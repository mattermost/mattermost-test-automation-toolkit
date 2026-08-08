// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {assembleVerdicts, renderComment, markTriageFailed} = require('./triage-apply');
const {decideCluster, decideRun, OUTCOMES} = require('./triage-policy');

const assist = {mode: 'assist', runType: 'PR'};

function evidence(overrides = {}) {
    return {
        tier: 1,
        tier_reason: '3 failures',
        summary: {totalTests: 100, passed: 97, failed: 3, shards: []},
        suite_verdict: null,
        clusters: [],
        ...overrides,
    };
}

test('a decided suite verdict replaces per-cluster adjudication entirely', () => {
    const verdicts = assembleVerdicts(evidence({
        suite_verdict: {verdict: 'FLAKY_INFRA', confidence: 0.95, reason: 'no shard produced results', rule_id: 'suite.no-results'},
        clusters: [{signature_hash: 'a', needs_ai: true, member_count: 40}],
    }), []);

    assert.equal(verdicts.length, 1, 'clusters are symptoms of the suite failure, not separate causes');
    assert.equal(verdicts[0].source, 'rules');

    // Keyed on the rule rather than left null: TSIO requires one of
    // external_test_id or cluster_signature, so a null/null row was rejected and
    // the one verdict class that can waive a whole run never reached the ledger.
    assert.equal(verdicts[0].cluster_signature, 'suite:suite.no-results');
});

test('rule-decided clusters never consult the model output', () => {
    const verdicts = assembleVerdicts(evidence({
        clusters: [{
            signature_hash: 'a',
            needs_ai: false,
            rule_verdict: 'FLAKY_INFRA',
            confidence: 0.95,
            reason: 'emulator lost adb',
            member_count: 12,
            matched_signatures: [{id: 'device.adb-offline'}],
        }],
    }), [{cluster_signature: 'a', verdict: 'PR_REGRESSION', confidence: 0.99, evidence: [{}, {}]}]);

    assert.equal(verdicts[0].verdict, 'FLAKY_INFRA');
    assert.equal(verdicts[0].source, 'rules');
});

test('a cluster the model skipped is INCONCLUSIVE, not assumed benign', () => {
    const verdicts = assembleVerdicts(evidence({
        clusters: [{signature_hash: 'ghost', needs_ai: true, member_count: 2, matched_signatures: []}],
    }), []);

    assert.equal(verdicts[0].verdict, 'INCONCLUSIVE');
    assert.equal(verdicts[0].source, 'missing');
    assert.equal(decideCluster(verdicts[0], assist).state, 'failure');
});

test('a model verdict is matched to its cluster by signature', () => {
    const verdicts = assembleVerdicts(evidence({
        clusters: [
            {signature_hash: 'a', needs_ai: true, member_count: 1, matched_signatures: []},
            {signature_hash: 'b', needs_ai: true, member_count: 1, matched_signatures: []},
        ],
    }), [
        {cluster_signature: 'b', verdict: 'FLAKY_TEST', confidence: 0.9, evidence: [{kind: 'log'}, {kind: 'rerun'}]},
    ]);

    assert.equal(verdicts[0].verdict, 'INCONCLUSIVE', 'cluster a had no model verdict');
    assert.equal(verdicts[1].verdict, 'FLAKY_TEST');
    assert.equal(verdicts[1].source, 'model');
});

test('a partly-adjudicated run stays red because of the unexplained cluster', () => {
    const verdicts = assembleVerdicts(evidence({
        clusters: [
            // Two matched signatures, because a waiver needs two independent
            // citations whatever produced it — a rule verdict is not exempt.
            {signature_hash: 'a',
                needs_ai: false,
                rule_verdict: 'FLAKY_INFRA',
                confidence: 0.95,
                reason: 'adb',
                member_count: 9,
                matched_signatures: [{id: 'device.adb-offline'}, {id: 'infra.runner-oom'}]},
            {signature_hash: 'b', needs_ai: true, member_count: 1, matched_signatures: []},
        ],
    }), []);

    const run = decideRun(verdicts.map((v) => decideCluster(v, assist)));

    assert.equal(run.state, 'failure');
    assert.equal(run.red_clusters, 1);
    assert.equal(run.green_clusters, 1);
});

