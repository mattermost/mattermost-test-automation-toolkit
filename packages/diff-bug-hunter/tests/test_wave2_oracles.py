# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Wave 2 oracles: A8 (BASE_UNCOMPILABLE evidence, auto NEW_API), R5 (Mode D stability), C2 (lazy confirmation), Mode V."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_clean_wts as _clean
from conftest import make_hunt
from test_hunt_engine import run  # imports the scripts

# ------------------------------------------------------------------ C2: lazy confirmation

HEAD_TESTS = ("calc::TestHuntA_ClampAllClamps", "calc::TestHuntA_ClampAllEmpty", "calc::TestHuntA_ClampKeepsUpperBound")


def _scripted_run_suite(monkeypatch, script: list[dict[str, str]]):
    """Replace run_suite with one that answers from `script` (one status table per call) and records each suite."""
    seen: list[dict[str, str]] = []

    def fake(wt, suite, race, go_timeouts=None):
        seen.append(dict(suite.go_patterns))
        o = run.Outcome()
        o.results = dict(script[len(seen) - 1])
        return o

    monkeypatch.setattr(run, "run_suite", fake)
    return seen


def test_c2_passing_tests_run_once_and_only_failures_are_rerun(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    a, b, c = HEAD_TESTS
    seen = _scripted_run_suite(monkeypatch, [
        {a: "FAIL", b: "PASS", c: "FAIL"},
        {a: "FAIL", c: "PASS"},   # c passes on the rerun: FLAKY, and it is not run a third time
        {a: "FAIL"},
    ])
    table = run.cmd_run(hdir, state, "A")
    assert table == {a: "FAIL_3_OF_3", b: "PASS", c: "FLAKY"}
    assert len(seen) == 3
    assert seen[0] == {"calc": "^TestHuntA_"}
    assert seen[1] == {"calc": "^(TestHuntA_ClampAllClamps|TestHuntA_ClampKeepsUpperBound)$"}
    assert seen[2] == {"calc": "^(TestHuntA_ClampAllClamps)$"}
    _clean(state)


def test_c2_all_passing_is_one_run(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    seen = _scripted_run_suite(monkeypatch, [dict.fromkeys(HEAD_TESTS, "PASS")])
    assert set(run.cmd_run(hdir, state, "A").values()) == {"PASS"}
    assert len(seen) == 1
    _clean(state)


def test_c2_a_failure_that_passes_on_the_first_rerun_stops_there(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    a, b, c = HEAD_TESTS
    seen = _scripted_run_suite(monkeypatch, [{a: "FAIL", b: "PASS", c: "SKIP"}, {a: "PASS"}])
    assert run.cmd_run(hdir, state, "A") == {a: "FLAKY", b: "PASS", c: "SKIP"}
    assert len(seen) == 2
    _clean(state)


# ------------------------------------------------------------------ Mode V

V_TEST = ('package calc\n\nimport "testing"\n\n'
          "func TestHuntV_ClampKeepsUpperBound(t *testing.T) {\n"
          '\tif got := Clamp(10, 0, 10); got != 10 {\n\t\tt.Fatalf("Clamp(10, 0, 10) = %d, want 10", got)\n\t}\n}\n')


def _v_response(hdir: Path, content: str) -> None:
    (hdir / "V").mkdir(exist_ok=True)
    (hdir / "V" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntv_test.go", "content": content}]}))


def test_mode_v_run_and_base_give_mechanical_verdicts(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    _v_response(hdir, V_TEST)
    assert run.cmd_run(hdir, state, "V") == {"calc::TestHuntV_ClampKeepsUpperBound": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "V") == {"calc::TestHuntV_ClampKeepsUpperBound": "NEW_PR_BUG"}
    _clean(state)


def test_mode_v_file_must_hold_a_testhuntv_func(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    _v_response(hdir, V_TEST.replace("TestHuntV_", "TestHuntA_"))
    with pytest.raises(run.CompileError, match="TestHuntV_"):
        run.cmd_run(hdir, state, "V")
    _clean(state)


def test_mode_v_names_pass_the_hunt_file_gate():
    assert run.HUNT_FILE.match("hunt_huntv_test.go") and run.HUNT_FILE.match("hunt_v.test.ts")
    assert run.HUNT_FILE.match("hunt_v.test.tsx")


# ------------------------------------------------------------------ A8

def _head_failed(hdir: Path, files: list[dict[str, str]]) -> None:
    (hdir / "run_A.json").write_text(json.dumps({"calc::TestHuntA_ClampAllClamps": "FAIL_3_OF_3",
                                                 "calc::TestHuntA_ClampAllEmpty": "PASS"}))
    (hdir / "run_A.response.sha256").write_text(run.fingerprint(files))


def _unbuildable_base(monkeypatch, errors: str) -> None:
    def boom(*args, **kwargs):
        raise run.GoBuildError("calc:\n" + errors[-100:], "calc")

    monkeypatch.setattr(run, "salvage_go", boom)
    monkeypatch.setattr(run, "go_build_errors", lambda wt, d: errors)


def test_a8_errors_naming_only_pr_added_symbols_make_the_tests_new_api(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    _head_failed(hdir, json.loads((hdir / "A" / "response.json").read_text())["files"])
    _unbuildable_base(monkeypatch, "calc/hunt_hunta_test.go:9:9: undefined: ClampAll\n"
                                   "calc/hunt_hunta_test.go:17:9: undefined: ClampAll\n")
    out = run.cmd_base(hdir, state, "A")
    assert out["calc::TestHuntA_ClampAllClamps"] == "NEW_API" and out["calc::TestHuntA_ClampAllEmpty"] == "NOT_A_HEAD_FAILURE"
    assert out["new_api"] == {"calc::TestHuntA_ClampAllClamps": ["ClampAll"]} and "*" not in out
    _clean(state)


def test_a8_other_build_errors_keep_per_test_rows_and_every_error(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    _head_failed(hdir, json.loads((hdir / "A" / "response.json").read_text())["files"])
    errs = ("calc/hunt_hunta_test.go:9:9: undefined: ClampAll\n"
            "calc/hunt_hunta_test.go:12:4: cannot use \"x\" (untyped string constant) as int value in assignment\n"
            "calc/hunt_hunta_test.go:20:2: undefined: NoSuchThingAnywhere\n")
    _unbuildable_base(monkeypatch, errs)
    out = run.cmd_base(hdir, state, "A")
    assert out["calc::TestHuntA_ClampAllClamps"] == "BASE_UNCOMPILABLE"
    assert out["calc::TestHuntA_ClampAllEmpty"] == "NOT_A_HEAD_FAILURE"
    assert out["*"] == "BASE_UNCOMPILABLE" and "new_api" not in out
    evidence = json.loads((hdir / "base_A.errors.json").read_text())
    assert "NoSuchThingAnywhere" in evidence["calc"] and "cannot use" in evidence["calc"]
    run_again = run.cmd_base(hdir, state, "A")  # the evidence file is rewritten, not appended
    assert run_again == out
    _clean(state)


def test_a8_a_symbol_the_pr_did_not_add_is_not_new_api(tmp_path):
    _, state = make_hunt(tmp_path, "go_newapi")
    wt = Path(state["wt"])
    assert run.go_pr_added_names(wt, "calc/x_test.go:3:1: undefined: ClampAll") == ["ClampAll"]
    assert run.go_pr_added_names(wt, "calc/x_test.go:3:1: undefined: Missing") is None
    assert run.go_pr_added_names(wt, "calc/x_test.go:3:1: undefined: ClampAll\ncalc/x_test.go:4:1: missing return") is None
    assert run.go_pr_added_names(wt, "calc/x_test.go:3:1: \"strings\" imported and not used") is None  # nothing named
    assert run.go_pr_added_names(wt, "no errors here") is None


# ------------------------------------------------------------------ R5: Mode D stability

def rec(i: int, out: object = None) -> dict:
    return {"input": i, "output": i if out is None else out}


def _scripted_diff(monkeypatch, passes: list[dict[int, dict]]):
    """Answer each _diff_unit_pass call (head1, head2, base, optional base2) with one record set for the recorder."""
    calls: list[str] = []

    def fake(wt, state, tag, units, td, stem, *, base=False):
        calls.append(stem)
        o = run.Outcome()
        o.results = {"calc::TestHuntD_Scale": "PASS"}
        return o, {("calc", "HuntD_Scale"): passes[len(calls) - 1]}, {}, {}, []

    monkeypatch.setattr(run, "_diff_unit_pass", fake)
    return calls


def test_r5_stable_indices_are_those_both_runs_wrote_and_agree_on():
    assert run.stable_indices({0: rec(0), 1: rec(1), 2: rec(2)}, {0: rec(0), 1: rec(1, "x"), 3: rec(3)}) == {0}


def test_r5_unstable_head_records_are_dropped_not_the_whole_recorder(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")
    h1 = {i: rec(i) for i in range(6)}
    h2 = {**h1, 5: rec(5, "other")}                        # index 5 differs between the two head runs
    base = {**h1, 1: rec(1, "old"), 5: rec(5, "old")}      # base differs at 1 (stable) and 5 (dropped)
    calls = _scripted_diff(monkeypatch, [h1, h2, base, base])
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "DIFF"}
    d = json.loads((hdir / "diff_D.examples.json").read_text())["calc::TestHuntD_Scale"]
    assert d["differing"] == 1 and d["compared"] == 5 and d["dropped"] == 1
    assert [e["i"] for e in d["examples"]] == [1]
    assert calls == ["head1", "head2", "base", "base2"]    # base reran because of the DIFF
    _clean(state)


def test_r5_base_is_not_rerun_without_a_diff(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")
    h1 = {i: rec(i) for i in range(5)}
    h2 = {**h1, 4: rec(4, "other")}
    calls = _scripted_diff(monkeypatch, [h1, h2, {i: rec(i) for i in range(4)}])
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "SAME"}
    assert calls == ["head1", "head2", "base"]
    assert json.loads((hdir / "diff_D.examples.json").read_text())["calc::TestHuntD_Scale"] == {"dropped": 1}
    _clean(state)


def test_r5_too_few_stable_head_records_is_nondeterministic(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")
    h1 = {i: rec(i) for i in range(5)}
    h2 = {0: rec(0), 1: rec(1), **{i: rec(i, "x") for i in range(2, 5)}}  # only 2 stable of 5 (< MIN_STABLE_RECORDS)
    _scripted_diff(monkeypatch, [h1, h2, h1])
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "NONDETERMINISTIC"}
    assert json.loads((hdir / "diff_D.examples.json").read_text())["calc::TestHuntD_Scale"]["dropped"] == 3
    _clean(state)


def test_r5_a_recorder_with_fewer_records_than_the_minimum_needs_all_of_them_stable(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")
    _scripted_diff(monkeypatch, [{0: rec(0), 1: rec(1)}, {0: rec(0), 1: rec(1)}, {0: rec(0), 1: rec(1, "old")}, {0: rec(0), 1: rec(1, "old")}])
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "DIFF"}
    _clean(state)


def test_r5_a_diff_that_is_unstable_between_two_base_runs_is_nondeterministic(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")
    h = {i: rec(i) for i in range(4)}
    _scripted_diff(monkeypatch, [h, h, {**h, 2: rec(2, "b1")}, {**h, 2: rec(2, "b2")}])
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "NONDETERMINISTIC"}
    assert json.loads((hdir / "diff_D.examples.json").read_text())["calc::TestHuntD_Scale"]["dropped"] == 1
    _clean(state)
