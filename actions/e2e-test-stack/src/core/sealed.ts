// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import sodium from "libsodium-wrappers";
import { ActionError } from "./errors.ts";
import type { BatchSecrets } from "./response.ts";

/** A sealed box that does not open with the credentials key, or does not hold JSON. */
export class SealedError extends ActionError {}
SealedError.prototype.name = "SealedError";

/**
 * Opens a base64 libsodium sealed box (crypto_box_seal) with the repository's credentials key, an X25519 private key,
 * and parses the JSON inside. The public half is derived from it.
 */
export async function openSealed(sealed: string, credentialsKey: Uint8Array): Promise<unknown> {
  await sodium.ready;
  let plain: string;
  try {
    const box = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    plain = sodium.to_string(
      sodium.crypto_box_seal_open(box, sodium.crypto_scalarmult_base(credentialsKey), credentialsKey),
    );
  } catch {
    throw new SealedError(
      "the sealed secrets did not open with credentials-key; is it the key whose public half is registered for this repository?",
    );
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new SealedError("the sealed secrets opened but are not JSON");
  }
}

/** Opens a batch's sealed secrets, which must hold a JSON object; anything else is a SealedError. */
export async function openBatchSecrets(sealed: string, credentialsKey: Uint8Array): Promise<BatchSecrets> {
  const value = await openSealed(sealed, credentialsKey);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SealedError("the sealed secrets opened but are not an object");
  return value;
}
