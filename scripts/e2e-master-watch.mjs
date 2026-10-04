#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/**
 * E2E master watch: after a trunk E2E run, decide which failures need a fix and
 * hand them to a repair agent (a Cursor automation webhook).
 *
 * The decision is the triage engine's, on the trunk run itself (no AI):
 *   broken  BROKEN_ON_TRUNK: failed in this run and the previous one  -> repair
 *   flaky   FLAKY_ON_TRUNK: failed now and at least MIN_FLAKY times before -> repair
 *   new     failed for the first time                                 -> wait for the next run
 *   infra   the run failed for environmental reasons                  -> report only
 * Broken specs that last passed on the same commit most likely share a cause and
 * go to one agent together; each flaky spec goes alone. A spec is skipped when an
 * open PR changes it or its directory, or when it was requested within HOLD_HOURS
 * (its agent is still working). Requests are capped per run and per day. Without
 * a webhook URL it only reports.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compactError, FAILED_STATUSES, fetchHistory, gh, identityKey, laneOf, triage } from "./e2e-triage.mjs";

export const LABEL = "e2e-master-repair";
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

/** Repair PRs (by label) opened since `since`: the daily cap's fallback when the request record is lost. */
export async function repairsOpenedSince(api, repository, since) {
  const q = encodeURIComponent(`repo:${repository} is:pr label:${LABEL} created:>=${since.toISOString().slice(0, 10)}`);
  return (await api("GET", `/search/issues?q=${q}&per_page=1`)).total_count ?? 0;
}

/** Requests sent by earlier runs ({ at, specs, run }), persisted between runs by the action's cache. */
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
  return requests.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "broken" ? -1 : 1));
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
    return { decisions: [], notes: ["not a trunk run"] };
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
    for (const g of selectRepairs(result, s.name, { minFlaky: Number(env.MIN_FLAKY || 1) })) {
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
  const ledger = readLedger(env.LEDGER_PATH).filter((r) => now.getTime() - Date.parse(r.at) < 7 * 24 * HOUR);
  writeLedger(env.LEDGER_PATH, ledger); // pruned, and present for the cache to save even when nothing is sent
  const touched = groups.size ? await specsInOpenPRs(api, id.repository, { now }) : new Map();
  const ready = [];
  for (const g of groups.values()) {
    const prs = prsTouching(touched, g.spec);
    const held = ledger.find((r) => r.specs.includes(g.spec) && now.getTime() - Date.parse(r.at) < holdMs);
    if (prs.length) decisions.push({ specs: [g.spec], kind: g.kind, tests: g.tests, action: `skipped: #${prs.join(", #")} changes it or its directory` });
    else if (held) decisions.push({ specs: [g.spec], kind: g.kind, tests: g.tests, action: `skipped: requested ${held.at.slice(0, 16).replace("T", " ")} UTC by ${held.run}` });
    else ready.push({ ...g, range: await specRange(fetchImpl, base, id, g, until, log) });
  }

  const requests = bundle(ready);
  const sentToday = ledger.filter((r) => now.getTime() - Date.parse(r.at) < 24 * HOUR).length;
  const openedToday = requests.length ? await repairsOpenedSince(api, id.repository, new Date(now.getTime() - 24 * HOUR)) : 0;
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
      kind: "e2e-master-repair",
      repository: id.repository, branch: id.branch, commit: id.commit_sha, master_run: runURL,
      specs: r.specs, classification: r.kind, suites: [...r.suites],
      tests: tests.slice(0, MAX_TESTS), tests_omitted: Math.max(0, tests.length - MAX_TESTS),
      ...(await suspects(api, id, r.range, log)),
      instructions: env.INSTRUCTIONS || ".cursor/automations/e2e-master-repair.md",
      labels: [LABEL, ...(env.EXTRA_LABELS ? env.EXTRA_LABELS.split(",").map((l) => l.trim()).filter(Boolean) : [])],
    };
    decision.payload = payload;
    if (!env.CURSOR_WEBHOOK_URL) {
      decision.action = "would request a repair (no webhook configured)";
      continue;
    }
    const res = await fetchImpl(env.CURSOR_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CURSOR_WEBHOOK_KEY ?? ""}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    decision.action = res.ok ? "repair requested" : `repair request failed: HTTP ${res.status}`;
    if (res.ok) {
      // Written at once, so a crash later in this run cannot lose a request that was sent.
      ledger.push({ at: now.toISOString(), specs: r.specs, run: runURL });
      writeLedger(env.LEDGER_PATH, ledger);
    }
  }

  const lines = [`## E2E master watch: ${id.commit_sha.slice(0, 9)} · [run](${runURL})`, ""];
  if (!decisions.length) lines.push("No failure needs a repair: nothing failed twice in a row or flaked repeatedly.");
  else {
    lines.push("| Specs | Kind | Tests | Action |", "| --- | --- | --- | --- |");
    for (const d of decisions) lines.push(`| ${d.specs.map((s) => `\`${s}\``).join("<br>")} | ${d.kind} | ${d.tests.length} | ${d.action} |`);
  }
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  log(lines.join("\n"));
  return { decisions, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  watch({ env: process.env }).catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
