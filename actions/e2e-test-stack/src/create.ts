// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientError } from "@smithy/core/retry";
import { sleep as realSleep } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { ActionError } from "./core/errors.ts";
import { githubClient } from "./core/github.ts";
import {
  boolean,
  credentialsKeyFrom,
  input,
  integer,
  LABEL,
  list,
  matching,
  refuse,
  stackInputs,
} from "./core/inputs.ts";
import type { StackInputs } from "./core/inputs.ts";
import { alias, lambdaClient, lambdaInvoke } from "./core/lambda.ts";
import type { Invoke, InvokeOutput } from "./core/lambda.ts";
import { requestIdToken } from "./core/oidc.ts";
import { appendSummary, cell, masker, writeFile, writeOutputs } from "./core/outputs.ts";
import { errorText, handlerError, redact } from "./core/redact.ts";
import { maskBatchSecrets, responseError } from "./core/response.ts";
import type { BatchSecrets, Lease, StackResponse } from "./core/response.ts";
import { ACCOUNT_FILE, assumeRole, chooseRole, stsClient } from "./core/role.ts";
import type { Account, Credentials, StsSend } from "./core/role.ts";
import { openSealed, SealedError } from "./core/sealed.ts";
import { isServer, serverImage } from "./core/server-image.ts";

/** The control plane's longest instance key. */
export const MAX_INSTANCE_KEY = 44;
/** The create response's file name, in the directory create writes it to. */
export const RESPONSE_FILE = "e2e-test-stack-create.json";

/** Every output the create step writes; action.yml reads only these. */
export const CREATE_OUTPUTS = [
  "account_path",
  "batch_id",
  "duration_seconds",
  "indexes",
  "response_path",
  "server_image",
  "sites",
  "state",
] as const;
type CreateOutputs = { [K in (typeof CREATE_OUTPUTS)[number]]?: string };

/** A batch name: 1 to 20 lowercase letters, digits and hyphens, starting and ending with a letter or digit. */
const BATCH = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;
const RUN_ID = /^\d+$/;
const SERVICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A Go duration: "90m", "1h30m", "4h".
const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const OS_VARIANT = /^[a-z][a-z0-9]*-[0-9]+[.][0-9]+$/;
const POSTGRES = /^[0-9]+(\.[0-9]+)*$/;
const LICENSE = /^[A-Za-z0-9._-]+$/;
const INSTANCE_TYPE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const SERVER_SETTING = /^MM_[A-Z0-9_]+$/;

/** The create request's fields, as the control plane names them; absent ones take its defaults. */
export interface CreateFields {
  instance_key: string;
  caller_run_id: string;
  server_image: string;
  count?: number;
  services?: string[];
  ttl?: string;
  os?: string;
  postgres?: string;
  license?: string;
  instance_type?: string;
  server_env?: Record<string, string>;
  retries?: number;
  shared_admin_password?: boolean;
  wait_for_migrations?: boolean;
}

export interface CreateInputs extends StackInputs {
  batch: string;
  account: Account;
  roleArn: string;
  /** The repository's credentials key, which opens the sealed secrets: an X25519 private key, 32 bytes. */
  credentialsKey: Uint8Array;
  /** server-image as given: master, latest, esr, or an image reference. */
  serverImage: string;
  /** The Bearer token for api.github.com; empty sends none. */
  githubToken: string;
  runId: string;
  /** The fields, server_image left empty until it is resolved. */
  fields: CreateFields;
}

const serverEnv = (value: string): Record<string, string> | undefined => {
  if (value === "") return undefined;
  const shape = 'server-env must be a JSON object, e.g. {"MM_FEATUREFLAGS_TESTFEATURE":"true"}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse(shape);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse(shape);
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SERVER_SETTING.test(k))
      refuse(
        `server-env key ${JSON.stringify(k)} is not a server setting: MM_ followed by uppercase letters, digits and underscores`,
      );
    if (typeof v !== "string")
      refuse(`server-env ${k} must be a string, as every environment variable is; got ${JSON.stringify(v)}`);
  }
  return parsed as Record<string, string>;
};

