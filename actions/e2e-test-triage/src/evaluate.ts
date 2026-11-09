// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { identityKey, missingReports } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, RunResult } from "../../shared/src/tsio.ts";
import { BORDERLINE, causedByPR, changeTouchesFailure, classify, classifyNotRun, errorSignature, holdFailedEverywhere, infraVerdict, isShardPlaceholder, isSpecNotRun, isSpecStopped, isProductChange, JUDGED, markEarlierFailures, sameFailure } from "./classify.ts";
import { DEFAULTS, historyLane, repoPath } from "./config.ts";
import { commonSenseClear } from "./common-sense.ts";
import { sameTestOnOtherReports } from "./enrich.ts";
import { evidenceFor } from "./evidence.ts";
import { buildPack, namesChangedFile, releasePack } from "./pack.ts";
import type { OtherFailure, ReleaseRef } from "./pack.ts";
import { judge } from "./decision.ts";
import type { OutOfDateResult } from "./history.ts";
import { newLedger } from "./pricing.ts";
import type { AskFn, ChangedFile, Config, Diff, Evidence, Finding, HistoryLike, Ledger, PrRef, SpecHistory } from "./types.ts";

/** What evaluateRun returns: the verdict, the findings, and the facts the summary needs. */
export interface EvaluatedRun {
  verdict: string;
  findings: Finding[];
  infra: string | null;
  counts: RunResult["counts"];
  ai: Ledger;
  historyTruncated?: boolean;
  ownershipUnknown?: boolean;
  missing: { text: string; short: string } | null;
  /**
   * Failures that are shard placeholders, not tests (see isShardPlaceholder): none is classified or sent to the model,
   * and the lane is red for them. Set beside findings when a run has both.
   */
  unnamed?: number;
  /** Every spec that never ran (see isSpecNotRun): counted as not run, not failed, whether judged or re-run. */
  notRun?: number;
  /** Of the placeholders, the specs that never ran and are re-run because their history did not clear them. */
  notRunRerun?: number;
}

export interface EvaluateParams {
  run: RunResult;
  id: CompositeIdentity;
  prNumber: number | null;
  history: HistoryLike;
  diff: Diff;
  trunkBranch: string | null | undefined;
  /** A run with no PR on a branch other than the default: the default branch, which its copies of the tests are checked against. */
  branchBase?: string | null;
  /** That run's own branch, for the model's question (see releasePack). */
  branchName?: string | null;
  testRoot: string | null;
  cfg?: Config;
  prTitle?: string;
  lane?: string;
  ask?: AskFn | null;
  log?: (message: string) => void;
  evidence?: Evidence[];
  enrich?: ((findings: Finding[]) => Promise<void>) | null;
  /** The same test on the run's sibling groups (see siblingPlatforms). Asked of every failing run, model or not. */
  otherPlatforms?: ((findings: Finding[]) => Promise<void>) | null;
  outOfDate?: ((findings: Finding[]) => Promise<OutOfDateResult>) | null;
  fixedOnTrunk?: ((findings: Finding[]) => Promise<void>) | null;
  brokeBy?: ((findings: Finding[]) => Promise<void>) | null;
  /** Past runs of the specs a stopped Jest process skipped (see classifyNotRun); null when they could not be read. */
  specHistory?: SpecHistory | null;
}

/** A run flagged as a whole (see infraVerdict) is red for it while any failure still blocks, or when none is named. */
export const verdictOf = (findings: Finding[], infra: string | null | undefined): string => {
  const blocked = findings.some((f) => f.blocking);
  if (infra && (blocked || !findings.length)) return "ACTION_REQUIRED";
  return blocked ? "FAILURE" : "SUCCESS";
};

