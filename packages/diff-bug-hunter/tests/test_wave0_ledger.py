"""Wave 0: ledger confidence tier requires vetting (A5); empty Mode D is a coverage gap (R5)."""
from __future__ import annotations

import json
from pathlib import Path

import ledger
from conftest import vetted_row

PARTIAL = "Partial or Unverified Coverage"


def _hunt(tmp_path: Path, name: str = "h") -> Path:
    h = tmp_path / name
    h.mkdir()
    (h / "state.json").write_text(json.dumps({"pr": "1", "head": "h", "merge_base": "b", "batches": 1}))
    (h / "run_A.json").write_text('{"p::T": "FAIL_3_OF_3"}')
    (h / "run_B.json").write_text('{"p::T": "PASS"}')
    (h / "base_A.json").write_text('{"p::T": "NEW_PR_BUG"}')
    (h / "diff_D.json").write_text('{"p::D": "SAME"}')
    (h / "run_A.coverage.json").write_text('{"reached": 3, "executable": 5}')
    return h


def _rec(h: Path, tmp_path: Path) -> dict:
    return ledger.record("1", hdir=h, out_path=tmp_path / "l.jsonl")


def test_raw_new_pr_bug_without_vetted_is_partial_with_gap(tmp_path):
    row = _rec(_hunt(tmp_path), tmp_path)
    assert row["confidence_tier"] == PARTIAL
    assert "unvetted findings" in row["gaps"]


def test_vetted_keep_is_bug_proven(tmp_path):
    # A1: a KEEP reaches the author only when its mechanical verdict is NEW_PR_BUG and it has an entry point and repro.
    h = _hunt(tmp_path)
    keep = vetted_row(id="p::T", reason="real", file_line="x.go:1", caller="api4", entry_point="api4 GET /x",
                      repro_cmd="go test ./x -run TestHuntA_T")
    (h / "vetted.json").write_text(json.dumps({"rows": [{"id": "x", "decision": "DROP"}, keep]}))
    row = _rec(h, tmp_path)
    assert row["confidence_tier"] == "Bug Proven" and row["gaps"] == []


def test_vetted_list_form_keep_is_bug_proven(tmp_path):
    h = _hunt(tmp_path)
    keep = vetted_row(id="p::T", reason="real", file_line="x.go:1", caller="api4", entry_point="api4 GET /x",
                      repro_cmd="go test ./x -run TestHuntA_T")
    (h / "vetted.json").write_text(json.dumps([keep]))
    assert _rec(h, tmp_path)["confidence_tier"] == "Bug Proven"


def test_vetted_all_drop_is_not_bug_proven(tmp_path):
    h = _hunt(tmp_path)
    (h / "vetted.json").write_text(json.dumps({"rows": [{"id": "x", "decision": "DROP"}]}))
    assert _rec(h, tmp_path)["confidence_tier"] != "Bug Proven"


def test_old_test_break_without_vetted_is_partial(tmp_path):
    h = _hunt(tmp_path)
    (h / "base_A.json").write_text("{}")
    (h / "run_A.json").write_text('{"p::T": "PASS"}')
    (h / "old_tests.json").write_text(json.dumps({"tests": {"t": "OLD_TEST_BREAKS"}}))
    row = _rec(h, tmp_path)
    assert row["confidence_tier"] == PARTIAL and "unvetted findings" in row["gaps"]


def test_clean_hunt_stays_clean(tmp_path):
    h = _hunt(tmp_path)
    (h / "base_A.json").write_text("{}")
    (h / "run_A.json").write_text('{"p::T": "PASS"}')
    row = _rec(h, tmp_path)
    assert row["confidence_tier"] == "High-Confidence Clean" and row["gaps"] == []


def _clean(h: Path) -> None:
    (h / "base_A.json").write_text("{}")
    (h / "run_A.json").write_text('{"p::T": "PASS"}')


def test_empty_diff_d_json_is_gap(tmp_path):
    h = _hunt(tmp_path)
    _clean(h)
    (h / "diff_D.json").write_text("{}")
    assert _rec(h, tmp_path)["confidence_tier"] == PARTIAL


def test_empty_d_response_is_gap(tmp_path):
    h = _hunt(tmp_path)
    _clean(h)
    (h / "D").mkdir()
    (h / "D" / "response.json").write_text('{"files": []}')
    assert _rec(h, tmp_path)["confidence_tier"] == PARTIAL


def test_nonempty_d_response_is_not_gap(tmp_path):
    h = _hunt(tmp_path)
    _clean(h)
    (h / "D").mkdir()
    (h / "D" / "response.json").write_text('{"files": [{"path": "a", "content": "b"}]}')
    assert _rec(h, tmp_path)["confidence_tier"] == "High-Confidence Clean"


def test_omitted_mode_d_is_not_gap_and_requested_missing_mode_d_is_gap(tmp_path):
    h_omit = _hunt(tmp_path, "omit_d")
    _clean(h_omit)
    (h_omit / "diff_D.json").unlink()
    (h_omit / "driver.json").write_text(json.dumps({"modes": ["A", "B", "R"]}))
    assert _rec(h_omit, tmp_path)["confidence_tier"] == "High-Confidence Clean"

    h_req = _hunt(tmp_path, "req_d")
    _clean(h_req)
    (h_req / "diff_D.json").unlink()
    (h_req / "driver.json").write_text(json.dumps({"modes": ["A", "B", "D", "R"]}))
    assert _rec(h_req, tmp_path)["confidence_tier"] == PARTIAL
