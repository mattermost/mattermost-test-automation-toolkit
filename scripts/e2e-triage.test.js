// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULTS,
  parseAnswer,
  renderSummary,
  judge,
  samplingFor,
  servedMatches,
  identityKey,
  fetchChangedFiles,
  repoPath,
  buildPack,
  classify,
  laneOf,
  EXONERATED_ON_TRUNK,
  decide,
  evidenceIds,
  errorSignature,
  newLedger,
  canChange,
  compactError,
  costOf,
  priceFor,
  configFrom,
  answerKey,
  askModelBatch,
  evidenceFor,
  loadEvidence,
  sameFailure,
  fetchHistory,
  fetchRun,
  infraVerdict,
  isInfraError,
  namesChangedFile,
  laneSummary,
  missingReports,
  statusDescription,
  triage,
  verdictOf,
  failingLine,
  codeExcerpt,
  enrichFindings,
} from "./e2e-triage.mjs";

const obs = (over) => ({ file: "specs/a.spec.ts", title: "t1", status: "passed", retry_count: 0, gh_pr_number: null, commit_sha: "abcdef0123", created_at: "2026-09-10T10:00:00Z", branch: "master", ...over });
const failing = { file: "specs/a.spec.ts", title: "t1", error: "Error: expected visible" };
// Other PRs that failed the same test, so cross_pr evidence has real content.
const crossPR = (...prs) => prs.map((n) => obs({ gh_pr_number: n, status: "failed", commit_sha: `x${n}` }));
const trunkFailsAll = (n) => Array.from({ length: n }, (_, i) => obs({ commit_sha: `f${i}`, status: "failed", created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z` }));
const trunkPasses = (n) => Array.from({ length: n }, (_, i) => obs({ commit_sha: `c${i}`, created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z` }));

test("spec changed by the PR is the PR's problem, whatever history says", () => {
  const f = classify(failing, [...trunkPasses(10), obs({ gh_pr_number: 5, status: "failed" })], ["specs/a.spec.ts"]);
  assert.equal(f.class, "OWNED_BY_PR");
  assert.equal(f.blocking, true);
});
test("trunk currently failing the test clears the PR", () => {
  const f = classify(failing, [obs({ status: "failed" }), ...trunkPasses(6)], []);
  assert.equal(f.class, "BROKEN_ON_TRUNK");
  assert.equal(f.blocking, false);
});
test("a test that flakes on trunk clears the PR", () => {
  const f = classify(failing, [...trunkPasses(8), obs({ status: "flaky", commit_sha: "zz" })], []);
  assert.equal(f.class, "FLAKY_ON_TRUNK");
  assert.equal(f.blocking, false);
});
test("failing on three other PRs while trunk is green clears the PR; this PR's own runs do not count", () => {
  const hist = [...trunkPasses(6), obs({ gh_pr_number: 1, status: "failed" }), obs({ gh_pr_number: 2, status: "failed" }), obs({ gh_pr_number: 3, status: "failed" }), obs({ gh_pr_number: 3, status: "failed" }), obs({ gh_pr_number: 9, status: "failed" })];
  assert.equal(classify(failing, hist, [], undefined, 9).class, "FLAKY_CROSS_PR");
  assert.equal(classify(failing, hist.slice(0, 8), [], undefined, 9).class, "REGRESSION");
});
test("the PR's own runs never count as other PRs, even when TSIO sends string ids", () => {
  // jq-built identities carry the PR number as a string; PR 5's own failures must not count as other PRs'.
  const own = [1, 2, 3].map((i) => obs({ gh_pr_number: "5", status: "failed", commit_sha: `own${i}` }));
  const f = classify(failing, [...trunkPasses(8), ...own], [], undefined, "5");
  assert.notEqual(f.class, "FLAKY_CROSS_PR");
  assert.equal(f.cross_pr.prs.length, 0, "the PR's own failures must not be listed as other PRs");
  assert.equal(f.blocking, true);
});
test("on trunk, a failure that was already failing last run is a streak and stays red", () => {
  // The dangerous case: without this, a standing breakage on main clears itself
  // as BROKEN_ON_TRUNK every run and trunk stays green while genuinely broken.
  const history = [obs({ commit_sha: "prev", status: "failed" }), ...trunkPasses(8)];
  const f = classify(failing, history, [], undefined, null, null, { isTrunkRun: true });
  assert.equal(f.class, "BROKEN_ON_TRUNK");
  assert.equal(f.blocking, true, "a streak on trunk must never go green");
  assert.equal(EXONERATED_ON_TRUNK.has("BROKEN_ON_TRUNK"), false);
});
test("on trunk, an intermittent failure whose last run passed is a flake and clears", () => {
  const history = [obs({ commit_sha: "prev", status: "passed" }), obs({ commit_sha: "old", status: "failed" }), ...trunkPasses(6)];
  const f = classify(failing, history, [], undefined, null, null, { isTrunkRun: true });
  assert.equal(f.class, "FLAKY_ON_TRUNK");
  assert.equal(f.blocking, false);
});
test("a run is never part of its own history", () => {
  // On a trunk run the current group has no PR number; only the group id keeps it out of its own history.
  const history = [obs({ group_id: "self", status: "failed" }), ...trunkPasses(8)];
  const contaminated = classify(failing, history, [], undefined, null, null, { isTrunkRun: true });
  assert.equal(contaminated.class, "BROKEN_ON_TRUNK", "without the guard the run sees itself");
  assert.equal(contaminated.trunk.runs, 9);

  const f = classify(failing, history, [], undefined, null, null, { isTrunkRun: true, groupId: "self" });
  assert.equal(f.class, "REGRESSION", "excluded, it is a genuinely new failure over 8 clean runs");
  assert.equal(f.blocking, true);
  assert.equal(f.trunk.runs, 8);
});
test("on trunk, too little history cannot tell a flake from a new break", () => {
  const f = classify(failing, trunkPasses(3), [], undefined, null, null, { isTrunkRun: true });
  assert.equal(f.class, "INSUFFICIENT_DATA");
  assert.equal(f.blocking, true);
});
test("lane names line up between PR and trunk runs in every repo", () => {
  // If a PR run and a trunk run of the same suite land in different lanes, no
  // trunk history is ever found and every failure stays blocking, silently.
  for (const [pr, trunk] of [
    ["mobile-pr-detox-ios", "mobile-main-detox-ios"],
    ["mobile-pr-maestro-android-e2e", "mobile-main-maestro-android-e2e"],
    ["desktop-pr", "desktop-master"],
    ["playwright-full-enterprise", "playwright-full-enterprise-master"],
  ])
    assert.equal(laneOf(pr), laneOf(trunk), `${pr} and ${trunk} must share a lane`);
  // Different suites must still separate.
  assert.notEqual(laneOf("mobile-pr-detox-ios"), laneOf("mobile-pr-detox-android"));
});
test("history from another lane does not count", () => {
  const ios = (o) => obs({ ...o, name: o.gh_pr_number ? "mobile-pr-detox-ios" : "mobile-main-detox-ios" });
  const android = (o) => obs({ ...o, name: o.gh_pr_number ? "mobile-pr-detox-android" : "mobile-main-detox-android" });
  const hist = [...trunkPasses(6).map(ios), android({ gh_pr_number: 1, status: "failed" }), android({ gh_pr_number: 2, status: "failed" }), android({ gh_pr_number: 3, status: "failed" })];
  assert.equal(classify(failing, hist, [], undefined, 9, "detox-ios").class, "REGRESSION");
  assert.equal(classify(failing, hist, [], undefined, 9, null).class, "FLAKY_CROSS_PR");
  assert.equal(laneOf("playwright-full-enterprise-master"), "playwright-full-enterprise");
  assert.equal(laneOf("mobile-pr-detox-ios"), laneOf("mobile-main-detox-ios"));
  assert.equal(laneOf("playwright-full-enterprise-upgrade-from-release-11.7-esr-master"), "playwright-full-enterprise-upgrade-from-release-11.7-esr");
});
test("too little trunk history is borderline, not green", () => {
  const f = classify(failing, trunkPasses(2), []);
  assert.equal(f.class, "INSUFFICIENT_DATA");
  assert.equal(f.blocking, true);
});
test("infra call needs a majority of infra signatures or a storm", () => {
  const infra = { ...failing, error: "Error: server not healthy at http://x" };
  assert.ok(infraVerdict([infra, infra, infra, failing]));
  assert.equal(infraVerdict([infra, failing, failing, failing]), null);
  assert.ok(infraVerdict(Array.from({ length: 30 }, () => failing)));
});
test("a spec whose shard uploaded nothing is an infrastructure failure, not a test outcome", () => {
  // Verbatim from mattermost-mobile detox/utils/merge-jest-results-for-tsio.js.
  const missing = (spec) => ({ file: spec, title: "spec did not run", error: `${spec} was assigned to a shard but produced no result. The shard uploaded nothing, or its Jest process died before reaching this spec.` });
  assert.ok(isInfraError(missing("a.e2e.ts").error));
  const regression = { ...failing, error: "Test Failed: Timed out while waiting for expectation: NOT TOBEVISIBLE" };
  assert.equal(isInfraError(regression.error), false, "a Detox expectation timeout is not infrastructure");
  assert.ok(infraVerdict([regression, ...["a", "b", "c", "d", "e"].map((s) => missing(`${s}.e2e.ts`))]));
  assert.equal(infraVerdict([regression, regression, missing("a.e2e.ts")]), null, "one missing spec does not make the run infra");
});
test("decision matrix: unblock needs confidence plus a checkable citation; unknown citations are dropped", () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(11, 12)], [], undefined, 1);
  const pack = buildPack(f, [{ filename: "specs/a.spec.ts", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  const ok = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "recurs" };
  assert.equal(decide("REGRESSION", ok, pack).decision, "adjudicator_unblock");
  assert.equal(decide("REGRESSION", { ...ok, confidence: 0.8 }, pack).blocking, true);
  assert.equal(decide("REGRESSION", { ...ok, cited_evidence: ["error"] }, pack).blocking, true);
  assert.equal(decide("REGRESSION", { ...ok, cited_evidence: ["hunk_7"] }, pack).blocking, true);
  // "bug_on_master" no longer unblocks on its own; it still needs cross_pr or a hunk.
  assert.equal(decide("REGRESSION", { ...ok, cause: "bug_on_master", cited_evidence: ["engine"] }, pack).blocking, true);
  assert.equal(decide("FLAKY_CROSS_PR", { cause: "caused_by_pr", confidence: 0.95, cited_evidence: ["hunk_0"], explanation: "" }, pack).decision, "adjudicator_veto");
  assert.equal(decide("FLAKY_CROSS_PR", { cause: "caused_by_pr", confidence: 0.95, cited_evidence: ["error"], explanation: "" }, pack).blocking, false);
  assert.equal(decide("OWNED_BY_PR", ok, pack).blocking, true);
  assert.equal(decide("REGRESSION", null, pack).decision, "unavailable");

  // Empty evidence must not be citable.
  const alone = classify(failing, trunkPasses(8), []);
  const emptyPack = buildPack(alone, [{ filename: "docs/readme.md", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  assert.equal(evidenceIds(emptyPack).includes("cross_pr"), false, "no other PR failed, so cross_pr is not citable");
  assert.equal(decide("REGRESSION", ok, emptyPack).blocking, true, "citing empty cross_pr must not unblock");
  assert.equal(decide("REGRESSION", { ...ok, cited_evidence: ["hunk_0"] }, emptyPack).blocking, true, "an unrelated hunk must not unblock");
});
test("a claim that master is broken cannot unblock on its own", () => {
  // bug_on_master contradicts clean trunk history, so it needs a citation like any other cause.
  const pack = buildPack(classify(failing, [...trunkPasses(8), ...crossPR(21, 22)], [], undefined, 1), [{ filename: "specs/a.spec.ts", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  const noCitation = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: [], explanation: "x" }, pack);
  assert.equal(noCitation.blocking, true, "bug_on_master with no citation must stay blocking");
  const invented = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: ["made_up"], explanation: "x" }, pack);
  assert.equal(invented.blocking, true, "an invented citation is filtered, so it cannot unblock");
  const real = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: ["cross_pr"], explanation: "x" }, pack);
  assert.equal(real.blocking, false, "a checkable citation still clears it");
});
test("judge asks once per run, caps the findings it sends and survives an outage", async () => {
  const make = () => Array.from({ length: 10 }, (_, i) => classify({ ...failing, title: `t${i}` }, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1));
  const packsOf = (findings) => findings.map((f) => buildPack(f, [], { number: 1, repository: "o/r", title: "", lane: "l" }, []));
  const answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const sent = [];
  const findings = make();
  const ledger = newLedger();
  await judge(findings, packsOf(findings), async (packs, model) => {
    sent.push({ n: packs.length, model });
    return { answers: packs.map(() => answer), usage: { input_tokens: 10000, output_tokens: 1000 } };
  }, { ...DEFAULTS, escalationModel: "" }, () => {}, false, ledger);
  assert.deepEqual(sent, [{ n: 8, model: DEFAULTS.model }], "one call carries up to maxJudged findings");
  assert.equal(findings.filter((f) => f.decision === "adjudicator_unblock").length, 8);
  assert.equal(findings.slice(8).every((f) => f.blocking && !f.decision && f.ai.skipped), true);
  assert.equal(ledger.skipped.cap, 2);
  assert.equal(ledger.calls[0].cost_usd, (10000 * 2 + 1000 * 10) / 1e6, "priced at Sonnet 5.5 list price");

  const down = make();
  await judge(down, packsOf(down), async () => { throw new Error("boom"); }, DEFAULTS, () => {});
  assert.equal(down.filter((f) => f.decision === "unavailable").length, 8, "an outage leaves every asked finding on the rules' outcome");
  assert.equal(down.every((f) => f.blocking), true);
  assert.equal(verdictOf(down, null), "FAILURE");
});
test("parseAnswer rejects anything it would otherwise have to repair", () => {
  const ok = { cause: "test_bug", confidence: 0.5, cited_evidence: ["a"], explanation: "e" };
  assert.throws(() => parseAnswer(JSON.stringify({ ...ok, cause: "vibes" })), /unknown cause/);
  // An out-of-range confidence is rejected, not clamped (7 used to become 1 and clear).
  for (const bad of [7, -0.1, 1.0001, "0.9", null, true])
    assert.throws(() => parseAnswer(JSON.stringify({ ...ok, confidence: bad })), /confidence/, `confidence ${JSON.stringify(bad)}`);
  // NaN and Infinity cannot survive JSON, so test them past the parse.
  assert.throws(() => parseAnswer('{"cause":"test_bug","confidence":1e400,"cited_evidence":["a"],"explanation":"e"}'), /confidence/, "Infinity");
  assert.throws(() => parseAnswer(JSON.stringify({ ...ok, cited_evidence: ["a", 7] })), /cited_evidence/);
  assert.throws(() => parseAnswer(JSON.stringify({ ...ok, explanation: 3 })), /explanation/);
  // The boundaries themselves are valid.
  assert.equal(parseAnswer(JSON.stringify({ ...ok, confidence: 0 })).confidence, 0);
  assert.equal(parseAnswer(JSON.stringify({ ...ok, confidence: 1 })).confidence, 1);
});
test("the summary names the evidence and escapes markdown", () => {
  const f = { ...classify({ ...failing, title: "a | b" }, trunkPasses(8), []), judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "recurs <x>" }, decision: "adjudicator_unblock", blocking: false };
  const c = renderSummary({ verdict: "SUCCESS", findings: [f], infra: null, runURL: "u", counts: { failed: 1 } });
  assert.ok(c.startsWith("## E2E triage: ✅ all 1 failure cleared"));
  assert.ok(c.includes("a &#124; b") && c.includes("&lt;x&gt;"), "titles and the model's text are escaped");
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) if (String(url).includes(match)) return respond(init);
    throw new Error(`unexpected fetch ${url}`);
  };
  impl.calls = calls;
  return impl;
}
// A Messages API reply in the shape the request asked for: one answer per
// finding id for a run's batch, a bare answer for a single pack.
function modelReply(init, answer, usage = { input_tokens: 2000, output_tokens: 150 }) {
  const body = JSON.parse(init.body);
  const text = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.at(-1).text;
  const ids = [...new Set(text.match(/"id":"f\d+"/g) ?? [])].map((m) => m.slice(6, -1));
  const reply = body.output_config.format.schema.properties.answers ? { answers: ids.map((id) => ({ id, ...answer })) } : answer;
  return Response.json({ model: body.model, stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify(reply) }] });
}
// TSIO run fixtures: one group, one suite per spec, one case row per attempt.
const caseRow = (title, status, retry = 0, suite = "s1") => ({ suite_id: suite, title, status, retry_count: retry, ordinal: 0, error_message: status === "passed" ? null : "Error: expected visible", error_stack: null });
const spec = (title, status, retries = 0) => [...Array.from({ length: retries }, (_, i) => caseRow(title, "failed", i)), caseRow(title, status, retries)];
const runRoutes = (specs, name = "playwright-full") => [
  // The group carries its identity because fetchRun verifies it belongs to the
  // run being triaged rather than trusting the server to have filtered.
  ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name, gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
  ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
  ["/reports/g1/cases", () => Response.json(specs.flat())],
];
const env = {
  COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full", branch: "pr-5", gh_pr_number: 5 }),
  STATUS_CONTEXT: "e2e-test/playwright",
  TEST_ROOT: ".",
  // Explicit: report-only is the default, so a test that expects a status write
  // has to ask for enforcement.
  MODE: "enforce",
  BASE_REF: "master",
  GITHUB_TOKEN: "GH",
  ANTHROPIC_API_KEY: "AK",
  TSIO_BASE_URL: "http://tsio",
};

