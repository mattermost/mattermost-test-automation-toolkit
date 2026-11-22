---
name: hunt
description: Blind Mode A (caller invariants) + Mode B (PR-promise falsifier) bug hunt on one mattermost/mattermost PR, with merge-base vetting and a compile-verified mutation gate. Use when asked to hunt, bug-hunt or falsify a Mattermost PR.
argument-hint: <pr_number> [--batch N]
---

Hunt PR #$ARGUMENTS. Scripts are in `scripts/` next to this file; run them with `cd <this dir>/scripts && python3 <script>`.
`HUNT_SCRATCH` (default `<tmp>/hunt`) holds clones, worktrees and `hunt<pr>/`. Model output, hunter tests and mutants
are written only by `scripts/` (and by the agents they dispatch); you never edit them. The one file you write is a
throwaway diagnostic test in step 5, deleted before the next script runs. Nothing is posted to GitHub and nothing is
committed. Run one script at a time per PR: `prepare.py`, `ctx.py` and every `run.py` command share the worktrees
and hunt dir, and a lock makes a second one stop with `INFRA_ERROR` while the first is running (wait for a background
`run.py` to finish first). Run slow suites in the background and never kill one: an interrupted run is cleaned up by
`prepare.py <pr>`.

0. **Trust gate:** `trusted.py check`. Rules (`SKILL.md`, `lessons.jsonl`, `RELIABILITY.md`, `prompts/`) come from
   the base branch, never the PR head. If the check fails, stop: a change to this skill cannot take part in its own hunt.
