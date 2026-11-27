# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Author-channel gate (ACC-1) and vetting records (ACC-4).

`vetted.json` (schema: ../vetted.schema.json) is the model's decision per candidate. This module decides what the
author sees. A row is admitted (`keep`) only when ALL of these hold:

  1. decision == KEEP;
  2. the mechanical verdict for the row's test is NEW_PR_BUG; or it is a Mode A/B row whose mechanical verdict is
     NEW_API and whose head run is FAIL_3_OF_3; or it is a Mode D row whose mechanical verdict is DIFF;
  3. entry_point is set (a real entry point the second test reproduces through);
  4. repro_cmd is non-empty (one command reproduces it);
  5. the fix-commit check is not STRICTLY_WEAK. The mechanical result (fix_<tag>.json, fix_D.json, written by
     eval_bugs.py when a fix exists) decides; the model's fix_check can only add a STRICTLY_WEAK, never clear one.

Every other row goes to `held` with the failing conditions named. The model can downgrade a row (DROP, HELD) but
can never upgrade one: rule 2 reads the mechanical files, not the model's words.

A missing vetted.json makes the result empty with `vetted_present` False; the ledger then reports "Partial".

The skeptic's DROP is checked too (check_drop): its `reason_code` names the kind of evidence and `evidence_quote`
must be found verbatim (whitespace-normalised, at least MIN_QUOTE_CHARS) in the text that kind of evidence comes
from. A DROP that fails the check becomes HELD, so an unsupported model claim can cost coverage but never hides a
candidate silently.
Stdlib only, like the rest of the skill.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

from hunt_common import read_optional_json
from verdicts import Verdict

SOURCES = frozenset({"A", "B", "D", "R", "V", "old", "verify"})
SEVERITIES = frozenset({"critical", "major", "minor"})
DECISIONS = frozenset({Verdict.KEEP.value, Verdict.DROP.value, Verdict.HELD.value})
FIX_CHECKS = frozenset({Verdict.STRONG.value, Verdict.STRICTLY_WEAK.value})
MIN_QUOTE_CHARS = 8
ROW_KEYS = ("id", "source", "decision", "reason", "file_line", "caller", "entry_point", "repro_cmd",
            "evidence_path", "severity", "fix_check")
# base_<tag>.json files that can hold a verdict for a Mode A/B row. A2 is the strengthen round of A.
_BASE_TAGS = {"A": ("A", "A2"), "B": ("B",)}


def load_vetted(hdir: Path) -> list[dict[str, Any]] | None:
    """Rows from hdir/vetted.json, or None when the file is missing or unreadable (the caller reports Partial).

    Accepts {"rows": [...]} (the schema form), a bare list, or the legacy {"findings": [...]} key.
    """
    data = read_optional_json(hdir / "vetted.json")
    if data is None:
        return None
    if isinstance(data, dict):
        data = data.get("rows", data.get("findings"))
    if not isinstance(data, list):
        return None
    return [r if isinstance(r, dict) else {"_raw": r} for r in data]


def _in(value: Any, allowed: frozenset[str]) -> bool:
    return isinstance(value, str) and value in allowed


def row_errors(row: dict[str, Any]) -> list[str]:
    """Shape errors against vetted.schema.json. Empty list means the row is well formed."""
    if "_raw" in row:
        return ["row is not an object"]
    errs = [f"missing {k}" for k in ROW_KEYS if k not in row]
    if errs:
        return errs
    if not isinstance(row["id"], str) or not row["id"]:
        errs.append("id must be a non-empty string")
    if not _in(row["source"], SOURCES):
        errs.append(f"source {row['source']!r} not in {sorted(SOURCES)}")
    if not _in(row["decision"], DECISIONS):
        errs.append(f"decision {row['decision']!r} not in KEEP|DROP|HELD")
    if not _in(row["severity"], SEVERITIES):
        errs.append(f"severity {row['severity']!r} not in critical|major|minor")
    if row["fix_check"] is not None and not _in(row["fix_check"], FIX_CHECKS):
        errs.append(f"fix_check {row['fix_check']!r} not in STRONG|STRICTLY_WEAK|null")
    for k in ("reason", "file_line", "caller", "repro_cmd", "evidence_path"):
        if not isinstance(row[k], str):
            errs.append(f"{k} must be a string")
    if row["entry_point"] is not None and not isinstance(row["entry_point"], str):
        errs.append("entry_point must be a string or null")
    return errs


def _lookup(path: Path, key: str) -> Any:
    data = read_optional_json(path)
    return data.get(key) if isinstance(data, dict) else None