/** Reads and checks create's inputs, which its composite step passes as STACK_* variables, before anything is called. */
export function readCreateInputs(env: Env): CreateInputs {
  const get = (name: string) => input(env, name);
  const common = stackInputs(env);

  const batch = get("batch");
  if (!batch) refuse("batch is required: it names the batch within the run, e.g. ios");
  matching(
    "batch",
    batch,
    BATCH,
    "1 to 20 lowercase letters, digits and hyphens, starting and ending with a letter or digit",
  );
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  const attempt = (env.GITHUB_RUN_ATTEMPT ?? "").trim();
  if (!RUN_ID.test(runId) || !RUN_ID.test(attempt))
    refuse("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be set, as they are in a GitHub Actions job");
  const instanceKey = `${common.callerKey}-${runId}-${batch}-${attempt}`;
  if (instanceKey.length > MAX_INSTANCE_KEY)
    refuse(
      `the instance key ${instanceKey}, <caller-key>-<run id>-<batch>-<run attempt>, is ${instanceKey.length} characters; the control plane takes at most ${MAX_INSTANCE_KEY}. Shorten batch`,
    );
  // Holds for any caller key and batch that passed; checked so no other shape reaches the control plane.
  matching("the instance key", instanceKey, LABEL, "a lowercase DNS label");

  const { account, roleArn } = chooseRole({
    account: get("account"),
    roleArnProd: get("role-arn-prod"),
    roleArnDev: get("role-arn-dev"),
  });
  const credentialsKey = credentialsKeyFrom(get("credentials-key"));

  const image = get("server-image");
  if (!image)
    refuse(
      "server-image is required: master, latest, esr, or the image under test by tag, e.g. mattermostdevelopment/mattermost-enterprise-edition:master",
    );
  if (/\s/.test(image)) refuse(`server-image must be one image reference, got ${JSON.stringify(image)}`);

  const fields: CreateFields = { instance_key: instanceKey, caller_run_id: runId, server_image: "" };
  if (get("count")) fields.count = integer("count", get("count"), 1);
  const services = list(get("services"));
  for (const s of services) matching("each of services", s, SERVICE, "a service name such as minio or keycloak");
  if (services.length) fields.services = services;
  const ttl = matching("ttl", get("ttl"), DURATION, 'a duration such as "90m" or "4h"');
  if (ttl) fields.ttl = ttl;
  const os = matching("os", get("os"), OS_VARIANT, 'an OS variant such as "ubuntu-24.04"');
  if (os) fields.os = os;
  const postgres = matching("postgres", get("postgres"), POSTGRES, 'a version such as "16" or "16.4"');
  if (postgres) fields.postgres = postgres;
  const license = matching("license", get("license"), LICENSE, 'a licence SKU such as "enterprise-advanced"');
  if (license) fields.license = license;
  const instanceType = matching(
    "instance-type",
    get("instance-type"),
    INSTANCE_TYPE,
    'an EC2 instance type such as "m7i.xlarge"',
  );
  if (instanceType) fields.instance_type = instanceType;
  const settings = serverEnv(get("server-env"));
  if (settings) fields.server_env = settings;
  // Any negative number asks for no retries.
  if (get("retries")) fields.retries = integer("retries", get("retries"), -Infinity);
  const shared = boolean("shared-admin-password", get("shared-admin-password"));
  if (shared !== undefined) fields.shared_admin_password = shared;
  const wait = boolean("wait-for-migrations", get("wait-for-migrations"));
  if (wait !== undefined) fields.wait_for_migrations = wait;

  return {
    ...common,
    batch,
    account,
    roleArn,
    credentialsKey,
    serverImage: image,
    githubToken: get("github-token"),
    runId,
    fields,
  };
}

/** What create calls, injectable for tests. */
export interface CreateDeps {
  /** Takes progress and workflow commands (::add-mask::); stdout in the action. */
  log: (message: string) => void;
  /** Requests the ID token and calls GitHub; the global fetch in the action. */
  fetch: FetchImpl;
  /** Waits between attempts. */
  sleep: Sleep;
  /** The STS client for the region. */
  sts: (region: string) => StsSend;
  /** The invoke for the region, with the assumed role's credentials. */
  connect: (region: string, credentials: Credentials) => Invoke;
  /** The longest one fetch waits for its reply. */
  fetchTimeoutMs: number;
}

