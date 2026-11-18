// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import sodium from "libsodium-wrappers";
import { readInputs } from "./inputs.ts";
import { lambdaClientConfig, lambdaInvoke, THROTTLE_ATTEMPTS } from "./lambda.ts";
import { openSealed, SealedError } from "./sealed.ts";
import { buildRequest, downloadLog, MAX_LOG_BYTES, run, writeOutputs } from "./stack.ts";
import type { Download, InvokeInput, InvokeOutput } from "./stack.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const other = sodium.crypto_box_keypair();
const PRIVATE_KEY = Buffer.from(keys.privateKey).toString("base64");
const seal = (value: unknown, publicKey = keys.publicKey): string =>
  Buffer.from(sodium.crypto_box_seal(JSON.stringify(value), publicKey)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-test-"));
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
    while (lines[++i] !== m[2]) value.push(lines[i]);
    out[m[1]] = value.join("\n");
  }
  return out;
};

const SECRETS = {
  batch_token: "batch-token-1",
  instances: [
    {
      admin_password: "admin-pw-0",
      mail_token: "mail-0",
      credentials: {
        "postgres.user": "mmuser",
        "postgres.database": "mattermost",
        "postgres.password": "pg-pw-0",
        "minio.secret_key": "minio-0",
      },
      facts: { "openldap.bind_dn": "cn=admin,dc=mm,dc=test", "openldap.bind_password": "ldap-pw-0" },
    },
    null,
  ],
};
const lease = (i: number) => ({
  instance_id: `pr-1234-abc-0${i}`,
  state: "ready",
  site_url: `https://pr-1234-abc-0${i}.test.example`,
  admin: { username: "sysadmin", email: "sysadmin@sample.mattermost.com" },
});
const createResponse = (over: Record<string, unknown> = {}) => ({
  batch_id: "pr-1234-abc",
  sites: ["https://pr-1234-abc-00.test.example", ""],
  error: "1 of 2 instances failed: [1]",
  deployment: { build: "lambda/abc/lambda.zip", version: "7", invoked: "test-public-project-v1" },
  batch: {
    state: "failed",
    ready: 1,
    expires_at: "2026-11-17T13:00:00Z",
    instances: [lease(0), null],
    secrets: seal(SECRETS),
  },
  ...over,
});

interface Harness {
  calls: InvokeInput[];
  regions: string[];
  logged: string[];
  output: string;
  summary: string;
  go: () => Promise<void>;
}
const harness = (
  env: Record<string, string>,
  reply: InvokeOutput | ((input: InvokeInput) => InvokeOutput),
  download: Download = () => Promise.reject(new Error("this test downloads nothing")),
): Harness => {
  const h: Harness = {
    calls: [],
    regions: [],
    logged: [],
    output: file("output"),
    summary: file("summary"),
    go: () =>
      run({
        env: {
          GITHUB_OUTPUT: h.output,
          GITHUB_STEP_SUMMARY: h.summary,
          RUNNER_TEMP: dir,
          STACK_CALLER_RUN_ID: "1234567890",
          ...env,
        },
        connect: (region) => {
          h.regions.push(region);
          return async (input) => {
            h.calls.push(input);
            return typeof reply === "function" ? reply(input) : reply;
          };
        },
        download,
        log: (m) => h.logged.push(m),
      }),
  };
  return h;
};
const ok = (body: unknown): InvokeOutput => ({
  StatusCode: 200,
  Payload: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
});
const masks = (h: Harness) =>
  h.logged.filter((l) => l.startsWith("::add-mask::")).map((l) => l.slice("::add-mask::".length));
const createEnv = (over: Record<string, string> = {}) => ({
  STACK_OPERATION: "create",
  STACK_CALLER_KEY: "test-public-project",
  STACK_PRIVATE_KEY: PRIVATE_KEY,
  STACK_INSTANCE_KEY: "pr-1234",
  STACK_SERVER_IMAGE: "mattermostdevelopment/mattermost-enterprise-edition:master",
  ...over,
});
const SECRET_VALUES = ["batch-token-1", "admin-pw-0", "mail-0", "pg-pw-0", "minio-0", "ldap-pw-0"];

