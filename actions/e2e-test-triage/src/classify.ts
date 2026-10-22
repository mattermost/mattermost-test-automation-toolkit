// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { FAILED_STATUSES } from "../../shared/src/tsio.ts";
import { DEFAULTS, laneOf } from "./config.ts";
import type { At, Config, Finding, Observation, TestRef, TsioId } from "./types.ts";

// The last alternative: a mobile spec whose shard uploaded nothing never ran.
const INFRA_RE =
  /server (?:is )?not healthy|server at "[^"]*" is not healthy|No response from server|ECONNREFUSED|ENOTFOUND|net::ERR_|browser has been closed|browser has disconnected|Target page, context or browser has been closed|StatusRuntimeException: UNAVAILABLE|Failed to launch|Could not connect to|socket hang up|502 Bad Gateway|503 Service|Timed out waiting for the (?:server|app)|was assigned to a shard but produced no result|was not JSON|answered with an HTML page|HTML from server|server did not attach file|cloudflare-5xx-errors|service is not ready/i;

export const isInfraError = (text: string | null | undefined): boolean => INFRA_RE.test(text ?? "");

export const EXONERATED = new Set(["BROKEN_ON_TRUNK", "FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
// On a trunk run only flakiness clears: a failure still there from last time is a
// standing breakage, and greening it would hide it.
export const EXONERATED_ON_TRUNK = new Set(["FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
export const exoneratedSet = (isTrunkRun: boolean): Set<string> => (isTrunkRun ? EXONERATED_ON_TRUNK : EXONERATED);
export const BORDERLINE = new Set(["REGRESSION", "INSUFFICIENT_DATA"]);

export interface ClassifyOptions {
  isTrunkRun?: boolean;
  groupId?: TsioId | null;
  trunkBranch?: string | null | undefined;
}

/** Classify one failing test from its history and the PR's changed files. */
export function classify(
  test: TestRef,
  observations: Observation[],
  changedFiles: string[],
  cfg: Config = DEFAULTS,
  prNumber: number | string | null = null,
  lane: string | null = null,
  opts: ClassifyOptions = {},
): Finding {
  const { isTrunkRun = false, groupId = null, trunkBranch = null } = opts;
  const own = new Set(changedFiles);
  // A run is never part of its own history.
  const seen = groupId == null ? observations : observations.filter((o) => o.group_id !== groupId);
  // A skipped execution is not a trial.
  const ran = seen.filter((o) => o.status !== "skipped");
  const inLane = lane == null ? ran : ran.filter((o) => o.name == null || laneOf(o.name) === lane);
  // Compare as numbers: identities built with jq carry PR numbers as strings.
  const prOf = (o: Observation): number | null => (o.gh_pr_number == null || o.gh_pr_number === "" ? null : Number(o.gh_pr_number));
  const currentPR = prNumber == null ? null : Number(prNumber);
  // No PR number is not enough to be trunk: a pushed branch has none either.
  const trunk = inLane.filter((o) => prOf(o) == null && (trunkBranch == null || o.branch === trunkBranch));
  const others = inLane.filter((o) => prOf(o) != null && prOf(o) !== currentPR);
  // This PR's own earlier runs: a test that passed on an earlier commit of the PR,
  // with nothing related changed since, did not break because of the PR.
  const mine = currentPR == null ? [] : inLane.filter((o) => prOf(o) === currentPR);
  const minePassed = mine.filter((o) => o.status === "passed" || o.status === "flaky");
  const trunkFails = trunk.filter((o) => FAILED_STATUSES.has(o.status)).length;
  const trunkFlaky = trunk.filter((o) => o.status === "flaky").length;
  const trunkPasses = trunk.filter((o) => o.status === "passed").length;
  const latestTrunk = trunk[0] as Observation | undefined;
  // A test failing on trunk now: the run where the current streak began, and the pass before it.
  let streak = 0;
  while (streak < trunk.length && FAILED_STATUSES.has(trunk[streak].status)) streak++;
  const at = (o: Observation | undefined): At | null => (o ? { commit_sha: o.commit_sha ?? null, created_at: o.created_at ?? null } : null);
  // Other PRs' failures count only with the same failure (see failureKey): a distinctive error with the same
  // error, a timeout with the same stuck step, a bare timeout with a bare timeout. Nothing else is the same.
  const ownKey = failureKey(test.error);
  // Trunk's comparison keeps the distinctive error only (see otherError); the cross-PR rule uses failureKey.
  const ownSignature = errorSignature(test.error);
  const sameAsOwn = (excerpt: string | null | undefined): boolean => {
    const k = failureKey(excerpt);
    if (ownKey.kind === "stuck") {
      // A stuck step also has to agree on the old signature when both have one: the step key masks durations, the signature does not.
      return k.kind === "stuck" && k.key === ownKey.key && (ownSignature === errorSignature(excerpt) || (ownSignature == null && errorSignature(excerpt) == null));
    }
    return ownKey.kind === "distinctive" ? k.kind === ownKey.kind && k.key === ownKey.key : k.kind === ownKey.kind;
  };
  const crossFailures = others.filter((o) => FAILED_STATUSES.has(o.status) && sameAsOwn(o.error_excerpt));
  const failedPRs = [...new Set(crossFailures.map(prOf))];
  const otherPasses = others.filter((o) => o.status === "passed" || o.status === "flaky").length;
  // The distinctive errors this test had elsewhere (used by sameFailure, which keys on sameKey).
  const failureSignatures = [...new Set([...trunk, ...others]
    .filter((o) => FAILED_STATUSES.has(o.status))
    .map((o) => sameKey(o.error_excerpt))
    .filter((k): k is string => Boolean(k)))];
  const stats = {
    trunk: { runs: trunk.length, fails: trunkFails, flaky: trunkFlaky, passes: trunkPasses, latest: latestTrunk?.status ?? "" },
    cross_pr: {
      prs: failedPRs,
      examples: crossFailures
        .filter((o, i, all) => all.findIndex((x) => prOf(x) === prOf(o)) === i)
        .slice(0, 12)
        .map((o) => `PR ${prOf(o)} (${o.commit_sha?.slice(0, 7) ?? "unknown"}, ${o.created_at?.slice(5, 10) ?? "?"})`),
      passes: otherPasses,
    },
    failure_signatures: failureSignatures,
    trunk_break: streak ? { first_fail: at(trunk[streak - 1]), last_pass: at(trunk[streak]) } : null,
    this_pr: {
      runs: mine.length,
      passes: minePassed.length,
      fails: mine.filter((o) => FAILED_STATUSES.has(o.status)).length,
      last_pass: minePassed[0] ? { commit_sha: minePassed[0].commit_sha ?? null, created_at: minePassed[0].created_at ?? null } : null,
    },
  };
  const out = (cls: string, reason: string, blocking: boolean): Finding => ({ ...test, class: cls, reason, blocking, ...stats });
  // Trunk's instability clears a PR's failure only when it is the same failure. When every
  // trunk failure has an error to compare and none is this one, the PR may have broken the
  // test in a new way: it goes to the judge instead. Unknown trunk errors prove nothing either way.
  const otherError = (rows: Observation[]): string | null => {
    if (ownSignature == null || !rows.length) return null;
    const sigs = rows.map((o) => errorSignature(o.error_excerpt));
    return sigs.every(Boolean) && !sigs.includes(ownSignature) ? (sigs[0] ?? null) : null;
  };
  if (own.has(test.repo_path ?? test.file))
    return out("OWNED_BY_PR", isTrunkRun
      ? `This commit changes ${test.file}; a failure in a spec the commit edits is not noise.`
      : `This PR changes ${test.file}; a failure in a spec the PR edits is the PR's to explain.`, true);
  // The test's own error says the environment failed (the test server down or behind a proxy page,
  // a shard that never ran): history says nothing about that. Where the PR can't touch the
  // environment (an app against a separate test server) it clears; where it can (a server PR that
  // hangs its own server) it is named so the developer reruns, and stays blocking.
  if (isInfraError(test.error))
    return out("INFRA_ERROR", cfg.infraClears
      ? "Environment error, not the change: the test failed on its environment (see the error). Rerun when it recovers."
      : "Environment error: the test failed on its environment (see the error). Rerun; if it fails the same way again, the change may be the cause.", !cfg.infraClears);
  // History that names more than one test cannot clear any of them.
  if (test.identity_unresolved)
    return out(
      "INSUFFICIENT_DATA",
      `The available suite/report identity does not uniquely identify "${test.title}" in ${test.file}; history cannot clear it.`,
      true,
    );
  // On trunk, a failure already there last time is a streak and stays red.
  if (isTrunkRun) {
    if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status))
      return out("BROKEN_ON_TRUNK", `Still failing: the previous ${lane ?? "trunk"} run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}) failed this test too. That is a streak, not a flake.`, true);
    if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0)
      return out("FLAKY_ON_TRUNK", `Intermittent on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the previous ${trunk.length} runs, and the last one passed.`, false);
    if (trunk.length < cfg.minTrunkRuns)
      return out("INSUFFICIENT_DATA", `Only ${trunk.length} earlier trunk runs (need ${cfg.minTrunkRuns}); cannot tell a flake from a new break.`, true);
    return out("REGRESSION", `New on trunk: passed in all ${trunk.length} previous runs.`, true);
  }
  if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status)) {
    const trunkError = otherError(trunk.slice(0, streak));
    if (trunkError)
      return out("REGRESSION", `Trunk fails this test too, but with another error ("${trunkError.slice(0, 160)}"); this one may be the PR's.`, true);
    return out("BROKEN_ON_TRUNK", `Trunk's latest run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}, ${latestTrunk.created_at?.slice(0, 10) ?? "unknown date"}) fails this test too.`, false);
  }
  const laplace = (trunkFails + trunkFlaky + 1) / (trunk.length + 2);
  if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0 && laplace >= cfg.pMin && latestTrunk?.status !== "failed") {
    const trunkError = otherError(trunk.filter((o) => FAILED_STATUSES.has(o.status) || o.status === "flaky"));
    if (trunkError)
      return out("REGRESSION", `Unstable on trunk (${trunkFails} failures, ${trunkFlaky} flaky passes in ${trunk.length} runs), but never with this error; there it failed with "${trunkError.slice(0, 160)}".`, true);
    return out("FLAKY_ON_TRUNK", `Unstable on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the last ${trunk.length} trunk runs.`, false);
  }
  // Require real trunk passes: trunkFails === 0 is also true with no trunk runs.
  if (failedPRs.length >= cfg.crossPRMinPRs && trunkFails === 0 && trunkPasses > 0)
    return out("FLAKY_CROSS_PR", `Failed${ownKey.kind === "distinctive" ? " with the same error" : ownKey.kind === "stuck" ? " stuck at the same step" : ownKey.kind === "bare" ? " with the same bare timeout" : ""} on ${failedPRs.length} other PRs in the last ${cfg.crossPRRuns} runs (${stats.cross_pr.examples.slice(0, 3).join(", ")}) while trunk stayed green.`, false);
  if (trunk.length < cfg.minTrunkRuns)
    return out("INSUFFICIENT_DATA", `Only ${trunk.length} trunk runs found (need ${cfg.minTrunkRuns}); history cannot clear it.`, true);
  return out("REGRESSION", `Fails here, passes on trunk (${trunkPasses}/${trunk.length}) and was not failing on other PRs enough to call it flaky (${failedPRs.length}).`, true);
}

