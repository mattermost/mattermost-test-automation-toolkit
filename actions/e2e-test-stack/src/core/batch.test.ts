// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchAttempt, batchIdParts } from "./batch.ts";

const owner = { callerKey: "mobile", runId: "42", batch: "ios", attempt: 2 };

test("a batch id of this caller, run and batch names the attempt that created it", () => {
  assert.equal(batchAttempt("mobile-42-ios-1-abc123", owner), 1);
  assert.equal(batchAttempt("mobile-42-ios-2-x", owner), 2);
});

test("a batch id of a later attempt, another caller, run or batch, or another shape, is not this run's", () => {
  for (const id of [
    "mobile-42-ios-3-abc",
    "mobile-42-ios-0-abc",
    "mobile-42-ios-01-abc",
    "tpp-42-ios-1-abc",
    "mobile-43-ios-1-abc",
    "mobile-142-ios-1-abc",
    "mobile-42-android-1-abc",
    "mobile-42-ios-1",
    "mobile-42-ios-1-",
    "mobile-42-ios-1-ABC",
    "mobile-42-ios-1-abc\n",
    " mobile-42-ios-1-abc",
    "xmobile-42-ios-1-abc",
    `mobile-42-ios-${"9".repeat(20)}-abc`,
  ])
    assert.equal(batchAttempt(id, owner), undefined, JSON.stringify(id));
});

test("a batch whose name extends another's never matches the shorter one", () => {
  assert.equal(batchAttempt("mobile-42-ios-1-2-abc", owner), undefined);
  assert.equal(batchAttempt("mobile-42-ios-1-2-abc", { ...owner, batch: "ios-1" }), 2);
});

test("a batch id splits into its run, batch and attempt for its caller key, one way only", () => {
  assert.deepEqual(batchIdParts("mobile-42-ios-2-abc", "mobile"), { runId: "42", batch: "ios", attempt: 2 });
  assert.deepEqual(batchIdParts("mobile-42-ios-2-1-abc", "mobile"), { runId: "42", batch: "ios-2", attempt: 1 });
  for (const id of [
    "tpp-42-ios-2-abc",
    "mobile-42-ios-abc",
    "mobile-x-ios-2-abc",
    "mobile-42-ios-0-abc",
    "mobile-42-IOS-2-abc",
    "",
  ])
    assert.equal(batchIdParts(id, "mobile"), undefined, id);
});