test("each operation invokes the caller's own alias with the control plane's request JSON, naming no repository", () => {
  const base = { STACK_CALLER_KEY: "test-public-project", STACK_PRIVATE_KEY: PRIVATE_KEY, STACK_CALLER_RUN_ID: "42" };
  const created = buildRequest(
    readInputs({ ...base, ...createEnv(), STACK_CHANNEL: "edge", STACK_COUNT: "2", STACK_SERVER_ENV: '{"MM_X":"1"}' }),
  );
  assert.equal(created.functionName, "e2e-test-stack-edge");
  assert.equal(created.qualifier, "test-public-project-edge");
  assert.equal(
    JSON.stringify(created.payload),
    '{"action":"create","instance_key":"pr-1234","caller_run_id":"42","server_image":"mattermostdevelopment/mattermost-enterprise-edition:master","count":2,"server_env":{"MM_X":"1"}}',
  );
  const batch = { ...base, STACK_BATCH_ID: "pr-1234-abc", STACK_BATCH_TOKEN: "tok" };
  const fetched = buildRequest(
    readInputs({ ...batch, STACK_OPERATION: "fetch", STACK_INDEXES: "1,0", STACK_PROJECT: "other-stack" }),
    "pr-1234-abc",
    "tok",
  );
  assert.deepEqual([fetched.functionName, fetched.qualifier], ["other-stack-v1", "test-public-project-v1"]);
  assert.equal(
    JSON.stringify(fetched.payload),
    '{"action":"fetch","batch_id":"pr-1234-abc","batch_token":"tok","indexes":[1,0]}',
  );
  assert.equal(
    JSON.stringify(
      buildRequest(readInputs({ ...batch, STACK_OPERATION: "logs", STACK_INDEX: "0" }), "pr-1234-abc", "tok").payload,
    ),
    '{"action":"logs","batch_id":"pr-1234-abc","batch_token":"tok","index":0}',
  );
  assert.equal(
    JSON.stringify(buildRequest(readInputs({ ...batch, STACK_OPERATION: "logs" }), "pr-1234-abc", "tok").payload),
    '{"action":"logs","batch_id":"pr-1234-abc","batch_token":"tok"}',
  );
  assert.equal(
    JSON.stringify(buildRequest(readInputs({ ...batch, STACK_OPERATION: "destroy" }), "pr-1234-abc", "tok").payload),
    '{"action":"destroy","batch_id":"pr-1234-abc","batch_token":"tok"}',
  );
});

test("a create that came up whole sets every output, masks every secret first, and writes the raw response", async () => {
  const body = createResponse({
    error: undefined,
    sites: ["https://pr-1234-abc-00.test.example"],
    batch: {
      state: "ready",
      ready: 1,
      instances: [lease(0)],
      secrets: seal({ ...SECRETS, instances: [SECRETS.instances[0]] }),
    },
  });
  const raw = JSON.stringify(body);
  const responsePath = file("create.json");
  const h = harness(createEnv({ STACK_RESPONSE_PATH: responsePath, STACK_REGION: "us-west-2" }), ok(raw));
  await h.go();
  assert.deepEqual(h.regions, ["us-west-2"]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].FunctionName, "e2e-test-stack-v1");
  assert.equal(h.calls[0].Qualifier, "test-public-project-v1");
  assert.equal((JSON.parse(h.calls[0].Payload) as { caller_run_id: string }).caller_run_id, "1234567890");
  assert.equal(readFileSync(responsePath, "utf8"), raw);

  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.batch_token, "batch-token-1");
  assert.equal(out.sites, '["https://pr-1234-abc-00.test.example"]');
  assert.equal(out.ready, "1");
  assert.equal(out.state, "ready");
  assert.equal(out.error, "");
  assert.equal(out.deployment_version, "7");
  assert.equal(out.response_path, responsePath);
  assert.deepEqual(JSON.parse(out.instances), [
    {
      site_url: "https://pr-1234-abc-00.test.example",
      state: "ready",
      admin_username: "sysadmin",
      admin_email: "sysadmin@sample.mattermost.com",
      admin_password: "admin-pw-0",
      mail_token: "mail-0",
      credentials: SECRETS.instances[0]!.credentials,
      facts: SECRETS.instances[0]!.facts,
    },
  ]);

  // Every secret is masked; names that unlock nothing are not, or every line naming them would be redacted.
  assert.deepEqual(masks(h).sort(), [...SECRET_VALUES].sort());
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /### E2E test stack: create/);
  assert.match(summary, /\| Ready \| 1 of 1 \|/);
  for (const secret of SECRET_VALUES) {
    assert.ok(!summary.includes(secret), `summary carries ${secret}`);
    assert.ok(!h.logged.some((l) => !l.startsWith("::add-mask::") && l.includes(secret)), `log carries ${secret}`);
  }
});

