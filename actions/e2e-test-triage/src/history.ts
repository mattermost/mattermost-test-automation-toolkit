// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { FetchImpl, GhApi } from "../../shared/src/github.ts";
import { identityKey, outcomeOf } from "../../shared/src/tsio.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { CHANGED_FILES_MAX_PAGES, COMPARE_FILE_CAP, DEFAULTS, HISTORY_MAX_FILES, HISTORY_MAX_PAGES, HISTORY_PER_PAGE, laneOf } from "./config.ts";
import type { BrokeBy, ChangedFile, Config, Finding, Observation, OutOfDate, TestRef } from "./types.ts";

/** TSIO's history for a run's tests: rows by test identity, with the flags the rules read. */
export interface History extends Map<string, Observation[]> {
  truncated: boolean;
  reportUnknown: boolean;
  ambiguous: Set<string>;
}

interface HistoryPage {
  observations?: Observation[];
  has_more?: boolean;
}

const HISTORY_RETRY_MS = 500;

/**
 * POSTs one history page. A timeout, a dropped connection or a 5xx answer is retried once after a short pause;
 * any other answer is returned for the caller to refuse. Each attempt has its own timeout.
 */
async function postHistory(fetchImpl: FetchImpl, url: string, body: Record<string, unknown>): Promise<Response> {
  let failure: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise<void>((resolve) => setTimeout(resolve, HISTORY_RETRY_MS));
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (res.status < 500) return res;
      failure = new Error(`TSIO history ${res.status}`);
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
}

/**
 * Past runs of the failing tests, keyed by identityKey. Asks for whole spec files
 * and matches tests here; a renamed test finds nothing and stays blocking.
 * Two queries: the trunk branch's last trunkRuns runs, and the last crossPRRuns
 * runs anywhere (other PRs).
 */
