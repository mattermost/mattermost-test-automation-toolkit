#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Append-only log of vetted false-positive patterns, matched into future hunter prompts.

usage: lessons.py add '<json>'          append one lesson (validated; existing lines are never rewritten)
       lessons.py filter <hunt_dir>     list failing tests a lesson's failure_regex explains (they move to HELD)
       lessons.py probes <diff.patch>   print the "miss" lessons that apply to this diff (probes for hunters)
       lessons.py match <ctx.json>      print the top 5 lessons for this context
       lessons.py prune [--window 30] [--write] [--repo ROOT]
                                        list lessons to retire: no match in the last 30 logged hunts, or globs so broad
                                        they match whole top-level trees; --write appends a retirement line for each
Only add a lesson after a failure was root-caused to the pattern with a diagnostic run. Retirements are append-only
lines too ({"retire": "L002", "reason": ...}); like any lesson change they apply once they land on the base branch.
build_requests.py appends one line per hunt to $HUNT_SCRATCH/lessons_hits.jsonl ({"run", "matched"}), which prune reads.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import argparse
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import trusted
from hunt_common import LESSONS_FILE, scratch

REQUIRED = ("pattern", "applies_to", "keywords", "symptom", "check", "source_pr")
TOP = 5
PRUNE_WINDOW = 30
KINDS = ("fp", "miss")


def kind_of(lesson: dict[str, Any]) -> str:
    """Rows written before kinds existed are false-positive lessons."""
    return lesson.get("kind", "fp")


def _append_line(path: Path, record: dict[str, Any], unique_pattern: bool = False) -> None:
    """Append one JSON line under an exclusive flock so parallel sessions never interleave or race a duplicate check."""
    with path.open("a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            if unique_pattern:
                fh.seek(0)
                for line in fh.read().splitlines():
                    if line.strip() and json.loads(line).get("pattern") == record["pattern"]:
                        raise ValueError(f"duplicate pattern: {record['pattern']}")
            fh.seek(0, os.SEEK_END)
            fh.write(json.dumps(record) + "\n")
            fh.flush()
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def hits_log() -> Path:
    env = os.environ.get("HUNT_LESSONS_HITS", "").strip()
    return Path(env).resolve() if env else scratch() / "lessons_hits.jsonl"


def _records(path: Path | None) -> list[dict[str, Any]]:
    text = trusted.read(LESSONS_FILE.name) if path is None else (path.read_text() if path.exists() else "")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def load(path: Path | None = None, include_retired: bool = False) -> list[dict[str, Any]]:
    """Lessons from the trusted base ref by default; from `path` when given (adding a lesson, tests). Retired lessons
    are left out unless include_retired."""
    records = _records(path)
    retired = {r["retire"] for r in records if "retire" in r}
    return [r for r in records if "retire" not in r and (include_retired or r.get("id") not in retired)]


def validate_candidate(lesson: dict[str, Any], base: Path | None = None) -> None:
    """A false-positive lesson must point at a fixture (path under `base`, default the lessons directory) that
    reproduces the false positive: the file exists and, when the lesson has a failure_regex, the regex matches it.
    Raises ValueError otherwise. Miss lessons need no fixture."""
    kind = kind_of(lesson)
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    regex = lesson.get("failure_regex")
    if regex:
        try:
            re.compile(regex)
        except re.error as e:
            raise ValueError(f"failure_regex does not compile: {e}") from e
    if kind != "fp":
        return
    ref = lesson.get("fixture")
    if not ref or not isinstance(ref, str):
        raise ValueError("fp lesson needs a 'fixture' path that reproduces its false positive")
    root = (base or LESSONS_FILE.parent).resolve()
    target = (root / ref).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"fixture escapes {root}: {ref}")
    if not target.is_file():
        raise ValueError(f"fixture not found: {ref}")
    if regex and not re.search(regex, target.read_text(errors="replace"), re.MULTILINE):
        raise ValueError(f"failure_regex does not match fixture {ref}: it does not reproduce the false positive")


