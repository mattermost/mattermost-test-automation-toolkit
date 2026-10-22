# Owned E2E status publication

Use this action for **every writer of a lane's required status**: claim pending
before preparation, finish with the raw test result, and claim success for a
skipped suite. `e2e-triage` uses the same guard for its verdict. Disable the TSIO
begin/summary actions' status writes when adopting this writer.

The latest owning run ID wins, then its attempt. Workflow source `github.sha`
and `github.ref` are deliberately irrelevant: manual dispatch from master and
automatic dispatch from a PR branch can test exactly the same commit. An old
run rerun after a newer run cannot reclaim that newer run's status. Terminal
writes require an existing claim by the same run; unknown current status URLs
are left alone. API errors or truncated history fail closed.

## Required caller serialization

GitHub statuses have no atomic compare-and-swap. **The guard alone is not a
lock.** All prepare/claim, skip, report/triage, and aggregate-publication jobs
for the tested commit must use this same repository-wide mutex:

```yaml
concurrency:
  group: e2e-status-publish-${{ inputs.commit_sha }}
  cancel-in-progress: false
  queue: max
```

Use the full tested SHA, not the workflow-source SHA and not the PR number
(two PRs can point at one commit). `queue: max` preserves queued publication
jobs; the default single pending slot can discard another lane's final report.
GitHub supports up to 100 queued jobs. See [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Separately serialize each whole lane by resolved PR (or tested SHA for trunk),
suite, edition, and report type with `cancel-in-progress: false`. Different
suites/editions still execute independently. Do not nest the same concurrency
group at the lane and publication levels.

Guard actual publication and triage steps with `!cancelled()` and cancelled
worker/dispatch results. Keep diagnostic summary collection and worker artifact
uploads on `always()`, with TSIO `update-commit-status: "false"`.
A cancellation leaves the current pending status intact.

For dispatched runs, set `verify-reports: "true"`, pass `execution-success`
only when preparation, dispatch and all workers succeeded, and set
`tsio-base-url` to the dispatcher's selected environment (or `use-staging: "true"`
for staging, which fails if `tsio-base-url` names any other URL; `use-staging`
is `"false"` by default and then changes nothing). The orchestration
summary can succeed before shard uploads fail. Verification requires the exact
run/attempt's complete, nonempty reports and keeps missing/unreadable reports,
failed upstream jobs, and reported test failures red. It never promotes a
failed summary. `state` exposes that validated raw result; `reports-complete`
is affirmative only after verification.

Verification waits up to `report-wait-seconds` (120) for late uploads, while the
caller usually holds the `e2e-status-publish-<sha>` lock, so every other lane's
publication waits too. A caller that runs after all its worker jobs finished can
keep it short (their uploads are done); none is spent when `execution-success`
isn't `"true"`, since that lane is red anyway.

Run triage for a raw failure, but permit enforcement only with successful
upstream execution and `reports-complete == 'true'`. Otherwise use report-only
to retain diagnostics. Apply those same gates to the report job's final
assertion, and accept a triage SUCCESS only after the triage step succeeds,
its `published` output confirms a required-status write, and `effective-mode`
equals `enforce` (after its PR label check). If reports arrive after the
initial incomplete check, the current attempt stays red until a rerun.

Manual/label verification workflows also hold the same SHA lock across their
existing read/failure-only override/write. They preserve the original target
URL and owner, then use `operation: summarize` to refresh the factual aggregate
without claiming any required lane. Their existing authorization checks remain
in place. Never use the snapshot operation to write a required lane context.

## Attempts and the lane summary

Report-only job reruns may reuse attempt 1's report identity. Publication uses
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`; `status_run_id` and
`status_run_attempt` in the status target URL carry that owner without changing
the report URL's `gh_run_attempt`. Thus attempt 2 can finish its own run while
still linking the original diagnostics. Older attempts cannot overwrite it.

When configured, `triage-status-context` is also refreshed after pending, skip,
raw result and triage writes, inside the same lock. This is a factual summary
of the required statuses, including when AI triage is report-only or disabled
by a PR label: it never clears a failure. The triage action itself still writes
nothing in report-only mode or with `E2E/Triage-report-only`. Only listed lanes
may refresh the shared summary; other suites/editions cannot change it. Terminal
failures remain red even if triage is unavailable. No delayed 15-second snapshot
is needed.

## Rollout

A branch fix cannot change a running workflow's YAML or an action pinned by
older YAML. Update both automated dispatch and manual/master entry paths to
the same toolkit commit and workflow changes, then let older unguarded runs
finish before relying on exclusive ownership. Do not mix old and new writers
and claim the race is fixed. This action does not change deployed TSIO services.
