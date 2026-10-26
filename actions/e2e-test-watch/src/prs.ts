// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { GhApi } from "../../shared/src/github.ts";
import { HOUR } from "./model.ts";

export const DEFAULT_LABEL = "e2e-autofix";

/** One open PR as the watch reads it: its number, title, URL, labels, and when it last had activity (ms; null when unknown). */
export interface OpenPR {
  number: number;
  title: string;
  url: string;
  labels: string[];
  activeAt: number | null;
}

/** Open PRs into trunk: `files` maps each changed path to PR numbers, `prs` a number to its OpenPR. */
export interface OpenPRs {
  files: Map<string, number[]>;
  prs: Map<number, OpenPR>;
  truncated?: boolean;
}

/** A PR's activity as GitHub reports it: its last update, and its last commit. */
export interface PRActivity {
  updatedAt?: string | null;
  commits?: { nodes?: { commit?: { committedDate?: string | null } | null }[] | null } | null;
}

/** An agent's open PR, as the search reads it. */
export interface RepairPR extends PRActivity {
  number: number;
  title?: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  files?: { nodes?: { path: string }[] } | null;
  isCrossRepository?: boolean | null;
}

/** The agent's open PRs: `files` maps each changed path to their numbers. */
export interface RepairPRs {
  prs: RepairPR[];
  files: Map<string, number[]>;
}

/** A GraphQL reply: the data, or the errors GitHub returned. */
interface GraphqlReply<T> {
  data?: T;
  errors?: { message: string }[];
}

interface OpenPRPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        title: string;
        url: string;
        baseRefName: string;
        updatedAt: string;
        isCrossRepository: boolean;
        commits?: PRActivity["commits"];
        labels?: { nodes?: { name: string }[] } | null;
        files: { pageInfo: { hasNextPage: boolean }; nodes: { path: string }[] };
      }[];
    };
  };
}

interface RepairSearch {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (Partial<RepairPR> | null)[];
  };
}

/** When a PR last had activity, in ms: its last update or its last commit, whichever is later. Null when GitHub gave neither. */
export function lastActivity(p: PRActivity): number | null {
  const times = [p.updatedAt, ...(p.commits?.nodes ?? []).map((n) => n.commit?.committedDate)].map((t) => Date.parse(t ?? "") || 0);
  return Math.max(0, ...times) || null;
}

