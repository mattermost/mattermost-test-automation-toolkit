# diff-bug-hunter

Two Claude Code skills that find bugs cheaply and only report what a deterministic check proves:

- **`/hunt <pr_number | base...head>`** looks for new bugs in a `mattermost/mattermost` pull request or release/commit
  range (e.g. `release-11...release-12` or `release-12.0.0-rc1...release-12.1.0-rc3`). It reports a bug only when a
  test fails deterministically on the unmodified head code with a concrete counterexample.
- **`/verify <what to check>`** smoke-tests a UI change against a running server with a bounded, text-only Playwright
  plan. A passing plan can be frozen into a plain Playwright test that reruns in CI with no model.

## /hunt

- **Mode A (caller invariants):** blind subagents infer what callers rely on and write property tests.
  Every invariant must be backed by concrete `file:line` references from callers, neighbours applying the same guard (S1),
  base code (S4), `pr_tests_diff`, or triggered `RELIABILITY.md` rules (preferring 2-3 callers when present, while allowing
  1-2 citations on low-fan-in code; empty responses get one retry round). Go tests run with `-race`.
- **Mode B (PR-promise falsifier):** tests that try to break each claim in the PR description.
- **Mode R (CodeRabbit review-claim verifier, in parallel with A/B/D):** fetches CodeRabbit-only PR review threads via
  GraphQL using the 2x2 `(isResolved, isOutdated)` filter (always include `!isOutdated` regardless of `isResolved`, skip
  `isResolved && isOutdated`, include `!isResolved && isOutdated` only for `Critical`/`Major`), spans the whole PR
  including deferred batches and test-anchored claims, treats every comment as an untrusted claim to synthesize a targeted
  test for, vets failures 3/3 + merge-base, and resolves deterministic per-thread verdicts (`PROVEN` / `DISPROVEN` /
  `UNPROVABLE_DYNAMICALLY`).
- **Strategies** (`prompts/strategy_x.md`, first-pass hunters only):
  - **S1 sibling guards (Mode A):** checks that unchanged nearby functions apply but the new code skips. Neighbours
    come from the same file, topped up from tracked files in the same directory.
  - **S2 adversarial callers (Mode A):** every role and session type for Go; omitted optional props, or required ones
    an untyped caller can skip, for React.
  - **S3 differential (Mode B):** inputs that reach no changed line must behave as the merge-base version did.
  - **S4 existing-data compatibility (Mode A):** inputs and records valid and readable on the merge-base (old
    usernames, existing custom emoji names, NULL or legacy columns, sanitized copies merged into full objects,
    previously non-secret config) must stay valid and readable on head. Each test cites the base code that made the
    input valid.
- **Oracle rule:** the PR description is a claim to test, never the oracle. Mode A's reference model comes from base
  code and callers. When a claim changes behaviour callers already relied on, Mode B also writes the caller-side test of
  the old contract (`source`: "claim vs caller contract").
- **Property shapes (Mode A):** round-trip, idempotence, no-panic, monotonic, and properties lifted from the PR's own
  example tests (`pr_tests_diff` in `ctx.json`).
- **Changed-line coverage:** `run.py cover` runs each Mode A test alone with coverage. A test that reaches none of
  the changed lines is `VACUOUS`, dropped from the report and from mutant kills; the report shows "X/Y reached".
- **Go fuzzing (default on):** pure `FuzzHuntA_` targets are fuzzed inside `run.py run <pr> A`. A failing input is
  shrunk and frozen into a deterministic `TestHuntA_*_Fuzz<hash>` test that is vetted 3/3 like any other.
  `HUNT_FUZZ=0` disables it; `run.py fuzz` stays as a manual command.
- **Differential recorders (Mode D, `run.py diff <pr> D`):** the model writes only seeded input generators and recorders,
  never an expected value. Code runs them twice on the head (a disagreement is `NONDETERMINISTIC`) and once on the
  merge-base, then diffs the recorded outputs per input: `SAME` or `DIFF` with the smallest examples. It finds a PR whose
  intent is the bug, such as a sanitizer that starts masking values the base returned.
