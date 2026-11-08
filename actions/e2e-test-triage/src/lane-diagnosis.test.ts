// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FetchImpl } from "../../shared/src/github.ts";
import { allPassed, orchestrationFrom, unitResult } from "../../shared/src/orchestration.ts";
import type { Orchestration } from "../../shared/src/orchestration.ts";
import { REPORTS_INCOMPLETE, UPSTREAM_FAILED } from "../../shared/src/status.ts";
import { redReason } from "../../shared/src/lane.ts";
import { trunkBroken } from "./baseline.ts";
import type { Baseline, TrunkRun } from "./baseline.ts";
import { diagnoseLane, jobCause, laneDescription, laneTurnsGreen } from "./lane-diagnosis.ts";
import type { LaneFacts } from "./lane-diagnosis.ts";
import { errorLines, lanePrefixOf, stepLines } from "./lane-jobs.ts";
import type { LaneJob } from "./lane-jobs.ts";
import { triage } from "./triage.ts";

// ---- fixtures, shaped on the runs they name ----

const unit = (spec: string, state: string, attempts: { status: string | null; actual_duration_ms?: number; expired?: boolean }[] = [{ status: state === "completed_fail" ? "failed" : "passed" }]) => ({ spec_path: spec, state, attempts });
const passing = (n: number, from = 0) => Array.from({ length: n }, (_, i) => unit(`specs/functional/s${from + i}.spec.ts`, "completed_pass"));
const failing = (n: number) => Array.from({ length: n }, (_, i) => unit(`specs/functional/f${i}.spec.ts`, "completed_fail"));
const orch = (units: ReturnType<typeof unit>[], status = "completed", failedTests = 0): Orchestration =>
  orchestrationFrom({ status, total_units: units.length, units, tests: { passed: 100, failed: failedTests, flaky: 0, skipped: 0, total: 100 + failedTests } });

const job = (over: Partial<LaneJob>): LaneJob => ({ id: 1, name: "e2e-playwright / playwright-full / dispatch-run-playwright--chrome-1", short: "dispatch-run-playwright--chrome-1", conclusion: "success", step: null, tail: "", errors: [], worker: true, ...over });
const workers = (n: number, dead: Partial<LaneJob>[] | Record<number, Partial<LaneJob>> = []): LaneJob[] => [
  job({ id: 100, short: "prepare-run", worker: false }),
  job({ id: 101, short: "dispatch-begin", worker: false }),
  ...Array.from({ length: n }, (_, i) => job({ id: 200 + i, short: `dispatch-run-playwright--chrome-${i + 1}`, ...((dead as Record<number, Partial<LaneJob>>)[i] ?? {}) })),
];
const trunk = (state: string, o: Orchestration | null = null, sha = "aaaaaaa1"): TrunkRun => ({ sha, state, description: state === "success" ? "100% passed" : REPORTS_INCOMPLETE, orchestration: o });
const baseline = (over: Partial<Baseline> = {}): Baseline => ({ context: "e2e-test/playwright-full/enterprise/master", base: "master", atBase: null, tip: null, behindBy: 0, baseChanged: [], peers: null, ...over });
const facts = (over: Partial<LaneFacts>): LaneFacts => ({ trunkRun: false, orchestration: null, jobs: workers(30), prFiles: [], baseline: baseline(), lanePaths: ["e2e-tests/playwright/specs", "e2e-tests/playwright/lib"], staleRerun: false, ...over });
const OIDC = { conclusion: "failure", step: "ci/dispatch-run", errors: ["##[error]drain loop failed: Error message: Failed to get ID Token."], tail: "##[error]dispatch-run action crashed: Error: Error message: Failed to get ID Token." };
const massBroken = orch([...failing(300), ...passing(20)]);

// ---- the orchestration reader ----

test("a unit's result: its final state, else any lease that reported, else unfinished", () => {
  assert.equal(unitResult({ state: "completed_pass", attempts: [] }), "passed");
  assert.equal(unitResult({ state: "completed_fail", attempts: [] }), "failed");
  // mattermost run 41940673353: team_advanced_rules.spec.ts ran 14.6 min, past its 10-min lease. Its late report passed
  // every test, the re-lease never finished, and TSIO marked the unit abandoned.
  assert.equal(unitResult({ state: "abandoned", attempts: [{ status: "passed" }, { status: null }] }), "passed");
  assert.equal(unitResult({ state: "abandoned", attempts: [{ status: null }] }), "unfinished");
  assert.equal(unitResult({ state: "pending", attempts: [] }), "unfinished");
  assert.equal(unitResult({ state: "abandoned", attempts: [{ status: "interrupted" }] }), "failed");
  // TSIO's worker deadline killed the spec and reported it interrupted: it never finished, it did not fail.
  const killed = orchestrationFrom({ status: "timed_out", total_units: 1, units: [{ spec_path: "specs/a.spec.ts", state: "completed_fail", attempts: [{ status: "interrupted", error_message: "killed at worker deadline (deadline-minutes); spec did not finish in this worker" }] }] });
  assert.deepEqual([killed.unfinished.length, killed.failed.length], [1, 0]);
  const realFail = orchestrationFrom({ status: "completed", total_units: 1, units: [{ spec_path: "specs/a.spec.ts", state: "completed_fail", attempts: [{ status: "interrupted", error_message: "killed at worker deadline" }, { status: "failed" }] }] });
  assert.equal(realFail.failed.length, 1, "a retest that ran and failed is a failure");
});

