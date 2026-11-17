// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Env } from "../../shared/src/github.ts";
import { BATCH_ID, readInputs } from "./inputs.ts";
import type { Inputs } from "./inputs.ts";
import { openSealed, SealedError } from "./sealed.ts";

/** One Lambda Invoke call, as the action makes it. */
export interface InvokeInput {
  FunctionName: string;
  Qualifier: string;
  Payload: string;
}

/** What the action reads of the Invoke reply. */
export interface InvokeOutput {
  StatusCode?: number;
  FunctionError?: string;
  Payload?: Uint8Array;
}

export type Invoke = (input: InvokeInput) => Promise<InvokeOutput>;

/** One instance of a batch, as the control plane describes it in the clear. */
interface Lease {
  instance_id?: string;
  state?: string;
  site_url?: string;
  admin?: { username?: string; email?: string };
}

/** The control plane's reply; every secret in it is sealed. */
export interface StackResponse {
  batch_id?: string;
  sites?: string[];
  error?: string | null;
  deployment?: { build?: string; version?: string; invoked?: string };
  batch?: {
    state?: string;
    ready?: number;
    expires_at?: string;
    instances?: (Lease | null)[] | null;
    secrets?: string;
  };
  logs?: {
    instance_id?: string;
    index?: number;
    containers?: string[];
    lines?: number;
    bytes?: number;
    truncated?: boolean;
    no_object?: boolean;
    secrets?: string;
  };
}

interface InstanceSecrets {
  admin_password?: string;
  mail_token?: string;
  credentials?: Record<string, string>;
  facts?: Record<string, string>;
}

/** What batch.secrets opens to. */
interface BatchSecrets {
  batch_token?: string;
  instances?: (InstanceSecrets | null)[];
}

/** What logs.secrets opens to. */
interface LogsSecrets {
  url?: string;
  content_gzip?: string;
}

/** One instance as the instances output carries it: site and admin, with the opened secrets. */
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

/** Credentials that name something rather than unlock it; masking them would redact every line that mentions them. */
const NOT_SECRET = new Set(["postgres.user", "postgres.database"]);
/** Facts that are secrets: openldap.bind_password, and any later one named the same way. */
const SECRET_FACT = /(password|secret|token|_key)$/;

/** The function, alias and request JSON for one operation. The alias decides the repository; the request never names it. */
export function buildRequest(
  inputs: Inputs,
  batchId?: string,
  batchToken?: string,
): { functionName: string; qualifier: string; payload: Record<string, unknown> } {
  const functionName = `${inputs.project}-${inputs.channel}`;
  const qualifier = `${inputs.callerKey}-${inputs.channel}`;
  const { operation } = inputs;
  if (operation === "create") return { functionName, qualifier, payload: { action: "create", ...inputs.create } };
  const payload: Record<string, unknown> = { action: operation, batch_id: batchId, batch_token: batchToken };
  if (operation === "fetch" && inputs.indexes) payload.indexes = inputs.indexes;
  if (operation === "logs" && inputs.index !== undefined) payload.index = inputs.index;
  return { functionName, qualifier, payload };
}

