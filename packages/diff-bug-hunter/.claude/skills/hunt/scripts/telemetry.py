"""Per-stage telemetry ledger: one JSON line per stage in <hdir>/telemetry.jsonl.

Line: {stage, start, end, secs, exit ("ok" | exception class name), ...fields}
Fields are free-form (model, tokens_in, cache_write, cache_read, tokens_out, cost_usd, retries, image_pull_s,
effort_tier, schema_version). Each line is appended with a single write.
"""
from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

LEDGER = "telemetry.jsonl"
TOKEN_KEYS = ("tokens_in", "cache_write", "cache_read", "tokens_out")  # tokens_in includes both cache parts


def _append(hdir: str | Path, row: dict[str, Any]) -> None:
    path = Path(hdir)
    path.mkdir(parents=True, exist_ok=True)
    clean = {k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in row.items()}
    line = json.dumps(clean, sort_keys=True, default=str, allow_nan=False) + "\n"
    with open(path / LEDGER, "a", encoding="utf-8") as fh:
        fh.write(line)


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


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def summarize(hdir: str | Path) -> dict[str, Any]:
    """Totals plus per-stage totals. Missing ledger gives zeros; malformed lines are skipped."""
    out: dict[str, Any] = {"total_secs": 0.0, "total_cost_usd": 0.0, **dict.fromkeys(TOKEN_KEYS, 0), "by_stage": {}}
    path = Path(hdir) / LEDGER
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict) or "stage" not in row:
            continue
        secs, cost = _num(row.get("secs")), _num(row.get("cost_usd"))
        b = out["by_stage"].setdefault(
            str(row["stage"]), {"count": 0, "secs": 0.0, "cost_usd": 0.0, **dict.fromkeys(TOKEN_KEYS, 0), "failures": 0})
        b["count"] += 1
        b["secs"] += secs
        b["cost_usd"] += cost
        for k in TOKEN_KEYS:
            n = int(_num(row.get(k)))
            b[k] += n
            out[k] += n
        b["failures"] += row.get("exit", "ok") != "ok"
        out["total_secs"] += secs
        out["total_cost_usd"] += cost
    return out
