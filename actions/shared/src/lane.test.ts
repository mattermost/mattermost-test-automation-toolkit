// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitStatus } from "./github.ts";
import { laneName, laneSummary, redReason } from "./lane.ts";

const st = (state: string, description: string): CommitStatus => ({ state, description }) as CommitStatus;
const lanes = (rows: Record<string, CommitStatus | null>) => laneSummary(Object.entries(rows).map(([context, status]) => ({ context, status })));

test("a lane's name in the PR-wide check drops the shared prefix", () => {
  assert.equal(laneName("e2e-test/detox-ios"), "detox-ios");
  assert.equal(laneName("e2e/linux"), "linux");
});

test("the red reason reads the labels a status now carries", () => {
  assert.equal(redReason("(2 flaky, 2 caused by PR) 99.7% passed (1186 passed, 4 failed, 164 skipped)"), "2 not caused by PR, 2 caused by PR");
  assert.equal(redReason("(1 broken on main, 4 needs investigation) 90.0% passed (9 passed, 5 failed, 0 skipped)"), "1 not caused by PR, 4 to check");
  assert.equal(redReason("(1 out of date, 1 caused by PR) 50.0% passed (1 passed, 2 failed, 0 skipped)"), "1 caused by PR, 1 out of date");
  assert.equal(redReason("(3 flaky, 1 needs investigation; many failures in one run) 80.0% passed (4 passed, 1 failed, 0 skipped)"), "3 not caused by PR, 1 to check, many failures in one run");
  assert.equal(redReason("(17 flaky, 2 needs investigation; mostly environment errors, re-run) 96.9% passed (587 passed, 19 failed, 42 skipped)"), "17 not caused by PR, 2 to check, environment errors, re-run");
  assert.equal(redReason("(not triaged, mostly environment errors, re-run) 99.2% passed (240 passed, 2 failed, 3 skipped)"), "environment errors, re-run");
  assert.equal(redReason("(1 flaky; 2 report(s) missing) 0% passed (0 passed, 1 failed, 0 skipped)"), "1 not caused by PR, 2 report(s) missing, re-run");
  assert.equal(redReason("(re-run the failed jobs; 1 report(s) missing) 0% passed (0 passed, 1 failed, 0 skipped)"), "1 report(s) missing, re-run");
  assert.equal(redReason("(re-run the failed jobs) 0% passed (0 passed, 1 failed, 0 skipped)"), "re-run the failed jobs");
  assert.equal(redReason("(re-run the failed jobs) 615 passed, 0 failed, 2 not run, 17 skipped"), "2 specs did not run, re-run");
  assert.equal(redReason("(1 flaky; re-run the failed jobs) 18 passed, 2 failed, 1 not run, 0 skipped"), "1 not caused by PR, re-run the failed jobs");
  assert.equal(redReason("(re-run the failed jobs; 1 report(s) missing) 0 passed, 0 failed, 1 not run, 0 skipped"), "1 report(s) missing, re-run", "missing reports say more than the specs they left unrun");
  assert.equal(redReason("(re-running the failed jobs) 615 passed, 0 failed, 2 not run, 17 skipped"), "2 specs did not run, re-running");
  assert.equal(redReason("(re-running the failed jobs; 1 report(s) missing) 0% passed (0 passed, 1 failed, 0 skipped)"), "1 report(s) missing, re-running");
  assert.equal(redReason("(re-running the failed jobs) 0% passed (0 passed, 1 failed, 0 skipped)"), "re-running the failed jobs");
  assert.equal(redReason("(not re-run: the build failed) 615 passed, 0 failed, 2 not run, 17 skipped"), "not re-run: the build failed", "a held re-run names why");
  assert.equal(redReason("(1 flaky, 1 needs investigation) 10 passed, 1 failed, 1 not run, 0 skipped"), "1 not caused by PR, 1 to check", "a spec that did not run is not a re-run unless the status asks for one");
  assert.equal(redReason("(1 flaky; re-run the failed jobs) 10 passed, 1 failed, 3 not run, 0 skipped"), "1 not caused by PR, re-run the failed jobs", "beside other labels the not-run count is not all re-run");
});

