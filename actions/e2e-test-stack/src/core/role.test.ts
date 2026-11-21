// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ActionError } from "./errors.ts";
import { assumeRole, chooseRole, SESSION_SECONDS } from "./role.ts";
import type { StsSend } from "./role.ts";

const ARNS = {
  roleArnProd: "arn:aws:iam::111111111111:role/e2e-test-stack-ci-mobile",
  roleArnDev: "arn:aws:iam::222222222222:role/e2e-test-stack-ci-mobile",
};

test("the account picks its own role ARN", () => {
  assert.deepEqual(chooseRole({ account: "prod", ...ARNS }), { account: "prod", roleArn: ARNS.roleArnProd });
  assert.deepEqual(chooseRole({ account: "dev", ...ARNS }), { account: "dev", roleArn: ARNS.roleArnDev });
});

test("an account that is not prod or dev, or a role ARN unset or malformed, fails without quoting an ARN", () => {
  assert.throws(
    () => chooseRole({ account: "staging", ...ARNS }),
    /^ActionError: account must be prod or dev, got "staging"$/,
  );
  assert.throws(() => chooseRole({ account: "", ...ARNS }), /account must be prod or dev/);
  assert.throws(
    () => chooseRole({ account: "prod", roleArnProd: "", roleArnDev: ARNS.roleArnDev }),
    /role-arn-prod is required for account prod/,
  );
  for (const bad of ["arn:aws:iam::111111111111:user/x", "arn:aws:iam::1111:role/x", "role/x", `${ARNS.roleArnDev} x`])
    assert.throws(
      () => chooseRole({ account: "dev", roleArnProd: ARNS.roleArnProd, roleArnDev: bad }),
      (e: unknown) =>
        e instanceof ActionError &&
        e.message === "role-arn-dev must be an IAM role ARN, arn:aws:iam::<account id>:role/<name>",
    );
});

const ASSUME = {
  roleArn: ARNS.roleArnProd,
  sessionName: "e2e-test-stack-create-42",
  token: "id-token",
  account: "prod" as const,
};

test("the role is assumed with the ID token for an hour, and its credentials returned", async () => {
  const sent: AssumeRoleWithWebIdentityCommand[] = [];
  const expiration = new Date("2026-11-21T13:00:00Z");
  const sts: StsSend = {
    send: async (command) => {
      sent.push(command);
      return { Credentials: { AccessKeyId: "AK", SecretAccessKey: "SK", SessionToken: "ST", Expiration: expiration } };
    },
  };
  assert.deepEqual(await assumeRole(sts, ASSUME), {
    accessKeyId: "AK",
    secretAccessKey: "SK",
    sessionToken: "ST",
    expiration,
  });
  assert.deepEqual(sent[0].input, {
    RoleArn: ARNS.roleArnProd,
    RoleSessionName: "e2e-test-stack-create-42",
    WebIdentityToken: "id-token",
    DurationSeconds: SESSION_SECONDS,
  });
});

test("a refusal names the role's input and the trust it checks, with ARNs and account ids out", async () => {
  const sts: StsSend = {
    send: async () => {
      throw Object.assign(
        new Error(`Not authorized to perform sts:AssumeRoleWithWebIdentity on ${ARNS.roleArnProd} in 111111111111`),
        { name: "AccessDenied" },
      );
    },
  };
  await assert.rejects(assumeRole(sts, ASSUME), (e: unknown) => {
    assert.ok(e instanceof ActionError);
    assert.equal(
      e.message,
      "could not assume role-arn-prod with this job's GitHub OIDC token: AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity on [arn] in [account]. The role trusts only jobs in the workflow files and on the branches registered for this repository.",
    );
    return true;
  });
  const empty: StsSend = { send: async () => ({ Credentials: { AccessKeyId: "AK" } }) };
  await assert.rejects(assumeRole(empty, ASSUME), /^ActionError: assuming role-arn-prod returned no credentials$/);
});

test("the STS client sends an unsigned AssumeRoleWithWebIdentity, needing no credentials", async () => {
  const requests: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AK</AccessKeyId><SecretAccessKey>SK</SecretAccessKey><SessionToken>ST</SessionToken><Expiration>2026-11-21T13:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  // No credentials anywhere: a signed request would fail to find any.
  const client = new STSClient({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    credentials: () => Promise.reject(new Error("no credentials were to be read")),
  });
  try {
    const credentials = await assumeRole(client, ASSUME);
    assert.equal(credentials.sessionToken, "ST");
    assert.equal(credentials.expiration?.toISOString(), "2026-11-21T13:00:00.000Z");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, undefined);
    const form = new URLSearchParams(requests[0].body);
    assert.equal(form.get("Action"), "AssumeRoleWithWebIdentity");
    assert.equal(form.get("RoleArn"), ARNS.roleArnProd);
    assert.equal(form.get("WebIdentityToken"), "id-token");
    assert.equal(form.get("DurationSeconds"), "3600");
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
