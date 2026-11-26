// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Env, FetchImpl } from "../../shared/src/github.ts";
import { MAX_ERROR_CONTEXT_BYTES } from "../../shared/src/tsio.ts";
import type { TsioVerdict } from "../../shared/src/tsio.ts";
import { judge } from "./decision.ts";
import { checkFindingsShape, findingLogLine, findingsRecord, secretsOf } from "./findings.ts";
import { buildPack, releasePack } from "./pack.ts";
import { newLedger } from "./pricing.ts";
import { decidedBy, statusLabelOf } from "./render.ts";
import { triage } from "./triage.ts";
import type { Answer, Finding, Observation, Pack, PrRef } from "./types.ts";
import { buildErrorContext, findingToVerdictItem, makeVerdictLookup, shouldSubmitFindingVerdict, submitTriageVerdicts } from "./verdicts.ts";
import type { JudgedLane } from "./lane-verdict.ts";

const GROUP_UUID = "01960000-0000-7000-8000-000000000001";
const TEST_UUID_1 = "11111111-1111-4111-8111-111111111111";
const TEST_UUID_2 = "22222222-2222-4222-8222-222222222222";
const SIG_UUID_1 = "33333333-3333-4333-8333-333333333333";
const PRIOR_VERDICT_UUID = "44444444-4444-4444-8444-444444444444";

const obs = (over: Partial<Observation> = {}): Observation => ({
  file: "specs/a.spec.ts",
  title: "t1",
  name: "playwright-full-master",
  status: "passed",
  retry_count: 0,
  gh_pr_number: null,
  commit_sha: "oldsha",
  created_at: "2026-11-20T10:00:00Z",
  branch: "master",
  ...over,
});

function priorVerdict(over: Partial<TsioVerdict> = {}): TsioVerdict {
  return {
    id: PRIOR_VERDICT_UUID,
    report_group_id: GROUP_UUID,
    repository: "o/r",
    test_id: TEST_UUID_1,
    signature_id: SIG_UUID_1,
    fingerprint: "fp-1",
    label: "flaky",
    decided_by: "ai",
    rule: "adjudicator_unblock",
    confidence: 0.94,
    summary: "Known timeout flake across unrelated PRs",
    model: "claude-sonnet-5-5",
    triage_url: "https://github.com/o/r/actions/runs/9",
    reused_from_id: null,
    created_at: "2026-11-25T10:00:00Z",
    ...over,
  };
}

interface TriageHarnessOpts {
  cases?: Record<string, unknown>[];
  prFiles?: { filename: string; patch?: string }[];
  history?: Observation[];
  envOver?: Partial<Env>;
  onLookup?: (fingerprint: string, url: string) => Response | Promise<Response>;
  onPostVerdicts?: (body: unknown, headers: Record<string, string>) => Response | Promise<Response>;
  onOidc?: (url: string, headers: Record<string, string>) => Response | Promise<Response>;
  llmAnswer?: Partial<Answer>;
}

