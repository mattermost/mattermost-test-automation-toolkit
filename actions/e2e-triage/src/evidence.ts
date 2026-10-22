// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Evidence, EvidenceImage } from "./types.ts";

const EVIDENCE_LIMITS = { files: 50, entries: 200, imagesPerTest: 2, imageBytes: 3_500_000, notes: 1500 };
const IMAGE_TYPES = [
  { media_type: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { media_type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
];

/**
 * Screenshots and notes the test run recorded: JSON files of
 * `{file, title, full_title?, notes?, images?: [path]}`. They come from the PR's
 * own CI, so only PNG/JPEG files inside `dir` and within limits are read.
 */
export function loadEvidence(dir: string, warn: (message: string) => void = () => {}): Evidence[] {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    warn(`evidence directory ${JSON.stringify(dir)} does not exist; no producer evidence`);
    return [];
  }
  // The PR's CI wrote this directory: a link in it may dangle, or point outside it, and neither is evidence.
  const insideRoot = (path: string): boolean => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  const jsonFiles: string[] = [];
  const walk = (d: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch (e) {
      warn(`evidence directory ${JSON.stringify(relative(root, d))} cannot be read: ${String(e).slice(0, 120)}`);
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        warn(`evidence entry ${JSON.stringify(relative(root, full))} cannot be read (a dangling link?); skipped`);
        continue;
      }
      // Only directories and JSON entries are read here; images are checked where they are read.
      const isEvidenceJson = st.isFile() && name.endsWith(".json");
      if (!st.isDirectory() && !isEvidenceJson) continue;
      if (!insideRoot(realpathSync(full))) {
        warn(`evidence entry ${JSON.stringify(relative(root, full))} links outside the evidence directory; skipped`);
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (jsonFiles.length < EVIDENCE_LIMITS.files) jsonFiles.push(full);
    }
  };
  walk(root, 0);
  const out: Evidence[] = [];
  for (const file of jsonFiles) {
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      warn(`evidence file ${relative(root, file)} is not JSON: ${String(e).slice(0, 120)}`);
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const list: unknown[] = entries;
    for (const e of list) {
      if (out.length >= EVIDENCE_LIMITS.entries) return out;
      if (!e || typeof e !== "object") continue;
      // Fields of a JSON entry: each is checked before it is used.
      const entry = e as Record<string, unknown>;
      if (typeof entry.file !== "string" || typeof entry.title !== "string") continue;
      const images: EvidenceImage[] = [];
      const refs: unknown[] = Array.isArray(entry.images) ? entry.images : [];
      for (const rel of refs) {
        if (images.length >= EVIDENCE_LIMITS.imagesPerTest || typeof rel !== "string") break;
        let path: string;
        try {
          path = realpathSync(resolve(dirname(file), rel));
        } catch {
          warn(`evidence image ${JSON.stringify(rel)} not found`);
          continue;
        }
        if (relative(root, path).startsWith("..")) {
          warn(`evidence image ${JSON.stringify(rel)} is outside the evidence directory; skipped`);
          continue;
        }
        // A path that is not a file (a directory, say) or cannot be read is unusable evidence: warned and skipped, as the others are.
        let bytes: Buffer;
        try {
          if (!statSync(path).isFile()) {
            warn(`evidence image ${JSON.stringify(rel)} is not a file, so it is not a PNG or JPEG; skipped`);
            continue;
          }
          bytes = readFileSync(path);
        } catch (e) {
          warn(`evidence image ${JSON.stringify(rel)} cannot be read (${String(e).slice(0, 120)}); skipped`);
          continue;
        }
        const type = IMAGE_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b));
        if (!type || bytes.length > EVIDENCE_LIMITS.imageBytes) {
          warn(`evidence image ${JSON.stringify(rel)} is not a PNG or JPEG within ${EVIDENCE_LIMITS.imageBytes} bytes; skipped`);
          continue;
        }
        images.push({ name: relative(root, path), media_type: type.media_type, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      const notes = typeof entry.notes === "string" ? entry.notes.slice(0, EVIDENCE_LIMITS.notes) : "";
      if (notes || images.length)
        out.push({ file: entry.file, title: entry.title, full_title: typeof entry.full_title === "string" ? entry.full_title : null, notes, images });
    }
  }
  return out;
}

/** The producer evidence recorded for this test, matched on title, qualified title and spec path. */
export function evidenceFor(finding: { file: string; title: string; full_title?: string | null; repo_path?: string | null }, evidence: Evidence[]): Evidence | null {
  const path = finding.repo_path ?? finding.file;
  // Producers and TSIO may root paths differently, so a tail of at least one
  // directory matches; a bare file name could be any spec of that name.
  const tail = (long: string, short: string): boolean => short.includes("/") && long.endsWith(`/${short}`);
  return evidence.find((e) =>
    e.title === finding.title &&
    (e.full_title == null || finding.full_title == null || e.full_title === finding.full_title) &&
    (path === e.file || tail(path, e.file) || tail(e.file, path)),
  ) ?? null;
}