/** Escapes a workflow command's data, as @actions/core does. */
const escapeData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** Appends outputs to GITHUB_OUTPUT, each in the delimited form so any value is safe. */
export function writeOutputs(path: string | undefined, outputs: Record<string, string>): void {
  if (!path) return;
  let text = "";
  for (const [k, v] of Object.entries(outputs)) {
    const delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${k}<<${delimiter}\n${v}\n${delimiter}\n`;
  }
  appendFileSync(path, text);
}

const writeFile = (path: string, content: string | Uint8Array): string => {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
};

/** The Lambda runtime's handler-error payload, {"errorMessage": ...}, or the raw text. */
const handlerError = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { errorMessage?: unknown };
    if (typeof parsed?.errorMessage === "string") return parsed.errorMessage;
  } catch {
    // Not JSON: the text itself is the message.
  }
  return text.trim().slice(0, 500) || "no reason given";
};

/** An invoke failure's name and a short reason, with ARNs and account ids taken out. */
export const invokeError = (e: unknown): string => {
  const name = (e as { name?: string })?.name || "Error";
  const message = String((e as { message?: string })?.message ?? e)
    .replace(/arn:aws[a-z-]*:[^\s"',]*/g, "<arn>")
    .replace(/\b\d{12}\b/g, "<account>")
    .split("\n")[0]
    .slice(0, 200);
  return `${name}: ${message}`;
};

const cell = (s: string | number | null | undefined): string =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

export interface RunOptions {
  env: Env;
  /** The invoke for the checked region. */
  connect: (region: string) => Invoke;
  /** Takes progress and workflow commands (::add-mask::); stdout in the action. */
  log?: (message: string) => void;
}

/**
 * Runs one operation against the control plane: invokes the caller's alias, writes the raw response if asked, opens the
 * sealed secrets, masks every secret, and sets outputs and the job summary. A refused call, a failed open or a response
 * error fails it, after the outputs that were read are set, so a partial create still hands back its batch.
 */
export async function run({ env, connect, log = console.log }: RunOptions): Promise<void> {
  const inputs = readInputs(env);
  const { operation } = inputs;
  const outputs: Record<string, string> = {};
  const summary: string[] = [];
  const masked = new Set<string>();
  const mask = (value: string | undefined): void => {
    if (!value || masked.has(value)) return;
    masked.add(value);
    log(`::add-mask::${escapeData(value)}`);
    // The value as it appears inside a JSON output, when that differs.
    const quoted = JSON.stringify(value).slice(1, -1);
    if (quoted !== value && !masked.has(quoted)) {
      masked.add(quoted);
      log(`::add-mask::${escapeData(quoted)}`);
    }
  };

  try {
    let batchId = inputs.batchId;
    let batchToken = inputs.batchToken;
    mask(batchToken);
    if (inputs.createResponse) {
      const created = JSON.parse(readFileSync(inputs.createResponse, "utf8")) as StackResponse;
      if (!created.batch_id || !created.batch?.secrets)
        throw new Error(
          `e2e-test-stack: ${inputs.createResponse} is not a create response with a batch: no batch_id or batch.secrets`,
        );
      if (batchId && batchId !== created.batch_id)
        throw new Error(
          `e2e-test-stack: batch-id ${batchId} is not the batch in create-response (${created.batch_id})`,
        );
      const secrets = (await openSealed(created.batch.secrets, inputs.privateKey!)) as BatchSecrets;
      if (!secrets?.batch_token)
        throw new Error(
          `e2e-test-stack: ${inputs.createResponse} holds no batch token; only a create response carries one`,
        );
      mask(secrets.batch_token);
      batchId = created.batch_id;
      batchToken = secrets.batch_token;
    }

    const request = buildRequest(inputs, batchId, batchToken);
    log(
      `e2e-test-stack: ${operation} through ${request.functionName}:${request.qualifier}${batchId ? ` for batch ${batchId}` : ""}`,
    );
    const mayExist = operation === "create" ? " A batch may have been created; it is reaped at its ttl." : "";
    let reply: InvokeOutput;
    try {
      reply = await connect(inputs.region)({
        FunctionName: request.functionName,
        Qualifier: request.qualifier,
        Payload: JSON.stringify(request.payload),
      });
    } catch (e) {
      throw new Error(
        `e2e-test-stack: the invoke of ${request.functionName}:${request.qualifier} failed: ${invokeError(e)}.${mayExist}`,
        { cause: e },
      );
    }
    const text = Buffer.from(reply.Payload ?? new Uint8Array()).toString("utf8");
    if (inputs.responsePath) outputs.response_path = writeFile(inputs.responsePath, text);
    if (reply.FunctionError)
      throw new Error(`e2e-test-stack: the control plane refused the ${operation}: ${handlerError(text)}.${mayExist}`);
    if (reply.StatusCode !== 200)
      throw new Error(`e2e-test-stack: the invoke answered ${reply.StatusCode}: ${handlerError(text)}`);

    let response: StackResponse;
    try {
      response = JSON.parse(text) as StackResponse;
    } catch {
      throw new Error(`e2e-test-stack: the control plane's reply is not JSON: ${text.slice(0, 200)}`);
    }
    const sites = response.sites ?? [];
    const leases = response.batch?.instances ?? [];
    const state = response.batch?.state ?? "";
    const ready = response.batch?.ready ?? leases.filter((l) => l?.state === "ready").length;
    Object.assign(outputs, {
      batch_id: response.batch_id ?? batchId ?? "",
      sites: JSON.stringify(sites),
      ready: String(ready),
      state,
      error: response.error ?? "",
      deployment_version: response.deployment?.version ?? "",
    });

    summary.push(`### E2E test stack: ${operation}`, "", "| | |", "|---|---|");
    summary.push(`| Batch | \`${cell(outputs.batch_id || "none")}\` |`, `| State | ${cell(state || "unknown")} |`);
    if (operation === "create" || operation === "fetch") summary.push(`| Ready | ${ready} of ${leases.length} |`);
    if (response.batch?.expires_at) summary.push(`| Expires | ${cell(response.batch.expires_at)} |`);
    if (response.deployment)
      summary.push(
        `| Control plane | ${cell(response.deployment.invoked || request.qualifier)}, version ${cell(response.deployment.version || "unknown")} |`,
      );
    if (response.error) summary.push(`| Error | ${cell(response.error)} |`);

    // Opened and masked before any output is written.
    if ((operation === "create" || operation === "fetch") && response.batch_id) {
      if (!response.batch?.secrets)
        throw new Error(
          `e2e-test-stack: batch ${response.batch_id} came back with no sealed secrets${response.error ? ` (${response.error})` : ""}`,
        );
      let secrets: BatchSecrets;
      try {
        secrets = (await openSealed(response.batch.secrets, inputs.privateKey!)) as BatchSecrets;
      } catch (e) {
        if (e instanceof SealedError && operation === "create")
          throw new Error(
            `e2e-test-stack: batch ${response.batch_id}: ${e.message.replace(/^e2e-test-stack: /, "")} Without its batch token it cannot be destroyed; it expires at its ttl.`,
            { cause: e },
          );
        throw e;
      }
      mask(secrets.batch_token);
      const opened = secrets.instances ?? [];
      for (const s of opened) {
        if (!s) continue;
        mask(s.admin_password);
        mask(s.mail_token);
        for (const [k, v] of Object.entries(s.credentials ?? {})) if (!NOT_SECRET.has(k)) mask(v);
        for (const [k, v] of Object.entries(s.facts ?? {})) if (SECRET_FACT.test(k)) mask(v);
      }
      const instances: (Instance | null)[] = leases.map((lease, i) => {
        if (!lease) return null;
        const s = opened[i] ?? {};
        return {
          site_url: lease.site_url || sites[i] || "",
          state: lease.state ?? "",
          admin_username: lease.admin?.username ?? "",
          admin_email: lease.admin?.email ?? "",
          admin_password: s.admin_password ?? "",
          mail_token: s.mail_token ?? "",
          credentials: s.credentials ?? {},
          facts: s.facts ?? {},
        };
      });
      outputs.instances = JSON.stringify(instances);
      if (operation === "create") {
        if (!secrets.batch_token)
          throw new Error(
            `e2e-test-stack: batch ${response.batch_id}'s secrets hold no batch token, so it cannot be destroyed; it expires at its ttl`,
          );
        outputs.batch_token = secrets.batch_token;
      }
    }

    if (operation === "logs" && response.logs) {
      const logs = response.logs;
      summary.push(
        `| Instance | \`${cell(logs.instance_id)}\` (index ${logs.index ?? inputs.index ?? 0}) |`,
        `| Containers | ${cell((logs.containers ?? []).join(", ") || "none")} |`,
        `| Tail | ${logs.no_object ? "no log object found" : `${logs.lines ?? 0} lines, ${logs.bytes ?? 0} bytes${logs.truncated ? ", truncated" : ""}`} |`,
      );
      if (logs.secrets) {
        const secrets = (await openSealed(logs.secrets, inputs.privateKey!)) as LogsSecrets;
        mask(secrets.url);
        outputs.logs_url = secrets.url ?? "";
        if (secrets.content_gzip) {
          const index = logs.index ?? inputs.index ?? 0;
          const path =
            inputs.logsPath ||
            // The reply's batch id names the file only in the shape a batch id takes.
            join(
              env.RUNNER_TEMP || tmpdir(),
              `e2e-test-stack-${BATCH_ID.test(outputs.batch_id) ? outputs.batch_id : "batch"}-${index}.log`,
            );
          outputs.logs_path = writeFile(path, gunzipSync(Buffer.from(secrets.content_gzip, "base64")));
        }
      }
    }

    if (sites.length) {
      summary.push("", "| Index | State | Site |", "|---|---|---|");
      sites.forEach((site, i) =>
        summary.push(`| ${i} | ${cell(leases[i]?.state ?? (site ? "" : "failed"))} | ${cell(site)} |`),
      );
    }

    if (response.error) {
      const teardown =
        operation === "create" && outputs.batch_id ? ` Batch ${outputs.batch_id} was created; destroy it.` : "";
      throw new Error(`e2e-test-stack: ${operation} reported: ${response.error}.${teardown}`);
    }
    if (operation === "create" && !outputs.batch_id) throw new Error("e2e-test-stack: create returned no batch id");
  } finally {
    writeOutputs(env.GITHUB_OUTPUT, outputs);
    if (summary.length && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
  }
}
