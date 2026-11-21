// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import sodium from "libsodium-wrappers";
import { ActionError } from "./errors.ts";
import { openSealed, SealedError } from "./sealed.ts";

await sodium.ready;
const keys = sodium.crypto_box_keypair();
const other = sodium.crypto_box_keypair();
const seal = (plain: string, publicKey = keys.publicKey): string =>
  Buffer.from(sodium.crypto_box_seal(plain, publicKey)).toString("base64");

test("a sealed box opens with the credentials key alone, and not with another", async () => {
  assert.deepEqual(await openSealed(seal('{"a":1}'), keys.privateKey), { a: 1 });
  await assert.rejects(
    openSealed(seal('{"a":1}'), other.privateKey),
    (e: unknown) =>
      e instanceof SealedError && e instanceof ActionError && /^the sealed secrets did not open/.test(e.message),
  );
  await assert.rejects(openSealed("bm90IGEgYm94", keys.privateKey), SealedError);
  await assert.rejects(openSealed("not base64!", keys.privateKey), SealedError);
});

test("a box that opens but holds no JSON is refused without quoting it", async () => {
  await assert.rejects(openSealed(seal("secret-not-json"), keys.privateKey), (e: unknown) => {
    assert.ok(e instanceof SealedError);
    assert.equal(e.message, "the sealed secrets opened but are not JSON");
    return true;
  });
});
