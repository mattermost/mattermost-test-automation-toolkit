#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Apply triage verdicts: decide, post, record.
 *
 * Reads the deterministic evidence bundle plus (optionally) the model's verdict
 * file, runs them through the policy engine, and then does the three things that
 * have side effects:
 *
 *   1. posts the `e2e-test/ai-triage` commit status
 *   2. applies the E2E/AI-Waived label when policy waived the run
 *   3. records every verdict in the TSIO ledger
 *
 * Ordering matters: the ledger write happens last and is best-effort, but the
 * label is applied *before* the platform contexts get re-posted, because the
 * re-post reads the label to decide whether to downgrade a failure to success.
 *
 * Every failure path here ends in a red status. If this script cannot do its job,
 * the run must look exactly as it did before triage existed.
 */

const fs = require('fs');

const {decideCluster, decideRun, parseModelOutput, statusDescription} = require('./triage-policy');

const AI_WAIVED_LABEL = 'E2E/AI-Waived';
const STATUS_CONTEXT = 'e2e-test/ai-triage';
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
            cluster_signature: null,
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
    lines.push('| Cluster | Verdict | Conf | Source | Tests | Why |', '|---|---|---:|---|---:|---|');
    verdicts.forEach((v, i) => {
        const d = decisions[i];
        lines.push([
            '',
            v.cluster_signature ? `\`${v.cluster_signature}\`` : '_suite_',
            d.verdict,
            d.confidence,
            v.source,
            v.member_count,
            String(d.reason || '').replace(/\|/g, '\\|').slice(0, 160),
            '',
        ].join(' | ').trim());
    });
    lines.push(
        '',
        `_Tier ${opts.tier} — ${opts.tierReason}_`,
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
 * vars are absent and the ledger write is skipped rather than failing the run.
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
    return res.json();
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
    // Optional. When absent the ledger authenticates with a minted OIDC token,
    // which is the path CI actually uses — no shared secret required.
    const tsioApiKey = process.env.TSIO_API_KEY || '';
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const runUrl = arg('run-url', '');

    if (!token) {
        throw new Error('GH_TOKEN is required');
    }

    const evidence = readJson(evidenceFile);
    if (!evidence) {
        // No evidence means triage did not run. Post red and stop — silence here
        // would leave a required check pending forever.
        await gh(token, 'POST', `/repos/${repo}/statuses/${commitSha}`, {
            state: 'failure',
            context: STATUS_CONTEXT,
            description: 'triage produced no evidence bundle — manual triage required',
            target_url: runUrl,
        });
        console.log('no evidence bundle; posted red');
        return;
    }

    const parsed = modelFile && fs.existsSync(modelFile) ?
        parseModelOutput(fs.readFileSync(modelFile, 'utf8')) :
        {ok: true, error: null, verdicts: []};
    if (!parsed.ok) {
        console.log(`model output rejected: ${parsed.error}`);
    }

    const verdicts = assembleVerdicts(evidence, parsed.verdicts);
    const clusterByIndex = evidence.suite_verdict ? [] : (evidence.clusters || []);
    const decisions = verdicts.map((v, i) => decideCluster(v, {
        runType,
        mode,
        amnestyExhausted: Boolean(clusterByIndex[i] && clusterByIndex[i].amnesty_exhausted),
        // Overlap is asserted by the caller from the diff, not inferred by the
        // model about its own verdict.
        diffOverlapsFailure: arg('diff-overlaps', 'false') === 'true',

        // Set by the rerun stage. A cluster that failed every repetition is
        // deterministic, and no model verdict may waive it.
        reproducedOnRerun: Boolean(clusterByIndex[i] && clusterByIndex[i].reproduced_on_rerun),
    }));
    // The run's shape decides what "no decisions" means. A passing suite has
    // nothing to triage and must go green; a suite that produced no reports at
    // all must go red. Both look like an empty decision list from here.
    const runDecision = decideRun(decisions, {
        failureCount: evidence.summary ? evidence.summary.failed : null,
        reportsFound: evidence.summary ? evidence.summary.reportsFound : null,
    });

    console.log(JSON.stringify({runDecision, decisions}, null, 2));

    // 1. Own status, always posted.
    await gh(token, 'POST', `/repos/${repo}/statuses/${commitSha}`, {
        state: runDecision.state,
        context: STATUS_CONTEXT,
        description: statusDescription(runDecision),
        target_url: runUrl,
    });

    // 2. Label, only when policy actually waived (never in shadow mode).
    //
    // The removal branch matters as much as the application one. The label is
    // sticky across pushes and the status reporter honours it unconditionally, so
    // a waiver granted for one commit would keep greening every later commit —
    // including one that introduces a genuine regression. Any run that does not
    // waive must clear it.
    if (prNumber) {
        try {
            if (runDecision.waived) {
                await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/labels`, {
                    labels: [AI_WAIVED_LABEL],
                });
            } else {
                await gh(token, 'DELETE',
                    `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(AI_WAIVED_LABEL)}`);
                console.log(`cleared ${AI_WAIVED_LABEL} — this run was not waived`);
            }
        } catch (err) {
            // Applying can fail (contexts stay red — the safe direction). Removing
            // can 404 when the label was not set, which is the common case and not
            // an error worth surfacing.
            if (runDecision.waived || !/→ 404/.test(err.message)) {
                console.error(`could not update ${AI_WAIVED_LABEL}: ${err.message}`);
            }
        }
    }

    // 3. PR comment, updated in place rather than appended.
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

    // 4. Ledger. Best-effort: a missing ledger row costs a metric, not a gate.
    let ledgerToken = null;
    if (!tsioApiKey) {
        try {
            ledgerToken = await mintOidcToken(arg('tsio-audience', 'mattermost-test-system-io'));
        } catch (err) {
            console.error(`OIDC mint failed (skipping ledger): ${err.message}`);
        }
    }
    if (tsioApiKey || ledgerToken) {
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
                    verdicts: verdicts.map((v, i) => ({
                        external_test_id: (clusterByIndex[i] && clusterByIndex[i].member_test_ids &&
                            clusterByIndex[i].member_test_ids[0]) || null,
                        cluster_signature: v.cluster_signature,
                        member_count: v.member_count,
                        verdict: decisions[i].verdict,
                        confidence: decisions[i].confidence,
                        root_cause: decisions[i].reason,
                        evidence: v.evidence,
                        check_state: decisions[i].state,
                        waived: decisions[i].waived,
                    })),
                },
            });
            console.log(`recorded ${result.count} verdict(s) in the triage ledger`);
        } catch (err) {
            console.error(`ledger write failed (continuing): ${err.message}`);
        }
    } else {
        console.log('no TSIO credential (no API key, no OIDC) — skipping ledger write');
    }

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, [
            `state=${runDecision.state}`,
            `waived=${runDecision.waived}`,
            `verdict=${runDecision.verdict || 'INCONCLUSIVE'}`,
            `description=${statusDescription(runDecision)}`,
            '',
        ].join('\n'));
    }
}

if (require.main === module) {
    main().catch(async (err) => {
        console.error(`triage-apply failed: ${err.stack || err.message}`);
        // Last-ditch red so a crash here never leaves the check pending.
        try {
            await gh(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, 'POST',
                `/repos/${arg('repo')}/statuses/${arg('commit')}`, {
                    state: 'failure',
                    context: STATUS_CONTEXT,
                    description: 'triage errored — manual triage required',
                    target_url: arg('run-url', ''),
                });
        } catch {
            // Nothing left to try.
        }
        process.exit(1);
    });
}

module.exports = {assembleVerdicts, renderComment, mintOidcToken, AI_WAIVED_LABEL, STATUS_CONTEXT};
