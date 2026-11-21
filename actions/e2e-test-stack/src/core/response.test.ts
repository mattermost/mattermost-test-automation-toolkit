// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import assert from "node:assert/strict";
import { test } from "node:test";
import { masker } from "./outputs.ts";
import { maskBatchSecrets, responseError } from "./response.ts";

test("every secret of a batch is masked; names that unlock nothing are not", () => {
  const logged: string[] = [];
  const m = masker((l) => logged.push(l));
  maskBatchSecrets(m, {
    batch_token: "tok",
    instances: [
      {
        admin_password: "pw",
        mail_token: "mail",
        credentials: { "postgres.user": "mmuser", "postgres.database": "mattermost", "postgres.password": "pg" },
        facts: { "openldap.bind_dn": "cn=admin", "openldap.bind_password": "ldap", "x.api_key": "k" },
      },
      null,
    ],
  });
  assert.deepEqual([...m.masked].sort(), ["k", "ldap", "mail", "pg", "pw", "tok"]);
});

test("a reply's error is text, redacted, whatever it holds; none is empty", () => {
  assert.equal(responseError({}), "");
  assert.equal(responseError({ error: null }), "");
  assert.equal(responseError({ error: "" }), "");
  assert.equal(responseError({ error: "account 123456789012 over quota" }), "account [account] over quota");
  assert.equal(responseError({ error: { code: "partial", failed: [1] } }), '{"code":"partial","failed":[1]}');
});
