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
| `INFRA` | Mostly infrastructure errors, or 30+ failures | Each failure is judged as on any run; `ACTION_REQUIRED` while any still blocks |
| `OWNED_BY_PR` | The PR changed the failing spec | Blocking, never sent to the model |
| `INFRA_ERROR` | The test's own error is its environment (test server down, a proxy page instead of JSON) | Cleared with `infra-clears: true` (held on an `INFRA` run), otherwise blocking unless the model clears it |
| `BROKEN_ON_TRUNK` | Master's latest run fails it too | Cleared |
| `FLAKY_ON_TRUNK` | It is intermittent on master (see below) | Cleared |
| `FLAKY_CROSS_PR` | 3+ other PRs fail it with the same error, and master passes it | Cleared |
| `REGRESSION`, `INSUFFICIENT_DATA` | History can't clear it | Blocking, unless the model clears it with evidence |
| `SAME_FAILURE_AS_CLEARED` | Same spec and error as a test history cleared in this run | Cleared |

**Shard placeholders are not tests.** Some failed rows stand for a shard that
produced no results: a row with no test name; desktop's
`[<job name>] CI shard failure` in `ci/tsio-shard-failure.ts`
(`write-tsio-failure-stub.mjs`, after a job died or was cancelled); and mobile's
`spec did not run` with "<spec> was assigned to a shard but produced no result"
(`merge-jest-results-for-tsio.js`) and `CI infrastructure failure` in
`ci/<job>.stub` (its `write-tsio-failure-stub.mjs`). They are counted as failed but are not
findings: no test history is read for them, the model is not asked, and they do
not make the run an `INFRA` run. The lane stays red and the check says "re-run
the failed jobs", after the labels when the run also has real failures:
`(1 flaky; re-run the failed jobs) 85.7% passed (...)`.

A mobile `spec did not run` row is counted as "not run", not failed. When no spec
of its shard reported (the shard ran or uploaded nothing), or the row does not say,
it stays a placeholder and the shard is re-run. When other specs of its shard
reported (its Jest process stopped before reaching it), it is judged by its spec
file's own runs: `NOT_RUN` (blocking) when the change edits it, when that can't be
checked, or when its history can't be read. Otherwise it is `FLAKY_NOT_RUN`
(cleared, and the run can be green) when it also did not run in another recent run
and passed where it ran (at least `minTrunkRuns` runs, failing in at most 1 of 20),
or when it skipped every test in all its recent runs, and `NOT_RUN` when not.

