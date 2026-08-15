#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Triage policy engine — turns verdicts into check states.
 *
 * This is deliberately code, not prompt. The model produces a verdict and a
 * confidence; *what that means for the merge button* is a policy decision that
 * must be reviewable, diffable, and unit-tested. A model is never allowed to
 * decide its own authority.
 *
 * Two layers keep the concerns separate:
 *
 *  - the **stored verdict** — what was concluded about the failure
 *    (PR_REGRESSION, FLAKY_INFRA, …, INCONCLUSIVE). This is the record TSIO
 *    keeps and the accuracy metrics grade. Its enum is stable and never renamed
 *    by policy.
 *  - the **operational outcome** — what the check does about it. Exactly three
 *    values, each mapping to a check state and a user-facing headline:
 *
 *      FLAKY_CONFIRMED → success  — confirmed flaky failures
 *      REGRESSION      → failure  — genuine test or product failure
 *      TRIAGE_FAILED   → failure  — triage could not complete safely
 *
 * The outcome is the headline a human reads. The confidence bar and tier are
 * policy internals and never appear as the lead.
 *
 * Two rules do most of the work:
 *
 *  1. Fail closed. Anything unexpected — missing verdict, unparseable model
 *     output, unknown verdict class, confidence below bar, missing or
 *     incomplete citation, an unknown run type, triage itself erroring —
 *     resolves to TRIAGE_FAILED. There is no path where "we don't know"
 *     produces green.
 *
 *  2. Asymmetric bars. A verdict that produces green needs materially more
 *     evidence than one that produces red, because the two errors are not
 *     symmetric: a false red costs a rerun, a false green ships a bug.
 */

const GREEN_CONFIDENCE_BAR = 0.85;
const RED_CONFIDENCE_BAR = 0.7;

const VERDICTS = new Set([
    'PR_REGRESSION',
    'MAIN_REGRESSION',
    'FLAKY_TEST',
    'FLAKY_INFRA',
    'FLAKY_SERVER',
    'BUILD_OR_ENV_ERROR',
    'TEST_DEBT',
    'INCONCLUSIVE',
]);

const OUTCOMES = {
    FLAKY_CONFIRMED: 'FLAKY_CONFIRMED',
    REGRESSION: 'REGRESSION',
    TRIAGE_FAILED: 'TRIAGE_FAILED',

    // A real failure that this pull request provably did not cause. Distinct
    // from FLAKY_CONFIRMED (which claims the failure is not real) and from
    // MAIN_REGRESSION (which needs baseline history to establish). This one is
    // established from the diff, so it is reachable when no history exists.
    NOT_ATTRIBUTABLE: 'NOT_ATTRIBUTABLE',
};

// The headline is the user-facing language. The verdict and confidence never
// lead the status — a reader needs the outcome, not the model's self-grading.
const OUTCOME_HEADLINES = {
    [OUTCOMES.FLAKY_CONFIRMED]: 'confirmed flaky failures',
    [OUTCOMES.REGRESSION]: 'genuine test or product failure',
    [OUTCOMES.TRIAGE_FAILED]: 'triage could not complete safely',
    [OUTCOMES.NOT_ATTRIBUTABLE]: 'real failure, but not caused by this change',
};

// Run types that represent a protected branch rather than a PR. Confirmed flakes
// succeed here too — recorded in the ledger, but no PR label, because there is no
// PR. Regressions and triage failures fail. MAIN_REGRESSION on a baseline branch
// is itself a regression and must fail.
const BASELINE_RUN_TYPES = new Set(['MAIN', 'MASTER', 'RELEASE', 'CMT']);
const KNOWN_RUN_TYPES = new Set(['PR', ...BASELINE_RUN_TYPES]);

// Verdicts whose meaning is "a genuine failure" — never waivable, always red.
const REGRESSION_VERDICTS = new Set(['PR_REGRESSION', 'BUILD_OR_ENV_ERROR', 'TEST_DEBT']);

// Verdicts whose meaning is "this failure is not attributable to the change".
const WAIVABLE = new Set(['FLAKY_TEST', 'FLAKY_INFRA', 'FLAKY_SERVER', 'MAIN_REGRESSION']);

