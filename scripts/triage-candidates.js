#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Analysis-only AI candidate stage for E2E triage.
 *
 * This runs *before* mobile targeted reruns. The model nominates which failing
 * clusters are likely flaky, so the rerun stage only re-runs those candidates
 * instead of the whole failure set. The final deterministic policy
 * (`triage-apply.js` + `triage-policy.js`) remains authoritative: a candidate is
 * a hint about what to re-run, never a waiver.
 *
 * Two modes:
 *
 *   produce (default) — read the evidence bundle and the model's raw output,
 *     validate every verdict, and write a compact `candidates.json` artifact.
 *     `available=true` only when the model ran and validation succeeded.
 *
 *   consume — read a `candidates.json` artifact, re-validate it, and reconstruct
 *     the standard model-output file (`{"verdicts": [...]}`) that the final
 *     workflow feeds into `triage-apply.js`. The final post-rerun evidence may
 *     have dropped or changed clusters, so consume does NOT re-check signature
 *     presence against evidence — it only re-validates structure.
 *
 * This script never posts a status, label, comment, notification, or ledger row.
 * Its only side effect is writing the candidate/model-output file the caller
 * asked for. No network, no GitHub API, no TSIO.
 */

const fs = require('fs');

const {parseModelOutput} = require('./triage-policy');

const SCHEMA_VERSION = 2;

// Only these verdicts can become rerun candidates. Product/test/build verdicts
// are preserved in `verdicts` (the final policy needs them) but never nominated
// for a flaky rerun — re-running a genuine regression just wastes a runner.
const CANDIDATE_VERDICTS = new Set(['FLAKY_TEST', 'FLAKY_INFRA', 'FLAKY_SERVER']);

// A candidate must clear the same green bar the final policy uses for a waiver:
// below 0.85 a flaky verdict is not strong enough to spend a rerun on.
const CANDIDATE_CONFIDENCE_BAR = 0.85;

// Citation kinds the model may claim. Anything else is a malformed reference,
// not a novel evidence category.
const CITATION_KINDS = new Set(['history', 'rerun', 'log', 'screenshot', 'signature', 'diff']);

function arg(name, dflt = '') {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? dflt : hit.slice(name.length + 3);
}

function readJson(file, dflt = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return dflt;
    }
}

/**
 * Flatten a stored field to one line with no control characters.
 *
 * Every field that lands in the artifact is untrusted model output, and the
 * artifact is later read back and fed into GITHUB_OUTPUT / the final policy. A
 * newline in a root_cause or ref would start a new `key=value` assignment there,
 * so control characters are stripped here at the boundary that produces the
 * artifact — not assumed away downstream.
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const sanitize = (v) => String(v ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The set of signatures the model is allowed to opine on: clusters the caller's
 * rules left undecided (`needs_ai: true`). A verdict for any other signature is
 * an invention and is dropped wholesale — preserving it as INCONCLUSIVE would
 * record a row for a cluster that does not exist.
 */
function allowedSignatures(evidence) {
    const set = new Set();
    for (const c of (evidence && evidence.clusters) || []) {
        if (c && c.needs_ai && c.signature_hash) {
            set.add(c.signature_hash);
        }
    }
    return set;
}

/**
 * Validate and compact a verdict's citations.
 *
 * INCONCLUSIVE needs no citations. Every other verdict needs at least two
 * distinct citations, each with a known kind and a non-empty ref — the same
 * corroboration bar the final policy enforces, applied here so a malformed
 * candidate cannot reach the rerun stage. Returns `{ok, evidence}` with the
 * compacted citations; on failure `evidence` is `[]` and the caller demotes the
 * verdict to INCONCLUSIVE.
 */
function validateCitations(verdict, evidence) {
    if (verdict === 'INCONCLUSIVE') {
        return {ok: true, evidence: []};
    }
    if (!Array.isArray(evidence) || evidence.length < 2) {
        return {ok: false, evidence: []};
    }
    const cites = [];
    const seen = new Set();
    for (const c of evidence) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
            return {ok: false, evidence: []};
        }
        const kind = typeof c.kind === 'string' ? c.kind : '';
        if (!CITATION_KINDS.has(kind)) {
            return {ok: false, evidence: []};
        }
        const ref = sanitize(c.ref);
        if (!ref) {
            return {ok: false, evidence: []};
        }
        const compact = {kind, ref, supports: sanitize(c.supports)};
        // Distinct on the compacted form: two identical references are one
        // observation written twice, and corroboration is the whole point.
        const key = `${kind}\0${ref}\0${compact.supports}`;
        if (seen.has(key)) {
            return {ok: false, evidence: []};
        }
        seen.add(key);
        cites.push(compact);
    }
    return {ok: true, evidence: cites};
}

