#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 2: mechanical blind context for one batch of a PR.

usage: ctx.py <pr> [--batch N]
Reads prepare.json, fetches PR title/body over the GitHub REST API, runs the large-diff prefilter, and writes
ctx.json (what hunters see), state.json (what the runner needs) and skipped.log (every file not hunted, with reason).
Nothing here is summarised or chosen by a model.
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

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import prefilter
from hunt_common import REPO, InfraError, git, hunt_dir, hunt_lock, sh, write_json

MAX_SOURCE_LINES = 1500     # bigger changed files are shown as windows around the hunks
MAX_SIBLING_LINES = 3000    # total sibling test lines per batch
MAX_CALLERS = 40
CALLER_PAD = 6


def numbered(lines: list[str], a: int, b: int) -> str:
    return "\n".join(f"{i:5d}  {lines[i - 1]}" for i in range(a, b + 1))


def hunk_ranges(patch: str) -> list[tuple[int, int]]:
    return [(int(m.group(1)), int(m.group(2) or 1)) for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", patch, re.M)]


def source_view(wt: Path, path: str, patch: str) -> str:
    lines = (wt / path).read_text(errors="replace").split("\n")
    if len(lines) <= MAX_SOURCE_LINES:
        return numbered(lines, 1, len(lines))
    parts = []
    for start, n in hunk_ranges(patch):
        a, b = max(1, start - 40), min(len(lines), start + n + 40)
        parts.append(numbered(lines, a, b))
    return "\n   ...\n".join(parts)


def changed_symbols(patch: str, lang: str) -> set[str]:
    """Names of functions/types/exports the PR adds or touches, read from + lines and hunk headers."""
    names: set[str] = set()
    text = "\n".join(line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
    headers = "\n".join(re.findall(r"^@@.*@@(.*)$", patch, re.M))
    if lang == "go":
        rx = r"func (?:\([^)]*\) )?([A-Za-z_]\w*)\s*[\[(]|^type ([A-Z]\w*)[\s\[]"
    else:
        rx = r"(?:export (?:default )?(?:function|const|class)|function|const) ([A-Za-z_]\w*)"
    for src in (text, headers):
        for m in re.finditer(rx, src, re.M):
            names.add(next(g for g in m.groups() if g))
    return {n for n in names if len(n) > 3 and n not in {"init", "main", "Error", "String"}}


def lang_of(path: str) -> str:
    return "go" if path.endswith(".go") else "jest"


def sibling_rank(p: Path, stem: str, symbols: set[str]) -> int:
    """0 helpers (main/helper/setup), 1 same-name test, 2 mentions a changed symbol, 9 unrelated."""
    n = p.name
    if re.match(r"(main|helper|setup|utils?)[._]", n):
        return 0
    if n.startswith((stem + "_test", stem + ".test")):
        return 1
    body = p.read_text(errors="replace")
    return 2 if any(s in body for s in symbols) else 9


def sibling_tests(wt: Path, files: list[str], symbols: set[str]) -> list[dict[str, str]]:
    """Sibling tests in rank order until the line budget is spent; unrelated tests are never included."""
    out, budget, seen = [], MAX_SIBLING_LINES, set()
    for f in files:
        d = (wt / f).parent
        stem = Path(f).name.split(".")[0]
        cands = sorted(d.glob("*_test.go")) + sorted(d.glob("*.test.ts*"))
        ranked = sorted((sibling_rank(p, stem, symbols), p.name, p) for p in cands)
        for rank, _, p in ranked:
            if p in seen or rank == 9 or p.name.startswith("hunt_"):
                continue
            lines = p.read_text(errors="replace").split("\n")
            if len(lines) > budget:
                continue
            seen.add(p)
            budget -= len(lines)
            out.append({"file": str(p.relative_to(wt)), "source": numbered(lines, 1, len(lines))})
    return out


def callers(wt: Path, files: list[str], symbols: set[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen: set[tuple[str, int]] = set()
    roots = sorted({f.split("/")[0] for f in files})
    for sym in sorted(symbols):
        for root in roots:
            p = sh(["grep", "-rnw", "--include=*.go", "--include=*.ts", "--include=*.tsx", "--include=*.js",
                    "--exclude-dir=node_modules", "--exclude-dir=vendor", sym, root], wt, check=False)
            for hit in p.stdout.splitlines():
                f, n_s, _ = hit.split(":", 2)
                if (f in files or f.endswith(("_test.go", ".test.ts", ".test.tsx", ".test.js"))
                        or "/mocks/" in f or not n_s.isdigit()):
                    continue
                n = int(n_s)
                if (f, n // 10) in seen:
                    continue
                seen.add((f, n // 10))
                lines = (wt / f).read_text(errors="replace").split("\n")
                a, b = max(1, n - CALLER_PAD), min(len(lines), n + CALLER_PAD)
                out.append({"file": f, "symbol": sym, "lines": f"{a}-{b}", "source": numbered(lines, a, b)})
                if len(out) >= MAX_CALLERS:
                    return out
    return out


def test_targets(wt: Path, files: list[str]) -> list[dict[str, str]]:
    """Where hunters must write their tests: one file per Go package dir / webapp component dir."""
    out, seen = [], set()
    for f in files:
        d = str(Path(f).parent)
        if d in seen:
            continue
        seen.add(d)
        if f.endswith(".go"):
            m = re.search(r"^package (\w+)", (wt / f).read_text(), re.M)
            out.append({"lang": "go", "dir": d, "path": f"{d}/hunt_hunt<mode>_test.go", "package": m.group(1) if m else "?"})
        else:
            out.append({"lang": "jest", "dir": d, "path": f"{d}/hunt_<mode>.test.tsx"})
    return out


def go_code(line: str) -> str:
    """One Go line without its trailing // comment (string, raw-string and rune literals respected), right-stripped."""
    quote = ""
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\" and quote != "`":
                i += 1
            elif c == quote:
                quote = ""
        elif c in "\"`'":
            quote = c
        elif line.startswith("//", i):
            return line[:i].rstrip()
        i += 1
    return line.rstrip()


def changed_go_tests(patch: str, head_src: str) -> list[str]:
    """Top-level Test functions that contain an added or removed line (new tests and edited bodies alike)."""
    lines = head_src.split("\n")
    decls = []  # (first line, last line, name); gofmt puts a top-level closing brace in column 0
    for i, line in enumerate(lines, 1):
        if line.startswith("func "):
            # A trailing comment (`} // TestA`) does not hide the brace; `//` inside a literal is not a comment.
            if go_code(line).endswith("}"):  # one-line body: func TestA(t *testing.T) {}
                end = i
            else:
                end = next((j for j in range(i + 1, len(lines) + 1) if go_code(lines[j - 1]) == "}"), len(lines))
            # Only what `go test -run` executes: top-level func TestX(t *testing.T), with the parameter name optional
            # and any package qualifier (aliased or dot-imported testing). Not TestMain, benchmarks, helpers, or
            # methods whose names happen to start with Test.
            m = re.match(r"func (Test(?:[A-Z_0-9]\w*)?)\((?:\w+ )?\*(?:\w+\.)?T\)", line)
            decls.append((i, end, m.group(1) if m else ""))
    touched: set[int] = set()
    ln = 0
    for line in patch.splitlines():
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            ln = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            touched.add(ln)
            ln += 1
        elif line.startswith("-") and not line.startswith("---"):
            touched.add(ln)  # a removed line sits just before head line `ln`
        elif not line.startswith("\\"):
            ln += 1
    names = set()
    for t in touched:
        names |= {name for start, end, name in decls if name and start <= t <= end}
    return sorted(names)


def own_tests(repo: Path, mb: str, head: str, dirs: set[str]) -> dict[str, Any]:
    """Tests the PR itself adds or changes in the hunted dirs: Go test names, Jest file paths."""
    names: list[str] = []
    by_dir: dict[str, set[str]] = {}
    jest: list[str] = []
    for f in git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", mb, head).splitlines():
        if str(Path(f).parent) not in dirs:
            continue
        if f.endswith("_test.go"):
            patch = git(repo, "diff", mb, head, "--", f)
            found = changed_go_tests(patch, git(repo, "show", f"{head}:{f}"))
            names += found
            if found:
                by_dir.setdefault(str(Path(f).parent), set()).update(found)
        elif re.search(r"\.test\.[jt]sx?$", f):
            jest.append(f)
    return {"go": sorted(set(names)), "go_by_dir": {d: sorted(v) for d, v in sorted(by_dir.items())},
            "jest": sorted(jest)}


def file_diffs(repo: Path, mb: str, head: str) -> list[prefilter.FileDiff]:
    """Added and modified files only. Renames count as delete + add, so every path exists at head."""
    out = []
    for row in git(repo, "diff", "--numstat", "--no-renames", "--diff-filter=AM", mb, head).splitlines():
        a, r, path = row.split("\t", 2)
        if a == "-":  # binary
            out.append(prefilter.FileDiff(path, 0, 0))
            continue
        out.append(prefilter.FileDiff(path, int(a), int(r)))
    return out


# Outputs of an earlier hunt or batch. Left in place they would be reused (an old regenerated mutant, an old compile
# log, old verdicts), so a new context removes them; prepare.json stays.
STALE = ("A", "B", "A2", "M", "M2", "R_*", "run_*", "base_*", "mutants_*", "compile_*", "ctx.json", "state.json",
         "skipped.log")


def reset_hunt_dir(hdir: Path) -> None:
    hdir.mkdir(parents=True, exist_ok=True)
    for pattern in STALE:
        for p in hdir.glob(pattern):
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink(missing_ok=True)


def build(pr: str, batch: int, prep: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    repo, wt, mb, head = Path(prep["repo"]), Path(prep["wt"]), prep["merge_base"], prep["head"]
    diffs = file_diffs(repo, mb, head)
    for f in diffs:
        if not prefilter.excluded(f.path):
            f.patch = git(repo, "diff", mb, head, "--", f.path)
    plan = prefilter.plan(diffs)
    deleted = git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=D", mb, head).splitlines()
    plan.skipped += [(path, "deleted") for path in deleted]
    hdir = Path(prep.get("hunt_dir") or hunt_dir(pr))
    reset_hunt_dir(hdir)
    (hdir / "skipped.log").write_text("\n".join(prefilter.describe(plan, batch)) + "\n")
    if not plan.batches:
        raise InfraError("prefilter left no source files to hunt (see skipped.log)")
    if not 1 <= batch <= len(plan.batches):
        raise InfraError(f"batch {batch} requested; batches are 1..{len(plan.batches)}")
    chosen = plan.batches[batch - 1]
    files = [f.path for f in chosen]
    patches = {f.path: "\n".join(f.patch.splitlines()[:prefilter.MAX_LINES + 20]) for f in chosen}
    syms: set[str] = set()
    for f in chosen:
        syms |= changed_symbols(f.patch, lang_of(f.path))
    targets = test_targets(wt, files)
    ctx = {
        "pr": {"number": int(pr), "title": meta.get("title", ""), "description": meta.get("body") or ""},
        "diff_production_code": "\n".join(patches[f] for f in files),
        "changed_files_head_source": [{"file": f, "source": source_view(wt, f, patches[f])} for f in files],
        "sibling_tests_and_helpers": sibling_tests(wt, files, syms),
        "callers": callers(wt, files, syms),
        "your_test_files": targets,
        # every changed path, hunted, skipped or deleted, so path-triggered rules (e.g. SQL migrations) still apply
        "all_changed_files": sorted({f.path for f in diffs} | set(deleted)),
    }
    state = {"pr": pr, "batch": batch, "batches": len(plan.batches), "repo": str(repo), "wt": str(wt),
             "wt_base": prep["wt_base"], "merge_base": mb, "head": head, "changed": files, "targets": targets,
             "own_tests": own_tests(repo, mb, head, {t["dir"] for t in targets})}
    write_json(hdir / "ctx.json", ctx)
    write_json(hdir / "state.json", state)
    return state


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--batch", type=int, default=1)
    a = ap.parse_args()
    with hunt_lock(hunt_dir(a.pr), a.pr):  # never rewrite state.json under a running run.py, nor read a half-made prep
        prep = json.loads((hunt_dir(a.pr) / "prepare.json").read_text())
        meta = json.loads(sh(["gh", "api", f"repos/{REPO}/pulls/{a.pr}"], Path(".")).stdout)
        if meta.get("draft"):
            print(f"note: PR #{a.pr} is a draft")
        st = build(a.pr, a.batch, prep, meta)
    ctx = json.loads((hunt_dir(a.pr) / "ctx.json").read_text())
    print(f"batch {st['batch']}/{st['batches']}: {len(st['changed'])} files, {len(ctx['callers'])} caller excerpts, "
          f"{len(ctx['sibling_tests_and_helpers'])} sibling test files; skipped.log has the rest")


if __name__ == "__main__":
    try:
        main()
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
