// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { FetchImpl, GhApi } from "../../shared/src/github.ts";
import { fetchRun } from "../../shared/src/tsio.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { COMPARE_FILE_CAP, laneOf, repoPath } from "./config.ts";
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

interface ReportsPage {
  reports?: { id?: string | number; name: string; gh_run_id: string | number; gh_run_attempt: string | number }[];
}

/**
 * Facts for the failures the rules couldn't settle, each from its own source:
 * what changed on this PR since the test last passed here (GitHub compare), the
 * test's code near the failing line (GitHub contents), and the same test on the
 * run's other platforms (TSIO).
 */
export async function enrichFindings({
  findings,
  api,
  fetchImpl,
  base,
  id,
  testRoot,
  log = () => {},
}: {
  findings: Finding[];
  api: GhApi;
  fetchImpl: FetchImpl;
  base: string;
  id: CompositeIdentity;
  testRoot: string | null;
  log?: (message: string) => void;
}): Promise<void> {
  if (!findings.length) return;
  const compares = new Map<string, { files: { filename: string; patch: string }[]; complete: boolean } | null>();
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
  // The same test on the run's other platforms: one TSIO group per platform.
  try {
    const res = await fetchImpl(`${base}/api/v1/reports?${new URLSearchParams({ repository: id.repository, commit: id.commit_sha, limit: "20" })}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`TSIO ${res.status}`);
    const { reports = [] } = (await res.json()) as ReportsPage;
    const siblings = reports.filter((g) => String(g.gh_run_id) === String(id.gh_run_id) && String(g.gh_run_attempt) === String(id.gh_run_attempt) && g.name !== id.name).slice(0, 5);
    for (const g of siblings) {
      let other;
      try {
        other = await fetchRun(fetchImpl, base, { ...id, name: g.name }, null, { attempts: 1, ms: 0 });
      } catch (e) {
        log(`results of ${g.name} unavailable: ${String(e).slice(0, 160)}`);
        continue;
      }
      for (const f of findings) {
        const status = other.outcomes.get(JSON.stringify([f.file, f.title]));
        if (status) (f.other_lanes ??= []).push({ platform: laneOf(g.name), result: status });
      }
    }
  } catch (e) {
    log(`other platforms' results unavailable: ${String(e).slice(0, 160)}`);
  }
}
