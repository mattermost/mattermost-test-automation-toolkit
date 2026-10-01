# E2E triage

Reads Test System IO (TSIO) evidence after an E2E run and returns `SUCCESS`,
`FAILURE`, or `ACTION_REQUIRED`. The default is **report-only**, with a concise
GitHub job summary and structured outputs. It does not change the required
commit status or post a PR comment by default.

One script, no dependencies: [`scripts/e2e-triage.mjs`](../../scripts/e2e-triage.mjs).
The three producer repositories use this shared implementation; TSIO remains the
source of run and historical test data.

## Decisions

Tests that passed on retry are not failures. For failed tests the action reads
trunk and cross-PR history, then applies these rules in order:

| Finding | Meaning | Outcome on a PR |
| --- | --- | --- |
| `INFRA` | Many infrastructure signatures, or 30+ failures | `ACTION_REQUIRED`; investigate, never cleared |
| `OWNED_BY_PR` | The PR changed the failing spec | Blocking; never sent to the model |
| `BROKEN_ON_TRUNK` | The latest trunk observation fails this test too | Cleared |
| `FLAKY_ON_TRUNK` | This test is intermittent on trunk | Cleared |
| `FLAKY_CROSS_PR` | At least three other PRs fail this test and trunk has actually passed it | Cleared |
| `INSUFFICIENT_DATA`, `REGRESSION` | History cannot clear the failure | Blocking unless the model supplies qualifying evidence |
| `SAME_FAILURE_AS_CLEARED` | Still blocked after the model, but fails with the same spec and error as a failure in this run that history cleared | Cleared (PR runs only; timeouts and short messages never match) |

A widespread failure can be a product bug as well as an environment problem.
`ACTION_REQUIRED` is not proof that the PR is innocent. Likewise, an unresolved
failure is not automatically proof that the PR caused it.

Claude receives one evidence pack per finding, at most eight per run. Clearing
requires confidence at least `min-confidence` (default 0.85) and a validated
citation to actual cross-PR evidence or a related diff hunk. A model claiming
`bug_on_master` without qualifying evidence cannot clear anything. Vetoing a
history-cleared finding requires confidence at least 0.9 and a related hunk.
Model failure preserves the deterministic outcome. Model confidence is not a
measured accuracy rate.

Incomplete changed files, unknown test root or trunk branch, truncated history,
or unprovable report scope block clearing and skip the model. A test with
unresolved identity also stays blocking and is never sent to the model.

## Identity and report scope

Runs require exact repository, commit, name, GitHub run ID and run attempt.
Incomplete groups, missing suite file paths and empty runs fail closed.

Tests are matched by file and full ancestor-qualified title, within the configured
report scope. Same-leaf siblings cannot borrow each other's history or hide a
failure with another sibling's pass. Qualified current titles cannot be matched
to legacy history missing their ancestry. TSIO must serve full titles in both
current cases and historical observations for that comparison to be possible.

`report-name` is a producer-supplied prefix, such as `e2e-on-windows-2022-`.
This keeps desktop history within one OS while allowing version suffixes to
change. Without an explicit prefix, worker/shard names are not guessed into
lanes. Duplicate identities across reports in one group, conflicting duplicate
observations and ambiguous legacy identities remain blocking. A renamed test
has no matching history; this action does not fuzzy-match names.

## Usage

```yaml
      - name: ci/e2e-triage
        if: always() && steps.summary.outcome != 'skipped'
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-triage@<published full sha>
        with:
          composite-identity: ${{ needs.prepare-run.outputs.composite-identity-json }}
          status-context: ${{ inputs.context_name }}
          test-root: e2e-tests/playwright
          github-token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          mode: ${{ vars.E2E_TRIAGE_MODE || 'report-only' }}
          post-pr-comment: "false"
```

Set `test-root` to the repository-relative root of this producer's specs, or `.`
if TSIO already returns repository-relative paths. Desktop also supplies its
per-OS `report-name`. The PR base branch is read from GitHub metadata.

Outputs are `verdict`, `blocking`, `exonerated`, and `description`. `blocking`
counts unresolved failures, including missing evidence and run-level infra
failures. Consumers must use `verdict`, not parse summary text, to gate jobs.
Existing consumer workflows retain their manual override handling.

