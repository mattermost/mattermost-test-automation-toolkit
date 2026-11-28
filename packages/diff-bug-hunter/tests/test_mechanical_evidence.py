# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Mechanical evidence the model cannot overrule: race-detector reports, and eval runs that never hunted."""
from __future__ import annotations

import json
from pathlib import Path

import eval_bugs
import hunt
import ledger
import report
import trusted

from tests.test_hunt_engine import _eval_manifest

RACE_TEXT = "    testing.go:1617: race detected during execution of test"
TID = "server/channels/app::TestHuntA_Counter"


def _tier(hdir: Path) -> tuple[str, list[str]]:
    counts = {"pass": 1, "fail_3_of_3": 0, "new_pr_bug": 0, "new_api": 0, "pre_existing": 0, "diff": 0,
              "mode_a_empty": 0}
    return ledger._tier_and_gaps(hdir, counts, 0, 0, 0, 1, 1, False, {})


def test_a_race_report_on_head_blocks_clean_and_is_named(tmp_path):
    assert _tier(tmp_path) == ("High-Confidence Clean", [])
    (tmp_path / "run_A.messages.json").write_text(json.dumps({TID: RACE_TEXT}))
    tier, gaps = _tier(tmp_path)
    assert tier == "Partial or Unverified Coverage"
    assert gaps == [f"race detector fired on head in {TID} (Mode A)"]


def test_a_race_the_merge_base_also_reports_is_not_this_prs(tmp_path):
    (tmp_path / "run_A.messages.json").write_text(json.dumps({TID: RACE_TEXT}))
    (tmp_path / "base_A.json").write_text(json.dumps({TID: "PRE_EXISTING"}))
    assert _tier(tmp_path) == ("High-Confidence Clean", [])


def test_a_failure_without_a_race_report_adds_no_race_gap(tmp_path):
    (tmp_path / "run_A.messages.json").write_text(json.dumps({TID: "    a_test.go:9: got 3, want 2"}))
    assert _tier(tmp_path) == ("High-Confidence Clean", [])


def _card(errors: list[str], verdict: str) -> dict:
    return {"metrics": {"vetted_recall": 0.0, "fp_rate": 0.0}, "rows": [{"kind": "case", "id": "c1"}],
            "errors": errors, "verdict": verdict}


def test_the_gate_fails_on_a_baseline_scorecard_that_errored():
    good = _card([], "PASS")
    ok = eval_bugs.diff_scorecards(good, good)
    assert ok["verdict"] == "PASS" and ok["base_ok"] is True
    for bad in (_card(["c1"], "PASS"), _card([], "ERROR")):
        res = eval_bugs.diff_scorecards(bad, good)
        assert res["verdict"] == "FAIL" and res["base_ok"] is False


