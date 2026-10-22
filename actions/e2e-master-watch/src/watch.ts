// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "../../e2e-triage/src/types.ts";
import type { EvaluatedRun } from "../../e2e-triage/src/evaluate.ts";
import { laneOf } from "../../e2e-triage/src/config.ts";
import { fetchHistory } from "../../e2e-triage/src/history.ts";
import { triage } from "../../e2e-triage/src/triage.ts";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { tsioBase } from "../../shared/src/tsio.ts";
import type { Wait } from "../../shared/src/tsio.ts";
import type { TsioId } from "../../e2e-triage/src/types.ts";
import { LEDGER_MS, readLedger, writeLedger } from "./ledger.ts";
import type { LedgerEntry } from "./ledger.ts";
import { DAY, HOUR, flakes, utcMinute } from "./model.ts";
import type { Group, GroupTest, Kind } from "./model.ts";
import { DEFAULT_LABEL, conflictedRepairPRs, lastActivity, prsChanging, prsTouching, repairPRs, specsInOpenPRs } from "./prs.ts";
import type { OpenPR, OpenPRs, RepairPRs } from "./prs.ts";
import { addGroup, retryRecovered, selectCrossLane, selectRepairs, selectRetryFlakes } from "./select.ts";
import { bundle, specRange, suspects, windowsOverlap } from "./range.ts";
import type { RangedGroup, WatchId } from "./range.ts";

export { DEFAULT_LABEL } from "./prs.ts";

const MAX_TESTS = 40;
const MAX_OPEN_PRS_TOUCHING = 10;

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
}

/** A fix request's body, as the workflow sends it to the agent. */
export interface FixPayload {
  kind: "e2e-autofix";
  repository: string;
  branch: string;
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
  instructions?: string;
  labels: string[];
}

/** A conflict request's body: one of the agent's PRs no longer merges into trunk. */
export interface ConflictPayload {
  kind: "e2e-autofix-conflict";
  repository: string;
  branch: string;
  master_run: string;
  pr: number;
  pr_url: string;
  pr_branch: string;
  pr_head: string;
  instructions?: string;
}

export type Payload = FixPayload | ConflictPayload;

/** One spec's outcome in the job summary: sent, or the reason it was not. */
export interface Decision {
  specs: string[];
  kind: Kind;
  tests: GroupTest[];
  action: string;
  payload?: FixPayload;
}

/** One of the agent's PRs in conflict with trunk, with its outcome. */
export interface ConflictRow {
  pr: number;
  url: string;
  action?: string;
  payload?: ConflictPayload;
}

/** A request the workflow sends, with the ledger entry `record` keeps once it is accepted. */
interface Outgoing {
  id: string;
  payload: Payload;
  entry: LedgerEntry;
}

/** A request as the workflow reads it from the requests file. */
export interface PlannedRequest {
  id: string;
  payload: Payload;
}

