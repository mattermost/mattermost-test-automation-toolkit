# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Tests for unified telemetry across telemetry.py, eval_bugs.py, and ledger.py."""
from __future__ import annotations

import concurrent.futures
import json
import math
import sys
from pathlib import Path

import eval_bugs
import hunt_common
import ledger
import pytest
import telemetry
import trusted

from tests.test_hunt_engine import _eval_manifest


def test_normalize_row_and_numeric_validation():
    assert telemetry.valid_nonneg_num(None) is None
    assert telemetry.valid_nonneg_num("1") is None
    assert telemetry.valid_nonneg_num(True) is None
    assert telemetry.valid_nonneg_num(False) is None
    assert telemetry.valid_nonneg_num(-0.01) is None
    assert telemetry.valid_nonneg_num(float("nan")) is None
    assert telemetry.valid_nonneg_num(float("inf")) is None
    assert telemetry.valid_nonneg_num(10**400) is None
    assert telemetry.valid_nonneg_num(1.5) == 1.5

    assert telemetry.valid_nonneg_int(True) is None
    assert telemetry.valid_nonneg_int(-1) is None
    assert telemetry.valid_nonneg_int(1.5) is None
    assert telemetry.valid_nonneg_int(100.0) == 100
    assert telemetry.valid_nonneg_int(10**25) == 10**25

    cleaned = telemetry.normalize_row({
        "stage": "dispatch",
        "tag": "A",
        "tokens_in": True,
        "cache_write": 1.5,
        "cache_read": -2,
        "tokens_out": 25.0,
        "cost_usd": float("inf"),
        "secs": 1.25,
        "extra_nan": float("nan"),
    })
    assert "tokens_in" not in cleaned
    assert "cache_write" not in cleaned
    assert "cache_read" not in cleaned
    assert cleaned["tokens_out"] == 25
    assert cleaned["cost_usd"] is None
    assert cleaned["secs"] == 1.25
    assert cleaned["extra_nan"] is None


def test_flocked_concurrent_append_and_tag_filtering(tmp_path: Path):
    def write_row(i: int) -> None:
        tag = "A" if i % 2 == 0 else "B"
        telemetry.record(tmp_path, "dispatch", tag=tag, tokens_in=100, tokens_out=10, cost_usd=0.01, secs=0.5)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write_row, range(40)))

    # Inject malformed lines/fields that must be ignored cleanly on summarize()
    with (tmp_path / telemetry.LEDGER).open("a", encoding="utf-8") as fh:
        fh.write("{not-json\n")
        fh.write(json.dumps({"stage": "dispatch", "tag": "A", "tokens_in": True, "cost_usd": math.inf}) + "\n")
        fh.write(json.dumps({"stage": "dispatch", "tag": "A", "tokens_in": 1.5, "cost_usd": -3}) + "\n")

    all_sum = telemetry.summarize(tmp_path)
    assert all_sum["calls"] == 42
    assert all_sum["tokens_in"] == 4000
    assert all_sum["tokens_out"] == 400
    assert all_sum["total_cost_usd"] == 0.4
    assert all_sum["total_secs"] == 20.0
    assert all_sum["by_tag"]["A"]["tokens_in"] == 2000
    assert all_sum["by_tag"]["B"]["calls"] == 20

    only_b = telemetry.summarize(tmp_path, tag="B")
    assert only_b["calls"] == 20
    assert only_b["tokens_in"] == 2000
    assert list(only_b["by_tag"]) == ["B"]


