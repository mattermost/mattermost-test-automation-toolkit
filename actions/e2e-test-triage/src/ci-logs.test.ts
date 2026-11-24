// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchImpl } from "../../shared/src/github.ts";
import { CI_CODE_PATTERNS, CI_INFRA_RE, errorLines, filterLaneJobs, skimCiLogsForFindings } from "./ci-logs.ts";
import type { Finding } from "./types.ts";

const makeFinding = (over: Partial<Finding>): Finding => ({
  file: "specs/channels/incoming_webhook_spec.ts",
  title: "MM-T633 Text in Slack-style attachment is searchable",
  class: "REGRESSION",
  reason: "failed",
  blocking: true,
  trunk: { runs: 5, fails: 0, flaky: 0, passes: 5, latest: "passed" },
  cross_pr: { prs: [], examples: [], passes: 5 },
  failure_signatures: [],
  trunk_break: null,
  this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  ...over,
});

test("shared CI infra and code failure classifiers cover runner/OIDC and build/server errors", () => {
  assert.equal(CI_INFRA_RE.test("Failed to get ID Token"), true);
  assert.equal(CI_INFRA_RE.test("<!DOCTYPE html><html>502"), true);
  assert.equal(CI_CODE_PATTERNS.some(([re]) => re.test("error TS2304: Cannot find name 'foo'")), true);
  assert.equal(CI_CODE_PATTERNS.some(([re]) => re.test("** BUILD FAILED **")), true);
});

test("filterLaneJobs applies include and !exclude filters", () => {
  const jobs = [
    { id: 1, name: "detox-android-build", status: "completed", conclusion: "success" },
    { id: 2, name: "maestro-android-test", status: "completed", conclusion: "failure" },
  ];
  const { lane } = filterLaneJobs(jobs, null, "android,!maestro");
  assert.deepEqual(
    lane.map((j) => j.id),
    [1],
  );
});

test("skimCiLogsForFindings extracts spec-correlated windows and run errors while redacting secrets", async () => {
  const rawLog = [
    "2026-11-20T10:00:00.0000000Z ##[group]Run e2e tests",
    "2026-11-20T10:00:00.0000000Z GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890",
    "2026-11-20T10:00:00.0000000Z ##[endgroup]",
    "2026-11-20T10:00:01.0000000Z Running incoming_webhook_spec.ts",
    "2026-11-20T10:00:02.0000000Z Error: connect ECONNREFUSED 127.0.0.1:8065 secret=my_super_secret_token",
    "2026-11-20T10:00:03.0000000Z   MM-T633 failed after 30000ms",
  ].join("\n");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/jobs?")) {
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 42,
            name: "e2e-cypress / cypress-full / dispatch-run-1",
            status: "completed",
            conclusion: "failure",
            steps: [{ name: "Run tests", conclusion: "failure", started_at: "2026-11-20T10:00:00Z", completed_at: "2026-11-20T10:00:05Z" }],
          },
        ],
      });
    }
    if (String(url).includes("/jobs/42/logs")) return new Response(rawLog);
    throw new Error(`unexpected ${url}`);
  }) as FetchImpl;

  const skimmed = await skimCiLogsForFindings({
    fetchImpl,
    token: "TOK",
    repository: "o/r",
    runId: "100",
    attempt: "1",
    findings: [makeFinding({})],
    secrets: ["my_super_secret_token"],
  });
  const excerpt = skimmed.byFinding.get(0) ?? "";
  assert.match(excerpt, /incoming_webhook_spec\.ts/);
  assert.match(excerpt, /ECONNREFUSED/);
  assert.doesNotMatch(excerpt, /my_super_secret_token/);
  assert.doesNotMatch(excerpt, /ghp_1234567890/);
  assert.match(skimmed.runExcerpt, /ECONNREFUSED/);
});

