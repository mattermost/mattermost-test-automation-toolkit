#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""A PR's server for /verify, from the mattermost repo's own e2e stack (e2e-tests/.ci): a published image, no build.

usage: pr_server.py images <pr> [--pull]   print the enterprise image tags of the PR head and its merge-base;
                                           --pull pulls both at once (start it in the background when the hunt starts:
                                           a cold pull is 10-15 min, the check itself seconds)
       pr_server.py up <image> [--e2e <dir>]
                                           run the repo stack on that image (http://localhost:8065), replacing a server
                                           on another build (its volumes are dropped), check the running build is that image, then seed an admin for /verify
       pr_server.py down [--e2e <dir>]

--e2e defaults to $MM_E2E_DIR, else <cwd>/e2e-tests (searching upward from the current directory), else
$HUNT_MM/e2e-tests. The stack is `make start-server` with
TEST=none and only postgres + inbucket. Its containers use host networking: on Docker Desktop (macOS) turn on
Settings > Resources > Network > Enable host networking. One stack per machine (port 8065), so base and head run one
after the other; `up` and `down` hold a lock in the system temp dir (leaving e2e-tests/ clean) and `up` replaces a
server that runs another build (make stop-server
drops its volumes), so a plan never runs against the wrong build. (The repo's Playwright Testcontainers stack was tried: its env-pinned settings,
e.g. ServiceSettings.SiteURL, are read-only in the System Console, and an image swap took 166 s against ~100 s here.)
Seeding: the first user on a fresh server becomes system admin. $VERIFY_USER / $VERIFY_PASSWORD are created if
missing, a team `verify` is made, and the onboarding task list is turned off (its overlay intercepts clicks).
Exit codes: 0 ok, 2 INFRA_ERROR (image not published, server not up, wrong build, seeding failed).
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

REPO = os.environ.get("HUNT_REPO", "mattermost/mattermost")
IMAGE_REPO = "mattermostdevelopment/mattermost-enterprise-edition"
SERVER_URL = "http://localhost:8065"  # the e2e stack's fixed port (e2e-tests/.ci/server.generate.sh)
MEMBER_USER = "verify_member"  # regular non-admin account seeded alongside VERIFY_USER for RBAC / permission checks
STACK_ENV = {"TEST": "none", "ENABLED_DOCKER_SERVICES": "postgres inbucket"}
# Onboarding preferences that put an overlay over the app (webapp components/onboarding_tasks/constants.ts).
ONBOARDING_OFF = [("onboarding_task_list", "onboarding_task_list_show", "false"),
                  ("onboarding_task_list", "onboarding_task_list_open", "false"),
                  ("onboarding_task_list", "declined_onboarding_task_list", "true"),
                  ("recommended_next_steps", "hide", "true")]


class InfraError(RuntimeError):
    pass


def default_e2e(cwd: Path | None = None) -> Path:
    """Locate mattermost's e2e-tests dir: $MM_E2E_DIR, else an e2e-tests dir above cwd, else $HUNT_MM/e2e-tests."""
    if os.environ.get("MM_E2E_DIR"):
        return Path(os.environ["MM_E2E_DIR"])
    cur = (cwd or Path.cwd()).resolve()
    for base in (cur, *cur.parents):
        for cand in (base, base / "e2e-tests"):
            if (cand / ".ci" / "server.generate.sh").exists():
                return cand
    if os.environ.get("HUNT_MM"):
        return Path(os.environ["HUNT_MM"]) / "e2e-tests"
    return cur / "e2e-tests"


def lock_path() -> Path:
    """One stack per machine (port 8065): keep the lock in tempdir so e2e-tests/ never gets an untracked file."""
    return Path(tempfile.gettempdir()) / "mm-pr-server-8065.lock"


def image_for(sha: str) -> str:
    """CI publishes one enterprise image per commit, tagged with the first 7 characters of its sha."""
    if len(sha) < 7 or not all(c in "0123456789abcdef" for c in sha.lower()):
        raise InfraError(f"not a commit sha: {sha!r}")
    return f"{IMAGE_REPO}:{sha[:7].lower()}"


def build_matches(build_hash: str, image: str) -> bool:
    """True if a server reporting BuildHash runs `image` (whose tag is a short sha)."""
    tag = image.rsplit(":", 1)[-1]
    return bool(build_hash) and len(tag) >= 7 and build_hash.lower().startswith(tag.lower())


def gh_json(path: str) -> Any:
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=False)
    if p.returncode:
        raise InfraError(f"gh api {path}: {p.stderr.strip()[-300:]}")
    return json.loads(p.stdout)


