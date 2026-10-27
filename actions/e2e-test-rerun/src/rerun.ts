// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env, FetchImpl } from "../../shared/src/github.ts";

/**
 * The marker e2e-test-triage uploads when a lane is red only for jobs that sent no results: the attempt that asks, the
 * attempts its rerun-attempts allows in all, and the lane.
 */
const MARKER = /^e2e-triage-rerun-attempt-(\d+)-of-(\d+)-(.+)$/;

export interface RerunOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
}

export interface RerunResult {
  rerun: boolean;
  reason: string;
}

interface Artifact {
  name: string;
  expired?: boolean;
}

const refuse = (message: string): never => {
  throw new Error(`e2e-test-rerun: ${message}`);
};

/**
 * Re-runs a finished run's failed jobs when a lane's triage asked for it on this attempt, and the attempt is not the last
 * the repo allows. One re-run covers every lane that asked. The re-run attempt triages its lanes again.
 */
export async function requestRerun({ env, fetchImpl = fetch, log = console.log }: RerunOptions): Promise<RerunResult> {
  const repo = String(env.REPOSITORY ?? "");
  const runId = String(env.RUN_ID ?? "");
  const attempt = Number(env.RUN_ATTEMPT);
  const max = Number(env.MAX_ATTEMPTS ?? 5);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) refuse(`repository ${JSON.stringify(repo)} is not owner/name`);
  if (!/^\d+$/.test(runId)) refuse(`run id ${JSON.stringify(runId)} is not a number`);
  if (!Number.isInteger(attempt) || attempt < 1) refuse(`run attempt ${JSON.stringify(env.RUN_ATTEMPT)} is not 1 or more`);
  if (!Number.isInteger(max) || max < 1) refuse(`max attempts ${JSON.stringify(env.MAX_ATTEMPTS)} is not 1 or more`);
  const call = async (method: string, path: string): Promise<Response> => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "mattermost-e2e-rerun" },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const artifacts: Artifact[] = [];
  for (let page = 1; ; page++) {
    const { total_count: total = 0, artifacts: rows = [] } = (await (await call("GET", `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`)).json()) as { total_count?: number; artifacts?: Artifact[] };
    artifacts.push(...rows);
    if (!rows.length || artifacts.length >= total) break;
  }
  const asks = artifacts
    .filter((a) => !a.expired)
    .map((a) => MARKER.exec(a.name))
    .filter((m): m is RegExpExecArray => m != null && Number(m[1]) === attempt);
  const lanes = asks.map((m) => m[3]).sort();
  // The lanes' own limit, and max-attempts as the backstop.
  const limit = Math.min(max, ...asks.map((m) => Number(m[2])));
  let result: RerunResult;
  if (!lanes.length) result = { rerun: false, reason: `no lane asked for a re-run on attempt ${attempt}` };
  else if (attempt >= limit) result = { rerun: false, reason: `attempt ${attempt} is the last of ${limit}; a person re-runs it` };
  else {
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    result = { rerun: true, reason: `re-running the failed jobs for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
  }
  log(`e2e-test-rerun: ${result.reason}`);
  return result;
}
