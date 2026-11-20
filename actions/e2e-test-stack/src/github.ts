// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { networkError, sleep } from "../../shared/src/github.ts";
import type { FetchImpl, Sleep } from "../../shared/src/github.ts";
import { BodyTooLarge, readBody } from "./body.ts";

export const GITHUB_API = "https://api.github.com";
/** Calls in all, the first included. */
export const GITHUB_ATTEMPTS = 4;
/** The longest one attempt, its body included, may take. */
export const GITHUB_ATTEMPT_MS = 60_000;
/** The wait after a server error, a timeout or a network error, by the attempt that failed. */
export const GITHUB_RETRY_MS: readonly number[] = Object.freeze([10_000, 20_000, 30_000]);
/** The wait after a 429 or a secondary rate limit. */
export const GITHUB_THROTTLE_MS = 60_000;
/** The most of a JSON body read, and of an error body, which is cut there. */
export const MAX_JSON_BYTES = 8 << 20;
const MAX_ERROR_BYTES = 4 << 10;

/** Whether a failed attempt is tried again, and after which wait. */
type Kind = "transient" | "throttled" | "final";

/** One attempt's failure, with whether it is tried again. */
class AttemptError extends Error {
  readonly kind: Kind;
  constructor(message: string, kind: Kind) {
    super(message);
    this.kind = kind;
  }
}

/** A GitHub call that failed every attempt it was given; the message lists each attempt's error on one line. */
export class GitHubError extends Error {}

/** A GitHub REST client that retries transient failures; see githubClient. */
export interface GitHub {
  /** GETs a REST path and parses its JSON body. */
  json(path: string): Promise<unknown>;
  /** GETs a REST path that redirects to a download, and reads at most max bytes of it. */
  download(path: string, max: number): Promise<Buffer>;
}

/** A fetch failure's name and reason, with undici's cause code (ECONNRESET, ENOTFOUND) when it has one. */
const describe = (e: unknown): string => {
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))
    return `did not answer within ${GITHUB_ATTEMPT_MS / 1000} seconds`;
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code || err?.cause?.message;
  return `${err?.name || "Error"}: ${String(err?.message ?? e)}${cause ? ` (${cause})` : ""}`.split("\n")[0];
};

/**
 * A response that is not 2xx, as an attempt error: a 5xx is transient; a 429 or a 403 for the secondary rate limit is
 * throttled; the primary rate limit, which resets only on the hour, and any other 4xx are final.
 */
const statusError = async (res: Response): Promise<AttemptError> => {
  const body = (await readBody(res, MAX_ERROR_BYTES, { truncate: true }).catch(() => Buffer.alloc(0)))
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
  const text = body.slice(0, 200);
  const message = `HTTP ${res.status}${text ? ` ${text}` : ""}`;
  if (res.status >= 500) return new AttemptError(message, "transient");
  const secondary = /secondary rate limit/i.test(body);
  const primary = !secondary && res.headers.get("x-ratelimit-remaining") === "0";
  if (secondary || (res.status === 429 && !primary)) return new AttemptError(message, "throttled");
  return new AttemptError(message, "final");
};

/** A body read within max bytes; one longer is a final failure. */
const readBounded = async (res: Response, max: number): Promise<Buffer> => {
  try {
    return await readBody(res, max);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new AttemptError(e.message, "final");
    throw e;
  }
};

/**
 * A GitHub REST client for api.github.com. Each call is tried up to GITHUB_ATTEMPTS times, each attempt bounded to
 * GITHUB_ATTEMPT_MS: again after GITHUB_RETRY_MS on a 5xx, a timeout or a network error, and after GITHUB_THROTTLE_MS
 * on a 429 or a secondary rate limit. Any other failure is final. Once it gives up, the error lists every attempt's.
 * An empty token sends no Authorization header.
 */
export function githubClient(
  token: string,
  fetchImpl: FetchImpl = fetch,
  wait: Sleep = sleep,
  log: (message: string) => void = console.log,
): GitHub {
  const headers = (): Record<string, string> => ({
    accept: "application/vnd.github+json",
    "user-agent": "mattermost-e2e-test-stack",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  const retried = async <T>(path: string, attempt: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const errors: string[] = [];
    for (let n = 1; ; n++) {
      let kind: Kind;
      try {
        return await attempt(AbortSignal.timeout(GITHUB_ATTEMPT_MS));
      } catch (e) {
        if (e instanceof AttemptError) kind = e.kind;
        else kind = networkError(e) ? "transient" : "final";
        errors.push(`attempt ${n}: ${e instanceof AttemptError ? e.message : describe(e)}`);
      }
      if (kind === "final" || n >= GITHUB_ATTEMPTS)
        throw new GitHubError(`e2e-test-stack: GitHub GET ${path} failed: ${errors.join("; ")}`);
      const ms = kind === "throttled" ? GITHUB_THROTTLE_MS : GITHUB_RETRY_MS[n - 1];
      log(
        `e2e-test-stack: GitHub GET ${path}: ${errors[errors.length - 1]}; trying again in ${ms / 1000} s (attempt ${n + 1} of ${GITHUB_ATTEMPTS})`,
      );
      await wait(ms);
    }
  };

  return {
    json: (path) =>
      retried(path, async (signal) => {
        const res = await fetchImpl(`${GITHUB_API}${path}`, { headers: headers(), signal });
        if (!res.ok) throw await statusError(res);
        const text = (await readBounded(res, MAX_JSON_BYTES)).toString("utf8");
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new AttemptError(`HTTP ${res.status} with a body that is not JSON`, "final");
        }
      }),
    // The API answers with a redirect to a short-lived storage URL, followed here without the token.
    download: (path, max) =>
      retried(path, async (signal) => {
        const res = await fetchImpl(`${GITHUB_API}${path}`, { headers: headers(), redirect: "manual", signal });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          await res.body?.cancel();
          if (!location) throw new AttemptError(`HTTP ${res.status} with no location`, "final");
          // The URL carries its own signed access; it is never quoted in an error.
          const blob = await fetchImpl(location, { redirect: "error", signal });
          // Its body is not quoted either: a storage error may echo the request.
          if (!blob.ok) {
            await blob.body?.cancel();
            const kind = blob.status >= 500 ? "transient" : blob.status === 429 ? "throttled" : "final";
            throw new AttemptError(`the download answered HTTP ${blob.status}`, kind);
          }
          return await readBounded(blob, max);
        }
        if (!res.ok) throw await statusError(res);
        return await readBounded(res, max);
      }),
  };
}
