"use strict";

// src/run.ts
var import_node_util = require("util");
var ACTIONS = {};
var ActionError = class extends Error {
};
ActionError.prototype.name = "ActionError";
async function run(name, env, actions = ACTIONS) {
  const action = name !== void 0 && Object.hasOwn(actions, name) ? actions[name] : void 0;
  if (!action) {
    const known = Object.keys(actions);
    throw new ActionError(
      `no action ${JSON.stringify(name ?? "")}; the bundle runs ${known.length ? known.join(", ") : "none"}`
    );
  }
  await action(env);
}
var commandText = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
var MAX_DEPTH = 5;
var MAX_ERRORS = 5;
var MAX_OBJECT_TEXT = 300;
var isError = (e) => e instanceof Error || import_node_util.types.isNativeError(e);
var aggregated = (e) => {
  const errors = e.errors;
  return e.name === "AggregateError" && Array.isArray(errors) ? errors : void 0;
};
function written(e) {
  if (typeof e !== "object" || e === null) return String(e);
  const text = (0, import_node_util.inspect)(e, { depth: 1, breakLength: Infinity });
  return text.length > MAX_OBJECT_TEXT ? `${text.slice(0, MAX_OBJECT_TEXT)}\u2026` : text;
}
function describe(e, depth = 0) {
  try {
    if (!isError(e)) return written(e);
    let text = e instanceof ActionError ? e.message : e.message ? `${e.name}: ${e.message}` : e.name;
    const errors = aggregated(e);
    if (errors?.length && depth < MAX_DEPTH) {
      const listed = errors.slice(0, MAX_ERRORS).map((inner) => describe(inner, depth + 1));
      const more = errors.length > MAX_ERRORS ? `; ${errors.length - MAX_ERRORS} more` : "";
      text += ` (${listed.join("; ")}${more})`;
    }
    if (e.cause !== void 0 && depth < MAX_DEPTH) text += `; caused by ${describe(e.cause, depth + 1)}`;
    return text;
  } catch {
    return "a value that could not be read";
  }
}
function failureLines(e) {
  try {
    return reportLines(e);
  } catch {
    return ["::error::e2e-test-stack: failed with a value that could not be read"];
  }
}
function reportLines(e) {
  const lines = [`::error::${commandText(`e2e-test-stack: ${describe(e)}`)}`];
  if (!(e instanceof ActionError) && isError(e) && typeof e.stack === "string")
    lines.push(
      ...e.stack.split(/\r\n|\r|\n/).filter((l) => /^\s+at /.test(l)).map(commandText)
    );
  return lines;
}

// src/index.ts
var failed = false;
function exit(code) {
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(failed ? 1 : code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}
function fail(e) {
  if (failed) return;
  failed = true;
  try {
    for (const line of failureLines(e)) console.error(line);
  } finally {
    exit(1);
  }
}
process.stdout.on("error", () => {
});
process.stderr.on("error", () => {
});
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
run(process.argv[2], process.env).then(() => exit(0), fail);
