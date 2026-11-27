#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 1: worktrees + infrastructure gate.

usage: prepare.py <pr | base..head | base...head> [--fresh]
Creates <scratch>/wt<key> at the PR head (or range head) and <scratch>/wt<key>.base at the base, sets up
go.work and webapp node_modules, and checks Postgres + Redis when the diff touches stateful server code. Prints
INFRA_ERROR and exits 2 on any environment failure.
Range base: `base..head` (two dots) takes the base ref itself as the base worktree; `base...head` (three dots) takes
merge-base(base, head), as a PR does.
prepare.json carries schema_version (SCHEMA_VERSION). A hunt dir prepared by another schema prints SCHEMA_MISMATCH and
exits 5 instead of resuming, unless --fresh is given.
Preparing again wipes hunt<key>/. When it already holds hunter responses or verdicts for the current head, that would
throw away paid-for work (a restarted session does exactly this), so it prints ALREADY_HUNTED and exits 4 instead.
--fresh starts over anyway; a PR or branch whose head moved starts over without it.
Postgres and Redis: with a usable docker, containers `hunt-pg` (127.0.0.1:5432) and `hunt-redis` (127.0.0.1:6379) are
started; without docker, or when their ports are taken, the host's Postgres and Redis are used.
"""
from __future__ import annotations

import sys

# Never load bytecode from the skill directory: a committed __pycache__/*.pyc (an unchecked-hash .pyc, say) would run
# code the trust gate never compares with the reviewed source. Disabling writes + non-existent prefix blocks loading too.
sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import fcntl
import hashlib
import json
import re
import shutil
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import build_requests
import prefilter
from ctx import reset_hunt_dir
from hunt_common import (
    REPO,
    SCHEMA_VERSION,
    SKILL_DIR,
    InfraError,
    git,
    git_cmd,
    hunt_dir,
    hunt_lock,
    mm_clone,
    node_env,
    parse_range,
    read_optional_dict,
    require_disk,
    scratch,
    sh,
    worktree_paths,
    write_json,
)

PG_MAX_CONNECTIONS = 400  # 4 parallel hunts x parallel Go test packages, each with its own pool
PG_CONTAINER, PG_IMAGE = "hunt-pg", "postgres:18.3"  # the pinned Postgres (CLAUDE.md); mmuser/mostest as start_pg.sh
REDIS_CONTAINER, REDIS_IMAGE = "hunt-redis", "redis:7"


class SchemaMismatch(RuntimeError):
    """hunt<key>/ was prepared by another schema_version: resuming it could mix layouts. Printed as SCHEMA_MISMATCH."""


@contextmanager
def clone_fetch_lock(mm: Path) -> Iterator[None]:
    """Serialize fetches into the shared clone (blocking: a wait, not a retry)."""
    with (mm.parent / f".{mm.name}.fetch.lock").open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


RUN_STALE = ("telemetry.jsonl", "driver.json")  # one run's cost and gaps; a new hunt starts from zero


def check_schema(hdir: Path, head: str, fresh: bool) -> None:
    """Refuse to resume a preparation of this same head made by another schema. A moved head starts over anyway."""
    if fresh or not (hdir / "prepare.json").exists():
        return
    try:
        prev = json.loads((hdir / "prepare.json").read_text())
    except ValueError as e:
        raise SchemaMismatch(f"{hdir.name}/prepare.json is not JSON; pass --fresh to start over") from e
    if not isinstance(prev, dict) or prev.get("head") != head:
        return
    found = prev.get("schema_version")
    if found != SCHEMA_VERSION:
        raise SchemaMismatch(f"{hdir.name}/ was prepared by schema_version {found!r}, this is {SCHEMA_VERSION}: "
                             "old hunt results are not resumed. Pass --fresh to start over.")


def is_two_dot(target: str) -> bool:
    """`base..head` (two dots, base taken as is) rather than `base...head` (merge-base) or a PR number."""
    s = str(target).strip()
    return ".." in s and "..." not in s


STATEFUL = ("server/channels/api4/", "server/channels/app/", "server/channels/store/", "server/channels/web/",
            "server/channels/wsapi/")


def ensure_clone(mm: Path) -> None:
    if not (mm / ".git").exists():
        mm.parent.mkdir(parents=True, exist_ok=True)
        sh(["git", "clone", "--filter=blob:none", "--no-checkout", f"https://github.com/{REPO}", str(mm)], mm.parent)


def _registered_worktrees(repo: Path) -> set[Path]:
    out = git(repo, "worktree", "list", "--porcelain")
    return {Path(line[9:]).resolve() for line in out.splitlines() if line.startswith("worktree ")}


def worktrees(repo: Path, head_ref: str, base_ref: str, wt: Path, wt_base: Path, *, two_dot: bool = False) -> str:
    """Head worktree at head_ref, base worktree at merge-base(head_ref, base_ref), or at base_ref itself when
    two_dot (base_ref is then a commit sha). Returns the base commit sha.
    Re-running resets both to the same commits (no stale hunt files survive)."""
    mb = base_ref if two_dot else git(repo, "merge-base", head_ref, base_ref)
    for path, ref in ((wt, head_ref), (wt_base, mb)):
        worktree(repo, path, ref)
    return mb


def worktree(repo: Path, path: Path, ref: str) -> None:
    """One detached worktree at ref, created or reset (no stale hunt files survive)."""
    git(repo, "worktree", "prune")
    if path.exists():
        if not (path / ".git").is_file() or path.resolve() not in _registered_worktrees(repo):
            raise InfraError(f"{path} exists but is not a git worktree of {repo}")
        # Discard leftovers (an interrupted mutant, hunt files) before switching, or checkout refuses.
        git(path, "reset", "-q", "--hard")
        git(path, "clean", "-qfd", "-e", "node_modules", "-e", "go.work*")
        git(path, "checkout", "-q", "-f", "--detach", ref)
    else:
        git(repo, "worktree", "add", "-q", "--detach", str(path), ref)


def go_work(wt: Path) -> None:
    if (wt / "server" / "go.mod").exists() and not (wt / "go.work").exists():
        mods = ["./server"] + (["./server/public"] if (wt / "server/public/go.mod").exists() else [])
        p = sh(["go", "work", "init", *mods], wt, check=False)
        if p.returncode != 0:  # first call sometimes fails while the toolchain downloads
            sh(["go", "work", "init", *mods], wt)


def docker_usable() -> bool:
    if not shutil.which("docker"):
        return False
    return sh(["docker", "info", "--format", "{{.ServerVersion}}"], Path("."), check=False).returncode == 0


def _container_running(name: str) -> bool | None:
    """True/False for an existing container's state, None when it does not exist."""
    p = sh(["docker", "inspect", "-f", "{{.State.Running}}", name], Path("."), check=False)
    return None if p.returncode != 0 else p.stdout.strip() == "true"


