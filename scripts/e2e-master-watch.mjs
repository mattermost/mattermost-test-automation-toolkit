#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/**
 * E2E master watch: after a trunk E2E run, decide which failures need a fix and
 * write the requests for a fixing agent. It never calls the agent itself: the
 * consuming workflow sends each request (for example to a Cursor automation
 * webhook), then `record` notes which were accepted, so this stays repo-agnostic
 * and no agent credentials reach it.
 *
 * The decision is the triage engine's, on the trunk run itself (no AI):
 *   broken  BROKEN_ON_TRUNK: failed in this run and the previous one  -> repair
 *   flaky   FLAKY_ON_TRUNK: failed now and at least MIN_FLAKY times before -> repair
 *   flaky   failed and then passed on retry now, and failed or flaked on trunk
 *           at least MIN_FLAKY times before                            -> repair
 *   new     failed for the first time                                 -> wait for the next run
 *   infra   the run failed for environmental reasons                  -> report only
 * Broken specs that last passed on the same commit most likely share a cause and
 * go to one agent together; each flaky spec goes alone. A spec is skipped when an
 * open PR changes it or its directory, or when it was requested within HOLD_HOURS
 * (its agent is still working). Requests are capped per run and per day.
 *
 * The agent also owns the PRs it opened: an open PR with its label that now
 * conflicts with trunk gets a conflict request, so the agent merges trunk in and
 * re-verifies, once per PR head within HOLD_HOURS.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compactError, FAILED_STATUSES, fetchHistory, gh, identityKey, laneOf, outcomeOf, repoPath, triage } from "./e2e-triage.mjs";

export const DEFAULT_LABEL = "e2e-autofix";
const HOUR = 3600e3;
const MAX_TESTS = 40;

/** Which failures in a trunk triage result need a repair, grouped by spec file. */
export function selectRepairs(result, suite, { minFlaky = 1 } = {}) {
  const bySpec = new Map();
  for (const f of result.findings) {
    // trunk counts exclude this run, so minFlaky 1 means this failure plus one before it.
    const kind = f.class === "BROKEN_ON_TRUNK" ? "broken"
      : f.class === "FLAKY_ON_TRUNK" && f.trunk.fails + f.trunk.flaky >= minFlaky ? "flaky"
      : null;
    if (!kind || f.identity_unresolved) continue;
    const spec = f.repo_path ?? f.file;
    if (!bySpec.has(spec)) bySpec.set(spec, { spec, kind, suites: new Set(), tests: [] });
    const g = bySpec.get(spec);
    if (kind === "broken") g.kind = "broken";
    g.suites.add(suite);
    g.tests.push({ spec, title: f.title, full_title: f.full_title ?? null, error: compactError(f.error, 600), trunk: f.trunk, finding: f });
  }
  return [...bySpec.values()];
}

/**
 * Tests that failed and then passed on retry in one run. The triage engine counts them as
 * passed, so a test that flakes on trunk but always recovers would otherwise never be seen.
 */
export async function retryRecovered(fetchImpl, base, groupId) {
  const get = async (path) => {
    const res = await fetchImpl(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`TSIO GET ${path}: ${res.status}`);
    return res.json();
  };
  const [{ suites = [] }, cases] = await Promise.all([get(`/reports/${groupId}/suites`), get(`/reports/${groupId}/cases`)]);
  const fileOf = new Map(suites.map((s) => [s.id, s.file_path ?? s.file ?? ""]));
  const byTest = new Map();
  for (const c of cases) {
    const k = c.full_title ? JSON.stringify([fileOf.get(c.suite_id) ?? "", c.full_title]) : JSON.stringify([c.suite_id, c.title]);
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k).push(c);
  }
  // A name two tests share can't be matched to its own history.
  const perIdentity = new Map();
  for (const attempts of byTest.values()) {
    const key = identityKey({ file: fileOf.get(attempts[0].suite_id), title: attempts[0].title, full_title: attempts[0].full_title });
    perIdentity.set(key, (perIdentity.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const attempts of byTest.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || (a.ordinal ?? 0) - (b.ordinal ?? 0));
    if (outcomeOf(attempts).status !== "flaky") continue;
    const failed = attempts.find((a) => FAILED_STATUSES.has(a.status)) ?? attempts[0];
    const file = fileOf.get(failed.suite_id) ?? "";
    const test = { file, title: failed.title, full_title: failed.full_title ?? null, error: [failed.error_message, failed.error_stack].filter(Boolean).join("\n") };
    if (file && perIdentity.get(identityKey(test)) === 1) out.push(test);
  }
  return out;
}

