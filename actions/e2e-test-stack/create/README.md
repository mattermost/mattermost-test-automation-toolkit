# E2E test stack: create

Creates a batch of remote Mattermost test servers through the e2e-test-stack control plane, checks that every server
is ready, and uploads the batch's create response for the jobs and runs that use or destroy it. See the
[shared README](../README.md) for the keys, aliases and setup every action relies on.

In order, the action:

1. Checks every input, and derives the **instance key** `<caller-key>-<run id>-<batch>-<run attempt>` (for example
   `mobile-12345678901-ios-1`), which the control plane takes up to 44 characters long and which prefixes the batch id
   and every hostname.
2. Resolves `server-image`: `master` is `mattermostdevelopment/mattermost-enterprise-edition:master`; `latest` is
   `mattermost/mattermost-enterprise-edition:<X.Y.Z>`, the highest stable release of `mattermost/mattermost` (not a
   draft or prerelease, and a tag with no suffix such as `-rc1`); `esr` is the newest patch of the newest minor whose
   stable releases' notes say "extended support release". Any other value is passed through as the image.
3. Records the account (`prod` or `dev`) in `e2e-test-stack-account`, beside where the response goes.
4. Requests the job's GitHub OIDC token for `sts.amazonaws.com` and assumes `role-arn-<account>` with it for one hour.
   No `aws-actions/configure-aws-credentials` step is needed, and the action uses no AWS credentials the job holds.
5. Invokes `<project>-<channel>:<caller-key>-<channel>` with `action: create` and waits for the reply (usually two to
   four minutes, at most 15), then writes the raw reply to `e2e-test-stack-create.json`.
6. Opens the sealed secrets with `credentials-key` and masks every one (the batch token, each server's admin password,
   mail token and service credentials) before writing any output.
7. Fetches the batch with its token and requires the control plane to find it with every server ready.
8. Uploads the response and the account file as artifacts.

