// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { errorSignature, exoneratedSet, isInfraError, JUDGED } from "./classify.ts";
import { DEFAULTS } from "./config.ts";
import { chainClears, CLEARING, evidenceIds, PACK_IMAGES } from "./pack.ts";
import { answerKey, cachedAnswer, expectedOutput, maxTokensFor, SYSTEM } from "./judge.ts";
import { costOf, ledgerTotals, newLedger } from "./pricing.ts";
import type { Answer, BatchResult, Config, Finding, Ledger, Pack } from "./types.ts";

/**
 * What a non-PR cause must cite before it can clear a judged finding, as the judge's rules
 * require. A related hunk is not on the list: it is evidence the PR may be the cause. Producer
 * evidence is not either: the PR's own CI wrote it, so it supports a clear but cannot carry one.
 */
export function unblocks(cause: string, cited: string[], pack: Pack, cls = ""): boolean {
  const has = (...ids: string[]): boolean => ids.some((id) => cited.includes(id));
  const trunk: Partial<Pack["trunk_history_14d"]> = pack.trunk_history_14d ?? {};
  // A PR that breaks the server fails every test with an environment error, so its text never clears one; nor do trunk's
  // failures, which classify does not read for one and so need not be this failure.
  if (cls === "INFRA_ERROR") {
    if (cause === "test_bug") return has("this_pr");
    return (cause === "flaky_environment" || cause === "bug_on_master") && has("cross_pr", "this_pr");
  }
  if (cause === "flaky_environment") return has("cross_pr", "this_pr") || isInfraError(pack.error) || (has("earlier_failure_same_spec") && chainClears(pack));
  if (cause === "bug_on_master") return has("cross_pr") || (has("trunk_history_14d") && ((trunk.fails ?? 0) > 0 || (trunk.flaky ?? 0) > 0 || trunk.latest === "failed"));
  if (cause === "test_bug") return has("this_pr");
  return false;
}

/** What a judge answer may change for one finding. */
export interface Decision {
  blocking: boolean;
  decision: string;
  answer: Answer | null;
}

/** The decision matrix: what a judge answer may change. Citations must name evidence in the pack. */
export function decide(cls: string, answer: Answer | null | undefined, pack: Pack, cfg: Config = DEFAULTS, isTrunkRun = false, identityUnresolved = false): Decision {
  const EXON = exoneratedSet(isTrunkRun);
  // A finding whose history can't be tied to it is never cleared by an opinion.
  if (identityUnresolved) return { blocking: true, decision: "evidence_incomplete", answer: answer ?? null };
  if (!answer) return { blocking: !EXON.has(cls), decision: "unavailable", answer: null };
  const known = new Set(evidenceIds(pack));
  const cited = answer.cited_evidence.filter((c) => known.has(c));
  const a: Answer = { ...answer, cited_evidence: cited };
  const hunk = cited.some((c) => c.startsWith("hunk_"));
  if (EXON.has(cls)) {
    if (a.cause === "caused_by_pr" && a.confidence >= cfg.vetoMin && hunk) return { blocking: true, decision: "adjudicator_veto", answer: a };
    return { blocking: false, decision: "engine", answer: a };
  }
  // An unblock always needs a citation that exists in the pack.
  if (JUDGED.has(cls) && a.cause !== "caused_by_pr" && a.confidence >= cfg.minConfidence && unblocks(a.cause, cited, pack, cls))
    return { blocking: false, decision: "adjudicator_unblock", answer: a };
  // Naming the PR takes the same bar as clearing it: sure enough, and a change in the
  // diff to point to. A weaker guess keeps the failure red as "needs a look".
  if (JUDGED.has(cls) && a.cause === "caused_by_pr" && a.confidence >= cfg.minConfidence && hunk)
    return { blocking: true, decision: "adjudicator_blame", answer: a };
  return { blocking: !EXON.has(cls), decision: "engine", answer: a };
}

/**
 * Whether any answer could change the outcome (see decide): a veto needs a related
 * hunk; an unblock needs a cross-PR recurrence, a pass earlier on this PR, or (flaky_environment) an infrastructure error
 * or an earlier environment failure in the spec with a pass on another platform (not for a held environment error).
 */
export function canChange(cls: string, pack: Pack, isTrunkRun = false): boolean {
  const ids = evidenceIds(pack);
  const hunk = ids.some((id) => id.startsWith("hunk_"));
  if (exoneratedSet(isTrunkRun).has(cls)) return hunk;
  if (cls === "INFRA_ERROR") return CLEARING(ids);
  if (JUDGED.has(cls)) return CLEARING(ids) || isInfraError(pack.error) || chainClears(pack);
  return false;
}

