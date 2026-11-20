// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { checkRun } from "./check-run.ts";
import { earlierResponse } from "./earlier.ts";
import { GITHUB_ATTEMPTS, githubClient, GitHubError } from "./github.ts";
import type { GitHub } from "./github.ts";
import { classify, MASTER_IMAGE, serverImage } from "./server-image.ts";
import { readZipMember, ZipError } from "./zip.ts";

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-github-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let dirs = 0;

interface Call {
  url: string;
  init?: RequestInit;
}
type Answer = Response | Error | ((url: string) => Response);

/** A fetch that answers each URL from its queue in turn, recording every call. */
const fakeFetch = (routes: Record<string, Answer[]>) => {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const queue = routes[url];
    if (!queue?.length) throw new Error(`no answer for ${url}`);
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(url);
    // A copy, read in full: a clone's body is not cancelled until the original's is.
    const body = await answer.clone().arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: answer.status, headers: answer.headers });
  };
  return { calls, impl };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const api = (path: string) => `https://api.github.com${path}`;
const client = (routes: Record<string, Answer[]>, token = "tok") => {
  const fake = fakeFetch(routes);
  const waits: number[] = [];
  const logged: string[] = [];
  const github = githubClient(
    token,
    fake.impl,
    async (ms) => void waits.push(ms),
    (m) => logged.push(m),
  );
  return { github, calls: fake.calls, waits, logged };
};

/** A ZIP archive of the given members, each deflated unless stored is set. */
const zip = (members: { name: string; data: string | Buffer; stored?: boolean }[]): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const data = Buffer.from(m.data);
    const body = m.stored ? data : deflateRawSync(data);
    const name = Buffer.from(m.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(m.stored ? 0 : 8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(m.stored ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(header, name, body);
    central.push(entry, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

test("the GitHub client sends the token and returns the JSON body", async () => {
  const c = client({ [api("/x")]: [json({ a: 1 })] });
  assert.deepEqual(await c.github.json("/x"), { a: 1 });
  const headers = c.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tok");
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.ok(c.calls[0].init?.signal instanceof AbortSignal);

  const anonymous = client({ [api("/x")]: [json({})] }, "");
  await anonymous.github.json("/x");
  assert.equal((anonymous.calls[0].init?.headers as Record<string, string>).authorization, undefined);
});

test("a 5xx, a timeout or a dropped connection is tried again after 10, 20 and 30 s, then fails listing each attempt", async () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const c = client({
    [api("/x")]: [new Response("Bad Gateway", { status: 502 }), timeout, reset, new Response("", { status: 503 })],
  });
  await assert.rejects(
    c.github.json("/x"),
    (e: unknown) =>
      e instanceof GitHubError &&
      e.message ===
        "e2e-test-stack: GitHub GET /x failed: attempt 1: HTTP 502 Bad Gateway; attempt 2: did not answer within 60 seconds; attempt 3: TypeError: fetch failed (ECONNRESET); attempt 4: HTTP 503",
  );
  assert.equal(c.calls.length, GITHUB_ATTEMPTS);
  assert.deepEqual(c.waits, [10_000, 20_000, 30_000]);
  assert.match(c.logged[0], /GitHub GET \/x: attempt 1: HTTP 502 Bad Gateway; trying again in 10 s \(attempt 2 of 4\)/);

  const recovers = client({ [api("/x")]: [new Response("", { status: 500 }), json([1])] });
  assert.deepEqual(await recovers.github.json("/x"), [1]);
  assert.deepEqual(recovers.waits, [10_000]);
});

test("a 429 or a secondary rate limit waits 60 s; the primary rate limit and other 4xx are final", async () => {
  const throttled = client({
    [api("/x")]: [
      new Response("", { status: 429 }),
      new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }),
      json({ ok: true }),
    ],
  });
  assert.deepEqual(await throttled.github.json("/x"), { ok: true });
  assert.deepEqual(throttled.waits, [60_000, 60_000]);

  for (const answer of [
    new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    new Response('{"message":"API rate limit exceeded"}', { status: 429, headers: { "x-ratelimit-remaining": "0" } }),
    new Response('{"message":"Not Found"}', { status: 404 }),
    new Response('{"message":"Bad credentials"}', { status: 401 }),
    new Response("not json", { status: 200 }),
  ]) {
    const final = client({ [api("/x")]: [answer] });
    await assert.rejects(final.github.json("/x"), /GitHub GET \/x failed: attempt 1: HTTP \d+/);
    assert.equal(final.calls.length, 1);
    assert.deepEqual(final.waits, []);
  }
});

test("a download follows the API's redirect without the token, bounded, and never quotes the storage URL", async () => {
  const blob = "https://storage.example/artifact.zip?sig=secret";
  const c = client({
    [api("/a/zip")]: [new Response(null, { status: 302, headers: { location: blob } })],
    [blob]: [new Response("", { status: 500 }), new Response("PK-bytes")],
  });
  assert.equal((await c.github.download("/a/zip", 100)).toString(), "PK-bytes");
  assert.equal(c.calls[0].init?.redirect, "manual");
  assert.equal(c.calls[1].url, blob);
  assert.equal(c.calls[1].init?.headers, undefined);
  assert.deepEqual(c.waits, [10_000]);

  const denied = client({
    [api("/a/zip")]: [new Response(null, { status: 302, headers: { location: blob } })],
    [blob]: [new Response(`<Error>${blob}</Error>`, { status: 403 })],
  });
  await assert.rejects(denied.github.download("/a/zip", 100), (e: unknown) => {
    const message = (e as Error).message;
    return /attempt 1: the download answered HTTP 403$/.test(message) && !message.includes("sig=secret");
  });

  const big = client({ [api("/a/zip")]: [new Response("x".repeat(101))] });
  await assert.rejects(big.github.download("/a/zip", 100), /attempt 1: more than 100 bytes$/);
  assert.equal(big.calls.length, 1);
});

/** A GitHub that answers json from a map, and download from another. */
const fakeGitHub = (pages: Record<string, unknown>, downloads: Record<string, Buffer | Error> = {}) => {
  const asked: string[] = [];
  const github: GitHub = {
    json: async (path) => {
      asked.push(path);
      if (!(path in pages)) throw new GitHubError(`e2e-test-stack: GitHub GET ${path} failed: attempt 1: HTTP 404`);
      return pages[path];
    },
    download: async (path) => {
      asked.push(path);
      const d = downloads[path];
      if (!d || d instanceof Error) throw d ?? new Error(`no download ${path}`);
      return d;
    },
  };
  return { github, asked };
};

const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  body: "",
  ...over,
});
const ESR_BODY = "Mattermost v10.11 is an Extended Support Release (ESR).";

