# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Wave 1 contract: verdicts.py (M2), vetted.json and the author gate verdict.py (A1, A4), ledger tier (A5)."""
from __future__ import annotations

import ast
import io
import json
import re
import tokenize
from pathlib import Path
from typing import Any

import eval_bugs
import ledger
import pytest
import verdict
from verdicts import MEANINGS, MODE_NAMES, Verdict, render_glossary

SKILL = Path(__file__).resolve().parents[1] / ".claude" / "skills" / "hunt"
SCRIPTS = SKILL / "scripts"
VERDICT_VALUES = {v.value for v in Verdict}

# ALL_CAPS words in SKILL.md that are not verdicts or statuses. Anything else in caps must be a Verdict member.
NON_VERDICT_CAPS = frozenset({
    "A2",  # Mode A strengthen round tag
    "AND", "ARGUMENTS",  # prose and the $ARGUMENTS placeholder
    "API", "CI", "HTTP", "MCP", "PR", "UI", "SKILL",  # acronyms and names
    "CR1",  # CodeRabbit thread example id
    "M1", "M2", "M3", "M5",  # mutant ids
    "S1", "S2", "S3", "S4",  # strategy ids in strategy_x.md
    "REQ", "RELIABILITY",  # placeholder and file name
    "DISABLE_PROMPT_CACHING", "ENABLE_FULLY_PARALLEL_TESTS", "HUNT_FUZZ", "HUNT_FUZZ_TIME", "HUNT_PR_TEST_PARALLEL", "HUNT_SCRATCH",  # env vars
})


def _load_schema(name: str) -> dict[str, Any]:
    data = json.loads((SKILL / name).read_text())
    assert isinstance(data, dict)
    return data


def _vetted_row(**over: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "p::TestHuntA_X", "source": "A", "decision": "KEEP", "reason": "real",
        "file_line": "server/x.go:10", "caller": "api4 POST /x", "entry_point": "api4 POST /api/v4/x",
        "repro_cmd": "go test ./server/x -run TestHuntA_X", "evidence_path": "run_A.json",
        "severity": "major", "fix_check": None,
    }
    row.update(over)
    return row


def _hunt(tmp_path: Path, base_a: dict[str, str] | None = None, run_a: dict[str, str] | None = None) -> Path:
    h = tmp_path / "hunt"
    h.mkdir()
    (h / "state.json").write_text(json.dumps({"pr": "1", "head": "h", "merge_base": "b", "batches": 1}))
    (h / "base_A.json").write_text(json.dumps({"p::TestHuntA_X": "NEW_PR_BUG"} if base_a is None else base_a))
    (h / "run_A.json").write_text(json.dumps({"p::TestHuntA_X": "FAIL_3_OF_3"} if run_a is None else run_a))
    return h


def _write_vetted(h: Path, rows: list[dict[str, Any]]) -> None:
    (h / "vetted.json").write_text(json.dumps({"rows": rows}))


def _reasons(h: Path) -> list[list[str]]:
    return [item["reasons"] for item in verdict.admissibility(h)["held"]]


# ---------------------------------------------------------------- M2: verdicts.py, GLOSSARY.md, SKILL.md tokens

def test_every_all_caps_token_in_skill_md_is_a_defined_verdict():
    text = (SKILL / "SKILL.md").read_text()
    caps = set(re.findall(r"(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?![A-Za-z0-9_])", text))
    caps = {t for t in caps if len(t) >= 2}
    unknown = sorted(t for t in caps if t not in VERDICT_VALUES and t not in NON_VERDICT_CAPS)
    assert unknown == [], f"SKILL.md uses tokens missing from verdicts.py (or the allowlist): {unknown}"


def test_allowlist_has_no_verdict_and_no_stale_entries():
    text = (SKILL / "SKILL.md").read_text()
    assert not (NON_VERDICT_CAPS & VERDICT_VALUES), "a verdict is allowlisted as non-verdict"
    stale = sorted(t for t in NON_VERDICT_CAPS if not re.search(rf"(?<![A-Za-z0-9_]){re.escape(t)}(?![A-Za-z0-9_])", text))
    assert stale == [], f"allowlist entries no longer in SKILL.md: {stale}"


