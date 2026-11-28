# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Regression tests for Milestone M5 Group B CodeRabbit fixes (#10-#16)."""
from __future__ import annotations

import json
from pathlib import Path

import build_requests
import ctx
import ledger
import report
import trusted
from conftest import vetted_row
from hunt_common import InfraError, write_json

PARTIAL = "Partial or Unverified Coverage"


def _write(root: Path, rel: str, text: str) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def _base_hunt(tmp_path: Path, name: str = "h") -> Path:
    h = tmp_path / name
    h.mkdir(parents=True, exist_ok=True)
    write_json(h / "state.json", {"pr": "1", "head": "h1", "merge_base": "b1", "batches": 1})
    write_json(h / "prepare.json", {"schema_version": 1, "head": "h1", "merge_base": "b1"})
    write_json(h / "run_A.json", {"p::T": "PASS"})
    write_json(h / "run_B.json", {"p::T": "PASS"})
    write_json(h / "base_A.json", {})
    write_json(h / "base_B.json", {})
    write_json(h / "diff_D.json", {"p::D": "SAME"})
    write_json(h / "run_A.coverage.json", {"reached": 3, "executable": 5})
    return h


# ------------------------------------------------------------------ #10: enclosing_function


def test_enclosing_function_single_line_go_and_out_of_range_hits(tmp_path):
    lines = [
        "package api4",
        "func Short() { DoCall() }",
        "func Other() {",
        "\tSessionHasPermissionToManageSystem()",
        "}",
        "var afterClose = DoCall()",
    ]
    assert ctx.enclosing_function(lines, 2, "go") == ("Short", 2, 2)
    assert ctx.enclosing_function(lines, 4, "go") == ("Other", 3, 5)
    assert ctx.enclosing_function(lines, 6, "go") is None

    # String-literal braces inside a function do not close the range early; hits after `}` return None.
    brace_lines = [
        "package app",
        "func HasBrace() {",
        '\ts := "}"',
        "\tDoCall()",
        "}",
        "// trailing DoCall()",
    ]
    assert ctx.enclosing_function(brace_lines, 4, "go") == ("HasBrace", 2, 5)
    assert ctx.enclosing_function(brace_lines, 6, "go") is None

    # Bodyless Go declaration must not swallow the following function's body.
    stub_lines = [
        "package app",
        "func Stub(x int)",
        "func Next() { SessionHasPermissionToManageSystem() }",
    ]
    assert ctx.enclosing_function(stub_lines, 2, "go") is None

    # Integration with callers(): single-line caller must not pick up next function's permission checks.
    wt = tmp_path / "wt"
    _write(wt, "server/channels/app/target.go", "package app\nfunc DoCall() {}\n")
    _write(wt, "server/channels/api4/callers.go", "\n".join(lines) + "\n")
    out = ctx.callers(wt, ["server/channels/app/target.go"], {"DoCall"})
    assert len(out) == 1
    assert out[0]["enclosing"] == "Short"
    assert out[0]["permission_checks"] == []


def test_enclosing_function_ts_memo_and_bodyless_const():
    ts_lines = [
        "const LIMIT = 5",
        "export const Comp = React.memo(() => {",
        "\tSessionHasPermissionToManageSystem();",
        "\treturn DoCall();",
        "});",
        "const after = DoCall();",
    ]
    assert ctx.enclosing_function(ts_lines, 1, "jest") is None
    assert ctx.enclosing_function(ts_lines, 4, "jest") == ("Comp", 2, 5)
    assert ctx.enclosing_function(ts_lines, 6, "jest") is None


# ------------------------------------------------------------------ #11: jest_fallback containment


