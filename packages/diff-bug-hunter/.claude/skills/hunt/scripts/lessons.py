#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Append-only log of vetted false-positive patterns, matched into future hunter prompts.

usage: lessons.py add '<json>'          append one lesson (validated; existing lines are never rewritten)
       lessons.py match <ctx.json>      print the top 5 lessons for this context
Only add a lesson after a failure was root-caused to the pattern with a diagnostic run.
"""
from __future__ import annotations

import fnmatch
import json
import sys
from pathlib import Path
from typing import Any

from hunt_common import LESSONS_FILE

REQUIRED = ("pattern", "applies_to", "keywords", "symptom", "check", "source_pr")
TOP = 5


def load(path: Path = LESSONS_FILE) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def add(lesson: dict[str, Any], path: Path = LESSONS_FILE) -> dict[str, Any]:
    missing = [k for k in REQUIRED if not lesson.get(k)]
    if missing:
        raise ValueError(f"lesson missing {missing}")
    if not isinstance(lesson["applies_to"].get("path_globs"), list):
        raise TypeError("applies_to.path_globs must be a list")
    existing = load(path)
    if any(e["pattern"] == lesson["pattern"] for e in existing):
        raise ValueError(f"duplicate pattern: {lesson['pattern']}")
    lesson = {"id": f"L{len(existing) + 1:03d}", **{k: v for k, v in lesson.items() if k != "id"}}
    with path.open("a") as fh:
        fh.write(json.dumps(lesson) + "\n")
    return lesson


def score(lesson: dict[str, Any], files: list[str], text: str) -> int:
    globs = lesson["applies_to"].get("path_globs", [])
    langs = set(lesson["applies_to"].get("lang", []))
    file_langs = {"go" if f.endswith(".go") else "jest" for f in files}
    if langs and not langs & file_langs:
        return 0
    path_hits = sum(1 for f in files if any(fnmatch.fnmatch(f, g) for g in globs))
    kw_hits = sum(1 for k in lesson["keywords"] if k.lower() in text)
    return 3 * path_hits + kw_hits if (path_hits or kw_hits) else 0


def match(ctx: dict[str, Any], lessons: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    lessons = load() if lessons is None else lessons
    files = [c["file"] for c in ctx.get("changed_files_head_source", [])]
    text = (ctx.get("diff_production_code", "") + json.dumps(ctx.get("sibling_tests_and_helpers", []))).lower()
    ranked = sorted(((score(lsn, files, text), i, lsn) for i, lsn in enumerate(lessons)), key=lambda t: (-t[0], t[1]))
    return [lsn for s, _, lsn in ranked if s > 0][:TOP]


def render(matched: list[dict[str, Any]]) -> str:
    if not matched:
        return ""
    rows = "\n".join(f"- {m['pattern']}: {m['symptom']} Avoid it: {m['check']}" for m in matched)
    return ("\nKnown false-positive patterns from earlier hunts. Do not write tests that fail only because of these:\n"
            + rows + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "add":
        print(json.dumps(add(json.loads(sys.argv[2]))))
    elif sys.argv[1] == "match":
        for m in match(json.loads(Path(sys.argv[2]).read_text())):
            print(json.dumps(m))
    else:
        sys.exit(__doc__)