/** Retry-recovered tests that also failed or flaked in an earlier trunk run, grouped by spec file. */
export function selectRetryFlakes(tests, history, { suite, testRoot, branch, groupId, minFlaky = 1 }) {
  const bySpec = new Map();
  for (const t of tests) {
    if (history.ambiguous?.has(identityKey(t))) continue;
    const trunk = (history.get(identityKey(t)) ?? []).filter((o) => o.group_id !== groupId && o.branch === branch && (o.gh_pr_number == null || o.gh_pr_number === "") && o.status !== "skipped");
    const fails = trunk.filter((o) => FAILED_STATUSES.has(o.status)).length;
    const flaky = trunk.filter((o) => o.status === "flaky").length;
    if (fails + flaky < minFlaky) continue;
    const spec = repoPath(testRoot, t.file) ?? t.file;
    if (!bySpec.has(spec)) bySpec.set(spec, { spec, kind: "flaky", suites: new Set([suite]), tests: [] });
    bySpec.get(spec).tests.push({
      spec, title: t.title, full_title: t.full_title, error: compactError(t.error, 600),
      trunk: { runs: trunk.length, fails, flaky, passes: trunk.filter((o) => o.status === "passed").length, latest: trunk[0]?.status ?? "", recovered_on_retry_now: true },
      finding: t,
    });
  }
  return [...bySpec.values()];
}

