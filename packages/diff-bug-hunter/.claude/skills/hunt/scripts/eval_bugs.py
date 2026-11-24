#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Score /hunt against real history: commits that were later reverted, RC hotfixes, and clean controls.

usage: eval_bugs.py <manifest.json> [--repo <git dir>] [--out <dir>] [--dispatch '<cmd>'] [--only <id> ...]
                    [--signals hunters,diff,old,pr,review] [--controls <extra_controls.json>]
                    [--skip-missing] [--validate-only]
       eval_bugs.py diff <baseline_scorecard.json> <candidate_scorecard.json> [--max-fp 0.05]

Manifest (paths are relative to the manifest file):
  {"repo": "<local clone>",            (--repo overrides it; a case may name its own "repo")
   "thresholds": {"raw_recall_min": 0.4, "vetted_recall_min": 0.2, "fp_rate_max": 0.2},
   "cases":    [{"id", "bug_sha", "fix_sha", "area", "bug", "source", "responses"?}],
   "controls": [{"id", "sha", "area", "responses"?}]}
A case's bug_sha is the commit that introduced the bug and fix_sha the commit that reverted it; the manifest is refused
unless fix_sha's message names bug_sha (git revert writes "This reverts commit <sha>"). `bug` is the one-sentence
ground truth, quoted from where `source` says; it is never shown to a hunter, which sees only bug_sha's own commit
message as the PR title and description, exactly as /hunt sees a PR.

Each entry is hunted like a PR: head = the commit, base = its first parent, every prefilter batch, hunters A and B,
3/3 on head (run.py run) and vetting on the base (run.py base). Hunter responses come from the entry's recorded
"responses" directory (batch 1 only) or, with --dispatch, from `<cmd> <request.json>`, which must write the request's
response_path (for example a headless Claude Code call that follows ../dispatch.md).

A hunter's COMPILE_ERROR gets the one repair round of SKILL.md step 4 when --dispatch is set (compile_<tag>.log,
build_requests.py repair, dispatch the request, rerun); still broken is a miss. An InfraError inside one hunter tag
(a target directory with no jest.config, say) is recorded on that tag: the other tag and the other signals still run.

Each entry also runs two model-free signals once: old_tests.py (the base version of every existing test the commit
edits or deletes, run on the commit) and pr_tests.py (the tests the commit itself adds or edits, run as CI would; a
missing pr_tests module is recorded as "signal not available"). --signals picks among hunters, old and pr (default
all). --controls appends the controls mined by mine_controls.py (ids must stay unique).

Signals, per entry:
  hunters_vetted    a NEW_PR_BUG verdict (fails 3/3 on head, passes on base)
  hunters_new_api   a NEW_API verdict (fails on head, cannot compile on base: it calls an API the commit adds)
  old               an OLD_TEST_BREAKS verdict
  old_sometimes     an OLD_TEST_SOMETIMES_BREAKS verdict
  pr_ci             a PR_TEST_FAILS_UNDER_CI verdict (fails with the CI flag, passes without it)
  pr_fails          a PR_TEST_FAILS verdict (fails either way: a broken commit, or this machine lacks something)

Scorecard (deterministic for the same responses):
  raw recall          cases with any test failing 3/3 on head / cases
  post-vetting recall cases with a NEW_PR_BUG verdict / cases
  false-positive rate controls with a NEW_PR_BUG verdict / controls
  <signal> recall/FP  cases / controls where that signal fired, per signal above (new_api, old, old_sometimes, pr_ci, pr_fails)
  combined recall/FP  cases / controls where a finding signal fired: hunters_vetted, old, old_sometimes or pr_ci.
                      new_api and pr_fails need root-causing first, so they are reported but not combined.
The thresholds apply to the hunter metrics (raw, post-vetting, false-positive rate) only. Seconds per entry go to
timings.json, outside the scorecard.
Exit 0 PASS (every threshold met, no entry errored), 1 FAIL, 2 invalid manifest or an entry that could not run.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import argparse
import importlib
import json
import math
import os
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import build_requests
import ctx
import old_tests
import prepare
import review_threads
import run
from hunt_common import InfraError, git, require_disk, write_json

