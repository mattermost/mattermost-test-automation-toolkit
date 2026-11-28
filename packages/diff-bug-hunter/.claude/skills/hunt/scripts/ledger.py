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

import telemetry
from hunt_common import (
    InfraError,
    hunt_dir,
    load_json,
    read_optional_dict,
    read_optional_json,
    read_state,
    scratch,
    target_key,
    under,
    write_json,
)
from verdict import admissibility, mechanical_verdict, row_errors
from verdicts import Verdict

_BAD_RUN = frozenset({Verdict.FLAKY, Verdict.SKIP, "(package failed)"})
GO_RACE_MARK = "race detected during execution of test"
_BAD_BASE = frozenset({Verdict.NEW_API, Verdict.BASE_UNCOMPILABLE, Verdict.BASE_FAILS_DIFFERENTLY, Verdict.NOT_RUN_ON_BASE, Verdict.UNVETTED})
_BAD_DIFF = frozenset({Verdict.RECORDER_FAILED, Verdict.BASE_FAILED, Verdict.BASE_UNCOMPILABLE, Verdict.NO_RECORDS, Verdict.NONDETERMINISTIC})


def ledger_path(override: Path | None = None) -> Path:
    if override is not None:
        return override.resolve()
    env = os.environ.get("HUNT_LEDGER", "").strip()
    return Path(env).resolve() if env else scratch() / "hunt_ledger.jsonl"


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
        raw_order = read_optional_json(broot / "order.json")
        order_idx = {str(name): idx for idx, name in enumerate(raw_order)} if isinstance(raw_order, list) else {}
        dirs.extend(sorted(
            (p for p in broot.iterdir() if p.is_dir() and p.name.startswith("batch_")),
            key=lambda p: (1, order_idx[p.name], 0, 0, p.name) if p.name in order_idx else (0, *_batch_sort_key(p)),
        ))
    dirs.append(hdir)
    return dirs


def _read_verdict_json(bdir: Path) -> dict[str, Any] | None:
    vpath = bdir / "verdict.json"
    if not vpath.is_file():
        return None
    data = read_optional_dict(vpath)
    keep, held = data.get("keep"), data.get("held")
    if not (isinstance(keep, list) or isinstance(held, list)):
        return None
    if keep is not None and not isinstance(keep, list):
        return None
    if held is not None and not isinstance(held, list):
        return None
    keep_rows = keep if isinstance(keep, list) else []
    held_rows = held if isinstance(held, list) else []
    if not all(isinstance(r, dict) and not row_errors(r) for r in keep_rows):
        return None
    if not all(isinstance(h, dict) and isinstance(h.get("row"), dict) for h in held_rows):
        return None
    return {"vetted_present": bool(data.get("vetted_present")), "keep": keep_rows, "held": held_rows}


def _batch_verdicts(bdir: Path, root: Path, *, require_verdict_json: bool = False) -> dict[str, Any]:
    """Post-lesson verdict.json when valid and vetted; active batch may fall back to admissibility()."""
    data = _read_verdict_json(bdir)
    if data is not None:
        if data.get("vetted_present"):
            return data
        return {"keep": [], "held": []} if (require_verdict_json or bdir != root) else admissibility(bdir)
    if require_verdict_json or bdir != root:
        return {"keep": [], "held": []}
    return admissibility(bdir)


def _batch_raw_bugs(bdir: Path) -> set[tuple[str, str]]:
    bugs: set[tuple[str, str]] = set()
    for tag in ("A", "A2", "B"):
        base_data = read_optional_json(bdir / f"base_{tag}.json")
        if isinstance(base_data, dict):
            src = "A" if tag == "A2" else tag
            for k, v in base_data.items():
                if k not in ("*", "detail", "new_api") and v == Verdict.NEW_PR_BUG:
                    bugs.add((src, str(k)))
    diff_data = read_optional_json(bdir / "diff_D.json")
    if isinstance(diff_data, dict):
        for k, v in diff_data.items():
            if v == Verdict.DIFF:
                bugs.add(("D", str(k)))
    return bugs


