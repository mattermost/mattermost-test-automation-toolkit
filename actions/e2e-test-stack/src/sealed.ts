// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import sodium from "libsodium-wrappers";

/** A sealed box that does not open with the private key, or does not hold JSON. */
export class SealedError extends Error {}

/**
 * Opens a base64 libsodium sealed box (crypto_box_seal) with the repository's X25519 private key, and parses the JSON
 * inside. The public half is derived from the private key.
 */
export async function openSealed(sealed: string, privateKey: Uint8Array): Promise<unknown> {
  await sodium.ready;
  let plain: string;
  try {
    const box = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    plain = sodium.to_string(sodium.crypto_box_seal_open(box, sodium.crypto_scalarmult_base(privateKey), privateKey));
  } catch {
    throw new SealedError(
      "e2e-test-stack: the sealed secrets did not open with private-key; is it the key registered for caller-key?",
    );
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new SealedError("e2e-test-stack: the sealed secrets opened but are not JSON");
  }
}
