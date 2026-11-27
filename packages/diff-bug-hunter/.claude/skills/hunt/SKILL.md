---
name: hunt
description: Blind Mode A (caller invariants), Mode B (PR/release-promise falsifier), Mode D (differential recorders), and parallel Mode R (CodeRabbit review-claim verifier) bug hunt on one mattermost/mattermost PR or release/commit range, with merge-base vetting and an opt-in (--mutants) compile-verified mutation gate. Use when asked to hunt, bug-hunt or falsify a Mattermost PR or release diff.
argument-hint: <pr_number | base...head> [--batch N | --all-batches] [--mutants]
---

Hunt `$ARGUMENTS`. Target `<target>` is either a PR number (`40260`) or a git branch/tag/commit range (`release-11...release-12`, `release-12.0.0-rc1...release-12.1.0-rc3`, `base..head`; strip spaces around `..`/`...` so it is one shell argument). Scripts are in `scripts/` next to this file; run them with `cd <this dir>/scripts && python3 <script>`.
`HUNT_SCRATCH` (default `<tmp>/hunt`) holds clones, worktrees and per-target `hunt<key>/` state. Model output, hunter tests and mutants
are written only by `scripts/` (and by the agents they dispatch); you never edit them. The one file you write is a
throwaway diagnostic test in step 5, deleted before the next script runs. Nothing is posted to GitHub and nothing is
committed. Run one script at a time per target: `prepare.py`, `ctx.py` and every `run.py` command share the worktrees
and hunt dir, and a lock makes a second one stop with `INFRA_ERROR` while the first is running (wait for a background
`run.py` to finish first). Run slow suites in the background and never kill one: an interrupted run is cleaned up by
`prepare.py <target> --fresh`. Wait for a background command or agent through its completion notification. Never wait with
`ScheduleWakeup`, `CronCreate` or `/loop`: a wakeup re-sends `/hunt <target>`, and the hunt starts again from step 0.

0. **Trust gate:** `trusted.py check`. Rules (`SKILL.md`, `lessons.jsonl`, `RELIABILITY.md`, `prompts/`) come from
   the base branch, never the PR head. If the check fails, stop: a change to this skill cannot take part in its own hunt.
