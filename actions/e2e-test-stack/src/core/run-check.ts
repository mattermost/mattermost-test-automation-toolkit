// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { ActionError } from "./errors.ts";
import type { GitHub } from "./github.ts";

/** What another run must be for an action to act on its batches. */
export interface RunAllowance {
  /** Workflow files, .github/workflows/<file>. */
  workflows: readonly string[];
  /** Matches the whole head branch. */
  branches: RegExp;
  events: readonly string[];
}

/** What the action reads of a workflow run. */
interface WorkflowRun {
  path?: unknown;
  head_branch?: unknown;
  event?: unknown;
  run_attempt?: unknown;
  status?: unknown;
  head_repository?: { full_name?: unknown } | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Reads another workflow run of this repository and returns its latest attempt. Fails unless it ran one of the
 * allowed workflow files, on an allowed branch, for an allowed event, from this repository rather than a fork, and
 * has completed.
 */
export async function checkRun(
  github: GitHub,
  repository: string,
  runId: string,
  allowed: RunAllowance,
  log: (message: string) => void,
): Promise<number> {
  const run = (await github.json(`/repos/${repository}/actions/runs/${runId}`)) as WorkflowRun | null;
  const path = text(run?.path);
  const branch = text(run?.head_branch);
  const event = text(run?.event);
  const from = text(run?.head_repository?.full_name);
  const described = JSON.stringify(
    `${path || "no workflow"} on ${branch || "no branch"} (${event || "no event"}) from ${from || "no repository"}`,
  );
  if (
    !allowed.workflows.includes(path) ||
    !allowed.branches.test(branch) ||
    !allowed.events.includes(event) ||
    from !== repository
  )
    throw new ActionError(`run ${runId} is not one this action may act on: it is ${described}`);
  // A run still going may be testing against its batches, and may create another after the listing.
  const status = text(run?.status);
  if (status !== "completed")
    throw new ActionError(
      `run ${runId} is ${JSON.stringify(status || "in no state")}, not completed: destroy its batches once it completes`,
    );
  const attempt = run?.run_attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new ActionError(`run ${runId} has no attempt number`);
  log(`e2e-test-stack: run ${runId} is allowed: ${described}, attempt ${attempt}`);
  return attempt;
}
