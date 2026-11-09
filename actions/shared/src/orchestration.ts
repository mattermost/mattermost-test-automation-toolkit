// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { FetchImpl } from "./github.ts";
import type { CompositeIdentity } from "./tsio.ts";

/**
 * A lane's TSIO orchestration, read from /orchestration/status: every spec unit the lane dispatched, with each lease's
 * outcome. Workers report each lease to the orchestration as soon as its specs finish, before (and whether or not) they
 * upload their shard report, so this says which specs ran and how they ended even when a shard report never arrived.
 */
export interface Orchestration {
  status: string;
  totalUnits: number;
  units: OrchestrationUnit[];
  /** Units whose specs never finished: no lease of them reported a result. */
  unfinished: OrchestrationUnit[];
  /** Units that finished and failed on every lease that reported (a retest that passed makes a unit pass). */
  failed: OrchestrationUnit[];
  /** Tests, as TSIO rolls them up over every reported lease. */
  tests: { passed: number; failed: number; flaky: number; skipped: number; total: number };
  /** The lease timeout in ms, when TSIO sends it. */
  leaseTimeoutMs: number | null;
}

export interface OrchestrationAttempt {
  /** The lease's reported status; null when it never reported, or when the worker's deadline killed its spec. */
  status: string | null;
  durationMs: number | null;
  expired: boolean;
  job: string | null;
  tests: { title: string; full_title: string | null; status: string; retry_count: number }[];
}

export interface OrchestrationUnit {
  spec: string;
  state: string;
  attempts: OrchestrationAttempt[];
  /** "passed", "failed" or "unfinished": the unit's result over every lease that reported. */
  result: "passed" | "failed" | "unfinished";
}

interface RawAttempt {
  status?: string | null;
  error_message?: string | null;
  actual_duration_ms?: number | null;
  expired?: boolean | null;
  gh_job_name?: string | null;
  test_cases?: { title?: string; full_title?: string | null; status?: string; retry_count?: number }[] | null;
}

interface RawUnit {
  spec_path?: string;
  state?: string;
  attempts?: RawAttempt[] | null;
}

interface RawStatus {
  status?: string;
  total_units?: number;
  lease_timeout_ms?: number | null;
  tests?: { passed?: number; failed?: number; flaky?: number; skipped?: number; total?: number } | null;
  units?: RawUnit[] | null;
}

const FINISHED_PASS = new Set(["completed_pass", "completed_skipped"]);
// TSIO dispatch-run's worker deadline (deadline-minutes) kills a spec still running then and reports its lease
// "interrupted" with this message, so another worker can retest it. The spec did not fail: it did not finish.
const DEADLINE_KILL = /killed at worker deadline/i;
const PASSED_ATTEMPT = new Set(["passed", "skipped", "flaky"]);
const FAILED_ATTEMPT = new Set(["failed", "timedOut", "interrupted"]);

/**
 * A unit's result over every lease that reported. The unit's own state wins when it is final: TSIO sets it from the
 * leases' results. An abandoned or still pending unit can have a lease that reported after its deadline (TSIO keeps a
 * late report): its result counts, because those specs did run. With no reported lease the unit never finished.
 */
export function unitResult(unit: { state: string; attempts: { status: string | null }[] }): OrchestrationUnit["result"] {
  if (FINISHED_PASS.has(unit.state)) return "passed";
  const reported = unit.attempts.filter((a) => a.status != null);
  // A unit TSIO failed only because worker deadlines killed it (see orchestrationFrom) never finished.
  if (unit.state === "completed_fail") return reported.length || !unit.attempts.length ? "failed" : "unfinished";
  if (reported.some((a) => PASSED_ATTEMPT.has(String(a.status)))) return "passed";
  if (reported.some((a) => FAILED_ATTEMPT.has(String(a.status)))) return "failed";
  return "unfinished";
}

/** The orchestration from TSIO's raw /orchestration/status body. */
export function orchestrationFrom(raw: RawStatus): Orchestration {
  const units: OrchestrationUnit[] = (raw.units ?? []).map((u) => {
    const attempts: OrchestrationAttempt[] = (u.attempts ?? []).map((a) => ({
      status: DEADLINE_KILL.test(String(a.error_message ?? "")) ? null : a.status ?? null,
      durationMs: typeof a.actual_duration_ms === "number" ? a.actual_duration_ms : null,
      expired: Boolean(a.expired),
      job: a.gh_job_name ?? null,
      tests: (a.test_cases ?? []).map((t) => ({ title: String(t.title ?? ""), full_title: t.full_title ?? null, status: String(t.status ?? ""), retry_count: Number(t.retry_count ?? 0) })),
    }));
    const state = String(u.state ?? "");
    return { spec: String(u.spec_path ?? ""), state, attempts, result: unitResult({ state, attempts }) };
  });
  const t = raw.tests ?? {};
  return {
    status: String(raw.status ?? ""),
    totalUnits: Number(raw.total_units ?? units.length),
    units,
    unfinished: units.filter((u) => u.result === "unfinished"),
    failed: units.filter((u) => u.result === "failed"),
    tests: { passed: Number(t.passed ?? 0), failed: Number(t.failed ?? 0), flaky: Number(t.flaky ?? 0), skipped: Number(t.skipped ?? 0), total: Number(t.total ?? 0) },
    leaseTimeoutMs: typeof raw.lease_timeout_ms === "number" ? raw.lease_timeout_ms : null,
  };
}

/**
 * The lane's orchestration, or null when the lane has none (a lane that does not lease its specs, or one whose
 * orchestration never began: TSIO answers 404). Any other failure throws: a caller must not read an unread
 * orchestration as "none".
 */
export async function fetchOrchestration(fetchImpl: FetchImpl, base: string, id: CompositeIdentity, framework: string | null = null, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Orchestration | null> {
  const q = new URLSearchParams({ repository: id.repository, commit_sha: id.commit_sha, gh_run_id: String(id.gh_run_id ?? ""), name: String(id.name ?? ""), gh_run_attempt: String(id.gh_run_attempt ?? "") });
  if (id.branch) q.set("branch", String(id.branch));
  if (framework) q.set("framework", framework);
  const path = `/orchestration/status?${q}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // A 429 or 5xx is usually still in effect a moment later: wait before the next try, not before the first.
    if (attempt > 0) await sleep(500 * attempt);
    try {
      const res = await fetchImpl(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null;
      if (res.ok) return orchestrationFrom((await res.json()) as RawStatus);
      lastError = new Error(`TSIO GET ${path.split("?")[0]}: ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Whether every unit finished and passed: every spec the lane dispatched ran, and none failed. */
// At least one test ran and passed: a run whose every unit completed with all its tests skipped (or with no test rollup)
// shows nothing passed.
export const allPassed = (o: Orchestration | null): boolean =>
  Boolean(o && o.units.length > 0 && o.units.length === o.totalUnits && !o.unfinished.length && !o.failed.length && o.tests.failed === 0 && o.tests.passed + o.tests.flaky > 0);

/** The longest a unit's spec ran on one lease, for a spec that outlasted its lease (a late report). */
export const longestRun = (u: OrchestrationUnit): number => Math.max(0, ...u.attempts.map((a) => a.durationMs ?? 0));
