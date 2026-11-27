#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 3/5: write the blind request.json files for hunters and mutant planters.

usage: build_requests.py <pr> hunters            -> A/, B/
       build_requests.py <pr> diff               -> D/ (differential recorders: no assertions; `run.py diff <pr> D` diffs the
                                                   recorded outputs of the merge-base and the PR head)
       build_requests.py <pr> review             -> R/ (CodeRabbit review-claim verifier; skips writing request if 0 qualifying threads)
       build_requests.py <pr> retry <tag>        -> <tag>/request.retry.json (one retry when a hunter returned empty files: [])
       build_requests.py <pr> mutants            -> M/ (3 visible faults)
       build_requests.py <pr> heldout            -> M2/ (2 held-back faults; needs M/response.json)
       build_requests.py <pr> strengthen <ids>   -> A2/ (needs A/response.json; ids = surviving mutants, e.g. M1,M3)
       build_requests.py <pr> regen <id> <tag>   -> R_<id>/ (one mutant that mutants_<tag>.json marked
                                                   NEEDS_REGENERATION, with that score's compiler error)
       build_requests.py <pr> repair <tag>       -> <tag>/request.repair.json (hunter files that did not compile, with
                                                   compile_<tag>.log; the old response is kept as response.prev.json)
Each request is {tier, system, user, schema, response_path}, plus the same request as text in request*.md (what the agent
reads); dispatch it with ../dispatch.md, one fresh agent each.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import lessons
import reliability
import review_threads
import trusted
from hunt_common import SCHEMA_VERSION, SKILL_DIR, InfraError, hunt_dir, load_json, read_state, write_json

HUNTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["files"],
    "properties": {
        "files": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": {"type": "string", "minLength": 1, "maxLength": 240},
                    "content": {"type": "string", "maxLength": 32000},
                },
            },
        },
        "tests": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "properties": {
                    "test_name": {"type": "string", "maxLength": 200},
                    "source": {"type": "string", "maxLength": 300},
                },
            },
        },
    },
}
REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["files", "claims"],
    "properties": {
        "files": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": {"type": "string", "minLength": 1, "maxLength": 240},
                    "content": {"type": "string", "maxLength": 32000},
                },
            },
        },
        "tests": {
            "type": "array",
            "maxItems": 45,
            "items": {
                "type": "object",
                "properties": {
                    "test_name": {"type": "string", "maxLength": 200},
                    "claim_id": {"type": "string", "maxLength": 40},
                    "source": {"type": "string", "maxLength": 300},
                },
            },
        },
        "claims": {
            "type": "array",
            "maxItems": 15,
            "items": {
                "type": "object",
                "required": ["id", "testable", "tests", "reason"],
                "properties": {
                    "id": {"type": "string", "minLength": 1, "maxLength": 40},
                    "testable": {"type": "boolean"},
                    "tests": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 200}},
                    "reason": {"type": "string", "maxLength": 400},
                },
            },
        },
    },
}
MUTANT_SCHEMA = {"type": "object", "required": ["mutants"], "properties": {"mutants": {"type": "array"}}}

V_SYSTEM = (
    "You are the diagnostic step of a bug hunt. Each candidate below is a test that failed 3 of 3 times on the PR head "
    "and passed on the merge-base. Write exactly one bounded diagnostic test per candidate. It must isolate the root "
    "cause with the smallest input, use only the code given in this request, and assert the merge-base behaviour that "
    "the candidate asserts. Name Go tests TestHuntV_<Name> and Jest tests 'HuntV_<name>' (the title must start with HuntV_), in the same package or "
    "component directory as the candidate. Report only what the test shows, never the PR's intent. Put the tests in "
    "the `files` array and name each in `tests`. Output one JSON object matching the schema, nothing else."
)
SKEPTIC_SYSTEM = (
    "You are the skeptic of a bug hunt. For each candidate, decide KEEP, DROP or HELD. The request gives the PR's "
    "title and description, the production diff, callers of the changed code (an `entry_point: true` caller is an API "
    "route, websocket handler, plugin hook or UI entry), and per candidate the test source, its head failure or "
    "differential examples, and the command that reproduces it. "
    "KEEP when the failure is a behaviour a production user or caller can hit and the PR's description does not ask "
    "for it: name the real caller in `caller`, the entry point in `entry_point` (API route, UI component or screen, "
    "job, plugin hook), the root-cause `file_line` from the diff, and copy the candidate's `repro_cmd`. "
    "DROP when the evidence shows intended behaviour (the description or diff asks for it), a test that asserts the "
    "wrong thing, or input no caller can produce. HELD only when the request lacks something you need to decide; "
    "say what in `reason`. A candidate with mechanical_verdict NEW_API has no merge-base to compare with: KEEP it "
    "only when the failing assertion contradicts the PR's own description or an existing invariant shown in the "
    "diff. Give `reason` in one or two sentences. Copy the candidate's `id` and `source`. Set `evidence_path` to "
    "the artifact the evidence came from, and `fix_check` to null. Output JSON {\"rows\": [...]} matching the "
    "schema, one row per candidate, and nothing else. "
    "Every row also carries `reason_code` and `evidence_quote`, which code checks: KEEP uses BUG. A DROP must use "
    "INTENDED (evidence_quote is copied verbatim from the PR description, the production diff or pr_tests_diff), "
    "UNREACHABLE (evidence_quote names the guard, copied verbatim from the diff or a caller's source) or "
    "WRONG_ASSERTION (evidence_quote is the wrong assertion, copied verbatim from the candidate's test_source). "
    "HELD uses NEEDS_INPUT. A DROP whose quote is not found verbatim is held, not dropped."
)


