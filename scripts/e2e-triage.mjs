#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/**
 * E2E triage: is this red run the PR's fault?
 *
 * Runs after the E2E summary of a PR run. For every test that ended failed
 * (retry-recovered tests do not count) it asks TSIO for the test's history
 * across trunk and other PRs, applies a handful of rules, asks Claude about the
 * findings the rules cannot settle, and publishes the outcome as the required
 * commit status plus a sticky PR comment that names the evidence.
 *
 * Rules, in order (each was validated on production history before shipping):
 *   INFRA            the run failed for environmental reasons          -> red, nobody blamed
 *   OWNED_BY_PR      the PR changed the failing spec                    -> red, never judged
 *   BROKEN_ON_TRUNK  trunk's latest run fails this test too             -> not the PR's
 *   FLAKY_ON_TRUNK   the test flakes on trunk in the window             -> not the PR's
 *   FLAKY_CROSS_PR   failed on 3+ other PRs while trunk stayed green    -> not the PR's
 *   INSUFFICIENT_DATA / REGRESSION                                      -> ask the judge
 *
 * The judge may unblock a REGRESSION/INSUFFICIENT_DATA finding only with
 * confidence >= min (0.85) AND a citation a reviewer can check (cross-PR
 * recurrence or a diff hunk), or a bug-on-trunk call. Anything short of that
 * stays red. Model outage keeps the rule outcome.
 *
 * Zero dependencies; Node >= 22.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const FAILED_STATUSES = new Set(["failed", "timedOut", "interrupted"]);
