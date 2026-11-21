// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { failureLines, run } from "./run.ts";

/** Whether a failure was reported; it decides the exit code, whatever settles after it. */
let failed = false;

/**
 * Exits once stdout and stderr have flushed. Pipes are asynchronous on macOS, so exiting straight after a write could
 * drop it; waiting for a pending timer or socket instead could hold the step open until the job times out. A write
 * that fails (the runner closed the pipe) still exits.
 */
function exit(code: number): void {
  let pending = 2;
  const done = () => {
    // A failure reported while a success was flushing still fails the step.
    if (--pending === 0) process.exit(failed ? 1 : code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

/** Reports a failure as an escaped error annotation and exits 1. */
function fail(e: unknown): void {
  // The first failure is the one reported; a later one (a stray rejection while exiting) adds nothing.
  if (failed) return;
  failed = true;
  try {
    for (const line of failureLines(e)) console.error(line);
  } finally {
    exit(1);
  }
}

// A closed pipe must not crash the process with an unescaped stack.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
// A failure outside the action's promise (a rejection nothing awaited, an emitter's error) is reported the same way,
// not by Node's default handler, which prints it unescaped.
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

run(process.argv[2], process.env).then(() => exit(0), fail);
