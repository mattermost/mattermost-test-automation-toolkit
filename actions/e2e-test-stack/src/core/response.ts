// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Masker } from "./outputs.ts";
import { redact } from "./redact.ts";

/** What a stack's time was spent on, as the control plane reports it. */
export interface Timing {
  total_seconds?: number;
  phases?: { name?: string; seconds?: number }[];
}

/** One instance of a batch, as the control plane describes it in the clear. */
export interface Lease {
  instance_id?: string;
  state?: string;
  site_url?: string;
  admin?: { username?: string; email?: string };
  instance_type?: string;
  /** From create: launch to ready. */
  timing?: Timing;
  service_seconds?: Record<string, number>;
  image_pull_seconds?: number;
  critical_path?: { chain?: string[]; seconds?: number };
  /** "<container> <image>", one per container. */
  containers?: string[];
  server_image?: { ref?: string; digest?: string; created_at?: string; age?: string; source?: string };
  ami_name?: string;
  /** Keycloak's sso- host, for an instance created with it. */
  sso_host?: string;
}

/** The control plane's reply; every secret in it is sealed. */
export interface StackResponse {
  batch_id?: string;
  sites?: string[];
  error?: unknown;
  deployment?: { build?: string; version?: string; invoked?: string };
  batch?: {
    state?: string;
    ready?: number;
    expires_at?: string;
    instances?: (Lease | null)[] | null;
    secrets?: string;
    timing?: Timing;
  };
}

/** One instance's secrets, as batch.secrets opens to them. */
export interface InstanceSecrets {
  admin_password?: string;
  mail_token?: string;
  credentials?: Record<string, string>;
  facts?: Record<string, string>;
}

/** What batch.secrets opens to. */
export interface BatchSecrets {
  batch_token?: string;
  instances?: (InstanceSecrets | null)[];
}

/** Credentials that name something rather than unlock it; masking them would redact every line that mentions them. */
const NOT_SECRET = new Set(["postgres.user", "postgres.database"]);
/** Facts that are secrets: openldap.bind_password, and any later one named the same way. */
const SECRET_FACT = /(password|secret|token|_key)$/;

/** Masks every secret of a batch: its token, and each instance's passwords, tokens, credentials and secret facts. */
export function maskBatchSecrets(masker: Masker, secrets: BatchSecrets): void {
  masker.mask(secrets.batch_token);
  for (const s of Array.isArray(secrets.instances) ? secrets.instances : []) {
    if (!isObject(s)) continue;
    masker.mask(s.admin_password);
    masker.mask(s.mail_token);
    for (const [k, v] of entries(s.credentials)) if (!NOT_SECRET.has(k)) masker.mask(v);
    for (const [k, v] of entries(s.facts)) if (SECRET_FACT.test(k)) masker.mask(v);
  }
}

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
/** An object's entries; none for anything else, so a string is not split into characters. */
const entries = (v: unknown): [string, string | undefined][] =>
  isObject(v) ? (Object.entries(v) as [string, string | undefined][]) : [];

/** The reply's error as text, redacted; empty when it has none. Whatever the field holds is reported, not thrown on. */
export function responseError(response: StackResponse): string {
  const raw = response.error;
  if (raw === undefined || raw === null || raw === "") return "";
  return redact(typeof raw === "string" ? raw : JSON.stringify(raw));
}
