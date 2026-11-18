---
name: verify
description: Cheap, text-only UI smoke check of a change against a running Mattermost server (default http://localhost:8065), using scoped accessibility snapshots instead of screenshots. Use when asked to verify, smoke-test or confirm a UI change works in the browser.
argument-hint: <what to verify> [base_url]
---

Verify: $ARGUMENTS. The runner is `scripts/verify_ui.mjs` next to this file. It reads a JSON plan and drives Chromium.
Its output is text only: step results, scoped `ariaSnapshot()` YAML, and a final `VERDICT:` line. Never take,
request or read screenshots.

1. **Server and auth:** check that `VERIFY_BASE_URL` (or `MM_URL`, default `http://localhost:8065`) answers
   `GET /api/v4/system/ping`. If it doesn't, stop and report `INFRA_ERROR`; do not start or reconfigure servers unasked.
   - Logged-in pages: the runner authenticates through the API before the first step, so no step goes to the login
     form. Put `"login": true` in the plan so missing credentials fail as `INFRA_ERROR`.
   - `VERIFY_USER` + `VERIFY_PASSWORD`: `POST /api/v4/users/login`. The server sets `MMAUTHTOKEN`, `MMUSERID` and
     `MMCSRF`, and the runner checks that all three are present.
   - `VERIFY_TOKEN` (session or personal access token): `MMAUTHTOKEN` + `MMUSERID` cookies and a Bearer header. Header
     tokens skip the CSRF check, so `MMCSRF` is not needed in this mode.
   - Never write credentials into the plan.
2. **Plan:** write a plan of at most 10 steps (`MAX_STEPS`). The format is in the header of `verify_ui.mjs`.
   - Locate by role and accessible name first; use `testid`/`css` only when there is no accessible name.
   - Add a `snapshot` step scoped to the region you need (e.g. `{"role": "dialog"}`), not the whole page. The default
     scope is `#app-content`. Open menus, dialogs and listboxes render in React portals outside it and are always
     appended as `portal [role=…]:` blocks, so click their items by role and name as usual.
   - Stay on the server under test. Other origins are blocked; add `allow_origins` only for assets the app really
     loads.
   - `expect` must hold at least one deterministic check: a DOM assertion (`visible`, `text` + `contains`,
     `count` + `min`) or an `/api/v4/` read (`api.path`, `status`, `json_has`). Choose checks that would fail if
     the change were broken.
3. **Run:** `node <this dir>/scripts/verify_ui.mjs plan.json` from a directory where `require("playwright")` resolves
   (e.g. `mattermost/e2e-tests/playwright`), or with `NODE_PATH` pointing at a `node_modules` that has it.
   - Exit 0 `PASS`.
   - Exit 1 `FAIL`: an assertion failed, the page threw (`pageerror`), or an `/api/v4/` call returned >= 500. Each one
     fails automatically.
   - Exit 2: `INVALID_PLAN` or `INFRA_ERROR`.
   - Add `--freeze <name>.spec.ts` once the plan passes. It writes a plain `@playwright/test` spec with the same
     oracle, which reruns in CI with no model and no tokens. Offer it to the user; do not commit it unasked.
4. **Iterate:** on `FAIL`, read the failure snapshot and fix the plan only when the plan was wrong (wrong name, wrong
   region). Never relax an `expect` to make it pass. Stop after 3 runs.
5. **Report in chat:** the plan, the verdict line, the snapshot lines that prove it, and the frozen spec path if any. A `FAIL` caused by the app is a
   finding: give the steps to reproduce it.