export const EXONERATED = new Set(["BROKEN_ON_TRUNK", "FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
// On a trunk run there is no PR to exonerate, so the question changes from "is
// this the PR's fault" to "is this noise or is trunk actually broken". Only
// intermittency answers that. BROKEN_ON_TRUNK deliberately does NOT clear here:
// on trunk it means the failure is still there from last time, and greening a
// standing breakage is how a broken trunk becomes permanent and invisible.
export const EXONERATED_ON_TRUNK = new Set(["FLAKY_ON_TRUNK", "FLAKY_CROSS_PR"]);
export const exoneratedSet = (isTrunkRun) => (isTrunkRun ? EXONERATED_ON_TRUNK : EXONERATED);
export const BORDERLINE = new Set(["REGRESSION", "INSUFFICIENT_DATA"]);
// The history endpoint pages; ask for its maximum page so a busy spec file is a
// handful of requests rather than a hundred, and stop after enough pages that a
// pathological file cannot stall the job.
const HISTORY_MAX_FILES = 50;
const HISTORY_PER_PAGE = 2000;
const HISTORY_MAX_PAGES = 25;
export const DEFAULTS = {
  windowDays: 14,
  minTrunkRuns: 5,
  pMin: 0.05,
  crossPRMinPRs: 3,
  minConfidence: 0.85,
  vetoMin: 0.9,
  maxJudged: 8,
  concurrency: 4,
  infraMinFailures: 30,
  model: "claude-haiku-4-5",
};
const INFRA_RE =
  /server (?:is )?not healthy|ECONNREFUSED|ENOTFOUND|net::ERR_|browser has been closed|browser has disconnected|Target page, context or browser has been closed|StatusRuntimeException: UNAVAILABLE|Failed to launch|Could not connect to|socket hang up|502 Bad Gateway|503 Service|Timed out waiting for the (?:server|app)/i;

export const isInfraError = (text) => INFRA_RE.test(text ?? "");

/**
 * Lane of a run name: the same spec set on the same platform. PR and trunk
 * runs of one lane differ only by producer prefix/suffix
 * (mobile-pr-detox-ios vs mobile-main-detox-ios; playwright-full-enterprise
 * vs playwright-full-enterprise-master). History is compared within a lane:
 * an Android flake says nothing about iOS.
 */
export const laneOf = (name) =>
  String(name ?? "")
    .replace(/^mobile-(pr|main)-/, "")
    .replace(/-(master|main|release(-cut)?)$/, "");

// ---------------------------------------------------------------- history rules

/** Classify one failing test from its history and the PR's changed files. */
export function classify(test, observations, changedFiles, cfg = DEFAULTS, prNumber = null, lane = null, opts = {}) {
  const { isTrunkRun = false, groupId = null } = opts;
  const own = new Set(changedFiles);
  // A run must never be part of its own history. On a PR run its group carries
  // the PR number and drops out below, but on a trunk run it would land in
  // `trunk` and the test would be reported as failing on trunk because of the
  // very run being judged.
  const seen = groupId == null ? observations : observations.filter((o) => o.group_id !== groupId);
  const inLane = lane == null ? seen : seen.filter((o) => o.name == null || laneOf(o.name) === lane);
  // PR numbers arrive as numbers from TSIO but as strings from a composite
  // identity built with jq, so compare them as numbers. A strict mismatch would
  // file this PR's own runs under "other PRs", where enough of them satisfy
  // FLAKY_CROSS_PR and clear a failure on the strength of its own history.
  const prOf = (o) => (o.gh_pr_number == null || o.gh_pr_number === "" ? null : Number(o.gh_pr_number));
  const currentPR = prNumber == null ? null : Number(prNumber);
  const trunk = inLane.filter((o) => prOf(o) == null);
  const others = inLane.filter((o) => prOf(o) != null && prOf(o) !== currentPR);
  const trunkFails = trunk.filter((o) => FAILED_STATUSES.has(o.status)).length;
  const trunkFlaky = trunk.filter((o) => o.status === "flaky").length;
  const trunkPasses = trunk.filter((o) => o.status === "passed").length;
  const latestTrunk = trunk[0];
  const failedPRs = [...new Set(others.filter((o) => FAILED_STATUSES.has(o.status)).map(prOf))];
  const otherPasses = others.filter((o) => o.status === "passed" || o.status === "flaky").length;
  const stats = {
    trunk: { runs: trunk.length, fails: trunkFails, flaky: trunkFlaky, passes: trunkPasses, latest: latestTrunk?.status ?? "" },
    cross_pr: {
      prs: failedPRs,
      examples: others
        .filter((o) => FAILED_STATUSES.has(o.status))
        .filter((o, i, all) => all.findIndex((x) => prOf(x) === prOf(o)) === i)
        .slice(0, 12)
        .map((o) => `PR ${prOf(o)} (${o.commit_sha?.slice(0, 7) ?? "unknown"}, ${o.created_at?.slice(5, 10) ?? "?"})`),
      passes: otherPasses,
    },
  };
  const out = (cls, reason, blocking) => ({ ...test, class: cls, reason, blocking, ...stats });
  if (own.has(test.file))
    return out("OWNED_BY_PR", isTrunkRun
      ? `This commit changes ${test.file}; a failure in a spec the commit edits is not noise.`
      : `This PR changes ${test.file}; a failure in a spec the PR edits is the PR's to explain.`, true);
  // Trunk runs answer a different question, so they get their own order: a
  // failure that was already there last time is a streak, not a flake, and stays
  // red however often it has flaked before.
  if (isTrunkRun) {
    if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status))
      return out("BROKEN_ON_TRUNK", `Still failing: the previous ${lane ?? "trunk"} run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}) failed this test too. That is a streak, not a flake.`, true);
    if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0)
      return out("FLAKY_ON_TRUNK", `Intermittent on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in the previous ${trunk.length} runs, and the last one passed.`, false);
    if (trunk.length < cfg.minTrunkRuns)
      return out("INSUFFICIENT_DATA", `Only ${trunk.length} earlier trunk runs (need ${cfg.minTrunkRuns}); cannot tell a flake from a new break.`, true);
    return out("REGRESSION", `New on trunk: passed in all ${trunk.length} previous runs.`, true);
  }
  if (latestTrunk && FAILED_STATUSES.has(latestTrunk.status))
    return out("BROKEN_ON_TRUNK", `Trunk's latest run (${latestTrunk.commit_sha?.slice(0, 7) ?? "unknown"}, ${latestTrunk.created_at?.slice(0, 10) ?? "unknown date"}) fails this test too.`, false);
  const laplace = (trunkFails + trunkFlaky + 1) / (trunk.length + 2);
  if (trunk.length >= cfg.minTrunkRuns && trunkFails + trunkFlaky > 0 && laplace >= cfg.pMin && latestTrunk?.status !== "failed")
    return out("FLAKY_ON_TRUNK", `Unstable on trunk: ${trunkFails} failures and ${trunkFlaky} flaky passes in ${trunk.length} runs over ${cfg.windowDays} days.`, false);
  if (failedPRs.length >= cfg.crossPRMinPRs && trunkFails === 0 && (trunkPasses > 0 || otherPasses > 0))
    return out("FLAKY_CROSS_PR", `Failed on ${failedPRs.length} other PRs in ${cfg.windowDays} days (${stats.cross_pr.examples.slice(0, 3).join(", ")}) while trunk stayed green.`, false);
  if (trunk.length < cfg.minTrunkRuns)
    return out("INSUFFICIENT_DATA", `Only ${trunk.length} trunk runs in ${cfg.windowDays} days (need ${cfg.minTrunkRuns}); history cannot clear it.`, true);
  return out("REGRESSION", `Fails here, passes on trunk (${trunkPasses}/${trunk.length}) and was not failing on other PRs enough to call it flaky (${failedPRs.length}).`, true);
}

