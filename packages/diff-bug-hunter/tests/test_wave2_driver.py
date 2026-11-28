# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Unattended driver: dispatch.py (backoff, idempotency, telemetry), prepare.py (schema stamp, two-dot base, docker
services), report.py (findings.json and audit.md), and hunt.py end to end on the go_bug and react_bug fixtures with a
fake dispatch command that copies canned responses. No sleeps: the backoff test injects its own sleep."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import dispatch
import hunt
import prepare
import pytest
import report
import telemetry
import verdict
from conftest import (
    FAKE_DISPATCH,
    JESTDEPS,
    _git,
    cli_json,
    make_repo,
    needs_jest,
    vetted_row,
)
from conftest import (
    canned_responses as _canned,
)
from conftest import (
    e2e_repo as _e2e_repo,
)
from conftest import (
    fake_script as _fake,
)
from hunt_common import hunt_dir, worktree_paths, write_json

FLAKY_THEN_OK = '''
import json, os, sys
from pathlib import Path
req = Path(sys.argv[-1])
count = Path(os.environ["FAKE_COUNT"])
n = int(count.read_text()) if count.exists() else 0
count.write_text(str(n + 1))
if n == 0:
    print("API Error: 502 upstream_unreachable", file=sys.stderr)
    sys.exit(1)
Path(json.loads(req.read_text())["response_path"]).write_text(json.dumps({"files": [], "tests": []}))
'''


def _request(hdir: Path, tag: str) -> Path:
    d = hdir / tag
    d.mkdir(parents=True, exist_ok=True)
    path = d / "request.json"
    write_json(path, {"tier": "opus", "system": "s", "user": "{}", "schema": {"type": "object"},
                      "response_path": str(d / "response.json")})
    return path


# ------------------------------------------------------------------ dispatch.py

def test_dispatch_retries_a_502_with_backoff_then_succeeds(tmp_path, monkeypatch):
    cmd = _fake(tmp_path, "flaky.py", FLAKY_THEN_OK)
    monkeypatch.setenv("FAKE_COUNT", str(tmp_path / "count"))
    hdir = tmp_path / "hunt"
    req = _request(hdir, "A")
    sleeps: list[float] = []
    res = dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="A", sleep=sleeps.append)
    assert res.status == "ok" and res.retries == 1
    assert sleeps == [1.0]  # first backoff; the second attempt succeeded
    assert json.loads((hdir / "A" / "response.json").read_text()) == {"files": [], "tests": []}
    row = [json.loads(x) for x in (hdir / "telemetry.jsonl").read_text().splitlines()][-1]
    assert row["stage"] == "dispatch" and row["retries"] == 1 and row["exit"] == "ok" and row["tag"] == "A"


def test_dispatch_gives_up_after_five_tries_with_capped_exponential_backoff(tmp_path):
    cmd = _fake(tmp_path, "down.py", "import sys\nprint('API Error: 503 overloaded', file=sys.stderr)\nsys.exit(1)\n")
    hdir = tmp_path / "hunt"
    req = _request(hdir, "B")
    sleeps: list[float] = []
    with pytest.raises(dispatch.DispatchError, match="503"):
        dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="B", sleep=sleeps.append)
    assert sleeps == [1.0, 2.0, 4.0, 8.0]  # 5 tries = 4 waits
    row = [json.loads(x) for x in (hdir / "telemetry.jsonl").read_text().splitlines()][-1]
    assert row["exit"] == "DispatchError" and row["retries"] == 4


def test_a_non_transient_failure_is_not_retried(tmp_path):
    cmd = _fake(tmp_path, "bad.py", "import sys\nprint('no such model', file=sys.stderr)\nsys.exit(2)\n")
    hdir = tmp_path / "hunt"
    sleeps: list[float] = []
    with pytest.raises(dispatch.DispatchError):
        dispatch.dispatch(_request(hdir, "B"), cmd=cmd, hdir=hdir, tag="B", sleep=sleeps.append)
    assert sleeps == []


def test_dispatch_is_idempotent_per_request_sha(tmp_path, monkeypatch):
    cmd = _fake(tmp_path, "fake.py", FAKE_DISPATCH)
    log = tmp_path / "log"
    responses = tmp_path / "responses"
    (responses / "D").mkdir(parents=True)
    (responses / "D" / "response.json").write_text(json.dumps({"files": [{"path": "x"}], "tests": []}))
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    hdir = tmp_path / "hunt"
    req = _request(hdir, "D")
    first = dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="D")
    second = dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="D")
    req.write_text(req.read_text().replace('"system": "s"', '"system": "changed"'))  # a new request: dispatch again
    third = dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="D")
    assert (first.status, second.status, third.status) == ("ok", "skipped", "ok")
    assert log.read_text().splitlines() == ["D", "D"]  # the fake ran for the first and the changed request only
    assert json.loads((hdir / "D" / "response.json").read_text()) == {"files": [{"path": "x"}], "tests": []}


def test_default_command_is_one_inline_turn_with_no_tools(tmp_path, monkeypatch):
    """The model gets the request as its system prompt and stdin and no tools: text in a diff cannot make it read
    or write a file. The script, not the model, writes response.json."""
    seen: dict[str, object] = {}

    def fake_run(argv, **kw):
        seen["argv"], seen["input"] = argv, kw["input"]
        seen["system"] = Path(argv[argv.index("--system-prompt-file") + 1]).read_text()
        return subprocess.CompletedProcess(argv, 0, stdout=cli_json({"files": [], "tests": ["t"]}, markdown=True), stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)
    hdir = tmp_path / "hunt"
    req = _request(hdir, "A")
    res = dispatch.dispatch(req, hdir=hdir, tag="A")
    argv = seen["argv"]
    assert argv[:argv.index("--system-prompt-file")] == [
        "claude", "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
        "--setting-sources", ""]
    assert "Read" not in " ".join(argv) and "acceptEdits" not in argv
    assert str(seen["system"]).startswith("s\n\n") and "no tools" in str(seen["system"])
    assert "# Schema" in str(seen["input"]) and str(req) not in str(seen["input"])
    assert json.loads((hdir / "A" / "response.json").read_text()) == {"files": [], "tests": ["t"]}
    assert (res.tokens_in, res.cache_write, res.cache_read, res.tokens_out, res.cost_usd) == (10, 5, 1, 4, 0.5)
    summ = telemetry.summarize(hdir)
    assert (summ["tokens_in"], summ["cache_write"], summ["cache_read"], summ["tokens_out"],
            summ["total_cost_usd"]) == (10, 5, 1, 4, 0.5)


def test_failed_call_reports_the_cli_result_text(tmp_path, monkeypatch):
    """The CLI prints a long JSON object on failure. The error must carry its `result` text, not only the tail."""
    def fake_run(argv, **kw):
        out = json.dumps({"is_error": True, "subtype": "success", "result": "Claude usage limit reached",
                          "padding": "x" * 2000})
        return subprocess.CompletedProcess(argv, 1, stdout=out, stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)
    hdir = tmp_path / "hunt"
    with pytest.raises(dispatch.DispatchError) as e:
        dispatch.dispatch(_request(hdir, "A"), hdir=hdir, tag="A", sleep=lambda _s: None)
    assert "Claude usage limit reached" in str(e.value)


