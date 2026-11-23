// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// The machine-readable findings file (FINDINGS_FILE): what triage decided for each failed test, so the accuracy of its
// answers can be measured. Written after every run, judged or not. It never carries a secret or a full stack.

import { writeFileSync } from "node:fs";
import type { Env } from "../../shared/src/github.ts";
import { isFailedTry } from "../../shared/src/tsio.ts";
import type { RunResult } from "../../shared/src/tsio.ts";
import type { EvaluatedRun } from "./evaluate.ts";
import { statusLabelOf } from "./render.ts";
import { ledgerTotals, newLedger } from "./pricing.ts";
import type { TriageIdentity } from "./triage.ts";
import type { Counts, Finding } from "./types.ts";

/** The schema version. A consumer checks it before it reads any other field. */
// 2: each row has its check label, and the model's explanation.
export const FINDINGS_SCHEMA = 2 as const;

/** One failed test: the decision, the facts it rests on, and the model's part when it was asked. */
export interface FindingRow {
  title: string;
  full_title: string | null;
  file: string;
  class: string;
  /** The label the check counts it under (see statusLabelOf): "flaky", "test bug", "app bug", "out of date"... */
  label: string;
  blocking: boolean;
  decision: string | null;
  reason: string;
  error_first_line: string;
  out_of_date: boolean;
  tries: { ran: number; failed: number } | null;
  other_lanes_failed: string[];
  ai: { cause: string | null; confidence: number | null; cited: string[]; cleared: boolean; explanation: string | null };
}

/** The whole file. A run that was not triaged has no verdict or findings, and says why in not_triaged_reason. */
export interface FindingsRecord {
  schema: typeof FINDINGS_SCHEMA;
  repository: string | null;
  commit_sha: string | null;
  pr: number | null;
  lane: string | null;
  status_context: string | null;
  run_id: string | null;
  run_attempt: string | null;
  mode: "enforce" | "report-only";
  verdict: string | null;
  counts: Counts | null;
  ai: { calls: number; cost_usd: number | null; model: string | null };
  triaged: boolean;
  not_triaged_reason: string | null;
  findings: FindingRow[];
}

/** What the file is written from. `notTriaged` is the reason when triage did not finish; null when it did. */
export interface FindingsFacts {
  env: Env;
  id: TriageIdentity | null;
  mode: "enforce" | "report-only";
  run: RunResult | null;
  result: EvaluatedRun | null;
  notTriaged: string | null;
}

