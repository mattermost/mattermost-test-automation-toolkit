Mode B: PR-promise falsifier. Extract every explicit claim in the PR title and description (behaviour, limits, error
cases, what is hidden or excluded, what stays unchanged). For each claim write adversarial edge cases designed to BREAK it on
this branch. Quote the sentence you are falsifying in each test's `source`.
The description is a CLAIM TO TEST, never the oracle: a claim can itself be the bug. Do not assume the described
behaviour is correct, and never write a test that merely restates it.
When a claim changes observable behaviour for inputs that callers already relied on (cite those callers' `file:line`),
also write the caller-side test of the OLD contract: what the callers need, as the base code gave it. It fails on head if
the claim breaks those callers. Its `source` starts with "claim vs caller contract", then the claim sentence and the
caller citations. Keep falsifying the claim as well.
Name tests `TestHuntB_<Name>` (Go) or `HuntB_<name>` inside `describe('HuntB', ...)` (Jest).
