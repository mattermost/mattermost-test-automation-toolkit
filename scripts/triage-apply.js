#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Apply triage verdicts: decide, record, post.
 *
 * Reads the deterministic evidence bundle plus (optionally) the model's verdict
 * file, runs them through the policy engine, and then does the things that have
 * side effects. The order is load-bearing:
 *
 *   1. record every verdict in the TSIO ledger — a successful flaky outcome must
 *      be recorded before the check is allowed to go green, and a ledger failure
 *      turns the whole run into TRIAGE_FAILED
 *   2. apply the E2E/AI-Waived label (PR only), verifying the PR head before and
 *      after — a waiver that lands on a pushed-to PR would green untriaged commits
 *   3. post the `status_context` commit status, reflecting the final outcome
 *   4. post the PR comment
 *
 * Every failure path here ends in a red status. If this script cannot do its job,
 * the run must look exactly as it did before triage existed.
 */

const fs = require('fs');

const {decideCluster, decideRun, parseModelOutput, statusDescription, OUTCOMES} = require('./triage-policy');
const {attribute, blameCandidates, formatCallout} = require('./triage-blame');

const AI_WAIVED_LABEL = 'E2E/AI-Waived';
const DEFAULT_STATUS_CONTEXT = 'e2e-test/ai-triage';
const COMMENT_MARKER = '<!-- e2e-ai-triage -->';

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

async function gh(token, method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
    });
    if (!res.ok) {
        throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
}

/**
 * Turn the evidence bundle into the per-cluster verdict list.
 *
 * Rule-decided clusters never reach the model, so their verdicts come straight
 * from the catalogue; the model's file only covers what the rules left open. A
 * cluster present in neither is INCONCLUSIVE — which is the honest answer, and
 * red.
 */
function assembleVerdicts(evidence, modelVerdicts) {
    const bySignature = new Map(modelVerdicts.map((v) => [v.cluster_signature, v]));

    // A decided suite verdict covers the whole run: when every shard died, the
    // individual clusters are symptoms of it and must not be adjudicated apart
    // from it.
    if (evidence.suite_verdict) {
        return [{
            // Synthetic, but not arbitrary: TSIO requires one of
            // external_test_id or cluster_signature, so a null/null suite row was
            // rejected with a 400 and swallowed as a log line — meaning the one
            // verdict class that can waive a whole run was never recorded, and
            // the false-green metric could not see it. Keyed on the rule id so
            // re-triaging the same run updates its row instead of appending.
            cluster_signature: `suite:${evidence.suite_verdict.rule_id || 'unknown'}`,
            member_count: evidence.summary ? evidence.summary.failed : 0,
            verdict: evidence.suite_verdict.verdict,
            confidence: evidence.suite_verdict.confidence,
            root_cause: evidence.suite_verdict.reason,
            evidence: [
                {kind: 'suite-rule', ref: evidence.suite_verdict.rule_id},
                {kind: 'suite-shape', ref: JSON.stringify(evidence.summary && evidence.summary.shards)},
            ],
            source: 'rules',
        }];
    }

    return (evidence.clusters || []).map((c) => {
        if (!c.needs_ai && c.rule_verdict) {
            return {
                cluster_signature: c.signature_hash,
                member_count: c.member_count,
                verdict: c.rule_verdict,
                confidence: c.confidence,
                root_cause: c.reason,
                evidence: (c.matched_signatures || []).map((m) => ({kind: 'signature', ref: m.id})),
                source: 'rules',
            };
        }
        const fromModel = bySignature.get(c.signature_hash);
        if (fromModel) {
            return {...fromModel, member_count: c.member_count, source: 'model'};
        }
        return {
            cluster_signature: c.signature_hash,
            member_count: c.member_count,
            verdict: 'INCONCLUSIVE',
            confidence: 0,
            root_cause: 'no verdict was produced for this cluster',
            evidence: [],
            source: 'missing',
        };
    });
}

