// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { sleep as realSleep } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { createResponse } from "./core/artifacts.ts";
import { batchAttempt } from "./core/batch.ts";
import { ActionError } from "./core/errors.ts";
import { githubClient } from "./core/github.ts";
import {
  batchFrom,
  credentialsKeyFrom,
  input,
  PROJECT,
  REGION,
  refuse,
  repositoryFrom,
  runFrom,
  stackInputs,
} from "./core/inputs.ts";
import type { Run, StackInputs } from "./core/inputs.ts";
import { abortableSleep, alias, lambdaClient, lambdaInvoke } from "./core/lambda.ts";
import type { Invoke, InvokeInput } from "./core/lambda.ts";
import { requestIdToken } from "./core/oidc.ts";
import { cell, masker, settle, writeFile } from "./core/outputs.ts";
import type { Masker } from "./core/outputs.ts";
import { callControlPlane, parseResponse, reason } from "./core/control-plane.ts";
import { redactArns } from "./core/redact.ts";
import { isObject, maskBatchSecrets, responseError } from "./core/response.ts";
import type { LogsSecrets } from "./core/response.ts";
import { assumeRole, roleArnFrom, stsClient } from "./core/role.ts";
import type { Credentials, StsSend } from "./core/role.ts";
import { checkRun, runTargetFrom } from "./core/run-check.ts";
import type { RunAllowance } from "./core/run-check.ts";
import { openBatchSecrets, openSealed, SealedError } from "./core/sealed.ts";

/** Every output the logs step writes; action.yml reads only these. */
export const LOGS_OUTPUTS = ["artifact_name", "logs_dir", "servers"] as const;
type LogsOutputs = { [K in (typeof LOGS_OUTPUTS)[number]]?: string };

/** Servers whose logs are collected at once: each full log is streamed to disk a line at a time. */
export const LOGS_CONCURRENCY = 4;
/** How long one full log may take to download and scrub, and the largest read. */
export const DOWNLOAD_TIMEOUT_MS = 300_000;
export const MAX_LOG_BYTES = 256 << 20;
/** About the size of the blocks the full log is scrubbed and written in. */
const BLOCK_BYTES = 1 << 20;
/** The largest tail unzipped. */
const MAX_TAIL_BYTES = 16 << 20;
/** The start of the control plane's answer for a batch with no live server. */
const GONE = "no live instances tagged";
const ARTIFACT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export interface LogsInputs extends StackInputs {
  batch: string;
  roleArn: string;
  /** The repository's credentials key, which opens the sealed secrets: an X25519 private key, 32 bytes. */
  credentialsKey: Uint8Array;
  githubToken: string;
  /** owner/name, from GITHUB_REPOSITORY. */
  repository: string;
  /** This job's run. */
  own: Run;
  /** The run whose batch's logs are collected: this run, or another named by run-id. */
  runId: string;
  /** What another run must be; undefined for this run. */
  allowance?: RunAllowance;
  /** The uploaded artifact's name starts with it. */
  artifactPrefix: string;
}

/** Reads and checks logs' inputs and the job's run, before anything is called. */
export function readLogsInputs(env: Env): LogsInputs {
  const common = stackInputs(env);
  const batch = batchFrom(env);
  const own = runFrom(env);
  const repository = repositoryFrom(env);
  const { runId, allowance } = runTargetFrom(env, own.runId);
  const artifactPrefix = input(env, "artifact-prefix") || "e2e-test-stack-logs";
  if (!ARTIFACT_PREFIX.test(artifactPrefix))
    refuse("artifact-prefix must be letters, digits, '.', '_' and '-', starting with a letter or digit, at most 100");
  const roleArn = roleArnFrom(input(env, "role-arn"), common.callerKey);
  const credentialsKey = credentialsKeyFrom(input(env, "credentials-key"));
  const githubToken = input(env, "github-token");
  if (!githubToken)
    refuse("github-token is required: a token that reads the run's artifacts, such as github.token with actions: read");
  return { ...common, batch, roleArn, credentialsKey, githubToken, repository, own, runId, allowance, artifactPrefix };
}

/** What logs calls, injectable for tests. */
export interface LogsDeps {
  /** Takes progress and workflow commands (::add-mask::); stdout in the action. */
  log: (message: string) => void;
  /** Requests the ID token, calls GitHub and downloads the logs; the global fetch in the action. */
  fetch: FetchImpl;
  /** Waits between attempts. */
  sleep: Sleep;
  /** The STS client for the region. */
  sts: (region: string) => StsSend;
  /** The invoke for the region, with the assumed role's credentials. */
  connect: (region: string, credentials: Credentials) => Invoke;
}