const OPEN_PRS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url baseRefName updatedAt isCrossRepository commits(last: 1) { nodes { commit { committedDate } } } labels(first: 20) { nodes { name } } files(first: 100) { pageInfo { hasNextPage } nodes { path } } }
    }
  }
}`;

/**
 * Files changed by every open PR into `base` updated in the last `days` days: `files` maps
 * a path to PR numbers, `prs` a number to { number, title, url, labels }. All of them, not
 * the newest few: a busy repository has hundreds open. `truncated` when `maxPages` ran out first.
 */
export async function specsInOpenPRs(
  api: GhApi,
  repository: string,
  { days = 14, now = new Date(), maxPages = 20, base = null }: { days?: number; now?: Date; maxPages?: number; base?: string | null } = {},
): Promise<OpenPRs> {
  const since = now.getTime() - days * 24 * HOUR;
  const [owner, name] = repository.split("/");
  const touched = new Map<string, number[]>();
  const prs = new Map<number, OpenPR>();
  const add = (path: string, number: number): void => {
    touched.set(path, [...(touched.get(path) ?? []), number]);
  };
  const result: OpenPRs = { files: touched, prs, truncated: false };
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = (await api("POST", "/graphql", { query: OPEN_PRS, variables: { owner, name, after } })) as GraphqlReply<OpenPRPage>;
    if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
    const pullRequests = (res.data as OpenPRPage).repository.pullRequests;
    for (const p of pullRequests.nodes) {
      if (Date.parse(p.updatedAt) < since) return result;
      // A fork PR's title and files come from outside the repository: none of it reaches the agent.
      if (p.isCrossRepository !== false) continue;
      // A PR into another branch (a release cherry-pick) changes nothing on trunk.
      if (base && p.baseRefName !== base) continue;
      prs.set(p.number, { number: p.number, title: p.title, url: p.url, labels: (p.labels?.nodes ?? []).map((l) => l.name), activeAt: lastActivity(p) });
      for (const f of p.files.nodes) add(f.path, p.number);
      // Over 100 files: the rest from REST, up to 300 in all.
      for (let filesPage = 2; p.files.pageInfo.hasNextPage && filesPage <= 3; filesPage++) {
        const files = (await api("GET", `/repos/${repository}/pulls/${p.number}/files?per_page=100&page=${filesPage}`)) as { filename: string }[];
        for (const f of files) add(f.filename, p.number);
        if (files.length < 100) break;
      }
    }
    if (!pullRequests.pageInfo.hasNextPage) return result;
    after = pullRequests.pageInfo.endCursor;
  }
  result.truncated = true;
  return result;
}

/** Open PRs that change the spec, or any other file in its directory (a restructure, a shared helper). */
export function prsTouching(touched: Map<string, number[]>, spec: string): number[] {
  const dir = spec.slice(0, spec.lastIndexOf("/") + 1);
  const prs = new Set<number>();
  for (const [file, numbers] of touched) {
    const sameDir = dir && file.startsWith(dir) && !file.slice(dir.length).includes("/");
    if (file === spec || sameDir) for (const n of numbers) prs.add(n);
  }
  return [...prs].sort((a, b) => a - b);
}

/** Open PRs that change exactly this file: a sibling in its directory does not count. */
export function prsChanging(touched: Map<string, number[]>, spec: string): number[] {
  return [...new Set(touched.get(spec) ?? [])].sort((a, b) => a - b);
}

const REPAIR_PRS = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url baseRefName headRefName headRefOid updatedAt isCrossRepository commits(last: 1) { nodes { commit { committedDate } } } files(first: 100) { nodes { path } } } }
  }
}`;

/**
 * The agent's open PRs (by label) into `base`, however long they have been idle: `prs` in search
 * order, `files` mapping each changed path to their numbers (as specsInOpenPRs does). Up to 100
 * changed files per PR: the agent's PRs fix one cause. A PR into another branch (a release
 * backport) doesn't fix trunk.
 */
export async function repairPRs(
  api: GhApi,
  repository: string,
  label: string = DEFAULT_LABEL,
  { base = null, maxPages = 10 }: { base?: string | null; maxPages?: number } = {},
): Promise<RepairPRs> {
  const prs: RepairPR[] = [];
  let after: string | null = null;
  // Quoted, so a label with spaces stays one qualifier.
  const q = `repo:${repository} is:pr is:open label:${JSON.stringify(label)}`;
  for (let page = 0; ; page++) {
    // Part of the list would let a spec its own PR fixes be requested again: the caller fails closed.
    if (page === maxPages) throw new Error(`more than ${maxPages * 50} open PRs labelled ${label}`);
    const res = (await api("POST", "/graphql", { query: REPAIR_PRS, variables: { q, after } })) as GraphqlReply<RepairSearch>;
    if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
    const search = res.data?.search;
    // The agent's PRs are this repository's: a fork PR with the label is dropped here, before anything uses it.
    prs.push(...(search?.nodes ?? []).filter((p): p is RepairPR => Boolean(p?.number && p.isCrossRepository === false && (!base || p.baseRefName === base))));
    if (!search?.pageInfo?.hasNextPage) break;
    after = search.pageInfo.endCursor;
  }
  const files = new Map<string, number[]>();
  for (const p of prs) for (const f of p.files?.nodes ?? []) files.set(f.path, [...(files.get(f.path) ?? []), p.number]);
  return { prs, files };
}
