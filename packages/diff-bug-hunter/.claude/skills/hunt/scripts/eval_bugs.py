#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Generalized MatterWolf benchmark & monotonic diff gate built on eval_reverts.

usage: eval_bugs.py <manifest.json> [--repo <git dir>] [--signals hunters,diff,old,pr,review] [--skip-missing] [--validate-only] ...
       eval_bugs.py diff <baseline_scorecard.json> <candidate_scorecard.json> [--max-fp 0.05]
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
import sys
from pathlib import Path

import eval_reverts


def _cmd_diff(args: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="eval_bugs.py diff")
    ap.add_argument("baseline", type=Path)
    ap.add_argument("candidate", type=Path)
    ap.add_argument("--max-fp", type=float, default=0.05)
    ns = ap.parse_args(args)
    try:
        base = json.loads(ns.baseline.read_text())
        cand = json.loads(ns.candidate.read_text())
        res = eval_reverts.diff_scorecards(base, cand, max_fp=ns.max_fp)
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
    args = sys.argv if argv is None else argv
    if len(args) >= 2 and args[1] == "diff":
        return _cmd_diff(args[2:])
    return eval_reverts.main(args)


if __name__ == "__main__":
    sys.exit(main())
