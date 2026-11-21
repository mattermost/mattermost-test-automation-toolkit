// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { networkError, sleep } from "../../../shared/src/github.ts";
import type { Env, FetchImpl, Sleep } from "../../../shared/src/github.ts";
import { readBody } from "./body.ts";
import { ActionError } from "./errors.ts";

/** The audience AWS STS accepts a GitHub ID token for. */
export const STS_AUDIENCE = "sts.amazonaws.com";
/** Requests in all, the first included. */
export const ID_TOKEN_ATTEMPTS = 3;
/** The wait after a failed attempt that is tried again, by the attempt that failed. */
export const ID_TOKEN_RETRY_MS: readonly number[] = Object.freeze([5_000, 10_000]);
/** The longest one attempt may take. */
export const ID_TOKEN_ATTEMPT_MS = 30_000;
/** The most of the token response read. */
const MAX_TOKEN_BYTES = 64 << 10;

/**
 * Requests this job's GitHub OIDC ID token for STS, as @actions/core's getIDToken does: a GET of
 * ACTIONS_ID_TOKEN_REQUEST_URL with the audience, with ACTIONS_ID_TOKEN_REQUEST_TOKEN as the bearer. Without those
 * variables the job lacks id-token: write. A 5xx, a 429, a timeout or a dropped connection is tried again; the
 * request token and the ID token are never quoted.
 */
export async function requestIdToken(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  wait: Sleep = sleep,
  log: (message: string) => void = console.log,
): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer)
    throw new ActionError(
      "this job cannot request a GitHub OIDC token: give the job permissions: id-token: write, which the CI role's trust needs",
    );
  const errors: string[] = [];
  for (let n = 1; ; n++) {
    let again = false;
    try {
      const res = await fetchImpl(`${url}&audience=${encodeURIComponent(STS_AUDIENCE)}`, {
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
        signal: AbortSignal.timeout(ID_TOKEN_ATTEMPT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        again = res.status >= 500 || res.status === 429;
        errors.push(`attempt ${n}: HTTP ${res.status}`);
      } else {
        let value: unknown;
        try {
          value = (JSON.parse((await readBody(res, MAX_TOKEN_BYTES)).toString("utf8")) as { value?: unknown })?.value;
        } catch {
          value = undefined;
        }
        if (typeof value === "string" && value) return value;
        errors.push(`attempt ${n}: the response holds no token`);
      }
    } catch (e) {
      again = networkError(e);
      errors.push(`attempt ${n}: ${again ? "no answer" : "the request failed"} (${(e as Error)?.name || "Error"})`);
    }
    if (!again || n >= ID_TOKEN_ATTEMPTS)
      throw new ActionError(`the GitHub OIDC token request failed: ${errors.join("; ")}`);
    const ms = ID_TOKEN_RETRY_MS[n - 1];
    log(
      `e2e-test-stack: the GitHub OIDC token request: ${errors[errors.length - 1]}; trying again in ${ms / 1000} s (attempt ${n + 1} of ${ID_TOKEN_ATTEMPTS})`,
    );
    await wait(ms);
  }
}
