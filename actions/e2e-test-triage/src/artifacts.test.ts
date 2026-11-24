// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import type { FetchImpl } from "../../shared/src/github.ts";
import { skimRunArtifacts } from "./artifacts.ts";
import type { Finding } from "./types.ts";

function makeZip(entries: { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const payload = deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
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
    ch.writeUInt16LE(8, 10);
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const finding = (over: Partial<Finding>): Finding => ({
  file: "specs/channels/incoming_webhook_spec.ts",
  title: "MM-T633 Text in Slack-style attachment is searchable",
  class: "REGRESSION",
  reason: "failed",
  blocking: true,
  trunk: { runs: 5, fails: 0, flaky: 0, passes: 5, latest: "passed" },
  cross_pr: { prs: [], examples: [], passes: 5 },
  failure_signatures: [],
  trunk_break: null,
  this_pr: { runs: 0, passes: 0, fails: 0, last_pass: null, latest: "" },
  ...over,
});

test("skimRunArtifacts extracts mattermost service logs, nested blob-report error-context, and matched screenshots", async () => {
  const innerBlob = makeZip([{ name: "error-context.md", data: "# Page snapshot\nError: 502 Bad Gateway on /api/v4/posts" }]);
  const debugZip = makeZip([
    { name: "e2e-tests/playwright/logs/mattermost.log", data: '{"level":"info","msg":"ok"}\n{"level":"error","msg":"ECONNREFUSED postgres:5432 token=ghp_secret123456789012345"}\n' },
    { name: "e2e-tests/playwright/results/blob-report/report-1.zip", data: innerBlob },
    { name: "worker-artifacts/1/output/incoming_webhook_spec.ts/MM-T633 (failed).png", data: PNG },
  ]);
  const downloadedIds: number[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/artifacts?per_page=100&page=1")) {
      return Response.json({
        total_count: 2,
        artifacts: [
          { id: 1, name: "e2e-triage-findings-a1", size_in_bytes: 500, expired: false },
          { id: 2, name: "playwright-full--debug-1", size_in_bytes: debugZip.length, expired: false },
        ],
      });
    }
    const m = /\/artifacts\/(\d+)\/zip$/.exec(u);
    if (m) {
      downloadedIds.push(Number(m[1]));
      if (Number(m[1]) === 2) return new Response(new Uint8Array(debugZip));
    }
    throw new Error(`unexpected ${u}`);
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "99",
    patterns: ["e2e-triage-findings"],
    findings: [finding({ report_name: "playwright-full-1" })],
  });
  assert.deepEqual(downloadedIds, [2]);
  assert.deepEqual(skimmed.artifactsScanned, ["playwright-full--debug-1"]);
  assert.match(skimmed.serviceLogs, /\[mattermost\.log\].*ECONNREFUSED/);
  assert.match(skimmed.serviceLogs, /\[error-context\.md\].*502 Bad Gateway/);
  assert.doesNotMatch(skimmed.serviceLogs, /ghp_secret123456789012345/);
  assert.equal(skimmed.evidence.length, 1);
  assert.equal(skimmed.evidence[0].images.length, 1);
});

