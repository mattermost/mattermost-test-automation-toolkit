// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DAY } from "./model.ts";
import type { Kind } from "./model.ts";

// Requests are kept this long. Flaky specs are rotated by when they were last asked about within it.
export const LEDGER_MS = 7 * DAY;

/**
 * A request sent by an earlier run: a fix request { at, specs, kind, window?, run } (window: a break's run times,
 * `from` null for -Infinity), or a conflict request { at, pr, head, run }.
 */
export interface LedgerEntry {
  at: string;
  specs?: string[];
  kind?: Kind;
  window?: { from: number | null; to: number };
  run?: string;
  pr?: number;
  head?: string;
}

/**
 * Requests sent by earlier runs, persisted between runs by the action's cache. A missing ledger is an empty one;
 * an unreadable one stops the run.
 */
export function readLedger(path: string | null | undefined): LedgerEntry[] {
  if (!path) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return []; // the first run, or the cache expired
    throw e;
  }
  // An unreadable ledger would drop every hold and resend what agents are working on: stop instead.
  try {
    return (JSON.parse(text) as { requests?: LedgerEntry[] }).requests ?? [];
  } catch (e) {
    throw new Error(`ledger ${path} is not valid JSON (${errorMessage(e)}); delete the e2e-master-watch caches to start a new one`);
  }
}

export function writeLedger(path: string | null | undefined, requests: LedgerEntry[]): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  // Renamed into place, so an interrupted write can't leave half a ledger for the cache to save.
  writeFileSync(`${path}.tmp`, JSON.stringify({ requests }, null, 1));
  renameSync(`${path}.tmp`, path);
}

/** The message of an error thrown by the runtime, as `e.message`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}
