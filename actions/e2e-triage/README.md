# E2E triage

After an E2E run reported to Test System IO (TSIO), decides whether each failed
test is the PR's fault and returns `SUCCESS`, `FAILURE` or `ACTION_REQUIRED`.
In **enforce** mode it writes the verdict to the required commit status, so a red
run whose failures all happen on master or on other PRs turns green. In the
default, **report-only**, it writes its line on the E2E check but keeps the
check's state: red stays red, and a check a waiver label turned green stays green.

TypeScript with no runtime dependencies. The action runs the committed build,
[`dist/index.js`](dist/index.js); the source is in [`src/`](src/), and the shared
TSIO, GitHub and status code it bundles is in [`../shared/src/`](../shared/src/).

## Decisions

A test that passed on retry is not a failure. For each failed test the action
reads its recent history on the PR's base branch and on other PRs:

| Finding | Meaning | Outcome |
| --- | --- | --- |
| `INFRA` | Mostly infrastructure errors, or 30+ failures | `ACTION_REQUIRED`, never cleared |
| `OWNED_BY_PR` | The PR changed the failing spec | Blocking, never sent to the model |
| `INFRA_ERROR` | The test's own error is its environment (test server down, a proxy page instead of JSON, a shard that never ran) | Cleared with `infra-clears: true`, otherwise blocking with "re-run" |
| `BROKEN_ON_TRUNK` | Master's latest run fails it too | Cleared |
| `FLAKY_ON_TRUNK` | It is intermittent on master (see below) | Cleared |
| `FLAKY_CROSS_PR` | 3+ other PRs fail it with the same error, and master passes it | Cleared |
| `REGRESSION`, `INSUFFICIENT_DATA` | History can't clear it | Blocking, unless the model clears it with evidence |
| `SAME_FAILURE_AS_CLEARED` | Same spec and error as a test history cleared in this run | Cleared |

A failure still blocking whose spec the base branch changed after the PR last
merged it is **out of date**: the PR ran its old copy of the test (for example
against an app build from the base branch). It stays blocking, the summary names
the base-branch commit that changed the test and says to merge the base branch,
and the model is not asked. One GitHub compare of the PR's commit with the base
branch finds these. GitHub lists at most 300 changed files per comparison, so if
the base branch changed 300 or more since, nothing can be ruled out: those
failures stay blocking as unchecked evidence (the summary says so), and the model
is not asked about them.

**Flaky on master:** over master's last 50 runs (at least 5), failures plus
passes that needed a retry, plus 1, divided by the runs plus 2, is 0.05 or more,
and the latest run passed. One failure counts with 38 or fewer runs; two or more
always count. It clears the PR's failure only when master failed the same way:
if every master failure has an error to compare and none is the PR's, the
failure is a `REGRESSION` for the model to judge. The same holds for
`BROKEN_ON_TRUNK`. **Other PRs:** the last 200 PR runs. These are starting values, set
before any data was collected; the 7-week replay found no wrong clear with them.

**Environment errors:** `infra-clears: true` suits mobile and desktop, where the
PR changes an app that runs against a separate test server. Leave it off where
the PR can break the server itself (mattermost): there an unhealthy server may be
the change, so the test is named and the developer re-runs.