test("every spec passed needs every unit dispatched, none unfinished or failed, and no failed test", () => {
  assert.equal(allPassed(orch(passing(10))), true);
  assert.equal(allPassed(orch([...passing(9), unit("specs/x.spec.ts", "abandoned", [{ status: null }])], "timed_out")), false);
  assert.equal(allPassed(orch([...passing(9), unit("specs/x.spec.ts", "completed_fail")])), false);
  assert.equal(allPassed(orch(passing(10), "completed", 1)), false, "a failed test in TSIO's rollup is not a pass");
  assert.equal(allPassed(orchestrationFrom({ status: "completed", total_units: 11, units: passing(10), tests: { total: 10 } })), false, "a unit TSIO did not send is not a pass");
  assert.equal(allPassed(null), false);
});

// ---- reading a job's log ----

test("a step's own lines and its most repeated error lines, without its header or the dispatch loop's progress", () => {
  const log = [
    "2026-11-04T12:00:00.0000000Z ##[group]Run ci/dispatch-run",
    "2026-11-04T12:00:00.0000000Z shell: /usr/bin/bash -e {0}",
    "2026-11-04T12:00:00.0000000Z ##[endgroup]",
    "2026-11-04T12:00:01.0000000Z \u001b[31m     AssertionError: Timed out retrying after 30000ms: Expected to find element: `#postListContent`, but never found it.\u001b[0m",
    "2026-11-04T12:00:02.0000000Z reported (failed) → completed_fail [queue: pending=3 leased=1 pass=1 fail=4 skip=0]",
    "2026-11-04T12:00:03.0000000Z      AssertionError: Timed out retrying after 10000ms: Expected to find element: `#postListContent`, but never found it.",
    "2026-11-04T12:00:04.0000000Z   ✖  1 of 1 failed (100%)                      03:39        3        -        3",
    "2026-11-04T12:09:00.0000000Z outside the step",
  ].join("\n");
  const lines = stepLines(log, Date.parse("2026-11-04T12:00:00Z"), Date.parse("2026-11-04T12:00:05Z"));
  assert.ok(!lines.some((l) => l.includes("shell:") || l.includes("outside")));
  const errors = errorLines(lines);
  assert.equal(errors.length, 1, "progress lines are not errors; the two timeouts are one error");
  assert.match(errors[0], /^AssertionError: Timed out retrying after 30000ms: Expected to find element: `#postListContent`/);
});

test("the lane's prefix comes from its own result job's name", () => {
  assert.equal(lanePrefixOf("e2e-cypress / cypress-full / lane-result / lane-result"), "e2e-cypress / cypress-full / ");
  assert.equal(lanePrefixOf("e2e-playwright-fips / playwright-rolling-upgrades / playwright-rolling-upgrades (release-11.10, 11.10, 11.10.4, false, release-11.10) / report"), "e2e-playwright-fips / playwright-rolling-upgrades / playwright-rolling-upgrades (release-11.10, 11.10, 11.10.4, false, release-11.10) / ");
  assert.equal(lanePrefixOf("triage"), "");
});

test("a dead job's cause: the machine, the code, its time, or after the tests", () => {
  assert.equal(jobCause(job(OIDC)).kind, "infra");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/restore-playwright-deps", tail: "Failed to restore: Egress is over the account limit." })).kind, "infra");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/claim-status", tail: "Error: GitHub GET /repos/mattermost/mattermost/commits/5af8481/statuses: 500 " })).kind, "infra");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/checkout-repo", tail: "fatal: could not fetch 4f1c0e from promisor remote" })).kind, "infra");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/upload-debug-artifacts", tail: "Error: read ECONNRESET" })).kind, "infra");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/upload-debug-artifacts", tail: "Error: zip error" })).kind, "after-tests");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/dispatch-run", tail: "##[error]The action 'ci/dispatch-run' has timed out after 25 minutes." })).kind, "timeout");
  const server = jobCause(job({ conclusion: "failure", step: "ci/start-server", tail: "Mattermost container not healthy, retry attempts exhausted. Giving up." }));
  assert.deepEqual([server.kind, server.short], ["code", "the test server did not start"]);
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/prepare-playwright", tail: "Error: Unknown PW_TESTCONTAINERS_SERVICES entry: nginx" })).short, "the test setup failed");
  assert.equal(jobCause(job({ conclusion: "failure", step: "ci/install", tail: "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync." })).short, "the dependencies did not install");
});