/** Run-level infrastructure call: many failures, or most failures share an infra signature. */
export function infraVerdict(failing, cfg = DEFAULTS) {
  if (!failing.length) return null;
  const infra = failing.filter((t) => isInfraError(t.error)).length;
  if (infra >= Math.max(3, Math.ceil(failing.length / 2)))
    return `${infra} of ${failing.length} failures are infrastructure errors (server health, connectivity, device); rerun when the environment recovers.`;
  if (failing.length >= cfg.infraMinFailures)
    return `${failing.length} tests failed in one run; that is an environment or build problem, not a set of individual test failures.`;
  return null;
}

// ------------------------------------------------------------------- the judge

export const SYSTEM = `You are the second judge in an automated CI triage system for end-to-end test failures on pull requests.
A deterministic engine has already classified each failing test from statistics (trunk history, other PRs' history,
file ownership). You adjudicate ONE finding at a time using the evidence pack and answer a single question:
what caused this test to fail on this PR run?

Causes:
- caused_by_pr: the PR's code change plausibly produces this failure (the error is about behavior, selectors, data or
  flows the diff touches; or the failing test/helper is modified by the PR).
- flaky_environment: the failure is environmental or timing-related and unrelated to the diff (server/API health,
  device or emulator problems, timeouts waiting for UI that the PR does not touch, the same failure recurring on
  unrelated PRs). This includes failures that also occurred on other PRs the author had nothing to do with.
- bug_on_master: the same failure already occurs on the trunk branch (master/main) before this PR, so the PR inherits it.
- test_bug: the test itself is wrong or brittle in a way the PR did not introduce (stale assertion, race in the test).

Rules:
- Cite only evidence items by their id from the pack. Never invent PR numbers, files or errors.
- caused_by_pr requires a concrete link between the error and the diff: name the changed file or hunk that explains it.
  A PR touching many files is not by itself evidence; a PR touching the failing spec, a helper in the stack, or the
  feature under test is.
- flaky_environment with high confidence requires either recurrence on other PRs (evidence id starting with cross_pr)
  or an error text that is clearly infrastructural (server not healthy, cannot connect, device/emulator failure, app crash on
  launch) together with a diff that does not touch that area.
- If the evidence is genuinely insufficient, answer with confidence below 0.6 rather than guessing.
- Be precise and terse in the explanation: one paragraph a developer can act on.`;

export const SCHEMA = {
  type: "object",
  properties: {
    cause: { type: "string", enum: ["caused_by_pr", "flaky_environment", "bug_on_master", "test_bug"] },
    confidence: { type: "number", description: "0 to 1" },
    cited_evidence: { type: "array", items: { type: "string" }, description: "up to 6 evidence ids from the pack" },
    explanation: { type: "string", description: "one short paragraph a developer can act on" },
  },
  required: ["cause", "confidence", "cited_evidence", "explanation"],
  additionalProperties: false,
};

