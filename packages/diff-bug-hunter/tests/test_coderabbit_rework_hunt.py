# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Milestone M5 CodeRabbit rework tests for hunt.py (Findings #1-#9)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import build_requests
import ctx
import dispatch
import hunt
import prepare
import pytest
import run
import trusted
import verdict
from conftest import FAKE_DISPATCH, _git, make_repo, vetted_row
from conftest import canned_responses as _canned
from conftest import e2e_repo as _e2e_repo
from conftest import fake_script as _fake
from hunt_common import hunt_dir, write_json


def _go_skeptic_hunt(tmp: Path) -> Path:
    hdir = tmp / "hunt"
    wt = tmp / "wt"
    (wt / "server" / "channels" / "app").mkdir(parents=True)
    (wt / "server" / "go.mod").write_text("module x\n")
    write_json(hdir / "state.json", {"pr": "1", "wt": str(wt), "batches": 1})
    write_json(hdir / "ctx.json", {
        "pr": {"title": "Fix scope", "description": "Check channel access."},
        "diff_production_code": "+func Evaluate() {}",
        "callers": [],
    })
    return hdir


def _setup_two_batch_repo(tmp: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    base = {
        "go.mod": "module example.com/twobatch\n\ngo 1.22\n",
        "pkg2/extra.go": "package pkg2\n\nfunc Extra(x int) int { return x * 2 }\n",
        **{f"pkg1/f{i}.go": f"package pkg1\n\nfunc F{i}(x int) int {{ return x + {i} }}\n" for i in range(1, 6)},
    }
    head = {
        "pkg2/extra.go": "package pkg2\n\nfunc Extra(x int) int {\n\tif x < 0 {\n\t\treturn 0\n\t}\n\treturn x * 2\n}\n",
        **{
            f"pkg1/f{i}.go": (
                f"package pkg1\n\nfunc F{i}(x int) int {{\n\tif x == 0 {{\n\t\treturn 99\n\t}}\n\treturn x + {i}\n}}\n"
            )
            for i in range(1, 6)
        },
    }
    repo = make_repo(tmp, base, head)
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    return repo, hunt_dir("master..feature")


# ------------------------------------------------------------------ #1: Do not mark unfinished vetting complete

def test_unfinished_vetting_does_not_write_hunt_done_and_resumes(tmp_path, monkeypatch, capsys):
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses, log = _canned(tmp_path, "go_bug", "calc::TestHuntA_ClampRangeAndIdentity", "A")
    # Remove vet response initially and make vet dispatch fail cleanly.
    vet_resp = responses / "vet" / "response.json"
    saved_vet = vet_resp.read_text()
    vet_resp.unlink()
    fail_on_vet = tmp_path / "fail_vet.py"
    fail_on_vet.write_text(
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "req = Path(sys.argv[-1])\n"
        "tag = req.parent.name\n"
        "with Path(os.environ['FAKE_LOG']).open('a') as fh:\n"
        "    fh.write(tag + '\\n')\n"
        "if tag == 'vet' and Path(os.environ['FAIL_VET_FLAG']).exists():\n"
        "    sys.stderr.write('no such model\\n')\n"
        "    sys.exit(2)\n"
        "src = Path(os.environ['FAKE_RESPONSES']) / tag / 'response.json'\n"
        "text = src.read_text() if src.exists() else json.dumps({'files': [], 'tests': []})\n"
        "Path(json.loads(req.read_text())['response_path']).write_text(text)\n"
    )
    flag = tmp_path / "fail_vet.flag"
    flag.write_text("1")
    cmd = f"python3 {fail_on_vet}"
    monkeypatch.setenv("HUNT_DISPATCH_CMD", cmd)
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAIL_VET_FLAG", str(flag))

    assert hunt.main(["hunt.py", "master..feature"]) == 0
    hdir = hunt_dir("master..feature")
    assert not (hdir / "vetted.json").exists()
    assert not (hdir / "hunt_done.json").exists()

    # Recover vet response and rerun without --force: must NOT skip, must complete vetting & write hunt_done.json.
    flag.unlink()
    vet_resp.write_text(saved_vet)
    capsys.readouterr()
    assert hunt.main(["hunt.py", "master..feature"]) == 0
    out = capsys.readouterr().out
    assert "skip: already hunted" not in out
    assert (hdir / "vetted.json").exists()
    assert (hdir / "hunt_done.json").exists()


def test_empty_candidates_writes_empty_vetted_and_marks_hunt_done(tmp_path, monkeypatch):
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses = tmp_path / "responses"
    responses.mkdir()
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    log = tmp_path / "dispatch.log"
    monkeypatch.setenv("HUNT_DISPATCH_CMD", cmd)
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    monkeypatch.setenv("FAKE_LOG", str(log))

    assert hunt.main(["hunt.py", "master..feature"]) == 0
    hdir = hunt_dir("master..feature")
    assert json.loads((hdir / "vetted.json").read_text()) == {"rows": []}
    assert (hdir / "hunt_done.json").exists()


# ------------------------------------------------------------------ #2: Multi-batch driver loop & --first-batch

def test_drive_processes_all_planned_batches_before_hunt_done(tmp_path, monkeypatch, capsys):
    _repo, hdir = _setup_two_batch_repo(tmp_path, monkeypatch)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH))
    monkeypatch.setenv("FAKE_RESPONSES", str(tmp_path / "no_responses"))
    log = tmp_path / "dispatch.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    (tmp_path / "no_responses").mkdir()

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            repo = Path(_git(tmp_path / "repo", "rev-parse", "--show-toplevel"))
            wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
            if not wt.exists():
                mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
            else:
                mb = _git(repo, "rev-parse", "master")
            write_json(hdir / "prepare.json", {
                "repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
                "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir),
                "schema_version": 1, "base_mode": "two-dot", "huntable_files": 6,
            })
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "ctx.py":
            prep = json.loads((hdir / "prepare.json").read_text())
            batch = int(args[args.index("--batch") + 1]) if "--batch" in args else 1
            first_b = "--first-batch" in args
            ctx.build(args[0], batch, prep, {"title": "multi", "body": ""}, all_batches=not first_b, first_batch=first_b)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "build_requests.py":
            tag = "A" if args[1] == "hunters" else ("D" if args[1] == "diff" else "")
            if args[1] == "hunters":
                for t in ("A", "B"):
                    build_requests.write(hdir, t, "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            elif tag:
                build_requests.write(hdir, tag, "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "run":
            tag = args[2]
            write_json(hdir / f"run_{tag}.json", {})
            files = json.loads((hdir / tag / "response.json").read_text()).get("files", [])
            (hdir / f"run_{tag}.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "old_tests.py":
            write_json(hdir / "old_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "pr_tests.py":
            write_json(hdir / "pr_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,B"]) == 0
    assert (hdir / "batches" / "batch_1" / "state.json").exists()
    assert json.loads((hdir / "state.json").read_text())["batch"] == 2
    assert json.loads((hdir / "state.json").read_text())["batches"] == 2
    assert json.loads((hdir / "state.json").read_text())["modes"] == ["A", "B"]
    assert (hdir / "hunt_done.json").exists()
    # Dispatched both A and B across both batches (4 calls total).
    calls = log.read_text().splitlines()
    assert len(calls) == 4 and calls.count("A") == 2 and calls.count("B") == 2

    # Second run skips as already hunted.
    capsys.readouterr()
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,B"]) == 0
    assert "skip: already hunted" in capsys.readouterr().out


def test_drive_first_batch_flag_stops_after_batch_1(tmp_path, monkeypatch):
    _repo, hdir = _setup_two_batch_repo(tmp_path, monkeypatch)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH))
    monkeypatch.setenv("FAKE_RESPONSES", str(tmp_path / "no_responses"))
    log = tmp_path / "dispatch.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    (tmp_path / "no_responses").mkdir()

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            repo = Path(_git(tmp_path / "repo", "rev-parse", "--show-toplevel"))
            wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
            mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
            write_json(hdir / "prepare.json", {
                "repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
                "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir),
                "schema_version": 1, "base_mode": "two-dot", "huntable_files": 6,
            })
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "ctx.py":
            prep = json.loads((hdir / "prepare.json").read_text())
            first_b = "--first-batch" in args
            ctx.build(args[0], 1, prep, {"title": "single", "body": ""}, all_batches=not first_b, first_batch=first_b)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "build_requests.py" and args[1] == "hunters":
            for t in ("A", "B"):
                build_requests.write(hdir, t, "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "run":
            tag = args[2]
            write_json(hdir / f"run_{tag}.json", {})
            files = json.loads((hdir / tag / "response.json").read_text()).get("files", [])
            (hdir / f"run_{tag}.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "old_tests.py":
            write_json(hdir / "old_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "pr_tests.py":
            write_json(hdir / "pr_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    assert hunt.main(["hunt.py", "master..feature", "--first-batch", "--modes", "A,B"]) == 0
    state = json.loads((hdir / "state.json").read_text())
    assert state["batch"] == 1 and state["batches"] == 2 and state["all_batches"] is False
    assert not (hdir / "batches").exists()
    assert (hdir / "hunt_done.json").exists()
    assert sorted(log.read_text().splitlines()) == ["A", "B"]


def test_drive_stops_before_batch_2_if_batch_1_vetting_unfinished(tmp_path, monkeypatch):
    _repo, hdir = _setup_two_batch_repo(tmp_path, monkeypatch)

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            repo = Path(_git(tmp_path / "repo", "rev-parse", "--show-toplevel"))
            wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
            mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
            write_json(hdir / "prepare.json", {
                "repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
                "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir),
                "schema_version": 1, "base_mode": "two-dot", "huntable_files": 6,
            })
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "ctx.py":
            assert "--batch" not in args, "must not advance to batch 2 when batch 1 vetting failed"
            prep = json.loads((hdir / "prepare.json").read_text())
            ctx.build(args[0], 1, prep, {"title": "multi", "body": ""}, all_batches=True, first_batch=False)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "build_requests.py" and args[1] == "hunters":
            for t in ("A", "B"):
                build_requests.write(hdir, t, "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "run":
            tag = args[2]
            write_json(hdir / f"run_{tag}.json", {"pkg1::TestF1": "FAIL_3_OF_3"} if tag == "A" else {})
            files = json.loads((hdir / tag / "response.json").read_text()).get("files", [])
            (hdir / f"run_{tag}.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "base":
            write_json(hdir / "base_A.json", {"pkg1::TestF1": "NEW_PR_BUG"})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "old_tests.py":
            write_json(hdir / "old_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "pr_tests.py":
            write_json(hdir / "pr_tests.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        if tag == "vet":
            return False, None, dispatch.DispatchError("vet failed")
        write_json(Path(json.loads(req.read_text())["response_path"]), {"files": [], "tests": []})
        return True, dispatch.DispatchResult(status="ok", model="sonnet"), None

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,B"]) == 0
    assert json.loads((hdir / "state.json").read_text())["batch"] == 1
    assert not (hdir / "vetted.json").exists()
    assert not (hdir / "hunt_done.json").exists()


# ------------------------------------------------------------------ #3 & #6: Retry compile repair & unlink run_{tag}.json

def test_mode_a_retry_unlinks_run_json_and_repairs_compile_errors(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "batches": 1, "changed": []})
    req_a1 = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(hdir / "A" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_a1).write_text(dispatch.request_sha(req_a1))

    run_calls: list[str] = []
    dispatch_calls: list[str] = []

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "run.py" and args[:2] == ("run", "1"):
            run_calls.append(f"run:{len(run_calls)}")
            if len(run_calls) == 1:
                # Initial empty run writes run_A.json={} and prints EMPTY_RESPONSE.
                write_json(hdir / "run_A.json", {})
                return subprocess.CompletedProcess([], 0, stdout="EMPTY_RESPONSE\n", stderr="")
            if len(run_calls) == 2:
                # Post-retry run hits COMPILE_ERROR (exit 3) AND asserts stale run_A.json was unlinked.
                assert not (hdir / "run_A.json").exists()
                return subprocess.CompletedProcess([], 3, stdout="COMPILE_ERROR\n", stderr="")
            # Post-repair run succeeds.
            write_json(hdir / "run_A.json", {"calc::TestHuntA_Fixed": "PASS"})
            return subprocess.CompletedProcess([], 0, stdout="PASS\n", stderr="")
        if name == "build_requests.py" and args[1] == "retry":
            build_requests.write_request(hdir / "A" / "request.retry.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "build_requests.py" and args[1] == "repair":
            build_requests.write_request(hdir / "A" / "request.repair.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        dispatch_calls.append(tag)
        return True, dispatch.DispatchResult(status="ok", model="sonnet"), None

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.run_tag("1", hdir, "A", retry_empty=True)
    assert dispatch_calls == ["A:retry", "A:repair"]
    assert len(run_calls) == 3
    gaps = json.loads((hdir / "driver.json").read_text()).get("gaps", {})
    assert "run:A" not in gaps and "empty:A" not in gaps


def test_mode_a_retry_persistent_compile_error_records_gap_instead_of_crashing(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "batches": 1, "changed": []})
    req_a1 = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(hdir / "A" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_a1).write_text(dispatch.request_sha(req_a1))

    calls = {"run": 0}

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "run.py":
            calls["run"] += 1
            if calls["run"] == 1:
                write_json(hdir / "run_A.json", {})
                return subprocess.CompletedProcess([], 0, stdout="EMPTY_RESPONSE\n", stderr="")
            return subprocess.CompletedProcess([], 3, stdout="COMPILE_ERROR\n", stderr="")
        if name == "build_requests.py":
            sub = args[1]
            build_requests.write_request(hdir / "A" / f"request.{sub}.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result",
                        lambda *a, **k: (True, dispatch.DispatchResult(status="ok", model="sonnet"), None))
    hunt.run_tag("1", hdir, "A", retry_empty=True)
    gaps = json.loads((hdir / "driver.json").read_text())["gaps"]
    assert gaps["run:A"] == "A COMPILE_ERROR after one repair round"


def test_mode_a_escalation_unlinks_run_json_when_interrupted_before_run(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "batches": 1, "changed": []})
    req_a1 = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(hdir / "A" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_a1).write_text(dispatch.request_sha(req_a1))

    class BoomAfterOpus(RuntimeError):
        pass

    calls = {"run": 0}

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "run.py":
            calls["run"] += 1
            if (hdir / "A" / "request.opus.json").exists():
                raise BoomAfterOpus("simulated interruption after escalation dispatch")
            write_json(hdir / "run_A.json", {})
            return subprocess.CompletedProcess([], 0, stdout="EMPTY_RESPONSE\n", stderr="")
        if name == "build_requests.py" and args[1] == "retry":
            build_requests.write_request(hdir / "A" / "request.retry.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result",
                        lambda *a, **k: (True, dispatch.DispatchResult(status="ok", model="sonnet"), None))
    with pytest.raises(BoomAfterOpus):
        hunt.run_tag("1", hdir, "A", retry_empty=True)
    assert not (hdir / "run_A.json").exists()
    assert not hunt._run_done(hdir, ("A",))


# ------------------------------------------------------------------ #4: Mode V keeps accepted max_tokens response when escalation does not start

def test_stage_v_keeps_accepted_max_tokens_response_when_escalation_does_not_start(tmp_path, monkeypatch):
    hdir = tmp_path / "hv"
    write_json(hdir / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hdir / "base_A.json", {"calc::TestA": "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "calc/a_test.go", "content": "func TestA() {}"}]})

    run_v_called: list[tuple[str, ...]] = []

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        write_json(Path(json.loads(req.read_text())["response_path"]),
                   {"files": [{"path": "calc/hunt_huntv_test.go", "content": "package calc"}], "tests": []})
        return True, dispatch.DispatchResult(status="ok", model="sonnet", stop_reason="max_tokens"), None

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        run_v_called.append((name, *args))
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    # Budget reached right when escalate_tag checks over_budget -> escalation does NOT start.
    monkeypatch.setattr(hunt, "over_budget", lambda _hdir: True)
    monkeypatch.setattr(hunt, "script", fake_script)

    hunt.stage_v("1", hdir)
    assert ("run.py", "run", "1", "V") in run_v_called
    assert ("run.py", "base", "1", "V") in run_v_called
    assert not (hdir / "V" / "request.opus.json").exists()


def test_stage_v_skips_run_when_escalation_starts_and_fails(tmp_path, monkeypatch):
    hdir = tmp_path / "hv"
    write_json(hdir / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hdir / "base_A.json", {"calc::TestA": "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "calc/a_test.go", "content": "func TestA() {}"}]})

    seen_calls: list[Path] = []
    run_v_called: list[tuple[str, ...]] = []

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        seen_calls.append(req)
        if req.name == "request.json":
            write_json(Path(json.loads(req.read_text())["response_path"]), {"files": [], "tests": []})
            return True, dispatch.DispatchResult(status="ok", model="sonnet", stop_reason="max_tokens"), None
        return False, None, dispatch.DispatchError("opus failed")

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    monkeypatch.setattr(hunt, "script", lambda name, *args: run_v_called.append((name, *args)) or subprocess.CompletedProcess([], 0))

    hunt.stage_v("1", hdir)
    assert [p.name for p in seen_calls] == ["request.json", "request.opus.json"]
    assert run_v_called == []


# ------------------------------------------------------------------ #5: Filter candidates, V, and vet by requested modes

def test_modes_filter_candidates_stage_v_stage_vet_and_vet_done(tmp_path, monkeypatch):
    hdir = _go_skeptic_hunt(tmp_path)
    write_json(hdir / "run_A.json", {"server/channels/app::TestA": "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {"server/channels/app::TestA": "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "server/channels/app/hunt_a_test.go", "content": "func TestA() {}"}]})
    write_json(hdir / "run_B.json", {"server/channels/app::TestB": "FAIL_3_OF_3", "server/channels/app::TestB2": "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {"server/channels/app::TestB": "NEW_PR_BUG", "server/channels/app::TestB2": "NEW_API"})
    write_json(hdir / "B" / "response.json", {"files": [{"path": "server/channels/app/hunt_b_test.go", "content": "func TestB() {}"}]})
    write_json(hdir / "diff_D.json", {"server/channels/app::TestD": "DIFF"})
    write_json(hdir / "D" / "response.json", {"files": []})
    write_json(hdir / "review_verdicts.json", {"verdicts": {
        "CR1": {"verdict": "PROVEN", "base_verdict": "NEW_PR_BUG", "tests": {"server/channels/app::TestHuntR_CR1_X": "FAIL_3_OF_3"}},
    }})
    write_json(hdir / "run_V.json", {"server/channels/app::TestHuntV_Stale": "FAIL_3_OF_3"})
    write_json(hdir / "base_V.json", {"server/channels/app::TestHuntV_Stale": "NEW_PR_BUG"})

    assert [c["source"] for c in hunt.candidates_ab(hdir, ("A",))] == ["A"]
    assert hunt.candidates_new_api(hdir, ("A",)) == []
    assert [(c["source"], c["id"]) for c in hunt.candidates_all(hdir, ("A",))] == [("A", "server/channels/app::TestA")]
    assert hunt.v_done(hdir, ("D",)) is True

    # Stale vetted.json containing Mode D row does NOT satisfy vet_done for ("A",).
    write_json(hdir / "vetted.json", {"rows": [vetted_row(id="server/channels/app::TestD", source="D")]})
    assert hunt.vet_done(hdir, ("A",)) is False

    seen_reqs: dict[str, Any] = {}

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        data = json.loads(req.read_text())
        seen_reqs[tag] = json.loads(data["user"]) if isinstance(data["user"], str) else data["user"]
        if tag == "vet":
            cands = seen_reqs[tag]["candidates"]
            write_json(Path(data["response_path"]), {"rows": [
                vetted_row(id=c["id"], source=c["source"], repro_cmd=c["repro_cmd"]) for c in cands
            ]})
        else:
            write_json(Path(data["response_path"]), {"files": [], "tests": []})
        return True, dispatch.DispatchResult(status="ok", model="sonnet"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    monkeypatch.setattr(hunt, "script", lambda *a: subprocess.CompletedProcess([], 0, stdout="", stderr=""))

    hunt.stage_v("1", hdir, ("A",))
    assert [(c["tag"], c["id"]) for c in seen_reqs["V"]["candidates"]] == [("A", "server/channels/app::TestA")]

    hunt.stage_vet(hdir, ("A",))
    assert [(c["source"], c["id"]) for c in seen_reqs["vet"]["candidates"]] == [("A", "server/channels/app::TestA")]
    assert hunt.vet_done(hdir, ("A",)) is True

    # Mode R only does not pull stale Mode V results.
    hunt.stage_vet(hdir, ("R",))
    r_cand = seen_reqs["vet"]["candidates"]
    assert [(c["source"], c["id"]) for c in r_cand] == [("R", "CR1")]
    assert r_cand[0]["diagnostic_v_results"] == {"run_V": {}, "base_V": {}}


# ------------------------------------------------------------------ #7: Match skeptic rows on both id and source

def test_stage_vet_matches_skeptic_rows_by_source_and_id(tmp_path, monkeypatch):
    hdir = _go_skeptic_hunt(tmp_path)
    tid = "server/channels/app::TestShared"
    write_json(hdir / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": []})

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        data = json.loads(req.read_text())
        # Same id, wrong source ("B" instead of "A") -> must be treated as malformed & fallback to HELD for A.
        write_json(Path(data["response_path"]), {"rows": [
            vetted_row(id=tid, source="B"),
        ]})
        return True, dispatch.DispatchResult(status="ok", model="opus"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.stage_vet(hdir, ("A",))
    rows = json.loads((hdir / "vetted.json").read_text())["rows"]
    assert [(r["source"], r["id"], r["decision"]) for r in rows] == [("A", tid, "HELD")]
    gap = json.loads((hdir / "driver.json").read_text())["gaps"]["vet"]
    assert "1 skeptic row(s) malformed or for unknown ids, ignored" in gap
    assert "1 candidate(s) with no skeptic row, held" in gap


# ------------------------------------------------------------------ #8: pr_tests_diff passes text, not dict repr

def test_skeptic_context_formats_pr_tests_diff_text_and_supports_drop_quote(tmp_path):
    hdir = _go_skeptic_hunt(tmp_path)
    write_json(hdir / "ctx.json", {
        "pr": {"title": "t", "description": "d"},
        "diff_production_code": "+x := 1",
        "callers": [],
        "pr_tests_diff": [{"file": "server/channels/app/foo_test.go", "added": '12: assert.Equal(t, "a\\nb", got)'}],
    })
    sc = hunt.skeptic_context(hdir)
    assert sc["pr_tests_diff"] == 'server/channels/app/foo_test.go\n12: assert.Equal(t, "a\\nb", got)'
    assert "{'file':" not in sc["pr_tests_diff"]

    row = vetted_row(decision="DROP", reason="intended", reason_code="INTENDED",
                     evidence_quote='assert.Equal(t, "a\\nb", got)')
    assert verdict.check_drop(row, verdict.drop_corpus(sc, "")) is True
    assert row["decision"] == "DROP"


# ------------------------------------------------------------------ #9: Mode R repro_cmd uses proving test ID, preserves CR1 lookup

def test_mode_r_repro_cmd_uses_proving_test_id_and_keeps_claim_id(tmp_path, monkeypatch):
    hdir = _go_skeptic_hunt(tmp_path)
    test_pass = "server/channels/app::TestHuntR_CR1_Other"
    test_bug = "server/channels/app::TestHuntR_CR1_WriteDenied"
    write_json(hdir / "review_verdicts.json", {"verdicts": {
        "CR1": {
            "id": "CR1",
            "verdict": "PROVEN",
            "base_verdict": "NEW_PR_BUG",
            "tests": {test_pass: "PASS", test_bug: "FAIL_3_OF_3"},
        },
    }})
    write_json(hdir / "base_R.json", {test_bug: "NEW_PR_BUG"})
    write_json(hdir / "run_R.messages.json", {test_bug: "expected 403 Forbidden, got 200 OK"})

    cands = hunt.candidates_all(hdir, ("R",))
    assert cands == [{
        "id": "CR1", "source": "R", "mechanical_verdict": "NEW_PR_BUG", "repro_id": test_bug,
    }]

    seen_cands: list[dict[str, Any]] = []

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        data = json.loads(req.read_text())
        user = json.loads(data["user"]) if isinstance(data["user"], str) else data["user"]
        seen_cands.extend(user["candidates"])
        c = user["candidates"][0]
        write_json(Path(data["response_path"]), {"rows": [
            vetted_row(id=c["id"], source="R", repro_cmd="model-guess", evidence_path="review_verdicts.json"),
        ]})
        return True, dispatch.DispatchResult(status="ok", model="opus"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.stage_vet(hdir, ("R",))

    expected_repro = hunt.repro_cmd(hdir, test_bug, tag="R")
    assert "run.py" in expected_repro and "repro 1 R --only server/channels/app::TestHuntR_CR1_WriteDenied" in expected_repro
    assert seen_cands[0]["id"] == "CR1"
    assert seen_cands[0]["repro_cmd"] == expected_repro
    assert seen_cands[0]["head_failure"] == "expected 403 Forbidden, got 200 OK"

    adm = verdict.admissibility(hdir)
    assert [(r["id"], r["repro_cmd"]) for r in adm["keep"]] == [("CR1", expected_repro)]
    assert adm["held"] == []
