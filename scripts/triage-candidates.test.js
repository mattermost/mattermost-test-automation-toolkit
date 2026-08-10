// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');

const {
    buildCandidates,
    consumeArtifact,
    reconstructModelOutput,
    validateCitations,
    validateAndSplit,
    sanitize,
    CANDIDATE_VERDICTS,
    CITATION_KINDS,
    CANDIDATE_CONFIDENCE_BAR,
} = require('./triage-candidates');

// triage-apply assembles verdicts; triage-policy decides them. The integration
// tests exercise the same path the final workflow walks after reconstruction.
const {assembleVerdicts: assemble} = require('./triage-apply');
const {decideCluster: decide, decideRun: runDecide, OUTCOMES: OUT} = require('./triage-policy');

const assist = {mode: 'assist', runType: 'PR'};

// Build an evidence bundle whose `needs_ai` clusters are exactly the given
// signatures — i.e. the set the model is allowed to opine on.
function evidenceWith(sigs, overrides = {}) {
    return {
        clusters: sigs.map((sig) => ({signature_hash: sig, needs_ai: true, member_count: 1})),
        ...overrides,
    };
}

// A well-formed model verdict: two distinct, valid citations by default.
function modelVerdict(sig, verdict, overrides = {}) {
    return {
        cluster_signature: sig,
        verdict,
        confidence: 0.93,
        root_cause: `${verdict} on ${sig}`,
        evidence: [
            {kind: 'log', ref: 'device-log:1', supports: 'adb offline'},
            {kind: 'rerun', ref: 'rep:2', supports: 'passed on retry'},
        ],
        ...overrides,
    };
}

const modelRaw = (verdicts) => JSON.stringify({verdicts});

// ---------- 1. AI unavailable produces available=false ----------

test('AI unavailable produces an available=false artifact', () => {
    const a = buildCandidates({evidence: evidenceWith(['a']), modelRaw: ''});
    assert.equal(a.available, false);
    assert.equal(a.schema_version, 2);
    assert.deepEqual(a.verdicts, []);
    assert.deepEqual(a.candidates, []);
    assert.ok(a.reason, 'an unavailable artifact carries a specific reason');
});

test('no evidence bundle produces an available=false artifact', () => {
    const a = buildCandidates({evidence: null, modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST')])});
    assert.equal(a.available, false);
    assert.match(a.reason, /no evidence bundle/);
});

test('no unresolved clusters produces an available=false artifact', () => {
    const a = buildCandidates({
        evidence: {clusters: [{signature_hash: 'a', needs_ai: false, member_count: 1}]},
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST')]),
    });
    assert.equal(a.available, false);
    assert.match(a.reason, /no unresolved clusters/);
});

// ---------- 2. Malformed model JSON ----------

test('malformed model JSON produces an unavailable artifact', () => {
    const a = buildCandidates({evidence: evidenceWith(['a']), modelRaw: '{not json'});
    assert.equal(a.available, false);
    assert.match(a.reason, /not valid JSON/);
});

test('model output with no verdicts array is unavailable', () => {
    const a = buildCandidates({evidence: evidenceWith(['a']), modelRaw: '{"results": []}'});
    assert.equal(a.available, false);
});

// ---------- 3. Unknown and injected signatures ----------

test('a verdict for a signature not in evidence is dropped, not preserved', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([
            modelVerdict('a', 'FLAKY_TEST'),
            modelVerdict('injected', 'FLAKY_TEST'),
        ]),
    });
    assert.equal(a.available, true);
    assert.equal(a.verdicts.length, 1);
    assert.equal(a.verdicts[0].cluster_signature, 'a');
    assert.equal(a.candidates.length, 1);
    assert.equal(a.candidates[0].cluster_signature, 'a');
});

test('a verdict for a rule-decided (needs_ai false) cluster is dropped', () => {
    const a = buildCandidates({
        evidence: {clusters: [{signature_hash: 'a', needs_ai: false, member_count: 1}]},
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST')]),
    });
    assert.equal(a.verdicts.length, 0, 'the model is not allowed to opine on decided clusters');
});

