// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl, GhApi, Sleep } from "../../shared/src/github.ts";
import { laneName, laneSummary } from "../../shared/src/lane.ts";
import { FAILED_TESTS, isReportsIncomplete, isUpstreamFailed, readStatuses, statusPublisher } from "../../shared/src/status.ts";
import { compositeIdentityFrom, fetchRun, missingArrived, NoResultsError, SupersededRunError, tsioBase } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, RunResult, Wait } from "../../shared/src/tsio.ts";
import { isShardPlaceholder, isSpecNotRun, isSpecStopped } from "./classify.ts";
import { configFrom, DEFAULTS, historyLane, PR_SPEND_KEY } from "./config.ts";
import { loadEvidence } from "./evidence.ts";
import { dropStormRuns, fetchChangedFiles, fetchHistory, fetchSpecRuns, markBrokeBy, markFixedOnTrunk, markOutOfDate, trunkRunsOn } from "./history.ts";
import { enrichFindings, siblingPlatforms } from "./enrich.ts";
import { askModelBatch } from "./judge.ts";
import { evaluateRun } from "./evaluate.ts";
import type { EvaluatedRun } from "./evaluate.ts";
import { findingLogLine, redact, secretsOf, writeFindings } from "./findings.ts";
import { askCauseWith, decideRerun, readDeadJobs } from "./rerun-check.ts";
import { laneDescription } from "./lane-diagnosis.ts";
import { laneTurnsGreen } from "./lane-diagnosis.ts";
import { judgeLane, lanePathsOf } from "./lane-verdict.ts";
import type { JudgedLane } from "./lane-verdict.ts";
import type { RerunDecision } from "./rerun-check.ts";
import { ledgerTotals } from "./pricing.ts";
import { activeFlag, noResultsText, otherRunText, passLine, renderLane, renderNotTriaged, renderSummary, renderUnfinished, RERUN, RERUNNING, runFlag, statusDescription, statusLabels, supersededText } from "./render.ts";
import type { AskFn, Config, Diff, HistoryLike, Observation, SpecHistory } from "./types.ts";

/** The composite identity as the triage action reads it from COMPOSITE_IDENTITY, including the PR and branch fields. */
export interface TriageIdentity extends CompositeIdentity {
  branch?: string | null;
  gh_pr_number?: number | string | null;
}

/** The parts of the GitHub pull request this action reads. */
interface PullInfo {
  title?: string;
  base?: { ref?: string | null } | null;
  labels?: ({ name?: string } | null)[] | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A kept PR spend (see PR_SPEND_KEY): a PR number and an amount of 0 or more. Anything else is corrupt. */
const isPrSpend = (v: unknown): v is { pr: number; usd: number } =>
  isPlainObject(v) && typeof v.pr === "number" && typeof v.usd === "number" && Number.isFinite(v.usd) && v.usd >= 0;

/**
 * Thrown for a run triage leaves unjudged on purpose: a newer dispatch replaced it. Its summary and findings file say
 * why. This is not a failure, so the action exits 0 on it (index.ts). Any other error still exits 1.
 */
export class NotTriagedError extends Error {}

export interface TriageOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
  now?: Date;
  wait?: Wait;
  /** Waits between attempts of a retried status write (shared gh); a test passes one that does not sleep. */
  retryWait?: Sleep;
}

/** What triage got as far as it went, for the findings file and the not-triaged paths. */
interface Seen {
  run: RunResult | null;
  result: EvaluatedRun | null;
  enforce: boolean | null;
}

/** The composite identity, or null when it cannot be read: the findings file then names what it can. */
function identityOrNull(env: Env): TriageIdentity | null {
  try {
    return compositeIdentityFrom<TriageIdentity>(env.COMPOSITE_IDENTITY);
  } catch {
    return null;
  }
}

/** The first line of what went wrong, with secrets redacted: what the summary and the findings file say. */
const errorLine = (e: unknown, secrets: string[]): string => redact((e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0] ?? "", secrets);

/**
 * A history read that still fails after its retries (a TSIO 504 under load) does not stop triage: the run is judged
 * without history, as evaluate's blind case, where only this PR's own change can hold a failure (see settlePR).
 */
async function unreadHistory(read: Promise<HistoryLike>, log: (message: string) => void): Promise<HistoryLike> {
  try {
    return await read;
  } catch (e) {
    const why = String(e).replace(/^Error: /, "").slice(0, 120);
    log(`e2e-test-triage: history unavailable, judging without it: ${why}`);
    return Object.assign(new Map<string, Observation[]>(), { unavailable: why });
  }
}

