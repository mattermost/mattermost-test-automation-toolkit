// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { Finding } from "../../e2e-test-triage/src/types.ts";
import { compactError } from "../../e2e-test-triage/src/pack.ts";
import { repoPath } from "../../e2e-test-triage/src/config.ts";
import type { FetchImpl } from "../../shared/src/github.ts";
import { FAILED_STATUSES, identityKey, outcomeOf, tsioJson } from "../../shared/src/tsio.ts";
import type { TsioCase, TsioSuite } from "../../shared/src/tsio.ts";
import type { TsioId } from "../../e2e-test-triage/src/types.ts";
import { specOf, trunkRows } from "./model.ts";
import type { Group, Kind, RunHistory } from "./model.ts";

const ERROR_CHARS = 600;
// Earlier trunk failures or flaky passes a test needs, besides this run's, to count as flaky.
const MIN_FLAKY = 1;

/** The parts of a triage finding that selecting repairs reads. */
export type RepairFinding = Pick<Finding, "class" | "title" | "full_title" | "file" | "repo_path" | "error" | "identity_unresolved" | "trunk">;

/** A test that failed and then passed on retry in one run, as retryRecovered finds it. */
export interface RecoveredTest {
  file: string;
  title: string;
  full_title: string | null;
  error: string;
}

// Triage classes for a test failing on trunk for the first time (or with too little history to say).
const FIRST_FAILURE = new Set(["REGRESSION", "INSUFFICIENT_DATA"]);

/** Which failures in a trunk triage result need a repair, grouped by spec file. */
export function selectRepairs(result: { findings: readonly RepairFinding[] }, suite: string): Group[] {
  const bySpec = new Map<string, Group>();
  for (const f of result.findings) {
    // trunk counts exclude this run, so MIN_FLAKY 1 means this failure plus one before it.
    const kind: Kind | null =
      f.class === "BROKEN_ON_TRUNK" ? "broken" : f.class === "FLAKY_ON_TRUNK" && f.trunk.fails + f.trunk.flaky >= MIN_FLAKY ? "flaky" : null;
    if (!kind || f.identity_unresolved) continue;
    const spec = specOf(f);
    let g = bySpec.get(spec);
    if (!g) {
      g = { spec, kind, suites: new Set(), tests: [] };
      bySpec.set(spec, g);
    }
    if (kind === "broken") g.kind = "broken";
    g.suites.add(suite);
    g.tests.push({ spec, suite, title: f.title, full_title: f.full_title ?? null, error: compactError(f.error, ERROR_CHARS), trunk: f.trunk, finding: f });
  }
  return [...bySpec.values()];
}

/**
 * Tests that failed and then passed on retry in one run. The triage engine counts them as
 * passed, so a test that flakes on trunk but always recovers would otherwise never be seen.
 */
export async function retryRecovered(fetchImpl: FetchImpl, base: string, groupId: TsioId): Promise<RecoveredTest[]> {
  const [{ suites = [] }, cases] = await Promise.all([
    tsioJson<{ suites?: TsioSuite[] }>(fetchImpl, base, `/reports/${groupId}/suites`),
    tsioJson<TsioCase[]>(fetchImpl, base, `/reports/${groupId}/cases`),
  ]);
  const fileOf = new Map<TsioId, string>(suites.map((s): [TsioId, string] => [s.id, s.file_path ?? s.file ?? ""]));
  const byTest = new Map<string, TsioCase[]>();
  for (const c of cases) {
    const k = c.full_title ? JSON.stringify([fileOf.get(c.suite_id) ?? "", c.full_title]) : JSON.stringify([c.suite_id, c.title]);
    let attempts = byTest.get(k);
    if (!attempts) {
      attempts = [];
      byTest.set(k, attempts);
    }
    attempts.push(c);
  }
  // A name two tests share can't be matched to its own history.
  const perIdentity = new Map<string, number>();
  for (const attempts of byTest.values()) {
    const key = identityKey({ file: fileOf.get(attempts[0].suite_id) ?? "", title: attempts[0].title, full_title: attempts[0].full_title });
    perIdentity.set(key, (perIdentity.get(key) ?? 0) + 1);
  }
  const out: RecoveredTest[] = [];
  for (const attempts of byTest.values()) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    if (outcomeOf(attempts).status !== "flaky") continue;
    const failed = attempts.find((a) => FAILED_STATUSES.has(a.status)) ?? attempts[0];
    const file = fileOf.get(failed.suite_id) ?? "";
    const test: RecoveredTest = {
      file,
      title: failed.title,
      full_title: failed.full_title ?? null,
      error: [failed.error_message, failed.error_stack].filter(Boolean).join("\n"),
    };
    if (file && perIdentity.get(identityKey(test)) === 1) out.push(test);
  }
  return out;
}

