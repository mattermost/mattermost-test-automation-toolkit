# E2E test stack

Composite actions for a repository's CI to use remote Mattermost test servers from the e2e-test-stack control plane:
one AWS Lambda function per channel, `<project>-v1` (the promoted build) and `<project>-edge` (`main`'s newest build).
Each server is a short-lived stack (Mattermost, Postgres, Inbucket and any optional services) reachable over HTTPS; a
batch of servers is reaped at its TTL if nothing destroys it.

Each action is a folder here with its own `action.yml` and README. They share this folder's package and one bundle,
`dist/index.js`, which `run.sh` runs with the action's name.

## Keys, aliases and sealed secrets

A repository is registered in the control plane's `callers` with a short **caller key** (for example `mobile`) and
the X25519 public key its secrets are sealed to, its `recipient_public_key`. The actions invoke only that repository's
own alias, `<project>-<channel>:<caller-key>-<channel>` (for example `e2e-test-stack-v1:mobile-v1`). The alias decides
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
2. **The CI role.** `arn:aws:iam::<account>:role/e2e-test-stack-ci-<caller-key>`, one per account. It trusts only
   jobs on the branches registered for the repository, in the workflow files registered for it, so `pull_request`
   runs are refused.
3. **Node.** The actions run on Node 26 or later and fail before doing anything on an older one. The runner's default
   Node is older, so run [`actions/setup-node`](https://github.com/actions/setup-node) with `node-version: "26"`
   first. That switches Node for the rest of the job, so a job that runs its tests on another version sets that
   version up again afterwards, or uses the actions in a job of its own.

## Development

From the repository root, `npm install` installs every action's dependencies. In this folder, `npm test` runs the
tests, `npm run build` rebuilds `dist/index.js`, and `npm run fmt`, `npm run lint` and `npm run tsc` format, lint and
type-check. CI fails when `dist/` does not match a fresh build.