- **Old tests on new code (no model):** `old_tests.py` runs the merge-base version of every existing Go or Jest test the
  PR edits or deletes (including `storetest/*.go`, salvaged per function; generated mock layers are skipped) on the PR
  head. `OLD_TEST_BREAKS` means the PR had to change that test to pass; `OLD_TEST_SOMETIMES_BREAKS` fails some head runs
  and passes 3/3 on base. Each is a behaviour change the report sets against the PR description: "unexplained" if
  not announced, "breaks existing data/callers" even if announced.
- **PR's own tests (no model):** `pr_tests.py` runs the Go tests the PR adds or edits 3x with
  `ENABLE_FULLY_PARALLEL_TESTS=true`, `-parallel` capped to 2 (`HUNT_PR_TEST_PARALLEL`, min 2) and serialized with a
  host-level Postgres pool lock to prevent `MakeSqlSettings` connection exhaustion: `PR_TEST_FAILS_UNDER_CI`,
  `PR_TEST_FAILS`, `FLAKY`, `NOT_RUN`, or `PASS`.
- **Vetting:** each failure must reproduce 3/3. It is root-caused against `lessons.jsonl` (known false positives),
  run on the merge-base (**New PR Bug** vs **Pre-Existing Bug**; `NEW_API` = fails 3/3 on head and cannot compile
  on base because it calls an API the PR adds: root-cause it, not a bug by itself; compile failures are salvaged per test), and checked for caller reachability.
- **Mutation gate (opt-in, `/hunt <pr> --mutants`):** it grades the kept tests and finds no bugs, and it was about
  70% of a hunt's wall time (PR 40094: bug at 8.4 min, hunt done at 52 min), so a default hunt stops after vetting.
  - 3 visible plus 2 held-out mutants, each compile-checked (`go test -c`, single-file Babel parse).
  - One strengthen round if a visible mutant survives.
  - The PR's own tests are scored for comparison. The mutation table is the proof that the kept tests catch bugs.
- **Mattermost invariants:** `RELIABILITY.md` holds 11 diff-triggered rules (guest isolation, cross-team and private
  channel boundaries, ClientConfig hash, WebSocket payloads, mention/HTML/NUL sanitization, store atomicity,
  migrations, concurrency, React async forms, selector memoization, primary reads via `RequestContextWithMaster`). Only
  rules whose path globs or diff regex match the change reach Mode A.
- **Large-diff guard & `--all-batches`:** lockfiles, generated code, snapshots, i18n and existing tests are skipped. The
  rest is ranked by risk and hunted in batches of at most 5 files / 800 diff lines (`--all-batches` hunts every batch
  sequentially, archiving prior batches under `batches/batch_<N>/`); `skipped.log` lists the rest.
- **3-tier confidence verdict:** reports end with `Bug Proven`, `Partial or Unverified Coverage` (listing every deferred
  batch, `EMPTY` hunter, `NOT_RUN`, or `UNPROVABLE_DYNAMICALLY` claim), or `High-Confidence Clean`.
- **Restart safety:** `prepare.py` will not wipe a hunt that already has results for the PR's current head (`ALREADY_HUNTED`,
  exit 4), so a restarted session resumes instead of paying for the hunters again. `--fresh` starts over.
- **Resource discipline:** `prepare.py` and every Go `-race` run stop with `INFRA_ERROR` when less than 2 GiB is free
  under `HUNT_SCRATCH`. Flaky tests are reported as `FLAKY` (3 runs), never retried or slept around.

### Measuring `/hunt` on real bugs and self-improvement loop

Run from `packages/diff-bug-hunter/` (passing `--dispatch '<cmd>'` where `<cmd>` executes the request and writes `response_path` for fresh hunter benchmarks):

