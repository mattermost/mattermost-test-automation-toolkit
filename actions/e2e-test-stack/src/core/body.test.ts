// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyTooLarge, readBody } from "./body.ts";

/** A body of chunks of size bytes, recording how many were pulled and whether it was cancelled. */
const stream = (chunks: number, size: number) => {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= chunks) return controller.close();
        seen.pulled++;
        controller.enqueue(new Uint8Array(size).fill(120));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { res: new Response(body), seen };
};

test("a body within the limit is read whole", async () => {
  const { res, seen } = stream(3, 10);
  assert.equal((await readBody(res, 30)).length, 30);
  assert.equal(seen.cancelled, false);
});

test("with truncate, the first max bytes are kept and no read is awaited past them", async () => {
  const { res, seen } = stream(100, 10);
  const got = await readBody(res, 25, { truncate: true });
  assert.equal(got.length, 25);
  assert.equal(seen.pulled, 3);
  assert.equal(seen.cancelled, true);

  const exact = stream(100, 10);
  assert.equal((await readBody(exact.res, 20, { truncate: true })).length, 20);
  assert.equal(exact.seen.pulled, 2);
  assert.equal(exact.seen.cancelled, true);
});

test("without truncate, a body over the limit fails and is cancelled, by its declared length before any read", async () => {
  const { res, seen } = stream(100, 10);
  await assert.rejects(
    readBody(res, 25),
    (e: unknown) => e instanceof BodyTooLarge && e.message === "more than 25 bytes",
  );
  assert.equal(seen.pulled, 3);
  assert.equal(seen.cancelled, true);

  const declared = stream(3, 10);
  const sized = new Response(declared.res.body, { headers: { "content-length": "30" } });
  await assert.rejects(readBody(sized, 25), /^Error: 30 bytes, more than 25$/);
  assert.equal(declared.seen.pulled, 0);
  assert.equal(declared.seen.cancelled, true);
});
