#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Steps 4-5: run hunter tests, vet on the merge-base, score mutants. Go and Jest adapters.

usage: run.py run <pr> <A|B|A2|R|V>    1 run on unmodified PR head, failures rerun up to 3 in all (Go with -race; full-suite confirmation runs when a filtered rerun passes are additional); writes run_<tag>.json
       run.py base <pr> <A|B|A2|R|V>   the same tests once on the merge-base worktree; writes base_<tag>.json
       run.py diff <pr> D              differential recorders (build_requests.py <pr> diff): run on the PR head twice (records
                                       that differ are dropped; too few stable = NONDETERMINISTIC) and on the merge-base (a
                                       second time only for a DIFF), then diff the stable records per (test, input). SAME | DIFF | NONDETERMINISTIC | BASE_UNCOMPILABLE |
                                       BASE_FAILED | RECORDER_FAILED | NO_RECORDS; writes diff_D.json, diff_D.examples.json
       run.py cover <pr> <A|A2>        each test alone with coverage (no -race); writes run_<tag>.coverage.json: which
                                       changed lines it reaches, VACUOUS if none (then it kills no mutant)
       run.py fuzz <pr> A              fuzz pure FuzzHuntA_<Name> targets (HUNT_FUZZ_TIME, default 60s); a failure is frozen
                                       into TestHuntA_<Name>_Fuzz<hash> in A/response.json; writes fuzz_A.json. `run A`
                                       does this itself before its 3 runs; HUNT_FUZZ=0 turns both off
       run.py mutants <pr> <A|A2|PR>   compile-check then score every mutant (M, then held-back M2); writes mutants_<tag>.json
Run these one at a time, and not while prepare.py or ctx.py runs for the same PR (they share the worktrees and hunt dir;
a lock enforces it). Long runs belong in the background.
Exit codes: 0 ok, 2 INFRA_ERROR (0 tests executed, dirty worktree, dead DB, missing tool, another step holds the lock),
3 COMPILE_ERROR in hunter tests (does not compile, wrong path, or a file with no TestHunt<mode>_ / Hunt<mode>_ test:
the repair round fixes it).
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import contextlib
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import tempfile
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ctx import changed_lines, go_bodies, top_blocks
from hunt_common import (
    InfraError,
    git,
    git_cmd,
    hunt_dir,
    load_json,
    maybe_pg_pool_lock,
    node_env,
    read_state,
    read_text_lossy,
    require_disk,
    run_locked_cli,
    scratch,
    sh,
    under,
    write_json,
)
from verdicts import Verdict

HUNT_FILE = re.compile(r"^(hunt_hunt[a-z0-9]+_test\.go|hunt_[a-z0-9]+\.test\.tsx?)$")
MODE_A_FUZZ_TARGET = re.compile(r"^func (FuzzHuntA_\w+)\(", re.M)
_FROZEN_FUZZ_RE = re.compile(r"^func (TestHuntA_\w+_Fuzz[0-9a-f]{8})\(", re.M)
RESULT_GO = re.compile(r"^\s*--- (PASS|FAIL|SKIP): (\S+)", re.M)
PACKAGE_FAILED = "(package failed)"
# `ok  \t<import path>\t15.116s` / `FAIL\t<import path>\t2.5s`: how long one package's test binary ran.
GO_PACKAGE_TIME = re.compile(r"^(?:ok|FAIL)\s+\S+\s+([\d.]+)s\s*$", re.M)
# A mutant's `go test` may run this many times as long as the unmutated baseline, and never less than the floor.
# Past that the mutant made a test hang: go test panics, the package fails, and the mutant counts as KILLED. Without
# the cap go test's own 10-minute default applies, once per hanging mutant.
MUTANT_TIMEOUT_FACTOR = 5
MUTANT_TIMEOUT_MIN_S = 60
# A failure on the merge-base that only says the code under test does not exist there.
MISSING_ON_BASE = re.compile(r"is not a function|is not defined|is not a constructor|Cannot find module", re.I)


class CompileError(RuntimeError):
    pass


class GoBuildError(CompileError):
    """`go test` could not build one package of hunter tests; `pkg_dir` is that package's directory in the worktree."""

    def __init__(self, msg: str, pkg_dir: str) -> None:
        super().__init__(msg)
        self.pkg_dir = pkg_dir


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
    runtimes: dict[str, float] = field(default_factory=dict)  # Go package dir -> seconds its test binary ran
    log: str = ""


def normalize_failure(text: str, wt: Path) -> str:
    """Failure text with what differs between two runs of the same failure removed: worktree paths, stack frames,
    durations, memory addresses and goroutine ids. Two failures compare equal only if they say the same thing, so
    values written in hex (got 0x02, want 0x01) are kept; only frame offsets and 64-bit addresses are redacted."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)  # strip ANSI color codes (mlog console warn/info/debug)
    text = text.replace(str(wt.resolve()), "<wt>").replace(str(wt), "<wt>")
    keep = [line for line in text.splitlines()
            if not re.match(r'\s+at |\s*created by |\t\S+\.go:\d+(?: \+0x[0-9a-fA-F]+)?$|'
                            r'\s*\{"(?:timestamp":"[^"]+",)?"level":"(?:debug|info|warn)"|'
                            r'\s*(?:debug|info|warn) \[(?:\d{4}-\d{2}-\d{2}|<ts>)', line)]  # JS/Go frames & server noise logs
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
    text = re.sub(r"\b20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?: ?[+-]\d{2}:?\d{2}|Z)?\b", "<ts>", text)
    text = re.sub(r"[ \t]+", " ", text).strip()
    # Keep the tail: Mattermost Setup(t) server-startup JSON logs exceed 4000 chars and would otherwise hide the
    # actual assertion failure at the end, making two distinct failures compare equal as PRE_EXISTING.
    return text[-4000:]


_COMPARE_RE: tuple[tuple[re.Pattern[str], str | Callable[[re.Match[str]], str]], ...] = (
    # 1. Temp dir paths (macOS /var/folders, Linux/Go /tmp, /private/tmp)
    (re.compile(
        r"(?:/private)?/var/folders/[A-Za-z0-9_+-]+/[A-Za-z0-9_+-]+/T"
        r"(?:/(?:Test[A-Za-z0-9_.-]*\d{4,}|[^\s\"'`<>()\[\]{},;:/]*\d{5,}[^\s\"'`<>()\[\]{},;:/]*))?"
    ), "<tmpdir>"),
    (re.compile(
        r"(?:/private)?/tmp/(?:Test[A-Za-z0-9_.-]*\d{4,}|[^\s\"'`<>()\[\]{},;:/]*\d{5,}[^\s\"'`<>()\[\]{},;:/]*)"
    ), "<tmpdir>"),
    # 2. Ephemeral loopback ports in transport diagnostics (preserve configured host:port assertions)
    (re.compile(
        r"(\b(?:dial|listen)\s+(?:tcp|udp)\s+)(127\.0\.0\.1|localhost|\[::1\]):\d+\b",
        re.I,
    ), r"\1\2:<port>"),
    (re.compile(
        r"((?:https?|wss?|postgres(?:ql)?|redis|grpc)://|\b(?:addr|address|listen|bind|endpoint|server|url)\s*[:=]\s*[\"']?(?:(?:https?|wss?|postgres(?:ql)?|redis|grpc)://)?)"
        r"(127\.0\.0\.1|localhost|\[::1\]):\d+"
        r"(?=[^\s\"']*[\"']?:\s*(?:dial\b|connect\b|bind\b|connection\s+(?:refused|reset)|EOF|i/o\s+timeout|read:|write:|TLS|reset\s+by\s+peer|broken\s+pipe))",
        re.I,
    ), r"\1\2:<port>"),
    # 3. Go time.Time monotonic clock suffix
    (re.compile(r"\bm=[+-]\d+\.\d+\b"), "m=<mono>"),
    # 4. UUIDs in diagnostic/keyed contexts (8-4-4-4-12 hex; preserves fixed UUID assertion expectations)
    (re.compile(
        r"(?i)\b((?:x[-_])?(?:request|req|trace|span|correlation|session|container|instance|job|run|build|node|worker|cluster|cid|tid|sid|uuid|guid)(?:[_-]?id)?)"
        r"([\"']?\s*[:=\s]\s*[\"']?)"
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
    ), r"\1\2<uuid>"),
    # 5. Mattermost storetest random DB names: db<NewId> / db<random> (before 26-char ID because 'db' has no \b)
    (re.compile(r"\bdb(?:[ybndrfg8ejkmcpqxot1uwisza345h769]{26}|(?=[a-z0-9]*\d)[a-z0-9]{20,})\b"), "<db>"),
    # 6. Mattermost 26-char zbase32 model.NewId() (digit+letter lookahead spares 26-letter English words & 'a'*26)
    (re.compile(
        r"(?<![A-Za-z0-9])"
        r"(?=[ybndrfg8ejkmcpqxot1uwisza345h769]*[13456789])"
        r"(?=[ybndrfg8ejkmcpqxot1uwisza345h769]*[a-z])"
        r"[ybndrfg8ejkmcpqxot1uwisza345h769]{26}"
        r"(?![A-Za-z0-9])"
    ), "<id>"),
    # 7. Epoch timestamps (13-19 digit millis/micros/nanos) only when identified as a timestamp; spares numeric assertions
    (re.compile(
        r"(?i)\b([a-z0-9_]*_at|at|timestamp|ts|time|epoch|unix(?:_[a-z]+)?|created|updated|deleted|expires|ns|ms|us)"
        r"([\"']?\s*[:=]\s*[\"']?)\d{13,19}(?![A-Za-z0-9.])"
    ), r"\1\2<epoch>"),
    (re.compile(r"(?i)\b(timestamp|epoch|unix(?:_[a-z]+)?)\s+\d{13,19}(?![A-Za-z0-9.])"), r"\1 <epoch>"),
    # 8. Labelled ephemeral hex IDs / container IDs / trace IDs (12-64 mixed hex+digit); preserves deterministic checksum assertions
    (re.compile(
        r"(?i)\b(container|docker|pod|trace|span|correlation|request|req|session|instance|run|job|build|node|worker|cid|tid|sid)"
        r"(?:[_-]?id)?([\"']?\s*[:=\s]\s*[\"']?)(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{12,64}(?![A-Za-z0-9])"
    ), r"\1\2<hex>"),
    # 9. React useId() tokens (:r...:, _r_..._; digit/1-char rule spares emojis/CSS like :rocket:, :rage:, :root:)
    (re.compile(r":(?:r|R)(?:[0-9a-z]|(?=[0-9a-z]*\d)[0-9a-z]{2,}):"), "<react-id>"),
    (re.compile(r"(?<![A-Za-z0-9])_r_(?:[0-9a-z]|(?=[0-9a-z]*\d)[0-9a-z]{2,})_(?![A-Za-z0-9])"), "<react-id>"),
    # 10. Keyed request/trace/correlation/session/container/instance IDs (handles '=' and JSON '": "');
    #     preserves explicit assertion operands (`got|want|expected|expect|actual ...`).
    (re.compile(
        r"(?i)(?:(\b(?:got|want|expected|expect|actual)\b\s*[:=]?\s*[\"']?)|)"
        r"\b((?:x[-_])?(?:request|req|trace|span|correlation|session|container|instance)[_-]?id)\b"
        r"([\"']?\s*[:=]\s*[\"']?)"
        r"(?:(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,})"
        r"(?![A-Za-z0-9_-])"
    ), lambda m: m.group(0) if m.group(1) else f"{m.group(2)}{m.group(3)}<id>"),
)


def normalize_for_compare(text: str) -> str:
    """Redact ephemeral per-run IDs/ports/temp-paths/timestamps only when comparing head vs base failures.
    Raw failure text in run_<tag>.messages.json is kept unredacted for reporting, Mode V, and Skeptic."""
    for rx, rep in _COMPARE_RE:
        text = rx.sub(rep, text)
    return text


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
        rel = str(p.resolve().relative_to(wt.resolve()))
        if rel.endswith(".go"):
            # One -run pattern per package: another file's match would hide a file whose tests are misnamed.
            src = p.read_text()
            has_det = re.search(rf"^func TestHunt{mode}_\w*\(", src, re.M)
            if not has_det and not (tag == "A" and fuzz_enabled() and MODE_A_FUZZ_TARGET.search(src)):
                raise CompileError(f"{rel}: no test named TestHunt{mode}_<Name>(t *testing.T); rename the tests")
            if has_det:  # a fuzz-only companion file runs in the fuzz phase, not under this -run pattern
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


def go_package_runtime(out: str) -> float | None:
    times = GO_PACKAGE_TIME.findall(out)
    return float(times[-1]) if times else None


def timeout_caps(runtimes: dict[str, float]) -> dict[str, int]:
    """Per Go package, a `go test -timeout` (seconds) from observed runtimes, so a hanging mutant or base run panics
    in max(60s, 5x baseline) instead of waiting for go test's 10-minute default."""
    return {d: max(MUTANT_TIMEOUT_MIN_S, math.ceil(MUTANT_TIMEOUT_FACTOR * t)) for d, t in runtimes.items()}


def mutant_timeouts(base: Outcome) -> dict[str, int]:
    """Per Go package, the `go test -timeout` (seconds) for a mutant run, from the baseline run of the same suite."""
    return timeout_caps(base.runtimes)