function unavailable(reason) {
    return {
        schema_version: SCHEMA_VERSION,
        available: false,
        reason: sanitize(reason),
        verdicts: [],
        candidates: [],
    };
}

/**
 * Turn the parsed model verdicts into the validated `verdicts` and `candidates`
 * arrays.
 *
 * `allowed` is the set of needs_ai signatures in produce mode; pass `null` in
 * consume mode to skip the whitelist (the final evidence may have moved on).
 *
 * Rejected verdicts:
 *   - signature not in the whitelist, or a duplicate → dropped entirely. An
 *     invented or repeated signature must not reach the ledger or the rerun.
 *   - known signature but invalid citations (non-INCONCLUSIVE) → demoted to
 *     INCONCLUSIVE and kept in `verdicts`. The cluster is real, so the final
 *     policy still sees it and resolves it red rather than silently losing it.
 *
 * `verdicts` keeps every validated model verdict — including PR_REGRESSION,
 * TEST_DEBT, BUILD_OR_ENV_ERROR, and INCONCLUSIVE — because the final policy
 * needs the complete picture, not just the flaky subset. `candidates` is only
 * FLAKY_* at or above the confidence bar, with `evidence` renamed to `citations`
 * to match the artifact schema.
 */
function validateAndSplit(modelVerdicts, allowed) {
    const seen = new Set();
    const verdicts = [];
    for (const v of modelVerdicts) {
        const sig = sanitize(v && v.cluster_signature);
        if (!sig) {
            continue;
        }
        if (allowed && !allowed.has(sig)) {
            continue;
        }
        if (seen.has(sig)) {
            continue;
        }
        seen.add(sig);

        const verdict = v.verdict;
        const cite = validateCitations(verdict, v.evidence);
        let finalVerdict = verdict;
        let evidence = cite.evidence;
        if (!cite.ok && verdict !== 'INCONCLUSIVE') {
            finalVerdict = 'INCONCLUSIVE';
            evidence = [];
        }
        verdicts.push({
            cluster_signature: sig,
            verdict: finalVerdict,
            confidence: typeof v.confidence === 'number' ? v.confidence : 0,
            root_cause: sanitize(v.root_cause),
            evidence,
        });
    }

    const candidates = verdicts
        .filter((v) => CANDIDATE_VERDICTS.has(v.verdict) &&
            typeof v.confidence === 'number' && v.confidence >= CANDIDATE_CONFIDENCE_BAR)
        .map((v) => ({
            cluster_signature: v.cluster_signature,
            verdict: v.verdict,
            confidence: v.confidence,
            root_cause: v.root_cause,
            citations: v.evidence,
        }));

    return {verdicts, candidates};
}

/**
 * Produce mode: build the candidate artifact from evidence + raw model output.
 */
function buildCandidates({evidence, modelRaw}) {
    if (!evidence) {
        return unavailable('no evidence bundle — candidate adjudication skipped');
    }
    const allowed = allowedSignatures(evidence);
    if (allowed.size === 0) {
        return unavailable('no unresolved clusters require AI adjudication');
    }
    if (!modelRaw || !String(modelRaw).trim()) {
        return unavailable('AI adjudication was skipped — no model output');
    }
    const parsed = parseModelOutput(modelRaw);
    if (!parsed.ok) {
        return unavailable(`model output rejected: ${parsed.error}`);
    }
    const {verdicts, candidates} = validateAndSplit(parsed.verdicts, allowed);
    return {
        schema_version: SCHEMA_VERSION,
        available: true,
        verdicts,
        candidates,
    };
}

/**
 * Consume mode: re-validate a candidate artifact and report availability.
 *
 * Returns `{ok, available, verdicts, reason}`. `ok` is false when the artifact
 * is malformed (not JSON, wrong schema, no verdicts array) — the caller should
 * fail closed. `ok` true with `available` false means the artifact is a valid
 * "unavailable" marker; the caller falls back to no model verdicts (the final
 * policy resolves unresolved clusters red).
 */
