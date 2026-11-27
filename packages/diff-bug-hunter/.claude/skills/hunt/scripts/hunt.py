#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Unattended driver: a deterministic state machine over the hunt scripts. The model answers only the requests it is
given (hunters, Mode V diagnostics, the skeptic); every other step is a script.

usage: hunt.py <pr | base..head | base...head> [--fresh] [--force] [--modes A,B,D,R] [--no-prompt-cache]
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
import json
import os
import re
import shlex
import signal
import subprocess
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_requests
import dispatch
import lessons
import prefilter
import report
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

def script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    """Run one hunt script from the scripts directory, streaming its output into the driver's log."""
    p = subprocess.run([sys.executable, str(SCRIPTS / name), *args], cwd=SCRIPTS, capture_output=True, text=True,
                       errors="replace", check=False)
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
    if over_budget(hdir):
        print(f"[dispatch {tag}] skipped: budget reached")
        return False, None, None
    try:
        res = dispatch.dispatch(request, hdir=hdir, tag=tag, strict_schema=strict_schema,
                                no_prompt_cache=no_prompt_cache)
    except dispatch.DispatchError as e:
        print(f"[dispatch {tag}] FAILED {str(e)[:300]}")
        set_gap(hdir, f"dispatch:{tag}", str(e)[:500])
        return False, None, e
    print(f"[dispatch {tag}] {res.status} retries={res.retries} tokens_in={res.tokens_in} "
          f"cache_write={res.cache_write} cache_read={res.cache_read} tokens_out={res.tokens_out}")
    set_gap(hdir, f"dispatch:{tag}", None)
    return True, res, None


def dispatch_one(hdir: Path, tag: str, request: Path) -> bool:
    """One model call for one request. A failed call is a gap, not a stop: the hunter is reported as failed."""
    ok, _, _ = dispatch_with_result(hdir, tag, request)
    return ok


_ORIG_DISPATCH_ONE = dispatch_one


def _call_dispatch(hdir: Path, tag: str, request: Path, *, strict_schema: bool = False,
                   no_prompt_cache: bool | None = None) -> tuple[
                       bool, dispatch.DispatchResult | None, dispatch.DispatchError | None]:
    if dispatch_one is not _ORIG_DISPATCH_ONE:
        return dispatch_one(hdir, tag, request), None, None
    return dispatch_with_result(hdir, tag, request, strict_schema=strict_schema, no_prompt_cache=no_prompt_cache)


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
        elif line.startswith("+++ b/"):
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
        else:
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
            if fpath and isinstance(item.get("lines"), str):
                m = re.match(r"^(\d+)-(\d+)$", item["lines"].strip())
                if m:
                    valid.setdefault(fpath, set()).update(range(int(m.group(1)), int(m.group(2)) + 1))
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
    raw_schema = req_data.get("schema")
    schema: dict[str, Any] = raw_schema if isinstance(raw_schema, dict) else build_requests.HUNTER_SCHEMA
    build_requests.write_request(
        opus_req, str(req_data.get("system") or ""), user_obj, schema, resp_path, tier="opus",
    )
    record_escalation(hdir, tag, reason, from_tier=from_tier, to_tier="opus")
    ok, res, err = _call_dispatch(hdir, tag, opus_req, strict_schema=True, no_prompt_cache=no_prompt_cache)
    if ok:
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


