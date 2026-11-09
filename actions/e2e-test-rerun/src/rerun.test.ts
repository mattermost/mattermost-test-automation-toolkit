// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FetchImpl } from "../../shared/src/github.ts";
import { requestRerun } from "./rerun.ts";

interface Call { method: string; url: string }
const github = (artifacts: { name: string; expired?: boolean }[], pages = 1) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "POST" && (url.endsWith("/actions/runs/40301634711/rerun-failed-jobs") || url.endsWith("/actions/runs/40301634711/rerun") || /\/actions\/jobs\/\d+\/rerun$/.test(url))) return new Response(null, { status: 201 });
    if (method === "GET" && /\/actions\/jobs\/\d+$/.test(url)) return Response.json({ run_id: 40301634711 });
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    if (method === "GET" && url.includes("/actions/runs/40301634711/artifacts")) {
      const rows = page <= pages ? artifacts.filter((_, i) => i % pages === page - 1) : [];
      return Response.json({ total_count: artifacts.length, artifacts: rows.map((a) => ({ expired: false, ...a })) });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as FetchImpl;
  return { calls, fetchImpl };
};
const env = (attempt: string, over: Record<string, string> = {}) => ({ GITHUB_TOKEN: "GH", REPOSITORY: "mattermost/mattermost-mobile", RUN_ID: "40301634711", RUN_ATTEMPT: attempt, MAX_ATTEMPTS: "3", ...over });
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST").length;

test("a lane's request for this attempt re-runs the run's failed jobs once, whatever the number of lanes asking", async () => {
  // mattermost-mobile run 40301634711: detox-ios's shard machine-1 died on npm ci, so two specs never ran.
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-ios" }, { name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-android" }, { name: "jest-results-1" }]);
  const result = await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(result, { rerun: true, reason: "re-running the failed jobs for e2e-test-detox-android, e2e-test-detox-ios (attempt 2 of 3)" });
  assert.equal(posts(gh.calls), 1);
});

test("a run a newer run on the same PR or concurrency group superseded is not re-run; dispatches for different PRs do not supersede each other", async () => {
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-ios" }]);
  const inner = gh.fetchImpl;
  let headBranch = "pr-1";
  let newerSha = "b2";
  let ownPr: number | null = null;
  let newerPr: number | null = null;
  let sharedGroup: string | null = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/actions/runs/40301634711"))
      return Response.json({
        id: 40301634711,
        workflow_id: 7,
        head_branch: headBranch,
        head_sha: "a1",
        run_number: 10,
        ...(ownPr ? { pull_requests: [{ number: ownPr }] } : {}),
        ...(sharedGroup ? { concurrency_group: sharedGroup } : {}),
      });
    if (url.includes(`/actions/workflows/7/runs?branch=${headBranch}`))
      return Response.json({
        workflow_runs: [
          {
            id: 40301634999,
            head_branch: headBranch,
            head_sha: newerSha,
            run_number: 11,
            ...(newerPr ? { pull_requests: [{ number: newerPr }] } : {}),
            ...(sharedGroup ? { concurrency_group: sharedGroup } : {}),
          },
          { id: 40301634711, head_branch: headBranch, head_sha: "a1", run_number: 10 },
        ],
      });
    return inner(url, init);
  }) as FetchImpl;
  assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl, log: () => {} }), { rerun: false, reason: "run 40301634999 superseded this run on its branch; not re-run" });
  assert.equal(posts(gh.calls), 0);
  // A newer run on the same PR branch with the same head SHA still shares the branch's concurrency group: not re-run.
  newerSha = "a1";
  assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl, log: () => {} }), { rerun: false, reason: "run 40301634999 superseded this run on its branch; not re-run" });
  assert.equal(posts(gh.calls), 0);
  // Manual dispatches from master for different PRs do not supersede each other, even when master moved between them.
  headBranch = "master";
  newerSha = "b2";
  ownPr = 101;
  newerPr = 102;
  assert.equal((await requestRerun({ env: env("1"), fetchImpl, log: () => {} })).rerun, true);
  // A newer manual dispatch from master for the same PR does supersede the earlier run.
  newerPr = 101;
  assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl, log: () => {} }), { rerun: false, reason: "run 40301634999 superseded this run on its branch; not re-run" });
  // When dispatches for different PRs share the workflow's concurrency group, the newer run still blocks the re-run.
  newerPr = 102;
  sharedGroup = "e2e-refs/heads/master";
  assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl, log: () => {} }), { rerun: false, reason: "run 40301634999 superseded this run on its branch; not re-run" });
});

