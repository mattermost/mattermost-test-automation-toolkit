// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sodium from "libsodium-wrappers";
import { createArtifact } from "./core/artifacts.ts";
import { zip } from "./core/zip.fixture.ts";
import { OPEN_OUTPUTS, openWith, readOpenInputs } from "./open.ts";
import { ACTIONS } from "./run.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const other = sodium.crypto_box_keypair();
const CREDENTIALS_KEY = Buffer.from(keys.privateKey).toString("base64");
const seal = (value: unknown, publicKey = keys.publicKey): string =>
  Buffer.from(sodium.crypto_box_seal(JSON.stringify(value), publicKey)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-open-test-"));
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

const BATCH_ID = "mobile-42-ios-1-abc";
const SECRETS = {
  batch_token: "batch-token-1",
  instances: [
    {
      admin_password: "admin-pw-0",
      mail_token: "mail-0",
      credentials: { "postgres.user": "mmuser", "postgres.password": "pg-pw-0" },
      facts: { "openldap.bind_dn": "cn=admin,dc=mm,dc=test", "openldap.bind_password": "ldap-pw-0" },
    },
    { admin_password: "admin-pw-1", mail_token: "mail-1" },
    null,
  ],
};
const SECRET_VALUES = ["batch-token-1", "admin-pw-0", "mail-0", "pg-pw-0", "ldap-pw-0", "admin-pw-1", "mail-1"];
const lease = (i: number, over: Record<string, unknown> = {}) => ({
  instance_id: `${BATCH_ID}-0${i}`,
  state: "ready",
  site_url: `https://${BATCH_ID}-0${i}.test.example`,
  admin: { username: "sysadmin", email: "sysadmin@sample.mattermost.com" },
  ...over,
});
/** A create response for three servers, the third failed. */
const response = (over: Record<string, unknown> = {}) => ({
  batch_id: BATCH_ID,
  sites: [`https://${BATCH_ID}-00.test.example`, `https://${BATCH_ID}-01.test.example`, ""],
  batch: {
    state: "failed",
    instances: [lease(0), lease(1), lease(2, { state: "failed", site_url: "" })],
    secrets: seal(SECRETS),
  },
  ...over,
});

const API = "https://api.github.com/repos/mattermost/mobile/actions";
const LISTING = `${API}/runs/42/artifacts?name=e2e-test-stack-create-ios&per_page=100&page=1`;
const BLOB = "https://storage.example/artifact.zip?sig=secret";
const archive = (body: unknown) =>
  zip([{ name: "e2e-test-stack-create.json", data: typeof body === "string" ? body : JSON.stringify(body) }]);

interface Harness {
  calls: { url: string; init?: RequestInit }[];
  logged: string[];
  output: string;
  go: () => Promise<void>;
}

/** Runs open against a fake GitHub that lists artifacts and serves the newest one's archive through a redirect. */
const harness = (
  env: Record<string, string> = {},
  zipBody: Buffer | null = archive(response()),
  artifacts: unknown[] = [{ id: 7, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T09:00:00Z" }],
  now = Date.parse("2026-11-21T10:00:00Z"),
): Harness => {
  const h: Harness = {
    calls: [],
    logged: [],
    output: file("output"),
    go: () =>
      openWith({
        log: (m) => h.logged.push(m),
        sleep: async () => {},
        now: () => now,
        fetch: async (url, init) => {
          h.calls.push({ url, init });
          if (url === LISTING) return Response.json({ total_count: artifacts.length, artifacts });
          if (url === `${API}/artifacts/7/zip`) return new Response(null, { status: 302, headers: { location: BLOB } });
          if (url === BLOB && zipBody) return new Response(new Uint8Array(zipBody));
          return new Response("", { status: 404 });
        },
      })({
        GITHUB_OUTPUT: h.output,
        GITHUB_REPOSITORY: "mattermost/mobile",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
        STACK_CALLER_KEY: "mobile",
        STACK_BATCH: "ios",
        STACK_CREDENTIALS_KEY: CREDENTIALS_KEY,
        STACK_GITHUB_TOKEN: "gh-token",
        ...env,
      }),
  };
  return h;
};
const masks = (h: Harness) =>
  h.logged.filter((l) => l.startsWith("::add-mask::")).map((l) => l.slice("::add-mask::".length));

test("open is the bundle's open action", () => {
  assert.equal(typeof ACTIONS.open, "function");
});

test("open finds this run's create response, masks every secret, and sets the server at index", async () => {
  const h = harness({ STACK_INDEX: "1" });
  await h.go();
  const out = readOutputs(h.output);
  assert.equal(out.site_url, `https://${BATCH_ID}-01.test.example`);
  assert.equal(out.admin_username, "sysadmin");
  assert.equal(out.admin_email, "sysadmin@sample.mattermost.com");
  assert.equal(out.admin_password, "admin-pw-1");
  assert.equal(out.mail_token, "mail-1");
  assert.equal(out.batch_id, BATCH_ID);
  const instances = JSON.parse(out.instances) as unknown[];
  assert.equal(instances.length, 3);
  assert.equal(instances[2], null, "a failed server is null");
  assert.deepEqual(instances[0], {
    site_url: `https://${BATCH_ID}-00.test.example`,
    state: "ready",
    admin_username: "sysadmin",
    admin_email: "sysadmin@sample.mattermost.com",
    admin_password: "admin-pw-0",
    mail_token: "mail-0",
    credentials: { "postgres.user": "mmuser", "postgres.password": "pg-pw-0" },
    facts: { "openldap.bind_dn": "cn=admin,dc=mm,dc=test", "openldap.bind_password": "ldap-pw-0" },
  });
  for (const s of SECRET_VALUES) assert.ok(masks(h).includes(s), `${s} is masked`);
  assert.ok(!masks(h).includes("mmuser"), "a credential that names something is not masked");
  assert.ok(h.logged.some((l) => l === `e2e-test-stack: opened server 1 of batch ${BATCH_ID}, created in attempt 1`));
});

test("the listing and the API call carry the token; the storage URL gets none", async () => {
  const h = harness();
  await h.go();
  assert.deepEqual(
    h.calls.map((c) => c.url),
    [LISTING, `${API}/artifacts/7/zip`, BLOB],
  );
  assert.equal((h.calls[0].init?.headers as Record<string, string>).authorization, "Bearer gh-token");
  assert.equal(h.calls[2].init?.headers, undefined);
});

test("every mask is written before the outputs", async () => {
  const h = harness();
  const writtenWhenMasked: boolean[] = [];
  const log = h.logged.push.bind(h.logged);
  h.logged.push = (...lines: string[]) => {
    for (const l of lines) if (l.startsWith("::add-mask::")) writtenWhenMasked.push(existsSync(h.output));
    return log(...lines);
  };
  await h.go();
  assert.ok(writtenWhenMasked.length >= SECRET_VALUES.length);
  assert.ok(!writtenWhenMasked.includes(true), "no mask comes after the outputs file is written");
  assert.ok(existsSync(h.output));
});

test("the newest artifact is read when the run holds one from each attempt", async () => {
  const h = harness({}, archive(response()), [
    { id: 3, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T08:00:00Z" },
    { id: 7, name: "e2e-test-stack-create-ios", created_at: "2026-11-21T09:00:00Z" },
  ]);
  await h.go();
  assert.ok(h.calls.some((c) => c.url === `${API}/artifacts/7/zip`));
  assert.ok(!h.calls.some((c) => c.url === `${API}/artifacts/3/zip`));
});

test("a batch created by a later attempt of this run is opened, up to the run's attempt now", async () => {
  const id = "mobile-42-ios-2-xyz";
  const h = harness({}, archive(response({ batch_id: id })));
  await h.go();
  assert.equal(readOutputs(h.output).batch_id, id);
  assert.ok(h.logged.some((l) => l.endsWith(`batch ${id}, created in attempt 2`)));
});

test("a response naming another caller's, run's, batch's or a future attempt's batch is refused before it is opened", async () => {
  for (const id of ["tpp-42-ios-1-abc", "mobile-41-ios-1-abc", "mobile-42-android-1-abc", "mobile-42-ios-3-abc"]) {
    const h = harness({}, archive(response({ batch_id: id })));
    await assert.rejects(h.go(), (e: unknown) => {
      const m = (e as Error).message;
      return (
        m.includes(
          `names batch "${id}", which is not this run's: it must be mobile-42-ios-<attempt 1 to 2>-<suffix>`,
        ) && !m.includes("admin-pw")
      );
    });
    assert.deepEqual(masks(h), [], "nothing was opened");
    assert.deepEqual(readOutputs(h.output), {});
  }
});

test("a run with no artifact for the batch fails, saying no create uploaded one", async () => {
  const h = harness({}, null, []);
  await assert.rejects(
    h.go(),
    /this run has no artifact e2e-test-stack-create-ios: no create step for batch ios uploaded a response in any of its attempts/,
  );
});

test("an artifact that cannot be downloaded fails naming it, without the storage URL", async () => {
  const h = harness({}, null);
  await assert.rejects(h.go(), (e: unknown) => {
    const m = (e as Error).message;
    return (
      /artifact e2e-test-stack-create-ios exists but could not be downloaded: .*HTTP 404/.test(m) && !m.includes("sig=")
    );
  });
});

test("a response that is not a JSON object, or names no batch, fails", async () => {
  for (const body of ["not json", "null", "[1]"]) {
    const h = harness({}, archive(body));
    await assert.rejects(h.go(), /the create response in e2e-test-stack-create-ios is not a JSON object/);
  }
  const refused = harness({}, archive({ error: "quota for 123456789012 exceeded" }));
  await assert.rejects(
    refused.go(),
    /names no batch: the create for batch ios made none \(quota for \[account\] exceeded\)$/,
  );
});

test("secrets that do not open, are not an object, or are missing fail naming the batch; the batch id is still set", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      { secrets: seal(SECRETS, other.publicKey) },
      /batch mobile-42-ios-1-abc: the sealed secrets did not open with credentials-key/,
    ],
    [{ secrets: seal([1]) }, /batch mobile-42-ios-1-abc: the sealed secrets opened but are not an object/],
    [{}, /batch mobile-42-ios-1-abc has no sealed secrets$/],
  ];
  for (const [batch, message] of cases) {
    const h = harness({}, archive(response({ batch: { state: "ready", instances: [lease(0)], ...batch } })));
    await assert.rejects(h.go(), message);
    assert.equal(readOutputs(h.output).batch_id, BATCH_ID);
  }
});

test("an index with no ready server fails, naming the batch and the index, and instances is still set", async () => {
  for (const index of ["2", "3"]) {
    const h = harness({ STACK_INDEX: index });
    await assert.rejects(
      h.go(),
      new RegExp(`batch ${BATCH_ID} has no ready server at index ${index}: it lists 3, 2 of them ready$`),
    );
    const out = readOutputs(h.output);
    assert.ok(out.instances);
    assert.equal(out.site_url, undefined);
  }
});

test("a ready server with no opened secrets or no site is not ready", async () => {
  const h = harness(
    { STACK_INDEX: "1" },
    archive(
      response({
        sites: [],
        batch: {
          state: "ready",
          instances: [lease(0, { site_url: "" }), lease(1)],
          secrets: seal({ batch_token: "t", instances: [{ admin_password: "p" }] }),
        },
      }),
    ),
  );
  await assert.rejects(h.go(), /has no ready server at index 1: it lists 2, 0 of them ready/);
});

test("a batch past its expiry fails naming when it expired, with no secret opened; one before it opens", async () => {
  const at = (expires_at: unknown) => archive(response({ batch: { ...response().batch, expires_at } }));
  const expired = harness({}, at("2026-11-21T09:59:59Z"));
  await assert.rejects(
    expired.go(),
    /batch mobile-42-ios-1-abc expired at 2026-11-21T09:59:59\.000Z, the end of its ttl, and is reaped/,
  );
  assert.equal(readOutputs(expired.output).batch_id, BATCH_ID);
  assert.deepEqual(masks(expired), [], "nothing is opened");
  for (const live of ["2026-11-21T10:00:01Z", "not a time", 5]) await harness({}, at(live)).go();
});

test("create uploads its response under the artifact name open reads", () => {
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  assert.ok(
    yml.includes(`name: ${createArtifact("${{ inputs.batch }}")}\n`),
    "create/action.yml uploads createArtifact(batch)",
  );
});

test("open writes every output it declares on success, and action.yml reads exactly those", async () => {
  const h = harness();
  await h.go();
  assert.deepEqual(Object.keys(readOutputs(h.output)).sort(), [...OPEN_OUTPUTS]);
  const yml = readFileSync(new URL("../open/action.yml", import.meta.url), "utf8");
  const read = new Set([...yml.matchAll(/steps\.open\.outputs\.([\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), [...OPEN_OUTPUTS]);
});

test("outputs that cannot be written do not hide the failure", async () => {
  const outputDir = file("output-dir");
  mkdirSync(outputDir);
  const h = harness({ GITHUB_OUTPUT: outputDir, STACK_INDEX: "2" });
  await assert.rejects(h.go(), /no ready server at index 2: .* Also, the outputs could not be written/);
});

test("open refuses a missing or malformed input before anything is called", () => {
  const env = {
    GITHUB_REPOSITORY: "mattermost/mobile",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    STACK_CALLER_KEY: "mobile",
    STACK_BATCH: "ios",
    STACK_CREDENTIALS_KEY: CREDENTIALS_KEY,
    STACK_GITHUB_TOKEN: "t",
  };
  assert.equal(readOpenInputs(env).index, 0);
  const refused = (over: Record<string, string>, message: RegExp) =>
    assert.throws(() => readOpenInputs({ ...env, ...over }), message);
  refused({ STACK_CALLER_KEY: "" }, /caller-key is required/);
  refused({ STACK_BATCH: "IOS" }, /batch must be 1 to 20 lowercase letters/);
  refused({ STACK_INDEX: "-1" }, /index must be 0 or more/);
  refused({ STACK_INDEX: "one" }, /index must be a whole number/);
  refused({ STACK_CREDENTIALS_KEY: "short" }, /credentials-key must be the repository's credentials key/);
  refused({ STACK_GITHUB_TOKEN: "" }, /github-token is required: .* actions: read/);
  refused({ GITHUB_REPOSITORY: "" }, /GITHUB_REPOSITORY must be set/);
  refused({ GITHUB_RUN_ATTEMPT: "" }, /GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be set/);
});