/** Decide a run from evidence already fetched. Writes nothing. */
export async function evaluateRun({
  run,
  id,
  prNumber,
  history,
  diff,
  trunkBranch,
  branchBase = null,
  branchName = null,
  testRoot,
  cfg = DEFAULTS,
  prTitle = "",
  lane = id.name,
  ask,
  log = () => {},
  evidence = [],
  enrich = null,
  otherPlatforms = null,
  outOfDate = null,
  fixedOnTrunk = null,
  brokeBy = null,
  specHistory = null,
}: EvaluateParams): Promise<EvaluatedRun> {
  const isTrunkRun = prNumber == null;
  // A shard placeholder (no test name, a desktop shard stub, a mobile spec that did not run) has no history to read and
  // nothing to show the model. The run is red for it: it is counted, and not classified, asked or flagged.
  const tests = run.failing.filter((t) => !isShardPlaceholder(t));
  const result: EvaluatedRun = { verdict: "SUCCESS", findings: [], infra: infraVerdict(tests, cfg), counts: run.counts, ai: newLedger(), missing: null };
  // A shard that sent nothing ran none of its specs: they stay placeholders and the shard is re-run. A spec its shard's
  // Jest process stopped before (the shard ran) is judged by its own history (see classifyNotRun), never re-run for.
  // Like OWNED_BY_PR: a spec this change edits has to run; unknown when the change list or the test root is.
  const changedFiles = new Set((diff.files ?? []).map((f: ChangedFile) => f.filename));
  const editedBy = (file: string): boolean | null => {
    const path = repoPath(testRoot, file);
    return diff.ok && path != null ? changedFiles.has(path) : null;
  };
  const judgedNotRun = run.failing.filter(isSpecStopped).map((t) => classifyNotRun(t, specHistory && !specHistory.truncated ? specHistory.byFile.get(t.file) ?? [] : null, cfg, run.group_id, editedBy(t.file)));
  const placeholders = run.failing.length - tests.length - judgedNotRun.length;
  if (placeholders) result.unnamed = placeholders;
  const notRunRerun = run.failing.filter((t) => isSpecNotRun(t) && !isSpecStopped(t)).length;
  if (notRunRerun) result.notRunRerun = notRunRerun;
  const notRun = run.failing.filter(isSpecNotRun).length;
  if (notRun) result.notRun = notRun;
  // A run-level infra call still names each failure, and the model is asked as on any run: the run is red while
  // any failure still blocks.
  if (tests.length) {
    const files = (diff.files ?? []).map((f: ChangedFile) => ({ filename: f.filename, patch: f.patch }));
    const changed = files.map((f) => f.filename);
    const withPaths = tests.map((t) => ({ ...t, repo_path: repoPath(testRoot, t.file) }));
    const changeContext = { testRoot, failingSpecs: withPaths.map((t) => t.repo_path).filter((p): p is string => Boolean(p)) };
    const unresolved = (t: { identity_unresolved?: boolean }, key: string): boolean => Boolean(t.identity_unresolved) || (history.ambiguous?.has(key) ?? false);
    result.findings = withPaths.map((t) => {
      const key = identityKey(t);
      return classify(unresolved(t, key) ? { ...t, identity_unresolved: true } : t, history.get(key) ?? [], changed, cfg, prNumber, historyLane(id, cfg), {
        isTrunkRun,
        groupId: run.group_id,
        trunkBranch,
        commitSha: id.commit_sha,
        // A cut-off list could hide the change: only a complete one may name the PR's line.
        patches: diff.ok ? files : null,
      });
    });
    // A PR that breaks its own server fails every test on the environment, so on a flagged run only the judge clears
    // an environment error.
    if (result.infra) {
      const why = /infrastructure errors/.test(result.infra) ? "most of this run failed on its environment" : "many tests failed in this run";
      for (const f of result.findings)
        if (f.class === "INFRA_ERROR" && !f.blocking)
          Object.assign(f, { blocking: true, reason: `Environment error, held for the judge: ${why}, which this change could also have caused (see the error).` });
    }
    for (const f of result.findings) {
      const producer = evidenceFor(f, evidence);
      if (producer) f.producer = producer;
      // "Likely regression" only if the PR touches the test or a file its error names.
      // A change that holds what the test looked for (changed_by_pr) touches it too.
      if (prNumber && diff.ok && f.class === "REGRESSION") f.untouched = !f.changed_by_pr && !changed.some((name) => namesChangedFile(f, name));
      // A PR streak's likely files, for the summary when no judge names one: the change that holds what the test looked
      // for, then files its error names, then the PR's other product changes.
      if (f.pr_streak && diff.ok) {
        const own = f.repo_path ?? f.file;
        const rank = (name: string): number => (name === f.changed_by_pr?.file ? 0 : namesChangedFile(f, name) ? 1 : 2);
        f.suspects = changed.filter((name) => name !== own && isProductChange(name)).sort((a, b) => rank(a) - rank(b)).slice(0, 3);
      }
    }
    // Incomplete evidence makes the rules unsound: nothing clears, and the model isn't asked.
    const blind =
      history.unavailable ? `TSIO's history could not be read (${history.unavailable})`
      : history.truncated ? "History was truncated at the page cap"
      : !diff.ok ? "The list of changed files could not be read in full"
      : testRoot == null ? "No test root is configured, so whether this PR edits the failing spec cannot be determined"
      : !trunkBranch ? "The trunk branch is unknown, so trunk history cannot be told from another branch's"
      : history.reportUnknown ? "History does not identify which report a past run came from, so another platform's history cannot be ruled out"
      : null;
    if (blind) {
      result.historyTruncated = Boolean(history.truncated);
      result.ownershipUnknown = !diff.ok;
      for (const f of result.findings)
        if (f.class !== "OWNED_BY_PR") Object.assign(f, { blocking: true, decision: "evidence_incomplete", reason: `${f.reason} ${blind}, so this could not be confirmed.` });
    }
    // The same test on the run's other platforms: this run's own reports (no call), then its sibling groups. The summary
    // and the pack read it, and a failure that failed every try here and on another platform is held.
    sameTestOnOtherReports(result.findings, run, Boolean(branchBase));
    // Not on an infrastructure storm: the run is red for its environment, and sibling reads would only add calls.
    if (otherPlatforms && !result.infra) {
      try {
        await otherPlatforms(result.findings);
      } catch (e) {
        log(`other platforms unavailable: ${String(e).slice(0, 200)}`);
      }
    }
    holdFailedEverywhere(result.findings);
    // A finding the hold just turned into a REGRESSION gets the same check as one classified so: does the PR touch the
    // test or a file its error names? (Set above only for findings that were already REGRESSION.)
    for (const f of result.findings)
      if (prNumber && diff.ok && f.class === "REGRESSION" && f.untouched === undefined) f.untouched = !changed.some((name) => namesChangedFile(f, name));
    // A release branch judged on its default branch's history: another line of code, so nothing clears on it.
    if (branchBase && trunkBranch === branchBase)
      for (const f of result.findings)
        if (!f.blocking && f.class !== "INFRA_ERROR")
          Object.assign(f, { blocking: true, reason: `${f.reason} That is ${branchBase}'s history, not this branch's, so it does not clear a failure here.` });
    // A failure in a test the base branch changed after this PR last merged it ran
    // the PR's old copy: it stays red, with "merge <base>" as the next step, and
    // is not sent to the model. A release branch's run is checked the same way
    // against the default branch, and for every held failure, whatever its history.
    if (!blind && (prNumber || branchBase) && outOfDate) {
      const candidates = result.findings.filter((f) => f.blocking && (branchBase ? f.class !== "OWNED_BY_PR" : BORDERLINE.has(f.class)) && !f.identity_unresolved && f.repo_path);
      // A failure whose change list is cut off or unreadable cannot be shown unchanged: it is unchecked, so red and never judged.
      const unchecked = (list: Finding[], because: string): void => {
        for (const f of list) Object.assign(f, { decision: "evidence_incomplete", reason: `${f.reason} ${because}; this could not be confirmed.` });
      };
      try {
        const res = await outOfDate(candidates);
        // A cut-off list leaves unchecked only what its directory check did not settle (all, when it names none).
        if (res?.truncated)
          unchecked(res.unchecked ?? candidates, "The base branch changed 300 or more files since this PR last merged it, so whether this test changed could not be checked");
      } catch (e) {
        // An error is not "nothing changed": the same fail-closed outcome as a cut-off list.
        log(`base branch changes unavailable: ${String(e).slice(0, 200)}`);
        unchecked(candidates, "The base branch's changes since this PR last merged it could not be read, so whether this test changed could not be checked");
      }
    }
    // A break the base branch fixed: out of date where this branch lacks the fix, the judge's where it has it.
    if (!blind && prNumber && fixedOnTrunk) {
      const fixed = result.findings.filter((f) => f.class === "FIXED_ON_TRUNK" && !f.identity_unresolved);
      try {
        await fixedOnTrunk(fixed);
      } catch (e) {
        log(`base branch commits unavailable: ${String(e).slice(0, 200)}`);
        for (const f of fixed) Object.assign(f, { decision: "evidence_incomplete", reason: `${f.reason} Whether this branch has that fix could not be checked.` });
      }
      // One the branch has the fix for is a REGRESSION now: whether the PR touches it is read as for any other.
      for (const f of fixed) if (diff.ok && f.class === "REGRESSION" && f.untouched === undefined) f.untouched = !changed.some((name) => namesChangedFile(f, name));
    }
    // Tests broken on the base branch: what merged between their last pass and first failure.
    if (!blind && brokeBy) {
      try {
        await brokeBy(result.findings.filter((f) => f.class === "BROKEN_ON_TRUNK" && f.trunk_break?.last_pass?.commit_sha && f.trunk_break?.first_fail?.commit_sha));
      } catch (e) {
        log(`base branch history unavailable: ${String(e).slice(0, 200)}`);
      }
    }
    if (!blind && prNumber) {
      // More facts for the failures the rules couldn't settle; a lookup that fails only leaves a fact out.
      if (enrich) {
        try {
          await enrich(result.findings.filter((f) => JUDGED.has(f.class) && f.blocking && !f.identity_unresolved && !f.out_of_date));
        } catch (e) {
          log(`extra evidence unavailable: ${String(e).slice(0, 200)}`);
        }
      }
      markEarlierFailures(result.findings);
      const others: OtherFailure[] = result.findings.map((f) => ({ class: f.class, title: (f.full_title || f.title).slice(0, 200), file: f.file, signature: errorSignature(f.error) }));
      const pr: PrRef = { number: prNumber, repository: id.repository, title: prTitle, lane };
      const packs = result.findings.map((f) => (f.class === "OWNED_BY_PR" || f.identity_unresolved || f.out_of_date || f.decision === "evidence_incomplete" ? null : buildPack(f, files, pr, others, changeContext)));
      // Common sense before the model, with or without it: a failure the same commit shows is not the PR's is cleared.
      for (const [i, f] of result.findings.entries()) {
        const why = commonSenseClear(f, packs[i]);
        if (why) Object.assign(f, { blocking: false, decision: "rules_unblock", reason: why });
      }
      if (ask) await judge(result.findings, packs, ask, cfg, log, isTrunkRun, result.ai);
    }
    if (!blind && !prNumber && branchBase) {
      // A release branch's run: what kind of failure each held one is (see SYSTEM_RELEASE and decideRelease).
      for (const f of result.findings) f.release = true;
      const held = result.findings.filter((f) => f.blocking && f.class !== "OWNED_BY_PR" && !f.identity_unresolved && f.decision !== "evidence_incomplete");
      if (enrich) {
        try {
          await enrich(held);
        } catch (e) {
          log(`extra evidence unavailable: ${String(e).slice(0, 200)}`);
        }
      }
      markEarlierFailures(result.findings);
      const others: OtherFailure[] = result.findings.map((f) => ({ class: f.class, title: (f.full_title || f.title).slice(0, 200), file: f.file, signature: errorSignature(f.error) }));
      const release: ReleaseRef = { repository: id.repository, name: id.name ?? "", branch: branchName || "this branch", base: branchBase, historyBranch: trunkBranch || branchBase, lane };
      const packs = result.findings.map((f) => (held.includes(f) ? releasePack(f, release, others, changeContext) : null));
      if (ask) await judge(result.findings, packs, ask, cfg, log, isTrunkRun, result.ai);
    }
    if (!blind && prNumber) sameFailure(result.findings);
    // Whether the PR touches a test is known only from a complete change list and a test root to place the spec in it.
    if (prNumber && !branchBase) settlePR(result.findings, changed, diff.ok && testRoot != null, Boolean(result.infra), files, cfg.minTrunkRuns);
    if (isTrunkRun && !branchBase) for (const f of result.findings) f.trunk_run = true;
  }
  // A release branch's spec that never ran is untested in that build: spec history, which has no branch, does not clear it.
  if (branchBase)
    for (const f of judgedNotRun)
      if (!f.blocking) Object.assign(f, { class: "NOT_RUN", blocking: true, reason: `${f.reason} On a release branch that does not clear it: this build never ran the spec.` });
  result.findings.push(...judgedNotRun);
  result.verdict = verdictOf(result.findings, result.infra);
  // Specs that never ran can't be vouched for, whatever happened to the rest.
  result.missing = missingReports(run.missing);
  if ((result.missing || result.unnamed) && result.verdict === "SUCCESS") result.verdict = "FAILURE";
  return result;
}

