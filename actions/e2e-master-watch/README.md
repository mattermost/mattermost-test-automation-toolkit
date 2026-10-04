# E2E master watch

Runs after a trunk (master) E2E run. It reads the run with the triage engine's
trunk rules (branch and commit come from what the run reported to TSIO) and asks a repair agent to fix only what repeats:

| Failure | Action |
| --- | --- |
| Failed in this run and the previous one (`BROKEN_ON_TRUNK`) | repair |
| Intermittent on trunk: failed in this run and at least once before (`FLAKY_ON_TRUNK`) | repair |
| Failed and then passed on retry in this run, and failed or flaked on trunk at least once before | repair (flaky) |
| Failed for the first time | wait for the next run |
| Run failed for environmental reasons | report only |

Broken specs whose failing tests last passed on the same commit most likely share
a cause, so they go to one agent in one request; each flaky spec goes alone. A
request carries the failing tests, their errors and history, the last trunk
commit where they all passed, the first one where they failed, and the commits
in between (oldest first). Broken requests go before flaky ones.

A spec is skipped when an open PR changes it or another file in its directory, or
when it was requested in the last `hold-hours` (its agent is still working, and
master E2E runs after every merge). Requests stop at `max-per-run` per run and `max-per-day` a
day, counting requests sent and repair PRs (label `e2e-master-repair`) opened. The
record of requests sent is kept between runs with `actions/cache`. Without a
webhook URL it only writes the job summary, so it can run report-only first.

The repair itself (reproduce, fix, verify several times, open the PR) is the
automation's job; its instructions live in the consumer repository, for example
`.cursor/automations/e2e-master-repair.md`.

```yaml
on:
  workflow_run:
    workflows: ["E2E Tests (master/release - merge)"]
    types: [completed]
    branches: [master]
jobs:
  watch:
    if: github.event.workflow_run.conclusion != 'cancelled'
    runs-on: ubuntu-24.04
    permissions: { contents: read, pull-requests: read }
    steps:
      - uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-master-watch@<full sha>
        with:
          repository: ${{ github.repository }}
          gh-run-id: ${{ github.event.workflow_run.id }}
          gh-run-attempt: ${{ github.event.workflow_run.run_attempt }}
          suites: '[{"name": "playwright-full-enterprise-master", "test_root": "e2e-tests/playwright/specs"}]'
          github-token: ${{ github.token }}
          cursor-webhook-url: ${{ secrets.CURSOR_E2E_REPAIR_WEBHOOK_URL }}
          cursor-webhook-key: ${{ secrets.CURSOR_E2E_REPAIR_WEBHOOK_KEY }}
```
