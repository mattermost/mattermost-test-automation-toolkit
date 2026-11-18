#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Steps 4-5: run hunter tests, vet on the merge-base, score mutants. Go and Jest adapters.

usage: run.py run <pr> <A|B|A2>        3 runs on unmodified PR head (Go with -race); writes run_<tag>.json
       run.py base <pr> <A|B|A2>       same tests once on the merge-base worktree; writes base_<tag>.json
       run.py mutants <pr> <A|A2|PR>   compile-check then score every mutant (M, then held-back M2); writes mutants_<tag>.json
Exit codes: 0 ok, 2 INFRA_ERROR (0 tests executed, dead DB, missing tool), 3 COMPILE_ERROR in hunter tests (repair round).
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hunt_common import InfraError, hunt_dir, load_json, node_env, read_state, sh, under, write_json

HUNT_FILE = re.compile(r"^(hunt_hunt[a-z0-9]+_test\.go|hunt_[a-z0-9]+\.test\.tsx?)$")
RESULT_GO = re.compile(r"^\s*--- (PASS|FAIL|SKIP): (\S+)", re.M)


class CompileError(RuntimeError):
    pass


@dataclass
class Suite:
    """What to run in one worktree: Go packages with a -run pattern, and/or Jest test files with a title prefix."""
    go_patterns: dict[str, str] = field(default_factory=dict)  # package dir -> -run pattern
    jest_files: list[str] = field(default_factory=list)
    jest_prefix: str = ""


# ---------------------------------------------------------------- placing model-written test files

def place(wt: Path, files: list[dict[str, str]], target_dirs: set[str]) -> list[Path]:
    """Write hunter files into wt, all or nothing. Model output picks the paths, so every path is validated before
    anything is written (only hunt_* test files inside a target dir pass), and a failed write removes what was written."""
    targets = []
    for f in files:
        rel = f["path"]
        if not HUNT_FILE.match(Path(rel).name) or str(Path(rel).parent) not in target_dirs:
            raise ValueError(f"refusing to write {rel!r}: not a hunt_* test file in a target dir")
        p = under(wt, rel)
        if not p.parent.is_dir():
            raise CompileError(f"{p.parent} does not exist in this worktree")
        targets.append((p, f["content"]))
    placed: list[Path] = []
    try:
        for p, content in targets:
            placed.append(p)  # before writing: a write that fails halfway must be rolled back too
            p.write_text(content)
    except OSError:
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


def go_run(wt: Path, patterns: dict[str, str], race: bool) -> tuple[dict[str, str], str]:
    res: dict[str, str] = {}
    outs = []
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
            raise InfraError(f"0 tests executed in {pkg} (exit {p.returncode}):\n{out[-2500:]}")
        if p.returncode != 0 and "FAIL" not in got.values():
            # e.g. TestMain teardown, a race report or a panic after the last test: the package failed even though no
            # test line says so. Record it instead of reporting PASS.
            got[f"{d}::(package failed)"] = "FAIL"
        res.update(got)
        outs.append(out)
    return res, "\n".join(outs)


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


