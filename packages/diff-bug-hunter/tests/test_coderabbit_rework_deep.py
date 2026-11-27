# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Regression tests for all 20 CodeRabbit --deep findings fixed in Milestone M5."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import build_requests
import ctx
import dispatch
import eval_bugs
import hunt
import ledger
import lessons
import prepare
import pytest
import run
import trusted
from conftest import FAKE_DISPATCH, _git, make_repo, vetted_row
from conftest import fake_script as _fake
from hunt_common import hunt_dir, load_json, write_json
from verdicts import Verdict


def _setup_two_batch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
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
    repo = make_repo(tmp_path, base, head)
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    return repo, hunt_dir("master..feature")


# ------------------------------------------------------------------ #3: Failed mechanical stages never mark hunt_done


def test_failed_mechanical_stage_does_not_mark_hunt_done(tmp_path):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "batches": 1, "all_batches": True})
    req = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    dispatch.sidecar(req).write_text(dispatch.request_sha(req))
    write_json(hdir / "A" / "response.json", {"files": [{"path": "calc/a_test.go", "content": "x"}], "tests": []})
    write_json(hdir / "old_tests.json", {"tests": {}})
    write_json(hdir / "pr_tests.json", {"tests": {}})
    write_json(hdir / "vetted.json", {"rows": []})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(hdir / "findings.json", [])
    (hdir / "audit.md").write_text("# audit\n")
    write_json(hdir / "driver.json", {"gaps": {"run:A": "A COMPILE_ERROR after one repair round"}})
    assert hunt._hunt_complete(hdir, ("A",)) is False

    # Intentionally empty Mode A run that completed retry qualifies.
    write_json(hdir / "A" / "response.json", {"files": []})
    write_json(hdir / "run_A.json", {})
    (hdir / "run_A.response.sha256").write_text(run.fingerprint([]))
    (hdir / "A" / "retry.done").write_text("ok\n")
    write_json(hdir / "driver.json", {"gaps": {"empty:A": "Mode A emitted no tests after one retry"}})
    assert hunt._hunt_complete(hdir, ("A",)) is True


# ------------------------------------------------------------------ #4: Failed base rerun in Mode D does not confirm DIFF