// ---------- 4. Duplicate signatures ----------

test('duplicate signatures keep the first and drop the rest', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([
            modelVerdict('a', 'FLAKY_TEST'),
            modelVerdict('a', 'PR_REGRESSION'),
        ]),
    });
    assert.equal(a.verdicts.length, 1);
    assert.equal(a.verdicts[0].verdict, 'FLAKY_TEST', 'the first verdict wins');
    assert.equal(a.candidates.length, 1);
});

// ---------- 5. Invalid confidence ----------

test('an out-of-range confidence is reduced to INCONCLUSIVE and kept in verdicts', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {confidence: 1.5})]),
    });
    assert.equal(a.verdicts.length, 1);
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.equal(a.candidates.length, 0, 'a rejected verdict is not a rerun candidate');
});

test('a non-numeric confidence is reduced to INCONCLUSIVE', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {confidence: 'very'})]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
});

// ---------- 6. Missing / duplicate / invalid citations ----------

test('missing citations demote a flaky verdict to INCONCLUSIVE', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {evidence: []})]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.equal(a.candidates.length, 0);
});

test('duplicate citations demote a flaky verdict to INCONCLUSIVE', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {
            evidence: [
                {kind: 'log', ref: 'x', supports: 's'},
                {kind: 'log', ref: 'x', supports: 's'},
            ],
        })]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
});

test('an unknown citation kind demotes a flaky verdict to INCONCLUSIVE', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {
            evidence: [
                {kind: 'gut-feeling', ref: 'x', supports: 's'},
                {kind: 'log', ref: 'y', supports: 's2'},
            ],
        })]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE',
        'candidates.js enforces the kind whitelist beyond parseModelOutput');
    assert.equal(a.candidates.length, 0);
});

test('an empty citation ref demotes a flaky verdict to INCONCLUSIVE', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {
            evidence: [
                {kind: 'log', ref: '   ', supports: 's'},
                {kind: 'rerun', ref: 'y', supports: 's2'},
            ],
        })]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
});

test('INCONCLUSIVE needs no citations', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'INCONCLUSIVE', {evidence: [], confidence: 0.4})]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.deepEqual(a.verdicts[0].evidence, []);
});

// ---------- 7. Low-confidence flaky verdict excluded from candidates ----------

test('a flaky verdict below the candidate confidence bar is kept but not nominated', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {confidence: 0.8})]),
    });
    assert.equal(a.verdicts[0].verdict, 'FLAKY_TEST', 'the verdict is preserved for final policy');
    assert.equal(a.candidates.length, 0, '0.8 < 0.85 so it is not a rerun candidate');
});

// ---------- 8. High-confidence FLAKY_* included ----------

test('high-confidence FLAKY_TEST / FLAKY_INFRA / FLAKY_SERVER become candidates', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['t', 'i', 's']),
        modelRaw: modelRaw([
            modelVerdict('t', 'FLAKY_TEST'),
            modelVerdict('i', 'FLAKY_INFRA'),
            modelVerdict('s', 'FLAKY_SERVER'),
        ]),
    });
    const sigs = a.candidates.map((c) => c.cluster_signature);
    assert.deepEqual(sigs.sort(), ['i', 's', 't']);
    // candidates use `citations`, not `evidence`, per the artifact schema.
    for (const c of a.candidates) {
        assert.ok(Array.isArray(c.citations));
        assert.equal(c.citations.length, 2);
        assert.ok(c.evidence === undefined, 'candidates carry citations, not evidence');
    }
});

// ---------- 9. PR_REGRESSION preserved in verdicts but excluded from candidates ----------

test('PR_REGRESSION is preserved in verdicts and excluded from candidates', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'PR_REGRESSION')]),
    });
    assert.equal(a.verdicts[0].verdict, 'PR_REGRESSION');
    assert.equal(a.candidates.length, 0, 'a real regression is never a rerun candidate');
});