def stage_requests(target: str, hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> None:
    # Review first: a failure there leaves no hunter request behind, so the next run builds everything again.
    if "R" in modes:
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
            results[t] = (_path, ok, res, err)
    for t in active_tags:
        if t not in results or not can_escalate(hdir):
            continue
        req_path, _ok, res, err = results[t]
        req_tier = str(read_dict(req_path).get("tier") or "sonnet").lower()
        if req_tier != "sonnet":
            continue
        reason = _escalation_reason(hdir, t, req_path, res, err)
        if reason:
            escalate_tag(hdir, t, reason, no_prompt_cache=no_prompt_cache)


def dispatched(hdir: Path, modes: tuple[str, ...] = DEFAULT_MODES) -> bool:
    active_tags = tuple(t for t in HUNTER_TAGS if t in modes)
    reqs = requests_present(hdir, active_tags)
    if over_budget(hdir):
        return True  # the breaker tripped: run on the answers that exist
    return bool(reqs) and all(dispatch.is_answered(path) for _, path in reqs)


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
    return p


def run_tag(target: str, hdir: Path, tag: str, *, retry_empty: bool = False,
            no_prompt_cache: bool | None = None) -> None:
    if (hdir / f"run_{tag}.json").exists():
        return
    if not (hdir / tag / "response.json").exists():
        set_gap(hdir, f"run:{tag}", f"hunter {tag} wrote no response")
        return
    p = _run_with_repair(target, hdir, tag, "run", f"run.py run {tag}", no_prompt_cache=no_prompt_cache)
    if p is None:
        return
    if retry_empty and "EMPTY_RESPONSE" in p.stdout and not (hdir / tag / "request.retry.json").exists():
        expect_ok(script("build_requests.py", target, "retry", tag), f"build_requests retry {tag}")
        ok, _, _ = _call_dispatch(hdir, f"{tag}:retry", hdir / tag / "request.retry.json",
                                  strict_schema=True, no_prompt_cache=no_prompt_cache)
        if ok:
            p = script("run.py", "run", target, tag)
            expect_ok(p, f"run.py run {tag} after retry")
    if retry_empty and "EMPTY_RESPONSE" in p.stdout and can_escalate(hdir):
        req_tier = str(read_dict(effective_request(hdir, tag)).get("tier") or "sonnet").lower()
        if req_tier == "sonnet" and not (hdir / tag / "request.opus.json").exists():
            ok, _, _ = escalate_tag(hdir, tag, "empty_after_retry", no_prompt_cache=no_prompt_cache)
            if ok:
                p2 = _run_with_repair(target, hdir, tag, "run", f"run.py run {tag} after opus escalation",
                                      no_prompt_cache=no_prompt_cache)
                if p2 is None:
                    return
                p = p2
    set_gap(hdir, f"empty:{tag}", "Mode A emitted no tests after one retry" if "EMPTY_RESPONSE" in p.stdout else None)
    set_gap(hdir, f"run:{tag}", None)


def run_diff(target: str, hdir: Path, *, no_prompt_cache: bool | None = None) -> None:
    if (hdir / "diff_D.json").exists():
        return
    if not (hdir / "D" / "response.json").exists():
        set_gap(hdir, "run:D", "hunter D wrote no response")
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


def candidates_ab(hdir: Path) -> list[dict[str, Any]]:
    """Mode A and B tests that fail 3 of 3 on head and pass on the merge-base: the ones Mode V diagnoses."""
    out = []
    for tag in ("A", "B"):
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_PR_BUG:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def candidates_new_api(hdir: Path) -> list[dict[str, Any]]:
    """Mode A/B tests that fail 3 of 3 on head and cannot run on the merge-base because they call the PR's new API.
    No base oracle exists, so the skeptic judges them against the PR's description (PR 40256: the write-scope bug)."""
    out = []
    for tag in ("A", "B"):
        head = read_dict(hdir / f"run_{tag}.json")
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_API and head.get(tid) == verdict.Verdict.FAIL_3_OF_3:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def candidates_all(hdir: Path) -> list[dict[str, Any]]:
    """Everything the skeptic may decide on: Mode A/B NEW_PR_BUG or NEW_API (head 3 of 3), Mode R PROVEN with a
    NEW_PR_BUG base, Mode D DIFF."""
    out = candidates_ab(hdir) + candidates_new_api(hdir)
    for tid, item in read_dict(hdir / "review_verdicts.json").get("verdicts", {}).items():
        if isinstance(item, dict) and item.get("verdict") == verdict.Verdict.PROVEN \
                and item.get("base_verdict") == verdict.Verdict.NEW_PR_BUG:
            out.append({"id": tid, "source": "R", "mechanical_verdict": verdict.Verdict.NEW_PR_BUG})
    for tid, v in read_dict(hdir / "diff_D.json").items():
        if v == verdict.Verdict.DIFF:
            out.append({"id": tid, "source": "D", "mechanical_verdict": v})
    return out


def stage_v(target: str, hdir: Path, *, no_prompt_cache: bool | None = None) -> None:
    cands = candidates_ab(hdir)
    if not cands:
        return
    files_by_tag: dict[str, str] = {}
    for tag in ("A", "B"):
        resp = read_dict(hdir / tag / "response.json")
        files_by_tag[tag] = _capped_to("\n\n".join(f"// {f.get('path', '')}\n{f.get('content', '')}"
                                                  for f in resp.get("files", []) if isinstance(f, dict)),
                                        MAX_PAYLOAD_CHARS)
    messages: dict[str, Any] = {}
    for tag in ("A", "B"):
        messages.update(read_dict(hdir / f"run_{tag}.messages.json"))
    user = {"candidates": [{"id": c["id"], "tag": c["source"], "head_failure": str(messages.get(c["id"], ""))[:1500],
                            "test_source": files_by_tag[c["source"]]} for c in cands]}
    opus_req = hdir / "V" / "request.opus.json"
    req = opus_req if opus_req.exists() else build_requests.write_request(
        hdir / "V" / "request.json", V_SYSTEM, user, build_requests.HUNTER_SCHEMA, hdir / "V" / "response.json")
    ok, res, err = _call_dispatch(hdir, "V", req, strict_schema=True, no_prompt_cache=no_prompt_cache)
    reason: str | None = None
    if err is not None and err.schema_errors:
        reason = "schema_validation_failed"
    elif (res is not None and res.stop_reason in MAX_TOKENS_REASONS) or (
            err is not None and err.stop_reason in MAX_TOKENS_REASONS):
        reason = "max_tokens"
    if reason and can_escalate(hdir):
        ok, _, _ = escalate_tag(hdir, "V", reason, no_prompt_cache=no_prompt_cache)
    if not ok:
        return
    p = script("run.py", "run", target, "V")
    if p.returncode == 3:  # the diagnostic tests did not compile: vet the candidates on the A/B evidence alone
        tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
        set_gap(hdir, "vet_v", f"Mode V COMPILE_ERROR: {tail[0][:300]}")
        return
    expect_ok(p, "run.py run V")
    set_gap(hdir, "vet_v", None)
    expect_ok(script("run.py", "base", target, "V"), "run.py base V")


def v_done(hdir: Path) -> bool:
    if not candidates_ab(hdir):
        return True
    if not (hdir / "run_V.json").exists():
        return "vet_v" in read_dict(hdir / "driver.json").get("gaps", {})
    return not failing(hdir, "V") or (hdir / "base_V.json").exists()


SKEPTIC_DESCRIPTION_CHARS = 3000
SKEPTIC_DIFF_CHARS = 12000
SKEPTIC_CALLERS_CHARS = 6000
SKEPTIC_TEST_CHARS = 3000
SKEPTIC_PR_TESTS_CHARS = 4000


def repro_cmd(hdir: Path, tid: str) -> str:
    """The command that reruns one hunted test, from the repository root of the PR head, as run.py runs it."""
    rel, _, name = tid.partition("::")
    wt = Path(str(read_dict(hdir / "state.json").get("wt") or "."))
    if rel.endswith((".ts", ".tsx", ".js", ".jsx")):
        import run  # only for the Jest root lookup
        try:
            root = run.jest_root(wt, rel).relative_to(wt.resolve())
        except (InfraError, ValueError):
            root = Path("webapp/channels")
        if Path(rel).is_relative_to(root):
            return f"cd {root} && npx jest {Path(rel).relative_to(root)} -t {shlex.quote(name)}"
        # A test outside the Jest root (webapp/platform) is found only through --roots, as run.py runs it.
        pkg = run.jest_pkg_dir(wt, rel, wt / root)
        roots = f"--roots . --roots {os.path.relpath(pkg, (wt / root).resolve())} " if pkg is not None else ""
        return f"cd {root} && npx jest {roots}--runTestsByPath {os.path.relpath(rel, root)} -t {shlex.quote(name)}"
    mod = Path(rel)
    while mod.parts and not (wt / mod / "go.mod").exists():
        mod = mod.parent
    pkg = Path(rel).relative_to(mod) if mod.parts else Path(rel)
    cd = f"cd {mod} && " if mod.parts else ""
    return f"{cd}go test ./{pkg} -run '^{name.split('/')[0]}$' -count=1"


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
            "pr_tests_diff": _capped_to("\n".join(str(d.get("diff", d)) if isinstance(d, dict) else str(d)
                                                  for d in ctx.get("pr_tests_diff") or []), SKEPTIC_PR_TESTS_CHARS),
            "callers": picked}


