# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Shared paths, process helpers and state for the /hunt scripts. Stdlib only.

Paths never hard-code a home directory: the scratch area comes from HUNT_SCRATCH (default <tmp>/hunt) and everything
else the skill needs lives inside the skill directory, so it works symlinked or copied into any repository.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parents[1]
LESSONS_FILE = SKILL_DIR / "lessons.jsonl"
SCHEMA_VERSION = 1

REPO = os.environ.get("HUNT_REPO", "mattermost/mattermost")


def scratch() -> Path:
    return Path(os.environ.get("HUNT_SCRATCH") or Path(tempfile.gettempdir()) / "hunt").resolve()


MIN_FREE_BYTES = 2 * 1024**3  # a Go -race build of a Mattermost package plus worktrees needs about this much


def require_disk(path: Path, min_free: int = MIN_FREE_BYTES) -> None:
    """Fail fast with INFRA_ERROR instead of letting a build die halfway with a misleading compile error."""
    p = path
    while not p.exists() and p != p.parent:  # the scratch dir may not exist yet: measure the disk it will live on
        p = p.parent
    free = shutil.disk_usage(p).free
    if free < min_free:
        raise InfraError(f"only {free / 1024**3:.1f} GiB free under {path}; /hunt needs {min_free / 1024**3:.0f} GiB "
                         "for worktrees and Go -race builds: free space or point HUNT_SCRATCH at a larger disk")


def mm_clone() -> Path:
    return Path(os.environ.get("HUNT_MM") or scratch() / "mmfull")


def parse_range(target: str) -> tuple[str, str] | None:
    """Parse '<base>..<head>' or '<base>...<head>' into (base, head), or None for a PR number."""
    s = str(target).strip()
    for sep in ("...", ".."):
        if sep in s:
            base, head = s.split(sep, 1)
            base, head = base.strip(), head.strip()
            if not base or not head:
                raise InfraError(f"invalid range {target!r}: expected <base>..<head> or <base>...<head>")
            return base, head
    return None


def target_key(target: str | int) -> str:
    """Filesystem-safe key for a PR number ('40260') or git range ('release-11..release-12' -> safe slug)."""
    s = str(target).strip()
    rng = parse_range(s)
    if rng is None:
        return s
    canon = f"{rng[0]}...{rng[1]}"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", canon).strip("._-")
    digest = hashlib.sha256(canon.encode()).hexdigest()[:8]
    return f"{slug[:48]}-{digest}" if slug else digest


def hunt_dir(pr: str | int) -> Path:
    return scratch() / f"hunt{target_key(pr)}"


def worktree_paths(pr: str | int) -> tuple[Path, Path]:
    key = target_key(pr)
    return scratch() / f"wt{key}", scratch() / f"wt{key}.base"


class InfraError(RuntimeError):
    """The environment, not the code under test, failed. Printed as INFRA_ERROR and exit code 2."""


@contextmanager
def hunt_lock(hdir: Path, pr: str | int) -> Iterator[None]:
    """One step at a time per PR: prepare.py resets the worktrees, ctx.py rewrites the hunt dir and run.py places
    tests in the worktrees, so any two of them running together would corrupt each other's results."""
    hdir.mkdir(parents=True, exist_ok=True)
    with (hdir / ".lock").open("w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise InfraError(f"another hunt step (prepare.py, ctx.py or run.py) is using PR {pr}; "
                             "run them one at a time") from e
        yield


def node_env() -> dict[str, str]:
    env = dict(os.environ)
    node_bin = os.environ.get("HUNT_NODE_BIN")
    if node_bin:
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    return env


# Variables that point git at a different repository than `cwd`. An inherited GIT_DIR / GIT_WORK_TREE (from a hook or
# an outer git process) would otherwise make `reset --hard` or `clean` run against the caller's checkout.
GIT_LOCATION_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
                     "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX")


def git_env(env: dict[str, str] | None = None) -> dict[str, str]:
    return {k: v for k, v in (os.environ if env is None else env).items() if k not in GIT_LOCATION_VARS}


