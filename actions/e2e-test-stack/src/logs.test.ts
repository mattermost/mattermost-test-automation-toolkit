// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import sodium from "libsodium-wrappers";
import type { InvokeInput, InvokeOutput } from "./core/lambda.ts";
import { zip } from "./core/zip.fixture.ts";
import { LOGS_CONCURRENCY, LOGS_OUTPUTS, logsWith, readLogsInputs, scrubber } from "./logs.ts";
import type { ServerLog } from "./logs.ts";
import { ACTIONS } from "./run.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const CREDENTIALS_KEY = Buffer.from(keys.privateKey).toString("base64");
const seal = (value: unknown): string =>
  Buffer.from(sodium.crypto_box_seal(JSON.stringify(value), keys.publicKey)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-logs-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const file = (name: string): string => join(dir, `${++files}-${name}`);

/** Parses GITHUB_OUTPUT's delimited entries. */
const readOutputs = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const value: string[] = [];
    while (++i < lines.length && lines[i] !== m[2]) value.push(lines[i]);
    assert.ok(i < lines.length, `output ${m[1]} has no closing delimiter`);
    out[m[1]] = value.join("\n");
  }
  return out;
};

const ROLE_ARN = "arn:aws:iam::111111111111:role/e2e-test-stack-ci-mobile";
const BATCH_ID = "mobile-42-ios-2-abc";
const createResponse = (id = BATCH_ID) => ({
  batch_id: id,
  batch: {
    state: "ready",
    secrets: seal({
      batch_token: "batch-token-1",
      instances: [{ admin_password: "admin-pw-0" }, { admin_password: "admin-pw-1" }],
    }),
  },
});
const ok = (body: unknown): InvokeOutput => ({
  StatusCode: 200,
  Payload: new TextEncoder().encode(JSON.stringify(body)),
});
const refused = (message: string): InvokeOutput => ({
  StatusCode: 200,
  FunctionError: "Unhandled",
  Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: message })),
});
const fetched = (states: (string | null)[]) =>
  ok({
    batch_id: BATCH_ID,
    batch: { state: "found", instances: states.map((s, i) => (s ? { instance_id: `i-${i}`, state: s } : null)) },
  });
const logsReply = (index: number, over: Record<string, unknown> = {}, sealed: unknown = undefined) =>
  ok({
    batch_id: BATCH_ID,
    logs: {
      instance_id: `i-${index}`,
      index,
      containers: ["mattermost", "postgres"],
      lines: 2,
      truncated: true,
      secrets: seal(
        sealed ?? {
          url: `https://logs.example/${index}?sig=secret-${index}`,
          content_gzip: gzipSync(`tail ${index} admin-pw-${index}`).toString("base64"),
        },
      ),
      ...over,
    },
  });

const API = "https://api.github.com/repos/mattermost/mobile/actions";

interface Harness {
  output: string;
  summary: string;
  temp: string;
  logged: string[];
  calls: Record<string, unknown>[];
  downloads: string[];
  stsCalls: number;
  /** The most logs calls in flight at once. */
  peak: number;
  go: () => Promise<void>;
}

/**
 * Runs logs against a fake GitHub serving the newest create response (none when created is undefined), a fake STS, and
 * a control plane answering fetch with fetchReply and each logs call from logsReplies by index. Each log URL answers
 * with downloads[index] or the full log.
 */