test("latest is the highest stable release by semver, skipping drafts, prereleases and suffixed tags", () => {
  assert.equal(
    classify([
      release("v10.9.0"),
      release("v10.10.2"),
      release("v10.10.10"),
      release("v11.0.0", { draft: true }),
      release("v11.1.0-rc1"),
      release("v11.2.0", { prerelease: true }),
      release("v10.12.0-beta"),
      release("nightly"),
    ]).latest,
    "10.10.10",
  );
});

test("esr is the newest patch of the newest minor any of whose stable releases says it is an ESR line", () => {
  const { latest, esr } = classify([
    release("v11.2.1"),
    release("v10.11.0", { body: ESR_BODY }),
    release("v10.11.7"),
    release("v10.11.12"),
    release("v10.5.3", { body: "an EXTENDED SUPPORT RELEASE" }),
    // Matterwick reads the note on stable releases only.
    release("v11.1.0-rc1", { body: ESR_BODY }),
    release("v11.0.0", { body: ESR_BODY, draft: true }),
  ]);
  assert.equal(latest, "11.2.1");
  assert.equal(esr, "10.11.12");
  assert.equal(classify([release("v11.2.1")]).esr, undefined);
});

test("server-image reads every page of releases and names the image; master calls nothing", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => release(`v9.${i}.0`));
  const page2 = [release("v10.11.3", { body: ESR_BODY }), release("v11.0.1")];
  const { github, asked } = fakeGitHub({
    "/repos/mattermost/mattermost/releases?per_page=100&page=1": page1,
    "/repos/mattermost/mattermost/releases?per_page=100&page=2": page2,
  });
  assert.deepEqual(await serverImage("latest", github), {
    image: "mattermost/mattermost-enterprise-edition:11.0.1",
    version: "11.0.1",
  });
  assert.equal(asked.length, 2);
  assert.deepEqual(await serverImage("esr", github), {
    image: "mattermost/mattermost-enterprise-edition:10.11.3",
    version: "10.11.3",
  });

  const none = fakeGitHub({});
  assert.deepEqual(await serverImage("master", none.github), { image: MASTER_IMAGE, version: "master" });
  assert.equal(none.asked.length, 0);

  const noEsr = fakeGitHub({ "/repos/mattermost/mattermost/releases?per_page=100&page=1": [release("v11.0.1")] });
  await assert.rejects(
    serverImage("esr", noEsr.github),
    /no ESR release among the 1 releases of mattermost\/mattermost/,
  );
});

