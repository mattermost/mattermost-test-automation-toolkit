#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Driver output: findings.json (author-facing KEEP items only) and audit.md (tiers, gaps, HELD, telemetry).

usage: report.py <pr | base..head | base...head>

findings.json is a JSON array; each item matches finding.schema.json. It is built from the rows verdict.json keeps, so
every item already passed verdict.admissibility(). Kept rows are grouped by root cause before they reach the author:
rows that name the exact same file_line are one bug. The group's most severe row is the item; the others go in its
`related` list. Rows on different lines are never merged, so a duplicate can remain but a distinct bug is never
hidden. The skeptic's `reason` is the impact sentence; NOT_CHECKED lists what the driver does not verify.
audit.md keeps everything else: the confidence tier with its gaps, HELD rows with reasons, coverage floor, and the
telemetry summary (wall seconds, tokens and cost per stage and in total).
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

from pathlib import Path
from typing import Any

import ledger
import telemetry
from hunt_common import hunt_dir, read_dict, read_state, write_json
from verdicts import Verdict

FINDING_KEYS = ("impact", "severity", "actor_roles", "entry_point", "repro_cmd", "base_result", "head_result",
                "contradicts", "file_line", "checked", "not_checked", "root_cause")
_SEVERITY_RANK = {"critical": 0, "major": 1, "minor": 2}
NOT_CHECKED = ["actor roles: the role matrix is not run by the driver",
               "PR text: no check of the description or commit message (contradicts is null)"]


def finding(row: dict[str, Any]) -> dict[str, Any]:
    """One author-facing item from a KEEP row. Mode D rows compare outputs (DIFF); test rows fail 3 of 3 on head."""
    is_diff = row.get("source") == "D"
    checked = [f"mechanical verdict {row.get('mechanical_verdict')} for {row.get('id')}",
               f"caller: {row.get('caller')}", f"evidence: {row.get('evidence_path')}"]
    if row.get("fix_check"):
        checked.append(f"fix check: {row['fix_check']}")
    return {
        "impact": row["reason"],
        "severity": row["severity"],
        "actor_roles": [],
        "entry_point": row["entry_point"],
        "repro_cmd": row["repro_cmd"],
        "base_result": "DIFF" if is_diff else Verdict.NEW_PR_BUG.value,
        "head_result": "DIFF" if is_diff else Verdict.FAIL_3_OF_3.value,
        "contradicts": None,
        "file_line": row["file_line"],
        "checked": checked,
        "not_checked": list(NOT_CHECKED),
    }