test("a secret that differs inside JSON is masked in that form too", async () => {
  const secrets = { batch_token: "t", instances: [{ admin_password: 'a"b\\c' }] };
  const h = harness(
    createEnv(),
    ok(
      createResponse({
        error: undefined,
        sites: ["s"],
        batch: { state: "ready", instances: [lease(0)], secrets: seal(secrets) },
      }),
    ),
  );
  await h.go();
  assert.deepEqual(masks(h), ["t", 'a"b\\c', 'a\\"b\\\\c']);
});

test("a partial create still sets its outputs and writes the response, then fails naming the batch to destroy", async () => {
  const responsePath = file("partial.json");
  const h = harness(createEnv({ STACK_RESPONSE_PATH: responsePath }), ok(createResponse()));
  await assert.rejects(
    h.go(),
    /create reported: 1 of 2 instances failed: \[1\]\. Batch pr-1234-abc was created; destroy it\./,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.batch_token, "batch-token-1");
  assert.equal(out.state, "failed");
  assert.equal(out.error, "1 of 2 instances failed: [1]");
  assert.equal(out.sites, '["https://pr-1234-abc-00.test.example",""]');
  assert.equal((JSON.parse(out.instances) as unknown[])[1], null);
  assert.equal(out.response_path, responsePath);
  assert.ok(existsSync(responsePath));
  assert.match(readFileSync(h.summary, "utf8"), /\| 1 \| failed \| {2}\|/);
  assert.deepEqual(masks(h).sort(), [...SECRET_VALUES].sort());
});

test("a handler error fails the step with the control plane's message, and writes nothing but the response", async () => {
  const responsePath = file("refused.json");
  const h = harness(createEnv({ STACK_RESPONSE_PATH: responsePath }), {
    StatusCode: 200,
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode(
      '{"errorMessage":"ttl 5h0m0s is above the ceiling of 4h0m0s","errorType":"errorString"}',
    ),
  });
  await assert.rejects(
    h.go(),
    /the control plane refused the create: ttl 5h0m0s is above the ceiling of 4h0m0s\. A batch may have been created; it is reaped at its ttl\.$/,
  );
  assert.deepEqual(readOutputs(h.output), { response_path: responsePath });
});

test("a create reply with an error and no sealed secrets fails with the control plane's error", async () => {
  const h = harness(createEnv(), ok(createResponse({ batch: { state: "failed", ready: 0, instances: [null] } })));
  await assert.rejects(
    h.go(),
    /batch pr-1234-abc came back with no sealed secrets \(1 of 2 instances failed: \[1\]\)$/,
  );
  assert.equal(readOutputs(h.output).batch_id, "pr-1234-abc");
});

test("an invoke that fails names the action and the alias, keeps ARNs and accounts out, and warns that a create may have run", async () => {
  const denied = Object.assign(
    new Error(
      "User: arn:aws:sts::123456789012:assumed-role/e2e-test-stack-ci-mobile/x is not authorized to perform: lambda:InvokeFunction",
    ),
    { name: "AccessDeniedException" },
  );
  const h = harness(createEnv(), () => {
    throw denied;
  });
  await assert.rejects(h.go(), (e: unknown) => {
    const m = (e as Error).message;
    assert.equal(
      m,
      "e2e-test-stack: the invoke of e2e-test-stack-v1:test-public-project-v1 failed: AccessDeniedException: User: [arn] is not authorized to perform: lambda:InvokeFunction. A batch may have been created; it is reaped at its ttl.",
    );
    assert.ok(!m.includes("123456789012") && !m.includes("pr-1234"));
    return true;
  });
  const timeout = harness(
    {
      STACK_OPERATION: "destroy",
      STACK_CALLER_KEY: "mobile",
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "tok-1",
    },
    () => {
      throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    },
  );
  await assert.rejects(
    timeout.go(),
    /^Error: e2e-test-stack: the invoke of e2e-test-stack-v1:mobile-v1 failed: TimeoutError: socket hang up\.$/,
  );
});

