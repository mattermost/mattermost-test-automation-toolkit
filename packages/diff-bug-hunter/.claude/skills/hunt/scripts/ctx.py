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
import itertools
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any, NamedTuple

import prefilter
from hunt_common import REPO, InfraError, git, git_cmd, hunt_dir, hunt_lock, sh, write_json

MAX_SOURCE_LINES = 1500     # bigger changed files are shown as windows around the hunks
MAX_SIBLING_LINES = 3000    # total sibling test lines per batch
MAX_CALLERS = 40
CALLER_PAD = 6
MAX_BLOCK_LINES = 90        # one neighbour or merge-base function, clipped
MAX_LINE_CHARS = 300        # longer lines (generated literals) are cut, so one file cannot flood the context
MAX_NEIGHBOURS = 2          # unchanged functions shown per changed file
MAX_NEIGHBOUR_LINES = 1000  # neighbour lines per batch, shared evenly between its files
MAX_BASE_LINES = 2000       # merge-base function lines per batch, shared evenly between its files


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
            p = sh(["grep", "-rnwIH", "--include=*.go", "--include=*.ts", "--include=*.tsx", "--include=*.js",
                    "--exclude-dir=node_modules", "--exclude-dir=vendor", sym, root], wt, check=False)
            for hit in p.stdout.splitlines():
                if hit.count(":") < 2:
                    continue
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
    touched = changed_lines(patch)
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


MAX_PR_TEST_LINES = 400


def pr_tests_diff(repo: Path, mb: str, head: str, dirs: set[str]) -> list[dict[str, str]]:
    """What the PR's own tests in the hunted dirs add or change: Mode A lifts their literal examples into properties.
    Added lines only, with their head line numbers, capped at MAX_PR_TEST_LINES in all."""
    out = []
    budget = MAX_PR_TEST_LINES
    for f in git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", mb, head).splitlines():
        if budget <= 0:
            break
        if str(Path(f).parent) not in dirs or not (f.endswith("_test.go") or re.search(r"\.test\.[jt]sx?$", f)):
            continue
        if Path(f).name.startswith("hunt_"):
            continue
        rows = []
        new = 0
        for line in git(repo, "diff", "-U0", mb, head, "--", f).splitlines():
            m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if m:
                new = int(m.group(1))
            elif line.startswith("+") and not line.startswith("+++"):
                rows.append(f"{new}: {line[1:]}")
                new += 1
        if rows:
            out.append({"file": f, "added": "\n".join(rows[:budget])})
            budget -= len(rows)
    return out


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
STALE = ("A", "B", "D", "A2", "M", "M2", "R_*", "run_*", "base_*", "mutants_*", "compile_*", "fuzz_*", "diff_*", "ctx.json",
         "state.json", "skipped.log")
WHOLE_PR_STALE = ("old_tests.json", "old_tests.messages.json", "pr_tests.json", "pr_tests.messages.json")


def reset_hunt_dir(hdir: Path, *, include_whole_pr: bool = False) -> None:
    hdir.mkdir(parents=True, exist_ok=True)
    patterns = STALE + WHOLE_PR_STALE if include_whole_pr else STALE
    for pattern in patterns:
        for p in hdir.glob(pattern):
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink(missing_ok=True)


# ------------------------------------------------------------------ neighbours and merge-base versions
# Hunters compare the PR's code with unchanged functions next to it (guards the new code may lack) and with the
# merge-base version of each function it changed or removed (behaviour that should survive outside the PR's scope).

GO_FUNC = re.compile(r"^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*(\w+)[^)]*\)\s*)?([A-Za-z_]\w*)")
TS_FUNC = re.compile(r"^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)?\s*[<(]"
                     r"|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]")
SOURCE_SUFFIXES = {"go": (".go",), "jest": (".ts", ".tsx", ".js", ".jsx")}
NOT_NEIGHBOUR = re.compile(r"(^hunt_|_test\.go$|\.(test|spec|stories)\.|\.d\.ts$|\.pb\.go$|[._]gen(erated)?[._]|^mock_)")


class PatchLines(NamedTuple):
    added: set[int]      # head lines the patch adds
    anchors: set[int]    # head line just after each removal
    removed: set[int]    # base lines the patch removes
    inserted: set[int]   # base line just after each addition


