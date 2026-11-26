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

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import fcntl
import os
import signal
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ctx import changed_go_tests
from hunt_common import InfraError, clean_untracked, git, hunt_dir, hunt_lock, read_state, terminate_handler, write_json
from run import PACKAGE_FAILED, CompileError, Outcome, classify, ensure_clean, go_run
from verdicts import Verdict

FLAG = "ENABLE_FULLY_PARALLEL_TESTS"
PARALLEL_ENV = "HUNT_GO_PARALLEL"
DEFAULT_PARALLEL = 2  # TestMain enables RunParallel when test.parallel > 1; NewTestPool allocates 2 * parallel DBs
MAX_UNITS = 20  # Go packages per hunt; the rest are listed as skipped
RUNS = 3


def parallelism() -> int:
    """Cap -parallel for ENABLE_FULLY_PARALLEL_TESTS so NewTestPool does not exhaust Postgres max_connections on high-CPU
    hosts (clamped >= 2 so TestMain still activates fully parallel mode)."""
    raw = os.environ.get("HUNT_PR_TEST_PARALLEL", "").strip()
    if not raw:
        return DEFAULT_PARALLEL
    try:
        val = int(raw)
    except ValueError as e:
        raise InfraError(f"invalid HUNT_PR_TEST_PARALLEL={raw!r}: expected integer >= 2") from e
    return max(2, val)


@contextmanager
def pg_pool_lock() -> Iterator[None]:
    """Serialize parallel Postgres test-pool runs across concurrent hunts on the same host."""
    lock_path = Path(os.environ.get("HUNT_PG_LOCK") or Path(tempfile.gettempdir()) / f"hunt-pg-pool-{os.getuid()}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


@contextmanager
def ci_env(parallel: bool) -> Iterator[None]:
    """The process environment go test inherits, with the flag on or (whatever the caller exported) off. Mattermost's
    TestMain reads flag.Lookup("test.parallel") BEFORE flag.Parse()/m.Run(), so it sees the flag's default value, which
    Go initializes from GOMAXPROCS. Setting BOTH GOMAXPROCS and -parallel (via HUNT_GO_PARALLEL) to `parallelism()`
    (default 2, >= 2) guarantees RunParallel activates while capping NewTestPool to 2*parallel Postgres stores instead
    of 2*NCPUs (preventing MakeSqlSettings connection exhaustion on multi-core hosts)."""
    saved = {k: os.environ.get(k) for k in (FLAG, "GOMAXPROCS", PARALLEL_ENV)}
    try:
        if parallel:
            par = str(parallelism())
            os.environ[FLAG] = "true"
            os.environ["GOMAXPROCS"] = par
            os.environ[PARALLEL_ENV] = par
        else:
            os.environ.pop(FLAG, None)
            os.environ.pop(PARALLEL_ENV, None)
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
        if parallel:
            with pg_pool_lock():
                go_run(wt, {unit["dir"]: "^(" + "|".join(tests) + ")$"}, False, o)
        else:
            go_run(wt, {unit["dir"]: "^(" + "|".join(tests) + ")$"}, False, o)
    return o


def _run_unit(wt: Path, unit: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    key = unit["key"]
    try:
        heads = [_run(wt, unit, unit["tests"], True) for _ in range(RUNS)]
        names = sorted(set().union(*(h.results for h in heads)))
        seen = {n: classify([h.results.get(n, Verdict.MISSING) for h in heads]) for n in names}
        failing = [n for n in names if seen[n] == Verdict.FAIL_3_OF_3]
        pkg_failed = any(n.endswith(f"::{PACKAGE_FAILED}") for n in failing)
        retest = list(unit["tests"]) if pkg_failed else [n.split("::", 1)[1] for n in failing]
        plain = _run(wt, unit, retest, False) if retest else Outcome()
    except CompileError as e:  # not a finding: generated code or build tags may be missing in this worktree
        return {f"{key}::*": Verdict.NOT_RUN}, {f"{key}::*": str(e)[-1500:]}
    table: dict[str, str] = {}
    msgs: dict[str, str] = {}
    for n in names:
        v = seen[n]
        if v == Verdict.FAIL_3_OF_3:
            without = plain.packages.get(unit["dir"]) if n.endswith(f"::{PACKAGE_FAILED}") else plain.results.get(n)
            ci_map: dict[str, Verdict] = {Verdict.PASS: Verdict.PR_TEST_FAILS_UNDER_CI, Verdict.FAIL: Verdict.PR_TEST_FAILS}
            v = ci_map.get(without or "", Verdict.FLAKY)
        table[n] = v
        failure = next((h.messages[n] for h in heads if n in h.messages), None)
        if v != Verdict.PASS and failure is not None:
            msgs[n] = failure
    return table, msgs


def cmd_pr(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
    wt, repo = Path(state["wt"]), Path(state["repo"])
    ensure_clean(wt)
    units, skipped = plan(repo, state["merge_base"], state["head"])
    if any(u.get("lang") == "go" for u in units):
        parallelism()  # validate config before per-unit error isolation turns it into NOT_RUN
    table: dict[str, str] = {}
    msgs: dict[str, str] = {}
    try:
        for unit in units:
            try:
                t, m = _run_unit(wt, unit)
            except InfraError as e:  # e.g. a test behind a build tag ran 0 tests: lose this unit, keep the others
                t, m = {f"{unit['key']}::*": Verdict.NOT_RUN}, {f"{unit['key']}::*": str(e)[-800:]}
            table.update(t)
            msgs.update(m)
    finally:
        clean_untracked(wt)
    ensure_clean(wt)
    out = {"tests": table, "units": [{k: u[k] for k in ("lang", "key", "tests")} for u in units], "skipped": skipped}
    write_json(hdir / "pr_tests.json", out)
    write_json(hdir / "pr_tests.messages.json", msgs)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, terminate_handler)
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