def test_eval_bugs_dispatch_sets_hunt_telemetry_and_preserves_usage_on_error(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    path, _ = _eval_manifest(tmp_path, raw_recall_min=1.0, vetted_recall_min=1.0, fp_rate_max=0.0)
    m = json.loads(path.read_text())
    m["cases"][0].pop("responses")
    m["controls"] = []
    path.write_text(json.dumps(m))

    disp = tmp_path / "disp_telem.py"
    disp.write_text(
        "import json, os, pathlib, sys\n"
        f"sys.path.insert(0, {json.dumps(str(Path(telemetry.__file__).parent))})\n"
        "import telemetry\n"
        "req_p = pathlib.Path(sys.argv[1])\n"
        "req = json.loads(req_p.read_text())\n"
        "tpath = pathlib.Path(os.environ['HUNT_TELEMETRY'])\n"
        "if req_p.parent.name == 'A':\n"
        "    pathlib.Path(req['response_path']).write_text(json.dumps({'files': []}))\n"
        "    telemetry.record(tpath.parent, 'dispatch', tag='A', tokens_in=111, tokens_out=20, cost_usd=0.04, secs=1.2)\n"
        "else:\n"
        "    telemetry.record(tpath.parent, 'dispatch', tag='B', tokens_in=222, tokens_out=30, cost_usd=0.06, secs=1.8)\n"
        "    sys.exit(1)\n"
    )
    out_dir = tmp_path / "out_midfail"
    code = eval_bugs.main([
        "eval_bugs.py", str(path), "--out", str(out_dir),
        "--signals", "hunters", "--dispatch", f"{sys.executable} {disp}",
    ])
    _ = capsys.readouterr()
    assert code == 2
    card = json.loads((out_dir / "scorecard.json").read_text())
    assert card["verdict"] == "ERROR"
    assert card["usage"]["calls"] == 2
    assert card["usage"]["tokens_in"] == 333
    assert card["usage"]["tokens_out"] == 50
    assert card["usage"]["total_cost_usd"] == 0.1
    assert card["usage"]["total_secs"] == 3.0


def test_eval_bugs_scorecard_render_and_diff_scorecards_usage(tmp_path: Path, capsys):
    hdir = tmp_path / "hunt1"
    (hdir / "A").mkdir(parents=True)
    (hdir / "D").mkdir(parents=True)
    telemetry.record(hdir, "dispatch", tag="A", tokens_in=120, tokens_out=30, cost_usd=0.02, secs=1.0)
    telemetry.record(hdir, "dispatch", tag="D", tokens_in=80, tokens_out=20, cost_usd=0.01, secs=0.5)

    row_a = eval_bugs._attach_tag_telemetry({"batch": 1, "hunter": "A"}, hdir, "A")
    row_d = eval_bugs._attach_tag_telemetry({"batch": 1, "hunter": "D", "repaired": True}, hdir, "D")
    assert set(row_a["usage"]["by_tag"]) == {"A"}
    assert set(row_d["usage"]["by_tag"]) == {"D"}

    manifest = {
        "cases": [{"id": "c1", "area": "calc"}, {"id": "c_err", "area": "calc"}],
        "controls": [],
        "thresholds": {"raw_recall_min": 0.0, "vetted_recall_min": 0.0, "fp_rate_max": 1.0},
    }
    card = eval_bugs.scorecard(manifest, {"c1": {"results": [row_a, row_d]}, "c_err": {"error": "InfraError: boom"}})
    assert card["usage"]["calls"] == 2
    assert card["usage"]["repairs"] == 1
    assert card["usage"]["tokens_in"] == 200
    assert card["usage"]["total_cost_usd"] == 0.03
    assert "usage: calls=2 repairs=1 retries=0 tokens_in=200 tokens_out=50 cost=$0.0300 duration=1.5s" in eval_bugs.render(card)

    # Legacy scorecards without usage compare cleanly and leave usage_delta as None (unknown, not zero)
    old_base = {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0}, "rows": [{"kind": "case", "id": "c1", "vetted": True}]}
    old_cand = {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0}, "rows": [{"kind": "case", "id": "c1", "vetted": True}]}
    compat = eval_bugs.diff_scorecards(old_base, old_cand)
    assert compat["verdict"] == "PASS" and compat["usage_delta"] is None

    # Valid usage on both computes usage_delta
    base_u = {**old_base, "usage": {"calls": 2, "tokens_in": 1000, "tokens_out": 200, "total_cost_usd": 0.20, "total_secs": 4.0, "repairs": 0, "retries": 0}}
    cand_u = {**old_cand, "usage": {"calls": 3, "tokens_in": 1500, "tokens_out": 250, "total_cost_usd": 0.25, "total_secs": 5.0, "repairs": 1, "retries": 0}}
    bp, cp = tmp_path / "base.json", tmp_path / "cand.json"
    bp.write_text(json.dumps(base_u))
    cp.write_text(json.dumps(cand_u))
    assert eval_bugs.main(["eval_bugs.py", "diff", str(bp), str(cp)]) == 0
    out = capsys.readouterr().out
    assert "usage: cost $0.2000 -> $0.2500 (+25.00%), tokens_in 1000 -> 1500, repairs 0 -> 1" in out

    # Malformed usage values raise ValueError or TypeError
    for bad_usage in ({"total_cost_usd": True}, {"total_cost_usd": -0.1}, {"tokens_in": 1.5}, {"repairs": float("nan")}, "bad"):
        with pytest.raises((ValueError, TypeError)):
            eval_bugs.diff_scorecards(old_base, {**old_cand, "usage": bad_usage})


