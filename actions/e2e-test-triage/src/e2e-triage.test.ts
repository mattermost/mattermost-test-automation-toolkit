// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canChange, decide, decideRelease, judge, unblocks } from "./decision.ts";
import { EXONERATED_ON_TRUNK, classify, classifyNotRun, errorSignature, holdFailedEverywhere, infraVerdict, isInfraError, isShardPlaceholder, markEarlierFailures, sameFailure } from "./classify.ts";
import { DEFAULTS, PR_SPEND_KEY, configFrom, historyLane, laneOf, laneOfReport, repoPath } from "./config.ts";
import { SYSTEM_RELEASE, answerKey, askModelBatch, packKey, parseAnswer, samplingFor, servedMatches } from "./judge.ts";
import { OUT_OF_DATE_DIR_CAP, dropStormRuns, fetchChangedFiles, fetchHistory, fetchSpecRuns, markBrokeBy, markFixedOnTrunk, markOutOfDate, trunkRunsOn } from "./history.ts";
import { commonSenseClear, onlyOnPlatform, platformOf } from "./common-sense.ts";
import { codeExcerpt, enrichFindings, failingLine, prChangedSince, sameTestOnOtherReports, siblingPlatforms } from "./enrich.ts";
import { evidenceFor, loadEvidence } from "./evidence.ts";
import { CLEARING, buildPack, chainClears, changeCategory, changeSummary, compactError, evidenceIds, namesChangedFile, releasePack, serverOf } from "./pack.ts";
import type { OtherFailure } from "./pack.ts";
import { PRICES, costOf, newLedger, priceFor } from "./pricing.ts";
import { bucketOf, passLine, passRate, renderSummary, statusDescription, statusLabelOf, statusLabels } from "./render.ts";
import type { SummaryInput } from "./render.ts";
import { evaluateRun, verdictOf } from "./evaluate.ts";
import type { EvaluatedRun, EvaluateParams } from "./evaluate.ts";
import { NotTriagedError, triage } from "./triage.ts";
import { FINDINGS_SCHEMA, checkFindingsShape, findingLogLine, redact } from "./findings.ts";
import type { CommitStatus, Env, FetchImpl, GhApi } from "../../shared/src/github.ts";
import { laneSummary, redReason } from "../../shared/src/lane.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { elsewhereKey, fetchRun, identityKey, missingReports } from "../../shared/src/tsio.ts";
import type { RunResult } from "../../shared/src/tsio.ts";
import type { Answer, AskFn, BatchResult, CallRecord, Config, Evidence, Finding, Ledger, Observation, Pack, PrRef, SinceLastPass, SpecRun, TestRef, Usage } from "./types.ts";


// ---------------------------------------------------------------- fixtures and fakes