/**
 * Decide one cluster's outcome.
 *
 * `context` carries the facts policy needs that the model must not be trusted to
 * assert about itself: which branch this is, whether the test still has waiver
 * budget, and whether the PR's diff overlaps the failing area.
 */
function decideCluster(verdictRecord, context = {}) {
    const {
        runType = 'PR',
        amnestyExhausted = false,
        diffOverlapsFailure = false,
        reproducedOnRerun = false,
        mode = 'shadow',
    } = context;

    const verdict = verdictRecord && verdictRecord.verdict;

    // typeof before Number(). Number(true) is 1, which clears the 0.85 green bar
    // outright, so a model emitting `"confidence": true` — or any non-number the
    // coercion happens to land inside [0,1] — bought itself a maximum-confidence
    // waiver. A confidence that is not a number is not a low confidence, it is a
    // malformed record.
    const rawConfidence = verdictRecord && verdictRecord.confidence;
    const confidence = typeof rawConfidence === 'number' ? rawConfidence : NaN;

    // An unknown run type cannot be acted on safely. The policy for PR and for
    // each baseline branch differs, so a run type policy does not recognise is
    // not a missing default, it is a request to do something undefined.
    if (!KNOWN_RUN_TYPES.has(runType)) {
        return triageFailed(confidence, `unknown run type "${runType}"`);
    }

    // Range, not just finiteness. Number.isFinite rejects NaN and Infinity but
    // happily admits 5, which clears the 0.85 green bar and waives — a model
    // that emits a confidence on a 0-100 scale, or a corrupted record copied
    // through assembleVerdicts, would silently buy itself a green. Confidence is
    // defined as a probability, so anything outside [0,1] is not a low-confidence
    // answer, it is an unusable one.
    if (!VERDICTS.has(verdict) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return triageFailed(confidence, 'triage produced no usable verdict');
    }

    const isBaseline = BASELINE_RUN_TYPES.has(runType);

    // MAIN_REGRESSION is special: it excuses an unrelated PR, but on a baseline
    // branch it IS the regression and must fail. Overlap with the PR diff makes
    // attribution ambiguous, and ambiguity is triage failure, not a waiver.
    if (verdict === 'MAIN_REGRESSION') {
        if (isBaseline) {
            if (confidence < RED_CONFIDENCE_BAR) {
                return triageFailed(confidence,
                    `MAIN_REGRESSION at ${confidence} is below the red bar of ${RED_CONFIDENCE_BAR}`);
            }
            return regression(verdict, confidence,
                verdictRecord.root_cause || 'already failing on the baseline branch');
        }
        if (diffOverlapsFailure) {
            return triageFailed(confidence,
                'pre-existing on main, but this PR touches the same area — cannot attribute cleanly');
        }
        // PR, unrelated: a MAIN_REGRESSION excuses the PR. It still has to clear
        // the waiver bar — a low-confidence "it's main's fault" is not authority
        // to waive — but flake amnesty does not apply to a baseline break.
        return waiveOrConfirm(verdictRecord, confidence, {isBaseline, isFlake: false, mode,
            amnestyExhausted, reproducedOnRerun});
    }

    if (WAIVABLE.has(verdict)) {
        return waiveOrConfirm(verdictRecord, confidence, {isBaseline, isFlake: true, mode,
            amnestyExhausted, reproducedOnRerun});
    }

    // PR_REGRESSION means "this change broke it", which is a claim about the
    // diff, not about the error text. Upstream, diff_overlaps_failure is false
    // only when the files API succeeded, returned a complete list, and nothing
    // in it touched app/, libraries/, or share_extension/; anything unknown maps
    // to true. So an explicit false is established fact.
    //
    // Read off context directly rather than the destructured binding above,
    // which defaults to false. That default is permissive for the
    // MAIN_REGRESSION branch and would be the opposite here — absent would read
    // as "proven unrelated" and downgrade every PR_REGRESSION from a caller that
    // never supplied the field. Only an explicit false is evidence.
    //
    // A change confined to CI config, docs, or the test tree cannot break a
    // rendering or gesture path in the app. Accepting the verdict anyway
    // classified the platform PRODUCT_BUG and told the author their change broke
    // a test it could not reach. The failure may well be real — this keeps it
    // red — but the attribution is what triage got wrong, so the honest outcome
    // is that it could not be attributed, not a bug report against this PR.
    //
    // Deliberately not applied to TEST_DEBT or BUILD_OR_ENV_ERROR: neither
    // blames the diff, so neither needs the diff to corroborate it.
    if (verdict === 'PR_REGRESSION' && !isBaseline && context.diffOverlapsFailure === false) {
        return triageFailed(confidence,
            'PR_REGRESSION, but this PR changes no app code — the failure is real, the attribution is not');
    }

    // Genuine-failure verdicts. Below the red bar the conclusion is too weak to
    // act on, which is triage failure, not a silent green.
    if (REGRESSION_VERDICTS.has(verdict)) {
        // Unless the rerun already measured it. The confidence bar exists to stop
        // the system asserting a *cause* it is unsure of, but REGRESSION only
        // claims "this is a genuine failure" — and a failure that reproduced on
        // every fresh-device repetition is deterministic by measurement, which is
        // that claim established independently of the model.
        //
        // The same measurement is already trusted to override a FLAKY_TEST at
        // 0.95 in waiveOrConfirm. Letting it override there but not here was
        // incoherent: it meant the strongest evidence the pipeline produces could
        // only ever push toward red inside the waivable branch, and a reproduced
        // PR_REGRESSION at 0.6 was reported as "triage could not complete safely"
        // when triage had in fact completed and measured the thing twice.
        //
        // Safe in one direction only: both outcomes are already `state: failure`,
        // so this cannot green a run. It changes the headline a reviewer reads
        // and the platform classification from TRIAGE_FAILED to PRODUCT_BUG.
        if (confidence < RED_CONFIDENCE_BAR && !reproducedOnRerun) {
            return triageFailed(confidence,
                `${verdict} at ${confidence} is below the red bar of ${RED_CONFIDENCE_BAR}`);
        }
        if (confidence < RED_CONFIDENCE_BAR) {
            return regression(verdict, confidence,
                `${verdict} below the confidence bar but reproduced on every rerun`);
        }
        return regression(verdict, confidence, verdictRecord.root_cause || verdict);
    }

    // INCONCLUSIVE and anything else: the honest outcome is that triage could
    // not complete safely, and that is red.
    return triageFailed(confidence,
        (verdictRecord && verdictRecord.root_cause) || 'triage could not complete safely');
}

