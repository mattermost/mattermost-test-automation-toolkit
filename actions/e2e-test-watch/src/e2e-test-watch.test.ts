// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { identityKey } from "../../shared/src/tsio.ts";
import type { FetchImpl } from "../../shared/src/github.ts";
import type { RepairFinding } from "./select.ts";
import { selectCrossLane, selectRepairs, unselected } from "./select.ts";
import { breakWindow, bundle, rangeOf, specRange, windowsOverlap } from "./range.ts";
import type { RangedGroup, WatchId } from "./range.ts";
import { prsTouching, specsInOpenPRs } from "./prs.ts";
import type { RepairPR } from "./prs.ts";
import { readLedger } from "./ledger.ts";
import { record, runGroups, unwatchedFailures, watch } from "./watch.ts";
import type { FixPayload } from "./watch.ts";
import type { GroupTest, RangeEnd, RunRow } from "./model.ts";

const trunkOf = (fails: number, flaky: number, passes: number) => ({ runs: 8, fails, flaky, passes, latest: "passed" });

const finding = (over: Partial<RepairFinding>): RepairFinding => ({
  file: "a.spec.ts",
  repo_path: "specs/a.spec.ts",
  title: "t",
  error: "Error: expected visible",
  class: "BROKEN_ON_TRUNK",
  trunk: trunkOf(2, 0, 6),
  ...over,
});

test("only failures that repeat on trunk are repaired, grouped by spec", () => {
  const findings: RepairFinding[] = [
    finding({ title: "t1" }),
    finding({ title: "t2", class: "FLAKY_ON_TRUNK" }),
    finding({ title: "t3", class: "REGRESSION" }), // first failure: wait for the next run
    finding({ title: "t4", class: "INSUFFICIENT_DATA" }),
    finding({ title: "t5", file: "b.spec.ts", repo_path: "specs/b.spec.ts", class: "FLAKY_ON_TRUNK", trunk: trunkOf(1, 0, 7) }),
    finding({ title: "t6", identity_unresolved: true }),
    // History excludes this run: flaky with no earlier failure is this run's alone.
    finding({ title: "t7", file: "c.spec.ts", repo_path: "specs/c.spec.ts", class: "FLAKY_ON_TRUNK", trunk: trunkOf(0, 0, 8) }),
  ];
  const groups = selectRepairs({ findings }, "suite-a");
  assert.deepEqual(groups.map((g) => [g.spec, g.kind]), [["specs/a.spec.ts", "broken"], ["specs/b.spec.ts", "flaky"]], "a broken test makes its spec broken; one earlier failure plus this one is flaky enough");
  assert.deepEqual(groups[0].tests.map((t) => t.title), ["t1", "t2"]);
});

test("an open PR blocks a spec when it changes the spec or a file beside it", () => {
  const touched = new Map([["specs/x/helpers.ts", [7]], ["specs/x/deep/other.spec.ts", [8]], ["specs/y/a.spec.ts", [9]], ["specs/x/a.spec.ts", [3]]]);
  assert.deepEqual(prsTouching(touched, "specs/x/a.spec.ts"), [3, 7]);
  assert.deepEqual(prsTouching(touched, "specs/z/a.spec.ts"), []);
});

const row = (status: string, i: number, over: Partial<RunRow> = {}): RunRow => ({
  status,
  commit_sha: `c${i}`,
  created_at: `2026-10-02T${String(20 - i).padStart(2, "0")}:00:00Z`,
  branch: "master",
  gh_pr_number: null,
  ...over,
});

test("the suspect range starts where every failing test last passed and ends at the first failure after it", () => {
  const t1 = { file: "a.spec.ts", title: "t1" };
  const t2 = { file: "a.spec.ts", title: "t2" };
  const history = new Map<string, RunRow[]>([
    // Newest first. t1 broke at c2; t2 already broke at c4, so c4..c2 is in the range too.
    [identityKey(t1), [row("failed", 1), row("failed", 2), row("passed", 3), row("failed", 4, { branch: "feature" }), row("passed", 5)]],
    [identityKey(t2), [row("failed", 1), row("failed", 2), row("failed", 3), row("failed", 4), row("passed", 5), row("passed", 6)]],
  ]);
  const r = rangeOf(history, [t1, t2], "master");
  assert.equal(r?.green.commit_sha, "c5");
  assert.equal(r?.red?.commit_sha, "c2", "the later of the two first failures");
  // A PR's run is not trunk.
  assert.equal(rangeOf(new Map([[identityKey(t1), [row("failed", 1), row("passed", 2, { gh_pr_number: 5 })]]]), [t1], "master"), null, "no trunk pass in the window: no range");
});

/** A bundle test's suspect range: its oldest green and first red run, as TSIO rows carry them. */
type RangeFixture = { green: RangeEnd; red: RangeEnd | null } | null;

/** A test as a bundle's group carries it. */
const groupTest = (spec: string): GroupTest => ({
  spec,
  suite: "s",
  title: "t",
  full_title: null,
  error: "",
  trunk: trunkOf(0, 0, 0),
  finding: { file: spec, title: "t" },
});

test("broken specs whose break windows overlap go to one agent; flaky ones alone, after them", () => {
  const t = (hhmm: string): number => Date.parse(`2026-10-02T${hhmm}:00Z`);
  const row = (sha: string, hhmm: string) => ({ commit_sha: sha, created_at: `2026-10-02T${hhmm}:00Z` });
  // window: when it could have broken; range: its suspect commits (last pass .. first failure).
  const g = (spec: string, kind: "broken" | "flaky", from: number | null, to: number, range: RangeFixture = null): RangedGroup => ({
    spec,
    kind,
    suites: new Set(["s"]),
    tests: [groupTest(spec)],
    range,
    window: from == null ? null : { from, to },
  });
  const requests = bundle([
    g("f.spec.ts", "flaky", t("01:00"), t("10:00")),
    // One merge broke a and b; an incomplete run left them different last passes.
    g("a.spec.ts", "broken", t("03:00"), t("10:00"), { green: row("c3", "03:00"), red: row("r1", "10:00") }),
    g("b.spec.ts", "broken", t("02:00"), t("10:00"), { green: row("c2", "02:00"), red: row("r1", "10:00") }),
    // x has been red since 08:00; y was last seen at 02:00 and failed first in this run (12:00), so it may share x's cause.
    g("x.spec.ts", "broken", t("01:00"), t("08:00"), { green: row("c1", "01:00"), red: row("r0", "08:00") }),
    g("y.spec.ts", "broken", t("02:00"), t("12:00"), { green: row("c2", "02:00"), red: null }),
    // A break with no window (no history could place it) goes alone.
    g("d.spec.ts", "broken", null, 0),
  ]);
  assert.deepEqual(requests.map((r) => [r.specs.slice().sort(), r.kind]), [
    [["a.spec.ts", "b.spec.ts", "x.spec.ts", "y.spec.ts"], "broken"],
    [["d.spec.ts"], "broken"],
    [["f.spec.ts"], "flaky"],
  ]);
  assert.equal(requests[0].range?.green.commit_sha, "c1", "from the oldest last pass");
  assert.equal(requests[0].range?.red, null, "to this run, the latest first failure in the bundle");
  assert.deepEqual(requests[0].window, { from: t("01:00"), to: t("12:00") });

  // c ran clean in the run where a first failed (its other lane started a minute later): a separate break.
  const c = g("c.spec.ts", "broken", t("10:01"), t("11:00"));
  assert.deepEqual(bundle([g("a.spec.ts", "broken", t("03:00"), t("10:00")), c]).map((r) => r.specs), [["a.spec.ts"], ["c.spec.ts"]]);
  // A chain: w overlaps a, and a overlaps v, so all three go together.
  assert.deepEqual(bundle([g("v.spec.ts", "broken", t("01:00"), t("04:00")), g("a.spec.ts", "broken", t("03:00"), t("10:00")), g("w.spec.ts", "broken", t("09:00"), t("12:00"))]).map((r) => r.specs.length), [3]);
  assert.equal(windowsOverlap({ from: 0, to: 600e3 }, { from: 540e3, to: 900e3 }), false, "ends within five minutes are the same run");
});