def test_confirm_diff_on_base_ignores_records_from_failed_base_rerun(tmp_path, monkeypatch):
    ident = "u::TestHuntD_X"
    rkey = ("u", "HuntD_X")

    def fake_pass(wt, state, tag, units, td, stem, *, base=False):
        o = run.Outcome()
        o.results[ident] = Verdict.FAIL
        return o, {rkey: {0: {"input": 1, "output": "same"}}}, {}, {}, []

    monkeypatch.setattr(run, "_place_units", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", fake_pass)
    verdicts = {ident: Verdict.DIFF}
    detail: dict[str, Any] = {ident: {"differing": 1}}
    pending = [(ident, "u", rkey, {0: {"input": 1, "output": "head"}}, {0}, {0: {"input": 1, "output": "base"}}, {0})]
    run._confirm_diff_on_base(tmp_path, {}, "D", {"u": []}, set(), pending, verdicts, detail)
    assert verdicts == {ident: Verdict.DIFF}
    assert detail[ident]["base_rerun"] == "not available; DIFF from one base run"


# ------------------------------------------------------------------ #5 & #6: Batch coverage & mode expansion on archives


def test_first_batch_completion_does_not_skip_default_all_batches_and_mode_expansion_rebuilds(tmp_path, monkeypatch):
    _repo, hdir = _setup_two_batch(tmp_path, monkeypatch)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH))
    monkeypatch.setenv("FAKE_RESPONSES", str(tmp_path / "no_responses"))
    log = tmp_path / "dispatch.log"
    monkeypatch.setenv("FAKE_LOG", str(log))
    (tmp_path / "no_responses").mkdir()

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            repo = Path(_git(tmp_path / "repo", "rev-parse", "--show-toplevel"))
            wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
            mb = prepare.worktrees(repo, "feature", "master", wt, wt_base) if not wt.exists() else _git(repo, "rev-parse", "master")
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
            if args[1] == "hunters":
                for t in ("A", "B"):
                    build_requests.write(hdir, t, "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            elif args[1] == "diff":
                build_requests.write(hdir, "D", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "run":
            tag = args[2]
            write_json(hdir / f"run_{tag}.json", {})
            files = json.loads((hdir / tag / "response.json").read_text()).get("files", [])
            (hdir / f"run_{tag}.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "diff":
            write_json(hdir / "diff_D.json", {})
            write_json(hdir / "diff_D.examples.json", {})
            files = json.loads((hdir / "D" / "response.json").read_text()).get("files", [])
            (hdir / "diff_D.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name in ("old_tests.py", "pr_tests.py"):
            write_json(hdir / f"{name[:-3]}.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    # 1. --first-batch covers batch 1 only.
    assert hunt.main(["hunt.py", "master..feature", "--first-batch", "--modes", "A"]) == 0
    assert json.loads((hdir / "hunt_done.json").read_text())["all_batches"] is False
    assert log.read_text().splitlines() == ["A"]

    # 2. A second --first-batch with same modes skips cleanly.
    assert hunt.main(["hunt.py", "master..feature", "--first-batch", "--modes", "A"]) == 0
    assert log.read_text().splitlines() == ["A"]

    # 3. A default all-batches run must NOT skip; it advances to batch 2.
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A"]) == 0
    assert json.loads((hdir / "hunt_done.json").read_text())["all_batches"] is True
    assert (hdir / "batches" / "batch_1" / "A" / "request.json").exists()
    assert log.read_text().splitlines() == ["A", "A"]

    # 4. Expanding modes to A,D rebuilds and runs D on BOTH batch 1 and batch 2.
    log.write_text("")
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,D"]) == 0
    calls = log.read_text().splitlines()
    assert calls.count("D") == 2 and calls.count("A") == 2
    assert (hdir / "batches" / "batch_1" / "D" / "request.json").exists()
    assert (hdir / "D" / "request.json").exists()


# ------------------------------------------------------------------ #7: One skeptic decision per candidate


def test_stage_vet_holds_conflicting_duplicate_rows_and_vet_done_rejects_dups(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module x\n")
    write_json(hdir / "state.json", {"pr": "1", "wt": str(wt), "batches": 1})
    write_json(hdir / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "+x", "callers": []})
    tid = "pkg::TestHuntA_X"
    write_json(hdir / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg/hunt_a_test.go", "content": "func TestHuntA_X() {}"}]})

    dup_rows = [vetted_row(id=tid, source="A", decision="KEEP"), vetted_row(id=tid, source="A", decision="DROP")]
    write_json(hdir / "vetted.json", {"rows": dup_rows})
    assert hunt.vet_done(hdir, ("A",)) is False

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        write_json(Path(json.loads(req.read_text())["response_path"]), {"rows": dup_rows})
        return True, dispatch.DispatchResult(status="ok", model="opus"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.stage_vet(hdir, ("A",))
    rows = json.loads((hdir / "vetted.json").read_text())["rows"]
    assert len(rows) == 1 and rows[0]["decision"] == "HELD"
    assert "conflicting" in json.loads((hdir / "driver.json").read_text())["gaps"]["vet"]
    assert hunt.vet_done(hdir, ("A",)) is True


# ------------------------------------------------------------------ #8: Committed run + separate Mode A retry tracking


def test_run_committed_requires_sha256_and_mode_a_retry_marker(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    write_json(hdir / "A" / "response.json", {"files": []})
    write_json(hdir / "run_A.json", {})
    # Missing run_A.response.sha256 -> not committed.
    assert hunt._run_committed(hdir, "A") is False
    assert hunt._run_done(hdir, ("A",)) is False

    # Committed empty run without A/retry.done still triggers retry on resume.
    (hdir / "run_A.response.sha256").write_text(run.fingerprint([]))
    assert hunt._run_committed(hdir, "A") is True
    assert hunt._run_done(hdir, ("A",)) is False

    seen: list[str] = []

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        seen.append(f"{name}:{' '.join(args)}")
        if name == "build_requests.py" and args[1] == "retry":
            build_requests.write_request(hdir / "A" / "request.retry.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
        if name == "run.py":
            write_json(hdir / "run_A.json", {"pkg::TestHuntA_R": "PASS"})
            write_json(hdir / "run_A.messages.json", {})
            files = [{"path": "pkg/a_test.go", "content": "x"}]
            write_json(hdir / "A" / "response.json", {"files": files})
            (hdir / "run_A.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="PASS\n", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result",
                        lambda *a, **k: (True, dispatch.DispatchResult(status="ok", model="sonnet"), None))
    hunt.run_tag("1", hdir, "A", retry_empty=True)
    assert any("build_requests.py:1 retry A" in s for s in seen)
    assert (hdir / "A" / "retry.done").is_file()
    assert hunt._run_done(hdir, ("A",)) is True


# ------------------------------------------------------------------ #9: Mode-scoped failure messages


def test_stage_v_and_stage_vet_scope_messages_by_source(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    (wt / "go.mod").write_text("module x\n")
    write_json(hdir / "state.json", {"pr": "1", "wt": str(wt), "batches": 1})
    write_json(hdir / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "+x", "callers": []})
    tid = "calc::(package failed)"
    write_json(hdir / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "run_A.messages.json", {tid: "FAILURE_FROM_A"})
    write_json(hdir / "A" / "response.json", {"files": []})
    write_json(hdir / "run_B.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_B.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "run_B.messages.json", {tid: "FAILURE_FROM_B"})
    write_json(hdir / "B" / "response.json", {"files": []})
    write_json(hdir / "run_V.messages.json", {tid: "FAILURE_FROM_V"})

    captured: dict[str, Any] = {}

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        captured[tag] = json.loads(json.loads(req.read_text())["user"])
        return False, None, dispatch.DispatchError("stop")

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.stage_v("1", hdir, ("A", "B"))
    hunt.stage_vet(hdir, ("A", "B"))
    v_by_src = {c["tag"]: c["head_failure"] for c in captured["V"]["candidates"]}
    vet_by_src = {c["source"]: c["head_failure"] for c in captured["vet"]["candidates"]}
    assert v_by_src == {"A": "FAILURE_FROM_A", "B": "FAILURE_FROM_B"}
    assert vet_by_src == {"A": "FAILURE_FROM_A", "B": "FAILURE_FROM_B"}


# ------------------------------------------------------------------ #10: ctx.source_view budget across hunks


def test_source_view_caps_huge_addition_to_max_source_lines(tmp_path):
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    big = "\n".join(f"line_{i}" for i in range(1, 30001))
    (wt / "pkg" / "gen.go").write_text(big)
    patch = "@@ -0,0 +1,30000 @@\n" + "\n".join(f"+line_{i}" for i in range(1, 10))
    view = ctx.source_view(wt, "pkg/gen.go", patch)
    assert len(view.splitlines()) <= ctx.MAX_SOURCE_LINES + 5
    assert "[source cut:" in view


# ------------------------------------------------------------------ #11: go_pr_added_names requires Go declaration


def test_go_pr_added_names_rejects_comment_only_and_unrelated_pkg(tmp_path):
    base = {
        "go.mod": "module example.com/a8\n\ngo 1.22\n",
        "pkg/a.go": "package pkg\n\n// staleHook mentioned in unchanged comment\nfunc Existing() {}\n",
        "other/b.go": "package other\n\nfunc OtherOnly() {}\n",
    }
    head = {
        "pkg/a.go": "package pkg\n\n// staleHook mentioned in unchanged comment\nfunc Existing() {}\nfunc AddedInPkg() {}\n",
    }
    repo = make_repo(tmp_path, base, head)
    wt_base, wt_head = tmp_path / "wt_base", tmp_path / "wt_head"
    prepare.worktrees(repo, "feature", "master", wt_head, wt_base)
    assert run.go_pr_added_names(wt_head, "pkg/x_test.go:5:2: undefined: staleHook", pkg_dir="pkg", wt_base=wt_base) is None
    assert run.go_pr_added_names(wt_head, "pkg/x_test.go:5:2: undefined: OtherOnly", pkg_dir="pkg", wt_base=wt_base) is None
    assert run.go_pr_added_names(wt_head, "pkg/x_test.go:5:2: undefined: Existing", pkg_dir="pkg", wt_base=wt_base) is None
    assert run.go_pr_added_names(wt_head, "pkg/x_test.go:5:2: undefined: AddedInPkg", pkg_dir="pkg", wt_base=wt_base) == ["AddedInPkg"]


# ------------------------------------------------------------------ #12: driver writes review_verdicts.json before stage_vet


def test_drive_computes_review_verdicts_before_vet(tmp_path, monkeypatch):
    _repo, hdir = _setup_two_batch(tmp_path, monkeypatch)
    seen_rv_in_vet: list[bool] = []
    # Single-file repo for 1-batch run
    repo = make_repo(tmp_path / "r1", {"go.mod": "module example.com/r\n\ngo 1.22\n", "pkg/a.go": "package pkg\nfunc F() int { return 1 }\n"},
                     {"pkg/a.go": "package pkg\nfunc F() int {\n\treturn 2\n}\n"})
    monkeypatch.setenv("HUNT_MM", str(repo))
    hdir = hunt_dir("master..feature")

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            wt, wt_base = tmp_path / "rwt", tmp_path / "rwt.base"
            mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
            write_json(hdir / "prepare.json", {
                "repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
                "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir),
                "schema_version": 1, "base_mode": "two-dot", "huntable_files": 1,
            })
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "ctx.py":
            prep = json.loads((hdir / "prepare.json").read_text())
            ctx.build(args[0], 1, prep, {"title": "r", "body": ""})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "build_requests.py" and args[1] == "review":
            write_json(hdir / "R" / "threads.json", {"pr": "master..feature", "included": [
                {"id": "CR1", "path": "pkg/a.go", "line": 2, "severity": "major", "triage": "open_current",
                 "is_resolved": False, "is_outdated": False, "title": "bug", "url": "https://ex/1"}], "skipped": []})
            build_requests.write(hdir, "R", "sys", {"x": 1}, build_requests.REVIEW_SCHEMA)
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "run":
            tid = "pkg::TestHuntR_CR1"
            write_json(hdir / "run_R.json", {tid: "FAIL_3_OF_3"})
            write_json(hdir / "run_R.messages.json", {tid: "wrong"})
            files = json.loads((hdir / "R" / "response.json").read_text()).get("files", [])
            (hdir / "run_R.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name == "run.py" and args[0] == "base":
            tid = "pkg::TestHuntR_CR1"
            write_json(hdir / "base_R.json", {tid: "NEW_PR_BUG"})
            files = json.loads((hdir / "R" / "response.json").read_text()).get("files", [])
            (hdir / "base_R.response.sha256").write_text(run.fingerprint(files))
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        if name in ("old_tests.py", "pr_tests.py"):
            write_json(hdir / f"{name[:-3]}.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        if tag == "R":
            write_json(Path(json.loads(req.read_text())["response_path"]), {
                "files": [{"path": "pkg/hunt_r_test.go", "content": "func TestHuntR_CR1() {}"}],
                "claims": [{"id": "CR1", "testable": True, "tests": ["TestHuntR_CR1"], "reason": "ok"}],
                "tests": [],
            })
        elif tag == "vet":
            seen_rv_in_vet.append((hdir / "review_verdicts.json").is_file())
            user = json.loads(json.loads(req.read_text())["user"])
            assert [c["id"] for c in user["candidates"]] == ["CR1"]
            write_json(Path(json.loads(req.read_text())["response_path"]),
                       {"rows": [vetted_row(id="CR1", source="R", decision="DROP",
                                            reason_code="INTENDED", evidence_quote="r")]})
        return True, dispatch.DispatchResult(status="ok", model="sonnet"), None

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    assert hunt.main(["hunt.py", "master..feature", "--modes", "R"]) == 0
    assert seen_rv_in_vet == [True]
    assert (hdir / "review_verdicts.json").is_file()


# ------------------------------------------------------------------ #13 & #19: ledger vetted_present & Mode B per-batch identity


def test_ledger_rejects_vetted_present_false_and_keeps_distinct_mode_b_batches(tmp_path):
    h1 = tmp_path / "h_unvetted"
    tid = "pkg1::TestHuntB_Nil"
    write_json(h1 / "base_B.json", {tid: "NEW_PR_BUG"})
    write_json(h1 / "verdict.json", {"vetted_present": False, "keep": [], "held": []})
    tier, gaps = ledger._tier_and_gaps(h1, {"mode_a_empty": 0}, 1, 1, 0, 1, 1, False, {})
    assert tier == "Partial or Unverified Coverage" and "unvetted findings" in gaps

    # Mode B same test name in two different batches covering different files stays separate.
    h2 = tmp_path / "h_two_b"
    keep_b1 = vetted_row(id=tid, source="B", decision="KEEP", file_line="pkg1/f1.go:10")
    drop_b2 = {"row": vetted_row(id=tid, source="B", decision="DROP", file_line="pkg1/f2.go:22"),
               "reasons": ["decision=DROP"]}
    write_json(h2 / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/f1.go"]})
    write_json(h2 / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [keep_b1], "held": []})
    write_json(h2 / "state.json", {"batch": 2, "changed": ["pkg1/f2.go"]})
    write_json(h2 / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_b2]})
    keep, held = ledger.resolved_verdicts(h2)
    assert len(keep) == 1 and keep[0]["file_line"] == "pkg1/f1.go:10"
    assert len(held) == 1


# ------------------------------------------------------------------ #14, #15, #16, #17, #18: eval_bugs.py


def test_eval_bugs_rework_gates(tmp_path, monkeypatch):
    # #14: cmd_fix_diff requires original differing index to be checked.
    hdir = tmp_path / "hd"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    rkey = (u, run.record_name(ident))
    write_json(hdir / "diff_D.json", {ident: "DIFF"})
    write_json(hdir / "diff_D.examples.json", {ident: {"examples": [{"i": 1, "input": 1, "base": 1, "head": 2}]}})
    write_json(hdir / "D" / "response.json", {"files": [{"path": path, "content": ""}]})
    runs = {
        "fix": {0: {"output": "same"}, 1: {"output": "t1"}},
        "fix2": {0: {"output": "same"}, 1: {"output": "t2"}},
        "fixbase": {0: {"output": "same"}, 1: {"output": "t3"}},
        "fixbase2": {0: {"output": "same"}, 1: {"output": "t4"}},
    }
    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", lambda wt, st, t, un, td, stem, base=False: (
        type("O", (), {"results": {ident: "PASS"}})(), {rkey: runs[stem]}, {}, {}, []))
    assert eval_bugs.cmd_fix_diff(hdir, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path) == {
        ident: Verdict.FIX_NOT_RUN}

    # #15: vet_error fails scorecard with ERROR and admitted=None.
    manifest = {"cases": [], "controls": [{"id": "k1", "area": "a"}], "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}
    card = eval_bugs.scorecard(manifest, {"k1": {"results": [{"hunter": "V", "admissibility": {}, "vet_error": "bad"}]}})
    assert card["verdict"] == Verdict.ERROR and card["errors"] == ["k1"] and card["rows"][0]["admitted"] is None

    # #16: diff_scorecards rejects candidate missing a baseline signal.
    base_c = {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0, "diff_fp_rate": 0.0},
              "rows": [{"kind": "case", "id": "c1"}], "errors": [], "signals": ["hunters", "diff", "old"]}
    cand_c = {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0},
              "rows": [{"kind": "case", "id": "c1"}], "errors": [], "signals": ["hunters", "old"]}
    diff_res = eval_bugs.diff_scorecards(base_c, cand_c)
    assert diff_res["verdict"] == Verdict.FAIL and diff_res["missing_signals"] == ["diff"]

    # #17: vet_signal applies post_filter failure_regex lessons.
    hv = tmp_path / "hv"
    tid = "pkg::TestCtrl"
    write_json(hv / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hv / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hv / "run_A.messages.json", {tid: "known noise: transient port bind"})
    write_json(hv / "vetted.json", {"rows": [vetted_row(id=tid, source="A", decision="KEEP")]})
    monkeypatch.setattr(lessons, "load", lambda: [
        {"id": "L_FP", "kind": "fp", "failure_regex": "transient port bind"}])
    vs = eval_bugs.vet_signal(hv)
    assert vs["admissibility"] == {"vetted_present": True, "keep": [], "held": 1}

    # #18: hunt_entry preserves results when fix_sha worktree setup fails.
    repo = make_repo(tmp_path / "rfix", {"go.mod": "module example.com/f\n\ngo 1.22\n", "a.go": "package a\n"},
                     {"a.go": "package a\n// change\n"})
    bug_sha = _git(repo, "rev-parse", "feature")
    out_dir = tmp_path / "eval_out"
    out_dir.mkdir()
    monkeypatch.setattr(prepare, "deps", lambda *a, **k: (False, False))
    real_wt = prepare.worktree

    def fail_fix_wt(r, dst, rev):
        if str(dst).endswith(".fix"):
            raise eval_bugs.InfraError("fix worktree boom")
        return real_wt(r, dst, rev)

    monkeypatch.setattr(prepare, "worktree", fail_fix_wt)
    resp_dir = tmp_path / "resp"
    write_json(resp_dir / "A" / "response.json", {"files": []})
    entry = {"id": "case1", "repo": str(repo), "head": bug_sha, "fix_sha": bug_sha, "area": "a", "responses": str(resp_dir)}
    res = eval_bugs.hunt_entry(entry, 1, out_dir, None, signals=("hunters",))
    assert res["results"] and "fix setup failed" in (res["results"][0].get("fix_reason") or "")


# ------------------------------------------------------------------ #20: Log miss probes and failure_regex holds


def test_miss_probes_and_failure_regex_holds_logged_for_prune(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    monkeypatch.setenv("HUNT_SCRATCH", str(tmp_path / "scratch"))
    monkeypatch.setenv("HUNT_LESSONS_HITS", str(tmp_path / "lessons_hits.jsonl"))
    hdir = hunt_dir("40999")
    write_json(hdir / "state.json", {"pr": "40999", "targets": [{"lang": "go", "dir": "server/a"}]})
    write_json(hdir / "ctx.json", {
        "pr": {"number": 40999, "title": "t", "description": "d"},
        "diff_production_code": "+++ b/server/a/x.go\n+checkAuth()\n",
        "changed_files_head_source": [{"file": "server/a/x.go", "source": ""}],
        "sibling_tests_and_helpers": [], "callers": [], "your_test_files": [],
    })
    miss_lsn = {"id": "L-MISS1", "kind": "miss", "pattern": "p", "applies_to": {"lang": ["go"], "path_globs": ["server/a/*"]},
                "keywords": ["checkAuth"], "symptom": "s", "check": "c", "source_pr": 1}
    fp_regex = {"id": "L-REG1", "kind": "fp", "pattern": "p2", "applies_to": {"lang": ["go"], "path_globs": ["server/a/*"]},
                "keywords": ["other"], "symptom": "s", "check": "c", "source_pr": 1, "failure_regex": "transient err"}
    monkeypatch.setattr(lessons, "load", lambda: [miss_lsn, fp_regex])

    build_requests.main("40999", "hunters")
    tid = "server/a::TestHuntA_X"
    write_json(hdir / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hdir / "run_A.messages.json", {tid: "transient err"})
    write_json(hdir / "vetted.json", {"rows": [vetted_row(id=tid, source="A", decision="KEEP")]})
    hunt.stage_verdict(hdir)

    lines = [json.loads(x) for x in (tmp_path / "lessons_hits.jsonl").read_text().splitlines()]
    # Pad 29 earlier hunts that did NOT match either lesson; hunt 40999 used both -> neither should retire!
    padded = [{"run": str(i), "matched": []} for i in range(1, 30)] + lines
    retired = lessons.prune([miss_lsn, fp_regex], padded, window=30)
    assert retired == []


# ------------------------------------------------------------------ Round-2 CodeRabbit fixes (prepare, run, pr_server)


def test_prepare_invalidates_range_cache_when_base_advances(tmp_path, monkeypatch):
    repo = make_repo(tmp_path, {"a.go": "package a\nfunc F() int { return 1 }\n"},
                     {"a.go": "package a\nfunc F() int { return 2 }\n"})
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_SCRATCH", str(tmp_path / "scratch"))
    prepare.prepare("master..feature")
    hdir = hunt_dir("master..feature")
    write_json(hdir / "run_A.json", {"a::TestA": "PASS"})

    # Second run with unchanged base & head raises AlreadyHunted.
    with pytest.raises(prepare.AlreadyHunted):
        prepare.prepare("master..feature")

    # Advance master (head stays at same SHA): must invalidate and re-prepare instead of AlreadyHunted.
    _git(repo, "checkout", "-q", "master")
    (repo / "base_only.txt").write_text("advance\n")
    _git(repo, "add", "base_only.txt")
    _git(repo, "commit", "-qm", "advance master")
    prepare.prepare("master..feature")
    assert not (hdir / "run_A.json").exists()
    assert json.loads((hdir / "prepare.json").read_text())["merge_base"] == _git(repo, "rev-parse", "master")


def test_prepare_docker_services_waits_for_cold_container_and_passes_immediately_when_ready(monkeypatch):
    pg_probes = {"n": 0}
    waits: list[float] = []

    class FakeEvent:
        def wait(self, sec: float) -> bool:
            waits.append(sec)
            return False

    def fake_sh(args, cwd, *, check=True, timeout=1800, env=None):
        if args[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="")
        if args[:3] == ["docker", "exec", prepare.PG_CONTAINER] and "pg_isready" in args:
            pg_probes["n"] += 1
            return subprocess.CompletedProcess(args, 0 if pg_probes["n"] >= 3 else 1, stdout="", stderr="")
        if args[:3] == ["docker", "exec", prepare.PG_CONTAINER] and "-tAc" in args:
            return subprocess.CompletedProcess(args, 0, stdout="1\n", stderr="")
        if args[:3] == ["docker", "exec", prepare.REDIS_CONTAINER]:
            return subprocess.CompletedProcess(args, 0, stdout="PONG\n", stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(prepare.threading, "Event", FakeEvent)
    monkeypatch.setattr(prepare, "sh", fake_sh)
    prepare._docker_services()
    assert pg_probes["n"] == 3 and len(waits) == 2


def test_salvaged_go_test_with_type_error_becomes_base_uncompilable_not_new_api(tmp_path):
    base = {
        "go.mod": "module example.com/salv\n\ngo 1.22\n",
        "calc/calc.go": "package calc\n\nfunc Clamp(x int) int { return x }\n",
    }
    head = {
        "calc/calc.go": "package calc\n\nfunc Clamp(x string) string { return x }\n",
    }
    repo = make_repo(tmp_path, base, head)
    wt_head, wt_base = tmp_path / "wt_head", tmp_path / "wt_base"
    prepare.worktrees(repo, "feature", "master", wt_head, wt_base)
    hdir = tmp_path / "h"
    test_src = (
        'package calc\n\nimport "testing"\n\n'
        'func TestHuntA_ChangedSig(t *testing.T) { if Clamp("hi") != "x" { t.Fatal("fail") } }\n'
    )
    write_json(hdir / "A" / "response.json", {"files": [{"path": "calc/hunt_hunta_test.go", "content": test_src}]})
    state = {"wt": str(wt_head), "wt_base": str(wt_base), "targets": [{"dir": "calc", "lang": "go"}]}
    assert run.cmd_run(hdir, state, "A", runs=1) == {"calc::TestHuntA_ChangedSig": Verdict.FAIL_3_OF_3}
    out = run.cmd_base(hdir, state, "A")
    assert out["calc::TestHuntA_ChangedSig"] == Verdict.BASE_UNCOMPILABLE
    assert "new_api" not in out
    assert (hdir / "base_A.errors.json").is_file()


def test_pr_server_create_user_passes_admin_token_for_member_post(monkeypatch):
    import importlib.util
    ps_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "pr_server.py"
    spec = importlib.util.spec_from_file_location("pr_server", ps_path)
    assert spec and spec.loader
    pr_server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pr_server)

    posts: list[tuple[str, str | None]] = []

    def fake_request(method, url, body=None, token=None, timeout=10):
        if method == "POST" and url.endswith("/api/v4/users"):
            posts.append((body["username"], token))
            return {}, {"id": f"uid-{body['username']}"}
        if method == "POST" and url.endswith("/api/v4/users/login"):
            return {"Token": "adm-tok"}, {"id": "uid-admin", "roles": "system_admin"}
        if method == "POST" and url.endswith("/api/v4/teams"):
            return {}, {"id": "team-1"}
        return {}, {}

    monkeypatch.setattr(pr_server, "request", fake_request)
    pr_server.seed("http://127.0.0.1:8065", "admin_u", "pw")
    assert posts == [("admin_u", None), ("verify_member", "adm-tok")]


# ------------------------------------------------------------------ Round-3 CodeRabbit fixes


def test_qualified_go_name_resolves_in_actual_package_not_unrelated_pkg(tmp_path):
    base = {
        "go.mod": "module example.com/sel\n\ngo 1.22\n",
        "model/m.go": "package model\n\ntype Old struct{}\n",
        "other/o.go": "package other\n\nfunc NewThing() {}\n",
        "app/a.go": "package app\n\nfunc Use() {}\n",
    }
    head = {
        "model/m.go": "package model\n\ntype Old struct{}\nfunc NewThing() {}\n",
    }
    repo = make_repo(tmp_path, base, head)
    wt_head, wt_base = tmp_path / "wt_h", tmp_path / "wt_b"
    prepare.worktrees(repo, "feature", "master", wt_head, wt_base)
    src = 'package app\nimport "example.com/sel/model"\nfunc TestHuntA_X() { model.NewThing() }\n'
    assert run.go_pr_added_names(
        wt_head, "app/hunt_hunta_test.go:3:21: undefined: model.NewThing",
        pkg_dir="app", wt_base=wt_base, source_texts={"app/hunt_hunta_test.go": src},
    ) == ["NewThing"]


def test_prepare_checks_schema_before_already_hunted_and_installs_webapp_for_mixed_pr_tests(tmp_path, monkeypatch):
    # 1. check_schema runs before AlreadyHunted on legacy prepare.json missing metadata keys.
    repo = make_repo(tmp_path / "r1", {"a.go": "package a\nfunc F() int { return 1 }\n"},
                     {"a.go": "package a\nfunc F() int { return 2 }\n"})
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_SCRATCH", str(tmp_path / "scratch"))
    hdir = hunt_dir("master..feature")
    head_sha = _git(repo, "rev-parse", "feature")
    write_json(hdir / "prepare.json", {"schema_version": 0, "head": head_sha})
    write_json(hdir / "run_A.json", {"a::TestA": "PASS"})
    with pytest.raises(prepare.SchemaMismatch):
        prepare.prepare("master..feature")

    # 2. Mixed PR (server/*.go + webapp/**/*.test.tsx) installs webapp_deps even though test is prefilter-excluded.
    repo2 = make_repo(
        tmp_path / "r2",
        {"server/a.go": "package a\n", "webapp/channels/src/a.test.tsx": "it('a', () => {});\n"},
        {"server/a.go": "package a\nfunc B() {}\n", "webapp/channels/src/a.test.tsx": "it('a', () => { expect(1).toBe(1); });\n"},
    )
    wt, wt_base = tmp_path / "wt2", tmp_path / "wt2b"
    mb = prepare.worktrees(repo2, "feature", "master", wt, wt_base)
    web_called: list[bool] = []
    monkeypatch.setattr(prepare, "go_work", lambda w: None)
    monkeypatch.setattr(prepare, "webapp_deps", lambda *a: web_called.append(True))
    go_ch, web_ch = prepare.deps(repo2, wt, wt_base, mb, "feature")
    assert go_ch is True and web_ch is True and web_called == [True]


def test_cmd_fix_diff_requires_all_four_executions_to_pass(tmp_path, monkeypatch):
    hdir = tmp_path / "hd4"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    rkey = (u, run.record_name(ident))
    write_json(hdir / "diff_D.json", {ident: "DIFF"})
    write_json(hdir / "diff_D.examples.json", {ident: {"examples": [{"i": 0, "input": 1, "base": 1, "head": 2}]}})
    write_json(hdir / "D" / "response.json", {"files": [{"path": path, "content": ""}]})

    def fake_pass(wt, st, t, un, td, stem, base=False):
        o = run.Outcome()
        o.results[ident] = Verdict.FAIL if stem == "fix2" else Verdict.PASS
        return o, {rkey: {0: {"output": "same"}}}, {}, {}, []

    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", fake_pass)
    assert eval_bugs.cmd_fix_diff(hdir, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path) == {
        ident: Verdict.FIX_NOT_RUN}


def test_report_finding_writes_new_api_to_base_result_and_matches_schema():
    import report
    row = vetted_row(id="calc::TestA", source="A", mechanical_verdict="NEW_API")
    item = report.finding(row)
    assert item["base_result"] == "NEW_API"
    schema = json.loads((Path(__file__).resolve().parent.parent / ".claude" / "skills" / "hunt" / "finding.schema.json").read_text())
    assert item["base_result"] in schema["properties"]["base_result"]["enum"]


def test_pr_server_pending_profile_forces_replacement_after_interrupted_up(tmp_path, monkeypatch):
    import importlib.util
    ps_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "pr_server.py"
    spec = importlib.util.spec_from_file_location("pr_server", ps_path)
    assert spec and spec.loader
    pr_server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pr_server)

    e2e = tmp_path / "e2e"
    (e2e / ".ci").mkdir(parents=True)
    (e2e / ".ci" / "server.generate.sh").write_text("")
    prof = tmp_path / "profile"
    monkeypatch.setenv("VERIFY_USER", "u")
    monkeypatch.setenv("VERIFY_PASSWORD", "p")
    monkeypatch.setattr(pr_server, "profile_path", lambda: prof)
    monkeypatch.setattr(pr_server, "lock_path", lambda: tmp_path / "lock")
    monkeypatch.setattr(pr_server, "running_build", lambda url: "abc1234")
    monkeypatch.setattr(pr_server, "seed", lambda *a: None)

    class Boom(RuntimeError):
        pass

    calls: list[tuple[str, ...]] = []
    should_fail = {"v": True}

    def fake_make(e2e_dir, target, *args):
        calls.append((target, *args))
        if target == "start-server" and should_fail["v"]:
            should_fail["v"] = False
            raise Boom("interrupted startup")

    monkeypatch.setattr(pr_server, "make", fake_make)
    with pytest.raises(Boom):
        pr_server.up("repo:abc1234", e2e, flags=["FlagA"])
    assert json.loads(prof.read_text()) == {"pending": True}
    assert pr_server._stored_profile() is None

    # Next `up` with empty flags MUST still replace the server instead of skipping.
    calls.clear()
    pr_server.up("repo:abc1234", e2e, flags=[])
    assert [c[0] for c in calls] == ["stop-server", "start-server"]
    assert pr_server._stored_profile() == []


def test_verify_ui_freeze_emits_unsaved_get_captures():
    script_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "verify_ui.mjs"
    js_code = (
        f"import {{ freeze }} from {json.dumps(script_path.as_uri())};\n"
        "const out = freeze({ steps: [{ capture: { api: 'GET /api/v4/plugins/health' } }], expect: [] }, 'http://127.0.0.1:8065');\n"
        "process.stdout.write(out);\n"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js_code], capture_output=True, text=True, check=True)
    assert "/api/v4/plugins/health" in p.stdout
    assert "toBeLessThan(500)" in p.stdout


# ------------------------------------------------------------------ Round-4 CodeRabbit fixes


def test_stage_vet_chunks_over_30_candidates_to_respect_vetted_schema(tmp_path, monkeypatch):
    hdir = tmp_path / "h35"
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module x\n")
    write_json(hdir / "state.json", {"pr": "1", "wt": str(wt), "batches": 1})
    write_json(hdir / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "+x", "callers": []})
    base_a = {f"pkg::TestHuntA_{i}": "NEW_PR_BUG" for i in range(35)}
    write_json(hdir / "base_A.json", base_a)
    write_json(hdir / "A" / "response.json", {"files": []})

    chunk_sizes: list[int] = []

    def fake_dispatch(_hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        user = json.loads(json.loads(req.read_text())["user"])
        cands = user["candidates"]
        chunk_sizes.append(len(cands))
        rows = [vetted_row(id=c["id"], source="A", decision="KEEP") for c in cands]
        write_json(Path(json.loads(req.read_text())["response_path"]), {"rows": rows})
        return True, dispatch.DispatchResult(status="ok", model="opus"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.stage_vet(hdir, ("A",))
    assert chunk_sizes == [30, 5]
    assert hunt.vet_done(hdir, ("A",)) is True


def test_go_pr_added_names_rejects_methods_for_pkg_lookup_and_checks_all_scopes(tmp_path):
    base = {
        "go.mod": "module example.com/scopes\n\ngo 1.22\n",
        "pkg/p.go": "package pkg\n\ntype Runner struct{}\nfunc (r Runner) Resolve() {}\n",
        "a/a.go": "package a\n",
        "b/b.go": "package b\n\nfunc Existing() {}\n",
    }
    head = {
        "a/a.go": "package a\n\nfunc Resolve() {}\n",
    }
    repo = make_repo(tmp_path, base, head)
    wt_head, wt_base = tmp_path / "wth", tmp_path / "wtb"
    prepare.worktrees(repo, "feature", "master", wt_head, wt_base)

    # Bare package-level lookup must not be satisfied by Runner.Resolve() method.
    assert run.go_pr_added_names(wt_head, "pkg/x_test.go:4:2: undefined: Resolve", pkg_dir="pkg", wt_base=wt_base) is None

    # Same suffix across two packages: a.Resolve added, b.Resolve missing -> must return None.
    err_two = "pkg/x_test.go:4:2: undefined: a.Resolve\npkg/x_test.go:5:2: undefined: b.Resolve\n"
    src_map = {"pkg/x_test.go": 'package pkg\nimport (\n\t"example.com/scopes/a"\n\t"example.com/scopes/b"\n)\n'}
    assert run.go_pr_added_names(wt_head, err_two, pkg_dir="pkg", wt_base=wt_base, source_texts=src_map) is None


def test_confirm_diff_on_base_treats_empty_passing_rerun_as_nondeterministic_and_retains_drops(tmp_path, monkeypatch):
    ident = "u::TestHuntD_X"
    rkey = ("u", "HuntD_X")

    def fake_pass(wt, state, tag, units, td, stem, *, base=False):
        o = run.Outcome()
        o.results[ident] = Verdict.PASS
        return o, {}, {}, {}, []

    monkeypatch.setattr(run, "_place_units", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", fake_pass)
    verdicts = {ident: Verdict.DIFF}
    detail: dict[str, Any] = {ident: {"differing": 1, "dropped": 1}}
    pending = [(ident, "u", rkey, {0: {"input": 1, "output": "head"}}, {0}, {0: {"input": 1, "output": "base"}}, {0})]
    run._confirm_diff_on_base(tmp_path, {}, "D", {"u": []}, set(), pending, verdicts, detail)
    assert verdicts == {ident: Verdict.NONDETERMINISTIC}
    assert detail[ident]["dropped"] == 2


def test_eval_bugs_fix_compile_error_and_archived_batch_admissibility(tmp_path, monkeypatch):
    # 1. Fix-side compile error map yields FIX_INCOMPATIBLE.
    hdir = tmp_path / "hd_err"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    write_json(hdir / "diff_D.json", {ident: "DIFF"})
    write_json(hdir / "D" / "response.json", {"files": [{"path": path, "content": ""}]})
    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", lambda wt, st, t, un, td, stem, base=False: (
        run.Outcome(), {}, {u: "compile failed"} if stem == "fix" else {}, {}, []))
    assert eval_bugs.cmd_fix_diff(hdir, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path) == {
        ident: Verdict.FIX_INCOMPATIBLE}

    # 2. vet_signal sees archived batch keeps when active batch has none.
    hc = tmp_path / "h_arch_ctrl"
    tid = "pkg1::TestCtrl"
    write_json(hc / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/a.go"]})
    write_json(hc / "batches" / "batch_1" / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hc / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hc / "batches" / "batch_1" / "vetted.json", {"rows": [vetted_row(id=tid, source="A", decision="KEEP")]})
    write_json(hc / "state.json", {"batch": 2, "changed": ["pkg2/b.go"]})
    write_json(hc / "vetted.json", {"rows": []})
    vs = eval_bugs.vet_signal(hc)
    assert vs["admissibility"] == {"vetted_present": True, "keep": [tid], "held": 0}


def test_verify_ui_freeze_preserves_proto_json_key():
    script_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "verify_ui.mjs"
    js_code = (
        f"import {{ freeze }} from {json.dumps(script_path.as_uri())};\n"
        'const payload = JSON.parse(\'{"__proto__":{"enabled":true}}\');\n'
        "const out = freeze({ steps: [], expect: [{ api: { method: 'POST', path: '/api/v4/x', body: payload, status: 200 } }] }, 'http://127.0.0.1:8065');\n"
        "process.stdout.write(out);\n"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js_code], capture_output=True, text=True, check=True)
    assert "JSON.parse(" in p.stdout and "__proto__" in p.stdout


def test_cmd_run_confirmation_updates_all_failing_tests_in_confirmed_package(tmp_path, monkeypatch):
    hdir = tmp_path / "h_conf"
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg1/a_test.go", "content": ""}]})
    monkeypatch.setattr(run, "require_disk", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "target_dirs_for", lambda *a, **k: None)
    monkeypatch.setattr(run, "suite_for", lambda *a, **k: run.Suite(go_patterns={"pkg1": "^TestHunt"}))

    # 1: full fails A,B; 2: filtered passes A, fails B; 3: full confirmation fails A, passes B; 4+: filtered/full reruns
    seq = iter([
        run.Outcome(results={"pkg1::TestHuntA_1": "FAIL", "pkg1::TestHuntA_2": "FAIL"}),
        run.Outcome(results={"pkg1::TestHuntA_1": "PASS", "pkg1::TestHuntA_2": "FAIL"}),
        run.Outcome(results={"pkg1::TestHuntA_1": "FAIL", "pkg1::TestHuntA_2": "PASS"}),
        run.Outcome(results={"pkg1::TestHuntA_1": "FAIL"}),
    ])
    monkeypatch.setattr(run, "run_suite", lambda *a, **k: next(seq))
    table = run.cmd_run(hdir, {"wt": str(tmp_path)}, "A", runs=3)
    assert table == {"pkg1::TestHuntA_1": Verdict.FAIL_3_OF_3, "pkg1::TestHuntA_2": Verdict.FLAKY}


def test_go_repair_merges_helper_errors_and_cmd_base_keeps_full_diagnostics(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module m\n\ngo 1.21\n")
    test_file = wt / "pkg" / "hunt_a_test.go"
    test_file.write_text(
        "package pkg\n"
        "func helper() { _ = 1 + \"bad\" }\n"
        "func TestHuntA_Mixed() {\n"
        "    helper()\n"
        "    _ = NewHeadFn()\n"
        "}\n"
    )
    monkeypatch.setattr(run, "go_build_errors", lambda *a, **k: (
        "pkg/hunt_a_test.go:2:25: invalid operation: 1 + \"bad\"\n"
        "pkg/hunt_a_test.go:5:9: undefined: NewHeadFn\n"
    ))
    raw_errs: dict[str, str] = {}
    removed, cut = run.go_repair(wt, [test_file], "pkg", raw_errs=raw_errs) or ({}, False)
    assert cut and "pkg::TestHuntA_Mixed" in removed
    assert "invalid operation" in raw_errs["pkg::TestHuntA_Mixed"]
    assert "undefined: NewHeadFn" in raw_errs["pkg::TestHuntA_Mixed"]

    # cmd_base retains diagnostics > 6000 chars in base_A.errors.json
    hdir = tmp_path / "h_long"
    head_wt = tmp_path / "head"
    (head_wt / "pkg").mkdir(parents=True)
    (head_wt / "pkg" / "x.go").write_text("package pkg\n")
    write_json(hdir / "run_A.json", {"pkg::TestHuntA_1": Verdict.FAIL_3_OF_3})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg/hunt_a_test.go", "content": ""}]})
    (hdir / "run_A.response.sha256").write_text(run.fingerprint([{"path": "pkg/hunt_a_test.go", "content": ""}]))
    long_err = "HEAD_DIAG_START " + ("x" * 6500) + " TAIL_DIAG"
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "require_disk", lambda *a, **k: None)
    monkeypatch.setattr(run, "target_dirs_for", lambda *a, **k: None)
    monkeypatch.setattr(run, "place", lambda *a, **k: [wt / "pkg" / "hunt_a_test.go"])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "salvage_go", lambda *a, **k: (_ for _ in ()).throw(run.CompileError(long_err)))
    out = run.cmd_base(hdir, {"wt": str(head_wt), "wt_base": str(wt)}, "A")
    assert out["pkg::TestHuntA_1"] == Verdict.BASE_UNCOMPILABLE
    ev = json.loads((hdir / "base_A.errors.json").read_text())["pkg"]
    assert len(ev) > 6000 and ev.startswith("HEAD_DIAG_START")


def test_go_pr_added_names_single_import_and_local_receiver(tmp_path):
    wt_head = tmp_path / "head"
    wt_base = tmp_path / "base"
    for side in (wt_head, wt_base):
        (side / "config").mkdir(parents=True)
        (side / "a").mkdir(parents=True)
        (side / "b").mkdir(parents=True)
        (side / "go.mod").write_text("module m\n\ngo 1.21\n")
        (side / "config" / "cfg.go").write_text("package config\nfunc Existing() {}\n")
        (side / "b" / "svc.go").write_text("package b\ntype Svc struct{}\nfunc (*Svc) NewMethod() {}\n")
        (side / "a" / "svc.go").write_text("package a\ntype Svc struct{}\n")
    (wt_head / "config" / "cfg.go").write_text("package config\nfunc Existing() {}\nfunc NewOpt() {}\n")
    (wt_head / "a" / "svc.go").write_text("package a\ntype Svc struct{}\nfunc (*Svc) NewMethod() {}\n")
    (wt_head / "a" / "hunt_test.go").write_text('package a\nimport cfg "m/config"\nfunc f() { cfg.NewOpt() }\n')

    assert run.go_pr_added_names(wt_head, "a/hunt_test.go:3:12: undefined: cfg.NewOpt", pkg_dir="a", wt_base=wt_base) == ["NewOpt"]
    assert run.go_pr_added_names(wt_head, "a/hunt_test.go:4:1: x.NewMethod undefined (type *Svc has no field or method NewMethod)", pkg_dir="a", wt_base=wt_base) == ["NewMethod"]


def test_diff_unit_pass_base2_isolates_infra_error_per_unit(tmp_path, monkeypatch):
    def fake_salvage(wt, state, tag, u_placed, **kwargs):
        if "u2" in str(u_placed[0]):
            raise run.InfraError("0 tests executed")
        return run.Outcome(results={"u1::TestHuntD_1": "PASS"}), {}

    monkeypatch.setattr(run, "salvage_go", fake_salvage)
    out, _, errs, _, _ = run._diff_unit_pass(
        tmp_path, {}, "D", [("u1", [tmp_path / "u1.go"]), ("u2", [tmp_path / "u2.go"])], tmp_path, "base2", base=True)
    assert out.results == {"u1::TestHuntD_1": "PASS"} and errs == {"u2": "0 tests executed"}


def test_ledger_flags_stale_verdict_when_new_candidate_added(tmp_path):
    hdir = tmp_path / "h_stale"
    write_json(hdir / "run_A.json", {"pkg::Test1": Verdict.PASS})
    write_json(hdir / "base_B.json", {"pkg::Test2": Verdict.NEW_PR_BUG})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    tier, gaps = ledger._tier_and_gaps(hdir, {"mode_a_empty": 0}, 1, 1, 0, 1, 1, False, {})
    assert tier == "Partial or Unverified Coverage" and "unvetted findings" in gaps


def test_verify_ui_round5_plugins_capture_and_api_timeout(tmp_path):
    script_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "verify_ui.mjs"
    js_code = (
        f"import {{ freeze, validatePlan }} from {json.dumps(script_path.as_uri())};\n"
        "const plan = {\n"
        "  base_url: 'http://127.0.0.1:8065',\n"
        "  steps: [\n"
        "    { capture: { api: '/plugins/_demo/api/v1/status' } },\n"
        "    { capture: { api: '/plugins/-demo/api/v1/ok' } },\n"
        "  ],\n"
        "  expect: [{ api: { path: '/plugins/_demo/api/v1/status', status: 200 } }],\n"
        "};\n"
        "validatePlan(plan, 'http://127.0.0.1:8065');\n"
        "const bad = { base_url: 'http://127.0.0.1:8065', steps: [], expect: [{ api: { path: '/plugins/../api/v4/me' } }] };\n"
        "let badMsg = ''; try { validatePlan(bad, 'http://127.0.0.1:8065'); } catch (e) { badMsg = String(e); }\n"
        "const out = freeze(plan, 'http://127.0.0.1:8065');\n"
        "process.stdout.write(JSON.stringify({ badMsg, out }));\n"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js_code], capture_output=True, text=True, check=True)
    res = json.loads(p.stdout)
    assert "must be a path under" in res["badMsg"]
    out = res["out"]
    assert "const API_TIMEOUT = 30000;" in out
    assert "timeout: timeoutMs" in out
    assert "test.setTimeout(60000 + 3 * API_TIMEOUT);" in out
    assert "chromium" not in out
    assert "await settle();" not in out


def test_go_pr_added_names_root_package_stays_scoped_to_root(tmp_path):
    wt_head = tmp_path / "head"
    wt_base = tmp_path / "base"
    for side in (wt_head, wt_base):
        (side / "child").mkdir(parents=True)
        (side / "go.mod").write_text("module m\n\ngo 1.21\n")
        (side / "root.go").write_text("package m\nfunc ExistingRoot() {}\n")
        (side / "child" / "c.go").write_text("package child\nfunc OnlyInChild() {}\n")
    assert run.go_pr_added_names(
        wt_head, "hunt_test.go:3:2: undefined: OnlyInChild", pkg_dir="", wt_base=wt_base,
    ) is None


def test_go_repair_ignores_helper_name_in_comments_and_strings(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module m\n\ngo 1.21\n")
    f_bad = wt / "pkg" / "hunt_bad_test.go"
    f_bad.write_text('package pkg\nfunc badHelper() { _ = 1 + "x" }\nfunc TestHuntA_Bad() { badHelper() }\n')
    f_ok = wt / "pkg" / "hunt_ok_test.go"
    f_ok.write_text('package pkg\n// Mentions badHelper in comment and "badHelper" in string.\nfunc TestHuntA_Ok() { _ = "badHelper" }\n')
    monkeypatch.setattr(run, "go_build_errors", lambda *a, **k: 'pkg/hunt_bad_test.go:2:29: invalid operation: 1 + "x"\n')
    removed, cut = run.go_repair(wt, [f_bad, f_ok], "pkg") or ({}, False)
    assert cut and "pkg::TestHuntA_Bad" in removed and "pkg::TestHuntA_Ok" not in removed
    assert "func TestHuntA_Ok()" in f_ok.read_text()


def test_eval_bugs_cmd_fix_uses_full_pkgs_and_fix_diff_rejects_package_failure(tmp_path, monkeypatch):
    # 1. cmd_fix passes failing=None for units listed in run_<tag>.full_pkgs.json.
    hdir = tmp_path / "h_fix_fp"
    tid = "pkg1::TestHuntA_Polluted"
    write_json(hdir / "base_A.json", {tid: Verdict.NEW_PR_BUG})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg1/hunt_a_test.go", "content": ""}]})
    write_json(hdir / "run_A.full_pkgs.json", ["pkg1"])
    seen_failing: list[Any] = []
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "target_dirs_for", lambda *a, **k: None)
    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "salvage_go", lambda *a, failing=None, **k: (
        seen_failing.append(failing) or run.Outcome(results={tid: Verdict.PASS}), {}))
    out = eval_bugs.cmd_fix(hdir, {"targets": [{"dir": "pkg1"}]}, "A", tmp_path)
    assert out == {tid: Verdict.STRONG}
    assert seen_failing == [None, None, None]

    # 2. cmd_fix_diff rejects STRONG -> FIX_NOT_RUN when package teardown fails alongside recorder PASS.
    hd = tmp_path / "hd_pkgfail"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    rkey = (u, run.record_name(ident))
    write_json(hd / "diff_D.json", {ident: Verdict.DIFF})
    write_json(hd / "D" / "response.json", {"files": [{"path": path, "content": ""}]})
    monkeypatch.setattr(run, "_diff_unit_pass", lambda wt, st, t, un, td, stem, base=False: (
        run.Outcome(results={ident: Verdict.PASS, f"{u}::{run.PACKAGE_FAILED}": Verdict.FAIL} if stem == "fix2" else {ident: Verdict.PASS}),
        {rkey: {0: {"output": "same"}}}, {}, {}, []))
    assert eval_bugs.cmd_fix_diff(hd, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path) == {
        ident: Verdict.FIX_NOT_RUN}


def test_eval_bugs_vet_signal_uses_persisted_verdict_on_archived_batches(tmp_path):
    hc = tmp_path / "h_arch_verdict"
    tid = "pkg1::TestPersisted"
    row_keep = vetted_row(id=tid, source="A", decision="KEEP")
    row_held = {"row": row_keep, "reasons": ["lesson:false_positive"]}
    write_json(hc / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/a.go"]})
    write_json(hc / "batches" / "batch_1" / "run_A.json", {tid: "FAIL_3_OF_3"})
    write_json(hc / "batches" / "batch_1" / "base_A.json", {tid: "NEW_PR_BUG"})
    write_json(hc / "batches" / "batch_1" / "vetted.json", {"rows": [row_keep]})
    write_json(hc / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [], "held": [row_held]})
    write_json(hc / "state.json", {"batch": 2, "changed": ["pkg2/b.go"]})
    write_json(hc / "vetted.json", {"rows": []})
    vs = eval_bugs.vet_signal(hc)
    assert vs["admissibility"] == {"vetted_present": True, "keep": [], "held": 1}


def test_ledger_supersedes_same_finding_across_changed_sets_and_applies_driver_gaps(tmp_path):
    hdir = tmp_path / "h_overlap"
    tid = "pkg1::TestHuntB_Shared"
    keep_b1 = vetted_row(id=tid, source="B", decision="KEEP", file_line="pkg1/shared.go:10")
    drop_b2 = {"row": vetted_row(id=tid, source="B", decision="DROP", file_line="pkg1/shared.go:10"),
               "reasons": ["decision=DROP"]}
    write_json(hdir / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/a.go", "pkg1/shared.go"]})
    write_json(hdir / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [keep_b1], "held": []})
    write_json(hdir / "state.json", {"batch": 2, "changed": ["pkg1/b.go", "pkg1/shared.go"]})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_b2]})
    keep, held = ledger.resolved_verdicts(hdir)
    assert keep == [] and len(held) == 1

    # driver.json gap prevents High-Confidence Clean in ledger._tier_and_gaps.
    hgap = tmp_path / "h_drv_gap"
    write_json(hgap / "run_A.json", {"pkg::Test1": Verdict.PASS})
    write_json(hgap / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(hgap / "driver.json", {"gaps": {"vet": "vet truncated"}})
    tier, _ = ledger._tier_and_gaps(hgap, {"mode_a_empty": 0}, 1, 1, 0, 1, 1, False, {})
    assert tier == "Partial or Unverified Coverage"


def test_hunt_stage_v_splits_more_than_8_candidates_within_schema_limit(tmp_path, monkeypatch):
    hdir = tmp_path / "h_v_split"
    base_a = {f"pkg{i}::TestHuntA_{i}": Verdict.NEW_PR_BUG for i in range(10)}
    msgs_a = {f"pkg{i}::TestHuntA_{i}": f"fail {i}" for i in range(10)}
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg0/hunt_a_test.go", "content": "package pkg0\n"}]})
    write_json(hdir / "run_A.json", dict.fromkeys(base_a, Verdict.FAIL_3_OF_3))
    write_json(hdir / "base_A.json", base_a)
    write_json(hdir / "run_A.messages.json", msgs_a)
    write_json(hdir / "driver.json", {"gaps": {}, "escalations": []})

    dispatched: list[tuple[str, int]] = []
    ran: list[tuple[str, str]] = []

    def fake_dispatch(hd, tag, req, *, strict_schema=False, no_prompt_cache=None):
        doc = json.loads(req.read_text())
        user_obj = json.loads(doc["user"])
        dispatched.append((tag, len(user_obj["candidates"])))
        write_json(hd / tag / "response.json", {"files": [{"path": f"pkg/{tag.lower()}_test.go", "content": "package pkg\n"}]})
        return True, None, None

    def fake_script(name, *args):
        if name == "run.py" and len(args) >= 3 and args[0] in ("run", "base"):
            verb, _, vtag = args[:3]
            ran.append((verb, vtag))
            write_json(hdir / f"{verb}_{vtag}.json", {f"pkg::{vtag}": Verdict.FAIL_3_OF_3 if verb == "run" else Verdict.NEW_PR_BUG})
            if verb == "run":
                write_json(hdir / f"run_{vtag}.messages.json", {f"pkg::{vtag}": "diag fail"})
        return subprocess.CompletedProcess([name, *args], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "_call_dispatch", fake_dispatch)
    monkeypatch.setattr(hunt, "script", fake_script)
    hunt.stage_v("1", hdir, modes=("A",))
    assert dispatched == [("V", 8), ("V_2", 2)]
    assert ran == [("run", "V"), ("base", "V"), ("run", "V_2"), ("base", "V_2")]
    assert json.loads((hdir / "run_V.json").read_text()) == {
        "V:pkg::V": Verdict.FAIL_3_OF_3, "V_2:pkg::V_2": Verdict.FAIL_3_OF_3}
    assert json.loads((hdir / "base_V.json").read_text()) == {
        "V:pkg::V": Verdict.NEW_PR_BUG, "V_2:pkg::V_2": Verdict.NEW_PR_BUG}
    assert hunt.v_done(hdir, modes=("A",))


def test_ledger_and_eval_reconcile_located_and_locationless_decisions(tmp_path, monkeypatch):
    # 1. Locationless HELD in batch_1 is replaced by located DROP in batch_2 with same changed files.
    hdir = tmp_path / "h_loc_replace"
    tid = "pkg1::TestHuntB_Reconcile"
    held_b1 = {"row": vetted_row(id=tid, source="B", decision="HELD", file_line=""), "reasons": ["omitted"]}
    drop_b2 = {"row": vetted_row(id=tid, source="B", decision="DROP", file_line="pkg1/foo.go:10"), "reasons": ["decision=DROP"]}
    write_json(hdir / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/foo.go"]})
    write_json(hdir / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [], "held": [held_b1]})
    write_json(hdir / "state.json", {"batch": 2, "changed": ["pkg1/foo.go"]})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_b2]})
    keep, held = ledger.resolved_verdicts(hdir)
    assert keep == [] and len(held) == 1
    assert held[0]["row"]["decision"] == Verdict.DROP
    tier, _ = ledger._tier_and_gaps(hdir, {"mode_a_empty": 0}, 1, 1, 0, 2, 2, False, {})
    assert tier == "High-Confidence Clean"

    # 2. vet_signal clears earlier located KEEP when later batch records locationless HELD on overlapping file.
    h_vet = tmp_path / "h_vet_reconcile"
    keep_b1 = vetted_row(id=tid, source="B", decision="KEEP", file_line="pkg1/foo.go:10")
    held_b2 = {"row": vetted_row(id=tid, source="B", decision="HELD", file_line=""), "reasons": ["omitted"]}
    write_json(h_vet / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/foo.go"]})
    write_json(h_vet / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [keep_b1], "held": []})
    write_json(h_vet / "state.json", {"batch": 2, "changed": ["pkg1/foo.go", "pkg1/bar.go"]})
    write_json(h_vet / "verdict.json", {"vetted_present": True, "keep": [], "held": [held_b2]})
    assert eval_bugs.vet_signal(h_vet)["admissibility"] == {"vetted_present": True, "keep": [], "held": 1}

    # 3. hunt_entry invokes vet_signal when only verdict.json is present (no vetted.json or batches/).
    repo = make_repo(tmp_path / "r_vonly", {"a.go": "package a\n"}, {"a.go": "package a\nfunc F() {}\n"})
    head_sha = _git(repo, "rev-parse", "feature")
    out_dir = tmp_path / "eval_out"
    resp_dir = tmp_path / "resp_verdict_only"
    write_json(resp_dir / "verdict.json", {"vetted_present": True, "keep": [vetted_row(id="a::TestFP", source="A", decision="KEEP")], "held": []})
    monkeypatch.setattr(eval_bugs.prepare, "worktrees", lambda *a, **k: _git(repo, "rev-parse", "master"))
    monkeypatch.setattr(eval_bugs.prepare, "deps", lambda *a, **k: (False, False))
    monkeypatch.setattr(eval_bugs.ctx, "build", lambda *a, **k: {"batches": 1, "targets": []})
    res = eval_bugs.hunt_entry({"id": "c1", "repo": repo, "head": head_sha, "responses": str(resp_dir)}, 1, out_dir, None, signals=("hunters",))
    assert any(r.get("hunter") == "V" and r.get("admissibility", {}).get("keep") == ["a::TestFP"] for r in res["results"])