def jest_run(wt: Path, files: list[str], prefix: str) -> tuple[dict[str, str], str]:
    res: dict[str, str] = {}
    msgs: list[str] = []
    for rel in files:
        root = jest_root(wt, rel)
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            p = sh(["npx", "jest", os.path.relpath(wt / rel, root), "--watchAll=false", "--json", f"--outputFile={out}"],
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
                if not prefix or a["title"].startswith(prefix):
                    # file + full name: equal titles in two describe blocks or files never overwrite each other
                    key = f"{rel}::{a.get('fullName') or a['title']}"
                    res[key] = {"passed": "PASS", "failed": "FAIL"}.get(a["status"], "SKIP")
                    msgs += a.get("failureMessages") or []
    if files and not res:
        raise InfraError(f"0 tests matching {prefix!r} executed in {files}")
    return res, "\n".join(msgs)


def jest_compiles(wt: Path, file: str) -> str | None:
    root = jest_root(wt, file)
    p = sh(["node", "-e", "require('@babel/core').transformFileSync(process.argv[1])", str(wt / file)], root,
           check=False, timeout=120, env=node_env())
    return None if p.returncode == 0 else (p.stdout + p.stderr)[-1500:]


# ---------------------------------------------------------------- suite level

def run_suite(wt: Path, s: Suite, race: bool) -> tuple[dict[str, str], str]:
    res: dict[str, str] = {}
    out = ""
    if s.go_patterns:
        r, o = go_run(wt, s.go_patterns, race)
        res.update(r)
        out += o
    if s.jest_files:
        r, o = jest_run(wt, s.jest_files, s.jest_prefix)
        res.update(r)
        out += o
    if not res:
        raise InfraError("suite is empty: no Go packages or Jest files to run")
    return res, out


def compiles(wt: Path, file: str) -> str | None:
    return go_compiles(wt, file) if file.endswith(".go") else jest_compiles(wt, file)


def classify(statuses: list[str]) -> str:
    if all(x == "PASS" for x in statuses):
        return "PASS"
    if all(x == "FAIL" for x in statuses):
        return "FAIL_3_OF_3"
    return "FLAKY"


def cmd_run(hdir: Path, state: dict[str, Any], tag: str, runs: int = 3) -> dict[str, Any]:
    wt = Path(state["wt"])
    files = load_json(hdir / tag / "response.json")["files"]
    placed = place(wt, files, {t["dir"] for t in state["targets"]})
    try:
        results = []
        log = []
        for _ in range(runs):
            r, out = run_suite(wt, suite_for(tag, state, placed, wt), race=True)
            results.append(r)
            log.append(out)
    finally:
        unplace(placed)
    names = sorted(set().union(*results))
    table = {n: classify([r.get(n, "MISSING") for r in results]) for n in names}
    write_json(hdir / f"run_{tag}.json", table)
    (hdir / f"run_{tag}.log").write_text("\n\n=== run ===\n".join(log))
    return table


def cmd_base(hdir: Path, state: dict[str, Any], tag: str) -> dict[str, str]:
    """PASS on base -> the failure is new in the PR. FAIL on base -> pre-existing. BASE_UNCOMPILABLE -> decide from diff."""
    wt = Path(state["wt_base"])
    files = load_json(hdir / tag / "response.json")["files"]
    out: dict[str, str] = {}
    placed: list[Path] = []
    try:
        placed = place(wt, files, {t["dir"] for t in state["targets"]})
        r, _ = run_suite(wt, suite_for(tag, state, placed, wt), race=True)
        out = {n: {"PASS": "NEW_PR_BUG", "FAIL": "PRE_EXISTING"}.get(s, s) for n, s in r.items()}
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


def cmd_mutants(hdir: Path, state: dict[str, Any], tag: str) -> list[dict[str, Any]]:
    wt = Path(state["wt"])
    placed = [] if tag == "PR" else place(wt, load_json(hdir / tag / "response.json")["files"],
                                          {t["dir"] for t in state["targets"]})
    verdicts = []
    try:
        suite = suite_for(tag, state, placed, wt)
        base, _ = run_suite(wt, suite, race=False)
        for m in all_mutants(hdir):
            v: dict[str, Any] = {"id": m["id"], "held_back": m["held_back"], "file": m["file"],
                                 "what_breaks": m["what_breaks"], "killers": [], "mutant": m}
            if m["file"] not in state["changed"]:
                verdicts.append({**v, "verdict": "INVALID", "detail": "file is not a hunted production file"})
                continue
            path = under(wt, m["file"])
            orig = path.read_text()
            if orig.count(m["old"]) != 1:
                verdicts.append({**v, "verdict": "INVALID", "detail": f"`old` occurs {orig.count(m['old'])} times"})
                continue
            try:
                path.write_text(orig.replace(m["old"], m["new"], 1))
                err = compiles(wt, m["file"])
                if err:
                    verdicts.append({**v, "verdict": "NEEDS_REGENERATION", "detail": err})
                    continue
                try:
                    r, _ = run_suite(wt, suite, race=False)
                except CompileError as e:
                    verdicts.append({**v, "verdict": "NEEDS_REGENERATION", "detail": str(e)[-1500:]})
                    continue
                # A "(package failed)" key exists only when a package failed; its absence in the baseline means the
                # package passed there, so a mutant that newly breaks teardown still counts as a kill.
                killers = sorted(n for n, s in r.items() if s == "FAIL" and base.get(
                    n, "PASS" if n.endswith("::(package failed)") else None) == "PASS")
                verdicts.append({**v, "verdict": "KILLED" if killers else "SURVIVED", "killers": killers})
            finally:
                path.write_text(orig)
    finally:
        unplace(placed)
    write_json(hdir / f"mutants_{tag}.json", verdicts)
    return verdicts


def main(argv: list[str]) -> int:
    cmd, pr, tag = argv[1], argv[2], argv[3]
    hdir = hunt_dir(pr)
    state = read_state(hdir)
    try:
        if cmd == "run":
            for n, c in cmd_run(hdir, state, tag).items():
                print(f"[{tag}] {n}: {c}")
        elif cmd == "base":
            for n, c in cmd_base(hdir, state, tag).items():
                print(f"[{tag} @merge-base] {n}: {c if n != 'detail' else c[:300]}")
        elif cmd == "mutants":
            for v in cmd_mutants(hdir, state, tag):
                extra = v["killers"] or v.get("detail", "")[:160]
                print(f"{v['id']}{' (held back)' if v['held_back'] else ''}: {v['verdict']} {extra}")
        else:
            print(__doc__)
            return 1
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    except CompileError as e:
        print(f"COMPILE_ERROR {e}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
