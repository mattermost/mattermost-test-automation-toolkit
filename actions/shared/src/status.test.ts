// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommitStatus } from "./github.ts";
import { inferRelease } from "./status.ts";
import type { CompositeIdentity } from "./tsio.ts";

const id: CompositeIdentity = { repository: "o/r", commit_sha: "sha" };
const summary = "e2e-test/triage";
const aggregate = (description: string): CommitStatus[] => [{ context: summary, state: "failure", description } as CommitStatus];
const prEvent = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge", GITHUB_REF_NAME: "7/merge" };

test("release is read from the tested identity, not from the workflow's own event", () => {
  assert.equal(inferRelease({ ...id, branch: "release-11.7" }, prEvent), true, "a release branch's commit tested from a PR-triggered workflow");
  assert.equal(inferRelease({ ...id, branch: "main" }, prEvent), false);
  assert.equal(inferRelease({ ...id, branch: "release-11.7", gh_pr_number: 7 }), false, "a PR into a release branch");
  assert.equal(inferRelease({ ...id, branch: "release-11.7" }, { ...prEvent, RELEASE: "false" }), false, "an explicit RELEASE wins");
  assert.equal(inferRelease(id, prEvent), undefined, "nothing in the identity or the aggregate says");
});

test("the aggregate's pull guidance outweighs a label a release run also writes", () => {
  assert.equal(inferRelease(id, {}, aggregate("playwright-full/enterprise: 1 app bug, pull main changes"), summary), false);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 test bug, pull release-11.7 changes"), summary), false);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 app bug"), summary), true);
  assert.equal(inferRelease(id, {}, aggregate("ubuntu-11.11: 1 out of date"), summary), true);
});