def stage_vet(hdir: Path, *, no_prompt_cache: bool | None = None) -> None:
    cands = candidates_all(hdir)
    if not cands:
        write_json(hdir / "vetted.json", {"rows": []})
        return
    messages: dict[str, Any] = {}
    for tag in ("A", "B", "V"):
        messages.update(read_dict(hdir / f"run_{tag}.messages.json"))
    examples = read_dict(hdir / "diff_D.examples.json")
    v_results = {"run_V": read_dict(hdir / "run_V.json"), "base_V": read_dict(hdir / "base_V.json")}
    items = []
    for c in cands:
        item: dict[str, Any] = {"id": c["id"], "source": c["source"],
                                "mechanical_verdict": c["mechanical_verdict"], "repro_cmd": repro_cmd(hdir, c["id"])}
        if c["source"] == "D":
            item["examples"] = (examples.get(c["id"]) or {}).get("examples", [])[:3]
        else:
            item["head_failure"] = str(messages.get(c["id"], ""))[:1200]
            item["diagnostic_v_results"] = v_results
        if c["source"] in ("A", "B", "D"):
            item["test_source"] = _test_source(hdir, c["source"], c["id"])
        items.append(item)
    schema = json.loads((SKILL_DIR / "vetted.schema.json").read_text())
    context = skeptic_context(hdir)
    req = build_requests.write_request(hdir / "vet" / "request.json", SKEPTIC_SYSTEM,
                                       {**context, "candidates": items}, schema,
                                       hdir / "vet" / "response.json", tier="opus")
    ok, _, _ = _call_dispatch(hdir, "vet", req, strict_schema=False, no_prompt_cache=no_prompt_cache)
    if not ok:
        return
    data = read_dict(hdir / "vet" / "response.json")
    rows = data.get("rows")
    if not isinstance(rows, list):
        set_gap(hdir, "vet", "skeptic response has no rows array")
        return
    repro = {item["id"]: item["repro_cmd"] for item in items}
    for r in rows:  # the repro command is mechanical: what the driver ran, not what the model remembers
        if isinstance(r, dict) and r.get("id") in repro:
            r["repro_cmd"] = repro[r["id"]]
    ids = {item["id"]: item for item in items}
    good = [r for r in rows if isinstance(r, dict) and not verdict.row_errors(r) and r.get("id") in ids]
    bad = len(rows) - len(good)
    # A candidate the skeptic did not answer is held, never silently gone (PR text can ask the model to omit one).
    answered = {r["id"] for r in good}
    missing = [i for i in ids if i not in answered]
    good += [{"id": i, "source": ids[i]["source"], "decision": verdict.Verdict.HELD.value,
              "reason": "the skeptic returned no row for this candidate", "file_line": "", "caller": "",
              "entry_point": None, "repro_cmd": ids[i]["repro_cmd"], "evidence_path": "vet/response.json",
              "severity": "minor", "fix_check": None, "reason_code": "NEEDS_INPUT", "evidence_quote": ""}
             for i in missing]
    notes = [f"{bad} skeptic row(s) malformed or for unknown ids, ignored"] if bad else []
    notes += [f"{len(missing)} candidate(s) with no skeptic row, held"] if missing else []
    set_gap(hdir, "vet", "; ".join(notes) or None)
    # A DROP is a model claim. It stands only when its evidence is found verbatim in what the skeptic was shown.
    tests = {item["id"]: str(item.get("test_source", "")) for item in items}
    for r in good:
        verdict.check_drop(r, verdict.drop_corpus(context, tests.get(str(r.get("id")), "")))
    write_json(hdir / "vetted.json", {"rows": good})