/**
 * Resolve who broke the baseline, when triage concluded MAIN_REGRESSION.
 *
 * The PR under test is innocent, but somebody's change did break main and
 * nobody is being told. TSIO already knows the last commit where the test passed
 * and the first where it failed, so the suspect range is whatever landed
 * between — no bisect, no builds, usually a single commit.
 *
 * Entirely best-effort: a failed compare call costs a callout, not a verdict.
 */
async function resolveBlame({token, repo, evidence, decisions}) {
    const candidates = blameCandidates(evidence, decisions);
    if (candidates.length === 0) {
        return null;
    }

    // One callout per distinct range: several tests broken by one commit is the
    // normal shape, and repeating the same accusation per test is just noise.
    const byRange = new Map();
    for (const c of candidates) {
        const key = `${c.range.lastPass}...${c.range.failingSince}`;
        if (!byRange.has(key)) {
            byRange.set(key, {range: c.range, testIds: []});
        }
        byRange.get(key).testIds.push(c.testId);
    }

    const callouts = [];
    for (const {range, testIds} of byRange.values()) {
        try {
            const compare = await gh(token, 'GET',
                `/repos/${repo}/compare/${range.lastPass}...${range.failingSince}`);
            const attribution = attribute(compare.commits || []);
            callouts.push({
                range,
                testIds,
                attribution,
                text: formatCallout({repo, testIds, range, attribution}),
            });
        } catch (err) {
            console.error(`blame compare failed for ${range.lastPass}...${range.failingSince}: ${err.message}`);
        }
    }
    return callouts.length > 0 ? callouts : null;
}

