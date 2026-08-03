#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Human override of an automated triage verdict.
 *
 * Corrections are the only ground truth this system ever gets. Everything else —
 * confidence scores, signature weights, model verdicts — is the system grading
 * its own homework. A maintainer saying "that was actually a real bug" is the
 * single input that can tell us the triage is wrong, and it is what the
 * false-green metric counts.
 *
 * So this does two things, and the order matters:
 *
 *   1. Record the correction in the TSIO ledger. This is the durable part; it
 *      survives the PR being merged and feeds the accuracy metrics that decide
 *      whether triage is ever allowed to gate anything.
 *   2. Bring the checks into line with what the human said.
 *
 * If (1) fails we still do (2) — the maintainer's immediate intent must be
 * honoured — but we say so loudly, because a correction that was not recorded is
 * a data point permanently lost.
 */

const AI_WAIVED_LABEL = 'E2E/AI-Waived';
const STATUS_CONTEXT = 'e2e-test/ai-triage';

const VERDICTS = new Set([
    'PR_REGRESSION',
    'MAIN_REGRESSION',
    'FLAKY_TEST',
    'FLAKY_INFRA',
    'FLAKY_SERVER',
    'BUILD_OR_ENV_ERROR',
    'TEST_DEBT',
    'INCONCLUSIVE',
]);

// Verdicts whose meaning is "not attributable to this change", i.e. the ones that
// justify a green. Mirrors WAIVABLE in triage-policy.js.
const WAIVABLE = new Set(['FLAKY_TEST', 'FLAKY_INFRA', 'FLAKY_SERVER', 'MAIN_REGRESSION']);

/**
 * Parse `/e2e-triage-override <verdict> <reason>`.
 *
 * A reason is mandatory. The correction's whole value is as a labelled example
 * for whoever later asks "why was the model wrong here" — a bare verdict with no
 * explanation records that it was wrong while discarding the only part that says
 * how.
 *
 * The verdict is matched case-insensitively and with dashes normalised, because
 * people will type `flaky-infra` at least as often as `FLAKY_INFRA`.
 */