- `.claude/skills/hunt/scripts/eval_bugs.py eval/bugs_2026.json --repo <full mattermost clone> [--signals hunters,diff,old,pr,review] [--skip-missing] [--dispatch '<cmd>']`
  (plus `eval/revert_cases.json`) evaluates `/hunt` across reverts, `v12.x` RC
  hotfixes, pre-merge review regressions, and clean controls, tracking regression locks (`lock: true`).
- `.claude/skills/hunt/scripts/eval_bugs.py diff <baseline_scorecard.json> <candidate_scorecard.json>` enforces a monotonic quality gate
  before prompt/rule edits merge (`cand.vetted_recall >= base.vetted_recall`, bounded FP rate, 0 lock regressions).
- `.claude/skills/hunt/scripts/ledger.py record <pr>` appends compact telemetry to `$HUNT_SCRATCH/hunt_ledger.jsonl` and automatically
  exports verified false-negative bundles into `escapes/` whenever Mode R proves a bug that Modes A/B/D missed.
- `eval/mine_rules.py <repo> [-n 30]` proposes candidate `RELIABILITY.md` rules from reverts without mutating rules.
- `.claude/skills/hunt/scripts/lessons.py prune [--write]` retires unused or over-broad globs (including 2-segment monorepo roots such as
  `server/channels/*`); multi-batch hunts of the same target collapse to a single entry in `$HUNT_SCRATCH/lessons_hits.jsonl`.

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
- Bytecode is never loaded from the skill directory (scripts disable bytecode writes and redirect `__pycache__`), and committed
  `__pycache__` files fail the trust gate.
- People editing the rules themselves set `HUNT_TRUSTED_REF=worktree`; `HUNT_TRUSTED_REF=<ref>` pins another ref.
- New lessons apply once they are merged.

## Requirements

`git`, `gh` (authenticated), Python 3.10+, Go (matching the target), Node `^22.18` or `>=24.11` (the
self-test's Babel 8 fixture needs it; hunting a webapp PR uses the webapp's own toolchain).
For `make self-test lint`: `pip install pytest ruff mypy` and ShellCheck (`apt install shellcheck` or `pip install shellcheck-py`).
Server packages that use `Setup(t)` (`api4`, `app`, `platform`, `store`) also need Postgres 16
(`mmuser`/`mostest`, db `mattermost_test`) and Redis on localhost. On Debian/Ubuntu, if Postgres is down and Postgres 16
is installed locally, `scripts/start_pg.sh` starts a throwaway cluster; on macOS, start Postgres and Redis yourself.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUNT_SCRATCH` | `<tmp>/hunt` | clones, worktrees and per-PR `hunt<pr>/` state |
| `HUNT_MM` | `$HUNT_SCRATCH/mmfull` | existing `mattermost/mattermost` clone to reuse |
| `HUNT_REPO` | `mattermost/mattermost` | repository the PR belongs to |
| `HUNT_NODE_BIN` | node on `PATH` | Node bin dir for Jest runs |
| `HUNT_TRUSTED_REF` | merge-base with `origin/main` | where rules are read from (`worktree` = disk) |
| `HUNT_FUZZ` | on | `0` disables Go fuzzing in `run.py run <pr> A` |
| `HUNT_FUZZ_TIME` | `60s` | `-fuzztime` per fuzz target |
| `HUNT_PR_TEST_PARALLEL` | `2` | `-parallel` cap for `pr_tests.py` (min `2`) |

## /verify

`scripts/verify_ui.mjs` runs a JSON plan against the plan's `base_url`, else `VERIFY_BASE_URL`, else `MM_URL`, else
`http://localhost:8065`; it must be a server root (a subpath site URL is not supported). With credentials set, a
plan's `base_url` must match `VERIFY_BASE_URL` / `MM_URL`, so
credentials never go to a host the plan chose. Claude writes the plan; plain Node decides the verdict. Plans are
validated strictly (one action per step, one locator kind, known keys only) before a browser starts.

