// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { posix } from "node:path";
import type { FetchImpl } from "../../shared/src/github.ts";
import { listZipEntries, readZipEntry } from "../../shared/src/zip.ts";
import type { ZipEntry } from "../../shared/src/zip.ts";
import { hasLaneTagConflict, OS_GROUPS } from "./ci-logs.ts";
import { EVIDENCE_LIMITS, evidenceFor, mergeEvidence, parseImageBuffer } from "./evidence.ts";
import { redact } from "./findings.ts";
import type { Evidence, EvidenceImage, Finding } from "./types.ts";

interface GhArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired?: boolean;
}

export interface SkimmedArtifacts {
  evidence: Evidence[];
  serviceLogs: string;
  artifactsScanned: string[];
}

const OWN_ARTIFACT_RE = /^e2e-triage-(?:findings|verdict|rerun)-/i;
const IMAGE_EXT_RE = /\.(png|jpe?g)$/i;
const SERVICE_LOG_RE =
  /(?:^|\/)(?:mattermost|nginx|postgres|elasticsearch|opensearch|keycloak|openldap|minio|inbucket|calls[^/]*|electron[^/]*|detox[^/]*|maestro[^/]*)\.log$|(?:^|\/)error-context\.md$/i;
const HIGH_SIGNAL_LOG_RE =
  /\b(?:ERR|ERROR|FATAL|PANIC|WARN|CRIT)\b|"level"\s*:\s*"(?:error|fatal|panic)"|\b50[0-4]\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Unhandled|uncaught|Crash|segmentation fault|Traceback/i;

const MAX_LOG_ENTRY_BYTES = 2_000_000;
const MAX_NESTED_ZIP_BYTES = 5_000_000;
const SERVICE_LOGS_MAX_CHARS = 2500;
export const MAX_SCAN_IMAGE_BYTES = 20_000_000;
export const MAX_SCAN_IMAGES = 24;
const TEST_ID_RE = /(?:^|[^a-z0-9])(mm-t\d+)(?!\d)/gi;

interface ScanBudget {
  imageBytes: number;
  images: number;
  warned?: boolean;
}

