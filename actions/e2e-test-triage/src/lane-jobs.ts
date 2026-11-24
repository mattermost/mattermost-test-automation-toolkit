// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { FetchImpl } from "../../shared/src/github.ts";
import {
  DEAD_CONCLUSIONS,
  errorLines,
  failedStepOf,
  fetchJobLog,
  fetchRunJobs,
  filterLaneJobs,
  lastLines,
  OWN_RESULT_JOB,
  stepLines,
  toMs,
  WORKER_JOB,
} from "./ci-logs.ts";
import type { GhJob } from "./ci-logs.ts";

export { errorLines, stepLines, WORKER_JOB };

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
  /** Prefix-scoped jobs before any lane-job-filter is applied, so startJobId still resolves prepare-run. */
  allJobs?: { id: number; short: string }[];
}

const MAX_WORKER_LOGS = 10;
const TAIL_LINES = 60;

/** The lane's prefix from a job name "a / b / lane-result / lane-result": everything before its own result job. */
export function lanePrefixOf(ownJobName: string): string {
  const parts = ownJobName.split(" / ");
  const at = parts.findIndex((p) => OWN_RESULT_JOB.test(p) || /lane-result/i.test(p));
  return at > 0 ? `${parts.slice(0, at).join(" / ")} / ` : "";
}

/**
 * The lane's jobs on this attempt. The lane is found from this job (by its runner, or a name prefix the caller gives):
 * a run can hold several lanes. Every dead job outside the lane's own result jobs has its failed step's log read, up
 * to ten test workers (they fail alike when they fail together). Needs `actions: read`.
 */
export async function readLaneJobs({ fetchImpl, token, repository, runId, attempt, runnerName, prefix: given, filter, log }: {
  fetchImpl: FetchImpl; token: string; repository: string; runId: string; attempt: string; runnerName?: string | null; prefix?: string | null; filter?: string | null; log: (message: string) => void;
}): Promise<LaneJobs> {
  const all: GhJob[] = await fetchRunJobs({ fetchImpl, token, repository, runId, attempt, maxPages: 100 });
  let prefix = given ?? "";
  if (!prefix && runnerName) {
    const own = all.find((j) => j.runner_name === runnerName && j.status !== "completed");
    if (own) prefix = lanePrefixOf(own.name);
  }
  const { byPrefix, lane } = filterLaneJobs(all, prefix, filter);
  let workerLogs = 0;
  const out: LaneJob[] = [];
  for (const j of lane) {
    const short = j.name.slice(prefix.length);
    const worker = WORKER_JOB.test(short) && !/prepare|begin|prep-deps|setup/i.test(short);
    const conclusion = j.status === "completed" ? String(j.conclusion) : j.status;
    const step = failedStepOf(j);
    const job: LaneJob = { id: j.id, name: j.name, short, conclusion, step: step?.name ?? null, tail: "", errors: [], worker };
    const dead = DEAD_CONCLUSIONS.has(conclusion) && !OWN_RESULT_JOB.test(short);
    if (dead && (!worker || workerLogs++ < MAX_WORKER_LOGS)) {
      try {
        const lines = stepLines(await fetchJobLog({ fetchImpl, token, repository, jobId: j.id, timeoutMs: 60_000 }), toMs(step?.started_at), toMs(step?.completed_at));
        job.tail = lastLines(lines.join("\n"), TAIL_LINES);
        job.errors = errorLines(lines);
      } catch (e) {
        log(`log of ${j.name} unavailable: ${String(e).slice(0, 160)}`);
      }
    }
    out.push(job);
  }
  const allJobs = byPrefix.map((j) => ({ id: j.id, short: j.name.slice(prefix.length) }));
  return { prefix, jobs: out, allJobs };
}
