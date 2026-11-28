#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Unattended driver: a deterministic state machine over the hunt scripts. The model answers only the requests it is
given (hunters, Mode V diagnostics, the skeptic); every other step is a script.

usage: hunt.py <pr | base..head | base...head> [--fresh] [--force] [--first-batch] [--modes A,B,D,R] [--no-prompt-cache]
       hunt.py --help

Stages. A stage whose output exists is skipped, so running again resumes at the first missing output:
  prepare    prepare.py (exit 4 = results for this head exist: resume; exit 5 = SCHEMA_MISMATCH: stop, or --fresh)
  ctx        ctx.py                                     -> ctx.json
  requests   build_requests.py review, hunters, diff    -> A/, B/, D/ (and R/ when it qualifies)
  dispatch   dispatch.py for each request, in parallel  -> <tag>/response.json (idempotent per request)
  run        run.py run A (EMPTY retry, COMPILE repair), run.py run B, run.py diff D, run.py run R
  base       run.py base <tag> for each tag with FAIL_3_OF_3 tests
  old_tests  old_tests.py                                -> old_tests.json
  pr_tests   pr_tests.py                                 -> pr_tests.json
  vet_v      Mode V: one request writes hunt_v tests for the A/B NEW_PR_BUG candidates; run.py run V, run.py base V
  vet        the skeptic decides KEEP/DROP/HELD per candidate                 -> vetted.json
  verdict    verdict.admissibility + lessons.post_filter                      -> verdict.json
  report     report.py                                                         -> findings.json, audit.md

Every stage runs inside telemetry.stage (telemetry.jsonl); dispatch rows carry tokens and cost. Gaps (a hunter that
wrote no response, a COMPILE_ERROR after its repair round) are kept in driver.json and degrade the confidence tier.
Circuit breaker: once the hunt's model calls have cost $HUNT_BUDGET_USD (default 8), no further call is made;
the hunt finishes on what it has, as Partial with a `budget` gap.
Exit codes: 0 done, 1 usage, 2 INFRA_ERROR, 5 SCHEMA_MISMATCH. A second driver on the same target stops with
INFRA_ERROR. The trust gate (trusted.check) runs first.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_requests
import ctx
import dispatch
import ledger
import lessons
import prefilter
import report
import review_threads
import run
import telemetry
import trusted
import verdict
from build_requests import SKEPTIC_SYSTEM, V_SYSTEM
from hunt_common import (
    SCHEMA_VERSION,
    SKILL_DIR,
    InfraError,
    hunt_dir,
    read_dict,
    scratch,
    target_key,
    terminate_handler,
    write_atomic,
    write_json,
)

SCRIPTS = Path(__file__).resolve().parent
HUNTER_TAGS = ("A", "B", "D", "R")
BASE_TAGS = ("A", "B", "R")
DEFAULT_MODES = ("A", "B", "R")
MODE_ORDER = ("A", "B", "D", "R")
VALID_MODES = frozenset(MODE_ORDER)
MAX_TOKENS_REASONS = ("max_tokens", "error_max_tokens")
MAX_PAYLOAD_CHARS = 20000  # per request: a candidate's test source and failure text, capped so a request stays readable
_CITED_LINE_RE = re.compile(r"(?<![A-Za-z0-9_./:-])([A-Za-z0-9_./-]+\.(?:go|tsx?|jsx?|sql)):(\d+)\b")

DEFAULT_BUDGET_USD = 8.0


class Stop(RuntimeError):
    """A stop that is not an infrastructure failure: the exit code is given."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------ small helpers

_TEST_RUNNER_SCRIPTS = frozenset({"run.py", "old_tests.py", "pr_tests.py"})
_SAFE_ENV_EXACT = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "TERM", "TZ", "LANG",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "GOPATH", "GOMODCACHE", "GOCACHE", "GOROOT", "GOENV", "GOFLAGS", "CI",
})
_SAFE_ENV_PREFIXES = ("LC_", "HUNT_", "NODE_", "PLAYWRIGHT_", "UV_")
_SENSITIVE_ENV_TOKENS = ("TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL", "AUTH", "COOKIE")


def _isolated_script_env(name: str) -> dict[str, str] | None:
    """Scrub host credentials/secrets before executing scripts that run PR test code."""
    if name not in _TEST_RUNNER_SCRIPTS:
        return None
    env: dict[str, str] = {}
    for k, v in os.environ.items():
        ku = k.upper()
        if any(tok in ku for tok in _SENSITIVE_ENV_TOKENS):
            continue
        if k in _SAFE_ENV_EXACT or ku.startswith(_SAFE_ENV_PREFIXES):
            env[k] = v
    return env


def _require_pr_isolation(target: str) -> None:
    """Fail closed before executing third-party PR code unless an isolation boundary is active."""
    if ".." in target:
        return
    if (os.environ.get("HUNT_TEST_SANDBOX_CMD", "").strip()
            or os.environ.get("HUNT_ISOLATED_SANDBOX") == "1"
            or os.environ.get("HUNT_ALLOW_UNSANDBOXED") == "1"):
        return
    raise InfraError(
        "refusing unattended test execution on third-party PR without an isolation boundary: "
        "set HUNT_TEST_SANDBOX_CMD (or run inside an isolated container with HUNT_ISOLATED_SANDBOX=1, "
        "or opt out locally with HUNT_ALLOW_UNSANDBOXED=1)"
    )


def script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    """Run one hunt script from the scripts directory, streaming its output into the driver's log."""
    cmd = [sys.executable, str(SCRIPTS / name), *args]
    sandbox = os.environ.get("HUNT_TEST_SANDBOX_CMD", "").strip() if name in _TEST_RUNNER_SCRIPTS else ""
    if sandbox:
        cmd = [*shlex.split(sandbox), *cmd]
    p = subprocess.run(cmd, cwd=SCRIPTS, capture_output=True, text=True,
                       errors="replace", check=False, env=_isolated_script_env(name))
    print(p.stdout, end="")
    if p.stderr:
        print(p.stderr, end="", file=sys.stderr)
    return p


def expect_ok(p: subprocess.CompletedProcess[str], what: str) -> None:
    """Exit 0 is success. Anything else from a script is an environment or usage failure: stop, do not guess."""
    if p.returncode != 0:
        tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
        raise InfraError(f"{what} exited {p.returncode}: {tail[0][:400]}")


_GAP_LOCK = threading.Lock()  # dispatch threads record gaps concurrently


