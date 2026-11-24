// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { listZipEntries, readZipEntry, readZipMember, ZipError } from "./zip.ts";

function makeZip(entries: { name: string; data: Buffer | string; stored?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.stored ? 0 : 8;
    const payload = e.stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    name.copy(lh, 30);
    locals.push(lh, payload);

    const ch = Buffer.alloc(46 + name.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    name.copy(ch, 46);
    centrals.push(ch);

    offset += lh.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("listZipEntries and readZipEntry inspect and extract stored and deflated members", () => {
  const archive = makeZip([
    { name: "logs/mattermost.log", data: "line1\nline2\n" },
    { name: "shot.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), stored: true },
  ]);
  const entries = listZipEntries(archive);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["logs/mattermost.log", "shot.png"],
  );
  assert.equal(readZipEntry(archive, entries[0], 1024).toString(), "line1\nline2\n");
  assert.deepEqual(readZipEntry(archive, entries[1], 1024), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(readZipMember(archive, "missing.txt", 1024), undefined);
});

test("ZIP reader enforces size caps, CRC checks, and rejects encrypted or ZIP64 entries", () => {
  const archive = makeZip([{ name: "big.txt", data: "abcdef" }]);
  assert.throws(
    () => readZipMember(archive, "big.txt", 3),
    (e: unknown) => e instanceof ZipError && /more than 3/.test(e.message),
  );
  const corrupt = makeZip([{ name: "b.txt", data: "stored", stored: true }]);
  corrupt[corrupt.indexOf("stored")] = "S".charCodeAt(0);
  assert.throws(() => readZipMember(corrupt, "b.txt", 100), /CRC-32/);

  const encrypted = makeZip([{ name: "a.txt", data: "x" }]);
  encrypted.writeUInt16LE(1, encrypted.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  assert.throws(() => readZipMember(encrypted, "a.txt", 100), /encrypted/);

  const zip64 = makeZip([{ name: "a.txt", data: "x" }]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => listZipEntries(zip64), /ZIP64/);
});
