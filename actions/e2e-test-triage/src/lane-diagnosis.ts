// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { allPassed, longestRun } from "../../shared/src/orchestration.ts";
import type { Orchestration, OrchestrationUnit } from "../../shared/src/orchestration.ts";
import { trunkBroken, trunkGreen } from "./baseline.ts";
import type { Baseline } from "./baseline.ts";
import type { LaneJob } from "./lane-jobs.ts";

/**
 * What a lane red outside its test results (missing reports, a dead job, no results at all) comes down to: one label,
 * whose fault it is, and what the author does. Every lane triage looks at gets one; none is left at "re-run".
 *
 * - "all specs ran": the orchestration says every spec ran and passed; only a job or a report was lost. Green.
 * - "broken on main": the base branch fails the same way at the PR's merge base (or, on a trunk run, this commit or an
 *   earlier one broke it). Not the author's fault. A PR's lane whose specs ran and failed that way is green (the tests
 *   say the same on their own); one whose setup broke ran nothing, so it stays red until the base branch is fixed.
 * - "fixed on main": broken at the merge base, or the base branch changed the code the lane's setup needs since the PR
 *   left it, and green on the base branch now. Not the author's fault: green where the specs ran, else merge the base.
 * - "caused by PR": the lane fails on every worker, or on a spec the PR changed, and the base branch does not.
 * - "machine failure": a runner, the network or a service failed, or a report was lost; the same code ran fine on the
 *   other jobs, or nothing shows the code failed. Re-run.
 * There is no "needs a look": a lane red for no reason shown is re-run as a machine failure, unless the PR changes the
 * lane's own code, which makes it the PR's.
 */
export type LaneLabel = "all specs ran" | "broken on main" | "fixed on main" | "caused by PR" | "machine failure";
export type Fault = "nobody" | "base branch" | "PR" | "infrastructure" | "unknown";
/** How the lane is re-run: not at all, its failed jobs (the orchestration never began), or the whole lane afresh. */
export type RerunKind = "none" | "failed-jobs" | "lane";

export interface LaneVerdict {
  label: LaneLabel;
  state: "success" | "failure";
  fault: Fault;
  /** What the author does, in a few words. */
  action: string;
  /** What happened, in one line: the step and its error, or the specs. */
  what: string;
  rerun: RerunKind;
  /** The evidence, one line each, for the job summary. */
  evidence: string[];
}

export interface LaneFacts {
  /** Whether the run tested a base-branch commit (no PR). */
  trunkRun: boolean;
  orchestration: Orchestration | null;
  /** Why the orchestration could not be read; null when it was read (or the lane has none). */
  orchestrationError?: string | null;
  jobs: LaneJob[] | null;
  jobsError?: string | null;
  /** Files the PR changes; null when unknown. */
  prFiles: string[] | null;
  baseline: Baseline | null;
  /** Repository directories the lane's specs and their support code live in (test root, support paths). */
  lanePaths: string[];
  /** Whether this attempt re-ran jobs on the first attempt's orchestration (a "re-run failed jobs"). */
  staleRerun: boolean;
  /** Spec files whose failures the arrived reports hold, which triage already judged test by test. */
  judgedSpecs?: string[];
}