const RUN = {
  path: ".github/workflows/e2e-test-stack-run.yml",
  head_branch: "master",
  event: "push",
  head_repository: { full_name: "mattermost/tpp" },
};
const checkInputs = {
  repository: "mattermost/tpp",
  runId: "42",
  workflows: [".github/workflows/e2e-test-stack-run.yml", ".github/workflows/e2e-test-stack-mobile.yml"],
  branches: /^(?:master|release-\d+\.\d+)$/,
  events: ["push", "workflow_dispatch"],
};

test("check-run passes a run of an allowed workflow, branch and event from this repository", async () => {
  for (const run of [RUN, { ...RUN, head_branch: "release-11.2", event: "workflow_dispatch" }]) {
    const { github, asked } = fakeGitHub({ "/repos/mattermost/tpp/actions/runs/42": run });
    const logged: string[] = [];
    await checkRun(checkInputs, github, (m) => logged.push(m));
    assert.deepEqual(asked, ["/repos/mattermost/tpp/actions/runs/42"]);
    assert.match(logged[0], /run 42 is allowed/);
  }
});

test("check-run refuses another workflow, branch, event or a fork's run, describing it", async () => {
  const refused = async (run: unknown, message: RegExp) => {
    const { github } = fakeGitHub({ "/repos/mattermost/tpp/actions/runs/42": run });
    await assert.rejects(
      checkRun(checkInputs, github, () => {}),
      message,
    );
  };
  await refused(
    { ...RUN, path: ".github/workflows/other.yml" },
    /^Error: e2e-test-stack: run 42 is not an allowed run: \.github\/workflows\/other\.yml on master \(push\) from mattermost\/tpp$/,
  );
  // The pattern matches the whole branch.
  await refused({ ...RUN, head_branch: "master-copy" }, /on master-copy \(push\)/);
  await refused({ ...RUN, head_branch: "release-11.2x" }, /on release-11\.2x/);
  await refused({ ...RUN, event: "pull_request" }, /\(pull_request\)/);
  await refused({ ...RUN, head_repository: { full_name: "fork/tpp" } }, /from fork\/tpp$/);
  await refused({ ...RUN, head_repository: null }, /from no repository$/);
  const { github } = fakeGitHub({});
  await assert.rejects(
    checkRun(checkInputs, github, () => {}),
    /GitHub GET .* failed: attempt 1: HTTP 404/,
  );
});

const ARTIFACTS = "/repos/mattermost/tpp/actions/runs/42/artifacts?name=e2e-test-stack-create&per_page=100&page=1";
const CREATED = JSON.stringify({ batch_id: "tpp-42-1-abc", batch: { secrets: "sealed" } });
const earlierInputs = (over: { responseMember?: string; accountPath?: string } = {}) => ({
  repository: "mattermost/tpp",
  runId: "42",
  artifactName: "e2e-test-stack-create",
  responseMember: "e2e-test-stack-create.json",
  responsePath: join(dir, `earlier-${++dirs}`, "earlier.json"),
  ...over,
});
const artifact = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: "e2e-test-stack-create",
  expired: false,
  created_at: `2026-11-20T10:0${id}:00Z`,
  ...over,
});

test("earlier-response finds no artifact, and says so without failing", async () => {
  const { github } = fakeGitHub({ [ARTIFACTS]: { total_count: 0, artifacts: [] } });
  const inputs = earlierInputs();
  assert.equal(await earlierResponse(inputs, github, () => {}), undefined);
  assert.equal(existsSync(inputs.responsePath), false);
});

test("earlier-response writes the newest artifact's response, and its account only to account-path", async () => {
  const archive = zip([
    { name: "e2e-test-stack-create.json", data: CREATED },
    { name: "e2e-test-stack-account", data: "dev\n", stored: true },
  ]);
  const { github, asked } = fakeGitHub(
    { [ARTIFACTS]: { total_count: 2, artifacts: [artifact(1), artifact(3)] } },
    { "/repos/mattermost/tpp/actions/artifacts/3/zip": archive },
  );
  const accountPath = join(dir, `account-${++dirs}`, "earlier-account");
  const inputs = earlierInputs({ accountPath });
  const logged: string[] = [];
  assert.equal(await earlierResponse(inputs, github, (m) => logged.push(m)), inputs.responsePath);
  assert.equal(readFileSync(inputs.responsePath, "utf8"), CREATED);
  assert.equal(readFileSync(accountPath, "utf8"), "dev\n");
  assert.deepEqual(asked, [ARTIFACTS, "/repos/mattermost/tpp/actions/artifacts/3/zip"]);
  assert.match(logged[0], /holds batch tpp-42-1-abc/);

  // Without account-path, nothing is written beside the response.
  const second = earlierInputs();
  assert.equal(await earlierResponse(second, github, () => {}), second.responsePath);
  assert.equal(existsSync(join(second.responsePath, "..", "e2e-test-stack-account")), false);
});