def test_inline_answer_without_json_fails_and_writes_nothing(tmp_path, monkeypatch):
    def fake_run(argv, **kw):
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({"result": "I cannot help."}), stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)
    hdir = tmp_path / "hunt"
    req = _request(hdir, "A")
    with pytest.raises(dispatch.DispatchError, match="not JSON"):
        dispatch.dispatch(req, hdir=hdir, tag="A")
    assert not (hdir / "A" / "response.json").exists() and not dispatch.is_answered(req)


def test_inline_input_sends_the_md_user_and_schema_sections(tmp_path):
    hdir = tmp_path / "hunt"
    req = _request(hdir, "A")
    doc = json.loads(req.read_text())
    doc["user"] = "line1\nline2"
    req.write_text(json.dumps(doc))
    req.with_suffix(".md").write_text("# Request\n\nWrite to /x\n\n# System\n\nsys\n\n# User\n\nstale_md\n\n"
                                      "# Schema\n\n```json\n{}\n```\n")
    system, stdin = dispatch._inline_input(req)
    assert stdin.startswith("# User\n\nline1\nline2") and "# Schema" in stdin and "stale_md" not in stdin
    assert system.startswith("s\n\n")


def test_dispatch_slots_cap_concurrent_calls_and_wait_with_jitter(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_MAX_DISPATCH", "1")
    monkeypatch.setattr(dispatch, "TIMEOUT_S", 2)
    naps: list[float] = []
    with dispatch.slot(), pytest.raises(dispatch.DispatchError, match="no free dispatch slot"), dispatch.slot(naps.append):
        pass
    assert naps and all(0.5 <= n <= 1.5 for n in naps)
    with dispatch.slot(naps.append):  # released: the next call gets the slot at once
        pass


# ------------------------------------------------------------------ prepare.py

def _two_commit_repo(tmp: Path, master_advances: bool) -> Path:
    repo = make_repo(
        tmp,
        {"calc/calc.go": "package calc\n\nfunc F() int { return 1 }\n", "go.mod": "module x\n"},
        {"calc/calc.go": "package calc\n\nfunc F() int { return 2 }\n"},
    )
    if master_advances:
        _git(repo, "checkout", "-q", "master")
        (repo / "other.txt").write_text("later\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "master moves on")
    return repo


def test_two_dot_range_uses_the_base_ref_itself_not_the_merge_base(tmp_path, monkeypatch):
    repo = _two_commit_repo(tmp_path, master_advances=True)
    monkeypatch.setenv("HUNT_MM", str(repo))
    prepare.main("master..feature")
    prep = json.loads((hunt_dir("master..feature") / "prepare.json").read_text())
    assert prep["merge_base"] == _git(repo, "rev-parse", "master")  # the tip, not the fork point
    assert _git(Path(prep["wt_base"]), "rev-parse", "HEAD") == prep["merge_base"]
    assert prep["base_mode"] == "two-dot" and prep["schema_version"] == prepare.SCHEMA_VERSION
    assert "return 1" in (Path(prep["wt_base"]) / "calc" / "calc.go").read_text()


def test_three_dot_range_still_uses_the_merge_base(tmp_path, monkeypatch):
    repo = _two_commit_repo(tmp_path, master_advances=True)
    monkeypatch.setenv("HUNT_MM", str(repo))
    prepare.main("master...feature")
    prep = json.loads((hunt_dir("master...feature") / "prepare.json").read_text())
    assert prep["merge_base"] == _git(repo, "rev-parse", "master^")  # the fork point
    assert prep["base_mode"] == "merge-base"


def test_a_hunt_dir_from_another_schema_is_refused_unless_fresh_or_the_head_moved(tmp_path, monkeypatch):
    repo = _two_commit_repo(tmp_path, master_advances=False)
    monkeypatch.setenv("HUNT_MM", str(repo))
    head = _git(repo, "rev-parse", "feature")
    hdir = hunt_dir("master..feature")
    write_json(hdir / "prepare.json", {"head": head})  # no schema_version: an older layout of this same head
    with pytest.raises(prepare.SchemaMismatch):
        prepare.check_schema(hdir, head, fresh=False)
    prepare.check_schema(hdir, head, fresh=True)  # --fresh starts over: no error
    prepare.check_schema(hdir, "some-moved-head", fresh=False)  # a moved head starts over by itself
    env = {**os.environ, "HUNT_MM": str(repo)}
    p = subprocess.run([sys.executable, str(hunt.SCRIPTS / "prepare.py"), "master..feature"], env=env,
                       capture_output=True, text=True, check=False)
    assert p.returncode == 5 and "SCHEMA_MISMATCH" in p.stdout


def test_services_use_docker_containers_on_fixed_ports_when_docker_is_usable(monkeypatch):
    calls: list[list[str]] = []

    def fake_sh(args, cwd, *, check=True, timeout=1800, env=None):
        calls.append(list(args))
        rc = 1 if args[:2] == ["docker", "inspect"] else 0
        out = "PONG" if args[-1:] == ["ping"] else ""
        return subprocess.CompletedProcess(args, rc, stdout=out, stderr="")

    monkeypatch.setattr(prepare, "docker_usable", lambda: True)
    monkeypatch.setattr(prepare, "sh", fake_sh)
    prepare.services_up()
    assert ["docker", "run", "-d", "--name", "hunt-pg", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
            "-p", "127.0.0.1:5432:5432", "postgres:18.3", "-c", "max_connections=400"] in calls
    assert ["docker", "run", "-d", "--name", "hunt-redis", "-p", "127.0.0.1:6379:6379", "redis:7"] in calls
    assert not any(c[:1] == ["pg_isready"] for c in calls)  # the host tools were not needed


def test_without_docker_services_use_the_host_tools(monkeypatch):
    calls: list[list[str]] = []

    def fake_sh(args, cwd, *, check=True, timeout=1800, env=None):
        calls.append(list(args))
        return subprocess.CompletedProcess(args, 0, stdout="PONG" if args[0] == "redis-cli" else "", stderr="")

    monkeypatch.setattr(prepare, "docker_usable", lambda: False)
    monkeypatch.setattr(prepare, "sh", fake_sh)
    prepare.services_up()
    assert calls == [["pg_isready", "-h", "localhost"], ["pg_isready", "-h", "localhost"], ["redis-cli", "ping"]]


# ------------------------------------------------------------------ report.py

def _keep_row() -> dict:
    return vetted_row(
        id="calc::TestHuntA_Clamp", reason="Clamp returns hi+1 for hi.", file_line="calc/calc.go:9",
        caller="api4 PUT /x", entry_point="api4 PUT /x", repro_cmd="go test ./calc -run TestHuntA_Clamp",
        mechanical_verdict="NEW_PR_BUG",
    )


def test_report_writes_only_kept_findings_in_the_schema_shape_and_gaps_in_the_audit(tmp_path):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "x", "head": "h", "merge_base": "m", "batches": 1})
    write_json(hdir / "prepare.json", {"schema_version": 1, "head": "h", "merge_base": "m", "base_mode": "two-dot"})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [_keep_row()],
                                       "held": [{"row": {"id": "t2", "source": "B"}, "reasons": ["repro_cmd missing"]}]})
    write_json(hdir / "driver.json", {"gaps": {"dispatch:B": "B failed"}})
    telemetry.record(hdir, "step:prepare", secs=1.5, cost_usd=0.0)
    telemetry.record(hdir, "dispatch", tag="A", secs=2.0, tokens_in=100, cache_write=60, cache_read=30,
                     tokens_out=20, cost_usd=0.25)
    out = report.write(hdir, "x")
    findings = json.loads((hdir / "findings.json").read_text())
    assert out == {"tier": "Bug Proven", "findings": 1, "kept_tests": 1, "held": 1, "dropped": 0}
    assert set(findings[0]) == set(report.FINDING_KEYS)
    assert findings[0]["base_result"] == "NEW_PR_BUG" and findings[0]["head_result"] == "FAIL_3_OF_3"
    assert findings[0]["contradicts"] is None and findings[0]["actor_roles"] == []
    audit = (hdir / "audit.md").read_text()
    assert "Bug Proven" in audit and "dispatch:B: B failed" in audit and "repro_cmd missing" in audit
    assert "| dispatch | 1 | 2.0 | 100 | 60 | 30 | 20 | 0.2500 | 0 |" in audit
    assert "- Tokens in (cache write / cache read) / out: 100 (60 / 30) / 20" in audit


