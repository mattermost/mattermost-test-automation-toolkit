// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { isUuid, lookupVerdictBySignature, resolveTsioAuthHeaders, sliceUtf16Safe, submitVerdicts } from "../../shared/src/tsio.ts";
import type { CreateVerdictItem, CreatedVerdictItem, TsioVerdict } from "../../shared/src/tsio.ts";
import type { LookupVerdictFn } from "./decision.ts";
import { redact, secretsOf } from "./findings.ts";
import type { JudgedLane } from "./lane-verdict.ts";
import { statusLabelOf } from "./render.ts";
import type { Finding, TsioId } from "./types.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function firstErrorLine(error: string | null | undefined, secrets: string[]): string {
  const line = String(error ?? "").replace(ANSI, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return sliceUtf16Safe(redact(line.trim(), secrets), 200);
}

export function buildErrorContext(f: Finding, secrets: string[]): Record<string, unknown> {
  const first = firstErrorLine(f.error, secrets);
  return {
    file: redact(f.repo_path ?? f.file, secrets),
    title: redact(f.title, secrets),
    ...(f.full_title ? { full_title: redact(f.full_title, secrets) } : {}),
    class: f.class,
    error_first_line: first,
    ...(f.error ? { error: sliceUtf16Safe(redact(f.error, secrets), 4000) } : {}),
    ...(f.reason ? { reason: sliceUtf16Safe(redact(f.reason, secrets), 1000) } : {}),
    ...(f.tries ? { tries: { ran: f.tries.ran, failed: f.tries.failed } } : {}),
  };
}

export function findingToVerdictItem(f: Finding, runURL: string, secrets: string[]): CreateVerdictItem {
  const rawConf = f.reused_from_id ? (f.reused_verdict?.confidence ?? f.judge?.confidence ?? null) : (f.judge?.confidence ?? null);
  const confidence = typeof rawConf === "number" && Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : null;
  const reusedSummary = typeof f.reused_verdict?.summary === "string" ? f.reused_verdict.summary : null;
  const rawSummary = f.reused_from_id
    ? (reusedSummary ?? f.judge?.explanation ?? f.reason ?? "")
    : (f.judge?.explanation ?? f.reason ?? "");
  const cleanSummary = redact(rawSummary, secrets).trim();
  const reusedModel = typeof f.reused_verdict?.model === "string" ? f.reused_verdict.model : null;
  const model = f.reused_from_id
    ? (reusedModel ?? f.judge?.provenance?.served_model ?? null)
    : (f.judge?.provenance?.served_model ?? f.ai?.model ?? null);

  return {
    test_id: isUuid(f.test_id) ? f.test_id : null,
    signature_id: isUuid(f.signature_id) ? f.signature_id : null,
    fingerprint: typeof f.signature_fingerprint === "string" && f.signature_fingerprint.trim() ? f.signature_fingerprint.trim() : null,
    label: statusLabelOf(f),
    decided_by: f.reused_from_id ? "reused" : f.judge ? "ai" : "rules",
    rule: f.decision ?? f.class ?? null,
    confidence,
    summary: cleanSummary ? sliceUtf16Safe(cleanSummary, 1000) : null,
    model,
    triage_url: runURL,
    error_context: buildErrorContext(f, secrets),
    reused_from_id: isUuid(f.reused_from_id) ? f.reused_from_id : null,
  };
}

/**
 * Builds a fail-open pre-LLM TSIO signature verdict lookup callback.
 * Any network/HTTP/JSON error logs a redacted warning and resolves to null so triage falls back to the LLM.
 */
export function makeVerdictLookup({
  fetchImpl,
  base,
  repository,
  log,
  secrets,
  windowDays = 90,
}: {
  fetchImpl: FetchImpl;
  base: string;
  repository: string;
  log: (message: string) => void;
  secrets: string[];
  windowDays?: number;
}): LookupVerdictFn {
  return async (fingerprint: string): Promise<TsioVerdict | null> => {
    try {
      return await lookupVerdictBySignature(fetchImpl, base, fingerprint, { repository, windowDays });
    } catch (e) {
      log(`e2e-test-triage: TSIO verdict lookup failed (failing open): ${sliceUtf16Safe(redact(String(e), secrets), 200)}`);
      return null;
    }
  };
}

/**
 * Submits settled triage verdicts to TSIO POST /api/v1/verdicts.
 * Always fails open: missing auth, network errors, timeouts, or 4xx/5xx log a redacted warning and return [].
 */
export async function submitTriageVerdicts({
  env,
  fetchImpl,
  base,
  repository,
  reportGroupId,
  findings,
  lane,
  runURL,
  log,
}: {
  env: Env;
  fetchImpl: FetchImpl;
  base: string;
  repository: string;
  reportGroupId: TsioId | null | undefined;
  findings: Finding[];
  lane: JudgedLane | null;
  runURL: string;
  log: (message: string) => void;
}): Promise<CreatedVerdictItem[]> {
  const hasFindings = findings.length > 0;
  const hasFailingLane = Boolean(lane && lane.verdict.state !== "success");
  if (!hasFindings && !hasFailingLane) return [];

  let secrets = secretsOf(env);
  try {
    const auth = await resolveTsioAuthHeaders(env, fetchImpl, (msg) => log(redact(msg, secrets)));
    if (!auth) return [];
    secrets = secretsOf(env, [auth.secret]);

    const items: CreateVerdictItem[] = [];
    if (hasFailingLane) {
      items.push({
        test_id: null,
        signature_id: null,
        fingerprint: null,
        label: lane!.verdict.label,
        decided_by: "rules",
        rule: lane!.verdict.fault,
        confidence: null,
        summary: sliceUtf16Safe(redact(lane!.verdict.what, secrets).trim(), 1000) || null,
        model: null,
        triage_url: runURL,
        error_context: {
          lane_label: redact(lane!.verdict.label, secrets),
          fault: redact(lane!.verdict.fault, secrets),
          what: sliceUtf16Safe(redact(lane!.verdict.what, secrets), 1000),
          action: sliceUtf16Safe(redact(lane!.verdict.action, secrets), 1000),
        },
        reused_from_id: null,
      });
    }
    if (hasFindings) {
      for (const f of [...findings].sort((a, b) => Number(b.blocking) - Number(a.blocking))) {
        items.push(findingToVerdictItem(f, runURL, secrets));
      }
    }

    const gid = reportGroupId != null && isUuid(String(reportGroupId)) ? String(reportGroupId) : null;
    return await submitVerdicts(fetchImpl, base, auth.headers, {
      repository,
      report_group_id: gid,
      verdicts: items,
    });
  } catch (e) {
    log(`e2e-test-triage: TSIO verdict submission skipped (failing open): ${sliceUtf16Safe(redact(String(e), secrets), 200)}`);
    return [];
  }
}
