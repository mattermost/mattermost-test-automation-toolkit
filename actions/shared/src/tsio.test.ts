// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchImpl } from "./github.ts";
import { DEFAULT_TSIO_BASE_URL, NoResultsError, STAGING_TSIO_BASE_URL, SupersededRunError, compositeIdentityFrom, fetchRun, missingReports, missingArrived, tsioBase } from "./tsio.ts";

test("use-staging unset, false or empty keeps the shared instance or the given base URL", () => {
  assert.equal(tsioBase({}), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "false" }), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "" }), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "false", TSIO_BASE_URL: "" }), DEFAULT_TSIO_BASE_URL);
});

test("use-staging true targets the staging deployment", () => {
  assert.equal(tsioBase({ USE_STAGING: "true" }), STAGING_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: "" }), STAGING_TSIO_BASE_URL);
  // Read the way TSIO's own actions read it: trimmed and case-insensitive.
  assert.equal(tsioBase({ USE_STAGING: " TRUE " }), STAGING_TSIO_BASE_URL);
});

test("use-staging true with the matching staging URL is accepted, with or without a trailing slash", () => {
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: STAGING_TSIO_BASE_URL }), STAGING_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: `${STAGING_TSIO_BASE_URL}/` }), STAGING_TSIO_BASE_URL);
});

test("use-staging true with a conflicting tsio-base-url fails clearly", () => {
  assert.throws(() => tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: DEFAULT_TSIO_BASE_URL }), /use-staging is true.*tsio-base-url/);
  assert.throws(() => tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: "http://tsio" }), /use-staging is true.*tsio-base-url/);
});

test("use-staging false with a custom tsio-base-url uses the custom URL, without its trailing slash", () => {
  assert.equal(tsioBase({ USE_STAGING: "false", TSIO_BASE_URL: "https://custom.example/" }), "https://custom.example");
  assert.equal(tsioBase({ TSIO_BASE_URL: "http://tsio" }), "http://tsio");
});

test("an incomplete run names how many of its reports arrived", () => {
  assert.deepEqual(missingReports({ expected: 3, received: 3, status: "in_progress" }), { text: "the run's results are incomplete (3 of 3 reports arrived; TSIO group in_progress)", short: "results incomplete: 3 of 3 reports" });
  assert.deepEqual(missingReports({ expected: 3, received: null, status: "in_progress" }), { text: "the run's results are incomplete (? of 3 reports arrived; TSIO group in_progress)", short: "results incomplete: ? of 3 reports" });
  assert.deepEqual(missingReports({ expected: null, received: 2, status: "processing" }), { text: "the run's results are incomplete (2 reports arrived; the expected count is unknown; TSIO group processing)", short: "results incomplete" });
});

test("a missing or non-JSON COMPOSITE_IDENTITY is named as such, not a bare SyntaxError", () => {
  assert.throws(() => compositeIdentityFrom(undefined), /COMPOSITE_IDENTITY is missing/);
  assert.throws(() => compositeIdentityFrom(""), /COMPOSITE_IDENTITY is missing/);
  assert.throws(() => compositeIdentityFrom("{bad"), /COMPOSITE_IDENTITY is not valid JSON/);
  assert.deepEqual(compositeIdentityFrom('{"repository":"o/r"}'), { repository: "o/r" }, "a valid identity is read as written");
});

// A TSIO that answers the report list and nothing else: fetchRun reads it first, and its groups decide the outcome.
const groupsOnly = (reports: unknown[]): FetchImpl => (async (url: string) => {
  if (String(url).includes("/reports?")) return Response.json({ reports });
  throw new Error(`unexpected ${url}`);
}) as FetchImpl;
const commit = "beed9ae9f5732b81aedf0ad7b6bc86701253a387";
const suite = "playwright-full-enterprise";
const group = (gh_run_id: string, gh_run_attempt = "1", over: Record<string, unknown> = {}) => ({ id: `g-${gh_run_id}-${gh_run_attempt}`, repository: "mattermost/mattermost", commit, name: suite, gh_run_id, gh_run_attempt, status: "completed", ...over });
const ours = { repository: "mattermost/mattermost", commit_sha: commit, name: suite, gh_run_id: "39637355358", gh_run_attempt: "1" };

test("a group a newer dispatch took is superseded: the error names the newest replacement", async () => {
  // mattermost run 39637355358 was replaced for this suite by 39641043177, and later by 39650000000.
  const reports = [group("39641043177"), group("39650000000"), group("39640000000", "1", { name: "other-suite" })];
  await assert.rejects(() => fetchRun(groupsOnly(reports), "http://tsio", ours), (e: unknown) =>
    e instanceof SupersededRunError && e.replacement.gh_run_id === "39650000000" && e.replacement.gh_run_attempt === "1" &&
    /no group for mattermost\/mattermost beed9ae playwright-full-enterprise run 39637355358 attempt 1 .*its group now belongs to run 39650000000 attempt 1/.test(e.message));
});

test("a newer attempt of the same run supersedes it too", async () => {
  await assert.rejects(() => fetchRun(groupsOnly([group("39637355358", "2")]), "http://tsio", ours), (e: unknown) =>
    e instanceof SupersededRunError && e.replacement.gh_run_id === "39637355358" && e.replacement.gh_run_attempt === "2");
});