def test_ledger_flags_old_test_uncompilable_and_hunt_misc_round8_fixes(tmp_path, monkeypatch):
    # 1. OLD_TEST_UNCOMPILABLE in old_tests.json -> Partial or Unverified Coverage.
    h_old = tmp_path / "h_old_uncomp"
    write_json(h_old / "run_A.json", {"pkg::Test1": Verdict.PASS})
    write_json(h_old / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(h_old / "old_tests.json", {"tests": {"pkg::TestOld": Verdict.OLD_TEST_UNCOMPILABLE}})
    tier, _ = ledger._tier_and_gaps(h_old, {"mode_a_empty": 0}, 1, 1, 0, 1, 1, False, {})
    assert tier == "Partial or Unverified Coverage"

    # 2. _add_diff_hunk_lines ignores added '+++ b/' inside hunk body.
    valid: dict[str, set[int]] = {}
    hunt._add_diff_hunk_lines(
        "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,1 +1,3 @@\n context\n++++ b/fake.go\n+real\n",
        valid,
    )
    assert "fake.go" not in valid and valid["a.go"] == {1, 2, 3}

    # 3. Jest repro_cmd escapes regex metacharacters.
    h_repro = tmp_path / "h_repro"
    wt_r = tmp_path / "wt_r"
    (wt_r / "webapp" / "channels" / "src").mkdir(parents=True)
    (wt_r / "webapp" / "channels" / "jest.config.js").write_text("module.exports = {};\n")
    write_json(h_repro / "state.json", {"wt": str(wt_r)})
    cmd = hunt.repro_cmd(h_repro, "webapp/channels/src/a.test.tsx::handles (empty)")
    assert r"handles \(empty\)" in cmd

    # 4. R-only hunt with R/threads.json and no qualifying request counts as dispatched and complete.
    h_ronly = tmp_path / "h_ronly"
    write_json(h_ronly / "R" / "threads.json", {"included": [], "dropped": []})
    write_json(h_ronly / "driver.json", {"gaps": {"dispatch:B": "old"}, "modes": ["R"]})
    write_json(h_ronly / "state.json", {"batch": 1, "batches": 1, "all_batches": True})
    write_json(h_ronly / "old_tests.json", {"tests": {}})
    write_json(h_ronly / "pr_tests.json", {"tests": {}})
    write_json(h_ronly / "vetted.json", {"rows": []})
    write_json(h_ronly / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(h_ronly / "findings.json", [])
    (h_ronly / "audit.md").write_text("ok\n")
    assert hunt.dispatched(h_ronly, ("R",)) is True
    assert hunt._hunt_complete(h_ronly, ("R",)) is True

    # 5. dispatch budget_check skips retry attempt once spend hits HUNT_BUDGET_USD.
    import telemetry
    h_bud = tmp_path / "h_bud"
    req_b = h_bud / "A" / "request.json"
    write_json(req_b, {"tier": "sonnet", "system": "s", "user": "{}", "schema": {"type": "object"},
                       "response_path": str(h_bud / "A" / "response.json")})
    monkeypatch.setenv("HUNT_BUDGET_USD", "1.0")
    attempts = 0
    retry_cmd = _fake(tmp_path, "flaky_bud.py", "import sys\nprint('503', file=sys.stderr)\nsys.exit(1)\n")

    def fake_budget_check():
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            telemetry.record(h_bud, "dispatch", tag="other", cost_usd=1.2)
        return hunt.over_budget(h_bud)

    monkeypatch.setenv("HUNT_DISPATCH_CMD", retry_cmd)
    res_b = dispatch.dispatch(req_b, hdir=h_bud, tag="A", sleep=lambda _s: None, budget_check=fake_budget_check)
    assert res_b.status == "budget_skipped" and res_b.retries == 1


def test_hunt_stage_v_and_stage_vet_round8_resumption_and_chunk_validation(tmp_path, monkeypatch):
    # 1. Mode V candidate expansion invalidates old V outputs, and dispatch:V_2 does not mark v_done True.
    hdir = tmp_path / "h_v_inv"
    base_a = {f"pkg{i}::TestHuntA_{i}": Verdict.NEW_PR_BUG for i in range(9)}
    write_json(hdir / "A" / "response.json", {"files": [{"path": "pkg0/a_test.go", "content": "package pkg0\n"}]})
    write_json(hdir / "B" / "response.json", {"files": [{"path": "pkg9/b_test.go", "content": "package pkg9\n"}]})
    write_json(hdir / "run_A.json", dict.fromkeys(base_a, Verdict.FAIL_3_OF_3))
    write_json(hdir / "base_A.json", base_a)
    write_json(hdir / "run_A.messages.json", dict.fromkeys(base_a, "fail"))
    write_json(hdir / "driver.json", {"gaps": {}, "escalations": []})

    fail_v2 = True

    def fake_dispatch_v(hd, tag, req, *, strict_schema=False, no_prompt_cache=None):
        if tag == "V_2" and fail_v2:
            hunt.set_gap(hd, "dispatch:V_2", "transient fail")
            return False, None, None
        hunt.set_gap(hd, f"dispatch:{tag}", None)
        write_json(hd / tag / "response.json", {"files": [{"path": f"pkg/{tag.lower()}.go", "content": "package pkg\n"}]})
        return True, None, None

    def fake_script_v(name, *args):
        if name == "run.py" and len(args) >= 3 and args[0] in ("run", "base"):
            verb, _, vtag = args[:3]
            write_json(hdir / f"{verb}_{vtag}.json", {f"pkg::{vtag}": Verdict.FAIL_3_OF_3 if verb == "run" else Verdict.NEW_PR_BUG})
        return subprocess.CompletedProcess([name, *args], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "_call_dispatch", fake_dispatch_v)
    monkeypatch.setattr(hunt, "script", fake_script_v)
    hunt.stage_v("1", hdir, modes=("A",))
    assert hunt.v_done(hdir, modes=("A",)) is False  # dispatch:V_2 must be retried on resume
    fail_v2 = False
    hunt.stage_v("1", hdir, modes=("A",))
    assert hunt.v_done(hdir, modes=("A",)) is True
    # Expanding to B adds a candidate -> v_done becomes False until rebuilt.
    write_json(hdir / "run_B.json", {"pkg9::TestHuntB_0": Verdict.FAIL_3_OF_3})
    write_json(hdir / "base_B.json", {"pkg9::TestHuntB_0": Verdict.NEW_PR_BUG})
    write_json(hdir / "run_B.messages.json", {"pkg9::TestHuntB_0": "fail"})
    assert hunt.v_done(hdir, modes=("A", "B")) is False

    # 2. stage_vet ignores chunk-1 row answering a chunk-2 candidate, holding the omitted chunk-2 candidate.
    hvet = tmp_path / "h_vet_chunks"
    wt_v = tmp_path / "wt_v"
    wt_v.mkdir()
    write_json(hvet / "state.json", {"wt": str(wt_v), "pr": "1"})
    write_json(hvet / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "", "callers": []})
    base_items = {f"pkg{i}::TestHuntA_{i}": Verdict.NEW_PR_BUG for i in range(31)}
    write_json(hvet / "A" / "response.json", {"files": [{"path": "pkg0/a_test.go", "content": "package pkg0\n"}]})
    write_json(hvet / "run_A.json", dict.fromkeys(base_items, Verdict.FAIL_3_OF_3))
    write_json(hvet / "base_A.json", base_items)
    write_json(hvet / "run_A.messages.json", dict.fromkeys(base_items, "fail"))

    def fake_dispatch_vet(hd, sub, req, *, strict_schema=False, no_prompt_cache=None):
        doc = json.loads(req.read_text())
        cands = json.loads(doc["user"])["candidates"]
        if sub == "vet":
            # Smuggle candidate #30 (from vet_2) inside chunk 1's response.
            rows = [vetted_row(id=c["id"], source="A", decision="DROP", reason_code="WRONG_ASSERTION",
                               evidence_quote="pkg0") for c in cands]
            rows.append(vetted_row(id="pkg30::TestHuntA_30", source="A", decision="KEEP"))
            write_json(hd / sub / "response.json", {"rows": rows})
        else:
            # Chunk 2 omits pkg30::TestHuntA_30.
            write_json(hd / sub / "response.json", {"rows": []})
        return True, None, None

    monkeypatch.setattr(hunt, "_call_dispatch", fake_dispatch_vet)
    hunt.stage_vet(hvet, modes=("A",))
    vetted = json.loads((hvet / "vetted.json").read_text())["rows"]
    row_30 = next(r for r in vetted if r["id"] == "pkg30::TestHuntA_30")
    assert row_30["decision"] == Verdict.HELD

    # 3. Resuming an interrupted --first-batch hunt without --first-batch flips all_batches=True.
    h_fb = tmp_path / "h_fb"
    write_json(h_fb / "state.json", {"batch": 1, "batches": 3, "all_batches": False, "modes": ["A"]})
    hunt._sync_modes_in_state(h_fb, ("A",), first_batch=False)
    assert json.loads((h_fb / "state.json").read_text())["all_batches"] is True


def test_ctx_round9_jsx_testmain_raw_string_and_source_view_centering(tmp_path):
    # 1. .jsx included in CALLER_INCLUDES; TestMain recognized in GO_SETUP_DECL.
    assert "--include=*.jsx" in ctx.CALLER_INCLUDES
    assert ctx.GO_SETUP_DECL.search("func TestMain(m *testing.M) {\n}\n")
    assert not ctx.GO_SETUP_DECL.search("func TestOrdinary(t *testing.T) {\n}\n")

    # 2. top_blocks ignores column-1 func inside Go multiline raw string.
    src = (
        "package pkg\n"
        "func TestHuntA_Raw() {\n"
        "\ts := `\n"
        "func fixture() {}\n"
        "`\n"
        "\t_ = s\n"
        "}\n"
    )
    blocks = ctx.top_blocks(src.split("\n"), "go")
    assert blocks == [("TestHuntA_Raw", 2, 7)]

    # 3. source_view keeps changed line visible when span budget < 41 lines.
    wt = tmp_path / "wt_sv"
    (wt / "pkg").mkdir(parents=True)
    big = "\n".join(f"func f{i}() {{}}" if i != 200 else "func changedTarget() {}" for i in range(1, 260))
    (wt / "pkg" / "big.go").write_text(big)
    patch = "@@ -200,1 +200,1 @@\n-func old() {}\n+func changedTarget() {}\n"
    view = ctx.source_view(wt, "pkg/big.go", patch, max_lines=30)
    assert "changedTarget" in view


def test_hunt_round9_quoted_jest_paths_hunk_marker_vet_invalidation_and_partial(tmp_path, monkeypatch):
    # 1. _add_diff_hunk_lines ignores [patch cut: ...] marker inside hunk.
    valid: dict[str, set[int]] = {}
    hunt._add_diff_hunk_lines(
        "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -10,1 +10,2 @@\n+added\n[patch cut: 50 more lines not shown]\n",
        valid,
    )
    assert valid["a.go"] == {10}

    # 2. Jest repro_cmd quotes paths containing spaces.
    h_sp = tmp_path / "h_sp"
    wt_sp = tmp_path / "wt_sp"
    (wt_sp / "web app" / "src").mkdir(parents=True)
    (wt_sp / "web app" / "jest.config.js").write_text("module.exports = {};\n")
    write_json(h_sp / "state.json", {"wt": str(wt_sp)})
    cmd = hunt.repro_cmd(h_sp, "web app/src/a test.tsx::my test")
    assert cmd == "cd 'web app' && npx jest 'src/a test.tsx' -t 'my test'"

    # 3. stage_vet publishes partial chunk results while vet_done stays False until resumed; Mode V update invalidates vet_done.
    hvet = tmp_path / "h_vet_p"
    wt_v = tmp_path / "wt_v"
    wt_v.mkdir()
    write_json(hvet / "state.json", {"wt": str(wt_v), "pr": "1"})
    write_json(hvet / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "", "callers": []})
    base_items = {f"pkg{i}::TestHuntA_{i}": Verdict.NEW_PR_BUG for i in range(31)}
    write_json(hvet / "A" / "response.json", {"files": [{"path": "pkg0/a_test.go", "content": "package pkg0\n"}]})
    write_json(hvet / "run_A.json", dict.fromkeys(base_items, Verdict.FAIL_3_OF_3))
    write_json(hvet / "base_A.json", base_items)
    write_json(hvet / "run_A.messages.json", dict.fromkeys(base_items, "fail"))

    fail_chunk2 = True

    def fake_dispatch_vet(hd, sub, req, *, strict_schema=False, no_prompt_cache=None):
        cands = json.loads(json.loads(req.read_text())["user"])["candidates"]
        if sub == "vet_2" and fail_chunk2:
            hunt.set_gap(hd, "budget", "limit")
            return False, None, None
        rows = [vetted_row(id=c["id"], source="A", decision="DROP", reason_code="WRONG_ASSERTION",
                           evidence_quote="pkg0") for c in cands]
        write_json(hd / sub / "response.json", {"rows": rows})
        return True, None, None

    monkeypatch.setattr(hunt, "_call_dispatch", fake_dispatch_vet)
    hunt.stage_vet(hvet, modes=("A",))
    assert (hvet / "vet.partial").is_file()
    partial_rows = json.loads((hvet / "vetted.json").read_text())["rows"]
    assert len(partial_rows) == 30
    assert hunt.vet_done(hvet, modes=("A",)) is False

    fail_chunk2 = False
    hunt.stage_vet(hvet, modes=("A",))
    assert not (hvet / "vet.partial").is_file()
    assert len(json.loads((hvet / "vetted.json").read_text())["rows"]) == 31
    assert hunt.vet_done(hvet, modes=("A",)) is True

    # Completing Mode V after initial vetting invalidates vet_done.
    v_sha = hunt._v_cand_digest(hvet, hunt.candidates_ab(hvet, ("A",)), ("A",))
    (hvet / "V.candidates.sha256").write_text(v_sha)
    (hvet / "V.aggregate.sha256").write_text(v_sha)
    for vt, _ in hunt._v_chunks(hunt.candidates_ab(hvet, ("A",))):
        write_json(hvet / vt / "run.json", {"pkg0::TestHuntV_0": Verdict.PASS})
    write_json(hvet / "run_V.json", {"pkg0::TestHuntV_0": Verdict.FAIL_3_OF_3})
    write_json(hvet / "base_V.json", {"pkg0::TestHuntV_0": Verdict.NEW_PR_BUG})
    assert hunt.vet_done(hvet, modes=("A",)) is False


