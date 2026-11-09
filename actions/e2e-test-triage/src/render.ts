// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { FAILED_STATUSES, isFailedTry } from "../../shared/src/tsio.ts";
import { causedByPR, describeChange, errorFirstLine } from "./classify.ts";
import { COMPARE_FILE_CAP } from "./config.ts";
import { ledgerTotals, newLedger } from "./pricing.ts";
import type { Counts, Finding, Ledger } from "./types.ts";
import type { LaneVerdict } from "./lane-diagnosis.ts";

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

const LIKELY: Record<string, string> = { flaky_environment: "flaky or environment", bug_on_master: "already broken on the default branch", test_bug: "a test bug", server_compat: "a server-version incompatibility", app_bug: "an app bug" };
// What a release run's owner does with a failure the model cleared, by its cause.
const RELEASE_NEXT: Record<string, string> = {
  test_bug: "Backport the test fix, or ignore it for this release.",
  server_compat: "Check that this release supports that server version, or skip the test there.",
  flaky_environment: "Re-run to confirm.",
};

/**
 * Which of five groups a failed test falls in. The names are fixed so people learn them:
 * "yours" (this PR or commit caused it: see causedByPR), "outdated" (the base branch changed or fixed the test after
 * this PR last merged it: fixed on main), "check" (a machine failure: re-run), "broken" (broken on the base branch, or on
 * a trunk or release run its own new break), "flaky".
 */
export type Bucket = "yours" | "outdated" | "check" | "broken" | "flaky";

/** A failure still red that no change explains: the environment, a spec that never ran, or a change list unread. */
const machineFailure = (f: Finding): boolean => f.blocking && !causedByPR(f) && !f.out_of_date &&
  (f.class === "INFRA_ERROR" || f.class === "NOT_RUN" || f.decision === "evidence_incomplete" ||
    (!f.trunk_run && !f.release && f.class !== "BROKEN_ON_TRUNK" && f.same_as_class !== "BROKEN_ON_TRUNK"));

export function bucketOf(f: Finding): Bucket {
  const brokeOnBase = f.class === "BROKEN_ON_TRUNK" || f.same_as_class === "BROKEN_ON_TRUNK";
  // A release run's app bug is named before anything else, as its label is (see statusLabelOf).
  if (f.blocking && f.judge?.cause === "app_bug" && f.decision === "adjudicator_blame") return "yours";
  // A copy of the test the base branch has since changed or fixed is not the PR's change (see settlePR). A release run's
  // the model cleared is named by what it found, below.
  if (f.out_of_date && f.class !== "OWNED_BY_PR" && (f.blocking || !f.release)) return "outdated";
  if (f.blocking) {
    if (provenStreak(f) || causedByPR(f)) return "yours";
    return machineFailure(f) ? "check" : "broken";
  }
  // Cleared as a first failure nothing ties to the PR (see settlePR): its class may rest on history that was not used.
  if (f.decision === "first_failure") return "flaky";
  if (brokeOnBase || f.decision === "base_broken") return "broken";
  // A release run's cleared failure is not an app bug, whatever the model named it.
  if (f.release) return "flaky";
  const cause = f.decision === "adjudicator_unblock" ? f.judge?.cause : null;
  return cause === "bug_on_master" || cause === "test_bug" ? "broken" : "flaky";
}

/**
 * A PR streak the base branch does not explain (it did not change the test; see markOutOfDate) and whose check ran: the
 * PR's change is the cause. One the check could not run for is still the PR's (see causedByPR).
 */
const provenStreak = (f: Finding): boolean => Boolean(f.pr_streak) && f.blocking && !f.out_of_date && f.decision !== "evidence_incomplete";

/** The judge's confidence from which its explanation and fix for a PR streak are shown (its "meets the requirement" bar). */
const JUDGE_SURE = 0.6;

