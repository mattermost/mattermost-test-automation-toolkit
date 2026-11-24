#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Step 7b: persist per-hunt telemetry and export Mode R false-negative bundles for self-improvement.

usage: ledger.py record <pr> [--out <path>]   append one compact JSONL telemetry line (+ export escapes)
       ledger.py escapes [--ledger <path>]    list exported Mode R false-negative bundles
"""
from __future__ import annotations

import atexit as _atexit
import shutil as _shutil
import sys as _sys
import tempfile as _tempfile

if not _sys.pycache_prefix:
    _sys.pycache_prefix = _tempfile.mkdtemp(prefix="hunt-pyc-")
    _atexit.register(_shutil.rmtree, _sys.pycache_prefix, True)

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hunt_common import InfraError, hunt_dir, load_json, read_state, scratch, target_key, under, write_json

_BAD_RUN = frozenset({"FLAKY", "SKIP", "(package failed)"})
_BAD_BASE = frozenset({"NEW_API", "BASE_UNCOMPILABLE", "BASE_FAILS_DIFFERENTLY", "NOT_RUN_ON_BASE", "UNVETTED"})
_BAD_DIFF = frozenset({"RECORDER_FAILED", "BASE_FAILED", "BASE_UNCOMPILABLE", "NO_RECORDS", "NONDETERMINISTIC"})


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


def _batch_dirs(hdir: Path) -> list[Path]:
    dirs: list[Path] = []
    broot = hdir / "batches"
    if broot.is_dir():
        dirs.extend(sorted(p for p in broot.iterdir() if p.is_dir() and p.name.startswith("batch_")))
    dirs.append(hdir)
    return dirs


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
                    if v == "PASS":
                        counts["pass"] += 1
                    elif v == "FAIL_3_OF_3":
                        counts["fail_3_of_3"] += 1
                        head_fails.add(str(k))
                    if v in _BAD_RUN or "::(package failed)" in str(k):
                        mode_gaps = True
            elif tag in ("A", "B") or (bdir / f"compile_{tag}.log").exists():
                mode_gaps = True

            base_data = _read_optional_json(bdir / f"base_{tag}.json")
            if isinstance(base_data, dict):
                if head_fails and any(str(base_data.get(t, "")) not in ("NEW_PR_BUG", "PRE_EXISTING") for t in head_fails):
                    mode_gaps = True
                for tname, v in base_data.items():
                    if tname in ("*", "detail", "new_api"):
                        if tname == "*" and v in _BAD_BASE:
                            mode_gaps = True
                        continue
                    if v == "NEW_PR_BUG":
                        counts["new_pr_bug"] += 1
                        caught_by_tag[tag].add(tname)
                    elif v == "NEW_API":
                        counts["new_api"] += 1
                        caught_by_tag[tag].add(tname)
                        mode_gaps = True
                    elif v == "PRE_EXISTING":
                        counts["pre_existing"] += 1
                    elif v in _BAD_BASE:
                        mode_gaps = True

            elif head_fails:
                mode_gaps = True

        diff_data = _read_optional_json(bdir / "diff_D.json")
        if isinstance(diff_data, dict):
            counts["diff"] += sum(1 for v in diff_data.values() if v == "DIFF")
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


def _confidence_tier(hdir: Path, counts: dict[str, int],
                     reached: int, executable: int, deferred_count: int,
                     batches_hunted: int, batches_total: int,
                     mode_gaps: bool, verdicts: dict[str, Any]) -> str:
    pr_tests_data = _read_optional_dict(hdir / "pr_tests.json")
    old_tests_data = _read_optional_dict(hdir / "old_tests.json")
    pr_tests_map = pr_tests_data.get("tests")
    old_tests_map = old_tests_data.get("tests")
    pr_vals = set(pr_tests_map.values()) if isinstance(pr_tests_map, dict) else set()
    old_vals = set(old_tests_map.values()) if isinstance(old_tests_map, dict) else set()

    has_r_bug = any(
        isinstance(e, dict) and e.get("verdict") == "PROVEN" and e.get("base_verdict") == "NEW_PR_BUG"
        for e in verdicts.values()
    )
    if (
        counts["new_pr_bug"] > 0
        or has_r_bug
        or "PR_TEST_FAILS_UNDER_CI" in pr_vals
        or bool(old_vals & {"OLD_TEST_BREAKS", "OLD_TEST_SOMETIMES_BREAKS"})
    ):
        return "Bug Proven"

    threads_doc = _read_optional_dict(hdir / "R" / "threads.json")
    has_pending_r = bool(threads_doc.get("included")) and not verdicts
    r_compile_gap = (hdir / "compile_R.log").exists() and not (hdir / "run_R.json").exists()
    r_gaps = any(
        isinstance(e, dict) and (
            e.get("verdict") == "UNPROVABLE_DYNAMICALLY"
            or (e.get("verdict") == "PROVEN" and e.get("base_verdict") in _BAD_BASE)
        )
        for e in verdicts.values()
    )

    gaps = (
        mode_gaps
        or has_pending_r
        or r_compile_gap
        or r_gaps
        or (deferred_count > 0 and batches_hunted < batches_total)
        or counts["mode_a_empty"] > 0
        or bool(pr_vals & {"NOT_RUN", "FLAKY", "PR_TEST_FAILS"})
        or bool(old_vals & {"NOT_RUN", "NOT_RUN_ON_BASE", "FLAKY"})
        or (executable > 0 and reached == 0)
    )
    return "Partial or Unverified Coverage" if gaps else "High-Confidence Clean"


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
        if not isinstance(entry, dict) or entry.get("verdict") != "PROVEN":
            continue
        if entry.get("base_verdict") not in ("NEW_PR_BUG", "NEW_API"):
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
        if v == "PROVEN":
            r_summary["proven"] += 1
        elif v == "DISPROVEN":
            r_summary["disproven"] += 1
        elif v == "UNPROVABLE_DYNAMICALLY":
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
        "confidence_tier": _confidence_tier(
            hdir, counts, reached, executable, deferred_count, batches_hunted, batches_total, mode_gaps, verdicts,
        ),
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