// ---- the lane verdict, one case per root cause ----

test("every spec ran and passed: green, whatever worker or report was lost (fix 1)", () => {
  // mattermost run 42288723475: worker 14's server never started; the other 39 ran all 421 specs.
  const v = diagnoseLane(facts({ orchestration: orch(passing(421)), jobs: workers(40, { 13: { conclusion: "failure", step: "ci/start-server", tail: "Mattermost container not healthy, retry attempts exhausted. Giving up." } }) }));
  assert.deepEqual([v.label, v.state, v.fault, v.rerun], ["all specs ran", "success", "nobody", "none"]);
  // A rolling-upgrade worker whose harness failed (ci/upgrade-to) before dispatch: its tests ran where the orchestration
  // never sees them, so the other workers' clean run does not vouch for the lane.
  const harness = diagnoseLane(facts({ orchestration: orch(passing(421)), jobs: workers(40, { 13: { conclusion: "failure", step: "ci/upgrade-to", tail: "  ✘  1 [upgrade-to] › upgrade_to.ts:12 › baseline survives the upgrade\n  1 failed\n  4 passed (2.1m)" } }) }));
  assert.notEqual(harness.label, "all specs ran");
  assert.equal(harness.state, "failure");
  // run 41940673353: the abandoned spec's late report passed; the slow spec is named in the evidence.
  const slow = diagnoseLane(facts({ orchestration: orch([...passing(409), unit("specs/functional/system_console/abac/teams/team_advanced_rules.spec.ts", "abandoned", [{ status: "passed", actual_duration_ms: 874041, expired: true }, { status: null, expired: true }])], "timed_out"), jobs: workers(30, { 8: { conclusion: "failure", step: "ci/dispatch-run", tail: "##[error]The action 'ci/dispatch-run' has timed out after 25 minutes." } }) }));
  assert.equal(slow.state, "success");
  assert.ok(slow.evidence.some((e) => /team_advanced_rules\.spec\.ts ran 15 min, past its lease/.test(e)));
});

test("most specs failing is the base branch's when it fails the same way at the merge base, never a re-run", () => {
  // Nov 4: mattermost#39029 removed IconContainer while mattermost#38735 still imported it; PRs branched from it.
  const dead = { conclusion: "failure", step: "ci/dispatch-run", errors: ["Error: expect(locator).toBeVisible() failed"] };
  const atBase = trunk("failure", massBroken);
  const v = diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase, tip: atBase }) }));
  assert.deepEqual([v.label, v.fault, v.rerun], ["broken on main", "base branch", "none"]);
  // The specs ran and failed as the base branch does: not the PR's, so the PR's lane is green (as each test would be).
  assert.equal(v.state, "success");
  assert.match(v.what, /^300 of 320 specs failed: Error: expect\(locator\)\.toBeVisible\(\) failed/);
  assert.equal(laneDescription(v, false, "master"), "(broken on main, not your change) 300 of 320 specs failed: Error: expect(locator).toBeVisible() failed");
  // Fixed since: merge the base branch.
  const fixed = diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase, tip: trunk("success", null, "bbbbbbb2") }) }));
  assert.deepEqual([fixed.label, fixed.action, fixed.state], ["fixed on main", "merge master and push", "success"]);
  assert.equal(laneDescription(fixed, false, "master").startsWith("(fixed on main, not your change) "), true);
  // Green at the merge base: the PR broke it.
  const mine = diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: trunk("success") }) }));
  assert.deepEqual([mine.label, mine.fault, mine.state], ["caused by PR", "PR", "failure"]);
  // A trunk run: the base branch is broken; green before this commit says this commit did it.
  const onTrunk = diagnoseLane(facts({ trunkRun: true, orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: trunk("success") }) }));
  assert.deepEqual([onTrunk.label, onTrunk.action], ["broken on main", "fix the base branch: this commit broke the lane"]);
  assert.match(laneDescription(onTrunk, false), /^\(broken on main\) /);
  assert.equal(onTrunk.state, "failure", "the base branch's own run stays red");
});

test("the base branch's run at the merge base not finished yet: other PRs failing the same way at the same time make it the base branch's", async () => {
  // Nov 4, 11:27 UTC: PR 39682 branched from 69d345c (the break); master's own run there finished at 12:38, so the newest
  // finished master run was 18c8573's, from before the break, and green. Other PRs had already failed the same way.
  const dead = { conclusion: "failure", step: "ci/dispatch-run", errors: ["Error: expect(locator).toBeVisible() failed"] };
  const older = { ...trunk("success", null, "18c8573"), exact: false };
  const peers = { broken: ["PR 39387", "PR 39645", "PR 39583"], healthy: ["PR 39100"] };
  const v = diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: older, tip: older, peers }) }));
  assert.deepEqual([v.label, v.fault], ["broken on main", "base branch"]);
  assert.match(v.evidence[0], /^3 other runs of this lane in the 6 hours before failed the same way \(PR 39387, PR 39645, PR 39583\); 1 did not; the merge base's own run was not finished/);
  // Without peers that fail too, an older green run still reads as the PR's: one other PR is not enough.
  assert.equal(diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: older, peers: { broken: ["PR 1"], healthy: [] } }) })).label, "caused by PR");
  // The merge base's own run passed: the PR broke it, whatever other PRs did.
  assert.equal(diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: { ...trunk("success"), exact: true }, peers }) })).label, "caused by PR");
});