def sh(args: list[str], cwd: Path, *, check: bool = True, timeout: int = 1800,
       env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command and capture text output. check=True raises InfraError with the tail of the output.
    git always runs with repository-location variables removed, so `cwd` alone selects the repository."""
    if args[:1] == ["git"]:
        env = git_env(env)
    try:
        # errors="replace": a test may print arbitrary bytes (a recorder's generated id "\xff\xfe", PR 39657); a
        # strict decode would crash the whole run instead of yielding a result.
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, errors="replace", timeout=timeout, env=env,
                           check=False)
    except FileNotFoundError as e:
        raise InfraError(f"command not found: {args[0]}") from e
    except subprocess.TimeoutExpired as e:
        raise InfraError(f"timed out after {timeout}s: {' '.join(args)}") from e
    if check and p.returncode != 0:
        raise InfraError(f"{' '.join(args)} (cwd {cwd}) exited {p.returncode}:\n{(p.stdout + p.stderr)[-2500:]}")
    return p


def git(repo: Path, *args: str, check: bool = True) -> str:
    return sh(git_cmd(*args), repo, check=check).stdout.strip()


def git_cmd(*args: str) -> list[str]:
    """git argv whose output does not depend on the user's config: non-ASCII paths verbatim (core.quotePath would
    octal-escape them), no colour codes, standard a/ b/ diff prefixes."""
    return ["git", "-c", "core.quotePath=false", "-c", "color.ui=never", "-c", "diff.noprefix=false", *args]


def terminate_handler(signum: int, _frame: Any) -> None:
    """Turn SIGTERM/SIGHUP into SystemExit so finally cleanup runs instead of leaving dirty worktrees."""
    raise SystemExit(128 + signum)


def clean_untracked(wt: Path) -> None:
    """Remove untracked files left by tests without choking on spaces or quoted paths."""
    raw = sh(git_cmd("status", "--porcelain", "-z", "--untracked-files=all"), wt).stdout
    for entry in raw.split("\0"):
        if not entry.startswith("?? "):
            continue
        rel = entry[3:]
        if "node_modules" not in rel and "go.work" not in rel:
            under(wt, rel).unlink(missing_ok=True)


def read_text_lossy(path: Path) -> str:
    """Read UTF-8 text, replacing undecodable bytes instead of raising UnicodeDecodeError."""
    return path.read_text(encoding="utf-8", errors="replace")


def load_json(path: Path) -> Any:
    """Load JSON written by a model. Repairs only invalid backslash escapes, the one defect seen in practice."""
    return loads_lossy(read_text_lossy(path))


def loads_lossy(raw: str) -> Any:
    """json.loads with the same backslash repair as load_json, for model text that is not on disk."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Keep valid escapes (including an escaped backslash) and double every other lone backslash.
        return json.loads(re.sub(r'\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\',
                                 lambda m: m.group(0) if m.group(1) else "\\\\", raw))


def read_dict(path: Path) -> dict[str, Any]:
    """A JSON object file, or {} when it is missing or holds something else."""
    if not path.exists():
        return {}
    data = load_json(path)
    return data if isinstance(data, dict) else {}


def read_optional_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def read_optional_dict(path: Path) -> dict[str, Any]:
    data = read_optional_json(path)
    return data if isinstance(data, dict) else {}


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1))


def write_atomic(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    write_json(tmp, data)
    os.replace(tmp, path)


def run_locked_cli(pr: str, hdir: Path, fn: Callable[[], int]) -> int:
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, terminate_handler)
    try:
        with hunt_lock(hdir, pr):
            return fn()
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2


def read_state(hdir: Path) -> dict[str, Any]:
    p = hdir / "state.json"
    if not p.exists():
        raise InfraError(f"{p} missing: run prepare.py and ctx.py first")
    return json.loads(p.read_text())


def under(root: Path, rel: str) -> Path:
    """Resolve rel inside root, refusing absolute paths and '..' escapes (model output chooses these paths)."""
    p = (root / rel).resolve()
    if p != root.resolve() and root.resolve() not in p.parents:
        raise ValueError(f"path escapes {root}: {rel}")
    return p