def _is_invalid_held(h: dict[str, Any]) -> bool:
    reasons = h.get("reasons")
    return isinstance(reasons, list) and any(str(r).startswith("invalid row:") for r in reasons)


def _is_valid_drop(h: dict[str, Any]) -> bool:
    row = h.get("row")
    if not isinstance(row, dict) or str(row.get("decision", "")).upper() != Verdict.DROP.value:
        return False
    return not _is_invalid_held(h)


def _decided_candidates(data: dict[str, Any]) -> set[tuple[str, str]]:
    decided: set[tuple[str, str]] = set()
    for r in data.get("keep", []):
        if isinstance(r, dict) and r.get("id"):
            decided.add((str(r.get("source", "")), str(r["id"])))
    for h in data.get("held", []):
        row = h.get("row") if isinstance(h, dict) else None
        if isinstance(row, dict) and row.get("id"):
            if str(row.get("decision", "")).upper() == Verdict.DROP.value and not _is_valid_drop(h):
                continue
            decided.add((str(row.get("source", "")), str(row["id"])))
    return decided


def _batch_has_raw_bug(bdir: Path) -> bool:
    return bool(_batch_raw_bugs(bdir))


def _batch_is_vetted(bdir: Path, root: Path, *, require_verdict_json: bool = False) -> bool:
    raw_bugs = _batch_raw_bugs(bdir)
    vdata = _read_verdict_json(bdir)
    if vdata is not None and vdata.get("vetted_present"):
        return raw_bugs <= _decided_candidates(vdata)
    if not require_verdict_json and bdir == root and (bdir / "vetted.json").is_file():
        return raw_bugs <= _decided_candidates(admissibility(bdir))
    return False


def _finding_key(source: str, rid: str, row: dict[str, Any], batch_changed: tuple[str, ...]) -> tuple[Any, ...]:
    """Key findings by (source, id, file_line) so later batches supersede the same finding regardless of batch
    changed-file set, while batch-local findings with distinct root-cause locations stay separate (Mode R is PR-wide)."""
    if source == "R":
        return (source, rid)
    fl = str(row.get("file_line") or "").strip()
    if fl:
        return (source, rid, fl)
    return (source, rid, batch_changed)


def _clear_overlapped_prior(by_key: dict[tuple[Any, ...], Any],
                            key_batch: dict[tuple[Any, ...], tuple[int, tuple[str, ...]]],
                            source: str, rid: str, fl: str, batch_changed: tuple[str, ...],
                            batch_idx: int) -> None:
    """Reconcile earlier-batch decisions for the same candidate when location changes or becomes locationless."""
    if source == "R":
        return
    if not fl:
        drop = []
        for k in by_key:
            if k[0] != source or k[1] != rid:
                continue
            prev_idx, prev_bc = key_batch.get(k, (-1, ()))
            if prev_idx >= batch_idx:
                continue
            if not batch_changed:
                if not prev_bc:
                    drop.append(k)
            elif prev_bc == batch_changed or (
                len(k) == 3 and isinstance(k[2], str)
                and k[2].split(":", 1)[0] in prev_bc and k[2].split(":", 1)[0] in batch_changed
            ):
                drop.append(k)
    else:
        fl_file = fl.split(":", 1)[0]
        drop = []
        for k in by_key:
            if k[0] != source or k[1] != rid or len(k) != 3:
                continue
            prev_idx, prev_bc = key_batch.get(k, (-1, ()))
            if prev_idx >= batch_idx:
                continue
            if isinstance(k[2], tuple):
                if (k[2] == batch_changed or (not k[2] and not batch_changed)
                        or (fl_file in k[2] and fl_file in batch_changed)):
                    drop.append(k)
            elif isinstance(k[2], str) and k[2].split(":", 1)[0] == fl_file and (
                prev_bc == batch_changed
                or (not prev_bc and not batch_changed)
                or (fl_file in prev_bc and fl_file in batch_changed)
            ):
                drop.append(k)
    for k in drop:
        del by_key[k]
        key_batch.pop(k, None)