test("a break window starts after the last run that didn't fail the spec: passed, flaky, or skipped", () => {
  const t1 = { file: "a.spec.ts", title: "t1" };
  const t2 = { file: "a.spec.ts", title: "t2" };
  const r = (status: string, hh: string, over: Partial<RunRow> = {}): RunRow => ({ status, created_at: `2026-10-02T${hh}:00:00Z`, branch: "master", gh_pr_number: null, ...over });
  const at = (hh: string): number => Date.parse(`2026-10-02T${hh}:00:00Z`);
  const now = at("12");
  // Newest first. t1 was skipped behind a flag until it failed at 10; t2 last passed on trunk at 07 and
  // failed from 08 (a PR's pass at 10 is not a trunk run).
  const history = new Map<string, RunRow[]>([
    [identityKey(t1), [r("failed", "11"), r("failed", "10"), r("skipped", "09"), r("skipped", "08")]],
    [identityKey(t2), [r("failed", "11"), r("passed", "10", { gh_pr_number: 5 }), r("failed", "08"), r("passed", "07")]],
  ]);
  assert.deepEqual(breakWindow(history, [t1], "master", now), { from: at("09"), to: at("10") }, "a skipped run counts as not failing");
  assert.deepEqual(breakWindow(history, [t2], "master", now), { from: at("07"), to: at("08") }, "the PR's pass doesn't count");
  assert.deepEqual(breakWindow(history, [t1, t2], "master", now), { from: at("07"), to: at("10") }, "spanning all its tests");
  // Failing first in this run (its row not in the history yet): the window ends now.
  assert.deepEqual(breakWindow(new Map([[identityKey(t1), [r("passed", "09")]]]), [t1], "master", now), { from: at("09"), to: now });
  // A test with no trunk history could have broken any time.
  assert.deepEqual(breakWindow(new Map(), [t1], "master", now), { from: -Infinity, to: now });
});

// A trunk run with three broken specs, all broken since c1; an open PR changes y/b.spec.ts itself.
// With `recovered`, two more specs fail once and pass on retry: v/e.spec.ts flaked on trunk before, u/f.spec.ts never did.
// With `lanes`, the run has one report group per lane; `failIn` says which lanes each spec fails in, and
// `firstFailure` makes every spec pass in all earlier runs, so a failure now is its first.
interface RouteOptions {
  compared?: string[];
  untils?: string[];
  openPRFiles?: string[];
  branch?: string;
  recovered?: boolean;
  repairPRs?: unknown[];
  lanes?: string[];
  reported?: string[];
  failIn?: Record<string, string[]>;
  firstFailure?: boolean;
  openPRLabels?: string[];
  releasePRFiles?: string[];
  historyFailFor?: string | null;
  bothFlaked?: boolean;
  historyBodies?: HistoryBody[];
  reportName?: string | null;
  forkPRFiles?: string[];
  forkPRLabels?: string[];
  // The attempt each lane's report is filed under (default "1").
  attempts?: Record<string, string>;
  // When each lane's last report arrived (default 2026-10-02T09:50:00Z).
  uploadedAt?: Record<string, string>;
  // Other report groups of the same commit: suites the caller doesn't watch, or another run's.
  others?: { name: string; failed: number; runId?: string; attempt?: string }[];
}

interface HistoryBody {
  files: string[];
  until: string;
  report?: string;
}

