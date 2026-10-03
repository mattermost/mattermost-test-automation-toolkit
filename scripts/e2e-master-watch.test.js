// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { identityKey } from "./e2e-triage.mjs";
import { bundle, prsTouching, rangeOf, selectRepairs, watch } from "./e2e-master-watch.mjs";

const finding = (over) => ({ file: "a.spec.ts", repo_path: "specs/a.spec.ts", title: "t", error: "Error: expected visible", class: "BROKEN_ON_TRUNK", trunk: { runs: 8, fails: 2, flaky: 0, passes: 6 }, ...over });

test("only failures that repeat on trunk are repaired, grouped by spec", () => {
  const findings = [
    finding({ title: "t1" }),
    finding({ title: "t2", class: "FLAKY_ON_TRUNK" }),
    finding({ title: "t3", class: "REGRESSION" }), // first failure: wait for the next run
    finding({ title: "t4", class: "INSUFFICIENT_DATA" }),
    finding({ title: "t5", file: "b.spec.ts", repo_path: "specs/b.spec.ts", class: "FLAKY_ON_TRUNK", trunk: { runs: 8, fails: 1, flaky: 0, passes: 7 } }),
    finding({ title: "t6", identity_unresolved: true }),
  ];
  const groups = selectRepairs({ findings }, "suite-a");
  assert.deepEqual(groups.map((g) => [g.spec, g.kind]), [["specs/a.spec.ts", "broken"], ["specs/b.spec.ts", "flaky"]], "a broken test makes its spec broken; one earlier failure plus this one is flaky enough");
  assert.deepEqual(groups[0].tests.map((t) => t.title), ["t1", "t2"]);
  // History excludes this run, so minFlaky 2 asks for two earlier failures.
  assert.deepEqual(selectRepairs({ findings }, "suite-a", { minFlaky: 2 }).map((g) => g.spec), ["specs/a.spec.ts"]);
});

test("an open PR blocks a spec when it changes the spec or a file beside it", () => {
  const touched = new Map([["specs/x/helpers.ts", [7]], ["specs/x/deep/other.spec.ts", [8]], ["specs/y/a.spec.ts", [9]], ["specs/x/a.spec.ts", [3]]]);
  assert.deepEqual(prsTouching(touched, "specs/x/a.spec.ts"), [3, 7]);
  assert.deepEqual(prsTouching(touched, "specs/z/a.spec.ts"), []);
});

const row = (status, i, over = {}) => ({ status, commit_sha: `c${i}`, created_at: `2026-10-02T${String(20 - i).padStart(2, "0")}:00:00Z`, branch: "master", gh_pr_number: null, ...over });

test("the suspect range starts where every failing test last passed and ends at the first failure after it", () => {
  const t1 = { file: "a.spec.ts", title: "t1" };
  const t2 = { file: "a.spec.ts", title: "t2" };
  const history = new Map([
    // Newest first. t1 broke at c2; t2 already broke at c4, so c4..c2 is in the range too.
    [identityKey(t1), [row("failed", 1), row("failed", 2), row("passed", 3), row("failed", 4, { branch: "feature" }), row("passed", 5)]],
    [identityKey(t2), [row("failed", 1), row("failed", 2), row("failed", 3), row("failed", 4), row("passed", 5), row("passed", 6)]],
  ]);
  const r = rangeOf(history, [t1, t2], "master");
  assert.equal(r.green.commit_sha, "c5");
  assert.equal(r.red.commit_sha, "c4");
  // A PR's run is not trunk.
  assert.equal(rangeOf(new Map([[identityKey(t1), [row("failed", 1), row("passed", 2, { gh_pr_number: 5 })]]]), [t1], "master"), null, "no trunk pass in the window: no range");
});