const harness = (
  created: unknown,
  fetchReply: InvokeOutput,
  logsReplies: Record<number, InvokeOutput> = {},
  downloads: Record<number, Response> = {},
  env: Record<string, string> = {},
): Harness => {
  let inFlight = 0;
  const h: Harness = {
    output: file("output"),
    summary: file("summary"),
    temp: file("runner-temp"),
    logged: [],
    calls: [],
    downloads: [],
    stsCalls: 0,
    peak: 0,
    go: () =>
      logsWith({
        log: (m) => h.logged.push(m),
        sleep: async () => {},
        fetch: async (url) => {
          if (url.startsWith("https://token.actions.example/")) return Response.json({ value: "id-token-1" });
          if (url === `${API}/runs/77`)
            return Response.json({
              path: ".github/workflows/e2e.yml",
              head_branch: "main",
              event: "push",
              status: "completed",
              run_attempt: 1,
              head_repository: { full_name: "mattermost/mobile" },
            });
          if (
            /^https:\/\/api\.github\.com\/repos\/mattermost\/mobile\/actions\/runs\/(42|77)\/artifacts\?name=e2e-test-stack-create-ios&per_page=100&page=1$/.test(
              url,
            )
          )
            return Response.json({
              artifacts:
                created === undefined
                  ? []
                  : [{ id: 7, name: "e2e-test-stack-create-ios", created_at: "2026-11-22T00:00:00Z" }],
            });
          if (url === `${API}/artifacts/7/zip`)
            return new Response(null, { status: 302, headers: { location: "https://blob.example/7" } });
          if (url === "https://blob.example/7")
            return new Response(
              new Uint8Array(zip([{ name: "e2e-test-stack-create.json", data: JSON.stringify(created) }])),
            );
          const m = /^https:\/\/logs\.example\/(\d+)\?/.exec(url);
          if (m) {
            h.downloads.push(url);
            return downloads[Number(m[1])] ?? new Response(`===== mattermost =====\nfull ${m[1]} admin-pw-${m[1]}\n`);
          }
          return new Response("", { status: 404 });
        },
        sts: () => ({
          send: async () => {
            h.stsCalls++;
            return {
              Credentials: { AccessKeyId: "ASIA1", SecretAccessKey: "sts-secret-1", SessionToken: "sts-session-1" },
            };
          },
        }),
        connect: () => async (input: InvokeInput) => {
          const payload = JSON.parse(input.Payload) as { action: string; index?: number };
          h.calls.push(payload);
          if (payload.action === "fetch") return fetchReply;
          inFlight++;
          h.peak = Math.max(h.peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
          return logsReplies[payload.index!] ?? logsReply(payload.index!);
        },
      })({
        GITHUB_OUTPUT: h.output,
        GITHUB_STEP_SUMMARY: h.summary,
        GITHUB_REPOSITORY: "mattermost/mobile",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        RUNNER_TEMP: h.temp,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-1",
        STACK_CALLER_KEY: "mobile",
        STACK_BATCH: "ios",
        STACK_ROLE_ARN: ROLE_ARN,
        STACK_CREDENTIALS_KEY: CREDENTIALS_KEY,
        STACK_GITHUB_TOKEN: "gh-token",
        ...env,
      }),
  };
  return h;
};
const servers = (h: Harness) => JSON.parse(readOutputs(h.output).servers ?? "[]") as ServerLog[];

test("logs is the bundle's logs action", () => {
  assert.equal(typeof ACTIONS.logs, "function");
});

test("every server still up has its full log saved, with every known secret taken out", async () => {
  const h = harness(createResponse(), fetched(["ready", null, "ready"]));
  await h.go();
  const out = readOutputs(h.output);
  assert.deepEqual(
    h.calls.map((c) => c.action),
    ["fetch", "logs", "logs"],
  );
  assert.deepEqual(h.calls[1], { action: "logs", batch_id: BATCH_ID, batch_token: "batch-token-1", index: 0 });
  assert.deepEqual(readdirSync(out.logs_dir).sort(), ["server-0.log", "server-2.log"]);
  assert.equal(readFileSync(join(out.logs_dir, "server-0.log"), "utf8"), "===== mattermost =====\nfull 0 ***\n");
  assert.deepEqual(servers(h), [
    {
      index: 0,
      instance_id: "i-0",
      path: join(out.logs_dir, "server-0.log"),
      full: true,
      containers: ["mattermost", "postgres"],
    },
    {
      index: 2,
      instance_id: "i-2",
      path: join(out.logs_dir, "server-2.log"),
      full: true,
      containers: ["mattermost", "postgres"],
    },
  ]);
  assert.ok(h.logged.includes("::add-mask::https://logs.example/0?sig=secret-0"), "the log URL is masked");
  assert.match(readFileSync(h.summary, "utf8"), /\| 0 \| `i-0` \| mattermost, postgres \| the full log \|/);
  assert.deepEqual(Object.keys(out).sort(), [...LOGS_OUTPUTS]);
  assert.equal(out.artifact_name, "e2e-test-stack-logs-ios-2");
});

test("no more than a few servers are collected at once", async () => {
  const states = Array.from({ length: 10 }, () => "ready");
  const h = harness(createResponse(), fetched(states));
  await h.go();
  assert.equal(servers(h).length, 10);
  assert.ok(h.peak <= LOGS_CONCURRENCY && h.peak > 1, `${h.peak} at once`);
});

test("a batch already gone, or with no server up, has no logs and passes", async () => {
  const gone = harness(createResponse(), refused(`no live instances tagged ${BATCH_ID}; it may already be destroyed`));
  await gone.go();
  assert.equal(readOutputs(gone.output).servers, "[]");
  assert.match(readFileSync(gone.summary, "utf8"), /The batch is gone: no logs to collect\./);

  const none = harness(createResponse(), fetched([null, null]));
  await none.go();
  assert.equal(readOutputs(none.output).servers, "[]");
  assert.equal(readOutputs(none.output).logs_dir, undefined);
  assert.equal(readOutputs(none.output).artifact_name, undefined);
});

test("a server that is not ready is collected too; its failure is noted, not the step's", async () => {
  const h = harness(createResponse(), fetched(["ready", "failed", "failed"]), { 2: logsReply(2, { no_object: true }) });
  await h.go();
  assert.deepEqual(
    servers(h).map((s) => [s.index, s.full]),
    [
      [0, true],
      [1, true],
      [2, false],
    ],
  );
  assert.match(readFileSync(h.summary, "utf8"), /- server 2: no log was found for it\. It was not ready\./);
});

test("a fetch that reports an error, or a batch not found, fails", async () => {
  await assert.rejects(
    harness(
      createResponse(),
      ok({ batch_id: BATCH_ID, error: "partial", batch: { state: "found", instances: [] } }),
    ).go(),
    /the fetch of batch mobile-42-ios-2-abc reported: partial/,
  );
  await assert.rejects(
    harness(createResponse(), ok({ batch_id: BATCH_ID, batch: { state: "expired", instances: [] } })).go(),
    /reported state "expired", not found/,
  );
});

test("a tail that cannot be unzipped is noted, and the full log is still downloaded", async () => {
  const h = harness(createResponse(), fetched(["ready"]), {
    0: logsReply(
      0,
      {},
      { url: "https://logs.example/0?sig=secret-0", content_gzip: Buffer.from("not gzip").toString("base64") },
    ),
  });
  await h.go();
  assert.equal(servers(h)[0].full, true);
  assert.equal(h.downloads.length, 1);
});

test("a full log that breaks off keeps the tail, reported and uploaded", async () => {
  const broken = new Response(
    new ReadableStream({
      start(c) {
        c.error(new Error("connection reset"));
      },
    }),
  );
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: broken });
  await assert.rejects(h.go(), /server 0: the full log was not saved: Error: connection reset\. The tail is saved\./);
  assert.deepEqual([servers(h)[0].instance_id, servers(h)[0].full], ["i-0", false]);
  assert.ok(readOutputs(h.output).logs_dir);
  assert.equal(readOutputs(h.output).artifact_name, "e2e-test-stack-logs-ios-2");
});

