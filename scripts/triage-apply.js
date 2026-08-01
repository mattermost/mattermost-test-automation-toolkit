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
    if (runDecision.state === 'success') {
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

async function recordLedger({tsioUrl, token, batch}) {
    const res = await fetch(`${tsioUrl}/api/v1/triage/verdicts`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
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
    const tsioToken = process.env.TSIO_TOKEN || '';
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
    }));
    const runDecision = decideRun(decisions);

    console.log(JSON.stringify({runDecision, decisions}, null, 2));

    // 1. Own status, always posted.
    await gh(token, 'POST', `/repos/${repo}/statuses/${commitSha}`, {
        state: runDecision.state,
        context: STATUS_CONTEXT,
        description: statusDescription(runDecision),
        target_url: runUrl,
    });

    // 2. Label, only when policy actually waived (never in shadow mode).
    if (runDecision.waived && prNumber) {
        try {
            await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/labels`, {
                labels: [AI_WAIVED_LABEL],
            });
        } catch (err) {
            // A failed label write means the platform contexts will stay red.
            // That is the safe direction, so log and continue.
            console.error(`could not apply ${AI_WAIVED_LABEL}: ${err.message}`);
        }
    }

    // 3. PR comment, updated in place rather than appended.
    if (prNumber) {
        try {
            const body = renderComment(runDecision, decisions, verdicts, {
                commitSha,
                commitUrl: `https://github.com/${repo}/commit/${commitSha}`,
                tier: evidence.tier,
                tierReason: evidence.tier_reason,
            });
            const comments = await gh(token, 'GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
            const existing = (comments || []).find((c) => c.body && c.body.includes(COMMENT_MARKER));
            if (existing) {
                await gh(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, {body});
            } else {
                await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {body});
            }
        } catch (err) {
            console.error(`could not post triage comment: ${err.message}`);
        }
    }

    // 4. Ledger. Best-effort: a missing ledger row costs a metric, not a gate.
    if (tsioToken) {
        try {
            const result = await recordLedger({
                tsioUrl,
                token: tsioToken,
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
        console.log('no TSIO token — skipping ledger write');
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

module.exports = {assembleVerdicts, renderComment, AI_WAIVED_LABEL, STATUS_CONTEXT};
