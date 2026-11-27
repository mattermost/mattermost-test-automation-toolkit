#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 2: mechanical blind context for one batch of a PR.

usage: ctx.py <pr> [--batch N | --all-batches | --first-batch]
Reads prepare.json, fetches PR title/body over the GitHub REST API, runs the large-diff prefilter, and writes
ctx.json (what hunters see), state.json (what the runner needs) and skipped.log (every file not hunted, with reason).
Nothing here is summarised or chosen by a model.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import argparse
import itertools
import json
import re
import shutil
from pathlib import Path
from typing import Any, NamedTuple

import prefilter
import reliability
from hunt_common import (
    REPO,
    InfraError,
    git,
    git_cmd,
    hunt_dir,
    hunt_lock,
    read_optional_dict,
    read_optional_json,
    read_text_lossy,
    sh,
    write_json,
)

MAX_SOURCE_LINES = 1500     # bigger changed files are shown as windows around the hunks
MAX_SIBLING_LINES = 3000    # total sibling test lines per batch
MAX_CALLERS = 40            # total caller excerpts, shared fairly between changed symbols
MAX_HOPS = 3                # caller walk: direct caller plus up to two more hops toward an entry point
MAX_HOP_GREPS = 24          # repo greps spent on hops 2-3 per batch
MAX_CHAINS_PER_SYMBOL = 2   # direct callers whose chain is walked, per symbol
MAX_COUNT_FILES = 25        # files whose caller count feeds the batch ordering
MAX_COUNT_SYMBOLS = 8
CALLER_PAD = 6
MAX_BLOCK_LINES = 90        # one neighbour or merge-base function, clipped
MAX_PATCH_LINES = 4000      # one file's patch in a hunter request; longer (generated) patches are cut there only
MAX_LINE_CHARS = 300        # longer lines (generated literals) are cut, so one file cannot flood the context
MAX_NEIGHBOURS = 2          # unchanged functions shown per changed file
MAX_NEIGHBOUR_LINES = 1000  # neighbour lines per batch, shared evenly between its files
MAX_BASE_LINES = 2000       # merge-base function lines per batch, shared evenly between its files


def numbered(lines: list[str], a: int, b: int) -> str:
    return "\n".join(f"{i:5d}  {lines[i - 1]}" for i in range(a, b + 1))


