"""Wave 0: eval zero-FP gate (A6 part 1) and telemetry ledger (C1)."""
from __future__ import annotations

import json
from typing import Any

import eval_bugs
import pytest
import telemetry


def _card(fp: float) -> dict[str, Any]:
    return {"metrics": {"vetted_recall": 0.5, "fp_rate": fp}, "rows": [{"kind": "case", "id": "c1"}], "errors": []}


def test_fp_gate_default_is_zero_and_has_no_baseline_tolerance():
    assert eval_bugs.diff_scorecards(_card(0.0), _card(0.0))["verdict"] == "PASS"
    res = eval_bugs.diff_scorecards(_card(0.0), _card(0.04))
    assert res["verdict"] == "FAIL" and res["fp_limit"] == 0.0 and not res["fp_ok"]
    # a baseline that already had FPs no longer widens the limit
    assert eval_bugs.diff_scorecards(_card(0.1), _card(0.1))["verdict"] == "FAIL"
    # explicit override still works
    assert eval_bugs.diff_scorecards(_card(0.0), _card(0.04), max_fp=0.05)["verdict"] == "PASS"


def test_default_thresholds_fp_zero():
    assert eval_bugs.DEFAULT_THRESHOLDS["fp_rate_max"] == 0.0


def test_stage_writes_one_line(tmp_path):
    with telemetry.stage(tmp_path, "hunt", model="m", tokens_in=10, tokens_out=5, cost_usd=0.5) as f:
        f["retries"] = 2
    lines = (tmp_path / "telemetry.jsonl").read_text().splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["stage"] == "hunt" and row["exit"] == "ok" and row["retries"] == 2 and row["model"] == "m"
    assert row["secs"] >= 0 and row["end"] >= row["start"]


def test_stage_records_exception_class_and_reraises(tmp_path):
    with pytest.raises(ValueError), telemetry.stage(tmp_path, "vet"):
        raise ValueError("boom")
    assert json.loads((tmp_path / "telemetry.jsonl").read_text())["exit"] == "ValueError"


def test_record_and_summarize(tmp_path):
    assert telemetry.summarize(tmp_path)["total_secs"] == 0.0
    telemetry.record(tmp_path, "a", secs=2.0, cost_usd=1.0, tokens_in=100, cache_write=70, cache_read=20, tokens_out=10)
    telemetry.record(tmp_path, "a", secs=1.0, cost_usd=0.5, tokens_in=50, tokens_out=5, exit="TimeoutError")
    telemetry.record(tmp_path, "b", secs=4.0)
    with (tmp_path / "telemetry.jsonl").open("a") as fh:
        fh.write("not json\n")
    s = telemetry.summarize(tmp_path)
    assert s["total_secs"] == 7.0 and s["total_cost_usd"] == 1.5
    assert (s["tokens_in"], s["cache_write"], s["cache_read"], s["tokens_out"]) == (150, 70, 20, 15)
    assert (s["by_stage"]["a"]["cache_write"], s["by_stage"]["a"]["cache_read"]) == (70, 20)
    assert s["by_stage"]["a"]["count"] == 2 and s["by_stage"]["a"]["failures"] == 1
    assert s["by_stage"]["b"]["secs"] == 4.0
