// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gh } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { laneSummary } from "../../shared/src/lane.ts";
import type { LaneSummary } from "../../shared/src/lane.ts";
import { statusPublisher } from "../../shared/src/status.ts";
import { compositeIdentityFrom } from "../../shared/src/tsio.ts";
import { FINDINGS_SCHEMA, redact, secretsOf } from "./findings.ts";
import type { FindingsRecord, LaneDiagnosisSummary, RerunSummary } from "./findings.ts";

export type RecommendedAction = "merge_base" | "fix_pr" | "fix_test" | "rerun" | "investigate";

export interface ConsolidatedLane {
  lane: string;
  status_context: string |Partial<FindingsRecord> | null;
  verdict: string | null;
  basis: string | null;
  description: string | null;
  triaged: boolean;
  not_triaged_reason: string | null;
  blocking: number;
  exonerated: number;
  lane_diagnosis: LaneDiagnosisSummary | null;
  rerun: RerunSummary | null;
}

export interface ConsolidatedBlockingItem {
  lane: string;
  kind: "test" | "lane";
  title: string;
  file: string | null;
  label: string;
  recommended_action: RecommendedAction;
  error_first_line: string;
  ai_explanation: string | null;
  ai_confidence: number | null;
  cited: string[];
}

export interface TriageSummary {
  schema: 1;
  overall_state: string;
  overall_description: string;
  totals: { lanes: number; failing_lanes: number; blocking: number; exonerated: number; ai_calls: number; ai_cost_usd: number | null };
  lanes: ConsolidatedLane[];
  blocking_items: ConsolidatedBlockingItem[];
}

export interface ConsolidateOptions {
  env: Env;
  fetchImpl?: FetchImpl;
  log?: (message: string) => void;
  retryWait?: Sleep;
}

