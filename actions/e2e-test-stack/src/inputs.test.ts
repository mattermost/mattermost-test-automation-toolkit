// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, readInputs } from "./inputs.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const create = (over: Record<string, string> = {}) => ({
  STACK_OPERATION: "create",
  STACK_CALLER_KEY: "test-public-project",
  STACK_CREDENTIALS_KEY: KEY,
  STACK_INSTANCE_KEY: "pr-1234",
  STACK_SERVER_IMAGE: "mattermostdevelopment/mattermost-enterprise-edition:master",
  STACK_CALLER_RUN_ID: "1234567890",
  ...over,
});
const destroy = (over: Record<string, string> = {}) => ({
  STACK_OPERATION: "destroy",
  STACK_CALLER_KEY: "mobile",
  STACK_BATCH_ID: "pr-1234-abc",
  STACK_BATCH_TOKEN: "tok",
  STACK_CALLER_RUN_ID: "1234567890",
  ...over,
});
const refused = (env: Record<string, string>, message: RegExp) =>
  assert.throws(
    () => readInputs(env),
    (e: unknown) => e instanceof InputError && message.test(e.message),
  );

test("a create takes the defaults for channel, project and region, and only the fields it was given", () => {
  const inputs = readInputs(create());
  assert.equal(inputs.channel, "v1");
  assert.equal(inputs.project, "e2e-test-stack");
  assert.equal(inputs.region, "us-east-1");
  assert.deepEqual(inputs.credentialsKey, new Uint8Array(32).fill(7));
  assert.deepEqual(inputs.create, {
    instance_key: "pr-1234",
    caller_run_id: "1234567890",
    server_image: "mattermostdevelopment/mattermost-enterprise-edition:master",
  });
});

test("a create carries every field it exposes, typed as the control plane reads them", () => {
  const inputs = readInputs(
    create({
      STACK_CHANNEL: "edge",
      STACK_COUNT: "3",
      STACK_SERVICES: "minio, keycloak,\nopenldap",
      STACK_TTL: "1h30m",
      STACK_OS: "ubuntu-24.04",
      STACK_POSTGRES: "16",
      STACK_LICENSE: "enterprise-advanced",
      STACK_INSTANCE_TYPE: "m7i.xlarge",
      STACK_SERVER_ENV: '{"MM_FEATUREFLAGS_TESTFEATURE":"true"}',
      STACK_RETRIES: "-5",
      STACK_SHARED_ADMIN_PASSWORD: "true",
      STACK_WAIT_FOR_MIGRATIONS: "false",
    }),
  );
  assert.equal(inputs.channel, "edge");
  assert.deepEqual(inputs.create, {
    instance_key: "pr-1234",
    caller_run_id: "1234567890",
    server_image: "mattermostdevelopment/mattermost-enterprise-edition:master",
    count: 3,
    services: ["minio", "keycloak", "openldap"],
    ttl: "1h30m",
    os: "ubuntu-24.04",
    postgres: "16",
    license: "enterprise-advanced",
    instance_type: "m7i.xlarge",
    server_env: { MM_FEATUREFLAGS_TESTFEATURE: "true" },
    retries: -5,
    shared_admin_password: true,
    wait_for_migrations: false,
  });
});

test("the common inputs are checked before anything is called", () => {
  refused(
    create({ STACK_OPERATION: "reap" }),
    /operation must be create, fetch, logs, destroy, open, role, server-image, check-run or earlier-response/,
  );
  refused(create({ STACK_CALLER_KEY: "" }), /caller-key is required/);
  refused(create({ STACK_CALLER_KEY: "Mobile" }), /caller-key must be/);
  refused(create({ STACK_CHANNEL: "edge-v1" }), /channel must be v1 or edge/);
  refused(create({ STACK_REGION: "useast1" }), /region must be/);
  refused(
    create({ STACK_CREDENTIALS_KEY: Buffer.alloc(31).toString("base64") }),
    /credentials-key must be .* 32 bytes/,
  );
  refused(create({ STACK_CREDENTIALS_KEY: "not base64!" }), /credentials-key must be/);
});

