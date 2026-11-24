// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { FetchImpl } from "../../shared/src/github.ts";
import { redact } from "./findings.ts";
import type { Finding } from "./types.ts";

export interface GhStep {
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runner_name?: string | null;
  steps?: GhStep[];
}

export const DEAD_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
export const WORKER_JOB = /dispatch-run|\bshard\b|\bworker\b|\bmachine-\d+|-\d+$/i;
export const OWN_RESULT_JOB = /(?:^|\/ )(?:lane-result|report|summary|triage|status)\b/i;

// Log lines start with an ISO timestamp with up to 7 fractional digits; Date.parse reads 3.
export const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3})\d*)?Z (.*)$/;
export const toMs = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
export const lastLines = (text: string, n: number): string => text.split("\n").slice(-n).join("\n");

// An error line in a step's output: what a quote of "what happened" should come from.
const ERROR_LINE =
  /##\[error\]|\b(?:Error|AssertionError|TypeError|ReferenceError|TimeoutError|HttpError)\b:|\berror\b[: ]|\bfailed\b|not healthy|timed out|Timed out|exceeded|ECONNRESET|ETIMEDOUT|Egress|panic:|fatal:/;
// Lines that look like errors but only report progress: the dispatch loop's per-lease line, Cypress's run table.
const NOISE =
  /^(?:shell:|env:|with:|\s*\* \[new (?:branch|tag)\]|(?:HEAD is now at|Previous HEAD position was) [0-9a-fA-F]+\b)|Process completed with exit code|##\[warning\]|reported \((?:failed|passed)\) →|\[queue: |^[✖✔│┌└├]|\b\d+ of \d+ failed \(\d+%\)|^\s*\d+ failing\s*$/;

