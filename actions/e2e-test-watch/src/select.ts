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
export type RepairFinding = Pick<Finding, "class" | "title" | "full_title" | "file" | "repo_path" | "error" | "identity_unresolved" | "trunk" | "failed_everywhere">;

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
 * `reportName` (a prefix, as triage reads it) scopes the run as `runFromGroups` does: only the
 * newest upload of each matching report name (a re-run replaces the earlier attempt's), each report
 * read on its own. Otherwise a failure in another report (another OS, another shard, or a
 * superseded upload) plus a pass here would read as a recovered retry.
 */
export async function retryRecovered(fetchImpl: FetchImpl, base: string, groupId: TsioId, reportName: string | null = null): Promise<RecoveredTest[]> {
  const [{ suites = [] }, cases] = await Promise.all([
    tsioJson<{ suites?: TsioSuite[] }>(fetchImpl, base, `/reports/${groupId}/suites`),
    tsioJson<TsioCase[]>(fetchImpl, base, `/reports/${groupId}/cases`),
  ]);
  const fileOf = new Map<TsioId, string>(suites.map((s): [TsioId, string] => [s.id, s.file_path ?? s.file ?? ""]));
  const reportOf = new Map<TsioId, string>(suites.map((s): [TsioId, string] => [s.id, String(s.report_name ?? "")]));
  let scoped: Set<TsioId> | null = null;
  if (reportName) {
    const matching = suites.filter((s) => String(s.report_name ?? "").startsWith(reportName));
    // Report ids are UUIDv7, so the greatest of a name is its newest upload.
    const newest = new Map<string, string>();
    for (const s of matching) if (s.report_id && (newest.get(String(s.report_name)) ?? "") < s.report_id) newest.set(String(s.report_name), s.report_id);
    scoped = new Set<TsioId>(matching.filter((s) => (s.report_id ? newest.get(String(s.report_name)) === s.report_id : !newest.has(String(s.report_name)))).map((s) => s.id));
  }
  // Scoped, the report is part of the key, so two reports' attempts never merge into one test's.
  const reportKey = (c: TsioCase): string => (scoped ? reportOf.get(c.suite_id) ?? "" : "");
  const byTest = new Map<string, TsioCase[]>();
  for (const c of cases) {
    if (scoped && !scoped.has(c.suite_id)) continue;
    const k = c.full_title
      ? JSON.stringify(scoped ? [reportKey(c), fileOf.get(c.suite_id) ?? "", c.full_title] : [fileOf.get(c.suite_id) ?? "", c.full_title])
      : JSON.stringify([c.suite_id, c.title]);
    let attempts = byTest.get(k);
    if (!attempts) {
      attempts = [];
      byTest.set(k, attempts);
    }
    attempts.push(c);
  }
  // A name two tests share can't be matched to its own history. The same test in two reports is still one test.
  const identityOf = (c: TsioCase): string => identityKey({ file: fileOf.get(c.suite_id) ?? "", title: c.title, full_title: c.full_title });
  const perIdentity = new Map<string, number>();
  for (const attempts of byTest.values()) {
    const key = JSON.stringify([reportKey(attempts[0]), identityOf(attempts[0])]);
    perIdentity.set(key, (perIdentity.get(key) ?? 0) + 1);
  }
  const out: RecoveredTest[] = [];
  const sent = new Set<string>();
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
    // Recovered in two matching reports: one test, requested once.
    if (!file || perIdentity.get(JSON.stringify([reportKey(failed), identityOf(failed)])) !== 1 || sent.has(identityKey(test))) continue;
    sent.add(identityKey(test));
    out.push(test);
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

/** A failing test no request covers, and why it was left for now. */
export interface Unselected {
  spec: string;
  suite: string;
  title: string;
  reason: string;
}

// Triage classes that would be repaired once they repeat or can be told apart.
const REPAIRABLE = new Set(["BROKEN_ON_TRUNK", "FLAKY_ON_TRUNK", ...FIRST_FAILURE]);

/**
 * The failing tests in specs no group covers, with why each waits: a first failure in one lane (or one trunk's history
 * does not call a flake), a first flake, or a name two tests share. Read so a red trunk run with no request says what
 * it saw.
 */
export function unselected(bySuite: { suite: string; findings: readonly RepairFinding[] }[], selected: ReadonlySet<string>): Unselected[] {
  const out: Unselected[] = [];
  for (const { suite, findings } of bySuite) {
    for (const f of findings) {
      const spec = specOf(f);
      if (selected.has(spec) || !REPAIRABLE.has(f.class)) continue;
      // A cross-platform failure leads even where history is too short to call a flake: it is the stronger fact.
      const reason = f.identity_unresolved
        ? "shares its name with another test, so its history can't be read"
        : f.class === "INSUFFICIENT_DATA"
          ? f.failed_everywhere?.length
            ? `failed every try and on ${f.failed_everywhere.join(" and ")} on this commit; only ${f.trunk.runs} trunk runs before; in ${suite} only; requested if it fails again`
            : `only ${f.trunk.runs} trunk runs before, too few to call a flake; in ${suite} only; requested if it fails again`
          : FIRST_FAILURE.has(f.class)
            ? f.failed_everywhere?.length
              ? `failed every try and on ${f.failed_everywhere.join(" and ")} on this commit; in ${suite} only; requested if it fails again`
              : f.trunk.fails + f.trunk.flaky > 0
                ? `failed or flaked in ${f.trunk.fails + f.trunk.flaky} of ${f.trunk.runs} trunk runs before, too rarely or another way to call a flake; in ${suite} only; requested if it fails again`
                : `first failure, in ${suite} only; requested if it fails again`
          : f.class === "FLAKY_ON_TRUNK"
            ? "first flake on trunk; requested if it flakes again"
            : null;
      if (reason) out.push({ spec, suite, title: f.full_title || f.title, reason });
    }
  }
  return out;
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