function routes({
  compared = [],
  untils = [],
  openPRFiles = ["specs/y/b.spec.ts"],
  branch = "master",
  recovered = false,
  repairPRs = [],
  lanes = ["pw-master"],
  reported = lanes,
  failIn = {},
  firstFailure = false,
  openPRLabels = ["e2e-autofix"],
  releasePRFiles = [],
  historyFailFor = null,
  bothFlaked = false,
  historyBodies = [],
  reportName = null,
  forkPRFiles = [],
  forkPRLabels = [],
  attempts = {},
  uploadedAt = {},
  others = [],
}: RouteOptions): FetchImpl {
  const files = ["x/a.spec.ts", "y/b.spec.ts", "z/c.spec.ts"];
  const retried = recovered ? ["v/e.spec.ts", "u/f.spec.ts"] : [];
  const fails = (file: string, lane: string): boolean => (failIn[file] ?? lanes).includes(lane);
  const obs = (file: string, status: string, i: number, name = "pw-master") => ({
    file,
    title: "t1",
    status,
    retry_count: 0,
    gh_pr_number: null,
    branch: "master",
    group_id: `old-${name}-${i}`,
    commit_sha: `c${i}`,
    created_at: `2026-10-02T0${9 - i}:00:00Z`,
    name,
    error_excerpt: "Error: expected visible",
  });
  const history = [
    ...lanes.flatMap((lane) => files.flatMap((file) => [obs(file, firstFailure ? "passed" : "failed", 1, lane), ...[2, 3, 4, 5, 6].map((i) => obs(file, "passed", i, lane))])),
    ...(recovered
      ? [
          obs("v/e.spec.ts", "flaky", 3),
          ...[1, 2, 4, 5, 6].map((i) => obs("v/e.spec.ts", "passed", i)),
          ...(bothFlaked ? [obs("u/f.spec.ts", "flaky", 3), ...[1, 2, 4, 5, 6].map((i) => obs("u/f.spec.ts", "passed", i))] : [1, 2, 3, 4, 5, 6].map((i) => obs("u/f.spec.ts", "passed", i))),
        ]
      : []),
  ];
  const groups = lanes.map((name, n) => ({ id: `g${n + 1}`, repository: "o/r", branch, commit: "abc", name, gh_run_id: "12", gh_run_attempt: attempts[name] ?? "1", status: "completed", created_at: "2026-10-02T09:30:00Z", last_upload_at: uploadedAt[name] ?? "2026-10-02T09:50:00Z" }));
  const otherGroups = others.map((o, n) => ({ id: `o${n + 1}`, repository: "o/r", branch, commit: "abc", name: o.name, gh_run_id: o.runId ?? "12", gh_run_attempt: o.attempt ?? "1", status: "completed", test_stats: { failed: o.failed } }));
  const laneOfGroup = (url: string): string => groups.find((g) => String(url).includes(`/reports/${g.id}/`))!.name;
  const table: [string, (init: RequestInit, url: string) => Response][] = [
    ["/reports?", (_init, url) => {
      // Asked by suite name, as the watcher does; triage's own lookup adds the commit; the check for
      // unwatched suites asks for the run's commit alone.
      const params = new URL(String(url)).searchParams;
      const name = params.get("name");
      if (!name) {
        assert.ok(params.get("commit"), "reports are listed per suite name or per commit, not as the newest of the whole repository");
        return Response.json({ reports: [...groups.filter((g) => reported.includes(g.name)), ...otherGroups] });
      }
      return Response.json({ reports: groups.filter((g) => g.name === name && reported.includes(name)) });
    }],
    ["/suites", () => Response.json({ suites: [...files, ...retried].map((file_path, i) => ({ id: `s${i}`, file_path, ...(reportName ? { report_name: `${reportName}-11.4` } : {}) })) })],
    ["/cases", (_init, url) => {
      const lane = laneOfGroup(url);
      return Response.json([
        ...files.map((file, i) => ({ suite_id: `s${i}`, title: "t1", status: fails(file, lane) ? "failed" : "passed", retry_count: 0, ordinal: i, error_message: fails(file, lane) ? "Error: expected visible" : null })),
        ...retried.flatMap((_, j) => [
          { suite_id: `s${files.length + j}`, title: "t1", status: "failed", retry_count: 0, ordinal: files.length + j, error_message: "Error: toast not visible" },
          { suite_id: `s${files.length + j}`, title: "t1", status: "passed", retry_count: 1, ordinal: files.length + j },
        ]),
      ]);
    }],
    ["/reports/history", (init) => {
      const body = JSON.parse(String(init.body)) as HistoryBody;
      untils.push(body.until);
      historyBodies.push(body);
      if (historyFailFor && body.files.length === 1 && body.files[0] === historyFailFor) return new Response("down", { status: 503 });
      return Response.json({ observations: history });
    }],
    ["/commits/abc", () => Response.json({ files: [] })],
    ["/graphql", (init) => {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { q?: string; after?: string | null } };
      if (query.includes("search(")) {
        assert.match(String(variables.q), /is:open label:"e2e-autofix"/);
        return Response.json({ data: { search: { nodes: repairPRs } } });
      }
      // Two pages: #41 is not among the newest 50, and #7 was last updated too long ago to count.
      const { after } = variables;
      const pr = (number: number, updatedAt: string, paths: string[] = [], labels: string[] = [], baseRefName = "master", isCrossRepository = false) => ({
        number,
        title: `PR ${number}`,
        url: `https://github.com/o/r/pull/${number}`,
        baseRefName,
        updatedAt,
        isCrossRepository,
        labels: { nodes: labels.map((name) => ({ name })) },
        files: { pageInfo: { hasNextPage: false }, nodes: paths.map((path) => ({ path })) },
      });
      if (!after) return Response.json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "p2" }, nodes: Array.from({ length: 50 }, (_, i) => pr(100 + i, "2026-10-02T12:00:00Z")) } } } });
      return Response.json({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "p3" }, nodes: [pr(43, "2026-10-02T01:00:00Z", releasePRFiles, [], "release-12.0"), pr(42, "2026-10-02T00:30:00Z", forkPRFiles, forkPRLabels, "master", true), pr(41, "2026-10-02T00:00:00Z", openPRFiles, openPRLabels), pr(7, "2026-09-01T00:00:00Z", ["specs/x/a.spec.ts"])] } } } });
    }],
    ["/compare/", (_init, url) => {
      // The watcher's suspect range only: triage's own compares (out of date, who broke master) carry a query.
      const range = String(url).split("/compare/")[1];
      if (!range.includes("?")) compared.push(range);
      // Oldest first, as GitHub returns them; the cause is usually among the first.
      const commits = Array.from({ length: 35 }, (_, i) => ({ sha: `${i}`.padStart(10, "d"), commit: { message: `change ${i}\n\nbody`, author: { name: "dev" } }, author: { login: `dev${i}` } }));
      return Response.json({ total_commits: 35, commits });
    }],
  ];
  return async (url, init = {}) => {
    for (const [m, r] of table) if (String(url).includes(m)) return r(init, String(url));
    throw new Error(`unexpected fetch ${url}`);
  };
}
const suite = (name: string) => ({ name, test_root: "specs" });
const env = { REPOSITORY: "o/r", GH_RUN_ID: "12", BRANCH: "master", GITHUB_TOKEN: "t", TSIO_BASE_URL: "http://tsio", SUITES: JSON.stringify([suite("pw-master")]) };
const now = new Date("2026-10-03T00:00:00Z");
const ledgerPath = (): string => join(mkdtempSync(join(tmpdir(), "watch-")), "ledger.json");

/** The request in a payload, asserting there is one. */
const asFix = (p: FixPayload | undefined): FixPayload => {
  if (!p) throw new Error("no request");
  return p;
};

// One trunk run as the workflow does it: plan, send each request (into `hook`, answered with
// `status`), then record what was accepted.
async function run({ env: e, fetchImpl, now: at = now, hook = [], status = 200 }: { env: Record<string, string | undefined>; fetchImpl: FetchImpl; now?: Date; hook?: FixPayload[]; status?: number }) {
  const LEDGER_PATH = e.LEDGER_PATH ?? ledgerPath();
  const PENDING_PATH = `${LEDGER_PATH}.pending`;
  const result = await watch({ env: { ...e, LEDGER_PATH, PENDING_PATH }, fetchImpl, now: at, log: () => {} });
  for (const r of result.requests) hook.push(r.payload);
  record({ env: { LEDGER_PATH, PENDING_PATH, RESULTS: JSON.stringify(result.requests.map((r) => ({ id: r.id, status }))) }, now: at, log: () => {} });
  return result;
}

test("broken specs with one cause go to one agent with what broke them, and are not requested again while it works", async () => {
  const hook: FixPayload[] = [];
  const compared: string[] = [];
  const untils: string[] = [];
  const fetchImpl = routes({ compared, untils });
  const LEDGER_PATH = ledgerPath();
  const { decisions } = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/y/b.spec.ts"], "skipped: #41 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/z/c.spec.ts"], "to request"],
  ]);
  const first = asFix(hook[0]);
  assert.equal(first.kind, "e2e-autofix");
  assert.equal(hook.length, 1);
  assert.deepEqual(first.specs, ["specs/x/a.spec.ts", "specs/z/c.spec.ts"]);
  assert.equal(first.classification, "broken");
  assert.deepEqual(compared, ["c2...c1"], "from the last green commit to the first red one");
  assert.ok(untils.length > 1 && untils.every((u) => u === "2026-10-02T09:51:00.000Z"), "classification and the suspect range read history only up to this run, not later ones");
  assert.equal(first.last_green_commit, "c2");
  assert.equal(first.first_red_commit, "c1");
  assert.equal(first.suspect_commits.length, 30);
  assert.equal(first.suspect_commits[0].author, "dev0", "the oldest commits are kept");
  assert.equal(first.suspect_commits_total, 35);
  assert.deepEqual(first.labels, ["e2e-autofix"]);

  // The next master run, half an hour later: still broken, no PR yet, so its agent is still working.
  const later = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 1800e3), hook });
  assert.equal(hook.length, 1);
  assert.ok(later.decisions.filter((d) => d.specs[0] !== "specs/y/b.spec.ts").every((d) => d.action.startsWith("skipped: requested 2026-10-03 00:00 UTC")));

  // A day later with still no fix, it is asked again.
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 25 * 3600e3), hook });
  assert.equal(hook.length, 2);
});

test("a request the agent did not accept is not recorded, so the next run plans it again", async () => {
  const hook: FixPayload[] = [];
  const LEDGER_PATH = ledgerPath();
  const fetchImpl = routes({});
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, hook, status: 500 });
  const next = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: new Date(now.getTime() + 1800e3), hook });
  assert.deepEqual(next.decisions.map((d) => d.action), ["skipped: #41 (e2e-autofix) already changes it", "to request"]);
  assert.equal(hook.length, 2);
});