def test_ledger_record_collects_unified_telemetry_and_runtimes(tmp_path: Path):
    hdir = tmp_path / "hunt42"
    hdir.mkdir()
    (hdir / "state.json").write_text(json.dumps({
        "pr": "42", "head": "abc123", "merge_base": "def456", "batches": 2, "all_batches": True,
    }))
    b1 = hdir / "batches" / "batch_1"
    (b1 / "A").mkdir(parents=True)
    (b1 / "A" / "request.repair.json").write_text("{}")
    (b1 / "run_A.runtimes.json").write_text(json.dumps({"pkg1": 1.25, "pkg2": 0.75}))
    (b1 / "run_D.runtimes.json").write_bytes(b"\xff\xfe")

    (hdir / "B").mkdir()
    (hdir / "B" / "request.retry.json").write_text("{}")
    (hdir / "run_B.runtimes.json").write_text(json.dumps({"pkg3": 3.001}))

    telemetry.record(hdir, "dispatch", tag="A", tokens_in=100, tokens_out=20, cost_usd=0.01, secs=1.0)
    telemetry.record(hdir, "dispatch", tag="B", tokens_in=250, tokens_out=50, cost_usd=0.025, secs=2.5)

    out_ledger = tmp_path / "ledger.jsonl"
    row = ledger.record("42", hdir=hdir, out_path=out_ledger)
    assert row["test_runtime_s"] == 5.001
    assert row["usage"]["calls"] == 2
    assert row["usage"]["tokens_in"] == 350
    assert row["usage"]["tokens_out"] == 70
    assert row["usage"]["total_cost_usd"] == 0.035
    assert row["usage"]["total_secs"] == 3.5
    assert row["usage"]["repairs"] == 1
    assert row["usage"]["retries"] == 1
    assert set(row["usage"]["by_tag"]) == {"A", "B"}
    assert hunt_common is not None


def test_telemetry_path_isolation_nested_nan_and_finite_accumulation(tmp_path: Path, monkeypatch):
    explicit_dir = tmp_path / "explicit"
    env_file = tmp_path / "env_override" / "telemetry.jsonl"
    monkeypatch.setenv("HUNT_TELEMETRY", str(env_file))

    telemetry.record(
        explicit_dir, "dispatch", tag="A", cost_usd=1.5,
        nested={"bad": float("nan"), "arr": [float("inf")], "tup": (0.2, float("nan"))},
    )
    raw_line = json.loads((explicit_dir / telemetry.LEDGER).read_text().splitlines()[0])
    assert raw_line["nested"] == {"bad": None, "arr": [None], "tup": [0.2, None]}
    assert not env_file.exists()
    assert telemetry.summarize(explicit_dir)["total_cost_usd"] == 1.5
    assert telemetry.telemetry_path(None) == env_file.resolve()

    ov_dir = tmp_path / "overflow"
    telemetry.record(ov_dir, "dispatch", tag="A", secs=1e308, cost_usd=1e308)
    telemetry.record(ov_dir, "dispatch", tag="A", secs=1e308, cost_usd=1e308)
    s = telemetry.summarize(ov_dir)
    assert math.isfinite(s["total_secs"]) and math.isfinite(s["total_cost_usd"])
    merged = telemetry.merge_summaries([s, s])
    assert math.isfinite(merged["total_secs"]) and math.isfinite(merged["total_cost_usd"])
