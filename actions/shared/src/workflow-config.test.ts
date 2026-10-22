// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// This file lives in actions/shared/src, three levels below the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

// mattermost/mattermost's .yamllint, which the YAML lint job follows.
const MONOREPO_YAMLLINT = `extends: default

rules:
  key-duplicates: enable
  empty-lines: disable
  line-length: disable
  trailing-spaces: disable
`;

test("YAML is linted with yamllint and the monorepo's rules, not a downloaded script piped into bash", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /actionlint|\|\s*bash/, "no script is fetched and run");
  assert.match(ci, /yamllint==1\.38\.0/, "yamllint is pinned to an exact version");
  assert.match(ci, /yamllint \.github\/workflows\/ actions\//, "the workflows and the actions are linted");
  assert.equal(read(".yamllint"), MONOREPO_YAMLLINT);
});

test("every action the CI workflow uses is pinned to a full commit SHA", () => {
  const uses = [...read(".github/workflows/ci.yml").matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 4, "checkout (twice), setup-node and setup-python");
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
});

test("the dist check also fails on untracked files under each action's dist, not only on tracked drift", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(ci.includes("git diff --exit-code actions/*/dist/"), "tracked drift is still checked");
  assert.ok(
    ci.includes('test -z "$(git status --porcelain --untracked-files=all actions/*/dist/)"'),
    "a new file in dist is drift too",
  );
});

test("every action with a package.json is a workspace, so CI installs, tests and builds it", () => {
  const { workspaces } = JSON.parse(read("package.json")) as { workspaces: string[] };
  const actions = readdirSync(join(root, "actions"))
    .filter((name) => existsSync(join(root, "actions", name, "package.json")))
    .map((name) => `actions/${name}`);
  assert.deepEqual([...workspaces].sort(), actions.sort());
  for (const action of actions) assert.ok(!existsSync(join(root, action, "package-lock.json")), `${action}: one lockfile, at the root`);
});