def patch_lines(patch: str) -> PatchLines:
    """Line numbers a patch touches on each side. `+++`/`---` are headers only before the first hunk, so content
    lines like `++count;` still count; no-newline markers are skipped."""
    out = PatchLines(set(), set(), set(), set())
    new = old = 0
    in_hunk = False
    for line in patch.splitlines():
        m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            old, new, in_hunk = int(m.group(1)), int(m.group(2)), True
        elif not in_hunk or line.startswith("\\"):
            continue
        elif line.startswith("+"):
            out.added.add(new)
            out.inserted.add(old)
            new += 1
        elif line.startswith("-"):
            out.anchors.add(new)
            out.removed.add(old)
            old += 1
        else:
            new += 1
            old += 1
    return out


def changed_lines(patch: str) -> set[int]:
    """Head-side line numbers the patch adds, plus the head position of each removal (context lines excluded)."""
    pl = patch_lines(patch)
    return pl.added | pl.anchors


REGEX_BEFORE = re.compile(r"(^|[(,=:\[!&|?{};]|\breturn)\s*$")


def code_only(line: str, lang: str, open_quote: str = "") -> tuple[str, str]:
    """(code, quote still open at the end) for one Go or JS/TS line: string, rune, template-literal and JS regex
    contents and any `//` comment removed, so braces and `//` inside them don't count as code. `open_quote` carries a
    Go raw string or JS template literal across lines. Go raw strings have no escapes; JS template literals do. JSX
    text containing an apostrophe is not recognised (rare: only matters when a `{...}` then spans lines)."""
    out: list[str] = []
    quote = open_quote
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\" and not (quote == "`" and lang == "go"):
                i += 1
            elif c == quote:
                quote = ""
                out.append(c)
        elif c in "\"'`":
            quote = c
            out.append(c)
        elif line.startswith("//", i):
            break
        elif c == "/" and lang != "go" and REGEX_BEFORE.search("".join(out)):
            in_class = False
            i += 1
            while i < len(line) and (line[i] != "/" or in_class):
                if line[i] == "\\":
                    i += 1
                elif line[i] == "[":
                    in_class = True
                elif line[i] == "]":
                    in_class = False
                i += 1
            out.append('""')
        else:
            out.append(c)
        i += 1
    return "".join(out), quote


def code_lines(lines: list[str], lang: str) -> list[str]:
    """code_only over consecutive lines, carrying multi-line raw strings and template literals."""
    out, quote = [], ""
    for line in lines:
        code, quote = code_only(line, lang, quote)
        out.append(code)
    return out


def block_end(lines: list[str], a: int, limit: int, lang: str) -> tuple[int, bool]:
    """(last line, has a body) of the declaration starting at line a, 1-based. The body is the first `{` outside any
    parentheses (so an inline object type in a parameter list doesn't count); the block ends where that brace closes.
    A declaration with no body ends at its first line ending in `;` with nothing left open. Bounded by `limit`."""
    braces = parens = 0
    body = False
    for j, code in enumerate(code_lines(lines[a - 1:limit], lang), start=a - 1):
        for c in code:
            if c in "([":
                parens += 1
            elif c in ")]":
                parens = max(0, parens - 1)
            elif c == "{":
                body = body or (parens == 0 and braces == 0)
                braces += 1
            elif c == "}":
                braces = max(0, braces - 1)
        if body and braces == 0:
            return j + 1, True
        if not body and braces == 0 and parens == 0 and code.rstrip().endswith(";"):
            return j + 1, False
    return limit, body


def balanced(text: str, i: int) -> int:
    """Index just past the bracket group opening at text[i] (`(` or `<`), or -1 when it never closes."""
    pairs = {"(": ")", "<": ">"}
    stack = [pairs[text[i]]]
    for k in range(i + 1, len(text)):
        if text[k] in pairs and (text[k] == "(" or stack[-1] == ">"):
            stack.append(pairs[text[k]])
        elif text[k] == stack[-1] and not (text[k] == ">" and text[k - 1] == "="):
            stack.pop()
            if not stack:
                return k + 1
    return -1


