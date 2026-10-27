// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Shapes the triage modules share. Each field mirrors what the old engine reads or writes: optional and
// nullable fields are the ones it checks with ?. or ??.

export type TsioId = string | number;

/** One TSIO history row: a past execution of a test. */
export interface Observation {
  file: string;
  title: string;
  full_title?: string | null;
  suite_title?: string | null;
  name?: string | null;
  branch?: string | null;
  status: string;
  retry_count: number;
  ordinal?: number;
  gh_pr_number?: number | string | null;
  commit_sha?: string | null;
  created_at?: string | null;
  error_excerpt?: string | null;
  report_name?: string | null;
  group_id?: TsioId | null;
}

/** A failing test as the rules see it: its identity and error, and what the run recorded about it. */
export interface TestRef {
  file: string;
  title: string;
  full_title?: string | null;
  suite_title?: string | null;
  report_name?: string | null;
  report_scope?: string | null;
  error?: string | null;
  identity_ambiguous?: boolean;
  identity_unresolved?: boolean;
  repo_path?: string | null;
  tries?: { ran: number; failed: number };
  /** Where the test ran in its report (TSIO's case ordinal), when the run says. */
  ordinal?: number | null;
}

/** A commit a TSIO-side or GitHub-side lookup named: its sha, and the PR merged in it when the message says so. */
export interface At {
  commit_sha: string | null;
  created_at: string | null;
}

export interface TrunkStats {
  runs: number;
  fails: number;
  flaky: number;
  passes: number;
  latest: string;
}

export interface CrossPRStats {
  prs: (number | null)[];
  examples: string[];
  passes: number;
}

export interface TrunkBreak {
  first_fail: At | null;
  last_pass: At | null;
}

export interface ThisPRStats {
  runs: number;
  passes: number;
  fails: number;
  last_pass: At | null;
  /** The status of this PR's most recent earlier run of the test ("" when there is none). */
  latest: string;
}

/** One test's verdict input: the test, its class and reason, and the history statistics behind them. */
/** One past run of a spec file: it did not run (its placeholder), a test failed every try, every test was skipped, or it passed. */
export interface SpecRun {
  group_id: string;
  status: "not_run" | "failed" | "skipped" | "passed";
}

/** Past runs of the specs a stopped Jest process skipped, by file (see fetchSpecRuns). */
export interface SpecHistory {
  byFile: Map<string, SpecRun[]>;
  truncated: boolean;
}

export interface Finding extends TestRef {
  class: string;
  reason: string;
  blocking: boolean;
  trunk: TrunkStats;
  cross_pr: CrossPRStats;
  failure_signatures: string[];
  trunk_break: TrunkBreak | null;
  /** FIXED_ON_TRUNK: trunk's last failing run of the ended streak, and its first pass after it. */
  trunk_fixed?: { last_fail: At | null; first_pass: At | null };
  this_pr: ThisPRStats;
  untouched?: boolean;
  producer?: Evidence;
  out_of_date?: OutOfDate;
  broke_by?: BrokeBy;
  since_last_pass?: SinceLastPass;
  code_near_failure?: string | null;
  other_lanes?: { platform: string; result: string }[];
  /** The earliest test of the same spec that failed before this one in this run, with another error (see markEarlierFailures). */
  earlier_failure?: EarlierFailure;
  decision?: string;
  judge?: Answer | null;
  ai?: Ai;
  escalated?: boolean;
  same_as?: string;
  same_as_class?: string;
}

