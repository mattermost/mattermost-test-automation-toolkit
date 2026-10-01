// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULTS,
  parseAnswer,
  renderComment,
  judge,
  samplingFor,
  servedMatches,
  askModel,
  identityKey,
  fetchChangedFiles,
  repoPath,
  buildPack,
  classify,
  laneOf,
  EXONERATED_ON_TRUNK,
  decide,
  evidenceIds,
  fetchHistory,
  fetchRun,
  infraVerdict,
  isInfraError,
  statusDescription,
  triage,
  verdictOf,
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
  // A composite identity built with jq carries gh_pr_number as a string. If the
  // comparison were strict, PR 5's own three failures would look like three
  // other PRs and clear the failure on the strength of its own history.
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
  // On a trunk run the current group carries no PR number, so it would land in
  // trunk history and the run would read its own failure as proof that trunk was
  // already broken. The contrast is the whole point: same history, and only the
  // group id changes the answer.
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

  // Evidence with no content must not be citable. Without this, a model naming
  // "cross_pr" on a finding where no other PR failed clears it while pointing at
  // an empty list, which is the whole guarantee gone.
  const alone = classify(failing, trunkPasses(8), []);
  const emptyPack = buildPack(alone, [{ filename: "docs/readme.md", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  assert.equal(evidenceIds(emptyPack).includes("cross_pr"), false, "no other PR failed, so cross_pr is not citable");
  assert.equal(decide("REGRESSION", ok, emptyPack).blocking, true, "citing empty cross_pr must not unblock");
  assert.equal(decide("REGRESSION", { ...ok, cited_evidence: ["hunk_0"] }, emptyPack).blocking, true, "an unrelated hunk must not unblock");
});
test("a claim that master is broken cannot unblock on its own", () => {
  // The rules only escalate a REGRESSION when trunk history was clean, so a model
  // asserting bug_on_master is arguing against the data. Without a citation a
  // reviewer can open, it must not clear the failure.
  const pack = buildPack(classify(failing, [...trunkPasses(8), ...crossPR(21, 22)], [], undefined, 1), [{ filename: "specs/a.spec.ts", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  const noCitation = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: [], explanation: "x" }, pack);
  assert.equal(noCitation.blocking, true, "bug_on_master with no citation must stay blocking");
  const invented = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: ["made_up"], explanation: "x" }, pack);
  assert.equal(invented.blocking, true, "an invented citation is filtered, so it cannot unblock");
  const real = decide("REGRESSION", { cause: "bug_on_master", confidence: 0.99, cited_evidence: ["cross_pr"], explanation: "x" }, pack);
  assert.equal(real.blocking, false, "a checkable citation still clears it");
});
test("judge caps the number of findings and survives outages", async () => {
  const findings = Array.from({ length: 10 }, (_, i) => classify({ ...failing, title: `t${i}` }, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1));
  const packs = findings.map((f) => buildPack(f, [], { number: 1, repository: "o/r", title: "", lane: "l" }, []));
  let calls = 0;
  await judge(findings, packs, async () => {
    calls++;
    if (calls === 2) throw new Error("boom");
    return { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  });
  assert.equal(calls, 8);
  assert.equal(findings.filter((f) => f.decision === "adjudicator_unblock").length, 7);
  assert.equal(findings.filter((f) => f.decision === "unavailable").length, 1);
  assert.equal(findings.slice(8).every((f) => f.blocking && !f.decision), true);
  assert.equal(verdictOf(findings, null), "FAILURE");
});
test("parseAnswer rejects anything it would otherwise have to repair", () => {
  const ok = { cause: "test_bug", confidence: 0.5, cited_evidence: ["a"], explanation: "e" };
  assert.throws(() => parseAnswer(JSON.stringify({ ...ok, cause: "vibes" })), /unknown cause/);
  // A confidence outside [0, 1] used to be clamped: 7 became 1, the most trust
  // the decision matrix can give, and cleared a regression. It is now rejected,
  // so the finding keeps its deterministic outcome.
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
test("comment names the evidence and escapes markdown", () => {
  const f = { ...classify({ ...failing, title: "a | b" }, trunkPasses(8), []), judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "recurs <x>" }, decision: "adjudicator_unblock", blocking: false };
  const c = renderComment({ context: "e2e-test/x", verdict: "SUCCESS", findings: [f], infra: null, model: "m", runURL: "u", counts: { failed: 1 } });
  assert.ok(c.startsWith("<!-- e2e-triage:e2e-test/x -->"));
  assert.ok(c.includes("a &#124; b") && c.includes("&lt;x&gt;") && c.includes("cites cross_pr"));
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
  // Rows that share file, title and attempt but come from different runs are the
  // normal case, and rows may arrive without a group id at all. An over-eager key
  // collapsed all of these into one, which shrank trunk history to a single run
  // and made the rules report INSUFFICIENT_DATA on a test with plenty of history.
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
  // Pushing a branch without an open PR yields rows with no PR number, which is
  // indistinguishable from a trunk run unless the branch is checked. On a real
  // desktop spec such a branch supplied 15 of 41 supposed trunk rows.
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
  // TSIO stores calls/x.test.ts where the desktop repository says
  // e2e/specs/calls/x.test.ts. Compared directly they never match, so a PR that
  // edits the failing spec was being cleared by trunk history instead.
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
  const routes = (g, suites, cases) => [
    ["/reports?", () => Response.json({ reports: [g] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const suite = [{ id: "s1", file_path: "specs/a.spec.ts", report_name: "e2e-on-windows-2022-1.0" }];

  await assert.rejects(
    () => fetchRun(fakeFetch(routes(group({ status: "processing" }), suite, [])), "http://tsio", id),
    /not completed/, "an unfinished upload cannot show whether the run passed");

  await assert.rejects(
    () => fetchRun(fakeFetch(routes(group(), suite, [])), "http://tsio", id, "e2e-on-windows"),
    /no test cases/, "a report with a matching suite but no cases is not a green run");
});
test("two describe blocks sharing a leaf title are different tests", async () => {
  // Keyed on file and title their rows merge, sort as if they were retries of
  // one test, and the last status wins -- so the passing block erases the
  // failing one and the run reports clean.
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
  assert.equal(written.length, 1, "explicit enforce still writes exactly one status");
  assert.equal(written[0].context, "e2e-test/playwright");
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
  // mattermost#38601: MM-T5828 failed twice on dispatch-run-14 and passed on its
  // retest on dispatch-run-3. Keyed on the suite, that was a failure plus an
  // ambiguous identity; the run summary, like Playwright, calls it flaky.
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
test("a failure skipped on retry is still a failure", async () => {
  // Serial describe on desktop: attempt 0 fails, attempt 1 skips the rest of the
  // block. Read as skipped, the failure never reached triage and enforce wrote
  // e2e/windows green over it.
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
  assert.equal(written[0].state, "success");
  assert.equal(written[0].description, "2 passed, 2 failed (2 cleared by triage), 1 skipped");

  const counts = { passed: 240, failed: 2, skipped: 3 };
  assert.equal(statusDescription("FAILURE", [{ blocking: true }, { blocking: false }], null, counts), "240 passed, 2 failed (1 cleared by triage, 1 unresolved), 3 skipped");
  assert.equal(statusDescription("ACTION_REQUIRED", [], "5 of 6 failures are infrastructure errors", counts), "240 passed, 2 failed (not triaged, investigation required), 3 skipped");
});
test("a sibling suite's trunk failure cannot clear this suite's failure", async () => {
  // One spec, two suites, both with a test called "same leaf". Suite A fails on
  // this PR and Suite B passes; trunk history holds a failure of Suite B's copy.
  // Keyed on file and leaf title those are one test, so Suite B's trunk failure
  // read as BROKEN_ON_TRUNK for Suite A and cleared it.
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
  // A deployment without the list filters answers the query with an unfiltered
  // list. Taking the first row would report an unrelated repository's result as
  // this run's, and it would look like a clean pass.
  const id = { repository: "o/r", commit_sha: "abc", name: "lane-a", gh_run_id: "12", gh_run_attempt: "1" };
  const other = { id: "g9", repository: "other/repo", commit: "zzz", name: "something-else", gh_run_attempt: "1" };
  const unfiltered = fakeFetch([["/reports?", () => Response.json({ reports: [other], total: 19659 })]]);
  await assert.rejects(() => fetchRun(unfiltered, "http://tsio", id), /no group for/);

  // The dangerous sibling: same repository, commit, name and attempt, different
  // workflow run. A rerun or a repeated dispatch produces exactly this, and the
  // older one may be green.
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
      assert.ok(JSON.parse(init.body).messages[0].content.includes("hunk_0"));
      assert.equal(init.headers["x-api-key"], "AK");
      return Response.json({ model: JSON.parse(init.body).model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr", "error"], explanation: "recurs on PR 1" }) }] });
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
const answerText = (over = {}) => JSON.stringify({ cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x", ...over });
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

test("the judge is pinned to a dated snapshot", () => {
  assert.match(DEFAULTS.model, /^claude-haiku-4-5-\d{8}$/, "an alias can be repointed underneath the thresholds");
});

test("an answer from a model other than the one requested is discarded, once", async () => {
  const f = fakeModel("claude-haiku-4-5-20991231");
  await assert.rejects(() => askModel(f, "k", "claude-haiku-4-5-20251001", judgePack), /is not the requested/);
  assert.equal(f.calls.length, 1, "a mismatch is deterministic, so it is not retried");

  const missing = fakeModel(undefined);
  await assert.rejects(() => askModel(missing, "k", "claude-haiku-4-5-20251001", judgePack), /is not the requested/, "an answer that cannot name its model is not used");
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
  const a = await askModel(fakeModel((m) => m), "k", "claude-haiku-4-5-20251001", judgePack);
  assert.equal(a.provenance.requested_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance.served_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance.temperature, 0);
  assert.match(a.provenance.pack_hash, /^[0-9a-f]{64}$/);

  const f = { ...classify(failing, trunkPasses(8), []), judge: { ...a, cited_evidence: ["cross_pr"] }, decision: "adjudicator_unblock", blocking: false };
  const c = renderComment({ context: "c", verdict: "SUCCESS", findings: [f], infra: null, model: "claude-haiku-4-5", runURL: "u", counts: { failed: 1 } });
  assert.ok(c.includes("Second judge (claude-haiku-4-5-20251001)"), "the header names the model that answered, not the alias that was asked for");
});

test("temperature is sent only to models that accept it", async () => {
  for (const m of ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]) {
    const f = fakeModel((x) => (m.endsWith("20251001") ? m : `${m}-20251001`));
    await askModel(f, "k", m, judgePack);
    assert.equal(f.calls[0].temperature, 0, `${m} accepts temperature`);
  }
  // Newer models return a 400 for any non-default temperature, and an unknown
  // model is treated the same way: better the API default than a failed request.
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "some-future-model"]) {
    const f = fakeModel(m);
    await askModel(f, "k", m, judgePack);
    assert.equal("temperature" in f.calls[0], false, `${m} must not be sent a temperature`);
  }
});

test("a malformed confidence cannot clear a regression, end to end", async () => {
  // The reproduction: confidence 7 used to be clamped to 1 and clear the finding.
  const f = fakeModel((m) => m, { text: answerText({ confidence: 7 }) });
  const findings = [classify(failing, trunkPasses(8), [])];
  assert.equal(findings[0].class, "REGRESSION");
  const packs = [judgePack];
  await judge(findings, packs, (pack) => askModel(f, "k", "claude-haiku-4-5-20251001", pack), DEFAULTS, () => {});
  assert.equal(findings[0].blocking, true, "a malformed answer leaves the deterministic verdict in place");
  assert.notEqual(findings[0].decision, "adjudicator_unblock");
});

test("only a complete answer is used", async () => {
  for (const stop of ["max_tokens", "stop_sequence", "refusal", "tool_use"])
    await assert.rejects(() => askModel(fakeModel((m) => m, { stop }), "k", "claude-haiku-4-5-20251001", judgePack), /stop_reason/, stop);
});