export interface WatchResult {
  decisions: Decision[];
  conflicts: ConflictRow[];
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
 * name, newest first, until the run's groups are passed or `maxPages` pages are read.
 */
export async function runGroups(
  fetchImpl: FetchImpl,
  base: string,
  repository: string,
  runId: string | undefined,
  attempt: string,
  names: string[],
  { pageSize = 100, maxPages = 5 }: { pageSize?: number; maxPages?: number } = {},
): Promise<ReportGroup[]> {
  const groups: ReportGroup[] = [];
  const ofRun = (g: ReportGroup): boolean => String(g.gh_run_id) === String(runId) && String(g.gh_run_attempt) === String(attempt);
  for (const name of names) {
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ repository, name, limit: String(pageSize), offset: String(page * pageSize) });
      const res = await fetchImpl(`${base}/api/v1/reports?${query}`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`TSIO GET /reports (${name}): ${res.status}`);
      const reports = ((await res.json()) as { reports?: ReportGroup[] }).reports ?? [];
      const found = reports.filter((g) => g.name === name && ofRun(g));
      groups.push(...found);
      // Found, and the page goes on to older runs: nothing of this run is further back.
      if (reports.length < pageSize || (found.length > 0 && !ofRun(reports[reports.length - 1]))) break;
    }
  }
  return groups;
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
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## E2E master watch\n\n${note}; nothing to watch.\n`);
    writeOutputs(env, []);
    return { decisions: [], conflicts: [], requests: [], notes: [note] };
  }
  const id: WatchId = { repository: String(env.REPOSITORY), commit_sha: first.commit, gh_run_id: env.GH_RUN_ID, gh_run_attempt: attempt, branch: trunk };
  const notes: string[] = [];
  // A lane the run did not report (not uploaded, or failed before reporting) can't be read, and its
  // first failures can't count toward a cross-lane break: say so instead of reading it as clean.
  for (const s of wanted) if (!suites.includes(s)) notes.push(`${s.name}: no ${trunk} report for this run; not read`);
  // History for the suspect range ends with this run: later runs (a re-read of an old run, or one that
  // finished meanwhile) could show a pass newer than this failure.
  const ranAt = Math.max(
    ...groupsOfRun.filter((g) => g.branch === trunk).flatMap((g) => [g.created_at, g.last_upload_at, g.orchestration?.durations?.last_test_at].map((t) => Date.parse(t ?? "") || 0)),
  );
  const until = new Date(Math.min(now.getTime(), ranAt > 0 ? ranAt + 60e3 : now.getTime())).toISOString();
  const api = gh(fetchImpl, String(env.GITHUB_TOKEN));
  const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
  const maxBrokenPerRun = Number(env.MAX_BROKEN_PER_RUN || 10);
  const maxFlakyPerDay = Number(env.MAX_FLAKY_PER_DAY || 6);
  const holdMs = Number(env.HOLD_HOURS || 24) * HOUR;
  // An agent PR with no activity for longer than this stops blocking the spec it changes.
  const ownIdleMs = Number(env.OWN_PR_IDLE_DAYS || 3) * DAY;
  const causeHoldMs = Number(env.CAUSE_HOLD_HOURS || 4) * HOUR;
  const minFlaky = Number(env.MIN_FLAKY || 1);
  const currentAt = Date.parse(first.created_at ?? "") || now.getTime();
  const label = env.LABEL || DEFAULT_LABEL;
  const reportNameOf = new Map<string, string | null>(suites.map((s): [string, string | null] => [s.name, s.report_name || null]));

  const groups = new Map<string, Group>();
  const bySuite: { suite: string; findings: Finding[] }[] = [];
  for (const s of suites) {
    let result: EvaluatedRun;
    try {
      result = await triage({
        env: { COMPOSITE_IDENTITY: JSON.stringify({ ...id, name: s.name }), MODE: "report-only", TEST_ROOT: s.test_root, REPORT_NAME: s.report_name || "", TSIO_BASE_URL: base, GITHUB_TOKEN: env.GITHUB_TOKEN },
        // Classified against the history up to this run: a later trunk run must not decide this one's failures.
        fetchImpl,
        log,
        now: new Date(until),
        wait,
      });
    } catch (e) {
      notes.push(`${s.name}: not read (${String(e).slice(0, 160)})`);
      continue;
    }
    if (result.infra) {
      notes.push(`${s.name}: infrastructure, not repaired (${result.infra})`);
      continue;
    }
    bySuite.push({ suite: s.name, findings: result.findings });
    const found = selectRepairs(result, s.name, { minFlaky });
    try {
      const groupId = groupsOfRun.find((g) => g.name === s.name && g.branch === trunk)!.id;
      const recovered = await retryRecovered(fetchImpl, base, groupId);
      if (recovered.length) {
        const history = await fetchHistory(fetchImpl, base, id.repository, recovered, until, undefined, trunk, s.report_name || null, log, laneOf(s.name));
        found.push(...selectRetryFlakes(recovered, history, { suite: s.name, testRoot: s.test_root, branch: trunk, groupId, minFlaky }));
      }
    } catch (e) {
      notes.push(`${s.name}: retry-recovered tests not read (${String(e).slice(0, 160)})`);
    }
    for (const g of found) addGroup(groups, g);
  }
  for (const g of selectCrossLane(bySuite)) addGroup(groups, g);

  const decisions: Decision[] = [];
  // What the workflow should send, each with the ledger entry `record` keeps once it is accepted.
  const out: Outgoing[] = [];
  const instructions = env.INSTRUCTIONS ? { instructions: env.INSTRUCTIONS } : {};
  const ledger = readLedger(env.LEDGER_PATH).filter((r) => now.getTime() - Date.parse(r.at) < LEDGER_MS);
  writeLedger(env.LEDGER_PATH, ledger); // pruned, and present for the cache to save even when nothing is sent
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
  // When each of the agent's PRs last had activity, from either read of them.
  const activity = new Map<number, number | null>([
    ...[...open.prs.values()].map((p): [number, number | null] => [p.number, p.activeAt]),
    ...own.prs.map((p): [number, number | null] => [p.number, lastActivity(p)]),
  ]);
  const idleNoted = new Set<number>();
  const candidates: (Group & { openPRs: OpenPR[] })[] = [];
  for (const g of groups.values()) {
    const prs = prsTouching(open.files, g.spec).flatMap((n) => {
      const p = open.prs.get(n);
      return p ? [p] : [];
    });
    // The agent's PRs that change this exact spec: a sibling in its directory is not a reason to wait.
    const agentPRs = [...new Set([...prsChanging(open.files, g.spec).filter((n) => open.prs.get(n)?.labels.includes(label)), ...prsChanging(own.files, g.spec)])].sort((a, b) => a - b);
    const ownPRs: number[] = [];
    for (const n of agentPRs) {
      const at = activity.get(n) ?? null;
      if (at != null && now.getTime() - at > ownIdleMs) {
        if (!idleNoted.has(n)) {
          idleNoted.add(n);
          notes.push(`stalled agent PR #${n} (idle ${Math.floor((now.getTime() - at) / DAY)} days): not blocking new requests`);
        }
      } else ownPRs.push(n);
    }
    const held = ledger.find((r) => r.specs?.includes(g.spec) && now.getTime() - Date.parse(r.at) < holdMs);
    // Without the agent's own PRs a request may duplicate one it is already fixing: wait for the next run.
    if (ownUnknown) skip(g, "skipped: the agent's own PRs could not be read");
    else if (ownPRs.length) skip(g, `skipped: #${ownPRs.join(", #")} (${label}) already changes it`);
    else if (held) skip(g, `skipped: requested ${utcMinute(held.at)} UTC by ${held.run}`);
    else candidates.push({ ...g, openPRs: prs });
  }

  // Master stays red until a break is fixed, so breaks all go now. Flaky specs share a daily budget,
  // chosen before any history is read: those not requested in the last week first (so the budget
  // rotates), then the most flaky.
  const asked = (g: Group): number => ledger.filter((e) => e.specs?.includes(g.spec)).length;
  const flakyLeft = maxFlakyPerDay - ledger.filter((r) => r.kind === "flaky" && now.getTime() - Date.parse(r.at) < DAY).length;
  const flaky = candidates.filter((g) => g.kind === "flaky").sort((a, b) => asked(a) - asked(b) || flakes(b) - flakes(a));
  const ranged: RangedGroup[] = [];
  for (const g of [...candidates.filter((c) => c.kind === "broken"), ...flaky.slice(0, Math.max(0, flakyLeft))]) {
    const range = await specRange(fetchImpl, base, id, g, until, currentAt, log, reportNameOf);
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
        (e) => e.window && now.getTime() - Date.parse(e.at) < causeHoldMs && windowsOverlap(window, { from: e.window.from ?? -Infinity, to: e.window.to }),
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
      repository: id.repository,
      branch: id.branch,
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
      ...instructions,
      labels: [label, ...(env.EXTRA_LABELS ? env.EXTRA_LABELS.split(",").map((l) => l.trim()).filter(Boolean) : [])],
    };
    decision.payload = payload;
    decision.action = "to request";
    out.push({
      id: `fix-${out.length + 1}`,
      payload,
      entry: {
        at: now.toISOString(),
        specs: r.specs,
        kind: r.kind,
        ...(r.window ? { window: { from: Number.isFinite(r.window.from) ? r.window.from : null, to: r.window.to } } : {}),
        run: runURL,
      },
    });
  }
  for (const g of flaky.slice(Math.max(0, flakyLeft))) skip(g, `skipped: flaky budget of ${maxFlakyPerDay} a day used`);

  // The repair PRs the automation opened are its own to keep mergeable: a trunk merge that
  // conflicts with one goes back to it, once per PR head within the hold.
  const { conflicts, out: conflictOut } = planConflicts({
    own,
    ledger,
    now,
    holdMs,
    maxPerRun: Number(env.MAX_CONFLICTS_PER_RUN || 2),
    repository: id.repository,
    branch: id.branch,
    runURL,
    instructions,
  });
  out.push(...conflictOut);

  const lines = summaryLines({ commit: id.commit_sha, runURL, decisions, conflicts, notes });
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