test("broken specs that last passed on the same commit go to one agent; flaky ones alone, after them", () => {
  const g = (spec, kind, green, red) => ({ spec, kind, suites: new Set(["s"]), tests: [{ spec, title: "t" }], range: green ? { green: { commit_sha: green }, red: { commit_sha: red, created_at: `2026-10-02T${red}:00:00Z` } } : null });
  const requests = bundle([g("f.spec.ts", "flaky", "c1", "10"), g("a.spec.ts", "broken", "c1", "12"), g("b.spec.ts", "broken", "c1", "11"), g("c.spec.ts", "broken", "c9", "13"), g("d.spec.ts", "broken", null)]);
  assert.deepEqual(requests.map((r) => [r.specs, r.kind]), [[["a.spec.ts", "b.spec.ts"], "broken"], [["c.spec.ts"], "broken"], [["d.spec.ts"], "broken"], [["f.spec.ts"], "flaky"]]);
  assert.equal(requests[0].range.red.commit_sha, "11", "the earliest first failure of the bundle");
});

// A trunk run with three broken specs, all broken since c1; an open PR changes a helper beside y/b.spec.ts.
function routes({ hook, compared = [], openPRFiles = ["specs/y/helpers.ts"], openedToday = 0, branch = "master" }) {
  const files = ["x/a.spec.ts", "y/b.spec.ts", "z/c.spec.ts"];
  const obs = (file, status, i) => ({ file, title: "t1", status, retry_count: 0, gh_pr_number: null, branch: "master", group_id: `old-${i}`, commit_sha: `c${i}`, created_at: `2026-10-02T0${9 - i}:00:00Z`, name: "pw-master", error_excerpt: "Error: expected visible" });
  const history = files.flatMap((file) => [obs(file, "failed", 1), ...[2, 3, 4, 5, 6].map((i) => obs(file, "passed", i))]);
  const table = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", branch, commit: "abc", name: "pw-master", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }] })],
    ["/reports/g1/suites", () => Response.json({ suites: files.map((file_path, i) => ({ id: `s${i}`, file_path })) })],
    ["/reports/g1/cases", () => Response.json(files.map((_, i) => ({ suite_id: `s${i}`, title: "t1", status: "failed", retry_count: 0, ordinal: i, error_message: "Error: expected visible" })))],
    ["/reports/history", () => Response.json({ observations: history })],
    ["/commits/abc", () => Response.json({ files: [] })],
    ["/graphql", (init) => {
      // Two pages: #41 is not among the newest 50, and #7 was last updated too long ago to count.
      const { after } = JSON.parse(init.body).variables;
      const pr = (number, updatedAt, paths = []) => ({ number, updatedAt, files: { pageInfo: { hasNextPage: false }, nodes: paths.map((path) => ({ path })) } });
      if (!after) return Response.json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "p2" }, nodes: Array.from({ length: 50 }, (_, i) => pr(100 + i, "2026-10-02T12:00:00Z")) } } } });
      return Response.json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "p3" }, nodes: [pr(41, "2026-10-02T00:00:00Z", openPRFiles), pr(7, "2026-09-01T00:00:00Z", ["specs/x/a.spec.ts"])] } } } });
    }],
    ["/search/issues", () => Response.json({ total_count: openedToday })],
    ["/compare/", (init, url) => {
      compared.push(String(url).split("/compare/")[1]);
      // Oldest first, as GitHub returns them; the cause is usually among the first.
      const commits = Array.from({ length: 35 }, (_, i) => ({ sha: `${i}`.padStart(10, "d"), commit: { message: `change ${i}\n\nbody`, author: { name: "dev" } }, author: { login: `dev${i}` } }));
      return Response.json({ total_commits: 35, commits });
    }],
    ["hooks.cursor", (init) => { hook.push(JSON.parse(init.body)); return Response.json({ ok: true }); }],
  ];
  return async (url, init = {}) => {
    for (const [m, r] of table) if (String(url).includes(m)) return r(init, url);
    throw new Error(`unexpected fetch ${url}`);
  };
}
const env = { REPOSITORY: "o/r", GH_RUN_ID: "12", BRANCH: "master", GITHUB_TOKEN: "t", TSIO_BASE_URL: "http://tsio", SUITES: JSON.stringify([{ name: "pw-master", test_root: "specs" }]), CURSOR_WEBHOOK_URL: "https://hooks.cursor.test/x", CURSOR_WEBHOOK_KEY: "k" };
const now = new Date("2026-10-03T00:00:00Z");
const ledgerPath = () => join(mkdtempSync(join(tmpdir(), "watch-")), "ledger.json");

