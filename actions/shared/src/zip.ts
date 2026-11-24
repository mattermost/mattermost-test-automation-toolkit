// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { crc32, inflateRawSync } from "node:zlib";

/** An archive that is not a ZIP this reader reads, or a member that does not check out. */
export class ZipError extends Error {}
ZipError.prototype.name = "ZipError";

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// The end record is 22 bytes, followed by a comment of up to 65535.
const EOCD_SEARCH = 22 + 0xffff;

const defaultErrorText = (e: unknown): string => {
  const name = (e as { name?: string } | null | undefined)?.name || "Error";
  const message = String((e as { message?: unknown } | null | undefined)?.message ?? e)
    .split("\n")[0]
    .slice(0, 200);
  return `${name}: ${message}`;
};

/**
 * Lists every entry from a ZIP archive's central directory without decompressing any member.
 * ZIP64 archives and malformed central directories are refused. Member names are strings only,
 * never resolved as filesystem paths.
 */
export function listZipEntries(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - EOCD_SEARCH); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("not a ZIP archive: no end of central directory");
  const entries = zip.readUInt16LE(end + 10);
  const offset = zip.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffffffff) throw new ZipError("a ZIP64 archive, which is not read");

  const out: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CENTRAL) throw new ZipError("a malformed central directory");
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (p + 46 + nameLength > zip.length) throw new ZipError("a malformed central directory");
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    p += 46 + nameLength + extraLength + commentLength;
    out.push({ name, flags, method, crc, compressed, size, local });
  }
  return out;
}

/**
 * Extracts and verifies a single entry from `zip`, enforcing `max` uncompressed bytes and CRC-32.
 * Refuses encrypted entries, ZIP64 members, and compression methods other than stored (0) or deflate (8).
 */
export function readZipEntry(zip: Buffer, entry: ZipEntry, max: number, formatError: (e: unknown) => string = defaultErrorText): Buffer {
  const { name, flags, method, crc, compressed, size, local } = entry;
  if (flags & 1) throw new ZipError(`${name} is encrypted`);
  if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
    throw new ZipError(`${name} is a ZIP64 member, which is not read`);
  if (size > max) throw new ZipError(`${name} is ${size} bytes, more than ${max}`);
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL)
    throw new ZipError(`${name} has no local header where the directory says`);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  if (start + compressed > zip.length) throw new ZipError(`${name} runs past the end of the archive`);
  const raw = zip.subarray(start, start + compressed);
  let data: Buffer;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, max) });
    } catch (e) {
      throw new ZipError(`${name} does not inflate: ${formatError(e)}`);
    }
  } else throw new ZipError(`${name} uses compression method ${method}, which is not read`);
  if (data.length !== size || crc32(data) !== crc)
    throw new ZipError(`${name} does not match its size and CRC-32 in the archive`);
  return data;
}

/**
 * Reads the member named exactly `name` from a ZIP archive's central directory, or returns undefined when there is none.
 * Reads stored and deflated members, at most `max` bytes uncompressed, and checks the CRC-32.
 */
export function readZipMember(
  zip: Buffer,
  name: string,
  max: number,
  formatError: (e: unknown) => string = defaultErrorText,
): Buffer | undefined {
  const entry = listZipEntries(zip).find((e) => e.name === name);
  return entry ? readZipEntry(zip, entry, max, formatError) : undefined;
}
