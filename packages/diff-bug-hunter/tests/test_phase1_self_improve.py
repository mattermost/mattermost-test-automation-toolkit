# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-tests for MatterWolf Self-Improvement Phase 1:
- ledger.py (hunt_ledger.jsonl telemetry + Mode R verified escape exporter)
- lessons.py (path+keyword AND scoring, diff-only scanning, monorepo overbroad(), target-keyed prune, Mode D opt-out)
- prefilter.py (calibrated weights for server/public/model/, cmd/mmctl/, webapp components & utils)
- old_tests.py (language-balanced Go/Jest water-filling quotas + production risk prioritization)
- eval_bugs.py (multi-kind manifests, --skip-missing, regression locks, monotonic diff_scorecards)
"""
from __future__ import annotations

import json

import build_requests
import ctx
import eval_bugs
import ledger
import lessons
import old_tests
import prefilter
import pytest
import review_threads
import trusted
from test_hunt_engine import _git


@pytest.fixture(autouse=True)
def _iso(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)


# ------------------------------------------------------------------ 1A. ledger.py

def test_ledger_records_telemetry_and_exports_only_mode_r_escapes(tmp_path):
    hdir = tmp_path / "scratch" / "hunt40299"
    (hdir / "R").mkdir(parents=True)
    (hdir / "A").mkdir(parents=True)
    (hdir / "state.json").write_text(json.dumps({
        "pr": "40299", "head": "acb8f87", "merge_base": "a2fe7c4", "batches": 2, "all_batches": False,
    }))
    (hdir / "skipped.log").write_text(
        "2 batch(es); hunting batch 1\n"
        "HUNT\tserver/channels/api4/properties.go\trisk=11 lines=20\n"
        "DEFERRED to batch 2\twebapp/channels/src/actions/websocket_actions.ts\trisk=11.5 lines=80\n"
    )
    (hdir / "A" / "response.json").write_text('{"files": []}')
    (hdir / "run_A.coverage.json").write_text(json.dumps({"reached": 0, "executable": 12}))
    (hdir / "R" / "response.json").write_text(json.dumps({
        "files": [{"path": "webapp/channels/src/actions/hunt_r.test.tsx", "content": "it('HuntR_CR1_stale', () => {});"}],
    }))
    (hdir / "review_verdicts.json").write_text(json.dumps({
        "pr": "40299",
        "verdicts": {
            "CR1": {
                "id": "CR1", "path": "webapp/channels/src/actions/websocket_actions.ts", "line": 1599,
                "severity": "minor", "triage": "open_current", "title": "Refetch options", "url": "https://ex/1",
                "verdict": "PROVEN", "base_verdict": "NEW_PR_BUG",
                "tests": {"webapp/channels/src/actions/hunt_r.test.tsx::HuntR_CR1_stale": "FAIL_3_OF_3"},
            },
            "CR2": {
                "id": "CR2", "path": "server/channels/api4/properties.go", "line": 100,
                "severity": "major", "triage": "open_current", "title": "Replica", "url": "https://ex/2",
                "verdict": "UNPROVABLE_DYNAMICALLY", "base_verdict": "", "tests": {},
            },
        },
    }))
    out_ledger = tmp_path / "telemetry" / "hunt_ledger.jsonl"
    (hdir / "vetted.json").write_text(json.dumps({"rows": [{
        "id": "CR1", "source": "R", "decision": "KEEP", "reason": "real", "file_line": "websocket_actions.ts:1599",
        "caller": "websocket handler", "entry_point": "websocket refetch", "repro_cmd": "npx jest hunt_r.test.tsx",
        "evidence_path": "review_verdicts.json", "severity": "minor", "fix_check": None,
    }]}))
    row = ledger.record("40299", hdir=hdir, out_path=out_ledger)
    assert row["confidence_tier"] == "Bug Proven"
    assert row["modes"]["mode_a_empty"] == 1
    assert row["deferred_count"] == 1
    assert row["mode_r_summary"] == {"proven": 1, "disproven": 0, "unprovable": 1, "unprovable_high_severity": 1}
    assert row["escapes"] == ["pr_40299_acb8f87_CR1.json"]
    bundle = json.loads((out_ledger.parent / "escapes" / "pr_40299_acb8f87_CR1.json").read_text())
    assert bundle["deferred_or_excluded"] == "DEFERRED to batch 2"
    assert "webapp/channels/src/actions/hunt_r.test.tsx" in bundle["repro_files"]
    assert len(ledger.list_escapes(out_ledger)) == 1

    # No escape bundle exported if Mode B also caught a bug on the same hunt.
    (hdir / "base_B.json").write_text('{"server/channels/api4::TestHuntB_X": "NEW_PR_BUG"}')
    out_ledger2 = tmp_path / "telemetry2" / "hunt_ledger.jsonl"
    row2 = ledger.record("40299", hdir=hdir, out_path=out_ledger2)
    assert row2["escapes"] == [] and ledger.list_escapes(out_ledger2) == []


# ------------------------------------------------------------------ 1B. lessons.py + build_requests.py

def test_lessons_require_path_and_diff_keywords_and_drop_monorepo_broad_globs(tmp_path):
    lsn_go = {"id": "L99", "pattern": "cfg", "applies_to": {"lang": ["go"], "path_globs": ["server/channels/app/*"]},
              "keywords": ["regenerateClientConfig"], "symptom": "s", "check": "c", "source_pr": 1}
    # Path hits, keyword ONLY inside sibling test -> score 0 (sibling tests are no longer searched).
    ctx_sib_only = {
        "changed_files_head_source": [{"file": "server/channels/app/foo.go"}],
        "diff_production_code": "+return nil",
        "sibling_tests_and_helpers": [{"file": "foo_test.go", "source": "regenerateClientConfig"}],
    }
    assert lessons.match(ctx_sib_only, [lsn_go]) == []
    # Path hits AND diff contains keyword -> matches.
    ctx_both = {**ctx_sib_only, "diff_production_code": "+ps.regenerateClientConfig()"}
    assert [m["id"] for m in lessons.match(ctx_both, [lsn_go])] == ["L99"]

    # Monorepo 2-segment root globs fail overbroad(); 3-segment globs pass.
    assert lessons.overbroad("server/channels/*") is True
    assert lessons.overbroad("webapp/channels/*") is True
    assert lessons.overbroad("server/channels/app/*") is False
    assert lessons.overbroad("webapp/channels/src/components/*") is False

    # Multi-batch hit logs (`40299/1`..`40299/30`) collapse to 1 hunt in prune() so 30 batches do not flush PRUNE_WINDOW.
    collapsed = [{"run": f"40299/{b}", "matched": []} for b in range(1, 31)]
    assert lessons.prune([lsn_go], collapsed, window=30) == []

    # Mode D never receives {lessons}.
    c = {"pr": {"title": "t"}, "diff_production_code": "+ps.regenerateClientConfig()",
         "changed_files_head_source": [{"file": "server/channels/app/platform/config.go", "source": ""}],
         "sibling_tests_and_helpers": [], "callers": [], "your_test_files": []}
    state = {"targets": [{"lang": "go", "dir": "server/channels/app/platform"}]}
    assert "Known false-positive patterns" in build_requests.hunter_system("A", state, c)
    assert "Known false-positive patterns" not in build_requests.hunter_system("D", state, c)


# ------------------------------------------------------------------ 1C. prefilter.py calibration

def test_prefilter_calibrates_2026_hotfix_hotspots():
    assert prefilter.risk(prefilter.FileDiff("server/public/model/property_field.go", 10, 2, "+type X struct{}\n")) >= 6.0
    assert prefilter.risk(prefilter.FileDiff("server/cmd/mmctl/commands/system.go", 10, 2, "+func run() {}\n")) >= 3.0
    assert prefilter.risk(prefilter.FileDiff("webapp/channels/src/components/panel.tsx", 10, 2, "+const a = 1;\n")) >= 3.0
    assert prefilter.risk(prefilter.FileDiff("webapp/channels/src/utils/url.ts", 10, 2, "+export const u = 1;\n")) >= 3.0


# ------------------------------------------------------------------ 1D. old_tests.py quotas

def test_old_tests_balances_go_and_jest_units_and_ranks_by_risk(tmp_path):
    repo = tmp_path / "rel"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    # Create 15 Go packages and 15 Jest component test files; one high-risk Go pkg (auth) and one high-risk Jest dir.
    for i in range(15):
        gdir = repo / f"server/channels/pkg{i:02d}"
        gdir.mkdir(parents=True)
        (gdir / "svc.go").write_text("package pkg\nfunc F() int { return 1 }\n")
        (gdir / "svc_test.go").write_text('package pkg\nimport "testing"\nfunc TestF(t *testing.T) {}\n')
        wdir = repo / f"webapp/channels/src/components/c{i:02d}"
        wdir.mkdir(parents=True)
        (wdir / "c.tsx").write_text("export const C = 1;\n")
        (wdir / "c.test.tsx").write_text("it('ok', () => {});\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    mb = _git(repo, "rev-parse", "HEAD")

    _git(repo, "checkout", "-qb", "rel")
    for i in range(15):
        gdir = repo / f"server/channels/pkg{i:02d}"
        line = "// checkAuth(session, token)" if i == 14 else "// tweak"
        (gdir / "svc.go").write_text(f"package pkg\n{line}\nfunc F() int {{ return 2 }}\n")
        (gdir / "svc_test.go").write_text('package pkg\nimport "testing"\nfunc TestF(t *testing.T) { _ = 2 }\n')
        wdir = repo / f"webapp/channels/src/components/c{i:02d}"
        wline = "// permission check" if i == 13 else "// ui"
        (wdir / "c.tsx").write_text(f"export const C = 2; {wline}\n")
        (wdir / "c.test.tsx").write_text("it('ok', () => { expect(2).toBe(2); });\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    head = _git(repo, "rev-parse", "HEAD")

    units, skipped = old_tests.plan(repo, mb, head)
    go_u = [u for u in units if u["lang"] == "go"]
    jest_u = [u for u in units if u["lang"] == "jest"]
    assert len(units) == 20 and len(go_u) == 10 and len(jest_u) == 10
    assert len(skipped) == 10
    assert go_u[0]["key"] == "server/channels/pkg14"  # highest production risk ranked first
    assert "components/c13/" in jest_u[0]["key"]


# ------------------------------------------------------------------ 1E. eval_bugs.py

def test_eval_bugs_kinds_skip_missing_locks_and_diff_gate(tmp_path, capsys):
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "a.go").write_text("package a\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    base = _git(repo, "rev-parse", "HEAD")
    (repo / "a.go").write_text("package a\nfunc X() int { return 1 }\n")
    _git(repo, "commit", "-qam", "hotfix bug commit")
    bug = _git(repo, "rev-parse", "HEAD")
    (repo / "a.go").write_text("package a\nfunc X() int { return 2 }\n")
    _git(repo, "commit", "-qam", "forward fix")
    fix = _git(repo, "rev-parse", "HEAD")

    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({
        "cases": [
            {"id": "hotfix-1", "kind": "rc_hotfix", "repo": str(repo), "bug_sha": bug, "base_sha": base,
             "fix_sha": fix, "area": "a", "bug": "X returned 1", "source": "PR #1", "lock": True},
            {"id": "missing-pr", "kind": "pre_merge_review", "repo": str(repo),
             "bug_sha": "0" * 40, "area": "a", "bug": "unmerged", "source": "PR #2"},
        ],
        "controls": [{"id": "ctl-1", "repo": str(repo), "sha": fix, "area": "a"}],
    }))
    # Strict load fails on missing SHA; --skip-missing validates the merged SHA and skips missing_pr.
    assert eval_bugs.main(["eval_bugs.py", str(manifest), "--validate-only"]) == 2
    capsys.readouterr()
    assert eval_bugs.main(["eval_bugs.py", str(manifest), "--skip-missing", "--validate-only"]) == 0
    assert "cases=1 controls=1 skipped_missing=1" in capsys.readouterr().out

    # diff_scorecards gate: passes on equal/improved recall within FP budget, fails on lock regression or high FP.
    base_card = tmp_path / "base.json"
    cand_card = tmp_path / "cand.json"
    base_card.write_text(json.dumps({
        "metrics": {"vetted_recall": 0.5, "fp_rate": 0.0},
        "rows": [{"kind": "case", "id": "hotfix-1", "lock": True, "vetted": True, "hunters_new_api": False}],
    }))
    cand_card.write_text(json.dumps({
        "metrics": {"vetted_recall": 0.5, "fp_rate": 0.0},
        "rows": [{"kind": "case", "id": "hotfix-1", "lock": True, "vetted": True, "hunters_new_api": False}],
    }))
    assert eval_bugs.main(["eval_bugs.py", "diff", str(base_card), str(cand_card)]) == 0
    capsys.readouterr()
    assert eval_bugs.diff_scorecards(
        json.loads(base_card.read_text()),
        {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0},
         "rows": [{"kind": "case", "id": "hotfix-1", "lock": True, "vetted": False, "hunters_new_api": False}]},
    )["verdict"] == "FAIL"
    cand_bad_fp = tmp_path / "cand_fp.json"
    cand_bad_fp.write_text(json.dumps({
        "metrics": {"vetted_recall": 1.0, "fp_rate": 0.10},
        "rows": [{"kind": "case", "id": "hotfix-1", "lock": True, "vetted": True, "hunters_new_api": False}],
    }))
    assert eval_bugs.main(["eval_bugs.py", "diff", str(base_card), str(cand_bad_fp)]) == 1
    assert eval_bugs.diff_scorecards(
        json.loads(base_card.read_text()),
        {"metrics": {"vetted_recall": 1.0, "fp_rate": 0.0},
         "rows": [{"kind": "case", "id": "hotfix-1", "lock": True, "vetted": True, "hunters_new_api": False}],
         "errors": ["c1"]},
    )["verdict"] == "FAIL"
    assert eval_bugs.diff_scorecards(
        json.loads(base_card.read_text()),
        {"metrics": {"vetted_recall": 1.0, "fp_rate": 0.0}, "rows": []},
    )["lock_regressions"] == ["hotfix-1"]


def test_review_signal_verdicts_do_not_leak_into_hunter_metrics(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    (hdir / "R").mkdir(parents=True)
    (hdir / "R" / "threads.json").write_text(json.dumps({
        "pr": "1",
        "included": [{
            "id": "CR1", "path": "pkg/a.go", "line": 10, "severity": "major",
            "triage": "open_current", "is_resolved": False, "is_outdated": False,
            "title": "Claim", "url": "https://ex/1",
        }],
        "skipped": [],
        "non_coderabbit": 0,
    }))
    (hdir / "R" / "response.json").write_text(json.dumps({
        "files": [],
        "claims": [{"id": "CR1", "testable": True, "tests": ["TestR"]}],
    }))
    (hdir / "run_R.json").write_text(json.dumps({"pkg::TestR": "FAIL_3_OF_3"}))
    (hdir / "base_R.json").write_text(json.dumps({"pkg::TestR": "NEW_PR_BUG"}))
    monkeypatch.setattr(eval_bugs, "hunt_tag", lambda *a, **kw: {
        "batch": 1, "hunter": "R", "run": {"pkg::TestR": "FAIL_3_OF_3"}, "base": {"pkg::TestR": "NEW_PR_BUG"},
    })
    row = eval_bugs.review_signal(1, hdir, {"targets": []}, {"title": "", "body": ""}, {"id": "c1"}, None)
    assert "run" not in row and "base" not in row
    assert row["review"] == {"CR1": "PROVEN"}
    f = eval_bugs.flags({"results": [row]}, eval_bugs.ALL_SIGNALS)
    raw, vetted = eval_bugs.score({"results": [row]})
    assert f["review_proven"] is True
    assert f["hunters_vetted"] is False and raw is False and vetted is False


def test_audit_hardening_ledger_tiers_review_edges_and_empty_archive(tmp_path):
    # Empty A with run_A.json == {} still counts mode_a_empty -> Partial or Unverified Coverage; full clean run -> High-Confidence Clean.
    h_empty = tmp_path / "h_empty"
    (h_empty / "A").mkdir(parents=True)
    (h_empty / "state.json").write_text(json.dumps({"pr": "10", "head": "h", "merge_base": "b", "batches": 1}))
    (h_empty / "A" / "response.json").write_text('{"files": []}')
    (h_empty / "run_A.json").write_text("{}")
    row_e = ledger.record("10", hdir=h_empty, out_path=tmp_path / "l1.jsonl")
    assert row_e["modes"]["mode_a_empty"] == 1
    assert row_e["confidence_tier"] == "Partial or Unverified Coverage"

    h_clean = tmp_path / "h_clean"
    h_clean.mkdir(parents=True)
    (h_clean / "state.json").write_text(json.dumps({"pr": "11", "head": "h", "merge_base": "b", "batches": 1}))
    (h_clean / "run_A.json").write_text('{"p::T": "PASS"}')
    (h_clean / "run_B.json").write_text('{"p::T": "PASS"}')
    (h_clean / "diff_D.json").write_text('{"p::D": "SAME"}')
    (h_clean / "run_A.coverage.json").write_text('{"reached": 3, "executable": 5}')
    assert ledger.record("11", hdir=h_clean, out_path=tmp_path / "l2.jsonl")["confidence_tier"] == "High-Confidence Clean"

    (h_clean / "diff_D.json").write_text('{"p::D": "NONDETERMINISTIC"}')
    assert ledger.record("11", hdir=h_clean, out_path=tmp_path / "l2.jsonl")["confidence_tier"] == "Partial or Unverified Coverage"

    # review_threads: bold badge severity + out-of-bounds focus line clamping + missing run_R.json hint.
    assert review_threads.parse_severity("**Major**\n\n**Issue**") == "major"
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "pkg" / "big.go").write_text("".join(f"// L{i}\n" for i in range(1, 1605)))
    view = review_threads.thread_source_view(wt, "pkg/big.go", "", [99999])
    assert view and "// L1600" in view

    h_r = tmp_path / "h_r"
    (h_r / "R").mkdir(parents=True)
    (h_r / "R" / "threads.json").write_text(json.dumps({
        "pr": "55",
        "included": [{
            "id": "CR1", "path": "pkg/a.go", "line": 1, "severity": "major",
            "triage": "open_current", "is_resolved": False, "is_outdated": False, "title": "t", "url": "u",
        }],
    }))
    (h_r / "R" / "response.json").write_text(json.dumps({
        "files": [{"path": "pkg/hunt_huntr_test.go", "content": "package pkg\n"}],
        "claims": [{"id": "CR1", "testable": True, "tests": ["TestCR1"]}],
    }))
    ver = review_threads.compute_verdicts(h_r)["verdicts"]["CR1"]
    assert ver["verdict"] == "UNPROVABLE_DYNAMICALLY" and "run.py run 55 R" in ver["reason"]

    # ctx.archive_batch with no hunter outputs never creates an empty batches/batch_N directory,
    # and repeat archival of a batch preserves prior completed archive as batch_1.2.
    h_arch = tmp_path / "h_arch"
    h_arch.mkdir()
    (h_arch / "ctx.json").write_text("{}")
    ctx.archive_batch(h_arch, 1)
    assert not (h_arch / "batches").exists()
    (h_arch / "run_A.json").write_text('{"p::T": "PASS"}')
    ctx.archive_batch(h_arch, 1)
    (h_arch / "run_A.json").write_text('{"p::T2": "PASS"}')
    ctx.archive_batch(h_arch, 1)
    assert (h_arch / "batches" / "batch_1" / "run_A.json").exists()
    assert (h_arch / "batches" / "batch_1.2" / "run_A.json").exists()


def test_coderabbit_review_fixes_flags_scorecards_lessons_ledger_and_review_freshness(tmp_path, capsys):
    # eval_bugs.flags handles nested new_api dict metadata without TypeError; diff_scorecards checks population & strings.
    entry = {"results": [{"hunter": "A", "base": {"pkg::T": "NEW_API", "new_api": {"pkg::T": ["Sym"]}}}]}
    assert eval_bugs.flags(entry)["hunters_new_api"] is True
    base_c = {"metrics": {"vetted_recall": "0.5", "fp_rate": "0.0"}, "rows": [{"kind": "case", "id": "c1", "lock": False, "vetted": True}]}
    same_c = {"metrics": {"vetted_recall": "0.5", "fp_rate": "0.0"}, "rows": [{"kind": "case", "id": "c1", "lock": False, "vetted": True}]}
    pop_c = {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0}, "rows": [{"kind": "case", "id": "c2", "lock": False, "vetted": True}]}
    assert eval_bugs.diff_scorecards(base_c, same_c)["cand_vetted_recall"] == 0.5
    assert eval_bugs.diff_scorecards(base_c, pop_c)["population_ok"] is False
    assert eval_bugs.diff_scorecards(base_c, pop_c)["verdict"] == "FAIL"

    # lessons.prune merges hits across batches of one target so earlier matches are retained.
    lsn = {"id": "L77", "pattern": "p", "applies_to": {"lang": ["go"], "path_globs": ["server/channels/app/*"]},
           "keywords": ["k"], "symptom": "s", "check": "c", "source_pr": 1}
    logs = [{"run": "40299", "matched": ["L77"]}, {"run": "40299", "matched": []}] + [
        {"run": str(1000 + i), "matched": []} for i in range(29)
    ]
    assert lessons.prune([lsn], logs, window=30) == []

    # ledger classifies unvetted FAIL_3_OF_3 or plain PR_TEST_FAILS as Partial or Unverified Coverage.
    h_unv = tmp_path / "h_unv"
    h_unv.mkdir()
    (h_unv / "state.json").write_text(json.dumps({"pr": "12", "head": "aaa", "merge_base": "bbb", "batches": 1}))
    (h_unv / "run_A.json").write_text('{"p::T": "PASS"}')
    (h_unv / "run_B.json").write_text('{"p::T": "FAIL_3_OF_3"}')
    (h_unv / "diff_D.json").write_text('{"p::D": "SAME"}')
    assert ledger.record("12", hdir=h_unv, out_path=tmp_path / "lu.jsonl")["confidence_tier"] == "Partial or Unverified Coverage"
    (h_unv / "run_B.json").write_text('{"p::T": "PASS"}')
    (h_unv / "pr_tests.json").write_text('{"tests": {"ci::TestA": "PR_TEST_FAILS"}}')
    assert ledger.record("12", hdir=h_unv, out_path=tmp_path / "lu.jsonl")["confidence_tier"] == "Partial or Unverified Coverage"

    # review_threads rejects orphan run_R.json without R/response.json (expected_digest is None) & clears shifted thread IDs.
    h_rt = tmp_path / "h_rt"
    (h_rt / "R").mkdir(parents=True)
    (h_rt / "R" / "threads.json").write_text(json.dumps({
        "pr": "77",
        "included": [{
            "thread_id": "T1", "id": "CR1", "path": "pkg/a.go", "line": 1, "severity": "major",
            "triage": "open_current", "is_resolved": False, "is_outdated": False, "title": "t", "url": "u",
        }],
    }))
    (h_rt / "run_R.json").write_text('{"pkg::HuntR_CR1": "PASS"}')
    assert review_threads.compute_verdicts(h_rt)["verdicts"]["CR1"]["verdict"] == "UNPROVABLE_DYNAMICALLY"
    (h_rt / "R" / "response.json").write_text('{"files": []}')
    repo = tmp_path / "repo_rt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    (repo / "pkg").mkdir()
    (repo / "pkg" / "a.go").write_text("package pkg\nfunc F() {}\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "init")
    mb = _git(repo, "rev-parse", "HEAD")
    review_threads.build_review_context(
        "77", h_rt, {"repo": str(repo), "wt": str(repo), "wt_base": str(repo), "merge_base": mb, "head": mb}, {},
        raw_threads=[{
            "id": "T2", "isResolved": False, "isOutdated": False, "path": "pkg/a.go", "line": 1,
            "comments": {"nodes": [{"databaseId": 2, "url": "u", "author": {"login": "coderabbitai[bot]"},
                                    "body": "**Major**\n\n**Shifted.**"}]},
        }],
    )
    assert not (h_rt / "run_R.json").exists() and not (h_rt / "R" / "response.json").exists()
