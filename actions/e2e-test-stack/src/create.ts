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
  batchFrom,
  boolean,
  credentialsKeyFrom,
  input,
  integer,
  LABEL,
  list,
  matching,
  PROJECT,
  REGION,
  refuse,
  runFrom,
  stackInputs,
} from "./core/inputs.ts";
import type { StackInputs } from "./core/inputs.ts";
import { alias, lambdaClient, lambdaInvoke } from "./core/lambda.ts";
import type { Invoke, InvokeOutput } from "./core/lambda.ts";
import { requestIdToken } from "./core/oidc.ts";
import { also, cell, masker, settle, writeFile } from "./core/outputs.ts";
import { errorText, handlerError, redact } from "./core/redact.ts";
import { maskBatchSecrets, RESPONSE_FILE, responseError } from "./core/response.ts";
import type { BatchSecrets, Lease, StackResponse } from "./core/response.ts";
import { assumeRole, roleArnFrom, stsClient } from "./core/role.ts";
import type { Credentials, StsSend } from "./core/role.ts";
import { openBatchSecrets, SealedError } from "./core/sealed.ts";
import { isServer, serverImage } from "./core/server-image.ts";

/** The control plane's longest instance key. */
export const MAX_INSTANCE_KEY = 44;

/** Every output the create step writes; action.yml reads only these. */
export const CREATE_OUTPUTS = [
  "batch_id",
  "duration_seconds",
  "indexes",
  "response_path",
  "server_image",
  "sites",
  "state",
] as const;
type CreateOutputs = { [K in (typeof CREATE_OUTPUTS)[number]]?: string };

/** A service name: lowercase letters and digits, in parts joined by single hyphens. */
const SERVICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// One part of a Go duration ("90m", "1h30m", "4h"), and a whole one.
const DURATION_PART = /(\d+)(?:\.(\d+))?(ns|us|µs|ms|s|m|h)/g;
const DURATION = new RegExp(`^(?:${DURATION_PART.source})+$`);
const UNIT_NS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};
const SERVER_SETTING = /^MM_[A-Z0-9_]+$/;

/** The OS variants the deployment builds images for, and the default. */
export const OS_VARIANTS = ["ubuntu-24.04", "ubuntu-26.04"] as const;
export const DEFAULT_OS = "ubuntu-24.04";
/** The Postgres major versions the deployment mirrors, and the default. */
export const POSTGRES_VERSIONS = ["14", "15", "16", "17", "18"] as const;
export const DEFAULT_POSTGRES = "16";
/** The licence SKUs the deployment holds, and the default. Empty runs unlicensed. */
export const LICENSES = ["enterprise-advanced"] as const;
export const DEFAULT_LICENSE = "enterprise-advanced";
/** The ttl when none is given. */
export const DEFAULT_TTL = "2h";
/** The control plane's longest ttl. */
export const MAX_TTL = "4h";

/**
 * A Go duration in nanoseconds, as time.ParseDuration reads it: each part's fraction is truncated to whole
 * nanoseconds. Takes a value that matches DURATION.
 */
export const durationNs = (value: string): bigint => {
  let ns = 0n;
  for (const [, whole, fraction = "", unit] of value.matchAll(DURATION_PART)) {
    const per = UNIT_NS[unit];
    ns += BigInt(whole) * per + (BigInt(fraction || "0") * per) / 10n ** BigInt(fraction.length);
  }
  return ns;
};
const MAX_TTL_NS = durationNs(MAX_TTL);

/** One of the allowed values, or fallback when empty; anything else is refused, naming them. */
const oneOf = (name: string, value: string, allowed: readonly string[], fallback: string): string => {
  if (value === "") return fallback;
  if (!allowed.includes(value))
    refuse(
      `${name} must be ${allowed.slice(0, -1).join(", ")}${allowed.length > 1 ? " or " : ""}${allowed.at(-1)}, got ${JSON.stringify(value)}`,
    );
  return value;
};

/** A Go duration greater than zero and no longer than MAX_TTL; DEFAULT_TTL when empty. */
const ttlFrom = (value: string): string => {
  const ttl = value || DEFAULT_TTL;
  matching("ttl", ttl, DURATION, 'a duration such as "90m" or "2h"');
  const ns = durationNs(ttl);
  if (ns <= 0n) refuse(`ttl must be longer than 0, got ${JSON.stringify(ttl)}`);
  if (ns > MAX_TTL_NS)
    refuse(`ttl must be ${MAX_TTL} or less, the control plane's ceiling, got ${JSON.stringify(ttl)}`);
  return ttl;
};

