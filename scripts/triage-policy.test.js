// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
    GREEN_CONFIDENCE_BAR,
    OUTCOMES,
    decideCluster,
    decideRun,
    parseModelOutput,
    statusDescription,
} = require('./triage-policy');

const assist = {mode: 'assist', runType: 'PR'};

function verdict(overrides = {}) {
    return {
        verdict: 'FLAKY_INFRA',
        confidence: 0.95,
        root_cause: 'emulator lost adb on shard 3',
        evidence: [{kind: 'log'}, {kind: 'rerun'}],
        ...overrides,
    };
}

// ---------- fail closed ----------

test('a missing verdict resolves red, never green', () => {
    assert.equal(decideCluster(null, assist).state, 'failure');
    assert.equal(decideCluster({}, assist).state, 'failure');
    assert.equal(decideCluster({verdict: 'NOT_A_VERDICT', confidence: 1}, assist).state, 'failure');
});

test('a non-numeric confidence resolves red', () => {
    assert.equal(decideCluster(verdict({confidence: 'very'}), assist).state, 'failure');
});

// ---------- operational outcomes ----------

test('a confirmed flake is FLAKY_CONFIRMED and succeeds', () => {
    const d = decideCluster(verdict(), assist);

    assert.equal(d.state, 'success');
    assert.equal(d.operational_outcome, OUTCOMES.FLAKY_CONFIRMED);
    assert.equal(d.waived, true, 'PR waivers apply the label');
});

test('a genuine failure is REGRESSION', () => {
    const d = decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.9}), assist);

    assert.equal(d.state, 'failure');
    assert.equal(d.operational_outcome, OUTCOMES.REGRESSION);
    assert.equal(d.verdict, 'PR_REGRESSION', 'the stored verdict is preserved');
});

test('INCONCLUSIVE is TRIAGE_FAILED, not a silent red', () => {
    const d = decideCluster(verdict({verdict: 'INCONCLUSIVE', confidence: 0.9}), assist);

    assert.equal(d.state, 'failure');
    assert.equal(d.operational_outcome, OUTCOMES.TRIAGE_FAILED);
});

test('an unknown run type is TRIAGE_FAILED', () => {
    const d = decideCluster(verdict(), {mode: 'assist', runType: 'HOTFIX'});

    assert.equal(d.state, 'failure');
    assert.equal(d.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(d.reason, /unknown run type/);
});

// ---------- asymmetric confidence bars ----------

test('green needs a higher bar than red', () => {
    const weakGreen = decideCluster(verdict({confidence: 0.8}), assist);
    const weakRed = decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.8}), assist);

    assert.equal(weakGreen.state, 'failure', '0.8 is under the green bar');
    assert.equal(weakGreen.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.equal(weakRed.state, 'failure');
    assert.equal(weakRed.verdict, 'PR_REGRESSION', '0.8 clears the red bar, so the verdict stands');
    assert.equal(weakRed.operational_outcome, OUTCOMES.REGRESSION);
});

test('a waivable verdict at the bar exactly is waived', () => {
    const atBar = decideCluster(verdict({confidence: GREEN_CONFIDENCE_BAR}), assist);

    assert.equal(atBar.state, 'success');
    assert.equal(atBar.waived, true);
});

test('a red verdict below the red bar is triage failure, not a silent green', () => {
    const d = decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.5}), assist);

    assert.equal(d.state, 'failure');
    assert.equal(d.operational_outcome, OUTCOMES.TRIAGE_FAILED, 'low confidence is triage failure');
    assert.equal(d.verdict, 'INCONCLUSIVE', 'the untrusted verdict is rejected');
});

// ---------- branch and amnesty guards ----------

