# diff-bug-hunter

PR diff bug hunter and cheap UI smoke verifier for `mattermost/mattermost` pull requests and release ranges. Reports only findings proven by deterministic Go/Jest execution, differential recorders, or Playwright accessibility assertions.

## Commands

Both skills set `disable-model-invocation: true`, so invoke them explicitly:

- **`/diff-bug-hunter:hunt <pr_number | base...head> [--batch N | --all-batches] [--mutants]`**
  Runs multi-mode bug hunting (`A` caller invariants, `B` PR-promise falsifier, optional `D` differential recorders, `R` CodeRabbit claim verifier, and `V` root-cause diagnostics) plus `old_tests.py`, vetting all failures on the merge-base. Separately, `pr_tests.py` runs PR-added or modified Go tests in parallel mode and retests consistent failures in plain mode on the PR head only (without merge-base comparison).
- **`/diff-bug-hunter:verify <what to verify> [base_url]`**
  Drives Chromium against a running Mattermost server (or a PR's published e2e image via `pr_server.py`) using text-only ARIA snapshots.

## Prerequisites

- **Python 3.11+** (macOS system Python 3.9 is too old)
- **`git`** and authenticated **`gh` CLI** (`gh auth status`)
- **Go toolchain** matching `mattermost/mattermost` (for Go PRs)
- **Node.js & `npm`** (for webapp Jest PRs and `/diff-bug-hunter:verify` UI plans)
- **Docker or local PostgreSQL + Redis** (for stateful Go `Setup(t)` tests and `pr_server.py`)
- **Playwright** (optional, for `/diff-bug-hunter:verify` UI plans via `mattermost/e2e-tests/playwright` or `NODE_PATH`)
- Local `mattermost/mattermost` checkout or `HUNT_REPO` (defaults to `mattermost/mattermost`, cached/cloned under `HUNT_SCRATCH`)

## Cost Controls & Environment Variables

By default, unattended hunters and Mode V run on **Sonnet**, Mode D is opt-in, the skeptic runs on **Opus** (capped at 1 mechanical escalation per hunt), and every hunt enforces an **$8 USD cap** (`HUNT_BUDGET_USD`).

| Variable | Purpose | Default |
|---|---|---|
| `HUNT_SCRATCH` | Clones, worktrees, state, `telemetry.jsonl`, `hunt_ledger.jsonl` | `<tmp>/hunt` |
| `HUNT_STATE_DIR` | Writable overlay for `lessons.jsonl` additions/retirements | `CLAUDE_PLUGIN_DATA` or `~/.local/state/diff-bug-hunter` (when read-only) |
| `HUNT_BUDGET_USD` | Max model spend per hunt | `8` |
| `HUNT_FUZZ_TIME` | Per-target `go test -fuzztime` budget (`HUNT_FUZZ=0` disables) | `60s` |
| `ENABLE_FULLY_PARALLEL_TESTS` | Bypass host Postgres pool lock when set to `true` | unset |
| `DISABLE_PROMPT_CACHING` | Opt out of prompt caching when set to `1` | unset |

## Security Notice

`/diff-bug-hunter:hunt` checks out PR head commits and executes `go test` and `npm ci` (including lifecycle scripts) on that code. Only hunt PRs you trust, or run inside an isolated container/VM.
