// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { CallRecord, Ledger, Prices, Price, Usage } from "./types.ts";

// List prices, USD per million tokens, as of 2026-10-02. AI_PRICES overrides or adds.
export const PRICES: Prices = {
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
};

export function priceFor(model: string | null | undefined, prices: Prices = PRICES): Price | null {
  const m = String(model ?? "");
  const key = Object.keys(prices).sort((a, b) => b.length - a.length).find((k) => m === k || m.startsWith(`${k}-`));
  return key ? prices[key] : null;
}

/** USD for one response's usage, or null when the model has no price or the cost is not a finite number. */
export function costOf(usage: Usage | null | undefined, model: string | null | undefined, prices: Prices = PRICES): number | null {
  const p = priceFor(model, prices);
  if (!p || !usage) return null;
  const n = (k: string): number => Number(usage[k] ?? 0);
  const usd = (n("input_tokens") * p.input + n("output_tokens") * p.output + n("cache_creation_input_tokens") * p.cache_write + n("cache_read_input_tokens") * p.cache_read) / 1e6;
  // NaN compares false against every ceiling, so a cost that is not a number is unknown, never a pass.
  return Number.isFinite(usd) ? usd : null;
}

// What a run spent on the model, and why it did not spend more.
export const newLedger = (): Ledger => ({ calls: [], skipped: { no_effect: 0, duplicate: 0, cached: 0, cap: 0, budget: 0 } });

export interface LedgerTotals {
  calls: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export function ledgerTotals(ledger: Ledger): LedgerTotals {
  const sum = (k: string): number => ledger.calls.reduce((n: number, c: CallRecord) => n + Number(c.usage?.[k] ?? 0), 0);
  const costs = ledger.calls.map((c) => c.cost_usd);
  const known = costs.filter((c): c is number => c != null);
  return {
    calls: ledger.calls.length,
    input_tokens: sum("input_tokens") + sum("cache_read_input_tokens") + sum("cache_creation_input_tokens"),
    cached_tokens: sum("cache_read_input_tokens"),
    output_tokens: sum("output_tokens"),
    cost_usd: known.length === costs.length ? known.reduce((a, b) => a + b, 0) : null,
  };
}