def test_ledger_locationless_held_does_not_drop_unrelated_batch_context_keep(tmp_path):
    # batch_1 changed=["pkg1/a.go"] has KEEP at file_line="pkg1/ctx_callee.go:10" (caller context).
    # batch_2 changed=["pkg1/ctx_callee.go"] emits locationless HELD for same test id -> must NOT drop batch_1's KEEP.
    hdir = tmp_path / "h_ctx_keep"
    tid = "pkg1::TestHuntB_Shared"
    keep_b1 = vetted_row(id=tid, source="B", decision="KEEP", file_line="pkg1/ctx_callee.go:10")
    held_b2 = {"row": vetted_row(id=tid, source="B", decision="HELD", file_line=""), "reasons": ["omitted"]}
    write_json(hdir / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/a.go"]})
    write_json(hdir / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [keep_b1], "held": []})
    write_json(hdir / "state.json", {"batch": 2, "changed": ["pkg1/ctx_callee.go"]})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [held_b2]})
    keep, held = ledger.resolved_verdicts(hdir)
    assert len(keep) == 1 and keep[0]["file_line"] == "pkg1/ctx_callee.go:10"
    assert len(held) == 1


def test_verify_ui_compare_all_diffs_prints_beyond_200(tmp_path):
    script_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "verify_ui.mjs"
    js_code = (
        f"import {{ diffRuns }} from {json.dumps(script_path.as_uri())};\n"
        "const base = { captures: [Object.fromEntries(Array.from({length: 205}, (_, i) => [`k${i}`, i]))], snapshots: [], expects: [], problems: [] };\n"
        "const head = { captures: [Object.fromEntries(Array.from({length: 205}, (_, i) => [`k${i}`, i + 1]))], snapshots: [], expects: [], problems: [] };\n"
        "const diffs = diffRuns({captures: [{step: 1, status: 200, json: base.captures[0]}], snapshots: [], expects: [], problems: []}, "
        "{captures: [{step: 1, status: 200, json: head.captures[0]}], snapshots: [], expects: [], problems: []}, ['http://127.0.0.1:8065', 'http://127.0.0.1:8065'], []);\n"
        "process.stdout.write(String(diffs.length));\n"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js_code], capture_output=True, text=True, check=True)
    assert int(p.stdout) == 205
    bad = subprocess.run(["node", str(script_path), "--all-diffs", str(tmp_path / "missing.json")],
                         capture_output=True, text=True, check=False)
    assert bad.returncode == 2 and "--all-diffs requires --compare" in bad.stdout


def test_round10_ctx_multiline_go_test_and_verdicts_doc():
    import verdicts
    assert "compile or load" in verdicts.MEANINGS[verdicts.Verdict.NEW_API].text
    head_src = "package p\nfunc TestMultiline(\n\tt *testing.T,\n) {\n\tt.Log(1)\n}\n"
    patch = "@@ -5,1 +5,1 @@\n-\tt.Log(0)\n+\tt.Log(1)\n"
    assert ctx.changed_go_tests(patch, head_src) == ["TestMultiline"]


def test_round10_dispatch_isolation_telemetry_and_in_slot_budget(tmp_path, monkeypatch):
    import telemetry
    hdir = tmp_path / "h_d_iso"
    req = hdir / "A" / "request.json"
    resp = hdir / "A" / "response.json"
    write_json(req, {"tier": "sonnet", "system": "s", "user": "{}", "schema": {"type": "object"},
                     "response_path": str(resp)})
    # Attempt 1 writes response then exits 503 with cost $0.20; Attempt 2 exits 0 without writing -> rejected!
    count_f = tmp_path / "cnt"
    cmd = _fake(tmp_path, "stale_resp.py", f"""
import json, pathlib, sys
c = pathlib.Path({str(count_f)!r})
n = int(c.read_text()) + 1 if c.exists() else 1
c.write_text(str(n))
req = json.loads(pathlib.Path(sys.argv[1]).read_text())
if n == 1:
    pathlib.Path(req["response_path"]).write_text('{{"stale": true}}')
    print(json.dumps({{"is_error": True, "result": "503", "total_cost_usd": 0.2}}))
    sys.exit(1)
sys.exit(0)
""")
    with pytest.raises(dispatch.DispatchError, match="wrote no response"):
        dispatch.dispatch(req, cmd=cmd, hdir=hdir, tag="A", sleep=lambda _s: None)
    assert not resp.exists()
    assert telemetry.summarize(hdir)["total_cost_usd"] == pytest.approx(0.2)

    # Attempt 1 transient cost ($0.20) + existing $7.90 >= $8.00 triggers budget_skipped inside retry!
    h_b = tmp_path / "h_d_bud"
    telemetry.record(h_b, "dispatch", tag="prev", cost_usd=7.9)
    req_b = h_b / "A" / "request.json"
    write_json(req_b, {"tier": "sonnet", "system": "s", "user": "{}", "schema": {"type": "object"},
                       "response_path": str(h_b / "A" / "response.json")})
    cmd_b = _fake(tmp_path, "cost_retry.py", """
import json, sys
print(json.dumps({"is_error": True, "result": "503", "total_cost_usd": 0.2}))
sys.exit(1)
""")
    monkeypatch.setenv("HUNT_BUDGET_USD", "8.0")
    res = dispatch.dispatch(req_b, cmd=cmd_b, hdir=h_b, tag="A", sleep=lambda _s: None,
                            budget_check=lambda: hunt.over_budget(h_b))
    assert res.status == "budget_skipped" and res.retries == 1
    assert telemetry.summarize(h_b)["total_cost_usd"] == pytest.approx(8.1)


def test_round10_hunt_mode_v_payload_key_citations_and_invalid_vet_stamp(tmp_path, monkeypatch):
    # 1. _extract_valid_lines rejects unshown lines inside range "100-300" when source shows only 100-101.
    h_cit = tmp_path / "h_cit"
    req_cit = h_cit / "A" / "request.json"
    write_json(req_cit, {"user": {"neighbors_same_file": [{"file": "a.go", "lines": "100-300", "source": "  100  a\n  101  b"}]}})
    valid = hunt._extract_valid_lines(req_cit)
    assert valid["a.go"] == {100, 101}

    # 2. Mode V cache key includes head_failure + test_source payload.
    hv = tmp_path / "h_v_pay"
    write_json(hv / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "func TestHuntA_1(){}"}]})
    write_json(hv / "run_A.json", {"pkg::TestHuntA_1": Verdict.FAIL_3_OF_3})
    write_json(hv / "base_A.json", {"pkg::TestHuntA_1": Verdict.NEW_PR_BUG})
    write_json(hv / "run_A.messages.json", {"pkg::TestHuntA_1": "fail v1"})
    write_json(hv / "run_V.json", {"pkg::TestHuntV_1": Verdict.PASS})
    (hv / "V.candidates.sha256").write_text(hunt._v_cand_digest(hv, hunt.candidates_ab(hv, ("A",)), ("A",)))
    assert hunt.v_done(hv, ("A",)) is True
    write_json(hv / "run_A.messages.json", {"pkg::TestHuntA_1": "fail v2"})
    assert hunt.v_done(hv, ("A",)) is False

    # 3. Invalidating bad skeptic chunk unlinks .dispatched stamp.
    hvet = tmp_path / "h_bad_vet"
    (hvet / "vet").mkdir(parents=True)
    wt = tmp_path / "wt"
    wt.mkdir()
    write_json(hvet / "state.json", {"wt": str(wt), "pr": "1"})
    write_json(hvet / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "", "callers": []})
    write_json(hvet / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": ""}]})
    write_json(hvet / "run_A.json", {"pkg::TestHuntA_1": Verdict.FAIL_3_OF_3})
    write_json(hvet / "base_A.json", {"pkg::TestHuntA_1": Verdict.NEW_PR_BUG})
    write_json(hvet / "run_A.messages.json", {"pkg::TestHuntA_1": "fail"})

    def bad_vet_dispatch(hd, sub, req, *, strict_schema=False, no_prompt_cache=None):
        write_json(hd / sub / "response.json", {"wrong": 1})
        dispatch.sidecar(req).write_text(dispatch.request_sha(req))
        return True, None, None

    monkeypatch.setattr(hunt, "_call_dispatch", bad_vet_dispatch)
    hunt.stage_vet(hvet, modes=("A",))
    assert not dispatch.sidecar(hvet / "vet" / "request.json").exists()


def test_round10_eval_unrounded_fp_and_ledger_vetted_present_false(tmp_path, monkeypatch):
    # 1. cmd_fix_diff requires original differing index in keep even when other indices differ (STRICTLY_WEAK vs FIX_NOT_RUN).
    hd = tmp_path / "hd_orig"
    path = "server/x/hunt_d_test.go"
    u = run._unit_key(path)
    ident = f"{u}::TestHuntD_X"
    rkey = (u, run.record_name(ident))
    write_json(hd / "diff_D.json", {ident: "DIFF"})
    write_json(hd / "diff_D.examples.json", {ident: {"examples": [{"i": 0, "input": 0, "base": 1, "head": 2}]}})
    write_json(hd / "D" / "response.json", {"files": [{"path": path, "content": ""}]})
    monkeypatch.setattr(run, "place", lambda *a, **k: [])
    monkeypatch.setattr(run, "unplace", lambda *a, **k: None)
    monkeypatch.setattr(run, "ensure_clean", lambda *a, **k: None)
    monkeypatch.setattr(run, "_diff_unit_pass", lambda wt, st, t, un, td, stem, base=False: (
        run.Outcome(results={ident: Verdict.PASS}),
        {rkey: {1: {"output": "f" if stem.startswith("fixb") else "h"}}}, {}, {}, []))
    assert eval_bugs.cmd_fix_diff(hd, {"wt_base": str(tmp_path / "b"), "targets": [{"dir": "server/x"}]}, tmp_path) == {
        ident: Verdict.FIX_NOT_RUN}

    # 2. Unrounded fp check fails 1/30 against fp_rate_max=0.0333 despite round(1/30, 4) == 0.0333.
    ctrls = [{"id": f"k{i}", "area": "a"} for i in range(30)]
    manifest = {"cases": [], "controls": ctrls, "thresholds": {"raw_recall_min": 0.0, "vetted_recall_min": 0.0, "fp_rate_max": 0.0333}}
    entries = {f"k{i}": {"results": [{"hunter": "D", "diff": {"t": "DIFF" if i == 0 else "SAME"}}]} for i in range(30)}
    card = eval_bugs.scorecard(manifest, entries, signals=("diff",))
    assert card["metrics"]["diff_fp_rate"] == 0.0333 and card["verdict"] == Verdict.FAIL
    assert eval_bugs.diff_scorecards(card, card, max_fp=0.0333)["verdict"] == Verdict.FAIL

    # 3. _batch_verdicts ignores leftover keep when vetted_present is False, and ledger locationless/located scope must match.
    hl = tmp_path / "h_unvet_keep"
    tid = "pkg1::TestHuntB_X"
    keep_row = vetted_row(id=tid, source="B", decision="KEEP", file_line="pkg1/a.go:10")
    write_json(hl / "batches" / "batch_1" / "verdict.json", {"vetted_present": False, "keep": [keep_row], "held": []})
    assert ledger.resolved_verdicts(hl)[0] == []

    hl2 = tmp_path / "h_diff_scope"
    locless_keep = vetted_row(id=tid, source="B", decision="KEEP", file_line="")
    located_drop = {"row": vetted_row(id=tid, source="B", decision="DROP", file_line="pkg1/a.go:12"), "reasons": ["decision=DROP"]}
    write_json(hl2 / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["pkg1/a.go"]})
    write_json(hl2 / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [locless_keep], "held": []})
    write_json(hl2 / "state.json", {"batch": 2, "changed": ["pkg1/b.go"]})
    write_json(hl2 / "verdict.json", {"vetted_present": True, "keep": [], "held": [located_drop]})
    keep, held = ledger.resolved_verdicts(hl2)
    assert len(keep) == 1 and len(held) == 1


# ------------------------------------------------------------------ Round 11 CodeRabbit --deep regressions


def test_round11_prefilter_and_ctx_edge_cases(tmp_path, monkeypatch):
    import prefilter

    # prefilter: feature_flag matches camelCase EnableFeatureFlag -> feature_flag (tier 5)
    ff_diff = prefilter.FileDiff("misc/flags.go", 2, 0, patch="@@ -1 +1 @@\n+func EnableFeatureFlag() {}\n")
    assert prefilter.risk(ff_diff) == 5

    # ctx.code_only / code_lines: /* Don't ... */ block comment never opens apostrophe string
    lines = ["/* Don't break", "   still comment */", "func TestMultiline( // note", "    t *testing.T,", ") {", "    t.Log(\"/* ok */\")", "}"]
    stripped = ctx.code_lines(lines, "go")
    assert stripped[0].strip() == "" and "still comment" not in stripped[1]
    assert stripped[2].startswith("func TestMultiline(")
    assert ctx.changed_go_tests("@@ -3,0 +3,1 @@\n+func TestMultiline(", "\n".join(lines)) == ["TestMultiline"]

    # ctx.source_view: multi-hunk truncation respects max_lines strictly (including separators + cut footer)
    f = tmp_path / "big.go"
    f.write_text("\n".join(f"// line {i}" for i in range(1, 301)) + "\n")
    patch = "@@ -10,2 +10,2 @@\n+a\n@@ -200,2 +200,2 @@\n+b\n"
    view = ctx.source_view(tmp_path, "big.go", patch, max_lines=20)
    assert len(view.splitlines()) <= 20
    assert "[source cut:" in view

    # ctx.build: empty batch plan with changed head clears whole-PR artifacts
    repo = make_repo(
        tmp_path / "r",
        {"go.mod": "module example.com/r\n\ngo 1.22\n", "a.go": "package r\nfunc A() {}\n"},
        {"a.go": "package r\nfunc A() int { return 1 }\n"},
    )
    _git(repo, "checkout", "-b", "empty_head", "master")
    (repo / "README.md").write_text("docs only\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "docs")
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir = hunt_dir("master..empty_head")
    prepare.prepare("master..empty_head")
    prep = load_json(hdir / "prepare.json")
    write_json(hdir / "state.json", {"pr": "master..empty_head", "head": "old_head", "batch": 1, "batches": 1})
    write_json(hdir / "review_verdicts.json", {"stale": True})
    st = ctx.build("master..empty_head", 1, prep, {})
    assert st["batches"] == 0 and st["skipped_diff"] is True
    assert not (hdir / "review_verdicts.json").exists()


def test_round11_run_repair_decl_base_full_pkgs_and_empty_diff(tmp_path, monkeypatch):
    # _COMPARE_RE: loopback address preserved outside test/log error context
    assert "127.0.0.1:8080" in run.normalize_for_compare("got 127.0.0.1:8080; want 127.0.0.1:80")
    assert "127.0.0.1:<port>" in run.normalize_for_compare("dial tcp 127.0.0.1:43210: connect: connection refused")

    # _has_go_decl: comma-separated var/const declarations
    assert run._has_go_decl("package p\nvar Existing, NewValue = 1, 2\n", "NewValue")

    # go_repair: local short-var shadow (`badHelper := ...`) is not pruned across sibling files
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module example.com/wt\n\ngo 1.22\n")
    (wt / "pkg" / "hunt_a_test.go").write_text(
        "package pkg\nimport \"testing\"\nfunc TestOne(t *testing.T) { x := badHelper(); _ = x }\n"
    )
    (wt / "pkg" / "hunt_b_test.go").write_text(
        "package pkg\nimport \"testing\"\nfunc TestTwo(t *testing.T) { badHelper := func() int { return 1 }; _ = badHelper() }\n"
    )
    test_file = wt / "pkg" / "hunt_a_test.go"
    sib_file = wt / "pkg" / "hunt_b_test.go"
    monkeypatch.setattr(
        run,
        "go_build_errors",
        lambda *a, **kw: f"{test_file}:3:36: undefined: badHelper\n" if "func TestOne" in test_file.read_text() else "",
    )
    res = run.go_repair(wt, [test_file, sib_file], "pkg")
    assert res is not None
    gone, removed = res
    assert removed is True
    assert "pkg::TestOne" in gone and "pkg::TestTwo" not in gone
    assert "badHelper := func()" in sib_file.read_text()

    # cmd_base: uses run_A.full_pkgs.json -> failing=None when package needed full-pkg confirmation
    repo = make_repo(
        tmp_path / "r2",
        {"go.mod": "module example.com/r2\n\ngo 1.22\n", "pkg/a.go": "package pkg\nfunc F() int { return 1 }\n"},
        {"pkg/a.go": "package pkg\nfunc F() int { return 2 }\n"},
    )
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    prepare.prepare("master..feature")
    prep2 = load_json(hunt_dir("master..feature") / "prepare.json")
    state = {"pr": "1", "repo": str(repo), "wt": prep2["wt"], "wt_base": prep2["wt_base"],
             "changed": ["pkg/a.go"], "targets": [{"dir": "pkg", "kind": "go"}]}
    hdir = tmp_path / "h_base"
    resp = {"files": [{"path": "pkg/hunt_hunta_test.go", "content": "package pkg\n"}]}
    write_json(hdir / "A" / "response.json", resp)
    (hdir / "run_A.response.sha256").write_text(run.fingerprint(resp["files"]))
    write_json(hdir / "run_A.json", {"pkg::TestX": run.Verdict.FAIL_3_OF_3})
    write_json(hdir / "run_A.full_pkgs.json", ["pkg"])
    seen_failing: list[object] = []
    monkeypatch.setattr(run, "salvage_go", lambda *a, **kw: (seen_failing.append(kw.get("failing")) or (run.Outcome(results={"pkg::TestX": run.Verdict.PASS}), {})))
    verdicts = run.cmd_base(hdir, state, "A")
    assert seen_failing == [None]
    assert verdicts["pkg::TestX"] == run.Verdict.NEW_PR_BUG

    # cmd_diff: empty files still clears stale downstream adjudication
    hdir_d = tmp_path / "h_diff"
    write_json(hdir_d / "D" / "response.json", {"files": []})
    write_json(hdir_d / "vetted.json", {"rows": [{"id": "x"}]})
    out_d = run.cmd_diff(hdir_d, state, "D")
    assert out_d == {} and not (hdir_d / "vetted.json").exists()


def test_round11_verify_ui_guards_and_error_regex(tmp_path):
    from conftest import VERIFY_UI, _node_env

    assert VERIFY_UI.exists()
    script = (
        f"import fs from 'node:fs';\n"
        f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
        "const m = src.match(/const NET_ERR_RE = ([^;]+);/);\n"
        "if (!m) throw new Error('missing NET_ERR_RE');\n"
        "const re = eval(m[1]);\n"
        "if (re.test('net::ERR_ABORTED')) throw new Error('ERR_ABORTED must not match');\n"
        "if (!re.test('net::ERR_CONNECTION_REFUSED')) throw new Error('ERR_CONNECTION_REFUSED must match');\n"
        "if (!src.includes('const frameOf = (r) =>')) throw new Error('missing frameOf guard');\n"
        "if (!src.includes('reqHost.cookies(reqUrl)')) throw new Error('missing reqUrl cookie scoping');\n"
    )
    js_path = tmp_path / "check_r11.mjs"
    js_path.write_text(script)
    p = subprocess.run(["node", str(js_path)], check=False, capture_output=True, text=True, env=_node_env())
    assert p.returncode == 0, p.stderr + p.stdout


def test_round12_zero_batch_eval_corrupt_state_and_parent_domain_csrf(tmp_path, monkeypatch):
    from conftest import VERIFY_UI, _node_env

    # 1. ctx.build treats corrupt/unreadable state.json as head_changed -> clears WHOLE_PR_STALE
    repo = make_repo(
        tmp_path / "r12",
        {"go.mod": "module example.com/r12\n\ngo 1.22\n", "a.go": "package r12\nfunc A() {}\n"},
        {"a.go": "package r12\nfunc A() int { return 1 }\n"},
    )
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    prepare.prepare("master..feature")
    hdir = hunt_dir("master..feature")
    prep = load_json(hdir / "prepare.json")
    (hdir / "state.json").write_text("{truncated")
    write_json(hdir / "old_tests.json", {"tests": {"stale": "OLD_TEST_BREAKS"}})
    ctx.build("master..feature", 1, prep, {"title": "t", "body": ""})
    assert not (hdir / "old_tests.json").exists()

    # 2. eval_bugs.hunt_entry skips hunters/diff dispatch & hunting when ctx.build reports batches == 0
    _git(repo, "checkout", "-b", "docs_only", "master")
    (repo / "README.md").write_text("docs only\n")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "docs")
    docs_sha = _git(repo, "rev-parse", "HEAD")
    out_dir = tmp_path / "eval_out"
    called_review: list[str] = []
    monkeypatch.setattr(eval_bugs.build_requests, "main", lambda *a, **k: pytest.fail("must not build requests on 0 batches"))
    monkeypatch.setattr(eval_bugs, "dispatch", lambda *a, **k: pytest.fail("must not dispatch hunters/diff on 0 batches"))
    monkeypatch.setattr(eval_bugs, "hunt_tag", lambda *a, **k: pytest.fail("must not hunt_tag on 0 batches"))
    monkeypatch.setattr(eval_bugs, "hunt_diff", lambda *a, **k: pytest.fail("must not hunt_diff on 0 batches"))
    monkeypatch.setattr(eval_bugs, "review_signal", lambda *a, **k: called_review.append("R") or {"hunter": "R", "review": {}})
    entry = {"id": "docs", "repo": str(repo), "head": docs_sha}
    res = eval_bugs.hunt_entry(entry, 1, out_dir, dispatch_cmd="fake", signals=("hunters", "diff", "review"))
    assert res == {"results": [{"hunter": "R", "review": {}}]} and called_review == ["R"]

    # 3. verify_ui.mjs sendApiRequest matches parent-domain CSRF cookies (.example.test) without matching badexample.test
    script = (
        f"import fs from 'node:fs';\n"
        f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
        "const m = src.match(/async function sendApiRequest\\([\\s\\S]*?\\n\\}/);\n"
        "if (!m) throw new Error('missing sendApiRequest');\n"
        "const fn = (new Function('return ' + m[0]))();\n"
        "let gotHeaders = null;\n"
        "const host = (cookies) => ({\n"
        "  storageState: async () => ({cookies}),\n"
        "  request: { fetch: async (_url, opts) => { gotHeaders = opts.headers; return {status: () => 200}; } },\n"
        "});\n"
        "await fn(host([{name: 'MMCSRF', value: 'tok1', domain: '.example.test', path: '/'}]), 'https://chat.example.test', 'POST', '/api/v4/x', {}, {}, 1024, 5000);\n"
        "if (gotHeaders['X-CSRF-Token'] !== 'tok1') throw new Error('parent-domain cookie missed');\n"
        "await fn(host([{name: 'MMCSRF', value: 'tok2', domain: '.example.test', path: '/'}]), 'https://badexample.test', 'POST', '/api/v4/x', {}, {}, 1024, 5000);\n"
        "if (gotHeaders['X-CSRF-Token'] !== undefined) throw new Error('suffix spoof matched');\n"
        "await fn(host([{name: 'MMCSRF', value: 'tok3', domain: 'example.test', path: '/'}]), 'https://chat.example.test', 'POST', '/api/v4/x', {}, {}, 1024, 5000);\n"
        "if (gotHeaders['X-CSRF-Token'] !== undefined) throw new Error('host-only cookie matched subdomain');\n"
    )
    js_path2 = tmp_path / "check_r12.mjs"
    js_path2.write_text(script)
    p2 = subprocess.run(["node", str(js_path2)], check=False, capture_output=True, text=True, env=_node_env())
    assert p2.returncode == 0, p2.stderr + p2.stdout


