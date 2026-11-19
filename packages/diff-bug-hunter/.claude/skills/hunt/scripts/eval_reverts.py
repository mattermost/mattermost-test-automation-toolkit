#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Score /hunt against real history: commits that were later reverted (known bugs) and clean commits (controls).

usage: eval_reverts.py <manifest.json> [--repo <git dir>] [--out <dir>] [--dispatch '<cmd>'] [--only <id> ...]

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

Scorecard (deterministic for the same responses):
  raw recall          cases with any test failing 3/3 on head / cases
  post-vetting recall cases with a NEW_PR_BUG verdict (fails on head, passes on base) / cases
  false-positive rate controls with a NEW_PR_BUG verdict / controls
Exit 0 PASS (every threshold met, no entry errored), 1 FAIL, 2 invalid manifest or an entry that could not run.
"""
from __future__ import annotations

import atexit as _atexit
import shutil as _shutil
import sys as _sys
import tempfile as _tempfile

# Never load bytecode from the skill directory: a committed __pycache__/*.pyc (an unchecked-hash .pyc, say) would run
# code the trust gate never compares with the reviewed source. Bytecode caches go to a private temp dir instead.
if not _sys.pycache_prefix:
    _sys.pycache_prefix = _tempfile.mkdtemp(prefix="hunt-pyc-")
    _atexit.register(_shutil.rmtree, _sys.pycache_prefix, True)

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import build_requests
import ctx
import prepare
import run
from hunt_common import InfraError, git, write_json

CASE_KEYS = ("id", "bug_sha", "fix_sha", "area", "bug", "source")
CONTROL_KEYS = ("id", "sha", "area")
DEFAULT_THRESHOLDS = {"raw_recall_min": 0.0, "vetted_recall_min": 0.0, "fp_rate_max": 1.0}


class ManifestError(ValueError):
    pass


def load_manifest(path: Path, repo_override: Path | None) -> dict[str, Any]:
    m = json.loads(path.read_text())
    if not m.get("cases") or not isinstance(m["cases"], list):
        raise ManifestError("manifest needs a non-empty cases list")
    controls = m.get("controls") or []
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

    cases, ctrls = [], []
    for e in m["cases"]:
        missing = [k for k in CASE_KEYS if not str(e.get(k, "")).strip()]
        if missing:
            raise ManifestError(f"case {e.get('id')}: missing {missing}")
        repo = repo_of(e)
        bug, fix = git(repo, "rev-parse", f"{e['bug_sha']}^{{commit}}"), git(repo, "rev-parse", f"{e['fix_sha']}^{{commit}}")
        if bug not in git(repo, "log", "-1", "--format=%B", fix):
            raise ManifestError(f"case {e['id']}: fix_sha {fix[:10]} does not say it reverts bug_sha {bug[:10]}")
        cases.append({**e, "repo": repo, "head": bug})
    for e in controls:
        missing = [k for k in CONTROL_KEYS if not str(e.get(k, "")).strip()]
        if missing:
            raise ManifestError(f"control {e.get('id')}: missing {missing}")
        repo = repo_of(e)
        ctrls.append({**e, "repo": repo, "head": git(repo, "rev-parse", f"{e['sha']}^{{commit}}")})
    for e in cases + ctrls:
        if e.get("responses"):
            e["responses"] = (path.parent / e["responses"]).resolve()
    return {"cases": cases, "controls": ctrls, "thresholds": thresholds}


def dispatch(cmd: str, request: Path) -> None:
    req = json.loads(request.read_text())
    p = subprocess.run(f"{cmd} {shlex.quote(str(request))}", shell=True, capture_output=True, text=True, check=False,
                       timeout=3600)
    if p.returncode != 0 or not Path(req["response_path"]).exists():
        raise InfraError(f"dispatch failed for {request} (exit {p.returncode}): {(p.stdout + p.stderr)[-800:]}")


def hunt_entry(e: dict[str, Any], num: int, out: Path, dispatch_cmd: str | None) -> dict[str, Any]:
    """Hunt one commit as if it were PR #num; returns its run and base tables per batch and hunter."""
    repo, head = e["repo"], e["head"]
    base = git(repo, "rev-parse", f"{head}^1")
    message = git(repo, "log", "-1", "--format=%s%x00%b", head).split("\x00", 1)
    meta = {"title": message[0], "body": message[1].strip() if len(message) > 1 else ""}  # never the ground truth
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
        if e.get("responses") and batch == 1:
            shutil.copytree(e["responses"], hdir, dirs_exist_ok=True)
        elif dispatch_cmd:
            build_requests.main(str(num), "hunters")  # writes <hdir>/A and B request.json (hunt_dir(num) == hdir)
            for tag in ("A", "B"):
                dispatch(dispatch_cmd, hdir / tag / "request.json")
        for tag in ("A", "B"):
            if not (hdir / tag / "response.json").exists():
                continue
            row: dict[str, Any] = {"batch": batch, "hunter": tag}
            try:
                row["run"] = run.cmd_run(hdir, state, tag)
                row["base"] = run.cmd_base(hdir, state, tag)
            except run.CompileError as err:
                row["compile_error"] = str(err)[-400:]  # a miss, as in a real hunt that exhausted its repair round
            results.append(row)
        batch += 1
    return {"results": results}


