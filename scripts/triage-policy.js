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

    // Range, not just finiteness. Number.isFinite rejects NaN and Infinity but
    // happily admits 5, which clears the 0.85 green bar and waives — a model
    // that emits a confidence on a 0-100 scale, or a corrupted record copied
    // through assembleVerdicts, would silently buy itself a green. Confidence is
    // defined as a probability, so anything outside [0,1] is not a low-confidence
    // answer, it is an unusable one.
    if (!VERDICTS.has(verdict) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return red('INCONCLUSIVE', 0, 'triage produced no usable verdict');
    }

    const wantsGreen = WAIVABLE.has(verdict);
    const bar = wantsGreen ? GREEN_CONFIDENCE_BAR : RED_CONFIDENCE_BAR;

    // The two-citation rule is enforced here, not only in parseModelOutput.
    // Living in the parser it applied only to verdicts the model produced, so a
    // rule-decided cluster (needs_ai: false) and a suite verdict could waive on a
    // single citation — the invariant read as absolute but was model-only.
    // Citations must also be distinct: two copies of the same reference are one
    // observation written twice, and corroboration is the whole point.
    if (wantsGreen) {
        const cites = Array.isArray(verdictRecord.evidence) ? verdictRecord.evidence : [];
        const distinct = new Set(cites.map((c) => JSON.stringify(c)));
        if (distinct.size < 2) {
            return red(
                'INCONCLUSIVE',
                confidence,
                `${verdict} cites ${distinct.size} independent item(s) — a waiver needs 2`,
            );
        }
    }

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

    // The measurement overrules the inference. A failure that reproduced on every
    // rerun repetition is deterministic by definition, so no amount of model
    // confidence about the error text makes it flakiness. This is the strongest
    // single guard against a false green, because it is evidence rather than
    // interpretation.
    if (reproducedOnRerun) {
        return red(
            verdict,
            confidence,
            `${verdict} rejected — reproduced on every rerun, so it is deterministic`,
        );
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
        return {
            state: 'failure',
            waived: false,
            reason: 'no usable test results were produced — nothing could be triaged',
            green_clusters: 0,
            red_clusters: decisions.length,
        };
    }

    if (decisions.length === 0) {
        if (reportsFound === 0) {
            return {
                state: 'failure',
                waived: false,
                reason: 'no usable test results were produced — nothing could be triaged',
                green_clusters: 0,
                red_clusters: 0,
            };
        }
        if (failureCount === 0) {
            return {
                state: 'success',
                waived: false,
                reason: 'no failures to triage',
                green_clusters: 0,
                red_clusters: 0,
            };
        }
        return {
            state: 'failure',
            waived: false,
            reason: failureCount === null ?
                'triage produced no decisions' :
                `triage produced no decisions for ${failureCount} failure(s)`,
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
            confidence: worst.confidence,
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
        confidence: lowest.confidence,
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
    if (!runDecision.verdict) {
        // No verdict at all: on a passing run the reason ("no failures to
        // triage") is the whole message, and prefixing it with "inconclusive"
        // would read as a problem where there is none.
        return singleLine(runDecision.reason || 'triage did not complete').slice(0, 140);
    }
    const prefix = `${runDecision.verdict.toLowerCase().replace(/_/g, '-')} (${runDecision.confidence ?? '?'})`;
    return singleLine(`${prefix}: ${runDecision.reason}`).slice(0, 140);
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
    WAIVABLE,
    decideCluster,
    decideRun,
    parseModelOutput,
    statusDescription,
};
