// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env } from "../../shared/src/github.ts";
import type { CheckRunInputs } from "./check-run.ts";
import type { EarlierInputs } from "./earlier.ts";
import type { RoleInputs } from "./role.ts";
import type { Server } from "./server-image.ts";

const OPERATIONS = [
  "create",
  "fetch",
  "logs",
  "destroy",
  "open",
  "role",
  "server-image",
  "check-run",
  "earlier-response",
] as const;
export type Operation = (typeof OPERATIONS)[number];
/** The operations that call no control plane and open no secret. */
const NO_STACK: readonly Operation[] = ["role", "server-image", "check-run", "earlier-response"];
export type Channel = "edge" | "v1";

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

export interface Inputs {
  operation: Operation;
  callerKey: string;
  channel: Channel;
  project: string;
  region: string;
  /** The repository's credentials key, which opens the sealed secrets: an X25519 private key, 32 bytes. */
  credentialsKey?: Uint8Array;
  batchId?: string;
  batchToken?: string;
  /** A create response written by response-path, to read the batch id and token from. */
  createResponse?: string;
  create?: CreateFields;
  index?: number;
  indexes?: number[];
  responsePath?: string;
  logsPath?: string;
  /** A create response's batch id must start with it. */
  expectBatchPrefix?: string;
  /** For destroy: probe the batch's hosts until each answers the router's 404. */
  verifyGone?: boolean;
  goneWindowSeconds?: number;
  role?: RoleInputs;
  server?: Server;
  /** The Bearer token for api.github.com; empty sends none. */
  githubToken?: string;
  checkRun?: CheckRunInputs;
  earlier?: EarlierInputs;
}

/** An input the action refuses before any call is made. */
export class InputError extends Error {}

const refuse = (message: string): never => {
  throw new InputError(`e2e-test-stack: ${message}`);
};

// A lowercase DNS label: the shape of the caller key, the project, the instance key and the batch id.
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const BATCH_ID = /^[a-z0-9-]{1,63}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const SERVICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A Go duration: "90m", "1h30m", "4h".
const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const OS_VARIANT = /^[a-z][a-z0-9]*-[0-9]+[.][0-9]+$/;
const POSTGRES = /^[0-9]+(\.[0-9]+)*$/;
const LICENSE = /^[A-Za-z0-9._-]+$/;
const INSTANCE_TYPE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const SERVER_SETTING = /^MM_[A-Z0-9_]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** How long verify-gone waits for each host, in seconds, unless gone-window says otherwise. */
export const GONE_WINDOW_SECONDS = 180;
// Ends with a hyphen, so mobile-123- cannot match run 1234's batch.
const BATCH_PREFIX = /^[a-z0-9][a-z0-9-]{0,60}-$/;
/** The longest gone-window, in seconds. */
export const MAX_GONE_WINDOW_SECONDS = 1800;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^\d+$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const EVENT = /^[a-z_]+$/;
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;
// A path inside an archive: names of letters, digits, dots, hyphens and underscores, none of them . or ..
const MEMBER = /^(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+)*$/;

const CREATE_ONLY = [
  ["instance-key", "STACK_INSTANCE_KEY"],
  ["server-image", "STACK_SERVER_IMAGE"],
  ["count", "STACK_COUNT"],
  ["services", "STACK_SERVICES"],
  ["ttl", "STACK_TTL"],
  ["os", "STACK_OS"],
  ["postgres", "STACK_POSTGRES"],
  ["license", "STACK_LICENSE"],
  ["instance-type", "STACK_INSTANCE_TYPE"],
  ["server-env", "STACK_SERVER_ENV"],
  ["retries", "STACK_RETRIES"],
  ["shared-admin-password", "STACK_SHARED_ADMIN_PASSWORD"],
  ["wait-for-migrations", "STACK_WAIT_FOR_MIGRATIONS"],
] as const;

