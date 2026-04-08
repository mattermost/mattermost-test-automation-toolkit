# PR Test Analysis

AI-powered pull request test coverage analysis using Claude. This reusable workflow analyzes PRs to determine whether test coverage is adequate, posts commit statuses, and optionally comments on PRs and sends webhook notifications.

## How It Works

1. Fetches the PR diff and filters it to production and test files only.
2. Sends the filtered diff to Claude for analysis.
3. Claude produces a verdict: `PASS`, `PASS_NOT_NEEDED`, `FAIL_MISSING`, or `FAIL_INSUFFICIENT`.
4. Posts a commit status and (optionally) a PR comment and webhook notification.

## Usage

Create a caller workflow in your repository (e.g., `.github/workflows/pr-test-analysis.yml`):

```yaml
---
name: PR Test Analysis

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches:
      - master
      - main
      - "release-*"
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to analyze"
        required: true
        type: number
      claude_model:
        description: "Claude model to use (default: claude-sonnet-4-6)"
        required: false
        type: string

concurrency:
  group: test-analyzer-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  analyze:
    permissions:
      contents: read
      pull-requests: write
      statuses: write
      id-token: write
    # pull_request: skip drafts and forks (drafts are not ready for analysis;
    # fork runs do not receive this repo's Actions secrets).
    # workflow_dispatch: always allowed — runs in this repo with secrets, so you can pass a fork PR number manually.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.pull_request.draft == false &&
       github.event.pull_request.head.repo.full_name == github.repository)
    # Pin to a full commit SHA from the toolkit repo — replace the value after @ with yours. Avoid @main unless you want CI to float on every default-branch update.
    uses: mattermost/mattermost-test-automation-toolkit/.github/workflows/pr-test-analysis.yml@0123456789abcdef0123456789abcdef01234567
    with:
      pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}
      target_repo: ${{ github.repository }}
      # Order: workflow_dispatch input → repository variable CLAUDE_MODEL → default (matches reusable workflow env).
      claude_model: ${{ inputs.claude_model || vars.CLAUDE_MODEL || 'claude-sonnet-4-6' }}
    secrets:
      # When target_repo is this repo, github.token is enough (see Secrets below).
      GH_TOKEN: ${{ github.token }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      # Optional: pass a webhook URL for Mattermost notifications.
      WEBHOOK_URL: ${{ secrets.WEBHOOK_URL_TEST_PR_ANALYSIS_HUB }}
```

