// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { ActionError } from "./errors.ts";
import type { GitHub } from "./github.ts";

/** The words server-image resolves; any other value is an image reference. */
export const SERVERS = ["master", "latest", "esr"] as const;
export type Server = (typeof SERVERS)[number];

/** Whether a server-image value is one of the words resolved to an image. */
export const isServer = (value: string): value is Server => (SERVERS as readonly string[]).includes(value);

export const MASTER_IMAGE = "mattermostdevelopment/mattermost-enterprise-edition:master";
export const RELEASE_IMAGE = "mattermost/mattermost-enterprise-edition";
/** Releases read per page, and the most pages read. */
export const RELEASES_PER_PAGE = 100;
export const RELEASE_PAGES = 10;

/** What the action reads of a GitHub release. */
interface Release {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** A stable tag, vX.Y.Z or X.Y.Z; any suffix, such as -rc1, is not one. */
const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const ESR_NOTE = "extended support release";

const newer = (a: Version, b: Version): boolean =>
  a.major !== b.major ? a.major > b.major : a.minor !== b.minor ? a.minor > b.minor : a.patch > b.patch;
const text = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/** Every release of mattermost/mattermost, a page of RELEASES_PER_PAGE at a time, up to RELEASE_PAGES pages. */
async function releases(github: Pick<GitHub, "json">): Promise<Release[]> {
  const all: Release[] = [];
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const got = await github.json(`/repos/mattermost/mattermost/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`);
    if (!Array.isArray(got)) throw new ActionError("GitHub's releases list is not an array");
    all.push(...(got as Release[]));
    if (got.length < RELEASES_PER_PAGE) break;
  }
  return all;
}

/**
 * The newest stable release, and the newest patch of the newest ESR line, among releases. A stable release is one
 * that is not a draft or a prerelease and whose tag is X.Y.Z with no suffix. A minor is an ESR line when any of its
 * stable releases' notes say "extended support release", in any case.
 */
export function classify(list: Release[]): { latest?: string; esr?: string } {
  const newestPerMinor = new Map<string, Version>();
  const esrMinors = new Set<string>();
  for (const r of list) {
    if (r.draft || r.prerelease) continue;
    const m = STABLE.exec((r.tag_name ?? "").trim());
    if (!m) continue;
    const v = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
    const minor = `${v.major}.${v.minor}`;
    const current = newestPerMinor.get(minor);
    if (!current || newer(v, current)) newestPerMinor.set(minor, v);
    if ((r.body ?? "").toLowerCase().includes(ESR_NOTE)) esrMinors.add(minor);
  }
  let latest: Version | undefined;
  let esr: Version | undefined;
  for (const [minor, v] of newestPerMinor) {
    if (!latest || newer(v, latest)) latest = v;
    if (esrMinors.has(minor) && (!esr || newer(v, esr))) esr = v;
  }
  return { latest: latest && text(latest), esr: esr && text(esr) };
}

/** The server image for master, the newest stable release, or the newest ESR patch, and its version. */
export async function serverImage(
  server: Server,
  github: Pick<GitHub, "json">,
): Promise<{ image: string; version: string }> {
  if (server === "master") return { image: MASTER_IMAGE, version: "master" };
  const list = await releases(github);
  const version = classify(list)[server];
  if (!version)
    throw new ActionError(
      `no ${server === "esr" ? "ESR" : "stable"} release among the ${list.length} releases of mattermost/mattermost`,
    );
  return { image: `${RELEASE_IMAGE}:${version}`, version };
}
