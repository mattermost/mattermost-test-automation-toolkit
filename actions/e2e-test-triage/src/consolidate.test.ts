// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CommitStatus, GhApi } from "../../shared/src/github.ts";
import { buildTriageSummary, consolidate, loadFindingsDir, renderTriageSummaryMarkdown } from "./consolidate.ts";
import { FINDINGS_SCHEMA } from "./findings.ts";
import type { FindingsRecord } from "./findings.ts";

function withTmp(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "consolidate-test-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function record(over: Partial<FindingsRecord> = {}): FindingsRecord {
  return {
    schema: FINDINGS_SCHEMA,
    repository: "mattermost/mattermost-mobile",
    commit_sha: "abc1234",
    pr: 10368,
    lane: "detox-ios",
    status_context: "e2e-test/detox-ios",
    run_id: "100",
    run_attempt: "1",
    mode: "enforce",
    verdict: "SUCCESS",
    basis: "tests",
    description: "(1 flaky) 99% passed",
    lane_diagnosis: null,
    rerun: { requested: false, of: null, held: null },
    counts: { total: 10, passed: 9, failed: 1, flaky: 0, skipped: 0 },
    ai: { calls: 1, cost_usd: 0.0125, model: "claude-sonnet-5-5" },
    triaged: true,
    not_triaged_reason: null,
    findings: [],
    ...over,
  };
}

test("loadFindingsDir skips invalid JSON and non-findings files and sorts deterministically", async () => {
  await withTmp((dir) => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "z.json"), JSON.stringify(record({ lane: "maestro-ios" })));
    writeFileSync(join(dir, "sub", "a.json"), JSON.stringify(record({ lane: "detox-android" })));
    writeFileSync(join(dir, "ignore.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(dir, "broken.json"), "{not json");
    const logs: string[] = [];
    const loaded = loadFindingsDir(dir, (m) => logs.push(m));
    assert.deepEqual(loaded.map((r) => r.lane), ["detox-android", "maestro-ios"]);
    assert.equal(logs.length, 2);
  });
});