def _ensure_container(name: str, run_args: list[str]) -> None:
    lock_file = scratch() / f"{name}.lock"
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with lock_file.open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            state = _container_running(name)
            if state is None:
                sh(["docker", "run", "-d", "--name", name, *run_args], Path("."))
            elif not state:
                sh(["docker", "start", name], Path("."))
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _wait_until(probe: Callable[[], bool], timeout: float, interval: float = 0.5) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if probe():
            return True
        rem = deadline - time.monotonic()
        if rem <= 0:
            return False
        threading.Event().wait(min(interval, rem))


def _docker_services() -> None:
    """Postgres and Redis in containers on fixed loopback ports, with the role and database the Mattermost tests use.

    Parallel hunts share this server but not test data: each Mattermost test package creates its own randomly named
    database (server/channels/store/storetest/settings.go, `"db" + model.NewId()`). What they do share is the
    connection limit, so the container raises max_connections from Postgres's default of 100 to PG_MAX_CONNECTIONS.
    The setting applies when the container is created; remove an older hunt-pg container to pick it up."""
    _ensure_container(PG_CONTAINER, ["-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1:5432:5432", PG_IMAGE,
                                     "-c", f"max_connections={PG_MAX_CONNECTIONS}"])
    if not _wait_until(
        lambda: sh(["docker", "exec", PG_CONTAINER, "pg_isready", "-h", "localhost", "-U", "postgres", "-q"],
                   Path("."), check=False).returncode == 0,
        timeout=60.0,
    ):
        raise InfraError(f"Postgres container {PG_CONTAINER} not ready after 60s")
    psql = ["docker", "exec", PG_CONTAINER, "psql", "-h", "localhost", "-U", "postgres"]
    if sh([*psql, "-tAc", "SELECT 1 FROM pg_roles WHERE rolname='mmuser'"], Path("."), check=False).stdout.strip() != "1":
        sh([*psql, "-qc", "CREATE ROLE mmuser LOGIN SUPERUSER PASSWORD 'mostest'"], Path("."))
    if sh([*psql, "-tAc", "SELECT 1 FROM pg_database WHERE datname='mattermost_test'"], Path("."),
          check=False).stdout.strip() != "1":
        sh([*psql, "-qc", "CREATE DATABASE mattermost_test OWNER mmuser"], Path("."))
    _ensure_container(REDIS_CONTAINER, ["-p", "127.0.0.1:6379:6379", REDIS_IMAGE])
    if not _wait_until(
        lambda: sh(["docker", "exec", REDIS_CONTAINER, "redis-cli", "ping"],
                   Path("."), check=False).stdout.strip() == "PONG",
        timeout=30.0,
    ):
        raise InfraError(f"Redis container {REDIS_CONTAINER} did not answer PING")


