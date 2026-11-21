// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GONE, goneUrls, PROBE_INTERVAL_MS, probeGone } from "./probe.ts";
import type { ProbeOptions } from "./probe.ts";

test("each site's ping and mail- host, and each sso- host, are probed with the site's protocol", () => {
  assert.deepEqual(
    goneUrls(
      ["https://a.test.example", "", "http://c.test.example:8080/"],
      ["sso-a.test.example", "", "sso-c.test.example"],
    ),
    [
      "https://a.test.example/api/v4/system/ping",
      "https://mail-a.test.example/",
      "http://c.test.example:8080/api/v4/system/ping",
      "http://mail-c.test.example:8080/",
      "https://sso-a.test.example/",
      "http://sso-c.test.example/",
    ],
  );
  assert.deepEqual(goneUrls([], ["sso-x.test.example"]), ["https://sso-x.test.example/"], "no site: https");
});

test("a site that is not an http(s) URL, or an sso host that is not a hostname, fails without a line break", () => {
  for (const site of ["ftp://a", "not a url", "https://a\n.example", 5])
    assert.throws(
      () => goneUrls([site], []),
      (e: unknown) =>
        /is not (an http\(s\) URL|a URL)/.test((e as Error).message) && !(e as Error).message.includes("\n"),
    );
  for (const host of ["a/b", "a b", "x\ny", 7]) assert.throws(() => goneUrls([], [host]), /is not a hostname/);
});

/** A clock that moves only when the probe sleeps, and a fetch answering from answers by URL, in turn. */
const options = (answers: Record<string, (Response | Error)[]>): ProbeOptions & { slept: number[] } => {
  let t = 0;
  const slept: number[] = [];
  const seen = new Map<string, number>();
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    log: () => {},
    fetch: async (url) => {
      const n = seen.get(url) ?? 0;
      seen.set(url, n + 1);
      const list = answers[url];
      const a = list[Math.min(n, list.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
};

test("a host is gone once it answers the router's 404; until then it is tried again", async () => {
  const o = options({
    "https://a/": [new Response("bad gateway", { status: 502 }), new Response(`<h1>${GONE}</h1>`, { status: 404 })],
  });
  assert.deepEqual(await probeGone(["https://a/"], 60_000, o), []);
  assert.deepEqual(o.slept, [PROBE_INTERVAL_MS]);
});

test("a 404 without the router's text, a refused request or a timeout is not gone, and each is reported", async () => {
  const o = options({
    "https://a/": [new Response("not found", { status: 404 })],
    "https://b/": [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    "https://c/": [new DOMException("timed out", "TimeoutError")],
  });
  const served = await probeGone(["https://a/", "https://b/", "https://c/"], 12_000, o);
  assert.equal(served.length, 3);
  assert.match(served[0], /^https:\/\/a\/ is still served after \d+ s \(\d+ attempt\(s\)\): last HTTP 404$/);
  assert.match(served[1], /last no answer, ECONNREFUSED$/);
  assert.match(served[2], /last no answer, timed out$/);
});

test("the body is never quoted: it may carry anything the server wrote", async () => {
  const o = options({ "https://a/": [new Response("secret\n::error::x", { status: 500 })] });
  const [served] = await probeGone(["https://a/"], 1_000, o);
  assert.ok(!served.includes("secret"));
});