const obs = (over: Partial<Observation> = {}): Observation => ({ file: "specs/a.spec.ts", title: "t1", status: "passed", retry_count: 0, gh_pr_number: null, commit_sha: "abcdef0123", created_at: "2026-09-10T10:00:00Z", branch: "master", ...over });
const failing: TestRef = { file: "specs/a.spec.ts", title: "t1", error: "Error: expected visible" };
// Other PRs that failed the same test, so cross_pr evidence has real content.
const crossPR = (...prs: number[]): Observation[] => prs.map((n) => obs({ gh_pr_number: n, status: "failed", commit_sha: `x${n}` }));
const trunkFailsAll = (n: number): Observation[] => Array.from({ length: n }, (_, i) => obs({ commit_sha: `f${i}`, status: "failed", created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z` }));
const trunkPasses = (n: number): Observation[] => Array.from({ length: n }, (_, i) => obs({ commit_sha: `c${i}`, created_at: `2026-09-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z` }));

/** A value the test builds with only the fields it sets; the code under test is not given the rest here. */
function fixture<T>(partial: Partial<T>): T {
  return partial as T;
}

/** Parsed JSON, with the shape the test reads from it. */
function parsed<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** The body of a request, as text (what JSON.parse was given before). */
const bodyText = (init: RequestInit | undefined): string => String(init?.body);

/** The text of a Messages API content field, whichever of its two shapes it has. */
const contentText = (content: string | Part[]): string => (typeof content === "string" ? content : content.map((p) => p.text ?? "").join(""));
const partsOf = (content: string | Part[]): Part[] => (typeof content === "string" ? [] : content);

interface Part {
  type: string;
  text?: string;
  source?: { type?: string; media_type: string; data: string };
}

interface SchemaBody {
  properties: { answers?: { items: { properties: { id: unknown; cause?: { enum?: string[] } } } } };
}

interface MessageBody {
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  messages: { role: string; content: string | Part[] }[];
  output_config: { format: { schema: SchemaBody } };
}

interface StatusBody {
  state: string;
  context: string;
  description?: string;
  target_url?: string;
}

interface HistoryBody {
  files?: string[];
  tests?: unknown;
  since?: string;
  branch?: string;
  runs?: number;
  page?: number;
  report?: string;
}

type Route = [string, (init: RequestInit) => Response | Promise<Response>];

interface FakeCall {
  url: string;
  init: RequestInit;
}

type FakeFetch = FetchImpl & { calls: FakeCall[] };

function fakeFetch(routes: Route[]): FakeFetch {
  const calls: FakeCall[] = [];
  const impl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) if (String(url).includes(match)) return respond(init);
    if (String(url).includes("/commits/abc/statuses")) return Response.json([{ context: "e2e-test/playwright", state: "failure", target_url: "https://github.com/o/r/actions/runs/12" }]);
    // A comparison no test routes is "nothing changed", as GitHub answers an identical pair. A failed compare now leaves a failure unchecked.
    if (String(url).includes("/compare/")) return Response.json({ ahead_by: 0, behind_by: 0, total_commits: 0, files: [], commits: [] });
    throw new Error(`unexpected fetch ${url}`);
  };
  return Object.assign(impl, { calls });
}

// A Messages API reply in the shape the request asked for: one answer per
// finding id for a run's batch, a bare answer for a single pack.
function modelReply(init: RequestInit | undefined, answer: Partial<Answer>, usage: Usage = { input_tokens: 2000, output_tokens: 150 }): Response {
  const body = parsed<MessageBody>(bodyText(init));
  const text = contentText(body.messages[0].content);
  const ids = [...new Set(text.match(/"id":"f\d+"/g) ?? [])].map((m) => m.slice(6, -1));
  const reply = body.output_config.format.schema.properties.answers ? { answers: ids.map((id) => ({ id, ...answer })) } : answer;
  return Response.json({ model: body.model, stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify(reply) }] });
}

// TSIO run fixtures: one group, one suite per spec, one case row per attempt.
const caseRow = (title: string, status: string, retry = 0, suite = "s1") => ({ suite_id: suite, title, status, retry_count: retry, ordinal: 0, error_message: status === "passed" ? null : "Error: expected visible", error_stack: null });
const spec = (title: string, status: string, retries = 0) => [...Array.from({ length: retries }, (_, i) => caseRow(title, "failed", i)), caseRow(title, status, retries)];
const runRoutes = (specs: unknown[][], name = "playwright-full"): Route[] => [
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
const prCtx: PrRef = { number: 1, repository: "o/r", title: "", lane: "l" };
/** A summary input; the extra keys the old tests passed (context, model) are read by nothing here. */
type SummaryFixture = SummaryInput & { context?: string; model?: string };
const summary = (input: SummaryFixture): string => renderSummary(input);

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
test("trunk's instability clears a PR's failure only when trunk failed the same way", () => {
  const pr: TestRef = { ...failing, error: 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"' };
  const same = obs({ status: "failed", commit_sha: "s1", error_excerpt: pr.error });
  const other = obs({ status: "failed", commit_sha: "o1", error_excerpt: "Error: apiCreateChannel failed: No response from server: timeout of 45000ms exceeded" });
  assert.equal(classify(pr, [...trunkPasses(8), same], []).class, "FLAKY_ON_TRUNK");
  const newWay = classify(pr, [...trunkPasses(8), other], []);
  assert.equal(newWay.class, "REGRESSION", "a flaky test broken in a new way goes to the judge");
  assert.equal(newWay.blocking, true);
  assert.match(newWay.reason, /never with this error; there it failed with "Error: apiCreateChannel failed/);
  assert.equal(classify(pr, [...trunkPasses(8), same, other], []).class, "FLAKY_ON_TRUNK", "it failed this way on trunk too");
  assert.equal(classify(pr, [...trunkPasses(8), obs({ status: "failed", commit_sha: "u1" }), other], []).class, "REGRESSION", "a trunk failure with no error to compare can't clear it either");
  const noError = classify(pr, [...trunkPasses(8), obs({ status: "failed", commit_sha: "u1" })], []);
  assert.equal(noError.class, "REGRESSION");
  assert.match(noError.reason, /never with this error; there it left no error to compare\.$/);
  // mobile #10048: trunk's only failure of the test was a hook timeout in a storm run, and the PR broke it another way.
  const hook = obs({ status: "failed", commit_sha: "h1", error_excerpt: 'Error: thrown: "Exceeded timeout of 300000 ms for a hook.' });
  assert.match(classify({ ...failing, error: "Test Failed: 'not null' doesn't match the selected view." }, [...trunkPasses(24), hook], []).reason, /never with this error; there it failed with "Error: thrown: "Exceeded timeout of 300000 ms for a hook\./);
  // A timeout compares by where it got stuck: another duration is the same step.
  const stuck = (ms: number): string => `Error: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })`;
  assert.equal(classify({ ...failing, error: stuck(15000) }, [...trunkPasses(8), obs({ status: "flaky", commit_sha: "f1", error_excerpt: stuck(30000) })], []).class, "FLAKY_ON_TRUNK");
  assert.equal(classify({ ...failing, error: "Error: timeout" }, [...trunkPasses(8), other], []).class, "FLAKY_ON_TRUNK", "a generic error can't be compared");
  // Broken on trunk: the current streak's error decides.
  assert.equal(classify(pr, [other, ...trunkPasses(6)], []).class, "REGRESSION");
  assert.equal(classify(pr, [same, ...trunkPasses(6)], []).class, "BROKEN_ON_TRUNK");
});
test("failing every try here does not change the flake verdict: an environment that breaks fails every try too", () => {
  // Replayed on real runs, holding these red added 37 false reds in environment storms and none caught a PR.
  const error = 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"';
  const everyTry: TestRef = { ...failing, error, tries: { ran: 2, failed: 2 } };
  const flakeOnly = obs({ status: "flaky", commit_sha: "z1", error_excerpt: error });
  assert.equal(classify(everyTry, [flakeOnly, ...trunkPasses(8)], []).class, "FLAKY_ON_TRUNK");
  assert.equal(classify(everyTry, [flakeOnly, ...trunkPasses(8)], [], undefined, null, null, { isTrunkRun: true }).class, "FLAKY_ON_TRUNK");
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
test("on trunk, a pass on retry does not end a streak; a test that keeps failing and passing is a flake", () => {
  // mattermost release-12.1 run 40292449090: passed every run to 10-21 14:43, then failed every try in each run but one,
  // which passed on its retest (flaky). Every try failed here too.
  const run = (status: string, i: number) => obs({ commit_sha: `r${i}`, status, created_at: `2026-10-${String(26 - i).padStart(2, "0")}T00:00:00Z`, branch: "release-12.1" });
  const opts = { isTrunkRun: true, trunkBranch: "release-12.1" };
  const real = ["flaky", ...Array(7).fill("failed"), ...Array(5).fill("passed")].map(run);
  const f = classify({ ...failing, tries: { ran: 4, failed: 4 } }, real, [], undefined, null, null, opts);
  assert.equal(f.class, "BROKEN_ON_TRUNK");
  assert.equal(f.blocking, true);
  assert.match(f.reason, /failed or passed only on retry in each of the previous 8 trunk runs/);
  // Half its runs fail, but never two in a row: intermittent, so a flake.
  const alternating = Array.from({ length: 12 }, (_, i) => (i % 2 ? "failed" : "passed")).map(run);
  assert.equal(classify(failing, alternating, [], undefined, null, null, opts).class, "FLAKY_ON_TRUNK");
  // Two runs rescued by a retry, with no failure: still a flake.
  assert.equal(classify(failing, ["flaky", "flaky", ...Array(8).fill("passed")].map(run), [], undefined, null, null, opts).class, "FLAKY_ON_TRUNK");
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
  const ios = (o: Partial<Observation>) => obs({ ...o, name: o.gh_pr_number ? "mobile-pr-detox-ios" : "mobile-main-detox-ios" });
  const android = (o: Partial<Observation>) => obs({ ...o, name: o.gh_pr_number ? "mobile-pr-detox-android" : "mobile-main-detox-android" });
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
  const infra: TestRef = { ...failing, error: "Error: server not healthy at http://x" };
  assert.ok(infraVerdict([infra, infra, infra, failing]));
  assert.equal(infraVerdict([infra, failing, failing, failing]), null);
  assert.ok(infraVerdict(Array.from({ length: 30 }, () => failing)));
});
test("the test's own calls finding the test server down are infrastructure; the app's own failures are not", () => {
  // Verbatim from mattermost-mobile detox-ios run 39482819031, where both test servers stopped answering.
  const health = 'Error: apiCheckSystemHealth: server at "https://mobile-pr-10172-ios-site-1-xj4p6mrb.test.mattermost.cloud" is not healthy. {"message":"No response from server"}';
  const patch = 'Error: enableChannelAttributes: failed to patch server config: {"message":"No response from server: timeout of 45000ms exceeded."}';
  assert.ok(isInfraError(health));
  assert.ok(isInfraError(patch));
  assert.equal(isInfraError("Test Failed: Failed expectation: TOEXIST WITH MATCHER(id == login_form.username.input)"), false);
  const down = (n: number, error: string): TestRef[] => Array.from({ length: n }, (_, i) => ({ ...failing, title: `t${i}`, error }));
  assert.match(String(infraVerdict([...down(71, health), ...down(43, "TypeError: Cannot read properties of undefined (reading 'id')")])), /^71 of 114 failures are infrastructure errors/);
});
test("a test that failed on its environment is named so; it clears only where the change can't touch the environment", () => {
  const down: TestRef = { ...failing, error: 'Error: ReportAProblemType never took: client config serves "<client config was not JSON: the server answered with an HTML page starting \'<!DOCTYPE html>\'>"' };
  const history = [...trunkPasses(25)];
  const app = classify(down, history, [], { ...DEFAULTS, infraClears: true });
  assert.equal(app.class, "INFRA_ERROR");
  assert.equal(app.blocking, false, "mobile and desktop: the PR can't take the test server down");
  assert.equal(bucketOf(app), "flaky");
  const server = classify(down, history, [], DEFAULTS);
  assert.equal(server.class, "INFRA_ERROR");
  assert.equal(server.blocking, true, "a server PR can hang its own server: rerun, don't clear");
  assert.equal(bucketOf(server), "check");
  assert.match(server.reason, /Rerun; if it fails the same way again/);
  assert.equal(classify(down, history, ["specs/a.spec.ts"], { ...DEFAULTS, infraClears: true }).class, "OWNED_BY_PR", "a spec the PR edits is still the PR's");
  assert.equal(classify(failing, history, [], { ...DEFAULTS, infraClears: true }).class, "REGRESSION", "an app failure is not the environment");
  assert.equal(configFrom({ INFRA_CLEARS: "true" }).infraClears, true);
  assert.equal(configFrom({}).infraClears, false);
});
test("automatic re-runs are off unless the repo allows them; a count that is not a whole number of 0 or more is refused", () => {
  assert.equal(configFrom({}).rerunAttempts, 0);
  assert.equal(configFrom({ RERUN_ATTEMPTS: "2" }).rerunAttempts, 2);
  const warned: string[] = [];
  assert.equal(configFrom({ RERUN_ATTEMPTS: "1.5" }, (m) => warned.push(m)).rerunAttempts, 0);
  assert.equal(configFrom({ RERUN_ATTEMPTS: "-1" }, (m) => warned.push(m)).rerunAttempts, 0);
  assert.equal(warned.length, 2);
});
test("a lane the trunk rarely runs is judged against the lane it borrows history from", () => {
  const sub = fixture<CompositeIdentity>({ repository: "o/r", name: "playwright-full-enterprise-subpath" });
  assert.equal(historyLane(sub, configFrom({})), "playwright-full-enterprise-subpath");
  const cfg = configFrom({ HISTORY_LANE: " playwright-full-enterprise " });
  assert.equal(historyLane(sub, cfg), "playwright-full-enterprise");
  const pr: TestRef = { ...failing, error: 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"' };
  // The enterprise lane's trunk runs (reported as "...-master") flaked this way; the subpath lane never ran on trunk.
  const enterprise = (over: Partial<Observation>) => obs({ name: "playwright-full-enterprise-master", ...over });
  const history = [...Array.from({ length: 8 }, (_, i) => enterprise({ commit_sha: `e${i}` })), enterprise({ status: "failed", commit_sha: "ef", error_excerpt: pr.error })];
  assert.equal(classify(pr, history, [], cfg, null, laneOf(sub.name)).class, "INSUFFICIENT_DATA", "its own lane has no trunk runs");
  assert.equal(classify(pr, history, [], cfg, null, historyLane(sub, cfg)).class, "FLAKY_ON_TRUNK", "the same flake on the enterprise lane");
  const urlBreak: TestRef = { ...failing, error: "Error: expected URL to start with /subpath/ but got http://localhost:8065/login" };
  assert.equal(classify(urlBreak, history, [], cfg, null, historyLane(sub, cfg)).class, "REGRESSION", "an error the enterprise lane never had goes to the judge");
});
test("a spec whose shard uploaded nothing is an infrastructure failure, not a test outcome", () => {
  // Verbatim from mattermost-mobile detox/utils/merge-jest-results-for-tsio.js.
  const missing = (spec: string): TestRef => ({ file: spec, title: "spec did not run", error: `${spec} was assigned to a shard but produced no result. The shard uploaded nothing, or its Jest process died before reaching this spec.` });
  assert.ok(isInfraError(missing("a.e2e.ts").error));
  const regression: TestRef = { ...failing, error: "Test Failed: Timed out while waiting for expectation: NOT TOBEVISIBLE" };
  assert.equal(isInfraError(regression.error), false, "a Detox expectation timeout is not infrastructure");
  assert.ok(infraVerdict([regression, ...["a", "b", "c", "d", "e"].map((s) => missing(`${s}.e2e.ts`))]));
  assert.equal(infraVerdict([regression, regression, missing("a.e2e.ts")]), null, "one missing spec does not make the run infra");
});
test("decision matrix: unblock needs confidence plus a checkable citation; unknown citations are dropped", () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(11, 12)], [], undefined, 1);
  const pack = buildPack(f, [{ filename: "specs/a.spec.ts", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  const ok: Answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "recurs" };
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
test("a non-PR cause clears only with the evidence that cause requires; a related hunk never clears it", () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(11, 12)], [], undefined, 1);
  const pack = buildPack(f, [{ filename: "specs/a.spec.ts", patch: "@@" }], { number: 1, repository: "o/r", title: "", lane: "l" }, []);
  // The hunk is evidence the PR caused it: citing only that hunk while saying "not the PR" must keep the failure red.
  for (const cause of ["flaky_environment", "bug_on_master", "test_bug"] as const)
    assert.equal(decide("REGRESSION", { cause, confidence: 0.95, cited_evidence: ["hunk_0"], explanation: "x" }, pack).blocking, true, `${cause} with only the PR's hunk`);
  assert.equal(decide("REGRESSION", { cause: "test_bug", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" }, pack).blocking, true, "test_bug needs this_pr or producer evidence");
  assert.equal(decide("REGRESSION", { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" }, pack).blocking, false);
});
test("producer evidence supports a clear but never makes one alone: the PR's own CI wrote it", () => {
  const producer = fixture<Evidence>({ notes: "still waiting on: POST /api/v4/posts/6qgx/pin", images: [] });
  const alone = buildPack({ ...classify(failing, trunkPasses(8), [], undefined, 1), producer }, [], prCtx, []);
  assert.ok(evidenceIds(alone).includes("producer"), "the evidence is citable");
  for (const cause of ["flaky_environment", "test_bug", "bug_on_master"] as const)
    assert.equal(decide("REGRESSION", { cause, confidence: 0.99, cited_evidence: ["producer"], explanation: "x" }, alone).blocking, true, `${cause} on producer alone stays red`);
  assert.equal(canChange("REGRESSION", alone), false, "alone, it cannot change the outcome, so the model is not asked to clear on it");

  // The same evidence beside a citation the PR cannot write does support the clear.
  const beside = buildPack({ ...classify(failing, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1), producer }, [], prCtx, []);
  assert.equal(decide("REGRESSION", { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["producer", "cross_pr"], explanation: "x" }, beside).blocking, false);
});

test("the server's refusal to attach a file is an environment error; a failed app step is not", () => {
  assert.equal(isInfraError('Error: apiCreatePostWithImageAttachment: server did not attach file. post.file_ids=[], fileId=abc'), true);
  assert.equal(isInfraError('apiCreatePostWithImageAttachment: upload failed: {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/"}'), true);
  assert.equal(isInfraError("Test Failed: 10.0sec timeout expired without matching of given matcher: not null"), false);
  assert.equal(isInfraError("Error: expected the attachment to be shown after upload"), false);
});
test("the harness giving up on a test-server API call is an environment error; a UI wait that runs out is not", () => {
  // desktop master run 40398808902, MM-T5748: the harness aborted the call after 30 s.
  assert.equal(isInfraError("ApiRequestError: POST /api/v4/custom_profile_attributes/fields failed: 408 Request timed out after 30000ms"), true);
  assert.equal(isInfraError("TimeoutError: page.click: Timeout 30000ms exceeded."), false);
  assert.equal(isInfraError("Error: expect(locator).toBeVisible() failed: Timed out 10000ms waiting for expect"), false);
});
test("a server's own not-ready answer to the test's setup call is environment, even when the identity is unresolved", () => {
  // mattermost-mobile: {"id":"app.pap.is_ready.app_error","message":"Access control service is not ready."} from the server.
  const error = 'Error: {"id":"app.pap.is_ready.app_error","message":"Access control service is not ready."}';
  assert.equal(isInfraError(error), true);
  const cfg = { ...DEFAULTS, infraClears: true };
  const f = classify({ ...failing, error, identity_unresolved: true }, [...trunkPasses(8)], [], cfg, 1, null, {});
  assert.equal(f.class, "INFRA_ERROR", "the environment call is made before the identity check");
  assert.equal(f.blocking, false);
  // Without infra-clears (a server PR) the same failure is still named, and stays red.
  const strict = classify({ ...failing, error, identity_unresolved: true }, [...trunkPasses(8)], [], DEFAULTS, 1, null, {});
  assert.equal(strict.class, "INFRA_ERROR");
  assert.equal(strict.blocking, true);
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
test("judge asks up to 8 findings per call, caps the findings it sends and survives an outage", async () => {
  const make = () => Array.from({ length: 10 }, (_, i) => classify({ ...failing, title: `t${i}` }, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1));
  const packsOf = (findings: Finding[]) => findings.map((f) => buildPack(f, [], { number: 1, repository: "o/r", title: "", lane: "l" }, []));
  const answer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const sent: { n: number; model: string }[] = [];
  const findings = make();
  const ledger = newLedger();
  await judge(findings, packsOf(findings), async (packs, model) => {
    sent.push({ n: packs.length, model });
    return fixture<BatchResult>({ answers: packs.map(() => answer), usage: { input_tokens: 10000, output_tokens: 1000 } });
  }, { ...DEFAULTS, escalationModel: "", maxJudged: 8 }, () => {}, false, ledger);
  assert.deepEqual(sent, [{ n: 8, model: DEFAULTS.model }], "one call carries up to maxJudged findings");
  assert.equal(findings.filter((f) => f.decision === "adjudicator_unblock").length, 8);
  assert.equal(findings.slice(8).every((f) => f.blocking && !f.decision && f.ai?.skipped), true);
  assert.equal(ledger.skipped.cap, 2);
  assert.equal(ledger.calls[0].cost_usd, (10000 * 2 + 1000 * 10) / 1e6, "priced at Sonnet 5.5 list price");

  const down = make();
  await judge(down, packsOf(down), async () => { throw new Error("boom"); }, DEFAULTS, () => {});
  assert.equal(down.filter((f) => f.decision === "unavailable").length, 10, "an outage leaves every asked finding on the rules' outcome");
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
  const f: Finding = { ...classify({ ...failing, title: "a | b" }, trunkPasses(8), []), judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "recurs <x>" }, decision: "adjudicator_unblock", blocking: false };
  const c = summary({ verdict: "SUCCESS", findings: [f], infra: null, runURL: "u", counts: { failed: 1 } });
  assert.ok(c.startsWith("## E2E triage: ✅ none caused by this PR"));
  assert.ok(c.includes("a &#124; b") && c.includes("&lt;x&gt;"), "titles and the model's text are escaped");
});

test("a test name that looks like markup is shown as typed; an ordinary name is written exactly as before", () => {
  // A link, emphasis, an entity and an image in a title would render as live markup in the job summary.
  const rowOf = (title: string): string => {
    const c = summary({ verdict: "FAILURE", findings: [classify({ ...failing, title }, trunkPasses(8), [], undefined, 1)], infra: null, runURL: "u", counts: { failed: 1, passed: 9 } });
    return c.split("\n").find((line) => line.startsWith("| ") && line.includes(" · `a.spec.ts`")) ?? "";
  };
  const hostile = rowOf("[open](https://evil.example) *bold* &amp; ![img](x.png) _em_");
  assert.ok(hostile.startsWith("| \\[open\\](https://evil.example) \\*bold\\* \\&amp; !\\[img\\](x.png) \\_em\\_ · `a.spec.ts` |"), hostile);
  assert.doesNotMatch(hostile, /(^|[^\\])\[open\]/, "no bracket that could open a link");
  assert.ok(rowOf("channel_attributes works (default) & more").startsWith("| channel_attributes works (default) & more · `a.spec.ts` |"), "a name with no markup is unchanged");
});

const answerText = (over: Record<string, unknown> = {}): string => JSON.stringify({ answers: [{ id: "f1", cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x", ...over }] });

test("history is asked by run count, not by title or by window, and both queries are walked", async () => {
  const sent: HistoryBody[] = [];
  const responses = [
    // trunk query, paged
    { observations: [obs({ commit_sha: "p1", group_id: "g1" }), obs({ title: "some other test in the same file", commit_sha: "x", group_id: "g1" })], has_more: true },
    { observations: [obs({ commit_sha: "p2", group_id: "g2" })], has_more: false },
    // cross-PR query: repeats g1, and carries a row the trunk query cannot see
    { observations: [obs({ commit_sha: "p1", group_id: "g1" }), obs({ commit_sha: "p3", group_id: "g3", gh_pr_number: 7, status: "failed", created_at: "2026-09-11T00:00:00Z" })], has_more: false },
  ];
  const fetchImpl = fakeFetch([["/reports/history", (init) => { sent.push(parsed<HistoryBody>(bodyText(init))); return Response.json(responses[sent.length - 1]); }]]);
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
  const rows = history.get(identityKey(failing))!;
  assert.deepEqual(rows.map((o) => o.commit_sha), ["p3", "p1", "p2"], "g1 is counted once even though both queries returned it");
  // Rows for tests the caller never asked about are dropped.
  assert.equal(history.has(identityKey({ ...failing, title: "some other test in the same file" })), false);
  assert.equal(history.get(identityKey({ ...failing, title: "t2" })), undefined, "a title with no rows stays unknown, so it stays blocking");
});
// One history read: a timeout, a dropped connection or a 5xx answer is retried once; a 4xx is the answer.
test("a history read that fails in transit or answers 5xx is retried once, then its error is surfaced", async () => {
  const historyBody = (): Response => Response.json({ observations: trunkPasses(8) });
  const serverError = (): Response => Response.json({}, { status: 503 });
  const readHistory = (fetchImpl: FetchImpl) => fetchHistory(fetchImpl, "http://tsio", "o/r", [failing], "2026-09-11T00:00:00Z", DEFAULTS, null);
  const flaky503 = [serverError, historyBody];
  const once = fakeFetch([["/reports/history", () => flaky503.shift()!()]]);
  assert.equal((await readHistory(once)).get(identityKey(failing))?.length, 8);
  assert.equal(once.calls.length, 2, "one retry");
  const dropped = [() => { throw new TypeError("fetch failed"); }, historyBody];
  const retried = fakeFetch([["/reports/history", () => dropped.shift()!()]]);
  assert.equal((await readHistory(retried)).get(identityKey(failing))?.length, 8);
  assert.equal(retried.calls.length, 2, "a dropped connection is retried the same way");
  const down = fakeFetch([["/reports/history", serverError]]);
  await assert.rejects(() => readHistory(down), /TSIO history 503/);
  assert.equal(down.calls.length, 2, "a second 503 is the error, after one retry");
  const refused = fakeFetch([["/reports/history", () => Response.json({}, { status: 400 })]]);
  await assert.rejects(() => readHistory(refused), /TSIO history 400/);
  assert.equal(refused.calls.length, 1, "a client error is not retried");
});

test("deduplication never drops a row it cannot identify", async () => {
  // Rows from different runs, or without a group id, must not collapse into one run.
  const noIds = Array.from({ length: 6 }, (_, i) => { const o = obs({ commit_sha: `c${i}` }); delete o.group_id; return o; });
  const single = fakeFetch([["/reports/history", () => Response.json({ observations: noIds })]]);
  const one = await fetchHistory(single, "http://tsio", "o/r", [failing], "2026-09-17T00:00:00Z", DEFAULTS, null);
  assert.equal(one.get(identityKey(failing))!.length, 6, "one query cannot overlap itself, so nothing is deduplicated");

  const shared = [obs({ commit_sha: "a", group_id: "g1" }), obs({ commit_sha: "b", group_id: "g2" }), obs({ commit_sha: "c", group_id: "g3" })];
  const both = fakeFetch([["/reports/history", () => Response.json({ observations: shared })]]);
  const two = await fetchHistory(both, "http://tsio", "o/r", [failing], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  assert.equal(two.get(identityKey(failing))!.length, 3, "distinct runs survive the overlap between the two queries");
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
  const routes: Route[] = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const id: CompositeIdentity = { repository: "o/r", commit_sha: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1" };

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

  const canonical: TestRef = { file: tsioPath, title: "t", error: "e", repo_path: repoPath("e2e/specs", tsioPath) };
  const owned = classify(canonical, trunkPasses(8), changed, DEFAULTS, 5, null, { trunkBranch: "master" });
  assert.equal(owned.class, "OWNED_BY_PR", "the PR edited this spec, so it answers for it");
  assert.equal(owned.blocking, true);
});
test("an incomplete or empty run is not a passing run", async () => {
  const group = (over: Record<string, unknown> = {}) => ({ id: "g1", repository: "o/r", commit: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1", status: "completed", ...over });
  const id: CompositeIdentity = { repository: "o/r", commit_sha: "abc", name: "n", gh_run_id: "12", gh_run_attempt: "1" };
  const routes = (g: Record<string, unknown>, suites: unknown[], cases: unknown[], detail: Record<string, unknown> = g): Route[] => [
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
  const partial = await fetchRun(fakeFetch(routes(open, suite, cases, { ...open, reports: Array.from({ length: 28 }, () => ({})) })), "http://tsio", id, null, now);
  assert.equal(partial.failing.length, 1);
  assert.deepEqual(partial.missing, { expected: 30, received: 28, status: "in_progress" });
  assert.deepEqual(missingReports(partial.missing), { text: "2 of 30 reports never uploaded, so the specs on those workers never ran", short: "2 report(s) missing" });
  assert.equal(missingReports({ expected: null, received: null, status: "processing" })?.short, "results incomplete");

  // A late upload that completes the group while we wait is a complete run.
  const late = await fetchRun(fakeFetch(routes(open, suite, cases, { ...open, status: "completed" })), "http://tsio", id, null, now);
  assert.equal(late.missing, null);

  await assert.rejects(
    () => fetchRun(fakeFetch(routes(group(), suite, [])), "http://tsio", id, "e2e-on-windows"),
    /no test cases/, "a report with a matching suite but no cases is not a green run");
});
test("a run with missing reports is triaged but never comes out green", async () => {
  const routes = (statuses: StatusBody[]): Route[] => [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "in_progress", total_reports_expected: 3 }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g1/cases", () => Response.json(spec("t1", "failed"))],
    ["/reports/g1", () => Response.json({ id: "g1", status: "in_progress", total_reports_expected: 3, reports: [{}, {}] })],
    // Master fails it too, so on a complete run this would clear.
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ];
  const statuses: StatusBody[] = [];
  const dir = mkdtempSync(join(tmpdir(), "triage-missing-"));
  try {
    const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(routes(statuses)), log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.equal(result.findings[0].blocking, false, "the failure that did upload is still judged");
    assert.equal(result.verdict, "FAILURE", "the specs that never ran keep it red");
    assert.match(readFileSync(join(dir, "s.md"), "utf8"), /1 of 3 reports never uploaded, so the specs on those workers never ran; re-run the failed jobs/);
    const required = statuses.filter((s) => s.context === "e2e-test/playwright");
    assert.deepEqual(required.map((s) => [s.state, s.description]), [["failure", "(1 broken on main; 1 report(s) missing) 0% passed (0 passed, 1 failed, 0 skipped)"]]);
    assert.equal(statuses.filter((s) => s.context === "e2e-test/playwright/triage").at(-1)?.description, "1 failed → 1 broken on main · 1 report(s) missing");
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
  const pages: string[] = [];
  const api = async (_m: string, path: string): Promise<unknown> => {
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
  const rows = (extra: Partial<Observation>) => ({ observations: [obs({ commit_sha: "a", group_id: "g1", ...extra })] });

  // A server that identifies the report: the filter is sent, and rows that came
  // from a different report are dropped even if the server ignored it.
  const sent: HistoryBody[] = [];
  const good = fakeFetch([["/reports/history", (init) => {
    sent.push(parsed<HistoryBody>(bodyText(init)));
    return Response.json({ observations: [
      obs({ commit_sha: "mine", group_id: "g1", report_name: "e2e-on-windows-2022-1.0" }),
      obs({ commit_sha: "theirs", group_id: "g2", report_name: "e2e-on-ubuntu-latest-1.0" }),
    ] });
  }]]);
  const scoped = await fetchHistory(good, "http://tsio", "o/r", tests, "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows");
  assert.equal(sent[0].report, "e2e-on-windows", "the filter is sent to the server");
  assert.deepEqual(scoped.get(identityKey(failing))!.map((o) => o.commit_sha), ["mine"], "the other platform's row is dropped");
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
  const t: TestRef = { ...failing, full_title: "A > t1", report_scope: "e2e-on-windows" };
  const row = (over: Partial<Observation>) => obs({ full_title: "A > t1", suite_title: "A", report_name: "e2e-on-windows-2022-12.0", name: "desktop-master", ...over });
  const history = (rows: Observation[]) => fakeFetch([["/reports/history", () => Response.json({ observations: rows })]]);
  const trunk = [row({ group_id: "g1", commit_sha: "a" }), row({ group_id: "g2", commit_sha: "b" })];
  // A compatibility-matrix run puts one spec against several server versions in one group.
  const cmt = ["10.11", "11.10"].map((v) => row({ group_id: "cmt", name: "cmt-desktop", report_name: `e2e-on-windows-2022-${v}` }));

  const scoped = await fetchHistory(history([...trunk, ...cmt]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows", () => {}, laneOf("desktop-pr"));
  assert.equal(scoped.ambiguous.has(identityKey(t)), false, "the other lane's group is not this lane's evidence");
  assert.deepEqual(scoped.get(identityKey(t))!.map((o) => o.group_id).sort(), ["g1", "g2"]);

  // The same shape inside this lane still needs a narrower producer scope.
  const sameLane = cmt.map((o) => ({ ...o, name: "desktop-master" }));
  const inLane = await fetchHistory(history([...trunk, ...sameLane]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master", "e2e-on-windows", () => {}, laneOf("desktop-pr"));
  assert.equal(inLane.ambiguous.has(identityKey(t)), true);
});
test("a lane with nothing failed keeps its own status and writes no summary", async () => {
  // mattermost-mobile#10172: green lanes were rewritten as "0 failed (0 cleared by
  // triage)", and a lane red outside its tests would have been turned green. Their
  // "nothing failed" summaries also filled the run page with boxes to scroll past.
  // The lane's own status is green here: a red one with nothing failed has its own summary (see below).
  const statuses: StatusBody[] = [];
  const dir = mkdtempSync(join(tmpdir(), "triage-green-"));
  const summaryFile = join(dir, "s.md");
  await triage({
    env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryFile },
    fetchImpl: fakeFetch([
      ...runRoutes([spec("t1", "passed"), spec("t2", "passed")]),
      ["/commits/abc/statuses", () => Response.json([{ context: "e2e-test/playwright", state: "success", target_url: "https://github.com/o/r/actions/runs/12" }])],
      ["/reports/history", () => Response.json({ observations: [] })],
      ["/pulls/5/files", () => Response.json([])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
      ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
    ]),
    log: () => {},
  });
  assert.deepEqual(statuses, [], "nothing to triage, nothing written");
  assert.equal(existsSync(summaryFile), false, "no job summary for a lane with nothing failed");
  rmSync(dir, { recursive: true, force: true });
});

// Report only writes triage's line on the E2E check but never changes its state.
const keptRed = (statuses: StatusBody[]): boolean => statuses.length === 1 && statuses[0].context === "e2e-test/playwright" && statuses[0].state === "failure";
test("only an explicit, valid enforce mode changes the E2E check's state", async () => {
  const routes = (statuses: StatusBody[]): Route[] => [
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/issues/5/comments", (i) => (i.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ];
  for (const mode of [undefined, "", "report-only", "Enforce ", "enforced", "true", "ENFORCE_ME"]) {
    const statuses: StatusBody[] = [];
    const e: Env = { ...env, ANTHROPIC_API_KEY: "" };
    if (mode === undefined) delete e.MODE; else e.MODE = mode;
    await triage({ env: e, fetchImpl: fakeFetch(routes(statuses)), log: () => {} });
    // The failure is cleared, yet the check stays red: only its text changes.
    assert.ok(keptRed(statuses), `mode ${JSON.stringify(mode)} must keep the check red: ${JSON.stringify(statuses)}`);
  }
  // The one spelling that may.
  const written: StatusBody[] = [];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(routes(written)), log: () => {} });
  const required = written.filter((s) => s.context === "e2e-test/playwright");
  assert.equal(required.length, 1, "explicit enforce still writes exactly one required status");
  // Beside it, its own check: pending while triage works, then the verdict.
  assert.deepEqual(written.filter((s) => s.context === "e2e-test/playwright/triage").map((s) => [s.state, s.description]), [
    ["pending", "1 failed · triage is checking them"],
    ["success", "1 failed → 1 broken on main"],
  ]);
  assert.ok(written.findIndex((s) => s.state === "pending") < written.findIndex((s) => s.context === "e2e-test/playwright"), "the triage check goes pending first");

  // A triage that crashes says so on its check and leaves the E2E result alone.
  const crashed: StatusBody[] = [];
  const broken = routes(crashed).map(([path, h]): Route => (path === "/reports/history" ? [path, () => { throw new Error("history down"); }] : [path, h]));
  await assert.rejects(triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(broken), log: () => {} }));
  assert.deepEqual(crashed.map((s) => [s.context, s.state]), [["e2e-test/playwright/triage", "pending"], ["e2e-test/playwright/triage", "error"]]);

  // TRIAGE_CONTEXT=off posts only the required status.
  const quiet: StatusBody[] = [];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(routes(quiet)), log: () => {} });
  assert.deepEqual(quiet.map((s) => s.context), ["e2e-test/playwright"]);
});
test("the step log has one line per finding: its class, decision, the model's cause and confidence, and what it cited", async () => {
  const logs: string[] = [];
  const routes: Route[] = [
    ...runRoutes([spec("t1", "failed"), spec("t2", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
    ["/pulls/5/files", () => Response.json([])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", () => Response.json({})],
  ];
  await triage({ env: { ...env, ANTHROPIC_API_KEY: "", TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(routes), log: (m) => logs.push(m) });
  const lines = logs.filter((l) => l.startsWith("e2e-test-triage: finding"));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^e2e-test-triage: finding 1\/2 blocking REGRESSION decision=- ai=- cited=- "t1" · specs\/a\.spec\.ts: Fails here/);
  const judged = findingLogLine(finding({ title: "t3", class: "REGRESSION", blocking: false, decision: "adjudicator_unblock", judge: { cause: "flaky_environment", confidence: 0.91, cited_evidence: ["cross_pr", "this_pr"], explanation: "x" } as Finding["judge"] }), 1, 1, []);
  assert.match(judged, /^e2e-test-triage: finding 1\/1 cleared REGRESSION decision=adjudicator_unblock ai=flaky_environment@0\.91 cited=cross_pr,this_pr "t3"/);
  assert.ok(findingLogLine(finding({ title: "x".repeat(900) }), 1, 1, []).length <= 500, "one line, bounded");
});
test("a failure history can't explain is a likely regression only when the PR touches it", async () => {
  const routes = (files: unknown[], error?: string): Route[] => [
    ...runRoutes([spec("t1", "failed").map((row) => (error ? { ...row, error_message: error } : row))]),
    ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
    ["/pulls/5/files", () => Response.json(files)],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", () => Response.json({})],
  ];
  const run = async (files: unknown[], error?: string) => {
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
  assert.match(untouched.summary, /### Needs a look \(1\)/);
  assert.match(untouched.summary, /\| Passes on master \(16 of 16 runs\), no other PR fails it this way, and this PR doesn't change it or a file its error names\. \| Read the error before re-running\. \|/);
  assert.match(untouched.summary, /\| Does this PR change a file its error names\? \| No \|/);
  assert.doesNotMatch(untouched.summary, /likely regression/);

  // A plain word of the error's prose ("expected visible") does not name src/visible.ts.
  const prose = await run([{ filename: "src/visible.ts", patch: "@@" }]);
  assert.match(prose.summary, /### Needs a look \(1\)/);

  // A changed file the error names (its test id server_form) keeps the old wording.
  const named = await run([{ filename: "app/screens/server_form.tsx", patch: "@@" }], "Error: expected server_form to be visible");
  assert.equal(named.result.findings[0].class, "REGRESSION");
  assert.match(named.summary, /### Your PR \(1\)[^#]*\| Passes on master \(16 of 16 runs\), and this PR changes a file its error names\. \| Check your change to that file\. \|/);
  assert.match(named.summary, /\| Does this PR change a file its error names\? \| Yes \|/);
});
test("one triage check for the whole PR summarises every lane", async () => {
  // Lane statuses carry only the state and description the lane summary reads.
  const st = (state: string, description: string): CommitStatus => fixture<CommitStatus>({ state, description });
  const lanes = (rows: Record<string, CommitStatus | null>) => laneSummary(Object.entries(rows).map(([context, status]) => ({ context, status })));
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("failure", "590 passed, 7 failed, 41 skipped"), "e2e-test/maestro-ios": st("pending", "running") }),
    { state: "pending", description: "Triage is checking: waiting for maestro-ios" }, "a running lane keeps it pending; terminal failures remain red");
  assert.deepEqual(lanes({
    "e2e-test/detox-ios": st("failure", "590 passed, 7 failed (2 cleared by triage, 5 unresolved), 41 skipped"),
    "e2e-test/maestro-ios": st("success", "6 passed, 1 failed (1 cleared by triage), 1 skipped"),
    "e2e-test/detox-ipad": st("success", "19 passed, 0 skipped"),
    "e2e-test/maestro-android": null,
  }), { state: "failure", description: "detox-ios: 2 not caused by PR, 5 to check · maestro-ios cleared by triage" });
  // mattermost#38601: every failure cleared, but two runners timed out without a report.
  assert.deepEqual(lanes({ "e2e-test/playwright-full/enterprise": st("failure", "1119 passed, 26 failed (26 cleared by triage), 118 skipped; 2 report(s) missing") }),
    { state: "failure", description: "playwright-full/enterprise: 26 not caused by PR, 2 report(s) missing, re-run" });
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("failure", "49 passed, 132 failed (not triaged, investigation required), 29 skipped") }),
    { state: "failure", description: "detox-ios: many failures in one run" });
  assert.deepEqual(lanes({ "e2e-test/detox-android": st("failure", "(49 cleared by triage, 4 unresolved; investigation required) 91.3% passed (555 passed, 53 failed, 42 skipped)") }),
    { state: "failure", description: "detox-android: 49 not caused by PR, 4 to check, many failures in one run" });
  assert.deepEqual(lanes({ "e2e/linux": st("failure", "10 passed, 2 failed (not triaged: triage could not finish)") }),
    { state: "failure", description: "linux: triage could not finish" });
  assert.deepEqual(lanes({ "e2e-test/maestro-ios": st("success", "6 passed, 1 failed (1 cleared by triage), 1 skipped"), "e2e-test/detox-ios": st("success", "597 passed, 0 failed (0 cleared by triage)") }),
    { state: "success", description: "maestro-ios cleared by triage · all lanes green" });
  assert.deepEqual(lanes({ "e2e/linux": st("success", "235 passed, 0 failed") }), { state: "success", description: "All lanes green" });

  // Through triage(): this lane's verdict is written, then the PR-wide check from every lane.
  const written: StatusBody[] = [];
  const lane = "e2e-test/playwright";
  const statuses = () => [...written].reverse();
  const routes: Route[] = [
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/commits/abc/statuses", () => Response.json([...statuses(), { context: lane, state: "failure", target_url: "https://github.com/o/r/actions/runs/12" }, { context: "e2e-test/other", state: "success", description: "10 passed" }])],
    ["/statuses/abc", (i) => { written.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ];
  await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", STATUS_CONTEXT: lane, TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: `${lane}, e2e-test/other`, TRIAGE_SETTLE_MS: "0" }, fetchImpl: fakeFetch(routes), log: () => {} });
  assert.deepEqual(written.map((s) => [s.context, s.state, s.description]), [
    ["e2e-test/triage", "pending", "Triage is checking playwright"],
    [lane, "success", "(1 broken on main) 0% passed (0 passed, 1 failed, 0 skipped)"],
    ["e2e-test/triage", "success", "playwright cleared by triage · all lanes green"],
  ]);
});
test("skipped history rows are not trunk runs", () => {
  const skipped = (n: number): Observation[] => Array.from({ length: n }, (_, i) => obs({ commit_sha: `s${i}`, status: "skipped", created_at: "2026-09-11T00:00:00Z" }));
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
  const row = (suite: string, title: string, status: string, retry: number) => ({ ...caseRow(title, status, retry, suite), full_title: `a.spec.ts > a > ${title}` });
  const cases = [
    row("w14", "retested", "failed", 0), row("w14", "retested", "failed", 1), row("w3", "retested", "passed", 0),
    row("w14", "broken", "failed", 0), row("w3", "broken", "failed", 0),
  ];
  const routes: Route[] = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const run = await fetchRun(fakeFetch(routes), "http://tsio", parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY));
  assert.deepEqual(run.counts, { total: 2, passed: 1, failed: 1, flaky: 1, skipped: 0 });
  assert.deepEqual(run.failing.map((f) => [f.title, f.identity_unresolved]), [["broken", false]]);

  // A report scope declares reports to be separate lanes, so they stay apart --
  // and one scope covering both is ambiguous rather than merged.
  const scoped = await fetchRun(fakeFetch(routes), "http://tsio", parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY), "dispatch-run-");
  assert.equal(scoped.counts.total, 4);
  assert.ok(scoped.failing.every((f) => f.identity_unresolved));
});
test("history counts runs, not attempts", async () => {
  const t: TestRef = { ...failing, full_title: "A > t1" };
  const row = (over: Partial<Observation>) => obs({ full_title: "A > t1", suite_title: "A", name: "playwright-full", ...over });
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
  assert.deepEqual(history.get(identityKey(t))!.map((o) => [o.group_id, o.status]).sort(), [["g1", "flaky"], ["g2", "failed"], ["g3", "passed"]]);
});
test("a retest on the same worker is not a second test when history rows carry their ordinal", async () => {
  // mattermost group 01a17502 (PR 39408): the banner test failed twice on worker chrome-26 (ordinals 5 and 6), and its
  // retest unit passed on chrome-26 at retry 0 (ordinal 37). Without the ordinal the retest has the first attempt's key.
  const t: TestRef = { ...failing, full_title: "A > t1" };
  const row = (over: Partial<Observation>) => obs({ full_title: "A > t1", suite_title: "A", name: "playwright-full", report_name: "chrome-26", ...over });
  const rows = [
    row({ group_id: "g1", status: "failed", retry_count: 0, ordinal: 5 }),
    row({ group_id: "g1", status: "failed", retry_count: 1, ordinal: 6 }),
    row({ group_id: "g1", status: "passed", retry_count: 0, ordinal: 37 }),
    row({ group_id: "g2", status: "passed", retry_count: 0, ordinal: 4 }),
  ];
  const history = await fetchHistory(fakeFetch([["/reports/history", () => Response.json({ observations: rows })]]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  assert.equal(history.ambiguous.has(identityKey(t)), false);
  assert.deepEqual(history.get(identityKey(t))!.map((o) => o.group_id).sort(), ["g1", "g2"], "both runs are history, each once");
  const unordered = rows.map(({ ordinal: _ordinal, ...o }) => o);
  const blind = await fetchHistory(fakeFetch([["/reports/history", () => Response.json({ observations: unordered })]]), "http://tsio", "o/r", [t], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  assert.equal(blind.ambiguous.has(identityKey(t)), true, "without ordinals it cannot be told from two tests sharing a name, so it fails closed");
});
test("a run's duplicate executions at one retry level cannot hide a fail; a pass on a later retry still excuses it", async () => {
  // mattermost-mobile: one spec reported by two suites of one group, both at retry 0: one passed, one failed.
  const suites = [
    { id: "s1", file_path: "specs/a.spec.ts", title: "A", report_name: "detox-ios" },
    { id: "s2", file_path: "specs/a.spec.ts", title: "A", report_name: "detox-ios" },
  ];
  const cases = [
    { suite_id: "s1", title: "t1", full_title: "A > t1", status: "passed", retry_count: 0, ordinal: 496, error_message: null, error_stack: null },
    { suite_id: "s2", title: "t1", full_title: "A > t1", status: "failed", retry_count: 0, ordinal: 496, error_message: "boom", error_stack: null },
    // A genuine retry: failed on the first try, passed on the second, both in one suite.
    { suite_id: "s1", title: "t2", full_title: "A > t2", status: "failed", retry_count: 0, ordinal: 497, error_message: "boom", error_stack: null },
    { suite_id: "s1", title: "t2", full_title: "A > t2", status: "passed", retry_count: 1, ordinal: 497, error_message: null, error_stack: null },
  ];
  const routes: Route[] = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "mobile-pr-detox-ios", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites })],
    ["/reports/g1/cases", () => Response.json(cases)],
  ];
  const id: CompositeIdentity = { repository: "o/r", commit_sha: "abc", name: "mobile-pr-detox-ios", gh_run_id: "12", gh_run_attempt: "1" };
  const run = await fetchRun(fakeFetch(routes), "http://tsio", id);
  assert.deepEqual(run.failing.map((f) => f.full_title), ["A > t1"], "the duplicate fail is a fail");
  assert.equal(run.outcomes.get(JSON.stringify(["specs/a.spec.ts", "t2"])), "flaky", "a fail on the first try and a pass on the retry is flaky");
});
// mattermost-mobile#10172: a shared setup broke; tests too new for history fail with the same error.
const setupError = (line: number): string => `TypeError: Cannot read properties of undefined (reading 'id') at Object.<anonymous> (/home/runner/work/m/channel_attributes.e2e.ts:${line}:80) at processTicksAndRejections (node:internal/process/task_queues:104:5)`;
const finding = (over: Partial<Finding>): Finding => fixture<Finding>({
  file: "detox/channel_attributes.e2e.ts", title: "t", class: "FLAKY_CROSS_PR", blocking: false, reason: "Failed on 4 other PRs.", error: setupError(219),
  trunk: { runs: 7, fails: 0, flaky: 0, passes: 7, latest: "passed" }, cross_pr: { prs: [1, 2, 3, 4], examples: [], passes: 0 },
  failure_signatures: [errorSignature(setupError(1))!],
  ...over,
});

// mattermost-mobile#10017: other PRs failed leave_call with a different error (login setup).
const leaveCall = (over: Partial<TestRef>): TestRef => ({ ...failing, file: "flows/calls/leave_call.yml", title: "leave_call", error: "Assertion is false: id: tab_bar.home.tab is visible", ...over });
const otherPR = (n: number, error: string): Observation => obs({ file: "flows/calls/leave_call.yml", title: "leave_call", gh_pr_number: n, branch: `pr-${n}`, status: "failed", error_excerpt: error });
test("another PR's failure counts only when it failed with the same error", () => {
  const green = trunkPasses(20).map((o) => ({ ...o, file: "flows/calls/leave_call.yml", title: "leave_call" }));
  const setup = ["Assertion is false: id: server_form.display_help is not visible", "Element not found: Text matching regex: Display Name", "Assertion is false: id: server_form.server_url.input is visible"];
  const unrelated = classify(leaveCall({}), [...green, ...setup.map((e, i) => otherPR(20 + i, e))], [], undefined, 9);
  assert.equal(unrelated.class, "REGRESSION", "three different failures are not this failure");
  assert.deepEqual(unrelated.cross_pr.prs, []);
  assert.deepEqual(unrelated.cross_pr.examples, [], "the judge is not shown them as recurrences either");

  const same = classify(leaveCall({}), [...green, ...[20, 21, 22].map((n) => otherPR(n, "Assertion is false: id: tab_bar.home.tab is visible"))], [], undefined, 9);
  assert.equal(same.class, "FLAKY_CROSS_PR");
  assert.match(same.reason, /^Failed with the same error on 3 other PRs/);

  // A bare timeout names no failure: it counts only with other bare timeouts, never with a distinctive error (owner decision B).
  const timeout = 'thrown: "Exceeded timeout of 300000 ms for a test.';
  const withErrors = classify(leaveCall({ error: timeout }), [...green, ...setup.map((e, i) => otherPR(20 + i, e))], [], undefined, 9);
  assert.equal(withErrors.class, "REGRESSION", "a bare timeout is not the same failure as an assertion");
  const withTimeouts = classify(leaveCall({ error: timeout }), [...green, ...[20, 21, 22].map((n) => otherPR(n, timeout))], [], undefined, 9);
  assert.equal(withTimeouts.class, "FLAKY_CROSS_PR");
  assert.match(withTimeouts.reason, /^Failed with the same bare timeout on 3 other PRs/);
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
  const judged: Finding = { ...blocked, judge: { cause: "flaky_environment", confidence: 0.5, cited_evidence: [], explanation: "unsure" } };
  const comment = summary({ context: "c", verdict: "SUCCESS", findings: [anchor, judged], infra: null, model: "m", runURL: "u", counts: { failed: 2 } });
  assert.match(comment, /### Flaky \(2\)/);
  assert.match(comment, /\| Same error as "MM-T6301_1", cleared above\. \| Nothing for you\. \|/);
  assert.match(comment, /\| Same failure as \| MM-T6301_1 \|/);
  assert.doesNotMatch(comment, /agreed/);
});
test("the same-failure rule needs the same spec, a specific error and an anchor history cleared", () => {
  const blocked = (over: Partial<Finding>) => finding({ title: "new", class: "REGRESSION", blocking: true, error: setupError(500), ...over });
  const stays = (findings: Finding[], why: string) => assert.equal(sameFailure(findings).at(-1)!.blocking, true, why);
  stays([finding({ file: "detox/other.e2e.ts" }), blocked({})], "another spec is another cause");
  stays([finding({ error: "TypeError: Cannot read properties of undefined (reading 'name')" }), blocked({})], "another error is another cause");
  const timeout = 'thrown: "Exceeded timeout of 300000 ms for a test.';
  stays([finding({ error: timeout }), blocked({ error: timeout })], "two timeouts are not one failure");
  stays([finding({ class: "SAME_FAILURE_AS_CLEARED" }), blocked({})], "only history anchors; a cleared follower does not");
  stays([finding({ class: "REGRESSION", blocking: false, decision: "adjudicator_unblock" }), blocked({})], "a judge's clear is not history");
  stays([finding({ judge: fixture<Answer>({ cause: "caused_by_pr", confidence: 0.6 }) }), blocked({})], "an anchor the judge tied to the PR anchors nothing");
  // desktop#4020, an Electron upgrade: MM-T804 cleared on two flaky passes in 39
  // trunk runs and never failed there, so nothing shows its error is anyone else's.
  stays([finding({ class: "FLAKY_ON_TRUNK", failure_signatures: [] }), blocked({})], "an anchor whose history never failed this way proves nothing about this error");
  stays([finding({ failure_signatures: ["TypeError: Cannot read properties of undefined (reading 'name')"] }), blocked({})], "history that failed differently is not this error's");
  stays([finding({}), blocked({ judge: fixture<Answer>({ cause: "caused_by_pr", confidence: 0.6 }) })], "a failure the judge tied to the PR does not follow");
  stays([finding({}), blocked({ identity_unresolved: true })], "history that cannot name the test clears nothing");
  stays([finding({}), blocked({ decision: "evidence_incomplete" })], "incomplete evidence clears nothing");
  stays([finding({}), blocked({ class: "OWNED_BY_PR" })], "a spec the PR edits stays the PR's");
});
test("the same-failure rule runs on PR runs only", async () => {
  // Two tests, one spec, one setup error. t1 failed on three other PRs; t2 is new.
  const routes = (pr: boolean) => {
    const identity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full", branch: pr ? "pr-5" : "master", ...(pr ? { gh_pr_number: 5 } : {}) };
    const row = (title: string, line: number) => ({ ...caseRow(title, "failed"), error_message: setupError(line) });
    const crossPRs = [5, 6, 7, 8].filter((n) => n !== 5 || !pr).slice(0, 3).map((n) => obs({ title: "t1", gh_pr_number: n + 10, status: "failed", branch: `pr-${n}`, error_excerpt: setupError(40 + n) }));
    return {
      identity,
      fetch: fakeFetch([
        ...runRoutes([[row("t1", 219)], [row("t2", 380)]]),
        ["/reports/history", () => Response.json({ observations: [...trunkPasses(8).map((o) => ({ ...o, title: "t1" })), ...crossPRs, ...trunkPasses(2).map((o) => ({ ...o, title: "t2" }))] })],
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
  const row = (title: string, line: number) => ({ ...caseRow(title, "failed"), error_message: setupError(line) });
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
const PNG = (fill = 0): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, fill)]);
const timeoutTest = { file: "detox/e2e/test/products/channels/smoke_test/messaging.e2e.ts", title: "MM-T4786_4 - pin a message", full_title: "Smoke Test - Messaging MM-T4786_4 - pin a message" };
const busyNotes = 'Detox reported the app busy 9 times; still waiting on: Network Request "https://site-1/api/v4/posts/6qgx/pin"';
function evidenceDir(entries: unknown[], files: Record<string, Buffer | string> = {}): string {
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
  const warnings: string[] = [];
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
  const e: Evidence = { file: "e2e/test/products/channels/smoke_test/messaging.e2e.ts", title: timeoutTest.title, full_title: timeoutTest.full_title, notes: "n", images: [] };
  assert.equal(evidenceFor(timeoutTest, [e]), e, "a path relative to a different root still matches on its tail");
  assert.equal(evidenceFor({ ...timeoutTest, full_title: "Another describe " + timeoutTest.title }, [e]), null);
  assert.equal(evidenceFor({ ...timeoutTest, file: "detox/e2e/test/other.e2e.ts" }, [e]), null);
  assert.equal(evidenceFor({ ...timeoutTest, file: "x" + timeoutTest.file }, [{ ...e, file: "messaging.e2e.ts" }]), null, "a bare file name is not a path tail");
});
test("a dangling link or a link out of the evidence directory is skipped with a warning; the rest still loads", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-json-"));
  writeFileSync(join(outside, "other.json"), JSON.stringify([{ file: timeoutTest.file, title: "from outside", notes: "not the PR's to write" }]));
  const dir = evidenceDir([{ ...timeoutTest, notes: busyNotes, images: [] }]);
  symlinkSync(join(outside, "gone.json"), join(dir, "shard-1", "dangling.json"));
  symlinkSync(join(outside, "other.json"), join(dir, "shard-1", "linked.json"));
  symlinkSync(outside, join(dir, "shard-1", "linked-dir"));
  const warnings: string[] = [];
  try {
    const evidence = loadEvidence(dir, (w) => warnings.push(w));
    assert.deepEqual(evidence.map((e) => e.title), [timeoutTest.title], "the entries beside the bad links load; nothing from outside is read");
    assert.ok(warnings.some((w) => /dangling link/.test(w) && /dangling\.json/.test(w)));
    assert.equal(warnings.filter((w) => /links outside the evidence directory/.test(w)).length, 2, "a file link and a directory link are both refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("end to end: a timeout the judge clears from the screenshot the run recorded", async () => {
  const dir = evidenceDir([{ ...timeoutTest, notes: busyNotes, images: ["timeout.png"] }], { "shard-1/timeout.png": PNG(7) });
  const identity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "mobile-pr-detox-ios", branch: "pr-5", gh_pr_number: 5 };
  const sent: MessageBody[] = [];
  const answer = { cause: "flaky_environment" as const, confidence: 0.9, explanation: "Stuck on a pin request to the test server; the diff only touches CI." };
  // crossPRs: two other PRs failed this test the same way, so cross_pr is there to cite.
  const routes = ({ crossPRs = false, cited = ["producer"] }: { crossPRs?: boolean; cited?: string[] } = {}): Route[] => [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: identity.name, gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: timeoutTest.file }] })],
    ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: timeoutTest.title, full_title: timeoutTest.full_title, status: "failed", retry_count: 0, ordinal: 0, error_message: 'thrown: "Exceeded timeout of 300000 ms for a test.', error_stack: null }])],
    ["/reports/history", () => Response.json({ observations: [
      ...trunkPasses(25).map((o) => ({ ...o, file: timeoutTest.file, title: timeoutTest.title, full_title: timeoutTest.full_title, name: "mobile-main-detox-ios" })),
      // The other PRs failed this test the same way: the same bare timeout.
      ...(crossPRs ? [31, 32].map((n) => ({ ...obs({ gh_pr_number: n, status: "failed", commit_sha: `x${n}`, error_excerpt: 'thrown: "Exceeded timeout of 300000 ms for a test.' }), file: timeoutTest.file, title: timeoutTest.title, full_title: timeoutTest.full_title, name: "mobile-pr-detox-ios", branch: `pr-${n}` })) : []),
    ] })],
    ["/pulls/5/files", () => Response.json([{ filename: ".github/workflows/e2e.yml", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "ci only", base: { ref: "main" } })],
    ["api.anthropic.com", (init) => {
      sent.push(parsed<MessageBody>(bodyText(init)));
      return modelReply(init, { ...answer, cited_evidence: cited });
    }],
  ];
  const base = { ...env, MODE: "report-only", COMPOSITE_IDENTITY: JSON.stringify(identity) };
  try {
    const result = await triage({ env: { ...base, EVIDENCE_DIR: dir }, fetchImpl: fakeFetch(routes({ crossPRs: true, cited: ["producer", "cross_pr"] })), log: () => {} });
    const [label, image, text] = partsOf(sent[0].messages[0].content);
    assert.equal(label.text, "Screenshots recorded for f1:");
    assert.deepEqual([image.type, image.source?.media_type, image.source?.data], ["image", "image/png", PNG(7).toString("base64")], "the screenshot goes before the evidence, as an image");
    assert.match(text.text ?? "", /"valid_evidence_ids":\[[^\]]*"producer"/);
    assert.match(text.text ?? "", /posts\/6qgx\/pin/);
    assert.equal(result.findings[0].decision, "adjudicator_unblock");
    assert.equal(result.verdict, "SUCCESS");

    // The screenshot alone clears nothing: the PR's own CI recorded it, so the model's clear must also cite evidence the PR cannot write.
    sent.length = 0;
    const alone = await triage({ env: { ...base, EVIDENCE_DIR: dir }, fetchImpl: fakeFetch(routes({ crossPRs: true, cited: ["producer"] })), log: () => {} });
    assert.equal(sent.length, 1);
    assert.equal(alone.findings[0].blocking, true, "producer alone never clears");
    assert.notEqual(alone.findings[0].decision, "adjudicator_unblock");
    assert.equal(alone.verdict, "FAILURE");

    // Without evidence there is nothing the model could cite to clear it. It is
    // still asked, for advice the summary shows; the outcome stays the rules'.
    sent.length = 0;
    const without = await triage({ env: base, fetchImpl: fakeFetch(routes()), log: () => {} });
    assert.equal(sent.length, 1);
    assert.equal(without.findings[0].blocking, true);
    assert.equal(without.findings[0].decision, "advice");
    assert.equal(without.findings[0].judge?.cause, "flaky_environment");
    assert.equal(without.verdict, "FAILURE");
    const summaryText = summary({ context: "c", verdict: without.verdict, findings: without.findings, infra: null, model: "m", runURL: "u", counts: { failed: 1, passed: 0, skipped: 0 }, ai: without.ai });
    assert.match(summaryText, /\| Looks flaky or environment \(AI, 90% sure\), but not sure enough to clear\. \| Read the error before re-running\. \|/);
    assert.match(summaryText, /\| Decided by \| Rules; AI asked \|/);
    assert.match(summaryText, /90% sure, but with nothing it could point to, so it can't clear/, "advice is never read as a clear");

    // With advice off, it is not asked at all.
    sent.length = 0;
    const off = await triage({ env: { ...base, AI_ADVICE: "false" }, fetchImpl: fakeFetch(routes()), log: () => {} });
    assert.equal(sent.length, 0);
    assert.equal(off.ai.skipped.no_effect, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------- AI spend

const ok = (answer: Answer) => async (packs: Pack[], _model?: string): Promise<BatchResult> => ({ answers: packs.map(() => answer), usage: { input_tokens: 3000, output_tokens: 200 }, served_model: DEFAULTS.model });
const flakyAnswer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "recurs elsewhere" };

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
  await judge(findings, findings.map((f) => buildPack(f, ci, prCtx, [])), async () => { calls++; return fixture<BatchResult>({}); }, { ...DEFAULTS, advise: false }, () => {}, false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.no_effect, 2);
  assert.deepEqual(findings.map((f) => f.blocking), [false, true], "the rules' outcome stands");

  // With advice on, only the blocked one is asked, and even a confident "flaky" leaves it blocking.
  const again = [classify(failing, [obs({ status: "failed" }), ...trunkPasses(8)], [], undefined, 1), classify(failing, trunkPasses(8), [], undefined, 1)];
  const asked: string[][] = [];
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
  const sent: number[] = [];
  await judge(findings, findings.map((f) => buildPack(f, [], prCtx, [])), async (packs, model) => { sent.push(packs.length); return ok(flakyAnswer)(packs, model); }, { ...DEFAULTS, escalationModel: "" }, () => {}, false, ledger);
  assert.deepEqual(sent, [1]);
  assert.equal(ledger.skipped.duplicate, 2);
  assert.equal(findings.every((f) => f.decision === "adjudicator_unblock"), true, "each is decided against its own evidence");
  assert.ok(Math.abs(findings.reduce((n, f) => n + (f.ai?.cost_usd ?? 0), 0) - (ledger.calls[0].cost_usd ?? NaN)) < 1e-12, "the call's cost is split across the tests it answered");
});

test("an answer already given for the same evidence is reused, not paid for again", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const pack = buildPack(f, [], prCtx, []);
  const kept: Answer = { ...flakyAnswer, provenance: { served_model: DEFAULTS.model } };
  const cfg = { ...DEFAULTS, escalationModel: "", answers: { [answerKey(DEFAULTS.model, pack)]: kept } };
  let calls = 0;
  const ledger = newLedger();
  await judge([f], [pack], async () => { calls++; return fixture<BatchResult>({}); }, cfg, () => {}, false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.cached, 1);
  assert.equal(f.decision, "adjudicator_unblock");
});

test("a cached answer that does not parse, or was kept without the model that gave it, is asked again", async () => {
  // An entry that would throw used to abort every later run; an old-shape entry cannot say who answered.
  const unparseable = { cause: "vibes", confidence: 0.9, cited_evidence: [], explanation: "x", provenance: { served_model: DEFAULTS.model } };
  const oldShape = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "kept before the model was recorded" };
  for (const [label, entry] of [["unparseable", unparseable], ["old shape", oldShape]] as const) {
    const g = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    const pack = buildPack(g, [], prCtx, []);
    let calls = 0;
    await judge([g], [pack], async (packs, model) => { calls++; return ok(flakyAnswer)(packs, model); }, { ...DEFAULTS, escalationModel: "", answers: { [answerKey(DEFAULTS.model, pack)]: entry } }, () => {}, false, newLedger());
    assert.equal(calls, 1, `${label}: asked again`);
    assert.equal(g.decision, "adjudicator_unblock", `${label}: decided on the fresh answer`);
  }
});

test("a cached answer keeps the model that gave it, so the summary names it as it does a fresh answer", async () => {
  const served = "claude-sonnet-5-5-20260915";
  const kept: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "recurs on PR 31", provenance: { requested_model: DEFAULTS.model, served_model: served, temperature: null, pack_hash: "0".repeat(64) } };
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const pack = buildPack(f, [], prCtx, []);
  let calls = 0;
  await judge([f], [pack], async () => { calls++; return fixture<BatchResult>({}); }, { ...DEFAULTS, escalationModel: "", answers: { [answerKey(DEFAULTS.model, pack)]: kept } }, () => {}, false, newLedger());
  assert.equal(calls, 0, "answered before, so not asked again");
  const c = renderSummary({ verdict: "SUCCESS", findings: [f], infra: null, runURL: "u", counts: { failed: 1, passed: 9 } });
  assert.match(c, /\| Decided by \| AI \(sonnet-5-5-20260915\) \|/);
  assert.doesNotMatch(c, /AI \(\)/);

  // What a fresh answer stores includes the model that gave it, so the next run can name it.
  const store: Record<string, Answer> = {};
  const g = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const api = fakeFetch([["api.anthropic.com", (init) => modelReply(init, flakyAnswer)]]);
  await judge([g], [buildPack(g, [], prCtx, [])], (packs, model) => askModelBatch(api, "k", model, packs), { ...DEFAULTS, escalationModel: "", answers: store }, () => {}, false, newLedger());
  const [entry] = Object.values(store);
  assert.equal(entry.provenance?.served_model, DEFAULTS.model);
  assert.equal(g.judge?.provenance?.served_model, DEFAULTS.model);
});

test("a call that could cross the run budget is not made", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  let calls = 0;
  const ledger = newLedger();
  const warnings: string[] = [];
  await judge([f], [buildPack(f, [], prCtx, [])], async () => { calls++; return fixture<BatchResult>({}); }, { ...DEFAULTS, budgetUsd: 0.0001 }, (w) => warnings.push(w), false, ledger);
  assert.equal(calls, 0);
  assert.equal(ledger.skipped.budget, 1);
  assert.equal(f.blocking, true, "over budget, the failure stays red");
  assert.match(warnings[0], /run budget/);
});

test("a call whose cost cannot be bounded is not made: unpriced model, unknown spend, a budget that is not a number", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const judgeOnce = (cfg: Partial<Config>, ledger = newLedger()) => {
    const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    return judge([f], [buildPack(f, [], prCtx, [])], async () => { calls++; return fixture<BatchResult>({ answers: [], usage: null }); }, { ...DEFAULTS, escalationModel: "", ...cfg }, (w) => warnings.push(w), false, ledger).then(() => f);
  };
  const unpriced = await judgeOnce({ model: "claude-unpriced-9-9" });
  assert.equal(calls, 0, "no price, so no bound on what the call costs");
  assert.match(warnings[0], /has no price/);
  assert.equal(unpriced.blocking, true);

  const nan = await judgeOnce({ budgetUsd: Number.NaN });
  assert.equal(calls, 0, "a budget that is not a number allows nothing");
  assert.match(warnings[1], /is not an amount of 0 or more/);
  assert.equal(nan.blocking, true);

  const spentUnknown = newLedger();
  spentUnknown.calls.push(fixture<CallRecord>({ model: DEFAULTS.model, usage: null, cost_usd: null }));
  await judgeOnce({}, spentUnknown);
  assert.equal(calls, 0, "spend that is not known cannot be added to");
  assert.match(warnings[2], /cost is unknown/);
});

test("a response that is not used is still billed: it is recorded with its cost, and it is never retried", async () => {
  const billed: Usage = { input_tokens: 4000, output_tokens: 900 };
  // Cut off: the answer is not used, the tokens were paid for, and the same request would be cut off again.
  let cutOff = 0;
  const truncated = async (_url: string | null, init?: RequestInit): Promise<Response> => {
    cutOff++;
    return Response.json({ model: parsed<MessageBody>(bodyText(init)).model, stop_reason: "max_tokens", usage: billed, content: [{ type: "text", text: "{" }] });
  };
  const cut = await askOne(truncated, DEFAULTS.model).catch((e: Error & { usage?: Usage | null; served_model?: string | null }) => e);
  assert.match(String(cut), /stop_reason=max_tokens/);
  assert.equal(cutOff, 1, "a cut-off answer is not retried");
  assert.deepEqual(cut.usage, billed, "the error carries what the response cost");
  assert.equal(cut.served_model, DEFAULTS.model);

  // Served by another model: not used, billed, not retried.
  let other = 0;
  const wrongModel = async (): Promise<Response> => {
    other++;
    return Response.json({ model: "claude-haiku-4-5-20991231", stop_reason: "end_turn", usage: billed, content: [{ type: "text", text: answerText() }] });
  };
  const mismatch = await askOne(wrongModel, DEFAULTS.model).catch((e: Error & { usage?: Usage | null }) => e);
  assert.match(String(mismatch), /is not the requested/);
  assert.equal(other, 1);
  assert.deepEqual(mismatch.usage, billed);

  // The judge records what the rejected call cost, so the run's ledger and the PR's spend include it.
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const ledger = newLedger();
  await judge([f], [buildPack(f, [], prCtx, [])], async () => { throw Object.assign(new Error("stop_reason=max_tokens"), { usage: billed, served_model: DEFAULTS.model }); }, { ...DEFAULTS, escalationModel: "" }, () => {}, false, ledger);
  assert.equal(ledger.calls.length, 1, "the rejected call is in the ledger");
  assert.ok((ledger.calls[0].cost_usd ?? 0) > 0);
  assert.equal(f.blocking, true, "a rejected answer clears nothing");

  // End to end: the PR's spend in the answers cache counts the cut-off call.
  await inTmp(async (dir) => {
    const cache = join(dir, "answers.json");
    const asked: number[] = [];
    const routes: Route[] = [
      ...judgedRoutes().filter(([match]) => match !== "api.anthropic.com"),
      ["api.anthropic.com", async (init) => { asked.push(1); return truncated(null, init); }],
    ];
    await triage({ env: { ...env, MODE: "report-only", ANTHROPIC_API_KEY: "k", ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(routes), log: () => {} });
    assert.equal(asked.length, 1, "asked once");
    const kept = parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"))[PR_SPEND_KEY];
    assert.equal(kept.pr, 5);
    assert.ok(kept.usd > 0, "the cut-off call's cost is the PR's spend");
  });
});

// Escalation is off by default; these tests turn it on to check how it behaves.
const WITH_FABLE: Config = { ...DEFAULTS, escalationModel: "claude-fable-5-1" };
test("an answer just short of the threshold goes once to the escalation model", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const ledger = newLedger();
  const asked: string[] = [];
  await judge([f], [buildPack(f, [], prCtx, [])], async (packs, model) => {
    asked.push(model);
    const confidence = model === DEFAULTS.model ? 0.75 : 0.92;
    return { answers: packs.map(() => ({ ...flakyAnswer, confidence })), usage: { input_tokens: 3000, output_tokens: 200 }, served_model: model };
  }, WITH_FABLE, () => {}, false, ledger);
  assert.deepEqual(asked, [DEFAULTS.model, WITH_FABLE.escalationModel]);
  assert.equal(f.decision, "adjudicator_unblock");
  assert.equal(f.escalated, true);
  assert.equal(ledger.calls[1].cost_usd, (3000 * 10 + 200 * 50) / 1e6, "priced at Fable 5.1 list price");

  // A confident answer, a refusal, and an answer below the band are not escalated.
  for (const confidence of [0.95, 0.4]) {
    const g = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    const models: string[] = [];
    await judge([g], [buildPack(g, [], prCtx, [])], async (packs, model) => { models.push(model); return ok({ ...flakyAnswer, confidence })(packs, model); }, WITH_FABLE, () => {});
    assert.deepEqual(models, [DEFAULTS.model], `confidence ${confidence}`);
  }
});

test("an answer that blames the PR without citing a change goes to the escalation model", async () => {
  // mattermost-mobile#10172 replay: Haiku blamed "test setup and environment files" for a
  // Maestro flow the diff does not touch, cited no hunk, and so skipped escalation.
  const ungrounded: Answer = { cause: "caused_by_pr", confidence: 0.72, cited_evidence: ["error", "engine"], explanation: "x" };
  const run = async (second: Answer) => {
    const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
    const asked: string[] = [];
    await judge([f], [buildPack(f, [], prCtx, [])], async (packs, model) => {
      asked.push(model);
      return ok(model === DEFAULTS.model ? ungrounded : second)(packs, model);
    }, WITH_FABLE, () => {});
    return { f, asked };
  };
  const cleared = await run({ ...flakyAnswer, confidence: 0.92 });
  assert.deepEqual(cleared.asked, [DEFAULTS.model, WITH_FABLE.escalationModel]);
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
  const models: string[] = [];
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
  // An unreadable AI_PRICES warns and leaves every model unpriced: the judge skips the call, and the run goes on.
  const warned: string[] = [];
  const unreadable = configFrom({ AI_PRICES: "{" }, (w) => warned.push(w));
  assert.equal(priceFor(DEFAULTS.model, unreadable.prices), null);
  assert.match(warned[0] ?? "", /AI_PRICES/);
});

test("the evidence sent is the part that explains the failure", () => {
  const error = ["Error: expect(locator).toBeVisible() failed", "Locator: getByTestId('chip')", "    at /repo/node_modules/playwright/lib/x.js:1:1",
    "    at Object.<anonymous> (/repo/specs/a.spec.ts:40:9)", "    at node:internal/process/task_queues:105:5", "    at helper (/repo/support/ui.ts:7:3)",
    "    at more (/repo/support/a.ts:1:1)", "    at evenMore (/repo/support/b.ts:1:1)"].join("\n");
  assert.equal(compactError(error), "Error: expect(locator).toBeVisible() failed\nLocator: getByTestId('chip')\nat Object.<anonymous> (/repo/specs/a.spec.ts:40:9)\nat helper (/repo/support/ui.ts:7:3)\nat more (/repo/support/a.ts:1:1)");
  assert.equal(compactError("x".repeat(2000)).length, 800);

  const f = classify({ ...failing, error }, trunkPasses(8), [], undefined, 1);
  const files = [{ filename: "app/login.ts", patch: "@@ unrelated" }, { filename: "specs/a.spec.ts", patch: "@@ spec" }];
  const others: OtherFailure[] = [
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
  const bodies: MessageBody[] = [];
  const res = await askModelBatch(async (_u, init) => { bodies.push(parsed<MessageBody>(bodyText(init))); return modelReply(init, flakyAnswer, { input_tokens: 1234, output_tokens: 56 }); }, "k", DEFAULTS.model, packs);
  const body = bodies[0];
  assert.equal(typeof body.system, "string", "no cache marker: the prompt is below Haiku 4.5's minimum cacheable length");
  assert.equal(body.max_tokens, 600 + 16000, "room to think before the answer; thinking counts against max_tokens");
  const haikuBodies: MessageBody[] = [];
  await askModelBatch(async (_u, init) => { haikuBodies.push(parsed<MessageBody>(bodyText(init))); return modelReply(init, flakyAnswer, { input_tokens: 1, output_tokens: 1 }); }, "k", "claude-haiku-4-5-20251001", packs);
  assert.equal(haikuBodies[0].max_tokens, 600, "a model that does not think gets only the answer's room");
  assert.equal(contentText(body.messages[0].content).match(/@@ spec/g)?.length, 1, "a hunk shared by both findings is sent once");
  assert.deepEqual(res.answers.map((a) => a.cause), ["flaky_environment", "flaky_environment"]);
  assert.deepEqual(res.usage, { input_tokens: 1234, output_tokens: 56 });
  assert.match((res.answers[1] as Answer).provenance?.pack_hash ?? "", /^[0-9a-f]{64}$/);

  // An answer missing for one finding fails that finding only.
  const partial = await askModelBatch(async (_u, init) => Response.json({ model: DEFAULTS.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "f2", ...flakyAnswer }] }) }] }), "k", DEFAULTS.model, packs);
  assert.ok(partial.answers[0] instanceof Error);
  assert.equal((partial.answers[0] as Error & { missing?: boolean }).missing, true, "marked so the judge can ask again");
  assert.match(String(partial.answers[0]), /no answer for f1 \(the response answered: f2\)/);
  assert.equal((partial.answers[1] as Answer).cause, "flaky_environment");

  // The request names every id it expects and the schema accepts no other.
  assert.match(contentText(body.messages[0].content), /Return exactly 2 answer\(s\), one for each of: f1, f2\./);
  assert.deepEqual(body.output_config.format.schema.properties.answers?.items.properties.id, { type: "string", enum: ["f1", "f2"] });
});

test("judge asks again, once, about a finding the response left out", async () => {
  const make = () => ["t1", "t2", "t3"].map((title) => classify({ ...failing, title }, [...trunkPasses(8), ...crossPR(31, 32)], [], undefined, 1));
  const packsOf = (findings: Finding[]) => findings.map((f) => buildPack(f, [], { number: 1, repository: "o/r", title: "", lane: "l" }, []));
  const answer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const leaveOut = (skip: number[]) => async (packs: Pack[], _model?: string): Promise<BatchResult> => fixture<BatchResult>({
    answers: packs.map((_, i) => (skip.includes(i) ? Object.assign(new Error(`no answer for f${i + 1}`), { missing: true }) : answer)),
    usage: { input_tokens: 1000, output_tokens: 100 },
  });

  const findings = make();
  const sent: string[][] = [];
  const warnings: string[] = [];
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
  const again: string[] = [];
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
  const cleared: Finding = { ...classify({ ...failing, title: "MM-T5828 redacts" }, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1),
    blocking: false, decision: "adjudicator_unblock", ai: { model: DEFAULTS.model, cost_usd: 0.0031 },
    judge: { ...flakyAnswer, confidence: 0.9, provenance: { served_model: "claude-haiku-4-5-20251001" } } };
  const ai: Ledger = { calls: [{ model: DEFAULTS.model, served_model: "claude-haiku-4-5-20251001", findings: 1, usage: { input_tokens: 2100, output_tokens: 120, cache_read_input_tokens: 0 }, cost_usd: 0.0031 }],
    skipped: { no_effect: 3, duplicate: 0, cached: 0, cap: 0, budget: 0 } };
  const c = summary({ context: "c", verdict: "FAILURE", findings: [cleared, blocked], infra: null, model: "m", runURL: "u", counts: { failed: 2, passed: 10, skipped: 1 }, ai });
  assert.match(c, /^## E2E triage: 🟡 1 needs a look\n/);
  assert.match(c, /\*\*2 failures: 1 needs a look; 1 looks unrelated \(1 flaky\)\.\*\* 83\.3% passed \(10 passed, 2 failed, 1 skipped\) · \[run\]\(u\)/);
  assert.ok(c.indexOf("### Needs a look") < c.indexOf("### Flaky"), "what blocks comes first");
  assert.match(c, /\| MM-T5803 subtitle · `a\.spec\.ts` \| Passes on the default branch \(25 of 25 runs\)[^|]*\| Read the error before re-running\. \|/);
  assert.match(c, /\| MM-T5828 redacts · `a\.spec\.ts` \| Looks flaky or environment \(AI, 90% sure\)\. \| Nothing for you\. \|/);
  assert.match(c, /\| AI \(haiku-4-5-20251001\) \| Not caused by this PR \(flaky or environment\), 90% sure, enough to decide\. recurs elsewhere \|/);
  assert.match(c, /\| Decided by \| AI \(haiku-4-5-20251001\) \|/);
  assert.match(c, /AI: 1 call \(haiku-4-5-20251001\) · 2\.1k tokens in · 120 out · \$0\.0031 · skipped: 3 with nothing the model could change$/);
  assert.doesNotMatch(c, /model's own estimate|cites cross_pr/, "no disclaimer, no evidence ids");
});

test("a failure skipped on retry is still a failure", async () => {
  // Desktop serial describe: a failure followed by a skip is a failure, not a skip.
  const run = await fetchRun(fakeFetch(runRoutes([
    [caseRow("serial", "failed", 0), caseRow("serial", "skipped", 1)],
    [caseRow("late", "skipped", 0), caseRow("late", "passed", 1)],
    [caseRow("never", "skipped", 0), caseRow("never", "skipped", 1)],
  ])), "http://tsio", parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY));
  assert.deepEqual(run.failing.map((f) => f.title), ["serial"]);
  assert.deepEqual(run.counts, { total: 3, passed: 1, failed: 1, flaky: 0, skipped: 1 });
});
test("the status description accounts for every test in the run", async () => {
  // Two failures broken on trunk, one passed, one recovered on retry, one skipped.
  const routes = (statuses: StatusBody[]): Route[] => [
    ...runRoutes([spec("t1", "failed"), spec("t2", "failed"), spec("t3", "passed"), spec("t4", "passed", 1), spec("t5", "skipped")]),
    ["/reports/history", () => Response.json({ observations: [...trunkFailsAll(8), ...trunkFailsAll(8).map((o) => ({ ...o, title: "t2" }))] })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ];
  const written: StatusBody[] = [];
  const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(routes(written)), log: () => {} });
  assert.deepEqual(result.counts, { total: 5, passed: 2, failed: 2, flaky: 1, skipped: 1 });
  const required = written.filter((s) => s.context === "e2e-test/playwright");
  assert.equal(required.length, 1);
  assert.equal(required[0].state, "success");
  assert.equal(required[0].description, "(2 broken on main) 50.0% passed (2 passed, 2 failed, 1 skipped)");

  // mattermost's convention: passed ÷ (passed + failed), one decimal, skipped not counted.
  const counts = { passed: 240, failed: 2, skipped: 3 };
  assert.equal(statusDescription("FAILURE", [blockingOnly(true), blockingOnly(false)], null, counts), "(1 flaky, 1 needs investigation) 99.2% passed (240 passed, 2 failed, 3 skipped)");
  assert.equal(statusDescription("ACTION_REQUIRED", [], "5 of 6 failures are infrastructure errors", counts), "(not triaged, mostly environment errors, re-run) 99.2% passed (240 passed, 2 failed, 3 skipped)");
  // A run with many failures still says what triage made of each one; the run stays red either way.
  const storm = [...Array.from({ length: 49 }, () => blockingOnly(false)), ...Array.from({ length: 4 }, () => blockingOnly(true))];
  assert.equal(statusDescription("ACTION_REQUIRED", storm, "53 tests failed in one run", { passed: 555, failed: 53, skipped: 42 }),
    "(49 flaky, 4 needs investigation; many failures in one run) 91.3% passed (555 passed, 53 failed, 42 skipped)");
  // A run most of whose failures are environment errors says so once, after the labels: "investigation" appears once.
  const envRun = [...Array.from({ length: 17 }, () => blockingOnly(false)), ...Array.from({ length: 2 }, () => blockingOnly(true))];
  assert.equal(statusDescription("ACTION_REQUIRED", envRun, "15 of 19 failures are infrastructure errors (server health, connectivity, device, shard that never ran); rerun when the environment recovers.", { passed: 587, failed: 19, skipped: 42 }),
    "(17 flaky, 2 needs investigation; mostly environment errors, re-run) 96.9% passed (587 passed, 19 failed, 42 skipped)");
  assert.equal(statusDescription("SUCCESS", Array.from({ length: 4 }, () => blockingOnly(false)), null, { passed: 1186, failed: 4, skipped: 164 }), "(4 flaky) 99.7% passed (1186 passed, 4 failed, 164 skipped)");
  // Never "100%" while something failed.
  assert.equal(statusDescription("SUCCESS", [blockingOnly(false)], null, { passed: 5000, failed: 1, skipped: 0 }), "(1 flaky) 99.9% passed (5000 passed, 1 failed, 0 skipped)");
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
  const routes: Route[] = [
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
  const routes: Route[] = [
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
  const asked: number[] = [];
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
  const id: CompositeIdentity = { repository: "o/r", commit_sha: "abc", name: "lane-a", gh_run_id: "12", gh_run_attempt: "1" };
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
      const text = contentText(parsed<MessageBody>(bodyText(init)).messages[0].content);
      assert.match(text, /"valid_evidence_ids":\[[^\]]*"cross_pr"/);
      assert.doesNotMatch(text, /@@ -1 \+1 @@/, "a hunk unrelated to the failure is not sent");
      assert.equal(new Headers(init.headers).get("x-api-key"), "AK");
      return modelReply(init, { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr", "error"], explanation: "recurs on PR 1" });
    }],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/statuses/abc", (init) => {
      const b = parsed<StatusBody>(bodyText(init));
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
  assert.ok(!JSON.stringify(anthropic?.init.headers).includes("GH"));
});
test("end to end: report-only never changes the check's state, and an owned spec is never judged", async () => {
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
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("anthropic")));
  const posted = fetchImpl.calls.filter((c) => c.url.includes("/statuses/")).map((c) => parsed<StatusBody>(bodyText(c.init)));
  assert.ok(keptRed(posted));
});
test("end to end: infra storm is red for the environment while the model does not clear its errors", async () => {
  const many = Array.from({ length: 6 }, (_, i) => [{ ...caseRow(`t${i}`, "failed"), error_message: "Error: server not healthy" }]);
  const asked: number[] = [];
  const fetchImpl = fakeFetch([
    ...runRoutes(many),
    ["api.anthropic.com", (init) => { asked.push(1); return modelReply(init, { cause: "flaky_environment", confidence: 0.5, cited_evidence: ["error"], explanation: "x" }); }],
    ["/reports/history", () => Response.json({ observations: [], has_more: false })],
    ["/issues/5/comments", (init) => (init.method === "POST" ? Response.json({ id: 1 }) : Response.json([]))],
    ["/pulls/5/files", () => Response.json([])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", (init) => { statuses.push(parsed<StatusBody>(bodyText(init))); return Response.json({}); }],
  ]);
  const statuses: StatusBody[] = [];
  const result = await triage({ env, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "ACTION_REQUIRED");
  assert.ok(result.infra);
  const required = statuses.filter((s) => s.context === "e2e-test/playwright");
  assert.deepEqual(required.map((s) => s.state), ["failure"]);
  assert.equal(required.at(-1)?.description, "(6 needs investigation; mostly environment errors, re-run) 0% passed (0 passed, 6 failed, 0 skipped)");
  assert.equal(statuses.filter((s) => s.context === "e2e-test/playwright/triage").at(-1)?.description, "6 failed → 6 needs investigation · mostly environment errors, re-run");
  // Each failure is still named (an environment error), and the model is asked about them in one call.
  assert.equal(asked.length, 1);
  assert.equal(result.findings.length, 6);
  assert.ok(result.findings.every((f) => f.class === "INFRA_ERROR" && f.blocking === true), "named, but the run stays red");
});
// ---------------------------------------------------------------- flagged runs and the judge's capacity

/** A run of failures as evaluateRun reads it: one spec per failure unless a file is given. */
const runOf = (failures: { title: string; file: string; error: string }[]): RunResult => fixture<RunResult>({
  group_id: "g1",
  failing: failures.map((t) => ({ file: t.file, title: t.title, full_title: null, suite_title: null, report_name: null, report_scope: null, identity_ambiguous: false, identity_unresolved: false, error: t.error, tries: { ran: 1, failed: 1 } })),
  missing: null,
  outcomes: new Map(),
  elsewhere: new Map(),
  counts: { total: failures.length, passed: 0, failed: failures.length, flaky: 0, skipped: 0 },
});
const runId: CompositeIdentity = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full" };
const evaluate = (run: RunResult, over: Partial<EvaluateParams>): Promise<EvaluatedRun> =>
  evaluateRun({ run, id: runId, prNumber: 5, history: new Map(), diff: { files: [], ok: true }, trunkBranch: "master", testRoot: ".", ...over });
/** A model that answers each pack with `answer`, recording how many packs each call carried. */
const answering = (answer: (p: Pack) => Answer, sent: number[] = []): AskFn => async (packs) => {
  sent.push(packs.length);
  return fixture<BatchResult>({ answers: packs.map(answer), usage: { input_tokens: 1000, output_tokens: 100 } });
};
const SERVER_DOWN = 'Error: server at "http://localhost:8065" is not healthy after 30 seconds of retries';
const envAnswer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["error"], explanation: "x" };
const downRun = (n: number): RunResult => runOf(Array.from({ length: n }, (_, i) => ({ title: `t${i}`, file: `specs/s${i}.spec.ts`, error: SERVER_DOWN })));
// One other PR that failed each of downRun's tests the same way: cross_pr evidence, short of the cross-PR flaky rule.
const downHistory = (n: number): Map<string, Observation[]> => new Map(Array.from({ length: n }, (_, i): [string, Observation[]] => {
  const at = { file: `specs/s${i}.spec.ts`, title: `t${i}` };
  return [identityKey(at), [obs({ ...at, gh_pr_number: 7, status: "failed", commit_sha: "x7", error_excerpt: SERVER_DOWN })]];
}));
// An environment error is cleared only on evidence from elsewhere: here, the other PR that failed the same way.
const envCrossAnswer: Answer = { ...envAnswer, cited_evidence: ["cross_pr", "error"] };

test("a run flagged for environment errors asks the model, and is green once every failure is cleared, with no run flag", async () => {
  const sent: number[] = [];
  const result = await evaluate(downRun(4), { history: downHistory(4), cfg: { ...DEFAULTS, infraClears: true, escalationModel: "" }, ask: answering(() => envCrossAnswer, sent) });
  assert.match(String(result.infra), /^4 of 4 failures are infrastructure errors/);
  assert.deepEqual(sent, [4], "every held environment error is asked");
  assert.ok(result.findings.every((f) => f.class === "INFRA_ERROR" && !f.blocking && f.decision === "adjudicator_unblock"));
  assert.equal(result.verdict, "SUCCESS");
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts), "(4 flaky) 0% passed (0 passed, 4 failed, 0 skipped)");
  const text = renderSummary({ findings: result.findings, infra: result.infra, runURL: "u", counts: result.counts, trunkBranch: "master" });
  assert.match(text, /✅ none caused by this PR/);
  assert.doesNotMatch(text, /needs investigation|infrastructure errors/);
  // The flag stands while a failure blocks, or when no failure is named.
  assert.equal(verdictOf(result.findings, result.infra), "SUCCESS");
  assert.equal(verdictOf([], result.infra), "ACTION_REQUIRED");
  assert.equal(verdictOf([{ ...result.findings[0], blocking: true }], result.infra), "ACTION_REQUIRED");
});

test("a flagged run with one failure the model blames on the PR stays red, with the run flag", async () => {
  const run = runOf([
    ...[0, 1, 2].map((i) => ({ title: `t${i}`, file: `specs/s${i}.spec.ts`, error: SERVER_DOWN })),
    { title: "t3", file: "specs/s3.spec.ts", error: `${SERVER_DOWN}: panic in server/app/startup.ts` },
  ]);
  const diff = { files: [{ filename: "server/app/startup.ts", patch: "@@ -1 +1 @@\n-ok()\n+panic()" }], ok: true };
  const blame: Answer = { cause: "caused_by_pr", confidence: 0.9, cited_evidence: ["hunk_0"], explanation: "x" };
  const result = await evaluate(run, { diff, history: downHistory(3), cfg: { ...DEFAULTS, infraClears: true, escalationModel: "" }, ask: answering((p) => (p.diff_hunks_of_files_named_in_error.length ? blame : envCrossAnswer)) });
  assert.ok(result.infra);
  assert.deepEqual(result.findings.map((f) => [f.decision, f.blocking]), [["adjudicator_unblock", false], ["adjudicator_unblock", false], ["adjudicator_unblock", false], ["adjudicator_blame", true]]);
  assert.equal(result.verdict, "ACTION_REQUIRED");
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts), "(3 flaky, 1 caused by PR; mostly environment errors, re-run) 0% passed (0 passed, 4 failed, 0 skipped)");
});

test("a flagged run holds environment errors the rules would clear: without the model they stay red", async () => {
  const cfg: Config = { ...DEFAULTS, infraClears: true, escalationModel: "" };
  const result = await evaluate(downRun(4), { cfg, ask: null });
  assert.ok(result.findings.every((f) => f.class === "INFRA_ERROR" && f.blocking), "held, not cleared by the rule");
  assert.match(result.findings[0].reason, /held for the judge: most of this run failed on its environment/);
  assert.equal(result.verdict, "ACTION_REQUIRED");
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts), "(4 needs investigation; mostly environment errors, re-run) 0% passed (0 passed, 4 failed, 0 skipped)");
  // A model that is unavailable leaves them held.
  const down = await evaluate(downRun(4), { cfg, ask: async () => { throw new Error("boom"); } });
  assert.ok(down.findings.every((f) => f.blocking), "with nothing from elsewhere to cite, and the model down, they stay held");
  assert.equal(down.verdict, "ACTION_REQUIRED");
  // On a run that is not flagged, the rule still clears an environment error, and the model is not asked about it.
  const classes: string[] = [];
  const normal = await evaluate(runOf([
    { title: "t0", file: "specs/s0.spec.ts", error: SERVER_DOWN },
    ...[1, 2, 3].map((i) => ({ title: `t${i}`, file: `specs/s${i}.spec.ts`, error: "Error: expected visible" })),
  ]), { cfg, ask: async (packs) => { classes.push(...packs.map((p) => p.engine.class)); return fixture<BatchResult>({ answers: packs.map(() => envAnswer), usage: { input_tokens: 1, output_tokens: 1 } }); } });
  assert.equal(normal.infra, null);
  assert.equal(normal.findings[0].class, "INFRA_ERROR");
  assert.equal(normal.findings[0].blocking, false);
  assert.equal(normal.findings[0].decision, undefined);
  assert.ok(!classes.includes("INFRA_ERROR"), "a cleared environment error is not sent");
});