1. **Prepare:** `prepare.py <pr>` (worktrees at the PR head and its merge-base with the PR's own base branch).
   `INFRA_ERROR` = stop and report it; that includes less than 2 GiB free under `HUNT_SCRATCH`, which `prepare.py`
   and every Go `-race` run check first.
2. **Context:** `ctx.py <pr> [--batch N]`. Quote its batch line. `skipped.log` lists every file not hunted; mention the
   deferred batches in the report and hunt them only if the user asks.
3. **Hunters:** `build_requests.py <pr> hunters`, then dispatch `A/request.json` and `B/request.json` in parallel.
   Both also get `prompts/strategy_x.md` (Mode A: S1 sibling guards, S2 adversarial callers and props, S4 existing-data compatibility; Mode B: S3
   merge-base differential) and the context it reads: `neighbors_same_file` (unchanged functions near the change, from
   the same file, topped up from the same directory) and `changed_functions_base_source`. Strengthen and repair rounds
   get the context but not `strategy_x.md`; mutant planters get neither.
   Mode A's reference models come from base code and callers, never from the PR description; Mode B treats the
   description as a claim to test, and adds a caller-side "claim vs caller contract" test where a claim changes
   behaviour callers relied on.
   Mode A also gets the `RELIABILITY.md` rules this diff triggers; Mode B and mutant planters never do. Each goes
   to a fresh Agent with no messaging/MCP tools, prompted with `dispatch.md` (next to this file) and `{REQ}` = the path.
4. **Run:** `run.py run <pr> A` and `run.py run <pr> B`.
   - `COMPILE_ERROR` (exit 3): one repair round. `build_requests.py <pr> repair <tag>`, dispatch
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
   - Then `old_tests.py <pr>` (no model): old tests on new code, now also covering `storetest/*.go`, with per-function
     salvage; generated mock layers are skipped. `OLD_TEST_BREAKS` = the PR had to change that test to pass.
     `OLD_TEST_SOMETIMES_BREAKS` = fails some head runs but passes 3/3 on the merge-base. Both are behaviour changes, not
     yet bugs: step 7 sets them against the PR description. `OLD_TEST_UNCOMPILABLE` (the head API no longer fits the old
     test) and `PRE_EXISTING` are listed, not reported as findings.
   - Then `pr_tests.py <pr>` (no model): the PR's own added or edited Go tests run 3x with
     `ENABLE_FULLY_PARALLEL_TESTS=true`. Verdicts: `PR_TEST_FAILS_UNDER_CI`, `PR_TEST_FAILS`, `FLAKY`, `PASS`.
4b. **Differential recorders (Mode D), code decides:** `build_requests.py <pr> diff`, dispatch `D/request.json` to a fresh
   Agent as in step 3, then `run.py diff <pr> D`. The model writes only seeded input generators and recorders (no
   assertion, no expected value, nothing taken from the PR description); the same recorder runs twice on the PR head
   and once on the merge-base, and code diffs the records per input. Verdicts per recorder: `SAME`, `DIFF` (up to 5
   smallest examples: `input`, `base`, `head`), `NONDETERMINISTIC` (the two head runs disagree: records dropped),
   `BASE_UNCOMPILABLE` / `BASE_FAILED` (that recorder cannot run on the merge-base: decide from the diff),
   `RECORDER_FAILED`, `NO_RECORDS`. `COMPILE_ERROR` (exit 3): one repair round as in step 4 (`repair D`); `INFRA_ERROR`
   (exit 2): fix and rerun. Files: `diff_D.json`, `diff_D.examples.json`.
5. **Vet every `FAIL_3_OF_3`:**
   - Root-cause it with a throwaway diagnostic test, then delete it (`run.py` refuses to run on a dirty worktree).
   - `lessons.py match <scratch>/hunt<pr>/ctx.json` lists known false positives. If it is one, drop it.
   - `run.py base <pr> <tag>` gives `NEW_PR_BUG`, `PRE_EXISTING`, `NEW_API`, `BASE_FAILS_DIFFERENTLY`
     (decide that one from the diff, as for `NOT_RUN_ON_BASE`). `NEW_API` = fails 3/3 on head and cannot compile on base
     because it calls an API the PR adds: root-cause it, it is not a bug by itself. Compile failures are salvaged per test,
     not per file; `NOT_A_HEAD_FAILURE` means there is nothing to vet.
   - Confirm a real caller (HTTP, websocket, plugin API, UI) reaches the input. If none does, it is a caller-unreachable nit.
   - A newly vetted false-positive pattern: `lessons.py add '<json>'`. Hunters see it once it is merged to the base
     branch; until then it stays in the working copy without blocking the trust gate.
6. **Mutation gate**, if Mode A has passing tests:
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
   - **New PR Bug** (`NEW_PR_BUG`, root-caused) / **Pre-Existing Bug** / **Caller-unreachable nit**, each with its exact
     test command, counterexample, root cause `file:line` and the caller that reaches it.
   - **Behaviour change the PR's tests absorbed**: each `OLD_TEST_BREAKS` / `OLD_TEST_SOMETIMES_BREAKS` with its failure
     text from `old_tests.messages.json`. If the PR description does not announce that change, mark it **unexplained**
     (that is how a bug in the PR's intent shows up, which hunters cannot see). Mark it **breaks existing data/callers**
     even when announced.
   - **Behaviour diff on generated inputs**: each `DIFF` from `run.py diff`, with its smallest example (input, base, head),
     and whether the PR description announces that change. An unannounced change, or one that breaks data callers
     already stored (settings, records, IDs a caller still holds), is a finding. An announced change that only
     fixes a crash (base panics, head returns a value) is not.
   - **PR tests failing under CI flags**: each `PR_TEST_FAILS_UNDER_CI` / `PR_TEST_FAILS` / `FLAKY` from `pr_tests.py`.
   - **New-API failures to root-cause**: each `NEW_API`.
   - **UI/API base-vs-head diffs**: `/verify` compare runs (`verify_ui.mjs plan.json --compare <base_url>`, capture steps,
     verdict `SAME` / `DIFF` / `REGRESSION`). A `DIFF` the PR does not explain is a finding. Skip when the PR has no UI/API surface.
   - One line per dropped artifact.
   - **Mutation table** M1-M5 x (A, A2, PR), the proof that the kept tests catch bugs, and under it "changed lines
     reached: X/Y" for A and A2. That is a floor, not a quality score: never report it as a percentage.
   - If there is a New PR Bug, offer a review-comment draft. Never post it.
   - If nothing failed 3/3, say so plainly.