const mdCell = (s: unknown): string => String(s ?? "").replace(/[|<>`]/g, "\\$&").replace(/\r?\n/g, " ");

export function recommendedAction(label: string, fault: string | null, rerunRequested: boolean): RecommendedAction {
  if (label === "out of date" || label === "fixed on main") return "merge_base";
  if (label === "caused by PR" || label === "app bug") return "fix_pr";
  if (label === "test bug") return "fix_test";
  if (label === "machine failure" || fault === "infrastructure" || rerunRequested) return "rerun";
  return "investigate";
}

/** Reads FINDINGS_SCHEMA FindingsRecord files recursively from `dir`, sorted by lane name. */
export function loadFindingsDir(dir: string | undefined, log: (message: string) => void = console.warn): FindingsRecord[] {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath ?? (entry as { path?: string }).path ?? dir, entry.name))
    .sort();
  const out: FindingsRecord[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<FindingsRecord> | null;
      if (parsed?.schema === FINDINGS_SCHEMA && typeof parsed.lane === "string" && Array.isArray(parsed.findings)) {
        out.push(parsed as FindingsRecord);
      } else {
        log(`e2e-test-triage consolidate: skipped non-findings JSON ${file}`);
      }
    } catch (e) {
      log(`e2e-test-triage consolidate: failed reading ${file}: ${String(e).slice(0, 160)}`);
    }
  }
  return out.sort((a, b) => String(a.lane ?? "").localeCompare(String(b.lane ?? "")));
}

/** Combines per-lane findings and optional aggregate status into one Human + Agent summary structure. */
export function buildTriageSummary(records: FindingsRecord[], aggregate: LaneSummary | null, secrets: string[] = []): TriageSummary {
  let blockingTotal = 0;
  let exoneratedTotal = 0;
  let aiCalls = 0;
  let aiCost = 0;
  let costUnknown = false;
  let failingLanes = 0;
  const lanes: ConsolidatedLane[] = [];
  const blockingItems: ConsolidatedBlockingItem[] = [];

  for (const r of records) {
    const lane = r.lane ?? "unknown";
    const superseded = !r.triaged && Boolean(r.not_triaged_reason?.startsWith("superseded:"));
    const findings = r.findings ?? [];
    const blockingRows = findings.filter((f) => f.blocking);
    const laneCleared = findings.filter((f) => !f.blocking).length;
    const laneFailed = !superseded && (!r.triaged || blockingRows.length > 0 || Boolean(r.verdict && r.verdict !== "SUCCESS"));
    const laneBlocked = superseded ? 0 : blockingRows.length > 0 ? blockingRows.length : !r.triaged || (r.verdict && r.verdict !== "SUCCESS") ? 1 : 0;
    if (laneFailed) failingLanes++;
    blockingTotal += laneBlocked;
    exoneratedTotal += laneCleared;
    aiCalls += r.ai?.calls ?? 0;
    if (r.ai?.calls && r.ai.cost_usd == null) costUnknown = true;
    else aiCost += r.ai?.cost_usd ?? 0;

    const cleanDiag = r.lane_diagnosis
      ? {
          label: redact(r.lane_diagnosis.label, secrets),
          fault: redact(r.lane_diagnosis.fault, secrets),
          what: redact(r.lane_diagnosis.what, secrets),
          action: redact(r.lane_diagnosis.action, secrets),
        }
      : null;
    const cleanRerun = r.rerun
      ? { requested: Boolean(r.rerun.requested), of: r.rerun.of ?? null, held: r.rerun.held ? redact(r.rerun.held, secrets) : null }
      : null;

    lanes.push({
      lane,
      status_context: r.status_context ?? null,
      verdict: r.verdict ?? null,
      basis: r.basis ?? null,
      description: r.description ? redact(r.description, secrets) : null,
      triaged: Boolean(r.triaged),
      not_triaged_reason: r.not_triaged_reason ? redact(r.not_triaged_reason, secrets) : null,
      blocking: laneBlocked,
      exonerated: laneCleared,
      lane_diagnosis: cleanDiag,
      rerun: cleanRerun,
    });

    for (const f of blockingRows) {
      blockingItems.push({
        lane,
        kind: "test",
        title: redact(f.full_title ?? f.title, secrets),
        file: f.file ? redact(f.file, secrets) : null,
        label: f.label,
        recommended_action: recommendedAction(f.label, null, Boolean(r.rerun?.requested)),
        error_first_line: redact(f.error_first_line ?? "", secrets),
        ai_explanation: f.ai?.explanation ? redact(f.ai.explanation, secrets) : null,
        ai_confidence: f.ai?.confidence ?? null,
        cited: f.ai?.cited ?? [],
      });
    }

    if (blockingRows.length === 0 && laneFailed) {
      blockingItems.push({
        lane,
        kind: "lane",
        title: redact(cleanDiag ? cleanDiag.label : r.not_triaged_reason ?? "lane failed", secrets),
        file: null,
        label: cleanDiag?.label ?? (r.triaged ? "needs investigation" : "not triaged"),
        recommended_action: recommendedAction(cleanDiag?.label ?? "", cleanDiag?.fault ?? null, Boolean(r.rerun?.requested)),
        error_first_line: redact(cleanDiag?.what || r.description || r.not_triaged_reason || "", secrets),
        ai_explanation: cleanDiag?.action ?? null,
        ai_confidence: null,
        cited: [],
      });
    }
  }

  const derivedState =
    records.length === 0
      ? "error"
      : failingLanes > 0 || blockingTotal > 0
        ? "failure"
        : "success";
  const derivedDesc =
    records.length === 0
      ? "No triage findings available"
      : failingLanes > 0
        ? `${failingLanes} lane(s) blocking (${blockingTotal} issue(s))`
        : `All ${records.length} triaged lane(s) cleared (${exoneratedTotal} cleared)`;

  return {
    schema: 1,
    overall_state: aggregate?.state ?? derivedState,
    overall_description: redact(aggregate?.description ?? derivedDesc, secrets),
    totals: { lanes: records.length, failing_lanes: failingLanes, blocking: blockingTotal, exonerated: exoneratedTotal, ai_calls: aiCalls, ai_cost_usd: costUnknown ? null : Number(aiCost.toFixed(6)) },
    lanes,
    blocking_items: blockingItems,
  };
}

/** Renders Human Summary table + compact Agent Fix Brief Markdown for GITHUB_STEP_SUMMARY. */
export function renderTriageSummaryMarkdown(summary: TriageSummary): string {
  const icon = summary.overall_state === "success" ? "✅" : summary.overall_state === "pending" ? "⏳" : "❌";
  const cost = summary.totals.ai_cost_usd == null ? "unknown" : `$${summary.totals.ai_cost_usd.toFixed(4)}`;
  const lines = [
    `## ${icon} E2E Triage Consolidated Summary`,
    "",
    `**Status:** \`${summary.overall_state}\` — ${mdCell(summary.overall_description)}`,
    `**Totals:** ${summary.totals.lanes} lane(s) triaged · ${summary.totals.blocking} blocking · ${summary.totals.exonerated} cleared · AI calls: ${summary.totals.ai_calls} (${cost})`,
  ];
  if (summary.lanes.length) {
    lines.push("", "| Lane | Verdict | Blocking | Cleared | Cause / Summary |", "|---|---|---:|---:|---|");
    for (const l of summary.lanes) {
      const verdict = l.triaged ? l.verdict ?? "—" : `not triaged`;
      const cause = l.description ?? l.lane_diagnosis?.what ?? l.not_triaged_reason ?? "—";
      lines.push(`| ${mdCell(l.lane)} | ${mdCell(verdict)} | ${l.blocking} | ${l.exonerated} | ${mdCell(cause)} |`);
    }
  }
  if (summary.blocking_items.length) {
    lines.push("", "### Agent Fix Brief", "");
    for (const item of summary.blocking_items) {
      const loc = item.file ? ` (${mdCell(item.file)})` : "";
      const why = item.ai_explanation ? ` — ${mdCell(item.ai_explanation)}` : "";
      const err = item.error_first_line ? ` \`${mdCell(item.error_first_line.slice(0, 140))}\`` : "";
      lines.push(`- **[${item.recommended_action}]** \`${mdCell(item.lane)}\` · ${mdCell(item.label)} · ${mdCell(item.title)}${loc}${err}${why}`);
    }
  }
  return lines.join("\n");
}