test("earlier-response reads the member response-member names", async () => {
  const { github } = fakeGitHub(
    { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } },
    {
      "/repos/mattermost/tpp/actions/artifacts/1/zip": zip([
        { name: "e2e-test-stack-create.json", data: "{}" },
        { name: "mobile/create.json", data: CREATED },
      ]),
    },
  );
  const inputs = earlierInputs({ responseMember: "mobile/create.json" });
  assert.equal(await earlierResponse(inputs, github, () => {}), inputs.responsePath);
  assert.equal(readFileSync(inputs.responsePath, "utf8"), CREATED);
});

test("an account that is missing, oversized or corrupt is skipped with a warning; the response is still written", async () => {
  const corrupt = zip([
    { name: "e2e-test-stack-create.json", data: CREATED },
    { name: "e2e-test-stack-account", data: "prod", stored: true },
  ]);
  corrupt[corrupt.indexOf("prod")] = "P".charCodeAt(0);
  for (const archive of [
    zip([{ name: "e2e-test-stack-create.json", data: CREATED }]),
    zip([
      { name: "e2e-test-stack-create.json", data: CREATED },
      { name: "e2e-test-stack-account", data: "x".repeat(65) },
    ]),
    corrupt,
  ]) {
    const { github } = fakeGitHub(
      { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } },
      { "/repos/mattermost/tpp/actions/artifacts/1/zip": archive },
    );
    const accountPath = join(dir, `account-${++dirs}`, "account");
    const inputs = earlierInputs({ accountPath });
    const logged: string[] = [];
    assert.equal(await earlierResponse(inputs, github, (m) => logged.push(m)), inputs.responsePath);
    assert.equal(readFileSync(inputs.responsePath, "utf8"), CREATED);
    assert.equal(existsSync(accountPath), false);
    assert.ok(logged.some((l) => /^::warning::.*no recorded account was written to account-path/.test(l)));
  }
});

test("a response that names no batch, as a refused create leaves, is reported as none with a warning", async () => {
  for (const data of [
    "",
    "{}",
    '{"errorMessage":"caller not registered"}',
    '{"batch_id":"","error":"refused"}',
    "null",
  ]) {
    const { github } = fakeGitHub(
      { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } },
      { "/repos/mattermost/tpp/actions/artifacts/1/zip": zip([{ name: "e2e-test-stack-create.json", data }]) },
    );
    const inputs = earlierInputs();
    const logged: string[] = [];
    assert.equal(await earlierResponse(inputs, github, (m) => logged.push(m)), undefined);
    assert.equal(existsSync(inputs.responsePath), false);
    assert.ok(logged.some((l) => /^::warning::.*the earlier attempt's response names no batch/.test(l)));
  }
});

test("earlier-response reads every page of artifacts", async () => {
  const page2 = ARTIFACTS.replace(/page=1$/, "page=2");
  const others = Array.from({ length: 100 }, (_, i) => artifact(100 + i, { name: "other" }));
  const { github, asked } = fakeGitHub(
    {
      [ARTIFACTS]: { total_count: 101, artifacts: others },
      [page2]: { total_count: 101, artifacts: [artifact(7)] },
    },
    { "/repos/mattermost/tpp/actions/artifacts/7/zip": zip([{ name: "e2e-test-stack-create.json", data: CREATED }]) },
  );
  assert.ok(await earlierResponse(earlierInputs(), github, () => {}));
  assert.deepEqual(asked.slice(0, 2), [ARTIFACTS, page2]);
});

test("earlier-response fails, never reports none, when an artifact exists but cannot be downloaded or read", async () => {
  const one = { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } };
  const failed = async (
    download: Buffer | Error | undefined,
    message: RegExp,
    pages: Record<string, unknown> = one,
  ) => {
    const { github } = fakeGitHub(pages, download ? { "/repos/mattermost/tpp/actions/artifacts/1/zip": download } : {});
    const inputs = earlierInputs();
    await assert.rejects(
      earlierResponse(inputs, github, () => {}),
      message,
    );
    assert.equal(existsSync(inputs.responsePath), false);
  };
  await failed(
    new GitHubError("e2e-test-stack: GitHub GET /zip failed: attempt 1: HTTP 502; attempt 2: HTTP 502"),
    /run 42's artifact e2e-test-stack-create exists but could not be downloaded: GitHub GET \/zip failed: attempt 1: HTTP 502; attempt 2: HTTP 502$/,
  );
  await failed(Buffer.from("not a zip"), /could not be read: not a ZIP archive/);
  await failed(zip([{ name: "other.json", data: CREATED }]), /holds no e2e-test-stack-create\.json$/);
  await failed(zip([{ name: "e2e-test-stack-create.json", data: '{"batch_id":"tpp-' }]), /that is not JSON/);
  await failed(zip([{ name: "e2e-test-stack-create.json", data: '{"batch_id":7}' }]), /whose batch_id is not a string/);
  await failed(undefined, /has expired/, {
    [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1, { expired: true })] },
  });
  const { github } = fakeGitHub({});
  await assert.rejects(
    earlierResponse(earlierInputs(), github, () => {}),
    /GitHub GET .*artifacts.* failed/,
  );
});

