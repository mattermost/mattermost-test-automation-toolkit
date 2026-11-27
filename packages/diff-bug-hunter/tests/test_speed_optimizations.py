# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Tests for scoped locks, pg_pool_lock, precompiled Go binaries, parallel fuzz, and mutant optimizations."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import ctx
import hunt_common
import pr_tests
import prepare
import pytest
import run


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


def test_hunt_lock_scopes_tag_and_two_process_concurrency(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    with hunt_common.hunt_lock(hdir, "1", scope="wt"):
        with hunt_common.hunt_lock(hdir, "1", scope="wt_base"):
            pass
        with pytest.raises(hunt_common.InfraError), hunt_common.hunt_lock(hdir, "1", scope="wt"):
            pass
        with pytest.raises(hunt_common.InfraError), hunt_common.hunt_lock(hdir, "1", scope="all"):
            pass
    with (hunt_common.hunt_lock(hdir, "1", scope="all"),
          pytest.raises(hunt_common.InfraError),
          hunt_common.hunt_lock(hdir, "1", scope="wt")):
        pass

    # Tag serialization across wt and wt_base
    with hunt_common.hunt_lock(hdir, "1", scope="wt", tag="A"):
        with pytest.raises(hunt_common.InfraError), hunt_common.hunt_lock(hdir, "1", scope="wt_base", tag="A"):
            pass
        with hunt_common.hunt_lock(hdir, "1", scope="wt_base", tag="B"):
            pass
    with pytest.raises(ValueError), hunt_common.hunt_lock(hdir, "1", scope="wt", tag="../x"):
        pass

    # Real 2-process check: child process holds wt and waits, parent acquires wt_base concurrently, then all blocks
    scripts_dir = str(Path(hunt_common.__file__).parent)
    ready = tmp_path / "ready"
    release = tmp_path / "release"
    child_code = (
        f"import pathlib, sys, time\n"
        f"sys.path.insert(0, {json.dumps(scripts_dir)})\n"
        f"import hunt_common\n"
        f"with hunt_common.hunt_lock(pathlib.Path({json.dumps(str(hdir))}), '1', scope='wt', tag='A'):\n"
        f"    pathlib.Path({json.dumps(str(ready))}).write_text('1')\n"
        f"    while not pathlib.Path({json.dumps(str(release))}).exists():\n"
        f"        time.sleep(0.02)\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", child_code])
    try:
        deadline = time.monotonic() + 10.0
        while not ready.exists():
            if proc.poll() is not None:
                pytest.fail(f"lock child exited early with code {proc.returncode}")
            if time.monotonic() >= deadline:
                pytest.fail("timed out waiting for child lock readiness")
            time.sleep(0.02)
        with hunt_common.hunt_lock(hdir, "1", scope="wt_base", tag="B"):
            pass
        with pytest.raises(hunt_common.InfraError), hunt_common.hunt_lock(hdir, "1", scope="all"):
            pass
        release.write_text("go")
        assert proc.wait(timeout=10) == 0
    finally:
        release.write_text("go")
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)

    assert pr_tests.pg_pool_lock is hunt_common.pg_pool_lock
    pg_lock = tmp_path / "pg.lock"
    monkeypatch.setenv("HUNT_PG_LOCK", str(pg_lock))
    monkeypatch.delenv("ENABLE_FULLY_PARALLEL_TESTS", raising=False)
    with hunt_common.maybe_pg_pool_lock("server/channels/apps"):
        pass
    assert not pg_lock.exists()
    with hunt_common.maybe_pg_pool_lock("server/channels/store/sqlstore"):
        pass
    assert pg_lock.exists()
    monkeypatch.setenv("ENABLE_FULLY_PARALLEL_TESTS", "true")
    with hunt_common.maybe_pg_pool_lock("server/channels/store/sqlstore"):
        pass


