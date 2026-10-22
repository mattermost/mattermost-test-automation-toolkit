// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type { Observation, TestRef } from "../../e2e-test-triage/src/types.ts";
import { identityKey } from "../../shared/src/tsio.ts";

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

export type Kind = "broken" | "flaky";

/** The fields of a TSIO history row that the watch reads. */
export type RunRow = Pick<Observation, "status" | "branch" | "gh_pr_number" | "created_at" | "commit_sha" | "group_id">;

/** TSIO history by test identity, newest first; `ambiguous` holds identities the rows can't be tied to. */
export type RunHistory = ReadonlyMap<string, readonly RunRow[]> & { readonly ambiguous?: ReadonlySet<string> };

/** Trunk counts of a test before this run. `recovered_on_retry_now` marks a test that passed only on retry in this run. */
export interface TrunkCounts {
  runs: number;
  fails: number;
  flaky: number;
  passes: number;
  latest: string;
  recovered_on_retry_now?: boolean;
}

/** When a broken spec could have broken: run times in ms; `from` is -Infinity when no history places it. */
export interface BreakWindow {
  from: number;
  to: number;
}

export type RangeEnd = Pick<RunRow, "commit_sha" | "created_at">;

/** The suspect range: the last green run and the first red one (null when this run is the first red). */
export interface SuspectRange {
  green: RangeEnd;
  red: RangeEnd | null;
}

/** One failing test in a group: its spec, the lane (suite) it failed in, and what triage said. */
export interface GroupTest {
  spec: string;
  suite: string;
  title: string;
  full_title: string | null;
  error: string;
  trunk: TrunkCounts;
  finding: TestRef;
  failed_in_suites_now?: string[];
}

/** The failing tests of one spec, with the kind of repair they need. */
export interface Group {
  spec: string;
  kind: Kind;
  suites: Set<string>;
  tests: GroupTest[];
}

/** The spec a finding belongs to: its path from the repository root, else its file. */
export const specOf = (f: { repo_path?: string | null; file: string }): string => f.repo_path ?? f.file;

/** A timestamp cut to the minute, for the job summary. */
export const utcMinute = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** A test's trunk runs in a history, newest first. History also carries other PRs' runs, which are not trunk. */
export function trunkRows(history: RunHistory, test: TestRef, branch: string): RunRow[] {
  return (history.get(identityKey(test)) ?? []).filter((o) => o.branch === branch && (o.gh_pr_number == null || o.gh_pr_number === ""));
}

/** How often a group's or request's tests failed or flaked on trunk before this run. */
export const flakes = (r: { readonly tests: readonly GroupTest[] }): number =>
  r.tests.reduce((n, t) => n + (t.trunk?.fails ?? 0) + (t.trunk?.flaky ?? 0), 0);