function makeHarness(opts: TriageHarnessOpts = {}) {
  const id = {
    repository: "o/r",
    commit_sha: "abc",
    gh_run_id: "12",
    gh_run_attempt: "1",
    name: "playwright-full",
    branch: "pr-5",
    gh_pr_number: 5,
  };
  const env: Env = {
    COMPOSITE_IDENTITY: JSON.stringify(id),
    STATUS_CONTEXT: "e2e-test/playwright",
    TEST_ROOT: ".",
    MODE: "enforce",
    BASE_REF: "master",
    GITHUB_TOKEN: "ghp_secretToken1234567890123456",
    ANTHROPIC_API_KEY: "sk-ant-secretKey1234567890",
    TSIO_BASE_URL: "http://tsio",
    ARTIFACT_EVIDENCE: "false",
    ...opts.envOver,
  };
  const cases = opts.cases ?? [
    {
      suite_id: "s1",
      title: "t1",
      status: "failed",
      retry_count: 0,
      ordinal: 0,
      error_message: "Error: expected visible",
      test_id: TEST_UUID_1,
      signature_id: SIG_UUID_1,
      signature_fingerprint: "fp-1",
    },
  ];
  const history = opts.history ?? [
    ...Array.from({ length: 6 }, (_, i) => obs({ commit_sha: `c${i}` })),
    obs({ gh_pr_number: 99, status: "failed", commit_sha: "otherpr" }),
  ];
  const prFiles = opts.prFiles ?? [{ filename: "app/unrelated.ts", patch: "@@ -1 +1 @@\n-a\n+b" }];

  let anthropicCalls = 0;
  let lookupCalls: string[] = [];
  let postedVerdicts: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let statusWrites: Record<string, unknown>[] = [];
  const logs: string[] = [];

  const fetchImpl: FetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const p = u.pathname;
    const hdrs = Object.fromEntries(Object.entries((init.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    if (u.hostname === "oidc.example") {
      if (opts.onOidc) return opts.onOidc(String(url), hdrs);
      return Response.json({ value: "oidc-jwt-secret-value-999999" });
    }
    if (p === "/api/v1/reports") {
      return Response.json({
        reports: [{ id: GROUP_UUID, repository: "o/r", commit: "abc", name: "playwright-full", gh_run_id: "12", gh_run_attempt: "1", status: "completed" }],
        total: 1,
      });
    }
    if (p === `/api/v1/reports/${GROUP_UUID}/suites`) {
      return Response.json({ suites: [{ id: "s1", file_path: "specs/a.spec.ts" }] });
    }
    if (p === `/api/v1/reports/${GROUP_UUID}/cases`) {
      return Response.json(cases);
    }
    if (p.endsWith("/history")) {
      return Response.json({ observations: history, has_more: false });
    }
    if (/^\/api\/v1\/reports\/[^/]+$/.test(p)) {
      return Response.json({ test_stats: { total: 10, failed: 1 } });
    }
    if (p.startsWith("/api/v1/verdicts/by-signature/")) {
      const fp = decodeURIComponent(p.slice("/api/v1/verdicts/by-signature/".length));
      lookupCalls.push(fp);
      if (opts.onLookup) return opts.onLookup(fp, String(url));
      return new Response(null, { status: 404 });
    }
    if (p === "/api/v1/verdicts" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      postedVerdicts.push({ body, headers: hdrs });
      if (opts.onPostVerdicts) return opts.onPostVerdicts(body, hdrs);
      const items = (body.verdicts as { test_id: string | null; signature_id: string | null; label: string; reused_from_id: string | null }[]) ?? [];
      return Response.json({
        verdicts: items.map((v, i) => ({
          id: `99999999-9999-4999-8999-${String(i + 1).padStart(12, "0")}`,
          report_group_id: body.report_group_id ?? null,
          repository: body.repository,
          test_id: v.test_id,
          signature_id: v.signature_id,
          label: v.label,
          decided_by: "ai",
          rule: null,
          confidence: null,
          summary: null,
          model: null,
          triage_url: null,
          reused_from_id: v.reused_from_id,
          created_at: "2026-11-26T00:00:00Z",
          created: true,
          superseded_id: null,
        })),
      });
    }
    if (p === "/repos/o/r/pulls/5") return Response.json({ title: "Fix", base: { ref: "master" }, labels: [] });
    if (p === "/repos/o/r/pulls/5/files") return Response.json(prFiles);
    if (p === "/repos/o/r/commits/abc/statuses") {
      return Response.json([{ context: "e2e-test/playwright", state: "failure", target_url: "https://github.com/o/r/actions/runs/12" }]);
    }
    if (p === "/repos/o/r/statuses/abc") {
      statusWrites.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ id: 1 });
    }
    if (p.includes("/compare/")) {
      return Response.json({ ahead_by: 0, behind_by: 0, total_commits: 0, files: [], commits: [] });
    }
    if (p.includes("/pulls/5/commits") || p.includes("/commits/")) {
      return Response.json([]);
    }
    if (u.hostname === "api.anthropic.com") {
      anthropicCalls++;
      const body = JSON.parse(String(init.body)) as { model: string; messages: { content: string | { text?: string }[] }[]; output_config: { format: { schema: { properties: { answers?: unknown } } } } };
      const text = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.map((c) => c.text ?? "").join("");
      const ids = [...new Set(text.match(/"id":"f\d+"/g) ?? [])].map((m) => m.slice(6, -1));
      const ans: Answer = {
        cause: "flaky_environment",
        confidence: 0.92,
        cited_evidence: ["cross_pr"],
        explanation: "Failed on unrelated PR too",
        ...opts.llmAnswer,
      };
      const reply = body.output_config.format.schema.properties.answers ? { answers: ids.map((fid) => ({ id: fid, ...ans })) } : ans;
      return Response.json({ model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return {
    env,
    fetchImpl,
    logs,
    get anthropicCalls() {
      return anthropicCalls;
    },
    get lookupCalls() {
      return lookupCalls;
    },
    get postedVerdicts() {
      return postedVerdicts;
    },
    get statusWrites() {
      return statusWrites;
    },
  };
}

const noopWait = async () => {};

test("pre-LLM TSIO verdict hit skips Anthropic call, sets reused_from_id, and submits reused verdict", async () => {
  const h = makeHarness({
    envOver: { TSIO_API_KEY: "tsio-api-key-secret-value" },
    onLookup: async (_fp, url) => {
      assert.match(url, /repository=o%2Fr/);
      assert.match(url, /window_days=90/);
      return Response.json(priorVerdict({ label: "flaky", confidence: 0.94 }));
    },
  });

  const res = await triage({ env: h.env, fetchImpl: h.fetchImpl, log: (m) => h.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(h.anthropicCalls, 0, "Anthropic API must not be called on valid reusable verdict hit");
  assert.equal(res.ai.calls.length, 0, "ledger.calls must remain 0");
  assert.deepEqual(h.lookupCalls, ["fp-1"]);
  assert.equal(res.verdict, "SUCCESS");
  assert.equal(res.findings[0].reused_from_id, PRIOR_VERDICT_UUID);
  assert.equal(statusLabelOf(res.findings[0]), "flaky");
  assert.match(decidedBy(res.findings[0]), /^Reused/);

  const rec = findingsRecord({ env: h.env, id: JSON.parse(String(h.env.COMPOSITE_IDENTITY)), mode: "enforce", run: null, result: res, notTriaged: null });
  assert.deepEqual(checkFindingsShape(rec), [], "findingsRecord must pass strict schema check");

  assert.equal(h.postedVerdicts.length, 1);
  assert.equal(h.postedVerdicts[0].headers["x-api-key"], "tsio-api-key-secret-value");
  const item = (h.postedVerdicts[0].body.verdicts as Record<string, unknown>[])[0];
  assert.equal(item.test_id, TEST_UUID_1);
  assert.equal(item.signature_id, SIG_UUID_1);
  assert.equal(item.label, "flaky");
  assert.equal(item.decided_by, "reused");
  assert.equal(item.reused_from_id, PRIOR_VERDICT_UUID);
  assert.equal(h.postedVerdicts[0].body.report_group_id, GROUP_UUID);
});

test("pre-LLM broken-on-main hit skips LLM on PR (unblocking) and preserves blocking on trunk run", async () => {
  const hPr = makeHarness({
    envOver: { TSIO_API_KEY: "tsio-key-123456" },
    onLookup: async () => Response.json(priorVerdict({ label: "broken on main", confidence: 0.9 })),
  });
  const prRes = await triage({ env: hPr.env, fetchImpl: hPr.fetchImpl, log: () => {}, now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hPr.anthropicCalls, 0);
  assert.equal(prRes.findings[0].blocking, false);
  assert.equal(statusLabelOf(prRes.findings[0]), "broken on main");

  // Direct judge() call with isTrunkRun = true preserves trunk blocking semantics for "broken on main"
  const pr: PrRef = { number: null, repository: "o/r", title: "", lane: "master" };
  const trunkFinding: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: boom",
    class: "REGRESSION",
    reason: "Failed on trunk",
    blocking: true,
    trunk: { runs: 6, fails: 1, flaky: 0, passes: 5, latest: "failed", same_error: true },
    cross_pr: { prs: [99], examples: ["PR #99: Error: boom"], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    signature_fingerprint: "fp-trunk",
  };
  const pack: Pack = buildPack(trunkFinding, [], pr, []);
  let asked = 0;
  await judge(
    [trunkFinding],
    [pack],
    async () => {
      asked++;
      return { answers: [], usage: null, served_model: "claude-sonnet-5-5" };
    },
    undefined,
    () => {},
    true,
    undefined,
    async () => priorVerdict({ label: "broken on main", confidence: 0.91 }),
  );
  assert.equal(asked, 0, "LLM must not be called on trunk when TSIO already has broken on main");
  assert.equal(trunkFinding.blocking, true, "trunk broken on main must stay blocking");
  assert.equal(trunkFinding.reused_from_id, PRIOR_VERDICT_UUID);
  assert.equal(statusLabelOf(trunkFinding), "broken on main");
});

test("release run reuses test bug and server compat verdicts while skipping LLM", async () => {
  const mkRelease = (label: "test bug" | "server compat") => {
    const f: Finding = {
      file: "specs/a.spec.ts",
      title: "t1",
      error: "Error: mismatch",
      class: "REGRESSION",
      reason: "Failed on release",
      blocking: true,
      release: true,
      trunk: { runs: 6, fails: 0, flaky: 0, passes: 6, latest: "passed" },
      cross_pr: { prs: [], examples: [], passes: 0 },
      failure_signatures: [],
      trunk_break: null,
      this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
      signature_fingerprint: `fp-${label}`,
    };
    const pack = releasePack(f, { repository: "o/r", name: "e2e-Server_11.11.0", branch: "release-11.11", base: "master", historyBranch: "master" }, []);
    return { f, pack };
  };
  for (const label of ["test bug", "server compat"] as const) {
    const { f, pack } = mkRelease(label);
    let asked = 0;
    await judge(
      [f],
      [pack],
      async () => {
        asked++;
        return { answers: [], usage: null, served_model: "claude-sonnet-5-5" };
      },
      undefined,
      () => {},
      true,
      undefined,
      async () => priorVerdict({ label, confidence: 0.92 }),
    );
    assert.equal(asked, 0);
    assert.equal(f.blocking, false);
    assert.equal(f.reused_from_id, PRIOR_VERDICT_UUID);
    assert.equal(statusLabelOf(f), label);
  }
});

test("guardrails: non-reusable caused-by-PR, low confidence, and PR-touched findings still invoke LLM", async () => {
  // 1. Non-reusable "caused by PR"
  const hBlame = makeHarness({
    envOver: { TSIO_API_KEY: "tsio-key-123456" },
    onLookup: async () => Response.json(priorVerdict({ label: "caused by PR", confidence: 0.95 })),
  });
  const blameRes = await triage({ env: hBlame.env, fetchImpl: hBlame.fetchImpl, log: () => {}, now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hBlame.anthropicCalls, 1);
  assert.equal(blameRes.findings[0].reused_from_id, undefined);

  // 2. Low confidence (< minConfidence 0.85)
  const hLowConf = makeHarness({
    envOver: { TSIO_API_KEY: "tsio-key-123456" },
    onLookup: async () => Response.json(priorVerdict({ label: "flaky", confidence: 0.6 })),
  });
  await triage({ env: hLowConf.env, fetchImpl: hLowConf.fetchImpl, log: () => {}, now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hLowConf.anthropicCalls, 1);

  // 3. PR diff touches error-named file (untouched === false / related hunk)
  const hTouched = makeHarness({
    envOver: { TSIO_API_KEY: "tsio-key-123456" },
    cases: [
      {
        suite_id: "s1",
        title: "t1",
        status: "failed",
        retry_count: 0,
        ordinal: 0,
        error_message: "Error in channel_header.tsx: expected visible",
        test_id: TEST_UUID_1,
        signature_id: SIG_UUID_1,
        signature_fingerprint: "fp-touched",
      },
    ],
    prFiles: [{ filename: "components/channel_header.tsx", patch: "@@ -1 +1 @@\n-old\n+new" }],
    onLookup: async () => Response.json(priorVerdict({ label: "flaky", confidence: 0.99 })),
    llmAnswer: { cause: "caused_by_pr", confidence: 0.95, cited_evidence: ["hunk_0"], explanation: "Changed channel_header", fix: "Revert channel_header.tsx" },
  });
  const touchedRes = await triage({ env: hTouched.env, fetchImpl: hTouched.fetchImpl, log: () => {}, now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hTouched.anthropicCalls, 1, "PR-touched failure must still invoke LLM even if TSIO returned flaky");
  assert.equal(touchedRes.verdict, "FAILURE");
  assert.equal(statusLabelOf(touchedRes.findings[0]), "caused by PR");
});

test("fail-open: TSIO lookup 500 or timeout falls back cleanly to LLM", async () => {
  const h500 = makeHarness({
    onLookup: async () => new Response("internal error", { status: 500 }),
  });
  const res500 = await triage({ env: h500.env, fetchImpl: h500.fetchImpl, log: (m) => h500.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(h500.anthropicCalls, 1);
  assert.equal(res500.verdict, "SUCCESS");
  assert.ok(h500.logs.some((l) => l.includes("TSIO verdict lookup failed")));

  const hTimeout = makeHarness({
    onLookup: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  const resTimeout = await triage({ env: hTimeout.env, fetchImpl: hTimeout.fetchImpl, log: (m) => hTimeout.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hTimeout.anthropicCalls, 1);
  assert.equal(resTimeout.verdict, "SUCCESS");
});

test("POST /api/v1/verdicts supports OIDC auth, skips when unauthenticated, deduplicates targets, redacts secrets, and fails open on 500", async () => {
  // 1. OIDC Bearer auth + secret redaction + deduplication
  const oidcErr = "Error with https://example.com/cb?token=ghp_secretToken1234567890123456 and oidc-jwt-secret-value-999999\n" + "a".repeat(80_000);
  const hOidc = makeHarness({
    envOver: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?sig=abc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-req-secret-token",
      TSIO_OIDC_AUDIENCE: "mattermost-test-system-io",
    },
    history: [
      ...Array.from({ length: 6 }, (_, i) => obs({ title: "t1", commit_sha: `c${i}` })),
      obs({ title: "t1", gh_pr_number: 99, status: "failed", commit_sha: "otherpr", error_excerpt: oidcErr }),
      ...Array.from({ length: 6 }, (_, i) => obs({ title: "t2", commit_sha: `c${i}` })),
      obs({ title: "t2", gh_pr_number: 99, status: "failed", commit_sha: "otherpr" }),
    ],
    cases: [
      {
        suite_id: "s1",
        title: "t1",
        status: "failed",
        retry_count: 0,
        ordinal: 0,
        error_message: oidcErr,
        test_id: TEST_UUID_1,
        signature_id: SIG_UUID_1,
        signature_fingerprint: "fp-dup",
      },
      {
        suite_id: "s1",
        title: "t2",
        status: "failed",
        retry_count: 0,
        ordinal: 1,
        error_message: "Error: duplicate target",
        test_id: TEST_UUID_1,
        signature_id: SIG_UUID_1,
        signature_fingerprint: "fp-dup-2",
      },
    ],
  });
  const oidcRes = await triage({ env: hOidc.env, fetchImpl: hOidc.fetchImpl, log: (m) => hOidc.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(oidcRes.verdict, "SUCCESS");
  assert.equal(hOidc.postedVerdicts.length, 1);
  assert.equal(hOidc.postedVerdicts[0].headers.authorization, "Bearer oidc-jwt-secret-value-999999");
  const items = hOidc.postedVerdicts[0].body.verdicts as { error_context: Record<string, unknown>; summary: string | null }[];
  assert.equal(items.length, 1, "duplicate (test_id, signature_id) under same report_group_id must be deduped");
  const ctxStr = JSON.stringify(items[0].error_context);
  assert.ok(!ctxStr.includes("ghp_secretToken1234567890123456"));
  assert.ok(!ctxStr.includes("oidc-jwt-secret-value-999999"));
  assert.ok(Buffer.byteLength(ctxStr, "utf8") <= MAX_ERROR_CONTEXT_BYTES);

  // 2. Missing auth skips POST cleanly
  const hNoAuth = makeHarness();
  const noAuthRes = await triage({ env: hNoAuth.env, fetchImpl: hNoAuth.fetchImpl, log: () => {}, now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(noAuthRes.verdict, "SUCCESS");
  assert.equal(hNoAuth.postedVerdicts.length, 0);

  // 3. POST 500, 401, 403, and timeout all fail open without throwing or leaking TSIO_API_KEY
  for (const [label, handler] of [
    ["500", async () => new Response("tsio down", { status: 500 })],
    ["401", async () => new Response("unauthorized", { status: 401 })],
    ["403", async () => new Response("forbidden", { status: 403 })],
    ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
  ] as const) {
    const hFail = makeHarness({
      envOver: { TSIO_API_KEY: "super-secret-tsio-key-999" },
      onPostVerdicts: handler,
    });
    const resFail = await triage({ env: hFail.env, fetchImpl: hFail.fetchImpl, log: (m) => hFail.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
    assert.equal(resFail.verdict, "SUCCESS", `POST ${label} must fail open`);
    assert.ok(hFail.logs.some((l) => l.includes("TSIO verdict submission skipped")), `POST ${label} must log warning`);
    assert.ok(hFail.logs.every((l) => !l.includes("super-secret-tsio-key-999")), `POST ${label} must never leak API key`);
  }
});

test("secretsOf includes TSIO_API_KEY and ACTIONS_ID_TOKEN_REQUEST_TOKEN alongside GitHub and Anthropic secrets", () => {
  const s = secretsOf(
    { GITHUB_TOKEN: "gh-secret", ANTHROPIC_API_KEY: "ant-secret", TSIO_API_KEY: "tsio-secret", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-secret" },
    ["oidc-secret"],
  );
  assert.deepEqual(s, ["gh-secret", "ant-secret", "tsio-secret", "req-secret", "oidc-secret"]);
});

test("HIGH-1: malformed TSIO prior fields fail open to LLM without throwing in judge() or triage()", async () => {
  const pr: PrRef = { number: 5, repository: "o/r", title: "Fix", lane: "playwright-full" };
  const mkFinding = (): Finding => ({
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: boom",
    class: "REGRESSION",
    reason: "Cross-PR",
    blocking: true,
    trunk: { runs: 6, fails: 0, flaky: 0, passes: 6, latest: "passed" },
    cross_pr: { prs: [99], examples: ["PR #99: Error: boom"], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    signature_fingerprint: "fp-malformed",
  });

  for (const badPrior of [
    priorVerdict({ summary: 12345 as unknown as string }),
    priorVerdict({ summary: {} as unknown as string }),
    priorVerdict({ confidence: "0.95" as unknown as number }),
    priorVerdict({ model: 42 as unknown as string }),
    {} as unknown as TsioVerdict,
  ]) {
    const f = mkFinding();
    const pack = buildPack(f, [], pr, []);
    let asked = 0;
    await judge(
      [f],
      [pack],
      async () => {
        asked++;
        return {
          answers: [{ cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "LLM fallback" }],
          usage: null,
          served_model: "claude-sonnet-5-5",
        };
      },
      undefined,
      () => {},
      false,
      undefined,
      async () => badPrior,
    );
    assert.equal(asked, 1, "malformed prior must fall back to LLM without throwing");
    assert.equal(f.blocking, false);
    assert.equal(f.reused_from_id, undefined);
  }

  const hBadHttp = makeHarness({
    onLookup: async () => Response.json({ id: PRIOR_VERDICT_UUID, label: "flaky", confidence: 0.95, summary: 12345 }),
  });
  const res = await triage({ env: hBadHttp.env, fetchImpl: hBadHttp.fetchImpl, log: (m) => hBadHttp.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });
  assert.equal(hBadHttp.anthropicCalls, 1);
  assert.equal(res.verdict, "SUCCESS");
});

test("HIGH-2: ACTIONS_ID_TOKEN_REQUEST_TOKEN and OIDC JWTs are redacted from logs, FINDINGS_FILE, GITHUB_STEP_SUMMARY, and posted verdicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "triage-redact-"));
  const findingsPath = join(dir, "findings.json");
  const summaryPath = join(dir, "summary.md");
  const reqSecret = "actions-id-req-secret-99999";
  const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_part_abc12345";
  try {
    const h = makeHarness({
      envOver: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: reqSecret,
        FINDINGS_FILE: findingsPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      onOidc: async () => Response.json({ value: jwt }),
      history: [
        ...Array.from({ length: 6 }, (_, i) => obs({ title: `test with ${reqSecret} and ${jwt}`, commit_sha: `c${i}` })),
        obs({ title: `test with ${reqSecret} and ${jwt}`, gh_pr_number: 99, status: "failed", commit_sha: "otherpr", error_excerpt: `Error carrying ${reqSecret} and ${jwt}` }),
      ],
      cases: [
        {
          suite_id: "s1",
          title: `test with ${reqSecret} and ${jwt}`,
          status: "failed",
          retry_count: 0,
          ordinal: 0,
          error_message: `Error carrying ${reqSecret} and ${jwt}`,
          test_id: TEST_UUID_1,
          signature_id: SIG_UUID_1,
          signature_fingerprint: "fp-sec",
        },
      ],
      llmAnswer: {
        cause: "flaky_environment",
        confidence: 0.92,
        cited_evidence: ["cross_pr"],
        explanation: `Saw ${reqSecret} and ${jwt} in output`,
      },
    });
    await triage({ env: h.env, fetchImpl: h.fetchImpl, log: (m) => h.logs.push(m), now: new Date("2026-11-26T12:00:00Z"), retryWait: noopWait });

    assert.equal(h.postedVerdicts.length, 1);

    const logText = h.logs.join("\n");
    const findingsText = readFileSync(findingsPath, "utf8");
    const summaryText = readFileSync(summaryPath, "utf8");
    const postedText = JSON.stringify(h.postedVerdicts[0]?.body ?? {});

    for (const [where, text] of [
      ["logs", logText],
      ["FINDINGS_FILE", findingsText],
      ["GITHUB_STEP_SUMMARY", summaryText],
      ["POST /verdicts", postedText],
    ] as const) {
      assert.ok(!text.includes(reqSecret), `${where} must not leak ACTIONS_ID_TOKEN_REQUEST_TOKEN`);
      assert.ok(!text.includes(jwt), `${where} must not leak OIDC JWT`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HIGH-4: advisory groups (advise=true, canChange=false) are NOT unblocked by TSIO verdict reuse", async () => {
  const pr: PrRef = { number: 5, repository: "o/r", title: "Fix", lane: "playwright-full" };
  const f: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: expected visible",
    class: "REGRESSION",
    reason: "Failed without clearing evidence",
    blocking: true,
    trunk: { runs: 6, fails: 0, flaky: 0, passes: 6, latest: "passed" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    signature_fingerprint: "fp-advisory",
  };
  const pack = buildPack(f, [], pr, []);
  let asked = 0;
  let lookups = 0;
  await judge(
    [f],
    [pack],
    async () => {
      asked++;
      return {
        answers: [{ cause: "caused_by_pr", confidence: 0.7, cited_evidence: [], explanation: "Unsure" }],
        usage: null,
        served_model: "claude-sonnet-5-5",
      };
    },
    undefined,
    () => {},
    false,
    undefined,
    async () => {
      lookups++;
      return priorVerdict({ label: "flaky", confidence: 0.99 });
    },
  );
  assert.equal(lookups, 0, "advisory group must not query TSIO for unblock reuse");
  assert.equal(asked, 1, "advisory group must proceed to LLM advice path");
  assert.equal(f.blocking, true, "advisory finding must remain blocking");
  assert.equal(f.decision, "advice");
  assert.equal(f.reused_from_id, undefined);
});

test("LOW-1: trunk INFRA_ERROR does not reuse broken-on-main verdict", async () => {
  const pr: PrRef = { number: null, repository: "o/r", title: "", lane: "master" };
  const f: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: ECONNREFUSED 127.0.0.1:8065",
    class: "INFRA_ERROR",
    reason: "Service unreachable",
    blocking: true,
    trunk: { runs: 6, fails: 0, flaky: 0, passes: 6, latest: "passed" },
    cross_pr: { prs: [99], examples: ["PR #99: Error: ECONNREFUSED 127.0.0.1:8065"], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    signature_fingerprint: "fp-infra-trunk",
  };
  const pack = buildPack(f, [], pr, []);
  let asked = 0;
  let lookups = 0;
  await judge(
    [f],
    [pack],
    async () => {
      asked++;
      return {
        answers: [{ cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "Infra blip" }],
        usage: null,
        served_model: "claude-sonnet-5-5",
      };
    },
    undefined,
    () => {},
    true,
    undefined,
    async () => {
      lookups++;
      return priorVerdict({ label: "broken on main", confidence: 0.95 });
    },
  );
  assert.equal(lookups, 1, "non-advisory trunk INFRA_ERROR must consult lookup");
  assert.equal(asked, 1, "trunk INFRA_ERROR must not reuse 'broken on main'");
  assert.equal(f.reused_from_id, undefined);
});

test("MEDIUM-2: buildErrorContext and findingToVerdictItem truncate 4-byte emojis without lone UTF-16 surrogates", () => {
  const loneRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const err = "x".repeat(3999) + "😀" + "tail";
  const reason = "r".repeat(999) + "😀" + "tail";
  const summary = "s".repeat(999) + "😀" + "tail";
  const f: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: err,
    class: "REGRESSION",
    reason,
    blocking: true,
    trunk: { runs: 0, passes: 0, fails: 0, flaky: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: [], explanation: summary },
  };
  const ctx = buildErrorContext(f, []);
  const item = findingToVerdictItem(f, "https://github.com/o/r/actions/runs/1", []);
  assert.ok(!loneRe.test(String(ctx.error ?? "")));
  assert.ok(!loneRe.test(String(ctx.reason ?? "")));
  assert.ok(!loneRe.test(String(item.summary ?? "")));
});

test("secret redaction runs before truncation across 200, 1000, and 4000 char boundaries", async () => {
  const opaque = "OPAQUE_SECRET_BOUNDARY_VALUE_9876543210";
  const prefix = "OPAQUE_SECRET_";
  const firstLineBoundaryErr = "x".repeat(185) + opaque + " tail";
  const bodyBoundaryErr = "line1\n" + "e".repeat(3979) + opaque + " tail";
  const reasonBoundary = "r".repeat(985) + opaque + " tail";

  const mkFinding = (error: string): Finding => ({
    file: "specs/a.spec.ts",
    title: "t1",
    error,
    class: "REGRESSION",
    reason: reasonBoundary,
    blocking: true,
    trunk: { runs: 0, passes: 0, fails: 0, flaky: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  });

  const ctxFirst = buildErrorContext(mkFinding(firstLineBoundaryErr), [opaque]);
  assert.ok(!String(ctxFirst.error_first_line).includes(prefix), "error_first_line must not leak partial secret");
  assert.ok(String(ctxFirst.error_first_line).includes("[redacted]"));
  assert.ok(!String(ctxFirst.reason).includes(prefix), "reason must not leak partial secret across 1000-char boundary");
  assert.ok(String(ctxFirst.reason).includes("[redacted]"));

  const ctxBody = buildErrorContext(mkFinding(bodyBoundaryErr), [opaque]);
  assert.ok(!String(ctxBody.error).includes(prefix), "error must not leak partial secret across 4000-char boundary");
  assert.ok(String(ctxBody.error).includes("[redacted]"));

  const rec = findingsRecord({
    env: { TSIO_API_KEY: opaque, MODE: "enforce" },
    id: null,
    mode: "enforce",
    run: null,
    result: { verdict: "FAILURE", findings: [mkFinding(firstLineBoundaryErr)], infra: null, counts: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 }, missing: null, ai: newLedger() },
    notTriaged: null,
  });
  assert.ok(!rec.findings[0].error_first_line.includes(prefix), "findingsRecord error_first_line must not leak partial secret");
  assert.ok(rec.findings[0].error_first_line.includes("[redacted]"));

  const logs: string[] = [];
  const lookup = makeVerdictLookup({
    fetchImpl: async () => {
      throw new Error("x".repeat(180) + opaque + " tail");
    },
    base: "http://tsio",
    repository: "o/r",
    log: (m) => logs.push(m),
    secrets: [opaque],
  });
  await lookup("fp-1");
  await submitTriageVerdicts({
    env: { TSIO_API_KEY: opaque },
    fetchImpl: async () => {
      throw new Error("y".repeat(180) + opaque + " tail");
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: [mkFinding("err")],
    lane: null,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 2);
  for (const l of logs) {
    assert.ok(!l.includes(prefix), `warning log must not leak partial secret: ${l}`);
    assert.ok(l.includes("[redacted]"), `warning log must redact secret: ${l}`);
  }
});

test("submitTriageVerdicts submits failing lane verdict alongside non-empty findings", async () => {
  const posted: { verdicts: Record<string, unknown>[] }[] = [];
  const finding: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: flake",
    class: "REGRESSION",
    reason: "Cleared by adjudicator",
    blocking: false,
    decision: "adjudicator_unblock",
    test_id: TEST_UUID_1,
    signature_id: SIG_UUID_1,
    signature_fingerprint: "fp-1",
    trunk: { runs: 6, passes: 6, fails: 0, flaky: 0, latest: "passed" },
    cross_pr: { prs: [99], examples: ["PR #99: Error: flake"], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  };
  const lane: JudgedLane = {
    verdict: {
      state: "failure",
      label: "machine failure",
      fault: "infrastructure",
      what: "Worker shard timed out before uploading results",
      action: "Re-run lane",
      rerun: "lane",
      evidence: [],
    },
    orchestration: null,
    jobs: null,
    baseline: null,
    startJobId: 101,
  };

  await submitTriageVerdicts({
    env: { TSIO_API_KEY: "tsio-secret-key-123" },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { verdicts: Record<string, unknown>[] };
      posted.push(body);
      return Response.json({ verdicts: [] });
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: [finding],
    lane,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: () => {},
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].verdicts.length, 2, "must submit both failing lane verdict and test finding verdict");
  assert.equal(posted[0].verdicts[0].test_id, null);
  assert.equal(posted[0].verdicts[0].signature_id, null);
  assert.equal(posted[0].verdicts[0].fingerprint, null);
  assert.equal(posted[0].verdicts[0].label, "machine failure");
  assert.equal(posted[0].verdicts[0].rule, "infrastructure");
  assert.equal(posted[0].verdicts[1].test_id, TEST_UUID_1);
  assert.equal(posted[0].verdicts[1].signature_id, SIG_UUID_1);
});

test("submitTriageVerdicts retains failing lane verdict when findings contain an all-null item", async () => {
  const posted: { verdicts: Record<string, unknown>[] }[] = [];
  const allNullFinding: Finding = {
    file: "specs/unindexed.spec.ts",
    title: "unindexed test",
    error: "Error: timed out",
    class: "FLAKY_NOT_RUN",
    reason: "Cleared by rule",
    blocking: true,
    decision: "block",
    test_id: null,
    signature_id: null,
    signature_fingerprint: null,
    trunk: { runs: 0, passes: 0, fails: 0, flaky: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  };
  const identifiedFinding: Finding = {
    ...allNullFinding,
    file: "specs/identified.spec.ts",
    title: "identified test",
    blocking: false,
    decision: "adjudicator_unblock",
    test_id: TEST_UUID_1,
    signature_id: SIG_UUID_1,
    signature_fingerprint: "fp-1",
  };
  const lane: JudgedLane = {
    verdict: {
      state: "failure",
      label: "machine failure",
      fault: "infrastructure",
      what: "Missing shard report",
      action: "Re-run lane",
      rerun: "lane",
      evidence: [],
    },
    orchestration: null,
    jobs: null,
    baseline: null,
    startJobId: 101,
  };

  await submitTriageVerdicts({
    env: { TSIO_API_KEY: "tsio-secret-key-123" },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { verdicts: Record<string, unknown>[] };
      posted.push(body);
      return Response.json({ verdicts: [] });
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: [allNullFinding, identifiedFinding],
    lane,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: () => {},
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].verdicts.length, 2, "must retain failing lane verdict in the single (null, null) slot plus identified finding");
  assert.equal(posted[0].verdicts[0].test_id, null);
  assert.equal(posted[0].verdicts[0].signature_id, null);
  assert.equal(posted[0].verdicts[0].fingerprint, null);
  assert.equal(posted[0].verdicts[0].label, "machine failure");
  assert.equal(posted[0].verdicts[0].rule, "infrastructure");
  assert.equal(posted[0].verdicts[1].test_id, TEST_UUID_1);
  assert.equal(posted[0].verdicts[1].signature_id, SIG_UUID_1);
});

test("findingsRecord and findingLogLine redact secrets before clipping without unpaired UTF-16 surrogates", () => {
  const loneRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const opaque = "opaque_secret_val_998877665544332211";
  const prefix = "opaque_secret_";
  // After replacing 36-char `opaque` with 10-char `[redacted]` (-26), "🚀" (2 UTF-16 code units) straddles index 200 (199..200) and 300 (299..300).
  const makeAtBoundary = (limit: number): string => `${opaque}${"a".repeat(limit - 11)}🚀tail`;
  const f: Finding = {
    file: "specs/a.spec.ts",
    title: makeAtBoundary(120),
    error: makeAtBoundary(200),
    class: "REGRESSION",
    reason: makeAtBoundary(300),
    blocking: true,
    trunk: { runs: 0, passes: 0, fails: 0, flaky: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: [], explanation: makeAtBoundary(200) },
  };

  const rec = findingsRecord({
    env: { TSIO_API_KEY: opaque, MODE: "enforce" },
    id: null,
    mode: "enforce",
    run: null,
    result: { verdict: "FAILURE", findings: [f], infra: null, counts: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 }, missing: null, ai: newLedger() },
    notTriaged: null,
    description: makeAtBoundary(200),
    laneDiagnosis: { label: "infra", fault: "missing_reports", what: makeAtBoundary(300), action: makeAtBoundary(200) },
  });

  const logLine = findingLogLine(f, 1, 1, [opaque]);
  const strings = [
    rec.description ?? "",
    rec.lane_diagnosis?.what ?? "",
    rec.lane_diagnosis?.action ?? "",
    rec.findings[0].error_first_line,
    rec.findings[0].reason,
    rec.findings[0].ai.explanation ?? "",
    logLine,
  ];
  for (const text of strings) {
    assert.ok(!text.includes(prefix), `must not leak secret fragment: ${text}`);
    assert.ok(!loneRe.test(text), `must not leave unpaired UTF-16 surrogate: ${text}`);
  }
  assert.ok(rec.findings[0].error_first_line.includes("[redacted]"));
  assert.ok(rec.findings[0].reason.includes("[redacted]"));
});

test("secretsOf includes trimmed TSIO_API_KEY and ACTIONS_ID_TOKEN_REQUEST_TOKEN, excludes whitespace-only, and redacts trimmed credentials", async () => {
  const trimmedApiKey = "zxcvbnmasdfghjkl";
  const paddedApiKey = `  ${trimmedApiKey}\n`;
  const trimmedReqToken = "oidc-req-padded-12345";
  const paddedReqToken = `\t ${trimmedReqToken}  `;

  const s = secretsOf(
    {
      GITHUB_TOKEN: "   ",
      ANTHROPIC_API_KEY: "\n\t",
      TSIO_API_KEY: paddedApiKey,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: paddedReqToken,
    },
    ["  ", paddedApiKey, " extra-secret "],
  );
  assert.deepEqual(s, [paddedApiKey, trimmedApiKey, paddedReqToken, trimmedReqToken, " extra-secret ", "extra-secret"]);

  const f: Finding = {
    file: "specs/a.spec.ts",
    title: "t1",
    error: `Connection rejected ${trimmedApiKey} and ${trimmedReqToken}`,
    class: "REGRESSION",
    reason: `Auth failed for ${trimmedApiKey}`,
    blocking: true,
    trunk: { runs: 0, passes: 0, fails: 0, flaky: 0, latest: "" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    judge: { cause: "flaky_environment", confidence: 0.9, cited_evidence: [], explanation: `Used ${trimmedReqToken}` },
  };
  const env: Env = { TSIO_API_KEY: paddedApiKey, ACTIONS_ID_TOKEN_REQUEST_TOKEN: paddedReqToken, MODE: "enforce" };
  const rec = findingsRecord({
    env,
    id: null,
    mode: "enforce",
    run: null,
    result: { verdict: "FAILURE", findings: [f], infra: null, counts: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 }, missing: null, ai: newLedger() },
    notTriaged: null,
  });
  const logLine = findingLogLine(f, 1, 1, s);

  const logs: string[] = [];
  const lookup = makeVerdictLookup({
    fetchImpl: async () => {
      throw new Error(`Connection rejected ${trimmedApiKey} and ${trimmedReqToken}`);
    },
    base: "http://tsio",
    repository: "o/r",
    log: (m) => logs.push(m),
    secrets: s,
  });
  await lookup("fp-1");
  await submitTriageVerdicts({
    env,
    fetchImpl: async () => {
      throw new Error(`POST rejected ${trimmedApiKey} and ${trimmedReqToken}`);
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: [f],
    lane: null,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: (m) => logs.push(m),
  });

  const texts = [
    rec.findings[0].error_first_line,
    rec.findings[0].reason,
    rec.findings[0].ai.explanation ?? "",
    logLine,
    ...logs,
  ];
  assert.equal(logs.length, 2);
  for (const text of texts) {
    assert.ok(!text.includes(trimmedApiKey), `must redact trimmed TSIO_API_KEY: ${text}`);
    assert.ok(!text.includes(trimmedReqToken), `must redact trimmed ACTIONS_ID_TOKEN_REQUEST_TOKEN: ${text}`);
    assert.ok(text.includes("[redacted]"), `must contain [redacted]: ${text}`);
  }
});

test("submitTriageVerdicts filters unresolved/unconfirmed verdicts while preserving confirmed base-branch verdicts", async () => {
  const baseFinding = (over: Partial<Finding>): Finding => ({
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: boom",
    class: "REGRESSION",
    reason: "Reason",
    blocking: true,
    test_id: TEST_UUID_1,
    signature_id: SIG_UUID_1,
    signature_fingerprint: "fp-1",
    trunk: { runs: 6, passes: 5, fails: 1, flaky: 0, latest: "failed" },
    cross_pr: { prs: [], examples: [], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    ...over,
  });

  const rejected: Finding[] = [
    baseFinding({ trunk_run: true, decision: "unavailable" }),
    baseFinding({ trunk_run: true, decision: undefined }),
    baseFinding({ trunk_run: true, class: "INSUFFICIENT_DATA", decision: undefined }),
    baseFinding({ decision: "evidence_incomplete" }),
    baseFinding({ blocking: false, decision: "first_failure" }),
  ];
  for (const f of rejected) {
    assert.equal(shouldSubmitFindingVerdict(f), false, `must reject ${f.class}/${f.decision}/trunk=${Boolean(f.trunk_run)}`);
  }

  let fetchCalls = 0;
  const skipped = await submitTriageVerdicts({
    env: { TSIO_API_KEY: "tsio-secret-key-123" },
    fetchImpl: async () => {
      fetchCalls++;
      return Response.json({ verdicts: [] });
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: rejected,
    lane: null,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: () => {},
  });
  assert.deepEqual(skipped, []);
  assert.equal(fetchCalls, 0, "must not call POST /verdicts when all findings are filtered out");

  const confirmed: Finding[] = [
    baseFinding({ class: "BROKEN_ON_TRUNK", trunk_run: true, test_id: TEST_UUID_1 }),
    baseFinding({ class: "SAME_FAILURE_AS_CLEARED", same_as_class: "BROKEN_ON_TRUNK", blocking: false, decision: "same_failure", test_id: TEST_UUID_2 }),
    baseFinding({ blocking: false, decision: "base_broken", test_id: "55555555-5555-4555-8555-555555555555" }),
    baseFinding({
      blocking: false,
      decision: "adjudicator_unblock",
      judge: { cause: "bug_on_master", confidence: 0.91, cited_evidence: ["cross_pr"], explanation: "Broken on master" },
      test_id: "66666666-6666-4666-8666-666666666666",
    }),
  ];
  for (const f of confirmed) {
    assert.equal(statusLabelOf(f), "broken on main");
    assert.equal(shouldSubmitFindingVerdict(f), true, `must keep confirmed broken on main (${f.class}/${f.decision})`);
  }

  const posted: { verdicts: Record<string, unknown>[] }[] = [];
  await submitTriageVerdicts({
    env: { TSIO_API_KEY: "tsio-secret-key-123" },
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(String(init?.body)) as { verdicts: Record<string, unknown>[] });
      return Response.json({ verdicts: [] });
    },
    base: "http://tsio",
    repository: "o/r",
    reportGroupId: GROUP_UUID,
    findings: [...rejected, ...confirmed],
    lane: null,
    runURL: "https://github.com/o/r/actions/runs/1",
    log: () => {},
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].verdicts.length, confirmed.length);
  for (const v of posted[0].verdicts) assert.equal(v.label, "broken on main");
});

test("reusableOutcomeFor rejects unconfirmed stored verdicts and allows verified rules, ai, and reused verdicts", async () => {
  const pr: PrRef = { number: 5, repository: "o/r", title: "Fix", lane: "playwright-full" };
  const mkFinding = (over: Partial<Finding> = {}): Finding => ({
    file: "specs/a.spec.ts",
    title: "t1",
    error: "Error: boom",
    class: "REGRESSION",
    reason: "Cross-PR",
    blocking: true,
    trunk: { runs: 6, fails: 0, flaky: 0, passes: 6, latest: "passed" },
    cross_pr: { prs: [99], examples: ["PR #99: Error: boom"], passes: 0 },
    failure_signatures: [],
    trunk_break: null,
    this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
    signature_fingerprint: "fp-reuse-gate",
    ...over,
  });

  const runJudge = async (prior: TsioVerdict, opts: { release?: boolean; isTrunk?: boolean } = {}) => {
    const f = mkFinding(opts.release ? { release: true } : {});
    const pack = opts.release
      ? releasePack(f, { repository: "o/r", name: "e2e-Server_11.11.0", branch: "release-11.11", base: "master", historyBranch: "master" }, [])
      : buildPack(f, [], pr, []);
    let asked = 0;
    await judge(
      [f],
      [pack],
      async () => {
        asked++;
        return {
          answers: [{ cause: "flaky_environment", confidence: 0.9, cited_evidence: ["cross_pr"], explanation: "LLM fallback" }],
          usage: null,
          served_model: "claude-sonnet-5-5",
        };
      },
      undefined,
      () => {},
      Boolean(opts.isTrunk),
      undefined,
      async () => prior,
    );
    return { f, asked };
  };

  const rejectedPriors: { prior: TsioVerdict; release?: boolean }[] = [
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "unavailable", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "REGRESSION", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "INSUFFICIENT_DATA", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "first_failure", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "unavailable", confidence: null }) },
    { prior: priorVerdict({ label: "test bug", decided_by: "rules", rule: "test_bug", confidence: null }), release: true },
    { prior: priorVerdict({ label: "server compat", decided_by: "rules", rule: "server_compat", confidence: null }), release: true },
    { prior: priorVerdict({ label: "broken on main", decided_by: "ai", rule: "adjudicator_unblock", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "ai", rule: "engine", confidence: 0.95 }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "ai", rule: "adjudicator_blame", confidence: 0.95 }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "reused", rule: "first_failure", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: null, rule: "BROKEN_ON_TRUNK", confidence: null }) },
  ];

  for (const { prior, release } of rejectedPriors) {
    const { f, asked } = await runJudge(prior, { release });
    assert.equal(asked, 1, `must reject prior decided_by=${prior.decided_by} rule=${prior.rule} label=${prior.label} conf=${prior.confidence}`);
    assert.equal(f.reused_from_id, undefined);
  }

  const allowedPriors: { prior: TsioVerdict; release?: boolean; isTrunk?: boolean }[] = [
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "BROKEN_ON_TRUNK", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "base_broken", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "rules", rule: "same_failure", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "FLAKY_ON_TRUNK", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "FLAKY_CROSS_PR", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "FLAKY_NOT_RUN", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "INFRA_ERROR", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "rules_unblock", confidence: null }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "rules", rule: "same_failure", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "ai", rule: "adjudicator_unblock", confidence: 0.9 }) },
    { prior: priorVerdict({ label: "flaky", decided_by: "reused", rule: "adjudicator_unblock", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "reused", rule: "engine", confidence: null }), isTrunk: true },
    { prior: priorVerdict({ label: "broken on main", decided_by: "reused", rule: "base_broken", confidence: null }) },
    { prior: priorVerdict({ label: "broken on main", decided_by: "reused", rule: "BROKEN_ON_TRUNK", confidence: null }) },
    { prior: priorVerdict({ label: "test bug", decided_by: "ai", rule: "adjudicator_unblock", confidence: 0.92 }), release: true },
  ];

  for (const { prior, release, isTrunk } of allowedPriors) {
    const { f, asked } = await runJudge(prior, { release, isTrunk });
    assert.equal(asked, 0, `must reuse valid prior decided_by=${prior.decided_by} rule=${prior.rule} label=${prior.label}`);
    assert.equal(f.reused_from_id, PRIOR_VERDICT_UUID);
  }
});
