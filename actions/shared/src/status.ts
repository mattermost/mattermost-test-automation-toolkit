// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { CommitStatus, Env, GhApi } from "./github.ts";
import type { LaneStatus, LaneSummary } from "./lane.ts";
import type { CompositeIdentity } from "./tsio.ts";

// GitHub commit statuses have no compare-and-swap API. Every caller MUST hold
// the same non-cancelling, SHA-scoped job concurrency lock across these reads
// and writes, including triage and the cross-lane summary. See the action README.

/** The run and attempt that own a lane's status. Strings: they are compared as big integers. */
export interface Owner {
  run: string;
  attempt: string;
}

/** A status to write. `context` is set by the publisher for its own lane, or given for the aggregate. */
export interface StatusRow {
  context?: string;
  state: string;
  description: string;
  target_url?: string | null;
}

/** Summarizes the latest status of each lane into the aggregate's state and description. */
export type LaneSummarizer = (lanes: LaneStatus[]) => LaneSummary;

export interface StatusPublisher {
  allowed(operation: string): Promise<boolean>;
  summarize(lanes: string[], summaryContext: string | undefined, summarizeLanes: LaneSummarizer): Promise<void>;
  write(row: StatusRow, operation?: string): Promise<boolean>;
  info(row: StatusRow): Promise<boolean>;
  refresh(lanes: string[], summaryContext: string | undefined, summarizeLanes: LaneSummarizer): Promise<void>;
}

const positive = (v: unknown): boolean => /^[1-9]\d*$/.test(String(v ?? ""));

export function statusOwner(target: string | null | undefined, repository: string): Owner | null {
  try {
    const url = new URL(String(target));
    const path = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/);
    const run = url.searchParams.get("status_run_id") || (path && url.hostname === "github.com" && path[1] === repository
      ? path[2] : url.searchParams.get("gh_run_id"));
    const attempt = url.searchParams.get("status_run_attempt") || path?.[3] || url.searchParams.get("gh_run_attempt") || "1";
    return positive(run) && positive(attempt) ? { run: String(run), attempt: String(attempt) } : null;
  } catch { return null; }
}

export function compareOwners(a: Owner, b: Owner): number {
  for (const key of ["run", "attempt"] as const) {
    if (BigInt(a[key]) !== BigInt(b[key])) return BigInt(a[key]) > BigInt(b[key]) ? 1 : -1;
  }
  return 0;
}

// The run and attempt an env names, else the identity's.
const runOf = (id: CompositeIdentity, env: Env, attemptDefault: string): Owner => ({
  run: String(env.GITHUB_RUN_ID || id.gh_run_id || ""),
  attempt: String(env.GITHUB_RUN_ATTEMPT || id.gh_run_attempt || attemptDefault),
});

export function publishingOwner(id: CompositeIdentity, env: Env = {}): Owner {
  const owner = runOf(id, env, "");
  if (!positive(owner.run) || !positive(owner.attempt) || owner.run !== String(id.gh_run_id)) throw new Error("Invalid status publishing run/attempt");
  return owner;
}

export function ownedURL(target: string | null | undefined, owner: Owner, repository: string): string {
  const url = new URL(target || `https://github.com/${repository}/actions/runs/${owner.run}`);
  url.searchParams.set("status_run_id", owner.run);
  url.searchParams.set("status_run_attempt", owner.attempt);
  return url.href;
}

export async function readStatuses(api: GhApi, id: CompositeIdentity): Promise<CommitStatus[]> {
  const all: CommitStatus[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = await api("GET", `/repos/${id.repository}/commits/${id.commit_sha}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Invalid GitHub status history");
    const batch = rows as CommitStatus[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error("GitHub status history truncated; refusing to publish");
}

export function mayPublish(rows: CommitStatus[], id: CompositeIdentity, context: string, owner: Owner, operation: string): boolean {
  const lane = rows.filter((r) => r.context === context);
  if (!lane.length) return operation === "claim";
  const current = statusOwner(lane[0].target_url, id.repository);
  if (!current) return false; // Never overwrite an unknown/manual current owner.
  // Inspect history too: an old, unguarded writer may already have overwritten
  // the newest run. Older unparseable history does not prevent migration.
  if (lane.some((r) => {
    const prior = statusOwner(r.target_url, id.repository);
    return prior && compareOwners(prior, owner) > 0;
  })) return false;
  if (operation === "claim") {
    // Repeated begin must not turn this attempt's terminal result back to pending.
    return compareOwners(owner, current) > 0 || lane[0].state === "pending";
  }
  // A report-only job rerun reads the original report identity, but publishes
  // under the new attempt. It may finish its own run without re-running begin.
  return current.run === owner.run && compareOwners(owner, current) >= 0 &&
    (operation !== "triage" || lane[0].state !== "pending");
}

export function statusPublisher({ api, id, context, env = {}, log = console.error }: {
  api: GhApi;
  id: CompositeIdentity;
  context: string;
  env?: Env;
  log?: (message: string) => void;
}): StatusPublisher {
  // Validated when a lane is written, not when the publisher is built: a verification run only summarizes.
  let validated: Owner | undefined;
  const owner = (): Owner => (validated ??= publishingOwner(id, env));
  // The aggregate is a projection of the lanes, owned by whichever run refreshed it.
  const snapshotOwner = (): Owner => {
    const snapshot = runOf(id, env, "1");
    if (!positive(snapshot.run) || !positive(snapshot.attempt)) throw new Error("Invalid status publishing run/attempt");
    return snapshot;
  };
  const allowed = async (operation: string): Promise<boolean> => {
    const rows = await readStatuses(api, id);
    const ok = mayPublish(rows, id, context, owner(), operation);
    if (!ok) log(`Status ${context} belongs to another run/attempt or has no known owner; publication skipped`);
    return ok;
  };
  const post = (row: StatusRow, by: Owner = owner()): Promise<unknown> => api("POST", `/repos/${id.repository}/statuses/${id.commit_sha}`, {
    ...row, description: row.description.slice(0, 140), target_url: ownedURL(row.target_url, by, id.repository),
  });
  const summarize = async (lanes: string[], summaryContext: string | undefined, summarizeLanes: LaneSummarizer): Promise<void> => {
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
    },
  };
}