test("breaks all go out at once; flaky specs draw on a daily budget", async () => {
  // Six flaky requests already sent in the last 24 hours (and broken ones, which don't count), plus one from yesterday.
  const LEDGER_PATH = ledgerPath();
  const at = (h: number): string => new Date(now.getTime() - h * 3600e3).toISOString();
  writeFileSync(LEDGER_PATH, JSON.stringify({ requests: [
    ...[1, 2, 3, 4, 5, 6, 30].map((h) => ({ at: at(h), specs: [`specs/flaky${h}.spec.ts`], kind: "flaky", run: "r" })),
    ...[1, 2, 3].map((h) => ({ at: at(h), specs: [`specs/broken${h}.spec.ts`], kind: "broken", run: "r" })),
  ] }));
  const sent: FixPayload[] = [];
  const used = await run({ env: { ...env, LEDGER_PATH: `${LEDGER_PATH}` }, fetchImpl: routes({ openPRFiles: [], recovered: true }), hook: sent });
  assert.deepEqual(used.decisions.map((d) => [d.kind, d.action]), [
    ["broken", "to request"],
    ["flaky", "skipped: flaky budget of 6 a day used"],
  ], "the break goes out even with the flaky budget spent");

  const roomyLedger = ledgerPath();
  const roomy = await run({ env: { ...env, LEDGER_PATH: roomyLedger, MAX_FLAKY_PER_DAY: "7" }, fetchImpl: routes({ openPRFiles: [], recovered: true }), hook: [] });
  assert.ok(roomy.decisions.every((d) => d.action === "to request"));
  // What was sent is kept with its kind, so the next run counts the flaky one against the budget.
  assert.deepEqual(readLedger(roomyLedger).map((r) => [r.specs, r.kind]), [
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "broken"],
    [["specs/v/e.spec.ts"], "flaky"],
  ]);

  // The per-run limit on breaks is a safety stop only.
  const stopped = await run({ env: { ...env, MAX_BROKEN_PER_RUN: "0" }, fetchImpl: routes({ openPRFiles: [] }), hook: [] });
  assert.deepEqual(stopped.decisions.map((d) => d.action), ["skipped: over 0 broken requests in one run"]);

  // A release-branch run started from the same workflow is not trunk.
  const release: FixPayload[] = [];
  const other = await run({ env, fetchImpl: routes({ openPRFiles: [], branch: "release-12.0" }), hook: release });
  assert.equal(release.length, 0);
  assert.deepEqual(other.notes, ["not a master run (pw-master@release-12.0)"]);
});

test("a first failure in two lanes of the same run is broken now; in one lane it waits", async () => {
  const hook: FixPayload[] = [];
  const lanes = ["pw-master", "pw-fips-master"];
  const { decisions } = await run({
    env: { ...env, SUITES: JSON.stringify(lanes.map(suite)) },
    fetchImpl: routes({ lanes, openPRFiles: [], firstFailure: true, failIn: { "x/a.spec.ts": lanes, "y/b.spec.ts": ["pw-master"], "z/c.spec.ts": [] } }),
    hook,
  });
  assert.deepEqual(decisions.map((d) => [d.specs, d.kind, d.action]), [[["specs/x/a.spec.ts"], "broken", "to request"]], "y/b failed in one lane only: wait for the next run");
  assert.deepEqual(asFix(hook[0]).suites, lanes);
  assert.equal(asFix(hook[0]).last_green_commit, "c1", "it passed on the commit before");
});

test("selectCrossLane ignores tests already broken or flaky, and names it cannot tell apart", () => {
  const f = (over: Partial<RepairFinding>): RepairFinding => ({ file: "a.spec.ts", repo_path: "specs/a.spec.ts", title: "t", error: "Error: x", trunk: trunkOf(0, 0, 8), class: "REGRESSION", ...over });
  const groups = selectCrossLane([
    { suite: "ent", findings: [f({}), f({ title: "b", class: "BROKEN_ON_TRUNK" }), f({ title: "u", identity_unresolved: true }), f({ title: "n", class: "INSUFFICIENT_DATA" })] },
    { suite: "fips", findings: [f({}), f({ title: "b", class: "BROKEN_ON_TRUNK" }), f({ title: "u", identity_unresolved: true }), f({ title: "n", class: "INSUFFICIENT_DATA" })] },
  ]);
  // One entry per lane: each is read against its own lane's history.
  assert.deepEqual(groups.map((g) => [g.spec, g.kind, g.tests.map((t) => [t.suite, t.title])]), [["specs/a.spec.ts", "broken", [["ent", "t"], ["fips", "t"], ["ent", "n"], ["fips", "n"]]]]);
});

test("a lane failing first in this run makes this run the suspect range's end", async () => {
  const lanes = ["playwright-full-enterprise-master", "playwright-full-fips-master"];
  const obs = (name: string, n: number, status: string) => ({ file: "x/a.spec.ts", title: "t1", status, retry_count: 0, gh_pr_number: null, branch: "master", group_id: `${name}-${n}`, commit_sha: `c${n}`, created_at: `2026-10-02T${String(n).padStart(2, "0")}:00:00Z`, name });
  // Enterprise passed up to c7 and fails first in this run; FIPS broke at c8, after its green c7.
  const observations = [obs(lanes[0], 7, "passed"), obs(lanes[0], 6, "passed"), obs(lanes[1], 8, "failed"), obs(lanes[1], 7, "passed")];
  const fetchImpl: FetchImpl = async () => Response.json({ observations, has_more: false });
  const finding: RepairFinding = { file: "x/a.spec.ts", title: "t1", error: "Error: expected visible", class: "REGRESSION", trunk: trunkOf(0, 0, 8) };
  const [group] = selectCrossLane(lanes.map((suite) => ({ suite, findings: [finding] })));
  const id: WatchId = { repository: "o/r", branch: "master", commit_sha: "c9", gh_run_id: "12", gh_run_attempt: "1" };
  const { range } = await specRange(fetchImpl, "http://tsio", id, group, () => "2026-10-03T00:00:00Z", Date.parse("2026-10-02T09:00:00Z"), () => {}, new Map(lanes.map((l): [string, string | null] => [l, null])));
  assert.equal(range?.green.commit_sha, "c7");
  assert.equal(range?.red, null, "enterprise's first failure is this run, later than FIPS's c8");
});

test("the suspect range covers every lane's break, ending at the latest lane's first failure", async () => {
  const lanes = ["playwright-full-enterprise-master", "playwright-full-fips-master"];
  const obs = (name: string, n: number, status: string) => ({ file: "x/a.spec.ts", title: "t1", status, retry_count: 0, gh_pr_number: null, branch: "master", group_id: `${name}-${n}`, commit_sha: `c${n}`, created_at: `2026-10-02T${String(n).padStart(2, "0")}:00:00Z`, name });
  // Enterprise broke at c7, after its green c6; FIPS broke at c8, after its green c7. The range must reach c8.
  const observations = [obs(lanes[0], 7, "failed"), obs(lanes[0], 6, "passed"), obs(lanes[0], 5, "passed"), obs(lanes[1], 8, "failed"), obs(lanes[1], 7, "passed"), obs(lanes[1], 6, "passed")];
  const fetchImpl: FetchImpl = async () => Response.json({ observations, has_more: false });
  const finding: RepairFinding = { file: "x/a.spec.ts", title: "t1", error: "Error: expected visible", class: "REGRESSION", trunk: trunkOf(0, 0, 8) };
  const [group] = selectCrossLane(lanes.map((suite) => ({ suite, findings: [finding] })));
  const id: WatchId = { repository: "o/r", branch: "master", commit_sha: "c9", gh_run_id: "12", gh_run_attempt: "1" };
  const { range } = await specRange(fetchImpl, "http://tsio", id, group, () => "2026-10-03T00:00:00Z", Date.parse("2026-10-02T09:00:00Z"), () => {}, new Map(lanes.map((l): [string, string | null] => [l, null])));
  assert.deepEqual([range?.green.commit_sha, range?.red?.commit_sha], ["c6", "c8"], "the oldest green, the latest first failure");
});

