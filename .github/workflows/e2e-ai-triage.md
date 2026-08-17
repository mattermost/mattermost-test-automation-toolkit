# E2E AI triage — human override

Adjudication (clustering, flake vs bug, check greening) lives in
[mattermost-test-system-io](https://github.com/mattermost/mattermost-test-system-io)
(`.github/actions/test-system-io-ai-triage`). This repository only hosts the
maintainer override path.

## Override

Workflow: [`e2e-ai-triage-override.yml`](./e2e-ai-triage-override.yml)

Comment `/e2e-triage-override` on a PR (OWNER / MEMBER / COLLABORATOR) to
correct a triage verdict via the TSIO corrections API and adjust labels /
commit status.

## Testing

```bash
node --test scripts/triage-override.test.js
```