test("skimRunArtifacts reads mobile triage-evidence manifests and desktop numbered e2e-failure PNGs", async () => {
  const mobileZip = makeZip([
    {
      name: "evidence-4.json",
      data: JSON.stringify([{ file: "detox/e2e/test/bookmarks.e2e.ts", title: "MM-T5604_1", notes: "Timed out waiting", images: ["./failure.png"] }]),
    },
    { name: "failure.png", data: PNG },
  ]);
  const desktopZip = makeZip([{ name: "001-test-failed-1.png", data: PNG }]);

  const mobileFetch = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 10, name: "triage-evidence-detox-ios-1", size_in_bytes: mobileZip.length }] });
    }
    return new Response(new Uint8Array(mobileZip));
  }) as FetchImpl;

  const mob = await skimRunArtifacts({
    fetchImpl: mobileFetch,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "10",
    lane: "detox-ios",
    findings: [finding({ file: "detox/e2e/test/bookmarks.e2e.ts", title: "MM-T5604_1" })],
  });
  assert.equal(mob.evidence[0]?.images.length, 1);
  assert.equal(mob.evidence[0]?.notes, "Timed out waiting");

  const desktopFetch = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 20, name: "e2e-failure-e2e-on-ubuntu-latest-12.1.0-1-of-3", size_in_bytes: desktopZip.length }] });
    }
    return new Response(new Uint8Array(desktopZip));
  }) as FetchImpl;

  const desk = await skimRunArtifacts({
    fetchImpl: desktopFetch,
    token: "TOK",
    repository: "mattermost/desktop",
    runId: "20",
    reportName: "e2e-on-ubuntu-latest",
    findings: [finding({ file: "e2e/specs/calls.test.ts", title: "calls join" })],
  });
  assert.equal(desk.evidence[0]?.images.length, 1);
  assert.match(desk.evidence[0].images[0].name, /001-test-failed-1\.png$/);
});

test("skimRunArtifacts rejects cross-lane artifacts (OS, framework, and mobile platform exclusivity)", async () => {
  const downloaded: string[] = [];
  const listAndTrack = (artifacts: { id: number; name: string }[]): FetchImpl =>
    (async (url: string) => {
      const u = String(url);
      if (u.includes("/artifacts?")) {
        return Response.json({
          total_count: artifacts.length,
          artifacts: artifacts.map((a) => ({ ...a, size_in_bytes: 128, expired: false })),
        });
      }
      downloaded.push(u);
      return new Response(new Uint8Array(makeZip([{ name: "001-test-failed-1.png", data: PNG }])));
    }) as FetchImpl;

  await skimRunArtifacts({
    fetchImpl: listAndTrack([
      { id: 1, name: "e2e-failure-e2e-on-macos-26-12.1.0-1-of-2" },
      { id: 2, name: "e2e-failure-e2e-on-windows-2022-12.1.0-1-of-3" },
    ]),
    token: "TOK",
    repository: "mattermost/desktop",
    runId: "30",
    reportName: "e2e-on-ubuntu-latest",
    lane: "linux",
    findings: [finding({ file: "e2e/specs/calls.test.ts", title: "calls join" })],
  });
  await skimRunArtifacts({
    fetchImpl: listAndTrack([{ id: 3, name: "cypress-full--debug-1" }]),
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "31",
    lane: "playwright-full",
    findings: [finding({})],
  });
  await skimRunArtifacts({
    fetchImpl: listAndTrack([
      { id: 4, name: "triage-evidence-detox-android-1" },
      { id: 5, name: "maestro-ios-results-32" },
    ]),
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "32",
    lane: "detox-ios",
    findings: [finding({})],
  });
  assert.deepEqual(downloaded, []);
});

