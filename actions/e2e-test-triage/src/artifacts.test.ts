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
    if (u.endsWith("/artifacts/2/zip")) return new Response(new Uint8Array(debugZip));
    throw new Error(`unexpected ${u}`);
  }) as FetchImpl;

  const skimmed = await skimRunArtifacts({
    fetchImpl,
    token: "TOK",
    repository: "mattermost/mattermost",
    runId: "99",
    findings: [finding({ report_name: "playwright-full-1" })],
  });
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
