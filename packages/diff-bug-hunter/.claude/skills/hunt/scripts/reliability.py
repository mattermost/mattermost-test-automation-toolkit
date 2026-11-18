#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Diff-triggered Mattermost invariants from RELIABILITY.md (read from the trusted base ref).

usage: reliability.py match <ctx.json>   print the rules this context triggers
"""
from __future__ import annotations

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


@dataclass
class Rule:
    id: str
    title: str
    paths: list[str]
    diff: re.Pattern[str]
    invariant: str
    probe: str


def parse(text: str) -> list[Rule]:
    rules: list[Rule] = []
    cur: dict[str, str] = {}

    def flush() -> None:
        if not cur:
            return
        missing = [f for f in FIELDS if not cur.get(f)]
        if missing:
            raise ValueError(f"RELIABILITY.md {cur['id']}: missing {missing}")
        rules.append(Rule(cur["id"], cur["title"], [g.strip() for g in cur["paths"].split(",") if g.strip() not in ("", "-")],
                          re.compile(cur["diff"], re.I), cur["invariant"], cur["probe"]))

    for line in text.splitlines():
        m = HEADER.match(line)
        if m:
            flush()
            cur = {"id": m.group(1), "title": m.group(2).strip()}
        elif cur and ":" in line:
            key, _, val = line.partition(":")
            if key.strip() in FIELDS:
                cur[key.strip()] = val.strip()
    flush()
    return rules


def load() -> list[Rule]:
    return parse(trusted.read("RELIABILITY.md"))


def changed_lines(diff: str) -> str:
    return "\n".join(line[1:] for line in diff.splitlines()
                     if line[:1] in "+-" and not line.startswith(("+++", "---")))


def _glob(path: str, pattern: str) -> bool:
    # '**' crosses directories; fnmatch's '*' already does, so '**/' only has to allow zero directories too.
    return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, pattern.replace("**/", ""))


def match(ctx: dict[str, Any], rules: list[Rule] | None = None) -> list[Rule]:
    rules = load() if rules is None else rules
    files = [c["file"] for c in ctx.get("changed_files_head_source", [])]
    lines = changed_lines(ctx.get("diff_production_code", ""))
    return [r for r in rules if any(_glob(f, g) for f in files for g in r.paths) or r.diff.search(lines)]


def render(matched: list[Rule]) -> str:
    if not matched:
        return ""
    rows = "\n".join(f"- {r.id} {r.title}: {r.invariant} Probe: {r.probe}" for r in matched)
    return ("\nMattermost reliability invariants triggered by this diff. Test those the callers confirm "
            "(each still needs 3 caller citations):\n" + rows + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "match":
        sys.exit(__doc__)
    for r in match(json.loads(Path(sys.argv[2]).read_text())):
        print(f"{r.id} {r.title}")
