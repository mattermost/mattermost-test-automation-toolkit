---
name: verify
description: Cheap, text-only UI smoke check of a change against a running Mattermost server (default http://localhost:8065), using scoped accessibility snapshots instead of screenshots. Use when asked to verify, smoke-test or confirm a UI change works in the browser.
argument-hint: <what to verify> [base_url]
---

Verify: $ARGUMENTS. The runner is `scripts/verify_ui.mjs` next to this file. It reads a JSON plan and drives Chromium.
Its output is text: step results, scoped `ariaSnapshot()` YAML, and a final `VERDICT:` line. Never take, request or
read screenshots. The one exception: when the user asks for visual proof, add `--screenshot-on-fail`, which writes a
single `failure.png` only if the run FAILs. Hand its path to the user and never read it yourself.

1. **Server and auth:** check that the target answers `GET /api/v4/system/ping`: the `base_url` the user gave, else
   `VERIFY_BASE_URL`, else `MM_URL`, else `http://localhost:8065`. If it doesn't, stop and report `INFRA_ERROR`; do not start or reconfigure servers unasked.
   - **A PR's or release's own build** (when the user asks to check a PR or release range): never build it locally. `scripts/pr_server.py images <pr | base...head> --pull`
     gives and pulls the enterprise images of head and merge-base (`/hunt` starts this at step 1 when the diff
     touches `webapp/` or a server API a page calls; otherwise start it yourself, a cold pull is 10-15 min). `scripts/pr_server.py up <image>` runs the mattermost repo's
     own e2e stack on that image at `http://localhost:8065`, **replaces** a server running another build (`make stop-server`
     drops its volumes: ask before running it over a stack the user is using), and seeds both the
     `VERIFY_USER` system admin and a non-admin `verify_member` (same `VERIFY_PASSWORD`, joined to team `verify`,
     onboarding overlay off for both). Pass `VERIFY_USER=verify_member` to test non-admin / RBAC behavior. One stack at a time: run the plan on head, then `up` the base
     image and run it again, and compare the two verdicts (`--compare` needs both up at once). An image swap takes
     ~100 s, the plan seconds. A missing image = CI has not built that commit yet: say so, do not build it.
   - Logged-in pages: the runner authenticates through the API before the first step, so no step goes to the login
     form. Put `"login": true` in the plan so missing credentials fail as `INFRA_ERROR`.
   - `VERIFY_USER` + `VERIFY_PASSWORD`: `POST /api/v4/users/login`. The server sets `MMAUTHTOKEN`, `MMUSERID` and
     `MMCSRF`, and the runner checks that all three are present.
   - `VERIFY_TOKEN` (session or personal access token): a Bearer header on the webapp's same-origin fetch/XHR calls
     only, plus an `MMUSERID` cookie, with no `MMAUTHTOKEN` cookie. Mattermost reads the cookie before the header, and
     cookie sessions need CSRF on every write. The websocket, images (avatars, file previews) and downloads are not
     authenticated in this mode, so use `VERIFY_USER` / `VERIFY_PASSWORD` for anything that depends on them.
   - Never write credentials into the plan.
2. **Plan:** write a plan of at most 10 steps (`MAX_STEPS`). The format is in the header of `verify_ui.mjs`. `goto`
   takes a path (`/team/channels/town-square`), never a URL.
   - First run `node <this dir>/scripts/verify_ui.mjs --feature-map <route or feature>` from the repository. If the
     repository has a `.claude/skills/verify/FEATURE_MAP.md` (or `$VERIFY_FEATURE_MAP`), it prints the matching
     sections: use their routes and stable `data-testid` / ARIA names instead of guessing. Without a map, plan from
     snapshots.
   - Locate by role and accessible name first; use `testid`/`css` only when there is no accessible name. Locators are
     **strict by default** (an ambiguous locator fails instead of silently picking `.first()`; pass `"nth": 0` only when
     multiple matches are intended).
   - Pointer drag & mid-drag unmount: use `{"drag": {"from": LOC, "to": LOC | "dx": N, "dy": N, "release": false}}`
     followed by navigation/click/Escape and `{"mouse_up": true}`.
   - API calls (`capture.api` and `expect.api`): support `GET`, `POST`, `PUT`, `PATCH`, `DELETE` plus JSON `body`
     (<= 64 KB); `X-CSRF-Token` is attached automatically from `MMCSRF` under password login. Use `capture.save`
     (`{"capture": {"api": "/api/v4/teams", "save": {"team_id": "[0].id"}}}`) and `$team_id` in later paths or bodies.
     Plans that contain only `capture` steps and `expect.api` checks skip Chromium automatically (<200 ms).
   - Add a `snapshot` step scoped to the region you need (e.g. `{"role": "dialog"}`), not the whole page. The default
     scope is `#app-content`. Open menus, dialogs and listboxes render in React portals outside it and are always
     appended as `portal [role=…]:` blocks, so click their items by role and name as usual.
   - Stay on the server under test. Other origins are blocked, and a redirect, navigation or websocket to one fails
     the run; add `allow_origins` only for assets the app really loads.
   - Admin console: a button that tests a setting (Test Live URL, Test Connection) tests the **saved** value: save first,
     or the page answers "Please save unsaved changes first". Match the server's own error text in `expect`, never
     a prefix that the page's other messages share.
   - `expect` must hold at least one deterministic check: a DOM assertion (`visible`, `text` + `contains`,
     `count` + `min`) or an `/api/v4/` check (`api.path`, `method?`, `body?`, `status?`, `json_has?`). Choose checks
     that would fail if the change were broken. On `FAIL`, buffered `console.error` and `/api/v4/` 4xx responses are
     printed automatically to speed up debugging.
3. **Run:** `node <this dir>/scripts/verify_ui.mjs plan.json` from a directory where `require("playwright")` resolves
   (e.g. `mattermost/e2e-tests/playwright`), or with `NODE_PATH` pointing at a `node_modules` that has it.
   - Exit 0 `PASS`.
   - Exit 1 `FAIL`: an assertion failed, the page threw (`pageerror`), an `/api/v4/` call returned >= 500, a request
     was still running at the settle deadline, or the page left the allowed origins. Each one fails automatically.
   - Exit 2: `INVALID_PLAN` (fix the plan) or `INFRA_ERROR` (fix the environment; never report it as a finding).
   - Add `--freeze <dir>/<name>.spec.ts` once the plan passes. It writes a plain `@playwright/test` spec with the
     same oracle, which reruns in CI with no model and no tokens. Offer it to the user; do not commit it unasked.
     Optional `"covers": ["path/..."]` and `"verified_at": "<sha>"` keys emit `// covers:` and `// verified-at:` headers for drift tracking.
   - Freeze into a dedicated folder (e.g. `e2e-tests/playwright/specs/verify/`), never `/tmp`, and rerun it from
     there: with no config, Playwright collects tests from every file under the current folder. The spec checks the
     server this run checked; `VERIFY_REPLAY_BASE_URL` points it at another one.
   - If a click times out, the reason from Playwright's call log is appended (e.g. an onboarding overlay that
     "intercepts pointer events"). If an open menu or modal hides the app, the snapshot says so: press Escape before
     checking app content.