def vet_done(hdir: Path) -> bool:
    return (hdir / "vetted.json").exists()


def stage_verdict(hdir: Path) -> None:
    adm = verdict.admissibility(hdir)
    lesson_hits = {h["test_id"]: h["lesson_id"] for h in lessons.post_filter(hdir)}
    print(lessons.counts_line(applied=len(lesson_hits), matched=len(adm["keep"]) + len(adm["held"])))
    keep, held = [], list(adm["held"])
    for row in adm["keep"]:
        lid = lesson_hits.get(str(row.get("id", "")))
        if lid is None:
            keep.append(row)
        else:
            held.append({"row": row, "reasons": [f"failure text matches false-positive lesson {lid}"]})
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


def is_completed_hunt(hdir: Path, pv: str, requested_modes: tuple[str, ...]) -> dict[str, Any] | None:
    if not ((hdir / "findings.json").is_file() and (hdir / "audit.md").is_file()):
        return None
    done = _completed_hunt_meta(hdir, pv)
    if done is None:
        return None
    completed_modes = {str(m) for m in (done.get("modes") or [])}
    if not (set(requested_modes) <= completed_modes):
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
        return (hdir / "R" / "threads.json").exists() or (hdir / "R" / "request.json").exists()
    return True


def _run_done(hdir: Path, modes: tuple[str, ...]) -> bool:
    if "A" in modes and not (hdir / "run_A.json").exists():
        return False
    if "B" in modes and not (hdir / "run_B.json").exists():
        return False
    if "D" in modes and not (hdir / "diff_D.json").exists():
        return False
    return not ("R" in modes and (hdir / "R" / "request.json").exists() and not (hdir / "run_R.json").exists())


