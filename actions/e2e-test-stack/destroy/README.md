# E2E test stack: destroy

Destroys every attempt's batch of this run, or one batch by its id, checks that each one's hosts are gone, and destroys
each again expecting nothing to find. See the [shared README](../README.md) for the keys and setup every action relies on.

In order, the action:

1. Checks every input. Exactly one of `batch` and `batch-id` is given: `batch` in the run that created the batch,
   `batch-id` by hand.
2. With `batch-id`, takes its run, batch and attempt from it. When that run is another, this job must have been started
   by hand (`workflow_dispatch`), and it fails unless that run is this repository's own, not a fork's, was started by
   hand too, has completed, and the attempt that made the batch was started by a person, the same one as this job. Its
   own response is read, never the newest, which a later attempt someone else started may have uploaded. A batch
   anyone else made, or an automated run made, is left to that run's own destroy, or to the reaper at its TTL. Without
   `batch-id`, it is this run, every attempt up to the one now.
3. Looks up the run's artifacts by name. Each attempt's own response, `e2e-test-stack-response-<batch>-<attempt>`,
   names that attempt's batch. The newest, `e2e-test-stack-create-<batch>`, stands in for an attempt whose own is
   missing or cannot be read. A batch must be exactly `<caller-key>-<run id>-<batch>-<attempt>-<suffix>` for the
   attempt its response is for, and with `batch-id`, exactly that batch.
4. Assumes `role-arn` with the job's GitHub OIDC token, once, when there is a batch to destroy.
5. For each batch, opens its token with `credentials-key`, masks every secret, and destroys it. It must come back
   `destroyed`, or `"not found"` when it was already gone. A batch this very attempt created, ready, must still have
   been up, unless it has passed its expiry and was reaped.
6. Waits, for up to 30 seconds, for each site, its mail- host and any sso- host to answer the router's 404 for
   an unknown server. A host still served after that is shown in the summary and the `gone` output, not a failure:
   the batch is destroyed, and the router stops serving it soon after. The hosts the create response names show a
   batch still up in another account, which this role cannot find; those the control plane's reply names from the
   batch's published leases cover any the response lacks.
7. Destroys the batch again, which must come back `"not found"`.

The batches are destroyed at once, and one batch's failure never keeps another up: every batch is tried, and the step
then fails listing each failure.
Outputs and the summary are written whatever happens.

## Permissions

The job needs `id-token: write`, to assume the role, and `actions: read`, for `github-token` to read the run and its
artifacts. The job that runs destroy must be defined in the repository's `e2e-test-stack-destroy.yml`, run on a branch
registered for it: the CI role trusts no other file. An E2E workflow calls it as a reusable workflow. Run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"` before the
action.

## Inputs

| Input             | Description                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caller-key`      | The repository's key in the control plane's `callers`, e.g. `mobile`, as `create` was given it. Required                                             |
| `batch`           | In the run that created the batch: the batch, e.g. `ios`, as `create` was given it. Give this or `batch-id`, not both                                |
| `batch-id`        | By hand: the one batch to destroy, e.g. `mobile-1234-ios-1-a1b2c3`. Another run's only by whoever started it by hand. Give this or `batch`, not both |
| `role-arn`        | The repository's CI role ARN in the account the batch was created in, as `create` was given it. Required                                             |
| `channel`         | `v1` (the default) or `edge`, as `create` was given it                                                                                               |
| `credentials-key` | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Required                                                                                            |
| `github-token`    | Token for api.github.com, to read the run and its artifacts. Default `github.token`                                                                  |

## Outputs

| Output     | Description                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempts` | JSON array, one entry per attempt with a batch: `attempt`, `batch_id`, `state` (the destroy's reported state, such as `"destroyed"`, `"not found"` or `"partially_destroyed"`; `"unknown"` when a reply named none; `"not destroyed"` when no destroy answered or none was sent), `gone`, `again` (the second destroy's state, `"unknown"`, `"failed"` or `"not run"`) and `cost_usd` |
| `cost-usd` | The batches' estimated cost in USD; empty unless every batch the step destroyed had every server priced at a known rate                                                                                                                                                                                                                                                               |

## Examples

After the tests, in the run that created the batch, as a job of `e2e-test-stack-destroy.yml` the E2E workflow calls:

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

## Cleaning up by hand

Re-running the destroy job of the run that created the batch is usually enough: it destroys every attempt's batch
still up. A batch from a run you started by hand can also be destroyed by its id, which create's summary and outputs
show, from a `workflow_dispatch` trigger in `e2e-test-stack-destroy.yml` that you start yourself. Nobody can destroy
by hand a batch someone else started, or one an automated run made: that run's own destroy releases it, or the
reaper at its TTL.

```yaml
- uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/destroy@main
  with:
    caller-key: mobile
    batch-id: ${{ inputs.batch_id }}
    role-arn: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
    credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
```

The batch's run must still hold its create response, which outlives the batch: an artifact is kept at least a day,
a batch at most four hours.

The role decides the account: a batch of this run created in another account is `"not found"` there, and its hosts,
still up, then fail the check that they are gone.

## Failures

The step fails, with the reason, on:

- an invalid input, or another run's `batch-id` in a job not started by hand;
- another run that is a fork's, was not started by hand, has not completed, or whose attempt that made the batch
  someone else started;
- a create response that cannot be read, or that names a batch the run's attempt did not create, or not the
  `batch-id` given;
- a batch whose token cannot be opened;
- a destroy that is refused, comes back neither `destroyed` nor `"not found"`, or reports an error;
- `"not found"` for a batch this attempt created ready, before its expiry;
- a second destroy that finds the batch.

A batch it could not destroy is reaped at its TTL. Failure annotations have ARNs and account ids taken out.
