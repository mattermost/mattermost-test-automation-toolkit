// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { FAILED_STATUSES } from "../../shared/src/tsio.ts";
import { DEFAULTS, laneOf } from "./config.ts";
import type { At, ChangedFile, ChangedByPR, Config, Finding, Observation, SpecRun, TestRef, TsioId } from "./types.ts";

// The last alternative: a mobile spec whose shard uploaded nothing never ran.
const INFRA_RE =
  /server (?:is )?not healthy|server at "[^"]*" is not healthy|No response from server|ECONNREFUSED|ENOTFOUND|net::ERR_|browser has been closed|browser has disconnected|Target page, context or browser has been closed|StatusRuntimeException: UNAVAILABLE|Failed to launch|Could not connect to|socket hang up|502 Bad Gateway|503 Service|Timed out waiting for the (?:server|app)|was assigned to a shard but produced no result|was not JSON|answered with an HTML page|HTML from server|server did not attach file|cloudflare-5xx-errors|service is not ready|failed: 408 Request timed out after \d+ ?ms/i;

export const isInfraError = (text: string | null | undefined): boolean => INFRA_RE.test(text ?? "");

/**
 * A failed row that stands for a shard with no results, not a test: nothing to judge, so the lane stays red for a re-run.
 * - desktop: e2e/utils/write-tsio-failure-stub.mjs writes "[<job name>] CI shard failure" in ci/tsio-shard-failure.ts
 *   when a job died before Playwright wrote results; TSIO keeps its error empty.
 * - mobile: detox/utils/merge-jest-results-for-tsio.js writes "spec did not run" for a spec whose shard uploaded nothing,
 *   and .github/scripts/write-tsio-failure-stub.mjs writes "CI infrastructure failure" in ci/<job>.stub when a job died
 *   before its reporter wrote results.
 */
export function isShardPlaceholder(t: { file?: string | null; title: string; error?: string | null }): boolean {
  const title = t.title.trim();
  const error = String(t.error ?? "").trim();
  if (!title) return true;
  if (/^\[[^\]]*\] CI shard failure$/.test(title) && (!error || /(?:^|\/)tsio-shard-failure\.ts$/.test(String(t.file ?? "")))) return true;
  if (title === "CI infrastructure failure" && /^ci\/[^/]+\.stub$/.test(String(t.file ?? ""))) return true;
  return isSpecNotRun(t);
}

/** The mobile placeholder: a spec assigned to a shard that produced no result for it, so it never ran. */
export function isSpecNotRun(t: { title: string; error?: string | null }): boolean {
  return t.title.trim() === "spec did not run" && /was assigned to a shard but produced no result/.test(String(t.error ?? "").trim());
}

/** A mobile spec skipped because its shard's Jest process stopped before reaching it, while other specs of the shard reported. */
export const isSpecStopped = (t: { title: string; error?: string | null }): boolean =>
  isSpecNotRun(t) && /its Jest process stopped before reaching this spec/.test(String(t.error ?? ""));

/**
 * A mobile spec its shard's Jest process stopped before (see isSpecStopped): flaky when it also did not run in another
 * recent run and passed where it ran (at least minTrunkRuns runs, failing in at most 1 of 20), or when it skipped every
 * test in all its recent runs (nothing was lost). It blocks when this change edits it (`edited`; null when that could
 * not be checked), and otherwise. Unreadable history (null) clears nothing. A shard that sent nothing is re-run instead.
 */