CASE_KEYS = ("id", "bug_sha", "fix_sha", "area", "bug", "source")
NON_REVERT_KEYS = ("id", "bug_sha", "area", "bug", "source")
VALID_KINDS = frozenset({"revert", "rc_hotfix", "fix_forward", "pre_merge_review", "release_range"})
CONTROL_KEYS = ("id", "sha", "area")
DEFAULT_THRESHOLDS = {"raw_recall_min": 0.0, "vetted_recall_min": 0.0, "fp_rate_max": 1.0}
SIGNALS = ("hunters", "diff", "old", "pr")
ALL_SIGNALS = (*SIGNALS, "review")
# per-entry signal flags: (name, results key, verdicts that fire it, the --signals group it belongs to)
FLAGS: tuple[tuple[str, str, frozenset[str], str], ...] = (
    ("hunters_vetted", "base", frozenset({"NEW_PR_BUG"}), "hunters"),
    ("hunters_new_api", "base", frozenset({"NEW_API"}), "hunters"),
    ("diff", "diff", frozenset({"DIFF"}), "diff"),
    ("old", "old", frozenset({"OLD_TEST_BREAKS"}), "old"),
    ("old_sometimes", "old", frozenset({"OLD_TEST_SOMETIMES_BREAKS"}), "old"),
    ("pr_ci", "pr", frozenset({"PR_TEST_FAILS_UNDER_CI"}), "pr"),
    ("pr_fails", "pr", frozenset({"PR_TEST_FAILS"}), "pr"),
    ("review_proven", "review", frozenset({"PROVEN"}), "review"),
)
# metric prefix per flag: hunters_vetted keeps its historical names (vetted_recall, fp_rate)
METRIC_NAMES = {"hunters_new_api": "new_api", "diff": "diff", "old": "old", "old_sometimes": "old_sometimes",
                "pr_ci": "pr_ci", "pr_fails": "pr_fails"}
# signals that count as a finding on their own (combined recall / FP)
FINDINGS = ("hunters_vetted", "old", "old_sometimes", "pr_ci")


class ManifestError(ValueError):
    pass


# What one entry can fail with: our own InfraError, a CompileError that escaped a signal, a dispatch that timed out or
# exited (SubprocessError), a missing or unreadable file (OSError), and a hunter response that is not valid JSON or lacks
# "files" (ValueError, KeyError).
ENTRY_FAILURES = (InfraError, run.CompileError, OSError, subprocess.SubprocessError, KeyError, ValueError)


def load_controls(path: Path) -> list[dict[str, Any]]:
    """Controls mined by mine_controls.py: {\"controls\": [...]} or a bare list."""
    data = json.loads(path.read_text())
    controls = data.get("controls") if isinstance(data, dict) else data
    if not isinstance(controls, list):
        raise ManifestError(f"{path}: expected a controls list")
    return controls


def _resolve_commit(repo: Path, rev: str, skip_missing: bool) -> str | None:
    try:
        if skip_missing:
            return git(repo, "--no-lazy-fetch", "rev-parse", "--verify", f"{rev}^{{commit}}")
        return git(repo, "rev-parse", f"{rev}^{{commit}}")
    except InfraError:
        if skip_missing:
            return None
        raise


