"""Per-stage telemetry ledger: one JSON line per stage in <hdir>/telemetry.jsonl.

Line: {stage, start, end, secs, exit ("ok" | exception class name), ...fields}
Fields are free-form (model, tokens_in, cache_write, cache_read, tokens_out, cost_usd, retries, image_pull_s,
effort_tier, schema_version). Each line is appended with a single write.
"""
from __future__ import annotations

import fcntl
import json
import math
import os
import sys
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

LEDGER = "telemetry.jsonl"
TOKEN_KEYS = ("tokens_in", "cache_write", "cache_read", "tokens_out")  # tokens_in includes both cache parts
_INT_FIELDS = (*TOKEN_KEYS, "retries")
_FLOAT_FIELDS = ("cost_usd", "secs")


def valid_nonneg_num(v: Any) -> float | None:
    """Finite non-negative number (rejects booleans, NaN/Inf, negatives, and huge overflowing ints)."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        try:
            f = float(v)
        except OverflowError:
            return None
        if math.isfinite(f) and f >= 0:
            return f
    return None


def valid_nonneg_int(v: Any) -> int | None:
    """Exact non-negative integer (or integer-valued finite float); rejects booleans and fractional floats."""
    if isinstance(v, int) and not isinstance(v, bool):
        return v if v >= 0 else None
    num = valid_nonneg_num(v)
    if num is not None and num.is_integer():
        return int(num)
    return None


def _sanitize_value(v: Any) -> Any:
    """Recursively replace non-finite floats with None so allow_nan=False never fails on nested structures."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _sanitize_value(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_sanitize_value(item) for item in v]
    return v


def _add_finite(acc: float, val: float) -> float:
    """Add val to acc only if the sum remains finite."""
    total = acc + val
    return total if math.isfinite(total) else acc


