// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { Agent } from "node:https";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { LambdaClientConfig } from "@aws-sdk/client-lambda";
import { sleep } from "../../../shared/src/github.ts";
import type { Sleep } from "../../../shared/src/github.ts";
import type { Credentials } from "./role.ts";

/** The longest a call waits for the reply: above the function's 900 s timeout, so a create still running is not abandoned. */
export const REQUEST_TIMEOUT_MS = 960_000;
/** Throttled calls, refused before the function ran, are tried this many times in all. */
export const THROTTLE_ATTEMPTS = 5;

/** One Lambda Invoke call, as the actions make it. */
export interface InvokeInput {
  FunctionName: string;
  Qualifier: string;
  Payload: string;
}

/** What the actions read of the Invoke reply. */
export interface InvokeOutput {
  StatusCode?: number;
  FunctionError?: string;
  Payload?: Uint8Array;
}

/** Invokes; an aborted signal abandons the call. */
export type Invoke = (input: InvokeInput, signal?: AbortSignal) => Promise<InvokeOutput>;

/** The part of the Lambda client the actions use. */
export interface LambdaSend {
  send(command: InvokeCommand, options?: { abortSignal?: AbortSignal }): Promise<InvokeOutput>;
}

/** The repository's own alias of a channel's function: the alias decides the repository, the request never names it. */
export const alias = (
  project: string,
  channel: string,
  callerKey: string,
): { FunctionName: string; Qualifier: string } => ({
  FunctionName: `${project}-${channel}`,
  Qualifier: `${callerKey}-${channel}`,
});

/**
 * The Lambda client's settings. The SDK makes one attempt: a create retried after a timeout would make a second batch.
 * TCP keep-alive holds the connection open through NAT while a create runs.
 */
export function lambdaClientConfig(
  region: string,
  credentials: Credentials,
  requestTimeout = REQUEST_TIMEOUT_MS,
): LambdaClientConfig {
  return {
    region,
    credentials,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: 60_000,
      requestTimeout,
      // Without it the SDK only logs a warning at requestTimeout and keeps waiting.
      throwOnRequestTimeout: true,
      httpsAgent: new Agent({ keepAlive: true, keepAliveMsecs: 30_000 }),
    },
  };
}

/** The Lambda client, with the credentials given and none from the environment. */
export function lambdaClient(region: string, credentials: Credentials): LambdaClient {
  return new LambdaClient(lambdaClientConfig(region, credentials));
}

/**
 * Invokes synchronously through the client. Only a throttle (the channel's reserved concurrency is in use) is tried
 * again, since the function did not run; every other error is the caller's.
 */
export function lambdaInvoke(
  client: LambdaSend,
  wait: Sleep = sleep,
  log: (message: string) => void = console.log,
): Invoke {
  return async (input, signal) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.send(
          new InvokeCommand({
            ...input,
            InvocationType: "RequestResponse",
            Payload: new TextEncoder().encode(input.Payload),
          }),
          { abortSignal: signal },
        );
      } catch (e) {
        if (
          (e as { name?: string })?.name !== "TooManyRequestsException" ||
          attempt >= THROTTLE_ATTEMPTS ||
          signal?.aborted
        )
          throw e;
        const ms = 10_000 * 2 ** (attempt - 1);
        log(
          `e2e-test-stack: throttled; trying again in ${ms / 1000} s (attempt ${attempt + 1} of ${THROTTLE_ATTEMPTS})`,
        );
        await wait(ms);
      }
    }
  };
}
