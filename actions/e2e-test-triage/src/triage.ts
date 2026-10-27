// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl, GhApi } from "../../shared/src/github.ts";
import { laneName, laneSummary } from "../../shared/src/lane.ts";
import { readStatuses, statusPublisher } from "../../shared/src/status.ts";
import { compositeIdentityFrom, fetchRun, missingArrived, NoResultsError, SupersededRunError, tsioBase } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, RunResult, Wait } from "../../shared/src/tsio.ts";
import { isShardPlaceholder, isSpecNotRun } from "./classify.ts";
import { configFrom, DEFAULTS, historyLane, PR_SPEND_KEY } from "./config.ts";
import { loadEvidence } from "./evidence.ts";
import { fetchChangedFiles, fetchHistory, fetchSpecRuns, markBrokeBy, markOutOfDate, trunkRunsOn } from "./history.ts";
import { enrichFindings, siblingPlatforms } from "./enrich.ts";
import { askModelBatch } from "./judge.ts";
import { evaluateRun } from "./evaluate.ts";
import type { EvaluatedRun } from "./evaluate.ts";
import { findingLogLine, redact, secretsOf, writeFindings } from "./findings.ts";
import { ledgerTotals } from "./pricing.ts";
import { activeFlag, noResultsText, otherRunText, passLine, renderNotTriaged, renderSummary, renderUnfinished, RERUN, RERUNNING, runFlag, statusDescription, statusLabels, supersededText } from "./render.ts";
import type { AskFn, Config, Diff, HistoryLike, SpecHistory } from "./types.ts";

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
async function noteNoResults({ env, fetchImpl = fetch, log = console.error }: TriageOptions, id: TriageIdentity): Promise<void> {
  const context = env.STATUS_CONTEXT;
  if (!context || !env.GITHUB_TOKEN) return;
  try {
    const api = gh(fetchImpl, String(env.GITHUB_TOKEN));
    const own = (await readStatuses(api, id)).find((r) => r.context === context);
    if (!own || own.state === "pending") return;
    const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
    await statusPublisher({ api, id, context, env, log }).write({ state: own.state, description: "(not triaged: no results)", target_url: runURL }, "triage");
  } catch (e) {
    log(`not-triaged note not written on ${context}: ${String(e).slice(0, 200)}`);
  }
}

/**
 * Whether the lane's own status is red. Read only where no test failed: a red lane then has a job outside the tests
 * that failed, which the summary says. Nothing is written for it. An unreadable status is logged, and reads as not red.
 */
