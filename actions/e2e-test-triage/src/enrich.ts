// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { FetchImpl, GhApi } from "../../shared/src/github.ts";
import { FAILED_STATUSES, elsewhereKey, runFromGroups } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, RunResult, TsioGroup } from "../../shared/src/tsio.ts";
import { COMPARE_FILE_CAP, laneOf, laneOfReport, osOfReport, repoPath } from "./config.ts";
import { namesChangedFile } from "./pack.ts";
import type { Finding } from "./types.ts";

/** The failing line of the test's own file, from its error's stack. */
export function failingLine(f: { file?: string | null; error?: string | null }): number | null {
  const base = String(f.file ?? "").split("/").pop();
  if (!base) return null;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}:(\\d+)`).exec(String(f.error ?? ""));
  return m ? Number(m[1]) : null;
}

/** Numbered lines before and at the failing line, capped. */
export function codeExcerpt(text: string, line: number | null, before = 12, after = 2): string | null {
  const lines = String(text).split("\n");
  if (!line || line > lines.length) return null;
  const from = Math.max(1, line - before);
  const to = Math.min(lines.length, line + after);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${n}${n === line ? ">" : " "} ${lines[n - 1]}`);
  return out.join("\n").slice(0, 2500);
}

interface CompareFiles {
  files?: { filename: string; patch?: string | null }[];
}

interface ContentsReply {
  encoding?: string;
  content: string;
}


// How bad a platform's result was for this test: a failure over a failed try a retry recovered, over a pass.
const worseness = (result: string): number => (FAILED_STATUSES.has(result) ? 2 : result === "flaky" ? 1 : 0);

/** Adds one platform's result to a finding's other platforms, once per platform, keeping the worst result seen there. */
function addOtherLane(f: Finding, platform: string, result: string): void {
  const seen = f.other_lanes?.find((o) => o.platform === platform);
  if (seen) {
    if (worseness(result) > worseness(seen.result)) seen.result = result;
    return;
  }
  (f.other_lanes ??= []).push({ platform, result });
}

/**
 * The same test on the run's other reports, read from the group fetchRun already loaded (desktop: one group, one report
 * per OS). No call is made. A report is another platform only when its name differs from the finding's own.
 */
export function sameTestOnOtherReports(findings: Finding[], run: Pick<RunResult, "elsewhere">): void {
  for (const f of findings) {
    const own = f.report_name ?? "";
    const ownOs = osOfReport(own);
    // Another platform only: a report that names no OS, or the same OS, is a worker or retest of this lane, not a
    // second platform (mattermost reports are per worker; desktop shards one OS across reports).
    const others = (run.elsewhere.get(elsewhereKey(f.file, f.full_title || f.title)) ?? [])
      .filter((o) => ownOs != null && o.report !== "" && o.report !== own && osOfReport(o.report) != null && osOfReport(o.report) !== ownOs);
    const sorted = [...others].sort((a, b) => laneOfReport(a.report).localeCompare(laneOfReport(b.report)));
    for (const o of sorted) addOtherLane(f, laneOfReport(o.report), o.status);
  }
}

/** The sibling reads of one run share this long, in total: a read still running when it is spent is not awaited. */
export const SIBLING_DEADLINE_MS = 30_000;

/**
 * The same test on the run's sibling groups (mobile: one group per lane, all in one run). One list of the run's groups
 * is read for all of them, and each sibling's group is read from it (at most five). Every read shares one deadline. Asked
 * of a run with failures only, and by the caller, never on an infrastructure storm. Evidence for the summary and the
 * pack: no verdict depends on it.
 */
export async function siblingPlatforms({
  findings,
  fetchImpl,
  base,
  id,
  log = () => {},
  deadlineMs = SIBLING_DEADLINE_MS,
}: {
  findings: Finding[];
  fetchImpl: FetchImpl;
  base: string;
  id: CompositeIdentity;
  log?: (message: string) => void;
  deadlineMs?: number;
}): Promise<void> {
  if (!findings.length) return;
  const deadline = Date.now() + deadlineMs;
  // Resolves to the value, or to "late" when the deadline comes first. A read past it is not awaited.
  const bySomeDeadline = <T>(read: Promise<T>): Promise<T | "late"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([read, late]).finally(() => clearTimeout(timer));
  };
  const laterMessage = `other platforms' reads ran past the ${deadlineMs / 1000}s deadline`;
  try {
    const listed = await bySomeDeadline(
      (async () => {
        const res = await fetchImpl(`${base}/api/v1/reports?${new URLSearchParams({ repository: id.repository, commit: id.commit_sha, limit: "20" })}`, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`TSIO ${res.status}`);
        return ((await res.json()) as { reports?: TsioGroup[] }).reports ?? [];
      })(),
    );
    if (listed === "late") return log(`${laterMessage}; none was read`);
    const siblings = listed.filter((g) => String(g.gh_run_id) === String(id.gh_run_id) && String(g.gh_run_attempt) === String(id.gh_run_attempt) && g.name !== id.name).slice(0, 5);
    for (const g of siblings) {
      if (Date.now() >= deadline) return log(`${laterMessage}; ${g.name} and the rest were not read`);
      const read = await bySomeDeadline(runFromGroups(fetchImpl, base, { ...id, name: g.name }, listed, null, { attempts: 1, ms: 0 }).catch((e: unknown) => (log(`results of ${g.name} unavailable: ${String(e).slice(0, 160)}`), null)));
      if (read === "late") return log(`${laterMessage}; ${g.name} and the rest were not read`);
      if (!read) continue;
      // Matched by file and full title, as the run's own tests are: a same-named test in another block is another test.
      for (const f of findings) {
        const hits = read.elsewhere.get(elsewhereKey(f.file, f.full_title || f.title)) ?? [];
        for (const h of hits) addOtherLane(f, laneOf(g.name), h.status);
      }
    }
  } catch (e) {
    log(`other platforms' results unavailable: ${String(e).slice(0, 160)}`);
  }
}

