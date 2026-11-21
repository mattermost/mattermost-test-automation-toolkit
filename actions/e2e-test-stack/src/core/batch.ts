// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/** What names a batch: the caller, the run, the batch within it, and the run's latest attempt. */
export interface BatchOwner {
  callerKey: string;
  runId: string;
  batch: string;
  /** The run's attempt now; a batch from a later one is not this run's. */
  attempt: number;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The attempt that created batchId, when it is exactly <caller-key>-<run id>-<batch>-<attempt>-<suffix> for this
 * owner, with attempt from 1 to the run's attempt now and a suffix of lowercase letters and digits; undefined
 * otherwise. The suffix holds no hyphen, so another batch of the run whose name extends this one never matches.
 */
export function batchAttempt(batchId: string, owner: BatchOwner): number | undefined {
  const prefix = `${escape(owner.callerKey)}-${escape(owner.runId)}-${escape(owner.batch)}`;
  const m = new RegExp(`^${prefix}-([1-9][0-9]*)-[a-z0-9]+$`).exec(batchId);
  if (!m) return undefined;
  const attempt = Number(m[1]);
  return Number.isSafeInteger(attempt) && attempt <= owner.attempt ? attempt : undefined;
}