async function laneIsRed(api: GhApi, id: TriageIdentity, context: string, log: (message: string) => void): Promise<boolean> {
  try {
    const own = (await readStatuses(api, id)).find((r) => r.context === context);
    return own?.state === "failure" || own?.state === "error";
  } catch (e) {
    log(`lane status unavailable: ${String(e).slice(0, 160)}`);
    return false;
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

async function decideRun({ env, fetchImpl = fetch, log = console.error, now = new Date(), wait }: TriageOptions, written: { summary: boolean }, seen: Seen): Promise<EvaluatedRun> {
  const cfg: Config = configFrom(env, log);
  const id = compositeIdentityFrom<TriageIdentity>(env.COMPOSITE_IDENTITY);
  const prNumber = Number(id.gh_pr_number || 0) || null;
  // No PR number: a trunk run (see EXONERATED_ON_TRUNK).
  const isTrunkRun = prNumber == null;
  const base = tsioBase(env);
  const api = gh(fetchImpl, String(env.GITHUB_TOKEN));
  // Not guessed: a wrong root makes every spec look untouched.
  const testRoot = env.TEST_ROOT ? env.TEST_ROOT : null;
  const reportName = env.REPORT_NAME || null;
  const run = await fetchRun(fetchImpl, base, id, reportName, wait);
  seen.run = run;
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
  // Like the required status, only an enforcing run writes to the PR.
  const announce = enforce && (run.failing.length > 0 || Boolean(run.missing));
  // TRIAGE_LANES lists every lane's required context: then the triage check is one
  // for the whole PR, summarising all lanes, rather than one per lane.
  const lanes = String(env.TRIAGE_LANES ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  // All required-status writers and this snapshot hold one SHA-scoped job
  // concurrency lock. A delayed second snapshot cannot substitute for that lock.
  const settleLaneSummary = async (): Promise<void> => {
    try {
      await publisher.refresh(lanes, triageContext ?? undefined, laneSummary);
    } catch (e) {
      log(`triage check ${triageContext} not summarised: ${String(e).slice(0, 200)}`);
    }
  };
  if (announce) await postTriageCheck("pending", lanes.length ? `Triage is checking ${laneName(String(context))}` : `${run.counts.failed} failed · triage is checking them`);
  try {
    let history: HistoryLike = new Map();
    let diff: Diff = { files: [], ok: false };
    // A PR's trunk is its base branch, when TSIO has enough of that branch's runs to judge by (a stacked PR's base often has
    // too few); otherwise it is the repository's default branch, and the summary says so.
    const prBase = isTrunkRun ? null : pull.base?.ref ?? null;
    let trunkBranch: string | null | undefined = isTrunkRun ? id.branch : prBase;
    // A run of shard placeholders only needs no history. Otherwise placeholders' files are asked for too: TSIO counts its
    // run window over the files asked for, so dropping one would change which past runs the real tests are judged on.
    if (run.failing.some((t) => !isShardPlaceholder(t))) {
      [history, diff] = await Promise.all([
        fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, reportName, log, historyLane(id, cfg)),
        fetchChangedFiles(api, id, prNumber, log),
      ]);
      const baseRuns = prBase ? trunkRunsOn(history, prBase) : 0;
      if (prBase && baseRuns < cfg.minTrunkRuns) {
        const fallback = await defaultBranchOf(api, id.repository, log);
        if (fallback && fallback !== prBase) {
          trunkBranch = fallback;
          notes.push(`Trunk history is read from ${fallback}, the default branch: ${prBase} has ${baseRuns} earlier runs of these tests, fewer than ${cfg.minTrunkRuns}.`);
          history = await fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, reportName, log, historyLane(id, cfg));
        }
      }
    } else if (run.failing.some(isSpecNotRun)) {
      // A spec that did not run is never cleared while the change edits it (see classifyNotRun).
      diff = await fetchChangedFiles(api, id, prNumber, log);
    }
    // Specs that did not run are judged by their files' past runs; unreadable history clears none. It asks for every
    // failing file, as fetchHistory does: TSIO counts its run window over the files asked for.
    let specHistory: SpecHistory | null = null;
    if (run.failing.some(isSpecNotRun)) {
      try {
        specHistory = await fetchSpecRuns(fetchImpl, base, id.repository, run.failing.map((t) => t.file), now.toISOString(), cfg, historyLane(id, cfg), reportName);
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
      run, id, prNumber, history, diff, trunkBranch, testRoot, cfg,
      prTitle: pull.title ?? "", lane: env.LANE || id.name, log,
      ask,
      evidence: env.EVIDENCE_DIR ? loadEvidence(env.EVIDENCE_DIR, log) : [],
      enrich: (findings) => enrichFindings({ findings, api, id, testRoot, prFiles: diff.ok ? diff.files : null, baseBranch: prBase, log }),
      otherPlatforms: (findings) => siblingPlatforms({ findings, fetchImpl, base, id, log }),
      outOfDate: (findings) => markOutOfDate({ findings, api, id, baseBranch: trunkBranch, until: now.toISOString(), log }),
      brokeBy: (findings) => markBrokeBy({ findings, api, id, log }),
      specHistory,
    });
    seen.result = result;
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
    // Nothing failed and every report arrived, yet the lane is red: a job outside the tests failed. Its own status says so.
    const laneRed = !run.failing.length && !run.missing && context ? await laneIsRed(api, id, context, log) : false;
    // A lane red only for placeholders and missing reports, no test's result. Within the repo's allowance the failed jobs
    // are re-run, and the new attempt is triaged again (see e2e-test-rerun); the last attempt asks a person. A lane a test
    // already blocks is not re-run: the re-run would not turn it green.
    const attempt = Number(id.gh_run_attempt) || 1;
    const onlyNoResults = (result.unnamed || result.missing) && !result.findings.some((f) => f.blocking);
    const rerun = onlyNoResults && attempt <= cfg.rerunAttempts ? { attempt: attempt + 1, of: cfg.rerunAttempts + 1 } : null;
    const summary = renderSummary({ mode: enforce ? "enforce" : "report-only", verdict: result.verdict, findings: result.findings, infra: result.infra, runURL, counts: run.counts, ai: result.ai, missing: result.missing, lane: env.LANE || id.name, trunkBranch, pr: Boolean(prNumber), notes, laneRed, reportsArrived: missingArrived(run.missing), unnamed: result.unnamed ?? null, notRun: result.notRun ?? null, notRunRerun: result.notRunRerun ?? null, rerun });
    const description = statusDescription(result.verdict, result.findings, result.infra, run.counts, result.missing, result.unnamed ?? 0, result.notRun ?? 0, rerun);
    // The run flag only while it keeps the run red (see activeFlag): a flagged run whose failures were all cleared has none.
    const flag = activeFlag(result.infra, result.findings);
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `effective_mode=${enforce ? "enforce" : "report-only"}\nverdict=${result.verdict}\nblocking=${flag ? run.counts.failed : result.findings.filter((f) => f.blocking).length + (result.unnamed ?? 0)}\nexonerated=${result.findings.filter((f) => !f.blocking).length}\ndescription=${description}\nrerun=${Boolean(rerun)}\nrerun_of=${rerun?.of ?? ""}\n` +
        `ai_calls=${spend.calls}\nai_cost_usd=${spend.cost_usd == null ? "unknown" : spend.cost_usd.toFixed(6)}\nai_input_tokens=${spend.input_tokens}\nai_output_tokens=${spend.output_tokens}\n`);
    // A lane with nothing failed or missing has nothing to report, so it writes no job
    // summary: the run page then shows only the lanes someone needs to read.
    if (env.GITHUB_STEP_SUMMARY && (run.failing.length > 0 || Boolean(run.missing) || laneRed)) {
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
    if (enforce && context && (run.failing.length > 0 || Boolean(run.missing))) {
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
    if (!enforce && context && (run.failing.length > 0 || Boolean(run.missing))) {
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
      const again = rerun ? RERUNNING : RERUN;
      await postTriageCheck(result.verdict === "SUCCESS" ? "success" : "failure", (flag && !result.findings.length
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