const seconds = (n: number | undefined): string => (typeof n === "number" ? `${n.toFixed(1)} s` : "");

/** The service that took longest to start, with its time. */
const slowest = (taken: Record<string, number> | undefined): string => {
  const [name, s] = Object.entries(taken ?? {}).sort((a, b) => b[1] - a[1])[0] ?? [];
  return name ? `${name} ${seconds(s)}` : "";
};

/** The rows a create adds to the job summary after its batch rows: the image, each server, each container's image. */
function serverRows(sites: string[], leases: (Lease | null)[]): string[] {
  const rows: string[] = [];
  const present = leases.filter((l): l is Lease => !!l);
  const first = present.find((l) => l.server_image || l.ami_name);
  const si = first?.server_image;
  if (si?.ref || si?.digest) {
    // The pull-through cache's host is not part of the image's name.
    const ref = (si.ref ?? "").replace(/^.*?\/dockerhub\//, "");
    const built = si.created_at ? `built ${si.created_at}${si.age ? ` (${si.age})` : ""}` : "";
    const parts = [ref && `\`${ref}\``, si.digest && `\`${si.digest}\``, built, si.source && `from ${si.source}`];
    rows.push(`| Server image | ${cell(parts.filter(Boolean).join(", "))} |`);
  }
  if (first?.ami_name) rows.push(`| Host image | \`${cell(first.ami_name)}\` |`);

  if (sites.length) {
    const extra: [string, (l: Lease) => string][] = [
      ["Type", (l) => l.instance_type ?? ""],
      ["Ready in", (l) => (l.state === "ready" ? seconds(l.timing?.total_seconds) : "")],
      ["Image pull", (l) => seconds(l.image_pull_seconds)],
      ["Slowest service", (l) => slowest(l.service_seconds)],
      [
        "Critical path",
        (l) =>
          l.critical_path?.chain?.length
            ? `${l.critical_path.chain.join(" → ")}, ${seconds(l.critical_path.seconds)}`
            : "",
      ],
    ];
    const head = ["Index", "State", "Site", ...extra.map(([name]) => name)];
    rows.push("", `| ${head.join(" | ")} |`, `|${head.map(() => "---|").join("")}`);
    sites.forEach((site, i) => {
      const lease = leases[i];
      const cells = [
        String(i),
        lease?.state ?? (site ? "" : "failed"),
        site,
        ...extra.map(([, f]) => (lease ? f(lease) : "")),
      ];
      rows.push(`| ${cells.map(cell).join(" | ")} |`);
    });
  }

  // Each container's image, across the batch; a container on images that differ lists each.
  const images = new Map<string, Set<string>>();
  for (const l of present)
    for (const entry of l.containers ?? []) {
      const [name, ...rest] = entry.split(" ");
      if (!name) continue;
      if (!images.has(name)) images.set(name, new Set());
      images.get(name)!.add(rest.join(" "));
    }
  if (images.size) {
    rows.push("", "| Container | Image |", "|---|---|");
    for (const [name, set] of [...images].sort(([a], [b]) => a.localeCompare(b)))
      rows.push(`| ${cell(name)} | ${[...set].map((i) => (i ? `\`${cell(i)}\`` : "")).join(", ")} |`);
  }
  return rows;
}

/** The reply's payload as text. */
const payloadText = (reply: InvokeOutput): string => Buffer.from(reply.Payload ?? new Uint8Array()).toString("utf8");

/**
 * Creates a batch: resolves the server image, records the account, assumes the CI role through GitHub OIDC, invokes
 * the caller's alias, writes the raw response, opens and masks its sealed secrets, and checks with a fetch that every
 * server is ready. Outputs and the summary are written whatever happens; a batch that was created but fails a check
 * still hands back its batch id and response.
 */
export function createWith(overrides: Partial<CreateDeps> = {}): (env: Env) => Promise<void> {
  const log = overrides.log ?? console.log;
  const sleep = overrides.sleep ?? realSleep;
  const deps: CreateDeps = {
    log,
    sleep,
    fetch: overrides.fetch ?? fetch,
    sts: overrides.sts ?? stsClient,
    connect:
      overrides.connect ?? ((region, credentials) => lambdaInvoke(lambdaClient(region, credentials), sleep, log)),
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
  };
  return (env) => createBatch(env, deps);
}

async function createBatch(env: Env, deps: CreateDeps): Promise<void> {
  const { log } = deps;
  const inputs = readCreateInputs(env);
  const outputs: CreateOutputs = {};
  // The batch's rows, then each server's and each container's, written last whatever happens.
  const summary: string[] = [];
  let serverTable: string[] = [];
  const secrets = masker(log);
  let failure: unknown;
  const target = alias(inputs.project, inputs.channel, inputs.callerKey);
  const named = `${target.FunctionName}:${target.Qualifier}`;
  const mayExist = " A batch may have been created; it is reaped at its ttl.";
  // Set once the reply names a batch: every later failure says what becomes of it.
  let teardown = "";

  // A failed write of the response is reported with whatever else fails, or last, so the batch is still handed back.
  let responseWriteError: unknown;
  const writeFailure = (): string => `the create response could not be written: ${errorText(responseWriteError)}.`;

  try {
    // The image first: a release that cannot be resolved creates nothing.
    let image = inputs.serverImage;
    if (isServer(image)) {
      const github = githubClient(inputs.githubToken, deps.fetch, deps.sleep, log);
      ({ image } = await serverImage(image, github));
      log(`e2e-test-stack: server-image ${inputs.serverImage}: ${image}`);
    }
    outputs.server_image = image;
    const fields: CreateFields = { ...inputs.fields, server_image: image };

    // The account is recorded before the create, so a response is never uploaded without it. Files left by an
    // earlier create of the same batch in this job are removed first.
    const dir = join(env.RUNNER_TEMP || tmpdir(), `e2e-test-stack-create-${inputs.batch}`);
    const responseFile = join(dir, RESPONSE_FILE);
    rmSync(responseFile, { force: true });
    outputs.account_path = writeFile(join(dir, ACCOUNT_FILE), `${inputs.account}\n`);

    const token = await requestIdToken(env, deps.fetch, deps.sleep, log);
    secrets.mask(token);
    const credentials = await assumeRole(deps.sts(inputs.region), {
      roleArn: inputs.roleArn,
      sessionName: `e2e-test-stack-create-${inputs.runId}`,
      token,
      account: inputs.account,
    });
    secrets.mask(credentials.accessKeyId);
    secrets.mask(credentials.secretAccessKey);
    secrets.mask(credentials.sessionToken);
    const invoke = deps.connect(inputs.region, credentials);

    log(`e2e-test-stack: create through ${named} in account ${inputs.account}, instance key ${fields.instance_key}`);
    let reply: InvokeOutput;
    try {
      reply = await invoke({ ...target, Payload: JSON.stringify({ action: "create", ...fields }) });
    } catch (e) {
      throw new ActionError(`the invoke of ${named} failed: ${errorText(e)}.${mayExist}`);
    }
    const text = payloadText(reply);
    try {
      outputs.response_path = writeFile(responseFile, text);
    } catch (e) {
      responseWriteError = e;
    }
    if (reply.FunctionError)
      throw new ActionError(`the control plane refused the create: ${handlerError(text)}.${mayExist}`);
    if (reply.StatusCode !== 200)
      throw new ActionError(`the invoke answered ${reply.StatusCode}: ${handlerError(text)}.${mayExist}`);

    let response: StackResponse;
    try {
      response = JSON.parse(text) as StackResponse;
    } catch {
      throw new ActionError(`the control plane's reply is not JSON: ${redact(text).slice(0, 200)}.${mayExist}`);
    }
    const error = responseError(response);
    const batchId = typeof response.batch_id === "string" ? response.batch_id : "";
    if (batchId)
      teardown = ` Batch ${batchId} was created; the destroy action releases it, or it is reaped at its ttl.`;
    const sites = Array.isArray(response.sites) ? response.sites : [];
    const leases = Array.isArray(response.batch?.instances) ? response.batch.instances : [];
    const state = response.batch?.state ?? "";
    const ready = response.batch?.ready ?? leases.filter((l) => l?.state === "ready").length;
    outputs.batch_id = batchId;
    outputs.sites = JSON.stringify(sites);
    outputs.state = state;
    // Timed whether or not every server became ready; a duration to ready only when they did.
    const timing = response.batch?.timing?.total_seconds;
    if (state === "ready" && typeof timing === "number") outputs.duration_seconds = String(timing);

    summary.push("### E2E test stack: create", "", "| | |", "|---|---|");
    summary.push(`| Batch | \`${cell(batchId || "none")}\` |`, `| State | ${cell(state || "unknown")} |`);
    summary.push(`| Ready | ${ready} of ${leases.length} |`);
    summary.push(`| Account | ${inputs.account} |`);
    if (response.batch?.expires_at) summary.push(`| Expires | ${cell(response.batch.expires_at)} |`);
    if (response.deployment)
      summary.push(
        `| Control plane | ${cell(response.deployment.invoked || target.Qualifier)}, version ${cell(response.deployment.version || "unknown")} |`,
      );
    if (typeof timing === "number")
      summary.push(
        `| Duration | ${seconds(timing)}, ${state === "ready" ? "request to every server ready" : "request to failure"} |`,
      );
    if (error) summary.push(`| Error | ${cell(error)} |`);
    serverTable = serverRows(sites, leases);

    // Opened and masked before any output is written.
    let batchToken: string | undefined;
    if (batchId) {
      if (!response.batch?.secrets)
        throw new ActionError(
          `batch ${batchId} came back with no sealed secrets${error ? ` (${error})` : ""}; without its batch token it cannot be destroyed, and is reaped at its ttl`,
        );
      let value: unknown;
      try {
        value = await openSealed(response.batch.secrets, inputs.credentialsKey);
      } catch (e) {
        if (!(e instanceof SealedError)) throw e;
        throw new ActionError(
          `batch ${batchId}: ${e.message} Without its batch token it cannot be destroyed; it is reaped at its ttl.`,
        );
      }
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new ActionError(
          `batch ${batchId}'s secrets are not an object, so it has no batch token and cannot be destroyed; it is reaped at its ttl`,
        );
      const opened: BatchSecrets = value;
      maskBatchSecrets(secrets, opened);
      if (typeof opened.batch_token !== "string" || !opened.batch_token)
        throw new ActionError(
          `batch ${batchId}'s secrets hold no batch token, so it cannot be destroyed; it is reaped at its ttl`,
        );
      batchToken = opened.batch_token;
    }

    if (error) throw new ActionError(`create reported: ${error}.${teardown || mayExist}`);
    if (responseWriteError)
      throw new ActionError(`${writeFailure()}${teardown || mayExist}`, { cause: responseWriteError });
    if (!batchId) throw new ActionError(`create returned no batch id.${mayExist}`);
    if (state !== "ready") throw new ActionError(`create reported state ${state || "none"}, not ready.${teardown}`);
    const expected = fields.count ?? sites.length;
    if (!expected || sites.length !== expected)
      throw new ActionError(`create returned ${sites.length} servers; ${expected} were asked for.${teardown}`);

    if (!batchToken) throw new ActionError(`batch ${batchId} has no batch token.${teardown}`);
    const fetched = await fetchReady(invoke, target, named, batchId, batchToken, expected, teardown, deps);
    summary.push(`| Fetched | ${fetched} |`);
    outputs.indexes = JSON.stringify(Array.from({ length: expected }, (_, i) => i));
  } catch (e) {
    const reported = e instanceof Error && e.cause === responseWriteError;
    failure = responseWriteError !== undefined && !reported ? also(e, writeFailure()) : e;
  }
  {
    // Written whatever happened. A sink that cannot be written does not hide the failure being reported; with none, it
    // is the failure.
    const unwritten: string[] = [];
    try {
      writeOutputs(env.GITHUB_OUTPUT, outputs);
    } catch (w) {
      unwritten.push(`the outputs could not be written (${errorText(w)})`);
    }
    try {
      appendSummary(env.GITHUB_STEP_SUMMARY, [...summary, ...serverTable]);
    } catch (w) {
      unwritten.push(`the summary could not be written (${errorText(w)})`);
    }
    if (unwritten.length && failure !== undefined) failure = also(failure, `${unwritten.join("; ")}.`);
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error("create failed with a value that is not an error", { cause: failure });
    if (unwritten.length) throw new ActionError(`${unwritten.join("; ")}.`);
  }
}

