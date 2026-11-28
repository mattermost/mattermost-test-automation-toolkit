#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""A PR's server for /verify, from the mattermost repo's own e2e stack (e2e-tests/.ci): a published image, no build.

usage: pr_server.py images <pr> [--pull]   print the enterprise image tags of the PR head and its merge-base;
                                           --pull pulls both at once (start it in the background when the hunt starts:
                                           a cold pull is 10-15 min, the check itself seconds)
       pr_server.py up <image> [--e2e <dir>] [--flags A,B] [--flags-from-diff <base>..<head>] [--require-license]
                                           run the repo stack on that image (http://localhost:8065), replacing a server
                                           on another build (its volumes are dropped), check the running build is that image, then seed an admin for /verify
       pr_server.py down [--e2e <dir>]

images: a range `base..head` uses `base` itself as the base image; `base...head` and a PR use the merge-base. When the
base image is not published, the nearest published first-parent ancestor (at most 20 back) is used and the substitution
is printed (`BASE_SUBSTITUTION ...`); none within 20 = INFRA_ERROR, so the report can say "skipped: no image".
License (up): $MM_LICENSE_FILE (a path) or $MM_LICENSE (the text) is uploaded with POST /api/v4/license after seeding and
is never printed. A missing license is only an error with --require-license.
Flags (up): --flags FeatureA,FeatureB and/or --flags-from-diff <base>..<head> (every `FeatureFlags.<Name>` on an added
line of `git diff`, run in the current directory) set MM_FEATUREFLAGS_<NAME>=true on the server through the stack's
MM_ENV. A server started with another flag profile is replaced. The profile is printed (`PROFILE flags=... license=...`).

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

import contextlib
import fcntl
import json
import os
import re
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


FLAG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
DIFF_FLAG_RE = re.compile(r"FeatureFlags\.([A-Za-z][A-Za-z0-9_]*)")
RANGE_RE = re.compile(r"^[\w./~^@:+-]+\.{2,3}[\w./~^@:+-]+$")
MAX_ANCESTOR_WALK = 20


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


def profile_path() -> Path:
    """The feature-flag profile the running stack was started with (tempdir, next to the lock)."""
    return Path(tempfile.gettempdir()) / "mm-pr-server-8065.profile"


def parse_flags(raw: str) -> list[str]:
    """`FeatureA,FeatureB` -> sorted unique names; a name that could break the comma-separated MM_ENV is refused."""
    names = [n.strip() for n in raw.split(",") if n.strip()]
    for n in names:
        if not FLAG_RE.match(n):
            raise InfraError(f"not a feature flag name: {n!r}")
    return sorted(set(names), key=str.upper)


def flags_from_diff(target: str, cwd: Path | None = None) -> list[str]:
    """Feature flags a diff range touches: `FeatureFlags.<Name>` on its added lines."""
    if not RANGE_RE.match(target) or target.startswith("-"):
        raise InfraError(f"invalid range {target!r}: expected <base>..<head> or <base>...<head>")
    p = subprocess.run(["git", "diff", "--no-ext-diff", "--no-color", target, "--"], cwd=cwd, capture_output=True,
                       text=True, check=False)
    if p.returncode:
        raise InfraError(f"git diff {target}: {p.stderr.strip()[-300:]}")
    found = {m for line in p.stdout.splitlines() if line.startswith("+") and not line.startswith("+++")
             for m in DIFF_FLAG_RE.findall(line)}
    return sorted(found, key=str.upper)


def flags_env(flags: list[str]) -> str:
    """The stack's MM_ENV value (comma-separated KEY=value pairs) for these flags."""
    return ",".join(f"MM_FEATUREFLAGS_{f.upper()}=true" for f in flags)


def read_license(environ: Any = None) -> str | None:
    """License text from $MM_LICENSE_FILE (a path) or $MM_LICENSE; None when neither is set or both are empty."""
    env = os.environ if environ is None else environ
    path = env.get("MM_LICENSE_FILE")
    if path:
        try:
            text = Path(path).read_text().strip()
        except OSError as e:
            raise InfraError(f"MM_LICENSE_FILE {path} is not readable: {e.strerror or type(e).__name__}") from e
        return text or None
    return (env.get("MM_LICENSE") or "").strip() or None


def upload_license(url: str, token: str, text: str) -> None:
    """POST /api/v4/license (multipart field `license`). Errors carry the status and error id only, never the license."""
    boundary = "----pr-server-license"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"license\"; filename=\"mattermost.mattermost-license\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n{text}\r\n--{boundary}--\r\n").encode()
    req = urllib.request.Request(f"{url}/api/v4/license", data=body, method="POST", headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}", "X-Requested-With": "XMLHttpRequest",
        "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30):
            pass
    except urllib.error.HTTPError as e:
        raise InfraError(f"uploading the license: HTTP {e.code} {_error_id(e)}") from e


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


