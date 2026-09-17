# mattermost-test-automation-toolkit

Test Automation Toolkit, a collection of tools and libraries to help with test automation for Mattermost.

## Repository Structure

```text
mattermost-test-automation-toolkit/
├── .github/
│   └── workflows/
│       └── <reusable-workflow>/
├── actions/
│   └── <reusable-composite-action>/
├── packages/
│   └── mattermost-testcontainers/
└── scripts/
```

- **`.github/workflows/`** — Reusable GitHub Actions workflows shared across repositories.
- **`actions/`** — Reusable composite actions for GitHub Actions.
- **`packages/`** — Publishable libraries and tools (e.g., `mattermost-testcontainers`).
- **`scripts/`** — Utility scripts for test automation tasks.

## Available for use

1. Reusable workflow [`pr-test-analysis.yml`](.github/workflows/pr-test-analysis.yml). Documentation: [PR Test Analysis](.github/workflows/pr-test-analysis.md).
2. Reusable workflow [`pr-test-analysis-override.yml`](.github/workflows/pr-test-analysis-override.yml). Documentation: [PR Test Analysis Override](.github/workflows/pr-test-analysis-override.md).
3. Composite action [`actions/e2e-triage`](actions/e2e-triage): is a red E2E run the PR's fault? History rules plus a second judge, publishing the required status and a PR comment with the evidence. Documentation: [E2E triage](actions/e2e-triage/README.md).
