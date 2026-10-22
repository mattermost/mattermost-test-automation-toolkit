// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { Env } from "../../shared/src/github.ts";
import type { CompositeIdentity } from "../../shared/src/tsio.ts";
import { PRICES } from "./pricing.ts";
import type { Config, Prices } from "./types.ts";

// Where the answers cache keeps what this lane spent on the PR so far; answer keys start with "v".
export const PR_SPEND_KEY = "_pr_spend";

// Page caps so one busy spec file cannot stall the job.
export const HISTORY_MAX_FILES = 50;
export const HISTORY_PER_PAGE = 2000;
export const HISTORY_MAX_PAGES = 25;
export const CHANGED_FILES_MAX_PAGES = 30;
// GitHub's compare endpoint lists at most this many changed files, in one response: per_page and page
// do not page the files (they apply to the commits), so a comparison that reaches it is cut off.
export const COMPARE_FILE_CAP = 300;

export const DEFAULTS: Config = {
  windowDays: 14,
  // Runs, not days, per history query (see fetchHistory).
  trunkRuns: 50,
  crossPRRuns: 200,
  minTrunkRuns: 5,
  pMin: 0.05,
  crossPRMinPRs: 3,
  minConfidence: 0.85,
  vetoMin: 0.9,
  maxJudged: 8,
  // Ask about blocking findings the model can't clear, as advice only.
  advise: true,
  infraMinFailures: 30,
  infraClears: false,
  historyLane: null,
  // Re-asks an answer between escalateMin and the threshold, or one that blames the PR
  // without citing a change. Off ("") until the share of answers in that band shows a
  // second model is worth its price (Fable 5.1 costs 5x Sonnet 5.5 per token).
  escalationModel: "",
  escalateMin: 0.6,
  // Per-run spend ceiling; a call that could cross it is not made.
  budgetUsd: 1,
  // Spend ceiling for one PR across all its commits and lanes, split evenly between
  // the lanes in TRIAGE_LANES. Kept in the answers cache, so it needs one keyed by PR.
  prBudgetUsd: 2,
  // A PR with this label gets report-only triage whatever the repo's mode: an author
  // can make triage stricter on their PR, never looser. Empty turns it off.
  reportOnlyLabel: "E2E/Triage-report-only",
  // Replays of real mobile runs (mattermost-mobile#10172): Haiku 4.5 blamed the PR
  // without citing a change on 3 of 6 findings; Sonnet 5.5 cited correctly on all of
  // them and cleared 4 of the 5 the PR did not cause, Fable 5.1 the fifth on escalation.
  model: "claude-sonnet-5-5",
};

// A run name without its run type, so PR and trunk runs of one suite compare:
// mobile-pr-detox-ios ~ mobile-main-detox-ios, desktop-pr ~ desktop-master,
// playwright-full-enterprise ~ ...-master. History is compared within a lane.
export const laneOf = (name: string | null | undefined): string =>
  String(name ?? "")
    .replace(/^(mobile|desktop)-(pr|main|master)(-|$)/, "")
    .replace(/-(master|main|release(-cut)?)$/, "") || "default";

// The OS a desktop report stands for, by the name it is uploaded under (the release version after it is ignored).
const OS_OF_REPORT: [RegExp, string][] = [[/ubuntu/, "linux"], [/windows/, "windows"], [/macos/, "macos"]];
/** The platform a report name stands for: "e2e-on-ubuntu-latest-1.0" is linux. Any other name keeps its name, without the e2e prefix. */
export const laneOfReport = (name: string): string => {
  const rest = String(name).replace(/^e2e-on-/, "");
  return OS_OF_REPORT.find(([re]) => re.test(rest))?.[1] ?? rest;
};
/** The OS a report name stands for, or null when it names none (a worker or shard of the same lane, as on mattermost). */
export const osOfReport = (name: string): string | null => OS_OF_REPORT.find(([re]) => re.test(String(name)))?.[1] ?? null;

/**
 * TSIO's spec path relative to the repository, so it can be compared with the
 * PR's changed files. `testRoot` is "." when TSIO's paths are already
 * repository-relative; null (not configured) makes ownership unknowable.
 */
