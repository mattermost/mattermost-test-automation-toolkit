#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Mode R (Review-Claim Verifier): fetch and filter CodeRabbit review threads, build Mode R context, and resolve verdicts.

usage: review_threads.py fetch <pr>      fetch CodeRabbit threads via GraphQL and write R/threads.json
       review_threads.py verdicts <pr>   resolve per-thread verdicts (PROVEN | DISPROVEN | UNPROVABLE_DYNAMICALLY)
                                         from R/threads.json, R/response.json, run_R.json and base_R.json into
                                         review_verdicts.json
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import json
import re
from pathlib import Path
from typing import Any

import ctx as ctx_mod
from hunt_common import (
    REPO,
    InfraError,
    git,
    hunt_dir,
    load_json,
    parse_range,
    read_state,
    sh,
    under,
    write_json,
)
from run import PACKAGE_FAILED, fingerprint

CODERABBIT_LOGINS = frozenset({"coderabbitai", "coderabbitai[bot]"})
HIGH_SEVERITIES = frozenset({"critical", "major"})
SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2, "unknown": 3, "trivial": 4, "nitpick": 5, "info": 6}
TRIAGE_ORDER = {"open_current": 0, "resolved_not_outdated": 1, "open_outdated_high_severity": 2}
CODE_SUFFIXES = (".go", ".ts", ".tsx", ".js", ".jsx")
MAX_THREADS = 15
MAX_PAGES = 20
MAX_EXTRA_REF_FILES = 8
THREAD_WINDOW = 60

GRAPHQL_QUERY = """
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          comments(first: 20) {
            nodes {
              id
              databaseId
              url
              author { login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}
"""

_V1_BADGE = re.compile(r"</picture>\s*\*?\s*(critical|major|minor|trivial|nitpick|info)\b", re.I)
_LEGACY_BADGE = re.compile(r"_[🔴🟠🟡🔵🧹⚠️🛠️\s]*(critical|major|minor|trivial|nitpick)_", re.I)
_BOLD_BADGE = re.compile(r"^\*\*\s*(critical|major|minor|trivial|nitpick|info)\s*\*\*(?:\s*·|\s*$)", re.I | re.M)
_ICON_BADGE = re.compile(r"review-comment-icons-v1/(critical|major|minor|trivial|amber)-", re.I)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
_INNER_DETAILS_BLOCK = re.compile(r"<details\b[^>]*>(?:(?!</?details\b).)*?</details>", re.I | re.S)
_PICTURE_BLOCK = re.compile(r"<picture\b[^>]*>.*?</picture>", re.I | re.S)
_PATH_REF = re.compile(r"(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.(?:go|tsx?|jsx?))(?::(\d+))?")
_BASENAME_LINE_REF = re.compile(r"(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+\.(?:go|tsx?|jsx?)):(\d+)")
_BADGE_LINE = re.compile(
    r"^(?:\*\*\s*(?:critical|major|minor|trivial|nitpick|info)\s*\*\*(?:\s*·|\s*$)|_[^_]+_\s*(?:\|\s*_[^_]+_\s*)*$)",
    re.I,
)
_BASE_VERDICT_PRIORITY = (
    "NEW_PR_BUG", "NEW_API", "BASE_FAILS_DIFFERENTLY", "BASE_UNCOMPILABLE",
    "NOT_RUN_ON_BASE", "SKIP", "UNVETTED", "PRE_EXISTING",
)


def is_coderabbit(login: str) -> bool:
    return login.strip().lower() in CODERABBIT_LOGINS


