// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { sleep as realSleep } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { createArtifact, createResponse } from "./core/artifacts.ts";
import { batchAttempt } from "./core/batch.ts";
import { parseResponse } from "./core/control-plane.ts";
import { ActionError } from "./core/errors.ts";
import { githubClient } from "./core/github.ts";
import {
  batchFrom,
  callerKeyFrom,
  credentialsKeyFrom,
  input,
  integer,
  refuse,
  repositoryFrom,
  runFrom,
} from "./core/inputs.ts";
import type { Run } from "./core/inputs.ts";
import { masker, settle } from "./core/outputs.ts";
import { entries, isObject, maskBatchSecrets, responseError } from "./core/response.ts";
import type { BatchSecrets, InstanceSecrets, Lease } from "./core/response.ts";
import { openBatchSecrets, SealedError } from "./core/sealed.ts";

/** Every output the open step writes; action.yml reads only these. */
export const OPEN_OUTPUTS = [
  "admin_email",
  "admin_password",
  "admin_username",
  "batch_id",
  "instances",
  "mail_token",
  "site_url",
] as const;
type OpenOutputs = { [K in (typeof OPEN_OUTPUTS)[number]]?: string };

export interface OpenInputs {
  callerKey: string;
  batch: string;
  /** The server whose fields are set as their own outputs. */
  index: number;
  /** The repository's credentials key, which opens the sealed secrets: an X25519 private key, 32 bytes. */
  credentialsKey: Uint8Array;
  /** Reads this run's artifacts. */
  githubToken: string;
  /** owner/name, from GITHUB_REPOSITORY. */
  repository: string;
  run: Run;
}

/** Reads and checks open's inputs and the job's run, before anything is called. */
export function readOpenInputs(env: Env): OpenInputs {
  const callerKey = callerKeyFrom(env);
  const batch = batchFrom(env);
  const run = runFrom(env);
  const repository = repositoryFrom(env);
  const index = integer("index", input(env, "index") || "0", 0);
  const credentialsKey = credentialsKeyFrom(input(env, "credentials-key"));
  const githubToken = input(env, "github-token");
  if (!githubToken)
    refuse(
      "github-token is required: a token that reads this run's artifacts, such as github.token with actions: read",
    );
  return { callerKey, batch, index, credentialsKey, githubToken, repository, run };
}

export interface OpenDeps {
  /** Takes progress and workflow commands (::add-mask::); stdout in the action. */
  log: (message: string) => void;
  /** Calls GitHub; the global fetch in the action. */
  fetch: FetchImpl;
  /** Waits between attempts. */
  sleep: Sleep;
  /** The time now, in milliseconds; Date.now in the action. */
  now: () => number;
}

/** One server as the instances output carries it: its site and admin, with its opened secrets. */
export interface Instance {
  site_url: string;
  state: string;
  admin_username: string;
  admin_email: string;
  admin_password: string;
  mail_token: string;
  credentials: Record<string, string>;
  facts: Record<string, string>;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** An object's string values; none for anything else. */
const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));

/** A ready server with its site and opened secrets; null for one that is not ready or has neither. */
function instance(lease: Lease | null, site: unknown, opened: InstanceSecrets | null | undefined): Instance | null {
  const siteUrl = text(lease?.site_url) || text(site);
  if (lease?.state !== "ready" || !siteUrl || !isObject(opened)) return null;
  return {
    site_url: siteUrl,
    state: lease.state,
    admin_username: text(lease.admin?.username),
    admin_email: text(lease.admin?.email),
    admin_password: text(opened.admin_password),
    mail_token: text(opened.mail_token),
    credentials: strings(opened.credentials),
    facts: strings(opened.facts),
  };
}

/**
 * Opens one server of this run's batch: finds the newest create response for batch among the run's artifacts, checks
 * it names this run's batch and that the batch has not expired, opens its sealed secrets with the credentials key and
 * masks them, and sets the server at index as outputs. Calls only GitHub, never AWS. Outputs are written whatever
 * happens.
 */