// A message that only says time ran out names no cause, so two timeouts in one
// spec are not evidence of one failure.
const GENERIC_ERROR_RE = /^(?:\w*error:\s*)?(?:thrown:\s*)?["']?(?:test timeout|exceeded timeout|timeout of|timed out)/i;

/**
 * What a failure says, not where: the message's first lines without the stack,
 * generated ids masked. Null when too short or generic to compare.
 */
export function errorSignature(error: string | null | undefined): string | null {
  const kept: string[] = [];
  for (const line of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    if (/^at\s/.test(line) || /^call log:/i.test(line)) break;
    kept.push(line);
    if (kept.length === 3) break;
  }
  if (!kept.length || GENERIC_ERROR_RE.test(kept[0])) return null;
  const sig = kept.join(" ")
    .replace(/\s+at\s+(?:async\s+)?(?:\S+\s+)?\(?(?:file:\/\/)?(?:[A-Za-z]:)?[\\/].*$/, "")
    // Generated names differ per run: mixed letter-digit tokens and long numbers.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return sig.length >= 30 ? sig : null;
}

/**
 * What a failure says, for the cross-PR rule and sameFailure. A timeout (its first line is one: Playwright's
 * "Timeout Nms exceeded", "Test timeout of Nms", Jest's "Exceeded timeout of N ms", Detox's "Timed out ...")
 * is compared by where it got stuck: the action and the locator, selector, expectation or event it waited on,
 * with generated ids and durations masked. A timeout with no such step is "bare": it is the same failure only as
 * another bare timeout. Any other error is "distinctive" when errorSignature gives it one, and otherwise
 * "unusable" (empty or too short), which is the same failure only as another unusable error.
 */
export type FailureKind = "distinctive" | "stuck" | "bare" | "unusable";
export interface FailureKey {
  kind: FailureKind;
  key: string | null;
}

const TIMEOUT_FIRST_RE = /^(?:\w*error:\s*)?(?:thrown:\s*)?(?:test failed:\s*)?["']?(?:test timeout|exceeded timeout|timeout of\b|timed out|[\d.]+\s*sec timeout|[\w.]+:\s*timeout\s*[\d.]+\s*ms|timeout\s*[\d.]+\s*ms)/i;
const TIMEOUT_ACTION_RE = /^(?:\w*error:\s*)?([\w.]+):\s*timeout\s*[\d.]+\s*ms/i;
// Where the message is about its own code frame or stack, it has said all it will.
const FRAME_RE = /^at\s|^(?:>\s*)?\d+\s*\||^\||^\^|^Add a timeout value/;
// What a timeout waited on, from its first line when the call log did not name it.
const FIRST_LINE_STEP: [RegExp, (m: RegExpExecArray) => string | null][] = [
  [/timed out (?:after waiting for|waiting for)\s+(.+)$/i, (m) => (/^[\d.,\s]*(?:ms|sec|s)?\s*$/i.test(m[1]) ? null : `waiting for ${m[1]}`)],
  [/timed out retrying after [\d.]+\s*ms:\s*(.+)$/i, (m) => `retrying ${m[1].replace(/,\s*but the text was.*$/, "")}`],
  [/timeout expired without matching of given matcher:\s*(.+)$/i, (m) => `matcher ${m[1]}`],
  [/timed out while waiting for expectation:\s*(.+?)(?:\s+TIMEOUT\(.*\))?$/i, (m) => `expectation ${m[1]}`],
  [/while waiting for event\s+("[^"]*"|\S+)/i, (m) => `event ${m[1]}`],
];

/** A timeout's stuck step, normalised; null when its message names neither an action nor a step. */
function stuckStep(lines: string[]): string | null {
  const first = lines[0];
  const action = TIMEOUT_ACTION_RE.exec(first)?.[1] ?? null;
  let target: string | null = null;
  for (const l of [...lines.slice(1), first]) {
    const w = /^-?\s*(waiting for\s+.+)$/i.exec(l);
    if (w) {
      target = w[1];
      break;
    }
  }
  for (const [re, describe] of FIRST_LINE_STEP) {
    if (target) break;
    const m = re.exec(first);
    if (m) target = describe(m);
  }
  if (!action && !target) return null;
  return [action ? `action ${action}` : null, target]
    .filter(Boolean)
    .join(" ")
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\b\d+(?:\.\d+)?\s*sec\b/gi, "<n>sec")
    .replace(/\s+/g, " ")
    .trim();
}

export function failureKey(error: string | null | undefined): FailureKey {
  const lines: string[] = [];
  for (const raw of String(error ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (lines.length && FRAME_RE.test(l)) break;
    lines.push(l);
  }
  if (lines.length && TIMEOUT_FIRST_RE.test(lines[0])) {
    const step = stuckStep(lines);
    return step ? { kind: "stuck", key: step } : { kind: "bare", key: null };
  }
  const sig = errorSignature(error);
  return sig ? { kind: "distinctive", key: sig } : { kind: "unusable", key: null };
}

/**
 * sameFailure's key: the old signature only. A stuck step names a place, not a cause, and is too coarse across
 * tests in one spec: a failure stuck on the same step as a cleared one is not thereby the same failure.
 */
function sameKey(error: string | null | undefined): string | null {
  return failureKey(error).kind === "distinctive" ? errorSignature(error) : null;
}

/**
 * A blocked failure with the same spec and error as a cleared one shares its
 * cause, if the cleared test's own history shows that error without this PR.
 * Typical case: a shared setup breaks, and only some of the suite's tests are
 * old enough to have history. Runs after the judge, on PR runs only.
 */
export function sameFailure(findings: Finding[]): Finding[] {
  const blamed = (f: Finding): boolean => f.judge?.cause === "caused_by_pr";
  const keyOf = (f: Finding): string | null => {
    const sig = sameKey(f.error);
    return sig ? JSON.stringify([f.repo_path ?? f.file, sig]) : null;
  };
  const anchors = new Map<string | null, Finding>();
  for (const f of findings) {
    if (f.blocking || !EXONERATED.has(f.class) || f.identity_unresolved || blamed(f)) continue;
    const sig = sameKey(f.error);
    if (!sig || !(f.failure_signatures ?? []).includes(sig)) continue;
    const k = keyOf(f);
    if (!anchors.has(k)) anchors.set(k, f);
  }
  for (const f of findings) {
    if (!f.blocking || !BORDERLINE.has(f.class) || f.identity_unresolved || f.decision === "evidence_incomplete" || blamed(f)) continue;
    const k = keyOf(f);
    const anchor = k ? anchors.get(k) : undefined;
    if (!anchor) continue;
    Object.assign(f, {
      class: "SAME_FAILURE_AS_CLEARED",
      blocking: false,
      decision: "same_failure",
      same_as: anchor.full_title || anchor.title,
      same_as_class: anchor.class,
      reason: `Fails with the same error as "${anchor.title}" in this spec, which history cleared (${anchor.class}): ${anchor.reason}`,
    });
  }
  return findings;
}

/** Run-level infrastructure call: many failures, or most failures share an infra signature. */
export function infraVerdict(failing: readonly { error?: string | null }[], cfg: Config = DEFAULTS): string | null {
  if (!failing.length) return null;
  const infra = failing.filter((t) => isInfraError(t.error)).length;
  if (infra >= Math.max(3, Math.ceil(failing.length / 2)))
    return `${infra} of ${failing.length} failures are infrastructure errors (server health, connectivity, device, shard that never ran); rerun when the environment recovers.`;
  if (failing.length >= cfg.infraMinFailures)
    return `${failing.length} tests failed in one run; check for a shared environment, build or product failure first.`;
  return null;
}