def score(entry: dict[str, Any]) -> tuple[bool, bool]:
    raw = any(v == "FAIL_3_OF_3" for r in entry.get("results", []) for v in r.get("run", {}).values())
    vetted = any(v == "NEW_PR_BUG" for r in entry.get("results", []) for v in r.get("base", {}).values())
    return raw, vetted


def scorecard(manifest: dict[str, Any], hunted: dict[str, dict[str, Any]]) -> dict[str, Any]:
    rows = []
    for kind, entries in (("case", manifest["cases"]), ("control", manifest["controls"])):
        for e in entries:
            h = hunted[e["id"]]
            raw, vetted = score(h)
            rows.append({"kind": kind, "id": e["id"], "area": e["area"], "raw": raw, "vetted": vetted,
                         "error": h.get("error"), "responses": bool(h.get("results"))})
    cases = [r for r in rows if r["kind"] == "case"]
    controls = [r for r in rows if r["kind"] == "control"]

    def ratio(hit: int, n: int) -> float:
        return round(hit / n, 4) if n else 0.0

    metrics = {
        "raw_recall": ratio(sum(r["raw"] for r in cases), len(cases)),
        "vetted_recall": ratio(sum(r["vetted"] for r in cases), len(cases)),
        "fp_rate": ratio(sum(r["vetted"] for r in controls), len(controls)),
        "raw_fp_rate": ratio(sum(r["raw"] for r in controls), len(controls)),
    }
    t = manifest["thresholds"]
    checks = {"raw_recall": metrics["raw_recall"] >= t["raw_recall_min"],
              "vetted_recall": metrics["vetted_recall"] >= t["vetted_recall_min"],
              "fp_rate": metrics["fp_rate"] <= t["fp_rate_max"]}
    errors = [r["id"] for r in rows if r["error"]]
    verdict = "ERROR" if errors else ("PASS" if all(checks.values()) else "FAIL")
    return {"rows": rows, "metrics": metrics, "thresholds": t, "checks": checks, "errors": errors, "verdict": verdict}


def render(card: dict[str, Any]) -> str:
    lines = [f"{'kind':8} {'id':28} {'area':24} raw   vetted"]
    for r in card["rows"]:
        note = f"  ERROR {r['error'][:120]}" if r["error"] else ("" if r["responses"] else "  (no hunter responses)")
        lines.append(f"{r['kind']:8} {r['id']:28} {r['area']:24} {'yes' if r['raw'] else 'no ':5} "
                     f"{'yes' if r['vetted'] else 'no'}{note}")
    m, t, c = card["metrics"], card["thresholds"], card["checks"]
    raw = f"raw recall          {m['raw_recall']:.2f} (min {t['raw_recall_min']:.2f}) {'ok' if c['raw_recall'] else 'BELOW'}"
    vetted = (f"post-vetting recall {m['vetted_recall']:.2f} (min {t['vetted_recall_min']:.2f}) "
              f"{'ok' if c['vetted_recall'] else 'BELOW'}")
    fp = (f"false-positive rate {m['fp_rate']:.2f} (max {t['fp_rate_max']:.2f}) {'ok' if c['fp_rate'] else 'ABOVE'}"
          f"   (raw, before vetting: {m['raw_fp_rate']:.2f})")
    lines += [raw, vetted, fp, f"VERDICT: {card['verdict']}"]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="eval_reverts.py", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("--repo", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dispatch")
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args(argv[1:])
    try:
        manifest = load_manifest(a.manifest.resolve(), a.repo.resolve() if a.repo else None)
    except (ManifestError, InfraError, KeyError, json.JSONDecodeError) as err:
        print(f"INVALID_MANIFEST {err}")
        return 2
    if a.only:
        keep = set(a.only)
        manifest = {**manifest, "cases": [e for e in manifest["cases"] if e["id"] in keep],
                    "controls": [e for e in manifest["controls"] if e["id"] in keep]}
    out = (a.out or Path(_tempfile.mkdtemp(prefix="eval-reverts-"))).resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ["HUNT_SCRATCH"] = str(out)  # hunt_dir(n) == <out>/hunt<n>, so build_requests writes where we read
    hunted: dict[str, dict[str, Any]] = {}
    for num, e in enumerate(manifest["cases"] + manifest["controls"], 1):
        try:
            hunted[e["id"]] = hunt_entry(e, num, out, a.dispatch)
        except InfraError as err:
            hunted[e["id"]] = {"error": str(err).splitlines()[0]}
    card = scorecard(manifest, hunted)
    write_json(out / "scorecard.json", card)
    print(render(card))
    print(f"details: {out}/scorecard.json")
    return {"PASS": 0, "FAIL": 1}.get(card["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