test("secrets that do not open with the private key fail the create, after its batch id is set", async () => {
  const h = harness(
    createEnv(),
    ok(
      createResponse({
        error: undefined,
        batch: { state: "ready", instances: [lease(0)], secrets: seal(SECRETS, other.publicKey) },
      }),
    ),
  );
  await assert.rejects(
    h.go(),
    /batch pr-1234-abc: the sealed secrets did not open with private-key.*cannot be destroyed/,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.batch_token, undefined);
  assert.deepEqual(masks(h), []);
});

test("sealed boxes open with the private key alone, and not with another", async () => {
  assert.deepEqual(await openSealed(seal({ a: 1 }), keys.privateKey), { a: 1 });
  await assert.rejects(
    openSealed(seal({ a: 1 }), other.privateKey),
    (e: unknown) => e instanceof SealedError && /^e2e-test-stack: the sealed secrets did not open/.test(e.message),
  );
  await assert.rejects(openSealed("bm90IGEgYm94", keys.privateKey), SealedError);
});

test("fetch masks and returns the instances it asked for, holes kept", async () => {
  const h = harness(
    {
      STACK_OPERATION: "fetch",
      STACK_CALLER_KEY: "mobile",
      STACK_CHANNEL: "edge",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "batch-token-1",
      STACK_INDEXES: "0",
    },
    ok(
      createResponse({
        error: undefined,
        batch: {
          state: "ready",
          ready: 1,
          instances: [lease(0), null],
          secrets: seal({ instances: SECRETS.instances }),
        },
      }),
    ),
  );
  await h.go();
  assert.equal(h.calls[0].FunctionName, "e2e-test-stack-edge");
  assert.equal(h.calls[0].Qualifier, "mobile-edge");
  const out = readOutputs(h.output);
  assert.equal(out.batch_token, undefined);
  const instances = JSON.parse(out.instances) as ({ admin_password: string } | null)[];
  assert.equal(instances[0]?.admin_password, "admin-pw-0");
  assert.equal(instances[1], null);
  assert.deepEqual(masks(h).sort(), [...SECRET_VALUES].sort());
});

test("logs masks the URL, writes the full log it downloads, and summarizes without either", async () => {
  const tail = 'server  | {"level":"info","msg":"Server is listening"}\n';
  const full = `===== server =====\n${tail}`;
  const url = "https://bucket.s3.amazonaws.com/logs/x?X-Amz-Signature=abc";
  const downloaded: string[] = [];
  const h = harness(
    {
      STACK_OPERATION: "logs",
      STACK_CALLER_KEY: "mobile",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "batch-token-1",
      STACK_INDEX: "0",
    },
    ok({
      batch_id: "pr-1234-abc",
      sites: ["https://pr-1234-abc-00.test.example"],
      batch: { state: "ready", instances: [lease(0)] },
      logs: {
        instance_id: "pr-1234-abc-00",
        index: 0,
        containers: ["server"],
        lines: 1,
        bytes: 60,
        truncated: true,
        secrets: seal({ url, content_gzip: gzipSync(tail).toString("base64") }),
      },
    }),
    (u) => {
      downloaded.push(u);
      return Promise.resolve(full);
    },
  );
  await h.go();
  const out = readOutputs(h.output);
  assert.deepEqual(downloaded, [url]);
  assert.equal(out.logs_url, undefined);
  assert.ok(!readFileSync(h.output, "utf8").includes("X-Amz-Signature"));
  assert.equal(out.logs_path, join(dir, "e2e-test-stack-pr-1234-abc-0.log"));
  assert.equal(readFileSync(out.logs_path, "utf8"), full);
  assert.equal(out.logs_full, "true");
  assert.deepEqual(masks(h).sort(), ["batch-token-1", url].sort());
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /\| Tail \| 1 lines, 60 bytes, truncated \|/);
  assert.match(summary, /\| Saved \| the full log \|/);
  assert.ok(!summary.includes("X-Amz-Signature") && !summary.includes("Server is listening"));
});

