// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { publish } from "./publish.ts";

publish({ env: process.env }).catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