/**
 * A failure with more said about it, as an ActionError: one already gains the text, keeping its cause; any other value
 * becomes the cause. Messages are not assigned to, since some errors' cannot be.
 */
function also(failure: unknown, text: string): ActionError {
  if (failure instanceof ActionError)
    return new ActionError(`${failure.message} Also, ${text}`, { cause: failure.cause });
  return new ActionError(`create failed. Also, ${text}`, { cause: failure });
}

/** Fetches in all, the first included. */
export const FETCH_ATTEMPTS = 3;
/** The wait after a failed fetch, times the attempt that failed. */
export const FETCH_RETRY_MS = 5_000;
/** The longest one fetch waits: a fetch only reads, so it needs far less than a create. */
export const FETCH_TIMEOUT_MS = 120_000;

/** Whether a failed call may succeed when made again, by the AWS SDK's own rules: a network error, a timeout or a 5xx. */
const transientError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && isTransientError(e as Parameters<typeof isTransientError>[0]);

/**
 * Fetches the batch and requires the control plane to find it with every one of its expected servers ready. Returns
 * the summary's text for it; a failure says what becomes of the batch.
 */
async function fetchReady(
  invoke: Invoke,
  target: { FunctionName: string; Qualifier: string },
  named: string,
  batchId: string,
  batchToken: string,
  expected: number,
  teardown: string,
  deps: Pick<CreateDeps, "sleep" | "log" | "fetchTimeoutMs">,
): Promise<string> {
  const notReady = (reason: string) => new ActionError(`the fetch of batch ${batchId} ${reason}.${teardown}`);
  let reply: InvokeOutput | undefined;
  // A fetch only reads, so a dropped connection or a server error is tried again, unlike the create.
  for (let attempt = 1; !reply; attempt++) {
    const signal = AbortSignal.timeout(deps.fetchTimeoutMs);
    try {
      reply = await invoke(
        { ...target, Payload: JSON.stringify({ action: "fetch", batch_id: batchId, batch_token: batchToken }) },
        signal,
      );
    } catch (e) {
      const reason = signal.aborted ? `got no reply in ${deps.fetchTimeoutMs / 1000} s` : errorText(e);
      if (!(signal.aborted || transientError(e)) || attempt >= FETCH_ATTEMPTS)
        throw notReady(`through ${named} failed: ${reason}`);
      const ms = FETCH_RETRY_MS * attempt;
      deps.log(
        `e2e-test-stack: the fetch of batch ${batchId} failed (${reason}); trying again in ${ms / 1000} s (attempt ${attempt + 1} of ${FETCH_ATTEMPTS})`,
      );
      await deps.sleep(ms);
    }
  }
  const text = payloadText(reply);
  if (reply.FunctionError) throw notReady(`was refused: ${handlerError(text)}`);
  if (reply.StatusCode !== 200) throw notReady(`answered ${reply.StatusCode}: ${handlerError(text)}`);
  let response: StackResponse;
  try {
    response = JSON.parse(text) as StackResponse;
  } catch {
    throw notReady(`returned a reply that is not JSON: ${redact(text).slice(0, 200)}`);
  }
  const error = responseError(response);
  if (error) throw notReady(`reported: ${error}`);
  const state = response.batch?.state ?? "";
  const leases = Array.isArray(response.batch?.instances) ? response.batch.instances : [];
  const ready = leases.filter((l) => l?.state === "ready").length;
  if (state !== "found" || leases.length !== expected || ready !== expected)
    throw notReady(
      `found it ${state || "in no state"} with ${ready} of ${expected} servers ready, ${leases.length} listed; every server must be ready`,
    );
  return `found, ${ready} of ${expected} ready`;
}

/** The create action, as the bundle runs it. */
export const create = createWith();
