# /hunt verdict glossary

Generated from `scripts/verdicts.py` by `python3 scripts/verdicts.py > GLOSSARY.md`. Edit the module, not this file.

Prefix is the source that writes the token. Values are the exact strings in JSON and printed output.

| Token | Source | Meaning |
| --- | --- | --- |
| `PASS` | RUN | Test passed in every run. Eval card: the card passed its thresholds. |
| `FAIL` | RUN | One run failed the test. Eval card: the card failed a threshold. |
| `SKIP` | RUN | The runner skipped the test. Never a finding. |
| `FLAKY` | RUN | Runs disagree on the test. Reported as flaky, never retried into a pass. |
| `MISSING` | RUN | Test id absent from this run's output. |
| `FAIL_3_OF_3` | RUN | Test failed all 3 head runs. The only input to vetting. |
| `NOT_RUN` | RUN | Package did not compile or ran no test. Carries no result. |
| `NOT_A_HEAD_FAILURE` | RUN | Test did not fail on head. Nothing to vet. |
| `NEW_PR_BUG` | BASE | Fails 3/3 on head and passes on merge-base: the PR introduced the failure. Candidate only until vetted. |
| `PRE_EXISTING` | BASE | Fails on head and on merge-base: not introduced by the PR. |
| `NEW_API` | BASE | Fails on head and cannot compile on merge-base because the PR adds the API it calls. Not a bug by itself. |
| `BASE_UNCOMPILABLE` | BASE | Cannot compile on merge-base for another reason. Mode D: decide from the diff. |
| `BASE_FAILS_DIFFERENTLY` | BASE | Fails on merge-base with a different failure. Decide from the diff. |
| `NOT_RUN_ON_BASE` | BASE | Test or package did not run on merge-base. Decide from the diff. |
| `UNVETTED` | BASE | Failing head test with no usable base result (missing or stale base file). |
| `OLD_TEST_BREAKS` | OLD | Existing test fails 3/3 on head and passes on merge-base: the PR changed behaviour. |
| `OLD_TEST_SOMETIMES_BREAKS` | OLD | Existing test fails some head runs and passes 3/3 on merge-base. |
| `OLD_TEST_UNCOMPILABLE` | OLD | Existing test no longer compiles against the head API. Listed, not a finding. |
| `PR_TEST_FAILS_UNDER_CI` | PR | The PR's own test passes without CI flags and fails with ENABLE_FULLY_PARALLEL_TESTS=true. |
| `PR_TEST_FAILS` | PR | The PR's own test fails with and without CI flags. |
| `SAME` | DIFF | Head and merge-base records match. UI: /verify compare found no change. |
| `DIFF` | DIFF | Mode D: head and merge-base records differ on a generated input (candidate). UI: /verify compare found an unexplained change. |
| `NONDETERMINISTIC` | DIFF | The two head recorder runs disagree. Records are dropped. |
| `RECORDER_FAILED` | DIFF | Mode D recorder failed on head. |
| `NO_RECORDS` | DIFF | Mode D recorder passed on head but wrote no records. |
| `BASE_FAILED` | DIFF | Mode D recorder fails on merge-base. Decide from the diff. |
| `REGRESSION` | UI | /verify compare: a page or API that works on merge-base fails on head. |
| `PROVEN` | REVIEW | Mode R: a failing head test reproduces the CodeRabbit claim. base_verdict gives the merge-base result. |
| `DISPROVEN` | REVIEW | Mode R: the claim's test passes on head in every run. |
| `UNPROVABLE_DYNAMICALLY` | REVIEW | Mode R: the harness cannot decide the claim (flaky, skipped, unvetted on base, or untestable). |
| `KILLED` | MUT | A kept test fails on the planted mutant. |
| `SURVIVED` | MUT | No kept test fails on the planted mutant. |
| `NEEDS_REGENERATION` | MUT | Planted mutant does not compile. Regenerate once, then drop. |
| `REACHES` | COV | Mode A test executes at least one changed line. |
| `VACUOUS` | COV | Mode A test executes no changed line. Dropped; kills no mutant. |
| `UNKNOWN` | COV | No coverage profile. Never dropped on missing data. |
| `STRONG` | FIX | Test passes on the fix and fails on the bug: it catches the fix's removal. |
| `STRICTLY_WEAK` | FIX | Test fails on every run on the fix: its expectation is not the bug. |
| `FIX_INCOMPATIBLE` | FIX | Test cannot run on the fix (an API it uses was renamed or removed). |
| `FIX_FLAKY` | FIX | Runs on the fix disagree. |
| `FIX_NOT_RUN` | FIX | Test or package did not run on the fix commit. |
| `KEEP` | VET | Vetting accepts the finding as real. Admitted only if verdict.admissibility passes. |
| `DROP` | VET | Vetting rejects the finding (intended, unreachable, or known false positive). |
| `HELD` | VET | Vetting cannot decide. Kept in the internal HELD queue only. |
| `EMPTY` | HUNT | Hunter still emitted 0 test files after the retry. Lowers the confidence tier. |
| `EMPTY_RESPONSE` | HUNT | Mode A emitted 0 test files on a batch with changed source files. |
| `COMPILE_ERROR` | HUNT | Hunter tests do not compile (exit 3): one repair round. |
| `INFRA_ERROR` | STATUS | Environment failed (exit 2). Fix it and rerun; never 'no findings'. |
| `ALREADY_HUNTED` | STATUS | Results for this head already exist (prepare.py exit 4). |
| `ERROR` | STATUS | Environment failure while scoring one mutant or eval case: left unscored. |

## Mode names

| Letter | Descriptive name |
| --- | --- |
| A | invariants |
| B | claims |
| D | differential |
| R | review-claims |
