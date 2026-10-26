# E2E test watch

Runs after a trunk (master) E2E run. It reads the run with the triage engine's
trunk rules (branch and commit come from what the run reported to TSIO) and plans a
fix only for what repeats:

| Failure | Action |
| --- | --- |
| Failed in this run and the previous one (`BROKEN_ON_TRUNK`) | fix |
| Intermittent on trunk: failed in this run and at least once before (`FLAKY_ON_TRUNK`) | fix |
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
agent's own PRs (its `label`) changes that exact file and was active in the last 3
days; if those PRs can't be read, nothing is requested. Other open PRs that change it
go to the agent as `open_prs_touching`; fork PRs are dropped on read. Breaks all go
out at once (`max-broken-per-run` is only a safety limit); flaky specs share
`max-flaky-per-day`, those not requested this week first. The agent's PRs that
later conflict with trunk are left to the PR's own automation (e.g. an
`AI/ConflictsBabysit` label in `extra-labels`).

The action never calls the agent: it writes `requests-file` (`[{"id", "payload"}]`),
the caller sends each payload with its own credentials, and [`record`](record/action.yml)
keeps the accepted ones in an `actions/cache` ledger for the next run. Run `record`
on every trunk run, even one that sent nothing. A ledger that is not valid JSON fails
the run; delete the `e2e-master-watch-*` caches to start over.

The caller's job needs two settings that this action cannot set:

- `concurrency`: a run reads the ledger when it starts and saves it when it ends. Two overlapping runs restore the same ledger, and the later save drops the other run's requests, so they are sent again. Queue the runs. The group must cover every run that can use the ledger. Keep `cancel-in-progress: false`: a cancelled run that already sent requests but did not reach `record` would lose them.
- `cache-mode: write`: a `workflow_run` run is low-trust, so its caches are read-only by default. `record` then cannot save the ledger: the save is skipped with a log message and the job still passes, so nothing is kept and the next run sends the same requests again. `write` lets this job save caches into the default branch's scope. That is acceptable only while the job runs no code from pull requests: it reads the titles and file lists of this repository's open PRs through the API and sends them to the agent (fork PRs are dropped on read). Do not add steps that check out or run pull-request code under this setting.

For a working caller, see [e2e-tests-autofix-on-merge.yml](https://github.com/mattermost/mattermost/blob/master/.github/workflows/e2e-tests-autofix-on-merge.yml) in mattermost/mattermost.
