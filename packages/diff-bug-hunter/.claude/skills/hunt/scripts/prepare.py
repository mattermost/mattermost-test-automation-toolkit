#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 1: worktrees + infrastructure gate.

usage: prepare.py <pr | base..head | base...head> [--fresh]
Creates <scratch>/wt<key> at the PR head (or range head) and <scratch>/wt<key>.base at the merge-base, sets up
go.work and webapp node_modules, and checks Postgres + Redis when the diff touches stateful server code. Prints
INFRA_ERROR and exits 2 on any environment failure.
Preparing again wipes hunt<key>/. When it already holds hunter responses or verdicts for the current head, that would
throw away paid-for work (a restarted session does exactly this), so it prints ALREADY_HUNTED and exits 4 instead.
--fresh starts over anyway; a PR or branch whose head moved starts over without it.
"""
from __future__ import annotations

import sys

# Never load bytecode from the skill directory: a committed __pycache__/*.pyc (an unchecked-hash .pyc, say) would run
# code the trust gate never compares with the reviewed source. Disabling writes + non-existent prefix blocks loading too.
sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import hashlib
import json
import shutil
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
    parse_range,
    require_disk,
    scratch,
    sh,
    worktree_paths,
    write_json,
)

STATEFUL = ("server/channels/api4/", "server/channels/app/", "server/channels/store/", "server/channels/web/",
            "server/channels/wsapi/")


def ensure_clone(mm: Path) -> None:
    if not (mm / ".git").exists():
        mm.parent.mkdir(parents=True, exist_ok=True)
        sh(["git", "clone", "--filter=blob:none", "--no-checkout", f"https://github.com/{REPO}", str(mm)], mm.parent)


def _registered_worktrees(repo: Path) -> set[Path]:
    out = git(repo, "worktree", "list", "--porcelain")
    return {Path(line[9:]).resolve() for line in out.splitlines() if line.startswith("worktree ")}


def worktrees(repo: Path, head_ref: str, base_ref: str, wt: Path, wt_base: Path) -> str:
    """Head worktree at head_ref, base worktree at merge-base(head_ref, base_ref). Returns the merge-base sha.
    Re-running resets both to the same commits (no stale hunt files survive)."""
    mb = git(repo, "merge-base", head_ref, base_ref)
    git(repo, "worktree", "prune")
    registered = _registered_worktrees(repo)
    for path, ref in ((wt, head_ref), (wt_base, mb)):
        if path.exists():
            if not (path / ".git").is_file() or path.resolve() not in registered:
                raise InfraError(f"{path} exists but is not a git worktree of {repo}")
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
        for _ in range(30):
            if sh(["redis-cli", "ping"], Path("."), check=False).stdout.strip() == "PONG":
                return
        raise InfraError("Redis not reachable on localhost:6379 after daemon start")


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
    Returns (go_changed, web_changed). Shared with eval_bugs.py, which hunts historical commits instead of PRs."""
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
RESULTS = ("A/response.json", "B/response.json", "D/response.json", "R/response.json", "A2/response.json",
           "run_*.json", "diff_*.json", "old_tests.json", "pr_tests.json", "review_verdicts.json",
           "batches/batch_*/*/response.json", "batches/batch_*/run_*.json", "batches/batch_*/diff_*.json")


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


def resolve_ref(mm: Path, ref: str) -> str:
    """Resolve a branch, tag, or commit sha in `mm`, fetching it from origin when available."""
    p = sh(git_cmd("fetch", "-q", "origin", ref), mm, check=False)
    if p.returncode == 0:
        return git(mm, "rev-parse", "FETCH_HEAD^{commit}")
    for cand in (ref, f"origin/{ref}", f"refs/tags/{ref}", f"refs/remotes/origin/{ref}"):
        q = sh(git_cmd("rev-parse", "-q", "--verify", f"{cand}^{{commit}}"), mm, check=False)
        if q.returncode == 0:
            return q.stdout.strip()
    raise InfraError(f"cannot resolve ref {ref!r} in {mm}: {(p.stdout + p.stderr).strip()[-400:]}")


def prepare(pr: str, fresh: bool = False) -> None:
    require_disk(scratch())  # worktrees, node_modules and Go builds: refuse early rather than half-prepare
    hdir = hunt_dir(pr)
    rng = parse_range(pr)
    wt, wt_base = worktree_paths(pr)
    if rng is not None:
        base_spec, head_spec = rng
        mm = mm_clone()
        ensure_clone(mm)
        base_sha = resolve_ref(mm, base_spec)
        head_sha = resolve_ref(mm, head_spec)
        done = [] if fresh else existing_results(hdir, head_sha)
        if done:
            raise AlreadyHunted(f"{hdir.name}/ already has results for head {head_sha[:10]}: {', '.join(done)}. "
                                "Do not start over: continue from the first step whose output is missing, or report. "
                                "Pass --fresh only if the user asked for a new hunt.")
        reset_hunt_dir(hdir, include_whole_pr=True)
        (hdir / "prepare.json").unlink(missing_ok=True)
        mb = worktrees(mm, head_sha, base_sha, wt, wt_base)
        go_changed, web_changed = deps(mm, wt, wt_base, mb, head_sha)
        write_json(hdir / "prepare.json", {"pr": pr, "range": [base_spec, head_spec], "repo": str(mm),
                                           "wt": str(wt), "wt_base": str(wt_base), "head": head_sha,
                                           "merge_base": mb, "base_ref": base_spec})
        print(f"ready: head {wt} ({head_spec} @ {head_sha[:10]})  base {wt_base} ({base_spec} @ {mb[:10]})  "
              f"go={go_changed} webapp={web_changed}")
        return
    meta = pr_meta(pr)
    done = [] if fresh else existing_results(hdir, meta["head"]["sha"])
    if done:
        raise AlreadyHunted(f"hunt{pr}/ already has results for head {meta['head']['sha'][:10]}: {', '.join(done)}. "
                            "Do not start over: continue from the first step whose output is missing, or report. "
                            "Pass --fresh only if the user asked for a new hunt.")
    # The worktrees are about to move: context, responses and verdicts from the previous preparation no longer apply.
    reset_hunt_dir(hdir, include_whole_pr=True)
    (hdir / "prepare.json").unlink(missing_ok=True)
    mm = mm_clone()
    ensure_clone(mm)
    # The PR's own base branch (release-* cherry-picks are common), not always master.
    base = meta["base"]["ref"]
    git(mm, "fetch", "-q", "origin", f"+pull/{pr}/head:pr-{pr}", f"+{base}:refs/remotes/origin/{base}")
    mb = worktrees(mm, f"pr-{pr}", f"origin/{base}", wt, wt_base)
    go_changed, web_changed = deps(mm, wt, wt_base, mb, f"pr-{pr}")
    write_json(hdir / "prepare.json", {"pr": pr, "repo": str(mm), "wt": str(wt), "wt_base": str(wt_base),
                                       "head": git(mm, "rev-parse", f"pr-{pr}"), "merge_base": mb,
                                       "base_ref": base})
    print(f"ready: head {wt}  base {wt_base} ({base} @ {mb[:10]})  go={go_changed} webapp={web_changed}")


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or sys.argv[2:] not in ([], ["--fresh"]):
            sys.exit("usage: prepare.py <pr | base..head | base...head> [--fresh]")
        main(sys.argv[1], fresh=sys.argv[2:] == ["--fresh"])
    except AlreadyHunted as e:
        print(f"ALREADY_HUNTED {e}")
        sys.exit(4)
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
