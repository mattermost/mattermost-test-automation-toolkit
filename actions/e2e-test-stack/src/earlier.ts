// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GitHub } from "./github.ts";
import { BATCH_ID } from "./inputs.ts";
import { readZipMember, ZipError } from "./zip.ts";

/** The member a create's account is recorded in, beside its response. */
export const ACCOUNT_MEMBER = "e2e-test-stack-account";
/** The largest artifact archive downloaded, the largest response read from it, and the largest account. */
export const MAX_ARTIFACT_BYTES = 64 << 20;
export const MAX_MEMBER_BYTES = 16 << 20;
export const MAX_ACCOUNT_BYTES = 64;
/** Artifacts listed per page, and the most pages read. */
const PER_PAGE = 100;
const PAGES = 10;

export interface EarlierInputs {
  repository: string;
  runId: string;
  artifactName: string;
  /** The artifact's member that holds the create response. */
  responseMember: string;
  /** Where the response is written. */
  responsePath: string;
  /** Where the recorded account is written, when the artifact holds one; absent reads none. */
  accountPath?: string;
}

/** What the action reads of a workflow run's artifact. */
interface Artifact {
  id?: number;
  name?: string;
  expired?: boolean;
  created_at?: string;
}

/**
 * Finds the run's artifact of the given name and, when there is one, writes the create response it holds to
 * responsePath, and the recorded account to accountPath when both are there. Returns the response's path, or
 * undefined when the run has no such artifact or its response names no batch, as a refused create's does. An artifact
 * that exists but cannot be downloaded or read, holds no response member, or holds one that does not parse, fails: an
 * earlier attempt's batch is never lost silently. A recorded account that cannot be read is skipped with a warning.
 * Any file already at responsePath or accountPath is removed first, so a later step never reads a stale one.
 */
export async function earlierResponse(
  inputs: EarlierInputs,
  github: GitHub,
  log: (message: string) => void,
): Promise<string | undefined> {
  rmSync(resolve(inputs.responsePath), { force: true });
  if (inputs.accountPath) rmSync(resolve(inputs.accountPath), { force: true });
  const name = encodeURIComponent(inputs.artifactName);
  const found: Artifact[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const got = (await github.json(
      `/repos/${inputs.repository}/actions/runs/${inputs.runId}/artifacts?name=${name}&per_page=${PER_PAGE}&page=${page}`,
    )) as { total_count?: number; artifacts?: Artifact[] };
    const artifacts = Array.isArray(got?.artifacts) ? got.artifacts : [];
    found.push(...artifacts.filter((a) => a.name === inputs.artifactName));
    if (artifacts.length < PER_PAGE) break;
  }
  if (!found.length) {
    log(`e2e-test-stack: run ${inputs.runId} has no artifact ${inputs.artifactName}`);
    return undefined;
  }
  // The newest, should a run hold more than one of the name.
  const artifact = found.sort(
    (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || (b.id ?? 0) - (a.id ?? 0),
  )[0];
  const what = `run ${inputs.runId}'s artifact ${inputs.artifactName}`;
  if (artifact.expired)
    throw new Error(
      `e2e-test-stack: ${what} has expired, so the batch it names cannot be read; not going on without it`,
    );
  if (!Number.isSafeInteger(artifact.id)) throw new Error(`e2e-test-stack: ${what} has no id`);

  let zip: Buffer;
  try {
    zip = await github.download(`/repos/${inputs.repository}/actions/artifacts/${artifact.id}/zip`, MAX_ARTIFACT_BYTES);
  } catch (e) {
    throw new Error(
      `e2e-test-stack: ${what} exists but could not be downloaded: ${(e as Error).message.replace(/^e2e-test-stack: /, "")}`,
      { cause: e },
    );
  }
  const member = inputs.responseMember;
  let response: Buffer | undefined;
  try {
    response = readZipMember(zip, member, MAX_MEMBER_BYTES);
  } catch (e) {
    if (!(e instanceof ZipError)) throw e;
    throw new Error(`e2e-test-stack: ${what} could not be read: ${e.message}`, { cause: e });
  }
  if (!response) throw new Error(`e2e-test-stack: ${what} holds no ${member}`);
  // An empty reply, or one with no batch: a create that was refused, or failed before making a batch.
  let batchId: unknown;
  if (response.length) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.toString("utf8"));
    } catch {
      throw new Error(
        `e2e-test-stack: ${what} holds a ${member} that is not JSON, so the batch it may name is unknown`,
      );
    }
    batchId = (parsed as { batch_id?: unknown } | null)?.batch_id;
    if (batchId !== undefined && batchId !== null && batchId !== "" && typeof batchId !== "string")
      throw new Error(`e2e-test-stack: ${what} holds a ${member} whose batch_id is not a string`);
  }
  if (typeof batchId !== "string" || !batchId) {
    log(`::warning::${what}: the earlier attempt's response names no batch, so there is none to release`);
    return undefined;
  }

  const path = resolve(inputs.responsePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, response);
  if (inputs.accountPath) {
    let account: Buffer | undefined;
    let reason = "it holds no " + ACCOUNT_MEMBER;
    try {
      account = readZipMember(zip, ACCOUNT_MEMBER, MAX_ACCOUNT_BYTES);
    } catch (e) {
      if (!(e instanceof ZipError)) throw e;
      reason = e.message;
    }
    if (account) {
      const accountPath = resolve(inputs.accountPath);
      mkdirSync(dirname(accountPath), { recursive: true });
      writeFileSync(accountPath, account);
    } else log(`::warning::${what}: no recorded account was written to account-path: ${reason}`);
  }
  log(`e2e-test-stack: ${what} holds ${BATCH_ID.test(batchId) ? `batch ${batchId}` : "a create response"}`);
  return path;
}