export const repoPath = (testRoot: string | null | undefined, file: string): string | null => {
  if (testRoot == null || testRoot === "") return null;
  const root = String(testRoot).replace(/^\.?\/*/, "").replace(/\/+$/, "");
  return root === "" ? file : `${root}/${file}`;
};

/**
 * The lane whose history a run is judged against: its own, or HISTORY_LANE for a lane the trunk
 * rarely runs (mattermost's subpath suite reads the enterprise lane: same tests and server build).
 */
export const historyLane = (id: CompositeIdentity, cfg: Config = DEFAULTS): string | null => cfg.historyLane || laneOf(id.name);

/**
 * MIN_CONFIDENCE, kept within the documented 0.5-1: unset uses the default, a value that is not a number
 * uses the default, and a value outside the range is clamped. Each of those is warned.
 */
function confidenceFrom(raw: string | undefined, warn: (message: string) => void): number {
  if (raw == null || String(raw).trim() === "") return DEFAULTS.minConfidence;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(`MIN_CONFIDENCE ${JSON.stringify(raw)} is not a number; using ${DEFAULTS.minConfidence}`);
    return DEFAULTS.minConfidence;
  }
  const clamped = Math.min(1, Math.max(0.5, n));
  if (clamped !== n) warn(`MIN_CONFIDENCE ${n} is outside 0.5-1; using ${clamped}`);
  return clamped;
}

/** A USD ceiling: unset uses the default; anything that is not a finite amount of 0 or more is warned and uses the default. */
function amountFrom(raw: string | undefined, fallback: number, name: string, warn: (message: string) => void): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warn(`${name} ${JSON.stringify(raw)} is not a finite amount of 0 or more; using $${fallback}`);
  return fallback;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrice = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
const PRICE_FIELDS = ["input", "output", "cache_write", "cache_read"] as const;

/**
 * AI_PRICES, over the list prices. An entry must carry all four prices, each a finite number of 0 or more (costOf
 * multiplies all four). A malformed entry is warned and its model is left unpriced, so the judge does not call it;
 * the rest of the table and the run go on. A value that is not a JSON object warns, and no model is priced.
 */
export function pricesFrom(raw: string, warn: (message: string) => void = () => {}): Prices {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("AI_PRICES is not valid JSON; no model is priced, so the judge calls no model this run");
    return {};
  }
  if (!isPlainObject(parsed)) {
    warn("AI_PRICES is not a JSON object of model prices; no model is priced, so the judge calls no model this run");
    return {};
  }
  const overrides: Prices = {};
  const malformed: string[] = [];
  for (const [model, price] of Object.entries(parsed)) {
    if (isPlainObject(price) && PRICE_FIELDS.every((k) => isPrice(price[k]))) {
      overrides[model] = { input: Number(price.input), output: Number(price.output), cache_write: Number(price.cache_write), cache_read: Number(price.cache_read) };
    } else {
      warn(`AI_PRICES ${JSON.stringify(model)} needs input, output, cache_write and cache_read, each a finite number of 0 or more; that model is unpriced, so the judge does not call it`);
      malformed.push(model);
    }
  }
  const table: Prices = { ...PRICES, ...overrides };
  for (const model of malformed) delete table[model];
  return table;
}

/**
 * Engine settings from the action's environment. An empty ESCALATION_MODEL turns escalation off.
 * `warn` receives each setting that was invalid and replaced.
 */
export function configFrom(env: Env, warn: (message: string) => void = () => {}): Config {
  const prices = env.AI_PRICES ? pricesFrom(env.AI_PRICES, warn) : PRICES;
  return {
    ...DEFAULTS,
    minConfidence: confidenceFrom(env.MIN_CONFIDENCE, warn),
    model: env.CLAUDE_MODEL || DEFAULTS.model,
    escalationModel: env.ESCALATION_MODEL ?? DEFAULTS.escalationModel,
    budgetUsd: amountFrom(env.AI_BUDGET_USD, DEFAULTS.budgetUsd, "AI_BUDGET_USD", warn),
    prBudgetUsd: amountFrom(env.PR_BUDGET_USD, DEFAULTS.prBudgetUsd, "PR_BUDGET_USD", warn),
    reportOnlyLabel: (env.REPORT_ONLY_LABEL ?? DEFAULTS.reportOnlyLabel).trim(),
    advise: env.AI_ADVICE ? env.AI_ADVICE !== "false" : DEFAULTS.advise,
    infraClears: env.INFRA_CLEARS === "true",
    historyLane: (env.HISTORY_LANE || "").trim() || null,
    prices,
  };
}
