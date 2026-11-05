// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitStatus } from "./github.ts";
import { releaseFromDescriptions } from "./lane.ts";
import { inferRelease } from "./status.ts";
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
  assert.equal(releaseFromDescriptions(["(1 fixed on main) 50% passed", null]), true);
  assert.equal(releaseFromDescriptions(["(1 app bug) 50% passed", undefined, ""]), undefined);
});
