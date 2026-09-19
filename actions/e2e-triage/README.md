# E2E triage

Runs after an E2E job has reported its results to Test System IO (TSIO) and
answers the question a developer asks first when the check is red: **is this
failure mine?** It writes the answer as the required commit status and as a
sticky PR comment that names the evidence, so a run whose failures are all
trunk's or the environment's goes green without anyone applying a label.

One script, no dependencies: [`scripts/e2e-triage.mjs`](../../scripts/e2e-triage.mjs).

## What it does

1. Reads the run's consolidated results from TSIO. Tests that passed on retry
   are not failures.
2. Asks TSIO for the last 14 days of history of the spec files those failures
   live in (`POST /api/v1/reports/history`, paged): trunk runs and other PRs'
   runs. The request names files rather than tests because a test title is
   reworded far more often than the file it lives in, so a title-keyed request
   would lose a test's history to a typo fix. Rows are matched back to the
   failing tests in the action, on an exact file and title match today; a
   renamed test therefore finds no history and stays blocking, and a looser rule
   can be tried here without a TSIO deploy.
3. Applies the rules, in order:

   | Finding | Meaning | Status |
   | --- | --- | --- |
   | `INFRA` | most failures share an infrastructure signature, or 30+ tests failed | red, nobody blamed, rerun |
   | `OWNED_BY_PR` | the PR changed the failing spec | red, never judged |
   | `BROKEN_ON_TRUNK` | trunk's latest run fails this test too | cleared |
   | `FLAKY_ON_TRUNK` | the test flakes on trunk in the window | cleared |
   | `FLAKY_CROSS_PR` | failed on 3+ other PRs while trunk stayed green | cleared |
   | `INSUFFICIENT_DATA`, `REGRESSION` | history cannot settle it | second judge |

4. For findings the rules cannot settle, asks Claude with an evidence pack
   (error, trunk history, cross-PR recurrence, the PR's changed files and the
   diff hunks of files named in the error). The judge may clear a finding only
   with confidence ≥ `min-confidence` **and** a citation a reviewer can check
   (cross-PR recurrence or a diff hunk), or a bug-on-trunk call. It may veto a
   cleared finding only at ≥ 0.9 with a cited hunk. Model outage keeps the rule
   outcome. At most 8 findings per run are judged.
5. Publishes: the commit status for `status-context` (`enforce` mode) and a
   comment with the table of findings and the judge's explanations.

The repository's existing override label keeps precedence: it is applied by a
human after this step and nothing here removes it.

## Usage (mattermost, Playwright template)

```yaml
      - name: ci/e2e-triage
        if: always() && steps.summary.outcome != 'skipped'
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-triage@<full sha>
        with:
          composite-identity: ${{ needs.prepare-run.outputs.composite-identity-json }}
          status-context: ${{ inputs.context_name }}
          base-ref: ${{ inputs.ref_branch || 'master' }}
          github-token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          mode: ${{ vars.E2E_TRIAGE_MODE || 'report-only' }}
```

The job needs `statuses: write` and `pull-requests: write`. Start with
`report-only` (comment and job summary only), read a week of comments, then set
the repository variable `E2E_TRIAGE_MODE=enforce`.

## On trunk runs

The action also runs on `main`/`master`, detected by the absence of a PR number
in the composite identity. There the question is not "is this the PR's fault"
but "is trunk noisy or actually broken", so the rules change:

| Finding | Meaning | Status |
| --- | --- | --- |
| `BROKEN_ON_TRUNK` | the previous trunk run failed this test too | **blocking** |
| `FLAKY_ON_TRUNK` | intermittent, and the previous run passed | cleared |
| `REGRESSION` | passed in every previous run in the window | blocking |
| `INSUFFICIENT_DATA` | too few earlier runs to tell | blocking |

The important difference is `BROKEN_ON_TRUNK`. On a PR it exonerates, because a
test already failing on trunk is not the PR's doing. On trunk it does the
opposite: it means the failure is still there from last time, and greening a
standing breakage is exactly how a broken trunk becomes permanent and invisible.
A streak stays red however often that test has flaked before.

A run is also excluded from its own history by group id. Without that, a trunk
run has no PR number, lands in its own trunk history, and reads its own failure
as proof that trunk was already broken.

Trunk runs have no PR to comment on, so the outcome goes to the job summary and,
under `enforce`, to the commit status.

## Replay against history

The same script scores itself against labeled past runs without posting
anything, which is how every rule and threshold change is accepted:

```sh
node scripts/e2e-triage.mjs --replay runs.json --compare compares.json \
  --answers answers.json --tsio http://localhost:8080 --out results.json
```

`runs.json` rows: `{repository, pr, name, commit_sha, branch, run_at, truth,
base_ref}`; `compares.json`: `{"<repo>:<sha>": {files: [{filename, patch}],
pr_title}}`; `answers.json` caches judge answers keyed `pr|name|sha7|title` (with
`ANTHROPIC_API_KEY` set, missing answers are asked and cached). The output
table counts green verdicts per ground-truth bucket; runs that were later fixed
by their author must stay red.

## Tests

```sh
node --test scripts/e2e-triage.test.js
```

## Validation (2026-09-17)

Replayed over 370 labeled production PR runs (mattermost-mobile Aug 18 to
Sep 16, mattermost webapp newest 200), history scoped to each run's lane and
anchored at the run's own time. Judge answers came from the cached Claude Haiku
4.5 responses of the earlier evaluation; findings without a cached answer kept
the rule outcome, so the judge's contribution is a lower bound here.

| Ground truth | runs | green |
| --- | --- | --- |
| LIKELY_REGRESSION (failing test unique to the PR, later fixed by the author) | 143 | 3 |
| RECURRING_ELSEWHERE (same tests failed on other PRs, later passed) | 157 | 67 |
| WAIVED by a maintainer (`E2E/Verified`) | 32 | 20 |
| RERUN_PASSED (same commit passed on rerun) | 15 | 11 |
| FIXED_BY_AUTHOR, webapp (proxy label: a later commit passed) | 23 | 3 |

The three likely-regression greens are tests that trunk itself was failing or
flaking on at the time (`BROKEN_ON_TRUNK`, `FLAKY_ON_TRUNK`); the three webapp
greens are the same pattern. No run whose failing test was unique to the PR
was cleared.