test("create refuses a missing or malformed field, naming the input", () => {
  refused(create({ STACK_CREDENTIALS_KEY: "" }), /credentials-key is required for create/);
  refused(create({ STACK_INSTANCE_KEY: "" }), /instance-key is required/);
  refused(create({ STACK_INSTANCE_KEY: "PR_1234" }), /instance-key must be lowercase/);
  refused(create({ STACK_SERVER_IMAGE: "" }), /server-image is required/);
  refused(create({ STACK_CALLER_RUN_ID: "" }), /caller-run-id must be a workflow run id/);
  refused(create({ STACK_COUNT: "0" }), /count must be 1 or more/);
  refused(create({ STACK_COUNT: "two" }), /count must be a whole number/);
  refused(create({ STACK_RETRIES: "1.5" }), /retries must be a whole number/);
  refused(create({ STACK_TTL: "1 hour" }), /ttl must be a duration/);
  refused(create({ STACK_OS: "ubuntu" }), /os must be an OS variant/);
  refused(create({ STACK_POSTGRES: "latest" }), /postgres must be a version/);
  refused(create({ STACK_INSTANCE_TYPE: "large" }), /instance-type must be/);
  refused(create({ STACK_SERVICES: "minio,Keycloak" }), /each of services must be/);
  refused(create({ STACK_SERVER_ENV: "MM_X=1" }), /server-env must be a JSON object/);
  refused(create({ STACK_SERVER_ENV: '["MM_X"]' }), /server-env must be a JSON object/);
  refused(create({ STACK_SERVER_ENV: '{"MM_X":true}' }), /server-env MM_X must be a string/);
  refused(create({ STACK_SERVER_ENV: '{"FOO":"1"}' }), /server-env key "FOO" is not a server setting/);
  refused(create({ STACK_SHARED_ADMIN_PASSWORD: "yes" }), /shared-admin-password must be "true" or "false"/);
  refused(create({ STACK_BATCH_ID: "pr-1234-abc" }), /batch-id names an existing batch; create does not take it/);
});

test("fetch, logs and destroy need the batch and its token, or a create response, and refuse another operation's inputs", () => {
  assert.deepEqual(readInputs(destroy()), {
    operation: "destroy",
    callerKey: "mobile",
    channel: "v1",
    project: "e2e-test-stack",
    region: "us-east-1",
    batchId: "pr-1234-abc",
    batchToken: "tok",
  });
  refused(destroy({ STACK_BATCH_ID: "" }), /batch-id is required for destroy/);
  refused(destroy({ STACK_BATCH_TOKEN: "" }), /batch-token is required for destroy/);
  refused(destroy({ STACK_BATCH_ID: "Pr_1" }), /batch-id must be/);
  refused(destroy({ STACK_CREATE_RESPONSE: "create.json" }), /give batch-token or create-response, not both/);
  refused(
    destroy({ STACK_BATCH_TOKEN: "", STACK_CREATE_RESPONSE: "create.json" }),
    /credentials-key is required with create-response/,
  );
  refused(destroy({ STACK_INSTANCE_KEY: "pr-1" }), /instance-key is a create input; destroy does not take it/);
  refused(destroy({ STACK_INDEX: "0" }), /index is a logs and open input/);
  refused(destroy({ STACK_OPERATION: "fetch" }), /credentials-key is required for fetch/);
  refused(
    destroy({ STACK_OPERATION: "logs", STACK_CREDENTIALS_KEY: KEY, STACK_INDEXES: "0" }),
    /indexes is a fetch input/,
  );
  refused(
    destroy({ STACK_OPERATION: "logs", STACK_CREDENTIALS_KEY: KEY, STACK_INDEX: "-1" }),
    /index must be 0 or more/,
  );

  const viaResponse = readInputs(
    destroy({
      STACK_BATCH_ID: "",
      STACK_BATCH_TOKEN: "",
      STACK_CREATE_RESPONSE: "create.json",
      STACK_CREDENTIALS_KEY: KEY,
    }),
  );
  assert.equal(viaResponse.createResponse, "create.json");
  assert.equal(viaResponse.batchId, undefined);
  assert.deepEqual(
    readInputs(destroy({ STACK_OPERATION: "fetch", STACK_CREDENTIALS_KEY: KEY, STACK_INDEXES: "0, 3" })).indexes,
    [0, 3],
  );
  assert.equal(readInputs(destroy({ STACK_OPERATION: "logs", STACK_CREDENTIALS_KEY: KEY, STACK_INDEX: "2" })).index, 2);
});

