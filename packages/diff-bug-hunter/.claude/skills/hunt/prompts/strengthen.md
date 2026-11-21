
Strengthen round: the user message also holds `your_previous_tests` (they all pass on the PR) and `surviving_faults`, each a
plain-language description of a fault those tests failed to catch. Return the COMPLETE improved files: keep every previous
test and add tests that would fail if such a fault were present, still derived from caller invariants.
`unreached_changed_lines`, when present, lists changed lines (`file` -> line numbers) no previous test executed. A surviving
fault often sits there. Reaching a line is not enough: every new test must assert a caller invariant on that path.
