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

import shutil
import sys
from pathlib import Path

from hunt_common import REPO, SKILL_DIR, InfraError, git, hunt_dir, mm_clone, scratch, sh, write_json

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
            git(path, "checkout", "-q", "--detach", ref)
            git(path, "reset", "-q", "--hard")
            git(path, "clean", "-qfd", "-e", "node_modules", "-e", "go.work*")
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


def link_node_modules(mm: Path, wts: list[Path]) -> None:
    for sub in ("webapp/node_modules", "webapp/channels/node_modules"):
        src = mm / sub
        if not src.is_dir():
            raise InfraError(f"{src} missing: run `npm ci` in {mm / 'webapp'} once")
        for wt in wts:
            dst = wt / sub
            if dst.is_symlink() or dst.exists():
                continue
            dst.symlink_to(src)
    if not shutil.which("node"):
        raise InfraError("node not on PATH (set HUNT_NODE_BIN)")


def main(pr: str) -> None:
    mm = mm_clone()
    ensure_clone(mm)
    git(mm, "fetch", "-q", "origin", f"pull/{pr}/head:pr-{pr}", "master:refs/remotes/origin/master")
    wt, wt_base = scratch() / f"wt{pr}", scratch() / f"wt{pr}.base"
    mb = worktrees(mm, f"pr-{pr}", "origin/master", wt, wt_base)
    changed = git(mm, "diff", "--name-only", mb, f"pr-{pr}").splitlines()
    go_changed = any(f.startswith("server/") and f.endswith(".go") for f in changed)
    web_changed = any(f.startswith("webapp/") for f in changed)
    if go_changed:
        for w in (wt, wt_base):
            go_work(w)
    if any(f.startswith(STATEFUL) or "/app/platform/" in f for f in changed):
        services_up()
    if web_changed:
        link_node_modules(mm, [wt, wt_base])
    write_json(hunt_dir(pr) / "prepare.json", {"pr": pr, "repo": str(mm), "wt": str(wt), "wt_base": str(wt_base),
                                              "head": git(mm, "rev-parse", f"pr-{pr}"), "merge_base": mb})
    print(f"ready: head {wt}  base {wt_base}  merge-base {mb[:10]}  go={go_changed} webapp={web_changed}")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