test("history is asked by run count, not by title or by window, and both queries are walked", async () => {
  const sent = [];
  const responses = [
    // trunk query, paged
    { observations: [obs({ commit_sha: "p1", group_id: "g1" }), obs({ title: "some other test in the same file", commit_sha: "x", group_id: "g1" })], has_more: true },
    { observations: [obs({ commit_sha: "p2", group_id: "g2" })], has_more: false },
    // cross-PR query: repeats g1, and carries a row the trunk query cannot see
    { observations: [obs({ commit_sha: "p1", group_id: "g1" }), obs({ commit_sha: "p3", group_id: "g3", gh_pr_number: 7, status: "failed", created_at: "2026-09-11T00:00:00Z" })], has_more: false },
  ];
  const fetchImpl = fakeFetch([["/reports/history", (init) => { sent.push(JSON.parse(init.body)); return Response.json(responses[sent.length - 1]); }]]);
  const history = await fetchHistory(fetchImpl, "http://tsio", "o/r", [failing, { ...failing, title: "t2" }], "2026-09-17T00:00:00Z", DEFAULTS, "master");

  // One file, deduplicated from two failing tests, and no titles in the request.
  assert.deepEqual(sent[0].files, ["specs/a.spec.ts"]);
  assert.equal(sent[0].tests, undefined);
  // A window is what overran the page cap on a busy repository, so neither query sends one.
  assert.equal(sent.every((b) => b.since === undefined), true, "no query asks for a time window");
  assert.equal(sent[0].branch, "master", "trunk history is scoped to the trunk branch");
  assert.equal(sent[0].runs, DEFAULTS.trunkRuns);
  assert.equal(sent[2].branch, undefined, "cross-PR evidence is not branch scoped");
  assert.equal(sent[2].runs, DEFAULTS.crossPRRuns);
  assert.equal(sent.length, 3, "each query pages until has_more is false");
  assert.deepEqual([sent[0].page, sent[1].page, sent[2].page], [1, 2, 1]);

  // Merged newest-first, because classify() reads trunk[0] as the latest trunk run.
  const rows = history.get(identityKey(failing));
  assert.deepEqual(rows.map((o) => o.commit_sha), ["p3", "p1", "p2"], "g1 is counted once even though both queries returned it");
  // Rows for tests the caller never asked about are dropped.
  assert.equal(history.has(identityKey({ ...failing, title: "some other test in the same file" })), false);
  assert.equal(history.get(identityKey({ ...failing, title: "t2" })), undefined, "a title with no rows stays unknown, so it stays blocking");
});
test("deduplication never drops a row it cannot identify", async () => {
  // Rows from different runs, or without a group id, must not collapse into one run.
  const noIds = Array.from({ length: 6 }, (_, i) => { const o = obs({ commit_sha: `c${i}` }); delete o.group_id; return o; });
  const single = fakeFetch([["/reports/history", () => Response.json({ observations: noIds })]]);
  const one = await fetchHistory(single, "http://tsio", "o/r", [failing], "2026-09-17T00:00:00Z", DEFAULTS, null);
  assert.equal(one.get(identityKey(failing)).length, 6, "one query cannot overlap itself, so nothing is deduplicated");

  const shared = [obs({ commit_sha: "a", group_id: "g1" }), obs({ commit_sha: "b", group_id: "g2" }), obs({ commit_sha: "c", group_id: "g3" })];
  const both = fakeFetch([["/reports/history", () => Response.json({ observations: shared })]]);
  const two = await fetchHistory(both, "http://tsio", "o/r", [failing], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  assert.equal(two.get(identityKey(failing)).length, 3, "distinct runs survive the overlap between the two queries");
});
test("a branch with no pull request is not trunk", () => {
  // A pushed branch without a PR has no PR number either; it is not trunk.
  const rows = [
    ...trunkPasses(6),
    obs({ commit_sha: "f1", branch: "fix/something", status: "failed", created_at: "2026-09-12T00:00:00Z" }),
    obs({ commit_sha: "f2", branch: "fix/something", status: "failed", created_at: "2026-09-11T00:00:00Z" }),
  ];
  const loose = classify(failing, rows, [], DEFAULTS, 5, null, {});
  assert.equal(loose.trunk.runs, 8, "without a trunk branch every branchless row counts, which is the old behaviour");

  const scoped = classify(failing, rows, [], DEFAULTS, 5, null, { trunkBranch: "master" });
  assert.equal(scoped.trunk.runs, 6, "the feature branch is excluded");
  assert.equal(scoped.trunk.fails, 0, "and so are its failures");
  assert.notEqual(scoped.class, "BROKEN_ON_TRUNK", "a feature branch cannot make trunk look broken");
});
test("a run can be narrowed to one report, and a filter that matches nothing fails closed", async () => {
  // A desktop run uploads one report per operating system into one group. Without
  // narrowing, every OS shares a single verdict and a single status.
  const suites = [
    { id: "s-linux", file_path: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-12.0.0-rc2" },
    { id: "s-mac", file_path: "specs/a.spec.ts", report_name: "e2e-on-macos-26-12.0.0-rc2" },
  ];
  const cases = [
    { suite_id: "s-linux", title: "t1", status: "failed", retry_count: 0, ordinal: 0, error_message: "boom", error_stack: null },
    { suite_id: "s-mac", title: "t2", status: "passed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null },
  ];
  const routes = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const id = { repository: "o/r", commit_sha: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1" };

  const all = await fetchRun(fakeFetch(routes), "http://tsio", id);
  assert.equal(all.counts.total, 2, "unfiltered, every operating system is in one bucket");

  const linux = await fetchRun(fakeFetch(routes), "http://tsio", id, "e2e-on-ubuntu-latest");
  assert.equal(linux.counts.total, 1);
  assert.deepEqual(linux.failing.map((f) => f.title), ["t1"], "only this OS's results");

  const mac = await fetchRun(fakeFetch(routes), "http://tsio", id, "e2e-on-macos");
  assert.equal(mac.failing.length, 0, "the other OS passed");

  // The dangerous case: a name that matches nothing would otherwise look like a
  // clean run and, under enforce, write a green status for results never read.
  await assert.rejects(
    () => fetchRun(fakeFetch(routes), "http://tsio", id, "e2e-on-windows"),
    /no report in group g1 has a name starting with/,
  );
});
test("ownership compares repository paths, not TSIO's test-root-relative ones", () => {
  // TSIO paths are relative to the test root; the PR's are relative to the repository.
  assert.equal(repoPath("e2e/specs", "calls/x.test.ts"), "e2e/specs/calls/x.test.ts");
  assert.equal(repoPath(".", "detox/e2e/test/a.e2e.ts"), "detox/e2e/test/a.e2e.ts");
  assert.equal(repoPath(null, "calls/x.test.ts"), null, "an unconfigured root is unknown, not repo-relative");

  const tsioPath = "calls/x.test.ts";
  const changed = ["e2e/specs/calls/x.test.ts"];
  const raw = classify({ file: tsioPath, title: "t", error: "e" }, trunkPasses(8), changed, DEFAULTS, 5, null, { trunkBranch: "master" });
  assert.notEqual(raw.class, "OWNED_BY_PR", "the bug: TSIO's path never matches the diff");

  const canonical = { file: tsioPath, title: "t", error: "e", repo_path: repoPath("e2e/specs", tsioPath) };
  const owned = classify(canonical, trunkPasses(8), changed, DEFAULTS, 5, null, { trunkBranch: "master" });
  assert.equal(owned.class, "OWNED_BY_PR", "the PR edited this spec, so it answers for it");
  assert.equal(owned.blocking, true);
});
test("an incomplete or empty run is not a passing run", async () => {
  const group = (over) => ({ id: "g1", repository: "o/r", commit: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1", status: "completed", ...over });
  const id = { repository: "o/r", commit_sha: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1" };
  const routes = (g, suites, cases, detail = g) => [
    ["/reports?", () => Response.json({ reports: [g] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
    ["/reports/g1", () => Response.json(detail)],
  ];
  const suite = [{ id: "s1", file_path: "specs/a.spec.ts", report_name: "e2e-on-windows-2022-1.0" }];
  const cases = [{ suite_id: "s1", title: "t1", status: "failed", retry_count: 0, ordinal: 0, error_message: "Error: x" }];
  const now = { attempts: 1, ms: 0 };

  // Two workers never uploaded: what arrived is read, and the gap is reported.
  const open = group({ status: "in_progress", total_reports_expected: 30 });
  const partial = await fetchRun(fakeFetch(routes(open, suite, cases, { ...open, reports: Array(28).fill({}) })), "http://tsio", id, null, now);
  assert.equal(partial.failing.length, 1);
  assert.deepEqual(partial.missing, { expected: 30, received: 28, status: "in_progress" });
  assert.deepEqual(missingReports(partial.missing), { text: "2 of 30 reports never uploaded, so the specs on those workers never ran", short: "2 report(s) missing" });
  assert.equal(missingReports({ expected: null, received: null, status: "processing" }).short, "results incomplete");

  // A late upload that completes the group while we wait is a complete run.
  const late = await fetchRun(fakeFetch(routes(open, suite, cases, { ...open, status: "completed" })), "http://tsio", id, null, now);
  assert.equal(late.missing, null);

  await assert.rejects(
    () => fetchRun(fakeFetch(routes(group(), suite, [])), "http://tsio", id, "e2e-on-windows"),
    /no test cases/, "a report with a matching suite but no cases is not a green run");
});
test("a run with missing reports is triaged but never comes out green", async () => {
  const routes = (statuses) => [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "in_progress", total_reports_expected: 3 }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g1/cases", () => Response.json(spec("t1", "failed"))],
    ["/reports/g1", () => Response.json({ id: "g1", status: "in_progress", total_reports_expected: 3, reports: [{}, {}] })],
    // Master fails it too, so on a complete run this would clear.
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", (i) => { statuses.push(JSON.parse(i.body)); return Response.json({}); }],
  ];
  const statuses = [];
  const dir = mkdtempSync(join(tmpdir(), "triage-missing-"));
  try {
    const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(routes(statuses)), log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.equal(result.findings[0].blocking, false, "the failure that did upload is still judged");
    assert.equal(result.verdict, "FAILURE", "the specs that never ran keep it red");
    assert.match(readFileSync(join(dir, "s.md"), "utf8"), /1 of 3 reports never uploaded, so the specs on those workers never ran; re-run the failed jobs/);
    const required = statuses.filter((s) => s.context === "e2e-test/playwright");
    assert.deepEqual(required.map((s) => [s.state, s.description]), [["failure", "0 passed, 1 failed (1 cleared by triage), 0 skipped; 1 report(s) missing"]]);
    assert.equal(statuses.filter((s) => s.context === "e2e-test/playwright/triage").at(-1).description, "1 failed → 1 cleared · 0 blocking · 1 report(s) missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("two describe blocks sharing a leaf title are different tests", async () => {
  // Keyed on file and leaf title, the passing block would erase the failing one.
  const suites = [
    { id: "s-a", file_path: "specs/a.spec.ts", title: "describe A", report_name: "r1" },
    { id: "s-b", file_path: "specs/a.spec.ts", title: "describe B", report_name: "r1" },
  ];
  const cases = [
    { suite_id: "s-a", title: "same leaf", status: "failed", retry_count: 0, ordinal: 0, error_message: "boom", error_stack: null },
    { suite_id: "s-b", title: "same leaf", status: "passed", retry_count: 0, ordinal: 1, error_message: null, error_stack: null },
  ];
  const run = await fetchRun(fakeFetch([
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ]), "http://tsio", { repository: "o/r", commit_sha: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1" });
  assert.equal(run.counts.failed, 1, "the failure in describe A survives");
  assert.deepEqual(run.failing.map((f) => f.file), ["specs/a.spec.ts"]);
});
test("a diff that could not be read in full is not ownership evidence", async () => {
  // GitHub paginates a commit's file list and caps the comparison. Reading one
  // page of a large commit makes an edited spec look untouched.
  const pages = [];
  const api = async (_m, path) => {
    pages.push(path);
    return { files: Array.from({ length: 100 }, (_, i) => ({ filename: `f${pages.length}-${i}.ts`, patch: "@@" })) };
  };
  const out = await fetchChangedFiles(api, { repository: "o/r", commit_sha: "abc" }, null, () => {});
  assert.equal(out.ok, false, "a capped commit diff cannot claim complete ownership coverage");
  assert.ok(pages.length > 1, "pagination is followed rather than reading page one");
  assert.ok(pages.every((p) => p.includes("page=")), "every request names its page");
});
test("history from another platform cannot answer for this one", async () => {
  const tests = [failing];
  const rows = (extra) => ({ observations: [obs({ commit_sha: "a", group_id: "g1", ...extra })] });

  // A server that identifies the report: the filter is sent, and rows that came
  // from a different report are dropped even if the server ignored it.
  const sent = [];
  const good = fakeFetch([["/reports/history", (init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ observations: [
      obs({ commit_sha: "mine", group_id: "g1", report_name: "e2e-on-windows-2022-1.0" }),
      obs({ commit_sha: "theirs", group_id: "g2", report_name: "e2e-on-ubuntu-latest-1.0" }),
    ] });
  }]]);
  const scoped = await fetchHistory(good, "http://tsio", "o/r", tests, "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows");
  assert.equal(sent[0].report, "e2e-on-windows", "the filter is sent to the server");
  assert.deepEqual(scoped.get(identityKey(failing)).map((o) => o.commit_sha), ["mine"], "the other platform's row is dropped");
  assert.equal(scoped.reportUnknown, false);

  // A server that predates report identity: rows cannot prove which platform
  // they came from, so nothing may be cleared on them.
  const old = fakeFetch([["/reports/history", () => Response.json(rows({}))]]);
  const blindly = await fetchHistory(old, "http://tsio", "o/r", tests, "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows");
  assert.equal(blindly.reportUnknown, true, "an unprovable lane is not a usable one");

  // Unscoped runs are unaffected.
  const plain = await fetchHistory(fakeFetch([["/reports/history", () => Response.json(rows({}))]]), "http://tsio", "o/r", tests, "2026-09-17T00:00:00Z", DEFAULTS, "master", null);
  assert.equal(plain.reportUnknown, false);
});
test("another lane's multi-report run does not make this lane's history ambiguous", async () => {
  const t = { ...failing, full_title: "A > t1", report_scope: "e2e-on-windows" };
  const row = (over) => obs({ full_title: "A > t1", suite_title: "A", report_name: "e2e-on-windows-2022-12.0", name: "desktop-master", ...over });
  const history = (rows) => fakeFetch([["/reports/history", () => Response.json({ observations: rows })]]);
  const trunk = [row({ group_id: "g1", commit_sha: "a" }), row({ group_id: "g2", commit_sha: "b" })];
  // A compatibility-matrix run puts one spec against several server versions in one group.
  const cmt = ["10.11", "11.10"].map((v) => row({ group_id: "cmt", name: "cmt-desktop", report_name: `e2e-on-windows-2022-${v}` }));

  const scoped = await fetchHistory(history([...trunk, ...cmt]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows", () => {}, laneOf("desktop-pr"));
  assert.equal(scoped.ambiguous.has(identityKey(t)), false, "the other lane's group is not this lane's evidence");
  assert.deepEqual(scoped.get(identityKey(t)).map((o) => o.group_id).sort(), ["g1", "g2"]);

  // The same shape inside this lane still needs a narrower producer scope.
  const sameLane = cmt.map((o) => ({ ...o, name: "desktop-master" }));
  const inLane = await fetchHistory(history([...trunk, ...sameLane]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows", () => {}, laneOf("desktop-pr"));
  assert.equal(inLane.ambiguous.has(identityKey(t)), true);
});
test("a lane with nothing failed keeps its own status", async () => {
  // mattermost-mobile#10172: green lanes were rewritten as "0 failed (0 cleared by
  // triage)", and a lane red outside its tests would have been turned green.
  const statuses = [];
  await triage({
    env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" },
    fetchImpl: fakeFetch([
      ...runRoutes([spec("t1", "passed"), spec("t2", "passed")]),
      ["/reports/history", () => Response.json({ observations: [] })],
      ["/pulls/5/files", () => Response.json([])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
      ["/statuses/abc", (i) => { statuses.push(JSON.parse(i.body)); return Response.json({}); }],
    ]),
    log: () => {},
  });
  assert.deepEqual(statuses, [], "nothing to triage, nothing written");
});

test("only an explicit, valid enforce mode writes a commit status", async () => {
  const routes = (statuses) => [
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/issues/5/comments", (i) => (i.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", (i) => { statuses.push(JSON.parse(i.body)); return Response.json({}); }],
  ];
  for (const mode of [undefined, "", "report-only", "Enforce ", "enforced", "true", "ENFORCE_ME"]) {
    const statuses = [];
    const e = { ...env, ANTHROPIC_API_KEY: "" };
    if (mode === undefined) delete e.MODE; else e.MODE = mode;
    await triage({ env: e, fetchImpl: fakeFetch(routes(statuses)), log: () => {} });
    assert.deepEqual(statuses, [], `mode ${JSON.stringify(mode)} must not write a status`);
  }
  // The one spelling that may.
  const written = [];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(routes(written)), log: () => {} });
  const required = written.filter((s) => s.context === "e2e-test/playwright");
  assert.equal(required.length, 1, "explicit enforce still writes exactly one required status");
  // Beside it, its own check: pending while triage works, then the verdict.
  assert.deepEqual(written.filter((s) => s.context === "e2e-test/playwright/triage").map((s) => [s.state, s.description]), [
    ["pending", "1 failed · triage is checking them"],
    ["success", "1 failed → 1 cleared · 0 blocking"],
  ]);
  assert.ok(written.findIndex((s) => s.state === "pending") < written.findIndex((s) => s.context === "e2e-test/playwright"), "the triage check goes pending first");

  // A triage that crashes says so on its check and leaves the E2E result alone.
  const crashed = [];
  const broken = routes(crashed).map(([path, h]) => (path === "/reports/history" ? [path, () => { throw new Error("history down"); }] : [path, h]));
  await assert.rejects(triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(broken), log: () => {} }));
  assert.deepEqual(crashed.map((s) => [s.context, s.state]), [["e2e-test/playwright/triage", "pending"], ["e2e-test/playwright/triage", "error"]]);

  // TRIAGE_CONTEXT=off posts only the required status.
  const quiet = [];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(routes(quiet)), log: () => {} });
  assert.deepEqual(quiet.map((s) => s.context), ["e2e-test/playwright"]);
});
test("a failure history can't explain is a likely regression only when the PR touches it", async () => {
  const routes = (files, error) => [
    ...runRoutes([spec("t1", "failed").map((row) => (error ? { ...row, error_message: error } : row))]),
    ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
    ["/pulls/5/files", () => Response.json(files)],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", () => Response.json({})],
  ];
  const run = async (files, error) => {
    const dir = mkdtempSync(join(tmpdir(), "triage-label-"));
    try {
      const result = await triage({ env: { ...env, ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(routes(files, error)), log: () => {} });
      return { result, summary: readFileSync(join(dir, "s.md"), "utf8") };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  // mattermost-mobile#10172: the PR changed CI and test-harness files, none the
  // test or its error names. It is still blocking, but not called a regression.
  const untouched = await run([{ filename: "app/x.ts", patch: "@@" }]);
  assert.equal(untouched.result.findings[0].class, "REGRESSION");
  assert.equal(untouched.result.findings[0].blocking, true);
  assert.match(untouched.summary, /🔴 Not explained by history \| Re-run the job; if it fails again, check what the test depends on/);
  assert.match(untouched.summary, /\| Does this PR change a file its error names\? \| No \|/);
  assert.doesNotMatch(untouched.summary, /likely regression/);

  // A plain word of the error's prose ("expected visible") does not name src/visible.ts.
  const prose = await run([{ filename: "src/visible.ts", patch: "@@" }]);
  assert.match(prose.summary, /🔴 Not explained by history/);

  // A changed file the error names (its test id server_form) keeps the old wording.
  const named = await run([{ filename: "app/screens/server_form.tsx", patch: "@@" }], "Error: expected server_form to be visible");
  assert.equal(named.result.findings[0].class, "REGRESSION");
  assert.match(named.summary, /🔴 Likely regression \| Check your change, or merge master/);
  assert.match(named.summary, /\| Does this PR change a file its error names\? \| Yes \|/);
});
test("one triage check for the whole PR summarises every lane", async () => {
  const st = (state, description) => ({ state, description });
  const lanes = (rows) => laneSummary(Object.entries(rows).map(([context, status]) => ({ context, status })));
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("failure", "590 passed, 7 failed, 41 skipped"), "e2e-test/maestro-ios": st("pending", "running") }),
    { state: "pending", description: "Triage is checking: waiting for detox-ios, maestro-ios" }, "a red lane without a verdict, or a running one, keeps it pending");
  assert.deepEqual(lanes({
    "e2e-test/detox-ios": st("failure", "590 passed, 7 failed (2 cleared by triage, 5 unresolved), 41 skipped"),
    "e2e-test/maestro-ios": st("success", "6 passed, 1 failed (1 cleared by triage), 1 skipped"),
    "e2e-test/detox-ipad": st("success", "19 passed, 0 skipped"),
    "e2e-test/maestro-android": null,
  }), { state: "failure", description: "detox-ios: 2 cleared, 5 to check · maestro-ios cleared by triage" });
  // mattermost#38601: every failure cleared, but two runners timed out without a report.
  assert.deepEqual(lanes({ "e2e-test/playwright-full/enterprise": st("failure", "1119 passed, 26 failed (26 cleared by triage), 118 skipped; 2 report(s) missing") }),
    { state: "failure", description: "playwright-full/enterprise: 26 cleared, 2 report(s) missing, re-run" });
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("failure", "49 passed, 132 failed (not triaged, investigation required), 29 skipped") }),
    { state: "failure", description: "detox-ios: too many failures to triage" });
  assert.deepEqual(lanes({ "e2e/linux": st("failure", "10 passed, 2 failed (not triaged: triage could not finish)") }),
    { state: "failure", description: "linux: triage could not finish" });
  assert.deepEqual(lanes({ "e2e-test/maestro-ios": st("success", "6 passed, 1 failed (1 cleared by triage), 1 skipped"), "e2e-test/detox-ios": st("success", "597 passed, 0 failed (0 cleared by triage)") }),
    { state: "success", description: "maestro-ios cleared by triage · all lanes green" });
  assert.deepEqual(lanes({ "e2e/linux": st("success", "235 passed, 0 failed") }), { state: "success", description: "All lanes green" });

  // Through triage(): this lane's verdict is written, then the PR-wide check from every lane.
  const written = [];
  const lane = "e2e-test/playwright";
  const statuses = () => [...written].reverse();
  const routes = [
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/commits/abc/statuses", () => Response.json([...statuses(), { context: "e2e-test/other", state: "success", description: "10 passed" }])],
    ["/statuses/abc", (i) => { written.push(JSON.parse(i.body)); return Response.json({}); }],
  ];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", STATUS_CONTEXT: lane, TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: `${lane}, e2e-test/other`, TRIAGE_SETTLE_MS: "0" }, fetchImpl: fakeFetch(routes), log: () => {} });
  assert.deepEqual(written.map((s) => [s.context, s.state, s.description]), [
    ["e2e-test/triage", "pending", "Triage is checking playwright"],
    [lane, "success", "0 passed, 1 failed (1 cleared by triage), 0 skipped"],
    ["e2e-test/triage", "success", "playwright cleared by triage · all lanes green"],
    ["e2e-test/triage", "success", "playwright cleared by triage · all lanes green"],
  ]);
});
test("skipped history rows are not trunk runs", () => {
  const skipped = (n) => Array.from({ length: n }, (_, i) => obs({ commit_sha: `s${i}`, status: "skipped", created_at: "2026-09-11T00:00:00Z" }));
  // Two real trunk runs padded by skips do not meet the five-run minimum.
  const padded = classify(failing, [obs({ commit_sha: "p" }), obs({ status: "failed", commit_sha: "f" }), ...skipped(3)], [], DEFAULTS, 5);
  assert.equal(padded.class, "INSUFFICIENT_DATA");
  assert.equal(padded.trunk.runs, 2);
  // On a trunk run, a skipped latest row does not hide the failure before it.
  const streak = classify(failing, [...skipped(1), ...trunkFailsAll(1), ...trunkPasses(6)], [], DEFAULTS, null, null, { isTrunkRun: true });
  assert.equal(streak.class, "BROKEN_ON_TRUNK");
  assert.equal(streak.blocking, true);
});
test("a spec retested on another worker is one test, not two", async () => {
  // mattermost#38601: failed twice on one worker, passed on a retest on another: flaky, one test.
  const suites = [
    { id: "w14", file_path: "specs/a.spec.ts", title: "a", report_name: "dispatch-run-14" },
    { id: "w3", file_path: "specs/a.spec.ts", title: "a", report_name: "dispatch-run-3" },
  ];
  const row = (suite, title, status, retry) => ({ ...caseRow(title, status, retry, suite), full_title: `a.spec.ts > a > ${title}` });
  const cases = [
    row("w14", "retested", "failed", 0), row("w14", "retested", "failed", 1), row("w3", "retested", "passed", 0),
    row("w14", "broken", "failed", 0), row("w3", "broken", "failed", 0),
  ];
  const routes = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const run = await fetchRun(fakeFetch(routes), "http://tsio", JSON.parse(env.COMPOSITE_IDENTITY));
  assert.deepEqual(run.counts, { total: 2, passed: 1, failed: 1, flaky: 1, skipped: 0 });
  assert.deepEqual(run.failing.map((f) => [f.title, f.identity_unresolved]), [["broken", false]]);

  // A report scope declares reports to be separate lanes, so they stay apart --
  // and one scope covering both is ambiguous rather than merged.
  const scoped = await fetchRun(fakeFetch(routes), "http://tsio", JSON.parse(env.COMPOSITE_IDENTITY), "dispatch-run-");
  assert.equal(scoped.counts.total, 4);
  assert.ok(scoped.failing.every((f) => f.identity_unresolved));
});
test("history counts runs, not attempts", async () => {
  const t = { ...failing, full_title: "A > t1" };
  const row = (over) => obs({ full_title: "A > t1", suite_title: "A", name: "playwright-full", ...over });
  const rows = [
    // One trunk run that failed and passed on retry, another retested on a second worker.
    row({ group_id: "g1", report_name: "w1", status: "failed", retry_count: 0 }),
    row({ group_id: "g1", report_name: "w1", status: "passed", retry_count: 1 }),
    row({ group_id: "g2", report_name: "w1", status: "failed", retry_count: 0 }),
    row({ group_id: "g2", report_name: "w2", status: "failed", retry_count: 0 }),
    row({ group_id: "g3", report_name: "w1", status: "passed", retry_count: 0 }),
  ];
  const history = await fetchHistory(fakeFetch([["/reports/history", () => Response.json({ observations: rows })]]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  assert.equal(history.ambiguous.has(identityKey(t)), false, "a retest is not a second test");
  assert.deepEqual(history.get(identityKey(t)).map((o) => [o.group_id, o.status]).sort(), [["g1", "flaky"], ["g2", "failed"], ["g3", "passed"]]);
});
// mattermost-mobile#10172: a shared setup broke; tests too new for history fail with the same error.
const setupError = (line) => `TypeError: Cannot read properties of undefined (reading 'id') at Object.<anonymous> (/home/runner/work/m/channel_attributes.e2e.ts:${line}:80) at processTicksAndRejections (node:internal/process/task_queues:104:5)`;
const finding = (over) => ({
  file: "detox/channel_attributes.e2e.ts", title: "t", class: "FLAKY_CROSS_PR", blocking: false, reason: "Failed on 4 other PRs.", error: setupError(219),
  trunk: { runs: 7, fails: 0, flaky: 0, passes: 7, latest: "passed" }, cross_pr: { prs: [1, 2, 3, 4], examples: [], passes: 0 },
  failure_signatures: [errorSignature(setupError(1))],
  ...over,
});

// mattermost-mobile#10017: other PRs failed leave_call with a different error (login setup).
const leaveCall = (over) => ({ ...failing, file: "flows/calls/leave_call.yml", title: "leave_call", error: "Assertion is false: id: tab_bar.home.tab is visible", ...over });
const otherPR = (n, error) => obs({ file: "flows/calls/leave_call.yml", title: "leave_call", gh_pr_number: n, branch: `pr-${n}`, status: "failed", error_excerpt: error });
test("another PR's failure counts only when it failed with the same error", () => {
  const green = trunkPasses(20).map((o) => ({ ...o, file: "flows/calls/leave_call.yml", title: "leave_call" }));
  const setup = ["Assertion is false: id: server_form.display_help is not visible", "Element not found: Text matching regex: Display Name", "Assertion is false: id: server_form.server_url.input is visible"];
  const unrelated = classify(leaveCall(), [...green, ...setup.map((e, i) => otherPR(20 + i, e))], [], undefined, 9);
  assert.equal(unrelated.class, "REGRESSION", "three different failures are not this failure");
  assert.deepEqual(unrelated.cross_pr.prs, []);
  assert.deepEqual(unrelated.cross_pr.examples, [], "the judge is not shown them as recurrences either");

  const same = classify(leaveCall(), [...green, ...[20, 21, 22].map((n) => otherPR(n, "Assertion is false: id: tab_bar.home.tab is visible"))], [], undefined, 9);
  assert.equal(same.class, "FLAKY_CROSS_PR");
  assert.match(same.reason, /^Failed with the same error on 3 other PRs/);

  // A timeout says nothing about cause, so any failure still counts.
  const timeout = 'thrown: "Exceeded timeout of 300000 ms for a test.';
  const anyFailure = classify(leaveCall({ error: timeout }), [...green, ...setup.map((e, i) => otherPR(20 + i, e))], [], undefined, 9);
  assert.equal(anyFailure.class, "FLAKY_CROSS_PR");
  assert.match(anyFailure.reason, /^Failed on 3 other PRs/);
});
test("an error signature ignores where the error was thrown", () => {
  assert.equal(errorSignature(setupError(219)), errorSignature(setupError(380)));
  assert.equal(errorSignature(`TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (C:\\a\\x.ts:3:1)`), errorSignature(setupError(1)));
  assert.equal(errorSignature("Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('chip')\nExpected: visible\n\nCall log:\n  - waiting"),
    "Error: expect(locator).toBeVisible() failed Locator: getByTestId('chip') Expected: visible", "the locator is what tells two assertions apart");
  // MM-T3462 on mattermost-mobile: each run creates its own channel, so the name differs every time.
  assert.equal(errorSignature("Error: Sidebar channel item not found for channel: channel-e11bc4; searched categories: [channels, unreads, favorites]"),
    errorSignature("Error: Sidebar channel item not found for channel: channel-9f02aa; searched categories: [channels, unreads, favorites]"));
  assert.notEqual(errorSignature("Assertion is false: id: tab_bar.home.tab is visible"), errorSignature("Assertion is false: id: server_form.display_help is not visible"),
    "test ids are not generated names");
  for (const generic of ['thrown: "Exceeded timeout of 300000 ms for a test.', "Error: Test timeout of 60000ms exceeded.", "Error: expected visible", "", null])
    assert.equal(errorSignature(generic), null, `${JSON.stringify(generic)} names no cause`);
});
test("a blocked failure with the same spec and error as a cleared one is cleared with it", () => {
  const [anchor, blocked] = sameFailure([finding({ title: "MM-T6301_1" }), finding({ title: "MM-T6305_1", class: "INSUFFICIENT_DATA", blocking: true, reason: "Only 2 trunk runs.", error: setupError(380) })]);
  assert.equal(anchor.class, "FLAKY_CROSS_PR");
  assert.equal(blocked.class, "SAME_FAILURE_AS_CLEARED");
  assert.equal(blocked.blocking, false);
  assert.equal(blocked.same_as, "MM-T6301_1");
  assert.match(blocked.reason, /MM-T6301_1.*FLAKY_CROSS_PR/);

  // The judge declined it first; its section must not read as agreement.
  const judged = { ...blocked, judge: { cause: "flaky_environment", confidence: 0.5, cited_evidence: [], explanation: "unsure" } };
  const comment = renderSummary({ context: "c", verdict: "SUCCESS", findings: [anchor, judged], infra: null, model: "m", runURL: "u", counts: { failed: 2 } });
  assert.match(comment, /✅ Not caused by this PR: same failure as a cleared test/);
  assert.match(comment, /\| Same failure as \| MM-T6301_1 \|/);
  assert.doesNotMatch(comment, /agreed/);
});
test("the same-failure rule needs the same spec, a specific error and an anchor history cleared", () => {
  const blocked = (over) => finding({ title: "new", class: "REGRESSION", blocking: true, error: setupError(500), ...over });
  const stays = (findings, why) => assert.equal(sameFailure(findings).at(-1).blocking, true, why);
  stays([finding({ file: "detox/other.e2e.ts" }), blocked()], "another spec is another cause");
  stays([finding({ error: "TypeError: Cannot read properties of undefined (reading 'name')" }), blocked()], "another error is another cause");
  const timeout = 'thrown: "Exceeded timeout of 300000 ms for a test.';
  stays([finding({ error: timeout }), blocked({ error: timeout })], "two timeouts are not one failure");
  stays([finding({ class: "SAME_FAILURE_AS_CLEARED" }), blocked()], "only history anchors; a cleared follower does not");
  stays([finding({ class: "REGRESSION", blocking: false, decision: "adjudicator_unblock" }), blocked()], "a judge's clear is not history");
  stays([finding({ judge: { cause: "caused_by_pr", confidence: 0.6 } }), blocked()], "an anchor the judge tied to the PR anchors nothing");
  // desktop#4020, an Electron upgrade: MM-T804 cleared on two flaky passes in 39
  // trunk runs and never failed there, so nothing shows its error is anyone else's.
  stays([finding({ class: "FLAKY_ON_TRUNK", failure_signatures: [] }), blocked()], "an anchor whose history never failed this way proves nothing about this error");
  stays([finding({ failure_signatures: ["TypeError: Cannot read properties of undefined (reading 'name')"] }), blocked()], "history that failed differently is not this error's");
  stays([finding(), blocked({ judge: { cause: "caused_by_pr", confidence: 0.6 } })], "a failure the judge tied to the PR does not follow");
  stays([finding(), blocked({ identity_unresolved: true })], "history that cannot name the test clears nothing");
  stays([finding(), blocked({ decision: "evidence_incomplete" })], "incomplete evidence clears nothing");
  stays([finding(), blocked({ class: "OWNED_BY_PR" })], "a spec the PR edits stays the PR's");
});
test("the same-failure rule runs on PR runs only", async () => {
  // Two tests, one spec, one setup error. t1 failed on three other PRs; t2 is new.
  const routes = (pr) => {
    const identity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full", branch: pr ? "pr-5" : "master", ...(pr ? { gh_pr_number: 5 } : {}) };
    const row = (title, line) => ({ ...caseRow(title, "failed"), error_message: setupError(line) });
    const crossPR = [5, 6, 7, 8].filter((n) => n !== 5 || !pr).slice(0, 3).map((n) => obs({ title: "t1", gh_pr_number: n + 10, status: "failed", branch: `pr-${n}`, error_excerpt: setupError(40 + n) }));
    return {
      identity,
      fetch: fakeFetch([
        ...runRoutes([[row("t1", 219)], [row("t2", 380)]]),
        ["/reports/history", () => Response.json({ observations: [...trunkPasses(8).map((o) => ({ ...o, title: "t1" })), ...crossPR, ...trunkPasses(2).map((o) => ({ ...o, title: "t2" }))] })],
        ["/pulls/5/files", () => Response.json([{ filename: ".github/workflows/e2e.yml", patch: "@@" }])],
        ["/pulls/5", () => Response.json({ title: "ci only", base: { ref: "master" } })],
      ]),
    };
  };
  const pr = routes(true);
  const onPR = await triage({ env: { ...env, MODE: "report-only", ANTHROPIC_API_KEY: "", COMPOSITE_IDENTITY: JSON.stringify(pr.identity) }, fetchImpl: pr.fetch, log: () => {} });
  assert.deepEqual(onPR.findings.map((f) => [f.title, f.class, f.blocking]), [["t1", "FLAKY_CROSS_PR", false], ["t2", "SAME_FAILURE_AS_CLEARED", false]]);
  assert.equal(onPR.verdict, "SUCCESS");

  // On trunk t1 is cleared as intermittent, but trunk asks whether trunk is
  // broken, and a new test failing with it is not evidence that it is not.
  const trunkIdentity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full", branch: "master" };
  const row = (title, line) => ({ ...caseRow(title, "failed"), error_message: setupError(line) });
  const t1 = [...trunkPasses(7), obs({ commit_sha: "old", status: "failed", created_at: "2026-09-01T00:00:00Z", error_excerpt: setupError(7) })].map((o) => ({ ...o, title: "t1" }));
  const onTrunk = await triage({
    env: { ...env, MODE: "report-only", ANTHROPIC_API_KEY: "", COMPOSITE_IDENTITY: JSON.stringify(trunkIdentity) },
    fetchImpl: fakeFetch([
      ...runRoutes([[row("t1", 219)], [row("t2", 380)]]),
      ["/reports/history", () => Response.json({ observations: [...t1, ...trunkPasses(2).map((o) => ({ ...o, title: "t2" }))] })],
      ["/commits/abc", () => Response.json({ files: [{ filename: "app/x.ts", patch: "@@" }] })],
    ]),
    log: () => {},
  });
  assert.deepEqual(onTrunk.findings.map((f) => [f.title, f.class, f.blocking]), [["t1", "FLAKY_ON_TRUNK", false], ["t2", "INSUFFICIENT_DATA", true]]);
});
// mattermost-mobile#10172: a Jest timeout whose error says nothing; the screenshot shows the stuck request.
const PNG = (fill = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);
const timeoutTest = { file: "detox/e2e/test/products/channels/smoke_test/messaging.e2e.ts", title: "MM-T4786_4 - pin a message", full_title: "Smoke Test - Messaging MM-T4786_4 - pin a message" };
const busyNotes = 'Detox reported the app busy 9 times; still waiting on: Network Request "https://site-1/api/v4/posts/6qgx/pin"';
function evidenceDir(entries, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  mkdirSync(join(dir, "shard-1"), { recursive: true });
  writeFileSync(join(dir, "shard-1", "evidence.json"), JSON.stringify(entries));
  return dir;
}
test("producer evidence is read only from images inside its directory, within limits", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.png"), PNG());
  const dir = evidenceDir(
    [
      { ...timeoutTest, notes: busyNotes, images: ["shot/timeout.png", "shot/second.png", "shot/third.png"] },
      { ...timeoutTest, title: "escape", images: ["../../" + outside.split("/").pop() + "/secret.png", "shot/link.png"] },
      { ...timeoutTest, title: "not an image", images: ["shot/fake.png", "shot/huge.png"] },
      { title: "no file" },
    ],
    { "shard-1/shot/timeout.png": PNG(1), "shard-1/shot/second.png": PNG(2), "shard-1/shot/third.png": PNG(3), "shard-1/shot/fake.png": Buffer.from("#!/bin/sh\necho hi"), "shard-1/shot/huge.png": Buffer.concat([PNG(), Buffer.alloc(3_600_000)]) },
  );
  symlinkSync(join(outside, "secret.png"), join(dir, "shard-1", "shot", "link.png"));
  const warnings = [];
  try {
    const evidence = loadEvidence(dir, (w) => warnings.push(w));
    assert.deepEqual(evidence.map((e) => [e.title, e.images.length]), [[timeoutTest.title, 2]], "two images per test; the others carried nothing usable");
    assert.equal(evidence[0].notes, busyNotes);
    assert.equal(evidence[0].images[0].media_type, "image/png");
    assert.match(evidence[0].images[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(warnings.filter((w) => /outside the evidence directory/.test(w)).length === 2, "a relative escape and a symlink out are both refused");
    assert.ok(warnings.some((w) => /not a PNG or JPEG/.test(w)));
    assert.deepEqual(loadEvidence(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("producer evidence matches its test by title, qualified title and spec path", () => {
  const e = { file: "e2e/test/products/channels/smoke_test/messaging.e2e.ts", title: timeoutTest.title, full_title: timeoutTest.full_title, notes: "n", images: [] };
  assert.equal(evidenceFor(timeoutTest, [e]), e, "a path relative to a different root still matches on its tail");
  assert.equal(evidenceFor({ ...timeoutTest, full_title: "Another describe " + timeoutTest.title }, [e]), null);
  assert.equal(evidenceFor({ ...timeoutTest, file: "detox/e2e/test/other.e2e.ts" }, [e]), null);
  assert.equal(evidenceFor({ ...timeoutTest, file: "x" + timeoutTest.file }, [{ ...e, file: "messaging.e2e.ts" }]), null, "a bare file name is not a path tail");
});
test("end to end: a timeout the judge clears from the screenshot the run recorded", async () => {
  const dir = evidenceDir([{ ...timeoutTest, notes: busyNotes, images: ["timeout.png"] }], { "shard-1/timeout.png": PNG(7) });
  const identity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "mobile-pr-detox-ios", branch: "pr-5", gh_pr_number: 5 };
  const sent = [];
  const answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["producer"], explanation: "Stuck on a pin request to the test server; the diff only touches CI." };
  const routes = () => fakeFetch([
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: identity.name, gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: timeoutTest.file }] })],
    ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: timeoutTest.title, full_title: timeoutTest.full_title, status: "failed", retry_count: 0, ordinal: 0, error_message: 'thrown: "Exceeded timeout of 300000 ms for a test.', error_stack: null }])],
    ["/reports/history", () => Response.json({ observations: trunkPasses(25).map((o) => ({ ...o, file: timeoutTest.file, title: timeoutTest.title, full_title: timeoutTest.full_title, name: "mobile-main-detox-ios" })) })],
    ["/pulls/5/files", () => Response.json([{ filename: ".github/workflows/e2e.yml", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "ci only", base: { ref: "main" } })],
    ["api.anthropic.com", (init) => {
      sent.push(JSON.parse(init.body));
      return modelReply(init, answer);
    }],
  ]);
  const base = { ...env, MODE: "report-only", COMPOSITE_IDENTITY: JSON.stringify(identity) };
  try {
    const result = await triage({ env: { ...base, EVIDENCE_DIR: dir }, fetchImpl: routes(), log: () => {} });
    const [label, image, text] = sent[0].messages[0].content;
    assert.equal(label.text, "Screenshots recorded for f1:");
    assert.deepEqual([image.type, image.source.media_type, image.source.data], ["image", "image/png", PNG(7).toString("base64")], "the screenshot goes before the evidence, as an image");
    assert.match(text.text, /"valid_evidence_ids":\[[^\]]*"producer"/);
    assert.match(text.text, /posts\/6qgx\/pin/);
    assert.equal(result.findings[0].decision, "adjudicator_unblock");
    assert.equal(result.verdict, "SUCCESS");

    // Without evidence there is nothing the model could cite to clear it. It is
    // still asked, for advice the summary shows; the outcome stays the rules'.
    sent.length = 0;
    const without = await triage({ env: base, fetchImpl: routes(), log: () => {} });
    assert.equal(sent.length, 1);
    assert.equal(without.findings[0].blocking, true);
    assert.equal(without.findings[0].decision, "advice");
    assert.equal(without.findings[0].judge.cause, "flaky_environment");
    assert.equal(without.verdict, "FAILURE");
    const summary = renderSummary({ context: "c", verdict: without.verdict, findings: without.findings, infra: null, model: "m", runURL: "u", counts: { failed: 1, passed: 0, skipped: 0 }, ai: without.ai });
    assert.match(summary, /🟡 Likely flaky or environment, but not sure enough to clear \| Re-run the job \| rules \+ AI \|/);
    assert.match(summary, /90% sure, but with nothing it could point to, so it can't clear/, "advice is never read as a clear");

    // With advice off, it is not asked at all.
    sent.length = 0;
    const off = await triage({ env: { ...base, AI_ADVICE: "false" }, fetchImpl: routes(), log: () => {} });
    assert.equal(sent.length, 0);
    assert.equal(off.ai.skipped.no_effect, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------- AI spend

const prCtx = { number: 1, repository: "o/r", title: "", lane: "l" };
const ok = (answer) => async (packs) => ({ answers: packs.map(() => answer), usage: { input_tokens: 3000, output_tokens: 200 }, served_model: DEFAULTS.model });
const flakyAnswer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "recurs elsewhere" };

test("the model is asked only when its answer could change the outcome", async () => {
  // mattermost#38601: three tests master also fails, on a PR that changes only CI
  // files. A cleared finding can only be vetoed by citing a related hunk; there is none.
  const cleared = classify(failing, [obs({ status: "failed" }), ...trunkPasses(8)], [], undefined, 1);
  assert.equal(cleared.class, "BROKEN_ON_TRUNK");
  const ci = [{ filename: ".github/workflows/e2e.yml", patch: "@@ ci" }];
  assert.equal(canChange(cleared.class, buildPack(cleared, ci, prCtx, [])), false);
  assert.equal(canChange(cleared.class, buildPack(cleared, [{ filename: "specs/a.spec.ts", patch: "@@ spec" }], prCtx, [])), true, "a related hunk could support a veto");

  // A blocked finding needs something to cite before an answer could clear it.
  const regression = classify(failing, trunkPasses(8), [], undefined, 1);
  assert.equal(canChange(regression.class, buildPack(regression, ci, prCtx, [])), false);
  assert.equal(canChange(regression.class, buildPack(classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1), ci, prCtx, [])), true);

  // With advice off, neither is asked.
  let calls = 0;
  const ledger = newLedger();
  const findings = [cleared, regression];
  await judge(findings, findings.map((f) => buildPack(f, ci, prCtx, [])), async () => { calls++; }, { ...DEFAULTS, advise: false }, () => {}, false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.no_effect, 2);
  assert.deepEqual(findings.map((f) => f.blocking), [false, true], "the rules' outcome stands");

  // With advice on, only the blocked one is asked, and even a confident "flaky" leaves it blocking.
  const again = [classify(failing, [obs({ status: "failed" }), ...trunkPasses(8)], [], undefined, 1), classify(failing, trunkPasses(8), [], undefined, 1)];
  const asked = [];
  const advised = newLedger();
  await judge(again, again.map((f) => buildPack(f, ci, prCtx, [])), async (packs, model) => { asked.push(packs.map((p) => p.engine.class)); return ok({ ...flakyAnswer, confidence: 0.99, cited_evidence: [] })(packs, model); }, DEFAULTS, () => {}, false, advised);
  assert.deepEqual(asked, [["REGRESSION"]]);
  assert.equal(advised.skipped.no_effect, 1);
  assert.deepEqual(again.map((f) => [f.blocking, f.decision ?? null]), [[false, null], [true, "advice"]]);
  assert.equal(advised.calls.length, 1, "advice is paid for and shown like any other call");
});

test("tests failing with one spec and error share one question", async () => {
  const error = "TypeError: Cannot read properties of undefined (reading 'id') at Object.<anonymous> (/x/a.e2e.ts:12:3)";
  // Another PR failed these tests with the same error, so there is something to cite.
  const findings = ["t1", "t2", "t3"].map((title) => classify({ ...failing, title, error }, [...trunkPasses(8), ...crossPR(31).map((o) => ({ ...o, title, error_excerpt: error }))], [], undefined, 1));
  const ledger = newLedger();
  const sent = [];
  await judge(findings, findings.map((f) => buildPack(f, [], prCtx, [])), async (packs, model) => { sent.push(packs.length); return ok(flakyAnswer)(packs, model); }, { ...DEFAULTS, escalationModel: "" }, () => {}, false, ledger);
  assert.deepEqual(sent, [1]);
  assert.equal(ledger.skipped.duplicate, 2);
  assert.equal(findings.every((f) => f.decision === "adjudicator_unblock"), true, "each is decided against its own evidence");
  assert.ok(Math.abs(findings.reduce((n, f) => n + f.ai.cost_usd, 0) - ledger.calls[0].cost_usd) < 1e-12, "the call's cost is split across the tests it answered");
});

test("an answer already given for the same evidence is reused, not paid for again", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const pack = buildPack(f, [], prCtx, []);
  const cfg = { ...DEFAULTS, escalationModel: "", answers: { [answerKey(DEFAULTS.model, pack)]: flakyAnswer } };
  let calls = 0;
  const ledger = newLedger();
  await judge([f], [pack], async () => { calls++; }, cfg, () => {}, false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.cached, 1);
  assert.equal(f.decision, "adjudicator_unblock");
});

test("a call that could cross the run budget is not made", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  let calls = 0;
  const ledger = newLedger();
  const warnings = [];
  await judge([f], [buildPack(f, [], prCtx, [])], async () => { calls++; }, { ...DEFAULTS, budgetUsd: 0.0001 }, (w) => warnings.push(w), false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.budget, 1);
  assert.equal(f.blocking, true, "over budget, the failure stays red");
  assert.match(warnings[0], /run budget/);
});

test("an answer just short of the threshold goes once to the escalation model", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const ledger = newLedger();
  const asked = [];
  await judge([f], [buildPack(f, [], prCtx, [])], async (packs, model) => {
    asked.push(model);
    const confidence = model === DEFAULTS.model ? 0.75 : 0.92;
    return { answers: packs.map(() => ({ ...flakyAnswer, confidence })), usage: { input_tokens: 3000, output_tokens: 200 }, served_model: model };
  }, DEFAULTS, () => {}, false, ledger);
  assert.deepEqual(asked, [DEFAULTS.model, DEFAULTS.escalationModel]);
  assert.equal(f.decision, "adjudicator_unblock");
  assert.equal(f.escalated, true);
  assert.equal(ledger.calls[1].cost_usd, (3000 * 10 + 200 * 50) / 1e6, "priced at Fable 5.1 list price");

  // A confident answer, a refusal, and an answer below the band are not escalated.
  for (const confidence of [0.95, 0.4]) {
    const g = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    const models = [];
    await judge([g], [buildPack(g, [], prCtx, [])], async (packs, model) => { models.push(model); return ok({ ...flakyAnswer, confidence })(packs, model); }, DEFAULTS, () => {});
    assert.deepEqual(models, [DEFAULTS.model], `confidence ${confidence}`);
  }
});

test("an answer that blames the PR without citing a change goes to the escalation model", async () => {
  // mattermost-mobile#10172 replay: Haiku blamed "test setup and environment files" for a
  // Maestro flow the diff does not touch, cited no hunk, and so skipped escalation.
  const ungrounded = { cause: "caused_by_pr", confidence: 0.72, cited_evidence: ["error", "engine"], explanation: "x" };
  const run = async (second) => {
    const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    const asked = [];
    await judge([f], [buildPack(f, [], prCtx, [])], async (packs, model) => {
      asked.push(model);
      return ok(model === DEFAULTS.model ? ungrounded : second)(packs, model);
    }, DEFAULTS, () => {});
    return { f, asked };
  };
  const cleared = await run({ ...flakyAnswer, confidence: 0.92 });
  assert.deepEqual(cleared.asked, [DEFAULTS.model, DEFAULTS.escalationModel]);
  assert.equal(cleared.f.decision, "adjudicator_unblock");
  assert.equal(cleared.f.blocking, false);
  // The stronger model blaming the PR as well keeps it red.
  const kept = await run(ungrounded);
  assert.equal(kept.f.blocking, true);
  assert.equal(kept.f.escalated, true);
  // Blame that names a related change is grounded and is not second-guessed.
  const h = classify({ ...failing, error: "Error: expected server_form to be visible" }, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const pack = buildPack(h, [{ filename: "app/server_form.tsx", patch: "@@ -1 +1 @@" }], prCtx, []);
  const hunkId = pack.diff_hunks_of_files_named_in_error.find((x) => x.related)?.id;
  assert.ok(hunkId, "the changed component the error names is a related hunk");
  const models = [];
  await judge([h], [pack], async (packs, model) => { models.push(model); return ok({ ...ungrounded, cited_evidence: ["error", hunkId] })(packs, model); }, DEFAULTS, () => {});
  assert.deepEqual(models, [DEFAULTS.model]);
  assert.equal(h.blocking, true);
});

test("prices are looked up by model family and can be overridden", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), priceFor("claude-haiku-4-5"));
  assert.equal(priceFor("claude-haiku-4"), null, "a prefix of a different name is not that model");
  assert.equal(costOf({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, "claude-opus-5-5"), 4 + 20 + 0.2 + 5);
  assert.equal(costOf({ input_tokens: 10 }, "some-future-model"), null, "an unpriced model has an unknown cost, not zero");
  const cfg = configFrom({ AI_PRICES: JSON.stringify({ "some-future-model": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 } }), ESCALATION_MODEL: "", AI_BUDGET_USD: "0.2" });
  assert.equal(costOf({ input_tokens: 1e6 }, "some-future-model", cfg.prices), 3);
  assert.equal(cfg.escalationModel, "", "an empty value turns escalation off");
  assert.equal(cfg.budgetUsd, 0.2);
  assert.throws(() => configFrom({ AI_PRICES: "{" }), /AI_PRICES/);
});

test("the evidence sent is the part that explains the failure", () => {
  const error = ["Error: expect(locator).toBeVisible() failed", "Locator: getByTestId('chip')", "    at /repo/node_modules/playwright/lib/x.js:1:1",
    "    at Object.<anonymous> (/repo/specs/a.spec.ts:40:9)", "    at node:internal/process/task_queues:105:5", "    at helper (/repo/support/ui.ts:7:3)",
    "    at more (/repo/support/a.ts:1:1)", "    at evenMore (/repo/support/b.ts:1:1)"].join("\n");
  assert.equal(compactError(error), "Error: expect(locator).toBeVisible() failed\nLocator: getByTestId('chip')\nat Object.<anonymous> (/repo/specs/a.spec.ts:40:9)\nat helper (/repo/support/ui.ts:7:3)\nat more (/repo/support/a.ts:1:1)");
  assert.equal(compactError("x".repeat(2000)).length, 800);

  const f = classify({ ...failing, error }, trunkPasses(8), [], undefined, 1);
  const files = [{ filename: "app/login.ts", patch: "@@ unrelated" }, { filename: "specs/a.spec.ts", patch: "@@ spec" }];
  const others = [
    { class: "REGRESSION", title: "t1", file: "specs/a.spec.ts", signature: null },
    { class: "REGRESSION", title: "sibling", file: "specs/a.spec.ts", signature: null },
    { class: "REGRESSION", title: "elsewhere", file: "specs/b.spec.ts", signature: "different" },
  ];
  const pack = buildPack(f, files, prCtx, others);
  assert.deepEqual(pack.diff_hunks_of_files_named_in_error.map((h) => h.id), ["hunk_1"], "only the related hunk, under its place in the diff");
  assert.deepEqual(pack.other_failures_in_same_run.map((o) => o.title), ["sibling"], "only failures that share the spec or the error");
});

test("one request carries a run's findings with the shared context once", async () => {
  const packs = ["t1", "t2"].map((title) => buildPack(classify({ ...failing, title }, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1), [{ filename: "specs/a.spec.ts", patch: "@@ spec" }], prCtx, []));
  let body;
  const res = await askModelBatch(async (_u, init) => { body = JSON.parse(init.body); return modelReply(init, flakyAnswer, { input_tokens: 1234, output_tokens: 56 }); }, "k", DEFAULTS.model, packs);
  assert.equal(typeof body.system, "string", "no cache marker: the prompt is below Haiku 4.5's minimum cacheable length");
  assert.equal(body.max_tokens, 600 + 16000, "room to think before the answer; thinking counts against max_tokens");
  let haikuBody;
  await askModelBatch(async (_u, init) => { haikuBody = JSON.parse(init.body); return modelReply(init, flakyAnswer, { input_tokens: 1, output_tokens: 1 }); }, "k", "claude-haiku-4-5-20251001", packs);
  assert.equal(haikuBody.max_tokens, 600, "a model that does not think gets only the answer's room");
  assert.equal(body.messages[0].content.match(/@@ spec/g).length, 1, "a hunk shared by both findings is sent once");
  assert.deepEqual(res.answers.map((a) => a.cause), ["flaky_environment", "flaky_environment"]);
  assert.deepEqual(res.usage, { input_tokens: 1234, output_tokens: 56 });
  assert.match(res.answers[1].provenance.pack_hash, /^[0-9a-f]{64}$/);

  // An answer missing for one finding fails that finding only.
  const partial = await askModelBatch(async (_u, init) => Response.json({ model: DEFAULTS.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "f2", ...flakyAnswer }] }) }] }), "k", DEFAULTS.model, packs);
  assert.ok(partial.answers[0] instanceof Error);
  assert.equal(partial.answers[0].missing, true, "marked so the judge can ask again");
  assert.match(String(partial.answers[0]), /no answer for f1 \(the response answered: f2\)/);
  assert.equal(partial.answers[1].cause, "flaky_environment");

  // The request names every id it expects and the schema accepts no other.
  assert.match(body.messages[0].content, /Return exactly 2 answer\(s\), one for each of: f1, f2\./);
  assert.deepEqual(body.output_config.format.schema.properties.answers.items.properties.id, { type: "string", enum: ["f1", "f2"] });
});