test("skimRunArtifacts prioritizes mattermost.log over auxiliary logs within a ZIP and across artifacts", async () => {
  const auxLines = (prefix: string) =>
    Array.from({ length: 12 }, (_, i) => `ERROR ${prefix}_${String.fromCharCode(97 + i)}_${"x".repeat(210)}`).join("\n");

  const singleZip = makeZip([
    { name: "logs/inbucket.log", data: auxLines("single_inbucket") },
    { name: "logs/mattermost.log", data: '{"level":"error","msg":"single zip primary"}' },
  ]);
  const singleFetch = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 1, name: "playwright-full--debug-1", size_in_bytes: singleZip.length }] });
    }
    return new Response(new Uint8Array(singleZip));
  }) as FetchImpl;
  const single = await skimRunArtifacts({
    fetchImpl: singleFetch,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "40",
    lane: "playwright-full",
    findings: [finding({})],
  });
  assert.match(single.serviceLogs, /^\[mattermost\.log\].*single zip primary/);
  assert.ok(single.serviceLogs.length <= 2500);

  const art1 = makeZip([
    { name: "logs/inbucket.log", data: auxLines("art1_inbucket") },
    { name: "logs/postgres.log", data: "ERROR postgres timeout" },
    { name: "logs/mattermost.log", data: '{"level":"error","msg":"artifact one primary"}' },
  ]);
  const art2 = makeZip([
    { name: "logs/elasticsearch.log", data: auxLines("art2_elastic") },
    { name: "logs/mattermost.log", data: '{"level":"error","msg":"artifact two primary"}' },
  ]);
  const multiFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("/artifacts?")) {
      return Response.json({
        total_count: 2,
        artifacts: [
          { id: 10, name: "playwright-full--debug-1", size_in_bytes: art1.length },
          { id: 11, name: "playwright-full--debug-2", size_in_bytes: art2.length },
        ],
      });
    }
    if (u.endsWith("/artifacts/10/zip")) return new Response(new Uint8Array(art1));
    if (u.endsWith("/artifacts/11/zip")) return new Response(new Uint8Array(art2));
    throw new Error(`unexpected ${u}`);
  }) as FetchImpl;
  const multi = await skimRunArtifacts({
    fetchImpl: multiFetch,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "41",
    lane: "playwright-full",
    findings: [finding({})],
  });
  assert.match(multi.serviceLogs, /^\[mattermost\.log\]/);
  assert.match(multi.serviceLogs, /artifact one primary/);
  assert.match(multi.serviceLogs, /artifact two primary/);
  const mmIdx = multi.serviceLogs.indexOf("artifact two primary");
  const pgIdx = multi.serviceLogs.indexOf("[postgres.log]");
  const inbucketIdx = multi.serviceLogs.indexOf("[inbucket.log]");
  assert.ok(mmIdx >= 0 && pgIdx > mmIdx && inbucketIdx > pgIdx);
});

test("skimRunArtifacts stops downloading secondary artifacts once triage-evidence-* covers all findings", async () => {
  const f1 = finding({ file: "detox/e2e/test/alpha.e2e.ts", title: "MM-T101 alpha" });
  const f2 = finding({ file: "detox/e2e/test/beta.e2e.ts", title: "MM-T102 beta" });

  const ev1 = makeZip([
    { name: "evidence-1.json", data: JSON.stringify([{ file: f1.file, title: f1.title, notes: "alpha failed", images: ["./a.png"] }]) },
    { name: "a.png", data: PNG },
  ]);
  const ev2 = makeZip([
    { name: "evidence-2.json", data: JSON.stringify([{ file: f2.file, title: f2.title, notes: "beta failed", images: ["./b.png"] }]) },
    { name: "b.png", data: PNG },
  ]);
  const secondary = makeZip([{ name: "beta.e2e.ts/MM-T102 (failed).png", data: PNG }]);

  const downloadedFull: number[] = [];
  const fullFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("/artifacts?")) {
      return Response.json({
        total_count: 4,
        artifacts: [
          { id: 1, name: "triage-evidence-detox-ios-1", size_in_bytes: ev1.length },
          { id: 2, name: "triage-evidence-detox-ios-2", size_in_bytes: ev2.length },
          { id: 3, name: "detox-ios-results-1", size_in_bytes: secondary.length },
          { id: 4, name: "detox-ios--debug-1", size_in_bytes: secondary.length },
        ],
      });
    }
    const m = /\/artifacts\/(\d+)\/zip$/.exec(u);
    const id = Number(m?.[1]);
    downloadedFull.push(id);
    if (id === 1) return new Response(new Uint8Array(ev1));
    if (id === 2) return new Response(new Uint8Array(ev2));
    return new Response(new Uint8Array(secondary));
  }) as FetchImpl;

  const full = await skimRunArtifacts({
    fetchImpl: fullFetch,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "50",
    lane: "detox-ios",
    findings: [f1, f2],
  });
  assert.deepEqual(downloadedFull, [1, 2]);
  assert.deepEqual(full.artifactsScanned, ["triage-evidence-detox-ios-1", "triage-evidence-detox-ios-2"]);
  assert.equal(full.evidence.length, 2);

  const downloadedPartial: number[] = [];
  const partialFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("/artifacts?")) {
      return Response.json({
        total_count: 2,
        artifacts: [
          { id: 1, name: "triage-evidence-detox-ios-1", size_in_bytes: ev1.length },
          { id: 3, name: "detox-ios-results-1", size_in_bytes: secondary.length },
        ],
      });
    }
    const m = /\/artifacts\/(\d+)\/zip$/.exec(u);
    const id = Number(m?.[1]);
    downloadedPartial.push(id);
    if (id === 1) return new Response(new Uint8Array(ev1));
    return new Response(new Uint8Array(secondary));
  }) as FetchImpl;

  const partial = await skimRunArtifacts({
    fetchImpl: partialFetch,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "51",
    lane: "detox-ios",
    findings: [f1, f2],
  });
  assert.deepEqual(downloadedPartial, [1, 3]);
  assert.deepEqual(partial.artifactsScanned, ["triage-evidence-detox-ios-1", "detox-ios-results-1"]);
  assert.equal(partial.evidence.length, 2);
});

