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
 * Two rules do most of the work:
 *
 *  1. Fail closed. Anything unexpected — missing verdict, unparseable model
 *     output, unknown verdict class, confidence below bar, triage itself
 *     erroring — resolves to red. There is no path where "we don't know"
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
        mode = 'shadow',
    } = context;

    const verdict = verdictRecord && verdictRecord.verdict;
    const confidence = Number(verdictRecord && verdictRecord.confidence);

    if (!VERDICTS.has(verdict) || !Number.isFinite(confidence)) {
        return red('INCONCLUSIVE', 0, 'triage produced no usable verdict');
    }

    const wantsGreen = WAIVABLE.has(verdict);
    const bar = wantsGreen ? GREEN_CONFIDENCE_BAR : RED_CONFIDENCE_BAR;

    if (confidence < bar) {
        return red(
            'INCONCLUSIVE',
            confidence,
            `${verdict} at ${confidence} is below the ${wantsGreen ? 'green' : 'red'} bar of ${bar}`,
        );
    }

    if (!wantsGreen) {
        return red(verdict, confidence, verdictRecord.root_cause || verdict);
    }

    // Main and release health must reflect reality. Auto-greening a flake on the
    // baseline branch would hide exactly the signal the baseline exists to give,
    // and it is also the branch every PR's baseline comparison is drawn from.
    if (runType !== 'PR') {
        return red(
            verdict,
            confidence,
            `${verdict} on ${runType} stays red — baseline health must reflect reality`,
        );
    }

    // A test out of waiver budget is no longer noise, it is unmaintained.
    if (amnestyExhausted) {
        return red(
            verdict,
            confidence,
            'flake amnesty exhausted — fix or quarantine explicitly',
        );
    }

    // A main regression only excuses *this* PR if the PR is not touching the same
    // area. Overlap means attribution is genuinely ambiguous, and ambiguity is red.
    if (verdict === 'MAIN_REGRESSION' && diffOverlapsFailure) {
        return red(
            'INCONCLUSIVE',
            confidence,
            'pre-existing on main, but this PR touches the same area — cannot attribute cleanly',
        );
    }

    // Shadow mode observes without acting: it posts its own context but never
    // waives, so accuracy can be measured before any authority is granted.
    if (mode === 'shadow') {
        return {
            state: 'failure',
            verdict,
            confidence,
            waived: false,
            shadow: true,
            reason: `${verdict} — would waive, but triage is in shadow mode`,
        };
    }

    return {
        state: 'success',
        verdict,
        confidence,
        waived: true,
        shadow: false,
        reason: verdictRecord.root_cause || verdict,
    };
}

function red(verdict, confidence, reason) {
    return {state: 'failure', verdict, confidence, waived: false, shadow: false, reason};
}

/**
 * Roll per-cluster decisions into the run's outcome.
 *
 * A run is only waivable if *every* cluster is. One unexplained cluster among
 * nine waived ones is still an unexplained failure, and greening the run because
 * the majority was flaky is precisely the failure mode that would make this
 * system untrustworthy.
 */
function decideRun(decisions) {
    if (decisions.length === 0) {
        return {
            state: 'failure',
            waived: false,
            reason: 'triage produced no decisions',
            green_clusters: 0,
            red_clusters: 0,
        };
    }

    const reds = decisions.filter((d) => d.state !== 'success');
    if (reds.length > 0) {
        const worst = reds.sort((a, b) => b.confidence - a.confidence)[0];
        return {
            state: 'failure',
            waived: false,
            reason: reds.length === 1 ?
                worst.reason :
                `${reds.length} unwaived cluster(s); most confident: ${worst.reason}`,
            verdict: worst.verdict,
            green_clusters: decisions.length - reds.length,
            red_clusters: reds.length,
        };
    }

    const lowest = decisions.reduce((a, b) => (a.confidence <= b.confidence ? a : b));
    return {
        state: 'success',
        waived: true,
        reason: decisions.length === 1 ?
            lowest.reason :
            `${decisions.length} clusters all waived; weakest: ${lowest.reason}`,
        verdict: lowest.verdict,
        green_clusters: decisions.length,
        red_clusters: 0,
    };
}

/**
 * Build the commit-status description. GitHub truncates at 140 characters, so
 * the verdict and confidence go first — they are what a reader needs when the
 * text is cut.
 */
function statusDescription(runDecision) {
    const prefix = runDecision.verdict ?
        `${runDecision.verdict.toLowerCase().replace(/_/g, '-')} (${runDecision.confidence ?? '?'})` :
        'inconclusive';
    return `${prefix}: ${runDecision.reason}`.slice(0, 140);
}

/**
 * Parse the model's output.
 *
 * Anything that is not exactly the expected shape becomes INCONCLUSIVE rather
 * than a best-effort interpretation: guessing at a malformed verdict is how a
 * garbled response turns into an unearned green.
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
    const verdicts = doc.verdicts.map((v) => {
        const evidence = Array.isArray(v.evidence) ? v.evidence : [];
        const valid = VERDICTS.has(v.verdict) &&
            Number.isFinite(Number(v.confidence)) &&
            // Two independent evidence items minimum. A verdict with one citation
            // is an assertion; the whole design rests on corroboration.
            (evidence.length >= 2 || v.verdict === 'INCONCLUSIVE');
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
    WAIVABLE,
    decideCluster,
    decideRun,
    parseModelOutput,
    statusDescription,
};
