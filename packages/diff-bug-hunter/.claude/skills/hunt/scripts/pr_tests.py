#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 4c: the PR's own added or edited Go tests, run on the PR head the way CI runs them.

usage: pr_tests.py <pr>      writes pr_tests.json (verdict per test) and pr_tests.messages.json (head failure text)

No model is involved. Every Go Test function an added or modified *_test.go file adds or changes (any directory, not
only the hunted ones) runs 3 times on the head worktree with ENABLE_FULLY_PARALLEL_TESTS=true: CI's fully parallel mode
gives each test its own store, so a helper that writes through the shared one passes locally and fails there. A test
that fails 3/3 runs once more without the flag, which tells a CI-only failure from a plain one.

Verdicts: PR_TEST_FAILS_UNDER_CI (fails 3/3 with the flag, passes without), PR_TEST_FAILS (fails with and without),
FLAKY, SKIP, PASS, NOT_RUN (the package did not compile or ran no test: the message says why).
Exit codes: 0 ok, 2 INFRA_ERROR.
"""
from __future__ import annotations

import atexit as _atexit
import shutil as _shutil
import sys as _sys
import tempfile as _tempfile

# Never load bytecode from the skill directory: a committed __pycache__/*.pyc (an unchecked-hash .pyc, say) would run
# code the trust gate never compares with the reviewed source. Bytecode caches go to a private temp dir instead.
if not _sys.pycache_prefix:
    _sys.pycache_prefix = _tempfile.mkdtemp(prefix="hunt-pyc-")
    _atexit.register(_shutil.rmtree, _sys.pycache_prefix, True)

import os
import signal
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ctx import changed_go_tests
from hunt_common import InfraError, git, hunt_dir, hunt_lock, read_state, write_json
from run import PACKAGE_FAILED, CompileError, Outcome, classify, ensure_clean, go_run

FLAG = "ENABLE_FULLY_PARALLEL_TESTS"
MAX_UNITS = 20  # Go packages per hunt; the rest are listed as skipped
RUNS = 3


@contextmanager
def ci_env(parallel: bool) -> Iterator[None]:
    """The process environment go test inherits, with the flag on or (whatever the caller exported) off. The test
    binary reads it in TestMain, and only goes parallel when -test.parallel > 1 (GOMAXPROCS by default), so a one-CPU
    machine gets GOMAXPROCS=2 for the flagged runs."""
    saved = {k: os.environ.get(k) for k in (FLAG, "GOMAXPROCS")}
    try:
        if parallel:
            os.environ[FLAG] = "true"
            if (os.cpu_count() or 1) < 2:
                os.environ.setdefault("GOMAXPROCS", "2")
        else:
            os.environ.pop(FLAG, None)
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def plan(repo: Path, mb: str, head: str) -> tuple[list[dict[str, Any]], list[str]]:
    """One unit per directory with added or modified Go test files: the Test functions those files add or change."""
    by_dir: dict[str, set[str]] = {}
    for line in git(repo, "diff", "--name-status", "--no-renames", "--diff-filter=AM", mb, head).splitlines():
        _, _, path = line.partition("\t")
        if not path.endswith("_test.go") or Path(path).name.startswith("hunt_"):
            continue
        found = changed_go_tests(git(repo, "diff", mb, head, "--", path), git(repo, "show", f"{head}:{path}"))
        if found:
            by_dir.setdefault(str(Path(path).parent), set()).update(found)
    units = [{"lang": "go", "key": d, "dir": d, "tests": sorted(t)} for d, t in sorted(by_dir.items())]
    return units[:MAX_UNITS], [f"{u['key']} (over {MAX_UNITS} units)" for u in units[MAX_UNITS:]]


def _run(wt: Path, unit: dict[str, Any], tests: list[str], parallel: bool) -> Outcome:
    o = Outcome()
    with ci_env(parallel):
        go_run(wt, {unit["dir"]: "^(" + "|".join(tests) + ")$"}, False, o)
    return o


def _run_unit(wt: Path, unit: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    key = unit["key"]
    try:
        heads = [_run(wt, unit, unit["tests"], True) for _ in range(RUNS)]
        names = sorted(set().union(*(h.results for h in heads)))
        seen = {n: classify([h.results.get(n, "MISSING") for h in heads]) for n in names}
        failing = [n for n in names if seen[n] == "FAIL_3_OF_3"]
        pkg_failed = any(n.endswith(f"::{PACKAGE_FAILED}") for n in failing)
        retest = list(unit["tests"]) if pkg_failed else [n.split("::", 1)[1] for n in failing]
        plain = _run(wt, unit, retest, False) if retest else Outcome()
    except CompileError as e:  # not a finding: generated code or build tags may be missing in this worktree
        return {f"{key}::*": "NOT_RUN"}, {f"{key}::*": str(e)[-1500:]}
    table, msgs = {}, {}
    for n in names:
        v = seen[n]
        if v == "FAIL_3_OF_3":
            without = plain.packages.get(unit["dir"]) if n.endswith(f"::{PACKAGE_FAILED}") else plain.results.get(n)
            v = {"PASS": "PR_TEST_FAILS_UNDER_CI", "FAIL": "PR_TEST_FAILS"}.get(without or "", "FLAKY")
        table[n] = v
        failure = next((h.messages[n] for h in heads if n in h.messages), None)
        if v != "PASS" and failure is not None:
            msgs[n] = failure
    return table, msgs


def cmd_pr(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
    wt, repo = Path(state["wt"]), Path(state["repo"])
    ensure_clean(wt)
    units, skipped = plan(repo, state["merge_base"], state["head"])
    table: dict[str, str] = {}
    msgs: dict[str, str] = {}
    try:
        for unit in units:
            try:
                t, m = _run_unit(wt, unit)
            except InfraError as e:  # e.g. a test behind a build tag ran 0 tests: lose this unit, keep the others
                t, m = {f"{unit['key']}::*": "NOT_RUN"}, {f"{unit['key']}::*": str(e)[-800:]}
            table.update(t)
            msgs.update(m)
    finally:
        _clean(wt)
    ensure_clean(wt)
    out = {"tests": table, "units": [{k: u[k] for k in ("lang", "key", "tests")} for u in units], "skipped": skipped}
    write_json(hdir / "pr_tests.json", out)
    write_json(hdir / "pr_tests.messages.json", msgs)
    return out


def _clean(wt: Path) -> None:
    """A run can leave untracked files (a fuzz cache, a test's output) next to the tests: remove them."""
    for line in git(wt, "status", "--porcelain", "--untracked-files=all").splitlines():
        rel = line[3:]
        if line.startswith("??") and "node_modules" not in rel and "go.work" not in rel:
            (wt / rel).unlink(missing_ok=True)


def _terminate(signum: int, _frame: Any) -> None:
    raise SystemExit(128 + signum)  # unwind through ci_env, which puts the environment back


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _terminate)
    hdir = hunt_dir(argv[1])
    try:
        with hunt_lock(hdir, argv[1]):
            out = cmd_pr(hdir, read_state(hdir))
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    if not out["units"]:
        print("[pr] the PR adds or edits no Go test: nothing to run")
    for n, v in out["tests"].items():
        print(f"[pr] {n}: {v}")
    for k in out["skipped"]:
        print(f"[pr] skipped: {k}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
