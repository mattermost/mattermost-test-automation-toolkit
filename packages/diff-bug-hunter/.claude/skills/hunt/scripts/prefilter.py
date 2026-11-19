# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Large-diff guard: drop files hunters must never see, rank the rest by bug risk, cut into small batches.

Pure functions, no I/O, so the self-tests can feed synthetic 1,000+ file diffs.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field

MAX_FILES = 5
MAX_LINES = 800

# (glob, reason). Matched against the repo-relative path.
EXCLUDE: list[tuple[str, str]] = [
    ("*package-lock.json", "lockfile"), ("*yarn.lock", "lockfile"), ("*pnpm-lock.yaml", "lockfile"),
    ("*go.sum", "lockfile"), ("*go.mod", "module file"),
    ("*.pb.go", "generated"), ("*_gen.go", "generated"), ("*.gen.go", "generated"), ("*_generated.*", "generated"),
    ("*/mocks/*", "generated mock"), ("*/mock_*.go", "generated mock"), ("*/retrylayer/*", "generated layer"),
    ("*/timerlayer/*", "generated layer"),
    ("*.snap", "snapshot"), ("*/__snapshots__/*", "snapshot"),
    ("*/i18n/*.json", "translations"), ("i18n/*.json", "translations"),
    ("*_test.go", "existing test"), ("*.test.ts", "existing test"), ("*.test.tsx", "existing test"),
    ("*.test.js", "existing test"), ("*.test.jsx", "existing test"), ("*/tests/*", "existing test"),
    ("*/testlib/*", "test helper"), ("*testlib*.go", "test helper"), ("*/storetest/*", "test helper"),
    ("*/e2e-tests/*", "e2e suite"), ("e2e-tests/*", "e2e suite"),
    ("*.spec.ts", "existing test"), ("*.spec.tsx", "existing test"), ("*.spec.js", "existing test"),
    ("*/vendor/*", "vendored"), ("vendor/*", "vendored"), ("*/node_modules/*", "vendored"),
    ("*.md", "docs"), ("*.svg", "asset"), ("*.png", "asset"), ("*.scss", "style"), ("*.css", "style"),
    ("*.yml", "config"), ("*.yaml", "config"),
]
SOURCE_EXT = (".go", ".ts", ".tsx", ".js", ".jsx")

# (regex, weight). Searched in the path and in the file's added/removed lines.
RISK: list[tuple[str, int]] = [
    (r"auth|permission|session|token|password|mfa|saml|ldap|oauth|guest|sanitiz|escape|role", 10),
    (r"parse|unmarshal|decode|regexp|validate|isvalid", 8),
    (r"sync\.|go func|atomic\.|mutex|lock\(|chan |select \{", 7),
    (r"/api4/|/web/|handler|router|http\.", 6),
    (r"/store/|sqlstore|transaction|tx\.|commit|rollback", 6),
    (r"reducer|actions?/|selectors?/|dispatch\(", 5),
    (r"/app/|/platform/", 3),
]


@dataclass
class FileDiff:
    path: str
    added: int
    removed: int
    patch: str = ""

    @property
    def lines(self) -> int:
        return self.added + self.removed


@dataclass
class Plan:
    batches: list[list[FileDiff]] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (path, reason)


def excluded(path: str) -> str | None:
    for glob, reason in EXCLUDE:
        if fnmatch.fnmatch(path, glob):
            return reason
    if not path.endswith(SOURCE_EXT):
        return "not source"
    return None


def risk(f: FileDiff) -> int:
    changed = "\n".join(line for line in f.patch.splitlines() if line[:1] in "+-" and line[:3] not in ("+++", "---"))
    text = f"{f.path}\n{changed}".lower()
    return sum(w for rx, w in RISK if re.search(rx, text))


def plan(files: list[FileDiff], max_files: int = MAX_FILES, max_lines: int = MAX_LINES) -> Plan:
    """Exclude, rank by (risk desc, size desc, path), then pack greedily: a batch holds at most max_files files and
    max_lines changed lines. A single file larger than max_lines gets a batch of its own and is marked oversize."""
    out = Plan()
    keep = []
    for f in files:
        reason = excluded(f.path)
        if reason:
            out.skipped.append((f.path, reason))
        else:
            keep.append(f)
    keep.sort(key=lambda f: (-risk(f), -f.lines, f.path))
    cur: list[FileDiff] = []
    cur_lines = 0
    for f in keep:
        if f.lines > max_lines:  # close the open batch first so batches stay in risk order
            if cur:
                out.batches.append(cur)
                cur, cur_lines = [], 0
            out.batches.append([f])
            continue
        if cur and (len(cur) >= max_files or cur_lines + f.lines > max_lines):
            out.batches.append(cur)
            cur, cur_lines = [], 0
        cur.append(f)
        cur_lines += f.lines
    if cur:
        out.batches.append(cur)
    return out


def describe(p: Plan, batch: int) -> list[str]:
    """Human log lines: what this batch hunts, what is deferred to other batches, what is excluded and why."""
    lines = [f"{len(p.batches)} batch(es); hunting batch {batch}"]
    for i, b in enumerate(p.batches, 1):
        for f in b:
            tag = "HUNT" if i == batch else f"DEFERRED to batch {i}"
            over = " (oversize: diff truncated)" if f.lines > MAX_LINES else ""
            lines.append(f"{tag}\t{f.path}\trisk={risk(f)} lines={f.lines}{over}")
    lines += [f"EXCLUDED\t{path}\t{reason}" for path, reason in p.skipped]
    return lines
