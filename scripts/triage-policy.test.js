// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
    GREEN_CONFIDENCE_BAR,
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

// ---------- asymmetric confidence bars ----------

test('green needs a higher bar than red', () => {
    const weakGreen = decideCluster(verdict({confidence: 0.8}), assist);
    const weakRed = decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.8}), assist);

    assert.equal(weakGreen.state, 'failure', '0.8 is under the green bar');
    assert.equal(weakGreen.verdict, 'INCONCLUSIVE');
    assert.equal(weakRed.state, 'failure');
    assert.equal(weakRed.verdict, 'PR_REGRESSION', '0.8 clears the red bar, so the verdict stands');
});

test('a waivable verdict at the bar exactly is waived', () => {
    const atBar = decideCluster(verdict({confidence: GREEN_CONFIDENCE_BAR}), assist);

    assert.equal(atBar.state, 'success');
    assert.equal(atBar.waived, true);
});

// ---------- branch and amnesty guards ----------

test('flakes are never auto-greened on the baseline branch', () => {
    const onMain = decideCluster(verdict(), {mode: 'assist', runType: 'MAIN'});

    assert.equal(onMain.state, 'failure');
    assert.match(onMain.reason, /baseline health/);
});

test('a test out of waiver budget stops being waivable', () => {
    const exhausted = decideCluster(verdict(), {...assist, amnestyExhausted: true});

    assert.equal(exhausted.state, 'failure');
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
    assert.equal(overlapping.state, 'failure');
    assert.equal(overlapping.verdict, 'INCONCLUSIVE');
});

// ---------- shadow mode ----------

test('shadow mode records what it would have done without doing it', () => {
    const shadow = decideCluster(verdict(), {mode: 'shadow', runType: 'PR'});

    assert.equal(shadow.state, 'failure');
    assert.equal(shadow.waived, false);
    assert.equal(shadow.shadow, true);
    assert.match(shadow.reason, /shadow mode/);
});

// ---------- run rollup ----------

test('one unwaived cluster keeps the whole run red', () => {
    const run = decideRun([
        decideCluster(verdict(), assist),
        decideCluster(verdict({verdict: 'PR_REGRESSION', confidence: 0.9}), assist),
    ]);

    assert.equal(run.state, 'failure');
    assert.equal(run.green_clusters, 1);
    assert.equal(run.red_clusters, 1);
});

test('a run is green only when every cluster is waived', () => {
    const run = decideRun([
        decideCluster(verdict(), assist),
        decideCluster(verdict({verdict: 'FLAKY_SERVER', confidence: 0.9}), assist),
    ]);

    assert.equal(run.state, 'success');
    assert.equal(run.waived, true);
    // The weakest link is what gets reported, not the most flattering one.
    assert.match(run.reason, /weakest/);
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

test('status description fits the GitHub limit and leads with the verdict', () => {
    const desc = statusDescription({
        verdict: 'FLAKY_INFRA',
        confidence: 0.93,
        reason: 'x'.repeat(400),
    });

    assert.ok(desc.length <= 140);
    assert.ok(desc.startsWith('flaky-infra (0.93)'));
});
