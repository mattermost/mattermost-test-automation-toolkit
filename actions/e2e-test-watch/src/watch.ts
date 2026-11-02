// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "../../e2e-test-triage/src/types.ts";
import type { EvaluatedRun } from "../../e2e-test-triage/src/evaluate.ts";
import { laneOf } from "../../e2e-test-triage/src/config.ts";
import { fetchHistory } from "../../e2e-test-triage/src/history.ts";
import { runFlag } from "../../e2e-test-triage/src/render.ts";
import { triage } from "../../e2e-test-triage/src/triage.ts";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { tsioBase, tsioJson } from "../../shared/src/tsio.ts";
import type { Wait } from "../../shared/src/tsio.ts";
import type { TsioId } from "../../e2e-test-triage/src/types.ts";
import { LEDGER_MS, readLedger, writeLedger } from "./ledger.ts";
import type { LedgerEntry } from "./ledger.ts";
import { DAY, HOUR, flakes, utcMinute } from "./model.ts";
import type { Group, GroupTest, Kind } from "./model.ts";
import { DEFAULT_LABEL, answerCheck, lastActivity, openedAt, prsChanging, prsTouching, repairPRs, specsInOpenPRs } from "./prs.ts";
import type { OpenPR, OpenPRs, RepairPRs } from "./prs.ts";
import { addGroup, retryRecovered, selectCrossLane, selectRepairs, selectRetryFlakes, unselected } from "./select.ts";
import { bundle, specRange, suspects, windowsOverlap } from "./range.ts";
import type { RangedGroup, WatchId } from "./range.ts";

const MAX_TESTS = 40;
const MAX_OPEN_PRS_TOUCHING = 10;
// Failing tests no request covers that the job summary names one by one; the rest are counted.
const MAX_UNSELECTED_NOTES = 10;
// How long a requested spec is left to its agent before it can be requested again.
const HOLD_MS = 24 * HOUR;
// An agent PR with no activity for longer than this stops blocking the spec it changes.
const OWN_PR_IDLE_MS = 3 * DAY;
// An agent PR open longer than this, with its spec still failing on trunk, stops blocking it too:
// review traffic keeps it active, so idleness alone can hold a red spec back for weeks. The spec is
// then requested again (no more often than STALE_PR_HOLD_MS), with the PR in open_prs_touching to judge.
const OWN_PR_MAX_AGE_MS = 2 * DAY;
// How long a spec whose only agent PRs are past OWN_PR_MAX_AGE_MS is held after a request. Longer than
// HOLD_MS: a right fix still in review leaves the spec failing too, and each request is an agent run.
const STALE_PR_HOLD_MS = 3 * DAY;
// How many times a request with no sign the agent ran it is sent again before its hold applies as usual. The
// agent's no-op outcome leaves no GitHub trace either; it stops early on a recent memory, so one more is cheap.
const MAX_RESENDS = 1;
const REPORTS_PAGE = 100;
const REPORTS_MAX_PAGES = 5;

/** One of the watched suites, as the workflow passes it: TSIO report group name, spec root, optional report prefix. */
export interface Suite {
  name: string;
  test_root: string;
  report_name?: string | null;
}

/** A TSIO report group: one suite's report of one workflow run. */
export interface ReportGroup {
  id: TsioId;
  name: string;
  branch: string;
  commit: string;
  gh_run_id: string | number | null;
  gh_run_attempt: string | number | null;
  created_at?: string | null;
  last_upload_at?: string | null;
  orchestration?: { durations?: { last_test_at?: string | null } | null } | null;
  test_stats?: { failed?: number | null } | null;
}

/** A fix request's body, as the workflow sends it to the agent. */
export interface FixPayload {
  kind: "e2e-autofix";
  commit: string;
  master_run: string;
  specs: string[];
  classification: Kind;
  suites: string[];
  tests: Omit<GroupTest, "finding">[];
  tests_omitted: number;
  last_green_commit?: string | null;
  first_red_commit?: string | null;
  suspect_commits: { sha: string; title: string; author?: string }[];
  suspect_commits_total: number;
  open_prs_touching: { number: number; title: string; url: string }[];
  labels: string[];
}

/** One spec's outcome in the job summary: sent, or the reason it was not. */
export interface Decision {
  specs: string[];
  kind: Kind;
  tests: GroupTest[];
  action: string;
}