def services_up() -> None:
    if docker_usable():
        try:
            _docker_services()
            return
        except InfraError as e:  # e.g. the fixed port is held by a host Postgres: the host tools below serve instead
            print(f"note: docker services unavailable ({str(e).splitlines()[0][:200]}); using host Postgres and Redis")
    if sh(["pg_isready", "-h", "localhost"], Path("."), check=False).returncode != 0:
        sh(["bash", str(SKILL_DIR / "scripts" / "start_pg.sh")], SKILL_DIR, timeout=300)
    if sh(["pg_isready", "-h", "localhost"], Path("."), check=False).returncode != 0:
        raise InfraError("Postgres not reachable on localhost:5432 (scripts/start_pg.sh did not bring it up)")
    if sh(["redis-cli", "ping"], Path("."), check=False).stdout.strip() != "PONG":
        sh(["redis-server", "--daemonize", "yes", "--port", "6379", "--save", "", "--appendonly", "no",
            "--dir", str(scratch())], Path("."))
        if not _wait_until(
            lambda: sh(["redis-cli", "ping"], Path("."), check=False).stdout.strip() == "PONG",
            timeout=15.0,
        ):
            raise InfraError("Redis not reachable on localhost:6379 after daemon start")


def npm_ci_for_lock(webapp: Path) -> None:
    """`npm ci` unless node_modules was installed from this exact package-lock.json (a stamp records its hash)."""
    lock = webapp / "package-lock.json"
    digest = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else "no-lock"
    stamp = webapp / "node_modules" / ".hunt-lock-sha256"
    if stamp.exists() and stamp.read_text().strip() == digest:
        return
    sh(["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"], webapp, timeout=3600, env=node_env())
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


def huntable_changed(repo: Path, mb: str, head_ref: str) -> list[str]:
    changed = git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", mb, head_ref).splitlines()
    return [f for f in changed if not prefilter.excluded(f)]


def deps(repo: Path, wt: Path, wt_base: Path, mb: str, head_ref: str) -> tuple[bool, bool]:
    """What the changed files need: go.work for Go, Postgres and Redis for stateful server code, npm ci for the webapp.
    Returns (go_changed, web_changed). Shared with eval_bugs.py, which hunts historical commits instead of PRs."""
    changed = huntable_changed(repo, mb, head_ref)
    all_changed = (git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", mb, head_ref).splitlines()
                   if changed else [])
    go_changed = any(f.startswith("server/") and f.endswith(".go") for f in changed)
    web_changed = any(f.startswith("webapp/") for f in changed) or any(
        f.startswith("webapp/") and re.search(r"\.test\.[jt]sx?$", f) and not Path(f).name.startswith("hunt_")
        for f in all_changed
    )
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
    if read_optional_dict(hdir / "prepare.json").get("head") != head:
        return []
    return sorted(str(p.relative_to(hdir)) for pattern in RESULTS for p in hdir.glob(pattern))


def _meta_matches(hdir: Path, key: str, value: str) -> bool:
    prev = read_optional_dict(hdir / "prepare.json")
    return key not in prev or prev.get(key) == value


def prompt_matches(hdir: Path, pv: str) -> bool:
    return _meta_matches(hdir, "prompt_version", pv)


def base_mode_matches(hdir: Path, base_mode: str) -> bool:
    return _meta_matches(hdir, "base_mode", base_mode)


def main(pr: str, fresh: bool = False) -> None:
    # Held from the fetch to prepare.json: a run.py still using these worktrees must finish first.
    with hunt_lock(hunt_dir(pr), pr):
        prepare(pr, fresh)


def resolve_ref(mm: Path, ref: str) -> str:
    """Resolve a branch, tag, or commit sha in `mm`, fetching it from origin when available.

    A commit sha already in the clone is used as is. Anything else is fetched into its own ref
    (refs/hunt-fetch/<hash of ref>) and read back from there, never from FETCH_HEAD: fetching an object the clone
    already has can leave FETCH_HEAD without it, and hunts running in parallel share the clone's FETCH_HEAD."""
    if all(c in "0123456789abcdef" for c in ref.lower()) and len(ref) >= 7:
        q = sh(git_cmd("rev-parse", "-q", "--verify", f"{ref}^{{commit}}"), mm, check=False)
        if q.returncode == 0:
            return q.stdout.strip()
    local = f"refs/hunt-fetch/{hashlib.sha256(ref.encode()).hexdigest()[:16]}"
    with clone_fetch_lock(mm):
        p = sh(git_cmd("fetch", "-q", "origin", f"+{ref}:{local}"), mm, check=False)
    if p.returncode == 0:
        return git(mm, "rev-parse", f"{local}^{{commit}}")
    for cand in (ref, f"origin/{ref}", f"refs/tags/{ref}", f"refs/remotes/origin/{ref}"):
        q = sh(git_cmd("rev-parse", "-q", "--verify", f"{cand}^{{commit}}"), mm, check=False)
        if q.returncode == 0:
            return q.stdout.strip()
    raise InfraError(f"cannot resolve ref {ref!r} in {mm}: {(p.stdout + p.stderr).strip()[-400:]}")


