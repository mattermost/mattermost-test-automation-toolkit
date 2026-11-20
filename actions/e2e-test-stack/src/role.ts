// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { readFileSync, statSync } from "node:fs";

export type Account = "prod" | "dev";

export interface RoleInputs {
  /** prod or dev, or empty for only a recorded account; "recorded" is read as empty. */
  account: string;
  /** The account a run's create recorded beside its response; absent when the file does not exist. */
  accountFile?: string;
  roleArnProd: string;
  roleArnDev: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Picks the account and its CI role: the account recorded in accountFile when that file exists, otherwise the account
 * input. A recorded account and a prod or dev input that differ fail, as does an unset role ARN: the other account's
 * role is never used instead. The recorded file's content is never quoted.
 */
export function chooseRole(inputs: RoleInputs): { account: Account; roleArn: string } {
  let account = inputs.account === "recorded" ? "" : inputs.account;
  if (inputs.accountFile && isFile(inputs.accountFile)) {
    // As a shell reads it with $(cat ...): trailing newlines dropped, nothing else.
    const recorded = readFileSync(inputs.accountFile, "utf8").replace(/\n+$/, "");
    if (recorded !== "prod" && recorded !== "dev")
      throw new Error("e2e-test-stack: the recorded account is not prod or dev");
    if (account && account !== recorded)
      throw new Error(`e2e-test-stack: the run recorded account ${recorded}; account ${account} was asked for`);
    account = recorded;
  }
  if (account !== "prod" && account !== "dev")
    throw new Error(
      !account && inputs.accountFile
        ? "e2e-test-stack: the run recorded no account: set account to prod or dev"
        : "e2e-test-stack: account must be prod or dev",
    );
  const roleArn = account === "prod" ? inputs.roleArnProd : inputs.roleArnDev;
  if (!roleArn) throw new Error(`e2e-test-stack: role-arn-${account} is not set`);
  return { account, roleArn };
}