/** One server's collected log, as the servers output carries it. */
export interface ServerLog {
  index: number;
  instance_id: string;
  /** The file holding the full log, or its tail when the full log was not saved; empty when neither was. */
  path: string;
  /** True when path holds the whole log. */
  full: boolean;
  containers: string[];
}

/**
 * Replaces each of its values with ***, in one left-to-right pass, longest first, then takes ARNs out. Other 12-digit
 * numbers stay: a server's log holds sizes and ids.
 */
export interface Scrubber {
  (text: string): string;
  /** The longest value: a cut leaves at least this much after it, so a value crossing the cut is seen whole. */
  readonly hold: number;
  /** Where to cut text at or before at, so each side scrubs as the whole would. */
  cut(text: string, at: number): number;
  /** This scrubber with more values. */
  with(...more: string[]): Scrubber;
}

const WHITESPACE = /\s/;
/** How far back a cut looks for a line break or whitespace. */
const REACH = 1 << 16;

export const scrubber = (values: readonly string[]): Scrubber => {
  const sorted = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  // Outside a character class, these are every character a pattern treats as special.
  const pattern = sorted.length
    ? new RegExp(sorted.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;
  const scrub = (text: string) => redactArns(pattern ? text.replace(pattern, "***") : text);

  /** at, or the start of the value a scrub of the whole text matches across it. */
  const outsideValues = (text: string, at: number): number => {
    if (!pattern) return at;
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m && m.index < at; m = pattern.exec(text))
      if (m.index + m[0].length > at) return m.index;
    return at;
  };
  /**
   * The cut at or before at that leaves each side to scrub as the whole would: after a line break within REACH, else
   * after whitespace within REACH, and never inside a value. An ARN holds no whitespace, so it is split only within a
   * run of more than REACH characters without any; the cut is never inside a value or a character.
   */
  const cut = (text: string, at: number): number => {
    let c = at;
    for (let prev = -1; c !== prev;) {
      prev = c;
      const floor = Math.max(0, c - REACH);
      const line = text.lastIndexOf("\n", c - 1) + 1;
      let space = 0;
      for (let i = c - 1; i >= floor && !space; i--) if (WHITESPACE.test(text[i])) space = i + 1;
      c = outsideValues(text, line > floor ? line : space || c);
    }
    // A cut between the two halves of a character would write neither.
    const code = text.charCodeAt(c - 1);
    return code >= 0xd800 && code <= 0xdbff ? c - 1 : c;
  };
  return Object.assign(scrub, {
    hold: sorted[0]?.length ?? 0,
    cut,
    with: (...more: string[]) => scrubber([...sorted, ...more]),
  });
};

/** Runs each task, at most limit at once, keeping their order. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Collects the logs of every server still up in a run's batch: this run's, or another run's named by run-id once that
 * run is checked. The batch is the newest create response's, which must be exactly the run's. Each server's full log
 * is downloaded, a few at a time, bounded as it streams, with every known secret taken out, into one directory that
 * action.yml uploads. A batch already gone has no logs, and passes. Outputs and the summary are written whatever
 * happens.
 */
export function logsWith(overrides: Partial<LogsDeps> = {}): (env: Env) => Promise<void> {
  const log = overrides.log ?? console.log;
  const deps: LogsDeps = {
    log,
    fetch: overrides.fetch ?? fetch,
    sleep: overrides.sleep ?? realSleep,
    sts: overrides.sts ?? stsClient,
    connect:
      overrides.connect ??
      ((region, credentials) =>
        lambdaInvoke(lambdaClient(region, credentials), overrides.sleep ?? abortableSleep, log)),
  };
  return (env) => collectLogs(env, deps);
}

