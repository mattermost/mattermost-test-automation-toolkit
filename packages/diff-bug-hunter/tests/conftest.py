# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Shared pytest fixtures, path constants, and test helpers for diff-bug-hunter."""
from __future__ import annotations

import http.server
import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

TESTS_DIR = Path(__file__).resolve().parent
ROOT = TESTS_DIR.parent
SKILL = ROOT / ".claude" / "skills" / "hunt"
SCRIPTS = SKILL / "scripts"
EVAL_DIR = ROOT / "eval"
VERIFY_SCRIPTS = ROOT / ".claude" / "skills" / "verify" / "scripts"
VERIFY_UI = VERIFY_SCRIPTS / "verify_ui.mjs"
VERIFY_DEPS = TESTS_DIR / "verify_fixtures" / "node_modules"
FIX = TESTS_DIR / "hunt_fixtures"
JESTDEPS = FIX / "jestdeps" / "node_modules"

for p in (TESTS_DIR, SCRIPTS, EVAL_DIR, VERIFY_SCRIPTS):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture(autouse=True)
def _no_user_git_config(monkeypatch, tmp_path):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("HUNT_SCRATCH", str(tmp_path / "scratch"))


_GIT_BASE_ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
}


def git_test_env(when: str | None = None) -> dict[str, str]:
    import hunt_common
    env = {**hunt_common.git_env(), **_GIT_BASE_ENV}
    if when:
        env.update(GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    return env


GIT_ENV = git_test_env()


def _git(repo: Path, *args: str, when: str | None = None) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True,
                          env=git_test_env(when)).stdout.strip()


def overlay(src: Path, dst: Path) -> None:
    for p in src.rglob("*"):
        if p.is_file():
            out = dst / p.relative_to(src)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, out)


def write_files(root: Path, files: dict[str, str]) -> None:
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)


def make_repo(
    tmp: Path,
    base: dict[str, str] | str,
    head: dict[str, str] | str | None = None,
    *,
    head_msg: str = "head",
    base_msg: str = "base",
    dirname: str = "repo",
    branch: str = "master",
    feature_branch: str | None = "feature",
) -> Path:
    """Create a 2-commit git repo from dicts or fixture name, optionally advancing on `feature_branch`."""
    repo = tmp / dirname
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q", "-b", branch)

    def _apply(spec: dict[str, str] | str, side: str) -> None:
        if isinstance(spec, str):
            overlay(FIX / spec / side, repo)
        else:
            write_files(repo, spec)

    _apply(base, "base")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", base_msg)
    if head is not None:
        if feature_branch:
            _git(repo, "checkout", "-qb", feature_branch)
        _apply(head, "head")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", head_msg)
    return repo


def make_hunt(tmp: Path, name: str) -> tuple[Path, dict[str, Any]]:
    """Repo with master=base and feature=base+head, worktrees via prepare.worktrees, context via ctx.build."""
    import ctx
    import prepare

    repo = make_repo(tmp, name, name)
    wt, wt_base = tmp / "wt", tmp / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    for w in (wt, wt_base):
        if (w / "web").is_dir():
            (w / "web" / "node_modules").symlink_to(JESTDEPS)
    hdir = tmp / "hunt"
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    state = ctx.build("1", 1, prep, {"title": f"fixture {name}", "body": "Clamp keeps values in range."})
    shutil.copytree(FIX / name / "responses", hdir, dirs_exist_ok=True)
    return hdir, state


REQUIRE_DEPS = bool(os.environ.get("HUNT_REQUIRE_DEPS"))
TOKEN = "tok-123"
needs_jest = pytest.mark.skipif(not REQUIRE_DEPS and not JESTDEPS.is_dir(), reason="run `make jest-deps` first")


def _node_env(auth: str = "password") -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("VERIFY_")}
    if auth == "password":
        env.update(VERIFY_USER="tester", VERIFY_PASSWORD="pw")
    elif auth == "token":
        env["VERIFY_TOKEN"] = TOKEN
    paths = [str(VERIFY_DEPS)] + [p for p in env.get("NODE_PATH", "").split(os.pathsep) if p]
    env["NODE_PATH"] = os.pathsep.join(paths)
    if os.environ.get("HUNT_NODE_BIN"):
        env["PATH"] = f"{os.environ['HUNT_NODE_BIN']}{os.pathsep}{env['PATH']}"
    return env


def _playwright_available() -> bool:
    try:
        check = "const fs = require('fs'); process.exit(fs.existsSync(require('playwright').chromium.executablePath()) ? 0 : 1)"
        p = subprocess.run(["node", "-e", check], env=_node_env(), capture_output=True, check=False)
    except FileNotFoundError:
        return False
    return p.returncode == 0


def _node_available() -> bool:
    try:
        return subprocess.run(["node", "-v"], env=_node_env("none"), capture_output=True, check=False).returncode == 0
    except FileNotFoundError:
        return False


needs_node = pytest.mark.skipif(not REQUIRE_DEPS and not _node_available(), reason="node not on PATH")
needs_playwright = pytest.mark.skipif(not REQUIRE_DEPS and not _playwright_available(), reason="run `make verify-deps` first")


def _module(expr: str) -> str:
    """Evaluate an expression against verify_ui.mjs's exports in a fresh node (no browser)."""
    code = f"import(process.env.VERIFY_UI_MODULE).then((m) => console.log(JSON.stringify({expr})))"
    p = subprocess.run(["node", "-e", code], env={**_node_env("none"), "VERIFY_UI_MODULE": str(VERIFY_UI)},
                       capture_output=True, text=True, check=True)
    return p.stdout.strip()