/** Evidence pack for one finding: what the judge sees, and nothing else. */
export function buildPack(finding, compareFiles, pr, others) {
  const names = compareFiles.map((f) => f.filename);
  const text = `${finding.error}\n${finding.file}`.toLowerCase();
  const small = compareFiles.length <= 8;
  const hunks = [];
  for (const f of compareFiles) {
    const base = f.filename.split("/").pop() ?? "";
    const stem = base.split(".")[0] ?? "";
    const named = f.filename === finding.file || (stem.length > 3 && text.includes(stem.toLowerCase())) || finding.error.includes(base);
    if ((named || small) && f.patch) hunks.push({ id: `hunk_${hunks.length}`, file: f.filename, patch: f.patch.slice(0, named ? 4000 : 2500) });
    if (hunks.length >= 8) break;
  }
  return {
    test: { title: finding.title, file: finding.file, lane: pr.lane },
    error: finding.error.slice(0, 2500),
    engine: { class: finding.class, reason: finding.reason },
    trunk_history_14d: { runs: finding.trunk.runs, fails: finding.trunk.fails, flaky: finding.trunk.flaky, latest: finding.trunk.latest },
    cross_pr_failures_14d: { id: "cross_pr", other_prs_where_this_test_failed: finding.cross_pr.examples, other_pr_runs_where_it_passed: finding.cross_pr.passes },
    pr: { number: pr.number, repository: pr.repository, title: pr.title, changed_file_count: names.length, changed_files: names.slice(0, 200), spec_file_changed_by_pr: names.includes(finding.file) },
    diff_hunks_of_files_named_in_error: hunks,
    other_failures_in_same_run: others.slice(0, 12),
  };
}
export const evidenceIds = (pack) => ["test", "error", "engine", "trunk_history_14d", "cross_pr", "pr.changed_files", ...pack.diff_hunks_of_files_named_in_error.map((h) => h.id)];
export const packKey = (model, pack) => createHash("sha256").update(model + "\n" + JSON.stringify(pack)).digest("hex");

export async function askModel(fetchImpl, apiKey, model, pack, timeoutMs = 60000) {
  const body = {
    model,
    max_tokens: 2000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Evidence pack (JSON). Valid evidence ids to cite: ${evidenceIds(pack).join(", ")}\n\n${JSON.stringify(pack, null, 1)}` }],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, ...(model.startsWith("claude-haiku") ? {} : { effort: "medium" }) },
  };
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    try {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        last = new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) throw last;
        continue;
      }
      const msg = await res.json();
      if (msg.stop_reason !== "end_turn" && msg.stop_reason !== "stop_sequence") throw new Error(`stop_reason=${msg.stop_reason}`);
      return parseAnswer(msg.content?.find((b) => b.type === "text")?.text ?? "");
    } catch (e) {
      last = e;
      if (String(e).startsWith("Error: anthropic 4")) throw e;
    }
  }
  throw last;
}
export function parseAnswer(text) {
  const a = JSON.parse(text);
  if (!SCHEMA.properties.cause.enum.includes(a.cause) || typeof a.confidence !== "number" || !Array.isArray(a.cited_evidence) || typeof a.explanation !== "string")
    throw new Error("answer failed validation");
  return { cause: a.cause, confidence: Math.max(0, Math.min(1, a.confidence)), cited_evidence: a.cited_evidence.map(String).slice(0, 6), explanation: a.explanation.slice(0, 900) };
}

/** The decision matrix: what a judge answer may change. Citations must name evidence in the pack. */
export function decide(cls, answer, pack, cfg = DEFAULTS, isTrunkRun = false) {
  const EXON = exoneratedSet(isTrunkRun);
  if (!answer) return { blocking: !EXON.has(cls), decision: "unavailable", answer: null };
  const known = new Set(evidenceIds(pack));
  const cited = answer.cited_evidence.filter((c) => known.has(c));
  const a = { ...answer, cited_evidence: cited };
  const hunk = cited.some((c) => c.startsWith("hunk_"));
  const cross = cited.includes("cross_pr");
  if (EXON.has(cls)) {
    if (a.cause === "caused_by_pr" && a.confidence >= cfg.vetoMin && hunk) return { blocking: true, decision: "adjudicator_veto", answer: a };
    return { blocking: false, decision: "engine", answer: a };
  }
  if (BORDERLINE.has(cls) && a.cause !== "caused_by_pr" && a.confidence >= cfg.minConfidence && (cross || hunk || a.cause === "bug_on_master"))
    return { blocking: false, decision: "adjudicator_unblock", answer: a };
  return { blocking: !EXON.has(cls), decision: "engine", answer: a };
}

/** Ask the judge about the findings that can still change the outcome; at most cfg.maxJudged, cfg.concurrency at a time. */
export async function judge(findings, packs, ask, cfg = DEFAULTS, warn = () => {}, isTrunkRun = false) {
  const EXON = exoneratedSet(isTrunkRun);
  const queue = findings.map((f, i) => ({ f, pack: packs[i] })).filter((x) => x.pack && (BORDERLINE.has(x.f.class) || EXON.has(x.f.class))).slice(0, cfg.maxJudged);
  const workers = Array.from({ length: cfg.concurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const d = decide(item.f.class, await ask(item.pack), item.pack, cfg, isTrunkRun);
        Object.assign(item.f, { blocking: d.blocking, decision: d.decision, judge: d.answer });
      } catch (e) {
        warn(`judge unavailable for "${item.f.title}": ${String(e).slice(0, 200)}`);
        Object.assign(item.f, { decision: "unavailable" });
      }
    }
  });
  await Promise.all(workers);
  return findings;
}

// ----------------------------------------------------------------- publishing

export function verdictOf(findings, infra) {
  if (infra) return "ACTION_REQUIRED";
  return findings.some((f) => f.blocking) ? "FAILURE" : "SUCCESS";
}
const md = (s) => String(s).replace(/[|<>`]/g, (c) => ({ "|": "&#124;", "<": "&lt;", ">": "&gt;", "`": "&#96;" })[c]).replace(/\r?\n/g, " ");
const CAUSE = { caused_by_pr: "caused by this PR", flaky_environment: "flaky / environment", bug_on_master: "bug on trunk", test_bug: "test bug" };