def add(lesson: dict[str, Any], path: Path = LESSONS_FILE, fixture_base: Path | None = None,
        require_fixture: bool = False) -> dict[str, Any]:
    missing = [k for k in REQUIRED if not lesson.get(k)]
    if missing:
        raise ValueError(f"lesson missing {missing}")
    if not isinstance(lesson["applies_to"].get("path_globs"), list):
        raise TypeError("applies_to.path_globs must be a list")
    if require_fixture or "kind" in lesson or "failure_regex" in lesson:
        validate_candidate(lesson, fixture_base)
    # random ids: concurrent appenders cannot collide, and ids are never reused
    lesson = {"id": f"L-{uuid.uuid4().hex[:12]}", **{k: v for k, v in lesson.items() if k != "id"}}
    _append_line(path, lesson, unique_pattern=True)
    return lesson


def files_hash(root: Path, files: list[str]) -> str:
    """Hash of the named files' contents (a missing file hashes as absent), for retiring lessons whose code changed."""
    h = hashlib.sha256()
    for f in sorted(files):
        p = root / f
        h.update(f.encode() + b"\0" + (p.read_bytes() if p.is_file() else b"<missing>") + b"\0")
    return h.hexdigest()


def stale(lessons: list[dict[str, Any]], root: Path) -> list[dict[str, Any]]:
    """Retirements for lessons that recorded matched_files + files_hash when added and whose files now hash differently."""
    out = []
    for lsn in lessons:
        files, recorded = lsn.get("matched_files"), lsn.get("files_hash")
        if files and recorded and files_hash(root, files) != recorded:
            out.append({"retire": lsn["id"], "reason": "matched files changed since the lesson was recorded"})
    return out


def score(lesson: dict[str, Any], files: list[str], text: str) -> int:
    globs = lesson["applies_to"].get("path_globs", [])
    langs = set(lesson["applies_to"].get("lang", []))
    file_langs = {"go" if f.endswith(".go") else "jest" for f in files}
    if langs and not langs & file_langs:
        return 0
    path_hits = sum(1 for f in files if any(fnmatch.fnmatch(f, g) for g in globs))
    kw_hits = sum(1 for k in lesson["keywords"] if k.lower() in text)
    if globs and lesson.get("keywords"):
        return 3 * path_hits + kw_hits if (path_hits > 0 and kw_hits > 0) else 0
    return 3 * path_hits + kw_hits if (path_hits or kw_hits) else 0


def _top_matches(items: list[dict[str, Any]], files: list[str], text: str) -> list[dict[str, Any]]:
    ranked = sorted(((score(lsn, files, text), i, lsn) for i, lsn in enumerate(items)), key=lambda t: (-t[0], t[1]))
    return [lsn for s, _, lsn in ranked if s > 0][:TOP]