4. **Iterate:** on `FAIL`, read the failure snapshot and fix the plan only when the plan was wrong (wrong name, wrong
   region). Never relax an `expect` to make it pass. Stop after 3 runs.
5. **Compare (differential oracle):** when a base server (before the change) and a head server (with it) are both
running, the oracle must come from code, not from you or the PR text. Add `{"capture": {"api": "/api/v4/config"}}`
steps (GET an `/api/v4/` path, record the body, assert nothing) and snapshots, keep at least one `expect`, then run
`node <this dir>/scripts/verify_ui.mjs plan.json --compare <base_url>`; the usual target (`VERIFY_BASE_URL` / `base_url`)
is the head. Same steps, same credentials, both servers. Ids, timestamps, version/build fields and origins are
normalised away; add `"ignore": ["json.path"]` for other known noise.
- Output: `DIFF <step#> <json-path>: base=<v> head=<v>` lines, then `VERDICT: SAME` (exit 0), `DIFF` or `REGRESSION`
(an `expect` passes on base, fails on head; exit 1), `FAIL` (a step failed; page errors and 5xx are diffed, not fatal, so noise both servers share is not a difference) or exit 2 `INVALID_PLAN` /
`INFRA_ERROR`. `--freeze` is not supported with `--compare`.
- **Rule:** every `DIFF` must be explained by the PR (the diff or its description names that field or behaviour) or it
is a finding: report path, base value, head value. Never add an `ignore` just to silence one. A diff between two
different releases also holds version noise; judge each line, do not dismiss them all.
- The runner pre-sets `__landingPageSeen__` in localStorage, so logged-in plans land on the app instead of the
"Where would you like to view this?" desktop-app prompt.
6. **Report in chat:** the plan, the verdict line, the snapshot lines that prove it, and the frozen spec path if any. A `FAIL` caused by the app is a
   finding: give the steps to reproduce it, and pair it with a passing nearby control case (e.g. valid control input or passing base build) to prove the harness and auth work.
