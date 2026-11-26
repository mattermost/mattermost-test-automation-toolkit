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
 * outcomeOf, except that two executions of one report at the same retry level are not a retry unless their case
 * ordinals say the pass ran after the fail (a spec run again later in the same report, as Cypress can). A pass beside a
 * fail there that ran first, or that cannot be placed (an ordinal missing), cannot excuse the fail, so it is a fail.
 * A retest on another worker is a different report, so it stays a retest.
 */
export function outcomeWithDuplicates<T extends { status: string; retry_count: number; ordinal?: number | null }>(attempts: readonly T[], reportOf: (a: T) => string | null = () => null): Outcome<T> {
  const outcome = outcomeOf(attempts);
  if (outcome.status !== "flaky") return outcome;
  const ranAfter = (a: T, f: T): boolean => typeof a.ordinal === "number" && typeof f.ordinal === "number" && a.ordinal > f.ordinal;
  const duplicateFail = attempts.find((f) => FAILED_STATUSES.has(f.status) && attempts.some((a) => a !== f && a.retry_count === f.retry_count && reportOf(a) === reportOf(f) && !FAILED_STATUSES.has(a.status) && a.status !== "skipped" && !ranAfter(a, f)));
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
  branch?: string | null;
  gh_pr_number?: number | string | null;
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
  test_id?: string | null;
  signature_id?: string | null;
  signature_fingerprint?: string | null;
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
  test_id?: string | null;
  signature_id?: string | null;
  signature_fingerprint?: string | null;
}

export interface RunResult {
  group_id: TsioId;
  attempt?: string;
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

/** Picks `runAttempt` when it is a valid numeric attempt newer than `idAttempt`, else `idAttempt`. */
export function effectiveAttemptOf(idAttempt: string | number | null | undefined, runAttempt?: string | number | null): string {
  const base = String(idAttempt ?? "");
  return runAttempt != null && /^\d+$/.test(String(runAttempt)) && /^\d+$/.test(base) && Number(runAttempt) > Number(base)
    ? String(Number(runAttempt))
    : base;
}

function groupMatches(g: TsioGroup, id: CompositeIdentity, runId: string, attempt: string): boolean {
  return (
    g.repository === id.repository &&
    g.commit === id.commit_sha &&
    g.name === id.name &&
    String(g.gh_run_id) === runId &&
    String(g.gh_run_attempt) === attempt
  );
}

/** Lists TSIO report groups with offset pagination so multi-group commits are never truncated at 20 rows. */
export async function listReportGroups(
  fetchImpl: FetchImpl,
  base: string,
  params: Record<string, string>,
  maxPages = 2,
  pageSize = 100,
  stopWhen?: (all: TsioGroup[]) => boolean,
): Promise<TsioGroup[]> {
  const all: TsioGroup[] = [];
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ ...params, limit: String(pageSize), ...(page > 0 ? { offset: String(page * pageSize) } : {}) });
    const data = await tsioJson<{ reports?: TsioGroup[] | null }>(fetchImpl, base, `/reports?${q}`);
    const reports = data.reports ?? [];
    all.push(...reports);
    if (reports.length < pageSize || stopWhen?.(all)) break;
  }
  return all;
}

/**
 * The run's results, optionally narrowed to one report in the group (desktop
 * uploads one per OS). `reportName` is a prefix: names end in a release version.
 */
export async function fetchRun(
  fetchImpl: FetchImpl,
  base: string,
  id: CompositeIdentity,
  reportName: string | null = null,
  wait: Wait = { attempts: 6, ms: 20000 },
  runAttempt?: string | number | null,
): Promise<RunResult> {
  const runId = String(id.gh_run_id ?? "");
  const idAttempt = String(id.gh_run_attempt ?? "");
  const effectiveAttempt = effectiveAttemptOf(idAttempt, runAttempt);
  const groups = await listReportGroups(
    fetchImpl,
    base,
    { repository: id.repository, commit: id.commit_sha, name: String(id.name) },
    2,
    100,
    runId && idAttempt ? (all) => all.some((g) => groupMatches(g, id, runId, effectiveAttempt)) : undefined,
  );
  return runFromGroups(fetchImpl, base, id, groups, reportName, wait, runAttempt);
}