test("a test that failed and passed on retry is repaired as flaky only if it also flaked on trunk before", async () => {
  const hook: FixPayload[] = [];
  const { decisions } = await run({ env, fetchImpl: routes({ recovered: true }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.kind, d.action]), [
    [["specs/y/b.spec.ts"], "broken", "skipped: #41 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/z/c.spec.ts"], "broken", "to request"],
    [["specs/v/e.spec.ts"], "flaky", "to request"],
  ], "u/f.spec.ts recovered on retry but never flaked on trunk before: wait");
  const flaky = asFix(hook.find((h) => h.kind === "e2e-autofix" && h.classification === "flaky"));
  assert.equal(flaky.tests[0].trunk.flaky, 1);
  assert.equal(flaky.tests[0].trunk.recovered_on_retry_now, true);
  assert.match(flaky.tests[0].error, /toast not visible/, "the error is the failed attempt's");
});

test("conflict requests a ledger still holds from before they moved to a label hold no spec", async () => {
  const LEDGER_PATH = ledgerPath();
  writeFileSync(LEDGER_PATH, JSON.stringify({ requests: [{ at: new Date(now.getTime() - 3600e3).toISOString(), pr: 50, head: "h50", run: "r" }] }));
  const hook: FixPayload[] = [];
  const { decisions } = await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ openPRLabels: [] }), hook });
  assert.deepEqual(decisions.map((d) => d.action), ["to request"]);
  assert.equal(hook.length, 1);
});

test("someone else's open PR on a spec doesn't hold back the fix: the agent gets it to judge", async () => {
  const hook: FixPayload[] = [];
  // #41 is feature work (no autofix label) changing y/b.spec.ts; #43 targets a release branch.
  const { decisions } = await run({ env, fetchImpl: routes({ openPRLabels: [], releasePRFiles: ["specs/x/a.spec.ts"] }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]]);
  assert.deepEqual(asFix(hook[0]).open_prs_touching, [{ number: 41, title: "PR 41", url: "https://github.com/o/r/pull/41" }], "the release-branch PR is not listed");
});

test("a fork PR is never sent to the agent, and does not count as its own", async () => {
  const hook: FixPayload[] = [];
  // #42 is from a fork: it changes x/a.spec.ts and carries the agent's label. Its title and files stay out of the request.
  const { decisions } = await run({ env, fetchImpl: routes({ openPRLabels: [], forkPRFiles: ["specs/x/a.spec.ts"], forkPRLabels: ["e2e-autofix"] }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]], "the fork PR does not block x/a");
  assert.deepEqual(asFix(hook[0]).open_prs_touching, [{ number: 41, title: "PR 41", url: "https://github.com/o/r/pull/41" }], "the same-repo PR is listed; the fork PR is not");
});

test("a fork PR with the agent's label is not one of its PRs: it blocks nothing", async () => {
  const hook: FixPayload[] = [];
  const fork = { number: 60, title: "fork", url: "https://github.com/o/r/pull/60", baseRefName: "master", headRefName: "fix/60", headRefOid: "h60", isCrossRepository: true, files: { nodes: [{ path: "specs/x/a.spec.ts" }] } };
  const { decisions } = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [fork] }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]]);
});

test("a break overlapping one handed over a few hours ago waits for that agent; later it is requested", async () => {
  // a, b and c broke between c2 (07:00) and c1 (08:00). An earlier run sent a break with an overlapping window.
  const sentAt = new Date(now.getTime() - 3600e3).toISOString();
  const ledgerWith = (window: { from: number; to: number }): string => {
    const path = ledgerPath();
    writeFileSync(path, JSON.stringify({ requests: [{ at: sentAt, specs: ["specs/q/other.spec.ts"], kind: "broken", window, run: "r" }] }));
    return path;
  };
  const overlapping = { from: Date.parse("2026-10-02T06:00:00Z"), to: Date.parse("2026-10-02T07:30:00Z") };
  const hook: FixPayload[] = [];
  const held = await run({ env: { ...env, LEDGER_PATH: ledgerWith(overlapping) }, fetchImpl: routes({ openPRFiles: [] }), hook });
  assert.deepEqual(held.decisions.map((d) => d.action), ["skipped: may be the break requested 2026-10-02 23:00 UTC (overlapping suspect commits)"]);
  assert.equal(hook.length, 0);

  // After the cause hold (4 hours by default) it goes out: by then that agent's PR exists, or it found nothing.
  const later = await run({ env: { ...env, LEDGER_PATH: ledgerWith(overlapping) }, fetchImpl: routes({ openPRFiles: [] }), now: new Date(now.getTime() + 4 * 3600e3), hook });
  assert.deepEqual(later.decisions.map((d) => d.action), ["to request"]);

  // An earlier break that ended before these last passed can't be the same cause.
  const before = { from: Date.parse("2026-10-02T04:00:00Z"), to: Date.parse("2026-10-02T07:00:00Z") };
  const separate = await run({ env: { ...env, LEDGER_PATH: ledgerWith(before) }, fetchImpl: routes({ openPRFiles: [] }), hook: [] });
  assert.deepEqual(separate.decisions.map((d) => d.action), ["to request"]);

  // A request keeps its window, so later runs can tell.
  const fresh = ledgerPath();
  await run({ env: { ...env, LEDGER_PATH: fresh }, fetchImpl: routes({ openPRFiles: [] }), hook: [] });
  assert.deepEqual(readLedger(fresh).map((e) => [e.kind, e.window]), [["broken", { from: Date.parse("2026-10-02T07:00:00Z"), to: Date.parse("2026-10-02T08:00:00Z") }]]);
});

test("a spec's last green run passed or skipped it: a skip behind a flag counts, a flaky run doesn't", () => {
  const t1 = { file: "a.spec.ts", title: "t1" };
  const range = (...rows: RunRow[]) => rangeOf(new Map([[identityKey(t1), rows]]), [t1], "master");
  assert.equal(range(row("failed", 1), row("skipped", 2), row("passed", 3))?.green.commit_sha, "c2");
  // It flaked at c2 and failed from c1: c2 may be where it broke, so it stays among the suspects.
  const flakedFirst = range(row("failed", 1), row("flaky", 2), row("passed", 3));
  assert.deepEqual([flakedFirst?.green.commit_sha, flakedFirst?.red?.commit_sha], ["c3", "c1"]);
  assert.equal(range(row("failed", 1), row("failed", 2)), null);
});

test("a bundle with a member whose break is older than the history has no suspect range", () => {
  const t = (hhmm: string): number => Date.parse(`2026-10-02T${hhmm}:00Z`);
  const g = (spec: string, from: number, range: RangeFixture): RangedGroup => ({
    spec,
    kind: "broken",
    suites: new Set(["s"]),
    tests: [groupTest(spec)],
    range,
    window: { from, to: t("10:00") },
  });
  const known = { green: { commit_sha: "c3", created_at: "2026-10-02T03:00:00Z" }, red: null };
  assert.equal(bundle([g("a.spec.ts", t("03:00"), known), g("b.spec.ts", -Infinity, null)])[0].range, null, "the unknown member first");
  assert.equal(bundle([g("b.spec.ts", -Infinity, null), g("a.spec.ts", t("03:00"), known)])[0].range, null);
});

