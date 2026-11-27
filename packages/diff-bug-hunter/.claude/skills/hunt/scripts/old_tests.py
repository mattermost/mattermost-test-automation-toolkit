#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 4b: the merge-base version of every existing test the PR edits or deletes, run on the PR head.

usage: old_tests.py <pr>      writes old_tests.json (verdict per test) and old_tests.messages.json (head failure text)

No model is involved: the oracle is the base branch's own test. When a PR has to edit an existing test to pass, the
old test failing on the new code shows the behaviour change the edit absorbed. That is a finding to explain, not a bug
by itself: an intended change fails the same way, so the report sets it against the PR description.

Per Go package with edited or deleted *_test.go files, the head worktree gets the merge-base set of test files (edited
ones reverted, deleted ones restored, PR-added ones moved aside, since they may use the PR's new helpers) on top of the
head production code. Only the Test functions whose body changed, that were deleted, or that call a changed helper of
the same file run: 3 times on head without -race, then once on the merge-base. Jest: each edited or deleted
*.test.[jt]s(x) file runs whole, with its snapshot file reverted too.

Store tests live in non-_test.go files under a storetest/ dir and are called from other packages' tests
(`StoreTest(t, storetest.TestStatusStore)`): an edited or deleted storetest file is swapped back to its merge-base
version too, and the Test functions under its parent dir that reference a changed exported function run as candidates.

A swapped Go package that does not compile is salvaged per function: the compiler errors are mapped to the top-level
functions that hold them, those are deleted from the swapped copies, and the package is retried (SALVAGE_ROUNDS at
most). Only the deleted Test functions are OLD_TEST_UNCOMPILABLE; an error outside the swapped files (or with no Test
function left) loses the whole unit, as before. Test files of generated layers (retrylayer, timerlayer, ...) are not run:
their tests fire mechanically whenever a store method is added.

Verdicts: OLD_TEST_BREAKS (fails 3/3 on head, passes on base), OLD_TEST_SOMETIMES_BREAKS (fails on head in some of the
3 runs, passes 3/3 on base: a probabilistic break), PASS, FLAKY, SKIP, PRE_EXISTING (fails on base too),
NOT_RUN_ON_BASE, OLD_TEST_UNCOMPILABLE (the head API no longer fits the old test: the detail says why), NOT_RUN.
Exit codes: 0 ok, 2 INFRA_ERROR.
"""
from __future__ import annotations

import sys

# Never load bytecode from the skill directory: a committed __pycache__/*.pyc (an unchecked-hash .pyc, say) would run
# code the trust gate never compares with the reviewed source. Disabling writes + non-existent prefix blocks loading too.
sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import prefilter
from ctx import GO_TEST, go_bodies, is_generated, top_blocks
from hunt_common import (
    InfraError,
    clean_untracked,
    git,
    git_cmd,
    git_env,
    hunt_dir,
    read_state,
    run_locked_cli,
    sh,
    under,
    write_json,
)
from run import (
    GO_UNUSED_IMPORT,
    PACKAGE_FAILED,
    CompileError,
    Outcome,
    classify,
    ensure_clean,
    go_build_errors,
    go_compile_binary,
    go_root,
    go_run,
    jest_run,
    parse_go_errors,
)
from verdicts import Verdict

_REAL_GO_RUN = go_run

JEST_TEST = re.compile(r"\.test\.[jt]sx?$")
MAX_UNITS = 20  # Go packages plus Jest files per hunt; the rest are listed as skipped
RUNS = 3
SALVAGE_ROUNDS = 3  # compile, delete the functions the compiler names, retry: at most this many deletions rounds
GO_ERR = re.compile(r"^(?:vet: )?(\S+?\.go):(\d+):(?:\d+:)? (.+)$", re.M)  # path.go:LINE:COL: message


def edited_tests(repo: Path, mb: str, head: str) -> dict[str, str]:
    """Existing test files (and Jest snapshots) the PR modifies or deletes, plus the test files it adds: path -> M/D/A."""
    out: dict[str, str] = {}
    for line in git(repo, "diff", "--name-status", "--no-renames", mb, head).splitlines():
        status, _, path = line.partition("\t")
        name = Path(path).name
        if name.startswith("hunt_"):
            continue
        if path.endswith("_test.go") or JEST_TEST.search(path) or (path.endswith(".snap") and "__snapshots__" in path):
            out[path] = status[:1]
    return out


def go_candidates(base_src: str, head_src: str | None) -> list[str]:
    """Test functions of the base file to run: their body changed or is gone at head, or they call a helper (a non-test
    top-level function of the same file) that changed or is gone. TestMain changing makes every test a candidate."""
    base, head = go_bodies(base_src), go_bodies(head_src or "")
    tests = {}
    for name, body in base.items():
        m = GO_TEST.match(body.split("\n", 1)[0])
        if m:
            tests[name] = (m.group(1), body)
    changed = {n for n, b in base.items() if head.get(n) != b}
    if "TestMain" in changed:
        return sorted(t for t, _ in tests.values())
    helpers = {n.split(".")[-1] for n in changed if n not in tests}
    out = set()
    for name, (test, body) in tests.items():
        rest = body.split("{", 1)[1] if "{" in body else ""
        if name in changed or any(re.search(rf"\b{re.escape(h)}\(", rest) for h in helpers):
            out.add(test)
    return sorted(out)


SUPPORT_DIRS = ("storetest", "searchtest")  # packages of store/search tests that other packages' tests call


def support_dir(path: str) -> str | None:
    """The first SUPPORT_DIRS name among the path's parent directories, if any."""
    return next((d for d in Path(path).parent.parts if d in SUPPORT_DIRS), None)


def support_files(repo: Path, mb: str, head: str) -> dict[str, str]:
    """Edited or deleted non-test Go files under a storetest/ or searchtest/ dir, which hold store tests that other packages call:
    path -> M/D. Generated files (the mocks) are left out by the caller, which reads the base source."""
    out: dict[str, str] = {}
    for line in git(repo, "diff", "--name-status", "--no-renames", mb, head).splitlines():
        status, _, path = line.partition("\t")
        p = Path(path)
        if (status[:1] in ("M", "D") and path.endswith(".go") and not path.endswith("_test.go")
                and support_dir(path) is not None and not p.name.startswith("hunt_")):
            out[path] = status[:1]
    return out


def support_scope(path: str) -> str:
    """The directory whose tests may call a support file: the parent of its support dir."""
    parts = Path(path).parts
    i = parts.index(support_dir(path) or "")
    return str(Path(*parts[:i])) if i else "."


def support_exports(base_src: str, head_src: str | None) -> set[str]:
    """Exported top-level functions another package can reference whose behaviour differs at head: the ones whose body
    changed or is gone, plus those that call (even through unexported helpers) a changed function of the same file."""
    base, head = go_bodies(base_src), go_bodies(head_src or "")
    plain = {n: b for n, b in base.items() if "." not in n and "#" not in n}
    changed = {n for n, b in plain.items() if head.get(n) != b}
    grew = True
    while grew:
        grew = False
        for n, b in plain.items():
            if n not in changed and any(re.search(rf"\b{re.escape(c)}\b", b) for c in changed):
                changed.add(n)
                grew = True
    return {n for n in changed if n[:1].isupper()}


def store_callers(repo: Path, head: str, scope: str, names: set[str], pkg: str = "storetest") -> dict[str, dict[str, str]]:
    """Test functions under `scope` whose body references <pkg>.<name>: package dir -> {Test function: file}."""
    out: dict[str, dict[str, str]] = {}
    ref = re.compile(rf"\b{pkg}\.(?:" + "|".join(re.escape(n) for n in sorted(names)) + r")\b")
    p = sh(git_cmd("grep", "-l", "-e", rf"{pkg}\.", head, "--", scope), repo, check=False)
    for line in p.stdout.splitlines():
        path = line.split(":", 1)[1] if ":" in line else line
        if not path.endswith("_test.go"):
            continue
        for body in go_bodies(git(repo, "show", f"{head}:{path}")).values():
            m = GO_TEST.match(body)
            if m and ref.search(body):  # the whole body: `func TestX(t *testing.T) { storetest.F(t) }` is one line
                out.setdefault(str(Path(path).parent), {})[m.group(1)] = path
    return out


def generated_layer(repo: Path, revs: list[str], d: str) -> bool:
    """A dir like store/retrylayer whose non-test Go source is generated: its tests fire whenever the interface grows."""
    if not Path(d).name.endswith("layer"):
        return False
    for rev in revs:
        for f in git(repo, "ls-tree", "--name-only", rev, f"{d}/", check=False).splitlines():
            if (f.endswith(".go") and not f.endswith("_test.go")
                    and is_generated(git(repo, "show", f"{rev}:{f}", check=False).split("\n")[:60])):
                return True
    return False


class Swap:
    """Put merge-base test files into the head worktree, and always put the head versions back."""

    def __init__(self, wt: Path, repo: Path, mb: str):
        self.wt, self.repo, self.mb = wt, repo, mb
        self.saved: list[tuple[Path, bytes | None]] = []  # path, exact head bytes (None: absent at head)

    def apply(self, path: str, status: str) -> None:
        p = under(self.wt, path)
        self.saved.append((p, p.read_bytes() if p.exists() else None))
        if status == "A":
            p.unlink(missing_ok=True)  # PR-added test file: may depend on the PR's new helpers
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            res = subprocess.run(git_cmd("show", f"{self.mb}:{path}"), cwd=self.repo,
                                 capture_output=True, check=False, env=git_env())
            if res.returncode != 0:
                raise InfraError(f"git show {self.mb}:{path} failed:\n{res.stderr.decode(errors='replace')[-1500:]}")
            p.write_bytes(res.stdout)  # preserve exact bytes (including CRLF)

    def write(self, p: Path, text: str) -> None:
        """Change a file in the worktree (a function removed from a swapped copy); restore() puts the head content back."""
        if not any(q == p for q, _ in self.saved):
            self.saved.append((p, p.read_bytes() if p.exists() else None))
        p.write_text(text)

    def restore(self) -> None:
        for p, content in reversed(self.saved):
            if content is None:
                p.unlink(missing_ok=True)
            else:
                p.write_bytes(content)
        self.saved = []
        clean_untracked(self.wt)


def verdict(head: list[str], base: str | None, pkg_base: str | None, name: str) -> str:
    cls = classify(head)
    if cls != Verdict.FAIL_3_OF_3:
        return cls
    if base == Verdict.PASS:
        return Verdict.OLD_TEST_BREAKS
    if base == Verdict.FAIL:
        return Verdict.PRE_EXISTING
    if name.endswith(f"::{PACKAGE_FAILED}") and pkg_base == Verdict.PASS:
        return Verdict.OLD_TEST_BREAKS
    return Verdict.NOT_RUN_ON_BASE


def _compile_errors(wt: Path, unit: dict[str, Any]) -> str:
    """The compiler's errors for the unit's package, all of them: -e lifts the 10-error cap on the test package and on
    every package a swapped file lives in (storetest, say, which sqlstore's tests import)."""
    dirs = {unit["dir"]} | {str(Path(f).parent) for f, _ in unit["swap"] if f.endswith(".go")}
    return go_build_errors(wt, unit["dir"], dirs)


def _salvage(wt: Path, unit: dict[str, Any], swap: Swap, tests: list[str], errors: str) -> dict[str, str] | None:
    """Delete from the swapped copies the top-level functions the compiler errors sit in; returns {removed Test function
    in `tests`: why}, or None when that cannot help: an error outside the files we may edit, outside any function, in
    TestMain or init, or nothing to delete. Caller test files are head files, so only candidate Tests may go from them."""
    root = go_root(wt, unit["dir"])
    swapped = {under(wt, f) for f, st in unit["swap"] if f.endswith(".go") and st != "A"}
    callers = {under(wt, f) for f in unit.get("callers", [])}
    by_file: dict[Path, list[tuple[int, str]]] = {}
    for f, line, msg in parse_go_errors(errors, root, GO_ERR):
        by_file.setdefault(f, []).append((line, msg))
    if not by_file or not set(by_file) <= swapped | callers:
        return None
    removed: dict[str, str] = {}
    edits: dict[Path, str] = {}
    for p, errs in by_file.items():
        lines = p.read_text().split("\n")
        blocks = top_blocks(lines, "go")
        gone: set[int] = set()
        for line, msg in errs:
            blk = next((b for b in blocks if b[1] <= line <= b[2]), None)
            if blk is None:
                if GO_UNUSED_IMPORT.match(msg):
                    gone.add(line)  # a deleted function left its import unused
                    continue
                return None
            name, first, last = blk
            m = GO_TEST.match(lines[first - 1])
            if name == "TestMain" or name.split("#")[0] == "init":
                return None
            if p not in swapped and not (m and m.group(1) in tests):
                return None
            gone.update(range(first, last + 1))
            if m and m.group(1) in tests:
                removed[m.group(1)] = (removed.get(m.group(1), "") + f"\n{p.name}:{line}: {msg}").strip()
        edits[p] = "\n".join(ln for i, ln in enumerate(lines, 1) if i not in gone)
    for p, text in edits.items():
        swap.write(p, text)
    return removed or {"": ""}


def _run_unit(wt: Path, wt_base: Path, unit: dict[str, Any], swap: Swap,
              base_swap: Swap) -> tuple[dict[str, str], dict[str, str]]:
    """One Go package or Jest file: RUNS on head with the base tests swapped in, once on base (three times when a test
    failed on head only some of the runs)."""
    go = unit["lang"] == "go"
    key = unit["key"]
    tests = list(unit["tests"])
    removed: dict[str, str] = {}  # Test functions the salvage had to delete -> compiler errors

    def run_once(w: Path, only: list[str], bins: dict[str, Path] | None = None) -> Outcome:
        o = Outcome()
        if go:
            if bins is not None:
                go_run(w, {unit["dir"]: "^(" + "|".join(only) + ")$"}, False, o, bins=bins)
            else:
                go_run(w, {unit["dir"]: "^(" + "|".join(only) + ")$"}, False, o)
        else:
            jest_run(w, [unit["file"]], "", o)
        return o

    heads: list[Outcome] = []
    try:
        for path, status in unit["swap"]:
            swap.apply(path, status)
        first_error = ""
        rounds = 0
        while not heads:
            try:
                if go and RUNS > 1 and go_run is _REAL_GO_RUN and (wt / unit["dir"]).is_dir():
                    with tempfile.TemporaryDirectory() as td:
                        bins = {unit["dir"]: go_compile_binary(wt, unit["dir"], False, Path(td) / "old.test")}
                        heads = [run_once(wt, tests, bins=bins) for _ in range(RUNS)]
                else:
                    heads = [run_once(wt, tests) for _ in range(RUNS)]
            except CompileError as e:
                first_error = first_error or str(e)
                step = None
                if go and rounds < SALVAGE_ROUNDS:
                    errors = _compile_errors(wt, unit)
                    step = _salvage(wt, unit, swap, tests, errors if GO_ERR.search(errors) else str(e))
                if step is None:
                    raise
                rounds += 1
                removed.update({t: why for t, why in step.items() if t})
                tests = [t for t in tests if t not in removed]
                if not tests:
                    raise CompileError(first_error) from e
    except CompileError as e:
        names = unit["tests"] if go else [unit["file"]]
        return ({f"{key}::{n}": Verdict.OLD_TEST_UNCOMPILABLE for n in names}, {f"{key}::*": str(e)[-1500:]})
    finally:
        swap.restore()
    names = sorted(set().union(*(h.results for h in heads)))
    seen = {n: [h.results.get(n, Verdict.MISSING) for h in heads] for n in names}
    # Failed on head in some runs only: a probabilistic break looks like this, so give base the same number of runs.
    some = [n for n in names if classify(seen[n]) == Verdict.FLAKY and Verdict.FAIL in seen[n]
            and not n.endswith(f"::{PACKAGE_FAILED}")]
    try:
        base = run_once(wt_base, tests)
        more = [run_once(wt_base, [n.split("::", 1)[1] for n in some] if go else tests) for _ in range(RUNS - 1)] if some else []
    except CompileError as e:
        out: dict[str, str] = {f"{key}::{n}": Verdict.NOT_RUN for n in (tests if go else [unit["file"]])}
        out_msgs = {f"{key}::*": f"base uncompilable: {str(e)[-1500:]}"}
        for t, why in removed.items():
            out[f"{key}::{t}"] = Verdict.OLD_TEST_UNCOMPILABLE
            out_msgs[f"{key}::{t}"] = why[-1500:]
        return out, out_msgs
    finally:
        base_swap.restore()  # nothing is swapped on base; this only removes files the run left behind
    table: dict[str, str] = {}
    msgs: dict[str, str] = {}
    for n in names:
        v = verdict(seen[n], base.results.get(n), base.packages.get(n.split("::", 1)[0]), n)
        if n in some and v == Verdict.FLAKY and all(o.results.get(n) == Verdict.PASS for o in [base, *more]):
            v = Verdict.OLD_TEST_SOMETIMES_BREAKS
        table[n] = v
        failure = next((h.messages[n] for h in heads if n in h.messages), None)
        if v != Verdict.PASS and failure is not None:
            msgs[n] = failure
    for t, why in removed.items():
        table[f"{key}::{t}"] = Verdict.OLD_TEST_UNCOMPILABLE
        msgs[f"{key}::{t}"] = why[-1500:]
    return table, msgs


def _dir_prod_risk(repo: Path, mb: str, head: str, target_dirs: set[str]) -> dict[str, float]:
    """Max changed non-test source file risk per directory in `target_dirs`, for ranking overflow units."""
    if not target_dirs:
        return {}
    by_dir: dict[str, float] = {}
    for line in git(repo, "diff", "--numstat", "--no-renames", mb, head).splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        add_s, rem_s, path = parts
        d = str(Path(path).parent)
        if d not in target_dirs or prefilter.excluded(path) or not (add_s.isdigit() and rem_s.isdigit()):
            continue
        patch = git(repo, "diff", mb, head, "--", path, check=False)
        r = prefilter.risk(prefilter.FileDiff(path, int(add_s), int(rem_s), patch))
        by_dir[d] = max(by_dir.get(d, 0.0), r)
    return by_dir


def _balance_units(go_list: list[dict[str, Any]], jest_list: list[dict[str, Any]],
                   cap: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Water-fill `cap` evenly across Go and Jest so Go packages cannot starve Jest specs on releases."""
    go_cap = max(cap // 2, cap - len(jest_list))
    chosen_go = go_list[:go_cap]
    jest_cap = max(0, cap - len(chosen_go))
    chosen_jest = jest_list[:jest_cap]
    return chosen_go + chosen_jest, go_list[go_cap:] + jest_list[jest_cap:]


def plan(repo: Path, mb: str, head: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Units to run and what was left out, each as "<path or key> (reason)"."""
    files = edited_tests(repo, mb, head)
    skipped: list[str] = []
    go_units: dict[str, dict[str, Any]] = {}
    by_dir: dict[str, list[tuple[str, str]]] = {}
    for path, status in files.items():
        if not path.endswith("_test.go"):
            continue
        d = str(Path(path).parent)
        if generated_layer(repo, [head, mb], d):
            skipped.append(f"{path} (generated layer: its tests fire mechanically when the store interface changes)")
        elif status in "MD" and is_generated(git(repo, "show", f"{mb}:{path}").split("\n")[:60]):
            skipped.append(f"{path} (generated file)")
        else:
            by_dir.setdefault(d, []).append((path, status))
    for d, entries in sorted(by_dir.items()):
        tests: set[str] = set()
        for path, status in entries:
            if status in "MD":
                head_src = git(repo, "show", f"{head}:{path}") if status == "M" else None
                tests |= set(go_candidates(git(repo, "show", f"{mb}:{path}"), head_src))
        if tests:
            go_units[d] = {"lang": "go", "key": d, "dir": d, "tests": tests, "swap": list(entries), "callers": []}
    by_scope: dict[tuple[str, str], list[tuple[str, str, set[str]]]] = {}
    for path, status in sorted(support_files(repo, mb, head).items()):
        base_src = git(repo, "show", f"{mb}:{path}")
        if is_generated(base_src.split("\n")[:60]):
            continue  # storetest/mocks
        names = support_exports(base_src, git(repo, "show", f"{head}:{path}") if status == "M" else None)
        if names:
            by_scope.setdefault((support_scope(path), support_dir(path) or "storetest"), []).append((path, status, names))
    for (scope, pkg), items in sorted(by_scope.items()):
        found = store_callers(repo, head, scope, set().union(*(n for _, _, n in items)), pkg)
        for d, callers in sorted(found.items()):
            callers = {t: f for t, f in callers.items() if files.get(f) != "A"}  # PR-added tests are not old tests
            if not callers or generated_layer(repo, [head, mb], d):
                continue
            u = go_units.setdefault(d, {"lang": "go", "key": d, "dir": d, "tests": set(), "swap": [], "callers": []})
            u["tests"] |= set(callers)
            u["callers"] = sorted(set(u["callers"]) | set(callers.values()))
            u["swap"] += [(p, st) for p, st, _ in items if (p, st) not in u["swap"]]
    jest_list: list[dict[str, Any]] = []
    for path, status in sorted(files.items()):
        if JEST_TEST.search(path) and status in "MD":
            snap = str(Path(path).parent / "__snapshots__" / f"{Path(path).name}.snap")
            swap = [(path, status)] + ([(snap, files[snap])] if snap in files else [])
            jest_list.append({"lang": "jest", "key": path, "file": path, "tests": [], "swap": swap})
    target_dirs = set(go_units) | {str(Path(u["file"]).parent) for u in jest_list}
    risk_by_dir = _dir_prod_risk(repo, mb, head, target_dirs)
    go_list = sorted(
        ({**u, "tests": sorted(u["tests"])} for u in go_units.values()),
        key=lambda u: (-risk_by_dir.get(u["dir"], 0.0), u["key"]),
    )
    jest_list.sort(key=lambda u: (-risk_by_dir.get(str(Path(u["file"]).parent), 0.0), u["key"]))
    units, overflow = _balance_units(go_list, jest_list, MAX_UNITS)
    skipped += [f"{u['key']} (over {MAX_UNITS} units)" for u in overflow]
    return units, skipped


def cmd_old(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
    wt, wt_base, repo = Path(state["wt"]), Path(state["wt_base"]), Path(state["repo"])
    ensure_clean(wt)
    ensure_clean(wt_base)
    units, skipped = plan(repo, state["merge_base"], state["head"])
    table: dict[str, str] = {}
    msgs: dict[str, str] = {}
    swap, base_swap = Swap(wt, repo, state["merge_base"]), Swap(wt_base, repo, state["merge_base"])
    for unit in units:
        try:
            t, m = _run_unit(wt, wt_base, unit, swap, base_swap)
        except InfraError as e:  # e.g. a test behind a build tag ran 0 tests: lose this unit, keep the others
            t, m = {f"{unit['key']}::*": Verdict.NOT_RUN}, {f"{unit['key']}::*": str(e)[-800:]}
        table.update(t)
        msgs.update(m)
    ensure_clean(wt)
    ensure_clean(wt_base)
    out = {"tests": table, "units": [{k: u[k] for k in ("lang", "key", "tests")} for u in units], "skipped": skipped}
    write_json(hdir / "old_tests.json", out)
    write_json(hdir / "old_tests.messages.json", msgs)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    hdir = hunt_dir(argv[1])

    def _run() -> int:
        out = cmd_old(hdir, read_state(hdir))
        if not out["units"]:
            print("[old] the PR edits or deletes no existing test: nothing to run")
        for n, v in out["tests"].items():
            print(f"[old] {n}: {v}")
        for k in out["skipped"]:
            print(f"[old] skipped: {k}")
        return 0

    return run_locked_cli(argv[1], hdir, _run)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
