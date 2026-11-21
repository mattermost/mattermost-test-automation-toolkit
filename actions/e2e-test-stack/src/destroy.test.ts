// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sodium from "libsodium-wrappers";
import { createArtifact, responseArtifact } from "./core/artifacts.ts";
import type { InvokeInput, InvokeOutput } from "./core/lambda.ts";
import { GONE } from "./core/probe.ts";
import { DESTROY_OUTPUTS, destroyWith, readDestroyInputs } from "./destroy.ts";
import type { AttemptResult } from "./destroy.ts";
import { ACTIONS } from "./run.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const CREDENTIALS_KEY = Buffer.from(keys.privateKey).toString("base64");
const seal = (value: unknown): string =>
  Buffer.from(sodium.crypto_box_seal(JSON.stringify(value), keys.publicKey)).toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-destroy-test-"));
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
const batchId = (attempt: number, run = 42) => `mobile-${run}-ios-${attempt}-abc`;
const site = (id: string) => `https://${id}-00.test.example`;
/** A create response for a one-server batch of the attempt, with Keycloak's sso- host. */
const createResponse = (id: string, over: Record<string, unknown> = {}) => ({
  batch_id: id,
  sites: [site(id)],
  batch: {
    state: "ready",
    instances: [{ instance_id: `${id}-00`, state: "ready", site_url: site(id), sso_host: `sso-${id}-00.test.example` }],
    secrets: seal({ batch_token: `token-${id}`, instances: [{ admin_password: `pw-${id}` }] }),
  },
  ...over,
});
const destroyed = (id: string) => ({
  batch_id: id,
  batch: {
    state: "destroyed",
    instances: [{ instance_id: `${id}-00`, state: "terminated", cost: { total: 0.05, hours: 0.5 } }],
    cost: { total: 0.05, hours: 0.5, currency: "USD" },
  },
});
const notFound = (id: string) => ({ batch_id: id, batch: { batch_id: id, state: "not found" } });
const ok = (body: unknown): InvokeOutput => ({
  StatusCode: 200,
  Payload: new TextEncoder().encode(JSON.stringify(body)),
});

const API = "https://api.github.com/repos/mattermost/mobile/actions";
/** The run's artifacts named name, as the listing asks for them. */
const listingName = (url: string, run = 42): string | undefined => {
  const m = new RegExp(
    `^${API.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/runs/${run}/artifacts\\?name=([^&]+)&per_page=100&page=1$`,
  ).exec(url);
  return m ? decodeURIComponent(m[1]) : undefined;
};
const archive = (body: unknown) =>
  zip([{ name: "e2e-test-stack-create.json", data: typeof body === "string" ? body : JSON.stringify(body) }]);
import { zip } from "./core/zip.fixture.ts";

interface Artifact {
  name: string;
  body: unknown;
  created_at?: string;
  expired?: boolean;
}

interface Harness {
  output: string;
  summary: string;
  logged: string[];
  /** The destroy payloads, in order. */
  destroys: Record<string, unknown>[];
  probed: string[];
  stsCalls: number;
  go: () => Promise<void>;
}

/**
 * Runs destroy against a fake GitHub serving artifacts, a fake STS, and a control plane that answers each batch's
 * destroys in turn from replies (destroyed then not found by default). Every probed host answers the router's 404.
 */