test("no group a newer run took is no results: an older run's group, another suite or another commit does not supersede this run", async () => {
  const older = [group("39637355357"), group("39641043177", "1", { name: "other-suite" }), group("39641043177", "1", { commit: "0000000" })];
  await assert.rejects(() => fetchRun(groupsOnly(older), "http://tsio", ours), (e: unknown) =>
    e instanceof NoResultsError && !(e instanceof SupersededRunError) && /no group for/.test(e.message));
  await assert.rejects(() => fetchRun(groupsOnly([]), "http://tsio", ours), (e: unknown) => e instanceof NoResultsError && !(e instanceof SupersededRunError));
});

test("missing reports are counted as arrived of expected, or as a bare count when the expected count is unknown", () => {
  assert.equal(missingArrived(null), null);
  assert.equal(missingArrived({ expected: 3, received: 1, status: "in_progress" }), "1 of 3 reports arrived");
  assert.equal(missingArrived({ expected: null, received: 2, status: "processing" }), "2 reports arrived (the expected count is unknown)");
});

// A TSIO that serves one group's detail, suites and cases; the list answers with the group itself.
const oneGroup = (detail: Record<string, unknown>): FetchImpl => (async (url: string) => {
  const u = String(url);
  if (u.includes("/reports?")) return Response.json({ reports: [{ ...detail, orchestration: undefined }] });
  if (u.endsWith("/suites")) return Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] });
  if (u.includes("/cases")) return Response.json([{ suite_id: "s1", title: "t1", status: "passed", retry_count: 0, ordinal: 0, error_message: null, error_stack: null }]);
  if (u.includes(`/reports/${detail.id}`)) return Response.json(detail);
  throw new Error(`unexpected ${url}`);
}) as FetchImpl;
const run40417095173 = (over: Record<string, unknown>) =>
  group("39637355358", "1", { status: "incomplete", total_reports_expected: 40, reports: Array.from({ length: 39 }, () => ({})), test_stats: { total: 1309 }, ...over });
const settled = (counts: Record<string, number>, total = 1309) => ({ status: "completed", total_units: 421, counts: { pending: 0, leased: 0, completed_pass: 419, completed_fail: 0, completed_skipped: 2, abandoned: 0, ...counts }, tests: { total } });

test("a group whose orchestration ran every unit is complete although a worker never uploaded: its units went to other workers", async () => {
  // mattermost run 40417095173: 39 of 40 reports, but all 421 units finished, so nothing is missing.
  const run = await fetchRun(oneGroup(run40417095173({ orchestration: settled({}) })), "http://tsio", ours, null, { attempts: 1, ms: 0 });
  assert.equal(run.missing, null);
});

test("a group whose orchestration left units pending, leased or abandoned is still missing reports", async () => {
  for (const left of [{ pending: 3 }, { leased: 1 }, { abandoned: 2 }] as Record<string, number>[]) {
    const run = await fetchRun(oneGroup(run40417095173({ orchestration: { ...settled(left), status: left.abandoned ? "completed" : "running" } })), "http://tsio", ours, null, { attempts: 1, ms: 0 });
    assert.deepEqual(run.missing, { expected: 40, received: 39, status: "incomplete" }, JSON.stringify(left));
  }
  const lost = await fetchRun(oneGroup(run40417095173({ orchestration: settled({}, 1320) })), "http://tsio", ours, null, { attempts: 1, ms: 0 });
  assert.deepEqual(lost.missing, { expected: 40, received: 39, status: "incomplete" }, "every unit ran, but 11 tests' results never arrived");
  const without = await fetchRun(oneGroup(run40417095173({})), "http://tsio", ours, null, { attempts: 1, ms: 0 });
  assert.deepEqual(without.missing, { expected: 40, received: 39, status: "incomplete" }, "no orchestration: the report count decides");
});

test("a re-run's report replaces the earlier attempt's of the same name: its stub no longer counts", async () => {
  // desktop#4054: shard 1/3 sent only a stub on attempt 1; its re-run uploaded passing results under the same report name.
  const shard = "e2e-on-ubuntu-latest-12.1.0-rc2-1-of-3";
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/suites")) return Response.json({ suites: [
      { id: "s-stub", file_path: "ci/tsio-shard-failure.ts", report_name: shard, report_id: "01a17e00-9600-7910-a53e-bc2c474fe7cc" },
      { id: "s-noid", file_path: "ci/tsio-shard-failure.ts", report_name: shard, report_id: null },
      { id: "s-rerun", file_path: "calls/calls_functionality.test.ts", report_name: shard, report_id: "01a17e19-e8d5-7857-a70a-cce3ce5daed6" },
      { id: "s-other", file_path: "login.test.ts", report_name: "e2e-on-ubuntu-latest-12.1.0-rc2-2-of-3", report_id: "01a17dee-ea28-0000-0000-000000000000" },
    ] });
    if (u.includes("/cases")) return Response.json([
      { suite_id: "s-stub", title: "[e2e-linux (1)] CI shard failure", status: "failed", retry_count: 0, ordinal: 0 },
      { suite_id: "s-noid", title: "[e2e-linux (1)] CI shard failure", status: "failed", retry_count: 0, ordinal: 0 },
      { suite_id: "s-rerun", title: "MM-T1", status: "passed", retry_count: 0, ordinal: 0 },
      { suite_id: "s-other", title: "MM-T2", status: "passed", retry_count: 0, ordinal: 0 },
    ]);
    return Response.json({ reports: [group(ours.gh_run_id)], total: 1 });
  }) as FetchImpl;
  const run = await fetchRun(fetchImpl, "http://tsio", ours, null, { attempts: 1, ms: 0 });
  assert.deepEqual(run.failing, []);
  assert.deepEqual(run.counts, { total: 2, passed: 2, failed: 0, flaky: 0, skipped: 0 });
});