def load_manifest(path: Path, repo_override: Path | None,
                  extra_controls: list[dict[str, Any]] | None = None,
                  skip_missing: bool = False) -> dict[str, Any]:
    m = json.loads(path.read_text())
    if not isinstance(m, dict):
        raise ManifestError("manifest must be a JSON object")
    if not m.get("cases") or not isinstance(m["cases"], list):
        raise ManifestError("manifest needs a non-empty cases list")
    controls = (m.get("controls") or []) + (extra_controls or [])
    ids = [e.get("id") for e in m["cases"] + controls]
    if len(ids) != len(set(ids)):
        raise ManifestError("entry ids must be unique")
    thresholds = {**DEFAULT_THRESHOLDS, **(m.get("thresholds") or {})}
    unknown = set(thresholds) - set(DEFAULT_THRESHOLDS)
    if unknown:
        raise ManifestError(f"unknown thresholds {sorted(unknown)}")
    base_repo = repo_override or (Path(m["repo"]) if m.get("repo") else None)

    def repo_of(e: dict[str, Any]) -> Path:
        r = Path(e["repo"]) if e.get("repo") else base_repo
        if r is None:
            raise ManifestError(f"{e.get('id')}: no repo (set manifest repo or --repo)")
        return r if r.is_absolute() else (path.parent / r).resolve()

    cases, ctrls, skipped_missing = [], [], []
    for e in m["cases"]:
        kind = str(e.get("kind", "revert")).strip()
        if kind not in VALID_KINDS:
            raise ManifestError(f"case {e.get('id')}: invalid kind {kind!r}")
        req_keys = CASE_KEYS if kind == "revert" else NON_REVERT_KEYS
        missing = [k for k in req_keys if not str(e.get(k, "")).strip()]
        if missing:
            raise ManifestError(f"case {e.get('id')}: missing {missing}")
        repo = repo_of(e)
        bug = _resolve_commit(repo, e["bug_sha"], skip_missing)
        if bug is None:
            skipped_missing.append(str(e["id"]))
            continue
        resolved_base: str | None = None
        if e.get("base_sha"):
            resolved_base = _resolve_commit(repo, e["base_sha"], skip_missing)
            if resolved_base is None:
                skipped_missing.append(str(e["id"]))
                continue
        if kind == "revert":
            fix = _resolve_commit(repo, e["fix_sha"], skip_missing)
            if fix is None:
                skipped_missing.append(str(e["id"]))
                continue
            if bug not in git(repo, "log", "-1", "--format=%B", fix):
                raise ManifestError(f"case {e['id']}: fix_sha {fix[:10]} does not say it reverts bug_sha {bug[:10]}")
        elif e.get("fix_sha"):
            fix_res = _resolve_commit(repo, e["fix_sha"], skip_missing)
            if fix_res is None:
                skipped_missing.append(str(e["id"]))
                continue
        entry = {**e, "kind": kind, "repo": repo, "head": bug}
        if resolved_base:
            entry["base_sha"] = resolved_base
        cases.append(entry)
    for e in controls:
        missing = [k for k in CONTROL_KEYS if not str(e.get(k, "")).strip()]
        if missing:
            raise ManifestError(f"control {e.get('id')}: missing {missing}")
        repo = repo_of(e)
        head = _resolve_commit(repo, e["sha"], skip_missing)
        if head is None:
            skipped_missing.append(str(e["id"]))
            continue
        resolved_base = None
        if e.get("base_sha"):
            resolved_base = _resolve_commit(repo, e["base_sha"], skip_missing)
            if resolved_base is None:
                skipped_missing.append(str(e["id"]))
                continue
        entry = {**e, "repo": repo, "head": head}
        if resolved_base:
            entry["base_sha"] = resolved_base
        ctrls.append(entry)
    for e in cases + ctrls:
        if e.get("responses"):
            e["responses"] = (path.parent / e["responses"]).resolve()
            if not e["responses"].is_dir():
                raise ManifestError(f"{e['id']}: responses directory {e['responses']} does not exist")
        if e.get("mode_r_threads"):
            tp = (path.parent / e["mode_r_threads"]).resolve()
            if not tp.is_file():
                raise ManifestError(f"{e['id']}: mode_r_threads file {tp} does not exist")
            e["mode_r_threads"] = tp
    return {"cases": cases, "controls": ctrls, "thresholds": thresholds, "skipped_missing": skipped_missing}


def dispatch(cmd: str, request: Path) -> None:
    req = json.loads(request.read_text())
    p = subprocess.run(f"{cmd} {shlex.quote(str(request))}", shell=True, capture_output=True, text=True, check=False,
                       timeout=3600)
    if p.returncode != 0 or not Path(req["response_path"]).exists():
        raise InfraError(f"dispatch failed for {request} (exit {p.returncode}): {(p.stdout + p.stderr)[-800:]}")


def _attempt(hdir: Path, state: dict[str, Any], tag: str, row: dict[str, Any]) -> None:
    row["run"] = run.cmd_run(hdir, state, tag)
    row["base"] = run.cmd_base(hdir, state, tag)


def _repair(num: int, hdir: Path, tag: str, err: run.CompileError, dispatch_cmd: str) -> None:
    """SKILL.md step 4's one repair round: what run.py main() writes on COMPILE_ERROR, then build_requests.py repair, then
    one dispatch of the repair request. The old response goes away first so a dispatch that writes nothing fails."""
    (hdir / f"compile_{tag}.log").write_text(str(err))
    build_requests.main(str(num), "repair", tag)  # keeps the old response as response.prev.json
    response = hdir / tag / "response.json"
    response.unlink()
    try:
        dispatch(dispatch_cmd, hdir / tag / "request.repair.json")
    except (InfraError, subprocess.TimeoutExpired):
        response.write_text((hdir / tag / "response.prev.json").read_text())  # the first response stays the record
        raise


