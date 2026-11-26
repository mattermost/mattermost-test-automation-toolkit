#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 7b: persist per-hunt telemetry and export Mode R false-negative bundles for self-improvement.

usage: ledger.py record <pr> [--out <path>]   append one compact JSONL telemetry line (+ export escapes)
       ledger.py escapes [--ledger <path>]    list exported Mode R false-negative bundles
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hunt_common import InfraError, hunt_dir, load_json, read_state, scratch, target_key, under, write_json
from verdict import admissibility
from verdicts import Verdict

_BAD_RUN = frozenset({Verdict.FLAKY, Verdict.SKIP, "(package failed)"})
_BAD_BASE = frozenset({Verdict.NEW_API, Verdict.BASE_UNCOMPILABLE, Verdict.BASE_FAILS_DIFFERENTLY, Verdict.NOT_RUN_ON_BASE, Verdict.UNVETTED})
_BAD_DIFF = frozenset({Verdict.RECORDER_FAILED, Verdict.BASE_FAILED, Verdict.BASE_UNCOMPILABLE, Verdict.NO_RECORDS, Verdict.NONDETERMINISTIC})


def ledger_path(override: Path | None = None) -> Path:
    if override is not None:
        return override.resolve()
    env = os.environ.get("HUNT_LEDGER", "").strip()
    return Path(env).resolve() if env else scratch() / "hunt_ledger.jsonl"


def _read_optional_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _read_optional_dict(path: Path) -> dict[str, Any]:
    data = _read_optional_json(path)
    return data if isinstance(data, dict) else {}


def _batch_sort_key(path: Path) -> tuple[int, int, int, str]:
    suffix = path.name.removeprefix("batch_")
    parts = suffix.split(".", 1)
    if parts[0].isdigit() and (len(parts) == 1 or parts[1].isdigit()):
        return (0, int(parts[0]), int(parts[1]) if len(parts) > 1 else 0, path.name)
    return (1, 0, 0, path.name)


def _batch_dirs(hdir: Path) -> list[Path]:
    dirs: list[Path] = []
    broot = hdir / "batches"
    if broot.is_dir():
        dirs.extend(sorted((p for p in broot.iterdir() if p.is_dir() and p.name.startswith("batch_")),
                           key=_batch_sort_key))
    dirs.append(hdir)
    return dirs


def _read_verdict_json(bdir: Path) -> dict[str, Any] | None:
    vpath = bdir / "verdict.json"
    if not vpath.is_file():
        return None
    data = _read_optional_dict(vpath)
    keep, held = data.get("keep"), data.get("held")
    if not (isinstance(keep, list) or isinstance(held, list)):
        return None
    if keep is not None and not isinstance(keep, list):
        return None
    if held is not None and not isinstance(held, list):
        return None
    keep_rows = keep if isinstance(keep, list) else []
    held_rows = held if isinstance(held, list) else []
    if not all(isinstance(r, dict) for r in keep_rows):
        return None
    if not all(isinstance(h, dict) and isinstance(h.get("row"), dict) for h in held_rows):
        return None
    return {"keep": keep_rows, "held": held_rows}


def _batch_verdicts(bdir: Path, root: Path, *, require_verdict_json: bool = False) -> dict[str, Any]:
    """Post-lesson verdict.json when valid; active batch may fall back to admissibility() for ledger tiering."""
    data = _read_verdict_json(bdir)
    if data is not None:
        return data
    if require_verdict_json or bdir != root:
        return {"keep": [], "held": []}
    return admissibility(bdir)


def _batch_has_raw_bug(bdir: Path) -> bool:
    for tag in ("A", "A2", "B"):
        base_data = _read_optional_json(bdir / f"base_{tag}.json")
        if isinstance(base_data, dict) and any(
            k not in ("*", "detail", "new_api") and v == Verdict.NEW_PR_BUG
            for k, v in base_data.items()
        ):
            return True
    diff_data = _read_optional_json(bdir / "diff_D.json")
    return isinstance(diff_data, dict) and any(v == Verdict.DIFF for v in diff_data.values())


def _batch_is_vetted(bdir: Path, root: Path) -> bool:
    if _read_verdict_json(bdir) is not None:
        return True
    return bdir == root and (bdir / "vetted.json").is_file()