/**
 * The run's results from a group list already read. fetchRun is this after its one list call; a caller that reads
 * several runs from one list (the sibling groups of a run) calls it directly, so the list is read once.
 */
export async function runFromGroups(
  fetchImpl: FetchImpl,
  base: string,
  id: CompositeIdentity,
  groups: TsioGroup[],
  reportName: string | null = null,
  wait: Wait = { attempts: 6, ms: 20000 },
  runAttempt?: string | number | null,
): Promise<RunResult> {
  const get = <T>(path: string): Promise<T> => tsioJson<T>(fetchImpl, base, path);
  // Match the full identity ourselves: never trust the server's filtering, and
  // run id + attempt are what tell two runs of one suite on one commit apart.
  const runId = String(id.gh_run_id ?? "");
  const idAttempt = String(id.gh_run_attempt ?? "");
  if (!runId || !idAttempt)
    throw new Error(`composite identity is missing gh_run_id or gh_run_attempt; refusing to guess which run to read (run_id=${runId || "-"} attempt=${idAttempt || "-"})`);
  const effectiveAttempt = effectiveAttemptOf(idAttempt, runAttempt);
  const matchAttempt = (att: string): TsioGroup | undefined => groups.find((g) => groupMatches(g, id, runId, att));
  const group = (effectiveAttempt !== idAttempt ? matchAttempt(effectiveAttempt) : undefined) ?? matchAttempt(idAttempt);
  const attempt = effectiveAttempt;
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
  const [suitesRes, allCases] = await Promise.all([
    get<{ suites?: TsioSuite[] | null }>(`/reports/${group.id}/suites`),
    get<TsioCase[]>(`/reports/${group.id}/cases`),
  ]);
  const uploaded = suitesRes.suites ?? [];
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
      const pickCaseMeta = (k: "test_id"): string | null | undefined => {
        if (lastAttempt[k] != null) return lastAttempt[k];
        const fromAny = attempts.find((a) => a[k] != null)?.[k];
        return fromAny != null ? fromAny : lastAttempt[k];
      };
      const testId = pickCaseMeta("test_id");
      const errorText = (a: TsioCase): string => [a.error_message, a.error_stack].filter(Boolean).join("\n");
      const lastError = errorText(lastAttempt);
      const sigAttempt =
        lastAttempt.signature_fingerprint != null || lastAttempt.signature_id != null
          ? lastAttempt
          : (lastError !== ""
              ? attempts.find(
                  (a) =>
                    FAILED_STATUSES.has(a.status) &&
                    (a.signature_fingerprint != null || a.signature_id != null) &&
                    errorText(a) === lastError,
                )
              : undefined) ?? lastAttempt;
      const signatureId = sigAttempt.signature_id;
      const signatureFingerprint = sigAttempt.signature_fingerprint;
      failing.push({
        file,
        title,
        full_title: lastAttempt.full_title ?? null,
        suite_title: suiteTitleOf.get(suiteId) ?? null,
        report_name: reportOf.get(suiteId),
        report_scope: reportName,
        identity_ambiguous: testsPerLeaf.get(JSON.stringify([file, title]))!.size > 1,
        identity_unresolved: testsPerIdentity.get(identityKey({ file, title, full_title: lastAttempt.full_title, report_scope: reportName }))!.size > 1,
        error: lastError,
        tries: { ran: attempts.filter((a) => a.status !== "skipped").length, failed: attempts.filter((a) => FAILED_STATUSES.has(a.status)).length },
        ...(typeof first?.ordinal === "number" ? { ordinal: first.ordinal } : {}),
        ...(testId !== undefined ? { test_id: testId } : {}),
        ...(signatureId !== undefined ? { signature_id: signatureId } : {}),
        ...(signatureFingerprint !== undefined ? { signature_fingerprint: signatureFingerprint } : {}),
      });
    } else if (status === "skipped") skipped++;
    else if (status === "flaky") flaky++;
  }
  // Passed includes retry-recovered tests, as the E2E statuses count them.
  return { group_id: group.id, attempt: String(group.gh_run_attempt), failing, missing, outcomes, elsewhere, counts:{ total: byTest.size, passed: byTest.size - failed - skipped, failed, flaky, skipped } };
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

