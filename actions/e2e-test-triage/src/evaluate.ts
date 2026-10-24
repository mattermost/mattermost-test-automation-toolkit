// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { identityKey, missingReports } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, RunResult } from "../../shared/src/tsio.ts";
import { BORDERLINE, classify, errorSignature, infraVerdict, JUDGED, sameFailure } from "./classify.ts";
import { DEFAULTS, historyLane, repoPath } from "./config.ts";
import { sameTestOnOtherReports } from "./enrich.ts";
import { evidenceFor } from "./evidence.ts";
import { buildPack, namesChangedFile } from "./pack.ts";
import type { OtherFailure } from "./pack.ts";
import { judge } from "./decision.ts";
import { newLedger } from "./pricing.ts";
import type { AskFn, ChangedFile, Config, Diff, Evidence, Finding, HistoryLike, Ledger, PrRef } from "./types.ts";

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
  /** Set when every failure names no test (shard-level): none is classified or sent to the model, and the lane is red. */
  unnamed?: number;
}

export interface EvaluateParams {
  run: RunResult;
  id: CompositeIdentity;
  prNumber: number | null;
  history: HistoryLike;
  diff: Diff;
  trunkBranch: string | null | undefined;
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
  outOfDate?: ((findings: Finding[]) => Promise<{ truncated: boolean }>) | null;
  brokeBy?: ((findings: Finding[]) => Promise<void>) | null;
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
  brokeBy = null,
}: EvaluateParams): Promise<EvaluatedRun> {
  const isTrunkRun = prNumber == null;
  const result: EvaluatedRun = { verdict: "SUCCESS", findings: [], infra: infraVerdict(run.failing, cfg), counts: run.counts, ai: newLedger(), missing: null };
  // A failure with no test name (a shard that reported nothing by name) has no history to read and nothing to show the
  // model. A run whose failures all lack names is red for them: it is counted, and not classified or asked.
  const named = run.failing.some((t) => t.title.trim() !== "");
  if (run.failing.length && !named) result.unnamed = run.failing.length;
  // A run-level infra call still names each failure, and the model is asked as on any run: the run is red while
  // any failure still blocks.
  if (run.failing.length && named) {
    const files = (diff.files ?? []).map((f: ChangedFile) => ({ filename: f.filename, patch: f.patch }));
    const changed = files.map((f) => f.filename);
    const withPaths = run.failing.map((t) => ({ ...t, repo_path: repoPath(testRoot, t.file) }));
    const changeContext = { testRoot, failingSpecs: withPaths.map((t) => t.repo_path).filter((p): p is string => Boolean(p)) };
    const unresolved = (t: { identity_unresolved?: boolean }, key: string): boolean => Boolean(t.identity_unresolved) || (history.ambiguous?.has(key) ?? false);
    result.findings = withPaths.map((t) => {
      const key = identityKey(t);
      return classify(unresolved(t, key) ? { ...t, identity_unresolved: true } : t, history.get(key) ?? [], changed, cfg, prNumber, historyLane(id, cfg), {
        isTrunkRun,
        groupId: run.group_id,
        trunkBranch,
        commitSha: id.commit_sha,
      });
    });
    // A PR that breaks its own server fails every test on the environment. On a flagged run, an environment error
    // the rules would clear (infraClears) is held instead: only the judge's answer clears it.
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
      if (prNumber && diff.ok && f.class === "REGRESSION") f.untouched = !changed.some((name) => namesChangedFile(f, name));
    }
    // Incomplete evidence makes the rules unsound: nothing clears, and the model isn't asked.
    const blind =
      history.truncated ? "History was truncated at the page cap"
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
    // The same test on the run's other platforms: this run's own reports (no call), then its sibling groups. Evidence
    // only: the summary and the pack read it, and no class or blocking depends on it.
    sameTestOnOtherReports(result.findings, run);
    // Not on an infrastructure storm: the run is red for its environment, and sibling reads would only add calls.
    if (otherPlatforms && !result.infra) {
      try {
        await otherPlatforms(result.findings);
      } catch (e) {
        log(`other platforms unavailable: ${String(e).slice(0, 200)}`);
      }
    }
    // A failure in a test the base branch changed after this PR last merged it ran
    // the PR's old copy: it stays red, with "merge <base>" as the next step, and
    // is not sent to the model.
    if (!blind && prNumber && outOfDate) {
      const candidates = result.findings.filter((f) => f.blocking && BORDERLINE.has(f.class) && !f.identity_unresolved && f.repo_path);
      // A failure whose change list is cut off or unreadable cannot be shown unchanged: it is unchecked, so red and never judged.
      const unchecked = (because: string): void => {
        for (const f of candidates) Object.assign(f, { decision: "evidence_incomplete", reason: `${f.reason} ${because}; this could not be confirmed.` });
      };
      try {
        if ((await outOfDate(candidates))?.truncated)
          unchecked("The base branch changed 300 or more files since this PR last merged it, so whether this test changed could not be checked");
      } catch (e) {
        // An error is not "nothing changed": the same fail-closed outcome as a cut-off list.
        log(`base branch changes unavailable: ${String(e).slice(0, 200)}`);
        unchecked("The base branch's changes since this PR last merged it could not be read, so whether this test changed could not be checked");
      }
    }
    // Tests broken on the base branch: what merged between their last pass and first failure.
    if (!blind && brokeBy) {
      try {
        await brokeBy(result.findings.filter((f) => f.class === "BROKEN_ON_TRUNK" && f.trunk_break?.last_pass?.commit_sha && f.trunk_break?.first_fail?.commit_sha));
      } catch (e) {
        log(`base branch history unavailable: ${String(e).slice(0, 200)}`);
      }
    }
    if (!blind && ask && prNumber) {
      // More facts for the failures the rules couldn't settle; a lookup that fails only leaves a fact out.
      if (enrich) {
        try {
          await enrich(result.findings.filter((f) => JUDGED.has(f.class) && f.blocking && !f.identity_unresolved && !f.out_of_date));
        } catch (e) {
          log(`extra evidence unavailable: ${String(e).slice(0, 200)}`);
        }
      }
      const others: OtherFailure[] = result.findings.map((f) => ({ class: f.class, title: (f.full_title || f.title).slice(0, 200), file: f.file, signature: errorSignature(f.error) }));
      const pr: PrRef = { number: prNumber, repository: id.repository, title: prTitle, lane };
      const packs = result.findings.map((f) => (f.class === "OWNED_BY_PR" || f.identity_unresolved || f.out_of_date || f.decision === "evidence_incomplete" ? null : buildPack(f, files, pr, others, changeContext)));
      await judge(result.findings, packs, ask, cfg, log, isTrunkRun, result.ai);
    }
    if (!blind && prNumber) sameFailure(result.findings);
  }
  result.verdict = verdictOf(result.findings, result.infra);
  // Specs that never ran can't be vouched for, whatever happened to the rest.
  result.missing = missingReports(run.missing);
  if ((result.missing || result.unnamed) && result.verdict === "SUCCESS") result.verdict = "FAILURE";
  return result;
}
