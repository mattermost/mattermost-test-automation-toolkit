# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Single source of every verdict and status token the /hunt scripts write or compare.

Each member's value is the exact string that is written to JSON and printed, so renaming a member is never needed
for behaviour: only the string value is the contract. `MEANINGS` gives each token its source prefix (BASE, DIFF, UI,
...) and a one-line meaning. `GLOSSARY.md` is generated from this module (`python3 verdicts.py > GLOSSARY.md`) and a
test fails if the two drift apart. SKILL.md may mention only tokens defined here.

Run `python3 verdicts.py` to print the glossary.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from enum import Enum

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"


class Verdict(str, Enum):
    """Verdict and status tokens. `str()` and `format()` give the value, so f-strings and JSON stay unchanged."""

    def __str__(self) -> str:
        return str(self.value)

    def __repr__(self) -> str:
        return repr(self.value)

    # per-test run outcome (run.py classify, pr_tests.py, old_tests.py, eval_bugs.py card)
    PASS = "PASS"
    FAIL = "FAIL"
    SKIP = "SKIP"
    FLAKY = "FLAKY"
    MISSING = "MISSING"
    FAIL_3_OF_3 = "FAIL_3_OF_3"
    NOT_RUN = "NOT_RUN"
    NOT_A_HEAD_FAILURE = "NOT_A_HEAD_FAILURE"

    # base run: a head failure compared with the merge-base (run.py base, review_threads.py)
    NEW_PR_BUG = "NEW_PR_BUG"
    PRE_EXISTING = "PRE_EXISTING"
    NEW_API = "NEW_API"
    BASE_UNCOMPILABLE = "BASE_UNCOMPILABLE"
    BASE_FAILS_DIFFERENTLY = "BASE_FAILS_DIFFERENTLY"
    NOT_RUN_ON_BASE = "NOT_RUN_ON_BASE"
    UNVETTED = "UNVETTED"

    # old tests on new code (old_tests.py)
    OLD_TEST_BREAKS = "OLD_TEST_BREAKS"
    OLD_TEST_SOMETIMES_BREAKS = "OLD_TEST_SOMETIMES_BREAKS"
    OLD_TEST_UNCOMPILABLE = "OLD_TEST_UNCOMPILABLE"

    # the PR's own tests under CI flags (pr_tests.py)
    PR_TEST_FAILS_UNDER_CI = "PR_TEST_FAILS_UNDER_CI"
    PR_TEST_FAILS = "PR_TEST_FAILS"

    # Mode D differential recorders (run.py diff) and /verify compare (UI)
    SAME = "SAME"
    DIFF = "DIFF"
    NONDETERMINISTIC = "NONDETERMINISTIC"
    RECORDER_FAILED = "RECORDER_FAILED"
    NO_RECORDS = "NO_RECORDS"
    BASE_FAILED = "BASE_FAILED"
    REGRESSION = "REGRESSION"
    BOTH_FAIL = "BOTH_FAIL"

    # Mode R CodeRabbit thread verdicts (review_threads.py)
    PROVEN = "PROVEN"
    DISPROVEN = "DISPROVEN"
    UNPROVABLE_DYNAMICALLY = "UNPROVABLE_DYNAMICALLY"

    # mutation gate (run.py mutants)
    KILLED = "KILLED"
    SURVIVED = "SURVIVED"
    NEEDS_REGENERATION = "NEEDS_REGENERATION"

    # Mode A coverage (run.py cover)
    REACHES = "REACHES"
    VACUOUS = "VACUOUS"
    UNKNOWN = "UNKNOWN"

    # fix-commit oracle (eval_bugs.py)
    STRONG = "STRONG"
    STRICTLY_WEAK = "STRICTLY_WEAK"
    FIX_INCOMPATIBLE = "FIX_INCOMPATIBLE"
    FIX_FLAKY = "FIX_FLAKY"
    FIX_NOT_RUN = "FIX_NOT_RUN"

    # vetting decision (vetted.json, verdict.py)
    KEEP = "KEEP"
    DROP = "DROP"
    HELD = "HELD"

    # hunter output (build_requests.py, run.py)
    EMPTY = "EMPTY"
    EMPTY_RESPONSE = "EMPTY_RESPONSE"
    COMPILE_ERROR = "COMPILE_ERROR"

    # script outcome
    INFRA_ERROR = "INFRA_ERROR"
    ALREADY_HUNTED = "ALREADY_HUNTED"
    ERROR = "ERROR"


