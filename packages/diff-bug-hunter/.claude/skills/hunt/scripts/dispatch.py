#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""LLM adapter: answer one hunter request file and write its response.json.

usage: dispatch.py <request.json> [--tag <tag>]

Two ways to call the model:
- $HUNT_DISPATCH_CMD set: the same `<cmd> <request.json>` contract as eval_bugs.py --dispatch. The command receives
  the request path as its last argument and must write the request's response_path itself.
- Unset (the default): one inline turn with no tools. DEFAULT_CMD gets the request's System section as its system
  prompt (--system-prompt-file) and the User and Schema sections on stdin, and must print one JSON object. The
  model has no file, shell or web tool (`--tools ''`), so text in a diff, PR body or review thread cannot make it read
  or write anything; its answer is data that this script parses and writes. It loads no user settings, hooks,
  plugins, MCP servers or skills, so each call pays only for the request itself.

Behaviour:
- Idempotent: a request already answered (response.json exists and `<request>.dispatched` holds this request's sha256)
  is skipped. Any other state dispatches again, and the stale response.json is removed first, so a command that writes
  nothing fails instead of passing an old answer.
- Concurrency: at most $HUNT_MAX_DISPATCH (default 8) model calls run at once on this machine, across every hunt.
  A call waits for a free slot (a file lock under the scratch dir), polling with jitter, for at most TIMEOUT_S.
- Retries only transient failures (non-zero exit or is_error with 5xx, `upstream_unreachable` or `overloaded` in its
  output): up to MAX_TRIES attempts with exponential backoff (1 s, 2 s, ... capped at 60 s). `sleep` is injectable.
- On success the response is re-read (lossy JSON repair, see hunt_common.load_json), then written atomically
  (temp file + os.replace).
- Token counts and cost come from the CLI's JSON when present: tokens_in is usage.input_tokens plus the cache-creation
  and cache-read input tokens (all of them are billed input), tokens_out is usage.output_tokens, cost is
  total_cost_usd. They go to telemetry.jsonl as one `dispatch` row per call.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import fcntl
import hashlib
import json
import os
import random
import re
import shlex
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import telemetry
from hunt_common import InfraError, load_json, loads_lossy, scratch, write_json

DEFAULT_CMD = "claude -p --output-format json --tools '' --strict-mcp-config --disable-slash-commands --setting-sources ''"
OUTPUT_RULE = ("Answer with exactly one JSON object that matches the JSON schema in the Schema section. No prose, no "
               "markdown fences. You have no tools: answer only from the request.")
DEFAULT_MAX_DISPATCH = 8
MAX_TRIES = 5
BASE_DELAY_S = 1.0
MAX_DELAY_S = 60.0
TIMEOUT_S = 1800
TRANSIENT = re.compile(r"upstream_unreachable|overloaded|\b5\d\d\b", re.IGNORECASE)


class DispatchError(RuntimeError):
    """The model call failed for good: a non-transient failure, retries exhausted, or no response written."""


@dataclass
class DispatchResult:
    status: str  # "ok" or "skipped" (already answered for this request)
    retries: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    secs: float = 0.0


def request_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sidecar(request: Path) -> Path:
    return request.with_name(request.name + ".dispatched")


def response_path(request: Path) -> Path:
    data = load_json(request)
    if not isinstance(data, dict) or not isinstance(data.get("response_path"), str):
        raise InfraError(f"{request} has no response_path")
    return Path(data["response_path"])


def is_answered(request: Path) -> bool:
    """True when this exact request was dispatched and its response is on disk."""
    side = sidecar(request)
    try:
        return side.read_text().strip() == request_sha(request) and response_path(request).exists()
    except OSError:
        return False


def _usage(stdout: str) -> tuple[dict[str, Any] | None, int, int, float]:
    """The CLI's JSON object (None when stdout is not JSON), with token counts and cost (zero when absent)."""
    try:
        data = json.loads(stdout)
    except ValueError:
        return None, 0, 0, 0.0
    if not isinstance(data, dict):
        return None, 0, 0, 0.0
    usage: dict[str, Any] = data["usage"] if isinstance(data.get("usage"), dict) else {}
    tin = sum(v for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
              if isinstance(v := usage.get(k), int))
    tout = usage.get("output_tokens")
    cost = data.get("total_cost_usd")
    return (data, tin, int(tout) if isinstance(tout, int) else 0,
            float(cost) if isinstance(cost, (int, float)) else 0.0)


def _inline_input(request: Path) -> tuple[str, str]:
    """(system prompt, stdin) for one inline call. The .md copy has real line breaks, so its User and Schema sections
    are sent when it exists; otherwise they are built from request.json."""
    data = load_json(request)
    if not isinstance(data, dict):
        raise InfraError(f"{request} is not a JSON object")
    system = f"{data.get('system', '')}\n\n{OUTPUT_RULE}"
    md = request.with_suffix(".md")
    text = md.read_text(errors="replace") if md.exists() else ""
    at = text.find("\n# User\n")
    if at >= 0:
        body = text[at + 1:]
    else:
        schema = data.get("schema")
        body = (f"# User\n\n{data.get('user', '')}\n\n# Schema\n\n```json\n"
                f"{json.dumps(schema, indent=1) if not isinstance(schema, str) else schema}\n```\n")
    return system, f"{body.rstrip()}\n\n{OUTPUT_RULE}\n"


def parse_answer(data: dict[str, Any] | None) -> Any:
    """The JSON object in an inline answer: the CLI's structured_output when present, else its `result` text, with
    any markdown fence or surrounding prose cut away. Raises TypeError or ValueError when there is no JSON object."""
    if not isinstance(data, dict):
        raise TypeError("the CLI did not print a JSON object")
    if isinstance(data.get("structured_output"), (dict, list)):
        return data["structured_output"]
    text = data.get("result")
    if not isinstance(text, str) or "{" not in text:
        raise ValueError("the answer holds no JSON object")
    return loads_lossy(text[text.index("{"):text.rindex("}") + 1])


@contextmanager
def slot(sleep: Callable[[float], None] = time.sleep) -> Iterator[None]:
    """Hold one of $HUNT_MAX_DISPATCH machine-wide model-call slots. Waits (not a retry) for at most TIMEOUT_S."""
    try:
        n = max(1, int(os.environ.get("HUNT_MAX_DISPATCH", DEFAULT_MAX_DISPATCH)))
    except ValueError:
        n = DEFAULT_MAX_DISPATCH
    d = scratch() / "dispatch-slots"
    d.mkdir(parents=True, exist_ok=True)
    waited = 0.0
    while True:
        for i in range(n):
            fh = (d / f"slot{i}").open("w")
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fh.close()
                continue
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
                fh.close()
            return
        if waited >= TIMEOUT_S:
            raise DispatchError(f"no free dispatch slot after {TIMEOUT_S}s (HUNT_MAX_DISPATCH={n})")
        pause = 0.5 + random.random()  # jitter, so waiting calls do not wake together
        sleep(pause)
        waited += pause


def _write_atomic(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    write_json(tmp, data)
    os.replace(tmp, path)


def dispatch(request: Path, *, cmd: str | None = None, hdir: Path | None = None, tag: str | None = None,
             sleep: Callable[[float], None] = time.sleep) -> DispatchResult:
    """Answer one request file. Raises DispatchError when the model call fails for good."""
    request = request.resolve()
    hdir = hdir or request.parent.parent
    tag = tag or request.parent.name
    if is_answered(request):
        return DispatchResult(status="skipped")
    cmd = cmd if cmd is not None else os.environ.get("HUNT_DISPATCH_CMD", "").strip() or None
    resp = response_path(request)
    resp.unlink(missing_ok=True)  # a command that writes nothing must fail, not pass the previous answer
    inline = not cmd
    if cmd:
        argv, stdin = [*shlex.split(cmd), str(request)], None
    else:
        system, stdin = _inline_input(request)
        sysfile = request.with_name(request.stem + ".system.txt")
        sysfile.write_text(system)
        argv = [*shlex.split(DEFAULT_CMD), "--system-prompt-file", str(sysfile)]
    result = DispatchResult(status="ok")
    delay = BASE_DELAY_S
    t0 = time.monotonic()
    try:
        for attempt in range(1, MAX_TRIES + 1):
            try:
                with slot(sleep):
                    p = subprocess.run(argv, input=stdin, cwd=request.parent, capture_output=True, text=True,
                                       errors="replace", timeout=TIMEOUT_S, check=False)
            except FileNotFoundError as e:
                raise InfraError(f"dispatch command not found: {argv[0]}") from e
            except subprocess.TimeoutExpired as e:
                raise DispatchError(f"dispatch timed out after {TIMEOUT_S}s for {request}") from e
            data, tin, tout, cost = _usage(p.stdout)
            result.tokens_in += tin
            result.tokens_out += tout
            result.cost_usd += cost
            failed = p.returncode != 0 or bool(data and data.get("is_error"))
            text = p.stdout + p.stderr
            if failed:
                if TRANSIENT.search(text) and attempt < MAX_TRIES:
                    result.retries += 1
                    sleep(delay)
                    delay = min(delay * 2, MAX_DELAY_S)
                    continue
                raise DispatchError(f"dispatch failed for {request} (exit {p.returncode}, attempt {attempt}): "
                                    f"{text[-800:]}")
            if inline:
                try:
                    answer = parse_answer(data)
                except (TypeError, ValueError) as e:
                    raise DispatchError(f"inline answer for {request} is not JSON: {e}: {p.stdout[-400:]}") from e
                _write_atomic(resp, answer)
            if not resp.exists():
                raise DispatchError(f"dispatch exited 0 but wrote no response for {request}")
            break
        try:
            parsed = load_json(resp)
        except ValueError as e:
            raise DispatchError(f"response for {request} is not JSON: {e}") from e
        _write_atomic(resp, parsed)  # re-written atomically: a reader never sees a half-written response
        sidecar(request).write_text(request_sha(request))
        result.secs = round(time.monotonic() - t0, 6)
        return result
    except Exception as e:  # recorded under its class name, then re-raised
        result.status = type(e).__name__
        raise
    finally:
        if result.status != "skipped":
            telemetry.record(hdir, "dispatch", tag=tag, exit=result.status, retries=result.retries,
                             tokens_in=result.tokens_in, tokens_out=result.tokens_out, cost_usd=result.cost_usd,
                             secs=round(time.monotonic() - t0, 6))


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--tag"):
        print(__doc__)
        return 1
    try:
        res = dispatch(Path(argv[1]), tag=argv[3] if len(argv) == 4 else None)
    except DispatchError as e:
        print(f"DISPATCH_FAILED {e}")
        return 2
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    print(f"{res.status}: retries={res.retries} tokens_in={res.tokens_in} tokens_out={res.tokens_out} "
          f"cost_usd={res.cost_usd:.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
