#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 1: worktrees + infrastructure gate.

usage: prepare.py <pr>
Creates <scratch>/wt<pr> at the PR head and <scratch>/wt<pr>.base at the merge-base, sets up go.work and webapp
node_modules, and checks Postgres + Redis when the PR touches stateful server code. Prints INFRA_ERROR and exits 2 on any
environment failure.
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

import hashlib
import json
import shutil
import sys
from pathlib import Path

from hunt_common import (
    REPO,
    SKILL_DIR,
    InfraError,
    git,
    git_cmd,
    hunt_dir,
    hunt_lock,
    mm_clone,
    node_env,
    scratch,
    sh,
    write_json,
)

STATEFUL = ("server/channels/api4/", "server/channels/app/", "server/channels/store/", "server/channels/web/",
            "server/channels/wsapi/")


def ensure_clone(mm: Path) -> None:
    if not (mm / ".git").exists():
        mm.parent.mkdir(parents=True, exist_ok=True)
        sh(["git", "clone", "--filter=blob:none", "--no-checkout", f"https://github.com/{REPO}", str(mm)], mm.parent)


def worktrees(repo: Path, head_ref: str, base_ref: str, wt: Path, wt_base: Path) -> str:
    """Head worktree at head_ref, base worktree at merge-base(head_ref, base_ref). Returns the merge-base sha.
    Re-running resets both to the same commits (no stale hunt files survive)."""
    mb = git(repo, "merge-base", head_ref, base_ref)
    for path, ref in ((wt, head_ref), (wt_base, mb)):
        if path.exists():
            # Discard leftovers (an interrupted mutant, hunt files) before switching, or checkout refuses.
            git(path, "reset", "-q", "--hard")
            git(path, "clean", "-qfd", "-e", "node_modules", "-e", "go.work*")
            git(path, "checkout", "-q", "-f", "--detach", ref)
        else:
            git(repo, "worktree", "add", "-q", "--detach", str(path), ref)
    return mb


def go_work(wt: Path) -> None:
    if (wt / "server" / "go.mod").exists() and not (wt / "go.work").exists():
        mods = ["./server"] + (["./server/public"] if (wt / "server/public/go.mod").exists() else [])
        p = sh(["go", "work", "init", *mods], wt, check=False)
        if p.returncode != 0:  # first call sometimes fails while the toolchain downloads
            sh(["go", "work", "init", *mods], wt)


def services_up() -> None:
    if sh(["pg_isready", "-h", "localhost"], Path("."), check=False).returncode != 0:
        sh(["bash", str(SKILL_DIR / "scripts" / "start_pg.sh")], SKILL_DIR, timeout=300)
    if sh(["pg_isready", "-h", "localhost"], Path("."), check=False).returncode != 0:
        raise InfraError("Postgres not reachable on localhost:5432 (scripts/start_pg.sh did not bring it up)")
    if sh(["redis-cli", "ping"], Path("."), check=False).stdout.strip() != "PONG":
        sh(["redis-server", "--daemonize", "yes", "--port", "6379", "--save", "", "--appendonly", "no",
            "--dir", str(scratch())], Path("."))
        sh(["redis-cli", "ping"], Path("."))


def npm_ci_for_lock(webapp: Path) -> None:
    """`npm ci` unless node_modules was installed from this exact package-lock.json (a stamp records its hash)."""
    lock = webapp / "package-lock.json"
    digest = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else "no-lock"
    stamp = webapp / "node_modules" / ".hunt-lock-sha256"
    if stamp.exists() and stamp.read_text().strip() == digest:
        return
    sh(["npm", "ci", "--no-audit", "--no-fund"], webapp, timeout=3600, env=node_env())
    stamp.parent.mkdir(exist_ok=True)
    stamp.write_text(digest)


def webapp_deps(wt: Path, wt_base: Path, mb: str, head: str) -> None:
    """`npm ci` in the head worktree's webapp/ (the shared clone has no checkout). The merge-base worktree reuses those
    node_modules when package-lock.json is unchanged, and installs its own otherwise."""
    if not shutil.which("node", path=node_env().get("PATH")):
        raise InfraError("node not on PATH (set HUNT_NODE_BIN)")
    npm_ci_for_lock(wt / "webapp")
    lock_changed = sh(git_cmd("diff", "--quiet", mb, head, "--", "webapp/package-lock.json"), wt, check=False).returncode != 0
    shared = ("webapp/node_modules", "webapp/channels/node_modules")
    if lock_changed:
        for sub in shared:  # links from an earlier run, when the lockfiles still matched
            if (wt_base / sub).is_symlink():
                (wt_base / sub).unlink()
        npm_ci_for_lock(wt_base / "webapp")
        return
    if (wt_base / "webapp" / "node_modules").is_dir() and not (wt_base / "webapp" / "node_modules").is_symlink():
        npm_ci_for_lock(wt_base / "webapp")  # its own install from an earlier run: keep it matching its lockfile
        return
    for sub in shared:
        src, dst = wt / sub, wt_base / sub
        if src.is_dir() and not (dst.exists() or dst.is_symlink()):
            dst.symlink_to(src)


def main(pr: str) -> None:
    # Held from the fetch to prepare.json: a run.py still using these worktrees must finish first.
    with hunt_lock(hunt_dir(pr), pr):
        prepare(pr)


def prepare(pr: str) -> None:
    mm = mm_clone()
    ensure_clone(mm)
    # The PR's own base branch (release-* cherry-picks are common), not always master.
    base = json.loads(sh(["gh", "api", f"repos/{REPO}/pulls/{pr}"], Path(".")).stdout)["base"]["ref"]
    git(mm, "fetch", "-q", "origin", f"+pull/{pr}/head:pr-{pr}", f"+{base}:refs/remotes/origin/{base}")
    wt, wt_base = scratch() / f"wt{pr}", scratch() / f"wt{pr}.base"
    mb = worktrees(mm, f"pr-{pr}", f"origin/{base}", wt, wt_base)
    changed = git(mm, "diff", "--name-only", "--no-renames", mb, f"pr-{pr}").splitlines()
    go_changed = any(f.startswith("server/") and f.endswith(".go") for f in changed)
    web_changed = any(f.startswith("webapp/") for f in changed)
    if go_changed:
        for w in (wt, wt_base):
            go_work(w)
    if any(f.startswith(STATEFUL) or "/app/platform/" in f for f in changed):
        services_up()
    if web_changed:
        webapp_deps(wt, wt_base, mb, git(mm, "rev-parse", f"pr-{pr}"))
    write_json(hunt_dir(pr) / "prepare.json", {"pr": pr, "repo": str(mm), "wt": str(wt), "wt_base": str(wt_base),
                                              "head": git(mm, "rev-parse", f"pr-{pr}"), "merge_base": mb,
                                              "base_ref": base})
    print(f"ready: head {wt}  base {wt_base} ({base} @ {mb[:10]})  go={go_changed} webapp={web_changed}")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