export function renderComment({ context, verdict, findings, infra, model, runURL, counts }) {
  const lines = [`<!-- e2e-triage:${context} -->`, `## E2E triage: ${verdict}`, ""];
  if (infra) lines.push(`**Infrastructure, not this PR.** ${md(infra)}`, "");
  else if (verdict === "SUCCESS") lines.push(`No failure in this run is attributable to the PR; the required status is green. ${counts.failed} failed test(s) were traced to trunk or to other PRs.`, "");
  else lines.push(`${findings.filter((f) => f.blocking).length} failure(s) could not be cleared and block this PR.`, "");
  if (findings.length) {
    lines.push("| Test | Finding | Trunk (runs / fails / flaky) | Other PRs failing | Why |", "| --- | --- | --- | --- | --- |");
    for (const f of findings)
      lines.push(`| ${md(f.title)} | ${f.blocking ? "🔴" : "🟢"} ${f.class} | ${f.trunk.runs} / ${f.trunk.fails} / ${f.trunk.flaky} | ${f.cross_pr.prs.length} | ${md(f.reason)} |`);
    const judged = findings.filter((f) => f.judge);
    if (judged.length) {
      lines.push("", `### Second judge (${model})`, "");
      for (const f of judged) {
        const mark = f.decision === "adjudicator_unblock" ? "unblocked" : f.decision === "adjudicator_veto" ? "vetoed" : f.blocking ? "still blocking" : "agreed";
        lines.push(`- **${md(f.title)}** — ${CAUSE[f.judge.cause] ?? f.judge.cause} (${Math.round(f.judge.confidence * 100)}%, ${mark}; cites ${f.judge.cited_evidence.join(", ") || "nothing checkable"}): ${md(f.judge.explanation)}`);
      }
    }
  }
  lines.push("", `Run: ${runURL}. A maintainer can still apply the repository's override label; that always wins.`);
  return lines.join("\n");
}
export function statusDescription(verdict, findings, infra, counts) {
  const s = infra ? `Infra: ${infra}` : verdict === "SUCCESS" ? `${counts.failed} failed, none caused by this PR (triage)` : `${findings.filter((f) => f.blocking).length} failure(s) attributable to this PR (triage)`;
  return s.slice(0, 140);
}

// ------------------------------------------------------------------ data access