test("another run's logs are named for it", async () => {
  const h = harness(
    { ...createResponse("mobile-77-ios-1-abc") },
    fetched(["ready"]),
    {},
    {},
    {
      STACK_RUN_ID: "77",
      STACK_ALLOWED_WORKFLOWS: ".github/workflows/e2e.yml",
      STACK_ALLOWED_BRANCHES: "main",
      STACK_ALLOWED_EVENTS: "push",
    },
  );
  await h.go();
  assert.equal(readOutputs(h.output).artifact_name, "e2e-test-stack-logs-ios-run-77-2");
});

test("a run with no batch has no logs, and assumes no role", async () => {
  const none = harness(undefined, fetched([]));
  await none.go();
  assert.equal(none.stsCalls, 0);
  assert.equal(readOutputs(none.output).servers, "[]");
  const noBatch = harness({ error: "capacity" }, fetched([]));
  await noBatch.go();
  assert.equal(noBatch.stsCalls, 0);
  assert.match(readFileSync(noBatch.summary, "utf8"), /has no batch `ios`: no logs to collect/);
});

test("a fetch refused for another reason, or a response naming another batch, fails", async () => {
  await assert.rejects(
    harness(createResponse(), refused("throttled")).go(),
    /the fetch of batch mobile-42-ios-2-abc was refused: throttled/,
  );
  await assert.rejects(
    harness(createResponse("mobile-41-ios-1-abc"), fetched(["ready"])).go(),
    /names batch "mobile-41-ios-1-abc", which is not this run's batch ios/,
  );
});

test("a full log that does not download keeps the tail, scrubbed, and fails without quoting the URL", async () => {
  const h = harness(
    createResponse(),
    fetched(["ready", "ready"]),
    {},
    { 1: new Response("denied secret-1", { status: 403 }) },
  );
  await assert.rejects(h.go(), (e: unknown) => {
    const message = (e as Error).message;
    return (
      /server 1: the full log was not saved: the download answered HTTP 403\. The tail is saved\./.test(message) &&
      !message.includes("sig=")
    );
  });
  const out = readOutputs(h.output);
  assert.equal(readFileSync(join(out.logs_dir, "server-1.log"), "utf8"), "tail 1 ***");
  assert.deepEqual(
    servers(h).map((s) => [s.index, s.full]),
    [
      [0, true],
      [1, false],
    ],
  );
  assert.match(readFileSync(h.summary, "utf8"), /\| 1 \| `i-1` \| mattermost, postgres \| the tail, truncated \|/);
});

