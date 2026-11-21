#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Steps 4-5: run hunter tests, vet on the merge-base, score mutants. Go and Jest adapters.

usage: run.py run <pr> <A|B|A2>        3 runs on unmodified PR head (Go with -race); writes run_<tag>.json
       run.py base <pr> <A|B|A2>       the same tests once on the merge-base worktree; writes base_<tag>.json
       run.py cover <pr> <A|A2>        each test alone with coverage (no -race); writes run_<tag>.coverage.json: which
                                       changed lines it reaches, VACUOUS if none (then it kills no mutant)
       run.py mutants <pr> <A|A2|PR>   compile-check then score every mutant (M, then held-back M2); writes mutants_<tag>.json
Run these one at a time, and not while prepare.py or ctx.py runs for the same PR (they share the worktrees and hunt dir;
a lock enforces it). Long runs belong in the background.
Exit codes: 0 ok, 2 INFRA_ERROR (0 tests executed, dirty worktree, dead DB, missing tool, another step holds the lock),
3 COMPILE_ERROR in hunter tests (does not compile, wrong path, or a file with no TestHunt<mode>_ / Hunt<mode>_ test:
the repair round fixes it).
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

import hashlib
import json
import os
import re
import signal
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ctx import changed_lines
from hunt_common import (
    InfraError,
    git,
    hunt_dir,
    hunt_lock,
    load_json,
    node_env,
    read_state,
    require_disk,
    scratch,
    sh,
    under,
    write_json,
)

HUNT_FILE = re.compile(r"^(hunt_hunt[a-z0-9]+_test\.go|hunt_[a-z0-9]+\.test\.tsx?)$")
RESULT_GO = re.compile(r"^\s*--- (PASS|FAIL|SKIP): (\S+)", re.M)
PACKAGE_FAILED = "(package failed)"
# A failure on the merge-base that only says the code under test does not exist there.
MISSING_ON_BASE = re.compile(r"is not a function|is not defined|is not a constructor|Cannot find module|"
                             r"Cannot read propert(?:y|ies) of undefined|undefined is not", re.I)


class CompileError(RuntimeError):
    pass


@dataclass
class Suite:
    """What to run in one worktree: Go packages with a -run pattern, and/or Jest test files with a title prefix."""
    go_patterns: dict[str, str] = field(default_factory=dict)  # package dir -> -run pattern
    jest_files: list[str] = field(default_factory=list)
    jest_prefix: str = ""

    def empty(self) -> bool:
        return not self.go_patterns and not self.jest_files


@dataclass
class Outcome:
    results: dict[str, str] = field(default_factory=dict)   # identity -> PASS | FAIL | SKIP
    messages: dict[str, str] = field(default_factory=dict)  # identity -> normalized failure text
    packages: dict[str, str] = field(default_factory=dict)  # Go package dir -> PASS | FAIL, as its `go test` exited
    log: str = ""


def normalize_failure(text: str, wt: Path) -> str:
    """Failure text with what differs between two runs of the same failure removed: worktree paths, stack frames,
    durations, memory addresses and goroutine ids. Two failures compare equal only if they say the same thing, so
    values written in hex (got 0x02, want 0x01) are kept; only frame offsets and 64-bit addresses are redacted."""
    text = text.replace(str(wt.resolve()), "<wt>").replace(str(wt), "<wt>")
    keep = [line for line in text.splitlines()
            if not re.match(r"\s+at |\s*created by |\t\S+\.go:\d+(?: \+0x[0-9a-fA-F]+)?$", line)]  # JS and Go frames
    text = "\n".join(keep)
    text = re.sub(r"(?i)goroutine \d+", "goroutine N", text)
    text = re.sub(r"\(\d+(?:\.\d+)?m?s\)", "", text)
    text = re.sub(r"\b\d+(?:\.\d+)?m?s$", "", text, flags=re.M)
    text = re.sub(r"\+0x[0-9a-fA-F]+\b", "+0x?", text)  # frame offsets
    text = re.sub(r"\b(pc|sp|fp|lr|addr)=0x[0-9a-fA-F]+", r"\1=0x?", text)  # registers in a signal line
    # A traceback call's arguments ("pkg.f({0x54fe40, 0x6a08a0})", "testing.tRunner(0xc0001, 0x5843?)") are pointers
    # into the binary, which move whenever the code does; a list of nothing but hex words is never assertion text.
    text = re.sub(r"(?<=[\w)\]])\((?:[\s{},.?]|0x[0-9a-fA-F]+)*0x[0-9a-fA-F]+(?:[\s{},.?]|0x[0-9a-fA-F]+)*\)", "(...)",
                  text)
    text = re.sub(r"\b0x[0-9a-fA-F]{9,}\b", "0x?", text)  # heap, stack and mmap addresses (wider than 32 bits)
    text = re.sub(r"[ \t]+", " ", text).strip()
    return text[:4000]