test("skimCiLogsForFindings excludes subpath jobs for non-subpath lanes and retains them for subpath lanes", async () => {
  const jobs = [
    { id: 10, name: "e2e-playwright-subpath / playwright-subpath / dispatch-run-1", status: "completed", conclusion: "failure" },
    { id: 20, name: "e2e-playwright / playwright-full / dispatch-run-1", status: "completed", conclusion: "failure" },
  ];
  const makeFetch = (jobList: typeof jobs, fetched: number[]): FetchImpl =>
    (async (url: string) => {
      const u = String(url);
      if (u.includes("/jobs?")) return Response.json({ total_count: jobList.length, jobs: jobList });
      const m = /\/jobs\/(\d+)\/logs/.exec(u);
      const id = Number(m?.[1]);
      fetched.push(id);
      if (id === 10) return new Response("2026-11-20T10:00:00.0000000Z Error: subpath failure");
      if (id === 20) return new Response("2026-11-20T10:00:00.0000000Z Error: full failure");
      throw new Error(`unexpected ${u}`);
    }) as FetchImpl;

  const nonSubpathFetched: number[] = [];
  const nonSubpath = await skimCiLogsForFindings({
    fetchImpl: makeFetch(jobs, nonSubpathFetched),
    token: "TOK",
    repository: "o/r",
    runId: "101",
    attempt: "1",
    lane: "playwright-full",
    reportName: "playwright-full",
    findings: [makeFinding({})],
  });
  assert.deepEqual(nonSubpathFetched, [20]);
  assert.match(nonSubpath.runExcerpt, /full failure/);
  assert.doesNotMatch(nonSubpath.runExcerpt, /subpath failure/);

  const onlySubpathFetched: number[] = [];
  const onlySubpath = await skimCiLogsForFindings({
    fetchImpl: makeFetch([jobs[0]], onlySubpathFetched),
    token: "TOK",
    repository: "o/r",
    runId: "102",
    attempt: "1",
    lane: "playwright-full",
    reportName: "playwright-full",
    findings: [makeFinding({})],
  });
  assert.deepEqual(onlySubpathFetched, []);
  assert.equal(onlySubpath.runExcerpt, "");

  const subpathFetched: number[] = [];
  const subpath = await skimCiLogsForFindings({
    fetchImpl: makeFetch(jobs, subpathFetched),
    token: "TOK",
    repository: "o/r",
    runId: "103",
    attempt: "1",
    lane: "playwright-subpath",
    reportName: "playwright-subpath",
    findings: [makeFinding({})],
  });
  assert.ok(subpathFetched.includes(10));
  assert.match(subpath.runExcerpt, /subpath failure/);
});

test("skimCiLogsForFindings ignores git checkout HEAD is now at and Previous HEAD position was lines", async () => {
  const rawLog = [
    '2026-11-20T10:00:00.0000000Z Previous HEAD position was abc1234 Revert "error: test timed out"',
    "2026-11-20T10:00:01.0000000Z HEAD is now at def5678 Fix error handling when login failed",
    "2026-11-20T10:00:02.0000000Z Error: real assertion failed on #postTextbox",
  ].join("\n");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/jobs?")) {
      return Response.json({
        total_count: 1,
        jobs: [{ id: 77, name: "e2e-playwright / playwright-full / dispatch-run-1", status: "completed", conclusion: "failure" }],
      });
    }
    if (String(url).includes("/jobs/77/logs")) return new Response(rawLog);
    throw new Error(`unexpected ${url}`);
  }) as FetchImpl;

  const skimmed = await skimCiLogsForFindings({
    fetchImpl,
    token: "TOK",
    repository: "o/r",
    runId: "104",
    attempt: "1",
    lane: "playwright-full",
    findings: [makeFinding({})],
  });
  assert.doesNotMatch(skimmed.runExcerpt, /HEAD is now at|Previous HEAD position was/);
  assert.match(skimmed.runExcerpt, /real assertion failed on #postTextbox/);
});