def _rel(wt: Path, sub: str | Path, root: Path) -> str:
    """Path of `wt / sub` relative to `root`, both resolved (macOS /tmp -> /private/tmp symlinks)."""
    return os.path.relpath((wt / sub).resolve(), root.resolve())


def go_compile_binary(wt: Path, d: str, race: bool, out_bin: Path) -> Path:
    """Precompile one Go package test binary with -vet=off; raises GoBuildError on build/setup failure."""
    if race:
        require_disk(scratch())
    root = go_root(wt, d)
    pkg = "./" + _rel(wt, d, root)
    args = ["go", "test", "-c", "-vet=off"] + (["-race"] if race else []) + ["-o", str(out_bin), pkg]
    p = sh(args, root, check=False, timeout=1800)
    if p.returncode != 0 or not out_bin.exists():
        out = p.stdout + p.stderr
        raise GoBuildError(f"{pkg}:\n{out[-2500:]}", d)
    return out_bin


def _goflags_binary_timeout() -> str | None:
    """Return timeout for a prebuilt test binary from GOFLAGS, or None when GOFLAGS sets unsupported runtime flags."""
    raw = os.environ.get("GOFLAGS", "").strip()
    if not raw:
        return "10m"
    try:
        toks = shlex.split(raw)
    except ValueError:
        return None
    timeout = "10m"
    i = 0
    while i < len(toks):
        tok = toks[i]
        if tok.startswith(("-timeout=", "--timeout=", "-test.timeout=")):
            timeout = tok.split("=", 1)[1] or timeout
        elif tok in ("-timeout", "--timeout", "-test.timeout") and i + 1 < len(toks):
            timeout = toks[i + 1] or timeout
            i += 1
        elif tok.startswith(("-vet=", "-mod=", "-tags=", "-count=")) or tok in ("-race", "-trimpath"):
            pass
        elif tok in ("-vet", "-mod", "-tags") and i + 1 < len(toks):
            i += 1
        else:
            return None
        i += 1
    return timeout


def go_run(wt: Path, patterns: dict[str, str], race: bool, into: Outcome,
           timeouts: dict[str, int] | None = None, *,
           bins: dict[str, Path] | None = None, failfast: bool = False) -> None:
    if race and not bins:
        require_disk(scratch())  # before the -race build starts, not after it fails for lack of space
    gf_timeout = _goflags_binary_timeout() if bins else "10m"
    for d, pattern in sorted(patterns.items()):
        root = go_root(wt, d)
        pkg = "./" + _rel(wt, d, root)
        cap = (timeouts or {}).get(d)
        par = os.environ.get("HUNT_GO_PARALLEL", "").strip()
        bin_path = (bins or {}).get(d) if gf_timeout is not None else None
        if bin_path is not None:
            args = ([str(bin_path), "-test.v", f"-test.run={pattern}"]
                    + ([f"-test.parallel={par}"] if par else [])
                    + [f"-test.timeout={cap}s" if cap else f"-test.timeout={gf_timeout}", "-test.paniconexit0"]
                    + (["-test.failfast"] if failfast else []))
            cwd = wt / d
        else:
            args = (["go", "test", "-count=1", "-vet=off", "-v", "-run", pattern] + (["-race"] if race else [])
                    + ([f"-parallel={par}"] if par else [])
                    + ([f"-timeout={cap}s"] if cap else [])
                    + (["-failfast"] if failfast else []) + [pkg])
            cwd = root
        with maybe_pg_pool_lock(d):
            t0 = time.monotonic()
            p = sh(args, cwd, check=False, timeout=1800)
        elapsed = round(time.monotonic() - t0, 3)
        out = p.stdout + p.stderr
        runtime = go_package_runtime(out)
        if runtime is not None:
            into.runtimes[d] = runtime
        elif bin_path is not None:
            into.runtimes[d] = elapsed
        # Identities are package-qualified ("<dir>::<Test>") so equal test names in two packages never overwrite.
        got = {f"{d}::{m.group(2)}": m.group(1) for m in RESULT_GO.finditer(out) if "/" not in m.group(2)}
        if not got:
            if "[build failed]" in out or "[setup failed]" in out:
                raise GoBuildError(f"{pkg}:\n{out[-2500:]}", d)
            if p.returncode != 0 and "=== RUN" in out:
                # A test started and the binary died before any result line (panic in a goroutine, timeout):
                # that is a test failure, not an environment problem.
                got = {f"{d}::{PACKAGE_FAILED}": Verdict.FAIL}
            else:
                raise InfraError(f"0 tests executed in {pkg} (exit {p.returncode}):\n{out[-2500:]}")
        elif p.returncode != 0 and Verdict.FAIL not in got.values():
            # e.g. TestMain teardown, a race report or a panic after the last test: the package failed even though no
            # test line says so. Record it instead of reporting PASS.
            got[f"{d}::{PACKAGE_FAILED}"] = Verdict.FAIL
        into.results.update(got)
        into.packages[d] = Verdict.PASS if p.returncode == 0 else Verdict.FAIL
        for name, block in go_test_output(out).items():
            if got.get(f"{d}::{name}") == Verdict.FAIL:
                into.messages[f"{d}::{name}"] = normalize_failure(block, wt)
        if got.get(f"{d}::{PACKAGE_FAILED}") == Verdict.FAIL:
            into.messages[f"{d}::{PACKAGE_FAILED}"] = normalize_failure(out[-4000:], wt)
        into.log += out


def go_compiles(wt: Path, file: str) -> str | None:
    d = str(Path(file).parent)
    root = go_root(wt, d)
    p = sh(["go", "test", "-c", "-o", os.devnull, "./" + _rel(wt, d, root)], root, check=False, timeout=900)
    return None if p.returncode == 0 else (p.stdout + p.stderr)[-1500:]


# ---------------------------------------------------------------- Jest

JEST_CONFIGS = ("jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs")
# Mattermost's webapp/platform/* packages (types, client, components) have no jest config of their own; the channels
# config maps @mattermost/<pkg> to webapp/platform/<pkg>/src, so a test there runs under it.
JEST_FALLBACK_ROOT = "webapp/channels"


def jest_root(wt: Path, rel: str) -> Path:
    p = (wt / rel).resolve().parent
    while p != wt.resolve().parent:
        if any((p / n).exists() for n in JEST_CONFIGS):
            return p
        p = p.parent
    fallback = wt / JEST_FALLBACK_ROOT
    if Path(rel).parts[:1] == ("webapp",) and any((fallback / n).exists() for n in JEST_CONFIGS):
        return fallback.resolve()
    raise InfraError(f"no jest.config above {rel}")


def jest_pkg_dir(wt: Path, rel: str, root: Path) -> Path | None:
    """For a test outside its config's rootDir (the fallback): the nearest package.json dir above it, else its dir."""
    f = (wt / rel).resolve()
    if f.is_relative_to(root.resolve()):
        return None
    p = f.parent
    while p != wt.resolve() and not (p / "package.json").exists():
        p = p.parent
    return p if p != wt.resolve() else f.parent


def jest_roots_args(wt: Path, rel: str, root: Path) -> list[str]:
    """Jest only finds test files under `roots` (default: rootDir), so a fallback-run test adds its package dir."""
    pkg = jest_pkg_dir(wt, rel, root)
    return [] if pkg is None else ["--roots", str(root.resolve()), "--roots", str(pkg)]


def jest_run(wt: Path, files: list[str], prefix: str, into: Outcome) -> None:
    for rel in files:
        found = 0
        root = jest_root(wt, rel)
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            # --runTestsByPath: a bare path is a regex and would also run e.g. src/packages/.../actions/hunt_a.test.tsx
            # --ci=false: Jest turns --ci on by itself when CI is set, and then a test whose snapshot is missing fails
            # instead of writing one (removed after the run). Verdicts must not depend on where the hunt runs.
            p = sh(["npx", "jest", *jest_roots_args(wt, rel, root), "--runTestsByPath", _rel(wt, rel, root),
                    "--watchAll=false", "--ci=false", "--json", f"--outputFile={out}"],
                   root, check=False, timeout=1200, env=node_env())
            if not out.exists():
                raise InfraError(f"jest wrote no results for {rel}:\n{(p.stdout + p.stderr)[-2500:]}")
            data = json.loads(read_text_lossy(out))
        for f in data.get("testResults", []):
            if not f.get("assertionResults"):
                if f.get("message"):
                    raise CompileError(f"{rel}:\n{f['message'][-2500:]}")
                raise InfraError(f"0 tests executed in {rel}")
            file_failed = False
            for a in f["assertionResults"]:
                if prefix and not a["title"].startswith(prefix):
                    continue
                found += 1
                # file + full name: equal titles in two describe blocks or files never overwrite each other
                key = f"{rel}::{a.get('fullName') or a['title']}"
                status = {"passed": Verdict.PASS, "failed": Verdict.FAIL}.get(a["status"], Verdict.SKIP)
                if status == Verdict.FAIL:
                    file_failed = True
                into.results[key] = status
                failures = a.get("failureMessages") or []
                if failures:
                    into.messages[key] = normalize_failure("\n".join(failures), wt)
                    into.log += "\n".join(failures) + "\n"
            into.packages[rel] = Verdict.FAIL if f.get("status") == "failed" else Verdict.PASS
            if f.get("status") == "failed" and not file_failed and found:
                # e.g. afterAll threw or an unhandled error hit after passing assertions
                pkey = f"{rel}::{PACKAGE_FAILED}"
                into.results[pkey] = Verdict.FAIL
                msg = f.get("message") or f"{rel}: Jest suite failed after assertions passed"
                into.messages[pkey] = normalize_failure(msg, wt)
                into.log += msg + "\n"
        if not found:
            # Checked per file: a passing file must not hide one whose tests were all filtered out.
            raise CompileError(f"{rel}: no test title starts with {prefix!r}; rename the tests")


def jest_compiles(wt: Path, file: str) -> str | None:
    root = jest_root(wt, file)
    p = sh(["node", "-e", "require('@babel/core').transformFileSync(process.argv[1])", str(wt / file)], root,
           check=False, timeout=120, env=node_env())
    return None if p.returncode == 0 else (p.stdout + p.stderr)[-1500:]


# ---------------------------------------------------------------- suite level

def run_suite(wt: Path, s: Suite, race: bool, go_timeouts: dict[str, int] | None = None,
              *, go_bins: dict[str, Path] | None = None, failfast: bool = False) -> Outcome:
    if s.empty():
        raise InfraError("suite is empty: no Go packages or Jest files to run")
    go_kw: dict[str, Any] = {}
    if go_bins is not None:
        go_kw["bins"] = go_bins
    if failfast:
        go_kw["failfast"] = True
    if s.go_patterns and s.jest_files:
        go_o, jest_o = Outcome(), Outcome()
        with ThreadPoolExecutor(max_workers=2) as pool:
            fg = pool.submit(go_run, wt, s.go_patterns, race, go_o, go_timeouts, **go_kw)
            fj = pool.submit(jest_run, wt, s.jest_files, s.jest_prefix, jest_o)
            fg.result()
            fj.result()
        _merge_outcome(go_o, jest_o)
        return go_o
    o = Outcome()
    if s.go_patterns:
        go_run(wt, s.go_patterns, race, o, go_timeouts, **go_kw)
    if s.jest_files:
        jest_run(wt, s.jest_files, s.jest_prefix, o)
    return o


def compiles(wt: Path, file: str) -> str | None:
    return go_compiles(wt, file) if file.endswith(".go") else jest_compiles(wt, file)


def classify(statuses: list[str]) -> Verdict:
    if all(x == Verdict.PASS for x in statuses):
        return Verdict.PASS
    if all(x == Verdict.FAIL for x in statuses):
        return Verdict.FAIL_3_OF_3
    if all(x == Verdict.SKIP for x in statuses):
        return Verdict.SKIP
    return Verdict.FLAKY