test("skimRunArtifacts matches exact MM-T test IDs before attributing screenshots", async () => {
  const f12 = finding({ file: "specs/channels/shared_spec.ts", title: "MM-T12 short id" });
  const f123 = finding({ file: "specs/channels/shared_spec.ts", title: "MM-T123 longer id" });
  const zip = makeZip([{ name: "shared_spec.ts/MM-T123 (failed).png", data: PNG }]);
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 1, name: "playwright-full--debug-1", size_in_bytes: zip.length }] });
    }
    return new Response(new Uint8Array(zip));
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "60",
    lane: "playwright-full",
    findings: [f12, f123],
  });
  assert.equal(skimmed.evidence.length, 1);
  assert.equal(skimmed.evidence[0].title, "MM-T123 longer id");
});

test("skimRunArtifacts redacts secrets crossing 240/260-char line clip boundaries", async () => {
  const secret = "SECRET_CROSSING_BOUNDARY_XYZ123";
  const prefix = secret.slice(0, 12);
  const zip = makeZip([
    // "ERROR " (6) + 240 = 246 -> 14 chars of secret before 260-char clip, remainder after.
    { name: "logs/mattermost.log", data: `ERROR ${"a".repeat(240)}${secret}_tail` },
    // "heading " (8) + 218 = 226 -> 14 chars of secret before 240-char clip, remainder after.
    { name: "blob-report/r.zip", data: makeZip([{ name: "error-context.md", data: `heading ${"b".repeat(218)}${secret}_end` }]) },
  ]);
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 1, name: "playwright-full--debug-1", size_in_bytes: zip.length }] });
    }
    return new Response(new Uint8Array(zip));
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "61",
    lane: "playwright-full",
    secrets: [secret],
    findings: [finding({})],
  });
  assert.doesNotMatch(skimmed.serviceLogs, new RegExp(prefix));
  assert.match(skimmed.serviceLogs, /\[mattermost\.log\]/);
  assert.match(skimmed.serviceLogs, /\[error-context\.md\]/);
});

