# E2E test watch

Runs after a trunk (master) E2E run. It reads the run with the triage engine's
trunk rules (branch and commit come from what the run reported to TSIO) and plans a
fix only for what repeats:

| Failure | Action |
| --- | --- |
| Failed in this run and the previous one (`BROKEN_ON_TRUNK`) | fix |
| Intermittent on trunk: failed in this run; trunk failed or flaked it in about 1 in 20 runs before, with the same error where the error names its cause (`FLAKY_ON_TRUNK`; see [trunk runs](../e2e-test-triage/README.md#trunk-runs)) | fix |
| Failed in this run, and trunk failed or flaked it too rarely, or with another error (`REGRESSION`); or failed every try here and on another platform of this commit, held (`failed_everywhere`); or trunk has too little history to say (`INSUFFICIENT_DATA`) | as a first failure: wait for the next run |
| Failed and then passed on retry in this run, and failed or flaked on trunk at least once before | fix (flaky) |
| Failed for the first time in two or more lanes (suites) of the same run, e.g. enterprise and FIPS | fix (broken) |
| Failed for the first time, in one lane | wait for the next run |
| Half or more of the lane's failures are environment errors | report only: re-run |
| 30 or more tests failed in the lane | report only: one shared cause is likely, so a person looks first |

Broken specs whose break windows (last trunk pass to first trunk failure) overlap
can't be told apart, so they go to one agent in one request; each flaky spec goes
alone. A request carries the failing tests, their errors and trunk history, and the
suspect commits: from the last commit where every failing test passed (or was
skipped behind a flag) to the latest of their first failures. History is read only
up to the run being watched, and only for the specs that will be sent. A break whose
suspect commits overlap a request sent in the last `cause-hold-hours` (4) waits for
that agent's PR instead of getting a second request.

A spec is not requested within 24 hours of its last request, or while one of the
agent's own PRs (its `label`) changes that exact file, was opened in the last 2 days
and was active in the last 3; if those PRs can't be read, nothing is requested. An
older (or idle) agent PR whose spec still fails stops blocking it, however much
review it gets: the spec is requested again, at most every 3 days, with that PR in
`open_prs_touching` for the agent to judge. Other open PRs that change it
go to the agent as `open_prs_touching`; fork PRs are dropped on read. Breaks all go
out at once (`max-broken-per-run` is only a safety limit); flaky specs share
`max-flaky-per-day`, those not requested this week first. The agent's PRs that
later conflict with trunk are left to the PR's own automation (e.g. an
`AI/ConflictsBabysit` label in `extra-labels`).

A webhook can accept a request (HTTP 200) whose agent then never starts. The agent
answers each request it runs on GitHub: its PR, or its comment or review on an
existing PR, links the request's trunk run and names the spec. A request still held
after `answer-hours` (6) is checked for such an answer: one text (a body, comment,
review or review comment) that links its run and names one of its specs. The texts
read are those of the PRs and issues search finds citing the run, the open PRs the
request was sent with (`open_prs_touching`, kept on its ledger entry, where a review
search doesn't index still counts), and the agent's PRs opened since. No PR's file
list is read. With no answer, and no agent PR on its specs opened since, it holds
nothing (no spec, no break, no flaky budget): its specs are requested again, once.
The resend then holds as any request does, so a run that ends in no change (the
agent's no-op leaves no trace either) is not sent a third time. A missed answer
costs at most that one extra agent run, which stops early on its memory of the
first. Requests hold as sent when the check can't tell: GitHub can't be read, its
search is incomplete, more than 20 PRs and issues cite the run, more than 20 PRs are
to be read besides, or a PR read without an answer has more comments or reviews than
the read holds. A request sent before its PRs were kept is checked by search and the
agent's PRs alone.

A re-run attempt re-runs only the failed jobs, so each suite is read at its newest
attempt up to `gh-run-attempt`. The job summary also names what no request covers:
failing tests that wait (a first failure in one lane, a first flake, a name two tests
share), and suites outside `suites` that failed in the run (another framework, a
subpath or upgrade lane). Add a suite to `suites` only when the agent can reproduce it.

The action never calls the agent: it writes `requests-file` (`[{"id", "payload"}]`),
the caller sends each payload with its own credentials, and [`record`](record/action.yml)
keeps the accepted ones in an `actions/cache` ledger for the next run. Run `record`
on every trunk run, even one that sent nothing. A ledger that is not valid JSON fails
the run; delete the `e2e-master-watch-*` caches to start over.

The caller's job needs two settings that this action cannot set:

- `concurrency`: a run reads the ledger when it starts and saves it when it ends. Two overlapping runs restore the same ledger, and the later save drops the other run's requests, so they are sent again. Queue the runs. The group must cover every run that can use the ledger. Keep `cancel-in-progress: false`: a cancelled run that already sent requests but did not reach `record` would lose them.
- `cache-mode: write`: a `workflow_run` run is low-trust, so its caches are read-only by default. `record` then cannot save the ledger: the save is skipped with a log message and the job still passes, so nothing is kept and the next run sends the same requests again. `write` lets this job save caches into the default branch's scope. That is acceptable only while the job runs no code from pull requests: it reads the titles and file lists of this repository's open PRs through the API and sends them to the agent (fork PRs are dropped on read). Do not add steps that check out or run pull-request code under this setting.

For a working caller, see [e2e-tests-autofix-on-merge.yml](https://github.com/mattermost/mattermost/blob/master/.github/workflows/e2e-tests-autofix-on-merge.yml) in mattermost/mattermost.
