// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TSIO_BASE_URL, STAGING_TSIO_BASE_URL, compositeIdentityFrom, missingReports, tsioBase } from "./tsio.ts";

test("use-staging unset, false or empty keeps the shared instance or the given base URL", () => {
  assert.equal(tsioBase({}), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "false" }), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "" }), DEFAULT_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "false", TSIO_BASE_URL: "" }), DEFAULT_TSIO_BASE_URL);
});

test("use-staging true targets the staging deployment", () => {
  assert.equal(tsioBase({ USE_STAGING: "true" }), STAGING_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: "" }), STAGING_TSIO_BASE_URL);
  // Read the way TSIO's own actions read it: trimmed and case-insensitive.
  assert.equal(tsioBase({ USE_STAGING: " TRUE " }), STAGING_TSIO_BASE_URL);
});

test("use-staging true with the matching staging URL is accepted, with or without a trailing slash", () => {
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: STAGING_TSIO_BASE_URL }), STAGING_TSIO_BASE_URL);
  assert.equal(tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: `${STAGING_TSIO_BASE_URL}/` }), STAGING_TSIO_BASE_URL);
});

test("use-staging true with a conflicting tsio-base-url fails clearly", () => {
  assert.throws(() => tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: DEFAULT_TSIO_BASE_URL }), /use-staging is true.*tsio-base-url/);
  assert.throws(() => tsioBase({ USE_STAGING: "true", TSIO_BASE_URL: "http://tsio" }), /use-staging is true.*tsio-base-url/);
});

test("use-staging false with a custom tsio-base-url uses the custom URL, without its trailing slash", () => {
  assert.equal(tsioBase({ USE_STAGING: "false", TSIO_BASE_URL: "https://custom.example/" }), "https://custom.example");
  assert.equal(tsioBase({ TSIO_BASE_URL: "http://tsio" }), "http://tsio");
});

test("an incomplete run names how many of its reports arrived", () => {
  assert.deepEqual(missingReports({ expected: 3, received: 3, status: "in_progress" }), { text: "the run's results are incomplete (3 of 3 reports arrived; TSIO group in_progress)", short: "results incomplete: 3 of 3 reports" });
  assert.deepEqual(missingReports({ expected: 3, received: null, status: "in_progress" }), { text: "the run's results are incomplete (? of 3 reports arrived; TSIO group in_progress)", short: "results incomplete: ? of 3 reports" });
  assert.deepEqual(missingReports({ expected: null, received: 2, status: "processing" }), { text: "the run's results are incomplete (2 reports arrived; the expected count is unknown; TSIO group processing)", short: "results incomplete" });
});

test("a missing or non-JSON COMPOSITE_IDENTITY is named as such, not a bare SyntaxError", () => {
  assert.throws(() => compositeIdentityFrom(undefined), /COMPOSITE_IDENTITY is missing/);
  assert.throws(() => compositeIdentityFrom(""), /COMPOSITE_IDENTITY is missing/);
  assert.throws(() => compositeIdentityFrom("{bad"), /COMPOSITE_IDENTITY is not valid JSON/);
  assert.deepEqual(compositeIdentityFrom('{"repository":"o/r"}'), { repository: "o/r" }, "a valid identity is read as written");
});