def test_jest_fallback_blocks_symlinked_dir_and_files_outside_checkout(tmp_path):
    wt = tmp_path / "wt"
    outside = tmp_path / "outside"
    _write(outside, "secret.test.tsx", "const SECRET = 'do-not-leak';\ntest('s', () => {});\n")

    comp_dir = wt / "webapp" / "components" / "widget"
    _write(comp_dir, "widget.tsx", "export const Widget = () => null;\n")

    # Symlinked __tests__ directory pointing outside the checkout.
    (comp_dir / "__tests__").symlink_to(outside, target_is_directory=True)
    # Symlinked test file inside a real parent __tests__ directory pointing outside the checkout.
    parent_tests = wt / "webapp" / "components" / "__tests__"
    parent_tests.mkdir(parents=True, exist_ok=True)
    (parent_tests / "leak.test.tsx").symlink_to(outside / "secret.test.tsx")

    assert ctx.jest_fallback(comp_dir, set(), wt) == []

    # A regular test file inside the checkout's parent __tests__ is still allowed.
    _write(parent_tests, "local.test.tsx", "test('ok', () => {});\n")
    found = ctx.jest_fallback(comp_dir, set(), wt)
    assert [str(p.relative_to(wt)) for _, p, _ in found] == ["webapp/components/__tests__/local.test.tsx"]

    # Checkout-root directory safely skips d.parent / "__tests__" outside wt.
    _write(wt, "index.tsx", "export const Root = () => null;\n")
    assert ctx.jest_fallback(wt, {"index.tsx"}, wt) == []


# ------------------------------------------------------------------ #12: caller cap before excerpts