test("a storm of failures is judged: 24 questions in calls of 8, the rest over the per-run limit stay red with the flag", async () => {
  // Padded so the specs' order is the list's: the judge picks among equals by spec, then title.
  const run = runOf(Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, file: `specs/s${String(i).padStart(2, "0")}.spec.ts`, error: "Error: expected visible" })));
  const history = new Map(run.failing.map((t): [string, Observation[]] => [identityKey(t), [...trunkPasses(8), ...crossPR(31, 32)]]));
  const sent: number[] = [];
  const recurs: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const result = await evaluate(run, { history, cfg: { ...DEFAULTS, escalationModel: "" }, ask: answering(() => recurs, sent) });
  assert.match(String(result.infra), /^30 tests failed in one run/);
  assert.deepEqual(sent, [8, 8, 8]);
  assert.equal(result.findings.filter((f) => f.decision === "adjudicator_unblock").length, 24);
  assert.ok(result.findings.slice(24).every((f) => f.blocking && f.ai?.skipped === "over the per-run limit"));
  assert.equal(result.verdict, "ACTION_REQUIRED");
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts), "(24 flaky, 6 needs investigation; many failures in one run) 0% passed (0 passed, 30 failed, 0 skipped)");
});

test("the same run in another order asks the same questions in the same batches", async () => {
  // TSIO lists a run's failures in no fixed order; the judge must not depend on it.
  const tests = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, file: `specs/s${i % 13}.spec.ts`, error: `Error: expected visible ${i % 3}` }));
  const recurs: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const asked = async (order: typeof tests): Promise<string[][]> => {
    const run = runOf(order);
    const history = new Map(run.failing.map((t): [string, Observation[]] => [identityKey(t), [...trunkPasses(8), ...crossPR(31, 32)]]));
    const batches: string[][] = [];
    await evaluate(run, { history, cfg: { ...DEFAULTS, escalationModel: "" }, ask: async (packs, model) => { batches.push(packs.map((p) => `${p.test.file} ${p.test.title} ${p.error}`)); return answering(() => recurs)(packs, model); } });
    return batches;
  };
  const forward = await asked(tests);
  assert.ok(forward.flat().length > 0);
  // The same test twice with different errors: the error, not TSIO's order, picks the lead.
  const twice = [{ title: "t0", file: "specs/s0.spec.ts", error: "Error: expected visible 2" }, { title: "t0", file: "specs/s0.spec.ts", error: "Error: expected visible 1" }];
  assert.deepEqual(await asked([...twice].reverse()), await asked(twice));
  assert.deepEqual(await asked([...tests].reverse()), forward);
  assert.deepEqual(await asked([...tests.slice(17), ...tests.slice(0, 17)]), forward);
});

test("a blocking environment error is never cleared as broken on trunk by trunk's own failures", () => {
  // classify reads no trunk history for an environment error, so a trunk failure there need not be this one.
  const f = classify({ file: "specs/s0.spec.ts", title: "t0", error: SERVER_DOWN }, [], []);
  assert.equal(f.class, "INFRA_ERROR");
  const base = buildPack(f, [], { lane: "linux" } as PrRef, []);
  const pack: Pack = { ...base, trunk_history_14d: { ...base.trunk_history_14d, fails: 1, latest: "failed" } };
  const onTrunk: Answer = { cause: "bug_on_master", confidence: 0.95, cited_evidence: ["trunk_history_14d"], explanation: "x" };
  assert.equal(decide("INFRA_ERROR", onTrunk, pack).blocking, true);
  assert.equal(unblocks("bug_on_master", ["trunk_history_14d"], pack, "INFRA_ERROR"), false);
  assert.equal(unblocks("bug_on_master", ["cross_pr"], pack, "INFRA_ERROR"), true, "the same failure on another PR still clears");
  assert.equal(unblocks("test_bug", ["cross_pr"], pack, "INFRA_ERROR"), false, "a test bug still needs a pass earlier on this PR");
  assert.equal(unblocks("bug_on_master", ["trunk_history_14d"], pack, "REGRESSION"), true, "other classes keep the trunk rule");
});

test("a blocking environment error (infraClears off) is the judge's to clear or blame on any run", async () => {
  const cleared = await evaluate(downRun(1), { history: downHistory(1), cfg: { ...DEFAULTS, escalationModel: "" }, ask: answering(() => envCrossAnswer) });
  // The error text alone never clears one: a PR that breaks the server fails every test with such an error.
  const textOnly = await evaluate(downRun(1), { cfg: { ...DEFAULTS, escalationModel: "" }, ask: answering(() => envAnswer) });
  assert.equal(textOnly.findings[0].blocking, true);
  assert.equal(textOnly.verdict, "FAILURE");
  assert.equal(cleared.infra, null);
  assert.equal(cleared.findings[0].decision, "adjudicator_unblock");
  assert.equal(cleared.findings[0].blocking, false);
  assert.equal(cleared.verdict, "SUCCESS");
  const run = runOf([{ title: "t0", file: "specs/s0.spec.ts", error: `${SERVER_DOWN}: panic in server/app/startup.ts` }]);
  const diff = { files: [{ filename: "server/app/startup.ts", patch: "@@ -1 +1 @@\n-ok()\n+panic()" }], ok: true };
  const blamed = await evaluate(run, { diff, cfg: { ...DEFAULTS, escalationModel: "" }, ask: answering(() => ({ cause: "caused_by_pr", confidence: 0.9, cited_evidence: ["hunk_0"], explanation: "x" })) });
  assert.equal(blamed.findings[0].decision, "adjudicator_blame");
  assert.equal(statusLabelOf(blamed.findings[0]), "caused by PR");
  assert.equal(blamed.verdict, "FAILURE");
  // The bar is the same as for any judged finding: sure enough, and a blame needs a change to point to.
  const pack = buildPack(blamed.findings[0], diff.files, prCtx, []);
  assert.equal(canChange("INFRA_ERROR", pack), true, "a related hunk: the model may blame it");
  assert.equal(canChange("INFRA_ERROR", buildPack(textOnly.findings[0], [], prCtx, [])), false, "no other PR, earlier pass or hunk to cite: no answer can change it");
  assert.equal(decide("INFRA_ERROR", envAnswer, pack).blocking, true, "the error text alone never clears it");
  assert.equal(decide("INFRA_ERROR", { ...envAnswer, confidence: 0.8 }, pack).blocking, true, "below the threshold it stays red");
  assert.equal(decide("INFRA_ERROR", { ...envAnswer, cause: "test_bug" }, pack).blocking, true, "a test bug needs this PR's earlier pass");
  assert.equal(decide("INFRA_ERROR", { cause: "caused_by_pr", confidence: 0.95, cited_evidence: ["error"], explanation: "x" }, pack).decision, "engine", "no blame without a hunk");
  assert.equal(decide("INFRA_ERROR", undefined, pack).blocking, true, "no answer leaves it red");
});

test("the judge asks 8 findings to a call, larger groups first, each call within what is left of the budget", async () => {
  const recurs: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "x" };
  const hist = [...trunkPasses(8), ...crossPR(31, 32)];
  const sidebar = "Error: expected the channel sidebar to list the new channel";
  const make = (): Finding[] => [
    ...Array.from({ length: 19 }, (_, i) => classify({ ...failing, title: `t${i}`, file: `specs/s${i}.spec.ts` }, hist, [], undefined, 1)),
    // Three tests of one spec with one distinctive error: one question, and it goes first.
    ...[0, 1, 2].map((i) => classify({ file: "specs/big.spec.ts", title: `big${i}`, error: sidebar }, [...trunkPasses(8), ...crossPR(31, 32).map((o) => ({ ...o, error_excerpt: sidebar }))], [], undefined, 1)),
  ];
  const packsOf = (findings: Finding[]) => findings.map((f) => buildPack(f, [], prCtx, []));
  const calls: string[][] = [];
  const all = make();
  await judge(all, packsOf(all), async (packs) => {
    calls.push(packs.map((p) => p.test.title));
    return fixture<BatchResult>({ answers: packs.map(() => recurs), usage: { input_tokens: 1000, output_tokens: 100 } });
  }, { ...DEFAULTS, escalationModel: "" });
  assert.deepEqual(calls.map((c) => c.length), [8, 8, 4], "20 questions in three calls");
  assert.equal(calls[0][0], "big0", "the question that settles three tests is asked first");
  assert.ok(all.every((f) => f.decision === "adjudicator_unblock"));

  // A budget the first call uses up: its 8 questions are answered, and the other 12 are not asked.
  const tight = make();
  const ledger = newLedger();
  const warnings: string[] = [];
  let asked = 0;
  await judge(tight, packsOf(tight), async (packs) => {
    asked++;
    return fixture<BatchResult>({ answers: packs.map(() => recurs), usage: { input_tokens: 50000, output_tokens: 0 } });
  }, { ...DEFAULTS, escalationModel: "", budgetUsd: 0.1 }, (w) => warnings.push(w), false, ledger);
  assert.equal(asked, 1);
  assert.equal(ledger.calls[0].cost_usd, 0.1);
  assert.equal(ledger.skipped.budget, 12);
  assert.equal(tight.filter((f) => f.decision === "adjudicator_unblock").length, 10, "8 questions, one of them for 3 tests");
  const skipped = tight.filter((f) => f.decision !== "adjudicator_unblock");
  assert.equal(skipped.length, 12);
  assert.ok(skipped.every((f) => f.blocking && /would cross the \$0\.1 run budget/.test(String(f.ai?.skipped))));
  assert.equal(warnings.filter((w) => /model call skipped/.test(w)).length, 2, "each call is checked on its own");
});

test("the escalation pass asks its near misses in calls of 8 too", async () => {
  const hist = [...trunkPasses(8), ...crossPR(31, 32)];
  const findings = Array.from({ length: 10 }, (_, i) => classify({ ...failing, title: `t${i}`, file: `specs/s${i}.spec.ts` }, hist, [], undefined, 1));
  const sent: { n: number; model: string }[] = [];
  await judge(findings, findings.map((f) => buildPack(f, [], prCtx, [])), async (packs, model) => {
    sent.push({ n: packs.length, model });
    const confidence = model === DEFAULTS.model ? 0.7 : 0.95;
    return fixture<BatchResult>({ answers: packs.map(() => ({ cause: "flaky_environment", confidence, cited_evidence: ["cross_pr"], explanation: "x" })), usage: { input_tokens: 1000, output_tokens: 100 } });
  }, { ...DEFAULTS, escalationModel: "claude-fable-5-1", budgetUsd: 5 });
  assert.deepEqual(sent, [
    { n: 8, model: DEFAULTS.model }, { n: 2, model: DEFAULTS.model },
    { n: 8, model: "claude-fable-5-1" }, { n: 2, model: "claude-fable-5-1" },
  ]);
  assert.ok(findings.every((f) => f.decision === "adjudicator_unblock" && f.escalated));
});

test("end to end: green run posts success and no comment", async () => {
  const fetchImpl = fakeFetch([
    ...runRoutes([spec("t1", "passed")]),
    ["/statuses/abc", (init) => (assert.equal(parsed<StatusBody>(bodyText(init)).state, "success"), Response.json({}))],
  ]);
  const result = await triage({ env, fetchImpl, log: () => {} });
  assert.equal(result.verdict, "SUCCESS");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("/comments")));
});

// ---- judge provenance, sampling and strict answers ----
const judgePack = { cross_pr_failures_14d: { other_prs_where_this_test_failed: ["PR 1"] }, diff_hunks_of_files_named_in_error: [], test: {}, error: "", engine: {}, trunk_history_14d: {}, pr: {} } as unknown as Pack;
interface FakeModel extends FetchImpl {
  calls: MessageBody[];
}
function fakeModel(served: string | undefined | ((requested: string) => string), { text = answerText(), stop = "end_turn" }: { text?: string; stop?: string } = {}): FakeModel {
  const calls: MessageBody[] = [];
  const impl = async (_url: string, init: RequestInit = {}): Promise<Response> => {
    const body = parsed<MessageBody>(bodyText(init));
    calls.push(body);
    return Response.json({ model: typeof served === "function" ? served(body.model) : served, stop_reason: stop, content: [{ type: "text", text }] });
  };
  return Object.assign(impl, { calls });
}

const askOne = (fetchImpl: FetchImpl, model: string) => askModelBatch(fetchImpl, "k", model, [judgePack]);

test("the judge is pinned to a versioned model, and the second opinion is off by default", () => {
  // Versioned ids (no dated snapshot exists for these): a family alias could be
  // repointed underneath the thresholds.
  assert.equal(DEFAULTS.model, "claude-sonnet-5-5");
  assert.equal(DEFAULTS.escalationModel, "", "Sonnet 5.5 only until data shows a second opinion is worth it");
  assert.equal(configFrom({}).escalationModel, "");
  for (const m of [DEFAULTS.model, WITH_FABLE.escalationModel]) assert.ok(priceFor(m), `${m} is priced, so the run budget applies to it`);
});
test("with the default settings, an answer just short of the threshold is not asked again", async () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const asked: string[] = [];
  await judge([f], [buildPack(f, [], prCtx, [])], async (packs, model) => { asked.push(model); return ok({ ...flakyAnswer, confidence: 0.75 })(packs, model); }, DEFAULTS, () => {});
  assert.deepEqual(asked, [DEFAULTS.model]);
  assert.equal(f.blocking, true, "below the threshold it stays red for a person");
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
  const a = (await askOne(fakeModel((m) => m), "claude-haiku-4-5-20251001")).answers[0] as Answer;
  assert.equal(a.provenance?.requested_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance?.served_model, "claude-haiku-4-5-20251001");
  assert.equal(a.provenance?.temperature, 0);
  assert.match(a.provenance?.pack_hash ?? "", /^[0-9a-f]{64}$/);

  const f: Finding = { ...classify(failing, trunkPasses(8), []), judge: { ...a, cited_evidence: ["cross_pr"] }, decision: "adjudicator_unblock", blocking: false };
  const c = summary({ context: "c", verdict: "SUCCESS", findings: [f], infra: null, model: "claude-haiku-4-5", runURL: "u", counts: { failed: 1 } });
  assert.ok(c.includes("| Decided by | AI (haiku-4-5-20251001) |"), "the row names the model that answered, not the alias that was asked for");
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
  const f = (error: string, file = "detox/maestro/flows/account/a.yml") => ({ error, file });
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

test("a changed file's name counts only as a whole path or module, not as the tail of a longer name", () => {
  const f = (error: string) => ({ error, file: "detox/maestro/flows/account/login.yml" });
  // "a.js" is the end of "data.js" and "index.ts" the end of "reindex.ts": neither names the other file.
  assert.equal(namesChangedFile(f("TypeError at load (data.js:3:1)"), "src/a.js"), false);
  assert.equal(namesChangedFile(f("Cannot find module 'reindex.ts'"), "app/index.ts"), false);
  assert.equal(namesChangedFile(f("at foo (src/a.js:10:5)"), "src/a.js"), true);
  assert.equal(namesChangedFile(f("Cannot find module './config' from 'x.ts'"), "detox/e2e/config.js"), true);
});

test("a server answering with a page instead of JSON is infrastructure", () => {
  assert.ok(isInfraError("AllowDownloadLogs never took: wanted 'false', client config serves '<client config was not JSON: the server answered with an HTML page starting '<!DOCTYPE html>'>'"));
  assert.ok(isInfraError("Received HTML from server instead of JSON"));
  assert.equal(isInfraError("Assertion is false: id: channel_bookmark.screen is not visible"), false);
});

// mattermost-mobile#10172 run 37196938935: a test that passed on 23 earlier commits
// of the PR was kept red because the judge never saw that history.
const mine = (status: string, sha: string, at: string): Observation => obs({ gh_pr_number: 1, status, commit_sha: sha, created_at: at });

test("this PR's own earlier runs are counted, newest pass first", () => {
  const f = classify(failing, [...trunkPasses(8), mine("failed", "new", "2026-09-12T00:00:00Z"), mine("passed", "mid", "2026-09-11T00:00:00Z"), mine("passed", "old", "2026-09-10T00:00:00Z")], [], undefined, 1);
  assert.equal(f.class, "REGRESSION", "this PR's own runs never change the rules' class");
  assert.deepEqual(f.this_pr, { runs: 3, passes: 2, fails: 1, last_pass: { commit_sha: "mid", created_at: "2026-09-11T00:00:00Z" }, latest: "failed" });
  assert.equal(f.cross_pr.passes, 0, "and they are not counted as other PRs");
  assert.equal(classify(failing, trunkPasses(8), [], undefined, null).this_pr.runs, 0, "a trunk run has no PR history");
});

test("a pass earlier on this PR counts as evidence only when nothing related changed since", () => {
  const base = { ...classify(failing, [...trunkPasses(8), mine("passed", "mid", "2026-09-11T00:00:00Z")], [], undefined, 1) };
  const pack = (since: Partial<SinceLastPass> | undefined) => buildPack({ ...base, since_last_pass: since && fixture<SinceLastPass>(since) }, [], prCtx, []);
  assert.ok(evidenceIds(pack({ files: [".github/x.yml"], related: [] })).includes("this_pr"));
  assert.ok(!evidenceIds(pack({ files: ["src/expected.ts"], related: [{ file: "specs/a.spec.ts", patch: "@@" }] })).includes("this_pr"), "a related change since the pass");
  assert.ok(!evidenceIds(pack(undefined)).includes("this_pr"), "what changed since is unknown");
  const never = buildPack({ ...classify(failing, [...trunkPasses(8), mine("failed", "a", "2026-09-11T00:00:00Z")], [], undefined, 1), since_last_pass: fixture<SinceLastPass>({ files: [], related: [] }) }, [], prCtx, []);
  assert.ok(!evidenceIds(never).includes("this_pr"), "it never passed on this PR");

  const answer: Answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["this_pr"], explanation: "x" };
  assert.equal(decide("REGRESSION", answer, pack({ files: [".github/x.yml"], related: [] })).blocking, false);
  assert.equal(decide("REGRESSION", answer, pack({ files: ["a.ts"], related: [{ file: "a.ts", patch: "" }] })).blocking, true);
  assert.equal(decide("REGRESSION", { ...answer, confidence: 0.8 }, pack({ files: [], related: [] })).blocking, true, "still needs 85%");
});

