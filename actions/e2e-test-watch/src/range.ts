// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { TestRef } from "../../e2e-test-triage/src/types.ts";
import { fetchHistory } from "../../e2e-test-triage/src/history.ts";
import { laneOf } from "../../e2e-test-triage/src/config.ts";
import type { FetchImpl, GhApi } from "../../shared/src/github.ts";
import { FAILED_STATUSES } from "../../shared/src/tsio.ts";
import { flakes, trunkRows } from "./model.ts";
import type { BreakWindow, Group, GroupTest, Kind, RangeEnd, RunHistory, RunRow, SuspectRange } from "./model.ts";
import type { OpenPR } from "./prs.ts";

const MAX_SUSPECTS = 30;

// A run's lanes (enterprise, FIPS) start seconds apart; runs of different commits start minutes apart.
const SAME_RUN_MS = 5 * 60e3;

/** The watched run: the trunk commit it tested, its TSIO and GitHub run, and the branch. */
export interface WatchId {
  repository: string;
  commit_sha: string;
  gh_run_id: string | undefined;
  gh_run_attempt: string;
  branch: string;
}

/** A spec's suspect range and break window, as specRange reads them. */
export interface SpecRange {
  range: SuspectRange | null;
  window: BreakWindow | null;
  historyError?: string;
}

/** A group with what the planning added: its open PRs, and its suspect range and break window. */
export interface RangedGroup extends Group {
  openPRs?: OpenPR[];
  range?: SuspectRange | null;
  window?: BreakWindow | null;
}

/** One fix request: the specs one agent gets, with the suspect range and break window they share. */
export interface FixRequest {
  specs: string[];
  kind: Kind;
  suites: Set<string>;
  tests: GroupTest[];
  range: SuspectRange | null | undefined;
  openPRs: OpenPR[];
  window: BreakWindow | null | undefined;
}

interface CompareCommit {
  sha: string;
  commit: { message: string; author?: { name?: string } | null };
  author?: { login?: string } | null;
}

/** The suspect commits and range ends a request carries. */
export interface Suspects {
  last_green_commit: string | null | undefined;
  first_red_commit: string | null | undefined;
  suspect_commits: { sha: string; title: string; author: string | undefined }[];
  suspect_commits_total: number;
}

/**
 * Where a spec's failing tests were last all green on trunk (the oldest of their last runs that
 * passed or were skipped: a test skipped behind a flag broke only when something made it run)
 * and where the last of them first failed after that, so the range covers every test's break.
 * A flaky run is not green: it may be where the break began, and the suspect commits start after
 * the green one. Null when a test has not been green on trunk within the history window: its break
 * is older than what we can see.
 */
export function rangeOf(history: RunHistory, tests: readonly TestRef[], branch: string): SuspectRange | null {
  const at = (o: RunRow): number => Date.parse(o.created_at ?? "") || 0;
  let green: RunRow | null = null;
  let red: RunRow | null = null;
  for (const t of tests) {
    const rows = trunkRows(history, t, branch);
    const i = rows.findIndex((o) => o.status === "passed" || o.status === "skipped");
    if (i < 0) return null;
    // The last failing row before the first pass: the first failure after the green run.
    let firstFail: RunRow | undefined;
    for (const o of rows.slice(0, i)) if (FAILED_STATUSES.has(o.status)) firstFail = o;
    if (!green || at(rows[i]) < at(green)) green = rows[i];
    if (firstFail && (!red || at(firstFail) > at(red))) red = firstFail;
  }
  return green ? { green, red } : null;
}

/** Two suspect ranges as one: the older green, the later red. No red row means this run, the latest there is. */
function mergeRanges(a: SuspectRange, b: SuspectRange): SuspectRange {
  const at = (o: RangeEnd): number => Date.parse(o.created_at ?? "") || 0;
  return {
    green: at(b.green) < at(a.green) ? b.green : a.green,
    red: !a.red || !b.red ? null : at(b.red) > at(a.red) ? b.red : a.red,
  };
}