test("a spec whose history can't be read waits for the next run instead of going out unbundled", async () => {
  const hook: FixPayload[] = [];
  const { decisions } = await run({ env, fetchImpl: routes({ openPRFiles: [], historyFailFor: "x/a.spec.ts" }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/x/a.spec.ts"], "skipped: history unavailable (Error: TSIO history 503)"],
    [["specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"],
  ]);
});

/** An agent PR as the search reads it, active at the run's time unless `updatedAt` says otherwise. */
const ownPR = (number: number, path: string, over: Record<string, unknown> = {}) => ({
  number,
  title: `fix ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  baseRefName: "master",
  headRefName: `fix/${number}`,
  headRefOid: `h${number}`,
  isCrossRepository: false,
  updatedAt: "2026-10-02T23:00:00Z",
  files: { nodes: [{ path }] },
  ...over,
});

test("an agent PR blocks the exact spec it changes while active, not its directory; a backport never counts", async () => {
  // A sibling in the spec's directory: nothing is skipped.
  const sibling = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [ownPR(9, "specs/z/helpers.ts")] }), hook: [] });
  assert.deepEqual(sibling.decisions.map((d) => [d.specs.slice().sort(), d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]], "a helper beside the spec does not block it");

  // The spec itself: skipped; the release-branch backport changes it too but is not trunk's, so it doesn't block.
  const backport = ownPR(10, "specs/x/a.spec.ts", { baseRefName: "release-12.0" });
  const exact = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [ownPR(9, "specs/z/c.spec.ts"), backport] }), hook: [] });
  assert.deepEqual(exact.decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: #9 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
});

test("a labelled open PR beside a spec, not on it, does not block the spec; it is still listed for the agent", async () => {
  const hook: FixPayload[] = [];
  // #41 carries the label and changes y/helpers.ts, beside y/b.spec.ts.
  const { decisions } = await run({ env, fetchImpl: routes({ openPRFiles: ["specs/y/helpers.ts"] }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs.slice().sort(), d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]]);
  assert.deepEqual(asFix(hook[0]).open_prs_touching.map((p) => p.number), [41], "still listed, so the agent can judge it");
});

test("an agent PR idle for more than 3 days no longer blocks, and is named in the summary", async () => {
  // Last updated and last committed four days before the run.
  const idle = ownPR(9, "specs/z/c.spec.ts", { updatedAt: "2026-09-29T00:00:00Z", commits: { nodes: [{ commit: { committedDate: "2026-09-29T00:00:00Z" } }] } });
  const { decisions, notes } = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [idle] }), hook: [] });
  assert.deepEqual(decisions.map((d) => [d.specs.slice().sort(), d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]]);
  assert.deepEqual(notes, ["stalled agent PR #9 (idle 4 days): not blocking new requests"]);
});

test("a recent commit keeps an agent PR active, even when its update is old", async () => {
  const pushed = ownPR(9, "specs/z/c.spec.ts", { updatedAt: "2026-09-29T00:00:00Z", commits: { nodes: [{ commit: { committedDate: "2026-10-02T23:00:00Z" } }] } });
  const { decisions, notes } = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [pushed] }), hook: [] });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: #9 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
  assert.deepEqual(notes, []);
});

test("an agent PR idle for less than 3 days still blocks", async () => {
  const idle = ownPR(9, "specs/z/c.spec.ts", { updatedAt: "2026-10-01T00:00:00Z" });
  const recent = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [idle] }), hook: [] });
  assert.deepEqual(recent.decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: #9 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
  assert.deepEqual(recent.notes, [], "not idle yet: nothing to name");
});

test("an agent PR open more than 2 days with its spec still failing no longer blocks, however active; the agent gets it to judge", async () => {
  // Opened four days before the run, with review traffic an hour ago.
  const stuck = ownPR(9, "specs/z/c.spec.ts", { createdAt: "2026-09-29T00:00:00Z" });
  const hook: FixPayload[] = [];
  const { decisions, notes } = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [stuck] }), hook });
  assert.deepEqual(decisions.map((d) => [d.specs.slice().sort(), d.action]), [[["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"], "to request"]]);
  assert.deepEqual(notes, ["stalled agent PR #9 (open 4 days with the spec still failing): not blocking new requests"]);
  assert.deepEqual(asFix(hook[0]).open_prs_touching, [{ number: 9, title: "fix 9", url: "https://github.com/o/r/pull/9" }], "listed, though it is not among the recent open PRs read");

  // Opened a day ago: still the agent's to finish.
  const young = ownPR(9, "specs/z/c.spec.ts", { createdAt: "2026-10-02T00:00:00Z" });
  const fresh = await run({ env, fetchImpl: routes({ openPRFiles: [], repairPRs: [young] }), hook: [] });
  assert.deepEqual(fresh.decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: #9 (e2e-autofix) already changes it"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
});

test("a spec whose old agent PR no longer blocks is asked about every 3 days, not daily: a right fix in review keeps it failing too", async () => {
  const LEDGER_PATH = ledgerPath();
  // Only z/c has an agent PR; x/a and y/b keep the daily hold.
  const stuck = ownPR(9, "specs/z/c.spec.ts", { createdAt: "2026-09-29T00:00:00Z" });
  const fetchImpl = routes({ openPRFiles: [], repairPRs: [stuck] });
  const hook: FixPayload[] = [];
  const at = (h: number): Date => new Date(now.getTime() + h * 3600e3);
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, hook });
  assert.deepEqual(asFix(hook[0]).specs, ["specs/x/a.spec.ts", "specs/y/b.spec.ts", "specs/z/c.spec.ts"]);
  const nextDay = await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: at(25), hook });
  assert.deepEqual(nextDay.decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: requested 2026-10-03 00:00 UTC by https://github.com/o/r/actions/runs/12"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
  await run({ env: { ...env, LEDGER_PATH }, fetchImpl, now: at(73), hook });
  assert.deepEqual(hook.map((p) => p.specs.includes("specs/z/c.spec.ts")), [true, false, true], "asked again after 3 days");
});

test("each suite's history ends with its own report: one a re-run left at attempt 1 is not read past it", async () => {
  const untils: string[] = [];
  const lanes = ["pw-master", "pw-fips-master"];
  // Attempt 2 re-ran the enterprise lane hours after attempt 1 reported FIPS.
  await run({
    env: { ...env, GH_RUN_ATTEMPT: "2", SUITES: JSON.stringify(lanes.map(suite)) },
    fetchImpl: routes({ lanes, openPRFiles: [], untils, attempts: { "pw-master": "2" }, uploadedAt: { "pw-master": "2026-10-02T15:00:00Z" } }),
    hook: [],
  });
  assert.deepEqual([...new Set(untils)].sort(), ["2026-10-02T09:51:00.000Z", "2026-10-02T15:01:00.000Z"]);
});

test("the hold still limits duplicates for a spec whose agent PR is idle", async () => {
  const LEDGER_PATH = ledgerPath();
  writeFileSync(LEDGER_PATH, JSON.stringify({ requests: [{ at: new Date(now.getTime() - 3600e3).toISOString(), specs: ["specs/z/c.spec.ts"], kind: "broken", run: "r" }] }));
  const idle = ownPR(9, "specs/z/c.spec.ts", { updatedAt: "2026-09-29T00:00:00Z" });
  const { decisions } = await run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({ openPRFiles: [], repairPRs: [idle] }), hook: [] });
  assert.deepEqual(decisions.map((d) => [d.specs, d.action]), [
    [["specs/z/c.spec.ts"], "skipped: requested 2026-10-02 23:00 UTC by r"],
    [["specs/x/a.spec.ts", "specs/y/b.spec.ts"], "to request"],
  ]);
});

test("the flaky budget goes to specs not requested this week before the ones that were", async () => {
  // Both flaked once before. v/e was requested two days ago (past the 24-hour hold) and is still flaky; u/f never was.
  const ledgerWithE = (): string => {
    const path = ledgerPath();
    writeFileSync(path, JSON.stringify({ requests: [{ at: new Date(now.getTime() - 48 * 3600e3).toISOString(), specs: ["specs/v/e.spec.ts"], kind: "flaky", run: "r" }] }));
    return path;
  };
  const flaky = async (LEDGER_PATH: string, max: string) => (await run({ env: { ...env, LEDGER_PATH, MAX_FLAKY_PER_DAY: max }, fetchImpl: routes({ openPRFiles: [], recovered: true, bothFlaked: true }), hook: [] }))
    .decisions.filter((d) => d.kind === "flaky").map((d) => [d.specs[0], d.action]);
  assert.deepEqual(await flaky(ledgerPath(), "1"), [["specs/v/e.spec.ts", "to request"], ["specs/u/f.spec.ts", "skipped: flaky budget of 1 a day used"]], "equally flaky, never asked: in order");
  assert.deepEqual(await flaky(ledgerWithE(), "1"), [["specs/u/f.spec.ts", "to request"], ["specs/v/e.spec.ts", "skipped: flaky budget of 1 a day used"]], "the one asked about this week goes last");
  assert.deepEqual(await flaky(ledgerWithE(), "2"), [["specs/u/f.spec.ts", "to request"], ["specs/v/e.spec.ts", "to request"]], "with room, it is still sent");
});

test("a lane the run did not report is named in the summary, not read as clean", async () => {
  const lanes = ["pw-master", "pw-fips-master"];
  const { notes } = await run({ env: { ...env, SUITES: JSON.stringify(lanes.map(suite)) }, fetchImpl: routes({ lanes, reported: ["pw-master"], openPRFiles: [] }), hook: [] });
  assert.deepEqual(notes, ["pw-fips-master: no master report for this run; not read"]);
});

test("when the agent's own PRs can't be read, no fix request goes out", async () => {
  const fetchImpl = routes({ openPRFiles: [] });
  const failing: FetchImpl = async (url, init = {}) =>
    String(url).includes("/graphql") && (JSON.parse(String(init.body)) as { query: string }).query.includes("search(") ? Response.json({ errors: [{ message: "rate limited" }] }) : fetchImpl(url, init);
  const hook: FixPayload[] = [];
  const { decisions, notes } = await run({ env, fetchImpl: failing, hook });
  assert.equal(hook.length, 0);
  assert.ok(decisions.every((d) => d.action === "skipped: the agent's own PRs could not be read"));
  assert.deepEqual(notes, ["the agent's own PRs not read (Error: GitHub GraphQL: rate limited)"]);
});

test("the agent's own PRs are read past the first page", async () => {
  const pages: (string | null | undefined)[] = [];
  const fetchImpl = routes({ openPRFiles: [] });
  const paged: FetchImpl = async (url, init = {}) => {
    if (String(url).includes("/graphql")) {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { after?: string | null } };
      if (query.includes("search(")) {
        pages.push(variables.after);
        const pr = (n: number, path: string) => ({ number: n, title: "fix", url: `https://github.com/o/r/pull/${n}`, baseRefName: "master", headRefName: `fix/${n}`, headRefOid: `h${n}`, isCrossRepository: false, files: { nodes: [{ path }] } });
        return Response.json({ data: { search: variables.after ? { pageInfo: { hasNextPage: false }, nodes: [pr(9, "specs/z/c.spec.ts")] } : { pageInfo: { hasNextPage: true, endCursor: "p2" }, nodes: [pr(8, "specs/q/other.ts")] } } });
      }
    }
    return fetchImpl(url, init);
  };
  const { decisions } = await run({ env, fetchImpl: paged, hook: [] });
  assert.deepEqual(pages, [null, "p2"]);
  assert.deepEqual([decisions[0].specs, decisions[0].action], [["specs/z/c.spec.ts"], "skipped: #9 (e2e-autofix) already changes it"]);
});

