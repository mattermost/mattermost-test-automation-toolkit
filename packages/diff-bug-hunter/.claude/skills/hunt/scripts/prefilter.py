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
    ("*/testlib/*", "test helper"), ("*testlib*.go", "test helper"), ("*/storetest/*", "test helper"), ("*/searchtest/*", "test helper"),
    ("*/e2e-tests/*", "e2e suite"), ("e2e-tests/*", "e2e suite"),
    ("*.spec.ts", "existing test"), ("*.spec.tsx", "existing test"), ("*.spec.js", "existing test"),
    ("*/vendor/*", "vendored"), ("vendor/*", "vendored"), ("*/node_modules/*", "vendored"),
    ("*.md", "docs"), ("*.svg", "asset"), ("*.png", "asset"), ("*.scss", "style"), ("*.css", "style"),
    ("*.yml", "config"), ("*.yaml", "config"),
]
SOURCE_EXT = (".go", ".ts", ".tsx", ".js", ".jsx", ".sql")  # .sql: migrations are hunted for reviewed schema bugs

# (regex, weight). Searched in the path and in the file's added/removed lines.
# Aligned with Mattermost's internal PR risk rubric (0-10 scale; starting points to calibrate against revert history).
# Tier 1 Critical (8-10), Tier 2 High (5-7), Tier 3 Moderate (3-4). Non-source CI/Docker files stay excluded above
# because /hunt generates Go/Jest unit tests.
def _w(*stems: str, closed: tuple[str, ...] = ()) -> str:
    """Word-start regex: `stems` may continue (auth -> authz), `closed` words may not (role, not controller).
    The text is camelCase-split and lower-cased first (see _risk_text), so checkAuth reads as check_auth and a match
    never starts inside a word ('ctx.' is not 'tx.', 'concert' is not 'cert', 'block(' is not 'lock(')."""
    parts = [re.escape(s) for s in stems] + [re.escape(c) + r"(?![a-z0-9])" for c in closed]
    return r"(?<![a-z0-9])(?:" + "|".join(parts) + ")"


RISK: list[tuple[str, int]] = [
    (_w("auth", "permission", "session", "token", "password", "mfa", "saml", "ldap", "oauth", "guest", "secret", "crypt",
        closed=("role", "roles", "tls", "cert", "certs", "certificate", "certificates")), 10),
    (r"/store/|" + _w("sqlstore", "transaction", "commit", "rollback", "migration", "backfill", "kvstore", "upgrade")
     + r"|" + _w("tx") + r"\.|\.sql(?![a-z0-9])", 9),
    (_w("sanitiz", "escape", "parse", "unmarshal", "decode", "regexp", "validate", "isvalid", "upload", "ssrf",
        "markdown", "signature", "hmac", closed=("html",)), 9),
    (r"/api4/|/wsapi/|/plugin/|/web/|" + _w("websocket", "webhook", "handler", "router") + r"|" + _w("http") + r"\.", 8),
    (_w("sync") + r"\.|" + _w("go") + r" func|" + _w("atomic") + r"\.|" + _w("mutex", "cache", "cluster", "queue")
     + r"|" + _w("lock") + r"\(|" + _w("chan") + r" |" + _w("select") + r" \{|" + _w("job", "jobs"), 7),
    (r"/public/model/", 6),
    (_w("config", "featureflag", "feature_flag", "audit", "license"), 5),
    (_w("reducer", "selector", "dispatch") + r"|" + _w("action", "actions") + r"/", 4),
    (r"/app/|/platform/|/cmd/mmctl/|/src/components/|/src/utils/", 3),
]
_CAMEL = re.compile(r"([a-z0-9])([A-Z])")


def _risk_text(path: str, patch: str) -> str:
    changed = "\n".join(line for line in patch.splitlines() if line[:1] in "+-" and line[:3] not in ("+++", "---"))
    return _CAMEL.sub(r"\1_\2", f"{path}\n{changed}").lower()


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


def risk(f: FileDiff) -> float:
    """Max-based score plus breadth bonus (+0.5 per extra Tier 1/2 category, cap +2.0), matching Mattermost's PR risk
    rubric so a Tier 1 auth, persistence or input-handling file always outranks a multi-keyword Tier 2/3 file."""
    text = _risk_text(f.path, f.patch)
    hits = [w for rx, w in RISK if re.search(rx, text)]
    if not hits:
        return 0.0
    extra_high = max(0, sum(1 for w in hits if w >= 5) - 1)
    return max(hits) + min(2.0, 0.5 * extra_high)


MAX_CALLER_BONUS = 1.0
CALLER_BONUS_AT = 20  # callers at which the bonus saturates


def rank_score(f: FileDiff, callers: dict[str, int] | None = None) -> float:
    """risk x callers: the risk score plus up to +1.0 for how many places call the file's changed symbols. The bonus
    is below the 2-point gap between tiers' base weights, so a Tier 1 file still outranks a busier Tier 3 one."""
    n = (callers or {}).get(f.path, 0)
    return risk(f) + MAX_CALLER_BONUS * min(n, CALLER_BONUS_AT) / CALLER_BONUS_AT


def plan(files: list[FileDiff], max_files: int = MAX_FILES, max_lines: int = MAX_LINES,
         callers: dict[str, int] | None = None) -> Plan:
    """Exclude, rank by (risk x callers desc, size desc, path), then pack greedily: a batch holds at most max_files files and
    max_lines changed lines. A single file larger than max_lines gets a batch of its own and is marked oversize."""
    out = Plan()
    keep = []
    for f in files:
        reason = excluded(f.path)
        if reason:
            out.skipped.append((f.path, reason))
        else:
            keep.append(f)
    keep.sort(key=lambda f: (-rank_score(f, callers), -f.lines, f.path))
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
            over = " (oversize: batch of its own)" if f.lines > MAX_LINES else ""
            lines.append(f"{tag}\t{f.path}\trisk={risk(f):g} lines={f.lines}{over}")
    lines += [f"EXCLUDED\t{path}\t{reason}" for path, reason in p.skipped]
    return lines
