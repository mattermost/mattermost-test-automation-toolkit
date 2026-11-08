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
// stays at the pending its claim posted, and nothing after it writes the context. A GET changes
// nothing, so it is retried the same way: a statuses read that answered 500 once stopped three
// PR lanes before they began (prepare-run's claim).
const STATUS_POST = /^\/repos\/[^/]+\/[^/]+\/statuses\/[^/?]+$/;
export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 3000]);

/** Whether an HTTP status is transient (5xx or 429); 429's Retry-After is not read beyond the short burst waits. */
const retryable = (status: number): boolean => status >= 500 || status === 429;

/**
 * Whether a fetch error is a dropped connection (undici TypeError "fetch failed" or "terminated") or an expired/aborted
 * signal (DOMException TimeoutError or AbortError). Any other TypeError (e.g. an invalid header value) is not retried.
 */
const networkError = (e: unknown): boolean =>
  (e instanceof TypeError && (e.message === "fetch failed" || e.message === "terminated")) ||
  (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"));

/** Returns a GitHub REST client that retries reads and commit-status POST requests on transient HTTP or network failures. */
export function gh(fetchImpl: FetchImpl, token: string, wait: Sleep = sleep): GhApi {
  return async (method, path, body) => {
    // Only a read or a status write is safe to repeat; other writes (a re-run request) are not.
    const isStatusPost = method === "POST" && STATUS_POST.test(path);
    const delays = isStatusPost || method === "GET" ? RETRY_DELAYS_MS : [];
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
      // Once GitHub returns 2xx for a status POST, the status is already created and callers do not read its body:
      // a body-read failure must neither retry the POST nor fail the write (which would skip the aggregate refresh).
      if (res.ok) return res.status === 204 ? null : isStatusPost ? res.json().catch(() => null) : await res.json();
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
