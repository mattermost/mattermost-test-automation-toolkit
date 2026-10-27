"use strict";

// src/index.ts
var import_node_fs = require("fs");

// src/rerun.ts
var MARKER = /^e2e-triage-rerun-attempt-(\d+)-of-(\d+)-(.+)$/;
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
  const lanes = asks.map((m) => m[3]).sort();
  const limit = Math.min(max, ...asks.map((m) => Number(m[2])));
  let result;
  if (!lanes.length) result = { rerun: false, reason: `no lane asked for a re-run on attempt ${attempt}` };
  else if (attempt >= limit) result = { rerun: false, reason: `attempt ${attempt} is the last of ${limit}; a person re-runs it` };
  else {
    await call("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
    result = { rerun: true, reason: `re-running the failed jobs for ${lanes.join(", ")} (attempt ${attempt + 1} of ${limit})` };
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