def test_an_entry_no_hunter_answered_is_an_error_not_a_miss(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    path, _ = _eval_manifest(tmp_path)
    m = json.loads(path.read_text())
    for e in m["cases"] + m["controls"]:
        e.pop("responses")
    path.write_text(json.dumps(m))
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--signals", "hunters"])
    assert code == 2 and "VERDICT: ERROR" in capsys.readouterr().out
    card = json.loads((tmp_path / "out" / "scorecard.json").read_text())
    assert sorted(card["errors"]) == ["clamp", "percent"]
    assert all("no hunter response" in r["error"] for r in card["rows"])


def _keep(source: str, rid: str) -> dict:
    return {"id": rid, "source": source, "decision": "KEEP", "reason": "real", "file_line": "x.go:1", "caller": "api4",
            "entry_point": "api4 GET /x", "repro_cmd": f"go test ./x -run {rid}", "evidence_path": "run_A.json",
            "severity": "major", "fix_check": None}


def _record(tmp_path: Path, run: dict, base: dict, keep: list[dict], diff: dict | None = None,
            coverage: bool = True) -> dict:
    h = tmp_path / "h"
    h.mkdir(parents=True)
    (h / "state.json").write_text(json.dumps({"pr": "1", "head": "h", "merge_base": "b", "batches": 1}))
    (h / "run_A.json").write_text(json.dumps(run))
    (h / "run_B.json").write_text(json.dumps({}))
    (h / "base_A.json").write_text(json.dumps(base))
    (h / "diff_D.json").write_text(json.dumps(diff if diff is not None else {"p::D": "SAME"}))
    if coverage:
        (h / "run_A.coverage.json").write_text('{"reached": 1, "executable": 1}')
    (h / "vetted.json").write_text(json.dumps({"rows": keep}))
    return ledger.record("1", hdir=h, out_path=h.parent / "l.jsonl")


def test_a_kept_behaviour_change_is_not_bug_proven(tmp_path):
    row = _record(tmp_path, {"p::T": "FAIL_3_OF_3"}, {"p::T": "NEW_API"}, [_keep("A", "p::T")])
    assert row["confidence_tier"] == "Behaviour change, needs review"


def test_a_kept_mode_d_diff_is_not_bug_proven(tmp_path):
    row = _record(tmp_path, {}, {}, [_keep("D", "p::D")], diff={"p::D": "DIFF"})
    assert row["confidence_tier"] == "Behaviour change, needs review"


def test_a_kept_new_pr_bug_is_bug_proven_even_beside_a_behaviour_change(tmp_path):
    row = _record(tmp_path, {"p::T": "FAIL_3_OF_3", "p::U": "FAIL_3_OF_3"}, {"p::T": "NEW_PR_BUG", "p::U": "NEW_API"},
                  [_keep("A", "p::T"), _keep("A", "p::U")])
    assert row["confidence_tier"] == "Bug Proven" and row["gaps"] == []


def test_a_mode_a_run_without_changed_line_coverage_blocks_clean(tmp_path):
    row = _record(tmp_path, {"p::T": "PASS"}, {"p::T": "PRE_EXISTING"}, [], coverage=False)
    assert row["confidence_tier"] == "Partial or Unverified Coverage"
    row = _record(tmp_path / "again", {"p::T": "PASS"}, {"p::T": "PRE_EXISTING"}, [], coverage=True)
    assert row["confidence_tier"] == "High-Confidence Clean"


def test_the_driver_measures_changed_lines_unless_a_bug_is_kept(tmp_path):
    h = tmp_path / "h"
    h.mkdir()
    assert hunt.cover_done(h, ("A",)) is True  # no Mode A run: nothing to measure
    (h / "run_A.json").write_text(json.dumps({"p::T": "PASS"}))
    assert hunt.cover_done(h, ("A",)) is False
    (h / "run_A.coverage.json").write_text('{"reached": 0, "executable": 0}')
    assert hunt.cover_done(h, ("A",)) is True
    (h / "run_A.coverage.json").unlink()
    (h / "base_A.json").write_text(json.dumps({"p::T": "NEW_PR_BUG"}))
    (h / "run_A.json").write_text(json.dumps({"p::T": "FAIL_3_OF_3"}))
    (h / "vetted.json").write_text(json.dumps({"rows": [_keep("A", "p::T")]}))
    assert hunt.cover_done(h, ("A",)) is True  # a kept NEW_PR_BUG is Bug Proven: the coverage run is skipped


DISMISSED = "1 mechanical failure(s) dismissed by the skeptic"


def _drop(source: str, rid: str) -> dict:
    return {**_keep(source, rid), "decision": "DROP"}


def test_a_model_drop_of_a_mechanical_failure_is_partial_not_clean(tmp_path):
    row = _record(tmp_path, {"p::T": "FAIL_3_OF_3"}, {"p::T": "NEW_PR_BUG"}, [_drop("A", "p::T")])
    assert row["confidence_tier"] == "Partial or Unverified Coverage" and row["gaps"] == [DISMISSED]


def test_a_model_drop_of_a_mode_d_diff_is_partial_not_clean(tmp_path):
    row = _record(tmp_path, {}, {}, [_drop("D", "p::D")], diff={"p::D": "DIFF"})
    assert row["confidence_tier"] == "Partial or Unverified Coverage" and row["gaps"] == [DISMISSED]


def test_a_drop_of_a_non_mechanical_row_stays_clean(tmp_path):
    row = _record(tmp_path, {"p::T": "PASS"}, {"p::T": "PRE_EXISTING"}, [_drop("A", "p::T")])
    assert row["confidence_tier"] == "High-Confidence Clean" and row["gaps"] == []


def test_a_drop_in_an_archived_batch_is_counted_against_that_batch(tmp_path):
    h = tmp_path / "h"
    h.mkdir()
    (h / "state.json").write_text(json.dumps({"pr": "1", "head": "h", "merge_base": "b", "batches": 2}))
    (h / "run_A.json").write_text(json.dumps({"p::T": "PASS"}))
    (h / "run_B.json").write_text(json.dumps({}))
    (h / "diff_D.json").write_text(json.dumps({"p::D": "SAME"}))
    (h / "run_A.coverage.json").write_text('{"reached": 1, "executable": 1}')
    (h / "base_A.json").write_text(json.dumps({"p::T": "PRE_EXISTING"}))
    b1 = h / "batches" / "batch_1"
    b1.mkdir(parents=True)
    (b1 / "state.json").write_text(json.dumps({"changed": ["a.go"]}))
    (b1 / "base_A.json").write_text(json.dumps({"p::U": "NEW_PR_BUG"}))
    (b1 / "verdict.json").write_text(json.dumps({"vetted_present": True, "keep": [],
                                                  "held": [{"row": _drop("A", "p::U"), "reasons": ["decision=DROP"]}]}))
    row = ledger.record("1", hdir=h, out_path=tmp_path / "l.jsonl")
    assert row["confidence_tier"] == "Partial or Unverified Coverage" and DISMISSED in row["gaps"]
    tier, gaps, _, _ = report._tier(h, {"batches": 2}, [], [])
    assert tier == "Partial or Unverified Coverage" and DISMISSED in gaps


def test_a_drop_is_not_cleared_by_a_newer_batch_that_says_pre_existing(tmp_path):
    h = tmp_path / "h"
    h.mkdir()
    (h / "state.json").write_text(json.dumps({"pr": "1", "head": "h", "merge_base": "b", "batches": 2}))
    (h / "run_A.json").write_text(json.dumps({"p::T": "PASS"}))
    (h / "run_B.json").write_text(json.dumps({}))
    (h / "diff_D.json").write_text(json.dumps({"p::D": "SAME"}))
    (h / "run_A.coverage.json").write_text('{"reached": 1, "executable": 1}')
    (h / "base_A.json").write_text(json.dumps({"p::T": "PRE_EXISTING"}))
    b1 = h / "batches" / "batch_1"
    b1.mkdir(parents=True)
    (b1 / "state.json").write_text(json.dumps({"changed": ["a.go"]}))
    (b1 / "base_A.json").write_text(json.dumps({"p::T": "NEW_PR_BUG"}))
    (b1 / "verdict.json").write_text(json.dumps({"vetted_present": True, "keep": [],
                                                  "held": [{"row": _drop("A", "p::T"), "reasons": ["decision=DROP"]}]}))
    row = ledger.record("1", hdir=h, out_path=tmp_path / "l.jsonl")
    assert row["confidence_tier"] == "Partial or Unverified Coverage" and DISMISSED in row["gaps"]