function consumeArtifact(raw) {
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch {
        return {ok: false, available: false, verdicts: [], reason: 'candidate artifact is not valid JSON'};
    }
    if (!doc || doc.schema_version !== SCHEMA_VERSION) {
        return {ok: false, available: false, verdicts: [], reason: 'candidate artifact has an unsupported schema_version'};
    }
    if (doc.available !== true) {
        return {ok: true, available: false, verdicts: [],
            reason: sanitize(doc.reason || 'candidate artifact is unavailable')};
    }
    if (!Array.isArray(doc.verdicts)) {
        return {ok: false, available: false, verdicts: [], reason: 'candidate artifact has no verdicts array'};
    }
    // Re-validate structure without the signature whitelist: the final post-rerun
    // evidence may have dropped clusters that passed rerun, so a signature absent
    // from evidence is expected, not an injection.
    const {verdicts} = validateAndSplit(doc.verdicts, null);
    return {ok: true, available: true, verdicts, reason: null};
}

/**
 * Reconstruct the standard model-output file from a consumed artifact.
 *
 * `triage-apply.js` reads `{"verdicts": [...]}` through `parseModelOutput`; the
 * artifact's `verdicts` are already in that shape, so reconstruction is a direct
 * projection — no Claude, no second adjudication.
 */
function reconstructModelOutput(verdicts) {
    return JSON.stringify({verdicts});
}

function writeStepOutput(key, value) {
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT,
            `${key}=${sanitize(value).replace(/\r/g, ' ')}\n`);
    }
}

async function main() {
    const mode = arg('mode', 'produce');
    const outFile = arg('out', '');

    if (mode === 'consume') {
        const candidatesFile = arg('candidates');
        if (!candidatesFile || !fs.existsSync(candidatesFile)) {
            writeStepOutput('available', 'false');
            console.error('no candidate artifact supplied — failing closed');
            process.exit(1);
        }
        const result = consumeArtifact(fs.readFileSync(candidatesFile, 'utf8'));
        if (!result.ok) {
            writeStepOutput('available', 'false');
            console.error(`candidate artifact rejected: ${result.reason}`);
            process.exit(1);
        }
        if (!result.available) {
            // A valid unavailable marker: no model verdicts. Do not write the
            // reconstructed file — the final policy then sees no model output and
            // resolves unresolved clusters red, which is fail-closed.
            writeStepOutput('available', 'false');
            console.log(`candidate artifact unavailable: ${result.reason}`);
            if (outFile && fs.existsSync(outFile)) {
                fs.rmSync(outFile);
            }
            return;
        }
        if (outFile) {
            fs.writeFileSync(outFile, reconstructModelOutput(result.verdicts));
        }
        writeStepOutput('available', 'true');
        console.log(`reconstructed ${result.verdicts.length} verdict(s) from candidate artifact`);
        return;
    }

    // produce
    const evidence = readJson(arg('evidence', 'triage-out/evidence.json'));
    const modelFile = arg('model-output', '');
    const modelRaw = modelFile && fs.existsSync(modelFile) ?
        fs.readFileSync(modelFile, 'utf8') : '';
    const artifact = buildCandidates({evidence, modelRaw});
    if (outFile) {
        fs.writeFileSync(outFile, JSON.stringify(artifact));
    }
    writeStepOutput('available', artifact.available ? 'true' : 'false');
    console.log(`candidates ${artifact.available ? 'available' : 'unavailable'}: ` +
        `${artifact.verdicts.length} verdict(s), ${artifact.candidates.length} candidate(s)`);
    if (!artifact.available) {
        console.log(`reason: ${artifact.reason}`);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`triage-candidates failed: ${err.stack || err.message}`);
        process.exit(1);
    });
}

module.exports = {
    SCHEMA_VERSION,
    CANDIDATE_VERDICTS,
    CITATION_KINDS,
    CANDIDATE_CONFIDENCE_BAR,
    sanitize,
    allowedSignatures,
    validateCitations,
    validateAndSplit,
    buildCandidates,
    consumeArtifact,
    reconstructModelOutput,
};