def test_callers_applies_cap_before_building_unused_excerpts(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    _write(wt, "server/channels/app/target.go", "package app\n\nfunc Popular() {}\n")
    for i in range(30):
        _write(wt, f"server/channels/api4/ep_{i:02d}.go", f"package api4\n\nfunc Ep{i}() {{\n\tPopular()\n}}\n")

    enc_calls = 0
    perm_calls = 0
    orig_enc = ctx.enclosing_function
    orig_perm = ctx.permission_lines

    def count_enc(lines, n, lang):
        nonlocal enc_calls
        enc_calls += 1
        return orig_enc(lines, n, lang)

    def count_perm(f, lines, a, b):
        nonlocal perm_calls
        perm_calls += 1
        return orig_perm(f, lines, a, b)

    monkeypatch.setattr(ctx, "MAX_CALLERS", 4)
    monkeypatch.setattr(ctx, "enclosing_function", count_enc)
    monkeypatch.setattr(ctx, "permission_lines", count_perm)

    out = ctx.callers(wt, ["server/channels/app/target.go"], {"Popular"})
    assert len(out) == 4
    assert enc_calls == 4
    assert perm_calls == 4


# ------------------------------------------------------------------ #13: exclude declarations from caller hops


def test_callers_excludes_declarations_and_visited_hits_from_hops(tmp_path):
    wt = tmp_path / "wt"
    _write(wt, "server/channels/app/target.go", "package app\n\nfunc TargetFunc() {}\n")
    # app/a.go sorts alphabetically before app/b.go and declares Bridge().
    _write(
        wt,
        "server/channels/app/a.go",
        "package app\n\nfunc Bridge() {\n\tTargetFunc()\n}\n",
    )
    _write(
        wt,
        "server/channels/app/b.go",
        "package app\n\nfunc CallerB() {\n\tBridge()\n}\n",
    )
    _write(
        wt,
        "server/channels/api4/c.go",
        "package api4\n\nfunc ApiHandler() {\n"
        "\tif !SessionHasPermissionToTeam(id) {\n\t\treturn\n\t}\n"
        "\tCallerB()\n}\n",
    )

    out = ctx.callers(wt, ["server/channels/app/target.go"], {"TargetFunc"})
    by_hop = {e["hop"]: e for e in out}
    assert by_hop[1]["file"] == "server/channels/app/a.go" and by_hop[1]["enclosing"] == "Bridge"
    assert by_hop[2]["file"] == "server/channels/app/b.go" and by_hop[2]["enclosing"] == "CallerB"
    assert by_hop[3]["file"] == "server/channels/api4/c.go" and by_hop[3]["entry_point"] is True
    assert by_hop[3]["enclosing"] == "ApiHandler"
    assert any("SessionHasPermissionToTeam" in line for line in by_hop[3]["permission_checks"])


def test_callers_keeps_entry_point_ranking_and_allows_other_same_file_callers(tmp_path):
    wt = tmp_path / "wt"
    _write(wt, "server/channels/app/target.go", "package app\n\nfunc Leaf() {}\n")
    _write(
        wt,
        "server/channels/app/a.go",
        "package app\n\n"
        "func Bridge(n int) {\n"
        "\tif n > 0 { Bridge(n - 1) }\n"
        "\tLeaf()\n"
        "}\n\n"
        "func SameFileOuter() {\n"
        "\tBridge(1)\n"
        "}\n",
    )
    _write(
        wt,
        "server/channels/api4/z_entry.go",
        "package api4\n\nfunc Entry() {\n\tBridge(1)\n}\n",
    )

    out = ctx.callers(wt, ["server/channels/app/target.go"], {"Leaf"})
    hop2 = [e for e in out if e["hop"] == 2]
    assert len(hop2) == 1
    assert hop2[0]["file"] == "server/channels/api4/z_entry.go" and hop2[0]["entry_point"] is True


# ------------------------------------------------------------------ #14: keep unvetted PR/old/R out of clean


def test_empty_verdict_json_does_not_clear_unvetted_pr_old_or_r_failures(tmp_path):
    empty_verdict = {"vetted_present": True, "keep": [], "held": []}

    # 1. Unvetted PR_TEST_FAILS_UNDER_CI + empty verdict.json -> Partial, not High-Confidence Clean.
    h_pr = _base_hunt(tmp_path, "h_pr")
    write_json(h_pr / "pr_tests.json", {"tests": {"ci::TestPR": "PR_TEST_FAILS_UNDER_CI"}})
    write_json(h_pr / "vetted.json", {"rows": []})
    write_json(h_pr / "verdict.json", empty_verdict)
    rec_pr = ledger.record("1", hdir=h_pr, out_path=tmp_path / "l_pr.jsonl")
    assert rec_pr["confidence_tier"] == PARTIAL
    assert "unvetted findings" in rec_pr["gaps"]
    rep_pr = report.write(h_pr, "1")
    assert rep_pr["tier"] == PARTIAL

    # 2. Unrelated DROP in verdict.json must still keep PR_TEST_FAILS_UNDER_CI unvetted.
    drop_a = {"row": vetted_row(id="p::Other", source="A", decision="DROP"), "reasons": ["decision=DROP"]}
    write_json(h_pr / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_a]})
    rec_pr2 = ledger.record("1", hdir=h_pr, out_path=tmp_path / "l_pr2.jsonl")
    assert rec_pr2["confidence_tier"] == PARTIAL
    assert "unvetted findings" in rec_pr2["gaps"]

    # 3. Unvetted OLD_TEST_BREAKS and OLD_TEST_SOMETIMES_BREAKS + empty verdict.json -> Partial.
    for idx, status in enumerate(("OLD_TEST_BREAKS", "OLD_TEST_SOMETIMES_BREAKS")):
        h_old = _base_hunt(tmp_path, f"h_old_{idx}")
        write_json(h_old / "old_tests.json", {"tests": {"pkg::TestOld": status}})
        write_json(h_old / "vetted.json", {"rows": []})
        write_json(h_old / "verdict.json", empty_verdict)
        rec_old = ledger.record("1", hdir=h_old, out_path=tmp_path / f"l_old_{idx}.jsonl")
        assert rec_old["confidence_tier"] == PARTIAL
        assert "unvetted findings" in rec_old["gaps"]

    # 4. Unvetted Mode R PROVEN + NEW_PR_BUG + empty verdict.json -> Partial.
    h_r = _base_hunt(tmp_path, "h_r")
    write_json(h_r / "review_verdicts.json", {"verdicts": {"CR1": {"verdict": "PROVEN", "base_verdict": "NEW_PR_BUG"}}})
    write_json(h_r / "vetted.json", {"rows": []})
    write_json(h_r / "verdict.json", empty_verdict)
    rec_r = ledger.record("1", hdir=h_r, out_path=tmp_path / "l_r.jsonl")
    assert rec_r["confidence_tier"] == PARTIAL
    assert "unvetted findings" in rec_r["gaps"]

    # 5. Vetting the R claim as DROP clears unvetted, but its merge-base oracle is NEW_PR_BUG: the dismissal is a gap.
    drop_r = {"row": vetted_row(id="CR1", source="R", decision="DROP"), "reasons": ["decision=DROP"]}
    write_json(h_r / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_r]})
    rec_r_clean = ledger.record("1", hdir=h_r, out_path=tmp_path / "l_r_clean.jsonl")
    assert rec_r_clean["confidence_tier"] == PARTIAL
    assert rec_r_clean["gaps"] == ["1 mechanical failure(s) dismissed by the skeptic"]


