// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitStatus, Env, FetchImpl, GhApi } from "../../shared/src/github.ts";
import { laneSummary } from "../../shared/src/lane.ts";
import { mayPublish, ownedURL, publishingOwner, readStatuses, statusOwner, statusPublisher } from "../../shared/src/status.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { publish, reportWait } from "./publish.ts";

const id: CompositeIdentity = { repository: "o/r", commit_sha: "same-tested-sha", gh_run_id: "20", gh_run_attempt: "1" };
const lane = "e2e-test/playwright-full/enterprise";
const other = "e2e-test/cypress-full/enterprise";
const lanes = [lane, other];
const owner = { run: "20", attempt: "1" };
const status = (run: string, attempt = "1", state = "pending", context = lane): CommitStatus => ({
  context, state, description: state,
  target_url: `https://test-io.test.mattermost.com/reports/r/pr-1/abc/playwright?gh_run_id=${run}&gh_run_attempt=${attempt}`,
});
function fixture(initial: CommitStatus[] = []) {
  const rows: CommitStatus[] = [...initial];
  const posts: unknown[] = [];
  const api: GhApi = async (method, path, body) => {
    if (method === "GET") {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
      return rows.slice((page - 1) * 100, page * 100);
    }
    posts.push(body); rows.unshift(body as CommitStatus); return body;
  };
  const fetchImpl: FetchImpl = async (url, init) => Response.json(await api(init?.method ?? "", new URL(url).pathname + new URL(url).search, init?.body ? JSON.parse(String(init.body)) : undefined));
  const writer = (run = "20", attempt = "1", context = lane, extra: Env = {}) => statusPublisher({ api, id: { ...id, gh_run_id: run }, context, env: { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, ...extra }, log: () => {} });
  return { rows, posts, api, fetchImpl, writer };
}
test("owner is tested-run identity, independent of workflow ref and source SHA", async () => {
  const f = fixture();
  const old = f.writer("10", "1", lane, { GITHUB_SHA: "master-source", GITHUB_REF: "refs/heads/master" });
  const fresh = f.writer("20", "1", lane, { GITHUB_SHA: "pr-source", GITHUB_REF: "refs/heads/pr" });
  assert.equal(await old.write({ state: "pending", description: "old" }, "claim"), true);
  assert.equal(await fresh.write({ state: "pending", description: "new" }, "claim"), true);
  assert.equal(await fresh.write({ state: "success", description: "new success" }), true);
  assert.equal(await old.write({ state: "failure", description: "cancelled old report" }), false);
  assert.equal(await old.write({ state: "pending", description: "late old begin" }, "claim"), false);
  assert.equal(f.rows[0].state, "success");
});
test("current genuine failure and missing/incomplete report remain red", async () => {
  for (const state of ["failure", "error"]) {
    const f = fixture([status("20")]);
    assert.equal(await f.writer().write({ state, description: "missing or failed tests" }), true);
    assert.equal(f.rows[0].state, state);
  }
});
test("stale triage cannot clear a current pending status", async () => {
  const f = fixture([status("20")]);
  assert.equal(await f.writer("10").write({ state: "success", description: "old cleared" }, "triage"), false);
  assert.equal(await f.writer().write({ state: "success", description: "raw report not finished" }, "triage"), false);
  assert.equal(f.rows[0].state, "pending");
});
test("new attempt may finish original reports; old attempts and older rerun IDs cannot overwrite it", async () => {
  const f = fixture([status("20", "1", "failure")]);
  const report = f.rows[0].target_url;
  assert.equal(await f.writer("20", "2").write({ state: "success", description: "rerun", target_url: report }), true);
  assert.deepEqual(statusOwner(f.rows[0].target_url, "o/r"), { run: "20", attempt: "2" });
  assert.equal(new URL(f.rows[0].target_url ?? "").searchParams.get("gh_run_attempt"), "1", "report still links to original diagnostic attempt");
  assert.equal(await f.writer("20", "1").write({ state: "failure", description: "late attempt 1" }), false);
  assert.equal(await f.writer("10", "99").write({ state: "pending", description: "old run rerun" }, "claim"), false);
  assert.equal(await f.writer("20", "2").write({ state: "pending", description: "duplicate begin" }, "claim"), false);
});
test("current unknown owners fail closed, old unknown history does not prevent migration", () => {
  const unknown = { ...status("10"), target_url: "https://example.test/manual-override" };
  assert.equal(mayPublish([unknown], id, lane, owner, "claim"), false);
  assert.equal(mayPublish([status("10"), unknown], id, lane, owner, "claim"), true);
  assert.equal(mayPublish([status("10"), status("30")], id, lane, owner, "claim"), false, "a legacy late overwrite cannot hide a newer owner");
  assert.equal(mayPublish([], id, lane, owner, "finish"), false);
});
test("legacy URLs, large run IDs and publishing identity validation", () => {
  assert.deepEqual(statusOwner("https://github.com/o/r/actions/runs/9007199254740993", "o/r"), { run: "9007199254740993", attempt: "1" });
  assert.deepEqual(statusOwner("https://github.com/o/r/actions/runs/20/attempts/3", "o/r"), { run: "20", attempt: "3" });
  assert.equal(statusOwner("nonsense", "o/r"), null);
  assert.throws(() => publishingOwner(id, { GITHUB_RUN_ID: "99" }), /Invalid/);
  assert.deepEqual(statusOwner(ownedURL("", owner, "o/r"), "o/r"), owner);
});
test("all pages are checked and truncated or failed reads never write", async () => {
  const f = fixture([...Array.from({ length: 100 }, () => status("1", "1", "success", other)), status("30")]);
  assert.equal(await f.writer().write({ state: "pending", description: "older" }, "claim"), false);
  assert.equal(f.posts.length, 0);
  await assert.rejects(readStatuses(async () => Array.from({ length: 100 }, () => status("1")), id), /truncated/);
  const writer = statusPublisher({ api: async () => { throw new Error("API unavailable"); }, id, context: lane });
  await assert.rejects(writer.write({ state: "success", description: "test" }), /unavailable/);
});
test("suites and editions own independent statuses; aggregate is refreshed from every lane", async () => {
  const f = fixture([status("30", "1", "success", other)]);
  assert.equal(await f.writer().write({ state: "pending", description: "start" }, "claim"), true);
  await f.writer().refresh(lanes, "e2e-test/triage", laneSummary);
  assert.equal(f.rows[0].state, "pending");
  assert.equal(await f.writer().write({ state: "success", description: "passed" }), true);
  await f.writer().refresh(lanes, "e2e-test/triage", laneSummary);
  assert.equal(f.rows[0].state, "success", "newer Cypress run doesn't block current Playwright summary");
  const fips = f.writer("40", "1", "e2e-test/playwright-full/fips");
  await fips.write({ state: "failure", description: "fips" }, "claim");
  const n = f.posts.length;
  await fips.refresh(lanes, "e2e-test/triage", laneSummary);
  assert.equal(f.posts.length, n, "FIPS must not mutate the enterprise aggregate");
});
test("new pending, clean result and raw failure replace an existing all-green aggregate", async () => {
  const f = fixture([status("10", "1", "success"), status("10", "1", "success", other)]);
  const env = { COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_TOKEN: "fake", STATUS_CONTEXT: lane, TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(","), OPERATION: "claim", STATUS_STATE: "pending" };
  for (const [operation, state] of [["claim", "pending"], ["finish", "success"], ["finish", "failure"]]) {
    await publish({ env: { ...env, OPERATION: operation, STATUS_STATE: state }, fetchImpl: f.fetchImpl });
    assert.equal(f.rows[0].context, "e2e-test/triage");
    assert.equal(f.rows[0].state, state);
  }
});
test("cancelled publication preserves statuses and does not even read GitHub", async () => {
  assert.equal(await publish({ env: { CANCELLED: "true" }, fetchImpl: () => { throw new Error("should not fetch"); } }), false);
});
test("finishing a summary verifies execution and exact-run reports before allowing green", async (t) => {
  const cases = [
    { name: "passing summary after upload failure with missing shard", execution: "false", groupStatus: "in_progress", expected: "failure", complete: false },
    { name: "passing summary after upload failure even if reports arrived", execution: "false", expected: "failure", complete: true },
    { name: "passing summary with incomplete report group", groupStatus: "in_progress", expected: "failure", complete: false },
    { name: "passing summary with absent group", absent: true, expected: "failure", complete: false },
    { name: "passing summary with another run on the same SHA", reportRun: "19", expected: "failure", complete: false },
    { name: "passing summary with another report attempt", reportAttempt: "2", expected: "failure", complete: false },
    { name: "passing summary with empty reports", empty: true, expected: "failure", complete: false },
    { name: "passing summary with unavailable reports", unavailable: true, expected: "failure", complete: false },
    { name: "passing summary contradicted by failed report cases", failed: true, expected: "failure", complete: true },
    { name: "genuine current test failure stays red", summary: "failure", failed: true, expected: "failure", complete: true },
    { name: "complete reports never promote failed summary", summary: "failure", expected: "failure", complete: true },
    { name: "unknown upstream result fails closed", execution: "", expected: "failure", complete: true },
    { name: "complete successful current run passes", expected: "success", complete: true },
    { name: "report job rerun verifies original reports and publishes new attempt", publishingAttempt: "2", expected: "success", complete: true },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const f = fixture([status("20"), status("20", "1", "success", other)]);
    const dir = mkdtempSync(join(tmpdir(), "status-complete-"));
    try {
      const output = join(dir, "output");
      const identity = { ...id, name: "playwright-full" };
      const group = { id: "g1", repository: id.repository, commit: id.commit_sha, name: identity.name, gh_run_id: c.reportRun || "20", gh_run_attempt: c.reportAttempt || "1", status: c.groupStatus || "completed", total_reports_expected: 2, reports: c.groupStatus ? [{}] : [{}, {}] };
      const fetchImpl: FetchImpl = async (url, init) => {
        if (new URL(url).origin === "https://api.github.com") return f.fetchImpl(url, init);
        assert.equal(new URL(url).origin, "https://staging-tsio.example", "must use the dispatcher's selected backend");
        if (c.unavailable) return new Response("unavailable", { status: 503 });
        if (String(url).includes("/reports?")) return Response.json({ reports: c.absent ? [] : [group] });
        if (String(url).endsWith("/suites")) return Response.json({ suites: [{ id: "s1", file_path: "a.spec.ts" }] });
        if (String(url).endsWith("/cases")) return Response.json(c.empty ? [] : [{ suite_id: "s1", title: "test", status: c.failed ? "failed" : "passed", retry_count: 0, ordinal: 0 }]);
        if (String(url).endsWith("/reports/g1")) return Response.json(group);
        throw new Error(`Unexpected request ${url}`);
      };
      await publish({ env: {
        COMPOSITE_IDENTITY: JSON.stringify(identity), GITHUB_TOKEN: "fake", STATUS_CONTEXT: lane,
        STATUS_STATE: c.summary || "success", STATUS_DESCRIPTION: "All orchestration units passed",
        VERIFY_REPORTS: "true", EXECUTION_SUCCESS: c.execution ?? "true", TSIO_BASE_URL: "https://staging-tsio.example",
        GITHUB_OUTPUT: output, GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: c.publishingAttempt || "1",
        TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(","),
      }, fetchImpl, wait: { attempts: 1, ms: 0 }, log: () => {} });
      assert.equal(f.rows.find((r) => r.context === lane)?.state, c.expected);
      assert.equal(f.rows[0].state, c.expected, "the aggregate must reflect the validated raw result");
      assert.match(readFileSync(output, "utf8"), new RegExp(`reports_complete=${c.complete}\\n`));
      assert.match(readFileSync(output, "utf8"), new RegExp(`state=${c.expected}\\n`));
      assert.deepEqual(statusOwner(f.rows.find((r) => r.context === lane)?.target_url, id.repository), { run: "20", attempt: c.publishingAttempt || "1" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
test("serialized publishers keep check-and-write indivisible, including aggregate refresh", async () => {
  const f = fixture([status("10")]);
  let tail: Promise<void> = Promise.resolve();
  const serialized = (fn: () => Promise<void>): Promise<void> => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  await Promise.all([
    serialized(async () => { await f.writer("20").write({ state: "pending", description: "new" }, "claim"); await f.writer("20").refresh(lanes, "e2e-test/triage", laneSummary); }),
    serialized(async () => { await f.writer("20").write({ state: "success", description: "new" }); await f.writer("20").refresh(lanes, "e2e-test/triage", laneSummary); }),
    serialized(async () => { assert.equal(await f.writer("10").write({ state: "failure", description: "late old" }), false); await f.writer("10").refresh(lanes, "e2e-test/triage", laneSummary); }),
  ]);
  assert.equal(f.rows[0].state, "success");
  assert.equal(f.rows.find((r) => r.context === lane)?.state, "success");
});

test("human verification snapshot preserves lane owners and current pending", async () => {
  const f = fixture([status("20", "1", "pending"), status("10", "1", "success", other)]);
  const before = structuredClone(f.rows);
  await publish({ env: {
    COMPOSITE_IDENTITY: JSON.stringify({ ...id, gh_run_id: "99" }), GITHUB_TOKEN: "fake",
    STATUS_CONTEXT: "e2e-test/triage", OPERATION: "summarize",
    TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(","),
  }, fetchImpl: f.fetchImpl });
  assert.equal(f.rows[0].context, "e2e-test/triage");
  assert.equal(f.rows[0].state, "pending");
  assert.deepEqual(f.rows.slice(1), before, "snapshot must not claim or modify a required lane");
  // The verification workflow is its own run: it names the tested run in the identity.
  const verifier = fixture([status("20", "1", "failure"), status("10", "1", "success", other)]);
  const lanesBefore = structuredClone(verifier.rows);
  await publish({ env: {
    COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_RUN_ID: "500", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "fake",
    STATUS_CONTEXT: "e2e-test/triage", OPERATION: "summarize",
    TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(","),
  }, fetchImpl: verifier.fetchImpl });
  assert.equal(verifier.rows[0].context, "e2e-test/triage");
  assert.match(verifier.rows[0].target_url ?? "", /status_run_id=500&status_run_attempt=2/);
  assert.deepEqual(verifier.rows.slice(1), lanesBefore, "the verifier's snapshot leaves the lanes alone");
  // It still cannot write a lane as if it were the tested run.
  await assert.rejects(statusPublisher({ api: verifier.api, id, context: lane, env: { GITHUB_RUN_ID: "500" } }).write({ state: "success", description: "x" }), /Invalid status publishing run\/attempt/);
  const empty = fixture();
  await empty.writer().summarize(lanes, "e2e-test/triage", laneSummary);
  assert.equal(empty.posts.length, 0, "no vacuous all-green status");
  await assert.rejects(f.writer().summarize(lanes, lane, laneSummary), /aggregate must not be a required lane/);
});

test("a serialized verifier cannot replace a new run's pending status with an old success", async () => {
  const f = fixture([status("10", "1", "failure")]);
  // The real verification workflows hold the same lock across this read/write.
  const old = f.rows[0];
  if (old.state === "failure") await f.api("POST", "/repos/o/r/statuses/same-tested-sha", { ...old, state: "success", description: "verified" });
  await f.writer("20").write({ state: "pending", description: "new" }, "claim");
  const current = f.rows[0];
  if (current.state === "failure") await f.api("POST", "/repos/o/r/statuses/same-tested-sha", { ...current, state: "success" });
  assert.equal(f.rows[0].state, "pending");
  assert.equal(await f.writer("20").write({ state: "failure", description: "current real failure" }), true);
  assert.equal(f.rows[0].state, "failure");
});

test("finish waits for late uploads only when the lane can still pass, and no longer than asked", () => {
  assert.deepEqual(reportWait({ EXECUTION_SUCCESS: "true" }), { attempts: 6, ms: 20000 }, "two minutes by default");
  assert.deepEqual(reportWait({ EXECUTION_SUCCESS: "true", REPORT_WAIT_SECONDS: "20" }), { attempts: 1, ms: 20000 });
  assert.deepEqual(reportWait({ EXECUTION_SUCCESS: "true", REPORT_WAIT_SECONDS: "0" }), { attempts: 0, ms: 20000 });
  assert.equal(reportWait({ EXECUTION_SUCCESS: "false", REPORT_WAIT_SECONDS: "120" }).attempts, 0, "a failed worker makes the lane red: don't hold the lock waiting");
  assert.equal(reportWait({}).attempts, 0);
});
test("a status context absent from TRIAGE_LANES never writes the triage aggregate, on finish or refresh", async () => {
  const absent = "e2e-test/cypress-full/fips";
  const f = fixture([status("10", "1", "success", other)]);
  const env = { COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_TOKEN: "fake", STATUS_CONTEXT: absent, TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(",") };
  await publish({ env: { ...env, OPERATION: "finish", STATUS_STATE: "failure" }, fetchImpl: f.fetchImpl });
  await publish({ env: { ...env, OPERATION: "refresh" }, fetchImpl: f.fetchImpl });
  assert.equal(f.posts.some((p) => (p as { context?: string }).context === "e2e-test/triage"), false, "no aggregate write");
  assert.equal(f.rows.filter((r) => r.context === "e2e-test/triage").length, 0);
});
test("use-staging true with a conflicting tsio-base-url stops publication before any GitHub call", async () => {
  await assert.rejects(
    publish({
      env: { COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_TOKEN: "fake", STATUS_CONTEXT: lane, USE_STAGING: "true", TSIO_BASE_URL: "https://test-io.test.mattermost.com", OPERATION: "finish", STATUS_STATE: "success" },
      fetchImpl: () => { throw new Error("should not fetch"); },
    }),
    /use-staging/,
  );
});
test("a conflicting use-staging stops finish, which reads TSIO, but not claim, refresh or summarize, which read none", async () => {
  const conflict = { USE_STAGING: "true", TSIO_BASE_URL: "https://test-io.test.mattermost.com" };
  const base = { COMPOSITE_IDENTITY: JSON.stringify(id), GITHUB_TOKEN: "fake", STATUS_CONTEXT: lane, TRIAGE_CONTEXT: "e2e-test/triage", TRIAGE_LANES: lanes.join(",") };
  const f = fixture();
  assert.equal(await publish({ env: { ...base, ...conflict, OPERATION: "claim", STATUS_STATE: "pending", GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1" }, fetchImpl: f.fetchImpl }), true, "a claim publishes");
  await publish({ env: { ...base, ...conflict, OPERATION: "refresh" }, fetchImpl: f.fetchImpl });
  await publish({ env: { ...base, ...conflict, OPERATION: "summarize", GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1" }, fetchImpl: f.fetchImpl });
  assert.equal(f.rows[0].state, "pending", "the claim was written");
  for (const verify of [{}, { VERIFY_REPORTS: "true" }]) {
    await assert.rejects(
      publish({ env: { ...base, ...conflict, OPERATION: "finish", STATUS_STATE: "success", ...verify }, fetchImpl: () => { throw new Error("should not fetch"); } }),
      /use-staging/,
      JSON.stringify(verify),
    );
  }
});
test("an invalid COMPOSITE_IDENTITY is named before any GitHub call", async () => {
  await assert.rejects(
    publish({ env: { COMPOSITE_IDENTITY: "{bad", GITHUB_TOKEN: "fake", STATUS_CONTEXT: lane, OPERATION: "claim", STATUS_STATE: "pending" }, fetchImpl: () => { throw new Error("should not fetch"); } }),
    /COMPOSITE_IDENTITY is not valid JSON/,
  );
});
