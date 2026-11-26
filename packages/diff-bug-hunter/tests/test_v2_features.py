# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-tests for MatterWolf v2 features:
- Mode A relaxed citation floor & empty-response retry (`build_requests.py retry`, `EMPTY_RESPONSE`)
- Mode D normalization guidance & SKILL.md 3-tier confidence verdict
- `--all-batches`, batch archival, and whole-PR artifact preservation across batch switches
- `pr_tests.py` `-parallel` cap and host-level Postgres pool lock (`pg_pool_lock`)
- `R11` primary-read reliability invariant
- Mode R (CodeRabbit-only review-claim verifier): GraphQL pagination/error handling, 2x2 filter, severity parser,
  body cleaning, batch-2 & test-anchored target resolution, end-to-end Go `run.py run/base R`, repair R, and verdicts.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import build_requests
import ctx
import hunt_common
import pr_tests
import prepare
import pytest
import reliability
import review_threads
import run
import trusted
from test_hunt_engine import JESTDEPS, _git, make_hunt

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / ".claude" / "skills" / "hunt"

needs_jest = pytest.mark.skipif(not os.environ.get("HUNT_REQUIRE_DEPS") and not JESTDEPS.is_dir(),
                                reason="run `make jest-deps` first")


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)


def _cr_node(
    tid: str,
    path: str,
    line: int | None,
    body: str,
    *,
    resolved: bool = False,
    outdated: bool = False,
    author: str = "coderabbitai",
    replies: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    comments = [{
        "id": f"c_{tid}_0",
        "databaseId": 100,
        "url": f"https://github.com/mattermost/mattermost/pull/1#discussion_r{tid}",
        "author": {"login": author} if author else None,
        "body": body,
        "createdAt": "2026-11-23T00:00:00Z",
    }]
    for i, (r_auth, r_body) in enumerate(replies or [], 1):
        comments.append({
            "id": f"c_{tid}_{i}",
            "databaseId": 100 + i,
            "url": f"https://github.com/mattermost/mattermost/pull/1#discussion_r{tid}_{i}",
            "author": {"login": r_auth},
            "body": r_body,
            "createdAt": "2026-11-23T01:00:00Z",
        })
    return {
        "id": tid,
        "isResolved": resolved,
        "isOutdated": outdated,
        "path": path,
        "line": line,
        "originalLine": line or 10,
        "startLine": None,
        "originalStartLine": None,
        "diffSide": "RIGHT",
        "comments": {"nodes": comments},
    }


def _two_batch_repo(tmp: Path) -> tuple[Path, dict[str, Any]]:
    """Git repo with 6 changed Go files across pkg1 (5 files -> batch 1) and pkg2 (1 buggy file -> batch 2)."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "go.mod").write_text("module example.com/v2fx\n\ngo 1.22\n")
    (repo / "pkg1").mkdir()
    (repo / "pkg2").mkdir()
    for i in range(1, 6):
        (repo / "pkg1" / f"f{i}.go").write_text(f"package pkg1\n\nfunc F{i}(x int) int {{ return x + {i} }}\n")
    (repo / "pkg2" / "extra.go").write_text("package pkg2\n\nfunc Extra(x int) int { return x * 2 }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    # Introduce a bug in pkg1/f1.go (high-risk keyword "auth" so pkg1 stays batch 1) and in pkg2/extra.go (batch 2).
    (repo / "pkg1" / "f1.go").write_text(
        "package pkg1\n\n// auth helper\nfunc F1(x int) int {\n\tif x == 0 {\n\t\treturn 999 // bug\n\t}\n\treturn x + 1\n}\n"
    )
    for i in range(2, 6):
        (repo / "pkg1" / f"f{i}.go").write_text(
            f"package pkg1\n\n// auth helper {i}\nfunc F{i}(x int) int {{ return x + {i} }}\n"
        )
    (repo / "pkg2" / "extra.go").write_text(
        "package pkg2\n\nfunc Extra(x int) int {\n\tif x < 0 {\n\t\treturn 0 // bug: negative input zeroed\n\t}\n\treturn x * 2\n}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    wt, wt_base = tmp / "wt", tmp / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    hdir = tmp / "hunt42"
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    return hdir, prep


# ------------------------------------------------------------------ Step 1A: Mode A citation floor & empty retry

def test_mode_a_and_reliability_prompts_drop_rigid_three_citation_floor():
    for rel in ("prompts/mode_a.md", "prompts/strategy_x.md", "RELIABILITY.md", "scripts/reliability.py"):
        text = (SKILL / rel).read_text()
        assert "AT LEAST 3" not in text, rel
        assert "3 required citations" not in text, rel
        assert "3 caller citations" not in text, rel
    mode_a = (SKILL / "prompts/mode_a.md").read_text()
    assert "1-2 concrete citations" in mode_a and "Never return" in mode_a


def test_mode_a_empty_response_prints_nudge_and_retry_builds_request(tmp_path, monkeypatch, capsys):
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "hunters")
    capsys.readouterr()

    # Empty Mode A response -> exit 0, prints EMPTY_RESPONSE actionable nudge.
    (hdir / "A" / "response.json").write_text(json.dumps({"files": [], "tests": []}))
    assert run.main(["run.py", "run", "1", "A"]) == 0
    out = capsys.readouterr().out
    assert "EMPTY_RESPONSE" in out and "build_requests.py 1 retry A" in out

    # Empty Mode B response -> normal, no EMPTY_RESPONSE nudge.
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [], "tests": []}))
    assert run.main(["run.py", "run", "1", "B"]) == 0
    out_b = capsys.readouterr().out
    assert "EMPTY_RESPONSE" not in out_b and "no tests in the hunter response" in out_b

    # `build_requests.py 1 retry A` backs up response and writes request.retry.json + .md.
    build_requests.main("1", "retry", "A")
    capsys.readouterr()
    assert (hdir / "A" / "response.prev.json").exists()
    retry_req = json.loads((hdir / "A" / "request.retry.json").read_text())
    assert "Empty-output retry" in retry_req["system"]
    assert retry_req["response_path"].endswith("A/response.json")
    assert json.loads(retry_req["user"])["previous_response"] == {"files": [], "tests": []}
    assert "Empty-output retry" in (hdir / "A" / "request.retry.md").read_text()

    # Refuses retry when response.json already contains files.
    (hdir / "A" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_hunta_test.go", "content": "x"}]}))
    with pytest.raises(SystemExit, match="is not empty"):
        build_requests.main("1", "retry", "A")


# ------------------------------------------------------------------ Step 1B & 1D: Mode D normalization, R11, 3-tier verdict

def test_skill_and_mode_d_cover_normalization_blind_spot_and_three_tier_verdict():
    skill_md = (SKILL / "SKILL.md").read_text()
    for phrase in ("Bug Proven", "Partial or Unverified Coverage", "High-Confidence Clean",
                   "normalization-equivalent", "--all-batches", "build_requests.py <pr> review",
                   "review_threads.py verdicts", 'base_verdict == "PRE_EXISTING"'):
        assert phrase in skill_md, f"missing {phrase!r} in SKILL.md"
    assert "Pre-Existing Bug" in skill_md
    mode_d = (SKILL / "prompts/mode_d.md").read_text()
    assert "sparse/partial patches" in mode_d


def test_r11_triggers_only_on_primary_read_and_invalidation_patterns():
    rules = reliability.load()
    r11 = next(r for r in rules if r.id == "R11")
    assert r11.paths == []
    assert r11.langs == ("go",)
    match_ids = lambda diff: [r.id for r in reliability.match(  # noqa: E731
        {"changed_files_head_source": [{"file": "server/channels/app/foo.go", "source": ""}],
         "diff_production_code": diff}, rules)]
    assert "R11" in match_ids("+\tfields, err := s.GetPropertyFields(RequestContextWithMaster(rctx), ids)")
    assert "R11" in match_ids("+\tdb := ss.DBXFromContext(rctx.Context())")
    assert "R11" in match_ids("+\tif dropsOptions(f, existingByID[f.ID], updatedByID[f.ID]) {")
    assert "R11" in match_ids("+\ta.refreshAttributeViewsAfterOptionRemoval(rctx)")
    assert "R11" in match_ids("+\tcache.InvalidateCacheForUser(id)")
    assert "R11" in match_ids("+\texisting, err := a.Srv().Store.Channel().Get(id, true)")
    assert "R11" not in match_ids("+\tx := 1 + 2")
    assert "R11" not in match_ids("+\tps.regenerateClientConfig()")
    # R11 and mode_r.md cite real Mattermost APIs (never non-existent sqlstore.WithMaster).
    assert "sqlstore.WithMaster" not in r11.invariant and "HasMaster(rctx.Context())" in r11.probe
    assert "HasMaster(rctx.Context())" in (SKILL / "prompts/mode_r.md").read_text()


def test_reliability_lang_filter_blocks_cross_language_leaks_and_stays_backwards_compatible():
    rules = reliability.load()
    by_id = {r.id: r for r in rules}
    assert by_id["R08"].langs == ("go",)
    assert by_id["R09"].langs == ("jest",)
    assert by_id["R11"].langs == ("go",)
    assert by_id["R07"].langs == ()

    def match_ids(files: list[str], diff: str) -> list[str]:
        return [r.id for r in reliability.match(
            {"changed_files_head_source": [{"file": f, "source": ""} for f in files],
             "diff_production_code": diff}, rules)]

    # R11 (Go-only) must NOT fire on TypeScript / JS diffs calling cache-invalidation helpers.
    for ts_diff in ("+clearUserCache(userId);", "+invalidateCache();", "+purgeSessionCache();", "+const existingByID = {};"):
        assert "R11" not in match_ids(["webapp/channels/src/actions/user_actions.ts"], ts_diff)
        assert "R11" not in match_ids(["webapp/channels/src/components/view.tsx"], ts_diff)

    # R09 (Jest-only) must NOT fire on Go diffs mentioning saving / onSubmit / async.
    for go_diff in ("+\tsaving := true", "+\t// async handleSubmit", "+\tserverError := err.Error()"):
        assert "R09" not in match_ids(["server/channels/app/channel.go"], go_diff)

    # R09 DOES fire on TypeScript diffs; R08 does NOT fire on TypeScript diffs.
    assert "R09" in match_ids(["webapp/channels/src/components/form.tsx"], "+setSaving(true);")
    assert "R08" not in match_ids(["webapp/channels/src/utils/worker.ts"], "+// go func() { Mutex }")

    # Mixed Go + TS batch with unified diff: TS cache invalidation never triggers Go R11; Go `saving` never triggers Jest R09.
    mixed_diff = (
        "diff --git a/server/channels/app/foo.go b/server/channels/app/foo.go\n"
        "--- a/server/channels/app/foo.go\n"
        "+++ b/server/channels/app/foo.go\n"
        "@@ -1,2 +1,3 @@\n"
        "+\tsaving := true\n"
        "diff --git a/webapp/channels/src/actions/bar.ts b/webapp/channels/src/actions/bar.ts\n"
        "--- a/webapp/channels/src/actions/bar.ts\n"
        "+++ b/webapp/channels/src/actions/bar.ts\n"
        "@@ -1,2 +1,3 @@\n"
        "+clearUserCache(id);\n"
    )
    mixed_files = ["server/channels/app/foo.go", "webapp/channels/src/actions/bar.ts"]
    assert match_ids(mixed_files, mixed_diff) == []

    # Mixed Go + TS batch where each language triggers its own rule fires both cleanly.
    mixed_match_diff = (
        "diff --git a/server/channels/app/foo.go b/server/channels/app/foo.go\n"
        "--- a/server/channels/app/foo.go\n"
        "+++ b/server/channels/app/foo.go\n"
        "@@ -1,2 +1,3 @@\n"
        "+\tcache.InvalidateCacheForUser(id)\n"
        "diff --git a/webapp/channels/src/actions/bar.ts b/webapp/channels/src/actions/bar.ts\n"
        "--- a/webapp/channels/src/actions/bar.ts\n"
        "+++ b/webapp/channels/src/actions/bar.ts\n"
        "@@ -1,2 +1,3 @@\n"
        "+setSaving(true);\n"
    )
    assert sorted(match_ids(mixed_files, mixed_match_diff)) == ["R09", "R11"]

    # A removed `--- a/...go` line INSIDE a TS hunk must NOT switch parser language to Go, and quoted/.mts paths still match.
    hunk_spoof = (
        "diff --git a/webapp/channels/src/actions/bar.ts b/webapp/channels/src/actions/bar.ts\n"
        "--- a/webapp/channels/src/actions/bar.ts\n"
        "+++ b/webapp/channels/src/actions/bar.ts\n"
        "@@ -1,3 +1,4 @@\n"
        "--- a/server/channels/app/foo.go\n"
        "+clearUserCache(id);\n"
    )
    assert match_ids(mixed_files, hunk_spoof) == []
    quoted_ts = (
        'diff --git "a/webapp/channels/src/my form.mts" "b/webapp/channels/src/my form.mts"\n'
        '--- "a/webapp/channels/src/my form.mts"\n'
        '+++ "b/webapp/channels/src/my form.mts"\n'
        "@@ -1,1 +1,2 @@\n"
        "+setSaving(true);\n"
    )
    assert match_ids(["webapp/channels/src/my form.mts"], quoted_ts) == ["R09"]

    # A rule with both `lang: go` and `paths:` must ignore non-Go files matching the glob.
    lang_paths = reliability.parse("## R90 Go app\npaths: server/channels/app/*\nlang: go\ndiff: neverMatches\ninvariant: i\nprobe: p\n")
    assert reliability.match(
        {"changed_files_head_source": [{"file": "server/public/model/x.go", "source": ""}],
         "all_changed_files": ["server/channels/app/README.md"], "diff_production_code": "+x := 1"}, lang_paths) == []
    assert [r.id for r in reliability.match(
        {"changed_files_head_source": [{"file": "server/public/model/x.go", "source": ""}],
         "all_changed_files": ["server/channels/app/foo.go"], "diff_production_code": "+x := 1"}, lang_paths)] == ["R90"]

    # Backwards compatibility: a rule omitting `lang:` matches any language; unknown lang fails fast.
    custom = reliability.parse("## R99 Any lang\npaths: -\ndiff: magicToken\ninvariant: inv\nprobe: prb\n")
    assert custom[0].langs == ()
    assert [r.id for r in reliability.match(
        {"changed_files_head_source": [{"file": "web/a.ts", "source": ""}], "diff_production_code": "+magicToken"}, custom)] == ["R99"]
    assert [r.id for r in reliability.match(
        {"changed_files_head_source": [{"file": "srv/a.go", "source": ""}], "diff_production_code": "+magicToken"}, custom)] == ["R99"]
    with pytest.raises(ValueError, match="unknown lang"):
        reliability.parse("## R98 Bad\npaths: -\nlang: rust\ndiff: x\ninvariant: i\nprobe: p\n")


# ------------------------------------------------------------------ Step 1C (1): --all-batches & archival

def test_all_batches_prints_plan_archives_prior_batches_and_preserves_whole_pr_outputs(tmp_path, monkeypatch, capsys):
    hdir, prep = _two_batch_repo(tmp_path)
    (hdir / "prepare.json").parent.mkdir(parents=True, exist_ok=True)
    (hdir / "prepare.json").write_text(json.dumps({**prep, "range": ["master", "feature"]}))
    monkeypatch.setattr(ctx, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(sys, "argv", ["ctx.py", "42", "--all-batches"])
    ctx.main()
    out = capsys.readouterr().out
    assert "batch 1/2:" in out and "all-batches plan (2 batches" in out and "pkg2/extra.go" in out

    st1 = json.loads((hdir / "state.json").read_text())
    assert st1["batch"] == 1 and st1["batches"] == 2 and st1["all_batches"] is True
    assert len(st1["batch_plan"]) == 2 and st1["batch_plan"][1] == ["pkg2/extra.go"]

    # Simulate completed batch 1 artifacts AND whole-PR artifacts (Mode R, old_tests, pr_tests).
    (hdir / "A").mkdir()
    (hdir / "A" / "response.json").write_text('{"files": []}')
    (hdir / "run_A.json").write_text('{"pkg1::TestHuntA_X": "PASS"}')
    (hdir / "diff_D.json").write_text('{"pkg1::TestHuntD_X": "SAME"}')
    (hdir / "R").mkdir()
    (hdir / "R" / "threads.json").write_text('{"included": []}')
    (hdir / "R" / "response.json").write_text('{"files": [], "tests": [], "claims": []}')
    (hdir / "run_R.json").write_text('{"pkg2::TestHuntR_CR1_X": "FAIL_3_OF_3"}')
    (hdir / "base_R.json").write_text('{"pkg2::TestHuntR_CR1_X": "NEW_PR_BUG"}')
    (hdir / "review_verdicts.json").write_text('{"verdicts": {}}')
    (hdir / "old_tests.json").write_text('{"tests": {}}')
    (hdir / "pr_tests.json").write_text('{"tests": {}}')

    # Switch to batch 2: archives batch 1, preserves Mode R & whole-PR files, AND keeps all_batches=True.
    st2 = ctx.build("42", 2, prep, {"title": "t", "body": ""})
    assert st2["batch"] == 2 and st2["changed"] == ["pkg2/extra.go"] and st2["all_batches"] is True
    assert (hdir / "batches" / "batch_1" / "run_A.json").exists()
    assert (hdir / "batches" / "batch_1" / "diff_D.json").exists()
    assert (hdir / "batches" / "batch_1" / "A" / "response.json").exists()
    assert not (hdir / "run_A.json").exists()  # moved into batch_1 archive
    for whole_pr in ("R/threads.json", "R/response.json", "run_R.json", "base_R.json",
                     "review_verdicts.json", "old_tests.json", "pr_tests.json"):
        assert (hdir / whole_pr).exists(), f"whole-PR artifact {whole_pr} was wiped on batch switch"

    # Switching back to batch 1 and away again with NO new hunter outputs does not clobber completed batches/batch_1.
    ctx.build("42", 1, prep, {"title": "t", "body": ""})
    ctx.build("42", 2, prep, {"title": "t", "body": ""})
    assert (hdir / "batches" / "batch_1" / "run_A.json").exists()

    # Restart safety in prepare.py detects archived batch results & Mode R results.
    found = prepare.existing_results(hdir, prep["head"])
    assert "batches/batch_1/run_A.json" in found and "review_verdicts.json" in found and "R/response.json" in found
    assert "batches/batch_1/A/response.json" in found

    # Invalid batch number does not wipe batch 2.
    with pytest.raises(hunt_common.InfraError, match="batches are 1..2"):
        ctx.build("42", 3, prep, {"title": "t", "body": ""})
    assert json.loads((hdir / "state.json").read_text())["batch"] == 2

    # A new head commit clears whole-PR artifacts (R/, old_tests, pr_tests, batches/) automatically.
    repo = Path(prep["repo"])
    (repo / "pkg1" / "f1.go").write_text(
        "package pkg1\n\n// auth helper v2\nfunc F1(x int) int {\n\tif x == 0 {\n\t\treturn 998\n\t}\n\treturn x + 1\n}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head2")
    new_head = _git(repo, "rev-parse", "feature")
    prepare.worktrees(repo, "feature", "master", Path(prep["wt"]), Path(prep["wt_base"]))
    ctx.build("42", 1, {**prep, "head": new_head}, {"title": "t", "body": ""})
    assert not (hdir / "batches").exists() and not (hdir / "R").exists() and not (hdir / "run_R.json").exists()
    assert not (hdir / "old_tests.json").exists() and not (hdir / "pr_tests.json").exists()


# ------------------------------------------------------------------ Step 1C (2): pr_tests parallel cap & pg_pool_lock

def test_pr_tests_caps_go_test_parallel_flag_and_clamps_minimum(tmp_path, monkeypatch):
    # Real Go test asserting that TestMain observes -test.parallel == 2 (not NCPUs) under ENABLE_FULLY_PARALLEL_TESTS.
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "go.mod").write_text("module example.com/par\n\ngo 1.22\n")
    (repo / "par").mkdir()
    (repo / "par" / "par.go").write_text("package par\n\nfunc Ok() bool { return true }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    (repo / "par" / "par_test.go").write_text(
        'package par\n\nimport (\n\t"flag"\n\t"os"\n\t"strconv"\n\t"testing"\n)\n\n'
        'var seenParallel int\n\n'
        'func TestMain(m *testing.M) {\n'
        '\tflag.Parse()\n'
        '\tif f := flag.Lookup("test.parallel"); f != nil {\n'
        '\t\tseenParallel, _ = strconv.Atoi(f.Value.String())\n'
        '\t}\n'
        '\tos.Exit(m.Run())\n'
        '}\n\n'
        'func TestParallelCap(t *testing.T) {\n'
        '\tif os.Getenv("ENABLE_FULLY_PARALLEL_TESTS") != "true" {\n'
        '\t\tt.Fatal("expected ENABLE_FULLY_PARALLEL_TESTS=true")\n'
        '\t}\n'
        '\tif seenParallel != 2 {\n'
        '\t\tt.Fatalf("expected test.parallel=2, got %d", seenParallel)\n'
        '\t}\n'
        '}\n'
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    hdir = tmp_path / "hunt"
    state = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
             "head": _git(repo, "rev-parse", "feature")}
    monkeypatch.setenv("HUNT_PG_LOCK", str(tmp_path / "pg.lock"))
    monkeypatch.setenv("GOMAXPROCS", "4")
    monkeypatch.delenv("HUNT_PR_TEST_PARALLEL", raising=False)
    monkeypatch.delenv(pr_tests.PARALLEL_ENV, raising=False)

    out = pr_tests.cmd_pr(hdir, state)
    assert out["tests"] == {"par::TestParallelCap": "PASS"}
    assert pr_tests.PARALLEL_ENV not in os.environ  # restored after ci_env

    # Env parsing edge cases: clamp <2 to 2, allow >2, reject non-integer.
    monkeypatch.setenv("HUNT_PR_TEST_PARALLEL", "1")
    assert pr_tests.parallelism() == 2
    monkeypatch.setenv("HUNT_PR_TEST_PARALLEL", "4")
    assert pr_tests.parallelism() == 4
    monkeypatch.setenv("HUNT_PR_TEST_PARALLEL", "notanint")
    with pytest.raises(hunt_common.InfraError, match="HUNT_PR_TEST_PARALLEL"):
        pr_tests.parallelism()


def test_pg_pool_lock_serializes_concurrent_acquisitions(tmp_path, monkeypatch):
    lock_file = tmp_path / "pg.lock"
    monkeypatch.setenv("HUNT_PG_LOCK", str(lock_file))
    events: list[str] = []
    entered = threading.Event()

    def holder() -> None:
        with lock_file.open("w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            events.append("holder_acquired")
            entered.set()
            time.sleep(0.15)
            events.append("holder_releasing")
            fcntl.flock(fh, fcntl.LOCK_UN)

    t = threading.Thread(target=holder)
    t.start()
    assert entered.wait(timeout=2)
    with pr_tests.pg_pool_lock():
        events.append("waiter_acquired")
    t.join(timeout=2)
    assert events == ["holder_acquired", "holder_releasing", "waiter_acquired"]


# ------------------------------------------------------------------ Step 2: Mode R parsing, filtering, and GraphQL

def test_parse_severity_handles_v1_legacy_and_ignores_body_code():
    v1_major = (
        "<!-- coderabbit-ai-generated:v1 -->\n\n"
        '**<picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/major-16.svg">'
        "</picture> Major** · **Data Integrity**\n\n**Read from primary.**\n"
    )
    v1_minor = (
        "<!-- coderabbit-ai-generated:v1 -->\n\n"
        '**<picture><img src="https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/amber-16.svg">'
        "</picture> Minor** · **Functional Correctness**\n\n**Check reorder.**\n"
    )
    v1_icon_only = '<img src="https://x/review-comment-icons-v1/amber-16.svg">\nSome finding'
    legacy_crit = "_⚠️ Potential issue_ | _🔴 Critical_\n\n**SQL injection**"
    legacy_nit = "_🧹 Nitpick_\n\nRename var."
    code_decoy = "Simple comment.\n```go\n// _🔴 Critical_ inside code fence\n```\n"
    assert review_threads.parse_severity(v1_major) == "major"
    assert review_threads.parse_severity(v1_minor) == "minor"
    assert review_threads.parse_severity(v1_icon_only) == "minor"
    assert review_threads.parse_severity(legacy_crit) == "critical"
    assert review_threads.parse_severity(legacy_nit) == "nitpick"
    assert review_threads.parse_severity(code_decoy) == "unknown"


def test_clean_body_strips_comments_pictures_and_details_dumps():
    raw = (
        "<!-- coderabbit-ai-generated:v1 -->\n\n"
        '**<picture><img src="x.svg"></picture> Minor** · **Functional**\n\n'
        "**Refuse masked reorder.**\n\nActual bug explanation here.\n\n"
        "<details>\n<summary>Analysis chain</summary>\n" + ("huge shell log\n" * 500) + "</details>\n"
        "<!-- This is an auto-generated comment by CodeRabbit -->\n"
    )
    cleaned = review_threads.clean_body(raw)
    assert "Actual bug explanation here." in cleaned
    assert "Analysis chain" not in cleaned and "huge shell log" not in cleaned
    assert "<!--" not in cleaned and "<picture>" not in cleaned
    assert review_threads.extract_title(cleaned) == "Refuse masked reorder."
    # Details-only fallback never returns empty string.
    assert "only inside details" in review_threads.clean_body("<details>only inside details</details>")


def test_filter_threads_applies_coderabbit_only_and_2x2_policy():
    v1_minor = '**<picture><img src="amber-16.svg"></picture> Minor**\n\n**Minor claim.**\nDetails.'
    v1_major = '**<picture><img src="major-16.svg"></picture> Major**\n\n**Major claim.**\nDetails.'
    raw = [
        _cr_node("h1", "a.go", 10, "Human review comment", author="alice"),
        _cr_node("b1", "a.go", 11, "Bugbot comment", author="cursor[bot]"),
        _cr_node("cr_open", "pkg/a.go", 20, v1_minor, resolved=False, outdated=False),
        _cr_node("cr_silent", "pkg/b.go", 30, v1_minor, resolved=True, outdated=False,
                 author="coderabbitai[bot]", replies=[("dev", "looks fine to me")]),
        _cr_node("cr_fixed", "pkg/c.go", 40, v1_major, resolved=True, outdated=True),
        _cr_node("cr_out_major", "pkg/d.go", 50, v1_major, resolved=False, outdated=True),
        _cr_node("cr_out_minor", "pkg/e.go", 60, v1_minor, resolved=False, outdated=True),
        _cr_node("cr_docs", "docs/guide.mdx", 10, v1_major, resolved=False, outdated=False),
        _cr_node("cr_test", "pkg/a_test.go", 99, v1_minor, resolved=False, outdated=False),
    ]
    included, skipped, non_cr = review_threads.filter_threads(raw)
    assert non_cr == 2  # human + cursor[bot] ignored
    assert [(t["id"], t["thread_id"], t["triage"]) for t in included] == [
        ("CR1", "cr_open", "open_current"),
        ("CR2", "cr_test", "open_current"),
        ("CR3", "cr_silent", "resolved_not_outdated"),
        ("CR4", "cr_out_major", "open_outdated_high_severity"),
    ]
    assert included[2]["replies"] == [{"author": "dev", "body": "looks fine to me"}]
    skip_map = {s["thread_id"]: s["reason"] for s in skipped}
    assert skip_map == {
        "cr_fixed": "resolved and outdated",
        "cr_out_minor": "unresolved outdated low severity (minor)",
        "cr_docs": "non-code path",
    }


def test_fetch_graphql_paginates_and_fails_on_errors(monkeypatch):
    calls: list[list[str]] = []
    pages = [
        {"data": {"repository": {"pullRequest": {"reviewThreads": {
            "pageInfo": {"hasNextPage": True, "endCursor": "CUR1"},
            "nodes": [{"id": "t1"}],
        }}}}},
        {"data": {"repository": {"pullRequest": {"reviewThreads": {
            "pageInfo": {"hasNextPage": False, "endCursor": None},
            "nodes": [{"id": "t2"}],
        }}}}},
    ]

    def fake_sh(args, cwd, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, json.dumps(pages.pop(0)), "")

    monkeypatch.setattr(review_threads, "sh", fake_sh)
    got = review_threads.fetch_graphql("123", repo="mattermost/mattermost")
    assert [n["id"] for n in got] == ["t1", "t2"]
    assert "cursor=CUR1" in calls[1]

    # GraphQL error -> InfraError (never silently 0 threads).
    monkeypatch.setattr(review_threads, "sh", lambda a, c, **k: subprocess.CompletedProcess(
        a, 0, json.dumps({"errors": [{"message": "API rate limit exceeded"}]}), ""))
    with pytest.raises(hunt_common.InfraError, match="rate limit"):
        review_threads.fetch_graphql("123", repo="mattermost/mattermost")


def test_review_skips_range_targets_and_zero_thread_prs_without_request(tmp_path, monkeypatch, capsys):
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(review_threads, "fetch_graphql", lambda *a, **k: pytest.fail("gh must not run for ranges"))
    build_requests.main("release-11...release-12", "review")
    out = capsys.readouterr().out
    assert "range target" in out and not (hdir / "R" / "request.json").exists()
    assert (hdir / "R" / "threads.json").exists()

    # PR with 0 qualifying CodeRabbit threads also writes no request and clears stale request.json.
    (hdir / "R" / "request.json").write_text("{}")
    monkeypatch.setattr(review_threads, "fetch_graphql", lambda pr: [
        _cr_node("old", "calc/percent.go", 5, "Minor", resolved=True, outdated=True),
    ])
    build_requests.main("1", "review")
    assert "0 qualifying CodeRabbit threads" in capsys.readouterr().out
    assert not (hdir / "R" / "request.json").exists()


# ------------------------------------------------------------------ Step 2 E2E: Mode R spanning batch 1 + batch 2 + verdicts

def test_mode_r_end_to_end_proves_batch1_and_batch2_bugs_disproves_false_alarm_and_marks_unprovable(
    tmp_path, monkeypatch, capsys,
):
    hdir, prep = _two_batch_repo(tmp_path)
    state = ctx.build("42", 1, prep, {"title": "Update pkg1 and pkg2", "body": ""})
    assert state["changed"] != ["pkg2/extra.go"] and "pkg2/extra.go" not in state["changed"]  # pkg2 is deferred to batch 2!

    raw = [
        _cr_node("t1", "pkg1/f1.go", 5, '**<picture><img src="major-16.svg"></picture> Major**\n\n'
                 "**F1 returns 999 for zero.**\nPassing 0 returns 999 instead of 1."),
        _cr_node("t2", "pkg2/extra.go", 4, '**<picture><img src="amber-16.svg"></picture> Minor**\n\n'
                 "**Extra drops negative inputs.**\nNegative x returns 0 instead of x*2.", resolved=True, outdated=False),
        _cr_node("t3", "pkg1/f2.go", 4, '**<picture><img src="amber-16.svg"></picture> Minor**\n\n'
                 "**F2 off by one.**\nClaims F2(3) returns 4 instead of 5."),
        _cr_node("t4", "pkg1/f3.go", 4, '**<picture><img src="major-16.svg"></picture> Major**\n\n'
                 "**Read from replica lags under replication.**\nRequires a lagging Postgres replica."),
    ]
    monkeypatch.setattr(review_threads, "fetch_graphql", lambda pr: raw)
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(review_threads, "hunt_dir", lambda pr: hdir)

    build_requests.main("42", "review")
    capsys.readouterr()
    req = json.loads((hdir / "R" / "request.json").read_text())
    assert req["schema"] == build_requests.REVIEW_SCHEMA
    assert req["system"].startswith("Mode R: CodeRabbit review-claim verifier")
    assert "R11" not in req["system"] and "S1 Sibling guards" not in req["system"]
    user = json.loads(req["user"])
    assert {t["dir"] for t in user["your_test_files"]} == {"pkg1", "pkg2"}  # spans batch 1 AND deferred batch 2!
    assert len(user["review_threads"]) == 4

    # Map claim IDs by path so test names match sorted CR1..CR4 regardless of ordering.
    cid_by_path = {t["path"]: t["id"] for t in user["review_threads"]}
    c1, c2, c3, c4 = cid_by_path["pkg1/f1.go"], cid_by_path["pkg2/extra.go"], cid_by_path["pkg1/f2.go"], cid_by_path["pkg1/f3.go"]

    resp = {
        "files": [
            {
                "path": "pkg1/hunt_huntr_test.go",
                "content": (
                    'package pkg1\n\nimport "testing"\n\n'
                    f'func TestHuntR_{c1}_ZeroReturnsOne(t *testing.T) {{\n'
                    '\tif got := F1(0); got != 1 {\n\t\tt.Fatalf("F1(0) = %d, want 1", got)\n\t}\n}\n\n'
                    f'func TestHuntR_{c3}_F2AddsTwo(t *testing.T) {{\n'
                    '\tif got := F2(3); got != 5 {\n\t\tt.Fatalf("F2(3) = %d, want 5", got)\n\t}\n}\n'
                ),
            },
            {
                "path": "pkg2/hunt_huntr_test.go",
                "content": (
                    'package pkg2\n\nimport "testing"\n\n'
                    f'func TestHuntR_{c2}_NegativeDoubles(t *testing.T) {{\n'
                    '\tif got := Extra(-3); got != -6 {\n\t\tt.Fatalf("Extra(-3) = %d, want -6", got)\n\t}\n}\n'
                ),
            },
        ],
        "tests": [
            {"test_name": f"TestHuntR_{c1}_ZeroReturnsOne", "claim_id": c1, "checks": "F1(0)", "source": f"{c1} pkg1/f1.go:5"},
            {"test_name": f"TestHuntR_{c2}_NegativeDoubles", "claim_id": c2, "checks": "Extra(-3)", "source": f"{c2} pkg2/extra.go:4"},
            {"test_name": f"TestHuntR_{c3}_F2AddsTwo", "claim_id": c3, "checks": "F2(3)", "source": f"{c3} pkg1/f2.go:4"},
        ],
        "claims": [
            {"id": c1, "testable": True, "tests": [f"TestHuntR_{c1}_ZeroReturnsOne"], "reason": ""},
            {"id": c2, "testable": True, "tests": [f"TestHuntR_{c2}_NegativeDoubles"], "reason": ""},
            {"id": c3, "testable": True, "tests": [f"TestHuntR_{c3}_F2AddsTwo"], "reason": ""},
            {"id": c4, "testable": False, "tests": [], "reason": "single-node test cannot observe replica lag"},
        ],
    }
    (hdir / "R" / "response.json").write_text(json.dumps(resp))

    # Run head 3/3 + base vetting through the exact existing run.py pipeline while state.json is on batch 1!
    head_table = run.cmd_run(hdir, state, "R")
    assert head_table == {
        f"pkg1::TestHuntR_{c1}_ZeroReturnsOne": "FAIL_3_OF_3",
        f"pkg1::TestHuntR_{c3}_F2AddsTwo": "PASS",
        f"pkg2::TestHuntR_{c2}_NegativeDoubles": "FAIL_3_OF_3",
    }
    base_table = run.cmd_base(hdir, state, "R")
    assert base_table[f"pkg1::TestHuntR_{c1}_ZeroReturnsOne"] == "NEW_PR_BUG"
    assert base_table[f"pkg2::TestHuntR_{c2}_NegativeDoubles"] == "NEW_PR_BUG"
    assert base_table[f"pkg1::TestHuntR_{c3}_F2AddsTwo"] == "NOT_A_HEAD_FAILURE"

    # Deterministic per-thread verdicts.
    assert review_threads.main(["review_threads.py", "verdicts", "42"]) == 0
    cli_out = capsys.readouterr().out
    verdicts = json.loads((hdir / "review_verdicts.json").read_text())["verdicts"]
    assert verdicts[c1]["verdict"] == "PROVEN" and verdicts[c1]["base_verdict"] == "NEW_PR_BUG"
    assert verdicts[c2]["verdict"] == "PROVEN" and verdicts[c2]["base_verdict"] == "NEW_PR_BUG"
    assert verdicts[c3]["verdict"] == "DISPROVEN"
    assert verdicts[c4]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "replica lag" in verdicts[c4]["reason"]
    assert "PROVEN (NEW_PR_BUG)" in cli_out and "DISPROVEN" in cli_out and "UNPROVABLE_DYNAMICALLY" in cli_out

    # Repair request for Mode R preserves Mode R's targets, threads, claims, tests, and REVIEW_SCHEMA.
    (hdir / "compile_R.log").write_text("pkg2/hunt_huntr_test.go:4: undefined: Oops")
    build_requests.main("42", "repair", "R")
    rep_req = json.loads((hdir / "R" / "request.repair.json").read_text())
    assert rep_req["schema"] == build_requests.REVIEW_SCHEMA
    rep_user = json.loads(rep_req["user"])
    assert "review_threads" in rep_user and "undefined: Oops" in rep_user["compiler_error"]
    assert {t["dir"] for t in rep_user["your_test_files"]} == {"pkg1", "pkg2"}
    assert rep_user["your_previous_claims"] == resp["claims"]
    assert rep_user["your_previous_tests"] == resp["tests"]
    # Missing R/request.json fails cleanly instead of falling back to broken hunter_system("R").
    (hdir / "R" / "request.json").unlink()
    with pytest.raises(SystemExit, match="request.json missing"):
        build_requests.main("42", "repair", "R")
    run.ensure_clean(Path(state["wt"]))
    run.ensure_clean(Path(state["wt_base"]))


def test_compute_verdicts_edge_cases_flaky_skip_preexisting_and_compile_error(tmp_path):
    hdir = tmp_path / "hunt99"
    (hdir / "R").mkdir(parents=True)
    threads = [
        {"id": f"CR{i}", "path": f"p/f{i}.go", "line": i, "severity": "major", "triage": "open_current",
         "is_resolved": False, "is_outdated": False, "title": f"T{i}", "url": ""}
        for i in range(1, 7)
    ]
    (hdir / "R" / "threads.json").write_text(json.dumps({"pr": "99", "included": threads, "skipped": []}))
    (hdir / "R" / "response.json").write_text(json.dumps({"files": [], "tests": [], "claims": [
        {"id": "CR1", "testable": True, "tests": ["TestHuntR_CR1_Pre"], "reason": ""},
        {"id": "CR2", "testable": True, "tests": ["TestHuntR_CR2_NewApi"], "reason": ""},
        {"id": "CR3", "testable": True, "tests": ["TestHuntR_CR3_Flaky"], "reason": ""},
        {"id": "CR4", "testable": True, "tests": ["TestHuntR_CR4_Skip"], "reason": ""},
        {"id": "CR5", "testable": True, "tests": ["TestHuntR_CR5_Missing"], "reason": ""},
        {"id": "CR6", "testable": True, "tests": ["TestHuntR_CR6_Pass"], "reason": ""},
    ]}))
    (hdir / "run_R.json").write_text(json.dumps({
        "p::TestHuntR_CR1_Pre": "FAIL_3_OF_3",
        "p::TestHuntR_CR2_NewApi": "FAIL_3_OF_3",
        "p::TestHuntR_CR3_Flaky": "FLAKY",
        "p::TestHuntR_CR4_Skip": "SKIP",
        "p::TestHuntR_CR6_Pass": "PASS",
    }))
    (hdir / "base_R.json").write_text(json.dumps({
        "p::TestHuntR_CR1_Pre": "PRE_EXISTING",
        "p::TestHuntR_CR2_NewApi": "NEW_API",
    }))
    v = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v["CR1"]["verdict"] == "PROVEN" and v["CR1"]["base_verdict"] == "PRE_EXISTING"
    assert v["CR2"]["verdict"] == "PROVEN" and v["CR2"]["base_verdict"] == "NEW_API"
    assert v["CR3"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "FLAKY" in v["CR3"]["reason"]
    assert v["CR4"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "SKIP" in v["CR4"]["reason"]
    assert v["CR5"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "no linked test" in v["CR5"]["reason"]
    assert v["CR6"]["verdict"] == "DISPROVEN"

    # Compile failure with no run_R.json -> UNPROVABLE_DYNAMICALLY noting compile_R.log.
    (hdir / "run_R.json").unlink()
    (hdir / "compile_R.log").write_text("syntax error")
    v2 = review_threads.compute_verdicts(hdir)["verdicts"]
    assert all(x["verdict"] == "UNPROVABLE_DYNAMICALLY" and "compile_R.log" in x["reason"] for x in v2.values())

    # Stale base_R.json (older mtime than run_R.json) is ignored as UNVETTED and must NOT emit PROVEN; CR1 never matches CR10.
    (hdir / "compile_R.log").unlink()
    (hdir / "base_R.json").write_text(json.dumps({"p::TestHuntR_CR1_Pre": "NEW_PR_BUG"}))
    os.utime(hdir / "base_R.json", (1000, 1000))
    (hdir / "run_R.json").write_text(json.dumps({
        "p::TestHuntR_CR1_Pre": "FAIL_3_OF_3",
        "p::TestHuntR_CR10_Other": "PASS",
        "p::(package failed)": "FAIL_3_OF_3",
    }))
    v3 = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v3["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and v3["CR1"]["base_verdict"] == "UNVETTED"
    assert "run.py base 99 R" in v3["CR1"]["reason"]
    assert "p::TestHuntR_CR10_Other" not in v3["CR1"]["tests"]
    assert "package failed" in v3["CR5"]["reason"]

    # Completely missing base_R.json also emits UNPROVABLE_DYNAMICALLY with UNVETTED + actionable command.
    (hdir / "base_R.json").unlink()
    v4 = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v4["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and v4["CR1"]["base_verdict"] == "UNVETTED"
    assert "run.py base 99 R" in v4["CR1"]["reason"]


def test_review_threads_nested_details_late_replies_basename_focus_and_deleted_file(tmp_path):
    # Nested <details> blocks (Analysis chain -> Scripts executed) strip cleanly with zero stray tags.
    nested = (
        "**Major**\n\n**Real bug.**\nExplanation.\n"
        "<details><summary>Analysis chain</summary>"
        "<details><summary>Scripts</summary>inner dump</details>"
        "outer dump</details>\nKeep tail."
    )
    cleaned = review_threads.clean_body(nested)
    assert "Real bug." in cleaned and "Keep tail." in cleaned
    assert "inner dump" not in cleaned and "outer dump" not in cleaned and "</details>" not in cleaned

    # Threads with >7 comments retain first 2 replies AND the latest 4 replies (never dropping late withdrawals).
    many_replies = [(f"dev{i}", f"reply {i}") for i in range(1, 9)] + [("coderabbitai", "I withdraw my finding.")]
    inc, _, _ = review_threads.filter_threads([_cr_node("t_long", "pkg/a.go", 10, "**Minor**\n\n**Claim.**", replies=many_replies)])
    reply_bodies = [r["body"] for r in inc[0]["replies"]]
    assert "reply 1" in reply_bodies and "reply 2" in reply_bodies and "I withdraw my finding." in reply_bodies

    # Non-numeric PR raises InfraError cleanly.
    with pytest.raises(hunt_common.InfraError, match="invalid PR number"):
        review_threads.fetch_graphql("not-a-pr")

    # Deleted-at-head file & same-file basename:line reference (like #40294 property_field.go:79).
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "go.mod").write_text("module example.com/del\n\ngo 1.22\n")
    (repo / "pkg").mkdir()
    (repo / "pkg" / "keep.go").write_text("package pkg\n" + "".join(f"// line {i}\n" for i in range(2, 1600)))
    (repo / "pkg" / "old.go").write_text("package pkg\n\nfunc Legacy() int { return 1 }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    (repo / "pkg" / "old.go").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "delete old")
    wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    hdir = tmp_path / "hunt7"
    state = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
             "head": _git(repo, "rev-parse", "feature")}
    raw = [
        _cr_node("t_del", "pkg/old.go", 3, "**Major**\n\n**Legacy removed.**\nCallers still need Legacy."),
        _cr_node("t_base", "pkg/keep.go", 1500, "**Major**\n\n**Check early line.**\nSee keep.go:79 as well."),
    ]
    meta, user = review_threads.build_review_context("7", hdir, state, {}, raw_threads=raw)
    assert user is not None
    assert meta["targets"] == [{"lang": "go", "dir": "pkg", "path": "pkg/hunt_huntr_test.go", "package": "pkg"}]
    assert "func Legacy()" in user["diff_production_code"]
    keep_src = next(f["source"] for f in user["thread_files_head_source"] if f["file"] == "pkg/keep.go")
    assert "   79  // line 79" in keep_src and " 1500  // line 1500" in keep_src


def test_compute_verdicts_sha256_freshness_priority_and_multiword_jest_match(tmp_path):
    hdir = tmp_path / "hunt88"
    (hdir / "R").mkdir(parents=True)
    threads = [
        {"id": "CR1", "path": "p/a.go", "line": 10, "severity": "major", "triage": "open_current",
         "is_resolved": False, "is_outdated": False, "title": "Multi test", "url": ""},
        {"id": "CR2", "path": "web/src/ws.ts", "line": 20, "severity": "minor", "triage": "open_current",
         "is_resolved": False, "is_outdated": False, "title": "Multiword Jest", "url": ""},
        {"id": "CR3", "path": "other/b.go", "line": 30, "severity": "minor", "triage": "open_current",
         "is_resolved": False, "is_outdated": False, "title": "Cross-pkg fail", "url": ""},
    ]
    files = [{"path": "p/hunt_huntr_test.go", "content": "v2"}]
    digest = run.fingerprint(files)
    (hdir / "R" / "threads.json").write_text(json.dumps({"pr": "88", "included": threads, "skipped": []}))
    (hdir / "R" / "response.json").write_text(json.dumps({"files": files, "tests": [], "claims": [
        {"id": "CR1", "testable": True, "tests": ["TestHuntR_CR1_Pre", "TestHuntR_CR1_Diff"], "reason": ""},
        {"id": "CR2", "testable": True, "tests": ["HuntR_non admin refetches omitted options"], "reason": ""},
        {"id": "CR3", "testable": True, "tests": ["TestHuntR_CR3_NeverRan"], "reason": ""},
    ]}))
    (hdir / "run_R.json").write_text(json.dumps({
        "p::TestHuntR_CR1_Pre": "FAIL_3_OF_3",
        "p::TestHuntR_CR1_Diff": "FAIL_3_OF_3",
        "web/src/hunt_r.test.tsx::HuntR HuntR_non admin refetches omitted options": "PASS",
        "api4::(package failed)": "FAIL_3_OF_3",
    }))
    (hdir / "run_R.response.sha256").write_text(digest)
    # 1. Mixed PRE_EXISTING + BASE_FAILS_DIFFERENTLY must NOT collapse to PRE_EXISTING via bvs[0].
    (hdir / "base_R.json").write_text(json.dumps({
        "p::TestHuntR_CR1_Pre": "PRE_EXISTING",
        "p::TestHuntR_CR1_Diff": "BASE_FAILS_DIFFERENTLY",
    }))
    (hdir / "base_R.response.sha256").write_text(digest)
    v = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v["CR1"]["verdict"] == "PROVEN" and v["CR1"]["base_verdict"] == "BASE_FAILS_DIFFERENTLY"
    assert v["CR2"]["verdict"] == "DISPROVEN"
    assert v["CR3"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "api4::(package failed)" in v["CR3"]["reason"]

    # 2. Stale base_R.response.sha256 is ignored as UNVETTED even when base_R.json has a NEWER mtime (never PROVEN).
    (hdir / "base_R.response.sha256").write_text("stale-sha")
    future = time.time() + 60
    os.utime(hdir / "base_R.json", (future, future))
    v_stale_base = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v_stale_base["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and v_stale_base["CR1"]["base_verdict"] == "UNVETTED"
    assert "run.py base 88 R" in v_stale_base["CR1"]["reason"]

    # 3. Stale run_R.response.sha256 + compile_R.log reports compile error instead of stale run_R.json.
    (hdir / "run_R.response.sha256").write_text("stale-sha")
    (hdir / "compile_R.log").write_text("build failed")
    v_compile = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v_compile["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and "compile_R.log" in v_compile["CR1"]["reason"]

    # 4. Empty base_R.json stays UNVETTED, PRE_EXISTING vs SKIP is order-independent, and corrupt base_R.json raises InfraError.
    (hdir / "compile_R.log").unlink()
    (hdir / "run_R.response.sha256").write_text(digest)
    (hdir / "base_R.response.sha256").write_text(digest)
    (hdir / "base_R.json").write_text("{}")
    v_empty = review_threads.compute_verdicts(hdir)["verdicts"]
    assert v_empty["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY" and v_empty["CR1"]["base_verdict"] == "UNVETTED"

    (hdir / "base_R.json").write_text(json.dumps({"p::TestHuntR_CR1_Pre": "PRE_EXISTING", "p::TestHuntR_CR1_Diff": "SKIP"}))
    bv_a = review_threads.compute_verdicts(hdir)["verdicts"]["CR1"]["base_verdict"]
    (hdir / "base_R.json").write_text(json.dumps({"p::TestHuntR_CR1_Pre": "SKIP", "p::TestHuntR_CR1_Diff": "PRE_EXISTING"}))
    bv_b = review_threads.compute_verdicts(hdir)["verdicts"]["CR1"]["base_verdict"]
    assert bv_a == bv_b == "SKIP"

    (hdir / "base_R.json").write_text("{corrupt")
    with pytest.raises(hunt_common.InfraError, match="invalid JSON"):
        review_threads.compute_verdicts(hdir)


@needs_jest
def test_mode_r_mixed_go_and_jest_end_to_end_and_per_unit_base_isolation(tmp_path, monkeypatch):
    """Mirrors #40299: batch 1 has 5 Go files, deferred batch 2 has a Jest .ts file + PR-added Go dir + PR-added TS module.
    Verifies real Jest Mode R E2E, per-unit cmd_base isolation (passing new-dir test & failing new-module Jest file do NOT
    destroy valid NEW_PR_BUG verdicts in other packages/files), and cmd_run stale cleanup."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "go.mod").write_text("module example.com/mixed\n\ngo 1.22\n")
    (repo / "pkg1").mkdir()
    for i in range(1, 6):
        (repo / "pkg1" / f"f{i}.go").write_text(f"package pkg1\n\nfunc F{i}(x int) int {{ return x + {i} }}\n")
    (repo / "web" / "src").mkdir(parents=True)
    (repo / "web" / "package.json").write_text('{"name": "mixed-fixture", "private": true}\n')
    (repo / "web" / "jest.config.js").write_text("module.exports = {testEnvironment: 'jsdom', transform: {'^.+\\\\.[jt]sx?$': 'babel-jest'}};\n")
    (repo / "web" / "babel.config.js").write_text(
        "module.exports = {presets: [['@babel/preset-env', {targets: {node: 'current'}}], '@babel/preset-react', '@babel/preset-typescript']};\n"
    )
    (repo / "web" / "src" / "ws.ts").write_text(
        "export function shouldRefetch(_isAdmin: boolean, optionsOmitted: boolean): boolean {\n"
        "    return optionsOmitted;\n"
        "}\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    # Batch 1: 5 Go files (high-risk "auth" keyword so pkg1 fills batch 1); f1 introduces a bug.
    (repo / "pkg1" / "f1.go").write_text(
        "package pkg1\n\n// auth check\nfunc F1(x int) int {\n\tif x == 0 {\n\t\treturn 42\n\t}\n\treturn x + 1\n}\n"
    )
    for i in range(2, 6):
        (repo / "pkg1" / f"f{i}.go").write_text(f"package pkg1\n\n// auth {i}\nfunc F{i}(x int) int {{ return x + {i} }}\n")
    # Batch 2: Jest ws.ts introduces the #40299 bug (only admins refetch on optionsOmitted).
    (repo / "web" / "src" / "ws.ts").write_text(
        "export function shouldRefetch(isAdmin: boolean, optionsOmitted: boolean): boolean {\n"
        "    return optionsOmitted && isAdmin;\n"
        "}\n"
    )
    # Also add a brand-new Go directory (absent on base) and a brand-new TS module (absent on base).
    (repo / "newpkg").mkdir()
    (repo / "newpkg" / "added.go").write_text("package newpkg\n\nfunc Ok() bool { return true }\n")
    (repo / "web" / "newmod").mkdir()
    (repo / "web" / "newmod" / "extra.ts").write_text("export function extra(n: number): number { return n - 1; }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")

    wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    for w in (wt, wt_base):
        (w / "web" / "node_modules").symlink_to(JESTDEPS)
    hdir = tmp_path / "hunt99"
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    state = ctx.build("99", 1, prep, {"title": "Mixed Go + Jest PR", "body": ""})
    assert "web/src/ws.ts" not in state["changed"]  # deferred to batch 2!

    raw = [
        _cr_node("g1", "pkg1/f1.go", 5, "**Major**\n\n**F1(0) returns 42.**\nShould return 1."),
        _cr_node("w1", "web/src/ws.ts", 2, "**Minor**\n\n**Non-admin skips refetch.**\nNon-admin must also refetch."),
        _cr_node("n1", "newpkg/added.go", 3, "**Minor**\n\n**Ok() returns false.**\nFalse alarm on newpkg."),
        _cr_node("m1", "web/newmod/extra.ts", 1, "**Minor**\n\n**extra(5) wrong.**\nExpected 5, got 4."),
    ]
    monkeypatch.setattr(review_threads, "fetch_graphql", lambda pr: raw)
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(review_threads, "hunt_dir", lambda pr: hdir)

    build_requests.main("99", "review")
    req = json.loads((hdir / "R" / "request.json").read_text())
    user = json.loads(req["user"])
    by_path = {t["path"]: t["id"] for t in user["review_threads"]}
    cg, cw, cn, cm = by_path["pkg1/f1.go"], by_path["web/src/ws.ts"], by_path["newpkg/added.go"], by_path["web/newmod/extra.ts"]
    assert {"pkg1", "web/src", "newpkg", "web/newmod"} <= {t["dir"] for t in user["your_test_files"]}

    resp = {
        "files": [
            {
                "path": "pkg1/hunt_huntr_test.go",
                "content": (
                    'package pkg1\n\nimport "testing"\n\n'
                    f'func TestHuntR_{cg}_Zero(t *testing.T) {{\n'
                    '\tif got := F1(0); got != 1 {\n\t\tt.Fatalf("got %d want 1", got)\n\t}\n}\n'
                ),
            },
            {
                "path": "web/src/hunt_r.test.tsx",
                "content": (
                    "import {shouldRefetch} from './ws';\n\n"
                    "describe('HuntR', () => {\n"
                    f"    it('HuntR_{cw}_nonAdminRefetchesOmittedOptions', () => {{\n"
                    "        expect(shouldRefetch(false, true)).toBe(true);\n"
                    "    });\n"
                    "});\n"
                ),
            },
            {
                "path": "newpkg/hunt_huntr_test.go",
                "content": (
                    'package newpkg\n\nimport "testing"\n\n'
                    f'func TestHuntR_{cn}_OkTrue(t *testing.T) {{\n'
                    '\tif !Ok() {\n\t\tt.Fatal("expected true")\n\t}\n}\n'
                ),
            },
            {
                "path": "web/newmod/hunt_r.test.tsx",
                "content": (
                    "import {extra} from './extra';\n\n"
                    "describe('HuntR', () => {\n"
                    f"    it('HuntR_{cm}_extraIdentity', () => {{\n"
                    "        expect(extra(5)).toBe(5);\n"
                    "    });\n"
                    "});\n"
                ),
            },
        ],
        "tests": [],
        "claims": [
            {"id": cg, "testable": True, "tests": [f"TestHuntR_{cg}_Zero"], "reason": ""},
            {"id": cw, "testable": True, "tests": [f"HuntR_{cw}_nonAdminRefetchesOmittedOptions"], "reason": ""},
            {"id": cn, "testable": True, "tests": [f"TestHuntR_{cn}_OkTrue"], "reason": ""},
            {"id": cm, "testable": True, "tests": [f"HuntR_{cm}_extraIdentity"], "reason": ""},
        ],
    }
    (hdir / "R" / "response.json").write_text(json.dumps(resp))

    head = run.cmd_run(hdir, state, "R")
    assert head[f"pkg1::TestHuntR_{cg}_Zero"] == "FAIL_3_OF_3"
    assert head[f"web/src/hunt_r.test.tsx::HuntR HuntR_{cw}_nonAdminRefetchesOmittedOptions"] == "FAIL_3_OF_3"
    assert head[f"newpkg::TestHuntR_{cn}_OkTrue"] == "PASS"
    assert head[f"web/newmod/hunt_r.test.tsx::HuntR HuntR_{cm}_extraIdentity"] == "FAIL_3_OF_3"

    # Per-unit base isolation: passing test in brand-new newpkg/ is skipped, failing newmod/ (missing on base) does NOT
    # wipe out pkg1/ (Go) or web/src/ (Jest) NEW_PR_BUG verdicts!
    base = run.cmd_base(hdir, state, "R")
    assert "*" not in base
    assert base[f"pkg1::TestHuntR_{cg}_Zero"] == "NEW_PR_BUG"
    assert base[f"web/src/hunt_r.test.tsx::HuntR HuntR_{cw}_nonAdminRefetchesOmittedOptions"] == "NEW_PR_BUG"
    assert base[f"newpkg::TestHuntR_{cn}_OkTrue"] == "NOT_A_HEAD_FAILURE"
    assert base[f"web/newmod/hunt_r.test.tsx::HuntR HuntR_{cm}_extraIdentity"] in ("BASE_UNCOMPILABLE", "NEW_API")
    assert (hdir / "base_R.response.sha256").exists()

    verdicts = review_threads.compute_verdicts(hdir)["verdicts"]
    assert verdicts[cg]["verdict"] == "PROVEN" and verdicts[cg]["base_verdict"] == "NEW_PR_BUG"
    assert verdicts[cw]["verdict"] == "PROVEN" and verdicts[cw]["base_verdict"] == "NEW_PR_BUG"
    assert verdicts[cn]["verdict"] == "DISPROVEN"
    assert verdicts[cm]["verdict"] == "PROVEN" and verdicts[cm]["base_verdict"] in ("BASE_UNCOMPILABLE", "NEW_API")

    # Rerunning cmd_run removes stale base_R.json and base_R.response.sha256 immediately.
    run.cmd_run(hdir, state, "R", runs=1)
    assert not (hdir / "base_R.json").exists() and not (hdir / "base_R.response.sha256").exists()
    run.ensure_clean(wt)
    run.ensure_clean(wt_base)


# ------------------------------------------------------------------ sibling_tests: >3,000-line windowing & dir fairness

def _large_go_test(pkg: str, helper_name: str, sym_a: str, sym_b: str, total_blocks: int = 900) -> str:
    """Build a >5,000-line Go test file with package header, TestMain, setup helper, early sym_a hits, and deep sym_b hit."""
    parts = [
        f"package {pkg}\n",
        'import (\n\t"os"\n\t"testing"\n)\n',
        "func TestMain(m *testing.M) {\n\tos.Exit(m.Run())\n}\n",
        f"func {helper_name}(t *testing.T) int {{\n\tt.Helper()\n\treturn 42\n}}\n",
    ]
    for i in range(total_blocks):
        if 40 <= i < 90:
            body = f"\t_ = {sym_a}({i})\n"
        elif i == total_blocks - 20:
            body = f"\t_ = {sym_b}({i})\n"
        else:
            body = f"\t_ = {i}\n"
        parts.append(f"func TestCase{i}(t *testing.T) {{\n\tv := {i}\n\t_ = v\n{body}\t// pad {i}\n}}\n")
    return "\n".join(parts)


def test_sibling_tests_windows_oversized_go_test_files_instead_of_dropping(tmp_path):
    wt = tmp_path / "wt"
    api = wt / "server/channels/api4"
    api.mkdir(parents=True)
    (api / "properties.go").write_text("package api4\n\nfunc UpdatePropertyField(x int) int { return x }\n")
    big_go = _large_go_test("api4", "setupPropertyEnv", "UpdatePropertyField", "ValidatePropertyValue", total_blocks=900)
    assert len(big_go.splitlines()) > ctx.MAX_SIBLING_LINES  # > 5,000 lines like properties_test.go / config_test.go
    (api / "properties_test.go").write_text(big_go)
    (api / "unrelated_test.go").write_text("package api4\n\nfunc TestUnrelated(t *testing.T) {}\n")

    res = ctx.sibling_tests(wt, ["server/channels/api4/properties.go"], {"UpdatePropertyField", "ValidatePropertyValue"})
    assert [r["file"] for r in res] == ["server/channels/api4/properties_test.go"]
    src = res[0]["source"]
    assert len(src.splitlines()) <= ctx.MAX_SIBLING_LINES
    assert "package api4" in src
    assert "func TestMain(m *testing.M)" in src
    assert "func setupPropertyEnv(t *testing.T)" in src
    assert "UpdatePropertyField(" in src
    assert "ValidatePropertyValue(" in src  # deep symbol past line 5,000 is not crowded out by 50 early hits of sym_a
    assert "   ..." in src

    # Empty symbols on a >3,000-line rank-1 file still emits a compact windowed excerpt instead of dropping it.
    res_empty = ctx.sibling_tests(wt, ["server/channels/api4/properties.go"], set())
    assert [r["file"] for r in res_empty] == ["server/channels/api4/properties_test.go"]
    src_empty = res_empty[0]["source"]
    assert 0 < len(src_empty.splitlines()) <= ctx.MAX_SIBLING_LINES
    assert "package api4" in src_empty and "func setupPropertyEnv" in src_empty

    # Oversized rank-0 helper does NOT starve oversized rank-1 same-name test in the same directory.
    (api / "helper_test.go").write_text(_large_go_test("api4", "makeSharedFixture", "UpdatePropertyField", "OtherSym", 600))
    res_both = ctx.sibling_tests(wt, ["server/channels/api4/properties.go"], {"UpdatePropertyField", "ValidatePropertyValue"})
    assert [r["file"] for r in res_both] == [
        "server/channels/api4/helper_test.go",
        "server/channels/api4/properties_test.go",
    ]
    assert sum(len(r["source"].splitlines()) for r in res_both) <= ctx.MAX_SIBLING_LINES
    assert "func makeSharedFixture" in res_both[0]["source"]
    assert "ValidatePropertyValue(" in res_both[1]["source"]

    # Tight budgets (25..50 lines) with a realistic 25-line header + helper must still center on and include the symbol hit.
    tight_lines = ["// Copyright", "package p", "", "import ("] + [f'\t"pkg{i}"' for i in range(20)] + [")", ""]
    tight_lines += ["func setupHelper(t *testing.T) {"] + [f"\t_ = {i}" for i in range(13)] + ["}", ""]
    tight_lines += [f"// filler {i}" for i in range(1, 500)]
    tight_lines[499] = "func TestTarget(t *testing.T) { TargetSymbol(42) }"
    for cap in (25, 35, 50):
        txt, used = ctx._windowed_sibling(tight_lines, "go", {"TargetSymbol"}, cap)
        assert used == len(txt.splitlines()) <= cap
        assert "TargetSymbol(42)" in txt

    # Oversized rank-2 sibling test must NOT starve another rank-2 sibling in the same directory; dotted stems match rank 1.
    r2_dir = wt / "server/channels/r2"
    r2_dir.mkdir(parents=True)
    (r2_dir / "feature.go").write_text("package r2\nfunc SpecialCall() {}\n")
    (r2_dir / "a_big_test.go").write_text(_large_go_test("r2", "setupR2", "SpecialCall", "OtherCall", 700))
    (r2_dir / "z_small_test.go").write_text("package r2\nfunc TestSmall(t *testing.T) { SpecialCall() }\n")
    r2_res = ctx.sibling_tests(wt, ["server/channels/r2/feature.go"], {"SpecialCall"})
    assert [r["file"] for r in r2_res] == ["server/channels/r2/a_big_test.go", "server/channels/r2/z_small_test.go"]
    assert sum(len(r["source"].splitlines()) for r in r2_res) <= ctx.MAX_SIBLING_LINES
    assert "SpecialCall()" in r2_res[1]["source"]

    dot_dir = wt / "webapp/src/dot"
    dot_dir.mkdir(parents=True)
    (dot_dir / "panel.component.tsx").write_text("export const Panel = () => null;\n")
    (dot_dir / "panel.component.test.tsx").write_text("test('panel', () => expect(1).toBe(1));\n")
    assert [r["file"] for r in ctx.sibling_tests(wt, ["webapp/src/dot/panel.component.tsx"], set())] == [
        "webapp/src/dot/panel.component.test.tsx"
    ]


def test_sibling_tests_fair_directory_budget_prevents_go_starving_jest_and_works_in_mode_r(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "go.mod").write_text("module example.com/sib\n\ngo 1.22\n")
    api = repo / "server/channels/api4"
    actions = repo / "webapp/channels/src/actions"
    comps = repo / "webapp/channels/src/components"
    for d in (api, actions, comps):
        d.mkdir(parents=True)

    (api / "properties.go").write_text("package api4\n\nfunc UpdatePropertyField(x int) int { return x }\n")
    (api / "main_test.go").write_text("package api4\n\n" + "\n".join(f"// main helper line {i}" for i in range(100)) + "\n")
    (api / "properties_test.go").write_text(
        _large_go_test("api4", "setupApi4", "UpdatePropertyField", "DeletePropertyField", total_blocks=900)
    )
    (actions / "ws.ts").write_text("export function handlePropertyEvent(x: number): number { return x; }\n")
    (actions / "ws.test.tsx").write_text(
        "import {handlePropertyEvent} from './ws';\n\n"
        "function makeWsEvent() { return {data: 1}; }\n\n"
        + "\n".join(f"test('case {i}', () => expect(handlePropertyEvent({i})).toBe({i}));" for i in range(80))
        + "\n"
    )
    (comps / "panel.tsx").write_text("export function renderPanel(x: number): number { return x; }\n")
    big_jest = (
        "import {renderPanel} from './panel';\n\n"
        "function makePanelProps() { return {id: '1'}; }\n\n"
        + "\n".join(
            f"test('panel filler {i}', () => {{\n    const v = {i};\n    expect(v).toBe({i});\n}});"
            for i in range(900)
        )
        + "\ntest('panel target', () => {\n    expect(renderPanel(7)).toBe(7);\n});\n"
    )
    assert len(big_jest.splitlines()) > ctx.MAX_SIBLING_LINES
    (comps / "panel.test.tsx").write_text(big_jest)
    (comps / "unrelated.test.tsx").write_text("test('unrelated', () => expect(1).toBe(1));\n")

    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    (api / "properties.go").write_text("package api4\n\nfunc UpdatePropertyField(x int) int { return x + 1 }\n")
    (actions / "ws.ts").write_text("export function handlePropertyEvent(x: number): number { return x + 1; }\n")
    (comps / "panel.tsx").write_text("export function renderPanel(x: number): number { return x + 1; }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")

    wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    head = _git(repo, "rev-parse", "feature")

    # Direct ctx.sibling_tests call: Go >5,000-line dir must NOT starve either Jest dir.
    files = [
        "server/channels/api4/properties.go",
        "webapp/channels/src/actions/ws.ts",
        "webapp/channels/src/components/panel.tsx",
    ]
    syms = {"UpdatePropertyField", "handlePropertyEvent", "renderPanel"}
    sibs = ctx.sibling_tests(wt, files, syms)
    sib_by_file = {s["file"]: s["source"] for s in sibs}
    assert set(sib_by_file) == {
        "server/channels/api4/main_test.go",
        "server/channels/api4/properties_test.go",
        "webapp/channels/src/actions/ws.test.tsx",
        "webapp/channels/src/components/panel.test.tsx",
    }
    assert sum(len(s["source"].splitlines()) for s in sibs) <= ctx.MAX_SIBLING_LINES
    # Small files in both Go and Jest stay intact in full; huge Go and Jest files are windowed with headers + helpers + symbols.
    assert len(sib_by_file["webapp/channels/src/actions/ws.test.tsx"].splitlines()) == len(
        (wt / "webapp/channels/src/actions/ws.test.tsx").read_text().split("\n")
    )
    assert "func setupApi4" in sib_by_file["server/channels/api4/properties_test.go"]
    assert "UpdatePropertyField(" in sib_by_file["server/channels/api4/properties_test.go"]
    assert "function makePanelProps()" in sib_by_file["webapp/channels/src/components/panel.test.tsx"]
    assert "renderPanel(7)" in sib_by_file["webapp/channels/src/components/panel.test.tsx"]

    # Mode R build_review_context gets the exact same non-starvation across Go + Jest CodeRabbit threads.
    hdir = tmp_path / "hunt_sib"
    state = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb, "head": head}
    raw = [
        _cr_node("c1", "server/channels/api4/properties.go", 3, "**Major**\n\n**Bad property update.**"),
        _cr_node("c2", "webapp/channels/src/actions/ws.ts", 1, "**Minor**\n\n**Bad ws handler.**"),
        _cr_node("c3", "webapp/channels/src/components/panel.tsx", 1, "**Minor**\n\n**Bad panel render.**"),
    ]
    _, user = review_threads.build_review_context("55", hdir, state, {}, raw_threads=raw)
    assert user is not None
    r_files = {s["file"] for s in user["sibling_tests_and_helpers"]}
    assert {
        "server/channels/api4/properties_test.go",
        "webapp/channels/src/actions/ws.test.tsx",
        "webapp/channels/src/components/panel.test.tsx",
    } <= r_files
    assert sum(len(s["source"].splitlines()) for s in user["sibling_tests_and_helpers"]) <= ctx.MAX_SIBLING_LINES


def test_sibling_tests_fall_back_to_setup_helpers_when_no_sibling_relates(tmp_path):
    # PR 39657: invitation.go has no invitation_test.go and no sibling mentions AcceptInvitation; the package's
    # mocks_test.go (newMockServer) is what a hunter needs to build the Service. Before: [] and every hunter was EMPTY.
    wt = tmp_path / "wt"
    rc = wt / "server/platform/services/remotecluster"
    rc.mkdir(parents=True)
    (rc / "invitation.go").write_text("package remotecluster\n\nfunc (rcs *Service) AcceptInvitation() {}\n")
    (rc / "mocks_test.go").write_text("package remotecluster\n\ntype mockServer struct{}\n\n"
                                      "func newMockServer(t *testing.T) *mockServer { return &mockServer{} }\n")
    (rc / "ping_test.go").write_text("package remotecluster\n\nfunc TestPing(t *testing.T) {}\n")
    res = ctx.sibling_tests(wt, ["server/platform/services/remotecluster/invitation.go"], {"AcceptInvitation"})
    assert [r["file"] for r in res] == ["server/platform/services/remotecluster/mocks_test.go"]
    assert "func newMockServer" in res[0]["source"]
    # a related sibling present: no fallback, unrelated helper files stay out
    (rc / "invitation_test.go").write_text("package remotecluster\n\nfunc TestAccept(t *testing.T) {}\n")
    res = ctx.sibling_tests(wt, ["server/platform/services/remotecluster/invitation.go"], {"AcceptInvitation"})
    assert [r["file"] for r in res] == ["server/platform/services/remotecluster/invitation_test.go"]