test("logs with a create response takes every batch credential, ARNs and account ids out of the log", async () => {
  const responsePath = file("create.json");
  writeFileSync(responsePath, JSON.stringify(createResponse()));
  const tail = [
    "server  | login as sysadmin with admin-pw-0",
    "server  | pulled 123456789012.dkr.ecr.us-east-1.amazonaws.com/mattermost:master",
    "server  | role arn:aws:iam::123456789012:role/x refused",
    'postgres| password "pg-pw-0" for mmuser on mattermost',
    "inbucket| token mail-0, batch batch-token-1, ldap ldap-pw-0, minio minio-0",
    "",
  ].join("\n");
  const h = harness(
    {
      STACK_OPERATION: "logs",
      STACK_CALLER_KEY: "mobile",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_CREATE_RESPONSE: responsePath,
      STACK_INDEX: "0",
      STACK_LOGS_PATH: file("tail.log"),
    },
    ok({
      batch_id: "pr-1234-abc",
      logs: {
        instance_id: "pr-1234-abc-00",
        index: 0,
        lines: 5,
        bytes: tail.length,
        secrets: seal({ url: "https://bucket/x?sig", content_gzip: gzipSync("tail\n").toString("base64") }),
      },
    }),
    () => Promise.resolve(tail),
  );
  await h.go();
  assert.equal(
    readFileSync(readOutputs(h.output).logs_path, "utf8"),
    [
      "server  | login as sysadmin with ***",
      "server  | pulled [account].dkr.ecr.us-east-1.amazonaws.com/mattermost:master",
      "server  | role [arn] refused",
      'postgres| password "***" for mmuser on mattermost',
      "inbucket| token ***, batch ***, ldap ***, minio ***",
      "",
    ].join("\n"),
  );
});

test("a full log that does not download leaves the scrubbed tail and fails the step", async () => {
  const h = harness(
    {
      STACK_OPERATION: "logs",
      STACK_CALLER_KEY: "mobile",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "batch-token-1",
      STACK_INDEX: "1",
    },
    ok({
      batch_id: "pr-1234-abc",
      logs: {
        instance_id: "pr-1234-abc-01",
        index: 1,
        truncated: true,
        secrets: seal({
          url: "https://bucket/x?sig",
          content_gzip: gzipSync("token batch-token-1\n").toString("base64"),
        }),
      },
    }),
    () => Promise.reject(new TypeError("Failed to parse URL from https://bucket/x?sig")),
  );
  await assert.rejects(h.go(), (e: Error) => {
    assert.equal(
      e.message,
      "e2e-test-stack: the full log of instance 1 was not saved: the download failed: TypeError: Failed to parse URL from ***. logs-path holds the tail.",
    );
    return true;
  });
  const out = readOutputs(h.output);
  assert.equal(readFileSync(out.logs_path, "utf8"), "token ***\n");
  assert.equal(out.logs_full, "false");
  assert.match(readFileSync(h.summary, "utf8"), /\| Saved \| the tail; not the full log \|/);
});

test("a truncated tail with no URL for the full log fails the step, with the control plane's error", async () => {
  const h = harness(
    {
      STACK_OPERATION: "logs",
      STACK_CALLER_KEY: "mobile",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "batch-token-1",
    },
    ok({
      batch_id: "pr-1234-abc",
      error: "url unavailable",
      logs: { index: 0, truncated: true, secrets: seal({ content_gzip: gzipSync("end\n").toString("base64") }) },
    }),
  );
  await assert.rejects(
    h.go(),
    /no URL for it, and the tail is truncated\. logs-path holds the tail\. The logs call also reported: url unavailable\./,
  );
  const out = readOutputs(h.output);
  assert.equal(readFileSync(out.logs_path, "utf8"), "end\n");
  assert.equal(out.logs_full, "false");
});