**Lanes the base branch rarely runs:** history is read per lane. A lane master
runs only sometimes (mattermost's subpath suite) has too little history to call
anything flaky; `history-lane` makes it read a lane with the same tests, such as
`playwright-full-enterprise`. Because a failure clears only with the same error,
a break specific to that lane still goes to the model.

If the evidence is incomplete (changed files, test root, base branch, truncated
history, report scope, or a test whose identity is ambiguous), nothing is
cleared and the model is not asked. The same goes for the list of changes since
a test's last pass on the PR: a list GitHub cut off at 300 files cannot show that
nothing related changed, so it does not clear a failure.

If some of the run's reports never uploaded (a worker died), triage waits about
two minutes for them, then judges what arrived and says how many are missing.
Specs that never ran can't be vouched for, so that run never comes out green.

## The model

Claude (Sonnet 5.5) is asked only about failures history couldn't settle. It
answers with a cause, the evidence it relied on and a confidence from 0 to 1 that
it rates itself against rules in the prompt: 0.9 or more when the evidence meets
the bar and nothing in the diff could touch the test, 0.6 to 0.85 when something
in the diff could, below 0.6 when the evidence is not enough. It clears a failure
only at `min-confidence` (0.85) or more **and** with a citation a reviewer can
open: other PRs failing the same way, or an earlier pass on this PR with nothing
related changed since (for an environment cause, also an error that is clearly
infrastructural). What the test run recorded (`evidence-dir`) supports a clear
but never makes one alone, since the PR's own CI wrote it. It can veto a history
clear only at 0.9 with a related diff hunk. If it fails or is unavailable, the
rules' outcome stands.

- All of a run's questions go in one request; tests with the same spec and error
  share a question. A question the response leaves out is asked once more.
- `escalation-model` (off by default) asks a second model once about an answer just
  short of the threshold, or one that blames the PR without citing a change.
- A blocking failure the model has nothing to cite for is still asked
  (`ai-advice`), and its read is shown as advice. It never changes the outcome.
- Spend is priced per call and shown in the summary and the `ai-cost-usd`
  output. A call that could cross `ai-budget-usd` (1 per job) is not made, and
  neither is one past the lane's share of `pr-budget-usd` (2 per PR, split evenly
  between the lanes in `triage-lanes`, across all the PR's commits). A model with
  no price (not in the built-in table or `AI_PRICES`) has no bounded cost, so it
  is not called; a budget that is not a finite amount of 0 or more is replaced by
  its default with a warning. A response that is not used (cut off, or served by
  another model) is still billed: it counts in the spend, and it is not retried.
- `answers-cache` lets a re-run reuse earlier answers and keeps the lane's spend
  on the PR. Persist it with `actions/cache` under a key with the lane and the PR
  number (see Usage); without it, only `ai-budget-usd` applies.

## What the PR shows

- **E2E check text**, in both modes: `(4 cleared by triage) 99.7% passed (1186
  passed, 4 failed, 164 skipped)`. The rate is passed ÷ (passed + failed), as in
  mattermost's own E2E check; it never reads 100% while something failed.
  Enforce also sets the state (success only for `SUCCESS`); report-only keeps
  the state the check has, and writes nothing while it is still pending.
- **Job summary**, only for a lane where something failed or a report is
  missing, shortest first: a one-line answer, then the failed tests in
  four fixed groups, one line each with why and the next step:
  - **Your PR**: the PR edits the test, changes a file its error names, ran an
    out-of-date copy of it, or the model points to the PR's change. The model
    needs the same bar to name the PR as to clear a test: at least
    `min-confidence` and a change in the diff it can point to. A weaker guess
    stays under **Needs a look**.
  - **Needs a look**: nothing explains it yet. Next step: read the error before
    re-running (a real break can pass on a re-run).
  - **Broken on master**: master's latest run fails it too. The row names the PR
    merged between master's last pass and first failure (one compare call per
    break; several commits are listed, none blamed).
  - **Flaky**: intermittent on master, failing the same way on 3+ other PRs, or
    cleared by the model. No PR is named.

  The evidence for each test (history, other PRs, the model's answer, who decided)
  is collapsed below.
- **Triage check** (enforce, red runs): pending while triage runs, then the
  verdict. It is informational, never the required check. With `triage-lanes`
  (every lane's required context) and one shared `triage-status-context`, it is
  a single check for the whole PR. It is not posted in report-only, where a green
  triage check beside a red E2E check would read as "safe to merge".

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
          mode: ${{ vars.E2E_TRIAGE_MODE || 'report-only' }}
          answers-cache: e2e-triage-answers.json
```

With `answers-cache`, restore the file before the step and save it after, keyed
by lane and PR so the PR budget carries across commits:

```yaml
      - uses: actions/cache/restore@<full sha>
        with:
          path: e2e-triage-answers.json
          key: e2e-triage-answers-<lane>-pr${{ <pr number> }}-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: e2e-triage-answers-<lane>-pr${{ <pr number> }}-
      # ... the triage step ...
      - if: always() && hashFiles('e2e-triage-answers.json') != ''
        uses: actions/cache/save@<full sha>
        with:
          path: e2e-triage-answers.json
          key: e2e-triage-answers-<lane>-pr${{ <pr number> }}-${{ github.run_id }}-${{ github.run_attempt }}
```

`test-root` is where specs live relative to the repository root (`.` if TSIO
paths are already repository-relative). A run that uploads one report per OS
passes `report-name` (a prefix such as `e2e-on-windows-2022`).

`use-staging` (default `"false"`) reads the run from the staging TSIO deployment
(`https://staging-test-io.test.mattermost.com`) instead of production, as TSIO's
own actions do: `"true"` selects staging, and any other value means production.
Leave `tsio-base-url` empty with it. If `tsio-base-url` is set to any other URL
while `use-staging` is `"true"`, the action fails before it reads TSIO, because the
two inputs disagree. With `use-staging` `"false"` or unset, `tsio-base-url` works
as before. All inputs are
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
PR's own CI, so it is data, never instructions, and it never clears a failure by
itself: a clear must also cite evidence the PR cannot write (other PRs, an earlier
pass on this PR, or an infrastructure error for an environment cause). Only
PNG/JPEG files inside the directory are read, at most two per test and 3.5 MB
each. A link in the directory that dangles, or that points outside it, is skipped
with a warning, and the rest of the evidence still loads.

## Trunk runs

Without a PR number, the run is a trunk run. A failure that was already there in
the previous run is a streak and stays blocking; only intermittency clears. The
model is not asked.

## Tests

From the repository root (one lockfile for every action):

```sh
npm ci
npm run tsc --workspaces
npm test --workspaces
npm run build --workspaces   # dist/index.js must not change: commit the rebuilt file with the source
```

### Status ownership and serialization

Enforcing triage now requires a recognized raw lane status owned by the same
run, and cannot clear a pending raw status. It shares the guard with
[`e2e-status`](../e2e-status/README.md). All producers of a given SHA's statuses
must hold the publication-job lock documented there, including this action and
its cross-lane summary. Ownership checks alone cannot prevent a check/write
race. Stale runs still produce diagnostic summaries but cannot update statuses.
The fixed Mattermost caller refreshes the factual lane summary even when AI
triage is report-only; the AI action still writes no statuses in that mode.