export const DEFAULT_TSIO_OIDC_AUDIENCE = "mattermost-test-system-io";
export const MAX_VERDICT_BATCH = 500;
export const MAX_ERROR_CONTEXT_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface TsioVerdict {
  id: string;
  report_group_id: string | null;
  repository: string;
  test_id: string | null;
  signature_id: string;
  fingerprint: string;
  label: string;
  decided_by: string | null;
  rule: string | null;
  confidence: number | null;
  summary: string | null;
  model: string | null;
  triage_url: string | null;
  reused_from_id: string | null;
  created_at: string;
}

export interface CreateVerdictItem {
  test_id?: string | null;
  signature_id?: string | null;
  fingerprint?: string | null;
  label: string;
  decided_by?: string | null;
  rule?: string | null;
  confidence?: number | null;
  summary?: string | null;
  model?: string | null;
  triage_url?: string | null;
  error_context?: Record<string, unknown> | null;
  reused_from_id?: string | null;
}

export interface CreateVerdictsBatchRequest {
  repository: string;
  report_group_id?: string | null;
  verdicts: CreateVerdictItem[];
}

export interface CreatedVerdictItem {
  id: string;
  report_group_id: string | null;
  repository: string;
  test_id: string | null;
  signature_id: string | null;
  label: string;
  decided_by: string | null;
  rule: string | null;
  confidence: number | null;
  summary: string | null;
  model: string | null;
  triage_url: string | null;
  reused_from_id: string | null;
  created_at: string;
  created: boolean;
  superseded_id: string | null;
}

export interface CreateVerdictsBatchResponse {
  verdicts: CreatedVerdictItem[];
}

export interface TsioAuth {
  headers: Record<string, string>;
  secret: string;
}

/**
 * Resolves optional TSIO write auth headers: X-API-Key (TSIO_API_KEY) first,
 * then GitHub OIDC (ACTIONS_ID_TOKEN_REQUEST_URL + ACTIONS_ID_TOKEN_REQUEST_TOKEN).
 * Returns null if neither is configured or OIDC minting fails (fail-open). Never logs tokens.
 */
export async function resolveTsioAuthHeaders(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  log: (message: string) => void = () => {},
): Promise<TsioAuth | null> {
  const apiKey = (env.TSIO_API_KEY ?? "").trim();
  if (apiKey) return { headers: { "X-API-Key": apiKey }, secret: apiKey };

  const reqUrl = (env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "").trim();
  const reqToken = (env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "").trim();
  if (!reqUrl || !reqToken) return null;

  const audience = (env.TSIO_OIDC_AUDIENCE ?? "").trim() || DEFAULT_TSIO_OIDC_AUDIENCE;
  const sep = reqUrl.includes("?") ? "&" : "?";
  const url = `${reqUrl}${sep}audience=${encodeURIComponent(audience)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${reqToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      log(`TSIO OIDC token request failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { value?: unknown } | null;
    const token = typeof data?.value === "string" ? data.value.trim() : "";
    if (!token) {
      log("TSIO OIDC token response held no token");
      return null;
    }
    return { headers: { Authorization: `Bearer ${token}` }, secret: token };
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    log(`TSIO OIDC token request unavailable (${name})`);
    return null;
  }
}

/**
 * Queries GET /api/v1/verdicts/by-signature/{fingerprint}.
 * Returns null on 404; throws a concise status/shape error on unexpected failures so callers fail open.
 */