test("a change list cut off at GitHub's 300-file limit is incomplete, so a pass earlier on this PR cannot clear on it", async () => {
  const f: Finding = { ...classify({ ...failing, error: "Error: timeout" }, [...trunkPasses(8), mine("passed", "lastpass", "2026-09-11T00:00:00Z")], [], undefined, 1), repo_path: "specs/a.spec.ts" };
  const cut = Array.from({ length: 300 }, (_, i) => ({ filename: `webapp/f${i}.ts`, patch: "@@" }));
  const api = async (_method: string, path: string): Promise<unknown> => {
    if (path.startsWith("/repos/o/r/compare/lastpass...head")) return { files: cut };
    throw new Error(`unexpected ${path}`);
  };
  await enrichFindings({ findings: [f], api, id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", log: () => {} });
  assert.equal(f.since_last_pass?.complete, false);
  const pack = buildPack(f, [], prCtx, []);
  assert.equal(evidenceIds(pack).includes("this_pr"), false, "the file that changed may be one the list cut off");
  const answer: Answer = { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["this_pr"], explanation: "x" };
  assert.equal(decide("REGRESSION", answer, pack).blocking, true);
  const c = renderSummary({ verdict: "FAILURE", findings: [f], infra: null, runURL: "u", counts: { failed: 1, passed: 9 } });
  assert.match(c, /Changed on this PR since that pass \| 300 files listed; GitHub lists at most 300, so more may have changed\./);
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
  const f: Finding = { ...classify({ ...failing, error: "Error: timeout\n at (specs/a.spec.ts:3:1)" }, [...trunkPasses(8), mine("passed", "lastpass", "2026-09-11T00:00:00Z")], [], undefined, 1), repo_path: "specs/a.spec.ts" };
  const api = async (_method: string, path: string): Promise<unknown> => {
    if (path.startsWith("/repos/o/r/compare/lastpass...head")) return { files: [{ filename: ".github/ci.yml", patch: "@@ -1 +1 @@" }, { filename: "specs/a.spec.ts", patch: "@@ spec" }] };
    if (path.startsWith("/repos/o/r/contents/specs/a.spec.ts?ref=head")) return { encoding: "base64", content: Buffer.from("one\ntwo\nthree\nfour").toString("base64") };
    throw new Error(`unexpected ${path}`);
  };
  const tsio = async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes("/reports?") && !u.includes("name=")) return Response.json({ reports: [
      { id: "g-self", name: "pw", gh_run_id: "9", gh_run_attempt: "1" },
      { id: "g-ios", repository: "o/r", commit: "head", name: "mobile-pr-detox-ios", gh_run_id: "9", gh_run_attempt: "1", status: "completed" },
      { id: "g-old", repository: "o/r", commit: "head", name: "mobile-pr-detox-ios", gh_run_id: "8", gh_run_attempt: "1", status: "completed" },
    ] });
    if (u.includes("name=mobile-pr-detox-ios")) return Response.json({ reports: [{ id: "g-ios", name: "mobile-pr-detox-ios", repository: "o/r", commit: "head", gh_run_id: "9", gh_run_attempt: "1", status: "completed", total_reports_expected: 1, reports: [{}] }] });
    if (u.includes("/reports/g-ios/suites")) return Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] });
    if (u.includes("/reports/g-ios/cases")) return Response.json([{ suite_id: "s1", title: "t1", status: "passed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }]);
    throw new Error(`unexpected ${u}`);
  };
  const logs: string[] = [];
  await enrichFindings({ findings: [f], api, id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", log: (m) => logs.push(m) });
  await siblingPlatforms({ findings: [f], fetchImpl: tsio, base: "http://tsio", id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, log: (m) => logs.push(m) });
  assert.deepEqual(f.since_last_pass?.files, [".github/ci.yml", "specs/a.spec.ts"]);
  assert.deepEqual(f.since_last_pass?.related.map((r) => r.file), ["specs/a.spec.ts"], "the spec itself changed since the pass");
  assert.equal(f.since_last_pass?.changes?.length, 2, "a small change set goes to the judge whole");
  assert.equal(f.code_near_failure, "1  one\n2  two\n3> three\n4  four");
  assert.deepEqual(f.other_lanes, [{ platform: "detox-ios", result: "passed" }], "only this run's other platforms");
  const noLogs: string[] = [];
  assert.deepEqual(logs, noLogs);

  // Every lookup can fail without failing triage: the fact is left out.
  const g: Finding = { ...classify(failing, [...trunkPasses(8), mine("passed", "lastpass", "2026-09-11T00:00:00Z")], [], undefined, 1) };
  await enrichFindings({ findings: [g], api: async () => { throw new Error("down"); }, id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", log: (m) => logs.push(m) });
  assert.equal(g.since_last_pass, undefined);
  assert.equal(g.other_lanes, undefined, "other platforms are read by their own function, not by this one");
  assert.equal(logs.length, 1, "the failed compare is logged; the sibling read is not part of this function");
});

test("the summary shows the facts behind each verdict and who decided", () => {
  const f: Finding = { ...classify(failing, [...trunkPasses(25), mine("passed", "4f4dbd3fb4", "2026-10-04T06:29:17Z")], [], undefined, 1),
    untouched: true, tries: { ran: 2, failed: 2 }, other_lanes: [{ platform: "detox-ios", result: "passed" }],
    since_last_pass: fixture<SinceLastPass>({ files: [".github/workflows/e2e-detox-pr.yml"], related: [] }),
    ai: { model: "claude-sonnet-5-5", cost_usd: 0.1 }, decision: "engine",
    judge: { cause: "flaky_environment", confidence: 0.68, cited_evidence: ["producer"], explanation: "Waits on an outside host.", provenance: { served_model: "claude-sonnet-5-5" } } };
  const c = renderSummary({ verdict: "FAILURE", findings: [f], infra: null, runURL: "u", counts: { failed: 1, passed: 594, skipped: 42 }, lane: "detox-android", trunkBranch: "main" });
  assert.match(c, /^## E2E triage · detox-android: 🟡 1 needs a look/);
  assert.match(c, /\*\*1 failure: 1 needs a look\.\*\* 99\.8% passed \(594 passed, 1 failed, 42 skipped\)/);
  assert.match(c, /\| Looks flaky or environment \(AI, 68% sure\), but not sure enough to clear\. \| Read the error before re-running\. \|/);
  assert.match(c, /\| Decided by \| Rules; AI asked \|/, "the AI was asked, so it is not 'rules' alone");
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
// A failure only the model can clear: master passes it, one other PR failed it.
const judgedRoutes = ({ labels = [], statuses = [], asked = [] }: { labels?: { name: string }[]; statuses?: StatusBody[]; asked?: string[] } = {}): Route[] => [
  ...runRoutes([spec("t1", "failed")]),
  ["/reports/history", () => Response.json({ observations: [...trunkPasses(8), obs({ gh_pr_number: 1, status: "failed" })] })],
  ["/pulls/5/files", () => Response.json([{ filename: "app/login.ts", patch: "@@" }])],
  ["/pulls/5", () => Response.json({ title: "Fix login", base: { ref: "master" }, labels })],
  ["api.anthropic.com", (init) => { asked.push(parsed<MessageBody>(bodyText(init)).model); return modelReply(init, { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr", "error"], explanation: "recurs on PR 1" }); }],
  ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
];
const inTmp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "triage-pr-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
/** One PR's kept spend in the answers cache (see PR_SPEND_KEY). */
interface SpendEntry {
  pr: number;
  usd: number;
}
/** A finding that carries only the flag the test sets. */
const blockingOnly = (blocking: boolean): Finding => fixture<Finding>({ blocking });

test("the report-only label makes triage report-only on that PR, whatever the repo's mode", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const result = await triage({ env: { ...env, GITHUB_STEP_SUMMARY: join(dir, "s.md"), GITHUB_OUTPUT: join(dir, "output"), FINDINGS_FILE: join(dir, "findings.json") }, fetchImpl: fakeFetch(judgedRoutes({ labels: [{ name: "E2E/Triage-report-only" }], statuses })), log: () => {} });
    assert.equal(result.verdict, "SUCCESS", "the failure is still judged");
    assert.equal(parsed<{ mode: string }>(readFileSync(join(dir, "findings.json"), "utf8")).mode, "report-only", "the findings file records the mode the run ran in, not the one asked for");
    assert.ok(keptRed(statuses), "the cleared failure does not turn the check green; only its text changes");
    const summaryText = readFileSync(join(dir, "s.md"), "utf8");
    assert.match(summaryText, /\*\*Report only\.\*\*/);
    assert.match(summaryText, /it has the E2E\/Triage-report-only label/);
    assert.match(readFileSync(join(dir, "output"), "utf8"), /effective_mode=report-only\n/);
  });
  // Another label changes nothing; an empty label setting turns the opt-out off.
  const other: StatusBody[] = [];
  await triage({ env, fetchImpl: fakeFetch(judgedRoutes({ labels: [{ name: "E2E/Run" }], statuses: other })), log: () => {} });
  assert.ok(other.some((s) => s.context === "e2e-test/playwright" && s.state === "success"));
  const off: StatusBody[] = [];
  await triage({ env: { ...env, REPORT_ONLY_LABEL: "" }, fetchImpl: fakeFetch(judgedRoutes({ labels: [{ name: "E2E/Triage-report-only" }], statuses: off })), log: () => {} });
  assert.ok(off.some((s) => s.context === "e2e-test/playwright"), "with the opt-out off the repo's mode applies");
});

test("unreadable PR labels cannot bypass the report-only opt-out", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    await triage({ env: { ...env, GITHUB_OUTPUT: join(dir, "output") }, fetchImpl: fakeFetch([
      ["/pulls/5", () => new Response("unavailable", { status: 503 })],
      ...judgedRoutes({ statuses }),
    ]), log: () => {} });
    assert.ok(keptRed(statuses), "the cleared failure does not turn the check green");
    assert.match(readFileSync(join(dir, "output"), "utf8"), /effective_mode=report-only\n/);
  });
});

test("all-pass report data neither clears a raw summary failure nor ignores the report-only label", async () => {
  for (const labels of [[], [{ name: "E2E/Triage-report-only" }]]) await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const result = await triage({ env: { ...env, GITHUB_OUTPUT: join(dir, "output") }, fetchImpl: fakeFetch([
      ...runRoutes([spec("t1", "passed")]),
      ...judgedRoutes({ labels, statuses }),
    ]), log: () => {} });
    assert.equal(result.verdict, "SUCCESS");
    assert.deepEqual(statuses, [], "a non-test failure belongs to the raw reporter");
    const output = readFileSync(join(dir, "output"), "utf8");
    assert.match(output, /published=false\n/);
    assert.match(output, new RegExp(`effective_mode=${labels.length ? "report-only" : "enforce"}\\n`));
  });
});

test("triage reports publication only after an owned required-status write succeeds", async () => {
  for (const kind of ["current", "superseded", "write-error"]) await inTmp(async (dir) => {
    const overrides: Route[] = kind === "write-error"
      ? [["/statuses/abc", () => new Response("unavailable", { status: 503 })]]
      : kind === "superseded"
        ? [["/commits/abc/statuses", () => Response.json([{ context: env.STATUS_CONTEXT, state: "failure", target_url: "https://github.com/o/r/actions/runs/99" }])]]
        : [];
    const work = triage({ env: { ...env, GITHUB_OUTPUT: join(dir, "output") }, fetchImpl: fakeFetch([...overrides, ...judgedRoutes()]), log: () => {} });
    if (kind === "write-error") await assert.rejects(work, /503/);
    else await work;
    const output = readFileSync(join(dir, "output"), "utf8");
    assert.match(output, /verdict=SUCCESS\n/, "a diagnostic verdict alone does not establish publication");
    if (kind === "current") assert.match(output, /published=true\n/);
    else assert.doesNotMatch(output, /published=true\n/);
  });
});

test("a lane's share of the PR's AI budget carries across commits in the answers cache", async () => {
  await inTmp(async (dir) => {
    const cache = join(dir, "answers.json");
    const lanes = "e2e-test/a,e2e-test/b,e2e-test/c,e2e-test/d";
    const base = { ...env, ANSWERS_CACHE: cache, TRIAGE_LANES: lanes, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") };

    // First commit: nothing spent yet, the model is asked and its cost is kept for the PR.
    const asked: string[] = [];
    await triage({ env: base, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: () => {} });
    assert.deepEqual(asked, [DEFAULTS.model]);
    const kept = parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"))[PR_SPEND_KEY];
    assert.equal(kept.pr, 5);
    assert.ok(kept.usd > 0, "this run's cost is added to the PR's spend");

    // A later commit of the same PR whose lane already used its share ($2 / 4 lanes):
    // no call is made, the failure stays red, and the summary says why.
    writeFileSync(cache, JSON.stringify({ [PR_SPEND_KEY]: { pr: 5, usd: 0.5 } }));
    const later: string[] = [];
    const statuses: StatusBody[] = [];
    const result = await triage({ env: base, fetchImpl: fakeFetch(judgedRoutes({ asked: later, statuses })), log: () => {} });
    assert.deepEqual(later, [], "the lane's share of the PR budget is used up");
    assert.equal(result.findings[0].blocking, true);
    assert.deepEqual(statuses.map((s) => s.state), ["failure"]);
    assert.match(readFileSync(join(dir, "s.md"), "utf8"), /over the PR's AI budget \(\$2 per PR, \$0\.50 for this lane, \$0\.50 already spent\)/);
    assert.equal(parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"))[PR_SPEND_KEY].usd, 0.5, "nothing new spent");

    // Spend recorded for another PR is not this PR's.
    writeFileSync(cache, JSON.stringify({ [PR_SPEND_KEY]: { pr: 9, usd: 5 } }));
    const fresh: string[] = [];
    await triage({ env: base, fetchImpl: fakeFetch(judgedRoutes({ asked: fresh })), log: () => {} });
    assert.deepEqual(fresh, [DEFAULTS.model]);
    assert.equal(parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"))[PR_SPEND_KEY].pr, 5);
  });
});

test("the PR budget does not apply to trunk runs or without an answers cache", async () => {
  // No cache to keep the spend in: only the per-run budget applies.
  const asked: string[] = [];
  await triage({ env: { ...env, PR_BUDGET_USD: "0" }, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: () => {} });
  assert.deepEqual(asked, [DEFAULTS.model]);
  assert.equal(configFrom({}).prBudgetUsd, 2);
  assert.equal(configFrom({ PR_BUDGET_USD: "3.5" }).prBudgetUsd, 3.5);
});


test("MIN_CONFIDENCE is clamped to 0.5-1 and the budgets must be amounts; anything else is replaced by the default, with a warning", () => {
  const warnings: string[] = [];
  const config = (over: Env) => configFrom(over, (w) => warnings.push(w));
  assert.equal(config({ MIN_CONFIDENCE: "0.9" }).minConfidence, 0.9);
  assert.equal(config({ MIN_CONFIDENCE: "0.1" }).minConfidence, 0.5, "below the floor is raised, so a weak answer cannot clear");
  assert.equal(config({ MIN_CONFIDENCE: "7" }).minConfidence, 1, "above 1 is lowered");
  assert.equal(warnings.length, 2, "each clamp is warned");
  for (const bad of ["abc", "NaN", "Infinity"]) assert.equal(config({ MIN_CONFIDENCE: bad }).minConfidence, DEFAULTS.minConfidence, `MIN_CONFIDENCE ${bad}`);
  assert.equal(warnings.length, 5, "each value that is not a number is warned");
  assert.equal(config({}).minConfidence, DEFAULTS.minConfidence);
  assert.equal(warnings.length, 5, "unset is not a warning");

  assert.equal(config({ AI_BUDGET_USD: "0" }).budgetUsd, 0, "zero is a real budget: no call is made");
  assert.equal(config({ AI_BUDGET_USD: "-1" }).budgetUsd, DEFAULTS.budgetUsd);
  assert.equal(config({ AI_BUDGET_USD: "abc" }).budgetUsd, DEFAULTS.budgetUsd);
  assert.equal(config({ PR_BUDGET_USD: "Infinity" }).prBudgetUsd, DEFAULTS.prBudgetUsd);
  assert.equal(warnings.length, 8, "each invalid budget is warned");
  assert.match(warnings.at(-1) ?? "", /PR_BUDGET_USD "Infinity" is not a finite amount/);
});

// mattermost#38601: master's #39127 fixed a typo in a help text and updated the
// Cypress test in the same commit. The PR, behind master, ran its old copy of the
// test against master's app build, so the test failed on the PR alone.
const staleRoutes = ({ compare, commits, asked = [], statuses = [] }: { compare: unknown; commits: unknown; asked?: number[]; statuses?: StatusBody[] }): Route[] => [
  ...runRoutes([spec("t1", "failed")]),
  ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
  ["/compare/abc...master", () => Response.json(compare)],
  ["/commits?sha=master&path=specs%2Fa.spec.ts", () => Response.json(commits)],
  ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
  ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" }, labels: [] })],
  ["api.anthropic.com", (init) => { asked.push(1); return modelReply(init, { cause: "flaky_environment", confidence: 0.5, cited_evidence: ["error"], explanation: "x" }); }],
  ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
];
const typoFix = { sha: "m1", commit: { message: "Fix English typos and grammar (#39127)", committer: { date: "2026-10-13T21:05:57Z" } } };

test("a test the base branch changed after the PR last merged it is out of date: red, merge, no model", async () => {
  await inTmp(async (dir) => {
    const asked: number[] = [];
    const statuses: StatusBody[] = [];
    const compare = { ahead_by: 25, files: [{ filename: "specs/a.spec.ts" }, { filename: "webapp/i18n/en.json" }], commits: [{ sha: "m0" }, { sha: "m1" }] };
    const result = await triage({ env: { ...env, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(staleRoutes({ compare, commits: [typoFix], asked, statuses })), log: () => {} });
    const f = result.findings[0];
    assert.equal(f.blocking, true, "it stays red: the PR's copy of the test is what failed");
    assert.deepEqual(f.out_of_date, { base: "master", behind: 25, commit: { sha: "m1", date: "2026-10-13", pr: 39127 } });
    assert.deepEqual(asked, [], "the model is not asked about it");
    assert.deepEqual(statuses.map((s) => s.state), ["failure"]);
    const summaryText = readFileSync(join(dir, "s.md"), "utf8");
    assert.match(summaryText, /### Out of date \(1\): master changed these tests, or fixed these failures, after this PR last merged master/);
    assert.match(summaryText, /\| master changed this test \(#39127, 2026-10-13\) after this PR last merged master, so the PR ran its old copy\. \| Merge master and re-run\. \|/);
    assert.match(summaryText, /Changed on master since this PR last merged it \| Yes: m1 \(#39127\) on 2026-10-13\. This PR is 25 commits behind/);
  });
});

test("the out-of-date rule stays out of the way when it can't be sure", async () => {
  // master changed other files only: the usual path, and the model is asked.
  const asked: number[] = [];
  const other = await triage({ env: { ...env, TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(staleRoutes({ compare: { ahead_by: 3, files: [{ filename: "webapp/x.ts" }], commits: [{ sha: "m1" }] }, commits: [], asked })), log: () => {} });
  assert.equal(other.findings[0].out_of_date, undefined);
  assert.equal(asked.length, 1);
  // GitHub stops listing at 300 files. A spec in the cut-off list did change, so it is marked.
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: i === 7 ? "specs/a.spec.ts" : `f${i}.ts` }));
  const listed = await triage({ env: { ...env, TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(staleRoutes({ compare: { ahead_by: 400, files: many, commits: [] }, commits: [] })), log: () => {} });
  assert.deepEqual(listed.findings[0].out_of_date, { base: "master", behind: 400, commit: null });
  // A spec missing from it may be missing only because the list stopped; with no merge base to ask from, nothing is marked.
  const others = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }));
  const capped = await triage({ env: { ...env, TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(staleRoutes({ compare: { ahead_by: 400, files: others, commits: [] }, commits: [] })), log: () => {} });
  assert.equal(capped.findings[0].out_of_date, undefined);
  assert.equal(capped.findings[0].decision, "evidence_incomplete", "not marked, but not cleared on that account either");
  // Up to date with master: nothing to compare.
  const current = await triage({ env: { ...env, TRIAGE_CONTEXT: "off" }, fetchImpl: fakeFetch(staleRoutes({ compare: { ahead_by: 0, files: [], commits: [] }, commits: [] })), log: () => {} });
  assert.equal(current.findings[0].out_of_date, undefined);
  // No red failure to check: GitHub is not asked at all.
  await markOutOfDate({ findings: [], api: async () => { throw new Error("not called"); }, id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master" });
});

// A failure whose spec master changed after this PR last merged it (stale), and one the PR's own edit explains (owned).
const staleOnMaster = (title: string): Finding => Object.assign(classify({ ...failing, title }, trunkPasses(8), []), { out_of_date: { base: "master", behind: 25, commit: { sha: "m1", date: "2026-10-13", pr: 39127 } } });
const ownedByPR = (title: string): Finding => classify({ ...failing, title }, trunkPasses(8), ["specs/a.spec.ts"]);
test("an out-of-date failure is its own group: merge and re-run, never the PR's blame, still red", () => {
  const stale = staleOnMaster("a");
  assert.equal(bucketOf(stale), "outdated");
  assert.equal(bucketOf(ownedByPR("b")), "yours");
  const text = summary({ findings: [stale], counts: { passed: 9, failed: 1 }, runURL: "u", trunkBranch: "master" });
  assert.match(text, /^## E2E triage: 🔴 merge master and re-run: 1 out of date$/m);
  assert.match(text, /^### Out of date \(1\): master changed these tests, or fixed these failures, after this PR last merged master$/m);
  assert.match(text, /\| master changed this test \(#39127, 2026-10-13\) after this PR last merged master, so the PR ran its old copy\. \| Merge master and re-run\. \|/);
  assert.match(text, /\*\*Merge master and re-run first\. 1 failure: 1 out of date\.\*\*/);
  assert.doesNotMatch(text, /may be caused by this PR|Your PR/);
  assert.match(statusDescription("FAILURE", [stale], null, { passed: 9, failed: 1 }), /^\(1 out of date\)/, "the check names it as out of date");
});

test("out-of-date failures are counted apart from the PR's own, and lead the headline once they are half the failures", () => {
  const head = (findings: Finding[]): string => summary({ findings, counts: { passed: 9, failed: findings.length }, runURL: "u", trunkBranch: "master" }).split("\n")[0];
  assert.equal(head([ownedByPR("b"), ownedByPR("c"), staleOnMaster("a")]), "## E2E triage: 🔴 2 may be caused by this PR, 1 out of date");
  assert.equal(head([ownedByPR("b"), staleOnMaster("a")]), "## E2E triage: 🔴 merge master and re-run: 1 out of date, 1 may be caused by this PR");
  assert.equal(head([ownedByPR("b"), staleOnMaster("a"), staleOnMaster("c")]), "## E2E triage: 🔴 merge master and re-run: 2 out of date, 1 may be caused by this PR");
  const mixed = summary({ findings: [ownedByPR("b"), ownedByPR("c"), staleOnMaster("a")], counts: { passed: 9, failed: 3 }, runURL: "u", trunkBranch: "master" });
  assert.match(mixed, /\*\*3 failures: 2 may be caused by this PR; 1 out of date\.\*\*/);
  assert.match(mixed, /### Your PR \(2\)/);
  assert.match(mixed, /### Out of date \(1\): master changed/);
});

test("a cleared test that failed every try here is re-run before digging, never 'Nothing for you'", () => {
  const error = 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"';
  const f = classify({ ...failing, error, tries: { ran: 2, failed: 2 } }, [...trunkPasses(8), obs({ status: "failed", commit_sha: "s1", error_excerpt: error })], []);
  assert.equal(f.class, "FLAKY_ON_TRUNK");
  const text = summary({ findings: [f], counts: { passed: 9, failed: 1 }, runURL: "u", trunkBranch: "master" });
  assert.match(text, /Failed every try here; flaky on master\. \| Re-run once before digging\. \|/);
  assert.doesNotMatch(text, /Nothing for you/);
});

test("a base branch that changed 300 files or more leaves a failure unchecked: red, and the model is never asked", async () => {
  // Cross-PR evidence the model could cite would clear this failure; the cut-off list is what must stop it.
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: `webapp/f${i}.ts` }));
  const asked: number[] = [];
  const result = await triage({
    env: { ...env, TRIAGE_CONTEXT: "off" },
    fetchImpl: fakeFetch([
      ...runRoutes([spec("t1", "failed")]),
      ["/reports/history", () => Response.json({ observations: [...trunkPasses(8), ...crossPR(31)] })],
      ["/compare/abc...master", () => Response.json({ ahead_by: 400, files: many, commits: [] })],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" }, labels: [] })],
      ["api.anthropic.com", (init) => {
        asked.push(1);
        return modelReply(init, { cause: "flaky_environment", confidence: 0.95, cited_evidence: ["cross_pr"], explanation: "recurs on PR 31" });
      }],
      ["/statuses/abc", () => Response.json({})],
    ]),
    log: () => {},
  });
  const f = result.findings[0];
  assert.equal(f.class, "REGRESSION", "history alone cannot clear it");
  assert.equal(f.blocking, true);
  assert.equal(f.decision, "evidence_incomplete");
  assert.deepEqual(asked, [], "a test that may have changed is not sent to the model");
  assert.equal(result.verdict, "FAILURE");
});

// A run triage could not read or decide still says why in the job summary, in report-only too.
test("a run that triage cannot finish writes its reason to the job summary, in both modes", async () => {
  for (const mode of ["report-only", "enforce"]) {
    await inTmp(async (dir) => {
      const summaryPath = join(dir, "s.md");
      await assert.rejects(
        () => triage({ env: { ...env, MODE: mode, GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch([["/reports?", () => Response.json({}, { status: 500 })]]), log: () => {} }),
        /TSIO GET \/reports/,
      );
      assert.match(readFileSync(summaryPath, "utf8"), /^## E2E triage: ⚠️ not triaged$/m, mode);
      assert.match(readFileSync(summaryPath, "utf8"), /\*\*triage could not finish: TSIO GET \/reports\?/, mode);
    });
  }
});

test("a history read that still fails after its retry ends triage with the error in the summary, report-only", async () => {
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    const fetchImpl = fakeFetch([...runRoutes([spec("t1", "failed")]), ["/reports/history", () => Response.json({}, { status: 503 })]]);
    await assert.rejects(() => triage({ env: { ...env, MODE: "report-only", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} }), /TSIO history 503/);
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reports/history")).length, 2, "one retry");
    assert.match(readFileSync(summaryPath, "utf8"), /\*\*triage could not finish: TSIO history 503\*\*/);
  });
});

// Report only (the launch mode): triage's line goes on the E2E check, never its colour.
test("report-only writes triage's line on the E2E check but keeps the state the check has", async () => {
  const run = async (current: string | null): Promise<StatusBody[]> => {
    const posted: StatusBody[] = [];
    const routes: Route[] = [
      ...judgedRoutes({ statuses: posted }),
      ["/commits/abc/statuses", () => Response.json(current ? [{ context: "e2e-test/playwright", state: current, description: "98.5% passed (1303/1323)", target_url: "https://test-io.test.mattermost.com/reports/o/r/pr-5/abc/playwright?gh_run_id=12&status_run_id=12&status_run_attempt=1" }] : [])],
    ];
    await triage({ env: { ...env, MODE: "report-only" }, fetchImpl: fakeFetch(routes), log: () => {} });
    return posted;
  };
  // The failure is cleared, but a red check stays red: report only never turns red green. The link moves from the
  // report to this run, whose summary says why each failure is or isn't the PR's.
  assert.deepEqual(await run("failure"), [{ state: "failure", context: "e2e-test/playwright", description: "(1 flaky) 0% passed (0 passed, 1 failed, 0 skipped)", target_url: "https://github.com/o/r/actions/runs/12?status_run_id=12&status_run_attempt=1" }]);
  // A check a waiver label already turned green stays green.
  assert.deepEqual((await run("success")).map((s) => s.state), ["success"]);
  // No final state yet (or no status at all): nothing is written.
  assert.deepEqual(await run("pending"), []);
  assert.deepEqual(await run(null), []);
  // No triage check is posted in report-only: a green one beside a red E2E check would read as "safe to merge".
  assert.equal((await run("failure")).some((s) => s.context.endsWith("/triage")), false);
});

// mattermost#38937 turned ChannelAttributes on by default and broke these specs on master.
const brokenOnMaster = (): Observation[] => [
  obs({ commit_sha: "bad2", status: "failed", created_at: "2026-09-12T00:00:00Z" }),
  obs({ commit_sha: "bad1", status: "failed", created_at: "2026-09-11T00:00:00Z" }),
  ...trunkPasses(6),
];
test("a test broken on master names the PR merged between its last pass and first failure", async () => {
  const f = classify(failing, brokenOnMaster(), [], undefined, 5);
  assert.equal(f.class, "BROKEN_ON_TRUNK");
  assert.deepEqual(f.trunk_break, { first_fail: { commit_sha: "bad1", created_at: "2026-09-11T00:00:00Z" }, last_pass: { commit_sha: "c0", created_at: "2026-09-10T00:00:00Z" } });
  assert.equal(bucketOf(f), "broken");

  const asked: string[] = [];
  const api = async (_m: string, path: string): Promise<unknown> => {
    asked.push(path);
    return { total_commits: 1, commits: [{ sha: "bad1", author: { login: "dev1" }, commit: { message: "Enable ChannelAttributes by default (#38937)\n\nbody" } }] };
  };
  const g = classify({ ...failing, title: "t2" }, brokenOnMaster().map((o) => ({ ...o, title: "t2" })), [], undefined, 5);
  await markBrokeBy({ findings: [f, g], api, id: { repository: "o/r", commit_sha: "abc" } });
  assert.deepEqual(asked, ["/repos/o/r/compare/c0...bad1?per_page=100"], "tests that broke in the same window share one call");
  assert.deepEqual(f.broke_by, { from: "c0", to: "bad1", total: 1, commits: [{ sha: "bad1", pr: 38937, author: "dev1" }] });

  const c = renderSummary({ verdict: "SUCCESS", findings: [f], infra: null, runURL: "u", counts: { passed: 9, failed: 1, skipped: 0 }, trunkBranch: "master" });
  assert.match(c, /### Broken on master \(1\)/);
  assert.match(c, /\| Fails on master's latest run too; broke in #38937 \(@dev1\)\. \| Nothing for you\. Fix belongs to #38937 \(@dev1\)\. \|/);
  assert.match(c, /\| Merged on master between its last pass and first failure \| 1 commit \(c0…bad1\): #38937 @dev1 \|/);

  // Several commits in the window: they are listed, none is blamed.
  const h = classify(failing, brokenOnMaster(), [], undefined, 5);
  await markBrokeBy({ findings: [h], api: async () => ({ total_commits: 3, commits: ["(#1)", "(#2)", "(#3)"].map((m, i) => ({ sha: `s${i}`, commit: { message: `x ${m}` } })) }), id: { repository: "o/r", commit_sha: "abc" } });
  assert.match(renderSummary({ verdict: "SUCCESS", findings: [h], infra: null, runURL: "u", counts: { passed: 9, failed: 1 }, trunkBranch: "master" }), /broke in one of #1, #2, #3\. \| Nothing for you\. Fix belongs to one of #1, #2, #3\. \|/);

  // No pass on record before the streak: nothing to compare, and no one is named.
  const always = classify(failing, trunkFailsAll(8), [], undefined, 5);
  assert.equal(always.trunk_break?.last_pass, null);
  // A lookup that fails leaves the finding as it was.
  const k = classify(failing, brokenOnMaster(), [], undefined, 5);
  await markBrokeBy({ findings: [k], api: async () => { throw new Error("rate limited"); }, id: { repository: "o/r", commit_sha: "abc" } });
  assert.equal(k.broke_by, undefined);
  assert.match(renderSummary({ verdict: "SUCCESS", findings: [k], infra: null, runURL: "u", counts: { passed: 9, failed: 1 }, trunkBranch: "master" }), /\| Fails on master's latest run too\. \| Nothing for you\. \|/);
});

test("the AI names this PR only when it is sure and points to the change", () => {
  const f = classify(failing, [...trunkPasses(8), ...crossPR(11, 12)], [], undefined, 1);
  const pack = buildPack(f, [{ filename: "specs/a.spec.ts", patch: "@@" }], prCtx, []);
  const hunk = evidenceIds(pack).find((id) => id.startsWith("hunk_"));
  assert.ok(hunk, "the pack has a hunk to cite");
  const blame: Answer = { cause: "caused_by_pr", confidence: 0.9, cited_evidence: [hunk], explanation: "the change renames the selector" };
  const strong = decide("REGRESSION", blame, pack);
  assert.deepEqual([strong.blocking, strong.decision], [true, "adjudicator_blame"]);
  // Weak, or with nothing in the diff to point to: still red, but a guess, not "your PR".
  assert.equal(decide("REGRESSION", { ...blame, confidence: 0.6 }, pack).decision, "engine");
  assert.equal(decide("REGRESSION", { ...blame, cited_evidence: ["error"] }, pack).decision, "engine");

  const regression: Finding = { ...f, class: "REGRESSION", blocking: true, untouched: true };
  const sure: Finding = { ...regression, decision: "adjudicator_blame", judge: strong.answer };
  assert.equal(bucketOf(sure), "yours");
  const guess: Finding = { ...regression, decision: "engine", judge: { ...blame, confidence: 0.6 } };
  assert.equal(bucketOf(guess), "check", "a 60% guess at the PR is not enough to blame it");
  const advice: Finding = { ...regression, decision: "advice", judge: { ...blame, confidence: 0.6, cited_evidence: [] } };
  assert.equal(bucketOf(advice), "check");

  const c = renderSummary({ verdict: "FAILURE", findings: [guess], infra: null, runURL: "u", counts: { passed: 9, failed: 1 }, trunkBranch: "main" });
  assert.match(c, /1 needs a look/);
  assert.doesNotMatch(c, /may be caused by this PR/);
  assert.match(c, /\| Might be this PR's change \(AI, 60% sure\), but not sure enough to say\. \| Read the error before re-running\. \|/);
  assert.match(c, /Caused by this PR, 60% sure; naming the PR needs 85% and a change it can point to\./);
  const y = renderSummary({ verdict: "FAILURE", findings: [sure], infra: null, runURL: "u", counts: { passed: 9, failed: 1 }, trunkBranch: "main" });
  assert.match(y, /1 may be caused by this PR/);
  assert.match(y, /\| Points to this PR's change \(AI, 90% sure\)\. \| Check the change named in the evidence\. \|/);
  assert.match(y, /Caused by this PR, 90% sure, enough to decide\./);
});

test("the four groups are fixed, and a flaky test names no PR", () => {
  const flaky = classify(failing, [...trunkPasses(8), obs({ commit_sha: "x", status: "flaky", created_at: "2026-09-01T00:00:00Z" })], [], undefined, 5);
  assert.equal(flaky.class, "FLAKY_ON_TRUNK");
  assert.equal(bucketOf(flaky), "flaky");
  const c = renderSummary({ verdict: "SUCCESS", findings: [flaky], infra: null, runURL: "u", counts: { passed: 9, failed: 1 }, trunkBranch: "master" });
  assert.match(c, /\| Flaky on master: passed only on retry 1 of the last 9 runs\. \| Nothing for you\. \|/);
  assert.doesNotMatch(c, /Fix belongs to/);
  assert.equal(bucketOf({ ...flaky, class: "OWNED_BY_PR", blocking: true }), "yours");
  assert.equal(bucketOf({ ...flaky, class: "REGRESSION", blocking: true, untouched: true }), "check");
  assert.equal(bucketOf({ ...flaky, class: "REGRESSION", blocking: true, untouched: false }), "yours");
  assert.equal(bucketOf({ ...flaky, class: "SAME_FAILURE_AS_CLEARED", blocking: false, same_as_class: "BROKEN_ON_TRUNK" }), "broken");
  assert.equal(passRate({ passed: 0, failed: 0 }), "0%");
  assert.equal(passRate({ passed: 10, failed: 0 }), "100%");
});

test("the headline agrees with the verdict: a blocking base-branch failure, a veto, and missing reports are never 'none caused'", () => {
  // A trunk run whose test is still failing on master: it blocks, and no PR is involved.
  const streak = classify(failing, [obs({ status: "failed" }), ...trunkPasses(8)], [], undefined, null, null, { isTrunkRun: true });
  assert.deepEqual([streak.class, streak.blocking], ["BROKEN_ON_TRUNK", true]);
  const trunk = summary({ verdict: "FAILURE", findings: [streak], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master", pr: false });
  assert.match(trunk, /^## E2E triage: 🔴 1 still failing on master$/m);
  assert.match(trunk, /\*\*1 failure: 1 still failing on master\.\*\*/, "the summary line does not call a blocking failure unrelated");
  assert.doesNotMatch(trunk, /none caused/);

  // A PR run whose base-branch failure the judge vetoes: the judge names the PR, so it is the PR's to explain.
  const vetoed: Finding = { ...classify(failing, [obs({ status: "failed" }), ...trunkPasses(8)], [], undefined, 1), blocking: true, decision: "adjudicator_veto", judge: { cause: "caused_by_pr", confidence: 0.95, cited_evidence: ["hunk_0"], explanation: "the change" } };
  assert.equal(bucketOf(vetoed), "yours");
  const veto = renderSummary({ verdict: "FAILURE", findings: [vetoed], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" });
  assert.match(veto, /^## E2E triage: 🔴 1 may be caused by this PR$/m);

  // Missing reports and no failure in the reports that arrived: red, not "nothing failed".
  const missing = { text: "1 of 3 reports never uploaded, so the specs on those workers never ran", short: "1 report(s) missing" };
  const none = renderSummary({ verdict: "FAILURE", findings: [], infra: null, runURL: "u", counts: { failed: 0, passed: 10 }, missing, trunkBranch: "master" });
  assert.match(none, /^## E2E triage: 🔴 results missing$/m);
  assert.doesNotMatch(none, /nothing failed/);
  // Missing reports still outrank an amber "needs a look".
  const amber: Finding = { ...classify({ ...failing, title: "t2" }, trunkPasses(8), [], undefined, 1), blocking: true, class: "INSUFFICIENT_DATA" };
  const both = renderSummary({ verdict: "FAILURE", findings: [amber], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, missing, trunkBranch: "master" });
  assert.match(both, /^## E2E triage: 🔴 results missing$/m);
});

test("a superseded same-SHA run keeps its diagnostic summary but cannot publish triage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "triage-superseded-"));
  const written: StatusBody[] = [];
  const routes: Route[] = [
    ...runRoutes([spec("t1", "failed")]),
    ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/commits/abc/statuses", () => Response.json([{ context: env.STATUS_CONTEXT, state: "success", target_url: "https://github.com/o/r/actions/runs/99" }])],
    ["/statuses/abc", (i) => { written.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ];
  try {
    await triage({ env: { ...env, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), ANTHROPIC_API_KEY: "" }, fetchImpl: fakeFetch(routes), log: () => {} });
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /E2E triage/);
    assert.deepEqual(written, [], "neither required nor informational statuses belong to this older run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- review fixes: prices are checked at load, and a cost that is not a number is never a pass ----
test("a malformed AI_PRICES entry warns and makes its model unpriced; the rest of the table still holds", () => {
  for (const raw of [
    '{"claude-sonnet-5-5":{"input":2}}',
    '{"claude-sonnet-5-5":{"input":2,"output":10}}',
    '{"claude-sonnet-5-5":{"input":-1,"output":10,"cache_write":2.5,"cache_read":0.2}}',
    '{"claude-sonnet-5-5":{"input":"2","output":10,"cache_write":2.5,"cache_read":0.2}}',
    '{"claude-sonnet-5-5":{"input":2,"output":1e400,"cache_write":2.5,"cache_read":0.2}}',
    '{"claude-sonnet-5-5":null}',
  ]) {
    const warned: string[] = [];
    const cfg = configFrom({ AI_PRICES: raw }, (w) => warned.push(w));
    assert.equal(priceFor("claude-sonnet-5-5", cfg.prices), null, `${raw}: the model has no price, so the judge does not call it`);
    assert.equal(priceFor("claude-haiku-4-5", cfg.prices) !== null, true, `${raw}: the other models keep their prices`);
    assert.match(warned[0] ?? "", /AI_PRICES "claude-sonnet-5-5"/, raw);
  }
  for (const raw of ["null", "[1]", "{not json"]) {
    const warned: string[] = [];
    const cfg = configFrom({ AI_PRICES: raw }, (w) => warned.push(w));
    assert.equal(priceFor("claude-haiku-4-5", cfg.prices), null, `${raw}: not an object of prices, so no model is priced`);
    assert.match(warned[0] ?? "", /AI_PRICES/, raw);
  }
  // Zero is a price, and a complete entry is taken as written.
  assert.equal(configFrom({ AI_PRICES: '{"free-model":{"input":0,"output":0,"cache_write":0,"cache_read":0}}' }).prices?.["free-model"]?.input, 0);
});

test("a malformed AI_PRICES does not stop the run: it publishes, and the model it names is not called", async () => {
  await inTmp(async (dir) => {
    const asked: string[] = [];
    const statuses: StatusBody[] = [];
    const logs: string[] = [];
    const output = join(dir, "output");
    await triage({ env: { ...env, AI_PRICES: '{"claude-sonnet-5-5":{"input":2}}', AI_BUDGET_USD: "0.0001", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked, statuses })), log: (m) => logs.push(m) });
    assert.deepEqual(asked, [], "the model is unpriced, so it is not called");
    assert.ok(statuses.length >= 1, "the verdict is published");
    assert.match(readFileSync(output, "utf8"), /published=true\n/);
    assert.match(logs.join("\n"), /AI_PRICES/);
  });
});

test("a cost that is not a finite number is never a passed budget check, whatever the prices say", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const f = classify(failing, [...trunkPasses(8), ...crossPR(31)], [], undefined, 1);
  const cfg: Config = { ...DEFAULTS, escalationModel: "", budgetUsd: 0.0001, prices: { ...PRICES, [DEFAULTS.model]: { input: 2, output: Number.NaN, cache_write: 2.5, cache_read: 0.2 } } };
  await judge([f], [buildPack(f, [], prCtx, [])], async () => { calls++; return fixture<BatchResult>({ answers: [], usage: null }); }, cfg, (w) => warnings.push(w));
  assert.equal(calls, 0, "NaN compares false against every ceiling, so a NaN worst-case used to let the call through");
  assert.match(warnings[0] ?? "", /cannot be bounded/);
  assert.equal(f.blocking, true);
  assert.equal(costOf({ input_tokens: 1 }, DEFAULTS.model, cfg.prices), null, "a non-finite cost is unknown, not NaN");
});

test("a failed base-branch compare is not read as unchanged: the failure is unchecked and the model is not asked", async () => {
  await inTmp(async (dir) => {
    const asked: string[] = [];
    const statuses: StatusBody[] = [];
    const logs: string[] = [];
    const result = await triage({
      env: { ...env, GITHUB_STEP_SUMMARY: join(dir, "s.md") },
      fetchImpl: fakeFetch([["/compare/", () => new Response("Server Error", { status: 500 })], ...judgedRoutes({ asked, statuses })]),
      log: (m) => logs.push(m),
    });
    assert.deepEqual(asked, [], "a test whose change list is unknown is not sent to the model");
    assert.equal(result.findings[0].decision, "evidence_incomplete");
    assert.equal(result.verdict, "FAILURE", "red, never cleared on an unknown change list");
    assert.match(result.findings[0].reason, /could not be read/);
    assert.ok(logs.some((l) => /base branch changes unavailable/.test(l)));
  });
});

// ---- review fixes: an answers cache that is not a readable object leaves the PR's spend unknown ----
test("an answers cache that is not an object leaves the PR's spend unknown: no model call, and the next save is valid", async () => {
  for (const seed of ["null", '"oops"', "5", "[]", "{not json"]) {
    await inTmp(async (dir) => {
      const cache = join(dir, "answers.json");
      writeFileSync(cache, seed);
      const asked: string[] = [];
      const logs: string[] = [];
      const result = await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: (m) => logs.push(m) });
      assert.deepEqual(asked, [], `${seed}: the model is not called`);
      assert.match(logs.join("\n"), /the PR's spend is unknown/, seed);
      assert.equal(result.verdict, "FAILURE", `${seed}: rules only, so the failure stays red`);
      const saved = parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"));
      assert.equal(saved[PR_SPEND_KEY].pr, 5, `${seed}: the next save is a valid structure`);
      // Owner decision A: unknown spend is not saved as budget used. This run counted no spend, so the next run starts the budget fresh.
      assert.equal(saved[PR_SPEND_KEY].usd, 0, `${seed}: the saved spend is only what this run counted`);
      const next: string[] = [];
      await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked: next })), log: () => {} });
      assert.deepEqual(next, [DEFAULTS.model], `${seed}: the next run starts the PR budget fresh`);
    });
  }
});

test("a corrupt PR-spend entry leaves the spend unknown: no model call", async () => {
  for (const entry of ['{"pr":5,"usd":"abc"}', '{"pr":5,"usd":-1}', '{"pr":5,"usd":1e400}', '{"pr":5}', '"5"']) {
    await inTmp(async (dir) => {
      const cache = join(dir, "answers.json");
      writeFileSync(cache, `{"${PR_SPEND_KEY}":${entry}}`);
      const asked: string[] = [];
      await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: () => {} });
      assert.deepEqual(asked, [], `${entry}: the model is not called`);
      const saved = parsed<Record<string, SpendEntry>>(readFileSync(cache, "utf8"));
      // Owner decision A: this run counted no spend, so the saved spend is 0 and the next run starts the budget fresh.
      assert.equal(saved[PR_SPEND_KEY].usd, 0, `${entry}: the saved spend is only what this run counted`);
      const next: string[] = [];
      await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked: next })), log: () => {} });
      assert.deepEqual(next, [DEFAULTS.model], `${entry}: the next run starts the PR budget fresh`);
    });
  }
});

test("a valid spend entry for this PR still counts, and a readable cache is used as before", async () => {
  await inTmp(async (dir) => {
    const cache = join(dir, "answers.json");
    writeFileSync(cache, JSON.stringify({ [PR_SPEND_KEY]: { pr: 5, usd: 0 } }));
    const asked: string[] = [];
    await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: () => {} });
    assert.deepEqual(asked, [DEFAULTS.model]);
  });
});

test("an answers cache that cannot be written after a paid call does not stop the run; the run says so", async () => {
  if (process.getuid?.() === 0) return; // root writes through a read-only file
  await inTmp(async (dir) => {
    const cache = join(dir, "answers.json");
    writeFileSync(cache, "{}");
    chmodSync(cache, 0o444);
    const asked: string[] = [];
    const logs: string[] = [];
    try {
      const result = await triage({ env: { ...env, ANSWERS_CACHE: cache, TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(judgedRoutes({ asked })), log: (m) => logs.push(m) });
      assert.deepEqual(asked, [DEFAULTS.model], "the call was made and paid for");
      assert.equal(result.verdict, "SUCCESS");
      assert.match(logs.join("\n"), /answers cache not saved/);
    } finally {
      chmodSync(cache, 0o644);
    }
  });
});

// ---- review fixes: a billed reply that is not used is still counted, its usage carried by the error ----
test("a reply that has no text or does not parse is billed: the error carries its usage and model", async () => {
  const billed: Usage = { input_tokens: 4000, output_tokens: 900 };
  for (const content of [[], [{ type: "text", text: "" }], [{ type: "text", text: "not json" }]]) {
    const err = await askOne(async () => Response.json({ model: DEFAULTS.model, stop_reason: "end_turn", usage: billed, content }), DEFAULTS.model)
      .then(() => null, (e: Error & { usage?: Usage | null; served_model?: string | null }) => e);
    assert.ok(err instanceof Error, JSON.stringify(content));
    assert.deepEqual(err.usage, billed, `${JSON.stringify(content)}: the error carries what the reply cost`);
    assert.equal(err.served_model, DEFAULTS.model);
  }
});

test("an unused reply is still counted by the run: its call and its cost", async () => {
  await inTmp(async (dir) => {
    const routes: Route[] = [
      ...judgedRoutes().filter(([match]) => match !== "api.anthropic.com"),
      ["api.anthropic.com", () => Response.json({ model: DEFAULTS.model, stop_reason: "end_turn", usage: { input_tokens: 2000, output_tokens: 150 }, content: [{ type: "text", text: "not json" }] })],
    ];
    const result = await triage({ env: { ...env, GITHUB_STEP_SUMMARY: join(dir, "s.md"), GITHUB_OUTPUT: join(dir, "out") }, fetchImpl: fakeFetch(routes), log: () => {} });
    assert.equal(result.ai.calls.length, 1, "the billed call is in the ledger");
    assert.ok((result.ai.calls[0].cost_usd ?? 0) > 0);
    assert.match(readFileSync(join(dir, "out"), "utf8"), /ai_calls=1\n/);
  });
});

// ---- review fixes: an evidence image path that is not a file is skipped, as other unusable evidence is ----
test("an evidence image that is a directory is skipped with a warning; the other images of the test still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-dir-"));
  try {
    mkdirSync(join(dir, "shard-1", "shot", "as-dir.png"), { recursive: true });
    writeFileSync(join(dir, "shard-1", "shot", "ok.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24, 0)]));
    writeFileSync(join(dir, "shard-1", "run.json"), JSON.stringify([{ file: "specs/a.spec.ts", title: "t1", notes: "the banner is hidden", images: ["shot/as-dir.png", "shot/ok.png"] }]));
    const warnings: string[] = [];
    const evidence = loadEvidence(dir, (w) => warnings.push(w));
    assert.deepEqual(evidence.map((e) => [e.title, e.images.length]), [["t1", 1]], "the directory is not an image; the PNG beside it loads");
    assert.equal(evidence[0].images[0].media_type, "image/png");
    assert.ok(warnings.some((w) => /as-dir\.png/.test(w) && /is not a file/.test(w)), warnings.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- review fixes: an invalid or missing identity is named, before any request ----
test("an invalid or missing COMPOSITE_IDENTITY is named before any request, with the same exit", async () => {
  for (const [value, pattern] of [["{bad", /COMPOSITE_IDENTITY is not valid JSON/], [undefined, /COMPOSITE_IDENTITY is missing/]] as const) {
    const fetchImpl = fakeFetch(judgedRoutes());
    await assert.rejects(triage({ env: { ...env, COMPOSITE_IDENTITY: value }, fetchImpl, log: () => {} }), pattern);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

// ---- owner decision B: the cross-PR "same error" rule. A timeout is compared by where it got stuck, a bare
// timeout only with other bare timeouts, and a distinctive error only with the same distinctive error.
const stuckA = (locator: string, ms = 30000) => `Error: Timed out waiting for selector "${locator}" to be visible\n\n   at ../helpers/serverView.ts:660\n    at waitForDesktopAuthPage (/home/runner/work/desktop/e2e/helpers/loginSso.ts:149:5)`;
const clickStuck = (locator: string, ms = 30000) => `TimeoutError: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for ${locator}\n\n\n  53 |\n> 55 |     await x.click();\n    at /home/runner/work/mattermost/e2e-tests/x.spec.ts:55:74`;
const BARE_TIMEOUT = "Test timeout of 30000ms exceeded.";
const ASSERTION = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('channel_view')\nExpected: visible\nTimeout: 10000ms\nError: element(s) not found";
const failedOn = (prs: number[], error: string): Observation[] => prs.map((n) => obs({ gh_pr_number: n, status: "failed", commit_sha: `x${n}`, error_excerpt: error }));
const judgedTest = (error: string): TestRef => ({ file: "specs/a.spec.ts", title: "t1", error });

test("a generic timeout stuck on one locator is not cleared by other PRs failing with distinctive errors", () => {
  const f = classify(judgedTest(stuckA("#save")), [...trunkPasses(8), ...failedOn([31, 32, 33], ASSERTION)], []);
  assert.notEqual(f.class, "FLAKY_CROSS_PR", "an unrelated failure on other PRs does not explain a stuck timeout");
  assert.equal(f.class, "REGRESSION");
});

test("a timeout stuck on the same locator as other PRs' timeouts is cleared as the same flake", () => {
  const f = classify(judgedTest(stuckA("#save")), [...trunkPasses(8), ...failedOn([31, 32, 33], stuckA("#save"))], []);
  assert.equal(f.class, "FLAKY_CROSS_PR");
  assert.equal(f.blocking, false);
});

test("a timeout stuck on one locator is not cleared by other PRs stuck on another", () => {
  const f = classify(judgedTest(stuckA("#save")), [...trunkPasses(8), ...failedOn([31, 32, 33], stuckA("#cancel"))], []);
  assert.notEqual(f.class, "FLAKY_CROSS_PR", "the same test hung on a different step");
  assert.equal(f.class, "REGRESSION");
});

test("playwright click timeouts are compared by locator, not by the shared action text", () => {
  const f = classify(judgedTest(clickStuck("getByRole('button', { name: 'Save' })")), [...trunkPasses(8), ...failedOn([31, 32, 33], clickStuck("getByRole('button', { name: 'Cancel' })", 45000))], []);
  assert.notEqual(f.class, "FLAKY_CROSS_PR");
  const same = classify(judgedTest(clickStuck("getByRole('button', { name: 'Save' })")), [...trunkPasses(8), ...failedOn([31, 32, 33], clickStuck("getByRole('button', { name: 'Save' })", 45000))], []);
  // errorSignature masks 4+ digit numbers, so a different millisecond timeout on the same step is the same stuck point.
  // A different wait in seconds is not (see "a stuck match needs the whole message to agree").
  assert.equal(same.class, "FLAKY_CROSS_PR", "the same locator at another millisecond timeout is the same stuck point");
});

test("a bare timeout is cleared only by other bare timeouts", () => {
  const same = classify(judgedTest(BARE_TIMEOUT), [...trunkPasses(8), ...failedOn([31, 32, 33], "Test timeout of 60000ms exceeded.")], []);
  assert.equal(same.class, "FLAKY_CROSS_PR");
  const other = classify(judgedTest(BARE_TIMEOUT), [...trunkPasses(8), ...failedOn([31, 32, 33], ASSERTION)], []);
  assert.notEqual(other.class, "FLAKY_CROSS_PR", "a bare timeout is not the same failure as an assertion");
  assert.equal(other.class, "REGRESSION");
  const stuck = classify(judgedTest(BARE_TIMEOUT), [...trunkPasses(8), ...failedOn([31, 32, 33], stuckA("#save"))], []);
  assert.notEqual(stuck.class, "FLAKY_CROSS_PR", "nor a timeout stuck on a locator");
});

test("a distinctive error is still cleared only by the same distinctive error", () => {
  assert.equal(classify(judgedTest(ASSERTION), [...trunkPasses(8), ...failedOn([31, 32, 33], ASSERTION)], []).class, "FLAKY_CROSS_PR");
  const other = classify(judgedTest(ASSERTION), [...trunkPasses(8), ...failedOn([31, 32, 33], "Error: expect(locator).toHaveText() failed\n\nLocator: getByTestId('other')\nExpected: 'x'")], []);
  assert.equal(other.class, "REGRESSION");
  const stuck = classify(judgedTest(ASSERTION), [...trunkPasses(8), ...failedOn([31, 32, 33], stuckA("#save"))], []);
  assert.notEqual(stuck.class, "FLAKY_CROSS_PR", "a distinctive error is never the same as a stuck timeout");
});

// ---- final review: a stuck step names a place, not a cause, and a stuck match needs the whole message to agree
const ELECTRON_STUCK = "Error: Timed out waiting for electron main-process evaluate\n\n   at ..\\helpers\\testRefs.ts:56\n\n  54 |     }\n> 56 |     throw new Error('Timed out waiting for electron main-process evaluate');\n    at evaluateInMainProcess (D:\\a\\desktop\\desktop\\e2e\\helpers\\testRefs.ts:56:11)";
test("a stuck step is never the same failure as a cleared one: sameFailure needs a distinctive error", () => {
  // A is cleared on trunk: this step failed once in its history and the last trunk run passed.
  const aFinding = classify({ file: "window_position.test.ts", title: "A", error: ELECTRON_STUCK }, [obs({ status: "passed", commit_sha: "t0" }), obs({ status: "failed", error_excerpt: ELECTRON_STUCK, commit_sha: "t1" }), ...trunkPasses(8)], []);
  assert.equal(aFinding.class, "FLAKY_ON_TRUNK");
  // B fails the same way: a PR that breaks the main process. It has no history of its own to clear it.
  const b = classify({ file: "window_position.test.ts", title: "B", error: ELECTRON_STUCK }, trunkPasses(8), []);
  assert.equal(b.class, "REGRESSION");
  const [, out] = sameFailure([aFinding, b]);
  assert.equal(out.class, "REGRESSION", "the stuck step does not make B the cleared failure");
  assert.equal(out.blocking, true);
});

test("a stuck match needs the whole message to agree: a different wait in seconds is a different failure", () => {
  const det = "Test Failed: 10.0sec timeout expired without matching of given matcher: not null\n\n    at InteractiveDialogScreen.expectHydratedFilePreview (/x/interactive_dialog.ts:189:42)";
  const other = det.replace("10.0sec", "5.0sec");
  const f = classify(judgedTest(det), [...trunkPasses(8), ...failedOn([31, 32, 33], other)], []);
  assert.notEqual(f.class, "FLAKY_CROSS_PR", "three PRs that waited 5.0sec did not fail the same way");
  const same = classify(judgedTest(det), [...trunkPasses(8), ...failedOn([31, 32, 33], det)], []);
  assert.equal(same.class, "FLAKY_CROSS_PR", "the same wait is the same failure");
});

// ---- outcomes: a run triage does not judge says why; a red lane with no failed test says what to re-run ----
const statusSink = (statuses: StatusBody[]): Route => ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }];
test("a run a newer dispatch replaced is not triaged: the summary names that run, no status is written, and it is not a failure", async () => {
  for (const mode of ["enforce", "report-only"]) {
    await inTmp(async (dir) => {
      const statuses: StatusBody[] = [];
      const summaryPath = join(dir, "s.md");
      const findingsPath = join(dir, "findings.json");
      // This group is run 13's: a newer dispatch of the same commit and suite than the run triage was given (12).
      const fetchImpl = fakeFetch([
        ["/reports?", () => Response.json({ reports: [{ id: "g9", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "13", gh_run_attempt: "1", status: "completed", gh_pr_number: "5", branch: "pr-5" }] })],
        statusSink(statuses),
      ]);
      await assert.rejects(() => triage({ env: { ...env, MODE: mode, GITHUB_STEP_SUMMARY: summaryPath, FINDINGS_FILE: findingsPath }, fetchImpl, log: () => {} }), NotTriagedError);
      const summary = readFileSync(summaryPath, "utf8");
      assert.match(summary, /^## E2E triage · playwright-full: ⚠️ not triaged$/m, mode);
      assert.match(summary, /^\*\*Not triaged: run \[13\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/13\) replaced this one for playwright-full; see that run's triage\.\*\*$/m, mode);
      assert.deepEqual(statuses, [], `${mode}: the newer run owns the lane's status`);
      const record = parsed<Record<string, unknown>>(readFileSync(findingsPath, "utf8"));
      assert.deepEqual(checkFindingsShape(record), [], mode);
      assert.equal(record.triaged, false, mode);
      assert.match(String(record.not_triaged_reason), /^superseded: run 13 /, mode);
    });
  }
});

test("a run TSIO has no results for is not triaged: the summary says the tests may not have run, and the red status keeps its state with a note", async () => {
  for (const mode of ["enforce", "report-only"]) {
    await inTmp(async (dir) => {
      const statuses: StatusBody[] = [];
      const summaryPath = join(dir, "s.md");
      const findingsPath = join(dir, "findings.json");
      const fetchImpl = fakeFetch([["/reports?", () => Response.json({ reports: [] })], statusSink(statuses)]);
      // The default status is failure from run 12, this run: the note goes on it and the state stays.
      await assert.rejects(() => triage({ env: { ...env, MODE: mode, GITHUB_STEP_SUMMARY: summaryPath, FINDINGS_FILE: findingsPath }, fetchImpl, log: () => {} }), /no group for/, mode);
      assert.match(readFileSync(summaryPath, "utf8"), /^\*\*Not triaged: TSIO has no results for playwright-full at abc \(the tests may not have run\)\.\*\*$/m, mode);
      assert.deepEqual(statuses.map((s) => [s.context, s.state, s.description]), [["e2e-test/playwright", "failure", "(not triaged: no results)"]], mode);
      const record = parsed<Record<string, unknown>>(readFileSync(findingsPath, "utf8"));
      assert.equal(record.triaged, false, mode);
      assert.match(String(record.not_triaged_reason), /^no_results: /, mode);
    });
  }
});

test("a lane red with no failed test says a job outside the tests failed, and writes no status", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    // Every test passed, and the lane's own status is red (the fake's default, from this run).
    await triage({
      env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryPath },
      fetchImpl: fakeFetch([...runRoutes([spec("t1", "passed")]), statusSink(statuses)]),
      log: () => {},
    });
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /^## E2E triage · playwright-full: 🔴 red outside the tests$/m);
    assert.match(summary, /^\*\*No test failed\. The lane is red because a job outside the tests failed \(setup, upload or runner\), or results are missing: re-run the failed jobs\.\*\*/m);
    assert.deepEqual(statuses, [], "a verdict for a red lane that no test failed in would be a guess: nothing is written");
  });
});

test("a red lane whose reports never all arrived says how many did, and keeps the missing-reports status", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    const routes: Route[] = [
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "in_progress", total_reports_expected: 2 }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json(spec("t1", "passed"))],
      ["/reports/g1", () => Response.json({ id: "g1", status: "in_progress", total_reports_expected: 2, reports: [{}] })],
      statusSink(statuses),
    ];
    await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch(routes), log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.match(readFileSync(summaryPath, "utf8"), /^\*\*Re-run the failed jobs: 1 of 2 reports arrived; 1 of 2 reports never uploaded, so the specs on those workers never ran\.\*\*/m);
    assert.deepEqual(statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => [s.state, s.description]), [["failure", "(1 report(s) missing) 100% passed (1 passed, 0 failed, 0 skipped)"]]);
  });
});

test("a test that also failed on other platforms in this run says so in its why, and adds one headline line", () => {
  const onOthers = finding({ title: "t1", file: "specs/a.spec.ts", other_lanes: [{ platform: "android", result: "failed" }, { platform: "ios", result: "timedOut" }] });
  const text = renderSummary({ findings: [onOthers], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" });
  assert.match(text, /^## E2E triage: ✅ none caused by this PR$/m, "the bucket and the headline do not change");
  assert.match(text, /^1 test failed on several platforms in this run\.$/m);
  assert.match(text, /Also failed on android, ios in this run: likely environment or a shared cause\./);
  // Passed elsewhere: no line and no why. (A failed try that a retry recovered does count: see the Windows test.)
  const passedOn = finding({ title: "t1", file: "specs/a.spec.ts", other_lanes: [{ platform: "android", result: "passed" }, { platform: "ios", result: "passed" }] });
  const quiet = renderSummary({ findings: [passedOn], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" });
  assert.doesNotMatch(quiet, /several platforms|Also failed/);
});

test("the findings file is written for a judged run, with one shape and the failing tests in it", async () => {
  await inTmp(async (dir) => {
    const findingsPath = join(dir, "findings.json");
    // Master fails the test too, so the rules clear it: no model, no token.
    const statuses: StatusBody[] = [];
    const fetchImpl = fakeFetch([...runRoutes([spec("t1", "failed")]), ["/reports/history", () => Response.json({ observations: trunkFailsAll(8) })], ["/pulls/5/files", () => Response.json([])], ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })], statusSink(statuses)]);
    await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", FINDINGS_FILE: findingsPath }, fetchImpl, log: () => {} });
    const record = parsed<Record<string, unknown>>(readFileSync(findingsPath, "utf8"));
    assert.deepEqual(checkFindingsShape(record), []);
    assert.equal(record.schema, 1);
    assert.deepEqual([record.triaged, record.not_triaged_reason, record.verdict, record.mode], [true, null, "SUCCESS", "enforce"]);
    assert.deepEqual([record.repository, record.commit_sha, record.pr, record.lane, record.status_context, record.run_id, record.run_attempt], ["o/r", "abc", 5, "playwright-full", "e2e-test/playwright", "12", "1"]);
    assert.deepEqual(record.counts, { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 });
    assert.deepEqual(record.ai, { calls: 0, cost_usd: 0, model: null }, "no call, no cost, no model");
    const [row] = parsed<{ findings: Record<string, unknown>[] }>(readFileSync(findingsPath, "utf8")).findings;
    assert.deepEqual([row.title, row.file, row.class, row.blocking, row.error_first_line, row.tries, row.other_lanes_failed], ["t1", "specs/a.spec.ts", "BROKEN_ON_TRUNK", false, "Error: expected visible", { ran: 1, failed: 1 }, []]);
  });
});

test("a run that breaks off writes a findings file that says why, with no token in it", async () => {
  await inTmp(async (dir) => {
    const findingsPath = join(dir, "findings.json");
    const token = `ghp_${"x".repeat(36)}`;
    const fetchImpl = fakeFetch([...runRoutes([spec("t1", "failed")]), ["/reports/history", () => { throw new Error(`history down, token ${token}`); }]]);
    await assert.rejects(() => triage({ env: { ...env, MODE: "report-only", FINDINGS_FILE: findingsPath }, fetchImpl, log: () => {} }), /history down/);
    const text = readFileSync(findingsPath, "utf8");
    assert.equal(text.includes(token), false, "the token is never written");
    const record = parsed<Record<string, unknown>>(text);
    assert.deepEqual(checkFindingsShape(record), []);
    assert.deepEqual([record.triaged, String(record.not_triaged_reason).startsWith("error: history down, token [redacted]")], [false, true]);
  });
});

test("the findings file has one shape, and the shape check names what drifts from it", () => {
  assert.equal(FINDINGS_SCHEMA, 1);
  const good = { schema: 1, repository: "o/r", commit_sha: "abc", pr: null, lane: null, status_context: null, run_id: null, run_attempt: null, mode: "report-only", verdict: null, counts: null, ai: { calls: 0, cost_usd: null, model: null }, triaged: false, not_triaged_reason: "error: x", findings: [] };
  assert.deepEqual(checkFindingsShape(good), []);
  assert.ok(checkFindingsShape({ ...good, schema: 2 }).length > 0, "a different schema is named");
  assert.ok(checkFindingsShape({ ...good, triaged: true, not_triaged_reason: null }).length > 0, "a triaged run has its verdict");
  assert.ok(checkFindingsShape({ ...good, extra: 1 }).length > 0, "no field outside the schema");
  assert.ok(checkFindingsShape({ ...good, findings: [{ title: "t", error_first_line: "a\nb" }] }).length > 0, "one line of error, never a stack");
});

test("tokens are redacted from the findings file: GitHub and Anthropic tokens, and the action's own secrets", () => {
  assert.equal(redact("x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y", []), "x [redacted] y");
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnop", []), "key [redacted]");
  assert.equal(redact("auth Bearer abc.def.ghi", []), "auth [redacted]");
  assert.equal(redact("saw S3CRET-VALUE twice", ["S3CRET-VALUE"]), "saw [redacted] twice");
});

// ---- other platforms: from the run's own reports (desktop: one group, one report per OS) and its sibling groups (mobile), model off ----
test("a report name names its platform: the OS in it, else the name without the e2e prefix", () => {
  assert.equal(laneOfReport("e2e-on-ubuntu-latest-1.0"), "linux");
  assert.equal(laneOfReport("e2e-on-windows-2022-1.0"), "windows");
  assert.equal(laneOfReport("e2e-on-macos-14-1.0"), "macos");
  assert.equal(laneOfReport("e2e-on-something-else"), "something-else");
});
const oneGroupPerOS = (linux: string, windows: string, macos: string): Route[] => [
  ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
  ["/reports/g1/suites", () => Response.json({ suites: [
    { id: "s-linux", file_path: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-1.0" },
    { id: "s-windows", file_path: "specs/a.spec.ts", report_name: "e2e-on-windows-2022-1.0" },
    { id: "s-macos", file_path: "specs/a.spec.ts", report_name: "e2e-on-macos-14-1.0" },
  ] })],
  ["/reports/g1/cases", () => Response.json([caseRow("t1", linux, 0, "s-linux"), caseRow("t1", windows, 0, "s-windows"), caseRow("t1", macos, 0, "s-macos")])],
];
const quietPR: Route[] = [
  ["/reports/history", () => Response.json({ observations: [] })],
  ["/pulls/5/files", () => Response.json([])],
  ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
  ["/statuses/abc", () => Response.json({})],
];
test("desktop's one group holds every OS report: the same test that also failed on the others says so, model off", async () => {
  const desktop = { ...env, ANTHROPIC_API_KEY: "", REPORT_NAME: "e2e-on-ubuntu-latest", LANE: "linux", COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "desktop-pr", gh_pr_number: 5 }) };
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    await triage({ env: { ...desktop, GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch([...oneGroupPerOS("failed", "failed", "failed"), ...quietPR]), log: () => {} });
    const text = readFileSync(summaryPath, "utf8");
    assert.match(text, /Also failed on macos, windows in this run: likely environment or a shared cause\./, "the other two OS reports name the lanes, sorted");
    assert.match(text, /^1 test failed on several platforms in this run\.$/m);
  });
});
test("Windows writes the same test's full title with backslashes, and a failed try that retry recovered counts as failed there", async () => {
  const desktop = { ...env, ANTHROPIC_API_KEY: "", REPORT_NAME: "e2e-on-ubuntu-latest", LANE: "linux", COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "desktop-pr", gh_pr_number: 5 }) };
  const routes: Route[] = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "desktop-pr", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [
      { id: "s-linux", file_path: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-1.0" },
      { id: "s-windows", file_path: "specs/a.spec.ts", report_name: "e2e-on-windows-2022-1.0" },
    ] })],
    ["/reports/g1/cases", () => Response.json([
      { suite_id: "s-linux", title: "t1", full_title: "specs/a.spec.ts > t1", status: "failed", retry_count: 0, ordinal: 0, error_message: "Error: expected visible", error_stack: null },
      { suite_id: "s-windows", title: "t1", full_title: "specs\\a.spec.ts > t1", status: "flaky", retry_count: 0, ordinal: 0, error_message: null, error_stack: null },
    ])],
  ];
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    await triage({ env: { ...desktop, GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch([...routes, ...quietPR]), log: () => {} });
    assert.match(readFileSync(summaryPath, "utf8"), /Also failed once on windows in this run \(passed on retry\): likely environment or a shared cause\./);
  });
});
test("the other-platform wording says what each platform did: failed, once (passed on retry), or both", () => {
  const sentence = (other_lanes: { platform: string; result: string }[]): string => {
    const text = renderSummary({ findings: [finding({ title: "t1", file: "specs/a.spec.ts", other_lanes })], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" });
    return text.match(/Also (?:failed|once)[^|]*?in this run[^|]*?\./)?.[0] ?? "";
  };
  assert.equal(sentence([{ platform: "macos", result: "failed" }, { platform: "windows", result: "timedOut" }]), "Also failed on macos, windows in this run: likely environment or a shared cause.");
  assert.equal(sentence([{ platform: "windows", result: "flaky" }]), "Also failed once on windows in this run (passed on retry): likely environment or a shared cause.");
  assert.equal(sentence([{ platform: "macos", result: "failed" }, { platform: "windows", result: "flaky" }]), "Also failed on macos, and once on windows (passed on retry), in this run: likely environment or a shared cause.");
});
test("a test that passed on the other OS reports has no other-platform line", async () => {
  const desktop = { ...env, ANTHROPIC_API_KEY: "", REPORT_NAME: "e2e-on-ubuntu-latest", LANE: "linux", COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "desktop-pr", gh_pr_number: 5 }) };
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    await triage({ env: { ...desktop, GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch([...oneGroupPerOS("failed", "passed", "passed"), ...quietPR]), log: () => {} });
    const text = readFileSync(summaryPath, "utf8");
    assert.doesNotMatch(text, /several platforms|Also failed/);
  });
});
const siblingGroups = (self: string, ios: string): Route[] => [
  ["/reports?", () => Response.json({ reports: [
    { id: "g1", repository: "o/r", commit: "abc", name: "detox-android", gh_run_id: "12", gh_run_attempt: "1", status: "completed" },
    { id: "g2", repository: "o/r", commit: "abc", name: "detox-ios", gh_run_id: "12", gh_run_attempt: "1", status: "completed" },
  ], total: 2 })],
  ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
  ["/reports/g1/cases", () => Response.json([caseRow("t1", self)])],
  ["/reports/g2/suites", () => Response.json({ suites: [{ id: "s2", file_path: "specs/a.spec.ts" }] })],
  ["/reports/g2/cases", () => Response.json([caseRow("t1", ios, 0, "s2")])],
];
const androidLane = { ...env, ANTHROPIC_API_KEY: "", COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "detox-android", gh_pr_number: 5 }) };
test("a mobile lane's sibling groups name the same failure on the other platforms, with the model off", async () => {
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    await triage({ env: { ...androidLane, GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch([...siblingGroups("failed", "failed"), ...quietPR]), log: () => {} });
    assert.match(readFileSync(summaryPath, "utf8"), /Also failed on detox-ios in this run: likely environment or a shared cause\./);
  });
});
test("a run with nothing failed reads no sibling group: no call for another platform", async () => {
  const fetchImpl = fakeFetch([...siblingGroups("passed", "failed"), ...quietPR]);
  await triage({ env: androidLane, fetchImpl, log: () => {} });
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reports?")).length, 1, "only this lane's own report list");
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reports/g2")).length, 0, "the sibling group is not read");
});

// ---- review fixes: wording on rows that blame this PR, the answer-cache key, sibling keys, deadline, superseded links, redaction ----
test("a row that blames this PR never says the cause is environmental: the other platforms are named, neutrally", () => {
  const yours = finding({ title: "t1", file: "specs/a.spec.ts", class: "OWNED_BY_PR", blocking: true, other_lanes: [{ platform: "windows", result: "failed" }] });
  const text = renderSummary({ findings: [yours], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" });
  const row = text.split("\n").find((l) => l.startsWith("| t1 ")) ?? "";
  assert.match(row, /Also failed on windows in this run\./);
  assert.doesNotMatch(row, /environment|shared cause/, "a change to this PR is not steered toward the environment");
});

test("the answer-cache key ignores the other-platform evidence, and is the v5 key for the same pack", () => {
  const pack = { test: { title: "t1", full_title: null, suite: null, file: "specs/a.spec.ts", report_scope: null, report_name: null }, error: "Error: expected visible", engine: { class: "REGRESSION", reason: "r" }, trunk_history_14d: { runs: 8, fails: 0, flaky: 0, latest: "passed" }, cross_pr_failures_14d: { id: "cross_pr", other_prs_where_this_test_failed: [], other_pr_runs_where_it_passed: 0 }, pr: { number: 5, repository: "o/r", title: "t", changed_file_count: 1, changed_files: ["app/x.ts"], spec_file_changed_by_pr: false }, diff_hunks_of_files_named_in_error: [], other_failures_in_same_run: [] } as unknown as Pack;
  const withOthers = { ...pack, same_test_other_platforms_this_run: { id: "other_platforms", results: [{ platform: "windows", result: "failed" }] } } as unknown as Pack;
  assert.equal(answerKey("claude-sonnet-5-5", withOthers), answerKey("claude-sonnet-5-5", pack), "the evidence is not part of the key");
  // v5 for this pack: SYSTEM gained the earlier_failure_same_spec rule, so every v4 answer is a miss by design. A
  // cached v5 answer keeps this key, so no call is paid again.
  assert.match(answerKey("claude-sonnet-5-5", pack), /^v5:/);
  assert.equal(answerKey("claude-sonnet-5-5", pack), "v5:bcf80891c4782faa31109b2aa041f4d7dcee0d874de8705f6cde091fe0bd8994");
});

test("a sibling's same leaf title in another describe block is another test: no other-platform line", async () => {
  const g1 = { id: "g1", repository: "o/r", commit: "abc", name: "detox-android", gh_run_id: "12", gh_run_attempt: "1", status: "completed" };
  const g2 = { id: "g2", repository: "o/r", commit: "abc", name: "detox-ios", gh_run_id: "12", gh_run_attempt: "1", status: "completed" };
  const fetchImpl = fakeFetch([
    ["/reports?", () => Response.json({ reports: [g1, g2], total: 2 })],
    ["/reports/g2/suites", () => Response.json({ suites: [{ id: "s2", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g2/cases", () => Response.json([{ suite_id: "s2", title: "t1", full_title: "B > t1", status: "failed", retry_count: 0, ordinal: 0, error_message: "Error: expected visible", error_stack: null }])],
  ]);
  const f = finding({ title: "t1", full_title: "A > t1", file: "specs/a.spec.ts", class: "REGRESSION", blocking: true });
  await siblingPlatforms({ findings: [f], fetchImpl, base: "http://tsio", id: { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "detox-android" }, log: () => {} });
  assert.equal(f.other_lanes, undefined, "B > t1 is not A > t1");
});

test("the sibling reads share one deadline: a read that runs past it is skipped and logged, and the next is not started", async () => {
  const g = (id: string, name: string) => ({ id, repository: "o/r", commit: "abc", name, gh_run_id: "12", gh_run_attempt: "1", status: "completed" });
  const slowFetch: FetchImpl = async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/reports/g2/")) await new Promise((r) => setTimeout(r, 300));
    return fakeFetch([
      ["/reports?", () => Response.json({ reports: [g("g1", "detox-android"), g("g2", "detox-ios"), g("g3", "detox-web")], total: 3 })],
      ["/reports/g2/suites", () => Response.json({ suites: [{ id: "s2", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g2/cases", () => Response.json([caseRow("t1", "failed", 0, "s2")])],
      ["/reports/g3/suites", () => Response.json({ suites: [{ id: "s3", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g3/cases", () => Response.json([caseRow("t1", "failed", 0, "s3")])],
    ])(url, init);
  };
  const logs: string[] = [];
  const f = finding({ title: "t1", file: "specs/a.spec.ts", class: "REGRESSION", blocking: true });
  await siblingPlatforms({ findings: [f], fetchImpl: slowFetch, base: "http://tsio", id: { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "detox-android" }, log: (m) => logs.push(m), deadlineMs: 100 });
  assert.ok(logs.some((m) => /deadline/.test(m)), `the skipped read is logged: ${JSON.stringify(logs)}`);
  assert.equal(f.other_lanes, undefined, "the read past the deadline adds nothing");
});

test("the sibling list is read once for the run, not once per sibling", async () => {
  const g = (id: string, name: string) => ({ id, repository: "o/r", commit: "abc", name, gh_run_id: "12", gh_run_attempt: "1", status: "completed" });
  const fetchImpl = fakeFetch([
    ["/reports?", () => Response.json({ reports: [g("g1", "detox-android"), g("g2", "detox-ios"), g("g3", "detox-web")], total: 3 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g1/cases", () => Response.json([caseRow("t1", "failed")])],
    ["/reports/g2/suites", () => Response.json({ suites: [{ id: "s2", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g2/cases", () => Response.json([caseRow("t1", "failed", 0, "s2")])],
    ["/reports/g3/suites", () => Response.json({ suites: [{ id: "s3", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g3/cases", () => Response.json([caseRow("t1", "passed", 0, "s3")])],
    ["/reports/history", () => Response.json({ observations: [] })],
    ["/pulls/5/files", () => Response.json([])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", () => Response.json({})],
  ]);
  await triage({ env: androidLane, fetchImpl, log: () => {} });
  const lists = fetchImpl.calls.filter((c) => c.url.includes("/reports?"));
  assert.equal(lists.length, 2, "this lane's own list, and one list for its siblings");
});

test("a sibling read on an infrastructure storm is never started: the other platforms explain nothing there", async () => {
  let asked = 0;
  const failing = Array.from({ length: 40 }, (_, i) => ({ file: "specs/a.spec.ts", title: `t${i}`, full_title: null, suite_title: null, report_name: null, report_scope: null, identity_ambiguous: false, identity_unresolved: false, error: "Error: expected visible", tries: { ran: 1, failed: 1 } }));
  const run = { group_id: "g1", failing, missing: null, outcomes: new Map(), elsewhere: new Map(), counts: { total: 40, passed: 0, failed: 40, flaky: 0, skipped: 0 } } as unknown as RunResult;
  const result = await evaluateRun({ run, id: { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "detox-android" }, prNumber: 5, history: new Map(), diff: { files: [], ok: true }, trunkBranch: "master", testRoot: ".", otherPlatforms: async () => { asked += 1; } });
  assert.ok(result.infra, "forty failures are an infrastructure storm");
  assert.equal(asked, 0, "no sibling read on a storm");
});

test("a case with no title does not break a run's read: the key for it is empty, not a crash", async () => {
  const fetchImpl = fakeFetch([
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "detox-android", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
    ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: null, full_title: null, status: "passed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }])],
  ]);
  const run = await fetchRun(fetchImpl, "http://tsio", { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "detox-android" }, null, { attempts: 1, ms: 0 });
  assert.equal(run.counts.passed, 1);
  assert.equal(elsewhereKey("specs/a.spec.ts", null as unknown as string), elsewhereKey("specs/a.spec.ts", ""));
});

test("a superseded run links to its replacement only when that run is of the same PR; another PR's replacement is named without a link", async () => {
  for (const [pr, linked] of [["5", true], ["6", false]] as const) {
    await inTmp(async (dir) => {
      const statuses: StatusBody[] = [];
      const summaryPath = join(dir, "s.md");
      const fetchImpl = fakeFetch([
        ["/reports?", () => Response.json({ reports: [{ id: "g9", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "13", gh_run_attempt: "1", status: "completed", gh_pr_number: pr, branch: "pr-5" }] })],
        statusSink(statuses),
      ]);
      await assert.rejects(() => triage({ env: { ...env, MODE: "enforce", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} }), NotTriagedError);
      const summary = readFileSync(summaryPath, "utf8");
      if (linked) assert.match(summary, /\*\*Not triaged: run \[13\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/13\) replaced this one for playwright-full; see that run's triage\.\*\*/, pr);
      else {
        assert.match(summary, /\*\*Not triaged: another run of this commit replaced this one for playwright-full\.\*\*/, pr);
        assert.doesNotMatch(summary, /actions\/runs\/13/, "no link to another PR's run");
      }
      assert.deepEqual(statuses, [], "no status either way");
    });
  }
});

test("zero failures with missing reports says both how many arrived and what never ran", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    const routes: Route[] = [
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "in_progress", total_reports_expected: 2 }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json(spec("t1", "passed"))],
      ["/reports/g1", () => Response.json({ id: "g1", status: "in_progress", total_reports_expected: 2, reports: [{}] })],
      statusSink(statuses),
    ];
    await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl: fakeFetch(routes), log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.match(readFileSync(summaryPath, "utf8"), /\*\*Re-run the failed jobs: 1 of 2 reports arrived; 1 of 2 reports never uploaded, so the specs on those workers never ran\.\*\*/m);
  });
});

test("redaction strips a URL's query string and the value of any credential-named key, in any case", () => {
  assert.equal(redact("see https://x.test/cb?code=abc&state=1 now", []), "see https://x.test/cb?[redacted] now");
  assert.equal(redact("token=abc123 and password: hunter2", []), "token=[redacted] and password: [redacted]");
  assert.equal(redact("Authorization: Bearer xyz.123", []), "Authorization: [redacted]");
  assert.equal(redact("API_KEY=zzz", []), "API_KEY=[redacted]");
  assert.equal(redact("license:abc", []), "license:[redacted]");
  assert.equal(redact("SECRET=val", []), "SECRET=[redacted]");
  assert.equal(redact("github_token=ghx", []), "github_token=[redacted]");
  assert.equal(redact("status: passed; tokens are fine", []), "status: passed; tokens are fine", "ordinary text is untouched");
});

test("an other-platform entry keeps the worst result for its OS: failed over once over passed", () => {
  const run = { elsewhere: new Map([[elsewhereKey("specs/a.spec.ts", "t1"), [{ report: "e2e-on-windows-2022-1.0", status: "passed" }, { report: "e2e-on-windows-11-1.0", status: "flaky" }, { report: "e2e-on-macos-14-1.0", status: "flaky" }, { report: "e2e-on-macos-15-1.0", status: "failed" }]]]) } as unknown as Pick<RunResult, "elsewhere">;
  const f = finding({ title: "t1", file: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-1.0" });
  sameTestOnOtherReports([f], run);
  assert.deepEqual(f.other_lanes, [{ platform: "macos", result: "failed" }, { platform: "windows", result: "flaky" }]);
});

test("other workers and shards of the same lane are not other platforms", () => {
  // Mattermost reports are per worker; desktop shards one OS across reports. Neither is a second platform.
  const run = { elsewhere: new Map([[elsewhereKey("specs/a.spec.ts", "t1"), [{ report: "e2e-cypress / cypress-full / dispatch-run-12", status: "failed" }, { report: "e2e-on-ubuntu-latest-2-of-3-1.0", status: "failed" }]]]) } as unknown as Pick<RunResult, "elsewhere">;
  const worker = finding({ title: "t1", file: "specs/a.spec.ts", report_name: "e2e-cypress / cypress-full / dispatch-run-4" });
  sameTestOnOtherReports([worker], run);
  assert.equal(worker.other_lanes, undefined, "a mattermost worker names no OS");
  const shard = finding({ title: "t1", file: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-1-of-3-1.0" });
  sameTestOnOtherReports([shard], run);
  assert.equal(shard.other_lanes, undefined, "another linux shard is the same platform");
});

// ---------------------------------------------------------------- branch state, trunk fallback, unnamed failures, change categories, status labels

const branchError = 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"';
const branchTest: TestRef = { ...failing, error: branchError };
/**
 * The fake with the repository read answering the default branch. A route matches any URL that contains its text, so
 * "/repos/o/r" would also take the commit statuses; this answers the exact repository URL only, and records the call.
 */
function withDefaultBranch(fake: FakeFetch, branch: string): FakeFetch {
  const impl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (/\/repos\/o\/r$/.test(String(url))) {
      fake.calls.push({ url: String(url), init });
      return Response.json({ default_branch: branch });
    }
    return fake(url, init);
  };
  return Object.assign(impl, { calls: fake.calls });
}
/** This PR's earlier run of the test: its status and the error it showed, with the commit it ran on. */
const prRun = (sha: string, status: string, error: string | null = branchError, at = "2026-09-12T00:00:00Z"): Observation =>
  obs({ gh_pr_number: 5, status, commit_sha: sha, created_at: at, error_excerpt: error });

test("branch state: failing the same way on this PR's last commits, and never on trunk, is held out of date, not cleared", () => {
  const f = classify(branchTest, [prRun("c2", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z"), ...trunkPasses(8)], [], DEFAULTS, 5);
  assert.equal(f.class, "BRANCH_STATE");
  assert.equal(f.blocking, true);
  assert.deepEqual(f.out_of_date, { base: "the default branch", behind: null, commit: null, streak: 3 });
  assert.equal(f.reason, "Failed the same way on this PR's last 3 commits and never on the default branch: the branch is behind or broken; merge the default branch and re-run.");
});

test("branch state comes before the environment rule: an infrastructure error repeated on this PR's commits is held, not cleared", () => {
  const infra = 'Error: server at "http://localhost:8065" is not healthy after 30 seconds of retries';
  const cfg = { ...DEFAULTS, infraClears: true };
  const held = classify({ ...branchTest, error: infra }, [prRun("c2", "failed", infra), prRun("c1", "failed", infra), ...trunkPasses(8)], [], cfg, 5);
  assert.equal(held.class, "BRANCH_STATE");
  assert.equal(held.blocking, true);
  assert.equal(classify({ ...branchTest, error: infra }, [...trunkPasses(8)], [], cfg, 5).class, "INFRA_ERROR", "one failing commit is still the environment's, as before");
});

test("branch state needs a streak: one failing commit, or a pass that ends the run of failures, leaves the rules as they were", () => {
  assert.notEqual(classify(branchTest, [...trunkPasses(8)], [], DEFAULTS, 5).class, "BRANCH_STATE", "a single failing commit");
  const broken = [prRun("c2", "passed", null), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z"), prRun("c0", "failed", branchError, "2026-09-10T00:00:00Z")];
  assert.notEqual(classify(branchTest, [...broken, ...trunkPasses(8)], [], DEFAULTS, 5).class, "BRANCH_STATE", "the newest earlier run passed, so the streak is the current run alone");
  const otherLine = 'Error: expect(locator).toHaveText(expected) failed: expected "Team header" but received "Set a header"';
  assert.notEqual(classify(branchTest, [prRun("c2", "failed", otherLine), prRun("c1", "failed"), ...trunkPasses(8)], [], DEFAULTS, 5).class, "BRANCH_STATE", "a different first line on this PR is not the same failure");
});

test("branch state counts commits, not runs: re-runs of one commit are one, and re-runs of this commit add nothing", () => {
  const reruns = [prRun("c1", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z")];
  assert.equal(classify(branchTest, [...reruns, ...trunkPasses(8)], [], DEFAULTS, 5, null, { commitSha: "c1" }).class !== "BRANCH_STATE", true, "two runs of the current commit are one commit");
  const held = classify(branchTest, [...reruns, ...trunkPasses(8)], [], DEFAULTS, 5, null, { commitSha: "c9" });
  assert.equal(held.class, "BRANCH_STATE");
  assert.equal(held.out_of_date?.streak, 2, "c1 twice and the current commit are two commits");
});

test("branch state needs enough trunk history to say the failure never happened there", () => {
  const earlier = [prRun("c2", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z")];
  assert.notEqual(classify(branchTest, [...earlier, ...trunkPasses(DEFAULTS.minTrunkRuns - 1)], [], DEFAULTS, 5).class, "BRANCH_STATE");
  assert.equal(classify(branchTest, [...earlier, ...trunkPasses(DEFAULTS.minTrunkRuns)], [], DEFAULTS, 5).class, "BRANCH_STATE");
});

test("branch state holds when trunk fails the test with a different first line, and not when trunk fails it with the same one", () => {
  const otherLine = 'Error: expect(locator).toHaveText(expected) failed: expected "Team header" but received "Set a header"';
  const earlier = [prRun("c2", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z")];
  const trunkOther = obs({ status: "failed", error_excerpt: otherLine, commit_sha: "t9", created_at: "2026-09-01T00:00:00Z" });
  assert.equal(classify(branchTest, [...earlier, ...trunkPasses(8), trunkOther], [], DEFAULTS, 5).class, "BRANCH_STATE", "trunk failed another way: the branch is the difference");
  const trunkSame = obs({ status: "failed", error_excerpt: branchError, commit_sha: "t8", created_at: "2026-09-01T00:00:00Z" });
  assert.notEqual(classify(branchTest, [...earlier, ...trunkPasses(8), trunkSame], [], DEFAULTS, 5).class, "BRANCH_STATE", "trunk fails it the same way: not the branch");
});

test("branch state does not hold when trunk's latest run failed the test", () => {
  const otherLine = 'Error: expect(locator).toHaveText(expected) failed: expected "Team header" but received "Set a header"';
  const trunkLatestFailed = obs({ status: "failed", error_excerpt: otherLine, commit_sha: "t0", created_at: "2026-09-12T00:00:00Z" });
  assert.notEqual(classify(branchTest, [prRun("c2", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z"), trunkLatestFailed, ...trunkPasses(8)], [], DEFAULTS, 5).class, "BRANCH_STATE");
});

test("branch state, end to end: the check is red as out of date, the summary says merge and re-run, and the model is not asked", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    const routes: Route[] = [
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: "t1", status: "failed", retry_count: 0, ordinal: 0, error_message: branchError, error_stack: null }])],
      // The other-PRs query (no branch) gets this PR's rows only; the trunk query (branch master) gets trunk's.
      ["/reports/history", (i) => Response.json({ observations: parsed<HistoryBody>(bodyText(i)).branch ? trunkPasses(8) : [prRun("c2", "failed"), prRun("c1", "failed", branchError, "2026-09-11T00:00:00Z")] })],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
      statusSink(statuses),
    ];
    const fetchImpl = fakeFetch(routes);
    const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "AK", TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} });
    assert.equal(result.findings[0].class, "BRANCH_STATE");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length, 0, "held before the judge, so the model is not asked");
    assert.deepEqual(statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => [s.state, s.description]), [["failure", "(1 out of date) 0% passed (0 passed, 1 failed, 0 skipped)"]]);
    const text = readFileSync(summaryPath, "utf8");
    assert.match(text, /^## E2E triage · playwright-full: 🔴 merge master and re-run: 1 out of date$/m);
    assert.match(text, /^### Out of date \(1\): this PR fails the same way on its last commits and never on master$/m);
    assert.match(text, /\| Failed the same way on this PR's last 3 commits and never on master: the branch is behind or broken\. \| Merge master and re-run\. \|/);
  });
});

test("a PR whose base branch has too little history reads trunk from the default branch, and says so", async () => {
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    const history = (i: RequestInit): Response => Response.json({ observations: parsed<HistoryBody>(bodyText(i)).branch === "master" ? trunkFailsAll(8) : [] });
    const fetchImpl = withDefaultBranch(fakeFetch([
      ...runRoutes([spec("t1", "failed")]),
      ["/reports/history", history],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "stacked", base: { ref: "feature/base" } })],
      statusSink([]),
    ]), "master");
    const result = await triage({ env: { ...env, TRIAGE_CONTEXT: "off", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} });
    assert.equal(result.findings[0].trunk.runs, 8, "the default branch's runs judge the test");
    assert.equal(result.findings[0].class, "BROKEN_ON_TRUNK");
    assert.equal(fetchImpl.calls.filter((c) => /\/repos\/o\/r$/.test(c.url)).length, 1, "the default branch is read once");
    const text = readFileSync(summaryPath, "utf8");
    assert.match(text, /^> Trunk history is read from master, the default branch: feature\/base has 0 earlier runs of these tests, fewer than 5\.$/m);
    assert.match(text, /Fails on master's latest run too/);
  });
});

test("a PR whose base branch has enough history keeps it, and asks GitHub for no default branch", async () => {
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    const baseRows = trunkFailsAll(8).map((o) => ({ ...o, branch: "feature/base" }));
    const history = (i: RequestInit): Response => Response.json({ observations: parsed<HistoryBody>(bodyText(i)).branch === "feature/base" ? baseRows : [] });
    const fetchImpl = withDefaultBranch(fakeFetch([
      ...runRoutes([spec("t1", "failed")]),
      ["/reports/history", history],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "stacked", base: { ref: "feature/base" } })],
      statusSink([]),
    ]), "master");
    const result = await triage({ env: { ...env, TRIAGE_CONTEXT: "off", ANTHROPIC_API_KEY: "", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} });
    assert.equal(result.findings[0].trunk.runs, 8);
    assert.equal(fetchImpl.calls.filter((c) => /\/repos\/o\/r$/.test(c.url)).length, 0);
    assert.doesNotMatch(readFileSync(summaryPath, "utf8"), /Trunk history is read from/);
  });
});

test("trunkRunsOn counts a branch's runs with no PR, the most any one test has", () => {
  const rows = new Map<string, Observation[]>([
    ["a", [obs({ branch: "feature/base" }), obs({ branch: "feature/base" }), obs({ branch: "feature/base", gh_pr_number: 7 }), obs({ branch: "master" })]],
    ["b", [obs({ branch: "feature/base" }), obs({ branch: "feature/base" }), obs({ branch: "feature/base" })]],
  ]);
  assert.equal(trunkRunsOn(rows, "feature/base"), 3);
  assert.equal(trunkRunsOn(rows, "release"), 0);
});

test("a lane whose every failure names no test is red for a re-run: no history is read, nothing is asked, and the line says what arrived", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    const routes: Route[] = [
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "in_progress", total_reports_expected: 3 }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: "", status: "failed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }])],
      ["/reports/g1", () => Response.json({ id: "g1", status: "in_progress", total_reports_expected: 3, reports: [{}, {}] })],
      statusSink(statuses),
    ];
    const fetchImpl = fakeFetch(routes);
    const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "AK", TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.equal(result.verdict, "FAILURE");
    assert.equal(result.findings.length, 0, "nothing is classified");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length, 0, "no model call");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reports/history")).length, 0, "no history read");
    assert.match(readFileSync(summaryPath, "utf8"), /^\*\*Re-run the failed jobs: 2 of 3 reports arrived; 1 of 3 reports never uploaded, so the specs on those workers never ran\.\*\*/m);
    assert.deepEqual(statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => [s.state, s.description]), [["failure", "(re-run the failed jobs; 1 report(s) missing) 0% passed (0 passed, 1 failed, 0 skipped)"]]);
  });
});

test("a run whose only failures name no test, with every report in, says so: a re-run line, no model, red", async () => {
  await inTmp(async (dir) => {
    const summaryPath = join(dir, "s.md");
    const fetchImpl = fakeFetch([
      ...runRoutes([[{ suite_id: "s1", title: "", status: "failed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }]]),
    ]);
    const result = await triage({ env: { ...env, MODE: "report-only", ANTHROPIC_API_KEY: "AK", TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: summaryPath }, fetchImpl, log: () => {} });
    assert.equal(result.verdict, "FAILURE");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length, 0);
    assert.match(readFileSync(summaryPath, "utf8"), /^\*\*Re-run the failed jobs: 1 failed result with no test name\.\*\*/m);
  });
});

test("this_pr is citable only when this PR's most recent earlier run of the test passed, not after any earlier pass", () => {
  const since = fixture<SinceLastPass>({ files: [], related: [] });
  const latestFailed = classify(failing, [...trunkPasses(8), mine("failed", "new", "2026-09-12T00:00:00Z"), mine("passed", "old", "2026-09-10T00:00:00Z")], [], undefined, 1);
  const failedPack = buildPack({ ...latestFailed, since_last_pass: since }, [], prCtx, []);
  assert.equal(failedPack.this_pr_history?.passed, 1, "it passed on an earlier commit");
  assert.equal(failedPack.this_pr_history?.latest, "failed");
  assert.ok(!evidenceIds(failedPack).includes("this_pr"), "but its latest run failed, so the pass is not citable");
  const latestPassed = classify(failing, [...trunkPasses(8), mine("passed", "new", "2026-09-12T00:00:00Z"), mine("failed", "old", "2026-09-10T00:00:00Z")], [], undefined, 1);
  assert.ok(evidenceIds(buildPack({ ...latestPassed, since_last_pass: since }, [], prCtx, [])).includes("this_pr"), "the latest run passed");
});

test("the PR's changed files are sorted into product, e2e harness, ci, docs and other; an unknown file is product", () => {
  const ctx = { testRoot: "e2e-tests/playwright/specs", failingSpecs: ["e2e-tests/playwright/specs/a.spec.ts"] };
  assert.equal(changeCategory("webapp/channels/x.tsx", ctx), "product");
  assert.equal(changeCategory("some/new/unknown-file.bin", ctx), "product", "unknown files count as product");
  assert.equal(changeCategory("e2e-tests/playwright/specs/helpers/login.ts", ctx), "e2e_harness");
  assert.equal(changeCategory("e2e-tests/playwright/specs/a.spec.ts", ctx), "e2e_harness", "the failing spec is harness");
  assert.equal(changeCategory("e2e-tests/playwright/specs-old/x.ts", ctx), "product", "whole path segments only");
  assert.equal(changeCategory("e2e-tests/playwright/specs/README.md", ctx), "docs", "docs before harness");
  assert.equal(changeCategory(".github/workflows/e2e.yml", ctx), "ci");
  assert.equal(changeCategory("docs/e2e.md", ctx), "docs");
  assert.equal(changeCategory("LICENSE.txt", ctx), "other");
  assert.equal(changeCategory("e2e/x.ts", { testRoot: ".", failingSpecs: [] }), "product", "a test root of . names no harness folder");
  const names = [...Array.from({ length: 25 }, (_, i) => `webapp/f${i}.ts`), "docs/x.md", ".github/a.yml"];
  const summary = changeSummary(names, { testRoot: null, failingSpecs: [] });
  assert.equal(summary.product.count, 25);
  assert.equal(summary.product.examples.length, 20, "up to 20 example paths");
  assert.equal(summary.docs.count, 1);
  assert.equal(summary.ci.count, 1);
  assert.equal(summary.e2e_harness.count, 0);
});

test("the change summary is in the pack and clears nothing: no citation is added for it, and no same-run environment evidence", () => {
  const f = classify(failing, [...trunkPasses(8), mine("passed", "mid", "2026-09-11T00:00:00Z")], [], undefined, 1);
  const withCI = buildPack(f, [{ filename: ".github/ci.yml", patch: "@@" }], prCtx, [], { testRoot: "e2e-tests/playwright/specs", failingSpecs: [] });
  const withHarness = buildPack(f, [{ filename: "e2e-tests/playwright/specs/helpers/login.ts", patch: "@@" }], prCtx, [], { testRoot: "e2e-tests/playwright/specs", failingSpecs: [] });
  assert.equal(withCI.pr.change_summary?.ci.count, 1);
  assert.equal(withHarness.pr.change_summary?.e2e_harness.count, 1);
  assert.deepEqual(evidenceIds(withCI), evidenceIds(withHarness), "a category adds no evidence id");
  assert.equal(CLEARING(evidenceIds(withHarness)), CLEARING(evidenceIds(withCI)));
  assert.ok(!JSON.stringify(withHarness).includes("same_run_env"), "no environment-clearing citation");
});

test("the status text names each finding by its label, in the owner's order, and leaves out zero labels", () => {
  const cleared = (over: Partial<Finding>): Finding => finding({ blocking: false, ...over });
  const blocked = (over: Partial<Finding>): Finding => finding({ blocking: true, ...over });
  const judged = (cause: string, decision: string, blocking: boolean): Finding => blocked({ class: "REGRESSION", decision, blocking, judge: { cause, confidence: 0.9, cited_evidence: [], explanation: "x" } as Finding["judge"] });
  const mixed = [
    cleared({ class: "FLAKY_ON_TRUNK" }),
    cleared({ class: "REGRESSION", decision: "adjudicator_unblock", judge: { cause: "bug_on_master", confidence: 0.9, cited_evidence: [], explanation: "x" } as Finding["judge"] }),
    cleared({ class: "BROKEN_ON_TRUNK" }),
    judged("caused_by_pr", "adjudicator_blame", true),
    blocked({ class: "REGRESSION", out_of_date: { base: "master", behind: 3, commit: null } }),
    blocked({ class: "REGRESSION" }),
  ];
  assert.equal(statusDescription("FAILURE", mixed, null, { passed: 10, failed: 6, skipped: 0 }), "(1 flaky, 2 broken on main, 1 caused by PR, 1 out of date, 1 needs investigation) 62.5% passed (10 passed, 6 failed, 0 skipped)");
  assert.equal(statusDescription("SUCCESS", [cleared({ class: "FLAKY_ON_TRUNK" }), cleared({ class: "FLAKY_ON_TRUNK" })], null, { passed: 1186, failed: 2, skipped: 164 }), "(2 flaky) 99.8% passed (1186 passed, 2 failed, 164 skipped)");
  assert.equal(statusDescription("SUCCESS", [], null, { passed: 9, failed: 0 }), "100% passed (9 passed, 0 failed, 0 skipped)", "no labels, no brackets");
  assert.equal(statusDescription("SUCCESS", [cleared({ class: "SAME_FAILURE_AS_CLEARED", same_as_class: "BROKEN_ON_TRUNK" })], null, { passed: 9, failed: 1 }), "(1 broken on main) 90.0% passed (9 passed, 1 failed, 0 skipped)", "takes its anchor's label");
  assert.equal(statusDescription("SUCCESS", [cleared({ class: "SAME_FAILURE_AS_CLEARED", same_as_class: "FLAKY_ON_TRUNK" })], null, { passed: 9, failed: 1 }), "(1 flaky) 90.0% passed (9 passed, 1 failed, 0 skipped)");
  assert.deepEqual(statusLabels([blocked({ class: "REGRESSION" })], 1), ["needs investigation"].map((l) => `1 ${l}`));
  assert.equal(statusLabelOf(blocked({ class: "REGRESSION", judge: { cause: "caused_by_pr", confidence: 0.9, cited_evidence: [], explanation: "x" } as Finding["judge"], decision: "advice" })), "needs investigation", "advice is not a blame: the finding stays unlabelled as caused by PR");
});

test("the status text is at most 140 characters, keeps its pass line whole, and shortens the labels only as the last resort", () => {
  const many = [
    ...Array.from({ length: 60 }, () => finding({ class: "REGRESSION", blocking: true, decision: "adjudicator_blame", judge: { cause: "caused_by_pr", confidence: 0.9, cited_evidence: [], explanation: "x" } as Finding["judge"] })),
    ...Array.from({ length: 20 }, () => finding({ class: "FLAKY_ON_TRUNK", blocking: false })),
    ...Array.from({ length: 9 }, () => finding({ class: "REGRESSION", blocking: true, out_of_date: { base: "master", behind: 1, commit: null } })),
    ...Array.from({ length: 5 }, () => finding({ class: "REGRESSION", blocking: true })),
  ];
  const text = statusDescription("FAILURE", many, "investigation", { passed: 90, failed: 10, skipped: 0 }, { text: "x", short: "2 report(s) missing" });
  assert.ok(text.length <= 140, `length ${text.length}`);
  assert.match(text, /\) 90\.0% passed \(90 passed, 10 failed, 0 skipped\)$/, "the pass line is whole");
  assert.match(text, /^\(\d+ flaky/, "the labels are kept, shortened to fit");
  assert.ok(text.includes("…"), "shortened with an ellipsis");
});

// ---------------------------------------------------------------- shard placeholders, stale specs past the compare cap, chained failures

// Verbatim titles and errors: desktop e2e/utils/write-tsio-failure-stub.mjs, mobile detox/utils/merge-jest-results-for-tsio.js.
const DESKTOP_STUB = { file: "ci/tsio-shard-failure.ts", title: "[e2e-linux (2)] CI shard failure", error: "" };
const MOBILE_STUB = { file: "detox/e2e/test/products/channels/x.e2e.ts", title: "spec did not run", error: "detox/e2e/test/products/channels/x.e2e.ts was assigned to a shard but produced no result. The shard uploaded nothing, or its Jest process died before reaching this spec." };

test("shard placeholders are told from tests: no name, the desktop shard stub, and the mobile spec that did not run", () => {
  assert.ok(isShardPlaceholder(DESKTOP_STUB));
  assert.ok(isShardPlaceholder({ ...DESKTOP_STUB, error: "Playwright exited with code 1 and no results.json was written" }), "the stub's own file, whatever its reason");
  assert.ok(isShardPlaceholder(MOBILE_STUB));
  assert.ok(isShardPlaceholder({ file: "specs/a.spec.ts", title: "  ", error: "" }), "no test name");
  assert.equal(isShardPlaceholder({ file: "specs/a.spec.ts", title: "[x] CI shard failure", error: "Error: expected visible" }), false, "a real test with an error is a test");
  assert.equal(isShardPlaceholder({ ...MOBILE_STUB, error: "Error: expected visible" }), false, "the title alone is not enough");
  // Mobile .github/scripts/write-tsio-failure-stub.mjs, for a job that died before its reporter wrote results.
  assert.ok(isShardPlaceholder({ file: "ci/detox-android-2.stub", title: "CI infrastructure failure", error: "Detox job failed before writing test results" }));
  assert.equal(isShardPlaceholder({ file: "specs/a.spec.ts", title: "CI infrastructure failure", error: "Error: expected visible" }), false, "a real spec with that title is a test");
  assert.equal(isShardPlaceholder(failing), false);
});

test("a run of mobile specs that did not run is red for a re-run: no findings, no run flag, nothing judged, and they are not run, not failed", async () => {
  let asked = 0;
  const run = runOf([1, 2, 3].map((i) => ({ ...MOBILE_STUB, file: `detox/e2e/test/s${i}.e2e.ts` })));
  const result = await evaluate(run, { ask: async () => { asked++; return fixture<BatchResult>({ answers: [] }); } });
  assert.deepEqual(result.findings, []);
  assert.equal(result.unnamed, 3);
  assert.equal(result.notRun, 3);
  assert.equal(result.infra, null, "placeholders are not an environment storm of tests");
  assert.equal(result.verdict, "FAILURE");
  assert.equal(asked, 0);
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts, null, result.unnamed, result.notRun), "(re-run the failed jobs) 0 passed, 0 failed, 3 not run, 0 skipped");
  const text = renderSummary({ findings: result.findings, infra: result.infra, runURL: "u", counts: result.counts, trunkBranch: "master", unnamed: result.unnamed, notRun: result.notRun, notRunRerun: result.notRunRerun });
  assert.match(text, /^## E2E triage: 🔴 3 specs did not run, re-run the failed jobs$/m);
  assert.match(text, /^\*\*Re-run the failed jobs: 3 specs did not run, no result from their CI job\.\*\* 0 passed, 0 failed, 3 not run, 0 skipped · /m);
});

test("a lane red only for specs that never ran says so, without a pass rate that counts them as failed", () => {
  const counts = { total: 634, passed: 615, failed: 2, flaky: 1, skipped: 17 };
  const description = statusDescription("FAILURE", [], null, counts, null, 2, 2);
  assert.equal(description, "(re-run the failed jobs) 615 passed, 0 failed, 2 not run, 17 skipped");
  assert.ok(description.length <= 140, `length ${description.length}`);
  assert.equal(statusDescription("FAILURE", [], null, { ...counts, failed: 3 }, null, 1, 1), "(re-run the failed jobs) 615 passed, 2 failed, 1 not run, 17 skipped", "only the spec that did not run leaves the failed count");
  assert.equal(passLine(counts), "99.7% passed (615 passed, 2 failed, 17 skipped)", "a run with every spec run keeps its rate");
});

test("with re-runs allowed, a lane red only for jobs that sent no results asks for one, and says so; the last attempt does not", async () => {
  const counts = { total: 634, passed: 615, failed: 2, flaky: 1, skipped: 17 };
  assert.equal(statusDescription("FAILURE", [], null, counts, null, 2, 2, { attempt: 2, of: 2 }), "(re-running the failed jobs) 615 passed, 0 failed, 2 not run, 17 skipped");
  assert.equal(statusDescription("FAILURE", [], null, { passed: 0, failed: 1, skipped: 0 }, null, 1, 0, { attempt: 2, of: 2 }), "(re-running the failed jobs) 0% passed (0 passed, 1 failed, 0 skipped)");
  const text = renderSummary({ findings: [], runURL: "u", counts, trunkBranch: "master", unnamed: 2, notRun: 2, notRunRerun: 2, rerun: { attempt: 2, of: 2 } });
  assert.match(text, /^## E2E triage: 🔴 2 specs did not run, re-running the failed jobs$/m);
  assert.match(text, /^\*\*Re-running the failed jobs automatically \(attempt 2 of 2\), then triaging the new results: 2 specs did not run, no result from their CI job\.\*\*/m);
  for (const [attempt, expected] of [["1", "true"], ["2", "false"]]) {
    await inTmp(async (dir) => {
      const statuses: StatusBody[] = [];
      const outputPath = join(dir, "o.txt");
      const fetchImpl = fakeFetch([
        ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "mobile-pr-detox-ios", gh_run_id: "12", gh_run_attempt: attempt, status: "completed" }], total: 1 })],
        ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: MOBILE_STUB.file }] })],
        ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: MOBILE_STUB.title, status: "failed", retry_count: 0, ordinal: 0, error_message: MOBILE_STUB.error, error_stack: null }])],
        ["/actions/runs/12/attempts/", () => Response.json({ total_count: 1, jobs: [{ id: 7, name: "Detox iOS E2E / iOS / machine-1", status: "completed", conclusion: "failure", steps: [{ name: "ci/prepare-node-deps", conclusion: "failure" }] }] })],
        ["/actions/jobs/7/logs", () => new Response("npm error code ECONNRESET")],
        statusSink(statuses),
      ]);
      const id = { ...parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY), name: "mobile-pr-detox-ios", gh_run_attempt: attempt };
      await triage({ env: { ...env, COMPOSITE_IDENTITY: JSON.stringify(id), MODE: "enforce", RERUN_ATTEMPTS: "1", TRIAGE_CONTEXT: "off", GITHUB_OUTPUT: outputPath }, fetchImpl, log: () => {} });
      assert.match(readFileSync(outputPath, "utf8"), new RegExp(`^rerun=${expected}$`, "m"), `attempt ${attempt}`);
      if (expected === "true") assert.match(readFileSync(outputPath, "utf8"), /^rerun_of=2$/m, "the marker carries the lane's limit to the listener");
      const description = statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => s.description)[0];
      assert.match(String(description), expected === "true" ? /^\(re-running the failed jobs\) / : /^\(re-run the failed jobs\) /, `attempt ${attempt}`);
    });
  }
});

test("a desktop shard stub, end to end: no history, no model, the check red with re-run the failed jobs", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const summaryPath = join(dir, "s.md");
    const fetchImpl = fakeFetch([
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: DESKTOP_STUB.file }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: DESKTOP_STUB.title, status: "failed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }])],
      statusSink(statuses),
    ]);
    const outputPath = join(dir, "o.txt");
    const result = await triage({ env: { ...env, MODE: "enforce", TRIAGE_CONTEXT: "off", GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath }, fetchImpl, log: () => {} });
    assert.equal(result.findings.length, 0);
    assert.match(readFileSync(outputPath, "utf8"), /^verdict=FAILURE\nblocking=1\n/m, "the shard that never ran still blocks");
    assert.equal(result.verdict, "FAILURE");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reports/history")).length, 0, "no history read");
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length, 0, "no model call");
    assert.deepEqual(statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => [s.state, s.description]), [["failure", "(re-run the failed jobs) 0% passed (0 passed, 1 failed, 0 skipped)"]]);
    assert.match(readFileSync(summaryPath, "utf8"), /^## E2E triage · playwright-full: 🔴 re-run the failed jobs$/m);
  });
});

test("placeholders beside a real flaky failure: the flaky one is labelled, and the run is red with re-run the failed jobs", async () => {
  const flakyError = 'Error: expect(locator).toHaveText(expected) failed: expected "Channel header" but received "Set a header"';
  const real = { file: "specs/a.spec.ts", title: "t1", error: flakyError };
  const run = { ...runOf([MOBILE_STUB, real, DESKTOP_STUB]), counts: { total: 21, passed: 18, failed: 3, flaky: 0, skipped: 0 } };
  const history = new Map([[identityKey(real), [...trunkPasses(8), obs({ status: "failed", commit_sha: "s1", error_excerpt: flakyError })]]]);
  const sent: string[] = [];
  const result = await evaluate(run, { history, ask: async (packs) => { sent.push(...packs.map((p) => p.test.title)); return fixture<BatchResult>({ answers: [] }); } });
  assert.deepEqual(result.findings.map((f) => [f.title, f.class, f.blocking]), [["t1", "FLAKY_ON_TRUNK", false]], "only the test is a finding");
  assert.equal(result.unnamed, 2);
  assert.equal(result.notRun, 1, "only the mobile spec did not run; the desktop stub is a shard with no results");
  assert.ok(!sent.some((t) => t !== "t1"), "no placeholder is judged");
  assert.equal(result.verdict, "FAILURE", "the placeholders keep the run red");
  const description = statusDescription(result.verdict, result.findings, result.infra, result.counts, null, result.unnamed, result.notRun);
  assert.equal(description, "(1 flaky; re-run the failed jobs) 18 passed, 2 failed, 1 not run, 0 skipped", "the pass line counts the spec that did not run");
  assert.ok(description.length <= 140);
  const text = renderSummary({ findings: result.findings, infra: result.infra, runURL: "u", counts: result.counts, trunkBranch: "master", unnamed: result.unnamed, notRun: result.notRun, notRunRerun: result.notRunRerun });
  assert.match(text, /^## E2E triage: 🔴 re-run the failed jobs$/m, "never 'none caused' while the lane is red");
  assert.match(text, /\*\*1 failure: 1 looks unrelated \(1 flaky\)\. Re-run the failed jobs: 1 spec did not run, no result from its CI job; 1 failed result with no test name\.\*\*/);
  // The labels still give way first past 140 characters; the re-run stays whole.
  const long = statusDescription("FAILURE", Array.from({ length: 40 }, (_, i) => finding({ title: `t${i}`, class: "REGRESSION", blocking: i % 2 === 0, decision: i % 4 === 0 ? "adjudicator_blame" : undefined, judge: i % 4 === 0 ? ({ cause: "caused_by_pr", confidence: 0.9, cited_evidence: [], explanation: "x" } as Finding["judge"]) : null, out_of_date: i % 3 === 0 ? { base: "master", behind: 1, commit: null } : undefined })), null, { passed: 900, failed: 42 }, { text: "x", short: "2 report(s) missing" }, 2);
  assert.ok(long.length <= 140, `length ${long.length}`);
  assert.match(long, /; re-run the failed jobs; 2 report\(s\) missing\) /);
  const longNotRun = statusDescription("FAILURE", Array.from({ length: 40 }, (_, i) => finding({ title: `t${i}`, class: "REGRESSION", blocking: true })), "infrastructure errors", { passed: 1186, failed: 342, skipped: 164 }, { text: "x", short: "2 report(s) missing" }, 302, 300);
  assert.ok(longNotRun.length <= 140, `length ${longNotRun.length}`);
  assert.match(longNotRun, /; mostly environment errors, re-run; re-run the failed jobs; 2 report\(s\) missing\) 1186 passed, 42 failed, 300 not run, 164 skipped$/);
});

// Written by mattermost-mobile's merge script once it knows each spec's shard.
const STOPPED = { ...MOBILE_STUB, error: `${MOBILE_STUB.file} was assigned to a shard but produced no result: other specs of its shard reported, so its Jest process stopped before reaching this spec.` };
const SILENT = { ...MOBILE_STUB, error: `${MOBILE_STUB.file} was assigned to a shard but produced no result: no spec of its shard reported, so the shard ran or uploaded nothing.` };
const specRuns = (statuses: string[]): SpecRun[] => statuses.map((status, i) => ({ group_id: `h${i}`, status: status as SpecRun["status"] }));

test("a spec whose Jest process stopped before it is flaky when it also did not run before and passed every time it ran", () => {
  const cleared = classifyNotRun(STOPPED, specRuns(["not_run", ...Array(6).fill("passed"), "not_run"]), DEFAULTS, "g1");
  assert.deepEqual([cleared.class, cleared.blocking], ["FLAKY_NOT_RUN", false]);
  assert.match(cleared.reason, /as it did in 2 of the last 8 runs; it passed in all 6 where it ran/);
  const blocked = (statuses: string[]) => classifyNotRun(STOPPED, specRuns(statuses), DEFAULTS, "g1");
  assert.match(blocked(Array(8).fill("passed")).reason, /which it has not done in the last 8 runs/, "first time");
  assert.match(blocked(["not_run", "failed", ...Array(6).fill("passed")]).reason, /it failed in 1 of the 7 recent runs where it ran/);
  // One failure in 96 runs where it ran (mm_blocks_ephemeral's history) is still passing.
  const rare = classifyNotRun(STOPPED, specRuns(["not_run", "failed", ...Array(95).fill("passed")]), DEFAULTS, "g1");
  assert.deepEqual([rare.class, rare.blocking], ["FLAKY_NOT_RUN", false], "one failure in 96 is still passing");
  assert.match(rare.reason, /^Did not run: its Jest process stopped before reaching it, as it did in 1 of the last 97 runs; it passed in 95 of the 96 where it ran\./);
  assert.match(blocked(["not_run", "passed", "passed"]).reason, /it ran in only 2 recent runs/);
  for (const f of [blocked(Array(8).fill("passed")), classifyNotRun(STOPPED, null, DEFAULTS, "g1")]) assert.deepEqual([f.class, f.blocking], ["NOT_RUN", true]);
  assert.equal(classifyNotRun(STOPPED, [{ group_id: "g1", status: "not_run" }, ...specRuns(Array(6).fill("passed"))], DEFAULTS, "g1").class, "NOT_RUN", "this run is not its own history");
  assert.equal(classifyNotRun(STOPPED, [{ group_id: "7", status: "not_run" }, ...specRuns(Array(6).fill("passed"))], DEFAULTS, 7).class, "NOT_RUN", "nor when TSIO sends its id as a number");
  // A run where every test was skipped is not a pass: 3 passes and 10 skipped runs are 3 runs, too few.
  assert.match(blocked(["not_run", ...Array(3).fill("passed"), ...Array(10).fill("skipped")]).reason, /it ran in only 3 recent runs/);
  // mm_blocks_incoming_webhook skips every test on CI (no stable webhook ingress), so missing it loses nothing.
  const alwaysSkipped = classifyNotRun(STOPPED, specRuns(["not_run", ...Array(96).fill("skipped")]), DEFAULTS, "g1");
  assert.deepEqual([alwaysSkipped.class, alwaysSkipped.blocking], ["FLAKY_NOT_RUN", false]);
  assert.match(alwaysSkipped.reason, /it skipped every test in all 96 recent runs where it was reached, so nothing was lost/);
  // A spec this change edits has to run, and one whose change list could not be read is not cleared either.
  const history = specRuns(["not_run", ...Array(6).fill("passed")]);
  assert.match(classifyNotRun(STOPPED, history, DEFAULTS, "g1", true).reason, /this change edits it, so it has to run/);
  assert.match(classifyNotRun(STOPPED, history, DEFAULTS, "g1", null).reason, /whether this change edits it could not be checked/);
  for (const edited of [true, null]) assert.equal(classifyNotRun(STOPPED, history, DEFAULTS, "g1", edited).blocking, true);
});

test("a spec's runs are read from the whole file: not run where its placeholder is, failed where a test failed every try", async () => {
  const row = (group_id: string, title: string, status: string, retry_count = 0, name = "mobile-pr-detox-ios") => obs({ file: MOBILE_STUB.file, title, full_title: `S > ${title}`, group_id, status, retry_count, name });
  const rows = [
    row("g1", "spec did not run", "failed"),
    row("g2", "a", "passed"), row("g2", "b", "passed"),
    row("g3", "a", "failed"), row("g3", "a", "failed", 1),
    row("g4", "a", "failed"), row("g4", "a", "passed", 1),
    row("g5", "a", "failed", 0, "mobile-pr-detox-android"),
    row("g6", "a", "skipped"), row("g6", "b", "skipped"),
    // One spec reported twice in one run at the same retry: the pass beside the fail cannot excuse it, as in the run reader.
    row("g7", "a", "failed"), row("g7", "a", "passed"),
  ];
  const history = await fetchSpecRuns(fakeFetch([["/reports/history", () => Response.json({ observations: rows })]]), "http://tsio", "o/r", [MOBILE_STUB.file], "2026-10-26T00:00:00Z", DEFAULTS, laneOf("mobile-pr-detox-ios"));
  assert.equal(history.truncated, false);
  assert.deepEqual(history.byFile.get(MOBILE_STUB.file)!.map((r) => [r.group_id, r.status]), [["g1", "not_run"], ["g2", "passed"], ["g3", "failed"], ["g4", "passed"], ["g6", "skipped"], ["g7", "failed"]], "another lane's run is not this lane's history, and a run where every test was skipped is no pass");
});

test("a lane whose only failures are specs a stopped Jest process skipped is green when they are flaky that way; a silent shard is re-run", async () => {
  const history = specRuns(["not_run", ...Array(6).fill("passed")]);
  const counts = { total: 634, passed: 615, failed: 1, flaky: 0, skipped: 17 };
  const result = await evaluate({ ...runOf([STOPPED]), counts }, { specHistory: { byFile: new Map([[STOPPED.file, history]]), truncated: false } });
  assert.equal(result.verdict, "SUCCESS");
  // On a release branch the same spec stays red: that build never ran it, and spec history is not the branch's own.
  const release = await evaluate({ ...runOf([STOPPED]), counts }, { prNumber: null, branchBase: "main", specHistory: { byFile: new Map([[STOPPED.file, history]]), truncated: false } });
  assert.deepEqual([release.verdict, release.findings[0].class, release.findings[0].blocking], ["FAILURE", "NOT_RUN", true]);
  assert.match(release.findings[0].reason, /On a release branch that does not clear it: this build never ran the spec\.$/);
  assert.equal(result.unnamed, undefined, "not a placeholder to re-run");
  assert.equal(result.notRun, 1);
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts, null, result.unnamed ?? 0, result.notRun ?? 0), "(1 flaky) 615 passed, 0 failed, 1 not run, 17 skipped");
  // A shard that sent nothing ran none of its specs: it is re-run, whatever their history says. So is an old-wording
  // placeholder, which cannot say which it was.
  for (const t of [SILENT, MOBILE_STUB]) {
    const silent = await evaluate({ ...runOf([t]), counts }, { specHistory: { byFile: new Map([[t.file, history]]), truncated: false } });
    assert.deepEqual([silent.verdict, silent.unnamed, silent.notRunRerun, silent.findings.length], ["FAILURE", 1, 1, 0], t.error);
  }
  const edited = await evaluate({ ...runOf([STOPPED]), counts }, { specHistory: { byFile: new Map([[STOPPED.file, history]]), truncated: false }, diff: { files: [{ filename: STOPPED.file }], ok: true } });
  assert.deepEqual([edited.verdict, edited.findings[0].class], ["FAILURE", "NOT_RUN"], "a spec the PR edits is held");
  const truncated = await evaluate({ ...runOf([STOPPED]), counts }, { specHistory: { byFile: new Map([[STOPPED.file, history]]), truncated: true } });
  assert.deepEqual([truncated.verdict, truncated.findings[0].class], ["FAILURE", "NOT_RUN"], "cut-off history clears nothing");
});