/** A request the workflow sends, with the ledger entry `record` keeps once it is accepted. */
interface Outgoing {
  id: string;
  payload: FixPayload;
  entry: LedgerEntry;
}

/** A request as the workflow reads it from the requests file. */
export interface PlannedRequest {
  id: string;
  payload: FixPayload;
}

export interface WatchResult {
  decisions: Decision[];
  requests: PlannedRequest[];
  notes: string[];
}

export interface WatchOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
  now?: Date;
  wait?: Wait;
}

/** The TSIO report groups of one workflow run, for the suites asked for. The merge workflow tests
 * the branch named in its inputs, not the ref it was started from, so branch and commit
 * come from what the run reported rather than from the triggering event. Asked per suite
 * name, newest first, until the run's groups are passed or REPORTS_MAX_PAGES pages are read.
 *
 * A re-run attempt re-runs only the failed jobs, so a suite it didn't re-run keeps its report
 * under the earlier attempt: each suite's newest attempt up to `attempt` is the one this attempt shows.
 */
export async function runGroups(
  fetchImpl: FetchImpl,
  base: string,
  repository: string,
  runId: string | undefined,
  attempt: string,
  names: string[],
): Promise<ReportGroup[]> {
  const groups: ReportGroup[] = [];
  const ofRun = (g: ReportGroup): boolean => String(g.gh_run_id) === String(runId);
  const attemptOf = (g: ReportGroup): number => Number(g.gh_run_attempt) || 1;
  const upTo = Number(attempt) || 1;
  for (const name of names) {
    const found: ReportGroup[] = [];
    for (let page = 0; page < REPORTS_MAX_PAGES; page++) {
      const query = new URLSearchParams({ repository, name, limit: String(REPORTS_PAGE), offset: String(page * REPORTS_PAGE) });
      const { reports = [] } = await tsioJson<{ reports?: ReportGroup[] }>(fetchImpl, base, `/reports?${query}`);
      const ofPage = reports.filter((g) => g.name === name && ofRun(g) && attemptOf(g) <= upTo);
      found.push(...ofPage);
      // Found, and the page goes on to older runs: nothing of this run is further back.
      if (reports.length < REPORTS_PAGE || (ofPage.length > 0 && !ofRun(reports[reports.length - 1]))) break;
    }
    const newest = Math.max(0, ...found.map(attemptOf));
    groups.push(...found.filter((g) => attemptOf(g) === newest));
  }
  return groups;
}

/**
 * Suites this run reported failures in that the caller doesn't watch (another framework, a subpath or
 * upgrade lane): one note each, so a red trunk run with no request says where its failures went.
 */
export async function unwatchedFailures(
  fetchImpl: FetchImpl,
  base: string,
  repository: string,
  commit: string,
  runId: string | undefined,
  attempt: string,
  trunk: string,
  watched: string[],
): Promise<string[]> {
  try {
    // Every group of the commit: other runs and dispatches of it add theirs, so it can take pages.
    const reports: ReportGroup[] = [];
    let complete = false;
    for (let page = 0; page < REPORTS_MAX_PAGES && !complete; page++) {
      const query = new URLSearchParams({ repository, commit, limit: String(REPORTS_PAGE), offset: String(page * REPORTS_PAGE) });
      const { reports: rows = [] } = await tsioJson<{ reports?: ReportGroup[] }>(fetchImpl, base, `/reports?${query}`);
      reports.push(...rows);
      complete = rows.length < REPORTS_PAGE;
    }
    // Each suite's newest attempt in this run up to the one watched: a re-run's count replaces the one
    // before it, and a later attempt's is that attempt's to report.
    const latest = new Map<string, ReportGroup>();
    for (const g of reports) {
      if (String(g.gh_run_id) !== String(runId) || g.branch !== trunk || watched.includes(g.name)) continue;
      if (Number(g.gh_run_attempt) > (Number(attempt) || 1)) continue;
      const prev = latest.get(g.name);
      if (!prev || Number(g.gh_run_attempt) > Number(prev.gh_run_attempt)) latest.set(g.name, g);
    }
    const notes = [...latest.values()]
      .filter((g) => Number(g.test_stats?.failed) > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => `${g.name}: ${g.test_stats?.failed} failed in this run; not watched, so not requested`);
    if (!complete) notes.push(`suites outside the watched ones checked only in the newest ${REPORTS_MAX_PAGES * REPORTS_PAGE} groups of this commit`);
    return notes;
  } catch (e) {
    return [`suites outside the watched ones not checked for failures (${String(e).slice(0, 160)})`];
  }
}

