// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { FetchImpl, Sleep } from "../../shared/src/github.ts";
import { readBody } from "./body.ts";

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
 * that are empty (an instance that never launched) are left out; a site that is not an http(s) URL fails.
 */
export function goneUrls(sites: string[], ssoHosts: string[]): string[] {
  const urls: string[] = [];
  const protocols: string[] = [];
  for (const [i, site] of sites.entries()) {
    if (!site) continue;
    // The URL parser drops control characters, which would otherwise reach the probe and its log lines unchecked.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(site))
      throw new Error(`e2e-test-stack: the create response's site ${JSON.stringify(site)} holds a control character`);
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      throw new Error(`e2e-test-stack: the create response's site ${JSON.stringify(site)} is not a URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error(`e2e-test-stack: the create response's site ${JSON.stringify(site)} is not an http(s) URL`);
    urls.push(`${url.href.replace(/\/+$/, "")}/api/v4/system/ping`, `${url.protocol}//mail-${url.host}/`);
    protocols[i] = url.protocol;
  }
  for (const [i, host] of ssoHosts.entries()) {
    if (!host) continue;
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host))
      throw new Error(`e2e-test-stack: the create response's sso host ${JSON.stringify(host)} is not a hostname`);
    urls.push(`${protocols[i] ?? "https:"}//${host}/`);
  }
  return urls;
}

/** The first MAX_BODY bytes of a body as text; the rest is cancelled unread. */
const head = async (res: Response): Promise<string> =>
  (await readBody(res, MAX_BODY, { truncate: true })).toString("utf8");

/** A failed request, as the last answer: curl's 000 and why. */
const noAnswer = (e: unknown): string => {
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return "000 timed out";
  const err = e as { message?: string; cause?: { code?: string } };
  return `000 ${err?.cause?.code || String(err?.message ?? e)}`.split("\n")[0];
};

/**
 * Waits, within windowMs from now, for each URL to answer the router's 404 with GONE: its lookup found no running
 * instance for the hostname. Anything else, such as a 502 (the instance is still known), a 503 (the lookup could not
 * run), a refused or timed-out request, is tried again every PROBE_INTERVAL_MS. Each request and wait is cut to the
 * time left. Every URL is probed at once. Fails listing each URL still served with its last answer.
 */
export async function probeGone(urls: string[], windowMs: number, o: ProbeOptions): Promise<void> {
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
          signal: AbortSignal.timeout(Math.min(left, PROBE_REQUEST_MS)),
        });
        const body = await head(res);
        if (res.status === 404 && body.includes(GONE)) {
          o.log(`  gone  ${url} (after ${attempts} attempt(s), ${elapsed()}s)`);
          return undefined;
        }
        last = `${res.status} ${body.replace(/\s+/g, " ").trim().slice(0, 200)}`.trim();
      } catch (e) {
        last = noAnswer(e);
      }
      const rest = windowMs - (o.now() - start);
      if (rest <= 0) break;
      await o.sleep(Math.min(rest, PROBE_INTERVAL_MS));
    }
    return `${url} is still served after ${elapsed()}s (${attempts} attempt(s)): last answer ${last}`;
  };
  const failed = (await Promise.all(urls.map(probe))).filter((f): f is string => !!f);
  if (failed.length)
    throw new Error(
      `e2e-test-stack: ${failed.length} of ${urls.length} host(s) still served after the destroy:\n${failed.map((f) => `  ${f}`).join("\n")}`,
    );
}
