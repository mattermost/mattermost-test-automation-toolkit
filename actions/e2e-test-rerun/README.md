# E2E test re-run

When a lane is red only because jobs sent no results (specs that did not run, reports that never arrived),
`e2e-test-triage` with `rerun-attempts` above 0 uploads a marker artifact instead of asking a person to re-run.
This action, called once the run has finished, re-runs the run's failed jobs when a marker for the run's current
attempt exists. The jobs that depend on them, triage included, run again, so the new attempt is triaged on its own
results. GitHub only re-runs a finished run, which is why this runs from a `workflow_run` listener and not from
triage itself.

The run's last attempt is never re-run: triage stops asking once `rerun-attempts` is used up, and `max-attempts`
is the backstop.

```yaml
name: E2E re-run
on:
  workflow_run:
    workflows: ["E2E"]
    types: [completed]
permissions:
  actions: write
jobs:
  rerun:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-24.04
    steps:
      - uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-rerun@main
        with:
          github-token: ${{ github.token }}
          run-id: ${{ github.event.workflow_run.id }}
          run-attempt: ${{ github.event.workflow_run.run_attempt }}
```

The listener checks out no code and reads only the run's artifact names, so it is safe for runs of fork pull requests.