// An answer that would change the outcome at a higher confidence, and fell short; or
// one that blames the PR without the change that would explain it, which the judge's
// rules forbid and which would otherwise keep a failure red on no evidence.
function nearMiss(cls: string, answer: Answer | null | undefined, pack: Pack, cfg: Config, isTrunkRun: boolean): boolean {
  if (!answer) return false;
  const known = new Set(evidenceIds(pack));
  const cited = answer.cited_evidence.filter((c) => known.has(c));
  const hunk = cited.some((c) => c.startsWith("hunk_"));
  if (JUDGED.has(cls) && answer.cause === "caused_by_pr" && !hunk) return true;
  if (answer.confidence < cfg.escalateMin) return false;
  if (exoneratedSet(isTrunkRun).has(cls)) return answer.cause === "caused_by_pr" && hunk && answer.confidence < cfg.vetoMin;
  const clears = CLEARING(cited) || (cls !== "INFRA_ERROR" && answer.cause === "flaky_environment" && (isInfraError(pack.error) || (cited.includes("earlier_failure_same_spec") && chainClears(pack))));
  return JUDGED.has(cls) && answer.cause !== "caused_by_pr" && answer.confidence < cfg.minConfidence && clears;
}

/** A group of findings that share one question to the model: the first is asked, the others take its answer. */
interface Group {
  lead: { f: Finding; pack: Pack };
  members: { f: Finding; pack: Pack }[];
  advisory: boolean;
  answer?: Answer;
  error?: unknown;
}

/** The most questions one model call carries; a bigger run is asked in several calls. */
export const JUDGED_PER_CALL = 8;

/**
 * Ask the model about findings an answer could change, up to cfg.maxJudged questions, at most
 * JUDGED_PER_CALL per call. Same spec and error share a question; questions that could change the
 * outcome go first, then those that settle more tests; cached answers are reused; a call that could
 * cross the budget is not made, and the calls before it stand; near misses go once to the escalation
 * model. With cfg.advise, blocking findings it can't clear are asked too, as advice only. Whatever the
 * model doesn't settle keeps the rules' outcome.
 */