test('confirmed flakes on the baseline branch succeed without a label', () => {
    for (const runType of ['MAIN', 'MASTER', 'RELEASE', 'CMT']) {
        const onBaseline = decideCluster(verdict(), {mode: 'assist', runType});

        assert.equal(onBaseline.state, 'success', `${runType} confirms flakes`);
        assert.equal(onBaseline.operational_outcome, OUTCOMES.FLAKY_CONFIRMED);
        assert.equal(onBaseline.waived, false, 'baseline success is recorded, not labelled');
    }
});

test('a low-confidence flake on the baseline branch is triage failure', () => {
    const onMain = decideCluster(verdict({confidence: 0.5}), {mode: 'assist', runType: 'MAIN'});

    assert.equal(onMain.state, 'failure');
    assert.equal(onMain.operational_outcome, OUTCOMES.TRIAGE_FAILED);
});

test('a test out of waiver budget is a regression, not a flake', () => {
    const exhausted = decideCluster(verdict(), {...assist, amnestyExhausted: true});

    assert.equal(exhausted.state, 'failure');
    assert.equal(exhausted.operational_outcome, OUTCOMES.REGRESSION);
    assert.match(exhausted.reason, /amnesty exhausted/);
});

test('a main regression excuses the PR only when the PR is elsewhere', () => {
    const unrelated = decideCluster(
        verdict({verdict: 'MAIN_REGRESSION'}),
        {...assist, diffOverlapsFailure: false},
    );
    const overlapping = decideCluster(
        verdict({verdict: 'MAIN_REGRESSION'}),
        {...assist, diffOverlapsFailure: true},
    );

    assert.equal(unrelated.state, 'success');
    assert.equal(unrelated.operational_outcome, OUTCOMES.FLAKY_CONFIRMED);
    assert.equal(overlapping.state, 'failure');
    assert.equal(overlapping.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.equal(overlapping.verdict, 'INCONCLUSIVE');
});

test('a main regression on a baseline branch is itself a regression', () => {
    for (const runType of ['MAIN', 'MASTER', 'RELEASE', 'CMT']) {
        const d = decideCluster(
            verdict({verdict: 'MAIN_REGRESSION', confidence: 0.9}),
            {mode: 'assist', runType},
        );

        assert.equal(d.state, 'failure', `${runType} must fail a main regression`);
        assert.equal(d.operational_outcome, OUTCOMES.REGRESSION);
        assert.equal(d.verdict, 'MAIN_REGRESSION', 'the stored verdict is preserved');
    }
});

// ---------- shadow mode ----------

test('shadow mode records what it would have done without doing it', () => {
    const shadow = decideCluster(verdict(), {mode: 'shadow', runType: 'PR'});

    assert.equal(shadow.state, 'failure');
    assert.equal(shadow.waived, false);
    assert.equal(shadow.shadow, true);
    assert.equal(shadow.operational_outcome, OUTCOMES.FLAKY_CONFIRMED, 'it records what it would be');
    assert.match(shadow.reason, /shadow mode/);
});

// ---------- run rollup ----------

test('one unwaived cluster keeps the whole run red', () => {
    const run = decideRun([
        decideCluster(verdict(), assist),
        decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.9}), assist),
    ]);

    assert.equal(run.state, 'failure');
    assert.equal(run.operational_outcome, OUTCOMES.REGRESSION);
    assert.equal(run.green_clusters, 1);
    assert.equal(run.red_clusters, 1);
});

test('one triage-failed cluster keeps the whole run red as triage failure', () => {
    const run = decideRun([
        decideCluster(verdict(), assist),
        decideCluster(verdict({confidence: 0.5}), assist), // below green bar → TRIAGE_FAILED
    ]);

    assert.equal(run.state, 'failure');
    assert.equal(run.operational_outcome, OUTCOMES.TRIAGE_FAILED);
});

test('a run is green only when every cluster is waived', () => {
    const run = decideRun([
        decideCluster(verdict(), assist),
        decideCluster(verdict({verdict: 'FLAKY_SERVER', confidence: 0.9}), assist),
    ]);

    assert.equal(run.state, 'success');
    assert.equal(run.waived, true);
    assert.equal(run.operational_outcome, OUTCOMES.FLAKY_CONFIRMED);
    // The weakest link is what gets reported, not the most flattering one.
    assert.match(run.reason, /weakest/);
});