def go_test_output(out: str) -> dict[str, str]:
    """Output lines per top-level Go test, from -v output (=== RUN / === CONT switch the current test)."""
    blocks: dict[str, list[str]] = {}
    current = None
    for line in out.splitlines():
        m = re.match(r"=== (?:RUN|CONT|PAUSE) +(\S+)", line)
        if m:
            current = m.group(1).split("/")[0]
            continue
        m = re.match(r"\s*--- (?:PASS|FAIL|SKIP): (\S+)", line)
        if m:
            current = m.group(1).split("/")[0]
            continue
        if re.match(r"(?:ok|FAIL|PASS)(?:\s|$)", line):  # package summary ("FAIL\tpkg\t0.01s", "PASS"): no test's output
            current = None
            continue
        if current:
            blocks.setdefault(current, []).append(line)
    return {k: "\n".join(v) for k, v in blocks.items()}


# ---------------------------------------------------------------- worktree hygiene

def ensure_clean(wt: Path) -> None:
    """Refuse to run on a worktree with leftovers (an interrupted mutant, stray hunt files): results would be wrong."""
    status = git(wt, "status", "--porcelain", "--untracked-files=all")
    dirty = [line for line in status.splitlines() if "node_modules" not in line and "go.work" not in line]
    if dirty:
        raise InfraError(f"{wt} has leftover changes ({'; '.join(dirty[:5])}); rerun prepare.py to reset it")


def place(wt: Path, files: list[dict[str, str]], target_dirs: set[str]) -> list[Path]:
    """Write hunter files into wt, all or nothing. Model output picks the paths, so every path is validated before
    anything is written (only new hunt_* test files inside a target dir pass), and a failed write removes what was
    written."""
    targets: list[tuple[Path, str]] = []
    for f in files:
        rel = str(f.get("path", ""))
        if not HUNT_FILE.match(Path(rel).name) or str(Path(rel).parent) not in target_dirs:
            # Model output chose a wrong name or directory: the repair round can fix that, so report it as such.
            raise CompileError(f"refusing to write {rel!r}: not a hunt_* test file in one of {sorted(target_dirs)}")
        try:
            p = under(wt, rel)
        except ValueError as e:
            raise CompileError(str(e)) from e
        if not p.parent.is_dir():
            raise CompileError(f"{p.parent} does not exist in this worktree")
        if p.exists() or p.is_symlink() or any(p == t for t, _ in targets):
            # Never overwrite (and later delete) a file the repository already has, or write one path twice.
            raise CompileError(f"refusing to write {rel!r}: the path is already taken; choose another hunt_* file name")
        targets.append((p, str(f.get("content", ""))))
    placed: list[Path] = []
    try:
        for p, content in targets:
            placed.append(p)  # before writing: a write that fails halfway must be rolled back too
            p.write_text(content)
    except BaseException:  # an OSError, or SIGTERM's SystemExit before the caller holds the list to clean up
        unplace(placed)
        raise
    return placed


def unplace(paths: list[Path]) -> None:
    for p in paths:
        p.unlink(missing_ok=True)


def suite_for(tag: str, state: dict[str, Any], placed: list[Path], wt: Path) -> Suite:
    s = Suite()
    if tag == "PR":
        own = state["own_tests"]
        # each package runs only the PR tests it contains (a name missing from a package would run 0 tests there)
        by_dir = own.get("go_by_dir") or ({t["dir"]: own["go"] for t in state["targets"] if t["lang"] == "go"}
                                          if own["go"] else {})
        s.go_patterns = {d: "^(" + "|".join(names) + ")$" for d, names in by_dir.items() if names}
        s.jest_files = own["jest"]
        return s
    mode = tag[0]
    for p in placed:
        rel = str(p.relative_to(wt))
        if rel.endswith(".go"):
            # One -run pattern per package: another file's match would hide a file whose tests are misnamed.
            if not re.search(rf"^func TestHunt{mode}_\w*\(", p.read_text(), re.M):
                raise CompileError(f"{rel}: no test named TestHunt{mode}_<Name>(t *testing.T); rename the tests")
            s.go_patterns[str(Path(rel).parent)] = f"^TestHunt{mode}_"
        else:
            s.jest_files.append(rel)
    s.jest_prefix = f"Hunt{mode}_"
    return s