**`PR_TEST_ANALYSIS_DRY_RUN`** is **not** a field in this workflow file. Set it as a **repository variable** on the **calling** repository (see [Repository Environment Variables](#repository-environment-variables)); defaults apply if you skip them. **`CLAUDE_MODEL`** works the same way for `pull_request` runs and is already combined in `with.claude_model` above.

Replace the placeholder SHA after `@` with a real commit from [mattermost-test-automation-toolkit](https://github.com/mattermost/mattermost-test-automation-toolkit). This repository is not versioned with release tags for this workflow—**pin the `uses` ref to a full SHA** so behavior stays stable until you bump it on purpose.

### Which ref to use

- **Full commit SHA (recommended)** — Immutable; workflow behavior only changes when you update the SHA in the caller repo.
- **`@main`** — Only if you deliberately want the reusable workflow to track the toolkit default branch (less predictable for callers).

GitHub resolves the `uses` ref when the workflow runs.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `pr_number` | Yes | — | PR number to analyze |
| `target_repo` | Yes | — | Full repo name (e.g., `mattermost/mattermost`) |
| `claude_model` | No | `claude-sonnet-4-6` | Effective model: this **`workflow_call` input**, then repository variable **`CLAUDE_MODEL`**, then `claude-sonnet-4-6` (see `env.CLAUDE_MODEL` in the reusable workflow). In the Usage example, the caller supplies the same order using `workflow_dispatch` input where applicable. |

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `GH_TOKEN` | Yes | Credential for `gh`/GitHub API against `target_repo`. Use **`${{ github.token }}`** when the caller passes `target_repo: ${{ github.repository }}` (same repo as the workflow). Use a **PAT** in **`secrets.GH_TOKEN`** only when `target_repo` is a *different* repository—the default `GITHUB_TOKEN` is limited to the caller repo and cannot act on another repo's PRs, statuses, or labels. |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude analysis. Must be provided by the caller. |
| `WEBHOOK_URL` | No | Optional Mattermost webhook URL for notifications. If omitted, no webhook notification is sent. |

## Repository Environment Variables

These are configured via **Settings > Environments** or **Settings > Secrets and variables > Actions > Variables** in the calling repository.

| Variable | Default | Description |
|----------|---------|-------------|
| `PR_TEST_ANALYSIS_DRY_RUN` | `false` | When `true`: runs the AI analysis but always posts a success status, does not comment on PRs, and writes results to the Job Summary only. When `false` or not set: enforces analysis — a failure verdict marks the CI check as failed and posts a PR comment. |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Used in the Usage `with.claude_model` expression when `workflow_dispatch` does not supply `claude_model` (e.g. on `pull_request` runs). |

### Configuring Environment Variables

1. Go to your repository's **Settings > Secrets and variables > Actions**.
2. Select the **Variables** tab.
3. Click **New repository variable**.
4. Add the variable name (e.g., `PR_TEST_ANALYSIS_DRY_RUN`) and value (e.g., `true`).

## Behavior Modes

### Enforce Mode (`PR_TEST_ANALYSIS_DRY_RUN=false`, default)

- Commit status reflects the actual verdict (`success` or `failure`).
- On failure, a PR comment is posted with the analysis and suggestions.
- Stale failure comments are automatically removed when the verdict changes to pass.
- Failure blocks the PR from merging (when used as a required status check).

### Dry Run Mode (`PR_TEST_ANALYSIS_DRY_RUN=true`)

- Commit status is always `success` (analysis never blocks merges).
- No PR comments are posted.
- Full analysis results are available in the **GitHub Actions Job Summary**.
- Webhook notification is still sent to the configured channel.
- Useful for initial rollout and observation before enforcing.

## Verdicts

| Verdict | Status | Description |
|---------|--------|-------------|
| `PASS` | success | Tests are included and adequate |
| `PASS_NOT_NEEDED` | success | No tests needed (docs, refactor, config, etc.) |
| `FAIL_MISSING` | failure | Tests are required but missing |
| `FAIL_INSUFFICIENT` | failure | Tests exist but don't sufficiently cover changes |

## Permissions

The **job** that invokes the reusable workflow must declare the following `permissions` (they are already in the [Usage](#usage) example above):

```yaml
permissions:
  contents: read
  pull-requests: write
  statuses: write
  id-token: write
```

## Overriding a Failure

A reviewer can override the analysis when the change requires no tests, existing tests are believed to be sufficient, or the result is a false positive:

1. Comment `/test-analysis-override <reason>` on the PR with the justification.

The override is handled by a companion reusable workflow [`pr-test-analysis-override.yml`](pr-test-analysis-override.yml). See [PR Test Analysis Override](pr-test-analysis-override.md) for setup instructions.

## Webhook Notification Format

Notifications use hashtags for easy filtering in Mattermost channels:

```text
:white_check_mark: #pass-test-analysis #mattermost-pr-1234
Tests included: 2 unit, 1 integration
```

```text
:red_circle: #fail-test-analysis #desktop-pr-567
Tests missing: add integration tests for new endpoint
```

```text
:large_blue_circle: #override-test-analysis #mattermost-pr-1234
By: @username
Reason: Tests verified manually, config-only change
```

Available hashtags for filtering:

- `#pass-test-analysis` — passing results
- `#fail-test-analysis` — failing results
- `#override-test-analysis` — manual overrides
- `#unavailable-test-analysis` — analysis unavailable (AI error/timeout)
- `#<repo>-pr-<number>` — specific PR (e.g., `#mattermost-pr-1234`)
