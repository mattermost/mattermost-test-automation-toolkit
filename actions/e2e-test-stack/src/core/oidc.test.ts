// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionError } from "./errors.ts";
import { ID_TOKEN_ATTEMPTS, requestIdToken } from "./oidc.ts";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-1",
};

/** A fetch that answers from a queue, recording each call. */
const fakeFetch = (answers: (Response | Error)[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    if (answer instanceof Error) throw answer;
    // A copy, read in full: a clone's body is not cancelled until the original's is.
    const body = await answer.clone().arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: answer.status, headers: answer.headers });
  };
  return { calls, impl };
};

const go = (answers: (Response | Error)[], env: Record<string, string> = ENV) => {
  const fake = fakeFetch(answers);
  const waits: number[] = [];
  const logged: string[] = [];
  const result = requestIdToken(
    env,
    fake.impl,
    async (ms) => void waits.push(ms),
    (m) => logged.push(m),
  );
  return { result, calls: fake.calls, waits, logged };
};

test("the token is requested for STS's audience with the request token as bearer", async () => {
  const r = go([Response.json({ value: "id-token-1" })]);
  assert.equal(await r.result, "id-token-1");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "https://token.actions.example/id?api-version=2.0&audience=sts.amazonaws.com");
  assert.equal((r.calls[0].init?.headers as Record<string, string>).authorization, "Bearer request-token-1");
  assert.ok(r.calls[0].init?.signal instanceof AbortSignal);
});

test("a job without id-token: write is told to grant it, and nothing is requested", async () => {
  for (const env of [{}, { ACTIONS_ID_TOKEN_REQUEST_URL: ENV.ACTIONS_ID_TOKEN_REQUEST_URL }] as Record<
    string,
    string
  >[]) {
    const r = go([Response.json({ value: "x" })], env);
    await assert.rejects(r.result, (e: unknown) => e instanceof ActionError && /id-token: write/.test(e.message));
    assert.equal(r.calls.length, 0);
  }
});

test("a 5xx, a 429 or a dropped connection is tried again; the error lists each attempt and quotes no token", async () => {
  const recovers = go([new Response("", { status: 502 }), Response.json({ value: "id-token-2" })]);
  assert.equal(await recovers.result, "id-token-2");
  assert.deepEqual(recovers.waits, [5_000]);
  assert.match(recovers.logged[0], /attempt 1: HTTP 502; trying again in 5 s \(attempt 2 of 3\)/);

  const reset = new TypeError("fetch failed");
  const fails = go([new Response("", { status: 429 }), reset, new Response("request-token-1", { status: 503 })]);
  await assert.rejects(fails.result, (e: unknown) => {
    const m = (e as Error).message;
    assert.equal(
      m,
      "the GitHub OIDC token request failed: attempt 1: HTTP 429; attempt 2: no answer (TypeError); attempt 3: HTTP 503",
    );
    return !m.includes("request-token-1");
  });
  assert.equal(fails.calls.length, ID_TOKEN_ATTEMPTS);
  assert.deepEqual(fails.waits, [5_000, 10_000]);
});

test("a connection dropped while the token is read is tried again", async () => {
  let calls = 0;
  const waits: number[] = [];
  const token = await requestIdToken(
    ENV,
    async () => {
      if (++calls > 1) return Response.json({ value: "id-token-3" });
      const body = new ReadableStream<Uint8Array>({
        start: (c) => c.enqueue(new TextEncoder().encode('{"val')),
        pull: (c) => c.error(new TypeError("terminated")),
      });
      return new Response(body, { status: 200 });
    },
    async (ms) => void waits.push(ms),
    () => {},
  );
  assert.equal(token, "id-token-3");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5_000]);
});

test("a 4xx or a response with no token is final", async () => {
  const denied = go([new Response("", { status: 403 })]);
  await assert.rejects(denied.result, /failed: attempt 1: HTTP 403$/);
  assert.equal(denied.calls.length, 1);
  for (const body of ["{}", "not json", '{"value":""}', '{"value":1}']) {
    const empty = go([new Response(body)]);
    await assert.rejects(empty.result, /attempt 1: the response holds no token$/);
    assert.equal(empty.calls.length, 1);
  }
});
