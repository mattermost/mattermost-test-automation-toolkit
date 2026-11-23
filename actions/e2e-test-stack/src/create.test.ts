// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import sodium from "libsodium-wrappers";
import { ActionError } from "./core/errors.ts";
import type { InvokeInput, InvokeOutput } from "./core/lambda.ts";
import type { Credentials } from "./core/role.ts";
import { MASTER_IMAGE } from "./core/server-image.ts";
import { CREATE_OUTPUTS, createWith, readCreateInputs } from "./create.ts";
import type { CreateDeps } from "./create.ts";
import { ACTIONS } from "./run.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const other = sodium.crypto_box_keypair();
const CREDENTIALS_KEY = Buffer.from(keys.privateKey).toString("base64");
const seal = (value: unknown, publicKey = keys.publicKey): string =>
  Buffer.from(sodium.crypto_box_seal(JSON.stringify(value), publicKey)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-create-test-"));
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

const ROLE_ARN = "arn:aws:iam::111111111111:role/e2e-test-stack-ci-tpp";
const ID_TOKEN = "id-token-1";
const STS_CREDENTIALS = { AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "sts-secret-1", SessionToken: "sts-session-1" };

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
const SECRET_VALUES = ["batch-token-1", "admin-pw-0", "mail-0", "pg-pw-0", "minio-0", "ldap-pw-0"];
const AUTH_VALUES = [ID_TOKEN, "ASIAEXAMPLE", "sts-secret-1", "sts-session-1"];

const BATCH_ID = "tpp-42-ios-1-abc";
const lease = (i: number, over: Record<string, unknown> = {}) => ({
  instance_id: `${BATCH_ID}-0${i}`,
  state: "ready",
  site_url: `https://${BATCH_ID}-0${i}.test.example`,
  admin: { username: "sysadmin", email: "sysadmin@sample.mattermost.com" },
  ...over,
});
/** A create reply: a partial batch of two by default. */
const createResponse = (over: Record<string, unknown> = {}) => ({
  batch_id: BATCH_ID,
  sites: [`https://${BATCH_ID}-00.test.example`, ""],
  error: "1 of 2 instances failed: [1]",
  deployment: { build: "lambda/abc/lambda.zip", version: "7", invoked: "tpp-v1" },
  batch: {
    state: "failed",
    ready: 1,
    expires_at: "2026-11-17T13:00:00Z",
    instances: [lease(0), null],
    secrets: seal(SECRETS),
  },
  ...over,
});
/** A create reply for one server that came up. */
const readyResponse = (over: Record<string, unknown> = {}) =>
  createResponse({
    error: undefined,
    sites: [`https://${BATCH_ID}-00.test.example`],
    batch: {
      state: "ready",
      ready: 1,
      instances: [lease(0)],
      secrets: seal({ ...SECRETS, instances: [SECRETS.instances[0]] }),
    },
    ...over,
  });
/** A fetch reply finding n servers, each ready. */
const found = (n = 1) => ({
  batch_id: BATCH_ID,
  sites: Array.from({ length: n }, (_, i) => `https://${BATCH_ID}-0${i}.test.example`),
  batch: {
    state: "found",
    ready: n,
    instances: Array.from({ length: n }, (_, i) => lease(i)),
    secrets: seal({ instances: [] }),
  },
});

const ok = (body: unknown): InvokeOutput => ({
  StatusCode: 200,
  Payload: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
});

type Reply = InvokeOutput | ((input: InvokeInput, signal?: AbortSignal) => InvokeOutput | Promise<InvokeOutput>);

interface Harness {
  calls: InvokeInput[];
  fetched: string[];
  sts: AssumeRoleWithWebIdentityCommand[];
  regions: string[];
  credentials: Credentials[];
  logged: string[];
  output: string;
  summary: string;
  temp: string;
  /** Overrides of create's dependencies, applied over the fakes. */
  deps: Partial<CreateDeps>;
  go: () => Promise<void>;
}

/** Runs create with a fake ID token endpoint, GitHub, STS and control plane: create answers createReply, fetch fetchReply. */
const harness = (
  env: Record<string, string>,
  createReply: Reply,
  fetchReply: Reply = ok(found()),
  github: (url: string) => Response = (url) => {
    throw new Error(`this test calls no GitHub: ${url}`);
  },
): Harness => {
  const temp = file("runner-temp");
  mkdirSync(temp);
  const h: Harness = {
    calls: [],
    fetched: [],
    sts: [],
    regions: [],
    credentials: [],
    logged: [],
    output: file("output"),
    summary: file("summary"),
    temp,
    deps: {},
    go: () =>
      createWith({
        log: (m) => h.logged.push(m),
        sleep: async () => {},
        fetch: async (url) => {
          h.fetched.push(url);
          if (url.startsWith("https://token.actions.example/")) return Response.json({ value: ID_TOKEN });
          return github(url);
        },
        sts: (region) => {
          h.regions.push(region);
          return {
            send: async (command) => {
              h.sts.push(command);
              return { Credentials: STS_CREDENTIALS };
            },
          };
        },
        connect: (region, credentials) => {
          h.regions.push(region);
          h.credentials.push(credentials);
          return async (input, signal) => {
            h.calls.push(input);
            const reply =
              (JSON.parse(input.Payload) as { action: string }).action === "create" ? createReply : fetchReply;
            return typeof reply === "function" ? reply(input, signal) : reply;
          };
        },
        fetchTimeoutMs: 50,
        ...h.deps,
      })({
        GITHUB_OUTPUT: h.output,
        GITHUB_STEP_SUMMARY: h.summary,
        RUNNER_TEMP: h.temp,
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-1",
        ...createEnv(env),
      }),
  };
  return h;
};
const createEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  STACK_CALLER_KEY: "tpp",
  STACK_BATCH: "ios",
  STACK_ROLE_ARN: ROLE_ARN,
  STACK_CREDENTIALS_KEY: CREDENTIALS_KEY,
  STACK_SERVER_IMAGE: "mattermostdevelopment/mattermost-enterprise-edition:master",
  STACK_GITHUB_TOKEN: "gh-token",
  ...over,
});
const masks = (h: Harness) =>
  h.logged.filter((l) => l.startsWith("::add-mask::")).map((l) => l.slice("::add-mask::".length));