/** The cause, and the fix, for a PR streak (see provenStreak): the judge's when it gave one, else the rules'. */
function streakWhyNext(f: Finding, branch: string): [string, string] {
  const runs = f.trunk?.runs ?? 0;
  const cause = `Failed the same way on this PR's last ${f.pr_streak} commits, passed in all ${runs} recent runs on ${branch}, and ${branch} has not changed this test since this PR last merged it: this PR's change causes it.`;
  const spec = f.file.split("/").pop() ?? f.file;
  // The judge's answer counts where it met its own bar for naming a cause (0.6, see SYSTEM); below it, it found no
  // change that explains the failure, and the summary says so instead of passing on a guess.
  const a = f.judge?.cause === "caused_by_pr" && f.judge.confidence >= JUDGE_SURE ? f.judge : null;
  const unsure = Boolean(f.judge) && !a ? " The AI found no change in this PR's diff that explains it." : "";
  if (a?.fix) return [`${cause} ${a.explanation}`, `Suggested fix (AI): ${a.fix}`];
  const c = f.changed_by_pr;
  if (c?.removed) return [`${cause} ${c.file} removes ${describeChange(c)}, which the test expects.`, `Keep ${describeChange(c)} in ${c.file}; if removing it is intended, update ${spec} to the new behavior.`];
  if (c) return [`${cause} ${c.file} changes the line with ${describeChange(c)} that the test looks for: "${c.line}".`, `Make that line give the test what it expects again, or update ${spec} to match the change.`];
  if (a) return [`${cause} ${a.explanation}`, "Check the change named in the evidence."];
  const at = errorFirstLine(f.error);
  return [`${cause}${at ? ` It fails at: "${at.slice(0, 160)}".` : ""}${unsure}`, f.suspects?.length ? `Look first at this PR's changes to ${f.suspects.join(", ")}.` : "Check what this PR changes that the test uses."];
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

// Up to four names; past that, three and how many more (a release run's matrix can name fifteen lanes).
const fewOf = (names: string[]): string => (names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));
/**
 * The sentence added to a why when the same test failed on other platforms in this run. Each platform is named by what
 * it did: failed, or once (a failed try that a retry recovered). The tail says what it may mean: a shared cause is the
 * likely one for a test that is not this PR's; a row that blames this PR gets the plain tail, which steers nowhere.
 */
const alsoFailed = (f: Finding, tail: string): string => {
  const other = f.other_lanes ?? [];
  const failed = fewOf(other.filter((o) => FAILED_STATUSES.has(o.result)).map((o) => o.platform));
  const once = fewOf(other.filter((o) => o.result === "flaky").map((o) => o.platform));
  if (failed && once) return ` Also failed on ${failed}, and once on ${once} (passed on retry), in this run${tail}`;
  if (once) return ` Also failed once on ${once} in this run (passed on retry)${tail}`;
  if (failed) return ` Also failed on ${failed} in this run${tail}`;
  return "";
};
const SHARED_CAUSE = ": likely environment or a shared cause.";
const PLAIN = ".";

// A base-branch commit by its PR number, or its short SHA.
const refOf = (c: { sha: string; pr: number | null }): string => (c.pr ? `#${c.pr}` : sha7(c.sha));

