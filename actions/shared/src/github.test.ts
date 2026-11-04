// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import assert from "node:assert/strict";
import test from "node:test";

import { gh, RETRY_DELAYS_MS } from "./github.ts";
import type { FetchImpl } from "./github.ts";

const STATUS = "/repos/mattermost/mattermost/statuses/abc123";

// Answers each call with the next step: a status code, or an Error to throw (a dropped connection).
const scripted = (...steps: (number | Error)[]) => {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: String(init?.method) });
    const step = steps[calls.length - 1];
    if (step instanceof Error) throw step;
    return step === 204 ? new Response(null, { status: 204 }) : Response.json({ step }, { status: step });
  };
  return { calls, fetchImpl };
};

test("a commit status POST is tried again after a GitHub 5xx, a 429 or a dropped connection", async () => {
  for (const first of [500, 502, 503, 429, new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError")]) {
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