const OPEN_PRS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt files(first: 100) { pageInfo { hasNextPage } nodes { path } } }
    }
  }
}`;

/**
 * Files changed by every open PR updated in the last `days` days, with the PR numbers.
 * All of them, not the newest few: a busy repository has hundreds open.
 */
export async function specsInOpenPRs(api, repository, { days = 14, now = new Date(), maxPages = 20 } = {}) {
  const since = now.getTime() - days * 24 * HOUR;
  const [owner, name] = repository.split("/");
  const touched = new Map();
  const add = (path, number) => touched.set(path, [...(touched.get(path) ?? []), number]);
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await api("POST", "/graphql", { query: OPEN_PRS, variables: { owner, name, after } });
    if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
    const prs = res.data.repository.pullRequests;
    for (const p of prs.nodes) {
      if (Date.parse(p.updatedAt) < since) return touched;
      for (const f of p.files.nodes) add(f.path, p.number);
      // Over 100 files: the rest from REST, up to 300 in all.
      for (let filesPage = 2; p.files.pageInfo.hasNextPage && filesPage <= 3; filesPage++) {
        const files = await api("GET", `/repos/${repository}/pulls/${p.number}/files?per_page=100&page=${filesPage}`);
        for (const f of files) add(f.filename, p.number);
        if (files.length < 100) break;
      }
    }
    if (!prs.pageInfo.hasNextPage) break;
    after = prs.pageInfo.endCursor;
  }
  return touched;
}

/** Open PRs that change the spec, or any other file in its directory (a restructure, a shared helper). */
export function prsTouching(touched, spec) {
  const dir = spec.slice(0, spec.lastIndexOf("/") + 1);
  const prs = new Set();
  for (const [file, numbers] of touched) {
    const sameDir = dir && file.startsWith(dir) && !file.slice(dir.length).includes("/");
    if (file === spec || sameDir) for (const n of numbers) prs.add(n);
  }
  return [...prs].sort((a, b) => a - b);
}

/** The agent's PRs (by label) opened since `since`: the daily cap's fallback when the request record is lost. */
export async function repairsOpenedSince(api, repository, since, label = DEFAULT_LABEL) {
  const q = encodeURIComponent(`repo:${repository} is:pr label:${label} created:>=${since.toISOString().slice(0, 10)}`);
  return (await api("GET", `/search/issues?q=${q}&per_page=1`)).total_count ?? 0;
}

/**
 * Requests sent by earlier runs, persisted between runs by the action's cache: a fix
 * request is { at, specs, run }, a conflict request { at, pr, head, run }.
 */
export function readLedger(path) {
  if (!path) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")).requests ?? [];
  } catch {
    return [];
  }
}

function writeLedger(path, requests) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ requests }, null, 1));
}

/**
 * Where a spec's failing tests last all passed on trunk (the oldest of their last
 * passes) and where the first of them failed after that. Null when a test has not
 * passed on trunk within the history window: its break is older than what we can see.
 */
export function rangeOf(history, tests, branch) {
  const at = (o) => Date.parse(o.created_at) || 0;
  let green = null;
  let red = null;
  for (const t of tests) {
    // Newest first; trunk rows only, since history also carries other PRs' runs.
    const rows = (history.get(identityKey(t)) ?? []).filter((o) => o.branch === branch && (o.gh_pr_number == null || o.gh_pr_number === ""));
    const i = rows.findIndex((o) => o.status === "passed");
    if (i < 0) return null;
    const firstFail = rows.slice(0, i).findLast((o) => FAILED_STATUSES.has(o.status));
    if (!green || at(rows[i]) < at(green)) green = rows[i];
    if (firstFail && (!red || at(firstFail) < at(red))) red = firstFail;
  }
  return green ? { green, red } : null;
}

async function specRange(fetchImpl, base, id, group, until, log) {
  try {
    const tests = group.tests.map((t) => t.finding);
    const history = await fetchHistory(fetchImpl, base, id.repository, tests, until, undefined, id.branch, null, log, laneOf([...group.suites][0]));
    return rangeOf(history, tests, id.branch);
  } catch (e) {
    log(`history for ${group.spec} unavailable: ${String(e).slice(0, 200)}`);
    return null;
  }
}

/** The commits from the last green one up to the first red one, oldest first: the cause is usually near the start. */
async function suspects(api, id, range, log) {
  if (!range) return { last_green_commit: null, first_red_commit: null, suspect_commits: [], suspect_commits_total: 0 };
  const head = range.red?.commit_sha ?? id.commit_sha;
  try {
    const cmp = await api("GET", `/repos/${id.repository}/compare/${range.green.commit_sha}...${head}`);
    return {
      last_green_commit: range.green.commit_sha,
      first_red_commit: head,
      suspect_commits: (cmp.commits ?? []).slice(0, 30).map((c) => ({ sha: c.sha.slice(0, 9), title: c.commit.message.split("\n")[0], author: c.author?.login ?? c.commit.author?.name })),
      suspect_commits_total: cmp.total_commits ?? (cmp.commits ?? []).length,
    };
  } catch (e) {
    log(`compare ${range.green.commit_sha}...${head} unavailable: ${String(e).slice(0, 200)}`);
    return { last_green_commit: range.green.commit_sha, first_red_commit: head, suspect_commits: [], suspect_commits_total: 0 };
  }
}

/** Broken specs that last passed on the same commit go together; everything else alone. Broken first. */
export function bundle(groups) {
  const requests = [];
  const byGreen = new Map();
  for (const g of groups) {
    const key = g.kind === "broken" && g.range ? g.range.green.commit_sha : null;
    const r = key && byGreen.get(key);
    if (r) {
      r.specs.push(g.spec);
      for (const s of g.suites) r.suites.add(s);
      r.tests.push(...g.tests);
      const red = g.range.red;
      if (red && (!r.range.red || Date.parse(red.created_at) < Date.parse(r.range.red.created_at))) r.range = { ...r.range, red };
      continue;
    }
    const req = { specs: [g.spec], kind: g.kind, suites: new Set(g.suites), tests: [...g.tests], range: g.range };
    if (key) byGreen.set(key, req);
    requests.push(req);
  }
  // Broken first; among flaky ones, the one that flaked most on trunk first.
  const flakes = (r) => r.tests.reduce((n, t) => n + (t.trunk?.fails ?? 0) + (t.trunk?.flaky ?? 0), 0);
  return requests.sort((a, b) => (a.kind === b.kind ? (a.kind === "flaky" ? flakes(b) - flakes(a) : 0) : a.kind === "broken" ? -1 : 1));
}

const REPAIR_PRS = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 30) {
    nodes { ... on PullRequest { number url headRefName headRefOid mergeable } }
  }
}`;