test("the merge base's own run still going but already failing most specs is the base branch's", () => {
  const dead = { conclusion: "failure", step: "ci/dispatch-run", errors: ["Error: expect(locator).toBeVisible() failed"] };
  const going = { sha: "69d345c", exact: true, state: "pending", description: "E2E tests queued or running", orchestration: orch([...failing(150), ...passing(5)], "in_progress") };
  const v = diagnoseLane(facts({ orchestration: massBroken, jobs: workers(30, Array(30).fill(dead)), baseline: baseline({ atBase: going, tip: { ...trunk("success", null, "18c8573"), exact: false } }) }));
  assert.deepEqual([v.label, v.fault], ["broken on main", "base branch"]);
  assert.match(v.evidence[0], /on 69d345c is still running and has already failed 150 specs/);
});

test("a test setup failing everywhere on a PR that changes none of the lane's code is fixed on main: not the PR's, merge main", () => {
  // PR 39106: master's workflow passes the nginx service; the branch, 341 commits behind, has the lib that rejects it.
  const nginx = { conclusion: "failure", step: "ci/prepare-playwright", tail: "Error: Unknown PW_TESTCONTAINERS_SERVICES entry: nginx" };
  const pending = orch(Array.from({ length: 382 }, (_, i) => unit(`specs/s${i}.spec.ts`, "pending", [])), "timed_out");
  const at = { ...trunk("success"), exact: true };
  const v = diagnoseLane(facts({ orchestration: pending, jobs: workers(30, Array(30).fill(nginx)), prFiles: ["server/channels/app/x.go"], baseline: baseline({ atBase: at, behindBy: 341, baseChanged: null }) }));
  // No spec ran, so nothing vouches for the PR: red, but the base branch's to explain, with the merge as the fix.
  assert.deepEqual([v.label, v.fault, v.state], ["fixed on main", "base branch", "failure"]);
  // The same failure on a PR that edits the lane's test code is the PR's.
  assert.equal(diagnoseLane(facts({ orchestration: pending, jobs: workers(30, Array(30).fill(nginx)), prFiles: ["e2e-tests/playwright/lib/src/server.ts"], baseline: baseline({ atBase: at, behindBy: 341, baseChanged: null }) })).label, "caused by PR");
});

test("every worker dead on the same setup step is judged by the logs read: ten of thirty is enough", () => {
  const nginx = { conclusion: "failure", step: "ci/prepare-playwright", tail: "Error: Unknown PW_TESTCONTAINERS_SERVICES entry: nginx" };
  const unread = { conclusion: "failure", step: "ci/prepare-playwright" };
  const pending = orch(Array.from({ length: 382 }, (_, i) => unit(`specs/s${i}.spec.ts`, "pending", [])), "timed_out");
  const v = diagnoseLane(facts({ orchestration: pending, jobs: workers(30, [...Array(10).fill(nginx), ...Array(20).fill(unread)]), baseline: baseline({ atBase: { ...trunk("success"), exact: true }, behindBy: 341, baseChanged: ["e2e-tests/playwright/lib/src/server/testcontainers.ts"] }) }));
  assert.deepEqual([v.label, v.fault], ["fixed on main", "base branch"]);
});

test("a setup that fails on every worker is the PR's, or fixed on main when the base branch changed the lane's code", () => {
  // PR 39465 (Go FIPS bump): the FIPS server never booted on any of 40 workers; master's FIPS lane was green.
  const server = { conclusion: "failure", step: "ci/start-server", tail: "Mattermost container not healthy, retry attempts exhausted. Giving up." };
  const pending = orch(passing(0).concat(Array.from({ length: 421 }, (_, i) => unit(`specs/s${i}.spec.ts`, "pending", []))), "timed_out");
  const v = diagnoseLane(facts({ orchestration: pending, jobs: workers(40, Array(40).fill(server)), baseline: baseline({ atBase: trunk("success") }) }));
  assert.deepEqual([v.label, v.fault, v.rerun], ["caused by PR", "PR", "none"]);
  assert.match(v.what, /^ci\/start-server failed on 40 of 40 workers: Mattermost container not healthy/);
  // PR 39106: the workflow (master's) passes the nginx service; the branch's lib, 40 commits old, rejects it.
  const nginx = { conclusion: "failure", step: "ci/prepare-playwright", tail: "Error: Unknown PW_TESTCONTAINERS_SERVICES entry: nginx" };
  const old = diagnoseLane(facts({ orchestration: pending, jobs: workers(30, Array(30).fill(nginx)), baseline: baseline({ atBase: trunk("success"), behindBy: 40, baseChanged: ["e2e-tests/playwright/lib/src/testcontainers/services.ts"] }) }));
  assert.deepEqual([old.label, old.fault], ["fixed on main", "base branch"]);
  assert.equal(laneDescription(old, false, "master").startsWith("(fixed on main, merge master) ci/prepare-playwright failed on 30 of 30 workers"), true);
  // A lockfile out of sync breaks prep-deps itself: no worker ran.
  const lock = diagnoseLane(facts({ orchestration: null, jobs: [job({ short: "prep-deps", worker: false, conclusion: "failure", step: "ci/install-playwright-deps", tail: "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync." }), ...workers(30).slice(2).map((j) => ({ ...j, conclusion: "skipped" }))], baseline: baseline({ atBase: trunk("success") }) }));
  assert.deepEqual([lock.label, lock.fault], ["caused by PR", "PR"]);
});