test("the full log download refuses a redirect, an error status and a log over the limit", async () => {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.once("data", (d) => {
      const path = d.toString().split(" ")[1];
      const reply: Record<string, string> = {
        "/ok": "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        "/redirect": "HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "/denied": "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "/big": `HTTP/1.1 200 OK\r\nContent-Length: ${MAX_LOG_BYTES + 1}\r\nConnection: close\r\n\r\n`,
      };
      s.end(reply[path] ?? reply["/denied"]);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await downloadLog(`${base}/ok`), "hello");
    await assert.rejects(downloadLog(`${base}/redirect`));
    await assert.rejects(downloadLog(`${base}/denied`), /answered 403/);
    await assert.rejects(downloadLog(`${base}/big`), /more than/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a response-path that cannot be written fails the create after its batch id and token are set", async () => {
  const notADirectory = file("plain");
  writeFileSync(notADirectory, "");
  const responsePath = join(notADirectory, "create.json");
  const body = createResponse({
    error: undefined,
    sites: ["https://pr-1234-abc-00.test.example"],
    batch: { state: "ready", ready: 1, instances: [lease(0)], secrets: seal(SECRETS) },
  });
  const h = harness(createEnv({ STACK_RESPONSE_PATH: responsePath }), ok(body));
  await assert.rejects(
    h.go(),
    /response-path .*create\.json could not be written: .*\. Batch pr-1234-abc was created; destroy it\.$/,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.batch_token, "batch-token-1");
  assert.equal(out.response_path, undefined);
});

test("a response-path that cannot be written is reported with any other failure", async () => {
  const unwritable = () => {
    const notADirectory = file("plain");
    writeFileSync(notADirectory, "");
    return join(notADirectory, "create.json");
  };
  const refused = harness(createEnv({ STACK_RESPONSE_PATH: unwritable() }), {
    StatusCode: 200,
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode('{"errorMessage":"no capacity"}'),
  });
  await assert.rejects(
    refused.go(),
    /refused the create: no capacity\..* Also, response-path .* could not be written: /,
  );

  const partial = harness(createEnv({ STACK_RESPONSE_PATH: unwritable() }), ok(createResponse()));
  await assert.rejects(
    partial.go(),
    /create reported: 1 of 2 instances failed: \[1\]\. Batch pr-1234-abc was created; destroy it\. Also, response-path .* could not be written: /,
  );
  assert.equal(readOutputs(partial.output).batch_token, "batch-token-1");
});

test("a response error that is not a string is reported, and the batch is still handed back", async () => {
  const h = harness(createEnv(), ok(createResponse({ error: { code: "partial", failed: [1] } })));
  await assert.rejects(h.go(), /create reported: \{"code":"partial","failed":\[1\]\}\. Batch pr-1234-abc was created/);
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.batch_token, "batch-token-1");
});

test("ARNs and account ids in the control plane's errors are redacted wherever they are reported", async () => {
  const arn = "arn:aws:sts::123456789012:assumed-role/e2e-test-stack-control-plane/x";
  const refused = harness(createEnv(), {
    StatusCode: 200,
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: `${arn} is not authorized` })),
  });
  await assert.rejects(refused.go(), (e: Error) => {
    assert.match(e.message, /refused the create: \[arn\] is not authorized\./);
    assert.ok(!e.message.includes("123456789012"));
    return true;
  });

  const reported = harness(createEnv(), ok(createResponse({ error: `account 123456789012 refused: ${arn}` })));
  await assert.rejects(reported.go(), /create reported: account \[account\] refused: \[arn\]\./);
  assert.equal(readOutputs(reported.output).error, "account [account] refused: [arn]");
  const summary = readFileSync(reported.summary, "utf8");
  assert.ok(!summary.includes("123456789012") && !summary.includes("arn:aws"));
});