test('a baseline run is green without being waived', () => {
    const run = decideRun([
        decideCluster(verdict(), {mode: 'assist', runType: 'MAIN'}),
        decideCluster(verdict({verdict: 'FLAKY_SERVER', confidence: 0.9}), {mode: 'assist', runType: 'MAIN'}),
    ]);

    assert.equal(run.state, 'success');
    assert.equal(run.waived, false, 'no label on a baseline branch');
    assert.equal(run.operational_outcome, OUTCOMES.FLAKY_CONFIRMED);
});

test('no decisions at all is red', () => {
    assert.equal(decideRun([]).state, 'failure');
});

// ---------- model output parsing ----------

test('unparseable model output yields no verdicts and is flagged', () => {
    const parsed = parseModelOutput('I think the tests are flaky!');

    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.verdicts, []);
    // decideRun on an empty set is red, so a garbled response cannot green a run.
    assert.equal(decideRun(parsed.verdicts.map((v) => decideCluster(v, assist))).state, 'failure');
});

test('a verdict citing fewer than two evidence items is downgraded', () => {
    const parsed = parseModelOutput(JSON.stringify({
        verdicts: [{
            cluster_signature: 'abc',
            verdict: 'FLAKY_INFRA',
            confidence: 0.99,
            evidence: [{kind: 'log'}],
        }],
    }));

    assert.equal(parsed.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.match(parsed.verdicts[0].root_cause, /insufficient evidence/);
    assert.equal(decideCluster(parsed.verdicts[0], assist).state, 'failure');
});

test('an unknown verdict class is downgraded rather than guessed at', () => {
    const parsed = parseModelOutput(JSON.stringify({
        verdicts: [{verdict: 'PROBABLY_FINE', confidence: 1, evidence: [{}, {}]}],
    }));

    assert.equal(parsed.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.match(parsed.verdicts[0].root_cause, /unknown verdict/);
});

test('a well-formed verdict survives parsing intact', () => {
    const parsed = parseModelOutput(JSON.stringify({verdicts: [verdict({cluster_signature: 'abc'})]}));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.verdicts[0].verdict, 'FLAKY_INFRA');
    assert.equal(decideCluster(parsed.verdicts[0], assist).state, 'success');
});

// ---------- status description ----------

test('status description leads with the operational outcome, not the confidence', () => {
    const desc = statusDescription({
        operational_outcome: OUTCOMES.FLAKY_CONFIRMED,
        verdict: 'FLAKY_INFRA',
        confidence: 0.93,
        reason: 'x'.repeat(400),
    });

    assert.ok(desc.length <= 140);
    assert.ok(desc.startsWith('confirmed flaky failures'), 'the headline leads');
    assert.ok(!desc.startsWith('flaky-infra'), 'no confidence-bar jargon as the headline');
});

test('a regression headline leads the regression description', () => {
    const desc = statusDescription({
        operational_outcome: OUTCOMES.REGRESSION,
        verdict: 'PR_REGRESSION',
        confidence: 0.9,
        reason: 'the change broke channel list rendering',
    });

    assert.ok(desc.startsWith('genuine test or product failure'));
});

test('a triage-failed headline leads the triage-failure description', () => {
    const desc = statusDescription({
        operational_outcome: OUTCOMES.TRIAGE_FAILED,
        verdict: 'INCONCLUSIVE',
        confidence: 0,
        reason: 'no usable verdict',
    });

    assert.ok(desc.startsWith('triage could not complete safely'));
});

// ---------- run shape: the three reasons there might be no decisions ----------

test('a passing suite is green, not red', () => {
    const run = decideRun([], {failureCount: 0, reportsFound: 4});

    assert.equal(run.state, 'success', 'reddening every passing run would make the check worthless');
    assert.equal(run.waived, false, 'nothing was waived — there was nothing to waive');
    assert.equal(run.operational_outcome, '', 'a clean pass has no triage outcome');
    assert.match(run.reason, /no failures/);
});

test('a run that produced no reports is red even though it also has no decisions', () => {
    const run = decideRun([], {failureCount: 0, reportsFound: 0});

    assert.equal(run.state, 'failure');
    assert.equal(run.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(run.reason, /no usable test results/);
});

test('failures with no decisions stay red', () => {
    const run = decideRun([], {failureCount: 7, reportsFound: 4});

    assert.equal(run.state, 'failure');
    assert.equal(run.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(run.reason, /7 failure/);
});

test('status description for a passing run does not read as a problem', () => {
    const desc = statusDescription(decideRun([], {failureCount: 0, reportsFound: 4}));

    assert.equal(desc, 'no failures to triage');
    assert.ok(!desc.includes('triage could not complete'));
});

test('the run carries the confidence of the decision it reports', () => {
    const green = decideRun([
        decideCluster(verdict({confidence: 0.99}), assist),
        decideCluster(verdict({verdict: 'FLAKY_SERVER', confidence: 0.88}), assist),
    ]);
    const red = decideRun([decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.91}), assist)]);

    // The weakest waived cluster is what the run is only as good as.
    assert.equal(green.confidence, 0.88);
    assert.equal(red.confidence, 0.91);
    assert.ok(!statusDescription(green).includes('(?)'), 'status must show a real confidence');
});