def _merge_batch_verdict_items(
    by_key: dict[tuple[Any, ...], tuple[str, dict[str, Any]]],
    anon_keep: list[dict[str, Any]],
    anon_held: list[dict[str, Any]],
    b_keep: list[dict[str, Any]],
    b_held: list[dict[str, Any]],
    batch_changed: tuple[str, ...],
    key_batch: dict[tuple[Any, ...], tuple[int, tuple[str, ...]]] | None = None,
    batch_idx: int = 0,
) -> None:
    batches = key_batch if key_batch is not None else {}
    for r in b_keep:
        if not isinstance(r, dict):
            continue
        rid = str(r.get("id", ""))
        if rid:
            src = str(r.get("source", ""))
            fl = str(r.get("file_line") or "").strip()
            _clear_overlapped_prior(by_key, batches, src, rid, fl, batch_changed, batch_idx)
            key = _finding_key(src, rid, r, batch_changed)
            by_key[key] = ("keep", r)
            batches[key] = (batch_idx, batch_changed)
        else:
            anon_keep.append(r)
    for h in b_held:
        if not isinstance(h, dict):
            continue
        raw_row = h.get("row")
        row = raw_row if isinstance(raw_row, dict) else {}
        rid = str(row.get("id", ""))
        if rid and not _is_invalid_held(h):
            src = str(row.get("source", ""))
            fl = str(row.get("file_line") or "").strip()
            _clear_overlapped_prior(by_key, batches, src, rid, fl, batch_changed, batch_idx)
            key = _finding_key(src, rid, row, batch_changed)
            by_key[key] = ("held", h)
            batches[key] = (batch_idx, batch_changed)
        else:
            anon_held.append(h)


