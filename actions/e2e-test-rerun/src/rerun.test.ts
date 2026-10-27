// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchImpl } from "../../shared/src/github.ts";
import { requestRerun } from "./rerun.ts";

interface Call { method: string; url: string }
const github = (artifacts: { name: string; expired?: boolean }[], pages = 1) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "POST" && url.endsWith("/actions/runs/40301634711/rerun-failed-jobs")) return new Response(null, { status: 201 });
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
  const gh = github([{ name: "e2e-triage-rerun-attempt-1-e2e-test-detox-ios" }, { name: "e2e-triage-rerun-attempt-1-e2e-test-detox-android" }, { name: "jest-results-1" }]);
  const result = await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} });
  assert.deepEqual(result, { rerun: true, reason: "re-running the failed jobs for e2e-test-detox-android, e2e-test-detox-ios (attempt 2 of 3)" });
  assert.equal(posts(gh.calls), 1);
});

test("an earlier attempt's request, an expired one, or none at all re-runs nothing", async () => {
  for (const artifacts of [[{ name: "e2e-triage-rerun-attempt-1-e2e-test-detox-ios" }], [{ name: "e2e-triage-rerun-attempt-2-e2e-test-detox-ios", expired: true }], [{ name: "jest-results-1" }]]) {
    const gh = github(artifacts);
    const result = await requestRerun({ env: env("2"), fetchImpl: gh.fetchImpl, log: () => {} });
    assert.deepEqual(result, { rerun: false, reason: "no lane asked for a re-run on attempt 2" }, JSON.stringify(artifacts));
    assert.equal(posts(gh.calls), 0);
  }
});

test("requests are read from every page of the run's artifacts", async () => {
  const gh = github([{ name: "a" }, { name: "b" }, { name: "e2e-triage-rerun-attempt-1-e2e-test-detox-ios" }], 3);
  assert.equal((await requestRerun({ env: env("1"), fetchImpl: gh.fetchImpl, log: () => {} })).rerun, true);
});

test("the last attempt the repo allows is never re-run, whatever triage asked", async () => {
  // A backstop: triage stops asking on its own last attempt; a misconfigured lane must not loop.
  const gh = github([{ name: "e2e-triage-rerun-attempt-3-e2e-test-detox-ios" }]);
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