A throttled invoke (the channel's reserved concurrency is in use) is tried again up to five times; no other failure is
retried, so a create is never made twice. The client waits up to 960 seconds for the reply.

## Permissions

The job needs `id-token: write`, to request the OIDC token the CI role trusts. Run
[`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"` before the action.

## Inputs

| Input                   | Description                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `caller-key`            | The repository's key in the control plane's `callers`, e.g. `mobile`. Required                                                               |
| `batch`                 | Names the batch within the run, e.g. `ios`: 1-20 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Required |
| `account`               | `prod` or `dev`. Required                                                                                                                    |
| `role-arn-prod`         | The repository's CI role ARN in prod, e.g. `${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}`. Required for `account: prod`                          |
| `role-arn-dev`          | The repository's CI role ARN in dev, e.g. `${{ vars.E2E_TEST_STACK_ROLE_ARN_DEV }}`. Required for `account: dev`                             |
| `channel`               | `v1` (default, the promoted build) or `edge` (`main`'s newest build)                                                                         |
| `project`               | The control plane's project, the prefix of its function names. Default `e2e-test-stack`                                                      |
| `region`                | Default `us-east-1`                                                                                                                          |
| `credentials-key`       | `${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}`. Required                                                                                    |
| `server-image`          | `master`, `latest`, `esr`, or the image under test by tag. Required                                                                          |
| `count`                 | Servers in the batch; default 1, at most 40                                                                                                  |
| `ttl`                   | A duration such as `90m`; default `1h`, at most `4h`                                                                                         |
| `services`              | Comma-separated: `minio` or `azurite`, `elasticsearch` or `opensearch`, `keycloak`, `openldap`                                               |
| `os`                    | OS variant, e.g. `ubuntu-24.04`                                                                                                              |
| `postgres`              | Postgres version, e.g. `16`                                                                                                                  |
| `license`               | Licence SKU, e.g. `enterprise-advanced`; empty runs unlicensed                                                                               |
| `instance-type`         | EC2 instance type; empty is sized by the control plane                                                                                       |
| `server-env`            | Server settings as a JSON object of strings, e.g. `{"MM_FEATUREFLAGS_TESTFEATURE":"true"}`; no credentials                                   |
| `retries`               | Attempts per failed server; default 1, a negative number none, at most 3                                                                     |
| `shared-admin-password` | `true` gives every server the same admin password                                                                                            |
| `wait-for-migrations`   | `true` waits for the server's migrations before a server is ready                                                                            |
| `github-token`          | Token for api.github.com, to read `mattermost/mattermost`'s releases for `latest` and `esr`. Default `github.token`                          |

A malformed input, or an instance key over 44 characters, is refused before anything is called.

## Outputs

| Output             | Description                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `batch-id`         | The batch's id; set whenever the control plane named a batch, even when the step then fails                  |
| `sites`            | JSON array of site URLs, index-aligned; `""` where a server failed                                           |
| `indexes`          | JSON array `[0, ..., count - 1]`, for a matrix of one job per server; empty unless every server is ready     |
| `server-image`     | The image the batch runs, with `master`, `latest` or `esr` resolved                                          |
| `state`            | The batch's state as create reported it: `ready` or `failed`                                                 |
| `duration-seconds` | Seconds from the request to every server ready, as the control plane measured it; empty when a server failed |
| `response-path`    | The create response file. Empty when the control plane was not reached                                       |
| `account-path`     | The file beside it that records the account                                                                  |

No output carries the batch token or any other secret. A later job reads them from the uploaded response with the
credentials key.

## Artifacts

Whenever `response-path` is set, even when the step fails, the response and the account file are uploaded twice:

- `e2e-test-stack-create-<batch>`: the newest, replacing an earlier attempt's.
- `e2e-test-stack-response-<batch>-<run attempt>`: this attempt's own. Its prefix differs, so a pattern for one name
  never matches the other.

Each holds `e2e-test-stack-create.json` and `e2e-test-stack-account`. The response is safe to upload, from a public
repository too: every secret in it is sealed to the repository's key.

## Re-runs

A re-run attempt has a new run attempt, so it creates a new batch with a new instance key. The create action never
destroys an earlier attempt's batch: the `destroy` action releases it, or it is reaped at its TTL.

## Example

```yaml
name: E2E tests
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  create:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write
    outputs:
      batch-id: ${{ steps.create.outputs.batch-id }}
      indexes: ${{ steps.create.outputs.indexes }}
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "26"
      - id: create
        uses: mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/create@main
        with:
          caller-key: mobile
          batch: ios
          account: prod
          role-arn-prod: ${{ vars.E2E_TEST_STACK_ROLE_ARN_PROD }}
          role-arn-dev: ${{ vars.E2E_TEST_STACK_ROLE_ARN_DEV }}
          credentials-key: ${{ secrets.E2E_TEST_STACK_CREDENTIALS_KEY }}
          server-image: master
          count: "3"
```

The job's workflow file and branch must be registered for the repository, or the CI role refuses the OIDC token.

## Failures

The step fails, with the reason, on:

- an invalid input, or an instance key over 44 characters;
- a `latest` or `esr` that cannot be resolved;
- a job without `id-token: write`, or a CI role that refuses the job's token;
- an invoke that fails, or a create the control plane refuses: "A batch may have been created; it is reaped at its
  ttl.";
- a reply with an error (a partial create, such as `1 of 2 instances failed: [1]`), with secrets that do not open
  with `credentials-key` or hold no batch token, with a state other than `ready`, or with fewer servers than `count`;
- a fetch that does not find the batch with every server ready;
- a response file that cannot be written.

Once the reply names a batch, the outputs, the response file and the artifacts are written before the step fails, and
the message says the batch was created: a later `destroy` with `if: always()` releases it, or it is reaped at its TTL.
The control plane's messages are shown with ARNs and account ids taken out, and every failure annotation is redacted
the same way.

Cancelling the job while a create is waiting leaves the batch running until its TTL: the action never received its
batch id, so nothing can destroy it.
