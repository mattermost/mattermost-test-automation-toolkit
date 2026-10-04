// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { identityKey } from "./e2e-triage.mjs";
import { bundle, prsTouching, rangeOf, record, selectRepairs, watch } from "./e2e-master-watch.mjs";

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
// With `recovered`, two more specs fail once and pass on retry: v/e.spec.ts flaked on trunk before, u/f.spec.ts never did.
function routes({ compared = [], untils = [], openPRFiles = ["specs/y/helpers.ts"], openedToday = 0, branch = "master", recovered = false, repairPRs = [] }) {
  const files = ["x/a.spec.ts", "y/b.spec.ts", "z/c.spec.ts"];
  const retried = recovered ? ["v/e.spec.ts", "u/f.spec.ts"] : [];
  const obs = (file, status, i) => ({ file, title: "t1", status, retry_count: 0, gh_pr_number: null, branch: "master", group_id: `old-${i}`, commit_sha: `c${i}`, created_at: `2026-10-02T0${9 - i}:00:00Z`, name: "pw-master", error_excerpt: "Error: expected visible" });
  const history = [
    ...files.flatMap((file) => [obs(file, "failed", 1), ...[2, 3, 4, 5, 6].map((i) => obs(file, "passed", i))]),
    ...(recovered ? [obs("v/e.spec.ts", "flaky", 3), ...[1, 2, 4, 5, 6].map((i) => obs("v/e.spec.ts", "passed", i)), ...[1, 2, 3, 4, 5, 6].map((i) => obs("u/f.spec.ts", "passed", i))] : []),
  ];
  const table = [
    ["/reports?", () => Response.json({ reports: [{ id: "g1", repository: "o/r", branch, commit: "abc", name: "pw-master", gh_run_id: "12", gh_run_attempt: "1", status: "completed", created_at: "2026-10-02T09:30:00Z", last_upload_at: "2026-10-02T09:50:00Z" }] })],
    ["/reports/g1/suites", () => Response.json({ suites: [...files, ...retried].map((file_path, i) => ({ id: `s${i}`, file_path })) })],
    ["/reports/g1/cases", () => Response.json([
      ...files.map((_, i) => ({ suite_id: `s${i}`, title: "t1", status: "failed", retry_count: 0, ordinal: i, error_message: "Error: expected visible" })),
      ...retried.flatMap((_, j) => [
        { suite_id: `s${files.length + j}`, title: "t1", status: "failed", retry_count: 0, ordinal: files.length + j, error_message: "Error: toast not visible" },
        { suite_id: `s${files.length + j}`, title: "t1", status: "passed", retry_count: 1, ordinal: files.length + j },
      ]),
    ])],
    ["/reports/history", (init) => { untils.push(JSON.parse(init.body).until); return Response.json({ observations: history }); }],
    ["/commits/abc", () => Response.json({ files: [] })],
    ["/graphql", (init) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("search(")) {
        assert.match(variables.q, /is:open label:e2e-autofix/);
        return Response.json({ data: { search: { nodes: repairPRs } } });
      }
      // Two pages: #41 is not among the newest 50, and #7 was last updated too long ago to count.
      const { after } = variables;
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
  ];
  return async (url, init = {}) => {
    for (const [m, r] of table) if (String(url).includes(m)) return r(init, url);
    throw new Error(`unexpected fetch ${url}`);
  };
}
const env = { REPOSITORY: "o/r", GH_RUN_ID: "12", BRANCH: "master", GITHUB_TOKEN: "t", TSIO_BASE_URL: "http://tsio", SUITES: JSON.stringify([{ name: "pw-master", test_root: "specs" }]) };
const now = new Date("2026-10-03T00:00:00Z");
const ledgerPath = () => join(mkdtempSync(join(tmpdir(), "watch-")), "ledger.json");

// One trunk run as the workflow does it: plan, send each request (into `hook`, answered with
// `status`), then record what was accepted.
async function run({ env: e, fetchImpl, now: at = now, hook = [], status = 200 }) {
  const LEDGER_PATH = e.LEDGER_PATH ?? ledgerPath();
  const PENDING_PATH = `${LEDGER_PATH}.pending`;
  const result = await watch({ env: { ...e, LEDGER_PATH, PENDING_PATH }, fetchImpl, now: at, log: () => {} });
  for (const r of result.requests) hook.push(r.payload);
  record({ env: { LEDGER_PATH, PENDING_PATH, RESULTS: JSON.stringify(result.requests.map((r) => ({ id: r.id, status }))) }, now: at, log: () => {} });
  return result;
}

test("broken specs with one cause go to one agent with what broke them, and are not requested again while it works", async () => {
  const hook = [];
  const compared = [];
  const untils = [];
  const fetchImpl = routes({ hook, compared, untils });
  const LEDGER_PATH = ledgerPath();
  const { decisions } = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/y/b.spec.ts"], "skipped: #41 changes it or its directory"],
    [["specs/x/a.spec.ts", "specs/z/c.spec.ts"], "to request"],
  ]);
  assert.equal(hook[0].kind, "e2e-autofix");
  assert.equal(hook.length, 1);
  assert.deepEqual(hook[0].specs, ["specs/x/a.spec.ts", "specs/z/c.spec.ts"]);
  assert.equal(hook[0].classification, "broken");
  assert.deepEqual(compared, ["c2...c1"], "from the last green commit to the first red one");
  assert.ok(untils.includes("2026-10-02T09:51:00.000Z"), "the suspect range reads history only up to this run, not later ones");
  assert.equal(hook[0].last_green_commit, "c2");
  assert.equal(hook[0].first_red_commit, "c1");
  assert.equal(hook[0].suspect_commits.length, 30);
  assert.equal(hook[0].suspect_commits[0].author, "dev0", "the oldest commits are kept");
  assert.equal(hook[0].suspect_commits_total, 35);
  assert.deepEqual(hook[0].labels, ["e2e-autofix"]);

  // The next master run, half an hour later: still broken, no PR yet, so its agent is still working.
  const later = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 1800e3), hook });
  assert.equal(hook.length, 1);
  assert.ok(later.decisions.filter((d) => d.specs[0] !== "specs/y/b.spec.ts").every((d) => d.action.startsWith("skipped: requested 2026-10-03 00:00 UTC")));

  // A day later with still no fix, it is asked again.
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 25 * 3600e3), hook });
  assert.equal(hook.length, 2);
});