// A patch without its hunk headers' line numbers: a base-branch change elsewhere in the file moves those, not the change.
const patchBody = (patch: string | null | undefined): string | null => (patch == null ? null : patch.replace(/^@@ [^@]* @@/gm, "@@"));

/**
 * Of the files changed since the last pass, those whose change is the PR's own: a file the PR's diff now or at the pass
 * lists, with patches that differ. The rest came in from the base branch. A patch too large to show counts as the PR's.
 */
export function prChangedSince(since: string[], prNow: { filename: string; patch?: string | null }[], prAtPass: { filename: string; patch?: string | null }[]): string[] {
  const now = new Map(prNow.map((f) => [f.filename, patchBody(f.patch)]));
  const then = new Map(prAtPass.map((f) => [f.filename, patchBody(f.patch)]));
  return since.filter((file) => {
    if (!now.has(file) && !then.has(file)) return false;
    const patchNow = now.get(file);
    const patchThen = then.get(file);
    return patchNow == null || patchThen == null || patchNow !== patchThen;
  });
}

/**
 * Facts for the failures the rules couldn't settle, each from its own source:
 * what changed on this PR since the test last passed here (GitHub compare), and of
 * that what is the PR's own change (its diff from the base branch now and at that
 * pass), and the test's code near the failing line (GitHub contents).
 */
export async function enrichFindings({
  findings,
  api,
  id,
  testRoot,
  prFiles = null,
  baseBranch = null,
  log = () => {},
}: {
  findings: Finding[];
  api: GhApi;
  id: CompositeIdentity;
  testRoot: string | null;
  /** The PR's diff from its base branch now, complete. Without it (or the base branch) nothing is told apart. */
  prFiles?: { filename: string; patch?: string | null }[] | null;
  baseBranch?: string | null;
  log?: (message: string) => void;
}): Promise<void> {
  if (!findings.length) return;
  const compares = new Map<string, { files: { filename: string; patch: string }[]; complete: boolean } | null>();
  // The PR's diff from its base branch as it was at each last pass, complete, or null.
  const atPass = new Map<string, { filename: string; patch?: string | null }[] | null>();
  const sources = new Map<string, string | null>();
  for (const f of findings) {
    const last = f.this_pr?.last_pass;
    if (last?.commit_sha) {
      const sha: string = last.commit_sha;
      if (sha === id.commit_sha) f.since_last_pass = { files: [], related: [], complete: true };
      else {
        if (!compares.has(sha)) {
          compares.set(sha, await (api("GET", `/repos/${id.repository}/compare/${sha}...${id.commit_sha}`) as Promise<unknown>)
            .then((raw) => {
              const c = raw as CompareFiles;
              const listed = (c.files ?? []).map((x) => ({ filename: x.filename, patch: x.patch ?? "" }));
              // The compare lists at most COMPARE_FILE_CAP files, so a list that reaches it may be cut off.
              return { files: listed, complete: listed.length < COMPARE_FILE_CAP };
            })
            .catch((e: unknown) => (log(`changes since ${sha.slice(0, 7)} unavailable: ${String(e).slice(0, 160)}`), null)));
        }
        const cmp = compares.get(sha);
        // With only a few changes since the pass, all of them go to the judge: a change
        // the error doesn't name can still be what broke the test.
        if (cmp) {
          const files = cmp.files;
          f.since_last_pass = {
            files: files.map((x) => x.filename),
            related: files.filter((x) => namesChangedFile(f, x.filename)).map((x) => ({ file: x.filename, patch: x.patch.slice(0, 2000) })),
            changes: files.length <= 10 ? files.slice(0, 5).map((x) => ({ file: x.filename, patch: x.patch.slice(0, 1500) })) : [],
            // A cut-off list cannot show that nothing related changed, so it never clears (see thisPrHistory).
            complete: cmp.complete,
          };
          if (cmp.complete && prFiles && baseBranch) {
            if (!atPass.has(sha)) {
              // The base branch's merge base with the pass commit is the one the PR had then: this is the PR's diff at the pass.
              atPass.set(sha, await (api("GET", `/repos/${id.repository}/compare/${encodeURIComponent(baseBranch)}...${sha}`) as Promise<unknown>)
                .then((raw) => {
                  const listed = (raw as CompareFiles).files ?? [];
                  return listed.length < COMPARE_FILE_CAP ? listed : null;
                })
                .catch((e: unknown) => (log(`this PR's changes at ${sha.slice(0, 7)} unavailable: ${String(e).slice(0, 160)}`), null)));
            }
            const then = atPass.get(sha);
            if (then) f.since_last_pass.pr_changed = prChangedSince(f.since_last_pass.files, prFiles, then);
          }
        }
      }
    }
    const line = failingLine(f);
    const path = f.repo_path ?? repoPath(testRoot, f.file);
    if (line && path) {
      if (!sources.has(path)) {
        sources.set(path, await (api("GET", `/repos/${id.repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${id.commit_sha}`) as Promise<unknown>)
          .then((raw) => {
            const c = raw as ContentsReply | null;
            return c?.encoding === "base64" ? Buffer.from(c.content, "base64").toString("utf8") : null;
          })
          .catch((e: unknown) => (log(`source of ${path} unavailable: ${String(e).slice(0, 160)}`), null)));
      }
      const text = sources.get(path);
      if (text) f.code_near_failure = codeExcerpt(text, line);
    }
  }
}