test("broken specs with one cause go to one agent with what broke them, and are not requested again while it works", async () => {
  const hook = [];
  const compared = [];
  const fetchImpl = routes({ hook, compared });
  const LEDGER_PATH = ledgerPath();
  const { decisions } = await watch({ env: { ...env, LEDGER_PATH }, fetchImpl, now, log: () => {} });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/y/b.spec.ts"], "skipped: #41 changes it or its directory"],
    [["specs/x/a.spec.ts", "specs/z/c.spec.ts"], "repair requested"],
  ]);
  assert.equal(hook.length, 1);
  assert.deepEqual(hook[0].specs, ["specs/x/a.spec.ts", "specs/z/c.spec.ts"]);
  assert.equal(hook[0].classification, "broken");
  assert.deepEqual(compared, ["c2...c1"], "from the last green commit to the first red one");
  assert.equal(hook[0].last_green_commit, "c2");
  assert.equal(hook[0].first_red_commit, "c1");
  assert.equal(hook[0].suspect_commits.length, 30);
  assert.equal(hook[0].suspect_commits[0].author, "dev0", "the oldest commits are kept");
  assert.equal(hook[0].suspect_commits_total, 35);
  assert.deepEqual(hook[0].labels, ["e2e-master-repair"]);

  // The next master run, half an hour later: still broken, no PR yet, so its agent is still working.
  const later = await watch({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 1800e3), log: () => {} });
  assert.equal(hook.length, 1);
  assert.ok(later.decisions.filter((d) => d.specs[0] !== "specs/y/b.spec.ts").every((d) => d.action.startsWith("skipped: requested 2026-10-03 00:00 UTC")));

  // A day later with still no fix, it is asked again.
  await watch({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 25 * 3600e3), log: () => {} });
  assert.equal(hook.length, 2);
});

test("the daily cap counts requests as well as PRs, and without a webhook it only reports", async () => {
  const capped = [];
  const { decisions } = await watch({ env, fetchImpl: routes({ hook: capped, openPRFiles: [], openedToday: 5 }), now, log: () => {} });
  assert.equal(capped.length, 0);
  assert.ok(decisions.every((d) => d.action === "skipped: over the repair cap"));

  // Five requests for other specs sent today, none of them a PR yet; one from yesterday doesn't count.
  const LEDGER_PATH = ledgerPath();
  const at = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
  writeFileSync(LEDGER_PATH, JSON.stringify({ requests: [1, 2, 3, 4, 5, 30].map((h) => ({ at: at(h), specs: [`specs/other${h}.spec.ts`], run: "r" })) }));
  const sent = [];
  const over = await watch({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ hook: sent, openPRFiles: [] }), now, log: () => {} });
  assert.equal(sent.length, 0);
  assert.ok(over.decisions.every((d) => d.action === "skipped: over the repair cap"));
  const room = await watch({ env: { ...env, LEDGER_PATH, MAX_PER_DAY: "6" }, fetchImpl: routes({ hook: sent, openPRFiles: [] }), now, log: () => {} });
  assert.equal(sent.length, 1);
  assert.deepEqual(room.decisions.map((d) => d.action), ["repair requested"]);

  // A release-branch run started from the same workflow is not trunk.
  const release = [];
  const other = await watch({ env, fetchImpl: routes({ hook: release, openPRFiles: [], branch: "release-12.0" }), now, log: () => {} });
  assert.equal(release.length, 0);
  assert.deepEqual(other.notes, ["not a trunk run"]);

  const dry = [];
  const report = await watch({ env: { ...env, CURSOR_WEBHOOK_URL: "" }, fetchImpl: routes({ hook: dry, openPRFiles: [] }), now, log: () => {} });
  assert.equal(dry.length, 0);
  assert.deepEqual(report.decisions.map((d) => [d.specs.length, d.action]), [[3, "would request a repair (no webhook configured)"]]);
});