test("a machine failure on some workers is the machine's, re-run as a whole lane once its TSIO run began (fix 5)", () => {
  // mattermost run 41880194751: worker 14's OIDC mint timed out before it took a spec; 3 specs never ran.
  const o = orch([...passing(418), ...Array.from({ length: 3 }, (_, i) => unit(`specs/u${i}.spec.ts`, "abandoned", [{ status: null }]))], "timed_out");
  const v = diagnoseLane(facts({ orchestration: o, jobs: workers(40, { 13: OIDC }) }));
  assert.deepEqual([v.label, v.fault, v.rerun], ["machine failure", "infrastructure", "lane"]);
  assert.equal(v.what, "worker 14: Failed to get ID Token.; 3 specs never finished");
  assert.equal(laneDescription(v, true), "(machine failure, re-running the lane) worker 14: Failed to get ID Token.; 3 specs never finished");
  assert.match(laneDescription(v, false), /^\(machine failure, re-run all jobs\)/);
  // A server that failed on one worker of forty is not the code: the other 39 started the same build.
  const one = diagnoseLane(facts({ orchestration: o, jobs: workers(40, { 13: { conclusion: "failure", step: "ci/start-server", tail: "Mattermost container not healthy, retry attempts exhausted. Giving up." } }) }));
  assert.deepEqual([one.label, one.rerun], ["machine failure", "lane"]);
  // The orchestration never began (prepare-run's statuses read answered 500): re-running the failed jobs is enough.
  const claim = diagnoseLane(facts({ orchestration: null, jobs: [job({ short: "prepare-run", worker: false, conclusion: "failure", step: "ci/claim-status", tail: "Error: GitHub GET /repos/mattermost/mattermost/commits/5af8481/statuses: 500 " }), ...workers(30).slice(2).map((j) => ({ ...j, conclusion: "skipped" }))] }));
  assert.deepEqual([claim.label, claim.rerun], ["machine failure", "failed-jobs"]);
  // GitHub never created prep-deps: nothing failed, and the lane's jobs were skipped.
  const skipped = diagnoseLane(facts({ orchestration: null, jobs: [job({ short: "prepare-run", worker: false }), job({ short: "dispatch-begin", worker: false, conclusion: "skipped" }), job({ short: "dispatch-run-playwright-${{ inputs.server_edition }}-${{ matrix.worker_index }}", conclusion: "skipped" }), job({ short: "lane-result / lane-result", worker: false, conclusion: "failure", step: "ci/assert-results" })] }));
  assert.deepEqual([skipped.label, skipped.rerun], ["machine failure", "lane"]);
  assert.match(skipped.what, /never ran: dispatch-begin, dispatch-run-playwright-\*-\* skipped/);
  // A "re-run failed jobs" on a closed run: its workers took nothing; say to re-run all jobs.
  const stale = diagnoseLane(facts({ orchestration: o, jobs: workers(40), staleRerun: true }));
  assert.deepEqual([stale.label, stale.action], ["machine failure", "re-run all jobs"]);
});

