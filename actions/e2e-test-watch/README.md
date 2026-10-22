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
| Run failed for environmental reasons | report only |

Each broken spec has a break window: from its last trunk pass to its first trunk
failure. Broken specs whose windows overlap can't be told apart, so they go to one
agent in one request (an incomplete run can make one spec of a break show up a run
earlier or later than another); each flaky spec goes alone. A break whose window
overlaps one requested in the last `cause-hold-hours` waits, so its agent has time
to open its PR; after that the agent's own-PR skip or the next agent's check of
that PR takes over. A spec whose history can't be read waits for the next run. A
request carries the failing tests, their errors and history, the last trunk
commit where they all passed or were skipped behind a flag (a flaky run may be
where the break began, so it stays among the suspects), the
latest of their first failures, and the commits in between (oldest first). Broken
requests go before flaky ones. Every decision reads history only up to the run
it is about, so a later trunk run can't change it. A lane the run did not report,
and open PRs past the pages read, are named in the summary.

A spec is skipped when one of the agent's own open PRs (its `label`, or one found by
the agent's search) changes that exact spec file, or when it was requested in the last
`hold-hours` (its agent is still working, and trunk E2E runs after every merge). A
PR that changes another file in the spec's directory is not a reason to skip. An agent
PR with no update and no commit for more than `own-pr-idle-days` (3 by default) stops
skipping: the spec goes out, and the summary names the PR as stalled. If the agent's PRs
can't all be read, no fix request goes out that run. Other open PRs into trunk that
change it are not a reason to wait: they are mostly feature work, and in a month of
trunk history skipping on them would have left the largest break unfixed. They go to
the agent as `open_prs_touching`, so it can tell whether one of them already fixes the
failure. Fork PRs (from another repository) are dropped as soon as they are read: they
are not listed, and they never count as the agent's. Trunk stays red until a break is fixed, so
broken requests all go out on the run that finds them (`max-broken-per-run` is
only a safety limit); flaky requests share a budget of `max-flaky-per-day` in any
24 hours: specs not requested in the last week first, then most-flaky first, so a
spec that stays flaky doesn't take the budget every day. History is read only for
the specs that will be sent.

The agent also owns the PRs it opens. After each trunk run, an open PR with its
`label` that now conflicts with trunk gets a conflict request, so the agent merges
trunk in, resolves the conflict and re-verifies. Each PR head is sent once per
`hold-hours`; up to `max-conflicts-per-run` new ones per run.

The action never calls the agent. It writes the requests to `requests-file`
(`[{"id", "payload"}]`; a file, since a big break's payloads outgrow an environment
variable), and the consumer sends each payload wherever its agent listens, with its
own credentials. Then [`record`](record/action.yml) keeps the requests that were
accepted, between runs with `actions/cache`, so the next run holds them and counts
them toward the daily cap. Run `record` on every trunk run, even one that sent
nothing. If the cached record is not valid JSON the action fails instead of
forgetting what was sent; delete the `e2e-master-watch-*` caches to start over. The cache keys keep the action's former name on purpose: a new key would find no saved ledger and re-send its requests. The fix itself (reproduce, fix, verify several times, open the PR) is the
agent's job; its instructions live in the consumer repository.

The caller's job needs two settings that this action cannot set, and the example below has both:

- `concurrency`: a run reads the ledger when it starts and saves it when it ends. Two overlapping runs restore the same ledger, and the later save drops the other run's requests, so they are sent again. Queue the runs. The group must cover every run that can use the ledger; the example uses the repository, so all branches share one queue. Keep `cancel-in-progress: false`: a cancelled run that already sent requests but did not reach `record` would lose them.
- `cache-mode: write`: a `workflow_run` run is low-trust, so its caches are read-only by default. `record` then cannot save the ledger: the save is skipped with a log message and the job still passes, so nothing is kept and the next run sends the same requests again. `write` lets this job save caches into the default branch's scope. That is acceptable only while the job runs no code from pull requests: it reads the titles and file lists of this repository's open PRs through the API and sends them to the agent (fork PRs are dropped on read). Do not add steps that check out or run pull-request code under this setting.

```yaml
on:
  workflow_run:
    workflows: ["E2E Tests (master/release - merge)"]
    types: [completed]
jobs:
  autofix:
    if: github.event.workflow_run.conclusion != 'cancelled'
    runs-on: ubuntu-24.04
    concurrency:
      group: e2e-test-watch-${{ github.repository }}
      cancel-in-progress: false
    cache-mode: write
    permissions: { contents: read, pull-requests: read }
    steps:
      - id: plan
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-watch@<full sha>
        with:
          repository: ${{ github.repository }}
          gh-run-id: ${{ github.event.workflow_run.id }}
          gh-run-attempt: ${{ github.event.workflow_run.run_attempt }}
          suites: '[{"name": "playwright-full-enterprise-master", "test_root": "e2e-tests/playwright/specs"}]'
          github-token: ${{ github.token }}
          label: e2e-autofix
          instructions: .cursor/automations/e2e-autofix.md
      - id: send
        if: steps.plan.outputs.count != '0'
        env:
          REQUESTS_FILE: ${{ steps.plan.outputs.requests-file }}
          WEBHOOK_URL: ${{ secrets.AGENT_WEBHOOK_URL }}
          WEBHOOK_KEY: ${{ secrets.AGENT_WEBHOOK_KEY }}
        run: |
          results='[]'
          while IFS= read -r request; do
            id=$(jq -r '.id' <<<"$request")
            status=$(jq -c '.payload' <<<"$request" | curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
              -X POST "$WEBHOOK_URL" -H "Authorization: Bearer $WEBHOOK_KEY" -H 'Content-Type: application/json' \
              --data-binary @-) || true
            results=$(jq -c --arg id "$id" --arg status "${status:-0}" '. + [{id: $id, status: ($status | tonumber)}]' <<<"$results")
          done < <(jq -c '.[]' "$REQUESTS_FILE")
          echo "results=$results" >> "$GITHUB_OUTPUT"
      - if: always() && steps.plan.outcome == 'success'
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-watch/record@<full sha>
        with:
          results: ${{ steps.send.outputs.results || '[]' }}
```