/** Shared infrastructure / runner / external service failure patterns across CI jobs. */
export const CI_INFRA_RE =
  /Failed to get ID Token|Egress is over the account limit|Failed to GetCacheEntryDownloadURL|Failed to restore:|Cache not found for input keys|HttpError: (?:Server Error|Bad Gateway|Service Unavailable)|\b50[0234]\b.*(?:Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|GitHub (?:GET|POST) [^:]+: 5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network (?:error|aborted|timeout)|Could not resolve host|TLS handshake timeout|429 Too Many Requests|rate limit exceeded|The runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|No space left on device|Unable to download (?:artifact|action)|Failed to download action|could not fetch [0-9a-f]+ from promisor remote|fatal: (?:unable to access|early EOF|the remote end hung up)|RPC failed|Error: Unable to process command .* successfully|The operation was canceled|<!DOCTYPE html|answered with an HTML page/i;

/** Shared build / dependency / test-server failure patterns attributable to the code under test. */
export const CI_CODE_PATTERNS: [RegExp, string][] = [
  [
    /\*\* BUILD FAILED \*\*|error TS\d{4}:|Module not found|SyntaxError:|xcodebuild: error|Execution failed for task|Compilation failed|BUILD FAILURE|Build failed|cannot find symbol|Cannot find module/i,
    "the build failed",
  ],
  [
    /npm (?:ERR!|error) (?:code )?(?:ERESOLVE|ETARGET|EUSAGE)|`npm ci` can only install packages when your package\.json and package-lock\.json|No matching version found|Could not find a version that satisfies|lock file'?s? .* does not satisfy/i,
    "the dependencies did not install",
  ],
  [
    /server (?:is )?not healthy|(?:is|container) not healthy|failed to start (?:the )?(?:test )?server|server did not (?:start|become ready)|health ?check failed|Timed out waiting for the server|panic:/i,
    "the test server did not start",
  ],
];

export const failedStepOf = (j: GhJob): GhStep | null =>
  j.steps?.find((s) => s.conclusion === "failure") ??
  j.steps?.find((s) => s.conclusion === "cancelled" || s.conclusion === "timed_out") ??
  null;

/** A step's own output lines (its header and the log's group markers left out), optionally bounded by [from, to]. */
export function stepLines(log: string, from: number | null, to: number | null): string[] {
  const kept: string[] = [];
  let header = false;
  for (const raw of log.split(/\r?\n/)) {
    const m = STAMP.exec(raw);
    const line = (m ? m[3] : raw).replace(/\x1b\[[0-9;]*m/g, "").replace(/\[\d+m/g, "");
    if (line.startsWith("##[group]Run ")) header = true;
    if (header) {
      if (line.startsWith("##[endgroup]")) header = false;
      continue;
    }
    if (/^##\[(?:end)?group\]/.test(line)) continue;
    if (!line.trim() || line.startsWith("[command]") || /^##\[(?:start|end)-action/.test(line)) continue;
    const at = m ? Date.parse(`${m[1]}.${(m[2] ?? "0").padEnd(3, "0")}Z`) : null;
    if (from != null && to != null && at != null && (at < from - 1000 || at > to + 1000)) continue;
    kept.push(line);
  }
  return kept;
}

/** The step's error lines, most repeated first: digits folded so "after 10000ms" and "after 4000ms" count as one. */
export function errorLines(lines: string[], max = 5, secrets: string[] = []): string[] {
  const counts = new Map<string, { n: number; line: string }>();
  for (const l of lines) {
    const line = l.trim();
    if (!ERROR_LINE.test(line) || NOISE.test(line) || line.length < 8) continue;
    const clean = redact(line, secrets);
    const key = clean.replace(/\d+/g, "#").slice(0, 160);
    const seen = counts.get(key);
    if (seen) seen.n++;
    else counts.set(key, { n: 1, line: clean.slice(0, 240) });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((c) => c.line);
}

async function ghRawGet(fetchImpl: FetchImpl, token: string, path: string, timeoutMs = 60_000, deadline?: number): Promise<Response> {
  let last: Error | null = null;
  for (let i = 0; i < 3; i++) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const remaining = deadline !== undefined ? Math.max(1000, Math.min(timeoutMs, deadline - Date.now())) : timeoutMs;
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "mattermost-e2e-triage",
      },
      signal: AbortSignal.timeout(remaining),
    });
    if (res.ok) return res;
    last = new Error(`GitHub GET ${path.split("?")[0]}: ${res.status}`);
    if (res.status < 500 && res.status !== 429) break;
  }
  throw last ?? new Error(`GitHub GET ${path.split("?")[0]}: deadline exceeded`);
}

/** Lists all jobs on `(runId, attempt)` via paginated GitHub Actions API. */
export async function fetchRunJobs({
  fetchImpl,
  token,
  repository,
  runId,
  attempt,
  maxPages = 10,
  deadline,
}: {
  fetchImpl: FetchImpl;
  token: string;
  repository: string;
  runId: string;
  attempt: string;
  maxPages?: number;
  deadline?: number;
}): Promise<GhJob[]> {
  const all: GhJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const { total_count: total = 0, jobs: rows = [] } = (await (
      await ghRawGet(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, 60_000, deadline)
    ).json()) as { total_count?: number; jobs?: GhJob[] };
    all.push(...rows);
    if (!rows.length || all.length >= total) break;
  }
  return all;
}

/** Downloads a single job's raw log text. */
export async function fetchJobLog({
  fetchImpl,
  token,
  repository,
  jobId,
  timeoutMs = 30_000,
  deadline,
}: {
  fetchImpl: FetchImpl;
  token: string;
  repository: string;
  jobId: number;
  timeoutMs?: number;
  deadline?: number;
}): Promise<string> {
  return (await ghRawGet(fetchImpl, token, `/repos/${repository}/actions/jobs/${jobId}/logs`, timeoutMs, deadline)).text();
}

/** Filters run jobs to a lane by prefix and comma-separated include/exclude tokens (`!exclude`). */
export function filterLaneJobs(jobs: GhJob[], prefix?: string | null, filter?: string | null): { byPrefix: GhJob[]; lane: GhJob[] } {
  const p = prefix ?? "";
  const byPrefix = p ? jobs.filter((j) => j.name.startsWith(p)) : jobs;
  const tokens = String(filter ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return { byPrefix, lane: byPrefix };
  const include = tokens.filter((t) => !t.startsWith("!"));
  const exclude = tokens.filter((t) => t.startsWith("!")).map((t) => t.slice(1)).filter(Boolean);
  const lane = byPrefix.filter((j) => {
    const name = j.name.toLowerCase();
    return (!include.length || include.some((t) => name.includes(t))) && !exclude.some((t) => name.includes(t));
  });
  return { byPrefix, lane };
}

export interface SkimmedCiLogs {
  runExcerpt: string;
  byFinding: Map<number, string>;
}

const MAX_RAW_LOG_CHARS = 2_000_000;
const RUN_EXCERPT_MAX = 1500;
const FINDING_EXCERPT_MAX = 1200;

function findingSearchTerms(f: Pick<Finding, "file" | "title" | "full_title">): string[] {
  const terms: string[] = [];
  const mm = /(?:^|[^a-z0-9])(mm-t\d+)(?!\d)/i.exec(`${f.full_title ?? ""} ${f.title}`);
  if (mm) terms.push(mm[1]);
  const base = String(f.file ?? "").split(/[\\/]/).pop() ?? "";
  if (base.length >= 4) terms.push(base);
  const title = String(f.title ?? "").trim();
  if (title.length >= 12 && title !== "spec did not run") terms.push(title.slice(0, 64));
  return [...new Set(terms)];
}

export const OS_GROUPS = [/\b(?:ubuntu|linux)\b/, /\bwindows\b/, /\bmacos\b/] as const;
const SUITE_GROUPS = [/\bcypress\b/, /\bplaywright\b/, /\bdetox\b/, /\bmaestro\b/] as const;
const MOBILE_GROUPS = [/\bios\b/, /\bandroid\b/, /\bipad\b/] as const;

function conflictingGroup(laneStr: string, targetStr: string, groups: readonly RegExp[]): boolean {
  const mine = groups.filter((re) => re.test(laneStr));
  if (!mine.length) return false;
  const hits = groups.filter((re) => re.test(targetStr));
  return hits.length > 0 && hits.some((re) => !mine.includes(re));
}

export function hasLaneTagConflict(laneStr: string, targetStr: string): boolean {
  return conflictingGroup(laneStr, targetStr, OS_GROUPS) || conflictingGroup(laneStr, targetStr, SUITE_GROUPS) || conflictingGroup(laneStr, targetStr, MOBILE_GROUPS);
}

function extractMatchingWindow(lines: string[], terms: string[], maxChars: number, secrets: string[] = []): string {
  if (!terms.length || !lines.length) return "";
  const matchers = terms.map((t) => {
    const low = t.toLowerCase();
    if (/^mm-t\d+$/.test(low)) {
      const re = new RegExp(`(?:^|[^a-z0-9])${low}(?!\\d)`);
      return (line: string) => re.test(line);
    }
    return (line: string) => line.includes(low);
  });
  const snippets: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length && snippets.length < 2; i++) {
    const lower = lines[i].toLowerCase();
    if (!matchers.some((m) => m(lower))) continue;
    const from = Math.max(0, i - 4);
    const to = Math.min(lines.length, i + 7);
    const chunk = redact(lines.slice(from, to).join("\n"), secrets);
    if (used + chunk.length > maxChars && snippets.length > 0) break;
    snippets.push(chunk);
    used += chunk.length + 5;
    i = to - 1;
  }
  return redact(snippets.join("\n---\n"), secrets).slice(0, maxChars);
}

/**
 * Skims CI job logs for failing test runs: extracts deduplicated run-level error lines and
 * spec/test-correlated windows for individual findings. Always degrades gracefully on errors.
 */
export async function skimCiLogsForFindings({
  fetchImpl,
  token,
  repository,
  runId,
  attempt,
  findings,
  prefix = null,
  filter = null,
  reportName = null,
  lane = null,
  secrets = [],
  log = () => {},
  maxJobs = 6,
  deadlineMs = 20_000,
}: {
  fetchImpl: FetchImpl;
  token: string;
  repository: string;
  runId: string;
  attempt: string;
  findings: Finding[];
  prefix?: string | null;
  filter?: string | null;
  reportName?: string | null;
  lane?: string | null;
  secrets?: string[];
  log?: (message: string) => void;
  maxJobs?: number;
  deadlineMs?: number;
}): Promise<SkimmedCiLogs> {
  const empty: SkimmedCiLogs = { runExcerpt: "", byFinding: new Map() };
  if (!token || !repository || !runId || !findings.length) return empty;
  const deadline = Date.now() + deadlineMs;
  try {
    const allJobs = await fetchRunJobs({ fetchImpl, token, repository, runId, attempt, deadline });
    const { lane: filtered } = filterLaneJobs(allJobs, prefix, filter);
    let scoped = filtered.filter((j) => !OWN_RESULT_JOB.test(j.name));
    if (![prefix, filter, reportName, lane].some((s) => /\bsubpath\b/i.test(String(s ?? "")))) {
      scoped = scoped.filter((j) => !/\bsubpath\b/i.test(j.name));
    }
    // If no explicit prefix/filter was given, drop conflicting OS/suite/mobile jobs and narrow by hint from reportName or lane.
    const laneStr = [reportName, lane].filter(Boolean).join(" ").toLowerCase();
    if (!prefix && !filter && laneStr) {
      scoped = scoped.filter((j) => !hasLaneTagConflict(laneStr, j.name.toLowerCase()));
      const hint = laneStr.match(/\b(ubuntu|linux|windows|macos|cypress|playwright|detox-ios|detox-android|detox-ipad|maestro-ios|maestro-android)\b/);
      if (hint) {
        const matched = scoped.filter((j) => j.name.toLowerCase().includes(hint[1]));
        if (matched.length) scoped = matched;
      }
    }
    const dead = scoped.filter((j) => DEAD_CONCLUSIONS.has(j.status === "completed" ? String(j.conclusion) : j.status));
    const candidates = (dead.length ? dead : scoped.filter((j) => j.status === "completed")).slice(0, maxJobs);
    if (!candidates.length) return empty;

    const termsByFinding = findings.map((f) => findingSearchTerms(f));
    const runErrors: string[] = [];
    const byFinding = new Map<number, string>();

    for (const j of candidates) {
      if (Date.now() >= deadline) break;
      try {
        const raw = await fetchJobLog({
          fetchImpl,
          token,
          repository,
          jobId: j.id,
          timeoutMs: Math.max(1000, deadline - Date.now()),
          deadline,
        });
        const trimmed = raw.length > MAX_RAW_LOG_CHARS ? raw.slice(-MAX_RAW_LOG_CHARS) : raw;
        const step = failedStepOf(j);
        const focusedLines = step ? stepLines(trimmed, toMs(step.started_at), toMs(step.completed_at)) : [];
        const allLines = focusedLines.length ? focusedLines : stepLines(trimmed, null, null);
        for (const err of errorLines(allLines, 5, secrets)) {
          const line = `[${j.name}] ${err}`;
          if (!runErrors.includes(line)) runErrors.push(line);
        }
        for (let i = 0; i < findings.length; i++) {
          if (byFinding.has(i)) continue;
          const hit = extractMatchingWindow(allLines, termsByFinding[i], FINDING_EXCERPT_MAX, secrets);
          if (hit) byFinding.set(i, redact(`[${j.name}]\n${hit}`, secrets).slice(0, FINDING_EXCERPT_MAX));
        }
      } catch (e) {
        log(`ci log skim skipped for ${j.name}: ${String(e).slice(0, 120)}`);
      }
    }

    const runExcerpt = redact(runErrors.join("\n"), secrets).slice(0, RUN_EXCERPT_MAX);
    return { runExcerpt, byFinding };
  } catch (e) {
    log(`ci logs unavailable for run ${runId}: ${String(e).slice(0, 120)}`);
    return empty;
  }
}
