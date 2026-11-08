// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env, FetchImpl, GhApi } from "../../shared/src/github.ts";
import { allPassed, fetchOrchestration } from "../../shared/src/orchestration.ts";
import type { Orchestration } from "../../shared/src/orchestration.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { readBaseline } from "./baseline.ts";
import type { Baseline } from "./baseline.ts";
import { diagnoseLane } from "./lane-diagnosis.ts";
import type { LaneVerdict } from "./lane-diagnosis.ts";
import { readLaneJobs } from "./lane-jobs.ts";
import type { LaneJobs } from "./lane-jobs.ts";

/** A lane verdict and what it was read from, for the summary and the re-run. */
export interface JudgedLane {
  verdict: LaneVerdict;
  orchestration: Orchestration | null;
  jobs: LaneJobs | null;
  baseline: Baseline | null;
  /** The lane's first job, re-run (with every job after it) to start the lane afresh; null when it was not found. */
  startJobId: number | null;
}

/** Where the lane's specs and the code they run through live: its test root and support paths. */
export function lanePathsOf(testRoot: string | null, supportPaths: string[]): string[] {
  return [testRoot, ...supportPaths].filter((p): p is string => Boolean(p && p !== "."));
}

/**
 * Reads what a lane red outside its test results comes down to (see diagnoseLane): its orchestration, its jobs on this
 * attempt, and, unless every spec passed, the base branch's run of the lane. A read that fails is named in the verdict's
 * evidence; it never stops the verdict.
 */
export async function judgeLane({ env, fetchImpl, api, tsio, id, context, base, trunkRun, prFiles, lanePaths, judgedSpecs, noResults = false, log }: {
  env: Env; fetchImpl: FetchImpl; api: GhApi; tsio: string; id: CompositeIdentity; context: string; base: string | null; trunkRun: boolean;
  prFiles: string[] | null; lanePaths: string[]; judgedSpecs: string[];
  /** TSIO has no results for the run: the verdict is used whatever could be read. */
  noResults?: boolean;
  log: (message: string) => void;
}): Promise<JudgedLane> {
  let orchestration: Orchestration | null = null;
  let orchestrationError: string | null = null;
  try {
    orchestration = await fetchOrchestration(fetchImpl, tsio, id);
  } catch (e) {
    orchestrationError = String(e instanceof Error ? e.message : e).slice(0, 160);
    log(`orchestration unavailable: ${orchestrationError}`);
  }
  // The attempt this job runs in, against the attempt the TSIO identity was made in: a "re-run failed jobs" keeps the
  // first attempt's identity, so its workers find that run closed.
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT || id.gh_run_attempt || "1");
  const staleRerun = Number(runAttempt) > Number(id.gh_run_attempt || 1);
  let jobs: LaneJobs | null = null;
  let jobsError: string | null = null;
  try {
    jobs = await readLaneJobs({
      fetchImpl, token: String(env.GITHUB_TOKEN ?? ""), repository: id.repository, runId: String(env.GITHUB_RUN_ID || id.gh_run_id), attempt: runAttempt,
      runnerName: env.RUNNER_NAME ?? null, prefix: env.LANE_JOB_PREFIX || null, log,
    });
  } catch (e) {
    jobsError = String(e instanceof Error ? e.message : e).slice(0, 160);
    log(`the run's jobs could not be read (needs actions: read): ${jobsError}`);
  }
  let baseline: Baseline | null = null;
  // The base branch is read only where the verdict can be used (an orchestration, or no results at all) and needs it.
  if ((orchestration || noResults) && !allPassed(orchestration) && base) baseline = await readBaseline({ api, fetchImpl, tsio, id, context, base, trunkRun, log, historyLane: env.HISTORY_LANE || null });
  const verdict = diagnoseLane({ trunkRun, orchestration, orchestrationError, jobs: jobs?.jobs ?? null, jobsError, prFiles, baseline, lanePaths, staleRerun, judgedSpecs });
  const startName = env.LANE_START_JOB || "prepare-run";
  const startJobId = jobs?.jobs.find((j) => j.short === startName)?.id ?? null;
  return { verdict, orchestration, jobs, baseline, startJobId };
}