A failure still blocking whose spec the base branch changed after the PR last
merged it is **out of date**: the PR ran its old copy of the test (for example
against an app build from the base branch). It stays blocking, the summary names
the base-branch commit that changed the test and says to merge the base branch,
and the model is not asked. One GitHub compare of the PR's commit with the base
branch finds these. GitHub lists at most 300 changed files per comparison. Past
that, a spec in the list is still out of date; for the rest, triage asks for the
base branch's newest commit in each failing spec's directory since the merge base
(up to the run's time, at most 20 directories). A commit there marks the failure
out of date with that commit; none leaves it to the usual rules. A spec no check
settled (over 20 directories, an error, a merge base with no date) stays blocking
as unchecked evidence (the summary says so), and the model is not asked about it.

**Flaky on master:** over master's last 50 runs (at least 5), failures plus
passes that needed a retry, plus 1, divided by the runs plus 2, is 0.05 or more,
and the latest run passed. One failure counts with 38 or fewer runs; two or more
always count. It clears the PR's failure only when master failed the same way:
a failure with an error to compare (a distinctive error, or a timeout's stuck
step) needs a master failure with that error (Mattermost's 26-character ids
masked). One master only failed another
way, or with nothing to compare (a hook timeout, no error), is a `REGRESSION`
for the model to judge. `BROKEN_ON_TRUNK` needs the same when every failure of
master's current streak has an error to compare. **Other PRs:** the last 200 PR
runs. These are starting values, set before any data was collected; the 7-week
replay found no wrong clear with them.

**Storm runs' failures are left out of history:** a past run where 30 or more
tests failed, and at least a tenth of its tests (TSIO counts a run over all its
reports: every OS of a desktop run, and retests), failed on its environment or a
shared break, and its failures say nothing about one test. Before the rules run,
each other run with a failed try in the history is read once, newest first (at
most 100, within 30 seconds); a storm's failed tries are left out, and so are
those of a run that can't be read in time. Kept: a pass in a storm, this PR's own
runs, and each test's current failing streak on master, which is a standing break
whatever its size (master's own triage still calls it broken, and a PR still sees
it as broken on master). A flaky run keeps the error of its failed try, so
master retrying past this same error counts as failing the same way. On mobile main, 201 of the 244 tests that
failed from 15 to 28 October failed only in 3 such runs, and each of those counted
as that test's flakiness.

**Failed everywhere is not cleared by a guess:** a test that failed every try here
(at least two) and failed on another platform of the same commit (iOS and Android,
Linux and Windows, or the enterprise and FIPS lanes) is never cleared by the model
or a same-failure match; the model may still name the PR. A flake rarely fails
every try on two platforms, and a change to shared code does. A rules clear stands
only where master or 3+ other PRs failed it the same way: that is their flake (a
desktop test master fails on two OSes). One that rests on nothing comparable (a
bare timeout) is held as `REGRESSION`, needs investigation. A break on master, an
environment error, and a spec the PR edits keep their own calls. Each condition
alone changes nothing: a test failing every try on one platform is often its
environment.

**Fixed on master:** master failed the test the same way in at least 3 runs in a
row and has passed since. That is a break master fixed, not a flake: a branch
without master's last failing commit is held as **fixed on main** ("The failure
first passed on master (#PR, date) after this PR last merged master"), and one
that has master's first passing commit goes to the model as a `REGRESSION`. If the base branch's commit list is cut off, it
stays unchecked.

**Re-runs:** a re-run uploads its jobs' reports again under the same names; the
newest report of a name replaces the earlier attempt's, so a shard that failed on
attempt 1 and passed on its re-run is read as passed.

**Checks triage doesn't cover:** the PR-wide check names any red E2E check under
its own prefix that is not one of `triage-lanes` (an upgrade or policy lane), e.g.
"triaged lanes green · not triaged: playwright-full/enterprise/upgrade-… red",
instead of saying all lanes are green. Its state is unchanged; that check's own
status still gates the PR.

**Environment errors:** `infra-clears: true` suits mobile and desktop, where the
PR changes an app that runs against a separate test server. Leave it off where
the PR can break the server itself (mattermost): there an unhealthy server may be
the change, so the test stays blocking and goes to the model, which clears it or
names the PR by the same bar as any other failure.

**A run flagged as a whole** (`INFRA`: at least half its failures are environment
errors, or 30 or more failed) is triaged test by test, and the model is asked. A
PR that breaks server startup fails every test on its environment, so on a
flagged run an environment error is held even with `infra-clears: true`: it stays
blocking until the model clears it, which it does only by citing the same failure
on another PR or a pass on an earlier commit of this PR, never on the error text
alone. Without the model (no key, over budget, an error) it stays blocking and the
run stays red as `ACTION_REQUIRED`. Once every failure is cleared the run is
`SUCCESS`; missing reports still keep it red.

**Release branches (CMT):** a run with no PR on a branch other than the default
(a release candidate's compatibility matrix) runs that branch's own copies of the
tests, which the default branch may have fixed since the branch was cut. Every
failure held there is checked against the default branch: one whose spec master
changed since the branch was cut is **out of date** ("master changed this test
(#PR, date) after release-6.3 branched from it, so this run used release-6.3's old
copy"; next step: backport the test change, or ignore it for this release). With
fewer than 5 earlier runs of its own, history is read from the default branch;
`history-lane` and `history-report` (a report-name prefix such as
`e2e-on-ubuntu-latest` for `e2e-on-ubuntu-latest-11.11.3`) make its runs match.
That history is another line of code: it is evidence, and never clears a failure on
the release branch by itself. A spec a stopped Jest process skipped stays `NOT_RUN`
there: the build never ran it.

**What kind of failure (release branches, with the model):** every failure still
held on a release branch's run is asked one question: is it an **app bug**, a
**test bug**, **flaky or environment**, or a **server compat** problem (it
depends on a server version)? The model gets the error, the test's code at the
failing line, its tries, the same test on every other lane of the run (each OS ×
server version), the history, and the default branch's commits to the test since
the branch was cut, with the file's diff. Its answer clears the failure only at 85%
confidence and only with the evidence its cause requires, checked in code: a test
bug cites the default branch's change to the test, with its diff; a server compat cites the other
lanes, where the test passes against another server version on this build; flaky
cites other PRs failing the same way or an infrastructure error (the history, which
may be another line of code, never carries it), and is never accepted for a test
that failed every try here and on every other lane. An app bug at 85% is named ("app bug") and stays red; anything
else stays red as needs investigation. The check names what was found:
`(1 test bug, 2 server compat, 1 app bug)`.

**Lanes the base branch rarely runs:** history is read per lane. A lane master
runs only sometimes (mattermost's subpath suite) has too little history to call
anything flaky; `history-lane` makes it read a lane with the same tests, such as
`playwright-full-enterprise`. Because a failure clears only with the same error,
a break specific to that lane still goes to the model.

**Failed on one platform only (common sense, with or without the model):** a
regression or a test with too little history is cleared as flaky when the same
commit shows the PR is not its cause. The same test passed on another platform of
the same commit (iOS against Android, Linux against macOS and Windows) and failed
on none, and **either**

- it passed on this platform earlier on this PR, and the PR itself changed
  nothing related since (a file merged in from the base branch, or one whose own
  patch is the same as at that pass, is the base branch's change, allowed while
  trunk's latest run of the test passed), **or**
- it passes on trunk (a regression), and the PR changes nothing it uses: not the
  spec, no file its error names.

A PR that breaks shared code fails every platform, so the pass elsewhere is what
rules the PR out. It never applies when the PR changes a file that reaches the
failing platform only (`ios/`, `Podfile.lock`, `android/`, `*.gradle`, a path
naming linux, windows or macos), to an environment error, or where no other
platform ran the test (mattermost's lanes are workers of one platform).

If the evidence is incomplete (changed files, test root, base branch, truncated
history, report scope, or a test whose identity is ambiguous), nothing is
cleared and the model is not asked. The same goes for the list of changes since
a test's last pass on the PR: a list GitHub cut off at 300 files cannot show that
nothing related changed, so it does not clear a failure.

If some of the run's reports never uploaded (a worker died), triage waits about
two minutes for them, then judges what arrived and says how many are missing.
Tests in reports that never arrived can't be vouched for, so that run never comes
out green.

## The model

Claude (Sonnet 5.5) is asked only about failures history couldn't settle. It
answers with a cause, the evidence it relied on and a confidence from 0 to 1 that
it rates itself against rules in the prompt: 0.9 or more when the evidence meets
the bar and nothing in the diff could touch the test, 0.6 to 0.85 when something
in the diff could, below 0.6 when the evidence is not enough. It clears a failure
only at `min-confidence` (0.85) or more **and** with a citation a reviewer can
open: other PRs failing the same way, or an earlier pass on this PR with nothing
related the PR changed since (for an environment cause, also an error that is
clearly infrastructural). What the test run recorded (`evidence-dir`) supports a
clear but never makes one alone, since the PR's own CI wrote it.

**The first failure in a chain:** a later test in a spec often fails only because
an earlier one's setup failed. Each question carries the earliest test of the
same spec that failed before it in this run with another error
(`earlier_failure_same_spec`: its title, its error's first line and its class).
Order is the tests' ordinals within one report; tests without them never chain.
For an environment cause it clears a `REGRESSION` or `INSUFFICIENT_DATA` failure
only when that earlier failure is an `INFRA_ERROR` **and** the same test passed on
another platform in this run: a PR that breaks the server fails every platform.
It never clears an environment error itself, which still needs other PRs or an
earlier pass on this PR.

The model can veto a history clear only at 0.9 with a related diff hunk. If the
model fails or is unavailable, the rules' outcome stands.

- Tests with the same spec and error share a question. Up to 24 questions per run
  are asked, 8 to a request: questions that can change the outcome first, then
  those that settle the most tests. A question the response leaves out is asked
  once more. Over 24, the rest keep the rules' outcome.
- `escalation-model` (off by default) asks a second model once about an answer just
  short of the threshold, or one that blames the PR without citing a change.
- A blocking failure the model has nothing to cite for is still asked
  (`ai-advice`), and its read is shown as advice. It never changes the outcome.
- Spend is priced per call and shown in the summary and the `ai-cost-usd`
  output. A request that could cross `ai-budget-usd` (1 per job) is not made, and
  neither is one past the lane's share of `pr-budget-usd` (2 per PR, split evenly
  between the lanes in `triage-lanes`, across all the PR's commits). Each request
  is checked on its own against what is left, so a big run gets the answers the
  budget allows. A model with no price (not in the built-in table or
  `AI_PRICES`) has no bounded cost, so it is not called; a budget that is not a finite amount of 0 or more is replaced by
  its default with a warning. A response that is not used (cut off, or served by
  another model) is still billed: it counts in the spend, and it is not retried.
- `answers-cache` lets a re-run reuse earlier answers and keeps the lane's spend
  on the PR. Persist it with `actions/cache` under a key with the lane and the PR
  number (see Usage); without it, only `ai-budget-usd` applies.

## What the PR shows

- **E2E check text**, in both modes: `(2 flaky, 2 caused by PR) 99.7% passed (1186
  passed, 4 failed, 164 skipped)`. The labels, each only when non-zero and in this
  order: flaky, broken on main, test bug, server compat, caused by PR, app bug, fixed on main, out of
  date, needs investigation (test bug, server compat and app bug only on a release branch). The
  rate is passed ÷ (passed + failed), as in
  mattermost's own E2E check; it never reads 100% while something failed.
  Shard placeholders add "re-run the failed jobs" after the labels (alone when
  every failure is one). A run flagged as a whole says why after the labels while
  any failure still blocks: "mostly environment errors, re-run" when at least half
  its failures are environment errors, or "many failures in one run" at 30 or
  more. Once every failure is cleared, the flag is gone.
  Enforce also sets the state (success only for `SUCCESS`); report-only keeps
  the state the check has, and writes nothing while it is still pending.
- **Job summary**, for a lane where something failed, a report is missing, or
  the lane is red with no failed test, shortest first: a one-line answer, then
  the failed tests in five fixed groups, one line each with why and the next step:
  - **Your PR**: the PR edits the test, changes a file its error names, or the
    model points to the PR's change. The model
    needs the same bar to name the PR as to clear a test: at least
    `min-confidence` and a change in the diff it can point to. A weaker guess
    stays under **Needs a look**.
  - **Out of date**: the base branch changed the test after this PR last merged
    it, so the PR ran its old copy; or it failed the same way on this PR's last
    commits and never on master, whose latest run passes it. Next step: merge
    master and re-run. The model is not asked.
  - **Needs a look**: nothing explains it yet. Next step: read the error before
    re-running (a real break can pass on a re-run).
  - **Broken on master**: master's latest run fails it too. The row names the PR
    merged between master's last pass and first failure (one compare call per
    break; several commits are listed, none blamed).
  - **Flaky**: intermittent on master, failing the same way on 3+ other PRs, or
    cleared by the model. No PR is named.

  A failed test that also failed on other platforms in the same run gets
  "Also failed on <platforms> in this run: likely environment or a shared
  cause" in its why, and the headline's line under it counts those tests. A
  failed try counts, even one a retry recovered (TSIO's `flaky`), and the
  wording says which: "Also failed on windows", "Also failed once on windows
  in this run (passed on retry)", or both for a mixed run. A pass does not
  count. The
  line and the count need no model; a test that failed every try here and failed
  on another platform may be held (see "Failed everywhere is not cleared by a guess"). The other platforms come
  from two places, and only for a run with failed tests: a desktop run's other
  OS reports, which sit in the same TSIO group (a report's name names its OS, as
  `e2e-on-ubuntu-latest` is linux), and a mobile run's sibling groups (one TSIO
  read each, at most five). Nothing is read for a run with nothing failed.

  **Not triaged** (a run a newer dispatch replaced, or one TSIO has no results
  for): the summary says so and why. A replaced run writes no status and exits
  0, since the newer run owns the lane. A run with no results keeps its lane's
  state and gets the note "(not triaged: no results)" where this run owns the
  status. Any other failure reads "triage could not finish" and exits 1.

  **Red with no failed test:** when the lane's own status is red and no test
  failed, the summary says a job outside the tests failed (setup, upload or
  runner) and to re-run the failed jobs. When reports are missing it also gives
  "N of M reports arrived". Triage writes no status for this lane: the lane's own
  status stands.

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
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-triage@<full sha>
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

## Automatic re-runs

`rerun-attempts` (default `0`, off) lets a lane that is red only because jobs sent no
results (a shard that reported nothing, reports that never arrived; no test blocks) be
re-run instead of asking a person to. While the run's attempt is within the allowance,
the check reads "re-running the failed jobs" and triage uploads a marker artifact; the
`e2e-test-rerun` action, called from a `workflow_run` listener once the run has
finished, re-runs the failed jobs, and the new attempt is triaged on its own results.
The last attempt says "re-run the failed jobs" as before. The `rerun` output says
whether this run asked, and the marker names the attempts the lane allows in all
(`rerun-attempts` + 1) for the listener.

Before asking, triage reads the run's failed and cancelled jobs (skipping jobs that
only report on the others) and each one's failed step and that step's last log
lines. A network, runner or host failure, or a setup step that failed or hung, is
re-run. A build failure, a test server that did not start, or dependencies that
did not install hold the re-run: the check reads `(not re-run: the build failed)`
and the summary quotes the line. A job neither settles (a test run that hung) is
asked of the model once per run; without an answer a person decides, as before.
The log is the job's own output and is never taken as an instruction. The triage
job needs `actions: read` to read the jobs; without it nothing is re-run
automatically.

## Step log

The step log has one line per finding: blocking or cleared, its class and decision, the
model's cause and confidence and what it cited (`-` when it was not asked), the test and
the reason.

## Findings file

`findings-file` (default `""`, off) names a JSON file the action writes after
every run: judged, superseded, with no results, or broken off. It is for measuring
how often triage's answers are right, so a consumer can join it to the verdicts
later. Nothing in it is a secret, and each error is only its first line (200
characters at most). Fields, in `schema` 2:

```json
{
  "schema": 2,
  "repository": "mattermost/mattermost", "commit_sha": "<sha>", "pr": 5,
  "lane": "playwright-full-enterprise", "status_context": "<context>",
  "run_id": "39637355358", "run_attempt": "1",
  "mode": "enforce | report-only",
  "verdict": "SUCCESS | FAILURE | ACTION_REQUIRED | null",
  "counts": { "total": 0, "passed": 0, "failed": 0, "flaky": 0, "skipped": 0 },
  "ai": { "calls": 0, "cost_usd": 0, "model": "claude-sonnet-5-5 | null" },
  "triaged": true,
  "not_triaged_reason": null,
  "findings": [{
    "title": "", "full_title": "", "file": "specs/a.spec.ts",
    "class": "REGRESSION", "label": "caused by PR", "blocking": true, "decision": "adjudicator_veto | null",
    "reason": "", "error_first_line": "", "out_of_date": false,
    "tries": { "ran": 1, "failed": 1 },
    "other_lanes_failed": ["android"],
    "ai": { "cause": "caused_by_pr | null", "confidence": 0.9, "cited": ["hunk_0"], "cleared": false, "explanation": "one or two sentences | null" }
  }]
}
```

- `mode` is the effective mode. For a run not triaged it is the requested mode,
  since the PR's label is not read.
- `triaged` is `true` exactly when `not_triaged_reason` is `null`. A run that is
  not triaged has `verdict: null` and no `counts`. It has `counts` only when TSIO
  was read.
- `not_triaged_reason` starts with `superseded:`, `no_results:` or `error:`.
- `ai.cost_usd` is `null` when a call's model is unpriced.
- `ai.cleared` is `true` when the model cleared the test; `ai.cited` lists the
  evidence it cited, and `ai.explanation` what it found (200 characters at most).
- `label` is what the E2E check counts the test as: flaky, broken on main, test
  bug, server compat, caused by PR, app bug, fixed on main, out of date, or needs
  investigation.
- Schema 2 added `label` and `ai.explanation`.

Consumers check `schema` first. A future change to the shape bumps it.

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
[`e2e-test-status`](../e2e-test-status/README.md). All producers of a given SHA's statuses
must hold the publication-job lock documented there, including this action and
its cross-lane summary. Ownership checks alone cannot prevent a check/write
race. Stale runs still produce diagnostic summaries but cannot update statuses.
The fixed Mattermost caller refreshes the factual lane summary even when AI
triage is report-only; the AI action still writes no statuses in that mode.