function normalizeZipPath(p: string): string {
  return posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function artifactTokens(reportName: string | null, lane: string | null): string[] {
  const raw = [reportName ?? "", lane ?? ""]
    .flatMap((s) => String(s).split(/[,\s]+/))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
  return [...new Set(raw)];
}

function workerIdsFromFindings(findings: Finding[]): string[] {
  const ids = new Set<string>();
  for (const f of findings) {
    const r = String(f.report_name ?? "");
    const m = /(?:^|[-_/])(\d+)(?:$|[-_/])/.exec(r);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function hasLaneConflict(artifactName: string, reportName: string | null, lane: string | null): boolean {
  const laneStr = [reportName ?? "", lane ?? ""].join(" ").toLowerCase();
  const artStr = artifactName.toLowerCase();
  if (hasLaneTagConflict(laneStr, artStr)) return true;
  if (/^e2e-failure-/i.test(artStr) && reportName) {
    const repLower = reportName.toLowerCase();
    const myOs = OS_GROUPS.find((re) => re.test(laneStr));
    if (!artStr.includes(repLower) && !(myOs && myOs.test(artStr))) return true;
  }
  return false;
}

function scoreArtifact(
  name: string,
  tokens: string[],
  workerIds: string[],
  customPatterns: string[],
  reportName: string | null,
  lane: string | null,
): number {
  const lower = name.toLowerCase();
  if (OWN_ARTIFACT_RE.test(lower) || hasLaneConflict(name, reportName, lane)) return -1;
  let score = 0;
  for (const pat of customPatterns) {
    if (pat && lower.includes(pat.toLowerCase())) score += 80;
  }
  if (/^triage-evidence-/.test(lower)) score += 100;
  if (/^e2e-failure-/.test(lower)) score += 90;
  if (/--debug-/.test(lower)) score += 75;
  if (/^(?:maestro-)?(?:ios|android|ipad)-results-/.test(lower)) score += 60;
  for (const tok of tokens) {
    if (lower.includes(tok)) score += 30;
  }
  for (const wid of workerIds) {
    if (new RegExp(`(?:^|-)${wid}$`).test(lower)) score += 40;
  }
  return score;
}

function findingMatchScore(entryName: string, f: Finding): number {
  const lower = entryName.toLowerCase();
  let score = 0;
  const entryIds = [...lower.matchAll(TEST_ID_RE)].map((m) => m[1]);
  if (entryIds.length > 0) {
    const findingIds = [...`${f.full_title ?? ""} ${f.title}`.toLowerCase().matchAll(TEST_ID_RE)].map((m) => m[1]);
    if (!findingIds.some((id) => entryIds.includes(id))) return 0;
    score += 100;
  }
  const base = (String(f.file ?? "").split(/[\\/]/).pop() ?? "").toLowerCase();
  const stem = base.replace(/\.(?:spec|test|e2e)\.[^.]+$|\.[^.]+$/, "");
  if (base.length >= 5 && lower.includes(base)) score += 60;
  else if (stem.length >= 5 && lower.includes(stem)) score += 40;
  const words = String(f.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length >= 2) {
    const hits = words.filter((w) => lower.includes(w)).length;
    if (hits >= Math.min(3, words.length)) score += hits * 10;
  }
  return score;
}

function serviceLogPriority(nameOrLine: string): number {
  const base = /^\[([^\]]+)\]/.exec(nameOrLine)?.[1] ?? nameOrLine.split(/[\\/]/).pop() ?? nameOrLine;
  if (/^mattermost\.log$/i.test(base)) return 0;
  if (/^(?:error-context\.md|(?:calls|electron|detox|maestro)[^/]*\.log)$/i.test(base)) return 1;
  if (/^(?:postgres|nginx)\.log$/i.test(base)) return 2;
  return 3;
}

function extractServiceLogLines(filename: string, content: string, secrets: string[] = []): string[] {
  const base = filename.split("/").pop() ?? filename;
  const lines = content.split(/\r?\n/);
  if (/error-context\.md$/i.test(base)) {
    const compact = lines
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(0, 25)
      .map((l) => `[${base}] ${redact(l, secrets).slice(0, 240)}`);
    return compact;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !HIGH_SIGNAL_LOG_RE.test(line)) continue;
    const clean = redact(line, secrets);
    const dedupe = clean.replace(/\d+/g, "#").slice(0, 140);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(`[${base}] ${clean.slice(0, 260)}`);
    if (out.length >= 12) break;
  }
  return out;
}

function inspectZipArchive({
  zip,
  artifactName,
  findings,
  warn,
  serviceLines,
  evidence,
  structuredEvidence,
  secrets = [],
  budget = { imageBytes: 0, images: 0 },
  depth = 0,
}: {
  zip: Buffer;
  artifactName: string;
  findings: Finding[];
  warn: (m: string) => void;
  serviceLines: string[];
  evidence: Evidence[];
  structuredEvidence?: Evidence[];
  secrets?: string[];
  budget?: ScanBudget;
  depth?: number;
}): void {
  const entries = listZipEntries(zip);
  const byPath = new Map<string, ZipEntry>(entries.map((e) => [normalizeZipPath(e.name), e]));
  const matchedScreenshots = new Set<string>();
  const decodedImages = new Map<string, EvidenceImage | null>();
  const decodeImage = (entry: ZipEntry): EvidenceImage | null => {
    if (decodedImages.has(entry.name)) return decodedImages.get(entry.name) ?? null;
    if (budget.images >= MAX_SCAN_IMAGES || budget.imageBytes + entry.size > MAX_SCAN_IMAGE_BYTES) {
      if (!budget.warned) {
        budget.warned = true;
        warn(`artifact image scan budget reached (${budget.images} images, ${budget.imageBytes} bytes); skipping remaining images`);
      }
      return null;
    }
    try {
      const buf = readZipEntry(zip, entry, EVIDENCE_LIMITS.imageBytes);
      budget.images++;
      budget.imageBytes += buf.length;
      const img = parseImageBuffer(`${artifactName}/${entry.name}`, buf, warn);
      decodedImages.set(entry.name, img);
      return img;
    } catch (e) {
      warn(`artifact image ${artifactName}/${entry.name} skipped: ${String(e).slice(0, 120)}`);
      decodedImages.set(entry.name, null);
      return null;
    }
  };

  // 1. Structured evidence*.json manifests (e.g. mobile triage-evidence-*).
  for (const entry of entries) {
    if (!/(?:^|\/)evidence[^/]*\.json$/i.test(entry.name) || entry.size > MAX_LOG_ENTRY_BYTES) continue;
    try {
      const parsed = JSON.parse(readZipEntry(zip, entry, MAX_LOG_ENTRY_BYTES).toString("utf8")) as unknown;
      if (!Array.isArray(parsed)) continue;
      const baseDir = posix.dirname(normalizeZipPath(entry.name));
      for (const rawItem of parsed) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        if (typeof item.file !== "string" || typeof item.title !== "string") continue;
        const images: EvidenceImage[] = [];
        for (const rel of Array.isArray(item.images) ? item.images : []) {
          if (images.length >= EVIDENCE_LIMITS.imagesPerTest || typeof rel !== "string") break;
          const resolved = normalizeZipPath(baseDir === "." ? rel : posix.join(baseDir, rel));
          const target = byPath.get(resolved) ?? entries.find((e) => normalizeZipPath(e.name).endsWith(`/${rel.replace(/^\.\//, "")}`));
          if (!target) continue;
          const img = decodeImage(target);
          if (img) {
            images.push(img);
            matchedScreenshots.add(target.name);
          }
        }
        const notes = typeof item.notes === "string" ? item.notes.slice(0, EVIDENCE_LIMITS.notes) : "";
        if (notes || images.length) {
          const ev: Evidence = {
            file: item.file,
            title: item.title,
            full_title: typeof item.full_title === "string" ? item.full_title : null,
            notes,
            images,
          };
          evidence.push(ev);
          structuredEvidence?.push(ev);
        }
      }
    } catch (e) {
      warn(`artifact ${artifactName}/${entry.name} unreadable: ${String(e).slice(0, 120)}`);
    }
  }

  // 2. Service/server/app logs and Playwright error-context.md (prioritize mattermost.log and primary logs).
  const logEntries = entries
    .filter((entry) => SERVICE_LOG_RE.test(entry.name) && entry.size > 0 && entry.size <= MAX_LOG_ENTRY_BYTES)
    .sort((a, b) => serviceLogPriority(a.name) - serviceLogPriority(b.name));
  for (const entry of logEntries) {
    try {
      const text = readZipEntry(zip, entry, MAX_LOG_ENTRY_BYTES).toString("utf8");
      serviceLines.push(...extractServiceLogLines(entry.name, text, secrets));
    } catch (e) {
      warn(`artifact log ${artifactName}/${entry.name} skipped: ${String(e).slice(0, 120)}`);
    }
  }

  // 3. Failure screenshots matched to findings (plus numbered desktop fallback when <= 8 findings).
  const imageEntries = entries.filter((e) => IMAGE_EXT_RE.test(e.name) && !matchedScreenshots.has(e.name) && e.size > 0 && e.size <= EVIDENCE_LIMITS.imageBytes);
  const imagesPerFinding = new Map<number, EvidenceImage[]>();
  for (const imgEntry of imageEntries) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < findings.length; i++) {
      const s = findingMatchScore(imgEntry.name, findings[i]);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && (imagesPerFinding.get(bestIdx)?.length ?? 0) < EVIDENCE_LIMITS.imagesPerTest) {
      const img = decodeImage(imgEntry);
      if (img) (imagesPerFinding.get(bestIdx) ?? imagesPerFinding.set(bestIdx, []).get(bestIdx)!).push(img);
    }
  }

  // Desktop Electron numbered failure PNGs (e.g. e2e-failure-e2e-on-ubuntu-latest-.../001-test-failed-1.png)
  if (!imagesPerFinding.size && /^e2e-failure-/i.test(artifactName) && findings.length > 0 && findings.length <= 8) {
    const numbered = imageEntries.filter((e) => /(?:^|\/)\d+-test-failed-\d+\.(?:png|jpe?g)$/i.test(e.name)).slice(0, EVIDENCE_LIMITS.imagesPerTest);
    const sharedImgs: EvidenceImage[] = [];
    for (const imgEntry of numbered) {
      const img = decodeImage(imgEntry);
      if (img) sharedImgs.push(img);
    }
    if (sharedImgs.length) {
      for (let i = 0; i < findings.length; i++) imagesPerFinding.set(i, sharedImgs);
    }
  }

  for (const [idx, imgs] of imagesPerFinding) {
    const f = findings[idx];
    evidence.push({
      file: f.repo_path ?? f.file,
      title: f.title,
      full_title: f.full_title ?? null,
      notes: "",
      images: imgs,
    });
  }

  // 4. Nested Playwright blob-report/*.zip (one level deep).
  if (depth === 0) {
    for (const entry of entries) {
      if (!/blob-report\/[^/]+\.zip$/i.test(entry.name) || entry.size === 0 || entry.size > MAX_NESTED_ZIP_BYTES) continue;
      try {
        const inner = readZipEntry(zip, entry, MAX_NESTED_ZIP_BYTES);
        inspectZipArchive({ zip: inner, artifactName: `${artifactName}/${entry.name}`, findings, warn, serviceLines, evidence, structuredEvidence, secrets, budget, depth: 1 });
      } catch (e) {
        warn(`nested blob-report ${artifactName}/${entry.name} skipped: ${String(e).slice(0, 120)}`);
      }
    }
  }
}