/**
 * Triages a run. However it ends without a verdict (a read that fails, a history that stays down), the job summary
 * says why, in report-only too, so the run page does not show only an exit. The findings file is written however it
 * ends (FINDINGS_FILE): judged, superseded, with no results, or broken off.
 */
export async function triage(options: TriageOptions): Promise<EvaluatedRun> {
  const written = { summary: false };
  const seen: Seen = { run: null, result: null, enforce: null };
  const { env } = options;
  const log = options.log ?? console.error;
  const requested: "enforce" | "report-only" = String(env.MODE ?? "").trim() === "enforce" ? "enforce" : "report-only";
  // The mode this run ran in: a report-only label turns an enforce request into report-only. Requested until known.
  const effective = (): "enforce" | "report-only" => (seen.enforce === null ? requested : seen.enforce ? "enforce" : "report-only");
  try {
    const result = await decideRun(options, written, seen);
    writeFindings({ env, id: identityOrNull(env), mode: effective(), run: seen.run, result, notTriaged: null }, log);
    return result;
  } catch (e) {
    const id = identityOrNull(env);
    const secrets = secretsOf(env);
    const summaryPath = env.GITHUB_STEP_SUMMARY;
    const reason = errorLine(e, secrets);
    // A run triage did not judge on purpose says why in its summary: a newer dispatch took its group, or TSIO has no
    // results for it. Anything else is an unfinished triage.
    let notTriaged = `error: ${reason}`;
    let body: string | null = null;
    if (e instanceof SupersededRunError && id) {
      // A link only to a replacement of this same PR, or of the same branch when neither run has a PR: another PR's run
      // is not this lane's triage, so it is named without a link.
      const rep = e.replacement;
      const samePR = rep.gh_pr_number !== undefined && (rep.gh_pr_number ? rep.gh_pr_number === String(id.gh_pr_number ?? "") : !id.gh_pr_number && rep.branch != null && rep.branch === id.branch);
      body = samePR ? supersededText(rep.gh_run_id, id.repository, String(id.name)) : otherRunText(String(id.name));
      notTriaged = `superseded: run ${e.replacement.gh_run_id} replaced this run`;
    } else if (e instanceof NoResultsError && id) {
      body = noResultsText(String(id.name), id.commit_sha);
      notTriaged = "no_results: TSIO has no results for this run";
      await noteNoResults(options, id);
    }
    if (!written.summary && summaryPath) {
      try {
        const text = body ? renderNotTriaged({ text: body, lane: env.LANE || id?.name || null }) : renderUnfinished({ reason, lane: env.LANE || null });
        appendFileSync(summaryPath, text + "\n");
      } catch (writeError) {
        log(`triage's summary not written: ${String(writeError).slice(0, 160)}`);
      }
    }
    writeFindings({ env, id, mode: effective(), run: seen.run, result: seen.result, notTriaged }, log);
    if (e instanceof SupersededRunError) throw new NotTriagedError(notTriaged);
    throw e;
  }
}

/**
 * The lane's status when TSIO has no results: the note goes on the state it already has, so the lane stays as it
 * was, and only where this run owns the status (the publisher checks that). A failed note is logged, not raised.
 */
async function noteNoResults({ env, fetchImpl = fetch, log = console.error, retryWait }: TriageOptions, id: TriageIdentity): Promise<void> {
  const context = env.STATUS_CONTEXT;
  if (!context || !env.GITHUB_TOKEN) return;
  try {
    const api = gh(fetchImpl, String(env.GITHUB_TOKEN), retryWait);
    const own = (await readStatuses(api, id)).find((r) => r.context === context);
    if (!own || own.state === "pending") return;
    const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
    await statusPublisher({ api, id, context, env, log }).write({ state: own.state, description: "(not triaged: no results)", target_url: runURL }, "triage");
  } catch (e) {
    log(`not-triaged note not written on ${context}: ${String(e).slice(0, 200)}`);
  }
}

/**
 * Why the lane's own status is red, read only where no test failed and every report arrived; null when it is not red.
 * "flaky" where a test passed on a retry and the status says tests failed: its count read that test as failed (a
 * retest in another report), and triage can turn it green. "upstream" where e2e-test-status says a job outside the
 * tests failed (a dead worker whose specs the others ran): nothing is written, and its failed step may get the failed
 * jobs re-run. "outside" for any other red status (missing reports, no text): the summary says so and nothing is
 * written. An unreadable status is logged, and reads as not red.
 */
/** Whether the lane's own status says a job outside its tests failed or its reports are incomplete; false when unread. */
async function redOutsideTests(api: GhApi, id: TriageIdentity, context: string, log: (message: string) => void): Promise<boolean> {
  try {
    const own = (await readStatuses(api, id)).find((r) => r.context === context);
    const text = String(own?.description ?? "");
    return isUpstreamFailed(text) || isReportsIncomplete(text);
  } catch (e) {
    log(`lane status unavailable: ${String(e).slice(0, 160)}`);
    return false;
  }
}