export function classifyNotRun(test: TestRef, runs: SpecRun[] | null, cfg: Config, groupId: TsioId | null, edited: boolean | null = false): Finding {
  const out = (cls: string, reason: string, blocking: boolean): Finding => ({
    ...test, class: cls, reason, blocking,
    trunk: { runs: 0, fails: 0, flaky: 0, passes: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  });
  const why = isSpecStopped(test) ? "Did not run: its Jest process stopped before reaching it" : "Did not run: its shard sent no result";
  if (edited === null) return out("NOT_RUN", `${why}, and whether this change edits it could not be checked.`, true);
  if (edited) return out("NOT_RUN", `${why}, and this change edits it, so it has to run.`, true);
  if (!runs) return out("NOT_RUN", `${why}, and its history could not be read.`, true);
  // TSIO may send the run's id as a number; history keeps ids as strings.
  const others = runs.filter((r) => r.group_id !== String(groupId));
  const notRun = others.filter((r) => r.status === "not_run").length;
  const ran = others.filter((r) => r.status === "passed" || r.status === "failed");
  const skipped = others.filter((r) => r.status === "skipped").length;
  const failed = ran.filter((r) => r.status === "failed").length;
  if (!ran.length && skipped >= cfg.minTrunkRuns)
    return out("FLAKY_NOT_RUN", `${why}, but it skipped every test in all ${skipped} recent runs where it was reached, so nothing was lost.`, false);
  // A failure in 1 run of 20 or fewer where it ran is the rest of the suite's noise, not this spec breaking.
  if (failed * 20 > ran.length) return out("NOT_RUN", `${why}, and it failed in ${failed} of the ${ran.length} recent runs where it ran.`, true);
  if (ran.length < cfg.minTrunkRuns) return out("NOT_RUN", `${why}, and it ran in only ${ran.length} recent runs (need ${cfg.minTrunkRuns}) to call it intermittent.`, true);
  if (!notRun) return out("NOT_RUN", `${why}, which it has not done in the last ${others.length} runs.`, true);
  return out("FLAKY_NOT_RUN", `${why}, as it did in ${notRun} of the last ${others.length} runs; it passed in ${failed ? `${ran.length - failed} of the` : "all"} ${ran.length} where it ran.`, false);
}

// Same-error trunk failures in a row, ended by passes, that read as a fix on trunk rather than a flake.
const FIXED_STREAK = 3;

export const EXONERATED = new Set(["BROKEN_ON_TRUNK", "FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
// On a trunk run only flakiness clears: a failure still there from last time is a
// standing breakage, and greening it would hide it.
export const EXONERATED_ON_TRUNK = new Set(["FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
export const exoneratedSet = (isTrunkRun: boolean): Set<string> => (isTrunkRun ? EXONERATED_ON_TRUNK : EXONERATED);

/**
 * Whether a finding carries evidence that the change under test caused it: the change edits the test, fails it on its
 * last commits and never on trunk (a PR streak), changes what the test looks for or a file its error names, fails it on
 * every try of this build while trunk and other PRs never do (a reproducible regression), or the judge blamed it from a
 * hunk. Only these may keep a PR's failure red (see settlePR); a base-branch fix never is one.
 */
export function causedByPR(f: Finding): boolean {
  if (f.out_of_date && f.class !== "OWNED_BY_PR") return false;
  return f.class === "OWNED_BY_PR" || Boolean(f.pr_streak) || Boolean(f.changed_by_pr) || f.untouched === false || Boolean(f.mass) ||
    f.decision === "adjudicator_blame" || f.decision === "adjudicator_veto" || f.decision === "reproducible_regression";
}
export const BORDERLINE = new Set(["REGRESSION", "INSUFFICIENT_DATA"]);
// An environment error still blocking is judged too: its repo's PRs can break their own environment, or it was held on a
// run that failed mostly on its environment.
export const JUDGED = new Set([...BORDERLINE, "INFRA_ERROR"]);

export interface ClassifyOptions {
  isTrunkRun?: boolean;
  groupId?: TsioId | null;
  trunkBranch?: string | null | undefined;
  /** The commit this run tested: its re-runs are not earlier commits of the PR. */
  commitSha?: string | null;
  /**
   * The PR's changed files with their patches, only when that list is complete: a PR streak names the PR's changed line
   * that holds what the test looked for (see changeTouchesFailure, prStreak).
   */
  patches?: ChangedFile[] | null;
}

// A selector's class, id or test id that names one element: it has "_" or "-" or an inner capital (no-results__title,
// adminConsoleWrapper), so a plain word (.active, #root) that many elements share is not one.
const ANCHOR_NAME = /^(?=.{6,})[A-Za-z_][\w-]*[A-Za-z0-9_]$/;
const namesOneElement = (name: string): boolean => ANCHOR_NAME.test(name) && /[_-]|[a-z][A-Z]/.test(name);
// Where an error names a selector: .class or #id after a quote, a space, a paren, a combinator or an element tag as
// chai-jquery prints one ('<div.SidebarChannel__dragHandle>'), never ".toHaveText" after "expect(locator)".
const SELECTOR_RE = /(?:^|[\s'"`(\[>+~,]|<[a-z][\w-]*)[.#]([A-Za-z_][\w-]*)/g;
const TEST_ID_RE = /(?:getByTestId\(\s*|data-testid\s*=\s*\\?|testid\s*[:=]\s*)['"`]([^'"`]+)['"`]/gi;
// The text a test waited for: Playwright's "Expected: ...", getByText and accessible names, Cypress's content.
const TEXT_RES = [
  /^Expected(?: string| substring| pattern)?:\s*"(.+)"\s*$/i,
  /getByText\(\s*(['"`])(.+?)\1/i,
  /\bname:\s*(['"`])(.+?)\1/i,
  /Expected to find content:\s*'(.+?)'/i,
  /to (?:have|contain) text\s*'(.+?)'/i,
];
/** Text as words to compare: ICU arguments ({limit, number}) and numbers (10,000) dropped, punctuation and case gone. */
const words = (text: string): string => text.toLowerCase().replace(/\{[^{}]*\}/g, " ").replace(/\d[\d,.]*/g, " ").replace(/[^\p{L}\s]+/gu, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a failure looked for, from its error's message (not its stack): element names and expected texts. */
export function failureAnchors(error: string | null | undefined): { names: { name: string; kind: "selector" | "test id" }[]; texts: string[] } {
  const message: string[] = [];
  for (const raw of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^at\s/.test(line)) break;
    if (line) message.push(line);
  }
  const names = new Map<string, "selector" | "test id">();
  const texts = new Set<string>();
  for (const line of message) {
    for (const m of line.matchAll(TEST_ID_RE)) if (m[1].length >= 4) names.set(m[1], "test id");
    for (const m of line.matchAll(SELECTOR_RE)) if (namesOneElement(m[1]) && !names.has(m[1])) names.set(m[1], "selector");
    for (const re of TEXT_RES) {
      const m = re.exec(line);
      const text = m?.[m.length - 1];
      // Three words or more: a short label ("Save", "Cancel") is in too many lines to point at one change.
      if (text && words(text).split(" ").length >= 3) texts.add(text);
    }
  }
  return { names: [...names].map(([name, kind]) => ({ name, kind })), texts: [...texts] };
}

// Unit tests and snapshots repeat what the product renders: a product file that changes it is named first.
const secondary = (file: string): boolean => /(?:^|\/)__snapshots__\/|\.snap$|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$/.test(file);
// A lock file repeats its manifest's dependency names and hashes thousands of times; the manifest is what the PR chose.
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Gemfile\.lock|Podfile\.lock)$/;
/** A changed file that can change what the app does: not a unit test, a snapshot, a lock file or documentation. */
export const isProductChange = (file: string): boolean => !secondary(file) && !LOCK_FILE.test(file) && !/\.md$/i.test(file);

/**
 * The first changed line of the PR (added or removed) that holds what the failure looked for: a selector's class or id,
 * a test id, or the expected text (compared as words, so "Only the latest 10,000 entries" matches the message
 * "Only the latest {limit, number} entries"). The failing spec itself is the edits-the-test rule's. Null when nothing
 * matches or no patch is known; a file GitHub shows no patch for is not searched.
 */
export function changeTouchesFailure(test: TestRef, files: ChangedFile[] | null | undefined): ChangedByPR | null {
  if (!files?.length) return null;
  const { names, texts } = failureAnchors(test.error);
  if (!names.length && !texts.length) return null;
  const spec = test.repo_path ?? test.file;
  const nameRes = names.map((a) => ({ ...a, re: new RegExp(`(?<![\\w-])${escapeRe(a.name)}(?![\\w-])`) }));
  const textWords = texts.map((t) => ({ text: t, words: words(t) }));
  const ordered = [...files].sort((a, b) => Number(secondary(a.filename)) - Number(secondary(b.filename)));
  for (const f of ordered) {
    if (!f.patch || f.filename === spec || LOCK_FILE.test(f.filename)) continue;
    const changedLines = f.patch.split("\n").filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)\s/.test(line));
    const holds = (body: string, a: { re?: RegExp; words?: string }): boolean => (a.re ? a.re.test(body) : Boolean(a.words) && words(body).includes(a.words!));
    // Removed: on a removed line and on no added line of the file (a moved or re-indented line is a change, not a removal).
    const removedHere = (a: { re?: RegExp; words?: string }): boolean => !changedLines.some((l) => l.startsWith("+") && holds(l.slice(1), a));
    // A kept anchor is shown on its added line (the PR's version); a removed one on the line that removed it.
    const shown = (line: string, a: { re?: RegExp; words?: string }): string =>
      (line.startsWith("-") ? changedLines.find((l) => l.startsWith("+") && holds(l.slice(1), a)) ?? line : line).slice(1).trim().slice(0, 200);
    for (const line of changedLines) {
      const body = line.slice(1);
      const gone = line.startsWith("-");
      const named = nameRes.find((a) => holds(body, a));
      if (named) return { file: f.filename, anchor: named.name, kind: named.kind, line: shown(line, named), removed: gone && removedHere(named) };
      const said = textWords.find((t) => holds(body, t));
      if (said) return { file: f.filename, anchor: said.text, kind: "text", line: shown(line, said), removed: gone && removedHere(said) };
    }
  }
  return null;
}

/** How a changed line names what the test looked for, in a sentence. */
export const describeChange = (c: ChangedByPR): string => (c.kind === "text" ? `the text "${c.anchor.slice(0, 120)}"` : `the ${c.kind} ${c.anchor}`);

/**
 * A PR streak: this PR's last commits failed the same way, and trunk never did. That is not a flake, so it is a
 * REGRESSION held red that no rule or model answer clears (see pr_streak); the judge may still blame the PR from a
 * changed hunk. It is out of date only where the base branch changed the test (or the code it runs through) since this
 * PR last merged it, which markOutOfDate checks and names; a branch a few commits behind is not, by itself, the cause.
 */
export function prStreak(f: Finding, streak: number, base: string, touched: ChangedByPR | null): Finding {
  return Object.assign(f, {
    class: "REGRESSION",
    blocking: true,
    pr_streak: streak,
    ...(touched ? { changed_by_pr: touched, untouched: false } : {}),
    reason: `Failed the same way on this PR's last ${streak} commits and never on ${base}, so it is not a flake${touched ? `; this PR changes ${describeChange(touched)} that the test looks for, in ${touched.file}` : ""}.`,
  });
}

/** Classify one failing test from its history and the PR's changed files. */
export function classify(
  test: TestRef,
  observations: Observation[],
  changedFiles: string[],
  cfg: Config = DEFAULTS,
  prNumber: number | string | null = null,
  lane: string | null = null,
  opts: ClassifyOptions = {},
): Finding {
  const { isTrunkRun = false, groupId = null, trunkBranch = null, commitSha = null, patches = null } = opts;
  const own = new Set(changedFiles);
  // A run is never part of its own history.
  const seen = groupId == null ? observations : observations.filter((o) => o.group_id !== groupId);
  // A skipped execution is not a trial.
  const ran = seen.filter((o) => o.status !== "skipped");
  const inLane = lane == null ? ran : ran.filter((o) => o.name == null || laneOf(o.name) === lane);
  // Compare as numbers: identities built with jq carry PR numbers as strings.
  const prOf = (o: Observation): number | null => (o.gh_pr_number == null || o.gh_pr_number === "" ? null : Number(o.gh_pr_number));
  const currentPR = prNumber == null ? null : Number(prNumber);
  // No PR number is not enough to be trunk: a pushed branch has none either.
  const trunk = inLane.filter((o) => prOf(o) == null && (trunkBranch == null || o.branch === trunkBranch));
  const others = inLane.filter((o) => prOf(o) != null && prOf(o) !== currentPR);
  // This PR's own earlier runs: a test that passed on an earlier commit of the PR,
  // with nothing related changed since, did not break because of the PR.
  const mine = currentPR == null ? [] : inLane.filter((o) => prOf(o) === currentPR);
  const minePassed = mine.filter((o) => o.status === "passed" || o.status === "flaky");
  const trunkFails = trunk.filter((o) => FAILED_STATUSES.has(o.status)).length;
  const trunkFlaky = trunk.filter((o) => o.status === "flaky").length;
  const trunkPasses = trunk.filter((o) => o.status === "passed").length;
  const latestTrunk = trunk[0] as Observation | undefined;
  // A test failing on trunk now: the run where the current streak began, and the pass before it.
  let streak = 0;
  while (streak < trunk.length && FAILED_STATUSES.has(trunk[streak].status)) streak++;
  const at = (o: Observation | undefined): At | null => (o ? { commit_sha: o.commit_sha ?? null, created_at: o.created_at ?? null } : null);
  // Other PRs' failures count only with the same failure (see failureKey): a distinctive error with the same
  // error, a timeout with the same stuck step, a bare timeout with a bare timeout. Nothing else is the same.
  const ownKey = failureKey(test.error);
  // Trunk's comparison keeps the distinctive error only (see otherError); the cross-PR rule uses failureKey.
  const ownSignature = errorSignature(test.error);
  const sameAsOwn = (excerpt: string | null | undefined): boolean => {
    const k = failureKey(excerpt);
    if (ownKey.kind === "stuck") {
      // A stuck step also has to agree on the old signature when both have one: the step key masks durations, the signature does not.
      return k.kind === "stuck" && k.key === ownKey.key && (ownSignature === errorSignature(excerpt) || (ownSignature == null && errorSignature(excerpt) == null));
    }
    return ownKey.kind === "distinctive" ? k.kind === ownKey.kind && k.key === ownKey.key : k.kind === ownKey.kind;
  };
  const crossFailures = others.filter((o) => FAILED_STATUSES.has(o.status) && sameAsOwn(o.error_excerpt));
  const failedPRs = [...new Set(crossFailures.map(prOf))];
  const otherPasses = others.filter((o) => o.status === "passed" || o.status === "flaky").length;
  // The distinctive errors this test had elsewhere (used by sameFailure, which keys on sameKey).
  const failureSignatures = [...new Set([...trunk, ...others]
    .filter((o) => FAILED_STATUSES.has(o.status))
    .map((o) => sameKey(o.error_excerpt))
    .filter((k): k is string => Boolean(k)))];
  const stats = {
    trunk: { runs: trunk.length, fails: trunkFails, flaky: trunkFlaky, passes: trunkPasses, latest: latestTrunk?.status ?? "" },
    cross_pr: {
      prs: failedPRs,
      examples: crossFailures
        .filter((o, i, all) => all.findIndex((x) => prOf(x) === prOf(o)) === i)
        .slice(0, 12)
        .map((o) => `PR ${prOf(o)} (${o.commit_sha?.slice(0, 7) ?? "unknown"}, ${o.created_at?.slice(5, 10) ?? "?"})`),
      passes: otherPasses,
    },
    failure_signatures: failureSignatures,
    trunk_break: streak ? { first_fail: at(trunk[streak - 1]), last_pass: at(trunk[streak]) } : null,
    this_pr: {
      runs: mine.length,
      passes: minePassed.length,
      fails: mine.filter((o) => FAILED_STATUSES.has(o.status)).length,
      last_pass: minePassed[0] ? { commit_sha: minePassed[0].commit_sha ?? null, created_at: minePassed[0].created_at ?? null } : null,
      latest: mine[0]?.status ?? "",
    },
  };
  const out = (cls: string, reason: string, blocking: boolean): Finding => ({ ...test, class: cls, reason, blocking, ...stats });
  // Trunk's instability clears a PR's failure only when it is the same failure. When every
  // trunk failure has an error to compare and none is this one, the PR may have broken the
  // test in a new way: it goes to the judge instead. Unknown trunk errors prove nothing either way. Ids are masked, so
  // another run's post in a selector is not another error.
  const otherError = (rows: Observation[]): string | null => {
    const mine = errorSignature(maskIds(test.error));
    if (mine == null || !rows.length) return null;
    const sigs = rows.map((o) => errorSignature(maskIds(o.error_excerpt)));
    return sigs.every(Boolean) && !sigs.includes(mine) ? (sigs[0] ?? null) : null;
  };
  if (own.has(test.repo_path ?? test.file))
    return out("OWNED_BY_PR", isTrunkRun
      ? `This commit changes ${test.file}; a failure in a spec the commit edits is not noise.`
      : `This PR changes ${test.file}; a failure in a spec the PR edits is the PR's to explain.`, true);
  // PR streak: this PR's last commits fail the same way, and trunk does not. The PR's own runs count (newest first)
  // while they fail with this first line; a pass or flaky run in between ends the streak. Commits count, not runs:
  // re-runs of one commit (this one included) are one. The current commit counts as one. Needs enough trunk history to
  // say "never on trunk". Held, never cleared, with the PR's changed line that holds what the test looked for when
  // there is one (see prStreak). Out of date only where markOutOfDate finds the base branch changed the test since.
  // Not where another PR failed the same way: a failure other changes share is more likely the test's or the
  // environment's than this PR's, so the rules below (the cross-PR flake, the judge) decide it instead.
  // Not an environment error: one that recurs on the PR's commits (a test-server outage across two pushes) is still
  // the environment's, decided by the INFRA_ERROR rule below. A PR that breaks its own server fails the lane's setup on
  // every worker, which the lane verdict names as the PR's.
  if (!isTrunkRun && currentPR != null && !test.identity_unresolved && !failedPRs.length && !isInfraError(test.error)) {
    const earlier = new Set<string>();
    for (const o of mine) {
      if (!FAILED_STATUSES.has(o.status) || !sameFirstLine(o.error_excerpt, test.error)) break;
      if (o.commit_sha && o.commit_sha !== commitSha) earlier.add(o.commit_sha);
    }
    const streak = earlier.size + 1;
    const trunkFailedSame = trunk.some((o) => FAILED_STATUSES.has(o.status) && sameFirstLine(o.error_excerpt, test.error));
    if (streak >= 2 && trunk.length >= cfg.minTrunkRuns && latestTrunk?.status === "passed" && !trunkFailedSame) {
      return prStreak(out("REGRESSION", "", true), streak, trunkBranch || "the default branch", changeTouchesFailure(test, patches));
    }
  }
  // The test's own error says the environment failed (the test server down or behind a proxy page,
  // a shard that never ran): history says nothing about that. Where the PR can't touch the
  // environment (an app against a separate test server) it clears; where it can (a server PR that
  // hangs its own server) it is named so the developer reruns, and stays blocking.
  if (isInfraError(test.error))
    return out("INFRA_ERROR", cfg.infraClears
      ? "Environment error, not the change: the test failed on its environment (see the error). Rerun when it recovers."
      : "Environment error: the test failed on its environment (see the error). Rerun; if it fails the same way again, the change may be the cause.", !cfg.infraClears);
  // History that names more than one test cannot clear any of them.
  if (test.identity_unresolved)
    return out(
      "INSUFFICIENT_DATA",
      `The available suite/report identity does not uniquely identify "${test.title}" in ${test.file}; history cannot clear it.`,
      true,
    );
  // How often trunk failed or flaked this test, smoothed: trunk's instability clears a failure only at pMin or above.
  const laplace = (trunkFails + trunkFlaky + 1) / (trunk.length + 2);
  /** Why trunk's instability says nothing about this failure, or null when it may be the same flake. */
  const notTrunksFlake = (): Finding | null => {
    const unstable = trunk.filter((o) => FAILED_STATUSES.has(o.status) || o.status === "flaky");
    // A failure with an error to compare is cleared only where trunk failed the same way: a trunk failure with another
    // error, or with none to compare (a hook timeout, an empty excerpt), says nothing about this one.
    if ((ownKey.kind === "distinctive" || ownKey.kind === "stuck") && !unstable.some((o) => sameFirstLine(maskIds(o.error_excerpt), maskIds(test.error)))) {
      const there = unstable.map((o) => errorFirstLine(o.error_excerpt)).find(Boolean);
      return out("REGRESSION", `Unstable on trunk (${trunkFails} failures, ${trunkFlaky} flaky passes in ${trunk.length} runs), but never with this error; ${there ? `there it failed with "${there.slice(0, 160)}"` : "there it left no error to compare"}.`, true);
    }
    // A bare timeout or an error with nothing to compare names no cause. One that failed every try here is cleared only
    // where trunk failed the same kind of way (the same bare timeout, or no error either): trunk's flakes of another
    // error say nothing about it. Unknown tries are left as before.
    if ((ownKey.kind === "bare" || ownKey.kind === "unusable") && test.tries && test.tries.ran > 0 && test.tries.failed === test.tries.ran &&
      !unstable.some((o) => failureKey(o.error_excerpt).kind === ownKey.kind)) {
      const how = ownKey.kind === "bare" ? "a timeout that names no step" : "no error to compare";
      return out("REGRESSION", `Unstable on trunk (${trunkFails} failures, ${trunkFlaky} flaky passes in ${trunk.length} runs), but this failed every try here with ${how}, and trunk never failed that way.`, true);
    }
    return null;
  };
  // On trunk, a failure already there last time is a streak and stays red.
  if (isTrunkRun) {
    if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status))
      return out("BROKEN_ON_TRUNK", `Still failing: the previous ${lane ?? "trunk"} run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}) failed this test too. That is a streak, not a flake.`, true);
    // A pass on retry does not end a streak: failing or needing a retry in each recent run, one of them a failure, is a
    // break a retry sometimes gets past. Failing and passing in turn is a flake.
    let rough = 0;
    while (rough < trunk.length && (FAILED_STATUSES.has(trunk[rough].status) || trunk[rough].status === "flaky")) rough++;
    if (rough >= 2 && trunk.slice(0, rough).some((o) => FAILED_STATUSES.has(o.status)))
      return out("BROKEN_ON_TRUNK", `Still failing: failed or passed only on retry in each of the previous ${rough} ${lane ?? "trunk"} runs. A pass on retry is not a fix.`, true);
    // Other PRs failing it the same way while trunk passes: the test's or the environment's flake, not this commit's
    // break. Two are enough here, where the PR rule wants crossPRMinPRs: trunk's own last run passed, so this commit is
    // the one change in question, and two unrelated changes failing it the same way already rule that change out.
    if (failedPRs.length >= Math.min(2, cfg.crossPRMinPRs) && trunkFails === 0 && trunkPasses > 0)
      return out("FLAKY_CROSS_PR", `Failed${ownKey.kind === "distinctive" ? " with the same error" : ownKey.kind === "stuck" ? " stuck at the same step" : ""} on ${failedPRs.length} PRs in the last ${cfg.crossPRRuns} runs (${stats.cross_pr.examples.slice(0, 3).join(", ")}) while ${trunkBranch || "trunk"} passed ${trunkPasses} of ${trunk.length}.`, false);
    // Intermittent clears only as a PR's failure would: often enough (pMin; one flake in 48 runs says little about a
    // failure now) and the same failure (its error, or for one that failed every try, the same kind of failure).
    if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0) {
      if (laplace < cfg.pMin)
        return out("REGRESSION", `Rarely unstable on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the previous ${trunk.length} runs, too few to call this failure a flake.`, true);
      const unlike = notTrunksFlake();
      if (unlike) return unlike;
      return out("FLAKY_ON_TRUNK", `Intermittent on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the previous ${trunk.length} runs, and the last one passed${latestTrunk?.status === "flaky" ? " on retry" : ""}.`, false);
    }
    if (trunk.length < cfg.minTrunkRuns)
      return out("INSUFFICIENT_DATA", `Only ${trunk.length} earlier trunk runs (need ${cfg.minTrunkRuns}); cannot tell a flake from a new break.`, true);
    return out("REGRESSION", `New on trunk: passed in all ${trunk.length} previous runs.`, true);
  }
  if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status)) {
    // A timeout is trunk's break only stuck where trunk's latest run is stuck (ids masked); a bare one never is.
    if (ownKey.kind === "bare" || (ownKey.kind === "stuck" && !sameFirstLine(maskIds(latestTrunk.error_excerpt), maskIds(test.error)))) {
      const there = errorFirstLine(latestTrunk.error_excerpt);
      return out("REGRESSION", `Trunk fails this test too, but ${ownKey.kind === "bare" ? "this timeout names no step to compare" : "not stuck at this step"}${there ? `; its latest run failed with "${there.slice(0, 160)}"` : ""}; this one may be the PR's.`, true);
    }
    const trunkError = otherError(trunk.slice(0, streak));
    if (trunkError)
      return out("REGRESSION", `Trunk fails this test too, but with another error ("${trunkError.slice(0, 160)}"); this one may be the PR's.`, true);
    return out("BROKEN_ON_TRUNK", `Trunk's latest run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}, ${latestTrunk.created_at?.slice(0, 10) ?? "unknown date"}) fails this test too.`, false);
  }
  // Trunk failed the same way run after run, and has passed since: a break trunk fixed, not a flake. markFixedOnTrunk
  // checks whether this PR has the fix.
  let recent = 0;
  while (recent < trunk.length && trunk[recent].status === "passed") recent++;
  let broken = 0;
  // A bare timeout or an unusable error is no evidence of the same break, so it ends the streak.
  const breakKey = (error: string | null | undefined): string | null => {
    const k = failureKey(error);
    return k.kind === "distinctive" || k.kind === "stuck" ? `${k.kind}:${maskIds(k.key)}` : null;
  };
  const ownBreak = breakKey(test.error);
  // The break key, not the signature: a stuck step matches only at that step, and ids in a selector are masked.
  const sameBreak = (excerpt: string | null | undefined): boolean => Boolean(excerpt) && ownBreak != null && breakKey(excerpt) === ownBreak;
  while (recent + broken < trunk.length && FAILED_STATUSES.has(trunk[recent + broken].status) && sameBreak(trunk[recent + broken].error_excerpt)) broken++;
  if (recent && broken >= FIXED_STREAK)
    return Object.assign(out("FIXED_ON_TRUNK", `${trunkBranch || "Trunk"} failed this test the same way in ${broken} runs in a row, then passed from ${trunk[recent - 1].commit_sha?.slice(0, 7) ?? "unknown"} on: trunk fixed it.`, true), {
      trunk_fixed: { last_fail: at(trunk[recent]), first_pass: at(trunk[recent - 1]) },
    });
  if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0 && laplace >= cfg.pMin && latestTrunk?.status !== "failed") {
    const unlike = notTrunksFlake();
    if (unlike) return unlike;
    return out("FLAKY_ON_TRUNK", `Unstable on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the last ${trunk.length} trunk runs.`, false);
  }
  // Require real trunk passes: trunkFails === 0 is also true with no trunk runs.
  if (failedPRs.length >= cfg.crossPRMinPRs && trunkFails === 0 && trunkPasses > 0)
    return out("FLAKY_CROSS_PR", `Failed${ownKey.kind === "distinctive" ? " with the same error" : ownKey.kind === "stuck" ? " stuck at the same step" : ownKey.kind === "bare" ? " with the same bare timeout" : ""} on ${failedPRs.length} other PRs in the last ${cfg.crossPRRuns} runs (${stats.cross_pr.examples.slice(0, 3).join(", ")}) while trunk stayed green.`, false);
  if (trunk.length < cfg.minTrunkRuns)
    return out("INSUFFICIENT_DATA", `Only ${trunk.length} trunk runs found (need ${cfg.minTrunkRuns}); history cannot clear it.`, true);
  return out("REGRESSION", `Fails here, passes on trunk (${trunkPasses}/${trunk.length}) and was not failing on other PRs enough to call it flaky (${failedPRs.length}).`, true);
}

