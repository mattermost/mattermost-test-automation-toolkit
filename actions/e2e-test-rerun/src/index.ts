// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { appendFileSync } from "node:fs";
import { requestRerun } from "./rerun.ts";

requestRerun({ env: process.env })
  .then((result) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rerun=${result.rerun}\n`);
  })
  .catch((e: unknown) => {
    console.error(String(e));
    process.exit(1);
  });
