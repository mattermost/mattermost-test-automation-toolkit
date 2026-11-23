// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/** A body longer than the most a caller reads. */
export class BodyTooLarge extends Error {}

/**
 * Reads a response body, at most max bytes of it. A body longer than that fails with BodyTooLarge, refused by its
 * declared length before any of it is read; with truncate, its first max bytes are returned instead. Whatever is not
 * read is cancelled.
 */
export async function readBody(res: Response, max: number, { truncate = false } = {}): Promise<Buffer> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (!truncate && length > max) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLarge(`${length} bytes, more than ${max}`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let done = false;
  try {
    // With truncate, no read is awaited once max bytes are in.
    while (!truncate || read < max) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      read += chunk.value.byteLength;
      if (!truncate && read > max) throw new BodyTooLarge(`more than ${max} bytes`);
      chunks.push(chunk.value);
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max);
}