def test_round13_ctx_fallbacks_enclosing_sql_and_forced_batches(tmp_path, monkeypatch):
    # 1. sibling_tests picks jest_fallback for Jest target even when Go mocks_test.go is in same dir
    d = tmp_path / "mixed"
    d.mkdir()
    (d / "panel.tsx").write_text("export const Panel = () => null;\n")
    (d / "mocks_test.go").write_text("package mixed\nfunc NewMockServer() {}\n")
    (d / "other.test.tsx").write_text("test('ok', () => {});\n")
    sibs = ctx.sibling_tests(tmp_path, ["mixed/panel.tsx"], set())
    assert [s["file"] for s in sibs] == ["mixed/other.test.tsx"]

    # 2. enclosing_function ignores const object literal while keeping braced arrow functions
    obj_lines = ["const route = {", "  guard: HasPermissionToTeam(u, t),", "  key: ChangedSymbol,", "};"]
    assert ctx.enclosing_function(obj_lines, 3, "jest") is None
    fn_lines = ["const handler = (u: string) => {", "  return ChangedSymbol(u);", "};"]
    enc = ctx.enclosing_function(fn_lines, 2, "jest")
    assert enc is not None and enc[0] == "handler"

    # 3. test_targets skips //go:build ignore generator main package in SQL_TEST_DIR
    wt_sql = tmp_path / "wt_sql"
    sdir = wt_sql / ctx.SQL_TEST_DIR
    sdir.mkdir(parents=True)
    (sdir / "00_gen.go").write_text("//go:build ignore\npackage main\nfunc main() {}\n")
    assert ctx.test_targets(wt_sql, ["server/migrations/postgres/001.up.sql"]) == []
    (sdir / "store.go").write_text("package sqlstore\nfunc Store() {}\n")
    tgts = ctx.test_targets(wt_sql, ["server/migrations/postgres/001.up.sql"])
    assert len(tgts) == 1 and tgts[0]["package"] == "sqlstore"

    # 4. ctx.build preserves forced_all_batches across same-head batch 2 and clears on new head
    repo, hdir = _setup_two_batch(tmp_path, monkeypatch)
    monkeypatch.setattr(ctx, "forced_all_batches", lambda diffs, deleted: ["R01"])
    prepare.prepare("master..feature")
    prep = load_json(hdir / "prepare.json")
    st1 = ctx.build("master..feature", 1, prep, {"title": "r13", "body": ""}, first_batch=True)
    assert st1["forced_all_batches"] == ["R01"] and st1["all_batches"] is True
    monkeypatch.setattr(ctx, "forced_all_batches", lambda diffs, deleted: [])
    st2 = ctx.build("master..feature", 2, prep, {"title": "r13", "body": ""}, first_batch=False)
    assert st2["forced_all_batches"] == ["R01"] and st2["all_batches"] is True
    (repo / "pkg1" / "f1.go").write_text("package pkg1\nfunc F1(x int) int { return x + 42 }\n")
    _git(repo, "add", "pkg1/f1.go")
    _git(repo, "commit", "-qm", "new head")
    new_head = _git(repo, "rev-parse", "feature")
    prepare.worktrees(repo, "feature", "master", Path(prep["wt"]), Path(prep["wt_base"]))
    st_new = ctx.build("master..feature", 1, {**prep, "head": new_head}, {"title": "r13", "body": ""}, first_batch=True)
    assert st_new["forced_all_batches"] == [] and st_new["all_batches"] is False