# ---------------------------------------------------------------- Go

def go_root(wt: Path, d: str) -> Path:
    p = (wt / d).resolve()
    while p != wt.resolve().parent:
        if (p / "go.mod").exists():
            return p
        p = p.parent
    raise InfraError(f"no go.mod above {d}")


def go_run(wt: Path, patterns: dict[str, str], race: bool, into: Outcome) -> None:
    if race:
        require_disk(scratch())  # before the -race build starts, not after it fails for lack of space
    for d, pattern in sorted(patterns.items()):
        root = go_root(wt, d)
        pkg = "./" + os.path.relpath(wt / d, root)
        args = ["go", "test", "-count=1", "-v", "-run", pattern] + (["-race"] if race else []) + [pkg]
        p = sh(args, root, check=False, timeout=1800)
        out = p.stdout + p.stderr
        # Identities are package-qualified ("<dir>::<Test>") so equal test names in two packages never overwrite.
        got = {f"{d}::{m.group(2)}": m.group(1) for m in RESULT_GO.finditer(out) if "/" not in m.group(2)}
        if not got:
            if "[build failed]" in out or "[setup failed]" in out:
                raise CompileError(f"{pkg}:\n{out[-2500:]}")
            if p.returncode != 0 and "=== RUN" in out:
                # A test started and the binary died before any result line (panic in a goroutine, timeout):
                # that is a test failure, not an environment problem.
                got = {f"{d}::{PACKAGE_FAILED}": "FAIL"}
            else:
                raise InfraError(f"0 tests executed in {pkg} (exit {p.returncode}):\n{out[-2500:]}")
        elif p.returncode != 0 and "FAIL" not in got.values():
            # e.g. TestMain teardown, a race report or a panic after the last test: the package failed even though no
            # test line says so. Record it instead of reporting PASS.
            got[f"{d}::{PACKAGE_FAILED}"] = "FAIL"
        into.results.update(got)
        into.packages[d] = "PASS" if p.returncode == 0 else "FAIL"
        for name, block in go_test_output(out).items():
            if got.get(f"{d}::{name}") == "FAIL":
                into.messages[f"{d}::{name}"] = normalize_failure(block, wt)
        if got.get(f"{d}::{PACKAGE_FAILED}") == "FAIL":
            into.messages[f"{d}::{PACKAGE_FAILED}"] = normalize_failure(out[-4000:], wt)
        into.log += out


def go_compiles(wt: Path, file: str) -> str | None:
    d = str(Path(file).parent)
    root = go_root(wt, d)
    p = sh(["go", "test", "-c", "-o", os.devnull, "./" + os.path.relpath(wt / d, root)], root, check=False, timeout=900)
    return None if p.returncode == 0 else (p.stdout + p.stderr)[-1500:]


# ---------------------------------------------------------------- Jest

def jest_root(wt: Path, rel: str) -> Path:
    p = (wt / rel).resolve().parent
    while p != wt.resolve().parent:
        if any((p / n).exists() for n in ("jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs")):
            return p
        p = p.parent
    raise InfraError(f"no jest.config above {rel}")