test("a spec the PR changed that outlasts its worker is the PR's; specs failed in a lost report are named", () => {
  const spec = "specs/functional/system_console/abac/teams/team_advanced_rules.spec.ts";
  const o = orch([...passing(409), unit(spec, "abandoned", [{ status: null, expired: true }])], "timed_out");
  const timeout = { conclusion: "failure", step: "ci/dispatch-run", tail: "##[error]The action 'ci/dispatch-run' has timed out after 25 minutes." };
  const v = diagnoseLane(facts({ orchestration: o, jobs: workers(30, { 8: timeout }), prFiles: [`e2e-tests/playwright/${spec}`] }));
  assert.deepEqual([v.label, v.fault, v.action], ["caused by PR", "PR", "make team_advanced_rules.spec.ts faster or split it"]);
  // Not the PR's spec: a slow machine, re-run.
  assert.equal(diagnoseLane(facts({ orchestration: o, jobs: workers(30, { 8: timeout }), prFiles: ["server/x.go"] })).label, "machine failure");
  // Two specs failed in a report that never arrived: named, the PR's when it changed them.
  const lost = orch([...passing(400), unit("specs/functional/a.spec.ts", "completed_fail"), unit("specs/functional/b.spec.ts", "completed_fail")]);
  const named = diagnoseLane(facts({ orchestration: lost, jobs: workers(30, { 2: OIDC }), prFiles: ["e2e-tests/playwright/specs/functional/a.spec.ts"] }));
  assert.deepEqual([named.label, named.state], ["caused by PR", "failure"]);
  assert.match(named.what, /2 specs failed in a lost report: a\.spec\.ts, b\.spec\.ts/);
  // Not the PR's specs: the report was lost in delivery, so the lane is re-run for it (never "needs a look").
  const unowned = diagnoseLane(facts({ orchestration: lost, jobs: workers(30, { 2: OIDC }), prFiles: ["server/x.go"] }));
  assert.deepEqual([unowned.label, unowned.fault, unowned.rerun], ["machine failure", "infrastructure", "lane"]);
  // Failures the arrived reports hold were judged test by test: they are not judged again here.
  assert.equal(diagnoseLane(facts({ orchestration: lost, jobs: workers(30, { 2: OIDC }), judgedSpecs: ["functional/a.spec.ts", "functional/b.spec.ts"] })).label, "machine failure");
});

test("a lane red for no reason shown is re-run as a machine failure, or the PR's when it changes the lane's code", () => {
  // A spec never finished, no job failed, nothing timed out.
  const o = orch([...passing(400), unit("specs/functional/x.spec.ts", "pending", [])], "timed_out");
  const machine = diagnoseLane(facts({ orchestration: o, jobs: workers(30), prFiles: ["server/x.go"] }));
  assert.deepEqual([machine.label, machine.fault, machine.rerun], ["machine failure", "infrastructure", "lane"]);
  assert.match(machine.what, /1 spec never finished and no job says why/);
  const mine = diagnoseLane(facts({ orchestration: o, jobs: workers(30), prFiles: ["e2e-tests/playwright/lib/src/server.ts"] }));
  assert.deepEqual([mine.label, mine.fault, mine.rerun], ["caused by PR", "PR", "none"]);
  // No label is ever "needs investigation" or "out of date".
  for (const v of [machine, mine]) assert.doesNotMatch(laneDescription(v, false, "master"), /needs investigation|out of date/);
});

test("a lane the base branch explains turns the run green only with complete results; all specs ran always may", () => {
  assert.equal(laneTurnsGreen({ state: "success", label: "all specs ran" }, true), true, "the orchestration vouches for every spec");
  assert.equal(laneTurnsGreen({ state: "success", label: "broken on main" }, false), true, "results complete");
  // A report missing or a job dead: the lane-result gate accepts only an orchestration basis, so no success is written.
  assert.equal(laneTurnsGreen({ state: "success", label: "broken on main" }, true), false);
  assert.equal(laneTurnsGreen({ state: "success", label: "fixed on main" }, true), false);
  assert.equal(laneTurnsGreen({ state: "failure", label: "machine failure" }, false), false);
});

test("a trunk run counts as broken only when most of its specs failed or none ran", () => {
  assert.equal(trunkBroken(trunk("failure", massBroken)), true);
  // Without an orchestration, the status text decides, in today's wording and the old one alike.
  assert.equal(trunkBroken({ sha: "a", state: "failure", description: "E2E jobs failed outside the tests; triage is checking why", orchestration: null }), true);
  assert.equal(trunkBroken({ sha: "a", state: "failure", description: "E2E upstream execution failed; re-run the failed jobs", orchestration: null }), true);
  assert.equal(trunkBroken({ sha: "a", state: "failure", description: "(1 flaky) 99.9% passed", orchestration: null }), false);
  assert.equal(trunkBroken(trunk("failure", orch([...failing(2), ...passing(400)]))), false, "a couple of failed tests is not a broken base branch");
  assert.equal(trunkBroken(trunk("failure", orch(Array.from({ length: 5 }, (_, i) => unit(`s${i}`, "pending", []))))), true, "none ran");
  assert.equal(trunkBroken(trunk("success")), false);
  assert.equal(trunkBroken({ sha: "x", state: "failure", description: "(1 needs investigation) 99.9% passed", orchestration: null }), false);
});

test("the PR-wide check names a lane's verdict and the interim texts", () => {
  assert.equal(redReason("(broken on main, not your change) 300 of 320 specs failed: Error"), "broken on main, not your change");
  assert.equal(redReason("(machine failure, re-running the lane) dispatch-run-14: …"), "machine failure, re-running the lane");
  assert.equal(redReason("(out of date, merge master) ci/prepare-playwright failed"), "out of date, merge master");
  assert.equal(redReason(REPORTS_INCOMPLETE), "triage is checking why");
  assert.equal(redReason("(1 caused by PR) 99.9% passed (1 failed)"), "1 caused by PR", "a test's label is read as before");
});

