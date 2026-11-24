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

test("statusPublisher does not overlay lastWritten over a newer run, unowned override, or different same-run status", async () => {
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

  for (const [label, foreignRow] of [
    ["newer run", { context: ctx, state: "failure", description: "run 56 failed", target_url: "https://github.com/o/r/actions/runs/56?status_run_id=56&status_run_attempt=1" }],
    ["unowned override", { context: ctx, state: "failure", description: "manual override", target_url: "https://example.com/override" }],
    ["different same-run writer", { context: ctx, state: "failure", description: "other writer failed", target_url: `${runUrl}?status_run_id=55&status_run_attempt=1` }],
  ] as const) {
    let reads = 0;
    const posted: { context: string; state: string; description: string }[] = [];
    const api: GhApi = async (method, path, body) => {
      if (method === "GET" && path.includes("/statuses")) {
        reads++;
        // write() sees staleLane; refresh()'s summarize() sees foreignRow (or allowed() sees staleLane then summarize() sees foreignRow).
        return [reads <= 2 ? staleLane : foreignRow, greenOther];
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
    assert.equal(await pub.write({ state: "success", description: "(1 flaky) 99% passed", target_url: runUrl }, "triage"), true, label);
    assert.equal(await pub.refresh([ctx, other], summary, (lanes) => ({
      state: lanes.every((l) => l.status?.state === "success") ? "success" : "failure",
      description: lanes.every((l) => l.status?.state === "success") ? "All green" : "Still red",
    })), true, label);
    assert.deepEqual(
      posted.map((p) => [p.context, p.state, p.description]),
      [
        [ctx, "success", "(1 flaky) 99% passed"],
        [summary, "failure", "Still red"],
      ],
      label,
    );
  }
});

test("statusPublisher.refresh returns true only when aggregate status is written, and false when skipped", async () => {
  const ctx = "e2e-test/playwright-full/enterprise";
  const other = "e2e-test/cypress-full/enterprise";
  const runUrl = "https://github.com/o/r/actions/runs/55";
  const ownStatus: CommitStatus = { context: ctx, state: "success", description: "ok", target_url: `${runUrl}?status_run_id=55&status_run_attempt=1` };
  const newerStatus: CommitStatus = { context: ctx, state: "success", description: "ok", target_url: "https://github.com/o/r/actions/runs/99?status_run_id=99&status_run_attempt=1" };
  let rows: CommitStatus[] = [];
  const api: GhApi = async (method, path) => {
    if (method === "GET" && path.includes("/statuses")) return rows;
    if (method === "POST" && path.includes("/statuses/")) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  const pub = statusPublisher({
    api,
    id: { repository: "o/r", commit_sha: "sha", gh_run_id: "55", gh_run_attempt: "1" },
    context: ctx,
    env: { GITHUB_RUN_ID: "55", GITHUB_RUN_ATTEMPT: "1" },
    log: () => {},
  });
  const summarizer = () => ({ state: "success", description: "All green" });

  assert.equal(await pub.refresh([ctx], undefined, summarizer), false);
  assert.equal(await pub.refresh([other], summary, summarizer), false);
  rows = [newerStatus];
  assert.equal(await pub.refresh([ctx, other], summary, summarizer), false);
  rows = [ownStatus];
  assert.equal(await pub.refresh([ctx, other], summary, summarizer), true);
  assert.equal(await pub.summarize([ctx, other], summary, () => ({ state: "success", description: "ok" })), true);
  rows = [];
  assert.equal(await pub.summarize([ctx, other], summary, summarizer), false);
});

test("statusPublisher.summarize does not call owner() when lastWritten is null (read-only verification run)", async () => {
  const ctx = "e2e-test/playwright-full/enterprise";
  const other = "e2e-test/cypress-full/enterprise";
  const testedUrl = "https://github.com/o/r/actions/runs/55";
  const testedStatus: CommitStatus = {
    context: ctx,
    state: "success",
    description: "100% passed",
    target_url: `${testedUrl}?status_run_id=55&status_run_attempt=1`,
  };
  for (const runEnv of [{}, { GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "2" }] as const) {
    const posted: CommitStatus[] = [];
    const api: GhApi = async (method, path, body) => {
      if (method === "GET" && path.includes("/statuses")) return [testedStatus];
      if (method === "POST" && path.includes("/statuses/")) {
        posted.push(body as CommitStatus);
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const pub = statusPublisher({
      api,
      id: { repository: "o/r", commit_sha: "sha", gh_run_id: "55", gh_run_attempt: "1" },
      context: ctx,
      env: runEnv,
      log: () => {},
    });
    const ok = await pub.summarize([ctx, other], summary, () => ({ state: "success", description: "All green" }));
    assert.equal(ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].context, summary);
    const expectedRun = runEnv.GITHUB_RUN_ID ?? "55";
    const expectedAttempt = runEnv.GITHUB_RUN_ATTEMPT ?? "1";
    assert.match(String(posted[0].target_url), new RegExp(`status_run_id=${expectedRun}&status_run_attempt=${expectedAttempt}`));
  }
});

test("statusPublisher records superseded lastWritten in staleKeys across multiple writes (2nd and 3rd write)", async () => {
  const ctx = "e2e-test/playwright-full/enterprise";
  const other = "e2e-test/cypress-full/enterprise";
  const runUrl = "https://github.com/o/r/actions/runs/55";
  const row = (state: string, description: string): CommitStatus => ({
    context: ctx,
    state,
    description,
    target_url: `${runUrl}?status_run_id=55&status_run_attempt=1`,
  });
  const s0 = row("failure", "initial fail");
  const s1 = row("success", "100% passed");
  const s2 = row("failure", "1 failed");
  const greenOther: CommitStatus = { ...row("success", "ok"), context: other };

  let readStatus: CommitStatus = s0;
  const posted: { context: string; state: string; description: string }[] = [];
  const api: GhApi = async (method, path, body) => {
    if (method === "GET" && path.includes("/statuses")) return [readStatus, greenOther];
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
  const summarizer = (lanes: { status: { state: string } | null }[]) => ({
    state: lanes.every((l) => l.status?.state === "success") ? "success" : "failure",
    description: lanes.every((l) => l.status?.state === "success") ? "All green" : "Still red",
  });

  // 1st write: S1 (success) while GET sees S0 (pending).
  assert.equal(await pub.write({ state: "success", description: "100% passed", target_url: runUrl }, "triage"), true);
  // 2nd write: S2 (failure) while GET still returns stale S0; summarize GET then returns stale S1.
  assert.equal(await pub.write({ state: "failure", description: "1 failed", target_url: runUrl }, "triage"), true);
  readStatus = s1;
  assert.equal(await pub.refresh([ctx, other], summary, summarizer), true);

  // 3rd write: S3 (S1 again) while GET still returns stale S1; summarize GET then returns stale S2.
  assert.equal(await pub.write({ state: "success", description: "100% passed", target_url: runUrl }, "triage"), true);
  readStatus = s2;
  assert.equal(await pub.refresh([ctx, other], summary, summarizer), true);

  assert.deepEqual(
    posted.filter((p) => p.context === summary).map((p) => p.state),
    ["failure", "success"],
  );
});

test("statusPublisher.refresh applies stale overlay inside allowed('finish') after cross-run claim", async () => {
  const ctx = "e2e-test/playwright-full/enterprise";
  const other = "e2e-test/cypress-full/enterprise";
  const run54Url = "https://github.com/o/r/actions/runs/54";
  const run55Url = "https://github.com/o/r/actions/runs/55";
  const run54Row: CommitStatus = {
    context: ctx,
    state: "failure",
    description: "old run failed",
    target_url: `${run54Url}?status_run_id=54&status_run_attempt=1`,
  };
  const run56Row: CommitStatus = {
    context: ctx,
    state: "failure",
    description: "newer run failed",
    target_url: "https://github.com/o/r/actions/runs/56?status_run_id=56&status_run_attempt=1",
  };
  const greenOther: CommitStatus = {
    context: other,
    state: "success",
    description: "ok",
    target_url: `${run55Url}?status_run_id=55&status_run_attempt=1`,
  };

  let currentRow = run54Row;
  const posted: { context: string; state: string; description: string }[] = [];
  const api: GhApi = async (method, path, body) => {
    if (method === "GET" && path.includes("/statuses")) return [currentRow, greenOther];
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

  assert.equal(await pub.write({ state: "pending", description: "running", target_url: run55Url }, "claim"), true);
  // Stale read still returns run 54's row: refresh() -> allowed("finish") must overlay run 55 and post pending.
  assert.equal(
    await pub.refresh([ctx, other], summary, (lanes) => ({
      state: lanes.some((l) => l.status?.state === "pending") ? "pending" : "failure",
      description: "Waiting",
    })),
    true,
  );
  assert.deepEqual(
    posted.map((p) => [p.context, p.state]),
    [
      [ctx, "pending"],
      [summary, "pending"],
    ],
  );

  // Newer run (56) on GET must still be refused by refresh() -> allowed("finish").
  currentRow = run56Row;
  assert.equal(
    await pub.refresh([ctx, other], summary, () => ({ state: "pending", description: "Waiting" })),
    false,
  );
  assert.equal(posted.length, 2);
});
