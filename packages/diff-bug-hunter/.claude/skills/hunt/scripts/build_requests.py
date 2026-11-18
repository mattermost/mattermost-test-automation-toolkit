#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 3/5: write the blind request.json files for hunters and mutant planters.

usage: build_requests.py <pr> hunters            -> A/, B/
       build_requests.py <pr> mutants            -> M/ (3 visible faults)
       build_requests.py <pr> heldout            -> M2/ (2 held-back faults; needs M/response.json)
       build_requests.py <pr> strengthen <ids>   -> A2/ (needs A/response.json; ids = surviving mutants, e.g. M1,M3)
       build_requests.py <pr> regen <id>         -> R_<id>/ (one mutant that did not compile, with the compiler error)
Each request is {tier, system, user, schema, response_path}; dispatch it with ../dispatch.md, one fresh agent each.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import lessons
from hunt_common import PROMPTS_DIR, hunt_dir, load_json, read_state, write_json

HUNTER_SCHEMA = {"type": "object", "required": ["files", "tests"],
                 "properties": {"files": {"type": "array"}, "tests": {"type": "array"}}}
MUTANT_SCHEMA = {"type": "object", "required": ["mutants"], "properties": {"mutants": {"type": "array"}}}


def prompt(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text()


def langs(state: dict[str, Any]) -> list[str]:
    return sorted({t["lang"] for t in state["targets"]})


def write(hdir: Path, tag: str, system: str, user: dict[str, Any], schema: dict[str, Any]) -> Path:
    req = {"tier": "opus", "system": system, "user": json.dumps(user, indent=1), "schema": schema,
           "response_path": str(hdir / tag / "response.json")}
    write_json(hdir / tag / "request.json", req)
    return hdir / tag / "request.json"


def hunter_system(mode: str, state: dict[str, Any], ctx: dict[str, Any]) -> str:
    lang_rules = "".join(prompt(f"lang_{lang}") for lang in langs(state))
    common = prompt("common").replace("{lang_rules}", lang_rules).replace("{lessons}", lessons.render(lessons.match(ctx)))
    return prompt(f"mode_{mode.lower()}") + common


def hunter_user(mode: str, ctx: dict[str, Any]) -> dict[str, Any]:
    tag = mode[0].lower()
    u = json.loads(json.dumps(ctx).replace("hunt_hunt<mode>", f"hunt_hunt{tag}").replace("hunt_<mode>", f"hunt_{tag}"))
    return u


def mutant_user(ctx: dict[str, Any]) -> dict[str, Any]:
    # Planters never see tests, callers or the PR description: only what the faults must be planted in.
    return {"pr_title": ctx["pr"]["title"], "diff_production_code": ctx["diff_production_code"],
            "changed_files_head_source": ctx["changed_files_head_source"]}


def mutant_system(state: dict[str, Any], count: int, ids: str, avoid: str = "") -> str:
    lang_name = " / ".join({"go": "valid Go", "jest": "valid TypeScript"}[lang] for lang in langs(state))
    return (prompt("mutants").replace("{count}", str(count)).replace("{ids}", ids)
            .replace("{lang_name}", lang_name).replace("{avoid}", avoid))


def main(pr: str, what: str, arg: str = "") -> None:
    hdir = hunt_dir(pr)
    state = read_state(hdir)
    ctx = json.loads((hdir / "ctx.json").read_text())
    if what == "hunters":
        for mode in ("A", "B"):
            print(write(hdir, mode, hunter_system(mode, state, ctx), hunter_user(mode, ctx), HUNTER_SCHEMA))
    elif what == "mutants":
        print(write(hdir, "M", mutant_system(state, 3, "M1, M2, M3"), mutant_user(ctx), MUTANT_SCHEMA))
    elif what == "heldout":
        planted = load_json(hdir / "M" / "response.json")["mutants"]
        user = {**mutant_user(ctx), "already_planted": planted}
        avoid = " They must differ in location and kind from every fault in `already_planted`."
        print(write(hdir, "M2", mutant_system(state, 2, "M4, M5", avoid), user, MUTANT_SCHEMA))
    elif what == "strengthen":
        survivors = set(arg.split(","))
        planted = load_json(hdir / "M" / "response.json")["mutants"]
        user = {**hunter_user("A", ctx), "your_previous_tests": load_json(hdir / "A" / "response.json")["files"],
                "surviving_faults": [m["what_breaks"] for m in planted if m["id"] in survivors]}
        print(write(hdir, "A2", hunter_system("A", state, ctx) + prompt("strengthen"), user, HUNTER_SCHEMA))
    elif what == "regen":
        verdicts = json.loads((hdir / "mutants_A.json").read_text())
        bad = next(v for v in verdicts if v["id"] == arg)
        user = {**mutant_user(ctx), "previous_attempt": bad["mutant"], "compiler_error": bad["detail"]}
        system = mutant_system(state, 1, arg, " Fix the previous attempt so it compiles and keeps its intent.")
        print(write(hdir, f"R_{arg}", system, user, MUTANT_SCHEMA))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(*sys.argv[1:4])