export async function watch({ env, fetchImpl = fetch, log = console.error, now = new Date(), wait }: WatchOptions): Promise<WatchResult> {
  const base = tsioBase(env);
  const trunk = env.BRANCH || "master";
  const attempt = env.GH_RUN_ATTEMPT || "1";
  const wanted = JSON.parse(String(env.SUITES)) as Suite[];
  const groupsOfRun = await runGroups(fetchImpl, base, String(env.REPOSITORY), env.GH_RUN_ID, attempt, wanted.map((s) => s.name));
  const suites = wanted.filter((s) => groupsOfRun.some((g) => g.name === s.name && g.branch === trunk));
  const first = groupsOfRun.find((g) => g.branch === trunk);
  if (!first) {
    const seen = [...new Set(groupsOfRun.map((g) => `${g.name}@${g.branch}`))];
    const note = seen.length ? `not a ${trunk} run (${seen.join(", ")})` : `no reports for run ${env.GH_RUN_ID} in TSIO under ${wanted.map((s) => s.name).join(", ")}`;
    log(`${note}; nothing to watch`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## E2E test watch\n\n${note}; nothing to watch.\n`);
    writeOutputs(env, []);
    return { decisions: [], requests: [], notes: [note] };
  }
  const id: WatchId = { repository: String(env.REPOSITORY), commit_sha: first.commit, gh_run_id: env.GH_RUN_ID, gh_run_attempt: attempt, branch: trunk };
  const notes: string[] = [];
  // A lane the run did not report (not uploaded, or failed before reporting) can't be read, and its
  // first failures can't count toward a cross-lane break: say so instead of reading it as clean.
  for (const s of wanted) if (!suites.includes(s)) notes.push(`${s.name}: no ${trunk} report for this run; not read`);
  const groupOf = (name: string): ReportGroup => groupsOfRun.find((g) => g.name === name && g.branch === trunk)!;
  for (const s of suites) {
    const read = String(groupOf(s.name).gh_run_attempt);
    if (read !== String(attempt)) notes.push(`${s.name}: not re-run in attempt ${attempt}; read attempt ${read}`);
  }
  notes.push(...(await unwatchedFailures(fetchImpl, base, String(env.REPOSITORY), first.commit, env.GH_RUN_ID, attempt, trunk, wanted.map((s) => s.name))));
  // History for the suspect range ends with this run: later runs (a re-read of an old run, or one that
  // finished meanwhile) could show a pass newer than this failure. Per suite: one read at an earlier
  // attempt ends where that attempt did, not where a later attempt's re-run of another suite did.
  const untilOf = (name: string): string => {
    const g = groupOf(name);
    const ranAt = Math.max(...[g.created_at, g.last_upload_at, g.orchestration?.durations?.last_test_at].map((t) => Date.parse(t ?? "") || 0));
    return new Date(Math.min(now.getTime(), ranAt > 0 ? ranAt + 60e3 : now.getTime())).toISOString();
  };
  const api = gh(fetchImpl, String(env.GITHUB_TOKEN));
  const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
  const maxBrokenPerRun = Number(env.MAX_BROKEN_PER_RUN || 10);
  const maxFlakyPerDay = Number(env.MAX_FLAKY_PER_DAY || 6);
  const causeHoldMs = Number(env.CAUSE_HOLD_HOURS || 4) * HOUR;
  const answerHours = Number(env.ANSWER_HOURS || 6);
  const currentAt = Date.parse(first.created_at ?? "") || now.getTime();
  const label = env.LABEL || DEFAULT_LABEL;
  const reportNameOf = new Map<string, string | null>(suites.map((s): [string, string | null] => [s.name, s.report_name || null]));

  const groups = new Map<string, Group>();
  const bySuite: { suite: string; findings: Finding[] }[] = [];
  for (const s of suites) {
    let result: EvaluatedRun;
    try {
      result = await triage({
        // The attempt that holds this suite's report, which an attempt that didn't re-run it leaves earlier.
        env: { COMPOSITE_IDENTITY: JSON.stringify({ ...id, gh_run_attempt: String(groupOf(s.name).gh_run_attempt), name: s.name }), MODE: "report-only", TEST_ROOT: s.test_root, REPORT_NAME: s.report_name || "", TSIO_BASE_URL: base, GITHUB_TOKEN: env.GITHUB_TOKEN },
        // Classified against the history up to this run: a later trunk run must not decide this one's failures.
        fetchImpl,
        log,
        now: new Date(untilOf(s.name)),
        wait,
      });
    } catch (e) {
      notes.push(`${s.name}: not read (${String(e).slice(0, 160)})`);
      continue;
    }
    if (result.infra) {
      notes.push(`${s.name}: ${runFlag(result.infra)}, not repaired (${result.infra})`);
      continue;
    }
    bySuite.push({ suite: s.name, findings: result.findings });
    const found = selectRepairs(result, s.name);
    try {
      const groupId = groupOf(s.name).id;
      const recovered = await retryRecovered(fetchImpl, base, groupId);
      if (recovered.length) {
        const history = await fetchHistory(fetchImpl, base, id.repository, recovered, untilOf(s.name), undefined, trunk, s.report_name || null, log, laneOf(s.name));
        found.push(...selectRetryFlakes(recovered, history, { suite: s.name, testRoot: s.test_root, branch: trunk, groupId }));
      }
    } catch (e) {
      notes.push(`${s.name}: retry-recovered tests not read (${String(e).slice(0, 160)})`);
    }
    for (const g of found) addGroup(groups, g);
  }
  for (const g of selectCrossLane(bySuite)) addGroup(groups, g);
  const left = unselected(bySuite, new Set(groups.keys()));
  for (const u of left.slice(0, MAX_UNSELECTED_NOTES)) notes.push(`${u.spec} › ${u.title} (${u.suite}): ${u.reason}`);
  if (left.length > MAX_UNSELECTED_NOTES) notes.push(`${left.length - MAX_UNSELECTED_NOTES} more failing tests wait the same way`);

  const decisions: Decision[] = [];
  // What the workflow should send, each with the ledger entry `record` keeps once it is accepted.
  const out: Outgoing[] = [];
  const ledgerPath = String(env.LEDGER_PATH);
  const ledger = readLedger(ledgerPath).filter((r) => now.getTime() - Date.parse(r.at) < LEDGER_MS);
  writeLedger(ledgerPath, ledger); // pruned, and present for the cache to save even when nothing is sent
  const open: OpenPRs = groups.size ? await specsInOpenPRs(api, id.repository, { now, base: trunk }) : { files: new Map(), prs: new Map() };
  if (open.truncated) notes.push("open PRs past the newest read were not checked for overlap with these specs");
  // The agent's own PRs by label as well: an idle one drops out of specsInOpenPRs' recent window.
  let own: RepairPRs = { prs: [], files: new Map() };
  let ownUnknown: string | null = null;
  try {
    own = await repairPRs(api, id.repository, label, { base: trunk });
  } catch (e) {
    ownUnknown = String(e).slice(0, 160);
    notes.push(`the agent's own PRs not read (${ownUnknown})`);
  }
  const skip = (g: Group, action: string): void => {
    decisions.push({ specs: [g.spec], kind: g.kind, tests: g.tests, action });
  };
  // Each of the agent's PRs as the payload lists it, with when it was opened and last had activity, from either read of them.
  const agentPR = new Map<number, OpenPR>([
    ...own.prs.map((p): [number, OpenPR] => [p.number, { number: p.number, title: p.title ?? "", url: p.url, labels: [label], activeAt: lastActivity(p), openedAt: openedAt(p) }]),
    ...[...open.prs.values()].map((p): [number, OpenPR] => [p.number, p]),
  ]);
  const daysSince = (at: number): number => Math.floor((now.getTime() - at) / DAY);
  // The agent's PRs that change this exact spec: a sibling in its directory is not a reason to wait.
  const agentPRsChanging = (spec: string): number[] =>
    [...new Set([...prsChanging(open.files, spec).filter((n) => open.prs.get(n)?.labels.includes(label)), ...prsChanging(own.files, spec)])].sort((a, b) => a - b);
  // A webhook can accept a request (HTTP 200) whose agent then never starts. The agent answers each request it runs
  // on GitHub, linking the request's trunk run and naming its spec (a new PR, or a comment or review on an existing
  // one), or opens a PR on its spec. A request old enough to have an answer and with neither stops holding its specs,
  // MAX_RESENDS times.
  const answers = answerCheck(api, id.repository);
  const answeredOf = new Map<LedgerEntry, Promise<boolean>>();
  let answersUnknown: string | null = null;
  const unanswered = async (r: LedgerEntry): Promise<boolean> => {
    const at = Date.parse(r.at);
    const runId = /\/actions\/runs\/(\d+)/.exec(r.run ?? "")?.[1];
    if ((r.resent ?? 0) >= MAX_RESENDS || now.getTime() - at < answerHours * HOUR || !runId) return false;
    if ((r.specs ?? []).some((s) => agentPRsChanging(s).some((n) => (agentPR.get(n)?.openedAt ?? 0) >= at))) return false;
    let answered = answeredOf.get(r);
    if (!answered) {
      // Where the agent answers when it opens no PR: its own PRs on the specs first, then the others it was sent.
      const specs = r.specs ?? [];
      // A PR whose file list was cut off may change a spec past the files read: its texts are read too.
      const onSpecs = [...new Set([...specs.flatMap(agentPRsChanging), ...specs.flatMap((s) => prsTouching(open.files, s)), ...(open.partial ?? [])])];
      // The answer may be on a PR past the ones read: as with an incomplete search, the request holds as sent.
      if (open.truncated) {
        notes.push(`${specs.join(", ")}: open PRs past the newest read were not checked for an answer; the request of ${utcMinute(r.at)} UTC (${r.run}) holds as sent`);
        answered = Promise.resolve(true);
      } else if (onSpecs.length > MAX_OPEN_PRS_TOUCHING) {
        notes.push(`${specs.join(", ")}: ${onSpecs.length} open PRs change it, more than the ${MAX_OPEN_PRS_TOUCHING} read for an answer; the request of ${utcMinute(r.at)} UTC (${r.run}) holds as sent`);
        answered = Promise.resolve(true);
      } else answered = answers(runId, specs, onSpecs);
      answeredOf.set(r, answered);
    }
    try {
      return !(await answered);
    } catch (e) {
      // Unknown counts as answered: the request holds as sent, as it did before this check.
      if (!answersUnknown) {
        answersUnknown = String(e).slice(0, 160);
        notes.push(`requests not checked for a sign the agent ran them (${answersUnknown}); they hold as sent`);
      }
      return false;
    }
  };
  // Requests found unanswered, which hold nothing and use no flaky budget; per spec, the resend count its next request carries.
  const unansweredEntries = new Set<LedgerEntry>();
  const resentOf = new Map<string, number>();
  const staleNoted = new Set<number>();
  const candidates: (Group & { openPRs: OpenPR[] })[] = [];
  for (const g of groups.values()) {
    const prs = prsTouching(open.files, g.spec).flatMap((n) => {
      const p = open.prs.get(n);
      return p ? [p] : [];
    });
    const agentPRs = agentPRsChanging(g.spec);
    const ownPRs: number[] = [];
    for (const n of agentPRs) {
      const p = agentPR.get(n);
      const opened = p?.openedAt ?? null;
      const at = p?.activeAt ?? null;
      const stale =
        opened != null && now.getTime() - opened > OWN_PR_MAX_AGE_MS
          ? `open ${daysSince(opened)} days with the spec still failing`
          : at != null && now.getTime() - at > OWN_PR_IDLE_MS
            ? `idle ${daysSince(at)} days`
            : null;
      if (!stale) {
        ownPRs.push(n);
        continue;
      }
      if (!staleNoted.has(n)) {
        staleNoted.add(n);
        notes.push(`stalled agent PR #${n} (${stale}): not blocking new requests`);
      }
      // Listed for the agent even when it has dropped out of the recent open PRs read.
      if (p && !prs.some((x) => x.number === n)) prs.push(p);
    }
    const holdMs = agentPRs.length && !ownPRs.length ? STALE_PR_HOLD_MS : HOLD_MS;
    let held: LedgerEntry | undefined;
    const dead: LedgerEntry[] = [];
    for (const r of ledger.filter((e) => e.specs?.includes(g.spec) && now.getTime() - Date.parse(e.at) < holdMs)) {
      // Checked only where the hold decides: an unread or blocking agent PR skips the spec anyway.
      if (!ownUnknown && !ownPRs.length && (await unanswered(r))) dead.push(r);
      else {
        held = r;
        break;
      }
    }
    if (!held && dead.length) {
      const last = dead[dead.length - 1];
      const resent = Math.max(...dead.map((r) => r.resent ?? 0)) + 1;
      resentOf.set(g.spec, resent);
      for (const r of dead) unansweredEntries.add(r);
      notes.push(`${g.spec}: nothing on GitHub answers the request of ${utcMinute(last.at)} UTC (${last.run}) after ${answerHours} hours; it may not have started, so it holds nothing (resend ${resent} of ${MAX_RESENDS})`);
    }
    // Without the agent's own PRs a request may duplicate one it is already fixing: wait for the next run.
    if (ownUnknown) skip(g, "skipped: the agent's own PRs could not be read");
    else if (ownPRs.length) skip(g, `skipped: #${ownPRs.join(", #")} (${label}) already changes it`);
    else if (held) skip(g, `skipped: requested ${utcMinute(held.at)} UTC by ${held.run}`);
    else candidates.push({ ...g, openPRs: prs });
  }

  // Trunk stays red until a break is fixed, so breaks all go now. Flaky specs share a daily budget,
  // chosen before any history is read: those not requested in the last week first (so the budget
  // rotates), then the most flaky.
  const asked = (g: Group): number => ledger.filter((e) => e.specs?.includes(g.spec)).length;
  const flakyLeft = maxFlakyPerDay - ledger.filter((r) => r.kind === "flaky" && now.getTime() - Date.parse(r.at) < DAY && !unansweredEntries.has(r)).length;
  const flaky = candidates.filter((g) => g.kind === "flaky").sort((a, b) => asked(a) - asked(b) || flakes(b) - flakes(a));
  const ranged: RangedGroup[] = [];
  for (const g of [...candidates.filter((c) => c.kind === "broken"), ...flaky.slice(0, Math.max(0, flakyLeft))]) {
    const range = await specRange(fetchImpl, base, id, g, untilOf, currentAt, log, reportNameOf);
    // Without its history a break can't be bundled or held with its cause: wait for the next run.
    if (range.historyError) skip(g, `skipped: history unavailable (${range.historyError})`);
    else ranged.push({ ...g, ...range });
  }

  let brokenLeft = maxBrokenPerRun;
  const bundled = bundle(ranged);
  // bundle() orders flaky specs by flakiness; keep the budget's order.
  const order = new Map<string, number>(flaky.map((g, i): [string, number] => [g.spec, i]));
  const requests = [
    ...bundled.filter((r) => r.kind === "broken"),
    ...bundled.filter((r) => r.kind === "flaky").sort((a, b) => order.get(a.specs[0])! - order.get(b.specs[0])!),
  ];
  for (const r of requests) {
    const decision: Decision = { specs: r.specs, kind: r.kind, tests: r.tests, action: "" };
    decisions.push(decision);
    // A break whose window overlaps one handed over in the last few hours may be the same cause,
    // showing up a run later (an incomplete run, a spec that failed in one lane only). Give that
    // agent time to open its PR: then the own-PR skip, or the new agent's own check of that PR,
    // takes over. A different cause waits only those hours.
    const window = r.window;
    const sameCause =
      window &&
      ledger.find(
        // A request that never ran is no cause to wait for.
        (e) => !unansweredEntries.has(e) && e.window && now.getTime() - Date.parse(e.at) < causeHoldMs && windowsOverlap(window, { from: e.window.from ?? -Infinity, to: e.window.to }),
      );
    if (sameCause) {
      decision.action = `skipped: may be the break requested ${utcMinute(sameCause.at)} UTC (overlapping suspect commits)`;
      continue;
    }
    if (r.kind === "broken" && brokenLeft-- <= 0) {
      decision.action = `skipped: over ${maxBrokenPerRun} broken requests in one run`;
      continue;
    }
    const tests = r.tests.map(({ finding: _finding, ...t }) => t);
    const payload: FixPayload = {
      kind: "e2e-autofix",
      commit: id.commit_sha,
      master_run: runURL,
      specs: r.specs,
      classification: r.kind,
      suites: [...r.suites],
      tests: tests.slice(0, MAX_TESTS),
      tests_omitted: Math.max(0, tests.length - MAX_TESTS),
      ...(await suspects(api, id, r.range, log)),
      // Not skipped on: the agent checks whether any of these already fixes this failure.
      open_prs_touching: r.openPRs.slice(0, MAX_OPEN_PRS_TOUCHING).map(({ number, title, url }) => ({ number, title, url })),
      labels: [label, ...(env.EXTRA_LABELS ? env.EXTRA_LABELS.split(",").map((l) => l.trim()).filter(Boolean) : [])],
    };
    decision.action = "to request";
    const resent = Math.max(0, ...r.specs.map((s) => resentOf.get(s) ?? 0));
    out.push({
      id: `fix-${out.length + 1}`,
      payload,
      entry: {
        at: now.toISOString(),
        specs: r.specs,
        kind: r.kind,
        ...(r.window ? { window: { from: Number.isFinite(r.window.from) ? r.window.from : null, to: r.window.to } } : {}),
        run: runURL,
        ...(resent ? { resent } : {}),
      },
    });
  }
  for (const g of flaky.slice(Math.max(0, flakyLeft))) skip(g, `skipped: flaky budget of ${maxFlakyPerDay} a day used`);

  const lines = summaryLines({ commit: id.commit_sha, runURL, decisions, notes });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  log(lines.join("\n"));
  if (env.PENDING_PATH) {
    mkdirSync(dirname(env.PENDING_PATH), { recursive: true });
    writeFileSync(env.PENDING_PATH, JSON.stringify(out.map(({ id: rid, entry }) => ({ id: rid, entry }))));
  }
  const planned = out.map(({ id: rid, payload }) => ({ id: rid, payload }));
  writeOutputs(env, planned);
  return { decisions, requests: planned, notes };
}

/** The job summary: what each spec got, and what could not be read. */
function summaryLines({ commit, runURL, decisions, notes }: { commit: string; runURL: string; decisions: Decision[]; notes: string[] }): string[] {
  const lines = [`## E2E test watch: ${commit.slice(0, 9)} · [run](${runURL})`, ""];
  if (!decisions.length) lines.push("No failure needs a repair: nothing failed twice in a row or flaked repeatedly.");
  else {
    lines.push("| Specs | Kind | Tests | Action |", "| --- | --- | --- | --- |");
    for (const d of decisions) lines.push(`| ${d.specs.map((s) => `\`${s}\``).join("<br>")} | ${d.kind} | ${d.tests.length} | ${d.action} |`);
  }
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`));
  return lines;
}

