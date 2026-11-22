# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Mode D (differential recorders): `build_requests.py <pr> diff` and `run.py diff <pr> D`.
The model writes input generators and recorders only; code diffs what the merge-base and the PR head recorded.
Fixtures are tiny git repos: tests/hunt_fixtures/diff_*/{base,head,responses/D/response.json}."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "skills" / "hunt" / "scripts"))

import build_requests
import run
import trusted
from test_hunt_engine import JESTDEPS, make_hunt

needs_jest = pytest.mark.skipif(not os.environ.get("HUNT_REQUIRE_DEPS") and not JESTDEPS.is_dir(),
                                reason="run `make jest-deps` first")


def _clean(state: dict) -> None:
    for wt in (state["wt"], state["wt_base"]):
        run.ensure_clean(Path(wt))
        assert not list(Path(wt).rglob("hunt_*"))


def _examples(hdir: Path) -> dict:
    return json.loads((hdir / "diff_D.examples.json").read_text())


# ------------------------------------------------------------------ Go: DIFF, SAME, BASE_UNCOMPILABLE per test

def test_go_behaviour_change_is_a_diff_with_base_vs_head_examples(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_go")
    v = run.cmd_diff(hdir, state)
    assert v == {
        "calc::TestHuntD_Bonus": "BASE_UNCOMPILABLE",   # calls Bonus, which the PR adds: cut from the base copy only
        "calc::TestHuntD_Label": "SAME",                # unchanged function in the same file
        "calc::TestHuntD_Ratio": "DIFF",                # head panics where base returned 0
        "calc::TestHuntD_TotalViaCaller": "DIFF",       # an unchanged caller sees the changed Scale
    }
    assert json.loads((hdir / "diff_D.json").read_text()) == v
    ex = _examples(hdir)
    total = ex["calc::TestHuntD_TotalViaCaller"]
    assert 0 < total["differing"] < total["compared"]
    # multiples of 7 (not 0) now map to 0; smallest input (shortest JSON, then lowest i) first
    assert total["examples"][0] == {"i": total["examples"][0]["i"], "input": [7, 3], "base": 20, "head": 6}
    assert len(total["examples"]) == 5
    sizes = [len(json.dumps(e["input"])) for e in total["examples"]]
    assert sizes == sorted(sizes)
    assert all(e["base"] != e["head"] and e["input"][0] % 7 == 0 for e in total["examples"])
    ratio = ex["calc::TestHuntD_Ratio"]["examples"]
    assert all(e["input"][1] == 0 and e["base"] == 0 and e["head"] == {"panic": "runtime error: integer divide by zero"}
               for e in ratio)
    assert "Bonus" in ex["calc::TestHuntD_Bonus"]["detail"]
    assert "calc::TestHuntD_Label" not in ex
    _clean(state)


def test_unchanged_behaviour_is_same(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_same")
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "SAME"}  # head refactors v*2 into v+v
    assert _examples(hdir) == {}
    _clean(state)


def test_time_based_recorder_is_nondeterministic_and_its_records_are_dropped(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_nondet")
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_ScaleAt": "NONDETERMINISTIC"}
    d = _examples(hdir)["calc::TestHuntD_ScaleAt"]
    assert "200 of 200 records differ" in d["detail"] and "examples" not in d
    _clean(state)


def test_a_recorder_that_fails_or_writes_nothing_is_not_reported_as_same(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_same")
    resp = hdir / "D" / "response.json"
    r = json.loads(resp.read_text())
    src = r["files"][0]["content"]
    r["files"][0]["content"] = (src + "\nfunc TestHuntD_Empty(t *testing.T) {}\n"
                                "\nfunc TestHuntD_Broken(t *testing.T) { t.Fatal(\"setup\") }\n")
    resp.write_text(json.dumps(r))
    v = run.cmd_diff(hdir, state)
    assert v == {"calc::TestHuntD_Broken": "RECORDER_FAILED", "calc::TestHuntD_Empty": "NO_RECORDS",
                 "calc::TestHuntD_Scale": "SAME"}
    assert "setup" in _examples(hdir)["calc::TestHuntD_Broken"]["detail"]
    _clean(state)


def test_head_that_does_not_compile_is_a_compile_error_and_leaves_worktrees_clean(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_same")
    resp = hdir / "D" / "response.json"
    r = json.loads(resp.read_text())
    r["files"][0]["content"] += "\nfunc TestHuntD_Bad(t *testing.T) { _ = notDefinedAnywhere }\n"
    resp.write_text(json.dumps(r))
    with pytest.raises(run.CompileError):
        run.cmd_diff(hdir, state)
    _clean(state)


def test_base_that_cannot_build_the_file_at_all_marks_each_test_base_uncompilable(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "diff_same")

    def unsalvageable(*args, **kwargs):
        raise run.CompileError("calc: error outside any hunter func")  # what salvage_go raises when nothing can be cut

    monkeypatch.setattr(run, "salvage_go", unsalvageable)
    assert run.cmd_diff(hdir, state) == {"calc::TestHuntD_Scale": "BASE_UNCOMPILABLE"}
    assert "outside any hunter func" in _examples(hdir)["calc::TestHuntD_Scale"]["detail"]
    _clean(state)


# ------------------------------------------------------------------ CLI: output and exit codes

def test_cli_prints_one_line_per_test_with_the_smallest_examples(tmp_path, monkeypatch, capsys):
    hdir, state = make_hunt(tmp_path, "diff_go")
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    assert run.main(["run.py", "diff", "1", "D"]) == 0
    out = capsys.readouterr().out
    assert "[D diff] calc::TestHuntD_Label: SAME" in out
    assert "[D diff] calc::TestHuntD_TotalViaCaller: DIFF (" in out and " inputs differ)" in out
    assert "    input: [7, 3]\n    base:  20\n    head:  6" in out
    assert "BASE_UNCOMPILABLE" in out
    _clean(state)


def test_cli_exit_codes(tmp_path, monkeypatch, capsys):
    hdir, state = make_hunt(tmp_path, "diff_same")
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    resp = hdir / "D" / "response.json"
    good = resp.read_text()
    r = json.loads(good)
    r["files"][0]["content"] += "\nfunc TestHuntD_Bad(t *testing.T) { _ = notDefinedAnywhere }\n"
    resp.write_text(json.dumps(r))
    assert run.main(["run.py", "diff", "1", "D"]) == 3  # COMPILE_ERROR on head: the repair round fixes it
    assert "COMPILE_ERROR" in capsys.readouterr().out and (hdir / "compile_D.log").exists()
    resp.write_text(good)
    (Path(state["wt"]) / "stray.txt").write_text("x")
    assert run.main(["run.py", "diff", "1", "D"]) == 2  # dirty worktree
    assert "INFRA_ERROR" in capsys.readouterr().out
    (Path(state["wt"]) / "stray.txt").unlink()
    assert run.main(["run.py", "diff", "1", "A"]) == 2  # diff is for D only
    capsys.readouterr()


def test_empty_response_runs_nothing(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_same")
    (hdir / "D" / "response.json").write_text(json.dumps({"files": [], "tests": []}))
    assert run.cmd_diff(hdir, state) == {}
    assert json.loads((hdir / "diff_D.json").read_text()) == {}


# ------------------------------------------------------------------ Jest

@needs_jest
def test_jest_behaviour_change_is_a_diff(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_jest")
    v = run.cmd_diff(hdir, state)
    f = "web/src/hunt_d.test.ts"
    assert v == {f"{f}::HuntD HuntD_slugify": "DIFF", f"{f}::HuntD HuntD_newFn": "BASE_UNCOMPILABLE"}
    d = _examples(hdir)[f"{f}::HuntD HuntD_slugify"]
    first = d["examples"][0]
    assert first["input"] == "" and first["base"] == "" and first["head"] == {"panic": "empty input"}
    # five smallest examples are all the empty string (the generator draws it many times); '_' inputs differ further down
    assert [e["input"] for e in d["examples"]] == [""] * 5 and d["differing"] > 5
    assert "target missing" in _examples(hdir)[f"{f}::HuntD HuntD_newFn"]["detail"]
    _clean(state)


# ------------------------------------------------------------------ units

def test_read_records_skips_noise_and_keeps_the_last_repeat(tmp_path):
    p = tmp_path / "r.jsonl"
    p.write_text('noise\n{"test":"T","i":0,"input":1,"output":2}\n{"test":"T","i":0,"input":1,"output":3}\n'
                 '{"test":"T","i":"x"}\n[1]\n{"test":"U","i":1,"input":0,"panic":"boom"}\n')
    assert run.read_records(p) == {"T": {0: {"input": 1, "output": 3}}, "U": {1: {"input": 0, "panic": "boom"}}}
    assert run.read_records(tmp_path / "missing") == {}


def test_diff_records_orders_by_input_size_and_marks_missing_and_changed_inputs():
    head = {0: {"input": [1, 2, 3], "output": 1}, 1: {"input": 9, "output": 1}, 2: {"input": "aaaa", "output": 5},
            3: {"input": 4, "output": 1}}
    base = {0: {"input": [1, 2, 3], "output": 2}, 1: {"input": 9, "panic": "x"}, 2: {"input": "bbbb", "output": 5},
            3: {"input": 4, "output": 1}, 4: {"input": 8, "output": 0}}
    got = run.diff_records(head, base)
    assert [e["i"] for e in got] == [1, 4, 2, 0]  # 9, 8, "aaaa", [1,2,3] by JSON length (then i)
    assert got[0] == {"i": 1, "input": 9, "base": {"panic": "x"}, "head": 1}
    assert got[1] == {"i": 4, "input": 8, "base": 0, "head": run.NO_RECORD}
    assert got[2]["base_input"] == "bbbb" and got[2]["input"] == "aaaa"
    assert run.diff_records(head, head) == []


def test_record_name_for_go_and_jest_identities():
    assert run.record_name("calc::TestHuntD_X") == "TestHuntD_X"
    assert run.record_name("web/src/hunt_d.test.ts::HuntD HuntD_x") == "HuntD_x"


def test_diff_out_sets_and_restores_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_DIFF_OUT", raising=False)
    with run.diff_out(tmp_path / "a"):
        assert os.environ["HUNT_DIFF_OUT"] == str(tmp_path / "a")
        with run.diff_out(tmp_path / "b"):
            assert os.environ["HUNT_DIFF_OUT"] == str(tmp_path / "b")
        assert os.environ["HUNT_DIFF_OUT"] == str(tmp_path / "a")
    assert "HUNT_DIFF_OUT" not in os.environ


# ------------------------------------------------------------------ request building

def test_build_requests_diff_writes_a_mode_d_request_shaped_like_a_and_b(tmp_path, monkeypatch, capsys):
    hdir, _state = make_hunt(tmp_path, "diff_go")
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "hunters")
    build_requests.main("1", "diff")
    capsys.readouterr()
    a, d = (json.loads((hdir / t / "request.json").read_text()) for t in ("A", "D"))
    assert set(d) == set(a) == {"tier", "system", "user", "schema", "response_path"}
    assert d["schema"] == a["schema"] and d["response_path"] == str(hdir / "D" / "response.json")
    assert d["system"].startswith("Mode D: differential recorder")
    assert "never decide what a correct output is" in d["system"].replace("\n", " ")
    assert "HUNT_DIFF_OUT" in d["system"] and "TestHuntD_<Name>" in d["system"]
    assert "Go: same package name" in d["system"]                   # lang_go.md
    assert "TestHuntA_" not in d["system"] and "FuzzHuntA_" not in d["system"] and "S3 Unchanged" not in d["system"]
    du = json.loads(d["user"])
    assert du["your_test_files"] == [{"lang": "go", "dir": "calc", "path": "calc/hunt_huntd_test.go", "package": "calc"}]
    for key in ("callers", "diff_production_code", "changed_functions_base_source", "neighbors_same_file"):
        assert key in du and du[key] == json.loads(a["user"])[key]


def test_mode_d_files_pass_place_and_suite_for(tmp_path):
    hdir, state = make_hunt(tmp_path, "diff_go")
    files = json.loads((hdir / "D" / "response.json").read_text())["files"]
    wt = Path(state["wt"])
    placed = run.place(wt, files, {t["dir"] for t in state["targets"]})
    try:
        assert [p.name for p in placed] == ["hunt_huntd_test.go"]
        assert run.suite_for("D", state, placed, wt).go_patterns == {"calc": "^TestHuntD_"}
    finally:
        run.unplace(placed)
    assert run.HUNT_FILE.match("hunt_d.test.tsx") and run.HUNT_FILE.match("hunt_d.test.ts")
