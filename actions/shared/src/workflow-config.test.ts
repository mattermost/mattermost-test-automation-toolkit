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
  assert.doesNotMatch(ci, /pip install|setup-python/, "the runner image's yamllint is used, nothing is installed");
  const command = "yamllint .github/workflows/ actions/";
  assert.match(ci, /runs-on: ubuntu-24\.04[\s\S]*run: yamllint \.github\/workflows\/ actions\//, "the workflows and the actions are linted");
  assert.equal(
    (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["lint:yaml"],
    command,
    "npm run lint:yaml runs what CI runs",
  );
  assert.equal(read(".yamllint"), MONOREPO_YAMLLINT);
});

test("every action the CI workflow uses is pinned to a full commit SHA", () => {
  const uses = [...read(".github/workflows/ci.yml").matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 5, "checkout (three times) and setup-node (twice)");
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
  const setupNode = new Set(uses.filter((ref) => ref.startsWith("actions/setup-node@")));
  assert.equal(setupNode.size, 1, "both jobs use one setup-node pin");
});

test("the dist check also fails on untracked files under each action's dist, not only on tracked drift", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(ci.includes("git diff --exit-code actions/*/dist/"), "tracked drift is still checked");
  assert.ok(
    ci.includes('test -z "$(git status --porcelain --untracked-files=all actions/*/dist/)"'),
    "a new file in dist is drift too",
  );
});

test("every workspace is tested in exactly one CI job: e2e-test-stack in its own, on Node 26, the rest on Node 24", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = (name: string): string => {
    const at = ci.indexOf(`\n  ${name}:\n`);
    assert.notEqual(at, -1, `job ${name}`);
    const next = ci.slice(at + 1).search(/\n  [a-z][\w-]*:\n/);
    return next === -1 ? ci.slice(at) : ci.slice(at, at + 1 + next);
  };
  const others = job("test");
  const stack = job("e2e-test-stack");
  assert.match(others, /node-version: "24"/, "the other actions on Node 24");
  assert.match(stack, /node-version: "26"/, "e2e-test-stack on Node 26");
  // The Node 24 job takes its list from package.json, leaving out e2e-test-stack and nothing else.
  assert.match(others, /require\("\.\/package\.json"\)\.workspaces\.filter\(\(w\) => w !== "actions\/e2e-test-stack"\)/);
  for (const step of ["fmt:check", "lint", "tsc", "test", "build"])
    assert.match(others, new RegExp(`npm (run )?${step} "\\$\\{workspaces\\[@\\]\\}"`), `the other actions' ${step}`);
  assert.doesNotMatch(
    others,
    /--workspaces\b|\s-ws\b|(?:-w|--workspace)[= ]["']?(?:\.\/)?(?:actions\/)?e2e-test-stack\b/,
    "the Node 24 job never runs e2e-test-stack",
  );
  for (const step of ["fmt:check", "lint", "tsc", "build"])
    assert.ok(stack.includes(`npm run ${step} -w actions/e2e-test-stack`), `e2e-test-stack's job runs ${step}`);
  assert.ok(stack.includes("npm test -w actions/e2e-test-stack"), "e2e-test-stack's job runs its tests");
  assert.ok(stack.includes("--test actions/shared/src/*.test.ts"), "the shared tests run on Node 26 too");
  assert.ok(stack.includes("git diff --exit-code actions/e2e-test-stack/dist/"), "e2e-test-stack's dist is checked");
  // The Node 24 job filters workspaces by exact path, so a glob entry would slip e2e-test-stack back in.
  const { workspaces } = JSON.parse(read("package.json")) as { workspaces: string[] };
  for (const w of workspaces)
    assert.match(w, /^actions\/[a-z0-9-]+$/, `${w}: workspaces are listed as actions/<name>, with no glob, ./ or /`);
});

test("every action with a package.json is a workspace, so CI installs, tests and builds it", () => {
  const { workspaces } = JSON.parse(read("package.json")) as { workspaces: string[] };
  const actions = readdirSync(join(root, "actions"))
    .filter((name) => existsSync(join(root, "actions", name, "package.json")))
    .map((name) => `actions/${name}`);
  assert.deepEqual([...workspaces].sort(), actions.sort());
  for (const action of actions) assert.ok(!existsSync(join(root, action, "package-lock.json")), `${action}: one lockfile, at the root`);
});