// ---- end to end through triage ----

const ID = { repository: "o/r", commit_sha: "abc", gh_run_id: "12", gh_run_attempt: "1", name: "playwright-full", branch: "pr-5", gh_pr_number: 5 };
const baseEnv = { COMPOSITE_IDENTITY: JSON.stringify(ID), STATUS_CONTEXT: "e2e-test/playwright", TEST_ROOT: "e2e-tests/playwright/specs", MODE: "enforce", GITHUB_TOKEN: "GH", TSIO_BASE_URL: "http://tsio", TRIAGE_CONTEXT: "off", GITHUB_RUN_ID: "12", GITHUB_RUN_ATTEMPT: "1", RUNNER_NAME: "runner-9", RERUN_ATTEMPTS: "1" };
const laneJobsBody = (dead: { name: string; step: string; id: number }[]) => ({
  total_count: 3 + dead.length,
  jobs: [
    { id: 1, name: "e2e-playwright / playwright-full / prepare-run", status: "completed", conclusion: "success", steps: [] },
    { id: 2, name: "e2e-playwright / playwright-full / dispatch-run-playwright--chrome-1", status: "completed", conclusion: "success", steps: [] },
    ...dead.map((d) => ({ id: d.id, name: `e2e-playwright / playwright-full / ${d.name}`, status: "completed", conclusion: "failure", steps: [{ name: d.step, conclusion: "failure", started_at: "2026-11-04T12:00:00Z", completed_at: "2026-11-04T12:05:00Z" }] })),
    { id: 9, name: "e2e-playwright / playwright-full / lane-result / lane-result", status: "in_progress", conclusion: null, runner_name: "runner-9", steps: [] },
  ],
});
type Route = [string, (init?: RequestInit) => Response];
function fake(routes: Route[]): FetchImpl & { posts: { url: string; body: { state: string; description: string } }[] } {
  const posts: { url: string; body: { state: string; description: string } }[] = [];
  const impl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (init.method === "POST" && url.includes("/statuses/abc")) {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({});
    }
    for (const [m, r] of routes) if (url.includes(m)) return r(init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return Object.assign(impl, { posts });
}
const inTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lane-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("end to end: a lane red only for a dead worker whose specs the others all ran turns green on the orchestration", async () => {
  await inTmp(async (dir) => {
    const out = join(dir, "out");
    const summary = join(dir, "summary.md");
    const fetchImpl = fake([
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "functional/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: "t1", status: "passed", retry_count: 0, ordinal: 0 }])],
      ["/orchestration/status", () => Response.json({ status: "completed", total_units: 2, tests: { passed: 2, failed: 0, total: 2 }, units: [{ spec_path: "specs/functional/a.spec.ts", state: "completed_pass", attempts: [{ status: "passed" }] }, { spec_path: "specs/functional/b.spec.ts", state: "completed_pass", attempts: [{ status: "passed" }] }] })],
      ["/commits/abc/statuses", () => Response.json([{ context: "e2e-test/playwright", state: "failure", description: UPSTREAM_FAILED, target_url: "https://github.com/o/r/actions/runs/12" }])],
      ["/pulls/5/files", () => Response.json([{ filename: "server/x.go" }])],
      ["/pulls/5", () => Response.json({ base: { ref: "master" }, labels: [] })],
      ["/actions/runs/12/attempts/1/jobs", () => Response.json(laneJobsBody([{ name: "dispatch-run-playwright--chrome-14", step: "ci/start-server", id: 14 }]))],
      ["/actions/jobs/14/logs", () => new Response("2026-11-04T12:01:00.0000000Z Mattermost container not healthy, retry attempts exhausted. Giving up.")],
    ]);
    const result = await triage({ env: { ...baseEnv, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, fetchImpl, log: () => {} });
    assert.equal(result.verdict, "SUCCESS");
    assert.deepEqual(fetchImpl.posts.map((p) => [p.body.state, p.body.description]), [["success", "(all specs ran) 1 worker lost after the other workers ran every spec"]]);
    const outputs = readFileSync(out, "utf8");
    assert.match(outputs, /^basis=orchestration$/m);
    assert.match(outputs, /^lane_label=all specs ran$/m);
    assert.match(readFileSync(summary, "utf8"), /Whose fault:\*\* nobody's: every spec ran and passed/);
  });
});

test("end to end: missing reports after a worker's OIDC timeout is a machine failure, re-run from prepare-run", async () => {
  await inTmp(async (dir) => {
    const out = join(dir, "out");
    const fetchImpl = fake([
      ["/reports/g1/suites", () => Response.json({ suites: [{ id: "s1", file_path: "functional/a.spec.ts" }] })],
      ["/reports/g1/cases", () => Response.json([{ suite_id: "s1", title: "t1", status: "passed", retry_count: 0, ordinal: 0 }])],
      ["/reports/g1", () => Response.json({ id: "g1", status: "incomplete", total_reports_expected: 2, reports: [{}] })],
      ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "incomplete", total_reports_expected: 2 }] })],
      ["/orchestration/status", () => Response.json({ status: "timed_out", total_units: 2, tests: { passed: 1, failed: 0, total: 1 }, units: [{ spec_path: "specs/functional/a.spec.ts", state: "completed_pass", attempts: [{ status: "passed" }] }, { spec_path: "specs/functional/b.spec.ts", state: "abandoned", attempts: [] }] })],
      ["/commits/abc/statuses", () => Response.json([{ context: "e2e-test/playwright", state: "failure", description: REPORTS_INCOMPLETE, target_url: "https://github.com/o/r/actions/runs/12" }])],
      ["/pulls/5/files", () => Response.json([{ filename: "server/x.go" }])],
      ["/pulls/5", () => Response.json({ base: { ref: "master" }, labels: [] })],
      ["/actions/runs/12/attempts/1/jobs", () => Response.json(laneJobsBody([{ name: "dispatch-run-playwright--chrome-14", step: "ci/dispatch-run", id: 14 }]))],
      ["/actions/jobs/14/logs", () => new Response("2026-11-04T12:01:00.0000000Z ##[error]drain loop failed: Error message: Failed to get ID Token.")],
      ["/compare/", () => Response.json({ merge_base_commit: { sha: "m1" }, behind_by: 0 })],
      ["/commits?sha=", () => Response.json([{ sha: "m1" }])],
      ["/commits/m1/statuses", () => Response.json([{ context: "e2e-test/playwright/master", state: "success", description: "100% passed" }])],
    ]);
    const result = await triage({ env: { ...baseEnv, GITHUB_OUTPUT: out }, fetchImpl, log: () => {}, wait: { attempts: 0, ms: 0 } });
    assert.equal(result.verdict, "FAILURE");
    const [post] = fetchImpl.posts;
    assert.equal(post.body.state, "failure");
    assert.equal(post.body.description, "(machine failure, re-running the lane) worker 14: Failed to get ID Token.; 1 spec never finished");
    const outputs = readFileSync(out, "utf8");
    assert.match(outputs, /^rerun=true$/m);
    assert.match(outputs, /^rerun_job=1$/m, "the lane's prepare-run, re-run with every job after it");
    assert.match(outputs, /^basis=lane$/m);
  });
});

