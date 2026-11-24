// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitStatus } from "./github.ts";
import { releaseFromDescriptions } from "./lane.ts";
import { inferRelease, statusPublisher } from "./status.ts";
import type { GhApi } from "./github.ts";
import type { CompositeIdentity } from "./tsio.ts";

const id: CompositeIdentity = { repository: "o/r", commit_sha: "sha" };
const summary = "e2e-test/triage";
const aggregate = (description: string): CommitStatus[] => [{ context: summary, state: "failure", description } as CommitStatus];
const prEvent = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge", GITHUB_REF_NAME: "7/merge" };

test("an explicit RELEASE wins over everything else", () => {
  assert.equal(inferRelease({ ...id, branch: "master" }, { RELEASE: "true" }), true);
  assert.equal(inferRelease({ ...id, branch: "release-11.7" }, { ...prEvent, RELEASE: " FALSE " }), false);
});

test("release is read from the tested identity, not from the workflow's own event", () => {
  assert.equal(inferRelease({ ...id, branch: "release-11.7" }, prEvent), true, "a release branch's commit tested from a PR-triggered workflow");
  assert.equal(inferRelease({ ...id, branch: "main" }, prEvent), false);
  assert.equal(inferRelease({ ...id, branch: "master" }), false);
  assert.equal(inferRelease({ ...id, branch: "release-11.7", gh_pr_number: 7 }), false, "a PR into a release branch");
  assert.equal(inferRelease(id, prEvent), undefined, "nothing in the identity, the ref or the aggregate says");
});

test("with no branch in the identity, a release workflow ref says release", () => {
  assert.equal(inferRelease(id, { GITHUB_REF: "refs/heads/release-11.7" }), true);
  assert.equal(inferRelease(id, { GITHUB_REF_NAME: "release/v6.3" }), true);
  assert.equal(inferRelease(id, { GITHUB_REF: "refs/heads/master" }), undefined);
  assert.equal(inferRelease(id, { GITHUB_REF: "refs/pull/7/merge" }), undefined);
});

test("the aggregate's text decides last, by the same rule the lane summary uses", () => {
  assert.equal(inferRelease(id, {}, aggregate("playwright-full/enterprise: 1 app bug, pull main changes"), summary), false);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 test bug, pull release-11.7 changes"), summary), false);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 test bug"), summary), true);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 out of date"), summary), true);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu: 1 caused by PR, 1 fixed on main"), summary), false, "older PR wording");
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 app bug"), summary), undefined, "both runs write app bug");
});

test("release from status text: PR-only labels, then release-only labels, then the old shared ones", () => {
  assert.equal(releaseFromDescriptions(["(1 server compat) 50% passed", "(pull main changes) 50% passed"]), false);
  assert.equal(releaseFromDescriptions(["(1 test bug, 1 caused by PR) 50% passed"]), true);
  assert.equal(releaseFromDescriptions(["(1 caused by PR) 50% passed", "(1 out of date) 50% passed"]), false);
  // A PR writes "fixed on main" too now (cleared), so it says nothing; "broken on branch" is a release run's.
  assert.equal(releaseFromDescriptions(["(1 fixed on main) 50% passed", null]), undefined);
  assert.equal(releaseFromDescriptions(["(1 broken on branch) 50% passed"]), true);
  assert.equal(releaseFromDescriptions(["(1 app bug) 50% passed", undefined, ""]), undefined);
});

test("statusPublisher overlays its own just-written status when GitHub /statuses returns a stale pre-write read", async () => {
  const ctx = "e2e-test/playwright-full/enterprise";
  const other = "e2e-test/cypress-full/enterprise";
  const runUrl = "https://github.com/o/r/actions/runs/55";
  const staleLane: CommitStatus = {
    context: ctx,
    state: "failure",
    description: "1 failed",
    target_url: `${runUrl}?status_run_id=55&status_run_attempt=1`,
  };
  const greenOther: CommitStatus = {
    context: other,
    state: "success",
    description: "100% passed",
    target_url: `${runUrl}?status_run_id=55&status_run_attempt=1`,
  };
  const posted: { context: string; state: string; description: string }[] = [];
  const api: GhApi = async (method, path, body) => {
    if (method === "GET" && path.includes("/statuses")) {
      // Simulate GitHub eventual consistency still returning staleLane even after write().
      return [staleLane, greenOther];
    }
    if (method === "POST" && path.includes("/statuses/")) {
      posted.push(body as { context: string; state: string; description: string });
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const pub = statusPublisher({
    api,
    id: { repository: "o/r", commit_sha: "sha", gh_run_id: "55", gh_run_attempt: "1" },
    context: ctx,
    env: { GITHUB_RUN_ID: "55", GITHUB_RUN_ATTEMPT: "1" },
    log: () => {},
  });
  const ok = await pub.write({ state: "success", description: "(1 flaky) 99% passed", target_url: runUrl }, "triage");
  assert.equal(ok, true);
  await pub.refresh([ctx, other], summary, (lanes) => ({
    state: lanes.every((l) => l.status?.state === "success") ? "success" : "failure",
    description: lanes.every((l) => l.status?.state === "success") ? "All green" : "Still red",
  }));
  assert.deepEqual(
    posted.map((p) => [p.context, p.state, p.description]),
    [
      [ctx, "success", "(1 flaky) 99% passed"],
      [summary, "success", "All green"],
    ],
  );
});