def run_frozen_spec(
    tmp: Path, spec_name: str, *, auth: str = "password", env: dict[str, str] | None = None,
    check_tsc: bool = False, run_test: bool = True,
) -> subprocess.CompletedProcess[str] | None:
    nm = tmp / "node_modules"
    if not nm.exists():
        nm.symlink_to(VERIFY_DEPS)
    if check_tsc:
        (tmp / "tsconfig.json").write_text(json.dumps({"compilerOptions": {
            "strict": True, "noEmit": True, "target": "es2022", "module": "esnext", "moduleResolution": "bundler",
            "types": ["node"], "skipLibCheck": True}, "files": [spec_name]}))
        tc = subprocess.run(["node", str(VERIFY_DEPS / "typescript" / "bin" / "tsc"), "-p", "."], cwd=tmp,
                            env=_node_env("none"), capture_output=True, text=True, timeout=180, check=False)
        assert tc.returncode == 0, tc.stdout + tc.stderr
    if not run_test:
        return None
    cli = VERIFY_DEPS / "@playwright" / "test" / "cli.js"
    return subprocess.run(["node", str(cli), "test", spec_name, "--reporter=line"], cwd=tmp,
                          env={**_node_env(auth), **(env or {})},
                          capture_output=True, text=True, timeout=180, check=False)


def assert_clean_wts(state: dict[str, Any], *, check_testdata: bool = False) -> None:
    import run
    for key in ("wt", "wt_base"):
        wt = Path(state[key])
        assert not list(wt.rglob("hunt_*"))
        if check_testdata:
            assert not (wt / "calc" / "testdata").exists()
        run.ensure_clean(wt)


def wts_clean(*wts: str | Path) -> bool:
    import run
    try:
        for wt in wts:
            run.ensure_clean(Path(wt))
    except run.InfraError:
        return False
    return True


class JsonHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass

    def _send(self, code: int, body: Any = "", ctype: str | None = "application/json",
              headers: dict[str, str] | None = None) -> None:
        self.send_response(code)
        if ctype:
            self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body is not None:
            self.wfile.write((body if isinstance(body, str) else json.dumps(body)).encode())


@contextmanager
def http_server(handler_cls: type[http.server.BaseHTTPRequestHandler], **attrs: Any) -> Iterator[tuple[Any, str]]:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    for k, v in attrs.items():
        setattr(srv, k, v)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv, f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def cli_json(
    answer: object, *, markdown: bool = False, stop_reason: str | None = None, subtype: str | None = None,
    is_error: bool | None = None, total_cost_usd: float = 0.5, usage: dict[str, int] | None = None,
) -> str:
    result = f"Here it is:\n```json\n{json.dumps(answer)}\n```" if markdown else json.dumps(answer)
    payload: dict[str, Any] = {
        "result": result,
        "total_cost_usd": total_cost_usd,
        "usage": usage or {"input_tokens": 4, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 1, "output_tokens": 4},
    }
    if stop_reason is not None:
        payload["stop_reason"] = stop_reason
    if subtype is not None:
        payload["subtype"] = subtype
    if is_error is not None:
        payload["is_error"] = is_error
    return json.dumps(payload)


def vetted_row(**over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "p::TestHuntA_X", "source": "A", "decision": "KEEP", "reason": "real",
        "file_line": "server/x.go:10", "caller": "api4 POST /x", "entry_point": "api4 POST /api/v4/x",
        "repro_cmd": "go test ./server/x -run TestHuntA_X", "evidence_path": "run_A.json",
        "severity": "major", "fix_check": None,
    }
    row.update(over)
    return row


FAKE_DISPATCH = '''
import json, os, sys
from pathlib import Path
req = Path(sys.argv[-1])
data = json.loads(req.read_text())
tag = req.parent.name
with Path(os.environ["FAKE_LOG"]).open("a") as fh:
    fh.write(tag + "\\n")
src = Path(os.environ["FAKE_RESPONSES"]) / tag / "response.json"
if src.exists():
    text = src.read_text()
elif tag == "vet":
    text = json.dumps({"rows": []})
else:
    text = json.dumps({"files": [], "tests": []})
Path(data["response_path"]).write_text(text)
'''


def fake_script(tmp: Path, name: str, body: str) -> str:
    path = tmp / name
    path.write_text(body)
    return f"{shlex.quote(sys.executable)} {shlex.quote(str(path))}"


def e2e_repo(tmp: Path, name: str, monkeypatch: pytest.MonkeyPatch) -> Path:
    import trusted
    repo = make_repo(tmp, name, name)
    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    return repo


def canned_responses(tmp: Path, name: str, row_id: str, source: str) -> tuple[Path, Path]:
    responses = tmp / "responses"
    shutil.copytree(FIX / name / "responses" / "A", responses / "A")
    (responses / "vet").mkdir(parents=True)
    row = vetted_row(
        id=row_id, source=source,
        reason="The hunted input returns a value outside the documented range.",
        file_line="calc/calc.go:1", caller="calc.Clamp is the exported API the PR changes",
        entry_point="calc.Clamp (library API)", repro_cmd=f"go test ./calc -run {row_id.split('::')[1]}",
    )
    (responses / "vet" / "response.json").write_text(json.dumps({"rows": [row]}))
    return responses, tmp / "dispatch.log"
