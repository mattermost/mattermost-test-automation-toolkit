// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { NotTriagedError, triage } from "./triage.ts";

triage({ env: process.env }).catch((e: unknown) => {
  // A run a newer dispatch replaced is not a failure: its job summary says where its triage is.
  if (e instanceof NotTriagedError) {
    console.error(`e2e-test-triage: ${e.message}`);
    return;
  }
  console.error(String(e));
  process.exit(1);
});