test("the re-run line counts only the specs it re-runs, beside a held one and a desktop stub", () => {
  const held = classifyNotRun(STOPPED, specRuns(Array(8).fill("passed")), DEFAULTS, "g1");
  const counts = { total: 10, passed: 6, failed: 4, flaky: 0, skipped: 0 };
  // 1 held stopped spec (a finding), 2 silent-shard specs and 1 desktop stub (placeholders, re-run).
  const text = renderSummary({ findings: [held], runURL: "u", counts, trunkBranch: "main", unnamed: 3, notRun: 3, notRunRerun: 2 });
  assert.match(text, /Re-run the failed jobs: 2 specs did not run, no result from their CI job; 1 failed result with no test name\./);
  const onlyPlaceholders = renderSummary({ findings: [], runURL: "u", counts, trunkBranch: "main", unnamed: 2, notRun: 3, notRunRerun: 2 });
  assert.match(onlyPlaceholders, /^## E2E triage: 🔴 2 specs did not run, re-run the failed jobs$/m);
});

test("end to end, a skipped spec with an intermittent history turns the lane green, and nothing asks for a re-run", async () => {
  await inTmp(async (dir) => {
    const statuses: StatusBody[] = [];
    const outputPath = join(dir, "o.txt");
    const logs: string[] = [];
    const past = (group_id: string, title: string) => obs({ file: STOPPED.file, title, full_title: `S > ${title}`, group_id, status: title === "a" ? "passed" : "failed", name: "mobile-pr-detox-ios" });
    const history = [past("h0", "spec did not run"), ...Array.from({ length: 6 }, (_, i) => past(`h${i + 1}`, "a"))];
    const fetchImpl = fakeFetch([
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "mobile-pr-detox-ios", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: STOPPED.file }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: STOPPED.title, status: "failed", retry_count: 0, ordinal: 0, error_message: STOPPED.error, error_stack: null }])],
      ["/reports/history", () => Response.json({ observations: history })],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "main" }, labels: [] })],
      statusSink(statuses),
    ]);
    const id = { ...parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY), name: "mobile-pr-detox-ios" };
    const result = await triage({ env: { ...env, COMPOSITE_IDENTITY: JSON.stringify(id), MODE: "enforce", RERUN_ATTEMPTS: "1", TRIAGE_CONTEXT: "off", GITHUB_OUTPUT: outputPath }, fetchImpl, log: (m) => logs.push(m) });
    assert.equal(result.verdict, "SUCCESS");
    assert.match(readFileSync(outputPath, "utf8"), /^rerun=false$/m);
    assert.deepEqual(statuses.filter((s) => s.context === "e2e-test/playwright").map((s) => [s.state, s.description]), [["success", "(1 flaky) 0 passed, 0 failed, 1 not run, 0 skipped"]]);
    assert.ok(logs.some((l) => /finding 1\/1 cleared FLAKY_NOT_RUN/.test(l)));
  });
});