// ---------- rerun evidence overrules model inference ----------

test('a failure that reproduced on every rerun is a regression, not a flake', () => {
    const reproduced = decideCluster(verdict({confidence: 0.99}), {
        ...assist,
        reproducedOnRerun: true,
    });

    assert.equal(reproduced.state, 'failure', 'measurement beats interpretation');
    assert.equal(reproduced.operational_outcome, OUTCOMES.REGRESSION);
    assert.match(reproduced.reason, /reproduced on every rerun/);
});

test('rerun evidence does not interfere with a red verdict', () => {
    const red = decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.9}), {
        ...assist,
        reproducedOnRerun: true,
    });

    assert.equal(red.state, 'failure');
    assert.equal(red.verdict, 'PR_REGRESSION', 'the verdict stands; only waivers are blocked');
});

test('a cluster that cleared on rerun is still waivable', () => {
    const cleared = decideCluster(verdict({confidence: 0.9}), {
        ...assist,
        reproducedOnRerun: false,
    });

    assert.equal(cleared.state, 'success');
});

test('a confidence outside 0-1 is unusable, not merely low', () => {
    // Number.isFinite admits 5, which clears the 0.85 green bar. A model emitting
    // a 0-100 confidence would otherwise have bought itself a waiver.
    for (const bad of [5, 100, -0.5, 1.0001]) {
        const d = decideCluster(verdict({confidence: bad}), assist);
        assert.equal(d.state, 'failure', `confidence ${bad} must not waive`);
        assert.equal(d.verdict, 'INCONCLUSIVE');
        assert.equal(d.operational_outcome, OUTCOMES.TRIAGE_FAILED);
        assert.equal(d.waived, false);
    }
});

test('the confidence bounds are inclusive at both ends', () => {
    assert.equal(decideCluster(verdict({confidence: 1}), assist).waived, true);
    assert.equal(decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0}), assist).verdict, 'INCONCLUSIVE');
});

test('a null verdict entry is rejected rather than thrown on', () => {
    // The model's output is untrusted JSON. One malformed element must cost one
    // verdict, not the whole adjudication.
    const parsed = parseModelOutput(JSON.stringify({verdicts: [null, 'nope', []]}));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verdicts.length, 3);
    for (const v of parsed.verdicts) {
        assert.equal(v.verdict, 'INCONCLUSIVE');
        assert.equal(v.confidence, 0);
    }
});