const harness = (
  artifacts: Artifact[],
  env: Record<string, string> = {},
  replies: Record<string, (InvokeOutput | Error)[]> = {},
  probe: (url: string) => Response = () => new Response(`<p>${GONE}</p>`, { status: 404 }),
  run: { id: number; attempt?: number; path?: string; status?: string } | undefined = undefined,
  deps: { clock?: () => number; log?: (m: string) => void } = {},
  failListing: string[] = [],
): Harness => {
  const listed = artifacts.map((a, i) => ({
    id: i + 1,
    name: a.name,
    created_at: a.created_at ?? `2026-11-21T0${i}:00:00Z`,
    expired: a.expired ?? false,
  }));
  const calls = new Map<string, number>();
  const h: Harness = {
    output: file("output"),
    summary: file("summary"),
    logged: [],
    destroys: [],
    probed: [],
    stsCalls: 0,
    go: () =>
      destroyWith({
        log: (m) => {
          deps.log?.(m);
          h.logged.push(m);
        },
        sleep: async () => {},
        clock: deps.clock ?? (() => Date.parse("2026-11-21T10:00:00Z")),
        now: (() => {
          let t = 0;
          return () => (t += 1000);
        })(),
        fetch: async (url) => {
          if (url.startsWith("https://token.actions.example/")) return Response.json({ value: "id-token-1" });
          const name = listingName(url, run?.id);
          if (name !== undefined && failListing.includes(name)) return new Response("", { status: 500 });
          if (name !== undefined) {
            const named = listed.filter((a) => a.name === name);
            return Response.json({ total_count: named.length, artifacts: named });
          }
          if (run && url === `https://api.github.com/repos/mattermost/mobile/actions/runs/${run.id}`)
            return Response.json({
              path: run.path ?? ".github/workflows/e2e.yml",
              head_branch: "main",
              event: "workflow_dispatch",
              run_attempt: run.attempt ?? 1,
              status: run.status ?? "completed",
              head_repository: { full_name: "mattermost/mobile" },
            });
          const m = /\/artifacts\/(\d+)\/zip$/.exec(url);
          if (m) return new Response(null, { status: 302, headers: { location: `https://blob.example/${m[1]}` } });
          const b = /^https:\/\/blob\.example\/(\d+)$/.exec(url);
          if (b) {
            const body = artifacts[Number(b[1]) - 1].body;
            return body instanceof Error
              ? new Response("", { status: 403 })
              : new Response(new Uint8Array(archive(body)));
          }
          if (url.includes(".test.example")) {
            h.probed.push(url);
            return probe(url);
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
          const payload = JSON.parse(input.Payload) as { batch_id: string };
          h.destroys.push(payload);
          const n = calls.get(payload.batch_id) ?? 0;
          calls.set(payload.batch_id, n + 1);
          const reply = (replies[payload.batch_id] ?? [
            ok(destroyed(payload.batch_id)),
            ok(notFound(payload.batch_id)),
          ])[n];
          if (reply instanceof Error) throw reply;
          return reply ?? ok(notFound(payload.batch_id));
        },
      })({
        GITHUB_OUTPUT: h.output,
        GITHUB_STEP_SUMMARY: h.summary,
        GITHUB_REPOSITORY: "mattermost/mobile",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "2",
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
const attempts = (h: Harness) => JSON.parse(readOutputs(h.output).attempts ?? "[]") as AttemptResult[];

test("destroy is the bundle's destroy action", () => {
  assert.equal(typeof ACTIONS.destroy, "function");
});

test("every attempt's batch is destroyed from its own response, its hosts checked gone, and destroyed again", async () => {
  const h = harness([
    { name: responseArtifact("ios", 1), body: createResponse(batchId(1)) },
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: createResponse(batchId(2)) },
  ]);
  await h.go();
  // The batches are destroyed at once, so only each one's own calls are in order.
  assert.deepEqual(h.destroys.map((d) => d.batch_id).sort(), [batchId(1), batchId(1), batchId(2), batchId(2)]);
  assert.deepEqual(
    h.destroys.find((d) => d.batch_id === batchId(1)),
    { action: "destroy", batch_id: batchId(1), batch_token: `token-${batchId(1)}` },
  );
  assert.deepEqual(attempts(h), [
    { attempt: 1, batch_id: batchId(1), state: "destroyed", gone: "yes, all 3", again: "not found", cost_usd: "0.05" },
    { attempt: 2, batch_id: batchId(2), state: "destroyed", gone: "yes, all 3", again: "not found", cost_usd: "0.05" },
  ]);
  assert.equal(readOutputs(h.output).cost_usd, "0.10");
  assert.deepEqual(
    h.probed.filter((u) => u.includes(batchId(1))),
    [
      `${site(batchId(1))}/api/v4/system/ping`,
      `https://mail-${batchId(1)}-00.test.example/`,
      `https://sso-${batchId(1)}-00.test.example/`,
    ],
  );
  assert.equal(h.stsCalls, 1, "the role is assumed once");
  const masked = h.logged.filter((l) => l.startsWith("::add-mask::"));
  for (const secret of [`token-${batchId(1)}`, `pw-${batchId(2)}`, "sts-secret-1", "id-token-1"])
    assert.ok(masked.includes(`::add-mask::${secret}`), `${secret} is masked`);
  const summary = readFileSync(h.summary, "utf8");
  assert.match(summary, /\| 1 \| `mobile-42-ios-1-abc` \| destroyed \| yes, all 3 \| not found \| 0\.05 USD \|/);
  assert.deepEqual(Object.keys(readOutputs(h.output)).sort(), [...DESTROY_OUTPUTS]);
});

test("an attempt with no response of its own is destroyed from the newest when it names that attempt's batch", async () => {
  const h = harness([
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: createResponse(batchId(1)) },
  ]);
  await h.go();
  assert.deepEqual(
    attempts(h).map((a) => [a.attempt, a.batch_id]),
    [
      [1, batchId(1)],
      [2, batchId(2)],
    ],
  );
  assert.ok(
    h.logged.some((l) =>
      /attempt 1's own response is missing; its batch is taken from e2e-test-stack-create-ios/.test(l),
    ),
  );
});

test("a run with no response for the batch destroys nothing and assumes no role", async () => {
  const h = harness([{ name: responseArtifact("android", 1), body: createResponse("mobile-42-android-1-abc") }]);
  await h.go();
  assert.deepEqual([h.destroys.length, h.stsCalls], [0, 0]);
  assert.deepEqual(attempts(h), []);
  assert.match(readFileSync(h.summary, "utf8"), /No batch to destroy\./);
});

test("a response that names another batch, run or a later attempt is refused, and the rest are still destroyed", async () => {
  const h = harness([
    { name: responseArtifact("ios", 1), body: createResponse("mobile-41-ios-1-abc") },
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: createResponse(batchId(3)) },
  ]);
  await assert.rejects(
    h.go(),
    /attempt 1: e2e-test-stack-response-ios-1 names batch "mobile-41-ios-1-abc", which attempt 1 of this run did not create; e2e-test-stack-create-ios names batch "mobile-42-ios-3-abc" of attempt 3, later than this run's attempt 2 when it was read: run destroy again for it/,
  );
  assert.deepEqual(
    attempts(h).map((a) => a.batch_id),
    [batchId(2)],
  );
});

test("a response that cannot be read fails the step, after every other batch is destroyed", async () => {
  const h = harness([
    { name: responseArtifact("ios", 1), body: new Error("forbidden") },
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
  ]);
  await assert.rejects(
    h.go(),
    /attempt 1: this run's artifact e2e-test-stack-response-ios-1 exists but could not be downloaded: .*HTTP 403.*; its batch, if any, is not destroyed, and is reaped at its ttl/,
  );
  assert.deepEqual(
    attempts(h).map((a) => a.batch_id),
    [batchId(2)],
  );
});

test("an expired artifact is passed over: its batch is long past its ttl", async () => {
  const h = harness([{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)), expired: true }]);
  await h.go();
  assert.equal(h.destroys.length, 0);
});

