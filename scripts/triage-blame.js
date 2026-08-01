#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
/* eslint-disable no-console */

/**
 * Attribute a main regression to the commit that caused it.
 *
 * When triage concludes MAIN_REGRESSION the PR under test is innocent, but
 * somebody's change did break the baseline and nobody is currently being told.
 * Without this the verdict is only half useful: the PR gets waved through and
 * the actual regression sits on main unowned.
 *
 * The expensive way to answer this is `git bisect`, where every step is a full
 * iOS/Android build plus a run — 20 to 40 minutes each. The cheap way is that
 * TSIO already knows the last commit where the test passed and the first where
 * it failed, so the suspect range is whatever landed between them. In the common
 * case that is a single commit and the answer is free.
 */

// Above this many commits the range is too wide to name a culprit responsibly.
// Naming the wrong author is worse than naming nobody: it burns the one thing
// this feature needs, which is people trusting the callout enough to look.
const MAX_NAMEABLE_RANGE = 8;

/**
 * Work out the suspect range from a test's history summary.
 *
 * `history` is the `summary` object from GET /api/v1/tests/history.
 */
function resolveSuspectRange(history) {
    if (!history) {
        return {resolvable: false, reason: 'no history for this test'};
    }
    const {last_pass_commit: lastPass, failing_since_commit: failingSince} = history;

    if (!failingSince) {
        return {resolvable: false, reason: 'the test is not in a failing streak on the baseline'};
    }
    if (!lastPass) {
        // Never passed in the window. It is broken, but "broken since before we
        // were looking" is not a regression anyone can be blamed for.
        return {
            resolvable: false,
            reason: 'the test has not passed within the history window — this is not a fresh regression',
            failingSince,
        };
    }
    return {resolvable: true, lastPass, failingSince};
}

/**
 * Turn a GitHub compare response into a blame conclusion.
 *
 * Merge commits are dropped: on a squash-merge repo they are noise, and on a
 * merge-commit repo the merge itself is not where the change was written.
 */
function attribute(compareCommits, {maxRange = MAX_NAMEABLE_RANGE} = {}) {
    const commits = (compareCommits || []).filter(
        (c) => !c.parents || c.parents.length <= 1,
    );

    if (commits.length === 0) {
        return {confident: false, reason: 'no non-merge commits in the suspect range', commits: []};
    }

    const described = commits.map((c) => ({
        sha: c.sha,
        author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || null,
        message: ((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 120),
    }));

    if (described.length === 1) {
        return {
            confident: true,
            reason: 'exactly one commit landed between the last pass and the first failure',
            suspect: described[0],
            commits: described,
        };
    }

    if (described.length > maxRange) {
        return {
            confident: false,
            reason: `${described.length} commits in the suspect range — too wide to name a culprit`,
            commits: described.slice(0, maxRange),
            truncated: described.length - maxRange,
        };
    }

    return {
        confident: false,
        reason: `${described.length} candidate commits — needs a human or an explicit bisect to narrow`,
        commits: described,
    };
}

/**
 * Render the callout.
 *
 * Deliberately addressed to the suspect author rather than to the PR author: the
 * PR author can do nothing about this, and telling them to "look into it" is how
 * a useful signal becomes noise people filter out.
 */
function formatCallout({repo, testIds, range, attribution}) {
    const lines = ['### Main regression detected', ''];
    const tests = testIds.filter(Boolean);
    lines.push(
        tests.length > 0 ?
            `\`${tests.slice(0, 5).join('`, `')}\`${tests.length > 5 ? ` and ${tests.length - 5} more` : ''} ` +
                'started failing on the baseline branch.' :
            'A test started failing on the baseline branch.',
        '',
    );

    if (range.resolvable) {
        lines.push(
            `Last passed at \`${range.lastPass.slice(0, 7)}\`, first failed at \`${range.failingSince.slice(0, 7)}\`.`,
            `[Compare the range](https://github.com/${repo}/compare/${range.lastPass}...${range.failingSince})`,
            '',
        );
    }

    if (attribution.confident) {
        const s = attribution.suspect;
        lines.push(
            `**Suspect commit:** [\`${s.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${s.sha}) — ${s.message}`,
            s.author ? `**Author:** @${s.author}` : '**Author:** unknown',
            '',
            '_Exactly one commit landed in the range, so this is attribution rather than a guess._',
        );
    } else {
        lines.push(`**Not attributed:** ${attribution.reason}`, '');
        if (attribution.commits.length > 0) {
            lines.push('Candidates:', '');
            for (const c of attribution.commits) {
                lines.push(
                    `- [\`${c.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${c.sha}) ` +
                    `${c.author ? `@${c.author}` : 'unknown author'} — ${c.message}`,
                );
            }
            if (attribution.truncated) {
                lines.push(`- …and ${attribution.truncated} more`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Pull the test IDs and history entries that carry a baseline failing streak out
 * of an evidence bundle. Only clusters the model called MAIN_REGRESSION matter —
 * a flaky test also has gaps in its history, and blaming a commit for a flake is
 * exactly the false accusation this must not make.
 */
function blameCandidates(evidence, decisions) {
    const out = [];
    (evidence.clusters || []).forEach((cluster, i) => {
        const decision = decisions[i];
        if (!decision || decision.verdict !== 'MAIN_REGRESSION') {
            return;
        }
        for (const entry of cluster.history || []) {
            const range = resolveSuspectRange(entry.history);
            if (range.resolvable) {
                out.push({testId: entry.test_id, range});
            }
        }
    });
    return out;
}

module.exports = {
    MAX_NAMEABLE_RANGE,
    attribute,
    blameCandidates,
    formatCallout,
    resolveSuspectRange,
};
