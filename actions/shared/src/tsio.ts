// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env, FetchImpl } from "./github.ts";

export const FAILED_STATUSES = new Set(["failed", "timedOut", "interrupted"]);

/**
 * Whether a test's result on another platform or report counts as a failure there: a failed try, which a retry may have
 * recovered (TSIO's flaky), or a failure outright. Passed, or skipped, does not.
 */
export const isFailedTry = (status: string): boolean => FAILED_STATUSES.has(status) || status === "flaky";

/**
 * The key that matches one test across reports and platforms: its file and full title (or title), with Windows path
 * separators read as "/", since Windows writes the same test's title with backslashes.
 */
export const elsewhereKey = (file: string | null | undefined, title: string | null | undefined): string =>
  JSON.stringify([String(file ?? "").replace(/\\/g, "/"), String(title ?? "").replace(/\\/g, "/")]);

/** One GET of TSIO's API; a failed status throws with the path, never a body. */
export async function tsioJson<T>(fetchImpl: FetchImpl, base: string, path: string): Promise<T> {
  const res = await fetchImpl(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`TSIO GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const DEFAULT_TSIO_BASE_URL = "https://test-io.test.mattermost.com";
// The staging deployment that use-staging selects. Same URL as TSIO's own actions.
export const STAGING_TSIO_BASE_URL = "https://staging-test-io.test.mattermost.com";

const withoutTrailingSlash = (url: string): string => url.replace(/\/$/, "");

/**
 * The TSIO base URL, without a trailing slash. USE_STAGING is the action's use-staging input, read as
 * TSIO's own actions read theirs: "true" after trimming and ignoring case; any other value is false.
 * With it true, the staging URL is the target, and a tsio-base-url that is set must be that same URL:
 * otherwise the inputs disagree and the action stops. With it false or empty, the result is what it was:
 * TSIO_BASE_URL if set, else the shared instance.
 */
export function tsioBase(env: Env): string {
  if ((env.USE_STAGING ?? "").trim().toLowerCase() === "true") {
    const configured = env.TSIO_BASE_URL;
    if (configured && withoutTrailingSlash(configured) !== STAGING_TSIO_BASE_URL)
      throw new Error(
        `use-staging is true, which targets ${STAGING_TSIO_BASE_URL}, but tsio-base-url is ${configured}; set one of them, not both`,
      );
    return STAGING_TSIO_BASE_URL;
  }
  return withoutTrailingSlash(env.TSIO_BASE_URL || DEFAULT_TSIO_BASE_URL);
}

/** A test's final outcome, and the execution it was read from (null only when it has no attempts). */
export interface Outcome<T> {
  status: string;
  last: T | undefined;
}

/**
 * outcomeOf, except that two executions of one report at the same retry level are not a retry: a pass
 * beside a fail there (one spec reported twice in one group) cannot excuse the fail, so it is a fail.
 * A retest on another worker is a different report, so it stays a retest.
 */
export function outcomeWithDuplicates<T extends { status: string; retry_count: number }>(attempts: readonly T[], reportOf: (a: T) => string | null = () => null): Outcome<T> {
  const outcome = outcomeOf(attempts);
  if (outcome.status !== "flaky") return outcome;
  const duplicateFail = attempts.find((f) => FAILED_STATUSES.has(f.status) && attempts.some((a) => a !== f && a.retry_count === f.retry_count && reportOf(a) === reportOf(f) && !FAILED_STATUSES.has(a.status) && a.status !== "skipped"));
  return duplicateFail ? { status: duplicateFail.status, last: duplicateFail } : outcome;
}

/**
 * A test's outcome from all its attempts (retries and retests on other workers),
 * as Playwright reads it: failed only if every attempt that ran failed, flaky if
 * some did. Not just the last attempt: a serial block can skip after a failure.
 */
export function outcomeOf<T extends { status: string }>(attempts: readonly T[]): Outcome<T> {
  const ran = attempts.filter((a) => a.status !== "skipped");
  if (!ran.length) return { status: "skipped", last: attempts.at(-1) };
  const failed = ran.filter((a) => FAILED_STATUSES.has(a.status));
  const lastFailed = failed.at(-1);
  if (lastFailed && failed.length === ran.length) return { status: lastFailed.status, last: lastFailed };
  return { status: failed.length || ran.some((a) => a.status === "flaky") ? "flaky" : "passed", last: ran.at(-1) };
}

// History key. The full title when present: two suites in a file can share a leaf title.
export const identityKey = (t: { file: string; title: string; full_title?: string | null; report_scope?: string | null }): string =>
  JSON.stringify([t.report_scope ?? "", t.file, t.full_title || t.title]);

/** The run an action reports on: repository, commit, suite name, and the GitHub run and attempt. */
export interface CompositeIdentity {
  repository: string;
  commit_sha: string;
  name?: string;
  gh_run_id?: string | number | null;
  gh_run_attempt?: string | number | null;
}

/**
 * The run's identity from COMPOSITE_IDENTITY, read as the caller wrote it (no shape check). A missing value or one
 * that is not JSON is named in words, rather than failing with a bare SyntaxError from JSON.parse.
 */
export function compositeIdentityFrom<T = CompositeIdentity>(raw: string | undefined): T {
  if (raw == null || raw.trim() === "") throw new Error("COMPOSITE_IDENTITY is missing; the action needs the run's identity as JSON");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`COMPOSITE_IDENTITY is not valid JSON: ${String(e).slice(0, 120)}`);
  }
}

/** Polling for late report uploads: how many times to re-read, and how long to wait each time. */
export interface Wait {
  attempts: number;
  ms: number;
}

/** What a run is missing when some reports never arrived; null from fetchRun when the group completed. */
export interface Missing {
  expected: number | null;
  received: number | null;
  status: string | undefined;
}

type TsioId = string | number;

/** One TSIO group: a run's results for one lane. The PR and branch are read when TSIO sends them. */
export interface TsioGroup {
  id: TsioId;
  repository: string;
  commit: string;
  name: string;
  gh_run_id: string | number;
  gh_run_attempt: string | number;
  status: string;
  total_reports_expected?: number | string | null;
  reports?: unknown[];
  gh_pr_number?: number | string | null;
  branch?: string | null;
  /** A lane that leases work units to its workers: a dead worker's units go to the others. Sent on the group's own read. */
  orchestration?: { status?: string; counts?: { pending?: number; leased?: number; abandoned?: number }; tests?: { total?: number } } | null;
  test_stats?: { total?: number } | null;
}

/**
 * Whether every result is in: TSIO closed the group, or its orchestration ran every unit (none pending, leased or
 * abandoned) and the group holds as many tests as the orchestration ran. A worker that died after its units were
 * re-leased never uploads, so its report never arrives.
 */
const finished = (g: TsioGroup): boolean => {
  if (g.status === "completed") return true;
  const o = g.orchestration;
  const ran = o?.tests?.total;
  return o?.status === "completed" && !o.counts?.pending && !o.counts?.leased && !o.counts?.abandoned &&
    typeof ran === "number" && ran === g.test_stats?.total;
};

export interface TsioSuite {
  id: TsioId;
  file_path?: string | null;
  file?: string | null;
  report_name?: string | null;
  report_id?: string | null;
  title?: string | null;
}

export interface TsioCase {
  suite_id: TsioId;
  title: string;
  full_title?: string | null;
  status: string;
  retry_count: number;
  ordinal: number;
  error_message?: string | null;
  error_stack?: string | null;
}

export interface FailingTest {
  file: string;
  title: string;
  full_title: string | null;
  suite_title: string | null;
  report_name: string | null | undefined;
  report_scope: string | null;
  identity_ambiguous: boolean;
  identity_unresolved: boolean;
  error: string;
  tries: { ran: number; failed: number };
  /** Its first try's case ordinal in the report it is named by: where it ran there. Absent when TSIO sent none. */
  ordinal?: number;
}

export interface RunResult {
  group_id: TsioId;
  failing: FailingTest[];
  missing: Missing | null;
  outcomes: Map<string, string>;
  /**
   * Every report's outcome for each test of the group, read before any report filter: keyed by [file, full title or
   * title], each entry the report's name and the test's outcome there. Desktop uploads one report per OS into one group,
   * so the same test on the other OSes is named from here with no further read.
   */
  elsewhere: Map<string, { report: string; status: string }[]>;
  counts: { total: number; passed: number; failed: number; flaky: number; skipped: number };
}

/** A GitHub run and attempt, as TSIO's group carries them. Digits only: they are compared as big integers. */
export interface Replacement {
  gh_run_id: string;
  gh_run_attempt: string;
  /** The replacement's PR as TSIO sent it: undefined when TSIO sent none, null for a run with no PR. */
  gh_pr_number?: string | null;
  /** The replacement's branch as TSIO sent it. */
  branch?: string | null;
}
/** Whether run a is newer than run b: a later run id, or the same run's later attempt. */
const newerRun = (a: Replacement, b: Replacement): boolean => {
  const run = BigInt(a.gh_run_id) - BigInt(b.gh_run_id);
  return run !== BigInt(0) ? run > BigInt(0) : BigInt(a.gh_run_attempt) > BigInt(b.gh_run_attempt);
};
/**
 * TSIO holds the run's group, but a newer dispatch of the same commit and suite replaced it (see fetchRun). Its
 * message keeps fetchRun's "no group for" wording, so a caller that only logs it reads the same as before.
 */
export class SupersededRunError extends Error {
  readonly replacement: Replacement;
  constructor(message: string, replacement: Replacement) {
    super(message);
    this.name = "SupersededRunError";
    this.replacement = replacement;
  }
}
/** TSIO holds no group for this run, and no newer run took its place: its results are not there (yet). */
export class NoResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoResultsError";
  }
}

/** "2 of 3 reports arrived" for a run with missing reports, or a bare count when the expected count is unknown; null if complete. */
export function missingArrived(missing: Missing | null): string | null {
  if (!missing) return null;
  const { expected, received } = missing;
  if (expected != null && received != null) return `${received} of ${expected} reports arrived`;
  return `${received ?? "?"} reports arrived (the expected count is unknown)`;
}

/**
 * The run's results, optionally narrowed to one report in the group (desktop
 * uploads one per OS). `reportName` is a prefix: names end in a release version.
 */
export async function fetchRun(fetchImpl: FetchImpl, base: string, id: CompositeIdentity, reportName: string | null = null, wait: Wait = { attempts: 6, ms: 20000 }): Promise<RunResult> {
  const q = new URLSearchParams({ repository: id.repository, commit: id.commit_sha, name: String(id.name), limit: "20" });
  const { reports: groups = [] } = await tsioJson<{ reports?: TsioGroup[] }>(fetchImpl, base, `/reports?${q}`);
  return runFromGroups(fetchImpl, base, id, groups, reportName, wait);
}

/**
 * The run's results from a group list already read. fetchRun is this after its one list call; a caller that reads
 * several runs from one list (the sibling groups of a run) calls it directly, so the list is read once.
 */
export async function runFromGroups(fetchImpl: FetchImpl, base: string, id: CompositeIdentity, groups: TsioGroup[], reportName: string | null = null, wait: Wait = { attempts: 6, ms: 20000 }): Promise<RunResult> {
  const get = <T>(path: string): Promise<T> => tsioJson<T>(fetchImpl, base, path);
  // Match the full identity ourselves: never trust the server's filtering, and
  // run id + attempt are what tell two runs of one suite on one commit apart.
  const runId = String(id.gh_run_id ?? "");
  const attempt = String(id.gh_run_attempt ?? "");
  if (!runId || !attempt)
    throw new Error(`composite identity is missing gh_run_id or gh_run_attempt; refusing to guess which run to read (run_id=${runId || "-"} attempt=${attempt || "-"})`);
  const group = groups.find(
    (g) =>
      g.repository === id.repository &&
      g.commit === id.commit_sha &&
      g.name === id.name &&
      String(g.gh_run_id) === runId &&
      String(g.gh_run_attempt) === attempt,
  );
  if (!group) {
    const noGroup = `TSIO returned no group for ${id.repository} ${id.commit_sha.slice(0, 7)} ${id.name} run ${runId} attempt ${attempt} (of ${groups.length} row(s) returned)`;
    // A newer run or attempt of this commit and suite took the group: this run is superseded, and the newest replacement is named.
    // An older run's group, or one of another suite or commit, says nothing about this run.
    const newest = /^\d+$/.test(runId) && /^\d+$/.test(attempt)
      ? groups
          .filter((g) => g.repository === id.repository && g.commit === id.commit_sha && g.name === id.name)
          .map((g): Replacement => ({
            gh_run_id: String(g.gh_run_id),
            gh_run_attempt: String(g.gh_run_attempt),
            gh_pr_number: g.gh_pr_number === undefined ? undefined : g.gh_pr_number === null || String(g.gh_pr_number) === "" ? null : String(g.gh_pr_number),
            branch: g.branch === undefined ? undefined : g.branch,
          }))
          .filter((r) => /^\d+$/.test(r.gh_run_id) && /^\d+$/.test(r.gh_run_attempt) && newerRun(r, { gh_run_id: runId, gh_run_attempt: attempt }))
          .reduce<Replacement | null>((best, r) => (!best || newerRun(r, best) ? r : best), null)
      : null;
    if (newest)
      throw new SupersededRunError(`${noGroup}; its group now belongs to run ${newest.gh_run_id} attempt ${newest.gh_run_attempt}`, newest);
    throw new NoResultsError(noGroup);
  }
  // A worker that never uploaded leaves the group open for good. Wait a little for
  // late uploads, then read what arrived: the missing reports keep the run red (all
  // of it: a report-scoped run can't tell which scope a missing report belonged to).
  let missing: Missing | null = null;
  if (group.status !== "completed") {
    let detail: TsioGroup = group;
    for (let i = 0; i < wait.attempts && !finished(detail); i++) {
      await new Promise<void>((r) => setTimeout(r, wait.ms));
      detail = await get<TsioGroup>(`/reports/${group.id}`);
    }
    if (!finished(detail)) {
      const expected = Number(detail.total_reports_expected ?? group.total_reports_expected) || null;
      const received = Array.isArray(detail.reports) ? detail.reports.length : null;
      missing = { expected, received, status: detail.status };
    }
  }
  const [{ suites: uploaded = [] }, allCases] = await Promise.all([
    get<{ suites?: TsioSuite[] }>(`/reports/${group.id}/suites`),
    get<TsioCase[]>(`/reports/${group.id}/cases`),
  ]);
  // A re-run uploads its jobs' reports again under the same names: the newest report of a name replaces the earlier
  // attempt's (report ids are UUIDv7, so they sort by upload time). No run uploads two reports of one name otherwise.
  const newest = new Map<string, string>();
  for (const s of uploaded) if (s.report_name && s.report_id && (newest.get(s.report_name) ?? "") < s.report_id) newest.set(s.report_name, s.report_id);
  const suites = uploaded.filter((s) => !s.report_name || (s.report_id ? newest.get(s.report_name) === s.report_id : !newest.has(s.report_name)));
  const kept = new Set(suites.map((s) => s.id));
  const cases = allCases.filter((c) => kept.has(c.suite_id));
  const fileOf = new Map<TsioId, string>(suites.map((s): [TsioId, string] => [s.id, s.file_path ?? s.file ?? ""]));
  const reportOf = new Map<TsioId, string | null>(suites.map((s): [TsioId, string | null] => [s.id, s.report_name ?? null]));
  const suiteTitleOf = new Map<TsioId, string>(suites.map((s): [TsioId, string] => [s.id, s.title ?? ""]));
  // Every report's outcome for each test, before the report filter: the same test on the group's other reports is named
  // from here, with no further read. One outcome per test per report, by the same rule as the run's own outcomes.
  const perReport = new Map<string, { report: string; identity: string; attempts: TsioCase[] }>();
  for (const c of cases) {
    const report = reportOf.get(c.suite_id) ?? "";
    const identity = elsewhereKey(fileOf.get(c.suite_id) ?? "", c.full_title || c.title);
    const key = JSON.stringify([report, identity]);
    if (!perReport.has(key)) perReport.set(key, { report, identity, attempts: [] });
    perReport.get(key)!.attempts.push(c);
  }
  const elsewhere = new Map<string, { report: string; status: string }[]>();
  for (const { report, identity, attempts } of perReport.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    const { status } = outcomeWithDuplicates(attempts, (a) => reportOf.get(a.suite_id) ?? null);
    if (!elsewhere.has(identity)) elsewhere.set(identity, []);
    elsewhere.get(identity)!.push({ report, status });
  }
  // A report filter that matches nothing must not read as a run with no failures.
  const scoped = reportName
    ? new Set<TsioId>(suites.filter((s) => String(s.report_name ?? "").startsWith(reportName)).map((s) => s.id))
    : null;
  if (scoped && scoped.size === 0)
    throw new Error(`no report in group ${group.id} has a name starting with "${reportName}" (of ${new Set(suites.map((s) => s.report_name)).size} report name(s) present)`);
  // One test per full title (two describe blocks can share a leaf title), so a
  // retest on another worker is the same test. Without a full title, per suite.
  const byTest = new Map<string, TsioCase[]>();
  for (const c of cases) {
    if (scoped && !scoped.has(c.suite_id)) continue;
    const k = c.full_title
      ? JSON.stringify([scoped ? reportOf.get(c.suite_id) ?? "" : "", fileOf.get(c.suite_id) ?? "", c.full_title])
      : JSON.stringify([c.suite_id, c.title]);
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k)!.push(c);
  }
  // Flag names shared by two suites: their history can't be told apart, so they can't clear.
  const testsPerLeaf = new Map<string, Set<string>>();
  const testsPerIdentity = new Map<string, Set<string>>();
  for (const [key, attempts] of byTest) {
    const c = attempts[0];
    const file = fileOf.get(c.suite_id);
    if (!file)
      throw new Error(`group ${group.id} has case rows without a suite file path; the run cannot be read reliably`);
    const leaf = JSON.stringify([file, c.title]);
    const identity = identityKey({ file, title: c.title, full_title: c.full_title, report_scope: reportName });
    for (const [map, k] of [[testsPerLeaf, leaf], [testsPerIdentity, identity]] as const) {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(key);
    }
  }
  if (byTest.size === 0)
    throw new Error(`group ${group.id} reported no test cases${reportName ? ` for report "${reportName}"` : ""}; an empty result is not a passing run`);
  const failing: FailingTest[] = [];
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  // Every test's final outcome by file and title, so another platform's run of the
  // same test can be looked up (see sameTestElsewhere).
  const outcomes = new Map<string, string>();
  for (const attempts of byTest.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    const { status, last } = outcomeWithDuplicates(attempts, (a) => reportOf.get(a.suite_id) ?? null);
    // Every entry of byTest has at least one attempt, so the outcome always has a last one.
    const lastAttempt = last!;
    outcomes.set(JSON.stringify([fileOf.get(lastAttempt.suite_id) ?? "", lastAttempt.title]), status);
    if (FAILED_STATUSES.has(status)) {
      failed++;
      const { suite_id: suiteId, title } = lastAttempt;
      const file = fileOf.get(suiteId) ?? "";
      // The first try in the report it is named by: ordinals are only comparable within one report.
      const first = attempts.find((a) => a.suite_id === suiteId);
      failing.push({
        file,
        title,
        full_title: lastAttempt.full_title ?? null,
        suite_title: suiteTitleOf.get(suiteId) ?? null,
        report_name: reportOf.get(suiteId),
        report_scope: reportName,
        identity_ambiguous: testsPerLeaf.get(JSON.stringify([file, title]))!.size > 1,
        identity_unresolved: testsPerIdentity.get(identityKey({ file, title, full_title: lastAttempt.full_title, report_scope: reportName }))!.size > 1,
        error: [lastAttempt.error_message, lastAttempt.error_stack].filter(Boolean).join("\n"),
        tries: { ran: attempts.filter((a) => a.status !== "skipped").length, failed: attempts.filter((a) => FAILED_STATUSES.has(a.status)).length },
        ...(typeof first?.ordinal === "number" ? { ordinal: first.ordinal } : {}),
      });
    } else if (status === "skipped") skipped++;
    else if (status === "flaky") flaky++;
  }
  // Passed includes retry-recovered tests, as the E2E statuses count them.
  return { group_id: group.id, failing, missing, outcomes, elsewhere, counts:{ total: byTest.size, passed: byTest.size - failed - skipped, failed, flaky, skipped } };
}

/** What a run is missing when some reports never arrived, long and short; null if complete. */
export function missingReports(missing: Missing | null): { text: string; short: string } | null {
  if (!missing) return null;
  const { expected, received } = missing;
  if (expected != null && received != null && expected > received)
    return { text: `${expected - received} of ${expected} reports never uploaded, so the specs on those workers never ran`, short: `${expected - received} report(s) missing` };
  const state = missing.status ?? "not completed";
  // The count is named where TSIO gave one; "?" marks what it did not.
  if (expected == null) return { text: `the run's results are incomplete (${received ?? "?"} reports arrived; the expected count is unknown; TSIO group ${state})`, short: "results incomplete" };
  return { text: `the run's results are incomplete (${received ?? "?"} of ${expected} reports arrived; TSIO group ${state})`, short: `results incomplete: ${received ?? "?"} of ${expected} reports` };
}