test("an earlier attempt's batch already gone is accepted; one this attempt created must still have been up", async () => {
  const earlier = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {
      [batchId(1)]: [ok(notFound(batchId(1))), ok(notFound(batchId(1)))],
    },
  );
  await earlier.go();
  assert.equal(attempts(earlier)[0].state, "not found");
  assert.equal(readOutputs(earlier.output).cost_usd, undefined, "nothing was destroyed, so nothing is priced");

  const current = harness(
    [{ name: responseArtifact("ios", 2), body: createResponse(batchId(2)) }],
    {},
    {
      [batchId(2)]: [ok(notFound(batchId(2)))],
    },
  );
  await assert.rejects(current.go(), /batch mobile-42-ios-2-abc was not found, but this attempt created it/);
});

test("a host still served fails with each one and its last answer, and the second destroy is not run", async () => {
  const h = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    { STACK_GONE_WINDOW: "5" },
    {},
    (url) =>
      url.startsWith("https://mail-")
        ? new Response("bad gateway", { status: 502 })
        : new Response(GONE, { status: 404 }),
  );
  await assert.rejects(
    h.go(),
    /1 of 3 host\(s\) of batch mobile-42-ios-1-abc are still served: https:\/\/mail-mobile-42-ios-1-abc-00\.test\.example\/ is still served after \d+ s \(\d+ attempt\(s\)\): last HTTP 502/,
  );
  assert.equal(attempts(h)[0].gone, "no: 1 of 3 still served");
  assert.equal(attempts(h)[0].again, "not run");
  assert.equal(h.destroys.length, 1);
});

