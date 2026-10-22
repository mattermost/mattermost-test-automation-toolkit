// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { laneName, laneSummary } from "../../shared/src/lane.ts";
import { readStatuses, statusPublisher } from "../../shared/src/status.ts";
import { compositeIdentityFrom, fetchRun, tsioBase } from "../../shared/src/tsio.ts";
import type { CompositeIdentity, Wait } from "../../shared/src/tsio.ts";
import { configFrom, DEFAULTS, historyLane, PR_SPEND_KEY } from "./config.ts";
import { loadEvidence } from "./evidence.ts";
import { fetchChangedFiles, fetchHistory, markBrokeBy, markOutOfDate } from "./history.ts";
import { enrichFindings } from "./enrich.ts";
import { askModelBatch } from "./judge.ts";
import { evaluateRun } from "./evaluate.ts";
import type { EvaluatedRun } from "./evaluate.ts";
import { ledgerTotals } from "./pricing.ts";
import { passLine, renderSummary, renderUnfinished, statusDescription } from "./render.ts";
import type { AskFn, Config, Diff, HistoryLike } from "./types.ts";

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

export interface TriageOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
  now?: Date;
  wait?: Wait;
}

/**
 * Triages a run. However it ends without a verdict (a read that fails, a history that stays down), the job summary
 * says why, in report-only too, so the run page does not show only an exit.
 */
export async function triage(options: TriageOptions): Promise<EvaluatedRun> {
  const written = { summary: false };
  try {
    return await decideRun(options, written);
  } catch (e) {
    const log = options.log ?? console.error;
    const summaryPath = options.env.GITHUB_STEP_SUMMARY;
    if (!written.summary && summaryPath) {
      const reason = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0] ?? "";
      try {
        appendFileSync(summaryPath, renderUnfinished({ reason, lane: options.env.LANE || null }) + "\n");
      } catch (writeError) {
        log(`triage's summary not written: ${String(writeError).slice(0, 160)}`);
      }
    }
    throw e;
  }
}

async function decideRun({ env, fetchImpl = fetch, log = console.error, now = new Date(), wait }: TriageOptions, written: { summary: boolean }): Promise<EvaluatedRun> {
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
    const trunkBranch: string | null | undefined = isTrunkRun ? id.branch : pull.base?.ref ?? null;
    if (run.failing.length) {
      [history, diff] = await Promise.all([
        fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg, trunkBranch, reportName, log, historyLane(id, cfg)),
        fetchChangedFiles(api, id, prNumber, log),
      ]);
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
      enrich: (findings) => enrichFindings({ findings, api, fetchImpl, base, id, testRoot, log }),
      outOfDate: (findings) => markOutOfDate({ findings, api, id, baseBranch: trunkBranch, log }),
      brokeBy: (findings) => markBrokeBy({ findings, api, id, log }),
    });
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
    const summary = renderSummary({ mode: enforce ? "enforce" : "report-only", verdict: result.verdict, findings: result.findings, infra: result.infra, runURL, counts: run.counts, ai: result.ai, missing: result.missing, lane: env.LANE || id.name, trunkBranch, pr: Boolean(prNumber), notes });
    const description = statusDescription(result.verdict, result.findings, result.infra, run.counts, result.missing);
    if (env.GITHUB_OUTPUT)
      appendFileSync(env.GITHUB_OUTPUT, `effective_mode=${enforce ? "enforce" : "report-only"}\nverdict=${result.verdict}\nblocking=${result.infra ? run.counts.failed : result.findings.filter((f) => f.blocking).length}\nexonerated=${result.findings.filter((f) => !f.blocking).length}\ndescription=${description}\n` +
        `ai_calls=${spend.calls}\nai_cost_usd=${spend.cost_usd == null ? "unknown" : spend.cost_usd.toFixed(6)}\nai_input_tokens=${spend.input_tokens}\nai_output_tokens=${spend.output_tokens}\n`);
    // A lane with nothing failed or missing has nothing to report, so it writes no job
    // summary: the run page then shows only the lanes someone needs to read.
    if (env.GITHUB_STEP_SUMMARY && (run.failing.length > 0 || Boolean(run.missing))) {
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
    // has now. Red stays red, and a check a waiver label turned green stays green.
    if (!enforce && context && (run.failing.length > 0 || Boolean(run.missing))) {
      try {
        const current = (await readStatuses(api, id)).find((r) => r.context === context);
        // The publisher also refuses a check another run or attempt owns.
        if (current && current.state !== "pending") await publisher.write({ state: current.state, description, target_url: current.target_url || runURL }, "triage");
        else log(`${context} has no final state yet; its text is left as it is`);
      } catch (e) {
        log(`triage's line not written on ${context}: ${String(e).slice(0, 200)}`);
      }
    }
    if (announce && lanes.length) await settleLaneSummary();
    else if (announce) {
      const blocking = result.findings.filter((f) => f.blocking).length;
      await postTriageCheck(result.verdict === "SUCCESS" ? "success" : "failure", (result.infra && !result.findings.length
        ? `${run.counts.failed} failed · investigation required`
        : `${run.counts.failed} failed → ${result.findings.length - blocking} cleared · ${blocking} blocking${result.infra ? " · investigation required" : ""}`) + (result.missing ? ` · ${result.missing.short}` : ""));
    }
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `published=${published}\n`);
    log(`e2e-triage: ${result.verdict} (${run.counts.failed} failed, ${result.findings.filter((f) => f.blocking).length} blocking)${enforce ? "" : " [report-only]"}`);
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
