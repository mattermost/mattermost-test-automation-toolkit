// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { fetchRun } from "../../shared/src/tsio.ts";
import { classify } from "./classify.ts";
import { decide, judge } from "./decision.ts";
import { buildPack } from "./pack.ts";
import { triage } from "./triage.ts";
import type { Answer, BatchResult, ChangedFile, Observation, PrRef } from "./types.ts";

interface FixtureId {
  repository: string;
  commit_sha: string;
  name: string;
  gh_run_id: string;
  gh_run_attempt: string;
  gh_pr_number?: number;
  branch: string;
}

interface FixtureSuite {
  id: string;
  title: string;
  file_path: string;
  report_name: string;
}

interface FixtureCase {
  suite_id: string;
  title: string;
  full_title?: string;
  status: string;
  retry_count: number;
  ordinal: number;
  error_message: string;
}

/** A request the fake network saw. Its body is parsed JSON, read by the caller that knows its shape (see bodyOf). */
interface Call {
  url: URL;
  method: string;
  body: unknown;
}

/** The fields of a commit-status write that the assertions read. */
interface StatusBody {
  state: string;
  context: string;
}

/** The parts of a Messages API request that the fake model reads. */
interface AnthropicBody {
  model: string;
  messages: { content: string | { type: string; text?: string }[] }[];
  output_config: { format: { schema: { properties: { answers?: unknown } } } };
}

interface Fixture {
  id: FixtureId;
  suites: FixtureSuite[];
  cases: FixtureCase[];
  history: Observation[];
  files: ChangedFile[];
  calls: Call[];
  modelCalls: number;
  truncated: boolean;
  diffError?: boolean;
  env: Env;
  fetch: FetchImpl;
}

/** A recorded write's body, read as the commit status it is. Only /statuses/ writes are read this way. */
const bodyOf = (c: Call): StatusBody => c.body as StatusBody;

const now = new Date("2026-09-30T12:00:00Z");

function fixture(): Fixture {
  const id: FixtureId = { repository: "o/r", commit_sha: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", gh_pr_number: 5, branch: "pr-5" };
  const env: Env = {
    COMPOSITE_IDENTITY: JSON.stringify(id),
    TSIO_BASE_URL: "http://fixture",
    GITHUB_TOKEN: "fake",
    ANTHROPIC_API_KEY: "fake",
    STATUS_CONTEXT: "e2e/windows",
    TEST_ROOT: "e2e",
    REPORT_NAME: "windows-",
  };
  const f: Fixture = {
    id,
    suites: [{ id: "s1", title: "A", file_path: "a.spec.ts", report_name: "windows-2.0" }],
    cases: [{ suite_id: "s1", title: "leaf", full_title: "A > leaf", status: "failed", retry_count: 0, ordinal: 0, error_message: "expected visible" }],
    history: Array.from({ length: 6 }, (_, i): Observation => ({ file: "a.spec.ts", title: "leaf", full_title: "A > leaf", suite_title: "A", report_name: "windows-1.0", group_id: `old-${i}`, name: "desktop-master", branch: "master", status: "passed", retry_count: 0, gh_pr_number: null, commit_sha: `old${i}`, created_at: `2026-09-${20 - i}T12:00:00Z` })),
    files: [{ filename: "app/other.ts", patch: "@@ unrelated change" }],
    calls: [],
    modelCalls: 0,
    truncated: false,
    env,
    fetch: (url, init) => route(f, url, init),
  };
  return f;
}

/** The fake network: GitHub, TSIO and the Anthropic API, answering the routes the scenarios need. */
async function route(f: Fixture, url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url), p = u.pathname;
  f.calls.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : init.body });
  if (p === "/api/v1/reports") return Response.json({ reports: [{ ...f.id, commit: f.id.commit_sha, id: "current", status: "completed" }] });
  if (p.endsWith("/suites")) return Response.json({ suites: f.suites });
  if (p.endsWith("/cases")) return Response.json(f.cases);
  if (p.endsWith("/history")) return Response.json({ observations: f.history, has_more: f.truncated });
  // A past run's own counts (dropStormRuns): a quiet run, not a storm.
  if (/^\/api\/v1\/reports\/(?:old-\d+|sibling)$/.test(p)) return Response.json({ test_stats: { total: 10, failed: 1 } });
  if (p.endsWith("/pulls/5")) return Response.json({ title: "Change", base: { ref: "master" } });
  if (p.endsWith("/pulls/5/files")) return f.diffError ? new Response("unavailable", { status: 503 }) : Response.json(f.files);
  if (p.endsWith("/statuses")) return Response.json([{ context: f.env.STATUS_CONTEXT, state: "failure", target_url: `https://github.com/o/r/actions/runs/${f.id.gh_run_id}` }]);
  if (p.includes("/commits/")) return Response.json({ files: f.files });
  if (p.includes("/statuses/")) return Response.json({ id: 1 });
  if (u.hostname === "api.anthropic.com") {
    f.modelCalls++;
    const body = JSON.parse(String(init.body)) as AnthropicBody;
    const answer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "Recurs elsewhere" };
    // One call carries every finding of a run; answer each id it asks about.
    const first = body.messages[0].content;
    const text = typeof first === "string" ? first : (first.at(-1)?.text ?? "");
    const ids = [...new Set(text.match(/"id":"f\d+"/g) ?? [])].map((m) => m.slice(6, -1));
    const reply = body.output_config.format.schema.properties.answers ? { answers: ids.map((id) => ({ id, ...answer })) } : answer;
    // The real API names the model that answered; echo the one requested.
    return Response.json({ model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "text", text: JSON.stringify(reply) }] });
  }
  // A comparison no scenario routes is "nothing changed", as GitHub answers an identical pair.
  if (p.includes("/compare/")) return Response.json({ ahead_by: 0, behind_by: 0, total_commits: 0, files: [], commits: [] });
  throw new Error(`unexpected fake route ${p}`);
}