// ---- history of a lane the base branch runs rarely ----
import { fetchHistory } from "./history.ts";
import { DEFAULTS } from "./config.ts";
import { identityKey } from "../../shared/src/tsio.ts";

test("a lane crowded out of the base branch's last runs (an upgrade lane) has its trunk history read over the whole window", async () => {
  // master's last 50 runs of edit_policies_rules.spec.ts: 49 from the standard lanes, 1 from the upgrade lane.
  const row = (i: number, name: string, status = "passed") => ({ file: "specs/edit_policies_rules.spec.ts", title: "t1", status, retry_count: 0, gh_pr_number: null, commit_sha: `c${i}`, created_at: "2026-11-05T00:00:00Z", branch: "master", group_id: `g${name}${i}`, name });
  const crowded = [...Array.from({ length: 49 }, (_, i) => row(i, "playwright-full-enterprise-master")), row(0, "playwright-full-enterprise-upgrade-from-release-11.11-master", "failed")];
  const window = Array.from({ length: 12 }, (_, i) => row(i, "playwright-full-enterprise-upgrade-from-release-11.11-master", i < 3 ? "failed" : "passed"));
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const observations = body.since ? window : body.branch ? crowded : [];
    return Response.json({ observations, has_more: false });
  }) as FetchImpl;
  const t = { file: "specs/edit_policies_rules.spec.ts", title: "t1", error: "Error: x" };
  const history = await fetchHistory(fetchImpl, "http://tsio", "o/r", [t], "2026-11-06T00:00:00Z", DEFAULTS, "master", null, () => {}, "playwright-full-enterprise-upgrade-from-release-11.11");
  assert.equal(bodies.length, 3, "trunk by count, trunk over the window, then cross-PR");
  assert.equal(bodies[1].since, "2026-10-23T00:00:00.000Z");
  assert.equal(history.get(identityKey(t))?.length, 12, "the upgrade lane's 12 runs, the window's copy of the one already read deduplicated");
  // A lane with enough of its own runs among the last 50 reads no more.
  bodies.length = 0;
  await fetchHistory(fetchImpl, "http://tsio", "o/r", [t], "2026-11-06T00:00:00Z", DEFAULTS, "master", null, () => {}, "playwright-full-enterprise");
  assert.equal(bodies.length, 2);
});