test("skimCiLogsForFindings respects deadline during job listing", async () => {
  const pages: number[] = [];
  const fetchImpl = (async (url: string) => {
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    pages.push(page);
    await new Promise((r) => setTimeout(r, 25));
    return Response.json({
      total_count: 200,
      jobs: [{ id: 1, name: "dispatch-run-1", status: "completed", conclusion: "failure" }],
    });
  }) as FetchImpl;

  const skimmed = await skimCiLogsForFindings({
    fetchImpl,
    token: "TOK",
    repository: "o/r",
    runId: "105",
    attempt: "1",
    findings: [makeFinding({})],
    deadlineMs: 10,
  });
  assert.deepEqual(pages, [1]);
  assert.equal(skimmed.runExcerpt, "");
});

test("skimCiLogsForFindings excludes conflicting lane jobs even when total job count is below maxJobs", async () => {
  const fetched: number[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/jobs?")) {
      return Response.json({
        total_count: 2,
        jobs: [
          { id: 1, name: "detox-ios-1", status: "completed", conclusion: "success" },
          { id: 2, name: "detox-android-1", status: "completed", conclusion: "failure" },
        ],
      });
    }
    const id = Number(/\/jobs\/(\d+)\/logs/.exec(u)?.[1]);
    fetched.push(id);
    if (id === 1) return new Response("2026-11-20T10:00:00.0000000Z All tests passed");
    return new Response("2026-11-20T10:00:00.0000000Z Error: android emulator crashed");
  }) as FetchImpl;

  const skimmed = await skimCiLogsForFindings({
    fetchImpl,
    token: "TOK",
    repository: "o/r",
    runId: "106",
    attempt: "1",
    lane: "detox-ios",
    findings: [makeFinding({})],
  });
  assert.deepEqual(fetched, [1]);
  assert.equal(skimmed.runExcerpt, "");
});

test("errorLines and extractMatchingWindow redact secrets crossing clip boundaries", async () => {
  const secret = "ghp_BoundarySecret9876543210abcdef";
  const prefix = secret.slice(0, 10);
  // "Error: failed " (14) + 214 + " " (1) = 229 -> 11 chars of secret before 240, remainder after.
  const longError = `Error: failed ${"x".repeat(214)} ${secret} tail`;
  const [line] = errorLines([longError], 5, [secret]);
  assert.ok(line);
  assert.doesNotMatch(line, new RegExp(prefix));

  // Line 0 ("Running incoming_webhook_spec.ts": 32) + "\n" + 4 * (230 + "\n") = 957; 957 + 227 + " " (1) = 1185 -> 15 chars before 1200 (10 before outer [p1]\n 1200 cut).
  const paddingLine = `2026-11-20T10:00:01.0000000Z ${"y".repeat(230)}`;
  const rawLog = [
    "2026-11-20T10:00:00.0000000Z Running incoming_webhook_spec.ts",
    paddingLine,
    paddingLine,
    paddingLine,
    paddingLine,
    `2026-11-20T10:00:02.0000000Z ${"z".repeat(227)} ${secret} tail`,
  ].join("\n");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/jobs?")) {
      return Response.json({
        total_count: 1,
        jobs: [{ id: 88, name: "p1", status: "completed", conclusion: "failure" }],
      });
    }
    if (String(url).includes("/jobs/88/logs")) return new Response(rawLog);
    throw new Error(`unexpected ${url}`);
  }) as FetchImpl;

  const skimmed = await skimCiLogsForFindings({
    fetchImpl,
    token: "TOK",
    repository: "o/r",
    runId: "107",
    attempt: "1",
    findings: [makeFinding({})],
    secrets: [secret],
  });
  const excerpt = skimmed.byFinding.get(0) ?? "";
  assert.ok(excerpt.length > 0);
  assert.doesNotMatch(excerpt, new RegExp(prefix));
});