/** The union of per-lane suspect ranges, so every lane's break is in it. Null when any lane has no range, as rangeOf is null when any test has none. */
function combineRanges(ranges: (SuspectRange | null)[]): SuspectRange | null {
  const known = ranges.filter((r): r is SuspectRange => r !== null);
  if (!known.length || known.length !== ranges.length) return null;
  return known.reduce(mergeRanges);
}

/** The union of per-lane break windows: from the earliest start to the latest end. */
function combineWindows(windows: (BreakWindow | null)[]): BreakWindow | null {
  const known = windows.filter((w): w is BreakWindow => Boolean(w));
  if (!known.length) return null;
  return { from: Math.min(...known.map((w) => w.from)), to: Math.max(...known.map((w) => w.to)) };
}

/**
 * A spec's suspect range (for the request) and, if broken, its break window (for bundling and holds).
 * Each suite's tests are read against that suite's own lane and report: a spec can fail in one lane
 * and pass in another, so one lane's history can't stand in for the rest.
 */
export async function specRange(
  fetchImpl: FetchImpl,
  base: string,
  id: WatchId,
  group: Group,
  // Where each suite's history ends: that suite's run, which a re-run attempt can leave earlier than another's.
  untilOf: (suite: string) => string,
  currentAt: number,
  log: (message: string) => void,
  reportNameOf: ReadonlyMap<string, string | null> = new Map(),
): Promise<SpecRange> {
  try {
    const bySuite = new Map<string, TestRef[]>();
    for (const t of group.tests) {
      let list = bySuite.get(t.suite);
      if (!list) {
        list = [];
        bySuite.set(t.suite, list);
      }
      list.push(t.finding);
    }
    const parts: { range: SuspectRange | null; window: BreakWindow | null }[] = [];
    for (const [suite, tests] of bySuite) {
      const history = await fetchHistory(fetchImpl, base, id.repository, tests, untilOf(suite), undefined, id.branch, reportNameOf.get(suite) ?? null, log, laneOf(suite));
      parts.push({ range: rangeOf(history, tests, id.branch), window: group.kind === "broken" ? breakWindow(history, tests, id.branch, currentAt) : null });
    }
    return { range: combineRanges(parts.map((p) => p.range)), window: combineWindows(parts.map((p) => p.window)) };
  } catch (e) {
    log(`history for ${group.spec} unavailable: ${String(e).slice(0, 200)}`);
    return { range: null, window: null, historyError: String(e).slice(0, 160) };
  }
}

/** The commits from the last green one up to the first red one, oldest first: the cause is usually near the start. */
export async function suspects(api: GhApi, id: WatchId, range: SuspectRange | null | undefined, log: (message: string) => void): Promise<Suspects> {
  if (!range) return { last_green_commit: null, first_red_commit: null, suspect_commits: [], suspect_commits_total: 0 };
  const head = range.red?.commit_sha ?? id.commit_sha;
  try {
    const cmp = (await api("GET", `/repos/${id.repository}/compare/${range.green.commit_sha}...${head}`)) as {
      commits?: CompareCommit[];
      total_commits?: number;
    };
    return {
      last_green_commit: range.green.commit_sha,
      first_red_commit: head,
      suspect_commits: (cmp.commits ?? []).slice(0, MAX_SUSPECTS).map((c) => ({
        sha: c.sha.slice(0, 9),
        title: c.commit.message.split("\n")[0],
        author: c.author?.login ?? c.commit.author?.name,
      })),
      suspect_commits_total: cmp.total_commits ?? (cmp.commits ?? []).length,
    };
  } catch (e) {
    log(`compare ${range.green.commit_sha}...${head} unavailable: ${String(e).slice(0, 200)}`);
    return { last_green_commit: range.green.commit_sha, first_red_commit: head, suspect_commits: [], suspect_commits_total: 0 };
  }
}