/** The response directories create made for batch, one per create that wrote a response. */
const responseDirs = (h: Harness, batch = "ios") =>
  readdirSync(h.temp)
    .filter((n) => new RegExp(`^e2e-test-stack-create-${batch}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(n))
    .map((n) => join(h.temp, n));
/** The one response directory create made for batch. */
const responseDir = (h: Harness, batch = "ios") => {
  const dirs = responseDirs(h, batch);
  assert.equal(dirs.length, 1, `one response directory for ${batch}`);
  return dirs[0];
};
const payloads = (h: Harness) => h.calls.map((c) => JSON.parse(c.Payload) as Record<string, unknown>);
const read = (env: Record<string, string>) =>
  readCreateInputs({ GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", ...createEnv(env) });
const refused = (env: Record<string, string>, message: RegExp) =>
  assert.throws(
    () => read(env),
    (e: unknown) => e instanceof ActionError && message.test(e.message),
  );

test("create is the bundle's create action", () => {
  assert.equal(typeof ACTIONS.create, "function");
});

test("the instance key is derived from the caller key, run, batch and attempt; ttl, os, postgres and license take their defaults", () => {
  const inputs = read({});
  assert.equal(inputs.channel, "v1");
  assert.equal(inputs.roleArn, ROLE_ARN);
  assert.deepEqual(inputs.credentialsKey, keys.privateKey);
  assert.deepEqual(inputs.fields, {
    instance_key: "tpp-42-ios-1",
    caller_run_id: "42",
    server_image: "",
    ttl: "2h",
    os: "ubuntu-24.04",
    postgres: "16",
    license: "enterprise-advanced",
  });
  const other = "arn:aws:iam::222222222222:role/e2e-test-stack-ci-tpp";
  assert.equal(read({ STACK_ROLE_ARN: other }).roleArn, other, "the role ARN is used as given, whatever its account");
});

test("license runs unlicensed when set empty, and is enterprise-advanced when unset or given", () => {
  assert.equal(read({ STACK_LICENSE: "" }).fields.license, undefined);
  assert.equal(read({}).fields.license, "enterprise-advanced");
  assert.equal(read({ STACK_LICENSE: "enterprise-advanced" }).fields.license, "enterprise-advanced");
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  assert.match(yml, /\n {2}license:\n {4}description: [^\n]+\n {4}default: enterprise-advanced\n/);
});

test("os, postgres and ttl accept only what the deployment offers, naming it when refused", () => {
  assert.equal(read({ STACK_OS: "ubuntu-26.04" }).fields.os, "ubuntu-26.04");
  for (const v of ["14", "15", "16", "17", "18"]) assert.equal(read({ STACK_POSTGRES: v }).fields.postgres, v);
  for (const v of ["90m", "1h30m", "4h", "240m", "0.5h", ".5h", "1.h", "1.5h"])
    assert.equal(read({ STACK_TTL: v }).fields.ttl, v);
  for (const v of ["h", ".h", "1.5", "1h.", "-1h", "1d"]) refused({ STACK_TTL: v }, /^ttl must be a duration such as/);
  refused({ STACK_OS: "ubuntu-22.04" }, /^os must be ubuntu-24\.04 or ubuntu-26\.04, got "ubuntu-22\.04"$/);
  refused({ STACK_POSTGRES: "16.4" }, /^postgres must be 14, 15, 16, 17 or 18, got "16\.4"$/);
  refused({ STACK_POSTGRES: "13" }, /^postgres must be 14, 15, 16, 17 or 18, got "13"$/);
  refused({ STACK_LICENSE: "professional" }, /^license must be enterprise-advanced, got "professional"$/);
  refused({ STACK_TTL: "4h1s" }, /^ttl must be 4h or less, the control plane's ceiling, got "4h1s"$/);
  refused({ STACK_TTL: "5h" }, /ttl must be 4h or less/);
  refused({ STACK_TTL: "0s" }, /^ttl must be longer than 0, got "0s"$/);
  // As Go reads them: a fraction of a nanosecond is truncated.
  refused({ STACK_TTL: "0.5ns" }, /^ttl must be longer than 0, got "0\.5ns"$/);
  assert.equal(read({ STACK_TTL: "4h0.5ns" }).fields.ttl, "4h0.5ns");
  assert.equal(read({ STACK_TTL: "14400.0000000001s" }).fields.ttl, "14400.0000000001s");
});

test("the action's defaults for os, postgres and ttl are the ones create applies to an empty input", () => {
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  const fields = read({}).fields;
  for (const [name, value] of [
    ["os", fields.os],
    ["postgres", fields.postgres],
    ["ttl", fields.ttl],
  ])
    assert.match(yml, new RegExp(`\\n  ${name}:\\n    description: [^\\n]+\\n    default: "?${value}"?\\n`), name);
  for (const gone of ["account", "role-arn-prod", "role-arn-dev", "project", "region", "instance-type"])
    assert.ok(!new RegExp(`\\n  ${gone}:\\n`).test(yml), `action.yml has no ${gone} input`);
});

test("create carries every field it exposes, typed as the control plane reads them", () => {
  const inputs = read({
    STACK_CHANNEL: "edge",
    STACK_COUNT: "3",
    STACK_SERVICES: "minio, keycloak,\nopenldap",
    STACK_TTL: "1h30m",
    STACK_OS: "ubuntu-26.04",
    STACK_POSTGRES: "17",
    STACK_LICENSE: "enterprise-advanced",
    STACK_SERVER_ENV: '{"MM_FEATUREFLAGS_TESTFEATURE":"true"}',
    STACK_RETRIES: "-5",
    STACK_SHARED_ADMIN_PASSWORD: "true",
    STACK_WAIT_FOR_MIGRATIONS: "false",
  });
  assert.equal(inputs.channel, "edge");
  assert.deepEqual(inputs.fields, {
    instance_key: "tpp-42-ios-1",
    caller_run_id: "42",
    server_image: "",
    ttl: "1h30m",
    os: "ubuntu-26.04",
    postgres: "17",
    count: 3,
    services: ["minio", "keycloak", "openldap"],
    license: "enterprise-advanced",
    server_env: { MM_FEATUREFLAGS_TESTFEATURE: "true" },
    retries: -5,
    shared_admin_password: true,
    wait_for_migrations: false,
  });
});

test("create refuses a missing or malformed input, naming it", () => {
  refused({ STACK_BATCH: "" }, /batch is required/);
  for (const bad of ["iOS", "-ios", "ios-", "a".repeat(21), "ios_1"])
    refused({ STACK_BATCH: bad }, /^batch must be 1 to 20/);
  refused({ STACK_ROLE_ARN: "" }, /role-arn is required/);
  refused({ STACK_ROLE_ARN: "not-an-arn" }, /role-arn must be an IAM role ARN/);
  refused(
    { STACK_ROLE_ARN: "arn:aws:iam::111111111111:role/e2e-test-stack-ci-mobile" },
    /^role-arn names another role: this repository's CI role is e2e-test-stack-ci-tpp, for caller-key tpp$/,
  );
  refused({ STACK_CREDENTIALS_KEY: "" }, /credentials-key is required/);
  refused({ STACK_CREDENTIALS_KEY: Buffer.alloc(31).toString("base64") }, /credentials-key must be .* 32 bytes/);
  refused({ STACK_SERVER_IMAGE: "" }, /server-image is required/);
  refused({ STACK_SERVER_IMAGE: "a b" }, /server-image must be one image reference/);
  refused({ STACK_CALLER_KEY: "" }, /caller-key is required/);
  refused({ STACK_CHANNEL: "edge-v1" }, /channel must be v1 or edge/);
  refused({ STACK_COUNT: "0" }, /count must be 1 or more/);
  refused({ STACK_COUNT: "two" }, /count must be a whole number/);
  refused({ STACK_RETRIES: "1.5" }, /retries must be a whole number/);
  refused({ STACK_TTL: "1 hour" }, /ttl must be a duration/);
  refused({ STACK_OS: "ubuntu" }, /os must be ubuntu-24\.04 or ubuntu-26\.04/);
  refused({ STACK_POSTGRES: "latest" }, /postgres must be 14, 15, 16, 17 or 18/);
  refused({ STACK_LICENSE: "a b" }, /license must be enterprise-advanced/);
  refused({ STACK_SERVICES: "minio,Keycloak" }, /each of services must be/);
  refused({ STACK_SERVER_ENV: "MM_X=1" }, /server-env must be a JSON object/);
  refused({ STACK_SERVER_ENV: '["MM_X"]' }, /server-env must be a JSON object/);
  refused({ STACK_SERVER_ENV: '{"MM_X":true}' }, /server-env MM_X must be a string/);
  refused({ STACK_SERVER_ENV: '{"FOO":"1"}' }, /server-env key "FOO" is not a server setting/);
  refused({ STACK_SHARED_ADMIN_PASSWORD: "yes" }, /shared-admin-password must be "true" or "false"/);
  refused({ STACK_WAIT_FOR_MIGRATIONS: "1" }, /wait-for-migrations must be "true" or "false"/);
});

test("an instance key over the control plane's 44 characters is refused, naming its parts", () => {
  // tpp-12345678901-<batch>-1: 18 characters around the batch.
  const env = { STACK_BATCH: "a".repeat(20), GITHUB_RUN_ID: "12345678901", GITHUB_RUN_ATTEMPT: "1" };
  assert.equal(readCreateInputs({ ...createEnv(env) }).fields.instance_key.length, 38);
  assert.throws(
    () => readCreateInputs({ ...createEnv({ ...env, STACK_CALLER_KEY: "test-public" }) }),
    (e: unknown) =>
      e instanceof ActionError &&
      e.message ===
        "the instance key test-public-12345678901-aaaaaaaaaaaaaaaaaaaa-1, <caller-key>-<run id>-<batch>-<run attempt>, is 46 characters; the control plane takes at most 44. Shorten batch",
  );
  assert.throws(() => readCreateInputs(createEnv()), /GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be set/);
});

test("a create that came up whole assumes the role, sets every output, and masks every secret first", async () => {
  const raw = JSON.stringify(readyResponse());
  const h = harness({}, ok(raw));
  await h.go();

  // The ID token for STS, then the role, then the alias with those credentials, all in the control plane's region.
  assert.deepEqual(h.fetched, ["https://token.actions.example/id?api-version=2.0&audience=sts.amazonaws.com"]);
  assert.equal(h.sts.length, 1);
  assert.deepEqual(h.sts[0].input, {
    RoleArn: ROLE_ARN,
    RoleSessionName: "e2e-test-stack-create-42",
    WebIdentityToken: ID_TOKEN,
    DurationSeconds: 3600,
  });
  assert.deepEqual(h.regions, ["us-east-1", "us-east-1"]);
  assert.deepEqual(h.credentials, [
    { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "sts-secret-1", sessionToken: "sts-session-1" },
  ]);
  assert.deepEqual(
    h.calls.map((c) => [c.FunctionName, c.Qualifier]),
    [
      ["e2e-test-stack-v1", "tpp-v1"],
      ["e2e-test-stack-v1", "tpp-v1"],
    ],
  );
  assert.equal(
    h.calls[0].Payload,
    '{"action":"create","instance_key":"tpp-42-ios-1","caller_run_id":"42","server_image":"mattermostdevelopment/mattermost-enterprise-edition:master","ttl":"2h","os":"ubuntu-24.04","postgres":"16","license":"enterprise-advanced"}',
  );
  assert.deepEqual(payloads(h)[1], { action: "fetch", batch_id: BATCH_ID, batch_token: "batch-token-1" });

  const responsePath = join(responseDir(h), "e2e-test-stack-create.json");
  assert.equal(readFileSync(responsePath, "utf8"), raw);
  assert.deepEqual(readdirSync(responseDir(h)), ["e2e-test-stack-create.json"], "the response is the only file");
  assert.deepEqual(readOutputs(h.output), {
    server_image: "mattermostdevelopment/mattermost-enterprise-edition:master",
    response_path: responsePath,
    batch_id: BATCH_ID,
    sites: `["https://${BATCH_ID}-00.test.example"]`,
    state: "ready",
    indexes: "[0]",
  });

  // Every secret is masked; names that unlock nothing are not, or every line naming them would be redacted.
  assert.deepEqual(masks(h).sort(), [...AUTH_VALUES, ...SECRET_VALUES].sort());
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /### E2E test stack: create/);
  assert.match(summary, /\| Ready \| 1 of 1 \|/);
  assert.doesNotMatch(summary, /Account/);
  assert.match(summary, /\| Fetched \| found, 1 of 1 ready \|/);
  const output = readFileSync(h.output, "utf8");
  for (const secret of [...AUTH_VALUES, ...SECRET_VALUES, "request-token-1"]) {
    assert.ok(!summary.includes(secret), `summary carries ${secret}`);
    assert.ok(!output.includes(secret), `outputs carry ${secret}`);
    assert.ok(!h.logged.some((l) => !l.startsWith("::add-mask::") && l.includes(secret)), `log carries ${secret}`);
  }
  for (const text of [summary, output, h.logged.join("\n")])
    assert.ok(!text.includes("111111111111"), "no account id is written");
});

test("every mask is written before any output or summary line", async () => {
  const h = harness({}, ok(readyResponse()));
  const written: boolean[] = [];
  const go = createWith({
    log: (m) => {
      if (m.startsWith("::add-mask::")) written.push(existsSync(h.output) || existsSync(h.summary));
    },
    sleep: async () => {},
    fetch: async () => Response.json({ value: ID_TOKEN }),
    sts: () => ({ send: async () => ({ Credentials: STS_CREDENTIALS }) }),
    connect: () => async (input) =>
      (JSON.parse(input.Payload) as { action: string }).action === "create" ? ok(readyResponse()) : ok(found()),
  });
  await go({
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: h.temp,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r",
    GITHUB_OUTPUT: h.output,
    GITHUB_STEP_SUMMARY: h.summary,
    ...createEnv(),
  });
  assert.deepEqual(written, new Array<boolean>(AUTH_VALUES.length + SECRET_VALUES.length).fill(false));
  assert.ok(existsSync(h.output) && existsSync(h.summary));
});

test("a secret that differs inside JSON is masked in that form too", async () => {
  const secrets = { batch_token: "t", instances: [{ admin_password: 'a"b\\c' }] };
  const h = harness(
    {},
    ok(readyResponse({ batch: { state: "ready", instances: [lease(0)], secrets: seal(secrets) } })),
  );
  await h.go();
  assert.deepEqual(masks(h).slice(AUTH_VALUES.length), ["t", 'a"b\\c', 'a\\"b\\\\c']);
});

test("latest, esr and master are resolved to an image before the create; any other value is passed through", async () => {
  const releases = "https://api.github.com/repos/mattermost/mattermost/releases?per_page=100&page=1";
  const latest = harness({ STACK_SERVER_IMAGE: "latest" }, ok(readyResponse()), ok(found()), (url) => {
    assert.equal(url, releases);
    return Response.json([{ tag_name: "v11.1.2", draft: false, prerelease: false, body: "" }]);
  });
  await latest.go();
  assert.equal(payloads(latest)[0].server_image, "mattermost/mattermost-enterprise-edition:11.1.2");
  assert.equal(readOutputs(latest.output).server_image, "mattermost/mattermost-enterprise-edition:11.1.2");
  assert.deepEqual(latest.fetched.slice(0, 1), [releases]);

  const master = harness({ STACK_SERVER_IMAGE: "master" }, ok(readyResponse()));
  await master.go();
  assert.equal(payloads(master)[0].server_image, MASTER_IMAGE);

  const pinned = harness({ STACK_SERVER_IMAGE: "mattermost/mattermost-team-edition:10.11.3" }, ok(readyResponse()));
  await pinned.go();
  assert.equal(payloads(pinned)[0].server_image, "mattermost/mattermost-team-edition:10.11.3");
});

test("an image that cannot be resolved fails before the role is assumed or anything is created", async () => {
  const h = harness({ STACK_SERVER_IMAGE: "esr" }, ok(readyResponse()), ok(found()), () =>
    Response.json([{ tag_name: "v11.1.2", draft: false, prerelease: false, body: "" }]),
  );
  await assert.rejects(h.go(), /^ActionError: no ESR release among the 1 releases of mattermost\/mattermost$/);
  assert.deepEqual([h.sts.length, h.calls.length], [0, 0]);
  assert.deepEqual(responseDirs(h), []);
});

test("a create stopped before any batch is named still writes a summary saying so, and no batch id", async () => {
  const refusedInput = harness({ STACK_BATCH: "" }, ok(readyResponse()));
  await assert.rejects(refusedInput.go(), /batch is required/);
  assert.match(
    readFileSync(refusedInput.summary, "utf8"),
    /\| State \| failed before the create was sent, so no batch was created\. The step's error says why \|/,
  );
  assert.deepEqual(readOutputs(refusedInput.output), {});

  const refusedCreate = harness({}, { ...ok({ errorMessage: "capacity" }), FunctionError: "Unhandled" });
  await assert.rejects(refusedCreate.go(), /the control plane refused the create/);
  assert.match(
    readFileSync(refusedCreate.summary, "utf8"),
    /\| State \| failed, with no batch named; one may have been created, and is reaped at its ttl\. /,
  );
  assert.equal(readOutputs(refusedCreate.output).batch_id, undefined);
});

test("a job without id-token: write fails before anything is created, asking for it", async () => {
  // No ACTIONS_ID_TOKEN_REQUEST_* variables, as in a job without the permission.
  const h = harness({}, ok(readyResponse()));
  const env = {
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: h.temp,
    GITHUB_OUTPUT: h.output,
    ...createEnv(),
  };
  await assert.rejects(
    createWith({ log: () => {}, connect: () => async () => ok(readyResponse()) })(env),
    /id-token: write/,
  );
  // No response: nothing is uploaded.
  assert.equal(readOutputs(h.output).response_path, undefined);
});

test("a role that refuses this job fails before the create, with no ARN or account id", async () => {
  const h = harness({}, ok(readyResponse()));
  await assert.rejects(
    createWith({
      log: () => {},
      sleep: async () => {},
      fetch: async () => Response.json({ value: ID_TOKEN }),
      sts: () => ({
        send: async () => {
          throw Object.assign(new Error(`Not authorized to perform sts:AssumeRoleWithWebIdentity on ${ROLE_ARN}`), {
            name: "AccessDenied",
          });
        },
      }),
      connect: () => {
        throw new Error("nothing is invoked");
      },
    })({
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      RUNNER_TEMP: h.temp,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?x=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r",
      ...createEnv(),
    }),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /^could not assume role-arn with this job's GitHub OIDC token: AccessDenied: .* on \[arn\]\./);
      return !m.includes("111111111111");
    },
  );
});

test("a partial create still sets its outputs and writes the response, then fails naming the batch", async () => {
  const h = harness({}, ok(createResponse()));
  await assert.rejects(
    h.go(),
    (e: unknown) =>
      e instanceof ActionError &&
      e.message ===
        `create reported: 1 of 2 instances failed: [1]. Batch ${BATCH_ID} was created; it is reaped at its ttl.`,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, BATCH_ID);
  assert.equal(out.state, "failed");
  assert.equal(out.sites, `["https://${BATCH_ID}-00.test.example",""]`);
  assert.equal(out.indexes, undefined);
  assert.equal(out.response_path, join(responseDir(h), "e2e-test-stack-create.json"));
  assert.ok(existsSync(out.response_path));
  assert.match(readFileSync(h.summary, "utf8"), /\| 1 \| failed \| {2}\|/);
  assert.deepEqual(masks(h).sort(), [...AUTH_VALUES, ...SECRET_VALUES].sort());
  assert.equal(h.calls.length, 1, "a partial batch is not fetched");
});

test("a handler error fails with the control plane's message, and writes nothing but the response", async () => {
  const h = harness(
    {},
    {
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(
        '{"errorMessage":"ttl 5h0m0s is above the ceiling of 4h0m0s","errorType":"errorString"}',
      ),
    },
  );
  await assert.rejects(
    h.go(),
    /^ActionError: the control plane refused the create: ttl 5h0m0s is above the ceiling of 4h0m0s\. A batch may have been created; it is reaped at its ttl\.$/,
  );
  assert.deepEqual(Object.keys(readOutputs(h.output)).sort(), ["response_path", "server_image"]);
});

test("a create reply with an error and no sealed secrets fails with the control plane's error", async () => {
  const h = harness({}, ok(createResponse({ batch: { state: "failed", ready: 0, instances: [null] } })));
  await assert.rejects(
    h.go(),
    /batch tpp-42-ios-1-abc came back with no sealed secrets \(1 of 2 instances failed: \[1\]\)/,
  );
  assert.equal(readOutputs(h.output).batch_id, BATCH_ID);
});

test("an invoke that fails names the alias, keeps ARNs and accounts out, and warns that a batch may exist", async () => {
  const denied = Object.assign(
    new Error(
      "User: arn:aws:sts::123456789012:assumed-role/e2e-test-stack-ci-tpp/x is not authorized to perform: lambda:InvokeFunction",
    ),
    { name: "AccessDeniedException" },
  );
  const h = harness({}, () => {
    throw denied;
  });
  await assert.rejects(h.go(), (e: unknown) => {
    const m = (e as Error).message;
    assert.equal(
      m,
      "the invoke of e2e-test-stack-v1:tpp-v1 failed: AccessDeniedException: User: [arn] is not authorized to perform: lambda:InvokeFunction. A batch may have been created; it is reaped at its ttl.",
    );
    assert.ok(!m.includes("123456789012"));
    return true;
  });
  assert.equal(readOutputs(h.output).response_path, undefined);
});

test("secrets that do not open with the credentials key fail the create, after its batch id is set", async () => {
  const h = harness(
    {},
    ok(readyResponse({ batch: { state: "ready", instances: [lease(0)], secrets: seal(SECRETS, other.publicKey) } })),
  );
  await assert.rejects(
    h.go(),
    /^ActionError: batch tpp-42-ios-1-abc: the sealed secrets did not open with credentials-key.*cannot be destroyed; it is reaped at its ttl\.$/,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, BATCH_ID);
  assert.deepEqual(masks(h).sort(), [...AUTH_VALUES].sort());
});

test("secrets with no batch token fail the create: the batch cannot be destroyed", async () => {
  const h = harness(
    {},
    ok(readyResponse({ batch: { state: "ready", instances: [lease(0)], secrets: seal({ instances: [] }) } })),
  );
  await assert.rejects(h.go(), /secrets hold no batch token, so it cannot be destroyed; it is reaped at its ttl$/);
});

test("a ready create is fetched, and fails unless the control plane finds every server ready", async () => {
  const notFound = harness({}, ok(readyResponse()), ok({ batch_id: BATCH_ID, batch: { state: "not found" } }));
  await assert.rejects(
    notFound.go(),
    (e: unknown) =>
      e instanceof ActionError &&
      e.message ===
        `the fetch of batch ${BATCH_ID} found it not found with 0 of 1 servers ready, 0 listed; every server must be ready. Batch ${BATCH_ID} was created; it is reaped at its ttl.`,
  );
  const out = readOutputs(notFound.output);
  assert.equal(out.batch_id, BATCH_ID);
  assert.equal(out.state, "ready");
  assert.equal(out.indexes, undefined);
  assert.ok(out.response_path);

  const one = { ...found(2) };
  one.batch.instances[1] = lease(1, { state: "unhealthy" });
  const two = harness(
    { STACK_COUNT: "2" },
    ok(
      readyResponse({
        sites: [`https://${BATCH_ID}-00.test.example`, `https://${BATCH_ID}-01.test.example`],
        batch: { state: "ready", ready: 2, instances: [lease(0), lease(1)], secrets: seal(SECRETS) },
      }),
    ),
    ok(one),
  );
  await assert.rejects(two.go(), /found it found with 1 of 2 servers ready, 2 listed/);

  const refusedFetch = harness({}, ok(readyResponse()), {
    StatusCode: 200,
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode('{"errorMessage":"bad batch token"}'),
  });
  await assert.rejects(refusedFetch.go(), /the fetch of batch tpp-42-ios-1-abc was refused: bad batch token\. Batch/);

  const thrown = harness({}, ok(readyResponse()), () => {
    throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
  });
  await assert.rejects(
    thrown.go(),
    /fetch of batch .* through e2e-test-stack-v1:tpp-v1 failed: TimeoutError: socket hang up\./,
  );

  const errored = harness({}, ok(readyResponse()), ok({ ...found(), error: "lookup failed" }));
  await assert.rejects(errored.go(), /the fetch of batch .* reported: lookup failed\./);
});

