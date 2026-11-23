// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ActionError } from "./errors.ts";
import { assumeRole, roleArnFrom, SESSION_SECONDS } from "./role.ts";
import type { StsSend } from "./role.ts";

const ROLE_ARN = "arn:aws:iam::111111111111:role/e2e-test-stack-ci-mobile";

test("the role ARN is taken as given, in whichever commercial account it names", () => {
  assert.equal(roleArnFrom(ROLE_ARN, "mobile"), ROLE_ARN);
  assert.equal(
    roleArnFrom("arn:aws:iam::222222222222:role/path/e2e-test-stack-ci-mobile", "mobile"),
    "arn:aws:iam::222222222222:role/path/e2e-test-stack-ci-mobile",
  );
});

test("a role in another partition is refused: the control plane is in the commercial one", () => {
  for (const other of [
    "arn:aws-us-gov:iam::222222222222:role/e2e-test-stack-ci-mobile",
    "arn:aws-cn:iam::222222222222:role/e2e-test-stack-ci-mobile",
  ])
    assert.throws(
      () => roleArnFrom(other, "mobile"),
      (e: unknown) =>
        /^role-arn must be in the commercial AWS partition/.test((e as Error).message) &&
        !(e as Error).message.includes("222222222222"),
    );
});

test("a role not named for the caller key is refused before anything is called, without quoting the ARN", () => {
  for (const other of [
    "arn:aws:iam::111111111111:role/e2e-test-stack-ci-tpp",
    "arn:aws:iam::111111111111:role/e2e-test-stack-ci-mobile-x",
    "arn:aws:iam::111111111111:role/admin",
  ])
    assert.throws(
      () => roleArnFrom(other, "mobile"),
      (e: unknown) =>
        e instanceof ActionError &&
        e.message ===
          "role-arn names another role: this repository's CI role is e2e-test-stack-ci-mobile, for caller-key mobile",
    );
});

test("a role ARN unset or malformed fails without quoting it", () => {
  assert.throws(() => roleArnFrom("", "mobile"), /^ActionError: role-arn is required: /);
  for (const bad of ["arn:aws:iam::111111111111:user/x", "arn:aws:iam::1111:role/x", "role/x", `${ROLE_ARN} x`])
    assert.throws(
      () => roleArnFrom(bad, "mobile"),
      (e: unknown) =>
        e instanceof ActionError &&
        e.message === "role-arn must be an IAM role ARN, arn:aws:iam::<account id>:role/<name>",
    );
});

const ASSUME = { roleArn: ROLE_ARN, sessionName: "e2e-test-stack-create-42", token: "id-token" };

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
    RoleArn: ROLE_ARN,
    RoleSessionName: "e2e-test-stack-create-42",
    WebIdentityToken: "id-token",
    DurationSeconds: SESSION_SECONDS,
  });
});

test("a refusal names the role's input and the trust it checks, with ARNs and account ids out", async () => {
  const sts: StsSend = {
    send: async () => {
      throw Object.assign(
        new Error(`Not authorized to perform sts:AssumeRoleWithWebIdentity on ${ROLE_ARN} in 111111111111`),
        { name: "AccessDenied" },
      );
    },
  };
  await assert.rejects(assumeRole(sts, ASSUME), (e: unknown) => {
    assert.ok(e instanceof ActionError);
    assert.equal(
      e.message,
      "could not assume role-arn with this job's GitHub OIDC token: AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity on [arn] in [account]. The role trusts only jobs in the workflow files and on the branches registered for this repository.",
    );
    return true;
  });
  const empty: StsSend = { send: async () => ({ Credentials: { AccessKeyId: "AK" } }) };
  await assert.rejects(assumeRole(empty, ASSUME), /^ActionError: assuming role-arn returned no credentials$/);
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
    assert.equal(form.get("RoleArn"), ROLE_ARN);
    assert.equal(form.get("WebIdentityToken"), "id-token");
    assert.equal(form.get("DurationSeconds"), "3600");
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