export async function lookupVerdictBySignature(
  fetchImpl: FetchImpl,
  base: string,
  fingerprint: string,
  opts?: { repository?: string; windowDays?: number; timeoutMs?: number },
): Promise<TsioVerdict | null> {
  const fp = fingerprint.trim();
  if (!fp) return null;
  const q = new URLSearchParams();
  if (opts?.repository) q.set("repository", opts.repository);
  q.set("window_days", String(opts?.windowDays ?? 90));
  const qs = q.toString();
  const url = `${withoutTrailingSlash(base)}/api/v1/verdicts/by-signature/${encodeURIComponent(fp)}${qs ? `?${qs}` : ""}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000) });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`TSIO GET /verdicts/by-signature: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.id !== "string" || !data.id || typeof data.label !== "string" || !data.label) {
    throw new Error("TSIO GET /verdicts/by-signature: invalid response shape");
  }
  const optStr = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v !== "string") throw new Error("TSIO GET /verdicts/by-signature: invalid response shape");
    return v;
  };
  const reqStr = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v !== "string") throw new Error("TSIO GET /verdicts/by-signature: invalid response shape");
    return v;
  };
  let confidence: number | null = null;
  if (data.confidence != null) {
    if (typeof data.confidence !== "number" || !Number.isFinite(data.confidence)) {
      throw new Error("TSIO GET /verdicts/by-signature: invalid response shape");
    }
    confidence = data.confidence;
  }
  return {
    id: data.id,
    report_group_id: optStr(data.report_group_id),
    repository: reqStr(data.repository),
    test_id: optStr(data.test_id),
    signature_id: reqStr(data.signature_id),
    fingerprint: reqStr(data.fingerprint),
    label: data.label,
    decided_by: optStr(data.decided_by),
    rule: optStr(data.rule),
    confidence,
    summary: optStr(data.summary),
    model: optStr(data.model),
    triage_url: optStr(data.triage_url),
    reused_from_id: optStr(data.reused_from_id),
    created_at: reqStr(data.created_at),
  };
}

/** Slices at most maxUnits UTF-16 code units without splitting a surrogate pair. */
export function sliceUtf16Safe(s: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (s.length <= maxUnits) return s;
  let end = maxUnits;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end);
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

function toJsonSafe(v: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof v === "bigint") return String(v);
  if (v === null || typeof v !== "object") {
    return typeof v === "function" || typeof v === "symbol" || v === undefined ? undefined : v;
  }
  if (ancestors.has(v)) return undefined;
  ancestors.add(v);
  try {
    const toJson = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      try {
        return toJsonSafe((toJson as () => unknown).call(v), ancestors);
      } catch {
        return undefined;
      }
    }
    if (Array.isArray(v)) return v.map((el) => toJsonSafe(el, ancestors) ?? null);
    const copy: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const safeVal = toJsonSafe(val, ancestors);
      if (safeVal !== undefined) copy[k] = safeVal;
    }
    return copy;
  } finally {
    ancestors.delete(v);
  }
}

function normalizeErrorContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    const safe = toJsonSafe(raw, new WeakSet());
    if (!safe || typeof safe !== "object" || Array.isArray(safe)) return {};
    const out = safe as Record<string, unknown>;
    if (utf8Bytes(JSON.stringify(out)) <= MAX_ERROR_CONTEXT_BYTES) return out;

    for (let guard = 0; guard < 64 && utf8Bytes(JSON.stringify(out)) > MAX_ERROR_CONTEXT_BYTES; guard++) {
      let longestStrKey: string | null = null;
      let longestStrLen = 0;
      for (const [k, v] of Object.entries(out)) {
        if (typeof v === "string" && v.length > longestStrLen) {
          longestStrKey = k;
          longestStrLen = v.length;
        }
      }
      if (longestStrKey && longestStrLen > 64) {
        const next = sliceUtf16Safe(out[longestStrKey] as string, Math.floor(longestStrLen / 2));
        if (next.length < longestStrLen) {
          out[longestStrKey] = next;
          continue;
        }
      }
      let largestKey: string | null = null;
      let largestBytes = -1;
      for (const [k, v] of Object.entries(out)) {
        const b = utf8Bytes(JSON.stringify(v ?? null));
        if (b > largestBytes) {
          largestBytes = b;
          largestKey = k;
        }
      }
      if (!largestKey) break;
      delete out[largestKey];
    }
    return utf8Bytes(JSON.stringify(out)) <= MAX_ERROR_CONTEXT_BYTES ? out : {};
  } catch {
    return {};
  }
}

