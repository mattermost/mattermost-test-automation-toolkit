// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { GhApi } from "../../shared/src/github.ts";
import { HOUR } from "./model.ts";

export const DEFAULT_LABEL = "e2e-autofix";

/** One open PR as the watch reads it: its number, title, URL, labels, and when it was opened and last had activity (ms; null when unknown). */
export interface OpenPR {
  number: number;
  title: string;
  url: string;
  labels: string[];
  activeAt: number | null;
  openedAt: number | null;
}

/** Open PRs into trunk: `files` maps each changed path to PR numbers, `prs` a number to its OpenPR. */
export interface OpenPRs {
  files: Map<string, number[]>;
  prs: Map<number, OpenPR>;
  truncated?: boolean;
  /** PRs with more changed files than are read (300): one may change a spec past them. */
  partial?: number[];
}

/** A PR's activity as GitHub reports it: when it was opened, its last update, and its last commit. */
export interface PRActivity {
  createdAt?: string | null;
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
        createdAt?: string | null;
        updatedAt: string;
        isCrossRepository: boolean;
        commits?: PRActivity["commits"];
        labels?: { nodes?: { name: string }[] } | null;
        /** How many files the PR changes, as GitHub counts them. */
        changedFiles?: number | null;
        /** Its head commit when its files were first read. */
        headRefOid?: string | null;
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

/** When a PR was opened, in ms. Null when GitHub didn't say. */
export function openedAt(p: PRActivity): number | null {
  return Date.parse(p.createdAt ?? "") || null;
}

const OPEN_PRS = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url baseRefName createdAt updatedAt isCrossRepository changedFiles headRefOid commits(last: 1) { nodes { commit { committedDate } } } labels(first: 20) { nodes { name } } files(first: 100) { pageInfo { hasNextPage } nodes { path } } }
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
  const result: OpenPRs = { files: touched, prs, truncated: false, partial: [] };
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
      prs.set(p.number, { number: p.number, title: p.title, url: p.url, labels: (p.labels?.nodes ?? []).map((l) => l.name), activeAt: lastActivity(p), openedAt: openedAt(p) });
      for (const f of p.files.nodes) add(f.path, p.number);
      // Over 100 files: the rest from REST, up to 300 in all. A PR with more files than were read is named as partial:
      // by GitHub's count of distinct paths, or, without one, when the last page read was full. So is one whose head
      // moved while its files were read: its pages may repeat one path and skip another.
      const paths = new Set(p.files.nodes.map((f) => f.path));
      let complete = !p.files.pageInfo.hasNextPage;
      const paged = !complete;
      for (let filesPage = 2; !complete && filesPage <= 3; filesPage++) {
        const files = (await api("GET", `/repos/${repository}/pulls/${p.number}/files?per_page=100&page=${filesPage}`)) as { filename: string }[];
        for (const f of files) {
          add(f.filename, p.number);
          paths.add(f.filename);
        }
        if (files.length < 100) complete = true;
      }
      let moved = false;
      if (paged && p.headRefOid) {
        const after = (await api("GET", `/repos/${repository}/pulls/${p.number}`)) as { head?: { sha?: string | null } | null } | null;
        moved = after?.head?.sha !== p.headRefOid;
      }
      if (moved || (typeof p.changedFiles === "number" ? p.changedFiles > paths.size : !complete)) result.partial!.push(p.number);
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

// PRs and issues that search may return for one trunk run; past it a request can't be ruled unanswered.
const MAX_ANSWER_READS = 20;

