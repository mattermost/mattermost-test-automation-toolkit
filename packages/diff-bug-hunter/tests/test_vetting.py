# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Vetting on the merge-base: per-test NEW_API salvage (Go and Jest), and fuzzing as a step of `run.py run`."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from test_hunt_engine import FUZZ_CLAMP, JESTDEPS, _add_to_response, make_hunt, run  # imports the scripts

needs_jest = pytest.mark.skipif(not os.environ.get("HUNT_REQUIRE_DEPS") and not JESTDEPS.is_dir(),
                                reason="run `make jest-deps` first")


def _clean(state: dict) -> None:
    for key in ("wt", "wt_base"):
        wt = Path(state[key])
        assert not list(wt.rglob("hunt_*")) and not (wt / "calc" / "testdata").exists()
        run.ensure_clean(wt)


def test_go_test_of_an_api_the_pr_adds_is_new_api_and_does_not_hide_the_rest(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    head = run.cmd_run(hdir, state, "A")
    assert head == {"calc::TestHuntA_ClampAllClamps": "FAIL_3_OF_3", "calc::TestHuntA_ClampAllEmpty": "PASS",
                    "calc::TestHuntA_ClampKeepsUpperBound": "FAIL_3_OF_3"}
    resp = (hdir / "A" / "response.json").read_text()
    out = run.cmd_base(hdir, state, "A")
    assert out["calc::TestHuntA_ClampAllClamps"] == "NEW_API"
    assert out["calc::TestHuntA_ClampKeepsUpperBound"] == "NEW_PR_BUG"
    assert out["calc::TestHuntA_ClampAllEmpty"] == "NOT_A_HEAD_FAILURE"  # removed too, but nothing to vet
    assert out["new_api"] == {"calc::TestHuntA_ClampAllClamps": ["ClampAll"]}
    assert "*" not in out
    assert json.loads((hdir / "base_A.json").read_text()) == out
    assert (hdir / "A" / "response.json").read_text() == resp  # only the placed copies were edited
    _clean(state)


def test_a_helper_the_base_rejects_takes_its_callers_with_it(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    src = json.loads((hdir / "A" / "response.json").read_text())
    extra = ("\nfunc huntCheckA_All(t *testing.T) {\n\tif got := ClampAll([]int{99}, 0, 10); got[0] != 10 {\n"
             "\t\tt.Fatalf(\"got %v\", got)\n\t}\n}\n\nfunc TestHuntA_ViaHelper(t *testing.T) { huntCheckA_All(t) }\n")
    src["files"][0]["content"] += extra
    (hdir / "A" / "response.json").write_text(json.dumps(src))
    assert run.cmd_run(hdir, state, "A")["calc::TestHuntA_ViaHelper"] == "FAIL_3_OF_3"
    out = run.cmd_base(hdir, state, "A")
    assert out["calc::TestHuntA_ViaHelper"] == "NEW_API"
    assert out["new_api"]["calc::TestHuntA_ViaHelper"] == ["ClampAll"]
    assert out["calc::TestHuntA_ClampKeepsUpperBound"] == "NEW_PR_BUG"
    _clean(state)


def test_nothing_salvageable_keeps_the_file_wide_verdict(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    src = json.loads((hdir / "A" / "response.json").read_text())
    # an error outside any func (a package-level var using the new API) cannot be cut out of one test
    src["files"][0]["content"] += "\nvar huntAll = ClampAll(nil, 0, 1)\n"
    (hdir / "A" / "response.json").write_text(json.dumps(src))
    run.cmd_run(hdir, state, "A")
    out = run.cmd_base(hdir, state, "A")
    assert out["*"] == "BASE_UNCOMPILABLE" and "ClampAll" in out["detail"] and "new_api" not in out
    _clean(state)


def test_salvage_stops_after_three_rounds_of_removals(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_newapi")
    run.cmd_run(hdir, state, "A")
    monkeypatch.setattr(run, "MAX_SALVAGE_ROUNDS", 0)
    assert run.cmd_base(hdir, state, "A")["*"] == "BASE_UNCOMPILABLE"
    _clean(state)


@needs_jest
def test_jest_test_of_an_api_the_pr_adds_is_new_api_and_does_not_hide_the_rest(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_newapi")
    f = "web/src/hunt_a.test.tsx"
    assert run.cmd_run(hdir, state, "A", runs=3) == {f"{f}::HuntA HuntA_doubleMax": "FAIL_3_OF_3",
                                                      f"{f}::HuntA HuntA_neverExceedsMax": "FAIL_3_OF_3"}
    out = run.cmd_base(hdir, state, "A")
    assert out[f"{f}::HuntA HuntA_doubleMax"] == "NEW_API"
    assert out[f"{f}::HuntA HuntA_neverExceedsMax"] == "NEW_PR_BUG"
    assert out["new_api"] == {f"{f}::HuntA HuntA_doubleMax": ["doubleMax"]}
    assert "*" not in out
    for key in ("wt", "wt_base"):
        assert not list(Path(state[key]).rglob("hunt_*"))


def test_run_fuzzes_by_itself_and_the_frozen_test_is_in_the_three_runs(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_FUZZ", raising=False)  # the default is on
    monkeypatch.setenv("HUNT_FUZZ_TIME", "10s")
    hdir, state = make_hunt(tmp_path, "go_bug")
    _add_to_response(hdir, FUZZ_CLAMP)
    table = run.cmd_run(hdir, state, "A")  # no `run.py fuzz` call
    frozen = [n for n in table if "_Fuzz" in n]
    assert len(frozen) == 1 and table[frozen[0]] == "FAIL_3_OF_3"
    assert (hdir / "fuzz_A.json").exists() and (hdir / "A" / "response.prefuzz.json").exists()
    assert run.cmd_base(hdir, state, "A")[frozen[0]] == "NEW_PR_BUG"  # base accepts the frozen response's fingerprint
    again = run.cmd_run(hdir, state, "A")  # a rerun neither re-adds the frozen test nor fuzzes it again
    assert sorted(again) == sorted(table)
    _clean(state)


def test_hunt_fuzz_0_runs_no_fuzzing(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_FUZZ", "0")
    monkeypatch.setattr(run, "cmd_fuzz", lambda *a, **k: pytest.fail("fuzzing ran with HUNT_FUZZ=0"))
    hdir, state = make_hunt(tmp_path, "go_bug")
    _add_to_response(hdir, FUZZ_CLAMP)
    table = run.cmd_run(hdir, state, "A")
    assert not any("_Fuzz" in n for n in table)
    assert not (hdir / "fuzz_A.json").exists()
    _clean(state)