def resolved_verdicts(hdir: Path, *, require_verdict_json: bool = False) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Resolve kept and held/dropped rows across archived batches and the active batch.

    Batches are walked in archive order (oldest -> newest -> active hdir), so later batches
    supersede earlier decisions for the same finding while unrelated archived findings remain.
    """
    by_key: dict[tuple[Any, ...], tuple[str, dict[str, Any]]] = {}
    key_batch: dict[tuple[Any, ...], tuple[int, tuple[str, ...]]] = {}
    anon_keep: list[dict[str, Any]] = []
    anon_held: list[dict[str, Any]] = []
    for batch_idx, bdir in enumerate(_batch_dirs(hdir)):
        adm = _batch_verdicts(bdir, root=hdir, require_verdict_json=require_verdict_json)
        st = read_optional_dict(bdir / "state.json")
        batch_changed = tuple(sorted(str(x) for x in (st.get("changed") or [])))
        _merge_batch_verdict_items(
            by_key, anon_keep, anon_held, adm.get("keep", []), adm.get("held", []),
            batch_changed, key_batch, batch_idx=batch_idx,
        )
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
    root_raw = read_optional_dict(hdir / "driver.json").get("modes") or read_optional_dict(hdir / "state.json").get("modes")
    root_modes = [str(m) for m in root_raw] if isinstance(root_raw, list) else None

    for bdir in _batch_dirs(hdir):
        b_raw = read_optional_dict(bdir / "state.json").get("modes")
        if isinstance(b_raw, list):
            recorded_modes: list[str] | None = [str(m) for m in b_raw]
        elif bdir == hdir:
            recorded_modes = root_modes
        else:
            recorded_modes = None
        for tag in ("A", "A2", "B"):
            resp = read_optional_dict(bdir / tag / "response.json")
            empty_resp = resp.get("files") == []
            if tag == "A" and empty_resp:
                counts["mode_a_empty"] += 1
            if empty_resp:
                mode_gaps = True

            run_data = read_optional_json(bdir / f"run_{tag}.json")
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
            elif (tag in recorded_modes if recorded_modes is not None
                  else (tag in ("A", "B") and (root_modes is None or tag in root_modes))) \
                    or (bdir / f"compile_{tag}.log").exists():
                mode_gaps = True

            base_data = read_optional_json(bdir / f"base_{tag}.json")
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

        d_present = any((bdir / p).exists() for p in ("D/request.json", "D/response.json", "compile_D.log", "diff_D.json"))
        d_expected = ("D" in recorded_modes) if recorded_modes is not None else d_present
        if d_expected or d_present:
            d_resp = read_optional_dict(bdir / "D" / "response.json")
            if (bdir / "D" / "response.json").exists() and not d_resp.get("files"):
                mode_gaps = True
            diff_data = read_optional_json(bdir / "diff_D.json")
            if isinstance(diff_data, dict):
                if not diff_data:
                    mode_gaps = True
                counts["diff"] += sum(1 for v in diff_data.values() if v == Verdict.DIFF)
                if any(v in _BAD_DIFF for v in diff_data.values()):
                    mode_gaps = True
            else:
                mode_gaps = True

        cov_data = read_optional_json(bdir / "run_A.coverage.json")
        if isinstance(cov_data, dict):
            reached_sum += int(cov_data.get("reached") or 0)
            exec_sum += int(cov_data.get("executable") or 0)
        elif (bdir / "run_A.json").exists():
            mode_gaps = True  # Mode A ran but its changed lines were never measured: Clean needs that evidence

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


def _archived_r_bugs(bdir: Path, root_verdicts: dict[str, Any]) -> set[tuple[str, str]]:
    bugs: set[tuple[str, str]] = set()
    rv = read_optional_dict(bdir / "review_verdicts.json").get("verdicts")
    if isinstance(rv, dict):
        for cid, e in rv.items():
            if isinstance(e, dict) and e.get("verdict") == Verdict.PROVEN and e.get("base_verdict") == Verdict.NEW_PR_BUG:
                bugs.add(("R", str(cid)))
        return bugs
    if not root_verdicts:
        for p in [bdir / "base_R.json", *sorted(p for p in bdir.glob("R_*.json") if p.is_file())]:
            data = read_optional_json(p)
            if isinstance(data, dict):
                raw_v = data.get("verdicts")
                src = raw_v if isinstance(raw_v, dict) else data
                for k, v in src.items():
                    if k not in ("*", "detail", "new_api") and (
                        v == Verdict.NEW_PR_BUG
                        or (isinstance(v, dict) and v.get("verdict") == Verdict.PROVEN
                            and v.get("base_verdict") == Verdict.NEW_PR_BUG)
                    ):
                        bugs.add(("R", str(k)))
    return bugs


def keep_tier(hdir: Path, keep: list[dict[str, Any]]) -> str:
    """Bug Proven only when a kept row has a merge-base NEW_PR_BUG oracle. A kept Mode D DIFF or Mode A/B NEW_API has no
    such oracle, so the skeptic's KEEP alone stands behind it: that is a behaviour change for the author to review."""
    for row in keep:
        if (row.get("mechanical_verdict") or mechanical_verdict(hdir, row)) == Verdict.NEW_PR_BUG:
            return "Bug Proven"
    return "Behaviour change, needs review"


def _dismissed_mechanical(hdir: Path, row: dict[str, Any]) -> bool:
    """True when any batch's merge-base oracle for the row's test is the mechanical failure: NEW_PR_BUG, or a Mode D
    DIFF. Any batch counts, so a newer batch that reuses the test name cannot clear an earlier failure."""
    for bdir in _batch_dirs(hdir):
        mech = mechanical_verdict(bdir, row)
        if mech == Verdict.NEW_PR_BUG or (row.get("source") == "D" and mech == Verdict.DIFF):
            return True
    return False


def race_reports(hdir: Path) -> list[str]:
    """One gap line per hunter test the Go race detector failed on head. A race the merge-base reports too is left
    out. The detector is mechanical evidence, so it stands whatever the run count or the skeptic made of the test."""
    out: list[str] = []
    for bdir in _batch_dirs(hdir):
        for tag in ("A", "A2", "B"):
            base = read_optional_dict(bdir / f"base_{tag}.json")
            for ident, text in sorted(read_optional_dict(bdir / f"run_{tag}.messages.json").items()):
                if GO_RACE_MARK in str(text) and base.get(ident) != Verdict.PRE_EXISTING:
                    out.append(f"race detector fired on head in {ident} (Mode {tag})")
    return out


