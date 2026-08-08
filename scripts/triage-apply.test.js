// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
    assembleVerdicts, renderComment, markTriageFailed,
    computePlatformOutcomes, platformOutcomesLine, normalizePlatform, decisionClassification,
} = require('./triage-apply');
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
// ---------- per-platform outcomes ----------

// Build a real decideCluster decision for a verdict, so the platform mapping is
// exercised against the actual operational outcomes the policy emits.
function decision(verdict, context = {}) {
    return decideCluster({
        verdict,
        confidence: 0.95,
        root_cause: `${verdict} on shard`,
        // Two distinct citations so a waivable verdict actually clears the bar.
        evidence: [{kind: 'log', ref: 'a'}, {kind: 'rerun', ref: 'b'}],
    }, {mode: 'assist', runType: 'PR', ...context});
}

// Run computePlatformOutcomes against a list of {signature, platform, verdict, ctx}
// entries, mapping each to a verdict row + decision. Clusters are emitted in the
// order given; verdict rows follow `verdictOrder` (a list of signatures) when
// provided, so a positional lookup would misattribute platforms to verdicts.
function outcomesFor(entries, {verdictOrder, ledgerRecorded = true, suite, shards} = {}) {
    const bySig = new Map(entries.map((e) => [e.signature, e]));
    const order = verdictOrder || entries.map((e) => e.signature);
    const verdicts = order.map((sig) => ({cluster_signature: sig, member_count: 1, source: 'model'}));
    const decisions = order.map((sig) => {
        const e = bySig.get(sig);
        return decision(e.verdict, e.ctx || {});
    });
    const evidenceObj = suite ?
        {suite_verdict: suite, summary: {shards: shards || []}, clusters: []} :
        {clusters: entries.map((e) => ({signature_hash: e.signature, platforms: e.platform}))};
    return computePlatformOutcomes({evidence: evidenceObj, decisions, verdicts,
        ledgerRecorded});
}

test('ipad is normalised to ios before any aggregation', () => {
    assert.equal(normalizePlatform('ipad'), 'ios');
    assert.equal(normalizePlatform('ios'), 'ios');
    assert.equal(normalizePlatform('android'), 'android');

    const o = outcomesFor([{signature: 'a', platform: ['ipad'], verdict: 'FLAKY_INFRA'}]);
    assert.deepEqual(Object.keys(o), ['ios'], 'ipad collapses into ios, not its own platform');
});

// ---------- the verdict → classification mapping ----------

test('FLAKY_CONFIRMED → FLAKY / success', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'}]);
    assert.equal(o.ios.classification, 'FLAKY');
    assert.equal(o.ios.state, 'success');
    assert.equal(o.ios.suffix, 'verified to be flaky');
});

test('REGRESSION + TEST_DEBT → TEST_BUG / failure', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'TEST_DEBT'}]);
    assert.equal(o.ios.classification, 'TEST_BUG');
    assert.equal(o.ios.state, 'failure');
    assert.equal(o.ios.suffix, 'verified to be a test bug');
});

test('REGRESSION + deterministic FLAKY_TEST → TEST_BUG / failure', () => {
    const o = outcomesFor([{
        signature: 'a', platform: ['ios'], verdict: 'FLAKY_TEST',
        ctx: {reproducedOnRerun: true},
    }]);
    assert.equal(o.ios.classification, 'TEST_BUG',
        'a flake that reproduced on every rerun is a test bug, not a waivable flake');
    assert.equal(o.ios.state, 'failure');
});

test('REGRESSION + FLAKY_INFRA / FLAKY_SERVER → INFRASTRUCTURE_FAILURE / failure', () => {
    const infra = outcomesFor([{
        signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA',
        ctx: {reproducedOnRerun: true},
    }]);
    assert.equal(infra.ios.classification, 'INFRASTRUCTURE_FAILURE');
    assert.equal(infra.ios.suffix, 'verified to be an infrastructure failure');

    const server = outcomesFor([{
        signature: 'b', platform: ['ios'], verdict: 'FLAKY_SERVER',
        ctx: {reproducedOnRerun: true},
    }]);
    assert.equal(server.ios.classification, 'INFRASTRUCTURE_FAILURE');
});

test('other REGRESSION (PR_REGRESSION) → PRODUCT_BUG / failure', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'PR_REGRESSION'}]);
    assert.equal(o.ios.classification, 'PRODUCT_BUG');
    assert.equal(o.ios.state, 'failure');
    assert.equal(o.ios.suffix, 'verified to be a product bug');
});