export async function fetchHistory(
  fetchImpl: FetchImpl,
  base: string,
  repository: string,
  tests: TestRef[],
  until: string,
  cfg: Config = DEFAULTS,
  trunkBranch: string | null | undefined = null,
  reportName: string | null = null,
  warn: (message: string) => void = () => {},
  lane: string | null = null,
): Promise<History> {
  const byTest = Object.assign(new Map<string, Observation[]>(), {
    truncated: false,
    reportUnknown: false, // rows can't say which report (platform) they came from
    ambiguous: new Set<string>(), // tests whose rows can't be tied to them alone
  });
  const files = [...new Set(tests.map((t) => t.file).filter(Boolean))].slice(0, HISTORY_MAX_FILES);
  if (files.length === 0) return byTest;
  const byLeaf = new Map<string, TestRef[]>();
  for (const t of tests) {
    const leaf = `${t.file}\n${t.title}`;
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf)!.push(t);
  }
  const queries: { branch?: string; runs: number }[] = [];
  if (trunkBranch) queries.push({ branch: trunkBranch, runs: cfg.trunkRuns });
  queries.push({ runs: cfg.crossPRRuns });
  // The trunk query overlaps the other, so rows with a group id are deduplicated.
  const seen = new Map<string, string>();
  const ancestryByLeaf = new Map<string, Set<string>>();
  const fallbackByLeaf = new Map<string, Set<string>>();
  const dedupe = queries.length > 1;
  for (const q of queries) {
    for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
      const body: Record<string, unknown> = { repository, until, files, page, per_page: HISTORY_PER_PAGE, ...q };
      if (reportName) body.report = reportName;
      const res = await postHistory(fetchImpl, `${base}/api/v1/reports/history`, body);
      if (!res.ok) throw new Error(`TSIO history ${res.status}`);
      const page_ = (await res.json()) as HistoryPage;
      const observations = page_.observations ?? [];
      const hasMore = page_.has_more;
      for (const o of observations) {
        const leaf = `${o.file}\n${o.title}`;
        const candidates = byLeaf.get(leaf);
        if (!candidates) continue;
        // Another lane's rows are never evidence, nor grounds for ambiguity.
        if (lane != null && o.name != null && laneOf(o.name) !== lane) continue;
        if (reportName) {
          if (!o.report_name) byTest.reportUnknown = true;
          else if (!String(o.report_name).startsWith(reportName)) continue;
        }
        const ancestry = o.full_title || o.suite_title;
        if (ancestry) {
          if (!ancestryByLeaf.has(leaf)) ancestryByLeaf.set(leaf, new Set());
          ancestryByLeaf.get(leaf)!.add(ancestry);
        }
        // Full titles settle which test a row is; without them a shared name can't be used.
        let test: TestRef | null = null;
        const comparable = Boolean(o.full_title) && candidates.every((c) => c.full_title);
        if (comparable) {
          test = candidates.find((c) => c.full_title === o.full_title) ?? null;
          if (!test) continue;
        } else if (candidates.length > 1 || candidates[0].identity_ambiguous) {
          for (const c of candidates) byTest.ambiguous.add(identityKey(c));
          continue;
        } else {
          test = candidates[0];
          // One qualified side cannot prove the ancestry of a legacy leaf row.
          if (Boolean(test.full_title) !== Boolean(o.full_title)) {
            byTest.ambiguous.add(identityKey(test));
            continue;
          }
          if (!fallbackByLeaf.has(leaf)) fallbackByLeaf.set(leaf, new Set());
          fallbackByLeaf.get(leaf)!.add(identityKey(test));
          if (test.suite_title && o.suite_title && test.suite_title !== o.suite_title)
            byTest.ambiguous.add(identityKey(test));
        }
        const k = identityKey(test);
        if (dedupe && o.group_id != null) {
          const rowKey = JSON.stringify([o.group_id, o.report_name, o.full_title, o.suite_title, k, o.retry_count, o.ordinal ?? 0]);
          const previous = seen.get(rowKey);
          if (previous !== undefined) {
            if (previous !== o.status) byTest.ambiguous.add(k);
            continue;
          }
          seen.set(rowKey, o.status);
        }
        if (!byTest.has(k)) byTest.set(k, []);
        byTest.get(k)!.push(o);
      }
      if (!hasMore) break;
      if (page === HISTORY_MAX_PAGES) {
        byTest.truncated = true;
        warn(`history for ${files.length} file(s) hit the ${HISTORY_MAX_PAGES}-page cap with more to come; nothing will be cleared on partial history`);
      }
    }
  }
  // Rows are attempts; the rules count runs. Collapse each run's attempts to one outcome.
  for (const [key, rows] of byTest) {
    const runs = new Map<string, Observation[]>();
    const collapsed: Observation[] = [];
    for (const row of rows) {
      if (row.group_id == null) {
        collapsed.push(row);
        continue;
      }
      const run = JSON.stringify([row.group_id, reportName ? row.report_name ?? "" : ""]);
      if (!runs.has(run)) runs.set(run, []);
      runs.get(run)!.push(row);
    }
    for (const attempts of runs.values()) {
      attempts.sort((a, b) => a.retry_count - b.retry_count);
      const { status, last } = outcomeOf(attempts);
      // Every run in `runs` has at least one attempt, so the outcome always has a last one.
      collapsed.push({ ...last!, status });
    }
    byTest.set(key, collapsed);
  }
  for (const [leaf, keys] of fallbackByLeaf) {
    if ((ancestryByLeaf.get(leaf)?.size ?? 0) > 1)
      for (const key of keys) byTest.ambiguous.add(key);
  }
  // One name in two reports of a run is ambiguous without a narrower report scope.
  for (const [key, rows] of byTest) {
    const reportsByGroup = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.group_id || !row.report_name) continue;
      const groupKey = String(row.group_id);
      if (!reportsByGroup.has(groupKey)) reportsByGroup.set(groupKey, new Set());
      reportsByGroup.get(groupKey)!.add(row.report_name);
    }
    if ([...reportsByGroup.values()].some((reports) => reports.size > 1)) byTest.ambiguous.add(key);
  }
  // Newest first: classify() reads trunk[0] as the latest trunk run.
  const at = (o: Observation): number => Date.parse(o.created_at ?? "") || 0;
  for (const rows of byTest.values()) rows.sort((a, b) => at(b) - at(a));
  return byTest;
}

export interface ChangedFiles {
  files: ChangedFile[];
  ok: boolean;
}

/**
 * The PR's changed files (a trunk run: the commit's), and `ok`: whether the list
 * is complete. An incomplete list looks like "touched nothing", so callers clear
 * nothing unless ok is true.
 */
export async function fetchChangedFiles(api: GhApi, id: CompositeIdentity, prNumber: number | null, log: (message: string) => void = () => {}): Promise<ChangedFiles> {
  try {
    if (prNumber) {
      const files: ChangedFile[] = [];
      for (let page = 1; page <= CHANGED_FILES_MAX_PAGES; page++) {
        const batch = (await api("GET", `/repos/${id.repository}/pulls/${prNumber}/files?per_page=100&page=${page}`)) as ChangedFile[] | null;
        files.push(...(batch ?? []));
        if (!batch || batch.length < 100) return { files, ok: true };
      }
      log(`stopped after ${CHANGED_FILES_MAX_PAGES} pages of changed files; ownership is incomplete and nothing will be cleared`);
      return { files, ok: false };
    }
    const files: ChangedFile[] = [];
    for (let page = 1; page <= CHANGED_FILES_MAX_PAGES; page++) {
      const commit = (await api("GET", `/repos/${id.repository}/commits/${id.commit_sha}?per_page=100&page=${page}`)) as { files?: ChangedFile[] } | null;
      const batch = commit?.files ?? [];
      files.push(...batch);
      if (batch.length < 100) return { files, ok: true };
    }
    log(`stopped after ${CHANGED_FILES_MAX_PAGES} pages of commit files; ownership is incomplete and nothing will be cleared`);
    return { files, ok: false };
  } catch (e) {
    log(`changed files unavailable: ${String(e).slice(0, 200)}`);
    return { files: [], ok: false };
  }
}

