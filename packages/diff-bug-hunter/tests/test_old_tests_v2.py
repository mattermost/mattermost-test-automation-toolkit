# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""old_tests.py v2 (storetest swaps, per-function salvage, probabilistic breaks, generated layers) and pr_tests.py.
Fixtures are tiny Go modules; nothing here needs Postgres."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "skills" / "hunt" / "scripts"))

import old_tests
import pr_tests
import pytest
import run
from test_hunt_engine import _git, make_hunt


def _clean(*wts: str) -> bool:
    try:
        for wt in wts:
            run.ensure_clean(Path(wt))
    except run.InfraError:
        return False
    return True


def _msgs(hdir: Path, name: str) -> dict:
    return json.loads((hdir / f"{name}.messages.json").read_text())


# ------------------------------------------------------------------ storetest swap

def test_storetest_edit_runs_the_callers_in_another_package_against_the_base_storetest(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_storetest")
    out = old_tests.cmd_old(hdir, state)
    # store/impl's own test file is untouched; its TestStatus calls the edited storetest.TestStatusStore, so it runs
    # with the base storetest/status.go. TestUnchanged calls an unchanged storetest function, TestPlain none.
    assert out["tests"] == {"store/impl::TestStatus": "OLD_TEST_BREAKS"}
    assert out["units"] == [{"lang": "go", "key": "store/impl", "tests": ["TestStatus"]}]
    assert out["skipped"] == []  # the generated storetest/mocks edit is not a test file and is not swapped
    assert "status 2, want 1" in _msgs(hdir, "old_tests")["store/impl::TestStatus"]  # base storetest, head Status()
    assert _clean(state["wt"], state["wt_base"])
    assert "got != 2" in (Path(state["wt"]) / "store/storetest/status.go").read_text()  # head storetest is back


def test_storetest_helpers_reach_their_exported_callers_and_mocks_are_ignored():
    base = ("package s\n\nfunc helper() int {\n\treturn 1\n}\n\nfunc TestA(t *testing.T) {\n\t_ = helper()\n}\n\n"
            "func TestB(t *testing.T) {\n\t_ = 2\n}\n\nfunc other() {\n\thelper()\n}\n")
    head = base.replace("return 1", "return 2")
    assert old_tests.support_exports(base, head) == {"TestA"}  # unexported helper and other() are not referenceable
    assert old_tests.support_exports(base, None) == {"TestA", "TestB"}  # deleted file
    assert old_tests.support_exports(base, base) == set()
    assert old_tests.support_scope("server/channels/store/storetest/x.go") == "server/channels/store"
    assert old_tests.support_scope("storetest/x.go") == "."


# ------------------------------------------------------------------ per-function salvage

def test_one_uncompilable_base_test_does_not_take_the_package_down(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_salvage")
    out = old_tests.cmd_old(hdir, state)
    # TestLegacy uses legacyHelper, which uses Legacy (gone at head): the helper goes first, then the test that
    # called it. TestBreaks still compiles and runs.
    assert out["tests"] == {"sv::TestBreaks": "OLD_TEST_BREAKS", "sv::TestLegacy": "OLD_TEST_UNCOMPILABLE"}
    assert out["units"] == [{"lang": "go", "key": "sv", "tests": ["TestBreaks", "TestLegacy"]}]
    msgs = _msgs(hdir, "old_tests")
    assert "got 6, want 4" in msgs["sv::TestBreaks"]
    assert "undefined: Legacy" in msgs["sv::TestLegacy"] or "undefined: legacyHelper" in msgs["sv::TestLegacy"]
    assert "sv::*" not in msgs
    assert _clean(state["wt"], state["wt_base"])
    assert "TestBreaks" in (Path(state["wt"]) / "sv/sv_test.go").read_text()
    assert "legacyHelper" not in (Path(state["wt"]) / "sv/sv_test.go").read_text()  # head file is back


def test_salvage_gives_up_after_its_rounds_and_loses_the_whole_unit(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "old_salvage")
    monkeypatch.setattr(old_tests, "SALVAGE_ROUNDS", 1)  # cascade needs 2: helper, then the test that calls it
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"sv::TestBreaks": "OLD_TEST_UNCOMPILABLE", "sv::TestLegacy": "OLD_TEST_UNCOMPILABLE"}
    assert "undefined" in _msgs(hdir, "old_tests")["sv::*"]
    assert _clean(state["wt"], state["wt_base"])


def test_an_error_outside_the_swapped_files_is_not_salvaged(tmp_path):
    _, state = make_hunt(tmp_path, "old_salvage")
    wt = Path(state["wt"])
    unit = {"lang": "go", "key": "sv", "dir": "sv", "tests": ["TestBreaks"], "swap": [("sv/sv_test.go", "M")]}
    swap = old_tests.Swap(wt, Path(state["repo"]), state["merge_base"])
    swap.apply("sv/sv_test.go", "M")
    try:
        # an error in a file we did not swap: head production code
        assert old_tests._salvage(wt, unit, swap, ["TestBreaks"], "sv/sv.go:3:1: syntax error") is None
        # an error in no function at all (a package-level declaration), TestMain, or init
        assert old_tests._salvage(wt, unit, swap, ["TestBreaks"], "sv/sv_test.go:1:1: expected 'package'") is None
        # nothing parseable
        assert old_tests._salvage(wt, unit, swap, ["TestBreaks"], "build failed") is None
    finally:
        swap.restore()
    assert _clean(state["wt"])


def test_salvage_does_not_delete_testmain_or_init(tmp_path):
    _, state = make_hunt(tmp_path, "old_salvage")
    wt = Path(state["wt"])
    p = wt / "sv/sv_test.go"
    swap = old_tests.Swap(wt, Path(state["repo"]), state["merge_base"])
    swap.apply("sv/sv_test.go", "M")
    unit = {"lang": "go", "key": "sv", "dir": "sv", "tests": ["TestBreaks"], "swap": [("sv/sv_test.go", "M")]}
    try:
        p.write_text(p.read_text() + "\nfunc TestMain(m *testing.M) {\n\tos.Exit(m.Run())\n}\n")
        line = p.read_text().split("\n").index("func TestMain(m *testing.M) {") + 2
        assert old_tests._salvage(wt, unit, swap, ["TestBreaks"], f"sv/sv_test.go:{line}:2: undefined: os") is None
    finally:
        swap.restore()
    assert _clean(state["wt"])


# ------------------------------------------------------------------ probabilistic break

def test_a_test_that_fails_on_head_in_some_runs_and_never_on_base_sometimes_breaks(tmp_path, monkeypatch):
    # head's Pick() alternates through a counter file (a stand-in for a random value, deterministic): fail, pass, fail
    counter = tmp_path / "counter"
    monkeypatch.setenv("RND_COUNTER", str(counter))
    hdir, state = make_hunt(tmp_path, "old_sometimes")
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"rnd::TestPick": "OLD_TEST_SOMETIMES_BREAKS"}
    assert "pick" in _msgs(hdir, "old_tests")["rnd::TestPick"]  # the failure text of a run that failed
    assert _clean(state["wt"], state["wt_base"])


