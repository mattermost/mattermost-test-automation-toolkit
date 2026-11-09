"use strict";

// src/index.ts
var import_node_fs = require("fs");

// src/rerun.ts
var MARKER = /^e2e-triage-rerun-attempt-(\d+)-of-(\d+)-(?:job-(\d+)-)?(.+)$/;
var TRUNK_BRANCH = /^(?:main|master|release[/_.-])/i;
var supersedes = (own, other) => {
  if (own.group && other.group && own.group === other.group) return true;
  if (own.pr || other.pr) return Boolean(own.pr && other.pr && own.pr === other.pr);
  return false;
};
var refuse = (message) => {
  throw new Error(`e2e-test-rerun: ${message}`);
};
async function requestRerun({ env, fetchImpl = fetch, log = console.log }) {
  const repo = String(env.REPOSITORY ?? "");
  const runId = String(env.RUN_ID ?? "");
  const attempt = Number(env.RUN_ATTEMPT);
  const max = Number(env.MAX_ATTEMPTS ?? 5);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) refuse(`repository ${JSON.stringify(repo)} is not owner/name`);
  if (!/^\d+$/.test(runId)) refuse(`run id ${JSON.stringify(runId)} is not a number`);
  if (!Number.isInteger(attempt) || attempt < 1) refuse(`run attempt ${JSON.stringify(env.RUN_ATTEMPT)} is not 1 or more`);
  if (!Number.isInteger(max) || max < 1) refuse(`max attempts ${JSON.stringify(env.MAX_ATTEMPTS)} is not 1 or more`);
  const call = async (method, path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "mattermost-e2e-rerun" },
      signal: AbortSignal.timeout(6e4)
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const artifacts = [];
  for (let page = 1; ; page++) {
    const { total_count: total = 0, artifacts: rows = [] } = await (await call("GET", `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`)).json();
    artifacts.push(...rows);
    if (!rows.length || artifacts.length >= total) break;
  }
  const asks = artifacts.filter((a) => !a.expired).map((a) => MARKER.exec(a.name)).filter((m) => m != null && Number(m[1]) === attempt);
  const lanes = asks.map((m) => m[4]).sort();
  const fresh = asks.filter((m) => m[3] !== void 0).map((m) => Number(m[3]));
  const limit = Math.min(max, ...asks.map((m) => Number(m[2])));
  const runIdentity = async (w, fallbackBranch = "") => {
    const branch = String(w.head_branch ?? fallbackBranch ?? "").trim();
    const onTrunk = TRUNK_BRANCH.test(branch);
    const explicitGroup = typeof w.concurrency_group === "string" && w.concurrency_group.trim() ? w.concurrency_group.trim() : null;
    const inputPr = w.inputs?.pr_number ?? w.inputs?.PR_NUMBER ?? w.inputs?.pull_request;
    let pr = inputPr != null && /^[1-9]\d*$/.test(String(inputPr).trim()) ? String(inputPr).trim() : null;
    if (!pr && Array.isArray(w.pull_requests)) {
      const ownPr = w.pull_requests.find(
        (p) => p?.number != null && /^[1-9]\d*$/.test(String(p.number)) && (!p.base?.repo || p.base.repo.full_name === repo || Boolean(p.base.repo.url?.endsWith(`/${repo}`))) && !(onTrunk && p.head?.ref === branch)
      );
      if (ownPr?.number != null) pr = String(ownPr.number);
    }
    if (!pr) {
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
        const { jobs = [] } = await (await call("GET", `/repos/${repo}/actions/runs/${w.id}/jobs?per_page=10`)).json();
        for (const job of jobs) {
          if (!/^resolve-pr$|^Resolve E2E policy|^Compute build fingerprints|(?:^|\/ )\s*generate-build-variables$/i.test(job.name ?? "")) continue;
          const rawLog = (await (await call("GET", `/repos/${repo}/actions/jobs/${job.id}/logs`)).text()).replace(/\x1b\[[0-9;]*m/g, "");
          const prMatch = /(?:Manual trigger: resolving commit SHA from|Found|Resolved) PR #(\d+)|PR #(\d+) head repo match=|Cache trust scope: pr-(\d+)|^\s*(?:INPUT_)?PR_NUMBER:\s*(\d+)\s*$/m.exec(rawLog);
          const foundPr = prMatch?.[1] ?? prMatch?.[2] ?? prMatch?.[3] ?? prMatch?.[4];
          if (foundPr) {
            pr = foundPr;
            break;
          }
          runType ||= /^\s*(?:INPUT_)?(?:RUN|REPORT)_TYPE:\s*(\S+)\s*$/m.exec(rawLog)?.[1]?.toUpperCase() ?? "";
          commitSha ||= /^\s*(?:MOBILE_VERSION|INPUT_COMMIT_SHA|COMMIT_SHA):\s*([0-9a-f]{7,40})\s*$/mi.exec(rawLog)?.[1] ?? "";
        }
      } catch {
      }
    }
    const isTrunkRun = runType === "MAIN" || runType === "MASTER" || runType === "RELEASE";
    const group = explicitGroup ?? (pr ? `pr:${pr}` : !onTrunk && branch ? `branch:${branch}` : isTrunkRun && (commitSha || w.head_sha) ? `sha:${commitSha || w.head_sha}` : runType === "PR" && branch ? `branch:${branch}` : null);
    return { pr, group };
  };
  const newerRun = async () => {
    try {
      const run = await (await call("GET", `/repos/${repo}/actions/runs/${runId}`)).json();
      const branch = String(run.head_branch ?? "");
      const { workflow_runs: rows = [] } = await (await call("GET", `/repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}&per_page=5`)).json();
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
  let result;
  let newer = null;
  if (!lanes.length) result = { rerun: false, reason: `no lane asked for a re-run on attempt ${attempt}` };
  else if (attempt >= limit) result = { rerun: false, reason: `attempt ${attempt} is the last of ${limit}; a person re-runs it` };
  else if (newer = await newerRun()) result = { rerun: false, reason: `run ${newer} superseded this run on its branch; not re-run` };
  else if (!fresh.length) {
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    result = { rerun: true, reason: `re-running the failed jobs for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
  } else if (asks.length === 1 && fresh[0] > 0) {
    const job = await (await call("GET", `/repos/${repo}/actions/jobs/${fresh[0]}`)).json();
    if (String(job.run_id) !== runId.replace(/^0+(?=\d)/, "")) refuse(`job ${fresh[0]} does not belong to run ${runId}`);
    await call("POST", `/repos/${repo}/actions/jobs/${fresh[0]}/rerun`);
    result = { rerun: true, reason: `re-running the whole lane ${lanes[0]} from its first job (attempt ${attempt + 1} of ${limit})` };
  } else {
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun`);
    result = { rerun: true, reason: `re-running every job of the run for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
  }
  log(`e2e-test-rerun: ${result.reason}`);
  return result;
}

// src/index.ts
requestRerun({ env: process.env }).then((result) => {
  if (process.env.GITHUB_OUTPUT) (0, import_node_fs.appendFileSync)(process.env.GITHUB_OUTPUT, `rerun=${result.rerun}
`);
}).catch((e) => {
  console.error(String(e));
  process.exit(1);
});