/** The create request's fields, as the control plane names them; absent ones take its defaults. */
export interface CreateFields {
  instance_key: string;
  caller_run_id: string;
  server_image: string;
  ttl: string;
  os: string;
  postgres: string;
  count?: number;
  services?: string[];
  license?: string;
  server_env?: Record<string, string>;
  retries?: number;
  shared_admin_password?: boolean;
  wait_for_migrations?: boolean;
}

export interface CreateInputs extends StackInputs {
  batch: string;
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

  const batch = batchFrom(env);
  const { runId, attempt } = runFrom(env);
  const instanceKey = `${common.callerKey}-${runId}-${batch}-${attempt}`;
  if (instanceKey.length > MAX_INSTANCE_KEY)
    refuse(
      `the instance key ${instanceKey}, <caller-key>-<run id>-<batch>-<run attempt>, is ${instanceKey.length} characters; the control plane takes at most ${MAX_INSTANCE_KEY}. Shorten batch`,
    );
  // Holds for any caller key and batch that passed; checked so no other shape reaches the control plane.
  matching("the instance key", instanceKey, LABEL, "a lowercase DNS label");

  const roleArn = roleArnFrom(get("role-arn"), common.callerKey);
  const credentialsKey = credentialsKeyFrom(get("credentials-key"));

  const image = get("server-image");
  if (!image)
    refuse(
      "server-image is required: master, latest, esr, or the image under test by tag, e.g. mattermostdevelopment/mattermost-enterprise-edition:master",
    );
  if (/\s/.test(image)) refuse(`server-image must be one image reference, got ${JSON.stringify(image)}`);

  const fields: CreateFields = {
    instance_key: instanceKey,
    caller_run_id: runId,
    server_image: "",
    ttl: ttlFrom(get("ttl")),
    os: oneOf("os", get("os"), OS_VARIANTS, DEFAULT_OS),
    postgres: oneOf("postgres", get("postgres"), POSTGRES_VERSIONS, DEFAULT_POSTGRES),
  };
  if (get("count")) fields.count = integer("count", get("count"), 1);
  const services = list(get("services"));
  for (const s of services) matching("each of services", s, SERVICE, "a service name such as minio or keycloak");
  if (services.length) fields.services = services;
  // Unset takes the default, as action.yml's default does; set empty, it runs unlicensed.
  const license = env.STACK_LICENSE === undefined ? DEFAULT_LICENSE : get("license");
  if (license) fields.license = oneOf("license", license, LICENSES, DEFAULT_LICENSE);
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
 * Creates a batch: resolves the server image, assumes the CI role through GitHub OIDC, invokes
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
  const target = alias(PROJECT, inputs.channel, inputs.callerKey);
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

    // A response left by an earlier create of the same batch in this job is removed first.
    const responseFile = join(env.RUNNER_TEMP || tmpdir(), `e2e-test-stack-create-${inputs.batch}`, RESPONSE_FILE);
    rmSync(responseFile, { force: true });

    const token = await requestIdToken(env, deps.fetch, deps.sleep, log);
    secrets.mask(token);
    const credentials = await assumeRole(deps.sts(REGION), {
      roleArn: inputs.roleArn,
      sessionName: `e2e-test-stack-create-${inputs.runId}`,
      token,
    });
    secrets.mask(credentials.accessKeyId);
    secrets.mask(credentials.secretAccessKey);
    secrets.mask(credentials.sessionToken);
    const invoke = deps.connect(REGION, credentials);

    log(`e2e-test-stack: create through ${named}, instance key ${fields.instance_key}`);
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
      let opened: BatchSecrets;
      try {
        opened = await openBatchSecrets(response.batch.secrets, inputs.credentialsKey);
      } catch (e) {
        if (!(e instanceof SealedError)) throw e;
        throw new ActionError(
          `batch ${batchId}: ${e.message}. Without its batch token it cannot be destroyed; it is reaped at its ttl.`,
        );
      }
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
    failure = responseWriteError !== undefined && !reported ? also("create", e, writeFailure()) : e;
  }
  settle(env, "create", outputs, [...summary, ...serverTable], failure);
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