def test_a_test_flaky_on_head_and_on_base_stays_flaky(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "old_sometimes")
    monkeypatch.setenv("RND_COUNTER", str(tmp_path / "counter"))
    real = old_tests.go_run
    calls = {"n": 0}

    def flaky_base(w, patterns, race, into):
        real(w, patterns, race, into)
        if w == Path(state["wt_base"]):  # base fails once in its three runs
            calls["n"] += 1
            if calls["n"] == 2:
                into.results = dict.fromkeys(into.results, "FAIL")
    monkeypatch.setattr(old_tests, "go_run", flaky_base)
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"rnd::TestPick": "FLAKY"}
    assert _clean(state["wt"], state["wt_base"])


# ------------------------------------------------------------------ generated layers

def test_tests_of_a_generated_layer_are_skipped_with_a_reason_and_the_rest_still_run(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_layer")
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"calc::TestOne": "PASS"}
    assert [u["key"] for u in out["units"]] == ["calc"]
    assert len(out["skipped"]) == 1
    assert out["skipped"][0].startswith("store/retrylayer/retrylayer_test.go (generated layer")
    assert json.loads((hdir / "old_tests.json").read_text()) == out
    assert _clean(state["wt"], state["wt_base"])


def test_the_unit_cap_is_twenty_and_the_overflow_is_listed(tmp_path, monkeypatch):
    assert old_tests.MAX_UNITS == 20
    hdir, state = make_hunt(tmp_path, "old_layer")
    monkeypatch.setattr(old_tests, "MAX_UNITS", 0)
    out = old_tests.cmd_old(hdir, state)
    assert out["units"] == [] and "calc (over 0 units)" in out["skipped"]


# ------------------------------------------------------------------ pr_tests