/** The agent's open PRs (by label) whose branch no longer merges cleanly into trunk. */
export async function conflictedRepairPRs(api, repository, label = DEFAULT_LABEL) {
  const res = await api("POST", "/graphql", { query: REPAIR_PRS, variables: { q: `repo:${repository} is:pr is:open label:${label}` } });
  if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
  // UNKNOWN means GitHub has not computed it yet: the next trunk run looks again.
  return (res.data?.search?.nodes ?? []).filter((p) => p?.mergeable === "CONFLICTING");
}

/**
 * The TSIO groups of one workflow run. The merge workflow tests the branch named
 * in its inputs, not the ref it was started from, so branch and commit come from
 * what the run reported rather than from the triggering event.
 */
export async function runGroups(fetchImpl, base, repository, runId, attempt) {
  const res = await fetchImpl(`${base}/api/v1/reports?${new URLSearchParams({ repository, limit: "200" })}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`TSIO GET /reports: ${res.status}`);
  return ((await res.json()).reports ?? []).filter((g) => String(g.gh_run_id) === String(runId) && String(g.gh_run_attempt) === String(attempt));
}

export async function watch({ env, fetchImpl = fetch, log = console.error, now = new Date(), wait } = {}) {
  const base = (env.TSIO_BASE_URL || "https://test-io.test.mattermost.com").replace(/\/$/, "");
  const trunk = env.BRANCH || "master";
  const attempt = env.GH_RUN_ATTEMPT || "1";
  const wanted = JSON.parse(env.SUITES);
  const groupsOfRun = await runGroups(fetchImpl, base, env.REPOSITORY, env.GH_RUN_ID, attempt);
  const suites = wanted.filter((s) => groupsOfRun.some((g) => g.name === s.name && g.branch === trunk));
  const first = groupsOfRun.find((g) => g.branch === trunk);
  if (!first) {
    log(`run ${env.GH_RUN_ID} reported no ${trunk} suites (${[...new Set(groupsOfRun.map((g) => `${g.name}@${g.branch}`))].join(", ") || "none"}); nothing to watch`);
    writeOutputs(env, []);
    return { decisions: [], conflicts: [], requests: [], notes: ["not a trunk run"] };
  }
  const id = { repository: env.REPOSITORY, commit_sha: first.commit, gh_run_id: env.GH_RUN_ID, gh_run_attempt: attempt, branch: trunk };
  // History for the suspect range ends with this run: later runs (a re-read of an old run, or one that
  // finished meanwhile) could show a pass newer than this failure.
  const ranAt = Math.max(...groupsOfRun.filter((g) => g.branch === trunk).flatMap((g) => [g.created_at, g.last_upload_at, g.orchestration?.durations?.last_test_at].map((t) => Date.parse(t) || 0)));
  const until = new Date(Math.min(now.getTime(), ranAt > 0 ? ranAt + 60e3 : now.getTime())).toISOString();
  const api = gh(fetchImpl, env.GITHUB_TOKEN);
  const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
  const maxPerRun = Number(env.MAX_PER_RUN || 2);
  const maxPerDay = Number(env.MAX_PER_DAY || 5);
  const holdMs = Number(env.HOLD_HOURS || 24) * HOUR;
  const label = env.LABEL || DEFAULT_LABEL;

  const groups = new Map();
  const notes = [];
  for (const s of suites) {
    let result;
    try {
      result = await triage({
        env: { COMPOSITE_IDENTITY: JSON.stringify({ ...id, name: s.name }), MODE: "report-only", TEST_ROOT: s.test_root, REPORT_NAME: s.report_name || "", TSIO_BASE_URL: base, GITHUB_TOKEN: env.GITHUB_TOKEN },
        fetchImpl, log, now, wait,
      });
    } catch (e) {
      notes.push(`${s.name}: not read (${String(e).slice(0, 160)})`);
      continue;
    }
    if (result.infra) {
      notes.push(`${s.name}: infrastructure, not repaired (${result.infra})`);
      continue;
    }
    const found = selectRepairs(result, s.name, { minFlaky: Number(env.MIN_FLAKY || 1) });
    try {
      const groupId = groupsOfRun.find((g) => g.name === s.name && g.branch === trunk).id;
      const recovered = await retryRecovered(fetchImpl, base, groupId);
      if (recovered.length) {
        const history = await fetchHistory(fetchImpl, base, id.repository, recovered, until, undefined, trunk, s.report_name || null, log, laneOf(s.name));
        found.push(...selectRetryFlakes(recovered, history, { suite: s.name, testRoot: s.test_root, branch: trunk, groupId, minFlaky: Number(env.MIN_FLAKY || 1) }));
      }
    } catch (e) {
      notes.push(`${s.name}: retry-recovered tests not read (${String(e).slice(0, 160)})`);
    }
    for (const g of found) {
      const prev = groups.get(g.spec);
      if (!prev) groups.set(g.spec, g);
      else {
        prev.kind = prev.kind === "broken" || g.kind === "broken" ? "broken" : "flaky";
        for (const x of g.suites) prev.suites.add(x);
        for (const t of g.tests) if (!prev.tests.some((p) => (p.full_title || p.title) === (t.full_title || t.title))) prev.tests.push(t);
      }
    }
  }

  const decisions = [];
  // What the workflow should send, each with the ledger entry `record` keeps once it is accepted.
  const out = [];
  const instructions = env.INSTRUCTIONS ? { instructions: env.INSTRUCTIONS } : {};
  const ledger = readLedger(env.LEDGER_PATH).filter((r) => now.getTime() - Date.parse(r.at) < 7 * 24 * HOUR);
  writeLedger(env.LEDGER_PATH, ledger); // pruned, and present for the cache to save even when nothing is sent
  const touched = groups.size ? await specsInOpenPRs(api, id.repository, { now }) : new Map();
  const ready = [];
  for (const g of groups.values()) {
    const prs = prsTouching(touched, g.spec);
    const held = ledger.find((r) => r.specs?.includes(g.spec) && now.getTime() - Date.parse(r.at) < holdMs);
    if (prs.length) decisions.push({ specs: [g.spec], kind: g.kind, tests: g.tests, action: `skipped: #${prs.join(", #")} changes it or its directory` });
    else if (held) decisions.push({ specs: [g.spec], kind: g.kind, tests: g.tests, action: `skipped: requested ${held.at.slice(0, 16).replace("T", " ")} UTC by ${held.run}` });
    else ready.push({ ...g, range: await specRange(fetchImpl, base, id, g, until, log) });
  }

  const requests = bundle(ready);
  const sentToday = ledger.filter((r) => r.specs && now.getTime() - Date.parse(r.at) < 24 * HOUR).length;
  const openedToday = requests.length ? await repairsOpenedSince(api, id.repository, new Date(now.getTime() - 24 * HOUR), label) : 0;
  let budget = Math.min(maxPerRun, maxPerDay - Math.max(sentToday, openedToday));
  for (const r of requests) {
    const decision = { specs: r.specs, kind: r.kind, tests: r.tests };
    decisions.push(decision);
    if (budget <= 0) {
      decision.action = "skipped: over the repair cap";
      continue;
    }
    budget--;
    const tests = r.tests.map(({ finding, ...t }) => t);
    const payload = {
      kind: "e2e-autofix",
      repository: id.repository, branch: id.branch, commit: id.commit_sha, master_run: runURL,
      specs: r.specs, classification: r.kind, suites: [...r.suites],
      tests: tests.slice(0, MAX_TESTS), tests_omitted: Math.max(0, tests.length - MAX_TESTS),
      ...(await suspects(api, id, r.range, log)),
      ...instructions,
      labels: [label, ...(env.EXTRA_LABELS ? env.EXTRA_LABELS.split(",").map((l) => l.trim()).filter(Boolean) : [])],
    };
    decision.payload = payload;
    decision.action = "to request";
    out.push({ id: `fix-${out.length + 1}`, payload, entry: { at: now.toISOString(), specs: r.specs, run: runURL } });
  }

  // The repair PRs the automation opened are its own to keep mergeable: a trunk merge that
  // conflicts with one goes back to it, once per PR head within the hold.
  const conflicts = [];
  try {
    for (const pr of (await conflictedRepairPRs(api, id.repository, label)).slice(0, Number(env.MAX_CONFLICTS_PER_RUN || 2))) {
      const held = ledger.find((r) => r.pr === pr.number && r.head === pr.headRefOid && now.getTime() - Date.parse(r.at) < holdMs);
      const c = { pr: pr.number, url: pr.url };
      conflicts.push(c);
      if (held) {
        c.action = `skipped: sent ${held.at.slice(0, 16).replace("T", " ")} UTC for this head`;
        continue;
      }
      c.payload = {
        kind: "e2e-autofix-conflict",
        repository: id.repository, branch: id.branch, master_run: runURL,
        pr: pr.number, pr_url: pr.url, pr_branch: pr.headRefName, pr_head: pr.headRefOid,
        ...instructions,
      };
      c.action = "to send back";
      out.push({ id: `conflict-${pr.number}`, payload: c.payload, entry: { at: now.toISOString(), pr: pr.number, head: pr.headRefOid, run: runURL } });
    }
  } catch (e) {
    notes.push(`repair PRs not checked for conflicts (${String(e).slice(0, 160)})`);
  }

  const lines = [`## E2E master watch: ${id.commit_sha.slice(0, 9)} · [run](${runURL})`, ""];
  if (!decisions.length) lines.push("No failure needs a repair: nothing failed twice in a row or flaked repeatedly.");
  else {
    lines.push("| Specs | Kind | Tests | Action |", "| --- | --- | --- | --- |");
    for (const d of decisions) lines.push(`| ${d.specs.map((s) => `\`${s}\``).join("<br>")} | ${d.kind} | ${d.tests.length} | ${d.action} |`);
  }
  if (conflicts.length) {
    lines.push("", "Fix PRs in conflict with trunk:", "", "| PR | Action |", "| --- | --- |");
    for (const c of conflicts) lines.push(`| [#${c.pr}](${c.url}) | ${c.action} |`);
  }
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  log(lines.join("\n"));
  if (env.PENDING_PATH) {
    mkdirSync(dirname(env.PENDING_PATH), { recursive: true });
    writeFileSync(env.PENDING_PATH, JSON.stringify(out.map(({ id: rid, entry }) => ({ id: rid, entry }))));
  }
  const planned = out.map(({ id: rid, payload }) => ({ id: rid, payload }));
  writeOutputs(env, planned);
  return { decisions, conflicts, requests: planned, notes };
}

