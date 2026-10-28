// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { errorSignature } from "./classify.ts";
import type { ChangeSummary, EvidenceImage, Finding, Pack, PrRef, ThisPRHistory } from "./types.ts";

/** The message and the first few app stack frames, without framework noise. */
export function compactError(error: string | null | undefined, max = 800): string {
  const message: string[] = [];
  const frames: string[] = [];
  for (const line of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^at\s/.test(t)) {
      if (frames.length < 3 && !/node_modules|node:internal|\(internal\//.test(t)) frames.push(t);
    } else if (!frames.length && message.length < 12) message.push(line.trimEnd());
  }
  return [...message, ...frames].join("\n").trim().slice(0, max);
}

// Identifier-like: has "_" or "-" or an inner capital (server_form, channelBookmark).
// A plain word (config, index, utils) is as likely to be prose as a file name.
const identifierLike = (name: string): boolean => name.length > 3 && /[_-]|[a-z][A-Z]/.test(name);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A file's full name as a token of the text: a path or module reference, not the end of a longer name ("a.js" is not in "data.js").
const namedAsToken = (text: string, name: string): boolean => new RegExp(String.raw`(?:^|[\s/\\'"\`])${escapeRe(name)}(?=$|[\s'"\`:)/\\])`, "m").test(text);

// Whether a changed file is the failing spec or is named in the failure's error or spec
// path. An identifier-like file or folder name relates wherever it appears; a plain word
// only where it reads as a path or module ("e2e/config.js", "'./config'"), so "never
// reached the client config" does not name config.js.
export function namesChangedFile(finding: { file: string; repo_path?: string | null; error?: string | null }, filename: string): boolean {
  const ownPath = finding.repo_path ?? finding.file;
  const error = String(finding.error ?? "");
  const parts = filename.split("/");
  const base = parts.at(-1) ?? "";
  if (filename === ownPath || namedAsToken(error, base)) return true;
  const stem = base.split(".")[0] ?? "";
  const text = `${error}\n${finding.file}`.toLowerCase();
  if (identifierLike(stem) && text.includes(stem.toLowerCase())) return true;
  const folder = parts.at(-2) ?? "";
  if (identifierLike(folder) && error.toLowerCase().includes(folder.toLowerCase())) return true;
  if (stem.length <= 3) return false;
  return new RegExp(`(?:^|[\\\\/'"\`])${escapeRe(stem.toLowerCase())}(?=$|[.'"\`:)\\s\\\\/])`, "m").test(text);
}

/** One finding's neighbour in the same run, as the pack names other failures. */
export interface OtherFailure {
  class: string;
  title: string;
  file: string;
  signature: string | null;
}

/** What the change categories need from the run: the test root, and the run's failing specs. */
export interface ChangeContext {
  /** The test root as a repository path. "." (or empty) is the whole repository, so it names no harness folder. */
  testRoot: string | null;
  /** Repository paths of every failing spec in the run: a spec is e2e harness whatever the test root says. */
  failingSpecs: string[];
}

const NO_CHANGE_CONTEXT: ChangeContext = { testRoot: null, failingSpecs: [] };
const OTHER_FILE = /^(LICENSE[^/]*|CODEOWNERS|\.gitignore|\.gitattributes|\.editorconfig)$/;
// A directory prefix matches whole path segments: "detox/" holds "detox/x.ts", not "detox-app/x.ts".
const under = (file: string, dir: string): boolean => dir !== "" && dir !== "." && (file === dir || file.startsWith(`${dir}/`));

export type ChangeCategory = keyof ChangeSummary;

/**
 * Which category a changed file belongs to. Product is the default, so a file no rule names counts as product: the side
 * that never clears. `other` is only the repository's own metadata. A category describes the change; it clears nothing.
 */
export function changeCategory(filename: string, ctx: ChangeContext): ChangeCategory {
  if (under(filename, ".github")) return "ci";
  if (filename.toLowerCase().endsWith(".md") || under(filename, "docs")) return "docs";
  const root = String(ctx.testRoot ?? "").trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (ctx.failingSpecs.includes(filename) || under(filename, root)) return "e2e_harness";
  if (OTHER_FILE.test(filename)) return "other";
  return "product";
}

const EXAMPLES = 20;

/** The PR's changed files by category, with up to 20 example paths in each. */
export function changeSummary(names: string[], ctx: ChangeContext): ChangeSummary {
  const out: ChangeSummary = {
    product: { count: 0, examples: [] },
    e2e_harness: { count: 0, examples: [] },
    ci: { count: 0, examples: [] },
    docs: { count: 0, examples: [] },
    other: { count: 0, examples: [] },
  };
  for (const name of names) {
    const bucket = out[changeCategory(name, ctx)];
    bucket.count++;
    if (bucket.examples.length < EXAMPLES) bucket.examples.push(name);
  }
  return out;
}

/** What the model sees about one finding, and nothing else. */
export function buildPack(finding: Finding, compareFiles: { filename: string; patch?: string }[], pr: PrRef, others: OtherFailure[], ctx: ChangeContext = NO_CHANGE_CONTEXT): Pack {
  const names = compareFiles.map((f) => f.filename);
  const ownPath = finding.repo_path ?? finding.file;
  const changes = changeSummary(names, { ...ctx, failingSpecs: [...ctx.failingSpecs, ownPath] });
  const hunks: Pack["diff_hunks_of_files_named_in_error"] = [];
  for (const [index, f] of compareFiles.entries()) {
    // Only hunks related to the failure are sent: nothing else may be cited.
    if (namesChangedFile(finding, f.filename) && f.patch) hunks.push({ id: `hunk_${index}`, file: f.filename, related: true, patch: f.patch.slice(0, 4000) });
    if (hunks.length >= 8) break;
  }
  const signature = errorSignature(finding.error);
  const neighbours = others.filter((o) => o.title !== finding.title && (o.file === finding.file || (signature && o.signature === signature)));
  const pack: Pack = {
    test: { title: finding.title, full_title: finding.full_title ?? null, suite: finding.suite_title ?? null, file: finding.file, report_scope: finding.report_scope ?? null, report_name: finding.report_name ?? null, lane: pr.lane },
    error: compactError(finding.error),
    engine: { class: finding.class, reason: finding.reason },
    trunk_history_14d: { runs: finding.trunk.runs, fails: finding.trunk.fails, flaky: finding.trunk.flaky, latest: finding.trunk.latest },
    cross_pr_failures_14d: { id: "cross_pr", other_prs_where_this_test_failed: finding.cross_pr.examples, other_pr_runs_where_it_passed: finding.cross_pr.passes },
    pr: { number: pr.number, repository: pr.repository, title: pr.title, changed_file_count: names.length, changed_files: names.slice(0, 200), spec_file_changed_by_pr: names.includes(ownPath), change_summary: changes },
    diff_hunks_of_files_named_in_error: hunks,
    other_failures_in_same_run: neighbours.slice(0, 8).map(({ class: cls, title }) => ({ class: cls, title })),
    ...(finding.producer ? { producer_evidence: { id: "producer" as const, notes: finding.producer.notes, screenshots: finding.producer.images.map(({ name, sha256 }) => ({ name, sha256 })) } } : {}),
    ...(finding.this_pr?.runs ? { this_pr_history: thisPrHistory(finding) } : {}),
    ...(finding.other_lanes?.length ? { same_test_other_platforms_this_run: { id: "other_platforms" as const, results: finding.other_lanes } } : {}),
    ...(finding.earlier_failure ? { earlier_failure_same_spec: { id: "earlier_failure_same_spec" as const, title: finding.earlier_failure.title, error: finding.earlier_failure.error, class: finding.earlier_failure.class } } : {}),
    ...(finding.tries?.ran ? { tries_in_this_run: finding.tries } : {}),
    ...(finding.code_near_failure ? { test_code_near_failure: finding.code_near_failure } : {}),
  };
  if (finding.producer?.images.length) PACK_IMAGES.set(pack, finding.producer.images);
  return pack;
}

/** What a release branch's run is, for its packs (see releasePack). */
export interface ReleaseRef {
  repository: string;
  /** The run's name (its TSIO group): a mobile lane's names its server version when its reports don't. */
  name: string;
  branch: string;
  base: string;
  historyBranch: string;
  lane?: string;
}

// The server version a lane ran against, from its report or group name: "e2e-on-ubuntu-latest-11.11.3", "...-Server_12.0.1".
export const serverOf = (name: string | null | undefined): string | null => /(\d+\.\d+\.\d+(?:-rc\d+)?)/.exec(String(name ?? ""))?.[1] ?? null;

/**
 * A release branch's pack: the finding's own evidence as buildPack gives it, without a PR, and with the release's facts
 * (its branch, the default branch it was cut from, the lane's server version) and, when the default branch changed the
 * test since the cut, those commits and the file's diff.
 */
export function releasePack(finding: Finding, release: ReleaseRef, others: OtherFailure[], ctx: ChangeContext = NO_CHANGE_CONTEXT): Pack {
  const pack = buildPack(finding, [], { number: null, repository: release.repository, title: "", lane: release.lane }, others, ctx);
  const ood = finding.out_of_date && !finding.out_of_date.streak && !finding.out_of_date.fixed ? finding.out_of_date : null;
  const ref = (c: { sha: string; pr: number | null; date?: string | null }): string => `${c.pr ? `#${c.pr}` : c.sha.slice(0, 7)}${c.date ? ` (${c.date})` : ""}`;
  return {
    ...pack,
    release: { id: "release", branch: release.branch, base: release.base, history_branch: release.historyBranch, server: serverOf(finding.report_name) ?? serverOf(release.name) },
    ...(ood ? { base_change: { id: "base_change" as const, commits: [ood.commit, ...(ood.also ?? [])].filter((c): c is NonNullable<typeof c> => Boolean(c)).map(ref), diff: ood.diff ?? null } } : {}),
  };
}

// This PR's earlier runs of the test, and what changed between its last pass and now. Where the PR's own changes are
// known, a related file that changed only because the base branch was merged in is listed apart: trunk runs it.
function thisPrHistory(f: Finding): ThisPRHistory {
  const since = f.since_last_pass;
  const own = since?.pr_changed ? new Set(since.pr_changed) : null;
  const related = since ? since.related.filter((r) => !own || own.has(r.file)) : [];
  const fromBase = since && own ? since.related.filter((r) => !own.has(r.file)).map((r) => r.file) : [];
  return {
    id: "this_pr",
    earlier_runs_on_this_pr: f.this_pr.runs,
    passed: f.this_pr.passes,
    failed: f.this_pr.fails,
    latest: f.this_pr.latest,
    last_passed: f.this_pr.last_pass ? { commit: f.this_pr.last_pass.commit_sha?.slice(0, 7) ?? null, at: f.this_pr.last_pass.created_at } : null,
    ...(since
      ? { changed_since_last_pass: { file_count: since.files.length, files: since.files.slice(0, 30), complete: since.complete !== false, related_to_this_test: related.map((r) => r.file), related_changes: related.slice(0, 3), ...(since.changes?.length ? { changes: since.changes } : {}), ...(fromBase.length ? { related_from_base: fromBase.slice(0, 30) } : {}) } }
      : {}),
  };
}

const thisPrCitable = (pack: Pack): boolean => {
  const since = pack.this_pr_history?.changed_since_last_pass;
  if (pack.this_pr_history?.latest !== "passed" || since?.complete !== true || since.related_to_this_test.length) return false;
  return !since.related_from_base?.length || pack.trunk_history_14d?.latest === "passed";
};

// Screenshot bytes travel beside the pack; the pack (and cache key) carries hashes.
export const PACK_IMAGES = new WeakMap<Pack, EvidenceImage[]>();

// Ids a citation may name. Empty evidence is left out so it can't be cited.
export const evidenceIds = (pack: Pack): string[] => [
  "test",
  "error",
  "engine",
  "trunk_history_14d",
  ...(pack.cross_pr_failures_14d?.other_prs_where_this_test_failed?.length ? ["cross_pr"] : []),
  // A release run has no PR: its own facts take the PR's place.
  ...(pack.release ? ["release", ...(pack.base_change ? ["base_change"] : [])] : ["pr.changed_files"]),
  ...pack.diff_hunks_of_files_named_in_error.filter((h) => h.related).map((h) => h.id),
  ...(pack.producer_evidence?.notes || pack.producer_evidence?.screenshots?.length ? ["producer"] : []),
  // Citable only when this PR's most recent earlier run of the test passed (a pass before a later failure does not count),
  // and the complete list of what changed since that pass shows nothing related that the PR changed. A related change
  // the base branch brought in is allowed only while trunk's latest run of the test passed with it.
  ...(thisPrCitable(pack) ? ["this_pr"] : []),
  ...(pack.same_test_other_platforms_this_run ? ["other_platforms"] : []),
  ...(pack.earlier_failure_same_spec ? ["earlier_failure_same_spec"] : []),
];

// Evidence that can change a blocked finding's outcome: a related hunk (a blame or a veto), other PRs failing the
// same way, or this PR's own earlier pass. What the run recorded is left out: the PR's CI wrote it, so it supports
// a clear but never carries one. An earlier failure in the same spec clears only as chainClears allows, which reads
// the pack, not the ids.
export const CLEARING = (ids: string[]): boolean => ids.some((c) => c.startsWith("hunk_")) || ids.includes("cross_pr") || ids.includes("this_pr");

/**
 * Whether earlier_failure_same_spec can carry a flaky_environment clear: the earlier test failed on its environment, and
 * this test passed on another platform in this run. A PR that breaks the server fails every platform.
 */
export const chainClears = (pack: Pack): boolean =>
  pack.earlier_failure_same_spec?.class === "INFRA_ERROR" && (pack.same_test_other_platforms_this_run?.results ?? []).some((r) => r.result === "passed");
