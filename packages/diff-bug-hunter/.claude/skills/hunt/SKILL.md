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
   Mode A also gets the `RELIABILITY.md` rules this diff triggers; Mode B and mutant planters never do. Each goes
   to a fresh Agent with no messaging/MCP tools, prompted with `dispatch.md` (next to this file) and `{REQ}` = the path.
4. **Run:** `run.py run <pr> A` and `run.py run <pr> B`.
   - `COMPILE_ERROR` (exit 3): one repair round. `build_requests.py <pr> repair <tag>`, dispatch
     `<tag>/request.repair.json` to a fresh agent, rerun. Still broken = report the hunter as failed.
   - `INFRA_ERROR` (exit 2): fix the environment and rerun. Never report it as "no findings".
   - A `FLAKY` test is reported as flaky. Never retry it, add sleeps, or raise `-count` to make it pass.
5. **Vet every `FAIL_3_OF_3`:**
   - Root-cause it with a throwaway diagnostic test, then delete it (`run.py` refuses to run on a dirty worktree).
   - `lessons.py match <scratch>/hunt<pr>/ctx.json` lists known false positives. If it is one, drop it.
   - `run.py base <pr> <tag>` gives `NEW_PR_BUG`, `PRE_EXISTING`, `BASE_UNCOMPILABLE` or `BASE_FAILS_DIFFERENTLY`
     (decide those from the diff, as for `NOT_RUN_ON_BASE`); `NOT_A_HEAD_FAILURE` means there is nothing to vet.
   - Confirm a real caller (HTTP, websocket, plugin API, UI) reaches the input. If none does, it is a caller-unreachable nit.
   - A newly vetted false-positive pattern: `lessons.py add '<json>'`. Hunters see it once it is merged to the base
     branch; until then it stays in the working copy without blocking the trust gate.
6. **Mutation gate**, if Mode A has passing tests:
   - Planting: `build_requests.py <pr> mutants`, dispatch it, then `build_requests.py <pr> heldout`, dispatch it.
     Never show M or M2 to a hunter.
   - Score: `run.py mutants <pr> A`.
   - `NEEDS_REGENERATION`: `build_requests.py <pr> regen <id> <tag>` (the score that reported it), dispatch it once, then rescore. Still broken = dropped.
     `ERROR` = that mutant hit an environment failure; rerun once, then report it as unscored.
   - Any of M1-M3 `SURVIVED`: `build_requests.py <pr> strengthen M1,..`, dispatch it, then `run.py run <pr> A2` and `run.py mutants <pr> A2`.
   - Always also run `run.py mutants <pr> PR` (a PR without tests in the hunted packages scores every mutant `SURVIVED`).
7. **Report in chat only:**
   - **New PR Bug** / **Pre-Existing Bug** / **Caller-unreachable nit**, each with its exact test command,
     counterexample, root cause `file:line` and the caller that reaches it.
   - One line per dropped artifact.
   - Mutation table M1-M5 × (A, A2, PR).
   - If there is a New PR Bug, offer a review-comment draft. Never post it.
   - If nothing failed 3/3, say so plainly.