def match(ctx: dict[str, Any], lessons: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Lessons still shown to hunters as prompt text: fp lessons without a failure_regex. Those with one are applied
    after the run by post_filter; miss lessons go through probes_for."""
    items = [lsn for lsn in (load() if lessons is None else lessons) if kind_of(lsn) == "fp" and not lsn.get("failure_regex")]
    return _top_matches(items, [c["file"] for c in ctx.get("changed_files_head_source", [])],
                        ctx.get("diff_production_code", "").lower())


def _diff_files(diff: str) -> list[str]:
    return sorted({m.group(1) for m in re.finditer(r"^\+\+\+ b/(\S+)", diff, re.MULTILINE)})


def probes_for(diff: str, lessons: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Miss lessons (bugs earlier hunts failed to find) that apply to this diff, best first; fed to hunters as probes."""
    items = [lsn for lsn in (load() if lessons is None else lessons) if kind_of(lsn) == "miss"]
    return _top_matches(items, _diff_files(diff), diff.lower())


def render_probes(probes: list[dict[str, Any]]) -> str:
    if not probes:
        return ""
    rows = "\n".join(f"- {p['pattern']}: {p['symptom']} Probe: {p['check']}" for p in probes)
    return "\nBugs earlier hunts missed in similar code. Probe for them:\n" + rows + "\n"


def post_filter(hdir: Path, lessons: list[dict[str, Any]] | None = None) -> list[dict[str, str]]:
    """Failing tests whose head failure text matches an fp lesson's failure_regex, from <hdir>/run_*.messages.json.
    Returns [{test_id, lesson_id}] (first matching lesson per test) for the caller to move to HELD and log."""
    lessons = load() if lessons is None else lessons
    rules = [(lsn["id"], re.compile(lsn["failure_regex"], re.MULTILINE)) for lsn in lessons
             if kind_of(lsn) == "fp" and lsn.get("failure_regex")]
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for f in sorted(Path(hdir).glob("run_*.messages.json")):
        for test_id, msg in json.loads(f.read_text()).items():
            if test_id in seen:
                continue
            for lid, rx in rules:
                if rx.search(str(msg)):
                    seen.add(test_id)
                    out.append({"test_id": test_id, "lesson_id": lid})
                    break
    return out


def counts_line(applied: int, matched: int) -> str:
    return f"lessons applied {applied}, matched {matched}"


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


MONOREPO_ROOTS = {("server", "channels"), ("server", "public"), ("webapp", "channels"), ("webapp", "platform")}


def overbroad(glob: str) -> bool:
    """True for wildcards over top-level trees or Mattermost's 2-segment monorepo roots."""
    prefix = []
    for seg in glob.split("/"):
        if re.search(r"[*?\[]", seg):
            break
        prefix.append(seg)
    min_depth = 3 if tuple(prefix[:2]) in MONOREPO_ROOTS else 2
    return len(prefix) < min_depth


def prune(lessons: list[dict[str, Any]], log_lines: list[dict[str, Any]], window: int = PRUNE_WINDOW) -> list[dict[str, Any]]:
    """Deterministic retirements: over-broad globs always; no match in the last `window` hunts only once the log holds
    at least `window` hunts (fewer is not evidence). Multiple batches or re-runs of the same target count as one hunt."""
    runs: dict[str, list[str]] = {}
    for line in log_lines:
        key = re.sub(r"/\d+$", "", str(line["run"]))
        earlier = runs.pop(key, [])  # move a re-run or later batch of the same target to the end
        runs[key] = sorted(set(earlier) | set(line["matched"]))
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
        print(json.dumps(add(json.loads(argv[2]), require_fixture=True)))
    elif argv[1:2] == ["filter"]:
        held = post_filter(Path(argv[2]))
        for h in held:
            print(json.dumps(h))
        print(counts_line(len(held), len({h["lesson_id"] for h in held})))
    elif argv[1:2] == ["probes"]:
        for p in probes_for(Path(argv[2]).read_text()):
            print(json.dumps(p))
    elif argv[1:2] == ["match"]:
        for m in match(json.loads(Path(argv[2]).read_text())):
            print(json.dumps(m))
    elif argv[1:2] == ["prune"]:
        ap = argparse.ArgumentParser(prog="lessons.py prune")
        ap.add_argument("--window", type=int, default=PRUNE_WINDOW)
        ap.add_argument("--write", action="store_true", help="append the retirements to the working copy of lessons.jsonl")
        ap.add_argument("--repo", type=Path, help="repo root: also retire lessons whose matched_files hash changed")
        a = ap.parse_args(argv[2:])
        log = hits_log()
        lines = [json.loads(x) for x in log.read_text().splitlines() if x.strip()] if log.exists() else []
        trusted_lessons = load()  # judged against the trusted lessons
        retire = prune(trusted_lessons, lines, a.window)
        if a.repo:
            done = {r["retire"] for r in retire}
            retire += [r for r in stale(trusted_lessons, a.repo) if r["retire"] not in done]
        for r in retire:
            print(json.dumps(r))
        if a.write and retire:
            already = {r["retire"] for r in _records(LESSONS_FILE) if "retire" in r}
            for r in retire:
                if r["retire"] not in already:
                    _append_line(LESSONS_FILE, r)
        hunts_logged = len({re.sub(r"/\d+$", "", str(x["run"])) for x in lines if "run" in x})
        print(f"{len(retire)} to retire; {hunts_logged} hunts logged in {log}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