def hunk_ranges(patch: str) -> list[tuple[int, int]]:
    return [(int(m.group(1)), int(m.group(2) or 1)) for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", patch, re.M)]


def source_view(wt: Path, path: str, patch: str, focus_lines: list[int] | None = None, window: int = 40,
                max_lines: int = MAX_SOURCE_LINES) -> str:
    lines = (wt / path).read_text(errors="replace").split("\n")
    if len(lines) <= max_lines:
        return numbered(lines, 1, len(lines))
    spans = [(max(1, start - 40), min(len(lines), start + n + 40)) for start, n in hunk_ranges(patch)]
    if focus_lines is not None:
        for ln in focus_lines:
            c = min(len(lines), max(1, ln))
            spans.append((max(1, c - window), min(len(lines), c + window)))
        spans = [(a, b) for a, b in spans if a <= b]
        if not spans:
            return numbered(lines, 1, min(len(lines), min(120, max_lines)))
    spans = _merge_spans(spans)
    total = _rendered_span_lines(spans)
    if total > max_lines:
        anchors = changed_lines(patch) | set(focus_lines or ())
        src_budget = max(1, max_lines - 1)  # reserve 1 line for `[source cut: ...]`
        alloc = _allocate_budgets({i: b - a + 1 for i, (a, b) in enumerate(spans)}, src_budget)
        non_empty = sum(1 for v in alloc.values() if v > 0)
        if non_empty > 1 and sum(alloc.values()) + non_empty > max_lines:
            alloc = _allocate_budgets({i: b - a + 1 for i, (a, b) in enumerate(spans)}, max(1, max_lines - non_empty))
        capped: list[tuple[int, int]] = []
        for i, (a, b) in enumerate(spans):
            cap = alloc[i]
            if cap <= 0:
                continue
            hits = [ln for ln in anchors if a <= ln <= b]
            if hits and (b - a + 1) > cap:
                lo_c, hi_c = min(hits), max(hits)
                if hi_c - lo_c + 1 <= cap:
                    pad = cap - (hi_c - lo_c + 1)
                    lo = max(a, lo_c - pad // 2)
                    hi = min(b, lo + cap - 1)
                    lo = max(a, hi - cap + 1)
                else:
                    lo, hi = lo_c, min(b, lo_c + cap - 1)
                capped.append((lo, hi))
            else:
                capped.append((a, min(b, a + cap - 1)))
        spans = capped
        shown = _rendered_span_lines(spans)
        rendered = "\n   ...\n".join(numbered(lines, a, b) for a, b in spans)
        return f"{rendered}\n[source cut: {total - shown} more lines not shown]"
    return "\n   ...\n".join(numbered(lines, a, b) for a, b in spans)


def request_patch(patch: str) -> str:
    """One file's patch as a hunter sees it: whole up to MAX_PATCH_LINES, then cut with a note. A generated file of
    tens of thousands of lines would otherwise fill the model's context on its own."""
    lines = patch.splitlines()
    if len(lines) <= MAX_PATCH_LINES:
        return patch
    return "\n".join(lines[:MAX_PATCH_LINES]) + f"\n[patch cut: {len(lines) - MAX_PATCH_LINES} more lines not shown]"


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


SIBLING_TEST_SUFFIXES = ("_test.go", ".test.ts", ".test.tsx", ".test.js", ".test.jsx")
SIBLING_SYM_BEFORE = 15
SIBLING_SYM_AFTER = 30
MIN_SIBLING_WINDOW = 25
MAX_SECONDARY_SIBLINGS = 4


def sibling_rank(p: Path, stems: str | list[str], symbols: set[str], body: str | None = None) -> int:
    """0 helpers (main/helper/setup), 1 same-name test, 2 mentions a changed symbol, 9 unrelated."""
    n = p.name
    if re.match(r"(main|helper|setup|utils?)[._]", n):
        return 0
    stem_list = [stems] if isinstance(stems, str) else stems
    if any(n.startswith((s + "_test", s + ".test")) for s in stem_list):
        return 1
    if not symbols:
        return 9
    text = p.read_text(errors="replace") if body is None else body
    return 2 if any(s in text for s in symbols) else 9


def _allocate_budgets(needs: dict[Any, int], total: int) -> dict[Any, int]:
    """Water-filling budget split: items needing <= share get full need; larger items split the rest evenly."""
    alloc: dict[Any, int] = {}
    rem = dict(needs)
    left = max(0, total)
    while rem:
        share = left // len(rem)
        small = {k: n for k, n in rem.items() if n <= share}
        if not small:
            extra = left - share * len(rem)
            for idx, k in enumerate(rem):
                alloc[k] = share + (1 if idx < extra else 0)
            break
        for k, n in small.items():
            alloc[k] = n
            left -= n
            del rem[k]
    return alloc


def _merge_spans(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not spans:
        return []
    ordered = sorted(spans)
    merged = [ordered[0]]
    for a, b in ordered[1:]:
        pa, pb = merged[-1]
        if a <= pb + 1:
            merged[-1] = (pa, max(pb, b))
        else:
            merged.append((a, b))
    return merged


def _rendered_span_lines(spans: list[tuple[int, int]]) -> int:
    return sum(b - a + 1 for a, b in spans) + max(0, len(spans) - 1)


def _add_span(spans: list[tuple[int, int]], a: int, b: int, budget: int) -> list[tuple[int, int]]:
    if a > b or budget <= 0:
        return spans
    merged = _merge_spans([*spans, (a, b)])
    if _rendered_span_lines(merged) <= budget:
        return merged
    if _rendered_span_lines(_merge_spans([*spans, (a, a)])) > budget:
        return spans
    lo, hi = a, b
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _rendered_span_lines(_merge_spans([*spans, (a, mid)])) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return _merge_spans([*spans, (a, lo)])


def _is_setup_helper(sym: str, lang: str) -> bool:
    if lang != "go":
        return True
    name = sym.rsplit(".", 1)[-1]
    return name == "TestMain" or not name.startswith(("Test", "Benchmark", "Fuzz", "Example"))


def _windowed_sibling(lines: list[str], lang: str, symbols: set[str], budget: int) -> tuple[str, int]:
    """Compact windowed excerpt of an oversized sibling test: package header + top setup helpers + symbol windows."""
    n = len(lines)
    if budget <= 0 or n == 0:
        return "", 0
    hits_by_sym: list[list[int]] = []
    for sym in sorted(symbols):
        rx = re.compile(rf"\b{re.escape(sym)}\b")
        hits = [i for i, ln in enumerate(lines, 1) if rx.search(ln)] or [i for i, ln in enumerate(lines, 1) if sym in ln]
        if hits:
            hits_by_sym.append(hits)

    blocks = top_blocks(lines, lang)
    first_test = next((i for i, ln in enumerate(lines, 1)
                       if (lang == "go" and ln.startswith("func "))
                       or (lang != "go" and re.match(r"^(?:describe|test|it)\s*\(", ln))), n + 1)
    first_decl = min([first_test] + ([blocks[0][1]] if blocks else []))
    hdr_cap = min(80, max(1, budget // 4))
    hdr_end = min(n, max(1, first_decl - 1) if first_decl > 1 else hdr_cap, hdr_cap)
    spans = _add_span([], 1, hdr_end, budget)

    sym_reserve = max(1, budget // 3) if hits_by_sym else 0
    helper_budget = min(budget - sym_reserve, _rendered_span_lines(spans) + max(0, budget // 3))
    helpers = [blk for blk in blocks if _is_setup_helper(blk[0], lang)]
    if lang == "go":
        helpers.sort(key=lambda blk: (0 if blk[0] == "TestMain" else 1, blk[1]))
    for _, a, b in helpers:
        if _rendered_span_lines(spans) >= helper_budget:
            break
        spans = _add_span(spans, a, min(b, a + MAX_BLOCK_LINES - 1), helper_budget)

    sym_added = False
    want_win = SIBLING_SYM_BEFORE + 1 + SIBLING_SYM_AFTER
    for round_hits in itertools.zip_longest(*hits_by_sym):
        if _rendered_span_lines(spans) >= budget:
            break
        for h in round_hits:
            if h is None or any(sa <= h <= sb for sa, sb in spans):
                continue
            rem = budget - _rendered_span_lines(spans)
            if rem <= 0:
                break
            sep = 0 if (not spans or any(sa - 1 <= h <= sb + 1 for sa, sb in spans)) else 1
            avail = rem - sep
            if avail <= 0:
                continue
            if avail >= want_win:
                a, b = max(1, h - SIBLING_SYM_BEFORE), min(n, h + SIBLING_SYM_AFTER)
            else:
                pre = min(SIBLING_SYM_BEFORE, (avail - 1) // 3)
                a = max(1, h - pre)
                b = min(n, a + avail - 1)
                a = max(1, b - avail + 1)
            before = _rendered_span_lines(spans)
            spans = _add_span(spans, a, b, budget)
            if _rendered_span_lines(spans) > before:
                sym_added = True

    if not sym_added:
        spans = _add_span(spans, 1, min(n, budget, max(hdr_end + 120, min(200, budget))), budget)

    text = "\n   ...\n".join(numbered(lines, a, b) for a, b in spans)
    return text, _rendered_span_lines(spans)


def _emit_sibling_group(
    wt: Path, group: list[tuple[int, Path, list[str]]], budget: int, symbols: set[str], out: list[dict[str, str]],
) -> int:
    budgets = _allocate_budgets({p: len(lines) for _, p, lines in group}, budget)
    used_total = 0
    for _, p, lines in group:
        cap = budgets[p]
        if cap <= 0:
            continue
        if len(lines) <= cap:
            text, used = numbered(lines, 1, len(lines)), len(lines)
        else:
            text, used = _windowed_sibling(lines, lang_of(p.name), symbols, cap)
        if text:
            out.append({"file": str(p.relative_to(wt)), "source": text})
            used_total += used
    return used_total


GO_SETUP_DECL = re.compile(r"^(?:func (?:TestMain\(|(?!(?:Test|Benchmark|Fuzz|Example)[A-Z_(])(?:\([^)]*\) )?\w+\()|type \w+ )", re.M)


HELPER_SRC_NAME = re.compile(r"testlib|test_?helpers?|test_?utils?|testutil", re.I)
MAX_JEST_FALLBACK = 2


def setup_fallback(cands: list[Path], helpers: list[Path] | None = None) -> list[tuple[int, Path, list[str]]]:
    """No sibling ranks 0-2 (no same-name test, none mentions a changed symbol): give the hunter the Go files that
    declare the package's setup helpers / mock types (e.g. remotecluster's mocks_test.go newMockServer), smallest first,
    so it can build the service under test. Without them hunters return no tests at all (PR 39657). `helpers` are
    non-test sources of the same directory (api4/apitestlib.go): prefilter keeps them out of the hunt, but they are
    where a package's Setup(t) lives, so they count here too."""
    found: list[tuple[int, Path, list[str]]] = []
    for p in [*cands, *(helpers or [])]:
        if not (p.name.endswith("_test.go") or (p.name.endswith(".go") and HELPER_SRC_NAME.search(p.name))):
            continue
        body = p.read_text(errors="replace")
        if GO_SETUP_DECL.search(body):
            found.append((3, p, body.split("\n")))
    found.sort(key=lambda item: len(item[2]))
    return found[:MAX_SECONDARY_SIBLINGS]


def helper_sources(d: Path, exclude: set[str], wt: Path) -> list[Path]:
    """Non-test Go helper sources of a directory (apitestlib.go, testlib.go, test_helper.go), never a changed file."""
    return sorted(p for p in d.iterdir()
                  if not p.is_symlink() and p.is_file() and p.name.endswith(".go") and not p.name.endswith("_test.go")
                  and HELPER_SRC_NAME.search(p.name) and str(p.relative_to(wt)) not in exclude)


def jest_fallback(d: Path, exclude: set[str], wt: Path) -> list[tuple[int, Path, list[str]]]:
    """A jest directory with no same-name or symbol-mentioning test: show its smallest sibling tests (same directory,
    else its __tests__ or the parent's __tests__) so the hunter sees how this code base mounts and mocks components."""
    wt_root = wt.resolve()
    for where in (d, d / "__tests__", d.parent / "__tests__"):
        if where.is_symlink() or not where.is_dir() or not where.resolve().is_relative_to(wt_root):
            continue
        found = []
        for p in sorted(where.iterdir()):
            if not p.name.endswith(SIBLING_TEST_SUFFIXES[1:]) or p.name.startswith("hunt_"):
                continue
            try:
                rel = str(p.relative_to(wt))
            except ValueError:
                continue
            if rel in exclude:
                continue
            lines = read_source(p, wt)
            if lines is not None:
                found.append((3, p, lines))
        if found:
            found.sort(key=lambda item: len(item[2]))
            return found[:MAX_JEST_FALLBACK]
    return []


def sibling_tests(wt: Path, files: list[str], symbols: set[str]) -> list[dict[str, str]]:
    """Sibling tests in rank order, fairly budgeted across unique target directories; oversized rank 0/1/2 files
    are emitted as compact windowed excerpts instead of being dropped, and unrelated tests are never included, except
    the setup-helper fallback for a directory that has nothing else (setup_fallback)."""
    file_set = {str(Path(f)) for f in files}
    dir_stems: dict[Path, list[str]] = {}
    for f in files:
        d = (wt / f).parent
        if not d.is_dir():
            continue
        stems = dir_stems.setdefault(d, [])
        for stem in (Path(f).stem, Path(f).name.split(".")[0]):
            if stem and stem not in stems:
                stems.append(stem)

    dir_cands: dict[Path, list[tuple[int, Path, list[str]]]] = {}
    dir_needs: dict[Path, int] = {}
    for d, stems in dir_stems.items():
        cands = sorted(p for p in d.iterdir()
                       if not p.is_symlink() and p.is_file() and p.name.endswith(SIBLING_TEST_SUFFIXES)
                       and not p.name.startswith("hunt_") and str(p.relative_to(wt)) not in file_set)
        ranked: list[tuple[int, Path, list[str]]] = []
        for p in cands:
            rank = sibling_rank(p, stems, set())
            if rank < 2:
                lines = p.read_text(errors="replace").split("\n")
            elif symbols:
                body = p.read_text(errors="replace")
                rank = sibling_rank(p, stems, symbols, body=body)
                if rank == 9:
                    continue
                lines = body.split("\n")
            else:
                continue
            ranked.append((rank, p, lines))
        has_go = any(lang_of(f) == "go" and (wt / f).parent == d for f in files)
        has_jest = any(lang_of(f) == "jest" and not f.endswith(".sql") and (wt / f).parent == d for f in files)
        if not any(lang_of(p.name) == "go" for _, p, _ in ranked) and has_go:
            ranked += setup_fallback(cands, helper_sources(d, file_set, wt))
        if not any(lang_of(p.name) == "jest" for _, p, _ in ranked) and has_jest:
            ranked += jest_fallback(d, file_set, wt)
        ranked.sort(key=lambda item: (item[0], item[1].name))
        if ranked:
            dir_cands[d] = ranked
            dir_needs[d] = sum(len(lines) for _, _, lines in ranked)

    out: list[dict[str, str]] = []
    dir_budgets = _allocate_budgets(dir_needs, MAX_SIBLING_LINES)
    for d, ranked in dir_cands.items():
        budget = dir_budgets[d]
        primary = [item for item in ranked if item[0] != 2]  # ranks 0-1, or the rank-3 setup fallback alone
        secondary = [item for item in ranked if item[0] == 2]
        used_total = _emit_sibling_group(wt, primary, budget, symbols, out)
        rem = budget - used_total
        if secondary and rem > 0 and (used_total == 0 or rem >= MIN_SIBLING_WINDOW):
            sec_pool = secondary[:min(MAX_SECONDARY_SIBLINGS, max(1, rem // MIN_SIBLING_WINDOW))]
            _emit_sibling_group(wt, sec_pool, rem, symbols, out)
    return out


ENTRY_POINT = re.compile(r"/(?:api4|wsapi|plugin|web)/|/plugin_api[^/]*\.go$")
GO_FUNC_DECL = re.compile(r"^func (?:\([^)]*\)\s*)?([A-Za-z_]\w*)")
TS_FUNC_DECL = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_]\w*)|const\s+([A-Za-z_]\w*)\s*[=:])")
PERMISSION_CALL = re.compile(r"SessionHasPermissionTo\w*\(|\bHasPermissionTo\w*\(")
MAX_ENCLOSING_LINES = 400
CALLER_INCLUDES = ("--include=*.go", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx")
CALLER_EXCLUDE_DIRS = ("--exclude-dir=node_modules", "--exclude-dir=vendor")


def is_entry_point(path: str) -> bool:
    return bool(ENTRY_POINT.search("/" + path))


def _is_test_path(f: str) -> bool:
    return (
        f.endswith(("_test.go", ".test.ts", ".test.tsx", ".test.js", ".test.jsx"))
        or "/mocks/" in f
        or "/node_modules/" in f
        or "/vendor/" in f
        or f.startswith(("node_modules/", "vendor/"))
    )


def _grep_callers(wt: Path, word: str, root: str) -> list[str]:
    if (wt / ".git").exists() and root:
        specs = [root] if (wt / root).is_file() else [f"{root}/*.{ext}" for ext in ("go", "ts", "tsx", "js", "jsx")]
        excludes = [":(exclude)*/node_modules/*", ":(exclude)node_modules/*", ":(exclude)*/vendor/*", ":(exclude)vendor/*"]
        p = sh(git_cmd("grep", "--no-color", "-nwIF", "--untracked", "--no-exclude-standard", "-e", word,
                       "--", *specs, *excludes), wt, check=False)
        if p.returncode in (0, 1):
            return p.stdout.splitlines()
    p = sh(["grep", "-rnwIH", *CALLER_INCLUDES, *CALLER_EXCLUDE_DIRS, "-e", word, root], wt, check=False)
    return p.stdout.splitlines()


def grep_word(wt: Path, word: str, roots: list[str]) -> list[tuple[str, int]]:
    """(file, line) of every whole-word hit of `word` in non-test source under `roots`, in grep order."""
    hits: list[tuple[str, int]] = []
    for root in roots:
        for hit in _grep_callers(wt, word, root):
            if hit.count(":") < 2:
                continue
            f, n_s, _ = hit.split(":", 2)
            if n_s.isdigit() and not _is_test_path(f):
                hits.append((f, int(n_s)))
    return hits


def enclosing_function(lines: list[str], n: int, lang: str) -> tuple[str, int, int] | None:
    """(name, first line, last line), 1-based, of the top-level function around line n, or None."""
    rx = GO_FUNC_DECL if lang == "go" else TS_FUNC_DECL
    for i in range(min(n, len(lines)) - 1, max(-1, n - 1 - MAX_ENCLOSING_LINES), -1):
        m = rx.match(lines[i])
        if not m:
            continue
        name = next(g for g in m.groups() if g)
        limit = min(len(lines), i + MAX_ENCLOSING_LINES)
        for k in range(i + 1, limit):
            if rx.match(lines[k]):
                limit = k
                break
        end, has_body = block_end(lines, i + 1, limit, lang)
        if lang == "go" or m.group(1) is not None:
            if not has_body:
                return None
        else:
            decl = " ".join(code_lines(lines[i:end], lang))
            if not ts_holds_function(decl):
                return None
            if not has_body and not decl.rstrip().endswith(";"):
                end = i + 1
        return (name, i + 1, end) if i + 1 <= n <= end else None
    return None


def permission_lines(f: str, lines: list[str], a: int, b: int) -> list[str]:
    return [f"{f}:{i}: {lines[i - 1].strip()[:MAX_LINE_CHARS]}" for i in range(a, min(b, len(lines)) + 1)
            if PERMISSION_CALL.search(lines[i - 1])]


def caller_rank(hit: tuple[str, int]) -> tuple[int, int, str, int]:
    """Entry points (api4, wsapi, plugin, web) first, then the shallowest paths: never alphabetical across the repo."""
    f, n = hit
    return (0 if is_entry_point(f) else 1, f.count("/"), f, n)


def callers(wt: Path, files: list[str], symbols: set[str]) -> list[dict[str, Any]]:
    """Caller excerpts per changed symbol, round-robin so one popular symbol cannot use the whole MAX_CALLERS cap.
    Each symbol's list is its direct callers ranked entry points first; the top MAX_CHAINS_PER_SYMBOL callers are
    walked up to MAX_HOPS hops toward an api4/wsapi/plugin/web entry point (the enclosing function of each hit is
    searched in turn). Every excerpt carries the SessionHasPermissionTo* lines of its enclosing function, the
    authorisation on the path to the change."""
    roots = sorted({f.split("/")[0] for f in files})
    file_set = set(files)
    cache: dict[str, list[str]] = {}
    grep_budget = [MAX_HOP_GREPS]

    def source(f: str) -> list[str]:
        if f not in cache:
            cache[f] = (wt / f).read_text(errors="replace").split("\n")
        return cache[f]

    def excerpt(f: str, n: int, sym: str, root_sym: str, hop: int) -> dict[str, Any]:
        lines = source(f)
        a, b = max(1, n - CALLER_PAD), min(len(lines), n + CALLER_PAD)
        enc = enclosing_function(lines, n, lang_of(f))
        e: dict[str, Any] = {"file": f, "symbol": sym, "lines": f"{a}-{b}", "source": numbered(lines, a, b),
                             "hop": hop, "entry_point": is_entry_point(f),
                             "permission_checks": permission_lines(f, lines, enc[1], enc[2]) if enc else []}
        if enc:
            e["enclosing"] = enc[0]
        if root_sym != sym:
            e["chain_for"] = root_sym
        return e

    per_symbol: list[list[tuple[str, int, str, str, int]]] = []
    for sym in sorted(symbols):
        direct: list[tuple[str, int]] = []
        seen: set[tuple[str, int]] = set()
        for f, n in sorted(grep_word(wt, sym, roots), key=caller_rank):
            if f in file_set or (f, n // 10) in seen:
                continue
            seen.add((f, n // 10))
            direct.append((f, n))
        specs: list[tuple[str, int, str, str, int]] = []
        used: set[tuple[str, int]] = set()
        for k, (f, n) in enumerate(direct):
            if (f, n // 10) not in used:
                specs.append((f, n, sym, sym, 1))
            if k >= MAX_CHAINS_PER_SYMBOL:
                continue
            cur_f, cur_n = f, n
            visited: set[tuple[str, int]] = {(f, n)}
            for hop in range(2, MAX_HOPS + 1):
                if is_entry_point(cur_f) or grep_budget[0] <= 0:
                    break
                enc = enclosing_function(source(cur_f), cur_n, lang_of(cur_f))
                if enc is None or len(enc[0]) <= 3 or enc[0].startswith("Test") or enc[0] == sym:
                    break
                visited.add((cur_f, enc[1]))
                grep_budget[0] -= 1
                ups = [
                    h for h in sorted(grep_word(wt, enc[0], roots), key=caller_rank)
                    if h[0] not in file_set
                    and not (h[0] == cur_f and enc[1] <= h[1] <= enc[2])
                    and h not in visited
                ]
                if not ups:
                    break
                cur_f, cur_n = ups[0]
                visited.add((cur_f, cur_n))
                used.add((cur_f, cur_n // 10))
                specs.append((cur_f, cur_n, enc[0], sym, hop))
        per_symbol.append(specs)

    out: list[dict[str, Any]] = []
    seen_out: set[tuple[str, str]] = set()
    for group in itertools.zip_longest(*per_symbol):
        for spec in group:
            if spec is None:
                continue
            f, n, hit_sym, root_sym, hop = spec
            lines = source(f)
            a, b = max(1, n - CALLER_PAD), min(len(lines), n + CALLER_PAD)
            if (f, f"{a}-{b}") in seen_out:
                continue
            seen_out.add((f, f"{a}-{b}"))
            out.append(excerpt(f, n, hit_sym, root_sym, hop))
            if len(out) >= MAX_CALLERS:
                return out
    return out


def caller_counts(wt: Path, chosen: list[prefilter.FileDiff]) -> dict[str, int]:
    """How many places call each file's changed symbols (whole-word hits outside the file and tests), for the batch
    order. Only the riskiest MAX_COUNT_FILES files are measured; the rest count as 0."""
    out: dict[str, int] = {}
    ranked = sorted((f for f in chosen if not prefilter.excluded(f.path)), key=lambda f: (-prefilter.risk(f), f.path))
    for f in ranked[:MAX_COUNT_FILES]:
        syms = sorted(changed_symbols(f.patch, lang_of(f.path)))[:MAX_COUNT_SYMBOLS]
        if not syms or f.path.endswith(".sql"):
            continue
        pattern = "|".join(re.escape(s) for s in syms)
        p = sh(["grep", "-rnwIHE", *CALLER_INCLUDES, *CALLER_EXCLUDE_DIRS, "-e", pattern, f.path.split("/")[0]],
               wt, check=False)
        out[f.path] = sum(1 for line in p.stdout.splitlines()
                          if not line.startswith(f.path + ":") and not _is_test_path(line.split(":", 1)[0]))
    return out


SQL_TEST_DIR = "server/channels/store/sqlstore"  # Go store tests exercise the migrations
GO_TEST = re.compile(r"^func (Test(?:[A-Z_0-9]\w*)?)\((?:\w+ )?\*(?:\w+\.)?T\)")


def target_entry(d: str, lang: str, mode_tag: str, sample: Path | None = None) -> dict[str, str]:
    if lang == "go":
        m = re.search(r"^package (\w+)", read_text_lossy(sample), re.M) if sample else None
        return {"lang": "go", "dir": d, "path": f"{d}/hunt_hunt{mode_tag}_test.go", "package": m.group(1) if m else "?"}
    return {"lang": "jest", "dir": d, "path": f"{d}/hunt_{mode_tag}.test.tsx"}


def test_targets(wt: Path, files: list[str]) -> list[dict[str, str]]:
    """Where hunters must write their tests: one file per Go package dir / webapp component dir. A .sql migration has
    no test directory of its own: its tests go to the sqlstore package, when this checkout has one."""
    out, seen = [], set()
    for f in files:
        d = str(Path(f).parent)
        if f.endswith(".sql"):
            store_dir = wt / SQL_TEST_DIR
            gofiles = [
                p for p in (sorted(store_dir.glob("*.go")) if store_dir.is_dir() else [])
                if not p.name.endswith("_test.go")
                and not re.search(r"^//(?:go:build\s+ignore\b|\s*\+build\s+ignore\b)", read_text_lossy(p), re.M)
            ]
            pick = [p for p in gofiles if not re.search(r"^package main\b", read_text_lossy(p), re.M)] or gofiles
            if not pick:
                continue
            d, f = SQL_TEST_DIR, str(pick[0].relative_to(wt))
        if d in seen:
            continue
        seen.add(d)
        out.append(target_entry(d, "go" if f.endswith(".go") else "jest", "<mode>", wt / f))
    return out


def go_code(line: str) -> str:
    """One Go line without its trailing // comment (string, raw-string and rune literals respected), right-stripped."""
    return code_only(line, "go", keep_strings=True)[0].rstrip()


def go_bodies(src: str) -> dict[str, str]:
    lines = src.split("\n")
    return {name: "\n".join(lines[a - 1:b]) for name, a, b in top_blocks(lines, "go")}


def changed_go_tests(patch: str, head_src: str) -> list[str]:
    """Top-level Test functions that contain an added or removed line (new tests and edited bodies alike)."""
    lines = head_src.split("\n")
    decls: list[tuple[int, int, str]] = []
    for _, a, b in top_blocks(lines, "go"):
        sig = re.sub(r"\s+", " ", "\n".join(code_lines(lines[a - 1:b], "go")).split("{", 1)[0]).strip()
        sig = re.sub(r",?\s*\)", ")", re.sub(r"\(\s+", "(", sig))
        if m := GO_TEST.match(sig):
            decls.append((a, b, m.group(1)))
    touched = changed_lines(patch)
    return sorted({name for t in touched for start, end, name in decls if start <= t <= end})


def changed_test_files(repo: Path, mb: str, head: str, dirs: set[str] | None = None, *, skip_hunt: bool = True) -> list[str]:
    return [
        f for f in git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", mb, head).splitlines()
        if (dirs is None or str(Path(f).parent) in dirs)
        and not (skip_hunt and Path(f).name.startswith("hunt_"))
        and (f.endswith("_test.go") or re.search(r"\.test\.[jt]sx?$", f))
    ]


def own_tests(repo: Path, mb: str, head: str, dirs: set[str]) -> dict[str, Any]:
    """Tests the PR itself adds or changes in the hunted dirs: Go test names, Jest file paths."""
    names: list[str] = []
    by_dir: dict[str, set[str]] = {}
    jest: list[str] = []
    for f in changed_test_files(repo, mb, head, dirs, skip_hunt=False):
        if f.endswith("_test.go"):
            found = changed_go_tests(git(repo, "diff", mb, head, "--", f), git(repo, "show", f"{head}:{f}"))
            names += found
            if found:
                by_dir.setdefault(str(Path(f).parent), set()).update(found)
        else:
            jest.append(f)
    return {"go": sorted(set(names)), "go_by_dir": {d: sorted(v) for d, v in sorted(by_dir.items())},
            "jest": sorted(jest)}


MAX_PR_TEST_LINES = 400


def pr_tests_diff(repo: Path, mb: str, head: str, dirs: set[str]) -> list[dict[str, str]]:
    """What the PR's own tests in the hunted dirs add or change: Mode A lifts their literal examples into properties.
    Added lines only, with their head line numbers, capped at MAX_PR_TEST_LINES in all."""
    out = []
    budget = MAX_PR_TEST_LINES
    for f in changed_test_files(repo, mb, head, dirs):
        if budget <= 0:
            break
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
# log, old verdicts), so a new context removes them; prepare.json and whole-PR artifacts stay across batch switches.
STALE = ("A", "B", "D", "A2", "M", "M2", "R_*", "run_A*", "run_B*", "run_D*", "base_A*", "base_B*", "base_D*",
         "fix_A*", "fix_B*", "fix_D*",
         "mutants_*", "compile_A*", "compile_B*", "compile_D*", "fuzz_*", "diff_*", "ctx.json", "state.json", "skipped.log",
         # driver outputs: a new batch or head must be vetted again, never reuse the last run's decisions
         "V", "V.*", "V_*", "run_V*", "base_V*", "vet", "vet.*", "vet_*", "vetted.json", "verdict.json", "findings.json", "audit.md", "hunt_done.json")
WHOLE_PR_STALE = ("old_tests.json", "old_tests.messages.json", "pr_tests.json", "pr_tests.messages.json",
                  "R", "run_R*", "base_R*", "fix_R*", "compile_R*", "review_verdicts.json", "batches")


_BATCH_OUTPUTS = ("A/response.json", "B/response.json", "D/response.json", "A2/response.json",
                  "run_A*.json", "run_B*.json", "diff_*.json", "mutants_*.json")


def archive_batch(hdir: Path, batch_num: int) -> Path:
    """Move completed batch-specific outputs into batches/batch_<N>/ so multi-batch hunts keep every batch's artifacts.
    No-op when the active batch has no hunter outputs, and never overwrites an existing completed archive."""
    dst = hdir / "batches" / f"batch_{batch_num}"
    has_outputs = any(p for pat in _BATCH_OUTPUTS for p in hdir.glob(pat))
    if not has_outputs:
        return dst
    n = 1
    while dst.exists():
        n += 1
        dst = hdir / "batches" / f"batch_{batch_num}.{n}"
    dst.mkdir(parents=True, exist_ok=True)
    for pattern in STALE:
        for p in sorted(hdir.glob(pattern)):
            shutil.move(str(p), str(dst / p.name))
    order_path = dst.parent / "order.json"
    raw_order = read_optional_json(order_path)
    order = [str(x) for x in raw_order if str(x) != dst.name] if isinstance(raw_order, list) else []
    order.append(dst.name)
    write_json(order_path, order)
    return dst


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


def code_only(line: str, lang: str, open_quote: str = "", *, keep_strings: bool = False) -> tuple[str, str]:
    """(code, quote still open at the end) for one Go or JS/TS line: string, rune, template-literal and JS regex
    contents and any `//` comment removed, so braces and `//` inside them don't count as code. `open_quote` carries a
    Go raw string or JS template literal across lines. Go raw strings have no escapes; JS template literals do. JSX
    text containing an apostrophe is not recognised (rare: only matters when a `{...}` then spans lines)."""
    out: list[str] = []
    quote = open_quote
    i = 0
    while i < len(line):
        c = line[i]
        if quote == "/*":
            end = line.find("*/", i)
            if end < 0:
                break
            quote = ""
            out.append(" ")
            i = end + 2
            continue
        if quote:
            if keep_strings:
                out.append(c)
            if c == "\\" and not (quote == "`" and lang == "go"):
                i += 1
                if keep_strings and i < len(line):
                    out.append(line[i])
            elif c == quote:
                quote = ""
                if not keep_strings:
                    out.append(c)
        elif c in "\"'`":
            quote = c
            out.append(c)
        elif line.startswith("//", i):
            break
        elif line.startswith("/*", i):
            quote = "/*"
            i += 2
            continue
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
    scan = code_lines(lines, "go") if lang == "go" else lines
    cands: list[tuple[int, str, bool]] = []  # (0-based line, name, is a `func`/`function` declaration)
    for i, line in enumerate(scan):
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


FORCE_ALL_RULES = ("R01", "R02")  # reliability invariants (guest isolation, team/channel boundaries): never hunt a subset


def forced_all_batches(diffs: list[prefilter.FileDiff], deleted: list[str]) -> list[str]:
    """Ids of the RELIABILITY rules in FORCE_ALL_RULES that the whole PR triggers. Rules unreadable from the trusted
    ref count as no hit here: run.py/build_requests.py read the same file and fail closed on their own."""
    try:
        rules = reliability.load()
    except InfraError:
        return []
    mctx = {"all_changed_files": [f.path for f in diffs] + deleted,
            "diff_production_code": "\n".join(f.patch for f in diffs if f.patch),
            "changed_files_head_source": []}
    return [r.id for r in reliability.match(mctx, rules) if r.id in FORCE_ALL_RULES]


def build(pr: str, batch: int, prep: dict[str, Any], meta: dict[str, Any], *, all_batches: bool = False,
          first_batch: bool = False) -> dict[str, Any]:
    repo, wt, mb, head = Path(prep["repo"]), Path(prep["wt"]), prep["merge_base"], prep["head"]
    diffs = file_diffs(repo, mb, head)
    has_huntable = False
    for f in diffs:
        if not prefilter.excluded(f.path):
            f.patch = git(repo, "diff", mb, head, "--", f.path)
            has_huntable = True
    plan = prefilter.plan(diffs, callers=caller_counts(wt, diffs) if has_huntable else {})
    deleted = git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=D", mb, head).splitlines()
    plan.skipped += [(path, "deleted") for path in deleted]
    forced = forced_all_batches(diffs, deleted) if first_batch and len(plan.batches) > 1 else []
    hdir = Path(prep.get("hunt_dir") or hunt_dir(pr))
    hdir.mkdir(parents=True, exist_ok=True)
    prev_state_path = hdir / "state.json"
    prev = read_optional_dict(prev_state_path) if prev_state_path.exists() else {}
    head_changed = prev.get("head") != head
    if not plan.batches:
        reset_hunt_dir(hdir, include_whole_pr=head_changed)
        (hdir / "skipped.log").write_text("\n".join(prefilter.describe(plan, batch)) + "\n")
        state: dict[str, Any] = {
            "pr": pr, "batch": 0, "batches": 0, "skipped_diff": True,
            "repo": str(repo), "wt": str(wt), "wt_base": prep["wt_base"],
            "merge_base": mb, "head": head, "changed": [], "targets": [],
        }
        write_json(hdir / "state.json", state)
        return state
    if not 1 <= batch <= len(plan.batches):
        raise InfraError(f"batch {batch} requested; batches are 1..{len(plan.batches)}")
    if not head_changed and prev.get("head") == head:
        prev_batch = prev.get("batch")
        all_batches = all_batches or (bool(prev.get("all_batches")) and not first_batch)
        if not forced and not first_batch and isinstance(prev.get("forced_all_batches"), list):
            forced = [str(r) for r in prev["forced_all_batches"]]
        if isinstance(prev_batch, int) and prev_batch != batch:
            archive_batch(hdir, prev_batch)
    all_batches = all_batches or bool(forced)
    reset_hunt_dir(hdir, include_whole_pr=head_changed)
    (hdir / "skipped.log").write_text("\n".join(prefilter.describe(plan, batch)) + "\n")
    chosen = plan.batches[batch - 1]
    files = [f.path for f in chosen]
    patches = {f.path: f.patch for f in chosen}  # whole patch: a long diff is a batch of its own, never cut
    syms: set[str] = set()
    for f in chosen:
        syms |= changed_symbols(f.patch, lang_of(f.path))
    targets = test_targets(wt, files)
    all_changed = sorted({f.path for f in diffs} | set(deleted))
    pr_info: dict[str, Any] = {"number": int(pr) if str(pr).isdigit() else 0,
                               "title": meta.get("title", ""), "description": meta.get("body") or ""}
    if prep.get("range"):
        pr_info["range"] = f"{prep['range'][0]}...{prep['range'][1]}"
    src_needs = {f: max(1, min(MAX_SOURCE_LINES, len((wt / f).read_text(errors="replace").splitlines()))) for f in files}
    src_alloc = _allocate_budgets(src_needs, MAX_SOURCE_LINES * 2) if files else {}
    ctx: dict[str, Any] = {
        "pr": pr_info,
        "diff_production_code": "\n".join(request_patch(patches[f]) for f in files),
        "changed_files_head_source": [
            {"file": f, "source": source_view(wt, f, patches[f], max_lines=src_alloc.get(f, MAX_SOURCE_LINES))}
            for f in files
        ],
        "sibling_tests_and_helpers": sibling_tests(wt, files, syms),
        "callers": callers(wt, files, syms),
        "your_test_files": targets,
        # every changed path, hunted, skipped or deleted, so path-triggered rules (e.g. SQL migrations) still apply
        "all_changed_files": all_changed,
        "pr_tests_diff": pr_tests_diff(repo, mb, head, {t["dir"] for t in targets}),
    }
    ctx["neighbors_same_file"], ctx["changed_functions_base_source"] = neighbours_and_base(
        wt, Path(prep["wt_base"]), files, {f.path: f.patch for f in chosen}, set(all_changed))
    state = {"pr": pr, "batch": batch, "batches": len(plan.batches), "all_batches": all_batches,
             "forced_all_batches": forced,
             "batch_plan": [[f.path for f in b] for b in plan.batches],
             "repo": str(repo), "wt": str(wt), "wt_base": prep["wt_base"], "merge_base": mb, "head": head,
             "changed": files, "targets": targets, "own_tests": own_tests(repo, mb, head, {t["dir"] for t in targets})}
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
    grp = ap.add_mutually_exclusive_group()
    grp.add_argument("--batch", type=int, default=None)
    grp.add_argument("--all-batches", action="store_true",
                     help="hunt every batch, riskiest first (the default; kept for old callers): build batch 1 and "
                          "print all batches (subsequent --batch N calls archive prior batches)")
    grp.add_argument("--first-batch", action="store_true",
                     help="hunt only the riskiest batch, as before the all-batches default; a PR that triggers R01/R02 "
                          "still hunts every batch")
    a = ap.parse_args()
    batch = 1 if a.batch is None else a.batch
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
        st = build(a.pr, batch, prep, meta, all_batches=not a.first_batch, first_batch=a.first_batch)
    if st["batches"] == 0:
        print("skip: prefilter left no source files to hunt (see skipped.log)")
        return
    ctx = json.loads((hunt_dir(a.pr) / "ctx.json").read_text())
    print(f"batch {st['batch']}/{st['batches']}: {len(st['changed'])} files, {len(ctx['callers'])} caller excerpts, "
          f"{len(ctx['sibling_tests_and_helpers'])} sibling test files, {len(ctx['neighbors_same_file'])} neighbour and "
          f"{len(ctx['changed_functions_base_source'])} merge-base functions; skipped.log has the rest")
    if st["forced_all_batches"]:
        print(f"all batches forced by reliability rule(s) {', '.join(st['forced_all_batches'])}")
    if st["all_batches"] and st["batches"] > 1:
        print(f"all-batches plan ({st['batches']} batches; run --batch 2..{st['batches']} after batch 1):")
        for idx, bfiles in enumerate(st["batch_plan"], 1):
            print(f"  batch {idx}: {', '.join(bfiles)}")


if __name__ == "__main__":
    try:
        main()
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
