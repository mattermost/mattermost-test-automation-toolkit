// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env, FetchImpl } from "../../shared/src/github.ts";

/**
 * The marker e2e-test-triage uploads when a lane is red only on a machine failure: the attempt that asks, the attempts
 * its rerun-attempts allows in all, optionally the lane's first job ("job-<id>-", 0 when it was not found), and the
 * lane. A marker with a job asks for the whole lane afresh: its TSIO run began, and re-running only its failed jobs
 * finds that run closed (their workers take no specs).
 */
const MARKER = /^e2e-triage-rerun-attempt-(\d+)-of-(\d+)-(?:job-(\d+)-)?(.+)$/;

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

interface WorkflowRun {
  id: number;
  workflow_id: number;
  head_branch?: string | null;
  head_sha?: string | null;
  run_number: number;
  name?: string | null;
  display_title?: string | null;
  event?: string | null;
  concurrency_group?: string | null;
  inputs?: Record<string, unknown> | null;
  pull_requests?: {
    number?: number | string | null;
    head?: { ref?: string | null; sha?: string | null } | null;
    base?: { ref?: string | null; repo?: { full_name?: string | null; url?: string | null } | null } | null;
  }[] | null;
}

interface RunIdentity {
  pr: string | null;
  group: string | null;
}

const TRUNK_BRANCH = /^(?:main|master|release[/_.-])/i;

/**
 * Whether a newer workflow run tests the same PR or shares the concurrency group that a re-run would contend with. A run
 * whose identity could not be resolved at all (no PR, no group: GitHub's run object carries neither concurrency_group
 * nor inputs) may share the newer run's group, and re-running it could cancel that run: it counts as superseded, so a
 * person re-runs it. A PR branch's run always resolves (its branch), so only a trunk run can land here.
 */
