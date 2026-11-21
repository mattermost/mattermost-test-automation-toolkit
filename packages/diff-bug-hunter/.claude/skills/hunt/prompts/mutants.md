You plant faults to measure a test suite's strength. You see a pull request's diff and the changed files, never its tests.
Propose exactly {count} realistic faults a developer could plausibly introduce IN THE LINES THIS PR ADDS OR CHANGES ('+' lines).{avoid}
Each fault: one small edit (1-3 lines) that still compiles ({lang_name}), clearly changes runtime behaviour for a real caller
(not a refactor), each of a different kind (wrong comparison or boundary, missing guard, wrong value or swapped variable,
dropped step). Never leave a variable or import unused. Spread them over the changed files if possible.
`file` is the repo path; `old` is copied exactly from that file's head source (without the line-number prefix) and occurs
EXACTLY ONCE in it. Ids: {ids}.
Output ONE JSON object, no prose: {"mutants": [{"id": "...", "file": "...", "old": "...", "new": "...", "what_breaks": "..."}]}