test("an earlier attempt's request, an expired one, or none at all re-runs nothing", async () => {
  for (const artifacts of [[{ name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-ios" }], [{ name: "e2e-triage-rerun-attempt-2-of-3-e2e-test-detox-ios", expired: true }], [{ name: "jest-results-1" }]]) {
    const gh = github(artifacts);
    const result = await requestRerun({ env: env("2"), fetchImpl: gh.fetchImpl, log: () => {} });
    assert.deepEqual(result, { rerun: false, reason: "no lane asked for a re-run on attempt 2" }, JSON.stringify(artifacts));
    assert.equal(posts(gh.calls), 0);
  }
});

test("requests are read from every page of the run's artifacts", async () => {
  const gh = github([{ name: "a" }, { name: "b" }, { name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-ios" }], 3);
  assert.equal((await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} })).rerun, true);
});

test("the marker carries the lane's own limit, so the listener re-runs every attempt rerun-attempts allows", async () => {
  // rerun-attempts 3: four attempts in all; attempt 3 asks, and is re-run.
  const third = github([{ name: "e2e-triage-rerun-attempt-3-of-4-e2e-test-detox-ios" }]);
  assert.deepEqual(await requestRerun({ env: env("3", { MAX_ATTEMPTS: "5" }), fetchImpl: third.fetchImpl, log: () => {} }), { rerun: true, reason: "re-running the failed jobs for e2e-test-detox-ios (attempt 4 of 4)" });
  // A marker for its own last attempt is not acted on.
  const last = github([{ name: "e2e-triage-rerun-attempt-4-of-4-e2e-test-detox-ios" }]);
  assert.deepEqual(await requestRerun({ env: env("4", { MAX_ATTEMPTS: "5" }), fetchImpl: last.fetchImpl, log: () => {} }), { rerun: false, reason: "attempt 4 is the last of 4; a person re-runs it" });
});

test("the last attempt the repo allows is never re-run, whatever triage asked", async () => {
  // A backstop: triage stops asking on its own last attempt; a misconfigured lane must not loop.
  const gh = github([{ name: "e2e-triage-rerun-attempt-3-of-9-e2e-test-detox-ios" }]);
  const result = await requestRerun({ env: env("3"), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(result, { rerun: false, reason: "attempt 3 is the last of 3; a person re-runs it" });
  assert.equal(posts(gh.calls), 0);
});

test("a run id, attempt, repository or limit that is not what GitHub sends is refused before any call", async () => {
  for (const over of [{ RUN_ID: "40301634711/../x" }, { RUN_ATTEMPT: "0" }, { REPOSITORY: "mattermost" }, { MAX_ATTEMPTS: "two" }] as Record<string, string>[]) {
    const gh = github([]);
    await assert.rejects(requestRerun({ env: env("1", over), fetchImpl: gh.fetchImpl, log: () => {} }), /e2e-test-rerun:/, JSON.stringify(over));
    assert.equal(gh.calls.length, 0);
  }
});

test("the marker e2e-test-triage's action uploads is one this action acts on: names agree end to end", async () => {
  // Run the marker step exactly as triage's action.yml has it, and hand the artifact name it writes to the listener.
  const action = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../e2e-test-triage/action.yml"), "utf8");
  const step = action.slice(action.indexOf("- id: marker"));
  const script = step.slice(step.indexOf("run: |") + "run: |".length, step.indexOf("\n    - ")).split("\n").map((l) => l.replace(/^ {8}/, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "rerun-marker-"));
  try {
    const output = join(dir, "output");
    writeFileSync(output, "");
    execFileSync("bash", ["-e", "-c", script], { env: { ...process.env, STATUS_CONTEXT: "e2e-test/detox-ios", DESCRIPTION: "(re-running the failed jobs) 615 passed", RERUN_OF: "2", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: dir, GITHUB_OUTPUT: output } });
    const name = /^name=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? "";
    assert.equal(name, "e2e-triage-rerun-attempt-1-of-2-e2e-test-detox-ios");
    const gh = github([{ name }]);
    assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} }), { rerun: true, reason: "re-running the failed jobs for e2e-test-detox-ios (attempt 2 of 2)" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lane whose TSIO run began is re-run whole from its first job, so its workers find a new run instead of a closed one", async () => {
  // mattermost run 41940673353: a worker timed out holding a spec; re-running only the failed jobs found the run closed.
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-of-2-job-126961998001-e2e-test-playwright-full-enterprise" }]);
  const result = await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(result, { rerun: true, reason: "re-running the whole lane e2e-test-playwright-full-enterprise from its first job (attempt 2 of 2)" });
  assert.deepEqual(gh.calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname), ["/repos/mattermost/mattermost-mobile/actions/jobs/126961998001/rerun"]);
});

test("a marker whose job ID belongs to another run is refused before any re-run POST", async () => {
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-of-2-job-126961998001-e2e-test-playwright-full-enterprise" }]);
  const inner = gh.fetchImpl;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.endsWith("/actions/jobs/126961998001")) return Response.json({ run_id: 99999999999 });
    return inner(url, init);
  }) as FetchImpl;
  await assert.rejects(requestRerun({ env: env("1"), fetchImpl, log: () => {} }), /e2e-test-rerun: job 126961998001 does not belong to run 40301634711/);
  assert.equal(posts(gh.calls), 0);
});