// ------------------------------------------------------------ out of date

interface CompareResult {
  ahead_by?: number;
  files?: { filename: string }[];
  commits?: { sha: string }[];
}

interface CommitRow {
  sha: string;
  commit?: { committer?: { date?: string | null } | null; author?: { date?: string | null } | null; message?: string | null } | null;
}

/**
 * Marks failures whose spec the base branch changed after this PR last merged it.
 * One compare call lists what the base branch changed since the merge base; a
 * second, per spec, names the commit. If GitHub can't list every changed file
 * (its compare stops at 300), nothing is marked and the result is `truncated`:
 * the caller must then treat those failures as unchecked, not as unchanged.
 */
export async function markOutOfDate({
  findings,
  api,
  id,
  baseBranch,
  log = () => {},
}: {
  findings: Finding[];
  api: GhApi;
  id: CompositeIdentity;
  baseBranch: string | null | undefined;
  log?: (message: string) => void;
}): Promise<{ truncated: boolean }> {
  if (!findings.length || !baseBranch) return { truncated: false };
  const cmp = (await api("GET", `/repos/${id.repository}/compare/${id.commit_sha}...${encodeURIComponent(baseBranch)}?per_page=100`)) as CompareResult | null;
  if (!cmp?.ahead_by) return { truncated: false };
  const files = cmp.files ?? [];
  if (files.length >= COMPARE_FILE_CAP) {
    log(`${baseBranch} changed ${files.length}+ files since this PR last merged it; too many to tell which tests changed`);
    return { truncated: true };
  }
  const changed = new Set(files.map((x) => x.filename));
  const onBase = new Set((cmp.commits ?? []).map((c) => c.sha));
  const commits = new Map<string, OutOfDate["commit"]>();
  for (const f of findings) {
    const path = f.repo_path;
    if (!path || !changed.has(path)) continue;
    if (!commits.has(path)) {
      const log_ = (await api("GET", `/repos/${id.repository}/commits?sha=${encodeURIComponent(baseBranch)}&path=${encodeURIComponent(path)}&per_page=10`).catch(() => [])) as CommitRow[] | null;
      const c = (log_ ?? []).find((x) => onBase.has(x.sha)) ?? null;
      commits.set(path, c && {
        sha: c.sha,
        date: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? "").slice(0, 10),
        pr: Number(/\(#(\d+)\)/.exec(c.commit?.message ?? "")?.[1]) || null,
      });
    }
    f.out_of_date = { base: baseBranch, behind: cmp.ahead_by, commit: commits.get(path) ?? null };
  }
  return { truncated: false };
}

// ------------------------------------------------------------ broken by

interface CompareWindow {
  total_commits?: number;
  commits?: { sha: string; commit?: { message?: string | null } | null; author?: { login?: string | null } | null }[];
}

/**
 * For tests broken on the base branch, the commits merged between the last run that
 * passed them and the first that failed: one commit names the PR that broke it.
 * Tests that broke in the same window share one compare call; at most 10 windows.
 */
export async function markBrokeBy({ findings, api, id, log = () => {} }: { findings: Finding[]; api: GhApi; id: CompositeIdentity; log?: (message: string) => void }): Promise<void> {
  const windows = new Map<string, BrokeBy | null>();
  for (const f of findings) {
    const from = f.trunk_break?.last_pass?.commit_sha;
    const to = f.trunk_break?.first_fail?.commit_sha;
    if (from === to) continue;
    const key = `${from}...${to}`;
    if (!windows.has(key)) {
      if (windows.size >= 10) continue;
      windows.set(key, await (api("GET", `/repos/${id.repository}/compare/${key}?per_page=100`) as Promise<unknown>)
        .then((raw) => {
          const c = raw as CompareWindow;
          return {
            from,
            to,
            total: c.total_commits ?? (c.commits ?? []).length,
            commits: (c.commits ?? []).slice(-5).map((x) => ({
              sha: x.sha,
              pr: Number(/\(#(\d+)\)\s*$/.exec(String(x.commit?.message ?? "").split("\n")[0])?.[1]) || null,
              author: x.author?.login ?? null,
            })),
          };
        })
        .catch((e: unknown) => (log(`commits between ${String(from).slice(0, 7)} and ${String(to).slice(0, 7)} unavailable: ${String(e).slice(0, 160)}`), null)));
    }
    const w = windows.get(key);
    if (w?.total) f.broke_by = w;
  }
}