test("a ledger that isn't valid JSON stops the run instead of dropping every hold", async () => {
  const LEDGER_PATH = ledgerPath();
  writeFileSync(LEDGER_PATH, '{"requests": [');
  await assert.rejects(run({ env: { ...env, LEDGER_PATH }, fetchImpl: routes({}), hook: [] }), /not valid JSON.*delete the e2e-master-watch caches/);
  assert.throws(() => record({ env: { LEDGER_PATH, PENDING_PATH: `${LEDGER_PATH}.pending`, RESULTS: "[]" }, log: () => {} }), /not valid JSON/);
  assert.deepEqual(readLedger(join(mkdtempSync(join(tmpdir(), "watch-")), "missing.json")), [], "no ledger yet is an empty one");
});

test("more open agent PRs than the search reads is treated like not reading them", async () => {
  const fetchImpl = routes({ openPRFiles: [] });
  const endless: FetchImpl = async (url, init = {}) => {
    if (String(url).includes("/graphql") && (JSON.parse(String(init.body)) as { query: string }).query.includes("search(")) {
      return Response.json({ data: { search: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [] } } });
    }
    return fetchImpl(url, init);
  };
  const hook: FixPayload[] = [];
  const { decisions } = await run({ env, fetchImpl: endless, hook });
  assert.equal(hook.length, 0);
  assert.ok(decisions.every((d) => d.action === "skipped: the agent's own PRs could not be read"));
});

test("open PRs past the pages read are reported as not checked", async () => {
  const page = { pageInfo: { hasNextPage: true, endCursor: "n" }, nodes: [] };
  const api = async () => ({ data: { repository: { pullRequests: page } } });
  assert.equal((await specsInOpenPRs(api, "o/r", { maxPages: 2 })).truncated, true);
  const last = { pageInfo: { hasNextPage: false }, nodes: [] };
  assert.equal((await specsInOpenPRs(async () => ({ data: { repository: { pullRequests: last } } }), "o/r")).truncated, false);
});

test("the run's reports are found past the newest page of its suite", async () => {
  const group = (run: number, i: number) => ({ id: `g${run}-${i}`, name: "pw-master", gh_run_id: String(run), gh_run_attempt: "1", branch: "master" });
  // Newest first: runs 300..201 on the first page, then 200..101; run 150 is on the second.
  const pages = [[...Array(100)].map((_, i) => group(300 - i, 0)), [...Array(100)].map((_, i) => group(200 - i, 0)), [...Array(100)].map((_, i) => group(100 - i, 0))];
  const offsets: number[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    offsets.push(offset);
    return Response.json({ reports: pages[offset / 100] ?? [] });
  };
  const found = await runGroups(fetchImpl, "http://tsio", "o/r", "150", "1", ["pw-master"]);
  assert.deepEqual(found.map((g) => g.id), ["g150-0"]);
  assert.deepEqual(offsets, [0, 100], "it stops once the run is behind it");
});

test("a re-run attempt reads each suite at its newest attempt up to it: one it didn't re-run stays at the earlier one", async () => {
  const group = (name: string, attempt: string) => ({ id: `${name}-${attempt}`, name, gh_run_id: "150", gh_run_attempt: attempt, branch: "master" });
  // ent was re-run in attempt 2; fips was not; attempt 3 of ent is newer than the attempt asked for.
  const reports = [group("ent", "3"), group("ent", "2"), group("ent", "1"), group("fips", "1"), { ...group("ent", "1"), gh_run_id: "149", id: "older" }];
  const fetchImpl: FetchImpl = async (url) => Response.json({ reports: reports.filter((g) => g.name === new URL(String(url)).searchParams.get("name")) });
  assert.deepEqual((await runGroups(fetchImpl, "http://tsio", "o/r", "150", "2", ["ent", "fips"])).map((g) => g.id), ["ent-2", "fips-1"]);
  assert.deepEqual((await runGroups(fetchImpl, "http://tsio", "o/r", "150", "1", ["ent", "fips"])).map((g) => g.id), ["ent-1", "fips-1"]);

  // A whole trunk run whose attempt 2 re-ran other jobs: the Playwright lane is read from attempt 1.
  const hook: FixPayload[] = [];
  const { decisions, notes } = await run({ env: { ...env, GH_RUN_ATTEMPT: "2" }, fetchImpl: routes({}), hook });
  assert.deepEqual(decisions.map((d) => d.action), ["skipped: #41 (e2e-autofix) already changes it", "to request"]);
  assert.deepEqual(notes, ["pw-master: not re-run in attempt 2; read attempt 1"]);
});