def fingerprint(files: list[dict[str, str]]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def target_dirs_for(hdir: Path, state: dict[str, Any], tag: str) -> set[str]:
    """Approved directories hunter `tag` may write hunt_* test files into (Mode R spans all CodeRabbit thread dirs)."""
    dirs = {t["dir"] for t in state["targets"]}
    if tag == "R" and (hdir / "R" / "threads.json").exists():
        dirs |= {t["dir"] for t in load_json(hdir / "R" / "threads.json").get("targets", [])}
    return dirs


def _failure_changed(first: Outcome, rerun: Outcome, ident: str) -> bool:
    if rerun.results.get(ident) != Verdict.FAIL:
        return True
    m1 = first.messages.get(ident, "")
    m2 = rerun.messages.get(ident, "")
    return bool(m1 and m2 and normalize_for_compare(m1) != normalize_for_compare(m2))


def _precompile_go_bins(wt: Path, go_patterns: dict[str, str], race: bool, bin_td: Path) -> dict[str, Path] | None:
    if not go_patterns or not all((wt / d).is_dir() for d in go_patterns):
        return None
    if sh is not _REAL_SH and go_compile_binary is _REAL_GO_COMPILE_BINARY:
        return None
    return {
        d: go_compile_binary(wt, d, race, bin_td / f"{hashlib.sha256(d.encode()).hexdigest()[:8]}.test")
        for d in sorted(go_patterns)
    }


_REAL_RUN_SUITE: Any = None
_REAL_DIFF_UNIT_PASS: Any = None
_REAL_COMPILES: Any = None
_REAL_SH: Any = None
_REAL_GO_COMPILE_BINARY: Any = None


def _call_run_suite(wt: Path, suite: Suite, race: bool, go_bins: dict[str, Path] | None) -> Outcome:
    if go_bins is not None and run_suite is _REAL_RUN_SUITE:
        return run_suite(wt, suite, race=race, go_bins=go_bins)
    return run_suite(wt, suite, race=race)


def _run_lazy_phase(
    hdir: Path, wt: Path, state: dict[str, Any], tag: str, files: list[dict[str, str]], runs: int,
    *, frozen_only: set[str] | None = None,
) -> tuple[dict[str, str], dict[str, str], dict[str, float], set[str], list[Outcome]]:
    placed: list[Path] = []
    outcomes: list[Outcome] = []
    statuses: dict[str, list[str]] = {}  # identity -> one status per run that executed it
    full_pkgs: set[str] = set()
    try:
        placed = place(wt, files, target_dirs_for(hdir, state, tag))
        full = suite_for(tag, state, placed, wt)
        if frozen_only is not None:
            go_files: dict[str, list[str]] = {}
            for f in files:
                if str(f.get("path", "")).endswith(".go"):
                    go_files.setdefault(str(Path(str(f["path"])).parent), []).append(str(f.get("content", "")))
            f_patterns: dict[str, str] = {}
            for d in full.go_patterns:
                src = "\n".join(go_files.get(d, []))
                names = sorted(t for t in frozen_only if re.search(rf"^func {re.escape(t)}\(", src, re.M))
                if names:
                    f_patterns[d] = "^(" + "|".join(re.escape(t) for t in names) + ")$"
            full = Suite(go_patterns=f_patterns)
        if full.empty():
            return {}, {}, {}, full_pkgs, outcomes
        with tempfile.TemporaryDirectory() as bin_td:
            go_bins = (
                _precompile_go_bins(wt, full.go_patterns, True, Path(bin_td))
                if runs > 1 and run_suite is _REAL_RUN_SUITE else None
            )
            first = _call_run_suite(wt, full, True, go_bins)
            outcomes.append(first)
            for n, st in first.results.items():
                statuses[n] = [st]
            # Lazy confirmation (C2): a test that did not fail on the first run is not run again. Only the failures are
            # rerun, up to `runs` runs in all; if a filtered rerun passes/changes, confirm under the original suite first
            # so passing tests that pollute package state do not mask a deterministic failure as FLAKY.
            failing = {n for n, st in first.results.items() if st == Verdict.FAIL}
            for run_idx in range(1, runs):
                suite = _filter_base_suite(full, failing, {}) if failing else Suite()
                for d in full_pkgs:
                    if d in full.go_patterns and d in suite.go_patterns:
                        suite.go_patterns[d] = full.go_patterns[d]
                if suite.empty():
                    break
                o = _call_run_suite(wt, suite, True, go_bins)
                outcomes.append(o)
                changed = {n for n in failing if _failure_changed(first, o, n)}
                if changed:
                    confirm_suite = Suite(
                        go_patterns={d: full.go_patterns[d] for d in full.go_patterns
                                     if any(n.startswith(f"{d}::") for n in changed)
                                     and suite.go_patterns.get(d) != full.go_patterns[d]},
                        jest_files=[rel for rel in full.jest_files
                                    if any(n.startswith(f"{rel}::") for n in changed)
                                    and rel not in suite.jest_files],
                        jest_prefix=full.jest_prefix,
                    )
                    if not confirm_suite.empty():
                        c = _call_run_suite(wt, confirm_suite, True, go_bins)
                        outcomes.append(c)
                        confirmed_units = set(confirm_suite.go_patterns) | set(confirm_suite.jest_files)
                        for n in failing:
                            unit = n.split("::", 1)[0]
                            if unit in confirmed_units:
                                st_c = c.results.get(n, Verdict.MISSING)
                                o.results[n] = st_c
                                if st_c == Verdict.FAIL and n in changed:
                                    full_pkgs.add(unit)
                        for n, st_c in c.results.items():
                            if n not in failing and st_c != Verdict.PASS:
                                statuses.setdefault(n, [Verdict.MISSING] * run_idx).append(st_c)
                for n, st_o in o.results.items():
                    if n not in failing and st_o != Verdict.PASS:
                        statuses.setdefault(n, [Verdict.MISSING] * run_idx).append(st_o)
                for n in failing:
                    statuses[n].append(o.results.get(n, Verdict.MISSING))
                failing = {n for n in failing if o.results.get(n) == Verdict.FAIL}
    finally:
        unplace(placed)
    table: dict[str, str] = {n: classify(statuses[n]).value for n in sorted(statuses)}
    messages = {
        n: next(o.messages[n] for o in outcomes if n in o.messages)
        for n in set().union(*(o.messages for o in outcomes))
    }
    runtimes = {d: max(o.runtimes[d] for o in outcomes if d in o.runtimes)
                for d in set().union(*(o.runtimes for o in outcomes))}
    return table, messages, runtimes, full_pkgs, outcomes


def _merge_phase_tables(
    table: dict[str, str], messages: dict[str, str], runtimes: dict[str, float],
    f_table: dict[str, str], f_messages: dict[str, str], f_runtimes: dict[str, float],
) -> None:
    """Merge deterministic and frozen-fuzz phase verdicts, keeping failure text from any unanimous FAIL_3_OF_3 phase."""
    for k, v in f_table.items():
        old = table.get(k)
        if old in (None, v):
            table[k] = v
        elif Verdict.FAIL_3_OF_3 in (old, v):
            table[k] = Verdict.FAIL_3_OF_3
        else:
            table[k] = Verdict.FLAKY
        if v == Verdict.FAIL_3_OF_3 and old != Verdict.FAIL_3_OF_3:
            if k in f_messages:
                messages[k] = f_messages[k]
            else:
                messages.pop(k, None)
        elif (old != Verdict.FAIL_3_OF_3 or v == Verdict.FAIL_3_OF_3) and k in f_messages:
            messages.setdefault(k, f_messages[k])
    for k, m in f_messages.items():
        if k not in f_table and table.get(k) != Verdict.FAIL_3_OF_3:
            messages.setdefault(k, m)
    for d, t in f_runtimes.items():
        runtimes[d] = max(t, runtimes.get(d, t))


def cmd_run(hdir: Path, state: dict[str, Any], tag: str, runs: int = 3) -> dict[str, Any]:
    wt = Path(state["wt"])
    ensure_clean(wt)
    files = load_json(hdir / tag / "response.json")["files"]
    # Clear outputs of any earlier run for this tag so a compile error or rerun never leaves stale head/base verdicts.
    # Keep compile_<tag>.log as the audit record of any prior repair round (compute_verdicts checks run_R freshness).
    for stale in (f"run_{tag}.json", f"run_{tag}.messages.json", f"run_{tag}.runtimes.json",
                  f"run_{tag}.full_pkgs.json", f"run_{tag}.coverage.json", f"run_{tag}.response.sha256",
                  f"base_{tag}.json", f"base_{tag}.errors.json", f"base_{tag}.response.sha256"):
        (hdir / stale).unlink(missing_ok=True)
    _clear_adjudication(hdir, tag)
    if not files:  # e.g. a Mode B hunter for a PR whose description promises nothing testable
        write_json(hdir / f"run_{tag}.json", {})
        (hdir / f"run_{tag}.response.sha256").write_text(fingerprint(files))
        _clear_adjudication(hdir, tag)
        return {}
    mode = tag[0]
    has_fuzz = (tag == "A" and fuzz_enabled() and any(
        str(f.get("path", "")).endswith(".go") and MODE_A_FUZZ_TARGET.search(str(f.get("content", ""))) for f in files))
    persisted_frozen: set[str] = (
        {m.group(1) for f in files if str(f.get("path", "")).endswith(".go")
         for m in _FROZEN_FUZZ_RE.finditer(str(f.get("content", "")))}
        if tag == "A" else set()
    )
    has_det = any(
        not str(f.get("path", "")).endswith(".go")
        or any(t not in persisted_frozen
               for t in re.findall(rf"^func (TestHunt{mode}_\w*)\(", str(f.get("content", "")), re.M))
        for f in files
    )
    table: dict[str, str] = {}
    messages: dict[str, str] = {}
    runtimes: dict[str, float] = {}
    full_pkgs: set[str] = set()
    outcomes: list[Outcome] = []
    if has_det or not (has_fuzz or persisted_frozen):
        table, messages, runtimes, full_pkgs, outcomes = _run_lazy_phase(hdir, wt, state, tag, files, runs)
    frozen = set(persisted_frozen)
    if has_fuzz:
        rep = cmd_fuzz(hdir, state, tag)
        files = load_json(hdir / tag / "response.json")["files"]
        frozen |= set(rep.get("frozen") or [])
    if frozen:
        f_table, f_messages, f_runtimes, f_pkgs, f_outcomes = _run_lazy_phase(
            hdir, wt, state, tag, files, runs, frozen_only=frozen,
        )
        _merge_phase_tables(table, messages, runtimes, f_table, f_messages, f_runtimes)
        full_pkgs |= f_pkgs
        outcomes.extend(f_outcomes)
    write_json(hdir / f"run_{tag}.json", table)
    write_json(hdir / f"run_{tag}.messages.json", messages)
    if runtimes:
        write_json(hdir / f"run_{tag}.runtimes.json", runtimes)
    if full_pkgs:
        write_json(hdir / f"run_{tag}.full_pkgs.json", sorted(full_pkgs))
    (hdir / f"run_{tag}.log").write_text("\n\n=== run ===\n".join(o.log for o in outcomes))
    (hdir / f"run_{tag}.response.sha256").write_text(fingerprint(files))
    _clear_adjudication(hdir, tag)
    return table


GO_ERROR = re.compile(r"^(\S+?\.go):(\d+):\d+: (.+)$", re.M)
GO_UNDEFINED = re.compile(r"^(?:undefined: (\S+)|(\S+) undefined \()")
GO_UNUSED_IMPORT = re.compile(r'^"[^"]+" imported (?:as \S+ )?and not used')
JS_MISSING = re.compile(r"\(0 , (?:\w+\.)?(\w+)\) is not a function|(\S+) is not a function|(\w+) is not defined|"
                        r"Cannot find module '([^']+)'")
MAX_SALVAGE_ROUNDS = 3  # rounds that remove tests; dropping an import a removal left unused is not counted


def go_build_errors(wt: Path, d: str, extra_dirs: set[str] | None = None) -> str:
    """Every compiler error of one package's tests (-gcflags=-e lifts the default cap of 10)."""
    root = go_root(wt, d)
    flags = ["-gcflags=-e"]
    if extra_dirs is not None:
        flags = []
        for ed in sorted(extra_dirs):
            lp = sh(["go", "list", "-f", "{{.ImportPath}}", "./" + _rel(wt, ed, root)], root, check=False, timeout=300)
            if lp.returncode == 0 and lp.stdout.strip():
                flags.append(f"-gcflags={lp.stdout.strip().splitlines()[0]}=-e")
    p = sh(["go", "test", "-c", "-o", os.devnull, *flags, "./" + _rel(wt, d, root)], root, check=False, timeout=900)
    return p.stdout + p.stderr


def parse_go_errors(errors: str, root: Path, rx: re.Pattern[str] = GO_ERROR) -> list[tuple[Path, int, str]]:
    out: list[tuple[Path, int, str]] = []
    for m in rx.finditer(errors):
        raw = Path(m.group(1))
        out.append(((raw if raw.is_absolute() else root / raw).resolve(), int(m.group(2)), m.group(3).strip()))
    return out


def undefined_names(msg: str) -> list[str]:
    m = GO_UNDEFINED.match(msg)
    return [g for g in m.groups() if g] if m else []


def _uses_unshadowed_helper(code_body: str, hname: str) -> bool:
    esc = re.escape(hname)
    word = re.compile(rf"(?<!\.)\b{esc}\b")
    if not word.search(code_body):
        return False
    var_decl = re.compile(rf"^(?:var|const|type)\s+(?:\w+\s*,\s*)*{esc}\b")
    param_decl = re.compile(rf"\bfunc\b[^{{]*\([^)]*\b{esc}\b")
    block_hdr = re.compile(r"^\s*(?:else\s+if|if|for|switch|select)\b")
    depth = 0
    shadow_at: set[int] = set()
    pending_hdr = False
    for tok in re.split(r"([{}])", code_body):
        if tok == "{":
            depth += 1
            if pending_hdr:
                shadow_at.add(depth)
                pending_hdr = False
            continue
        if tok == "}":
            shadow_at.discard(depth)
            depth = max(0, depth - 1)
            pending_hdr = False
            continue
        if param_decl.search(tok):
            pending_hdr = True
        for raw in re.split(r"[\n;]", tok):
            s = raw.strip()
            if not s:
                continue
            if block_hdr.match(s):
                pending_hdr = False
            if var_decl.match(s):
                _, _, rhs = s.partition("=")
                if rhs and not shadow_at and not pending_hdr and word.search(rhs):
                    return True
                shadow_at.add(depth)
                continue
            if ":=" in s:
                lhs, _, rhs = s.partition(":=")
                if not shadow_at and not pending_hdr and word.search(rhs):
                    return True
                if word.search(lhs):
                    if block_hdr.match(lhs):
                        pending_hdr = True
                    else:
                        shadow_at.add(depth)
                continue
            if not shadow_at and not pending_hdr and not param_decl.search(s) and word.search(s):
                return True
    return False


def go_repair(wt: Path, placed: list[Path], d: str,
              raw_errs: dict[str, str] | None = None) -> tuple[dict[str, list[str]], bool] | None:
    """Remove from the placed copies in package dir `d` the top-level funcs that the base compiler rejects, with every
    helper-dependent func, and drop imports that a removal left unused. Removed lines are blanked, so later error line
    numbers stay valid. Returns ({test identity: undefined identifiers} for removed tests, whether any func was
    removed), or None when an error lies outside any placed hunter func (nothing can be salvaged then)."""
    root = go_root(wt, d)
    mine = {p.resolve(): p for p in placed if p.suffix == ".go" and p.parent.resolve() == (wt / d).resolve()}
    by_func: dict[Path, dict[str, list[tuple[int, str]]]] = {}   # file -> func -> [(line, msg)]
    drop_import: dict[Path, set[int]] = {}
    texts = {p: p.read_text().split("\n") for p in mine.values()}
    blocks = {p: top_blocks(texts[p], "go") for p in mine.values()}
    for f, line, msg in parse_go_errors(go_build_errors(wt, d), root):
        if f not in mine:
            return None
        p = mine[f]
        if GO_UNUSED_IMPORT.match(msg):
            drop_import.setdefault(p, set()).add(line)
            continue
        owner = next((sym for sym, a, b in blocks[p] if a <= line <= b), None)
        if owner is None:
            return None
        by_func.setdefault(p, {}).setdefault(owner, []).append((line, msg))
    if not by_func and not drop_import:
        return None
    removed: dict[str, list[str]] = {}
    cut = False
    wt_res = wt.resolve()
    idents: dict[tuple[Path, str], list[str]] = {}
    err_blocks: dict[tuple[Path, str], list[str]] = {}
    for p, funcs in by_func.items():
        p_res = p.resolve()
        rel_p = (p_res.relative_to(wt_res) if p_res.is_relative_to(wt_res) else p.relative_to(root)).as_posix()
        for sym, items in funcs.items():
            msgs = [m for _, m in items]
            idents[(p, sym)] = sorted({n for m in msgs for n in undefined_names(m)}) or msgs[:1]
            err_blocks[(p, sym)] = [f"{rel_p}:{ln}:1: {m}" for ln, m in items]
    # a removed helper takes down every func that mentions it across the package, merging all helper diagnostics
    all_spans = [(p, sym, a, b) for p in mine.values() for sym, a, b in blocks[p]]
    span_by_key = {(p, sym): (a, b) for p, sym, a, b in all_spans}
    grew = True
    while grew:
        grew = False
        for sym_key in [k for k in idents if not k[1].split(".")[-1].startswith("TestHunt")]:
            hname = sym_key[1].split(".")[-1]
            for op, other, a, b in all_spans:
                okey = (op, other)
                code_body = _GO_COMMENT_OR_STR.sub(" ", "\n".join(texts[op][a - 1:b]))
                if okey != sym_key and _uses_unshadowed_helper(code_body, hname):
                    cur_id = idents.get(okey, [])
                    merged_id = sorted(set(cur_id) | set(idents[sym_key]))
                    cur_err = err_blocks.get(okey, [])
                    merged_err = list(dict.fromkeys(cur_err + err_blocks[sym_key]))
                    if okey not in idents or merged_id != cur_id or merged_err != cur_err:
                        idents[okey] = merged_id
                        err_blocks[okey] = merged_err
                        grew = True
    for (p, sym), (a, b) in ((k, span_by_key[k]) for k in idents):
        texts[p][a - 1:b] = [""] * (b - a + 1)
        cut = True
        if sym.startswith("Test"):
            key = f"{d}::{sym}"
            removed[key] = idents[(p, sym)]
            if raw_errs is not None:
                prev = raw_errs.get(key, "")
                joined = "\n".join(err_blocks[(p, sym)])
                raw_errs[key] = f"{prev}\n{joined}" if prev else joined
    for p, nums in drop_import.items():
        for n in nums:
            texts[p][n - 1] = ""
    for p, rows in texts.items():
        p.write_text("\n".join(rows))
    return removed, cut


def _filter_base_suite(suite: Suite, failing: set[str], gone: dict[str, list[str]]) -> Suite:
    """Narrow a merge-base suite to only packages/files with a FAIL_3_OF_3 head failure and, for Go packages without
    a package-level failure, only the specific failing tests (minus any already removed by salvage)."""
    go_patterns: dict[str, str] = {}
    for d, pat in suite.go_patterns.items():
        if f"{d}::{PACKAGE_FAILED}" in failing:
            go_patterns[d] = pat
            continue
        names = sorted(n.split("::", 1)[1] for n in failing
                       if n.startswith(f"{d}::") and n not in gone)
        if names:
            go_patterns[d] = "^(" + "|".join(re.escape(name) for name in names) + ")$"
    jest_files = [rel for rel in suite.jest_files if any(n.startswith(f"{rel}::") for n in failing)]
    return Suite(go_patterns=go_patterns, jest_files=jest_files, jest_prefix=suite.jest_prefix)


def salvage_go(wt: Path, state: dict[str, Any], tag: str, placed: list[Path],
               race: bool = True, failing: set[str] | None = None,
               go_timeouts: dict[str, int] | None = None,
               raw_errs: dict[str, str] | None = None) -> tuple[Outcome, dict[str, list[str]]]:
    """run_suite on the merge-base, but a Go test file that does not build there loses only the funcs the compiler
    rejects (the placed copies, never response.json) and is retried, up to MAX_SALVAGE_ROUNDS rounds. Returns the
    outcome of what remained and {removed test identity: identifiers it could not resolve}."""
    gone: dict[str, list[str]] = {}
    rounds = fixups = 0
    test_pat = re.compile(rf"^func TestHunt{tag[0]}_\w*\(", re.M)
    while True:
        live = [p for p in placed if p.exists()]
        has_test = {p for p in live if p.suffix == ".go" and test_pat.search(p.read_text())}
        active_go_dirs = {p.parent.resolve() for p in has_test}
        for p in live:  # drop helper/fuzz-only .go files once their package has no TestHunt<mode>_ left
            if p.suffix == ".go" and p not in has_test and p.parent.resolve() not in active_go_dirs:
                p.unlink()
        live = [p for p in placed if p.exists()]
        suite = suite_for(tag, state, [p for p in live if p.suffix != ".go" or p in has_test], wt)
        if failing is not None:
            suite = _filter_base_suite(suite, failing, gone)
        if suite.empty():
            return Outcome(), gone
        try:
            return run_suite(wt, suite, race=race, go_timeouts=go_timeouts), gone
        except GoBuildError as e:
            fixed = go_repair(wt, live, e.pkg_dir, raw_errs=raw_errs) if rounds < MAX_SALVAGE_ROUNDS and fixups < 3 else None
            if fixed is None:
                raise
            gone.update(fixed[0])
            if fixed[1]:
                rounds += 1
            else:
                fixups += 1  # only imports changed: mechanical, so it does not use up a round


def jest_missing(msg: str) -> list[str]:
    return sorted({x for m in JS_MISSING.findall(msg) for x in m if x})[:5]


def base_verdict(name: str, base_status: str, head: dict[str, str], head_msgs: dict[str, str], base_msg: str) -> str:
    """Only a test that failed 3/3 on head gets a bug verdict; anything else is labelled as not a failure."""
    if head.get(name) != Verdict.FAIL_3_OF_3:
        return Verdict.NOT_A_HEAD_FAILURE
    if base_status == Verdict.PASS:
        return Verdict.NEW_PR_BUG
    if base_status != Verdict.FAIL:
        return base_status
    if name in head_msgs and normalize_for_compare(head_msgs[name]) == normalize_for_compare(base_msg):
        return Verdict.PRE_EXISTING
    if MISSING_ON_BASE.search(base_msg):
        # Jest (Babel, no type check) loads a test of a function the PR adds; on base it fails as "not a function".
        return Verdict.NEW_API
    return Verdict.BASE_FAILS_DIFFERENTLY  # decide from the diff, as for BASE_UNCOMPILABLE


def base_table(head: dict[str, str], head_msgs: dict[str, str], o: Outcome) -> dict[str, str]:
    """One verdict per test the base run reported, plus one for every head failure it did not report."""
    out = {n: base_verdict(n, s, head, head_msgs, o.messages.get(n, "")) for n, s in o.results.items()}
    for n, status in head.items():
        if status == Verdict.FAIL_3_OF_3 and n not in o.results:
            # No result line for it on base. A package-level failure (teardown, a late race or panic) on head is new
            # if the same package exited cleanly on base; otherwise the package died on base or the test is absent.
            pkg = o.packages.get(n.split("::", 1)[0])
            if n.endswith(f"::{PACKAGE_FAILED}") and pkg == Verdict.PASS:
                out[n] = Verdict.NEW_PR_BUG
            elif pkg == Verdict.FAIL or o.results.get(n.split("::", 1)[0] + f"::{PACKAGE_FAILED}") == Verdict.FAIL:
                out[n] = Verdict.BASE_FAILS_DIFFERENTLY
            else:
                out[n] = Verdict.NOT_RUN_ON_BASE
    return out


_GO_COMMENT_OR_STR = re.compile(r'"(?:\\.|[^"\\])*"|`[^`]*`|//[^\n]*|/\*[\s\S]*?\*/')
_RECV_TYPE_ERR = re.compile(r"\(type \*?(?:(\w+)\.)?(\w+) has no field or method \w+")
_GO_IMPORT_SPEC = re.compile(r'^(?:\s*(?:import\s+)?(?:(\w+)\s+)?"([^"]+)")', re.M)


def _clear_adjudication(hdir: Path, tag: str) -> None:
    if tag not in ("A", "A2", "B", "D"):
        return
    for name in ("vetted.json", "verdict.json", "findings.json", "audit.md", "hunt_done.json"):
        (hdir / name).unlink(missing_ok=True)


def _strip_go_comments(src: str) -> str:
    return _GO_COMMENT_OR_STR.sub(lambda m: m.group(0) if m.group(0)[0] in ('"', '`') else "", src)


def _go_import_dir(wt: Path, err_file: str, pkg_alias: str, source_texts: dict[str, str] | None = None) -> str | None:
    """Resolve a Go selector qualifier (`pkg_alias`) to a repo-relative directory under wt via imports + go.mod."""
    texts: list[str] = []
    if source_texts and err_file in source_texts:
        texts.append(source_texts[err_file])
    if (wt / err_file).is_file():
        texts.append((wt / err_file).read_text(errors="replace"))
    pkg_dir = str(Path(err_file).parent)
    if (wt / pkg_dir).is_dir():
        for p in sorted((wt / pkg_dir).glob("*.go"))[:10]:
            texts.append(p.read_text(errors="replace"))
    try:
        root = go_root(wt, pkg_dir if pkg_dir != "." else "")
    except InfraError:
        root = wt
    mod_m = re.search(r"^module\s+(\S+)", (root / "go.mod").read_text(errors="replace"), re.M) if (root / "go.mod").is_file() else None
    mod_name = mod_m.group(1) if mod_m else ""
    for src in texts:
        for m in _GO_IMPORT_SPEC.finditer(_strip_go_comments(src)):
            alias, imp = m.group(1), m.group(2)
            inferred = alias or imp.rsplit("/", 1)[-1]
            if inferred != pkg_alias:
                continue
            if mod_name and (imp == mod_name or imp.startswith(mod_name + "/")):
                sub = imp[len(mod_name):].lstrip("/")
                cand = (root / sub) if sub else root
                if cand.is_dir() and cand.is_relative_to(wt.resolve()):
                    rel = cand.relative_to(wt.resolve()).as_posix()
                    return "" if rel == "." else rel
    return None


def _matches_pkg_decl(src: str, pkg_alias: str | None) -> bool:
    if not pkg_alias:
        return True
    m = re.search(r"^\s*package\s+(\w+)\b", _strip_go_comments(src), re.M)
    return bool(m and m.group(1) == pkg_alias)


def _has_go_decl(src: str, name: str, recv: str | None = None) -> bool:
    """True when `src` contains a package-level Go declaration for `name` (or member when `recv` is specified)."""
    clean = _GO_COMMENT_OR_STR.sub(lambda m: "\n" * m.group(0).count("\n") + " ", src)
    sym = re.escape(name)
    block_kind: str | None = None
    depth = 0
    member_re = re.compile(rf"^{sym}(?:\s*,\s*\w+)*(?:\s|\(|\[|=|$)")
    for line in clean.splitlines():
        s = line.strip()
        if not s:
            continue
        if depth == 0:
            if recv:
                r = re.escape(recv)
                if re.match(rf"^func\s+\([^)]*\*?\s*{r}\b[^)]*\)\s*{sym}\s*(?:\[|\()", s):
                    return True
            else:
                if (re.match(rf"^func\s+{sym}\s*(?:\[|\()", s)
                        or re.match(rf"^type\s+{sym}\b", s)
                        or re.match(rf"^(?:var|const)\s+(?:\w+\s*,\s*)*{sym}\b", s)):
                    return True
            inline = ""
            if recv:
                m_type = re.match(rf"^type\s+{re.escape(recv)}\b.*\b(?:struct|interface)\s*\{{(.*)$", s)
                if m_type:
                    block_kind = "type"
                    inline = m_type.group(1)
            else:
                m_grp = re.match(r"^(?:const|var|type)\s*\((.*)$", s)
                if m_grp:
                    block_kind = "group"
                    inline = m_grp.group(1)
            if inline:
                cur_d = 1
                stmt_buf: list[str] = []
                for ch in inline:
                    if cur_d == 1 and ch in (";", "}", ")"):
                        part = "".join(stmt_buf).strip()
                        if part and member_re.match(part):
                            return True
                        stmt_buf = []
                    elif not (cur_d == 1 and ch in ("}", ")")):
                        stmt_buf.append(ch)
                    if ch in ("{", "("):
                        cur_d += 1
                    elif ch in ("}", ")"):
                        cur_d -= 1
                        if cur_d <= 0:
                            break
                if cur_d == 1:
                    part = "".join(stmt_buf).strip()
                    if part and member_re.match(part):
                        return True
        elif depth == 1 and block_kind is not None and any(member_re.match(p.strip()) for p in s.split(";")):
            return True
        depth += s.count("{") + s.count("(") - s.count("}") - s.count(")")
        if depth <= 0:
            depth = 0
            block_kind = None
    return False


def _go_files_matching(wt: Path, name: str, scope_dir: str | None = None) -> list[Path]:
    args = ["grep", "-l", "-w", "-F", "-e", name, "--"]
    if scope_dir and scope_dir != ".":
        args.append(f"{scope_dir}/*.go")
    else:
        args.append("*.go")
    p = sh(git_cmd(*args), wt, check=False)
    if p.returncode == 0:
        return [
            wt / rel for rel in p.stdout.splitlines()
            if rel.endswith(".go") and (wt / rel).is_file()
            and (scope_dir is None or Path(rel).parent.as_posix() == scope_dir)
        ]
    if p.returncode == 1:
        return []
    root = (wt / scope_dir) if scope_dir and scope_dir != "." else wt
    if not root.is_dir():
        return []
    return list(root.glob("*.go") if scope_dir is not None else root.rglob("*.go"))


def _decl_added_on_head(wt_head: Path, name: str, scope_dir: str | None, recv: str | None,
                        wt_base: Path | None, pkg_alias: str | None = None) -> bool:
    head_files = _go_files_matching(wt_head, name, scope_dir)
    if not any(_matches_pkg_decl(txt := p.read_text(errors="replace"), pkg_alias) and _has_go_decl(txt, name, recv)
               for p in head_files):
        return False
    if wt_base is not None:
        base_files = _go_files_matching(wt_base, name, scope_dir)
        if any(_matches_pkg_decl(txt := p.read_text(errors="replace"), pkg_alias) and _has_go_decl(txt, name, recv)
               for p in base_files):
            return False
    return True


def go_pr_added_names(wt_head: Path, errors: str, *, pkg_dir: str = "",
                      wt_base: Path | None = None,
                      source_texts: dict[str, str] | None = None) -> list[str] | None:
    """A8: the identifiers a Go build failure on the merge-base leaves undefined, when EVERY error is an undefined
    name (an import left unused does not count) and every such name has a declaration on the PR head in the relevant
    package or receiver (and absent from that scope on base when provided). None otherwise."""
    entries = [(m.group(1), m.group(3).strip()) for m in GO_ERROR.finditer(errors)]
    entries = [(f, msg) for f, msg in entries if not GO_UNUSED_IMPORT.match(msg)]
    if not entries:
        return None
    checks: dict[tuple[str, str | None, str | None, str | None], str] = {}
    for err_file, msg in entries:
        found = undefined_names(msg)
        if not found:
            return None
        recv_m = _RECV_TYPE_ERR.search(msg)
        recv_pkg = recv_m.group(1) if recv_m else None
        recv = recv_m.group(2) if recv_m else None
        for raw in found:
            sym = raw.split(".")[-1]
            if "." in raw or recv is not None:
                alias = recv_pkg if recv is not None else raw.rsplit(".", 1)[0]
                imp_dir = _go_import_dir(wt_head, err_file, alias, source_texts) if alias else None
                if imp_dir is not None:
                    checks[(sym, imp_dir or ".", recv, None)] = sym
                else:
                    local_scope = None
                    if recv is not None and not recv_pkg:
                        sc = pkg_dir or str(Path(err_file).parent)
                        local_scope = sc if (wt_head / sc).is_dir() else None
                    checks[(sym, local_scope, recv, alias)] = sym
            else:
                scope = pkg_dir or str(Path(err_file).parent)
                scope_val = scope if (wt_head / scope).is_dir() else None
                checks[(sym, scope_val, None, None)] = sym
    return sorted(set(checks.values())) if all(
        _decl_added_on_head(wt_head, sym, sc, rv, wt_base, pa) for sym, sc, rv, pa in checks
    ) else None


def _unit_key(rel: str) -> str:
    return str(Path(rel).parent) if rel.endswith(".go") else os.path.normpath(rel)


def group_by_unit(files: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for f in files:
        grouped.setdefault(_unit_key(str(f.get("path", ""))), []).append(f)
    return grouped


def _place_units(
    root: Path, by_unit: dict[str, list[dict[str, str]]], targets: set[str], keys: list[str] | None = None,
) -> list[tuple[str, list[Path]]]:
    all_placed: list[Path] = []
    units: list[tuple[str, list[Path]]] = []
    try:
        for uk in (by_unit if keys is None else keys):
            up = place(root, by_unit[uk], targets)
            all_placed.extend(up)
            units.append((uk, up))
    except BaseException:
        unplace(all_placed)
        raise
    return units


def _failing_base_units(
    files: list[dict[str, str]], failing: set[str],
) -> list[tuple[str, list[dict[str, str]], set[str]]]:
    """Group response files into independent base-vetting units (Go package dir or Jest file) that have FAIL_3_OF_3."""
    return [(k, grp, uf) for k, grp in group_by_unit(files).items()
            if (uf := {n for n in failing if n.startswith(f"{k}::")})]


def cmd_base(hdir: Path, state: dict[str, Any], tag: str) -> dict[str, Any]:
    """NEW_PR_BUG: failed 3/3 on head, passes on base. PRE_EXISTING: fails with the same normalized failure on base.
    NEW_API: failed 3/3 on head and cannot run on base because it uses an API the PR adds (a Go test the base compiler
    rejects is cut from the placed copy and the rest is vetted; a Jest test that fails as "not a function"); the
    undefined names are in the "new_api" key. It is not a bug by itself: root-cause it. BASE_UNCOMPILABLE ("*": nothing
    could be salvaged) / BASE_FAILS_DIFFERENTLY / NOT_RUN_ON_BASE: decide from the diff. NOT_A_HEAD_FAILURE: nothing
    to vet. A build failure whose every error names only symbols the PR adds is NEW_API too (A8); any other build failure
    is BASE_UNCOMPILABLE per test, with every error kept in base_<tag>.errors.json ({unit: error text})."""
    wt = Path(state["wt_base"])
    ensure_clean(wt)
    (hdir / f"base_{tag}.errors.json").unlink(missing_ok=True)
    files = load_json(hdir / tag / "response.json")["files"]
    if not (hdir / f"run_{tag}.json").exists():
        raise InfraError(f"run_{tag}.json missing: run `run.py run <pr> {tag}` before `base`")
    digest = fingerprint(files)
    sha = hdir / f"run_{tag}.response.sha256"
    if not sha.exists() or sha.read_text().strip() != digest:
        raise InfraError(f"{tag}/response.json changed since run_{tag}.json was written; run `run.py run <pr> {tag}` "
                         "again so base vets the tests that produced the head verdicts")
    head = load_json(hdir / f"run_{tag}.json")
    head_msgs = (load_json(hdir / f"run_{tag}.messages.json")
                 if (hdir / f"run_{tag}.messages.json").exists() else {})
    runtimes_path = hdir / f"run_{tag}.runtimes.json"
    go_timeouts = timeout_caps(load_json(runtimes_path)) if runtimes_path.exists() else None
    failing = {n for n, v in head.items() if v == Verdict.FAIL_3_OF_3}
    out: dict[str, Any] = {n: Verdict.NOT_A_HEAD_FAILURE for n in head if n not in failing}
    approved_dirs = target_dirs_for(hdir, state, tag)
    new_api: dict[str, list[str]] = {}
    uncompilable: list[tuple[str, set[str], str, list[str] | None, bool]] = []  # unit, failing tests, error, PR-added names, is_go
    any_ran = False
    evidence: dict[str, str] = {}
    src_texts = {str(f.get("path", "")): str(f.get("content", "")) for f in files if isinstance(f, dict)}
    units = _failing_base_units(files, failing) if files and failing else []
    full_pkgs_path = hdir / f"run_{tag}.full_pkgs.json"
    full_pkgs = set(load_json(full_pkgs_path)) if full_pkgs_path.exists() else set()
    for unit_key, unit_files, unit_failing in units:
        placed: list[Path] = []
        try:
            placed = place(wt, unit_files, approved_dirs)
            raw_errs: dict[str, str] = {}
            failing_arg = None if unit_key in full_pkgs else unit_failing
            o, gone = salvage_go(wt, state, tag, placed, failing=failing_arg, go_timeouts=go_timeouts, raw_errs=raw_errs)
            out.update(base_table({n: head[n] for n in unit_failing}, head_msgs, o))
            for n, idents in gone.items():  # removed from the base copies: only confirmed PR-added APIs are NEW_API
                if n in unit_failing:
                    err_txt = raw_errs.get(n) or "\n".join(f"{unit_key}/x_test.go:1:1: {m}" for m in idents)
                    added = go_pr_added_names(Path(state["wt"]), err_txt, pkg_dir=unit_key, wt_base=wt,
                                              source_texts=src_texts)
                    if added:
                        out[n] = Verdict.NEW_API
                        new_api[n] = added
                    else:
                        out[n] = Verdict.BASE_UNCOMPILABLE
                        prev = evidence.get(unit_key, "")
                        evidence[unit_key] = f"{prev}\n{err_txt}" if prev else err_txt
            for n in unit_failing:
                if out.get(n) == Verdict.NEW_API and n not in new_api:  # Jest: the failure text names what is missing
                    new_api[n] = jest_missing(o.messages.get(n, ""))
            any_ran = True
        except CompileError as e:
            err, added, is_go = str(e), None, isinstance(e, GoBuildError)
            if isinstance(e, GoBuildError):  # the full error list: the message keeps only the tail of a long one
                err_full = go_build_errors(wt, e.pkg_dir)
                added = go_pr_added_names(Path(state["wt"]), err_full, pkg_dir=e.pkg_dir, wt_base=wt,
                                          source_texts=src_texts)
                err = f"{err[:200]}\n...\n{err_full}" if err_full.strip() else err
            uncompilable.append((unit_key, unit_failing, err, added, is_go))
        finally:
            unplace(placed)
    if uncompilable:
        details: list[str] = []
        for unit_key, unit_failing, err, added, is_go in uncompilable:
            is_missing = (not is_go) and bool(MISSING_ON_BASE.search(err))
            evidence[unit_key] = err
            for n in sorted(unit_failing):
                if added or is_missing:
                    out[n] = Verdict.NEW_API
                    new_api[n] = added or jest_missing(err)
                else:
                    out[n] = Verdict.BASE_UNCOMPILABLE
            if not (added or is_missing):
                details.append(f"{unit_key}: {err[-300:]}")
        if details:
            out["detail"] = "\n".join(details)[-800:]
        if not any_ran and failing and all(out.get(n) == Verdict.BASE_UNCOMPILABLE for n in failing):
            out["*"] = Verdict.BASE_UNCOMPILABLE  # nothing could be salvaged: the file-wide verdict
            out["detail"] = uncompilable[-1][2][-800:]
    if evidence:
        write_json(hdir / f"base_{tag}.errors.json", evidence)
    if new_api:
        out["new_api"] = new_api
    write_json(hdir / f"base_{tag}.json", out)
    (hdir / f"base_{tag}.response.sha256").write_text(digest)
    _clear_adjudication(hdir, tag)
    return out


# ---------------------------------------------------------------- differential recorders (Mode D)

DIFF_EXAMPLES = 5
# A recorder whose two head runs agree on fewer records than this (or on fewer than all of them, when it wrote fewer)
# is NONDETERMINISTIC: too little stable evidence to compare. Records that differ between the runs are dropped.
MIN_STABLE_RECORDS = 3
NO_RECORD = "<no record>"
TARGET_MISSING = re.compile(r"target missing", re.I)


@contextlib.contextmanager
def diff_out(path: Path) -> Iterator[None]:
    """HUNT_DIFF_OUT=<path> for the test processes started inside the block (go test and jest inherit os.environ)."""
    old = os.environ.get("HUNT_DIFF_OUT")
    os.environ["HUNT_DIFF_OUT"] = str(path)
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("HUNT_DIFF_OUT", None)
        else:
            os.environ["HUNT_DIFF_OUT"] = old


def read_records(path: Path) -> dict[str, dict[int, dict[str, Any]]]:
    """{test name: {i: record without test and i}} from one HUNT_DIFF_OUT file. A line that is not a JSON object with a
    test and an integer i is skipped (a recorder that printed something else); a repeated (test, i) keeps the last."""
    out: dict[str, dict[int, dict[str, Any]]] = {}
    if not path.exists():
        return out
    for line in read_text_lossy(path).splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict) or not isinstance(rec.get("test"), str) or not isinstance(rec.get("i"), int):
            continue
        out.setdefault(canon_record_name(rec["test"]), {})[rec["i"]] = {k: v for k, v in rec.items() if k not in ("test", "i")}
    return out


def canon_record_name(name: str) -> str:
    """One spelling for a recorder's name: TestHuntD_X and HuntD_X are the same recorder (a Jest recorder may label its
    records Go-style, as seen on PR #40187, where every record went unmatched and both tests read NO_RECORDS)."""
    return name[4:] if name.startswith("TestHuntD_") else name


def record_name(identity: str) -> str:
    """The canonical `test` for a run.py identity: "<dir>::TestHuntD_X" -> HuntD_X, and for Jest
    "<file>::HuntD HuntD_x" (describe + title) -> HuntD_x."""
    return canon_record_name(identity.split("::", 1)[1].split(" ")[-1])


def _json_eq(a: Any, b: Any) -> bool:
    """Compare decoded JSON values strictly by JSON type/structure (unlike Python's == where True == 1)."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def stable_indices(x: dict[int, dict[str, Any]], y: dict[int, dict[str, Any]]) -> set[int]:
    """The record indices two runs of one recorder agree on (written by both, equal)."""
    return {i for i in set(x) | set(y) if _json_eq(x.get(i), y.get(i))}


def diff_records(head: dict[int, dict[str, Any]], base: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    """Every (test, i) whose record differs, smallest input (by JSON length) first. An input that differs between the two
    sides (a generator that reads the code under test) is shown as `base_input` next to `input`."""
    def side(rec: dict[str, Any] | None) -> Any:
        if rec is None:
            return NO_RECORD
        return {"panic": rec["panic"]} if "panic" in rec else rec.get("output")

    found = []
    for i in sorted(set(head) | set(base)):
        h, b = head.get(i), base.get(i)
        if _json_eq(h, b):
            continue
        ex: dict[str, Any] = {"i": i, "input": (h or b or {}).get("input"), "base": side(b), "head": side(h)}
        if h is not None and b is not None and not _json_eq(h.get("input"), b.get("input")):
            ex["base_input"] = b.get("input")
        found.append(ex)
    return sorted(found, key=lambda e: (len(json.dumps(e["input"], sort_keys=True)), e["i"]))


def _merge_outcome(dst: Outcome, src: Outcome) -> None:
    dst.results.update(src.results)
    dst.messages.update(src.messages)
    dst.packages.update(src.packages)
    dst.runtimes.update(src.runtimes)
    dst.log += src.log


def _diff_unit_pass(
    wt: Path, state: dict[str, Any], tag: str, units: list[tuple[str, list[Path]]],
    td: Path, stem: str, *, base: bool = False, only: str | None = None,
    go_bins: dict[str, Path] | None = None,
) -> tuple[Outcome, dict[tuple[str, str], dict[int, dict[str, Any]]], dict[str, str], dict[str, list[str]], list[str]]:
    """Execute Mode D units one at a time so identically named recorders across packages never overwrite each other."""
    merged = Outcome()
    recs: dict[tuple[str, str], dict[int, dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    gone: dict[str, list[str]] = {}
    raw_lines: list[str] = []
    only_set = {only} if only else None
    for idx, (u_key, u_placed) in enumerate(units):
        uf = td / f"{stem}_{idx}.jsonl"
        try:
            with diff_out(uf):
                if base:
                    o, u_gone = salvage_go(wt, state, tag, u_placed, race=False, failing=only_set)
                    gone.update(u_gone)
                else:
                    suite = suite_for(tag, state, u_placed, wt)
                    if only_set is not None:
                        suite = _filter_base_suite(suite, only_set, {})
                    o = run_suite(wt, suite, race=False, go_bins=go_bins) if go_bins is not None else run_suite(wt, suite, race=False)
            _merge_outcome(merged, o)
            if uf.exists():
                text = read_text_lossy(uf)
                if text:
                    raw_lines.append(text.rstrip("\n") + "\n")
            for cname, u_recs in read_records(uf).items():
                recs[(u_key, cname)] = u_recs
        except CompileError as e:
            if not base:
                raise
            errors[u_key] = str(e)[-800:]
        except InfraError as e:
            if not (base and stem == "base2"):
                raise
            errors[u_key] = str(e)[-800:]
    return merged, recs, errors, gone, raw_lines


def _confirm_diff_on_base(
    wt_base: Path, state: dict[str, Any], tag: str, by_unit: dict[str, list[dict[str, str]]], targets: set[str],
    pending: list[tuple[str, str, tuple[str, str], dict[int, dict[str, Any]], set[int],
                        dict[int, dict[str, Any]], set[int]]],
    verdicts: dict[str, str], detail: dict[str, Any], *, only: str | None = None,
) -> None:
    """R5: rerun the merge-base once, only for the units that hold a DIFF recorder, and keep the DIFF only on records
    the two base runs agree on. A DIFF whose every differing record is unstable on base becomes NONDETERMINISTIC; a
    unit that cannot be rerun keeps its first-run verdict."""
    unit_paths = _place_units(wt_base, by_unit, targets, sorted({u for _, u, *_ in pending}))
    kw: dict[str, Any] = {"only": only} if only is not None else {}
    try:
        with tempfile.TemporaryDirectory() as td:
            try:
                base2_out, recs2, errors2, gone2, _ = _diff_unit_pass(wt_base, state, tag, unit_paths, Path(td),
                                                                      "base2", base=True, **kw)
            except InfraError:  # the rerun could not run: every pending DIFF keeps its first-run verdict
                base2_out, recs2, errors2, gone2 = Outcome(), {}, {u: "base rerun failed" for u, _ in unit_paths}, {}
    finally:
        unplace([p for _, ps in unit_paths for p in ps])
    for ident, u_key, rkey, a, stable, base1, cmp_idx in pending:
        if (u_key in errors2 or ident in gone2 or base2_out.results.get(ident) != Verdict.PASS
                or base2_out.results.get(f"{u_key}::{PACKAGE_FAILED}") == Verdict.FAIL):
            detail[ident]["base_rerun"] = "not available; DIFF from one base run"
            continue
        base2 = recs2.get(rkey, {})
        base_ok = stable_indices(base1, base2)
        keep = {i for i in cmp_idx if i in base_ok or (i not in base1 and i not in base2)}
        unstable = len(cmp_idx - keep)
        diffs = diff_records({i: a[i] for i in stable if i in keep}, {i: r for i, r in base1.items() if i in keep})
        if diffs:
            detail[ident].update({"differing": len(diffs), "compared": len(keep), "examples": diffs[:DIFF_EXAMPLES]})
        else:  # every differing record changed between the two base runs: no stable evidence
            prior_dropped = detail[ident].get("dropped", 0)
            verdicts[ident] = Verdict.NONDETERMINISTIC
            detail[ident] = {"detail": f"the {detail[ident]['differing']} differing record(s) are not stable between two "
                                       "runs on the merge-base; dropped", "dropped": prior_dropped + unstable}
            continue
        if unstable:
            detail[ident]["dropped"] = detail[ident].get("dropped", 0) + unstable


def cmd_diff(hdir: Path, state: dict[str, Any], tag: str = "D", *,
             only: str | None = None, write_outputs: bool = True,
             detail_out: dict[str, Any] | None = None) -> dict[str, str]:
    """Run the Mode D recorders on the PR head (twice) and on the merge-base (once), then compare their records.
    The model wrote the inputs and the recorder; code decides: SAME (all records equal), DIFF (some differ: up to
    DIFF_EXAMPLES smallest examples per test in diff_D.examples.json), NONDETERMINISTIC (fewer than MIN_STABLE_RECORDS
    records agree between the two head runs, or a DIFF whose records are all unstable between two base runs). Records
    that differ between the two head runs are dropped from the comparison and counted in "dropped"; a DIFF is rerun
    once on the merge-base, for its units only, and kept on the records both base runs agree on, BASE_UNCOMPILABLE (that test cannot build or load on the merge-base because it uses
    something the PR adds), BASE_FAILED, RECORDER_FAILED (failed on head), NO_RECORDS (passed but wrote nothing)."""
    if tag != "D":
        raise InfraError(f"diff is for the Mode D tag (D), not {tag}")
    wt, wt_base = Path(state["wt"]), Path(state["wt_base"])
    ensure_clean(wt)
    ensure_clean(wt_base)
    require_disk(scratch())
    files = load_json(hdir / tag / "response.json")["files"]
    verdicts: dict[str, str] = {}
    detail: dict[str, Any] = detail_out if detail_out is not None else {}
    if write_outputs:
        for stale in (f"diff_{tag}.json", f"diff_{tag}.examples.json", f"diff_{tag}.response.sha256"):
            (hdir / stale).unlink(missing_ok=True)
        _clear_adjudication(hdir, tag)
    if not files:
        if write_outputs:
            write_json(hdir / f"diff_{tag}.json", verdicts)
            write_json(hdir / f"diff_{tag}.examples.json", detail)
            (hdir / f"diff_{tag}.response.sha256").write_text(fingerprint(files))
            _clear_adjudication(hdir, tag)
        return verdicts
    targets = {t["dir"] for t in state["targets"]}
    by_unit = group_by_unit(files)
    if only is not None:
        only_unit = only.split("::", 1)[0]
        by_unit = {k: v for k, v in by_unit.items() if k == only_unit}
        if not by_unit:
            raise InfraError(f"no Mode D unit found for {only!r} in {hdir / tag / 'response.json'}")

    with tempfile.TemporaryDirectory() as td_str:
        td = Path(td_str)
        runs: list[Outcome] = []
        head_recs: list[dict[tuple[str, str], dict[int, dict[str, Any]]]] = []
        head_raw: list[str] = []
        head_units = _place_units(wt, by_unit, targets)
        kw: dict[str, Any] = {"only": only} if only is not None else {}
        try:
            head_bins: dict[str, Path] | None = None
            if _diff_unit_pass is _REAL_DIFF_UNIT_PASS:
                go_dirs = sorted({d for _, ps in head_units for d in suite_for(tag, state, ps, wt).go_patterns})
                head_bins = _precompile_go_bins(wt, dict.fromkeys(go_dirs, "^TestHunt"), False, td)
            for pass_i in range(2):
                pass_kw = {**kw, **({"go_bins": head_bins} if head_bins is not None and _diff_unit_pass is _REAL_DIFF_UNIT_PASS else {})}
                o, recs, _, _, raw = _diff_unit_pass(wt, state, tag, head_units, td, f"head{pass_i + 1}", **pass_kw)
                runs.append(o)
                head_recs.append(recs)
                if pass_i == 0:
                    head_raw = raw
        finally:
            unplace([p for _, ps in head_units for p in ps])

        gone: dict[str, list[str]] = {}
        base_errors: dict[str, str] = {}
        base = Outcome()
        base_recs: dict[tuple[str, str], dict[int, dict[str, Any]]] = {}
        base_raw: list[str] = []
        base_units = _place_units(wt_base, by_unit, targets)
        try:
            base, base_recs, base_errors, gone, base_raw = _diff_unit_pass(
                wt_base, state, tag, base_units, td, "base", base=True, **kw)
        finally:
            unplace([p for _, ps in base_units for p in ps])

        if write_outputs:
            (hdir / f"diff_{tag}.head.jsonl").write_text("".join(head_raw))
            (hdir / f"diff_{tag}.base.jsonl").write_text("".join(base_raw))
    pending_diff: list[tuple[str, str, tuple[str, str], dict[int, dict[str, Any]], set[int],
                             dict[int, dict[str, Any]], set[int]]] = []
    for ident in sorted(set(runs[0].results) | set(runs[1].results)):
        if only is not None and ident != only:
            continue
        u_key = ident.split("::", 1)[0]
        rkey = (u_key, record_name(ident))
        statuses = [r.results.get(ident, Verdict.MISSING) for r in runs]
        a, b = head_recs[0].get(rkey, {}), head_recs[1].get(rkey, {})
        stable = stable_indices(a, b)
        head_pkg_failed = any(r.results.get(f"{u_key}::{PACKAGE_FAILED}") == Verdict.FAIL for r in runs)
        if any(s != Verdict.PASS for s in statuses) or head_pkg_failed:
            verdicts[ident] = Verdict.RECORDER_FAILED
            msg = (runs[0].messages.get(ident) or runs[1].messages.get(ident)
                   or runs[0].messages.get(f"{u_key}::{PACKAGE_FAILED}")
                   or runs[1].messages.get(f"{u_key}::{PACKAGE_FAILED}", ""))
            detail[ident] = {"detail": f"head runs: {statuses}; {normalize_failure(msg, wt)[-600:]}"}
        elif not a and not b:
            verdicts[ident] = Verdict.NO_RECORDS
        elif len(stable) < min(MIN_STABLE_RECORDS, len(set(a) | set(b))) or not stable:
            verdicts[ident] = Verdict.NONDETERMINISTIC
            keys = set(a) | set(b)
            detail[ident] = {"detail": f"{len(keys) - len(stable)} of {len(keys)} records differ between two runs on the "
                                       f"PR head; only {len(stable)} stable (need {MIN_STABLE_RECORDS}); dropped",
                             "dropped": len(keys) - len(stable)}
        elif u_key in base_errors:
            verdicts[ident] = Verdict.BASE_UNCOMPILABLE
            detail[ident] = {"detail": base_errors[u_key]}
        elif ident in gone:
            verdicts[ident] = Verdict.BASE_UNCOMPILABLE
            detail[ident] = {"detail": "undefined on the merge-base: " + ", ".join(gone[ident])}
        else:
            status = base.results.get(ident, Verdict.MISSING)
            pkg_failed = base.results.get(f"{u_key}::{PACKAGE_FAILED}") == Verdict.FAIL
            msg = base.messages.get(ident) or base.messages.get(f"{u_key}::{PACKAGE_FAILED}", "")
            if status != Verdict.PASS or pkg_failed:
                missing = MISSING_ON_BASE.search(msg) or TARGET_MISSING.search(msg)
                verdicts[ident] = Verdict.BASE_UNCOMPILABLE if missing else Verdict.BASE_FAILED
                detail[ident] = {"detail": f"base run: {status}; {normalize_failure(msg, wt_base)[-600:]}"}
            elif not base_recs.get(rkey):
                verdicts[ident] = Verdict.BASE_FAILED
                detail[ident] = {"detail": "the recorder passed on the merge-base but wrote no records"}
            else:
                # Compare only what is stable on head, plus indices only the base wrote (the head never did).
                head_keys = set(a) | set(b)
                cmp_idx = stable | (set(base_recs[rkey]) - head_keys)
                dropped = len(head_keys) - len(stable)
                diffs = diff_records({i: a[i] for i in stable}, {i: r for i, r in base_recs[rkey].items() if i in cmp_idx})
                verdicts[ident] = Verdict.DIFF if diffs else Verdict.SAME
                if diffs:
                    detail[ident] = {"differing": len(diffs), "compared": len(cmp_idx),
                                     "examples": diffs[:DIFF_EXAMPLES]}
                    pending_diff.append((ident, u_key, rkey, a, stable, base_recs[rkey], cmp_idx))
                if dropped:
                    detail.setdefault(ident, {})["dropped"] = dropped
    if pending_diff:
        _confirm_diff_on_base(wt_base, state, tag, by_unit, targets, pending_diff, verdicts, detail, only=only)
    if write_outputs:
        write_json(hdir / f"diff_{tag}.json", verdicts)
        write_json(hdir / f"diff_{tag}.examples.json", detail)
        (hdir / f"diff_{tag}.response.sha256").write_text(fingerprint(files))
        _clear_adjudication(hdir, tag)
    return verdicts


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
    if status != Verdict.FAIL:
        return False
    if name.endswith(f"::{PACKAGE_FAILED}"):
        # A package-level failure kills only if the baseline run of that package was observed to exit cleanly.
        return base.packages.get(name.split("::", 1)[0]) == Verdict.PASS
    return base.results.get(name) == Verdict.PASS


def _covering_units(hdir: Path, tag: str) -> dict[str, set[str]]:
    """Map changed source file -> set of test unit keys (Go package dir or Jest file) that hit it in coverage."""
    cov_path = hdir / f"run_{tag}.coverage.json"
    if not cov_path.exists():
        return {}
    out: dict[str, set[str]] = {}
    for ident, t in load_json(cov_path).get("tests", {}).items():
        if t.get("verdict") != Verdict.REACHES:
            continue
        loc = ident.split("::", 1)[0]
        for f in t.get("hit", {}):
            out.setdefault(f, set()).add(loc)
    return out


def _ordered_mutant_units(suite: Suite, m_file: str, covering: dict[str, set[str]] | None) -> list[tuple[str, Suite]]:
    m_dir = str(Path(m_file).parent)
    cov_locs = (covering or {}).get(m_file, set())
    units = ([(d, Suite(go_patterns={d: pat})) for d, pat in suite.go_patterns.items()]
             + [(rel, Suite(jest_files=[rel], jest_prefix=suite.jest_prefix)) for rel in suite.jest_files])
    return sorted(units, key=lambda u: 0 if u[0] == m_dir else (1 if u[0] in cov_locs else 2))


def score_mutant(wt: Path, state: dict[str, Any], suite: Suite, base: Outcome,
                 m: dict[str, Any], vacuous: frozenset[str] = frozenset(),
                 covering: dict[str, set[str]] | None = None) -> dict[str, Any]:
    v: dict[str, Any] = {"id": m["id"], "held_back": m["held_back"], "file": m["file"],
                         "what_breaks": m["what_breaks"], "killers": [], "mutant": m}
    # A mutant that cannot be applied as written goes back to a planter (regen), like one that does not compile.
    if m["file"] not in state["changed"]:
        return {**v, "verdict": Verdict.NEEDS_REGENERATION, "detail": f"{m['file']} is not one of the hunted files {state['changed']}"}
    path = under(wt, m["file"])
    orig = path.read_text()
    if orig.count(m["old"]) != 1:
        return {**v, "verdict": Verdict.NEEDS_REGENERATION,
                "detail": f"`old` occurs {orig.count(m['old'])} times in {m['file']}; it must occur exactly once"}
    m_dir = str(Path(m["file"]).parent)
    try:
        path.write_text(orig.replace(m["old"], m["new"], 1))
        with tempfile.TemporaryDirectory() as bin_td:
            bins: dict[str, Path] = {}
            try:
                if m["file"].endswith(".go") and suite.go_patterns and compiles is _REAL_COMPILES:
                    for d in sorted(suite.go_patterns):
                        bins[d] = go_compile_binary(
                            wt, d, False, Path(bin_td) / f"{hashlib.sha256(d.encode()).hexdigest()[:8]}.test",
                        )
                    if m_dir not in suite.go_patterns:
                        err = compiles(wt, m["file"])
                        if err:
                            return {**v, "verdict": Verdict.NEEDS_REGENERATION, "detail": err}
                else:
                    err = compiles(wt, m["file"])
                    if err:
                        return {**v, "verdict": Verdict.NEEDS_REGENERATION, "detail": err}
                timeouts = mutant_timeouts(base)
                for u_key, u_suite in _ordered_mutant_units(suite, m["file"], covering):
                    ff = (all(base.results.get(n) == Verdict.PASS for n in base.results if n.startswith(f"{u_key}::"))
                          and not any(vac.startswith(f"{u_key}::") for vac in vacuous))
                    u_bins = {u_key: bins[u_key]} if u_key in bins else None
                    r = run_suite(wt, u_suite, race=False, go_timeouts=timeouts,
                                  go_bins=u_bins, failfast=ff).results
                    killers = sorted(n for n, s in r.items() if is_kill(n, s, base) and n not in vacuous)
                    if killers:
                        return {**v, "verdict": Verdict.KILLED, "killers": killers}
            except CompileError as e:
                return {**v, "verdict": Verdict.NEEDS_REGENERATION, "detail": str(e)[-1500:]}
            except InfraError as e:  # one mutant's environment failure (a compile-check timeout too) loses no other verdict
                return {**v, "verdict": Verdict.ERROR, "detail": str(e)[-1500:]}
        return {**v, "verdict": Verdict.SURVIVED, "killers": []}
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
                         "killers": [], "mutant": m, "verdict": Verdict.SURVIVED, "detail": "no tests to score"}
                        for m in all_mutants(hdir)]
        else:
            base = run_suite(wt, suite, race=False)
            # A test that executes none of the PR's changed lines does not count as a killer (run.py cover).
            vacuous = frozenset(vacuous_tests(hdir, tag))
            covering = _covering_units(hdir, tag)
            verdicts = [score_mutant(wt, state, suite, base, m, vacuous, covering) for m in all_mutants(hdir)]
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


def go_cover_binary(wt: Path, d: str, changed: dict[str, set[int]], td: Path) -> tuple[Path | None, list[str]]:
    """Compile one coverage-instrumented Go test binary per package so `cmd_cover` builds once, not once per test."""
    root = go_root(wt, d)
    go_files = [f for f in changed if f.endswith(".go") and not f.endswith("_test.go")
                and (wt / f).resolve().is_relative_to(root.resolve())]
    if not go_files:
        return None, []
    pkgs = sorted({"./" + _rel(wt, Path(f).parent, root) for f in go_files})
    bin_path = td / f"cover-{hashlib.sha256(d.encode()).hexdigest()[:8]}.test"
    p = sh(["go", "test", "-c", "-vet=off", "-cover", "-coverpkg=" + ",".join(pkgs), "-o", str(bin_path),
            "./" + _rel(wt, d, root)], root, check=False, timeout=1800)
    return (bin_path if p.returncode == 0 and bin_path.exists() else None), go_files


def go_test_coverage(wt: Path, d: str, name: str, changed: dict[str, set[int]],
                     prebuilt: tuple[Path | None, list[str]] | None = None) -> dict[str, tuple[set[int], set[int]]] | None:
    """Run one Go test alone with coverage of the changed packages in its module; None if no profile was written."""
    if prebuilt is None:
        with tempfile.TemporaryDirectory() as bin_td:
            return go_test_coverage(wt, d, name, changed, prebuilt=go_cover_binary(wt, d, changed, Path(bin_td)))
    root = go_root(wt, d)
    bin_path, go_files = prebuilt
    if not go_files:
        return {}
    if bin_path is None:
        return None
    with tempfile.TemporaryDirectory() as td:
        prof = Path(td) / "cover.out"
        with maybe_pg_pool_lock(d):
            sh([str(bin_path), f"-test.run=^{name}$", f"-test.coverprofile={prof}"], wt / d, check=False, timeout=1800)
        if not prof.exists():
            return None
        text = prof.read_text()
    return {f: go_profile_lines(text, _rel(wt, f, root)) for f in go_files}


def jest_test_coverage(wt: Path, rel: str, full_name: str,
                       changed: dict[str, set[int]]) -> dict[str, tuple[set[int], set[int]]] | None:
    root = jest_root(wt, rel)
    pkg = jest_pkg_dir(wt, rel, root)
    js_files = [f for f in changed if re.search(r"\.[jt]sx?$", f)
                and any((wt / f).resolve().is_relative_to(d.resolve()) for d in (root, pkg) if d is not None)]
    if not js_files:
        return {}
    with tempfile.TemporaryDirectory() as td:
        args = ["npx", "jest", *jest_roots_args(wt, rel, root), "--runTestsByPath", _rel(wt, rel, root),
                "--watchAll=false", "--ci=false",
                "-t", f"^{js_regex_escape(full_name)}$", "--coverage", "--coverageReporters=json",
                f"--coverageDirectory={td}"]
        for f in js_files:
            args.append(f"--collectCoverageFrom={_rel(wt, f, root)}")
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
            tests[name] = {"verdict": Verdict.UNKNOWN, "hit": {}}  # no profile (a crash): never dropped on missing data
            continue
        hit = {f: sorted(h & executable[f]) for f, (_, h) in cov.items() if h & executable[f]}
        for f, lines in hit.items():
            reached[f] |= set(lines)
        tests[name] = {"verdict": Verdict.REACHES if hit else Verdict.VACUOUS, "hit": hit}
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
        with tempfile.TemporaryDirectory() as bin_td:
            go_bins: dict[str, tuple[Path | None, list[str]]] = {}
            for ident in sorted(table):
                loc, name = ident.split("::", 1)
                if name == PACKAGE_FAILED:
                    continue
                if loc.endswith((".ts", ".tsx", ".js", ".jsx")):
                    per_test[ident] = jest_test_coverage(wt, loc, name, changed)
                else:
                    if loc not in go_bins:
                        go_bins[loc] = go_cover_binary(wt, loc, changed, Path(bin_td))
                    per_test[ident] = go_test_coverage(wt, loc, name, changed, prebuilt=go_bins[loc])
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
    return {n for n, t in load_json(p)["tests"].items() if t["verdict"] == Verdict.VACUOUS and t.get("head") != Verdict.FAIL_3_OF_3}


# ---------------------------------------------------------------- Go fuzzing (discovery only; HUNT_FUZZ=0 turns it off)

MAX_FUZZ_TARGETS = 5
FUZZ_TARGET = re.compile(r"^func (FuzzHunt([A-Z])_(\w+))\(\w+ \*testing\.F\)", re.M)
STATEFUL = re.compile(r"\bSetup(?:WithStoreMock|Config|WithServerOptions)?\(|\bmainHelper\b|\bsql\.Open\(|\bhttp\.(?:Get|Post)\(")
# A corpus value we can paste back as a Go expression: int(5), string("a\x00"), []byte("x"), bool(true), rune('a').
CORPUS_VALUE = re.compile(r"^(?:\[\]byte|string|bool|byte|rune|u?int(?:8|16|32|64)?|float(?:32|64))\(.*\)$")


def fuzz_enabled() -> bool:
    return os.environ.get("HUNT_FUZZ") != "0"


def fuzz_time() -> str:
    return os.environ.get("HUNT_FUZZ_TIME", "60s")


def func_body(src: str, name: str) -> str | None:
    return go_bodies(src).get(name)


def corpus_args(entry: str) -> list[str] | None:
    """Go expressions for one `go test fuzz v1` corpus file; None for a value that is not a plain literal (NaN, Inf)."""
    rows = entry.strip().split("\n")
    if not rows or rows[0].strip() != "go test fuzz v1":
        return None
    args = [r.strip() for r in rows[1:] if r.strip()]
    if any(not CORPUS_VALUE.match(a) or re.search(r"Inf|NaN|frombits", a) for a in args):
        return None
    return args


def freeze(name: str, mode: str, base: str, args: list[str]) -> tuple[str, str]:
    """(test name, Go source) of a deterministic test that replays one fuzz input through the target's helper."""
    test = f"TestHunt{mode}_{base}_Fuzz{hashlib.sha256(chr(10).join(args).encode()).hexdigest()[:8]}"
    return test, (f"\n// Frozen by run.py fuzz from a minimized failing input of {name}.\n"
                  f"func {test}(t *testing.T) {{\n\thuntCheck{mode}_{base}(t, {', '.join(args)})\n}}\n")


def cmd_fuzz(hdir: Path, state: dict[str, Any], tag: str) -> dict[str, Any]:
    """Fuzz each pure FuzzHuntA_<Name> target briefly. A failure is not a finding: its minimized input is frozen into a
    deterministic TestHuntA_<Name>_Fuzz<hash> that calls huntCheckA_<Name>, appended to <tag>/response.json, and
    must then go through `run.py run` (3/3), `cover` and `base` like any hunter test."""
    if not fuzz_enabled():
        raise InfraError("fuzzing is off: HUNT_FUZZ=0 is set")
    if tag != "A":
        raise InfraError(f"fuzz is for Mode A only, not {tag}")
    wt = Path(state["wt"])
    ensure_clean(wt)
    require_disk(scratch())
    resp_path = hdir / tag / "response.json"
    resp = load_json(resp_path)
    report: dict[str, Any] = {"targets": {}, "frozen": []}
    candidates: list[tuple[int, str, str, str]] = []  # (file index, target, mode, base name)
    for i, f in enumerate(resp["files"]):
        if not str(f.get("path", "")).endswith(".go"):
            continue
        src = str(f.get("content", ""))
        for m in FUZZ_TARGET.finditer(src):
            name, mode, base = m.group(1), m.group(2), m.group(3)
            check = func_body(src, f"huntCheck{mode}_{base}")
            body = (func_body(src, name) or "") + "\n" + (check or "")
            if mode != tag[0]:
                report["targets"][name] = "SKIPPED wrong mode"
            elif check is None:
                report["targets"][name] = f"SKIPPED no huntCheck{mode}_{base}(t, ...) helper to freeze into"
            elif f"func TestHunt{mode}_{base}_Fuzz" in "".join(str(g.get("content", "")) for g in resp["files"]):
                report["targets"][name] = "SKIPPED already frozen by an earlier run"  # a rerun must not re-add or re-wait
            elif STATEFUL.search(body):
                report["targets"][name] = "SKIPPED stateful (Setup, store, network): only pure functions are fuzzed"
            elif len(candidates) >= MAX_FUZZ_TARGETS:
                report["targets"][name] = f"SKIPPED over the {MAX_FUZZ_TARGETS}-target limit"
            else:
                candidates.append((i, name, mode, base))
    additions: dict[int, list[str]] = {}
    placed: list[Path] = []
    try:
        placed = place(wt, resp["files"], {t["dir"] for t in state["targets"]})
        shared_created: list[Path] = []
        if candidates:
            fuzz_par = max(1, (os.cpu_count() or 2) // len(candidates))
            pkg_dirs = sorted({str(Path(resp["files"][i]["path"]).parent) for i, _, _, _ in candidates})
            for d in pkg_dirs:
                for p in (wt / d / "testdata", wt / d / "testdata" / "fuzz"):
                    if not p.exists():
                        shared_created.append(p)

            def _fuzz_one(cand: tuple[int, str, str, str]) -> tuple[int, str, str, str | None, str | None]:
                i, name, mode, base = cand
                d = str(Path(resp["files"][i]["path"]).parent)
                root = go_root(wt, d)
                corpus = wt / d / "testdata" / "fuzz" / name
                corpus_existed = corpus.exists()
                try:
                    with maybe_pg_pool_lock(d):
                        p = sh(["go", "test", "-count=1", "-vet=off", "-run", "^$", "-fuzz", f"^{name}$",
                                f"-fuzztime={fuzz_time()}", f"-parallel={fuzz_par}",
                                "./" + _rel(wt, d, root)], root, check=False, timeout=1800)
                    entries = sorted(corpus.glob("*")) if corpus.is_dir() else []
                    if p.returncode == 0:
                        return i, name, Verdict.PASS, None, None
                    if not entries:
                        out = p.stdout + p.stderr
                        if "[build failed]" in out or "[setup failed]" in out:
                            raise CompileError(f"{name}:\n{out[-2500:]}")
                        return i, name, "ERROR " + normalize_failure(out[-1500:], wt), None, None
                    args = corpus_args(entries[0].read_text())
                    if args is None:
                        return i, name, "FAIL (input not freezable: " + entries[0].read_text()[:200] + ")", None, None
                    test, code = freeze(name, mode, base, args)
                    return i, name, f"FAIL frozen as {test}", test, code
                finally:
                    if not corpus_existed and corpus.exists():
                        shutil.rmtree(corpus)

            try:
                max_w = min(len(candidates), max(1, (os.cpu_count() or 2) // 2))
                with ThreadPoolExecutor(max_workers=max_w) as pool:
                    for i, name, status, test, code in pool.map(_fuzz_one, candidates):
                        report["targets"][name] = status
                        if test and code:
                            report["frozen"].append(test)
                            additions.setdefault(i, []).append(code)
            finally:
                for p in reversed(shared_created):
                    if p.exists():
                        shutil.rmtree(p)
    finally:
        unplace(placed)
    if additions:
        (hdir / tag / "response.prefuzz.json").write_text(resp_path.read_text())
        for i, frozen in additions.items():
            resp["files"][i]["content"] = resp["files"][i]["content"] + "".join(frozen)
        write_json(resp_path, resp)
    write_json(hdir / f"fuzz_{tag}.json", report)
    return report


def _diff_dir_for(hdir: Path, tag: str, only: str) -> Path:
    only_unit = only.split("::", 1)[0]
    candidates = [hdir]
    broot = hdir / "batches"
    if broot.is_dir():
        candidates.extend(sorted(p for p in broot.iterdir() if p.is_dir() and p.name.startswith("batch_")))
    for bdir in candidates:
        resp = bdir / tag / "response.json"
        if resp.is_file():
            files = load_json(resp).get("files") or []
            if only_unit in group_by_unit(files):
                return bdir
    return hdir


def cmd_repro(hdir: Path, state: dict[str, Any], tag: str, only: str) -> int:
    """Restore generated test files for `only`'s unit, run the selected test on PR head, and clean up the worktree."""
    wt = Path(state["wt"])
    ensure_clean(wt)
    files = load_json(hdir / tag / "response.json")["files"]
    targets = {t["dir"] for t in state["targets"]}
    only_unit, _, only_name = only.partition("::")
    by_unit = {k: v for k, v in group_by_unit(files).items() if k == only_unit}
    if not by_unit:
        raise InfraError(f"no {tag} test unit found for {only!r} in {hdir / tag / 'response.json'}")
    placed_units = _place_units(wt, by_unit, targets)
    placed = [p for _, ps in placed_units for p in ps]
    try:
        suite = _filter_base_suite(suite_for(tag, state, placed, wt), {only}, {})
        o = run_suite(wt, suite, race=True)
    finally:
        unplace(placed)
    only_top = f"{only_unit}::{only_name.split('/', 1)[0]}" if only_name else only
    status = o.results.get(only, o.results.get(only_top, Verdict.MISSING))
    print(f"[{tag} repro] {only}: {status}")
    msg = o.messages.get(only) or o.messages.get(only_top, "")
    if msg:
        print(msg)
    return 0 if status == Verdict.PASS else 1


def main(argv: list[str]) -> int:
    only: str | None = None
    args = list(argv[1:])
    if "--only" in args:
        idx = args.index("--only")
        if idx + 1 >= len(args):
            print(__doc__)
            return 1
        only = args[idx + 1]
        del args[idx:idx + 2]
    if (len(args) != 3 or args[0] not in ("run", "base", "mutants", "cover", "fuzz", "diff", "repro")
            or (only and args[0] not in ("diff", "repro"))
            or (args[0] == "repro" and not only)):
        print(__doc__)
        return 1
    cmd, pr, tag = args[0], args[1], args[2]
    hdir = hunt_dir(pr)

    def _run_cmd() -> int:
        try:
            state = read_state(hdir)  # inside the lock: ctx.py may be rewriting it
            if cmd == "run":
                table = cmd_run(hdir, state, tag)
                for n, c in table.items():
                    print(f"[{tag}] {n}: {c}")
                if not table:
                    resp_files = load_json(hdir / tag / "response.json").get("files") or []
                    if tag == "A" and state.get("changed") and not resp_files:
                        print(f"[{tag}] EMPTY_RESPONSE: Mode A emitted 0 test files despite {len(state['changed'])} "
                              f"changed source file(s); run `build_requests.py {pr} retry A` once before accepting empty output")
                    elif resp_files and (hdir / f"fuzz_{tag}.json").exists():
                        targets = load_json(hdir / f"fuzz_{tag}.json").get("targets", {})
                        skipped = sum(1 for v in targets.values() if str(v).startswith("SKIPPED"))
                        errored = sum(1 for v in targets.values() if str(v).startswith(Verdict.ERROR))
                        ran = len(targets) - skipped - errored
                        if errored:
                            print(f"[{tag}] {errored} fuzz target(s) failed with ERROR"
                                  + (f" ({ran} ran, {skipped} skipped)" if (ran or skipped) else "")
                                  + f"; see fuzz_{tag}.json")
                        elif ran == 0 and skipped:
                            print(f"[{tag}] {skipped} fuzz target(s) skipped (0 executed); see fuzz_{tag}.json")
                        else:
                            print(f"[{tag}] {ran} fuzz target(s) ran with 0 frozen failures"
                                  + (f" ({skipped} skipped)" if skipped else ""))
                    elif resp_files:
                        print(f"[{tag}] {len(resp_files)} fuzz file(s) ran with 0 frozen failures")
                    else:
                        print(f"[{tag}] no tests in the hunter response")
            elif cmd == "base":
                for n, c in cmd_base(hdir, state, tag).items():
                    shown = c[:300] if n == "detail" else c
                    print(f"[{tag} @merge-base] {n}: {shown}")
            elif cmd == "cover":
                cov = cmd_cover(hdir, state, tag)
                for n, t in cov["tests"].items():
                    print(f"[{tag} cover] {n}: {t['verdict']} {sum(len(v) for v in t['hit'].values())} changed lines")
                print(f"[{tag} cover] changed lines reached: {cov['reached']}/{cov['executable']}")
            elif cmd == "repro":
                assert only is not None
                bdir = _diff_dir_for(hdir, tag, only)
                bstate = read_state(bdir) if bdir != hdir else state
                return cmd_repro(bdir, bstate, tag, only)
            elif cmd == "diff":
                if only is not None:
                    bdir = _diff_dir_for(hdir, tag, only)
                    bstate = read_state(bdir) if bdir != hdir else state
                    info: dict[str, Any] = {}
                    verdicts = cmd_diff(bdir, bstate, tag, only=only, write_outputs=False, detail_out=info)
                else:
                    verdicts = cmd_diff(hdir, state, tag)
                    info = load_json(hdir / f"diff_{tag}.examples.json")
                for n, verdict in verdicts.items():
                    d = info.get(n, {})
                    count = f" ({d['differing']} of {d['compared']} inputs differ)" if verdict == Verdict.DIFF else ""
                    count += f" [{d['dropped']} unstable record(s) dropped]" if d.get("dropped") else ""
                    print(f"[{tag} diff] {n}: {verdict}{count}" + (f" {d['detail'][:300]}" if "detail" in d else ""))
                    for ex in d.get("examples", []):
                        print(f"    input: {json.dumps(ex['input'], sort_keys=True)[:300]}")
                        print(f"    base:  {json.dumps(ex['base'], sort_keys=True)[:300]}")
                        print(f"    head:  {json.dumps(ex['head'], sort_keys=True)[:300]}")
                if not verdicts:
                    print(f"[{tag} diff] no recorders in the hunter response")
            elif cmd == "fuzz":
                rep = cmd_fuzz(hdir, state, tag)
                for n, v in rep["targets"].items():
                    print(f"[{tag} fuzz] {n}: {v}")
                if rep["frozen"]:
                    print(f"[{tag} fuzz] {len(rep['frozen'])} frozen test(s) added to {tag}/response.json: "
                          f"run `run.py run <pr> {tag}` and `run.py cover <pr> {tag}` again")
            else:
                for v in cmd_mutants(hdir, state, tag):
                    extra = v["killers"] or v.get("detail", "")[:160]
                    print(f"{v['id']}{' (held back)' if v['held_back'] else ''}: {v['verdict']} {extra}")
        except CompileError as e:
            (hdir / f"compile_{tag}.log").write_text(str(e))  # input for `build_requests.py <pr> repair <tag>`
            print(f"COMPILE_ERROR {e}")
            return 3
        return 0

    return run_locked_cli(
        pr, hdir, _run_cmd,
        scope="wt_base" if cmd == "base" else ("all" if cmd in ("diff", "mutants") else "wt"),
        tag=tag,
    )


_REAL_RUN_SUITE = run_suite
_REAL_DIFF_UNIT_PASS = _diff_unit_pass
_REAL_COMPILES = compiles
_REAL_SH = sh
_REAL_GO_COMPILE_BINARY = go_compile_binary


if __name__ == "__main__":
    sys.exit(main(sys.argv))
