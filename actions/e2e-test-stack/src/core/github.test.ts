// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionError } from "./errors.ts";
import { GITHUB_ATTEMPTS, githubClient, GitHubError } from "./github.ts";

interface Call {
  url: string;
  init?: RequestInit;
}
type Answer = Response | Error;

/** A fetch that answers each URL from its queue in turn, recording every call. */
const fakeFetch = (routes: Record<string, Answer[]>) => {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const queue = routes[url];
    if (!queue?.length) throw new Error(`no answer for ${url}`);
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    if (answer instanceof Error) throw answer;
    // A copy, read in full: a clone's body is not cancelled until the original's is.
    const body = await answer.clone().arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: answer.status, headers: answer.headers });
  };
  return { calls, impl };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const api = (path: string) => `https://api.github.com${path}`;
const client = (routes: Record<string, Answer[]>, token = "tok") => {
  const fake = fakeFetch(routes);
  const waits: number[] = [];
  const logged: string[] = [];
  const github = githubClient(
    token,
    fake.impl,
    async (ms) => void waits.push(ms),
    (m) => logged.push(m),
  );
  return { github, calls: fake.calls, waits, logged };
};

test("the GitHub client sends the token and returns the JSON body", async () => {
  const c = client({ [api("/x")]: [json({ a: 1 })] });
  assert.deepEqual(await c.github.json("/x"), { a: 1 });
  const headers = c.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.ok(c.calls[0].init?.signal instanceof AbortSignal);

  const anonymous = client({ [api("/x")]: [json({})] }, "");
  await anonymous.github.json("/x");
  assert.equal((anonymous.calls[0].init?.headers as Record<string, string>).authorization, undefined);
});

test("a 5xx, a timeout or a dropped connection is tried again after 10, 20 and 30 s, then fails listing each attempt", async () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const c = client({
    [api("/x")]: [new Response("Bad Gateway", { status: 502 }), timeout, reset, new Response("", { status: 503 })],
  });
  await assert.rejects(
    c.github.json("/x"),
    (e: unknown) =>
      e instanceof GitHubError &&
      e instanceof ActionError &&
      e.message ===
        "GitHub GET /x failed: attempt 1: HTTP 502 Bad Gateway; attempt 2: did not answer within 60 seconds; attempt 3: TypeError: fetch failed (ECONNRESET); attempt 4: HTTP 503",
  );
  assert.equal(c.calls.length, GITHUB_ATTEMPTS);
  assert.deepEqual(c.waits, [10_000, 20_000, 30_000]);
  assert.match(c.logged[0], /GitHub GET \/x: attempt 1: HTTP 502 Bad Gateway; trying again in 10 s \(attempt 2 of 4\)/);

  const recovers = client({ [api("/x")]: [new Response("", { status: 500 }), json([1])] });
  assert.deepEqual(await recovers.github.json("/x"), [1]);
  assert.deepEqual(recovers.waits, [10_000]);
});

test("a 429 or a secondary rate limit waits 60 s; the primary rate limit and other 4xx are final", async () => {
  const throttled = client({
    [api("/x")]: [
      new Response("", { status: 429 }),
      new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }),
      json({ ok: true }),
    ],
  });
  assert.deepEqual(await throttled.github.json("/x"), { ok: true });
  assert.deepEqual(throttled.waits, [60_000, 60_000]);

  for (const answer of [
    new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    new Response('{"message":"API rate limit exceeded"}', { status: 429, headers: { "x-ratelimit-remaining": "0" } }),
    new Response('{"message":"Not Found"}', { status: 404 }),
    new Response('{"message":"Bad credentials"}', { status: 401 }),
    new Response("not json", { status: 200 }),
  ]) {
    const final = client({ [api("/x")]: [answer] });
    await assert.rejects(final.github.json("/x"), /GitHub GET \/x failed: attempt 1: HTTP \d+/);
    assert.equal(final.calls.length, 1);
    assert.deepEqual(final.waits, []);
  }
});

test("a JSON body over the limit is a final failure, refused by its declared length", async () => {
  const big = client({ [api("/x")]: [new Response("[]", { headers: { "content-length": String(9 << 20) } })] });
  await assert.rejects(big.github.json("/x"), /attempt 1: \d+ bytes, more than \d+$/);
  assert.equal(big.calls.length, 1);
});
