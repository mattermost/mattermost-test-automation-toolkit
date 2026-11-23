// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createArtifact,
  createResponse,
  newestArtifact,
  readResponse,
  responseArtifact,
  runArtifacts,
} from "./artifacts.ts";
import { ActionError } from "./errors.ts";
import { GitHubError } from "./github.ts";
import type { GitHub } from "./github.ts";
import { zip } from "./zip.fixture.ts";

const RUN = { repository: "mattermost/mobile", runId: "42" };
const listing = (page = 1) =>
  `/repos/mattermost/mobile/actions/runs/42/artifacts?name=e2e-test-stack-create-ios&per_page=100&page=${page}`;

/** A GitHub that answers json from pages and download from downloads, recording each path asked. */
const fakeGitHub = (pages: Record<string, unknown>, downloads: Record<string, Buffer | Error> = {}) => {
  const asked: string[] = [];
  const github: GitHub = {
    json: async (path) => {
      asked.push(path);
      if (!(path in pages)) throw new GitHubError(`GitHub GET ${path} failed: attempt 1: HTTP 404`);
      return pages[path];
    },
    download: async (path) => {
      asked.push(path);
      const d = downloads[path];
      if (d === undefined) throw new Error(`no download ${path}`);
      if (d instanceof Error) throw d;
      return d;
    },
  };
  return { github, asked };
};
const zipPath = (id: number) => `/repos/mattermost/mobile/actions/artifacts/${id}/zip`;
const archive = (response = '{"batch_id":"mobile-42-ios-1-abc"}') =>
  zip([{ name: "e2e-test-stack-create.json", data: response }]);

test("the create artifact is named for the batch", () => {
  assert.equal(createArtifact("ios"), "e2e-test-stack-create-ios");
});

test("the newest artifact of the name is chosen across attempts, by creation time then id", async () => {
  const { github } = fakeGitHub({
    [listing()]: {
      artifacts: [
        { id: 1, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T08:00:00Z" },
        { id: 3, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T09:00:00Z" },
        { id: 2, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T09:00:00Z" },
        { id: 9, name: "e2e-test-stack-create-ios-2", created_at: "2026-11-21T10:00:00Z" },
        { id: "x", name: "e2e-test-stack-create-ios", created_at: "2026-11-21T11:00:00Z" },
      ],
    },
  });
  assert.equal((await newestArtifact(github, RUN, "e2e-test-stack-create-ios"))?.id, 3);
});

test("every page of the listing is read", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    name: "e2e-test-stack-create-ios",
    created_at: "2026-11-21T08:00:00Z",
  }));
  const { github, asked } = fakeGitHub({
    [listing(1)]: { artifacts: full },
    [listing(2)]: { artifacts: [{ id: 500, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T09:00:00Z" }] },
  });
  assert.equal((await newestArtifact(github, RUN, "e2e-test-stack-create-ios"))?.id, 500);
  assert.equal(asked.length, 2);
});

test("a run with no artifact for the batch has no create response", async () => {
  const { github } = fakeGitHub({ [listing()]: { total_count: 0, artifacts: [] } });
  assert.equal(await createResponse(github, RUN, "ios"), undefined);
});

test("the create response is read from the newest artifact", async () => {
  const { github } = fakeGitHub(
    { [listing()]: { artifacts: [{ id: 7, name: "e2e-test-stack-create-ios", created_at: "t" }] } },
    { [zipPath(7)]: archive() },
  );
  const got = await createResponse(github, RUN, "ios");
  assert.equal(got?.artifact.id, 7);
  assert.equal(got?.response.toString(), '{"batch_id":"mobile-42-ios-1-abc"}');
});

test("an artifact that exists but expired, cannot be downloaded or read, or holds no response fails, naming it", async () => {
  const one = (extra: object = {}) => ({
    [listing()]: { artifacts: [{ id: 7, name: "e2e-test-stack-create-ios", created_at: "t", ...extra }] },
  });
  const cases: [Record<string, unknown>, Record<string, Buffer | Error>, RegExp][] = [
    [one({ expired: true }), {}, /artifact e2e-test-stack-create-ios has expired/],
    [
      one(),
      { [zipPath(7)]: new GitHubError("GitHub GET x failed: attempt 1: HTTP 410") },
      /e2e-test-stack-create-ios exists but could not be downloaded: GitHubError: .*HTTP 410/,
    ],
    [one(), { [zipPath(7)]: Buffer.from("not a zip") }, /could not be read: not a ZIP archive/],
    [one(), { [zipPath(7)]: zip([{ name: "other", data: "x" }]) }, /holds no e2e-test-stack-create\.json/],
  ];
  for (const [pages, downloads, message] of cases) {
    const { github } = fakeGitHub(pages, downloads);
    await assert.rejects(
      createResponse(github, RUN, "ios"),
      (e: unknown) => e instanceof ActionError && message.test(e.message),
    );
  }
});

test("a listing GitHub refuses fails with GitHub's error", async () => {
  const { github } = fakeGitHub({});
  await assert.rejects(createResponse(github, RUN, "ios"), /GitHub GET .* failed: attempt 1: HTTP 404/);
});

test("the run's artifacts of a name are listed across pages, keeping only that name and a usable id", async () => {
  const name = responseArtifact("ios", 2);
  const page = (n: number) => `/repos/mattermost/mobile/actions/runs/42/artifacts?name=${name}&per_page=100&page=${n}`;
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name, created_at: "", expired: false }));
  const { github } = fakeGitHub({
    [page(1)]: { artifacts: full },
    [page(2)]: {
      artifacts: [
        { id: 101, name, expired: true },
        { id: "x", name },
        { id: 102, name: "other" },
      ],
    },
  });
  const all = await runArtifacts(github, RUN, name);
  assert.equal(all.length, 101);
  assert.deepEqual(all[100], { id: 101, name: "e2e-test-stack-response-ios-2", createdAt: "", expired: true });
});

test("any artifact's response is read, naming it as the caller says when it cannot be", async () => {
  const artifact = { id: 9, name: "n", createdAt: "", expired: false };
  const { github } = fakeGitHub({}, { [zipPath(9)]: archive('{"batch_id":"x"}') });
  assert.equal((await readResponse(github, RUN, artifact, "run 42's artifact n")).toString(), '{"batch_id":"x"}');
  await assert.rejects(
    readResponse(github, RUN, { ...artifact, expired: true }, "run 42's artifact n"),
    /^ActionError: run 42's artifact n has expired/,
  );
});