function parseCommand(body) {
    const line = String(body || '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('/e2e-triage-override'));

    if (!line) {
        return {ok: false, error: 'no /e2e-triage-override command found'};
    }

    const rest = line.slice('/e2e-triage-override'.length).trim();
    if (!rest) {
        return {
            ok: false,
            error: 'usage: `/e2e-triage-override <verdict> <reason>` — for example ' +
                '`/e2e-triage-override PR_REGRESSION this really was broken by the change`',
        };
    }

    const [rawVerdict, ...reasonParts] = rest.split(/\s+/);
    const verdict = rawVerdict.toUpperCase().replace(/-/g, '_');

    if (!VERDICTS.has(verdict)) {
        return {
            ok: false,
            error: `\`${rawVerdict}\` is not a known verdict. One of: ${[...VERDICTS].join(', ')}`,
        };
    }

    const reason = reasonParts.join(' ').trim();
    if (!reason) {
        return {
            ok: false,
            error: 'a reason is required — the correction is only useful as a labelled ' +
                'example if it says *why* the verdict was wrong',
        };
    }

    return {ok: true, verdict, reason, waivable: WAIVABLE.has(verdict)};
}

/**
 * What the checks should look like after a correction.
 *
 * A human correcting to a waivable verdict is saying "this failure was not
 * caused by the change", so the checks go green. Correcting to anything else is
 * saying the opposite, and the waiver must be withdrawn — including the label,
 * which is sticky and would otherwise keep greening later commits.
 */
function decideAfterOverride(parsed) {
    if (parsed.waivable) {
        return {
            state: 'success',
            applyLabel: true,
            description: `human override: ${parsed.verdict.toLowerCase().replace(/_/g, '-')} — ${parsed.reason}`,
        };
    }
    return {
        state: 'failure',
        applyLabel: false,
        description: `human override: ${parsed.verdict.toLowerCase().replace(/_/g, '-')} — ${parsed.reason}`,
    };
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
    return (await res.json()).value || null;
}

/**
 * Record the correction against every verdict triage produced for this PR.
 *
 * All of them, not just the run-level one: the maintainer is correcting the
 * conclusion, and leaving per-cluster rows uncorrected would leave the accuracy
 * query reporting those clusters as unchallenged.
 */
async function recordCorrections({tsioUrl, credential, repo, prNumber, parsed, actor}) {
    const headers = credential.apiKey ?
        {'X-API-Key': credential.apiKey} :
        {Authorization: `Bearer ${credential.token}`};

    const listUrl = `${tsioUrl}/api/v1/triage/verdicts?repo=${encodeURIComponent(repo)}&pr=${prNumber}&limit=200`;

    // Credentials on the read too. It is a public endpoint today, so this is not
    // required — but the read and the writes that follow it are one operation,
    // and leaving the read anonymous means putting the endpoint behind auth later
    // breaks override rather than being a no-op.
    const listRes = await fetch(listUrl, {headers});
    if (!listRes.ok) {
        throw new Error(`could not list verdicts: ${listRes.status}`);
    }
    const {verdicts} = await listRes.json();
    if (!verdicts || verdicts.length === 0) {
        return {ok: false, corrected: 0, total: 0, note: 'no recorded verdicts for this PR'};
    }

    // Only the newest run's verdicts: older ones describe commits that are no
    // longer what the checks reflect. Newest is resolved from created_at rather
    // than by trusting the response order — the endpoint happens to sort
    // newest-first, but correcting the wrong commit's verdicts is silent and
    // permanent, which is too much to stake on an ordering nobody promised.
    const newest = verdicts.reduce((a, b) =>
        (new Date(b.created_at) > new Date(a.created_at) ? b : a));
    const targets = verdicts.filter((v) => v.commit_sha === newest.commit_sha);

    let corrected = 0;
    for (const v of targets) {
        const res = await fetch(`${tsioUrl}/api/v1/triage/verdicts/${v.id}/correction`, {
            method: 'POST',
            headers: {...headers, 'Content-Type': 'application/json'},
            // corrected_by is not sent: TSIO derives attribution from the
            // authenticated principal, because a body-supplied name could be
            // anyone's. The maintainer is named in the PR comment below, under
            // GitHub's own authentication.
            body: JSON.stringify({
                corrected_verdict: parsed.verdict,
                corrected_reason: parsed.reason,
            }),
        });
        if (res.ok) {
            corrected += 1;
        } else {
            console.error(`correction for ${v.id} failed: ${res.status} ${await res.text()}`);
        }
    }
    // ok is what the caller reports on, rather than the shape of the note. A run
    // where every correction POST failed still produces "0/5 verdict(s)
    // corrected", which reads as success to anything matching on that phrasing —
    // and claiming a correction was recorded when none was is a false claim of
    // accountability in the one place accountability is the product.
    return {ok: corrected > 0, corrected, total: targets.length, commit: newest.commit_sha};
}

function arg(name, dflt = '') {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? dflt : hit.slice(name.length + 3);
}

async function main() {
    const repo = arg('repo');
    const prNumber = Number(arg('pr'));
    const actor = arg('actor');
    const commentId = arg('comment-id');
    const tsioUrl = arg('tsio-url', 'https://test-io.test.mattermost.com');
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const body = process.env.COMMENT_BODY || '';

    if (!token) {
        throw new Error('GH_TOKEN is required');
    }

    const parsed = parseCommand(body);
    if (!parsed.ok) {
        // A malformed command gets a thumbs-down and an explanation rather than a
        // silent no-op: the maintainer believes they have corrected something.
        if (commentId) {
            await gh(token, 'POST', `/repos/${repo}/issues/comments/${commentId}/reactions`, {content: 'confused'});
        }
        await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {
            body: `:warning: **Triage override not applied** — ${parsed.error}`,
        });
        console.log(`rejected: ${parsed.error}`);
        return;
    }

    const decision = decideAfterOverride(parsed);
    console.log(JSON.stringify({parsed, decision}));

    // Resolve the head SHA now: the status has to land on the commit the checks
    // are attached to, not on whatever the PR pointed at when triage ran.
    const pr = await gh(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
    const headSha = pr.head.sha;

    // 1. Record first — this is the part that outlives the PR.
    let ledgerNote = 'not recorded';
    let recordedCleanly = false;
    try {
        const apiKey = process.env.TSIO_API_KEY || '';
        const oidc = apiKey ? null : await mintOidcToken(arg('tsio-audience', 'mattermost-test-system-io'));
        if (apiKey || oidc) {
            const result = await recordCorrections({
                tsioUrl,
                credential: {apiKey, token: oidc},
                repo,
                prNumber,
                parsed,
                actor,
            });
            ledgerNote = result.note || `${result.corrected}/${result.total} verdict(s) corrected`;
            recordedCleanly = Boolean(result.ok);
        } else {
            ledgerNote = 'no TSIO credential available';
        }
    } catch (err) {
        ledgerNote = `ledger write failed: ${err.message}`;
        console.error(ledgerNote);
    }

    // 2. Bring the checks into line with the human's decision.
    await gh(token, 'POST', `/repos/${repo}/statuses/${headSha}`, {
        state: decision.state,
        context: STATUS_CONTEXT,
        description: decision.description.slice(0, 140),
        target_url: arg('run-url', ''),
    });

    try {
        if (decision.applyLabel) {
            await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/labels`, {labels: [AI_WAIVED_LABEL]});
        } else {
            await gh(token, 'DELETE',
                `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(AI_WAIVED_LABEL)}`);
        }
    } catch (err) {
        if (decision.applyLabel || !/→ 404/.test(err.message)) {
            console.error(`label update failed: ${err.message}`);
        }
    }

    if (commentId) {
        await gh(token, 'POST', `/repos/${repo}/issues/comments/${commentId}/reactions`, {content: '+1'});
    }

    await gh(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {
        body: [
            `:white_check_mark: **Triage override applied by @${actor}**`,
            '',
            `\`${STATUS_CONTEXT}\` is now **${decision.state}** — \`${parsed.verdict}\`: ${parsed.reason}`,
            '',
            recordedCleanly ?
                `_Correction recorded (${ledgerNote}). It counts toward the triage accuracy metrics._` :
                `:warning: _The check was updated, but the correction was **not** recorded: ${ledgerNote}. ` +
                'The accuracy metrics will not see this one._',
        ].join('\n'),
    });

    console.log(`override applied: ${decision.state} (${ledgerNote})`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`triage-override failed: ${err.stack || err.message}`);
        process.exit(1);
    });
}

module.exports = {parseCommand, decideAfterOverride, VERDICTS, WAIVABLE, AI_WAIVED_LABEL, STATUS_CONTEXT};