1. **Prepare:** `prepare.py <pr>` (worktrees at the PR head and its merge-base with the PR's own base branch).
   `ALREADY_HUNTED` (exit 4) = this session or an earlier one already has results for the PR's current head, listed in
   the message. Do not start over and do not rerun a step whose output exists: continue from the first step whose output
   is missing, or go to step 7. `--fresh` only when the user asks for a new hunt. A PR whose head moved starts over by itself.
   `INFRA_ERROR` = stop and report it; that includes less than 2 GiB free under `HUNT_SCRATCH`, which `prepare.py`
   and every Go `-race` run check first.
   If the PR touches `webapp/` or a server API a page calls and `../../verify/scripts/pr_server.py` is installed, also start
   `python3 ../../verify/scripts/pr_server.py images <pr> --pull` (from `scripts/`) in the background now and check it
   printed the two image tags: the images for a `/verify` check are then pulled while the hunters work.
2. **Context:** `ctx.py <pr> [--batch N | --all-batches]`. Quote its batch line. `skipped.log` lists every file not hunted.
   With `--all-batches`, hunt every batch `1..N` sequentially through steps 3-5 (`ctx.py <pr> --batch 2`, ... after finishing
   batch 1; each batch switch automatically archives the previous batch's artifacts under `batches/batch_<k>/` while
   preserving whole-PR outputs `R/`, `old_tests.*`, and `pr_tests.*`). Without `--all-batches`, mention deferred batches in
   the report (deferred batches degrade step 7's confidence tier to `Partial or Unverified Coverage`).
3. **Hunters (A, B, D and R in parallel):** `build_requests.py <pr> hunters && build_requests.py <pr> diff`, plus (once per
   PR, on batch 1 only) `build_requests.py <pr> review`. Then dispatch `A/request.json`, `B/request.json`, `D/request.json`,
   and `R/request.json` (when written; skipped automatically for range targets or PRs with 0 qualifying CodeRabbit threads)
   in parallel. Also once per PR (whenever `pr_tests.json` / `old_tests.json` are missing), start
   `pr_tests.py <pr>; old_tests.py <pr>` as one chained background job while A/B/D/R think (they lock `wt` / `all` and
   do not need hunter outputs; wait for them to finish before step 4's `run.py`).
   Modes A and B also get `prompts/strategy_x.md` (Mode A: S1 sibling guards, S2 adversarial callers and props, S4 existing-data compatibility; Mode B: S3
   merge-base differential) and the context it reads: `neighbors_same_file` (unchanged functions near the change, from
   the same file, topped up from the same directory) and `changed_functions_base_source`. Strengthen and repair rounds
   get the context but not `strategy_x.md`; mutant planters get neither.
   Mode A's reference models come from base code and callers, never from the PR description; Mode B treats the
   description as a claim to test, and adds a caller-side "claim vs caller contract" test where a claim changes
   behaviour callers relied on.
   Mode A also gets the `RELIABILITY.md` rules this diff triggers; Mode B, Mode D, Mode R and mutant planters never do. Mode D
   writes only seeded input generators and recorders (no assertion, no expected value, nothing taken from the PR
   description). Mode R fetches CodeRabbit-only PR review threads via GraphQL using the 2x2 `(isResolved, isOutdated)` filter
   (always include `!isOutdated` regardless of `isResolved`; skip `isResolved && isOutdated`; for `!isResolved && isOutdated`
   include only `Critical`/`Major`), spans the whole PR (including batch 2+ files and test-anchored claims), treats every
   CodeRabbit comment as an untrusted claim to synthesize a targeted test for, and marks claims untestable in this harness
   (e.g. replica lag without a store mock) as `testable: false` instead of emitting fake-passing tests. Each goes to a fresh
   Agent with no messaging/MCP tools, prompted with `dispatch.md` (next to this file) and `{REQ}` = the path.
4. **Run:** `run.py run <pr> A`, `run.py run <pr> B`, `run.py diff <pr> D`, and (once per PR, when `R/request.json` was
   dispatched) `run.py run <pr> R` (one `wt`-locking script at a time; `run.py base <pr> <tag>` uses the separate `wt_base`
   lock and can run concurrently alongside `run.py run <pr> <next_tag>` for Jest and non-stateful Go packages, while
   stateful Mattermost Go packages `api4`/`app`/`store`/`web`/`wsapi` serialize on the host Postgres lock when
   `ENABLE_FULLY_PARALLEL_TESTS` is not `true`, and `run.py diff <pr> D` locks both worktrees).
   - `EMPTY_RESPONSE` on Mode A (0 test files emitted on a batch with changed source files): one retry round.
     `build_requests.py <pr> retry A`, dispatch `A/request.retry.json` to a fresh agent, rerun `run.py run <pr> A`. Still
     empty = record Mode A as `EMPTY` (degrades step 7 confidence tier).
   - `COMPILE_ERROR` (exit 3) on `A`, `B`, `D`, or `R`: one repair round. `build_requests.py <pr> repair <tag>`, dispatch
     `<tag>/request.repair.json` to a fresh agent, rerun. Still broken = report the hunter as failed.
   - `INFRA_ERROR` (exit 2): fix the environment and rerun. Never report it as "no findings".
   - A `FLAKY` test is reported as flaky. Never retry it, add sleeps, or raise `-count` to make it pass.
   - Fuzzing runs inside `run.py run <pr> A` when Mode A wrote `FuzzHuntA_` targets (pure Go functions only). A failing
     input is shrunk and frozen into `TestHuntA_<Name>_Fuzz<hash>` in `A/response.json`, then vetted 3/3 like any test.
     `HUNT_FUZZ=0` disables it; `HUNT_FUZZ_TIME` (default 60s) sets `-fuzztime`. `run.py fuzz <pr> A` stays as a manual command.
   - Then `run.py cover <pr> A`: each Mode A test runs alone with coverage (no `-race`). A test that reaches none of the
     PR's changed lines is `VACUOUS`: it is listed as dropped and kills no mutant. A `VACUOUS` test that failed 3/3 is
     still vetted in step 5. `UNKNOWN` (no profile) is never dropped. Mode B is not covered: its S3 tests stay off the
     changed lines on purpose.
   - Once per PR, read the results of the step-3 `old_tests.py` / `pr_tests.py` background job (not repeated across `--all-batches` iterations):
     - `old_tests.py <pr>` (no model): old tests on new code, covering `storetest/*.go` and `searchtest/*.go`, with
       per-function salvage; generated mock layers are skipped. `OLD_TEST_BREAKS` = the PR had to change that test to pass.
       `OLD_TEST_SOMETIMES_BREAKS` = fails some head runs but passes 3/3 on the merge-base. Both are behaviour changes, not
       yet bugs: step 7 sets them against the PR description. `OLD_TEST_UNCOMPILABLE` (the head API no longer fits the old
       test) and `PRE_EXISTING` are listed, not reported as findings.
     - `pr_tests.py <pr>` (no model): the PR's own added or edited Go tests run 3x with
       `ENABLE_FULLY_PARALLEL_TESTS=true`, `-parallel` capped to 2 (`HUNT_PR_TEST_PARALLEL`, min 2) and serialized via a
       host-level Postgres pool lock to prevent `MakeSqlSettings` connection exhaustion. Verdicts: `PR_TEST_FAILS_UNDER_CI`,
       `PR_TEST_FAILS`, `FLAKY`, `PASS`, `NOT_RUN`.
   - `run.py diff <pr> D` runs the Mode D recorders twice on the PR head and once on the merge-base, and code diffs the
     records per input. Verdicts per recorder: `SAME`, `DIFF` (up to 5 smallest examples: `input`, `base`, `head`),
     `NONDETERMINISTIC` (the two head runs disagree: records dropped), `BASE_UNCOMPILABLE` / `BASE_FAILED` (that
     recorder cannot run on the merge-base: decide from the diff), `RECORDER_FAILED`, `NO_RECORDS`. Files:
     `diff_D.json`, `diff_D.examples.json`.
5. **Vet every `FAIL_3_OF_3` (from A, B, and R):**
   - Root-cause it with a throwaway diagnostic test, then delete it (`run.py` refuses to run on a dirty worktree).
   - `lessons.py match <scratch>/hunt<pr>/ctx.json` lists known false positives. If it is one, drop it.
   - `run.py base <pr> <tag>` (for `A`, `B`, `A2`, `R`) gives `NEW_PR_BUG`, `PRE_EXISTING`, `NEW_API`, `BASE_FAILS_DIFFERENTLY`
     (decide that one from the diff, as for `NOT_RUN_ON_BASE`). `NEW_API` = fails 3/3 on head and cannot compile on base
     because it calls an API the PR adds: root-cause it, it is not a bug by itself, and pair it with a passing nearby control input on the same new API so you prove the test harness works. Compile failures are salvaged per test,
     not per file; `NOT_A_HEAD_FAILURE` means there is nothing to vet.
   - Once Mode R has run (and after `run.py base <pr> R` if any Mode R test failed `FAIL_3_OF_3`), run
     `review_threads.py verdicts <pr>` to write deterministic per-thread verdicts (`PROVEN` / `DISPROVEN` /
     `UNPROVABLE_DYNAMICALLY`) into `review_verdicts.json`.
   - Confirm a real caller (HTTP, websocket, plugin API, UI) reaches the input. If none does, it is a caller-unreachable nit.
   - A newly vetted false-positive pattern: `lessons.py add '<json>'`. Hunters see it once it is merged to the base
     branch; until then it stays in the working copy without blocking the trust gate.
6. **Mutation gate**, only when the arguments include `--mutants` and Mode A has passing tests. It grades the kept
   tests and finds no bugs, and it is most of a hunt's wall time. Without `--mutants`, skip this step and go to step 7.
   - Planting: `build_requests.py <pr> mutants`, dispatch it, then `build_requests.py <pr> heldout`, dispatch it.
     Never show M or M2 to a hunter.
   - Score: `run.py mutants <pr> A`. Each mutant's `go test` gets `-timeout` = max(60 s, 5x the unmutated run of that
     package); a mutant that hangs a test past it is `KILLED` by `(package failed)`.
   - `NEEDS_REGENERATION`: `build_requests.py <pr> regen <id> <tag>` (the score that reported it), dispatch it once, then rescore. Still broken = dropped.
     `ERROR` = that mutant hit an environment failure; rerun once, then report it as unscored.
   - Any of M1-M3 `SURVIVED`: `build_requests.py <pr> strengthen M1,..` (it also passes the changed lines `cover`
     found unreached), dispatch it, then `run.py run <pr> A2`, `run.py cover <pr> A2` and `run.py mutants <pr> A2`.
     Unreached lines alone never start a strengthen round.
   - Always also run `run.py mutants <pr> PR` (a PR without tests in the hunted packages scores every mutant `SURVIVED`).
7. **Report in chat only:**
   - **Verdict (3-tier confidence — never use a bare binary "Clean"):**
     - **`Bug Proven`** — at least one vetted `NEW_PR_BUG` (from Mode A, B, or R; note that a Mode R `PROVEN` thread with
       `base_verdict == "PRE_EXISTING"` reports under **Pre-Existing Bug** and does **not** escalate the PR's overall
       verdict to `Bug Proven`), an unannounced / existing-data-breaking /
       normalization-breaking `OLD_TEST_BREAKS` / `OLD_TEST_SOMETIMES_BREAKS` / Mode D `DIFF`, a `PR_TEST_FAILS_UNDER_CI`,
       or a confirmed `/verify` `REGRESSION` / unexplained `DIFF`.
     - **`Partial or Unverified Coverage`** — no bug proven, AND at least one coverage gap occurred: any batch deferred
       (`batch 1/N` with `N > 1` without `--all-batches`), any hunter `EMPTY` or failed repair, any `NOT_RUN` / `INFRA_ERROR`
       / `BASE_UNCOMPILABLE` / `BASE_FAILED` / `RECORDER_FAILED` / `NO_RECORDS` / `NONDETERMINISTIC` / `FLAKY` /
       `PR_TEST_FAILS` / unresolved `NEW_API`, any Mode R thread `UNPROVABLE_DYNAMICALLY` (including `UNVETTED`), or Mode A
       `0/Y` changed lines reached (`Y > 0`). List every
       specific gap explicitly so a reviewer knows exactly what was not proven clean.
     - **`High-Confidence Clean`** — no bug proven, AND every batch ran, Modes A/B/D (and R when qualifying threads exist)
       completed without `EMPTY`/compile/infra errors, `old_tests.py` and `pr_tests.py` had no `NOT_RUN`/flaky/failure, zero
       Mode R threads remained `UNPROVABLE_DYNAMICALLY`, and Mode A reached changed lines (`reached > 0` when `executable > 0`).
   - **New PR Bug** (`NEW_PR_BUG`, root-caused, from Mode A, B, or R) / **Pre-Existing Bug** (including any Mode R `PROVEN`
     thread with `base_verdict == "PRE_EXISTING"`) / **Caller-unreachable nit**,
     each with its exact test command, counterexample, root cause `file:line` and the caller that reaches it.
   - **CodeRabbit review-claim verdicts (Mode R)**: from `review_verdicts.json`, one row per qualifying thread (`CR1..CRk`)
     showing `path:line`, triage (`open_current` / `resolved_not_outdated` / `open_outdated_high_severity`), severity,
     verdict (`PROVEN` [+ `base_verdict`] / `DISPROVEN` / `UNPROVABLE_DYNAMICALLY`), test name(s), and reason, plus count of
     skipped threads (e.g. `resolved and outdated`). A `PROVEN` thread with `base_verdict == "PRE_EXISTING"` reports under
     **Pre-Existing Bug** rather than escalating the PR's overall verdict to `Bug Proven`; an unvetted failing head test
     (missing or stale `base_R.json`) stays `UNPROVABLE_DYNAMICALLY` (`UNVETTED`) until `run.py base <pr> R` runs. Skip
     section for range targets.
   - **Behaviour change the PR's tests absorbed**: each `OLD_TEST_BREAKS` / `OLD_TEST_SOMETIMES_BREAKS` with its failure
     text from `old_tests.messages.json`. If the PR description does not announce that change, mark it **unexplained**
     (that is how a bug in the PR's intent shows up, which hunters cannot see). Mark it **breaks existing data/callers**
     even when announced.
   - **Behaviour diff on generated inputs**: each `DIFF` from `run.py diff`, with its smallest example (input, base, head),
     and whether the PR description announces that change. Do **not** dismiss a `DIFF` as "announced" solely because the PR
     announces restricting or changing that field or function — inspect the actual differing input(s) (and
     `diff_D.head.jsonl` / `diff_D.base.jsonl` beyond the top 5 if needed). A `DIFF` is **still a finding even when the
     feature change is announced** if the differing input is:
     (a) a normalization-equivalent, no-op, sparse/partial-patch, default, or legacy-alias value (e.g. `""`, `nil`, zero
     value, omitted optional field, or old default constant that `SetDefaults()`/sanitization normalizes to the unchanged
     effective value),
     (b) data callers already stored (settings, records, IDs a caller still holds), or
     (c) an input outside the announced scope/condition.
     Only dismiss an announced `DIFF` after confirming the counterexample genuinely crosses the announced semantic boundary
     (or fixes a crash where base panics and head returns a value).
   - **PR tests failing under CI flags**: each `PR_TEST_FAILS_UNDER_CI` / `PR_TEST_FAILS` / `FLAKY` / `NOT_RUN` from `pr_tests.py`.
   - **New-API failures to root-cause**: each `NEW_API`.
   - **UI/API base-vs-head diffs**: `/verify` compare runs (`verify_ui.mjs plan.json --compare <base_url>`, capture steps,
     verdict `SAME` / `DIFF` / `REGRESSION`). A `DIFF` the PR does not explain is a finding. Skip when the PR has no UI/API surface.
   - One line per dropped artifact (and per batch when `--all-batches` ran).
   - **Mutation table** M1-M5 x (A, A2, PR), the proof that the kept tests catch bugs, and under it "changed lines
     reached: X/Y" for A and A2. Without `--mutants`: one line "Mutation gate: not run (pass --mutants)", plus
     "changed lines reached: X/Y" for A. That is a floor, not a quality score: never report it as a percentage.
   - If there is a New PR Bug, offer a review-comment draft. Never post it.
   - **Ledger telemetry**: run `<skill>/scripts/ledger.py record <pr>` after presenting the report so Mode counts,
     coverage floor, confidence tier, and any Mode R escape bundle append to `$HUNT_SCRATCH/hunt_ledger.jsonl` (default `<tmp>/hunt/hunt_ledger.jsonl`).

## Unattended driver

`/hunt` above stays the interactive path. For an unattended run, `scripts/hunt.py <target> [--fresh] [--force] [--modes A,B,D,R] [--no-prompt-cache]` drives the same
scripts as a state machine and calls the model only through `scripts/dispatch.py` (one request file in, one
`response.json` out). Stages: prepare, ctx, requests, dispatch (default modes A, B, and R when threads exist, in parallel;
Mode D is opt-in via `--modes A,B,D`), run (A with one empty
retry, B, diff D when requested, R; one repair round on `COMPILE_ERROR`), base, old_tests, pr_tests, vet_v (Mode V diagnostics for the
A/B `NEW_PR_BUG` candidates, then `run.py run|base <target> V`), vet (skeptic writes `vetted.json`), verdict, report.
Run it again to resume: a stage whose output exists is skipped, and dispatch is idempotent per request sha. Completed hunts
for the same `(target, head, merge_base, prompt_version)` skip cleanly (exit 0) unless `--force` or `--fresh` is passed;
docs-only and test-only diffs skip cleanly with exit 0 and zero model calls.

- The dispatch command environment variable (named in `scripts/dispatch.py`) replaces the model call (`<cmd> <request.json>`; the response goes to the request's
  `response_path`). Unset, it runs `claude -p --output-format json --tools ''` with `--model` mapped from each request's effort tier (hunters and Mode V default to Sonnet; the skeptic runs on Opus, with at most 1 mechanical Opus escalation per hunt logged in `driver.json` on schema/retry failure, `max_tokens`, ungrounded `file:line` citation, or empty output on a risky file): one inline turn with the request's System
  section as system prompt and its User and Schema sections on stdin, no tools, and the printed answer written by the
  script. Set `DISABLE_PROMPT_CACHING=1` or pass `--no-prompt-cache` to opt out of prompt caching per dispatch. At most 8 calls run at once per machine (the limit's variable is named in `scripts/dispatch.py`). Transient failures
  (5xx, `upstream_unreachable`, `overloaded`) retry up to 5 times with backoff, 1 s doubling to 60 s.
- Head runs: each test runs once; only failures rerun to 3/3. A test that passes first and fails later is recorded
  PASS, not FLAKY, so that flake does not lower the tier.
- Budget: once a hunt's calls cost $8 (the variable is named in `scripts/hunt.py`), no further call is made; the hunt
  ends Partial with a `budget` gap.
- Skeptic: every drop carries `reason_code` and `evidence_quote`; a quote not found verbatim in the request turns the
  drop into a held row (`verdict.check_drop`). Calibrate prompt or model changes with `scripts/skeptic_eval.py`
  (hand-labelled rows in `eval/skeptic/`; one model call per fixture).
- Outputs: `findings.json` (author-facing KEEP items grouped by root cause, `finding.schema.json`), `audit.md` (tier, gaps, HELD with
  reasons, mutation gate not run, telemetry per stage), `telemetry.jsonl` (wall seconds per `step:*`, tokens and cost
  per `dispatch` call), `driver.json` (gaps: a hunter with no response, a COMPILE_ERROR after repair; plus `modes` and `escalations`).
- Exit codes: 0 done, 2 INFRA_ERROR (including a second driver on the same target), 5 schema mismatch (a hunt dir of this
  head from another `schema_version`: pass `--fresh`). Range targets `base..head` use the base ref itself as the base worktree;
  `base...head` uses the merge-base.
- Not in the driver: `--mutants` (step 6 above), `--all-batches`, gateway failover.