def test_report_without_keeps_is_partial_when_a_driver_gap_exists(tmp_path):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "x", "batches": 1})
    write_json(hdir / "driver.json", {"gaps": {"run:B": "hunter B wrote no response"}})
    out = report.write(hdir, "x")
    assert out["tier"] == "Partial or Unverified Coverage" and out["findings"] == 0
    assert json.loads((hdir / "findings.json").read_text()) == []
    assert "run:B: hunter B wrote no response" in (hdir / "audit.md").read_text()


def test_a_held_candidate_without_keeps_is_partial_and_a_drop_is_listed_apart(tmp_path):
    """PR 40364: one Mode D candidate was HELD (no entry point) and the audit still said High-Confidence Clean.
    PR 39683: a skeptic DROP was listed under HELD."""
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "x", "batches": 1})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [
        {"row": {"id": "t_held", "source": "D", "decision": "HELD"}, "reasons": ["entry_point missing"]},
        {"row": {"id": "t_drop", "source": "D", "decision": "DROP", "reason": "intended permission check"},
         "reasons": ["decision=DROP"]}]})
    out = report.write(hdir, "x")
    assert out == {"tier": "Partial or Unverified Coverage", "findings": 0, "kept_tests": 0, "held": 1, "dropped": 1}
    audit = (hdir / "audit.md").read_text()
    assert "1 candidate(s) HELD: unresolved, not reported" in audit
    assert "## Dropped by the skeptic (1)" in audit and "intended permission check" in audit
    assert json.loads((hdir / "findings.json").read_text()) == []


def test_only_dropped_candidates_leave_the_tier_clean(tmp_path):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "x", "batches": 1})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [
        {"row": {"id": "t_drop", "source": "D", "decision": "DROP", "reason": "r"}, "reasons": ["decision=DROP"]}]})
    out = report.write(hdir, "x")
    assert out["held"] == 0 and out["dropped"] == 1
    assert "HELD: unresolved" not in (hdir / "audit.md").read_text()


# ------------------------------------------------------------------ hunt.py end to end

def _run_driver(monkeypatch, tmp: Path, target: str, responses: Path, log: Path, cmd: str) -> int:
    monkeypatch.setenv("HUNT_DISPATCH_CMD", cmd)
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    monkeypatch.setenv("FAKE_LOG", str(log))
    return hunt.main(["hunt.py", target])


def test_end_to_end_go_bug_driver_writes_findings_audit_and_telemetry_and_resumes(tmp_path, monkeypatch):
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses, log = _canned(tmp_path, "go_bug", "calc::TestHuntA_ClampRangeAndIdentity", "A")
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    assert _run_driver(monkeypatch, tmp_path, "master..feature", responses, log, cmd) == 0
    hdir = hunt_dir("master..feature")
    findings = json.loads((hdir / "findings.json").read_text())
    assert len(findings) == 1 and findings[0]["head_result"] == "FAIL_3_OF_3"
    assert "run.py repro master..feature A --only calc::TestHuntA_ClampRangeAndIdentity" in findings[0]["repro_cmd"]
    assert json.loads((hdir / "run_A.json").read_text()) == {"calc::TestHuntA_ClampRangeAndIdentity": "FAIL_3_OF_3"}
    assert json.loads((hdir / "base_A.json").read_text()) == {"calc::TestHuntA_ClampRangeAndIdentity": "NEW_PR_BUG"}
    audit = (hdir / "audit.md").read_text()
    assert "**Bug Proven**" in audit and "Telemetry" in audit
    rows = [json.loads(x) for x in (hdir / "telemetry.jsonl").read_text().splitlines()]
    stages = {r["stage"] for r in rows}
    assert {"step:prepare", "step:ctx", "step:dispatch", "step:run", "step:base", "step:vet", "step:report",
            "dispatch"} <= stages
    assert all(r["exit"] == "ok" for r in rows)
    calls_first = log.read_text().splitlines()
    assert {"A", "B", "vet"} <= set(calls_first)
    assert "D" not in calls_first
    # Resume: every output exists, so nothing is dispatched again and the findings are unchanged.
    assert _run_driver(monkeypatch, tmp_path, "master..feature", responses, log, cmd) == 0
    assert log.read_text().splitlines() == calls_first
    assert json.loads((hdir / "findings.json").read_text()) == findings


def test_end_to_end_go_bug_driver_runs_mode_d_when_opted_in(tmp_path, monkeypatch):
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses, log = _canned(tmp_path, "go_bug", "calc::TestHuntA_ClampRangeAndIdentity", "A")
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", cmd)
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    monkeypatch.setenv("FAKE_LOG", str(log))
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,B,D"]) == 0
    calls = log.read_text().splitlines()
    assert {"A", "B", "D", "vet"} <= set(calls)
    hdir = hunt_dir("master..feature")
    assert json.loads((hdir / "driver.json").read_text())["modes"] == ["A", "B", "D"]
    assert json.loads((hdir / "state.json").read_text())["modes"] == ["A", "B", "D"]