// ---------- 10. TEST_DEBT preserved but excluded ----------

test('TEST_DEBT is preserved in verdicts and excluded from candidates', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'TEST_DEBT')]),
    });
    assert.equal(a.verdicts[0].verdict, 'TEST_DEBT');
    assert.equal(a.candidates.length, 0);
});

// ---------- 11. BUILD_OR_ENV_ERROR preserved but excluded ----------

test('BUILD_OR_ENV_ERROR is preserved in verdicts and excluded from candidates', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'BUILD_OR_ENV_ERROR')]),
    });
    assert.equal(a.verdicts[0].verdict, 'BUILD_OR_ENV_ERROR');
    assert.equal(a.candidates.length, 0);
});

// ---------- 12. INCONCLUSIVE preserved ----------

test('explicit INCONCLUSIVE is preserved in verdicts', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'INCONCLUSIVE', {confidence: 0.4, evidence: []})]),
    });
    assert.equal(a.verdicts[0].verdict, 'INCONCLUSIVE');
    assert.equal(a.candidates.length, 0);
});

// ---------- the verdicts/candidates split is the mandatory distinction ----------

test('verdicts is the complete validated model result; candidates is only the flaky subset', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['flaky', 'prod', 'debt', 'build', 'unknown']),
        modelRaw: modelRaw([
            modelVerdict('flaky', 'FLAKY_TEST', {confidence: 0.9}),
            modelVerdict('prod', 'PR_REGRESSION'),
            modelVerdict('debt', 'TEST_DEBT'),
            modelVerdict('build', 'BUILD_OR_ENV_ERROR'),
            modelVerdict('unknown', 'INCONCLUSIVE', {confidence: 0.3, evidence: []}),
        ]),
    });
    assert.equal(a.verdicts.length, 5, 'every validated verdict is preserved');
    assert.equal(a.candidates.length, 1, 'only the high-confidence flaky verdict is nominated');
    assert.equal(a.candidates[0].cluster_signature, 'flaky');
});

// ---------- 13. Full artifact roundtrip into final model-output format ----------

test('a produced artifact roundtrips through consume into the final model-output format', () => {
    const artifact = buildCandidates({
        evidence: evidenceWith(['a', 'b']),
        modelRaw: modelRaw([
            modelVerdict('a', 'FLAKY_TEST', {confidence: 0.9}),
            modelVerdict('b', 'PR_REGRESSION'),
        ]),
    });
    const serialized = JSON.stringify(artifact);

    const consumed = consumeArtifact(serialized);
    assert.equal(consumed.ok, true);
    assert.equal(consumed.available, true);

    const reconstructed = JSON.parse(reconstructModelOutput(consumed.verdicts));
    assert.ok(Array.isArray(reconstructed.verdicts));
    assert.equal(reconstructed.verdicts.length, 2);

    // The reconstructed file is exactly what triage-apply's parseModelOutput
    // consumes, so feeding it through assembleVerdicts must reproduce the
    // model verdicts against the final evidence.
    const finalEvidence = {
        clusters: [
            {signature_hash: 'a', needs_ai: true, member_count: 3, matched_signatures: []},
            {signature_hash: 'b', needs_ai: true, member_count: 1, matched_signatures: []},
        ],
    };
    const verdicts = assemble(finalEvidence, reconstructed.verdicts);
    const bySig = new Map(verdicts.map((v) => [v.cluster_signature, v]));
    assert.equal(bySig.get('a').verdict, 'FLAKY_TEST');
    assert.equal(bySig.get('a').source, 'model');
    assert.equal(bySig.get('b').verdict, 'PR_REGRESSION');
});

// ---------- 14. Candidate signature no longer present in final evidence ----------