test("count servers are created and fetched, and indexes counts them", async () => {
  const sites = [0, 1, 2].map((i) => `https://${BATCH_ID}-0${i}.test.example`);
  const h = harness(
    { STACK_COUNT: "3" },
    ok(
      readyResponse({
        sites,
        batch: { state: "ready", ready: 3, instances: [lease(0), lease(1), lease(2)], secrets: seal(SECRETS) },
      }),
    ),
    ok(found(3)),
  );
  await h.go();
  assert.equal(readOutputs(h.output).indexes, "[0,1,2]");
  assert.equal(payloads(h)[0].count, 3);

  const short = harness({ STACK_COUNT: "3" }, ok(readyResponse()));
  await assert.rejects(short.go(), /create returned 1 servers; 3 were asked for\. Batch/);
});

test("a create reporting a state other than ready, with no error, fails naming the batch", async () => {
  const h = harness(
    {},
    ok(readyResponse({ batch: { state: "pending", instances: [lease(0)], secrets: seal(SECRETS) } })),
  );
  await assert.rejects(
    h.go(),
    /^ActionError: create reported state pending, not ready\. Batch tpp-42-ios-1-abc was created/,
  );
  assert.equal(h.calls.length, 1);
});

test("a reply with no batch id fails, warning that a batch may exist", async () => {
  const h = harness({}, ok({ batch: { state: "ready" } }));
  await assert.rejects(
    h.go(),
    /^ActionError: create returned no batch id\. A batch may have been created; it is reaped at its ttl\.$/,
  );
  const notJson = harness({}, ok("<html>"));
  await assert.rejects(notJson.go(), /reply is not JSON: <html>\. A batch may have been created/);
});

