// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { FetchImpl } from "../../shared/src/github.ts";
import { lastLines } from "./rerun-check.ts";

/** One job of the lane on this attempt: how it ended, its failed step, and for a dead job that step's output. */
export interface LaneJob {
  id: number;
  name: string;
  /** The job's name without the lane's prefix: "dispatch-run-cypress-14", "prepare-run". */
  short: string;
  conclusion: string;
  step: string | null;
  /** The failed step's last lines, for a dead job whose log was read; "" otherwise. */
  tail: string;
  /** The failed step's error lines, most repeated first (at most 5), for a dead job whose log was read. */
  errors: string[];
  /** Whether this job is one of the lane's parallel test workers (its specs come from a shared queue). */
  worker: boolean;
}

export interface LaneJobs {
  /** The lane's prefix in the run's job names ("e2e-cypress / cypress-full / "), or "" when the run has one lane. */
  prefix: string;
  jobs: LaneJob[];
}

interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runner_name?: string | null;
  steps?: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[];
}

const DEAD = new Set(["failure", "cancelled", "timed_out"]);
// A test worker: one of the lane's parallel jobs that pull specs from the queue (dispatch-run-*, a numbered shard).
export const WORKER_JOB = /dispatch-run|\bshard\b|\bworker\b|\bmachine-\d+|-\d+$/i;
// This lane's own result jobs: they fail because a job before them did, so they are not why the lane is red.
const OWN_RESULT_JOB = /(?:^|\/ )(?:lane-result|report|summary|triage|status)\b/i;
const MAX_WORKER_LOGS = 10;
const TAIL_LINES = 60;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3})\d*)?Z (.*)$/;
// An error line in a step's output: what a quote of "what happened" should come from.
const ERROR_LINE = /##\[error\]|\b(?:Error|AssertionError|TypeError|ReferenceError|TimeoutError|HttpError)\b:|\berror\b[: ]|\bfailed\b|not healthy|timed out|Timed out|exceeded|ECONNRESET|ETIMEDOUT|Egress|panic:|fatal:/;
// Lines that look like errors but only report progress: the dispatch loop's per-lease line, Cypress's run table.
const NOISE = /^(?:shell:|env:|with:|\s*\* \[new (?:branch|tag)\])|Process completed with exit code|##\[warning\]|reported \((?:failed|passed)\) →|\[queue: |^[✖✔│┌└├]|\b\d+ of \d+ failed \(\d+%\)|^\s*\d+ failing\s*$/;

const toMs = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

/** The lane's prefix from a job name "a / b / lane-result / lane-result": everything before its own result job. */
export function lanePrefixOf(ownJobName: string): string {
  const parts = ownJobName.split(" / ");
  const at = parts.findIndex((p) => OWN_RESULT_JOB.test(p) || /lane-result/i.test(p));
  return at > 0 ? `${parts.slice(0, at).join(" / ")} / ` : "";
}

/** A step's own output lines (its header and the log's group markers left out), by the step's start and end times. */
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
export function errorLines(lines: string[], max = 5): string[] {
  const counts = new Map<string, { n: number; line: string }>();
  for (const l of lines) {
    const line = l.trim();
    if (!ERROR_LINE.test(line) || NOISE.test(line) || line.length < 8) continue;
    const key = line.replace(/\d+/g, "#").slice(0, 160);
    const seen = counts.get(key);
    if (seen) seen.n++;
    else counts.set(key, { n: 1, line: line.slice(0, 240) });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, max).map((c) => c.line);
}

/**
 * The lane's jobs on this attempt. The lane is found from this job (by its runner, or a name prefix the caller gives):
 * a run can hold several lanes. Every dead job outside the lane's own result jobs has its failed step's log read, up
 * to ten test workers (they fail alike when they fail together). Needs `actions: read`.
 */
export async function readLaneJobs({ fetchImpl, token, repository, runId, attempt, runnerName, prefix: given, log }: {
  fetchImpl: FetchImpl; token: string; repository: string; runId: string; attempt: string; runnerName?: string | null; prefix?: string | null; log: (message: string) => void;
}): Promise<LaneJobs> {
  const get = async (path: string): Promise<Response> => {
    let last: Error | null = null;
    for (let i = 0; i < 3; i++) {
      const res = await fetchImpl(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "mattermost-e2e-triage" }, signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      last = new Error(`GitHub GET ${path.split("?")[0]}: ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    }
    throw last ?? new Error(`GitHub GET ${path}`);
  };
  const all: GhJob[] = [];
  for (let page = 1; ; page++) {
    const { total_count: total = 0, jobs: rows = [] } = (await (await get(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`)).json()) as { total_count?: number; jobs?: GhJob[] };
    all.push(...rows);
    if (!rows.length || all.length >= total) break;
  }
  let prefix = given ?? "";
  if (!prefix && runnerName) {
    const own = all.find((j) => j.runner_name === runnerName && j.status !== "completed");
    if (own) prefix = lanePrefixOf(own.name);
  }
  const lane = prefix ? all.filter((j) => j.name.startsWith(prefix)) : all;
  const failedStep = (j: GhJob) => j.steps?.find((s) => s.conclusion === "failure") ?? j.steps?.find((s) => s.conclusion === "cancelled" || s.conclusion === "timed_out") ?? null;
  let workerLogs = 0;
  const out: LaneJob[] = [];
  for (const j of lane) {
    const short = j.name.slice(prefix.length);
    const worker = WORKER_JOB.test(short) && !/prepare|begin|prep-deps|setup/i.test(short);
    const conclusion = j.status === "completed" ? String(j.conclusion) : j.status;
    const step = failedStep(j);
    const job: LaneJob = { id: j.id, name: j.name, short, conclusion, step: step?.name ?? null, tail: "", errors: [], worker };
    const dead = DEAD.has(conclusion) && !OWN_RESULT_JOB.test(short);
    if (dead && (!worker || workerLogs++ < MAX_WORKER_LOGS)) {
      try {
        const lines = stepLines(await (await get(`/repos/${repository}/actions/jobs/${j.id}/logs`)).text(), toMs(step?.started_at), toMs(step?.completed_at));
        job.tail = lastLines(lines.join("\n"), TAIL_LINES);
        job.errors = errorLines(lines);
      } catch (e) {
        log(`log of ${j.name} unavailable: ${String(e).slice(0, 160)}`);
      }
    }
    out.push(job);
  }
  return { prefix, jobs: out };
}