test("earlier-response removes stale files at response-path and account-path when it writes nothing", async () => {
  const stale = () => {
    const accountPath = join(dir, `account-${++dirs}`, "account");
    const inputs = { ...earlierInputs({ accountPath }), accountPath };
    for (const path of [inputs.responsePath, inputs.accountPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "stale");
    }
    return inputs;
  };
  const none = fakeGitHub({ [ARTIFACTS]: { total_count: 0, artifacts: [] } });
  const first = stale();
  assert.equal(await earlierResponse(first, none.github, () => {}), undefined);
  assert.deepEqual([existsSync(first.responsePath), existsSync(first.accountPath)], [false, false]);

  const noBatch = fakeGitHub(
    { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } },
    {
      "/repos/mattermost/tpp/actions/artifacts/1/zip": zip([
        { name: "e2e-test-stack-create.json", data: "{}" },
        { name: "e2e-test-stack-account", data: "dev" },
      ]),
    },
  );
  const second = stale();
  assert.equal(await earlierResponse(second, noBatch.github, () => {}), undefined);
  assert.deepEqual([existsSync(second.responsePath), existsSync(second.accountPath)], [false, false]);

  // A response with no account replaces the response and leaves no stale account.
  const noAccount = fakeGitHub(
    { [ARTIFACTS]: { total_count: 1, artifacts: [artifact(1)] } },
    { "/repos/mattermost/tpp/actions/artifacts/1/zip": zip([{ name: "e2e-test-stack-create.json", data: CREATED }]) },
  );
  const third = stale();
  assert.equal(await earlierResponse(third, noAccount.github, () => {}), third.responsePath);
  assert.equal(readFileSync(third.responsePath, "utf8"), CREATED);
  assert.equal(existsSync(third.accountPath), false);
});

test("the ZIP reader reads stored and deflated members by exact name, and refuses a corrupt or oversized one", () => {
  const archive = zip([
    { name: "a.json", data: '{"a":1}' },
    { name: "dir/a.json", data: "nested" },
    { name: "b.txt", data: "stored", stored: true },
  ]);
  assert.equal(readZipMember(archive, "a.json", 100)?.toString(), '{"a":1}');
  assert.equal(readZipMember(archive, "b.txt", 100)?.toString(), "stored");
  assert.equal(readZipMember(archive, "dir/a.json", 100)?.toString(), "nested");
  assert.equal(readZipMember(archive, "c.txt", 100), undefined);
  assert.throws(
    () => readZipMember(archive, "a.json", 3),
    (e: unknown) => e instanceof ZipError && /more than 3/.test(e.message),
  );

  const corrupt = Buffer.from(archive);
  const at = corrupt.indexOf("stored");
  corrupt[at] = "S".charCodeAt(0);
  assert.throws(() => readZipMember(corrupt, "b.txt", 100), /does not match its size and CRC-32/);
  assert.throws(() => readZipMember(Buffer.alloc(10), "a.json", 100), /not a ZIP archive/);
  // A member that inflates past its declared size is cut off at the limit.
  const bomb = zip([{ name: "a.json", data: "x".repeat(10_000) }]);
  bomb.writeUInt32LE(5, bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  assert.throws(() => readZipMember(bomb, "a.json", 100), /does not inflate|does not match/);
});