async function laneRedWhy(api: GhApi, id: TriageIdentity, context: string, flaky: number, log: (message: string) => void): Promise<"flaky" | "upstream" | "outside" | null> {
  try {
    const own = (await readStatuses(api, id)).find((r) => r.context === context);
    if (own?.state !== "failure" && own?.state !== "error") return null;
    // Only a status that says tests failed: the TSIO summary's "N failed" count, or e2e-test-status's own text. No text,
    // or any other (a job outside the tests, missing reports, an override), is not one triage can turn green.
    const text = String(own.description ?? "");
    // A job outside the tests failed (a dead worker), and e2e-test-status said so: a re-run may be asked for.
    if (isUpstreamFailed(text)) return "upstream";
    const testsFailed = /\b[1-9]\d* failed\b/.test(text) || text.startsWith(FAILED_TESTS);
    return flaky > 0 && own.state === "failure" && testsFailed && !isUpstreamFailed(text) && !isReportsIncomplete(text) ? "flaky" : "outside";
  } catch (e) {
    log(`lane status unavailable: ${String(e).slice(0, 160)}`);
    return null;
  }
}

/** The repository's default branch, read when the base branch has too little history to judge by. Null when GitHub can't say. */
async function defaultBranchOf(api: GhApi, repository: string, log: (message: string) => void): Promise<string | null> {
  try {
    const repo = (await api("GET", `/repos/${repository}`)) as { default_branch?: string | null } | null;
    return repo?.default_branch || null;
  } catch (e) {
    log(`default branch unavailable: ${String(e).slice(0, 160)}`);
    return null;
  }
}