def parse_severity(body: str) -> str:
    """Extract CodeRabbit severity from v1 or legacy header badges before any <details> or code fence."""
    header_lines: list[str] = []
    for line in body.splitlines():
        s = line.strip()
        if s.startswith(("<details", "```")):
            break
        if s:
            header_lines.append(s)
        if len(header_lines) >= 12:
            break
    header = "\n".join(header_lines)
    for rx in (_V1_BADGE, _LEGACY_BADGE, _BOLD_BADGE):
        m = rx.search(header)
        if m:
            return m.group(1).lower()
    m = _ICON_BADGE.search(header)
    if m:
        raw = m.group(1).lower()
        return "minor" if raw == "amber" else raw
    return "unknown"


def _strip_details(text: str) -> str:
    """Remove arbitrarily nested <details>...</details> blocks from innermost outward."""
    prev = text
    for _ in range(10):
        cur = _INNER_DETAILS_BLOCK.sub("", prev)
        if cur == prev:
            break
        prev = cur
    return prev


def clean_body(body: str, max_chars: int = 2000) -> str:
    """Strip HTML comments, <picture> icons, and <details> dumps (Analysis chain / AI prompt / suggested diff)."""
    no_comments = _HTML_COMMENT.sub("", body)
    stripped = _strip_details(no_comments)
    text = stripped if stripped.strip() else no_comments
    text = _PICTURE_BLOCK.sub("", text)
    text = re.sub(r"\*\*\s+(?=(?:critical|major|minor|trivial|nitpick|info)\*\*)", "**", text, flags=re.I)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > max_chars:
        return text[:max_chars].rstrip() + "\n...(truncated)"
    return text


def extract_title(cleaned: str) -> str:
    for line in cleaned.splitlines():
        s = line.strip()
        if not s or _BADGE_LINE.match(s):
            continue
        m = re.fullmatch(r"\*\*(.+?)\*\*", s)
        if m:
            return m.group(1).strip()[:140]
        return s[:140]
    return ""


def fetch_graphql(pr: str, repo: str = REPO) -> list[dict[str, Any]]:
    """Fetch all PR review threads from GitHub GraphQL API with cursor pagination."""
    if "/" not in repo:
        raise InfraError(f"invalid HUNT_REPO {repo!r}: expected owner/repo")
    pr_s = str(pr).strip()
    if not pr_s.isdigit():
        raise InfraError(f"invalid PR number {pr!r}: expected digits")
    owner, name = repo.split("/", 1)
    threads: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        args = ["gh", "api", "graphql", "-f", f"query={GRAPHQL_QUERY}",
                "-f", f"owner={owner}", "-f", f"repo={name}", "-F", f"pr={int(pr_s)}"]
        if cursor is not None:
            args += ["-f", f"cursor={cursor}"]
        raw = sh(args, Path("."), timeout=120).stdout
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise InfraError(f"invalid GraphQL JSON for PR #{pr}: {e}") from e
        if data.get("errors"):
            raise InfraError(f"GraphQL error for PR #{pr}: {json.dumps(data['errors'])[:600]}")
        pr_node = ((data.get("data") or {}).get("repository") or {}).get("pullRequest")
        if pr_node is None:
            raise InfraError(f"PR #{pr} not found in {repo}")
        rt = pr_node.get("reviewThreads") or {}
        threads.extend(node for node in (rt.get("nodes") or []) if node)
        page = rt.get("pageInfo") or {}
        if not page.get("hasNextPage") or not page.get("endCursor"):
            break
        cursor = str(page["endCursor"])
    return threads


