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

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import prefilter
from hunt_common import REPO, InfraError, git, hunt_dir, sh, write_json

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
        rx = r"func (?:\([^)]*\) )?([A-Za-z_]\w*)\(|^type ([A-Z]\w*) "
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


def own_tests(repo: Path, mb: str, head: str, dirs: set[str]) -> dict[str, list[str]]:
    """Tests the PR itself adds or changes in the hunted dirs: Go test names, Jest file paths."""
    names: list[str] = []
    jest: list[str] = []
    for f in git(repo, "diff", "--name-only", mb, head).splitlines():
        if str(Path(f).parent) not in dirs:
            continue
        if f.endswith("_test.go"):
            patch = git(repo, "diff", mb, head, "--", f)
            names += re.findall(r"^\+func (Test\w+)\(t \*testing\.T\)", patch, re.M)
        elif re.search(r"\.test\.[jt]sx?$", f):
            jest.append(f)
    return {"go": sorted(set(names)), "jest": sorted(jest)}


def file_diffs(repo: Path, mb: str, head: str) -> list[prefilter.FileDiff]:
    out = []
    for row in git(repo, "diff", "--numstat", mb, head).splitlines():
        a, r, path = row.split("\t", 2)
        if a == "-":  # binary
            out.append(prefilter.FileDiff(path, 0, 0))
            continue
        out.append(prefilter.FileDiff(path, int(a), int(r)))
    return out


def build(pr: str, batch: int, prep: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    repo, wt, mb, head = Path(prep["repo"]), Path(prep["wt"]), prep["merge_base"], prep["head"]
    diffs = file_diffs(repo, mb, head)
    for f in diffs:
        if not prefilter.excluded(f.path):
            f.patch = git(repo, "diff", mb, head, "--", f.path)
    plan = prefilter.plan(diffs)
    hdir = Path(prep.get("hunt_dir") or hunt_dir(pr))
    (hdir / "skipped.log").write_text("\n".join(prefilter.describe(plan, batch)) + "\n")
    if not plan.batches:
        raise InfraError("prefilter left no source files to hunt (see skipped.log)")
    if batch > len(plan.batches):
        raise InfraError(f"batch {batch} requested, only {len(plan.batches)} exist")
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
