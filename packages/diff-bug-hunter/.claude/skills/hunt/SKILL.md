---
name: hunt
description: Blind Mode A (caller invariants) + Mode B (PR-promise falsifier) bug hunt on one mattermost/mattermost PR, with merge-base vetting and a compile-verified mutation gate. Use when asked to hunt, bug-hunt or falsify a Mattermost PR.
argument-hint: <pr_number> [--batch N]
---

Hunt PR #$ARGUMENTS. Scripts are in `scripts/` next to this file; run them with `cd <this dir>/scripts && python3 <script>`.
`HUNT_SCRATCH` (default `<tmp>/hunt`) holds clones, worktrees and `hunt<pr>/`. Only `scripts/` writes files; you never
write or edit model output, test files or mutants yourself. Nothing is posted to GitHub and nothing is committed.

1. **Prepare:** `prepare.py <pr>`. `INFRA_ERROR` = stop and report it.
2. **Context:** `ctx.py <pr> [--batch N]`. Quote its batch line. `skipped.log` lists every file not hunted; mention the
   deferred batches in the report and hunt them only if the user asks.
3. **Hunters:** `build_requests.py <pr> hunters`, then dispatch `A/request.json` and `B/request.json` in parallel. Each goes
   to a fresh Agent with no messaging/MCP tools, prompted with `dispatch.md` (next to this file) and `{REQ}` = the path.
4. **Run:** `run.py run <pr> A` and `run.py run <pr> B`.
   - `COMPILE_ERROR` (exit 3): one repair round. A fresh agent gets its response plus the compiler output.
   - `INFRA_ERROR` (exit 2): fix the environment and rerun. Never report it as "no findings".
5. **Vet every `FAIL_3_OF_3`:**
   - Root-cause it with a throwaway diagnostic test, then delete it.
   - Check `lessons.jsonl`. If it is a known artifact, drop it.
   - `run.py base <pr> <tag>` gives `NEW_PR_BUG`, `PRE_EXISTING` or `BASE_UNCOMPILABLE`. For `BASE_UNCOMPILABLE`, decide from the diff.
   - Confirm a real caller (HTTP, websocket, plugin API, UI) reaches the input. If none does, it is a caller-unreachable nit.
   - A newly vetted false-positive pattern: `lessons.py add '<json>'`.
6. **Mutation gate**, if Mode A has passing tests:
   - Planting: `build_requests.py <pr> mutants`, dispatch it, then `build_requests.py <pr> heldout`, dispatch it.
     Never show M or M2 to a hunter.
   - Score: `run.py mutants <pr> A`.
   - `NEEDS_REGENERATION`: `build_requests.py <pr> regen <id>`, dispatch it once, then rescore. Still broken = dropped.
   - Any of M1-M3 `SURVIVED`: `build_requests.py <pr> strengthen M1,..`, dispatch it, then `run.py run <pr> A2` and `run.py mutants <pr> A2`.
   - Always also run `run.py mutants <pr> PR`.
7. **Report in chat only:**
   - **New PR Bug** / **Pre-Existing Bug** / **Caller-unreachable nit**, each with its exact test command,
     counterexample, root cause `file:line` and the caller that reaches it.
   - One line per dropped artifact.
   - Mutation table M1-M5 × (A, A2, PR).
   - If there is a New PR Bug, offer a review-comment draft. Never post it.
   - If nothing failed 3/3, say so plainly.