def prompt_version(skill_dir: Path = SKILL_DIR, schema_version: int = SCHEMA_VERSION) -> str:
    """Deterministic hash of prompts, rules, schemas, driver system prompts, and schema version."""
    h = hashlib.sha256()

    def _read(rel: str) -> str:
        path = skill_dir / rel
        try:
            return trusted.read(rel, skill_dir)
        except InfraError:
            return path.read_text() if path.exists() else ""

    prompts_dir = skill_dir / "prompts"
    names = sorted(p.name for p in prompts_dir.glob("*.md")) if prompts_dir.is_dir() else []
    for name in names:
        h.update(f"prompts/{name}\0".encode())
        h.update(_read(f"prompts/{name}").encode())
        h.update(b"\0")
    for rel in ("RELIABILITY.md", "lessons.jsonl", "vetted.schema.json", "finding.schema.json"):
        h.update(f"{rel}\0".encode())
        h.update(_read(rel).encode())
        h.update(b"\0")
    h.update(json.dumps({"HUNTER_SCHEMA": HUNTER_SCHEMA, "REVIEW_SCHEMA": REVIEW_SCHEMA}, sort_keys=True).encode())
    h.update(b"\0")
    h.update(V_SYSTEM.encode())
    h.update(b"\0")
    h.update(SKEPTIC_SYSTEM.encode())
    h.update(b"\0")
    h.update(str(schema_version).encode())
    return h.hexdigest()[:16]


def prompt(name: str) -> str:
    return trusted.read(f"prompts/{name}.md")


def langs(state: dict[str, Any]) -> list[str]:
    return sorted({t["lang"] for t in state["targets"]})


MAX_LINE = 2000  # longer lines are cut by the agent's file reader, and one line cannot be paged


def _wrap(line: str) -> list[str]:
    return [line[i:i + MAX_LINE] for i in range(0, len(line), MAX_LINE)] or [""]


def render_text(value: Any, level: int = 2) -> str:
    """A request value as plain text with real line breaks: keys become headings, multi-line strings go in fences
    longer than any backtick run inside them, and no line is longer than MAX_LINE (long lines are wrapped, never cut)."""
    if isinstance(value, dict):
        h = "#" * min(level, 6)
        return "\n\n".join(f"{h} {k}\n\n{render_text(v, level + 1)}" for k, v in value.items()) or "{}"
    if isinstance(value, list):
        if all(not isinstance(v, (dict, list)) and not (isinstance(v, str) and "\n" in v) for v in value):
            return "\n".join(line for v in value for line in _wrap(f"- {render_text(v, level)}")) or "[]"
        h = "#" * min(level, 6)
        return "\n\n".join(f"{h} [{i}]\n\n{render_text(v, level + 1)}" for i, v in enumerate(value)) or "[]"
    if isinstance(value, str):
        if "\n" not in value and len(value) <= MAX_LINE:
            return value
        fence = "`" * max(3, max((len(r) for r in re.findall(r"`+", value)), default=0) + 1)
        body = "\n".join(part for line in value.split("\n") for part in _wrap(line))
        return f"{fence}\n{body}\n{fence}"
    return json.dumps(value)


def write_request(path: Path, system: str, user: dict[str, Any], schema: dict[str, Any], response_path: Path,
                  *, tier: str = "sonnet") -> Path:
    """request.json for the scripts, and the same request as text next to it (.md) for the agent that answers it."""
    req = {"tier": tier, "system": system, "user": json.dumps(user, indent=1), "schema": schema,
           "response_path": str(response_path)}
    write_json(path, req)
    text = "\n\n".join([
        "# Request", f"Write one JSON object matching the schema below, and nothing else, to: {response_path}",
        "# System", render_text(system), "# User", render_text(user, 2),
        "# Schema", "```json\n" + json.dumps(schema, indent=1) + "\n```"])
    path.with_suffix(".md").write_text(text + "\n")
    return path