/**
 * The waivable path: FLAKY_TEST / FLAKY_INFRA / FLAKY_SERVER (and a
 * MAIN_REGRESSION excusing an unrelated PR) become FLAKY_CONFIRMED only when
 * every condition holds. Failing any one is triage failure; failing the
 * "deterministic" or "out of budget" checks is a regression, because those make
 * the failure genuine rather than flaky.
 */
function waiveOrConfirm(verdictRecord, confidence, opts) {
    const {isBaseline, isFlake, mode, amnestyExhausted, reproducedOnRerun} = opts;
    const verdict = verdictRecord.verdict;

    if (confidence < GREEN_CONFIDENCE_BAR) {
        return triageFailed(confidence,
            `${verdict} at ${confidence} is below the green bar of ${GREEN_CONFIDENCE_BAR}`);
    }

    // Citations must be distinct: two copies of the same reference are one
    // observation written twice, and corroboration is the whole point. This is
    // enforced here, not only in parseModelOutput, so a rule-decided cluster and
    // a suite verdict are checked too — the invariant reads as absolute, not
    // model-only.
    const cites = Array.isArray(verdictRecord.evidence) ? verdictRecord.evidence : [];
    const distinct = new Set(cites.map((c) => JSON.stringify(c)));
    if (distinct.size < 2) {
        return triageFailed(confidence,
            `${verdict} cites ${distinct.size} independent item(s) — a waiver needs 2`);
    }

    // Complete evidence: every citation is an object that says what kind of
    // evidence it is. A citation without a kind is a blank reference — present
    // in count but not in substance — and "missing citation" is triage failure.
    if (!cites.every((c) => c && typeof c === 'object' && !Array.isArray(c) && c.kind)) {
        return triageFailed(confidence,
            `${verdict} evidence is incomplete — every citation needs a kind`);
    }

    // The measurement overrules the inference. A failure that reproduced on every
    // rerun repetition is deterministic by definition, so no amount of model
    // confidence about the error text makes it flakiness. It is a genuine
    // failure, not a triage failure: the strongest single guard against a false
    // green, because it is evidence rather than interpretation.
    if (reproducedOnRerun) {
        return regression(verdict, confidence,
            `${verdict} rejected — reproduced on every rerun, so it is deterministic`);
    }

    // A flaky test out of waiver budget is no longer noise, it is unmaintained —
    // a genuine problem that must be fixed or quarantined, not waived. Amnesty is
    // a flake concept; a MAIN_REGRESSION has no flake budget to exhaust.
    if (isFlake && amnestyExhausted) {
        return regression(verdict, confidence,
            'flake amnesty exhausted — fix or quarantine explicitly');
    }

    // Shadow mode observes without acting: it posts its own context but never
    // waives, so accuracy can be measured before any authority is granted. The
    // outcome it *would* produce is recorded, but the check stays red.
    if (mode === 'shadow') {
        return {
            state: 'failure',
            verdict,
            confidence,
            operational_outcome: OUTCOMES.FLAKY_CONFIRMED,
            waived: false,
            shadow: true,
            reason: `${verdict} — would waive, but triage is in shadow mode`,
        };
    }

    // All conditions met: a confirmed flake. On a PR the waiver is applied
    // (waived: true → E2E/AI-Waived label). On a baseline branch the outcome is
    // recorded as success but no label is applied, because there is no PR to
    // label — the ledger record is the durable part.
    return {
        state: 'success',
        verdict,
        confidence,
        operational_outcome: OUTCOMES.FLAKY_CONFIRMED,
        waived: !isBaseline,
        shadow: false,
        reason: verdictRecord.root_cause || verdict,
    };
}