@needs_jest
def test_end_to_end_react_bug_driver_finds_the_react_regression(tmp_path, monkeypatch):
    _e2e_repo(tmp_path, "react_bug", monkeypatch)
    target = "master..feature"
    prepare.main(target)  # prepare first, then link the jest deps into the worktrees the driver will use
    wt, wt_base = worktree_paths(target)
    for w in (wt, wt_base):
        (w / "web" / "node_modules").unlink(missing_ok=True)
        (w / "web" / "node_modules").symlink_to(JESTDEPS)
    responses, log = _canned(tmp_path, "react_bug", "web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax", "A")
    vet_p = responses / "vet" / "response.json"
    vet_doc = json.loads(vet_p.read_text())
    vet_doc["rows"][0].update(
        file_line="web/src/counter.tsx:10",
        caller="Counter component under test",
        entry_point="Counter (React component)",
        repro_cmd="npx jest web/src/hunt_a.test.tsx",
    )
    vet_p.write_text(json.dumps(vet_doc))
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    assert _run_driver(monkeypatch, tmp_path, target, responses, log, cmd) == 0
    hdir = hunt_dir(target)
    run_a = json.loads((hdir / "run_A.json").read_text())
    assert run_a == {"web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "FAIL_3_OF_3"}
    assert json.loads((hdir / "base_A.json").read_text()) == {
        "web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "NEW_PR_BUG"}
    findings = json.loads((hdir / "findings.json").read_text())
    assert [f["file_line"] for f in findings] == ["web/src/counter.tsx:10"]




def test_resolve_ref_takes_a_local_sha_and_fetches_branches_without_fetch_head(tmp_path):
    """A range of two shas already in the clone failed: `git fetch origin <sha>` left FETCH_HEAD without the commit,
    and parallel hunts share FETCH_HEAD. resolve_ref must not read FETCH_HEAD."""
    import prepare
    origin = _two_commit_repo(tmp_path, master_advances=True)
    clone = tmp_path / "clone"
    _git(tmp_path, "clone", "-q", str(origin), str(clone))
    head = _git(origin, "rev-parse", "feature").strip()
    master = _git(origin, "rev-parse", "master").strip()
    (clone / ".git" / "FETCH_HEAD").write_text("")  # what a no-op fetch of a present object leaves behind
    assert prepare.resolve_ref(clone, head) == head
    assert prepare.resolve_ref(clone, head[:10]) == head
    assert prepare.resolve_ref(clone, "master") == master
    assert prepare.resolve_ref(clone, "feature") == head


def test_a_mode_v_compile_error_is_a_gap_and_the_hunt_still_vets_and_reports(tmp_path, monkeypatch):
    """PR 40163: the Mode V test titles did not start with HuntV_, run.py run V exited 3 (COMPILE_ERROR), and the
    driver stopped with INFRA_ERROR before vetting the A/B candidates it already had."""
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses, log = _canned(tmp_path, "go_bug", "calc::TestHuntA_ClampRangeAndIdentity", "A")
    (responses / "V").mkdir()
    (responses / "V" / "response.json").write_text(json.dumps({"files": [{
        "path": "calc/hunt_huntv_test.go",
        "content": "package calc\n\nimport \"testing\"\n\nfunc TestWrongName(t *testing.T) {}\n"}], "tests": []}))
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    assert _run_driver(monkeypatch, tmp_path, "master..feature", responses, log, cmd) == 0
    hdir = hunt_dir("master..feature")
    assert "vet" in log.read_text().splitlines()
    assert "Mode V COMPILE_ERROR" in json.loads((hdir / "driver.json").read_text())["gaps"]["vet_v"]
    audit = (hdir / "audit.md").read_text()
    assert "vet_v: Mode V COMPILE_ERROR" in audit
    assert len(json.loads((hdir / "findings.json").read_text())) == 1


def test_mode_v_prompt_names_jest_tests_with_the_prefix_run_py_requires():
    assert "'HuntV_<name>'" in hunt.V_SYSTEM


# ------------------------------------------------------------------ skeptic input (live runs: every candidate HELD)

def _skeptic_hunt(tmp: Path) -> Path:
    hdir = tmp / "hunt"
    wt = tmp / "wt"
    (wt / "server" / "channels" / "app").mkdir(parents=True)
    (wt / "server" / "go.mod").write_text("module x\n")
    (wt / "server" / "public" / "model").mkdir(parents=True)
    (wt / "server" / "public" / "go.mod").write_text("module y\n")
    (wt / "webapp" / "channels").mkdir(parents=True)
    (wt / "webapp" / "channels" / "jest.config.js").write_text("module.exports = {};\n")
    write_json(hdir / "state.json", {"pr": "1", "wt": str(wt), "batches": 1})
    write_json(hdir / "ctx.json", {
        "pr": {"title": "Add write scopes", "description": "Writes need a readable channel."},
        "diff_production_code": "+func Evaluate() {}",
        "callers": [{"file": "a.go", "symbol": "Evaluate", "source": "x", "hop": 2, "entry_point": False},
                    {"file": "api4/scope.go", "symbol": "Evaluate", "source": "y", "hop": 1, "entry_point": True}]})
    return hdir


def test_repro_cmd_runs_from_the_nearest_go_module_or_jest_root(tmp_path):
    hdir = _skeptic_hunt(tmp_path)
    c1 = hunt.repro_cmd(hdir, "server/channels/app::TestHuntB_X")
    assert "run.py" in c1 and "repro 1 A --only server/channels/app::TestHuntB_X" in c1
    c2 = hunt.repro_cmd(hdir, "server/public/model::TestHuntD_Y/sub", tag="B")
    assert "run.py" in c2 and "repro 1 B --only server/public/model::TestHuntD_Y/sub" in c2
    assert hunt.repro_cmd(hdir, "webapp/channels/src/c/hunt_b.test.tsx::HuntB HuntB_z") == \
        "cd webapp/channels && npx jest src/c/hunt_b.test.tsx -t 'HuntB HuntB_z'"


def test_the_skeptic_gets_intent_diff_entry_point_callers_test_source_and_a_mechanical_repro(tmp_path, monkeypatch):
    """Live hunts 40163/40256/40364: the skeptic saw only test output, so it could never name a file_line, entry
    point or repro command and HELD every candidate, including the v1-confirmed 40163 bug."""
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntB_WriteDenied"
    write_json(hdir / "run_B.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {tid: "NEW_API"})
    write_json(hdir / "run_B.messages.json", {tid: "write allowed on a channel the scope cannot read"})
    write_json(hdir / "B" / "response.json", {"files": [{"path": "server/channels/app/hunt_huntb_test.go",
                                                         "content": "package app\n\nfunc TestHuntB_WriteDenied(t) {}\n"}]})
    seen: dict = {}

    def fake_dispatch(hdir_, tag, request):
        req = json.loads(request.read_text())
        seen["user"] = json.loads(req["user"]) if isinstance(req["user"], str) else req["user"]
        row = {"id": tid, "source": "B", "decision": "KEEP", "reason": "contradicts the description",
               "file_line": "server/channels/app/scope.go:10", "caller": "api4 bookmark handler",
               "entry_point": "PATCH /api/v4/channels/{id}/bookmarks", "repro_cmd": "", "evidence_path": "run_B.json",
               "severity": "major", "fix_check": None}
        write_json(Path(req["response_path"]), {"rows": [row]})
        return True

    monkeypatch.setattr(hunt, "dispatch_one", fake_dispatch)
    hunt.stage_vet(hdir)
    user = seen["user"]
    assert user["pr"]["description"] == "Writes need a readable channel."
    assert user["diff_production_code"] == "+func Evaluate() {}"
    assert user["callers"][0]["entry_point"] is True  # entry points first
    cand = user["candidates"][0]
    assert cand["mechanical_verdict"] == "NEW_API" and "func TestHuntB_WriteDenied" in cand["test_source"]
    row = json.loads((hdir / "vetted.json").read_text())["rows"][0]
    assert "run.py" in row["repro_cmd"] and "repro 1 B --only server/channels/app::TestHuntB_WriteDenied" in row["repro_cmd"]
    adm = verdict.admissibility(hdir)
    assert [r["id"] for r in adm["keep"]] == [tid] and adm["held"] == []


def test_a_new_api_keep_needs_a_three_of_three_head_failure(tmp_path):
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntB_Flaky"
    write_json(hdir / "run_B.json", {tid: "FLAKY"})
    write_json(hdir / "base_B.json", {tid: "NEW_API"})
    write_json(hdir / "vetted.json", {"rows": [{
        "id": tid, "source": "B", "decision": "KEEP", "reason": "r", "file_line": "a.go:1", "caller": "c",
        "entry_point": "e", "repro_cmd": "go test", "evidence_path": "run_B.json", "severity": "minor",
        "fix_check": None}]})
    adm = verdict.admissibility(hdir)
    assert adm["keep"] == [] and "NEW_API without a 3 of 3 head failure" in adm["held"][0]["reasons"]


# ------------------------------------------------------------------ Stage 7 review fixes

def test_help_prints_usage_and_is_never_a_hunt_target(capsys, monkeypatch):
    """`hunt.py --help` used to start a hunt with target "--help"."""
    monkeypatch.setattr(hunt, "drive", lambda *a, **k: pytest.fail("drive must not run"))
    assert hunt.main(["hunt.py", "--help"]) == 0 and "usage: hunt.py" in capsys.readouterr().out
    assert hunt.main(["hunt.py", "-x"]) == 1


def test_the_budget_breaker_stops_model_calls_and_records_a_gap(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    monkeypatch.setenv("HUNT_BUDGET_USD", "1.0")
    telemetry.record(hdir, "dispatch", tag="A", cost_usd=0.6)
    req = _request(hdir, "V")
    called = []
    monkeypatch.setattr(hunt.dispatch, "dispatch", lambda *a, **k: called.append(a))
    assert hunt.over_budget(hdir) is False
    telemetry.record(hdir, "dispatch", tag="B", cost_usd=0.5)
    assert hunt.dispatch_one(hdir, "V", req) is False and called == []
    gaps = json.loads((hdir / "driver.json").read_text())["gaps"]
    assert "budget $1.00" in gaps["budget"] and "$1.10" in gaps["budget"]
    assert hunt.dispatched(hdir) is True  # the hunt goes on with the answers it has


def test_a_drop_stands_only_when_its_quote_is_in_the_request():
    ctx = {"pr": {"title": "t", "description": "Writes need a readable channel."},
           "diff_production_code": "+if !isValidWriteGrant(scope) { return err }",
           "pr_tests_diff": "", "callers": [{"source": "func handler() {}"}]}
    corpus = verdict.drop_corpus(ctx, 'assert.Equal(t, 404, resp.StatusCode)')

    def row(code, quote):
        return {"id": "x", "decision": "DROP", "reason": "r", "reason_code": code, "evidence_quote": quote}

    for ok in (row("INTENDED", "Writes need a   readable channel."), row("UNREACHABLE", "isValidWriteGrant(scope)"),
               row("WRONG_ASSERTION", "assert.Equal(t, 404, resp.StatusCode)")):
        assert verdict.check_drop(ok, corpus) and ok["decision"] == "DROP"
    for bad, why in ((row("INTENDED", "the description asks for this"), "not found verbatim"),
                     (row("UNREACHABLE", "Writes need a readable channel."), "not found verbatim"),
                     (row("BUG", "isValidWriteGrant(scope)"), "is not INTENDED"),
                     (row("INTENDED", "Writes"), "shorter than"),
                     ({"id": "x", "decision": "DROP", "reason": "r"}, "is not INTENDED")):
        assert not verdict.check_drop(bad, corpus)
        assert bad["decision"] == "HELD" and why in bad["reason"] and bad["reason"].endswith(": r")
    keep = {"id": "x", "decision": "KEEP"}
    assert verdict.check_drop(keep, corpus) and keep["decision"] == "KEEP"


def test_the_skeptic_drop_without_evidence_is_held_in_vetted_json(tmp_path, monkeypatch):
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntB_WriteDenied"
    write_json(hdir / "run_B.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "B" / "response.json", {"files": []})

    def fake_dispatch(hdir_, tag, request):
        req = json.loads(request.read_text())
        assert "pr_tests_diff" in (json.loads(req["user"]) if isinstance(req["user"], str) else req["user"])
        assert "evidence_quote" in req["system"]
        row = {"id": tid, "source": "B", "decision": "DROP", "reason": "intended", "file_line": "a.go:1",
               "caller": "c", "entry_point": None, "repro_cmd": "", "evidence_path": "run_B.json",
               "severity": "minor", "fix_check": None, "reason_code": "INTENDED",
               "evidence_quote": "the PR says writes are denied"}
        write_json(Path(req["response_path"]), {"rows": [row]})
        return True

    monkeypatch.setattr(hunt, "dispatch_one", fake_dispatch)
    hunt.stage_vet(hdir)
    row = json.loads((hdir / "vetted.json").read_text())["rows"][0]
    assert row["decision"] == "HELD" and row["reason"].startswith("unverified DROP (INTENDED quote not found")


def _kept(tid, file_line, severity="minor"):
    return {**_keep_row(), "id": tid, "file_line": file_line, "severity": severity, "reason": f"impact {tid}"}


def test_kept_rows_are_grouped_by_root_cause_for_the_author(tmp_path):
    """PR 40336 (7572ae1): 7 kept tests reached the author as 7 findings. Only rows on the exact same file_line merge:
    on 213daa6 a BOM-trim bug (text_value.ts:54) and a truncation bug (:57) were folded into one item by a 5-line
    window, hiding the second bug."""
    rows = [_kept("t1", "web/value_control.tsx:323", "major"), _kept("t2", "web/value_control.tsx:323", "minor"),
            _kept("t3", "web/text_value.ts:54"), _kept("t4", "web/text_value.ts:57"),
            _kept("t5", "web/text_value.ts:100"), _kept("t6", "web/text_value.ts:100")]
    by_cause = {f["root_cause"]: f for f in report.grouped_findings(rows)}
    assert set(by_cause) == {"web/value_control.tsx:323", "web/text_value.ts:54", "web/text_value.ts:57",
                             "web/text_value.ts:100"}
    assert by_cause["web/value_control.tsx:323"]["severity"] == "major"  # the most severe member leads
    assert [r["id"] for r in by_cause["web/value_control.tsx:323"]["related"]] == ["t2"]
    assert by_cause["web/text_value.ts:100"]["impact"] == "impact t5"  # equal severity: the lowest id leads
    assert "related" not in by_cause["web/text_value.ts:54"] and "related" not in by_cause["web/text_value.ts:57"]
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "x", "batches": 1})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": rows, "held": []})
    out = report.write(hdir, "x")
    assert (out["findings"], out["kept_tests"]) == (4, 6)
    assert "4 root cause(s) from 6 test(s)" in (hdir / "audit.md").read_text()


def test_findings_match_the_finding_schema_keys_and_types():
    import dispatch
    schema = json.loads((report.Path(hunt.SKILL_DIR) / "finding.schema.json").read_text())
    item = report.grouped_findings([_kept("t1", "a.go:1"), _kept("t2", "a.go:1")])[0]
    assert dispatch.validate_schema(item, schema) == []


def test_skeptic_eval_scores_decisions_against_labels():
    import skeptic_eval
    rows = [{"id": "a", "decision": "KEEP"}, {"id": "b", "decision": "DROP"}, {"id": "c", "decision": "HELD"},
            {"id": "d", "decision": "KEEP"}]
    got = {r["id"]: r["result"] for r in skeptic_eval.score(
        {"a": "KEEP", "b": "KEEP", "c": "DROP", "d": "DROP", "e": "KEEP"}, rows)}
    assert got == {"a": "pass", "b": "FAIL", "c": "held", "d": "FAIL", "e": "FAIL"}


def test_skeptic_eval_replays_a_fixture_through_the_current_prompt(tmp_path, monkeypatch, capsys):
    import skeptic_eval
    fx = tmp_path / "fx"
    fx.mkdir()
    write_json(fx / "1.json", {"pr": 1, "labels": {"t1": "DROP"}, "user": {
        "pr": {"title": "t", "description": "Stop polling for E10 licences."}, "diff_production_code": "+x",
        "callers": [], "candidates": [{"id": "t1", "test_source": "x"}]}})
    answer = {"rows": [{"id": "t1", "decision": "DROP", "reason_code": "INTENDED",
                        "evidence_quote": "Stop polling for E10 licences."}]}
    body = ("import json,sys\nfrom pathlib import Path\nreq=json.loads(Path(sys.argv[-1]).read_text())\n"
            "assert 'evidence_quote' in req['system']\n"
            f"Path(req['response_path']).write_text({json.dumps(json.dumps(answer))})\n")
    monkeypatch.setenv("HUNT_DISPATCH_CMD", _fake(tmp_path, "skeptic.py", body))
    assert skeptic_eval.main(["skeptic_eval.py", str(fx), "--out", str(tmp_path / "out")]) == 0
    card = json.loads((tmp_path / "out" / "skeptic_scorecard.json").read_text())
    assert card["totals"] == {"pass": 1, "held": 0, "FAIL": 0}


def test_the_checked_in_skeptic_fixtures_are_well_formed():
    import skeptic_eval
    files = sorted(skeptic_eval.DEFAULT_FIXTURES.glob("*.json"))
    assert {f.stem for f in files} >= {"40256", "40336", "40364"}
    for f in files:
        data = json.loads(f.read_text())
        ids = {c["id"] for c in data["user"]["candidates"]}
        assert data["labels"] and set(data["labels"]) <= ids
        assert set(data["labels"].values()) <= {"KEEP", "DROP"}
        assert "/var/folders" not in f.read_text() and "/Users/" not in f.read_text()


# ------------------------------------------------------------------ code review round (2026-11-26)

def _vetted_keep(hdir: Path, tid: str, **extra: object) -> None:
    write_json(hdir / "vetted.json", {"rows": [{
        "id": tid, "source": "A", "decision": "KEEP", "reason": "r", "file_line": "a.go:1", "caller": "c",
        "entry_point": "e", "repro_cmd": "go test", "evidence_path": "run_A.json", "severity": "minor",
        "fix_check": None, **extra}]})


def test_a_mechanical_strictly_weak_fix_holds_the_row_whatever_the_model_wrote(tmp_path):
    hdir = tmp_path / "hunt"
    tid = "calc::TestHuntA_X"
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "fix_A.json", {tid: "STRICTLY_WEAK"})
    _vetted_keep(hdir, tid, fix_check="STRONG")
    adm = verdict.admissibility(hdir)
    assert adm["keep"] == [] and "fix_check=STRICTLY_WEAK" in adm["held"][0]["reasons"]


def test_the_skeptic_cannot_replace_the_mechanical_repro_command(tmp_path, monkeypatch):
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntB_X"
    write_json(hdir / "run_B.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "B" / "response.json", {"files": []})

    def fake_dispatch(hdir_, tag, request):
        req = json.loads(request.read_text())
        write_json(Path(req["response_path"]), {"rows": [{
            "id": tid, "source": "B", "decision": "KEEP", "reason": "r", "file_line": "a.go:1", "caller": "c",
            "entry_point": "e", "repro_cmd": "true", "evidence_path": "run_B.json", "severity": "minor",
            "fix_check": None, "reason_code": "BUG", "evidence_quote": ""}]})
        return True

    monkeypatch.setattr(hunt, "dispatch_one", fake_dispatch)
    hunt.stage_vet(hdir)
    row = json.loads((hdir / "vetted.json").read_text())["rows"][0]
    assert "run.py" in row["repro_cmd"] and "repro 1 B --only server/channels/app::TestHuntB_X" in row["repro_cmd"]


def test_repro_for_a_jest_test_outside_the_root_names_its_roots(tmp_path):
    hdir = _skeptic_hunt(tmp_path)
    wt = tmp_path / "wt"
    (wt / "webapp" / "platform" / "types" / "src").mkdir(parents=True)
    (wt / "webapp" / "platform" / "types" / "package.json").write_text("{}\n")
    cmd = hunt.repro_cmd(hdir, "webapp/platform/types/src/hunt_b.test.ts::HuntB HuntB_y")
    assert cmd.startswith("cd webapp/channels && npx jest --roots . --roots ../platform/types ")
    assert "--runTestsByPath ../platform/types/src/hunt_b.test.ts" in cmd


def test_a_vetting_error_is_a_hunter_error_on_the_scorecard():
    import eval_bugs
    manifest = {"cases": [], "controls": [{"id": "k1", "area": "x"}], "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}
    hunted = {"k1": {"results": [{"hunter": "V", "admissibility": {}, "vet_error": "bad vetted.json"}]}}
    row = eval_bugs.scorecard(manifest, hunted)["rows"][0]
    assert row["hunter_errors"] == ["V vet: bad vetted.json"]


def test_a_huge_generated_patch_is_cut_only_in_the_request():
    import ctx
    patch = "\n".join(f"+line {i}" for i in range(ctx.MAX_PATCH_LINES + 10))
    out = ctx.request_patch(patch)
    assert out.count("\n") == ctx.MAX_PATCH_LINES and out.endswith("[patch cut: 10 more lines not shown]")
    assert ctx.request_patch("+a\n+b") == "+a\n+b"


def test_a_failed_mode_d_base_rerun_keeps_the_first_run_diff(tmp_path, monkeypatch):
    import run

    def boom(*a, **k):
        raise run.InfraError("0 tests executed")

    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", boom)
    verdicts = {"u::TestHuntD_X": "DIFF"}
    detail: dict = {"u::TestHuntD_X": {"differing": 1}}
    pending = [("u::TestHuntD_X", "u", ("u", "X"), {0: {"output": 1}}, {0}, {0: {"output": 2}}, {0})]
    run._confirm_diff_on_base(tmp_path, {}, "D", {"u": []}, set(), pending, verdicts, detail)
    assert verdicts == {"u::TestHuntD_X": "DIFF"}
    assert detail["u::TestHuntD_X"]["base_rerun"].startswith("not available")


def test_the_mode_d_fix_check_ignores_records_that_change_between_runs(tmp_path, monkeypatch):
    import eval_bugs
    import run
    hdir = tmp_path / "hunt"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    rkey = (u, run.record_name(ident))
    write_json(hdir / "diff_D.json", {ident: "DIFF"})
    write_json(hdir / "diff_D.examples.json", {ident: {"examples": [{"i": 0, "input": 1, "base": "old", "head": "new"}]}})
    write_json(hdir / "D" / "response.json", {"files": [{"path": path, "content": ""}]})
    runs = {"fix": {0: {"input": 1, "output": "old"}, 1: {"input": 2, "output": "t1"}},
            "fix2": {0: {"input": 1, "output": "old"}, 1: {"input": 2, "output": "t2"}},
            "fixbase": {0: {"input": 1, "output": "old"}, 1: {"input": 2, "output": "t3"}},
            "fixbase2": {0: {"input": 1, "output": "old"}, 1: {"input": 2, "output": "t4"}}}

    def fake_pass(wt, state, tag, units, td, stem, base=False):
        o = run.Outcome()
        o.results[ident] = "PASS"
        return o, {rkey: runs[stem]}, {}, {}, []

    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", fake_pass)
    out = eval_bugs.cmd_fix_diff(hdir, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path)
    assert out == {ident: "STRONG"}  # index 1 is a timestamp: unstable on both sides, so it is not compared


def test_rows_with_no_file_line_are_never_merged():
    found = report.grouped_findings([_kept("t1", ""), _kept("t2", "")])
    assert [f["root_cause"] for f in found] == ["t1", "t2"] and all("related" not in f for f in found)


# ------------------------------------------------------------------ pre-push review round (2026-11-26)

def test_a_skeptic_that_omits_a_candidate_leaves_it_held(tmp_path, monkeypatch):
    """PR text can ask the model to leave a candidate out; {"rows": []} must not read as a clean PR."""
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntB_X"
    write_json(hdir / "run_B.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "B" / "response.json", {"files": []})

    def fake_dispatch(hdir_, tag, request):
        req = json.loads(request.read_text())
        write_json(Path(req["response_path"]), {"rows": [{"id": "not-a-candidate", "source": "B",
                                                          "decision": "KEEP", "reason": "r"}]})
        return True

    monkeypatch.setattr(hunt, "dispatch_one", fake_dispatch)
    hunt.stage_vet(hdir)
    rows = json.loads((hdir / "vetted.json").read_text())["rows"]
    assert [(r["id"], r["decision"]) for r in rows] == [(tid, "HELD")]
    assert verdict.row_errors(rows[0]) == []
    gap = json.loads((hdir / "driver.json").read_text())["gaps"]["vet"]
    assert "1 candidate(s) with no skeptic row, held" in gap and "unknown ids" in gap


def test_mode_v_builds_its_request_from_a_new_pr_bug_candidate(tmp_path, monkeypatch):
    """stage_v crashed with a TypeError on any hunt that had a NEW_PR_BUG candidate."""
    hdir = _skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestHuntA_X"
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "server/channels/app/hunt_a_test.go",
                                                         "content": "x" * (hunt.MAX_PAYLOAD_CHARS + 50)}]})
    seen = {}
    monkeypatch.setattr(hunt, "dispatch_one", lambda h, tag, req: seen.setdefault("req", req) and False)
    hunt.stage_v("1", hdir)
    user = json.loads(json.loads(seen["req"].read_text())["user"])
    src = user["candidates"][0]["test_source"]
    assert user["candidates"][0]["id"] == tid and src.endswith("[truncated]")
    assert len(src) <= hunt.MAX_PAYLOAD_CHARS + len("\n[truncated]")


def test_parallel_gap_writes_keep_every_gap(tmp_path):
    import concurrent.futures
    hdir = tmp_path / "hunt"
    hdir.mkdir()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: hunt.set_gap(hdir, f"dispatch:{i}", "x"), range(40)))
    assert len(json.loads((hdir / "driver.json").read_text())["gaps"]) == 40