const live = (f: Fixture) => triage({ env: f.env, fetchImpl: f.fetch, now, log: () => {} });

test("merged suite rows retain distinct parent-qualified test outcomes", async () => {
  const f = fixture();
  f.cases.push({ ...f.cases[0], full_title: "B > leaf", status: "passed", ordinal: 1 });
  const run = await fetchRun(f.fetch, "http://fixture", f.id, f.env.REPORT_NAME ?? null);
  assert.equal(run.counts.total, 2);
  assert.equal(run.failing.length, 1);
  assert.equal(run.failing[0].full_title, "A > leaf");
});

test("qualified current ancestry cannot borrow legacy leaf-only history", async () => {
  const f = fixture();
  f.cases[0].full_title = "New parent > A > leaf";
  f.history.forEach((o) => { o.full_title = ""; o.status = "failed"; });
  const result = await live(f);
  assert.equal(result.verdict, "FAILURE");
  assert.equal(result.findings[0].identity_unresolved, true);
  assert.equal(f.modelCalls, 0);
});

test("missing suite file cannot bypass ownership through the judge", async () => {
  const f = fixture();
  f.suites[0].file_path = "";
  await assert.rejects(live(f), /without a suite file path/);
  assert.equal(f.modelCalls, 0);
});

for (const scenario of ["duplicate current report", "duplicate historical report", "historical sibling without current ancestry", "conflicting duplicate status"]) {
  test(`${scenario} cannot clear a failure or reach the model`, async () => {
    const f = fixture();
    f.history.forEach((o) => { o.status = "failed"; });
    if (scenario === "duplicate current report") {
      f.suites.push({ ...f.suites[0], id: "s2", report_name: "windows-other" });
      f.cases.push({ ...f.cases[0], suite_id: "s2", status: "passed" });
    } else if (scenario === "duplicate historical report") {
      f.history.push({ ...f.history[0], report_name: "windows-other" });
    } else if (scenario === "historical sibling without current ancestry") {
      delete f.cases[0].full_title;
      f.history.push({ ...f.history[0], full_title: "B > leaf", suite_title: "B", group_id: "sibling" });
    } else f.history.push({ ...f.history[0], status: "passed" });
    const result = await live(f);
    assert.equal(result.verdict, "FAILURE");
    assert.equal(result.findings[0].identity_unresolved, true);
    assert.equal(f.modelCalls, 0);
  });
}

test("stable report prefix accepts version changes; unscoped shard names can change", async () => {
  for (const scoped of [true, false]) {
    const f = fixture();
    if (!scoped) { delete f.env.REPORT_NAME; f.suites[0].report_name = "worker-9"; }
    f.history.forEach((o) => { o.status = "failed"; });
    f.env.ANTHROPIC_API_KEY = "";
    const result = await live(f);
    assert.equal(result.verdict, "SUCCESS");
    assert.equal(result.findings[0].trunk.runs, 6);
  }
});

test("judge boundary rejects unresolved identity even when a caller supplied a pack", async () => {
  const finding = classify({ file: "a", title: "t", error: "e", identity_unresolved: true }, [], []);
  const pack = buildPack(finding, [], { lane: "windows" } as PrRef, []);
  let calls = 0;
  await judge([finding], [pack], async (): Promise<BatchResult> => { calls++; return { answers: [], usage: null, served_model: "" }; });
  assert.equal(calls, 0);
  assert.equal(decide("BROKEN_ON_TRUNK", null, pack, undefined, false, true).blocking, true);
});