def pr_images(target: str) -> dict[str, str]:
    """Enterprise image tags for a PR number or a git range (`base..head` / `base...head`)."""
    for sep in ("...", ".."):
        if sep in target:
            base_ref, head_ref = (s.strip() for s in target.split(sep, 1))
            if not base_ref or not head_ref:
                raise InfraError(f"invalid range {target!r}: expected <base>..<head> or <base>...<head>")
            merge_base = gh_json(f"repos/{REPO}/compare/{base_ref}...{head_ref}")["merge_base_commit"]["sha"]
            head = gh_json(f"repos/{REPO}/commits/{head_ref}")["sha"]
            return {"head": image_for(head), "base": image_for(merge_base)}
    meta = gh_json(f"repos/{REPO}/pulls/{target}")
    head = meta["head"]["sha"]
    head_ref = meta["head"].get("label") or head  # owner:branch works for fork PRs as well as same-repo PRs
    merge_base = gh_json(f"repos/{REPO}/compare/{meta['base']['sha']}...{head_ref}")["merge_base_commit"]["sha"]
    return {"head": image_for(head), "base": image_for(merge_base)}


def pull(image: str) -> str | None:
    """None when pulled, else the reason (a commit CI has not built yet has no image)."""
    p = subprocess.run(["docker", "pull", "--platform", "linux/amd64", image], capture_output=True, text=True,
                       check=False)
    return None if p.returncode == 0 else (p.stderr.strip().splitlines() or ["docker pull failed"])[-1]


