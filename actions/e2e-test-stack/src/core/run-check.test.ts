// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHub } from "./github.ts";
import { checkRun } from "./run-check.ts";

const ALLOWED = { workflows: [".github/workflows/e2e.yml"], branches: /^(?:main|release-.*)$/, events: ["push"] };
const RUN = {
  path: ".github/workflows/e2e.yml",
  head_branch: "release-11.1",
  event: "push",
  run_attempt: 2,
  status: "completed",
  head_repository: { full_name: "mattermost/mobile" },
};
const github = (run: unknown): GitHub => ({
  json: async (path) => {
    assert.equal(path, "/repos/mattermost/mobile/actions/runs/77");
    return run;
  },
  download: async () => Buffer.alloc(0),
});

test("an allowed run of this repository gives its latest attempt", async () => {
  const logged: string[] = [];
  assert.equal(await checkRun(github(RUN), "mattermost/mobile", "77", ALLOWED, (m) => logged.push(m)), 2);
  assert.match(
    logged[0],
    /run 77 is allowed: ".github\/workflows\/e2e.yml on release-11.1 \(push\) from mattermost\/mobile", attempt 2/,
  );
});

test("a run of another workflow, branch, event or a fork is refused, saying what it is", async () => {
  for (const over of [
    { path: ".github/workflows/other.yml" },
    { head_branch: "feature/release-1" },
    { event: "pull_request" },
    { head_repository: { full_name: "someone/mobile" } },
    { head_repository: null },
  ])
    await assert.rejects(
      checkRun(github({ ...RUN, ...over }), "mattermost/mobile", "77", ALLOWED, () => {}),
      /^ActionError: run 77 is not one this action may act on: it is "/,
    );
});

test("a run with no attempt number, or not an object, is refused", async () => {
  await assert.rejects(
    checkRun(github({ ...RUN, run_attempt: "2" }), "mattermost/mobile", "77", ALLOWED, () => {}),
    /run 77 has no attempt number/,
  );
  await assert.rejects(
    checkRun(github(null), "mattermost/mobile", "77", ALLOWED, () => {}),
    /no workflow on no branch/,
  );
});

test("text from the run is quoted, so a line break cannot start another line", async () => {
  await assert.rejects(
    checkRun(github({ ...RUN, head_branch: "x\n::error::y" }), "mattermost/mobile", "77", ALLOWED, () => {}),
    (e: unknown) => !(e as Error).message.includes("\n"),
  );
});

test("a run not yet completed is refused", async () => {
  for (const status of ["in_progress", "queued", undefined])
    await assert.rejects(
      checkRun(github({ ...RUN, status }), "mattermost/mobile", "77", ALLOWED, () => {}),
      /run 77 is ".*", not completed/,
    );
});