test("create reports its duration, and each server's type, time to ready, slowest service and critical path", async () => {
  const timed = lease(0, {
    instance_type: "c7i.large",
    timing: { total_seconds: 202.724, phases: [{ name: "stack", seconds: 178.1 }] },
    service_seconds: { keycloak: 123.39, postgres: 127.9, server: 21.3 },
    image_pull_seconds: 27.401,
    critical_path: { chain: ["postgres", "pull server image", "server"], seconds: 176.64 },
    containers: [
      "e2e-postgres postgres:16",
      "e2e-keycloak keycloak:23.0.7",
      "e2e-mattermost mattermost-enterprise-edition@sha256:20b2",
    ],
    server_image: {
      ref: "*.ecr.*/dockerhub/mattermostdevelopment/mattermost-enterprise-edition:master",
      digest: "sha256:20b2",
      created_at: "2026-11-18T03:19:55Z",
      age: "53 minutes ago",
      source: "ecr-cache",
    },
    ami_name: "e2e-test-stack-ubuntu-24-04-2026-11-16T04-10-53.840Z",
  });
  const body = readyResponse({
    batch: { state: "ready", ready: 1, instances: [timed], secrets: seal(SECRETS), timing: { total_seconds: 233.615 } },
  });
  const h = harness({}, ok(body));
  await h.go();
  assert.equal(readOutputs(h.output).duration_seconds, "233.615");
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /\| Duration \| 233\.6 s, request to every server ready \|/);
  assert.match(
    summary,
    /\| Index \| State \| Site \| Type \| Ready in \| Image pull \| Slowest service \| Critical path \|/,
  );
  assert.match(
    summary,
    /\| 0 \| ready \| https:\/\/tpp-42-ios-1-abc-00\.test\.example \| c7i\.large \| 202\.7 s \| 27\.4 s \| postgres 127\.9 s \| postgres → pull server image → server, 176\.6 s \|/,
  );
  assert.match(
    summary,
    /\| Server image \| `mattermostdevelopment\/mattermost-enterprise-edition:master`, `sha256:20b2`, built 2026-11-18T03:19:55Z \(53 minutes ago\), from ecr-cache \|/,
  );
  assert.match(summary, /\| Host image \| `e2e-test-stack-ubuntu-24-04-2026-11-16T04-10-53\.840Z` \|/);
  assert.match(
    summary,
    /\| Container \| Image \|\n\|---\|---\|\n\| e2e-keycloak \| `keycloak:23\.0\.7` \|\n\| e2e-mattermost \| `mattermost-enterprise-edition@sha256:20b2` \|\n\| e2e-postgres \| `postgres:16` \|/,
  );
  // The batch's rows, the fetch's among them, come before the server table.
  assert.ok(summary.indexOf("| Fetched |") < summary.indexOf("| Index |"));
});