def _mechanical_verdict_and_tag(hdir: Path, row: dict[str, Any]) -> tuple[str | None, str | None]:
    rid = str(row.get("id", ""))
    source = str(row.get("source", ""))
    if source in _BASE_TAGS:
        for tag in _BASE_TAGS[source]:
            v = _lookup(hdir / f"base_{tag}.json", rid)
            if isinstance(v, str):
                return v, tag
        return None, None
    if source == "R":
        entry = _lookup(hdir / "review_verdicts.json", "verdicts")
        item = entry.get(rid) if isinstance(entry, dict) else None
        if not isinstance(item, dict):
            return None, None
        if item.get("verdict") == Verdict.PROVEN.value:
            base = item.get("base_verdict")
            return (base, "R") if isinstance(base, str) else (None, None)
        v = item.get("verdict")
        return (v, "R") if isinstance(v, str) else (None, None)
    if source == "D":
        v = _lookup(hdir / "diff_D.json", rid)
        return (v, "D") if isinstance(v, str) else (None, None)
    if source == "old":
        tests = _lookup(hdir / "old_tests.json", "tests")
        v = tests.get(rid) if isinstance(tests, dict) else None
        return (v, "old") if isinstance(v, str) else (None, None)
    return None, None


def mechanical_verdict(hdir: Path, row: dict[str, Any]) -> str | None:
    """The oracle's verdict for the row's test, or None when no mechanical candidate oracle applies.

    A/B/A2: base_<tag>.json (NEW_PR_BUG, PRE_EXISTING, ...). R: review_verdicts.json, where a PROVEN thread reports
    its base_verdict. D: diff_D.json. old: old_tests.json "tests".
    verify (no mechanical oracle) and V (diagnostic-only Mode V runs attached to A/B candidates, never standalone
    candidates) intentionally return None so any standalone verify/V row stays in the HELD queue.
    """
    return _mechanical_verdict_and_tag(hdir, row)[0]


def _r_fix_verdict(hdir: Path, claim_id: str) -> str | None:
    """Resolve Mode R claim id (e.g. CR1) against test-keyed fix_R.json.

    Any STRICTLY_WEAK among linked tests is decisive so a weak sibling test is never masked by a STRONG one;
    otherwise priority follows STRONG > FIX_INCOMPATIBLE > FIX_NOT_RUN.
    """
    data = read_optional_json(hdir / "fix_R.json")
    if not isinstance(data, dict):
        return None
    if isinstance(data.get(claim_id), str):
        return str(data[claim_id])
    resp = read_optional_json(hdir / "R" / "response.json")
    declared: set[str] = set()
    if isinstance(resp, dict) and isinstance(resp.get("claims"), list):
        for c in resp["claims"]:
            if isinstance(c, dict) and str(c.get("id", "")) == claim_id and isinstance(c.get("tests"), list):
                declared = {str(x).strip() for x in c["tests"] if str(x).strip()}
                break
    pat = re.compile(rf"(?:^|::|\s)(?:Test)?HuntR_{re.escape(claim_id)}(?:_|[^A-Za-z0-9]|$)")
    matches: list[str] = []
    for k, v in data.items():
        if not isinstance(v, str):
            continue
        tail = str(k).split("::", 1)[1] if "::" in str(k) else str(k)
        if str(k) in declared or any(tail == w or tail.endswith(" " + w) for w in declared) or pat.search(str(k)):
            matches.append(v)
    if not matches:
        return None
    for pref in (Verdict.STRICTLY_WEAK.value, Verdict.STRONG.value, Verdict.FIX_INCOMPATIBLE.value,
                 Verdict.FIX_NOT_RUN.value):
        if pref in matches:
            return pref
    return matches[0]


def mechanical_fix(hdir: Path, row: dict[str, Any], *, tag: str | None = None) -> str | None:
    """The fix-commit verdict for the row's test, or None when no fix check ran."""
    rid, source = str(row.get("id", "")), str(row.get("source", ""))
    if source == "R":
        return _r_fix_verdict(hdir, rid)
    if tag is None:
        _, tag = _mechanical_verdict_and_tag(hdir, row)
    tags = (tag,) if tag else (("D",) if source == "D" else _BASE_TAGS.get(source, ()))
    for t in tags:
        v = _lookup(hdir / f"fix_{t}.json", rid)
        if isinstance(v, str):
            return v
    return None