function regression(verdict, confidence, reason) {
    return {state: 'failure', verdict, confidence,
        operational_outcome: OUTCOMES.REGRESSION, waived: false, shadow: false, reason};
}

// A rejected verdict is stored as INCONCLUSIVE — no usable conclusion was
// reached — while the operational outcome TRIAGE_FAILED is what the check
// reports. Keeping the stored enum stable means TSIO records and the accuracy
// query keep working; the outcome is the new surface.
function triageFailed(confidence, reason) {
    return {state: 'failure', verdict: 'INCONCLUSIVE', confidence,
        operational_outcome: OUTCOMES.TRIAGE_FAILED, waived: false, shadow: false, reason};
}

/**
 * Roll per-cluster decisions into the run's outcome.
 *
 * A run is only green if *every* cluster is a confirmed flake. One regression or
 * triage-failed cluster among nine confirmed ones is still a failure, and
 * greening the run because the majority was flaky is precisely the failure mode
 * that would make this system untrustworthy.
 *
 * `context` carries the run's shape, which is what separates the three very
 * different reasons there might be no decisions:
 *
 *   - the suite passed          → success. There was nothing to triage.
 *   - no reports were produced  → red. Nothing can be concluded either way.
 *   - failures exist but nothing decided them → red. Fail closed.
 *
 * Collapsing those into one "no decisions → red" is wrong in the most damaging
 * direction: it reds every passing run, which would make the check worthless and
 * train everyone to ignore it.
 */