def ts_holds_function(decl: str) -> bool:
    """Whether a `const`/`let`/`var` declaration's value is a function: an arrow, `function`, or a call whose argument
    list contains one (React.memo, forwardRef, useCallback, createSelector). `decl` is the code-only declaration."""
    m = re.search(r"(?<![=!<>])=(?![=>])", decl)
    if not m:
        return False
    rhs = decl[m.end():].lstrip()
    rhs = re.sub(r"^async\s+", "", rhs)
    if re.match(r"function\b|[A-Za-z_$][\w$]*\s*=>", rhs):
        return True
    if rhs.startswith("<"):  # generic arrow: <T,>(x: T) => x
        k = balanced(rhs, 0)
        rhs = rhs[k:].lstrip() if k > 0 else ""
        if not rhs.startswith("("):
            return False
    if rhs.startswith("("):
        k = balanced(rhs, 0)
        return k > 0 and re.match(r"\s*(?::[^=;{]+?)?=>", rhs[k:]) is not None
    call = re.match(r"[\w$.]+\s*(?:<[^;]*?>)?\s*\(", rhs)
    if call:
        k = balanced(rhs, call.end() - 1)
        args = rhs[call.end():k] if k > 0 else rhs[call.end():]
        return re.search(r"=>|\bfunction\b", args) is not None
    return False


def top_blocks(lines: list[str], lang: str) -> list[tuple[str, int, int]]:
    """Top-level functions as (symbol, first, last), 1-based. Go methods are Recv.Name, an anonymous default export is
    `default`, and a repeated name (several `init`) gets `#2`, `#3`. TS body-less overload signatures and declarations
    whose value is not a function are skipped."""
    rx = GO_FUNC if lang == "go" else TS_FUNC
    cands: list[tuple[int, str, bool]] = []  # (0-based line, name, is a `func`/`function` declaration)
    for i, line in enumerate(lines):
        m = rx.match(line)
        if not m:
            continue
        if lang == "go":
            cands.append((i, f"{m.group(1)}.{m.group(2)}" if m.group(1) else m.group(2), True))
        elif m.group(2) is None:
            cands.append((i, m.group(1) or "default", True))
        else:
            cands.append((i, m.group(2), False))
    out: list[tuple[str, int, int]] = []
    seen: dict[str, int] = {}
    for k, (i, name, is_fn) in enumerate(cands):
        limit = cands[k + 1][0] if k + 1 < len(cands) else len(lines)
        b, has_body = block_end(lines, i + 1, limit, lang)
        decl = code_lines(lines[i:b], lang)
        if lang != "go" and is_fn and (not has_body or decl[-1].rstrip().endswith(";")):
            continue  # overload signature: function f(a: {x: string}): {y: number};
        if lang != "go" and not is_fn and not ts_holds_function(" ".join(decl)):
            continue  # export const LIMIT = 5;
        seen[name] = seen.get(name, 0) + 1
        out.append((name if seen[name] == 1 else f"{name}#{seen[name]}", i + 1, b))
    return out


def clipped(lines: list[str], a: int, b: int, budget: int, focus: int | None = None) -> tuple[str, int]:
    """Numbered source of lines a..b, at most min(MAX_BLOCK_LINES, budget) of them, each cut at MAX_LINE_CHARS;
    the window starts a little before `focus` when given, so a long function still shows its changed part."""
    room = max(1, min(MAX_BLOCK_LINES, budget))
    first = a if focus is None else max(a, min(focus - 10, b - room + 1))
    last = min(b, first + room - 1)
    cut = [ln if len(ln) <= MAX_LINE_CHARS else ln[:MAX_LINE_CHARS] + " …" for ln in lines]
    text = ("   ...\n" if first > a else "") + numbered(cut, first, last) + ("\n   ...(truncated)" if last < b else "")
    return text, last - first + 1


def read_source(path: Path, root: Path, max_lines: int | None = None) -> list[str] | None:
    """Lines of a regular file inside root (the first max_lines when given); None for symlinks, anything outside root,
    or a file that cannot be read."""
    try:
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            return None
        with path.open(encoding="utf-8", errors="replace") as fh:
            return [line.rstrip("\r\n") for line in itertools.islice(fh, max_lines)]
    except OSError:
        return None


