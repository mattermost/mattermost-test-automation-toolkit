// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { lambdaClient, lambdaInvoke } from "./lambda.ts";
import { run } from "./stack.ts";

run({ env: process.env, connect: (region) => lambdaInvoke(lambdaClient(region)) }).catch((e: unknown) => {
  // Every failure names the action; one from elsewhere (a file read, the SDK) gets the prefix.
  const message = e instanceof Error ? e.message : String(e);
  console.error(message.startsWith("e2e-test-stack:") ? message : `e2e-test-stack: ${message}`);
  process.exit(1);
});
