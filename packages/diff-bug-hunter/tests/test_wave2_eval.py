"""Wave 2 eval: FP gates on D DIFF / R PROVEN / PR-CI / admissibility (A6) and fix-check validity (A7)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "skills" / "hunt" / "scripts"))
import eval_bugs
from verdicts import Verdict


def _git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=env).stdout.strip()


def _commit(repo: Path, name: str) -> str:
    (repo / name).write_text(name)
    _git(repo, "add", name)
    _git(repo, "commit", "-qm", name)
    return _git(repo, "rev-parse", "HEAD")


def _card(**metrics: float) -> dict[str, Any]:
    return {"metrics": {"vetted_recall": 0.5, "fp_rate": 0.0, **metrics}, "rows": [{"kind": "case", "id": "c1"}],
            "errors": []}


# ------------------------------------------------------------------ A6: every author-reaching FP rate is gated
def test_diff_gate_fails_on_each_extra_fp_rate():
    for key in eval_bugs.FP_GATE_METRICS:
        res = eval_bugs.diff_scorecards(_card(), _card(**{key: 0.02}))
        assert res["verdict"] == "FAIL" and res["fp_gate_failures"] == [key], key
        assert eval_bugs.diff_scorecards(_card(), _card(**{key: 0.02}), max_fp=0.05)["verdict"] == "PASS"
    assert eval_bugs.diff_scorecards(_card(), _card(diff_fp_rate=0.0, admissibility_fp_rate=0.0))["verdict"] == "PASS"


def _hunted_with_vet(keep: list[str]) -> dict[str, Any]:
    return {"results": [{"hunter": "V", "admissibility": {"vetted_present": True, "keep": keep, "held": 1}}]}


def _manifest() -> dict[str, Any]:
    return {"cases": [{"id": "c1", "area": "a"}], "controls": [{"id": "k1", "area": "a"}, {"id": "k2", "area": "a"}],
            "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}


def test_scorecard_scores_admissibility_keep_rows_on_controls_as_fp():
    hunted = {"c1": _hunted_with_vet(["x"]), "k1": _hunted_with_vet(["y"]), "k2": _hunted_with_vet([])}
    card = eval_bugs.scorecard(_manifest(), hunted, ("hunters", "diff"))
    assert card["metrics"]["admissibility_recall"] == 1.0
    assert card["metrics"]["admissibility_fp_rate"] == 0.5
    assert card["fp_checks"]["admissibility_fp_rate"] is False and card["verdict"] == Verdict.FAIL


def test_scorecard_gates_diff_review_and_pr_ci_false_positives_on_controls():
    hunted: dict[str, Any] = {"c1": {"results": []}, "k2": {"results": []},
                              "k1": {"results": [{"hunter": "D", "diff": {"t": "DIFF"}},
                                                 {"hunter": "R", "review": {"c": "PROVEN"}},
                                                 {"hunter": "PR", "pr": {"p": "PR_TEST_FAILS_UNDER_CI"}}]}}
    card = eval_bugs.scorecard(_manifest(), hunted, ("hunters", "diff", "pr", "review"))
    for key in ("diff_fp_rate", "review_fp_rate", "pr_ci_fp_rate"):
        assert card["metrics"][key] == 0.5 and card["fp_checks"][key] is False
    assert card["verdict"] == Verdict.FAIL
    # a signal that was not run is not gated
    off = eval_bugs.scorecard(_manifest(), hunted, ("hunters",))
    assert "diff_fp_rate" not in off["fp_checks"] and "pr_ci_fp_rate" not in off["fp_checks"]


def test_clean_controls_pass_every_gate():
    hunted = {k: _hunted_with_vet([]) for k in ("c1", "k1", "k2")}
    card = eval_bugs.scorecard(_manifest(), hunted, ("hunters", "diff"))
    assert all(card["fp_checks"].values()) and card["fp_checks"] and card["verdict"] == Verdict.PASS


def test_vet_signal_reads_verdict_admissibility(tmp_path, monkeypatch):
    assert eval_bugs.vet_signal(tmp_path)["admissibility"] == {"vetted_present": False, "keep": [], "held": 0}
    monkeypatch.setattr(eval_bugs.verdict, "admissibility",
                        lambda h: {"vetted_present": True, "keep": [{"id": "f1"}], "held": [{}, {}]})
    assert eval_bugs.vet_signal(tmp_path)["admissibility"] == {"vetted_present": True, "keep": ["f1"], "held": 2}

    def boom(_h: Path) -> dict[str, Any]:
        raise ValueError("bad vetted.json")
    monkeypatch.setattr(eval_bugs.verdict, "admissibility", boom)
    assert "bad vetted.json" in eval_bugs.vet_signal(tmp_path)["vet_error"]


# ------------------------------------------------------------------ A7: fix must descend from the bug
def test_fix_descends_requires_bug_in_fix_history(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    root = _commit(tmp_path, "root")
    bug = _commit(tmp_path, "bug")
    fix = _commit(tmp_path, "fix")
    _git(tmp_path, "checkout", "-q", "-b", "side", root)
    side = _commit(tmp_path, "side")
    assert eval_bugs.fix_descends(tmp_path, bug, fix)
    assert not eval_bugs.fix_descends(tmp_path, fix, bug)
    assert not eval_bugs.fix_descends(tmp_path, bug, side)  # unrelated line: not a valid fix check


def test_unreachable_fix_marks_vetted_tests_fix_not_run(tmp_path, monkeypatch):
    def fake_attempt(hdir: Path, state: dict[str, Any], tag: str, row: dict[str, Any]) -> None:
        row["run"] = {"t1": "FAIL_3_OF_3", "t2": "FAIL_3_OF_3"}
        row["base"] = {"t1": "NEW_PR_BUG", "t2": "PRE_EXISTING"}
    monkeypatch.setattr(eval_bugs, "_attempt", fake_attempt)
    row = eval_bugs.hunt_tag(1, tmp_path, {}, "A", 1, None, None, "fix_sha abc does not descend from bug_sha def")
    assert row["fix"] == {"t1": Verdict.FIX_NOT_RUN} and "does not descend" in row["fix_reason"]
    card = eval_bugs.scorecard(
        {"cases": [{"id": "c1", "area": "a", "fix_sha": "f"}], "controls": [],
         "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}, {"c1": {"results": [row]}}, ("hunters",))
    r = card["rows"][0]
    assert r["strong"] is False and r["fix_verdicts"] == {"A": {Verdict.FIX_NOT_RUN: 1}}
    assert r["fix_not_run_reasons"] == ["fix_sha abc does not descend from bug_sha def"]
    assert "fix not run c1" in eval_bugs.render(card)


def test_hunt_diff_marks_diff_tests_fix_not_run_when_fix_unreachable(tmp_path, monkeypatch):
    monkeypatch.setattr(eval_bugs.run, "cmd_diff", lambda h, s, t="D": {"t1": "DIFF", "t2": "SAME"})
    row = eval_bugs.hunt_diff(1, tmp_path, {}, 1, None, None, "unreachable")
    assert row["fix"] == {"t1": Verdict.FIX_NOT_RUN} and row["fix_reason"] == "unreachable"


def test_hunt_diff_runs_the_fix_check_on_mode_d_records(tmp_path, monkeypatch):
    monkeypatch.setattr(eval_bugs.run, "cmd_diff", lambda h, s, t="D": {"t1": "DIFF"})
    seen: list[Path] = []

    def fake_fix(hdir: Path, state: dict[str, Any], wt_fix: Path) -> dict[str, str]:
        seen.append(wt_fix)
        return {"t1": Verdict.STRONG}
    monkeypatch.setattr(eval_bugs, "cmd_fix_diff", fake_fix)
    row = eval_bugs.hunt_diff(1, tmp_path, {}, 1, None, tmp_path / "wtfix")
    assert row["fix"] == {"t1": Verdict.STRONG} and seen == [tmp_path / "wtfix"]
    card = eval_bugs.scorecard(
        {"cases": [{"id": "c1", "area": "a", "fix_sha": "f", "kind": "fix_forward"}], "controls": [],
         "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}, {"c1": {"results": [row]}}, ("diff",))
    assert card["metrics"]["strong_recall_fix_forward"] == 1.0 and card["rows"][0]["strong"]


# ------------------------------------------------------------------ A7: gate on fix-forward strong recall and weak ratio
def test_diff_gate_on_fix_forward_recall_and_weak_ratio():
    base = _card(strong_recall=0.5, strong_recall_fix_forward=0.5, strictly_weak_ratio_A=0.2)
    assert eval_bugs.diff_scorecards(base, base)["verdict"] == "PASS"
    worse_fwd = _card(strong_recall=0.5, strong_recall_fix_forward=0.4, strictly_weak_ratio_A=0.2)
    res = eval_bugs.diff_scorecards(base, worse_fwd)
    assert res["verdict"] == "FAIL" and not res["fwd_ok"]
    worse_weak = _card(strong_recall=0.5, strong_recall_fix_forward=0.5, strictly_weak_ratio_A=0.3)
    res = eval_bugs.diff_scorecards(base, worse_weak)
    assert res["verdict"] == "FAIL" and res["weak_ratio_regressions"] == ["strictly_weak_ratio_A"]
    # a scorecard without the metrics (older) skips both checks
    assert eval_bugs.diff_scorecards(_card(), worse_weak)["verdict"] == "PASS"
    assert eval_bugs.diff_scorecards(base, _card(strong_recall=0.5))["verdict"] == "PASS"
    assert eval_bugs.diff_scorecards(_card(strong_recall_fix_forward=0.5, strictly_weak_ratio_D=0.1),
                                     _card(strong_recall_fix_forward=0.5, strictly_weak_ratio_D=0.0))["verdict"] == "PASS"


def test_cli_diff_prints_new_gates(tmp_path, capsys):
    b, c = tmp_path / "b.json", tmp_path / "c.json"
    b.write_text(json.dumps(_card(strong_recall_fix_forward=0.5)))
    c.write_text(json.dumps(_card(strong_recall_fix_forward=0.1, diff_fp_rate=0.1)))
    assert eval_bugs._cmd_diff([str(b), str(c)]) == 1
    out = capsys.readouterr().out
    assert "strong_recall_fix_forward" in out and "diff_fp_rate" in out
