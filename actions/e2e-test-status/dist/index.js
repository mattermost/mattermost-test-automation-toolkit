"use strict";

// src/publish.ts
var import_node_fs = require("fs");

// ../shared/src/github.ts
function gh(fetchImpl, token) {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "mattermost-e2e-triage" },
      body: body ? JSON.stringify(body) : void 0,
      signal: AbortSignal.timeout(6e4)
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
}

// ../shared/src/lane.ts
var laneName = (context) => String(context).replace(/^e2e(-test)?\//, "");
function namedIn(description) {
  const d = String(description ?? "");
  const count = (re) => Number(re.exec(d)?.[1] ?? 0);
  return {
    cleared: count(/(\d+) cleared by triage/) + count(/(\d+) flaky/) + count(/(\d+) broken on main/),
    caused: count(/(\d+) caused by PR/),
    outdated: count(/(\d+) out of date/),
    check: count(/(\d+) unresolved/) + count(/(\d+) needs investigation/)
  };
}
function redReason(description = "") {
  const d = String(description);
  const { cleared, caused, outdated, check } = namedIn(d);
  const parts = [];
  if (cleared) parts.push(`${cleared} cleared`);
  if (caused) parts.push(`${caused} caused by PR`);
  if (outdated) parts.push(`${outdated} out of date`);
  if (check) parts.push(`${check} to check`);
  const missing = /(\d+) report\(s\) missing/.exec(d)?.[1];
  if (missing) parts.push(`${missing} report(s) missing, re-run`);
  else if (/results incomplete/.test(d)) parts.push("results incomplete, re-run");
  else if (/re-run the failed jobs/.test(d)) parts.push("re-run the failed jobs");
  if (/environment errors, re-run/.test(d)) parts.push("environment errors, re-run");
  else if (/investigation required|many failures in one run/.test(d)) parts.push("many failures in one run");
  if (/triage could not finish/.test(d)) parts.push("triage could not finish");
  return parts.length ? parts.join(", ") : "still red";
}
function laneSummary(lanes) {
  const seen = lanes.filter((l) => Boolean(l.status));
  const waiting = seen.filter((l) => l.status.state === "pending");
  if (waiting.length) return { state: "pending", description: `Triage is checking: waiting for ${waiting.map((l) => laneName(l.context)).join(", ")}` };
  const red = seen.filter((l) => l.status.state !== "success");
  const cleared = seen.filter((l) => l.status.state === "success" && namedIn(l.status.description).cleared > 0);
  const clearedText = cleared.length ? `${cleared.map((l) => laneName(l.context)).join(", ")} cleared by triage` : "";
  if (red.length) return { state: "failure", description: [...red.map((l) => `${laneName(l.context)}: ${redReason(l.status.description)}`), clearedText].filter(Boolean).join(" \xB7 ") };
  return { state: "success", description: clearedText ? `${clearedText} \xB7 all lanes green` : "All lanes green" };
}

// ../shared/src/status.ts
var positive = (v) => /^[1-9]\d*$/.test(String(v ?? ""));
function statusOwner(target, repository) {
  try {
    const url = new URL(String(target));
    const path = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/);
    const run = url.searchParams.get("status_run_id") || (path && url.hostname === "github.com" && path[1] === repository ? path[2] : url.searchParams.get("gh_run_id"));
    const attempt = url.searchParams.get("status_run_attempt") || path?.[3] || url.searchParams.get("gh_run_attempt") || "1";
    return positive(run) && positive(attempt) ? { run: String(run), attempt: String(attempt) } : null;
  } catch {
    return null;
  }
}
function compareOwners(a, b) {
  for (const key of ["run", "attempt"]) {
    if (BigInt(a[key]) !== BigInt(b[key])) return BigInt(a[key]) > BigInt(b[key]) ? 1 : -1;
  }
  return 0;
}
var runOf = (id, env, attemptDefault) => ({
  run: String(env.GITHUB_RUN_ID || id.gh_run_id || ""),
  attempt: String(env.GITHUB_RUN_ATTEMPT || id.gh_run_attempt || attemptDefault)
});
function publishingOwner(id, env = {}) {
  const owner = runOf(id, env, "");
  if (!positive(owner.run) || !positive(owner.attempt) || owner.run !== String(id.gh_run_id)) throw new Error("Invalid status publishing run/attempt");
  return owner;
}
function ownedURL(target, owner, repository) {
  const url = new URL(target || `https://github.com/${repository}/actions/runs/${owner.run}`);
  url.searchParams.set("status_run_id", owner.run);
  url.searchParams.set("status_run_attempt", owner.attempt);
  return url.href;
}
async function readStatuses(api, id) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const rows = await api("GET", `/repos/${id.repository}/commits/${id.commit_sha}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Invalid GitHub status history");
    const batch = rows;
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error("GitHub status history truncated; refusing to publish");
}
function mayPublish(rows, id, context, owner, operation) {
  const lane = rows.filter((r) => r.context === context);
  if (!lane.length) return operation === "claim";
  const current = statusOwner(lane[0].target_url, id.repository);
  if (!current) return false;
  if (lane.some((r) => {
    const prior = statusOwner(r.target_url, id.repository);
    return prior && compareOwners(prior, owner) > 0;
  })) return false;
  if (operation === "claim") {
    return compareOwners(owner, current) > 0 || lane[0].state === "pending";
  }
  return current.run === owner.run && compareOwners(owner, current) >= 0 && (operation !== "triage" || lane[0].state !== "pending");
}
function statusPublisher({ api, id, context, env = {}, log = console.error }) {
  let validated;
  const owner = () => validated ??= publishingOwner(id, env);
  const snapshotOwner = () => {
    const snapshot = runOf(id, env, "1");
    if (!positive(snapshot.run) || !positive(snapshot.attempt)) throw new Error("Invalid status publishing run/attempt");
    return snapshot;
  };
  const allowed = async (operation) => {
    const rows = await readStatuses(api, id);
    const ok = mayPublish(rows, id, context, owner(), operation);
    if (!ok) log(`Status ${context} belongs to another run/attempt or has no known owner; publication skipped`);
    return ok;
  };
  const post = (row, by = owner()) => api("POST", `/repos/${id.repository}/statuses/${id.commit_sha}`, {
    ...row,
    description: row.description.slice(0, 140),
    target_url: ownedURL(row.target_url, by, id.repository)
  });
  const summarize = async (lanes, summaryContext, summarizeLanes) => {
    if (!summaryContext || !lanes.length) return;
    if (lanes.includes(summaryContext)) throw new Error("The aggregate must not be a required lane");
    const rows = await readStatuses(api, id);
    const latest = lanes.map((lane) => ({ context: lane, status: rows.find((r) => r.context === lane) ?? null }));
    if (!latest.some((lane) => lane.status)) return;
    await post({ ...summarizeLanes(latest), context: summaryContext }, snapshotOwner());
  };
  return {
    allowed,
    // Human verification workflows preserve the tested run's owner when they
    // override a failure. Under the same SHA mutex they can project the latest
    // statuses without claiming a lane or pretending to be its test run.
    summarize,
    async write(row, operation = "finish") {
      if (!await allowed(operation)) return false;
      await post({ ...row, context });
      return true;
    },
    async info(row) {
      if (!await allowed("triage")) return false;
      await post(row);
      return true;
    },
    async refresh(lanes, summaryContext, summarizeLanes) {
      if (!summaryContext || !lanes.includes(context) || !await allowed("finish")) return;
      await summarize(lanes, summaryContext, summarizeLanes);
    }
  };
}

// ../shared/src/tsio.ts
var FAILED_STATUSES = /* @__PURE__ */ new Set(["failed", "timedOut", "interrupted"]);
var elsewhereKey = (file, title) => JSON.stringify([String(file ?? "").replace(/\\/g, "/"), String(title ?? "").replace(/\\/g, "/")]);
async function tsioJson(fetchImpl, base, path) {
  const res = await fetchImpl(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(6e4) });
  if (!res.ok) throw new Error(`TSIO GET ${path}: ${res.status}`);
  return await res.json();
}
var DEFAULT_TSIO_BASE_URL = "https://test-io.test.mattermost.com";
var STAGING_TSIO_BASE_URL = "https://staging-test-io.test.mattermost.com";
var withoutTrailingSlash = (url) => url.replace(/\/$/, "");
function tsioBase(env) {
  if ((env.USE_STAGING ?? "").trim().toLowerCase() === "true") {
    const configured = env.TSIO_BASE_URL;
    if (configured && withoutTrailingSlash(configured) !== STAGING_TSIO_BASE_URL)
      throw new Error(
        `use-staging is true, which targets ${STAGING_TSIO_BASE_URL}, but tsio-base-url is ${configured}; set one of them, not both`
      );
    return STAGING_TSIO_BASE_URL;
  }
  return withoutTrailingSlash(env.TSIO_BASE_URL || DEFAULT_TSIO_BASE_URL);
}
function outcomeWithDuplicates(attempts, reportOf = () => null) {
  const outcome = outcomeOf(attempts);
  if (outcome.status !== "flaky") return outcome;
  const duplicateFail = attempts.find((f) => FAILED_STATUSES.has(f.status) && attempts.some((a) => a !== f && a.retry_count === f.retry_count && reportOf(a) === reportOf(f) && !FAILED_STATUSES.has(a.status) && a.status !== "skipped"));
  return duplicateFail ? { status: duplicateFail.status, last: duplicateFail } : outcome;
}
function outcomeOf(attempts) {
  const ran = attempts.filter((a) => a.status !== "skipped");
  if (!ran.length) return { status: "skipped", last: attempts.at(-1) };
  const failed = ran.filter((a) => FAILED_STATUSES.has(a.status));
  const lastFailed = failed.at(-1);
  if (lastFailed && failed.length === ran.length) return { status: lastFailed.status, last: lastFailed };
  return { status: failed.length || ran.some((a) => a.status === "flaky") ? "flaky" : "passed", last: ran.at(-1) };
}
var identityKey = (t) => JSON.stringify([t.report_scope ?? "", t.file, t.full_title || t.title]);
function compositeIdentityFrom(raw) {
  if (raw == null || raw.trim() === "") throw new Error("COMPOSITE_IDENTITY is missing; the action needs the run's identity as JSON");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`COMPOSITE_IDENTITY is not valid JSON: ${String(e).slice(0, 120)}`);
  }
}
var newerRun = (a, b) => {
  const run = BigInt(a.gh_run_id) - BigInt(b.gh_run_id);
  return run !== BigInt(0) ? run > BigInt(0) : BigInt(a.gh_run_attempt) > BigInt(b.gh_run_attempt);
};
var SupersededRunError = class extends Error {
  replacement;
  constructor(message, replacement) {
    super(message);
    this.name = "SupersededRunError";
    this.replacement = replacement;
  }
};
var NoResultsError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "NoResultsError";
  }
};
async function fetchRun(fetchImpl, base, id, reportName = null, wait = { attempts: 6, ms: 2e4 }) {
  const q = new URLSearchParams({ repository: id.repository, commit: id.commit_sha, name: String(id.name), limit: "20" });
  const { reports: groups = [] } = await tsioJson(fetchImpl, base, `/reports?${q}`);
  return runFromGroups(fetchImpl, base, id, groups, reportName, wait);
}
async function runFromGroups(fetchImpl, base, id, groups, reportName = null, wait = { attempts: 6, ms: 2e4 }) {
  const get = (path) => tsioJson(fetchImpl, base, path);
  const runId = String(id.gh_run_id ?? "");
  const attempt = String(id.gh_run_attempt ?? "");
  if (!runId || !attempt)
    throw new Error(`composite identity is missing gh_run_id or gh_run_attempt; refusing to guess which run to read (run_id=${runId || "-"} attempt=${attempt || "-"})`);
  const group = groups.find(
    (g) => g.repository === id.repository && g.commit === id.commit_sha && g.name === id.name && String(g.gh_run_id) === runId && String(g.gh_run_attempt) === attempt
  );
  if (!group) {
    const noGroup = `TSIO returned no group for ${id.repository} ${id.commit_sha.slice(0, 7)} ${id.name} run ${runId} attempt ${attempt} (of ${groups.length} row(s) returned)`;
    const newest = /^\d+$/.test(runId) && /^\d+$/.test(attempt) ? groups.filter((g) => g.repository === id.repository && g.commit === id.commit_sha && g.name === id.name).map((g) => ({
      gh_run_id: String(g.gh_run_id),
      gh_run_attempt: String(g.gh_run_attempt),
      gh_pr_number: g.gh_pr_number === void 0 ? void 0 : g.gh_pr_number === null || String(g.gh_pr_number) === "" ? null : String(g.gh_pr_number),
      branch: g.branch === void 0 ? void 0 : g.branch
    })).filter((r) => /^\d+$/.test(r.gh_run_id) && /^\d+$/.test(r.gh_run_attempt) && newerRun(r, { gh_run_id: runId, gh_run_attempt: attempt })).reduce((best, r) => !best || newerRun(r, best) ? r : best, null) : null;
    if (newest)
      throw new SupersededRunError(`${noGroup}; its group now belongs to run ${newest.gh_run_id} attempt ${newest.gh_run_attempt}`, newest);
    throw new NoResultsError(noGroup);
  }
  let missing = null;
  if (group.status !== "completed") {
    let detail = group;
    for (let i = 0; i < wait.attempts && detail.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, wait.ms));
      detail = await get(`/reports/${group.id}`);
    }
    if (detail.status !== "completed") {
      const expected = Number(detail.total_reports_expected ?? group.total_reports_expected) || null;
      const received = Array.isArray(detail.reports) ? detail.reports.length : null;
      missing = { expected, received, status: detail.status };
    }
  }
  const [{ suites = [] }, cases] = await Promise.all([
    get(`/reports/${group.id}/suites`),
    get(`/reports/${group.id}/cases`)
  ]);
  const fileOf = new Map(suites.map((s) => [s.id, s.file_path ?? s.file ?? ""]));
  const reportOf = new Map(suites.map((s) => [s.id, s.report_name ?? null]));
  const suiteTitleOf = new Map(suites.map((s) => [s.id, s.title ?? ""]));
  const perReport = /* @__PURE__ */ new Map();
  for (const c of cases) {
    const report = reportOf.get(c.suite_id) ?? "";
    const identity = elsewhereKey(fileOf.get(c.suite_id) ?? "", c.full_title || c.title);
    const key = JSON.stringify([report, identity]);
    if (!perReport.has(key)) perReport.set(key, { report, identity, attempts: [] });
    perReport.get(key).attempts.push(c);
  }
  const elsewhere = /* @__PURE__ */ new Map();
  for (const { report, identity, attempts } of perReport.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    const { status } = outcomeWithDuplicates(attempts, (a) => reportOf.get(a.suite_id) ?? null);
    if (!elsewhere.has(identity)) elsewhere.set(identity, []);
    elsewhere.get(identity).push({ report, status });
  }
  const scoped = reportName ? new Set(suites.filter((s) => String(s.report_name ?? "").startsWith(reportName)).map((s) => s.id)) : null;
  if (scoped && scoped.size === 0)
    throw new Error(`no report in group ${group.id} has a name starting with "${reportName}" (of ${new Set(suites.map((s) => s.report_name)).size} report name(s) present)`);
  const byTest = /* @__PURE__ */ new Map();
  for (const c of cases) {
    if (scoped && !scoped.has(c.suite_id)) continue;
    const k = c.full_title ? JSON.stringify([scoped ? reportOf.get(c.suite_id) ?? "" : "", fileOf.get(c.suite_id) ?? "", c.full_title]) : JSON.stringify([c.suite_id, c.title]);
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k).push(c);
  }
  const testsPerLeaf = /* @__PURE__ */ new Map();
  const testsPerIdentity = /* @__PURE__ */ new Map();
  for (const [key, attempts] of byTest) {
    const c = attempts[0];
    const file = fileOf.get(c.suite_id);
    if (!file)
      throw new Error(`group ${group.id} has case rows without a suite file path; the run cannot be read reliably`);
    const leaf = JSON.stringify([file, c.title]);
    const identity = identityKey({ file, title: c.title, full_title: c.full_title, report_scope: reportName });
    for (const [map, k] of [[testsPerLeaf, leaf], [testsPerIdentity, identity]]) {
      if (!map.has(k)) map.set(k, /* @__PURE__ */ new Set());
      map.get(k).add(key);
    }
  }
  if (byTest.size === 0)
    throw new Error(`group ${group.id} reported no test cases${reportName ? ` for report "${reportName}"` : ""}; an empty result is not a passing run`);
  const failing = [];
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  const outcomes = /* @__PURE__ */ new Map();
  for (const attempts of byTest.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    const { status, last } = outcomeWithDuplicates(attempts, (a) => reportOf.get(a.suite_id) ?? null);
    const lastAttempt = last;
    outcomes.set(JSON.stringify([fileOf.get(lastAttempt.suite_id) ?? "", lastAttempt.title]), status);
    if (FAILED_STATUSES.has(status)) {
      failed++;
      const { suite_id: suiteId, title } = lastAttempt;
      const file = fileOf.get(suiteId) ?? "";
      failing.push({
        file,
        title,
        full_title: lastAttempt.full_title ?? null,
        suite_title: suiteTitleOf.get(suiteId) ?? null,
        report_name: reportOf.get(suiteId),
        report_scope: reportName,
        identity_ambiguous: testsPerLeaf.get(JSON.stringify([file, title])).size > 1,
        identity_unresolved: testsPerIdentity.get(identityKey({ file, title, full_title: lastAttempt.full_title, report_scope: reportName })).size > 1,
        error: [lastAttempt.error_message, lastAttempt.error_stack].filter(Boolean).join("\n"),
        tries: { ran: attempts.filter((a) => a.status !== "skipped").length, failed: attempts.filter((a) => FAILED_STATUSES.has(a.status)).length }
      });
    } else if (status === "skipped") skipped++;
    else if (status === "flaky") flaky++;
  }
  return { group_id: group.id, failing, missing, outcomes, elsewhere, counts: { total: byTest.size, passed: byTest.size - failed - skipped, failed, flaky, skipped } };
}

// src/publish.ts
function reportWait(env) {
  if (env.EXECUTION_SUCCESS !== "true") return { attempts: 0, ms: 0 };
  const seconds = Number(env.REPORT_WAIT_SECONDS ?? 120);
  const ms = 2e4;
  return { attempts: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1e3 / ms) : 0, ms };
}
async function publish({ env, fetchImpl = fetch, log = console.error, wait }) {
  if (env.CANCELLED === "true") return false;
  const id = compositeIdentityFrom(env.COMPOSITE_IDENTITY);
  const operation = env.OPERATION || "finish";
  if (!["claim", "finish", "refresh", "summarize"].includes(operation)) throw new Error("Invalid status operation");
  if (operation === "finish") tsioBase(env);
  if (!env.STATUS_CONTEXT || !env.GITHUB_TOKEN) throw new Error("Status context and GitHub token are required");
  const publisher = statusPublisher({ api: gh(fetchImpl, env.GITHUB_TOKEN), id, context: env.STATUS_CONTEXT, env, log });
  let written = false;
  let state = env.STATUS_STATE ?? "";
  let reportsComplete = false;
  if (operation !== "refresh" && operation !== "summarize") {
    if (!["pending", "success", "failure", "error"].includes(state)) throw new Error("Invalid status state");
    let description = env.STATUS_DESCRIPTION || "E2E results unavailable";
    if (operation === "finish" && env.VERIFY_REPORTS === "true") {
      try {
        const base = tsioBase(env);
        const run = await fetchRun(fetchImpl, base, id, null, wait ?? reportWait(env));
        reportsComplete = !run.missing;
        if (state === "success" && run.counts.failed > 0) {
          state = "failure";
          description = "E2E reports contain failed tests";
        }
      } catch (e) {
        log(`report completeness could not be verified: ${String(e).slice(0, 300)}`);
      }
      if (!reportsComplete || env.EXECUTION_SUCCESS !== "true") {
        state = "failure";
        description = !reportsComplete ? "E2E reports unavailable or incomplete; re-run the failed jobs" : "E2E upstream execution failed; re-run the failed jobs";
      }
    }
    written = await publisher.write({ state, description, target_url: env.TARGET_URL }, operation);
  }
  const lanes = String(env.TRIAGE_LANES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (operation === "summarize") await publisher.summarize(lanes, env.TRIAGE_CONTEXT, laneSummary);
  if (written || operation === "refresh") await publisher.refresh(lanes, env.TRIAGE_CONTEXT, laneSummary);
  if (env.GITHUB_OUTPUT) (0, import_node_fs.appendFileSync)(env.GITHUB_OUTPUT, `published=${written}
state=${state || ""}
reports_complete=${reportsComplete}
`);
  return written;
}

// src/index.ts
publish({ env: process.env }).catch((e) => {
  console.error(String(e));
  process.exit(1);
});
