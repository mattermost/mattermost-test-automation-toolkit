// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, readInputs } from "./inputs.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const create = (over: Record<string, string> = {}) => ({
  STACK_OPERATION: "create",
  STACK_CALLER_KEY: "test-public-project",
  STACK_PRIVATE_KEY: KEY,
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
  assert.deepEqual(inputs.privateKey, new Uint8Array(32).fill(7));
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
  refused(create({ STACK_OPERATION: "reap" }), /operation must be create, fetch, logs, destroy or open/);
  refused(create({ STACK_CALLER_KEY: "" }), /caller-key is required/);
  refused(create({ STACK_CALLER_KEY: "Mobile" }), /caller-key must be/);
  refused(create({ STACK_CHANNEL: "edge-v1" }), /channel must be v1 or edge/);
  refused(create({ STACK_REGION: "useast1" }), /region must be/);
  refused(create({ STACK_PRIVATE_KEY: Buffer.alloc(31).toString("base64") }), /private-key must be .* 32 bytes/);
  refused(create({ STACK_PRIVATE_KEY: "not base64!" }), /private-key must be/);
});

test("create refuses a missing or malformed field, naming the input", () => {
  refused(create({ STACK_PRIVATE_KEY: "" }), /private-key is required for create/);
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
    /private-key is required with create-response/,
  );
  refused(destroy({ STACK_INSTANCE_KEY: "pr-1" }), /instance-key is a create input; destroy does not take it/);
  refused(destroy({ STACK_INDEX: "0" }), /index is a logs and open input/);
  refused(destroy({ STACK_OPERATION: "fetch" }), /private-key is required for fetch/);
  refused(destroy({ STACK_OPERATION: "logs", STACK_PRIVATE_KEY: KEY, STACK_INDEXES: "0" }), /indexes is a fetch input/);
  refused(destroy({ STACK_OPERATION: "logs", STACK_PRIVATE_KEY: KEY, STACK_INDEX: "-1" }), /index must be 0 or more/);

  const viaResponse = readInputs(
    destroy({
      STACK_BATCH_ID: "",
      STACK_BATCH_TOKEN: "",
      STACK_CREATE_RESPONSE: "create.json",
      STACK_PRIVATE_KEY: KEY,
    }),
  );
  assert.equal(viaResponse.createResponse, "create.json");
  assert.equal(viaResponse.batchId, undefined);
  assert.deepEqual(
    readInputs(destroy({ STACK_OPERATION: "fetch", STACK_PRIVATE_KEY: KEY, STACK_INDEXES: "0, 3" })).indexes,
    [0, 3],
  );
  assert.equal(readInputs(destroy({ STACK_OPERATION: "logs", STACK_PRIVATE_KEY: KEY, STACK_INDEX: "2" })).index, 2);
});

test("open needs a create response and the private key, takes an index, needs no caller key, and refuses the rest", () => {
  const open = (over: Record<string, string> = {}) => ({
    STACK_OPERATION: "open",
    STACK_PRIVATE_KEY: KEY,
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
  refused(open({ STACK_PRIVATE_KEY: "" }), /private-key is required for open/);
  refused(open({ STACK_INDEX: "-1" }), /index must be 0 or more/);
  refused(open({ STACK_BATCH_ID: "pr-1234-abc" }), /batch-id is not an open input/);
  refused(open({ STACK_BATCH_TOKEN: "tok" }), /batch-token is not an open input/);
  refused(open({ STACK_RESPONSE_PATH: "/tmp/r.json" }), /response-path is not an open input/);
  refused(open({ STACK_INDEXES: "0,1" }), /indexes is a fetch input; open does not take it/);
  refused(open({ STACK_TTL: "1h" }), /ttl is a create input; open does not take it/);
  refused(open({ STACK_LOGS_PATH: "/tmp/l" }), /logs-path is a logs input; open does not take it/);
});