/**
 * The last word on a PR's failures: one stays red only with evidence that this PR caused it (see causedByPR), or as a
 * machine failure, so nothing is left as "needs a look" and nothing the base branch explains blocks the PR.
 * - The base branch changed or fixed the test after this PR last merged it (out_of_date): cleared, as fixed on main. The
 *   base branch's copy passes there, and merging gives the PR that copy.
 * - Held on a run that failed in bulk (the run-level flag) while the base branch passes: an environment error stays a
 *   machine failure; any other failure is the PR's (mass), since the change broke something those tests share. Not
 *   where the judge cleared some of the run: then each is read on its own, as below.
 * - A spec that never ran (NOT_RUN), or a PR whose change list could not be read in full (or whose spec cannot be placed
 *   in it, with no test root): red as a machine failure, for a re-run.
 * - Otherwise, the PR changes the test's error-named file, or a changed line holds what the test looked for (a selector,
 *   test id or expected text; see changeTouchesFailure): the PR's.
 * - A test that failed every try of this build (retries and retests included) while trunk passed all of its recent runs
 *   (none failed or flaky, the latest a pass, and at least minTrunkRuns of them known to be the history lane's) and no
 *   other PR failed it the same way is a regression this build brought, not a flake: the PR's, as a reproducible
 *   regression. A trunk pass that needed a retry clears it even where another platform of this commit failed the test
 *   too: that platform's result carries no error to match against this one. Not for an environment error, nor where the
 *   test's history could not be used.
 * - If none holds, the failure is cleared: the first one that nothing ties to the PR is not blamed on it. The same
 *   failure on the PR's next commit is a PR streak (see classify), which is held as the PR's.
 */