def hunt_tag(num: int, hdir: Path, state: dict[str, Any], tag: str, batch: int, dispatch_cmd: str | None) -> dict[str, Any]:
    """One hunter's run and base tables. Its own failures stay on its row: a compile error is a miss (as in a real hunt
    that exhausted its repair round), an InfraError loses only this hunter."""
    row: dict[str, Any] = {"batch": batch, "hunter": tag}
    try:
        try:
            _attempt(hdir, state, tag, row)
        except run.CompileError as err:
            if not dispatch_cmd:
                raise
            row.pop("run", None)
            row["repaired"] = True
            _repair(num, hdir, tag, err, dispatch_cmd)
            _attempt(hdir, state, tag, row)
    except run.CompileError as err:
        row.pop("run", None)
        row.pop("base", None)
        row["compile_error"] = str(err)[-400:]
    except InfraError as err:
        row.pop("base", None)
        row["error"] = str(err)[-400:]
    return row


def hunt_diff(num: int, hdir: Path, state: dict[str, Any], batch: int, dispatch_cmd: str | None) -> dict[str, Any]:
    """Mode D differential recorders for one batch, with the same 1-round repair and per-hunter isolation."""
    row: dict[str, Any] = {"batch": batch, "hunter": "D"}
    try:
        try:
            row["diff"] = run.cmd_diff(hdir, state, "D")
        except run.CompileError as err:
            if not dispatch_cmd:
                raise
            row["repaired"] = True
            _repair(num, hdir, "D", err, dispatch_cmd)
            row["diff"] = run.cmd_diff(hdir, state, "D")
    except run.CompileError as err:
        row.pop("diff", None)
        row["compile_error"] = str(err)[-400:]
    except InfraError as err:
        row.pop("diff", None)
        row["error"] = str(err)[-400:]
    return row