/** Inputs that belong to some operations only: name, variable, the operations that take it. */
const OWN_INPUTS: readonly (readonly [string, string, readonly Operation[]])[] = [
  ["account", "STACK_ACCOUNT", ["role"]],
  ["account-file", "STACK_ACCOUNT_FILE", ["role"]],
  ["role-arn-prod", "STACK_ROLE_ARN_PROD", ["role"]],
  ["role-arn-dev", "STACK_ROLE_ARN_DEV", ["role"]],
  ["server", "STACK_SERVER", ["server-image"]],
  ["run-id", "STACK_RUN_ID", ["check-run", "earlier-response"]],
  ["allowed-workflows", "STACK_ALLOWED_WORKFLOWS", ["check-run"]],
  ["allowed-branches", "STACK_ALLOWED_BRANCHES", ["check-run"]],
  ["allowed-events", "STACK_ALLOWED_EVENTS", ["check-run"]],
  ["artifact-name", "STACK_ARTIFACT_NAME", ["earlier-response"]],
  ["response-member", "STACK_RESPONSE_MEMBER", ["earlier-response"]],
  ["account-path", "STACK_ACCOUNT_PATH", ["earlier-response"]],
  ["verify-gone", "STACK_VERIFY_GONE", ["destroy"]],
  ["gone-window", "STACK_GONE_WINDOW", ["destroy"]],
  ["expect-batch-prefix", "STACK_EXPECT_BATCH_PREFIX", ["fetch", "logs", "destroy", "open"]],
];

/** "a", "a and b", "a, b and c"; or with another conjunction. */
const and = (items: readonly string[], conjunction = "and"): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;

const article = (word: string): string => (/^[aeio]/.test(word) ? "an" : "a");

const integer = (name: string, value: string, min: number): number => {
  if (!/^-?\d+$/.test(value)) refuse(`${name} must be a whole number, got ${JSON.stringify(value)}`);
  const n = Number(value);
  if (n < min) refuse(`${name} must be ${min} or more, got ${value}`);
  return n;
};