const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-ant-[A-Za-z0-9_-]{8,}/g, /\bBearer\s+[^\s"']+/gi];
const ANSI = /\x1b\[[0-9;]*m/g;

// A credential-named key and its value: "token=…", "password: …", "Authorization: Bearer …", in any case. The key may carry a
// prefix or suffix (github_token). Ordinary words that only contain a credential's letters, with no "=" or ":", are kept.
const CREDENTIAL_KV = /([A-Za-z0-9_.-]*(?:token|password|secret|passwd|api[_-]?key|apikey|license|authorization)[A-Za-z0-9_.-]*)(\s*[=:]\s*)((?:Bearer\s+)?[^\s"',;&]+)/gi;

/**
 * The text with the action's own secrets, token-shaped strings, URL query strings, and the values of credential-named keys
 * replaced. A URL keeps its address and loses its query, which can carry a code or a state.
 */
export function redact(text: string, secrets: string[]): string {
  let out = String(text);
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  out = out.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
    const q = url.indexOf("?");
    return q < 0 ? url : `${url.slice(0, q)}?[redacted]`;
  });
  out = out.replace(CREDENTIAL_KV, "$1$2[redacted]");
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
/** The first line of an error, without colour codes, at most 200 characters. Never the stack. */
const firstLine = (error: string | null | undefined): string => {
  const line = String(error ?? "").replace(ANSI, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return clip(line.trim(), 200);
};

function rowOf(f: Finding, secrets: string[]): FindingRow {
  const judge = f.judge ?? null;
  return {
    title: redact(f.title, secrets),
    full_title: f.full_title ? redact(f.full_title, secrets) : null,
    file: redact(f.repo_path ?? f.file, secrets),
    class: f.class,
    label: statusLabelOf(f),
    blocking: f.blocking,
    decision: f.decision ?? null,
    reason: clip(redact(f.reason ?? "", secrets), 300),
    error_first_line: redact(firstLine(f.error), secrets),
    out_of_date: Boolean(f.out_of_date),
    tries: f.tries ? { ran: f.tries.ran, failed: f.tries.failed } : null,
    other_lanes_failed: (f.other_lanes ?? []).filter((o) => isFailedTry(o.result)).map((o) => o.platform),
    ai: { cause: judge?.cause ?? null, confidence: judge?.confidence ?? null, cited: judge?.cited_evidence ?? [], cleared: f.decision === "adjudicator_unblock", explanation: judge ? clip(redact(judge.explanation, secrets), 200) : null },
  };
}

/**
 * One finding as one step-log line: blocking or cleared, its class and decision, the model's cause and confidence and the
 * evidence it cited (- when it was not asked), then the test and the reason. The step log is the one record every run keeps.
 */
export function findingLogLine(f: Finding, n: number, of: number, secrets: string[]): string {
  const row = rowOf(f, secrets);
  const ai = row.ai.cause ? `${row.ai.cause}@${row.ai.confidence ?? "?"}` : "-";
  const cited = row.ai.cited.length ? row.ai.cited.join(",") : "-";
  const line = `e2e-test-triage: finding ${n}/${of} ${row.blocking ? "blocking" : "cleared"} ${row.class} decision=${row.decision ?? "-"} ai=${ai} cited=${cited} "${clip(row.title, 120)}" · ${clip(row.file, 100)}: ${row.reason}`;
  return clip(line.replace(/\s+/g, " "), 500);
}

/** The action's own secrets, as set in the environment: what the summary and the findings file must never print. */
export const secretsOf = (env: Env): string[] => [env.GITHUB_TOKEN, env.ANTHROPIC_API_KEY].filter((s): s is string => Boolean(s));

/** The findings file's contents for one run. */
export function findingsRecord({ env, id, mode, run, result, notTriaged }: FindingsFacts): FindingsRecord {
  const secrets = secretsOf(env);
  const ai = result?.ai ?? newLedger();
  const spend = ledgerTotals(ai);
  const served = [...new Set(ai.calls.map((c) => c.served_model))];
  const text = (v: unknown): string | null => (v == null || String(v) === "" ? null : String(v));
  return {
    schema: FINDINGS_SCHEMA,
    repository: text(id?.repository),
    commit_sha: text(id?.commit_sha),
    pr: Number(id?.gh_pr_number || 0) || null,
    lane: text(env.LANE) ?? text(id?.name),
    status_context: text(env.STATUS_CONTEXT),
    run_id: text(id?.gh_run_id),
    run_attempt: text(id?.gh_run_attempt),
    mode,
    verdict: result?.verdict ?? null,
    counts: run?.counts ?? null,
    ai: { calls: spend.calls, cost_usd: spend.cost_usd, model: served.length ? served.join(", ") : null },
    triaged: notTriaged == null,
    not_triaged_reason: notTriaged == null ? null : redact(notTriaged, secrets),
    findings: (result?.findings ?? []).map((f) => rowOf(f, secrets)),
  };
}

/** Writes the findings file when FINDINGS_FILE names one. A file that cannot be written is logged; the run's result stands. */
export function writeFindings(facts: FindingsFacts, log: (message: string) => void): void {
  const path = facts.env.FINDINGS_FILE;
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify(findingsRecord(facts), null, 2)}\n`);
  } catch (e) {
    log(`findings file not written: ${String(e).slice(0, 160)}`);
  }
}

const TOP_KEYS = ["schema", "repository", "commit_sha", "pr", "lane", "status_context", "run_id", "run_attempt", "mode", "verdict", "counts", "ai", "triaged", "not_triaged_reason", "findings"];
const ROW_KEYS = ["title", "full_title", "file", "class", "label", "blocking", "decision", "reason", "error_first_line", "out_of_date", "tries", "other_lanes_failed", "ai"];
const COUNT_KEYS = ["total", "passed", "failed", "flaky", "skipped"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const orNull = (ok: (v: unknown) => boolean) => (v: unknown): boolean => v === null || ok(v);
const isStrs = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);

/** The fields of an object, exactly: none missing, none unnamed. */
function exactKeys(o: Record<string, unknown>, keys: string[], where: string, problems: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${where}: unknown field ${k}`);
  for (const k of keys) if (!(k in o)) problems.push(`${where}: missing field ${k}`);
}

/** What in a findings record does not match the schema; an empty list means it does. */
export function checkFindingsShape(value: unknown): string[] {
  if (!isObj(value)) return ["record: not an object"];
  const problems: string[] = [];
  const need = (ok: boolean, what: string): void => {
    if (!ok) problems.push(what);
  };
  exactKeys(value, TOP_KEYS, "record", problems);
  need(value.schema === FINDINGS_SCHEMA, `schema: must be ${FINDINGS_SCHEMA}`);
  for (const k of ["repository", "commit_sha", "lane", "status_context", "run_id", "run_attempt", "verdict", "not_triaged_reason"]) need(orNull(isStr)(value[k]), `${k}: string or null`);
  need(orNull(isNum)(value.pr), "pr: number or null");
  need(value.mode === "enforce" || value.mode === "report-only", "mode: enforce or report-only");
  const counts = value.counts;
  need(counts === null || (isObj(counts) && COUNT_KEYS.every((k) => isNum(counts[k]))), "counts: the five test counts, or null");
  const ai = value.ai;
  if (isObj(ai)) {
    exactKeys(ai, ["calls", "cost_usd", "model"], "ai", problems);
    need(isNum(ai.calls), "ai.calls: number");
    need(orNull(isNum)(ai.cost_usd), "ai.cost_usd: number or null");
    need(orNull(isStr)(ai.model), "ai.model: string or null");
  } else problems.push("ai: not an object");
  need(isBool(value.triaged), "triaged: boolean");
  need(value.triaged === (value.not_triaged_reason === null), "triaged: true exactly when not_triaged_reason is null");
  need(value.triaged !== true || isStr(value.verdict), "triaged: a triaged run has its verdict");
  if (!Array.isArray(value.findings)) problems.push("findings: array");
  const rows: unknown[] = Array.isArray(value.findings) ? value.findings : [];
  rows.forEach((row, i) => {
    const where = `findings[${i}]`;
    if (!isObj(row)) {
      problems.push(`${where}: not an object`);
      return;
    }
    exactKeys(row, ROW_KEYS, where, problems);
    need(isStr(row.title) && orNull(isStr)(row.full_title) && isStr(row.file) && isStr(row.class) && isStr(row.label), `${where}: names`);
    need(isBool(row.blocking) && isBool(row.out_of_date), `${where}: blocking and out_of_date are booleans`);
    need(orNull(isStr)(row.decision) && isStr(row.reason), `${where}: decision and reason`);
    need(isStr(row.error_first_line) && !row.error_first_line.includes("\n") && row.error_first_line.length <= 200, `${where}: error_first_line is one line of at most 200 characters`);
    need(row.tries === null || (isObj(row.tries) && isNum(row.tries.ran) && isNum(row.tries.failed)), `${where}: tries`);
    need(isStrs(row.other_lanes_failed), `${where}: other_lanes_failed is a list of platforms`);
    const a = row.ai;
    if (isObj(a)) {
      exactKeys(a, ["cause", "confidence", "cited", "cleared", "explanation"], `${where}.ai`, problems);
      need(orNull(isStr)(a.cause) && orNull(isNum)(a.confidence) && isStrs(a.cited) && isBool(a.cleared) && orNull(isStr)(a.explanation), `${where}.ai: cause, confidence, cited, cleared, explanation`);
    } else problems.push(`${where}.ai: not an object`);
  });
  return problems;
}