test("two lanes that need a fresh start, or a lane whose first job was not found, re-run every job of the run", async () => {
  for (const artifacts of [
    [{ name: "e2e-triage-rerun-attempt-1-of-2-job-11-e2e-test-cypress-full-enterprise" }, { name: "e2e-triage-rerun-attempt-1-of-2-job-12-e2e-test-playwright-full-enterprise" }],
    [{ name: "e2e-triage-rerun-attempt-1-of-2-job-11-e2e-test-cypress-full-enterprise" }, { name: "e2e-triage-rerun-attempt-1-of-2-e2e-test-playwright-full-enterprise" }],
    [{ name: "e2e-triage-rerun-attempt-1-of-2-job-0-e2e-test-cypress-full-enterprise" }],
  ]) {
    const gh = github(artifacts);
    const result = await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} });
    assert.equal(result.rerun, true);
    assert.match(result.reason, /^re-running every job of the run for /);
    assert.deepEqual(gh.calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname), ["/repos/mattermost/mattermost-mobile/actions/runs/40301634711/rerun"], JSON.stringify(artifacts));
  }
});

test("a fresh-start request on the last allowed attempt asks a person, like any other", async () => {
  const gh = github([{ name: "e2e-triage-rerun-attempt-2-of-2-job-11-e2e-test-cypress-full-enterprise" }]);
  const result = await requestRerun({ env: env("2"), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(result, { rerun: false, reason: "attempt 2 is the last of 2; a person re-runs it" });
  assert.equal(posts(gh.calls), 0);
});

test("push runs on trunk are never told apart by their commit titles: an unresolved identity is superseded, not re-run", async () => {
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-of-3-e2e-test-detox-ios" }]);
  const inner = gh.fetchImpl;
  let event = "push";
  let ownTitle = "Fix the sidebar (#100)";
  let newerTitle = "Bump deps (#101)";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/actions/runs/40301634711"))
      return Response.json({ id: 40301634711, workflow_id: 7, head_branch: "main", head_sha: "a1", run_number: 10, event, display_title: ownTitle });
    if (url.includes("/actions/workflows/7/runs?branch=main"))
      return Response.json({ workflow_runs: [
        { id: 40301634999, head_branch: "main", head_sha: "b2", run_number: 11, event, display_title: newerTitle },
        { id: 40301634711, head_branch: "main", head_sha: "a1", run_number: 10, event, display_title: ownTitle },
      ] });
    return inner(url, init);
  }) as FetchImpl;
  // Commit titles name merged PRs (#100, #101), not the runs' identities; with no group either, the newer run may share
  // the concurrency group, so the older run is left to a person.
  assert.deepEqual(await requestRerun({ env: env("1"), fetchImpl, log: () => {} }), { rerun: false, reason: "run 40301634999 superseded this run on its branch; not re-run" });
  assert.equal(posts(gh.calls), 0);
  // A dispatched run's run-name does name the PR it tests: dispatches for different PRs still do not supersede each other.
  event = "workflow_dispatch";
  ownTitle = "E2E for PR #100";
  newerTitle = "E2E for PR #101";
  assert.equal((await requestRerun({ env: env("1"), fetchImpl, log: () => {} })).rerun, true);
});