def _held_reasons(hdir: Path, row: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    errs = row_errors(row)
    if errs:
        return [f"invalid row: {'; '.join(errs)}"]
    if row["decision"] != Verdict.KEEP.value:
        reasons.append(f"decision={row['decision']}")
    mech, mech_tag = _mechanical_verdict_and_tag(hdir, row)
    if mech is None:
        reasons.append("no mechanical verdict for this id")
    elif not (mech == Verdict.NEW_PR_BUG.value or (row["source"] == "D" and mech == Verdict.DIFF.value)
              or (row["source"] in ("A", "B") and mech == Verdict.NEW_API.value)):
        reasons.append(f"mechanical={mech} (need NEW_PR_BUG, Mode A/B NEW_API, or Mode D DIFF)")
    elif mech == Verdict.NEW_API.value and _lookup(hdir / f"run_{mech_tag or row['source']}.json", str(row["id"])) \
            != Verdict.FAIL_3_OF_3.value:
        reasons.append("NEW_API without a 3 of 3 head failure")
    if not row["entry_point"]:
        reasons.append("entry_point missing")
    if not str(row["repro_cmd"]).strip():
        reasons.append("repro_cmd missing")
    if Verdict.STRICTLY_WEAK.value in (row["fix_check"], mechanical_fix(hdir, row, tag=mech_tag)):
        reasons.append("fix_check=STRICTLY_WEAK")
    return reasons


def admissibility(hdir: Path) -> dict[str, Any]:
    """Split the vetted rows into what reaches the author and what stays in the HELD queue.

    Returns {"vetted_present": bool, "keep": [row...], "held": [{"row": row, "reasons": [str...]}...]}.
    A keep row carries `mechanical_verdict`. A missing vetted.json yields no rows and vetted_present False.
    """
    rows = load_vetted(hdir)
    if rows is None:
        return {"vetted_present": False, "keep": [], "held": []}
    keep: list[dict[str, Any]] = []
    held: list[dict[str, Any]] = []
    for row in rows:
        reasons = _held_reasons(hdir, row)
        if reasons:
            held.append({"row": row, "reasons": reasons})
        else:
            keep.append({**row, "mechanical_verdict": mechanical_verdict(hdir, row)})
    return {"vetted_present": True, "keep": keep, "held": held}


def apply_lessons(adm: dict[str, Any], hits: list[dict[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Apply lessons.post_filter hits onto admissibility() output; returns (keep, held, applied_lesson_ids)."""
    lesson_hits = {h["test_id"]: h["lesson_id"] for h in hits}
    keep: list[dict[str, Any]] = []
    held: list[dict[str, Any]] = list(adm["held"])
    applied: list[str] = []
    for row in adm["keep"]:
        lid = lesson_hits.get(str(row.get("id", "")))
        if lid is None:
            keep.append(row)
        else:
            applied.append(lid)
            held.append({"row": row, "reasons": [f"failure text matches false-positive lesson {lid}"]})
    return keep, held, list(dict.fromkeys(applied))


def _norm(text: str) -> str:
    return " ".join(text.split())


def drop_corpus(context: dict[str, Any], test_source: str) -> dict[str, str]:
    """Where each DROP reason code may quote from, built from the skeptic's own request."""
    pr: dict[str, Any] = context["pr"] if isinstance(context.get("pr"), dict) else {}
    callers = "\n".join(str(c.get("source", "")) + " " + str(c.get("permission_checks", ""))
                        for c in context.get("callers", []) if isinstance(c, dict))
    diff = str(context.get("diff_production_code", ""))
    return {
        "INTENDED": "\n".join([str(pr.get("title", "")), str(pr.get("description", "")), diff,
                               str(context.get("pr_tests_diff", ""))]),
        "UNREACHABLE": diff + "\n" + callers,
        "WRONG_ASSERTION": test_source,
    }


def check_drop(row: dict[str, Any], corpus: dict[str, str]) -> bool:
    """True when the row is not a DROP or its DROP is supported. An unsupported DROP is turned into HELD in place,
    keeping the skeptic's reason after the cause."""
    if row.get("decision") != Verdict.DROP.value:
        return True
    code = row.get("reason_code")
    quote = _norm(str(row.get("evidence_quote") or ""))
    if code not in corpus:
        why = f"reason_code {code!r} is not INTENDED, UNREACHABLE or WRONG_ASSERTION"
    elif len(quote) < MIN_QUOTE_CHARS:
        why = f"evidence_quote shorter than {MIN_QUOTE_CHARS} characters"
    elif quote not in _norm(corpus[code]):
        why = f"{code} quote not found verbatim in the request"
    else:
        return True
    row["decision"] = Verdict.HELD.value
    row["reason"] = f"unverified DROP ({why}): {row.get('reason', '')}"
    return False
