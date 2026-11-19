#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Append-only log of vetted false-positive patterns, matched into future hunter prompts.

usage: lessons.py add '<json>'          append one lesson (validated; existing lines are never rewritten)
       lessons.py match <ctx.json>      print the top 5 lessons for this context
       lessons.py prune [--window 30] [--write]
                                        list lessons to retire: no match in the last 30 logged hunts, or globs so broad
                                        they match whole top-level trees; --write appends a retirement line for each
Only add a lesson after a failure was root-caused to the pattern with a diagnostic run. Retirements are append-only
lines too ({"retire": "L002", "reason": ...}); like any lesson change they apply once they land on the base branch.
build_requests.py appends one line per hunt to $HUNT_SCRATCH/lessons_hits.jsonl ({"run", "matched"}), which prune reads.
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
import fnmatch
import json
import re
import sys
from pathlib import Path
from typing import Any

import trusted
from hunt_common import LESSONS_FILE, scratch

REQUIRED = ("pattern", "applies_to", "keywords", "symptom", "check", "source_pr")
TOP = 5
PRUNE_WINDOW = 30


def hits_log() -> Path:
    return scratch() / "lessons_hits.jsonl"


def _records(path: Path | None) -> list[dict[str, Any]]:
    text = trusted.read(LESSONS_FILE.name) if path is None else (path.read_text() if path.exists() else "")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def load(path: Path | None = None, include_retired: bool = False) -> list[dict[str, Any]]:
    """Lessons from the trusted base ref by default; from `path` when given (adding a lesson, tests). Retired lessons
    are left out unless include_retired."""
    records = _records(path)
    retired = {r["retire"] for r in records if "retire" in r}
    return [r for r in records if "retire" not in r and (include_retired or r.get("id") not in retired)]


def add(lesson: dict[str, Any], path: Path = LESSONS_FILE) -> dict[str, Any]:
    missing = [k for k in REQUIRED if not lesson.get(k)]
    if missing:
        raise ValueError(f"lesson missing {missing}")
    if not isinstance(lesson["applies_to"].get("path_globs"), list):
        raise TypeError("applies_to.path_globs must be a list")
    existing = load(path, include_retired=True)  # the working copy being appended to; ids are never reused
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


def log_hits(run: str, matched: list[dict[str, Any]], log: Path | None = None) -> None:
    """One line per hunt: which lessons its hunters were shown. prune reads this."""
    log = log or hits_log()
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as fh:
        fh.write(json.dumps({"run": run, "matched": [m["id"] for m in matched]}) + "\n")


def overbroad(glob: str) -> bool:
    """A glob that covers a whole top-level tree (or everything): '*', '**', 'server/*', 'webapp/**/*.ts'."""
    prefix = []
    for seg in glob.split("/"):
        if re.search(r"[*?\[]", seg):
            break
        prefix.append(seg)
    return len(prefix) < 2  # fewer than two fixed directories before the first wildcard


def prune(lessons: list[dict[str, Any]], log_lines: list[dict[str, Any]], window: int = PRUNE_WINDOW) -> list[dict[str, Any]]:
    """Deterministic retirements: over-broad globs always; no match in the last `window` hunts only once the log holds
    at least `window` hunts (fewer is not evidence). A re-run of the same hunt counts once, with its latest result."""
    runs: dict[str, list[str]] = {}
    for line in log_lines:
        runs.pop(line["run"], None)  # move a re-run to the end
        runs[line["run"]] = line["matched"]
    recent = list(runs.values())[-window:]
    out = []
    for lsn in lessons:
        broad = [g for g in lsn["applies_to"].get("path_globs", []) if overbroad(g)]
        if broad:
            out.append({"retire": lsn["id"], "reason": f"over-broad path glob(s) {broad}"})
        elif len(recent) >= window and not any(lsn["id"] in m for m in recent):
            out.append({"retire": lsn["id"], "reason": f"no match in the last {window} logged hunts"})
    return out


def main(argv: list[str]) -> None:
    if argv[1:2] == ["add"]:
        print(json.dumps(add(json.loads(argv[2]))))
    elif argv[1:2] == ["match"]:
        for m in match(json.loads(Path(argv[2]).read_text())):
            print(json.dumps(m))
    elif argv[1:2] == ["prune"]:
        ap = argparse.ArgumentParser(prog="lessons.py prune")
        ap.add_argument("--window", type=int, default=PRUNE_WINDOW)
        ap.add_argument("--write", action="store_true", help="append the retirements to the working copy of lessons.jsonl")
        a = ap.parse_args(argv[2:])
        log = hits_log()
        lines = [json.loads(x) for x in log.read_text().splitlines() if x.strip()] if log.exists() else []
        retire = prune(load(), lines, a.window)  # judged against the trusted lessons
        for r in retire:
            print(json.dumps(r))
        if a.write and retire:
            already = {r["retire"] for r in _records(LESSONS_FILE) if "retire" in r}
            with LESSONS_FILE.open("a") as fh:
                for r in retire:
                    if r["retire"] not in already:
                        fh.write(json.dumps(r) + "\n")
        print(f"{len(retire)} to retire; {len({k for x in lines for k in [x['run']]})} hunts logged in {log}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