def test_round13_hunt_partial_v_d_only_vet_and_terminal_batch_advance(tmp_path, monkeypatch):
    # 5. _batch_settled keeps any batch with active run/base/dispatch gaps current so resume can retry it.
    h_gap = tmp_path / "h_gap"
    write_json(h_gap / "state.json", {"pr": "1", "batch": 1, "batches": 2, "all_batches": True})
    hunt.set_gap(h_gap, "run:B", "B COMPILE_ERROR after one repair round")
    assert hunt._batch_settled(h_gap, ("B",), ()) is False
    hunt.set_gap(h_gap, "run:B", None)
    write_json(h_gap / "B" / "response.json", {"files": []})
    write_json(h_gap / "run_B.json", {})
    (h_gap / "run_B.response.sha256").write_text(run.fingerprint([]))
    assert hunt._batch_settled(h_gap, ("B",), ()) is True
    assert hunt._gap_for_active_modes("run:B:batch_1", ("B",)) is True

    # 6. stage_v records V.candidates.sha256 even on partial failure so candidate change invalidates completed chunk V
    hv = tmp_path / "h_partial_v"
    base_a = {f"pkg::Test{i}": "NEW_PR_BUG" for i in range(1, 11)}
    write_json(hv / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hv / "base_A.json", base_a)
    write_json(hv / "A" / "response.json", {"files": [{"path": "pkg/hunt_hunta_test.go", "content": "package pkg\n"}]})
    write_json(hv / "run_A.messages.json", {"pkg::Test1": "fail v1"})

    def fake_disp(hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        if tag == "V":
            write_json(hdir / "V" / "response.json", {"files": [{"path": "pkg/hunt_huntv_test.go", "content": "package pkg\n"}]})
            return True, dispatch.DispatchResult(status="ok"), None
        return False, dispatch.DispatchResult(status="error"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_disp)
    monkeypatch.setattr(hunt, "script", lambda *a: subprocess.CompletedProcess([], 0, stdout="", stderr=""))
    hunt.stage_v("1", hv, ("A",))
    assert (hv / "V.candidates.sha256").is_file()
    assert (hv / "V" / "response.json").is_file()
    assert hunt.v_done(hv, ("A",)) is False
    write_json(hv / "run_A.messages.json", {"pkg::Test1": "fail v2"})
    dispatched_v: list[str] = []

    def fake_disp2(hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        dispatched_v.append(tag)
        write_json(hdir / tag / "response.json", {"files": [{"path": "pkg/hunt_huntv_test.go", "content": "package pkg\n"}]})
        return True, dispatch.DispatchResult(status="ok"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_disp2)
    hunt.stage_v("1", hv, ("A",))
    assert dispatched_v == ["V", "V_2"]

    # 7. vet_done checks D-only examples + test_source via vet.v_inputs.sha256
    hd = tmp_path / "h_d_vet"
    write_json(hd / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hd / "ctx.json", {"pr": {"title": "t", "description": "d"}, "diff_production_code": "diff", "callers": []})
    write_json(hd / "diff_D.json", {"pkg::TestHuntD_X": "DIFF"})
    write_json(hd / "diff_D.examples.json", {"pkg::TestHuntD_X": {"examples": [{"k": 1, "head": "a", "base": "b"}]}})
    write_json(hd / "D" / "response.json", {"files": [{"path": "pkg/hunt_huntd_test.go", "content": "package pkg\n"}]})

    def fake_vet(hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        write_json(hdir / tag / "response.json", {"rows": [vetted_row(id="pkg::TestHuntD_X", source="D", decision="KEEP")]})
        return True, dispatch.DispatchResult(status="ok"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_vet)
    hunt.stage_vet(hd, ("D",))
    assert hunt.vet_done(hd, ("D",)) is True
    write_json(hd / "diff_D.examples.json", {"pkg::TestHuntD_X": {"examples": [{"k": 1, "head": "CHANGED", "base": "b"}]}})
    assert hunt.vet_done(hd, ("D",)) is False


def test_round14_ledger_a2_invalid_drop_and_pr_server_profile(tmp_path, monkeypatch):
    import importlib.util

    # 1. A2 strengthen-round NEW_PR_BUG maps to Mode A source so a valid DROP achieves High-Confidence Clean
    h_a2 = tmp_path / "h_a2"
    write_json(h_a2 / "state.json", {"pr": "1", "batch": 1, "batches": 1, "changed": ["p/a.go"], "modes": ["A"]})
    write_json(h_a2 / "A" / "response.json", {"files": [{"path": "p/hunt_hunta_test.go", "content": "x"}]})
    write_json(h_a2 / "run_A.json", {"p::T1": "PASS"})
    write_json(h_a2 / "run_A2.json", {"p::T2": "FAIL_3_OF_3"})
    write_json(h_a2 / "base_A2.json", {"p::T2": "NEW_PR_BUG"})
    write_json(h_a2 / "old_tests.json", {"tests": {}})
    write_json(h_a2 / "pr_tests.json", {"tests": {}})
    write_json(h_a2 / "vetted.json", {"rows": [vetted_row(id="p::T2", source="A", decision="DROP")]})
    rec_a2 = ledger.record("1", hdir=h_a2, out_path=tmp_path / "l_a2.jsonl")
    assert rec_a2["confidence_tier"] == "High-Confidence Clean" and rec_a2["gaps"] == []

    # 2. Validation-failed DROP row (missing required field -> invalid row) stays Partial with unvetted gap
    bad_drop = vetted_row(id="p::T2", source="A", decision="DROP")
    bad_drop.pop("file_line")
    write_json(h_a2 / "vetted.json", {"rows": [bad_drop]})
    rec_bad = ledger.record("1", hdir=h_a2, out_path=tmp_path / "l_bad.jsonl")
    assert rec_bad["confidence_tier"] == "Partial or Unverified Coverage"
    assert "unvetted findings" in rec_bad["gaps"]

    # 3 & 4. pr_server._stored_profile returns None when missing; unwritable profile fails before make()
    ps_path = Path(__file__).resolve().parent.parent / ".claude" / "skills" / "verify" / "scripts" / "pr_server.py"
    spec = importlib.util.spec_from_file_location("pr_server_r14", ps_path)
    assert spec and spec.loader
    pr_server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pr_server)

    e2e = tmp_path / "e2e"
    (e2e / ".ci").mkdir(parents=True)
    (e2e / ".ci" / "server.generate.sh").write_text("")
    prof = tmp_path / "missing_dir" / "profile"
    monkeypatch.setenv("VERIFY_USER", "u")
    monkeypatch.setenv("VERIFY_PASSWORD", "p")
    monkeypatch.setattr(pr_server, "profile_path", lambda: prof)
    monkeypatch.setattr(pr_server, "lock_path", lambda: tmp_path / "lock")
    monkeypatch.setattr(pr_server, "running_build", lambda url: "abc1234")
    monkeypatch.setattr(pr_server, "seed", lambda *a: None)
    assert pr_server._stored_profile() is None
    make_calls: list[str] = []
    monkeypatch.setattr(pr_server, "make", lambda _e, target, *_a: make_calls.append(target))
    with pytest.raises(OSError):
        pr_server.up("repo:abc1234", e2e, flags=[])
    assert make_calls == []


def test_round15_archived_r_unvetted_and_verify_ui_edge_cases(tmp_path):
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server

    # 1. Archived Mode R unvetted result without vetted.json/verdict.json stays Partial (unvetted findings)
    h_arch = tmp_path / "h_arch_r"
    write_json(h_arch / "state.json", {"pr": "1", "batch": 2, "batches": 2, "changed": ["b.go"], "modes": ["R"]})
    write_json(h_arch / "old_tests.json", {"tests": {}})
    write_json(h_arch / "pr_tests.json", {"tests": {}})
    write_json(h_arch / "vetted.json", {"rows": []})
    write_json(h_arch / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(h_arch / "batches" / "batch_1" / "R_CR1.json", {"CR1": "NEW_PR_BUG"})
    rec1 = ledger.record("1", hdir=h_arch, out_path=tmp_path / "l_r15_1.jsonl")
    assert rec1["confidence_tier"] == "Partial or Unverified Coverage"
    assert "unvetted findings" in rec1["gaps"]

    write_json(
        h_arch / "batches" / "batch_1" / "verdict.json",
        {"vetted_present": True, "keep": [], "held": [{"row": vetted_row(id="CR1", source="R", decision="DROP"), "reasons": ["decision=DROP"]}]},
    )
    rec2 = ledger.record("1", hdir=h_arch, out_path=tmp_path / "l_r15_2.jsonl")
    assert rec2["confidence_tier"] == "High-Confidence Clean"

    # 2-5. verify_ui.mjs: cookie path boundary, empty save freeze, framenavigated rf !== null, live-server connection reset
    class _OkHandler(JsonHandler):
        def do_GET(self):
            self._send(200, json.dumps({"ok": True}))

    with http_server(_OkHandler) as (_srv, live_url):
        script = (
            f"import fs from 'node:fs';\n"
            f"import {{ freeze }} from {json.dumps(VERIFY_UI.as_uri())};\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            # cookie path boundary
            "const m = src.match(/async function sendApiRequest\\([\\s\\S]*?\\n\\}/);\n"
            "const sendFn = (new Function('return ' + m[0]))();\n"
            "let hdr = null;\n"
            "const host = { storageState: async () => ({cookies: [{name: 'MMCSRF', value: 'p1', domain: '127.0.0.1', path: '/plugins/calendar'}]}),\n"
            "  request: { fetch: async (_u, o) => { hdr = o.headers; return {status: () => 200}; } } };\n"
            "await sendFn(host, 'http://127.0.0.1:8065', 'POST', '/plugins/calendar-tools/api/v1/settings', {}, {}, 1024, 5000);\n"
            "if (hdr['X-CSRF-Token'] !== undefined) throw new Error('sibling path matched');\n"
            "await sendFn(host, 'http://127.0.0.1:8065', 'POST', '/plugins/calendar/api/v1/settings', {}, {}, 1024, 5000);\n"
            "if (hdr['X-CSRF-Token'] !== 'p1') throw new Error('descendant path missed');\n"
            # freeze save: {} skips res.json()
            "const frozen = freeze({ steps: [{ capture: { api: 'GET /oauth/authorize', save: {} } }], expect: [{ count: { css: 'body' } }] }, 'http://127.0.0.1:8065');\n"
            "if (frozen.includes('res.json()')) throw new Error('empty capture.save emitted res.json()');\n"
            # framenavigated rf !== null
            "if (!src.includes('rf !== null && !r.isNavigationRequest() && rf === frame')) throw new Error('missing rf !== null guard');\n"
            # classifyStepErr with live vs dead server
            "const NET_ERR_RE = src.match(/const NET_ERR_RE = [^;]+;/)[0];\n"
            "const pm = src.match(/function planMistake[\\s\\S]*?\\n\\}/)[0];\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const cs = src.match(/async function classifyStepErr[\\s\\S]*?\\n\\}/)[0];\n"
            "const harness = (new Function('return (async () => {'\n"
            "  + 'class PlanError extends Error {} class InfraError extends Error {} class StepFailureError extends Error {} '\n"
            "  + 'const firstLine = (e) => String(e instanceof Error ? e.message : e).split(\"\\\\n\")[0]; '\n"
            "  + NET_ERR_RE + '\\n' + pm + '\\n' + sr + '\\n' + cs + '\\n'\n"
            "  + 'return {classifyStepErr, InfraError}; })()'))();\n"
            "const {classifyStepErr, InfraError} = await harness;\n"
            f"const liveRes = await classifyStepErr('step 1', new Error('net::ERR_CONNECTION_RESET'), {json.dumps(live_url)});\n"
            "if (liveRes !== 'net::ERR_CONNECTION_RESET') throw new Error('live reset became InfraError');\n"
            "let deadThrew = false;\n"
            "try { await classifyStepErr('step 1', new Error('net::ERR_CONNECTION_RESET'), 'http://127.0.0.1:1'); }\n"
            "catch (e) { deadThrew = e instanceof InfraError; }\n"
            "if (!deadThrew) throw new Error('dead server reset did not throw InfraError');\n"
        )
        js_path = tmp_path / "check_r15.mjs"
        js_path.write_text(script)
        p = subprocess.run(["node", str(js_path)], check=False, capture_output=True, text=True, env=_node_env())
        assert p.returncode == 0, p.stderr + p.stdout


def test_round16_verify_ui_capture_drag_and_api_reset(tmp_path):
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server

    class _OkHandler(JsonHandler):
        def do_GET(self):
            self._send(200, json.dumps({"ok": True}))

    with http_server(_OkHandler) as (_srv, live_url):
        script = (
            f"import fs from 'node:fs';\n"
            f"import {{ freeze }} from {json.dumps(VERIFY_UI.as_uri())};\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            # 1. freeze() budgets 2 TIMEOUT waits for target-based drags and 1 for offset drags
            "const targetFrozen = freeze({ steps: [{ drag: { from: { css: '#a' }, to: { css: '#b' } } }], expect: [{ count: { css: 'body' } }] }, 'http://127.0.0.1:8065');\n"
            "if (!targetFrozen.includes('1 * (TIMEOUT + SETTLE_MS) + 0 * API_TIMEOUT + 2 * TIMEOUT')) throw new Error('target drag missing extra TIMEOUT');\n"
            "const offsetFrozen = freeze({ steps: [{ drag: { from: { css: '#a' }, dx: 10, dy: 0 } }], expect: [{ count: { css: 'body' } }] }, 'http://127.0.0.1:8065');\n"
            "if (!offsetFrozen.includes('1 * (TIMEOUT + SETTLE_MS) + 0 * API_TIMEOUT + 1 * TIMEOUT')) throw new Error('offset drag timeout wrong');\n"
            # 2 & 3. StepFailureError + ECONNRESET/socket hang up handling in classifyStepErr
            "const NET_ERR_RE = src.match(/const NET_ERR_RE = [^;]+;/)[0];\n"
            "const pm = src.match(/function planMistake[\\s\\S]*?\\n\\}/)[0];\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const cs = src.match(/async function classifyStepErr[\\s\\S]*?\\n\\}/)[0];\n"
            "const harness = (new Function('return (async () => {'\n"
            "  + 'class PlanError extends Error {} class InfraError extends Error {} class StepFailureError extends Error {} '\n"
            "  + 'const firstLine = (e) => String(e instanceof Error ? e.message : e).split(\"\\\\n\")[0]; '\n"
            "  + NET_ERR_RE + '\\n' + pm + '\\n' + sr + '\\n' + cs + '\\n'\n"
            "  + 'return {classifyStepErr, InfraError, StepFailureError}; })()'))();\n"
            "const {classifyStepErr, InfraError, StepFailureError} = await harness;\n"
            "const capMsg = await classifyStepErr('step 1', new StepFailureError('capture.save.x: path \"ECONNREFUSED\" not found'), 'http://127.0.0.1:1');\n"
            "if (!capMsg.includes('ECONNREFUSED')) throw new Error('StepFailureError misclassified');\n"
            f"const liveApiReset = await classifyStepErr('step 1', new Error('socket hang up'), {json.dumps(live_url)});\n"
            "if (liveApiReset !== 'socket hang up') throw new Error('live socket hang up became InfraError');\n"
            "let deadApiThrew = false;\n"
            "try { await classifyStepErr('step 1', new Error('read ECONNRESET'), 'http://127.0.0.1:1'); }\n"
            "catch (e) { deadApiThrew = e instanceof InfraError; }\n"
            "if (!deadApiThrew) throw new Error('dead server ECONNRESET did not throw InfraError');\n"
        )
        js_path = tmp_path / "check_r16.mjs"
        js_path.write_text(script)
        p = subprocess.run(["node", str(js_path)], check=False, capture_output=True, text=True, env=_node_env())
        assert p.returncode == 0, p.stderr + p.stdout


def test_round17_hunt_and_eval_fixes(tmp_path, monkeypatch):
    # 1. repro_cmd quotes Go module path and ./pkg containing spaces
    wt_sp = tmp_path / "wt"
    (wt_sp / "nested modules" / "my pkg").mkdir(parents=True)
    (wt_sp / "nested modules" / "go.mod").write_text("module example.com/m\n\ngo 1.22\n")
    h_rep = tmp_path / "h_rep"
    write_json(h_rep / "state.json", {"pr": "1", "wt": str(wt_sp), "batches": 1})
    cmd = hunt.repro_cmd(h_rep, "nested modules/my pkg::TestFoo/sub")
    assert "run.py" in cmd and "repro 1 A --only 'nested modules/my pkg::TestFoo/sub'" in cmd

    # 2. stage_vet deletes stale vetted.json and vet.v_inputs.sha256 when partial run has no rows
    h_stale = tmp_path / "h_stale_vet"
    write_json(h_stale / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(h_stale / "base_A.json", {"pkg::T1": "NEW_PR_BUG"})
    write_json(h_stale / "A" / "response.json", {"files": [{"path": "pkg/hunt_hunta_test.go", "content": "package pkg\n"}]})
    write_json(h_stale / "vetted.json", {"rows": [vetted_row(id="pkg::T1", source="A", decision="KEEP")]})
    (h_stale / "vet.v_inputs.sha256").write_text("old-sha")
    monkeypatch.setattr(hunt, "dispatch_with_result", lambda *a, **k: (False, dispatch.DispatchResult(status="error"), None))
    hunt.stage_vet(h_stale, ("A",))
    assert not (h_stale / "vetted.json").exists()
    assert not (h_stale / "vet.v_inputs.sha256").exists()
    assert (h_stale / "vet.partial").is_file()

    # 3. chunk 1 failure + chunk 2 success in multi-chunk stage_v keeps v_done False (aggregate run_V.json cannot forge chunk V)
    h_mv = tmp_path / "h_mv"
    base_a = {f"pkg::Test{i}": "NEW_PR_BUG" for i in range(1, 11)}
    write_json(h_mv / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(h_mv / "base_A.json", base_a)
    write_json(h_mv / "A" / "response.json", {"files": [{"path": "pkg/hunt_hunta_test.go", "content": "package pkg\n"}]})
    write_json(h_mv / "run_A.messages.json", dict.fromkeys(base_a, "fail"))

    def disp_v2_only(hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        if tag == "V":
            hunt.set_gap(hdir, "dispatch:V", "transient")
            return False, None, None
        hunt.set_gap(hdir, f"dispatch:{tag}", None)
        write_json(hdir / tag / "response.json", {"files": [{"path": f"pkg/{tag.lower()}.go", "content": "package pkg\n"}]})
        return True, None, None

    def script_v(name, *args):
        if name == "run.py" and len(args) >= 3 and args[0] in ("run", "base"):
            verb, _, vtag = args[:3]
            write_json(h_mv / f"{verb}_{vtag}.json", {f"pkg::{vtag}": Verdict.FAIL_3_OF_3 if verb == "run" else Verdict.NEW_PR_BUG})
        return subprocess.CompletedProcess([name, *args], 0, stdout="", stderr="")

    monkeypatch.setattr(hunt, "_call_dispatch", disp_v2_only)
    monkeypatch.setattr(hunt, "script", script_v)
    hunt.stage_v("1", h_mv, ("A",))
    assert (h_mv / "run_V.json").is_file()
    assert not (h_mv / "V" / "run.json").is_file()
    assert hunt.v_done(h_mv, ("A",)) is False

    # 4. _vet_inputs attaches empty diagnostic_v_results when v_ready is False (stale Mode V outputs from earlier mode)
    h_vr = tmp_path / "h_vr"
    write_json(h_vr / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(h_vr / "run_B.json", {"pkg::TB": "FAIL_3_OF_3"})
    write_json(h_vr / "base_B.json", {"pkg::TB": "NEW_API"})
    write_json(h_vr / "B" / "response.json", {"files": [{"path": "pkg/hunt_huntb_test.go", "content": "package pkg\n"}]})
    write_json(h_vr / "run_V.json", {"stale::TV": "FAIL_3_OF_3"})
    write_json(h_vr / "base_V.json", {"stale::TV": "NEW_PR_BUG"})
    items, _, v_ready = hunt._vet_inputs(h_vr, ("B",), hunt.candidates_all(h_vr, ("B",)))
    assert v_ready is False and items[0]["diagnostic_v_results"] == {"run_V": {}, "base_V": {}}

    # 5. eval_bugs.fix_descends: exit 1 -> False, exit >1 -> raises InfraError
    monkeypatch.setattr(eval_bugs, "sh", lambda *a, **k: subprocess.CompletedProcess([], 1, "", ""))
    assert eval_bugs.fix_descends(tmp_path, "a", "b") is False
    monkeypatch.setattr(eval_bugs, "sh", lambda *a, **k: subprocess.CompletedProcess([], 128, "", "bad object"))
    with pytest.raises(eval_bugs.InfraError, match="exit 128"):
        eval_bugs.fix_descends(tmp_path, "a", "b")

    # 6. eval_bugs.cmd_fix_diff marks target FIX_NOT_RUN when package failed without PACKAGE_FAILED result key
    repo = make_repo(
        tmp_path / "r17",
        {"go.mod": "module example.com/r17\n\ngo 1.22\n", "pkg/a.go": "package pkg\nfunc F() int { return 1 }\n"},
        {"pkg/a.go": "package pkg\nfunc F() int { return 2 }\n"},
    )
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    prepare.prepare("master..feature")
    prep = load_json(hunt_dir("master..feature") / "prepare.json")
    h_fd = tmp_path / "h_fd"
    write_json(h_fd / "diff_D.json", {"pkg::TestHuntD_X": Verdict.DIFF})
    write_json(h_fd / "diff_D.examples.json", {"pkg::TestHuntD_X": {"examples": [{"i": 0, "head": 1, "base": 2}]}})
    write_json(h_fd / "D" / "response.json", {"files": [{"path": "pkg/hunt_huntd_test.go", "content": "package pkg\n"}]})
    st_fd = {"wt": prep["wt"], "wt_base": prep["wt_base"], "targets": [{"dir": "pkg", "kind": "go"}]}
    pkg_fail_out = eval_bugs.run.Outcome(
        results={"pkg::TestHuntD_X": Verdict.PASS},
        packages={"pkg": Verdict.FAIL},
    )
    monkeypatch.setattr(eval_bugs.run, "_diff_unit_pass", lambda *a, **k: (pkg_fail_out, {("pkg", "HuntD_X"): {0: {"v": 1}}}, {}, {}, []))
    out_fd = eval_bugs.cmd_fix_diff(h_fd, st_fd, Path(prep["wt"]))
    assert out_fd == {"pkg::TestHuntD_X": Verdict.FIX_NOT_RUN}

    # 7. scorecard and diff_scorecards exclude pr_error controls from pr_ci_fp_rate denominator
    manifest = {
        "cases": [{"id": "c1", "area": "a"}],
        "controls": [{"id": "k_err", "area": "a"}, {"id": "k_fp", "area": "a"}],
        "thresholds": {**eval_bugs.DEFAULT_THRESHOLDS, "raw_recall_min": 0.0, "vetted_recall_min": 0.0, "fp_rate_max": 0.5},
    }
    hunted = {
        "c1": {"results": [{"hunter": "A", "run": {"t": "FAIL_3_OF_3"}, "base": {"t": "NEW_PR_BUG"}}]},
        "k_err": {"results": [{"hunter": "PR", "pr": {}, "pr_error": "no CI config"}]},
        "k_fp": {"results": [{"hunter": "PR", "pr": {"p": "PR_TEST_FAILS_UNDER_CI"}}]},
    }
    card = eval_bugs.scorecard(manifest, hunted)
    assert card["metrics"]["pr_ci_fp_rate"] == 1.0
    assert card["fp_checks"]["pr_ci_fp_rate"] is False
    assert card["verdict"] == Verdict.FAIL
    diff = eval_bugs.diff_scorecards(card, card, max_fp=0.5)
    assert "pr_ci_fp_rate" in diff["fp_gate_failures"]
    assert diff["verdict"] == Verdict.FAIL


def test_round18_hunt_fixes(tmp_path, monkeypatch):
    # 1. Batch with base:A compile gap stays current (not archived/skipped on resume) and completes on retry.
    _repo, hdir = _setup_two_batch(tmp_path, monkeypatch)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH))
    monkeypatch.setenv("FAKE_RESPONSES", str(tmp_path / "no_resp"))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "d.log"))
    (tmp_path / "no_resp").mkdir()
    fail_base_b1 = True

    def fake_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
        if name == "prepare.py":
            repo = Path(_git(tmp_path / "repo", "rev-parse", "--show-toplevel"))
            wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
            mb = prepare.worktrees(repo, "feature", "master", wt, wt_base) if not wt.exists() else _git(repo, "rev-parse", "master")
            write_json(hdir / "prepare.json", {
                "repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
                "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir),
                "schema_version": 1, "base_mode": "two-dot", "huntable_files": 6,
            })
            return subprocess.CompletedProcess([], 0, "", "")
        if name == "ctx.py":
            prep = load_json(hdir / "prepare.json")
            batch = int(args[args.index("--batch") + 1]) if "--batch" in args else 1
            ctx.build(args[0], batch, prep, {"title": "t", "body": ""}, all_batches=True)
            return subprocess.CompletedProcess([], 0, "", "")
        if name == "build_requests.py" and args[1] == "hunters":
            build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
            return subprocess.CompletedProcess([], 0, "", "")
        if name == "run.py" and args[0] == "run":
            tag = args[2]
            write_json(hdir / f"run_{tag}.json", {"pkg1::TestHuntA_1": Verdict.FAIL_3_OF_3} if tag == "A" else {})
            (hdir / f"run_{tag}.response.sha256").write_text(run.fingerprint(load_json(hdir / tag / "response.json").get("files", [])))
            return subprocess.CompletedProcess([], 0, "", "")
        if name == "run.py" and args[0] == "base":
            tag = args[2]
            if tag == "A" and fail_base_b1 and load_json(hdir / "state.json").get("batch") == 1:
                return subprocess.CompletedProcess([], 3, "", "base compile failed")
            write_json(hdir / f"base_{tag}.json", {"pkg1::TestHuntA_1": Verdict.PASS})
            return subprocess.CompletedProcess([], 0, "", "")
        if name in ("old_tests.py", "pr_tests.py"):
            write_json(hdir / f"{name.removesuffix('.py')}.json", {"tests": {}})
            return subprocess.CompletedProcess([], 0, "", "")
        return subprocess.CompletedProcess([], 0, "", "")

    monkeypatch.setattr(hunt, "script", fake_script)
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A"]) == 0
    assert load_json(hdir / "state.json")["batch"] == 1
    assert not (hdir / "batches").exists() and not (hdir / "hunt_done.json").exists()

    fail_base_b1 = False
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A"]) == 0
    assert load_json(hdir / "state.json")["batch"] == 2
    assert (hdir / "batches" / "batch_1" / "state.json").is_file()
    assert (hdir / "hunt_done.json").is_file()

    # 2. Mode R threads.json with included threads requires R/request.json in _requests_done, stage_requests, dispatched.
    hr = tmp_path / "hr"
    write_json(hr / "R" / "threads.json", {"included": [{"thread_id": "t1"}]})
    assert hunt._requests_done(hr, ("R",)) is False
    assert hunt.dispatched(hr, ("R",)) is False
    rev_calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(hunt, "script", lambda n, *a: rev_calls.append((n, *a)) or subprocess.CompletedProcess([], 0, "", ""))
    hunt.stage_requests("1", hr, ("R",))
    assert ("build_requests.py", "1", "review") in rev_calls
    write_json(hr / "R" / "threads.json", {"included": []})
    assert hunt._requests_done(hr, ("R",)) is True
    assert hunt.dispatched(hr, ("R",)) is True

    # 3. Multi-chunk v_done requires run_V.json / base_V.json once any chunk result exists, and stage_v rebuilds them.
    hmv = tmp_path / "hmv"
    base_a = {f"pkg::Test{i}": "NEW_PR_BUG" for i in range(1, 11)}
    write_json(hmv / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hmv / "base_A.json", base_a)
    write_json(hmv / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    write_json(hmv / "run_A.messages.json", dict.fromkeys(base_a, "fail"))
    cands = hunt.candidates_ab(hmv, ("A",))
    (hmv / "V.candidates.sha256").write_text(hunt._v_cand_digest(hmv, cands, ("A",)))
    for vt, _ in hunt._v_chunks(cands):
        write_json(hmv / vt / "response.json", {"files": [{"path": f"pkg/{vt.lower()}.go", "content": "package pkg\n"}]})
        write_json(hmv / vt / "run.json", {f"pkg::{vt}": Verdict.FAIL_3_OF_3})
        write_json(hmv / vt / "base.json", {f"pkg::{vt}": Verdict.NEW_PR_BUG})
    assert hunt.v_done(hmv, ("A",)) is False
    write_json(hmv / "run_V.json", {"pkg::V": Verdict.FAIL_3_OF_3})
    assert hunt.v_done(hmv, ("A",)) is False  # base_V.json still missing
    (hmv / "run_V.json").unlink()
    monkeypatch.setattr(hunt, "_call_dispatch", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not redispatch")))
    hunt.stage_v("1", hmv, ("A",))
    assert (hmv / "run_V.json").is_file() and (hmv / "base_V.json").is_file()
    assert hunt.v_done(hmv, ("A",)) is True


def test_round18_eval_bugs_fixes(tmp_path, monkeypatch):
    # 4. pr_ci_fp_rate gate fails in scorecard and diff_scorecards when controls exist but all have pr_error.
    manifest = {
        "cases": [{"id": "c1", "area": "a"}],
        "controls": [{"id": "k1", "area": "a"}],
        "thresholds": {**eval_bugs.DEFAULT_THRESHOLDS},
    }
    hunted = {
        "c1": {"results": [{"hunter": "A", "run": {"t": "FAIL_3_OF_3"}, "base": {"t": "NEW_PR_BUG"}}]},
        "k1": {"results": [{"hunter": "PR", "pr": {}, "pr_error": "no CI config"}]},
    }
    card = eval_bugs.scorecard(manifest, hunted)
    assert card["fp_checks"]["pr_ci_fp_rate"] is False
    assert card["verdict"] == Verdict.FAIL
    diff = eval_bugs.diff_scorecards(card, card)
    assert "pr_ci_fp_rate" in diff["fp_gate_failures"] and diff["verdict"] == Verdict.FAIL

    # 5. Strictly weak ratios compare unrounded values (100/201 vs 101/203 both round to 0.4975).
    b_card = eval_bugs.scorecard(
        {"cases": [{"id": "c1", "area": "a", "fix_sha": "abc"}], "controls": [], "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)},
        {"c1": {"results": [{"hunter": "A", "fix": {
            **{f"s{i}": Verdict.STRONG for i in range(101)},
            **{f"w{i}": Verdict.STRICTLY_WEAK for i in range(100)},
        }}]}},
        ("hunters",),
    )
    c_card = eval_bugs.scorecard(
        {"cases": [{"id": "c1", "area": "a", "fix_sha": "abc"}], "controls": [], "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)},
        {"c1": {"results": [{"hunter": "A", "fix": {
            **{f"s{i}": Verdict.STRONG for i in range(102)},
            **{f"w{i}": Verdict.STRICTLY_WEAK for i in range(101)},
        }}]}},
        ("hunters",),
    )
    assert round(b_card["metrics"]["strictly_weak_ratio_A"], 4) == round(c_card["metrics"]["strictly_weak_ratio_A"], 4)
    wdiff = eval_bugs.diff_scorecards(b_card, c_card)
    assert wdiff["weak_ratio_regressions"] == ["strictly_weak_ratio_A"] and wdiff["verdict"] == Verdict.FAIL

    # 6. vet.partial marks vet_signal as vet_error (not clean control) even with only HELD rows or no vetted.json.
    hp = tmp_path / "hp"
    write_json(hp / "vetted.json", {"rows": [vetted_row(id="pkg::T", source="A", decision="HELD")]})
    (hp / "vet.partial").write_text("partial\n")
    vs = eval_bugs.vet_signal(hp)
    assert "vet_error" in vs and "vet.partial" in vs["vet_error"]
    pcard = eval_bugs.scorecard(
        {"cases": [{"id": "c1", "area": "a"}], "controls": [{"id": "k1", "area": "a"}],
         "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)},
        {"c1": {"results": []}, "k1": {"results": [vs]}},
        ("hunters",),
    )
    assert pcard["verdict"] == Verdict.ERROR and "k1" in pcard["errors"]

    # 7. cmd_fix_diff marks FIX_NOT_RUN when index i holds a different input than the original diff example.
    h_fd = tmp_path / "h_fd_r18"
    ident = "pkg::TestHuntD_X"
    write_json(h_fd / "diff_D.json", {ident: Verdict.DIFF})
    write_json(h_fd / "diff_D.examples.json", {ident: {"examples": [{"i": 0, "input": "orig", "head": 1, "base": 2}]}})
    write_json(h_fd / "D" / "response.json", {"files": [{"path": "pkg/hunt_huntd_test.go", "content": "package pkg\n"}]})
    ok_out = eval_bugs.run.Outcome(results={ident: Verdict.PASS}, packages={"pkg": Verdict.PASS})
    rkey = ("pkg", "HuntD_X")
    monkeypatch.setattr(eval_bugs.run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(eval_bugs.run, "place", lambda *_a: [])
    monkeypatch.setattr(eval_bugs.run, "unplace", lambda *_a: None)
    monkeypatch.setattr(
        eval_bugs.run, "_diff_unit_pass",
        lambda *_a, **_k: (ok_out, {rkey: {0: {"input": "changed", "output": "same"}}}, {}, {}, []),
    )
    out_fd = eval_bugs.cmd_fix_diff(h_fd, {"wt_base": str(tmp_path), "targets": [{"dir": "pkg", "kind": "go"}]}, tmp_path)
    assert out_fd == {ident: Verdict.FIX_NOT_RUN}


def test_round18_verify_ui_fixes(tmp_path):
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server

    class _OkHandler(JsonHandler):
        def do_GET(self):
            self._send(200, json.dumps({"ok": True}))

    with http_server(_OkHandler) as (_srv, live_url):
        script = (
            f"import fs from 'node:fs';\n"
            f"import {{ freeze }} from {json.dumps(VERIFY_UI.as_uri())};\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            # 8. Authenticated API-only plan freezes without chromium/browser/settle
            "const apiFrozen = freeze({ name: 'api', login: true, steps: [{ capture: { api: '/api/v4/users/me' } }], expect: [{ api: { path: '/api/v4/users/me', status: 200 } }] }, 'http://127.0.0.1:8065', [], true);\n"
            "if (apiFrozen.includes('chromium') || apiFrozen.includes('attachPageGuards') || apiFrozen.includes('await settle()')) throw new Error('API-only freeze kept browser setup');\n"
            "if (!apiFrozen.includes('request.newContext()') || !apiFrozen.includes('apiLogin(context, BASE, process.env)')) throw new Error('API-only freeze missing request context or login');\n"
            # 9. ERR_EMPTY_RESPONSE probed via serverReachable
            "const NET_ERR_RE = src.match(/const NET_ERR_RE = [^;]+;/)[0];\n"
            "const pm = src.match(/function planMistake[\\s\\S]*?\\n\\}/)[0];\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const cs = src.match(/async function classifyStepErr[\\s\\S]*?\\n\\}/)[0];\n"
            "const h1 = (new Function('return (async () => {'\n"
            "  + 'class PlanError extends Error {} class InfraError extends Error {} class StepFailureError extends Error {} '\n"
            "  + 'const firstLine = (e) => String(e instanceof Error ? e.message : e).split(\"\\\\n\")[0]; '\n"
            "  + NET_ERR_RE + '\\n' + pm + '\\n' + sr + '\\n' + cs + '\\n'\n"
            "  + 'return {classifyStepErr, InfraError}; })()'))();\n"
            "const {classifyStepErr, InfraError} = await h1;\n"
            f"const liveEmpty = await classifyStepErr('step 1', new Error('page.goto: net::ERR_EMPTY_RESPONSE'), {json.dumps(live_url)});\n"
            "if (!liveEmpty.includes('ERR_EMPTY_RESPONSE')) throw new Error('live empty response became InfraError');\n"
            "let deadEmpty = false;\n"
            "try { await classifyStepErr('step 1', new Error('page.goto: net::ERR_EMPTY_RESPONSE'), 'http://127.0.0.1:1'); }\n"
            "catch (e) { deadEmpty = e instanceof InfraError; }\n"
            "if (!deadEmpty) throw new Error('dead server ERR_EMPTY_RESPONSE did not throw InfraError');\n"
            # 10 & 12. attachPageGuards handles superseded navs + /oauth/ & /plugins/<id>/ 500s
            "const SPR = src.match(/const SERVER_PATH_RE = [^;]+;/)[0];\n"
            "const apg = src.match(/async function attachPageGuards[\\s\\S]*?\\n\\}/)[0];\n"
            "const h2 = (new Function('return (async () => {' + SPR + '\\n' + apg + '\\nreturn attachPageGuards; })()'))();\n"
            "const attachFn = await h2;\n"
            "const listeners = new Map();\n"
            "const frame = {};\n"
            "const fakePage = { mainFrame: () => frame, setDefaultTimeout: () => {}, on: (ev, fn) => { const a = listeners.get(ev) || []; a.push(fn); listeners.set(ev, a); } };\n"
            "const emit = (ev, arg) => (listeners.get(ev) || []).forEach((fn) => fn(arg));\n"
            "const soft = [];\n"
            "const tracker = await attachFn({ route: async () => {} }, fakePage, new Set(['http://127.0.0.1:8065']), () => 'http://127.0.0.1:8065', 5000, [], soft, () => {}, null);\n"
            "const oldReq = { url: () => 'http://127.0.0.1:8065/old.js', isNavigationRequest: () => false, frame: () => frame };\n"
            "const navA = { url: () => 'http://127.0.0.1:8065/a', isNavigationRequest: () => true, frame: () => frame, redirectedFrom: () => null };\n"
            "const navB = { url: () => 'http://127.0.0.1:8065/b', isNavigationRequest: () => true, frame: () => frame, redirectedFrom: () => null };\n"
            "emit('request', oldReq); emit('request', navA); emit('request', navB); emit('requestfailed', navA); emit('framenavigated', frame);\n"
            "if (tracker.inflight.has(oldReq)) throw new Error('superseded nav failure cleared newer nav marker');\n"
            "emit('response', { url: () => 'http://127.0.0.1:8065/oauth/authorize', status: () => 502, request: () => ({ method: () => 'GET' }) });\n"
            "emit('response', { url: () => 'http://127.0.0.1:8065/plugins/com.example/api', status: () => 500, request: () => ({ method: () => 'POST' }) });\n"
            "emit('response', { url: () => 'http://127.0.0.1:8065/static/app.js', status: () => 500, request: () => ({ method: () => 'GET' }) });\n"
            "if (soft.length !== 2) throw new Error('expected 2 server path errors, got ' + JSON.stringify(soft));\n"
            # 11. apiLogin in API-only mode filters cookies by target path
            "const al = src.match(/export async function apiLogin[\\s\\S]*?\\n\\}/)[0].replace(/^export /, '');\n"
            "const loginFn = (new Function('return ' + al))();\n"
            "const hostWrongPath = {\n"
            "  request: { post: async () => ({ ok: () => true, status: () => 200 }) },\n"
            "  storageState: async () => ({ cookies: [\n"
            "    { name: 'MMAUTHTOKEN', domain: '127.0.0.1', path: '/oauth/' },\n"
            "    { name: 'MMUSERID', domain: '127.0.0.1', path: '/' },\n"
            "    { name: 'MMCSRF', domain: '127.0.0.1', path: '/' },\n"
            "  ] }),\n"
            "};\n"
            "let pathErr = '';\n"
            "try { await loginFn(hostWrongPath, 'http://127.0.0.1:8065', { VERIFY_USER: 'u', VERIFY_PASSWORD: 'p' }); }\n"
            "catch (e) { pathErr = String(e.message); }\n"
            "if (!pathErr.includes('MMAUTHTOKEN')) throw new Error('wrong-path cookie was counted: ' + pathErr);\n"
        )
        js_path = tmp_path / "check_r18.mjs"
        js_path.write_text(script)
        p = subprocess.run(["node", str(js_path)], check=False, capture_output=True, text=True, env=_node_env())
        assert p.returncode == 0, p.stderr + p.stdout


def test_round19_run_eval_and_verify_ui_fixes(tmp_path, monkeypatch):
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server

    # 1. run.py: fixed URL ports in assertion messages are preserved, while transport errors normalize
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": 'got "http://127.0.0.1:8065/a"'}, 'got "http://127.0.0.1:8066/a"',
    ) == Verdict.BASE_FAILS_DIFFERENTLY
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": 'Get "http://127.0.0.1:54321/a": connection refused'},
        'Get "http://127.0.0.1:49152/a": connection refused',
    ) == Verdict.PRE_EXISTING

    # 2. run.py: empty cmd_run clears stale adjudication
    h_empty = tmp_path / "h_empty"
    write_json(h_empty / "A" / "response.json", {"files": []})
    for stale in ("vetted.json", "verdict.json", "findings.json", "hunt_done.json"):
        write_json(h_empty / stale, {"stale": True})
    monkeypatch.setattr(run, "ensure_clean", lambda *_a: None)
    assert run.cmd_run(h_empty, {"wt": str(tmp_path), "targets": []}, "A") == {}
    for stale in ("vetted.json", "verdict.json", "findings.json", "hunt_done.json"):
        assert not (h_empty / stale).exists()

    # 3. run.py: full-package confirmation records contradictory failure for a test that passed run 1
    h_conf = tmp_path / "h_conf"
    wt_c = tmp_path / "wt_c"
    (wt_c / "pkg").mkdir(parents=True)
    (wt_c / "go.mod").write_text("module m\n")
    write_json(h_conf / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    monkeypatch.setattr(run, "place", lambda *_a: [wt_c / "pkg" / "a_test.go"])
    monkeypatch.setattr(run, "unplace", lambda *_a: None)
    monkeypatch.setattr(run, "suite_for", lambda *_a: run.Suite(go_patterns={"pkg": "^(?:TestA|TestB)$"}))
    seq = iter([
        run.Outcome(results={"pkg::TestA": Verdict.PASS, "pkg::TestB": Verdict.FAIL}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestB": Verdict.PASS}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestA": Verdict.FAIL, "pkg::TestB": Verdict.FAIL}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestB": Verdict.FAIL}, runtimes={"pkg": 0.1}),
    ])
    monkeypatch.setattr(run, "run_suite", lambda *_a, **_k: next(seq))
    tbl = run.cmd_run(h_conf, {"wt": str(wt_c), "targets": [{"dir": "pkg", "lang": "go"}]}, "A", runs=3)
    assert tbl["pkg::TestA"] == Verdict.FLAKY and tbl["pkg::TestB"] == Verdict.FAIL_3_OF_3

    # 4. run.py: _has_go_decl recognizes type (...) groups without false-matching nested struct fields
    src_t = "package p\ntype (\n\tNewID string\n\tOther struct {\n\t\tField int\n\t}\n)\n"
    assert run._has_go_decl(src_t, "NewID") is True
    assert run._has_go_decl(src_t, "Field") is False

    # 5. run.py: cmd_diff rejects differential evidence when base TestMain fails package-level
    h_df = tmp_path / "h_df"
    write_json(h_df / "D" / "response.json", {"files": [{"path": "pkg/d_test.go", "content": "package pkg\n"}]})
    monkeypatch.setattr(run, "require_disk", lambda *_a: None)
    monkeypatch.setattr(run, "_place_units", lambda _w, by_u, _t, *_a: list(by_u.items()))

    def fake_diff_pass(_wt, _st, _tag, _u, _td, stem, base=False):
        res = {"pkg::TestHuntD_X": Verdict.PASS}
        if base:
            res[f"pkg::{run.PACKAGE_FAILED}"] = Verdict.FAIL
        o = run.Outcome(results=res, packages={"pkg": Verdict.FAIL if base else Verdict.PASS})
        recs = {("pkg", "HuntD_X"): {0: {"input": 1, "output": 1 if not base else 0}}}
        return o, recs, {}, {}, []

    monkeypatch.setattr(run, "_diff_unit_pass", fake_diff_pass)
    dv = run.cmd_diff(h_df, {"wt": str(wt_c), "wt_base": str(wt_c), "targets": [{"dir": "pkg", "lang": "go"}]})
    assert dv == {"pkg::TestHuntD_X": Verdict.BASE_FAILED}

    # 6-8. eval_bugs.cmd_fix_diff: unit isolation on InfraError, extra record removal -> STRONG, base output mismatch -> FIX_NOT_RUN
    monkeypatch.setattr(eval_bugs.run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(eval_bugs.run, "place", lambda *_a: [])
    monkeypatch.setattr(eval_bugs.run, "unplace", lambda *_a: None)
    h_iso = tmp_path / "h_iso"
    write_json(h_iso / "diff_D.json", {"u1::TestHuntD_1": Verdict.DIFF, "u2::TestHuntD_2": Verdict.DIFF})
    write_json(h_iso / "diff_D.examples.json", {
        "u1::TestHuntD_1": {"examples": [{"i": 1, "input": "k", "base": run.NO_RECORD, "head": "extra"}]},
        "u2::TestHuntD_2": {"examples": [{"i": 0, "input": "x", "base": 0, "head": 1}]},
    })
    write_json(h_iso / "D" / "response.json", {"files": [
        {"path": "u1/hunt_huntd_test.go", "content": "package u1\n"},
        {"path": "u2/hunt_huntd_test.go", "content": "package u2\n"},
    ]})

    def fake_iso(_wt, _st, _tag, units, _td, stem, base=False):
        uk = units[0][0]
        if uk == "u2" and stem == "fix2":
            raise eval_bugs.InfraError("timeout")
        o = run.Outcome(results={f"{uk}::TestHuntD_{'1' if uk == 'u1' else '2'}": Verdict.PASS}, packages={uk: Verdict.PASS})
        return o, {(uk, f"HuntD_{'1' if uk == 'u1' else '2'}"): {0: {"input": "ok", "output": 1}}}, {}, {}, []

    monkeypatch.setattr(eval_bugs.run, "_diff_unit_pass", fake_diff_pass if False else fake_iso)
    res_iso = eval_bugs.cmd_fix_diff(h_iso, {"wt_base": str(wt_c), "targets": [{"dir": "u1"}, {"dir": "u2"}]}, wt_c)
    assert res_iso == {"u1::TestHuntD_1": Verdict.STRONG, "u2::TestHuntD_2": Verdict.FIX_NOT_RUN}

    # Base output mismatch (ex["base"] == 0, replayed base output == 1) -> FIX_NOT_RUN
    h_bm = tmp_path / "h_bm"
    write_json(h_bm / "diff_D.json", {"u1::TestHuntD_1": Verdict.DIFF})
    write_json(h_bm / "diff_D.examples.json", {"u1::TestHuntD_1": {"examples": [{"i": 0, "input": "x", "base": 0, "head": 1}]}})
    write_json(h_bm / "D" / "response.json", {"files": [{"path": "u1/hunt_huntd_test.go", "content": "package u1\n"}]})
    monkeypatch.setattr(
        eval_bugs.run, "_diff_unit_pass",
        lambda *_a, **_k: (run.Outcome(results={"u1::TestHuntD_1": Verdict.PASS}, packages={"u1": Verdict.PASS}),
                           {("u1", "HuntD_1"): {0: {"input": "x", "output": 1}}}, {}, {}, []),
    )
    assert eval_bugs.cmd_fix_diff(h_bm, {"wt_base": str(wt_c), "targets": [{"dir": "u1"}]}, wt_c) == {"u1::TestHuntD_1": Verdict.FIX_NOT_RUN}

    # 9. eval_bugs.hunt_entry preserves matching single-batch vetted.json on control
    repo_e = make_repo(tmp_path / "re", {"go.mod": "module e\n", "p/a.go": "package p\nfunc F() int { return 1 }\n"},
                       {"p/a.go": "package p\nfunc F() int { return 2 }\n"})
    sha_e = _git(repo_e, "rev-parse", "HEAD")
    resp_dir = tmp_path / "resp_e"
    write_json(resp_dir / "A" / "response.json", {"files": [{"path": "p/hunt_a_test.go", "content": "package p\n"}]})
    write_json(resp_dir / "vetted.json", {"rows": [vetted_row(id="p::TestHuntA_1", source="A", decision="KEEP")]})
    monkeypatch.setattr(eval_bugs.prepare, "worktrees", lambda *_a: _git(repo_e, "rev-parse", "HEAD~1"))
    monkeypatch.setattr(eval_bugs.prepare, "deps", lambda *_a: (True, False))
    monkeypatch.setattr(eval_bugs.ctx, "build", lambda *_a: {"batches": 1, "targets": [{"dir": "p", "lang": "go"}]})
    monkeypatch.setattr(eval_bugs.run, "cmd_run", lambda hdir, *_a: run._clear_adjudication(hdir, "A") or {"p::TestHuntA_1": Verdict.FAIL_3_OF_3})
    monkeypatch.setattr(
        eval_bugs.run, "cmd_base",
        lambda hdir, *_a: write_json(hdir / "base_A.json", {"p::TestHuntA_1": Verdict.NEW_PR_BUG}) or {"p::TestHuntA_1": Verdict.NEW_PR_BUG},
    )
    entry_res = eval_bugs.hunt_entry(
        {"id": "k1", "repo": str(repo_e), "head": sha_e, "area": "p", "responses": str(resp_dir)},
        1, tmp_path / "eval_out", None, ("hunters",),
    )
    assert entry_res["results"][-1]["admissibility"]["keep"] == ["p::TestHuntA_1"]

    # 10-12. verify_ui.mjs: Secure cookie on non-localhost HTTP, $ECONNREFUSED variable failure vs InfraError, TLS errors
    class _Ok(JsonHandler):
        def do_GET(self):
            self._send(200, json.dumps({"ok": True}))

    with http_server(_Ok) as (_srv, live_url):
        plan_var = tmp_path / "var_plan.json"
        plan_var.write_text(json.dumps({
            "base_url": live_url,
            "steps": [],
            "expect": [{"api": {"path": "/api/v4/users/$ECONNREFUSED", "status": 200}}],
        }))
        pv_res = subprocess.run(["node", str(VERIFY_UI), str(plan_var)], capture_output=True, text=True, check=False, env=_node_env("none"))
        assert pv_res.returncode == 1 and "unknown saved variable $ECONNREFUSED" in pv_res.stdout

        js = (
            f"import fs from 'node:fs';\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            "const al = src.match(/export async function apiLogin[\\s\\S]*?\\n\\}/)[0].replace(/^export /, '');\n"
            "const loginFn = (new Function('return ' + al))();\n"
            "const hostSec = {\n"
            "  request: { post: async () => ({ ok: () => true, status: () => 200 }) },\n"
            "  storageState: async () => ({ cookies: [\n"
            "    { name: 'MMAUTHTOKEN', domain: 'app.example.com', path: '/', secure: true },\n"
            "    { name: 'MMUSERID', domain: 'app.example.com', path: '/' },\n"
            "    { name: 'MMCSRF', domain: 'app.example.com', path: '/' },\n"
            "  ] }),\n"
            "};\n"
            "let secErr = '';\n"
            "try { await loginFn(hostSec, 'http://app.example.com:8065', { VERIFY_USER: 'u', VERIFY_PASSWORD: 'p' }); }\n"
            "catch (e) { secErr = String(e.message); }\n"
            "if (!secErr.includes('MMAUTHTOKEN')) throw new Error('Secure cookie accepted on non-localhost HTTP: ' + secErr);\n"
            "const NET_ERR_RE = src.match(/const NET_ERR_RE = [^;]+;/)[0];\n"
            "const pm = src.match(/function planMistake[\\s\\S]*?\\n\\}/)[0];\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const cs = src.match(/async function classifyStepErr[\\s\\S]*?\\n\\}/)[0];\n"
            "const h = (new Function('return (async () => {'\n"
            "  + 'class PlanError extends Error {} class InfraError extends Error {} class StepFailureError extends Error {} '\n"
            "  + 'const firstLine = (e) => String(e instanceof Error ? e.message : e).split(\"\\\\n\")[0]; '\n"
            "  + NET_ERR_RE + '\\n' + pm + '\\n' + sr + '\\n' + cs + '\\n'\n"
            "  + 'return {classifyStepErr, InfraError}; })()'))();\n"
            "const {classifyStepErr, InfraError} = await h;\n"
            "for (const msg of ['net::ERR_CERT_AUTHORITY_INVALID', 'self-signed certificate']) {\n"
            "  let threw = false;\n"
            "  try { await classifyStepErr('expect 1', new Error(msg), 'https://127.0.0.1:8443'); }\n"
            "  catch (e) { threw = e instanceof InfraError; }\n"
            "  if (!threw) throw new Error('TLS error did not throw InfraError: ' + msg);\n"
            "}\n"
        )
        jp = tmp_path / "check_r19.mjs"
        jp.write_text(js)
        p = subprocess.run(["node", str(jp)], capture_output=True, text=True, check=False, env=_node_env())
        assert p.returncode == 0, p.stderr + p.stdout


def test_round20_rework_fixes(tmp_path, monkeypatch):
    import contextlib

    import telemetry
    import verdict
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server

    # 1. verdict.py: A2 NEW_API checks run_A2.json (not run_A.json)
    hv_a2 = tmp_path / "hv_a2"
    write_json(hv_a2 / "run_A.json", {"pkg::T2": Verdict.PASS})
    write_json(hv_a2 / "run_A2.json", {"pkg::T2": Verdict.FAIL_3_OF_3})
    write_json(hv_a2 / "base_A2.json", {"pkg::T2": Verdict.NEW_API})
    write_json(hv_a2 / "vetted.json", {"rows": [vetted_row(id="pkg::T2", source="A", decision="KEEP")]})
    adm_a2 = verdict.admissibility(hv_a2)
    assert len(adm_a2["keep"]) == 1 and adm_a2["keep"][0]["id"] == "pkg::T2"

    # 2. telemetry.py: non-finite costs serialize as null and do not poison summarize()
    ht = tmp_path / "ht"
    telemetry.record(ht, "dispatch", tag="A", cost_usd=float("nan"))
    telemetry.record(ht, "dispatch", tag="B", cost_usd=1.25)
    raw_lines = (ht / "telemetry.jsonl").read_text().splitlines()
    assert json.loads(raw_lines[0])["cost_usd"] is None
    assert telemetry.summarize(ht)["total_cost_usd"] == pytest.approx(1.25)

    # 3. dispatch.py: budget_skipped preserves existing resp and publishes attempt charge inside slot
    hd = tmp_path / "hd"
    req_d = hd / "A" / "request.opus.json"
    resp_d = hd / "A" / "response.json"
    write_json(req_d, {"tier": "opus", "system": "s", "user": "{}", "schema": {"type": "object"}, "response_path": str(resp_d)})
    write_json(resp_d, {"files": [], "tests": []})
    res_skip = dispatch.dispatch(req_d, cmd="true", hdir=hd, tag="A", budget_check=lambda: True)
    assert res_skip.status == "budget_skipped" and resp_d.is_file()

    # Successful call writes dispatch_attempt(exit="ok") before slot release without double-counting
    hd2 = tmp_path / "hd2"
    req2 = hd2 / "A" / "request.json"
    resp2 = hd2 / "A" / "response.json"
    write_json(req2, {"tier": "sonnet", "system": "s", "user": "{}", "schema": {"type": "object"}, "response_path": str(resp2)})
    cmd2 = _fake(tmp_path, "d2.py", """
import json, pathlib, sys
req = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path(req["response_path"]).write_text('{"files": [], "tests": []}')
print(json.dumps({"total_cost_usd": 0.4, "usage": {"input_tokens": 10, "output_tokens": 5}}))
""")
    seen_inside: list[float] = []

    @contextlib.contextmanager
    def spy_slot(_sleep):
        yield
        seen_inside.append(telemetry.summarize(hd2)["total_cost_usd"])

    monkeypatch.setattr(dispatch, "slot", spy_slot)
    dispatch.dispatch(req2, cmd=cmd2, hdir=hd2, tag="A", sleep=lambda _s: None)
    assert seen_inside == [pytest.approx(0.4)]
    summ2 = telemetry.summarize(hd2)
    assert summ2["total_cost_usd"] == pytest.approx(0.4)
    assert summ2["by_stage"]["dispatch_attempt"]["failures"] == 0

    # 4. hunt.py: chunked v_done requires V.aggregate.sha256 (first chunk writing run_V.json cannot fool v_done)
    hmv = tmp_path / "hmv_agg"
    base_a = {f"pkg::Test{i}": "NEW_PR_BUG" for i in range(1, 11)}
    write_json(hmv / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hmv / "base_A.json", base_a)
    write_json(hmv / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    write_json(hmv / "run_A.messages.json", dict.fromkeys(base_a, "fail"))
    cands = hunt.candidates_ab(hmv, ("A",))
    (hmv / "V.candidates.sha256").write_text(hunt._v_cand_digest(hmv, cands, ("A",)))
    for vt, _ in hunt._v_chunks(cands):
        write_json(hmv / vt / "response.json", {"files": [{"path": f"pkg/{vt.lower()}.go", "content": "package pkg\n"}]})
        write_json(hmv / vt / "run.json", {f"pkg::{vt}": Verdict.PASS})
    write_json(hmv / "run_V.json", {"pkg::V": Verdict.PASS})  # written by chunk 1 before merge!
    assert hunt.v_done(hmv, ("A",)) is False

    # 5. hunt.py + run.py: Mode D repro_cmd uses `run.py diff <pr> D --only <ident>` and executes differential check
    hd_r = tmp_path / "hd_r"
    write_json(hd_r / "state.json", {"pr": "42"})
    write_json(hd_r / "diff_D.json", {"pkg::TestHuntD_X": Verdict.DIFF})
    write_json(hd_r / "diff_D.examples.json", {"pkg::TestHuntD_X": {"examples": []}})
    write_json(hd_r / "D" / "response.json", {"files": [{"path": "pkg/d_test.go", "content": "package pkg\n"}]})
    items_d, _, _ = hunt._vet_inputs(hd_r, ("D",), hunt.candidates_all(hd_r, ("D",)))
    assert " diff 42 D --only pkg::TestHuntD_X" in items_d[0]["repro_cmd"]

    # 6. run.py: Go compile diagnostic containing "is not a function" does not match MISSING_ON_BASE fallback
    hr_go = tmp_path / "hr_go"
    wt_g = tmp_path / "wt_g"
    (wt_g / "pkg").mkdir(parents=True)
    (wt_g / "go.mod").write_text("module m\n")
    files_go = [{"path": "pkg/a_test.go", "content": "package pkg\n"}]
    write_json(hr_go / "A" / "response.json", {"files": files_go})
    write_json(hr_go / "run_A.json", {"pkg::TestHuntA_1": Verdict.FAIL_3_OF_3})
    (hr_go / "run_A.response.sha256").write_text(run.fingerprint(files_go))
    monkeypatch.setattr(run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(run, "require_disk", lambda *_a: None)
    monkeypatch.setattr(run, "place", lambda *_a: [])
    monkeypatch.setattr(run, "unplace", lambda *_a: None)
    monkeypatch.setattr(run, "salvage_go", lambda *_a, **_k: (_ for _ in ()).throw(run.GoBuildError("pkg", "pkg")))
    monkeypatch.setattr(run, "go_build_errors", lambda *_a: 'pkg/a_test.go:5:1: cannot call: "x is not a function"')
    monkeypatch.setattr(run, "go_pr_added_names", lambda *_a, **_k: None)
    base_res = run.cmd_base(hr_go, {"wt": str(wt_g), "wt_base": str(wt_g), "targets": [{"dir": "pkg", "lang": "go"}]}, "A")
    assert base_res["pkg::TestHuntA_1"] == Verdict.BASE_UNCOMPILABLE

    # 7. run.py: cmd_run clears stale verdict.json before place() even if CompileError raises, and pads MISSING for new late failures
    hr_clr = tmp_path / "hr_clr"
    write_json(hr_clr / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    write_json(hr_clr / "verdict.json", {"vetted_present": True, "keep": [{"id": "old"}], "held": []})
    monkeypatch.setattr(run, "place", lambda *_a: (_ for _ in ()).throw(run.CompileError("bad place")))
    with pytest.raises(run.CompileError):
        run.cmd_run(hr_clr, {"wt": str(wt_g), "targets": [{"dir": "pkg", "lang": "go"}]}, "A")
    assert not (hr_clr / "verdict.json").exists()
    monkeypatch.setattr(run, "place", lambda *_a: [])

    h_late = tmp_path / "h_late"
    write_json(h_late / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    monkeypatch.setattr(run, "suite_for", lambda *_a: run.Suite(go_patterns={"pkg": "^(?:TestA|TestB)$"}))
    seq_late = iter([
        run.Outcome(results={"pkg::TestA": Verdict.FAIL}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestA": Verdict.FAIL, f"pkg::{run.PACKAGE_FAILED}": Verdict.FAIL}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestA": Verdict.FAIL}, runtimes={"pkg": 0.1}),
    ])
    monkeypatch.setattr(run, "run_suite", lambda *_a, **_k: next(seq_late))
    tbl_late = run.cmd_run(h_late, {"wt": str(wt_g), "targets": [{"dir": "pkg", "lang": "go"}]}, "A", runs=3)
    assert tbl_late[f"pkg::{run.PACKAGE_FAILED}"] == Verdict.FLAKY

    # 8. eval_bugs.cmd_fix_diff keeps merge-base-only record when fix omits it -> STRICTLY_WEAK
    h_mb = tmp_path / "h_mb"
    write_json(h_mb / "diff_D.json", {"pkg::TestHuntD_X": Verdict.DIFF})
    write_json(h_mb / "diff_D.examples.json", {"pkg::TestHuntD_X": {"examples": [{"i": 0, "input": "x", "base": 0, "head": 1}]}})
    write_json(h_mb / "D" / "response.json", {"files": [{"path": "pkg/hunt_huntd_test.go", "content": "package pkg\n"}]})
    monkeypatch.setattr(eval_bugs.run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(eval_bugs.run, "place", lambda *_a: [])
    monkeypatch.setattr(eval_bugs.run, "unplace", lambda *_a: None)

    def fake_mb_only(_wt, _st, _tag, _u, _td, stem, base=False):
        o = run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS}, packages={"pkg": Verdict.PASS})
        recs = {("pkg", "HuntD_X"): {1: {"input": "y", "output": 2}} if not stem.startswith("fixbase") else {0: {"input": "x", "output": 0}, 1: {"input": "y", "output": 2}}}
        return o, recs, {}, {}, []

    monkeypatch.setattr(eval_bugs.run, "_diff_unit_pass", fake_mb_only)
    assert eval_bugs.cmd_fix_diff(h_mb, {"wt_base": str(wt_g), "targets": [{"dir": "pkg"}]}, wt_g) == {"pkg::TestHuntD_X": Verdict.STRICTLY_WEAK}

    # 9. verify_ui.mjs: non-transport DOM failures & API timeout probing
    class _Ok(JsonHandler):
        def do_GET(self):
            self._send(200, json.dumps({"ok": True}))

    with http_server(_Ok) as (_srv, live_url):
        js20 = (
            f"import fs from 'node:fs';\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            "const NET_ERR_RE = src.match(/const NET_ERR_RE = [^;]+;/)[0];\n"
            "const pm = src.match(/function planMistake[\\s\\S]*?\\n\\}/)[0];\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const cs = src.match(/async function classifyStepErr[\\s\\S]*?\\n\\}/)[0];\n"
            "const h = (new Function('return (async () => {'\n"
            "  + 'class PlanError extends Error {} class InfraError extends Error {} class StepFailureError extends Error {} '\n"
            "  + 'const firstLine = (e) => String(e instanceof Error ? e.message : e).split(\"\\\\n\")[0]; '\n"
            "  + NET_ERR_RE + '\\n' + pm + '\\n' + sr + '\\n' + cs + '\\n'\n"
            "  + 'return {classifyStepErr, InfraError}; })()'))();\n"
            "const {classifyStepErr, InfraError} = await h;\n"
            "const domErr = Object.assign(new Error('drag source has no bounding box: ECONNREFUSED'), {_verifyNonTransport: true});\n"
            "const domRes = await classifyStepErr('step 1', domErr, 'http://127.0.0.1:1');\n"
            "if (!domRes.includes('ECONNREFUSED')) throw new Error('non-transport error became InfraError');\n"
            f"const liveTo = Object.assign(new Error('apiRequestContext.fetch: Timeout 30000ms exceeded'), {{name: 'TimeoutError', _verifyApiTimeout: true}});\n"
            f"const liveRes = await classifyStepErr('expect 1', liveTo, {json.dumps(live_url)});\n"
            "if (!liveRes.includes('Timeout')) throw new Error('live API timeout became InfraError');\n"
            "let deadTo = false;\n"
            "try { await classifyStepErr('expect 1', Object.assign(new Error('apiRequestContext.fetch: Timeout 30000ms exceeded'), {name: 'TimeoutError', _verifyApiTimeout: true}), 'http://127.0.0.1:1'); }\n"
            "catch (e) { deadTo = e instanceof InfraError; }\n"
            "if (!deadTo) throw new Error('dead server API timeout did not throw InfraError');\n"
        )
        jp20 = tmp_path / "check_r20.mjs"
        jp20.write_text(js20)
        p20 = subprocess.run(["node", str(jp20)], capture_output=True, text=True, check=False, env=_node_env())
        assert p20.returncode == 0, p20.stderr + p20.stdout


def test_round21_rework_fixes(tmp_path, monkeypatch):
    import telemetry
    import verdict
    from hunt_common import InfraError

    # 1. dispatch.py: strict_schema validates cached responses instead of skipping invalid cache
    hd = tmp_path / "hd_strict"
    req_s = hd / "A" / "request.json"
    resp_s = hd / "A" / "response.json"
    schema_s = {"type": "object", "required": ["files"], "properties": {"files": {"type": "array"}}, "additionalProperties": False}
    write_json(req_s, {"tier": "sonnet", "system": "s", "user": "{}", "schema": schema_s, "response_path": str(resp_s)})
    write_json(resp_s, {"wrong": 1})
    dispatch.sidecar(req_s).write_text(dispatch.request_sha(req_s))
    assert dispatch.dispatch(req_s, cmd="true", hdir=hd, tag="A", strict_schema=False).status == "skipped"
    regen_cmd = _fake(tmp_path, "regen_ok.py", """
import json, pathlib, sys
req = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path(req["response_path"]).write_text('{"files": []}')
print(json.dumps({"total_cost_usd": 0.1}))
""")
    r_regen = dispatch.dispatch(req_s, cmd=regen_cmd, hdir=hd, tag="A", strict_schema=True, sleep=lambda _s: None)
    assert r_regen.status == "ok" and json.loads(resp_s.read_text()) == {"files": []}
    assert dispatch.dispatch(req_s, cmd="false", hdir=hd, tag="A", strict_schema=True).status == "skipped"

    # 2. hunt.py: answered Mode V request succeeds even when over_budget is True
    hv = tmp_path / "hv_bud"
    monkeypatch.setenv("HUNT_BUDGET_USD", "1.0")
    telemetry.record(hv, "dispatch", tag="A", cost_usd=1.5)
    req_v = hv / "V" / "request.json"
    resp_v = hv / "V" / "response.json"
    write_json(req_v, {"tier": "sonnet", "system": "s", "user": "{}", "schema": {"type": "object"}, "response_path": str(resp_v)})
    write_json(resp_v, {"files": [], "tests": []})
    dispatch.sidecar(req_v).write_text(dispatch.request_sha(req_v))
    ok_v, res_v, _ = hunt.dispatch_with_result(hv, "V", req_v, strict_schema=True)
    assert ok_v is True and res_v is not None and res_v.status == "skipped"
    monkeypatch.delenv("HUNT_BUDGET_USD", raising=False)

    # 3. hunt.py: resume escalation for already-answered Mode B risky empty response without re-running Sonnet
    he = tmp_path / "he_resume"
    write_json(he / "state.json", {"changed": ["server/channels/app/big.go"]})
    write_json(he / "ctx.json", {"diff_production_code": "diff --git a/server/channels/app/big.go b/server/channels/app/big.go\n" + "\n".join("+x" for _ in range(110))})
    req_b = build_requests.write(he, "B", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(he / "B" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_b).write_text(dispatch.request_sha(req_b))
    assert hunt.dispatched(he, ("B",)) is False
    seen_tags: list[str] = []

    def fake_call_disp(hdir, tag, req, *, strict_schema=False, no_prompt_cache=None):
        seen_tags.append(tag)
        if req.name == "request.opus.json":
            rp = Path(json.loads(req.read_text())["response_path"])
            write_json(rp, {"files": [{"path": "p/b_test.go", "content": "package p\n"}], "tests": []})
            dispatch.sidecar(req).write_text(dispatch.request_sha(req))
            return True, dispatch.DispatchResult(status="ok", model="opus"), None
        return True, dispatch.DispatchResult(status="skipped"), None

    monkeypatch.setattr(hunt, "_call_dispatch", fake_call_disp)
    hunt.stage_dispatch(he, ("B",))
    assert (he / "B" / "request.opus.json").is_file()
    assert hunt.dispatched(he, ("B",)) is True

    # 4. hunt.py: stale run:B gap reconciled & cleared when matching run is already committed
    hg = tmp_path / "hg_gap"
    files_g = [{"path": "p/b_test.go", "content": "package p\n"}]
    write_json(hg / "B" / "response.json", {"files": files_g})
    write_json(hg / "run_B.json", {"p::TestHuntB_1": Verdict.PASS})
    write_json(hg / "run_B.messages.json", {})
    (hg / "run_B.response.sha256").write_text(run.fingerprint(files_g))
    write_json(hg / "driver.json", {"gaps": {"run:B": "stale"}})
    assert hunt._run_done(hg, ("B",)) is False
    monkeypatch.setattr(hunt, "_run_with_repair", lambda *_a, **_k: pytest.fail("should not rerun committed tag"))
    hunt.run_tag("1", hg, "B")
    assert "run:B" not in json.loads((hg / "driver.json").read_text()).get("gaps", {})
    assert hunt._run_done(hg, ("B",)) is True

    # 5. telemetry.py: OSError in _append does not mask active stage exception
    monkeypatch.setattr(telemetry, "_append", lambda *_a, **_k: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(InfraError, match="original failure"), telemetry.stage(tmp_path / "ht_err", "run"):
        raise InfraError("original failure")

    # 6. verdict.py: A2 candidate uses fix_A2.json instead of fix_A.json
    hvf = tmp_path / "hvf"
    write_json(hvf / "run_A2.json", {"pkg::T2": Verdict.FAIL_3_OF_3})
    write_json(hvf / "base_A2.json", {"pkg::T2": Verdict.NEW_PR_BUG})
    write_json(hvf / "fix_A.json", {"pkg::T2": Verdict.STRONG})
    write_json(hvf / "fix_A2.json", {"pkg::T2": Verdict.STRICTLY_WEAK})
    write_json(hvf / "vetted.json", {"rows": [vetted_row(id="pkg::T2", source="A", decision="KEEP")]})
    adm_f = verdict.admissibility(hvf)
    assert adm_f["keep"] == [] and "fix_check=STRICTLY_WEAK" in adm_f["held"][0]["reasons"]

    # 7. run.py: configured assertion ports preserved while dial tcp ports normalized
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": "url=http://localhost:8065"}, "url=http://localhost:8066",
    ) == Verdict.BASE_FAILS_DIFFERENTLY
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": "dial tcp 127.0.0.1:54321: connection refused"},
        "dial tcp 127.0.0.1:49152: connection refused",
    ) == Verdict.PRE_EXISTING

    # 8. run.py: filtered rerun with different failure message confirms under original suite
    h_fc = tmp_path / "h_fc"
    wt_fc = tmp_path / "wt_fc"
    (wt_fc / "pkg").mkdir(parents=True)
    (wt_fc / "go.mod").write_text("module m\n")
    write_json(h_fc / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    monkeypatch.setattr(run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(run, "place", lambda *_a: [])
    monkeypatch.setattr(run, "unplace", lambda *_a: None)
    monkeypatch.setattr(run, "suite_for", lambda *_a: run.Suite(go_patterns={"pkg": "^(?:TestSetup|TestTarget)$"}))
    seq_fc = iter([
        run.Outcome(results={"pkg::TestTarget": Verdict.FAIL}, messages={"pkg::TestTarget": "expected 1 got 2"}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestTarget": Verdict.FAIL}, messages={"pkg::TestTarget": "panic: setup nil"}, runtimes={"pkg": 0.1}),
        run.Outcome(results={"pkg::TestTarget": Verdict.PASS}, runtimes={"pkg": 0.1}),
    ])
    monkeypatch.setattr(run, "run_suite", lambda *_a, **_k: next(seq_fc))
    assert run.cmd_run(h_fc, {"wt": str(wt_fc), "targets": [{"dir": "pkg", "lang": "go"}]}, "A", runs=3) == {"pkg::TestTarget": Verdict.FLAKY}

    # 9. run.py: lexical helper shadowing preserves outer calls and ignores purely local shadows
    assert run._uses_unshadowed_helper("func TestOut() {\n  helper()\n  if true {\n    helper := 1\n    _ = helper\n  }\n}", "helper") is True
    assert run._uses_unshadowed_helper("func TestIn() {\n  if helper := 1; helper > 0 {\n    _ = helper\n  }\n}", "helper") is False

    # 10. run.py: _has_go_decl checks single-line struct/interface opening-line members
    assert run._has_go_decl("package p\ntype Store struct { NewField int }\n", "NewField", "Store") is True
    assert run._has_go_decl("package p\ntype Store struct { NewField int }\n", "Other", "Store") is False

    # 11-12. run.py: _diff_unit_pass tolerates invalid UTF-8 bytes in JSONL and _confirm_diff_on_base forwards `only`
    bad_uf = tmp_path / "base_0.jsonl"
    monkeypatch.setattr(run, "salvage_go", lambda *_a, **_k: (
        bad_uf.write_bytes(b'{"test":"HuntD_X","i":0,"input":"\xff","output":1}\n'),
        run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS}),
    )[1] and (run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS}), {}))
    _, recs_u, _, _, raw_u = run._diff_unit_pass(wt_fc, {"targets": []}, "D", [("pkg", [])], tmp_path, "base", base=True)
    assert recs_u[("pkg", "HuntD_X")][0]["output"] == 1 and len(raw_u) == 1

    seen_only: list[str | None] = []
    monkeypatch.setattr(run, "_place_units", lambda _w, by_u, _t, *_a: list(by_u.items()))

    def fake_base2(_wt, _st, _tag, _u, _td, _stem, base=False, only=None):
        seen_only.append(only)
        return run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS}), {("pkg", "HuntD_X"): {0: {"input": 1, "output": 0}}}, {}, {}, []

    monkeypatch.setattr(run, "_diff_unit_pass", fake_base2)
    run._confirm_diff_on_base(
        wt_fc, {"targets": []}, "D", {"pkg": []}, {"pkg"},
        [("pkg::TestHuntD_X", "pkg", ("pkg", "HuntD_X"), {0: {"input": 1, "output": 1}}, {0}, {0: {"input": 1, "output": 0}}, {0})],
        {"pkg::TestHuntD_X": Verdict.DIFF}, {"pkg::TestHuntD_X": {"differing": 1, "compared": 1, "examples": []}},
        only="pkg::TestHuntD_X",
    )
    assert seen_only == ["pkg::TestHuntD_X"]


def test_round22_rework_fixes(tmp_path, monkeypatch):
    import ledger
    import report
    import verdict
    from conftest import VERIFY_UI, JsonHandler, _node_env, http_server
    from hunt_common import InfraError

    # 1. ctx.py: fix_*.json is archived and reset with its batch / whole-PR reset
    hc = tmp_path / "hc_fix"
    write_json(hc / "A" / "response.json", {"files": []})
    write_json(hc / "fix_A.json", {"pkg::T": Verdict.STRICTLY_WEAK})
    write_json(hc / "fix_R.json", {"pkg::TestHuntR_CR1": Verdict.STRICTLY_WEAK})
    arch = ctx.archive_batch(hc, 1)
    assert (arch / "fix_A.json").is_file() and not (hc / "fix_A.json").exists()
    assert (hc / "fix_R.json").is_file()
    ctx.reset_hunt_dir(hc, include_whole_pr=True)
    assert not (hc / "fix_R.json").exists()

    # 2. verdict.py: Mode R claim CR1 maps to HuntR_CR1_* in fix_R.json (any STRICTLY_WEAK holds it)
    hr = tmp_path / "hr_fix"
    write_json(hr / "review_verdicts.json", {"verdicts": {
        "CR1": {"id": "CR1", "verdict": Verdict.PROVEN, "base_verdict": Verdict.NEW_PR_BUG},
    }})
    write_json(hr / "fix_R.json", {
        "pkg::TestHuntR_CR1_Good": Verdict.STRONG,
        "pkg::TestHuntR_CR1_Weak": Verdict.STRICTLY_WEAK,
    })
    write_json(hr / "vetted.json", {"rows": [vetted_row(id="CR1", source="R", decision="KEEP")]})
    adm_r = verdict.admissibility(hr)
    assert adm_r["keep"] == [] and "fix_check=STRICTLY_WEAK" in adm_r["held"][0]["reasons"]

    # 3-4. run.py: cmd_diff rejects head PACKAGE_FAILED and clears adjudication before CompileError
    hd = tmp_path / "hd_pkg"
    wt_d = tmp_path / "wt_d"
    wt_d.mkdir()
    write_json(hd / "D" / "response.json", {"files": [{"path": "pkg/d_test.go", "content": "package pkg\n"}]})
    write_json(hd / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    write_json(hd / "hunt_done.json", {"done": True})
    with monkeypatch.context() as mp:
        mp.setattr(run, "ensure_clean", lambda *_a: None)
        mp.setattr(run, "require_disk", lambda *_a: None)
        mp.setattr(run, "_place_units", lambda _w, by_u, _t, *_a: list(by_u.items()))
        mp.setattr(run, "unplace", lambda *_a: None)

        def fake_head_pkg_fail(_wt, _st, _tag, _u, _td, stem, base=False):
            o = run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS, f"pkg::{run.PACKAGE_FAILED}": Verdict.FAIL}) if not base else run.Outcome(results={"pkg::TestHuntD_X": Verdict.PASS})
            return o, {("pkg", "HuntD_X"): {0: {"input": 1, "output": 0 if base else 1}}}, {}, {}, []

        mp.setattr(run, "_diff_unit_pass", fake_head_pkg_fail)
        assert run.cmd_diff(hd, {"wt": str(wt_d), "wt_base": str(wt_d), "targets": [{"dir": "pkg"}]})["pkg::TestHuntD_X"] == Verdict.RECORDER_FAILED
        assert not (hd / "verdict.json").exists() and not (hd / "hunt_done.json").exists()

        write_json(hd / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
        mp.setattr(run, "_diff_unit_pass", lambda *_a, **_k: (_ for _ in ()).throw(run.CompileError("bad")))
        with pytest.raises(run.CompileError):
            run.cmd_diff(hd, {"wt": str(wt_d), "wt_base": str(wt_d), "targets": [{"dir": "pkg"}]})
        assert not (hd / "verdict.json").exists()

    # 5-6. run.py: fixed UUID assertions preserved; function-local var excluded from _has_go_decl
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": "got 11111111-2222-3333-4444-555555555555, want 00000000-0000-0000-0000-000000000000"},
        "got 22222222-3333-4444-5555-666666666666, want 00000000-0000-0000-0000-000000000000",
    ) == Verdict.BASE_FAILS_DIFFERENTLY
    assert run._has_go_decl("package calc\nfunc helper() {\n\tvar Added int\n}\n", "Added") is False
    assert run._has_go_decl("package calc\nvar Added int\n", "Added") is True

    # 7. dispatch.py: _inline_input uses request.json snapshot, and mid-call request mutation aborts commit
    h_snap = tmp_path / "h_snap"
    req_sn = h_snap / "A" / "request.json"
    resp_sn = h_snap / "A" / "response.json"
    write_json(req_sn, {"tier": "sonnet", "system": "s", "user": "fresh_json_user", "schema": {"type": "object"}, "response_path": str(resp_sn)})
    req_sn.with_suffix(".md").write_text("# User\n\nstale_md_user\n# Schema\n{}\n")
    _, stdin_sn = dispatch._inline_input(req_sn)
    assert "fresh_json_user" in stdin_sn and "stale_md_user" not in stdin_sn

    mutate_cmd = _fake(tmp_path, "mutate_req.py", """
import json, pathlib, sys
req_p = pathlib.Path(sys.argv[1])
req = json.loads(req_p.read_text())
pathlib.Path(req["response_path"]).write_text('{"files": []}')
req["user"] = "mutated_user"
req_p.write_text(json.dumps(req))
print(json.dumps({"total_cost_usd": 0.05}))
""")
    with pytest.raises(dispatch.DispatchError, match="changed while model call ran"):
        dispatch.dispatch(req_sn, cmd=mutate_cmd, hdir=h_snap, tag="A", sleep=lambda _s: None)
    assert not dispatch.is_answered(req_sn)

    # 8-9. hunt.py: failed escalation preserves accepted Sonnet response; dispatched checks strict schema
    h_esc = tmp_path / "h_esc"
    write_json(h_esc / "state.json", {"changed": ["server/channels/app/big.go"]})
    write_json(h_esc / "ctx.json", {"diff_production_code": "diff --git a/server/channels/app/big.go b/server/channels/app/big.go\n" + "\n".join("+x" for _ in range(110))})
    req_eb = build_requests.write(h_esc, "B", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(h_esc / "B" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_eb).write_text(dispatch.request_sha(req_eb))
    monkeypatch.setattr(hunt, "_call_dispatch", lambda *_a, **_k: (False, None, dispatch.DispatchError("opus down")))
    ok_esc, _, _ = hunt.escalate_tag(h_esc, "B", "empty_on_risky_file")
    assert ok_esc is False and (h_esc / "B" / "response.json").is_file()
    assert not (h_esc / "B" / "request.opus.json").exists()
    assert "dispatch:B" not in json.loads((h_esc / "driver.json").read_text()).get("gaps", {})

    h_bad_ans = tmp_path / "h_bad_ans"
    req_ba = build_requests.write(h_bad_ans, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(h_bad_ans / "A" / "response.json", {"note": "incomplete"})
    dispatch.sidecar(req_ba).write_text(dispatch.request_sha(req_ba))
    assert hunt.dispatched(h_bad_ans, ("A",)) is False

    # 10. hunt.py: chunked Mode V qualifies identical diagnostic names per chunk in _vet_inputs
    h_vc = tmp_path / "h_vc"
    write_json(h_vc / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    base_vc = {f"pkg::TestC_{i}": Verdict.NEW_PR_BUG for i in range(1, 10)}
    write_json(h_vc / "base_A.json", base_vc)
    write_json(h_vc / "A" / "response.json", {"files": [{"path": "pkg/a_test.go", "content": "package pkg\n"}]})
    write_json(h_vc / "run_A.messages.json", dict.fromkeys(base_vc, "fail"))
    c_vc = hunt.candidates_ab(h_vc, ("A",))
    v_sha_vc = hunt._v_cand_digest(h_vc, c_vc, ("A",))
    (h_vc / "V.candidates.sha256").write_text(v_sha_vc)
    (h_vc / "V.aggregate.sha256").write_text(v_sha_vc)
    for vt in ("V", "V_2"):
        write_json(h_vc / vt / "response.json", {"files": [{"path": f"pkg/{vt.lower()}.go", "content": "package pkg\n"}]})
        write_json(h_vc / vt / "run.json", {"pkg::TestHuntV_Same": Verdict.FAIL_3_OF_3 if vt == "V" else Verdict.PASS})
    write_json(h_vc / "V" / "base.json", {"pkg::TestHuntV_Same": Verdict.NEW_PR_BUG})
    write_json(h_vc / "run_V.json", {"V:pkg::TestHuntV_Same": Verdict.FAIL_3_OF_3, "V_2:pkg::TestHuntV_Same": Verdict.PASS})
    write_json(h_vc / "base_V.json", {"V:pkg::TestHuntV_Same": Verdict.NEW_PR_BUG})
    items_vc, _, _ = hunt._vet_inputs(h_vc, ("A",), c_vc)
    assert items_vc[0]["diagnostic_v_results"]["base_V"] == {"V:pkg::TestHuntV_Same": Verdict.NEW_PR_BUG}
    assert items_vc[8]["diagnostic_v_results"]["run_V"] == {"V_2:pkg::TestHuntV_Same": Verdict.PASS}

    # 11. run.py repro restores generated Go file, runs selected test, and cleans up
    h_rp = tmp_path / "h_rp"
    wt_rp = tmp_path / "wt_rp"
    (wt_rp / "calc").mkdir(parents=True)
    (wt_rp / "go.mod").write_text("module m\n")
    write_json(h_rp / "A" / "response.json", {"files": [{"path": "calc/hunt_hunta_test.go", "content": "package calc\n"}]})
    placed_seen: list[str] = []
    monkeypatch.setattr(run, "ensure_clean", lambda *_a: None)
    monkeypatch.setattr(run, "place", lambda wt_, files_, _t: [placed_seen.append(f["path"]) or (wt_ / f["path"]) for f in files_])
    monkeypatch.setattr(run, "unplace", lambda ps: placed_seen.append(f"unplaced:{len(ps)}"))
    monkeypatch.setattr(run, "suite_for", lambda *_a: run.Suite(go_patterns={"calc": "^TestHuntA_.*"}))
    monkeypatch.setattr(run, "run_suite", lambda *_a, **_k: run.Outcome(results={"calc::TestHuntA_Bug": Verdict.FAIL}, messages={"calc::TestHuntA_Bug": "boom"}))
    assert run.cmd_repro(h_rp, {"wt": str(wt_rp), "targets": [{"dir": "calc", "lang": "go"}]}, "A", "calc::TestHuntA_Bug") == 1
    assert placed_seen == ["calc/hunt_hunta_test.go", "unplaced:1"]

    # 12. hunt.py isolation: scrubs credentials from test-runner env and blocks unsandboxed third-party PRs
    monkeypatch.setenv("GITHUB_TOKEN", "secret-tok")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    monkeypatch.setenv("HUNT_SCRATCH", "/tmp/s")
    env_r = hunt._isolated_script_env("run.py")
    assert env_r is not None and "GITHUB_TOKEN" not in env_r and "ANTHROPIC_API_KEY" not in env_r and env_r["HUNT_SCRATCH"] == "/tmp/s"
    assert hunt._isolated_script_env("prepare.py") is None
    monkeypatch.delenv("HUNT_TEST_SANDBOX_CMD", raising=False)
    monkeypatch.delenv("HUNT_ISOLATED_SANDBOX", raising=False)
    monkeypatch.delenv("HUNT_ALLOW_UNSANDBOXED", raising=False)
    with pytest.raises(InfraError, match="isolation boundary"):
        hunt._require_pr_isolation("40364")
    monkeypatch.setenv("HUNT_ISOLATED_SANDBOX", "1")
    hunt._require_pr_isolation("40364")

    # 13-16. report.py + ledger.py: finalized-verdict tier, KEEP schema guard, located supersede, per-batch modes
    h_rep2 = tmp_path / "h_rep2"
    write_json(h_rep2 / "prepare.json", {"schema_version": 1, "head": "h", "merge_base": "b"})
    write_json(h_rep2 / "state.json", {"pr": "1", "wt": str(wt_rp), "batch": 1, "batches": 1})
    write_json(h_rep2 / "run_A.json", {"pkg::T": Verdict.FAIL_3_OF_3})
    write_json(h_rep2 / "base_A.json", {"pkg::T": Verdict.NEW_PR_BUG})
    write_json(h_rep2 / "vetted.json", {"rows": [vetted_row(id="pkg::T", source="A", decision="KEEP")]})
    rep_out = report.write(h_rep2, "1")
    assert rep_out["tier"] == "Partial or Unverified Coverage"
    assert "false-positive lesson" not in (h_rep2 / "audit.md").read_text()

    h_mal = tmp_path / "h_mal"
    write_json(h_mal / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [{"id": "p::Bad", "source": "A"}], "held": []})
    write_json(h_mal / "batches" / "batch_2" / "verdict.json", {"vetted_present": True, "keep": [vetted_row(id="p::Good", source="B", decision="KEEP")], "held": []})
    write_json(h_mal / "state.json", {"pr": "1", "batch": 3, "batches": 3})
    write_json(h_mal / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    k_mal, _ = ledger.resolved_verdicts(h_mal)
    assert [r["id"] for r in k_mal] == ["p::Good"]
    assert ledger._read_verdict_json(h_mal / "batches" / "batch_1") is None

    h_sup = tmp_path / "h_sup"
    write_json(h_sup / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["x.go"]})
    write_json(h_sup / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [vetted_row(id="p::T", source="A", decision="KEEP", file_line="x.go:10")], "held": []})
    write_json(h_sup / "state.json", {"batch": 2, "changed": ["x.go"]})
    write_json(h_sup / "verdict.json", {"vetted_present": True, "keep": [], "held": [{"row": vetted_row(id="p::T", source="A", decision="DROP", file_line="x.go:11"), "reasons": ["decision=DROP"]}]})
    k_sup, h_sup_held = ledger.resolved_verdicts(h_sup)
    assert k_sup == [] and len(h_sup_held) == 1

    h_bm = tmp_path / "h_bm"
    write_json(h_bm / "batches" / "batch_1" / "state.json", {"batch": 1, "modes": ["A", "B"]})
    for t in ("A", "B"):
        write_json(h_bm / "batches" / "batch_1" / t / "response.json", {"files": [{"path": f"p/{t}.go", "content": "x"}]})
        write_json(h_bm / "batches" / "batch_1" / f"run_{t}.json", {f"p::{t}": Verdict.PASS})
    write_json(h_bm / "driver.json", {"modes": ["A", "B", "D"]})
    write_json(h_bm / "state.json", {"batch": 2, "batches": 2, "modes": ["A", "B", "D"]})
    for t in ("A", "B"):
        write_json(h_bm / t / "response.json", {"files": [{"path": f"p/{t}.go", "content": "x"}]})
        write_json(h_bm / f"run_{t}.json", {f"p::{t}": Verdict.PASS})
    write_json(h_bm / "D" / "response.json", {"files": [{"path": "p/d.go", "content": "x"}]})
    write_json(h_bm / "diff_D.json", {"p::D": Verdict.SAME})
    _, _, _, _, mg_bm = ledger._aggregate_modes(h_bm)
    assert mg_bm is False

    # 17. verify_ui.mjs: serverReachable probes /api/v4/system/ping
    class _PingOnly(JsonHandler):
        def do_GET(self):
            if self.path == "/api/v4/system/ping":
                self._send(200, json.dumps({"status": "OK"}))
            else:
                self._send(500, "unexpected path")

    with http_server(_PingOnly) as (_srv, ping_url):
        js22 = (
            f"import fs from 'node:fs';\n"
            f"const src = fs.readFileSync({json.dumps(str(VERIFY_UI))}, 'utf8');\n"
            "const sr = src.match(/async function serverReachable[\\s\\S]*?\\n\\}/)[0];\n"
            "const fn = (new Function('return (' + sr + ')'))();\n"
            f"if (!(await fn({json.dumps(ping_url)}))) throw new Error('ping probe failed');\n"
        )
        jp22 = tmp_path / "check_r22.mjs"
        jp22.write_text(js22)
        p22 = subprocess.run(["node", str(jp22)], capture_output=True, text=True, check=False, env=_node_env())
        assert p22.returncode == 0, p22.stderr + p22.stdout


def test_round23_rework_fixes(tmp_path, monkeypatch):
    import ledger
    import report

    # 1. hunt.py: resume promotes answered request.opus.json -> response.json (both stage_dispatch and Mode V)
    h_op = tmp_path / "h_op"
    orig_req = build_requests.write(h_op, "B", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    opus_resp = h_op / "B" / "response.opus.json"
    opus_req = build_requests.write_request(h_op / "B" / "request.opus.json", "sys", {"x": 1},
                                            build_requests.HUNTER_SCHEMA, opus_resp, tier="opus")
    write_json(opus_resp, {"files": [{"path": "p/b_test.go", "content": "package p\n"}], "tests": []})
    dispatch.sidecar(opus_req).write_text(dispatch.request_sha(opus_req))
    assert orig_req.is_file()
    assert hunt.dispatched(h_op, ("B",)) is False
    monkeypatch.setattr(hunt, "_call_dispatch", lambda *_a, **_k: (True, dispatch.DispatchResult(status="skipped"), None))
    hunt.stage_dispatch(h_op, ("B",))
    assert json.loads((h_op / "B" / "response.json").read_text())["files"][0]["path"] == "p/b_test.go"
    assert hunt.dispatched(h_op, ("B",)) is True
    assert hunt._has_accepted_response(h_op, "B") is True

    # Mode V resume promotion
    hv_op = tmp_path / "hv_op"
    write_json(hv_op / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hv_op / "base_A.json", {"p::TestA": Verdict.NEW_PR_BUG})
    write_json(hv_op / "A" / "response.json", {"files": [{"path": "p/a_test.go", "content": "package p\n"}]})
    write_json(hv_op / "run_A.messages.json", {"p::TestA": "fail"})
    v_op_resp = hv_op / "V" / "response.opus.json"
    v_op_req = build_requests.write_request(hv_op / "V" / "request.opus.json", "sys", {"x": 1},
                                            build_requests.HUNTER_SCHEMA, v_op_resp, tier="opus")
    write_json(v_op_resp, {"files": [{"path": "p/v_test.go", "content": "package p\n"}], "tests": []})
    dispatch.sidecar(v_op_req).write_text(dispatch.request_sha(v_op_req))
    monkeypatch.setattr(hunt, "script", lambda *a: subprocess.CompletedProcess([], 0, stdout="", stderr=""))
    hunt.stage_v("1", hv_op, modes=("A",))
    assert json.loads((hv_op / "V" / "response.json").read_text())["files"][0]["path"] == "p/v_test.go"

    # 2. hunt.py: unaccepted/timed-out response or stale response after changed request is rejected by run_tag & run_diff
    h_un = tmp_path / "h_un"
    build_requests.write(h_un, "B", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(h_un / "B" / "response.json", {"files": [{"path": "p/b_test.go", "content": "package p\n"}]})
    monkeypatch.setattr(hunt, "_run_with_repair", lambda *_a, **_k: pytest.fail("must not run unaccepted response"))
    hunt.run_tag("1", h_un, "B")
    assert "run:B" in json.loads((h_un / "driver.json").read_text())["gaps"]

    h_stale = tmp_path / "h_stale_d"
    req_d1 = build_requests.write(h_stale, "D", "sys", {"v": 1}, build_requests.HUNTER_SCHEMA)
    write_json(h_stale / "D" / "response.json", {"files": []})
    hunt._record_accepted_response(h_stale, "D", req_d1)
    write_json(h_stale / "diff_D.json", {})
    write_json(h_stale / "diff_D.examples.json", {})
    (h_stale / "diff_D.response.sha256").write_text(run.fingerprint([]))
    assert hunt._run_committed(h_stale, "D") is True
    build_requests.write(h_stale, "D", "sys", {"v": 2}, build_requests.HUNTER_SCHEMA)
    assert hunt._run_committed(h_stale, "D") is False
    hunt.run_diff("1", h_stale)
    assert "run:D" in json.loads((h_stale / "driver.json").read_text())["gaps"]

    # 3. ledger.py: invalid row in later batch does not supersede valid archived KEEP
    h_inv = tmp_path / "h_inv"
    keep_arch = vetted_row(id="p::TestKeep", source="A", decision="KEEP", file_line="x.go:10")
    bad_held = {"row": {**vetted_row(id="p::TestKeep", source="A", decision="KEEP", file_line="x.go:10"), "severity": "blocker"},
                "reasons": ["invalid row: severity 'blocker' not in critical|major|minor"]}
    write_json(h_inv / "prepare.json", {"schema_version": 1, "head": "h", "merge_base": "b"})
    write_json(h_inv / "batches" / "batch_1" / "state.json", {"batch": 1, "changed": ["x.go"]})
    write_json(h_inv / "batches" / "batch_1" / "verdict.json", {"vetted_present": True, "keep": [keep_arch], "held": []})
    write_json(h_inv / "state.json", {"pr": "1", "batch": 2, "batches": 2, "changed": ["x.go"]})
    write_json(h_inv / "verdict.json", {"vetted_present": True, "keep": [], "held": [bad_held]})
    keep_inv, held_inv = ledger.resolved_verdicts(h_inv)
    assert [r["id"] for r in keep_inv] == ["p::TestKeep"] and len(held_inv) == 1
    assert len(report.grouped_findings(keep_inv)) == 1

    # 4. run.py: keyed IDs inside explicit assertion operands are preserved while diagnostic keyed IDs normalize
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": "got request_id=req-10000000; want request_id=req-30000000"},
        "got request_id=req-20000000; want request_id=req-30000000",
    ) == Verdict.BASE_FAILS_DIFFERENTLY
    assert run.base_verdict(
        "pkg::T", Verdict.FAIL, {"pkg::T": Verdict.FAIL_3_OF_3},
        {"pkg::T": "request_id=req-10000000 failed"},
        "request_id=req-20000000 failed",
    ) == Verdict.PRE_EXISTING











