# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Shared paths, process helpers and state for the /hunt scripts. Stdlib only.

Paths never hard-code a home directory: the scratch area comes from HUNT_SCRATCH (default <tmp>/hunt) and everything
else the skill needs lives inside the skill directory, so it works symlinked or copied into any repository.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parents[1]
PROMPTS_DIR = SKILL_DIR / "prompts"
LESSONS_FILE = SKILL_DIR / "lessons.jsonl"
DISPATCH_TEMPLATE = SKILL_DIR / "dispatch.md"

REPO = os.environ.get("HUNT_REPO", "mattermost/mattermost")


def scratch() -> Path:
    return Path(os.environ.get("HUNT_SCRATCH") or Path(tempfile.gettempdir()) / "hunt")


def mm_clone() -> Path:
    return Path(os.environ.get("HUNT_MM") or scratch() / "mmfull")


def hunt_dir(pr: str | int) -> Path:
    return scratch() / f"hunt{pr}"


class InfraError(RuntimeError):
    """The environment, not the code under test, failed. Printed as INFRA_ERROR and exit code 2."""


def node_env() -> dict[str, str]:
    env = dict(os.environ)
    node_bin = os.environ.get("HUNT_NODE_BIN")
    if node_bin:
        env["PATH"] = f"{node_bin}{os.pathsep}{env.get('PATH', '')}"
    return env


def sh(args: list[str], cwd: Path, *, check: bool = True, timeout: int = 1800,
       env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command and capture text output. check=True raises InfraError with the tail of the output."""
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env, check=False)
    except FileNotFoundError as e:
        raise InfraError(f"command not found: {args[0]}") from e
    except subprocess.TimeoutExpired as e:
        raise InfraError(f"timed out after {timeout}s: {' '.join(args)}") from e
    if check and p.returncode != 0:
        raise InfraError(f"{' '.join(args)} (cwd {cwd}) exited {p.returncode}:\n{(p.stdout + p.stderr)[-2500:]}")
    return p


def git(repo: Path, *args: str, check: bool = True) -> str:
    return sh(["git", *args], repo, check=check).stdout.strip()


def load_json(path: Path) -> Any:
    """Load JSON written by a model. Repairs only invalid backslash escapes, the one defect seen in practice."""
    raw = path.read_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", raw))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1))


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