def _tier_and_gaps(hdir: Path, counts: dict[str, int],
                   reached: int, executable: int, deferred_count: int,
                   batches_hunted: int, batches_total: int,
                   mode_gaps: bool, verdicts: dict[str, Any],
                   *, require_verdict_json: bool = False) -> tuple[str, list[str]]:
    pr_tests_data = read_optional_dict(hdir / "pr_tests.json")
    old_tests_data = read_optional_dict(hdir / "old_tests.json")
    pr_tests_map = pr_tests_data.get("tests")
    old_tests_map = old_tests_data.get("tests")
    pr_vals = set(pr_tests_map.values()) if isinstance(pr_tests_map, dict) else set()
    old_vals = set(old_tests_map.values()) if isinstance(old_tests_map, dict) else set()

    # A1: only a vetted row that passes verdict.admissibility (and any post-filter in verdict.json) reaches the author.
    resolved_keep, resolved_held = resolved_verdicts(hdir, require_verdict_json=require_verdict_json)
    if resolved_keep:
        return keep_tier(hdir, resolved_keep), []
    decided_keys: set[tuple[str, str]] = set()
    for r in resolved_keep:
        if isinstance(r, dict) and r.get("id"):
            decided_keys.add((str(r.get("source", "")), str(r.get("id", ""))))
    for h in resolved_held:
        row = h.get("row") if isinstance(h, dict) else None
        if isinstance(row, dict) and row.get("id"):
            decided_keys.add((str(row.get("source", "")), str(row.get("id", ""))))
    batch_unvetted = any(
        _batch_has_raw_bug(bdir) and not _batch_is_vetted(bdir, hdir, require_verdict_json=require_verdict_json)
        for bdir in _batch_dirs(hdir)
    )
    r_unvetted = any(
        isinstance(e, dict)
        and e.get("verdict") == Verdict.PROVEN
        and e.get("base_verdict") == Verdict.NEW_PR_BUG
        and ("R", str(cid)) not in decided_keys
        for cid, e in verdicts.items()
    )
    pr_unvetted = isinstance(pr_tests_map, dict) and any(
        v == Verdict.PR_TEST_FAILS_UNDER_CI and ("pr", str(k)) not in decided_keys
        for k, v in pr_tests_map.items()
    )
    old_unvetted = isinstance(old_tests_map, dict) and any(
        v in {Verdict.OLD_TEST_BREAKS, Verdict.OLD_TEST_SOMETIMES_BREAKS} and ("old", str(k)) not in decided_keys
        for k, v in old_tests_map.items()
    )
    unfinished_archive = any(
        bdir != hdir and ((bdir / "vetted.json").is_file() or (bdir / "verdict.json").is_file())
        and _read_verdict_json(bdir) is None
        for bdir in _batch_dirs(hdir)
    )
    archived_r_unvetted = any(
        bdir != hdir
        and (r_bugs := _archived_r_bugs(bdir, verdicts))
        and not (
            (r_bugs <= _decided_candidates(vdata))
            if ((vdata := _read_verdict_json(bdir)) is not None and vdata.get("vetted_present"))
            else (r_bugs <= decided_keys)
        )
        for bdir in _batch_dirs(hdir)
    )
    unvetted = batch_unvetted or r_unvetted or pr_unvetted or old_unvetted or unfinished_archive or archived_r_unvetted
    has_held = any(not _is_valid_drop(h) for h in resolved_held)

    threads_doc = read_optional_dict(hdir / "R" / "threads.json")
    has_pending_r = bool(threads_doc.get("included")) and not verdicts
    r_compile_gap = (hdir / "compile_R.log").exists() and not (hdir / "run_R.json").exists()
    r_gaps = any(
        isinstance(e, dict) and (
            e.get("verdict") == Verdict.UNPROVABLE_DYNAMICALLY
            or (e.get("verdict") == Verdict.PROVEN and e.get("base_verdict") in _BAD_BASE)
        )
        for e in verdicts.values()
    )

    driver_gaps = read_optional_dict(hdir / "driver.json").get("gaps")
    has_driver_gaps = isinstance(driver_gaps, dict) and bool(driver_gaps)

    gaps = (
        unvetted
        or has_held
        or mode_gaps
        or has_driver_gaps
        or has_pending_r
        or r_compile_gap
        or r_gaps
        or (deferred_count > 0 and batches_hunted < batches_total)
        or counts["mode_a_empty"] > 0
        or bool(pr_vals & {Verdict.NOT_RUN, Verdict.FLAKY, Verdict.PR_TEST_FAILS})
        or bool(old_vals & {Verdict.NOT_RUN, Verdict.NOT_RUN_ON_BASE, Verdict.FLAKY, Verdict.OLD_TEST_UNCOMPILABLE})
        or (executable > 0 and reached == 0)
    )
    races = race_reports(hdir)
    dismissed = sum(1 for h in resolved_held if _is_valid_drop(h) and _dismissed_mechanical(hdir, h["row"]))
    dismissed_gap = [f"{dismissed} mechanical failure(s) dismissed by the skeptic"] if dismissed else []
    if not gaps and not races and not dismissed_gap:
        return "High-Confidence Clean", []
    return "Partial or Unverified Coverage", (["unvetted findings"] if unvetted else []) + races + dismissed_gap


