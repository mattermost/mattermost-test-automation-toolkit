// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {attribute, blameCandidates, formatCallout, resolveSuspectRange} = require('./triage-blame');

function commit(sha, login, message = 'do a thing', parents = 1) {
    return {
        sha,
        author: login ? {login} : null,
        commit: {message, author: {name: login || 'Someone'}},
        parents: new Array(parents).fill({sha: 'p'}),
    };
}

// ---------- suspect range ----------

test('a failing streak with a known last pass is resolvable', () => {
    const r = resolveSuspectRange({last_pass_commit: 'aaa', failing_since_commit: 'bbb'});

    assert.equal(r.resolvable, true);
    assert.equal(r.lastPass, 'aaa');
    assert.equal(r.failingSince, 'bbb');
});

test('a test that is not currently failing has nobody to blame', () => {
    const r = resolveSuspectRange({last_pass_commit: 'aaa', failing_since_commit: null});

    assert.equal(r.resolvable, false);
    assert.match(r.reason, /not in a failing streak/);
});

test('a test that never passed in the window is not a fresh regression', () => {
    const r = resolveSuspectRange({last_pass_commit: null, failing_since_commit: 'bbb'});

    assert.equal(r.resolvable, false);
    assert.match(r.reason, /not a fresh regression/);
});

test('absent history is not resolvable', () => {
    assert.equal(resolveSuspectRange(null).resolvable, false);
});

// ---------- attribution ----------

test('a single commit in the range is attribution, not a guess', () => {
    const a = attribute([commit('abc1234', 'alice')]);

    assert.equal(a.confident, true);
    assert.equal(a.suspect.author, 'alice');
    assert.match(a.reason, /exactly one commit/i);
});

test('merge commits are excluded so the merge is not blamed for the change', () => {
    const a = attribute([commit('merge01', 'bob', 'Merge pull request #1', 2), commit('real123', 'alice')]);

    assert.equal(a.confident, true);
    assert.equal(a.suspect.sha, 'real123');
});

test('several commits are listed as candidates rather than one being picked', () => {
    const a = attribute([commit('a1', 'alice'), commit('b2', 'bob'), commit('c3', 'carol')]);

    assert.equal(a.confident, false, 'naming the wrong author burns trust in the callout');
    assert.equal(a.commits.length, 3);
});

test('a range too wide to reason about names nobody', () => {
    const many = Array.from({length: 20}, (unused, i) => commit(`sha${i}`, `dev${i}`));
    const a = attribute(many);

    assert.equal(a.confident, false);
    assert.match(a.reason, /too wide/);
    assert.equal(a.commits.length, 8);
    assert.equal(a.truncated, 12);
});

test('an empty range yields no attribution', () => {
    assert.equal(attribute([]).confident, false);
    assert.equal(attribute(null).confident, false);
});

// ---------- callout ----------

test('a confident callout names the commit and its author', () => {
    const out = formatCallout({
        repo: 'mattermost/mattermost-mobile',
        testIds: ['MM-T4783_1'],
        range: {resolvable: true, lastPass: 'aaaaaaaaaa', failingSince: 'bbbbbbbbbb'},
        attribution: attribute([commit('abc1234def', 'alice')]),
    });

    assert.match(out, /Main regression detected/);
    assert.match(out, /MM-T4783_1/);
    assert.match(out, /@alice/);
    assert.match(out, /compare\/aaaaaaaaaa\.\.\.bbbbbbbbbb/);
});

test('an unattributed callout lists candidates without accusing anyone', () => {
    const out = formatCallout({
        repo: 'mattermost/mattermost-mobile',
        testIds: ['MM-T1'],
        range: {resolvable: true, lastPass: 'a', failingSince: 'b'},
        attribution: attribute([commit('a1', 'alice'), commit('b2', 'bob')]),
    });

    assert.match(out, /Not attributed/);
    assert.match(out, /@alice/);
    assert.match(out, /@bob/);
    assert.ok(!/Suspect commit/.test(out), 'must not single anyone out when the range is ambiguous');
});

// ---------- candidate selection ----------

test('only MAIN_REGRESSION clusters are blamed', () => {
    const evidence = {
        clusters: [
            {history: [{test_id: 'MM-T1', history: {last_pass_commit: 'a', failing_since_commit: 'b'}}]},
            {history: [{test_id: 'MM-T2', history: {last_pass_commit: 'c', failing_since_commit: 'd'}}]},
        ],
    };
    const decisions = [{verdict: 'MAIN_REGRESSION'}, {verdict: 'FLAKY_TEST'}];

    const candidates = blameCandidates(evidence, decisions);

    assert.equal(candidates.length, 1, 'blaming a commit for a flake is a false accusation');
    assert.equal(candidates[0].testId, 'MM-T1');
});

test('a MAIN_REGRESSION with unusable history produces no candidate', () => {
    const evidence = {clusters: [{history: [{test_id: 'MM-T1', history: {failing_since_commit: null}}]}]};

    assert.deepEqual(blameCandidates(evidence, [{verdict: 'MAIN_REGRESSION'}]), []);
});

test('a suite verdict blames nobody', () => {
    // assembleVerdicts collapses a suite verdict to a single decision, so
    // decisions[0] describes the whole run while clusters[0] is one arbitrary
    // cluster. Zipping them would name an author picked essentially at random.
    const evidence = {
        suite_verdict: {verdict: 'MAIN_REGRESSION', confidence: 0.9},
        clusters: [{
            history: [{
                test_id: 'MM-T1',
                history: {last_pass_commit: 'aaa', failing_since_commit: 'bbb'},
            }],
        }],
    };
    assert.deepEqual(blameCandidates(evidence, [{verdict: 'MAIN_REGRESSION'}]), []);
});