// ---------- the ledger maps rows to clusters by signature, not by index ----------

test('ledger evidence is not the old undefined clusterByIndex lookup', () => {
    // The previous code read `clusterByIndex[i].member_test_ids`, but
    // clusterByIndex was never defined — so the lookup threw and the catch
    // swallowed it, and no verdict ever reached TSIO. assembleVerdicts now keeps
    // the cluster_signature on every row so the caller can map by signature.
    const verdicts = assembleVerdicts(evidence({
        clusters: [{
            signature_hash: 'sig-abc',
            needs_ai: true,
            member_count: 3,
            member_test_ids: ['MM-T1_1', 'MM-T1_2', 'MM-T1_3'],
            matched_signatures: [],
        }],
    }), [{cluster_signature: 'sig-abc', verdict: 'FLAKY_TEST', confidence: 0.9,
        evidence: [{kind: 'log'}, {kind: 'rerun'}]}]);

    assert.equal(verdicts[0].cluster_signature, 'sig-abc');
    assert.equal(verdicts[0].member_count, 3);
});

// ---------- markTriageFailed downgrades a green run ----------

test('markTriageFailed turns a green run red with the triage-failed outcome', () => {
    const green = decideRun([decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.95,
        evidence: [{kind: 'log'}, {kind: 'rerun'}],
    }, assist)]);

    assert.equal(green.state, 'success');

    const failed = markTriageFailed(green, 'ledger recording failed — 503');

    assert.equal(failed.state, 'failure');
    assert.equal(failed.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.equal(failed.waived, false);
    assert.match(failed.reason, /ledger recording failed/);
});

// ---------- blame reaches the comment ----------

const {attribute} = require('./triage-blame');

test('a resolved main-regression callout is rendered into the PR comment', () => {
    const body = renderComment(
        {state: 'success', waived: true, operational_outcome: OUTCOMES.FLAKY_CONFIRMED, reason: 'pre-existing on main'},
        [{verdict: 'MAIN_REGRESSION', confidence: 0.9, operational_outcome: OUTCOMES.FLAKY_CONFIRMED, reason: 'pre-existing on main'}],
        [{cluster_signature: 'sig', member_count: 1, source: 'model'}],
        {
            commitSha: 'abcdef1234567890',
            commitUrl: 'https://github.com/o/r/commit/abcdef1234567890',
            tier: 1,
            tierReason: '1 failure',
            blame: [{
                attribution: attribute([{
                    sha: 'deadbeef123',
                    author: {login: 'alice'},
                    commit: {message: 'refactor the channel list'},
                    parents: [{sha: 'p'}],
                }]),
                text: '### Main regression detected\n\n**Author:** @alice',
            }],
        },
    );

    assert.match(body, /Main regression detected/);
    assert.match(body, /@alice/, 'the person who can actually fix it has to be named');
    assert.match(body, /Outcome:\*\* `FLAKY_CONFIRMED`/);
});

test('a comment without blame renders unchanged', () => {
    const body = renderComment(
        {state: 'failure', waived: false, operational_outcome: OUTCOMES.REGRESSION, reason: 'nope'},
        [{verdict: 'PR_REGRESSION', confidence: 0.9, operational_outcome: OUTCOMES.REGRESSION, reason: 'nope'}],
        [{cluster_signature: 'sig', member_count: 1, source: 'model'}],
        {commitSha: 'abcdef1234567890', commitUrl: 'x', tier: 1, tierReason: '1 failure'},
    );

    assert.ok(!/Main regression detected/.test(body));
    assert.match(body, /Outcome:\*\* `REGRESSION`/);
});