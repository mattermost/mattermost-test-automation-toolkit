Strategies. Mode A applies S1, S2 and S4; Mode B applies S3. Start each such test's `source` with its tag (S1, S2, S3 or S4),
then the evidence your mode already requires.
S1 Sibling guards (Mode A). `neighbors_same_file` holds unchanged functions near the PR's code: from the same file
(`scope: same_file`) or, when that file has too few, from the same directory (`scope: same_dir`); `near` lists the
changed files each was picked for. List the guards they apply: caller or session type checks, role or permission checks,
nil/empty/default handling (`?? ''`, default props, zero values), feature-flag and license gates, early returns. For a
guard the PR's new or changed code does NOT apply, write a test that drives the new code down that path and asserts the
outcome the neighbours produce. Cite the neighbour `file:line` excerpts that apply the guard.
S2 Adversarial callers (Mode A). Go: call each changed entry point as each of SystemAdmin, TeamAdmin, plain Member,
Guest, Bot, an OAuth app session and an integration/webhook session, and with any feature flag or license it reads both
off and on; assert each caller gets what the neighbours or callers show that caller should get. React: for a prop the
type marks optional, or a component the shown code exposes to untyped callers (plugins via `window.Components` or a
registry, plain JS files), render with that prop omitted or `undefined`, one prop at a time, then drive the main action;
assert it does not throw, does not re-render in a loop, and behaves as with the prop's empty value. Never test a
required prop that no shown caller can omit.
S3 Unchanged-behaviour differential (Mode B). `changed_functions_base_source` holds the merge-base version of each
function the PR changed or removed. For inputs that reach none of the PR's changed lines, assert the behaviour the base
version has; cite the base `file:line` instead of a quoted claim. Skip any input whose path runs through a changed line.
S4 Existing-data compatibility (Mode A). For each changed function, take inputs and records that were valid and readable
on the merge-base (`changed_functions_base_source`, `callers`, fixtures and migrations in context) and assert they stay
valid and readable on head with the same meaning. Look for: values the old validator accepted (existing usernames,
names of existing custom emoji, IDs and slugs), partially populated or sanitized objects merged into full ones (a copy
missing fields must not overwrite the full object), NULL or legacy column values scanned into non-pointer fields, config
values that were non-secret or defined before the PR, and old enum, role or JSON shapes. Each such test cites the base
`file:line` that made the input valid plus any callers or stored data that
still carry it. A new rule that rejects or rewrites data the base stored, or values callers already hold, is a
finding even if the PR description promises it: the stored data cannot be changed by the PR. A restriction scoped
solely to new submissions (keeping existing records readable) is a finding only when the PR does not announce it.