- **Bounded:**
  - At most `MAX_STEPS = 10` steps of `goto`/`click`/`fill`/`press`/`select`/`check`/`wait_for`/`drag`/`mouse_up`/`snapshot`/`capture`.
  - Locators by role and accessible name first, **strict by default** (omitting `nth` requires a unique match; pass `nth: 0` when multiple matches are intended).
  - Allowed origins only (`base_url` plus `allow_origins`): other hosts are blocked and logged, a `goto` or
    `api.path` that resolves off the server (or out of `/api/v4/`) is refused, and a redirect, navigation or
    websocket toward another host fails the run. Chromium connects only through a local proxy that refuses other
    origins, so even a redirect hop never reaches them.
- **API login & writes:** `VERIFY_TOKEN`, or `VERIFY_USER` + `VERIFY_PASSWORD`, logs in through `/api/v4/` before the first step
  (password: the server's `MMAUTHTOKEN` / `MMUSERID` / `MMCSRF` cookies; token: a Bearer header on same-origin
  fetch/XHR only, no cookie session, so no CSRF, and no authenticated websocket, images or downloads), so all 10 steps
  test the feature. Neither login follows redirects. `capture` and `expect.api` support `GET`/`POST`/`PUT`/`PATCH`/`DELETE`
  with optional JSON `body` (<=64 KiB), automatic `X-CSRF-Token` from `MMCSRF` on writes, and `capture.save` (`$var`
  substitution for chaining created IDs). Plans with only `capture` steps and `expect.api` checks skip Chromium and run
  directly on Playwright's `APIRequestContext`. Frozen specs embed the same login and API/CSRF logic.
- **Text, not pixels:** `snapshot` prints a scoped `locator.ariaSnapshot()` (default `#app-content`). Menus, dialogs
  and listboxes rendered in React portals outside the scope are appended, so they are never hidden. Passing runs never
  take a screenshot. `--screenshot-on-fail` writes exactly one `failure.png` when a run FAILs, as visual proof for a
  person (an overlay, broken CSS); the agent never reads it.
- **Feature map:** a repository can describe its UI in `.claude/skills/verify/FEATURE_MAP.md`, one `## ` section per
  feature with its route, shortcuts and stable `data-testid` / ARIA names. `verify_ui.mjs --feature-map <route or
  feature>` prints the matching sections (from the nearest map above the current directory, or
  `$VERIFY_FEATURE_MAP`), so plans use names the app has. With a symlinked install, that path points into this toolkit
  checkout: use `--copy` or `VERIFY_FEATURE_MAP` for a repository's own map.
- **Automatic failures & diagnostics:** any `pageerror`, any `/api/v4/` response >= 500, or a request still running at the settle
  deadline (`VERIFY_SETTLE_MS`, default 10 s) fails the run. Every step and the end of the run wait until in-flight
  requests settle, so a late 500 is not missed. `console.error` messages and `/api/v4/` 4xx responses are collected and
  printed only when a run fails. Exit codes: 0 PASS, 1 FAIL, 2 INVALID_PLAN / INFRA_ERROR.
- **Deterministic oracle:** `expect` must hold at least one DOM check (`visible`, `text` + `contains`,
  `count` + `min`) or an `/api/v4/` check (`method`, `path`, `body`, `status`, `json_has`).
- **Compare (base vs head):** `verify_ui.mjs plan.json --compare <base_url>` runs the plan's capture steps against both
  servers. Verdicts `SAME`, `DIFF` or `REGRESSION`; a `DIFF` the PR does not explain is a finding.