/**
 * Conflict requests for the agent's own PRs that no longer merge into trunk: once per PR head within
 * `holdMs`, and at most `maxPerRun` new ones per run. Returns the summary rows and the requests to send.
 */
function planConflicts({
  own,
  ledger,
  now,
  holdMs,
  maxPerRun,
  repository,
  branch,
  runURL,
  instructions,
}: {
  own: RepairPRs;
  ledger: LedgerEntry[];
  now: Date;
  holdMs: number;
  maxPerRun: number;
  repository: string;
  branch: string;
  runURL: string;
  instructions: { instructions?: string };
}): { conflicts: ConflictRow[]; out: Outgoing[] } {
  const conflicts: ConflictRow[] = [];
  const out: Outgoing[] = [];
  let left = maxPerRun;
  for (const pr of conflictedRepairPRs(own)) {
    const held = ledger.find((r) => r.pr === pr.number && r.head === pr.headRefOid && now.getTime() - Date.parse(r.at) < holdMs);
    const c: ConflictRow = { pr: pr.number, url: pr.url };
    conflicts.push(c);
    // Not counted against the per-run limit: a PR already sent for its head can't starve the others.
    if (held) {
      c.action = `skipped: sent ${utcMinute(held.at)} UTC for this head`;
      continue;
    }
    if (left <= 0) {
      c.action = `skipped: over ${maxPerRun} conflict requests in one run`;
      continue;
    }
    left--;
    c.payload = {
      kind: "e2e-autofix-conflict",
      repository,
      branch,
      master_run: runURL,
      pr: pr.number,
      pr_url: pr.url,
      pr_branch: pr.headRefName,
      pr_head: pr.headRefOid,
      ...instructions,
    };
    c.action = "to send back";
    out.push({ id: `conflict-${pr.number}`, payload: c.payload, entry: { at: now.toISOString(), pr: pr.number, head: pr.headRefOid, run: runURL } });
  }
  return { conflicts, out };
}