def pr_shas(target: str) -> dict[str, str]:
    """Head and base commit shas for a PR number or a git range. `base..head` uses base itself; `base...head` and a PR
    use the merge-base."""
    for sep in ("...", ".."):
        if sep in target:
            base_ref, head_ref = (s.strip() for s in target.split(sep, 1))
            if not base_ref or not head_ref:
                raise InfraError(f"invalid range {target!r}: expected <base>..<head> or <base>...<head>")
            head = gh_json(f"repos/{REPO}/commits/{head_ref}")["sha"]
            base = (gh_json(f"repos/{REPO}/compare/{base_ref}...{head_ref}")["merge_base_commit"]["sha"]
                    if sep == "..." else gh_json(f"repos/{REPO}/commits/{base_ref}")["sha"])
            return {"head": head, "base": base}
    meta = gh_json(f"repos/{REPO}/pulls/{target}")
    head = meta["head"]["sha"]
    head_ref = meta["head"].get("label") or head  # owner:branch works for fork PRs as well as same-repo PRs
    base = gh_json(f"repos/{REPO}/compare/{meta['base']['sha']}...{head_ref}")["merge_base_commit"]["sha"]
    return {"head": head, "base": base}


def pr_images(target: str) -> dict[str, str]:
    """Enterprise image tags for a PR number or a git range (`base..head` / `base...head`)."""
    shas = pr_shas(target)
    return {"head": image_for(shas["head"]), "base": image_for(shas["base"])}


def published(image: str) -> bool:
    """True if the registry has the image (`docker manifest inspect`, no pull). A registry or network failure is an
    InfraError, not "unpublished", so a flaky connection never triggers a substitution."""
    p = subprocess.run(["docker", "manifest", "inspect", image], capture_output=True, text=True, check=False)
    if p.returncode == 0:
        return True
    err = p.stderr.lower()
    if "no such manifest" in err or "not found" in err or "manifest unknown" in err:
        return False
    raise InfraError(f"docker manifest inspect {image}: {(p.stderr.strip().splitlines() or ['failed'])[-1]}")


def nearest_published(sha: str, max_back: int = MAX_ANCESTOR_WALK) -> tuple[str, int] | None:
    """First-parent walk from `sha` (itself excluded) to the nearest commit with a published image: (image, depth)."""
    cur = sha
    for depth in range(1, max_back + 1):
        parents = gh_json(f"repos/{REPO}/commits/{cur}").get("parents") or []
        if not parents:
            return None
        cur = parents[0]["sha"]
        image = image_for(cur)
        if published(image):
            return image, depth
    return None


def substitute_base(imgs: dict[str, str]) -> tuple[dict[str, str], str | None]:
    """An unpublished base image is replaced by its nearest published first-parent ancestor.
    Returns (images, substitution message or None)."""
    if published(imgs["base"]):
        return imgs, None
    found = nearest_published(imgs["base"].rsplit(":", 1)[-1])
    if found is None:
        raise InfraError(f"base image {imgs['base']} is not published and no first-parent ancestor within "
                         f"{MAX_ANCESTOR_WALK} commits is: skipped: no image")
    image, depth = found
    note = (f"BASE_SUBSTITUTION requested={imgs['base']} using={image} first_parent_ancestor={depth} "
            f"(the base is {depth} commit(s) older than the real base)")
    return {**imgs, "base": image}, note


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


