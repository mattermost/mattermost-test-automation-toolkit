# E2E test stack

Composite actions for a repository's CI to use remote Mattermost test servers from the e2e-test-stack control plane:
one AWS Lambda function per channel in `us-east-1`, `e2e-test-stack-v1` (the promoted build) and `e2e-test-stack-edge`
(`main`'s newest build).
Each server is a short-lived stack (Mattermost, Postgres, Inbucket and any optional services) reachable over HTTPS; a
batch of servers is reaped at its TTL if nothing destroys it.

Each action is a folder here with its own `action.yml` and README. They share this folder's package and one bundle,
`dist/index.js`, which `run.sh` runs with the action's name.

## Actions

- [`create`](create/README.md): creates a batch of servers, checks that every one is ready, and uploads its sealed
  create response. Uses: `mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/create@main`.
- [`open`](open/README.md): opens one server of this run's batch from its create response, and sets its site and admin
  credentials as masked outputs. Calls only GitHub, never AWS. Uses:
  `mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/open@main`.
- [`destroy`](destroy/README.md): destroys every attempt's batch of a run, this run's or another's, checks that every
  host is gone and that a second destroy finds nothing. Uses:
  `mattermost/mattermost-test-automation-toolkit/actions/e2e-test-stack/destroy@main`.

## Keys, aliases and sealed secrets

A repository is registered in the control plane's `callers` with a short **caller key** (for example `mobile`) and
the X25519 public key its secrets are sealed to, its `recipient_public_key`. The actions invoke only that repository's
own alias, `e2e-test-stack-<channel>:<caller-key>-<channel>` (for example `e2e-test-stack-v1:mobile-v1`). The alias decides
which repository a call acts for; the request never names one. The plain `v1` and `edge` aliases are refused, and the
repository's CI role may invoke only its own aliases.

Nothing secret comes back in the clear. Batch tokens, each server's admin password, mail token and service
credentials, and log URLs are sealed (libsodium `crypto_box_seal`) to the repository's public key. The actions open
them with the repository's credentials key and mask every secret before writing an output.

## Setup

1. **The credentials key.** The repository's credentials key is the base64 X25519 private key whose public half is
   registered as its `recipient_public_key`. Store it as a plain repository Actions secret,
   `E2E_TEST_STACK_CREDENTIALS_KEY`, not an environment secret: a job that names an environment gets an OIDC subject
   of `environment:<name>`, and the CI role trusts only branch subjects.
2. **The CI role.** `arn:aws:iam::<account id>:role/e2e-test-stack-ci-<caller-key>`, one per repository in each
   account. The caller passes the one to use as `role-arn`, and the batch is in that role's account. It trusts only
   jobs on the branches registered for the repository, in the workflow files registered for it, so `pull_request`
   runs are refused. `create` and `destroy` assume it themselves with the job's GitHub OIDC token, so their jobs grant
   `id-token: write`; `destroy` also reads the run's artifacts, so its job grants `actions: read` too. `open` assumes
   no role: it reads the run's artifacts, so its job grants `actions: read`.
3. **Node.** The actions run on Node 26 or later and fail before doing anything on an older one. The runner's default
   Node is older, so run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"`
   first. That switches Node for the rest of the job, so a job that runs its tests on another version sets that
   version up again afterwards, or uses the actions in a job of its own.

## Development

From the repository root, `npm install` installs every action's dependencies. In this folder, `npm test` runs the
tests, `npm run build` rebuilds `dist/index.js`, and `npm run fmt`, `npm run lint` and `npm run tsc` format, lint and
type-check. CI fails when `dist/` does not match a fresh build.
