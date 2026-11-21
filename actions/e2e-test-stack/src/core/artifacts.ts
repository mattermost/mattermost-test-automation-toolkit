// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { ActionError } from "./errors.ts";
import type { GitHub } from "./github.ts";
import { errorText } from "./redact.ts";
import { RESPONSE_FILE } from "./response.ts";
import { readZipMember, ZipError } from "./zip.ts";

/** The largest artifact archive downloaded, and the largest create response read from it. */
export const MAX_ARTIFACT_BYTES = 64 << 20;
export const MAX_RESPONSE_BYTES = 16 << 20;
/** Artifacts listed per page, and the most pages read. */
const PER_PAGE = 100;
const PAGES = 10;

/** The artifact create uploads as the newest response for a batch, replacing an earlier attempt's. */
export const createArtifact = (batch: string): string => `e2e-test-stack-create-${batch}`;

/** A workflow run's artifact, as the actions read it. */
export interface Artifact {
  id: number;
  name: string;
  createdAt: string;
  expired: boolean;
}

/** Where a run's artifacts are: the repository, owner/name, and the run's id. */
export interface RunRef {
  repository: string;
  runId: string;
}

/**
 * The run's newest artifact named exactly name, across its attempts, by creation time and then id; undefined when it
 * has none. Every page of the listing is read, up to PAGES.
 */
export async function newestArtifact(github: GitHub, run: RunRef, name: string): Promise<Artifact | undefined> {
  const found: Artifact[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const got = (await github.json(
      `/repos/${run.repository}/actions/runs/${run.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=${PER_PAGE}&page=${page}`,
    )) as { artifacts?: unknown } | null;
    const listed: unknown[] = Array.isArray(got?.artifacts) ? got.artifacts : [];
    for (const a of listed as { id?: unknown; name?: unknown; created_at?: unknown; expired?: unknown }[])
      if (a?.name === name && Number.isSafeInteger(a.id))
        found.push({
          id: a.id as number,
          name,
          createdAt: typeof a.created_at === "string" ? a.created_at : "",
          expired: a.expired === true,
        });
    if (listed.length < PER_PAGE) break;
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
}

/** A create response read from its artifact. */
export interface CreateArtifact {
  artifact: Artifact;
  /** The raw response, as create wrote it. */
  response: Buffer;
}

/**
 * Downloads the run's newest artifact for batch and reads its create response; undefined when the run has no such
 * artifact. One that has expired, cannot be downloaded or read, or holds no response fails, naming it.
 */
export async function createResponse(github: GitHub, run: RunRef, batch: string): Promise<CreateArtifact | undefined> {
  const name = createArtifact(batch);
  const artifact = await newestArtifact(github, run, name);
  if (!artifact) return undefined;
  const what = `this run's artifact ${name}`;
  if (artifact.expired) throw new ActionError(`${what} has expired, so the batch it names cannot be read`);
  let archive: Buffer;
  try {
    archive = await github.download(
      `/repos/${run.repository}/actions/artifacts/${artifact.id}/zip`,
      MAX_ARTIFACT_BYTES,
    );
  } catch (e) {
    throw new ActionError(`${what} exists but could not be downloaded: ${errorText(e)}`, { cause: e });
  }
  let response: Buffer | undefined;
  try {
    response = readZipMember(archive, RESPONSE_FILE, MAX_RESPONSE_BYTES);
  } catch (e) {
    if (!(e instanceof ZipError)) throw e;
    throw new ActionError(`${what} could not be read: ${e.message}`, { cause: e });
  }
  if (!response) throw new ActionError(`${what} holds no ${RESPONSE_FILE}`);
  return { artifact, response };
}
