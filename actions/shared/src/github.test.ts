// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import test from "node:test";

import { gh, RETRY_DELAYS_MS } from "./github.ts";
import type { FetchImpl } from "./github.ts";

const STATUS = "/repos/mattermost/mattermost/statuses/abc123";

// Answers each call with the next step: a status code, a Response as given, or an Error to throw (a dropped connection).
const scripted = (...steps: (number | Error | Response)[]) => {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: String(init?.method) });
    const step = steps[calls.length - 1];
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step;
    return step === 204 ? new Response(null, { status: 204 }) : Response.json({ step }, { status: step });
  };
  return { calls, fetchImpl };
};

test("a commit status POST is tried again after a GitHub 5xx, a 429, a dropped connection or an aborted call", async () => {
  for (const first of [500, 502, 503, 429, new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError"), new DOMException("aborted", "AbortError")]) {
    const waits: number[] = [];
    const { calls, fetchImpl } = scripted(first, 201);
    const body = await gh(fetchImpl, "t", async (ms) => {
      waits.push(ms);
    })("POST", STATUS, { state: "success", context: "e2e-test/x" });
    assert.deepEqual(body, { step: 201 }, String(first));
    assert.equal(calls.length, 2, String(first));
    assert.deepEqual(waits, [RETRY_DELAYS_MS[0]], String(first));
  }
});

test("a commit status POST gives up after the last attempt, with the last error", async () => {
  const { calls, fetchImpl } = scripted(502, 503, 500);
  await assert.rejects(gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), /GitHub POST \/repos\/mattermost\/mattermost\/statuses\/abc123: 500/);
  assert.equal(calls.length, RETRY_DELAYS_MS.length + 1);
});

test("an error that is not the network's is thrown at once", async () => {
  const { calls, fetchImpl } = scripted(new Error("bug in the caller"), 201);
  await assert.rejects(gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), /bug in the caller/);
  assert.equal(calls.length, 1);
});

test("a TypeError the network did not cause, such as an invalid header value, is thrown at once", async () => {
  const { calls, fetchImpl } = scripted(new TypeError('Headers.append: "Bearer a\\nb" is an invalid header value.'), 201);
  await assert.rejects(gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), /invalid header value/);
  assert.equal(calls.length, 1);
});

test("a TypeError with a cause but not undici's \"fetch failed\" is thrown at once", async () => {
  const { calls, fetchImpl } = scripted(new TypeError("Invalid URL", { cause: new Error("bad input") }), 201);
  await assert.rejects(gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), /Invalid URL/);
  assert.equal(calls.length, 1);
});

test("a 5xx whose body cannot be read is still tried again", async () => {
  const unreadable = new Response(new ReadableStream({ pull: (c) => c.error(new Error("connection reset")) }), { status: 503 });
  const { calls, fetchImpl } = scripted(unreadable, 201);
  assert.deepEqual(await gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), { step: 201 });
  assert.equal(calls.length, 2);
});

test("a 2xx commit status response whose body drops mid-read or is malformed still succeeds without retrying, while a GET body error still throws", async () => {
  for (const err of [new TypeError("terminated"), new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
    const dropped = new Response(new ReadableStream({ pull: (c) => c.error(err) }), { status: 201 });
    const waits: number[] = [];
    const { calls, fetchImpl } = scripted(dropped, 201);
    assert.equal(await gh(fetchImpl, "t", async (ms) => { waits.push(ms); })("POST", STATUS, {}), null, String(err));
    assert.equal(calls.length, 1, String(err));
    assert.deepEqual(waits, [], String(err));
  }

  const malformed = new Response("not json", { status: 201, headers: { "content-type": "application/json" } });
  const { calls, fetchImpl } = scripted(malformed, 201);
  assert.equal(await gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), null);
  assert.equal(calls.length, 1);

  const malformedGet = new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  const getScript = scripted(malformedGet);
  await assert.rejects(gh(getScript.fetchImpl, "t", async () => {})("GET", "/repos/mattermost/mattermost/commits/abc123/statuses?per_page=100&page=1"), SyntaxError);
  assert.equal(getScript.calls.length, 1);
});

test("a 429 is tried again on the same short waits, whatever its Retry-After says", async () => {
  const limited = new Response(null, { status: 429, headers: { "retry-after": "60" } });
  const waits: number[] = [];
  const { calls, fetchImpl } = scripted(limited, 201);
  assert.deepEqual(await gh(fetchImpl, "t", async (ms) => { waits.push(ms); })("POST", STATUS, {}), { step: 201 });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [RETRY_DELAYS_MS[0]]);
});

test("a 4xx fails at once: the request is wrong, not GitHub", async () => {
  const { calls, fetchImpl } = scripted(422);
  await assert.rejects(gh(fetchImpl, "t", async () => {})("POST", STATUS, {}), /: 422/);
  assert.equal(calls.length, 1);
});

test("other calls are not retried: a re-run request is not safe to repeat, and reads keep their own handling", async () => {
  for (const [method, path] of [
    ["POST", "/repos/mattermost/mattermost/actions/runs/1/rerun-failed-jobs"],
    ["GET", "/repos/mattermost/mattermost/commits/abc123/statuses?per_page=100&page=1"],
    ["GET", "/repos/mattermost/mattermost/pulls/5/files?per_page=100&page=1"],
  ]) {
    const { calls, fetchImpl } = scripted(503, 200);
    await assert.rejects(gh(fetchImpl, "t", async () => {})(method, path), /: 503/, path);
    assert.equal(calls.length, 1, path);
  }
});

test("a success returns the body, and 204 returns null", async () => {
  assert.deepEqual(await gh(scripted(201).fetchImpl, "t")("POST", STATUS, {}), { step: 201 });
  assert.equal(await gh(scripted(204).fetchImpl, "t")("POST", "/repos/o/r/actions/runs/1/rerun-failed-jobs"), null);
});