function decideRun(decisions, context = {}) {
    const {failureCount = null, reportsFound = null} = context;

    // A run that produced no usable report is red whatever the decisions say.
    //
    // This guard used to sit inside the `decisions.length === 0` branch, which
    // the suite path walks straight past: a run where every shard died produces
    // exactly one decision (the suite verdict), and the catalogue classifies that
    // shape as FLAKY_INFRA at 0.95 — so a change that broke the build well enough
    // to stop the tests running was waived green, with literally no test evidence
    // in existence. "No reports" cannot be a waiver at any confidence, because
    // there is nothing to be confident about.
    if (reportsFound === 0) {
        return runFailure(OUTCOMES.TRIAGE_FAILED,
            'no usable test results were produced — nothing could be triaged',
            {green_clusters: 0, red_clusters: decisions.length});
    }

    if (decisions.length === 0) {
        if (failureCount === 0) {
            // A clean pass has no outcome — there was nothing to triage. The
            // description carries that; no verdict or headline is invented.
            return {
                state: 'success',
                operational_outcome: '',
                verdict: undefined,
                confidence: undefined,
                waived: false,
                reason: 'no failures to triage',
                green_clusters: 0,
                red_clusters: 0,
            };
        }
        return runFailure(OUTCOMES.TRIAGE_FAILED,
            failureCount === null ?
                'triage produced no decisions' :
                `triage produced no decisions for ${failureCount} failure(s)`,
            {green_clusters: 0, red_clusters: 0});
    }

    // One regression or triage-failed cluster fails the complete run. Regression
    // outranks triage-failed in the headline: a genuine failure is a stronger
    // statement than "we could not tell", and it is the one a reader must act on.
    const hasRegression = decisions.some((d) => d.operational_outcome === OUTCOMES.REGRESSION);
    const hasTriageFailed = decisions.some((d) => d.operational_outcome === OUTCOMES.TRIAGE_FAILED);
    const outcome = hasRegression ? OUTCOMES.REGRESSION :
        hasTriageFailed ? OUTCOMES.TRIAGE_FAILED : OUTCOMES.FLAKY_CONFIRMED;

    const reds = decisions.filter((d) => d.state !== 'success');
    if (reds.length > 0) {
        // The cluster we quote has to be one that actually produced the headline.
        // Sorting every red by confidence and taking the top could pair a
        // REGRESSION headline with a TRIAGE_FAILED cluster's reason, and did:
        // "genuine test or product failure: 3 unwaived cluster(s); most
        // confident: FLAKY_INFRA at 0.75 is below the green bar" described one
        // regression using a different cluster's sub-threshold flake, and read as
        // three product bugs. Narrow to the deciding outcome first, then rank.
        const deciding = reds.filter((d) => d.operational_outcome === outcome);
        const worst = (deciding.length > 0 ? deciding : reds)
            .slice()
            .sort((a, b) => b.confidence - a.confidence)[0];

        // Name the composition rather than a bare total. "3 unwaived cluster(s)"
        // invites the reader to assume three of whatever the headline says; one
        // genuine failure alongside two the system could not classify is a
        // materially different situation and a different next action.
        const regressions = reds.filter(
            (d) => d.operational_outcome === OUTCOMES.REGRESSION).length;
        const unclassified = reds.length - regressions;
        const parts = [];
        if (regressions > 0) {
            parts.push(`${regressions} regression`);
        }
        if (unclassified > 0) {
            parts.push(`${unclassified} unclassified`);
        }

        return {
            state: 'failure',
            operational_outcome: outcome,
            verdict: worst.verdict,
            confidence: worst.confidence,
            waived: false,
            reason: reds.length === 1 ?
                worst.reason :
                `${parts.join(', ')}; ${worst.reason}`,
            green_clusters: decisions.length - reds.length,
            red_clusters: reds.length,
        };
    }

    const lowest = decisions.reduce((a, b) => (a.confidence <= b.confidence ? a : b));
    // waived is true only when every cluster was waived (PR, label applied). A
    // baseline success has confirmed flakes but waived=false on each cluster, so
    // the run is green without a label — exactly the baseline contract.
    return {
        state: 'success',
        operational_outcome: outcome,
        verdict: lowest.verdict,
        confidence: lowest.confidence,
        waived: decisions.every((d) => d.waived),
        reason: decisions.length === 1 ?
            lowest.reason :
            `${decisions.length} clusters all waived; weakest: ${lowest.reason}`,
        green_clusters: decisions.length,
        red_clusters: 0,
    };
}