test("a suite the caller doesn't watch that failed in this run is named, so a red run with no request says why", async () => {
  const { notes } = await run({
    env,
    fetchImpl: routes({
      others: [
        { name: "cy-master", failed: 3 },
        { name: "pw-upgrade-master", failed: 0 },
        { name: "cy-master-other", failed: 5, runId: "11" }, // another run of the commit
      ],
    }),
    hook: [],
  });
  assert.deepEqual(notes, ["cy-master: 3 failed in this run; not watched, so not requested"]);

  // A subpath lane failed in attempt 1 and passed in its re-run, attempt 2: each attempt's watch names its own count.
  const subpath = [{ name: "pw-subpath-master", failed: 2, attempt: "1" }, { name: "pw-subpath-master", failed: 0, attempt: "2" }];
  const first = await run({ env, fetchImpl: routes({ others: subpath }), hook: [] });
  assert.deepEqual(first.notes, ["pw-subpath-master: 2 failed in this run; not watched, so not requested"], "attempt 1's failure, though attempt 2 has passed since");
  const second = await run({ env: { ...env, GH_RUN_ATTEMPT: "2" }, fetchImpl: routes({ others: subpath }), hook: [] });
  assert.deepEqual(second.notes, ["pw-master: not re-run in attempt 2; read attempt 1"], "the re-run passed: nothing to name");

  // TSIO down for that read: the run still plans, and says what it couldn't check.
  const base = routes({});
  const flaky: FetchImpl = async (url, init) => (String(url).includes("/reports?") && !new URL(String(url)).searchParams.get("name") ? new Response("down", { status: 503 }) : base(url, init));
  const down = await run({ env, fetchImpl: flaky, hook: [] });
  assert.equal(down.decisions.at(-1)?.action, "to request");
  assert.match(down.notes[0], /^suites outside the watched ones not checked for failures/);
});

test("the check for unwatched suites reads every page of the commit's groups, and says when it stopped short", async () => {
  const group = (i: number, failed: number) => ({ id: `u${i}`, name: `lane-${i}`, gh_run_id: i === 150 ? "12" : "11", gh_run_attempt: "1", branch: "master", test_stats: { failed } });
  // The run's failing lane is on the second page; the rest belong to other runs of the commit.
  const rows = [...Array(230)].map((_, i) => group(i, i === 150 ? 4 : 1));
  const offsets: number[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    offsets.push(offset);
    return Response.json({ reports: rows.slice(offset, offset + 100) });
  };
  assert.deepEqual(await unwatchedFailures(fetchImpl, "http://tsio", "o/r", "abc", "12", "1", "master", []), ["lane-150: 4 failed in this run; not watched, so not requested"]);
  assert.deepEqual(offsets, [0, 100, 200]);

  const endless: FetchImpl = async () => Response.json({ reports: [...Array(100)].map((_, i) => group(i, 0)) });
  assert.deepEqual(await unwatchedFailures(endless, "http://tsio", "o/r", "abc", "12", "1", "master", []), ["suites outside the watched ones checked only in the newest 500 groups of this commit"]);
});

test("failing tests no request covers are named with why they wait", async () => {
  const lanes = ["pw-master", "pw-fips-master"];
  const { notes } = await run({
    env: { ...env, SUITES: JSON.stringify(lanes.map(suite)) },
    fetchImpl: routes({ lanes, openPRFiles: [], firstFailure: true, failIn: { "x/a.spec.ts": lanes, "y/b.spec.ts": ["pw-master"], "z/c.spec.ts": [] } }),
    hook: [],
  });
  assert.deepEqual(notes, ["specs/y/b.spec.ts › t1 (pw-master): first failure, in pw-master only; requested if it fails again"], "x/a failed in both lanes and is requested: not named");

  const f = (over: Partial<RepairFinding>): RepairFinding => finding({ trunk: trunkOf(0, 0, 8), ...over });
  const left = unselected(
    [{ suite: "ent", findings: [f({ title: "same", class: "BROKEN_ON_TRUNK", identity_unresolved: true }), f({ title: "once", class: "FLAKY_ON_TRUNK", file: "b.spec.ts", repo_path: "specs/b.spec.ts" }), f({ title: "infra", class: "INFRA_ERROR", file: "c.spec.ts", repo_path: "specs/c.spec.ts" }), f({ title: "picked", file: "d.spec.ts", repo_path: "specs/d.spec.ts" })] }],
    new Set(["specs/d.spec.ts"]),
  );
  assert.deepEqual(left.map((u) => [u.spec, u.title, u.reason]), [
    ["specs/a.spec.ts", "same", "shares its name with another test, so its history can't be read"],
    ["specs/b.spec.ts", "once", "first flake on trunk; requested if it flakes again"],
  ], "an environment error is the lane's to re-run, and a spec already requested needs no note");
});

test("a run with no reports says so in the job summary", async () => {
  const summary = join(mkdtempSync(join(tmpdir(), "watch-")), "summary.md");
  const { notes } = await run({ env: { ...env, GH_RUN_ID: "999", GITHUB_STEP_SUMMARY: summary }, fetchImpl: routes({}), hook: [] });
  assert.deepEqual(notes, ["no reports for run 999 in TSIO under pw-master"]);
  assert.match(readFileSync(summary, "utf8"), /no reports for run 999 in TSIO under pw-master; nothing to watch/);
});

test("history is read only for flaky specs the daily budget will send", async () => {
  const historyBodies: HistoryBody[] = [];
  await run({ env: { ...env, MAX_FLAKY_PER_DAY: "1" }, fetchImpl: routes({ openPRFiles: [], recovered: true, bothFlaked: true, historyBodies }), hook: [] });
  const perSpec = historyBodies.filter((b) => b.files.length === 1).map((b) => b.files[0]);
  assert.ok(perSpec.includes("v/e.spec.ts"), "the flaky spec it sends");
  assert.ok(!perSpec.includes("u/f.spec.ts"), "not the one over budget");
});

test("a suite's report name scopes every history read, the suspect range's too", async () => {
  const historyBodies: HistoryBody[] = [];
  await run({ env: { ...env, SUITES: JSON.stringify([{ ...suite("pw-master"), report_name: "pw" }]) }, fetchImpl: routes({ openPRFiles: [], historyBodies, reportName: "pw" }), hook: [] });
  assert.ok(historyBodies.some((b) => b.files.length === 1), "the suspect range read history");
  assert.ok(historyBodies.every((b) => b.report === "pw"));
});

test("the requests go to a file for the workflow to send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const GITHUB_OUTPUT = join(dir, "out");
  const { requests } = await run({ env: { ...env, REQUESTS_PATH: join(dir, "requests.json"), GITHUB_OUTPUT }, fetchImpl: routes({}), hook: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "requests.json"), "utf8")), requests);
  assert.equal(readFileSync(GITHUB_OUTPUT, "utf8"), `count=${requests.length}\n`);
});
