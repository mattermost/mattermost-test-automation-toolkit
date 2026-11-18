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
  brokenMain: number;
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
  // One count for both fields: redReason takes brokenMain out of cleared on a run with no PR.
  const brokenMain = count(/(\d+) broken on main/);
  return {
    cleared: count(/(\d+) cleared by triage/) + count(/(\d+) flaky/) + brokenMain + count(/(\d+) test bug/) + count(/(\d+) server compat/),
    brokenMain,
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

/**
 * How a red reason names what triage cleared: in full ("N not caused by PR"), in one word ("N cleared"), or not at all
 * beside anything else named. "action" goes further: only what a person has to do (a re-run, and the run-level flags),
 * when the lane names any; the lane's own check still names the rest. The shorter forms are for a summary that would
 * not fit GitHub's 140 characters otherwise.
 */
export type ClearedWording = "full" | "short" | "none" | "action";
const CLEARED_WORDINGS: readonly ClearedWording[] = ["full", "short", "none"];

/** GitHub cuts a commit status description at this length. */
const STATUS_LIMIT = 140;

/** Why a lane triage left red is still red, read from the status triage wrote on it. A run with no PR (a trunk or release
 * run) has no PR to clear: what triage cleared is not caused by the commit under test, and what is broken on main is
 * named as such, since on such a run it stays red (a standing breakage, see EXONERATED_ON_TRUNK in e2e-test-triage). */
export function redReason(description: string | null | undefined = "", release = false, pr = true, wording: ClearedWording = "full"): string {
  const d = String(description);
  // A lane triage judged as a whole (see diagnoseLane in e2e-test-triage): its label and what to do.
  const lane = /^\((machine failure, [^)]+|broken on main, not your change|broken on main|fixed on main, not your change|fixed on main, merge [^)]+|out of date, merge [^)]+|caused by PR|needs investigation)\)/.exec(d)?.[1];
  // A status written before today's lane labels keeps its meaning in today's words.
  if (lane) return lane.replace(/^out of date/, "fixed on main").replace(/^needs investigation$/, "machine failure, re-run");
  if (/triage is checking why/.test(d)) return "triage is checking why";
  const { cleared, brokenMain: brokenOnMain, caused, appBug, fixed, outdated, machine, brokenBranch, check } = namedIn(d);
  const parts: string[] = [];
  // A PR's failures the base branch changed or fixed are cleared with the rest; a release run's stay named: its fix is
  // a backport. Pull guidance and "out of date" are a PR status written before.
  const pull = PULL_GUIDANCE.exec(d)?.[0];
  const brokenMain = pr ? 0 : brokenOnMain;
  const notYours = cleared - brokenMain + (release ? 0 : fixed);
  if (brokenMain) parts.push(`${brokenMain} broken on main`);
  const clearedAt = parts.length;
  if (notYours) parts.push(wording === "full" ? `${notYours} not caused by ${pr ? "PR" : "this commit"}` : `${notYours} cleared`);
  if (caused) parts.push(`${caused} caused by PR`);
  if (appBug) parts.push(`${appBug} app bug`);
  // A release run's fixed on main stays named (its fix is a backport). Statuses written before today's labels said "out of
  // date" or gave pull guidance (no count) for the same thing, and "needs investigation" for a failure nothing explained,
  // held as a machine failure is. Their words are not repeated.
  const fixedHere = (release ? fixed : 0) + outdated;
  if (fixedHere) parts.push(`${fixedHere} fixed on main`);
  else if (pull) parts.push("fixed on main");
  if (brokenBranch) parts.push(`${brokenBranch} broken on branch`);
  // From here on, what a person has to do and the run-level flags.
  const actionAt = parts.length;
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
  // Left out only beside something else, so a lane red for nothing but cleared failures still says so.
  if (wording === "action" && parts.length > actionAt) parts.splice(0, actionAt);
  else if ((wording === "none" || wording === "action") && notYours && parts.length > 1) parts.splice(clearedAt, 1);
  return parts.length ? parts.join(", ") : "still red";
}

/**
 * One check for the whole PR from every lane's latest required status: pending
 * while a lane is still running, then red if any lane is red, otherwise green.
 * An unavailable or report-only triage must not hide a real failure as pending.
 * Lanes with no status did not run.
 */
