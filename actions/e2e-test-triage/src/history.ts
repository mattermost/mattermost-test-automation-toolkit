// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { FetchImpl, GhApi } from "../../shared/src/github.ts";
import { FAILED_STATUSES, identityKey, isFailedTry, outcomeOf, outcomeWithDuplicates, tsioJson } from "../../shared/src/tsio.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { CHANGED_FILES_MAX_PAGES, COMPARE_FILE_CAP, DEFAULTS, HISTORY_MAX_FILES, HISTORY_MAX_PAGES, HISTORY_PER_PAGE, laneOf } from "./config.ts";
import type { BrokeBy, ChangedFile, Config, Finding, Observation, OutOfDate, SpecHistory, SpecRun, TestRef } from "./types.ts";

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
 * Past runs of whole spec files in this lane, one outcome per run: not run where its "spec did not run" placeholder is,
 * failed where a test failed every try, passed otherwise. For the specs a stopped Jest process skipped (see classifyNotRun).
 */
export async function fetchSpecRuns(
  fetchImpl: FetchImpl,
  base: string,
  repository: string,
  files: string[],
  until: string,
  cfg: Config = DEFAULTS,
  lane: string | null = null,
  reportName: string | null = null,
): Promise<SpecHistory> {
  const history: SpecHistory = { byFile: new Map(), truncated: false };
  const wanted = [...new Set(files.filter(Boolean))].slice(0, HISTORY_MAX_FILES);
  // Per file and run: whether its placeholder is there, and each test's attempts.
  const runs = new Map<string, Map<string, { notRun: boolean; tests: Map<string, Observation[]> }>>();
  for (let page = 1; page <= HISTORY_MAX_PAGES && wanted.length; page++) {
    const body: Record<string, unknown> = { repository, until, files: wanted, page, per_page: HISTORY_PER_PAGE, runs: cfg.crossPRRuns };
    if (reportName) body.report = reportName;
    const res = await postHistory(fetchImpl, `${base}/api/v1/reports/history`, body);
    if (!res.ok) throw new Error(`TSIO history ${res.status}`);
    const { observations = [], has_more: hasMore } = (await res.json()) as HistoryPage;
    for (const o of observations) {
      if (o.group_id == null || !wanted.includes(o.file)) continue;
      if (lane != null && o.name != null && laneOf(o.name) !== lane) continue;
      if (!runs.has(o.file)) runs.set(o.file, new Map());
      const byGroup = runs.get(o.file)!;
      const group = String(o.group_id);
      if (!byGroup.has(group)) byGroup.set(group, { notRun: false, tests: new Map() });
      const run = byGroup.get(group)!;
      if (o.title === "spec did not run") run.notRun = true;
      else {
        const key = JSON.stringify([o.report_name ?? "", o.full_title || o.title]);
        if (!run.tests.has(key)) run.tests.set(key, []);
        run.tests.get(key)!.push(o);
      }
    }
    if (!hasMore) break;
    if (page === HISTORY_MAX_PAGES) history.truncated = true;
  }
  for (const [file, byGroup] of runs) {
    const outcomes: SpecRun[] = [];
    for (const [group_id, run] of byGroup) {
      // As the run reader does: a pass beside a fail at the same retry level of one report does not excuse the fail.
      const results = [...run.tests.values()].map((attempts) => outcomeWithDuplicates([...attempts].sort((a, b) => a.retry_count - b.retry_count), (a) => a.report_name ?? null).status);
      // A run where every test was skipped is no pass (see classifyNotRun).
      const status = run.notRun ? "not_run" : results.some((s) => FAILED_STATUSES.has(s)) ? "failed" : results.every((s) => s === "skipped") ? "skipped" : "passed";
      outcomes.push({ group_id, status });
    }
    history.byFile.set(file, outcomes);
  }
  return history;
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
      // Every run in `runs` has at least one attempt, so the outcome always has a last one. A flaky run's last attempt is
      // its pass: it keeps the error of its last failed try, which is what the rules compare.
      const failedTry = status === "flaky" ? attempts.filter((a) => FAILED_STATUSES.has(a.status)).at(-1) : undefined;
      collapsed.push({ ...last!, status, ...(failedTry?.error_excerpt ? { error_excerpt: failedTry.error_excerpt } : {}) });
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

/**
 * The most runs of one failing test that ran on `branch` with no PR, in a history read: what the trunk rules can count
 * for it. The trunk rules need minTrunkRuns of them, so a base branch with fewer is not read as trunk (see triage).
 */
export function trunkRunsOn(history: Map<string, Observation[]>, branch: string): number {
  let most = 0;
  for (const rows of history.values()) {
    const runs = rows.filter((o) => (o.gh_pr_number == null || o.gh_pr_number === "") && o.branch === branch).length;
    most = Math.max(most, runs);
  }
  return most;
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
/** The most past runs dropStormRuns reads, how many at once, and how long all its reads may take. */
export const STORM_READS = 100;
const STORM_READ_BATCH = 10;
export const STORM_DEADLINE_MS = 30_000;

/**
 * Leaves out of history the failed tries of past storm runs: at least `minFailures` tests failed, and at least a tenth of
 * the run's tests (TSIO sums a run over all its reports: every OS of a desktop run, and retests). A storm failed on its
 * environment or a shared break, and its failures say nothing about one test; counted as trunk's instability or another
 * PR's same failure, they would clear a PR's real failure. Kept: a pass in a storm, this PR's own runs (`pr`), and each
 * test's current failing streak on trunk (its latest trunk runs, while each failed a try), which is a standing break
 * whatever its size. Only other runs with a failed try are read, newest first, once each, the current run's own group
 * (`own`) aside. A run that can't be read, past STORM_READS or the deadline, is treated as a storm, so an unread storm
 * clears nothing. Returns the groups whose failures were left out.
 */
export async function dropStormRuns({
  history,
  fetchImpl,
  base,
  minFailures,
  trunkBranch = null,
  own = null,
  pr = null,
  log = () => {},
  deadlineMs = STORM_DEADLINE_MS,
}: {
  history: Map<string, Observation[]>;
  fetchImpl: FetchImpl;
  base: string;
  minFailures: number;
  trunkBranch?: string | null;
  own?: string | number | null;
  pr?: number | string | null;
  log?: (message: string) => void;
  deadlineMs?: number;
}): Promise<Set<string>> {
  // Compare PR numbers as numbers: identities built with jq carry them as strings.
  const prOf = (o: Observation): number | null => (o.gh_pr_number == null || o.gh_pr_number === "" ? null : Number(o.gh_pr_number));
  const isOwn = (o: Observation): boolean => o.group_id != null && String(o.group_id) === String(own);
  const isTrunk = (o: Observation): boolean => prOf(o) == null && (trunkBranch == null || o.branch === trunkBranch);
  // Rows are newest first (see fetchHistory): each test's trunk rows from the latest, while they failed a try.
  const streak = new Set<Observation>();
  for (const rows of history.values()) {
    for (const o of rows) {
      if (isOwn(o) || !isTrunk(o)) continue;
      if (!isFailedTry(o.status)) break;
      streak.add(o);
    }
  }
  const counted = (o: Observation): boolean => o.group_id != null && !isOwn(o) && isFailedTry(o.status) && !streak.has(o) && (pr == null || prOf(o) !== Number(pr));
  const newest = new Map<string, number>();
  for (const rows of history.values())
    for (const o of rows)
      if (counted(o)) newest.set(String(o.group_id), Math.max(newest.get(String(o.group_id)) ?? 0, Date.parse(o.created_at ?? "") || 0));
  const list = [...newest.keys()].sort((a, b) => newest.get(b)! - newest.get(a)!);
  const storms = new Set<string>();
  const quiet = new Set<string>();
  const deadline = Date.now() + deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    for (let i = 0; i < Math.min(list.length, STORM_READS) && Date.now() < deadline; i += STORM_READ_BATCH) {
      const batch = list.slice(i, Math.min(i + STORM_READ_BATCH, STORM_READS)).map(async (g) => {
        try {
          const { test_stats: t } = await tsioJson<{ test_stats?: { total?: number; failed?: number } | null }>(fetchImpl, base, `/reports/${encodeURIComponent(g)}`);
          const failed = t?.failed ?? 0;
          (failed >= minFailures && failed * 10 >= (t?.total ?? 0) ? storms : quiet).add(g);
        } catch {
          // Unread: left out below with the storms.
        }
      });
      await Promise.race([Promise.all(batch), late]);
    }
  } finally {
    clearTimeout(timer);
  }
  const dropped = new Set(list.filter((g) => !quiet.has(g)));
  if (!dropped.size) return dropped;
  for (const [key, rows] of history) history.set(key, rows.filter((o) => !counted(o) || !dropped.has(String(o.group_id))));
  const unread = dropped.size - [...dropped].filter((g) => storms.has(g)).length;
  log(`history: left out the failures of ${dropped.size - unread} storm run(s)${unread ? ` and of ${unread} that could not be read` : ""}`);
  return dropped;
}

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

interface CommitRow {
  sha: string;
  commit?: { committer?: { date?: string | null } | null; author?: { date?: string | null } | null; message?: string | null } | null;
}

interface CompareResult {
  ahead_by?: number;
  files?: { filename: string }[];
  commits?: CommitRow[];
  merge_base_commit?: CommitRow | null;
}

/** At most this many spec directories are asked about when the base branch's file list is cut off. */
export const OUT_OF_DATE_DIR_CAP = 20;

const commitRef = (c: CommitRow): NonNullable<OutOfDate["commit"]> => ({
  sha: c.sha,
  date: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? "").slice(0, 10),
  pr: Number(/\(#(\d+)\)/.exec(c.commit?.message ?? "")?.[1]) || null,
});

/**
 * FIXED_ON_TRUNK failures: trunk fixed them after a run of failures. The fix landed after trunk's last failing commit
 * and by its first passing one, so one compare (the base commits this PR lacks) settles two cases: lacking the last
 * failing commit, the PR lacks the fix (out of date, merge the base); having the first passing one, it has the fix and
 * still fails (a REGRESSION for the judge). Anything else (it has the last failure but not the first pass, or a cut-off
 * list) stays unchecked.
 */
export async function markFixedOnTrunk({ findings, api, id, baseBranch, log = () => {} }: {
  findings: Finding[];
  api: GhApi;
  id: Pick<CompositeIdentity, "repository" | "commit_sha">;
  baseBranch: string | null | undefined;
  log?: (message: string) => void;
}): Promise<void> {
  if (!findings.length) return;
  const unchecked = (f: Finding, because: string): void => void Object.assign(f, { decision: "evidence_incomplete", reason: `${f.reason} ${because}` });
  const cmp = baseBranch ? (await api("GET", `/repos/${id.repository}/compare/${id.commit_sha}...${encodeURIComponent(baseBranch)}?per_page=100`)) as CompareResult | null : null;
  const lacking = new Map((cmp?.commits ?? []).map((c): [string, CommitRow] => [c.sha, c]));
  const complete = cmp != null && (cmp.ahead_by ?? 0) <= lacking.size;
  for (const f of findings) {
    const lastFail = f.trunk_fixed?.last_fail?.commit_sha;
    const firstPass = f.trunk_fixed?.first_pass?.commit_sha;
    if (lastFail && lacking.has(lastFail)) {
      // Named by trunk's first passing commit: the fix is at or before it.
      const pass = firstPass ? lacking.get(firstPass) : undefined;
      f.out_of_date = { base: baseBranch!, behind: cmp!.ahead_by ?? null, commit: pass ? commitRef(pass) : null, fixed: true };
    } else if (firstPass && complete && !lacking.has(firstPass)) {
      Object.assign(f, { class: "REGRESSION", reason: `${f.reason} This branch has that fix (by ${firstPass.slice(0, 7)}) and still fails the same way.` });
    } else {
      log(`whether this PR has ${baseBranch}'s fix for ${f.title} is unknown`);
      unchecked(f, `Whether this branch has that fix could not be checked.`);
    }
  }
}

/** What markOutOfDate could not settle: `truncated` when the file list was cut off, and the failures left unchecked. */
export interface OutOfDateResult {
  truncated: boolean;
  /** With `truncated`: the failures neither list nor directory check settled. Absent means all of them. */
  unchecked?: Finding[];
}

/**
 * Marks failures whose spec the base branch changed after this PR last merged it.
 * One compare call lists what the base branch changed since the merge base; a
 * second, per spec, names the commit. GitHub's compare stops at 300 files: then a
 * spec in the list is still marked, and for the rest each spec's directory is asked
 * for a base-branch commit since the merge base (at most OUT_OF_DATE_DIR_CAP
 * directories, up to `until`). Any commit marks the failure with it; none leaves it
 * unmarked. A failure no check settled (the cap, an error, no merge base date) is
 * returned in `unchecked`: the caller must treat it as unchecked, not as unchanged.
 */
export async function markOutOfDate({
  findings,
  api,
  id,
  baseBranch,
  until = null,
  log = () => {},
}: {
  findings: Finding[];
  api: GhApi;
  id: CompositeIdentity;
  baseBranch: string | null | undefined;
  /** The run's time: commits after it are not counted, so a replay reads what the run could have. */
  until?: string | null;
  log?: (message: string) => void;
}): Promise<OutOfDateResult> {
  if (!findings.length || !baseBranch) return { truncated: false };
  const cmp = (await api("GET", `/repos/${id.repository}/compare/${id.commit_sha}...${encodeURIComponent(baseBranch)}?per_page=100`)) as CompareResult | null;
  if (!cmp?.ahead_by) return { truncated: false };
  const files = cmp.files ?? [];
  const truncated = files.length >= COMPARE_FILE_CAP;
  const changed = new Set(files.map((x) => x.filename));
  const onBase = new Set((cmp.commits ?? []).map((c) => c.sha));
  const commits = new Map<string, OutOfDate["commit"]>();
  const rest: Finding[] = [];
  for (const f of findings) {
    const path = f.repo_path;
    if (!path || !changed.has(path)) {
      if (truncated) rest.push(f);
      continue;
    }
    if (!commits.has(path)) {
      const log_ = (await api("GET", `/repos/${id.repository}/commits?sha=${encodeURIComponent(baseBranch)}&path=${encodeURIComponent(path)}&per_page=10`).catch(() => [])) as CommitRow[] | null;
      const c = (log_ ?? []).find((x) => onBase.has(x.sha)) ?? null;
      commits.set(path, c && commitRef(c));
    }
    f.out_of_date = { base: baseBranch, behind: cmp.ahead_by, commit: commits.get(path) ?? null };
  }
  if (!truncated) return { truncated: false };
  // The list is cut off: a spec missing from it may still have changed. Its directory's commits since the merge base say.
  const base = cmp.merge_base_commit;
  const since = base?.commit?.committer?.date ?? base?.commit?.author?.date ?? null;
  if (!since) {
    log(`${baseBranch} changed ${files.length}+ files since this PR last merged it, and the merge base has no date; ${rest.length} failure(s) unchecked`);
    return { truncated: true, unchecked: rest };
  }
  log(`${baseBranch} changed ${files.length}+ files since this PR last merged it; checking the failing specs' directories instead`);
  const dirs = new Map<string, OutOfDate["commit"] | "unchecked">();
  const unchecked: Finding[] = [];
  for (const f of rest) {
    const path = f.repo_path ?? "";
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dir) {
      unchecked.push(f);
      continue;
    }
    if (!dirs.has(dir)) {
      if (dirs.size >= OUT_OF_DATE_DIR_CAP) {
        unchecked.push(f);
        continue;
      }
      const q = new URLSearchParams({ sha: baseBranch, path: dir, since, ...(until ? { until } : {}), per_page: "1" });
      dirs.set(dir, await (api("GET", `/repos/${id.repository}/commits?${q}`) as Promise<unknown>)
        .then((raw) => {
          // The merge base itself is not a change since it: GitHub's since is inclusive.
          const c = (Array.isArray(raw) ? (raw as CommitRow[]) : []).find((x) => x.sha !== base?.sha);
          return c ? commitRef(c) : null;
        })
        .catch((e: unknown): "unchecked" => (log(`${baseBranch} commits in ${dir} unavailable: ${String(e).slice(0, 160)}`), "unchecked")));
    }
    const c = dirs.get(dir);
    if (c === "unchecked") unchecked.push(f);
    else if (c) f.out_of_date = { base: baseBranch, behind: cmp.ahead_by, commit: c };
  }
  return { truncated: true, unchecked };
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
