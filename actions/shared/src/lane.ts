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
  appBug: number;
  fixed: number;
  outdated: number;
  machine: number;
  brokenBranch: number;
  check: number;
}

// The labels are "flaky", "broken on main", "fixed on main", "test bug", "server compat", "caused by PR", "app bug",
// "broken on branch" and "machine failure". "cleared by triage", "unresolved", "needs investigation" and "out of date"
// are what a status written before them said.
function namedIn(description: string | null | undefined): Named {
  const d = String(description ?? "");
  const count = (re: RegExp): number => Number(re.exec(d)?.[1] ?? 0);
  return {
    cleared: count(/(\d+) cleared by triage/) + count(/(\d+) flaky/) + count(/(\d+) broken on main/) + count(/(\d+) test bug/) + count(/(\d+) server compat/),
    caused: count(/(\d+) caused by PR/),
    appBug: count(/(\d+) app bug/),
    fixed: count(/(\d+) fixed on main/),
    outdated: count(/(\d+) out of date/),
    machine: count(/(\d+) machine failures?\b/),
    brokenBranch: count(/(\d+) broken on branch/),
    check: count(/(\d+) unresolved/) + count(/(\d+) needs investigation/),
  };
}

/** A PR's "pull <base> changes" guidance in a status; only a PR run writes it. */
export const PULL_GUIDANCE = /\bpull [^\s,;)][^\n,;)]*? changes\b/;

/**
 * Whether statuses triage wrote come from a release run, read from their text alone; undefined when nothing says.
 * Pull guidance (written before) and "caused by PR" are written only on a PR run; "test bug", "server compat" and
 * "broken on branch" only on a release run, as "N out of date" was in a status written before. "fixed on main" and
 * "app bug" say nothing: both runs write them.
 */
export function releaseFromDescriptions(descriptions: readonly (string | null | undefined)[]): boolean | undefined {
  const ds = descriptions.map((d) => String(d ?? ""));
  if (ds.some((d) => PULL_GUIDANCE.test(d))) return false;
  if (ds.some((d) => /\b\d+ (?:test bug|server compat|broken on branch)\b/.test(d))) return true;
  if (ds.some((d) => /\b\d+ caused by PR\b/.test(d))) return false;
  // "N out of date" is written no more; in a status written before, it was a release run's label.
  if (ds.some((d) => /\b\d+ out of date\b/.test(d))) return true;
  return undefined;
}

/** Why a lane triage left red is still red, read from the status triage wrote on it. */
export function redReason(description: string | null | undefined = "", release = false): string {
  const d = String(description);
  // A lane triage judged as a whole (see diagnoseLane in e2e-test-triage): its label and what to do.
  const lane = /^\((machine failure, [^)]+|broken on main, not your change|broken on main|fixed on main, not your change|fixed on main, merge [^)]+|out of date, merge [^)]+|caused by PR|needs investigation)\)/.exec(d)?.[1];
  // A status written before today's lane labels keeps its meaning in today's words.
  if (lane) return lane.replace(/^out of date/, "fixed on main").replace(/^needs investigation$/, "machine failure, re-run");
  if (/triage is checking why/.test(d)) return "triage is checking why";
  const { cleared, caused, appBug, fixed, outdated, machine, brokenBranch, check } = namedIn(d);
  const parts: string[] = [];
  // A PR's failures the base branch changed or fixed are cleared with the rest; a release run's stay named: its fix is
  // a backport. Pull guidance and "out of date" are a PR status written before.
  const pull = PULL_GUIDANCE.exec(d)?.[0];
  const notYours = cleared + (release ? 0 : fixed);
  if (notYours) parts.push(`${notYours} not caused by PR`);
  if (caused) parts.push(`${caused} caused by PR`);
  if (appBug) parts.push(`${appBug} app bug`);
  // A release run's fixed on main stays named (its fix is a backport). Statuses written before today's labels said "out of
  // date" or gave pull guidance (no count) for the same thing, and "needs investigation" for a failure nothing explained,
  // held as a machine failure is. Their words are not repeated.
  const fixedHere = (release ? fixed : 0) + outdated;
  if (fixedHere) parts.push(`${fixedHere} fixed on main`);
  else if (pull) parts.push("fixed on main");
  if (brokenBranch) parts.push(`${brokenBranch} broken on branch`);
  if (machine + check) parts.push(`${machine + check} machine failure${machine + check === 1 ? "" : "s"}, re-run`);
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
export function laneSummary(lanes: LaneStatus[], untriaged: LaneStatus[] = [], release?: boolean): LaneSummary {
  const seen = lanes.filter((l): l is { context: string; status: CommitStatus } => Boolean(l.status));
  // A red check outside the aggregate's lanes (an upgrade lane) keeps "all lanes green" from being said; its own state
  // still gates the PR. One its own triage judged (its text starts with a label) is named with that verdict.
  const redOthers = untriaged.filter((l) => l.status && l.status.state !== "success" && l.status.state !== "pending");
  const judgedOther = (l: LaneStatus): boolean => /^\([^)]+\) /.test(String(l.status?.description ?? ""));
  const otherRed = redOthers.filter((l) => !judgedOther(l)).map((l) => laneName(l.context));
  const otherJudged = redOthers.filter(judgedOther).map((l) => `${laneName(l.context)}: ${redReason(l.status?.description, release ?? false)}`);
  const otherText = [
    ...otherJudged.slice(0, 2),
    otherJudged.length > 2 ? `+${otherJudged.length - 2} triaged red` : "",
    otherRed.length ? `not triaged: ${otherRed.slice(0, 2).join(", ")}${otherRed.length > 2 ? ` +${otherRed.length - 2}` : ""} red` : "",
  ].filter(Boolean).join(" · ");
  // The status is cut at 140 characters, so the warning comes last but always fits: by name, else by count, and the
  // text before it gives way.
  const withOther = (text: string): string => {
    if (!otherText) return text;
    if (`${text} · ${otherText}`.length <= 140) return `${text} · ${otherText}`;
    const count = otherJudged.length ? `${otherJudged.length + otherRed.length} other E2E check(s) red` : `not triaged: ${otherRed.length} red`;
    const room = 140 - count.length - 3;
    return `${text.length > room ? `${text.slice(0, room - 1)}…` : text} · ${count}`;
  };
  const waiting = seen.filter((l) => l.status.state === "pending");
  if (waiting.length) return { state: "pending", description: withOther(`Triage is checking: waiting for ${waiting.map((l) => laneName(l.context)).join(", ")}`) };
  const red = seen.filter((l) => l.status.state !== "success");
  // Unset release is read from the lanes' text (see releaseFromDescriptions); nothing saying so is a PR's wording.
  const isRelease = release ?? releaseFromDescriptions(seen.map((l) => l.status.description)) ?? false;
  // A PR's fixed on main is cleared too; a release run's never is.
  const cleared = seen.filter((l) => {
    const n = namedIn(l.status.description);
    return l.status.state === "success" && n.cleared + (isRelease ? 0 : n.fixed) > 0;
  });
  const clearedText = cleared.length ? `${cleared.map((l) => laneName(l.context)).join(", ")} cleared by triage` : "";
  if (red.length) return { state: "failure", description: withOther([...red.map((l) => `${laneName(l.context)}: ${redReason(l.status.description, isRelease)}`), clearedText].filter(Boolean).join(" · ")) };
  if (otherText) return { state: "success", description: withOther([clearedText, "triaged lanes green"].filter(Boolean).join(" · ")) };
  return { state: "success", description: clearedText ? `${clearedText} · all lanes green` : "All lanes green" };
}