test("a failed create reports its time to failure, with no duration output and no time to ready", async () => {
  const failed = lease(0, { state: "failed", instance_type: "c7i.large", timing: { total_seconds: 90 } });
  const h = harness(
    {},
    ok(
      createResponse({
        batch: {
          ...createResponse().batch,
          state: "failed",
          ready: 0,
          instances: [failed],
          timing: { total_seconds: 95 },
        },
      }),
    ),
  );
  await assert.rejects(h.go());
  assert.equal(readOutputs(h.output).duration_seconds, undefined);
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /\| Duration \| 95\.0 s, request to failure \|/);
  assert.match(summary, /\| 0 \| failed \| [^|]+ \| c7i\.large \| {2}\|/);
});

test("a response that cannot be written fails the create after its batch id is set, and with any other failure", async () => {
  const blocked = (h: Harness) => {
    h.deps.writeResponse = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
  };
  const h = harness({}, ok(readyResponse()));
  blocked(h);
  await assert.rejects(
    h.go(),
    /^ActionError: the create response could not be written: .*\. Batch tpp-42-ios-1-abc was created; it is reaped at its ttl\.$/,
  );
  const out = readOutputs(h.output);
  assert.equal(out.batch_id, BATCH_ID);
  assert.equal(out.response_path, undefined);

  const partial = harness({}, ok(createResponse()));
  blocked(partial);
  await assert.rejects(
    partial.go(),
    /create reported: 1 of 2 instances failed: \[1\]\. Batch .* reaped at its ttl\. Also, the create response could not be written: /,
  );
});