test("the triage check says re-running too while an automatic re-run is on its way", async () => {
  const statuses: StatusBody[] = [];
  const fetchImpl = fakeFetch([
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "mobile-pr-detox-ios", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: MOBILE_STUB.file }] })],
    ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: MOBILE_STUB.title, status: "failed", retry_count: 0, ordinal: 0, error_message: MOBILE_STUB.error, error_stack: null }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "main" }, labels: [] })],
    ["/actions/runs/12/attempts/", () => Response.json({ total_count: 1, jobs: [{ id: 7, name: "Detox iOS E2E / iOS / machine-1", status: "completed", conclusion: "failure", steps: [{ name: "ci/prepare-node-deps", conclusion: "failure" }] }] })],
    ["/actions/jobs/7/logs", () => new Response("npm error code ECONNRESET")],
    statusSink(statuses),
  ]);
  const id = { ...parsed<CompositeIdentity>(env.COMPOSITE_IDENTITY), name: "mobile-pr-detox-ios" };
  await triage({ env: { ...env, COMPOSITE_IDENTITY: JSON.stringify(id), MODE: "enforce", RERUN_ATTEMPTS: "1" }, fetchImpl, log: () => {} });
  const check = statuses.filter((s) => s.context === "e2e-test/playwright/triage" && s.state !== "pending").map((s) => s.description);
  assert.deepEqual(check, ["1 failed → re-running the failed jobs"]);
});