def resolved_verdicts(hdir: Path, *, require_verdict_json: bool = False) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Resolve kept and held/dropped rows across archived batches and the active batch.

    Batches are walked in numeric order (oldest -> newest -> active hdir), so later batches
    supersede earlier decisions for the same (source, id) while unrelated archived findings remain.
    """
    by_key: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
    anon_keep: list[dict[str, Any]] = []
    anon_held: list[dict[str, Any]] = []
    for bdir in _batch_dirs(hdir):
        adm = _batch_verdicts(bdir, root=hdir, require_verdict_json=require_verdict_json)
        for r in adm.get("keep", []):
            if not isinstance(r, dict):
                continue
            rid = str(r.get("id", ""))
            if rid:
                by_key[(str(r.get("source", "")), rid)] = ("keep", r)
            else:
                anon_keep.append(r)
        for h in adm.get("held", []):
            if not isinstance(h, dict):
                continue
            raw_row = h.get("row")
            row = raw_row if isinstance(raw_row, dict) else {}
            rid = str(row.get("id", ""))
            if rid:
                by_key[(str(row.get("source", "")), rid)] = ("held", h)
            else:
                anon_held.append(h)
    keep = [item for kind, item in by_key.values() if kind == "keep"] + anon_keep
    not_kept = [item for kind, item in by_key.values() if kind == "held"] + anon_held
    return keep, not_kept


def _aggregate_modes(hdir: Path) -> tuple[dict[str, int], dict[str, set[str]], int, int, bool]:
    counts: dict[str, int] = {
        "pass": 0, "fail_3_of_3": 0, "new_pr_bug": 0, "new_api": 0,
        "pre_existing": 0, "diff": 0, "mode_a_empty": 0,
    }
    caught_by_tag: dict[str, set[str]] = {"A": set(), "A2": set(), "B": set()}
    reached_sum = 0
    exec_sum = 0
    mode_gaps = False

    for bdir in _batch_dirs(hdir):
        for tag in ("A", "A2", "B"):
            resp = _read_optional_dict(bdir / tag / "response.json")
            empty_resp = resp.get("files") == []
            if tag == "A" and empty_resp:
                counts["mode_a_empty"] += 1
            if empty_resp:
                mode_gaps = True

            run_data = _read_optional_json(bdir / f"run_{tag}.json")
            head_fails: set[str] = set()
            if isinstance(run_data, dict):
                for k, v in run_data.items():
                    if v == Verdict.PASS:
                        counts["pass"] += 1
                    elif v == Verdict.FAIL_3_OF_3:
                        counts["fail_3_of_3"] += 1
                        head_fails.add(str(k))
                    if v in _BAD_RUN or "::(package failed)" in str(k):
                        mode_gaps = True
            elif tag in ("A", "B") or (bdir / f"compile_{tag}.log").exists():
                mode_gaps = True

            base_data = _read_optional_json(bdir / f"base_{tag}.json")
            if isinstance(base_data, dict):
                if head_fails and any(str(base_data.get(t, "")) not in (Verdict.NEW_PR_BUG, Verdict.PRE_EXISTING) for t in head_fails):
                    mode_gaps = True
                for tname, v in base_data.items():
                    if tname in ("*", "detail", "new_api"):
                        if tname == "*" and v in _BAD_BASE:
                            mode_gaps = True
                        continue
                    if v == Verdict.NEW_PR_BUG:
                        counts["new_pr_bug"] += 1
                        caught_by_tag[tag].add(tname)
                    elif v == Verdict.NEW_API:
                        counts["new_api"] += 1
                        caught_by_tag[tag].add(tname)
                        mode_gaps = True
                    elif v == Verdict.PRE_EXISTING:
                        counts["pre_existing"] += 1
                    elif v in _BAD_BASE:
                        mode_gaps = True

            elif head_fails:
                mode_gaps = True

        d_resp = _read_optional_dict(bdir / "D" / "response.json")
        if (bdir / "D" / "response.json").exists() and not d_resp.get("files"):
            mode_gaps = True
        diff_data = _read_optional_json(bdir / "diff_D.json")
        if isinstance(diff_data, dict):
            if not diff_data:
                mode_gaps = True
            counts["diff"] += sum(1 for v in diff_data.values() if v == Verdict.DIFF)
            if any(v in _BAD_DIFF for v in diff_data.values()):
                mode_gaps = True
        else:
            mode_gaps = True

        cov_data = _read_optional_json(bdir / "run_A.coverage.json")
        if isinstance(cov_data, dict):
            reached_sum += int(cov_data.get("reached") or 0)
            exec_sum += int(cov_data.get("executable") or 0)

    return counts, caught_by_tag, reached_sum, exec_sum, mode_gaps


def _skipped_info(hdir: Path) -> tuple[int, dict[str, str]]:
    sk_path = hdir / "skipped.log"
    if not sk_path.exists():
        return 0, {}
    deferred = 0
    reasons: dict[str, str] = {}
    for line in sk_path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            tag, path = parts[0], parts[1]
            if tag.startswith(("DEFERRED", "EXCLUDED")):
                reasons[path] = tag
            if tag.startswith("DEFERRED"):
                deferred += 1
    return deferred, reasons


def _tier_and_gaps(hdir: Path, counts: dict[str, int],
                   reached: int, executable: int, deferred_count: int,
                   batches_hunted: int, batches_total: int,
                   mode_gaps: bool, verdicts: dict[str, Any]) -> tuple[str, list[str]]:
    pr_tests_data = _read_optional_dict(hdir / "pr_tests.json")
    old_tests_data = _read_optional_dict(hdir / "old_tests.json")
    pr_tests_map = pr_tests_data.get("tests")
    old_tests_map = old_tests_data.get("tests")
    pr_vals = set(pr_tests_map.values()) if isinstance(pr_tests_map, dict) else set()
    old_vals = set(old_tests_map.values()) if isinstance(old_tests_map, dict) else set()

    has_r_bug = any(
        isinstance(e, dict) and e.get("verdict") == Verdict.PROVEN and e.get("base_verdict") == Verdict.NEW_PR_BUG
        for e in verdicts.values()
    )
    # A1: only a vetted row that passes verdict.admissibility (and any post-filter in verdict.json) reaches the author.
    resolved_keep, resolved_held = resolved_verdicts(hdir)
    if resolved_keep:
        return "Bug Proven", []
    batch_unvetted = any(_batch_has_raw_bug(bdir) and not _batch_is_vetted(bdir, hdir) for bdir in _batch_dirs(hdir))
    whole_pr_raw = (
        has_r_bug
        or Verdict.PR_TEST_FAILS_UNDER_CI in pr_vals
        or bool(old_vals & {Verdict.OLD_TEST_BREAKS, Verdict.OLD_TEST_SOMETIMES_BREAKS})
    )
    unfinished_archive = any(
        bdir != hdir and (bdir / "vetted.json").is_file() and _read_verdict_json(bdir) is None
        for bdir in _batch_dirs(hdir)
    )
    unvetted = batch_unvetted or (whole_pr_raw and not _batch_is_vetted(hdir, hdir)) or unfinished_archive
    has_held = any(
        str((h["row"] if isinstance(h.get("row"), dict) else {}).get("decision", "")).upper() != Verdict.DROP.value
        for h in resolved_held
    )

    threads_doc = _read_optional_dict(hdir / "R" / "threads.json")
    has_pending_r = bool(threads_doc.get("included")) and not verdicts
    r_compile_gap = (hdir / "compile_R.log").exists() and not (hdir / "run_R.json").exists()
    r_gaps = any(
        isinstance(e, dict) and (
            e.get("verdict") == Verdict.UNPROVABLE_DYNAMICALLY
            or (e.get("verdict") == Verdict.PROVEN and e.get("base_verdict") in _BAD_BASE)
        )
        for e in verdicts.values()
    )

    gaps = (
        unvetted
        or has_held
        or mode_gaps
        or has_pending_r
        or r_compile_gap
        or r_gaps
        or (deferred_count > 0 and batches_hunted < batches_total)
        or counts["mode_a_empty"] > 0
        or bool(pr_vals & {Verdict.NOT_RUN, Verdict.FLAKY, Verdict.PR_TEST_FAILS})
        or bool(old_vals & {Verdict.NOT_RUN, Verdict.NOT_RUN_ON_BASE, Verdict.FLAKY})
        or (executable > 0 and reached == 0)
    )
    if not gaps:
        return "High-Confidence Clean", []
    return "Partial or Unverified Coverage", (["unvetted findings"] if unvetted else [])


def _export_escapes(hdir: Path, state: dict[str, Any], pr_key: str,
                    verdicts: dict[str, Any], caught_by_tag: dict[str, set[str]],
                    counts: dict[str, int], skip_reasons: dict[str, str],
                    cov_data: dict[str, Any] | None, out_file: Path) -> list[str]:
    """Export verified Mode R escapes (Mode R PROVEN NEW_PR_BUG/NEW_API while standalone A/B/D missed)."""
    if any(caught_by_tag.values()) or counts["diff"] > 0:
        return []
    resp = _read_optional_dict(hdir / "R" / "response.json")
    raw_files = resp.get("files")
    files_by_path = {
        str(f["path"]): str(f.get("content", ""))
        for f in (raw_files if isinstance(raw_files, list) else [])
        if isinstance(f, dict) and isinstance(f.get("path"), str)
    }
    escape_dir = out_file.parent / "escapes"
    exported: list[str] = []
    safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(pr_key)).strip(".") or "target"
    for cid, entry in sorted(verdicts.items()):
        if not isinstance(entry, dict) or entry.get("verdict") != Verdict.PROVEN:
            continue
        if entry.get("base_verdict") not in (Verdict.NEW_PR_BUG, Verdict.NEW_API):
            continue
        tests = entry.get("tests")
        tests_dict = tests if isinstance(tests, dict) else {}
        test_files = {
            f_path: files_by_path[f_path]
            for f_path in files_by_path
            if any(t_id.startswith((f"{Path(f_path).parent}::", f"{f_path}::")) for t_id in tests_dict)
        }
        bundle = {
            "pr": str(state.get("pr", "")),
            "target": pr_key,
            "head": state.get("head", ""),
            "merge_base": state.get("merge_base", ""),
            "claim_id": cid,
            "path": entry.get("path", ""),
            "line": entry.get("line"),
            "severity": entry.get("severity", ""),
            "triage": entry.get("triage", ""),
            "title": entry.get("title", ""),
            "url": entry.get("url", ""),
            "base_verdict": entry.get("base_verdict", ""),
            "repro_tests": tests_dict,
            "repro_files": test_files,
            "deferred_or_excluded": skip_reasons.get(str(entry.get("path", "")), ""),
            "mode_a_coverage": cov_data,
        }
        safe_cid = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cid)).strip(".") or "claim"
        head_tag = re.sub(r"[^A-Za-z0-9]+", "", str(state.get("head", "")))[:8]
        fname = f"pr_{safe_key}_{head_tag}_{safe_cid}.json" if head_tag else f"pr_{safe_key}_{safe_cid}.json"
        write_json(under(escape_dir, fname), bundle)
        exported.append(fname)
    return exported


def record(pr: str, hdir: Path | None = None, out_path: Path | None = None) -> dict[str, Any]:
    hdir = hdir or hunt_dir(pr)
    state = read_state(hdir)
    out_file = ledger_path(out_path)
    counts, caught_by_tag, reached, executable, mode_gaps = _aggregate_modes(hdir)
    deferred_count, skip_reasons = _skipped_info(hdir)

    verdict_doc = _read_optional_dict(hdir / "review_verdicts.json")
    raw_verdicts = verdict_doc.get("verdicts")
    verdicts = raw_verdicts if isinstance(raw_verdicts, dict) else {}
    r_summary = {"proven": 0, "disproven": 0, "unprovable": 0, "unprovable_high_severity": 0}
    for item in verdicts.values():
        if not isinstance(item, dict):
            continue
        v = item.get("verdict")
        if v == Verdict.PROVEN:
            r_summary["proven"] += 1
        elif v == Verdict.DISPROVEN:
            r_summary["disproven"] += 1
        elif v == Verdict.UNPROVABLE_DYNAMICALLY:
            r_summary["unprovable"] += 1
            if item.get("severity") in ("critical", "major"):
                r_summary["unprovable_high_severity"] += 1

    pr_tests_data = _read_optional_dict(hdir / "pr_tests.json")
    pr_tests_map = pr_tests_data.get("tests")
    pr_statuses = sorted(set(pr_tests_map.values())) if isinstance(pr_tests_map, dict) else []
    cov_data = _read_optional_dict(hdir / "run_A.coverage.json") or None
    pr_key = target_key(pr)
    escapes = _export_escapes(hdir, state, pr_key, verdicts, caught_by_tag, counts, skip_reasons, cov_data, out_file)

    batches_hunted = len(_batch_dirs(hdir))
    batches_total = int(state.get("batches") or 1)
    tier, tier_gaps = _tier_and_gaps(
        hdir, counts, reached, executable, deferred_count, batches_hunted, batches_total, mode_gaps, verdicts,
    )
    entry: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target": str(state.get("pr", pr)),
        "target_key": pr_key,
        "head": state.get("head", ""),
        "merge_base": state.get("merge_base", ""),
        "batches_hunted": batches_hunted,
        "batches_total": batches_total,
        "all_batches": bool(state.get("all_batches")),
        "deferred_count": deferred_count,
        "confidence_tier": tier,
        "gaps": tier_gaps,
        "modes": counts,
        "mode_a_reached": reached,
        "mode_a_executable": executable,
        "pr_tests_statuses": pr_statuses,
        "mode_r_summary": r_summary,
        "escapes": escapes,
    }
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with out_file.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")
    return entry


def list_escapes(override: Path | None = None) -> list[dict[str, Any]]:
    esc_dir = ledger_path(override).parent / "escapes"
    if not esc_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(esc_dir.glob("*.json")):
        try:
            out.append({**load_json(p), "_file": p.name})
        except (OSError, json.JSONDecodeError):
            continue
    return out


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(prog="ledger.py", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("pr")
    rec.add_argument("--out", type=Path, default=None)
    esc = sub.add_parser("escapes")
    esc.add_argument("--ledger", type=Path, default=None)
    ns = ap.parse_args(args)
    try:
        if ns.cmd == "record":
            row = record(ns.pr, out_path=ns.out)
            print(f"[ledger] recorded {row['target']} -> {row['confidence_tier']} "
                  f"(escapes={len(row['escapes'])})")
        else:
            bundles = list_escapes(ns.ledger)
            for b in bundles:
                print(json.dumps(b))
            print(f"{len(bundles)} escape bundle(s)")
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