const supersedes = (own: RunIdentity, other: RunIdentity): boolean => {
  if (own.group && other.group && own.group === other.group) return true;
  const unresolved = (i: RunIdentity): boolean => !i.pr && !i.group;
  if (unresolved(own) || unresolved(other)) return true;
  if (own.pr || other.pr) return Boolean(own.pr && other.pr && own.pr === other.pr);
  return false;
};

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
  const lanes = asks.map((m) => m[4]).sort();
  // The lanes that need a fresh start, by their first job (0: not found, so the whole run is re-run).
  const fresh = asks.filter((m) => m[3] !== undefined).map((m) => Number(m[3]));
  // The lanes' own limit, and max-attempts as the backstop.
  const limit = Math.min(max, ...asks.map((m) => Number(m[2])));
  /** Resolves a workflow run's tested PR identity and concurrency group so only runs sharing them can supersede each other. */
  const runIdentity = async (w: WorkflowRun, fallbackBranch = ""): Promise<RunIdentity> => {
    const branch = String(w.head_branch ?? fallbackBranch ?? "").trim();
    const onTrunk = TRUNK_BRANCH.test(branch);
    const explicitGroup = typeof w.concurrency_group === "string" && w.concurrency_group.trim() ? w.concurrency_group.trim() : null;
    const inputPr = w.inputs?.pr_number ?? w.inputs?.PR_NUMBER ?? w.inputs?.pull_request;
    let pr: string | null = inputPr != null && /^[1-9]\d*$/.test(String(inputPr).trim()) ? String(inputPr).trim() : null;
    if (!pr && Array.isArray(w.pull_requests)) {
      const ownPr = w.pull_requests.find(
        (p) =>
          p?.number != null &&
          /^[1-9]\d*$/.test(String(p.number)) &&
          (!p.base?.repo || p.base.repo.full_name === repo || Boolean(p.base.repo.url?.endsWith(`/${repo}`))) &&
          !(onTrunk && p.head?.ref === branch),
      );
      if (ownPr?.number != null) pr = String(ownPr.number);
    }
    // A push run's title is its commit message: "Fix X (#100)" names the merged PR, not the PR the run tests, and two
    // pushes would read as two PRs. Only a dispatched run's title (its run-name) can name the PR it tests.
    if (!pr && w.event !== "push") {
      const titlePr = /(?:\bpr[ #:-]+|#)(\d+)\b/i.exec(`${w.display_title ?? ""} ${w.name ?? ""}`);
      if (titlePr) pr = titlePr[1];
    }
    if (!pr) {
      const branchPr = /^(?:pr|pull)[/-](\d+)$/i.exec(branch);
      if (branchPr) pr = branchPr[1];
    }
    let runType = String(w.inputs?.run_type ?? w.inputs?.report_type ?? "").trim().toUpperCase();
    let commitSha = String(w.inputs?.MOBILE_VERSION ?? w.inputs?.commit_sha ?? "").trim();
    if (!pr && !explicitGroup && onTrunk && w.id) {
      try {
        const { jobs = [] } = (await (await call("GET", `/repos/${repo}/actions/runs/${w.id}/jobs?per_page=10`)).json()) as {
          jobs?: { id: number; name?: string }[];
        };
        for (const job of jobs) {
          if (!/^resolve-pr$|^Resolve E2E policy|^Compute build fingerprints|(?:^|\/ )\s*generate-build-variables$/i.test(job.name ?? "")) continue;
          const rawLog = (await (await call("GET", `/repos/${repo}/actions/jobs/${job.id}/logs`)).text()).replace(/\x1b\[[0-9;]*m/g, "");
          const prMatch =
            /(?:Manual trigger: resolving commit SHA from|Found|Resolved) PR #(\d+)|PR #(\d+) head repo match=|Cache trust scope: pr-(\d+)|^\s*(?:INPUT_)?PR_NUMBER:\s*(\d+)\s*$/m.exec(rawLog);
          const foundPr = prMatch?.[1] ?? prMatch?.[2] ?? prMatch?.[3] ?? prMatch?.[4];
          if (foundPr) {
            pr = foundPr;
            break;
          }
          runType ||= /^\s*(?:INPUT_)?(?:RUN|REPORT)_TYPE:\s*(\S+)\s*$/m.exec(rawLog)?.[1]?.toUpperCase() ?? "";
          commitSha ||= /^\s*(?:MOBILE_VERSION|INPUT_COMMIT_SHA|COMMIT_SHA):\s*([0-9a-f]{7,40})\s*$/mi.exec(rawLog)?.[1] ?? "";
        }
      } catch {
        // Best-effort job/log lookup when dispatched from a trunk branch.
      }
    }
    const isTrunkRun = runType === "MAIN" || runType === "MASTER" || runType === "RELEASE";
    const group =
      explicitGroup ??
      (pr ? `pr:${pr}` : !onTrunk && branch ? `branch:${branch}` : isTrunkRun && (commitSha || w.head_sha) ? `sha:${commitSha || w.head_sha}` : runType === "PR" && branch ? `branch:${branch}` : null);
    return { pr, group };
  };
  // A newer run for the same PR or sharing the workflow's concurrency group supersedes this one: re-running this one
  // would cancel it through the concurrency group. A lookup that fails does not stop the re-run.
  const newerRun = async (): Promise<number | null> => {
    try {
      const run = (await (await call("GET", `/repos/${repo}/actions/runs/${runId}`)).json()) as WorkflowRun;
      const branch = String(run.head_branch ?? "");
      const { workflow_runs: rows = [] } = (await (await call("GET", `/repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}&per_page=5`)).json()) as { workflow_runs?: WorkflowRun[] };
      const candidates = rows.filter((r) => r.run_number > run.run_number);
      if (!candidates.length) return null;
      const own = await runIdentity(run, branch);
      for (const r of candidates) {
        if (supersedes(own, await runIdentity(r, branch))) return r.id;
      }
      return null;
    } catch (e) {
      log(`e2e-test-rerun: could not check for a newer run: ${String(e).slice(0, 160)}`);
      return null;
    }
  };
  // A run that ended "cancelled": re-run only when a job ran past its time limit (GitHub annotates it "The job has
  // exceeded the maximum execution time") and nothing cancelled the run ("The run was canceled by @who": a person, or a
  // newer run through the concurrency group). A lane's marker can predate the cancel, since another lane may still have
  // been running. Null: re-run it; else why not. A run that did not end cancelled, or whose conclusion cannot be read,
  // is left to the other checks, as before; a cancelled run whose jobs cannot be read is not re-run.
  const cancelledWhy = async (): Promise<string | null> => {
    let conclusion: string | null = null;
    try {
      conclusion = ((await (await call("GET", `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}`)).json()) as { conclusion?: string | null }).conclusion ?? null;
    } catch (e) {
      log(`e2e-test-rerun: could not read the run's conclusion: ${String(e).slice(0, 160)}`);
      return null;
    }
    if (conclusion !== "cancelled") return null;
    try {
      const jobs: { id: number; conclusion?: string | null }[] = [];
      for (let page = 1; page <= 10; page++) {
        const { total_count: total = 0, jobs: rows = [] } = (await (await call("GET", `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`)).json()) as { total_count?: number; jobs?: { id: number; conclusion?: string | null }[] };
        jobs.push(...rows);
        if (!rows.length || jobs.length >= total) break;
      }
      let timedOut = false;
      for (const job of jobs.filter((j) => j.conclusion === "cancelled").slice(0, 30)) {
        const notes = (await (await call("GET", `/repos/${repo}/check-runs/${job.id}/annotations`)).json()) as { message?: string | null }[];
        for (const { message = "" } of notes) {
          const by = /The run was canceled by (@\S+?)\.?$/m.exec(message ?? "");
          if (by) return `the run was cancelled by ${by[1]}, not by a job's time limit; not re-run`;
          if (/exceeded the maximum execution time/i.test(message ?? "")) timedOut = true;
        }
      }
      return timedOut ? null : "the run was cancelled and no job ran past its time limit; not re-run";
    } catch (e) {
      return `the run was cancelled and its jobs could not be read (${String(e).slice(0, 120)}); not re-run`;
    }
  };
  let result: RerunResult;
  let newer: number | null = null;
  let cancelled: string | null = null;
  if (!lanes.length) result = { rerun: false, reason: `no lane asked for a re-run on attempt ${attempt}` };
  else if (attempt >= limit) result = { rerun: false, reason: `attempt ${attempt} is the last of ${limit}; a person re-runs it` };
  else if ((cancelled = await cancelledWhy())) result = { rerun: false, reason: cancelled };
  else if ((newer = await newerRun())) result = { rerun: false, reason: `run ${newer} superseded this run on its branch; not re-run` };
  else if (!fresh.length) {
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    result = { rerun: true, reason: `re-running the failed jobs for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
  } else if (asks.length === 1 && fresh[0] > 0) {
    // One lane, started afresh: GitHub re-runs this job and every job that depends on it, as a new attempt, so the
    // lane makes a new TSIO run under that attempt. The run's other lanes keep their results.
    const job = (await (await call("GET", `/repos/${repo}/actions/jobs/${fresh[0]}`)).json()) as { run_id: number };
    if (String(job.run_id) !== runId.replace(/^0+(?=\d)/, "")) refuse(`job ${fresh[0]} does not belong to run ${runId}`);
    await call("POST", `/repos/${repo}/actions/jobs/${fresh[0]}/rerun`);
    result = { rerun: true, reason: `re-running the whole lane ${lanes[0]} from its first job (attempt ${attempt + 1} of ${limit})` };
  } else {
    // Several lanes asked, or a lane's first job was not found: one request can start only one job's chain, and a run
    // takes no second re-run while one is going. Every job of the run is re-run.
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun`);
    result = { rerun: true, reason: `re-running every job of the run for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
  }
  log(`e2e-test-rerun: ${result.reason}`);
  return result;
}
