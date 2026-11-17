# E2E test stack

Creates remote Mattermost test servers for a repository's CI, and fetches, collects the logs of and destroys them,
through the e2e-test-stack control plane: one AWS Lambda function per channel, `<project>-v1` (the promoted build) and
`<project>-edge` (`main`'s newest build). Each server is a short-lived stack (Mattermost, Postgres, Inbucket and any
optional services) reachable over HTTPS; a batch is reaped at its `ttl` (1h by default, 4h at most) if nothing
destroys it.

## Keys and aliases

A repository is registered in the control plane's `callers` with a short **key** (for example `mobile`) and the
X25519 **public key** its secrets are sealed to. The action invokes only that repository's own alias,
`<project>-<channel>:<caller-key>-<channel>` (for example `e2e-test-stack-v1:mobile-v1`). The alias decides which
repository the call acts for; the request never names one. The plain `v1` and `edge` aliases are refused, and the
repository's CI role may invoke only its own aliases.

Nothing secret comes back in the clear. The batch token, each instance's admin password, mail token and service
credentials, and a logs call's URL and tail are sealed (libsodium `crypto_box_seal`) to the repository's public key.
The action opens them with the repository's private key, masks every secret, and sets them as outputs.

## Setup

1. **The private key.** Store the repository's base64 X25519 private key as a plain repository Actions secret,
   `E2E_STACK_PRIVATE_KEY`, not an environment secret: a job that names an environment gets an OIDC subject of
   `environment:<name>`, and the CI role trusts only branch subjects.
2. **The CI role.** `arn:aws:iam::<account>:role/e2e-test-stack-ci-<caller-key>`. It trusts jobs only on the branches
   registered for the repository, and only in these workflow files, so every call must be made from one of them:
   - `.github/workflows/e2e-test-stack-create.yml`
   - `.github/workflows/e2e-test-stack-destroy.yml`

   The role trusts only the subject `repo:<owner>/<name>:ref:refs/heads/<branch>` with a matching `job_workflow_ref`,
   so `pull_request` runs are refused. Calls come from `push`, `schedule` or `workflow_dispatch` runs on a registered
   branch, in those two files.

3. **Permissions.** The job needs `id-token: write` to assume the role with
   [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials). The action uses
   the credentials the job holds; it assumes nothing itself.
4. **Session length.** The role's session lasts one hour. Configure the credentials again right before the
   `if: always()` logs and destroy steps: after a long test run the first session has expired, and destroy would fail
   with `ExpiredTokenException`, leaving the batch running until its TTL.
5. **Node.** The action runs on Node 26 or later, and fails before calling anything on an older one. The runner's
   default Node is older, so run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"`
   before it. That switches Node for the rest of the job, so a job that runs its tests on another version sets that
   version up again after the action, or calls the action from a job of its own.

## Secrets at rest

Only the response file `response-path` writes is safe to upload as an artifact: every secret in it is sealed. The
decoded log tail at `logs-path` is not. Container logs may hold secrets, which is why the control plane seals them, so
never upload it as an artifact from a public repository; read it in the job, or use `logs-url` there.

## Inputs

| Input                   | Operations           | Description                                                                                                                           |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `operation`             | all                  | `create`, `fetch`, `logs` or `destroy`. Required                                                                                      |
| `caller-key`            | all                  | The repository's key in the control plane's `callers`. Required                                                                       |
| `channel`               | all                  | `v1` (default) or `edge`. Use the channel the batch was created on                                                                    |
| `project`               | all                  | The control plane's project, the prefix of its function names. Default `e2e-test-stack`                                               |
| `region`                | all                  | Default `us-east-1`                                                                                                                   |
| `private-key`           | create, fetch, logs  | `${{ secrets.E2E_STACK_PRIVATE_KEY }}`. Also for destroy with `create-response`                                                       |
| `response-path`         | all                  | Write the raw response JSON here. Its secrets are sealed, so it is safe to upload as an artifact                                      |
| `instance-key`          | create               | Names the stack and prefixes its hostnames, e.g. `pr-1234`. Required                                                                  |
| `server-image`          | create               | The server image under test, by tag. Required                                                                                         |
| `count`                 | create               | Instances in the batch; default 1, at most 40                                                                                         |
| `services`              | create               | Comma-separated: `minio` or `azurite`, `elasticsearch` or `opensearch`, `keycloak`, `openldap`                                        |
| `ttl`                   | create               | A duration such as `90m`; default `1h`, at most `4h`                                                                                  |
| `os`                    | create               | OS variant, e.g. `ubuntu-24.04`                                                                                                       |
| `postgres`              | create               | Postgres version, e.g. `16`                                                                                                           |
| `license`               | create               | Licence SKU, e.g. `enterprise-advanced`; empty runs unlicensed                                                                        |
| `instance-type`         | create               | EC2 instance type; empty is sized by the control plane                                                                                |
| `server-env`            | create               | Server settings as a JSON object of strings, e.g. `{"MM_FEATUREFLAGS_TESTFEATURE":"true"}`; no credentials                            |
| `retries`               | create               | Attempts per failed instance; default 1, a negative number none, at most 3                                                            |
| `shared-admin-password` | create               | `true` gives every instance the same admin password                                                                                   |
| `wait-for-migrations`   | create               | `true` waits for the server's migrations before an instance is ready                                                                  |
| `caller-run-id`         | create               | Tagged on the batch for attribution. Default `github.run_id`                                                                          |
| `batch-id`              | fetch, logs, destroy | The batch, from create's `batch-id` output                                                                                            |
| `batch-token`           | fetch, logs, destroy | The batch's token, from create's `batch-token` output                                                                                 |
| `create-response`       | fetch, logs, destroy | Instead of `batch-id` and `batch-token`: a create response written by `response-path`; the token is opened from it with `private-key` |
| `indexes`               | fetch                | Comma-separated instance indexes; empty fetches the whole batch                                                                       |
| `index`                 | logs                 | The instance whose logs to collect; default 0                                                                                         |
| `logs-path`             | logs                 | Where to write the decoded log tail; default a file under `RUNNER_TEMP`                                                               |

