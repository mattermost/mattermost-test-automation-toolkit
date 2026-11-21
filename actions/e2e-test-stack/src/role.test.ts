// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { chooseRole } from "./role.ts";

const dir = mkdtempSync(join(tmpdir(), "e2e-test-stack-role-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const recorded = (content: string): string => {
  const path = join(dir, `${++files}-e2e-test-stack-account`);
  writeFileSync(path, content);
  return path;
};
const ARNS = { roleArnProd: "arn:aws:iam::111111111111:role/p", roleArnDev: "arn:aws:iam::222222222222:role/d" };

test("the account input picks its role when nothing is recorded", () => {
  assert.deepEqual(chooseRole({ account: "prod", ...ARNS }), { account: "prod", roleArn: ARNS.roleArnProd });
  assert.deepEqual(chooseRole({ account: "dev", accountFile: join(dir, "missing"), ...ARNS }), {
    account: "dev",
    roleArn: ARNS.roleArnDev,
  });
  // A directory is not a recorded account.
  assert.deepEqual(chooseRole({ account: "dev", accountFile: dir, ...ARNS }).account, "dev");
});

test("a recorded account wins over an empty or recorded input, and must agree with a prod or dev one", () => {
  const dev = recorded("dev\n");
  for (const account of ["", "recorded", "dev"])
    assert.deepEqual(chooseRole({ account, accountFile: dev, ...ARNS }), { account: "dev", roleArn: ARNS.roleArnDev });
  assert.throws(
    () => chooseRole({ account: "prod", accountFile: dev, ...ARNS }),
    /^Error: e2e-test-stack: the run recorded account dev; account prod was asked for$/,
  );
});

test("a recorded account that is not prod or dev fails without quoting it", () => {
  for (const content of ["staging\n", "prod dev", " prod", "::warning::x"])
    assert.throws(
      () => chooseRole({ account: "", accountFile: recorded(content), ...ARNS }),
      (e: unknown) => (e as Error).message === "e2e-test-stack: the recorded account is not prod or dev",
    );
});

test("no account at all, or an unset role, fails naming what to set", () => {
  assert.throws(
    () => chooseRole({ account: "recorded", accountFile: join(dir, "missing"), ...ARNS }),
    /the run recorded no account: set account to prod or dev$/,
  );
  assert.throws(() => chooseRole({ account: "", ...ARNS }), /account must be prod or dev$/);
  assert.throws(() => chooseRole({ account: "prod", roleArnProd: "", roleArnDev: "x" }), /role-arn-prod is not set$/);
  assert.throws(
    () => chooseRole({ account: "", accountFile: recorded("dev"), roleArnProd: "x", roleArnDev: "" }),
    /role-arn-dev is not set$/,
  );
});