def _create_user(url: str, username: str, password: str, token: str | None = None) -> str:
    try:
        _, user = request("POST", f"{url}/api/v4/users",
                          {"username": username, "email": f"{username}@example.com", "password": password},
                          token=token)
        return str((user or {}).get("id") or "")
    except urllib.error.HTTPError as e:
        reason = _error_id(e)
        if reason != "app.user.save.username_exists.app_error":  # an existing user is fine (a reused server)
            raise InfraError(f"creating {username}: HTTP {e.code} {reason}") from e
    if token:
        try:
            _, user = request("GET", f"{url}/api/v4/users/username/{username}", token=token)
            return str((user or {}).get("id") or "")
        except urllib.error.HTTPError:
            return ""
    return ""


def _disable_onboarding(url: str, uid: str, token: str) -> None:
    prefs = [{"user_id": uid, "category": c, "name": n, "value": v} for c, n, v in ONBOARDING_OFF]
    request("PUT", f"{url}/api/v4/users/{uid}/preferences", prefs, token)


def seed(url: str, user: str, password: str, license_text: str | None = None) -> None:
    """Admin `user` (the first account on a fresh server is system admin), non-admin `verify_member`, team `verify`,
    and onboarding off for both. `license_text` is uploaded as the server license once the admin is logged in."""
    _create_user(url, user, password)
    try:
        hdr, me = request("POST", f"{url}/api/v4/users/login", {"login_id": user, "password": password})
    except urllib.error.HTTPError as e:
        raise InfraError(f"logging in as {user}: HTTP {e.code} (another password on a reused server?)") from e
    token = hdr.get("Token")
    if not token:
        raise InfraError(f"logging in as {user}: no session token in the response")
    if "system_admin" not in (me.get("roles") or ""):
        raise InfraError(f"{user} is not a system admin: the server already had users before seeding")
    if license_text:
        upload_license(url, token, license_text)
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
        except urllib.error.HTTPError as lookup_err:
            raise InfraError(f"looking up team verify: HTTP {lookup_err.code}") from lookup_err
    _disable_onboarding(url, me["id"], token)
    if user != MEMBER_USER:
        member_id = _create_user(url, MEMBER_USER, password, token=token)
        if member_id:
            if team_id:
                try:
                    request("POST", f"{url}/api/v4/teams/{team_id}/members",
                            {"team_id": team_id, "user_id": member_id}, token)
                except urllib.error.HTTPError as e:
                    if e.code not in (400, 404):
                        raise InfraError(f"adding {MEMBER_USER} to team verify: HTTP {e.code}") from e
            _disable_onboarding(url, member_id, token)


def make(e2e: Path, target: str, image: str, mm_env: str = "") -> None:
    env = {**os.environ, **STACK_ENV, "SERVER_IMAGE": image}
    if mm_env:
        env["MM_ENV"] = mm_env  # the stack appends each KEY=value to the server's .env.server
    else:
        env.pop("MM_ENV", None)
    p = subprocess.run(["make", target], cwd=e2e, env=env,
                       capture_output=True, text=True, check=False)
    if p.returncode:
        raise InfraError(f"make {target} failed:\n{(p.stdout + p.stderr)[-1500:]}")


def _require_e2e(e2e: Path) -> None:
    if not (e2e / ".ci" / "server.generate.sh").exists():
        raise InfraError(f"{e2e} is not the mattermost repo's e2e-tests dir (pass --e2e or set MM_E2E_DIR)")


def _stored_profile() -> list[str] | None:
    try:
        raw = json.loads(profile_path().read_text())
        return list(raw) if isinstance(raw, list) else None
    except (OSError, ValueError, TypeError):
        return None