test("a response directory that cannot be made, as the filesystem refuses it, fails after the batch id is set", async () => {
  const h = harness({}, ok(readyResponse()));
  // RUNNER_TEMP is a file, so no directory can be made under it, whoever runs the test.
  h.temp = file("not-a-directory");
  writeFileSync(h.temp, "");
  await assert.rejects(
    h.go(),
    /the create response could not be written: .*ENOTDIR.* Batch tpp-42-ios-1-abc was created/,
  );
  assert.equal(readOutputs(h.output).batch_id, BATCH_ID);
  assert.equal(readOutputs(h.output).response_path, undefined);
});

test("each create of the batch in a job writes its own response, leaving one already handed back", async () => {
  const first = harness({}, ok(readyResponse()));
  await first.go();
  const handedBack = readOutputs(first.output).response_path;
  const second = harness({}, ok(readyResponse()));
  second.temp = first.temp;
  await second.go();
  assert.ok(existsSync(handedBack), "the first response is still there");
  assert.notEqual(readOutputs(second.output).response_path, handedBack);
});

test("a response error that is not a string is reported, and the batch is still handed back", async () => {
  const h = harness({}, ok(createResponse({ error: { code: "partial", failed: [1] } })));
  await assert.rejects(
    h.go(),
    /create reported: \{"code":"partial","failed":\[1\]\}\. Batch tpp-42-ios-1-abc was created/,
  );
  assert.equal(readOutputs(h.output).batch_id, BATCH_ID);
});

