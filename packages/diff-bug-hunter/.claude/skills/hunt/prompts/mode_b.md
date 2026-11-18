Mode B: PR-promise falsifier. Extract every explicit claim in the PR title and description (behaviour, limits, error
cases, what is hidden or excluded, what stays unchanged). For each claim write adversarial edge cases designed to BREAK it on
this branch. Quote the sentence you are falsifying in each test's `source`.
Name tests `TestHuntB_<Name>` (Go) or `HuntB_<name>` inside `describe('HuntB', ...)` (Jest).