test("a request the agent did not accept is not recorded, so the next run plans it again", async () => {
  const hook = [];
  const LEDGER_PATH = ledgerPath();
  const fetchImpl = routes({});
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, hook, status: 500 });
  const next = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 1800e3), hook });
  assert.deepEqual(next.decisions.map((d) => d.action), ["skipped: #41 changes it or its directory", "to request"]);
  assert.equal(hook.length, 2);
});

test("the daily cap counts requests as well as PRs", async () => {
  const capped = [];
  const { decisions } = await run({ env, fetchImpl: routes({ openPRFiles: [], openedToday: 5 }), hook: capped });
  assert.equal(capped.length, 0);
  assert.ok(decisions.every((d) => d.action === "skipped: over the repair cap"));

  // Five requests for other specs sent today, none of them a PR yet; one from yesterday doesn't count.
  const LEDGER_PATH = ledgerPath();
  const at = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
  writeFileSync(LEDGER_PATH, JSON.stringify({ requests: [1, 2, 3, 4, 5, 30].map((h) => ({ at: at(h), specs: [`specs/other${h}.spec.ts`], run: "r" })) }));
  const sent = [];
  const over = await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ openPRFiles: [] }), hook: sent });
  assert.equal(sent.length, 0);
  assert.ok(over.decisions.every((d) => d.action === "skipped: over the repair cap"));
  const room = await run({ env: { ...env, LEDGER_PATH, MAX_PER_DAY: "6" }, fetchImpl: routes({ openPRFiles: [] }), hook: sent });
  assert.equal(sent.length, 1);
  assert.deepEqual(room.decisions.map((d) => d.action), ["to request"]);

  // A release-branch run started from the same workflow is not trunk.
  const release = [];
  const other = await run({ env, fetchImpl: routes({ openPRFiles: [], branch: "release-12.0" }), hook: release });
  assert.equal(release.length, 0);
  assert.deepEqual(other.notes, ["not a trunk run"]);
});

test("a test that failed and passed on retry is repaired as flaky only if it also flaked on trunk before", async () => {
  const hook = [];
  const { decisions } = await run({ env: { ...env, MAX_PER_RUN: "3" }, fetchImpl: routes({ recovered: true }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.kind, d.action]), [
    [["specs/y/b.spec.ts"], "broken", "skipped: #41 changes it or its directory"],
    [["specs/x/a.spec.ts", "specs/z/c.spec.ts"], "broken", "to request"],
    [["specs/v/e.spec.ts"], "flaky", "to request"],
  ], "u/f.spec.ts recovered on retry but never flaked on trunk before: wait");
  const flaky = hook.find((h) => h.classification === "flaky");
  assert.equal(flaky.tests[0].trunk.flaky, 1);
  assert.equal(flaky.tests[0].trunk.recovered_on_retry_now, true);
  assert.match(flaky.tests[0].error, /toast not visible/, "the error is the failed attempt's");
});

test("a fix PR that conflicts with trunk goes back to the agent, once per PR head", async () => {
  const hook = [];
  const LEDGER_PATH = ledgerPath();
  const pr = (number, mergeable, head = `h${number}`) => ({ number, url: `https://github.com/o/r/pull/${number}`, headRefName: `fix/e2e-autofix-${number}`, headRefOid: head, mergeable });
  const repairPRs = [pr(50, "CONFLICTING"), pr(51, "MERGEABLE"), pr(52, "UNKNOWN")];
  const first = await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ repairPRs }), hook });
  assert.deepEqual(first.conflicts.map((c) => [c.pr, c.action]), [[50, "to send back"]], "only a known conflict is sent; UNKNOWN waits for the next run");
  const sent = hook.filter((h) => h.kind === "e2e-autofix-conflict");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].pr, sent[0].pr_branch, sent[0].pr_head], [50, "fix/e2e-autofix-50", "h50"]);
  assert.equal(hook.filter((h) => h.kind === "e2e-autofix").length, 1, "a conflict request does not use up the fix cap");

  // Next trunk run, same head still in conflict: its agent is on it.
  const again = await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ repairPRs }), now: new Date(now.getTime() + 1800e3), hook });
  assert.match(again.conflicts[0].action, /^skipped: sent .* for this head$/);
  assert.equal(hook.filter((h) => h.kind === "e2e-autofix-conflict").length, 1);

  // The agent pushed a merge, and a later trunk merge conflicts again: a new head is a new request.
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ repairPRs: [pr(50, "CONFLICTING", "h50b")] }), now: new Date(now.getTime() + 3600e3), hook });
  assert.equal(hook.filter((h) => h.kind === "e2e-autofix-conflict").length, 2);
});
