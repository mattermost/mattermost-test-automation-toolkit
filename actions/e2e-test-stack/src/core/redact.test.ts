// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, handlerError, redact } from "./redact.ts";

test("ARNs and account ids are replaced with placeholders Markdown shows", () => {
  assert.equal(
    redact("User: arn:aws:sts::123456789012:assumed-role/ci/x, in account 123456789012."),
    "User: [arn], in account [account].",
  );
  assert.equal(redact("arn:aws-us-gov:iam::123456789012:role/r"), "[arn]");
});

test("a 12-digit run inside a hyphenated name or a longer number is kept", () => {
  assert.equal(redact("batch run-123456789012-abc"), "batch run-123456789012-abc");
  assert.equal(redact("run 1234567890123"), "run 1234567890123");
});

test("an error is its name and first line, cut short and redacted", () => {
  const e = Object.assign(new Error("not authorized: arn:aws:iam::123456789012:role/x\nmore"), {
    name: "AccessDeniedException",
  });
  assert.equal(errorText(e), "AccessDeniedException: not authorized: [arn]");
  assert.equal(errorText("plain"), "Error: plain");
  assert.equal(errorText(new Error("x".repeat(300))).length, "Error: ".length + 200);
});

test("a handler error is its errorMessage, or the raw text, redacted", () => {
  assert.equal(
    handlerError('{"errorMessage":"ttl too long for 123456789012","errorType":"x"}'),
    "ttl too long for [account]",
  );
  assert.equal(handlerError("  Task timed out  "), "Task timed out");
  assert.equal(handlerError(""), "no reason given");
  assert.equal(handlerError('{"errorMessage":1}'), '{"errorMessage":1}');
});

test("an ARN ends before the punctuation that follows it", () => {
  assert.equal(redact("at f (arn:aws:lambda:us-east-1:111111111111:function:x)"), "at f ([arn])");
  assert.equal(redact("role/arn:aws:iam::111111111111:role/r; caused by"), "role/[arn]; caused by");
  assert.equal(redact("`arn:aws:iam::111111111111:role/r`."), "`[arn]`.");
  assert.equal(redact("see arn:aws:iam::111111111111:role/r."), "see [arn].");
  assert.equal(redact("role arn:aws:iam::111111111111:role/a,b, then"), "role [arn], then");
});