def up(image: str, e2e: Path, flags: list[str] | None = None, require_license: bool = False) -> None:
    user, password = os.environ.get("VERIFY_USER"), os.environ.get("VERIFY_PASSWORD")
    if not (user and password):
        raise InfraError("set VERIFY_USER and VERIFY_PASSWORD (the admin /verify will log in as)")
    flags = sorted(set(flags or []), key=str.upper)
    license_text = read_license()
    if require_license and not license_text:
        raise InfraError("--require-license: set MM_LICENSE_FILE (a path) or MM_LICENSE (the license text)")
    _require_e2e(e2e)
    with open(lock_path(), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # two swaps at once would leave one plan on the other's build
        build = running_build(SERVER_URL)
        wrong_build = build is None or not build_matches(build, image)
        if wrong_build or _stored_profile() != flags:
            if build is not None:
                why = f"runs {build[:10]}, not {image}" if wrong_build else "runs another feature-flag profile"
                print(f"server on {SERVER_URL} {why}: replacing it")
            profile_path().write_text(json.dumps({"pending": True}))
            started = time.time()
            make(e2e, "stop-server", image)
            if flags:
                make(e2e, "start-server", image, flags_env(flags))
            else:
                make(e2e, "start-server", image)
            with contextlib.suppress(OSError):  # pending marker stays if write fails, forcing replacement next `up`
                profile_path().write_text(json.dumps(flags))
            print(f"stack up in {time.time() - started:.0f}s")
        build = running_build(SERVER_URL)
        if build is None or not build_matches(build, image):
            raise InfraError(f"{SERVER_URL} runs {build!r}, expected {image} (host networking off?)")
        seed(SERVER_URL, user, password, license_text) if license_text else seed(SERVER_URL, user, password)
    lic = "uploaded" if license_text else "none (set MM_LICENSE_FILE or MM_LICENSE)"
    print(f"PROFILE flags={','.join(flags) or 'none'} license={lic}")
    print(f"VERIFY_BASE_URL={SERVER_URL} build={build[:10]} VERIFY_MEMBER_USER={MEMBER_USER}")


def down(e2e: Path) -> None:
    _require_e2e(e2e)
    with open(lock_path(), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        make(e2e, "stop-server", f"{IMAGE_REPO}:master")


def main(argv: list[str]) -> None:
    argv = list(argv)
    opts: dict[str, str] = {}
    for name in ("--e2e", "--flags", "--flags-from-diff"):
        if name in argv:
            i = argv.index(name)
            if i + 1 >= len(argv) or argv[i + 1].startswith("-"):
                sys.exit(__doc__)
            opts[name] = argv[i + 1]
            del argv[i:i + 2]
    e2e = Path(opts["--e2e"]) if "--e2e" in opts else default_e2e()
    require_license = "--require-license" in argv
    argv = [a for a in argv if a != "--require-license"]
    if (("--flags" in opts or "--flags-from-diff" in opts) or require_license) and argv[:1] != ["up"]:
        sys.exit(__doc__)
    pull_too = "--pull" in argv
    args = [a for a in argv if a != "--pull"]
    if args[:1] == ["images"] and len(args) == 2:
        imgs, substitution = substitute_base(pr_images(args[1]))
        print(json.dumps(imgs))
        if substitution:
            print(substitution)
        if pull_too:
            failed = []
            with ThreadPoolExecutor(2) as ex:
                for side, err in zip(imgs, ex.map(pull, imgs.values()), strict=True):
                    print(f"{side} {imgs[side]}: {'pulled' if err is None else 'NOT AVAILABLE: ' + err}")
                    if err is not None:
                        failed.append(f"{side} ({imgs[side]}): {err}")
            if failed:
                raise InfraError(f"image pull failed: {'; '.join(failed)}")
    elif args[:1] == ["up"] and len(args) == 2:
        flags = parse_flags(opts.get("--flags", "")) if "--flags" in opts else []
        if "--flags-from-diff" in opts:
            flags = sorted({*flags, *flags_from_diff(opts["--flags-from-diff"])}, key=str.upper)
        extra: dict[str, Any] = {}
        if flags:
            extra["flags"] = flags
        if require_license:
            extra["require_license"] = True
        up(args[1], e2e, **extra)
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