test("a full log over the limit is refused by its declared length, keeping the tail", async () => {
  const big = new Response("x", { headers: { "content-length": String(300 << 20) } });
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: big });
  await assert.rejects(
    h.go(),
    /server 0: the full log was not saved: the full log is too large: \d+ bytes, more than \d+\. The tail is saved\./,
  );
});

test("a server whose logs call is refused, finds no log, or has neither URL nor a whole tail fails alone", async () => {
  const h = harness(createResponse(), fetched(["ready", "ready", "ready", "ready"]), {
    0: refused("instance not ready"),
    1: logsReply(1, { no_object: true }),
    2: logsReply(2, {}, { content_gzip: gzipSync("tail 2").toString("base64") }),
  });
  await assert.rejects(
    h.go(),
    /server 0: the logs call was refused: instance not ready; server 1: no log was found for it\.; server 2: the control plane returned no URL for its full log, and the tail is truncated\./,
  );
  assert.equal(servers(h).find((s) => s.index === 3)?.full, true, "server 3 is still collected");
});

test("a whole tail with no URL is the full log", async () => {
  const h = harness(createResponse(), fetched(["ready"]), {
    0: logsReply(0, { truncated: false }, { content_gzip: gzipSync("whole admin-pw-0").toString("base64") }),
  });
  await h.go();
  assert.deepEqual([servers(h)[0].full, readFileSync(servers(h)[0].path, "utf8")], [true, "whole ***"]);
  assert.equal(h.downloads.length, 0);
});

test("logs refuses a missing or malformed input before anything is called", () => {
  const env = {
    GITHUB_REPOSITORY: "mattermost/mobile",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    STACK_CALLER_KEY: "mobile",
    STACK_BATCH: "ios",
    STACK_ROLE_ARN: ROLE_ARN,
    STACK_CREDENTIALS_KEY: CREDENTIALS_KEY,
    STACK_GITHUB_TOKEN: "t",
  };
  assert.equal(readLogsInputs(env).artifactPrefix, "e2e-test-stack-logs");
  const refusedInput = (over: Record<string, string>, message: RegExp) =>
    assert.throws(() => readLogsInputs({ ...env, ...over }), message);
  refusedInput({ STACK_ARTIFACT_PREFIX: "a/b" }, /artifact-prefix must be/);
  refusedInput({ STACK_ROLE_ARN: "" }, /role-arn is required/);
  refusedInput({ STACK_RUN_ID: "77" }, /allowed-workflows, allowed-branches and allowed-events are required/);
});

test("logs writes every output it declares, and action.yml reads exactly those", () => {
  const yml = readFileSync(new URL("../logs/action.yml", import.meta.url), "utf8");
  const read = new Set([...yml.matchAll(/steps\.logs\.outputs\.([\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), [...LOGS_OUTPUTS]);
});

test("the full log is scrubbed as it streams, a secret split across chunks included, and the account id with it", async () => {
  const encoder = new TextEncoder();
  const parts = [
    "===== mattermost =====\nlogin admin-p",
    "w-0 ok\nbucket 111111111111 size 123456789012\n",
    "last line",
  ];
  const stream = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(encoder.encode(p));
      c.close();
    },
  });
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: new Response(stream) });
  await h.go();
  assert.equal(
    readFileSync(servers(h)[0].path, "utf8"),
    "===== mattermost =====\nlogin *** ok\nbucket *** size 123456789012\nlast line",
  );
});

test("a full log that grows past the limit as it streams is stopped, and the tail kept", async () => {
  const chunk = new Uint8Array(1 << 20).fill(120);
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      sent++;
      c.enqueue(chunk);
      if (sent > 300) c.close();
    },
  });
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: new Response(stream) });
  await assert.rejects(
    h.go(),
    /server 0: the full log was not saved: the full log is too large: its body, more than \d+\. The tail is saved\./,
  );
  assert.ok(sent < 300, "the download stops at the limit");
  assert.equal(readFileSync(servers(h)[0].path, "utf8"), "tail 0 ***");
  assert.ok(!existsSync(`${servers(h)[0].path}.partial`));
});