/** One line of why, and the next step, for a failed test. */
function whyNext(f: Finding, branch: string, pr: boolean, branchRun: string | null = null): [string, string] {
  const t = f.trunk ?? { runs: 0, passes: 0, fails: 0, flaky: 0 };
  const a = f.judge;
  const ai = a ? `AI, ${PERCENT(a.confidence)} sure` : "";
  if (provenStreak(f)) return streakWhyNext(f, branch);
  switch (bucketOf(f)) {
    case "yours": {
      if (f.class === "OWNED_BY_PR") return [`This ${pr ? "PR" : "commit"} edits the test.`, "Check your change to the test."];
      if (a?.cause === "app_bug" && f.decision === "adjudicator_blame") return [`Looks like an app bug in this build (${ai}): ${a.explanation}`, "Read the error, and file it against this release if it holds."];
      const fix = a?.cause === "caused_by_pr" && a.fix ? `Suggested fix (AI): ${a.fix}` : null;
      if (f.decision === "adjudicator_blame" || f.decision === "adjudicator_veto") return [`Points to this PR's change (${ai}): ${a?.explanation ?? "see the evidence"}`, fix ?? "Check the change named in the evidence."];
      if (f.mass) return [`Failed with most of this run while ${branch} passes${t.runs ? ` (${t.passes} of ${t.runs} runs)` : ""}: this change broke something these tests share.`, "Start from the error most of the failures share."];
      const c = f.changed_by_pr;
      const spec = f.file.split("/").pop() ?? f.file;
      if (c?.removed) return [`Passes on ${branch} (${t.passes} of ${t.runs} runs), and ${c.file} removes ${describeChange(c)}, which the test expects.`, fix ?? `Keep ${describeChange(c)} in ${c.file}; if removing it is intended, update ${spec} to the new behavior.`];
      if (c) return [`Passes on ${branch} (${t.passes} of ${t.runs} runs), and ${c.file} changes the line with ${describeChange(c)} that the test looks for: "${c.line}".`, fix ?? `Make that line give the test what it expects again, or update ${spec} to match the change.`];
      if (f.decision === "reproducible_regression") {
        const at = errorFirstLine(f.error);
        return [`Failed all ${f.tries?.ran ?? 2} tries of this build, passes on ${branch} (${t.passes} of ${t.runs} runs), and no other PR fails it this way: this PR's change causes it.${at ? ` It fails at: "${at.slice(0, 160)}".` : ""}`,
          fix ?? (f.suspects?.length ? `Look first at this PR's changes to ${f.suspects.join(", ")}.` : "Check what this PR changes that the test uses.")];
      }
      return [`Passes on ${branch} (${t.passes} of ${t.runs} runs), and this PR changes a file its error names.`, fix ?? "Check your change to that file."];
    }
    case "outdated": {
      const c = f.out_of_date?.commit;
      const also = f.out_of_date?.also ?? [];
      const where = c ? ` (${refOf(c)}${c.date ? `, ${c.date}` : ""}${also.length ? `; also ${also.map(refOf).join(", ")}` : ""})` : "";
      const base = f.out_of_date?.base ?? branch;
      // The test is unchanged; the code it runs through (a support-paths directory) is not.
      const support = f.out_of_date?.support;
      const what = support ? `the test code it runs through (${support}${c ? `; ${refOf(c)}${c.date ? `, ${c.date}` : ""}` : ""})` : `this test${where}`;
      if (branchRun) {
        if (f.out_of_date?.fixed) return [`${base} fixed this failure${where} after ${branchRun} branched from it.`, `Backport the fix to ${branchRun}, or ignore it for this release.`];
        return [`${base} changed ${what} after ${branchRun} branched from it, so this run used ${branchRun}'s old copy.`, `Backport the test change to ${branchRun}, or ignore it for this release.`];
      }
      // A PR's: cleared (see settlePR). The base branch's copy passes there, and merging the PR gives it that copy.
      const next = `Nothing for you: ${branch} passes it, and this PR gets the fix when it is merged or updated with ${branch}.`;
      if (f.out_of_date?.fixed) return [`${branch} fixed this failure${where} after this PR last merged ${branch}; this branch still has the broken copy.`, next];
      return [`${branch} changed ${what} after this PR last merged ${branch}, and ${branch}'s copy passes; this PR ran the old one.`, next];
    }
    case "check":
      if (f.class === "NOT_RUN") return [f.reason, "Re-run the failed jobs: the spec never ran."];
      if (f.class === "INFRA_ERROR") return [`Failed on its environment (see the error) in a run where most tests failed on theirs.`, "Re-run the failed jobs once the environment recovers."];
      if (f.decision === "evidence_incomplete") return [f.reason, "Re-run the failed jobs to triage it again."];
      return ["This PR's list of changed files could not be read, so whether the change touches this test is unknown.", "Re-run the failed jobs to triage it again."];
    case "broken": {
      const by = brokeByText(f.broke_by);
      const where = branchRun ?? branch;
      // A trunk or release run's own new failure: the commit under test is the first to fail it.
      if (f.class !== "BROKEN_ON_TRUNK" && f.same_as_class !== "BROKEN_ON_TRUNK" && f.decision !== "adjudicator_unblock")
        return [`New on ${where}: ${t.runs ? `passed ${t.passes} of the previous ${t.runs} runs, and ` : ""}this commit is the first to fail it.`, `Re-run once: failing the same way again makes it broken on ${where}, fixed from this commit's change; passing makes it a flake.`];
      const why = f.decision === "adjudicator_unblock" ? `Already broken on ${branch} (${ai}).` : `Fails on ${branch}'s latest run too${by ? `; broke in ${by}` : ""}.`;
      return [why, pr ? (by ? `Nothing for you. Fix belongs to ${by}.` : "Nothing for you.") : by ? `Fix belongs to ${by}.` : `Fix on ${branch}.`];
    }
    default: {
      // A cleared test that failed every try here is never "nothing for you": it is re-run once before anyone digs.
      const allFailed = Boolean(f.tries && f.tries.ran >= 2 && f.tries.failed === f.tries.ran);
      const next = allFailed ? "Re-run once before digging." : pr ? "Nothing for you." : "Fix the flaky test.";
      if (allFailed && f.class === "FLAKY_ON_TRUNK") return [`Failed every try here; flaky on ${branch}.`, next];
      if (f.decision === "rules_unblock") return [f.reason, next];
      if (f.release && f.decision === "adjudicator_unblock" && a) return [`Looks like ${LIKELY[a.cause] ?? a.cause} (${ai}): ${a.explanation}`, RELEASE_NEXT[a.cause] ?? "Nothing for you."];
      if (f.decision === "adjudicator_unblock") return [`Looks ${LIKELY[a?.cause ?? ""] ?? "flaky"} (${ai}).`, next];
      if (f.class === "SAME_FAILURE_AS_CLEARED") return [`Same error as "${f.same_as}", cleared above.`, next];
      if (f.class === "FLAKY_NOT_RUN") return [f.reason, next];
      if (f.class === "INFRA_ERROR") return ["Failed on its environment (see the error), not on this change.", allFailed ? next : pr ? "Nothing for you; re-run if the lane must be green." : "Re-run when the environment recovers."];
      // Cleared on its first failure (see settlePR): nothing ties it to the PR, and a repeat is a PR streak.
      if (f.decision === "first_failure") {
        // What the history says, only where it could be used and says it: a pass record, or that there is none.
        const history = f.history_unused ? "Its history could not be used (see the evidence)"
          : !t.runs ? `No ${branch} history to compare`
          : t.passes === t.runs ? `Passes on ${branch} (${t.passes} of ${t.runs} runs)`
          : `On ${branch}: passed ${t.passes} of ${t.runs} runs`;
        const everywhere = f.failed_everywhere ? "Failed every try here and on another platform of this same commit. " : "";
        return [`${everywhere}${history}, and this PR changes neither the test nor a file its error names, so its first failure here is not blamed on the PR.`,
          `${f.failed_everywhere ? "Re-run once" : "Nothing for you"}. If it fails the same way on your next commit, triage blames this PR.`];
      }
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
function factsTable(f: Finding, branch: string, pr: boolean, branchRun: string | null = null): string[] {
  const t = f.trunk;
  const rows: [string, string][] = [];
  const edits = f.class === "OWNED_BY_PR";
  rows.push([`Does this ${pr ? "PR" : "commit"} change the test?`, edits ? "Yes" : "No"]);
  if (f.changed_by_pr) rows.push(["Does this PR change what the test looks for?", `Yes, ${f.changed_by_pr.removed ? "removes it" : "changes it"} in ${f.changed_by_pr.file}: "${f.changed_by_pr.line}"`]);
  if (f.pr_streak) rows.push([`Failed the same way on this PR's last commits`, `${count(f.pr_streak, "commit")}, never on ${branch}`]);
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
  if (f.out_of_date) {
    const c = f.out_of_date.commit;
    const also = f.out_of_date.also ?? [];
    const which = c ? `: ${sha7(c.sha)}${c.pr ? ` (#${c.pr})` : ""}${c.date ? ` on ${c.date}` : ""}${also.length ? `, and earlier ${also.map(refOf).join(", ")}` : ""}` : "";
    const base = f.out_of_date.base ?? branch;
    const support = f.out_of_date.support;
    rows.push(support
      ? (branchRun
        ? [`Test code changed on ${base} since ${branchRun} branched`, `Yes, in ${support}${which}. ${branchRun} is ${count(f.out_of_date.behind ?? 0, "commit")} behind ${base}, so it ran its old copy of the test code`]
        : [`Test code changed on ${branch} since this PR last merged it`, `Yes, in ${support}${which}. This PR is ${count(f.out_of_date.behind ?? 0, "commit")} behind, so it ran its old copy of the test code`])
      : f.out_of_date.fixed
      ? [`Fixed on ${branch} since this PR last merged it`, `Yes${which}: its first passing run. This PR is ${count(f.out_of_date.behind ?? 0, "commit")} behind, so it does not have the fix`]
      : branchRun
      ? [`Changed on ${base} since ${branchRun} branched`, `Yes${which}. ${branchRun} is ${count(f.out_of_date.behind ?? 0, "commit")} behind ${base}, so it ran its old copy of the test`]
      : [`Changed on ${branch} since this PR last merged it`, `Yes${which}. This PR is ${count(f.out_of_date.behind ?? 0, "commit")} behind, so it ran its old copy of the test`]);
  }
  if (f.decision === "evidence_incomplete" || f.identity_unresolved || f.history_unused) rows.push(["Why history wasn't used", f.reason]);
  const a = f.judge;
  if (a) {
    const verdict = a.cause === "caused_by_pr" ? "Caused by this PR" : a.cause === "app_bug" ? "An app bug in this build"
      : f.release ? `Not an app bug (${LIKELY[a.cause] ?? a.cause})` : `Not caused by this PR (${LIKELY[a.cause] ?? a.cause})`;
    const blames = a.cause === "caused_by_pr" || a.cause === "app_bug";
    const sure = f.decision === "adjudicator_unblock" || f.decision === "adjudicator_veto" || f.decision === "adjudicator_blame" ? `${pct(a.confidence)} sure, enough to decide`
      : blames ? `${pct(a.confidence)} sure; naming the PR needs 85% and a change it can point to`
      : f.decision === "advice" || f.decision === "first_failure" ? `${pct(a.confidence)} sure, but ${f.failed_everywhere ? "a failure on every try and on another platform is not cleared" : "with nothing it could point to, so it can't clear"}`
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

/** The counts, with their rate. Specs that never ran are counted apart from the failed, and the rate is left out: it would count them as failed. */
export const passLine = (counts: Partial<Counts>, notRun = 0): string => notRun
  ? `${counts.passed ?? 0} passed, ${Math.max(0, (counts.failed ?? 0) - notRun)} failed, ${notRun} not run, ${counts.skipped ?? 0} skipped`
  : `${passRate(counts)} passed (${counts.passed ?? 0} passed, ${counts.failed} failed, ${counts.skipped ?? 0} skipped)`;

/** An automatic re-run of the failed jobs triage asked for: the attempt it starts, of how many the repo allows. */
export interface Rerun {
  attempt: number;
  of: number;
}

/** Why specs that never ran keep the lane red (see isSpecNotRun). */
const notRunText = (n: number): string => `${count(n, "spec")} did not run, no result from ${n === 1 ? "its" : "their"} CI job`;

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
  /** A run with no PR on a branch other than the default (see branchBase): its name, for the out-of-date wording. */
  branchRun?: string | null;
  notes?: string[];
  /** The lane's own status is red although no test failed (a job outside the tests did). */
  laneRed?: boolean;
  /** "2 of 3 reports arrived", for a run with missing reports (see missingArrived). */
  reportsArrived?: string | null;
  /** Shard placeholders (see isShardPlaceholder): counted, not classified, and the lane is red for them. */
  unnamed?: number | null;
  /** Every spec that never ran (see isSpecNotRun), for the pass line. */
  notRun?: number | null;
  /** Of the placeholders, the specs that never ran: the ones the re-run line names. */
  notRunRerun?: number | null;
  /** The automatic re-run triage asked for, when it did. */
  rerun?: Rerun | null;
  /** The re-run check, when one ran (see decideRerun): why there was no automatic re-run. */
  rerunCheck?: { rerun: boolean; held: string | null; reason: string } | null;
}

/** What a red lane with no failed test is to re-run: a job outside the tests, or reports that never arrived. */
const RED_OUTSIDE = "No test failed. The lane is red because a job outside the tests failed (setup, upload or runner), or results are missing: re-run the failed jobs.";

/**
 * The job summary, shortest first: a one-line answer, then the failed tests in five
 * groups (Your PR, Out of date, Needs a look, Broken on the base branch, Flaky; one line each: why and the next
 * step), then the evidence, collapsed.
 */
export function renderSummary({ findings, infra: runInfra = null, runURL, counts, mode = "report-only", ai = newLedger(), missing = null, lane = null, trunkBranch = null, pr = true, branchRun = null, notes = [], laneRed = false, reportsArrived = null, unnamed = null, notRun = null, notRunRerun = null, rerun = null, rerunCheck = null }: SummaryInput): string {
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
  // A PR's failures the base branch changed or fixed are cleared (see settlePR); a release run's stay red for a
  // backport, and lead its headline when they are at least half its failures.
  const outdatedLead = Boolean(branchRun) && findings.length > 0 && outdated.length * 2 >= findings.length;
  // A failure the base branch fixed is named apart from a test it changed.
  const fixedCount = outdated.filter((f) => f.out_of_date?.fixed).length;
  const staleText = [fixedCount && `${fixedCount} fixed on ${md(branch)}`, outdated.length - fixedCount && `${outdated.length - fixedCount} changed on ${md(branch)}`].filter(Boolean).join(", ");
  const machineText = check.length ? `${check.length} machine failure${check.length === 1 ? "" : "s"}, re-run` : "";
  // A release branch's run is behind the default branch it was cut from, not its own history.
  const staleBase = outdated.find((f) => f.out_of_date?.base)?.out_of_date?.base ?? branch;
  const yoursText = `${yours.length} caused by this ${pr ? "PR" : "commit"}`;
  // The headline must agree with the verdict: blocking failures and missing reports are red, and "none caused"
  // is only said when nothing blocks.
  const head = infra && /infrastructure errors/.test(infra) && !yours.length ? "⚠️ machine failure: most of this run failed on its environment, re-run"
    : !counts.failed && !missing ? (laneRed ? "🔴 red outside the tests" : "✅ nothing failed")
    : outdatedLead ? `🔴 ${staleText}: ${md(staleBase)} changed these tests after ${md(branchRun ?? "")} branched${machineText ? `, ${machineText}` : ""}`
    : yours.length ? `🔴 ${yoursText}${machineText ? `, ${machineText}` : ""}`
    : missing ? "🔴 results missing"
    : check.length ? `🔴 ${machineText}`
    : branchRun && outdated.some((f) => f.blocking) ? `🔴 ${staleText}`
    : blockingBroken ? `🔴 ${blockingBroken} still failing on ${md(branchRun ?? branch)}`
    : unnamed ? `🔴 ${notRunRerun && !findings.length ? `${count(notRunRerun, "spec")} did not run, ` : ""}${rerun ? RERUNNING : RERUN}`
    : branchRun ? "✅ no app bug found"
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
  const nameless = (unnamed ?? 0) - (notRunRerun ?? 0);
  const placeholders = [notRunRerun ? notRunText(notRunRerun) : "", nameless > 0 ? `${count(nameless, "failed result")} with no test name` : ""].filter(Boolean).join("; ");
  const again = rerun ? `Re-running the failed jobs automatically (attempt ${rerun.attempt} of ${rerun.of}), then triaging the new results` : "Re-run the failed jobs";
  const rerunLine = unnamed ? `${again}: ${arrived || placeholders}.` : "";
  if (unnamed && !findings.length) {
    // Shard placeholders only: nothing is judged, so the line says which jobs to re-run, and what arrived.
    say = rerunLine;
  } else if (!counts.failed) {
    // Red with no failed test: the jobs to re-run. A missing report says how many arrived; a lane that is red for a job
    // outside the tests says that.
    say = missing ? `${again}: ${arrived}.` : laneRed ? (rerun ? `${again}: no test failed; a job outside the tests failed.` : RED_OUTSIDE) : "No test failed.";
  } else if (findings.length) {
    // A release run's cleared failures are named by what the model found (test bug, server compat, flaky).
    const kinds = branchRun ? statusLabels([...broken.filter((f) => !f.blocking), ...flaky]).join(", ")
      : [unrelatedBroken && `${unrelatedBroken} broken on ${branch}`, flaky.length && `${flaky.length} flaky`].filter(Boolean).join(", ");
    say = `${count(yours.length + outdated.length + check.length + blockingBroken + unrelated, "failure")}: ` + [
      yours.length && yoursText,
      fixedCount && `${fixedCount} fixed on ${branch}${branchRun ? "" : ", not blocking"}`,
      outdated.length - fixedCount && `${outdated.length - fixedCount} changed on ${branch}${branchRun ? "" : ", not blocking"}`,
      check.length && `${check.length} machine failure${check.length === 1 ? "" : "s"} (re-run the failed jobs)`,
      blockingBroken && `${blockingBroken} still failing on ${branchRun ?? branch}`,
      unrelated && (branchRun ? `${unrelated} not ${unrelated === 1 ? "an app bug" : "app bugs"} (${kinds})` : `${unrelated} not caused by this ${pr ? "PR" : "commit"} (${kinds})`),
    ].filter(Boolean).join("; ") + ".";
    if (outdatedLead) say = `Backport ${staleBase}'s test changes to ${branchRun}, or ignore them for this release. ${say}`;
    if (unnamed) say += ` ${rerunLine}`;
  }
  if (infra) say = `${infra} ${say}`;
  if (missing && counts.failed && !unnamed) say += ` Results incomplete: ${missing.text}; ${rerun ? "re-running the failed jobs automatically" : "re-run the failed jobs"} before relying on this.`;
  if (rerunCheck && !rerunCheck.rerun)
    say += rerunCheck.held ? ` Not re-run automatically: ${rerunCheck.reason}. That looks like the change, not the runner: fix it, then re-run the failed jobs.` : ` Not re-run automatically: ${rerunCheck.reason}.`;
  lines.push(`**${md(say.trim())}** ${passLine(counts, notRun ?? 0)} · [run](${runURL})`, "");

  const section = (title: string, list: Finding[], heading = `${title} (${list.length})`): void => {
    if (!list.length) return;
    lines.push(`### ${heading}`, "", "| Test | Why | Next step |", "| --- | --- | --- |");
    for (const f of list) {
      const [why, next] = whyNext(f, branch, pr, branchRun);
      // A row that blames this PR (or a base-branch change to its test), or is held for failing everywhere, is not
      // steered toward the environment.
      const plain = bucketOf(f) === "yours" || bucketOf(f) === "outdated" || Boolean(f.failed_everywhere);
      lines.push(`| ${md(f.title)} · \`${mdCode(fileOf(f))}\` | ${md(why + alsoFailed(f, plain ? PLAIN : SHARED_CAUSE))} | ${md(next)} |`);
    }
    lines.push("");
  };
  section(pr ? "Your PR" : "This commit", yours);
  section("Fixed on main", outdated, branchRun
    ? `Changed on ${md(staleBase)} (${outdated.length}): ${md(staleBase)} changed or fixed these tests after ${md(branchRun)} branched from it`
    : `Fixed on ${md(branch)} (${outdated.length}): ${md(branch)} changed or fixed these tests after this PR last merged it; not blocking`);
  section("Machine failure", check, `Machine failure (${check.length}): re-run the failed jobs`);
  section(`Broken on ${md(branchRun ?? branch)}`, broken);
  section(branchRun ? "Not an app bug" : "Flaky", flaky);

  const shown = [...yours, ...outdated, ...check, ...broken, ...flaky].slice(0, 30);
  if (shown.length) {
    lines.push("<details>", "<summary>Evidence for each test</summary>", "");
    for (const f of shown) lines.push(`**${md(f.title)}** · \`${mdCode(fileOf(f))}\``, "", ...factsTable(f, branch, pr, branchRun), "");
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

const FAULT_TEXT: Record<string, string> = {
  nobody: "nobody's: every spec ran and passed",
  "base branch": "the base branch's, not this change's",
  PR: "this change's",
  infrastructure: "the CI machines' or an outside service's, not this change's",
  unknown: "not known yet: the failure's error is in the lost report, which the re-run recovers",
};

/**
 * The job summary of a lane triage judged as a whole (see diagnoseLane): what happened, whose fault it is, what to do,
 * and the lines it rests on.
 */
export function renderLane({ verdict, rerunning, lane = null, runURL, base = null }: { verdict: LaneVerdict; rerunning: boolean; lane?: string | null; runURL: string; base?: string | null }): string {
  const where = lane ? ` · ${md(lane)}` : "";
  const icon = verdict.state === "success" ? "✅" : verdict.label === "machine failure" ? "🔁" : "❌";
  const action = verdict.label === "machine failure" && rerunning ? (verdict.rerun === "lane" ? "nothing: triage is re-running the whole lane" : "nothing: triage is re-running the failed jobs") : verdict.action;
  const lines = [
    `## E2E triage${where}: ${icon} ${md(verdict.label)}`,
    "",
    `**What happened:** ${md(verdict.what)}`,
    "",
    `**Whose fault:** ${md(FAULT_TEXT[verdict.fault] ?? verdict.fault)}`,
    "",
    `**What to do:** ${md(action)}${base && /merge (?:main|the base)/.test(action) ? ` (base branch: ${md(base)})` : ""}`,
    "",
  ];
  if (verdict.evidence.length) lines.push("<details><summary>Evidence</summary>", "", ...verdict.evidence.map((e) => `- ${md(e)}`), "", "</details>", "");
  lines.push(`[Run](${runURL})`, "");
  return lines.join("\n");
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

/** The labels the E2E check's text uses, in the order it lists them. */
export const STATUS_LABELS = ["flaky", "broken on main", "fixed on main", "test bug", "server compat", "caused by PR", "app bug", "broken on branch", "machine failure"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

/**
 * The label of one finding; every failure gets one of these, never "needs a look". Blocking: app bug (a release run's
 * judge names one), caused by PR (see causedByPR), fixed on main (only a release run's: its fix is a backport), machine
 * failure (the environment, a spec that never ran, or an unreadable change list: re-run), broken on branch (a release
 * run's own new break), otherwise broken on main (a trunk run's break). Cleared: fixed on main (a PR's copy the base
 * branch has since changed or fixed), broken on main (a trunk break, or the judge's bug_on_master), test bug or server
 * compat (the judge's, on a release run), otherwise flaky (trunk or cross-PR flakes, the environment, a PR run's test
 * bug, a first failure nothing ties to the PR, or the same failure as one of those).
 */
export function statusLabelOf(f: Finding): StatusLabel {
  if (f.blocking) {
    if (f.judge?.cause === "app_bug" && f.decision === "adjudicator_blame") return "app bug";
    if (f.class === "OWNED_BY_PR") return "caused by PR";
    if (f.out_of_date) return "fixed on main";
    if (provenStreak(f) || causedByPR(f)) return "caused by PR";
    if (machineFailure(f)) return "machine failure";
    return f.release ? "broken on branch" : "broken on main";
  }
  if (f.out_of_date && !f.release) return "fixed on main";
  if (f.decision === "base_broken") return "broken on main";
  if (f.decision === "first_failure") return "flaky";
  if (f.class === "SAME_FAILURE_AS_CLEARED") return f.same_as_class === "BROKEN_ON_TRUNK" ? "broken on main" : "flaky";
  if (f.decision === "adjudicator_unblock") {
    const cause = f.judge?.cause;
    if (cause === "bug_on_master") return "broken on main";
    if (f.release && cause === "test_bug") return "test bug";
    if (f.release && cause === "server_compat") return "server compat";
    return "flaky";
  }
  return f.class === "BROKEN_ON_TRUNK" ? "broken on main" : "flaky";
}

/** What a shard placeholder asks for (see isShardPlaceholder): the lane is red until its jobs are re-run. */
export const RERUN = "re-run the failed jobs";
/** The same, when triage asked for the re-run itself (see Rerun). */
export const RERUNNING = "re-running the failed jobs";

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
  return STATUS_LABELS.flatMap((l) => (counts.has(l) ? [`${counts.get(l)} ${l}`] : []));
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
 * failed jobs) ..."). The pass line counts specs that never ran apart from the failed. It is never shortened; past 140 characters the labels are, as the last resort.
 */
export function statusDescription(verdict: string, findings: Finding[], runInfra: string | null | undefined, counts: Partial<Counts>, missing: SummaryMissing | null = null, unnamed = 0, notRun = 0, rerun: Rerun | null = null, held: string | null = null): string {
  const pass = passLine(counts, notRun);
  // A held re-run says why on the check; an automatic one says it is on its way.
  const again = held ? `not re-run: ${held}` : rerun ? RERUNNING : RERUN;
  // A run with many failures says what triage made of each one, and its flag only while one still blocks.
  const infra = activeFlag(runInfra, findings);
  const head = infra && !findings.length ? `not triaged, ${runFlag(infra)}` : statusLabels(findings, counts.failed ?? 0).map((l) => (l === RERUN ? again : l)).join(", ");
  const rest = [infra && findings.length ? runFlag(infra) : "", unnamed && findings.length ? again : "", missing?.short ?? ""].filter(Boolean).join("; ");
  const room = STATUS_MAX - pass.length - 3 - (rest ? rest.length + 2 : 0);
  const shown = head.length <= room ? head : room > 1 ? `${head.slice(0, room - 1).trimEnd()}…` : "";
  const inner = [shown, rest].filter(Boolean).join("; ");
  return inner ? `(${inner}) ${pass}` : pass;
}
