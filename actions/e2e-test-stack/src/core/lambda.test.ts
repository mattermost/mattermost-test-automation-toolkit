// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { abortableSleep, alias, lambdaClient, lambdaClientConfig, lambdaInvoke, THROTTLE_ATTEMPTS } from "./lambda.ts";

const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example", sessionToken: "session" };

test("the alias is the caller's own, on the channel's function", () => {
  assert.deepEqual(alias("e2e-test-stack", "edge", "mobile"), {
    FunctionName: "e2e-test-stack-edge",
    Qualifier: "mobile-edge",
  });
});

test("the client makes one attempt, with the credentials given", async () => {
  const config = lambdaClientConfig("us-west-2", CREDENTIALS);
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.region, "us-west-2");
  const client = lambdaClient("us-west-2", CREDENTIALS);
  try {
    assert.deepEqual(await client.config.credentials(), CREDENTIALS);
  } finally {
    client.destroy();
  }
});

test("the Lambda client fails a call that runs past the request timeout, instead of only warning", async () => {
  // Accepts the connection, reads the request and never answers, as a stuck invoke would.
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const client = new LambdaClient({
    ...lambdaClientConfig("us-east-1", CREDENTIALS, 300),
    endpoint: `http://127.0.0.1:${port}`,
  });
  try {
    await assert.rejects(
      client.send(new InvokeCommand({ FunctionName: "f", Qualifier: "q", Payload: new Uint8Array() })),
      (e: Error) => e.name === "TimeoutError",
    );
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("the Lambda client is sent a synchronous Invoke, and only a throttle is tried again", async () => {
  const sent: InvokeCommand[] = [];
  let throttles = 2;
  const waits: number[] = [];
  const logged: string[] = [];
  const invoke = lambdaInvoke(
    {
      send: async (command) => {
        sent.push(command);
        if (throttles-- > 0) throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
        return { StatusCode: 200, Payload: new TextEncoder().encode("{}") };
      },
    },
    async (ms) => void waits.push(ms),
    (m) => logged.push(m),
  );
  const reply = await invoke({ FunctionName: "e2e-test-stack-v1", Qualifier: "mobile-v1", Payload: '{"action":"x"}' });
  assert.equal(reply.StatusCode, 200);
  assert.equal(sent.length, 3);
  assert.ok(sent[0] instanceof InvokeCommand);
  assert.equal(sent[0].input.FunctionName, "e2e-test-stack-v1");
  assert.equal(sent[0].input.Qualifier, "mobile-v1");
  assert.equal(sent[0].input.InvocationType, "RequestResponse");
  assert.equal(new TextDecoder().decode(sent[0].input.Payload as Uint8Array), '{"action":"x"}');
  assert.deepEqual(waits, [10000, 20000]);
  assert.match(logged[0], /throttled; trying again in 10 s \(attempt 2 of 5\)/);

  let calls = 0;
  const denied = lambdaInvoke(
    {
      send: async () => {
        calls++;
        throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
      },
    },
    async () => {},
    () => {},
  );
  await assert.rejects(denied({ FunctionName: "f", Qualifier: "q", Payload: "{}" }), /not authorized/);
  assert.equal(calls, 1);

  calls = 0;
  const throttled = lambdaInvoke(
    {
      send: async () => {
        calls++;
        throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      },
    },
    async () => {},
    () => {},
  );
  await assert.rejects(throttled({ FunctionName: "f", Qualifier: "q", Payload: "{}" }), /Rate exceeded/);
  assert.equal(calls, THROTTLE_ATTEMPTS);
});

test("the default wait clears its timer when the signal aborts, so it never keeps the process up", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waited = abortableSleep(60_000, controller.signal);
  controller.abort();
  await waited;
  assert.ok(Date.now() - started < 1_000);
  await abortableSleep(1);
});

test("a throttle wait ends when the call's signal aborts, and no other send is made", async () => {
  let calls = 0;
  const controller = new AbortController();
  const invoke = lambdaInvoke(
    {
      send: async () => {
        calls++;
        throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      },
    },
    () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise(() => {});
    },
    () => {},
  );
  await assert.rejects(
    invoke({ FunctionName: "f", Qualifier: "q", Payload: "{}" }, controller.signal),
    /Rate exceeded/,
  );
  assert.equal(calls, 1);
});