function writeOutputs(env, requests) {
  // One line of JSON: the workflow sends each `payload` and reports back by `id`.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `requests=${JSON.stringify(requests)}\ncount=${requests.length}\n`);
}

/**
 * After the workflow sent the requests: keep the accepted ones in the ledger, so the next
 * trunk run holds their specs and PRs and counts them toward the daily cap. RESULTS is
 * [{ id, status }] with each request's HTTP status (0 when it never got one).
 */
export function record({ env, now = new Date(), log = console.error } = {}) {
  let pending = [];
  try {
    pending = JSON.parse(readFileSync(env.PENDING_PATH, "utf8"));
  } catch {
    // Nothing planned (not a trunk run, or the plan step failed before writing it).
  }
  const results = new Map(JSON.parse(env.RESULTS || "[]").map((r) => [r.id, Number(r.status) || 0]));
  const ledger = readLedger(env.LEDGER_PATH).filter((r) => now.getTime() - Date.parse(r.at) < 7 * 24 * HOUR);
  const lines = [];
  for (const p of pending) {
    const status = results.get(p.id);
    if (status >= 200 && status < 300) ledger.push(p.entry);
    else lines.push(`- \`${p.id}\`: ${status == null ? "not sent" : `not accepted (HTTP ${status})`}; it will be planned again on the next trunk run`);
  }
  // Always written, so the cache keeps the record alive even on runs that send nothing.
  writeLedger(env.LEDGER_PATH, ledger);
  const sent = pending.length - lines.length;
  const summary = pending.length ? [`Sent ${sent} of ${pending.length} request(s).`, ...lines] : [];
  if (summary.length && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, "\n" + summary.join("\n") + "\n");
  if (summary.length) log(summary.join("\n"));
  return { sent, failed: lines.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv[2] === "record" ? Promise.resolve().then(() => record({ env: process.env })) : watch({ env: process.env })).catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