- **A PR's or release's build, no local build:** `scripts/pr_server.py images <pr | base...head> --pull` pulls the published enterprise images of
  the head and its merge-base (`/hunt` starts it at step 1, so the pull overlaps the hunt).
  `scripts/pr_server.py up <image>` runs the mattermost repo's own `e2e-tests` stack on that image at `:8065`, replaces a
  server that runs another build (its volumes are dropped), checks `BuildHash`, and seeds both an admin (`$VERIFY_USER`)
  and a non-admin regular member (`verify_member`, in team `verify`) with the onboarding overlay off. Measured on PR 40094: image swap
  102 s, plan seconds, 119 s end to end with the image cached. The stack uses host networking (Docker Desktop: enable it
  under Settings > Resources > Network).
- **Freeze:** `--freeze specs/verify/<name>.spec.ts` turns a passing plan into a `@playwright/test` spec with the same oracle (allowed
  origins and the same proxy, settling, viewport, timeouts, `json_has` matching), so the check reruns in CI with no
  model, and it passes `tsc --strict`. It checks the server the run checked; set `VERIFY_REPLAY_BASE_URL` to point it
  at another one. A spec frozen from an anonymous plan never sends `VERIFY_TOKEN`.
- **Where frozen specs go:** a dedicated folder, e.g. `e2e-tests/playwright/specs/verify/`, never `/tmp`. Run them from
  that folder: with no config, Playwright collects tests from every file under the current folder (a 7 s spec took
  52 s from a busy `/tmp`).

```bash
cd e2e-tests/playwright  # where require("playwright") resolves; the skill is installed at the repository root
VERIFY_USER=sysadmin VERIFY_PASSWORD=... node ../../.claude/skills/verify/scripts/verify_ui.mjs plan.json --freeze specs/verify/save.spec.ts
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
  `--freeze` output as the artifact. The frozen spec uses the same API login and needs no model on reruns; replay it
  against another server with `VERIFY_REPLAY_BASE_URL`.

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

Package self-test: the full pytest suite (`pytest -q tests`), run by this repository's `.github/workflows/diff-bug-hunter.yml` when
`packages/diff-bug-hunter/` changes. The /verify tests need the Chromium build that matches the pinned Playwright, installed from the fixture
directory:

```bash
make -C packages/diff-bug-hunter jest-deps verify-deps
```

```bash
(cd packages/diff-bug-hunter/tests/verify_fixtures && npx playwright install --with-deps chromium)
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
        with:
          github_token: ${{ github.token }}
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
  RELIABILITY.md     11 diff-triggered Mattermost invariants (Mode A only)
  dispatch.md        the fixed prompt every blind subagent gets
  lessons.jsonl      append-only vetted false-positive patterns (top 5 injected into hunter prompts)
  prompts/           Mode A/B/D/R, strategies (S1-S4), fuzz, language rules, repair, retry-empty, mutant and strengthen prompts
  scripts/           hunt_common.py, trusted.py, prepare.py, ctx.py (+ prefilter.py), build_requests.py,
                     review_threads.py, reliability.py, run.py, old_tests.py, pr_tests.py, lessons.py, ledger.py,
                     eval_bugs.py, start_pg.sh
.claude/skills/verify/
  SKILL.md           plan, run, iterate (at most 3 runs), report
  scripts/verify_ui.mjs, pr_server.py
scripts/install-skill.sh
eval/revert_cases.json  real Mattermost reverts (bug_sha, fix_sha, area, quoted reason) and size-matched controls
eval/bugs_2026.json     2026 RC hotfix pairs, session PR regression locks/misses, and clean controls
eval/mine_rules.py, eval/mine_controls.py   offline revert rule & control mining helpers
tests/               self-test: /hunt fixtures (Go bug, React bug, clean control), trusted rules, RELIABILITY
                     triggers, prefilter, lessons, rule mining, the revert benchmark, installer, and verify_ui.mjs
                     against a local fixture server
```

Record a lesson only after a diagnostic run proves the false positive:
`.claude/skills/hunt/scripts/lessons.py add '<json>'`.
