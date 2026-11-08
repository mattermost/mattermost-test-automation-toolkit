// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { CommitStatus, FetchImpl, GhApi } from "../../shared/src/github.ts";
import { fetchOrchestration } from "../../shared/src/orchestration.ts";
import type { Orchestration } from "../../shared/src/orchestration.ts";
import { isReportsIncomplete, isUpstreamFailed, readStatuses, statusOwner } from "../../shared/src/status.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";

/** The base branch's own run of this lane on one commit: its final status and, where TSIO has it, its orchestration. */
export interface TrunkRun {
  sha: string;
  /** Whether this run is of the merge base itself, not of an older commit walked back to. */
  exact?: boolean;
  state: string;
  description: string;
  /** Its orchestration; null when it has none or it could not be read. */
  orchestration: Orchestration | null;
}

/** What the base branch says about this lane, for a lane-wide failure: the PR's merge base, and the base branch now. */
export interface Baseline {
  /** The trunk lane's context, e.g. "e2e-test/cypress-full/enterprise/master". */
  context: string;
  base: string;
  /** The newest finished trunk run at or before the merge base (a trunk run: before this commit). */
  atBase: TrunkRun | null;
  /** The newest finished trunk run on the base branch now; null for a trunk run, or when none is found. */
  tip: TrunkRun | null;
  /** Commits the base branch has that the PR does not; null when unknown. */
  behindBy: number | null;
  /** Files the base branch changed since the merge base (first 300); null when unknown. */
  baseChanged: string[] | null;
  /**
   * Other runs of this lane (other PRs, other base-branch commits) in the six hours before this one: how many failed
   * lane-wide (most of their specs) and how many did not, each named once by PR or commit. When the base branch's own
   * run at the merge base has not finished, the same failure on other PRs at the same time is the base branch's.
   */
  peers: { broken: string[]; healthy: string[] } | null;
}

interface PeerGroup {
  commit?: string;
  name?: string;
  created_at?: string;
  gh_pr_number?: number | string | null;
  orchestration?: { counts?: { completed_pass?: number; completed_fail?: number; completed_skipped?: number } } | null;
}

const PEER_WINDOW_MS = 6 * 3600 * 1000;

/** Whether a peer's orchestration failed lane-wide: at least 20 specs, and a quarter of those that finished. */
export const peerBroken = (g: PeerGroup): boolean => {
  const c = g.orchestration?.counts ?? {};
  const fail = Number(c.completed_fail ?? 0);
  const done = fail + Number(c.completed_pass ?? 0) + Number(c.completed_skipped ?? 0);
  return fail >= 20 && fail * 4 >= done;
};

/** Other runs of the lane's TSIO names in the six hours up to `until`, newest first, at most 1000 read. */
export async function readPeers({ fetchImpl, tsio, repository, names, until, self, log }: {
  fetchImpl: FetchImpl; tsio: string; repository: string; names: string[]; until: number; self: { commit: string; pr: string | null }; log: (m: string) => void;
}): Promise<{ broken: string[]; healthy: string[] } | null> {
  const broken = new Set<string>();
  const healthy = new Set<string>();
  try {
    for (const name of [...new Set(names.filter(Boolean))]) {
      for (let offset = 0; offset < 1000; offset += 200) {
        const q = new URLSearchParams({ repository, name, limit: "200", offset: String(offset) });
        const res = await fetchImpl(`${tsio}/api/v1/reports?${q}`, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`TSIO GET /reports: ${res.status}`);
        const rows = ((await res.json()) as { reports?: PeerGroup[] }).reports ?? [];
        let older = false;
        for (const g of rows) {
          const at = Date.parse(String(g.created_at ?? ""));
          if (!Number.isFinite(at) || at > until) continue;
          if (at < until - PEER_WINDOW_MS) {
            older = true;
            continue;
          }
          const pr = g.gh_pr_number == null || String(g.gh_pr_number) === "" ? null : String(g.gh_pr_number);
          if (g.commit === self.commit || (pr && pr === self.pr) || !g.orchestration?.counts) continue;
          const who = pr ? `PR ${pr}` : String(g.commit ?? "").slice(0, 7);
          (peerBroken(g) ? broken : healthy).add(who);
        }
        if (older || rows.length < 200) break;
      }
    }
  } catch (e) {
    log(`other runs of the lane unavailable: ${String(e).slice(0, 120)}`);
    return null;
  }
  for (const w of broken) healthy.delete(w);
  return { broken: [...broken], healthy: [...healthy] };
}