def request(method: str, url: str, body: Any = None, token: str | None = None, timeout: float = 10) -> tuple[Any, Any]:
    h = {"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=timeout) as r:
        raw = r.read()
        return r.headers, json.loads(raw) if raw else None


def running_build(url: str) -> str | None:
    """BuildHash of the server answering at url, or None if nothing answers."""
    try:
        _, cfg = request("GET", f"{url}/api/v4/config/client?format=old", timeout=5)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return str((cfg or {}).get("BuildHash") or "")


def _error_id(e: urllib.error.HTTPError) -> str:
    try:
        return str(json.loads(e.read() or b"{}").get("id") or "")
    except ValueError:
        return ""


def seed(url: str, user: str, password: str) -> None:
    """Admin `user` (the first account on a fresh server is system admin), non-admin `verify_member`, team `verify`,
    and onboarding off for both."""
    try:
        request("POST", f"{url}/api/v4/users", {"username": user, "email": f"{user}@example.com", "password": password})
    except urllib.error.HTTPError as e:
        reason = _error_id(e)
        if reason != "app.user.save.username_exists.app_error":  # an existing user is fine (a reused server)
            raise InfraError(f"creating {user}: HTTP {e.code} {reason}") from e
    try:
        hdr, me = request("POST", f"{url}/api/v4/users/login", {"login_id": user, "password": password})
    except urllib.error.HTTPError as e:
        raise InfraError(f"logging in as {user}: HTTP {e.code} (another password on a reused server?)") from e
    token = hdr.get("Token")
    if not token:
        raise InfraError(f"logging in as {user}: no session token in the response")
    if "system_admin" not in (me.get("roles") or ""):
        raise InfraError(f"{user} is not a system admin: the server already had users before seeding")
    team_id = ""
    try:
        _, team = request("POST", f"{url}/api/v4/teams", {"name": "verify", "display_name": "Verify", "type": "O"}, token)
        team_id = (team or {}).get("id") or ""
    except urllib.error.HTTPError as e:
        if e.code != 400:
            raise InfraError(f"creating team verify: HTTP {e.code}") from e
        try:
            _, team = request("GET", f"{url}/api/v4/teams/name/verify", token=token)
            team_id = (team or {}).get("id") or ""
        except urllib.error.HTTPError:
            team_id = ""
    prefs = [{"user_id": me["id"], "category": c, "name": n, "value": v} for c, n, v in ONBOARDING_OFF]
    request("PUT", f"{url}/api/v4/users/{me['id']}/preferences", prefs, token)
    if user != MEMBER_USER:
        member_id = ""
        try:
            _, member = request("POST", f"{url}/api/v4/users",
                                {"username": MEMBER_USER, "email": f"{MEMBER_USER}@example.com", "password": password})
            member_id = (member or {}).get("id") or ""
        except urllib.error.HTTPError as e:
            reason = _error_id(e)
            if reason != "app.user.save.username_exists.app_error":
                raise InfraError(f"creating {MEMBER_USER}: HTTP {e.code} {reason}") from e
            try:
                _, member = request("GET", f"{url}/api/v4/users/username/{MEMBER_USER}", token=token)
                member_id = (member or {}).get("id") or ""
            except urllib.error.HTTPError:
                member_id = ""
        if member_id:
            if team_id:
                try:
                    request("POST", f"{url}/api/v4/teams/{team_id}/members",
                            {"team_id": team_id, "user_id": member_id}, token)
                except urllib.error.HTTPError as e:
                    if e.code not in (400, 404):
                        raise InfraError(f"adding {MEMBER_USER} to team verify: HTTP {e.code}") from e
            mprefs = [{"user_id": member_id, "category": c, "name": n, "value": v} for c, n, v in ONBOARDING_OFF]
            request("PUT", f"{url}/api/v4/users/{member_id}/preferences", mprefs, token)


def make(e2e: Path, target: str, image: str) -> None:
    p = subprocess.run(["make", target], cwd=e2e, env={**os.environ, **STACK_ENV, "SERVER_IMAGE": image},
                       capture_output=True, text=True, check=False)
    if p.returncode:
        raise InfraError(f"make {target} failed:\n{(p.stdout + p.stderr)[-1500:]}")


def _require_e2e(e2e: Path) -> None:
    if not (e2e / ".ci" / "server.generate.sh").exists():
        raise InfraError(f"{e2e} is not the mattermost repo's e2e-tests dir (pass --e2e or set MM_E2E_DIR)")


def up(image: str, e2e: Path) -> None:
    user, password = os.environ.get("VERIFY_USER"), os.environ.get("VERIFY_PASSWORD")
    if not (user and password):
        raise InfraError("set VERIFY_USER and VERIFY_PASSWORD (the admin /verify will log in as)")
    _require_e2e(e2e)
    with open(lock_path(), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # two swaps at once would leave one plan on the other's build
        build = running_build(SERVER_URL)
        if build is None or not build_matches(build, image):
            if build is not None:
                print(f"server on {SERVER_URL} runs {build[:10]}, not {image}: replacing it")
            started = time.time()
            make(e2e, "stop-server", image)
            make(e2e, "start-server", image)
            print(f"stack up in {time.time() - started:.0f}s")
        build = running_build(SERVER_URL)
        if build is None or not build_matches(build, image):
            raise InfraError(f"{SERVER_URL} runs {build!r}, expected {image} (host networking off?)")
        seed(SERVER_URL, user, password)
    print(f"VERIFY_BASE_URL={SERVER_URL} build={build[:10]} VERIFY_MEMBER_USER={MEMBER_USER}")


def down(e2e: Path) -> None:
    _require_e2e(e2e)
    with open(lock_path(), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        make(e2e, "stop-server", f"{IMAGE_REPO}:master")


def main(argv: list[str]) -> None:
    argv = list(argv)
    e2e_dir = None
    if "--e2e" in argv:
        i = argv.index("--e2e")
        if i + 1 >= len(argv) or argv[i + 1].startswith("-"):
            sys.exit(__doc__)
        e2e_dir = argv[i + 1]
        del argv[i:i + 2]
    e2e = Path(e2e_dir) if e2e_dir else default_e2e()
    pull_too = "--pull" in argv
    args = [a for a in argv if a != "--pull"]
    if args[:1] == ["images"] and len(args) == 2:
        imgs = pr_images(args[1])
        print(json.dumps(imgs))
        if pull_too:
            with ThreadPoolExecutor(2) as ex:
                for side, err in zip(imgs, ex.map(pull, imgs.values()), strict=True):
                    print(f"{side} {imgs[side]}: {'pulled' if err is None else 'NOT AVAILABLE: ' + err}")
    elif args[:1] == ["up"] and len(args) == 2:
        up(args[1], e2e)
    elif args == ["down"]:
        down(e2e)
    else:
        sys.exit(__doc__)


def run_cli(argv: list[str]) -> None:
    try:
        main(argv)
    except (InfraError, OSError) as e:  # OSError: a missing gh/docker/make, or the server dropped the connection
        print(f"INFRA_ERROR {e}")
        sys.exit(2)


if __name__ == "__main__":
    run_cli(sys.argv[1:])