test("a destroy that is refused, partial, or found again on the second call fails naming the batch", async () => {
  const refused = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {
      [batchId(1)]: [
        {
          StatusCode: 200,
          FunctionError: "Unhandled",
          Payload: new TextEncoder().encode(
            '{"errorMessage":"batch not found for this repository, or the batch token does not open it"}',
          ),
        },
      ],
    },
  );
  await assert.rejects(
    refused.go(),
    /attempt 1: batch mobile-42-ios-1-abc: the control plane refused the destroy: batch not found/,
  );

  const partial = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {
      [batchId(1)]: [
        ok({ ...destroyed(batchId(1)), batch: { state: "partially_destroyed" }, error: "1 of 2 not terminated" }),
      ],
    },
  );
  await assert.rejects(
    partial.go(),
    /the destroy of batch mobile-42-ios-1-abc reported partially_destroyed: 1 of 2 not terminated/,
  );
  assert.equal(partial.probed.length, 0, "no host is probed for a batch not destroyed");

  const back = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {
      [batchId(1)]: [ok(destroyed(batchId(1))), ok(destroyed(batchId(1)))],
    },
  );
  await assert.rejects(back.go(), /a second destroy of batch mobile-42-ios-1-abc reported destroyed, not "not found"/);
});

test("secrets that do not open, or hold no batch token, fail that attempt without calling the control plane", async () => {
  const other = sodium.crypto_box_keypair();
  const h = harness([
    {
      name: responseArtifact("ios", 1),
      body: createResponse(batchId(1), {
        batch: {
          ...createResponse(batchId(1)).batch,
          secrets: Buffer.from(sodium.crypto_box_seal("{}", other.publicKey)).toString("base64"),
        },
      }),
    },
    {
      name: responseArtifact("ios", 2),
      body: createResponse(batchId(2), {
        batch: { ...createResponse(batchId(2)).batch, secrets: seal({ instances: [] }) },
      }),
    },
  ]);
  await assert.rejects(
    h.go(),
    /attempt 1: batch mobile-42-ios-1-abc: the sealed secrets did not open .*; attempt 2: batch mobile-42-ios-2-abc's secrets hold no batch token/,
  );
  assert.equal(h.destroys.length, 0);
});

test("another run's batches are destroyed once that run is checked, up to its latest attempt", async () => {
  const run = { id: 77, attempt: 3 };
  const h = harness(
    [
      { name: responseArtifact("ios", 3), body: createResponse(batchId(3, 77)) },
      { name: responseArtifact("ios", 4), body: createResponse(batchId(4, 77)) },
    ],
    {
      STACK_RUN_ID: "77",
      STACK_ALLOWED_WORKFLOWS: ".github/workflows/e2e.yml",
      STACK_ALLOWED_BRANCHES: "main|release-.*",
      STACK_ALLOWED_EVENTS: "workflow_dispatch",
    },
    {},
    undefined,
    run,
  );
  await h.go();
  assert.deepEqual(
    attempts(h).map((a) => a.batch_id),
    [batchId(3, 77)],
    "attempt 4 is later than the run's latest",
  );

  const wrong = harness(
    [],
    {
      STACK_RUN_ID: "77",
      STACK_ALLOWED_WORKFLOWS: ".github/workflows/other.yml",
      STACK_ALLOWED_BRANCHES: "main",
      STACK_ALLOWED_EVENTS: "workflow_dispatch",
    },
    {},
    undefined,
    run,
  );
  await assert.rejects(
    wrong.go(),
    /run 77 is not one this action may act on: it is "\.github\/workflows\/e2e\.yml on main/,
  );
  assert.equal(wrong.stsCalls, 0);
});

