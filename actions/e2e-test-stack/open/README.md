# E2E test stack: open

Opens one server of this run's batch for a job that tests against it: its site URL and admin credentials, as masked
outputs. See the [shared README](../README.md) for the keys and setup every action relies on.

In order, the action:

1. Checks every input.
2. Lists this run's artifacts named `e2e-test-stack-create-<batch>`, which the `create` action uploads, and takes the
   newest, from whichever attempt made it.
3. Downloads it and reads the create response, `e2e-test-stack-create.json`.
4. Accepts the response only when its batch id is this run's batch: exactly
   `<caller-key>-<run id>-<batch>-<attempt>-<suffix>`, with the attempt from 1 to the run's attempt now, and the
   batch has not passed its expiry. A batch destroyed before its expiry is not detected here.
5. Opens the sealed secrets with `credentials-key` and masks every one (the batch token, each server's admin password,
   mail token and service credentials) before writing any output.
6. Sets the server at `index` as outputs, and every ready server as `instances`.

It calls GitHub only. It assumes no AWS role and calls nothing in the control plane, so it can run in the job that runs
the code under test. The batch token stays inside the action: no output carries it.

## Permissions

The job needs `actions: read`, for `github-token` to list and download the run's artifacts. Run
[`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"` before the action.

## Inputs

| Input             | Description                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `caller-key`      | The repository's key in the control plane's `callers`, e.g. `mobile`, as `create` was given it. Required            |
| `batch`           | The batch within the run, e.g. `ios`, as `create` was given it. Required                                            |
| `index`           | The server whose fields are set as their own outputs. Default `0`                                                   |
| `credentials-key` | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Required                                                           |
| `github-token`    | Token for api.github.com, to read this run's artifacts. Default `github.token`, which needs `actions: read` granted |

## Outputs

| Output           | Description                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-url`       | The server's site URL                                                                                                                                                                                                                    |
| `admin-username` | The server's admin username                                                                                                                                                                                                              |
| `admin-email`    | The server's admin email                                                                                                                                                                                                                 |
| `admin-password` | The server's admin password. Masked                                                                                                                                                                                                      |
| `mail-token`     | The server's Inbucket HTTP Basic password, user `inbucket`. Masked                                                                                                                                                                       |
| `instances`      | JSON array, index-aligned with the batch, `null` where a server is not ready: `site_url`, `state`, `admin_username`, `admin_email`, `admin_password`, `mail_token`, `credentials` (e.g. `postgres.password`) and `facts`. Secrets masked |
| `batch-id`       | The batch's id                                                                                                                                                                                                                           |

Outputs are for steps of the same job. A job that needs another server opens it with its own `index`.

## Example

```yaml
test:
  needs: create
  runs-on: ubuntu-24.04
  permissions:
    contents: read
    actions: read
  strategy:
    matrix:
      index: ${{ fromJSON(needs.create.outputs.indexes) }}
  steps:
    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version: "26"
    - id: server
      uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/open@main
      with:
        caller-key: mobile
        batch: ios
        index: ${{ matrix.index }}
        credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
    - run: ./run-tests.sh
      env:
        SITE_URL: ${{ steps.server.outputs.site-url }}
        ADMIN_USERNAME: ${{ steps.server.outputs.admin-username }}
        ADMIN_PASSWORD: ${{ steps.server.outputs.admin-password }}
```

## Failures

The step fails, with the reason, on:

- an invalid input;
- a run with no `e2e-test-stack-create-<batch>` artifact, or one that has expired, cannot be downloaded or read, or
  holds no create response;
- a response that is not JSON, names no batch, names a batch that is not this run's, or names one past its expiry;
- secrets that do not open with `credentials-key`;
- no ready server at `index`.

Whatever it has set by then (the batch id, `instances`) is written before the step fails. Failure
annotations have ARNs and account ids taken out.
