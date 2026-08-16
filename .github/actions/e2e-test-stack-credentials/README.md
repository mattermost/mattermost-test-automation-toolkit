# E2E Test Stack Credentials

Reads one instance's site URL and credentials from a batch leased by
[`e2e-test-stack-create`](../e2e-test-stack-create/README.md), for the job that runs tests
against it.

Assumes no AWS credentials itself — run `aws-actions/configure-aws-credentials` once in the
job before it.

## Why an action rather than a reusable workflow

So it runs **inside the consuming job**. Two things follow from that.

It uses the AWS credentials the job already assumed, rather than assuming its own — a
reusable workflow is a separate job and would have to request a second token.

Credentials never cross a job boundary and never become a workflow output.

That matters because of two GitHub behaviours:

- **`::add-mask::` applies only to the job that set it.** A password masked where it was
  fetched arrives *unmasked* in any later job, so handing one through a workflow output
  removes the protection exactly where it is needed.
- **`${{ }}` inside a `run:` body is rendered into the log.** Referencing a credential there
  publishes it even if nothing echoes it. Pass credentials through `env:` and read `$VAR`.

These stacks are on public HTTPS, so an admin password is live access to a reachable server,
not just test data.

## Usage

```yaml
  test:
    needs: stack
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1 (2026-07-20)

      # Once per job. Every toolkit action after this uses these credentials.
      - uses: aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6.2.3 (2026-07-22)
        with:
          role-to-assume: ${{ vars.MM_E2E_TEST_STACK_AWS_ROLE_ARN }}
          aws-region: us-east-1

      - uses: mattermost/mattermost-test-automation-toolkit/.github/actions/e2e-test-stack-credentials@<commit-sha>
        id: creds
        with:
          batch_id: ${{ needs.stack.outputs.batch_id }}
          indexes: ${{ matrix.shard }}

      - run: npm run test:e2e
        env:
          MM_SITE_URL: ${{ steps.creds.outputs.site_url }}
          MM_ADMIN_USERNAME: ${{ steps.creds.outputs.admin_username }}
          MM_ADMIN_PASSWORD: ${{ steps.creds.outputs.admin_password }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `batch_id` | Yes | — | Batch to read, as returned by `e2e-test-stack-create`. |
| `indexes` | No | — | Which instances to fetch, comma separated — `0` or `0,3`. Empty fetches the batch. Narrowing it keeps the other instances' admin passwords out of the response entirely. |
| `lambda_alias` | No | `v1` | Control plane to invoke — `v1` or `edge`. Match whatever created the batch. |

## Outputs

| Output | Description |
|---|---|
| `site_url` | HTTPS address of this instance. |
| `admin_username` | Admin account created on this instance. |
| `admin_email` | Email of that account. |
| `admin_password` | Password for that account. Masked. |
| `credentials` | Every other service credential, as a JSON object. |
| `instances` | Every ready instance in the batch, as a JSON array of `site_url`, `admin_username` and `admin_password`. |

### Reaching every instance

`indexes` names which instances to fetch, which is what a sharded job narrows. A job
checking the whole batch leaves it empty and takes `instances` — every ready instance with its own admin, so it
holds whether or not the batch was created with `shared_admin_password`:

```yaml
      - env:
          INSTANCES: ${{ steps.creds.outputs.instances }}
        run: |
          while read -r entry; do
            jq -r '.site_url' <<< "$entry"
          done < <(jq -c '.[]' <<< "$INSTANCES")
```

Instances that never came up are left out: they have no admin to reach them with.

### Other services

`credentials` is a JSON object keyed `<service>.<key>`, so a suite needing Keycloak or Minio
does not need a new output added here:

```yaml
      - run: npm run test:saml
        env:
          KEYCLOAK_ADMIN_PASSWORD: ${{ fromJSON(steps.creds.outputs.credentials)['keycloak.admin_password'] }}
          MINIO_ACCESS_KEY: ${{ fromJSON(steps.creds.outputs.credentials)['minio.access_key'] }}
```

Which keys exist follows the `services` the batch was created with:

| Key | Present when |
|---|---|
| `postgres.user`, `postgres.database`, `postgres.password` | Always |
| `keycloak.admin_password` | `keycloak` |
| `openldap.admin_password` | `openldap` |
| `opensearch.admin_password` | `opensearch` |
| `minio.access_key`, `minio.secret_key` | `minio` |
| `azurite.account_key` | `azurite` |

`elasticsearch` generates no credentials.

## Masking

Every value under `credentials` is masked **except `postgres.user` and `postgres.database`**,
which are not secret and would otherwise be redacted from every log line that mentions them.

The rule is written as an exclusion rather than a list of secrets, so a service added to the
control plane later is masked without anyone remembering to update this action.

## Failure modes

Fails, rather than returning something unusable, when:

- nothing came back for the `indexes` asked for
- that instance is not `ready` — otherwise the suite would hit an authentication error
  instead of a clear one
- `aws lambda invoke` succeeded but the handler failed, which the CLI reports as
  `FunctionError` with a zero exit status
