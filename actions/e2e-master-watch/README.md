# E2E master watch

Runs after a trunk (master) E2E run. It reads the run with the triage engine's
trunk rules (branch and commit come from what the run reported to TSIO) and plans a
fix only for what repeats:

| Failure | Action |
| --- | --- |
| Failed in this run and the previous one (`BROKEN_ON_TRUNK`) | fix |
| Intermittent on trunk: failed in this run and at least once before (`FLAKY_ON_TRUNK`) | fix |
| Failed and then passed on retry in this run, and failed or flaked on trunk at least once before | fix (flaky) |
| Failed for the first time | wait for the next run |
| Run failed for environmental reasons | report only |

Broken specs whose failing tests last passed on the same commit most likely share
a cause, so they go to one agent in one request; each flaky spec goes alone. A
request carries the failing tests, their errors and history, the last trunk
commit where they all passed, the first one where they failed, and the commits
in between (oldest first). Broken requests go before flaky ones.

A spec is skipped when an open PR changes it or another file in its directory, or
when it was requested in the last `hold-hours` (its agent is still working, and
master E2E runs after every merge). Requests stop at `max-per-run` per run and
`max-per-day` a day, counting requests sent and PRs with the agent's `label`
opened.

The agent also owns the PRs it opens. After each trunk run, an open PR with its
`label` that now conflicts with trunk gets a conflict request, so the agent merges
trunk in, resolves the conflict and re-verifies. Each PR head is sent once per
`hold-hours`.

The action never calls the agent. It outputs `requests` (`[{"id", "payload"}]`),
and the consumer sends each payload wherever its agent listens, with its own
credentials. Then [`record`](record/action.yml) keeps the requests that were
accepted, between runs with `actions/cache`, so the next run holds them and counts
them toward the daily cap. Run `record` on every trunk run, even one that sent
nothing. The fix itself (reproduce, fix, verify several times, open the PR) is the
agent's job; its instructions live in the consumer repository.

```yaml
on:
  workflow_run:
    workflows: ["E2E Tests (master/release - merge)"]
    types: [completed]
jobs:
  autofix:
    if: github.event.workflow_run.conclusion != 'cancelled'
    runs-on: ubuntu-24.04
    permissions: { contents: read, pull-requests: read }
    steps:
      - id: plan
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-master-watch@<full sha>
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
          REQUESTS: ${{ steps.plan.outputs.requests }}
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
          done < <(jq -c '.[]' <<<"$REQUESTS")
          echo "results=$results" >> "$GITHUB_OUTPUT"
      - if: always() && steps.plan.outcome == 'success'
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-master-watch/record@<full sha>
        with:
          results: ${{ steps.send.outputs.results || '[]' }}
          gh-run-id: ${{ github.event.workflow_run.id }}
          gh-run-attempt: ${{ github.event.workflow_run.run_attempt }}
```
