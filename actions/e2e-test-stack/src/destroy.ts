// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { sleep as realSleep } from "../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../shared/src/github.ts";
import { createArtifact, newest, readResponse, responseArtifact, runArtifacts } from "./core/artifacts.ts";
import type { Artifact, RunRef } from "./core/artifacts.ts";
import { batchAttempt } from "./core/batch.ts";
import { ActionError } from "./core/errors.ts";
import { githubClient } from "./core/github.ts";
import type { GitHub } from "./core/github.ts";
import {
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
import { cell, masker, settle } from "./core/outputs.ts";
import type { Masker } from "./core/outputs.ts";
import { goneUrls, probeGone } from "./core/probe.ts";
import { errorText, handlerError, redact } from "./core/redact.ts";
import { isObject, maskBatchSecrets, responseError } from "./core/response.ts";
import type { Cost, Lease, StackResponse } from "./core/response.ts";
import { assumeRole, roleArnFrom, stsClient } from "./core/role.ts";
import type { Credentials, StsSend } from "./core/role.ts";
import { batchTargetFrom, checkRun } from "./core/run-check.ts";
import { openBatchSecrets, SealedError } from "./core/sealed.ts";

/** Every output the destroy step writes; action.yml reads only these. */
export const DESTROY_OUTPUTS = ["attempts", "cost_usd"] as const;
type DestroyOutputs = { [K in (typeof DESTROY_OUTPUTS)[number]]?: string };

/** How long each host is given to stop being served once its batch is destroyed, in seconds. */
export const GONE_WINDOW_SECONDS = 30;
/** The state the control plane reports for a batch with no live server. */
export const NOT_FOUND = "not found";

export interface DestroyInputs extends StackInputs {
  /** The batch within the run. */
  batch: string;
  /** The one batch to destroy, from batch-id; undefined to destroy every attempt's batch of this run. */
  only?: { batchId: string; attempt: number };
  roleArn: string;
  /** The repository's credentials key, which opens the sealed secrets: an X25519 private key, 32 bytes. */
  credentialsKey: Uint8Array;
  githubToken: string;
  /** owner/name, from GITHUB_REPOSITORY. */
  repository: string;
  /** This job's run. */
  own: Run;
  /** The run whose batch is destroyed: this run, or the one batch-id names. */
  runId: string;
  /** True when that run is another than this job's. */
  other: boolean;
  /** Who started this job; set only for another run's batch, which only they may destroy, by hand. */
  actor: string;
}

/** Reads and checks destroy's inputs and the job's run, before anything is called. */
export function readDestroyInputs(env: Env): DestroyInputs {
  const common = stackInputs(env);
  const own = runFrom(env);
  const repository = repositoryFrom(env);
  const { batch, runId, other, actor, only } = batchTargetFrom(env, common.callerKey, own);
  const roleArn = roleArnFrom(input(env, "role-arn"), common.callerKey);
  const credentialsKey = credentialsKeyFrom(input(env, "credentials-key"));
  const githubToken = input(env, "github-token");
  if (!githubToken)
    refuse("github-token is required: a token that reads the run's artifacts, such as github.token with actions: read");
  return {
    ...common,
    batch,
    roleArn,
    credentialsKey,
    githubToken,
    repository,
    own,
    runId,
    other,
    actor,
    only,
  };
}

/** What destroy calls, injectable for tests. */
export interface DestroyDeps {
  /** Takes progress and workflow commands (::add-mask::); stdout in the action. */
  log: (message: string) => void;
  /** Requests the ID token, calls GitHub and probes the hosts; the global fetch in the action. */
  fetch: FetchImpl;
  /** Waits between attempts. */
  sleep: Sleep;
  /** Milliseconds on a steady clock, for the probes' window. */
  now: () => number;
  /** The time now, in milliseconds since the epoch, to compare with a batch's expiry; Date.now in the action. */
  clock: () => number;
  /** The STS client for the region. */
  sts: (region: string) => StsSend;
  /** The invoke for the region, with the assumed role's credentials. */
  connect: (region: string, credentials: Credentials) => Invoke;
}

/** One attempt's batch to destroy: its create response, read from the attempt's own artifact or the newest. */
interface Target {
  attempt: number;
  batchId: string;
  response: StackResponse;
  /** The artifact it was read from. */
  from: string;
}

/** What became of one attempt's batch, as the attempts output carries it. */
export interface AttemptResult {
  attempt: number;
  batch_id: string;
  state: string;
  gone: string;
  again: string;
  cost_usd: string;
}

const parse = (raw: Buffer): StackResponse | undefined => {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** An ActionError's own message, already written for the reader; any other error's class and first line. */
const reason = (e: unknown): string => (e instanceof ActionError ? e.message : errorText(e));

/**
 * The batches of the run to destroy, one per attempt: each attempt's own response, or the newest response when it
 * names that attempt's batch and the attempt's own is missing or unreadable. A response that cannot be read, or that
 * names a batch the run did not create, is a failure; the other attempts' batches are still returned. Each artifact is
 * listed by its exact name, so no other artifact of the run can push it out of the listing.
 */
async function findTargets(
  github: GitHub,
  run: RunRef,
  inputs: DestroyInputs,
  latest: number,
  label: string,
  log: (message: string) => void,
): Promise<{ targets: Target[]; failures: string[] }> {
  const failures: string[] = [];
  const owner = { callerKey: inputs.callerKey, runId: run.runId, batch: inputs.batch, attempt: latest };
  /** The newest artifact named exactly name that has not expired; an expired one names a batch long past its ttl. */
  const find = async (name: string): Promise<Artifact | undefined> => {
    const all = await runArtifacts(github, run, name);
    const usable = newest(all.filter((a) => !a.expired));
    // An artifact is kept at least a day, longer than any batch lives.
    if (!usable && all.length)
      log(`e2e-test-stack: ${label}'s artifact ${name} has expired; its batch is long past its ttl`);
    return usable;
  };
  /** The response in the newest artifact named name: none when there is no such artifact, or why it cannot be read. */
  const lookUp = async (name: string): Promise<{ response?: StackResponse; failure?: string } | undefined> => {
    const what = `${label}'s artifact ${name}`;
    try {
      const artifact = await find(name);
      if (!artifact) return undefined;
      const response = parse(await readResponse(github, run, artifact, what));
      return response ? { response } : { failure: `${what} is not a JSON object` };
    } catch (e) {
      return { failure: reason(e) };
    }
  };
  const named = (batchId: string) => JSON.stringify(batchId.slice(0, 100));

  const byAttempt = new Map<number, Target>();
  const unread = new Map<number, string>();
  // Attempts whose own response was read: the newest names no batch they do not account for.
  const accounted = new Set<number>();
  // With batch-id, only its attempt; otherwise every attempt of the run.
  const only = inputs.only;
  const attemptNumbers = only ? [only.attempt] : Array.from({ length: latest }, (_, i) => i + 1);
  const newestName = createArtifact(inputs.batch);
  // Every lookup at once, each one's failure kept for its attempt. With batch-id, the newest is looked up only when
  // that attempt's own response is missing or unreadable.
  const [own, newestFound] = only
    ? await (async () => {
        const mine = await lookUp(responseArtifact(inputs.batch, only.attempt));
        return [[mine], mine?.response ? undefined : await lookUp(newestName)] as const;
      })()
    : await Promise.all([
        Promise.all(attemptNumbers.map((n) => lookUp(responseArtifact(inputs.batch, n)))),
        lookUp(newestName),
      ]);
  for (const [i, found] of own.entries()) {
    const n = attemptNumbers[i];
    if (!found) continue;
    if (!found.response) {
      unread.set(n, found.failure!);
      continue;
    }
    accounted.add(n);
    const batchId = typeof found.response.batch_id === "string" ? found.response.batch_id : "";
    if (!batchId) {
      log(`e2e-test-stack: attempt ${n} made no batch: its create response names none`);
      continue;
    }
    if (batchAttempt(batchId, owner) !== n || (only && batchId !== only.batchId)) {
      failures.push(
        `attempt ${n}: ${responseArtifact(inputs.batch, n)} names batch ${named(batchId)}, ${only ? `not ${only.batchId}` : `which attempt ${n} of ${label} did not create`}`,
      );
      continue;
    }
    byAttempt.set(n, { attempt: n, batchId, response: found.response, from: responseArtifact(inputs.batch, n) });
  }

  if (newestFound) {
    const { response, failure } = newestFound;
    const batchId = typeof response?.batch_id === "string" ? response.batch_id : "";
    if (!response) {
      // It may be the only record of an attempt whose own response is missing; an unreadable own one is reported
      // already, and with every own response read the newest repeats one of them.
      if (accounted.size + unread.size === attemptNumbers.length)
        log(`e2e-test-stack: ${failure}; each attempt's own response is reported instead`);
      else failures.push(`${failure}; a batch only it names is not destroyed, and is reaped at its ttl`);
    } else if (only) {
      // Only the one batch is wanted: the newest stands in when it names exactly that one, and only in this run. In
      // another, a later attempt someone else started may have uploaded it.
      if (inputs.other)
        log(
          `e2e-test-stack: ${newestName} is not used for another run's batch: only attempt ${only.attempt}'s own response is`,
        );
      else if (batchId === only.batchId && !accounted.has(only.attempt)) {
        log(
          `e2e-test-stack: attempt ${only.attempt}'s own response is ${unread.has(only.attempt) ? "unreadable" : "missing"}; batch ${only.batchId} is taken from ${newestName}`,
        );
        unread.delete(only.attempt);
        byAttempt.set(only.attempt, { attempt: only.attempt, batchId, response, from: newestName });
      }
    } else if (batchId) {
      const n = batchAttempt(batchId, owner);
      const later = batchAttempt(batchId, { ...owner, attempt: Number.MAX_SAFE_INTEGER });
      if (n === undefined && later !== undefined)
        failures.push(
          `${newestName} names batch ${named(batchId)} of attempt ${later}, later than ${label}'s attempt ${latest} when it was read: run destroy again for it`,
        );
      else if (n === undefined)
        failures.push(`${newestName} names batch ${named(batchId)}, which is not ${label}'s batch ${inputs.batch}`);
      else if (!accounted.has(n)) {
        log(
          `e2e-test-stack: attempt ${n}'s own response is ${unread.has(n) ? "unreadable" : "missing"}; its batch is taken from ${newestName}`,
        );
        unread.delete(n);
        byAttempt.set(n, { attempt: n, batchId, response, from: newestName });
      }
    }
  }
  for (const [n, failure] of unread)
    failures.push(`attempt ${n}: ${failure}; its batch, if any, is not destroyed, and is reaped at its ttl`);
  if (only && !byAttempt.size && !failures.length)
    failures.push(
      `no create response of ${label} names batch ${only.batchId}, so it cannot be destroyed; it is reaped at its ttl`,
    );
  return { targets: [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt), failures };
}

/** The control plane leaves a zero total out of its JSON. */
const money = (c: Cost | undefined): string =>
  !c
    ? ""
    : c.start_unknown
      ? "unknown start"
      : c.estimated === false
        ? "no known rate"
        : `${(typeof c.total === "number" ? c.total : 0).toFixed(2)} ${c.currency || "USD"}`;
const percent = (n: number | undefined): string => (typeof n === "number" ? `${n.toFixed(0)}%` : "");

/** A batch's cost in USD when every server was destroyed and priced at a known rate; undefined otherwise. */
function wholeCost(response: StackResponse): number | undefined {
  const cost = response.batch?.cost;
  const present = (Array.isArray(response.batch?.instances) ? response.batch.instances : []).filter((l): l is Lease =>
    isObject(l),
  );
  const whole =
    !!cost &&
    response.batch?.state === "destroyed" &&
    present.every((l) => isObject(l.cost)) &&
    cost.estimated !== false &&
    !cost.start_unknown &&
    (cost.currency ?? "USD") === "USD";
  return whole ? (typeof cost.total === "number" ? cost.total : 0) : undefined;
}

/**
 * Destroys every attempt's batch of this run, or the one batch-id names, from its own run once that run is checked.
 * Each batch is named exactly for its run, batch and attempt, and read from that attempt's create response or the
 * newest. Once destroyed, every site, mail and SSO host must answer the router's 404, and a second destroy must find
 * nothing. One batch's failure never keeps another up. Outputs and the summary are written whatever happens.
 */
export function destroyWith(overrides: Partial<DestroyDeps> = {}): (env: Env) => Promise<void> {
  const log = overrides.log ?? console.log;
  const deps: DestroyDeps = {
    log,
    fetch: overrides.fetch ?? fetch,
    sleep: overrides.sleep ?? realSleep,
    now: overrides.now ?? (() => performance.now()),
    clock: overrides.clock ?? Date.now,
    sts: overrides.sts ?? stsClient,
    connect:
      overrides.connect ??
      ((region, credentials) =>
        lambdaInvoke(lambdaClient(region, credentials), overrides.sleep ?? abortableSleep, log)),
  };
  return (env) => destroyBatches(env, deps);
}

async function destroyBatches(env: Env, deps: DestroyDeps): Promise<void> {
  const { log } = deps;
  const outputs: DestroyOutputs = {};
  const summary: string[] = ["### E2E test stack: destroy", ""];
  const secrets = masker(log);
  const results: AttemptResult[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  let failure: unknown;
  try {
    const inputs = readDestroyInputs(env);
    const run: RunRef = { repository: inputs.repository, runId: inputs.runId };
    const label = inputs.other ? `run ${inputs.runId}` : "this run";
    const github = githubClient(inputs.githubToken, deps.fetch, deps.sleep, log);
    const latest =
      inputs.other && inputs.only
        ? await checkRun(
            github,
            inputs.repository,
            { runId: inputs.runId, attempt: inputs.only.attempt, actor: inputs.actor },
            log,
          )
        : inputs.own.attempt;
    if (inputs.only && inputs.only.attempt > latest)
      throw new ActionError(
        `batch ${inputs.only.batchId} is from attempt ${inputs.only.attempt}, but ${label} has ${latest}`,
      );
    summary.push(
      inputs.only
        ? `Batch \`${cell(inputs.only.batchId)}\` of ${label}.`
        : `Batch \`${cell(inputs.batch)}\` of ${label}, attempts 1 to ${latest}.`,
      "",
    );

    const found = await findTargets(github, run, inputs, latest, label, log);
    failures.push(...found.failures);
    let invoke: Invoke | undefined;
    if (found.targets.length)
      try {
        const token = await requestIdToken(env, deps.fetch, deps.sleep, log);
        secrets.mask(token);
        const credentials = await assumeRole(deps.sts(REGION), {
          roleArn: inputs.roleArn,
          sessionName: `e2e-test-stack-destroy-${inputs.own.runId}`,
          token,
        });
        secrets.mask(credentials.accessKeyId);
        secrets.mask(credentials.secretAccessKey);
        secrets.mask(credentials.sessionToken);
        invoke = deps.connect(REGION, credentials);
      } catch (e) {
        failures.push(`${reason(e)}; no batch was destroyed, and each is reaped at its ttl`);
        results.push(...found.targets.map(unsent));
      }
    if (invoke) {
      const target = alias(PROJECT, inputs.channel, inputs.callerKey);
      // A batch created in this very attempt must still have been up for this destroy to find.
      const current = inputs.other ? undefined : inputs.own.attempt;
      // Each batch at once, so one slow to go never holds up the others; an error in one is that attempt's failure.
      const settled = await Promise.all(
        found.targets.map((t) => destroyOne(t, target, invoke, secrets, inputs, current, deps, notes)),
      );
      for (const [i, s] of settled.entries()) {
        results.push(s.result);
        if (s.failure) failures.push(`attempt ${found.targets[i].attempt}: ${s.failure}`);
      }
    } else if (!failures.length)
      log(`e2e-test-stack: ${label} has no create response for batch ${inputs.batch}: no batch to destroy`);

    outputs.attempts = JSON.stringify(results);
    const destroyed = results.filter((r) => r.state === "destroyed");
    if (destroyed.length && destroyed.every((r) => r.cost_usd !== ""))
      outputs.cost_usd = destroyed.reduce((sum, r) => sum + Number(r.cost_usd), 0).toFixed(2);
    if (failures.length)
      throw new ActionError(`destroy failed for batch ${inputs.only?.batchId ?? inputs.batch}: ${failures.join("; ")}`);
  } catch (e) {
    failure = e;
  }
  if (results.length) {
    summary.push("| Attempt | Batch | Destroy | Hosts gone | Destroy again | Cost |", "|---|---|---|---|---|---|");
    for (const r of results)
      summary.push(
        `| ${r.attempt} | \`${cell(r.batch_id)}\` | ${cell(r.state)} | ${cell(r.gone)} | ${cell(r.again)} | ${cell(r.cost_usd ? `${r.cost_usd} USD` : "")} |`,
      );
    summary.push("");
  } else summary.push(failure ? "No batch was destroyed; the step's error says why." : "No batch to destroy.", "");
  summary.push(...[...notes].sort().map((n) => `- ${cell(n)}`));
  settle(env, "destroy", outputs, summary, failure);
}

/** Invokes the control plane and reads its reply; a refusal or an unreadable reply is an ActionError. */
async function call(
  invoke: Invoke,
  target: Omit<InvokeInput, "Payload">,
  payload: Record<string, unknown>,
): Promise<StackResponse> {
  const named = `${target.FunctionName}:${target.Qualifier}`;
  let reply;
  try {
    reply = await invoke({ ...target, Payload: JSON.stringify(payload) });
  } catch (e) {
    throw new ActionError(`the invoke of ${named} failed: ${reason(e)}`);
  }
  const text = reply.Payload ? new TextDecoder().decode(reply.Payload) : "";
  if (reply.FunctionError) throw new ActionError(`the control plane refused the destroy: ${handlerError(text)}`);
  if (reply.StatusCode !== 200) throw new ActionError(`the invoke answered ${reply.StatusCode}: ${handlerError(text)}`);
  const response = parse(Buffer.from(text));
  if (!response) throw new ActionError(`the control plane's reply is not a JSON object: ${redact(text).slice(0, 200)}`);
  return response;
}

/** An attempt's batch as it stands before any destroy is sent. */
const unsent = (t: Target): AttemptResult => ({
  attempt: t.attempt,
  batch_id: t.batchId,
  state: "not destroyed",
  gone: "not checked",
  again: "not run",
  cost_usd: "",
});

/** Destroys one attempt's batch, checks its hosts are gone, and destroys it again expecting nothing to find. */
async function destroyOne(
  t: Target,
  target: Omit<InvokeInput, "Payload">,
  invoke: Invoke,
  secrets: Masker,
  inputs: DestroyInputs,
  current: number | undefined,
  deps: DestroyDeps,
  notes: string[],
): Promise<{ result: AttemptResult; failure?: string }> {
  const result = unsent(t);
  try {
    const failure = await destroySteps(t, result, target, invoke, secrets, inputs, current, deps, notes);
    return { result, failure };
  } catch (e) {
    // What the steps had found stays: a batch destroyed before the error is still reported destroyed.
    return { result, failure: `batch ${t.batchId}: ${reason(e)}` };
  }
}

/** destroyOne's steps, filling in result; the failure, if any. */
async function destroySteps(
  t: Target,
  result: AttemptResult,
  target: Omit<InvokeInput, "Payload">,
  invoke: Invoke,
  secrets: Masker,
  inputs: DestroyInputs,
  current: number | undefined,
  deps: DestroyDeps,
  notes: string[],
): Promise<string | undefined> {
  const kept = "it is reaped at its ttl";

  const sealed = t.response.batch?.secrets;
  if (typeof sealed !== "string" || !sealed)
    return `batch ${t.batchId} in ${t.from} has no sealed secrets, so it cannot be destroyed; ${kept}`;
  let batchToken: string;
  try {
    const opened = await openBatchSecrets(sealed, inputs.credentialsKey);
    maskBatchSecrets(secrets, opened);
    if (typeof opened.batch_token !== "string" || !opened.batch_token)
      return `batch ${t.batchId}'s secrets hold no batch token, so it cannot be destroyed; ${kept}`;
    batchToken = opened.batch_token;
  } catch (e) {
    if (!(e instanceof SealedError)) throw e;
    return `batch ${t.batchId}: ${e.message}, so it cannot be destroyed; ${kept}`;
  }

  deps.log(`e2e-test-stack: destroying batch ${t.batchId}, attempt ${t.attempt}, from ${t.from}`);
  const payload = { action: "destroy", batch_id: t.batchId, batch_token: batchToken };
  let first: StackResponse;
  try {
    first = await call(invoke, target, payload);
  } catch (e) {
    return `batch ${t.batchId}: ${reason(e)}; ${kept}`;
  }
  const state = typeof first.batch?.state === "string" ? first.batch.state : "";
  result.state = state || "unknown";
  const error = responseError(first);
  if (error) return `the destroy of batch ${t.batchId} reported ${state || "no state"}: ${error}`;
  if (state === NOT_FOUND && t.attempt === current && t.response.batch?.state === "ready") {
    const expiresAt = Date.parse(typeof t.response.batch?.expires_at === "string" ? t.response.batch.expires_at : "");
    if (!(Number.isFinite(expiresAt) && expiresAt <= deps.clock()))
      return `batch ${t.batchId} was not found, but this attempt created it, so it should still have been up`;
    notes.push(`Batch ${t.batchId} was not found: it passed its expiry and was reaped.`);
  }
  if (state !== "destroyed" && state !== NOT_FOUND)
    return `the destroy of batch ${t.batchId} reported ${state || "no state"}, not destroyed`;
  const cost = wholeCost(first);
  if (cost !== undefined) result.cost_usd = cost.toFixed(2);
  const sizing = first.batch?.sizing;
  if (first.batch?.cost && cost === undefined)
    notes.push(`Batch ${t.batchId}: cost ${money(first.batch.cost)}, not every server priced.`);
  if (sizing) {
    const alternative =
      sizing.alternative && typeof sizing.saving === "number" && sizing.saving > 0
        ? `; ${sizing.alternative} would have cost ${typeof sizing.counterfactual === "number" ? sizing.counterfactual.toFixed(2) : "?"} USD, ${sizing.saving.toFixed(2)} less`
        : "";
    notes.push(
      `Batch ${t.batchId}: sustained CPU ${percent(sizing.sustained_cpu) || "unknown"} on ${sizing.instance_type || "its instance type"}${alternative}${sizing.note ? `. ${sizing.note}` : ""}`,
    );
  }

  // The hosts the create response named catch a batch still up in another account, whose reply there is "not found"
  // and names none; those the control plane's reply names from the batch's published leases catch any the response
  // lacks. The response is this run's own, or that of an attempt the same person started by hand. Each list is read on
  // its own, so one malformed list leaves the other probed; the reply's sso- hosts take the scheme of the site at their
  // index, from the reply or else the response.
  const sitesOf = (r: StackResponse): unknown[] => (Array.isArray(r.sites) ? r.sites : []);
  const ssoOf = (r: StackResponse): unknown[] =>
    (Array.isArray(r.batch?.instances) ? r.batch.instances : []).map((l) => (isObject(l) ? l.sso_host : undefined));
  const responseSites = sitesOf(t.response);
  const replySites = sitesOf(first);
  const lists: [string, () => string[]][] = [
    ["the create response's", () => goneUrls(responseSites, ssoOf(t.response))],
    [
      "the destroy reply's",
      () =>
        goneUrls(
          Array.from(
            { length: Math.max(replySites.length, responseSites.length) },
            (_, i) => replySites[i] || responseSites[i],
          ),
          ssoOf(first),
        ),
    ],
  ];
  const urls: string[] = [];
  const unread: string[] = [];
  for (const [whose, read] of lists)
    try {
      urls.push(...read());
    } catch (e) {
      unread.push(`${whose} hosts could not be read: ${reason(e)}`);
    }
  if (unread.length === lists.length) return `batch ${t.batchId}: ${unread.join("; ")}`;
  urls.splice(0, urls.length, ...new Set(urls));
  for (const u of unread) notes.push(`Batch ${t.batchId}: ${u}; the others were checked.`);
  if (urls.length) {
    deps.log(
      `e2e-test-stack: probing ${urls.length} host(s) of batch ${t.batchId} for the router's 404, within ${GONE_WINDOW_SECONDS} s`,
    );
    // A host still served once the window has passed is reported, not a failure: the batch is destroyed, and the
    // router stops serving it soon after.
    const served = await probeGone(urls, GONE_WINDOW_SECONDS * 1000, deps);
    if (served.length) {
      result.gone = `not yet: ${served.length} of ${urls.length} still served after ${GONE_WINDOW_SECONDS} s`;
      notes.push(`Batch ${t.batchId}: still served after ${GONE_WINDOW_SECONDS} s: ${served.join("; ")}`);
      deps.log(
        `e2e-test-stack: ${served.length} of ${urls.length} host(s) of batch ${t.batchId} still served: ${served.join("; ")}`,
      );
    } else result.gone = `yes, all ${urls.length}`;
  } else result.gone = "no host to check";

  let again: StackResponse;
  try {
    again = await call(invoke, target, payload);
  } catch (e) {
    result.again = "failed";
    return `the second destroy of batch ${t.batchId}: ${reason(e)}`;
  }
  result.again = typeof again.batch?.state === "string" ? again.batch.state : "unknown";
  const againError = responseError(again);
  if (againError) return `the second destroy of batch ${t.batchId} reported ${result.again}: ${againError}`;
  if (result.again !== NOT_FOUND)
    return `a second destroy of batch ${t.batchId} reported ${result.again}, not ${JSON.stringify(NOT_FOUND)}`;
  return undefined;
}

/** The destroy action, as the bundle runs it. */
export const destroy = destroyWith();
