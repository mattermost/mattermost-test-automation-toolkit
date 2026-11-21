# E2E test stack: logs

Collects the logs of every server still up in a run's batch and uploads them as one artifact. See the
[shared README](../README.md) for the keys and setup every action relies on.

In order, the action:

1. Checks every input.
2. With `run-id` naming another run, reads that run and fails unless it ran one of `allowed-workflows`, on a branch
   `allowed-branches` matches whole, for one of `allowed-events`, from this repository rather than a fork, and has
   completed. With no `run-id`, it is this run.
3. Reads the run's newest create response, `e2e-test-stack-create-<batch>`. Its batch must be exactly
   `<caller-key>-<run id>-<batch>-<attempt>-<suffix>`, from an attempt of the run. A run with no batch has no logs.
4. Opens the batch's token with `credentials-key` and masks every secret.
5. Assumes `role-arn` with the job's GitHub OIDC token, and asks the control plane which servers are still up, ready
   or not. A batch already gone has no logs, and passes.
6. For each server, four at a time, asks for its logs and writes the tail. Unless the control plane says the tail is
   the whole log, it streams the full log over it in blocks of about 1 MiB of whole lines, at most 256 MiB within 300 s. Every known
   secret, from the create response and the lookup, is taken out of both, with the account's id and any ARN.
7. Uploads the directory as `<artifact-prefix>-<batch>-<run attempt>`, or
   `<artifact-prefix>-<batch>-run-<run-id>-<run attempt>` for another run, even when the step fails.

A server whose full log is not saved keeps its tail, and the step fails naming it. For a server that was not ready,
which may have no logs to give, that is noted in the summary instead. Outputs and the summary are written
whatever happens.

## Permissions

The job needs `id-token: write`, to assume the role, and `actions: read`, for `github-token` to read the run and its
artifacts. Run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"` before the
action.

## Inputs

| Input               | Description                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `caller-key`        | The repository's key in the control plane's `callers`, e.g. `mobile`, as `create` was given it. Required        |
| `batch`             | The batch within the run, e.g. `ios`, as `create` was given it. Required                                        |
| `role-arn`          | The repository's CI role ARN in the account the batch was created in, as `create` was given it. Required        |
| `channel`           | `v1` (the default) or `edge`, as `create` was given it                                                          |
| `credentials-key`   | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Required                                                       |
| `run-id`            | The run whose batch's logs to collect. Default: this run                                                        |
| `allowed-workflows` | For another `run-id`: workflow files it may be of, `.github/workflows/<file>`, comma- or newline-separated      |
| `allowed-branches`  | For another `run-id`: a JavaScript regular expression its whole head branch must match, e.g. `main\|release-.*` |
| `allowed-events`    | For another `run-id`: events it may be for, comma-separated, e.g. `workflow_dispatch`                           |
| `artifact-prefix`   | Starts the artifact's name. Default `e2e-test-stack-logs`                                                       |
| `github-token`      | Token for api.github.com, to read the run and its artifacts. Default `github.token`                             |

## Outputs

| Output          | Description                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers`       | JSON array, one entry per server that was up: `index`, `instance_id`, `path` (the full log, or its tail; empty when neither was saved), `full` and `containers` |
| `logs-dir`      | The directory holding `server-<index>.log` for each server; empty when none was saved                                                                           |
| `artifact-name` | The uploaded artifact's name; empty when nothing was uploaded                                                                                                   |

The artifact is kept 14 days.

## Example

After the tests and before the destroy, in the run that created the batch:

```yaml
logs:
  needs: [create, test]
  if: always() && needs.create.result != 'skipped'
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
        batch: ios
        role-arn: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
        credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
```

A `destroy` job then `needs: logs`, so the servers are still up while their logs are collected.

## Failures

The step fails, with the reason, on:

- an invalid input, or another run that is not allowed or has not completed;
- a create response that cannot be read, or that names a batch the run did not create;
- a batch whose token cannot be opened;
- a lookup of the servers that is refused for any reason but the batch being gone, or that reports an error;
- a ready server whose logs call is refused, finds no log, or whose full log is not saved.

Failure annotations have ARNs and account ids taken out.
