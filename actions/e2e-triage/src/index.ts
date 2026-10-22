// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { triage } from "./triage.ts";

triage({ env: process.env }).catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
