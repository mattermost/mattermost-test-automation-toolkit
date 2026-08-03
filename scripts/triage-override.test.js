// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
    STATUS_DESCRIPTION_LIMIT,
    clampDescription,
    decideAfterOverride,
    parseCommand,
} = require('./triage-override');

// ---------- parsing ----------

test('a well-formed command parses', () => {
    const p = parseCommand('/e2e-triage-override PR_REGRESSION this really was broken by the change');

    assert.equal(p.ok, true);
    assert.equal(p.verdict, 'PR_REGRESSION');
    assert.equal(p.reason, 'this really was broken by the change');
    assert.equal(p.waivable, false);
});

test('verdicts are accepted in the form people actually type them', () => {
    for (const input of ['flaky-infra', 'FLAKY_INFRA', 'Flaky-Infra', 'flaky_infra']) {
        const p = parseCommand(`/e2e-triage-override ${input} emulator died again`);

        assert.equal(p.ok, true, `${input} should parse`);
        assert.equal(p.verdict, 'FLAKY_INFRA');
    }
});

test('the command is found on any line of a longer comment', () => {
    const p = parseCommand('I looked into this.\n\n/e2e-triage-override TEST_DEBT selector went stale\n\nthanks');

    assert.equal(p.ok, true);
    assert.equal(p.verdict, 'TEST_DEBT');
    assert.equal(p.reason, 'selector went stale');
});

test('a reason is mandatory', () => {
    const p = parseCommand('/e2e-triage-override FLAKY_TEST');

    assert.equal(p.ok, false);
    assert.match(p.error, /reason is required/);
});

test('an unknown verdict is rejected with the valid list', () => {
    const p = parseCommand('/e2e-triage-override NOT_MY_PROBLEM it is fine honestly');

    assert.equal(p.ok, false);
    assert.match(p.error, /not a known verdict/);
    assert.match(p.error, /PR_REGRESSION/);
});

test('a bare command explains the usage', () => {
    const p = parseCommand('/e2e-triage-override');

    assert.equal(p.ok, false);
    assert.match(p.error, /usage/);
});

test('an unrelated comment is not a command', () => {
    assert.equal(parseCommand('looks flaky to me').ok, false);
    assert.equal(parseCommand('').ok, false);
});

// ---------- resulting check state ----------

test('correcting to a not-your-fault verdict greens the check and applies the label', () => {
    const d = decideAfterOverride(parseCommand('/e2e-triage-override FLAKY_INFRA runner lost adb'));

    assert.equal(d.state, 'success');
    assert.equal(d.applyLabel, true);
    assert.match(d.description, /human override/);
});

test('correcting to a real-bug verdict reds the check and withdraws the waiver', () => {
    const d = decideAfterOverride(parseCommand('/e2e-triage-override PR_REGRESSION the change broke it'));

    assert.equal(d.state, 'failure');
    assert.equal(
        d.applyLabel, false,
        'the label is sticky and would keep greening later commits if left applied',
    );
});

test('INCONCLUSIVE is treated as unresolved, so it reds', () => {
    const d = decideAfterOverride(parseCommand('/e2e-triage-override INCONCLUSIVE nobody knows yet'));

    assert.equal(d.state, 'failure');
    assert.equal(d.applyLabel, false);
});

test('the description carries the verdict and the human reason in full', () => {
    // Unsliced on purpose. The previous assertion checked
    // `d.description.slice(0, 140).length <= 140`, which is true of every string
    // and so asserted nothing — and it checked truncation on the one function
    // that deliberately does not truncate. decideAfterOverride returns the whole
    // reason because the PR comment prints all of it; only the commit status is
    // capped, and that happens at the status call.
    const reason = 'x'.repeat(400);
    const d = decideAfterOverride(parseCommand(`/e2e-triage-override FLAKY_TEST ${reason}`));

    assert.match(d.description, /flaky-test/);
    assert.ok(d.description.includes(reason), 'the maintainer reason must survive intact');
});

test('the commit-status description is capped at the GitHub limit', () => {
    // The cap GitHub enforces silently. Asserting it here rather than at the
    // network call keeps it a tested rule instead of a bare slice.
    const long = decideAfterOverride(parseCommand(`/e2e-triage-override FLAKY_TEST ${'x'.repeat(400)}`));
    const clamped = clampDescription(long.description);

    assert.equal(clamped.length, STATUS_DESCRIPTION_LIMIT);
    assert.ok(clamped.startsWith('human override: flaky-test'), 'the verdict must survive truncation');

    // Short descriptions pass through untouched.
    const short = decideAfterOverride(parseCommand('/e2e-triage-override FLAKY_TEST it flakes'));
    assert.equal(clampDescription(short.description), short.description);
});