def write(hdir: Path, tag: str, system: str, user: dict[str, Any], schema: dict[str, Any],
          *, tier: str = "sonnet") -> Path:
    return write_request(hdir / tag / "request.json", system, user, schema, hdir / tag / "response.json", tier=tier)


def hunter_system(mode: str, state: dict[str, Any], ctx: dict[str, Any], strategies: bool = False) -> str:
    """System prompt for a hunter. `strategies` adds prompts/strategy_x.md: only first-pass hunters get it, so
    strengthen and repair rounds stay focused on their one job."""
    lang_rules = "".join(prompt(f"lang_{lang}") for lang in langs(state))
    lesson_text = ""
    if not mode.startswith("D"):
        known = lessons.load()
        lesson_text = lessons.render(lessons.match(ctx, known))
        lesson_text += lessons.render_probes(lessons.probes_for(ctx.get("diff_production_code", ""), known))
    common = prompt("common").replace("{lang_rules}", lang_rules).replace("{lessons}", lesson_text)
    rules = reliability.render(reliability.match(ctx)) if mode.startswith("A") else ""
    extra = prompt("strategy_x") if strategies else ""
    if mode == "A" and "go" in langs(state) and os.environ.get("HUNT_FUZZ") != "0":
        extra += prompt("fuzz")  # `run.py run` fuzzes them unless HUNT_FUZZ=0; otherwise the targets would be dead code
    return prompt(f"mode_{mode.lower()}") + rules + extra + common


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


def review_system(targets: list[dict[str, str]], r_ctx: dict[str, Any]) -> str:
    r_langs = sorted({t["lang"] for t in targets})
    lang_rules = "".join(prompt(f"lang_{lang}") for lang in r_langs)
    return prompt("mode_r").replace("{lang_rules}", lang_rules).replace("{lessons}", lessons.render(lessons.match(r_ctx)))