def test_every_member_has_one_line_meaning_and_a_source_prefix():
    assert set(MEANINGS) == set(Verdict)
    for v in Verdict:
        m = MEANINGS[v]
        assert m.prefix and m.prefix.isupper(), v
        assert m.text and "\n" not in m.text and m.text.endswith("."), v


def test_glossary_md_matches_the_generator():
    assert (SKILL / "GLOSSARY.md").read_text() == render_glossary()


def test_verdict_values_are_the_exact_strings_written_to_json():
    assert Verdict.NEW_PR_BUG == "NEW_PR_BUG"
    assert str(Verdict.PASS) == "PASS" and f"{Verdict.FAIL_3_OF_3}" == "FAIL_3_OF_3"
    assert json.dumps({Verdict.KEEP: Verdict.PROVEN}) == '{"KEEP": "PROVEN"}'
    assert repr(Verdict.DROP) == "'DROP'"
    assert {"PASS": 1}[Verdict.PASS] == 1  # a dict keyed by plain strings still finds members


def test_mode_names_cover_every_letter_mode():
    assert set(MODE_NAMES) == {"A", "B", "D", "R"}
    assert MODE_NAMES["R"] == "review-claims" and MODE_NAMES["A"] == "invariants"


def test_scripts_compare_verdicts_through_the_enum_not_bare_literals():
    """Every verdict-valued string in the six migrated scripts is Verdict.<NAME> (docstrings excluded)."""
    targets = ["run.py", "old_tests.py", "pr_tests.py", "review_threads.py", "eval_bugs.py", "ledger.py"]
    leftovers: list[str] = []
    for name in targets:
        src = (SCRIPTS / name).read_text()
        doc_lines = set()
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    doc_lines.add(first.lineno)
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type != tokenize.STRING or tok.string[0] not in "\"'" or tok.start[0] in doc_lines:
                continue
            if ast.literal_eval(tok.string) in VERDICT_VALUES:
                leftovers.append(f"{name}:{tok.start[0]} {tok.string}")
    assert leftovers == []


# ---------------------------------------------------------------- A4: schema and load_vetted

def test_schema_enums_match_the_python_contract():
    schema = _load_schema("vetted.schema.json")
    rows_schema = schema["properties"]["rows"]["items"]
    props = rows_schema["properties"]
    assert set(props["source"]["enum"]) == verdict.SOURCES
    assert set(props["decision"]["enum"]) == verdict.DECISIONS
    assert set(props["severity"]["enum"]) == verdict.SEVERITIES
    fix = {x for branch in props["fix_check"]["anyOf"] for x in branch.get("enum", [])}
    assert fix == verdict.FIX_CHECKS
    assert set(rows_schema["required"]) == set(verdict.ROW_KEYS)


def test_finding_schema_lists_the_author_fields_and_known_tokens():
    schema = _load_schema("finding.schema.json")
    assert set(schema["required"]) == {"impact", "severity", "actor_roles", "entry_point", "repro_cmd", "base_result",
                                       "head_result", "contradicts", "file_line", "checked", "not_checked", "root_cause"}
    assert schema["additionalProperties"] is False
    for key in ("base_result", "head_result"):
        assert set(schema["properties"][key]["enum"]) <= VERDICT_VALUES


def test_load_vetted_accepts_schema_form_bare_list_and_legacy_findings_key(tmp_path):
    h = tmp_path / "h"
    h.mkdir()
    assert verdict.load_vetted(h) is None  # missing file
    (h / "vetted.json").write_text("not json")
    assert verdict.load_vetted(h) is None
    (h / "vetted.json").write_text(json.dumps({"rows": [_vetted_row()]}))
    assert len(verdict.load_vetted(h) or []) == 1
    (h / "vetted.json").write_text(json.dumps([_vetted_row()]))
    assert len(verdict.load_vetted(h) or []) == 1
    (h / "vetted.json").write_text(json.dumps({"findings": [_vetted_row()]}))
    assert len(verdict.load_vetted(h) or []) == 1
    (h / "vetted.json").write_text(json.dumps({"rows": "nope"}))
    assert verdict.load_vetted(h) is None


