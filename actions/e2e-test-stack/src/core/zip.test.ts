// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { zip } from "./zip.fixture.ts";
import { readZipMember, ZipError } from "./zip.ts";

test("the ZIP reader reads stored and deflated members by exact name", () => {
  const archive = zip([
    { name: "a.json", data: '{"a":1}' },
    { name: "dir/a.json", data: "nested" },
    { name: "b.txt", data: "stored", stored: true },
  ]);
  assert.equal(readZipMember(archive, "a.json", 100)?.toString(), '{"a":1}');
  assert.equal(readZipMember(archive, "b.txt", 100)?.toString(), "stored");
  assert.equal(readZipMember(archive, "dir/a.json", 100)?.toString(), "nested");
  assert.equal(readZipMember(archive, "c.txt", 100), undefined);
});

test("the ZIP reader refuses an oversized, corrupt or inflating-past-its-size member, and what is not a ZIP", () => {
  const archive = zip([
    { name: "a.json", data: '{"a":1}' },
    { name: "b.txt", data: "stored", stored: true },
  ]);
  assert.throws(
    () => readZipMember(archive, "a.json", 3),
    (e: unknown) => e instanceof ZipError && e.name === "ZipError" && /more than 3/.test(e.message),
  );
  const corrupt = Buffer.from(archive);
  corrupt[corrupt.indexOf("stored")] = "S".charCodeAt(0);
  assert.throws(() => readZipMember(corrupt, "b.txt", 100), /does not match its size and CRC-32/);
  assert.throws(() => readZipMember(Buffer.alloc(10), "a.json", 100), /not a ZIP archive/);
  const bomb = zip([{ name: "a.json", data: "x".repeat(10_000) }]);
  bomb.writeUInt32LE(5, bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  assert.throws(() => readZipMember(bomb, "a.json", 100), /does not inflate|does not match/);
});

test("the ZIP reader refuses an encrypted member, another compression method, and a ZIP64 archive", () => {
  const central = (archive: Buffer) => archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const encrypted = zip([{ name: "a.json", data: "x" }]);
  encrypted.writeUInt16LE(1, central(encrypted) + 8);
  assert.throws(() => readZipMember(encrypted, "a.json", 100), /a\.json is encrypted/);
  const bzip = zip([{ name: "a.json", data: "x" }]);
  bzip.writeUInt16LE(12, central(bzip) + 10);
  assert.throws(() => readZipMember(bzip, "a.json", 100), /compression method 12/);
  const zip64 = zip([{ name: "a.json", data: "x" }]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => readZipMember(zip64, "a.json", 100), /ZIP64/);
});
