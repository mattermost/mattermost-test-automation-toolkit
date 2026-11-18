# diff-bug-hunter

Two Claude Code skills that find bugs cheaply and only report what a deterministic check proves:

- **`/hunt <pr_number>`** looks for new bugs in a `mattermost/mattermost` pull request. It reports a bug only when a
  test fails deterministically on the unmodified PR code with a concrete counterexample.
- **`/verify <what to check>`** smoke-tests a UI change against a running server with a bounded, text-only Playwright
  plan. A passing plan can be frozen into a plain Playwright test that reruns in CI with no model.

## /hunt

- **Mode A (caller invariants):** blind subagents infer what callers rely on and write property tests.
  Every invariant must be backed by at least 3 caller `file:line` references. Go tests run with `-race`.
- **Mode B (PR-promise falsifier):** tests that try to break each claim in the PR description.
- **Vetting:** each failure must reproduce 3/3. It is root-caused against `lessons.jsonl` (known false positives),
  run on the merge-base (**New PR Bug** vs **Pre-Existing Bug**), and checked for caller reachability.
- **Mutation gate:**
  - 3 visible plus 2 held-out mutants, each compile-checked (`go test -c`, single-file Babel parse).
  - One strengthen round if a visible mutant survives.
  - The PR's own tests are scored for comparison.
- **Mattermost invariants:** `RELIABILITY.md` holds 10 diff-triggered rules (guest isolation, cross-team and private
  channel boundaries, ClientConfig hash, WebSocket payloads, mention/HTML/NUL sanitization, store atomicity,
  migrations, concurrency, React async forms, selector memoization). Only rules whose path globs or diff regex match
  the change reach Mode A.
- **Large-diff guard:** lockfiles, generated code, snapshots, i18n and existing tests are skipped. The rest is
  ranked by risk and hunted in batches of at most 5 files / 800 diff lines; `skipped.log` lists the rest.

Hunters and mutant planters only ever see a request file built by `scripts/`; deterministic logic lives in tested
Python, not in prose. Results are reported in chat. Nothing is posted to GitHub.

### Rules come from the base branch

A pull request must not be able to weaken its own checks. `SKILL.md`, `lessons.jsonl`, `RELIABILITY.md` and `prompts/`
are read from the trusted ref: the merge-base of `HEAD` and `origin/main` (or `origin/master`) in the repository that
holds the skill, never from the checked-out head.

- `trusted.py check` (step 0 of `/hunt`) fails closed when any skill file differs from that ref.
- A tracked rule file missing on the base also fails closed, as does a repository without a base branch.
- A skill that is not tracked at `HEAD` (a local symlink or uncommitted copy) is read from disk: no pull request can
  change it.
- People editing the rules themselves set `HUNT_TRUSTED_REF=worktree`; `HUNT_TRUSTED_REF=<ref>` pins another ref.
- New lessons apply once they are merged.

## Requirements

`git`, `gh` (authenticated), Python 3.10+, Go (matching the target), Node 20+.
Server packages that use `Setup(t)` (`api4`, `app`, `platform`, `store`) also need Postgres 16
(`mmuser`/`mostest`, db `mattermost_test`) and Redis on localhost. If they are down and Postgres 16 is installed
locally, `scripts/start_pg.sh` starts a throwaway cluster.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUNT_SCRATCH` | `<tmp>/hunt` | clones, worktrees and per-PR `hunt<pr>/` state |
| `HUNT_MM` | `$HUNT_SCRATCH/mmfull` | existing `mattermost/mattermost` clone to reuse |
| `HUNT_REPO` | `mattermost/mattermost` | repository the PR belongs to |
| `HUNT_NODE_BIN` | node on `PATH` | Node bin dir for Jest runs |
| `HUNT_TRUSTED_REF` | merge-base with `origin/main` | where rules are read from (`worktree` = disk) |

## /verify

`scripts/verify_ui.mjs` runs a JSON plan against `MM_URL` (default `http://localhost:8065`). Claude writes the plan;
plain Node decides the verdict.

- **Bounded:**
  - At most `MAX_STEPS = 10` steps of `goto`/`click`/`fill`/`press`/`select`/`check`/`wait_for`/`snapshot`.
  - Locators by role and accessible name first.
  - Same-origin only: other hosts are blocked and logged, and a `goto` that leaves the server is refused.
