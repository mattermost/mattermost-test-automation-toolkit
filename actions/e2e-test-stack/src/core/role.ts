// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ActionError } from "./errors.ts";
import { PROJECT } from "./inputs.ts";
import { errorText } from "./redact.ts";

/** How long the assumed role's session lasts, in seconds. */
export const SESSION_SECONDS = 3600;

/**
 * An IAM role ARN in the commercial partition, where the control plane is; the role name allows letters, digits and
 * +=,.@_- and path slashes.
 */
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

/** AWS credentials for one session. */
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * The CI role ARN, which decides the account the batch is in. An unset or malformed one fails, as does a role not
 * named for the caller key, <project>-ci-<caller-key>; no ARN is quoted.
 */
export function roleArnFrom(value: string, callerKey: string): string {
  if (!value)
    throw new ActionError(
      "role-arn is required: the ARN of the repository's CI role in the account to use, arn:aws:iam::<account id>:role/e2e-test-stack-ci-<caller-key>",
    );
  if (/^arn:aws-[a-z-]+:/.test(value))
    throw new ActionError(
      "role-arn must be in the commercial AWS partition, arn:aws:iam::<account id>:role/<name>, where the control plane is",
    );
  if (!ROLE_ARN.test(value))
    throw new ActionError("role-arn must be an IAM role ARN, arn:aws:iam::<account id>:role/<name>");
  const name = `${PROJECT}-ci-${callerKey}`;
  if (value.slice(value.lastIndexOf("/") + 1) !== name)
    throw new ActionError(
      `role-arn names another role: this repository's CI role is ${name}, for caller-key ${callerKey}`,
    );
  return value;
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
}

/**
 * Assumes the role with the ID token for SESSION_SECONDS. A refusal names role-arn and the trust it checks,
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
      `could not assume role-arn with this job's GitHub OIDC token: ${errorText(e)}. The role trusts only jobs in the workflow files and on the branches registered for this repository.`,
      { cause: e },
    );
  }
  const c = reply.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
    throw new ActionError("assuming role-arn returned no credentials");
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    ...(c.Expiration ? { expiration: c.Expiration } : {}),
  };
}
