# E2E test stack

Creates remote Mattermost test servers for a repository's CI, and fetches, collects the logs of and destroys them,
through the e2e-test-stack control plane, and opens a create response's credentials in a test job that has no AWS
access: one AWS Lambda function per channel, `<project>-v1` (the promoted build) and
`<project>-edge` (`main`'s newest build). Each server is a short-lived stack (Mattermost, Postgres, Inbucket and any
optional services) reachable over HTTPS; a batch is reaped at its `ttl` (1h by default, 4h at most) if nothing
destroys it.

Four more operations call no control plane and need neither AWS credentials nor the credentials key; they do what a
stack workflow does around its calls ([Workflow operations](#workflow-operations)): `role` picks the AWS account and
its CI role, `server-image` names the server image to test, `check-run` checks a workflow run before its artifacts
are read, and `earlier-response` finds an earlier attempt's create response in a re-run.

## Keys and aliases

A repository is registered in the control plane's `callers` with a short **key** (for example `mobile`) and the
X25519 **public key** its secrets are sealed to. The action invokes only that repository's own alias,
`<project>-<channel>:<caller-key>-<channel>` (for example `e2e-test-stack-v1:mobile-v1`). The alias decides which
repository the call acts for; the request never names one. The plain `v1` and `edge` aliases are refused, and the
repository's CI role may invoke only its own aliases.

Nothing secret comes back in the clear. The batch token, each instance's admin password, mail token and service
credentials, and a logs call's URL and tail are sealed (libsodium `crypto_box_seal`) to the repository's public key.
The action opens them with the repository's credentials key, masks every secret, and sets them as outputs. `open`
does the same for a create response without calling anything, so a test job needs the credentials key but no AWS
role.

## Setup

1. **The credentials key.** The repository's credentials key is the base64 X25519 private key whose public half is
   registered as the caller's `recipient_public_key` in the control plane. Store it as a plain repository Actions
   secret, `E2E_TEST_STACK_CREDENTIALS_KEY`, not an environment secret: a job that names an environment gets an OIDC
   subject of `environment:<name>`, and the CI role trusts only branch subjects.
2. **The CI role.** `arn:aws:iam::<account>:role/e2e-test-stack-ci-<caller-key>`. It trusts jobs only on the branches
   registered for the repository, and only in these workflow files, so every call must be made from one of them:
   - `.github/workflows/e2e-test-stack-create.yml`
   - `.github/workflows/e2e-test-stack-destroy.yml`

   A repository with an existing E2E workflow makes both files reusable workflows (`on: workflow_call`) and calls
   them from it: create before its test matrix, destroy after. A called workflow's jobs carry the called file as
   `job_workflow_ref` and the caller's branch as subject, so the role trusts them. The calling job grants
   `id-token: write` and passes `E2E_TEST_STACK_CREDENTIALS_KEY`; a called workflow gets no more than that. The test
   jobs stay in the E2E workflow: each opens its server's credentials from the uploaded create response with `open`, which
   needs no AWS. See [Examples](#examples).

   The role trusts only the subject `repo:<owner>/<name>:ref:refs/heads/<branch>` with a matching `job_workflow_ref`,
   so `pull_request` runs are refused. Calls come from `push`, `schedule` or `workflow_dispatch` runs on a registered
   branch, in those two files.

3. **Permissions.** The job needs `id-token: write` to assume the role with
   [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials). The action uses
   the credentials the job holds; it assumes nothing itself.
4. **Session length.** The role's session lasts one hour. A job that runs long tests and then logs or destroys
   configures the credentials again right before those `if: always()` steps: the first session has expired by then,
   and destroy would fail with `ExpiredTokenException`, leaving the batch running until its TTL. A separate destroy
   job, as in the examples, starts its own session.
5. **Node.** The action runs on Node 26 or later, and fails before calling anything on an older one. The runner's
   default Node is older, so run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"`
   before it. That switches Node for the rest of the job, so a job that runs its tests on another version sets that
   version up again after the action, or calls the action from a job of its own.

## Secrets at rest

The response file `response-path` writes is safe to upload as an artifact: every secret in it is sealed.

`logs` downloads the full log and writes it to `logs-path`, with every value the action masks replaced with `***`. If
the full log is not saved (the download fails, or the tail is truncated and no URL came back), `logs-path` holds the
tail the response carried, and the step fails. The control plane returns the full log as a presigned S3 URL, sealed;
the action uses it only for the download, and no output, file or summary carries it.

## Inputs

| Input                   | Operations                                | Description                                                                                                                                                     |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`             | all                                       | `create`, `fetch`, `logs` or `destroy`, which call the control plane; `open`, `role`, `server-image`, `check-run` or `earlier-response`, which do not. Required |
| `caller-key`            | create, fetch, logs, destroy              | The repository's key in the control plane's `callers`. Required                                                                                                 |
| `channel`               | all                                       | `v1` (default) or `edge`. Use the channel the batch was created on                                                                                              |
| `project`               | all                                       | The control plane's project, the prefix of its function names. Default `e2e-test-stack`                                                                         |
| `region`                | all                                       | Default `us-east-1`                                                                                                                                             |
| `credentials-key`       | create, fetch, logs, open                 | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Also for destroy with `create-response`                                                                        |
| `response-path`         | all but open                              | Write the raw response JSON here. Its secrets are sealed, so it is safe to upload as an artifact                                                                |
| `instance-key`          | create                                    | Names the stack and prefixes its hostnames, e.g. `pr-1234`. Required                                                                                            |
| `server-image`          | create                                    | The server image under test, by tag. Required                                                                                                                   |
| `count`                 | create                                    | Instances in the batch; default 1, at most 40                                                                                                                   |
| `services`              | create                                    | Comma-separated: `minio` or `azurite`, `elasticsearch` or `opensearch`, `keycloak`, `openldap`                                                                  |
| `ttl`                   | create                                    | A duration such as `90m`; default `1h`, at most `4h`                                                                                                            |
| `os`                    | create                                    | OS variant, e.g. `ubuntu-24.04`                                                                                                                                 |
| `postgres`              | create                                    | Postgres version, e.g. `16`                                                                                                                                     |
| `license`               | create                                    | Licence SKU, e.g. `enterprise-advanced`; empty runs unlicensed                                                                                                  |
| `instance-type`         | create                                    | EC2 instance type; empty is sized by the control plane                                                                                                          |
| `server-env`            | create                                    | Server settings as a JSON object of strings, e.g. `{"MM_FEATUREFLAGS_TESTFEATURE":"true"}`; no credentials                                                      |
| `retries`               | create                                    | Attempts per failed instance; default 1, a negative number none, at most 3                                                                                      |
| `shared-admin-password` | create                                    | `true` gives every instance the same admin password                                                                                                             |
| `wait-for-migrations`   | create                                    | `true` waits for the server's migrations before an instance is ready                                                                                            |
| `caller-run-id`         | create                                    | Tagged on the batch for attribution. Default `github.run_id`                                                                                                    |
| `batch-id`              | fetch, logs, destroy                      | The batch, from create's `batch-id` output                                                                                                                      |
| `batch-token`           | fetch, logs, destroy                      | The batch's token, from create's `batch-token` output                                                                                                           |
| `create-response`       | fetch, logs, destroy, open                | Instead of `batch-id` and `batch-token`: a create response written by `response-path`; the token is opened from it with `credentials-key`. Required for open    |
| `indexes`               | fetch                                     | Comma-separated instance indexes; empty fetches the whole batch                                                                                                 |
| `index`                 | logs, open                                | logs: the instance whose logs to collect, default 0. open: the instance whose fields to set as `site-url`, `admin-username`, `admin-password` and `mail-token`  |
| `logs-path`             | logs                                      | Where to write the full log ([Secrets at rest](#secrets-at-rest)); default a file under `RUNNER_TEMP`                                                           |
| `expect-batch-prefix`   | fetch, logs, destroy, open                | With `create-response`: its batch id must start with this, e.g. `mobile-<run id>-`, or it is refused before anything is opened or called. Ends with a hyphen    |
| `verify-gone`           | destroy                                   | With `create-response`: `true` checks every host of the batch stops being served ([verify-gone](#verify-gone))                                                  |
| `gone-window`           | destroy                                   | With `verify-gone`: seconds each host has to stop being served; default 180, at most 1800                                                                       |
| `account`               | role                                      | `prod` or `dev`; empty or `recorded` takes only the account in `account-file`                                                                                   |
| `account-file`          | role                                      | The account a run's create recorded beside its response; used when the file exists                                                                              |
| `role-arn-prod`         | role                                      | The prod account's CI role ARN                                                                                                                                  |
| `role-arn-dev`          | role                                      | The dev account's CI role ARN                                                                                                                                   |
| `server`                | server-image                              | `master` (default), `latest` or `esr`                                                                                                                           |
| `github-token`          | server-image, check-run, earlier-response | Token for api.github.com. Default `github.token`; check-run and earlier-response need `actions: read`                                                           |
| `run-id`                | check-run, earlier-response               | check-run: the run to check. Required. earlier-response: the run to read; default this run                                                                      |
| `allowed-workflows`     | check-run                                 | Comma- or newline-separated workflow files the run may be of, e.g. `.github/workflows/e2e.yml`                                                                  |
| `allowed-branches`      | check-run                                 | A JavaScript regular expression the run's whole head branch must match, e.g. `master\|release-.*`                                                               |
| `allowed-events`        | check-run                                 | Comma-separated events the run may be for, e.g. `push, workflow_dispatch`                                                                                       |
| `artifact-name`         | earlier-response                          | The artifact holding the create response; default `e2e-test-stack-create`                                                                                       |
| `response-member`       | earlier-response                          | The artifact's file holding the create response; default `e2e-test-stack-create.json`                                                                           |
| `account-path`          | earlier-response                          | Where to write the account the artifact records; empty writes none                                                                                              |

An input that belongs to another operation is refused, as is any malformed value, before the control plane is called.

## Outputs

| Output               | Description                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch-id`           | The batch's id                                                                                                                                                                                                                                                                                                                                     |
| `batch-token`        | From create. The token fetch, logs and destroy need. Masked                                                                                                                                                                                                                                                                                        |
| `sites`              | JSON array of site URLs, index-aligned; `""` where an instance failed                                                                                                                                                                                                                                                                              |
| `instances`          | From create, fetch and open. JSON array, index-aligned, `null` where an instance failed or was not fetched: `site_url`, `state`, `admin_username`, `admin_email`, `admin_password`, `mail_token` (Inbucket's HTTP Basic password, user `inbucket`), `credentials` (e.g. `postgres.password`) and `facts` (e.g. `openldap.bind_dn`). Secrets masked |
| `site-url`           | From open with `index`. That instance's site URL                                                                                                                                                                                                                                                                                                   |
| `admin-username`     | From open with `index`. That instance's admin username                                                                                                                                                                                                                                                                                             |
| `admin-password`     | From open with `index`. That instance's admin password. Masked                                                                                                                                                                                                                                                                                     |
| `mail-token`         | From open with `index`. That instance's Inbucket HTTP Basic password, user `inbucket`. Masked                                                                                                                                                                                                                                                      |
| `ready`              | How many instances are ready                                                                                                                                                                                                                                                                                                                       |
| `state`              | The batch's state: `ready` or `failed` from create, and from open as it was created; `found` from fetch, which rebuilds the batch from its live instances (`ready` counts those ready); `destroyed`, `partially_destroyed`, `destroy_failed` or `not found` from destroy                                                                           |
| `error`              | The control plane's error for a call that still returned a batch; empty otherwise                                                                                                                                                                                                                                                                  |
| `deployment-version` | The Lambda version that answered                                                                                                                                                                                                                                                                                                                   |
| `duration-seconds`   | From create. Seconds from the request to every server ready, as the control plane measured it; empty when a server failed                                                                                                                                                                                                                          |
| `cost-usd`           | From destroy. The batch's estimated cost in USD; empty unless every server was destroyed and priced at a known rate                                                                                                                                                                                                                                |
| `logs-path`          | From logs. The full log, or the tail if it did not download; empty when there was none                                                                                                                                                                                                                                                             |
| `logs-full`          | From logs. `true` when `logs-path` holds the whole log, `false` when only a truncated tail                                                                                                                                                                                                                                                         |
| `response-path`      | Where `response-path` was written; from earlier-response, only when found                                                                                                                                                                                                                                                                          |
| `account`            | From role. `prod` or `dev`                                                                                                                                                                                                                                                                                                                         |
| `role-arn`           | From role. That account's CI role ARN                                                                                                                                                                                                                                                                                                              |
| `server-image`       | From server-image. The image, e.g. `mattermost/mattermost-enterprise-edition:11.1.2`                                                                                                                                                                                                                                                               |
| `server-version`     | From server-image. The release, `X.Y.Z`, or `master`                                                                                                                                                                                                                                                                                               |
| `found`              | From earlier-response. `true` when the run holds the artifact and its response was written, `false` when it holds none or its response names no batch                                                                                                                                                                                              |

Masked values are redacted from the job's logs. GitHub does not pass a job output that holds a masked value to
another job, so `batch-token`, `instances` and the fields `open` sets are for steps of the same job. To reach a later
job or run, upload the create response and pass it to `create-response`: `open` reads a server's credentials from it,
and fetch, logs and destroy the batch's token.

## Failures

The step fails on an invalid input, a call the control plane refuses (its message is shown), secrets that do not open
with `credentials-key`, an `error` in the response, and a `response-path` that cannot be written. A partial create
(`1 of 2 instances failed: [1]`) still returns its batch: the outputs, and `response-path` when it could be written,
are set before the step fails, so a teardown with `if: always()` can destroy it. The control plane's messages are
shown with ARNs and account ids taken out. A destroy of a batch that is already gone succeeds with `state` `not found`.
`open` with an `index` fails for an instance that is not ready, and names the create response it could not read or
open.

Cancelling the job while a create is waiting leaves the batch running until its TTL: the action never received its
batch id, so nothing can destroy it.

## Workflow operations

These call no control plane, open no secret and need no AWS credentials.

**`role`** picks the account a job runs in and its CI role, and sets `account` and `role-arn` for
`aws-actions/configure-aws-credentials`. The account is the one recorded in `account-file` when that file exists (a
create records it beside its response), otherwise `account`. A recorded account that is not `prod` or `dev` fails
without quoting the file; a recorded account and a `prod` or `dev` input that differ fail; with neither, the step fails
asking for `account`. An empty `role-arn-<account>` fails rather than fall back to the other account's role.

**`server-image`** sets `server-image` and `server-version`. `master` is
`mattermostdevelopment/mattermost-enterprise-edition:master` and reads nothing. `latest` is
`mattermost/mattermost-enterprise-edition:<X.Y.Z>`, the highest stable release of `mattermost/mattermost`: not a draft
or prerelease, and a tag with no suffix such as `-rc1`. `esr` is the newest patch of the newest minor whose stable
releases' notes say "extended support release", in any case, as Matterwick decides it.

**`check-run`** reads `run-id` in this repository and fails unless it ran one of `allowed-workflows`, on a head branch
`allowed-branches` matches whole, for one of `allowed-events`, from this repository rather than a fork:
`run 42 is not an allowed run: <path> on <branch> (<event>) from <repository>`. Run it before reading another run's
artifacts, so a pull request's artifact of the same name is never read. `head_branch` is what GitHub reports for the
run, so a tag named like an allowed branch matches too; callers rely on their CI role trusting only branch refs, and on
`expect-batch-prefix`.

**`earlier-response`** is for a re-run of a create job, whose earlier attempt's batch would otherwise be left running
and its response overwritten. It looks for this run's (or `run-id`'s) artifact `artifact-name`; with none, `found` is
`false`. Any file already at `response-path` or `account-path` is removed first, so a later step never reads a stale
one. With an artifact, it downloads it, writes its `response-member` to `response-path`, and sets `found` to `true`. With
`account-path`, it also writes the account the artifact records (`e2e-test-stack-account`) there; an account that is
missing or cannot be read is skipped with a warning, and `role` then decides the account from its own inputs. A
response that names no batch, as a refused create leaves, has nothing to release: `found` is `false`, with a warning.
An artifact that exists but cannot be downloaded or read, has expired, has no `response-member`, or holds a response
that is not JSON, fails the step, so a caller never loses an earlier batch by creating another.

Their GitHub calls are tried up to four times, each attempt within 60 seconds: again after 10, 20 and 30 seconds on a
server error, a timeout or a network error, and after 60 seconds on a 429 or a secondary rate limit. Any other failure,
such as a 404, an auth error or the primary rate limit, is final. A step that gives up lists every attempt's error.

### verify-gone

`destroy` with `create-response` and `verify-gone: true` checks that the batch has stopped serving, once it is
`destroyed` or `not found`: each site's `/api/v4/system/ping`, its `mail-` host, and the `sso-` host of each instance
created with Keycloak, all read from the create response and probed with the site's protocol. Only the router's 404 for an unknown test server ("No test
server for this hostname") passes. Anything else, a 502 (the instance is still known), a 503 (the lookup could not run),
a refused or timed-out request, is tried again every 5 seconds until `gone-window` seconds have passed; every host is
probed at once. The step fails listing each host still served with its last answer, after the outputs are set. A batch
with no launched instance has no host to probe, and passes; any other state fails without probing.

### expect-batch-prefix

A workflow that reads a create response from an artifact passes `expect-batch-prefix` with what its own create named
the batch with, such as `mobile-${{ github.run_id }}-`. A response whose batch id does not start with it, one copied
in from another run, is refused before its secrets are opened or the control plane is called.

## Examples

An E2E workflow that creates three servers, runs its tests against each in a matrix, and destroys them. Only the two
called files make AWS calls; the test jobs open their credentials with `open`.

```yaml
# .github/workflows/e2e-tests.yml: the repository's E2E workflow, any name
name: E2E tests
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  stack:
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/e2e-test-stack-create.yml
    with:
      count: "3"
    secrets:
      E2E_TEST_STACK_CREDENTIALS_KEY: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
  test:
    needs: stack
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        index: ${{ fromJSON(needs.stack.outputs.indexes) }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # Node 26 for the action, then the suite's own Node for the tests.
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "26"
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: e2e-test-stack-create
          path: ${{ runner.temp }}/create
      - id: server
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack@main
        with:
          operation: open
          credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
          create-response: ${{ runner.temp }}/create/e2e-test-stack-create.json
          index: ${{ matrix.index }}
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
      - run: npm ci
      - name: Run tests
        env:
          SITE_URL: ${{ steps.server.outputs.site-url }}
          ADMIN_USERNAME: ${{ steps.server.outputs.admin-username }}
          ADMIN_PASSWORD: ${{ steps.server.outputs.admin-password }}
        run: npm run e2e
  destroy:
    needs: [stack, test]
    if: always() && needs.stack.outputs.batch-id != ''
    # A called workflow gets no more than this; actions: read lets it read another run's artifact when run by hand.
    permissions:
      actions: read
      contents: read
      id-token: write
    uses: ./.github/workflows/e2e-test-stack-destroy.yml
    secrets:
      E2E_TEST_STACK_CREDENTIALS_KEY: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
```

```yaml
# .github/workflows/e2e-test-stack-create.yml: creates the batch and uploads its sealed response
name: E2E test stack create
on:
  workflow_call:
    inputs:
      count:
        type: string
        default: "1"
    outputs:
      batch-id:
        value: ${{ jobs.create.outputs.batch-id }}
      indexes:
        value: ${{ jobs.create.outputs.indexes }}
    secrets:
      E2E_TEST_STACK_CREDENTIALS_KEY:
        required: true
jobs:
  create:
    runs-on: ubuntu-24.04
    outputs:
      batch-id: ${{ steps.stack.outputs.batch-id }}
      indexes: ${{ steps.indexes.outputs.indexes }}
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "26"
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::<account>:role/e2e-test-stack-ci-mobile
          aws-region: us-east-1
      - id: stack
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack@main
        with:
          operation: create
          caller-key: mobile
          credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
          instance-key: main-${{ github.run_number }}-${{ github.run_attempt }}
          server-image: mattermostdevelopment/mattermost-enterprise-edition:master
          count: ${{ inputs.count }}
          response-path: ${{ runner.temp }}/e2e-test-stack-create.json
      # Its secrets are sealed, so it is safe to upload.
      - if: always() && steps.stack.outputs.response-path != ''
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: e2e-test-stack-create
          path: ${{ steps.stack.outputs.response-path }}
      # One test job per server. A partial create fails this job before it, so the tests are skipped and destroy runs.
      - id: indexes
        env:
          SITES: ${{ steps.stack.outputs.sites }}
        run: echo "indexes=$(jq -c '[to_entries[] | select(.value != "") | .key]' <<< "$SITES")" >> "$GITHUB_OUTPUT"
```

```yaml
# .github/workflows/e2e-test-stack-destroy.yml: called after the tests, or run by hand with a run id
name: E2E test stack destroy
on:
  workflow_call:
    secrets:
      E2E_TEST_STACK_CREDENTIALS_KEY:
        required: true
  workflow_dispatch:
    inputs:
      run-id:
        description: The run that created the batch
        required: true
permissions:
  actions: read
  id-token: write
jobs:
  destroy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: e2e-test-stack-create
          run-id: ${{ inputs.run-id || github.run_id }}
          github-token: ${{ github.token }}
          path: ${{ runner.temp }}/create
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "26"
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::<account>:role/e2e-test-stack-ci-mobile
          aws-region: us-east-1
      - uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack@main
        with:
          operation: destroy
          caller-key: mobile
          channel: v1
          credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
          create-response: ${{ runner.temp }}/create/e2e-test-stack-create.json
```

The response does not record the channel, so a destroy, fetch or logs call sets `channel` to the one that created the
batch (`v1` unless the create said otherwise). `logs` collects one instance's logs per call, from the same destroy job
before it destroys. Re-run all jobs, not only the failed ones: destroy has already released the batch the failed jobs
would open.

A create waits for its instances, usually two to four minutes and at most 15; the client waits up to 960 seconds for
the reply. A throttled call (the channel's reserved concurrency is in use) is tried again up to five times; no other
failure is retried, so a create is never made twice.