function runFailure(outcome, reason, extra) {
    return {
        state: 'failure',
        operational_outcome: outcome,
        verdict: undefined,
        confidence: undefined,
        waived: false,
        reason,
        ...extra,
    };
}

/**
 * Build the commit-status description. GitHub truncates at 140 characters, so
 * the operational outcome's headline goes first — it is what a reader needs when
 * the text is cut. The confidence bar and tier are policy internals and never
 * lead; a clean pass has no headline, just its reason.
 */
function statusDescription(runDecision) {
    const headline = OUTCOME_HEADLINES[runDecision.operational_outcome];
    if (!headline) {
        // No outcome: on a passing run the reason ("no failures to triage") is the
        // whole message, and prefixing it with a failure headline would read as a
        // problem where there is none.
        return singleLine(runDecision.reason || 'triage did not complete').slice(0, 140);
    }
    return singleLine(`${headline}: ${runDecision.reason}`).slice(0, 140);
}

/**
 * Flatten text to a single line with no control characters.
 *
 * A status description is one line by definition, but the reason it is built
 * from carries the model's root_cause — untrusted text. This value reaches
 * GITHUB_OUTPUT as `description=<text>`, where a newline starts a new
 * `key=value` assignment and the last assignment for a key wins. A root_cause
 * containing "\nstate=success\nwaived=true" would therefore have overwritten the
 * run's own state and turned a red run green, comfortably within 140 characters.
 */
function singleLine(text) {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    return String(text ?? '').
        replace(/[\u0000-\u001F\u007F]+/g, ' ').
        replace(/\s+/g, ' ').
        trim();
}

/**
 * Parse the model's output.
 *
 * Anything that is not exactly the expected shape becomes INCONCLUSIVE rather
 * than a best-effort interpretation: guessing at a malformed verdict is how a
 * garbled response turns into an unearned green. INCONCLUSIVE then resolves to
 * TRIAGE_FAILED in decideCluster, so a garbled response cannot green a run.
 */
function parseModelOutput(raw) {
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch {
        return {ok: false, error: 'model output is not valid JSON', verdicts: []};
    }
    if (!doc || !Array.isArray(doc.verdicts)) {
        return {ok: false, error: 'model output has no verdicts array', verdicts: []};
    }
    const verdicts = doc.verdicts.map((entry) => {
        // The model's output is untrusted JSON, so an entry need not be an
        // object. `verdicts: [null]` would throw on the first property read and
        // take down the whole adjudication, turning one malformed element into
        // no verdict at all rather than one rejected verdict.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return {
                cluster_signature: null,
                verdict: 'INCONCLUSIVE',
                confidence: 0,
                evidence: [],
                root_cause: 'rejected: verdict entry is not an object',
            };
        }
        const v = entry;
        const evidence = Array.isArray(v.evidence) ? v.evidence : [];
        const confidence = typeof v.confidence === 'number' ? v.confidence : NaN;
        const valid = VERDICTS.has(v.verdict) &&
            Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
            // Two independent evidence items minimum. A verdict with one citation
            // is an assertion; the whole design rests on corroboration.
            (new Set(evidence.map((e) => JSON.stringify(e))).size >= 2 ||
                v.verdict === 'INCONCLUSIVE');
        return valid ?
            {...v, confidence: Number(v.confidence), evidence} :
            {
                cluster_signature: v.cluster_signature,
                verdict: 'INCONCLUSIVE',
                confidence: 0,
                evidence,
                root_cause: `rejected: ${VERDICTS.has(v.verdict) ? 'insufficient evidence cited' : `unknown verdict ${v.verdict}`}`,
            };
    });
    return {ok: true, error: null, verdicts};
}

module.exports = {
    GREEN_CONFIDENCE_BAR,
    RED_CONFIDENCE_BAR,
    VERDICTS,
    OUTCOMES,
    OUTCOME_HEADLINES,
    BASELINE_RUN_TYPES,
    KNOWN_RUN_TYPES,
    REGRESSION_VERDICTS,
    WAIVABLE,
    decideCluster,
    decideRun,
    parseModelOutput,
    statusDescription,
};