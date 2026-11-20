// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GONE, goneUrls, PROBE_INTERVAL_MS, probeGone } from "./probe.ts";

test("the probed URLs are each site's ping and mail- host, and each sso- host; empty ones are left out", () => {
  assert.deepEqual(
    goneUrls(["https://a.test.example/", "", "http://b.test.example:8065"], ["", "sso-a.test.example"]),
    [
      "https://a.test.example/api/v4/system/ping",
      "https://mail-a.test.example/",
      "http://b.test.example:8065/api/v4/system/ping",
      "http://mail-b.test.example:8065/",
      "https://sso-a.test.example/",
    ],
  );
  assert.deepEqual(goneUrls(["", ""], []), []);
  assert.throws(() => goneUrls(["a.test.example"], []), /site "a\.test\.example" is not a URL/);
  assert.throws(() => goneUrls(["https://a.test.example/\n::warning::x"], []), /holds a control character/);
  assert.throws(() => goneUrls(["ftp://a.test.example"], []), /is not an http\(s\) URL/);
  assert.throws(() => goneUrls([], ["sso/../x"]), /is not a hostname/);
  // An sso- host takes its own instance's protocol.
  assert.deepEqual(goneUrls(["http://a.test", "https://b.test"], ["sso-a.test", "sso-b.test"]).slice(4), [
    "http://sso-a.test/",
    "https://sso-b.test/",
  ]);
});

/** A clock that moves only when the probe sleeps, or a request takes time. */
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    advance: (ms: number) => void (t += ms),
  };
};
const gone = () => new Response(`404 page: ${GONE}`, { status: 404 });

test("a host passes only on the router's 404 for an unknown server; 502, 503 and no answer are tried again", async () => {
  const c = clock();
  const answers: Record<string, (Response | Error)[]> = {
    "https://a/": [
      new Response("Bad Gateway", { status: 502 }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      new Response("unavailable", { status: 503 }),
      gone(),
    ],
    "https://b/": [gone()],
  };
  const seen: { url: string; redirect?: string; timeout: boolean }[] = [];
  const logged: string[] = [];
  await probeGone(Object.keys(answers), 180_000, {
    fetch: async (url, init) => {
      seen.push({ url, redirect: init?.redirect, timeout: init?.signal instanceof AbortSignal });
      const next = answers[url].shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: c.sleep,
    now: c.now,
    log: (m) => logged.push(m),
  });
  assert.equal(seen.filter((s) => s.url === "https://a/").length, 4);
  assert.ok(seen.every((s) => s.redirect === "manual" && s.timeout));
  assert.ok(logged.some((l) => /gone {2}https:\/\/a\/ \(after 4 attempt\(s\)/.test(l)));
  assert.ok(logged.some((l) => /gone {2}https:\/\/b\/ \(after 1 attempt\(s\)/.test(l)));
});

test("a host still served at the end of the window fails, listing each with its last answer", async () => {
  const c = clock();
  let calls = 0;
  await assert.rejects(
    probeGone(["https://a/", "https://b/", "https://c/"], 12_000, {
      fetch: async (url) => {
        calls++;
        if (url === "https://a/") return new Response("<html>\nstill\nup</html>", { status: 200 });
        // A 404 that is not the router's: the server itself, still up.
        if (url === "https://b/") return new Response('{"id":"api.context.404"}', { status: 404 });
        c.advance(PROBE_INTERVAL_MS);
        throw new DOMException("timed out", "TimeoutError");
      },
      sleep: c.sleep,
      now: c.now,
      log: () => {},
    }),
    (e: unknown) => {
      const lines = (e as Error).message.split("\n");
      assert.equal(lines[0], "e2e-test-stack: 3 of 3 host(s) still served after the destroy:");
      assert.match(
        lines[1],
        /^ {2}https:\/\/a\/ is still served after \d+s \(\d+ attempt\(s\)\): last answer 200 <html> still up<\/html>$/,
      );
      assert.match(lines[2], /last answer 404 \{"id":"api\.context\.404"\}$/);
      assert.match(lines[3], /last answer 000 timed out$/);
      return true;
    },
  );
  // Every wait was cut to the time left, so the window was never overrun by more than one request.
  assert.ok(c.now() <= 12_000 + PROBE_INTERVAL_MS * 3);
  assert.ok(calls >= 3);
});

test("a long answer is read no further than its first 64 KiB", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 << 10).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const c = clock();
  await assert.rejects(
    probeGone(["https://a/"], 1, {
      fetch: async () => new Response(endless, { status: 200 }),
      sleep: c.sleep,
      now: c.now,
      log: () => {},
    }),
    /last answer 200 x{200}$/,
  );
  assert.equal(pulled, 4);
  assert.ok(cancelled);
});
