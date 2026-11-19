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
- A skill copy that is not tracked by any repository (an uncommitted `--copy`) is read from disk: no pull request can
  change it. A symlink install (the installer's default) resolves into this toolkit checkout, where the skill is
  tracked, so its rules come from the toolkit's `origin/main`: keep that checkout on `origin/main` (fetched), or use
  `--copy`.
- Bytecode is never loaded from the skill directory (each script keeps its cache in a private temp dir), and committed
  `__pycache__` files fail the trust gate.
- People editing the rules themselves set `HUNT_TRUSTED_REF=worktree`; `HUNT_TRUSTED_REF=<ref>` pins another ref.
- New lessons apply once they are merged.

## Requirements

`git`, `gh` (authenticated), Python 3.10+, Go (matching the target), Node `^22.18` or `>=24.11` (the
self-test's Babel 8 fixture needs it; hunting a webapp PR uses the webapp's own toolchain).
For `make self-test lint`: `pip install pytest ruff mypy` and ShellCheck (`apt install shellcheck` or `pip install shellcheck-py`).
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

`scripts/verify_ui.mjs` runs a JSON plan against the plan's `base_url`, else `VERIFY_BASE_URL`, else `MM_URL`, else
`http://localhost:8065`; it must be a server root (a subpath site URL is not supported). With credentials set, a
plan's `base_url` must match `VERIFY_BASE_URL` / `MM_URL`, so
credentials never go to a host the plan chose. Claude writes the plan; plain Node decides the verdict. Plans are
validated strictly (one action per step, one locator kind, known keys only) before a browser starts.

- **Bounded:**
  - At most `MAX_STEPS = 10` steps of `goto`/`click`/`fill`/`press`/`select`/`check`/`wait_for`/`snapshot`.
  - Locators by role and accessible name first.
  - Allowed origins only (`base_url` plus `allow_origins`): other hosts are blocked and logged, a `goto` that leaves
    the server is refused, and a redirect, navigation or websocket that reaches another host fails the run.
- **API login:** `VERIFY_TOKEN`, or `VERIFY_USER` + `VERIFY_PASSWORD`, logs in through `/api/v4/` before the first step
  (password: the server's `MMAUTHTOKEN` / `MMUSERID` / `MMCSRF` cookies; token: a Bearer header on same-origin
  fetch/XHR only, no cookie session, so no CSRF, and no authenticated websocket, images or downloads), so all 10 steps
  test the feature. Neither login follows redirects. Frozen specs embed the same login.
- **Text, not pixels:** `snapshot` prints a scoped `locator.ariaSnapshot()` (default `#app-content`). Menus, dialogs
  and listboxes rendered in React portals outside the scope are appended, so they are never hidden. The runner never
  takes screenshots.
- **Automatic failures:** any `pageerror`, any `/api/v4/` response >= 500, or a request still running at the settle
  deadline (`VERIFY_SETTLE_MS`, default 10 s) fails the run. Every step and the end of the run wait until in-flight
  requests settle, so a late 500 is not missed. Exit codes: 0 PASS, 1 FAIL, 2 INVALID_PLAN / INFRA_ERROR.
- **Deterministic oracle:** `expect` must hold at least one DOM check (`visible`, `text` + `contains`,
  `count` + `min`) or an `/api/v4/` read (`status`, `json_has`).
- **Freeze:** `--freeze out.spec.ts` turns a passing plan into a `@playwright/test` spec with the same oracle (allowed
  origins, settling, viewport, timeouts, `json_has` matching), so the check reruns in CI with no model. It reads
  `VERIFY_BASE_URL` / `MM_URL` first, so one frozen spec can target another server, and it passes `tsc --strict`.

```bash
VERIFY_USER=sysadmin VERIFY_PASSWORD=... node .claude/skills/verify/scripts/verify_ui.mjs plan.json --freeze save.spec.ts
```

Run it where `require("playwright")` resolves (e.g. `mattermost/e2e-tests/playwright`), or set `NODE_PATH`.

### Running against Testcontainers, Docker or a Cursor Automation

`/verify` needs only a reachable server and credentials (`VERIFY_BASE_URL`, plus `VERIFY_TOKEN` or `VERIFY_USER` /
`VERIFY_PASSWORD`).

- **Mattermost Testcontainers** (`mattermost/mattermost`, `e2e-tests/playwright`):

  ```bash
  cd e2e-tests/playwright && npm run tc:up      # SERVER_IMAGE=mattermostdevelopment/mattermost-enterprise-edition:<tag> for a PR/release build
  export VERIFY_BASE_URL=http://localhost:8055  # tc:up publishes Mattermost on the fixed host port 8055
  export VERIFY_PASSWORD='choose-a-strong-one'
  # tc:up starts a fresh server with no users; on a fresh server the first user created becomes system admin:
  curl -sf -X POST "$VERIFY_BASE_URL/api/v4/users" -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","username":"sysadmin","password":"'"$VERIFY_PASSWORD"'"}'
  export VERIFY_USER=sysadmin
  ```

  Run `verify_ui.mjs` from `e2e-tests/playwright`, where `require("playwright")` resolves, and finish with
  `npm run tc:down`.
- **Docker:** `docker run -d -p 8065:8065 mattermost/mattermost-preview`, then the same user bootstrap against
  `http://localhost:8065`.
- **Cursor Automation (PR or release check):** start the stack as above, install the skill
  (`install-skill.sh --copy`), let the agent run `/verify <behaviour>` with the `VERIFY_*` secrets set, and keep
  `--freeze` output as the artifact. The frozen spec uses the same API login and needs no model on reruns.

## Install and run locally

```bash
packages/diff-bug-hunter/scripts/install-skill.sh ~/src/mattermost
```

That symlinks `.claude/skills/hunt` and `.claude/skills/verify` into the target repository and git-ignores them
locally (the ignore entry lives in the repository's shared `info/exclude`, so it covers every worktree). /hunt then
reads its rules from this toolkit checkout's base branch (see "Rules come from the base branch"). Use `--copy` to vendor a snapshot you can commit (plugins, forks), `--skill hunt|verify` to install one, and
`--force` to replace an existing install. Then, in Claude Code inside that repository:

```text
/hunt 40148
/verify the channel header edit dialog saves and shows the new header
```

Webapp PRs run `npm ci` once in the PR worktree's `webapp/` (`prepare.py` does it); the merge-base worktree reuses
those `node_modules` unless the PR changes `package-lock.json`.

## CI integration

Package self-test (runs in this repository's `.github/workflows/diff-bug-hunter.yml` when `packages/diff-bug-hunter/`
changes). The /verify tests need the Chromium build that matches the pinned Playwright, installed from the fixture
directory:

```bash
make -C packages/diff-bug-hunter jest-deps verify-deps
```

```bash
cd packages/diff-bug-hunter/tests/verify_fixtures && npx playwright install --with-deps chromium
```

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
