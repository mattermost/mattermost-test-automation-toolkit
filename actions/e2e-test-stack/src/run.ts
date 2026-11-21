// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { inspect, types } from "node:util";
import type { Env } from "../../shared/src/github.ts";

export type { Env };

/** One action: reads its inputs from env, writes its outputs and summary, and throws to fail. */
export type Action = (env: Env) => Promise<void>;

/** Every action the bundle runs, by the name its action.yml passes to run.sh. */
export const ACTIONS: Readonly<Record<string, Action>> = {};

/** A failure an action raises on purpose, with a message for the person reading the run; it is reported without a stack. */
export class ActionError extends Error {}
ActionError.prototype.name = "ActionError";

/** Runs the action named, or refuses a name the bundle does not have. */
export async function run(name: string | undefined, env: Env, actions: Readonly<Record<string, Action>> = ACTIONS) {
  const action = name !== undefined && Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!action) {
    const known = Object.keys(actions);
    throw new ActionError(
      `no action ${JSON.stringify(name ?? "")}; the bundle runs ${known.length ? known.join(", ") : "none"}`,
    );
  }
  await action(env);
}

/** Escapes text for a workflow command, as @actions/core does, so a line break cannot start another command. */
export const commandText = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** How deep a cause chain, and errors nested in an AggregateError, are followed. */
const MAX_DEPTH = 5;
/** How many of an AggregateError's errors are listed. */
const MAX_ERRORS = 5;
/** How long a thrown value that is not an error may be when written out; enough to show what it is. */
const MAX_OBJECT_TEXT = 300;

/** Whether a value is an error, one from another realm (a vm context, a worker) included. */
const isError = (e: unknown): e is Error => e instanceof Error || types.isNativeError(e);

/** An AggregateError's errors, from any realm; undefined for any other value. */
const aggregated = (e: Error): unknown[] | undefined => {
  const errors = (e as { errors?: unknown }).errors;
  return e.name === "AggregateError" && Array.isArray(errors) ? errors : undefined;
};

/** A value that is not an error, shallow and short. */
function written(e: unknown): string {
  if (typeof e !== "object" || e === null) return String(e);
  const text = inspect(e, { depth: 1, breakLength: Infinity });
  return text.length > MAX_OBJECT_TEXT ? `${text.slice(0, MAX_OBJECT_TEXT)}…` : text;
}

/**
 * A thrown value as one line of text, never throwing: "Name: message" for an error, followed by its cause chain and,
 * for an AggregateError, its errors, each described the same way, to MAX_DEPTH levels in all.
 */
function describe(e: unknown, depth = 0): string {
  try {
    if (!isError(e)) return written(e);
    let text = e instanceof ActionError ? e.message : e.message ? `${e.name}: ${e.message}` : e.name;
    const errors = aggregated(e);
    if (errors?.length && depth < MAX_DEPTH) {
      const listed = errors.slice(0, MAX_ERRORS).map((inner) => describe(inner, depth + 1));
      const more = errors.length > MAX_ERRORS ? `; ${errors.length - MAX_ERRORS} more` : "";
      text += ` (${listed.join("; ")}${more})`;
    }
    if (e.cause !== undefined && depth < MAX_DEPTH) text += `; caused by ${describe(e.cause, depth + 1)}`;
    return text;
  } catch {
    return "a value that could not be read";
  }
}

/**
 * The lines that report a failure: an error annotation naming the action, with the error's cause chain, then, for an
 * error that is not an ActionError (a file read, the SDK, a bug), its stack frames, which point into dist/index.js.
 */
export function failureLines(e: unknown): string[] {
  try {
    return reportLines(e);
  } catch {
    // A thrown value whose getters throw still fails the step with an annotation.
    return ["::error::e2e-test-stack: failed with a value that could not be read"];
  }
}

function reportLines(e: unknown): string[] {
  const lines = [`::error::${commandText(`e2e-test-stack: ${describe(e)}`)}`];
  // Only the frames: the stack's first lines repeat the message, which is already in the annotation. The stack is
  // split on every line break the runner reads, a lone \r included, and each frame is escaped too. The runner reads a
  // legacy ##[command] anywhere in a plain line, so ##[ is broken up.
  if (!(e instanceof ActionError) && isError(e) && typeof e.stack === "string")
    lines.push(
      ...e.stack
        .split(/\r\n|\r|\n/)
        .filter((l) => /^\s+at /.test(l))
        .map((l) => commandText(l).replaceAll("##[", "## [")),
    );
  return lines;
}