def test_raising_the_budget_lets_a_resumed_hunt_dispatch_again(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    telemetry.record(hdir, "dispatch", tag="A", cost_usd=2.0)
    monkeypatch.setenv("HUNT_BUDGET_USD", "1")
    assert hunt.over_budget(hdir)
    monkeypatch.setenv("HUNT_BUDGET_USD", "5")
    assert not hunt.over_budget(hdir)
    assert "budget" not in json.loads((hdir / "driver.json").read_text())["gaps"]


def test_a_jest_repro_title_is_shell_quoted(tmp_path):
    hdir = _skeptic_hunt(tmp_path)
    cmd = hunt.repro_cmd(hdir, "webapp/channels/src/c/hunt_b.test.tsx::HuntB $(touch pwned)")
    assert cmd.endswith(r"-t 'HuntB \$\(touch pwned\)'")


# ------------------------------------------------------------------ v3 rerun defects (2026-11-26)

def test_a_fresh_hunt_never_reuses_the_last_runs_vetting_or_cost(tmp_path):
    """v3 reruns kept vetted.json and telemetry.jsonl: the skeptic stage was skipped and cost added up across runs."""
    import ctx
    hdir = tmp_path / "hunt"
    for name in ("vetted.json", "verdict.json", "findings.json", "audit.md", "run_V.json", "base_V.json"):
        write_json(hdir / name, {})
    (hdir / "V").mkdir()
    (hdir / "vet").mkdir()
    ctx.reset_hunt_dir(hdir)
    assert sorted(p.name for p in hdir.iterdir()) == []
    assert set(prepare.RUN_STALE) == {"telemetry.jsonl", "driver.json"}


def test_parallel_fetches_into_the_shared_clone_are_serialized(tmp_path):
    """Two hunts fetching master at once failed with "cannot lock ref 'refs/remotes/origin/master'"."""
    import concurrent.futures
    import time
    mm = tmp_path / "mmfull"
    mm.mkdir()
    inside = []

    def hold(i):
        with prepare.clone_fetch_lock(mm):
            inside.append(i)
            assert len(inside) == 1
            time.sleep(0.05)
            inside.remove(i)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(hold, range(6)))


