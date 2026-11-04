// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/** The process environment as the actions read it. */
export type Env = Record<string, string | undefined>;

/** The global fetch, or a test double with the same call shape. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** A GitHub REST call. Resolves to the parsed JSON body, or null for 204 No Content. */
export type GhApi = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** One commit status, as the GitHub REST API returns it. */
export interface CommitStatus {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
}

/** Waits between attempts of a retried call; a test passes one that does not sleep. */
export type Sleep = (ms: number) => Promise<void>;

const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A commit status POST only sets that context's latest state: posting it again posts the same
// row, so a GitHub 5xx, a 429 or a dropped connection is tried again. Left failed, the lane
// stays at the pending its claim posted, and nothing after it writes the context.
const STATUS_POST = /^\/repos\/[^/]+\/[^/]+\/statuses\/[^/?]+$/;
export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 3000]);

// A 429's Retry-After is not read: these short waits cover a brief burst, and a longer limit fails as before.
const retryable = (status: number): boolean => status >= 500 || status === 429;

// fetch rejects a dropped connection with a TypeError ("fetch failed"), and an expired or aborted
// signal with a DOMException (TimeoutError, AbortError). Anything else is not the network's doing.
const networkError = (e: unknown): boolean => e instanceof TypeError || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"));

export function gh(fetchImpl: FetchImpl, token: string, wait: Sleep = sleep): GhApi {
  return async (method, path, body) => {
    // Only a status write is safe to repeat; other writes (a re-run request) are not.
    const delays = method === "POST" && STATUS_POST.test(path) ? RETRY_DELAYS_MS : [];
    // Outside the retry: a body that cannot be serialized is the caller's error, not the network's.
    const payload = body ? JSON.stringify(body) : undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`https://api.github.com${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "mattermost-e2e-triage" },
          body: payload,
          signal: AbortSignal.timeout(60000),
        });
      } catch (e) {
        if (networkError(e) && attempt < delays.length) {
          await wait(delays[attempt]);
          continue;
        }
        throw e;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      // The body only names the error: one that cannot be read must not stop a retry.
      const text = (await res.text().catch(() => "")).slice(0, 200);
      if (retryable(res.status) && attempt < delays.length) {
        await wait(delays[attempt]);
        continue;
      }
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${text}`);
    }
  };
}
