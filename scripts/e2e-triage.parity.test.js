// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, classify, decide, fetchRun, judge, replay, triage } from "./e2e-triage.mjs";

const now = new Date("2026-09-30T12:00:00Z");
function fixture() {
  const f = {
    id: { repository: "o/r", commit_sha: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", gh_pr_number: 5, branch: "pr-5" },
    suites: [{ id: "s1", title: "A", file_path: "a.spec.ts", report_name: "windows-2.0" }],
    cases: [{ suite_id: "s1", title: "leaf", full_title: "A > leaf", status: "failed", retry_count: 0, ordinal: 0, error_message: "expected visible" }],
    history: Array.from({ length: 6 }, (_, i) => ({ file: "a.spec.ts", title: "leaf", full_title: "A > leaf", suite_title: "A", report_name: "windows-1.0", group_id: `old-${i}`, name: "desktop-master", branch: "master", status: "passed", retry_count: 0, gh_pr_number: null, commit_sha: `old${i}`, created_at: `2026-09-${20-i}T12:00:00Z` })),
    files: [{ filename: "app/other.ts", patch: "@@ unrelated change" }],
    calls: [], modelCalls: 0, comment: null, truncated: false,
  };
  f.env = { COMPOSITE_IDENTITY: JSON.stringify(f.id), TSIO_BASE_URL: "http://fixture", GITHUB_TOKEN: "fake", ANTHROPIC_API_KEY: "fake", STATUS_CONTEXT: "e2e/windows", TEST_ROOT: "e2e", REPORT_NAME: "windows-" };
  f.fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname;
    f.calls.push({ url: u, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    if (p === "/api/v1/reports") return Response.json({ reports: [{ ...f.id, commit: f.id.commit_sha, id: "current", status: "completed" }] });
    if (p.endsWith("/suites")) return Response.json({ suites: f.suites });
    if (p.endsWith("/cases")) return Response.json(f.cases);
    if (p.endsWith("/history")) return Response.json({ observations: f.history, has_more: f.truncated });
    if (p.endsWith("/pulls/5")) return Response.json({ title: "Change", base: { ref: "master" } });
    if (p.endsWith("/pulls/5/files")) return f.diffError ? new Response("unavailable", { status: 503 }) : Response.json(f.files);
    if (p.includes("/commits/")) return Response.json({ files: f.files });
    if (p.endsWith("/comments") && init.method === "GET") {
      if (f.comment && u.searchParams.get("page") === "1") return Response.json(Array.from({ length: 100 }, () => ({ body: "unrelated" })));
      return Response.json(f.comment ? [f.comment] : []);
    }
    if (p.includes("/comments") || p.includes("/statuses/")) return Response.json({ id: 1 });
    if (u.hostname === "api.anthropic.com") {
      f.modelCalls++;
      const body = JSON.parse(init.body);
      const answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "Recurs elsewhere" };
      // One call carries every finding of a run; answer each id it asks about.
      const text = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.at(-1).text;
      const ids = [...new Set(text.match(/"id":"f\d+"/g) ?? [])].map((m) => m.slice(6, -1));
      const reply = body.output_config.format.schema.properties.answers ? { answers: ids.map((id) => ({ id, ...answer })) } : answer;
      // The real API names the model that answered; echo the one requested.
      return Response.json({ model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    throw new Error(`unexpected fake route ${p}`);
  };
  return f;
}
const live = (f) => triage({ env: f.env, fetchImpl: f.fetch, now, log: () => {} });
function corpus(f) {
  return { ...f.id, pr: f.id.gh_pr_number, run_at: now.toISOString(), truth: "regression", base_ref: "master", test_root: f.env.TEST_ROOT, report_name: f.env.REPORT_NAME };
}
async function replayFixture(f, { row = corpus(f), complete = true, compare = true, cache = {}, replayEnv = {}, dir: existingDir } = {}) {
  const dir = existingDir || mkdtempSync(join(tmpdir(), "triage-parity-"));
  const runsPath = join(dir, "runs.json"), comparePath = join(dir, "compare.json"), answersPath = join(dir, "answers.json"), outPath = join(dir, "out.json");
  writeFileSync(runsPath, JSON.stringify(Array.isArray(row) ? row : [row]));
  writeFileSync(comparePath, JSON.stringify(compare ? { "o/r:abc": { complete, files: f.files, pr_title: "Change" } } : {}));
  if (!existingDir) writeFileSync(answersPath, JSON.stringify(cache));
  try {
    const results = await replay({ runsPath, comparePath, answersPath, outPath, base: "http://fixture", fetchImpl: f.fetch, env: replayEnv, log: () => {} });
    return { results, report: JSON.parse(readFileSync(outPath)), answers: JSON.parse(readFileSync(answersPath)) };
  } finally {
    if (!existingDir) rmSync(dir, { recursive: true, force: true });
  }
}

test("merged suite rows retain distinct parent-qualified test outcomes", async () => {
  const f = fixture();
  f.cases.push({ ...f.cases[0], full_title: "B > leaf", status: "passed", ordinal: 1 });
  const run = await fetchRun(f.fetch, "http://fixture", f.id, f.env.REPORT_NAME);
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
  assert.equal((await replayFixture(f)).results[0].verdict, "FAILURE");
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
    const replayed = await replayFixture(f, { replayEnv: { ANTHROPIC_API_KEY: "fake" } });
    assert.equal(replayed.results[0].verdict, result.verdict);
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
    const replayed = await replayFixture(f);
    assert.equal(replayed.results[0].verdict, result.verdict);
  }
});

test("judge boundary rejects unresolved identity even when a caller supplied a pack", async () => {
  const finding = classify({ file: "a", title: "t", error: "e", identity_unresolved: true }, [], []);
  const pack = buildPack(finding, [], { lane: "windows" }, []);
  let calls = 0;
  await judge([finding], [pack], async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(decide("BROKEN_ON_TRUNK", null, pack, undefined, false, true).blocking, true);
});

for (const scenario of ["owned spec", "missing diff", "missing test root", "missing trunk branch", "missing report identity", "truncated history", "trunk excludes itself"]) {
  test(`live and replay agree: ${scenario}`, async () => {
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
    const replayed = await replayFixture(f, { compare: !f.diffError, replayEnv: { ANTHROPIC_API_KEY: "fake" } });
    assert.equal(replayed.results[0].verdict, result.verdict);
    assert.deepEqual(replayed.results[0].classes, result.findings.map((x) => x.class));
    assert.equal(result.verdict, "FAILURE");
    assert.equal(f.modelCalls, 0);
    assert.equal(f.calls.some((c) => c.url.hostname === "api.github.com" && c.method !== "GET"), false);
  });
}

test("replay requires a complete captured diff and never reuses legacy leaf-title answers", async () => {
  const f = fixture();
  f.history.push({ ...f.history[0], gh_pr_number: 9, status: "failed", group_id: "pr9", branch: "pr-9", name: "desktop-pr" });
  const cache = { "5|desktop-pr|abc|leaf": { cause: "flaky_environment", confidence: 0.99, cited_evidence: ["cross_pr"], explanation: "legacy" } };
  const oldCache = await replayFixture(f, { cache });
  assert.equal(oldCache.results[0].verdict, "FAILURE");
  const incomplete = await replayFixture(f, { complete: false, replayEnv: { ANTHROPIC_API_KEY: "fake" } });
  assert.equal(incomplete.results[0].verdict, "FAILURE");
  assert.equal(f.modelCalls, 0);
});

test("replay caches sibling packs separately and sends no GitHub requests", async () => {
  const f = fixture();
  f.cases.push({ ...f.cases[0], full_title: "B > leaf", ordinal: 1 });
  f.history.push(...f.history.map((o) => ({ ...o, full_title: "B > leaf", suite_title: "B" })));
  // One other PR failing gives the judge something it may cite; without it a
  // call could not change the outcome and is not made.
  f.history.push(...["A > leaf", "B > leaf"].map((t) => ({ ...f.history[0], full_title: t, suite_title: t[0], gh_pr_number: 9, branch: "pr-9", name: "desktop-pr", status: "failed", group_id: `pr9-${t[0]}` })));
  const dir = mkdtempSync(join(tmpdir(), "triage-cache-"));
  writeFileSync(join(dir, "answers.json"), "{}");
  try {
    const first = await replayFixture(f, { dir, replayEnv: { ANTHROPIC_API_KEY: "fake" } });
    assert.equal(Object.keys(first.answers).length, 2, "each sibling's evidence is cached under its own key");
    assert.equal(f.modelCalls, 1, "one call carries both findings");
    assert.notEqual(first.results[0].decisions[0].identity, first.results[0].decisions[1].identity);
    await replayFixture(f, { dir });
    assert.equal(f.modelCalls, 1, "second replay uses these exact evidence packs");
    assert.equal(f.calls.some((c) => c.url.hostname === "api.github.com"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replay reports partial coverage and rejects an empty or entirely skipped corpus", async () => {
  const f = fixture(), missing = { ...corpus(f), gh_run_id: null };
  const partial = await replayFixture(f, { row: [corpus(f), missing] });
  assert.equal(partial.report.evaluated, 1);
  assert.equal(partial.report.skipped.length, 1);
  await assert.rejects(replayFixture(f, { row: missing }), /No runs evaluated/);
  await assert.rejects(replayFixture(f, { row: [] }), /No runs evaluated/);
});

test("comments are opt-in in both modes; summary and outputs remain available without PR writes", async () => {
  for (const mode of ["report-only", "enforce"]) {
    const f = fixture(), dir = mkdtempSync(join(tmpdir(), "triage-summary-"));
    f.env.MODE = mode;
    f.env.ANTHROPIC_API_KEY = "";
    f.env.GITHUB_STEP_SUMMARY = join(dir, "summary.md");
    f.env.GITHUB_OUTPUT = join(dir, "outputs");
    try {
      await live(f);
      assert.equal(f.calls.some((c) => c.url.pathname.includes("/comments")), false);
      assert.equal(f.calls.filter((c) => c.url.pathname.includes("/statuses/")).length, mode === "enforce" ? 1 : 0);
      const summary = readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8");
      assert.match(summary, /1 failed → 0 cleared · 1 blocking/);
      assert.match(summary, /### Blocking \(1\)/);
      assert.doesNotMatch(summary, /required status is green|attributable to the PR/);
      if (mode === "report-only") assert.match(summary, /does not change the required commit status/);
      assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /verdict=FAILURE\nblocking=1/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("explicit comments create once or update an existing marker on a later page", async () => {
  for (const existing of [false, true]) {
    const f = fixture();
    f.env.POST_PR_COMMENT = "true";
    f.env.STATUS_CONTEXT = "e2e | windows";
    if (existing) f.comment = { id: 42, body: "<!-- e2e-triage:e2e &#124; windows -->\nold" };
    await live(f);
    const writes = f.calls.filter((c) => c.url.pathname.includes("/comments") && c.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, existing ? "PATCH" : "POST");
    if (existing) assert.equal(writes[0].url.pathname, "/repos/o/r/issues/comments/42");
  }
});

test("mass failures require investigation without claiming the PR is innocent", async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "triage-infra-"));
  f.cases = Array.from({ length: 30 }, (_, i) => ({ ...f.cases[0], full_title: `test-${i}` }));
  f.env.GITHUB_STEP_SUMMARY = join(dir, "summary.md");
  try {
    const result = await live(f);
    assert.equal(result.verdict, "ACTION_REQUIRED");
    const summary = readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8");
    assert.match(summary, /30 failed → 0 cleared · 30 blocking/);
    assert.match(summary, /product failure/);
    assert.doesNotMatch(summary, /not this PR|none caused/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