def _prepare_reset(hdir: Path, label: str, head_sha: str, fresh: bool, pv: str, base_mode: str | None = None,
                   merge_base: str | None = None) -> None:
    check_schema(hdir, head_sha, fresh)
    stale_meta = (
        fresh or not prompt_matches(hdir, pv)
        or (base_mode is not None and not base_mode_matches(hdir, base_mode))
        or (merge_base is not None and not _meta_matches(hdir, "merge_base", merge_base))
    )
    done = [] if stale_meta else existing_results(hdir, head_sha)
    if done:
        raise AlreadyHunted(f"{label} already has results for head {head_sha[:10]}: {', '.join(done)}. "
                            "Do not start over: continue from the first step whose output is missing, or report. "
                            "Pass --fresh only if the user asked for a new hunt.")
    # The worktrees are about to move: context, responses and verdicts from the previous preparation no longer apply.
    reset_hunt_dir(hdir, include_whole_pr=True)
    for name in ("prepare.json", *RUN_STALE):
        (hdir / name).unlink(missing_ok=True)


def prepare(pr: str, fresh: bool = False) -> None:
    require_disk(scratch())  # worktrees, node_modules and Go builds: refuse early rather than half-prepare
    hdir = hunt_dir(pr)
    pv = build_requests.prompt_version(SKILL_DIR, SCHEMA_VERSION)
    rng = parse_range(pr)
    wt, wt_base = worktree_paths(pr)
    if rng is not None:
        base_spec, head_spec = rng
        two_dot = is_two_dot(pr)
        base_mode = "two-dot" if two_dot else "merge-base"
        mm = mm_clone()
        ensure_clone(mm)
        base_sha, head_sha = resolve_ref(mm, base_spec), resolve_ref(mm, head_spec)
        eff_mb = base_sha if two_dot else git(mm, "merge-base", base_sha, head_sha)
        _prepare_reset(hdir, f"{hdir.name}/", head_sha, fresh, pv, base_mode=base_mode, merge_base=eff_mb)
        head_ref, base_ref, extra = head_sha, base_sha, {"range": [base_spec, head_spec], "base_mode": base_mode}
        base_label, extra_note = base_spec, f", {base_mode}"
        head_note = f" ({head_spec} @ {head_sha[:10]})"
    else:
        meta = pr_meta(pr)
        _prepare_reset(hdir, f"hunt{pr}/", meta["head"]["sha"], fresh, pv)
        mm = mm_clone()
        ensure_clone(mm)
        base = meta["base"]["ref"]
        with clone_fetch_lock(mm):  # parallel hunts share the clone; two fetches of one ref fail with "cannot lock ref"
            git(mm, "fetch", "-q", "origin", f"+pull/{pr}/head:pr-{pr}", f"+{base}:refs/remotes/origin/{base}")
        head_ref, base_ref, extra = f"pr-{pr}", f"origin/{base}", {}
        base_label, extra_note, head_note = base, "", ""
        two_dot = False
    mb = worktrees(mm, head_ref, base_ref, wt, wt_base, two_dot=two_dot)
    go_changed, web_changed = deps(mm, wt, wt_base, mb, head_ref)
    huntable = huntable_changed(mm, mb, head_ref)
    head_resolved = head_ref if rng is not None else git(mm, "rev-parse", head_ref)
    write_json(hdir / "prepare.json", {"schema_version": SCHEMA_VERSION, "pr": pr, **extra, "repo": str(mm),
                                       "wt": str(wt), "wt_base": str(wt_base), "head": head_resolved,
                                       "merge_base": mb, "base_ref": base_label, "prompt_version": pv,
                                       "huntable_files": len(huntable)})
    print(f"ready: head {wt}{head_note}  base {wt_base} ({base_label} @ {mb[:10]}{extra_note})  "
          f"go={go_changed} webapp={web_changed}")


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or sys.argv[2:] not in ([], ["--fresh"]):
            sys.exit("usage: prepare.py <pr | base..head | base...head> [--fresh]")
        main(sys.argv[1], fresh=sys.argv[2:] == ["--fresh"])
    except AlreadyHunted as e:
        print(f"ALREADY_HUNTED {e}")
        sys.exit(4)
    except SchemaMismatch as e:
        print(f"SCHEMA_MISMATCH {e}")
        sys.exit(5)
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