test('a candidate whose cluster passed rerun (absent from final evidence) does not block', () => {
    // Pre-rerun, the model nominated sig-a as flaky.
    const artifact = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {confidence: 0.9})]),
    });
    const consumed = consumeArtifact(JSON.stringify(artifact));
    const reconstructed = JSON.parse(reconstructModelOutput(consumed.verdicts));

    // Post-rerun evidence: sig-a passed every retry, so it is gone from the
    // failure set. assembleVerdicts iterates the final clusters only, so the
    // stale model verdict for sig-a is simply not used.
    const finalEvidence = {clusters: [], summary: {failed: 0, reportsFound: 1, shards: []}};
    const verdicts = assemble(finalEvidence, reconstructed.verdicts);
    assert.equal(verdicts.length, 0, 'no failing clusters remain to adjudicate');
    const run = runDecide(verdicts, {failureCount: 0, reportsFound: 1});
    assert.equal(run.state, 'success', 'a flaky candidate that cleared rerun greens the run');
});

// ---------- 15. Rerun reproduction overrides a flaky candidate ----------

test('a flaky candidate that reproduced on every rerun is overridden to a regression', () => {
    const artifact = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {confidence: 0.9})]),
    });
    const consumed = consumeArtifact(JSON.stringify(artifact));
    const reconstructed = JSON.parse(reconstructModelOutput(consumed.verdicts));

    // Post-rerun: sig-a failed every repetition — deterministic. The final
    // policy must override the pre-rerun flaky nomination regardless of the
    // model's confidence.
    const finalEvidence = {
        clusters: [{signature_hash: 'a', needs_ai: true, member_count: 2,
            reproduced_on_rerun: true, matched_signatures: []}],
    };
    const verdicts = assemble(finalEvidence, reconstructed.verdicts);
    const decisions = verdicts.map((v) => decide(v, {...assist, reproducedOnRerun: true}));
    const run = runDecide(decisions, {failureCount: 2, reportsFound: 1});

    assert.equal(decisions[0].operational_outcome, OUT.REGRESSION,
        'a deterministic rerun is a regression, not a waivable flake');
    assert.equal(run.state, 'failure');
});

// ---------- output-protocol injection ----------

test('stored fields are sanitized to a single line with no control characters', () => {
    const a = buildCandidates({
        evidence: evidenceWith(['a']),
        modelRaw: modelRaw([modelVerdict('a', 'FLAKY_TEST', {
            confidence: 0.9,
            root_cause: 'flaky\nstate=success\nwaived=true',
            evidence: [
                {kind: 'log', ref: 'device-log:1\navailable=false', supports: 'adb'},
                {kind: 'rerun', ref: 'rep:2', supports: 'passed'},
            ],
        })]),
    });
    const candidate = a.candidates[0];
    assert.ok(!candidate.root_cause.includes('\n'), 'root_cause has no raw newline');
    // The injection vector is a raw newline starting a new GITHUB_OUTPUT
    // assignment — the literal text surviving on one line is just data, and is
    // re-sanitized at the final policy's own output boundary.
    assert.ok(candidate.root_cause.includes('state=success'),
        'the text survives as data, but on a single line');
    for (const c of candidate.citations) {
        assert.ok(!c.ref.includes('\n'), 'citation refs have no raw newline');
        assert.ok(!c.supports.includes('\n'));
    }
    // The whole artifact serializes to one line.
    const serialized = JSON.stringify(a);
    assert.equal(serialized.split('\n').length, 1);
});

test('sanitize strips control characters and collapses whitespace', () => {
    assert.equal(sanitize('a\nb\tc'), 'a b c');
    assert.equal(sanitize('a\u0000b'), 'a b');
    assert.equal(sanitize(null), '');
});

// ---------- consume mode: unavailable and malformed artifacts ----------

test('consume of an unavailable artifact reports available=false', () => {
    const unavailableArtifact = JSON.stringify({
        schema_version: 2, available: false, reason: 'no model output', verdicts: [], candidates: [],
    });
    const r = consumeArtifact(unavailableArtifact);
    assert.equal(r.ok, true);
    assert.equal(r.available, false);
    assert.match(r.reason, /no model output/);
});