test("skimRunArtifacts memoizes duplicate zip images and enforces scan-wide image count and byte budgets", async () => {
  // 30 manifest items all pointing to the same image: memoization lets all 30 succeed within MAX_SCAN_IMAGES=24.
  const dupItems = Array.from({ length: 30 }, (_, i) => ({
    file: `specs/dup_${i}.ts`,
    title: `dup ${i}`,
    notes: `note ${i}`,
    images: ["./shared.png"],
  }));
  const dupZip = makeZip([
    { name: "evidence-1.json", data: JSON.stringify(dupItems) },
    { name: "shared.png", data: PNG },
  ]);
  const dupRes = await skimRunArtifacts({
    fetchImpl: (async (url: string) =>
      String(url).includes("/artifacts?")
        ? Response.json({ total_count: 1, artifacts: [{ id: 1, name: "triage-evidence-detox-ios-1", size_in_bytes: dupZip.length }] })
        : new Response(new Uint8Array(dupZip))) as FetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "62",
    lane: "detox-ios",
    findings: [finding({ file: "specs/dup_0.ts", title: "dup 0" })],
  });
  assert.equal(dupRes.evidence.length, 30);
  assert.ok(dupRes.evidence.every((e) => e.images.length === 1));

  // Exceeding MAX_SCAN_IMAGE_BYTES (20MB) keeps earlier images, later manifest notes, and service logs.
  const bigPng = Buffer.concat([PNG, Buffer.alloc(3_000_000)]);
  const byteItems = Array.from({ length: 8 }, (_, i) => ({
    file: `specs/big_${i}.ts`,
    title: `big ${i}`,
    notes: `note ${i}`,
    images: [`./img_${i}.png`],
  }));
  const byteZip = makeZip([
    { name: "evidence-1.json", data: JSON.stringify(byteItems) },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `img_${i}.png`, data: bigPng })),
    { name: "logs/mattermost.log", data: "ERROR server kept alive" },
  ]);
  const byteRes = await skimRunArtifacts({
    fetchImpl: (async (url: string) =>
      String(url).includes("/artifacts?")
        ? Response.json({ total_count: 1, artifacts: [{ id: 2, name: "triage-evidence-detox-ios-1", size_in_bytes: byteZip.length }] })
        : new Response(new Uint8Array(byteZip))) as FetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "63",
    lane: "detox-ios",
    findings: [finding({ file: "specs/big_0.ts", title: "big 0" })],
  });
  assert.equal(byteRes.evidence.length, 8);
  assert.equal(byteRes.evidence.filter((e) => e.images.length === 1).length, 6);
  assert.equal(byteRes.evidence[7].notes, "note 7");
  assert.equal(byteRes.evidence[7].images.length, 0);
  assert.match(byteRes.serviceLogs, /server kept alive/);
});

test("skimRunArtifacts cancels streaming download when response body exceeds maxZipBytes", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(600));
    },
    cancel() {
      canceled = true;
    },
  });
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("/artifacts?")) {
      return Response.json({ total_count: 1, artifacts: [{ id: 1, name: "playwright-full--debug-1", size_in_bytes: 500 }] });
    }
    return new Response(stream);
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "64",
    lane: "playwright-full",
    maxZipBytes: 1000,
    findings: [finding({})],
  });
  assert.equal(canceled, true);
  assert.deepEqual(skimmed.artifactsScanned, []);
});

test("skimRunArtifacts keeps multi-word artifact-patterns intact instead of splitting on whitespace", async () => {
  const downloaded: string[] = [];
  const zip = makeZip([{ name: "logs/mattermost.log", data: "ERROR custom matched" }]);
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/artifacts?")) {
      return Response.json({
        total_count: 2,
        artifacts: [
          { id: 1, name: "ui-cache", size_in_bytes: zip.length },
          { id: 2, name: "app-ui debug-1", size_in_bytes: zip.length },
        ],
      });
    }
    downloaded.push(u);
    return new Response(new Uint8Array(zip));
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "65",
    patterns: ["ui debug"],
    findings: [finding({})],
  });
  assert.equal(downloaded.length, 1);
  assert.deepEqual(skimmed.artifactsScanned, ["app-ui debug-1"]);
});