def _export_escapes(hdir: Path, state: dict[str, Any], pr_key: str,
                    verdicts: dict[str, Any], caught_by_tag: dict[str, set[str]],
                    counts: dict[str, int], skip_reasons: dict[str, str],
                    cov_data: dict[str, Any] | None, out_file: Path) -> list[str]:
    """Export verified Mode R escapes (Mode R PROVEN NEW_PR_BUG/NEW_API while standalone A/B/D missed)."""
    if any(caught_by_tag.values()) or counts["diff"] > 0:
        return []
    resp = read_optional_dict(hdir / "R" / "response.json")
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


def _collect_ledger_telemetry(hdir: Path) -> tuple[dict[str, Any], float]:
    """Collect unified telemetry usage, repair/retry counts, and test runtimes across batches and root."""
    summaries = [telemetry.summarize(bdir) for bdir in _batch_dirs(hdir) if (bdir / telemetry.LEDGER).is_file()]
    usage = telemetry.merge_summaries(summaries)
    repairs = 0
    retries = 0
    test_runtime_s = 0.0
    for bdir in _batch_dirs(hdir):
        for p in bdir.iterdir():
            if not p.is_dir() or p.name == "batches":
                continue
            if (p / "request.repair.json").is_file():
                repairs += 1
            if (p / "request.retry.json").is_file():
                retries += 1
        for rt_path in sorted(bdir.glob("run_*.runtimes.json")):
            rt_data = read_optional_dict(rt_path)
            for v in rt_data.values():
                num = telemetry.valid_nonneg_num(v)
                if num is not None:
                    test_runtime_s += num
    return {**usage, "repairs": repairs, "retries": retries}, round(test_runtime_s, 3)


def record(pr: str, hdir: Path | None = None, out_path: Path | None = None) -> dict[str, Any]:
    hdir = hdir or hunt_dir(pr)
    state = read_state(hdir)
    out_file = ledger_path(out_path)
    counts, caught_by_tag, reached, executable, mode_gaps = _aggregate_modes(hdir)
    deferred_count, skip_reasons = _skipped_info(hdir)

    verdict_doc = read_optional_dict(hdir / "review_verdicts.json")
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

    pr_tests_data = read_optional_dict(hdir / "pr_tests.json")
    pr_tests_map = pr_tests_data.get("tests")
    pr_statuses = sorted(set(pr_tests_map.values())) if isinstance(pr_tests_map, dict) else []
    cov_data = read_optional_dict(hdir / "run_A.coverage.json") or None
    pr_key = target_key(pr)
    escapes = _export_escapes(hdir, state, pr_key, verdicts, caught_by_tag, counts, skip_reasons, cov_data, out_file)

    batches_hunted = len(_batch_dirs(hdir))
    batches_total = int(state.get("batches") or 1)
    tier, tier_gaps = _tier_and_gaps(
        hdir, counts, reached, executable, deferred_count, batches_hunted, batches_total, mode_gaps, verdicts,
    )
    usage_info, test_runtime_s = _collect_ledger_telemetry(hdir)
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
        "usage": usage_info,
        "test_runtime_s": test_runtime_s,
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