def test_pr_test_that_fails_only_under_the_fully_parallel_flag_is_reported_as_a_ci_failure(tmp_path):
    hdir, state = make_hunt(tmp_path, "pr_ci_flag")
    before = os.environ.get(pr_tests.FLAG)
    out = pr_tests.cmd_pr(hdir, state)
    assert out["tests"] == {"ci::TestUsesStore": "PR_TEST_FAILS_UNDER_CI", "ci::TestAlwaysFails": "PR_TEST_FAILS",
                            "ci::TestFine": "PASS"}  # TestOld is unchanged: it does not run
    assert out["units"] == [{"lang": "go", "key": "ci", "tests": ["TestAlwaysFails", "TestFine", "TestUsesStore"]}]
    assert out["skipped"] == []
    msgs = _msgs(hdir, "pr_tests")
    assert "shared store used" in msgs["ci::TestUsesStore"] and "broken either way" in msgs["ci::TestAlwaysFails"]
    assert "ci::TestFine" not in msgs
    assert json.loads((hdir / "pr_tests.json").read_text()) == out
    assert os.environ.get(pr_tests.FLAG) == before  # the process environment is back
    assert _clean(state["wt"])


def test_the_flag_the_caller_exported_does_not_leak_into_the_run_without_it(tmp_path, monkeypatch):
    monkeypatch.setenv(pr_tests.FLAG, "true")
    hdir, state = make_hunt(tmp_path, "pr_ci_flag")
    assert pr_tests.cmd_pr(hdir, state)["tests"]["ci::TestUsesStore"] == "PR_TEST_FAILS_UNDER_CI"
    assert os.environ[pr_tests.FLAG] == "true"


def test_pr_tests_run_nothing_for_a_pr_that_adds_no_go_test(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_storetest")  # edits storetest (not a _test.go) and no test function
    assert pr_tests.cmd_pr(hdir, state) == {"tests": {}, "units": [], "skipped": []}


def test_pr_tests_restore_the_environment_when_interrupted(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "pr_ci_flag")
    monkeypatch.delenv(pr_tests.FLAG, raising=False)

    def boom(*a, **k):
        assert os.environ[pr_tests.FLAG] == "true"
        raise SystemExit(143)  # SIGTERM mid-run
    monkeypatch.setattr(pr_tests, "go_run", boom)
    with pytest.raises(SystemExit):
        pr_tests.cmd_pr(hdir, state)
    assert pr_tests.FLAG not in os.environ
    assert _clean(state["wt"])


def test_pr_tests_cap_and_uncompilable_package(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "pr_ci_flag")
    monkeypatch.setattr(pr_tests, "MAX_UNITS", 0)
    assert pr_tests.cmd_pr(hdir, state)["skipped"] == ["ci (over 0 units)"]
    monkeypatch.setattr(pr_tests, "MAX_UNITS", 20)
    wt = Path(state["wt"])
    (wt / "ci/ci.go").write_text("package ci\n\nfunc Name() string { return undefinedThing }\n")
    _git(wt, "update-index", "--assume-unchanged", "ci/ci.go")  # keep the worktree 'clean' for ensure_clean
    out = pr_tests.cmd_pr(hdir, state)
    assert out["tests"] == {"ci::*": "NOT_RUN"}
    assert "undefined: undefinedThing" in _msgs(hdir, "pr_tests")["ci::*"]


def test_old_tests_base_compile_error_marks_unit_not_run_and_cleans_up(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "old_layer")
    real = old_tests.go_run

    def fail_on_base(w, patterns, race, into):
        if w == Path(state["wt_base"]):
            raise old_tests.CompileError("base broken")
        real(w, patterns, race, into)

    monkeypatch.setattr(old_tests, "go_run", fail_on_base)
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"calc::TestOne": "NOT_RUN"}
    assert "base uncompilable" in _msgs(hdir, "old_tests")["calc::*"]
    assert _clean(state["wt"], state["wt_base"])


def test_pr_tests_retests_package_failure_without_ci_flag(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "pr_ci_flag")

    def fake_go_run(w, patterns, race, into):
        d = next(iter(patterns))
        if os.environ.get(pr_tests.FLAG) == "true":
            into.results[f"{d}::{pr_tests.PACKAGE_FAILED}"] = "FAIL"
            into.packages[d] = "FAIL"
            into.messages[f"{d}::{pr_tests.PACKAGE_FAILED}"] = "TestMain panic under parallel"
        else:
            into.results[f"{d}::TestUsesStore"] = "PASS"
            into.packages[d] = "PASS"

    monkeypatch.setattr(pr_tests, "go_run", fake_go_run)
    out = pr_tests.cmd_pr(hdir, state)
    assert out["tests"] == {f"ci::{pr_tests.PACKAGE_FAILED}": "PR_TEST_FAILS_UNDER_CI"}