/**
 * When a broken spec could have broken, as run times { from, to }: after the last trunk run in
 * which none of its failing tests failed (passed, flaky, or skipped: a test skipped behind a flag
 * still ran, and broke only when something made it run), up to the first trunk failure after
 * that, or this run (`currentAt`). Spanning all its tests. A test with no trunk history at all
 * could have broken any time: from -Infinity.
 */
export function breakWindow(history: RunHistory, tests: readonly TestRef[], branch: string, currentAt: number): BreakWindow | null {
  let from = Infinity;
  let to = -Infinity;
  for (const t of tests) {
    const rows = trunkRows(history, t, branch);
    const i = rows.findIndex((o) => !FAILED_STATUSES.has(o.status));
    from = Math.min(from, i < 0 ? -Infinity : Date.parse(rows[i].created_at ?? "") || -Infinity);
    to = Math.max(to, i > 0 ? Date.parse(rows[i - 1].created_at ?? "") || currentAt : currentAt);
  }
  return Number.isFinite(to) ? { from, to } : null;
}

/**
 * Two break windows share a commit that could have broken both. Ends in the same run don't
 * overlap: one spec passed in the run where the other first failed.
 */
export const windowsOverlap = (a: BreakWindow, b: BreakWindow): boolean => a.from < b.to - SAME_RUN_MS && b.from < a.to - SAME_RUN_MS;

/**
 * Broken specs whose break windows (see breakWindow) overlap go to one agent together: they can't be told apart,
 * and separate agents would race to fix the same cause. Windows, not exact commits, because an
 * incomplete run can leave one spec of a break red a run earlier or later than another. The
 * bundle's range runs from the oldest last pass to the latest first failure, so its suspect
 * commits cover every spec in it. Flaky specs, and breaks with no window, go alone. Broken
 * first; among flaky ones, the one that flaked most on trunk first.
 */
export function bundle(groups: RangedGroup[]): FixRequest[] {
  const newReq = (g: RangedGroup, window: BreakWindow | null): FixRequest => ({
    specs: [g.spec],
    kind: g.kind,
    suites: new Set(g.suites),
    tests: [...g.tests],
    range: g.range,
    openPRs: [...(g.openPRs ?? [])],
    window,
  });
  const absorb = (r: FixRequest, g: RangedGroup): void => {
    r.specs.push(g.spec);
    for (const s of g.suites) r.suites.add(s);
    r.tests.push(...g.tests);
    for (const p of g.openPRs ?? []) if (!r.openPRs.some((q) => q.number === p.number)) r.openPRs.push(p);
    // A member whose break is older than the history can see leaves the bundle's start unknown too:
    // suspect commits from the other members alone would leave out what broke it.
    r.range = r.range && g.range ? mergeRanges(r.range, g.range) : null;
  };
  const windowed: { g: RangedGroup; window: BreakWindow }[] = [];
  const alone: RangedGroup[] = [];
  for (const g of groups) {
    const window = g.kind === "broken" ? g.window : null;
    if (window) windowed.push({ g, window });
    else alone.push(g);
  }
  // Merge overlapping windows: sorted by start, a window joins the current bundle while it starts before the bundle ends.
  windowed.sort((a, b) => a.window.from - b.window.from);
  const bundles: FixRequest[] = [];
  for (const { g, window } of windowed) {
    const last = bundles.at(-1);
    if (last && last.window && windowsOverlap(window, last.window)) {
      absorb(last, g);
      last.window = { from: Math.min(last.window.from, window.from), to: Math.max(last.window.to, window.to) };
    } else bundles.push(newReq(g, { ...window }));
  }
  const requests = [...bundles, ...alone.map((g) => newReq(g, null))];
  return requests.sort((a, b) => (a.kind === b.kind ? (a.kind === "flaky" ? flakes(b) - flakes(a) : 0) : a.kind === "broken" ? -1 : 1));
}