def test_cmd_run_lazy_flaky_early_stop_and_precompiled_go_binary(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    _git(wt, "init", "-q", "-b", "main")
    (hdir / "A").mkdir(parents=True)
    (hdir / "A" / "response.json").write_text(json.dumps({
        "files": [{"path": "calc/hunt_hunta_test.go", "content": "package calc\nfunc TestHuntA_F(t *testing.T) {}\n"}]
    }))
    state = {"wt": str(wt), "targets": [{"dir": "calc", "lang": "go"}], "changed": ["calc/calc.go"]}

    compile_calls = {"n": 0}

    def fake_compile(*a, **k):
        compile_calls["n"] += 1
        return tmp_path / "fake.test"

    monkeypatch.setattr(run, "go_compile_binary", fake_compile)
    calls = {"n": 0}

    def fake_go_run(w, patterns, race, into, timeouts=None, *, bins=None, failfast=False):
        calls["n"] += 1
        assert bins and "calc" in bins
        if calls["n"] == 1:
            into.results["calc::TestHuntA_F"] = "FAIL"
            into.messages["calc::TestHuntA_F"] = "failed on run 1"
        else:
            into.results["calc::TestHuntA_F"] = "PASS"
        into.runtimes["calc"] = 0.1

    monkeypatch.setattr(run, "go_run", fake_go_run)
    table = run.cmd_run(hdir, state, "A", runs=3)
    assert compile_calls["n"] == 1
    assert calls["n"] == 3  # run 1 FAIL, run 2 filtered PASS -> full confirm PASS (stops before run 3 filtered)
    assert table == {"calc::TestHuntA_F": "FLAKY"}
    assert json.loads((hdir / "run_A.messages.json").read_text()) == {"calc::TestHuntA_F": "failed on run 1"}


def test_run_suite_concurrent_go_and_jest(tmp_path, monkeypatch):
    s = run.Suite(go_patterns={"calc": "^TestA$"}, jest_files=["web/a.test.tsx"], jest_prefix="HuntA_")
    monkeypatch.setattr(run, "go_run", lambda w, p, r, into, *a, **k: into.results.update({"calc::TestA": "PASS"}))
    monkeypatch.setattr(run, "jest_run", lambda w, f, p, into, *a, **k: into.results.update({"web/a.test.tsx::HuntA_1": "PASS"}))
    o = run.run_suite(tmp_path, s, race=False)
    assert o.results == {"calc::TestA": "PASS", "web/a.test.tsx::HuntA_1": "PASS"}


def test_fuzz_time_stays_60s_default_and_fuzz_only_cmd_run(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_FUZZ_TIME", raising=False)
    assert run.fuzz_time() == "60s"
    monkeypatch.delenv("HUNT_FUZZ", raising=False)
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    _git(wt, "init", "-q", "-b", "main")
    (hdir / "A").mkdir(parents=True)
    (hdir / "A" / "response.json").write_text(json.dumps({
        "files": [{"path": "calc/hunt_hunta_test.go",
                   "content": "package calc\nfunc huntCheckA_X(t *testing.T, n int) {}\n"
                              "func FuzzHuntA_X(f *testing.F) {}\n"}]
    }))
    state = {"wt": str(wt), "targets": [{"dir": "calc", "lang": "go"}], "changed": ["calc/calc.go"]}
    monkeypatch.setattr(run, "cmd_fuzz", lambda *a, **k: {"targets": {"FuzzHuntA_X": "PASS"}, "frozen": []})
    assert run.cmd_run(hdir, state, "A", runs=3) == {}


def test_main_diff_lock_scope_and_fuzz_empty_response(tmp_path, monkeypatch, capsys):
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    wt.mkdir(parents=True)
    _git(wt, "init", "-q", "-b", "main")
    (hdir / "D").mkdir(parents=True)
    (hdir / "A").mkdir(parents=True)
    (hdir / "state.json").write_text(json.dumps({"wt": str(wt), "changed": ["calc/calc.go"], "targets": []}))
    (hdir / "A" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_hunta_test.go", "content": "package calc\n"}]}))
    (hdir / "diff_D.examples.json").write_text("{}")

    scopes: list[str] = []
    tags: list[str] = []

    @contextmanager
    def fake_lock(hd, pr, scope="wt", *, tag=""):
        scopes.append(scope)
        tags.append(tag)
        yield

    monkeypatch.setattr(hunt_common, "hunt_lock", fake_lock)
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(run, "cmd_diff", lambda *a, **k: {})
    run.main(["run.py", "diff", "1", "D"])
    assert scopes == ["all"] and tags == ["D"]

    monkeypatch.setattr(run, "cmd_run", lambda *a, **k: {})
    capsys.readouterr()
    run.main(["run.py", "run", "1", "A"])
    out = capsys.readouterr().out
    assert "EMPTY_RESPONSE" not in out
    assert "no tests in the hunter response" not in out
    assert "[A] 1 fuzz file(s) ran with 0 frozen failures" in out

    (hdir / "fuzz_A.json").write_text(json.dumps({"targets": {"FuzzHuntA_X": "SKIPPED wrong mode",
                                                              "FuzzHuntA_Y": "SKIPPED stateful"}}))
    run.main(["run.py", "run", "1", "A"])
    assert "[A] 2 fuzz target(s) skipped (0 executed); see fuzz_A.json" in capsys.readouterr().out
    (hdir / "fuzz_A.json").write_text(json.dumps({"targets": {"FuzzHuntA_X": "PASS", "FuzzHuntA_Y": "SKIPPED x"}}))
    run.main(["run.py", "run", "1", "A"])
    assert "[A] 1 fuzz target(s) ran with 0 frozen failures (1 skipped)" in capsys.readouterr().out
    (hdir / "fuzz_A.json").write_text(json.dumps({"targets": {"FuzzHuntA_X": "ERROR build/run boom"}}))
    run.main(["run.py", "run", "1", "A"])
    assert "[A] 1 fuzz target(s) failed with ERROR; see fuzz_A.json" in capsys.readouterr().out
    monkeypatch.setattr(run, "cmd_mutants", lambda *a, **k: [])
    run.main(["run.py", "mutants", "1", "A"])
    assert scopes[-1] == "all" and tags[-1] == "A"


def test_score_mutant_single_compile_priority_and_vacuous_failfast(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg1").mkdir(parents=True)
    (wt / "pkg1" / "a.go").write_text("package pkg1\nfunc F() int { return 1 }\n")
    suite = run.Suite(go_patterns={"pkg1": "^TestA$", "pkg2": "^TestB$"})
    base = run.Outcome(results={"pkg1::TestA": "PASS", "pkg2::TestB": "PASS"},
                       packages={"pkg1": "PASS", "pkg2": "PASS"})
    state = {"changed": ["pkg1/a.go"]}
    m = {"id": "M1", "held_back": False, "file": "pkg1/a.go", "old": "return 1", "new": "return 2", "what_breaks": "x"}

    monkeypatch.setattr(run, "go_compile_binary", lambda *a, **k: tmp_path / "m.test")
    monkeypatch.setattr(run, "go_compiles", lambda *a, **k: pytest.fail("should not call go_compiles()"))
    seen_calls: list[tuple[dict[str, str], bool]] = []

    def fake_run_suite(w, s, race, go_timeouts=None, *, go_bins=None, failfast=False):
        seen_calls.append((dict(s.go_patterns), failfast))
        return run.Outcome(results={"pkg1::TestA": "FAIL"}, packages={"pkg1": "FAIL"})

    monkeypatch.setattr(run, "run_suite", fake_run_suite)
    v = run.score_mutant(wt, state, suite, base, m, vacuous=frozenset({"pkg2::TestB"}))
    assert v["verdict"] == "KILLED" and v["killers"] == ["pkg1::TestA"]
    assert seen_calls == [({"pkg1": "^TestA$"}, True)]


def test_score_mutant_no_failfast_when_package_already_fails_on_head(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg1").mkdir(parents=True)
    (wt / "pkg1" / "a.go").write_text("package pkg1\nfunc F() int { return 1 }\n")
    suite = run.Suite(go_patterns={"pkg1": "^(TestA|TestOld)$", "pkg2": "^TestB$"})
    base = run.Outcome(results={"pkg1::TestA": "PASS", "pkg1::TestOld": "FAIL", "pkg2::TestB": "PASS"})
    m = {"id": "M1", "held_back": False, "file": "pkg1/a.go", "old": "return 1", "new": "return 2", "what_breaks": "x"}
    monkeypatch.setattr(run, "go_compile_binary", lambda *a, **k: tmp_path / "m.test")
    seen: dict[str, bool] = {}

    def fake_run_suite(w, s, race, go_timeouts=None, *, go_bins=None, failfast=False):
        seen[next(iter(s.go_patterns))] = failfast
        return run.Outcome(results={n: r for n, r in base.results.items() if n.split("::")[0] in s.go_patterns})

    monkeypatch.setattr(run, "run_suite", fake_run_suite)
    assert run.score_mutant(wt, {"changed": ["pkg1/a.go"]}, suite, base, m)["verdict"] == "SURVIVED"
    assert seen == {"pkg1": False, "pkg2": True}


def test_go_run_binary_default_timeout_paniconexit_and_lock_excluded_from_runtime(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module x\n")
    clock = {"t": 0.0}
    monkeypatch.setattr(run.time, "monotonic", lambda: clock["t"])

    @contextmanager
    def slow_lock(d):
        clock["t"] += 100.0
        yield

    seen: list[list[str]] = []

    def fake_sh(args, cwd, **k):
        seen.append(args)
        clock["t"] += 2.0
        return subprocess.CompletedProcess(args, 0, "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\n", "")

    monkeypatch.setattr(run, "maybe_pg_pool_lock", slow_lock)
    monkeypatch.setattr(run, "sh", fake_sh)
    monkeypatch.delenv("GOFLAGS", raising=False)
    o = run.Outcome()
    run.go_run(wt, {"pkg": "^TestA$"}, False, o, bins={"pkg": tmp_path / "pkg.test"})
    assert "-test.paniconexit0" in seen[0] and "-test.timeout=10m" in seen[0]
    assert o.results == {"pkg::TestA": "PASS"} and o.runtimes["pkg"] == 2.0
    monkeypatch.setenv("GOFLAGS", "-count=1 -timeout=45s")
    run.go_run(wt, {"pkg": "^TestA$"}, False, run.Outcome(), bins={"pkg": tmp_path / "pkg.test"})
    assert "-test.timeout=45s" in seen[1]
    monkeypatch.setenv("GOFLAGS", "-short")
    run.go_run(wt, {"pkg": "^TestA$"}, False, run.Outcome(), bins={"pkg": tmp_path / "pkg.test"})
    assert seen[2][:2] == ["go", "test"]


def test_go_test_coverage_holds_pg_pool_lock_in_both_branches(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "pkg").mkdir(parents=True)
    (wt / "go.mod").write_text("module x\n")
    events: list[str] = []

    @contextmanager
    def fake_lock(d):
        events.append(f"enter:{d}")
        yield
        events.append("exit")

    def fake_sh(args, cwd, **k):
        if "-c" in args and "-o" in args:
            events.append("compile")
            Path(args[args.index("-o") + 1]).write_text("bin")
        else:
            events.append("sh")
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(run, "maybe_pg_pool_lock", fake_lock)
    monkeypatch.setattr(run, "sh", fake_sh)
    run.go_test_coverage(wt, "pkg", "TestA", {"pkg/a.go": {1}}, prebuilt=(tmp_path / "b.test", ["pkg/a.go"]))
    run.go_test_coverage(wt, "pkg", "TestA", {"pkg/a.go": {1}})
    assert events == ["enter:pkg", "sh", "exit", "compile", "enter:pkg", "sh", "exit"]


def test_suite_for_allows_fuzz_only_companion_go_file(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_FUZZ", raising=False)
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    det = wt / "calc" / "hunt_hunta_test.go"
    det.write_text("package calc\nfunc TestHuntA_D(t *testing.T) {}\n")
    fz = wt / "calc" / "hunt_huntafuzz_test.go"
    fz.write_text("package calc\nfunc FuzzHuntA_X(f *testing.F) {}\n")
    assert run.suite_for("A", {}, [det, fz], wt).go_patterns == {"calc": "^TestHuntA_"}
    bad = wt / "calc" / "hunt_huntabad_test.go"
    bad.write_text("package calc\nfunc TestOther(t *testing.T) {}\n")
    with pytest.raises(run.CompileError):
        run.suite_for("A", {}, [det, bad], wt)
    with pytest.raises(run.CompileError):
        run.suite_for("B", {}, [fz], wt)


def test_merge_phase_tables_keeps_unanimous_message_and_flaky_package(tmp_path):
    table = {"pkg::(package failed)": "FLAKY", "pkg::TestD": "FAIL_3_OF_3"}
    msgs = {"pkg::TestD": "det fail"}
    runtimes = {"pkg": 1.0}
    run._merge_phase_tables(
        table, msgs, runtimes,
        {"pkg::(package failed)": "FAIL_3_OF_3", "pkg::TestF": "FAIL_3_OF_3"},
        {"pkg::(package failed)": "frozen unanimous", "pkg::TestF": "fuzz fail"},
        {"pkg": 2.5},
    )
    assert table["pkg::(package failed)"] == "FAIL_3_OF_3"
    assert msgs["pkg::(package failed)"] == "frozen unanimous"
    assert msgs["pkg::TestF"] == "fuzz fail"
    assert runtimes["pkg"] == 2.5

    t2, m2, r2 = {"pkg::(package failed)": "PASS"}, {}, {}
    run._merge_phase_tables(t2, m2, r2, {"pkg::(package failed)": "FLAKY"}, {}, {})
    assert t2["pkg::(package failed)"] == "FLAKY"


def test_persisted_frozen_fuzz_runs_isolated_on_rerun_and_mutant_compiles_all_packages(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_FUZZ", raising=False)
    hdir = tmp_path / "h"
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    _git(wt, "init", "-q", "-b", "main")
    (hdir / "A").mkdir(parents=True)
    (hdir / "A" / "response.json").write_text(json.dumps({
        "files": [{"path": "calc/hunt_hunta_test.go",
                   "content": "package calc\nfunc TestHuntA_Det(t *testing.T) {}\n"
                              "func huntCheckA_X(t *testing.T, n int) {}\n"
                              "func FuzzHuntA_X(f *testing.F) {}\n"
                              "func TestHuntA_X_Fuzz12345678(t *testing.T) {}\n"}]
    }))
    state = {"wt": str(wt), "targets": [{"dir": "calc", "lang": "go"}], "changed": ["calc/calc.go"]}
    monkeypatch.setattr(run, "cmd_fuzz", lambda *a, **k: {"targets": {"FuzzHuntA_X": "SKIPPED already frozen"}, "frozen": []})
    seen_phases: list[set[str] | None] = []

    def fake_lazy(hd, w, st, tg, fl, rns, *, frozen_only=None):
        seen_phases.append(frozen_only)
        if frozen_only:
            return {"calc::TestHuntA_X_Fuzz12345678": "FAIL_3_OF_3"}, {"calc::TestHuntA_X_Fuzz12345678": "isolated boom"}, {}, set(), []
        return {"calc::TestHuntA_Det": "PASS", "calc::TestHuntA_X_Fuzz12345678": "PASS"}, {}, {}, set(), []

    monkeypatch.setattr(run, "_run_lazy_phase", fake_lazy)
    table = run.cmd_run(hdir, state, "A", runs=3)
    assert seen_phases == [None, {"TestHuntA_X_Fuzz12345678"}]
    assert table["calc::TestHuntA_X_Fuzz12345678"] == "FAIL_3_OF_3"

    # Mutant that compiles in pkg1 but breaks pkg2 build returns NEEDS_REGENERATION instead of KILLED
    (wt / "pkg1").mkdir()
    (wt / "pkg1" / "a.go").write_text("package pkg1\nfunc F() int { return 1 }\n")
    suite = run.Suite(go_patterns={"pkg1": "^TestA$", "pkg2": "^TestB$"})
    base = run.Outcome(results={"pkg1::TestA": "PASS", "pkg2::TestB": "PASS"}, packages={"pkg1": "PASS", "pkg2": "PASS"})
    m = {"id": "M1", "held_back": False, "file": "pkg1/a.go", "old": "return 1", "new": "return 2", "what_breaks": "x"}

    def fake_compile(w, d, race, out_bin):
        if d == "pkg2":
            raise run.GoBuildError("pkg2 broken symbol", "pkg2")
        return out_bin

    monkeypatch.setattr(run, "go_compile_binary", fake_compile)
    monkeypatch.setattr(run, "run_suite", lambda *a, **k: pytest.fail("should fail compile before running tests"))
    assert run.score_mutant(wt, {"changed": ["pkg1/a.go"]}, suite, base, m)["verdict"] == "NEEDS_REGENERATION"


def test_npm_ci_uses_prefer_offline(tmp_path, monkeypatch):
    webapp = tmp_path / "webapp"
    webapp.mkdir()
    (webapp / "package-lock.json").write_text("{}")
    calls: list[list[str]] = []
    monkeypatch.setattr(prepare, "sh", lambda args, *a, **k: calls.append(args))
    prepare.npm_ci_for_lock(webapp)
    assert calls and "--prefer-offline" in calls[0]


def test_callers_git_grep_and_non_git_fallback(tmp_path):
    repo = tmp_path / "repo"
    (repo / "pkg" / "mocks").mkdir(parents=True)
    (repo / "pkg" / "a.go").write_text("package pkg\nfunc Target() {}\n")
    (repo / "pkg" / "b.go").write_text("package pkg\nfunc Use1() { Target() }\n")
    (repo / "pkg" / "b_test.go").write_text("package pkg\nfunc TestUse() { Target() }\n")
    (repo / "pkg" / "mocks" / "m.go").write_text("package mocks\nfunc MockUse() { Target() }\n")
    (repo / ".gitignore").write_text("zz_*.go\nnode_modules/\n")
    (repo / "pkg" / "node_modules").mkdir(parents=True)
    (repo / "pkg" / "node_modules" / "skip.go").write_text("package pkg\nfunc IgnoredNM() { Target() }\n")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", ".gitignore", "pkg/a.go", "pkg/b.go", "pkg/b_test.go", "pkg/mocks/m.go")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    (repo / "pkg" / "c.go").write_text("package pkg\nfunc Use2() { Target() }\n")
    (repo / "pkg" / "zz_gen.go").write_text("package pkg\nfunc Gen() { Target() }\n")

    assert ctx.grep_word(repo, "Target", ["pkg"]) == [
        ("pkg/a.go", 2), ("pkg/b.go", 2), ("pkg/c.go", 2), ("pkg/zz_gen.go", 2),
    ]

    nongit = tmp_path / "nongit"
    (nongit / "pkg").mkdir(parents=True)
    (nongit / "pkg" / "a.go").write_text("package pkg\nfunc Target() {}\n")
    (nongit / "pkg" / "b.go").write_text("package pkg\nfunc Use1() { Target() }\n")
    assert ctx.grep_word(nongit, "Target", ["pkg"]) == [("pkg/a.go", 2), ("pkg/b.go", 2)]


def test_jest_bin_batched_jest_run_and_v8_cover_fallback(tmp_path, monkeypatch):
    root = tmp_path / "webapp"
    (root / "src").mkdir(parents=True)
    (root / "jest.config.js").write_text("module.exports = {};\n")
    assert run._jest_bin(root) == ["npx", "jest"]
    (root / "node_modules" / ".bin").mkdir(parents=True)
    local_jest = root / "node_modules" / ".bin" / "jest"
    local_jest.write_text("#!/bin/sh\n")
    assert run._jest_bin(root) == [str(local_jest)]

    seen_args: list[list[str]] = []

    def fake_sh(args, cwd, **k):
        seen_args.append(args)
        out_arg = next(a for a in args if a.startswith("--outputFile="))
        Path(out_arg.split("=", 1)[1]).write_text(json.dumps({
            "testResults": [
                {"name": str((root / "src" / "a.test.tsx").resolve()), "status": "passed",
                 "assertionResults": [{"title": "HuntA_1", "fullName": "HuntA_1", "status": "passed"}]},
                {"name": str((root / "src" / "b.test.tsx").resolve()), "status": "passed",
                 "assertionResults": [{"title": "HuntA_2", "fullName": "HuntA_2", "status": "passed"}]},
            ]
        }))
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(run, "sh", fake_sh)
    into = run.Outcome()
    run.jest_run(root, ["src/a.test.tsx", "src/b.test.tsx"], "HuntA_", into)
    assert len(seen_args) == 1
    assert "--bail=1" not in seen_args[0] and "--bail=false" in seen_args[0]
    assert "src/a.test.tsx" in seen_args[0] and "src/b.test.tsx" in seen_args[0]

    # Grouped Jest run missing one file retries that file individually instead of raising CompileError
    retry_calls: list[list[str]] = []

    def fake_retry_sh(args, cwd, **k):
        retry_calls.append(args)
        out_arg = next(a for a in args if a.startswith("--outputFile="))
        only_b = len([a for a in args if a.endswith(".test.tsx")]) == 1 and "src/b.test.tsx" in args
        results = [
            {"name": str((root / ("src/b.test.tsx" if only_b else "src/a.test.tsx")).resolve()), "status": "passed",
             "assertionResults": [{"title": "HuntA_2" if only_b else "HuntA_1", "fullName": "HuntA_2" if only_b else "HuntA_1", "status": "passed"}]},
        ]
        Path(out_arg.split("=", 1)[1]).write_text(json.dumps({"testResults": results}))
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(run, "sh", fake_retry_sh)
    retry_into = run.Outcome()
    run.jest_run(root, ["src/a.test.tsx", "src/b.test.tsx"], "HuntA_", retry_into)
    assert len(retry_calls) == 2 and retry_into.results == {
        "src/a.test.tsx::HuntA_1": "PASS",
        "src/b.test.tsx::HuntA_2": "PASS",
    }

    (root / "src" / "prod.ts").write_text("export const x = 1;\n")

    def fake_cov_sh(args, cwd, **k):
        if "--showConfig" in args:
            return subprocess.CompletedProcess(args, 0, json.dumps({"configs": [{"setupFilesAfterEnv": []}]}), "")
        cov_dir = Path(next(a for a in args if a.startswith("--coverageDirectory=")).split("=", 1)[1])
        (cov_dir / "coverage-final.json").write_text(json.dumps({
            str((root / "src" / "prod.ts").resolve()): {
                "statementMap": {"0": {"start": {"line": 1}, "end": {"line": 1}}},
                "s": {"0": 0},
            }
        }))
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(run, "sh", fake_cov_sh)
    monkeypatch.setattr(run, "jest_test_coverage", lambda *a, **k: pytest.fail("should not fall back to per-test"))
    cov = run._jest_file_coverage(root, "src/a.test.tsx", [("src/a.test.tsx::HuntA_1", "HuntA_1"),
                                                          ("src/a.test.tsx::HuntA_2", "HuntA_2")],
                                  {"src/prod.ts": {1}})
    assert cov["src/a.test.tsx::HuntA_1"]["src/prod.ts"] == ({1}, set())
    assert cov["src/a.test.tsx::HuntA_2"]["src/prod.ts"] == ({1}, set())


def test_jest_file_coverage_preserves_setup_files_and_partial_events(tmp_path, monkeypatch):
    root = tmp_path / "webapp"
    (root / "src").mkdir(parents=True)
    (root / "jest.config.js").write_text("module.exports = {};\n")
    (root / "src" / "prod.ts").write_text("export const x = 1;\n")
    abs_prod = str((root / "src" / "prod.ts").resolve())
    seen_args: list[list[str]] = []

    def fake_sh(args, cwd, **k):
        seen_args.append(args)
        if "--showConfig" in args:
            return subprocess.CompletedProcess(args, 0, json.dumps({"configs": [{"setupFilesAfterEnv": ["setupTests.js"]}]}), "")
        out = Path(k.get("env", {}).get("HUNT_COVER_OUT", ""))
        out.write_text(json.dumps({"test": "HuntA_1", "hits": {abs_prod: {"inst": [1], "hit": [1]}}}) + "\n")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(run, "sh", fake_sh)
    called_fallback: list[str] = []
    monkeypatch.setattr(run, "jest_test_coverage", lambda wt, rel, name, changed: called_fallback.append(name) or {"src/prod.ts": ({1}, {1})})

    tests = [("src/a.test.tsx::HuntA_1", "HuntA_1"), ("src/a.test.tsx::HuntA_2", "HuntA_2")]
    res = run._jest_file_coverage(root, "src/a.test.tsx", tests, {"src/prod.ts": {1}})
    test_run_args = [a for a in seen_args if "--runTestsByPath" in a][0]
    setups = [a.split("=", 1)[1] for a in test_run_args if a.startswith("--setupFilesAfterEnv=")]
    assert setups[0] == "setupTests.js" and setups[1].endswith("hook.cjs")
    assert res["src/a.test.tsx::HuntA_1"]["src/prod.ts"] == ({1}, {1})
    assert called_fallback == ["HuntA_2"]


def test_jest_cov_hook_isolates_lazy_hits_across_tests(tmp_path):
    hook = tmp_path / "hook.cjs"
    hook.write_text(run._JEST_COV_HOOK)
    out = tmp_path / "events.jsonl"
    driver = tmp_path / "driver.cjs"
    driver.write_text(f"""
const be = [], ae = [];
global.beforeEach = f => be.push(f);
global.afterEach = f => ae.push(f);
let name = '';
global.expect = {{getState: () => ({{currentTestName: name}})}};
require({json.dumps(str(hook))});
const run = (n, body) => {{ name = n; be.forEach(f => f()); body(); ae.forEach(f => f()); }};
run('t1', () => {{
  global.__coverage__ = {{'/src/a.ts': {{s: {{'0': 1}}, statementMap: {{'0': {{start: {{line: 1}}, end: {{line: 1}}}}}}}}}};
}});
run('t2', () => {{}});
""")
    env = {**hunt_common.node_env(), "HUNT_COVER_OUT": str(out), "HUNT_COVER_FILES": json.dumps(["/src/a.ts"])}
    subprocess.run(["node", str(driver)], check=True, env=env)
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert rows[0]["hits"]["/src/a.ts"]["hit"] == [1]
    assert rows[1]["hits"]["/src/a.ts"]["hit"] == []


def test_jest_file_coverage_falls_back_when_afterall_hits_unattributed_changed_line(tmp_path, monkeypatch):
    root = tmp_path / "webapp"
    (root / "src").mkdir(parents=True)
    (root / "jest.config.js").write_text("module.exports = {};\n")
    (root / "src" / "prod.ts").write_text("export const a = 1;\nexport const b = 2;\n")
    abs_prod = str((root / "src" / "prod.ts").resolve())

    def fake_sh(args, cwd, **k):
        if "--showConfig" in args:
            return subprocess.CompletedProcess(args, 0, json.dumps({"configs": [{"setupFilesAfterEnv": []}]}), "")
        out = Path(k.get("env", {}).get("HUNT_COVER_OUT", ""))
        out.write_text(
            json.dumps({"test": "HuntA_1", "hits": {abs_prod: {"inst": [1, 2], "hit": [1]}}}) + "\n"
            + json.dumps({"test": "HuntA_2", "hits": {abs_prod: {"inst": [1, 2], "hit": [1]}}}) + "\n"
        )
        cov_dir = Path(next(a for a in args if a.startswith("--coverageDirectory=")).split("=", 1)[1])
        (cov_dir / "coverage-final.json").write_text(json.dumps({
            abs_prod: {
                "statementMap": {"0": {"start": {"line": 1}, "end": {"line": 1}},
                                 "1": {"start": {"line": 2}, "end": {"line": 2}}},
                "s": {"0": 1, "1": 1},
            }
        }))
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(run, "sh", fake_sh)
    fallback_names: list[str] = []
    monkeypatch.setattr(run, "jest_test_coverage", lambda wt, rel, name, ch: fallback_names.append(name) or {"src/prod.ts": ({1, 2}, {1, 2})})
    cov = run._jest_file_coverage(
        root, "src/a.test.tsx",
        [("src/a.test.tsx::HuntA_1", "HuntA_1"), ("src/a.test.tsx::HuntA_2", "HuntA_2")],
        {"src/prod.ts": {1, 2}},
    )
    assert fallback_names == ["HuntA_1", "HuntA_2"]
    assert cov["src/a.test.tsx::HuntA_2"]["src/prod.ts"] == ({1, 2}, {1, 2})