/** An earlier failure in the same spec and run: its title, the first line of its error, and its class. */
export interface EarlierFailure {
  title: string;
  error: string;
  class: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export type Cause = "caused_by_pr" | "flaky_environment" | "bug_on_master" | "test_bug";

export interface Provenance {
  requested_model?: string;
  served_model: string;
  temperature?: number | null;
  pack_hash?: string;
}

/** One judge answer, validated (see parseAnswer). Provenance is added when the answer is kept. */
export interface Answer {
  cause: Cause;
  confidence: number;
  cited_evidence: string[];
  explanation: string;
  provenance?: Provenance;
}

export interface Hunk {
  id: string;
  file: string;
  related: boolean;
  patch: string;
}

export interface Pack {
  test: {
    title: string;
    full_title: string | null;
    suite: string | null;
    file: string;
    report_scope: string | null;
    report_name: string | null;
    lane?: string;
  };
  error: string;
  engine: { class: string; reason: string };
  trunk_history_14d: { runs: number; fails: number; flaky: number; latest: string };
  cross_pr_failures_14d: { id: "cross_pr"; other_prs_where_this_test_failed: string[]; other_pr_runs_where_it_passed: number };
  pr: {
    number: number | null;
    repository: string;
    title: string;
    changed_file_count: number;
    changed_files: string[];
    spec_file_changed_by_pr: boolean;
    change_summary?: ChangeSummary;
  };
  diff_hunks_of_files_named_in_error: Hunk[];
  other_failures_in_same_run: { class: string; title: string }[];
  producer_evidence?: { id: "producer"; notes: string; screenshots: { name: string; sha256: string }[] };
  this_pr_history?: ThisPRHistory;
  same_test_other_platforms_this_run?: { id: "other_platforms"; results: { platform: string; result: string }[] };
  earlier_failure_same_spec?: { id: "earlier_failure_same_spec" } & EarlierFailure;
  tries_in_this_run?: { ran: number; failed: number };
  test_code_near_failure?: string;
}

/** The PR's changed files in one category: how many, and up to 20 of their paths. */
export interface ChangeBucket {
  count: number;
  examples: string[];
}

/** What the PR changed, by category (see changeSummary in pack.ts). Unknown files count as product. */
export interface ChangeSummary {
  product: ChangeBucket;
  e2e_harness: ChangeBucket;
  ci: ChangeBucket;
  docs: ChangeBucket;
  other: ChangeBucket;
}

export interface ThisPRHistory {
  id: "this_pr";
  earlier_runs_on_this_pr: number;
  passed: number;
  failed: number;
  /** The status of the most recent earlier run of this test on this PR ("" when none). Only "passed" makes this_pr citable. */
  latest: string;
  last_passed: { commit: string | null; at: string | null } | null;
  changed_since_last_pass?: {
    file_count: number;
    files: string[];
    complete: boolean;
    related_to_this_test: string[];
    related_changes: { file: string; patch: string }[];
    changes?: { file: string; patch: string }[];
    /** Related files that changed only because the base branch was merged in: trunk runs them, the PR did not change them. */
    related_from_base?: string[];
  };
}

export interface EvidenceImage {
  name: string;
  media_type: string;
  data: string;
  sha256: string;
}

/** What the test run itself recorded for one test: notes and screenshots (see loadEvidence). */
export interface Evidence {
  file: string;
  title: string;
  full_title: string | null;
  notes: string;
  images: EvidenceImage[];
}

export interface SinceLastPass {
  files: string[];
  related: { file: string; patch: string }[];
  changes?: { file: string; patch: string }[];
  complete: boolean;
  /**
   * The files among `files` whose change is this PR's own: in the PR's diff now, with a patch that differs from the PR's
   * diff at the last pass (or could not be compared). The rest came in from the base branch. Absent when unknown.
   */
  pr_changed?: string[];
}

export interface CommitRef {
  sha: string;
  date: string;
  pr: number | null;
}

export interface OutOfDate {
  base: string;
  /** Commits the PR is behind the base; null for the branch-state hold, where no comparison was made. */
  behind: number | null;
  commit: CommitRef | null;
  /** The branch-state hold: this PR failed the same way on its last `streak` commits (this run included), never on the base. */
  streak?: number;
  /** The base branch fixed this failure at `commit` (see markFixedOnTrunk), after this PR last merged it. */
  fixed?: boolean;
}

export interface BrokeByCommit {
  sha: string;
  pr: number | null;
  author: string | null;
}

export interface BrokeBy {
  from: string | null | undefined;
  to: string | null | undefined;
  total: number;
  commits: BrokeByCommit[];
}

export interface Ai {
  model?: string;
  cost_usd?: number | null;
  skipped?: string;
}

export interface CallRecord {
  model: string;
  served_model: string;
  findings: number;
  usage: Usage | null | undefined;
  cost_usd: number | null;
  rejected?: string;
}

export interface Skipped {
  no_effect: number;
  duplicate: number;
  cached: number;
  cap: number;
  budget: number;
}

/** What a run spent on the model, and why it did not spend more. */
export interface Ledger {
  calls: CallRecord[];
  skipped: Skipped;
  budgetLabel?: string;
}

export interface Price {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export type Prices = Record<string, Price>;

/** Engine settings. `answers` is the answers cache; `budgetLabel` is set when the PR's budget narrows the run's. */
export interface Config {
  windowDays: number;
  trunkRuns: number;
  crossPRRuns: number;
  minTrunkRuns: number;
  pMin: number;
  crossPRMinPRs: number;
  minConfidence: number;
  vetoMin: number;
  maxJudged: number;
  advise: boolean;
  infraMinFailures: number;
  infraClears: boolean;
  /** Re-runs of the failed jobs triage may ask for when only placeholders or missing reports keep a lane red (0: none). */
  rerunAttempts: number;
  historyLane: string | null;
  escalationModel: string;
  escalateMin: number;
  budgetUsd: number;
  prBudgetUsd: number;
  reportOnlyLabel: string;
  model: string;
  budgetLabel?: string;
  answers?: Record<string, unknown>;
  prices?: Prices;
}

/** The PR a run belongs to (number null for a trunk run). */
export interface PrRef {
  number: number | null;
  repository: string;
  title: string;
  lane?: string;
}

/** A changed file from GitHub: its name, and its patch when GitHub sent one. */
export interface ChangedFile {
  filename: string;
  patch?: string;
}

/** The changed files of a PR (or commit), and whether that list is complete. */
export interface Diff {
  files: ChangedFile[];
  ok: boolean;
}

/** One entry of a judge call's output: an answer, or the error that stands in for it. */
export type AnswerOrError = Answer | Error;

export interface BatchResult {
  answers: AnswerOrError[];
  usage: Usage | null;
  served_model: string;
}

export interface Counts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

/** A TSIO history result: rows by test identity, with the flags the rules read. */
export interface HistoryLike extends Map<string, Observation[]> {
  truncated?: boolean;
  reportUnknown?: boolean;
  ambiguous?: Set<string>;
}

/** The judge's ask: one batch of packs for one model. */
export type AskFn = (packs: Pack[], model: string) => Promise<BatchResult>;