test("the Lambda client fails a call that runs past the request timeout, instead of only warning", async () => {
  // Accepts the connection, reads the request and never answers, as a stuck invoke would.
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const client = new LambdaClient({
    ...lambdaClientConfig("us-east-1", 300),
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example" },
  });
  try {
    await assert.rejects(
      client.send(new InvokeCommand({ FunctionName: "f", Qualifier: "q", Payload: new Uint8Array() })),
      (e: Error) => e.name === "TimeoutError",
    );
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("open reads every instance from a create response with the private key, masks first, and calls nothing", async () => {
  const responsePath = file("open.json");
  writeFileSync(responsePath, JSON.stringify(createResponse()));
  const h = harness(
    { STACK_OPERATION: "open", STACK_PRIVATE_KEY: PRIVATE_KEY, STACK_CREATE_RESPONSE: responsePath },
    () => assert.fail("open must not call the control plane"),
  );
  await h.go();
  assert.equal(h.calls.length, 0);
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, "pr-1234-abc");
  assert.equal(out.state, "failed");
  assert.equal(out.ready, "1");
  assert.equal(out.batch_token, undefined);
  assert.equal(out.admin_password, undefined);
  const instances = JSON.parse(out.instances) as ({ admin_password: string; site_url: string } | null)[];
  assert.equal(instances[0]?.admin_password, "admin-pw-0");
  assert.equal(instances[0]?.site_url, "https://pr-1234-abc-00.test.example");
  assert.equal(instances[1], null);
  assert.deepEqual(masks(h).sort(), [...SECRET_VALUES].sort());
});

test("open with an index sets that instance's fields as their own outputs, and fails for one that did not come up", async () => {
  const responsePath = file("open-index.json");
  writeFileSync(responsePath, JSON.stringify(createResponse()));
  const env = { STACK_OPERATION: "open", STACK_PRIVATE_KEY: PRIVATE_KEY, STACK_CREATE_RESPONSE: responsePath };
  const h = harness({ ...env, STACK_INDEX: "0" }, () => assert.fail("open must not call the control plane"));
  await h.go();
  const out = readOutputs(h.output);
  assert.equal(out.site_url, "https://pr-1234-abc-00.test.example");
  assert.equal(out.admin_username, "sysadmin");
  assert.equal(out.admin_password, "admin-pw-0");
  assert.equal(out.mail_token, "mail-0");
  assert.ok(masks(h).includes("admin-pw-0") && masks(h).includes("mail-0"));

  const failed = harness({ ...env, STACK_INDEX: "1" }, () => assert.fail("open must not call the control plane"));
  await assert.rejects(
    failed.go(),
    /batch pr-1234-abc has no ready instance 1 to open: it failed, or the batch has 2$/,
  );
  assert.equal(readOutputs(failed.output).batch_id, "pr-1234-abc");

  const other = harness(
    {
      STACK_OPERATION: "open",
      STACK_PRIVATE_KEY: Buffer.from(sodium.crypto_box_keypair().privateKey).toString("base64"),
      STACK_CREATE_RESPONSE: responsePath,
    },
    () => assert.fail("open must not call the control plane"),
  );
  await assert.rejects(other.go(), SealedError);
  assert.deepEqual(readOutputs(other.output), {});
});

test("open refuses an instance that is not ready, and names the file it cannot read or open", async () => {
  const notReady = file("open-not-ready.json");
  writeFileSync(
    notReady,
    JSON.stringify(
      createResponse({ batch: { ...createResponse().batch, instances: [lease(0), { ...lease(1), state: "failed" }] } }),
    ),
  );
  const env = { STACK_OPERATION: "open", STACK_PRIVATE_KEY: PRIVATE_KEY };
  const never = () => assert.fail("open must not call the control plane");
  const failed = harness({ ...env, STACK_CREATE_RESPONSE: notReady, STACK_INDEX: "1" }, never);
  await assert.rejects(failed.go(), /has no ready instance 1 to open/);

  const truncated = file("open-truncated.json");
  writeFileSync(truncated, '{"batch_id":');
  const bad = harness({ ...env, STACK_CREATE_RESPONSE: truncated }, never);
  await assert.rejects(bad.go(), new RegExp(`create-response ${truncated} could not be read as JSON: SyntaxError`));

  const other = harness(
    {
      ...env,
      STACK_PRIVATE_KEY: Buffer.from(sodium.crypto_box_keypair().privateKey).toString("base64"),
      STACK_CREATE_RESPONSE: notReady,
    },
    never,
  );
  await assert.rejects(other.go(), (e: Error) => {
    assert.ok(e instanceof SealedError);
    assert.match(
      e.message,
      /did not open with private-key; is it the key of the repository that created batch pr-1234-abc\?$/,
    );
    assert.ok(e.message.includes(notReady));
    return true;
  });
});

test("redaction keeps a 12-digit run inside a hyphenated name, and uses placeholders Markdown shows", async () => {
  const h = harness(
    createEnv(),
    ok(createResponse({ batch_id: "run-123456789012-abc", error: "account 123456789012 is over its quota" })),
  );
  await assert.rejects(
    h.go(),
    /reported: account \[account\] is over its quota\. Batch run-123456789012-abc was created/,
  );
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /run-123456789012-abc/);
  assert.match(summary, /account \[account\] is over its quota/);
});

test("a reply's batch id that is not one does not name the logs file", async () => {
  const h = harness(
    {
      STACK_OPERATION: "logs",
      STACK_CALLER_KEY: "mobile",
      STACK_PRIVATE_KEY: PRIVATE_KEY,
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "batch-token-1",
    },
    ok({
      batch_id: "../../escape",
      batch: { state: "ready", instances: [lease(0)] },
      logs: {
        instance_id: "pr-1234-abc-00",
        index: 0,
        secrets: seal({ content_gzip: gzipSync("x\n").toString("base64") }),
      },
    }),
  );
  await h.go();
  assert.equal(readOutputs(h.output).logs_path, join(dir, "e2e-test-stack-batch-0.log"));
});

test("destroy reads the batch and its sealed token from a create response, and fails on a partial destroy", async () => {
  const created = file("created.json");
  writeFileSync(created, JSON.stringify(createResponse()));
  const env = {
    STACK_OPERATION: "destroy",
    STACK_CALLER_KEY: "test-public-project",
    STACK_PRIVATE_KEY: PRIVATE_KEY,
    STACK_CREATE_RESPONSE: created,
  };
  const done = harness(
    env,
    ok({
      batch_id: "pr-1234-abc",
      sites: ["https://pr-1234-abc-00.test.example", ""],
      batch: { state: "destroyed", instances: [{ ...lease(0), state: "destroyed" }, null] },
    }),
  );
  await done.go();
  assert.equal(done.calls[0].Payload, '{"action":"destroy","batch_id":"pr-1234-abc","batch_token":"batch-token-1"}');
  assert.deepEqual(masks(done).sort(), [...SECRET_VALUES].sort());
  assert.equal(readOutputs(done.output).state, "destroyed");

  const partial = harness(
    env,
    ok({
      batch_id: "pr-1234-abc",
      error: "1 instance could not be stopped",
      batch: { state: "partially_destroyed", instances: [] },
    }),
  );
  await assert.rejects(partial.go(), /destroy reported: 1 instance could not be stopped\.$/);
  assert.equal(readOutputs(partial.output).state, "partially_destroyed");

  const mismatch = harness({ ...env, STACK_BATCH_ID: "pr-9-xyz" }, ok({}));
  await assert.rejects(mismatch.go(), /batch-id pr-9-xyz is not the batch in create-response \(pr-1234-abc\)/);
  assert.equal(mismatch.calls.length, 0);
});

test("a destroy with a batch token input masks it and needs no private key", async () => {
  const h = harness(
    {
      STACK_OPERATION: "destroy",
      STACK_CALLER_KEY: "mobile",
      STACK_BATCH_ID: "pr-1234-abc",
      STACK_BATCH_TOKEN: "tok-1",
    },
    ok({ batch_id: "pr-1234-abc", batch: { state: "not found" } }),
  );
  await h.go();
  assert.deepEqual(masks(h), ["tok-1"]);
  assert.equal(readOutputs(h.output).state, "not found");
});

test("outputs are written in the delimited form, so a multi-line value survives", () => {
  const path = file("outputs");
  writeOutputs(path, { a: "1", b: "x\ny" });
  assert.deepEqual(readOutputs(path), { a: "1", b: "x\ny" });
});

test("the Lambda client is sent a synchronous Invoke, and only a throttle is tried again", async () => {
  const sent: InvokeCommand[] = [];
  let throttles = 2;
  const waits: number[] = [];
  const invoke = lambdaInvoke(
    {
      send: async (command) => {
        sent.push(command);
        if (throttles-- > 0) throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
        return { StatusCode: 200, Payload: new TextEncoder().encode("{}") };
      },
    },
    async (ms) => void waits.push(ms),
    () => {},
  );
  const reply = await invoke({
    FunctionName: "e2e-test-stack-v1",
    Qualifier: "mobile-v1",
    Payload: '{"action":"fetch"}',
  });
  assert.equal(reply.StatusCode, 200);
  assert.equal(sent.length, 3);
  assert.ok(sent[0] instanceof InvokeCommand);
  assert.equal(sent[0].input.FunctionName, "e2e-test-stack-v1");
  assert.equal(sent[0].input.Qualifier, "mobile-v1");
  assert.equal(sent[0].input.InvocationType, "RequestResponse");
  assert.equal(new TextDecoder().decode(sent[0].input.Payload as Uint8Array), '{"action":"fetch"}');
  assert.deepEqual(waits, [10000, 20000]);

  let calls = 0;
  const denied = lambdaInvoke(
    {
      send: async () => {
        calls++;
        throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
      },
    },
    async () => {},
    () => {},
  );
  await assert.rejects(denied({ FunctionName: "f", Qualifier: "q", Payload: "{}" }), /not authorized/);
  assert.equal(calls, 1);

  calls = 0;
  const throttled = lambdaInvoke(
    {
      send: async () => {
        calls++;
        throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      },
    },
    async () => {},
    () => {},
  );
  await assert.rejects(throttled({ FunctionName: "f", Qualifier: "q", Payload: "{}" }), /Rate exceeded/);
  assert.equal(calls, THROTTLE_ATTEMPTS);
});