test("destroy refuses a missing or malformed input before anything is called", () => {
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
  const read = readDestroyInputs(env);
  assert.deepEqual([read.runId, read.allowance, read.goneWindowSeconds, read.channel], ["42", undefined, 180, "v1"]);
  assert.equal(
    readDestroyInputs({ ...env, STACK_RUN_ID: "42" }).allowance,
    undefined,
    "this run's own id needs no check",
  );
  const refused = (over: Record<string, string>, message: RegExp) =>
    assert.throws(() => readDestroyInputs({ ...env, ...over }), message);
  refused({ STACK_ROLE_ARN: "" }, /role-arn is required/);
  refused({ STACK_BATCH: "" }, /batch is required/);
  refused({ STACK_RUN_ID: "abc" }, /run-id must be a workflow run's id/);
  refused({ STACK_RUN_ID: "77" }, /allowed-workflows, allowed-branches and allowed-events are required/);
  refused(
    { STACK_RUN_ID: "77", STACK_ALLOWED_WORKFLOWS: "w", STACK_ALLOWED_EVENTS: "push", STACK_ALLOWED_BRANCHES: "(" },
    /allowed-branches is not a regular expression/,
  );
  refused({ STACK_GONE_WINDOW: "1801" }, /gone-window must be 1800 or less/);
  refused({ STACK_GONE_WINDOW: "0" }, /gone-window/);
  refused({ STACK_CHANNEL: "beta" }, /channel must be v1 or edge/);
  const other = readDestroyInputs({
    ...env,
    STACK_RUN_ID: "77",
    STACK_ALLOWED_WORKFLOWS: "a.yml, b.yml",
    STACK_ALLOWED_EVENTS: "push",
    STACK_ALLOWED_BRANCHES: "main|release-.*",
  });
  assert.ok(other.allowance?.branches.test("release-11.1"));
  assert.ok(!other.allowance?.branches.test("feature-main"), "the whole branch must match");
});

test("destroy writes every output it declares, and action.yml reads exactly those", async () => {
  const yml = readFileSync(new URL("../destroy/action.yml", import.meta.url), "utf8");
  const read = new Set([...yml.matchAll(/steps\.destroy\.outputs\.([\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), [...DESTROY_OUTPUTS]);
});

test("create uploads each attempt's response under the name destroy reads", () => {
  const yml = readFileSync(new URL("../create/action.yml", import.meta.url), "utf8");
  assert.equal(responseArtifact("ios", 3), "e2e-test-stack-response-ios-3");
  assert.ok(yml.includes("name: e2e-test-stack-response-${{ inputs.batch }}-${{ github.run_attempt }}\n"));
});

test("a newest response that cannot be read is passed over when every attempt's own was read", async () => {
  const h = harness([
    { name: responseArtifact("ios", 1), body: createResponse(batchId(1)) },
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: new Error("forbidden") },
  ]);
  await h.go();
  assert.equal(attempts(h).length, 2);

  const needed = harness([
    { name: responseArtifact("ios", 1), body: new Error("forbidden") },
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: new Error("forbidden") },
  ]);
  await assert.rejects(needed.go(), /attempt 1: .*its batch, if any, is not destroyed/);
  assert.equal(attempts(needed).length, 1, "attempt 2's batch is still destroyed");
});

test("a role that cannot be assumed fails with every failure found before it", async () => {
  const h = harness(
    [
      { name: responseArtifact("ios", 1), body: new Error("forbidden") },
      { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    ],
    { ACTIONS_ID_TOKEN_REQUEST_URL: "" },
  );
  await assert.rejects(h.go(), /attempt 1: .*could not be downloaded.*; .*id-token.*no batch was destroyed/s);
  assert.equal(h.destroys.length, 0);
});

test("an error inside one batch's destroy is that attempt's failure; the other batches are still destroyed", async () => {
  const h = harness(
    [
      { name: responseArtifact("ios", 1), body: createResponse(batchId(1)) },
      { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    ],
    {},
    {},
    undefined,
    undefined,
    {
      log: (m) => {
        if (m.includes(`destroying batch ${batchId(1)}`)) throw new TypeError("boom");
      },
    },
  );
  await assert.rejects(h.go(), /attempt 1: batch mobile-42-ios-1-abc: TypeError: boom/);
  assert.deepEqual(
    attempts(h).map((a) => [a.attempt, a.state]),
    [
      [1, "not destroyed"],
      [2, "destroyed"],
    ],
  );
});

test("this attempt's batch not found is accepted once past its expiry, as the reaper took it", async () => {
  const h = harness(
    [
      {
        name: responseArtifact("ios", 2),
        body: createResponse(batchId(2), {
          batch: { ...createResponse(batchId(2)).batch, expires_at: "2026-11-21T09:00:00Z" },
        }),
      },
    ],
    {},
    { [batchId(2)]: [ok(notFound(batchId(2))), ok(notFound(batchId(2)))] },
  );
  await h.go();
  assert.match(
    readFileSync(h.summary, "utf8"),
    /Batch mobile-42-ios-2-abc was not found: it passed its expiry and was reaped\./,
  );
});

test("another run still in progress is refused before anything is destroyed", async () => {
  const h = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1, 77)) }],
    {
      STACK_RUN_ID: "77",
      STACK_ALLOWED_WORKFLOWS: ".github/workflows/e2e.yml",
      STACK_ALLOWED_BRANCHES: "main",
      STACK_ALLOWED_EVENTS: "workflow_dispatch",
    },
    {},
    undefined,
    { id: 77, status: "in_progress" },
  );
  await assert.rejects(h.go(), /run 77 is "in_progress", not completed: destroy its batches once it completes/);
  assert.deepEqual([h.destroys.length, h.stsCalls], [0, 0]);
});