@dataclass(frozen=True)
class Meaning:
    prefix: str  # source the token belongs to: BASE, DIFF, UI, OLD, PR, REVIEW, MUT, COV, FIX, VET, RUN, HUNT, STATUS
    text: str  # one line


MEANINGS: dict[Verdict, Meaning] = {
    Verdict.PASS: Meaning("RUN", "Test passed in every run. Eval card: the card passed its thresholds."),
    Verdict.FAIL: Meaning("RUN", "One run failed the test. Eval card: the card failed a threshold."),
    Verdict.SKIP: Meaning("RUN", "The runner skipped the test. Never a finding."),
    Verdict.FLAKY: Meaning("RUN", "Runs disagree on the test. Reported as flaky, never retried into a pass."),
    Verdict.MISSING: Meaning("RUN", "Test id absent from this run's output."),
    Verdict.FAIL_3_OF_3: Meaning("RUN", "Test failed all 3 head runs. The only input to vetting."),
    Verdict.NOT_RUN: Meaning("RUN", "Package did not compile or ran no test. Carries no result."),
    Verdict.NOT_A_HEAD_FAILURE: Meaning("RUN", "Test did not fail on head. Nothing to vet."),
    Verdict.NEW_PR_BUG: Meaning("BASE", "Fails 3/3 on head and passes on merge-base: the PR introduced the failure. "
                                        "Candidate only until vetted."),
    Verdict.PRE_EXISTING: Meaning("BASE", "Fails on head and on merge-base: not introduced by the PR."),
    Verdict.NEW_API: Meaning("BASE", "Fails on head and cannot compile on merge-base because the PR adds the API "
                                     "it calls. Not a bug by itself."),
    Verdict.BASE_UNCOMPILABLE: Meaning("BASE", "Cannot compile on merge-base for another reason. Mode D: decide "
                                               "from the diff."),
    Verdict.BASE_FAILS_DIFFERENTLY: Meaning("BASE", "Fails on merge-base with a different failure. Decide from the "
                                                    "diff."),
    Verdict.NOT_RUN_ON_BASE: Meaning("BASE", "Test or package did not run on merge-base. Decide from the diff."),
    Verdict.UNVETTED: Meaning("BASE", "Failing head test with no usable base result (missing or stale base file)."),
    Verdict.OLD_TEST_BREAKS: Meaning("OLD", "Existing test fails 3/3 on head and passes on merge-base: the PR changed "
                                            "behaviour."),
    Verdict.OLD_TEST_SOMETIMES_BREAKS: Meaning("OLD", "Existing test fails some head runs and passes 3/3 on "
                                                      "merge-base."),
    Verdict.OLD_TEST_UNCOMPILABLE: Meaning("OLD", "Existing test no longer compiles against the head API. Listed, "
                                                  "not a finding."),
    Verdict.PR_TEST_FAILS_UNDER_CI: Meaning("PR", "The PR's own test passes without CI flags and fails with "
                                                  "ENABLE_FULLY_PARALLEL_TESTS=true."),
    Verdict.PR_TEST_FAILS: Meaning("PR", "The PR's own test fails with and without CI flags."),
    Verdict.SAME: Meaning("DIFF", "Head and merge-base records match. UI: /verify compare found no change."),
    Verdict.DIFF: Meaning("DIFF", "Mode D: head and merge-base records differ on a generated input (candidate). "
                                  "UI: /verify compare found an unexplained change."),
    Verdict.NONDETERMINISTIC: Meaning("DIFF", "The two head recorder runs disagree. Records are dropped."),
    Verdict.RECORDER_FAILED: Meaning("DIFF", "Mode D recorder failed on head."),
    Verdict.NO_RECORDS: Meaning("DIFF", "Mode D recorder passed on head but wrote no records."),
    Verdict.BASE_FAILED: Meaning("DIFF", "Mode D recorder fails on merge-base. Decide from the diff."),
    Verdict.REGRESSION: Meaning("UI", "/verify compare: a page or API that works on merge-base fails on head."),
    Verdict.BOTH_FAIL: Meaning("UI", "/verify compare: an expect fails on both servers, so the plan shows nothing about the change."),
    Verdict.PROVEN: Meaning("REVIEW", "Mode R: a failing head test reproduces the CodeRabbit claim. base_verdict "
                                      "gives the merge-base result."),
    Verdict.DISPROVEN: Meaning("REVIEW", "Mode R: the claim's test passes on head in every run."),
    Verdict.UNPROVABLE_DYNAMICALLY: Meaning("REVIEW", "Mode R: the harness cannot decide the claim (flaky, skipped, "
                                                      "unvetted on base, or untestable)."),
    Verdict.KILLED: Meaning("MUT", "A kept test fails on the planted mutant."),
    Verdict.SURVIVED: Meaning("MUT", "No kept test fails on the planted mutant."),
    Verdict.NEEDS_REGENERATION: Meaning("MUT", "Planted mutant does not compile. Regenerate once, then drop."),
    Verdict.REACHES: Meaning("COV", "Mode A test executes at least one changed line."),
    Verdict.VACUOUS: Meaning("COV", "Mode A test executes no changed line. Dropped; kills no mutant."),
    Verdict.UNKNOWN: Meaning("COV", "No coverage profile. Never dropped on missing data."),
    Verdict.STRONG: Meaning("FIX", "Test passes on the fix and fails on the bug: it catches the fix's removal."),
    Verdict.STRICTLY_WEAK: Meaning("FIX", "Test fails on every run on the fix: its expectation is not the bug."),
    Verdict.FIX_INCOMPATIBLE: Meaning("FIX", "Test cannot run on the fix (an API it uses was renamed or removed)."),
    Verdict.FIX_FLAKY: Meaning("FIX", "Runs on the fix disagree."),
    Verdict.FIX_NOT_RUN: Meaning("FIX", "Test or package did not run on the fix commit."),
    Verdict.KEEP: Meaning("VET", "Vetting accepts the finding as real. Admitted only if verdict.admissibility passes."),
    Verdict.DROP: Meaning("VET", "Vetting rejects the finding (intended, unreachable, or known false positive)."),
    Verdict.HELD: Meaning("VET", "Vetting cannot decide. Kept in the internal HELD queue only."),
    Verdict.EMPTY: Meaning("HUNT", "Hunter still emitted 0 test files after the retry. Lowers the confidence tier."),
    Verdict.EMPTY_RESPONSE: Meaning("HUNT", "Mode A emitted 0 test files on a batch with changed source files."),
    Verdict.COMPILE_ERROR: Meaning("HUNT", "Hunter tests do not compile (exit 3): one repair round."),
    Verdict.INFRA_ERROR: Meaning("STATUS", "Environment failed (exit 2). Fix it and rerun; never 'no findings'."),
    Verdict.ALREADY_HUNTED: Meaning("STATUS", "Results for this head already exist (prepare.py exit 4)."),
    Verdict.ERROR: Meaning("STATUS", "Environment failure while scoring one mutant or eval case: left unscored."),
}

# Mode names: the letters are the scripts' internal tags; the descriptive names are the output names the design brief
# proposes (M2). Output still uses the letters until SKILL.md is changed in its own lane.
MODE_NAMES: dict[str, str] = {"A": "invariants", "B": "claims", "D": "differential", "R": "review-claims"}


def render_glossary() -> str:
    """Markdown glossary generated from MEANINGS. GLOSSARY.md must equal this output (a test checks it)."""
    lines = [
        "# /hunt verdict glossary",
        "",
        "Generated from `scripts/verdicts.py` by `python3 scripts/verdicts.py > GLOSSARY.md`. Edit the module, not this file.",
        "",
        "Prefix is the source that writes the token. Values are the exact strings in JSON and printed output.",
        "",
        "| Token | Source | Meaning |",
        "| --- | --- | --- |",
    ]
    for v in Verdict:
        m = MEANINGS[v]
        lines.append(f"| `{v.value}` | {m.prefix} | {m.text} |")
    lines += [
        "",
        "## Mode names",
        "",
        "| Letter | Descriptive name |",
        "| --- | --- |",
    ]
    lines += [f"| {letter} | {name} |" for letter, name in MODE_NAMES.items()]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.stdout.write(render_glossary())