// A message that only says time ran out names no cause, so two timeouts in one
// spec are not evidence of one failure.
const GENERIC_ERROR_RE = /^(?:\w*error:\s*)?(?:thrown:\s*)?["']?(?:test timeout|exceeded timeout|timeout of|timed out)/i;

/**
 * What a failure says, not where: the message's first lines without the stack,
 * generated ids masked. Null when too short or generic to compare.
 */
export function errorSignature(error: string | null | undefined): string | null {
  const kept: string[] = [];
  for (const line of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    if (/^at\s/.test(line) || /^call log:/i.test(line)) break;
    kept.push(line);
    if (kept.length === 3) break;
  }
  if (!kept.length || GENERIC_ERROR_RE.test(kept[0])) return null;
  const sig = kept.join(" ")
    .replace(/\s+at\s+(?:async\s+)?(?:\S+\s+)?\(?(?:file:\/\/)?(?:[A-Za-z]:)?[\\/].*$/, "")
    // Generated names differ per run: mixed letter-digit tokens and long numbers.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return sig.length >= 30 ? sig : null;
}

/**
 * What a failure says, for the cross-PR rule and sameFailure. A timeout (its first line is one: Playwright's
 * "Timeout Nms exceeded", "Test timeout of Nms", Jest's "Exceeded timeout of N ms", Detox's "Timed out ...")
 * is compared by where it got stuck: the action and the locator, selector, expectation or event it waited on,
 * with generated ids and durations masked. A timeout with no such step is "bare": it is the same failure only as
 * another bare timeout. Any other error is "distinctive" when errorSignature gives it one, and otherwise
 * "unusable" (empty or too short), which is the same failure only as another unusable error.
 */
export type FailureKind = "distinctive" | "stuck" | "bare" | "unusable";
export interface FailureKey {
  kind: FailureKind;
  key: string | null;
}

const TIMEOUT_FIRST_RE = /^(?:\w*error:\s*)?(?:thrown:\s*)?(?:test failed:\s*)?["']?(?:test timeout|exceeded timeout|timeout of\b|timed out|[\d.]+\s*sec timeout|[\w.]+:\s*timeout\s*[\d.]+\s*ms|timeout\s*[\d.]+\s*ms)/i;
const TIMEOUT_ACTION_RE = /^(?:\w*error:\s*)?([\w.]+):\s*timeout\s*[\d.]+\s*ms/i;
// Where the message is about its own code frame or stack, it has said all it will.
const FRAME_RE = /^at\s|^(?:>\s*)?\d+\s*\||^\||^\^|^Add a timeout value/;
// What a timeout waited on, from its first line when the call log did not name it.
const FIRST_LINE_STEP: [RegExp, (m: RegExpExecArray) => string | null][] = [
  [/timed out (?:after waiting for|waiting for)\s+(.+)$/i, (m) => (/^[\d.,\s]*(?:ms|sec|s)?\s*$/i.test(m[1]) ? null : `waiting for ${m[1]}`)],
  [/timed out retrying after [\d.]+\s*ms:\s*(.+)$/i, (m) => `retrying ${m[1].replace(/,\s*but the text was.*$/, "")}`],
  [/timeout expired without matching of given matcher:\s*(.+)$/i, (m) => `matcher ${m[1]}`],
  [/timed out while waiting for expectation:\s*(.+?)(?:\s+TIMEOUT\(.*\))?$/i, (m) => `expectation ${m[1]}`],
  [/while waiting for event\s+("[^"]*"|\S+)/i, (m) => `event ${m[1]}`],
];

/** A timeout's stuck step, normalised; null when its message names neither an action nor a step. */
function stuckStep(lines: string[]): string | null {
  const first = lines[0];
  const action = TIMEOUT_ACTION_RE.exec(first)?.[1] ?? null;
  let target: string | null = null;
  for (const l of [...lines.slice(1), first]) {
    const w = /^-?\s*(waiting for\s+.+)$/i.exec(l);
    if (w) {
      target = w[1];
      break;
    }
  }
  for (const [re, describe] of FIRST_LINE_STEP) {
    if (target) break;
    const m = re.exec(first);
    if (m) target = describe(m);
  }
  if (!action && !target) return null;
  return [action ? `action ${action}` : null, target]
    .filter(Boolean)
    .join(" ")
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\b\d+(?:\.\d+)?\s*sec\b/gi, "<n>sec")
    .replace(/\s+/g, " ")
    .trim();
}

// A Mattermost id (26 lowercase letters and digits) differs per run, also where a selector joins it with "_".
const maskIds = (error: string | null | undefined): string => String(error ?? "").replace(/(?<![a-z0-9])[a-z0-9]{26}(?![a-z0-9])/g, "<id>");

/**
 * Whether two failures show the same first line of error: the same distinctive error (errorSignature), or the same stuck
 * step of a timeout (failureKey). A bare timeout or a message with no usable text is never the same as another.
 */
export function sameFirstLine(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = failureKey(a);
  const kb = failureKey(b);
  return (ka.kind === "distinctive" || ka.kind === "stuck") && kb.kind === ka.kind && kb.key === ka.key;
}

export function failureKey(error: string | null | undefined): FailureKey {
  const lines: string[] = [];
  for (const raw of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (lines.length && FRAME_RE.test(l)) break;
    lines.push(l);
  }
  if (lines.length && TIMEOUT_FIRST_RE.test(lines[0])) {
    const step = stuckStep(lines);
    return step ? { kind: "stuck", key: step } : { kind: "bare", key: null };
  }
  const sig = errorSignature(error);
  return sig ? { kind: "distinctive", key: sig } : { kind: "unusable", key: null };
}

/**
 * sameFailure's key: the old signature only. A stuck step names a place, not a cause, and is too coarse across
 * tests in one spec: a failure stuck on the same step as a cleared one is not thereby the same failure.
 */
function sameKey(error: string | null | undefined): string | null {
  return failureKey(error).kind === "distinctive" ? errorSignature(error) : null;
}

/**
 * A blocked failure with the same spec and error as a cleared one shares its
 * cause, if the cleared test's own history shows that error without this PR.
 * Typical case: a shared setup breaks, and only some of the suite's tests are
 * old enough to have history. Runs after the judge, on PR runs only. An environment error is not
 * matched: one still blocking is cleared by the judge's answer or not at all.
 */
export function sameFailure(findings: Finding[]): Finding[] {
  const blamed = (f: Finding): boolean => f.judge?.cause === "caused_by_pr";
  const keyOf = (f: Finding): string | null => {
    const sig = sameKey(f.error);
    return sig ? JSON.stringify([f.repo_path ?? f.file, sig]) : null;
  };
  const anchors = new Map<string | null, Finding>();
  for (const f of findings) {
    if (f.blocking || !EXONERATED.has(f.class) || f.identity_unresolved || blamed(f)) continue;
    const sig = sameKey(f.error);
    if (!sig || !(f.failure_signatures ?? []).includes(sig)) continue;
    const k = keyOf(f);
    if (!anchors.has(k)) anchors.set(k, f);
  }
  for (const f of findings) {
    // A failure that failed on this PR's last commits and never on trunk is no flake, whatever another test shows.
    if (!f.blocking || !BORDERLINE.has(f.class) || f.identity_unresolved || f.decision === "evidence_incomplete" || f.failed_everywhere || f.pr_streak || blamed(f)) continue;
    const k = keyOf(f);
    const anchor = k ? anchors.get(k) : undefined;
    if (!anchor) continue;
    Object.assign(f, {
      class: "SAME_FAILURE_AS_CLEARED",
      blocking: false,
      decision: "same_failure",
      same_as: anchor.full_title || anchor.title,
      same_as_class: anchor.class,
      reason: `Fails with the same error as "${anchor.title}" in this spec, which history cleared (${anchor.class}): ${anchor.reason}`,
    });
  }
  return findings;
}

/**
 * A failure that failed every try here and on another platform of this commit is not flakiness: a flake rarely does
 * that, a change to shared code does. Neither the model nor sameFailure may clear it, except on a release branch, where the
 * model may still unblock it (decideRelease). A rules clear is undone too, even
 * one that trunk's flakes with the same error support: a flake of one platform's error on trunk says nothing about the
 * same test failing on two platforms of this commit. A held flaky clear becomes REGRESSION; a blocking REGRESSION or
 * INSUFFICIENT_DATA keeps its class. A break on trunk, an environment error and a failure this change owns are not in
 * the set checked here, so they keep their calls. Out-of-date is not checked here: markOutOfDate runs after this, so an
 * out-of-date failure is held too and then gets its out-of-date mark as usual.
 */
export function holdFailedEverywhere(findings: Finding[]): Finding[] {
  const flaky = new Set(["FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
  for (const f of findings) {
    if (!(BORDERLINE.has(f.class) || flaky.has(f.class)) || f.identity_unresolved || !f.tries || f.tries.ran < 2 || f.tries.failed !== f.tries.ran) continue;
    const on = [...new Set((f.other_lanes ?? []).filter((o) => FAILED_STATUSES.has(o.result)).map((o) => o.platform))];
    if (!on.length) continue;
    const why = `Failed all ${f.tries.ran} tries here and failed on ${on.join(" and ")} on this same commit; a flake rarely does that.`;
    Object.assign(f, {
      ...(flaky.has(f.class) || !f.blocking ? { class: "REGRESSION" } : {}),
      blocking: true,
      failed_everywhere: on,
      reason: `${why} ${flaky.has(f.class) ? `Its clear does not stand: ${f.reason}` : f.reason}`,
    });
  }
  return findings;
}

export const errorFirstLine = (error: string | null | undefined): string =>
  (String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 200);

// Where neither error has a failure key, their first lines tell them apart.
const differentError = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const ka = failureKey(a);
  const kb = failureKey(b);
  return ka.kind !== kb.kind || ka.key !== kb.key || (ka.key == null && errorFirstLine(a) !== errorFirstLine(b));
};

/**
 * Marks each finding with the earliest test of its spec that failed before it in this run with another error: a later
 * test often fails only because an earlier one's setup failed. Only tests of one known report with distinct ordinals
 * chain: another report ran on another machine, and TSIO lists failures in no fixed order. Evidence only: it changes no
 * class or blocking (see chainClears).
 */
export function markEarlierFailures(findings: Finding[]): Finding[] {
  const earlier = (a: Finding, b: Finding): boolean =>
    Boolean(a.report_name) && a.report_name === b.report_name && typeof a.ordinal === "number" && typeof b.ordinal === "number" && a.ordinal < b.ordinal;
  for (const f of findings) {
    const spec = f.repo_path ?? f.file;
    let first: Finding | null = null;
    for (const o of findings) {
      if (o === f || (o.repo_path ?? o.file) !== spec || !earlier(o, f) || !differentError(o.error, f.error)) continue;
      if (!first || earlier(o, first)) first = o;
    }
    if (first) f.earlier_failure = { title: (first.full_title || first.title).slice(0, 200), error: errorFirstLine(first.error), class: first.class };
  }
  return findings;
}

/** Run-level infrastructure call: many failures, or most failures share an infra signature. */
export function infraVerdict(failing: readonly { error?: string | null }[], cfg: Config = DEFAULTS): string | null {
  if (!failing.length) return null;
  const infra = failing.filter((t) => isInfraError(t.error)).length;
  if (infra >= Math.max(3, Math.ceil(failing.length / 2)))
    return `${infra} of ${failing.length} failures are infrastructure errors (server health, connectivity, device, shard that never ran); rerun when the environment recovers.`;
  if (failing.length >= cfg.infraMinFailures)
    return `${failing.length} tests failed in one run; check for a shared environment, build or product failure first.`;
  return null;
}
