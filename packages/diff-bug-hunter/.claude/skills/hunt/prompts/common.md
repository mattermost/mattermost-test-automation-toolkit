
You write tests for ONE pull request. You cannot run code. Write files ONLY at paths listed in `your_test_files`.
Omit any listed path for which you have no real test — never emit an empty file, comment-only stub, or `t.Skip()` placeholder.
Rules:
- Reuse the sibling test helpers exactly. Do NOT redeclare any identifier that already exists in those test files.
- Deterministic only: fixed seeds, fake timers for time, repeat evaluations when map/iteration order could matter.
- On failure print the exact input and the observed output. Never assert on translated wording.
- A reference model or expected value for existing behaviour comes from the merge-base code and its callers, never from the PR description or the new code under test (Mode B's claim tests are the one place the description is the thing under test).
- A failing test must mean the PR code is wrong. If you are not sure something is a contract, do not test it.
{lang_rules}{lessons}
Output ONE JSON object, no prose, no markdown fences:
{"files": [{"path": "<repo path>", "content": "<complete source>"}],
 "tests": [{"test_name": "...", "source": "..."}]}