export async function judge(
  findings: Finding[],
  packs: (Pack | null | undefined)[],
  askMany: (packs: Pack[], model: string) => Promise<BatchResult>,
  cfg: Config = DEFAULTS,
  warn: (message: string) => void = () => {},
  isTrunkRun = false,
  ledger: Ledger = newLedger(),
): Promise<Finding[]> {
  const groups = new Map<string, Group>();
  // TSIO lists a run's failures in no fixed order. Visiting them in one makes the same run pick the same
  // questions, leads and batches every time, so a re-run asks the model what it asked before.
  const sortKey = (f: Finding): string[] => [f.file, f.full_title ?? f.title, f.report_name ?? "", f.title];
  const compareKeys = (a: string[], b: string[]): number => {
    for (const [k, x] of a.entries()) if (x !== b[k]) return x < b[k] ? -1 : 1;
    return 0;
  };
  const order = findings.map((_, i) => i).sort((a, b) => compareKeys(sortKey(findings[a]), sortKey(findings[b])) || a - b);
  for (const i of order) {
    const f = findings[i];
    const pack = packs[i];
    // An environment error the rules cleared is not asked; one still blocking is the judge's to clear or blame.
    if (!pack || f.identity_unresolved || !((JUDGED.has(f.class) && f.blocking) || exoneratedSet(isTrunkRun).has(f.class))) continue;
    const advisory = !canChange(f.class, pack, isTrunkRun);
    if (advisory && !(cfg.advise && f.blocking && JUDGED.has(f.class))) {
      ledger.skipped.no_effect++;
      f.ai = { skipped: "nothing the model could change" };
      continue;
    }
    const sig = errorSignature(f.error);
    // An environment error never shares a question with another class: its own error is what may clear it.
    const key = sig ? JSON.stringify([exoneratedSet(isTrunkRun).has(f.class), advisory, f.class === "INFRA_ERROR", f.file, sig]) : `#${i}`;
    const existing = groups.get(key);
    if (existing) {
      ledger.skipped.duplicate++;
      existing.members.push({ f, pack });
    } else groups.set(key, { lead: { f, pack }, members: [{ f, pack }], advisory });
  }
  let pending = [...groups.values()].sort((a, b) => Number(a.advisory) - Number(b.advisory) || b.members.length - a.members.length);
  for (const g of pending.slice(cfg.maxJudged)) {
    ledger.skipped.cap++;
    for (const m of g.members) m.f.ai = { skipped: "over the per-run limit" };
  }
  pending = pending.slice(0, cfg.maxJudged);
  const settle = (g: Group, answer: Answer | undefined, error: unknown): void => {
    for (const m of g.members) {
      if (g.advisory) {
        if (answer && !error) Object.assign(m.f, { decision: "advice", judge: answer });
        continue;
      }
      if (error) {
        Object.assign(m.f, { decision: "unavailable" });
        continue;
      }
      const d = decide(m.f.class, answer, m.pack, cfg, isTrunkRun, false);
      Object.assign(m.f, { blocking: d.blocking, decision: d.decision, judge: d.answer });
    }
  };
  // One model call, made only when its worst case fits what is left of the budget.
  const call = async (model: string, fresh: Group[], retryMissing: boolean): Promise<void> => {
    const chars = fresh.reduce((n, g) => n + JSON.stringify(g.lead.pack).length, SYSTEM.length);
    const images = fresh.reduce((n, g) => n + (PACK_IMAGES.get(g.lead.pack)?.length ?? 0), 0);
    const worst = costOf({ input_tokens: chars / 3 + images * 1600, output_tokens: expectedOutput(model, fresh.length) }, model, cfg.prices);
    // Fail closed: a call is made only when its cost is bounded (the model is priced), the spend so far
    // is known, and the budget is a real amount. Otherwise the budget check would pass for nothing.
    const spent = ledgerTotals(ledger).cost_usd;
    const budgetIsAmount = Number.isFinite(cfg.budgetUsd) && cfg.budgetUsd >= 0;
    // A NaN cost or spend compares false against the budget, so it must be refused here, not compared.
    if (worst == null || !Number.isFinite(worst) || spent == null || !Number.isFinite(spent) || !budgetIsAmount || spent + worst > cfg.budgetUsd) {
      ledger.skipped.budget += fresh.length;
      const which = cfg.budgetLabel ?? `$${cfg.budgetUsd} run budget`;
      const why =
        worst == null || !Number.isFinite(worst) ? `${model} has no price, so its cost cannot be bounded`
        : spent == null || !Number.isFinite(spent) ? "an earlier call's cost is unknown"
        : !budgetIsAmount ? `the budget ${JSON.stringify(cfg.budgetUsd)} is not an amount of 0 or more`
        : `up to $${worst.toFixed(4)} would cross the ${which}`;
      warn(`model call skipped: ${why}`);
      for (const g of fresh) for (const m of g.members) m.f.ai ??= { skipped: why };
      return;
    }
    const count = fresh.reduce((n, g) => n + g.members.length, 0);
    // A response's cost is its usage at list price. Without usage the cost is unknown, so the worst-case
    // estimate stands in for it: the PR's spend must never be counted low.
    const costOfResponse = (usage: BatchResult["usage"]): number => costOf(usage, model, cfg.prices) ?? worst;
    let res: BatchResult;
    try {
      res = await askMany(fresh.map((g) => g.lead.pack), model);
    } catch (e) {
      // A rejected response (cut off, or from another model) is not used, but it was billed.
      const usage = (e as { usage?: BatchResult["usage"] } | null | undefined)?.usage;
      if (usage) {
        const servedModel = (e as { served_model?: string | null } | null | undefined)?.served_model;
        ledger.calls.push({ model, served_model: servedModel ?? model, findings: count, usage, cost_usd: costOfResponse(usage), rejected: String(e).slice(0, 120) });
      }
      warn(`judge unavailable (${model}): ${String(e).slice(0, 200)}`);
      for (const g of fresh) g.error = e;
      return;
    }
    const cost = costOfResponse(res.usage);
    ledger.calls.push({ model, served_model: res.served_model ?? model, findings: count, usage: res.usage, cost_usd: cost });
    const share = cost / count;
    for (const [i, g] of fresh.entries()) {
      const a = res.answers[i];
      if (a instanceof Error) {
        const missing = (a as { missing?: unknown }).missing === true;
        if (!(retryMissing && missing)) warn(`judge unavailable for "${g.lead.f.title}": ${String(a).slice(0, 200)}`);
        g.error = a;
      } else {
        g.answer = a;
        if (cfg.answers) cfg.answers[answerKey(model, g.lead.pack)] = { cause: a.cause, confidence: a.confidence, cited_evidence: a.cited_evidence, explanation: a.explanation, provenance: a.provenance };
      }
      for (const m of g.members) m.f.ai = { model, cost_usd: (m.f.ai?.cost_usd ?? 0) + share };
    }
  };
  // A finding a response left out is asked once more, on its own.
  const ask = async (model: string, batch: Group[], retryMissing = true): Promise<void> => {
    const fresh: Group[] = [];
    for (const g of batch) {
      const cached = cachedAnswer(cfg.answers?.[answerKey(model, g.lead.pack)]);
      if (cached) {
        ledger.skipped.cached++;
        g.answer = cached;
      } else fresh.push(g);
    }
    for (let i = 0; i < fresh.length; i += JUDGED_PER_CALL) await call(model, fresh.slice(i, i + JUDGED_PER_CALL), retryMissing);
    const isMissing = (e: unknown): boolean => (e as { missing?: unknown } | null | undefined)?.missing === true;
    const missed = fresh.filter((g) => isMissing(g.error));
    if (retryMissing && missed.length) {
      warn(`asking again about ${missed.length} finding(s) the ${model} response left out: ${String(missed[0].error).slice(0, 200)}`);
      for (const g of missed) delete g.error;
      await ask(model, missed, false);
    }
  };
  await ask(cfg.model, pending);
  for (const g of pending) settle(g, g.answer, g.answer ? null : g.error ?? null);
  const escalate = cfg.escalationModel && cfg.escalationModel !== cfg.model
    ? pending.filter((g) => !g.advisory && g.answer && nearMiss(g.lead.f.class, g.answer, g.lead.pack, cfg, isTrunkRun))
    : [];
  if (escalate.length) {
    for (const g of escalate) delete g.answer;
    await ask(cfg.escalationModel, escalate);
    for (const g of escalate) {
      if (!g.answer) continue;
      settle(g, g.answer, null);
      for (const m of g.members) m.f.escalated = true;
    }
  }
  return findings;
}
