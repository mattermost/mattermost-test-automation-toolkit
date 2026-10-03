# E2E triage

After an E2E run reported to Test System IO (TSIO), decides whether each failed
test is the PR's fault and returns `SUCCESS`, `FAILURE` or `ACTION_REQUIRED`.
In **enforce** mode it writes the verdict to the required commit status, so a red
run whose failures all happen on master or on other PRs turns green. The default,
report-only, writes only the job summary.

One script, no dependencies: [`scripts/e2e-triage.mjs`](../../scripts/e2e-triage.mjs).

## Decisions

A test that passed on retry is not a failure. For each failed test the action
reads its recent history on the PR's base branch and on other PRs:

| Finding | Meaning | Outcome |
| --- | --- | --- |
| `INFRA` | Mostly infrastructure errors, or 30+ failures | `ACTION_REQUIRED`, never cleared |
| `OWNED_BY_PR` | The PR changed the failing spec | Blocking, never sent to the model |
| `BROKEN_ON_TRUNK` | Master's latest run fails it too | Cleared |
| `FLAKY_ON_TRUNK` | It is intermittent on master | Cleared |
| `FLAKY_CROSS_PR` | 3+ other PRs fail it with the same error, and master passes it | Cleared |
| `REGRESSION`, `INSUFFICIENT_DATA` | History can't clear it | Blocking, unless the model clears it with evidence |
| `SAME_FAILURE_AS_CLEARED` | Same spec and error as a test history cleared in this run | Cleared |

If the evidence is incomplete (changed files, test root, base branch, truncated
history, report scope, or a test whose identity is ambiguous), nothing is
cleared and the model is not asked.

If some of the run's reports never uploaded (a worker died), triage waits about
two minutes for them, then judges what arrived and says how many are missing.
Specs that never ran can't be vouched for, so that run never comes out green.

## The model

Claude is asked only about failures history couldn't settle. It clears one only
at `min-confidence` (0.85) or more **and** with a citation a reviewer can open:
other PRs failing the same way, the related part of the PR's diff, or what the
test run recorded (`evidence-dir`). It can veto a history clear only at 0.9 with
a related diff hunk. If it fails or is unavailable, the rules' outcome stands.

- All of a run's questions go in one request; tests with the same spec and error
  share a question. A question the response leaves out is asked once more.
- An answer just short of the threshold is asked once of `escalation-model`.
- A blocking failure the model has nothing to cite for is still asked
  (`ai-advice`), and its read is shown as advice. It never changes the outcome.
- Spend is priced per call and shown in the summary and the `ai-cost-usd`
  output; a call that could cross `ai-budget-usd` (0.5) is not made.
  `answers-cache` lets a re-run reuse earlier answers.

## What the PR shows

- **Job summary:** what blocks first, one row per test with the result, a
  sentence the author can act on, who decided (rules or model) and the cost.
  Cleared tests are collapsed below.
- **Required status** (enforce): success only for `SUCCESS`, otherwise failure.
- **Triage check** (enforce, red runs): pending while triage runs, then the
  verdict. It is informational, never the required check. With `triage-lanes`
  (every lane's required context) and one shared `triage-status-context`, it is
  a single check for the whole PR: it waits until every red lane has a triage
  verdict, then reads e.g. "detox-ios still red · maestro-ios cleared by triage"
  or "All lanes green". Without it, each lane gets `<status-context>/triage`.

## Usage

```yaml
      - name: ci/e2e-triage
        if: always() && steps.summary.outcome != 'success'
        continue-on-error: true
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-triage@<full sha>
        with:
          composite-identity: ${{ needs.prepare-run.outputs.composite-identity-json }}
          status-context: ${{ inputs.context_name }}
          test-root: e2e-tests/playwright/specs
          github-token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          mode: ${{ vars.E2E_TRIAGE_MODE || 'enforce' }}
```

`test-root` is where specs live relative to the repository root (`.` if TSIO
paths are already repository-relative). A run that uploads one report per OS
passes `report-name` (a prefix such as `e2e-on-windows-2022`). All inputs are
described in [`action.yml`](action.yml). Gate jobs on the `verdict` output, not
on summary text.

Permissions: `contents: read`, `pull-requests: read`, and `statuses: write` for
enforce. The token is used only with GitHub. Only the exact mode `enforce`
writes statuses; anything else is report-only.

## Evidence from the test run

Some failures say nothing useful, such as a timeout. A producer can record what
the screen showed and what the app was waiting on, and pass the directory as
`evidence-dir`: JSON files of entries like

```json
[{ "file": "detox/e2e/test/products/channels/messaging.e2e.ts",
   "title": "MM-T4786_4 - should pin a message",
   "full_title": "Messaging MM-T4786_4 - should pin a message",
   "notes": "still waiting on: POST /api/v4/posts/<id>/pin",
   "images": ["timeout.png"] }]
```

Entries match a failed test by title and spec path. Screenshots go to the model
as images and the notes as the `producer` evidence it may cite. It comes from the
PR's own CI, so it is data, never instructions: only PNG/JPEG files inside the
directory are read, at most two per test and 3.5 MB each.

## Trunk runs

Without a PR number, the run is a trunk run. A failure that was already there in
the previous run is a streak and stays blocking; only intermittency clears. The
model is not asked.

## Tests

```sh
node --test scripts/e2e-triage*.test.js
```