An input that belongs to another operation is refused, as is any malformed value, before the control plane is called.

## Outputs

| Output               | Description                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch-id`           | The batch's id                                                                                                                                                                                                                                                                                                                               |
| `batch-token`        | From create. The token fetch, logs and destroy need. Masked                                                                                                                                                                                                                                                                                  |
| `sites`              | JSON array of site URLs, index-aligned; `""` where an instance failed                                                                                                                                                                                                                                                                        |
| `instances`          | From create and fetch. JSON array, index-aligned, `null` where an instance failed or was not fetched: `site_url`, `state`, `admin_username`, `admin_email`, `admin_password`, `mail_token` (Inbucket's HTTP Basic password, user `inbucket`), `credentials` (e.g. `postgres.password`) and `facts` (e.g. `openldap.bind_dn`). Secrets masked |
| `ready`              | How many instances are ready                                                                                                                                                                                                                                                                                                                 |
| `state`              | The batch's state: `ready` or `failed` from create and fetch; `destroyed`, `partially_destroyed`, `destroy_failed` or `not found` from destroy                                                                                                                                                                                               |
| `error`              | The control plane's error for a call that still returned a batch; empty otherwise                                                                                                                                                                                                                                                            |
| `deployment-version` | The Lambda version that answered                                                                                                                                                                                                                                                                                                             |
| `logs-path`          | From logs. The decoded log tail; empty when there was none                                                                                                                                                                                                                                                                                   |
| `logs-url`           | From logs. Presigned URL of the full log object, valid for 30 minutes. Masked                                                                                                                                                                                                                                                                |
| `response-path`      | Where `response-path` was written                                                                                                                                                                                                                                                                                                            |

Masked values are redacted from the job's logs. GitHub does not pass a job output that holds a masked value to
another job, so `batch-token` and `instances` are for steps of the same job. To reach a later job or run, upload the
create response and pass it to `create-response`.

## Failures

The step fails on an invalid input, a call the control plane refuses (its message is shown), secrets that do not open
with `private-key`, and an `error` in the response. A partial create (`1 of 2 instances failed: [1]`) still returns its
batch: the outputs and `response-path` are set before the step fails, so a teardown with `if: always()` can destroy
it. A destroy of a batch that is already gone succeeds with `state` `not found`.

Cancelling the job while a create is waiting leaves the batch running until its TTL: the action never received its
batch id, so nothing can destroy it.

## Examples

Create, test and destroy in one job:

```yaml
# .github/workflows/e2e-test-stack-create.yml
name: E2E test stack
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
jobs:
  e2e:
    runs-on: ubuntu-24.04
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
          private-key: ${{ secrets.E2E_STACK_PRIVATE_KEY }}
          instance-key: main-${{ github.run_number }}
          server-image: mattermostdevelopment/mattermost-enterprise-edition:master
          response-path: ${{ runner.temp }}/e2e-test-stack-create.json
      - name: Run tests
        env:
          SITE_URL: ${{ fromJSON(steps.stack.outputs.instances)[0].site_url }}
          ADMIN_USERNAME: ${{ fromJSON(steps.stack.outputs.instances)[0].admin_username }}
          ADMIN_PASSWORD: ${{ fromJSON(steps.stack.outputs.instances)[0].admin_password }}
        run: npm run e2e
      # The first session may have expired during the tests.
      - if: always() && steps.stack.outputs.batch-id != ''
        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::<account>:role/e2e-test-stack-ci-mobile
          aws-region: us-east-1
      - if: always() && steps.stack.outputs.batch-id != ''
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack@main
        with:
          operation: logs
          caller-key: mobile
          private-key: ${{ secrets.E2E_STACK_PRIVATE_KEY }}
          batch-id: ${{ steps.stack.outputs.batch-id }}
          batch-token: ${{ steps.stack.outputs.batch-token }}
      - if: always() && steps.stack.outputs.batch-id != ''
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack@main
        with:
          operation: destroy
          caller-key: mobile
          batch-id: ${{ steps.stack.outputs.batch-id }}
          batch-token: ${{ steps.stack.outputs.batch-token }}
```

Destroy from a separate run: the create job uploads its response, whose token is sealed, and the destroy workflow
opens it with the private key. The response does not record the channel, so set `channel` to the one that created the
batch (`v1` unless the create said otherwise).

```yaml
# In the create job, after the create step:
- if: always() && steps.stack.outputs.response-path != ''
  uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  with:
    name: e2e-test-stack-create
    path: ${{ steps.stack.outputs.response-path }}
```

```yaml
# .github/workflows/e2e-test-stack-destroy.yml
name: E2E test stack destroy
on:
  workflow_dispatch:
    inputs:
      run-id:
        description: The create run
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
          run-id: ${{ inputs.run-id }}
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
          private-key: ${{ secrets.E2E_STACK_PRIVATE_KEY }}
          create-response: ${{ runner.temp }}/create/e2e-test-stack-create.json
```

A create waits for its instances, usually two to four minutes and at most 15; the client waits up to 960 seconds for
the reply. A throttled call (the channel's reserved concurrency is in use) is tried again up to five times; no other
failure is retried, so a create is never made twice.
