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

/** How many of a lane's failures a status description names, by kind. Reads the labels and the older wording alike. */
interface Named {
  cleared: number;
  caused: number;
  outdated: number;
  check: number;
}

// The labels are "flaky", "broken on main", "caused by PR", "out of date" and "needs investigation"; "cleared by triage"
// and "unresolved" are what a status written before them said.
function namedIn(description: string | null | undefined): Named {
  const d = String(description ?? "");
  const count = (re: RegExp): number => Number(re.exec(d)?.[1] ?? 0);
  return {
    cleared: count(/(\d+) cleared by triage/) + count(/(\d+) flaky/) + count(/(\d+) broken on main/),
    caused: count(/(\d+) caused by PR/),
    outdated: count(/(\d+) out of date/),
    check: count(/(\d+) unresolved/) + count(/(\d+) needs investigation/),
  };
}

// Why a lane triage left red is still red, read from the status triage wrote on it.
export function redReason(description: string | null | undefined = ""): string {
  const d = String(description);
  const { cleared, caused, outdated, check } = namedIn(d);
  const parts: string[] = [];
  if (cleared) parts.push(`${cleared} not caused by PR`);
  if (caused) parts.push(`${caused} caused by PR`);
  if (outdated) parts.push(`${outdated} out of date`);
  if (check) parts.push(`${check} to check`);
  // Triage asked for the re-run itself, held it for a fix, or a person has to.
  const held = /not re-run: ([^;)]+)/.exec(d)?.[1];
  const again = /re-running the failed jobs/.test(d) ? "re-running" : "re-run";
  const missing = /(\d+) report\(s\) missing/.exec(d)?.[1];
  const notRun = Number(/(\d+) not run\b/.exec(d)?.[1] ?? 0);
  if (held) parts.push(`not re-run: ${held}`);
  else if (missing) parts.push(`${missing} report(s) missing, ${again}`);
  else if (/results incomplete/.test(d)) parts.push(`results incomplete, ${again}`);
  // "N not run" counts every spec that did not run, re-run or not: it names the re-run alone, when nothing else is named.
  else if (notRun && /re-run(?:ning)? the failed jobs/.test(d) && !parts.length) parts.push(`${notRun} spec${notRun === 1 ? "" : "s"} did not run, ${again}`);
  else if (/re-running the failed jobs/.test(d)) parts.push("re-running the failed jobs");
  else if (/re-run the failed jobs/.test(d)) parts.push("re-run the failed jobs");
  // The run-level flag; "investigation required" is how statuses written before it said either reason.
  if (/environment errors, re-run/.test(d)) parts.push("environment errors, re-run");
  else if (/investigation required|many failures in one run/.test(d)) parts.push("many failures in one run");
  if (/triage could not finish/.test(d)) parts.push("triage could not finish");
  return parts.length ? parts.join(", ") : "still red";
}

/**
 * One check for the whole PR from every lane's latest required status: pending
 * while a lane is still running, then red if any lane is red, otherwise green.
 * An unavailable or report-only triage must not hide a real failure as pending.
 * Lanes with no status did not run.
 */
export function laneSummary(lanes: LaneStatus[], untriaged: LaneStatus[] = []): LaneSummary {
  const seen = lanes.filter((l): l is { context: string; status: CommitStatus } => Boolean(l.status));
  const waiting = seen.filter((l) => l.status.state === "pending");
  if (waiting.length) return { state: "pending", description: `Triage is checking: waiting for ${waiting.map((l) => laneName(l.context)).join(", ")}` };
  const red = seen.filter((l) => l.status.state !== "success");
  const cleared = seen.filter((l) => l.status.state === "success" && namedIn(l.status.description).cleared > 0);
  const clearedText = cleared.length ? `${cleared.map((l) => laneName(l.context)).join(", ")} cleared by triage` : "";
  // A red check triage does not cover keeps "all lanes green" from being said; its own state still gates the PR.
  const otherRed = untriaged.filter((l) => l.status && l.status.state !== "success" && l.status.state !== "pending");
  const otherText = otherRed.length ? `not triaged: ${otherRed.map((l) => laneName(l.context)).join(", ")} red` : "";
  if (red.length) return { state: "failure", description: [...red.map((l) => `${laneName(l.context)}: ${redReason(l.status.description)}`), clearedText, otherText].filter(Boolean).join(" · ") };
  if (otherText) return { state: "success", description: [clearedText, "triaged lanes green", otherText].filter(Boolean).join(" · ") };
  return { state: "success", description: clearedText ? `${clearedText} · all lanes green` : "All lanes green" };
}
