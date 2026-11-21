// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendSummary, cell, commandText, masker, writeFile, writeOutputs } from "./outputs.ts";

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-outputs-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Parses GITHUB_OUTPUT's delimited entries. */
const readOutputs = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const value: string[] = [];
    while (lines[++i] !== m[2]) value.push(lines[i]);
    out[m[1]] = value.join("\n");
  }
  return out;
};

test("outputs are written in the delimited form, so a multi-line value survives; no path writes nothing", () => {
  const path = join(dir, "outputs");
  writeOutputs(path, { a: "1", b: "x\ny" });
  assert.deepEqual(readOutputs(path), { a: "1", b: "x\ny" });
  writeOutputs(undefined, { a: "1" });
  writeOutputs(join(dir, "none"), {});
  assert.ok(!existsSync(join(dir, "none")));
});

test("the summary is appended with ARNs and account ids taken out", () => {
  const path = join(dir, "summary");
  appendSummary(path, ["| a |", "arn:aws:iam::123456789012:role/x in 123456789012"]);
  appendSummary(path, []);
  assert.equal(readFileSync(path, "utf8"), "| a |\n[arn] in [account]\n");
});

test("a file is written with its directory, at its absolute path", () => {
  const full = writeFile(join(dir, "deep", "er", "f.json"), "{}");
  assert.equal(full, join(dir, "deep", "er", "f.json"));
  assert.equal(readFileSync(full, "utf8"), "{}");
});

test("a table cell escapes pipes and puts line breaks on one line", () => {
  assert.equal(cell("a|b\nc\r\nd"), "a\\|b c d");
  assert.equal(cell(undefined), "");
  assert.equal(cell(3), "3");
});

test("workflow command text escapes %, \\r and \\n", () => {
  assert.equal(commandText("50%\r\n::x"), "50%25%0D%0A::x");
});

test("a masked value is masked once, with its form inside JSON, and its line breaks cannot start a command", () => {
  const logged: string[] = [];
  const m = masker((line) => logged.push(line));
  m.mask("plain");
  m.mask("plain");
  m.mask("");
  m.mask(undefined);
  m.mask('a"b');
  m.mask("x\n::warning::y");
  assert.deepEqual(logged, [
    "::add-mask::plain",
    '::add-mask::a"b',
    '::add-mask::a\\"b',
    "::add-mask::x%0A::warning::y",
    "::add-mask::x\\n::warning::y",
    // The lines of the multi-line value: "::warning::y" alone, and "x", too short to mask on its own, left.
    "::add-mask::::warning::y",
  ]);
  assert.deepEqual([...m.masked], ["plain", 'a"b', 'a\\"b', "x\n::warning::y", "x\\n::warning::y", "::warning::y"]);
});

test("each line of a multi-line secret is masked on its own, as the runner masks line by line", () => {
  const logged: string[] = [];
  const m = masker((line) => logged.push(line));
  m.mask('-----BEGIN KEY-----\n  abc123def456  \nab"cd\\efgh\nshort\n-----END KEY-----');
  for (const line of ["abc123def456", 'ab"cd\\efgh', 'ab\\"cd\\\\efgh', "-----BEGIN KEY-----", "-----END KEY-----"])
    assert.ok(logged.includes(`::add-mask::${line}`), line);
  assert.ok(!logged.includes("::add-mask::  abc123def456  "), "a line is masked trimmed");
  assert.ok(!logged.includes("::add-mask::short"), "a line under MIN_LINE_MASK is left");
});