def jest_run(wt: Path, files: list[str], prefix: str, into: Outcome) -> None:
    for rel in files:
        found = 0
        root = jest_root(wt, rel)
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            # --runTestsByPath: a bare path is a regex and would also run e.g. src/packages/.../actions/hunt_a.test.tsx
            p = sh(["npx", "jest", "--runTestsByPath", os.path.relpath(wt / rel, root), "--watchAll=false", "--json",
                    f"--outputFile={out}"],
                   root, check=False, timeout=1200, env=node_env())
            if not out.exists():
                raise InfraError(f"jest wrote no results for {rel}:\n{(p.stdout + p.stderr)[-2500:]}")
            data = json.loads(out.read_text())
        for f in data.get("testResults", []):
            if not f.get("assertionResults"):
                if f.get("message"):
                    raise CompileError(f"{rel}:\n{f['message'][-2500:]}")
                raise InfraError(f"0 tests executed in {rel}")
            for a in f["assertionResults"]:
                if prefix and not a["title"].startswith(prefix):
                    continue
                found += 1
                # file + full name: equal titles in two describe blocks or files never overwrite each other
                key = f"{rel}::{a.get('fullName') or a['title']}"
                into.results[key] = {"passed": "PASS", "failed": "FAIL"}.get(a["status"], "SKIP")
                failures = a.get("failureMessages") or []
                if failures:
                    into.messages[key] = normalize_failure("\n".join(failures), wt)
                    into.log += "\n".join(failures) + "\n"
        if not found:
            # Checked per file: a passing file must not hide one whose tests were all filtered out.
            raise CompileError(f"{rel}: no test title starts with {prefix!r}; rename the tests")


def jest_compiles(wt: Path, file: str) -> str | None:
    root = jest_root(wt, file)
    p = sh(["node", "-e", "require('@babel/core').transformFileSync(process.argv[1])", str(wt / file)], root,
           check=False, timeout=120, env=node_env())
    return None if p.returncode == 0 else (p.stdout + p.stderr)[-1500:]


# ---------------------------------------------------------------- suite level

def run_suite(wt: Path, s: Suite, race: bool) -> Outcome:
    if s.empty():
        raise InfraError("suite is empty: no Go packages or Jest files to run")
    o = Outcome()
    if s.go_patterns:
        go_run(wt, s.go_patterns, race, o)
    if s.jest_files:
        jest_run(wt, s.jest_files, s.jest_prefix, o)
    return o


def compiles(wt: Path, file: str) -> str | None:
    return go_compiles(wt, file) if file.endswith(".go") else jest_compiles(wt, file)


def classify(statuses: list[str]) -> str:
    if all(x == "PASS" for x in statuses):
        return "PASS"
    if all(x == "FAIL" for x in statuses):
        return "FAIL_3_OF_3"
    if all(x == "SKIP" for x in statuses):
        return "SKIP"
    return "FLAKY"


