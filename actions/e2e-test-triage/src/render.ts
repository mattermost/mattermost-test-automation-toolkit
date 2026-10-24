// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { FAILED_STATUSES, isFailedTry } from "../../shared/src/tsio.ts";
import { COMPARE_FILE_CAP } from "./config.ts";
import { ledgerTotals, newLedger } from "./pricing.ts";
import type { Counts, Finding, Ledger } from "./types.ts";

const CODE_ESCAPES: Record<string, string> = { "|": "&#124;", "<": "&lt;", ">": "&gt;", "`": "&#96;" };

// Text inside a code span: only what would end the span or break the table.
const mdCode = (s: unknown): string => String(s).replace(/[|<>`]/g, (c) => CODE_ESCAPES[c]).replace(/\r?\n/g, " ");
// Prose in a table cell or heading, shown as typed. Escaped: what can start markup, so a title like "[x](url)" or
// "*y*" or "&amp;" renders as written. Left alone: "(" and ")" (they make a link only after an unescaped "]", which
// is escaped), and "_" inside a word (it cannot open emphasis there), so ordinary names come out as they always did.
const md = (s: unknown): string => mdCode(
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/[[\]*~]/g, (c) => `\\${c}`)
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replace(/^#/, "\\#"),
);
const shortModel = (m: string | null | undefined): string => String(m ?? "").replace(/^claude-/, "");
const usd = (n: number | null | undefined): string => (n == null ? "?" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const sha7 = (c: string | null | undefined): string => String(c ?? "").slice(0, 7);
const fileOf = (f: Finding): string | undefined => String(f.file ?? "").split("/").pop();

const LIKELY: Record<string, string> = { flaky_environment: "flaky or environment", bug_on_master: "already broken on the default branch", test_bug: "a test bug" };

/**
 * Which of five groups a failed test falls in. The names are fixed so people learn them:
 * "yours" (this PR or commit is the likely cause), "outdated" (the base branch changed the test after this PR
 * last merged it: merge and re-run), "check" (nothing explains it yet), "broken" (broken on the base branch), "flaky".
 */
export type Bucket = "yours" | "outdated" | "check" | "broken" | "flaky";

export function bucketOf(f: Finding): Bucket {
  const brokeOnBase = f.class === "BROKEN_ON_TRUNK" || f.same_as_class === "BROKEN_ON_TRUNK";
  if (f.blocking) {
    // A stale copy of the test is not the PR's change: it is merged, not explained.
    if (f.out_of_date && f.class !== "OWNED_BY_PR") return "outdated";
    const yours = f.class === "OWNED_BY_PR" || f.decision === "adjudicator_veto" || f.decision === "adjudicator_blame"
      || (f.class === "REGRESSION" && f.untouched === false);
    // A judge's veto or blame names this PR even where base-branch history also fails the test.
    if (yours) return "yours";
    return brokeOnBase ? "broken" : "check";
  }
  if (brokeOnBase) return "broken";
  const cause = f.decision === "adjudicator_unblock" ? f.judge?.cause : null;
  return cause === "bug_on_master" || cause === "test_bug" ? "broken" : "flaky";
}

/** Who to look at for a test broken on the base branch: the PR(s) merged between its last pass and first failure. */
function brokeByText(b: Finding["broke_by"]): string | null {
  if (!b?.commits?.length) return null;
  const name = (c: { pr: number | null; sha: string }): string => (c.pr ? `#${c.pr}` : sha7(c.sha));
  if (b.total === 1) return `${name(b.commits[0])}${b.commits[0].author ? ` (@${b.commits[0].author})` : ""}`;
  if (b.total <= 5) return `one of ${b.commits.map(name).join(", ")}`;
  return `one of ${b.total} commits merged between ${sha7(b.from)} and ${sha7(b.to)}`;
}

const PERCENT = (n: number): string => `${Math.round(n * 100)}%`;

/** The other platforms in this run where this test failed a try (a retry may have recovered it; a pass does not count). */
export const failedElsewhere = (f: Finding): string[] => (f.other_lanes ?? []).filter((o) => isFailedTry(o.result)).map((o) => o.platform);

/**
 * The sentence added to a why when the same test failed on other platforms in this run. Each platform is named by what
 * it did: failed, or once (a failed try that a retry recovered). The tail says what it may mean: a shared cause is the
 * likely one for a test that is not this PR's; a row that blames this PR gets the plain tail, which steers nowhere.
 */
const alsoFailed = (f: Finding, tail: string): string => {
  const other = f.other_lanes ?? [];
  const failed = other.filter((o) => FAILED_STATUSES.has(o.result)).map((o) => o.platform);
  const once = other.filter((o) => o.result === "flaky").map((o) => o.platform);
  if (failed.length && once.length) return ` Also failed on ${failed.join(", ")}, and once on ${once.join(", ")} (passed on retry), in this run${tail}`;
  if (once.length) return ` Also failed once on ${once.join(", ")} in this run (passed on retry)${tail}`;
  if (failed.length) return ` Also failed on ${failed.join(", ")} in this run${tail}`;
  return "";
};
const SHARED_CAUSE = ": likely environment or a shared cause.";
const PLAIN = ".";

/** One line of why, and the next step, for a failed test. */
function whyNext(f: Finding, branch: string, pr: boolean): [string, string] {
  const t = f.trunk ?? { runs: 0, passes: 0, fails: 0, flaky: 0 };
  const a = f.judge;
  const ai = a ? `AI, ${PERCENT(a.confidence)} sure` : "";
  switch (bucketOf(f)) {
    case "yours":
      if (f.class === "OWNED_BY_PR") return [`This ${pr ? "PR" : "commit"} edits the test.`, "Check your change to the test."];
      if (f.decision === "adjudicator_blame" || f.decision === "adjudicator_veto") return [`Points to this PR's change (${ai}).`, "Check the change named in the evidence."];
      return [`Passes on ${branch} (${t.passes} of ${t.runs} runs), and this PR changes a file its error names.`, "Check your change to that file."];
    case "outdated": {
      if (f.out_of_date?.streak) return [`Failed the same way on this PR's last ${f.out_of_date.streak} commits and never on ${branch}: the branch is behind or broken.`, `Merge ${branch} and re-run.`];
      const c = f.out_of_date?.commit;
      const where = c ? ` (${c.pr ? `#${c.pr}` : sha7(c.sha)}${c.date ? `, ${c.date}` : ""})` : "";
      return [`${branch} changed this test${where} after this PR last merged ${branch}, so the PR ran its old copy.`, `Merge ${branch} and re-run.`];
    }
    case "check":
      if (f.decision === "evidence_incomplete" || f.identity_unresolved) return ["Its history could not be checked.", "Read the error, or re-run if it isn't your change."];
      if (a?.cause === "caused_by_pr") return [`Might be this PR's change (${ai}), but not sure enough to say.`, "Read the error before re-running."];
      if (a) return [`Looks ${LIKELY[a.cause] ?? a.cause} (${ai}), but not sure enough to clear.`, "Read the error before re-running."];
      if (f.class === "INFRA_ERROR") return ["Failed on its environment (see the error), which this change could also have caused.", "Re-run; if it fails the same way again, check your change."];
      if (f.class === "INSUFFICIENT_DATA") return [`Too little history on ${branch} to tell (${count(t.runs, "run")}).`, "Read the error before re-running."];
      return [`Passes on ${branch} (${t.passes} of ${t.runs} runs), no other PR fails it this way, and this ${pr ? "PR" : "commit"} doesn't change it or a file its error names.`, "Read the error before re-running."];
    case "broken": {
      const by = brokeByText(f.broke_by);
      const why = f.decision === "adjudicator_unblock" ? `Already broken on ${branch} (${ai}).` : `Fails on ${branch}'s latest run too${by ? `; broke in ${by}` : ""}.`;
      return [why, pr ? (by ? `Nothing for you. Fix belongs to ${by}.` : "Nothing for you.") : by ? `Fix belongs to ${by}.` : `Fix on ${branch}.`];
    }
    default: {
      // A cleared test that failed every try here is never "nothing for you": it is re-run once before anyone digs.
      const allFailed = Boolean(f.tries && f.tries.ran >= 2 && f.tries.failed === f.tries.ran);
      const next = allFailed ? "Re-run once before digging." : pr ? "Nothing for you." : "Fix the flaky test.";
      if (allFailed && f.class === "FLAKY_ON_TRUNK") return [`Failed every try here; flaky on ${branch}.`, next];
      if (f.decision === "adjudicator_unblock") return [`Looks ${LIKELY[a?.cause ?? ""] ?? "flaky"} (${ai}).`, next];
      if (f.class === "SAME_FAILURE_AS_CLEARED") return [`Same error as "${f.same_as}", cleared above.`, next];
      if (f.class === "INFRA_ERROR") return ["Failed on its environment (see the error), not on this change.", allFailed ? next : pr ? "Nothing for you; re-run if the lane must be green." : "Re-run when the environment recovers."];
      if (f.class === "FLAKY_CROSS_PR") return [`Failed the same way on ${count(f.cross_pr.prs.length, "other PR")} while ${branch} passes.`, next];
      const how = [t.fails && `failed ${t.fails}`, t.flaky && `passed only on retry ${t.flaky}`].filter(Boolean).join(" and ");
      return [`Flaky on ${branch}: ${how} of the last ${t.runs} runs.`, next];
    }
  }
}

function decidedBy(f: Finding): string {
  const model = shortModel(f.judge?.provenance?.served_model ?? f.ai?.model);
  if (f.decision === "adjudicator_unblock" || f.decision === "adjudicator_veto" || f.decision === "adjudicator_blame") return `AI (${model})${f.escalated ? ", second opinion" : ""}`;
  if (f.judge || f.ai?.model) return `Rules; AI asked${f.escalated ? ", second opinion" : ""}`;
  return "Rules";
}

/** The facts behind one test's verdict, one question per row. */
function factsTable(f: Finding, branch: string, pr: boolean): string[] {
  const t = f.trunk;
  const rows: [string, string][] = [];
  const edits = f.class === "OWNED_BY_PR";
  rows.push([`Does this ${pr ? "PR" : "commit"} change the test?`, edits ? "Yes" : "No"]);
  if (!edits && f.untouched != null) rows.push(["Does this PR change a file its error names?", f.untouched ? "No" : "Yes"]);
  if (t) rows.push(t.runs ? [`${branch}, last ${count(t.runs, "run")}`, `Passed ${t.passes}, failed ${t.fails}${t.flaky ? `, passed on retry ${t.flaky}` : ""}${t.latest ? `. Latest: ${t.latest}` : ""}`] : [`${branch}`, "No runs on record"]);
  if (f.broke_by) {
    const b = f.broke_by;
    rows.push([`Merged on ${branch} between its last pass and first failure`, `${count(b.total, "commit")} (${sha7(b.from)}…${sha7(b.to)})${b.commits.length ? `: ${b.commits.map((c) => `${c.pr ? `#${c.pr}` : sha7(c.sha)}${c.author ? ` @${c.author}` : ""}`).join(", ")}` : ""}`]);
  }
  if (f.cross_pr) {
    const ex = f.cross_pr.examples.slice(0, 3).join(", ");
    rows.push(["Other PRs", f.cross_pr.prs.length ? `Failed with the same error on ${count(f.cross_pr.prs.length, "PR")}${ex ? `: ${ex}` : ""}`
      : f.cross_pr.passes ? `Never failed the same way in ${count(f.cross_pr.passes, "run")}` : "No runs on record"]);
  }
  if (pr && f.this_pr?.runs) {
    const lp = f.this_pr.last_pass;
    rows.push(["This PR's earlier runs", `Passed ${f.this_pr.passes} of ${f.this_pr.runs}${lp ? `. Last pass: ${sha7(lp.commit_sha)}, ${String(lp.created_at ?? "").slice(0, 16).replace("T", " ")}` : ""}`]);
    const since = f.since_last_pass;
    if (since) {
      const cut = since.complete === false;
      const listed = cut
        ? `${count(since.files.length, "file")} listed; GitHub lists at most ${COMPARE_FILE_CAP}, so more may have changed`
        : `${count(since.files.length, "file")}${since.files.length <= 3 ? `: ${since.files.join(", ")}` : `, for example ${since.files.slice(0, 3).join(", ")}`}`;
      rows.push(["Changed on this PR since that pass", since.files.length
        ? `${listed}. ${since.related.length ? `Named in the test's error: ${since.related.map((r) => r.file).join(", ")}` : cut ? "None named in the files listed, which does not clear it" : "None named in the test's error"}`
        : "Nothing (same commit)"]);
    }
  }
  if (f.other_lanes?.length) rows.push(["Same test, same run, other platforms", f.other_lanes.map((o) => `${o.platform}: ${o.result}`).join(", ")]);
  if (f.tries?.ran) rows.push(["Tries in this run", f.tries.ran === 1 ? "Failed its only try" : f.tries.failed === f.tries.ran ? `Failed all ${f.tries.ran}` : `Failed ${f.tries.failed} of ${f.tries.ran}`]);
  if (f.producer) rows.push(["Recorded by the run", [f.producer.images.length && count(f.producer.images.length, "screenshot"), f.producer.notes && `notes: ${f.producer.notes.slice(0, 200)}`].filter(Boolean).join("; ")]);
  if (f.same_as) rows.push(["Same failure as", f.same_as]);
  if (f.out_of_date?.streak) {
    rows.push([`Failed the same way on this PR's last ${count(f.out_of_date.streak, "commit")}`, `Never on ${branch}; its latest run passed`]);
  } else if (f.out_of_date) {
    const c = f.out_of_date.commit;
    rows.push([`Changed on ${branch} since this PR last merged it`, `Yes${c ? `: ${sha7(c.sha)}${c.pr ? ` (#${c.pr})` : ""}${c.date ? ` on ${c.date}` : ""}` : ""}. This PR is ${count(f.out_of_date.behind ?? 0, "commit")} behind, so it ran its old copy of the test`]);
  }
  if (f.decision === "evidence_incomplete" || f.identity_unresolved) rows.push(["Why history wasn't used", f.reason]);
  const a = f.judge;
  if (a) {
    const verdict = a.cause === "caused_by_pr" ? "Caused by this PR" : `Not caused by this PR (${LIKELY[a.cause] ?? a.cause})`;
    const blames = a.cause === "caused_by_pr";
    const sure = f.decision === "adjudicator_unblock" || f.decision === "adjudicator_veto" || f.decision === "adjudicator_blame" ? `${pct(a.confidence)} sure, enough to decide`
      : blames ? `${pct(a.confidence)} sure; naming the PR needs 85% and a change it can point to`
      : f.decision === "advice" ? `${pct(a.confidence)} sure, but with nothing it could point to, so it can't clear`
      : `${pct(a.confidence)} sure; clearing needs 85% and evidence`;
    const model = shortModel(a.provenance?.served_model ?? f.ai?.model);
    rows.push([model ? `AI (${model})` : "AI", `${verdict}, ${sure}. ${a.explanation}`]);
  }
  rows.push(["Decided by", decidedBy(f)]);
  return ["| Question | Answer |", "| --- | --- |", ...rows.map(([q, v]) => `| ${md(q)} | ${md(v)} |`)];
}

/** "99.7%" of the tests that ran (passed ÷ (passed + failed)), never "100%" while something failed. */
export function passRate(counts: Partial<Counts>): string {
  const passed = counts.passed ?? 0;
  const ran = passed + (counts.failed ?? 0);
  if (!passed) return "0%";
  if (!counts.failed) return "100%";
  return `${Math.min(99.9, Math.round((passed / ran) * 1000) / 10).toFixed(1)}%`;
}

export const passLine = (counts: Partial<Counts>): string => `${passRate(counts)} passed (${counts.passed ?? 0} passed, ${counts.failed} failed, ${counts.skipped ?? 0} skipped)`;

export interface SummaryMissing {
  text: string;
  short: string;
}

export interface SummaryInput {
  verdict?: string;
  findings: Finding[];
  infra?: string | null;
  runURL: string;
  counts: Partial<Counts>;
  mode?: string;
  ai?: Ledger;
  missing?: SummaryMissing | null;
  lane?: string | null;
  trunkBranch?: string | null;
  pr?: boolean;
  notes?: string[];
  /** The lane's own status is red although no test failed (a job outside the tests did). */
  laneRed?: boolean;
  /** "2 of 3 reports arrived", for a run with missing reports (see missingArrived). */
  reportsArrived?: string | null;
  /** Shard placeholders (see isShardPlaceholder): counted, not classified, and the lane is red for them. */
  unnamed?: number | null;
}

/** What a red lane with no failed test is to re-run: a job outside the tests, or reports that never arrived. */
const RED_OUTSIDE = "No test failed. The lane is red because a job outside the tests failed (setup, upload or runner), or results are missing: re-run the failed jobs.";

/**
 * The job summary, shortest first: a one-line answer, then the failed tests in five
 * groups (Your PR, Out of date, Needs a look, Broken on the base branch, Flaky; one line each: why and the next
 * step), then the evidence, collapsed.
 */
export function renderSummary({ findings, infra: runInfra = null, runURL, counts, mode = "report-only", ai = newLedger(), missing = null, lane = null, trunkBranch = null, pr = true, notes = [], laneRed = false, reportsArrived = null, unnamed = null }: SummaryInput): string {
  const branch = trunkBranch || "the default branch";
  const where = lane ? ` · ${md(lane)}` : "";
  // A flagged run whose every failure was cleared reads as any other cleared run.
  const infra = activeFlag(runInfra, findings);
  const groups: Record<Bucket, Finding[]> = { yours: [], outdated: [], check: [], broken: [], flaky: [] };
  for (const f of findings) groups[bucketOf(f)].push(f);
  const { yours, outdated, check, broken, flaky } = groups;
  // A blocking base-branch failure is still red, so it is not counted as unrelated.
  const blockingBroken = broken.filter((f) => f.blocking).length;
  const unrelatedBroken = broken.length - blockingBroken;
  const unrelated = unrelatedBroken + flaky.length;
  // Out-of-date failures are counted apart, never as the PR's. When they are at least half the failures, the fix
  // is the merge, so the headline and the say-line lead with it.
  const outdatedLead = findings.length > 0 && outdated.length * 2 >= findings.length;
  const staleText = outdated.length ? `${outdated.length} out of date` : "";
  const needText = check.length ? `${check.length} need${check.length === 1 ? "s" : ""} a look` : "";
  // The headline must agree with the verdict: blocking failures and missing reports are red, and "none caused"
  // is only said when nothing blocks.
  const head = infra ? "⚠️ needs investigation"
    : !counts.failed && !missing ? (laneRed ? "🔴 red outside the tests" : "✅ nothing failed")
    : outdatedLead ? `🔴 merge ${md(branch)} and re-run: ${staleText}${yours.length ? `, ${yours.length} may be caused by this ${pr ? "PR" : "commit"}` : ""}${needText ? `, ${needText}` : ""}`
    : yours.length ? `🔴 ${yours.length} may be caused by this ${pr ? "PR" : "commit"}${[staleText, needText].filter(Boolean).map((t) => `, ${t}`).join("")}`
    : missing ? "🔴 results missing"
    // Shard placeholders keep the lane red, so a look-only headline turns red and says to re-run.
    : check.length || outdated.length ? `${unnamed ? "🔴" : "🟡"} ${[needText, staleText, unnamed ? "re-run the failed jobs" : ""].filter(Boolean).join(", ")}`
    : blockingBroken ? `🔴 ${blockingBroken} still failing on ${md(branch)}`
    // Shard placeholders keep the lane red whatever the tests beside them came to.
    : unnamed ? "🔴 re-run the failed jobs"
    : `✅ none caused by this ${pr ? "PR" : "commit"}`;
  const lines = [`## E2E triage${where}: ${head}`, ""];
  // Under the headline: how many failed tests also failed on other platforms in this run (see alsoFailed).
  const several = findings.filter((f) => failedElsewhere(f).length > 0).length;
  if (several) lines.push(`${count(several, "test")} failed on several platforms in this run.`, "");
  lines.push(mode === "enforce"
    ? "> Triage sets the E2E check: it passes only when every failure is cleared."
    : "> **Report only.** This is triage's advice; it doesn't change the E2E check.", "");
  for (const n of notes) lines.push(`> ${md(n)}`, "");

  let say = "";
  // What arrived, and what never ran: the reason a lane with missing reports is red.
  const arrived = [reportsArrived, missing?.text].filter(Boolean).join("; ");
  const rerun = unnamed ? `Re-run the failed jobs: ${arrived || `${count(unnamed, "failed result")} with no test name`}.` : "";
  if (unnamed && !findings.length) {
    // Shard placeholders only: nothing is judged, so the line says which jobs to re-run, and what arrived.
    say = rerun;
  } else if (!counts.failed) {
    // Red with no failed test: the jobs to re-run. A missing report says how many arrived; a lane that is red for a job
    // outside the tests says that.
    say = missing ? `Re-run the failed jobs: ${arrived}.` : laneRed ? RED_OUTSIDE : "No test failed.";
  } else if (findings.length) {
    const kinds = [unrelatedBroken && `${unrelatedBroken} broken on ${branch}`, flaky.length && `${flaky.length} flaky`].filter(Boolean).join(", ");
    say = `${count(yours.length + outdated.length + check.length + blockingBroken + unrelated, "failure")}: ` + [
      yours.length && `${yours.length} may be caused by this ${pr ? "PR" : "commit"}`,
      outdated.length && `${outdated.length} out of date`,
      check.length && `${check.length} need${check.length === 1 ? "s" : ""} a look`,
      blockingBroken && `${blockingBroken} still failing on ${branch}`,
      unrelated && `${unrelated} look${unrelated === 1 ? "s" : ""} unrelated (${kinds})`,
    ].filter(Boolean).join("; ") + ".";
    if (outdatedLead) say = `Merge ${branch} and re-run first. ${say}`;
    // Shard placeholders beside the tests: the jobs to re-run, after what triage made of the tests.
    if (unnamed) say += ` ${rerun}`;
  }
  if (infra) say = `${infra} ${say}`;
  if (missing && counts.failed && !unnamed) say += ` Results incomplete: ${missing.text}; re-run the failed jobs before relying on this.`;
  lines.push(`**${md(say.trim())}** ${passLine(counts)} · [run](${runURL})`, "");

  const section = (title: string, list: Finding[], heading = `${title} (${list.length})`): void => {
    if (!list.length) return;
    lines.push(`### ${heading}`, "", "| Test | Why | Next step |", "| --- | --- | --- |");
    for (const f of list) {
      const [why, next] = whyNext(f, branch, pr);
      // A row that blames this PR (or a base-branch change to its test) is not steered toward the environment.
      const blamesPR = bucketOf(f) === "yours" || bucketOf(f) === "outdated";
      lines.push(`| ${md(f.title)} · \`${mdCode(fileOf(f))}\` | ${md(why + alsoFailed(f, blamesPR ? PLAIN : SHARED_CAUSE))} | ${md(next)} |`);
    }
    lines.push("");
  };
  section(pr ? "Your PR" : "This commit", yours);
  // A branch-state hold changed nothing on the base: its heading says what it is.
  const streakOnly = outdated.length > 0 && outdated.every((f) => f.out_of_date?.streak);
  section("Out of date", outdated, streakOnly
    ? `Out of date (${outdated.length}): this PR fails the same way on its last commits and never on ${md(branch)}`
    : `Out of date (${outdated.length}): ${md(branch)} changed these tests after this PR last merged ${md(branch)}`);
  section("Needs a look", check);
  section(`Broken on ${md(branch)}`, broken);
  section("Flaky", flaky);

  const shown = [...yours, ...outdated, ...check, ...broken, ...flaky].slice(0, 30);
  if (shown.length) {
    lines.push("<details>", "<summary>Evidence for each test</summary>", "");
    for (const f of shown) lines.push(`**${md(f.title)}** · \`${mdCode(fileOf(f))}\``, "", ...factsTable(f, branch, pr), "");
    if (findings.length > shown.length) lines.push(`${findings.length - shown.length} more tests are not shown.`, "");
    lines.push("</details>", "");
  }

  const spend = ledgerTotals(ai);
  const sk = ai.skipped;
  const skipped = [
    sk.no_effect && `${sk.no_effect} with nothing the model could change`,
    sk.duplicate && `${sk.duplicate} sharing another test's failure`,
    sk.cached && `${sk.cached} answered before`,
    sk.budget && `${sk.budget} over the ${ai.budgetLabel ?? "run budget"}`,
    sk.cap && `${sk.cap} over the per-run limit`,
  ].filter(Boolean);
  const used = spend.calls
    ? `${count(spend.calls, "call")} (${[...new Set(ai.calls.map((c) => shortModel(c.served_model)))].join(", ")}) · ${tokens(spend.input_tokens)} tokens in${spend.cached_tokens ? ` (${tokens(spend.cached_tokens)} cached)` : ""} · ${tokens(spend.output_tokens)} out · ${usd(spend.cost_usd)}`
    : "not used";
  lines.push(`AI: ${used}${skipped.length ? ` · skipped: ${skipped.join(", ")}` : ""}`);
  return lines.join("\n");
}

/** The job summary of a run triage could not finish: the reason, and that the E2E result stands. */
export function renderUnfinished({ reason, lane = null }: { reason: string; lane?: string | null }): string {
  const where = lane ? ` · ${md(lane)}` : "";
  return [`## E2E triage${where}: ⚠️ not triaged`, "", `**${md(`triage could not finish: ${reason}`)}** The E2E result stands.`, ""].join("\n");
}

/**
 * The job summary of a run triage did not judge on purpose (superseded, or no results at TSIO). `text` is the
 * already-escaped sentence (see supersededText and noResultsText).
 */
export function renderNotTriaged({ text, lane = null }: { text: string; lane?: string | null }): string {
  const where = lane ? ` · ${md(lane)}` : "";
  return [`## E2E triage${where}: ⚠️ not triaged`, "", `**${text}**`, ""].join("\n");
}

/** The run a newer dispatch replaced: its number is the link to that run's own triage. */
export function supersededText(newerRunId: string, repository: string, lane: string): string {
  return `Not triaged: run [${md(newerRunId)}](https://github.com/${repository}/actions/runs/${newerRunId}) replaced this one for ${md(lane)}; see that run's triage.`;
}

/** A run another PR's lane replaced: named without a link, since its triage is not this lane's. */
export function otherRunText(lane: string): string {
  return `Not triaged: another run of this commit replaced this one for ${md(lane)}.`;
}

/** The run TSIO has no results for: the tests may not have run. */
export function noResultsText(lane: string, commitSha: string): string {
  return `Not triaged: TSIO has no results for ${md(lane)} at ${sha7(commitSha)} (the tests may not have run).`;
}

/** The five labels the E2E check's text uses, in the order it lists them. */
export const STATUS_LABELS = ["flaky", "broken on main", "caused by PR", "out of date", "needs investigation"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

/**
 * The label of one finding. Blocking: out of date (a stale copy, or the branch-state hold), caused by this PR (the PR
 * edits the spec, or the judge blames or vetoes it), otherwise needs investigation. Cleared: broken on main (a trunk
 * break, or the judge's bug_on_master), otherwise flaky (trunk or cross-PR flakes, the environment, a test bug, or the
 * same failure as one of those).
 */
export function statusLabelOf(f: Finding): StatusLabel {
  if (f.blocking) {
    if (f.out_of_date) return "out of date";
    if (f.class === "OWNED_BY_PR" || (f.judge?.cause === "caused_by_pr" && (f.decision === "adjudicator_blame" || f.decision === "adjudicator_veto"))) return "caused by PR";
    return "needs investigation";
  }
  if (f.class === "SAME_FAILURE_AS_CLEARED") return f.same_as_class === "BROKEN_ON_TRUNK" ? "broken on main" : "flaky";
  if (f.decision === "adjudicator_unblock") return f.judge?.cause === "bug_on_master" ? "broken on main" : "flaky";
  return f.class === "BROKEN_ON_TRUNK" ? "broken on main" : "flaky";
}

/** What a shard placeholder asks for (see isShardPlaceholder): the lane is red until its jobs are re-run. */
export const RERUN = "re-run the failed jobs";

/**
 * The status labels for a run, each with its count, in the fixed order and only where non-zero ("2 flaky, 2 caused by PR").
 * A run with failures and no findings (every failure is a shard placeholder) is red for a re-run, and says so.
 */
export function statusLabels(findings: Finding[], failed = findings.length): string[] {
  if (!findings.length) return failed ? [RERUN] : [];
  const counts = new Map<StatusLabel, number>();
  for (const f of findings) {
    const label = statusLabelOf(f);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return STATUS_LABELS.filter((l) => counts.has(l)).map((l) => `${counts.get(l)} ${l}`);
}

const STATUS_MAX = 140;

/** Why a run-level verdict keeps the run red, in the check's words: the environment, or a storm of failures. */
export const runFlag = (infra: string): string => (/infrastructure errors/.test(infra) ? "mostly environment errors, re-run" : "many failures in one run");

/** The run-level flag while it still keeps the run red: some failure still blocks, or none is named. Null once every failure is cleared. */
export const activeFlag = (infra: string | null | undefined, findings: Finding[]): string | null =>
  infra && (!findings.length || findings.some((f) => f.blocking)) ? infra : null;

/**
 * The E2E check's text: "(2 flaky, 2 caused by PR) 99.7% passed (1186 passed, 4 failed, 164 skipped)". Zero labels are
 * left out. Shard placeholders beside findings add "re-run the failed jobs" after the labels ("(1 flaky; re-run the
 * failed jobs) ..."). The pass line is never shortened; past 140 characters the labels are, as the last resort.
 */
export function statusDescription(verdict: string, findings: Finding[], runInfra: string | null | undefined, counts: Partial<Counts>, missing: SummaryMissing | null = null, unnamed = 0): string {
  const pass = passLine(counts);
  // A run with many failures says what triage made of each one, and its flag only while one still blocks.
  const infra = activeFlag(runInfra, findings);
  const head = infra && !findings.length ? `not triaged, ${runFlag(infra)}` : statusLabels(findings, counts.failed ?? 0).join(", ");
  const rest = [infra && findings.length ? runFlag(infra) : "", unnamed && findings.length ? RERUN : "", missing?.short ?? ""].filter(Boolean).join("; ");
  const room = STATUS_MAX - pass.length - 3 - (rest ? rest.length + 2 : 0);
  const shown = head.length <= room ? head : room > 1 ? `${head.slice(0, room - 1).trimEnd()}…` : "";
  const inner = [shown, rest].filter(Boolean).join("; ");
  return inner ? `(${inner}) ${pass}` : pass;
}