/** Settles the optional aggregate commit status and writes Human + Agent consolidated summaries. */
export async function consolidate({ env, fetchImpl = fetch, log = console.error, retryWait }: ConsolidateOptions): Promise<TriageSummary | null> {
  if (env.CANCELLED === "true") return null;
  const secrets = secretsOf(env);
  const records = loadFindingsDir(env.FINDINGS_DIR, log);
  const triageContext = String(env.TRIAGE_CONTEXT ?? "").trim();
  const lanes = String(env.TRIAGE_LANES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const onlyIfExists = String(env.ONLY_IF_EXISTS ?? "").trim().toLowerCase() === "true";
  const rawRelease = String(env.RELEASE ?? "").trim().toLowerCase();
  const release = rawRelease === "true" ? true : rawRelease === "false" ? false : undefined;

  let published = false;
  let aggregate: LaneSummary | null = null;
  if (triageContext && lanes.length && env.GITHUB_TOKEN && env.COMPOSITE_IDENTITY) {
    const id = compositeIdentityFrom(env.COMPOSITE_IDENTITY);
    const publisher = statusPublisher({ api: gh(fetchImpl, env.GITHUB_TOKEN, retryWait), id, context: triageContext, env, log, release });
    published = await publisher.summarize(lanes, triageContext, laneSummary, release, {
      onlyIfExists,
      onSummary: (s) => { aggregate = s; },
    });
  } else if (triageContext) {
    log("e2e-test-triage consolidate: triage-status-context set without github-token, composite-identity, or triage-lanes; status not published");
  }

  const summary = buildTriageSummary(records, aggregate, secrets);
  if (env.SUMMARY_FILE) {
    mkdirSync(dirname(env.SUMMARY_FILE), { recursive: true });
    writeFileSync(env.SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY && String(env.WRITE_SUMMARY ?? "true").trim().toLowerCase() !== "false" && (records.length > 0 || published || Boolean(!triageContext && env.FINDINGS_DIR))) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderTriageSummaryMarkdown(summary)}\n`);
  }
  if (env.GITHUB_OUTPUT) {
    const desc = summary.overall_description.replace(/[\r\n]+/g, " ");
    const costOut = summary.totals.ai_cost_usd == null ? "unknown" : summary.totals.ai_cost_usd.toFixed(6);
    appendFileSync(
      env.GITHUB_OUTPUT,
      `state=${summary.overall_state}\ndescription=${desc}\npublished=${published}\nblocking=${summary.totals.blocking}\nexonerated=${summary.totals.exonerated}\nai_calls=${summary.totals.ai_calls}\nai_cost_usd=${costOut}\n`,
    );
  }
  return summary;
}