export async function fetchRun(fetchImpl, base, id) {
  const get = async (path) => {
    const res = await fetchImpl(`${base}/api/v1${path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`TSIO GET ${path}: ${res.status}`);
    return res.json();
  };
  const q = new URLSearchParams({ repository: id.repository, commit: id.commit_sha, name: id.name, limit: "20" });
  const { reports: groups = [] } = await get(`/reports?${q}`);
  const attempt = String(id.gh_run_attempt ?? "");
  const group = groups.find((g) => attempt && String(g.gh_run_attempt) === attempt) ?? groups[0];
  if (!group) throw new Error(`TSIO has no report group for ${id.repository} ${id.commit_sha.slice(0, 7)} ${id.name}`);
  const [{ suites = [] }, cases] = await Promise.all([get(`/reports/${group.id}/suites`), get(`/reports/${group.id}/cases`)]);
  const fileOf = new Map(suites.map((s) => [s.id, s.file_path ?? s.file ?? ""]));
  const byTest = new Map();
  for (const c of cases) {
    const k = `${fileOf.get(c.suite_id) ?? ""}\n${c.title}`;
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k).push(c);
  }
  const failing = [];
  let failed = 0;
  let flaky = 0;
  for (const [k, attempts] of byTest) {
    attempts.sort((a, b) => a.retry_count - b.retry_count || a.ordinal - b.ordinal);
    const last = attempts[attempts.length - 1];
    if (FAILED_STATUSES.has(last.status)) {
      failed++;
      const [file, title] = k.split("\n");
      failing.push({ file, title, error: [last.error_message, last.error_stack].filter(Boolean).join("\n") });
    } else if (last.status === "flaky" || attempts.some((a) => FAILED_STATUSES.has(a.status))) flaky++;
  }
  return { group_id: group.id, failing, counts: { total: byTest.size, failed, flaky } };
}
/**
 * Past executions of the failing tests, as a map keyed `file\ntitle`.
 *
 * TSIO is asked for whole spec files rather than for named tests: a title is
 * reworded far more often than the file it lives in, so a request keyed on the
 * title would lose a test's history the moment somebody fixed a typo in it. The
 * response therefore carries every test in those files and the rows are matched
 * back here, which keeps the matching rule on this side where it can change
 * without a server deploy. The rule today is an exact file and title match, so a
 * renamed test finds nothing, is reported as INSUFFICIENT_DATA and stays
 * blocking, which is the safe direction.
 */
export async function fetchHistory(fetchImpl, base, repository, tests, until, windowDays) {
  const byTest = new Map();
  const files = [...new Set(tests.map((t) => t.file).filter(Boolean))].slice(0, HISTORY_MAX_FILES);
  if (files.length === 0) return byTest;
  const wanted = new Set(tests.map((t) => `${t.file}\n${t.title}`));
  const since = windowDays ? new Date(Date.parse(until) - windowDays * 86400000).toISOString() : undefined;
  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    const body = { repository, until, files, page, per_page: HISTORY_PER_PAGE };
    if (since) body.since = since;
    const res = await fetchImpl(`${base}/api/v1/reports/history`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`TSIO history ${res.status}`);
    const { observations = [], has_more: hasMore } = await res.json();
    for (const o of observations) {
      const k = `${o.file}\n${o.title}`;
      if (!wanted.has(k)) continue;
      if (!byTest.has(k)) byTest.set(k, []);
      byTest.get(k).push(o);
    }
    if (!hasMore) break;
  }
  return byTest;
}
export function gh(fetchImpl, token) {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "mattermost-e2e-triage" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
}

// ------------------------------------------------------------------ the run

export async function triage({ env, fetchImpl = fetch, log = console.error, now = new Date() }) {
  const cfg = { ...DEFAULTS, minConfidence: Number(env.MIN_CONFIDENCE || DEFAULTS.minConfidence), model: env.CLAUDE_MODEL || DEFAULTS.model };
  const id = JSON.parse(env.COMPOSITE_IDENTITY);
  const prNumber = Number(id.gh_pr_number || env.PR_NUMBER || 0) || null;
  // No PR number means this is a trunk run. The question then is not "is this
  // the PR's fault" but "is trunk noisy or actually broken", which changes which
  // findings may clear; see EXONERATED_ON_TRUNK.
  const isTrunkRun = prNumber == null;
  const base = (env.TSIO_BASE_URL || "https://test-io.test.mattermost.com").replace(/\/$/, "");
  const api = gh(fetchImpl, env.GITHUB_TOKEN);
  const run = await fetchRun(fetchImpl, base, id);
  const result = { verdict: "SUCCESS", findings: [], infra: null, counts: run.counts };
  if (run.failing.length) {
    result.infra = infraVerdict(run.failing, cfg);
    if (!result.infra) {
      const [history, compare, pull] = await Promise.all([
        fetchHistory(fetchImpl, base, id.repository, run.failing, now.toISOString(), cfg.windowDays),
        env.BASE_REF ? api("GET", `/repos/${id.repository}/compare/${encodeURIComponent(env.BASE_REF)}...${id.commit_sha}?per_page=100`).catch((e) => (log(String(e)), { files: [] })) : { files: [] },
        prNumber ? api("GET", `/repos/${id.repository}/pulls/${prNumber}`).catch(() => ({})) : {},
      ]);
      const files = (compare.files ?? []).map((f) => ({ filename: f.filename, patch: f.patch }));
      const changed = files.map((f) => f.filename);
      result.findings = run.failing.map((t) => classify(t, history.get(`${t.file}\n${t.title}`) ?? [], changed, cfg, prNumber, laneOf(id.name), { isTrunkRun, groupId: run.group_id }));
      if (env.ANTHROPIC_API_KEY && prNumber) {
        const others = result.findings.map((f) => ({ class: f.class, title: f.title.slice(0, 80) }));
        const pr = { number: prNumber, repository: id.repository, title: pull.title ?? "", lane: env.LANE || id.name };
        const packs = result.findings.map((f) => (f.class === "OWNED_BY_PR" ? null : buildPack(f, files, pr, others)));
        await judge(result.findings, packs, (pack) => askModel(fetchImpl, env.ANTHROPIC_API_KEY, cfg.model, pack), cfg, log, isTrunkRun);
      }
    }
  }
  result.verdict = verdictOf(result.findings, result.infra);
  const context = env.STATUS_CONTEXT;
  const runURL = `https://github.com/${id.repository}/actions/runs/${id.gh_run_id}`;
  const comment = renderComment({ context, verdict: result.verdict, findings: result.findings, infra: result.infra, model: cfg.model, runURL, counts: run.counts });
  const description = statusDescription(result.verdict, result.findings, result.infra, run.counts);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `verdict=${result.verdict}\nblocking=${result.findings.filter((f) => f.blocking).length}\nexonerated=${result.findings.filter((f) => !f.blocking).length}\ndescription=${description}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, comment + "\n");
  const enforce = (env.MODE || "enforce") === "enforce";
  if (prNumber && (run.failing.length || env.ALWAYS_COMMENT === "true")) {
    const marker = `<!-- e2e-triage:${context} -->`;
    // Comments come back oldest first, 100 to a page. On a long-running PR the
    // sticky comment is not on the first page, and failing to find it posts a
    // second one on every run instead of updating the one already there.
    let mine = null;
    for (let page = 1; page <= 20 && !mine; page++) {
      const comments = await api("GET", `/repos/${id.repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
      mine = comments.find((c) => c.body?.startsWith(marker)) ?? null;
      if (comments.length < 100) break;
    }
    if (mine) await api("PATCH", `/repos/${id.repository}/issues/comments/${mine.id}`, { body: comment });
    else await api("POST", `/repos/${id.repository}/issues/${prNumber}/comments`, { body: comment });
  }
  if (enforce && context) {
    await api("POST", `/repos/${id.repository}/statuses/${id.commit_sha}`, {
      state: result.verdict === "SUCCESS" ? "success" : "failure",
      context,
      description,
      target_url: runURL,
    });
  }
  log(`e2e-triage: ${result.verdict} (${run.counts.failed} failed, ${result.findings.filter((f) => f.blocking).length} blocking)${enforce ? "" : " [report-only]"}`);
  return result;
}

// ------------------------------------------------------------------- replay

/**
 * Score the rules and the judge against labeled historical runs without
 * posting anything. runs.json rows: {repository, pr, name, commit_sha, branch,
 * run_at, truth, base_ref}. Judge answers come from --answers (a JSON map of
 * "pr|name|sha7|title" -> answer) when no ANTHROPIC_API_KEY is set; with a key,
 * missing answers are asked and cached back into that file.
 */
export async function replay({ runsPath, answersPath, comparePath, base, outPath, env = process.env, fetchImpl = fetch, log = console.error }) {
  const runs = JSON.parse(readFileSync(runsPath, "utf8"));
  const answers = answersPath && existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, "utf8")) : {};
  const compares = comparePath ? JSON.parse(readFileSync(comparePath, "utf8")) : {};
  const cfg = { ...DEFAULTS, model: env.CLAUDE_MODEL || DEFAULTS.model };
  const results = [];
  for (const [i, r] of runs.entries()) {
    const id = { repository: r.repository, branch: r.branch, commit_sha: r.commit_sha, name: r.name };
    let run;
    try {
      run = await fetchRun(fetchImpl, base, id);
    } catch (e) {
      log(`[${i + 1}/${runs.length}] ${r.pr} ${r.name} ${r.commit_sha.slice(0, 7)}: ${e}`);
      continue;
    }
    const infra = infraVerdict(run.failing, cfg);
    let findings = [];
    if (run.failing.length && !infra) {
      const until = new Date(Date.parse(r.run_at) + 5 * 60000).toISOString();
      const history = await fetchHistory(fetchImpl, base, r.repository, run.failing, until, cfg.windowDays);
      const cmp = compares[`${r.repository}:${r.commit_sha}`] ?? compares[`${r.repository}:${r.commit_sha.slice(0, 7)}`] ?? {};
      const files = (cmp.files ?? []).map((f) => ({ filename: f.filename, patch: f.patch }));
      findings = run.failing.map((t) => classify(t, history.get(`${t.file}\n${t.title}`) ?? [], files.map((f) => f.filename), cfg, r.pr, laneOf(r.name)));
      const others = findings.map((f) => ({ class: f.class, title: f.title.slice(0, 80) }));
      const pr = { number: r.pr, repository: r.repository, title: cmp.pr_title ?? "", lane: r.name };
      const packs = findings.map((f) => (f.class === "OWNED_BY_PR" ? null : buildPack(f, files, pr, others)));
      const key = (f) => `${r.pr}|${r.name}|${r.commit_sha.slice(0, 7)}|${f.title}`;
      await judge(
        findings,
        packs,
        async (pack) => {
          const f = findings.find((x) => x.title === pack.test.title);
          const k = key(f);
          // Labeled data may carry titles truncated to 120 characters.
          const cached = answers[k] ?? answers[`${r.pr}|${r.name}|${r.commit_sha.slice(0, 7)}|${f.title.slice(0, 120)}`];
          if (cached) return cached;
          if (!env.ANTHROPIC_API_KEY) throw new Error("no cached answer");
          const a = await askModel(fetchImpl, env.ANTHROPIC_API_KEY, cfg.model, pack);
          answers[k] = a;
          if (answersPath) writeFileSync(answersPath, JSON.stringify(answers, null, 1));
          return a;
        },
        cfg,
        () => {},
      );
    }
    const verdict = verdictOf(findings, infra);
    results.push({ ...r, verdict, infra: Boolean(infra), classes: findings.map((f) => f.class), decisions: findings.map((f) => ({ title: f.title, class: f.class, blocking: f.blocking, decision: f.decision ?? "engine", judge: f.judge ?? null })) });
    log(`[${i + 1}/${runs.length}] PR ${r.pr} ${r.name} ${r.commit_sha.slice(0, 7)} ${r.truth}: ${verdict} ${findings.map((f) => f.class).join(",")}`);
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1));
  const truths = [...new Set(results.map((r) => r.truth))].sort();
  const table = ["| Ground truth | runs | green |", "|---|---|---|"];
  for (const t of truths) {
    const rs = results.filter((r) => r.truth === t);
    table.push(`| ${t} | ${rs.length} | ${rs.filter((r) => r.verdict === "SUCCESS").length} |`);
  }
  console.log(table.join("\n"));
  return results;
}

// --------------------------------------------------------------------- main

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const main = args.includes("--replay")
    ? replay({ runsPath: opt("replay"), answersPath: opt("answers"), comparePath: opt("compare"), base: opt("tsio") ?? "http://localhost:8080", outPath: opt("out") })
    : triage({ env: process.env });
  main.catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