// The runner, the network, GitHub or another outside service failed: nothing the change under test wrote.
const INFRA_RE =
  /Failed to get ID Token|Egress is over the account limit|Failed to GetCacheEntryDownloadURL|Failed to restore:|Cache not found for input keys|HttpError: (?:Server Error|Bad Gateway|Service Unavailable)|\b50[0234]\b.*(?:Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|GitHub (?:GET|POST) [^:]+: 5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network (?:error|aborted|timeout)|Could not resolve host|TLS handshake timeout|429 Too Many Requests|rate limit exceeded|The runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|No space left on device|Unable to download (?:artifact|action)|Failed to download action|could not fetch [0-9a-f]+ from promisor remote|fatal: (?:unable to access|early EOF|the remote end hung up)|RPC failed|Error: Unable to process command .* successfully|The operation was canceled/i;
// What only the code under test (or the base branch it carries) can break before a spec runs.
const CODE_RE: [RegExp, string][] = [
  [/npm (?:ERR!|error) (?:code )?(?:ERESOLVE|ETARGET|EUSAGE)|`npm ci` can only install packages when your package\.json and package-lock\.json|No matching version found|lock file'?s? .* does not satisfy/i, "the dependencies did not install"],
  [/error TS\d{4}:|Module not found|SyntaxError:|Compilation failed|BUILD FAILURE|Build failed|cannot find symbol|Cannot find module/i, "the build failed"],
  [/server (?:is )?not healthy|(?:is|container) not healthy|failed to start (?:the )?(?:test )?server|server did not (?:start|become ready)|Timed out waiting for the server|panic:|exited with code [1-9]/i, "the test server did not start"],
  [/Unknown [A-Z_]+ entry|Error: No tests found|Error: Project\(s\) .* not found/i, "the test setup failed"],
];
const AFTER_TESTS_STEP = /upload-debug-artifacts|upload-artifact|debug artifacts|teardown/i;
const RUN_STEP = /dispatch-run|run tests|run specs|\btest\b/i;
// A test runner's failed count (Playwright "  2 failed", mocha "2 failing") in a dead job's log.
const TESTS_FAILED = /^\s*\d+ (?:failed|failing)\b/m;
const TIMED_OUT = /has timed out after \d+ minutes|exceeded the maximum execution time|The job running on runner .* has exceeded/i;

/** How one dead job died: outside the code ("infra"), in code the lane runs ("code"), its time, after the tests, or unclear. */
export interface JobCause {
  kind: "infra" | "code" | "timeout" | "after-tests" | "unclear";
  /** The short reason for "code" ("the test server did not start"). */
  short: string | null;
  /** The line it rests on. */
  line: string;
}

export function jobCause(job: LaneJob): JobCause {
  const text = [job.tail, ...job.errors].join("\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = (re: RegExp): string | null => lines.find((l) => re.test(l)) ?? null;
  const infra = first(INFRA_RE);
  if (infra) return { kind: "infra", short: null, line: infra };
  if (job.step && AFTER_TESTS_STEP.test(job.step)) return { kind: "after-tests", short: null, line: job.errors[0] ?? lines.at(-1) ?? "" };
  const timeout = first(TIMED_OUT);
  if (timeout || job.conclusion === "timed_out") return { kind: "timeout", short: null, line: timeout ?? `${job.step ?? "the job"} timed out` };
  for (const [re, short] of CODE_RE) {
    const line = first(re);
    if (line) return { kind: "code", short, line };
  }
  // A job a person or a newer run cancelled is not a failure of the code.
  if (job.conclusion === "cancelled") return { kind: "infra", short: null, line: `${job.short} was cancelled` };
  return { kind: "unclear", short: null, line: job.errors[0] ?? lines.at(-1) ?? "no log" };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** A job's name in a status line: "worker 14" for a numbered test worker, else its name. */
const jobLabel = (job: LaneJob): string => {
  const n = job.worker ? /-(\d+)$/.exec(job.short)?.[1] : null;
  return n ? `worker ${n}` : job.short;
};
/** An error line without the wrappers that repeat it ("##[error]", "drain loop failed: Error message:"). */
const bare = (line: string): string => quote(line.replace(/^##\[error\]/, "").replace(/^(?:[\w -]+(?:failed|crashed): )?(?:Error(?: message)?: ?)+/i, ""));
const shortSpec = (spec: string): string => spec.replace(/^.*\/(?=[^/]+$)/, "");
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const quote = (line: string): string => clip(line.replace(/^##\[error\]/, "").replace(/\s+/g, " ").trim(), 110);

/** Whether a path is one the PR changed, matching a unit's spec path ("specs/a/b.spec.ts") against repository paths. */
const sameSpec = (spec: string, files: readonly string[]): boolean => files.some((f) => f === spec || f.endsWith(`/${spec}`) || spec.endsWith(`/${f}`));
const changedByPR = (spec: string, prFiles: string[] | null): boolean => sameSpec(spec, prFiles ?? []);

/** The failed test a dead job's log names (Playwright's "✘ … › test", an error line), else its cause's line. */
const hiddenLine = (c: { job: LaneJob; cause: JobCause }): string =>
  [c.job.tail, ...c.job.errors].join("\n").split("\n").map((l) => l.trim()).find((l) => /✘|failed|Error/.test(l) && !TESTS_FAILED.test(l)) ?? c.cause.line;

/** The base branch's verdict on a lane-wide failure: whose fault, and what to do. */
function baselineCall(facts: LaneFacts, setup: boolean, setupShort: string | null = null): { label: LaneLabel; fault: Fault; action: string; evidence: string } {
  const b = facts.baseline;
  const at = b?.atBase ?? null;
  const tip = b?.tip ?? null;
  const name = (r: { sha: string; state: string }) => `${b?.context ?? "the trunk lane"} on ${r.sha.slice(0, 7)}: ${r.state}`;
  if (facts.trunkRun) {
    // A trunk run's failure is the base branch's, whoever's commit it was: the commit before shows which.
    const first = at && trunkGreen(at);
    return { label: "broken on main", fault: "base branch", action: first ? "fix the base branch: this commit broke the lane" : "fix the base branch", evidence: at ? `before this commit, ${name(at)}` : "no earlier run of this lane found" };
  }
  if (at && trunkBroken(at)) {
    if (at.state === "pending") return { label: "broken on main", fault: "base branch", action: `not your change: merge ${b?.base} once it is fixed`, evidence: `at the merge base ${b?.context ?? "the trunk lane"} on ${at.sha.slice(0, 7)} is still running and has already failed ${at.orchestration?.failed.length ?? "most"} specs` };
    if (tip && tip.sha !== at.sha && trunkGreen(tip)) return { label: "fixed on main", fault: "base branch", action: `merge ${b?.base} and push`, evidence: `at the merge base ${name(at)}; now ${name(tip)}` };
    return { label: "broken on main", fault: "base branch", action: `not your change: merge ${b?.base} once it is fixed`, evidence: `at the merge base ${name(at)}${tip && tip.sha !== at.sha ? `; now ${name(tip)}` : ""}` };
  }
  const touched = (b?.baseChanged ?? []).filter((f) => facts.lanePaths.some((p) => p && (f === p || f.startsWith(p.endsWith("/") ? p : `${p}/`))));
  const behind = b?.behindBy ?? 0;
  // The base branch's own run at the merge base had not finished (an older commit's run was found instead): other PRs
  // failing this lane the same way at the same time show the base branch broke it. Two at least, and more than passed.
  const peers = b?.peers;
  if (!(at?.exact && trunkGreen(at)) && peers && peers.broken.length >= 2 && peers.broken.length > peers.healthy.length) {
    const ev = `${plural(peers.broken.length, "other run")} of this lane in the 6 hours before failed the same way (${clip(peers.broken.slice(0, 4).join(", "), 60)}); ${peers.healthy.length} did not${at ? `; the merge base's own run was not finished (newest found: ${name(at)})` : ""}`;
    return { label: "broken on main", fault: "base branch", action: `not your change: merge ${b?.base} once it is fixed`, evidence: ev };
  }
  if (at && trunkGreen(at)) {
    // Green at the merge base. A setup failure where the base branch since changed the lane's own code is a branch out
    // of date with what the workflow (always the base branch's) now expects.
    if (setup && behind > 0 && touched.length)
      return { label: "fixed on main", fault: "base branch", action: `merge ${b?.base}: it changed ${clip(touched.slice(0, 2).join(", "), 60)} since this branch left it`, evidence: `at the merge base ${name(at)}; ${plural(behind, "commit")} behind` };
    // The lane's own test setup (not the product: its server, build or dependencies) failed everywhere, and this PR
    // changes none of the lane's code: the setup the workflow (always the base branch's) asks for is newer than this
    // branch's test code.
    const prTouchesLane = (facts.prFiles ?? []).some((f) => facts.lanePaths.some((p) => p && f.startsWith(p.endsWith("/") ? p : `${p}/`)));
    if (setup && setupShort === "the test setup failed" && behind > 0 && facts.prFiles && !prTouchesLane)
      return { label: "fixed on main", fault: "base branch", action: `merge ${b?.base}: the lane's setup comes from ${b?.base}'s workflow, newer than this branch's test code`, evidence: `at the merge base ${name(at)}; ${plural(behind, "commit")} behind; the PR changes none of ${facts.lanePaths.join(", ")}` };
    return { label: "caused by PR", fault: "PR", action: "fix the change: the base branch passes this lane", evidence: `at the merge base ${name(at)}` };
  }
  // The merge base has no finished run of this lane: judge by the base branch now.
  if (tip && trunkBroken(tip)) return { label: "broken on main", fault: "base branch", action: `not your change: merge ${b?.base} once it is fixed`, evidence: `the base branch now: ${name(tip)}` };
  // No run at the merge base, and the base branch passes the lane now (or has no run to say otherwise): the lane failed
  // as a whole on this PR's code, which is the PR's whether or not the branch is behind.
  const lag = b?.behindBy == null ? "the base branch's run of this lane could not be read" : behind > 0 ? `no run of this lane at the merge base; ${plural(behind, "commit")} behind` : "the PR is up to date with its base branch";
  return { label: "caused by PR", fault: "PR", action: "fix the change: the base branch passes this lane", evidence: tip ? `${lag}; the base branch now: ${name(tip)}` : lag };
}

/**
 * The lane's verdict. The orchestration decides first: every spec ran and passed is green whatever else died. Then a
 * lane-wide failure (most specs failed, or every worker died the same way) is the base branch's or the PR's, by the
 * base branch's own run. Then dead jobs on some workers: the same code ran on the others, so it is the machine, unless
 * the specs left unfinished are ones the PR changed.
 */
export function diagnoseLane(facts: LaneFacts): LaneVerdict {
  const o = facts.orchestration;
  const jobs = facts.jobs ?? [];
  const dead = jobs.filter((j) => (j.conclusion === "failure" || j.conclusion === "cancelled" || j.conclusion === "timed_out") && !/lane-result|report|summary|triage/i.test(j.short));
  const causes = dead.map((j) => ({ job: j, cause: jobCause(j) }));
  const workers = jobs.filter((j) => j.worker);
  const deadWorkers = causes.filter((c) => c.job.worker);
  const evidence = causes.slice(0, 6).map(({ job, cause }) => `${job.short}: ${job.step ?? "a step"} — ${quote(cause.line)}`);
  if (dead.length > 6) evidence.push(`… and ${plural(dead.length - 6, "more dead job")}`);
  const rerunKind: RerunKind = o ? "lane" : "failed-jobs";

  // 1. Every spec ran and passed: only a worker, its report or a job after the tests was lost. Not where a worker's log
  // shows tests that failed in a step outside dispatch (an upgrade harness): the orchestration never sees those.
  const hidden = deadWorkers.filter((c) => !(c.job.step && RUN_STEP.test(c.job.step)) && TESTS_FAILED.test([c.job.tail, ...c.job.errors].join("\n")));
  if (allPassed(o) && !hidden.length) {
    const slow = o!.units.filter((u) => u.attempts.some((a) => a.expired) && longestRun(u) > 0).sort((a, b) => longestRun(b) - longestRun(a));
    const lost = deadWorkers.length;
    const ev = [`TSIO orchestration ${o!.status}: ${o!.units.length} of ${o!.totalUnits} specs ran, ${o!.tests.total} tests, 0 failed`, ...evidence];
    for (const u of slow.slice(0, 2)) ev.push(`${u.spec} ran ${Math.round(longestRun(u) / 60000)} min, past its lease: split it or it can outlast a worker`);
    return { label: "all specs ran", state: "success", fault: "nobody", action: "nothing", what: lost ? `${plural(lost, "worker")} lost after the other workers ran every spec` : "a job outside the tests failed after every spec ran", rerun: "none", evidence: ev };
  }

  // 1b. Tests that failed outside dispatch (an upgrade harness) on some workers, while the others ran them clean: the
  // same code passed there, so it is re-run, and the summary names the test step that failed. On every worker it is a
  // lane-wide failure, judged below.
  // Workers are counted by the step they died on, not by whose log was read (at most ten are): one whose log was not read
  // but died at the same step is not counted as a pass.
  // A worker that died there on the network or the runner is the machine's, not a harness failure.
  const sameStep = hidden.length ? deadWorkers.filter((c) => c.job.step === hidden[0].job.step && c.cause.kind !== "infra") : [];
  const hiddenAll = hidden.length > 0 && sameStep.length === workers.length;
  if (hidden.length && !hiddenAll) {
    const h = hidden[0];
    const passed = workers.length - sameStep.length;
    return { label: "machine failure", state: "failure", fault: "infrastructure", action: rerunKind === "lane" ? "re-run all jobs" : "re-run the failed jobs", what: `${h.job.step} tests failed on ${plural(sameStep.length, "worker")} and passed on the other ${passed}: ${quote(hiddenLine(h))}`, rerun: rerunKind, evidence: [`${sameStep.map((c) => jobLabel(c.job)).join(", ")}: ${h.job.step} failed; ${plural(passed, "worker")} passed it`, ...evidence] };
  }

  // 2. A lane-wide failure: most specs failed, or the setup broke on every worker that started.
  const finished = o ? o.units.length - o.unfinished.length : 0;
  const massTests = Boolean(o && o.failed.length >= 20 && o.failed.length * 4 >= finished);
  const codeDead = causes.filter((c) => c.cause.kind === "code");
  // Every worker died before any spec finished, on the same step, and every log read (ten at most) says the code broke.
  const readDead = deadWorkers.filter((c) => c.job.tail || c.job.errors.length);
  const allWorkersSetup = workers.length > 0 && deadWorkers.length === workers.length && finished === 0 && readDead.length > 0 &&
    readDead.every((c) => c.cause.kind === "code") && new Set(deadWorkers.map((c) => c.job.step)).size === 1;
  const setupJob = codeDead.find((c) => !c.job.worker);
  // Harness tests that failed on every worker (hiddenAll): the same code failed them everywhere, a lane-wide test failure.
  if (massTests || allWorkersSetup || hiddenAll || (setupJob && finished === 0)) {
    const call = baselineCall(facts, !massTests, (setupJob ?? codeDead[0])?.cause.short ?? null);
    // The error the failed specs share, as the dead workers' logs give it: an assertion or error line, the most repeated first.
    const errs = deadWorkers.flatMap((c) => c.job.errors).filter((l) => !INFRA_RE.test(l));
    const top = massTests ? (errs.find((l) => /AssertionError|Error:|Expected|Timed out|toBe|not found/.test(l)) ?? errs[0] ?? null) : null;
    const what = massTests
      ? `${o!.failed.length} of ${finished} specs failed${top ? `: ${quote(top)}` : ""}`
      : setupJob
        ? `${setupJob.job.short} ${setupJob.job.step ?? ""} failed: ${quote(setupJob.cause.line)}`
        : hiddenAll && !codeDead.length
          ? `${hidden[0].job.step} tests failed on every worker: ${quote(hiddenLine(hidden[0]))}`
          : `${codeDead[0].job.step ?? "setup"} failed on ${deadWorkers.length} of ${workers.length} workers: ${quote(codeDead[0].cause.line)}`;
    // A PR's specs that ran and failed as the base branch does are not the PR's: green, as each test would be (see
    // settlePR). A setup that broke ran no spec, so nothing vouches for the PR: red until the base branch is fixed.
    const notYours = !facts.trunkRun && massTests && (call.label === "broken on main" || call.label === "fixed on main");
    return { label: call.label, state: notYours ? "success" : "failure", fault: call.fault, action: call.action, what, rerun: "none", evidence: [call.evidence, ...evidence] };
  }

  // 3. Specs that failed in a report that never arrived: real test failures triage could not judge test by test.
  const unjudged = (o?.failed ?? []).filter((u) => !sameSpec(u.spec, facts.judgedSpecs ?? []));
  if (o && unjudged.length) {
    const specs = unjudged.map((u) => shortSpec(u.spec));
    const mine = unjudged.filter((u) => changedByPR(u.spec, facts.prFiles));
    // A report that never arrived is lost in delivery: re-run so its specs arrive and are judged test by test. One the PR
    // changed is the PR's to look at either way.
    return {
      label: mine.length ? "caused by PR" : "machine failure",
      state: "failure",
      fault: mine.length ? "PR" : "infrastructure",
      action: mine.length ? "fix the specs this PR changed" : rerunKind === "lane" ? "re-run all jobs" : "re-run the failed jobs",
      what: `${plural(unjudged.length, "spec")} failed in a lost report: ${clip(specs.join(", "), 80)}`,
      rerun: mine.length ? "none" : rerunKind,
      evidence: [`TSIO orchestration: ${o.failed.length} failed, ${o.unfinished.length} unfinished of ${o.totalUnits} specs`, ...evidence],
    };
  }

  // 4. Specs that never finished. A spec the PR changed that outlasted its worker is the PR's; otherwise the machine.
  const unfinished: OrchestrationUnit[] = o?.unfinished ?? [];
  const mineUnfinished = unfinished.filter((u) => changedByPR(u.spec, facts.prFiles));
  const timedOut = causes.filter((c) => c.cause.kind === "timeout");
  if (mineUnfinished.length && timedOut.length) {
    const u = mineUnfinished[0];
    const ran = longestRun(u);
    return { label: "caused by PR", state: "failure", fault: "PR", action: `make ${shortSpec(u.spec)} faster or split it`, what: `${shortSpec(u.spec)} (changed by this PR) did not finish before its worker timed out${ran ? ` (ran ${Math.round(ran / 60000)} min)` : ""}`, rerun: "none", evidence: [`TSIO orchestration: ${unfinished.length} unfinished: ${clip(unfinished.map((x) => shortSpec(x.spec)).join(", "), 100)}`, ...evidence] };
  }

  // 5. No job died, yet the lane's jobs never ran: GitHub skipped them (a job it never created, a needed job it lost).
  const skipped = jobs.filter((j) => j.conclusion === "skipped" && !/lane-result|report|summary|triage/i.test(j.short));
  if (!causes.length && !o && skipped.length) {
    const names = skipped.map((j) => j.short.replace(/\$\{\{[^}]*\}\}/g, "*"));
    return { label: "machine failure", state: "failure", fault: "infrastructure", action: "re-run all jobs", what: `the lane's jobs never ran: ${clip(names.join(", "), 90)} skipped, and no job failed`, rerun: "lane", evidence: [`lane jobs: ${jobs.map((j) => `${j.short} ${j.conclusion}`).join(", ").slice(0, 300)}`, "TSIO orchestration never began"] };
  }

  // 6. Dead jobs the code did not cause: the same code ran on the other workers, or the step failed outside it.
  const notCode = causes.filter((c) => c.cause.kind !== "code");
  const someWorkers = deadWorkers.length > 0 && deadWorkers.length < workers.length;
  const infraLike = causes.length > 0 && (notCode.length === causes.length || (someWorkers && causes.every((c) => c.job.worker)));
  const stale = facts.staleRerun && Boolean(o);
  if (infraLike || stale) {
    const lead = causes.find((c) => c.cause.kind === "infra") ?? causes.find((c) => c.cause.kind === "timeout") ?? causes[0];
    const specs = unfinished.length ? `; ${plural(unfinished.length, "spec")} never finished` : "";
    const what = lead ? `${jobLabel(lead.job)}: ${bare(lead.cause.line)}${specs}` : `this attempt re-ran jobs on a closed run${specs}`;
    const ev = [...(stale ? ["this attempt re-ran failed jobs on the first attempt's TSIO run, which had closed: its workers could take no specs"] : []), ...(o ? [`TSIO orchestration ${o.status}: ${unfinished.length} unfinished, ${o.failed.length} failed of ${o.totalUnits} specs`] : ["TSIO orchestration never began"]), ...evidence];
    return { label: "machine failure", state: "failure", fault: "infrastructure", action: rerunKind === "lane" ? "re-run all jobs" : "re-run the failed jobs", what, rerun: rerunKind, evidence: ev };
  }

  // 7. Nothing above shows the code failed. A PR that changes the lane's own code (its specs or support paths) owns the
  // red lane; otherwise it is re-run as a machine failure, naming the step and its error.
  const lead = causes[0];
  const prTouchesLane = !facts.trunkRun && (facts.prFiles ?? []).some((f) => facts.lanePaths.some((p) => p && f.startsWith(p.endsWith("/") ? p : `${p}/`)));
  return {
    label: prTouchesLane ? "caused by PR" : "machine failure",
    state: "failure",
    fault: prTouchesLane ? "PR" : "infrastructure",
    action: prTouchesLane ? "fix the change: it changes this lane's code" : rerunKind === "lane" ? "re-run all jobs" : "re-run the failed jobs",
    what: lead ? `${lead.job.short}: ${lead.job.step ?? "a step"} — ${quote(lead.cause.line)}` : facts.jobsError ? `the run's jobs could not be read (${clip(facts.jobsError, 60)})` : o && unfinished.length ? `${plural(unfinished.length, "spec")} never finished and no job says why` : o ? "every spec finished, no test failed in TSIO, and no job failed: the lane's status says why" : "no TSIO results and no failed job",
    rerun: prTouchesLane ? "none" : rerunKind,
    evidence: [...(facts.orchestrationError ? [`TSIO orchestration unreadable: ${facts.orchestrationError}`] : []), ...evidence],
  };
}

/**
 * Whether a lane verdict may turn the run green. A lane red outside its tests (a report missing, a job dead, no results)
 * turns green only on the orchestration: every dispatched spec ran and passed ("all specs ran"). That is the line the
 * lane-result gate holds (basis "orchestration"), so success is never written for a lane that gate would keep red. A
 * PR's lane the base branch explains ("broken on main", "fixed on main") is green only when its results are complete.
 */
export function laneTurnsGreen(v: Pick<LaneVerdict, "state" | "label">, outsideTests: boolean): boolean {
  return v.state === "success" && (v.label === "all specs ran" || !outsideTests);
}

/** The lane's status text: "(label, action) what", cut to GitHub's 140 characters. */
export function laneDescription(v: LaneVerdict, rerunning: boolean, base = "main"): string {
  const head =
    v.label === "machine failure" ? `machine failure, ${rerunning ? (v.rerun === "lane" ? "re-running the lane" : "re-running the failed jobs") : v.action}` :
    v.label === "broken on main" ? (v.action.startsWith("fix the base branch") ? "broken on main" : "broken on main, not your change") :
    v.label === "fixed on main" ? (v.state === "success" ? "fixed on main, not your change" : `fixed on main, merge ${base}`) :
    v.label;
  return clip(`(${head}) ${v.what}`, 140);
}