function sanitizeVerdictItem(item: CreateVerdictItem): CreateVerdictItem {
  const testId = isUuid(item.test_id) ? item.test_id : null;
  const sigId = isUuid(item.signature_id) ? item.signature_id : null;
  const fp = typeof item.fingerprint === "string" && item.fingerprint.trim() ? item.fingerprint.trim() : null;
  const conf = typeof item.confidence === "number" && Number.isFinite(item.confidence)
    ? Math.min(1, Math.max(0, item.confidence))
    : null;
  const reusedFromId = isUuid(item.reused_from_id) ? item.reused_from_id : null;
  return {
    test_id: testId,
    signature_id: sigId,
    fingerprint: fp,
    label: item.label,
    decided_by: item.decided_by ?? null,
    rule: item.rule ?? null,
    confidence: conf,
    summary: item.summary ?? null,
    model: item.model ?? null,
    triage_url: item.triage_url ?? null,
    error_context: normalizeErrorContext(item.error_context),
    reused_from_id: reusedFromId,
  };
}

/**
 * Submits AI triage verdicts to POST /api/v1/verdicts in chunks of <= 500.
 * Deduplicates items on (test_id, signature_id) when report_group_id is a valid UUID,
 * enforces UUID/null normalization and <= 64 KiB JSON object error_context.
 */
export async function submitVerdicts(
  fetchImpl: FetchImpl,
  base: string,
  authHeaders: Record<string, string>,
  request: CreateVerdictsBatchRequest,
  opts?: { timeoutMs?: number },
): Promise<CreatedVerdictItem[]> {
  if (!request.verdicts.length) return [];
  const reportGroupId = isUuid(request.report_group_id) ? request.report_group_id : null;
  const sanitized = request.verdicts.map(sanitizeVerdictItem).filter((v) => v.label.trim().length > 0);
  if (!sanitized.length) return [];

  const fpToSigId = new Map<string, string>();
  for (const item of sanitized) {
    if (item.fingerprint && item.signature_id && !fpToSigId.has(item.fingerprint)) {
      fpToSigId.set(item.fingerprint, item.signature_id);
    }
  }
  const normalized = sanitized.map((item) =>
    !item.signature_id && item.fingerprint && fpToSigId.has(item.fingerprint)
      ? { ...item, signature_id: fpToSigId.get(item.fingerprint)! }
      : item,
  );

  let items = normalized;
  if (reportGroupId) {
    const seen = new Set<string>();
    items = [];
    for (const item of normalized) {
      const sigKey = item.signature_id ? `s:${item.signature_id}` : item.fingerprint ? `f:${item.fingerprint}` : "";
      const key = `${item.test_id ?? ""}\0${sigKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  const endpoint = `${withoutTrailingSlash(base)}/api/v1/verdicts`;
  const created: CreatedVerdictItem[] = [];
  for (let i = 0; i < items.length; i += MAX_VERDICT_BATCH) {
    const chunk = items.slice(i, i + MAX_VERDICT_BATCH);
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        repository: request.repository,
        report_group_id: reportGroupId,
        verdicts: chunk,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`TSIO POST /verdicts: ${res.status}`);
    }
    const data = (await res.json()) as CreateVerdictsBatchResponse | null;
    if (Array.isArray(data?.verdicts)) created.push(...data.verdicts);
  }
  return created;
}
