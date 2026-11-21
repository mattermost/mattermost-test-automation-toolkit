# E2E test stack: destroy

Destroys every attempt's batch of a run, checks that each one's hosts are gone, and destroys each again expecting
nothing to find. See the [shared README](../README.md) for the keys and setup every action relies on.

In order, the action:

1. Checks every input.
2. With `run-id` naming another run, reads that run and fails unless it ran one of `allowed-workflows`, on a branch
   `allowed-branches` matches whole, for one of `allowed-events`, from this repository rather than a fork, and has
   completed: a run still going may be testing against its batches. That run's latest attempt bounds the attempts
   read. With no `run-id`, it is this run and its attempt now.
3. Looks up the run's artifacts by name. Each attempt's own response, `e2e-test-stack-response-<batch>-<attempt>`, names that
   attempt's batch. The newest, `e2e-test-stack-create-<batch>`, stands in for an attempt whose own is missing or
   cannot be read. A batch must be exactly `<caller-key>-<run id>-<batch>-<attempt>-<suffix>` for the attempt its
   response is for.
4. Assumes `role-arn` with the job's GitHub OIDC token, once, when there is a batch to destroy.
5. For each batch, opens its token with `credentials-key`, masks every secret, and destroys it. It must come back
   `destroyed`, or `"not found"` when it was already gone. A batch this very attempt created, ready, must still have
   been up, unless it has passed its expiry and was reaped.
6. Waits, within `gone-window` seconds, for each site, its mail- host and any sso- host to answer the router's 404 for
   an unknown server.
7. Destroys the batch again, which must come back `"not found"`.

The batches are destroyed at once, and one batch's failure never keeps another up: every batch is tried, and the step
then fails listing each failure.
Outputs and the summary are written whatever happens.

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
| `run-id`            | The run whose batches to destroy. Default: this run                                                             |
| `allowed-workflows` | For another `run-id`: workflow files it may be of, `.github/workflows/<file>`, comma- or newline-separated      |
| `allowed-branches`  | For another `run-id`: a JavaScript regular expression its whole head branch must match, e.g. `main\|release-.*` |
| `allowed-events`    | For another `run-id`: events it may be for, comma-separated, e.g. `workflow_dispatch`                           |
| `gone-window`       | Seconds each host has to stop being served: `180` (the default) to `1800`                                       |
| `github-token`      | Token for api.github.com, to read the run and its artifacts. Default `github.token`                             |

## Outputs

| Output     | Description                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempts` | JSON array, one entry per attempt with a batch: `attempt`, `batch_id`, `state` (the destroy's reported state, such as `"destroyed"`, `"not found"` or `"partially_destroyed"`; `"unknown"` when a reply named none; `"not destroyed"` when no destroy answered or none was sent), `gone`, `again` (the second destroy's state, `"unknown"`, `"failed"` or `"not run"`) and `cost_usd` |
| `cost-usd` | The batches' estimated cost in USD; empty unless every batch the step destroyed had every server priced at a known rate                                                                                                                                                                                                                                                               |

## Examples

After the tests, in the run that created the batch:

```yaml
destroy:
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
    - uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/destroy@main
      with:
        caller-key: mobile
        batch: ios
        role-arn: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
        credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
```

By hand, for another run, from a `workflow_dispatch` workflow:

```yaml
- uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/destroy@main
  with:
    caller-key: mobile
    batch: ${{ inputs.batch }}
    role-arn: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
    credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
    run-id: ${{ inputs.run_id }}
    allowed-workflows: .github/workflows/e2e-detox-pr.yml
    allowed-branches: main|release-[0-9]+\.[0-9]+
    allowed-events: workflow_dispatch
```

The role decides the account: a batch created in another account is `"not found"` there, and its hosts, still up,
then fail the check that they are gone.

## Failures

The step fails, with the reason, on:

- an invalid input, or another run that is not allowed or has not completed;
- a create response that cannot be read, or that names a batch the run's attempt did not create;
- a batch whose token cannot be opened;
- a destroy that is refused, comes back neither `destroyed` nor `"not found"`, or reports an error;
- `"not found"` for a batch this attempt created ready, before its expiry;
- a host still served once `gone-window` has passed;
- a second destroy that finds the batch.

A batch it could not destroy is reaped at its TTL. Failure annotations have ARNs and account ids taken out.