def test_row_errors_flags_bad_shape_and_accepts_the_good_row():
    assert verdict.row_errors(_vetted_row()) == []
    assert verdict.row_errors(_vetted_row(source="X"))
    assert verdict.row_errors(_vetted_row(decision="MAYBE"))
    assert verdict.row_errors(_vetted_row(severity="blocker"))
    assert verdict.row_errors(_vetted_row(fix_check="WEAK"))
    assert verdict.row_errors(_vetted_row(entry_point=3))
    missing = _vetted_row()
    del missing["repro_cmd"]
    assert any("repro_cmd" in e for e in verdict.row_errors(missing))


# ---------------------------------------------------------------- A1: author gate

def test_full_keep_on_new_pr_bug_reaches_the_author(tmp_path):
    h = _hunt(tmp_path)
    _write_vetted(h, [_vetted_row()])
    out = verdict.admissibility(h)
    assert out["vetted_present"] is True and out["held"] == []
    assert [r["id"] for r in out["keep"]] == ["p::TestHuntA_X"]
    assert out["keep"][0]["mechanical_verdict"] == "NEW_PR_BUG"


def test_missing_vetted_file_admits_nothing(tmp_path):
    out = verdict.admissibility(_hunt(tmp_path))
    assert out == {"vetted_present": False, "keep": [], "held": []}


def test_fix_check_strong_still_admits_and_strictly_weak_is_held(tmp_path):
    h = _hunt(tmp_path)
    _write_vetted(h, [_vetted_row(fix_check="STRONG")])
    assert len(verdict.admissibility(h)["keep"]) == 1
    _write_vetted(h, [_vetted_row(fix_check="STRICTLY_WEAK")])
    out = verdict.admissibility(h)
    assert out["keep"] == [] and "fix_check=STRICTLY_WEAK" in out["held"][0]["reasons"]


@pytest.mark.parametrize("override, reason", [
    ({"decision": "DROP"}, "decision=DROP"),
    ({"decision": "HELD"}, "decision=HELD"),
    ({"entry_point": None}, "entry_point missing"),
    ({"entry_point": ""}, "entry_point missing"),
    ({"repro_cmd": "   "}, "repro_cmd missing"),
])
def test_each_failing_condition_is_named_in_the_hold_reason(tmp_path, override, reason):
    h = _hunt(tmp_path)
    _write_vetted(h, [_vetted_row(**override)])
    out = verdict.admissibility(h)
    assert out["keep"] == []
    assert reason in out["held"][0]["reasons"]


def test_model_cannot_upgrade_a_row_whose_mechanical_verdict_is_not_new_pr_bug(tmp_path):
    h = _hunt(tmp_path, base_a={"p::TestHuntA_X": "PRE_EXISTING"})
    _write_vetted(h, [_vetted_row()])  # the model says KEEP and the rest is complete
    out = verdict.admissibility(h)
    assert out["keep"] == []
    assert any(r.startswith("mechanical=PRE_EXISTING") for r in out["held"][0]["reasons"])


# NEW_API is admissible since the skeptic sees the PR's intent (test_wave2_driver: a NEW_API keep needs head 3 of 3).
@pytest.mark.parametrize("base_a", [{}, {"p::TestHuntA_X": "BASE_UNCOMPILABLE"}])
def test_row_without_new_pr_bug_on_base_is_held(tmp_path, base_a):
    h = _hunt(tmp_path, base_a=base_a)
    _write_vetted(h, [_vetted_row()])
    assert verdict.admissibility(h)["keep"] == []


def test_mode_a_row_falls_back_to_the_strengthen_round_base_file(tmp_path):
    h = _hunt(tmp_path, base_a={})
    (h / "base_A2.json").write_text(json.dumps({"p::TestHuntA_X": "NEW_PR_BUG"}))
    _write_vetted(h, [_vetted_row()])
    assert len(verdict.admissibility(h)["keep"]) == 1


def test_mode_d_diff_with_entry_point_is_admissible_and_same_is_not(tmp_path):
    h = _hunt(tmp_path)
    (h / "diff_D.json").write_text(json.dumps({"p::D": "DIFF", "p::S": "SAME"}))
    _write_vetted(h, [
        _vetted_row(id="p::D", source="D"),
        _vetted_row(id="p::S", source="D"),
    ])
    out = verdict.admissibility(h)
    assert [r["id"] for r in out["keep"]] == ["p::D"]
    assert out["held"][0]["row"]["id"] == "p::S"
    assert any(r.startswith("mechanical=SAME") for r in out["held"][0]["reasons"])