def group_root_causes(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Kept rows grouped by root cause: rows that name the exact same file_line are one bug. Rows on different lines
    stay separate, even in one function, so a distinct bug is never folded under another (PR 40336: a BOM-trim bug
    and a truncation bug 3 lines apart). Within a group the most severe row leads, then the lowest id."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for n, r in enumerate(rows):  # a row with no file_line is its own group: nothing proves it shares a cause
        key = str(r.get("file_line", "")).strip()
        groups.setdefault(key or f"\0{n}", []).append(r)
    out = [sorted(g, key=lambda r: (_SEVERITY_RANK.get(str(r.get("severity")), 9), str(r.get("id", ""))))
           for _, g in sorted(groups.items())]
    return out


def grouped_findings(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for g in group_root_causes(rows):
        item = finding(g[0])
        item["root_cause"] = str(g[0].get("file_line", "")).strip() or str(g[0].get("id", "unknown"))
        if len(g) > 1:
            item["related"] = [{"id": str(r.get("id", "")), "file_line": str(r.get("file_line", "")),
                                "repro_cmd": str(r.get("repro_cmd", "")), "impact": str(r.get("reason", ""))}
                               for r in g[1:]]
        out.append(item)
    return out


def _tier(hdir: Path, state: dict[str, Any], keep: list[dict[str, Any]], driver_gaps: list[str],
          held: int = 0) -> tuple[str, list[str], int, int]:
    """(tier, gaps, changed lines reached, executable changed lines)."""
    counts, _caught, reached, executable, mode_gaps = ledger._aggregate_modes(hdir)
    deferred, _skip = ledger._skipped_info(hdir)
    verdicts = read_dict(hdir / "review_verdicts.json").get("verdicts")
    tier, gaps = ledger._tier_and_gaps(hdir, counts, reached, executable, deferred, len(ledger._batch_dirs(hdir)),
                                       int(state.get("batches") or 1), mode_gaps,
                                       verdicts if isinstance(verdicts, dict) else {})
    if keep:
        return "Bug Proven", driver_gaps, reached, executable
    if tier == "Bug Proven":  # the ledger saw a vetted row the lesson filter has since held
        tier, gaps = "Partial or Unverified Coverage", ["findings held by a false-positive lesson"]
    if held:  # an unresolved candidate is neither a finding nor evidence of a clean PR
        tier, gaps = "Partial or Unverified Coverage", [*gaps, f"{held} candidate(s) HELD: unresolved, not reported"]
    if tier != "Bug Proven" and driver_gaps:
        tier = "Partial or Unverified Coverage"
    return tier, list(gaps) + driver_gaps, reached, executable


def _telemetry_table(hdir: Path) -> tuple[list[str], float, str, float]:
    summary = telemetry.summarize(hdir)
    rows = [
        "| stage | runs | secs | tokens in | cache write | cache read | tokens out | cost USD | failures |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, b in sorted(summary["by_stage"].items()):
        rows.append(f"| {name} | {b['count']} | {b['secs']:.1f} | {b['tokens_in']} | {b['cache_write']} | "
                    f"{b['cache_read']} | {b['tokens_out']} | {b['cost_usd']:.4f} | {b['failures']} |")
    wall = sum(b["secs"] for name, b in summary["by_stage"].items() if name.startswith("step:"))
    s = summary
    tokens = f"{s['tokens_in']} ({s['cache_write']} / {s['cache_read']}) / {s['tokens_out']}"
    return rows, wall, tokens, s["total_cost_usd"]


def write(hdir: Path, target: str) -> dict[str, Any]:
    state = read_state(hdir)
    prep = read_dict(hdir / "prepare.json")
    keep, not_kept = ledger.resolved_verdicts(hdir, require_verdict_json=True)
    # The skeptic's DROP is a decision (the evidence shows no bug); only the rest are unresolved.
    dropped: list[dict[str, Any]] = []
    held: list[dict[str, Any]] = []
    for h in not_kept:
        is_drop = str(h.get("row", {}).get("decision", "")).upper() == Verdict.DROP.value
        (dropped if is_drop else held).append(h)
    driver_gaps = sorted(f"{k}: {v}" for k, v in read_dict(hdir / "driver.json").get("gaps", {}).items())
    findings = grouped_findings(keep)
    for f in findings:
        if set(FINDING_KEYS) - set(f):
            raise ValueError("finding is missing keys")
    write_json(hdir / "findings.json", findings)
    tier, gaps, reached, executable = _tier(hdir, state, keep, driver_gaps, held=len(held))
    rows, wall, tokens, cost = _telemetry_table(hdir)
    lines = [
        f"# Hunt audit: {target}", "",
        f"- Head: `{prep.get('head', state.get('head', ''))}`",
        f"- Base: `{prep.get('merge_base', state.get('merge_base', ''))}` ({prep.get('base_mode', 'merge-base')})",
        f"- Schema: {prep.get('schema_version', 'unversioned')}",
        f"- Confidence tier: **{tier}**", "",
        f"## Gaps ({len(gaps)})", *([f"- {g}" for g in gaps] or ["- none"]), "",
        f"## Findings kept: {len(findings)} root cause(s) from {len(keep)} test(s) (see findings.json)",
        *[f"- `{f['root_cause']}` ({f['severity']}): {len(f.get('related', [])) + 1} test(s)" for f in findings], "",
        f"## HELD ({len(held)})",
    ]
    for h in held:
        row = h.get("row", {})
        lines.append(f"- `{row.get('id')}` ({row.get('source')}): {'; '.join(h.get('reasons', []))}")
    if not held:
        lines.append("- none")
    lines += ["", f"## Dropped by the skeptic ({len(dropped)})"]
    lines += [f"- `{h.get('row', {}).get('id')}` ({h.get('row', {}).get('source')}): {h.get('row', {}).get('reason', '')}"
              for h in dropped] or ["- none"]
    lines += ["", "## Coverage", f"- changed lines reached: {reached}/{executable} (Mode A)",
              "- Mutation gate: not run (the driver does not run --mutants)", "",
              "## Telemetry", f"- Wall seconds (steps): {wall:.1f}", f"- Tokens in (cache write / cache read) / out: {tokens}",
              f"- Cost USD: {cost:.4f}", "", *rows, ""]
    (hdir / "audit.md").write_text("\n".join(lines) + "\n")
    print(f"[report] {len(findings)} finding(s) ({len(keep)} kept tests), {len(held)} held, {len(dropped)} dropped, "
          f"tier: {tier}")
    print(f"[report] {hdir / 'findings.json'}")
    print(f"[report] {hdir / 'audit.md'}")
    return {"tier": tier, "findings": len(findings), "kept_tests": len(keep), "held": len(held),
            "dropped": len(dropped)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: report.py <pr | base..head | base...head>")
    write(hunt_dir(sys.argv[1]), sys.argv[1])