def test_report_keeps_archived_batch_findings_after_batch_switch(tmp_path):
    """Archiving batch 1 moves verdict.json/findings.json out of root; report.write must keep prior batch findings."""
    import ctx
    import ledger

    hdir = _skeptic_hunt(tmp_path)
    tid = "pkg::TestBug1"
    kept_a = {
        "id": tid, "source": "A", "decision": "KEEP", "reason": "null deref",
        "file_line": "a.go:10", "caller": "Handle", "entry_point": "POST /x",
        "repro_cmd": "go test ./pkg -run '^TestBug1$' -count=1",
        "evidence_path": "base_A.json", "severity": "major", "fix_check": None,
        "mechanical_verdict": "NEW_PR_BUG",
    }
    kept_r = {
        "id": "claim_1", "source": "R", "decision": "KEEP", "reason": "stale thread",
        "file_line": "r.go:5", "caller": "Check", "entry_point": "POST /r",
        "repro_cmd": "go test ./r -run '^TestR$' -count=1",
        "evidence_path": "review_verdicts.json", "severity": "minor", "fix_check": None,
        "mechanical_verdict": "NEW_PR_BUG",
    }
    held_b = {"row": {"id": "pkg::TestHeld1", "source": "B", "decision": "HELD"}, "reasons": ["needs check"]}

    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "func TestBug1() {}"}]})
    write_json(hdir / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "vetted.json", {"rows": [kept_a]})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [kept_a, kept_r], "held": [held_b]})
    write_json(hdir / "findings.json", [{"root_cause": "a.go:10"}])

    archived = ctx.archive_batch(hdir, 1)
    assert (archived / "verdict.json").exists()
    assert not (hdir / "verdict.json").exists()

    write_json(hdir / "prepare.json", {"schema_version": 1, "head": "abc", "merge_base": "def"})
    write_json(hdir / "state.json", {"pr": "1", "wt": str(tmp_path / "wt"), "batch": 2, "batches": 2})
    write_json(hdir / "vetted.json", {"rows": []})
    drop_r = {"row": {"id": "claim_1", "source": "R", "decision": "DROP", "reason": "superseded"},
              "reasons": ["decision is DROP"]}
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_r]})

    res = report.write(hdir, "1")
    assert res == {"tier": "Bug Proven", "findings": 1, "kept_tests": 1, "held": 1, "dropped": 1}
    findings = json.loads((hdir / "findings.json").read_text())
    assert len(findings) == 1 and findings[0]["root_cause"] == "a.go:10"

    counts, _c, reached, executable, mode_gaps = ledger._aggregate_modes(hdir)
    tier, _gaps = ledger._tier_and_gaps(hdir, counts, reached, executable, 0, 2, 2, mode_gaps, {})
    assert tier == "Bug Proven"


