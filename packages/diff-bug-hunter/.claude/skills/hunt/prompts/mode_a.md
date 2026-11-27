Mode A: caller-invariant and concurrency hunter. Target ONLY code this PR adds or changes.
Read `callers` first and infer what they rely on. Candidate areas: permission boundaries, cross-team and guest isolation,
store atomicity (no partial write when a step fails), nil/empty/oversized payloads, boundaries, ordering, and concurrent use.
Keep every invariant grounded in concrete `file:line` evidence from the provided context (`callers`, `neighbors_same_file`
for S1 sibling guards, `changed_functions_base_source` for S4/base contracts, `sibling_tests_and_helpers` / `pr_tests_diff`
for lifted properties, or a triggered `RELIABILITY.md` rule) and cite those `file:line` in each test's `source`.
Prefer 2-3 independent caller/neighbour citations when the context has them, but when a changed function has few callers in
context (new helpers, hooks, HTTP/WS handlers, low-fan-in functions), 1-2 concrete citations from callers, neighbours,
base code, `pr_tests_diff`, doc comments, or triggered `RELIABILITY.md` rules suffice. Never return `{"files": [], "tests": []}`
solely because fewer than 3 caller excerpts appear in `callers`: if `changed_files_head_source` has executable production
code, emit concrete tests (S1/S2/S4, lifted properties, or triggered `RELIABILITY.md` probes); emit `files: []` only when
the batch changes no executable logic (e.g. types or constants only).
Generate inputs with a property loop: `testing/quick` or a seeded PRNG loop in Go, a seeded PRNG loop in Jest. Fixed seeds only. Also try S4 (existing-data compatibility) on every changed function that reads, validates or stores data.
Property shapes to try on each changed function, where its callers support them:
- round-trip: decode(encode(x)) == x (marshal/unmarshal, ToJSON/FromJSON, serialize/parse, escape/unescape).
- idempotence: f(f(x)) == f(x) (sanitize, normalize, migrate, dedupe, PreSave/PreUpdate).
- no-panic: nil, empty, zero, oversized, deeply nested structures, malformed UTF-8 and unicode boundaries return an error or a value, never panic or throw.
- monotonic: a caller with more roles or permissions never sees less; a superset filter never returns fewer rows.
- sequence: 3-8 seeded operations over shared state, sessions, roles, reconnects, or mount/drag/unmount lifecycles; assert invariants hold after every step and cleanup leaves no stuck state.
- lifted: generalize each literal example in `pr_tests_diff` into a loop over the same contract. Cite that test's
  `file:line` (plus any matching callers or base lines).
The reference model or expected value in every test is derived from the merge-base code and the callers, NEVER from the
PR description or the PR's new code: a model copied from either one passes whatever the PR does. Cite the base or caller
lines it comes from.
Inputs that reach none of the changed lines belong to Mode B's S3, not here.
Name tests `TestHuntA_<Name>` (Go) or `HuntA_<name>` inside `describe('HuntA', ...)` (Jest).