test("a lane a named test already blocks asks for no re-run, though a shard beside it sent nothing", async () => {
  await inTmp(async (dir) => {
    const outputPath = join(dir, "o.txt");
    const fetchImpl = fakeFetch([
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }, { id: "s2", file_path: SILENT.file }] })],
      ["/reports/g1/cases", () => Response.json([...spec("t1", "failed"), { suite_id: "s2", title: SILENT.title, status: "failed", retry_count: 0, ordinal: 1, error_message: SILENT.error, error_stack: null }])],
      ["/reports/history", () => Response.json({ observations: trunkPasses(8) })],
      ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
      ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
      ["/statuses/abc", () => Response.json({})],
    ]);
    const result = await triage({ env: { ...env, ANTHROPIC_API_KEY: "", RERUN_ATTEMPTS: "1", TRIAGE_CONTEXT: "off", GITHUB_OUTPUT: outputPath }, fetchImpl, log: () => {}, wait: { attempts: 1, ms: 0 } });
    assert.equal(result.unnamed, 1, "the silent shard's spec is still a placeholder");
    assert.ok(result.findings.some((f) => f.blocking), "t1 blocks");
    assert.match(readFileSync(outputPath, "utf8"), /^rerun=false$/m);
  });
});

test("placeholders beside a test still put their specs in the history query: TSIO's run window is counted over the files asked for", async () => {
  // Dropping a placeholder's spec moves the window back to older runs of the real test, so its evidence would change.
  const sent: HistoryBody[] = [];
  const fetchImpl = fakeFetch([
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }], total: 1 })],
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }, { id: "s2", file_path: MOBILE_STUB.file }] })],
    ["/reports/g1/cases", () => Response.json([...spec("t1", "failed"), { suite_id: "s2", title: MOBILE_STUB.title, status: "failed", retry_count: 0, ordinal: 1, error_message: MOBILE_STUB.error, error_stack: null }])],
    ["/reports/history", (init) => { sent.push(parsed<HistoryBody>(bodyText(init))); return Response.json({ observations: trunkFailsAll(8) }); }],
    ["/pulls/5/files", () => Response.json([{ filename: "app/x.ts", patch: "@@" }])],
    ["/pulls/5", () => Response.json({ title: "t", base: { ref: "master" } })],
    ["/statuses/abc", () => Response.json({})],
  ]);
  const result = await triage({ env: { ...env, MODE: "enforce", ANTHROPIC_API_KEY: "", TRIAGE_CONTEXT: "off" }, fetchImpl, log: () => {}, wait: { attempts: 1, ms: 0 } });
  assert.deepEqual(result.findings.map((f) => f.title), ["t1"], "the placeholder is not a finding");
  assert.ok(sent.length > 0);
  for (const body of sent) assert.deepEqual([...(body.files ?? [])].sort(), [MOBILE_STUB.file, "specs/a.spec.ts"].sort());
});