test("a secret only the fetch carries is taken out of the logs too", async () => {
  const fetchedWithSecrets = ok({
    batch_id: BATCH_ID,
    batch: {
      state: "found",
      instances: [{ instance_id: "i-0", state: "ready" }],
      secrets: seal({ instances: [{ admin_password: "rotated-pw-0" }] }),
    },
  });
  const h = harness(createResponse(), fetchedWithSecrets, {}, { 0: new Response("seen rotated-pw-0\n") });
  await h.go();
  assert.equal(readFileSync(servers(h)[0].path, "utf8"), "seen ***\n");
});

test("no URL and a tail that could not be saved says why", async () => {
  const h = harness(createResponse(), fetched(["ready"]), {
    0: logsReply(0, {}, { content_gzip: Buffer.from("not gzip").toString("base64") }),
  });
  await assert.rejects(
    h.go(),
    /server 0: the control plane returned no URL for its full log\. The tail was not saved: /,
  );
});

test("a multi-line secret is taken out whole, its short lines included", async () => {
  const pem = "-----BEGIN KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\nAB==\n-----END KEY-----";
  const created = createResponse();
  created.batch.secrets = seal({
    batch_token: "batch-token-1",
    instances: [{ admin_password: "admin-pw-0", credentials: { "tls.key": pem } }],
  });
  const h = harness(created, fetched(["ready"]), {}, { 0: new Response(`key:\n${pem}\nafter\n`) });
  await h.go();
  assert.equal(readFileSync(servers(h)[0].path, "utf8"), "key:\n***\nafter\n");
});

test("a full log that is empty, or has no body, keeps the tail and fails", async () => {
  for (const response of [new Response(""), new Response(null)]) {
    const h = harness(createResponse(), fetched(["ready"]), {}, { 0: response });
    await assert.rejects(
      h.go(),
      /server 0: the full log was not saved: the download (is empty|has no body)\. The tail is saved\./,
    );
    assert.equal(readFileSync(servers(h)[0].path, "utf8"), "tail 0 ***");
  }
});

test("a line longer than a block is written in parts, and the rest of the log follows", async () => {
  const long = "x".repeat(3 << 20);
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: new Response(`${long}\nadmin-pw-0 end\n`) });
  await h.go();
  assert.equal(readFileSync(servers(h)[0].path, "utf8"), `${long}\n*** end\n`);
});

test("each server's log URL is taken out of its own log", async () => {
  const h = harness(
    createResponse(),
    fetched(["ready"]),
    {},
    { 0: new Response("fetched https://logs.example/0?sig=secret-0\n") },
  );
  await h.go();
  assert.equal(readFileSync(servers(h)[0].path, "utf8"), "fetched ***\n");
});

test("a cut falls after a line break or whitespace, never inside a secret, an ARN or a character", () => {
  const s = scrubber(["secret-value", "line one\nline two"]);
  const text = "aaaaaaaaaa secret-value b arn:aws:iam::123456789012:role/x c";
  assert.equal(s.cut(text, 15), 11, "inside the secret: back to the whitespace before it");
  const arnAt = text.indexOf("arn:");
  assert.equal(s.cut(text, arnAt + 5), arnAt, "inside the ARN: back to the whitespace before it");
  assert.equal(s.cut("ab\ncd ef", 8), 3, "a line break in reach is preferred");
  const multi = "x line one\nline two y";
  assert.equal(s.cut(multi, multi.indexOf("\n") + 1), 2, "inside a multi-line secret: back to before it");
  assert.equal(s.cut("zzzzsecret-valuezz", 8), 4, "no whitespace: back to the secret's start");
  assert.equal(s.cut("zz\u{1F600}zz", 3), 2, "never between a character's halves");
  assert.equal(s.hold, "line one\nline two".length);
});

test("a long log with no line breaks keeps every secret out, wherever the blocks are cut", async () => {
  // Mostly secret, in 64 KiB chunks as a download arrives, so nearly every cut would fall inside one.
  const unit = "zadmin-pw-0";
  const body = unit.repeat(300_000);
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(c) {
      for (let at = 0; at < bytes.length; at += 65536) c.enqueue(bytes.slice(at, at + 65536));
      c.close();
    },
  });
  const h = harness(createResponse(), fetched(["ready"]), {}, { 0: new Response(stream) });
  await h.go();
  const saved = readFileSync(servers(h)[0].path, "utf8");
  assert.ok(!saved.includes("admin-pw") && !saved.includes("pw-0"));
  assert.equal(saved, "z***".repeat(300_000));
});
