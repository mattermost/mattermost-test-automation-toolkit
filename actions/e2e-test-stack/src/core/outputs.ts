// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redact } from "./redact.ts";

/** Escapes text for a workflow command, as @actions/core does, so a line break cannot start another command. */
export const commandText = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Appends outputs to GITHUB_OUTPUT, each in the delimited form so any value is safe; nothing without a path. */
export function writeOutputs(path: string | undefined, outputs: Readonly<Record<string, string | undefined>>): void {
  if (!path) return;
  let text = "";
  for (const [k, v] of Object.entries(outputs)) {
    if (v === undefined) continue;
    const delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${k}<<${delimiter}\n${v}\n${delimiter}\n`;
  }
  if (text) appendFileSync(path, text);
}

/** Appends lines to the job summary with ARNs and account ids taken out; nothing without a path or lines. */
export function appendSummary(path: string | undefined, lines: readonly string[]): void {
  if (path && lines.length) appendFileSync(path, redact(lines.join("\n")) + "\n");
}

/** Writes a file, creating its directory, and returns its absolute path. */
export function writeFile(path: string, content: string | Uint8Array): string {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Text for a Markdown table cell: pipes escaped, line breaks as spaces. */
export const cell = (s: string | number | null | undefined): string =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, " ");

/** Registers secrets with the runner, which then shows each as *** in the job log. */
export interface Masker {
  /** Masks a value, and its form inside a JSON string when that differs; an empty value or one already masked is skipped. */
  mask(value: string | undefined): void;
  /** Every value masked so far. */
  readonly masked: ReadonlySet<string>;
}

/** The shortest line, trimmed, of a multi-line value that is masked on its own. */
export const MIN_LINE_MASK = 8;

/** A masker that writes each ::add-mask:: command through log. */
export function masker(log: (message: string) => void): Masker {
  const masked = new Set<string>();
  const add = (value: string): void => {
    if (masked.has(value)) return;
    masked.add(value);
    log(`::add-mask::${commandText(value)}`);
  };
  // The value, and its form inside a JSON string when that differs.
  const addWithQuoted = (value: string): void => {
    add(value);
    const quoted = JSON.stringify(value).slice(1, -1);
    if (quoted !== value) add(quoted);
  };
  return {
    masked,
    mask(value) {
      if (typeof value !== "string" || !value) return;
      addWithQuoted(value);
      // The runner masks log output line by line, so each line of a multi-line value is masked on its own too, trimmed.
      // A line shorter than MIN_LINE_MASK is left: masking it would hide that text everywhere in the log.
      if (/[\r\n]/.test(value))
        for (const line of value.split(/\r\n|\r|\n/)) {
          const trimmed = line.trim();
          if (trimmed.length >= MIN_LINE_MASK) addWithQuoted(trimmed);
        }
    },
  };
}