async function collectLogs(env: Env, deps: LogsDeps): Promise<void> {
  const { log } = deps;
  const outputs: LogsOutputs = {};
  const summary: string[] = ["### E2E test stack: logs", ""];
  const secrets = masker(log);
  const servers: ServerLog[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  let failure: unknown;
  // The steps; a return ends them early, and the outputs and summary are written after, whatever happened.
  const steps = async (): Promise<void> => {
    const inputs = readLogsInputs(env);
    const label = inputs.allowance ? `run ${inputs.runId}` : "this run";
    const github = githubClient(inputs.githubToken, deps.fetch, deps.sleep, log);
    const latest = inputs.allowance
      ? await checkRun(github, inputs.repository, inputs.runId, inputs.allowance, log)
      : inputs.own.attempt;

    const found = await createResponse(
      github,
      { repository: inputs.repository, runId: inputs.runId },
      inputs.batch,
      label,
    );
    const response = found ? parseResponse(found.response.toString("utf8")) : undefined;
    if (found && !response)
      throw new ActionError(`${label}'s create response for batch ${inputs.batch} is not a JSON object`);
    const batchId = typeof response?.batch_id === "string" ? response.batch_id : "";
    if (!response || !batchId) {
      log(`e2e-test-stack: ${label} created no batch ${inputs.batch}: no logs to collect`);
      summary.push(`${label} has no batch \`${cell(inputs.batch)}\`: no logs to collect.`);
      outputs.servers = "[]";
      return;
    }
    const owner = { callerKey: inputs.callerKey, runId: inputs.runId, batch: inputs.batch, attempt: latest };
    if (batchAttempt(batchId, owner) === undefined)
      throw new ActionError(
        `the newest create response names batch ${JSON.stringify(batchId.slice(0, 100))}, which is not ${label}'s batch ${inputs.batch}`,
      );
    summary.push(`Batch \`${cell(batchId)}\` of ${label}.`, "");

    const sealed = response.batch?.secrets;
    if (typeof sealed !== "string" || !sealed) throw new ActionError(`batch ${batchId} has no sealed secrets`);
    let batchToken: string;
    try {
      const opened = await openBatchSecrets(sealed, inputs.credentialsKey);
      maskBatchSecrets(secrets, opened);
      if (typeof opened.batch_token !== "string" || !opened.batch_token)
        throw new ActionError(`batch ${batchId}'s secrets hold no batch token`);
      batchToken = opened.batch_token;
    } catch (e) {
      if (!(e instanceof SealedError)) throw e;
      throw new ActionError(`batch ${batchId}: ${e.message}`);
    }

    const token = await requestIdToken(env, deps.fetch, deps.sleep, log);
    secrets.mask(token);
    const credentials = await assumeRole(deps.sts(REGION), {
      roleArn: inputs.roleArn,
      sessionName: `e2e-test-stack-logs-${inputs.own.runId}`,
      token,
    });
    secrets.mask(credentials.accessKeyId);
    secrets.mask(credentials.secretAccessKey);
    secrets.mask(credentials.sessionToken);
    const invoke = deps.connect(REGION, credentials);
    const target = alias(PROJECT, inputs.channel, inputs.callerKey);

    const fetched = await callControlPlane(invoke, target, {
      action: "fetch",
      batch_id: batchId,
      batch_token: batchToken,
    });
    if (fetched.refused !== undefined) {
      if (!fetched.refused.startsWith(GONE))
        throw new ActionError(`the fetch of batch ${batchId} was refused: ${fetched.refused}`);
      log(`e2e-test-stack: batch ${batchId} is gone: no logs to collect`);
      summary.push("The batch is gone: no logs to collect.");
      outputs.servers = "[]";
      return;
    }
    // The fetch's secrets are current: any changed since create are taken out of the logs too.
    const fetchedSecrets = fetched.response.batch?.secrets;
    if (typeof fetchedSecrets === "string" && fetchedSecrets)
      try {
        maskBatchSecrets(secrets, await openBatchSecrets(fetchedSecrets, inputs.credentialsKey));
      } catch (e) {
        if (!(e instanceof SealedError)) throw e;
        throw new ActionError(`batch ${batchId}'s fetched secrets: ${e.message}`);
      }
    const fetchError = responseError(fetched.response);
    if (fetchError) throw new ActionError(`the fetch of batch ${batchId} reported: ${fetchError}`);
    const state = fetched.response.batch?.state;
    if (state !== "found")
      throw new ActionError(
        `the fetch of batch ${batchId} reported state ${JSON.stringify(state ?? "none")}, not found`,
      );
    const leases = Array.isArray(fetched.response.batch?.instances) ? fetched.response.batch.instances : [];
    // Every server still listed, ready or not: one that failed is the one whose logs matter most.
    const up = leases.flatMap((l, i) => (isObject(l) ? [{ index: i, ready: l.state === "ready" }] : []));
    if (!up.length) {
      log(`e2e-test-stack: no server of batch ${batchId} is up: no logs to collect`);
      summary.push("No server of the batch is up: no logs to collect.");
      outputs.servers = "[]";
      return;
    }

    const dir = join(env.RUNNER_TEMP || tmpdir(), `e2e-test-stack-logs-${inputs.batch}-${randomUUID()}`);
    // Another run's logs name it, so collections for several runs in one attempt do not replace each other.
    const artifactName = `${inputs.artifactPrefix}-${inputs.batch}${inputs.allowance ? `-run-${inputs.runId}` : ""}-${inputs.own.attempt}`;
    // The role's account id, from its ARN, is taken out of the logs with the secrets.
    const scrub = scrubber([...secrets.masked, inputs.roleArn.split(":")[4] ?? ""]);
    log(
      `e2e-test-stack: collecting the logs of ${up.length} server(s) of batch ${batchId}, ${LOGS_CONCURRENCY} at a time`,
    );
    const collected = await pool(up, LOGS_CONCURRENCY, ({ index }) =>
      collectOne(index, batchId, batchToken, inputs.credentialsKey, dir, target, invoke, secrets, scrub, deps),
    );
    for (const [i, c] of collected.entries()) {
      servers.push(c.server);
      if (!c.failure) continue;
      // A server that was not ready may have no logs to give: that is noted, not a failure.
      if (up[i].ready) failures.push(c.failure);
      else notes.push(`${c.failure.replace(/\.?$/, ".")} It was not ready.`);
    }
    outputs.servers = JSON.stringify(servers);
    if (servers.some((s) => s.path)) {
      outputs.logs_dir = dir;
      outputs.artifact_name = artifactName;
    }
    if (failures.length) throw new ActionError(`logs of batch ${batchId}: ${failures.join("; ")}`);
  };
  try {
    await steps();
  } catch (e) {
    failure = e;
  }
  {
    if (servers.length) {
      summary.push("| Index | Server | Containers | Saved |", "|---|---|---|---|");
      for (const s of servers)
        summary.push(
          `| ${s.index} | \`${cell(s.instance_id)}\` | ${cell(s.containers.join(", "))} | ${s.full ? "the full log" : s.path ? "the tail, truncated" : "nothing"} |`,
        );
    } else if (failure) summary.push("No log was collected; the step's error says why.");
    if (notes.length) summary.push("", ...notes.map((n) => `- ${cell(n)}`));
  }
  settle(env, "logs", outputs, summary, failure);
}

/**
 * Downloads a presigned URL to path, following no redirect, within DOWNLOAD_TIMEOUT_MS and MAX_LOG_BYTES, scrubbing
 * and writing it in blocks of about BLOCK_BYTES. Each block ends where the scrubber's cut says, so a secret or an ARN
 * is seen whole in one block. A declared length over the limit is refused before the body is read, and a missing or
 * empty body is a failure, which leaves the tail as it was.
 */
async function downloadTo(fetchImpl: FetchImpl, url: string, path: string, scrub: Scrubber): Promise<void> {
  const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ActionError(`the download answered HTTP ${res.status}`);
  }
  const tooLarge = (what: string) => new ActionError(`the full log is too large: ${what}, more than ${MAX_LOG_BYTES}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_LOG_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(`${length} bytes`);
  }
  if (!res.body) throw new ActionError("the download has no body");
  mkdirSync(dirname(path), { recursive: true });
  const file = await open(path, "w");
  const reader = res.body.getReader();
  let done = false;
  try {
    const decoder = new TextDecoder();
    let read = 0;
    // Decoded text not yet written: whole lines, then the start of the next, kept as parts so none is rescanned.
    let parts: string[] = [];
    let pending = 0;
    const flush = async (text: string) => {
      // appendFile writes the whole text, however many writes it takes.
      if (text) await file.appendFile(scrub(text));
    };
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      read += chunk.value.byteLength;
      if (read > MAX_LOG_BYTES) throw tooLarge("its body");
      const text = decoder.decode(chunk.value, { stream: true });
      parts.push(text);
      pending += text.length;
      if (pending < BLOCK_BYTES + scrub.hold) continue;
      const joined = parts.join("");
      // At least the longest value is held back, so one crossing the cut is seen whole in the next block.
      const cut = scrub.cut(joined, joined.length - scrub.hold);
      await flush(joined.slice(0, cut));
      parts = [joined.slice(cut)];
      pending = parts[0].length;
    }
    if (!read) throw new ActionError("the download is empty");
    await flush(parts.join("") + decoder.decode());
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    await file.close();
  }
}

/** Collects one server's log: its tail first, then the full log over it; the failure, if any, with what was saved. */
async function collectOne(
  index: number,
  batchId: string,
  batchToken: string,
  credentialsKey: Uint8Array,
  dir: string,
  target: Omit<InvokeInput, "Payload">,
  invoke: Invoke,
  secrets: Masker,
  scrub: Scrubber,
  deps: LogsDeps,
): Promise<{ server: ServerLog; failure?: string }> {
  const server: ServerLog = { index, instance_id: "", path: "", full: false, containers: [] };
  try {
    const failure = await collectSteps(
      server,
      batchId,
      batchToken,
      credentialsKey,
      dir,
      target,
      invoke,
      secrets,
      scrub,
      deps,
    );
    return failure ? { server, failure: scrub(failure) } : { server };
  } catch (e) {
    // What was saved before the error stays: a tail on disk is still reported and uploaded.
    return { server, failure: `server ${index}: ${scrub(reason(e))}` };
  }
}

/** collectOne's steps, filling in server; the failure, if any. */
async function collectSteps(
  server: ServerLog,
  batchId: string,
  batchToken: string,
  credentialsKey: Uint8Array,
  dir: string,
  target: Omit<InvokeInput, "Payload">,
  invoke: Invoke,
  secrets: Masker,
  scrub: Scrubber,
  deps: LogsDeps,
): Promise<string | undefined> {
  const { index } = server;
  const called = await callControlPlane(invoke, target, {
    action: "logs",
    batch_id: batchId,
    batch_token: batchToken,
    index,
  });
  if (called.refused !== undefined) return `server ${index}: the logs call was refused: ${called.refused}`;
  const logs = called.response.logs;
  const error = responseError(called.response);
  const also = error ? ` The logs call also reported: ${error}.` : "";
  if (!isObject(logs)) return `server ${index}: the logs call returned no logs.${also}`;
  server.instance_id = typeof logs.instance_id === "string" ? logs.instance_id : "";
  server.containers = Array.isArray(logs.containers) ? logs.containers.filter((c) => typeof c === "string") : [];
  if (logs.no_object) return `server ${index}: no log was found for it.${also}`;
  if (typeof logs.secrets !== "string" || !logs.secrets)
    return `server ${index}: the logs call returned nothing sealed.${also}`;

  let opened: LogsSecrets;
  try {
    const value = await openSealed(logs.secrets, credentialsKey);
    opened = isObject(value) ? value : {};
  } catch (e) {
    if (!(e instanceof SealedError)) throw e;
    return `server ${index}: ${e.message}`;
  }
  // Used only to download the log here: masked in case an error quotes it, and never an output. Scrubbed by its own
  // pass, so no other server's log is matched against it.
  secrets.mask(opened.url);
  const url = typeof opened.url === "string" ? opened.url : "";
  const scrubbed = url ? scrub.with(url) : scrub;
  const path = resolve(join(dir, `server-${index}.log`));
  let tailFailure = "";
  if (typeof opened.content_gzip === "string" && opened.content_gzip)
    try {
      const tail = gunzipSync(Buffer.from(opened.content_gzip, "base64"), { maxOutputLength: MAX_TAIL_BYTES });
      // Written beside its place and moved there whole, so a failed write leaves no part of it to upload.
      const partial = `${path}.partial`;
      try {
        writeFile(partial, scrubbed(tail.toString("utf8")));
        renameSync(partial, path);
      } catch (e) {
        rmSync(partial, { force: true });
        throw e;
      }
      server.path = path;
      // Only a tail the control plane says is whole is the full log.
      server.full = logs.truncated === false;
    } catch (e) {
      tailFailure = ` The tail was not saved: ${reason(e)}.`;
    }
  const kept = server.path ? " The tail is saved." : tailFailure;
  if (server.full) {
    // The tail is the whole log: nothing more to download.
  } else if (url) {
    // Written beside the tail and moved over it whole, so a failed download or write leaves the tail as it was.
    const partial = `${path}.partial`;
    try {
      await downloadTo(deps.fetch, url, partial, scrubbed);
      renameSync(partial, path);
    } catch (e) {
      rmSync(partial, { force: true });
      // Nothing of the URL is quoted: the error's text is scrubbed of it.
      return `server ${index}: the full log was not saved: ${scrubbed(reason(e))}.${kept}${also}`;
    }
    server.path = path;
    server.full = true;
  } else
    return `server ${index}: the control plane returned no URL for its full log${server.path ? ", and the tail is truncated" : ""}.${kept}${also}`;
  if (error) return `server ${index}: the logs call reported: ${error}`;
  return undefined;
}

/** The logs action, as the bundle runs it. */
export const logs = logsWith();