test("buildTriageSummary surfaces both blocking test failures and lane-level build/linker failures for humans and agents", () => {
  const secret = "ghp_secretvalue1234567890";
  const recs: FindingsRecord[] = [
    record({
      lane: "detox-ios-superseded",
      triaged: false,
      not_triaged_reason: "superseded: run 101 replaced this run",
      verdict: null,
      ai: { calls: 0, cost_usd: null, model: null },
      findings: [],
    }),
    record({
      lane: "detox-android",
      verdict: "FAILURE",
      description: `(1 caused by PR) 90% passed`,
      findings: [{
        title: "send post",
        full_title: "Chat > send post",
        file: "detox/e2e/test/smoke.e2e.ts",
        class: "REGRESSION",
        label: "caused by PR",
        blocking: true,
        decision: "adjudicator_blame",
        reason: "PR changed post composer",
        error_first_line: `Timeout waiting for composer ${secret}`,
        out_of_date: false,
        tries: { ran: 2, failed: 2 },
        other_lanes_failed: [],
        ai: { cause: "caused_by_pr", confidence: 0.92, cited: ["hunk_0"], cleared: false, explanation: "Composer testID removed" },
      }],
    }),
    record({
      lane: "detox-ios",
      verdict: "FAILURE",
      basis: "lane",
      description: "(caused by PR, fix the change) build-ios-simulator: ld: Too many personality routines",
      lane_diagnosis: { label: "caused by PR", fault: "PR", what: "build-ios-simulator: ld: Too many personality routines", action: "fix the change" },
      rerun: { requested: false, of: null, held: "PR broke build" },
      findings: [],
    }),
    record({
      lane: "maestro-ios",
      verdict: "SUCCESS",
      description: "(1 flaky) 100% passed",
      findings: [{
        title: "login",
        full_title: "Auth > login",
        file: "detox/maestro/login.yaml",
        class: "FLAKY_ON_TRUNK",
        label: "flaky",
        blocking: false,
        decision: "rules_unblock",
        reason: "flaky on main",
        error_first_line: "timeout",
        out_of_date: false,
        tries: { ran: 2, failed: 1 },
        other_lanes_failed: [],
        ai: { cause: null, confidence: null, cited: [], cleared: false, explanation: null },
      }],
    }),
  ];

  const summary = buildTriageSummary(recs, { state: "failure", description: "detox-android: 1 caused by PR · detox-ios: caused by PR" }, [secret]);
  assert.equal(summary.schema, 1);
  assert.equal(summary.totals.lanes, 4);
  assert.equal(summary.totals.failing_lanes, 2);
  assert.equal(summary.totals.blocking, 2);
  assert.equal(summary.totals.exonerated, 1);
  assert.equal(summary.totals.ai_calls, 3);
  assert.equal(summary.blocking_items.length, 2);
  assert.equal(summary.lanes.find((l) => l.lane === "detox-ios")?.blocking, 1);
  assert.equal(summary.lanes.find((l) => l.lane === "detox-ios-superseded")?.blocking, 0);

  const unknownCost = buildTriageSummary([record({ ai: { calls: 1, cost_usd: null, model: "custom" } })], null);
  assert.equal(unknownCost.totals.ai_cost_usd, null);
  assert.match(renderTriageSummaryMarkdown(unknownCost), /\(unknown\)/);
  assert.deepEqual(
    summary.blocking_items.map((b) => [b.lane, b.kind, b.recommended_action]),
    [
      ["detox-android", "test", "fix_pr"],
      ["detox-ios", "lane", "fix_pr"],
    ],
  );
  assert.equal(summary.blocking_items[0].error_first_line.includes(secret), false);

  const md = renderTriageSummaryMarkdown(summary);
  assert.match(md, /## ❌ E2E Triage Consolidated Summary/);
  assert.match(md, /### Agent Fix Brief/);
  assert.match(md, /ld: Too many personality routines/);
  assert.match(md, /\*\*\[fix_pr\]\*\*/);
});

test("consolidate settles aggregate status, respects only-if-exists, and writes JSON + summary without status when context is empty", async () => {
  await withTmp(async (dir) => {
    const findingsDir = join(dir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(join(findingsDir, "detox-ios.json"), JSON.stringify(record({ lane: "detox-ios", verdict: "SUCCESS" })));

    const summaryFile = join(dir, "out", "triage-summary.json");
    const stepSummary = join(dir, "step-summary.md");
    const ghOut = join(dir, "gh-output.txt");

    // 1. CMT / summary-only mode (no TRIAGE_CONTEXT -> zero GitHub API calls).
    await consolidate({
      env: { FINDINGS_DIR: findingsDir, SUMMARY_FILE: summaryFile, GITHUB_STEP_SUMMARY: stepSummary, GITHUB_OUTPUT: ghOut },
      fetchImpl: () => { throw new Error("should not call GitHub when TRIAGE_CONTEXT is empty"); },
      log: () => {},
    });
    const written = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.equal(written.overall_state, "success");
    assert.match(readFileSync(stepSummary, "utf8"), /All 1 triaged lane\(s\) cleared/);
    assert.match(readFileSync(ghOut, "utf8"), /published=false/);

    // 2. Attempt-2 clean rerun with only-if-exists clears Attempt 1's pending aggregate.
    const posted: CommitStatus[] = [];
    const routes = async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).includes("/statuses?") && (!init.method || init.method === "GET")) {
        return Response.json([
          { context: "e2e-test/detox-ios", state: "success", description: "100% passed", target_url: "https://github.com/o/r/actions/runs/55?status_run_id=55&status_run_attempt=2" },
          { context: "e2e-test/triage", state: "pending", description: "waiting", target_url: "https://github.com/o/r/actions/runs/55?status_run_id=55&status_run_attempt=1" },
        ]);
      }
      if (String(url).includes("/statuses/sha") && init.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as CommitStatus);
        return Response.json({});
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const emptyDir = join(dir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const out2 = join(dir, "gh-output-2.txt");
    await consolidate({
      env: {
        COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "sha", gh_run_id: "55", gh_run_attempt: "2" }),
        GITHUB_TOKEN: "gh-tok",
        TRIAGE_CONTEXT: "e2e-test/triage",
        TRIAGE_LANES: "e2e-test/detox-ios",
        ONLY_IF_EXISTS: "true",
        FINDINGS_DIR: emptyDir,
        SUMMARY_FILE: summaryFile,
        GITHUB_STEP_SUMMARY: join(dir, "step2.md"),
        GITHUB_OUTPUT: out2,
      },
      fetchImpl: routes as typeof fetch,
      log: () => {},
    });
    assert.equal(posted.length, 1);
    assert.deepEqual([posted[0].context, posted[0].state, posted[0].description], ["e2e-test/triage", "success", "All lanes green"]);
    assert.match(readFileSync(out2, "utf8"), /published=true/);

    // 3. Missing findings in summary-only mode resolves to error and writes step summary.
    const emptySummary = buildTriageSummary([], null);
    assert.equal(emptySummary.overall_state, "error");
    assert.equal(emptySummary.overall_description, "No triage findings available");
    const step3 = join(dir, "step3.md");
    const out3 = join(dir, "gh-output-3.txt");
    await consolidate({
      env: { FINDINGS_DIR: emptyDir, SUMMARY_FILE: summaryFile, GITHUB_STEP_SUMMARY: step3, GITHUB_OUTPUT: out3 },
      fetchImpl: () => { throw new Error("should not call GitHub when TRIAGE_CONTEXT is empty"); },
      log: () => {},
    });
    assert.equal(JSON.parse(readFileSync(summaryFile, "utf8")).overall_state, "error");
    assert.match(readFileSync(step3, "utf8"), /No triage findings available/);
    assert.match(readFileSync(out3, "utf8"), /state=error/);
  });
});