def test_ledger_resolves_numeric_batches_supersedes_lesson_holds_and_archived_r(tmp_path):
    """Numeric batch_N sort, later DROP/HELD superseding, lesson-filtered holds, and root review_verdicts.json."""
    import ledger

    kept_r = {
        "id": "claim_1", "source": "R", "decision": "KEEP", "reason": "stale thread",
        "file_line": "r.go:5", "caller": "Check", "entry_point": "POST /r",
        "repro_cmd": "go test ./r -run '^TestR$' -count=1",
        "evidence_path": "review_verdicts.json", "severity": "minor", "fix_check": None,
        "mechanical_verdict": "NEW_PR_BUG",
    }
    drop_r = {"row": {"id": "claim_1", "source": "R", "decision": "DROP", "reason": "superseded"},
              "reasons": ["decision=DROP"]}

    # 1. Numeric sorting: batch_10 must come after batch_9 (not between batch_1 and batch_2)
    h1 = tmp_path / "h_num"
    for b in ("batch_2", "batch_9", "batch_10"):
        (h1 / "batches" / b).mkdir(parents=True)
    write_json(h1 / "batches" / "batch_9" / "verdict.json", {"vetted_present": True, "keep": [kept_r], "held": []})
    write_json(h1 / "batches" / "batch_10" / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_r]})
    assert [p.name for p in ledger._batch_dirs(h1)] == ["batch_2", "batch_9", "batch_10", "h_num"]
    assert ledger.resolved_verdicts(h1)[0] == []

    # 2. Active batch DROP supersedes archived batch KEEP in _tier_and_gaps
    h2 = tmp_path / "h_super"
    write_json(h2 / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [kept_r], "held": []})
    write_json(h2 / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_r]})
    base_counts = {"mode_a_empty": 0, "new_pr_bug": 0}
    tier2, _ = ledger._tier_and_gaps(h2, base_counts, 1, 1, 0, 2, 2, False, {})
    assert tier2 == "High-Confidence Clean"

    # 3. Lesson-filtered verdict.json hold overrides archived vetted.json KEEP
    h3 = tmp_path / "h_lesson"
    tid = "pkg::TestA"
    kept_a = {**kept_r, "id": tid, "source": "A", "evidence_path": "base_A.json"}
    write_json(h3 / "batches" / "batch_1" / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(h3 / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(h3 / "batches" / "batch_1" / "vetted.json", {"rows": [kept_a]})
    write_json(h3 / "batches" / "batch_1" / "verdict.json", {
        "vetted_present": True, "keep": [],
        "held": [{"row": kept_a, "reasons": ["failure text matches false-positive lesson L1"]}],
    })
    tier3, _ = ledger._tier_and_gaps(h3, {**base_counts, "new_pr_bug": 1}, 1, 1, 0, 1, 1, False, {})
    assert tier3 == "Partial or Unverified Coverage"

    # 4. Unfinished archived batch (vetted.json without verdict.json) never promotes kept rows and flags unvetted
    h4 = tmp_path / "h_unfinished"
    write_json(h4 / "batches" / "batch_1" / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(h4 / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(h4 / "batches" / "batch_1" / "vetted.json", {"rows": [kept_a]})
    assert ledger.resolved_verdicts(h4)[0] == []
    assert ledger._tier_and_gaps(
        h4, {**base_counts, "new_pr_bug": 1}, 1, 1, 0, 1, 1, False, {}
    ) == ("Partial or Unverified Coverage", ["unvetted findings"])

    # 5. Empty archived vetted.json must not hide an unvetted NEW_PR_BUG in the active batch
    h5 = tmp_path / "h_active_unvetted"
    write_json(h5 / "batches" / "batch_1" / "vetted.json", {"rows": []})
    write_json(h5 / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(h5 / "base_A.json", {tid: "NEW_PR_BUG"})
    assert ledger._tier_and_gaps(
        h5, {**base_counts, "new_pr_bug": 1}, 1, 1, 0, 2, 2, False, {}
    ) == ("Partial or Unverified Coverage", ["unvetted findings"])

    # 6. report.write must not emit findings.json from unfiltered vetted.json when verdict.json is absent
    h6 = tmp_path / "h_no_verdict"
    write_json(h6 / "prepare.json", {"schema_version": 1, "head": "abc", "merge_base": "def"})
    write_json(h6 / "state.json", {"pr": "1", "wt": str(tmp_path / "wt"), "batch": 1, "batches": 1})
    write_json(h6 / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(h6 / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(h6 / "vetted.json", {"rows": [kept_a]})
    report.write(h6, "1")
    assert json.loads((h6 / "findings.json").read_text()) == []

    # 7. Malformed or empty verdict.json ({}) must not mark an archive as vetted
    h7 = tmp_path / "h_bad_verdict"
    write_json(h7 / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(h7 / "batches" / "batch_1" / "verdict.json", {})
    assert ledger._tier_and_gaps(
        h7, {**base_counts, "new_pr_bug": 1}, 1, 1, 0, 1, 1, False, {}
    ) == ("Partial or Unverified Coverage", ["unvetted findings"])

    # 8. {"keep": None, "held": []} normalizes cleanly without TypeError
    h8 = tmp_path / "h_null_keep"
    write_json(h8 / "verdict.json", {"keep": None, "held": []})
    assert ledger.resolved_verdicts(h8) == ([], [])

    # 9. Unvetted Mode D DIFF in an archive without vetted.json/verdict.json flags unvetted
    h9 = tmp_path / "h_diff_unvetted"
    write_json(h9 / "batches" / "batch_1" / "diff_D.json", {"pkg::Diff": "DIFF"})
    assert ledger._tier_and_gaps(
        h9, base_counts, 1, 1, 0, 1, 1, False, {}
    ) == ("Partial or Unverified Coverage", ["unvetted findings"])

    # 10. Held entries with non-dict row (e.g. {"row": None}) reject the verdict.json payload
    h10 = tmp_path / "h_bad_held_row"
    write_json(h10 / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(h10 / "batches" / "batch_1" / "verdict.json", {"keep": [], "held": [{"row": None}]})
    assert ledger.resolved_verdicts(h10) == ([], [])
    assert ledger._tier_and_gaps(
        h10, {**base_counts, "new_pr_bug": 1}, 1, 1, 0, 1, 1, False, {}
    ) == ("Partial or Unverified Coverage", ["unvetted findings"])