function renderComment(runDecision, decisions, verdicts, opts) {
    const lines = [COMMENT_MARKER];
    const icon = runDecision.state === 'success' ? ':white_check_mark:' : ':red_circle:';
    lines.push(
        `${icon} **E2E failure triage — [${opts.commitSha.slice(0, 7)}](${opts.commitUrl})**`,
        '',
        runDecision.reason,
        '',
    );
    // Only a waiver gets the waiver sentence. A run that passed is green because
    // nothing failed, and telling the author their failures were excused when
    // they had none is both confusing and quietly erodes trust in the waivers
    // that are real.
    if (runDecision.waived) {
        lines.push(
            `These failures were classified as not caused by this change, so the E2E checks were waived with \`${AI_WAIVED_LABEL}\`.`,
            '',
        );
    }
    lines.push('| Cluster | Verdict | Outcome | Conf | Source | Tests | Why |', '|---|---|---|---:|---|---:|---|');
    verdicts.forEach((v, i) => {
        const d = decisions[i];
        lines.push([
            '',
            v.cluster_signature ? `\`${v.cluster_signature}\`` : '_suite_',
            d.verdict,
            d.operational_outcome || '—',
            d.confidence,
            v.source,
            v.member_count,
            // Newlines collapse before the pipe escaping: a reason carrying one
            // ends the table row early, so every later cell shifts into the
            // wrong column and the rest of the table renders as body text.
            String(d.reason || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|').
                slice(0, 160),
            '',
        ].join(' | ').trim());
    });
    for (const callout of opts.blame || []) {
        lines.push('', '---', '', callout.text);
    }
    lines.push(
        '',
        `**Outcome:** \`${runDecision.operational_outcome || 'PASS'}\``,
        '',
        '*Wrong? Comment `/e2e-triage-override <verdict> <reason>`. Corrections are recorded and are the only ground truth this system gets.*',
    );
    return lines.join('\n');
}

/**
 * Mint a GitHub Actions OIDC token for TSIO.
 *
 * TSIO's authenticated routes accept either an `X-API-Key` or an OIDC bearer it
 * verifies against the GitHub Actions issuer — a static secret presented as a
 * bearer is rejected. This mirrors what detox/utils/tsio-report-status.js already
 * does for report uploads, so the ledger write authenticates the same way the
 * rest of the pipeline does and needs no additional shared secret.
 *
 * Requires `permissions: id-token: write` on the job. Without it the request env
 * vars are absent and the mint fails — which is now a ledger failure and turns
 * the run TRIAGE_FAILED, so a missing permission is loud rather than silent.
 */
async function mintOidcToken(audience) {
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
        return null;
    }
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}audience=${encodeURIComponent(audience)}`, {
        headers: {Authorization: `bearer ${bearer}`, Accept: 'application/json; api-version=2.0'},
    });
    if (!res.ok) {
        throw new Error(`OIDC mint failed: ${res.status}`);
    }
    const body = await res.json();
    return body.value || null;
}

async function recordLedger({tsioUrl, token, apiKey, batch}) {
    const headers = {'Content-Type': 'application/json'};
    if (apiKey) {
        headers['X-API-Key'] = apiKey;
    } else {
        headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${tsioUrl}/api/v1/triage/verdicts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
    });
    if (!res.ok) {
        throw new Error(`ledger write failed: ${res.status} ${await res.text()}`);
    }

    // A TSIO deployment without the triage routes serves its single-page app on
    // every unmatched path, so the miss arrives as 200 text/html rather than a
    // 404. res.ok is true, res.json() then dies on the doctype, and the run is
    // reported as `Unexpected token '<'` — which reads as a triage bug rather
    // than a missing endpoint. Checking the content type turns the most likely
    // deployment mistake into a message that names itself.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
        throw new Error(
            `ledger endpoint returned ${res.status} ${contentType || 'no content-type'} — ` +
            `POST ${tsioUrl}/api/v1/triage/verdicts is not served by this TSIO deployment`);
    }
    return res.json();
}

/**
 * Turn a green run into a triage failure. Used when the ledger or the PR-head
 * verification refuses to underwrite a waiver: the verdicts may say flaky, but
 * the run cannot be allowed to go green, so the outcome becomes TRIAGE_FAILED.
 *
 * The reason carries only the cause. statusDescription() prefixes the
 * TRIAGE_FAILED headline itself, and spelling it out here too produced
 * "triage could not complete safely: triage could not complete safely: …",
 * which spent 35 of the 140 available characters restating the headline and
 * truncated the actual error mid-word.
 */
function markTriageFailed(runDecision, reason) {
    return {
        ...runDecision,
        state: 'failure',
        operational_outcome: OUTCOMES.TRIAGE_FAILED,
        waived: false,
        reason,
    };
}

/**
 * Per-platform triage outcomes.
 *
 * The global run outcome is one verdict for one merge button; the per-platform
 * view answers "is iOS green, is Android green" — which is what a mobile team
 * actually needs, because a flaky simulator does not block Android and a real
 * code regression on one platform should not be waived for both. Each cluster's
 * decision is attributed to the platforms its failures ran on, and a platform
 * is green only when every failure on it was a confirmed flake.
 */

// An iPad runs the iOS app on an iPad device/simulator; the platform that has to
// be green is iOS, so the label is normalised before any aggregation.
function normalizePlatform(p) {
    return p === 'ipad' ? 'ios' : p;
}

// A REGRESSION's stored verdict says *what kind* of regression it is, and that
// refines the platform classification. A deterministic flake (FLAKY_TEST that
// reproduced on every rerun) and TEST_DEBT are both "the test is wrong, not the
// app" → TEST_BUG; a deterministic infra/server flake is still infra →
// INFRASTRUCTURE_FAILURE; everything else (PR_REGRESSION, BUILD_OR_ENV_ERROR,
// MAIN_REGRESSION on a baseline, an amnesty-exhausted PR_REGRESSION) is a
// PRODUCT_BUG. FLAKY_CONFIRMED and TRIAGE_FAILED map directly off the outcome.
const TEST_BUG_VERDICTS = new Set(['TEST_DEBT', 'FLAKY_TEST']);
const INFRA_VERDICTS = new Set(['FLAKY_INFRA', 'FLAKY_SERVER']);

// Mixed-platform severity: when one platform carries both a product bug and a
// flake, the platform reports the worst of its verdicts — a confirmed flake
// next to a real bug is still a red platform. Ordered highest → lowest.
const PLATFORM_SEVERITY = {
    PRODUCT_BUG: 4,
    TEST_BUG: 3,
    INFRASTRUCTURE_FAILURE: 2,
    TRIAGE_FAILED: 1,
    FLAKY: 0,
};

const PLATFORM_SUFFIXES = {
    FLAKY: 'verified to be flaky',
    TEST_BUG: 'verified to be a test bug',
    PRODUCT_BUG: 'verified to be a product bug',
    INFRASTRUCTURE_FAILURE: 'verified to be an infrastructure failure',
    TRIAGE_FAILED: 'triage could not classify safely',
};

function decisionClassification(decision) {
    if (decision.operational_outcome === OUTCOMES.FLAKY_CONFIRMED) {
        return 'FLAKY';
    }
    if (decision.operational_outcome === OUTCOMES.TRIAGE_FAILED) {
        return 'TRIAGE_FAILED';
    }
    // REGRESSION: the stored verdict refines the platform classification.
    const v = decision.verdict;
    if (TEST_BUG_VERDICTS.has(v)) {
        return 'TEST_BUG';
    }
    if (INFRA_VERDICTS.has(v)) {
        return 'INFRASTRUCTURE_FAILURE';
    }
    return 'PRODUCT_BUG';
}

function platformOutcomeFor(decisions) {
    const classes = decisions.map(decisionClassification);
    // A platform is green only when every failure on it was a confirmed flake;
    // one genuine bug or untriaged cluster among nine flakes is still red.
    if (classes.every((c) => c === 'FLAKY')) {
        return {classification: 'FLAKY', state: 'success',
            suffix: PLATFORM_SUFFIXES.FLAKY};
    }
    const worst = classes.reduce((a, b) =>
        PLATFORM_SEVERITY[b] > PLATFORM_SEVERITY[a] ? b : a, 'FLAKY');
    return {classification: worst, state: 'failure',
        suffix: PLATFORM_SUFFIXES[worst]};
}

/**
 * The distinct platforms a run spanned, from its per-shard summary.
 *
 * A suite verdict is one decision covering the whole run, so the platforms it
 * applies to come from summary.shards (each shard ran on one platform) — the
 * individual clusters are symptoms of the suite failure and may not list
 * platforms at all. Shards are the authoritative source of "which platforms
 * this run touched".
 */
function runPlatforms(evidence) {
    const shards = (evidence.summary && Array.isArray(evidence.summary.shards)) ?
        evidence.summary.shards : [];
    const platforms = new Set();
    for (const s of shards) {
        if (!s) {
            continue;
        }
        if (s.platform) {
            platforms.add(normalizePlatform(s.platform));
        }
        if (Array.isArray(s.platforms)) {
            s.platforms.forEach((p) => platforms.add(normalizePlatform(p)));
        }
    }
    return platforms;
}

/**
 * Build the per-platform outcome map.
 *
 * Clusters are matched to verdicts by `cluster_signature`, never array
 * position: a reordered model file must not misattribute a platform. A suite
 * verdict is attributed to every platform the run spanned instead.
 *
 * `ledgerRecorded` is whether the TSIO ledger write succeeded (or was vacuous —
 * nothing to record). A flaky platform can only go green once its verdict is
 * durably recorded; a ledger failure means the waiver is unbacked, so the
 * platform becomes TRIAGE_FAILED. Non-flaky platforms are already red and are
 * unaffected.
 */
function computePlatformOutcomes({evidence, decisions, verdicts, ledgerRecorded}) {
    const byPlatform = new Map();

    if (evidence.suite_verdict) {
        let platforms = runPlatforms(evidence);
        if (platforms.size === 0) {
            for (const c of evidence.clusters || []) {
                (c && c.platforms || []).forEach((p) => platforms.add(normalizePlatform(p)));
            }
        }
        const decision = decisions[0];
        for (const p of platforms) {
            if (!byPlatform.has(p)) {
                byPlatform.set(p, []);
            }
            byPlatform.get(p).push(decision);
        }
    } else {
        const clusterBySignature = new Map(
            (evidence.clusters || [])
                .filter((c) => c && c.signature_hash)
                .map((c) => [c.signature_hash, c]),
        );
        for (let i = 0; i < verdicts.length; i++) {
            const cluster = clusterBySignature.get(verdicts[i].cluster_signature);
            const platforms = (cluster && cluster.platforms) || [];
            for (const p of platforms) {
                const np = normalizePlatform(p);
                if (!byPlatform.has(np)) {
                    byPlatform.set(np, []);
                }
                byPlatform.get(np).push(decisions[i]);
            }
        }
    }

    const outcomes = {};
    for (const platform of [...byPlatform.keys()].sort()) {
        const outcome = platformOutcomeFor(byPlatform.get(platform));
        if (outcome.classification === 'FLAKY' && !ledgerRecorded) {
            outcomes[platform] = {classification: 'TRIAGE_FAILED', state: 'failure',
                suffix: PLATFORM_SUFFIXES.TRIAGE_FAILED};
        } else {
            outcomes[platform] = outcome;
        }
    }
    return outcomes;
}

/**
 * Serialize the platform outcomes as one sanitized GITHUB_OUTPUT line.
 *
 * GITHUB_OUTPUT is parsed as `key=value` per line, so a value carrying a newline
 * would start a new assignment — and `platform_outcomes` is built from fixed
 * enum strings, but the same single-line sanitiser used for the run outputs is
 * applied here so the invariant reads as absolute at the boundary.
 */
function platformOutcomesLine(outcomes) {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    return String(JSON.stringify(outcomes || {}))
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .trim();
}

/**
 * Fetch the current PR head SHA. The waiver label is sticky across pushes and the
 * caller's status reporter honours it unconditionally, so applying it when the
 * PR has moved on would green commits that were never triaged.
 */
async function prHeadSha(token, repo, prNumber) {
    const pr = await gh(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
    return pr.head.sha;
}

async function main() {
    const evidenceFile = arg('evidence', 'triage-out/evidence.json');
    const modelFile = arg('model-output', '');
    const repo = arg('repo');
    const commitSha = arg('commit');
    const prNumber = arg('pr') ? Number(arg('pr')) : null;
    const runType = arg('run-type', 'PR');
    const mode = arg('mode', 'shadow');
    const model = arg('model', '');
    const tsioUrl = arg('tsio-url', 'https://test-io.test.mattermost.com');
    const statusContext = arg('status-context', DEFAULT_STATUS_CONTEXT);
    // Optional. When absent the ledger authenticates with a minted OIDC token,
    // which is the path CI actually uses — no shared secret required.
    const tsioApiKey = process.env.TSIO_API_KEY || '';
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const runUrl = arg('run-url', '');

    if (!token) {
        throw new Error('GH_TOKEN is required');
    }

    const postStatus = (state, description) => gh(token, 'POST', `/repos/${repo}/statuses/${commitSha}`, {
        state,
        context: statusContext,
        description,
        target_url: runUrl,
    });

    const evidence = readJson(evidenceFile);
    if (!evidence) {
        // No evidence means triage did not run. Post red and stop — silence here
        // would leave a required check pending forever.
        await postStatus('failure', 'triage produced no evidence bundle — manual triage required');
        console.log('no evidence bundle; posted red');
        writeOutputs({state: 'failure', waived: false, verdict: 'INCONCLUSIVE',
            operational_outcome: OUTCOMES.TRIAGE_FAILED,
            description: 'triage produced no evidence bundle — manual triage required',
            triage_url: runUrl, blame: null, platform_outcomes: {}});
        return;
    }

    const parsed = modelFile && fs.existsSync(modelFile) ?
        parseModelOutput(fs.readFileSync(modelFile, 'utf8')) :
        {ok: true, error: null, verdicts: []};
    if (!parsed.ok) {
        console.log(`model output rejected: ${parsed.error}`);
    }

    const verdicts = assembleVerdicts(evidence, parsed.verdicts);

    // A suite verdict is one decision covering every cluster, so there is no
    // cluster to line up with it by index. Reading `clusters[i]` against
    // `decisions[i]` would pair the suite decision with an arbitrary cluster;
    // the suite case aggregates instead: if *any* cluster in the run reproduced
    // on rerun or has spent its amnesty, that applies to the verdict that covers
    // them all.
    const clusters = evidence.clusters || [];
    const suiteFacts = evidence.suite_verdict ? {
        amnestyExhausted: clusters.some((c) => c && c.amnesty_exhausted),
        reproducedOnRerun: clusters.some((c) => c && c.reproduced_on_rerun),
    } : null;

    const decisions = verdicts.map((v, i) => decideCluster(v, {
        runType,
        mode,
        amnestyExhausted: suiteFacts ?
            suiteFacts.amnestyExhausted :
            Boolean(clusters[i] && clusters[i].amnesty_exhausted),
        // Overlap is asserted by the caller from the diff, not inferred by the
        // model about its own verdict.
        diffOverlapsFailure: arg('diff-overlaps', 'false') === 'true',
        // Set by the rerun stage. A cluster that failed every repetition is
        // deterministic, and no model verdict may waive it.
        reproducedOnRerun: suiteFacts ?
            suiteFacts.reproducedOnRerun :
            Boolean(clusters[i] && clusters[i].reproduced_on_rerun),
    }));
    // The run's shape decides what "no decisions" means. A passing suite has
    // nothing to triage and must go green; a suite that produced no reports at
    // all must go red. Both look like an empty decision list from here.
    let runDecision = decideRun(decisions, {
        failureCount: evidence.summary ? evidence.summary.failed : null,
        reportsFound: evidence.summary ? evidence.summary.reportsFound : null,
    });

    console.log(JSON.stringify({runDecision, decisions}, null, 2));

    // Resolved before the comment is rendered so the callout travels with it.
    let blame = null;
    try {
        blame = await resolveBlame({token, repo, evidence, decisions});
        if (blame) {
            for (const b of blame) {
                console.log(`blame: ${b.attribution.confident ?
                    `suspect ${b.attribution.suspect.sha} (@${b.attribution.suspect.author})` :
                    b.attribution.reason}`);
            }
        }
    } catch (err) {
        console.error(`blame resolution failed (continuing): ${err.message}`);
    }

    // 1. Ledger. A successful flaky outcome must be recorded before the check is
    //    allowed to go green, and a ledger failure turns the whole run into
    //    TRIAGE_FAILED. This is no longer best-effort: the ledger write is the
    //    authority for the green, so a missing credential or a failed POST costs
    //    the gate, not just a metric.
    //
    //    Ledger rows are mapped to clusters by signature, not by index. The old
    //    code read `clusterByIndex[i]`, which was never defined — so every row
    //    threw on the member_test_ids lookup and the catch swallowed it as a log
    //    line, meaning no verdict ever reached TSIO and the false-green metric
    //    was permanently blind. A suite verdict has no cluster to map to, so its
    //    external_test_id stays null (TSIO accepts a signature in its place).
    // ledgerRecorded drives the per-platform gate: a flaky platform can only
    // go green once its verdict is durably recorded. Vacuously true when there
    // was nothing to record; set false on every failure path below and true
    // only after a successful write.
    let ledgerRecorded = verdicts.length === 0;
    if (verdicts.length > 0) {
        const clusterBySignature = new Map(
            (evidence.clusters || [])
                .filter((c) => c && c.signature_hash)
                .map((c) => [c.signature_hash, c]),
        );
        let ledgerToken = null;
        let credentialReady = false;
        if (tsioApiKey) {
            credentialReady = true;
        } else {
            try {
                ledgerToken = await mintOidcToken(arg('tsio-audience', 'mattermost-test-system-io'));
                credentialReady = Boolean(ledgerToken);
            } catch (err) {
                runDecision = markTriageFailed(runDecision, `OIDC mint failed — ${err.message}`);
                console.error(runDecision.reason);
            }
        }
        if (credentialReady) {
            try {
                const result = await recordLedger({
                    tsioUrl,
                    token: ledgerToken,
                    apiKey: tsioApiKey,
                    batch: {
                        repository: repo,
                        branch: arg('branch', ''),
                        commit_sha: commitSha,
                        gh_run_id: arg('run-id', ''),
                        gh_pr_number: prNumber,
                        model: model || null,
                        tier: evidence.tier,
                        verdicts: verdicts.map((v, i) => {
                            const d = decisions[i];
                            const cluster = clusterBySignature.get(v.cluster_signature);
                            const testIds = cluster && cluster.member_test_ids;
                            return {
                                external_test_id: (testIds && testIds[0]) || null,
                                cluster_signature: v.cluster_signature,
                                member_count: v.member_count,
                                verdict: d.verdict,
                                operational_outcome: d.operational_outcome,
                                confidence: d.confidence,
                                root_cause: d.reason,
                                evidence: v.evidence,
                                check_state: d.state,
                                waived: d.waived,
                            };
                        }),
                    },
                });
                console.log(`recorded ${result.count} verdict(s) in the triage ledger`);
                ledgerRecorded = true;
            } catch (err) {
                runDecision = markTriageFailed(runDecision, `ledger recording failed — ${err.message}`);
                console.error(runDecision.reason);
            }
        } else if (runDecision.state !== 'failure') {
            // No credential and no token, and the mint did not already fail
            // (which would have set TRIAGE_FAILED above). A green run with no way
            // to record it cannot be allowed to stand.
            runDecision = markTriageFailed(runDecision, 'no TSIO credential available to record the verdict');
            console.error(runDecision.reason);
        }
    }

    // Per-platform outcomes are resolved after the ledger gate so they honour
    // ledgerRecorded: a flaky platform whose verdict was not recorded cannot go
    // green.
    const platformOutcomes = computePlatformOutcomes(
        {evidence, decisions, verdicts, ledgerRecorded});

    // 2. Label, only when policy actually waived (never in shadow mode, never on
    //    a baseline branch). The PR head is verified before and after: the label
    //    is sticky across pushes and the status reporter honours it
    //    unconditionally, so a waiver granted for one commit would keep greening
    //    every later commit — including one that introduces a genuine regression.
    //    Any run that does not waive must clear it.
    if (prNumber) {
        try {
            if (runDecision.waived) {
                const headBefore = await prHeadSha(token, repo, prNumber);
                if (headBefore !== commitSha) {
                    runDecision = markTriageFailed(runDecision,
                        `PR head moved to ${headBefore.slice(0, 7)} before the waiver could be applied`);
                    console.error(runDecision.reason);
                } else {
                    await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/labels`, {
                        labels: [AI_WAIVED_LABEL],
                    });
                    // Re-verify immediately: a push between the two GETs would
                    // leave the label applied to a PR whose head was never
                    // triaged. Withdraw it and fail closed.
                    const headAfter = await prHeadSha(token, repo, prNumber);
                    if (headAfter !== commitSha) {
                        await gh(token, 'DELETE',
                            `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(AI_WAIVED_LABEL)}`);
                        runDecision = markTriageFailed(runDecision,
                            `PR head moved to ${headAfter.slice(0, 7)} immediately after the waiver was applied`);
                        console.error(runDecision.reason);
                    }
                }
            } else {
                await gh(token, 'DELETE',
                    `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(AI_WAIVED_LABEL)}`);
                console.log(`cleared ${AI_WAIVED_LABEL} — this run was not waived`);
            }
        } catch (err) {
            // Applying can fail (contexts stay red — the safe direction). Removing
            // can 404 when the label was not set, which is the common case and not
            // an error worth surfacing. A failed apply on a waived run must not
            // leave a green check with no label, so downgrade.
            if (runDecision.waived || !/→ 404/.test(err.message)) {
                console.error(`could not update ${AI_WAIVED_LABEL}: ${err.message}`);
                if (runDecision.waived) {
                    runDecision = markTriageFailed(runDecision,
                        `could not apply ${AI_WAIVED_LABEL} — ${err.message}`);
                }
            }
        }
    }

    // 3. Own status, always posted, reflecting the final outcome (which the
    //    ledger and head verification may have turned red).
    await postStatus(runDecision.state, statusDescription(runDecision));

    // 4. PR comment, updated in place rather than appended.
    //
    // A clean run posts nothing — a comment on every passing PR is noise and the
    // commit status already carries the result — but it does clear a stale one
    // from an earlier push, so the thread never shows failures the latest run no
    // longer has.
    if (prNumber) {
        try {
            const comments = await gh(token, 'GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
            const existing = (comments || []).find((c) => c.body && c.body.includes(COMMENT_MARKER));

            if (decisions.length === 0) {
                if (existing) {
                    await gh(token, 'DELETE', `/repos/${repo}/issues/comments/${existing.id}`);
                    console.log('removed stale triage comment — this run had nothing to triage');
                }
            } else {
                const body = renderComment(runDecision, decisions, verdicts, {
                    commitSha,
                    commitUrl: `https://github.com/${repo}/commit/${commitSha}`,
                    tier: evidence.tier,
                    tierReason: evidence.tier_reason,
                    blame,
                });
                if (existing) {
                    await gh(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, {body});
                } else {
                    await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {body});
                }
            }
        } catch (err) {
            console.error(`could not update triage comment: ${err.message}`);
        }
    }

    writeOutputs({state: runDecision.state, waived: runDecision.waived,
        verdict: runDecision.verdict, operational_outcome: runDecision.operational_outcome,
        description: statusDescription(runDecision), triage_url: runUrl, blame,
        platform_outcomes: platformOutcomes});
}