- **report-only (default):** job summary and outputs only; required status unchanged.
- **enforce:** also writes success only for `SUCCESS`, otherwise failure, on the
  configured commit-status context. The consumer remains responsible for its
  job assertion and manual override ordering.
- **post-pr-comment: "true":** separately opts into a sticky comment, in either
  mode. It contains the same compact summary with collapsed evidence. Otherwise
  no comment is read, created, updated or deleted. Existing comments are left alone.

GitHub read access is needed for PR metadata and files. `statuses: write` is
needed for enforce; `pull-requests: write` is needed only for optional comments.
The workflow token is used only with GitHub, never sent to TSIO or Anthropic.
Only the exact mode `enforce` (with surrounding whitespace ignored) enables
status writes. Unknown modes are logged and treated as report-only.

## Trunk runs

Without a PR number the action evaluates the trunk commit's changed files.
A previous failure of the same test is `BROKEN_ON_TRUNK` and **stays blocking**.
Only intermittency with a prior passing run may clear. The current group is
excluded from its own history and the model is not called on trunk runs.
Master repair automation is separate from triage: a repeated master failure
is evidence to investigate and fix, not a reason to permanently green trunk.

## Replay against history

Replay uses the same `evaluateRun` path as live triage, including ownership,
report scope, ambiguity, evidence completeness and trunk rules. It never calls
GitHub or publishes comments/statuses. With `ANTHROPIC_API_KEY` it may call the
model; without it only answers for exact cached evidence packs are used.

```sh
node scripts/e2e-triage.mjs --replay runs.json --compare compares.json \
  --answers answers.json --tsio http://localhost:8080 --out results.json
```

A `runs.json` row carries:

```json
{
  "repository": "mattermost/desktop",
  "pr": 123,
  "name": "desktop-pr",
  "commit_sha": "full-commit-sha",
  "gh_run_id": "123456",
  "gh_run_attempt": "1",
  "branch": "pr-123",
  "base_ref": "master",
  "run_at": "2026-09-30T12:00:00Z",
  "test_root": "e2e/specs",
  "report_name": "e2e-on-windows-2022-",
  "truth": "REGRESSION"
}
```

`run_at` is the historical evaluation cutoff; later observations are not requested.
For trunk, omit `pr` and supply the trunk `branch`. `test_root` and `report_name`
may also come from `TEST_ROOT` and `REPORT_NAME` environment variables.

`compares.json` maps **repository:full-commit-sha** to
`{"complete": true, "files": [{"filename": "...", "patch": "..."}], "pr_title": "..."}`.
Only mark it complete after capturing all pages of the PR diff (or trunk commit
files) at the evaluated revision. Missing or partial captures cannot clear tests.

Answers are keyed by model, system prompt and the complete evidence pack,
including qualified test identity and report scope. Old leaf-title answer keys
are deliberately ignored; they cannot establish which test was judged.

Output is `{evaluated, skipped, results}`. Skipped entries include reasons and
are reported alongside the ground-truth table. An empty or entirely skipped
corpus exits nonzero. Partial coverage must be investigated before using a replay
as calibration; it is not evidence of safety for the skipped population.

## Validation and rollout

```sh
node --test scripts/e2e-triage*.test.js
```

The tests use fake HTTP responses, including live/replay parity, ambiguous
identity, ownership, incomplete evidence, cache separation and comment opt-in.
CI runs all triage test files. These tests do not establish production accuracy.

The old 370-run replay used earlier rules and leaf-title cached model answers.
Its percentages do **not** calibrate this implementation. Before enabling
`E2E_TRIAGE_MODE=enforce` in any consumer:

1. Deploy the required TSIO history/case identity fields and validate per-OS scope.
2. Publish a reviewed toolkit commit and pin consumers to that reachable full SHA.
3. Demonstrate `OWNED_BY_PR` on a controlled real report-only run.
4. Replay an identity-aware corpus with complete captured diffs and inspect false
   clearances, missing data and coverage, then review report-only outcomes with the team.

Keep report-only until those checks are reviewed. TSIO credentials, rollout
variables, master repair triggers and branch protection are outside this action's
configuration changes.