test("open needs a create response and the credentials key, takes an index, needs no caller key, and refuses the rest", () => {
  const open = (over: Record<string, string> = {}) => ({
    STACK_OPERATION: "open",
    STACK_CREDENTIALS_KEY: KEY,
    STACK_CREATE_RESPONSE: "/tmp/create.json",
    ...over,
  });
  const inputs = readInputs(open({ STACK_INDEX: "2" }));
  assert.equal(inputs.operation, "open");
  assert.equal(inputs.createResponse, "/tmp/create.json");
  assert.equal(inputs.index, 2);
  assert.equal(inputs.callerKey, "");
  assert.equal(readInputs(open()).index, undefined);

  refused(open({ STACK_CREATE_RESPONSE: "" }), /create-response is required for open/);
  refused(open({ STACK_CREDENTIALS_KEY: "" }), /credentials-key is required for open/);
  refused(open({ STACK_INDEX: "-1" }), /index must be 0 or more/);
  refused(open({ STACK_BATCH_ID: "pr-1234-abc" }), /batch-id is not an open input/);
  refused(open({ STACK_BATCH_TOKEN: "tok" }), /batch-token is not an open input/);
  refused(open({ STACK_RESPONSE_PATH: "/tmp/r.json" }), /response-path is not an open input/);
  refused(open({ STACK_INDEXES: "0,1" }), /indexes is a fetch input; open does not take it/);
  refused(open({ STACK_TTL: "1h" }), /ttl is a create input; open does not take it/);
  refused(open({ STACK_LOGS_PATH: "/tmp/l" }), /logs-path is a logs input; open does not take it/);
});

test("role takes the account, the recorded account's file and both role ARNs, and no control-plane input", () => {
  const role = (over: Record<string, string> = {}) => ({
    STACK_OPERATION: "role",
    STACK_ACCOUNT: "prod",
    STACK_ACCOUNT_FILE: "/tmp/create/e2e-test-stack-account",
    STACK_ROLE_ARN_PROD: "arn:p",
    STACK_ROLE_ARN_DEV: "arn:d",
    STACK_CALLER_RUN_ID: "1234567890",
    ...over,
  });
  assert.deepEqual(readInputs(role()).role, {
    account: "prod",
    accountFile: "/tmp/create/e2e-test-stack-account",
    roleArnProd: "arn:p",
    roleArnDev: "arn:d",
  });
  for (const account of ["", "dev", "recorded"])
    assert.equal(readInputs(role({ STACK_ACCOUNT: account })).role?.account, account);
  refused(role({ STACK_ACCOUNT: "staging" }), /account must be prod, dev or recorded, got "staging"/);
  refused(role({ STACK_CREDENTIALS_KEY: KEY }), /credentials-key is not a role input; role calls no control plane/);
  refused(role({ STACK_RESPONSE_PATH: "/tmp/r.json" }), /response-path is not a role input/);
  refused(role({ STACK_SERVER: "esr" }), /server is a server-image input; role does not take it/);
  refused(destroy({ STACK_ACCOUNT: "prod" }), /account is a role input; destroy does not take it/);
  refused(create({ STACK_ROLE_ARN_DEV: "arn:d" }), /role-arn-dev is a role input; create does not take it/);
});

test("server-image takes master, latest or esr, master by default, and the token if there is one", () => {
  const image = (over: Record<string, string> = {}) => ({ STACK_OPERATION: "server-image", ...over });
  assert.equal(readInputs(image()).server, "master");
  assert.equal(readInputs(image()).githubToken, undefined);
  const esr = readInputs(image({ STACK_SERVER: "esr", STACK_GITHUB_TOKEN: "ghs_x" }));
  assert.equal(esr.server, "esr");
  assert.equal(esr.githubToken, "ghs_x");
  refused(image({ STACK_SERVER: "11.0" }), /server must be master, latest or esr, got "11\.0"/);
  refused(image({ STACK_INSTANCE_KEY: "pr-1" }), /instance-key is a create input; server-image does not take it/);
  refused(create({ STACK_SERVER: "latest" }), /server is a server-image input; create does not take it/);
});