test("the red reason still reads the wording a status written before the labels carries", () => {
  assert.equal(redReason("(49 cleared by triage, 4 unresolved; investigation required) 91.3% passed (555 passed, 53 failed, 42 skipped)"), "49 not caused by PR, 4 to check, many failures in one run");
  assert.equal(redReason("(0 cleared by triage; 1 report(s) missing) 100% passed (1 passed, 0 failed, 0 skipped)"), "1 report(s) missing, re-run");
  assert.equal(redReason("(not triaged, investigation required) 99.2% passed"), "many failures in one run");
  assert.equal(redReason("(3 flaky, 1 needs investigation; investigation required) 80.0% passed (4 passed, 1 failed, 0 skipped)"), "3 not caused by PR, 1 to check, many failures in one run");
  assert.equal(redReason("10 passed, 2 failed (not triaged: triage could not finish)"), "triage could not finish");
  assert.equal(redReason("(0 flaky) 100% passed (9 passed, 0 failed, 0 skipped)"), "still red", "nothing named is nothing to explain");
  assert.equal(redReason(undefined), "still red");
});

test("a lane summary reads red lanes by their labels and old wording alike, and names the lanes cleared by triage", () => {
  assert.deepEqual(lanes({
    "e2e-test/detox-ios": st("failure", "(2 flaky, 5 needs investigation) 88% passed (590 passed, 7 failed, 41 skipped)"),
    "e2e-test/maestro-ios": st("success", "(1 flaky) 99.9% passed (5000 passed, 1 failed, 0 skipped)"),
    "e2e-test/detox-ipad": st("success", "(0 flaky) 100% passed (19 passed, 0 failed, 0 skipped)"),
    "e2e-test/maestro-android": null,
  }), { state: "failure", description: "detox-ios: 2 not caused by PR, 5 to check · maestro-ios cleared by triage" });
  assert.deepEqual(lanes({
    "e2e-test/playwright-full/enterprise": st("failure", "(1 out of date, 2 caused by PR) 50% passed (4 passed, 4 failed, 0 skipped)"),
    "e2e/linux": st("success", "235 passed, 0 failed"),
  }), { state: "failure", description: "playwright-full/enterprise: 2 caused by PR, 1 out of date" });
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("success", "(0 flaky) 597 passed, 0 failed") }), { state: "success", description: "All lanes green" });
});

test("a flagged run reads the same way: its flag while a failure blocks, none once all are cleared", () => {
  // Every failure cleared: no flag, green, and named as cleared by triage.
  assert.deepEqual(lanes({ "e2e-test/playwright": st("success", "(4 flaky) 0% passed (0 passed, 4 failed, 0 skipped)") }),
    { state: "success", description: "playwright cleared by triage · all lanes green" });
  // One still blocks: the flag stays, after the labels.
  assert.equal(redReason("(3 flaky, 1 caused by PR; mostly environment errors, re-run) 0% passed (0 passed, 4 failed, 0 skipped)"), "3 not caused by PR, 1 caused by PR, environment errors, re-run");
  assert.equal(redReason("(24 flaky, 6 needs investigation; many failures in one run) 0% passed (0 passed, 30 failed, 0 skipped)"), "24 not caused by PR, 6 to check, many failures in one run");
  assert.equal(redReason("(4 needs investigation; mostly environment errors, re-run) 0% passed (0 passed, 4 failed, 0 skipped)"), "4 to check, environment errors, re-run");
});

test("a lane that is pending keeps the PR-wide check pending, whatever its labels", () => {
  assert.deepEqual(lanes({ "e2e-test/detox-ios": st("pending", "(1 flaky) running"), "e2e-test/maestro-ios": st("failure", "(1 caused by PR) 0% passed") }),
    { state: "pending", description: "Triage is checking: waiting for detox-ios" });
});

test("a red check triage does not cover keeps the aggregate from saying all lanes green", () => {
  const green = { context: "e2e-test/playwright-full/enterprise", status: st("success", "100% passed (1315)") };
  const upgrade = { context: "e2e-test/playwright-full/enterprise/upgrade-from-release-11.10", status: st("failure", "99.8% passed, 2 failed") };
  assert.deepEqual(laneSummary([green], [upgrade]), { state: "success", description: "triaged lanes green · not triaged: playwright-full/enterprise/upgrade-from-release-11.10 red" });
  assert.deepEqual(laneSummary([green], [{ ...upgrade, status: st("pending", "running") }]), { state: "success", description: "All lanes green" }, "a running check is not red yet");
  assert.equal(laneSummary([{ context: "e2e-test/cypress-full/enterprise", status: st("failure", "(1 caused by PR) 99.9% passed") }], [upgrade]).description,
    "cypress-full/enterprise: 1 caused by PR · not triaged: playwright-full/enterprise/upgrade-from-release-11.10 red");
});
