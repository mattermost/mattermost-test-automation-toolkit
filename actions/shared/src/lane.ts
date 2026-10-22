// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { CommitStatus } from "./github.ts";

/** A required lane and its latest status, or null when the lane has no status (it did not run). */
export interface LaneStatus {
  context: string;
  status: CommitStatus | null;
}

export interface LaneSummary {
  state: string;
  description: string;
}

// A lane's name in the PR-wide check: its context without the shared prefix.
export const laneName = (context: string): string => String(context).replace(/^e2e(-test)?\//, "");

// Why a lane triage left red is still red, read from the status triage wrote on it.
export function redReason(description: string | null | undefined = ""): string {
  const d = String(description);
  const parts: string[] = [];
  const cleared = /\(([1-9]\d*) cleared by triage/.exec(d)?.[1];
  if (cleared) parts.push(`${cleared} cleared`);
  const unresolved = /(\d+) unresolved/.exec(d)?.[1];
  if (unresolved) parts.push(`${unresolved} to check`);
  const missing = /(\d+) report\(s\) missing/.exec(d)?.[1];
  if (missing) parts.push(`${missing} report(s) missing, re-run`);
  else if (/results incomplete/.test(d)) parts.push("results incomplete, re-run");
  if (/investigation required/.test(d)) parts.push("many failures in one run");
  if (/triage could not finish/.test(d)) parts.push("triage could not finish");
  return parts.length ? parts.join(", ") : "still red";
}

/**
 * One check for the whole PR from every lane's latest required status: pending
 * while a lane is still running, then red if any lane is red, otherwise green.
 * An unavailable or report-only triage must not hide a real failure as pending.
 * Lanes with no status did not run.
 */
export function laneSummary(lanes: LaneStatus[]): LaneSummary {
  const seen = lanes.filter((l): l is { context: string; status: CommitStatus } => Boolean(l.status));
  const waiting = seen.filter((l) => l.status.state === "pending");
  if (waiting.length) return { state: "pending", description: `Triage is checking: waiting for ${waiting.map((l) => laneName(l.context)).join(", ")}` };
  const red = seen.filter((l) => l.status.state !== "success");
  const cleared = seen.filter((l) => l.status.state === "success" && /\(([1-9]\d*) cleared by triage/.test(l.status.description ?? ""));
  const clearedText = cleared.length ? `${cleared.map((l) => laneName(l.context)).join(", ")} cleared by triage` : "";
  if (red.length) return { state: "failure", description: [...red.map((l) => `${laneName(l.context)}: ${redReason(l.status.description)}`), clearedText].filter(Boolean).join(" · ") };
  return { state: "success", description: clearedText ? `${clearedText} · all lanes green` : "All lanes green" };
}