const TEXTS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { body comments(last: 100) { pageInfo { hasPreviousPage } nodes { body } } }
      ... on PullRequest {
        body
        comments(last: 100) { pageInfo { hasPreviousPage } nodes { body } }
        reviews(last: 100) { pageInfo { hasPreviousPage } nodes { body comments(first: 50) { pageInfo { hasNextPage } nodes { body } } } }
      }
    }
  }
}`;

interface Bodies {
  pageInfo?: { hasPreviousPage?: boolean; hasNextPage?: boolean } | null;
  nodes?: ({ body?: string | null } | null)[] | null;
}

interface Texts {
  repository: {
    issueOrPullRequest: {
      body?: string | null;
      comments?: Bodies | null;
      reviews?: { pageInfo?: Bodies["pageInfo"]; nodes?: ({ body?: string | null; comments?: Bodies | null } | null)[] | null } | null;
    } | null;
  } | null;
}

/** A PR's or issue's texts as read, and whether some were past the pages read. */
interface ReadTexts {
  texts: string[];
  truncated: boolean;
}

/**
 * A spec as the agent names it in its answers: its file name, e.g. `channel_classification.spec.ts`, alone or at the
 * end of a path. Not as the end of another name: `post.spec.ts` is not named by `edit_post.spec.ts`.
 */
const specName = (spec: string): RegExp => {
  const file = spec.slice(spec.lastIndexOf("/") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${file}(?!\\w)`);
};

/**
 * A check of whether the agent answered a request: some PR or issue holds one text (its body, a comment, a review,
 * or a review comment) that links the request's trunk run and names one of its specs. The agent's new PR, and its
 * comment or review on an existing PR, both do. The spec tells apart requests sent from one trunk run. Read are the
 * PRs and issues search finds citing the run, and `candidates` (the PRs on its specs), so a review that search
 * doesn't index still counts there. Each PR's texts are read once per check. Throws when it can't tell: more PRs
 * and issues cite the run than search returns, or one read with no answer has more texts than its pages hold.
 */
export function answerCheck(api: GhApi, repository: string): (runId: string, specs: string[], candidates: number[]) => Promise<boolean> {
  const [owner, name] = repository.split("/");
  const read = new Map<number, Promise<ReadTexts>>();
  const textsOf = (number: number): Promise<ReadTexts> => {
    let texts = read.get(number);
    if (!texts) {
      texts = (async () => {
        const res = (await api("POST", "/graphql", { query: TEXTS, variables: { owner, name, number } })) as GraphqlReply<Texts>;
        if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
        const item = res.data?.repository?.issueOrPullRequest;
        const bodies = (b?: Bodies | null): (string | null | undefined)[] => (b?.nodes ?? []).map((n) => n?.body);
        const reviews = item?.reviews?.nodes ?? [];
        return {
          texts: [item?.body, ...bodies(item?.comments), ...reviews.flatMap((r) => [r?.body, ...bodies(r?.comments)])].filter((t): t is string => Boolean(t)),
          truncated: Boolean(item?.comments?.pageInfo?.hasPreviousPage || item?.reviews?.pageInfo?.hasPreviousPage || reviews.some((r) => r?.comments?.pageInfo?.hasNextPage)),
        };
      })();
      read.set(number, texts);
    }
    return texts;
  };
  return async (runId, specs, candidates) => {
    const q = `repo:${repository} "${runId}"`;
    const found = (await api("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=${MAX_ANSWER_READS}`)) as { total_count?: number; incomplete_results?: boolean; items?: { number: number }[] };
    // A search that timed out may have missed the answer.
    if (found.incomplete_results) throw new Error(`search for run ${runId} returned incomplete results`);
    if ((found.total_count ?? 0) > (found.items ?? []).length) throw new Error(`more than ${MAX_ANSWER_READS} PRs and issues cite run ${runId}`);
    // The run's link, not a number that happens to contain it.
    const link = new RegExp(`/actions/runs/${runId}(?!\\d)`);
    const names = specs.map(specName);
    const truncated: number[] = [];
    for (const n of new Set([...(found.items ?? []).map((i) => i.number), ...candidates])) {
      const { texts, truncated: more } = await textsOf(n);
      if (texts.some((t) => link.test(t) && names.some((s) => s.test(t)))) return true;
      if (more) truncated.push(n);
    }
    // The answer may be among the texts not read.
    if (truncated.length) throw new Error(`#${truncated.join(", #")}: more comments or reviews than read`);
    return false;
  };
}

const REPAIR_PRS = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url baseRefName headRefName headRefOid createdAt updatedAt isCrossRepository commits(last: 1) { nodes { commit { committedDate } } } files(first: 100) { nodes { path } } } }
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