/** The job summary: what each spec got, the agent's PRs in conflict, and what could not be read. */
function summaryLines({
  commit,
  runURL,
  decisions,
  conflicts,
  notes,
}: {
  commit: string;
  runURL: string;
  decisions: Decision[];
  conflicts: ConflictRow[];
  notes: string[];
}): string[] {
  const lines = [`## E2E master watch: ${commit.slice(0, 9)} · [run](${runURL})`, ""];
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
export function record({ env, now = new Date(), log = console.error }: { env: Env; now?: Date; log?: (message: string) => void }): { sent: number; failed: number } {
  let pending: PlannedEntry[] = [];
  try {
    pending = JSON.parse(readFileSync(env.PENDING_PATH ?? "", "utf8")) as PlannedEntry[];
  } catch {
    // Nothing planned (not a trunk run, or the plan step failed before writing it).
  }
  const results = new Map<string, number>((JSON.parse(env.RESULTS || "[]") as { id: string; status: unknown }[]).map((r) => [r.id, Number(r.status) || 0]));
  const ledger = readLedger(env.LEDGER_PATH).filter((r) => now.getTime() - Date.parse(r.at) < LEDGER_MS);
  const lines: string[] = [];
  for (const p of pending) {
    const status = results.get(p.id);
    if (status !== undefined && status >= 200 && status < 300) ledger.push(p.entry);
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

/** A planned request as the plan step wrote it to PENDING_PATH. */
interface PlannedEntry {
  id: string;
  entry: LedgerEntry;
}
