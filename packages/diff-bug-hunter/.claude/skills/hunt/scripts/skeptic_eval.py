#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Skeptic calibration: replay hand-labelled skeptic requests through the current prompt and score the decisions.

usage: skeptic_eval.py [<fixtures dir>] [--out <dir>]

Each fixture (default: ../../../../eval/skeptic/*.json) holds one PR's skeptic request (`user`: PR intent, diff,
callers and candidates, as hunt.py built it) and `labels`: the decision a person verified for some candidate ids.
The request is rebuilt with today's hunt.SKEPTIC_SYSTEM and vetted.schema.json, answered through dispatch.py (so
$HUNT_DISPATCH_CMD and the inline default both work), and every DROP goes through verdict.check_drop, exactly as in
a hunt. Then each labelled id is scored:

  label KEEP, decision KEEP  pass
  label KEEP, decision DROP  FAIL (a known bug dropped: recall loss)
  label KEEP, decision HELD  held (no wrong output, but the bug does not reach the author)
  label DROP, decision KEEP  FAIL (a known non-bug kept: a wrong finding)
  label DROP, decision DROP  pass
  label DROP, decision HELD  held
  id missing from the answer FAIL

Exit 0 when nothing FAILs, 1 otherwise, 2 on INFRA_ERROR. A scorecard (skeptic_scorecard.json) is written to --out.
Every run calls the model once per fixture; it is not part of the unit tests. Run it before changing the skeptic
prompt and after, and after any model change.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any

import build_requests
import dispatch
import hunt
import verdict
from hunt_common import SKILL_DIR, InfraError, load_json, write_json

DEFAULT_FIXTURES = SKILL_DIR.parent.parent.parent / "eval" / "skeptic"


def score(labels: dict[str, str], rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    by_id = {str(r.get("id")): str(r.get("decision")) for r in rows if isinstance(r, dict)}
    out = []
    for tid, label in sorted(labels.items()):
        got = by_id.get(tid, "MISSING")
        if got == label:
            result = "pass"
        elif got == "HELD":
            result = "held"
        else:
            result = "FAIL"
        out.append({"id": tid, "label": label, "decision": got, "result": result})
    return out


def run_fixture(fixture: Path, out: Path) -> dict[str, Any]:
    data = load_json(fixture)
    if not isinstance(data, dict) or not isinstance(data.get("user"), dict) or not isinstance(data.get("labels"), dict):
        raise InfraError(f"{fixture} needs `user` and `labels` objects")
    user: dict[str, Any] = data["user"]
    hdir = out / fixture.stem
    schema = json.loads((SKILL_DIR / "vetted.schema.json").read_text())
    req = build_requests.write_request(hdir / "vet" / "request.json", hunt.SKEPTIC_SYSTEM, user, schema,
                                       hdir / "vet" / "response.json")
    res = dispatch.dispatch(req, hdir=hdir, tag="vet")
    answer = load_json(hdir / "vet" / "response.json")
    rows = [r for r in (answer.get("rows") if isinstance(answer, dict) else None) or [] if isinstance(r, dict)]
    tests = {str(c.get("id")): str(c.get("test_source", "")) for c in user.get("candidates", []) if isinstance(c, dict)}
    for r in rows:
        verdict.check_drop(r, verdict.drop_corpus(user, tests.get(str(r.get("id")), "")))
    scored = score({str(k): str(v) for k, v in data["labels"].items()}, rows)
    return {"fixture": fixture.name, "pr": data.get("pr"), "cost_usd": res.cost_usd, "rows": scored,
            "decisions": [{"id": r.get("id"), "decision": r.get("decision"), "reason_code": r.get("reason_code"),
                           "reason": r.get("reason")} for r in rows]}


def main(argv: list[str]) -> int:
    args = argv[1:]
    out_dir: Path | None = None
    if "--out" in args:
        i = args.index("--out")
        if i + 1 >= len(args):
            print(__doc__)
            return 1
        out_dir = Path(args[i + 1])
        del args[i:i + 2]
    if len(args) > 1 or (args and args[0].startswith("-")):
        print(__doc__)
        return 0 if args and args[0] in ("-h", "--help") else 1
    fixtures_dir = Path(args[0]) if args else DEFAULT_FIXTURES
    fixtures = sorted(fixtures_dir.glob("*.json"))
    if not fixtures:
        print(f"INFRA_ERROR no fixtures in {fixtures_dir}")
        return 2
    out = (out_dir or Path(tempfile.mkdtemp(prefix="skeptic-eval-"))).resolve()
    results = []
    try:
        for f in fixtures:
            results.append(run_fixture(f, out))
    except (InfraError, dispatch.DispatchError) as e:
        print(f"INFRA_ERROR {e}")
        return 2
    rows = [r for res in results for r in res["rows"]]
    totals = {k: sum(r["result"] == k for r in rows) for k in ("pass", "held", "FAIL")}
    card = {"system_prompt_sha": hashlib.sha256(hunt.SKEPTIC_SYSTEM.encode()).hexdigest()[:12],
            "totals": totals, "cost_usd": round(sum(r["cost_usd"] for r in results), 4), "fixtures": results}
    write_json(out / "skeptic_scorecard.json", card)
    print("| fixture | id | label | decision | result |\n|---|---|---|---|---|")
    for res in results:
        for r in res["rows"]:
            print(f"| {res['fixture']} | {r['id'][-60:]} | {r['label']} | {r['decision']} | {r['result']} |")
    print(f"\npass {totals['pass']}, held {totals['held']}, FAIL {totals['FAIL']}; cost ${card['cost_usd']}")
    print(f"scorecard: {out / 'skeptic_scorecard.json'}")
    return 1 if totals["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