export function laneSummary(lanes: LaneStatus[], untriaged: LaneStatus[] = [], release?: boolean, pr = true): LaneSummary {
  const seen = lanes.filter((l): l is { context: string; status: CommitStatus } => Boolean(l.status));
  // Unset release is read from the lanes' text (see releaseFromDescriptions); nothing saying so is a PR's wording.
  const isRelease = release ?? releaseFromDescriptions(seen.map((l) => l.status.description)) ?? false;
  // A verdict that asks a person to re-run; "re-running" is triage's own re-run, "not re-run: ..." a held one. A count
  // that stands for checks keeps the instruction any of them carries.
  const rerunNote = (reasons: readonly string[]): string => (reasons.some((r) => /(?<!not )\bre-run\b/.test(r)) ? ", re-run" : "");
  // A red check outside the aggregate's lanes (an upgrade lane) keeps "all lanes green" from being said; its own state
  // still gates the PR. One its own triage judged (its text starts with a label) is named with that verdict.
  const redOthers = untriaged.filter((l) => l.status && l.status.state !== "success" && l.status.state !== "pending");
  const judgedOther = (l: LaneStatus): boolean => /^\([^)]+\) /.test(String(l.status?.description ?? ""));
  const otherRed = redOthers.filter((l) => !judgedOther(l)).map((l) => laneName(l.context));
  const judged = redOthers.filter(judgedOther);
  const otherReason = (l: LaneStatus, wording: ClearedWording): string => redReason(l.status?.description, isRelease, pr, wording);
  const otherNamed = (wording: ClearedWording, names: number): string => [
    ...judged.slice(0, names).map((l) => `${laneName(l.context)}: ${otherReason(l, wording)}`),
    judged.length > names ? `+${judged.length - names} triaged red${rerunNote(judged.slice(names).map((l) => otherReason(l, "none")))}` : "",
    otherRed.length ? `not triaged: ${otherRed.slice(0, names).join(", ")}${otherRed.length > names ? ` +${otherRed.length - names}` : ""} red` : "",
  ].filter(Boolean).join(" · ");
  const otherCount = judged.length
    ? `${judged.length + otherRed.length} other E2E check(s) red${rerunNote(judged.map((l) => otherReason(l, "none")))}`
    : `not triaged: ${otherRed.length} red`;
  const join = (...parts: string[]): string => parts.filter(Boolean).join(" · ");
  // GitHub cuts the status at 140 characters, so the most detailed text that fits is written. `texts` is the text before
  // the warning about other checks, most detailed first; `fewer` is what it gives way to when none fits. Another check's
  // name goes last: its cleared wording is shortened, then left out, then the text's own detail gives way, then two
  // other checks are named, then one, then they are only counted (keeping a re-run any of them asks for). Then the text
  // gives way to `fewer`, and only when that does not fit either is it cut; the warning still fits whole.
  const fit = (texts: readonly string[], fewer: readonly string[] = []): string => {
    const fits = (text: string): boolean => text.length <= STATUS_LIMIT;
    const own = [...new Set(texts)];
    if (redOthers.length) {
      for (const names of [2, 1]) {
        for (const text of own) {
          for (const wording of CLEARED_WORDINGS) {
            const candidate = join(text, otherNamed(wording, names));
            if (fits(candidate)) return candidate;
          }
        }
      }
    }
    const other = redOthers.length ? otherCount : "";
    const all = [...own, ...fewer];
    for (const text of all) {
      const candidate = join(text, other);
      if (fits(candidate)) return candidate;
    }
    const room = STATUS_LIMIT - (other ? other.length + 3 : 0);
    return join(`${(all[all.length - 1] ?? "").slice(0, room - 1)}…`, other);
  };
  const waiting = seen.filter((l) => l.status.state === "pending").map((l) => laneName(l.context));
  if (waiting.length) {
    // The last lanes it waits for are counted when their names do not fit.
    const waitingFor = (shown: number): string => shown
      ? `Triage is checking: waiting for ${waiting.slice(0, shown).join(", ")}${shown < waiting.length ? ` +${waiting.length - shown} more` : ""}`
      : `Triage is checking: waiting for ${waiting.length} lane(s)`;
    return { state: "pending", description: fit([waitingFor(waiting.length)], waiting.map((_, i) => waitingFor(waiting.length - 1 - i))) };
  }
  const red = seen.filter((l) => l.status.state !== "success");
  // A PR's fixed on main is cleared too; a release run's never is.
  const cleared = seen.filter((l) => {
    const n = namedIn(l.status.description);
    return l.status.state === "success" && n.cleared + (isRelease ? 0 : n.fixed) > 0;
  });
  // The lanes triage cleared are named, then counted, before they are left out.
  const clearedText = cleared.length ? `${cleared.map((l) => laneName(l.context)).join(", ")} cleared by triage` : "";
  const clearedCount = cleared.length ? `${cleared.length} lane(s) cleared by triage` : "";
  if (red.length) {
    const reasons = (wording: ClearedWording) => red.map((l) => ({ name: laneName(l.context), reason: redReason(l.status.description, isRelease, pr, wording) }));
    // The first `shown` red lanes by name, the rest counted with any re-run they ask for.
    const named = (wording: ClearedWording, shown: number): string => {
      const rs = reasons(wording);
      const rest = rs.slice(shown).map((r) => r.reason);
      const counted = rest.length ? `${shown ? "+" : ""}${rest.length}${shown ? " more" : ""} lane(s) red${rerunNote(rest)}` : "";
      return join(...rs.slice(0, shown).map((r) => `${r.name}: ${r.reason}`), counted);
    };
    // What triage cleared on the red lanes, then the lanes it cleared whole, give way before a red lane does.
    const texts = [
      ...CLEARED_WORDINGS.map((wording) => join(named(wording, red.length), clearedText)),
      join(named("none", red.length), clearedCount),
      named("none", red.length),
    ];
    // Then the last red lanes are counted; then each lane says only what a person has to do; last, every lane is counted.
    const fewer: string[] = [];
    for (const wording of ["none", "action"] as const) {
      for (let shown = red.length; shown > 0; shown--) fewer.push(named(wording, shown));
    }
    fewer.push(named("action", 0));
    return { state: "failure", description: fit(texts, fewer) };
  }
  if (redOthers.length) {
    return { state: "success", description: fit([join(clearedText, "triaged lanes green"), join(clearedCount, "triaged lanes green"), "triaged lanes green"]) };
  }
  if (clearedText) return { state: "success", description: fit([`${clearedText} · all lanes green`, `${clearedCount} · all lanes green`]) };
  return { state: "success", description: "All lanes green" };
}
