# E2E test stack: logs

Collects the logs of every server still up in this run's batch, or in one batch by its id, and uploads them as one
artifact. See the
[shared README](../README.md) for the keys and setup every action relies on.

In order, the action:

1. Checks every input. Exactly one of `batch` and `batch-id` is given: `batch` in the run that created the batch,
   `batch-id` by hand.
2. With `batch-id`, takes its run, batch and attempt from it. When that run is another, this job must have been
   started by hand (`workflow_dispatch`), and it fails unless that run is this repository's own, not a fork's, was
   started by hand too, has completed, and the attempt that made the batch was started by a person, the same one as
   this job. Without `batch-id`, it is this run.
3. Reads the create response: with `batch-id`, that attempt's own, `e2e-test-stack-response-<batch>-<attempt>`, whose
   batch must be exactly the one named (in this run, the newest stands in when that one is missing); otherwise this
   run's newest, `e2e-test-stack-create-<batch>`, whose batch must be exactly `<caller-key>-<run id>-<batch>-<attempt>-
<suffix>`. A run with no batch has no logs.
4. Opens the batch's token with `credentials-key` and masks every secret.
5. Assumes `role-arn` with the job's GitHub OIDC token, and asks the control plane which servers are still up, ready
   or not. A batch already gone has no logs, and passes.
6. For each server, four at a time, asks for its logs and writes the tail. Unless the control plane says the tail is
   the whole log, it streams the full log over it in blocks of about 1 MiB of whole lines, at most 256 MiB within
   300 s. Every known secret, from the create response and the lookup, is taken out of both, with the account's id
   and any ARN.
7. Uploads the directory as `e2e-test-stack-logs-<batch>-<run attempt>`, or
   `e2e-test-stack-logs_<batch-id>-<run attempt>` for a batch named by its id, even when the step fails. No batch
   name holds a `_`, so the two never share a name, and neither meets `create`'s artifacts.

A server whose full log is not saved keeps its tail, and the step fails naming it. For a server that was not ready,
which may have no logs to give, that is noted in the summary instead. Outputs and the summary are written
whatever happens.

## Permissions

The job needs `id-token: write`, to assume the role, and `actions: read`, for `github-token` to read the run and its
artifacts. The job must be defined in the repository's `e2e-test-stack-destroy.yml` or `e2e-test-stack-create.yml`,
run on a branch registered for it: the CI role trusts no other file. Run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"` before the
action.

## Inputs

| Input             | Description                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caller-key`      | The repository's key in the control plane's `callers`, e.g. `mobile`, as `create` was given it. Required                                                        |
| `batch`           | In the run that created the batch: the batch, e.g. `ios`, as `create` was given it. Give this or `batch-id`, not both                                           |
| `batch-id`        | By hand: the one batch whose logs to collect, e.g. `mobile-1234-ios-1-a1b2c3`. Another run's only by whoever started it by hand. Give this or `batch`, not both |
| `role-arn`        | The repository's CI role ARN in the account the batch was created in, as `create` was given it. Required                                                        |
| `channel`         | `v1` (the default) or `edge`, as `create` was given it                                                                                                          |
| `credentials-key` | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Required                                                                                                       |
| `github-token`    | Token for api.github.com, to read the run and its artifacts. Default `github.token`                                                                             |

## Outputs

| Output          | Description                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers`       | JSON array, one entry per server that was up: `index`, `instance_id`, `path` (the full log, or its tail; empty when neither was saved), `full` and `containers` |
| `logs-dir`      | The directory holding `server-<index>.log` for each server; empty when none was saved                                                                           |
| `artifact-name` | The uploaded artifact's name; empty unless the upload succeeded                                                                                                 |

The artifact is kept 14 days.

## Example

After the tests, in the run that created the batch. The CI role trusts only `e2e-test-stack-create.yml` and
`e2e-test-stack-destroy.yml`, so the E2E workflow calls the latter as a reusable workflow for cleanup, and grants the
permissions its jobs ask for, which a called workflow can only lower:

```yaml
# The E2E workflow
jobs:
  # create, which calls e2e-test-stack-create.yml, and test …
  cleanup:
    needs: [create, test]
    if: always() && needs.create.result != 'skipped'
    permissions:
      contents: read
      actions: read
      id-token: write
    uses: ./.github/workflows/e2e-test-stack-destroy.yml
    with:
      batch: ios
    secrets: inherit
```

The reusable workflow collects the logs while the servers are up, then destroys the batch whatever the collection
did:

```yaml
# .github/workflows/e2e-test-stack-destroy.yml
on:
  workflow_call:
    inputs:
      batch: { type: string, required: true }

jobs:
  logs:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read
      id-token: write
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "26"
      - uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/logs@main
        with:
          caller-key: mobile
          batch: ${{ inputs.batch }}
          role-arn: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
          credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}

  destroy:
    needs: logs
    if: always()
    # … the destroy action, as its README shows
```

## Failures

The step fails, with the reason, on:

- an invalid input, or another run's `batch-id` in a job not started by hand;
- another run that is a fork's, was not started by hand, has not completed, or whose attempt that made the batch
  someone else started;
- a create response that cannot be read, or that names a batch the run did not create, or not the `batch-id` given;
- a batch whose token cannot be opened;
- a lookup of the servers that is refused for any reason but the batch being gone, or that reports an error;
- a ready server whose logs call is refused, finds no log, or whose full log is not saved.

Failure annotations have ARNs and account ids taken out.