/**
 * Tests failing for the first time in two or more lanes (suites) of the same run: independent
 * signals at once, so they count as broken now instead of waiting for the next run.
 * `bySuite` is [{ suite, findings }] from triage, one entry per suite read.
 */
export function selectCrossLane(bySuite: { suite: string; findings: readonly RepairFinding[] }[]): Group[] {
  const seen = new Map<string, { spec: string; suites: Map<string, RepairFinding> }>();
  for (const { suite, findings } of bySuite) {
    for (const f of findings) {
      if (f.identity_unresolved || !FIRST_FAILURE.has(f.class)) continue;
      const spec = specOf(f);
      const key = JSON.stringify([spec, f.full_title || f.title]);
      let entry = seen.get(key);
      if (!entry) {
        entry = { spec, suites: new Map() };
        seen.set(key, entry);
      }
      // The finding of each lane: its own error and its own trunk history.
      if (!entry.suites.has(suite)) entry.suites.set(suite, f);
    }
  }
  const bySpec = new Map<string, Group>();
  for (const { spec, suites } of seen.values()) {
    if (suites.size < 2) continue;
    let g = bySpec.get(spec);
    if (!g) {
      g = { spec, kind: "broken", suites: new Set(), tests: [] };
      bySpec.set(spec, g);
    }
    for (const x of suites.keys()) g.suites.add(x);
    // One entry per lane, so each is read against its own lane's history.
    for (const [suite, f] of suites) {
      g.tests.push({
        spec,
        suite,
        title: f.title,
        full_title: f.full_title ?? null,
        error: compactError(f.error, ERROR_CHARS),
        trunk: f.trunk,
        finding: f,
      });
    }
  }
  return [...bySpec.values()];
}

/** Adds a spec's group, merging with one already found in another suite: broken wins over flaky. */
export function addGroup(groups: Map<string, Group>, g: Group): void {
  const prev = groups.get(g.spec);
  if (!prev) {
    groups.set(g.spec, g);
    return;
  }
  prev.kind = prev.kind === "broken" || g.kind === "broken" ? "broken" : "flaky";
  for (const x of g.suites) prev.suites.add(x);
  for (const t of g.tests) if (!prev.tests.some((p) => p.suite === t.suite && (p.full_title || p.title) === (t.full_title || t.title))) prev.tests.push(t);
}

/** Retry-recovered tests that also failed or flaked in an earlier trunk run, grouped by spec file. */
export function selectRetryFlakes(
  tests: readonly RecoveredTest[],
  history: RunHistory,
  {
    suite,
    testRoot,
    branch,
    groupId,
  }: { suite: string; testRoot: string | null | undefined; branch: string; groupId: TsioId },
): Group[] {
  const bySpec = new Map<string, Group>();
  for (const t of tests) {
    if (history.ambiguous?.has(identityKey(t))) continue;
    const trunk = trunkRows(history, t, branch).filter((o) => o.group_id !== groupId && o.status !== "skipped");
    const fails = trunk.filter((o) => FAILED_STATUSES.has(o.status)).length;
    const flaky = trunk.filter((o) => o.status === "flaky").length;
    if (fails + flaky < MIN_FLAKY) continue;
    const spec = repoPath(testRoot, t.file) ?? t.file;
    let g = bySpec.get(spec);
    if (!g) {
      g = { spec, kind: "flaky", suites: new Set([suite]), tests: [] };
      bySpec.set(spec, g);
    }
    g.tests.push({
      spec,
      suite,
      title: t.title,
      full_title: t.full_title,
      error: compactError(t.error, ERROR_CHARS),
      trunk: {
        runs: trunk.length,
        fails,
        flaky,
        passes: trunk.filter((o) => o.status === "passed").length,
        latest: trunk[0]?.status ?? "",
        recovered_on_retry_now: true,
      },
      finding: t,
    });
  }
  return [...bySpec.values()];
}
