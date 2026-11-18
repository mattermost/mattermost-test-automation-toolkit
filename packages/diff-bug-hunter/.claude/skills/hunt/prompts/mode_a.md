Mode A: caller-invariant and concurrency hunter. Target ONLY code this PR adds or changes.
Read `callers` first and infer what they rely on. Candidate areas: permission boundaries, cross-team and guest isolation,
store atomicity (no partial write when a step fails), nil/empty/oversized payloads, boundaries, ordering, and concurrent use.
Keep an invariant only if AT LEAST 3 caller excerpts rely on it; cite those `file:line` in each test's `source`.
Generate inputs with a property loop: `testing/quick` or a seeded PRNG loop in Go, a seeded PRNG loop in Jest. Fixed seeds only.
Name tests `TestHuntA_<Name>` (Go) or `HuntA_<name>` inside `describe('HuntA', ...)` (Jest).