def _update_driver(hdir: Path, fn: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    with _GAP_LOCK:
        path = hdir / "driver.json"
        doc = read_dict(path)
        fn(doc)
        write_atomic(path, doc)
        return doc


def set_gap(hdir: Path, key: str, message: str | None) -> None:
    """Record (or, with None, clear) a gap for the audit. Keyed, so a resumed run overwrites instead of duplicating.
    Serialized and written atomically: parallel hunters must not read a half-written file or lose each other's gap."""
    def _apply(doc: dict[str, Any]) -> None:
        raw = doc.get("gaps")
        gaps = dict(raw) if isinstance(raw, dict) else {}
        if message is None:
            gaps.pop(key, None)
        else:
            gaps[key] = message
        doc["gaps"] = gaps
    _update_driver(hdir, _apply)


def read_escalations(hdir: Path) -> list[dict[str, Any]]:
    raw = read_dict(hdir / "driver.json").get("escalations")
    return [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []


def can_escalate(hdir: Path) -> bool:
    return len(read_escalations(hdir)) < 1


def record_escalation(hdir: Path, tag: str, reason: str, *, from_tier: str = "sonnet",
                      to_tier: str = "opus") -> None:
    def _apply(doc: dict[str, Any]) -> None:
        raw = doc.get("escalations")
        items = [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []
        items.append({"tag": tag, "reason": reason, "from_tier": from_tier, "to_tier": to_tier})
        doc["escalations"] = items
    _update_driver(hdir, _apply)
    telemetry.record(hdir, "escalate", tag=tag, reason=reason, from_tier=from_tier, to_tier=to_tier)


@contextmanager
def driver_lock(hdir: Path, target: str) -> Iterator[None]:
    """One driver per target. Separate from .lock: the child scripts take .lock, and this process holds this one."""
    hdir.mkdir(parents=True, exist_ok=True)
    with (hdir / ".driver.lock").open("w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise InfraError(f"another hunt driver is running for {target}") from e
        yield


def step(hdir: Path, name: str, done: Callable[[], bool], body: Callable[[], object]) -> None:
    if done():
        print(f"[{name}] resume: output exists, skipped")
        return
    with telemetry.stage(hdir, f"step:{name}"):
        body()


def budget_usd() -> float:
    try:
        return float(os.environ.get("HUNT_BUDGET_USD", DEFAULT_BUDGET_USD))
    except ValueError:
        return DEFAULT_BUDGET_USD


def over_budget(hdir: Path) -> bool:
    """True once this hunt's model calls have cost the budget. Records the `budget` gap the first time."""
    spent = float(telemetry.summarize(hdir).get("total_cost_usd") or 0.0)
    if spent < budget_usd():
        set_gap(hdir, "budget", None)
        return False
    set_gap(hdir, "budget", f"model calls cost ${spent:.2f}, budget ${budget_usd():.2f} (HUNT_BUDGET_USD): "
                            "later calls not made")
    return True


def dispatch_with_result(hdir: Path, tag: str, request: Path, *, strict_schema: bool = False,
                         no_prompt_cache: bool | None = None) -> tuple[
                             bool, dispatch.DispatchResult | None, dispatch.DispatchError | None]:
    """One model call for one request. A failed call is a gap, not a stop: the hunter is reported as failed."""
    if not dispatch.is_answered(request, strict_schema=strict_schema) and over_budget(hdir):
        print(f"[dispatch {tag}] skipped: budget reached")
        return False, None, None
    try:
        res = dispatch.dispatch(request, hdir=hdir, tag=tag, strict_schema=strict_schema,
                                no_prompt_cache=no_prompt_cache, budget_check=lambda: over_budget(hdir))
    except dispatch.DispatchError as e:
        print(f"[dispatch {tag}] FAILED {str(e)[:300]}")
        set_gap(hdir, f"dispatch:{tag}", str(e)[:500])
        return False, None, e
    if res.status == "budget_skipped":
        print(f"[dispatch {tag}] skipped: budget reached")
        return False, None, None
    print(f"[dispatch {tag}] {res.status} retries={res.retries} tokens_in={res.tokens_in} "
          f"cache_write={res.cache_write} cache_read={res.cache_read} tokens_out={res.tokens_out}")
    set_gap(hdir, f"dispatch:{tag}", None)
    return True, res, None


def dispatch_one(hdir: Path, tag: str, request: Path) -> bool:
    """One model call for one request. A failed call is a gap, not a stop: the hunter is reported as failed."""
    ok, _, _ = dispatch_with_result(hdir, tag, request)
    return ok


_ORIG_DISPATCH_ONE = dispatch_one


def _record_accepted_response(hdir: Path, tag: str, req_path: Path, resp_path: Path | None = None) -> None:
    rp = resp_path or (hdir / tag / "response.json")
    if not req_path.is_file() or not rp.is_file():
        return
    base_req = hdir / tag / "request.json"
    doc: dict[str, str] = {
        "request": req_path.name,
        "request_sha": dispatch.request_sha(req_path),
        "response_sha": hashlib.sha256(rp.read_bytes()).hexdigest(),
    }
    if base_req.is_file():
        doc["base_request_sha"] = dispatch.request_sha(base_req)
    write_atomic(hdir / tag / "response.accepted.json", doc)


def _maybe_record_accepted(hdir: Path, tag: str, req_path: Path) -> None:
    if not (tag in HUNTER_TAGS or tag.startswith("V")) or not req_path.is_file():
        return
    try:
        target_resp = dispatch.response_path(req_path).resolve()
    except (OSError, ValueError, InfraError):
        return
    canonical = (hdir / tag / "response.json").resolve()
    if target_resp == canonical and canonical.is_file():
        _record_accepted_response(hdir, tag, req_path, canonical)


def _has_accepted_response(hdir: Path, tag: str) -> bool:
    rp = hdir / tag / "response.json"
    if not rp.is_file():
        return False
    acc = hdir / tag / "response.accepted.json"
    if acc.is_file():
        meta = read_dict(acc)
        req_name = str(meta.get("request") or "")
        req_p = hdir / tag / req_name if req_name else None
        base_req = hdir / tag / "request.json"
        if not req_p or not req_p.is_file():
            return False
        if meta.get("response_sha") != hashlib.sha256(rp.read_bytes()).hexdigest():
            return False
        if meta.get("request_sha") != dispatch.request_sha(req_p):
            return False
        return not (base_req.is_file() and meta.get("base_request_sha") != dispatch.request_sha(base_req))
    if not requests_present(hdir, (tag,)):
        return True
    eff = effective_request(hdir, tag)
    try:
        if dispatch.response_path(eff).resolve() != rp.resolve():
            return False
    except (OSError, ValueError, InfraError):
        return False
    return dispatch.is_answered(eff, strict_schema=True)


def _promote_opus_response(hdir: Path, tag: str) -> bool:
    opus_req = hdir / tag / "request.opus.json"
    if not opus_req.is_file() or not dispatch.is_answered(opus_req, strict_schema=True):
        return False
    req_data = read_dict(hdir / tag / "request.json")
    resp_path = Path(str(req_data.get("response_path") or (hdir / tag / "response.json")))
    try:
        opus_resp = dispatch.response_path(opus_req)
    except (OSError, ValueError, InfraError):
        return False
    if opus_resp.is_file():
        if opus_resp.resolve() != resp_path.resolve():
            write_atomic(resp_path, read_dict(opus_resp))
        _record_accepted_response(hdir, tag, opus_req, resp_path)
        return True
    return False


def _call_dispatch(hdir: Path, tag: str, request: Path, *, strict_schema: bool = False,
                   no_prompt_cache: bool | None = None) -> tuple[
                       bool, dispatch.DispatchResult | None, dispatch.DispatchError | None]:
    if dispatch_one is not _ORIG_DISPATCH_ONE:
        ok = dispatch_one(hdir, tag, request)
        res, err = None, None
    else:
        ok, res, err = dispatch_with_result(hdir, tag, request, strict_schema=strict_schema, no_prompt_cache=no_prompt_cache)
    if ok:
        _maybe_record_accepted(hdir, tag.split(":", 1)[0], request)
    return ok, res, err


def _add_diff_hunk_lines(diff_text: str, valid: dict[str, set[int]], default_path: str = "") -> None:
    cur_path = default_path
    old_n = new_n = 0
    in_hunk = False
    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/", 1)
            if len(parts) == 2:
                cur_path = parts[1].strip().strip('"')
            in_hunk = False
        elif not in_hunk and line.startswith("+++ b/"):
            cur_path = line[6:].strip().strip('"')
        elif line.startswith("@@ "):
            m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if m:
                old_n, new_n, in_hunk = int(m.group(1)), int(m.group(2)), True
        elif not in_hunk or not cur_path or line.startswith("\\"):
            continue
        elif line.startswith("+"):
            valid.setdefault(cur_path, set()).add(new_n)
            new_n += 1
        elif line.startswith("-"):
            valid.setdefault(cur_path, set()).add(old_n)
            old_n += 1
        elif line == "" or line.startswith(" "):
            valid.setdefault(cur_path, set()).update((old_n, new_n))
            old_n += 1
            new_n += 1


def _add_numbered_lines(path: str, text: str, valid: dict[str, set[int]]) -> None:
    if not path or not text:
        return
    nums = valid.setdefault(path, set())
    for line in text.splitlines():
        m = re.match(r"^\s*(\d+)(?:\s|:)", line)
        if m:
            nums.add(int(m.group(1)))


def _parse_user(req: dict[str, Any]) -> dict[str, Any]:
    raw_user = req.get("user")
    if isinstance(raw_user, str):
        try:
            raw_user = json.loads(raw_user)
        except ValueError:
            return {}
    return raw_user if isinstance(raw_user, dict) else {}


def _extract_valid_lines(req_path: Path) -> dict[str, set[int]]:
    user = _parse_user(read_dict(req_path))
    if not user:
        return {}
    valid: dict[str, set[int]] = {}
    _add_diff_hunk_lines(str(user.get("diff_production_code") or ""), valid)
    for key in ("changed_files_head_source", "thread_files_head_source"):
        for item in user.get(key) or []:
            if isinstance(item, dict):
                _add_numbered_lines(str(item.get("file") or ""), str(item.get("source") or ""), valid)
    for key in ("neighbors_same_file", "changed_functions_base_source", "callers", "sibling_tests_and_helpers"):
        for item in user.get(key) or []:
            if not isinstance(item, dict):
                continue
            fpath = str(item.get("file") or "")
            _add_numbered_lines(fpath, str(item.get("source") or ""), valid)
            for chk in item.get("permission_checks") or []:
                cm = _CITED_LINE_RE.search(str(chk))
                if cm:
                    valid.setdefault(cm.group(1), set()).add(int(cm.group(2)))
    for item in user.get("pr_tests_diff") or []:
        if not isinstance(item, dict):
            continue
        fpath = str(item.get("file") or item.get("path") or "")
        _add_numbered_lines(fpath, str(item.get("added") or ""), valid)
        if isinstance(item.get("diff"), str):
            _add_diff_hunk_lines(item["diff"], valid, default_path=fpath)
    for item in user.get("review_threads") or []:
        if isinstance(item, dict) and isinstance(item.get("path"), str) and isinstance(item.get("line"), int):
            valid.setdefault(item["path"], set()).add(item["line"])
    return valid


def _has_uncited_line(req_path: Path, resp_path: Path) -> bool:
    resp = read_dict(resp_path)
    tests = resp.get("tests")
    if not isinstance(tests, list) or not tests:
        return False
    citations: list[tuple[str, int]] = []
    for t in tests:
        if not isinstance(t, dict):
            continue
        src = str(t.get("source") or "")
        for m in _CITED_LINE_RE.finditer(src):
            citations.append((m.group(1), int(m.group(2))))
    if not citations:
        return False
    valid = _extract_valid_lines(req_path)
    for path, line in citations:
        if path in valid:
            if line not in valid[path]:
                return True
            continue
        matches = [k for k in valid if Path(k).name == path or k.endswith("/" + path)]
        if len(matches) == 1:
            if line not in valid[matches[0]]:
                return True
        else:
            return True
    return False


def _split_diff_patches(diff_text: str) -> dict[str, str]:
    patches: dict[str, str] = {}
    cur_path = ""
    buf: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            if cur_path:
                patches[cur_path] = "\n".join(buf)
            parts = line.split(" b/", 1)
            cur_path = parts[1].strip().strip('"') if len(parts) == 2 else ""
            buf = [line]
        elif cur_path:
            buf.append(line)
    if cur_path:
        patches[cur_path] = "\n".join(buf)
    return patches


def _batch_has_risky_file(hdir: Path) -> bool:
    state = read_dict(hdir / "state.json")
    ctx = read_dict(hdir / "ctx.json")
    changed = [str(p) for p in state.get("changed", []) if isinstance(p, str)]
    patches = _split_diff_patches(str(ctx.get("diff_production_code") or ""))
    paths = changed or list(patches)
    for path in paths:
        patch = patches.get(path, "")
        added = sum(1 for ln in patch.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
        removed = sum(1 for ln in patch.splitlines() if ln.startswith("-") and not ln.startswith("---"))
        fd = prefilter.FileDiff(path, added, removed, patch)
        if prefilter.risk(fd) >= 5.0 or fd.lines >= 100:
            return True
    return False


def escalate_tag(hdir: Path, tag: str, reason: str, *, no_prompt_cache: bool | None = None) -> tuple[
        bool, dispatch.DispatchResult | None, dispatch.DispatchError | None]:
    if not can_escalate(hdir) or over_budget(hdir):
        return False, None, None
    orig = hdir / tag / "request.json"
    opus_req = hdir / tag / "request.opus.json"
    if not orig.exists() or opus_req.exists():
        return False, None, None
    req_data = read_dict(orig)
    from_tier = str(req_data.get("tier") or "sonnet").lower()
    if from_tier != "sonnet":
        return False, None, None
    user_obj = _parse_user(req_data)
    resp_path = Path(str(req_data.get("response_path") or (hdir / tag / "response.json")))
    opus_resp = resp_path.with_name("response.opus.json")
    raw_schema = req_data.get("schema")
    schema: dict[str, Any] = raw_schema if isinstance(raw_schema, dict) else build_requests.HUNTER_SCHEMA
    build_requests.write_request(
        opus_req, str(req_data.get("system") or ""), user_obj, schema, opus_resp, tier="opus",
    )
    record_escalation(hdir, tag, reason, from_tier=from_tier, to_tier="opus")
    ok, res, err = _call_dispatch(hdir, tag, opus_req, strict_schema=True, no_prompt_cache=no_prompt_cache)
    if ok:
        if not _promote_opus_response(hdir, tag) and resp_path.is_file() and opus_req.is_file():
            _record_accepted_response(hdir, tag, opus_req, resp_path)
        set_gap(hdir, f"dispatch:{tag}", None)
    elif dispatch.is_answered(orig, strict_schema=True) and resp_path.is_file():
        opus_req.unlink(missing_ok=True)
        opus_req.with_suffix(".md").unlink(missing_ok=True)
        dispatch.sidecar(opus_req).unlink(missing_ok=True)
        opus_resp.unlink(missing_ok=True)
        set_gap(hdir, f"dispatch:{tag}", None)
    return ok, res, err


def _escalation_reason(hdir: Path, tag: str, req_path: Path, res: dispatch.DispatchResult | None,
                       err: dispatch.DispatchError | None) -> str | None:
    if err is not None and err.schema_errors:
        return "schema_validation_failed"
    if (res is not None and res.stop_reason in MAX_TOKENS_REASONS) or (
            err is not None and err.stop_reason in MAX_TOKENS_REASONS):
        return "max_tokens"
    resp_path = hdir / tag / "response.json"
    if resp_path.exists():
        if _has_uncited_line(req_path, resp_path):
            return "cited_line_not_in_diff"
        if tag in ("A", "B", "D") and read_dict(resp_path).get("files") == [] and _batch_has_risky_file(hdir):
            return "empty_on_risky_file"
    return None


# ------------------------------------------------------------------ stages

def stage_prepare(target: str, hdir: Path, fresh: bool) -> None:
    p = script("prepare.py", target, *(["--fresh"] if fresh else []))
    if p.returncode == 5:
        raise Stop(5, "SCHEMA_MISMATCH: this hunt dir was prepared by another schema; pass --fresh to start over")
    if p.returncode == 4:  # results for this head exist: resume from the first missing output
        return
    expect_ok(p, "prepare.py")


def _r_requests_done(hdir: Path) -> bool:
    if (hdir / "R" / "request.json").exists():
        return True
    tpath = hdir / "R" / "threads.json"
    return tpath.is_file() and not read_dict(tpath).get("included")


def stage_requests(target: str, hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> None:
    # Review first: a failure there leaves no hunter request behind, so the next run builds everything again.
    if "R" in modes and not _r_requests_done(hdir):
        expect_ok(script("build_requests.py", target, "review"), "build_requests review")
    if "A" in modes or "B" in modes:
        expect_ok(script("build_requests.py", target, "hunters"), "build_requests hunters")
        for m in ("A", "B"):
            if m not in modes:
                for name in ("request.json", "request.md"):
                    (hdir / m / name).unlink(missing_ok=True)
    if "D" in modes:
        expect_ok(script("build_requests.py", target, "diff"), "build_requests diff")


def effective_request(hdir: Path, tag: str) -> Path:
    opus_req = hdir / tag / "request.opus.json"
    return opus_req if opus_req.exists() else hdir / tag / "request.json"


def requests_present(hdir: Path, tags: tuple[str, ...]) -> list[tuple[str, Path]]:
    return [(t, effective_request(hdir, t)) for t in tags
            if (hdir / t / "request.json").exists() or (hdir / t / "request.opus.json").exists()]


def _escalation_checked(hdir: Path, tag: str, req_path: Path) -> bool:
    marker = hdir / tag / "escalation.checked"
    try:
        return marker.is_file() and marker.read_text().strip() == dispatch.request_sha(req_path)
    except OSError:
        return False


def _mark_escalation_checked(hdir: Path, tag: str, req_path: Path) -> None:
    with suppress(OSError):
        (hdir / tag / "escalation.checked").write_text(dispatch.request_sha(req_path))


def stage_dispatch(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES, *,
                   no_prompt_cache: bool | None = None) -> None:
    active_tags = tuple(t for t in HUNTER_TAGS if t in modes)
    reqs = requests_present(hdir, active_tags)
    results: dict[str, tuple[Path, bool, dispatch.DispatchResult | None, dispatch.DispatchError | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(reqs))) as pool:
        futs = {
            t: pool.submit(_call_dispatch, hdir, t, path, strict_schema=True, no_prompt_cache=no_prompt_cache)
            for t, path in reqs
        }
        for t, _path in reqs:
            ok, res, err = futs[t].result()
            if ok and _path.name == "request.opus.json":
                _promote_opus_response(hdir, t)
            results[t] = (_path, ok, res, err)
    for t in active_tags:
        if t not in results or not can_escalate(hdir):
            continue
        req_path, _ok, res, err = results[t]
        if _escalation_checked(hdir, t, req_path):
            continue
        req_tier = str(read_dict(req_path).get("tier") or "sonnet").lower()
        if req_tier != "sonnet":
            continue
        reason = _escalation_reason(hdir, t, req_path, res, err)
        if reason:
            esc_before = len(read_escalations(hdir))
            escalate_tag(hdir, t, reason, no_prompt_cache=no_prompt_cache)
            if len(read_escalations(hdir)) > esc_before or not can_escalate(hdir):
                _mark_escalation_checked(hdir, t, req_path)
        elif dispatch.is_answered(req_path, strict_schema=True):
            _mark_escalation_checked(hdir, t, req_path)


def dispatched(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> bool:
    active_tags = tuple(t for t in HUNTER_TAGS if t in modes)
    reqs = requests_present(hdir, active_tags)
    if over_budget(hdir):
        return True  # the breaker tripped: run on the answers that exist
    if reqs:
        for t, path in reqs:
            if not dispatch.is_answered(path, strict_schema=True):
                return False
            if path.name == "request.opus.json" and not _has_accepted_response(hdir, t):
                return False
            if (can_escalate(hdir) and str(read_dict(path).get("tier") or "sonnet").lower() == "sonnet"
                    and not _escalation_checked(hdir, t, path)
                    and _escalation_reason(hdir, t, path, None, None) is not None):
                return False
        return True
    return set(modes) == {"R"} and _r_requests_done(hdir)


def repair_round(target: str, hdir: Path, tag: str, *, no_prompt_cache: bool | None = None) -> bool:
    """One repair round after a COMPILE_ERROR (SKILL.md step 4): the failing files go back to the same hunter."""
    expect_ok(script("build_requests.py", target, "repair", tag), f"build_requests repair {tag}")
    ok, _, _ = _call_dispatch(hdir, f"{tag}:repair", hdir / tag / "request.repair.json",
                              strict_schema=True, no_prompt_cache=no_prompt_cache)
    return ok


def _run_with_repair(target: str, hdir: Path, tag: str, subcmd: str, label: str, *,
                     no_prompt_cache: bool | None = None) -> subprocess.CompletedProcess[str] | None:
    p = script("run.py", subcmd, target, tag)
    if p.returncode == 3 and repair_round(target, hdir, tag, no_prompt_cache=no_prompt_cache):
        p = script("run.py", subcmd, target, tag)
    if p.returncode == 3:
        set_gap(hdir, f"run:{tag}", f"{tag} COMPILE_ERROR after one repair round")
        return None
    expect_ok(p, label)
    acc = hdir / tag / "response.accepted.json"
    rp = hdir / tag / "response.json"
    if acc.is_file() and rp.is_file():
        meta = read_dict(acc)
        meta["response_sha"] = hashlib.sha256(rp.read_bytes()).hexdigest()
        write_atomic(acc, meta)
    return p


def _run_committed(hdir: Path, tag: str) -> bool:
    """True only when tag's run output, required auxiliary files, and matching accepted response fingerprint all exist."""
    if not _has_accepted_response(hdir, tag):
        return False
    resp_path = hdir / tag / "response.json"
    if not resp_path.is_file():
        return False
    files = read_dict(resp_path).get("files")
    if not isinstance(files, list):
        return False
    digest = run.fingerprint(files)
    if tag == "D":
        sha_path = hdir / "diff_D.response.sha256"
        return ((hdir / "diff_D.json").is_file() and (hdir / "diff_D.examples.json").is_file()
                and sha_path.is_file() and sha_path.read_text().strip() == digest)
    sha_path = hdir / f"run_{tag}.response.sha256"
    if not ((hdir / f"run_{tag}.json").is_file() and sha_path.is_file() and sha_path.read_text().strip() == digest):
        return False
    return not files or (hdir / f"run_{tag}.messages.json").is_file()


def run_tag(target: str, hdir: Path, tag: str, *, retry_empty: bool = False,
            no_prompt_cache: bool | None = None) -> None:
    retry_marker = hdir / tag / "retry.done"
    committed = _run_committed(hdir, tag)
    if committed and (not retry_empty or retry_marker.exists()):
        set_gap(hdir, f"run:{tag}", None)
        return
    if not _has_accepted_response(hdir, tag):
        set_gap(hdir, f"run:{tag}", f"hunter {tag} wrote no accepted response")
        return
    if committed:
        p_stdout = "EMPTY_RESPONSE\n" if read_dict(hdir / f"run_{tag}.json") == {} else ""
    else:
        retry_marker.unlink(missing_ok=True)
        p = _run_with_repair(target, hdir, tag, "run", f"run.py run {tag}", no_prompt_cache=no_prompt_cache)
        if p is None:
            return
        p_stdout = p.stdout
    retry_req = hdir / tag / "request.retry.json"
    retry_unanswered = False
    if retry_empty and "EMPTY_RESPONSE" in p_stdout:
        if not retry_req.exists():
            expect_ok(script("build_requests.py", target, "retry", tag), f"build_requests retry {tag}")
        if not dispatch.is_answered(retry_req, strict_schema=True):
            ok, _, _ = _call_dispatch(hdir, f"{tag}:retry", retry_req,
                                      strict_schema=True, no_prompt_cache=no_prompt_cache)
            if not ok and not dispatch.is_answered(retry_req, strict_schema=True):
                retry_unanswered = True
        else:
            ok = False
        if ok:
            (hdir / f"run_{tag}.json").unlink(missing_ok=True)
            (hdir / f"run_{tag}.response.sha256").unlink(missing_ok=True)
            p2 = _run_with_repair(target, hdir, tag, "run", f"run.py run {tag} after retry",
                                  no_prompt_cache=no_prompt_cache)
            if p2 is None:
                return
            p_stdout = p2.stdout
    if retry_empty and "EMPTY_RESPONSE" in p_stdout and not retry_unanswered and can_escalate(hdir):
        req_tier = str(read_dict(effective_request(hdir, tag)).get("tier") or "sonnet").lower()
        if req_tier == "sonnet" and not (hdir / tag / "request.opus.json").exists():
            ok, _, _ = escalate_tag(hdir, tag, "empty_after_retry", no_prompt_cache=no_prompt_cache)
            if ok:
                (hdir / f"run_{tag}.json").unlink(missing_ok=True)
                (hdir / f"run_{tag}.response.sha256").unlink(missing_ok=True)
                p2 = _run_with_repair(target, hdir, tag, "run", f"run.py run {tag} after opus escalation",
                                      no_prompt_cache=no_prompt_cache)
                if p2 is None:
                    return
                p_stdout = p2.stdout
            elif not dispatch.is_answered(hdir / tag / "request.opus.json", strict_schema=True):
                retry_unanswered = True
    set_gap(hdir, f"empty:{tag}", "Mode A emitted no tests after one retry" if "EMPTY_RESPONSE" in p_stdout else None)
    set_gap(hdir, f"run:{tag}", None)
    if retry_empty and not retry_unanswered:
        retry_marker.write_text("ok\n")


def run_diff(target: str, hdir: Path, *, no_prompt_cache: bool | None = None) -> None:
    if _run_committed(hdir, "D"):
        set_gap(hdir, "run:D", None)
        return
    if not _has_accepted_response(hdir, "D"):
        set_gap(hdir, "run:D", "hunter D wrote no accepted response")
        return
    if _run_with_repair(target, hdir, "D", "diff", "run.py diff D", no_prompt_cache=no_prompt_cache) is not None:
        set_gap(hdir, "run:D", None)


def stage_run(target: str, hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES, *,
              no_prompt_cache: bool | None = None) -> None:
    if "A" in modes:
        run_tag(target, hdir, "A", retry_empty=True, no_prompt_cache=no_prompt_cache)
    if "B" in modes:
        run_tag(target, hdir, "B", no_prompt_cache=no_prompt_cache)
    if "D" in modes:
        run_diff(target, hdir, no_prompt_cache=no_prompt_cache)
    if "R" in modes and (hdir / "R" / "request.json").exists():
        run_tag(target, hdir, "R", no_prompt_cache=no_prompt_cache)


def failing(hdir: Path, tag: str) -> list[str]:
    return [k for k, v in read_dict(hdir / f"run_{tag}.json").items() if v == verdict.Verdict.FAIL_3_OF_3]


def base_pending(hdir: Path, tag: str) -> bool:
    return bool(failing(hdir, tag)) and not (hdir / f"base_{tag}.json").exists()


def stage_base(target: str, hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> None:
    for tag in tuple(t for t in BASE_TAGS if t in modes):
        if base_pending(hdir, tag):
            p = script("run.py", "base", target, tag)
            if p.returncode == 3:
                set_gap(hdir, f"base:{tag}", f"{tag} COMPILE_ERROR on the merge-base")
                continue
            expect_ok(p, f"run.py base {tag}")
            set_gap(hdir, f"base:{tag}", None)


def candidates_ab(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> list[dict[str, Any]]:
    """Mode A and B tests that fail 3 of 3 on head and pass on the merge-base: the ones Mode V diagnoses."""
    out = []
    for tag in tuple(t for t in ("A", "B") if t in modes):
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_PR_BUG:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def candidates_new_api(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> list[dict[str, Any]]:
    """Mode A/B tests that fail 3 of 3 on head and cannot run on the merge-base because they call the PR's new API.
    No base oracle exists, so the skeptic judges them against the PR's description (PR 40256: the write-scope bug)."""
    out = []
    for tag in tuple(t for t in ("A", "B") if t in modes):
        head = read_dict(hdir / f"run_{tag}.json")
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_API and head.get(tid) == verdict.Verdict.FAIL_3_OF_3:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def _mode_r_repro_id(hdir: Path, item: dict[str, Any]) -> str:
    tests = item.get("tests")
    if not isinstance(tests, dict) or not tests:
        return ""
    failing_tests = sorted(str(tid) for tid, st in tests.items() if st == verdict.Verdict.FAIL_3_OF_3)
    if failing_tests:
        base_r = read_dict(hdir / "base_R.json")
        return next((tid for tid in failing_tests if base_r.get(tid) == verdict.Verdict.NEW_PR_BUG), failing_tests[0])
    return sorted(str(tid) for tid in tests)[0]


def candidates_all(hdir: Path, modes: tuple[str, ...] = MODE_ORDER) -> list[dict[str, Any]]:
    """Everything the skeptic may decide on: Mode A/B NEW_PR_BUG or NEW_API (head 3 of 3), Mode R PROVEN with a
    NEW_PR_BUG base, Mode D DIFF."""
    out = candidates_ab(hdir, modes) + candidates_new_api(hdir, modes)
    if "R" in modes:
        for tid, item in read_dict(hdir / "review_verdicts.json").get("verdicts", {}).items():
            if isinstance(item, dict) and item.get("verdict") == verdict.Verdict.PROVEN \
                    and item.get("base_verdict") == verdict.Verdict.NEW_PR_BUG:
                out.append({"id": tid, "source": "R", "mechanical_verdict": verdict.Verdict.NEW_PR_BUG,
                            "repro_id": _mode_r_repro_id(hdir, item)})
    if "D" in modes:
        for tid, v in read_dict(hdir / "diff_D.json").items():
            if v == verdict.Verdict.DIFF:
                out.append({"id": tid, "source": "D", "mechanical_verdict": v})
    return out


def _v_chunks(cands: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    max_files = max(1, int(build_requests.HUNTER_SCHEMA.get("properties", {}).get("files", {}).get("maxItems") or 8))
    return [
        ("V" if i == 0 else f"V_{i // max_files + 1}", cands[i:i + max_files])
        for i in range(0, len(cands), max_files)
    ]


def _v_inputs(hdir: Path, modes: tuple[str, ...]) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    ab_tags = tuple(t for t in ("A", "B") if t in modes)
    files_by_tag: dict[str, str] = {}
    for tag in ab_tags:
        resp = read_dict(hdir / tag / "response.json")
        files_by_tag[tag] = _capped_to("\n\n".join(f"// {f.get('path', '')}\n{f.get('content', '')}"
                                                  for f in resp.get("files", []) if isinstance(f, dict)),
                                        MAX_PAYLOAD_CHARS)
    messages: dict[str, dict[str, Any]] = {tag: read_dict(hdir / f"run_{tag}.messages.json") for tag in ab_tags}
    return files_by_tag, messages


def _v_cand_digest(hdir: Path, cands: list[dict[str, Any]], modes: tuple[str, ...],
                   files_by_tag: dict[str, str] | None = None,
                   messages: dict[str, dict[str, Any]] | None = None) -> str:
    if files_by_tag is None or messages is None:
        files_by_tag, messages = _v_inputs(hdir, modes)
    return run.fingerprint([{
        "id": str(c["id"]),
        "source": str(c["source"]),
        "mv": str(c.get("mechanical_verdict", "")),
        "head_failure": str(messages.get(c["source"], {}).get(c["id"], ""))[:1500],
        "test_source": files_by_tag.get(c["source"], ""),
    } for c in cands])


def _clear_stale_v(hdir: Path) -> None:
    for p in hdir.glob("V*"):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    for pat in ("run_V*.json", "run_V*.messages.json", "run_V*.runtimes.json", "run_V*.log",
                "run_V*.response.sha256", "base_V*.json", "base_V*.errors.json", "base_V*.response.sha256"):
        for p in hdir.glob(pat):
            p.unlink(missing_ok=True)
    gaps = read_dict(hdir / "driver.json").get("gaps", {})
    if isinstance(gaps, dict):
        for k in list(gaps):
            if str(k).startswith(("vet_v", "dispatch:V")):
                set_gap(hdir, str(k), None)


def stage_v(target: str, hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES, *,
            no_prompt_cache: bool | None = None) -> None:
    cands = candidates_ab(hdir, modes)
    if not cands:
        return
    files_by_tag, messages = _v_inputs(hdir, modes)
    digest = _v_cand_digest(hdir, cands, modes, files_by_tag, messages)
    cand_sha = hdir / "V.candidates.sha256"
    if cand_sha.is_file() and cand_sha.read_text().strip() != digest:
        _clear_stale_v(hdir)
    cand_sha.write_text(digest)
    chunks = _v_chunks(cands)
    if len(chunks) > 1:
        (hdir / "V.aggregate.sha256").unlink(missing_ok=True)
    merged_run: dict[str, Any] = {}
    merged_base: dict[str, Any] = {}
    for vtag, chunk in chunks:
        gap_key = "vet_v" if vtag == "V" else f"vet_{vtag.lower()}"
        chunk_done = (
            len(chunks) > 1
            and (hdir / vtag / "response.json").is_file()
            and (hdir / vtag / "run.json").is_file()
            and (not [k for k, v in read_dict(hdir / vtag / "run.json").items() if v == verdict.Verdict.FAIL_3_OF_3]
                 or (hdir / vtag / "base.json").is_file())
        )
        if chunk_done:
            if len(chunks) > 1:
                merged_run.update({f"{vtag}:{k}": v for k, v in read_dict(hdir / vtag / "run.json").items()})
                merged_base.update({f"{vtag}:{k}": v for k, v in read_dict(hdir / vtag / "base.json").items()})
            continue
        user = {"candidates": [{"id": c["id"], "tag": c["source"],
                                "head_failure": str(messages.get(c["source"], {}).get(c["id"], ""))[:1500],
                                "test_source": files_by_tag[c["source"]]} for c in chunk]}
        opus_req = hdir / vtag / "request.opus.json"
        req = opus_req if opus_req.exists() else build_requests.write_request(
            hdir / vtag / "request.json", V_SYSTEM, user, build_requests.HUNTER_SCHEMA, hdir / vtag / "response.json")
        ok, res, err = _call_dispatch(hdir, vtag, req, strict_schema=True, no_prompt_cache=no_prompt_cache)
        if ok and req.name == "request.opus.json":
            _promote_opus_response(hdir, vtag)
        reason: str | None = None
        if err is not None and err.schema_errors:
            reason = "schema_validation_failed"
        elif (res is not None and res.stop_reason in MAX_TOKENS_REASONS) or (
                err is not None and err.stop_reason in MAX_TOKENS_REASONS):
            reason = "max_tokens"
        if reason and can_escalate(hdir):
            esc_before = len(read_escalations(hdir))
            esc_ok, _, _ = escalate_tag(hdir, vtag, reason, no_prompt_cache=no_prompt_cache)
            if len(read_escalations(hdir)) > esc_before:
                ok = esc_ok
        if not ok:
            continue
        p = script("run.py", "run", target, vtag)
        if p.returncode == 3:  # the diagnostic tests did not compile: vet the candidates on the A/B evidence alone
            tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
            set_gap(hdir, gap_key, f"Mode {vtag} COMPILE_ERROR: {tail[0][:300]}")
            continue
        expect_ok(p, f"run.py run {vtag}")
        set_gap(hdir, gap_key, None)
        expect_ok(script("run.py", "base", target, vtag), f"run.py base {vtag}")
        if len(chunks) > 1:
            r_chunk = read_dict(hdir / f"run_{vtag}.json")
            b_chunk = read_dict(hdir / f"base_{vtag}.json")
            write_json(hdir / vtag / "run.json", r_chunk)
            if b_chunk or (hdir / f"base_{vtag}.json").exists():
                write_json(hdir / vtag / "base.json", b_chunk)
            merged_run.update({f"{vtag}:{k}": v for k, v in r_chunk.items()})
            merged_base.update({f"{vtag}:{k}": v for k, v in b_chunk.items()})
    if len(chunks) > 1:
        if merged_run or any((hdir / vt / "run.json").exists() for vt, _ in chunks):
            write_json(hdir / "run_V.json", merged_run)
        if merged_base or any((hdir / vt / "base.json").exists() for vt, _ in chunks):
            write_json(hdir / "base_V.json", merged_base)
        gaps = read_dict(hdir / "driver.json").get("gaps", {})
        all_chunks_done = all(
            ((hdir / vt / "run.json").exists()
             and (not [k for k, v in read_dict(hdir / vt / "run.json").items() if v == verdict.Verdict.FAIL_3_OF_3]
                  or (hdir / vt / "base.json").exists()))
            or (("vet_v" if vt == "V" else f"vet_{vt.lower()}") in gaps)
            for vt, _ in chunks
        )
        if all_chunks_done:
            (hdir / "V.aggregate.sha256").write_text(digest)


def v_done(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> bool:
    cands = candidates_ab(hdir, modes)
    if not cands:
        return True
    cand_sha = hdir / "V.candidates.sha256"
    if cand_sha.is_file() and cand_sha.read_text().strip() != _v_cand_digest(hdir, cands, modes):
        return False
    chunks = _v_chunks(cands)
    gaps = read_dict(hdir / "driver.json").get("gaps", {})
    if len(chunks) == 1:
        if not (hdir / "run_V.json").exists():
            return "vet_v" in gaps
        return not failing(hdir, "V") or (hdir / "base_V.json").exists()
    if not cand_sha.is_file():
        return False
    agg_sha = hdir / "V.aggregate.sha256"
    if not agg_sha.is_file() or agg_sha.read_text().strip() != cand_sha.read_text().strip():
        return False
    for vtag, _ in chunks:
        if not (hdir / vtag / "run.json").exists():
            gap_key = "vet_v" if vtag == "V" else f"vet_{vtag.lower()}"
            if gap_key in gaps:
                continue
            return False
        chunk_fail = [k for k, v in read_dict(hdir / vtag / "run.json").items() if v == verdict.Verdict.FAIL_3_OF_3]
        if chunk_fail and not (hdir / vtag / "base.json").exists():
            return False
    if any((hdir / vtag / "run.json").exists() for vtag, _ in chunks) and not (hdir / "run_V.json").exists():
        return False
    return not any((hdir / vtag / "base.json").exists() for vtag, _ in chunks) or (hdir / "base_V.json").exists()


SKEPTIC_DESCRIPTION_CHARS = 3000
SKEPTIC_DIFF_CHARS = 12000
SKEPTIC_CALLERS_CHARS = 6000
SKEPTIC_TEST_CHARS = 3000
SKEPTIC_PR_TESTS_CHARS = 4000


_JEST_REGEX_META = re.compile(r"([.*+?^${}()|[\]\\])")


def _repro_tag_for(hdir: Path, tid: str) -> str:
    unit = tid.partition("::")[0]
    bdirs = [hdir]
    broot = hdir / "batches"
    if broot.is_dir():
        bdirs.extend(sorted(p for p in broot.iterdir() if p.is_dir() and p.name.startswith("batch_")))
    for bdir in bdirs:
        if tid in read_dict(bdir / "run_A2.json") or tid in read_dict(bdir / "base_A2.json"):
            return "A2"
        for t in ("A2", "A", "B", "R"):
            files = read_dict(bdir / t / "response.json").get("files")
            if isinstance(files, list) and unit in run.group_by_unit(files):
                return t
    return "A"


def repro_cmd(hdir: Path, tid: str, *, diff: bool = False, tag: str | None = None) -> str:
    """The command that reruns one hunted test (restoring generated Go files via run.py repro, or running Jest)."""
    pr = str(read_dict(hdir / "state.json").get("pr") or hdir.name)
    if diff:
        return (f"{shlex.quote(sys.executable)} {shlex.quote(str(SCRIPTS / 'run.py'))} "
                f"diff {shlex.quote(pr)} D --only {shlex.quote(tid)}")
    rel, _, name = tid.partition("::")
    wt = Path(str(read_dict(hdir / "state.json").get("wt") or "."))
    if rel.endswith((".ts", ".tsx", ".js", ".jsx")):
        import run as run_mod  # only for the Jest root lookup
        try:
            root = run_mod.jest_root(wt, rel).relative_to(wt.resolve())
        except (InfraError, ValueError):
            root = Path("webapp/channels")
        jest_pat = shlex.quote(_JEST_REGEX_META.sub(r"\\\1", name))
        root_q = shlex.quote(str(root))
        if Path(rel).is_relative_to(root):
            return f"cd {root_q} && npx jest {shlex.quote(str(Path(rel).relative_to(root)))} -t {jest_pat}"
        # A test outside the Jest root (webapp/platform) is found only through --roots, as run.py runs it.
        pkg = run_mod.jest_pkg_dir(wt, rel, wt / root)
        roots = f"--roots . --roots {shlex.quote(os.path.relpath(pkg, (wt / root).resolve()))} " if pkg is not None else ""
        return f"cd {root_q} && npx jest {roots}--runTestsByPath {shlex.quote(os.path.relpath(rel, root))} -t {jest_pat}"
    rtag = tag or _repro_tag_for(hdir, tid)
    if rtag == "A" and (tid in read_dict(hdir / "run_A2.json") or tid in read_dict(hdir / "base_A2.json")):
        rtag = "A2"
    return (f"{shlex.quote(sys.executable)} {shlex.quote(str(SCRIPTS / 'run.py'))} "
            f"repro {shlex.quote(pr)} {shlex.quote(rtag)} --only {shlex.quote(tid)}")


def _test_source(hdir: Path, tag: str, tid: str) -> str:
    """The candidate's own test function (or the whole hunter file when the function cannot be cut out)."""
    rel, _, name = tid.partition("::")
    files = read_dict(hdir / tag / "response.json").get("files", [])
    key = name.split(" ")[-1].split("/")[0]
    # A Go id names the package (dir::TestName), a Jest id the file (file::title).
    ok = [f for f in files if isinstance(f, dict) and (f.get("path") == rel or str(Path(str(f.get("path"))).parent) == rel)]
    text = next((str(f.get("content", "")) for f in ok if key and key in str(f.get("content", ""))),
                str(ok[0].get("content", "")) if ok else "")
    at = text.find(key) if key else -1
    if at >= 0:
        start = max(0, text.rfind("\n", 0, max(0, at - 200)))
        return _capped_to(text[start:], SKEPTIC_TEST_CHARS)
    return _capped_to(text, SKEPTIC_TEST_CHARS)


def _capped_to(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n] + "\n[truncated]"


def _pr_test_text(d: Any) -> str:
    if not isinstance(d, dict):
        return str(d)
    body = d["added"] if d.get("added") is not None else d.get("diff")
    if body is None:
        return str(d)
    f = str(d.get("file") or d.get("path") or "")
    return f"{f}\n{body}" if f else str(body)


def _row_key(row: dict[str, Any]) -> tuple[str, str] | None:
    src, cid = row.get("source"), row.get("id")
    return (src, cid) if isinstance(src, str) and isinstance(cid, str) else None


def skeptic_context(hdir: Path) -> dict[str, Any]:
    """What a reviewer needs to place a failure: the PR's intent, the production diff and who calls the changed code.
    Entry-point callers first, then the shallowest."""
    ctx = read_dict(hdir / "ctx.json")
    pr: dict[str, Any] = ctx["pr"] if isinstance(ctx.get("pr"), dict) else {}
    callers = [c for c in ctx.get("callers", []) if isinstance(c, dict)]
    callers.sort(key=lambda c: (not c.get("entry_point"), int(c.get("hop") or 9)))
    picked, used = [], 0
    for c in callers:
        item = {k: c.get(k) for k in ("file", "symbol", "lines", "hop", "entry_point", "enclosing", "permission_checks")
                if c.get(k) not in (None, "", [])}
        item["source"] = _capped_to(str(c.get("source", "")), 800)
        used += len(json.dumps(item))
        if used > SKEPTIC_CALLERS_CHARS:
            break
        picked.append(item)
    return {"pr": {"title": pr.get("title", ""), "description": _capped_to(str(pr.get("description", "")),
                                                                            SKEPTIC_DESCRIPTION_CHARS)},
            "diff_production_code": _capped_to(str(ctx.get("diff_production_code", "")), SKEPTIC_DIFF_CHARS),
            "pr_tests_diff": _capped_to("\n".join(_pr_test_text(d) for d in ctx.get("pr_tests_diff") or []),
                                        SKEPTIC_PR_TESTS_CHARS),
            "callers": picked}


def _vet_inputs(
    hdir: Path, modes: tuple[str, ...], cands: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any], bool]:
    has_ab = any(t in modes for t in ("A", "B"))
    msg_tags = tuple(t for t in ("A", "B", "R") if t in modes)
    messages = {tag: read_dict(hdir / f"run_{tag}.messages.json") for tag in msg_tags}
    examples = read_dict(hdir / "diff_D.examples.json") if "D" in modes else {}
    ab_cands = candidates_ab(hdir, modes) if has_ab else []
    v_chunks = _v_chunks(ab_cands) if ab_cands else []
    chunk_by_cand = {(c["source"], str(c["id"])): vt for vt, ch in v_chunks for c in ch}
    v_ready = bool(has_ab and ab_cands and v_done(hdir, modes))
    v_results = {"run_V": read_dict(hdir / "run_V.json"), "base_V": read_dict(hdir / "base_V.json")} if v_ready else {
        "run_V": {}, "base_V": {}}
    items = []
    for c in cands:
        repro_tid = str(c.get("repro_id") or "") if c["source"] == "R" else str(c["id"])
        item: dict[str, Any] = {"id": c["id"], "source": c["source"],
                                "mechanical_verdict": c["mechanical_verdict"],
                                "repro_cmd": repro_cmd(hdir, repro_tid, diff=(c["source"] == "D"), tag=c["source"]) if repro_tid else ""}
        if c["source"] == "D":
            item["examples"] = (examples.get(c["id"]) or {}).get("examples", [])[:3]
        else:
            msg_key = repro_tid or str(c["id"])
            src_msgs = messages.get(c["source"], {})
            item["head_failure"] = str(src_msgs.get(msg_key, src_msgs.get(c["id"], "")))[:1200]
            if len(v_chunks) > 1 and (vt := chunk_by_cand.get((c["source"], str(c["id"])))):
                pref = f"{vt}:"
                item["diagnostic_v_results"] = {
                    "chunk": vt,
                    "run_V": {k: v for k, v in v_results["run_V"].items() if k.startswith(pref)},
                    "base_V": {k: v for k, v in v_results["base_V"].items() if k.startswith(pref)},
                }
            else:
                item["diagnostic_v_results"] = v_results
        if c["source"] in ("A", "B", "D"):
            item["test_source"] = _test_source(hdir, c["source"], c["id"])
        items.append(item)
    return items, skeptic_context(hdir), v_ready


def _vet_v_inputs_digest(
    hdir: Path, modes: tuple[str, ...],
    precomputed: tuple[list[dict[str, Any]], dict[str, Any], bool] | None = None,
) -> str:
    items, context, v_ready = precomputed if precomputed is not None else _vet_inputs(
        hdir, modes, candidates_all(hdir, modes))
    return run.fingerprint([{
        "items": json.dumps(items, sort_keys=True),
        "context": json.dumps(context, sort_keys=True),
        "v_ready": str(v_ready),
    }])


def stage_vet(hdir: Path, modes: tuple[str, ...] = MODE_ORDER, *, no_prompt_cache: bool | None = None) -> None:
    cands = candidates_all(hdir, modes)
    if not cands:
        write_json(hdir / "vetted.json", {"rows": []})
        (hdir / "vet.partial").unlink(missing_ok=True)
        (hdir / "vet.v_inputs.sha256").write_text(_vet_v_inputs_digest(hdir, modes))
        return
    precomputed = _vet_inputs(hdir, modes, cands)
    items, context, _ = precomputed
    schema = json.loads((SKILL_DIR / "vetted.schema.json").read_text())
    max_rows = max(1, int(schema.get("properties", {}).get("rows", {}).get("maxItems") or len(items)))
    vet_digest = _vet_v_inputs_digest(hdir, modes, precomputed)
    by_key = {(item["source"], item["id"]): item for item in items}
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    bad = 0
    partial = False
    for idx in range(0, len(items), max_rows):
        chunk = items[idx:idx + max_rows]
        chunk_keys = {(item["source"], item["id"]) for item in chunk}
        sub = "vet" if idx == 0 else f"vet_{idx // max_rows + 1}"
        req = build_requests.write_request(hdir / sub / "request.json", SKEPTIC_SYSTEM,
                                           {**context, "candidates": chunk}, schema,
                                           hdir / sub / "response.json", tier="opus")
        use_cached = (dispatch_one is _ORIG_DISPATCH_ONE) and dispatch.is_answered(req)
        if not use_cached:
            ok, _, _ = _call_dispatch(hdir, sub, req, strict_schema=False, no_prompt_cache=no_prompt_cache)
            if not ok:
                partial = True
                break
        data = read_dict(hdir / sub / "response.json")
        chunk_rows = data.get("rows")
        if not isinstance(chunk_rows, list):
            dispatch.sidecar(req).unlink(missing_ok=True)
            set_gap(hdir, "vet", "skeptic response has no rows array")
            partial = True
            break
        for r in chunk_rows:
            rk = _row_key(r) if isinstance(r, dict) else None
            if not isinstance(r, dict) or verdict.row_errors(r) or rk not in chunk_keys:
                bad += 1
                continue
            r["repro_cmd"] = by_key[rk]["repro_cmd"]
            grouped.setdefault(rk, []).append(r)
    good: list[dict[str, Any]] = []
    conflicts = 0
    for (src, cid), grp in grouped.items():
        if len({str(r.get("decision", "")).upper() for r in grp}) > 1:
            conflicts += 1
            good.append({"id": cid, "source": src, "decision": verdict.Verdict.HELD.value,
                         "reason": "skeptic returned conflicting decisions for this candidate", "file_line": "",
                         "caller": "", "entry_point": None, "repro_cmd": by_key[(src, cid)]["repro_cmd"],
                         "evidence_path": "vet/response.json", "severity": "minor", "fix_check": None,
                         "reason_code": "NEEDS_INPUT", "evidence_quote": ""})
        else:
            good.append(grp[0])
    # A candidate the skeptic did not answer is held only once all chunks ran; partial runs stay resumable.
    missing: list[tuple[str, str]] = []
    if not partial:
        answered = {(r["source"], r["id"]) for r in good}
        missing = [k for k in by_key if k not in answered]
        good += [{"id": cid, "source": src, "decision": verdict.Verdict.HELD.value,
                  "reason": "the skeptic returned no row for this candidate", "file_line": "", "caller": "",
                  "entry_point": None, "repro_cmd": by_key[(src, cid)]["repro_cmd"], "evidence_path": "vet/response.json",
                  "severity": "minor", "fix_check": None, "reason_code": "NEEDS_INPUT", "evidence_quote": ""}
                 for src, cid in missing]
        notes = [f"{bad} skeptic row(s) malformed or for unknown ids, ignored"] if bad else []
        notes += [f"{conflicts} candidate(s) with conflicting skeptic rows, held"] if conflicts else []
        notes += [f"{len(missing)} candidate(s) with no skeptic row, held"] if missing else []
        set_gap(hdir, "vet", "; ".join(notes) or None)
    # A DROP is a model claim. It stands only when its evidence is found verbatim in what the skeptic was shown.
    tests = {(item["source"], item["id"]): str(item.get("test_source", "")) for item in items}
    for r in good:
        verdict.check_drop(r, verdict.drop_corpus(context, tests.get((str(r.get("source")), str(r.get("id"))), "")))
    if not partial:
        write_json(hdir / "vetted.json", {"rows": good})
        (hdir / "vet.partial").unlink(missing_ok=True)
        (hdir / "vet.v_inputs.sha256").write_text(vet_digest)
    elif good:
        write_json(hdir / "vetted.json", {"rows": good})
        (hdir / "vet.partial").write_text("partial\n")
        (hdir / "vet.v_inputs.sha256").write_text(vet_digest)
    else:
        (hdir / "vetted.json").unlink(missing_ok=True)
        (hdir / "vet.v_inputs.sha256").unlink(missing_ok=True)
        (hdir / "vet.partial").write_text("partial\n")


def vet_done(hdir: Path, modes: tuple[str, ...] = MODE_ORDER) -> bool:
    if (hdir / "vet.partial").is_file() or not (hdir / "vetted.json").exists():
        return False
    has_ab = any(t in modes for t in ("A", "B"))
    if has_ab and candidates_ab(hdir, modes):
        gaps = read_dict(hdir / "driver.json").get("gaps", {})
        if isinstance(gaps, dict) and any(str(k).startswith("dispatch:V") for k in gaps):
            return False
    v_sha = hdir / "vet.v_inputs.sha256"
    if v_sha.is_file() and v_sha.read_text().strip() != _vet_v_inputs_digest(hdir, modes):
        return False
    rows = verdict.load_vetted(hdir)
    if rows is None:
        return False
    expected = {(c["source"], c["id"]) for c in candidates_all(hdir, modes)}
    actual = {(str(r.get("source", "")), str(r.get("id", ""))) for r in rows}
    return len(rows) == len(expected) and actual == expected


def cover_done(hdir: Path, modes: tuple[str, ...]) -> bool:
    """Mode A's changed lines are measured unless nothing needs it: Mode A not run, or a kept NEW_PR_BUG already decides
    the tier as Bug Proven. Otherwise Clean would rest on lines the hunter tests never touched."""
    if "A" not in modes or not (hdir / "run_A.json").exists() or (hdir / "run_A.coverage.json").exists():
        return True
    return ledger.keep_tier(hdir, verdict.admissibility(hdir)["keep"]) == "Bug Proven"


def stage_cover(target: str, hdir: Path) -> None:
    p = script("run.py", "cover", target, "A")
    if p.returncode != 0:
        set_gap(hdir, "cover:A", f"run.py cover A failed (exit {p.returncode}): changed lines not measured")
        return
    set_gap(hdir, "cover:A", None)


def stage_verdict(hdir: Path) -> None:
    adm = verdict.admissibility(hdir)
    hits = lessons.post_filter(hdir)
    print(lessons.counts_line(applied=len(hits), matched=len(adm["keep"]) + len(adm["held"])))
    keep, held, applied_ids = verdict.apply_lessons(adm, hits)
    if applied_ids:
        # Applying a failure_regex lesson to hold an admissible KEEP row counts as active use for prune().
        pr_ref = str(read_dict(hdir / "state.json").get("pr") or hdir.name)
        lessons.log_hits(pr_ref, [{"id": lid} for lid in applied_ids])
    write_json(hdir / "verdict.json", {"vetted_present": adm["vetted_present"], "keep": keep, "held": held})
    print(f"[verdict] kept {len(keep)}, held {len(held)}")


# ------------------------------------------------------------------ driver

def _completed_hunt_meta(hdir: Path, pv: str) -> dict[str, Any] | None:
    done_path = hdir / "hunt_done.json"
    if not done_path.is_file() or not (hdir / "prepare.json").is_file():
        return None
    done = read_dict(done_path)
    prep = read_dict(hdir / "prepare.json")
    if not done or not prep or not done.get("head"):
        return None
    if (done.get("head") != prep.get("head")
            or done.get("merge_base") != prep.get("merge_base")
            or done.get("base_mode") != prep.get("base_mode")
            or done.get("prompt_version") != pv):
        return None
    return done


def is_completed_hunt(hdir: Path, pv: str, requested_modes: tuple[str, ...], *,
                      first_batch: bool = False) -> dict[str, Any] | None:
    if not ((hdir / "findings.json").is_file() and (hdir / "audit.md").is_file()):
        return None
    done = _completed_hunt_meta(hdir, pv)
    if done is None:
        return None
    completed_modes = {str(m) for m in (done.get("modes") or [])}
    if not (set(requested_modes) <= completed_modes):
        return None
    batches = int(done.get("batches") or 1)
    if not first_batch and batches > 1 and (not done.get("all_batches", True) or int(done.get("batch") or 1) < batches):
        return None
    return done


def _record_hunt_done(hdir: Path, target: str, pv: str, modes: tuple[str, ...]) -> None:
    prep = read_dict(hdir / "prepare.json")
    state = read_dict(hdir / "state.json")
    doc = {
        "target": target,
        "target_key": target_key(target),
        "head": prep.get("head") or state.get("head", ""),
        "merge_base": prep.get("merge_base") or state.get("merge_base", ""),
        "base_mode": prep.get("base_mode"),
        "prompt_version": pv,
        "modes": list(modes),
        "batch": int(state.get("batch") or 1),
        "batches": int(state.get("batches") or 1),
        "all_batches": bool(state.get("all_batches", True)),
        "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    write_atomic(hdir / "hunt_done.json", doc)
    idx = scratch() / "hunted_index.jsonl"
    idx.parent.mkdir(parents=True, exist_ok=True)
    with idx.open("a") as fh:
        fh.write(json.dumps(doc) + "\n")


def _requests_done(hdir: Path, modes: tuple[str, ...]) -> bool:
    for t in ("A", "B", "D"):
        if t in modes and not (hdir / t / "request.json").exists():
            return False
    if "R" in modes:
        return _r_requests_done(hdir)
    return True


def _run_done(hdir: Path, modes: tuple[str, ...]) -> bool:
    gaps = read_dict(hdir / "driver.json").get("gaps", {})
    g = gaps if isinstance(gaps, dict) else {}
    if "A" in modes and (not (_run_committed(hdir, "A") and (hdir / "A" / "retry.done").exists()) or "run:A" in g):
        return False
    if "B" in modes and (not _run_committed(hdir, "B") or "run:B" in g):
        return False
    if "D" in modes and (not _run_committed(hdir, "D") or "run:D" in g):
        return False
    return not ("R" in modes and (hdir / "R" / "request.json").exists()
                and (not _run_committed(hdir, "R") or "run:R" in g))


def _sync_modes_in_state(hdir: Path, modes: tuple[str, ...], *, first_batch: bool = False) -> None:
    state_path = hdir / "state.json"
    if not state_path.exists():
        return
    state = read_dict(state_path)
    changed = False
    if state and state.get("modes") != list(modes):
        state["modes"] = list(modes)
        changed = True
    if state and not first_batch and int(state.get("batches") or 1) > 1 and not state.get("all_batches", True):
        state["all_batches"] = True
        changed = True
        for stale in ("findings.json", "audit.md", "hunt_done.json"):
            (hdir / stale).unlink(missing_ok=True)
    if changed:
        write_atomic(state_path, state)


def _batch_settled(hdir: Path, modes: tuple[str, ...], base_tags: tuple[str, ...]) -> bool:
    gaps = read_dict(hdir / "driver.json").get("gaps", {})
    g = gaps if isinstance(gaps, dict) else {}
    if any(_gap_for_active_modes(str(k), modes) for k in g):
        return False
    return _run_done(hdir, modes) and not any(base_pending(hdir, t) for t in base_tags)


def _gap_for_active_modes(key: str, modes: tuple[str, ...]) -> bool:
    if not key.startswith(("dispatch:", "run:", "base:")):
        return False
    tag = key.split(":", 2)[1]
    if tag.startswith("vet"):
        return True
    if tag.startswith("V"):
        return any(m in modes for m in ("A", "B"))
    return bool(tag) and tag[0] in modes


def _hunt_complete(hdir: Path, modes: tuple[str, ...]) -> bool:
    if not (dispatched(hdir, modes) and _run_done(hdir, modes)):
        return False
    if any(base_pending(hdir, t) for t in BASE_TAGS if t in modes):
        return False
    if (hdir / "state.json").exists() and not ((hdir / "old_tests.json").is_file() and (hdir / "pr_tests.json").is_file()):
        return False
    if not (v_done(hdir, modes) and vet_done(hdir, modes)):
        return False
    if not all((hdir / f).is_file() for f in ("verdict.json", "findings.json", "audit.md")):
        return False
    if over_budget(hdir):
        return False
    gaps = read_dict(hdir / "driver.json").get("gaps", {})
    if isinstance(gaps, dict) and any(_gap_for_active_modes(str(k), modes) for k in gaps):
        return False
    state = read_dict(hdir / "state.json")
    cur_batch = int(state.get("batch") or 1)
    total_batches = int(state.get("batches") or 1)
    return not state.get("all_batches") or cur_batch >= total_batches


def _archived_batches_missing_modes(hdir: Path, modes: tuple[str, ...]) -> bool:
    broot = hdir / "batches"
    if not broot.is_dir():
        return False
    for bdir in broot.iterdir():
        if not bdir.is_dir() or not bdir.name.startswith("batch_"):
            continue
        for t in ("A", "B", "D"):
            if t in modes and not (bdir / t / "request.json").exists():
                return True
    return False


def _ensure_review_verdicts(hdir: Path) -> None:
    if not (hdir / "R" / "threads.json").exists():
        return
    rv = hdir / "review_verdicts.json"
    deps = [hdir / "R" / "threads.json", hdir / "R" / "response.json", hdir / "run_R.json", hdir / "base_R.json"]
    rv_mtime = rv.stat().st_mtime if rv.is_file() else -1.0
    if any(p.is_file() and p.stat().st_mtime >= rv_mtime for p in deps):
        review_threads.compute_verdicts(hdir)


def drive(target: str, fresh: bool = False, *, force: bool = False, modes: tuple[str, ...] = DEFAULT_MODES,
          no_prompt_cache: bool | None = None, first_batch: bool = False) -> int:
    hdir = hunt_dir(target)
    with driver_lock(hdir, target):
        print(trusted.check())
        _require_pr_isolation(target)
        pv = build_requests.prompt_version(SKILL_DIR, SCHEMA_VERSION)
        step(hdir, "prepare", lambda: False, lambda: stage_prepare(target, hdir, fresh=fresh or force))
        if not fresh and not force:
            completed = is_completed_hunt(hdir, pv, modes, first_batch=first_batch)
            if completed is not None:
                head = str(completed.get("head") or "")
                print(f"[hunt] skip: already hunted {target} (head={head[:10]}, prompt_version={pv}); pass --force to re-run")
                return 0
            prev_done = _completed_hunt_meta(hdir, pv)
            prev_modes = {str(m) for m in (prev_done.get("modes") or [])} if prev_done else {
                str(m) for m in (read_dict(hdir / "driver.json").get("modes") or [])}
            if (prev_modes and (set(modes) - prev_modes)
                    and (int(read_dict(hdir / "state.json").get("batches") or 1) > 1
                         or _archived_batches_missing_modes(hdir, modes))):
                ctx.reset_hunt_dir(hdir, include_whole_pr=True)
            elif prev_done is not None:
                expanding_batches = (not first_batch and int(prev_done.get("batches") or 1) > 1
                                     and not prev_done.get("all_batches", True) and set(modes) <= prev_modes)
                if expanding_batches:
                    for stale in ("findings.json", "audit.md", "hunt_done.json"):
                        (hdir / stale).unlink(missing_ok=True)
                    st = read_dict(hdir / "state.json")
                    if st:
                        st["all_batches"] = True
                        write_atomic(hdir / "state.json", st)
                else:
                    for stale in ("vetted.json", "verdict.json", "findings.json", "audit.md", "hunt_done.json"):
                        (hdir / stale).unlink(missing_ok=True)
        if read_dict(hdir / "prepare.json").get("huntable_files") == 0:
            print("[hunt] skip: no huntable source files (docs-only/test-only diff)")
            return 0
        _update_driver(hdir, lambda doc: doc.__setitem__("modes", list(modes)))
        ctx_args = [target, "--first-batch"] if first_batch else [target]
        step(hdir, "ctx", lambda: (hdir / "ctx.json").exists() or read_dict(hdir / "state.json").get("batches") == 0,
             lambda: expect_ok(script("ctx.py", *ctx_args), "ctx.py"))
        if read_dict(hdir / "state.json").get("batches") == 0:
            print("[hunt] skip: no huntable source files (docs-only/test-only diff; see skipped.log)")
            return 0
        base_tags = tuple(t for t in BASE_TAGS if t in modes)
        while True:
            _sync_modes_in_state(hdir, modes, first_batch=first_batch)
            step(hdir, "requests", lambda: _requests_done(hdir, modes),
                 lambda: stage_requests(target, hdir, modes))
            step(hdir, "dispatch", lambda: dispatched(hdir, modes),
                 lambda: stage_dispatch(hdir, modes, no_prompt_cache=no_prompt_cache))
            step(hdir, "run", lambda: _run_done(hdir, modes),
                 lambda: stage_run(target, hdir, modes, no_prompt_cache=no_prompt_cache))
            step(hdir, "base", lambda: not any(base_pending(hdir, t) for t in base_tags),
                 lambda: stage_base(target, hdir, modes))
            if "R" in modes:
                _ensure_review_verdicts(hdir)
            step(hdir, "old_tests", lambda: (hdir / "old_tests.json").exists(),
                 lambda: expect_ok(script("old_tests.py", target), "old_tests.py"))
            step(hdir, "pr_tests", lambda: (hdir / "pr_tests.json").exists(),
                 lambda: expect_ok(script("pr_tests.py", target), "pr_tests.py"))
            step(hdir, "vet_v", lambda: v_done(hdir, modes),
                 lambda: stage_v(target, hdir, modes, no_prompt_cache=no_prompt_cache))
            step(hdir, "vet", lambda: vet_done(hdir, modes),
                 lambda: stage_vet(hdir, modes, no_prompt_cache=no_prompt_cache))
            step(hdir, "cover", lambda: cover_done(hdir, modes), lambda: stage_cover(target, hdir))
            over_budget(hdir)
            step(hdir, "verdict", lambda: False, lambda: stage_verdict(hdir))
            step(hdir, "report", lambda: False, lambda: report.write(hdir, target))
            state = read_dict(hdir / "state.json")
            cur_batch = int(state.get("batch") or 1)
            total_batches = int(state.get("batches") or 1)
            if (first_batch and not state.get("forced_all_batches")) or not state.get("all_batches") or cur_batch >= total_batches:
                break
            if not _batch_settled(hdir, modes, base_tags) or not vet_done(hdir, modes) or over_budget(hdir):
                break
            next_batch = cur_batch + 1
            with telemetry.stage(hdir, "step:ctx"):
                expect_ok(script("ctx.py", target, "--batch", str(next_batch)), f"ctx.py --batch {next_batch}")
        if _hunt_complete(hdir, modes):
            _record_hunt_done(hdir, target, pv, modes)
    return 0


def parse_modes(raw: str) -> tuple[str, ...] | None:
    parts = [p.strip().upper() for p in raw.split(",") if p.strip()]
    if not parts or any(p not in VALID_MODES for p in parts):
        return None
    picked = set(parts)
    return tuple(m for m in MODE_ORDER if m in picked)


def main(argv: list[str]) -> int:
    args = argv[1:]
    if any(a in ("-h", "--help") for a in args):
        print(__doc__)
        return 0
    fresh = force = first_batch = False
    no_prompt_cache: bool | None = None
    modes: tuple[str, ...] = DEFAULT_MODES
    target: str | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--fresh":
            fresh = True
        elif a == "--force":
            force = True
        elif a == "--first-batch":
            first_batch = True
        elif a == "--no-prompt-cache":
            no_prompt_cache = True
        elif a == "--modes" or a.startswith("--modes="):
            val = a.split("=", 1)[1] if "=" in a else (args[i + 1] if i + 1 < len(args) else "")
            if "=" not in a:
                i += 1
            parsed = parse_modes(val)
            if parsed is None:
                print(__doc__)
                return 1
            modes = parsed
        elif a.startswith("-") or target is not None:
            print(__doc__)
            return 1
        else:
            target = a
        i += 1
    if target is None:
        print(__doc__)
        return 1
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, terminate_handler)
    try:
        return drive(target, fresh=fresh, force=force, modes=modes, no_prompt_cache=no_prompt_cache,
                     first_batch=first_batch)
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    except Stop as s:
        print(str(s))
        return s.code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