export function openWith(overrides: Partial<OpenDeps> = {}): (env: Env) => Promise<void> {
  const deps: OpenDeps = {
    log: overrides.log ?? console.log,
    fetch: overrides.fetch ?? fetch,
    sleep: overrides.sleep ?? realSleep,
    now: overrides.now ?? Date.now,
  };
  return (env) => openServer(env, deps);
}

async function openServer(env: Env, deps: OpenDeps): Promise<void> {
  const { log } = deps;
  const inputs = readOpenInputs(env);
  const outputs: OpenOutputs = {};
  const secrets = masker(log);
  const name = createArtifact(inputs.batch);
  let failure: unknown;
  try {
    const github = githubClient(inputs.githubToken, deps.fetch, deps.sleep, log);
    const found = await createResponse(
      github,
      { repository: inputs.repository, runId: inputs.run.runId },
      inputs.batch,
    );
    if (!found)
      throw new ActionError(
        `this run has no artifact ${name}: no create step for batch ${inputs.batch} uploaded a response in any of its attempts`,
      );

    const response = parseResponse(found.response.toString("utf8"));
    if (!response) throw new ActionError(`the create response in ${name} is not a JSON object`);
    const batchId = typeof response.batch_id === "string" ? response.batch_id : "";
    if (!batchId) {
      const error = responseError(response);
      throw new ActionError(
        `the create response in ${name} names no batch: the create for batch ${inputs.batch} made none${error ? ` (${error})` : ""}`,
      );
    }
    const createdIn = batchAttempt(batchId, { ...inputs.run, callerKey: inputs.callerKey, batch: inputs.batch });
    if (createdIn === undefined)
      throw new ActionError(
        `the create response in ${name} names batch ${JSON.stringify(batchId.slice(0, 100))}, which is not this run's: it must be ${inputs.callerKey}-${inputs.run.runId}-${inputs.batch}-<attempt 1 to ${inputs.run.attempt}>-<suffix>`,
      );
    outputs.batch_id = batchId;
    const expiresAt = Date.parse(typeof response.batch?.expires_at === "string" ? response.batch.expires_at : "");
    if (Number.isFinite(expiresAt) && expiresAt <= deps.now())
      throw new ActionError(
        `batch ${batchId} expired at ${new Date(expiresAt).toISOString()}, the end of its ttl, and is reaped; its servers cannot be opened`,
      );

    const sealed = response.batch?.secrets;
    if (typeof sealed !== "string" || !sealed) throw new ActionError(`batch ${batchId} has no sealed secrets`);
    let opened: BatchSecrets;
    try {
      opened = await openBatchSecrets(sealed, inputs.credentialsKey);
    } catch (e) {
      if (!(e instanceof SealedError)) throw e;
      throw new ActionError(`batch ${batchId}: ${e.message}`);
    }
    maskBatchSecrets(secrets, opened);

    const leases = Array.isArray(response.batch?.instances) ? response.batch.instances : [];
    const sites: unknown[] = Array.isArray(response.sites) ? response.sites : [];
    const openedInstances: unknown[] = Array.isArray(opened.instances) ? opened.instances : [];
    const instances = leases.map((lease, i) =>
      instance(lease, sites[i], openedInstances[i] as InstanceSecrets | null | undefined),
    );
    outputs.instances = JSON.stringify(instances);
    const one = instances[inputs.index];
    if (!one)
      throw new ActionError(
        `batch ${batchId} has no ready server at index ${inputs.index}: it lists ${leases.length}, ${instances.filter(Boolean).length} of them ready`,
      );
    outputs.site_url = one.site_url;
    outputs.admin_username = one.admin_username;
    outputs.admin_email = one.admin_email;
    outputs.admin_password = one.admin_password;
    outputs.mail_token = one.mail_token;
    log(`e2e-test-stack: opened server ${inputs.index} of batch ${batchId}, created in attempt ${createdIn}`);
  } catch (e) {
    failure = e;
  }
  settle(env, "open", outputs, [], failure);
}

/** The open action, as the bundle runs it. */
export const open = openWith();
