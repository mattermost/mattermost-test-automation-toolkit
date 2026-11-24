#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Diff-triggered Mattermost invariants from RELIABILITY.md (read from the trusted base ref).

usage: reliability.py match <ctx.json>   print the rules this context triggers
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

import fnmatch
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import trusted

HEADER = re.compile(r"^## (R\d+) (.+)$")
FIELDS = ("paths", "diff", "invariant", "probe")
OPT_FIELDS = ("lang",)
LANG_EXTS: dict[str, tuple[str, ...]] = {
    "go": (".go",),
    "jest": (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"),
}
_DIFF_GIT = re.compile(r'^diff --git (?:"a/[^"]+"|a/\S+) (?:"b/([^"]+)"|b/(.+))$')


@dataclass
class Rule:
    id: str
    title: str
    paths: list[str]
    diff: re.Pattern[str]
    invariant: str
    probe: str
    langs: tuple[str, ...] = ()


def parse(text: str) -> list[Rule]:
    rules: list[Rule] = []
    cur: dict[str, str] = {}

    def flush() -> None:
        if not cur:
            return
        missing = [f for f in FIELDS if not cur.get(f)]
        if missing:
            raise ValueError(f"RELIABILITY.md {cur['id']}: missing {missing}")
        raw_langs = [x.strip().lower() for x in cur.get("lang", "").split(",") if x.strip() not in ("", "-")]
        bad_langs = [x for x in raw_langs if x not in LANG_EXTS]
        if bad_langs:
            raise ValueError(f"RELIABILITY.md {cur['id']}: unknown lang {bad_langs}")
        rules.append(Rule(cur["id"], cur["title"], [g.strip() for g in cur["paths"].split(",") if g.strip() not in ("", "-")],
                          re.compile(cur["diff"], re.I), cur["invariant"], cur["probe"], tuple(raw_langs)))

    for line in text.splitlines():
        m = HEADER.match(line)
        if m:
            flush()
            cur = {"id": m.group(1), "title": m.group(2).strip()}
        elif cur and ":" in line:
            key, _, val = line.partition(":")
            if key.strip() in (*FIELDS, *OPT_FIELDS):
                cur[key.strip()] = val.strip()
    flush()
    return rules


def load() -> list[Rule]:
    return parse(trusted.read("RELIABILITY.md"))


def changed_lines(diff: str) -> str:
    return "\n".join(line[1:] for line in diff.splitlines()
                     if line[:1] in "+-" and not line.startswith(("+++", "---")))


def _file_lang(path: str) -> str | None:
    low = path.lower()
    for lang, exts in LANG_EXTS.items():
        if low.endswith(exts):
            return lang
    return None


def _diff_path(raw: str) -> str:
    p = raw.strip().split("\t", 1)[0]
    if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
        p = p[1:-1]
    return p[2:] if p.startswith(("a/", "b/")) else p


def _changed_lines_by_lang(diff: str) -> dict[str, str]:
    by_lang: dict[str, list[str]] = {}
    cur = ""  # "" = unscoped synthetic diff without file headers
    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            m = _DIFF_GIT.match(line)
            path = (m.group(1) or m.group(2)) if m else ""
            cur = (_file_lang(path) or "other") if path else "other"
        elif line.startswith("@@ "):
            in_hunk = True
        elif not in_hunk and line.startswith("--- "):
            raw = line[4:]
            cur = "other" if raw.strip() == "/dev/null" else (_file_lang(_diff_path(raw)) or "other")
        elif not in_hunk and line.startswith("+++ "):
            raw = line[4:]
            if raw.strip() != "/dev/null":
                cur = _file_lang(_diff_path(raw)) or "other"
        elif line[:1] in "+-" and (in_hunk or not line.startswith(("+++", "---"))):
            by_lang.setdefault(cur, []).append(line[1:])
    return {k: "\n".join(v) for k, v in by_lang.items()}


def _glob(path: str, pattern: str) -> bool:
    # '**' crosses directories; fnmatch's '*' already does, so '**/' only has to allow zero directories too.
    return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, pattern.replace("**/", ""))


def match(ctx: dict[str, Any], rules: list[Rule] | None = None) -> list[Rule]:
    rules = load() if rules is None else rules
    source_files = [c["file"] for c in ctx.get("changed_files_head_source", [])]
    all_files = source_files + list(ctx.get("all_changed_files", []))
    batch_langs = {lang for f in source_files if (lang := _file_lang(f))}
    diff = ctx.get("diff_production_code", "")
    all_lines = changed_lines(diff)
    by_lang = _changed_lines_by_lang(diff)
    out: list[Rule] = []
    for r in rules:
        if r.langs:
            if not any(lang in batch_langs for lang in r.langs):
                continue
            path_files = [f for f in all_files if _file_lang(f) in r.langs]
            lines = "\n".join(by_lang[k] for k in (*r.langs, "") if k in by_lang)
        else:
            path_files = all_files
            lines = all_lines
        if any(_glob(f, g) for f in path_files for g in r.paths) or r.diff.search(lines):
            out.append(r)
    return out


def render(matched: list[Rule]) -> str:
    if not matched:
        return ""
    rows = "\n".join(f"- {r.id} {r.title}: {r.invariant} Probe: {r.probe}" for r in matched)
    return ("\nMattermost reliability invariants triggered by this diff. Test those applicable to the changed code "
            "(cite the rule ID plus the diff/caller/neighbour file:line):\n" + rows + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "match":
        sys.exit(__doc__)
    for r in match(json.loads(Path(sys.argv[2]).read_text())):
        print(f"{r.id} {r.title}")