async function readResponseCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const contentLength = Number(res.headers?.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= maxBytes ? buf : null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Lists and selectively skims GitHub Actions artifacts for screenshots, structured triage evidence,
 * and server/service error logs across mattermost, desktop, and mattermost-mobile.
 */
export async function skimRunArtifacts({
  fetchImpl,
  token,
  repository,
  runId,
  findings,
  reportName = null,
  lane = null,
  patterns = [],
  secrets = [],
  log = () => {},
  maxArtifacts = 8,
  maxZipBytes = 25_000_000,
  deadlineMs = 30_000,
}: {
  fetchImpl: FetchImpl;
  token: string;
  repository: string;
  runId: string;
  findings: Finding[];
  reportName?: string | null;
  lane?: string | null;
  patterns?: string[];
  secrets?: string[];
  log?: (message: string) => void;
  maxArtifacts?: number;
  maxZipBytes?: number;
  deadlineMs?: number;
}): Promise<SkimmedArtifacts> {
  const empty: SkimmedArtifacts = { evidence: [], serviceLogs: "", artifactsScanned: [] };
  if (!token || !repository || !runId || !findings.length) return empty;
  const deadline = Date.now() + deadlineMs;
  try {
    const all: GhArtifact[] = [];
    for (let page = 1; page <= 5; page++) {
      if (Date.now() >= deadline) break;
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "mattermost-e2e-triage" },
          signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        });
        if (!res.ok) {
          log(`artifacts list unavailable (${res.status})`);
          if (all.length === 0) return empty;
          break;
        }
        const data = (await res.json()) as { total_count?: number; artifacts?: GhArtifact[] };
        const rows = data.artifacts ?? [];
        all.push(...rows);
        if (!rows.length || all.length >= (data.total_count ?? 0)) break;
      } catch (e) {
        log(`artifacts list page ${page} failed: ${String(e).slice(0, 120)}`);
        if (all.length === 0) return empty;
        break;
      }
    }

    const tokens = artifactTokens(reportName, lane);
    const workerIds = workerIdsFromFindings(findings);
    const selected = all
      .filter((a) => !a.expired && a.size_in_bytes > 0 && a.size_in_bytes <= maxZipBytes)
      .map((a) => ({ artifact: a, score: scoreArtifact(a.name, tokens, workerIds, patterns, reportName, lane) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxArtifacts)
      .map((x) => x.artifact);

    if (!selected.length) return empty;

    const evidence: Evidence[] = [];
    const structuredEvidence: Evidence[] = [];
    const serviceLines: string[] = [];
    const artifactsScanned: string[] = [];
    const budget: ScanBudget = { imageBytes: 0, images: 0 };

    for (const art of selected) {
      if (Date.now() >= deadline) break;
      try {
        const res = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts/${art.id}/zip`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "mattermost-e2e-triage" },
          signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
        });
        if (!res.ok) {
          log(`artifact ${art.name} download skipped (${res.status})`);
          continue;
        }
        const zip = await readResponseCapped(res, maxZipBytes);
        if (!zip) {
          log(`artifact ${art.name} exceeded ${maxZipBytes} bytes; skipped`);
          continue;
        }
        const isTriageEvidence = /^triage-evidence-/i.test(art.name);
        inspectZipArchive({
          zip,
          artifactName: art.name,
          findings,
          warn: log,
          serviceLines,
          evidence,
          structuredEvidence: isTriageEvidence ? structuredEvidence : undefined,
          secrets,
          budget,
        });
        artifactsScanned.push(art.name);
        if (isTriageEvidence && findings.every((f) => evidenceFor(f, structuredEvidence) != null)) break;
      } catch (e) {
        log(`artifact ${art.name} skim skipped: ${String(e).slice(0, 120)}`);
      }
    }

    const orderedLogs = [...new Set(serviceLines)].sort((a, b) => serviceLogPriority(a) - serviceLogPriority(b));
    const serviceLogs = redact(orderedLogs.join("\n"), secrets).slice(0, SERVICE_LOGS_MAX_CHARS);
    return { evidence: mergeEvidence([], evidence), serviceLogs, artifactsScanned };
  } catch (e) {
    log(`artifact skimming unavailable for run ${runId}: ${String(e).slice(0, 120)}`);
    return empty;
  }
}