def fingerprint(files: list[dict[str, str]]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def cmd_run(hdir: Path, state: dict[str, Any], tag: str, runs: int = 3) -> dict[str, Any]:
    wt = Path(state["wt"])
    ensure_clean(wt)
    files = load_json(hdir / tag / "response.json")["files"]
    # `base` vets these exact files: a redispatched response must be run on head again first.
    (hdir / f"run_{tag}.response.sha256").unlink(missing_ok=True)
    if not files:  # e.g. a Mode B hunter for a PR whose description promises nothing testable
        write_json(hdir / f"run_{tag}.json", {})
        (hdir / f"run_{tag}.response.sha256").write_text(fingerprint(files))
        return {}
    placed: list[Path] = []
    outcomes = []
    try:
        placed = place(wt, files, {t["dir"] for t in state["targets"]})
        for _ in range(runs):
            outcomes.append(run_suite(wt, suite_for(tag, state, placed, wt), race=True))
    finally:
        unplace(placed)
    names = sorted(set().union(*(o.results for o in outcomes)))
    table = {n: classify([o.results.get(n, "MISSING") for o in outcomes]) for n in names}
    write_json(hdir / f"run_{tag}.json", table)
    write_json(hdir / f"run_{tag}.messages.json", outcomes[0].messages)
    (hdir / f"run_{tag}.log").write_text("\n\n=== run ===\n".join(o.log for o in outcomes))
    (hdir / f"run_{tag}.response.sha256").write_text(fingerprint(files))
    return table


def base_verdict(name: str, base_status: str, head: dict[str, str], head_msgs: dict[str, str], base_msg: str) -> str:
    """Only a test that failed 3/3 on head gets a bug verdict; anything else is labelled as not a failure."""
    if head.get(name) != "FAIL_3_OF_3":
        return "NOT_A_HEAD_FAILURE"
    if base_status == "PASS":
        return "NEW_PR_BUG"
    if base_status != "FAIL":
        return base_status
    if name in head_msgs and head_msgs[name] == base_msg:
        return "PRE_EXISTING"
    if MISSING_ON_BASE.search(base_msg):
        # Jest (Babel, no type check) loads a test of a function the PR adds; on base it fails as "not a function".
        return "BASE_UNCOMPILABLE"
    return "BASE_FAILS_DIFFERENTLY"  # decide from the diff, as for BASE_UNCOMPILABLE


def base_table(head: dict[str, str], head_msgs: dict[str, str], o: Outcome) -> dict[str, str]:
    """One verdict per test the base run reported, plus one for every head failure it did not report."""
    out = {n: base_verdict(n, s, head, head_msgs, o.messages.get(n, "")) for n, s in o.results.items()}
    for n, status in head.items():
        if status == "FAIL_3_OF_3" and n not in o.results:
            # No result line for it on base. A package-level failure (teardown, a late race or panic) on head is new
            # if the same package exited cleanly on base; otherwise the package died on base or the test is absent.
            pkg = o.packages.get(n.split("::", 1)[0])
            if n.endswith(f"::{PACKAGE_FAILED}") and pkg == "PASS":
                out[n] = "NEW_PR_BUG"
            elif pkg == "FAIL" or o.results.get(n.split("::", 1)[0] + f"::{PACKAGE_FAILED}") == "FAIL":
                out[n] = "BASE_FAILS_DIFFERENTLY"
            else:
                out[n] = "NOT_RUN_ON_BASE"
    return out


def cmd_base(hdir: Path, state: dict[str, Any], tag: str) -> dict[str, str]:
    """NEW_PR_BUG: failed 3/3 on head, passes on base. PRE_EXISTING: fails with the same normalized failure on base.
    BASE_UNCOMPILABLE / BASE_FAILS_DIFFERENTLY / NOT_RUN_ON_BASE: decide from the diff. NOT_A_HEAD_FAILURE: nothing
    to vet."""
    wt = Path(state["wt_base"])
    ensure_clean(wt)
    files = load_json(hdir / tag / "response.json")["files"]
    if not (hdir / f"run_{tag}.json").exists():
        raise InfraError(f"run_{tag}.json missing: run `run.py run <pr> {tag}` before `base`")
    sha = hdir / f"run_{tag}.response.sha256"
    if not sha.exists() or sha.read_text().strip() != fingerprint(files):
        raise InfraError(f"{tag}/response.json changed since run_{tag}.json was written; run `run.py run <pr> {tag}` "
                         "again so base vets the tests that produced the head verdicts")
    head = load_json(hdir / f"run_{tag}.json")
    head_msgs = (load_json(hdir / f"run_{tag}.messages.json")
                 if (hdir / f"run_{tag}.messages.json").exists() else {})
    out: dict[str, str] = {}
    placed: list[Path] = []
    try:
        if files:
            placed = place(wt, files, {t["dir"] for t in state["targets"]})
            out = base_table(head, head_msgs, run_suite(wt, suite_for(tag, state, placed, wt), race=True))
    except CompileError as e:
        out = {"*": "BASE_UNCOMPILABLE", "detail": str(e)[-800:]}
    finally:
        unplace(placed)
    write_json(hdir / f"base_{tag}.json", out)
    return out


def all_mutants(hdir: Path) -> list[dict[str, Any]]:
    ms = [{**m, "held_back": False} for m in load_json(hdir / "M" / "response.json")["mutants"]]
    if (hdir / "M2" / "response.json").exists():
        ms += [{**m, "held_back": True} for m in load_json(hdir / "M2" / "response.json")["mutants"]]
    for i, m in enumerate(ms):  # a regenerated mutant (R_<id>) replaces the one that did not compile
        regen = hdir / f"R_{m['id']}" / "response.json"
        if regen.exists():
            ms[i] = {**load_json(regen)["mutants"][0], "id": m["id"], "held_back": m["held_back"]}
    return ms


def is_kill(name: str, status: str, base: Outcome) -> bool:
    if status != "FAIL":
        return False
    if name.endswith(f"::{PACKAGE_FAILED}"):
        # A package-level failure kills only if the baseline run of that package was observed to exit cleanly.
        return base.packages.get(name.split("::", 1)[0]) == "PASS"
    return base.results.get(name) == "PASS"


def score_mutant(wt: Path, state: dict[str, Any], suite: Suite, base: Outcome,
                 m: dict[str, Any], vacuous: frozenset[str] = frozenset()) -> dict[str, Any]:
    v: dict[str, Any] = {"id": m["id"], "held_back": m["held_back"], "file": m["file"],
                         "what_breaks": m["what_breaks"], "killers": [], "mutant": m}
    # A mutant that cannot be applied as written goes back to a planter (regen), like one that does not compile.
    if m["file"] not in state["changed"]:
        return {**v, "verdict": "NEEDS_REGENERATION", "detail": f"{m['file']} is not one of the hunted files {state['changed']}"}
    path = under(wt, m["file"])
    orig = path.read_text()
    if orig.count(m["old"]) != 1:
        return {**v, "verdict": "NEEDS_REGENERATION",
                "detail": f"`old` occurs {orig.count(m['old'])} times in {m['file']}; it must occur exactly once"}
    try:
        path.write_text(orig.replace(m["old"], m["new"], 1))
        try:
            err = compiles(wt, m["file"])
            if err:
                return {**v, "verdict": "NEEDS_REGENERATION", "detail": err}
            r = run_suite(wt, suite, race=False).results
        except CompileError as e:
            return {**v, "verdict": "NEEDS_REGENERATION", "detail": str(e)[-1500:]}
        except InfraError as e:  # one mutant's environment failure (a compile-check timeout too) loses no other verdict
            return {**v, "verdict": "ERROR", "detail": str(e)[-1500:]}
        killers = sorted(n for n, s in r.items() if is_kill(n, s, base) and n not in vacuous)
        return {**v, "verdict": "KILLED" if killers else "SURVIVED", "killers": killers}
    finally:
        path.write_text(orig)


def cmd_mutants(hdir: Path, state: dict[str, Any], tag: str) -> list[dict[str, Any]]:
    wt = Path(state["wt"])
    ensure_clean(wt)
    # Mutant builds skip -race, so go_run's check never runs for them; without this, a full disk would surface as
    # linker failures that read as NEEDS_REGENERATION.
    require_disk(scratch())
    files = [] if tag == "PR" else load_json(hdir / tag / "response.json")["files"]
    placed: list[Path] = []
    verdicts = []
    try:
        placed = place(wt, files, {t["dir"] for t in state["targets"]})
        suite = suite_for(tag, state, placed, wt)
        if suite.empty():  # the PR (or the hunter) has no tests in the hunted packages: nothing can kill a mutant
            verdicts = [{"id": m["id"], "held_back": m["held_back"], "file": m["file"], "what_breaks": m["what_breaks"],
                         "killers": [], "mutant": m, "verdict": "SURVIVED", "detail": "no tests to score"}
                        for m in all_mutants(hdir)]
        else:
            base = run_suite(wt, suite, race=False)
            # A test that executes none of the PR's changed lines does not count as a killer (run.py cover).
            vacuous = frozenset(vacuous_tests(hdir, tag))
            verdicts = [score_mutant(wt, state, suite, base, m, vacuous) for m in all_mutants(hdir)]
    finally:
        unplace(placed)
    write_json(hdir / f"mutants_{tag}.json", verdicts)
    return verdicts


# ---------------------------------------------------------------- changed-line coverage

GO_BLOCK = re.compile(r"^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$")


def changed_lines_by_file(wt: Path, merge_base: str, files: list[str]) -> dict[str, set[int]]:
    """Head-side lines the PR adds, plus the head line after each removal, per changed file."""
    out = {}
    for f in files:
        out[f] = changed_lines(git(wt, "diff", "-U0", merge_base, "HEAD", "--", f))
    return out


def go_profile_lines(profile: str, rel_to_root: str) -> tuple[set[int], set[int]]:
    """(lines inside any instrumented block, lines inside a block that ran) for one file of a Go cover profile.
    Profile entries name the file by import path, so a file matches by its path below the module root."""
    instrumented: set[int] = set()
    hit: set[int] = set()
    for line in profile.splitlines():
        m = GO_BLOCK.match(line)
        if not m or not (m.group(1) == rel_to_root or m.group(1).endswith("/" + rel_to_root)):
            continue
        span = set(range(int(m.group(2)), int(m.group(3)) + 1))
        instrumented |= span
        if int(m.group(4)) > 0:
            hit |= span
    return instrumented, hit


def jest_profile_lines(cov: dict[str, Any], abs_path: str) -> tuple[set[int], set[int]]:
    """Same as go_profile_lines, from one entry of Jest's coverage-final.json (statements only)."""
    entry = cov.get(abs_path) or next((v for k, v in cov.items() if Path(k).resolve() == Path(abs_path).resolve()), None)
    instrumented: set[int] = set()
    hit: set[int] = set()
    if not entry:
        return instrumented, hit
    for sid, loc in entry.get("statementMap", {}).items():
        span = set(range(loc["start"]["line"], loc["end"]["line"] + 1))
        instrumented |= span
        if entry.get("s", {}).get(sid, 0) > 0:
            hit |= span
    return instrumented, hit


def js_regex_escape(s: str) -> str:
    return re.sub(r"[.*+?^${}()|[\]\\/]", lambda m: "\\" + m.group(0), s)


def go_test_coverage(wt: Path, d: str, name: str, changed: dict[str, set[int]]) -> dict[str, tuple[set[int], set[int]]] | None:
    """Run one Go test alone with coverage of the changed packages in its module; None if no profile was written."""
    root = go_root(wt, d)
    go_files = [f for f in changed if f.endswith(".go") and not f.endswith("_test.go")
                and (wt / f).resolve().is_relative_to(root.resolve())]
    if not go_files:
        return {}
    pkgs = sorted({"./" + os.path.relpath((wt / f).parent, root) for f in go_files})
    with tempfile.TemporaryDirectory() as td:
        prof = Path(td) / "cover.out"
        sh(["go", "test", "-count=1", "-run", f"^{name}$", f"-coverprofile={prof}", "-coverpkg=" + ",".join(pkgs),
            "./" + os.path.relpath(wt / d, root)], root, check=False, timeout=1800)
        if not prof.exists():
            return None
        text = prof.read_text()
    return {f: go_profile_lines(text, os.path.relpath(wt / f, root)) for f in go_files}


def jest_test_coverage(wt: Path, rel: str, full_name: str,
                       changed: dict[str, set[int]]) -> dict[str, tuple[set[int], set[int]]] | None:
    root = jest_root(wt, rel)
    js_files = [f for f in changed if re.search(r"\.[jt]sx?$", f) and (wt / f).resolve().is_relative_to(root.resolve())]
    if not js_files:
        return {}
    with tempfile.TemporaryDirectory() as td:
        args = ["npx", "jest", "--runTestsByPath", os.path.relpath(wt / rel, root), "--watchAll=false",
                "-t", f"^{js_regex_escape(full_name)}$", "--coverage", "--coverageReporters=json",
                f"--coverageDirectory={td}"]
        for f in js_files:
            args.append(f"--collectCoverageFrom={os.path.relpath(wt / f, root)}")
        sh(args, root, check=False, timeout=1200, env=node_env())
        final = Path(td) / "coverage-final.json"
        if not final.exists():
            return None
        cov = json.loads(final.read_text())
    return {f: jest_profile_lines(cov, str(wt / f)) for f in js_files}


def cover_table(changed: dict[str, set[int]],
                per_test: dict[str, dict[str, tuple[set[int], set[int]]] | None]) -> dict[str, Any]:
    """Verdicts from raw per-test coverage. Only changed lines that some coverage run instrumented count: comments,
    blank lines and declarations can never be reached, so they are not part of the denominator."""
    executable: dict[str, set[int]] = {f: set() for f in changed}
    for cov in per_test.values():
        for f, (instrumented, _) in (cov or {}).items():
            executable[f] |= instrumented & changed[f]
    tests: dict[str, Any] = {}
    reached: dict[str, set[int]] = {f: set() for f in changed}
    for name, cov in per_test.items():
        if cov is None:
            tests[name] = {"verdict": "UNKNOWN", "hit": {}}  # no profile (a crash): never dropped on missing data
            continue
        hit = {f: sorted(h & executable[f]) for f, (_, h) in cov.items() if h & executable[f]}
        for f, lines in hit.items():
            reached[f] |= set(lines)
        tests[name] = {"verdict": "REACHES" if hit else "VACUOUS", "hit": hit}
    total = sum(len(v) for v in executable.values())
    return {"tests": tests, "reached": sum(len(v) for v in reached.values()), "executable": total,
            "unreached": {f: sorted(executable[f] - reached[f]) for f in changed if executable[f] - reached[f]}}


def cmd_cover(hdir: Path, state: dict[str, Any], tag: str) -> dict[str, Any]:
    """Run each hunter test alone with coverage (no -race, so no verdict depends on it) and record which of the PR's
    changed lines it executes. Mode A only: Mode B's S3 tests are meant to stay off the changed lines."""
    if tag not in ("A", "A2"):
        raise InfraError(f"cover is for Mode A tags (A, A2), not {tag}")
    wt = Path(state["wt"])
    ensure_clean(wt)
    files = load_json(hdir / tag / "response.json")["files"]
    head = hdir / f"run_{tag}.json"
    sha = hdir / f"run_{tag}.response.sha256"
    if not head.exists() or not sha.exists() or sha.read_text().strip() != fingerprint(files):
        raise InfraError(f"run `run.py run <pr> {tag}` first: cover measures the tests that produced run_{tag}.json")
    table = load_json(head)
    changed = changed_lines_by_file(wt, state["merge_base"], state["changed"])
    per_test: dict[str, dict[str, tuple[set[int], set[int]]] | None] = {}
    placed: list[Path] = []
    try:
        placed = place(wt, files, {t["dir"] for t in state["targets"]})
        for ident in sorted(table):
            loc, name = ident.split("::", 1)
            if name == PACKAGE_FAILED:
                continue
            if loc.endswith((".ts", ".tsx", ".js", ".jsx")):
                per_test[ident] = jest_test_coverage(wt, loc, name, changed)
            else:
                per_test[ident] = go_test_coverage(wt, loc, name, changed)
    finally:
        unplace(placed)
    out = cover_table(changed, per_test)
    for ident, t in out["tests"].items():
        t["head"] = table.get(ident, "")
    write_json(hdir / f"run_{tag}.coverage.json", out)
    return out


def vacuous_tests(hdir: Path, tag: str) -> set[str]:
    """Tests run.py cover found to reach no changed line. A FAIL_3_OF_3 test is never in this set: it can still be a
    real bug next to the change, and vetting decides that."""
    p = hdir / f"run_{tag}.coverage.json"
    if not p.exists():
        return set()
    return {n for n, t in load_json(p)["tests"].items() if t["verdict"] == "VACUOUS" and t.get("head") != "FAIL_3_OF_3"}


def _terminate(signum: int, _frame: Any) -> None:
    # SIGTERM / SIGHUP (a tool timeout, a closed terminal) unwind through the finally blocks, so a mutated file is
    # restored and hunt files are removed instead of being left in the worktree.
    raise SystemExit(128 + signum)


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] not in ("run", "base", "mutants", "cover"):
        print(__doc__)
        return 1
    cmd, pr, tag = argv[1], argv[2], argv[3]
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _terminate)
    hdir = hunt_dir(pr)
    try:
        with hunt_lock(hdir, pr):
            state = read_state(hdir)  # inside the lock: ctx.py may be rewriting it
            if cmd == "run":
                table = cmd_run(hdir, state, tag)
                for n, c in table.items():
                    print(f"[{tag}] {n}: {c}")
                if not table:
                    print(f"[{tag}] no tests in the hunter response")
            elif cmd == "base":
                for n, c in cmd_base(hdir, state, tag).items():
                    print(f"[{tag} @merge-base] {n}: {c if n != 'detail' else c[:300]}")
            elif cmd == "cover":
                cov = cmd_cover(hdir, state, tag)
                for n, t in cov["tests"].items():
                    print(f"[{tag} cover] {n}: {t['verdict']} {sum(len(v) for v in t['hit'].values())} changed lines")
                print(f"[{tag} cover] changed lines reached: {cov['reached']}/{cov['executable']}")
            else:
                for v in cmd_mutants(hdir, state, tag):
                    extra = v["killers"] or v.get("detail", "")[:160]
                    print(f"{v['id']}{' (held back)' if v['held_back'] else ''}: {v['verdict']} {extra}")
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    except CompileError as e:
        (hdir / f"compile_{tag}.log").write_text(str(e))  # input for `build_requests.py <pr> repair <tag>`
        print(f"COMPILE_ERROR {e}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
