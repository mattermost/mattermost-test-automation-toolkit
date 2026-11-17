// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env } from "../../shared/src/github.ts";

export type Operation = "create" | "fetch" | "logs" | "destroy" | "open";
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
  /** The repository's X25519 private key, 32 bytes. */
  privateKey?: Uint8Array;
  batchId?: string;
  batchToken?: string;
  /** A create response written by response-path, to read the batch id and token from. */
  createResponse?: string;
  create?: CreateFields;
  index?: number;
  indexes?: number[];
  responsePath?: string;
  logsPath?: string;
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

/** Decodes the private key, which must be standard base64 of 32 bytes. */
export function privateKeyFrom(value: string): Uint8Array {
  const key = Buffer.from(value, "base64");
  if (!BASE64.test(value) || value.length % 4 !== 0 || key.length !== 32)
    refuse("private-key must be the repository's X25519 private key: 32 bytes, standard base64");
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

/** Reads and checks the action's inputs, which the composite step passes as STACK_* variables. */
export function readInputs(env: Env): Inputs {
  const get = (k: string) => (env[k] ?? "").trim();
  const operation = get("STACK_OPERATION");
  if (!["create", "fetch", "logs", "destroy", "open"].includes(operation))
    refuse(`operation must be create, fetch, logs, destroy or open, got ${JSON.stringify(operation)}`);
  const op = operation as Operation;
  const callerKey = get("STACK_CALLER_KEY");
  // open calls nothing, so it names no alias.
  if (!callerKey && op !== "open")
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

  const privateKey = get("STACK_PRIVATE_KEY");
  if (privateKey) inputs.privateKey = privateKeyFrom(privateKey);

  if (op === "open") {
    for (const name of ["batch-id", "batch-token", "response-path"])
      if (get(`STACK_${name.replace(/-/g, "_").toUpperCase()}`))
        refuse(`${name} is not an open input; open reads the batch from create-response and calls nothing`);
    const createResponse = get("STACK_CREATE_RESPONSE");
    if (!createResponse) refuse("create-response is required for open: the create response file to open");
    if (!inputs.privateKey) refuse("private-key is required for open: the create response's secrets are sealed to it");
    inputs.createResponse = createResponse;
    if (get("STACK_INDEX")) inputs.index = integer("index", get("STACK_INDEX"), 0);
    return inputs;
  }

  if (op === "create") {
    for (const name of ["batch-id", "batch-token", "create-response"])
      if (get(`STACK_${name.replace(/-/g, "_").toUpperCase()}`))
        refuse(`${name} names an existing batch; create does not take it`);
    if (!inputs.privateKey)
      refuse(
        "private-key is required for create: without it the batch token, and so the batch's teardown, cannot be read",
      );
    inputs.create = createFields(env);
    return inputs;
  }

  const batchId = get("STACK_BATCH_ID");
  const batchToken = get("STACK_BATCH_TOKEN");
  const createResponse = get("STACK_CREATE_RESPONSE");
  if (createResponse) {
    if (batchToken) refuse("give batch-token or create-response, not both");
    if (!inputs.privateKey) refuse("private-key is required with create-response: the batch token in it is sealed");
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
  if (op !== "destroy" && !inputs.privateKey)
    refuse(`private-key is required for ${op}: its secrets come back sealed to it`);
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