def filter_threads(raw_threads: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Filter GraphQL reviewThreads to CodeRabbit-only threads using the 2x2 (isResolved, isOutdated) policy:
      - !isOutdated (any isResolved, any severity): INCLUDE (catches both open bugs and silent dismissals)
      - isResolved && isOutdated: SKIP (addressed / stale)
      - !isResolved && isOutdated: INCLUDE only if severity is critical/major; SKIP minor/trivial/nitpick/unknown
    Returns (included, skipped, non_coderabbit_count).
    """
    kept: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    non_cr = 0
    for node in raw_threads:
        comments = ((node.get("comments") or {}).get("nodes") or [])
        if not comments:
            continue
        root = comments[0]
        login = ((root.get("author") or {}).get("login") or "")
        if not is_coderabbit(login):
            non_cr += 1
            continue
        path = str(node.get("path") or "")
        line = node.get("line") or node.get("originalLine")
        resolved = bool(node.get("isResolved"))
        outdated = bool(node.get("isOutdated"))
        body_raw = str(root.get("body") or "")
        severity = parse_severity(body_raw)
        cleaned = clean_body(body_raw, max_chars=2000)
        title = extract_title(cleaned)
        base_entry: dict[str, Any] = {
            "thread_id": str(node.get("id") or ""),
            "url": str(root.get("url") or ""),
            "author": login,
            "path": path,
            "line": line,
            "original_line": node.get("originalLine"),
            "is_resolved": resolved,
            "is_outdated": outdated,
            "severity": severity,
            "title": title,
        }
        if resolved and outdated:
            skipped.append({**base_entry, "reason": "resolved and outdated"})
            continue
        if not resolved and outdated:
            if severity not in HIGH_SEVERITIES:
                skipped.append({**base_entry, "reason": f"unresolved outdated low severity ({severity})"})
                continue
            triage = "open_outdated_high_severity"
        else:
            triage = "resolved_not_outdated" if resolved else "open_current"
        if not path.endswith(CODE_SUFFIXES):
            skipped.append({**base_entry, "reason": "non-code path"})
            continue
        replies = []
        raw_replies = comments[1:3] + comments[-4:] if len(comments) > 7 else comments[1:]
        for rep in raw_replies:
            r_login = ((rep.get("author") or {}).get("login") or "unknown")
            r_text = clean_body(str(rep.get("body") or ""), max_chars=800)
            if r_text:
                replies.append({"author": r_login, "body": r_text})
        kept.append({**base_entry, "triage": triage, "body": cleaned, "replies": replies})
    kept.sort(key=lambda t: (
        TRIAGE_ORDER.get(t["triage"], 9),
        SEVERITY_ORDER.get(t["severity"], 9),
        t["path"],
        t["line"] or 0,
    ))
    overflow = kept[MAX_THREADS:]
    kept = kept[:MAX_THREADS]
    for ov in overflow:
        skipped.append({k: ov[k] for k in ("thread_id", "url", "author", "path", "line", "original_line",
                                           "is_resolved", "is_outdated", "severity", "title")}
                       | {"reason": f"over {MAX_THREADS} thread cap"})
    for idx, item in enumerate(kept, 1):
        item["id"] = f"CR{idx}"
    return kept, skipped, non_cr


def referenced_files(wt: Path, threads: list[dict[str, Any]]) -> tuple[list[str], dict[str, list[int]]]:
    """Ordered unique repo-relative code files from thread paths + file:line references inside bodies, plus focus lines."""
    files: list[str] = []
    seen: set[str] = set()
    focus: dict[str, list[int]] = {}

    def add(rel: str, ln: int | None) -> bool:
        try:
            p = under(wt, rel)
        except ValueError:
            return False
        if (wt / rel).is_symlink() or p.is_symlink() or not p.is_file() or not rel.endswith(CODE_SUFFIXES):
            return False
        if ln is not None and ln > 0:
            focus.setdefault(rel, []).append(ln)
        if rel not in seen:
            seen.add(rel)
            files.append(rel)
            return True
        return False

    for t in threads:
        add(t["path"], t["line"])
    extra = 0
    for t in threads:
        texts = [t["body"]] + [r["body"] for r in t.get("replies", [])]
        for txt in texts:
            for m in _PATH_REF.finditer(txt):
                rel = m.group(1)
                ln = int(m.group(2)) if m.group(2) else None
                if rel in seen:
                    if ln:
                        focus.setdefault(rel, []).append(ln)
                    continue
                if extra >= MAX_EXTRA_REF_FILES:
                    continue
                if add(rel, ln):
                    extra += 1
    by_name: dict[str, list[str]] = {}
    for rel in files:
        by_name.setdefault(Path(rel).name, []).append(rel)
    for t in threads:
        texts = [t["body"]] + [r["body"] for r in t.get("replies", [])]
        for txt in texts:
            for m in _BASENAME_LINE_REF.finditer(txt):
                name, ln = m.group(1), int(m.group(2))
                if ln <= 0:
                    continue
                if t["path"] in seen and Path(t["path"]).name == name:
                    focus.setdefault(t["path"], []).append(ln)
                elif len(by_name.get(name, ())) == 1:
                    focus.setdefault(by_name[name][0], []).append(ln)
    return files, {k: sorted(set(v)) for k, v in focus.items()}


def review_targets(wt: Path, files: list[str], extra_paths: list[str] | None = None) -> list[dict[str, str]]:
    """Test target file paths for Mode R across all dirs referenced by qualifying CodeRabbit threads."""
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for f in [*files, *(extra_paths or [])]:
        d = str(Path(f).parent)
        lang = "go" if f.endswith(".go") else "jest"
        if (d, lang) in seen:
            continue
        try:
            dpath = under(wt, d)
        except ValueError:
            continue
        if not dpath.is_dir():
            continue
        seen.add((d, lang))
        if lang == "go":
            # Prefer a non-test Go file in `d` for package name (a *_test.go file might use package foo_test).
            prod = sorted(p for p in dpath.glob("*.go") if not p.name.endswith("_test.go") and not p.name.startswith("hunt_"))
            sample = prod[0] if prod else (wt / f if (wt / f).is_file() else next(iter(sorted(dpath.glob("*.go"))), None))
            m = re.search(r"^package (\w+)", sample.read_text(errors="replace"), re.M) if sample else None
            out.append({"lang": "go", "dir": d, "path": f"{d}/hunt_huntr_test.go", "package": m.group(1) if m else "?"})
        else:
            out.append({"lang": "jest", "dir": d, "path": f"{d}/hunt_r.test.tsx"})
    return out


def thread_source_view(wt: Path, path: str, patch: str, focus_lines: list[int]) -> str:
    """Full numbered file if <= MAX_SOURCE_LINES, else merged windows around diff hunks AND thread focus lines."""
    lines = (wt / path).read_text(errors="replace").split("\n")
    if len(lines) <= ctx_mod.MAX_SOURCE_LINES:
        return ctx_mod.numbered(lines, 1, len(lines))
    spans: list[tuple[int, int]] = []
    for start, n in ctx_mod.hunk_ranges(patch):
        a, b = max(1, start - 40), min(len(lines), start + n + 40)
        if a <= b:
            spans.append((a, b))
    for ln in focus_lines:
        clamped = min(len(lines), max(1, ln))
        a, b = max(1, clamped - THREAD_WINDOW), min(len(lines), clamped + THREAD_WINDOW)
        if a <= b:
            spans.append((a, b))
    if not spans:
        return ctx_mod.numbered(lines, 1, min(len(lines), 120))
    spans.sort()
    merged: list[tuple[int, int]] = [spans[0]]
    for a, b in spans[1:]:
        pa, pb = merged[-1]
        if a <= pb + 1:
            merged[-1] = (pa, max(pb, b))
        else:
            merged.append((a, b))
    return "\n   ...\n".join(ctx_mod.numbered(lines, a, b) for a, b in merged)


def build_review_context(pr: str, hdir: Path, state: dict[str, Any], ctx_data: dict[str, Any],
                         raw_threads: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Fetch/filter CodeRabbit threads, write R/threads.json, and return (meta, user_payload_or_None)."""
    if raw_threads is None and (parse_range(pr) is not None or not str(pr).isdigit()):
        meta: dict[str, Any] = {"pr": pr, "included": [], "skipped": [], "targets": [], "non_coderabbit": 0,
                                "skipped_reason": "range target (not a GitHub PR)"}
        write_json(hdir / "R" / "threads.json", meta)
        return meta, None
    fetched = fetch_graphql(pr) if raw_threads is None else raw_threads
    included, skipped, non_cr = filter_threads(fetched)
    wt, repo = Path(state["wt"]), Path(state["repo"])
    mb, head = state["merge_base"], state["head"]
    files, focus = referenced_files(wt, included)
    deleted_thread_paths = [t["path"] for t in included if t["path"] not in files]
    targets = review_targets(wt, files, extra_paths=deleted_thread_paths)
    meta = {"pr": pr, "included": included, "skipped": skipped, "targets": targets, "non_coderabbit": non_cr}
    tpath = hdir / "R" / "threads.json"
    if tpath.exists():
        try:
            prev_ids = [t.get("thread_id") for t in _read_json_dict(tpath).get("included", []) if isinstance(t, dict)]
        except InfraError:
            prev_ids = []
        new_ids = [t.get("thread_id") for t in included]
        if prev_ids != new_ids:
            for stale in (
                hdir / "R" / "response.json", hdir / "R" / "request.json",
                hdir / "R" / "request.repair.json", hdir / "R" / "request.retry.json",
                hdir / "run_R.json", hdir / "run_R.response.sha256",
                hdir / "base_R.json", hdir / "base_R.response.sha256",
                hdir / "compile_R.log", hdir / "review_verdicts.json",
            ):
                stale.unlink(missing_ok=True)
    write_json(tpath, meta)
    if not included:
        return meta, None
    patches: dict[str, str] = {}
    syms: set[str] = set()
    diff_paths = list(dict.fromkeys([*files, *deleted_thread_paths]))
    for f in diff_paths:
        p = git(repo, "diff", mb, head, "--", f, check=False)
        patches[f] = "\n".join(p.splitlines()[:900])
        if p:
            syms |= ctx_mod.changed_symbols(p, ctx_mod.lang_of(f))
    user: dict[str, Any] = {
        "pr": ctx_data.get("pr", {"number": int(pr) if str(pr).isdigit() else 0, "title": "", "description": ""}),
        "review_threads": [
            {k: t[k] for k in ("id", "path", "line", "is_resolved", "is_outdated", "triage", "severity",
                               "title", "body", "replies", "url")}
            for t in included
        ],
        "diff_production_code": "\n".join(patches[f] for f in diff_paths if patches[f]),
        "thread_files_head_source": [
            {"file": f, "source": thread_source_view(wt, f, patches[f], focus.get(f, []))}
            for f in files
        ],
        "sibling_tests_and_helpers": ctx_mod.sibling_tests(wt, files, syms),
        "your_test_files": targets,
    }
    return meta, user


def _match_tests(claim_id: str, declared: list[str], run_results: dict[str, str]) -> list[str]:
    """Map a claim CR<k> to executed test identities in run_R.json (declared names + CR<k>_ naming convention)."""
    wanted = {d.strip() for d in declared if d and d.strip()}
    pat = re.compile(rf"(?:^|::|\s)(?:Test)?HuntR_{re.escape(claim_id)}(?:_|[^A-Za-z0-9]|$)")
    matched = []
    for ident in sorted(run_results):
        tail = ident.split("::", 1)[1] if "::" in ident else ident
        if (ident in wanted or any(tail == w or tail.endswith(" " + w) for w in wanted) or pat.search(ident)):
            matched.append(ident)
    return matched


def _artifact_fresh(data_path: Path, sha_path: Path, expected_digest: str | None, fallback_ok: bool = True) -> bool:
    if not data_path.exists() or expected_digest is None:
        return False
    if sha_path.exists():
        return sha_path.read_text().strip() == expected_digest
    return fallback_ok


def _read_json_dict(path: Path, *, repair: bool = False) -> dict[str, Any]:
    try:
        data = load_json(path) if repair else json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise InfraError(f"invalid JSON in {path}: {e}") from e
    if not isinstance(data, dict):
        raise InfraError(f"expected JSON object in {path}")
    return data


def compute_verdicts(hdir: Path) -> dict[str, Any]:
    """Deterministically resolve PROVEN | DISPROVEN | UNPROVABLE_DYNAMICALLY per CodeRabbit thread."""
    tpath = hdir / "R" / "threads.json"
    if not tpath.exists():
        raise InfraError(f"{tpath} missing: run `build_requests.py <pr> review` first")
    meta = _read_json_dict(tpath)
    included: list[dict[str, Any]] = meta.get("included", [])
    resp_path = hdir / "R" / "response.json"
    run_path = hdir / "run_R.json"
    base_path = hdir / "base_R.json"
    resp = _read_json_dict(resp_path, repair=True) if resp_path.exists() else {}
    raw_files = resp.get("files")
    valid_files = [f for f in raw_files if isinstance(f, dict) and "path" in f and "content" in f] if isinstance(raw_files, list) else []
    digest = fingerprint(valid_files) if isinstance(raw_files, list) and len(valid_files) == len(raw_files) else None
    run_fresh = _artifact_fresh(run_path, hdir / "run_R.response.sha256", digest)
    run_res: dict[str, str] = _read_json_dict(run_path) if run_fresh else {}
    base_mtime_ok = not run_path.exists() or base_path.stat().st_mtime >= run_path.stat().st_mtime if base_path.exists() else False
    base_fresh = run_fresh and _artifact_fresh(base_path, hdir / "base_R.response.sha256", digest, fallback_ok=base_mtime_ok)
    base_res: dict[str, Any] = _read_json_dict(base_path) if base_fresh else {}
    claims_by_id = {str(c.get("id", "")): c for c in resp.get("claims", []) if isinstance(c, dict)}
    compile_failed = (hdir / "compile_R.log").exists() and not run_fresh
    pkg_fails = sorted(k for k in run_res if k.endswith(f"::{PACKAGE_FAILED}"))

    verdicts: dict[str, dict[str, Any]] = {}
    for t in included:
        cid = t["id"]
        claim = claims_by_id.get(cid, {})
        declared = [str(x) for x in claim.get("tests", [])] if isinstance(claim.get("tests"), list) else []
        matched = _match_tests(cid, declared, run_res)
        statuses = {m: run_res[m] for m in matched}
        failing = [m for m, s in statuses.items() if s == "FAIL_3_OF_3"]
        pkg_fail_key = f"{Path(t['path']).parent}::{PACKAGE_FAILED}"
        entry: dict[str, Any] = {
            "id": cid,
            "path": t["path"],
            "line": t["line"],
            "severity": t["severity"],
            "triage": t["triage"],
            "is_resolved": t["is_resolved"],
            "is_outdated": t["is_outdated"],
            "title": t["title"],
            "url": t["url"],
            "tests": statuses,
        }
        if failing:
            if not base_res:
                bv = "UNVETTED"
            elif base_res.get("*") == "BASE_UNCOMPILABLE":
                bv = "BASE_UNCOMPILABLE"
            else:
                bvs = [
                    "UNVETTED" if str(base_res.get(m, "")) in ("", "NOT_A_HEAD_FAILURE") else str(base_res[m])
                    for m in failing
                ]
                bv = next((p for p in _BASE_VERDICT_PRIORITY if p in bvs), bvs[0])
            if bv == "UNVETTED":
                pr_ref = str(meta.get("pr") or "<pr>")
                entry["verdict"] = "UNPROVABLE_DYNAMICALLY"
                entry["base_verdict"] = "UNVETTED"
                entry["reason"] = (
                    f"failing 3/3 on head ({', '.join(failing)}), but merge-base vetting is missing or stale; "
                    f"run `run.py base {pr_ref} R` then rerun `review_threads.py verdicts {pr_ref}`"
                )
            else:
                entry["verdict"] = "PROVEN"
                entry["base_verdict"] = bv
                entry["reason"] = f"failing 3/3 on head ({', '.join(failing)}); merge-base={bv}"
        elif claim.get("testable") is False:
            entry["verdict"] = "UNPROVABLE_DYNAMICALLY"
            entry["base_verdict"] = ""
            entry["reason"] = str(claim.get("reason") or "marked untestable dynamically by Mode R")
        elif matched and all(s == "PASS" for s in statuses.values()):
            entry["verdict"] = "DISPROVEN"
            entry["base_verdict"] = ""
            entry["reason"] = f"all linked tests passed 3/3 on head ({', '.join(matched)})"
        elif any(s in ("FLAKY", "SKIP") for s in statuses.values()):
            bad = [f"{m}={s}" for m, s in statuses.items() if s in ("FLAKY", "SKIP")]
            entry["verdict"] = "UNPROVABLE_DYNAMICALLY"
            entry["base_verdict"] = ""
            entry["reason"] = f"inconclusive test execution ({', '.join(bad)})"
        else:
            entry["verdict"] = "UNPROVABLE_DYNAMICALLY"
            entry["base_verdict"] = ""
            if compile_failed:
                entry["reason"] = "Mode R tests failed to compile (see compile_R.log)"
            elif pkg_fail_key in run_res:
                entry["reason"] = f"package failed before test result ({pkg_fail_key}: {run_res[pkg_fail_key]})"
            elif pkg_fails:
                entry["reason"] = f"package failed before test result ({', '.join(pkg_fails)})"
            elif not run_fresh and valid_files:
                pr_ref = str(meta.get("pr") or "<pr>")
                entry["reason"] = (
                    f"Mode R tests written, but run_R.json is missing or stale; "
                    f"run `run.py run {pr_ref} R` then rerun `review_threads.py verdicts {pr_ref}`"
                )
            else:
                entry["reason"] = str(claim.get("reason") or "no linked test executed")
        verdicts[cid] = entry

    out = {
        "pr": meta.get("pr"),
        "verdicts": verdicts,
        "skipped": meta.get("skipped", []),
        "non_coderabbit": meta.get("non_coderabbit", 0),
        "skipped_reason": meta.get("skipped_reason", ""),
    }
    write_json(hdir / "review_verdicts.json", out)
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("fetch", "verdicts"):
        print(__doc__)
        return 1
    cmd, pr = argv[1], argv[2]
    hdir = hunt_dir(pr)
    try:
        if cmd == "fetch":
            state = read_state(hdir)
            ctx_data = _read_json_dict(hdir / "ctx.json") if (hdir / "ctx.json").exists() else {}
            meta, _ = build_review_context(pr, hdir, state, ctx_data)
            if meta.get("skipped_reason"):
                print(f"[R] {meta['skipped_reason']}")
            else:
                print(f"[R] {len(meta['included'])} qualifying CodeRabbit thread(s), "
                      f"{len(meta['skipped'])} skipped, {meta['non_coderabbit']} non-CodeRabbit ignored")
                for t in meta["included"]:
                    print(f"  {t['id']} [{t['triage']} {t['severity']}] {t['path']}:{t['line']} - {t['title']}")
        else:
            out = compute_verdicts(hdir)
            if not out["verdicts"]:
                note = out["skipped_reason"] or f"0 qualifying CodeRabbit threads ({len(out['skipped'])} skipped)"
                print(f"[R verdicts] {note}")
            for cid, v in out["verdicts"].items():
                bv = f" ({v['base_verdict']})" if v["base_verdict"] else ""
                print(f"[R verdicts] {cid}: {v['verdict']}{bv} — {v['path']}:{v['line']} — {v['reason']}")
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