export function settlePR(findings: Finding[], changed: string[], ownershipKnown: boolean, flagged: boolean, files: ChangedFile[] = [], minTrunkRuns = DEFAULTS.minTrunkRuns): void {
  // A flagged run the judge cleared any of is not a bulk break: those it judged are its environment's or flaky, and the
  // rest are read one by one like any other run's.
  const bulk = flagged && !findings.some((f) => f.decision === "adjudicator_unblock");
  for (const f of findings) {
    if (f.out_of_date && f.class !== "OWNED_BY_PR") {
      if (f.blocking) Object.assign(f, { blocking: false, decision: "base_fixed" });
      continue;
    }
    if (!f.blocking || causedByPR(f)) continue;
    if (f.class === "NOT_RUN" || (f.class === "INFRA_ERROR" && flagged)) continue;
    if (bulk) {
      f.mass = true;
      continue;
    }
    if (!ownershipKnown) continue;
    const own = f.repo_path ?? f.file;
    if (changed.some((name) => name === own || namesChangedFile(f, name))) {
      f.untouched = false;
      continue;
    }
    const touched = changeTouchesFailure(f, files);
    if (touched) {
      Object.assign(f, { changed_by_pr: touched, untouched: true });
      continue;
    }
    const unused = f.decision === "evidence_incomplete" || Boolean(f.identity_unresolved);
    const t = f.trunk;
    const everyTry = Boolean(f.tries && f.tries.ran >= 2 && f.tries.failed === f.tries.ran);
    // Another platform's failure of this test (failed_everywhere) is named, but it does not excuse a trunk retry pass: it
    // records only the platform's result, not its error, so it may be another failure altogether.
    const elsewhere = f.failed_everywhere?.length ? f.failed_everywhere : null;
    const trunkClean = Boolean(t && t.runs >= minTrunkRuns && (t.lane_runs ?? t.runs) >= minTrunkRuns && t.fails === 0 && t.flaky === 0 && t.latest === "passed");
    if (!unused && f.class !== "INFRA_ERROR" && everyTry && trunkClean && !f.cross_pr?.prs.length) {
      Object.assign(f, {
        untouched: true,
        decision: "reproducible_regression",
        reason: `Failed all ${f.tries!.ran} tries of this build${elsewhere ? ` and on ${elsewhere.join(" and ")} of this same commit` : ""}, never failed in its ${t.runs} recent runs on trunk, and no other PR failed it this way: this PR's change causes it.`,
      });
      continue;
    }
    Object.assign(f, { blocking: false, untouched: true, decision: "first_failure", ...(unused ? { history_unused: true } : {}) });
  }
}