const WALK = 15;

/** The trunk lane's context and TSIO name for a PR lane: "<context>/<base>" and "<name>-<base>". A trunk lane is its own. */
export function trunkLane(context: string, name: string, base: string): { context: string; name: string } {
  if (context.endsWith(`/${base}`)) return { context, name };
  return { context: `${context}/${base}`, name: `${name}-${base}` };
}

/** The TSIO run name in a status's report link (".../reports/<org>/<branch>/<sha>/<name>?gh_run_id=…"), if it has one. */
const nameInLink = (url: string | null | undefined): string | null => {
  try {
    const u = new URL(String(url));
    const m = /\/reports\/[^/]+\/[^/]+\/[^/]+\/([^/?]+)\/?$/.exec(u.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
};

/**
 * A lane-wide failure on a trunk run: most of its specs failed (at least 20, and a quarter of those that finished), or
 * none of them ran. A trunk run red for a few tests is not a broken base branch.
 */
export function trunkBroken(run: TrunkRun | null): boolean {
  // A run still going counts once its orchestration already shows the lane-wide failure.
  if (!run || (run.state !== "failure" && run.state !== "error" && !(run.state === "pending" && run.orchestration))) return false;
  const o = run.orchestration;
  if (!o) return isUpstreamFailed(run.description) || isReportsIncomplete(run.description) || /reports unavailable|upstream execution failed|broken on main|caused by|many failures|investigation required/.test(run.description);
  const finished = o.units.length - o.unfinished.length;
  if (finished === 0) return true;
  return o.failed.length >= 20 && o.failed.length * 4 >= finished;
}

/** Whether a trunk run passed: green, or every spec of its orchestration ran and passed. */
export const trunkGreen = (run: TrunkRun | null): boolean => run?.state === "success";

/**
 * The first finished status of `context` among `shas`, newest first, with its orchestration read when it failed. With
 * `asOf`, only statuses written by then count: what the base branch said when the lane ran (a replay of an old run).
 */
async function firstFinished(api: GhApi, fetchImpl: FetchImpl, tsio: string, repository: string, context: string, name: string, shas: string[], log: (m: string) => void, asOf: string | null = null): Promise<TrunkRun | null> {
  for (const sha of shas) {
    let rows: CommitStatus[];
    try {
      // Every page: a commit with many lanes and checks lists the trunk lane's row past the first 100.
      rows = await readStatuses(api, { repository, commit_sha: sha } as CompositeIdentity);
    } catch (e) {
      log(`statuses of ${sha.slice(0, 7)} unavailable: ${String(e).slice(0, 120)}`);
      continue;
    }
    const by = asOf ? Date.parse(asOf) : null;
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.context === context && (by == null || Date.parse(String((r as { created_at?: string }).created_at ?? "")) <= by));
    if (!row) continue;
    if (row.state === "pending") {
      // The merge base's own run has not finished. Its orchestration can already show a lane-wide failure (most specs
      // failed so far): that is the base branch's verdict, without waiting. Otherwise look further back.
      if (sha !== shas[0]) continue;
      const owner = statusOwner(row.target_url, repository);
      if (!owner) continue;
      try {
        const o = await fetchOrchestration(fetchImpl, tsio, { repository, commit_sha: sha, name, gh_run_id: owner.run, gh_run_attempt: owner.attempt });
        const going: TrunkRun = { sha, exact: true, state: "pending", description: String(row.description ?? ""), orchestration: o };
        if (o && trunkBroken(going)) return going;
      } catch (e) {
        log(`orchestration of the running trunk run on ${sha.slice(0, 7)} unavailable: ${String(e).slice(0, 120)}`);
      }
      continue;
    }
    const run: TrunkRun = { sha, exact: sha === shas[0], state: row.state, description: String(row.description ?? ""), orchestration: null };
    if (row.state !== "success") {
      const owner = statusOwner(row.target_url, repository);
      if (owner) {
        const id: CompositeIdentity = { repository, commit_sha: sha, name: nameInLink(row.target_url) ?? name, gh_run_id: owner.run, gh_run_attempt: owner.attempt };
        try {
          run.orchestration = await fetchOrchestration(fetchImpl, tsio, id);
        } catch (e) {
          log(`orchestration of the trunk run on ${sha.slice(0, 7)} unavailable: ${String(e).slice(0, 120)}`);
        }
      }
    }
    return run;
  }
  return null;
}

const shasFrom = (rows: unknown): string[] => (Array.isArray(rows) ? rows.map((c) => String((c as { sha?: string }).sha ?? "")).filter(Boolean) : []);

/**
 * The base branch's view of this lane. For a PR: its run at the merge base (walking back over commits that have none),
 * its run now, and how far behind the PR is. For a trunk run: its run on the commits before this one. Every read that
 * fails leaves its part null, and the caller names what it could not tell.
 */
export async function readBaseline({ api, fetchImpl, tsio, id, context, base, trunkRun, log, asOf = null, historyLane = null }: {
  api: GhApi; fetchImpl: FetchImpl; tsio: string; id: CompositeIdentity; context: string; base: string; trunkRun: boolean; log: (m: string) => void;
  /** Read the base branch as it was at this time (ISO), not now; null for now. */
  asOf?: string | null;
  /** The lane whose history this one is judged by (a subpath lane's standard lane): its runs count as peers too. */
  historyLane?: string | null;
}): Promise<Baseline> {
  const lane = trunkLane(context, String(id.name ?? ""), base);
  const out: Baseline = { context: lane.context, base, atBase: null, tip: null, behindBy: null, baseChanged: null, peers: null };
  if (!trunkRun) {
    const names = [String(id.name ?? ""), lane.name, ...(historyLane ? [historyLane, `${historyLane}-${base}`] : [])];
    out.peers = await readPeers({ fetchImpl, tsio, repository: id.repository, names, until: asOf ? Date.parse(asOf) : Date.now(), self: { commit: id.commit_sha, pr: id.gh_pr_number == null ? null : String(id.gh_pr_number) }, log });
  }
  try {
    if (trunkRun) {
      const before = shasFrom(await api("GET", `/repos/${id.repository}/commits?sha=${id.commit_sha}&per_page=${WALK + 1}`)).filter((s) => s !== id.commit_sha);
      out.atBase = await firstFinished(api, fetchImpl, tsio, id.repository, lane.context, lane.name, before, log, asOf);
      return out;
    }
    const cmp = (await api("GET", `/repos/${id.repository}/compare/${encodeURIComponent(base)}...${id.commit_sha}`)) as { merge_base_commit?: { sha?: string }; behind_by?: number } | null;
    const mergeBase = cmp?.merge_base_commit?.sha ?? null;
    out.behindBy = typeof cmp?.behind_by === "number" ? cmp.behind_by : null;
    if (mergeBase) {
      const back = shasFrom(await api("GET", `/repos/${id.repository}/commits?sha=${mergeBase}&per_page=${WALK}`));
      out.atBase = await firstFinished(api, fetchImpl, tsio, id.repository, lane.context, lane.name, back.length ? back : [mergeBase], log, asOf);
      if (out.behindBy) {
        try {
          const ahead = (await api("GET", `/repos/${id.repository}/compare/${mergeBase}...${encodeURIComponent(base)}`)) as { files?: { filename?: string }[] } | null;
          out.baseChanged = (ahead?.files ?? []).map((f) => String(f.filename ?? "")).filter(Boolean);
        } catch (e) {
          log(`base branch changes since the merge base unavailable: ${String(e).slice(0, 120)}`);
        }
      } else out.baseChanged = [];
    }
    const tip = shasFrom(await api("GET", `/repos/${id.repository}/commits?sha=${encodeURIComponent(base)}&per_page=${WALK}${asOf ? `&until=${encodeURIComponent(asOf)}` : ""}`));
    out.tip = await firstFinished(api, fetchImpl, tsio, id.repository, lane.context, lane.name, tip, log, asOf);
  } catch (e) {
    log(`base branch history unavailable: ${String(e).slice(0, 160)}`);
  }
  return out;
}