test("check-run needs a run id, the allowed workflows, a branch pattern and events, a token and the repository", () => {
  const check = (over: Record<string, string> = {}) => ({
    STACK_OPERATION: "check-run",
    STACK_RUN_ID: "42",
    STACK_ALLOWED_WORKFLOWS: ".github/workflows/a.yml,\n.github/workflows/b.yaml",
    STACK_ALLOWED_BRANCHES: "master|release-\\d+\\.\\d+",
    STACK_ALLOWED_EVENTS: "push, workflow_dispatch",
    STACK_GITHUB_TOKEN: "ghs_x",
    GITHUB_REPOSITORY: "mattermost/tpp",
    ...over,
  });
  const inputs = readInputs(check());
  assert.equal(inputs.githubToken, "ghs_x");
  assert.deepEqual(
    { ...inputs.checkRun, branches: undefined },
    {
      repository: "mattermost/tpp",
      runId: "42",
      workflows: [".github/workflows/a.yml", ".github/workflows/b.yaml"],
      branches: undefined,
      events: ["push", "workflow_dispatch"],
    },
  );
  // The pattern matches the whole branch, alternatives included.
  const branches = inputs.checkRun!.branches;
  assert.ok(branches.test("master") && branches.test("release-11.2"));
  assert.ok(!branches.test("master-x") && !branches.test("x-release-11.2"));

  refused(check({ STACK_RUN_ID: "" }), /run-id must be a workflow run id/);
  refused(check({ STACK_RUN_ID: "42; rm" }), /run-id must be a workflow run id/);
  refused(check({ STACK_ALLOWED_WORKFLOWS: "" }), /allowed-workflows is required for check-run/);
  refused(check({ STACK_ALLOWED_WORKFLOWS: "e2e.yml" }), /each of allowed-workflows must be a workflow file/);
  refused(check({ STACK_ALLOWED_BRANCHES: "" }), /allowed-branches is required for check-run/);
  refused(check({ STACK_ALLOWED_BRANCHES: "master(" }), /allowed-branches must be a JavaScript regular expression/);
  // An unbalanced ")" would close the wrapping group and leave the second alternative unanchored.
  refused(
    check({ STACK_ALLOWED_BRANCHES: "master)|(?:release-.*" }),
    /allowed-branches must be a JavaScript regular expression/,
  );
  refused(check({ STACK_ALLOWED_EVENTS: "" }), /allowed-events is required for check-run/);
  refused(check({ STACK_ALLOWED_EVENTS: "push,Pull Request" }), /each of allowed-events must be an event name/);
  refused(check({ STACK_GITHUB_TOKEN: "" }), /github-token is required for check-run/);
  refused(check({ GITHUB_REPOSITORY: "" }), /GITHUB_REPOSITORY must name the repository/);
  refused(destroy({ STACK_ALLOWED_EVENTS: "push" }), /allowed-events is a check-run input; destroy does not take it/);
});

test("earlier-response needs response-path and a token, and reads this run unless run-id names another", () => {
  const earlier = (over: Record<string, string> = {}) => ({
    STACK_OPERATION: "earlier-response",
    STACK_RESPONSE_PATH: "/tmp/earlier/e2e-test-stack-create.json",
    STACK_GITHUB_TOKEN: "ghs_x",
    GITHUB_REPOSITORY: "mattermost/tpp",
    GITHUB_RUN_ID: "77",
    ...over,
  });
  assert.deepEqual(readInputs(earlier()).earlier, {
    repository: "mattermost/tpp",
    runId: "77",
    artifactName: "e2e-test-stack-create",
    responseMember: "e2e-test-stack-create.json",
    responsePath: "/tmp/earlier/e2e-test-stack-create.json",
  });
  const other = readInputs(
    earlier({
      STACK_RUN_ID: "42",
      STACK_ARTIFACT_NAME: "mobile-create",
      STACK_RESPONSE_MEMBER: "mobile/create.json",
      STACK_ACCOUNT_PATH: "/tmp/earlier/account",
    }),
  ).earlier;
  assert.deepEqual(
    [other?.runId, other?.artifactName, other?.responseMember, other?.accountPath],
    ["42", "mobile-create", "mobile/create.json", "/tmp/earlier/account"],
  );
  for (const member of ["../create.json", "a/./b.json", "a b.json", "/abs.json"])
    refused(earlier({ STACK_RESPONSE_MEMBER: member }), /response-member must be a file name in the artifact/);
  refused(
    destroy({ STACK_ACCOUNT_PATH: "/tmp/a" }),
    /account-path is an earlier-response input; destroy does not take it/,
  );
  refused(destroy({ STACK_RESPONSE_MEMBER: "a.json" }), /response-member is an earlier-response input/);
  refused(earlier({ STACK_RESPONSE_PATH: "" }), /response-path is required for earlier-response/);
  refused(earlier({ STACK_GITHUB_TOKEN: "" }), /github-token is required for earlier-response/);
  refused(earlier({ GITHUB_RUN_ID: "" }), /run-id must be a workflow run id/);
  refused(earlier({ STACK_ARTIFACT_NAME: "a/b" }), /artifact-name must be letters, digits/);
  refused(earlier({ STACK_CREATE_RESPONSE: "/tmp/c.json" }), /create-response is not an earlier-response input/);
  refused(
    earlier({ STACK_ALLOWED_EVENTS: "push" }),
    /allowed-events is a check-run input; earlier-response does not take it/,
  );
  refused(create({ STACK_ARTIFACT_NAME: "x" }), /artifact-name is an earlier-response input; create does not take it/);
});

