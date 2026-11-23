// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionError } from "./errors.ts";
import { GitHubError } from "./github.ts";
import type { GitHub } from "./github.ts";
import { classify, isServer, MASTER_IMAGE, serverImage } from "./server-image.ts";

/** A GitHub that answers json from a map of paths. */
const fakeGitHub = (pages: Record<string, unknown>) => {
  const asked: string[] = [];
  const github: Pick<GitHub, "json"> = {
    json: async (path) => {
      asked.push(path);
      if (!(path in pages)) throw new GitHubError(`GitHub GET ${path} failed: attempt 1: HTTP 404`);
      return pages[path];
    },
  };
  return { github, asked };
};

const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  body: "",
  ...over,
});
const ESR_BODY = "Mattermost v10.11 is an Extended Support Release (ESR).";
const PAGE = (n: number) => `/repos/mattermost/mattermost/releases?per_page=100&page=${n}`;

test("only master, latest and esr are words to resolve; anything else is an image reference", () => {
  for (const word of ["master", "latest", "esr"]) assert.ok(isServer(word));
  for (const other of ["Master", "mattermost/mattermost-enterprise-edition:11.1.2", "", "toString"])
    assert.ok(!isServer(other));
});

test("latest is the highest stable release by semver, skipping drafts, prereleases and suffixed tags", () => {
  assert.equal(
    classify([
      release("v10.9.0"),
      release("v10.10.2"),
      release("v10.10.10"),
      release("v11.0.0", { draft: true }),
      release("v11.1.0-rc1"),
      release("v11.2.0", { prerelease: true }),
      release("v10.12.0-beta"),
      release("nightly"),
    ]).latest,
    "10.10.10",
  );
});

test("esr is the newest patch of the newest minor any of whose stable releases says it is an ESR line", () => {
  const { latest, esr } = classify([
    release("v11.2.1"),
    release("v10.11.0", { body: ESR_BODY }),
    release("v10.11.7"),
    release("v10.11.12"),
    release("v10.5.3", { body: "an EXTENDED SUPPORT RELEASE" }),
    // Only stable releases' notes are read.
    release("v11.1.0-rc1", { body: ESR_BODY }),
    release("v11.0.0", { body: ESR_BODY, draft: true }),
  ]);
  assert.equal(latest, "11.2.1");
  assert.equal(esr, "10.11.12");
  assert.equal(classify([release("v11.2.1")]).esr, undefined);
});

test("server-image reads every page of releases and names the image; master calls nothing", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => release(`v9.${i}.0`));
  const page2 = [release("v10.11.3", { body: ESR_BODY }), release("v11.0.1")];
  const { github, asked } = fakeGitHub({ [PAGE(1)]: page1, [PAGE(2)]: page2 });
  assert.deepEqual(await serverImage("latest", github), {
    image: "mattermost/mattermost-enterprise-edition:11.0.1",
    version: "11.0.1",
  });
  assert.equal(asked.length, 2);
  assert.deepEqual(await serverImage("esr", github), {
    image: "mattermost/mattermost-enterprise-edition:10.11.3",
    version: "10.11.3",
  });

  const none = fakeGitHub({});
  assert.deepEqual(await serverImage("master", none.github), { image: MASTER_IMAGE, version: "master" });
  assert.equal(none.asked.length, 0);
});

test("no matching release, or a list that is not one, fails as an ActionError", async () => {
  const noEsr = fakeGitHub({ [PAGE(1)]: [release("v11.0.1")] });
  await assert.rejects(serverImage("esr", noEsr.github), (e: unknown) => {
    assert.ok(e instanceof ActionError);
    assert.equal(e.message, "no ESR release among the 1 releases of mattermost/mattermost");
    return true;
  });
  const odd = fakeGitHub({ [PAGE(1)]: { message: "?" } });
  await assert.rejects(serverImage("latest", odd.github), /^ActionError: GitHub's releases list is not an array$/);
});