test("judge asks again, once, about a finding the response left out", async () => {
  const make = () => ["t1", "t2", "t3"].map((title) => classify({ ...failing, title }, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1));
  const packsOf = (findings) => findings.map((f) => buildPack(f, [], { number: 1, repository: "o/r", title: "", lane: "l" }, []));
  const answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const leaveOut = (skip) => async (packs) => ({
    answers: packs.map((_, i) => (skip.includes(i) ? Object.assign(new Error(`no answer for f${i + 1}`), { missing: true }) : answer)),
    usage: { input_tokens: 1000, output_tokens: 100 },
  });

  const findings = make();
  const sent = [];
  const warnings = [];
  const ledger = newLedger();
  let call = 0;
  await judge(findings, packsOf(findings), async (packs, model) => {
    sent.push(packs.map((p) => p.test.title));
    return (call++ === 0 ? leaveOut([0, 2]) : leaveOut([]))(packs, model);
  }, { ...DEFAULTS, escalationModel: "" }, (w) => warnings.push(w), false, ledger);
  assert.deepEqual(sent, [["t1", "t2", "t3"], ["t1", "t3"]], "only the left-out findings are asked again");
  assert.equal(findings.every((f) => f.decision === "adjudicator_unblock"), true);
  assert.equal(ledger.calls.length, 2, "both calls are paid for and recorded");
  assert.equal(warnings.some((w) => /judge unavailable/.test(w)), false, "a recovered answer is not reported as unavailable");

  // Left out twice: the finding keeps the rules' outcome, and there is no third call.
  const stubborn = make();
  const again = [];
  let calls = 0;
  await judge(stubborn, packsOf(stubborn), async (packs, model) => { calls++; return leaveOut([0])(packs, model); }, { ...DEFAULTS, escalationModel: "" }, (w) => again.push(w), false, newLedger());
  assert.equal(calls, 2);
  assert.equal(stubborn[0].decision, "unavailable");
  assert.equal(stubborn[0].blocking, true);
  assert.equal(stubborn.slice(1).every((f) => f.decision === "adjudicator_unblock"), true);
  assert.equal(again.filter((w) => /judge unavailable for "t1"/.test(w)).length, 1);
});

