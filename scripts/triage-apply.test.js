// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {assembleVerdicts} = require('./triage-apply');
const {decideCluster, decideRun} = require('./triage-policy');

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
    assert.equal(verdicts[0].cluster_signature, null);
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
        {cluster_signature: 'b', verdict: 'FLAKY_TEST', confidence: 0.9, evidence: [{}, {}]},
    ]);

    assert.equal(verdicts[0].verdict, 'INCONCLUSIVE', 'cluster a had no model verdict');
    assert.equal(verdicts[1].verdict, 'FLAKY_TEST');
    assert.equal(verdicts[1].source, 'model');
});

test('a partly-adjudicated run stays red because of the unexplained cluster', () => {
    const verdicts = assembleVerdicts(evidence({
        clusters: [
            {signature_hash: 'a', needs_ai: false, rule_verdict: 'FLAKY_INFRA', confidence: 0.95, reason: 'adb', member_count: 9, matched_signatures: []},
            {signature_hash: 'b', needs_ai: true, member_count: 1, matched_signatures: []},
        ],
    }), []);

    const run = decideRun(verdicts.map((v) => decideCluster(v, assist)));

    assert.equal(run.state, 'failure');
    assert.equal(run.red_clusters, 1);
    assert.equal(run.green_clusters, 1);
});

// ---------- blame reaches the comment ----------

const {renderComment} = require('./triage-apply');
const {attribute} = require('./triage-blame');

test('a resolved main-regression callout is rendered into the PR comment', () => {
    const body = renderComment(
        {state: 'success', waived: true, reason: 'pre-existing on main'},
        [{verdict: 'MAIN_REGRESSION', confidence: 0.9, reason: 'pre-existing on main'}],
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
});

test('a comment without blame renders unchanged', () => {
    const body = renderComment(
        {state: 'failure', waived: false, reason: 'nope'},
        [{verdict: 'PR_REGRESSION', confidence: 0.9, reason: 'nope'}],
        [{cluster_signature: 'sig', member_count: 1, source: 'model'}],
        {commitSha: 'abcdef1234567890', commitUrl: 'x', tier: 1, tierReason: '1 failure'},
    );

    assert.ok(!/Main regression detected/.test(body));
});