test("a failure that needs a look beside a shard placeholder: the headline is red and says to re-run", () => {
  const look = finding({ title: "t1", class: "REGRESSION", blocking: true });
  const text = renderSummary({ findings: [look], infra: null, runURL: "u", counts: { total: 10, passed: 8, failed: 2, flaky: 0, skipped: 0 }, trunkBranch: "master", unnamed: 1 });
  assert.match(text, /^## E2E triage: 🔴 1 needs a look, re-run the failed jobs$/m);
  const alone = renderSummary({ findings: [look], infra: null, runURL: "u", counts: { total: 10, passed: 9, failed: 1, flaky: 0, skipped: 0 }, trunkBranch: "master" });
  assert.match(alone, /^## E2E triage: 🟡 1 needs a look$/m, "without a placeholder it stays amber");
});

test("the answer cache keys the other platforms' results only where they can clear: beside an earlier failure in the spec", () => {
  const f = classify({ file: "specs/servers.spec.ts", title: "MM-T4691_3", error: "Error: expected visible" }, trunkPasses(8), []);
  const earlier = { title: "MM-T4691_2", error: "Error: getaddrinfo ENOTFOUND second-server", class: "INFRA_ERROR" };
  const passed = [{ platform: "android", result: "passed" }];
  const key = (over: Partial<Finding>): string => packKey("m", buildPack({ ...f, ...over }, [], prCtx, []));
  assert.notEqual(key({ earlier_failure: earlier, other_lanes: passed }), key({ earlier_failure: earlier }), "a pass elsewhere arriving later asks again");
  assert.equal(key({ other_lanes: passed }), key({}), "without the chain the field stays out of the key, as before");
});

/** A GitHub fake for markOutOfDate: a cut-off compare with a merge base, and each directory's commits since it. */
function cutOffApi(dirCommits: Record<string, unknown[] | Error>, calls: URLSearchParams[] = [], mergeBase: unknown = { sha: "mb", commit: { committer: { date: "2026-09-01T10:00:00Z" } } }) {
  return async (_method: string, path: string): Promise<unknown> => {
    if (path.includes("/compare/abc...master")) return { ahead_by: 49, files: Array.from({ length: 300 }, (_, i) => ({ filename: `webapp/f${i}.ts` })), commits: [], merge_base_commit: mergeBase };
    if (path.startsWith("/repos/o/r/commits?")) {
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      calls.push(q);
      const answer = dirCommits[q.get("path") ?? ""] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    throw new Error(`unexpected ${path}`);
  };
}
const staleSpec = (path: string): Finding => Object.assign(classify({ file: path, title: "t", error: "Error: expected visible" }, trunkPasses(8), []), { repo_path: path });

test("a cut-off compare checks each failing spec's directory since the merge base: a commit there marks it out of date", async () => {
  const calls: URLSearchParams[] = [];
  const rewrite = { sha: "m9", commit: { message: "Rewrite the server list specs (#31234)", committer: { date: "2026-10-02T08:00:00Z" } } };
  const servers = staleSpec("e2e-tests/cypress/tests/integration/servers/list_spec.js");
  const login = staleSpec("e2e-tests/cypress/tests/integration/login/login_spec.js");
  // GitHub's since is inclusive: the merge base itself, touching the directory, is not a change since it.
  const res = await markOutOfDate({ findings: [servers, login], api: cutOffApi({ "e2e-tests/cypress/tests/integration/servers": [rewrite], "e2e-tests/cypress/tests/integration/login": [{ sha: "mb", commit: { committer: { date: "2026-09-01T10:00:00Z" } } }] }, calls), id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master", until: "2026-10-20T00:00:00.000Z" });
  assert.deepEqual(servers.out_of_date, { base: "master", behind: 49, commit: { sha: "m9", date: "2026-10-02", pr: 31234 } });
  assert.equal(login.out_of_date, undefined, "no commit in its directory since the merge base");
  assert.deepEqual(res, { truncated: true, unchecked: [] }, "both settled: neither is left unchecked");
  assert.deepEqual(calls.map((q) => [q.get("sha"), q.get("path"), q.get("since"), q.get("until"), q.get("per_page")]), [
    ["master", "e2e-tests/cypress/tests/integration/servers", "2026-09-01T10:00:00Z", "2026-10-20T00:00:00.000Z", "1"],
    ["master", "e2e-tests/cypress/tests/integration/login", "2026-09-01T10:00:00Z", "2026-10-20T00:00:00.000Z", "1"],
  ]);
});

test("the directory check is capped at 20 directories, and a directory it could not read stays unchecked", async () => {
  const specs = Array.from({ length: OUT_OF_DATE_DIR_CAP + 2 }, (_, i) => staleSpec(`specs/d${i}/x.spec.ts`));
  const calls: URLSearchParams[] = [];
  const res = await markOutOfDate({ findings: specs, api: cutOffApi({ "specs/d0": new Error("GitHub 502") }, calls), id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master" });
  assert.equal(calls.length, OUT_OF_DATE_DIR_CAP, "at most 20 directories are asked");
  assert.equal(calls[0].get("until"), null, "no run time, no until");
  assert.deepEqual((res.unchecked ?? []).map((f) => f.repo_path), ["specs/d0/x.spec.ts", "specs/d20/x.spec.ts", "specs/d21/x.spec.ts"]);
  assert.ok(specs.every((f) => f.out_of_date === undefined));
  // No merge base date to ask from: every spec the list did not name stays unchecked, and nothing is asked.
  const none: URLSearchParams[] = [];
  const blind = await markOutOfDate({ findings: [staleSpec("specs/d0/x.spec.ts")], api: cutOffApi({}, none, null), id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master" });
  assert.equal(blind.unchecked?.length, 1);
  assert.equal(none.length, 0);
});

test("past the compare cap, a spec its directory shows changed is out of date, one with no change is judged, and an unread one is unchecked", async () => {
  const run = runOf([
    { title: "MM-T1", file: "specs/servers/list.spec.ts", error: "Error: expected visible" },
    { title: "MM-T2", file: "specs/login/login.spec.ts", error: "Error: expected header" },
    { title: "MM-T3", file: "specs/search/find.spec.ts", error: "Error: expected result" },
  ]);
  const history = new Map(run.failing.map((t): [string, Observation[]] => [identityKey(t), [...trunkPasses(8), ...crossPR(31)]]));
  const rewrite = { sha: "m9", commit: { message: "Rewrite (#31234)", committer: { date: "2026-10-02T08:00:00Z" } } };
  const api = cutOffApi({ "specs/servers": [rewrite], "specs/search": new Error("GitHub 502") });
  const sent: string[] = [];
  const result = await evaluate(run, { history, cfg: { ...DEFAULTS, escalationModel: "" }, outOfDate: (fs) => markOutOfDate({ findings: fs, api, id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master" }), ask: answering((p) => (sent.push(p.test.title), envAnswer)) });
  const [servers, login, search] = result.findings;
  assert.deepEqual(servers.out_of_date, { base: "master", behind: 49, commit: { sha: "m9", date: "2026-10-02", pr: 31234 } });
  assert.equal(statusLabelOf(servers), "out of date");
  assert.equal(login.out_of_date, undefined);
  assert.notEqual(login.decision, "evidence_incomplete", "checked and unchanged: not unchecked");
  assert.equal(search.decision, "evidence_incomplete");
  assert.deepEqual(sent, ["MM-T2"], "only the checked, unchanged failure goes to the model");
});

test("the first failure in a chain: an earlier test of the same spec and report that failed another way, by ordinal", () => {
  const env1 = "Error: getaddrinfo ENOTFOUND second-server.test.mattermost.cloud\n    at GetAddrInfoReqWrap.onlookupall";
  const ui = 'Error: expect(locator).toBeVisible() failed: locator getByRole("listitem", { name: "Second server" })';
  const mk = (title: string, error: string, ordinal?: number, file = "specs/servers.spec.ts", report: string | null = "detox-ios"): Finding => Object.assign(classify({ file, title, error, ordinal }, trunkPasses(8), []), { repo_path: file, report_name: report });
  // Listed out of order; the ordinals say MM-T4691_2 ran first.
  const [t3, t2, t5, other] = markEarlierFailures([mk("MM-T4691_3", ui, 30), mk("MM-T4691_2", env1, 20), mk("MM-T4691_5", ui, 50), mk("MM-T1", ui, 10, "specs/other.spec.ts")]);
  assert.deepEqual(t3.earlier_failure, { title: "MM-T4691_2", error: "Error: getaddrinfo ENOTFOUND second-server.test.mattermost.cloud", class: "INFRA_ERROR" });
  assert.deepEqual(t5.earlier_failure, t3.earlier_failure, "the chain's first failure, not the previous one with the same error");
  assert.equal(t2.earlier_failure, undefined, "nothing failed before it");
  assert.equal(other.earlier_failure, undefined, "another spec is another chain");
  // TSIO lists failures in no fixed order: without ordinals, or with equal ones, nothing says which ran first.
  const [a, b] = markEarlierFailures([mk("first", env1), mk("second", ui)]);
  assert.equal(a.earlier_failure, undefined);
  assert.equal(b.earlier_failure, undefined);
  assert.equal(markEarlierFailures([mk("first", env1, 4), mk("second", ui, 4)])[1].earlier_failure, undefined);
  // The same error earlier is not a chain.
  assert.equal(markEarlierFailures([mk("x", ui, 1), mk("y", ui, 2)])[1].earlier_failure, undefined);
  // Another report ran on another machine; with no report names, nothing says which ran first.
  assert.equal(markEarlierFailures([mk("first", env1, 1, undefined, "detox-android"), mk("second", ui, 2)])[1].earlier_failure, undefined);
  assert.equal(markEarlierFailures([mk("first", env1, 1, undefined, null), mk("second", ui, 2, undefined, null)])[1].earlier_failure, undefined);
});

test("an earlier environment failure in the spec clears a later one only with a pass on another platform in this run", () => {
  const f = classify({ file: "specs/servers.spec.ts", title: "MM-T4691_3", error: 'Error: expect(locator).toBeVisible() failed: locator getByRole("listitem", { name: "Second server" })' }, trunkPasses(8), [], undefined, 5);
  assert.equal(f.class, "REGRESSION");
  const earlier = { title: "MM-T4691_2", error: "Error: getaddrinfo ENOTFOUND second-server.test.mattermost.cloud", class: "INFRA_ERROR" };
  const packOf = (over: Partial<Finding>): Pack => buildPack({ ...f, ...over }, [], prCtx, []);
  const chain: Answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["earlier_failure_same_spec", "other_platforms"], explanation: "The earlier test could not reach the second server." };

  const clears = packOf({ earlier_failure: earlier, other_lanes: [{ platform: "macos", result: "passed" }] });
  assert.deepEqual(clears.earlier_failure_same_spec, { id: "earlier_failure_same_spec", ...earlier });
  assert.ok(evidenceIds(clears).includes("earlier_failure_same_spec"));
  assert.ok(chainClears(clears));
  assert.equal(canChange("REGRESSION", clears), true, "a question the answer can settle, not advice");
  assert.equal(decide("REGRESSION", chain, clears).decision, "adjudicator_unblock");
  assert.equal(decide("REGRESSION", { ...chain, cited_evidence: ["other_platforms"] }, clears).blocking, true, "the chain must be cited");
  assert.equal(decide("REGRESSION", { ...chain, cause: "test_bug" }, clears).blocking, true, "only flaky_environment");
  assert.equal(decide("INFRA_ERROR", chain, clears).blocking, true, "a held environment error still needs cross_pr or this_pr");

  // The same test failed on the other platform too: a PR that breaks the server fails every platform.
  const failedElsewhere = packOf({ earlier_failure: earlier, other_lanes: [{ platform: "macos", result: "failed" }] });
  assert.equal(chainClears(failedElsewhere), false);
  assert.equal(canChange("REGRESSION", failedElsewhere), false);
  assert.equal(decide("REGRESSION", chain, failedElsewhere).blocking, true);
  assert.equal(decide("REGRESSION", chain, packOf({ earlier_failure: earlier })).blocking, true, "no other platform at all");
  assert.equal(decide("REGRESSION", chain, packOf({ earlier_failure: earlier, other_lanes: [{ platform: "macos", result: "flaky" }] })).blocking, true, "a retry-recovered run is not a pass");

  // An earlier failure that is not an environment error explains nothing about the environment.
  const notInfra = packOf({ earlier_failure: { ...earlier, error: "Error: expected visible", class: "REGRESSION" }, other_lanes: [{ platform: "macos", result: "passed" }] });
  assert.equal(chainClears(notInfra), false);
  assert.equal(canChange("REGRESSION", notInfra), false);
  assert.equal(decide("REGRESSION", chain, notInfra).blocking, true);
});

test("a chained failure end to end: the pack carries the earlier failure, and the model's answer citing it clears", async () => {
  const ui = 'Error: expect(locator).toBeVisible() failed: locator getByRole("listitem", { name: "Second server" })';
  const base = runOf([
    { title: "MM-T4691_3", file: "specs/servers.spec.ts", error: ui },
    { title: "MM-T4691_2", file: "specs/servers.spec.ts", error: "Error: getaddrinfo ENOTFOUND second-server.test.mattermost.cloud" },
  ]);
  // One report, as TSIO names every suite's: the ordinals say MM-T4691_2 ran first.
  const run = { ...base, failing: base.failing.map((t, i) => ({ ...t, report_name: "detox-ios", ordinal: i === 0 ? 30 : 20 })) };
  const history = new Map(run.failing.map((t): [string, Observation[]] => [identityKey(t), trunkPasses(8)]));
  const packs: Pack[] = [];
  const chain: Answer = { cause: "flaky_environment", confidence: 0.9, cited_evidence: ["earlier_failure_same_spec", "other_platforms"], explanation: "x" };
  // An iOS-only change in the PR: common sense can't rule it out for an iOS failure, so the model is asked.
  const iosOnly = { files: [{ filename: "ios/Podfile.lock", patch: "@@ -1 +1 @@\n-a\n+b" }], ok: true };
  const otherPlatforms = async (fs: Finding[]): Promise<void> => { for (const f of fs) if (f.title === "MM-T4691_3") f.other_lanes = [{ platform: "detox-android", result: "passed" }]; };
  const result = await evaluate(run, {
    history,
    diff: iosOnly,
    cfg: { ...DEFAULTS, escalationModel: "" },
    otherPlatforms,
    ask: answering((p) => (packs.push(p), chain)),
  });
  const [later, earlier] = result.findings;
  assert.equal(earlier.class, "INFRA_ERROR");
  const packOf = (title: string): Pack | undefined => packs.find((p) => p.test.title === title);
  assert.deepEqual(packOf("MM-T4691_3")?.earlier_failure_same_spec, { id: "earlier_failure_same_spec", title: "MM-T4691_2", error: "Error: getaddrinfo ENOTFOUND second-server.test.mattermost.cloud", class: "INFRA_ERROR" });
  assert.equal(packOf("MM-T4691_2")?.earlier_failure_same_spec, undefined, "nothing failed before the first one");
  assert.equal(later.decision, "adjudicator_unblock");
  assert.equal(later.blocking, false);
  assert.equal(earlier.decision, "advice", "the held environment error has nothing an answer could clear it with: advice only");
  assert.equal(earlier.blocking, true, "the environment error itself is never cleared by the chain");
  assert.equal(result.verdict, "FAILURE");
  // Without the iOS-only change, common sense clears it before the model: Android passed this commit, the PR touches nothing.
  const asked: string[] = [];
  const plain = await evaluate(run, { history, cfg: { ...DEFAULTS, escalationModel: "" }, otherPlatforms, ask: answering((p) => (asked.push(p.test.title), chain)) });
  assert.equal(plain.findings[0].decision, "rules_unblock");
  assert.ok(!asked.includes("MM-T4691_3"), "settled without the model");
});

// ---------------------------------------------------------------- common sense: the same commit rules the PR out

// A failure on linux that passed on the other two platforms of the same commit and passes on trunk (desktop #4033).
const onePlatform = (over: Partial<Finding> = {}, history: Observation[] = trunkPasses(25)): Finding =>
  Object.assign(classify(failing, history, [], undefined, 1), {
    repo_path: "specs/a.spec.ts",
    untouched: true,
    report_name: "e2e-on-ubuntu-latest-6.0.0",
    other_lanes: [{ platform: "macos", result: "passed" }, { platform: "windows", result: "passed" }],
  }, over);
const packOfFinding = (f: Finding, diff: { filename: string; patch?: string }[] = []): Pack => buildPack(f, diff.map((d) => ({ filename: d.filename, patch: d.patch ?? "" })), prCtx, []);

test("platforms: a report names its platform, and a file reaches one platform only by its path", () => {
  assert.deepEqual(["e2e-on-ubuntu-latest-6.0", "e2e-on-windows-2022", "e2e-on-macos-26", "detox-ios", "detox-android", "e2e-cypress / dispatch-run--21", null].map(platformOf), ["linux", "windows", "macos", "ios", "android", null, null]);
  assert.ok(onlyOnPlatform("ios", "ios/Podfile.lock") && onlyOnPlatform("ios", "ios/Mattermost/AppDelegate.swift"));
  assert.ok(onlyOnPlatform("android", "android/app/build.gradle") && onlyOnPlatform("linux", "src/main/linux/tray.ts") && onlyOnPlatform("windows", "scripts/win32/installer.nsh"));
  assert.ok(!onlyOnPlatform("ios", "package.json") && !onlyOnPlatform("windows", "src/renderer/window.ts") && !onlyOnPlatform("linux", "src/debug.ts") && !onlyOnPlatform("macos", "src/machine.ts"));
});

test("common sense clears a test that failed on one platform only, passes on trunk, and that the PR doesn't touch (desktop #4033)", () => {
  const f = onePlatform();
  assert.equal(f.class, "REGRESSION");
  assert.equal(commonSenseClear(f, packOfFinding(f), ["e2e/helpers/callsLogs.js", ".github/workflows/ci.yaml"]), "Failed only on linux: it passed on macos and windows on this same commit, passes on trunk (25 of 25 runs), and this PR changes nothing it uses.");
});

test("common sense never clears what the PR could have caused", () => {
  const clears = (f: Finding, files: string[] = [], diff: { filename: string; patch?: string }[] = []): string | null => commonSenseClear(f, packOfFinding(f, diff), files);
  assert.equal(clears(onePlatform({ other_lanes: [{ platform: "macos", result: "passed" }, { platform: "windows", result: "failed" }] })), null, "it failed on another platform too: a shared break (desktop #4020)");
  assert.equal(clears(onePlatform({ other_lanes: [] })), null, "no other platform ran it (mattermost)");
  assert.equal(clears(onePlatform({ other_lanes: [{ platform: "macos", result: "flaky" }] })), null, "a pass on retry elsewhere is not a pass");
  assert.equal(clears(onePlatform({ other_lanes: [{ platform: "macos", result: "passed" }, { platform: "windows", result: "flaky" }] })), null, "it failed a try on another platform: the PR may make it unstable everywhere");
  assert.equal(clears(onePlatform({ untouched: false })), null, "the PR changes a file its error names");
  assert.equal(clears(onePlatform(), [], [{ filename: "src/helper.ts", patch: "@@" }].map((d) => ({ ...d, filename: "specs/a.spec.ts" }))), null, "the PR edits the spec");
  assert.equal(clears(onePlatform(), ["src/main/linux/tray.ts"]), null, "a linux-only change, for a linux failure");
  assert.ok(clears(onePlatform(), ["ios/Podfile.lock"]), "an iOS-only change cannot break linux");
  assert.equal(clears(onePlatform({ report_name: "detox-ios", other_lanes: [{ platform: "detox-android", result: "passed" }] }), ["ios/Podfile.lock"]), null, "an iOS-only change, for an iOS failure");
  assert.equal(clears(onePlatform({ report_name: "worker-3" })), null, "a report that names no platform");
  assert.equal(clears(onePlatform({}, trunkPasses(2))), null, "too little trunk history, and no pass on this PR");
  for (const over of [{ blocking: false }, { identity_unresolved: true }, { out_of_date: { base: "master", behind: 1, commit: null } }, { decision: "evidence_incomplete" }] as Partial<Finding>[])
    assert.equal(clears(onePlatform(over)), null, JSON.stringify(over));
  assert.equal(commonSenseClear(onePlatform(), null, []), null, "no pack: the evidence is incomplete");
  const env = Object.assign(classify({ ...failing, error: SERVER_DOWN }, trunkPasses(25), [], undefined, 1), { report_name: "e2e-on-ubuntu-latest", other_lanes: [{ platform: "macos", result: "passed" }] });
  assert.equal(env.class, "INFRA_ERROR");
  assert.equal(commonSenseClear(env, packOfFinding(env), []), null, "an environment error stays the judge's");
});

test("the PR's own changes since a pass: a file only the base branch changed, or whose own patch is the same, is not one", () => {
  const now = [{ filename: "moved.ts", patch: "@@ -10,2 +10,3 @@\n+x" }, { filename: "edited.ts", patch: "@@ -1 +1 @@\n-y\n+z" }, { filename: "big.json" }];
  const then = [{ filename: "moved.ts", patch: "@@ -4,2 +4,3 @@\n+x" }, { filename: "edited.ts", patch: "@@ -1 +1 @@\n-y\n+w" }, { filename: "reverted.ts", patch: "@@ +q" }, { filename: "big.json" }];
  assert.deepEqual(prChangedSince(["moved.ts", "edited.ts", "from-base.ts", "reverted.ts", "big.json"], now, then), ["edited.ts", "reverted.ts", "big.json"],
    "a base change only moved moved.ts's lines; from-base.ts is the base branch's; a reverted file and one too big to show are the PR's");
});

test("enrich tells the PR's own changes since its last pass from the base branch's", async () => {
  const f: Finding = { ...classify(failing, [...trunkPasses(8), mine("passed", "lastpass", "2026-10-19T00:00:00Z")], [], undefined, 1), repo_path: "specs/a.spec.ts" };
  const api = async (_method: string, path: string): Promise<unknown> => {
    if (path.startsWith("/repos/o/r/compare/lastpass...head")) return { files: [{ filename: "package.json", patch: "@@ -5 +5 @@\n+emm" }, { filename: "app/calls.ts", patch: "@@ main" }] };
    if (path.startsWith("/repos/o/r/compare/main...lastpass")) return { files: [{ filename: "package.json", patch: "@@ -3 +3 @@\n+emm" }] };
    throw new Error(`unexpected ${path}`);
  };
  await enrichFindings({ findings: [f], api, id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: ".", prFiles: [{ filename: "package.json", patch: "@@ -9 +9 @@\n+emm" }], baseBranch: "main" });
  assert.deepEqual(f.since_last_pass?.pr_changed, [], "the PR's own patch is as it was at the pass; app/calls.ts came from main");
  const noBase: Finding = { ...classify(failing, [...trunkPasses(8), mine("passed", "lastpass", "2026-10-19T00:00:00Z")], [], undefined, 1), repo_path: "specs/a.spec.ts" };
  await enrichFindings({ findings: [noBase], api, id: { repository: "o/r", commit_sha: "head", gh_run_id: "9", gh_run_attempt: "1", name: "pw" }, testRoot: "." });
  assert.equal(noBase.since_last_pass?.pr_changed, undefined, "without the PR's diff nothing is told apart");
});

test("common sense clears a failure that passed here earlier on this PR, with nothing related the PR changed since, and passed on another platform (mobile #10248)", () => {
  const history = [...trunkPasses(25), mine("passed", "b44f1b8aa", "2026-10-19T00:00:00Z")];
  const ios = (since: Partial<SinceLastPass>): Finding => onePlatform({
    report_name: "detox-ios",
    other_lanes: [{ platform: "detox-android", result: "passed" }],
    since_last_pass: fixture<SinceLastPass>({ files: ["ios/Podfile.lock", "package.json", "app/calls.ts"], related: [{ file: "app/calls.ts", patch: "@@" }], complete: true, ...since }),
  }, history);
  const prFiles = ["ios/Podfile.lock", "package.json", "package-lock.json"];
  // Main merged in a related change, and the PR's own patches are as they were at the pass.
  const merged = ios({ pr_changed: [] });
  const pack = packOfFinding(merged);
  assert.deepEqual(pack.this_pr_history?.changed_since_last_pass?.related_to_this_test, []);
  assert.deepEqual(pack.this_pr_history?.changed_since_last_pass?.related_from_base, ["app/calls.ts"]);
  assert.ok(evidenceIds(pack).includes("this_pr"));
  assert.equal(commonSenseClear(merged, pack, prFiles), "Failed only on ios: it passed on detox-android on this same commit, and passed on ios earlier on this PR (b44f1b8) with nothing related this PR changed since.");
  // A related change from the base branch counts only while trunk's latest run passed with it.
  assert.ok(!evidenceIds({ ...pack, trunk_history_14d: { ...pack.trunk_history_14d, latest: "failed" } }).includes("this_pr"));
  // The PR itself changed something related since the pass, or something only iOS runs, or what it changed is unknown.
  assert.equal(commonSenseClear(ios({ pr_changed: ["app/calls.ts"] }), packOfFinding(ios({ pr_changed: ["app/calls.ts"] })), prFiles), null);
  assert.equal(commonSenseClear(ios({ pr_changed: ["ios/Podfile.lock"] }), packOfFinding(ios({ pr_changed: ["ios/Podfile.lock"] })), prFiles), null);
  assert.equal(commonSenseClear(ios({}), packOfFinding(ios({})), prFiles), null);
});

test("common sense works without the model: the run is green and says why", async () => {
  const run = { ...runOf([{ title: "t1", file: "specs/a.spec.ts", error: "Error: Server views should finish reloading" }]) };
  const linux = { ...run, failing: run.failing.map((t) => ({ ...t, report_name: "e2e-on-ubuntu-latest-6.0.0" })), counts: { total: 240, passed: 239, failed: 1, flaky: 0, skipped: 0 } };
  const history = new Map([[identityKey(linux.failing[0]), trunkPasses(25)]]);
  const result = await evaluate(linux, { history, ask: null, otherPlatforms: async (fs) => { for (const f of fs) f.other_lanes = [{ platform: "macos", result: "passed" }, { platform: "windows", result: "passed" }]; } });
  assert.deepEqual(result.findings.map((f) => [f.class, f.blocking, f.decision]), [["REGRESSION", false, "rules_unblock"]]);
  assert.equal(result.verdict, "SUCCESS");
  assert.equal(statusDescription(result.verdict, result.findings, result.infra, result.counts), "(1 flaky) 99.6% passed (239 passed, 1 failed, 0 skipped)");
  assert.match(renderSummary({ findings: result.findings, infra: null, runURL: "u", counts: result.counts, trunkBranch: "master", pr: true }), /Failed only on linux: it passed on macos and windows on this same commit/);
});

// ---------------------------------------------------------------- a break trunk fixed (mattermost#39376 on the FIPS lanes)

const trunkRun = (sha: string, day: number, status = "passed", error_excerpt: string | null = null): Observation =>
  obs({ commit_sha: sha, status, created_at: `2026-10-${day}T00:00:00Z`, error_excerpt });
// The Cypress stuck step from mattermost#39376: each run's selector names its own post id.
const stuckOn = (postId: string): string => `AssertionError: Timed out retrying after 30000ms: Expected to find element: \`#CENTER_actions_button_${postId}\`, but never found it.`;
const stuckTest = { ...failing, error: stuckOn("4j9jsuqqytnz8x37pnir3dmeqc") };
// Newest first: three passes since p1, after four same-error failures, after older passes.
const fixedOnTrunkHistory = (err = stuckOn("1xpbzs3wdbf3xb8nzkswcuuqhc")): Observation[] => [
  trunkRun("p3", 27), trunkRun("p2", 26), trunkRun("p1", 25),
  trunkRun("f4", 24, "failed", err), trunkRun("f3", 23, "failed", err), trunkRun("f2", 22, "failed", err), trunkRun("f1", 21, "failed", err),
  ...trunkPasses(4),
];
const fixCompare = (shas: string[], aheadBy = shas.length): GhApi => async (_method, path) => {
  if (!path.startsWith("/repos/o/r/compare/abc...master")) throw new Error(`unexpected ${path}`);
  return { ahead_by: aheadBy, commits: shas.map((sha) => ({ sha, commit: { message: sha === "p1" ? "Pin FIPS base images to OpenSSL 3 (#39418)" : "x", committer: { date: "2026-10-26T12:47:46Z" } } })) };
};

test("a same-error streak on trunk that trunk has passed since is a fix there, not a flake", () => {
  const f = classify(stuckTest, fixedOnTrunkHistory(), [], undefined, 5);
  assert.equal(f.class, "FIXED_ON_TRUNK", "the same stuck step, whatever post id the selector names");
  assert.equal(f.blocking, true);
  assert.deepEqual([f.trunk_fixed?.last_fail?.commit_sha, f.trunk_fixed?.first_pass?.commit_sha], ["f4", "p1"]);
  const not = (history: Observation[], why: string): void => assert.notEqual(classify(stuckTest, history, [], undefined, 5).class, "FIXED_ON_TRUNK", why);
  assert.notEqual(classify(failing, fixedOnTrunkHistory("Error: expected visible"), [], undefined, 5).class, "FIXED_ON_TRUNK", "a generic error is no evidence of the same break");
  not(fixedOnTrunkHistory(stuckOn("1xpbzs3wdbf3xb8nzkswcuuqhc").replace("CENTER_actions_button", "RHS_COMMENT_actions_button")), "another stuck step");
  const stuck = stuckOn("1xpbzs3wdbf3xb8nzkswcuuqhc");
  not([trunkRun("p2", 26), trunkRun("p1", 25), trunkRun("f2", 24, "failed", stuck), trunkRun("f1", 23, "failed", stuck), ...trunkPasses(8)], "two failures in a row are a flake's");
  not([trunkRun("p3", 27), trunkRun("f3", 26, "failed", stuck), trunkRun("p2", 25), trunkRun("f2", 24, "failed", stuck), trunkRun("p1", 23), trunkRun("f1", 22, "failed", stuck), ...trunkPasses(4)], "failing and passing in turn");
  const ownError = { ...failing, error: "TypeError: Cannot read properties of undefined (reading 'id')" };
  assert.equal(classify(ownError, fixedOnTrunkHistory("TypeError: Cannot read properties of undefined (reading 'id')"), [], undefined, 5).class, "FIXED_ON_TRUNK", "the same distinctive error");
  assert.notEqual(classify(ownError, fixedOnTrunkHistory("TypeError: Cannot read properties of null (reading 'name')"), [], undefined, 5).class, "FIXED_ON_TRUNK", "trunk's streak was another failure");
  not([trunkRun("f5", 28, "failed", stuck), ...fixedOnTrunkHistory()], "trunk fails it again now");
});

test("a branch without trunk's fix is out of date; with it, the same failure goes to the judge", async () => {
  const fixedOne = (): Finding => classify(stuckTest, fixedOnTrunkHistory(), [], undefined, 5);
  const id = { repository: "o/r", commit_sha: "abc" };
  // The branch lacks trunk's last failing commit, so it lacks the fix that came after it.
  const stale = fixedOne();
  await markFixedOnTrunk({ findings: [stale], api: fixCompare(["m1", "f4", "p1", "m2"]), id, baseBranch: "master" });
  assert.deepEqual(stale.out_of_date, { base: "master", behind: 4, commit: { sha: "p1", date: "2026-10-26", pr: 39418 }, fixed: true });
  assert.equal(statusLabelOf(stale), "fixed on main");
  assert.match(renderSummary({ findings: [stale], infra: null, runURL: "u", counts: { failed: 1, passed: 9 }, trunkBranch: "master" }), /The failure first passed on master \(#39418, 2026-10-26\) after this PR last merged master, so this branch still has it\./);
  const current = fixedOne();
  await markFixedOnTrunk({ findings: [current], api: fixCompare(["m1", "m2"]), id, baseBranch: "master" });
  assert.equal(current.class, "REGRESSION", "it has the fix and fails anyway");
  assert.equal(current.blocking, true);
  // It has the last failure but not the first pass: the fix may be in either, so nothing is settled.
  const between = fixedOne();
  await markFixedOnTrunk({ findings: [between], api: fixCompare(["p1"]), id, baseBranch: "master" });
  assert.equal(between.decision, "evidence_incomplete");
  assert.equal(between.out_of_date, undefined);
  const cutOff = fixedOne();
  await markFixedOnTrunk({ findings: [cutOff], api: fixCompare(["m1", "m2"], 400), id, baseBranch: "master" });
  assert.equal(cutOff.decision, "evidence_incomplete", "a cut-off list can't show the branch has the fix");
});

test("end to end: the trunk-fixed failure on a stale branch reads fixed on main, never flaky", async () => {
  const run = runOf([{ title: "t1", file: "specs/a.spec.ts", error: stuckTest.error }]);
  const history = new Map([[identityKey(run.failing[0]), fixedOnTrunkHistory()]]);
  const result = await evaluate(run, { history, ask: null, fixedOnTrunk: (fs) => markFixedOnTrunk({ findings: fs, api: fixCompare(["f4", "p1"]), id: { repository: "o/r", commit_sha: "abc" }, baseBranch: "master" }) });
  assert.deepEqual(result.findings.map((f) => [f.class, f.blocking, statusLabelOf(f)]), [["FIXED_ON_TRUNK", true, "fixed on main"]]);
  assert.match(statusDescription(result.verdict, result.findings, result.infra, result.counts), /^\(1 fixed on main\)/);
  const text = summary({ findings: result.findings, counts: { passed: 9, failed: 1 }, runURL: "u", trunkBranch: "master" });
  assert.match(text, /^## E2E triage: 🔴 merge master and re-run: 1 fixed on master$/m);
  assert.match(text, /^### Fixed on master \(1\): master fixed these failures after this PR last merged master$/m);
  assert.match(text, /\*\*Merge master and re-run first\. 1 failure: 1 fixed on master\.\*\*/);
  const both = summary({ findings: [...result.findings, staleOnMaster("b")], counts: { passed: 9, failed: 2 }, runURL: "u", trunkBranch: "master" });
  assert.match(both, /^## E2E triage: 🔴 merge master and re-run: 1 fixed on master, 1 out of date$/m);
  assert.match(both, /^### Out of date \(2\): master changed these tests, or fixed these failures/m);
});
// ---------------------------------------------------------------- failing everywhere, storm runs

test("failing every try here and on another platform of this commit is never cleared by the model", async () => {
  // Master passes it, and one other PR failed it the same way: evidence the model may clear it by, short of the cross-PR rule.
  const error = "Test Failed: 'not null' doesn't match the selected view.";
  const run = runOf([{ title: "t1", file: "specs/a.spec.ts", error }]);
  run.failing[0].tries = { ran: 2, failed: 2 };
  const history = new Map([[identityKey(run.failing[0]), [...trunkPasses(8), obs({ gh_pr_number: 7, status: "failed", commit_sha: "p7", error_excerpt: error })]]]);
  const flaky: Answer = { cause: "flaky_environment", confidence: 0.99, cited_evidence: ["cross_pr"], explanation: "x" };
  const on = (result: string): Partial<EvaluateParams> => ({ history, ask: answering(() => flaky), otherPlatforms: async (fs) => { for (const f of fs) f.other_lanes = [{ platform: "detox-ios", result }]; } });
  const passedOnIos = (await evaluate(run, on("passed"))).findings[0];
  assert.deepEqual([passedOnIos.blocking, passedOnIos.decision], [false, "adjudicator_unblock"], "the model clears it when iOS passed");
  const held = await evaluate(run, on("failed"));
  const [f] = held.findings;
  assert.deepEqual([f.class, f.blocking, f.failed_everywhere, f.decision, statusLabelOf(f)], ["REGRESSION", true, ["detox-ios"], "advice", "needs investigation"]);
  assert.match(f.reason, /^Failed all 2 tries here and failed on detox-ios on this same commit; a flake rarely does that\. Fails here, passes on trunk/);
  assert.equal(held.verdict, "FAILURE");
  const text = renderSummary({ findings: held.findings, counts: { passed: 9, failed: 1 }, runURL: "u", trunkBranch: "main" });
  assert.match(text, /\| Failed every try here and on another platform of this same commit; a flake rarely does that\. Also failed on detox-ios in this run\. \| Read the error before re-running\. \|/);
  // Out of date as well: its why is the base branch's, and the platforms are still named.
  const stale = renderSummary({ findings: [{ ...f, out_of_date: { base: "main", behind: 3, commit: null } }], counts: { passed: 9, failed: 1 }, runURL: "u", trunkBranch: "main" });
  assert.match(stale, /after this PR last merged main, so the PR ran its old copy\. Also failed on detox-ios in this run\. \|/);
  assert.match(text, /99% sure, but a failure on every try and on another platform is not cleared\./);
  assert.equal(sameFailure([f, { ...finding({ title: "t2", file: "specs/a.spec.ts", error, failure_signatures: [errorSignature(error) ?? ""] }), class: "FLAKY_ON_TRUNK", blocking: false }])[0].blocking, true, "a cleared test with the same error doesn't clear it");
  // Each condition alone is not enough: a retry that passed elsewhere, a try that passed here, a single try.
  for (const [why, result, tries] of [
    ["passed on retry on iOS", "flaky", { ran: 2, failed: 2 }],
    ["one try passed here", "failed", { ran: 2, failed: 1 }],
    ["one try only", "failed", { ran: 1, failed: 1 }],
  ] as const) {
    run.failing[0].tries = { ...tries };
    assert.equal((await evaluate(run, on(result))).findings[0].blocking, false, why);
  }
});

test("a rules clear of a failure everywhere is undone only where nothing failed the same way", async () => {
  const bare = 'Error: thrown: "Exceeded timeout of 300000 ms for a hook.';
  // Desktop #4042: master fails the test the same way on two OSes; its failure everywhere is master's flake.
  const sameWay = "Error: Timed out waiting for selector \".DesktopAuthToken\" to be visible";
  const everywhere = (error: string, trunk: Observation[]): Finding => holdFailedEverywhere([{ ...classify({ ...failing, error, tries: { ran: 2, failed: 2 } }, trunk, []), other_lanes: [{ platform: "macos", result: "failed" }] }])[0];
  const flake = (error: string): Observation[] => [...trunkPasses(8), obs({ status: "failed", commit_sha: "f1", error_excerpt: error })];
  const held = everywhere(bare, flake(bare));
  assert.deepEqual([held.class, held.blocking, held.failed_everywhere], ["REGRESSION", true, ["macos"]], "a bare timeout matches nothing");
  const master = everywhere(sameWay, flake(sameWay));
  assert.deepEqual([master.class, master.blocking, master.failed_everywhere], ["FLAKY_ON_TRUNK", false, undefined]);
  // A break on trunk and the PR's own spec keep their calls.
  assert.equal(everywhere(sameWay, [obs({ status: "failed", error_excerpt: sameWay }), ...trunkPasses(6)]).class, "BROKEN_ON_TRUNK");
  assert.equal(holdFailedEverywhere([finding({ class: "OWNED_BY_PR", blocking: true, tries: { ran: 2, failed: 2 }, other_lanes: [{ platform: "ios", result: "failed" }] })])[0].failed_everywhere, undefined);
});

test("a Mattermost id joined to a selector does not make master's failure another one", () => {
  // mattermost #39376 fips: master failed MM-T1486_3 the same way 23 times, each with its own post id.
  const at = (id: string): string => `AssertionError: Timed out retrying after 30000ms: Expected to find element: \`#CENTER_actions_button_${id}\`, but never found it.`;
  // Each failure between two passes: a flake, not a streak trunk fixed.
  const trunk = Array.from({ length: 4 }, (_, i) => [obs({ commit_sha: `p${i}` }), obs({ status: "failed", commit_sha: `m${i}`, error_excerpt: at(`${"k".repeat(25)}${i}`) })]).flat();
  assert.equal(classify({ ...failing, error: at("p".repeat(20) + "abc123") }, [...trunk, obs({ commit_sha: "first" })], []).class, "FLAKY_ON_TRUNK");
});

test("a storm's failures are left out of history; a pass, this PR's runs and trunk's current streak are kept", async () => {
  const day = (d: number): string => `2026-09-${String(d).padStart(2, "0")}T00:00:00Z`;
  const rows = [
    obs({ group_id: "own", status: "failed", created_at: day(21) }),
    obs({ group_id: "streak", status: "failed", created_at: day(20) }),
    obs({ group_id: "green", status: "passed", created_at: day(19) }),
    obs({ group_id: "storm", status: "failed", created_at: day(18) }),
    obs({ group_id: "calm", status: "failed", created_at: day(17) }),
    obs({ group_id: "wide", status: "failed", created_at: day(16) }),
    obs({ group_id: "gone", status: "flaky", created_at: day(15) }),
    obs({ status: "failed", created_at: day(14) }),
  ];
  const history = new Map([["k", rows]]);
  const asked: string[] = [];
  // TSIO sums a run over its reports: "wide" is 40 failures of 2000 (every OS and retest), not a storm.
  const stats: Record<string, { total: number; failed: number }> = { storm: { total: 650, failed: 134 }, calm: { total: 650, failed: 2 }, wide: { total: 2000, failed: 40 } };
  const fetchImpl: FetchImpl = async (url) => {
    const id = url.split("/reports/")[1];
    asked.push(id);
    return stats[id] ? Response.json({ test_stats: stats[id] }) : new Response("down", { status: 503 });
  };
  const logs: string[] = [];
  const dropped = await dropStormRuns({ history, fetchImpl, base: "http://tsio", minFailures: 30, trunkBranch: "master", own: "own", log: (m) => logs.push(m) });
  assert.deepEqual(asked, ["storm", "calm", "wide", "gone"], "newest first; never this run, trunk's current streak, or a pass");
  assert.deepEqual([...dropped].sort(), ["gone", "storm"]);
  assert.deepEqual(history.get("k")?.map((o) => o.group_id ?? null), ["own", "streak", "green", "calm", "wide", null]);
  assert.deepEqual(logs, ["history: left out the failures of 1 storm run(s) and of 1 that could not be read"]);
  // A pass in a storm is kept, and so is every row of this PR's own runs: they never clear its failure.
  const mixed = new Map([["k", [obs({ group_id: "storm", status: "passed" }), obs({ group_id: "storm", status: "failed", gh_pr_number: "5" }), obs({ group_id: "storm", status: "failed", gh_pr_number: 9 })]]]);
  await dropStormRuns({ history: mixed, fetchImpl, base: "http://tsio", minFailures: 30, trunkBranch: "master", pr: 5 });
  assert.deepEqual(mixed.get("k")?.map((o) => [o.status, o.gh_pr_number ?? null]), [["passed", null], ["failed", "5"]]);
  // Nothing failed, nothing read.
  const quiet = new Map([["k", [obs({ group_id: "green", status: "passed" })]]]);
  assert.equal((await dropStormRuns({ history: quiet, fetchImpl: async () => { throw new Error("no read expected"); }, base: "http://tsio", minFailures: 30 })).size, 0);
  // A read past the deadline is not awaited, and its run is left out as unread.
  const slow = new Map([["k", [obs({ group_id: "green", status: "passed" }), obs({ group_id: "hung", status: "failed" })]]]);
  const hung = await dropStormRuns({ history: slow, fetchImpl: () => new Promise<Response>(() => {}), base: "http://tsio", minFailures: 30, trunkBranch: "master", deadlineMs: 20 });
  assert.deepEqual([...hung], ["hung"]);
});

test("master's own triage keeps a storm-sized break as a streak: a commit that breaks 35 tests is never flaky on the next run", async () => {
  // Run N broke 35 tests on master and is a storm; run N+1 fails the same test. Older runs had one flaky pass.
  // A skipped run in between is no trial: it neither starts nor ends the streak.
  const history = new Map([["k", [obs({ group_id: "skip", status: "skipped", created_at: "2026-09-21T00:00:00Z" }), obs({ group_id: "n", status: "failed", created_at: "2026-09-20T00:00:00Z" }), ...trunkPasses(6), obs({ group_id: "old", status: "flaky", commit_sha: "o1" })]]]);
  await dropStormRuns({ history, fetchImpl: async () => Response.json({ test_stats: { total: 650, failed: 35 } }), base: "http://tsio", minFailures: 30, trunkBranch: "master" });
  assert.deepEqual(history.get("k")?.map((o) => o.group_id ?? null), ["skip", "n", null, null, null, null, null, null, "old"], "the streak is kept; nothing else failed");
  const f = classify(failing, history.get("k") ?? [], [], undefined, null, null, { isTrunkRun: true, trunkBranch: "master" });
  assert.deepEqual([f.class, f.blocking], ["BROKEN_ON_TRUNK", true]);
});

test("a flaky run in history keeps the error of its failed try, which trunk's comparison reads", async () => {
  const error = "Error: expect(locator).toHaveText(expected) failed: expected \"Channel header\"";
  const fetchImpl = fakeFetch([["/reports/history", () => Response.json({ observations: [
    obs({ group_id: "g1", retry_count: 0, status: "failed", error_excerpt: error }),
    obs({ group_id: "g1", retry_count: 1, status: "passed", error_excerpt: null }),
  ], has_more: false })]]);
  const history = await fetchHistory(fetchImpl, "http://tsio", "o/r", [failing], "2026-09-17T00:00:00Z", DEFAULTS, "master");
  const [row] = history.get(identityKey(failing)) ?? [];
  assert.deepEqual([row.status, row.error_excerpt], ["flaky", error]);
  assert.equal(classify({ ...failing, error }, [...trunkPasses(8), row], []).class, "FLAKY_ON_TRUNK", "master retried past this same error");
});


// ---------------------------------------------------------------- a release branch's run (CMT)

// desktop CMT on v6.3.2-rc.2: master fixed the failing tests after release-6.3 was cut, and the branch had no history.
const releaseRoutes = ({ histories, compare, asked = [], statuses = [], master = trunkPasses(8), answer = null, bodies = [] }: { histories: HistoryBody[]; compare: unknown; asked?: string[]; statuses?: StatusBody[]; master?: Observation[]; answer?: Partial<Answer> | null; bodies?: MessageBody[] }): Route[] => [
  ...(answer ? [["api.anthropic.com", (init: RequestInit | undefined) => { bodies.push(parsed<MessageBody>(bodyText(init))); return modelReply(init, answer); }] as Route] : []),
  ...runRoutes([spec("t1", "failed")], "cmt-desktop"),
  ["/reports/history", (init) => { const body = parsed<HistoryBody>(bodyText(init)); histories.push(body); return Response.json({ observations: body.branch === "master" ? master : [] }); }],
  ["/compare/abc...master", () => { asked.push("compare"); return Response.json(compare); }],
  ["/commits?sha=master&path=specs%2Fa.spec.ts", () => Response.json([{ sha: "m1", commit: { message: "ci(e2e): restore 12.0 master E2E (#4012)", committer: { date: "2026-10-01T09:00:00Z" } } }])],
  ["/statuses/abc", (i) => { statuses.push(parsed<StatusBody>(bodyText(i))); return Response.json({}); }],
  ["/commits/abc/statuses", () => Response.json([{ context: "e2e/cmt", state: "failure", target_url: "https://github.com/o/r/actions/runs/12" }])],
  ["/commits/abc", () => Response.json({ files: [] })],
  ["/repos/o/r", () => { asked.push("repo"); return Response.json({ default_branch: "master" }); }],
];
const releaseEnv = (branch: string) => ({
  ...env,
  COMPOSITE_IDENTITY: JSON.stringify({ repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "cmt-desktop", branch }),
  STATUS_CONTEXT: "e2e/cmt",
  TRIAGE_CONTEXT: "off",
  ANTHROPIC_API_KEY: "",
});

test("a release branch's run checks its tests against the default branch: a test master changed since is out of date", async () => {
  await inTmp(async (dir) => {
    const histories: HistoryBody[] = [];
    const statuses: StatusBody[] = [];
    const compare = { ahead_by: 61, files: [{ filename: "specs/a.spec.ts" }], commits: [{ sha: "m1" }] };
    const result = await triage({ env: { ...releaseEnv("release-6.3"), GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(releaseRoutes({ histories, compare, statuses })), log: () => {} });
    assert.deepEqual(histories.map((h) => h.branch).filter(Boolean), ["release-6.3", "master"], "too little history on the branch: master's is read");
    const [f] = result.findings;
    assert.equal(f.blocking, true);
    assert.deepEqual(f.out_of_date, { base: "master", behind: 61, commit: { sha: "m1", date: "2026-10-01", pr: 4012 } });
    assert.equal(statusLabelOf(f), "out of date");
    assert.match(statuses.at(-1)?.description ?? "", /^\(1 out of date\) /);
    const text = readFileSync(join(dir, "s.md"), "utf8");
    assert.match(text, /^## E2E triage · [^:]+: 🔴 1 out of date: master changed these tests after release-6\.3 branched$/m);
    assert.match(text, /History is read from master, the default branch: release-6\.3 has 0 earlier runs of these tests, fewer than 5\./);
    assert.match(text, /^### Out of date \(1\): master changed these tests after release-6\.3 branched from it$/m);
    assert.match(text, /\| master changed this test \(#4012, 2026-10-01\) after release-6\.3 branched from it, so this run used release-6\.3's old copy\. \| Backport the test change to release-6\.3, or ignore it for this release\. \|/);
    assert.match(text, /\| Changed on master since release-6\.3 branched \| Yes: m1 \(#4012\) on 2026-10-01\. release-6\.3 is 61 commits behind master, so it ran its old copy of the test \|/);
    assert.match(text, /Backport master's test changes to release-6\.3, or ignore them for this release\./);
    assert.doesNotMatch(text, /this PR|Merge master/);
  });
});

test("a release branch's test master did not change keeps its call; master's own run is not compared with itself", async () => {
  const histories: HistoryBody[] = [];
  const unchanged = await triage({ env: releaseEnv("release-6.3"), fetchImpl: fakeFetch(releaseRoutes({ histories, compare: { ahead_by: 61, files: [{ filename: "app/x.ts" }], commits: [] } })), log: () => {} });
  assert.equal(unchanged.findings[0].out_of_date, undefined);
  assert.equal(unchanged.findings[0].class, "REGRESSION", "judged on master's history: it passes there");
  const asked: string[] = [];
  const master = await triage({ env: releaseEnv("master"), fetchImpl: fakeFetch(releaseRoutes({ histories: [], compare: { ahead_by: 3, files: [{ filename: "specs/a.spec.ts" }], commits: [] }, asked })), log: () => {} });
  assert.deepEqual(asked, ["repo"], "the default branch is read, and never compared with itself");
  assert.equal(master.findings[0].out_of_date, undefined);
});

test("history-report reads history under a wider report name than the run's own", async () => {
  const histories: HistoryBody[] = [];
  await triage({ env: { ...releaseEnv("release-6.3"), REPORT_NAME: "e2e-on-ubuntu-latest-11.11.3", HISTORY_REPORT: "e2e-on-ubuntu-latest" }, fetchImpl: fakeFetch([
    ...releaseRoutes({ histories, compare: { ahead_by: 0, files: [], commits: [] } }).filter(([m]) => m !== "/reports/g1/suites"),
    ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-11.11.3" }] })],
  ]), log: () => {} });
  assert.deepEqual([...new Set(histories.map((h) => h.report))], ["e2e-on-ubuntu-latest"]);
});

test("master's flakiness never clears a release branch's failure: it is another line of code", async () => {
  // desktop CMT: master flakes on MM-T4054 with the same error; v6.3.2-rc.2 failed it 30 of 30 tries, on its stale copy.
  const master = [...trunkPasses(8), obs({ status: "flaky", commit_sha: "f1", error_excerpt: "Error: expected visible" })];
  const fixed = await triage({ env: releaseEnv("release-6.3"), fetchImpl: fakeFetch(releaseRoutes({ histories: [], master, compare: { ahead_by: 61, files: [{ filename: "specs/a.spec.ts" }], commits: [{ sha: "m1" }] } })), log: () => {} });
  const [f] = fixed.findings;
  assert.deepEqual([f.class, f.blocking, statusLabelOf(f)], ["FLAKY_ON_TRUNK", true, "out of date"], "held, and checked against master: master changed the test");
  assert.match(f.reason, /That is master's history, not this branch's, so it does not clear a failure here\.$/);
  const unchanged = await triage({ env: releaseEnv("release-6.3"), fetchImpl: fakeFetch(releaseRoutes({ histories: [], master, compare: { ahead_by: 61, files: [], commits: [] } })), log: () => {} });
  assert.deepEqual([unchanged.findings[0].blocking, statusLabelOf(unchanged.findings[0])], [true, "needs investigation"]);
});

test("an out-of-date test names every base-branch commit to it since the branch last had it, newest first", async () => {
  // desktop MM-T4054: master's #3957 is the latest change, after the fixes #3960 and #3923 the release branch also lacks.
  await inTmp(async (dir) => {
    const commit = (sha: string, pr: number, date: string) => ({ sha, commit: { message: `change (#${pr})`, committer: { date: `${date}T00:00:00Z` } } });
    const log = [commit("c3", 3957, "2026-08-27"), commit("c2", 3960, "2026-08-26"), commit("old", 3887, "2026-07-08"), commit("c1", 3923, "2026-07-30")];
    const routes = releaseRoutes({ histories: [], compare: { ahead_by: 61, files: [{ filename: "specs/a.spec.ts" }], commits: [{ sha: "c1" }, { sha: "c2" }, { sha: "c3" }] } })
      .map(([m, r]): Route => (m.startsWith("/commits?sha=master&path=") ? [m, () => Response.json(log)] : [m, r]));
    const result = await triage({ env: { ...releaseEnv("release-6.3"), GITHUB_STEP_SUMMARY: join(dir, "s.md") }, fetchImpl: fakeFetch(routes), log: () => {} });
    assert.deepEqual(result.findings[0].out_of_date?.also?.map((c) => c.pr), [3960, 3923], "only commits the branch lacks; #3887 is before the cut");
    const text = readFileSync(join(dir, "s.md"), "utf8");
    assert.match(text, /master changed this test \(#3957, 2026-08-27; also #3960, #3923\) after release-6\.3 branched from it/);
    assert.match(text, /Yes: c3 \(#3957\) on 2026-08-27, and earlier #3960, #3923\./);
  });
});

// ---------------------------------------------------------------- a release branch's run: what kind of failure (CMT)

const releaseRef = { repository: "o/r", name: "cmt-desktop", branch: "v6.3.2-rc.2", base: "master", historyBranch: "master" };
const releaseFinding = (over: Partial<Finding> = {}): Finding => ({ ...classify({ ...failing, report_name: "e2e-on-ubuntu-latest-11.11.3", tries: { ran: 2, failed: 2 } }, trunkPasses(8), []), release: true, blocking: true, ...over });
const fixedOnMaster = { base: "master", behind: 61, commit: { sha: "c3", date: "2026-08-27", pr: 3957 }, also: [{ sha: "c2", date: "2026-08-26", pr: 3960 }], diff: "@@ -12 +12 @@\n-const PNG = 'bad'\n+const PNG = 'valid'" };

test("a release pack carries the release, the default branch's change to the test, and every lane; no PR", () => {
  const pack = releasePack(releaseFinding({ out_of_date: fixedOnMaster, other_lanes: [{ platform: "ubuntu-latest-10.11.25", result: "failed" }] }), releaseRef, []);
  assert.deepEqual(pack.release, { id: "release", branch: "v6.3.2-rc.2", base: "master", history_branch: "master", server: "11.11.3" });
  assert.deepEqual(pack.base_change, { id: "base_change", commits: ["#3957 (2026-08-27)", "#3960 (2026-08-26)"], diff: fixedOnMaster.diff });
  const ids = evidenceIds(pack);
  assert.ok(ids.includes("release") && ids.includes("base_change") && ids.includes("other_platforms"));
  assert.ok(!ids.includes("pr.changed_files"), "there is no PR to cite");
  assert.equal(releasePack(releaseFinding(), releaseRef, []).base_change, undefined, "no change on master: nothing to cite");
  assert.equal(serverOf("mobile-release-detox-android-Server_12.1.0-rc2"), "12.1.0-rc2");
  assert.equal(releasePack(releaseFinding({ report_name: null }), { ...releaseRef, name: "mobile-release-detox-ios-Server_12.0.1" }, []).release?.server, "12.0.1", "a mobile lane names its server in its group");
});

test("a release answer clears only on the evidence its cause requires; an app bug is named and stays red", () => {
  const answer = (cause: Answer["cause"], cited: string[], confidence = 0.92): Answer => ({ cause, confidence, cited_evidence: cited, explanation: "x" });
  const stale = releasePack(releaseFinding({ out_of_date: fixedOnMaster }), releaseRef, []);
  const plain = releasePack(releaseFinding(), releaseRef, []);
  const d = (a: Answer, p = plain) => { const r = decideRelease(a, p); return [r.blocking, r.decision]; };
  assert.deepEqual(d(answer("test_bug", ["base_change"]), stale), [false, "adjudicator_unblock"], "master fixed the test since the cut");
  assert.deepEqual(d(answer("test_bug", ["error", "test"])), [true, "engine"], "a test bug with no fix on master is a guess");
  assert.deepEqual(d(answer("test_bug", ["base_change"], 0.8), stale), [true, "engine"], "not sure enough");
  assert.deepEqual(d(answer("test_bug", ["base_change"])), [true, "engine"], "base_change cited but not in the pack");
  const lanes = (...results: [string, string][]): Pack => releasePack(releaseFinding({ other_lanes: results.map(([platform, result]) => ({ platform, result })) }), releaseRef, []);
  assert.deepEqual(d(answer("server_compat", ["other_platforms"]), lanes(["ubuntu-latest-12.1.0-rc2", "passed"], ["macos-26-11.11.3", "failed"])), [false, "adjudicator_unblock"], "passes against another server version");
  assert.deepEqual(d(answer("server_compat", ["other_platforms"]), lanes(["macos-26-11.11.3", "passed"])), [true, "engine"], "a pass on another OS of the same server is not a server version");
  assert.deepEqual(d(answer("flaky_environment", ["cross_pr"]), releasePack(releaseFinding({ cross_pr: { prs: [7], examples: ["PR 7 (abc, 10-01)"], passes: 3 } }), releaseRef, [])), [false, "adjudicator_unblock"]);
  const everywhere = releasePack(releaseFinding({ cross_pr: { prs: [7], examples: ["PR 7 (abc, 10-01)"], passes: 3 }, other_lanes: [{ platform: "windows-2022-11.11.3", result: "failed" }] }), releaseRef, []);
  assert.deepEqual(d(answer("flaky_environment", ["cross_pr"]), everywhere), [true, "engine"], "failed every try here and on every other lane: not flaky");
  assert.deepEqual(d(answer("app_bug", ["error"])), [true, "adjudicator_blame"]);
  assert.deepEqual(d(answer("app_bug", ["error"], 0.7)), [true, "engine"], "a weak app-bug guess is not named");
  assert.deepEqual(decide("REGRESSION", answer("test_bug", ["base_change"]), stale).blocking, false, "decide sends a release pack to its own rules");
});

test("a release run asks its own question, allows only its causes, and is keyed apart from a PR's", async () => {
  const pack = releasePack(releaseFinding({ out_of_date: fixedOnMaster }), releaseRef, []);
  const bodies: MessageBody[] = [];
  const res = await askModelBatch(async (_u, init) => { bodies.push(parsed<MessageBody>(bodyText(init))); return modelReply(init, { cause: "test_bug", confidence: 0.95, cited_evidence: ["base_change"], explanation: "Stale fixture." }); }, "k", DEFAULTS.model, [pack]);
  assert.equal(bodies[0].system, SYSTEM_RELEASE);
  assert.deepEqual(bodies[0].output_config.format.schema.properties.answers?.items.properties.cause?.enum, ["app_bug", "test_bug", "flaky_environment", "server_compat"]);
  const text = contentText(bodies[0].messages[0].content);
  assert.match(text, /"release":\{"id":"release","branch":"v6\.3\.2-rc\.2","base":"master","history_branch":"master"\}/);
  assert.doesNotMatch(text, /"pr":|diff_hunks/);
  assert.equal((res.answers[0] as Answer).cause, "test_bug");
  assert.throws(() => parseAnswer(JSON.stringify({ cause: "caused_by_pr", confidence: 0.9, cited_evidence: [], explanation: "x" }), ["app_bug", "test_bug", "flaky_environment", "server_compat"]), /unknown cause/);
  const prPack = buildPack(releaseFinding(), [], prCtx, []);
  assert.notEqual(answerKey(DEFAULTS.model, pack), answerKey(DEFAULTS.model, { ...pack, release: undefined, base_change: undefined }), "the question is part of the key");
  assert.ok(answerKey(DEFAULTS.model, prPack).startsWith("v5:"));
});

test("end to end: a release run's stale test is cleared as a test bug, and an app bug is named, on the check and in the summary", async () => {
  await inTmp(async (dir) => {
    const compare = { ahead_by: 61, files: [{ filename: "specs/a.spec.ts", patch: "@@ -1 +1 @@\n-old\n+fixed" }], commits: [{ sha: "m1" }] };
    const statuses: StatusBody[] = [];
    const bodies: MessageBody[] = [];
    const env = { ...releaseEnv("release-6.3"), ANTHROPIC_API_KEY: "AK", GITHUB_STEP_SUMMARY: join(dir, "s.md") };
    const testBug = await triage({ env, fetchImpl: fakeFetch(releaseRoutes({ histories: [], compare, statuses, bodies, answer: { cause: "test_bug", confidence: 0.95, cited_evidence: ["base_change"], explanation: "The old fixture is invalid; master replaced it." } })), log: () => {} });
    const [f] = testBug.findings;
    assert.deepEqual([f.blocking, f.decision, statusLabelOf(f)], [false, "adjudicator_unblock", "test bug"]);
    assert.equal(testBug.verdict, "SUCCESS");
    assert.match(statuses.at(-1)?.description ?? "", /^\(1 test bug\) /);
    assert.match(contentText(bodies[0].messages[0].content), /"base_change":\{"id":"base_change","commits":\["#4012 \(2026-10-01\)"\],"diff":"@@ -1 \+1 @@\\n-old\\n\+fixed"\}/);
    const text = readFileSync(join(dir, "s.md"), "utf8");
    assert.match(text, /\| Looks like a test bug \(AI, 95% sure\): The old fixture is invalid; master replaced it\. \| Backport the test fix, or ignore it for this release\. \|/);
    assert.match(text, /Not an app bug \(a test bug\), 95% sure/);
    assert.match(text, /^## E2E triage · [^:]+: ✅ no app bug found$/m);
    assert.match(text, /\*\*1 failure: 1 not an app bug \(1 test bug\)\.\*\*/);
    assert.match(text, /^### Not an app bug \(1\)$/m);

    const appStatuses: StatusBody[] = [];
    const appBug = await triage({ env, fetchImpl: fakeFetch(releaseRoutes({ histories: [], compare: { ahead_by: 61, files: [], commits: [] }, statuses: appStatuses, answer: { cause: "app_bug", confidence: 0.9, cited_evidence: ["error"], explanation: "The preview modal never opens." } })), log: () => {} });
    assert.deepEqual([appBug.findings[0].blocking, statusLabelOf(appBug.findings[0])], [true, "app bug"]);
    assert.match(appStatuses.at(-1)?.description ?? "", /^\(1 app bug\) /);
    assert.equal(redReason(appStatuses.at(-1)?.description), "1 app bug");
    assert.match(readFileSync(join(dir, "s.md"), "utf8"), /\| Looks like an app bug in this build \(AI, 90% sure\): The preview modal never opens\. \| Read the error, and file it against this release if it holds\. \|/);
  });
});

test("a release run's lanes are every other report of the run, by OS and server version; a shard of its own is not", () => {
  const f = finding({ title: "t1", file: "specs/a.spec.ts", report_name: "e2e-on-ubuntu-latest-11.11.3" });
  const elsewhere = new Map([[elsewhereKey("specs/a.spec.ts", "t1"), [
    { report: "e2e-on-ubuntu-latest-10.11.25", status: "passed" },
    { report: "e2e-on-macos-26-11.11.3", status: "failed" },
    { report: "e2e-on-ubuntu-latest-11.11.3-2-of-2", status: "failed" },
  ]]]);
  sameTestOnOtherReports([f], { elsewhere } as unknown as RunResult, true);
  assert.deepEqual(f.other_lanes, [{ platform: "macos-26-11.11.3", result: "failed" }, { platform: "ubuntu-latest-10.11.25", result: "passed" }]);
});

test("a row names at most three other lanes, then how many more", () => {
  const lanes = ["a", "b", "c", "d", "e"].map((platform) => ({ platform, result: "failed" }));
  const text = renderSummary({ findings: [finding({ title: "t1", file: "specs/a.spec.ts", other_lanes: lanes })], counts: { failed: 1, passed: 9 }, runURL: "u", trunkBranch: "master" });
  assert.match(text, /Also failed on a, b, c and 2 more in this run/);
  const four = renderSummary({ findings: [finding({ title: "t1", file: "specs/a.spec.ts", other_lanes: lanes.slice(0, 4) })], counts: { failed: 1, passed: 9 }, runURL: "u", trunkBranch: "master" });
  assert.match(four, /Also failed on a, b, c, d in this run/);
});