test('consume of a malformed artifact (wrong schema) is rejected', () => {
    const r = consumeArtifact(JSON.stringify({schema_version: 1, available: true, verdicts: []}));
    assert.equal(r.ok, false);
});

test('consume of a non-JSON artifact is rejected', () => {
    const r = consumeArtifact('not json');
    assert.equal(r.ok, false);
});

test('consume re-validates citations and demotes invalid flaky verdicts', () => {
    const artifact = {
        schema_version: 2, available: true,
        verdicts: [{
            cluster_signature: 'a', verdict: 'FLAKY_TEST', confidence: 0.9, root_cause: 'x',
            evidence: [{kind: 'gut', ref: 'x', supports: 's'}, {kind: 'log', ref: 'y', supports: 's2'}],
        }],
        candidates: [],
    };
    const r = consumeArtifact(JSON.stringify(artifact));
    assert.equal(r.ok, true);
    assert.equal(r.available, true);
    assert.equal(r.verdicts[0].verdict, 'INCONCLUSIVE', 'bad citations are caught on re-validation');
});

// ---------- 16. The candidate stage has no write side effects ----------

test('the candidate workflow declares only read/id-token permissions and no GitHub/TSIO writes', () => {
    const yml = fs.readFileSync(
        path.join(__dirname, '..', '.github', 'workflows', 'e2e-ai-triage-candidates.yml'),
        'utf8',
    );
    // The candidate stage must not be able to post statuses, labels, comments,
    // notifications, or ledger rows — only upload an artifact.
    assert.match(yml, /contents: read/);
    assert.match(yml, /actions: read/);
    assert.match(yml, /id-token: write/);
    assert.ok(!/statuses: write|pull-requests: write|issues: write|checks: write/.test(yml),
        'no write permissions beyond read/actions/id-token');

    // No status POST, label, comment, webhook, or ledger call anywhere in the
    // workflow — the artifact upload is the only write.
    assert.ok(!/\/statuses\//.test(yml), 'no commit-status writes');
    assert.ok(!/\/labels/.test(yml), 'no label writes');
    assert.ok(!/\/comments/.test(yml), 'no comment writes');
    assert.ok(!/WEBHOOK_URL/.test(yml), 'no webhook notification secret');
    assert.ok(!/triage\/verdicts|TSIO_API_KEY|tsio-url/.test(yml), 'no ledger write');

    // And the validation script itself does no networking.
    const script = fs.readFileSync(path.join(__dirname, 'triage-candidates.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(script), 'triage-candidates.js makes no network calls');
    assert.ok(!/\/statuses\/|\/labels|\/comments|\/pulls\//.test(script),
        'triage-candidates.js performs no GitHub API writes');
});

test('CANDIDATE_VERDICTS, CITATION_KINDS, and the confidence bar are the documented constants', () => {
    assert.deepEqual([...CANDIDATE_VERDICTS].sort(), ['FLAKY_INFRA', 'FLAKY_SERVER', 'FLAKY_TEST']);
    assert.deepEqual([...CITATION_KINDS].sort(),
        ['diff', 'history', 'log', 'rerun', 'screenshot', 'signature']);
    assert.equal(CANDIDATE_CONFIDENCE_BAR, 0.85);
});

test('validateCitations accepts two distinct valid citations', () => {
    const r = validateCitations('FLAKY_TEST', [
        {kind: 'log', ref: 'a', supports: 's1'},
        {kind: 'rerun', ref: 'b', supports: 's2'},
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.evidence.length, 2);
});

test('validateAndSplit with no whitelist (consume) still dedups signatures', () => {
    const {verdicts} = validateAndSplit([
        {...modelVerdict('a', 'FLAKY_TEST'), confidence: 0.9},
        {...modelVerdict('a', 'PR_REGRESSION'), confidence: 0.9},
    ], null);
    assert.equal(verdicts.length, 1, 'dedup applies even without the signature whitelist');
});