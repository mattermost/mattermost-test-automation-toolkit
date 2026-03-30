# PR Test Analysis Override

Companion to [PR Test Analysis](pr-test-analysis.md). This reusable workflow handles the `/test-analysis-override <reason>` slash command on PRs — it overrides a failing `Tests/analysis` commit status to success, reacts to the comment, and sends a webhook notification.

## Usage

Create a caller workflow in your repository (e.g., `.github/workflows/pr-test-analysis-override.yml`):

```yaml
---
name: PR Test Analysis Override

on:
  issue_comment:
    types: [created]

concurrency:
  group: test-analyzer-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  override:
    permissions:
      statuses: write
    if: >-
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/test-analysis-override') &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    uses: mattermost/mattermost-test-automation-toolkit/.github/workflows/pr-test-analysis-override.yml@0123456789abcdef0123456789abcdef01234567
    with:
      pr_number: ${{ github.event.issue.number }}
      target_repo: ${{ github.repository }}
      reason: ${{ github.event.comment.body }}
      comment_id: ${{ github.event.comment.id }}
      sender: ${{ github.event.comment.user.login }}
    secrets:
      GH_TOKEN: ${{ github.token }}
      # Optional: omit to use the default webhook configured in mattermost-test-automation-toolkit.
      # WEBHOOK_URL: ${{ secrets.WEBHOOK_URL }}
```

Replace the placeholder SHA after `@` with a real commit from [mattermost-test-automation-toolkit](https://github.com/mattermost/mattermost-test-automation-toolkit). Use the same ref as your `pr-test-analysis.yml` caller to keep the two workflows in sync.

### Reason extraction

The `reason` input receives the full comment body. The reusable workflow uses it as-is. If you want to strip the command prefix before passing it, you can do so in the caller:

```yaml
    with:
      reason: ${{ ... }} # custom extraction logic
```

The original source workflow extracted the reason in a shell step; for the reusable version, the full body is passed for simplicity. The webhook notification displays whatever string is provided.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `pr_number` | Yes | PR number to override |
| `target_repo` | Yes | Full repo name (e.g., `mattermost/mattermost`) |
| `reason` | Yes | Override reason provided by the reviewer |
| `comment_id` | Yes | ID of the slash-command comment (for +1 reaction) |
| `sender` | Yes | GitHub login of the user who posted the override |

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `GH_TOKEN` | Yes | Same rules as [PR Test Analysis secrets](pr-test-analysis.md#secrets). |
| `WEBHOOK_URL` | No | Optional Mattermost webhook from the caller. Falls back to toolkit environment secret `PR_TEST_ANALYSIS_HUB_WEBHOOK_URL`. |

## What It Does

1. Resolves the PR's head commit SHA.
2. Reads the current `Tests/analysis` commit status and prepends `(override)` to its description.
3. Posts a `success` status, overriding any previous failure.
4. Reacts with :+1: to the slash-command comment.
5. Sends a webhook notification with `#override-test-analysis` and `#<repo>-pr-<number>` hashtags.

## Permissions

The caller job needs:

```yaml
permissions:
  statuses: write
```

## Who Can Override

The caller workflow's `if` condition restricts the command to `OWNER`, `MEMBER`, or `COLLABORATOR` author associations. Adjust this in your caller if needed.
