// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { Masker } from "./outputs.ts";
import { redact } from "./redact.ts";

/** The create response's file, and its member in the uploaded artifact. */
export const RESPONSE_FILE = "e2e-test-stack-create.json";

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
  /** From destroy. */
  cost?: Cost;
  metrics?: { cpu_average?: number; cpu_peak?: number };
}

/** What a server or a batch cost, as destroy reports it. */
export interface Cost {
  instance_type?: string;
  hours?: number;
  total?: number;
  /** False when the instance type has no known rate: a zero total is then not free. */
  estimated?: boolean;
  currency?: string;
  /** No usable start time, so nothing was computed. */
  start_unknown?: boolean;
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
    /** From destroy. */
    cost?: Cost;
    sizing?: {
      instance_type?: string;
      sustained_cpu?: number;
      alternative?: string;
      counterfactual?: number;
      saving?: number;
      note?: string;
    };
  };
  /** From logs. */
  logs?: Logs;
}

/** One server's logs, as a logs call reports them; the URL and tail are sealed. */
export interface Logs {
  instance_id?: string;
  index?: number;
  containers?: string[];
  lines?: number;
  bytes?: number;
  truncated?: boolean;
  /** No log object was found: the command printed nothing, or its output was not yet written. */
  no_object?: boolean;
  secrets?: string;
}

/** What logs.secrets opens to: the full log's presigned URL, and its tail, gzipped and base64. */
export interface LogsSecrets {
  url?: string;
  content_gzip?: string;
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

export const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
/** An object's entries; none for anything else, so a string is not split into characters. */
export const entries = (v: unknown): [string, string | undefined][] =>
  isObject(v) ? (Object.entries(v) as [string, string | undefined][]) : [];

/** The reply's error as text, redacted; empty when it has none. Whatever the field holds is reported, not thrown on. */
export function responseError(response: StackResponse): string {
  const raw = response.error;
  if (raw === undefined || raw === null || raw === "") return "";
  return redact(typeof raw === "string" ? raw : JSON.stringify(raw));
}