# ------------------------------------------------------------------ #15: chronological archive order


def test_archive_batch_order_supersedes_by_chronology_not_batch_number(tmp_path):
    hdir = tmp_path / "h_chrono"
    hdir.mkdir()
    keep_a = vetted_row(id="p::TestBug", source="A", decision="KEEP")
    drop_a = {"row": vetted_row(id="p::TestBug", source="A", decision="DROP"), "reasons": ["decision=DROP"]}

    # Archive batch 1 (clean), then batch 2 (KEEP), then rerun batch 1 (DROP).
    write_json(hdir / "run_A.json", {"p::Other": "PASS"})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    b1 = ctx.archive_batch(hdir, 1)

    write_json(hdir / "run_A.json", {"p::TestBug": "FAIL_3_OF_3"})
    write_json(hdir / "base_A.json", {"p::TestBug": "NEW_PR_BUG"})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [keep_a], "held": []})
    b2 = ctx.archive_batch(hdir, 2)

    write_json(hdir / "run_A.json", {"p::TestBug": "PASS"})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_a]})
    b1_rerun = ctx.archive_batch(hdir, 1)

    assert [b1.name, b2.name, b1_rerun.name] == ["batch_1", "batch_2", "batch_1.2"]
    assert json.loads((hdir / "batches" / "order.json").read_text()) == ["batch_1", "batch_2", "batch_1.2"]
    assert [p.name for p in ledger._batch_dirs(hdir)] == ["batch_1", "batch_2", "batch_1.2", "h_chrono"]

    keep, held = ledger.resolved_verdicts(hdir)
    assert keep == []
    assert [h["row"]["id"] for h in held] == ["p::TestBug"]

    tier, gaps = ledger._tier_and_gaps(hdir, {"mode_a_empty": 0}, 1, 1, 0, 3, 3, False, {})
    assert tier == PARTIAL and gaps == ["1 mechanical failure(s) dismissed by the skeptic"]

    # Also when batch 2 is archived first and batch 1 second, batch 1 must win.
    hdir2 = tmp_path / "h_reverse"
    hdir2.mkdir()
    write_json(hdir2 / "run_A.json", {"p::TestBug": "FAIL_3_OF_3"})
    write_json(hdir2 / "verdict.json", {"vetted_present": True, "keep": [keep_a], "held": []})
    ctx.archive_batch(hdir2, 2)
    write_json(hdir2 / "run_A.json", {"p::TestBug": "PASS"})
    write_json(hdir2 / "verdict.json", {"vetted_present": True, "keep": [], "held": [drop_a]})
    ctx.archive_batch(hdir2, 1)
    assert [p.name for p in ledger._batch_dirs(hdir2)] == ["batch_2", "batch_1", "h_reverse"]
    assert ledger.resolved_verdicts(hdir2)[0] == []


# ------------------------------------------------------------------ #16: UTF-8 fallback in prompt_version


def test_prompt_version_decodes_fallback_prompts_as_utf8(tmp_path, monkeypatch):
    skill = tmp_path / "skill"
    (skill / "prompts").mkdir(parents=True)
    utf8_prompt = "Rule: keep café — handle → cleanly.\n"
    (skill / "prompts" / "common.md").write_text(utf8_prompt, encoding="utf-8")
    for rel in ("RELIABILITY.md", "lessons.jsonl", "vetted.schema.json", "finding.schema.json"):
        (skill / rel).write_text("{}\n", encoding="utf-8")

    expected = build_requests.prompt_version(skill, 1)

    seen_encodings: list[str | None] = []
    orig_read_text = Path.read_text

    def tracked_read_text(self: Path, encoding: str | None = None, errors: str | None = None) -> str:
        if self.is_relative_to(skill):
            seen_encodings.append(encoding)
        return orig_read_text(self, encoding=encoding, errors=errors)

    monkeypatch.setattr(trusted, "read", lambda rel, root=skill: (_ for _ in ()).throw(InfraError("no git")))
    monkeypatch.setattr(Path, "read_text", tracked_read_text)

    actual = build_requests.prompt_version(skill, 1)
    assert actual == expected
    assert seen_encodings and all(enc == "utf-8" for enc in seen_encodings)
