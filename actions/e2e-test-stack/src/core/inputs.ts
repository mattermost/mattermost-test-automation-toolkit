// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Env } from "../../../shared/src/github.ts";
import { ActionError } from "./errors.ts";

export type Channel = "edge" | "v1";

/** Refuses an input before anything is called. */
export const refuse = (message: string): never => {
  throw new ActionError(message);
};

/** A lowercase DNS label: the shape of the caller key, the project and the instance key. */
export const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** An input as the composite step passes it, STACK_<NAME>, trimmed; empty when unset. */
export const input = (env: Env, name: string): string =>
  (env[`STACK_${name.replace(/-/g, "_").toUpperCase()}`] ?? "").trim();

/** A whole number of at least min. */
export const integer = (name: string, value: string, min: number): number => {
  if (!/^-?\d+$/.test(value)) refuse(`${name} must be a whole number, got ${JSON.stringify(value)}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) refuse(`${name} is out of range, got ${value}`);
  if (n < min) refuse(`${name} must be ${min} or more, got ${value}`);
  return n;
};

/** "true" or "false"; undefined when empty. */
export const boolean = (name: string, value: string): boolean | undefined => {
  if (value === "") return undefined;
  if (value !== "true" && value !== "false") refuse(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
  return value === "true";
};

/** A value matching pattern; undefined when empty. */
export const matching = (name: string, value: string, pattern: RegExp, shape: string): string | undefined => {
  if (value === "") return undefined;
  if (!pattern.test(value)) refuse(`${name} must be ${shape}, got ${JSON.stringify(value)}`);
  return value;
};

/** Splits a comma- or newline-separated list, dropping blanks. */
export const list = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Decodes the credentials key, which must be standard base64 of 32 bytes. Its value is never quoted. */
export function credentialsKeyFrom(value: string): Uint8Array {
  if (!value)
    refuse("credentials-key is required: the repository's credentials key, from E2E_TEST_STACK_CREDENTIALS_KEY");
  const key = Buffer.from(value, "base64");
  if (!BASE64.test(value) || value.length % 4 !== 0 || key.length !== 32)
    refuse("credentials-key must be the repository's credentials key: 32 bytes, standard base64");
  return new Uint8Array(key);
}

/** The inputs every action that calls the control plane takes. */
export interface StackInputs {
  callerKey: string;
  channel: Channel;
  project: string;
  region: string;
}

/** Reads and checks caller-key, channel, project and region, with their defaults. */
export function stackInputs(env: Env): StackInputs {
  const callerKey = input(env, "caller-key");
  if (!callerKey) refuse("caller-key is required: the repository's key in the control plane's callers, e.g. mobile");
  matching("caller-key", callerKey, LABEL, "the repository's key: lowercase letters, digits and hyphens");
  const channel = input(env, "channel") || "v1";
  if (channel !== "edge" && channel !== "v1") refuse(`channel must be v1 or edge, got ${JSON.stringify(channel)}`);
  const project = input(env, "project") || "e2e-test-stack";
  matching("project", project, LABEL, "lowercase letters, digits and hyphens");
  const region = input(env, "region") || "us-east-1";
  matching("region", region, REGION, 'an AWS region such as "us-east-1"');
  return { callerKey, channel: channel as Channel, project, region };
}
