// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionError } from "./errors.ts";
import { boolean, credentialsKeyFrom, input, integer, list, matching, stackInputs } from "./inputs.ts";

const refused = (f: () => unknown, message: RegExp) =>
  assert.throws(f, (e: unknown) => e instanceof ActionError && message.test(e.message));

test("an input is read from its STACK_ variable, trimmed", () => {
  assert.equal(input({ STACK_CALLER_KEY: " mobile\n" }, "caller-key"), "mobile");
  assert.equal(input({}, "caller-key"), "");
});

test("the common inputs take their defaults", () => {
  assert.deepEqual(stackInputs({ STACK_CALLER_KEY: "mobile" }), {
    callerKey: "mobile",
    channel: "v1",
    project: "e2e-test-stack",
    region: "us-east-1",
  });
  assert.deepEqual(
    stackInputs({ STACK_CALLER_KEY: "tpp", STACK_CHANNEL: "edge", STACK_PROJECT: "other", STACK_REGION: "eu-west-1" }),
    { callerKey: "tpp", channel: "edge", project: "other", region: "eu-west-1" },
  );
});

test("the common inputs are refused when missing or malformed", () => {
  refused(() => stackInputs({}), /caller-key is required/);
  refused(() => stackInputs({ STACK_CALLER_KEY: "Mobile" }), /caller-key must be/);
  refused(() => stackInputs({ STACK_CALLER_KEY: "m", STACK_CHANNEL: "edge-v1" }), /channel must be v1 or edge/);
  refused(() => stackInputs({ STACK_CALLER_KEY: "m", STACK_PROJECT: "-x" }), /project must be/);
  refused(() => stackInputs({ STACK_CALLER_KEY: "m", STACK_REGION: "useast1" }), /region must be/);
});

test("numbers, booleans, patterns and lists are checked, naming the input", () => {
  assert.equal(integer("count", "3", 1), 3);
  assert.equal(integer("retries", "-5", -Infinity), -5);
  refused(() => integer("count", "0", 1), /^count must be 1 or more, got 0$/);
  refused(() => integer("count", "1.5", 1), /^count must be a whole number, got "1.5"$/);
  assert.equal(boolean("x", ""), undefined);
  assert.equal(boolean("x", "false"), false);
  refused(() => boolean("x", "yes"), /^x must be "true" or "false", got "yes"$/);
  assert.equal(matching("os", "", /^a$/, "a"), undefined);
  refused(() => matching("os", "b", /^a$/, "an a"), /^os must be an a, got "b"$/);
  assert.deepEqual(list(" minio, keycloak,\nopenldap,, "), ["minio", "keycloak", "openldap"]);
});

test("the credentials key must be 32 bytes of standard base64, and is never quoted", () => {
  assert.deepEqual(credentialsKeyFrom(Buffer.alloc(32, 7).toString("base64")), new Uint8Array(32).fill(7));
  refused(() => credentialsKeyFrom(""), /credentials-key is required/);
  for (const bad of [Buffer.alloc(31).toString("base64"), "not base64!", Buffer.alloc(32).toString("base64url")])
    assert.throws(
      () => credentialsKeyFrom(bad),
      (e: unknown) => e instanceof ActionError && /32 bytes/.test(e.message) && !e.message.includes(bad),
    );
});