test("an artifact of another batch never counts, however many the run has", async () => {
  const h = harness([
    { name: responseArtifact("ios-2", 1), body: createResponse("mobile-42-ios-2-1-abc") },
    { name: createArtifact("ios-2"), body: createResponse("mobile-42-ios-2-1-abc") },
  ]);
  await h.go();
  assert.equal(h.destroys.length, 0);
});

test("a listing GitHub keeps refusing fails that attempt alone; the others are still destroyed", async () => {
  const h = harness(
    [
      { name: responseArtifact("ios", 1), body: createResponse(batchId(1)) },
      { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    ],
    {},
    {},
    undefined,
    undefined,
    {},
    [responseArtifact("ios", 1)],
  );
  await assert.rejects(
    h.go(),
    /attempt 1: GitHub GET .*artifacts\?name=e2e-test-stack-response-ios-1.* failed: .*HTTP 500.*; its batch, if any, is not destroyed/,
  );
  assert.deepEqual(
    attempts(h).map((a) => a.batch_id),
    [batchId(2)],
  );
});

test("this attempt's batch not found is accepted when its create never reported it ready", async () => {
  const h = harness(
    [
      {
        name: responseArtifact("ios", 2),
        body: createResponse(batchId(2), { batch: { ...createResponse(batchId(2)).batch, state: "failed" } }),
      },
    ],
    {},
    { [batchId(2)]: [ok(notFound(batchId(2))), ok(notFound(batchId(2)))] },
  );
  await h.go();
  assert.equal(attempts(h)[0].state, "not found");
});

test("an error after the destroy keeps the batch reported destroyed", async () => {
  const h = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {},
    undefined,
    undefined,
    {
      log: (m) => {
        if (m.includes("probing")) throw new TypeError("boom");
      },
    },
  );
  await assert.rejects(h.go(), /attempt 1: batch mobile-42-ios-1-abc: TypeError: boom/);
  assert.deepEqual([attempts(h)[0].state, attempts(h)[0].cost_usd], ["destroyed", "0.05"]);
});

test('a second destroy that reports an error fails, even with "not found"', async () => {
  const h = harness(
    [{ name: responseArtifact("ios", 1), body: createResponse(batchId(1)) }],
    {},
    {
      [batchId(1)]: [ok(destroyed(batchId(1))), ok({ ...notFound(batchId(1)), error: "lookup failed" })],
    },
  );
  await assert.rejects(h.go(), /the second destroy of batch mobile-42-ios-1-abc reported not found: lookup failed/);
});

test("an unreadable newest fails the step when an attempt's own response is missing; it may be the only record", async () => {
  const h = harness([
    { name: responseArtifact("ios", 2), body: createResponse(batchId(2)) },
    { name: createArtifact("ios"), body: new Error("forbidden") },
  ]);
  await assert.rejects(h.go(), /a batch only it names is not destroyed/);
  assert.deepEqual(
    attempts(h).map((a) => [a.attempt, a.batch_id]),
    [[2, batchId(2)]],
    "the batch found is still destroyed, and attempt 1 has no target",
  );

  // An unreadable own response is reported once, not again for the unreadable newest.
  const both = harness([
    { name: responseArtifact("ios", 1), body: createResponse(batchId(1)) },
    { name: responseArtifact("ios", 2), body: new Error("forbidden") },
    { name: createArtifact("ios"), body: new Error("forbidden") },
  ]);
  const error = await both.go().then(
    () => "",
    (e: unknown) => (e as Error).message,
  );
  assert.match(error, /attempt 2: .*its batch, if any, is not destroyed/);
  assert.doesNotMatch(error, /a batch only it names/);
});
