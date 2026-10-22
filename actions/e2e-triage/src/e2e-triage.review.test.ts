// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
// Reproductions from an external review: tests sharing a leaf title in one spec.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { triage } from "./triage.ts";
import type { Observation } from "./types.ts";

interface FixtureOptions {
  bothFail?: boolean;
  fullTitles?: boolean;
  judgeEnabled?: boolean;
}

interface ReviewCase {
  suite_id: string;
  title: string;
  full_title?: string;
  status: string;
  retry_count: number;
  ordinal: number;
  error_message: string;
}

function fixture({ bothFail = false, fullTitles = true, judgeEnabled = false }: FixtureOptions = {}) {
  const id = { repository: "o/r", commit_sha: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", gh_pr_number: 5, branch: "pr-5" };
  const file = "specs/a.spec.ts";
  const suites = ["A", "B"].map((s) => ({ id: "suite-" + s, title: "Suite " + s, file_path: file, report_name: "r1" }));
  const cases: ReviewCase[] = ["A", "B"].map((s, i) => ({
    suite_id: "suite-" + s, title: "same leaf",
    ...(fullTitles ? { full_title: "Suite " + s + " > same leaf" } : {}),
    status: s === "A" || bothFail ? "failed" : "passed", retry_count: 0, ordinal: i, error_message: "Error: expected visible",
  }));
  const history: Observation[] = ["A", "B"].flatMap((s) => Array.from({ length: 8 }, (_, i): Observation => ({
    file, title: "same leaf", suite_title: "Suite " + s, report_name: "r1",
    ...(fullTitles ? { full_title: "Suite " + s + " > same leaf" } : {}),
    group_id: "old-" + s + i, name: "desktop-master", branch: "master", gh_pr_number: null,
    status: s === "A" ? "passed" : "failed", retry_count: 0, ordinal: 0, commit_sha: "old" + i,
    created_at: "2026-09-" + String(20 - i).padStart(2, "0") + "T00:00:00Z",
  })));
  if (judgeEnabled) history.push({ ...history[8], group_id: "other-pr", name: "desktop-pr", branch: "pr-6", gh_pr_number: 6 });
  let asked = 0;
  const fetchImpl: FetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname;
    if (p === "/api/v1/reports") return Response.json({ reports: [{ id: "current", repository: id.repository, commit: id.commit_sha, name: id.name, gh_run_id: id.gh_run_id, gh_run_attempt: id.gh_run_attempt, status: "completed" }] });
    if (p.endsWith("/suites")) return Response.json({ suites });
    if (p.endsWith("/cases")) return Response.json(cases);
    if (p.endsWith("/history")) return Response.json({ observations: history, has_more: false });
    if (p.endsWith("/pulls/5/files")) return Response.json([{ filename: "app/change.ts", patch: "@@ unrelated change" }]);
    if (p.endsWith("/pulls/5")) return Response.json({ title: "Product fix", base: { ref: "master" } });
    if (u.hostname === "api.anthropic.com") {
      asked++;
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "Recurs on another PR" }) }] });
    }
    throw new Error("Unexpected fake route: " + p);
  };
  const env: Env = {
    COMPOSITE_IDENTITY: JSON.stringify(id), STATUS_CONTEXT: "e2e/windows", REPORT_NAME: "r1", TEST_ROOT: ".",
    MODE: "report-only", TSIO_BASE_URL: "http://fixture", GITHUB_TOKEN: "fake-only",
    ANTHROPIC_API_KEY: judgeEnabled ? "fake-only" : "",
  };
  return { fetchImpl, asked: () => asked, env };
}

test("both failing sibling tests keep independent full-title history", async () => {
  const f = fixture({ bothFail: true });
  const r = await triage({ env: f.env, fetchImpl: f.fetchImpl, log: () => {} });
  console.log("BOTH_FAIL", JSON.stringify({ verdict: r.verdict, findings: r.findings.map((x) => ({
    full_title: x.full_title, class: x.class, blocking: x.blocking, trunk: x.trunk,
  })) }));
  assert.equal(r.findings.find((x) => x.full_title === "Suite A > same leaf")?.blocking, true,
    "Suite A passed on trunk and must not borrow Suite B failures");
});

test("unresolved test identity cannot reach or be cleared by the judge", async () => {
  const f = fixture({ fullTitles: false, judgeEnabled: true });
  const r = await triage({ env: f.env, fetchImpl: f.fetchImpl, log: () => {} });
  console.log("UNRESOLVED_JUDGE", JSON.stringify({ verdict: r.verdict, asked: f.asked(), findings: r.findings.map((x) => ({
    class: x.class, identity_unresolved: x.identity_unresolved, blocking: x.blocking, decision: x.decision,
  })) }));
  assert.equal(f.asked(), 0, "Judge must not receive unresolved identity evidence");
  assert.equal(r.verdict, "FAILURE");
});
test("use-staging true with a conflicting tsio-base-url stops triage before any request", async () => {
  let requests = 0;
  const id = { repository: "o/r", commit_sha: "abc", name: "playwright-full", branch: "master", gh_run_id: "1", gh_run_attempt: "1" };
  await assert.rejects(
    triage({
      env: { COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_TOKEN: "fake", USE_STAGING: "true", TSIO_BASE_URL: "https://test-io.test.mattermost.com" },
      fetchImpl: async () => { requests++; throw new Error("should not fetch"); },
      log: () => {},
    }),
    /use-staging/,
  );
  assert.equal(requests, 0);
});