test('BUILD_OR_ENV_ERROR is a PRODUCT_BUG, not infrastructure', () => {
    // Looks like infra but is a code problem — the mapping must not lump it with
    // FLAKY_INFRA just because it is environment-shaped.
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'BUILD_OR_ENV_ERROR'}]);
    assert.equal(o.ios.classification, 'PRODUCT_BUG');
});

test('TRIAGE_FAILED → TRIAGE_FAILED / failure', () => {
    // An INCONCLUSIVE verdict resolves to TRIAGE_FAILED in the policy engine.
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'INCONCLUSIVE'}]);
    assert.equal(o.ios.classification, 'TRIAGE_FAILED');
    assert.equal(o.ios.state, 'failure');
    assert.equal(o.ios.suffix, 'triage could not classify safely');
});

test('a low-confidence flake is TRIAGE_FAILED, not a green flake', () => {
    const d = decision('FLAKY_INFRA', {reproducedOnRerun: false});
    // Override confidence below the green bar directly: decideCluster below 0.85
    // returns TRIAGE_FAILED for a waivable verdict.
    const lowConf = decideCluster({
        verdict: 'FLAKY_INFRA', confidence: 0.5,
        evidence: [{kind: 'log'}, {kind: 'rerun'}],
    }, assist);
    assert.equal(lowConf.operational_outcome, OUTCOMES.TRIAGE_FAILED);
    assert.equal(decisionClassification(lowConf), 'TRIAGE_FAILED');
});

// ---------- mixed platforms and severity ----------

test('each platform is resolved independently', () => {
    const o = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'},
        {signature: 'b', platform: ['android'], verdict: 'PR_REGRESSION'},
    ]);
    assert.equal(o.ios.classification, 'FLAKY');
    assert.equal(o.ios.state, 'success');
    assert.equal(o.android.classification, 'PRODUCT_BUG');
    assert.equal(o.android.state, 'failure');
});

test('a spans-platforms cluster attributes its decision to every platform listed', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios', 'android'], verdict: 'PR_REGRESSION'}]);
    assert.equal(o.ios.classification, 'PRODUCT_BUG');
    assert.equal(o.android.classification, 'PRODUCT_BUG');
});

test('a platform is green only when every failure on it is confirmed flaky', () => {
    const o = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'},
        {signature: 'b', platform: ['ios'], verdict: 'PR_REGRESSION'},
    ]);
    assert.equal(o.ios.state, 'failure', 'one real bug among nine flakes is still red');
    // Severity: PRODUCT_BUG outranks FLAKY.
    assert.equal(o.ios.classification, 'PRODUCT_BUG');
});

test('mixed-platform severity: PRODUCT_BUG > TEST_BUG > INFRASTRUCTURE_FAILURE > TRIAGE_FAILED > FLAKY', () => {
    const o = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'TEST_DEBT'},          // TEST_BUG
        {signature: 'b', platform: ['ios'], verdict: 'PR_REGRESSION'},      // PRODUCT_BUG
        {signature: 'c', platform: ['ios'], verdict: 'FLAKY_INFRA'},         // FLAKY
    ]);
    assert.equal(o.ios.classification, 'PRODUCT_BUG');

    const o2 = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA',
            ctx: {reproducedOnRerun: true}},                                  // INFRASTRUCTURE_FAILURE
        {signature: 'b', platform: ['ios'], verdict: 'TEST_DEBT'},           // TEST_BUG
    ]);
    assert.equal(o2.ios.classification, 'TEST_BUG', 'TEST_BUG outranks INFRASTRUCTURE_FAILURE');

    const o3 = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'INCONCLUSIVE'},        // TRIAGE_FAILED
        {signature: 'b', platform: ['ios'], verdict: 'FLAKY_INFRA',
            ctx: {reproducedOnRerun: true}},                                  // INFRASTRUCTURE_FAILURE
    ]);
    assert.equal(o3.ios.classification, 'INFRASTRUCTURE_FAILURE',
        'INFRASTRUCTURE_FAILURE outranks TRIAGE_FAILED');

    const o4 = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'},         // FLAKY
        {signature: 'b', platform: ['ios'], verdict: 'INCONCLUSIVE'},        // TRIAGE_FAILED
    ]);
    assert.equal(o4.ios.classification, 'TRIAGE_FAILED',
        'TRIAGE_FAILED outranks FLAKY');
});

// ---------- signature-based mapping, never array position ----------

