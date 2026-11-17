// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { Agent } from "node:https";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { LambdaClientConfig } from "@aws-sdk/client-lambda";
import type { Sleep } from "../../shared/src/github.ts";
import type { Invoke } from "./stack.ts";

/** The longest a call waits for the reply: above the function's 900 s timeout, so a create still running is not abandoned. */
export const REQUEST_TIMEOUT_MS = 960_000;
/** Throttled calls, refused before the function ran, are tried this many times in all. */
export const THROTTLE_ATTEMPTS = 5;

/** The part of the Lambda client the action uses. */
export interface LambdaSend {
  send(command: InvokeCommand): Promise<{ StatusCode?: number; FunctionError?: string; Payload?: Uint8Array }>;
}

const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Lambda client's settings. The SDK makes one attempt: a create retried after a timeout would make a second batch.
 * TCP keep-alive holds the connection open through NAT while a create runs.
 */
export function lambdaClientConfig(region: string, requestTimeout = REQUEST_TIMEOUT_MS): LambdaClientConfig {
  return {
    region,
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

/** The Lambda client, with credentials from the environment. */
export function lambdaClient(region: string): LambdaClient {
  return new LambdaClient(lambdaClientConfig(region));
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
  return async (input) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.send(
          new InvokeCommand({
            ...input,
            InvocationType: "RequestResponse",
            Payload: new TextEncoder().encode(input.Payload),
          }),
        );
      } catch (e) {
        if ((e as { name?: string })?.name !== "TooManyRequestsException" || attempt >= THROTTLE_ATTEMPTS) throw e;
        const ms = 10_000 * 2 ** (attempt - 1);
        log(
          `e2e-test-stack: throttled; trying again in ${ms / 1000} s (attempt ${attempt + 1} of ${THROTTLE_ATTEMPTS})`,
        );
        await wait(ms);
      }
    }
  };
}