def is_generated(lines: list[str]) -> bool:
    """A `Code generated` / `@generated` marker anywhere in the leading comments (Mattermost puts its license header
    first); stops at the first line of code."""
    in_block = False
    for line in lines:
        s = line.strip()
        if "Code generated" in s or "@generated" in s:
            return True
        if in_block or s.startswith("/*"):
            in_block = "*/" not in s
        elif s and not s.startswith(("//", "#!")):
            return False
    return False


def nearest_first(blocks: list[tuple[str, int, int]], targets: list[tuple[int, int]]) -> list[tuple[str, int, int]]:
    """Blocks ordered by line distance to the nearest target range, then by position."""
    def key(blk: tuple[str, int, int]) -> tuple[int, int]:
        gap = min((max(0, blk[1] - hi, lo - blk[2]) for lo, hi in targets), default=0)
        return gap, blk[1]
    return sorted(blocks, key=key)


def tracked_siblings(wt: Path, f: str) -> list[str]:
    """Git-tracked files next to f (same directory, not recursive), sorted."""
    d = str(Path(f).parent)
    out = sh(git_cmd("ls-files", "-z", "--", "." if d == "." else d), wt).stdout
    return sorted(p for p in out.split("\0") if p and str(Path(p).parent) == d)


def neighbours_and_base(wt: Path, wt_base: Path, files: list[str], patches: dict[str, str],
                        all_changed: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Per changed file: up to MAX_NEIGHBOURS unchanged functions nearest the change, topped up from other tracked,
    hand-written source files in the same directory when the file has too few (a new file, or a component whose
    logic is nested); and the merge-base version of every function the patch changes or removes. A sibling function
    is listed once, with every changed file it was picked for in `near`. Deterministic: files and blocks in order.
    Each file gets an even share of the line budgets."""
    neigh: list[dict[str, Any]] = []
    shown: dict[tuple[str, str], dict[str, Any]] = {}
    base: list[dict[str, Any]] = []
    n_share = MAX_NEIGHBOUR_LINES // max(1, len(files))
    b_share = MAX_BASE_LINES // max(1, len(files))

    def entry(f: str, sym: str, a: int, b: int, text: str, **extra: Any) -> dict[str, Any]:
        return {"file": f, "symbol": sym, "lines": f"{a}-{b}", **extra, "source": text}

    for f in files:
        lang = lang_of(f)
        lines = read_source(wt / f, wt)
        if lines is None:
            continue
        pl = patch_lines(patches[f])
        blocks = top_blocks(lines, lang)
        changed = [blk for blk in blocks
                   if any(blk[1] <= n <= blk[2] for n in pl.added) or any(blk[1] < n <= blk[2] for n in pl.anchors)]
        unchanged = [blk for blk in blocks if blk not in changed]
        targets = [(c[1], c[2]) for c in changed] or [(n, n) for n in sorted(pl.added | pl.anchors)]
        budget, picked = n_share, 0
        for sym, a, b in nearest_first(unchanged, targets)[:MAX_NEIGHBOURS]:
            text, used = clipped(lines, a, b, budget)
            neigh.append(entry(f, sym, a, b, text, scope="same_file", near=[f]))
            budget, picked = budget - used, picked + 1
        for rel in tracked_siblings(wt, f) if picked < MAX_NEIGHBOURS else []:
            if picked == MAX_NEIGHBOURS or budget <= 0:
                break
            if (rel in all_changed or not rel.endswith(SOURCE_SUFFIXES[lang]) or prefilter.excluded(rel)
                    or NOT_NEIGHBOUR.search(Path(rel).name)):
                continue
            plines = read_source(wt / rel, wt, MAX_SOURCE_LINES)
            if plines is None or is_generated(plines):
                continue
            for sym, a, b in top_blocks(plines, lang)[:MAX_NEIGHBOURS - picked]:
                if (rel, sym) in shown:  # already listed for another changed file in this directory
                    shown[(rel, sym)]["near"].append(f)
                    picked += 1
                    continue
                if budget <= 0:
                    break
                text, used = clipped(plines, a, b, budget)
                shown[(rel, sym)] = entry(rel, sym, a, b, text, scope="same_dir", near=[f])
                neigh.append(shown[(rel, sym)])
                budget, picked = budget - used, picked + 1

        blines = read_source(wt_base / f, wt_base)
        if blines is None:
            continue  # new in this PR: no merge-base version to compare with
        bblocks = top_blocks(blines, lang)
        repeated = {s.split("#")[0] for s, _, _ in blocks + bblocks if "#" in s}  # ordinals can't pair head with base
        names = {sym for sym, _, _ in changed}
        budget = b_share
        for sym, a, b in bblocks:
            if sym.split("#")[0] in repeated or budget <= 0:
                continue
            hit = sorted(n for n in pl.removed | pl.inserted if a <= n <= b)
            if sym in names or any(a <= n <= b for n in pl.removed):
                text, used = clipped(blines, a, b, budget, hit[0] if hit else None)
                base.append(entry(f, sym, a, b, text))
                budget -= used
    return neigh, base


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
    all_changed = sorted({f.path for f in diffs} | set(deleted))
    pr_info: dict[str, Any] = {"number": int(pr) if str(pr).isdigit() else 0,
                               "title": meta.get("title", ""), "description": meta.get("body") or ""}
    if prep.get("range"):
        pr_info["range"] = f"{prep['range'][0]}...{prep['range'][1]}"
    ctx: dict[str, Any] = {
        "pr": pr_info,
        "diff_production_code": "\n".join(patches[f] for f in files),
        "changed_files_head_source": [{"file": f, "source": source_view(wt, f, patches[f])} for f in files],
        "sibling_tests_and_helpers": sibling_tests(wt, files, syms),
        "callers": callers(wt, files, syms),
        "your_test_files": targets,
        # every changed path, hunted, skipped or deleted, so path-triggered rules (e.g. SQL migrations) still apply
        "all_changed_files": all_changed,
        "pr_tests_diff": pr_tests_diff(repo, mb, head, {t["dir"] for t in targets}),
    }
    ctx["neighbors_same_file"], ctx["changed_functions_base_source"] = neighbours_and_base(
        wt, Path(prep["wt_base"]), files, {f.path: f.patch for f in chosen}, set(all_changed))
    state = {"pr": pr, "batch": batch, "batches": len(plan.batches), "repo": str(repo), "wt": str(wt),
             "wt_base": prep["wt_base"], "merge_base": mb, "head": head, "changed": files, "targets": targets,
             "own_tests": own_tests(repo, mb, head, {t["dir"] for t in targets})}
    write_json(hdir / "ctx.json", ctx)
    write_json(hdir / "state.json", state)
    return state


def range_meta(repo: Path, mb: str, head: str, base_spec: str, head_spec: str) -> dict[str, Any]:
    """Commit-log summary used in place of PR title/description when hunting a release or commit range."""
    total = git(repo, "rev-list", "--count", "--no-merges", f"{mb}..{head}")
    subjects = git(repo, "log", "--oneline", "--no-merges", "-n", "50", f"{mb}..{head}")
    body = f"Range {base_spec}...{head_spec} ({total} non-merge commit(s)):\n{subjects}"
    return {"title": f"{base_spec}...{head_spec}", "body": body}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--batch", type=int, default=1)
    a = ap.parse_args()
    with hunt_lock(hunt_dir(a.pr), a.pr):  # never rewrite state.json under a running run.py, nor read a half-made prep
        prep_path = hunt_dir(a.pr) / "prepare.json"
        if not prep_path.exists():
            raise InfraError(f"{prep_path} missing: run prepare.py first")
        prep = json.loads(prep_path.read_text())
        if prep.get("range"):
            meta = range_meta(Path(prep["repo"]), prep["merge_base"], prep["head"], prep["range"][0], prep["range"][1])
        else:
            meta = json.loads(sh(["gh", "api", f"repos/{REPO}/pulls/{a.pr}"], Path(".")).stdout)
            if meta.get("draft"):
                print(f"note: PR #{a.pr} is a draft")
        st = build(a.pr, a.batch, prep, meta)
    ctx = json.loads((hunt_dir(a.pr) / "ctx.json").read_text())
    print(f"batch {st['batch']}/{st['batches']}: {len(st['changed'])} files, {len(ctx['callers'])} caller excerpts, "
          f"{len(ctx['sibling_tests_and_helpers'])} sibling test files, {len(ctx['neighbors_same_file'])} neighbour and "
          f"{len(ctx['changed_functions_base_source'])} merge-base functions; skipped.log has the rest")


if __name__ == "__main__":
    try:
        main()
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
