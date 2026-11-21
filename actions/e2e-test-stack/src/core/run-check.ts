// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { ActionError } from "./errors.ts";
import type { GitHub } from "./github.ts";

/** What the action reads of a workflow run, or of one attempt of it. */
interface WorkflowRun {
  path?: unknown;
  head_branch?: unknown;
  event?: unknown;
  run_attempt?: unknown;
  status?: unknown;
  head_repository?: { full_name?: unknown } | null;
  triggering_actor?: { login?: unknown; type?: unknown } | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The batch a by-hand action names in another run: its run, the attempt that created it, and who acts now. */
export interface ByHand {
  runId: string;
  attempt: number;
  /** The person who started this job, GITHUB_TRIGGERING_ACTOR. */
  actor: string;
}

/**
 * Checks that an action started by hand may act on a batch of another run, and returns that run's latest attempt. The
 * run must be this repository's own, not a fork's, and completed: a run still going may be testing against its
 * batches. It must have been started by hand (workflow_dispatch), and the attempt that created the batch by the same
 * person who started this job: nobody acts by hand on a batch someone else made, or one an automated run made, which
 * that run's own destroy or the reaper releases.
 */
export async function checkRun(
  github: GitHub,
  repository: string,
  byHand: ByHand,
  log: (message: string) => void,
): Promise<number> {
  const { runId, attempt, actor } = byHand;
  const run = (await github.json(`/repos/${repository}/actions/runs/${runId}`)) as WorkflowRun | null;
  const from = text(run?.head_repository?.full_name);
  const event = text(run?.event);
  const described = JSON.stringify(
    `${text(run?.path) || "no workflow"} on ${text(run?.head_branch) || "no branch"} (${event || "no event"}) from ${from || "no repository"}`,
  );
  if (from !== repository)
    throw new ActionError(`run ${runId} is not one of this repository's own: it is ${described}`);
  if (event !== "workflow_dispatch")
    throw new ActionError(
      `run ${runId} was not started by hand: it is ${described}. Its own destroy releases its batches, or the reaper at their ttl`,
    );
  const status = text(run?.status);
  if (status !== "completed")
    throw new ActionError(
      `run ${runId} is ${JSON.stringify(status || "in no state")}, not completed: act on its batches once it completes`,
    );
  const latest = run?.run_attempt;
  if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < 1)
    throw new ActionError(`run ${runId} has no attempt number`);
  if (attempt > latest) throw new ActionError(`run ${runId} has ${latest} attempt(s), not ${attempt}`);
  const made = (await github.json(
    `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`,
  )) as WorkflowRun | null;
  const by = text(made?.triggering_actor?.login);
  // By hand means by a person: an attempt an app or a bot started is no one's to destroy by hand.
  if (text(made?.triggering_actor?.type) !== "User")
    throw new ActionError(
      `attempt ${attempt} of run ${runId} was started by ${JSON.stringify(by || "nobody named")}, not a person: no one may act on its batches by hand`,
    );
  if (!by || by !== actor)
    throw new ActionError(
      `attempt ${attempt} of run ${runId} was started by ${JSON.stringify(by || "nobody named")}, not by ${JSON.stringify(actor)}: only they may act on its batches by hand`,
    );
  log(`e2e-test-stack: run ${runId} is ${described}; attempt ${attempt} was started by ${by}, as this job was`);
  return latest;
}