def main(pr: str, what: str, arg: str = "", tag: str = "") -> None:
    hdir = hunt_dir(pr)
    state = read_state(hdir)
    ctx = json.loads((hdir / "ctx.json").read_text())
    if what == "hunters":
        lessons.log_hits(str(pr), lessons.match(ctx))  # input for `lessons.py prune`
        for mode in ("A", "B"):
            print(write(hdir, mode, hunter_system(mode, state, ctx, strategies=True), hunter_user(mode, ctx),
                        HUNTER_SCHEMA))
    elif what == "diff":
        # Mode D gets Mode A's context but no strategies, reliability rules or fuzz rules: a recorder asserts nothing.
        print(write(hdir, "D", hunter_system("D", state, ctx), hunter_user("D", ctx), HUNTER_SCHEMA))
    elif what == "review":
        meta, user = review_threads.build_review_context(pr, hdir, state, ctx)
        if user is None:
            for stale in ("request.json", "request.md"):
                (hdir / "R" / stale).unlink(missing_ok=True)
            reason = meta.get("skipped_reason") or f"0 qualifying CodeRabbit threads ({len(meta.get('skipped', []))} skipped)"
            print(f"[R] {reason}; no request written")
            return
        r_ctx = {"changed_files_head_source": user["thread_files_head_source"],
                 "diff_production_code": user["diff_production_code"],
                 "sibling_tests_and_helpers": user["sibling_tests_and_helpers"]}
        print(write(hdir, "R", review_system(meta["targets"], r_ctx), user, REVIEW_SCHEMA))
    elif what == "retry":
        tag = arg
        if tag.upper() == "R":
            sys.exit("retry is not supported for Mode R: empty files: [] is valid when all threads are untestable")
        prev = hdir / tag / "response.json"
        if not tag or not prev.exists():
            sys.exit(f"{prev} missing: hunter {tag!r} must have written a response first")
        prev_data = load_json(prev)
        if not isinstance(prev_data, dict):
            sys.exit(f"{prev} must be a JSON object")
        if prev_data.get("files"):
            sys.exit(f"{prev} is not empty: retry is only for hunters that returned files: []")
        kept = hdir / tag / "response.prev.json"
        kept.write_text(prev.read_text())
        req_path = hdir / tag / "request.json"
        opus_path = hdir / tag / "request.opus.json"
        tier = "sonnet"
        if opus_path.exists():
            tier = str(json.loads(opus_path.read_text()).get("tier") or "opus")
        if req_path.exists():
            prev_req = json.loads(req_path.read_text())
            system = prev_req["system"] + prompt("retry_empty")
            user = {**json.loads(prev_req["user"]), "previous_response": prev_data}
            schema = prev_req["schema"]
            if not opus_path.exists():
                tier = str(prev_req.get("tier") or "sonnet")
        elif tag.upper() == "R":
            sys.exit(f"{req_path} missing: run `build_requests.py <pr> review` before retrying R")
        else:
            system = hunter_system(tag[0], state, ctx, strategies=True) + prompt("retry_empty")
            user = {**hunter_user(tag, ctx), "previous_response": prev_data}
            schema = HUNTER_SCHEMA
        write_request(hdir / tag / "request.retry.json", system, user, schema, prev, tier=tier)
        print(hdir / tag / "request.retry.json")
    elif what == "mutants":
        print(write(hdir, "M", mutant_system(state, 3, "M1, M2, M3"), mutant_user(ctx), MUTANT_SCHEMA))
    elif what == "heldout":
        planted = load_json(hdir / "M" / "response.json")["mutants"]
        user = {**mutant_user(ctx), "already_planted": planted}
        avoid = " They must differ in location and kind from every fault in `already_planted`."
        print(write(hdir, "M2", mutant_system(state, 2, "M4, M5", avoid), user, MUTANT_SCHEMA))
    elif what == "strengthen":
        survivors = {s.strip() for s in arg.split(",") if s.strip()}
        planted = load_json(hdir / "M" / "response.json")["mutants"]
        user = {**hunter_user("A", ctx), "your_previous_tests": load_json(hdir / "A" / "response.json")["files"],
                "surviving_faults": [m["what_breaks"] for m in planted if m["id"] in survivors]}
        cov = hdir / "run_A.coverage.json"
        if cov.exists():  # from `run.py cover <pr> A`; context for the survivors, never a target on its own
            user["unreached_changed_lines"] = load_json(cov)["unreached"]
        print(write(hdir, "A2", hunter_system("A", state, ctx) + prompt("strengthen"), user, HUNTER_SCHEMA))
    elif what == "regen":
        # Only the score that asked for it: mutants_A.json and mutants_PR.json can hold different attempts and errors.
        scores = hdir / f"mutants_{tag}.json"
        if not tag or not scores.exists():
            sys.exit(f"usage: build_requests.py {pr} regen <id> <tag>, where mutants_<tag>.json exists in {hdir}")
        bad = next((v for v in json.loads(scores.read_text())
                    if v["id"] == arg and v["verdict"] == "NEEDS_REGENERATION"), None)
        if bad is None:
            sys.exit(f"no NEEDS_REGENERATION verdict for {arg} in {scores}")
        user = {**mutant_user(ctx), "previous_attempt": bad["mutant"], "compiler_error": bad["detail"]}
        system = mutant_system(state, 1, arg, " Fix the previous attempt so it compiles and keeps its intent.")
        print(write(hdir, f"R_{arg}", system, user, MUTANT_SCHEMA))
    elif what == "repair":
        tag = arg
        log = hdir / f"compile_{tag}.log"
        if not log.exists():
            sys.exit(f"{log} missing: run.py run {pr} {tag} must have reported COMPILE_ERROR")
        prev = hdir / tag / "response.json"
        kept = hdir / tag / "response.prev.json"
        kept.write_text(prev.read_text())
        req_path = hdir / tag / "request.json"
        opus_path = hdir / tag / "request.opus.json"
        tier = "sonnet"
        if opus_path.exists():
            tier = str(json.loads(opus_path.read_text()).get("tier") or "opus")
        elif req_path.exists():
            tier = str(json.loads(req_path.read_text()).get("tier") or "sonnet")
        if tag == "R":
            if not req_path.exists():
                sys.exit(f"{req_path} missing: run `build_requests.py {pr} review` first")
            prev_req = json.loads(req_path.read_text())
            prev_resp = load_json(kept)
            user = {**json.loads(prev_req["user"]), "your_previous_files": prev_resp["files"],
                    "your_previous_tests": prev_resp.get("tests", []),
                    "your_previous_claims": prev_resp.get("claims", []),
                    "compiler_error": log.read_text()[-4000:]}
            system = prev_req["system"] + prompt("repair")
            schema = prev_req["schema"]
        else:
            user = {**hunter_user(tag, ctx), "your_previous_files": load_json(kept)["files"],
                    "compiler_error": log.read_text()[-4000:]}
            system = hunter_system(tag[0], state, ctx) + prompt("repair")
            schema = HUNTER_SCHEMA
        write_request(hdir / tag / "request.repair.json", system, user, schema, prev, tier=tier)
        print(hdir / tag / "request.repair.json")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    try:
        main(*sys.argv[1:5])
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        sys.exit(2)