- **Text, not pixels:** `snapshot` prints a scoped `locator.ariaSnapshot()` (e.g. just the dialog). The runner never
  takes screenshots.
- **Automatic failures:** any `pageerror`, or any `/api/v4/` response >= 500, fails the run. Each step waits until
  in-flight requests settle, so a late 500 is not missed.
- **Deterministic oracle:** `expect` must hold at least one DOM check (`visible`, `text` + `contains`,
  `count` + `min`) or an `/api/v4/` read (`status`, `json_has`).
- **Freeze:** `--freeze out.spec.ts` turns a passing plan into a `@playwright/test` spec with the same oracle, so the
  check reruns in CI with no model.

```bash
MM_USERNAME=sysadmin MM_PASSWORD=... node .claude/skills/verify/scripts/verify_ui.mjs plan.json --freeze save.spec.ts
```

Run it where `require("playwright")` resolves (e.g. `mattermost/e2e-tests/playwright`), or set `NODE_PATH`.

## Install and run locally

```bash
packages/diff-bug-hunter/scripts/install-skill.sh ~/src/mattermost
```

That symlinks `.claude/skills/hunt` and `.claude/skills/verify` into the target repository and git-ignores them
locally. Use `--copy` to vendor a snapshot you can commit (plugins, forks), `--skill hunt|verify` to install one, and
`--force` to replace an existing install. Then, in Claude Code inside that repository:

```text
/hunt 40148
/verify the channel header edit dialog saves and shows the new header
```

Webapp PRs need `npm ci` once in `$HUNT_MM/webapp`; the skill links that `node_modules` into its worktrees.

## CI integration

Package self-test (runs in this repository's `ci.yml` when `packages/diff-bug-hunter/` changes; it needs a Chromium
from `npx playwright install chromium`):

```bash
make -C packages/diff-bug-hunter self-test lint
```

Running a hunt from a workflow is possible with
[claude-code-action](https://github.com/anthropics/claude-code-action), but this example has not been exercised in CI
yet. The report goes to the job summary and nothing is posted to the PR:

```yaml
jobs:
  hunt:
    runs-on: ubuntu-24.04
    timeout-minutes: 120
    permissions:
      contents: read
    services:
      postgres:
        image: postgres:16
        env: {POSTGRES_USER: mmuser, POSTGRES_PASSWORD: mostest, POSTGRES_DB: mattermost_test}
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-retries 20
      redis:
        image: redis:7
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
        with:
          repository: mattermost/mattermost-test-automation-toolkit
          persist-credentials: false
      - run: sudo apt-get install -y postgresql-client redis-tools
      - run: packages/diff-bug-hunter/scripts/install-skill.sh --copy .
      - uses: anthropics/claude-code-action@6d5ae526d25ce88daa2200be073e1a373167f064  # v1.0.265
        env:
          GH_TOKEN: ${{ github.token }}
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            /hunt ${{ github.event.pull_request.number }}
            Append the final report to the file named by $GITHUB_STEP_SUMMARY. Do not comment on the pull request.
          claude_args: --max-turns 300 --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Agent"
```

## Layout

```text
.claude/skills/hunt/
  SKILL.md           the workflow, one script call per step
  RELIABILITY.md     10 diff-triggered Mattermost invariants (Mode A only)
  dispatch.md        the fixed prompt every blind subagent gets
  lessons.jsonl      append-only vetted false-positive patterns (top 5 injected into hunter prompts)
  prompts/           generic Mode A/B, language rules, mutant and strengthen prompts
  scripts/           trusted.py, prepare.py, ctx.py (+ prefilter.py), build_requests.py, reliability.py, run.py,
                     lessons.py, start_pg.sh
.claude/skills/verify/
  SKILL.md           plan, run, iterate (at most 3 runs), report
  scripts/verify_ui.mjs
scripts/install-skill.sh
tests/               self-test: /hunt fixtures (Go bug, React bug, clean control), trusted rules, RELIABILITY
                     triggers, prefilter, lessons, installer, and verify_ui.mjs against a local fixture server
```

Record a lesson only after a diagnostic run proves the false positive:
`.claude/skills/hunt/scripts/lessons.py add '<json>'`.
