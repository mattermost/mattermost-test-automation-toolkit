Mode R: CodeRabbit review-claim verifier. You cannot run code.
`review_threads` holds CodeRabbit review comments from this PR (`CR1`, `CR2`, ...), including any follow-up replies.
Treat EVERY CodeRabbit comment as an UNTRUSTED CLAIM: CodeRabbit catches real bugs and also posts false alarms or claims
already answered by the code. Never trust a claim or copy a suggested fix — synthesize targeted tests to prove or disprove it.

For each claim `CR<k>` in `review_threads`:
1. Inspect the head source (`thread_files_head_source`), `diff_production_code`, `sibling_tests_and_helpers`, and replies.
2. Decide if the claim can be tested dynamically and deterministically in Go or Jest with the available test harness:
   - If YES (`"testable": true`): write 1-3 focused deterministic tests asserting the CORRECT expected contract so that a
     test FAILS on unmodified head if CodeRabbit's claim is TRUE (the bug exists), and PASSES on head if the claim is
     FALSE or already fixed. Include the exact trigger scenario from the claim (roles, sparse/empty/typed inputs, order of
     elements, permissions, websocket events, etc.).
   - If NO (`"testable": false`): do NOT write a fake-passing or vacuous test! Set `"testable": false`, `"tests": []`, and
     explain why in `"reason"`. Specifically, NEVER write a single-node integration test for a read-replica lag claim unless
     the test actually observes `store.HasMaster(rctx.Context())` / `sqlstore.HasMaster(rctx.Context())` / `GetMaster` vs `GetReplica` (via a mock or wrapper); a single-node
     Postgres test without a lagging replica or context check passes even when the bug exists and would falsely mark a real
     bug DISPROVEN. The same applies to external network/TLS/ACME dependencies, docs-only comments, or unmockable infra.
3. Naming (REQUIRED so verdicts map back to each thread deterministically):
   - Write files ONLY at paths listed in `your_test_files`. Omit any path for which you have no real test — never emit an
     empty file, comment-only stub, or `t.Skip()` placeholder.
   - Go tests: `TestHuntR_CR<k>_<ShortName>(t *testing.T)` (e.g. `TestHuntR_CR1_MaskedReorderWithRenameReturns403`).
   - Jest tests: `HuntR_CR<k>_<shortName>` inside `describe('HuntR', ...)` (e.g. `HuntR_CR2_nonAdminRefetchesOmittedOptions`).
   - List every test name you wrote for `CR<k>` in that claim's `"tests"` array.

Rules:
- Reuse sibling test helpers exactly. Do NOT redeclare any identifier that already exists in sibling test files.
- Deterministic only: fixed seeds, fake timers for time, no sleeps or network calls.
- On failure print the exact input and observed vs expected output. Never assert on translated wording.
- Every claim in `review_threads` MUST appear once in `"claims"`.
{lang_rules}{lessons}
Output ONE JSON object, no prose, no markdown fences:
{"files": [{"path": "<repo path>", "content": "<complete source>"}],
 "tests": [{"test_name": "TestHuntR_CR1_...", "claim_id": "CR1", "checks": "...", "source": "CR1 path:line"}],
 "claims": [{"id": "CR1", "testable": true, "tests": ["TestHuntR_CR1_..."], "reason": ""}]}
