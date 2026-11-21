// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ActionError } from "./errors.ts";
import { errorText } from "./redact.ts";

export const ACCOUNTS = ["prod", "dev"] as const;
export type Account = (typeof ACCOUNTS)[number];

/** The file, beside a create response, that records the account its batch was created in. */
export const ACCOUNT_FILE = "e2e-test-stack-account";

/** How long the assumed role's session lasts, in seconds. */
export const SESSION_SECONDS = 3600;

/** An IAM role ARN; the role name allows letters, digits and +=,.@_- and path slashes. */
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

/** AWS credentials for one session. */
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export interface RoleInputs {
  account: string;
  roleArnProd: string;
  roleArnDev: string;
}

/**
 * Picks the account and its CI role ARN. An account that is not prod or dev fails, as does an unset or malformed role
 * ARN: the other account's role is never used instead. No ARN is quoted.
 */
export function chooseRole(inputs: RoleInputs): { account: Account; roleArn: string } {
  const { account } = inputs;
  if (account !== "prod" && account !== "dev")
    throw new ActionError(`account must be prod or dev, got ${JSON.stringify(account.slice(0, 40))}`);
  const roleArn = account === "prod" ? inputs.roleArnProd : inputs.roleArnDev;
  if (!roleArn)
    throw new ActionError(
      `role-arn-${account} is required for account ${account}: the ARN of the repository's CI role in that account`,
    );
  if (!ROLE_ARN.test(roleArn))
    throw new ActionError(`role-arn-${account} must be an IAM role ARN, arn:aws:iam::<account id>:role/<name>`);
  return { account, roleArn };
}

/** The part of the STS client the actions use. */
export interface StsSend {
  send(command: AssumeRoleWithWebIdentityCommand): Promise<{
    Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date };
  }>;
}

/** The regional STS client. AssumeRoleWithWebIdentity is unsigned, so it takes no credentials. */
export const stsClient = (region: string): StsSend => new STSClient({ region });

export interface AssumeInputs {
  roleArn: string;
  /** Names the session in CloudTrail: letters, digits and +=,.@_-, 2 to 64. */
  sessionName: string;
  /** The GitHub OIDC ID token, for the audience sts.amazonaws.com. */
  token: string;
  /** Names the role in a failure, as role-arn-<account> does. */
  account: Account;
}

/**
 * Assumes the role with the ID token for SESSION_SECONDS. A refusal names the role's input and the trust it checks,
 * and quotes no ARN or account id.
 */
export async function assumeRole(sts: StsSend, inputs: AssumeInputs): Promise<Credentials> {
  let reply: Awaited<ReturnType<StsSend["send"]>>;
  try {
    reply = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: inputs.roleArn,
        RoleSessionName: inputs.sessionName,
        WebIdentityToken: inputs.token,
        DurationSeconds: SESSION_SECONDS,
      }),
    );
  } catch (e) {
    throw new ActionError(
      `could not assume role-arn-${inputs.account} with this job's GitHub OIDC token: ${errorText(e)}. The role trusts only jobs in the workflow files and on the branches registered for this repository.`,
      { cause: e },
    );
  }
  const c = reply.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
    throw new ActionError(`assuming role-arn-${inputs.account} returned no credentials`);
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    ...(c.Expiration ? { expiration: c.Expiration } : {}),
  };
}
