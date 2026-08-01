# E2E AI Triage (reusable)

Adjudicates E2E failures a caller repo's deterministic rules could not decide,
then posts `e2e-test/ai-triage`.

## Division of labour

The caller owns everything device- and repo-specific; this workflow owns
everything repo-agnostic.

| Stage | Where | What |
|---|---|---|
| collect, cluster, rule-classify, enrich with history | **caller repo** | needs its spec layout, its artifact names, and its failure-signature catalogue |
| adjudicate the residue, apply policy, post status/label/comment/ledger | **here** | operates purely on the normalized `evidence.json` contract |

The contract between them is one file. Any framework that can produce it can use
this workflow.

## Design rules

These are what make an automated green trustworthy. Change them deliberately.

**Fail closed.** No evidence bundle, unparseable model output, unknown verdict,
confidence under the bar, API error, job timeout — all resolve red. There is no
path where "we don't know" produces green.

**Asymmetric bars.** A verdict that would waive a failure needs 0.85 confidence;
one that keeps it red needs 0.7. The errors are not symmetric: a false red costs
a rerun, a false green ships a bug.

**Two citations minimum.** A verdict citing fewer than two independent evidence
items is downgraded to `INCONCLUSIVE` before policy ever sees it. A single
citation is an assertion, not corroboration.

**The model never decides its own authority.** It emits a verdict; the
deterministic, unit-tested policy engine in `scripts/triage-policy.js` decides
what that means for the merge button. The model never calls the status API.

**One unwaived cluster keeps the run red.** A run is green only when *every*
cluster is waived. Greening because the majority was flaky is exactly the failure
mode that would make the system untrustworthy.

**Baseline branches never auto-waive.** On `MAIN` and `RELEASE` runs, a flake
verdict is recorded but stays red. Baseline health has to reflect reality — it is
also the comparison every PR's verdict is drawn from.

**AI waivers are labelled separately.** `E2E/AI-Waived`, never the human
`E2E/Override`. Conflating them makes the false-green metric uncomputable.

## Modes

| Mode | Behaviour | Use when |
|---|---|---|
| `shadow` | posts its own status and comment; never waives | always, first. Measure accuracy before granting authority. |
| `assist` | additionally applies `E2E/AI-Waived`, which the caller's status reporter honours | once `false_greens` has been 0 over a real sample |
| `gate` | reserved for making `e2e-test/ai-triage` the required check | only after sustained assist-mode metrics |

Promotion is a repo-variable change (`E2E_AI_TRIAGE_MODE`), not a code change, so
rolling back is instant.

## Usage

```yaml
adjudicate:
  uses: mattermost/mattermost-test-automation-toolkit/.github/workflows/e2e-ai-triage.yml@main
  permissions:
    contents: read
    actions: read
    statuses: write
    pull-requests: write
    issues: write
    id-token: write
  with:
    target_repo: ${{ github.repository }}
    commit_sha: ${{ inputs.commit_sha }}
    pr_number: ${{ inputs.pr_number }}
    run_type: PR
    evidence_artifact: e2e-triage-evidence-${{ github.run_id }}
    evidence_run_id: ${{ github.run_id }}
    mode: ${{ vars.E2E_AI_TRIAGE_MODE || 'shadow' }}
    diff_overlaps_failure: ${{ needs.plan.outputs.diff_overlaps == 'true' }}
  secrets:
    GH_TOKEN: ${{ secrets.GH_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    TSIO_TOKEN: ${{ secrets.TSIO_TOKEN }}
    WEBHOOK_URL: ${{ secrets.WEBHOOK_URL }}
```

`permissions` must be granted at every level down from the root workflow — a
reusable workflow cannot escalate past its caller, and a missing scope makes the
nested step no-op silently rather than fail.

## `evidence.json` contract

```jsonc
{
  "tier": 1,                       // 0-4 volume tier; 4 = the run itself is broken
  "tier_reason": "...",
  "summary": {"totalTests": 600, "passed": 590, "failed": 10, "shards": [...]},
  "suite_verdict": null,           // set when a suite-shape rule already decided the run
  "needs_ai": true,
  "clusters": [{
    "signature_hash": "a1b2c3d4e5f6",
    "signature_label": "...",
    "member_count": 7,
    "spans_shards": true,
    "spans_platforms": false,
    "shards": ["1"], "platforms": ["ios"], "specs": ["..."],
    "matched_signatures": [{"id": "device.adb-offline", "weight": 0.9, "verdict": "FLAKY_INFRA"}],
    "rule_verdict": null,          // non-null means the rules decided; the model is skipped
    "confidence": 0.25,
    "needs_ai": true,
    "representative": {"error_message": "...", "device_log_excerpt": "...", "screenshot": "..."},
    "member_test_ids": ["MM-T4783_1"],
    "history": [...],              // per-test TSIO history + amnesty
    "all_failing_on_baseline": false,
    "any_failing_elsewhere": false,
    "amnesty_exhausted": false
  }]
}
```

Clusters with `needs_ai: false` and a `rule_verdict` are already decided and are
never sent to the model. A `suite_verdict` replaces per-cluster adjudication
entirely — when every shard died, the individual assertion messages are symptoms,
not causes.

## Verdicts

| Verdict | Waivable | Meaning |
|---|---|---|
| `PR_REGRESSION` | no | the change under test broke it |
| `MAIN_REGRESSION` | yes\* | already failing on the baseline branch |
| `FLAKY_TEST` | yes | test-side non-determinism |
| `FLAKY_INFRA` | yes | runner, emulator, or simulator |
| `FLAKY_SERVER` | yes | test server or its provisioning |
| `BUILD_OR_ENV_ERROR` | no | bundler/dependency/signing — looks like infra, is a code problem |
| `TEST_DEBT` | no | the test is wrong and the app is right |
| `INCONCLUSIVE` | no | evidence bar not met |

\* only when `diff_overlaps_failure` is false. If the PR touches the same area,
attribution is ambiguous and ambiguity is red.

## Metrics

Every verdict is recorded in the TSIO ledger. `GET /api/v1/triage/accuracy`
returns `false_greens` — waived verdicts a human later reclassified as a real
bug. **That number decides whether this system is allowed to gate anything.** It
must be zero.

Human corrections come from `/e2e-triage-override <verdict> <reason>` on the PR
and are the only ground truth available; recurring ones should become signature
entries in the caller's catalogue, which shrinks the model's share of the work
over time.

## Testing

```bash
node --test scripts/triage-policy.test.js scripts/triage-apply.test.js
```