test("the summary leads with what blocks and says what the model cost", () => {
  const blocked = classify({ ...failing, title: "MM-T5803 subtitle" }, trunkPasses(25), [], undefined, 1);
  const cleared = { ...classify({ ...failing, title: "MM-T5828 redacts" }, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1),
    blocking: false, decision: "adjudicator_unblock", ai: { model: DEFAULTS.model, cost_usd: 0.0031 },
    judge: { ...flakyAnswer, confidence: 0.9, provenance: { served_model: "claude-haiku-4-5-20251001" } } };
  const ai = { calls: [{ model: DEFAULTS.model, served_model: "claude-haiku-4-5-20251001", findings: 1, usage: { input_tokens: 2100, output_tokens: 120, cache_read_input_tokens: 0 }, cost_usd: 0.0031 }],
    skipped: { no_effect: 3, duplicate: 0, cached: 0, cap: 0, budget: 0 } };
  const c = renderSummary({ context: "c", verdict: "FAILURE", findings: [cleared, blocked], infra: null, model: "m", runURL: "u", counts: { failed: 2, passed: 10, skipped: 1 }, ai });
  assert.match(c, /^## E2E triage: 🔴 1 test needs a look\n/);
  assert.match(c, /\*\*Verdict:\*\* 1 failed test still blocks: 1 is not explained by history\. 1 other failed test was cleared\. Next step: re-run the job\./);
  assert.match(c, /10 passed · 2 failed · 1 skipped · AI: 1 call, \$0\.0031/);
  assert.ok(c.indexOf("MM-T5803 subtitle · `a.spec.ts`") < c.indexOf("MM-T5828 redacts · `a.spec.ts`"), "what blocks comes first");
  assert.match(c, /\| MM-T5803 subtitle · `a\.spec\.ts` \| 🔴 Likely regression \| Check your change, or merge the default branch \| rules \|/);
  assert.match(c, /\| MM-T5828 redacts · `a\.spec\.ts` \| ✅ Not caused by this PR: flaky or environment \| Nothing \| AI · haiku-4-5-20251001 \|/);
  assert.match(c, /\| AI \(haiku-4-5-20251001\) \| Not caused by this PR \(flaky or environment\), 90% sure, enough to decide\. recurs elsewhere \|/);
  assert.match(c, /AI: 1 call \(haiku-4-5-20251001\) · 2\.1k tokens in · 120 out · \*\*\$0\.0031\*\* · skipped: 3 with nothing the model could change$/);
  assert.doesNotMatch(c, /model's own estimate|cites cross_pr/, "no disclaimer, no evidence ids");
});

test("a failure skipped on retry is still a failure", async () => {
  // Desktop serial describe: a failure followed by a skip is a failure, not a skip.
  const run = await fetchRun(fakeFetch(runRoutes([
    [caseRow("serial", "failed", 0), caseRow("serial", "skipped", 1)],
    [caseRow("late", "skipped", 0), caseRow("late", "passed", 1)],
    [caseRow("never", "skipped", 0), caseRow("never", "skipped", 1)],
  ])), "http://tsio", JSON.parse(env.COMPOSITE_IDENTITY));
  assert.deepEqual(run.failing.map((f) => f.title), ["serial"]);
  assert.deepEqual(run.counts, { total: 3, passed: 1, failed: 1, flaky: 0, skipped: 1 });
});
test("the status description accounts for every test in the run", async () => {
  // Two failures broken on trunk, one passed, one recovered on retry, one skipped.
  const routes = (statuses) => [
    ...runRoutes([spec("t1", "failed"), spec("t2", "failed"), spec("t3", "passed"), spec("t4", "passed", 1), spec("t5", "skipped")]),
    ["/reports/history", () => Response.json({ observations: [...trunkFailsAll(8), ...trunkFailsAll(8).map((o) => ({ ...o, title: "t2" }))] })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", (i) => { statuses.push(JSON.parse(i.body)); return Response.json({}); }],
  ];
  const written = [];
  const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(routes(written)), log: () => {} });
  assert.deepEqual(result.counts, { total: 5, passed: 2, failed: 2, flaky: 1, skipped: 1 });
  const required = written.filter((s) => s.context === "e2e-test/playwright");
  assert.equal(required.length, 1);
  assert.equal(required[0].state, "success");
  assert.equal(required[0].description, "2 passed, 2 failed (2 cleared by triage), 1 skipped");

  const counts = { passed: 240, failed: 2, skipped: 3 };
  assert.equal(statusDescription("FAILURE", [{ blocking: true }, { blocking: false }], null, counts), "240 passed, 2 failed (1 cleared by triage, 1 unresolved), 3 skipped");
  assert.equal(statusDescription("ACTION_REQUIRED", [], "5 of 6 failures are infrastructure errors", counts), "240 passed, 2 failed (not triaged, investigation required), 3 skipped");
});
test("a sibling suite's trunk failure cannot clear this suite's failure", async () => {
  // Two suites with the same leaf title: Suite B's trunk failure must not clear Suite A.
  const suites = [
    { id: "s-a", file_path: "specs/a.spec.ts", title: "Suite A", report_name: "e2e-on-windows-2022-1.0" },
    { id: "s-b", file_path: "specs/a.spec.ts", title: "Suite B", report_name: "e2e-on-windows-2022-1.0" },
  ];
  const cases = [
    { suite_id: "s-a", title: "same leaf", status: "failed", retry_count: 0, ordinal: 0, error_message: "boom", error_stack: null },
    { suite_id: "s-b", title: "same leaf", status: "passed", retry_count: 0, ordinal: 1, error_message: null, error_stack: null },
  ];
  // Trunk history, as the deployed endpoint returns it: suite and report named,
  // but no ancestor-prefixed title to tie a row to one of the two suites.
  const history = Array.from({ length: 8 }, (_, i) => obs({
    commit_sha: `t${i}`, group_id: `gt${i}`, title: "same leaf", status: "failed",
    suite_title: "Suite B", report_name: "e2e-on-windows-2022-1.0",
    created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z`,
  }));
  const routes = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
    ["/reports/history", () => Response.json({ observations: history })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/issues/5/comments", (i) => (i.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", () => Response.json({})],
  ];
  const e = {
    ...env,
    COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "desktop-pr", branch: "pr-5", gh_pr_number: 5 }),
    REPORT_NAME: "e2e-on-windows-2022",
    ANTHROPIC_API_KEY: "",
  };
  const result = await triage({ env: e, fetchImpl: fakeFetch(routes), log: () => {} });

  assert.equal(result.counts.failed, 1, "Suite B passing does not erase Suite A's failure");
  assert.equal(result.findings.length, 1);
  const f = result.findings[0];
  assert.notEqual(f.class, "BROKEN_ON_TRUNK", "Suite B's history is not Suite A's history");
  assert.equal(f.blocking, true, "an unresolvable identity may not be cleared");
  assert.equal(result.verdict, "FAILURE");
});
test("a fully qualified title ties history to the right suite", async () => {
  // With ancestor-prefixed titles on both sides the same run resolves properly:
  // Suite A's own trunk history is read, and Suite B's is ignored.
  const suites = [
    { id: "s-a", file_path: "specs/a.spec.ts", title: "Suite A", report_name: "r1" },
    { id: "s-b", file_path: "specs/a.spec.ts", title: "Suite B", report_name: "r1" },
  ];
  const cases = [
    { suite_id: "s-a", title: "same leaf", full_title: "Suite A > same leaf", status: "failed", retry_count: 0, ordinal: 0, error_message: "boom", error_stack: null },
    { suite_id: "s-b", title: "same leaf", full_title: "Suite B > same leaf", status: "passed", retry_count: 0, ordinal: 1, error_message: null, error_stack: null },
  ];
  const history = [
    ...Array.from({ length: 8 }, (_, i) => obs({ commit_sha: `b${i}`, group_id: `gb${i}`, title: "same leaf", full_title: "Suite B > same leaf", status: "failed", report_name: "r1", created_at: `2026-09-0${(i % 8) + 1}T00:00:00Z` })),
    ...Array.from({ length: 8 }, (_, i) => obs({ commit_sha: `a${i}`, group_id: `ga${i}`, title: "same leaf", full_title: "Suite A > same leaf", status: "passed", report_name: "r1", created_at: `2026-09-1${i % 8}T00:00:00Z` })),
  ];
  const routes = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
    ["/reports/history", () => Response.json({ observations: history })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/issues/5/comments", (i) => (i.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", () => Response.json({})],
  ];
  const e = {
    ...env,
    COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "desktop-pr", branch: "pr-5", gh_pr_number: 5 }),
    REPORT_NAME: "r1",
    ANTHROPIC_API_KEY: "",
  };
  const result = await triage({ env: e, fetchImpl: fakeFetch(routes), log: () => {} });
  const f = result.findings[0];
  assert.equal(f.trunk.fails, 0, "Suite B's failures are not counted against Suite A");
  assert.equal(f.trunk.passes, 8, "Suite A's own history is what is read");
  assert.equal(f.class, "REGRESSION", "it fails here and passes on trunk, which is the truth");
  assert.equal(f.blocking, true);
});
test("an unreadable diff clears nothing, and never reaches the model", async () => {
  // An empty file list from a failed request looks exactly like "touched
  // nothing", which would let history rules clear a failure the PR caused.
  const asked = [];
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: [...trunkPasses(8), obs({ gh_pr_number: 1, status: "failed" }), obs({ gh_pr_number: 2, status: "failed" }), obs({ gh_pr_number: 3, status: "failed" })] })],
    ["/pulls/5/files", () => new Response("nope", { status: 500 })],
    ["/pulls/5", () => Response.json({ title: "x" })],
    ["api.anthropic.com", () => (asked.push(1), Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }))],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
  ]);
  const result = await triage({ env: { ...env, MODE: "report-only" }, fetchImpl, log: () => {} });
  assert.equal(result.ownershipUnknown, true);
  assert.equal(result.verdict, "FAILURE", "cross-PR history must not clear a failure when ownership is unknown");
  assert.equal(result.findings.every((f) => f.blocking), true);
  assert.equal(asked.length, 0, "the model sees the same incomplete pack, so it is skipped");
});
test("a trunk run is judged on what its own commit changed", async () => {
  // BASE_REF...commit is empty for a trunk commit, so ownership has to come from
  // the commit itself or a commit that edits its own failing spec looks innocent.
  const id = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "mobile-main-detox-ios", branch: "main" };
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "failed")], "mobile-main-detox-ios"),
    ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
    ["/commits/abc", () => Response.json({ files: [{ filename: "specs/a.spec.ts", patch: "@@" }] })],
  ]);
  const result = await triage({ env: { ...env, COMPOSITE_IDENTITY: JSON.stringify(id), MODE: "report-only" }, fetchImpl, log: () => {} });
  assert.equal(result.findings[0].class, "OWNED_BY_PR");
  assert.equal(result.verdict, "FAILURE");
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("/commits/abc")), "trunk ownership comes from the commit");
});
test("a run refuses to read another run's results", async () => {
  // A server that ignores the filters must not hand us another repository's run.
  const id = { repository: "o/r", commit_sha: "abc", name: "lane-a", gh_run_id: "12", gh_run_attempt: "1" };
  const other = { id: "g9", repository: "other/repo", commit: "zzz", name: "something-else", gh_run_attempt: "1" };
  const unfiltered = fakeFetch([["/reports?", () => Response.json({ reports: [other], total: 19659 })]]);
  await assert.rejects(() => fetchRun(unfiltered, "http://tsio", id), /no group for/);

  // Same repository, commit, name and attempt, but another workflow run (a rerun): not ours.
  const sibling = { id: "g8", repository: "o/r", commit: "abc", name: "lane-a", gh_run_id: "11", gh_run_attempt: "1", status: "completed" };
  const ambiguous = fakeFetch([
    ["/reports?", () => Response.json({ reports: [sibling], total: 1 })],
    ["/reports/g8/suites", () => Response.json({ suites: [{ id: "s9", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g8/cases", () => Response.json(spec("t1", "passed"))],
  ]);
  await assert.rejects(() => fetchRun(ambiguous, "http://tsio", id), /no group for/, "another run of the same commit is not this run");

  // And an identity that cannot name its run may not be resolved by guesswork.
  await assert.rejects(
    () => fetchRun(ambiguous, "http://tsio", { repository: "o/r", commit_sha: "abc", name: "lane-a" }),
    /missing gh_run_id or gh_run_attempt/,
  );

  const correct = { id: "g1", repository: "o/r", commit: "abc", name: "lane-a", gh_run_id: "12", gh_run_attempt: "1", status: "completed" };
  const filtered = fakeFetch([
    ["/reports?", () => Response.json({ reports: [other, sibling, correct], total: 3 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g1/cases", () => Response.json(spec("t1", "passed"))],
  ]);
  const run = await fetchRun(filtered, "http://tsio", id);
  assert.equal(run.group_id, "g1", "it picks its own group even when others come back alongside");
});
test("partial history clears nothing", async () => {
  // If the page cap is hit, the rows never fetched are exactly the ones that
  // might have shown a failure on trunk. Nothing may be cleared on that view.
  const page = { observations: [obs({ gh_pr_number: 1, status: "failed" }), ...trunkPasses(8)], has_more: true };
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json(page)],
    ["/pulls/5/files", () => Response.json([{ filename: "app/login.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "x" })],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
  ]);
  const result = await triage({ env: { ...env, MODE: "report-only", ANTHROPIC_API_KEY: "" }, fetchImpl, log: () => {} });
  assert.equal(result.historyTruncated, true);
  assert.equal(result.verdict, "FAILURE");
  assert.equal(result.findings.every((f) => f.blocking), true, "nothing may be cleared on partial history");
});
test("end to end: a regression the judge clears with cross-PR evidence turns the status green", async () => {
  const history = [...trunkPasses(8), obs({ gh_pr_number: 1, status: "failed" })].map((o) => ({ ...o }));
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "failed"), spec("t2", "passed"), spec("t3", "passed", 1)]),
    ["/reports/history", () => Response.json({ observations: history })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/login.ts", patch: "@@ -1 +1 @@" }])],
    ["/pulls/5", () => Response.json({ title: "Fix login", base: { ref: "master" } })],
    ["api.anthropic.com", (init) => {
      const text = JSON.parse(init.body).messages[0].content;
      assert.match(text, /"valid_evidence_ids":\[[^\]]*"cross_pr"/);
      assert.doesNotMatch(text, /@@ -1 \+1 @@/, "a hunk unrelated to the failure is not sent");
      assert.equal(init.headers["x-api-key"], "AK");
      return modelReply(init, { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr", "error"], explanation: "recurs on PR 1" });
    }],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", (init) => {
      const b = JSON.parse(init.body);
      assert.equal(b.state, "success");
      assert.equal(b.context, "e2e-test/playwright");
      return Response.json({});
    }],
  ]);
  const result = await triage({ env, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "SUCCESS");
  assert.equal(result.counts.flaky, 1);
  assert.equal(result.findings[0].decision, "adjudicator_unblock");
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("/statuses/abc")));
  const anthropic = fetchImpl.calls.find((c) => c.url.includes("anthropic"));
  assert.ok(!JSON.stringify(anthropic.init.headers).includes("GH"));
});
test("end to end: report-only never posts a status, and an owned spec is never judged", async () => {
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "specs/a.spec.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "x" })],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
  ]);
  const result = await triage({ env: { ...env, MODE: "report-only" }, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "FAILURE");
  assert.equal(result.findings[0].class, "OWNED_BY_PR");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("anthropic") || c.url.includes("/statuses/")));
});
test("end to end: infra storm is red for the environment, not the PR, and asks no model", async () => {
  const many = Array.from({ length: 6 }, (_, i) => [{ ...caseRow(`t${i}`, "failed"), error_message: "Error: server not healthy" }]);
  const fetchImpl = fakeFetch([
    ...runRoutes(many),
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", (init) => (assert.equal(JSON.parse(init.body).state, "failure"), Response.json({}))],
  ]);
  const result = await triage({ env, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "ACTION_REQUIRED");
  assert.ok(result.infra);
});
test("end to end: green run posts success and no comment", async () => {
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "passed")]),
    ["/statuses/abc", (init) => (assert.equal(JSON.parse(init.body).state, "success"), Response.json({}))],
  ]);
  const result = await triage({ env, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "SUCCESS");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("/comments")));
});

// ---- judge provenance, sampling and strict answers ----
const answerText = (over = {}) => JSON.stringify({ answers: [{ id: "f1", cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x", ...over }] });
const judgePack = { cross_pr_failures_14d: { other_prs_where_this_test_failed: ["PR 1"] }, diff_hunks_of_files_named_in_error: [], test: {}, error: "", engine: {}, trunk_history_14d: {}, pr: {} };
function fakeModel(served, { text = answerText(), stop = "end_turn" } = {}) {
  const calls = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return Response.json({ model: typeof served === "function" ? served(body.model) : served, stop_reason: stop, content: [{ type: "text", text }] });
  };
  impl.calls = calls;
  return impl;
}

const askOne = (fetchImpl, model) => askModelBatch(fetchImpl, "k", model, [judgePack]);

test("the judge and its escalation are pinned to versioned models", () => {
  // Versioned ids (no dated snapshot exists for these): a family alias could be
  // repointed underneath the thresholds.
  assert.equal(DEFAULTS.model, "claude-sonnet-5-5");
  assert.equal(DEFAULTS.escalationModel, "claude-fable-5-1");
  for (const m of [DEFAULTS.model, DEFAULTS.escalationModel]) assert.ok(priceFor(m), `${m} is priced, so the run budget applies to it`);
});

test("an answer from a model other than the one requested is discarded, once", async () => {
  const f = fakeModel("claude-haiku-4-5-20991231");
  await assert.rejects(() => askOne(f, "claude-haiku-4-5-20251001"), /is not the requested/);
  assert.equal(f.calls.length, 1, "a mismatch is deterministic, so it is not retried");

  const missing = fakeModel(undefined);
  await assert.rejects(() => askOne(missing, "claude-haiku-4-5-20251001"), /is not the requested/, "an answer that cannot name its model is not used");
});

test("an alias may be answered by its own snapshot and by nothing else", () => {
  assert.equal(servedMatches("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"), true);
  assert.equal(servedMatches("claude-haiku-4-5-20251001", "claude-haiku-4-5-20991231"), false, "a dated request needs exactly that snapshot");
  assert.equal(servedMatches("claude-haiku-4-5", "claude-haiku-4-5-20251001"), true, "that is what an alias is");
  assert.equal(servedMatches("claude-haiku-4-5", "claude-haiku-4-5-latest"), false, "not a dated snapshot");
  assert.equal(servedMatches("claude-haiku-4-5", "claude-sonnet-4-6-20251001"), false, "a different model entirely");
  assert.equal(servedMatches("claude-haiku-4", "claude-haiku-4-5-20251001"), false, "a prefix of a longer name is not the same alias");
});

test("provenance is recorded with the answer and named in the comment", async () => {
  const [a] = (await askOne(fakeModel((m) => m), "claude-haiku-4-5-20251001")).answers;
  assert.equal(a.provenance.requested_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance.served_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance.temperature, 0);
  assert.match(a.provenance.pack_hash, /^[0-9a-f]{64}$/);

  const f = { ...classify(failing, trunkPasses(8), []), judge: { ...a, cited_evidence: ["cross_pr"] }, decision: "adjudicator_unblock", blocking: false };
  const c = renderSummary({ context: "c", verdict: "SUCCESS", findings: [f], infra: null, model: "claude-haiku-4-5", runURL: "u", counts: { failed: 1 } });
  assert.ok(c.includes("AI · haiku-4-5-20251001"), "the row names the model that answered, not the alias that was asked for");
});

test("temperature is sent only to models that accept it", async () => {
  for (const m of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]) {
    const f = fakeModel((x) => (m.endsWith("20251001") ? m : `${m}-20251001`));
    await askOne(f, m);
    assert.equal(f.calls[0].temperature, 0, `${m} accepts temperature`);
  }
  // Newer models return a 400 for any non-default temperature, and an unknown
  // model is treated the same way: better the API default than a failed request.
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "some-future-model"]) {
    const f = fakeModel(m);
    await askOne(f, m);
    assert.equal("temperature" in f.calls[0], false, `${m} must not be sent a temperature`);
  }
});

test("a malformed confidence cannot clear a regression, end to end", async () => {
  // The reproduction: confidence 7 used to be clamped to 1 and clear the finding.
  const f = fakeModel((m) => m, { text: answerText({ confidence: 7 }) });
  const findings = [classify(failing, trunkPasses(8), [])];
  assert.equal(findings[0].class, "REGRESSION");
  const packs = [judgePack];
  await judge(findings, packs, (batch, model) => askModelBatch(f, "k", model, batch), DEFAULTS, () => {});
  assert.equal(findings[0].blocking, true, "a malformed answer leaves the deterministic verdict in place");
  assert.notEqual(findings[0].decision, "adjudicator_unblock");
});

test("only a complete answer is used", async () => {
  for (const stop of ["max_tokens", "stop_sequence", "refusal", "tool_use"])
    await assert.rejects(() => askOne(fakeModel((m) => m, { stop }), "claude-haiku-4-5-20251001"), /stop_reason/, stop);
});

test("a changed file relates to an error only where the error names it", () => {
  const f = (error, file = "detox/maestro/flows/account/a.yml") => ({ error, file });
  const precondition = f("AllowDownloadLogs=false never reached the client config; the flow's pre-condition was not in force");
  // mattermost-mobile#10172: the word "config" made detox/e2e/config.js look related.
  assert.equal(namesChangedFile(precondition, "detox/e2e/config.js"), false);
  assert.equal(namesChangedFile(f("Cannot find module './config' from 'x.ts'"), "detox/e2e/config.js"), true);
  assert.equal(namesChangedFile(f("at load (detox/e2e/config.js:12:3)"), "detox/e2e/config.js"), true);
  assert.equal(namesChangedFile(f("Expected index to be 3"), "app/screens/home/index.tsx"), false);
  // Identifier-like names relate wherever they appear, so a changed component stays tied to its test ids.
  assert.equal(namesChangedFile(f("Expected server_form to be visible"), "app/screens/server/server_form.tsx"), true);
  const bookmark = f("Assertion is false: id: channel_bookmark.screen is not visible");
  assert.equal(namesChangedFile(bookmark, "app/screens/channel_bookmark/index.tsx"), true);
  assert.equal(namesChangedFile(bookmark, "app/utils/channel_bookmark.ts"), true);
  assert.equal(namesChangedFile(bookmark, ".github/workflows/e2e-maestro-template.yml"), false);
  assert.equal(namesChangedFile(f("boom", "e2e/channels/channel_settings.spec.ts"), "support/ui/channel_settings.ts"), true);
  assert.equal(namesChangedFile({ error: "x", file: "a/b.spec.ts", repo_path: "a/b.spec.ts" }, "a/b.spec.ts"), true);
});

test("a server answering with a page instead of JSON is infrastructure", () => {
  assert.ok(isInfraError("AllowDownloadLogs never took: wanted 'false', client config serves '<client config was not JSON: the server answered with an HTML page starting '<!DOCTYPE html>'>'"));
  assert.ok(isInfraError("Received HTML from server instead of JSON"));
  assert.equal(isInfraError("Assertion is false: id: channel_bookmark.screen is not visible"), false);
});

// mattermost-mobile#10172 run 37196938935: a test that passed on 23 earlier commits
// of the PR was kept red because the judge never saw that history.
const mine = (status, sha, at) => obs({ gh_pr_number: 1, status, commit_sha: sha, created_at: at });

test("this PR's own earlier runs are counted, newest pass first", () => {
  const f = classify(failing, [...trunkPasses(8), mine("failed", "new", "2026-09-12T00:00:00Z"), mine("passed", "mid", "2026-09-11T00:00:00Z"), mine("passed", "old", "2026-09-10T00:00:00Z")], [], undefined, 1);
  assert.equal(f.class, "REGRESSION", "this PR's own runs never change the rules' class");
  assert.deepEqual(f.this_pr, { runs: 3, passes: 2, fails: 1, last_pass: { commit_sha: "mid", created_at: "2026-09-11T00:00:00Z" } });
  assert.equal(f.cross_pr.passes, 0, "and they are not counted as other PRs");
  assert.equal(classify(failing, trunkPasses(8), [], undefined, null).this_pr.runs, 0, "a trunk run has no PR history");
});

test("a pass earlier on this PR counts as evidence only when nothing related changed since", () => {
  const base = { ...classify(failing, [...trunkPasses(8), mine("passed", "mid", "2026-09-11T00:00:00Z")], [], undefined, 1) };
  const pack = (since) => buildPack({ ...base, since_last_pass: since }, [], prCtx, []);
  assert.ok(evidenceIds(pack({ files: [".github/x.yml"], related: [] })).includes("this_pr"));
  assert.ok(!evidenceIds(pack({ files: ["src/expected.ts"], related: [{ file: "specs/a.spec.ts", patch: "@@" }] })).includes("this_pr"), "a related change since the pass");
  assert.ok(!evidenceIds(pack(undefined)).includes("this_pr"), "what changed since is unknown");
  const never = buildPack({ ...classify(failing, [...trunkPasses(8), mine("failed", "a", "2026-09-11T00:00:00Z")], [], undefined, 1), since_last_pass: { files: [], related: [] } }, [], prCtx, []);
  assert.ok(!evidenceIds(never).includes("this_pr"), "it never passed on this PR");

  const answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["this_pr"], explanation: "x" };
  assert.equal(decide("REGRESSION", answer, pack({ files: [".github/x.yml"], related: [] })).blocking, false);
  assert.equal(decide("REGRESSION", answer, pack({ files: ["a.ts"], related: [{ file: "a.ts", patch: "" }] })).blocking, true);
  assert.equal(decide("REGRESSION", { ...answer, confidence: 0.8 }, pack({ files: [], related: [] })).blocking, true, "still needs 85%");
});

test("the failing line and the test code around it come from the error's stack", () => {
  const f = { file: "detox/e2e/test/server_login/connect_to_server.e2e.ts", error: "Test Failed: timeout\n\nat Object.<anonymous> (/home/runner/work/m/m/detox/e2e/test/server_login/connect_to_server.e2e.ts:97:54)" };
  assert.equal(failingLine(f), 97);
  assert.equal(failingLine({ ...f, error: "no stack" }), null);
  assert.equal(failingLine({ ...f, error: "at x (other_connect_to_server.e2e.tsx:5:1)" }), null, "another file whose name ends the same is not this one");
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.equal(codeExcerpt(text, 97, 2, 1), "95  line 95\n96  line 96\n97> line 97\n98  line 98");
  assert.equal(codeExcerpt(text, 500), null);
});

test("extra evidence: changes since the last pass, the code at the failure, other platforms", async () => {
  const f = { ...classify({ ...failing, error: "Error: timeout\n at (specs/a.spec.ts:3:1)" }, [...trunkPasses(8), mine("passed", "lastpass", "2026-09-11T00:00:00Z")], [], undefined, 1), repo_path: "specs/a.spec.ts" };
  const calls = [];
  const api = async (method, path) => {
    calls.push(path);
    if (path.startsWith("/repos/o/r/compare/lastpass...head")) return { files: [{ filename: ".github/ci.yml", patch: "@@ -1 +1 @@" }, { filename: "specs/a.spec.ts", patch: "@@ spec" }] };
    if (path.startsWith("/repos/o/r/contents/specs/a.spec.ts?ref=head")) return { encoding: "base64", content: Buffer.from("one\ntwo\nthree\nfour").toString("base64") };
    throw new Error(`unexpected ${path}`);
  };
  const tsio = async (url) => {
    const u = String(url);
    if (u.includes("/reports?") && !u.includes("name=")) return Response.json({ reports: [
      { id: "g-self", name: "pw", gh_run_id: "9", gh_run_attempt: "1" },
      { id: "g-ios", name: "mobile-pr-detox-ios", gh_run_id: "9", gh_run_attempt: "1" },
      { id: "g-old", name: "mobile-pr-detox-ios", gh_run_id: "8", gh_run_attempt: "1" },
    ] });
    if (u.includes("name=mobile-pr-detox-ios")) return Response.json({ reports: [{ id: "g-ios", name: "mobile-pr-detox-ios", repository: "o/r", commit: "head", gh_run_id: "9", gh_run_attempt: "1", status: "completed", total_reports_expected: 1, reports: [{}] }] });
    if (u.includes("/reports/g-ios/suites")) return Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] });
    if (u.includes("/reports/g-ios/cases")) return Response.json([{ suite_id: "s1", title: "t1", status: "passed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }]);
    throw new Error(`unexpected ${u}`);
  };
  const logs = [];
  await enrichFindings({ findings: [f], api, fetchImpl: tsio, base: "http://tsio", id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", log: (m) => logs.push(m) });
  assert.deepEqual(f.since_last_pass.files, [".github/ci.yml", "specs/a.spec.ts"]);
  assert.deepEqual(f.since_last_pass.related.map((r) => r.file), ["specs/a.spec.ts"], "the spec itself changed since the pass");
  assert.equal(f.since_last_pass.changes.length, 2, "a small change set goes to the judge whole");
  assert.equal(f.code_near_failure, "1  one\n2  two\n3> three\n4  four");
  assert.deepEqual(f.other_lanes, [{ platform: "detox-ios", result: "passed" }], "only this run's other platforms");
  assert.deepEqual(logs, []);

  // Every lookup can fail without failing triage: the fact is left out.
  const g = { ...classify(failing, [...trunkPasses(8), mine("passed", "lastpass", "2026-09-11T00:00:00Z")], [], undefined, 1) };
  await enrichFindings({ findings: [g], api: async () => { throw new Error("down"); }, fetchImpl: async () => { throw new Error("down"); }, base: "http://tsio", id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", log: (m) => logs.push(m) });
  assert.equal(g.since_last_pass, undefined);
  assert.equal(g.other_lanes, undefined);
  assert.equal(logs.length, 2);
});

test("the summary shows the facts behind each verdict and who decided", () => {
  const f = { ...classify(failing, [...trunkPasses(25), mine("passed", "4f4dbd3fb4", "2026-10-04T06:29:17Z")], [], undefined, 1),
    untouched: true, tries: { ran: 2, failed: 2 }, other_lanes: [{ platform: "detox-ios", result: "passed" }],
    since_last_pass: { files: [".github/workflows/e2e-detox-pr.yml"], related: [] },
    ai: { model: "claude-sonnet-5-5", cost_usd: 0.1 }, decision: "engine",
    judge: { cause: "flaky_environment", confidence: 0.68, cited_evidence: ["producer"], explanation: "Waits on an outside host.", provenance: { served_model: "claude-sonnet-5-5" } } };
  const c = renderSummary({ verdict: "FAILURE", findings: [f], infra: null, runURL: "u", counts: { failed: 1, passed: 594, skipped: 42 }, lane: "detox-android", trunkBranch: "main" });
  assert.match(c, /^## E2E triage · detox-android: 🔴 1 test needs a look/);
  assert.match(c, /\*\*Verdict:\*\* 1 failed test still blocks: 1 looks like a flaky or environment failure, but triage was not sure enough to clear it\. Next step: re-run the job\./);
  assert.match(c, /🟡 Likely flaky or environment, but not sure enough to clear \| Re-run the job \| rules \+ AI \|/, "the AI was asked, so it is not 'rules' alone");
  for (const row of [
    /\| main, last 25 runs \| Passed 25, failed 0\. Latest: passed \|/,
    /\| This PR's earlier runs \| Passed 1 of 1\. Last pass: 4f4dbd3, 2026-10-04 06:29 \|/,
    /\| Changed on this PR since that pass \| 1 file: \.github\/workflows\/e2e-detox-pr\.yml\. None named in the test's error \|/,
    /\| Same test, same run, other platforms \| detox-ios: passed \|/,
    /\| Tries in this run \| Failed all 2 \|/,
    /\| AI \(sonnet-5-5\) \| Not caused by this PR \(flaky or environment\), 68% sure; clearing needs 85% and evidence\. Waits on an outside host\. \|/,
  ]) assert.match(c, row);
  assert.doesNotMatch(c, /model's own estimate|cites |producer|this_pr/, "no disclaimer and no evidence ids");
});