test('clusters are matched to verdicts by signature, not array position', () => {
    // Clusters emitted in [sig-a, sig-b] order in the evidence; verdict rows
    // deliberately reversed, so a positional `clusters[i]` lookup would attribute
    // sig-a's platform to sig-b's verdict.
    const o = outcomesFor(
        [
            {signature: 'sig-a', platform: ['ios'], verdict: 'FLAKY_INFRA'},
            {signature: 'sig-b', platform: ['android'], verdict: 'PR_REGRESSION'},
        ],
        {verdictOrder: ['sig-b', 'sig-a']},
    );
    assert.equal(o.ios.classification, 'FLAKY', 'sig-a is the flake, regardless of verdict order');
    assert.equal(o.android.classification, 'PRODUCT_BUG', 'sig-b is the regression');
});

// ---------- suite verdicts apply to every platform in summary shards ----------

test('a suite verdict is attributed to every platform the run spanned', () => {
    const suite = {verdict: 'FLAKY_INFRA', confidence: 0.95,
        reason: 'no shard produced results', rule_id: 'suite.no-results'};
    const shards = [{platform: 'ios'}, {platform: 'android'}, {platform: 'ipad'}];
    const verdicts = assembleVerdicts(
        {suite_verdict: suite, summary: {shards}, clusters: [{signature_hash: 'a', needs_ai: true, member_count: 40}]},
        [],
    );
    const decisions = verdicts.map((v) => decideCluster(v, assist));

    const o = computePlatformOutcomes({evidence: {suite_verdict: suite, summary: {shards},
        clusters: []}, decisions, verdicts, ledgerRecorded: true});

    assert.deepEqual(Object.keys(o).sort(), ['android', 'ios'],
        'ipad normalises into ios; android stays distinct');
    assert.equal(o.ios.classification, 'FLAKY', 'the suite verdict was a confirmed flake');
    assert.equal(o.ios.state, 'success');
    assert.equal(o.android.state, 'success');
});

// ---------- the ledger gate ----------

test('a flaky platform goes green only when the ledger recorded successfully', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'}],
        {ledgerRecorded: true});
    assert.equal(o.ios.classification, 'FLAKY');
    assert.equal(o.ios.state, 'success');
});

test('a ledger failure converts a flaky platform to TRIAGE_FAILED', () => {
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'}],
        {ledgerRecorded: false});
    assert.equal(o.ios.classification, 'TRIAGE_FAILED');
    assert.equal(o.ios.state, 'failure');
    assert.equal(o.ios.suffix, 'triage could not classify safely');
});

test('a ledger failure does not change an already-red platform', () => {
    // PRODUCT_BUG is red regardless of the ledger; only flaky platforms depend on it.
    const o = outcomesFor([{signature: 'a', platform: ['ios'], verdict: 'PR_REGRESSION'}],
        {ledgerRecorded: false});
    assert.equal(o.ios.classification, 'PRODUCT_BUG');
    assert.equal(o.ios.state, 'failure');
});

test('a mixed run with a ledger failure flips only the flaky platform', () => {
    const o = outcomesFor([
        {signature: 'a', platform: ['ios'], verdict: 'FLAKY_INFRA'},
        {signature: 'b', platform: ['android'], verdict: 'PR_REGRESSION'},
    ], {ledgerRecorded: false});
    assert.equal(o.ios.classification, 'TRIAGE_FAILED', 'flaky ios loses its waiver');
    assert.equal(o.ios.state, 'failure');
    assert.equal(o.android.classification, 'PRODUCT_BUG', 'android was already red');
});

// ---------- output-injection safety ----------

test('platform_outcomes serializes as one sanitized single line', () => {
    const o = {ios: {classification: 'FLAKY', state: 'success', suffix: 'verified to be flaky'}};
    const line = platformOutcomesLine(o);
    assert.equal(line.split('\n').length, 1, 'no raw newlines — one GITHUB_OUTPUT assignment');
    assert.equal(line, JSON.stringify(o));
    // The exact string written to GITHUB_OUTPUT is one line.
    const written = `platform_outcomes=${line}`;
    assert.equal(written.split('\n').length, 1);
});

test('a malicious platform name cannot inject a GITHUB_OUTPUT assignment', () => {
    // A platform key is caller-supplied (it comes from the evidence bundle), so a
    // value containing a newline + a forged assignment must not survive into the
    // output line. JSON.stringify escapes the newline; the sanitizer strips any
    // raw control char that slipped through.
    const o = outcomesFor(
        [{signature: 'a', platform: ['ios\nstate=success\nwaived=true'], verdict: 'FLAKY_INFRA'}],
    );
    const line = platformOutcomesLine(o);
    assert.ok(!line.includes('\n'), 'no raw newline reaches the output line');
    // The forged assignment does not appear as its own key=value line.
    assert.ok(!line.includes('\nwaived=true'));
    // And the line still parses back to valid JSON.
    JSON.parse(line);
});
