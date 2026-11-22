#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Read the skill's rules from the base branch, so a pull request cannot weaken its own checks.

Rule files (SKILL.md, lessons.jsonl, RELIABILITY.md, prompts/*.md) that are tracked in git are read from the trusted
ref, never from the checked-out head:
  - HUNT_TRUSTED_REF unset: merge-base(HEAD, origin/HEAD | origin/main | origin/master) of the repo holding the skill.
  - HUNT_TRUSTED_REF=<ref>: that ref.
  - HUNT_TRUSTED_REF=worktree: the files on disk (only for people editing the rules themselves).
A skill that is not tracked in its repository (a local, uncommitted or symlinked install outside any PR) is read from
disk. In a tracked skill, a file the trusted ref has always comes from the ref, even if HEAD deleted it and the disk
holds a new copy; a file that is on disk or tracked at HEAD but missing at the trusted ref fails closed (rules must
land on the base branch before they apply).

usage: trusted.py check    print the trusted ref and fail (exit 2) if any skill file differs from it
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

import os
import sys
from pathlib import Path

from hunt_common import SKILL_DIR, InfraError, git_cmd, sh

WORKTREE = "worktree"


def _git(root: Path, *args: str, check: bool = True) -> tuple[int, str]:
    p = sh(git_cmd(*args), root, check=check)
    return p.returncode, p.stdout.strip()


def repo_root(skill_dir: Path) -> Path | None:
    code, out = _git(skill_dir.resolve(), "rev-parse", "--show-toplevel", check=False)
    return Path(out) if code == 0 else None


def trusted_ref(root: Path) -> str:
    env = os.environ.get("HUNT_TRUSTED_REF", "").strip()
    if env:
        return env
    candidates = []
    code, sym = _git(root, "symbolic-ref", "-q", "refs/remotes/origin/HEAD", check=False)
    if code == 0:
        candidates.append(sym)
    candidates += ["refs/remotes/origin/main", "refs/remotes/origin/master"]
    for base in candidates:
        if _git(root, "rev-parse", "-q", "--verify", f"{base}^{{commit}}", check=False)[0] == 0:
            code, mb = _git(root, "merge-base", "HEAD", base, check=False)
            if code == 0:
                return mb
    raise InfraError(f"no base branch in {root}: fetch origin/main (or set HUNT_TRUSTED_REF) so rules can be read from it")


def _tracked_at_head(root: Path, rel: str) -> bool:
    return _git(root, "cat-file", "-e", f"HEAD:{rel}", check=False)[0] == 0


def _skill_tracked(root: Path, skill_dir: Path) -> bool:
    """Tracked in the index or committed at HEAD: unstaging the skill (`git rm --cached -r`) does not make it a local
    install whose files would be read from disk."""
    rel = skill_dir.resolve().relative_to(root.resolve()).as_posix()
    if _git(root, "ls-files", "--error-unmatch", rel, check=False)[0] == 0:
        return True
    code, listed = _git(root, "ls-tree", "-r", "--name-only", "HEAD", "--", rel, check=False)
    return code == 0 and bool(listed)


def read(name: str, skill_dir: Path = SKILL_DIR) -> str:
    """Content of <skill_dir>/<name> as the trusted ref has it (see module doc)."""
    path = (skill_dir / name).resolve()
    root = repo_root(skill_dir)
    if root is None or os.environ.get("HUNT_TRUSTED_REF", "").strip() == WORKTREE:
        return path.read_text() if path.exists() else ""
    if not _skill_tracked(root, skill_dir):
        return path.read_text() if path.exists() else ""
    rel = path.relative_to(root.resolve()).as_posix()
    ref = trusted_ref(root)
    # The trusted ref is checked first: a file the PR deleted and the working copy recreated is still read from it.
    if _git(root, "cat-file", "-e", f"{ref}:{rel}", check=False)[0] == 0:
        return sh(git_cmd("show", f"{ref}:{rel}"), root).stdout
    if _tracked_at_head(root, rel) or path.exists():
        # On disk or in the PR but not on the base: never read it, and never silently drop it either.
        raise InfraError(f"{rel} is not on the trusted ref {ref[:12]}; rules must land on the base branch first")
    return ""  # nowhere at all (e.g. an optional rules file this checkout does not have)


def check(skill_dir: Path = SKILL_DIR) -> str:
    """Fail closed when the checked-out skill differs from the trusted ref (scripts and prompts included)."""
    root = repo_root(skill_dir)
    if root is None:
        return "skill is not in a git repository: local install, read from disk"
    if os.environ.get("HUNT_TRUSTED_REF", "").strip() == WORKTREE:
        return "HUNT_TRUSTED_REF=worktree: rules read from disk (rule-editing mode)"
    rel = skill_dir.resolve().relative_to(root.resolve()).as_posix()
    if not _skill_tracked(root, skill_dir):
        return f"{rel} is not tracked: local install, read from disk"
    # Step 1 of /hunt also invokes sibling verify/scripts/pr_server.py when present: guard it if tracked in this repo.
    paths = [rel]
    pr_server = (skill_dir.resolve().parent / "verify" / "scripts" / "pr_server.py")
    if pr_server.exists() and pr_server.is_relative_to(root.resolve()):
        ps_rel = pr_server.relative_to(root.resolve()).as_posix()
        if (_git(root, "ls-files", "--error-unmatch", ps_rel, check=False)[0] == 0
                or _tracked_at_head(root, ps_rel)):
            paths.append(ps_rel)
    _, tracked = _git(root, "ls-files", "--", *paths, check=False)
    bytecode = [f for f in tracked.splitlines() if "__pycache__/" in f or f.endswith((".pyc", ".pyo"))]
    if bytecode:
        raise InfraError(f"compiled bytecode is committed in the skill ({', '.join(bytecode[:3])}); Python could run it "
                         "instead of the reviewed source. Remove it from git.")
    ref = trusted_ref(root)
    code, changed = _git(root, "diff", "--name-status", "--no-renames", ref, "--", *paths, check=False)
    # No --exclude-standard: a PR must not hide a shadowing module (e.g. scripts/json.py) behind .gitignore.
    _, untracked = _git(root, "ls-files", "--others", "--", *paths, check=False)
    # lessons.jsonl may hold lessons added since the base (lessons.py add appends there); read() takes the trusted
    # copy anyway, so an edited working copy cannot change what hunters see and must not block hunting. Only an
    # in-place edit is exempt: a deleted, added or untracked lessons file is reported like any other change.
    # Locally generated caches are untracked noise; anything tracked was already refused above.
    entries = [line.split("\t", 1) for line in changed.splitlines() if "\t" in line]
    dirty = [f for st, f in entries if not (st == "M" and f.endswith("/lessons.jsonl"))]
    dirty += [u for u in untracked.splitlines() if u and "__pycache__" not in u]
    if code != 0:
        raise InfraError(f"{rel} is not on the trusted ref {ref[:12]}; the skill must land on the base branch first")
    if dirty:
        raise InfraError(f"skill differs from trusted ref {ref[:12]}: {', '.join(dirty)}. A change to the skill cannot "
                         "take part in its own hunt; merge it first, or set HUNT_TRUSTED_REF=worktree when editing rules")
    return f"rules read from trusted ref {ref[:12]} ({root})"


if __name__ == "__main__":
    if sys.argv[1:] != ["check"]:
        sys.exit(__doc__)
    try:
        print(check())
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
