#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Mine more clean controls for eval_reverts.py: size-matched commits that were never reverted. Prints a summary; writes
only --out.

usage: mine_controls.py <repo> <manifest.json> --per-case N --out eval/controls_extra.json

Rule (the manifest's "_about"), applied to every case's bug_sha, on the history reachable from the repo's HEAD:
  - a non-merge commit committed within 90 days of the case, that changes a non-test source file (prefilter.excluded,
    as the hunt itself counts them) under the case's `area`;
  - with 0.5x to 2x the case's non-test source files AND changed lines (whole commit, not only the area);
  - never reverted: no commit in any ref says `This reverts commit <sha>` or `Revert "<subject>"`, and it is not itself
    a revert;
  - sharing no MM-<n> ticket with the case (its commit message or its revert's);
  - not a case's bug or fix commit, not one of the manifest's controls, not picked for another case.
Closest size first (|ln files ratio| + |ln lines ratio|), then closest in time, then sha: deterministic. Output is
{"controls": [{"id", "area", "sha", "matches"}]}, the shape of the manifest's controls, which eval_reverts.py --controls
appends. A case with fewer than N matches gets what exists; the summary names it.
"""
from __future__ import annotations

import atexit as _atexit
import shutil as _shutil
import sys as _sys
import tempfile as _tempfile

# Never load bytecode from the skill directory (see eval_reverts.py): caches go to a private temp dir.
if not _sys.pycache_prefix:
    _sys.pycache_prefix = _tempfile.mkdtemp(prefix="hunt-pyc-")
    _atexit.register(_shutil.rmtree, _sys.pycache_prefix, True)

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import prefilter
from hunt_common import git, write_json

WINDOW_DAYS = 90
LOW, HIGH = 0.5, 2.0
TICKET = re.compile(r"\bMM-\d+\b", re.IGNORECASE)
CHUNK = 100  # commits per `git show`
ABOUT = ("Extra size-matched clean controls from mine_controls.py: per case, non-merge commits within 90 days in the same "
         "directory with 0.5x-2x its non-test source files and changed lines, never reverted, sharing no MM- ticket with it.")


@dataclass
class Commit:
    sha: str
    ts: int
    message: str
    files: dict[str, int]  # non-test source path -> changed lines

    @property
    def lines(self) -> int:
        return sum(self.files.values())

    @property
    def tickets(self) -> set[str]:
        return {t.upper() for t in TICKET.findall(self.message)}

    @property
    def subject(self) -> str:
        return self.message.split("\n", 1)[0].strip()


def read_commits(repo: Path, shas: list[str]) -> dict[str, Commit]:
    out: dict[str, Commit] = {}
    for i in range(0, len(shas), CHUNK):
        raw = git(repo, "show", "--no-walk=unsorted", "--no-renames", "--numstat", "--format=%x01%H%x00%ct%x00%B%x02",
                  *shas[i:i + CHUNK])
        for chunk in raw.split("\x01")[1:]:
            head, _, stat = chunk.partition("\x02")
            sha, ts, message = head.split("\x00", 2)
            files: dict[str, int] = {}
            for line in stat.strip().splitlines():
                added, removed, path = line.split("\t", 2)
                if prefilter.excluded(path) is None:
                    files[path] = (int(added) if added.isdigit() else 0) + (int(removed) if removed.isdigit() else 0)
            out[sha] = Commit(sha, int(ts), message.strip(), files)
    return out


def reverted(repo: Path, c: Commit) -> bool:
    """Some commit in any ref reverts c, by git's "This reverts commit <sha>" or by the `Revert "<subject>"` title."""
    for pattern in (f"This reverts commit {c.sha}", f'Revert "{c.subject}"'):
        if git(repo, "log", "--all", "-n1", "--format=%H", "-F", f"--grep={pattern}"):
            return True
    return False


def is_revert(c: Commit) -> bool:
    return c.subject.startswith('Revert "') or "This reverts commit" in c.message


def ratio_ok(n: float, case: float) -> bool:
    return case > 0 and LOW <= n / case <= HIGH


def candidates(repo: Path, case: Commit, area: str) -> list[Commit]:
    lo = datetime.fromtimestamp(case.ts, timezone.utc) - timedelta(days=WINDOW_DAYS)
    hi = datetime.fromtimestamp(case.ts, timezone.utc) + timedelta(days=WINDOW_DAYS)
    log = git(repo, "log", "--no-merges", f"--after={lo.isoformat()}", f"--before={hi.isoformat()}", "--format=%H", "HEAD",
              "--", area)
    commits = read_commits(repo, log.split())
    keep = [c for c in commits.values()
            if abs(c.ts - case.ts) <= WINDOW_DAYS * 86400 and any(p.startswith(area.rstrip("/") + "/") for p in c.files)
            and ratio_ok(len(c.files), len(case.files)) and ratio_ok(c.lines, case.lines)]

    def key(c: Commit) -> tuple[float, int, str]:
        dist = abs(math.log(len(c.files) / len(case.files))) + abs(math.log(c.lines / case.lines))
        return (round(dist, 9), abs(c.ts - case.ts), c.sha)

    return sorted(keep, key=key)


def mine(repo: Path, manifest: dict[str, Any], per_case: int) -> tuple[list[dict[str, str]], dict[str, int]]:
    cases = manifest["cases"]
    taken = {git(repo, "rev-parse", f"{e[k]}^{{commit}}") for e in cases for k in ("bug_sha", "fix_sha")}
    taken |= {git(repo, "rev-parse", f"{e['sha']}^{{commit}}") for e in manifest.get("controls") or []}
    used_ids = {e["id"] for e in cases + (manifest.get("controls") or [])}
    picked: list[dict[str, str]] = []
    filled: dict[str, int] = {}
    for case in cases:
        bug = git(repo, "rev-parse", f"{case['bug_sha']}^{{commit}}")
        fix = git(repo, "rev-parse", f"{case['fix_sha']}^{{commit}}")
        c = read_commits(repo, [bug])[bug]
        tickets = c.tickets | {t.upper() for t in TICKET.findall(git(repo, "log", "-1", "--format=%B", fix))}
        got = 0
        for cand in candidates(repo, c, case["area"]) if c.files and c.lines else []:
            if got == per_case:
                break
            if cand.sha in taken or is_revert(cand) or cand.tickets & tickets or reverted(repo, cand):
                continue
            got += 1
            taken.add(cand.sha)
            cid = f"{case['id']}-ctl{got}"
            if cid in used_ids:
                raise ValueError(f"control id {cid} already exists in the manifest")
            picked.append({"id": cid, "area": case["area"], "sha": cand.sha, "matches": case["id"]})
        filled[case["id"]] = got
    return picked, filled


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="mine_controls.py", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("repo", type=Path)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("--per-case", type=int, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv[1:])
    if a.per_case < 1:
        print("--per-case must be at least 1")
        return 2
    picked, filled = mine(a.repo.resolve(), json.loads(a.manifest.read_text()), a.per_case)
    write_json(a.out, {"_about": ABOUT, "per_case": a.per_case, "filled": filled, "controls": picked})
    short = {k: v for k, v in filled.items() if v < a.per_case}
    for case_id, n in filled.items():
        print(f"{case_id}: {n}/{a.per_case}")
    print(f"{len(picked)} controls -> {a.out}" + (f"; short: {', '.join(f'{k} ({v})' for k, v in short.items())}" if short else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
