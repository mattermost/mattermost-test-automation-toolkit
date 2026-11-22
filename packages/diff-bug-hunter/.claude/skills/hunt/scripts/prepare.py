#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 1: worktrees + infrastructure gate.

usage: prepare.py <pr> [--fresh]
Creates <scratch>/wt<pr> at the PR head and <scratch>/wt<pr>.base at the merge-base, sets up go.work and webapp
node_modules, and checks Postgres + Redis when the PR touches stateful server code. Prints INFRA_ERROR and exits 2 on any
environment failure.
Preparing again wipes hunt<pr>/. When it already holds hunter responses or verdicts for the PR's current head, that would
throw away paid-for work (a restarted session does exactly this), so it prints ALREADY_HUNTED and exits 4 instead.
--fresh starts over anyway; a PR whose head moved starts over without it.
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

from ctx import reset_hunt_dir
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
    require_disk,
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


def deps(repo: Path, wt: Path, wt_base: Path, mb: str, head_ref: str) -> tuple[bool, bool]:
    """What the changed files need: go.work for Go, Postgres and Redis for stateful server code, npm ci for the webapp.
    Returns (go_changed, web_changed). Shared with eval_reverts.py, which hunts historical commits instead of PRs."""
    changed = git(repo, "diff", "--name-only", "--no-renames", mb, head_ref).splitlines()
    go_changed = any(f.startswith("server/") and f.endswith(".go") for f in changed)
    web_changed = any(f.startswith("webapp/") for f in changed)
    if go_changed:
        for w in (wt, wt_base):
            go_work(w)
    if any(f.startswith(STATEFUL) or "/app/platform/" in f for f in changed):
        services_up()
    if web_changed:
        webapp_deps(wt, wt_base, mb, git(repo, "rev-parse", head_ref))
    return go_changed, web_changed


# Outputs that cost a model call or a long test run. Any of them for the current head means the hunt is under way.
RESULTS = ("A/response.json", "B/response.json", "D/response.json", "A2/response.json", "run_*.json", "diff_*.json",
           "old_tests.json", "pr_tests.json")


class AlreadyHunted(RuntimeError):
    pass


def pr_meta(pr: str) -> dict:
    return json.loads(sh(["gh", "api", f"repos/{REPO}/pulls/{pr}"], Path(".")).stdout)


def existing_results(hdir: Path, head: str) -> list[str]:
    """Result files in hdir that were made for `head` (as prepare.json recorded it); [] if none or another head."""
    try:
        prepared = json.loads((hdir / "prepare.json").read_text()).get("head")
    except (OSError, ValueError):
        return []
    if prepared != head:
        return []
    return sorted(str(p.relative_to(hdir)) for pattern in RESULTS for p in hdir.glob(pattern))


def main(pr: str, fresh: bool = False) -> None:
    # Held from the fetch to prepare.json: a run.py still using these worktrees must finish first.
    with hunt_lock(hunt_dir(pr), pr):
        prepare(pr, fresh)


def prepare(pr: str, fresh: bool = False) -> None:
    require_disk(scratch())  # worktrees, node_modules and Go builds: refuse early rather than half-prepare
    hdir = hunt_dir(pr)
    meta = pr_meta(pr)
    done = [] if fresh else existing_results(hdir, meta["head"]["sha"])
    if done:
        raise AlreadyHunted(f"hunt{pr}/ already has results for head {meta['head']['sha'][:10]}: {', '.join(done)}. "
                            "Do not start over: continue from the first step whose output is missing, or report. "
                            "Pass --fresh only if the user asked for a new hunt.")
    # The worktrees are about to move: context, responses and verdicts from the previous preparation no longer apply.
    reset_hunt_dir(hdir)
    (hdir / "prepare.json").unlink(missing_ok=True)
    mm = mm_clone()
    ensure_clone(mm)
    # The PR's own base branch (release-* cherry-picks are common), not always master.
    base = meta["base"]["ref"]
    git(mm, "fetch", "-q", "origin", f"+pull/{pr}/head:pr-{pr}", f"+{base}:refs/remotes/origin/{base}")
    wt, wt_base = scratch() / f"wt{pr}", scratch() / f"wt{pr}.base"
    mb = worktrees(mm, f"pr-{pr}", f"origin/{base}", wt, wt_base)
    go_changed, web_changed = deps(mm, wt, wt_base, mb, f"pr-{pr}")
    write_json(hunt_dir(pr) / "prepare.json", {"pr": pr, "repo": str(mm), "wt": str(wt), "wt_base": str(wt_base),
                                              "head": git(mm, "rev-parse", f"pr-{pr}"), "merge_base": mb,
                                              "base_ref": base})
    print(f"ready: head {wt}  base {wt_base} ({base} @ {mb[:10]})  go={go_changed} webapp={web_changed}")


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or sys.argv[2:] not in ([], ["--fresh"]):
            sys.exit("usage: prepare.py <pr> [--fresh]")
        main(sys.argv[1], fresh=sys.argv[2:] == ["--fresh"])
    except AlreadyHunted as e:
        print(f"ALREADY_HUNTED {e}")
        sys.exit(4)
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