const boolean = (name: string, value: string): boolean | undefined => {
  if (value === "") return undefined;
  if (value !== "true" && value !== "false") refuse(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
  return value === "true";
};

const matching = (name: string, value: string, pattern: RegExp, shape: string): string | undefined => {
  if (value === "") return undefined;
  if (!pattern.test(value)) refuse(`${name} must be ${shape}, got ${JSON.stringify(value)}`);
  return value;
};

/** Splits a comma- or newline-separated list, dropping blanks. */
const list = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Decodes the credentials key, which must be standard base64 of 32 bytes. */
export function credentialsKeyFrom(value: string): Uint8Array {
  const key = Buffer.from(value, "base64");
  if (!BASE64.test(value) || value.length % 4 !== 0 || key.length !== 32)
    refuse("credentials-key must be the repository's credentials key: 32 bytes, standard base64");
  return new Uint8Array(key);
}

const serverEnv = (value: string): Record<string, string> | undefined => {
  if (value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse('server-env must be a JSON object, e.g. {"MM_FEATUREFLAGS_TESTFEATURE":"true"}');
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    refuse('server-env must be a JSON object, e.g. {"MM_FEATUREFLAGS_TESTFEATURE":"true"}');
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

const createFields = (env: Env): CreateFields => {
  const get = (k: string) => (env[k] ?? "").trim();
  const instanceKey = get("STACK_INSTANCE_KEY");
  if (!instanceKey) refuse("instance-key is required for create; it names the stack, e.g. pr-1234");
  matching(
    "instance-key",
    instanceKey,
    LABEL,
    "lowercase letters, digits and hyphens, starting and ending with a letter or digit",
  );
  const callerRunId = get("STACK_CALLER_RUN_ID");
  if (!/^\d+$/.test(callerRunId))
    refuse(`caller-run-id must be a workflow run id (digits), got ${JSON.stringify(callerRunId)}`);
  const serverImage = get("STACK_SERVER_IMAGE");
  if (!serverImage)
    refuse(
      "server-image is required for create; name the image under test, e.g. mattermostdevelopment/mattermost-enterprise-edition:master",
    );
  if (/\s/.test(serverImage)) refuse(`server-image must be one image reference, got ${JSON.stringify(serverImage)}`);
  const fields: CreateFields = { instance_key: instanceKey, caller_run_id: callerRunId, server_image: serverImage };
  if (get("STACK_COUNT")) fields.count = integer("count", get("STACK_COUNT"), 1);
  const services = list(get("STACK_SERVICES"));
  for (const s of services) matching("each of services", s, SERVICE, "a service name such as minio or keycloak");
  if (services.length) fields.services = services;
  const ttl = matching("ttl", get("STACK_TTL"), DURATION, 'a duration such as "90m" or "4h"');
  if (ttl) fields.ttl = ttl;
  const os = matching("os", get("STACK_OS"), OS_VARIANT, 'an OS variant such as "ubuntu-24.04"');
  if (os) fields.os = os;
  const postgres = matching("postgres", get("STACK_POSTGRES"), POSTGRES, 'a version such as "16" or "16.4"');
  if (postgres) fields.postgres = postgres;
  const license = matching("license", get("STACK_LICENSE"), LICENSE, 'a licence SKU such as "enterprise-advanced"');
  if (license) fields.license = license;
  const instanceType = matching(
    "instance-type",
    get("STACK_INSTANCE_TYPE"),
    INSTANCE_TYPE,
    'an EC2 instance type such as "m7i.xlarge"',
  );
  if (instanceType) fields.instance_type = instanceType;
  const settings = serverEnv(get("STACK_SERVER_ENV"));
  if (settings) fields.server_env = settings;
  // Any negative number asks for no retries.
  if (get("STACK_RETRIES")) fields.retries = integer("retries", get("STACK_RETRIES"), -Infinity);
  const shared = boolean("shared-admin-password", get("STACK_SHARED_ADMIN_PASSWORD"));
  if (shared !== undefined) fields.shared_admin_password = shared;
  const wait = boolean("wait-for-migrations", get("STACK_WAIT_FOR_MIGRATIONS"));
  if (wait !== undefined) fields.wait_for_migrations = wait;
  return fields;
};

const batchPrefix = (value: string): string | undefined =>
  matching(
    "expect-batch-prefix",
    value,
    BATCH_PREFIX,
    'lowercase letters, digits and hyphens, ending with a hyphen, 62 or fewer, e.g. "mobile-1234-"',
  );

/** check-run's run, and the workflow files, branches and events it allows. */
const checkRunInputs = (env: Env, repository: string): CheckRunInputs => {
  const get = (k: string) => (env[k] ?? "").trim();
  const runId = get("STACK_RUN_ID");
  if (!RUN_ID.test(runId)) refuse(`run-id must be a workflow run id (digits), got ${JSON.stringify(runId)}`);
  const workflows = list(get("STACK_ALLOWED_WORKFLOWS"));
  if (!workflows.length)
    refuse("allowed-workflows is required for check-run: the workflow files whose runs may be read");
  for (const w of workflows)
    matching("each of allowed-workflows", w, WORKFLOW_PATH, 'a workflow file such as ".github/workflows/e2e.yml"');
  const pattern = get("STACK_ALLOWED_BRANCHES");
  if (!pattern) refuse("allowed-branches is required for check-run: a regular expression the whole branch matches");
  let branches: RegExp;
  try {
    // Compiled alone first: an unbalanced ")" would otherwise close the wrapping group and escape the anchors.
    new RegExp(pattern);
    branches = new RegExp(`^(?:${pattern})$`);
  } catch (e) {
    return refuse(`allowed-branches must be a JavaScript regular expression: ${(e as Error).message}`);
  }
  const events = list(get("STACK_ALLOWED_EVENTS"));
  if (!events.length) refuse("allowed-events is required for check-run: the events whose runs may be read");
  for (const e of events) matching("each of allowed-events", e, EVENT, 'an event name such as "push"');
  return { repository, runId, workflows, branches, events };
};

/** The inputs of role, server-image, check-run and earlier-response, which call no control plane. */
const noStackInputs = (env: Env, inputs: Inputs): Inputs => {
  const get = (k: string) => (env[k] ?? "").trim();
  const op = inputs.operation;
  for (const name of ["credentials-key", "batch-id", "batch-token", "create-response"])
    if (get(`STACK_${name.replace(/-/g, "_").toUpperCase()}`))
      refuse(`${name} is not ${article(op)} ${op} input; ${op} calls no control plane`);
  if (op !== "earlier-response" && inputs.responsePath)
    refuse(`response-path is not ${article(op)} ${op} input; ${op} calls no control plane`);
  const githubToken = get("STACK_GITHUB_TOKEN");
  const repository = (): string => {
    const repo = get("GITHUB_REPOSITORY");
    if (!REPOSITORY.test(repo))
      refuse(`GITHUB_REPOSITORY must name the repository as owner/name, got ${JSON.stringify(repo)}`);
    return repo;
  };
  const needToken = () => {
    if (!githubToken) refuse(`github-token is required for ${op}: it reads this repository's workflow runs`);
    inputs.githubToken = githubToken;
  };

  if (op === "role") {
    const account = get("STACK_ACCOUNT");
    if (!["", "prod", "dev", "recorded"].includes(account))
      refuse(`account must be prod, dev or recorded, got ${JSON.stringify(account)}`);
    inputs.role = {
      account,
      roleArnProd: get("STACK_ROLE_ARN_PROD"),
      roleArnDev: get("STACK_ROLE_ARN_DEV"),
    };
    if (get("STACK_ACCOUNT_FILE")) inputs.role.accountFile = get("STACK_ACCOUNT_FILE");
  } else if (op === "server-image") {
    const server = get("STACK_SERVER") || "master";
    if (server !== "master" && server !== "latest" && server !== "esr")
      refuse(`server must be master, latest or esr, got ${JSON.stringify(server)}`);
    inputs.server = server as Server;
    // The releases are public: no token reads them, at a lower rate limit.
    if (githubToken) inputs.githubToken = githubToken;
  } else if (op === "check-run") {
    needToken();
    inputs.checkRun = checkRunInputs(env, repository());
  } else {
    needToken();
    const runId = get("STACK_RUN_ID") || get("GITHUB_RUN_ID");
    if (!RUN_ID.test(runId)) refuse(`run-id must be a workflow run id (digits), got ${JSON.stringify(runId)}`);
    const artifactName =
      matching(
        "artifact-name",
        get("STACK_ARTIFACT_NAME"),
        ARTIFACT_NAME,
        "letters, digits, dots, hyphens and underscores",
      ) ?? "e2e-test-stack-create";
    if (!inputs.responsePath)
      refuse("response-path is required for earlier-response: where to write the create response it finds");
    const responseMember =
      matching(
        "response-member",
        get("STACK_RESPONSE_MEMBER"),
        MEMBER,
        "a file name in the artifact, such as e2e-test-stack-create.json",
      ) ?? "e2e-test-stack-create.json";
    inputs.earlier = {
      repository: repository(),
      runId,
      artifactName,
      responseMember,
      responsePath: inputs.responsePath!,
    };
    if (get("STACK_ACCOUNT_PATH")) inputs.earlier.accountPath = get("STACK_ACCOUNT_PATH");
  }
  return inputs;
};

/** Reads and checks the action's inputs, which the composite step passes as STACK_* variables. */
export function readInputs(env: Env): Inputs {
  const get = (k: string) => (env[k] ?? "").trim();
  const operation = get("STACK_OPERATION");
  if (!(OPERATIONS as readonly string[]).includes(operation))
    refuse(`operation must be ${and(OPERATIONS, "or")}, got ${JSON.stringify(operation)}`);
  const op = operation as Operation;
  const callerKey = get("STACK_CALLER_KEY");
  // open and the operations that call no control plane name no alias.
  if (!callerKey && op !== "open" && !NO_STACK.includes(op))
    refuse("caller-key is required: the repository's key in the control plane's callers, e.g. mobile");
  if (callerKey)
    matching("caller-key", callerKey, LABEL, "the repository's key: lowercase letters, digits and hyphens");
  const channel = get("STACK_CHANNEL") || "v1";
  if (channel !== "edge" && channel !== "v1") refuse(`channel must be v1 or edge, got ${JSON.stringify(channel)}`);
  const project = get("STACK_PROJECT") || "e2e-test-stack";
  matching("project", project, LABEL, "lowercase letters, digits and hyphens");
  const region = get("STACK_REGION") || "us-east-1";
  matching("region", region, REGION, 'an AWS region such as "us-east-1"');

  const inputs: Inputs = { operation: op, callerKey, channel: channel as Channel, project, region };
  if (get("STACK_RESPONSE_PATH")) inputs.responsePath = get("STACK_RESPONSE_PATH");

  for (const [name, key] of CREATE_ONLY)
    if (op !== "create" && get(key)) refuse(`${name} is a create input; ${op} does not take it`);
  if (op !== "logs" && op !== "open" && get("STACK_INDEX"))
    refuse(`index is a logs and open input; ${op} does not take it`);
  if (op !== "logs" && get("STACK_LOGS_PATH")) refuse(`logs-path is a logs input; ${op} does not take it`);
  if (op !== "fetch" && get("STACK_INDEXES")) refuse(`indexes is a fetch input; ${op} does not take it`);
  for (const [name, key, ops] of OWN_INPUTS)
    if (!ops.includes(op) && get(key))
      refuse(`${name} is ${article(ops[0])} ${and(ops)} input; ${op} does not take it`);

  if (NO_STACK.includes(op)) return noStackInputs(env, inputs);

  const credentialsKey = get("STACK_CREDENTIALS_KEY");
  if (credentialsKey) inputs.credentialsKey = credentialsKeyFrom(credentialsKey);

  if (op === "open") {
    for (const name of ["batch-id", "batch-token", "response-path"])
      if (get(`STACK_${name.replace(/-/g, "_").toUpperCase()}`))
        refuse(`${name} is not an open input; open reads the batch from create-response and calls nothing`);
    const createResponse = get("STACK_CREATE_RESPONSE");
    if (!createResponse) refuse("create-response is required for open: the create response file to open");
    if (!inputs.credentialsKey)
      refuse("credentials-key is required for open: the create response's secrets are sealed to it");
    inputs.createResponse = createResponse;
    if (get("STACK_INDEX")) inputs.index = integer("index", get("STACK_INDEX"), 0);
    const prefix = batchPrefix(get("STACK_EXPECT_BATCH_PREFIX"));
    if (prefix) inputs.expectBatchPrefix = prefix;
    return inputs;
  }

  if (op === "create") {
    for (const name of ["batch-id", "batch-token", "create-response"])
      if (get(`STACK_${name.replace(/-/g, "_").toUpperCase()}`))
        refuse(`${name} names an existing batch; create does not take it`);
    if (!inputs.credentialsKey)
      refuse(
        "credentials-key is required for create: without it the batch token, and so the batch's teardown, cannot be read",
      );
    inputs.create = createFields(env);
    return inputs;
  }

  const batchId = get("STACK_BATCH_ID");
  const batchToken = get("STACK_BATCH_TOKEN");
  const createResponse = get("STACK_CREATE_RESPONSE");
  if (createResponse) {
    if (batchToken) refuse("give batch-token or create-response, not both");
    if (!inputs.credentialsKey)
      refuse("credentials-key is required with create-response: the batch token in it is sealed");
    inputs.createResponse = createResponse;
  } else {
    if (!batchId) refuse(`batch-id is required for ${op}, or create-response to read it from`);
    if (!batchToken)
      refuse(
        `batch-token is required for ${op}, or create-response to read it from; create's batch-token output carries it`,
      );
    if (/\s/.test(batchToken)) refuse("batch-token must be one token, as create returned it");
    inputs.batchToken = batchToken;
  }
  if (batchId)
    inputs.batchId = matching("batch-id", batchId, BATCH_ID, "lowercase letters, digits and hyphens, 63 or fewer");
  const prefix = batchPrefix(get("STACK_EXPECT_BATCH_PREFIX"));
  if (prefix) {
    if (!createResponse) refuse("expect-batch-prefix checks the batch in create-response; give create-response");
    inputs.expectBatchPrefix = prefix;
  }
  if (op === "destroy") {
    const window = get("STACK_GONE_WINDOW");
    if (boolean("verify-gone", get("STACK_VERIFY_GONE"))) {
      if (!createResponse) refuse("verify-gone needs create-response: the hosts it probes are read from it");
      inputs.verifyGone = true;
      inputs.goneWindowSeconds = window ? integer("gone-window", window, 1) : GONE_WINDOW_SECONDS;
      if (inputs.goneWindowSeconds > MAX_GONE_WINDOW_SECONDS)
        refuse(`gone-window must be ${MAX_GONE_WINDOW_SECONDS} or less, got ${window}`);
    } else if (window) refuse('gone-window is used only with verify-gone: "true"');
  }
  if (op !== "destroy" && !inputs.credentialsKey)
    refuse(`credentials-key is required for ${op}: its secrets come back sealed to it`);
  if (op === "logs") {
    if (get("STACK_INDEX")) inputs.index = integer("index", get("STACK_INDEX"), 0);
    if (get("STACK_LOGS_PATH")) inputs.logsPath = get("STACK_LOGS_PATH");
  }
  if (op === "fetch") {
    const indexes = list(get("STACK_INDEXES")).map((s) => integer("each of indexes", s, 0));
    if (indexes.length) inputs.indexes = indexes;
  }
  return inputs;
}
