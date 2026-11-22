#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Mine candidate RELIABILITY.md rules from a repository's reverts. Prints them; never edits any rules file.

usage: mine_rules.py <repo> [-n 30] [--min 2] [--rules RELIABILITY.md]

Reads the last N reverts: commits whose subject starts with 'Revert "' (a squash commit that merely lists a revert
made inside its own PR is not one). Each revert's changed source
files (tests, generated code and e2e specs excluded, as in prefilter.py) are grouped by directory glob, at most four
levels deep. A glob that at least --min reverts touched becomes a candidate rule. Its diff regex lists the identifiers
that the changed lines of at least --min of those reverts share. Globs touched by the same set of reverts are merged.
Output is RELIABILITY.md blocks numbered after the last rule in --rules. Their invariant and probe are marked
CANDIDATE: a person writes the real ones and lands the rule on the base branch in a reviewed PR.
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
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import prefilter
from hunt_common import SKILL_DIR, git

DEPTH = 4
TOP_TOKENS = 5
IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{4,}\b")
# words every Go or TypeScript change contains: they would match any diff
STOP = {
    "return", "const", "string", "error", "false", "import", "export", "interface", "default", "func", "struct",
    "assert", "require", "expect", "props", "state", "await", "async", "function", "value", "nolint", "nil", "true",
    "typeof", "undefined", "number", "boolean", "Error", "context", "model", "store", "client", "result", "errors",
    "fmt", "Sprintf", "Errorf", "append", "range", "break", "continue", "switch", "case", "else", "ctx", "this",
}


@dataclass
class Revert:
    sha: str
    subject: str
    globs: set[str] = field(default_factory=set)
    tokens: dict[str, set[str]] = field(default_factory=dict)  # glob -> identifiers in its changed lines


def glob_of(path: str) -> str:
    parts = path.split("/")[:-1][:DEPTH]
    return "/".join(parts) + "/*" if parts else "*"


def wanted(path: str) -> bool:
    reason = prefilter.excluded(path)
    return reason is None or (reason == "not source" and path.endswith(".sql"))


def read_reverts(repo: Path, n: int) -> list[Revert]:
    out = []
    log = git(repo, "log", "--grep=^Revert \"", "--no-merges", "--format=%H%x1f%s")
    picked = [line.split("\x1f", 1) for line in log.splitlines() if line.split("\x1f", 1)[1].startswith('Revert "')][:n]
    for sha, subject in picked:
        r = Revert(sha, subject)
        current = None
        for d in git(repo, "show", "--no-renames", "--unified=0", "--format=", sha).splitlines():
            if d.startswith(("--- ", "+++ ")):
                path = d[6:] if d[4:6] in ("a/", "b/") else ""  # "/dev/null" for an added or deleted file
                if path:
                    current = glob_of(path) if wanted(path) else None
                    if current:
                        r.globs.add(current)
                elif d.startswith("--- "):
                    current = None  # an added file: its "+++ b/..." line follows
                continue
            if current and d[:1] in "+-":
                r.tokens.setdefault(current, set()).update(t for t in IDENT.findall(d[1:]) if t not in STOP)
        if r.globs:
            out.append(r)
    return out


def next_rule_id(rules: Path | None) -> int:
    ids = [int(m) for m in re.findall(r"^## R(\d+) ", rules.read_text(), re.M)] if rules and rules.exists() else []
    return max(ids, default=0) + 1


def candidates(reverts: list[Revert], minimum: int = 2) -> list[dict[str, object]]:
    by_glob: dict[str, list[Revert]] = {}
    for r in reverts:
        for g in r.globs:
            by_glob.setdefault(g, []).append(r)
    groups: dict[tuple[str, ...], list[str]] = {}  # same set of reverts -> one rule over all its globs
    for g, rs in by_glob.items():
        if len(rs) >= minimum:
            groups.setdefault(tuple(sorted(r.sha for r in rs)), []).append(g)
    out = []
    for shas, globs in groups.items():
        rs = [r for r in reverts if r.sha in shas]
        seen: dict[str, int] = {}
        for r in rs:
            for t in set().union(*(r.tokens.get(g, set()) for g in globs)):
                seen[t] = seen.get(t, 0) + 1
        tokens = sorted((t for t, c in seen.items() if c >= minimum), key=lambda t: (-seen[t], t))[:TOP_TOKENS]
        out.append({"globs": sorted(globs), "reverts": rs, "tokens": tokens})
    return sorted(out, key=lambda c: (-len(c["reverts"]), c["globs"]))  # type: ignore[arg-type]


def render(cands: list[dict[str, object]], first_id: int) -> str:
    blocks = []
    for i, c in enumerate(cands):
        rs: list[Revert] = c["reverts"]  # type: ignore[assignment]
        tokens: list[str] = c["tokens"]  # type: ignore[assignment]
        globs: list[str] = c["globs"]  # type: ignore[assignment]
        diff = r"\b(?:" + "|".join(re.escape(t) for t in tokens) + r")\b" if tokens else "(?!)"
        subjects = "; ".join(f"{r.sha[:10]} {r.subject}" for r in rs)
        blocks.append(
            f"## R{first_id + i:02d} Reverted {len(rs)} times under {globs[0]}\n"
            f"paths: {', '.join(globs)}\n"
            f"diff: {diff}\n"
            f"invariant: CANDIDATE (write the real invariant before merging). Reverts: {subjects}\n"
            f"probe: CANDIDATE (write the real probe before merging): a test that fails on each reverted change and "
            f"passes after its revert.\n")
    return "\n".join(blocks)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="mine_rules.py", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("repo", type=Path)
    ap.add_argument("-n", type=int, default=30)
    ap.add_argument("--min", type=int, default=2, dest="minimum")
    ap.add_argument("--rules", type=Path, default=SKILL_DIR / "RELIABILITY.md")
    a = ap.parse_args(argv[1:])
    reverts = read_reverts(a.repo, a.n)
    cands = candidates(reverts, a.minimum)
    print(f"# {len(cands)} candidate rule(s) from {len(reverts)} revert(s) in {a.repo}; review and edit before adding to "
          "RELIABILITY.md on the base branch\n")
    if cands:
        print(render(cands, next_rule_id(a.rules)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