test("ARNs and account ids in the control plane's errors are redacted wherever they are reported", async () => {
  const arn = "arn:aws:sts::123456789012:assumed-role/e2e-test-stack-control-plane/x";
  const refusedCreate = harness(
    {},
    {
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: `${arn} is not authorized` })),
    },
  );
  await assert.rejects(refusedCreate.go(), (e: Error) => {
    assert.match(e.message, /refused the create: \[arn\] is not authorized\./);
    assert.ok(!e.message.includes("123456789012"));
    return true;
  });

  const reported = harness({}, ok(createResponse({ error: `account 123456789012 refused: ${arn}` })));
  await assert.rejects(reported.go(), /create reported: account \[account\] refused: \[arn\]\./);
  const summary = readFileSync(reported.summary, "utf8");
  assert.ok(!summary.includes("123456789012") && !summary.includes("arn:aws"));
});

test("redaction keeps a 12-digit run inside a hyphenated name", async () => {
  const h = harness(
    {},
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

test("action.yml reads only the outputs create declares, and exposes each of them", () => {
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  const read = new Set([...yml.matchAll(/steps\.create\.outputs\.([\w-]+)/g)].map((m) => m[1]));
  const declared = new Set<string>(CREATE_OUTPUTS);
  for (const name of read)
    assert.ok(declared.has(name), `action.yml reads steps.create.outputs.${name}, which create does not declare`);
  for (const name of declared) assert.ok(read.has(name), `action.yml never reads ${name}`);
});

test("a create that came up whole writes every output it declares, and no other", async () => {
  const h = harness({}, ok(readyResponse()));
  await h.go();
  assert.deepEqual(
    Object.keys(readOutputs(h.output)).sort(),
    [...CREATE_OUTPUTS].filter((n) => n !== "duration_seconds"),
  );
});

test("a fetch that drops its connection or cannot resolve the host is tried again, and the create succeeds", async () => {
  let fetches = 0;
  const h = harness({}, ok(readyResponse()), () => {
    fetches++;
    if (fetches === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    if (fetches === 2) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return ok(found());
  });
  await h.go();
  assert.equal(fetches, 3);
  assert.ok(readOutputs(h.output).indexes, "indexes is set once every server is ready");
  assert.ok(h.logged.some((l) => /the fetch of batch .* trying again in 5 s \(attempt 2 of 3\)/.test(l)));
  assert.ok(h.logged.some((l) => /the fetch of batch .* trying again in 10 s \(attempt 3 of 3\)/.test(l)));
});

test("a fetch that gets no reply is abandoned at its timeout and tried again, at most three times", async () => {
  let fetches = 0;
  const hang = (_: InvokeInput, signal?: AbortSignal) =>
    new Promise<InvokeOutput>((_resolve, reject) => {
      fetches++;
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  await assert.rejects(
    harness({}, ok(readyResponse()), hang).go(),
    /the fetch of batch .* failed: got no reply in 0\.05 s\./,
  );
  assert.equal(fetches, 3);
});

test("secrets that open to something other than an object fail the create, naming the batch", async () => {
  for (const value of [null, "token", [1]]) {
    const h = harness(
      {},
      ok(readyResponse({ batch: { state: "ready", instances: [lease(0)], secrets: seal(value) } })),
    );
    await assert.rejects(
      h.go(),
      /batch tpp-42-ios-1-abc: the sealed secrets opened but are not an object\. .* reaped at its ttl\.$/,
    );
  }
  const odd = harness(
    {},
    ok(readyResponse({ batch: { state: "ready", instances: [lease(0)], secrets: seal({ instances: { a: 1 } }) } })),
  );
  await assert.rejects(odd.go(), /secrets hold no batch token/);
});

test("a fetch refused with a 4xx is not tried again", async () => {
  let fetches = 0;
  const h = harness({}, ok(readyResponse()), () => {
    fetches++;
    throw Object.assign(new Error("denied"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } });
  });
  await assert.rejects(h.go(), /the fetch of batch .* failed: AccessDeniedException: denied/);
  assert.equal(fetches, 1);
});

test("a summary that cannot be written does not hide the failure being reported", async () => {
  const summaryDir = file("summary-dir");
  mkdirSync(summaryDir);
  const h = harness({ GITHUB_STEP_SUMMARY: summaryDir }, ok(createResponse()));
  await assert.rejects(
    h.go(),
    (e: unknown) =>
      e instanceof ActionError &&
      e.message.startsWith("create reported: 1 of 2 instances failed") &&
      /Also, the summary could not be written/.test(e.message),
  );
  assert.equal(readOutputs(h.output).batch_id, BATCH_ID, "the outputs are still written");
});

test("a count or retries beyond a safe integer is refused before anything is called", () => {
  refused({ STACK_COUNT: "99999999999999999999" }, /count is out of range/);
  refused({ STACK_RETRIES: "-999999999999999999999" }, /retries is out of range/);
});

test("a reply that names a batch is uploaded as the batch's responses; one that names none under a name of its own", () => {
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  // Each upload step: its condition and the artifact it names.
  const uploads = [
    ...yml.matchAll(/- if: (.+)\n\s+uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: (\S+)/g),
  ].map((m) => [
    m[2],
    m[1].includes("batch_id != ''") ? "named" : m[1].includes("batch_id == ''") ? "unnamed" : "either",
    m[1].includes("response_path != ''"),
  ]);
  assert.deepEqual(uploads, [
    ["e2e-test-stack-response-${{", "named", true],
    ["e2e-test-stack-create-${{", "named", true],
    ["e2e-test-stack-unnamed-${{", "unnamed", true],
  ]);
});