def test_mode_d_diff_without_entry_point_is_held(tmp_path):
    h = _hunt(tmp_path)
    (h / "diff_D.json").write_text(json.dumps({"p::D": "DIFF"}))
    _write_vetted(h, [_vetted_row(id="p::D", source="D", entry_point=None)])
    out = verdict.admissibility(h)
    assert out["keep"] == [] and "entry_point missing" in out["held"][0]["reasons"]


def test_mode_r_thread_admits_only_when_proven_on_a_new_pr_bug(tmp_path):
    h = _hunt(tmp_path)
    (h / "review_verdicts.json").write_text(json.dumps({"verdicts": {
        "CR1": {"verdict": "PROVEN", "base_verdict": "NEW_PR_BUG"},
        "CR2": {"verdict": "PROVEN", "base_verdict": "PRE_EXISTING"},
        "CR3": {"verdict": "UNPROVABLE_DYNAMICALLY", "base_verdict": ""},
    }}))
    _write_vetted(h, [
        _vetted_row(id="CR1", source="R"),
        _vetted_row(id="CR2", source="R"),
        _vetted_row(id="CR3", source="R"),
    ])
    out = verdict.admissibility(h)
    assert [r["id"] for r in out["keep"]] == ["CR1"]
    held = {item["row"]["id"]: item["reasons"] for item in out["held"]}
    assert any("PRE_EXISTING" in r for r in held["CR2"])
    assert any("UNPROVABLE_DYNAMICALLY" in r for r in held["CR3"])


def test_old_test_and_verify_rows_are_always_held(tmp_path):
    h = _hunt(tmp_path)
    (h / "old_tests.json").write_text(json.dumps({"tests": {"p::Old": "OLD_TEST_BREAKS"}}))
    _write_vetted(h, [
        _vetted_row(id="p::Old", source="old"),
        _vetted_row(id="ui-1", source="verify"),
        _vetted_row(id="ui-2", source="V"),
    ])
    out = verdict.admissibility(h)
    assert out["keep"] == [] and len(out["held"]) == 3
    assert any("mechanical=OLD_TEST_BREAKS" in r for r in out["held"][0]["reasons"])
    assert all("no mechanical verdict for this id" in item["reasons"] for item in out["held"][1:])


def test_invalid_row_is_held_with_the_shape_error(tmp_path):
    h = _hunt(tmp_path)
    _write_vetted(h, [_vetted_row(source="Z"), "not a dict"])  # type: ignore[list-item]
    out = verdict.admissibility(h)
    assert out["keep"] == []
    assert out["held"][0]["reasons"][0].startswith("invalid row: source")
    assert out["held"][1]["reasons"] == ["invalid row: row is not an object"]


# ---------------------------------------------------------------- A5: ledger tier calls the gate

def test_ledger_bug_proven_iff_admissibility_keeps_a_row(tmp_path):
    h = _hunt(tmp_path)
    _write_vetted(h, [_vetted_row(entry_point=None)])  # KEEP, but no entry point
    row = ledger.record("1", hdir=h, out_path=tmp_path / "a.jsonl")
    assert row["confidence_tier"] != "Bug Proven"
    _write_vetted(h, [_vetted_row()])
    row = ledger.record("1", hdir=h, out_path=tmp_path / "b.jsonl")
    assert row["confidence_tier"] == "Bug Proven"


def test_ledger_has_one_tier_definition_and_it_uses_verdict_py():
    assert not hasattr(ledger, "_confidence_tier")
    assert not hasattr(ledger, "_has_kept_finding")
    assert ledger.admissibility is verdict.admissibility


def test_eval_fix_verdicts_are_the_contract_tokens():
    assert set(eval_bugs.FIX_VERDICTS) == {Verdict.STRONG, Verdict.STRICTLY_WEAK, Verdict.FIX_INCOMPATIBLE,
                                           Verdict.FIX_FLAKY, Verdict.FIX_NOT_RUN}
    assert all(isinstance(x, str) and x in VERDICT_VALUES for x in eval_bugs.FIX_VERDICTS)