test('parseModelOutput rejects an out-of-range confidence', () => {
    const parsed = parseModelOutput(JSON.stringify({
        verdicts: [{cluster_signature: 'a', verdict: 'FLAKY_TEST', confidence: 7, evidence: [{k: 1}, {k: 2}]}],
    }));
    assert.equal(parsed.verdicts[0].verdict, 'INCONCLUSIVE');
});

test('a status description is a single line even when the model supplies newlines', () => {
    // This value reaches GITHUB_OUTPUT as `description=<text>`, where a newline
    // starts a new key=value assignment and the last assignment wins — so an
    // embedded "state=success" would have overwritten the run's own verdict.
    const desc = statusDescription({
        operational_outcome: OUTCOMES.TRIAGE_FAILED,
        verdict: 'FLAKY_TEST',
        confidence: 0.9,
        reason: 'boom\nstate=success\nwaived=true',
    });
    assert.ok(!/[\r\n]/.test(desc), 'description must not contain a line break');
    assert.ok(desc.includes('state=success'), 'the text is kept, just flattened');
});

test('a run that produced no reports is red even when a suite rule explains it', () => {
    // The catalogue calls "every shard died" FLAKY_INFRA at 0.95, which is a
    // waivable verdict. A change that broke the build well enough to stop the
    // tests running would otherwise be waived green with no test evidence in
    // existence. The reportsFound guard used to sit behind a decisions.length
    // check that the suite path walks straight past.
    const suite = decideCluster({
        verdict: 'FLAKY_INFRA',
        confidence: 0.95,
        evidence: [{kind: 'suite-rule'}, {kind: 'suite-shape'}],
        root_cause: 'no shard produced a usable report',
    }, assist);
    const run = decideRun([suite], {failureCount: 0, reportsFound: 0});

    assert.equal(run.state, 'failure');
    assert.equal(run.waived, false);
    assert.equal(run.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(run.reason, /no usable test results/);
});

test('a non-numeric confidence is malformed, not maximally confident', () => {
    // Number(true) is 1, which clears the green bar outright.
    for (const bad of [true, '0.99', null, {}, []]) {
        const d = decideCluster({
            verdict: 'FLAKY_INFRA',
            confidence: bad,
            evidence: [{a: 1}, {b: 2}],
        }, assist);
        assert.equal(d.waived, false, `confidence ${JSON.stringify(bad)} must not waive`);
        assert.equal(d.verdict, 'INCONCLUSIVE');
    }
});

test('a waiver needs two citations whatever produced the verdict', () => {
    // The bar lived only in parseModelOutput, so rule-decided and suite verdicts
    // reached decideCluster having never been checked.
    const oneCite = decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.99, evidence: [{kind: 'signature', ref: 'x'}],
    }, assist);
    assert.equal(oneCite.waived, false);
    assert.equal(oneCite.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(oneCite.reason, /cites 1 independent item/);

    // Two copies of the same citation is one observation written twice.
    const dupCites = decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.99,
        evidence: [{kind: 'log', ref: 'same'}, {kind: 'log', ref: 'same'}],
    }, assist);
    assert.equal(dupCites.waived, false, 'duplicate citations are not corroboration');

    const twoCites = decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.99,
        evidence: [{kind: 'log', ref: 'a'}, {kind: 'history', ref: 'b'}],
    }, assist);
    assert.equal(twoCites.waived, true);
});

test('incomplete evidence — a citation without a kind — is triage failure', () => {
    // Two distinct citations, but one is a blank reference. Present in count, not
    // in substance: "missing citation" is triage failure.
    const d = decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.99,
        evidence: [{kind: 'log', ref: 'a'}, {ref: 'b'}],
    }, assist);

    assert.equal(d.waived, false);
    assert.equal(d.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.match(d.reason, /incomplete/);
});