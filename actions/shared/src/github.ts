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

export function gh(fetchImpl: FetchImpl, token: string): GhApi {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "mattermost-e2e-triage" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
}