test("expect-batch-prefix checks a create response's batch, and is refused without one", () => {
  const viaResponse = {
    STACK_BATCH_ID: "",
    STACK_BATCH_TOKEN: "",
    STACK_CREATE_RESPONSE: "c.json",
    STACK_CREDENTIALS_KEY: KEY,
  };
  assert.equal(
    readInputs(destroy({ ...viaResponse, STACK_EXPECT_BATCH_PREFIX: "mobile-42-" })).expectBatchPrefix,
    "mobile-42-",
  );
  assert.equal(
    readInputs({
      STACK_OPERATION: "open",
      STACK_CREDENTIALS_KEY: KEY,
      STACK_CREATE_RESPONSE: "c.json",
      STACK_EXPECT_BATCH_PREFIX: "tpp-",
    }).expectBatchPrefix,
    "tpp-",
  );
  refused(destroy({ STACK_EXPECT_BATCH_PREFIX: "mobile-" }), /expect-batch-prefix checks the batch in create-response/);
  refused(destroy({ ...viaResponse, STACK_EXPECT_BATCH_PREFIX: "Mobile_" }), /expect-batch-prefix must be lowercase/);
  // Without its trailing hyphen, mobile-123 would accept run 1234's batch.
  for (const prefix of ["mobile-123", "-mobile-", "-", `${"a".repeat(62)}-`])
    refused(
      destroy({ ...viaResponse, STACK_EXPECT_BATCH_PREFIX: prefix }),
      /expect-batch-prefix must be .*ending with a hyphen, 62 or fewer/,
    );
  assert.equal(
    readInputs(destroy({ ...viaResponse, STACK_EXPECT_BATCH_PREFIX: `${"a".repeat(61)}-` })).expectBatchPrefix?.length,
    62,
  );
  refused(
    create({ STACK_EXPECT_BATCH_PREFIX: "tpp-" }),
    /expect-batch-prefix is a fetch, logs, destroy and open input; create does not take it/,
  );
});

test("verify-gone is a destroy input that needs a create response; gone-window only goes with it", () => {
  const viaResponse = {
    STACK_BATCH_ID: "",
    STACK_BATCH_TOKEN: "",
    STACK_CREATE_RESPONSE: "c.json",
    STACK_CREDENTIALS_KEY: KEY,
  };
  const on = readInputs(destroy({ ...viaResponse, STACK_VERIFY_GONE: "true" }));
  assert.deepEqual([on.verifyGone, on.goneWindowSeconds], [true, 180]);
  assert.equal(
    readInputs(destroy({ ...viaResponse, STACK_VERIFY_GONE: "true", STACK_GONE_WINDOW: "30" })).goneWindowSeconds,
    30,
  );
  const off = readInputs(destroy({ ...viaResponse, STACK_VERIFY_GONE: "false" }));
  assert.deepEqual([off.verifyGone, off.goneWindowSeconds], [undefined, undefined]);
  refused(destroy({ STACK_VERIFY_GONE: "true" }), /verify-gone needs create-response/);
  refused(destroy({ ...viaResponse, STACK_VERIFY_GONE: "yes" }), /verify-gone must be "true" or "false"/);
  refused(
    destroy({ ...viaResponse, STACK_VERIFY_GONE: "true", STACK_GONE_WINDOW: "0" }),
    /gone-window must be 1 or more/,
  );
  refused(destroy({ ...viaResponse, STACK_GONE_WINDOW: "30" }), /gone-window is used only with verify-gone/);
  assert.equal(
    readInputs(destroy({ ...viaResponse, STACK_VERIFY_GONE: "true", STACK_GONE_WINDOW: "1800" })).goneWindowSeconds,
    1800,
  );
  refused(
    destroy({ ...viaResponse, STACK_VERIFY_GONE: "true", STACK_GONE_WINDOW: "1801" }),
    /gone-window must be 1800 or less, got 1801/,
  );
  refused(
    destroy({ STACK_OPERATION: "fetch", STACK_CREDENTIALS_KEY: KEY, STACK_VERIFY_GONE: "true" }),
    /verify-gone is a destroy input; fetch does not take it/,
  );
});
