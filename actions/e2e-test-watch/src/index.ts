// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { record, watch } from "./watch.ts";

// `record` is the second step of the record sub-action; without an argument the action plans the requests.
(process.argv[2] === "record" ? Promise.resolve().then(() => record({ env: process.env })) : watch({ env: process.env })).catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
