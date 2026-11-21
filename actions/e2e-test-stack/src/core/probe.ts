// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { FetchImpl, Sleep } from "../../../shared/src/github.ts";
import { readBody } from "./body.ts";
import { ActionError } from "./errors.ts";

/** The router's answer for a hostname with no running test server. */
export const GONE = "No test server for this hostname";
/** The wait between a host's attempts, and the longest one request may take. */
export const PROBE_INTERVAL_MS = 5_000;
export const PROBE_REQUEST_MS = 15_000;
/** The most of a body read, to look for GONE and to quote. */
const MAX_BODY = 64 << 10;

export interface ProbeOptions {
  fetch: FetchImpl;
  sleep: Sleep;
  /** Milliseconds on a steady clock. */
  now: () => number;
  log: (message: string) => void;
}

/**
 * The URLs that answer while a batch's servers are up: each site's ping, its mail- host, and each sso- host, all with
 * the site's protocol. ssoHosts is index-aligned with sites; an sso- host with no site is probed over https. Sites
 * that are empty (a server that never launched) are left out; a site that is not an http(s) URL fails.
 */
export function goneUrls(sites: readonly unknown[], ssoHosts: readonly unknown[]): string[] {
  const urls: string[] = [];
  const protocols: string[] = [];
  for (const [i, site] of sites.entries()) {
    if (site === "" || site === null || site === undefined) continue;
    const quoted = JSON.stringify(typeof site === "string" ? site.slice(0, 200) : typeof site);
    // The URL parser drops control characters, which would otherwise reach the probe and its log lines unchecked.
    // eslint-disable-next-line no-control-regex
    if (typeof site !== "string" || /[\u0000-\u001f\u007f]/.test(site))
      throw new ActionError(`the create response's site ${quoted} is not a URL`);
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      throw new ActionError(`the create response's site ${quoted} is not a URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new ActionError(`the create response's site ${quoted} is not an http(s) URL`);
    urls.push(`${url.href.replace(/\/+$/, "")}/api/v4/system/ping`, `${url.protocol}//mail-${url.host}/`);
    protocols[i] = url.protocol;
  }
  for (const [i, host] of ssoHosts.entries()) {
    if (host === "" || host === null || host === undefined) continue;
    if (typeof host !== "string" || !/^[a-z0-9.-]+(:\d+)?$/i.test(host))
      throw new ActionError(
        `the create response's sso host ${JSON.stringify(typeof host === "string" ? host.slice(0, 200) : typeof host)} is not a hostname`,
      );
    urls.push(`${protocols[i] ?? "https:"}//${host}/`);
  }
  return urls;
}

/** A failed request, as the last answer: why it got none. */
const noAnswer = (e: unknown): string => {
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))
    return "no answer, timed out";
  const err = e as { message?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : "";
  return `no answer, ${code || String(err?.message ?? e)}`.split("\n")[0];
};

/**
 * Waits, within windowMs from now, for each URL to answer the router's 404 with GONE: its lookup found no running
 * server for the hostname. Anything else, such as a 502 (the server is still known), a 503 (the lookup could not run),
 * a refused or timed-out request, is tried again every PROBE_INTERVAL_MS. Each request and wait is cut to the time
 * left. Every URL is probed at once. Returns each URL still served, with its last answer; none when all are gone.
 */
export async function probeGone(urls: readonly string[], windowMs: number, o: ProbeOptions): Promise<string[]> {
  const start = o.now();
  const elapsed = () => Math.round((o.now() - start) / 1000);
  const probe = async (url: string): Promise<string | undefined> => {
    let attempts = 0;
    let last = "no attempt";
    for (;;) {
      const left = windowMs - (o.now() - start);
      if (left <= 0) break;
      attempts++;
      try {
        const res = await o.fetch(url, {
          redirect: "manual",
          // AbortSignal.timeout takes whole milliseconds; the clock gives fractions.
          signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(left, PROBE_REQUEST_MS)))),
        });
        const body = (await readBody(res, MAX_BODY, { truncate: true })).toString("utf8");
        if (res.status === 404 && body.includes(GONE)) {
          o.log(`e2e-test-stack:   gone ${url} (after ${attempts} attempt(s), ${elapsed()} s)`);
          return undefined;
        }
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = noAnswer(e);
      }
      const rest = windowMs - (o.now() - start);
      if (rest <= 0) break;
      await o.sleep(Math.min(rest, PROBE_INTERVAL_MS));
    }
    return `${url} is still served after ${elapsed()} s (${attempts} attempt(s)): last ${last}`;
  };
  return (await Promise.all(urls.map(probe))).filter((f): f is string => f !== undefined);
}