def old_signal(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
    try:
        return {"hunter": "OLD", "old": old_tests.cmd_old(hdir, state)["tests"]}
    except (InfraError, run.CompileError) as err:  # the other signals' results stand; only this check is lost
        return {"hunter": "OLD", "old": {}, "old_error": str(err)[-400:]}


def pr_signal(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
    try:
        pr_tests = importlib.import_module("pr_tests")  # built by another module: absent is "not available", not a crash
    except ImportError as err:
        return {"hunter": "PR", "pr": {}, "pr_error": f"signal not available: {err}"}
    try:
        return {"hunter": "PR", "pr": pr_tests.cmd_pr(hdir, state)["tests"]}
    except InfraError as err:
        return {"hunter": "PR", "pr": {}, "pr_error": str(err)[-400:]}


def review_signal(num: int, hdir: Path, state: dict[str, Any], meta: dict[str, Any],
                  e: dict[str, Any], dispatch_cmd: str | None) -> dict[str, Any]:
    if not (hdir / "R" / "threads.json").exists():
        if not e.get("mode_r_threads"):
            return {"hunter": "R", "review": {}}
        raw = json.loads(Path(e["mode_r_threads"]).read_text())
        if not isinstance(raw, list):
            raise ManifestError(f"{e['id']}: mode_r_threads must hold a JSON array of GraphQL thread nodes")
        pr_num = int(e.get("pr") or num)
        ctx_stub = {"pr": {"number": pr_num, "title": meta["title"], "description": meta["body"]}}
        r_meta, user = review_threads.build_review_context(str(pr_num), hdir, state, ctx_stub, raw_threads=raw)
        if user is not None and dispatch_cmd and not (hdir / "R" / "response.json").exists():
            r_ctx = {"changed_files_head_source": user["thread_files_head_source"],
                     "diff_production_code": user["diff_production_code"],
                     "sibling_tests_and_helpers": user["sibling_tests_and_helpers"]}
            build_requests.write(hdir, "R", build_requests.review_system(r_meta["targets"], r_ctx),
                                 user, build_requests.REVIEW_SCHEMA)
            dispatch(dispatch_cmd, hdir / "R" / "request.json")
    if not (hdir / "R" / "response.json").exists():
        return {"hunter": "R", "review": {}}
    row = hunt_tag(num, hdir, state, "R", 1, dispatch_cmd)
    if "run" in row:
        row["review_run"] = row.pop("run")
    if "base" in row:
        row["review_base"] = row.pop("base")
    verdicts = review_threads.compute_verdicts(hdir).get("verdicts", {})
    row["review"] = {cid: v.get("verdict", "") for cid, v in verdicts.items() if isinstance(v, dict)}
    return row


def hunt_entry(e: dict[str, Any], num: int, out: Path, dispatch_cmd: str | None,
               signals: tuple[str, ...] = SIGNALS) -> dict[str, Any]:
    """Hunt one commit as if it were PR #num; returns its run and base tables per batch and hunter, then the model-free
    signals (old tests, the PR's own tests). Only a failure to prepare or read an entry raises."""
    repo, head = e["repo"], e["head"]
    base = str(e.get("base_sha") or git(repo, "rev-parse", f"{head}^1"))
    message = git(repo, "log", "-1", "--format=%s%x00%b", head).split("\x00", 1)
    meta = {"title": message[0], "body": message[1].strip() if len(message) > 1 else ""}  # never the ground truth
    require_disk(out)  # same gate as prepare.py: no worktrees or npm ci on a nearly full disk
    wt, wt_base, hdir = out / f"wt{num}", out / f"wt{num}.base", out / f"hunt{num}"
    mb = prepare.worktrees(repo, head, base, wt, wt_base)
    prepare.deps(repo, wt, wt_base, mb, head)
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb, "head": head,
            "hunt_dir": str(hdir)}
    results: list[dict[str, Any]] = []
    batch, batches = 1, 1
    while batch <= batches:
        state = ctx.build(str(num), batch, prep, meta)
        batches = state["batches"]
        if "hunters" in signals or "diff" in signals or "review" in signals:
            if e.get("responses") and batch == 1:
                shutil.copytree(e["responses"], hdir, dirs_exist_ok=True)
            if "hunters" in signals:
                if not (e.get("responses") and batch == 1) and dispatch_cmd:
                    build_requests.main(str(num), "hunters")  # writes <hdir>/A and B request.json
                    for tag in ("A", "B"):
                        dispatch(dispatch_cmd, hdir / tag / "request.json")
                for tag in ("A", "B"):
                    if (hdir / tag / "response.json").exists():
                        results.append(hunt_tag(num, hdir, state, tag, batch, dispatch_cmd))
            if "diff" in signals:
                if not (e.get("responses") and batch == 1) and dispatch_cmd:
                    build_requests.main(str(num), "diff")
                    dispatch(dispatch_cmd, hdir / "D" / "request.json")
                if (hdir / "D" / "response.json").exists():
                    results.append(hunt_diff(num, hdir, state, batch, dispatch_cmd))
        else:
            batches = 1  # the whole-commit signals need only the state, not one per batch
        batch += 1
    if "review" in signals:
        results.append(review_signal(num, hdir, state, meta, e, dispatch_cmd))
    # whole-commit, model-free: once per entry, after every batch (each run leaves the worktrees clean)
    if "old" in signals:
        results.append(old_signal(hdir, state))
    if "pr" in signals:
        results.append(pr_signal(hdir, state))
    return {"results": results}


def score(entry: dict[str, Any]) -> tuple[bool, bool]:
    raw = any(v == "FAIL_3_OF_3" for r in entry.get("results", []) for v in r.get("run", {}).values())
    vetted = any(v == "NEW_PR_BUG" for r in entry.get("results", []) for v in r.get("base", {}).values())
    return raw, vetted


def flags(entry: dict[str, Any], signals: tuple[str, ...] = SIGNALS) -> dict[str, bool]:
    """Which signals fired for one entry: any table of that kind holding one of the signal's verdicts."""
    results = entry.get("results", [])
    return {
        name: group in signals and any(
            isinstance(v, str) and v in verdicts
            for r in results
            for k, v in (r.get(key) or {}).items()
            if k not in ("*", "detail", "new_api")
        )
        for name, key, verdicts, group in FLAGS
    }


def _first(entry: dict[str, Any], key: str) -> str | None:
    return next((r[key] for r in entry.get("results", []) if r.get(key)), None)


def scorecard(manifest: dict[str, Any], hunted: dict[str, dict[str, Any]],
              signals: tuple[str, ...] = SIGNALS) -> dict[str, Any]:
    rows = []
    for kind, entries in (("case", manifest["cases"]), ("control", manifest["controls"])):
        for e in entries:
            h = hunted[e["id"]]
            raw, _ = score(h)
            f = flags(h, signals)
            tag_errors = [f"{r['hunter']}: {r['error']}" for r in h.get("results", []) if r.get("error")]
            rows.append({"kind": kind, "id": e["id"], "area": e["area"], "lock": bool(e.get("lock")),
                         "raw": raw and "hunters" in signals,
                         "vetted": f["hunters_vetted"], **f, "any": any(f[k] for k in FINDINGS),
                         "error": h.get("error"), "old_error": _first(h, "old_error"), "pr_error": _first(h, "pr_error"),
                         "hunter_errors": tag_errors,
                         "responses": any(r.get("hunter") in ("A", "B") for r in h.get("results", []))})
    cases = [r for r in rows if r["kind"] == "case"]
    controls = [r for r in rows if r["kind"] == "control"]

    def ratio(hit: int, n: int) -> float:
        return round(hit / n, 4) if n else 0.0

    metrics = {
        "raw_recall": ratio(sum(r["raw"] for r in cases), len(cases)),
        "vetted_recall": ratio(sum(r["vetted"] for r in cases), len(cases)),
        "fp_rate": ratio(sum(r["vetted"] for r in controls), len(controls)),
        "raw_fp_rate": ratio(sum(r["raw"] for r in controls), len(controls)),
        "combined_recall": ratio(sum(r["any"] for r in cases), len(cases)),
        "combined_fp_rate": ratio(sum(r["any"] for r in controls), len(controls)),
    }
    for flag, name in METRIC_NAMES.items():
        metrics[f"{name}_recall"] = ratio(sum(r[flag] for r in cases), len(cases))
        metrics[f"{name}_fp_rate"] = ratio(sum(r[flag] for r in controls), len(controls))
    if "review" in signals:
        metrics["review_recall"] = ratio(sum(r["review_proven"] for r in cases), len(cases))
        metrics["review_fp_rate"] = ratio(sum(r["review_proven"] for r in controls), len(controls))
    t = manifest["thresholds"]
    checks = {"raw_recall": metrics["raw_recall"] >= t["raw_recall_min"],
              "vetted_recall": metrics["vetted_recall"] >= t["vetted_recall_min"],
              "fp_rate": metrics["fp_rate"] <= t["fp_rate_max"]}
    errors = [r["id"] for r in rows if r["error"]]
    verdict = "ERROR" if errors else ("PASS" if all(checks.values()) else "FAIL")
    locked = [r for r in cases if r["lock"]]
    locks_missed = [r["id"] for r in locked if not (r["vetted"] or r["hunters_new_api"] or r.get("review_proven"))]
    summary = {
        "vetted_plus_new_api_recall": ratio(sum(r["vetted"] or r["hunters_new_api"] for r in cases), len(cases)),
        "hunter_only_fp_rate": ratio(sum(r["vetted"] for r in controls), len(controls)),
        "locks_total": len(locked),
        "locks_passed": len(locked) - len(locks_missed),
        "locks_missed": locks_missed,
        "skipped_missing": manifest.get("skipped_missing", []),
    }
    return {"rows": rows, "metrics": metrics, "summary": summary, "thresholds": t, "checks": checks,
            "errors": errors, "verdict": verdict, "signals": list(signals),
            "cases": len(cases), "controls": len(controls)}


def render(card: dict[str, Any]) -> str:
    signals = card.get("signals", list(SIGNALS))
    cols: list[tuple[str, str]] = [
        ("raw", "hunters"), ("vetted", "hunters"), ("new_api", "hunters"), ("diff", "diff"), ("old", "old"),
        ("old~", "old"), ("pr_ci", "pr"),
    ]
    if "review" in signals:
        cols.append(("review", "review"))
    keys = {"raw": "raw", "vetted": "hunters_vetted", "new_api": "hunters_new_api", "diff": "diff", "old": "old",
            "old~": "old_sometimes", "pr_ci": "pr_ci", "review": "review_proven"}

    def cell(r: dict[str, Any], col: str, group: str) -> str:
        return "-" if group not in signals else ("yes" if r.get(keys[col]) else "no")

    lines = [f"{'kind':8} {'id':28} {'area':24} " + " ".join(f"{c:7}" for c, _ in cols)]
    for r in card["rows"]:
        notes = []
        if r["error"]:
            notes.append(f"ERROR {r['error'][:120]}")
        elif "hunters" in signals and not r["responses"]:
            notes.append("(no hunter responses)")
        notes += [f"hunter {e[:100]} ERROR" for e in r.get("hunter_errors", [])]
        if r.get("old_error"):
            notes.append(f"old-tests ERROR {r['old_error'][:80]}")
        if r.get("pr_error"):
            notes.append(f"pr-tests ERROR {r['pr_error'][:80]}")
        lines.append(f"{r['kind']:8} {r['id']:28} {r['area']:24} " + " ".join(f"{cell(r, c, g):7}" for c, g in cols)
                     + ("  " + "; ".join(notes) if notes else ""))
    m, t, c = card["metrics"], card["thresholds"], card["checks"]
    lines.append(f"raw recall          {m['raw_recall']:.2f} (min {t['raw_recall_min']:.2f}) "
                 f"{'ok' if c['raw_recall'] else 'BELOW'}")
    lines.append(f"post-vetting recall {m['vetted_recall']:.2f} (min {t['vetted_recall_min']:.2f}) "
                 f"{'ok' if c['vetted_recall'] else 'BELOW'}")
    lines.append(f"false-positive rate {m['fp_rate']:.2f} (max {t['fp_rate_max']:.2f}) "
                 f"{'ok' if c['fp_rate'] else 'ABOVE'}   (raw, before vetting: {m['raw_fp_rate']:.2f})")
    lines.append(f"{'signal':18} recall   fp-rate  ({card.get('cases', '?')} cases, {card.get('controls', '?')} controls)")
    table: list[tuple[str, str, str | None]] = [
        ("hunters vetted", "vetted", "hunters"), ("hunters new-api", "new_api", "hunters"),
        ("diff (Mode D)", "diff", "diff"),
        ("old tests", "old", "old"), ("old tests ~", "old_sometimes", "old"), ("pr tests (ci)", "pr_ci", "pr"),
        ("pr tests (fail)", "pr_fails", "pr"),
    ]
    if "review" in signals:
        table.append(("review (Mode R)", "review", "review"))
    table.append(("combined (any)", "combined", None))
    for label, name, group in table:
        if group is not None and group not in signals:
            lines.append(f"{label:18} off")
        else:
            rec = m["vetted_recall" if name == "vetted" else f"{name}_recall"]
            fp = m["fp_rate" if name == "vetted" else f"{name}_fp_rate"]
            lines.append(f"{label:18} {rec:<8.2f} {fp:.2f}")
    lines.append(f"VERDICT: {card['verdict']}")
    return "\n".join(lines)


def diff_scorecards(base: dict[str, Any], cand: dict[str, Any], max_fp: float = 0.05) -> dict[str, Any]:
    """Monotonic gate comparing a candidate scorecard against a baseline."""
    def _num(d: dict[str, Any], key: str) -> float:
        raw = d[key]
        if isinstance(raw, bool):
            raise TypeError(f"{key} must be numeric, not bool")
        val = float(raw)
        if not math.isfinite(val):
            raise ValueError(f"{key} must be finite")
        return val

    bm, cm = base["metrics"], cand["metrics"]
    b_rows = {r["id"]: r for r in base.get("rows", []) if r.get("kind") == "case"}
    c_rows = {r["id"]: r for r in cand.get("rows", []) if r.get("kind") == "case"}
    b_ctrls = {r["id"] for r in base.get("rows", []) if r.get("kind") == "control"}
    c_ctrls = {r["id"] for r in cand.get("rows", []) if r.get("kind") == "control"}
    population_ok = (set(b_rows) == set(c_rows)) and (b_ctrls == c_ctrls)

    def caught(r: dict[str, Any]) -> bool:
        return bool(r.get("vetted") or r.get("hunters_new_api") or r.get("review_proven"))

    lock_regressions = sorted(
        cid for cid, br in b_rows.items()
        if (br.get("lock") or c_rows.get(cid, {}).get("lock")) and caught(br)
        and (cid not in c_rows or not caught(c_rows[cid]))
    )
    base_recall, cand_recall = _num(bm, "vetted_recall"), _num(cm, "vetted_recall")
    base_fp, cand_fp = _num(bm, "fp_rate"), _num(cm, "fp_rate")
    cand_ok = not cand.get("errors") and cand.get("verdict") != "ERROR"
    recall_ok = cand_recall >= base_recall
    fp_limit = max(max_fp, base_fp)
    fp_ok = cand_fp <= fp_limit
    passed = cand_ok and population_ok and recall_ok and fp_ok and not lock_regressions
    return {
        "verdict": "PASS" if passed else "FAIL",
        "cand_ok": cand_ok,
        "population_ok": population_ok,
        "recall_ok": recall_ok,
        "fp_ok": fp_ok,
        "fp_limit": fp_limit,
        "base_vetted_recall": base_recall,
        "cand_vetted_recall": cand_recall,
        "base_fp_rate": base_fp,
        "cand_fp_rate": cand_fp,
        "lock_regressions": lock_regressions,
    }


def _cmd_diff(args: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="eval_bugs.py diff")
    ap.add_argument("baseline", type=Path)
    ap.add_argument("candidate", type=Path)
    ap.add_argument("--max-fp", type=float, default=0.05)
    ns = ap.parse_args(args)
    try:
        base = json.loads(ns.baseline.read_text())
        cand = json.loads(ns.candidate.read_text())
        res = diff_scorecards(base, cand, max_fp=ns.max_fp)
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as err:
        print(f"INVALID_SCORECARD {err}")
        return 2
    print(f"vetted_recall: {res['base_vetted_recall']:.4f} -> {res['cand_vetted_recall']:.4f} "
          f"({'ok' if res['recall_ok'] else 'REGRESSED'})")
    print(f"fp_rate:       {res['base_fp_rate']:.4f} -> {res['cand_fp_rate']:.4f} "
          f"(limit {res['fp_limit']:.4f}, {'ok' if res['fp_ok'] else 'EXCEEDED'})")
    print(f"lock_regressions: {res['lock_regressions']}")
    print(f"VERDICT: {res['verdict']}")
    return 0 if res["verdict"] == "PASS" else 1


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    if len(argv) >= 2 and argv[1] == "diff":
        return _cmd_diff(argv[2:])
    ap = argparse.ArgumentParser(prog="eval_bugs.py", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("--repo", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dispatch")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--signals", default=",".join(SIGNALS), help="comma list of hunters,diff,old,pr,review")
    ap.add_argument("--controls", type=Path, help="extra controls (mine_controls.py output), appended to the manifest's")
    ap.add_argument("--skip-missing", action="store_true", help="skip entries whose commit SHAs are absent in --repo")
    ap.add_argument("--validate-only", action="store_true", help="validate manifest/SHAs against --repo and exit")
    a = ap.parse_args(argv[1:])
    signals = tuple(x for x in ALL_SIGNALS if x in {w.strip() for w in a.signals.split(",")})
    unknown = {w.strip() for w in a.signals.split(",")} - set(ALL_SIGNALS)
    if unknown or not signals:
        print(f"INVALID_SIGNALS {a.signals!r}: choose from {','.join(ALL_SIGNALS)}")
        return 2
    try:
        extra = load_controls(a.controls.resolve()) if a.controls else None
        manifest = load_manifest(a.manifest.resolve(), a.repo.resolve() if a.repo else None, extra,
                                 skip_missing=a.skip_missing)
    except (ManifestError, InfraError, OSError, KeyError, json.JSONDecodeError) as err:
        print(f"INVALID_MANIFEST {err}")
        return 2
    if a.only:
        keep = set(a.only)
        manifest = {**manifest, "cases": [e for e in manifest["cases"] if e["id"] in keep],
                    "controls": [e for e in manifest["controls"] if e["id"] in keep]}
    if a.validate_only:
        print(f"VALID_MANIFEST cases={len(manifest['cases'])} controls={len(manifest['controls'])} "
              f"skipped_missing={len(manifest['skipped_missing'])}")
        return 0
    if not (manifest["cases"] or manifest["controls"]):
        print("INVALID_MANIFEST no entries selected after filtering")
        return 2
    out = (a.out or Path(tempfile.mkdtemp(prefix="eval-bugs-"))).resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ["HUNT_SCRATCH"] = str(out)  # hunt_dir(n) == <out>/hunt<n>, so build_requests writes where we read
    hunted: dict[str, dict[str, Any]] = {}
    timings: dict[str, float] = {}
    for num, e in enumerate(manifest["cases"] + manifest["controls"], 1):
        start = time.monotonic()
        try:
            hunted[e["id"]] = hunt_entry(e, num, out, a.dispatch, signals)
        except ENTRY_FAILURES as err:
            # an ERROR verdict (exit 2): the entry could not run, which is not the same as a miss or a clean result
            hunted[e["id"]] = {"error": f"{type(err).__name__}: {str(err).splitlines()[0] if str(err) else 'no detail'}"}
        timings[e["id"]] = round(time.monotonic() - start, 1)
        write_json(out / "timings.json", timings)  # each entry as it ends: a long run can be followed
        write_json(out / f"entry_{num}_{e['id']}.json", hunted[e["id"]])
    card = scorecard(manifest, hunted, signals)
    write_json(out / "scorecard.json", card)
    print(render(card))
    print(f"details: {out}/scorecard.json")
    return {"PASS": 0, "FAIL": 1}.get(card["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
