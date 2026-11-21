// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHub } from "./github.ts";
import { checkRun } from "./run-check.ts";

const RUN = {
  path: ".github/workflows/e2e.yml",
  head_branch: "main",
  event: "workflow_dispatch",
  run_attempt: 2,
  status: "completed",
  head_repository: { full_name: "mattermost/mobile" },
};
const BY_HAND = { runId: "77", attempt: 1, actor: "alice" };
/** A GitHub that answers the run, and each attempt with who started it. */
const github = (run: unknown, startedBy: Record<number, string | undefined> = { 1: "alice", 2: "bob" }): GitHub => ({
  json: async (path) => {
    if (path === "/repos/mattermost/mobile/actions/runs/77") return run;
    const m = /^\/repos\/mattermost\/mobile\/actions\/runs\/77\/attempts\/(\d+)$/.exec(path);
    if (m) {
      const login = startedBy[Number(m[1])];
      return { triggering_actor: login ? { login, type: login.endsWith("[bot]") ? "Bot" : "User" } : null };
    }
    throw new Error(`unexpected ${path}`);
  },
  download: async () => Buffer.alloc(0),
});

test("a completed run started by hand, whose attempt the same person started, gives its latest attempt", async () => {
  const logged: string[] = [];
  assert.equal(await checkRun(github(RUN), "mattermost/mobile", BY_HAND, (m) => logged.push(m)), 2);
  assert.match(
    logged[0],
    /run 77 is ".github\/workflows\/e2e.yml on main \(workflow_dispatch\) from mattermost\/mobile"; attempt 1 was started by alice/,
  );
});

test("an attempt someone else started is refused: only they may act on its batches by hand", async () => {
  await assert.rejects(
    checkRun(github(RUN), "mattermost/mobile", { ...BY_HAND, attempt: 2 }, () => {}),
    /attempt 2 of run 77 was started by "bob", not by "alice": only they may act on its batches by hand/,
  );
  await assert.rejects(
    checkRun(github(RUN, {}), "mattermost/mobile", BY_HAND, () => {}),
    /was started by "nobody named", not a person/,
  );
});

test("an attempt an app or a bot started is no one's to act on by hand, even by that same bot", async () => {
  await assert.rejects(
    checkRun(
      github(RUN, { 1: "github-actions[bot]" }),
      "mattermost/mobile",
      { ...BY_HAND, actor: "github-actions[bot]" },
      () => {},
    ),
    /attempt 1 of run 77 was started by "github-actions\[bot\]", not a person: no one may act on its batches by hand/,
  );
});

test("a run not started by hand is refused: its own destroy or the reaper releases its batches", async () => {
  for (const event of ["push", "schedule", "pull_request", "workflow_call"])
    await assert.rejects(
      checkRun(github({ ...RUN, event }), "mattermost/mobile", BY_HAND, () => {}),
      /run 77 was not started by hand: .*Its own destroy releases its batches, or the reaper at their ttl/,
    );
});

test("a run from a fork, or with no head repository, is refused, saying what it is", async () => {
  for (const over of [{ head_repository: { full_name: "someone/mobile" } }, { head_repository: null }])
    await assert.rejects(
      checkRun(github({ ...RUN, ...over }), "mattermost/mobile", BY_HAND, () => {}),
      /^ActionError: run 77 is not one of this repository's own: it is "/,
    );
});

test("a run not yet completed, or with fewer attempts than named, is refused", async () => {
  for (const status of ["in_progress", "queued", undefined])
    await assert.rejects(
      checkRun(github({ ...RUN, status }), "mattermost/mobile", BY_HAND, () => {}),
      /run 77 is ".*", not completed/,
    );
  await assert.rejects(
    checkRun(github(RUN), "mattermost/mobile", { ...BY_HAND, attempt: 3 }, () => {}),
    /run 77 has 2 attempt\(s\), not 3/,
  );
  await assert.rejects(
    checkRun(github({ ...RUN, run_attempt: "2" }), "mattermost/mobile", BY_HAND, () => {}),
    /run 77 has no attempt number/,
  );
});

test("text from the run is quoted, so a line break cannot start another line", async () => {
  await assert.rejects(
    checkRun(
      github({ ...RUN, head_repository: { full_name: "x\n::error::y" } }),
      "mattermost/mobile",
      BY_HAND,
      () => {},
    ),
    (e: unknown) => !(e as Error).message.includes("\n"),
  );
  await assert.rejects(
    checkRun(github(RUN, { 1: "eve\n::error::x" }), "mattermost/mobile", BY_HAND, () => {}),
    (e: unknown) => !(e as Error).message.includes("\n"),
  );
});