test("skimRunArtifacts retains page 1 artifacts when page 2 listing fails", async () => {
  const zip = makeZip([{ name: "logs/mattermost.log", data: "ERROR from page 1" }]);
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("&page=1")) {
      return Response.json({
        total_count: 150,
        artifacts: [{ id: 10, name: "playwright-full--debug-1", size_in_bytes: zip.length }],
      });
    }
    if (u.includes("&page=2")) return new Response("server error", { status: 500 });
    return new Response(new Uint8Array(zip));
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "66",
    lane: "playwright-full",
    findings: [finding({})],
  });
  assert.deepEqual(skimmed.artifactsScanned, ["playwright-full--debug-1"]);
  assert.match(skimmed.serviceLogs, /from page 1/);
});

test("skimRunArtifacts skips an oversized manifest image without dropping item notes or later manifest items", async () => {
  const oversized = Buffer.concat([PNG, Buffer.alloc(3_600_000)]);
  const zip = makeZip([
    {
      name: "evidence-1.json",
      data: JSON.stringify([
        { file: "specs/a.ts", title: "test a", notes: "kept notes", images: ["./oversized.png", "./valid.png"] },
        { file: "specs/b.ts", title: "test b", notes: "second item", images: ["./valid2.png"] },
      ]),
    },
    { name: "oversized.png", data: oversized },
    { name: "valid.png", data: PNG },
    { name: "valid2.png", data: PNG },
  ]);
  const fetchImpl = (async (url: string) =>
    String(url).includes("/artifacts?")
      ? Response.json({ total_count: 1, artifacts: [{ id: 1, name: "triage-evidence-detox-ios-1", size_in_bytes: zip.length }] })
      : new Response(new Uint8Array(zip))) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "67",
    lane: "detox-ios",
    findings: [finding({ file: "specs/a.ts", title: "test a" }), finding({ file: "specs/b.ts", title: "test b" })],
  });
  assert.equal(skimmed.evidence.length, 2);
  assert.equal(skimmed.evidence[0].notes, "kept notes");
  assert.equal(skimmed.evidence[0].images.length, 1);
  assert.equal(skimmed.evidence[1].notes, "second item");
  assert.equal(skimmed.evidence[1].images.length, 1);
});

test("skimRunArtifacts only stops early when structured triage-evidence-* manifests cover all findings", async () => {
  const f1 = finding({ file: "detox/e2e/test/alpha.e2e.ts", title: "MM-T101 alpha" });
  const f2 = finding({ file: "detox/e2e/test/beta.e2e.ts", title: "MM-T102 beta" });
  const customZip = makeZip([{ name: "alpha.e2e.ts/MM-T101 (failed).png", data: PNG }]);
  const ev2 = makeZip([
    { name: "evidence-2.json", data: JSON.stringify([{ file: f2.file, title: f2.title, notes: "beta notes", images: ["./b.png"] }]) },
    { name: "b.png", data: PNG },
  ]);
  const ev1 = makeZip([
    { name: "evidence-1.json", data: JSON.stringify([{ file: f1.file, title: f1.title, notes: "alpha notes", images: ["./a.png"] }]) },
    { name: "a.png", data: PNG },
  ]);
  const downloaded: number[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/artifacts?")) {
      return Response.json({
        total_count: 3,
        artifacts: [
          { id: 1, name: "custom--debug-1", size_in_bytes: customZip.length },
          { id: 2, name: "triage-evidence-2", size_in_bytes: ev2.length },
          { id: 3, name: "triage-evidence-1", size_in_bytes: ev1.length },
        ],
      });
    }
    const id = Number(/\/artifacts\/(\d+)\/zip$/.exec(u)?.[1]);
    downloaded.push(id);
    if (id === 1) return new Response(new Uint8Array(customZip));
    if (id === 2) return new Response(new Uint8Array(ev2));
    return new Response(new Uint8Array(ev1));
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost-mobile",
    runId: "68",
    patterns: ["custom"],
    findings: [f1, f2],
  });
  assert.deepEqual(downloaded, [1, 2, 3]);
  assert.equal(skimmed.evidence.find((e) => e.title === f1.title)?.notes, "alpha notes");
});
