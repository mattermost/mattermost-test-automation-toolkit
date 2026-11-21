// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Action, ActionError, type Env, failureLines, run } from "./run.ts";

test("runs the action named, with the environment it is given", async () => {
  const seen: Env[] = [];
  const actions: Record<string, Action> = { create: async (env) => void seen.push(env) };
  await run("create", { STACK_BATCH: "ios" }, actions);
  assert.deepEqual(seen, [{ STACK_BATCH: "ios" }]);
});

test("refuses a name the bundle does not have, and names the ones it has", async () => {
  const actions: Record<string, Action> = { create: async () => {}, open: async () => {} };
  await assert.rejects(run("delete", {}, actions), {
    name: "ActionError",
    message: /^no action "delete"; the bundle runs create, open$/,
  });
  await assert.rejects(run(undefined, {}, actions), /no action ""; the bundle runs create, open/);
});

test("refuses a name inherited from Object, not only one that is missing", async () => {
  await assert.rejects(run("toString", {}, {}), /no action "toString"; the bundle runs none/);
  await assert.rejects(run("__proto__", {}, {}), /no action "__proto__"/);
});

test("an ActionError is one error annotation, % and line breaks escaped so no other command can start", () => {
  assert.deepEqual(failureLines(new ActionError("50% done\n::add-mask::x\r")), [
    "::error::e2e-test-stack: 50%25 done%0A::add-mask::x%0D",
  ]);
});

test("any other error is named for the action with its class, and followed by its stack frames only", () => {
  const e = new TypeError("boom\n::warning::x");
  e.stack = "TypeError: boom\n::warning::x\n    at f (dist/index.js:1:2)\n    at g (dist/index.js:3:4)";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: TypeError: boom%0A::warning::x",
    "    at f (dist/index.js:1:2)",
    "    at g (dist/index.js:3:4)",
  ]);
  assert.deepEqual(failureLines("plain"), ["::error::e2e-test-stack: plain"]);
});

test("a message that smuggles a frame-shaped line behind a lone \\r cannot start a command", () => {
  const e = new Error("boom");
  e.stack = "Error: boom\n    at x\r::stop-commands::t\n    at f (dist/index.js:1:2)";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: Error: boom",
    "    at x",
    "    at f (dist/index.js:1:2)",
  ]);
});

test("an error's cause chain is in the annotation, so a fetch or SDK failure shows its real reason", () => {
  const e = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.1:443") });
  e.stack = "TypeError: fetch failed";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: TypeError: fetch failed; caused by Error: connect ECONNREFUSED 10.0.0.1:443",
  ]);
});

test("a value that cannot be turned into text is still reported, and never throws", () => {
  const odd = Object.create(null) as object;
  assert.deepEqual(failureLines(odd), ["::error::e2e-test-stack: [Object: null prototype] {}"]);
  assert.equal(new ActionError("x").name, "ActionError");
  assert.ok(!Object.hasOwn(new ActionError("x"), "name"), "name is the prototype's, not each instance's");
});

test("a thrown value whose getters throw is still reported as one annotation", () => {
  const hostile = new Proxy(new Error("x"), {
    get() {
      throw new Error("getter");
    },
  });
  assert.deepEqual(failureLines(hostile), ["::error::e2e-test-stack: failed with a value that could not be read"]);
});

test("an ActionError keeps its cause chain, so wrapping an SDK failure does not hide its reason", () => {
  const e = new ActionError("could not invoke the create function", { cause: new Error("AccessDenied") });
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: could not invoke the create function; caused by Error: AccessDenied",
  ]);
});

test("an error from another realm is still an error: its class, cause and frames are reported", async () => {
  const { runInNewContext } = await import("node:vm");
  const e = runInNewContext(
    'const e = new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); e',
  ) as Error;
  e.stack = "TypeError: fetch failed\n    at f (dist/index.js:1:2)";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: TypeError: fetch failed; caused by Error: ECONNREFUSED",
    "    at f (dist/index.js:1:2)",
  ]);
});

test("an AggregateError lists its errors, and a plain thrown object shows its contents", () => {
  const e = new TypeError("fetch failed", {
    cause: new AggregateError([
      new Error("connect ECONNREFUSED ::1:443"),
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
    ]),
  });
  e.stack = "TypeError: fetch failed";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: TypeError: fetch failed; caused by AggregateError (Error: connect ECONNREFUSED ::1:443; Error: connect ECONNREFUSED 127.0.0.1:443)",
  ]);
  assert.deepEqual(failureLines({ message: "quota exceeded", code: "X" }), [
    "::error::e2e-test-stack: { message: 'quota exceeded', code: 'X' }",
  ]);
});

test("an object that only claims to be an Error is not treated as one", () => {
  const fake = { [Symbol.toStringTag]: "Error", code: "E" };
  assert.deepEqual(failureLines(fake), ["::error::e2e-test-stack: { code: 'E', Symbol(Symbol.toStringTag): 'Error' }"]);
});

test("an AggregateError is bounded: self-reference, nesting and long lists end, and its errors keep their causes", () => {
  const self = new AggregateError([], "loop");
  self.errors.push(self);
  assert.ok(failureLines(self)[0].length < 2000, "a self-referencing AggregateError ends");
  const many = new AggregateError(Array.from({ length: 8 }, (_, i) => new Error(`e${i}`)));
  assert.match(failureLines(many)[0], /\(Error: e0; Error: e1; Error: e2; Error: e3; Error: e4; 3 more\)/);
  const member = new AggregateError([new Error("connect failed", { cause: new Error("ECONNREFUSED") })]);
  assert.match(failureLines(member)[0], /Error: connect failed; caused by Error: ECONNREFUSED/);
});

test("a large thrown object is shown shallowly and cut short", () => {
  const big = { payload: "x".repeat(1000), nested: { deeper: { deepest: 1 } } };
  const [line] = failureLines(big);
  assert.ok(line.length < 400, `the line is ${line.length} characters`);
  assert.match(line, /…$/);
});

test("an AggregateError from another realm lists its errors", async () => {
  const { runInNewContext } = await import("node:vm");
  const e = runInNewContext('new AggregateError([new Error("a"), new Error("b")])') as Error;
  assert.deepEqual(failureLines(e).slice(0, 1), ["::error::e2e-test-stack: AggregateError (Error: a; Error: b)"]);
});

test("ARNs and account ids are taken out of the annotation, its causes and its frames", () => {
  const e = new Error("refused", {
    cause: new Error("User: arn:aws:sts::123456789012:assumed-role/ci/x is not authorized in 123456789012"),
  });
  e.stack = "Error: refused\n    at f (arn:aws:lambda:us-east-1:123456789012:function:x)";
  assert.deepEqual(failureLines(e), [
    "::error::e2e-test-stack: Error: refused; caused by Error: User: [arn] is not authorized in [account]",
    "    at f ([arn])",
  ]);
});