/**
 * Write the workflow outputs. Every value is flattened to one line — in this
 * file a newline is not cosmetic: GITHUB_OUTPUT is parsed as `key=value` per
 * line and the last assignment for a key wins, so a value carrying
 * "\nstate=success" would overwrite the run's own state. Two of these are
 * outside our control — the description is built from the model's root_cause,
 * and the suspect author comes from git — which is exactly why the sanitising
 * happens here, at the boundary, rather than being assumed upstream.
 */
function writeOutputs({state, waived, verdict, operational_outcome, description, triage_url, blame, platform_outcomes}) {
    if (!process.env.GITHUB_OUTPUT) {
        return;
    }
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const line = (v) => String(v ?? '').
        replace(/[\u0000-\u001F\u007F]+/g, ' ').
        trim();
    const confidentSuspects = (blame || [])
        .filter((b) => b.attribution.confident)
        .map((b) => `${b.attribution.suspect.sha.slice(0, 7)}:${b.attribution.suspect.author || 'unknown'}`)
        .join(',');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
        `state=${line(state)}`,
        `waived=${line(waived)}`,
        `verdict=${line(verdict || 'INCONCLUSIVE')}`,
        `operational_outcome=${line(operational_outcome || '')}`,
        `description=${line(description)}`,
        `triage_url=${line(triage_url)}`,
        `blame_confident=${Boolean(blame && blame.some((b) => b.attribution.confident))}`,
        `blame_suspects=${line(confidentSuspects)}`,
        `platform_outcomes=${platformOutcomesLine(platform_outcomes)}`,
        '',
    ].join('\n'));
}

if (require.main === module) {
    main().catch(async (err) => {
        console.error(`triage-apply failed: ${err.stack || err.message}`);
        // Last-ditch red so a crash here never leaves the check pending.
        try {
            await gh(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, 'POST',
                `/repos/${arg('repo')}/statuses/${arg('commit')}`, {
                    state: 'failure',
                    context: arg('status-context', DEFAULT_STATUS_CONTEXT),
                    description: 'triage errored — manual triage required',
                    target_url: arg('run-url', ''),
                });
        } catch {
            // Nothing left to try.
        }
        process.exit(1);
    });
}

module.exports = {
    assembleVerdicts,
    renderComment,
    resolveBlame,
    mintOidcToken,
    markTriageFailed,
    computePlatformOutcomes,
    platformOutcomesLine,
    normalizePlatform,
    decisionClassification,
    AI_WAIVED_LABEL,
    DEFAULT_STATUS_CONTEXT,
};