for (const scenario of ["owned spec", "missing diff", "missing test root", "missing trunk branch", "missing report identity", "truncated history", "trunk excludes itself"]) {
  test(`incomplete evidence clears nothing and asks no one: ${scenario}`, async () => {
    const f = fixture();
    f.history.forEach((o) => { o.status = "failed"; });
    if (scenario === "owned spec") f.files = [{ filename: "e2e/a.spec.ts", patch: "@@ spec" }];
    if (scenario === "missing diff") f.diffError = true;
    if (scenario === "missing test root") delete f.env.TEST_ROOT;
    if (scenario === "missing report identity") f.history.forEach((o) => { delete o.report_name; });
    if (scenario === "truncated history") f.truncated = true;
    if (scenario === "missing trunk branch" || scenario === "trunk excludes itself") {
      delete f.id.gh_pr_number;
      f.id.branch = scenario === "missing trunk branch" ? "" : "master";
      f.id.name = "desktop-master";
      f.env.COMPOSITE_IDENTITY = JSON.stringify(f.id);
      if (scenario === "trunk excludes itself") {
        f.history.forEach((o) => { o.status = "passed"; });
        f.history.unshift({ ...f.history[0], group_id: "current", status: "failed", created_at: now.toISOString() });
      }
    }
    const result = await live(f);
    assert.equal(result.verdict, "FAILURE");
    assert.equal(f.modelCalls, 0);
    // Report only: the only write is triage's line on the check, which stays red.
    const writes = f.calls.filter((c) => c.url.hostname === "api.github.com" && c.method !== "GET");
    assert.ok(writes.every((c) => c.url.pathname.includes("/statuses/") && bodyOf(c).state === "failure"), JSON.stringify(writes.map((c) => c.body)));
  });
}

test("the answers cache keys each sibling separately and is reused by a re-run", async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "triage-cache-"));
  const cachePath = join(dir, "answers.json");
  f.cases.push({ ...f.cases[0], full_title: "B > leaf", ordinal: 1 });
  f.history.push(...f.history.map((o) => ({ ...o, full_title: "B > leaf", suite_title: "B" })));
  // Another PR failing gives the model something it may cite.
  f.history.push(...["A > leaf", "B > leaf"].map((t) => ({ ...f.history[0], full_title: t, suite_title: t[0], gh_pr_number: 9, branch: "pr-9", name: "desktop-pr", status: "failed", group_id: `pr9-${t[0]}` })));
  f.env.ANSWERS_CACHE = cachePath;
  try {
    await live(f);
    // Besides the answers, the file keeps what this lane spent on the PR ("_pr_spend").
    const keys = Object.keys(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>);
    assert.equal(keys.filter((k) => !k.startsWith("_")).length, 2, "each sibling's evidence is cached under its own key");
    assert.equal(f.modelCalls, 1, "one call carries both findings");
    await live(f);
    assert.equal(f.modelCalls, 1, "the re-run reuses the answers");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("summary and outputs in both modes; only enforce sets the state, and never a comment", async () => {
  for (const mode of ["report-only", "enforce"]) {
    const f = fixture(), dir = mkdtempSync(join(tmpdir(), "triage-summary-"));
    const summaryPath = join(dir, "summary.md"), outputPath = join(dir, "outputs");
    f.env.MODE = mode;
    f.env.ANTHROPIC_API_KEY = "";
    f.env.GITHUB_STEP_SUMMARY = summaryPath;
    f.env.GITHUB_OUTPUT = outputPath;
    try {
      await live(f);
      assert.equal(f.calls.some((c) => c.url.pathname.includes("/comments")), false);
      const statuses = f.calls.filter((c) => c.url.pathname.includes("/statuses/"));
      assert.equal(statuses.filter((c) => !bodyOf(c).context.endsWith("/triage")).length, 1, "triage's line on the E2E check, in both modes");
      assert.equal(statuses.length, mode === "enforce" ? 3 : 1, "plus the triage check, pending then verdict, only when enforcing");
      if (mode !== "enforce") assert.equal(bodyOf(statuses[0]).state, "failure", "report only keeps the state the check had");
      const summary = readFileSync(summaryPath, "utf8");
      assert.match(summary, /🟡 1 needs a look/);
      assert.match(summary, /\*\*1 failure: 1 needs a look\.\*\*/);
      assert.doesNotMatch(summary, /required status is green|attributable to the PR/);
      assert.match(summary, mode === "enforce" ? /Triage sets the E2E check/ : /\*\*Report only\.\*\*/);
      assert.match(readFileSync(outputPath, "utf8"), /verdict=FAILURE\nblocking=1/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("mass failures require investigation without claiming the PR is innocent", async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "triage-infra-"));
  const summaryPath = join(dir, "summary.md");
  f.cases = Array.from({ length: 30 }, (_, i) => ({ ...f.cases[0], full_title: `test-${i}` }));
  f.env.GITHUB_STEP_SUMMARY = summaryPath;
  try {
    const result = await live(f);
    assert.equal(result.verdict, "ACTION_REQUIRED");
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /⚠️ needs investigation/);
    assert.match(summary, /30 tests failed in one run; check for a shared environment/);
    assert.match(summary, /product failure/);
    // Each failure is still sorted, so the author sees which ones need a look.
    assert.match(summary, /30 failures: /);
    assert.match(summary, /### (Needs a look|May be caused by this PR) \(\d+\)/);
    assert.doesNotMatch(summary, /not this PR|none caused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