/** Fetches the run, its history and diff, evaluates the findings, and writes the summary and commit statuses. */
async function decideRun({ env, fetchImpl = fetch, log = console.error, now = new Date(), wait, retryWait }: TriageOptions, written: { summary: boolean }, seen: Seen): Promise<EvaluatedRun> {
  const cfg: Config = configFrom(env, log);
  const id = compositeIdentityFrom<TriageIdentity>(env.COMPOSITE_IDENTITY);
  const prNumber = Number(id.gh_pr_number || 0) || null;
  // No PR number: a trunk run (see EXONERATED_ON_TRUNK).
  const isTrunkRun = prNumber == null;
  const base = tsioBase(env);
  const api = gh(fetchImpl, String(env.GITHUB_TOKEN), retryWait);
  // Not guessed: a wrong root makes every spec look untouched.
  const testRoot = env.TEST_ROOT ? env.TEST_ROOT : null;
  const reportName = env.REPORT_NAME || null;
  const historyReport = cfg.historyReport || reportName;
  // No results to judge test by test (no TSIO group, or a group with no test cases: every worker died before it
  // reported): the lane is judged from its orchestration and its jobs alone (see judgeLane).
  let laneOnly: string | null = null;
  let run: RunResult;
  try {
    run = await fetchRun(fetchImpl, base, id, reportName, wait);
  } catch (e) {
    if (!(e instanceof NoResultsError) && !/reported no test cases/.test(String(e))) throw e;
    laneOnly = String(e instanceof Error ? e.message : e).slice(0, 200);
    log(`no test results to triage (${laneOnly}); judging the lane from its orchestration and jobs`);
    run = { group_id: "", failing: [], missing: { expected: null, received: 0, status: "no results" }, outcomes: new Map(), elsewhere: new Map(), counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 } };
  }
  seen.run = laneOnly ? null : run;
  const context = env.STATUS_CONTEXT;
  const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
  // The lane's context is set in the environment (STATUS_CONTEXT); an unset one is passed through as undefined,
  // which the publisher treats as a lane it does not own. The shared signature is typed string.
  const publisher = statusPublisher({ api, id, context: context as string, env, log });
  // An informational check beside the required one: pending while triage runs, then the verdict.
  const triageContext = env.TRIAGE_CONTEXT === "off" ? null : env.TRIAGE_CONTEXT || (context ? `${context}/triage` : null);
  const postTriageCheck = async (state: string, description: string): Promise<void> => {
    if (!triageContext || !env.GITHUB_TOKEN) return;
    try {
      await publisher.info({ state, context: triageContext, description, target_url: runURL });
    } catch (e) {
      log(`triage check ${triageContext} not updated: ${String(e).slice(0, 200)}`);
    }
  };
  const notes: string[] = [];
  // The PR is read once: its labels decide the mode, and its base branch and title
  // feed the rules and the model.
  let pull: PullInfo = {};
  let prMetadataAvailable = true;
  if (prNumber) {
    try {
      pull = ((await api("GET", `/repos/${id.repository}/pulls/${prNumber}`)) as PullInfo | null) ?? {};
    } catch (e) {
      prMetadataAvailable = false;
      log(`pull request metadata unavailable: ${String(e).slice(0, 200)}`);
    }
  }
  let enforce = String(env.MODE ?? "").trim() === "enforce";
  if (enforce && cfg.reportOnlyLabel && !prMetadataAvailable) {
    enforce = false;
    notes.push("Report only: PR labels could not be read, so the report-only opt-out cannot be checked.");
  }
  if (enforce && cfg.reportOnlyLabel && (pull.labels ?? []).some((l) => l?.name === cfg.reportOnlyLabel)) {
    enforce = false;
    notes.push(`Report only on this PR: it has the ${cfg.reportOnlyLabel} label, so triage leaves the E2E check as the tests set it.`);
  }
  seen.enforce = enforce;
  // Nothing failed and every report arrived, yet the lane is red: for a test that passed on a retry, or a job outside the tests.
  const redWhy = !run.failing.length && !run.missing && context ? await laneRedWhy(api, id, context, run.counts.flaky, log) : null;
  const flakyOnly = redWhy === "flaky";
  // A lane red outside its test results: no results, missing reports, or a job outside the tests died. Triage gives
  // it a verdict of its own (see judgeLane): every red lane gets one.
  const outsideTests = Boolean(laneOnly) || Boolean(run.missing) || redWhy === "upstream" || redWhy === "outside";
  // What triage decides from the tests: failures, missing reports, or a lane red only for tests that passed on a retry.
  // A lane red outside its tests is decided too, but only once its verdict rests on what TSIO's orchestration says
  // (see grounded below): a job that died is not, by itself, a reason to write anything.
  let decides = run.failing.length > 0 || Boolean(run.missing) || flakyOnly;
  // Like the required status, only an enforcing run writes to the PR.
  const announce = enforce && decides;
  // TRIAGE_LANES lists every lane's required context: then the triage check is one
  // for the whole PR, summarising all lanes, rather than one per lane.
  const lanes = String(env.TRIAGE_LANES ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  // All required-status writers and this snapshot hold one SHA-scoped job
  // concurrency lock. A delayed second snapshot cannot substitute for that lock.
  let branchBase: string | null = null;
  // Whether this is a release run, for the aggregate's labels. A PR run never is; a trunk run is when its branch is not
  // the repository's default branch. Until GitHub names that branch (the lookup failed, or never ran because nothing
  // failed) it stays undefined, and the publisher infers it from the tested identity and the statuses.
  let releaseRun: boolean | undefined = isTrunkRun ? undefined : false;
  const settleLaneSummary = async (): Promise<void> => {
    try {
      await publisher.refresh(lanes, triageContext ?? undefined, laneSummary, releaseRun);
    } catch (e) {
      log(`triage check ${triageContext} not summarised: ${String(e).slice(0, 200)}`);
    }
  };
  if (announce) await postTriageCheck("pending", lanes.length ? `Triage is checking ${laneName(String(context))}` : flakyOnly ? `${run.counts.flaky} flaky · triage is checking them` : `${run.counts.failed} failed · triage is checking them`);
  try {
    let history: HistoryLike = new Map();
    let diff: Diff = { files: [], ok: false };
    // A PR's trunk is its base branch, when TSIO has enough of that branch's runs to judge by (a stacked PR's base often has
    // too few); otherwise it is the repository's default branch, and the summary says so.
    const prBase = isTrunkRun ? null : pull.base?.ref ?? null;
    let trunkBranch: string | null | undefined = isTrunkRun ? id.branch : prBase;
    // A run with no PR on a branch other than the default (a release candidate's CMT) runs that branch's own copies of
    // the tests, which the default branch may have changed since: the default branch is its base.
    if (isTrunkRun && id.branch && run.failing.length) {
      const defaultBranch = await defaultBranchOf(api, id.repository, log);
      if (defaultBranch) {
        releaseRun = defaultBranch !== id.branch;
        if (releaseRun) branchBase = defaultBranch;
      }
    }
    // A run of shard placeholders only needs no history. Otherwise placeholders' files are asked for too: TSIO counts its
    // run window over the files asked for, so dropping one would change which past runs the real tests are judged on.
    if (run.failing.some((t) => !isShardPlaceholder(t))) {
      [history, diff] = await Promise.all([
        unreadHistory(fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, historyReport, log, historyLane(id, cfg)), log),
        fetchChangedFiles(api, id, prNumber, log),
      ]);
      if (branchBase && id.branch) {
        const ownRuns = trunkRunsOn(history, id.branch);
        if (ownRuns < cfg.minTrunkRuns) {
          trunkBranch = branchBase;
          notes.push(`History is read from ${branchBase}, the default branch: ${id.branch} has ${ownRuns} earlier runs of these tests, fewer than ${cfg.minTrunkRuns}.`);
          history = await unreadHistory(fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, historyReport, log, historyLane(id, cfg)), log);
        }
      }
      const baseRuns = prBase ? trunkRunsOn(history, prBase) : 0;
      if (prBase && baseRuns < cfg.minTrunkRuns) {
        const fallback = await defaultBranchOf(api, id.repository, log);
        if (fallback && fallback !== prBase) {
          trunkBranch = fallback;
          notes.push(`Trunk history is read from ${fallback}, the default branch: ${prBase} has ${baseRuns} earlier runs of these tests, fewer than ${cfg.minTrunkRuns}.`);
          history = await unreadHistory(fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, historyReport, log, historyLane(id, cfg)), log);
        }
      }
      await dropStormRuns({ history, fetchImpl, base, minFailures: cfg.infraMinFailures, trunkBranch, own: run.group_id, pr: prNumber, log });
    } else if (run.failing.some(isSpecStopped)) {
      // A skipped spec is never cleared while the change edits it (see classifyNotRun).
      diff = await fetchChangedFiles(api, id, prNumber, log);
    }
    // Specs a stopped Jest process skipped are judged by their files' past runs; unreadable history clears none. It asks
    // for every failing file, as fetchHistory does: TSIO counts its run window over the files asked for.
    let specHistory: SpecHistory | null = null;
    if (run.failing.some(isSpecStopped)) {
      try {
        specHistory = await fetchSpecRuns(fetchImpl, base, id.repository, run.failing.map((t) => t.file), now.toISOString(), cfg, historyLane(id, cfg), historyReport);
      } catch (e) {
        log(`history of the specs that did not run unavailable: ${String(e).slice(0, 200)}`);
      }
    }
    // Answers from an earlier attempt at the same evidence, so a re-run does not pay twice. A cache that is not a
    // readable object, or a PR-spend entry that is corrupt, cannot say what the PR spent: that spend is unknown.
    let unknownSpend: string | null = null;
    if (env.ANSWERS_CACHE) {
      try {
        const loaded: unknown = existsSync(env.ANSWERS_CACHE) ? JSON.parse(readFileSync(env.ANSWERS_CACHE, "utf8")) : {};
        if (isPlainObject(loaded)) cfg.answers = loaded;
        else {
          cfg.answers = {};
          unknownSpend = "answers cache is not an object";
        }
      } catch (e) {
        cfg.answers = {};
        unknownSpend = `answers cache unreadable: ${String(e).slice(0, 120)}`;
      }
    }
    // What this lane already spent on this PR, on earlier commits and attempts. The
    // PR's budget is split evenly between its lanes, so lanes running at the same
    // time never need to see each other's spend to stay under it together.
    let prSpent = 0;
    if (cfg.answers) {
      const kept: unknown = cfg.answers[PR_SPEND_KEY];
      delete cfg.answers[PR_SPEND_KEY];
      if (kept !== undefined && !isPrSpend(kept)) unknownSpend ??= "PR spend entry is corrupt";
      else if (isPrSpend(kept) && prNumber && kept.pr === prNumber) prSpent = kept.usd;
    }
    // Unknown spend on a PR is never spent on: the model is not called and the failures stay on the rules.
    // A trunk run has no PR budget, so an unknown cache there only starts empty.
    const prSpendUnknown = prNumber != null && unknownSpend != null;
    if (unknownSpend) log(`${unknownSpend}; ${prNumber ? "the PR's spend is unknown, so the model is not called this run (rules only)" : "starting empty"}`);
    if (prNumber && cfg.answers && Number.isFinite(cfg.prBudgetUsd) && cfg.prBudgetUsd >= 0) {
      const share = cfg.prBudgetUsd / Math.max(1, lanes.length);
      const left = Math.max(0, share - prSpent);
      if (left < cfg.budgetUsd) {
        cfg.budgetUsd = left;
        cfg.budgetLabel = `PR's AI budget ($${cfg.prBudgetUsd} per PR, $${share.toFixed(2)} for this lane, $${prSpent.toFixed(2)} already spent)`;
      }
    }
    const apiKey = env.ANTHROPIC_API_KEY;
    const ask: AskFn | null = apiKey && !prSpendUnknown ? (packs, model) => askModelBatch(fetchImpl, apiKey, model, packs) : null;
    const result = await evaluateRun({
      run, id, prNumber, history, diff, trunkBranch, branchBase, branchName: branchBase ? id.branch ?? null : null, testRoot, cfg,
      prTitle: pull.title ?? "", lane: env.LANE || id.name, log,
      ask,
      evidence: env.EVIDENCE_DIR ? loadEvidence(env.EVIDENCE_DIR, log) : [],
      enrich: (findings) => enrichFindings({ findings, api, id, testRoot, prFiles: diff.ok ? diff.files : null, baseBranch: prBase, log }),
      // A release run's matrix (OS x server version) is wider than a PR's platforms.
      otherPlatforms: (findings) => siblingPlatforms({ findings, fetchImpl, base, id, log, limit: branchBase ? 20 : 5 }),
      outOfDate: (findings) => markOutOfDate({ findings, api, id, baseBranch: branchBase ?? trunkBranch, until: now.toISOString(), log, supportPaths: cfg.supportPaths }),
      fixedOnTrunk: (findings) => markFixedOnTrunk({ findings, api, id, baseBranch: trunkBranch, log }),
      brokeBy: (findings) => markBrokeBy({ findings, api, id, log }),
      specHistory,
    });
    seen.result = result;
    // A lane red outside its tests, or one with so many failures that triage flagged the run instead of judging them:
    // what the lane comes down to (see diagnoseLane). Its verdict stands where no test of the arrived reports blocks,
    // and replaces a flag (a mass failure is the base branch's or the PR's, not "many failures").
    const flagged = activeFlag(result.infra, result.findings);
    let lane: JudgedLane | null = null;
    if ((outsideTests || flagged) && context) {
      if (!diff.ok && prNumber) diff = await fetchChangedFiles(api, id, prNumber, log);
      const laneBase = isTrunkRun ? id.branch ?? null : prBase;
      const judged = await judgeLane({
        env, fetchImpl, api, tsio: base, id, context, base: laneBase, trunkRun: isTrunkRun,
        prFiles: diff.ok ? diff.files.map((f) => f.filename) : null, lanePaths: lanePathsOf(testRoot, cfg.supportPaths),
        judgedSpecs: run.failing.map((t) => t.file), noResults: Boolean(laneOnly), log,
      });
      const mass = ["broken on main", "fixed on main", "caused by PR"].includes(judged.verdict.label);
      const testsBlock = result.findings.some((f) => f.blocking);
      // A lane without an orchestration (one that does not lease its specs) keeps the judgement it had: its jobs alone
      // cannot show that every spec ran. A lane with no results at all is judged on whatever could be read.
      const grounded = Boolean(judged.orchestration) || Boolean(laneOnly);
      if (grounded && (outsideTests ? !testsBlock || (flagged && mass) : mass)) lane = judged;
      if (lane) decides = true;
      log(`e2e-test-triage: lane ${lane ? "verdict" : "read (tests decide)"}: ${judged.verdict.label} (${judged.verdict.fault}): ${judged.verdict.what}`);
    }
    // A lane red only for placeholders and missing reports, no test's result. Within the repo's allowance the failed jobs
    // are re-run, and the new attempt is triaged again (see e2e-test-rerun); the last attempt asks a person. A lane a test
    // already blocks is not re-run: the re-run would not turn it green. Before asking, the dead jobs' failed steps are
    // read: one the change broke (build, test server) holds the re-run (see decideRerun).
    // The later of the run's own attempt and the identity's: a re-run of failed jobs keeps the first attempt's TSIO
    // identity (gh_run_attempt 1), so the identity alone would promise a re-run the listener will not make.
    const attempt = Math.max(Number(id.gh_run_attempt) || 1, Number(env.GITHUB_RUN_ATTEMPT) || 1);
    const onlyNoResults = (result.unnamed || result.missing) && !result.findings.some((f) => f.blocking);
    // Every report arrived and no test failed, but a job outside the tests died (a worker whose specs the others ran):
    // the lane is red only for that job, and its failed step decides the re-run as for a shard that sent nothing.
    const onlyDeadJobs = redWhy === "upstream" && !run.failing.length && !result.findings.some((f) => f.blocking);
    let rerunCheck: RerunDecision | null = null;
    if (!lane && (onlyNoResults || onlyDeadJobs) && attempt <= cfg.rerunAttempts) {
      try {
        const dead = await readDeadJobs({ fetchImpl, token: String(env.GITHUB_TOKEN), repository: id.repository, runId: String(id.gh_run_id), attempt: String(id.gh_run_attempt), log });
        rerunCheck = await decideRerun(dead, apiKey && !prSpendUnknown ? askCauseWith(fetchImpl, apiKey, cfg.model, result.ai, cfg.prices) : null, log);
      } catch (e) {
        rerunCheck = { rerun: false, held: null, reason: `the run's jobs could not be read (${String(e).slice(0, 120)}; the action needs actions: read)` };
      }
      log(`e2e-test-triage: re-run check: ${rerunCheck.rerun ? "re-run" : rerunCheck.held ? `held, ${rerunCheck.held}` : "left to a person"}: ${rerunCheck.reason}`);
    }
    const spend = ledgerTotals(result.ai);
    if (env.ANSWERS_CACHE && cfg.answers) {
      // What this run counted, on top of the PR's known spend. Unknown spend is not saved as used up: this run made no call, so the next run starts the PR budget fresh.
      if (prNumber) cfg.answers[PR_SPEND_KEY] = { pr: prNumber, usd: prSpent + (spend.cost_usd ?? 0) };
      // The paid answers are already in this run's verdict; a cache that cannot be written only costs the next run.
      try {
        writeFileSync(env.ANSWERS_CACHE, JSON.stringify(cfg.answers));
      } catch (e) {
        log(`answers cache not saved: ${String(e).slice(0, 160)}`);
      }
    }
    if (cfg.budgetLabel) result.ai.budgetLabel = cfg.budgetLabel;
    const laneRed = redWhy === "outside" || redWhy === "upstream";
    if (flakyOnly)
      notes.push(`No test failed: the ${run.counts.flaky === 1 ? "1 test that failed a try" : `${run.counts.flaky} tests that failed a try`} passed on a retry. The lane counted ${run.counts.flaky === 1 ? "it" : "them"} as failed.`);
    // The lane's own re-run: only for a machine failure, and only within the repo's allowance. A lane whose orchestration
    // began is re-run whole, from its first job: re-running its failed jobs alone finds that run closed.
    const laneRerun = lane && lane.verdict.rerun !== "none" && attempt <= cfg.rerunAttempts && Number(env.GITHUB_RUN_ATTEMPT || attempt) <= cfg.rerunAttempts ? lane.verdict.rerun : null;
    const rerun = (lane ? laneRerun : rerunCheck?.rerun) ? { attempt: attempt + 1, of: cfg.rerunAttempts + 1 } : null;
    const held = lane ? null : rerunCheck?.held ?? null;
    if (lane && laneTurnsGreen(lane.verdict, outsideTests) && !result.findings.some((f) => f.blocking)) result.verdict = "SUCCESS";
    else if (lane) result.verdict = "FAILURE";
    // The lane-result gate's line, held before the status is written: a lane red outside its tests (a job outside them
    // died, a report is missing) turns green only on the orchestration ("all specs ran"). Tests that all cleared beside a
    // dead job leave it red, so success is never written for a lane that gate would keep red. A run that writes nothing
    // (decides is false) is left to the gate.
    if (decides && result.verdict === "SUCCESS" && lane?.verdict.label !== "all specs ran" && context && (outsideTests || (run.failing.length > 0 && (await redOutsideTests(api, id, context, log)))))
      result.verdict = "FAILURE";
    // The lane's own text agrees with what is written: a verdict held red above renders red too (report-only keeps it).
    if (enforce && lane && lane.verdict.state === "success" && result.verdict !== "SUCCESS") lane = { ...lane, verdict: { ...lane.verdict, state: "failure" } };
    const laneSection = lane ? renderLane({ verdict: lane.verdict, rerunning: Boolean(rerun), lane: env.LANE || id.name, runURL, base: lane.baseline?.base ?? prBase ?? trunkBranch ?? null }) : "";
    const testsSummary = renderSummary({ mode: enforce ? "enforce" : "report-only", verdict: result.verdict, findings: result.findings, infra: result.infra, runURL, counts: run.counts, ai: result.ai, missing: result.missing, lane: env.LANE || id.name, trunkBranch, pr: Boolean(prNumber), branchRun: branchBase ? id.branch ?? null : null, notes, laneRed, reportsArrived: missingArrived(run.missing), unnamed: result.unnamed ?? null, notRun: result.notRun ?? null, notRunRerun: result.notRunRerun ?? null, rerun, rerunCheck });
    const summary = lane && !result.findings.length ? laneSection : [laneSection, testsSummary].filter(Boolean).join("\n");
    const description = lane
      ? laneDescription(lane.verdict, Boolean(rerun), lane.baseline?.base ?? prBase ?? "main")
      : flakyOnly
      ? `(${run.counts.flaky} flaky, passed on retry) ${passLine(run.counts)}`
      : statusDescription(result.verdict, result.findings, result.infra, run.counts, result.missing, result.unnamed ?? 0, result.notRun ?? 0, rerun, held);
    // The run flag only while it keeps the run red (see activeFlag): a flagged run whose failures were all cleared has none.
    const flag = activeFlag(result.infra, result.findings);
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `effective_mode=${enforce ? "enforce" : "report-only"}\nverdict=${result.verdict}\nblocking=${flag ? run.counts.failed : result.findings.filter((f) => f.blocking).length + (result.unnamed ?? 0)}\nexonerated=${result.findings.filter((f) => !f.blocking).length}\ndescription=${description}\nrerun=${Boolean(rerun)}\nrerun_of=${rerun?.of ?? ""}\nrerun_held=${held ?? ""}\n` +
        `rerun_job=${rerun && laneRerun === "lane" ? String(lane?.startJobId ?? 0) : ""}\nlane_label=${lane?.verdict.label ?? ""}\nlane_fault=${lane?.verdict.fault ?? ""}\nbasis=${lane ? (lane.verdict.label === "all specs ran" ? "orchestration" : "lane") : "tests"}\n` +
        `ai_calls=${spend.calls}\nai_cost_usd=${spend.cost_usd == null ? "unknown" : spend.cost_usd.toFixed(6)}\nai_input_tokens=${spend.input_tokens}\nai_output_tokens=${spend.output_tokens}\n`);
    // A lane with nothing failed or missing has nothing to report, so it writes no job
    // summary: the run page then shows only the lanes someone needs to read.
    if (env.GITHUB_STEP_SUMMARY && (decides || laneRed || lane)) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, summary + "\n");
      written.summary = true;
    }
    // Only the exact value "enforce" writes the required status; anything else is report-only.
    const mode = String(env.MODE ?? "").trim();
    if (mode && mode !== "enforce" && mode !== "report-only")
      log(`unrecognised mode ${JSON.stringify(mode)}; the only value that enforces is "enforce", so this run is report-only`);
    // A lane with nothing failed or missing keeps the status its own job posted: there
    // is nothing triage decided, and overwriting it could turn a lane that went red
    // outside its tests green.
    let published = false;
    if (enforce && context && decides) {
      published = await publisher.write({
        state: result.verdict === "SUCCESS" ? "success" : "failure",
        context,
        description,
        target_url: runURL,
      }, "triage");
    }
    // Report only: triage's line goes on the E2E check, but the check keeps the state it
    // has now. Red stays red, and a check a waiver label turned green stays green. Its link
    // moves to this run, whose summary explains each failure.
    if (!enforce && context && decides) {
      try {
        const current = (await readStatuses(api, id)).find((r) => r.context === context);
        // The publisher also refuses a check another run or attempt owns.
        if (current && current.state !== "pending") await publisher.write({ state: current.state, description, target_url: runURL }, "triage");
        else log(`${context} has no final state yet; its text is left as it is`);
      } catch (e) {
        log(`triage's line not written on ${context}: ${String(e).slice(0, 200)}`);
      }
    }
    if (announce && lanes.length) await settleLaneSummary();
    else if (announce) {
      // The same labels as the E2E check's text (see statusDescription), and its re-run wording.
      const again = held ? `not re-run: ${held}` : rerun ? RERUNNING : RERUN;
      await postTriageCheck(result.verdict === "SUCCESS" ? "success" : "failure", lane ? description : flakyOnly ? `${run.counts.flaky} flaky, passed on retry · no test failed` : (flag && !result.findings.length
        ? `${run.counts.failed} failed · not triaged, ${runFlag(flag)}`
        : `${run.counts.failed} failed → ${statusLabels(result.findings, run.counts.failed).map((l) => (l === RERUN ? again : l)).join(", ") || "none cleared"}${flag ? ` · ${runFlag(flag)}` : ""}${result.unnamed && result.findings.length ? ` · ${again}` : ""}`) + (result.missing ? ` · ${result.missing.short}` : ""));
    }
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `published=${published}\n`);
    result.findings.forEach((f, i) => log(findingLogLine(f, i + 1, result.findings.length, secretsOf(env))));
    log(`e2e-test-triage: ${result.verdict} (${run.counts.failed} failed, ${result.findings.filter((f) => f.blocking).length} blocking)${enforce ? "" : " [report-only]"}`);
    return result;
  } catch (e) {
    if (announce && lanes.length && context) {
      // Mark the lane as having no verdict, so the PR-wide check stops waiting for it.
      try {
        await publisher.write({ state: "failure", context, description: `(not triaged: triage could not finish) ${passLine(run.counts)}`, target_url: runURL }, "triage");
      } catch {
        // The lane's own failure is what the PR shows; a write that fails here changes nothing.
      }
      await settleLaneSummary();
    } else if (announce) await postTriageCheck("error", "Triage could not finish; the E2E result stands");
    throw e;
  }
}