def _sync_modes_in_state(hdir: Path, modes: tuple[str, ...]) -> None:
    state_path = hdir / "state.json"
    if not state_path.exists():
        return
    state = read_dict(state_path)
    if state and state.get("modes") != list(modes):
        state["modes"] = list(modes)
        write_atomic(state_path, state)


def drive(target: str, fresh: bool = False, *, force: bool = False, modes: tuple[str, ...] = DEFAULT_MODES,
          no_prompt_cache: bool | None = None) -> int:
    hdir = hunt_dir(target)
    with driver_lock(hdir, target):
        print(trusted.check())
        pv = build_requests.prompt_version(SKILL_DIR, SCHEMA_VERSION)
        step(hdir, "prepare", lambda: False, lambda: stage_prepare(target, hdir, fresh=fresh or force))
        if not fresh and not force:
            completed = is_completed_hunt(hdir, pv, modes)
            if completed is not None:
                head = str(completed.get("head") or "")
                print(f"[hunt] skip: already hunted {target} (head={head[:10]}, prompt_version={pv}); pass --force to re-run")
                return 0
            if _completed_hunt_meta(hdir, pv) is not None:
                for stale in ("vetted.json", "verdict.json", "findings.json", "audit.md", "hunt_done.json"):
                    (hdir / stale).unlink(missing_ok=True)
        if read_dict(hdir / "prepare.json").get("huntable_files") == 0:
            print("[hunt] skip: no huntable source files (docs-only/test-only diff)")
            return 0
        _update_driver(hdir, lambda doc: doc.__setitem__("modes", list(modes)))
        step(hdir, "ctx", lambda: (hdir / "ctx.json").exists() or read_dict(hdir / "state.json").get("batches") == 0,
             lambda: expect_ok(script("ctx.py", target), "ctx.py"))
        if read_dict(hdir / "state.json").get("batches") == 0:
            print("[hunt] skip: no huntable source files (docs-only/test-only diff; see skipped.log)")
            return 0
        _sync_modes_in_state(hdir, modes)
        step(hdir, "requests", lambda: _requests_done(hdir, modes),
             lambda: stage_requests(target, hdir, modes))
        step(hdir, "dispatch", lambda: dispatched(hdir, modes),
             lambda: stage_dispatch(hdir, modes, no_prompt_cache=no_prompt_cache))
        step(hdir, "run", lambda: _run_done(hdir, modes),
             lambda: stage_run(target, hdir, modes, no_prompt_cache=no_prompt_cache))
        base_tags = tuple(t for t in BASE_TAGS if t in modes)
        step(hdir, "base", lambda: not any(base_pending(hdir, t) for t in base_tags),
             lambda: stage_base(target, hdir, modes))
        step(hdir, "old_tests", lambda: (hdir / "old_tests.json").exists(),
             lambda: expect_ok(script("old_tests.py", target), "old_tests.py"))
        step(hdir, "pr_tests", lambda: (hdir / "pr_tests.json").exists(),
             lambda: expect_ok(script("pr_tests.py", target), "pr_tests.py"))
        step(hdir, "vet_v", lambda: v_done(hdir),
             lambda: stage_v(target, hdir, no_prompt_cache=no_prompt_cache))
        step(hdir, "vet", lambda: vet_done(hdir),
             lambda: stage_vet(hdir, no_prompt_cache=no_prompt_cache))
        step(hdir, "verdict", lambda: False, lambda: stage_verdict(hdir))
        step(hdir, "report", lambda: False, lambda: report.write(hdir, target))
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
    fresh = force = False
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
        return drive(target, fresh=fresh, force=force, modes=modes, no_prompt_cache=no_prompt_cache)
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    except Stop as s:
        print(str(s))
        return s.code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