/**
 * The requests go to a file (REQUESTS_PATH), not a step output: a big break's payloads outgrow
 * what an environment variable can carry. The workflow sends each `payload` and reports back by `id`.
 */
function writeOutputs(env: Env, requests: PlannedRequest[]): void {
  if (env.REQUESTS_PATH) {
    mkdirSync(dirname(env.REQUESTS_PATH), { recursive: true });
    writeFileSync(env.REQUESTS_PATH, JSON.stringify(requests));
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `count=${requests.length}\n`);
}

/**
 * After the workflow sent the requests: keep the accepted ones in the ledger, so the next
 * trunk run holds their specs and PRs and counts them toward the daily cap. RESULTS is
 * [{ id, status }] with each request's HTTP status (0 when it never got one).
 */
export function record({ env, now = new Date(), log = console.error }: { env: Env; now?: Date; log?: (message: string) => void }): void {
  let pending: PlannedEntry[] = [];
  try {
    pending = JSON.parse(readFileSync(env.PENDING_PATH ?? "", "utf8")) as PlannedEntry[];
  } catch {
    // Nothing planned (not a trunk run, or the plan step failed before writing it).
  }
  const results = new Map<string, number>((JSON.parse(env.RESULTS || "[]") as { id: string; status: unknown }[]).map((r) => [r.id, Number(r.status) || 0]));
  const ledgerPath = String(env.LEDGER_PATH);
  const ledger = readLedger(ledgerPath).filter((r) => now.getTime() - Date.parse(r.at) < LEDGER_MS);
  const lines: string[] = [];
  for (const p of pending) {
    const status = results.get(p.id);
    if (status !== undefined && status >= 200 && status < 300) ledger.push(p.entry);
    else lines.push(`- \`${p.id}\`: ${status == null ? "not sent" : `not accepted (HTTP ${status})`}; it will be planned again on the next trunk run`);
  }
  // Always written, so the cache keeps the record alive even on runs that send nothing.
  writeLedger(ledgerPath, ledger);
  const sent = pending.length - lines.length;
  const summary = pending.length ? [`Sent ${sent} of ${pending.length} request(s).`, ...lines] : [];
  if (summary.length && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, "\n" + summary.join("\n") + "\n");
  if (summary.length) log(summary.join("\n"));
}

/** A planned request as the plan step wrote it to PENDING_PATH. */
interface PlannedEntry {
  id: string;
  entry: LedgerEntry;
}
