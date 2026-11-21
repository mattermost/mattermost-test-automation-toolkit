// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import type { GitHub } from "./github.ts";

export interface CheckRunInputs {
  repository: string;
  runId: string;
  workflows: string[];
  /** Matches the whole head branch. */
  branches: RegExp;
  events: string[];
}

/** What the action reads of a workflow run. */
interface WorkflowRun {
  path?: string;
  head_branch?: string | null;
  event?: string;
  head_repository?: { full_name?: string } | null;
}

/**
 * Reads a workflow run of this repository and fails unless it ran one of the allowed workflow files, on an allowed
 * branch, for an allowed event, from this repository rather than a fork.
 */
export async function checkRun(inputs: CheckRunInputs, github: GitHub, log: (message: string) => void): Promise<void> {
  const run = (await github.json(`/repos/${inputs.repository}/actions/runs/${inputs.runId}`)) as WorkflowRun;
  const path = run?.path ?? "";
  const branch = run?.head_branch ?? "";
  const event = run?.event ?? "";
  const repo = run?.head_repository?.full_name ?? "";
  const allowed =
    inputs.workflows.includes(path) &&
    inputs.branches.test(branch) &&
    inputs.events.includes(event) &&
    repo === inputs.repository;
  const described = `${path || "no workflow"} on ${branch || "no branch"} (${event || "no event"}) from ${repo || "no repository"}`;
  if (!allowed) throw new Error(`e2e-test-stack: run ${inputs.runId} is not an allowed run: ${described}`);
  log(`e2e-test-stack: run ${inputs.runId} is allowed: ${described}`);
}