def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Sanitize numeric telemetry fields on write so malformed tokens/costs/durations cannot poison telemetry.jsonl."""
    clean: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, float) and not math.isfinite(v):
            clean[k] = None
        elif k in _INT_FIELDS:
            iv = valid_nonneg_int(v)
            if iv is not None:
                clean[k] = iv
        elif k in _FLOAT_FIELDS:
            fv = valid_nonneg_num(v)
            if fv is not None:
                clean[k] = fv
        else:
            clean[k] = _sanitize_value(v)
    return clean


def telemetry_path(hdir: str | Path | None = None) -> Path:
    """Resolve telemetry.jsonl path: explicit hdir wins; falls back to HUNT_TELEMETRY when hdir is None."""
    if hdir is not None:
        p = Path(hdir)
        return p if p.suffix == ".jsonl" else p / LEDGER
    env = os.environ.get("HUNT_TELEMETRY", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    raise ValueError("telemetry_path requires hdir or HUNT_TELEMETRY")


def _append(hdir: str | Path | None, row: dict[str, Any]) -> None:
    path = telemetry_path(hdir)
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = normalize_row(row)
    line = json.dumps(clean, sort_keys=True, default=str, allow_nan=False) + "\n"
    with path.open("a", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.write(line)
            fh.flush()
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def record(hdir: str | Path, stage: str, **fields: Any) -> dict[str, Any]:
    """Append a row for a stage measured elsewhere. start/end/secs/exit may be passed in fields."""
    now = time.time()
    row: dict[str, Any] = {"stage": stage, "start": now, "end": now, "secs": 0.0, "exit": "ok"}
    row.update(fields)
    _append(hdir, row)
    return row


@contextmanager
def stage(hdir: str | Path, name: str, **fields: Any) -> Iterator[dict[str, Any]]:
    """Time a stage and append its row on exit (also when it raises; the exception propagates).

    Yields a dict: set keys on it inside the block (tokens_in, cost_usd, ...) to add them to the row.
    """
    extra: dict[str, Any] = dict(fields)
    start, t0 = time.time(), time.monotonic()
    exit_status = "ok"
    in_exc = False
    try:
        yield extra
    except BaseException as err:
        in_exc = True
        exit_status = type(err).__name__
        raise
    finally:
        secs = round(time.monotonic() - t0, 6)
        row: dict[str, Any] = {"stage": name, "start": start, "end": start + secs, "secs": secs, "exit": exit_status}
        row.update(extra)
        try:
            _append(hdir, row)
        except OSError as log_err:
            if not in_exc:
                raise
            print(f"[telemetry] failed to record {name} ({exit_status}): {log_err}", file=sys.stderr)


def _empty_tag_bucket() -> dict[str, Any]:
    return {"calls": 0, "secs": 0.0, "cost_usd": 0.0, **dict.fromkeys(TOKEN_KEYS, 0)}


def summarize(hdir: str | Path | None = None, *, tag: str | None = None) -> dict[str, Any]:
    """Totals plus per-stage and per-tag totals. Missing ledger gives zeros; malformed rows/fields are skipped."""
    out: dict[str, Any] = {
        "calls": 0,
        "total_secs": 0.0,
        "total_cost_usd": 0.0,
        **dict.fromkeys(TOKEN_KEYS, 0),
        "by_stage": {},
        "by_tag": {},
    }
    path = telemetry_path(hdir)
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict) or "stage" not in row:
            continue
        row_tag = row.get("tag")
        tag_str = row_tag.strip() if isinstance(row_tag, str) and row_tag.strip() else ""
        if tag is not None and tag_str != tag:
            continue
        secs = valid_nonneg_num(row.get("secs")) or 0.0
        cost = valid_nonneg_num(row.get("cost_usd")) or 0.0
        stage_name = str(row["stage"])
        is_dispatch = stage_name == "dispatch"
        b = out["by_stage"].setdefault(
            stage_name, {"count": 0, "secs": 0.0, "cost_usd": 0.0, **dict.fromkeys(TOKEN_KEYS, 0), "failures": 0})
        b["count"] += 1
        b["secs"] = _add_finite(b["secs"], secs)
        b["cost_usd"] = _add_finite(b["cost_usd"], cost)
        b["failures"] += row.get("exit", "ok") != "ok"
        tb = out["by_tag"].setdefault(tag_str, _empty_tag_bucket()) if tag_str else None
        if tb is not None:
            tb["calls"] += 1 if is_dispatch else 0
            tb["secs"] = _add_finite(tb["secs"], secs)
            tb["cost_usd"] = _add_finite(tb["cost_usd"], cost)
        for k in TOKEN_KEYS:
            n = valid_nonneg_int(row.get(k)) or 0
            b[k] += n
            out[k] += n
            if tb is not None:
                tb[k] += n
        if is_dispatch:
            out["calls"] += 1
        out["total_secs"] = _add_finite(out["total_secs"], secs)
        out["total_cost_usd"] = _add_finite(out["total_cost_usd"], cost)
    out["total_secs"] = round(float(out["total_secs"]), 6)
    out["total_cost_usd"] = round(float(out["total_cost_usd"]), 6)
    for b in (*out["by_stage"].values(), *out["by_tag"].values()):
        b["secs"] = round(float(b["secs"]), 6)
        b["cost_usd"] = round(float(b["cost_usd"]), 6)
    return out


def merge_summaries(summaries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Deterministically merge multiple telemetry.summarize() dicts into one usage summary."""
    out: dict[str, Any] = {
        "calls": 0,
        "total_secs": 0.0,
        "total_cost_usd": 0.0,
        **dict.fromkeys(TOKEN_KEYS, 0),
        "by_tag": {},
    }
    for s in summaries:
        if not isinstance(s, dict):
            continue
        out["calls"] += valid_nonneg_int(s.get("calls")) or 0
        out["total_secs"] = _add_finite(out["total_secs"], valid_nonneg_num(s.get("total_secs")) or 0.0)
        out["total_cost_usd"] = _add_finite(out["total_cost_usd"], valid_nonneg_num(s.get("total_cost_usd")) or 0.0)
        for k in TOKEN_KEYS:
            out[k] += valid_nonneg_int(s.get(k)) or 0
        raw_tags = s.get("by_tag")
        if isinstance(raw_tags, dict):
            for tag_name, tb in sorted(raw_tags.items()):
                if not isinstance(tb, dict) or not str(tag_name).strip():
                    continue
                dst = out["by_tag"].setdefault(str(tag_name), _empty_tag_bucket())
                dst["calls"] += valid_nonneg_int(tb.get("calls")) or 0
                dst["secs"] = _add_finite(dst["secs"], valid_nonneg_num(tb.get("secs")) or 0.0)
                dst["cost_usd"] = _add_finite(dst["cost_usd"], valid_nonneg_num(tb.get("cost_usd")) or 0.0)
                for k in TOKEN_KEYS:
                    dst[k] += valid_nonneg_int(tb.get(k)) or 0
    out["total_secs"] = round(float(out["total_secs"]), 6)
    out["total_cost_usd"] = round(float(out["total_cost_usd"]), 6)
    for dst in out["by_tag"].values():
        dst["secs"] = round(float(dst["secs"]), 6)
        dst["cost_usd"] = round(float(dst["cost_usd"]), 6)
    return out
