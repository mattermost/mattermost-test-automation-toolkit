// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { appendFileSync } from "node:fs";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { laneSummary } from "../../shared/src/lane.ts";
import { FAILED_TESTS, REPORTS_INCOMPLETE, statusPublisher, UPSTREAM_FAILED } from "../../shared/src/status.ts";
import { compositeIdentityFrom, fetchRun, tsioBase } from "../../shared/src/tsio.ts";
import type { Wait } from "../../shared/src/tsio.ts";

/**
 * How long finish waits for late report uploads. Callers usually hold the SHA-wide publication
 * lock while it waits, so a run whose workers already failed (red either way) does not wait.
 */
export function reportWait(env: Env): Wait {
  if (env.EXECUTION_SUCCESS !== "true") return { attempts: 0, ms: 0 };
  const seconds = Number(env.REPORT_WAIT_SECONDS ?? 120);
  const ms = 20000;
  return { attempts: Number.isFinite(seconds) && seconds > 0 ? Math.ceil((seconds * 1000) / ms) : 0, ms };
}

export interface PublishOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
  wait?: Wait;
  /** Waits between a status write's retries; a test passes one that does not sleep. */
  retryWait?: Sleep;
}

/** Publishes a run-owned E2E lane status and refreshes or summarizes the cross-lane aggregate. */
export async function publish({ env, fetchImpl = fetch, log = console.error, wait, retryWait }: PublishOptions): Promise<boolean> {
  if (env.CANCELLED === "true") return false;
  // The identity is trusted as written by the caller, as before: no shape check.
  const id = compositeIdentityFrom(env.COMPOSITE_IDENTITY);
  const operation = env.OPERATION || "finish";
  if (!["claim", "finish", "refresh", "summarize"].includes(operation)) throw new Error("Invalid status operation");
  // Only finish reads TSIO (its report verification), so only finish refuses a conflicting use-staging and tsio-base-url,
  // before any GitHub or TSIO call. claim, refresh and summarize read no TSIO and still publish.
  if (operation === "finish") tsioBase(env);
  if (!env.STATUS_CONTEXT || !env.GITHUB_TOKEN) throw new Error("Status context and GitHub token are required");
  const release = env.RELEASE === "true";
  const publisher = statusPublisher({ api: gh(fetchImpl, env.GITHUB_TOKEN, retryWait), id, context: env.STATUS_CONTEXT, env, log, release });
  let written = false;
  let state: string = env.STATUS_STATE ?? "";
  let reportsComplete = false;
  if (operation !== "refresh" && operation !== "summarize") {
    if (!["pending", "success", "failure", "error"].includes(state)) throw new Error("Invalid status state");
    let description = env.STATUS_DESCRIPTION || "E2E results unavailable";
    if (operation === "finish" && env.VERIFY_REPORTS === "true") {
      // Orchestration completes units before workers upload their reports. A
      // successful summary alone cannot establish that all results arrived.
      try {
        const base = tsioBase(env);
        const run = await fetchRun(fetchImpl, base, id, null, wait ?? reportWait(env));
        reportsComplete = !run.missing;
        if (state === "success" && run.counts.failed > 0) {
          state = "failure";
          description = FAILED_TESTS;
        }
      } catch (e) {
        log(`report completeness could not be verified: ${String(e).slice(0, 300)}`);
      }
      if (!reportsComplete || env.EXECUTION_SUCCESS !== "true") {
        state = "failure";
        description = !reportsComplete ? REPORTS_INCOMPLETE : UPSTREAM_FAILED;
      }
    }
    written = await publisher.write({ state, description, target_url: env.TARGET_URL }, operation);
  }
  const lanes = String(env.TRIAGE_LANES || "").split(",").map((s) => s.trim()).filter(Boolean);
  // This is a factual projection of required statuses, also in report-only
  // mode. Only triage itself can clear failures, and still respects its label.
  if (operation === "summarize") await publisher.summarize(lanes, env.TRIAGE_CONTEXT, laneSummary, release);
  if (written || operation === "refresh") await publisher.refresh(lanes, env.TRIAGE_CONTEXT, laneSummary, release);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `published=${written}\nstate=${state || ""}\nreports_complete=${reportsComplete}\n`);
  return written;
}
