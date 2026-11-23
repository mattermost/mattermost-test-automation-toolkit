#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Text-only UI smoke check against a running Mattermost server. Takes no screenshot unless --screenshot-on-fail is
// given, and then exactly one, failure.png, only when the run FAILs, for a person to look at; the agent never reads it.
//
// usage: verify_ui.mjs <plan.json> [--freeze <dir>/<name>.spec.ts] [--screenshot-on-fail]
//        verify_ui.mjs <plan.json> --compare <base_url>
//        verify_ui.mjs --feature-map <route or feature> [FEATURE_MAP.md]
// Exit codes: 0 PASS, 1 FAIL (an expectation, a page error, a >= 500 /api/v4/ response, a request still running at the
// settle deadline, or leaving the allowed origins), 2 INVALID_PLAN or INFRA_ERROR. Errors print only their first line
// (plus, for an action that timed out, the reason from Playwright's call log, e.g. an overlay that intercepts clicks).
// Bounded by design: at most MAX_STEPS steps, allowed origins only (base_url plus allow_origins; other hosts are
// blocked, and a redirect, navigation or websocket to them fails the run; Chromium connects only through a local proxy
// that refuses other origins, so not even a redirect hop reaches them), every step and the final check wait for
// in-flight requests to settle, and success is a deterministic DOM or /api/v4/ check, never a model's judgement.
// --freeze writes a passing plan as a @playwright/test spec with the same oracle, so the check reruns with no model.
//
// Compare mode (--compare <base_url>): the differential oracle. The same plan runs against the usual target (the "head":
// plan.base_url / $VERIFY_BASE_URL / $MM_URL) and against <base_url> (the "base"), one after the other, with the same
// credentials env and the same steps. Code decides, never a model: every {"capture": {"api": PATH}} body, every snapshot
// and every expect result of the two runs is compared after normalisation (26-character ids, *_at / *At / timestamp
// fields, ISO dates and clock times, version / build fields, the two origins and any localhost / 127.0.0.1 port, plus the plan's
// "ignore" paths). Output is one `DIFF <step#> <json-path>: base=<v> head=<v>` line per difference (expects print as
// `DIFF expect<N> result: ...`), then one verdict line:
//   VERDICT: SAME        nothing differs                                                   exit 0
//   VERDICT: DIFF        only captures / snapshots / expects that fail on base but pass on head differ   exit 1
//   VERDICT: REGRESSION  an expect passes on base and fails on head                       exit 1
//   VERDICT: FAIL ...    a run itself failed (a step that fails, a request still running at the deadline, leaving the
//                        allowed origins). A base run that fails is reported as `FAIL base run failed`.   exit 1
// Unlike a plain run, compare mode does not stop at an unmet expect, a page error or a >= 500 /api/v4/ response: it records
// them and diffs them (`DIFF run problem: base=<absent> head="pageerror: ..."`), so noise that both servers share (e.g. a
// plugin that throws) is not a difference, and the same problem on only one side is.
//   VERDICT: INVALID_PLAN / INFRA_ERROR   (either server, named in the message)           exit 2
// The base URL comes from the command line only, never from the plan, so a plan cannot send credentials anywhere. A DIFF
// is not a failure by itself: explain each one from the PR, or it is a finding. --freeze is not supported with --compare.
//
// Landing page: before the first navigation the runner sets localStorage `__landingPageSeen__` on the server's origin, so
// the webapp does not redirect to the "Where would you like to view this?" desktop-app prompt (/landing). Mattermost
// reads it in BrowserStore.hasSeenLandingPage() (webapp/channels/src/stores/browser_store.tsx:75, constant
// StoragePrefixes.LANDING_PAGE_SEEN in utils/constants.tsx; checked in root.tsx's redirectToLandingPageIfNecessary,
// v11.0.2 root.tsx:147); any non-empty value counts, the app itself stores "true". Frozen specs set it the same way.
//
// Target (a server root, http or https, no user:password): plan.base_url, else $VERIFY_BASE_URL, else $MM_URL, else
// http://localhost:8065; a malformed environment value is INFRA_ERROR. With credentials set, a
// plan.base_url must have the same origin as $VERIFY_BASE_URL / $MM_URL / the default, so credentials never go to a
// host the plan chose. Frozen specs check the server the run checked; only $VERIFY_REPLAY_BASE_URL retargets them.
//
// Auth (API, before the first step, so no step is spent on the login form):
//   VERIFY_TOKEN                   session or personal access token: a Bearer header on same-origin fetch/XHR only
//                                  (fetched without following redirects) + the MMUSERID cookie; no cookie session, so
//                                  no CSRF; the webapp's websocket, images and downloads stay unauthenticated
//   VERIFY_USER + VERIFY_PASSWORD  POST /api/v4/users/login; the server sets MMAUTHTOKEN, MMUSERID and MMCSRF
// Frozen specs embed the same apiLogin() and read the same variables; a spec frozen from an anonymous run never sends
// VERIFY_TOKEN. VERIFY_SETTLE_MS (default 10000) bounds settling.
//
// Plan (unknown keys are rejected):
// {
//   "name": "what this checks",                  (optional; the frozen test's title)
//   "base_url": "http://localhost:8065",          (optional, http or https)
//   "login": true,                                (optional: INFRA_ERROR when no VERIFY_* credentials are set)
//   "covers": ["server/channels/api4/foo.go"],    (optional: single-line paths emitted as `// covers:` in --freeze)
//   "verified_at": "5e62cb1",                     (optional: single-line commit/ref emitted as `// verified-at:` in --freeze)
//   "scope": LOC,                                 (snapshot scope; default #app-content if present, else body. Open
//                                                  dialogs, menus and listboxes outside it are always appended.)
//   "allow_origins": ["https://cdn.example.com"], (extra origins the page may load)
//   "steps": [ at most MAX_STEPS of, each with exactly one action:
//     {"goto": "/team/channels/town-square"} (a path) | {"click": LOC} | {"fill": LOC, "value": "text"} |
//     {"press": "Enter", "on"?: LOC} | {"select": LOC, "value": "x"} | {"check": LOC} | {"wait_for": LOC} |
//     {"drag": {"from": LOC, "to": LOC | "dx": N, "dy": N, "release"?: false}} | {"mouse_up": true} |
//     {"snapshot": LOC | null} |
//     {"capture": {"api": "/api/v4/config" | {"path": "/api/v4/...", "method"?: "POST", "body"?: ...}, "save"?: {"id": "id"}}} ],
//   "ignore": ["json.path", ...],                 (optional, compare mode: capture paths to skip; "." joins keys, "[0]"
//                                                  indexes arrays, "*" matches any run of characters, a path also
//                                                  covers everything under it)
//   "expect": [ at least one of
//     {"visible": LOC} | {"text": LOC, "contains": "x"} | {"count": LOC, "min"?: 1} |
//     {"api": {"path": "/api/v4/users/me", "method"?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", "body"?: ...,
//              "status"?: 200, "json_has"?: {"username": "sysadmin"}}} ]
// }
// LOC: exactly one of {"role": "button", "name"?: "Save", "exact"?: true} | {"testid"} | {"label"} | {"placeholder"} |
//      {"text"} | {"css"}, plus an optional integer "nth" (not in "count", which counts every match). Locators are
//      strict by default: omitting "nth" requires a unique match.
// "capture" calls an /api/v4/ endpoint (same checks as api.path, same credentials, auto X-CSRF-Token on writes) and
// records the JSON body without asserting; optional "save" extracts scalar fields into $var for later paths/bodies.
// Plans with only "capture" steps and "expect.api" checks skip Chromium and run directly via Playwright APIRequestContext.
// "goto" and "api.path" are checked after URL resolution: they must stay on the server, and api.path under /api/v4/.

import {createRequire} from 'node:module';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_STEPS = 10;
const ACTION_TIMEOUT_MS = 10000;
const SNAPSHOT_CHARS = 4000;
const QUIET_MS = 300;
const DEFAULT_SETTLE_MS = 10000;
const DEFAULT_BASE = 'http://localhost:8065';
const LOC_KINDS = ['role', 'testid', 'label', 'placeholder', 'text', 'css'];
const STEP_EXTRAS = {goto: [], click: [], fill: ['value'], press: ['on'], select: ['value'], check: [], wait_for: [],
    drag: [], mouse_up: [], snapshot: [], capture: []};
const EXPECT_EXTRAS = {visible: [], text: ['contains'], count: ['min'], api: []};
const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_BODY_BYTES = 65536;
const MAX_DRAG_OFFSET = 2000;
const VAR_NAME_RE = /^[A-Za-z_]\w*$/;
const VAR_REF_RE = /\$([A-Za-z_]\w*)/g;
const URL_VAR_VAL_RE = /^[A-Za-z0-9._-]+$/;
const TOP_KEYS = ['name', 'base_url', 'login', 'scope', 'allow_origins', 'steps', 'expect', 'ignore', 'covers', 'verified_at'];
const MAX_DIFFS = 200;

class PlanError extends Error {}
class InfraError extends Error {}

const firstLine = (err) => String(err instanceof Error ? err.message : err).split('\n')[0];

// Why an action timed out, from Playwright's call log (e.g. an overlay that "intercepts pointer events"). The call log
// is otherwise never printed: it can list request headers.
function actionHint(err) {
    const lines = String(err instanceof Error ? err.message : err).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
    const why = lines.reverse().find((l) => /intercepts pointer events|is not visible|is not enabled|outside of the viewport|not stable/.test(l));
    return why ? ` (${why.replace(/^- /, '').slice(0, 240)})` : '';
}

function loadPlaywright() {
    // The caller's project first (e.g. mattermost/e2e-tests), then this script's location and NODE_PATH.
    for (const from of [path.join(process.cwd(), 'noop.js'), import.meta.url]) {
        try {
            return createRequire(from)('playwright');
        } catch {
            // try the next location
        }
    }
    throw new InfraError('playwright not found: run from a directory where `require("playwright")` resolves, or set NODE_PATH');
}

// ---------------------------------------------------------------- plan validation

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

function httpOrigin(url, what) {
    let u;
    try {
        u = new URL(url);
    } catch {
        throw new PlanError(`${what} is not an absolute URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new PlanError(`${what} must be http or https (got ${u.protocol})`);
    }
    if (u.username || u.password) {
        throw new PlanError(`${what} must not contain user:password (it would be logged and frozen into specs)`);
    }
    if (u.pathname !== '/' || u.search || u.hash) {
        // Plans use server-root paths (/api/v4/..., /team/channels/...); a subpath site URL is not supported.
        throw new PlanError(`${what} must be a server root such as https://host:8065 (got path ${u.pathname})`);
    }
    return u.origin;
}

// A plan path resolves the way the browser will resolve it (tabs and newlines dropped, dot segments applied) and must
// stay on the server under test.
function staysOn(p, origin) {
    try {
        return new URL(p, origin).origin === origin;
    } catch {
        return false;
    }
}

// Checked after URL resolution too: "/api/v4/../../x" or a stray tab must not reach a non-API handler.
// When `allowVars` is true (plan validation), `$var` placeholders are treated as safe path tokens and re-checked at runtime.
function isApiPath(p, origin, allowVars = false) {
    if (!nonEmpty(p)) {
        return false;
    }
    const probe = allowVars ? p.replace(VAR_REF_RE, 'x') : p;
    return probe.startsWith('/api/v4/') && staysOn(probe, origin) && new URL(probe, origin).pathname.startsWith('/api/v4/');
}

function checkApiSpec(spec, origin, where, allowExpectKeys = false) {
    const allowedKeys = allowExpectKeys ? ['path', 'method', 'body', 'status', 'json_has'] : ['path', 'method', 'body'];
    if (!isObj(spec) || Object.keys(spec).some((k) => !allowedKeys.includes(k))) {
        throw new PlanError(`${where}: api takes only ${allowedKeys.join(', ')}`);
    }
    if (!isApiPath(spec.path, origin, true)) {
        throw new PlanError(`${where}: api.path must be a path under /api/v4/ (got ${JSON.stringify(spec.path)})`);
    }
    if ('method' in spec && !(typeof spec.method === 'string' && API_METHODS.includes(spec.method.toUpperCase()))) {
        throw new PlanError(`${where}: api.method must be one of ${API_METHODS.join(', ')}`);
    }
    if ('body' in spec) {
        let encoded;
        try {
            encoded = JSON.stringify(spec.body);
        } catch {
            throw new PlanError(`${where}: api.body must be JSON-serializable`);
        }
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) {
            throw new PlanError(`${where}: api.body must be <= ${MAX_BODY_BYTES} bytes`);
        }
    }
}

function checkDrag(drag, where) {
    if (!isObj(drag)) {
        throw new PlanError(`${where}: drag must be an object`);
    }
    const unknown = Object.keys(drag).filter((k) => !['from', 'to', 'dx', 'dy', 'release'].includes(k));
    if (unknown.length) {
        throw new PlanError(`${where}: unknown drag key(s) ${unknown.join(', ')}`);
    }
    checkLocator(drag.from, `${where} drag.from`);
    const hasTo = 'to' in drag;
    const hasDelta = 'dx' in drag || 'dy' in drag;
    if (hasTo === hasDelta) {
        throw new PlanError(`${where}: drag needs either "to" or numeric "dx"/"dy" (not both)`);
    }
    if (hasTo) {
        checkLocator(drag.to, `${where} drag.to`);
    } else {
        for (const axis of ['dx', 'dy']) {
            if (axis in drag && !(typeof drag[axis] === 'number' && Number.isFinite(drag[axis]) && Math.abs(drag[axis]) <= MAX_DRAG_OFFSET)) {
                throw new PlanError(`${where}: drag.${axis} must be a finite number in [-${MAX_DRAG_OFFSET}, ${MAX_DRAG_OFFSET}]`);
            }
        }
    }
    if ('release' in drag && typeof drag.release !== 'boolean') {
        throw new PlanError(`${where}: drag.release must be true or false`);
    }
}

function checkLocator(loc, where) {
    if (!isObj(loc)) {
        throw new PlanError(`${where}: locator must be an object`);
    }
    const kinds = Object.keys(loc).filter((k) => LOC_KINDS.includes(k));
    if (kinds.length !== 1) {
        throw new PlanError(`${where}: locator needs exactly one of ${LOC_KINDS.join(', ')}`);
    }
    const allowed = new Set([kinds[0], 'nth', ...(kinds[0] === 'role' ? ['name', 'exact'] : [])]);
    const unknown = Object.keys(loc).filter((k) => !allowed.has(k));
    if (unknown.length) {
        throw new PlanError(`${where}: unknown locator key(s) ${unknown.join(', ')}`);
    }
    if (!nonEmpty(loc[kinds[0]])) {
        throw new PlanError(`${where}: ${kinds[0]} must be a non-empty string`);
    }
    if ('name' in loc && !nonEmpty(loc.name)) {
        throw new PlanError(`${where}: name must be a non-empty string`);
    }
    if ('exact' in loc && typeof loc.exact !== 'boolean') {
        throw new PlanError(`${where}: exact must be true or false`);
    }
    if ('nth' in loc && !(Number.isInteger(loc.nth) && loc.nth >= 0)) {
        throw new PlanError(`${where}: nth must be an integer >= 0`);
    }
}

function exactlyOne(obj, table, where) {
    if (!isObj(obj)) {
        throw new PlanError(`${where} must be an object`);
    }
    const kinds = Object.keys(obj).filter((k) => Object.hasOwn(table, k));
    if (kinds.length !== 1) {
        throw new PlanError(`${where} needs exactly one of ${Object.keys(table).join(', ')} (got ${JSON.stringify(Object.keys(obj))})`);
    }
    const unknown = Object.keys(obj).filter((k) => k !== kinds[0] && !table[kinds[0]].includes(k));
    if (unknown.length) {
        throw new PlanError(`${where}: unknown key(s) ${unknown.join(', ')} for ${kinds[0]}`);
    }
    return kinds[0];
}

export function validatePlan(plan, env = process.env) {
    if (!isObj(plan)) {
        throw new PlanError('plan must be a JSON object');
    }
    const unknownTop = Object.keys(plan).filter((k) => !TOP_KEYS.includes(k));
    if (unknownTop.length) {
        throw new PlanError(`unknown plan key(s) ${unknownTop.join(', ')}`);
    }
    if ('name' in plan && !nonEmpty(plan.name)) {
        throw new PlanError('name must be a non-empty string');
    }
    if ('login' in plan && typeof plan.login !== 'boolean') {
        throw new PlanError('login must be true or false');
    }
    const envBase = env.VERIFY_BASE_URL || env.MM_URL || DEFAULT_BASE;
    let envOrigin;
    try {
        envOrigin = httpOrigin(envBase, 'VERIFY_BASE_URL / MM_URL');
    } catch (err) {
        throw new InfraError(firstLine(err));  // the environment is wrong, not the plan
    }
    const base = plan.base_url ?? envBase;
    const origin = plan.base_url === undefined ? envOrigin : httpOrigin(base, 'base_url');
    if (hasCredentials(env) && origin !== envOrigin) {
        throw new PlanError(`base_url ${origin} differs from ${new URL(envBase).origin}; credentials only go to VERIFY_BASE_URL / MM_URL`);
    }
    if ('scope' in plan) {
        checkLocator(plan.scope, 'scope');
    }
    if ('ignore' in plan && !(Array.isArray(plan.ignore) && plan.ignore.every(nonEmpty))) {
        throw new PlanError('ignore must be an array of non-empty json-path strings');
    }
    if ('covers' in plan && !(Array.isArray(plan.covers) && plan.covers.length > 0 && plan.covers.every((c) => nonEmpty(c) && !/[\r\n]/.test(c)))) {
        throw new PlanError('covers must be a non-empty array of single-line file paths');
    }
    if ('verified_at' in plan && !(nonEmpty(plan.verified_at) && !/[\r\n]/.test(plan.verified_at))) {
        throw new PlanError('verified_at must be a non-empty single-line string');
    }
    const allowOrigins = plan.allow_origins ?? [];
    if (!Array.isArray(allowOrigins)) {
        throw new PlanError('allow_origins must be an array');
    }
    const allowed = [origin, ...allowOrigins.map((o, i) => httpOrigin(o, `allow_origins[${i}]`))];
    if (!env.VERIFY_TOKEN && env.VERIFY_USER && env.VERIFY_PASSWORD) {
        // Cookies ignore the port: the session cookie would also go to another origin on the same host.
        const host = new URL(origin).hostname;
        const sameHost = allowed.slice(1).filter((o) => new URL(o).hostname === host);
        if (sameHost.length) {
            throw new PlanError(`allow_origins ${sameHost.join(', ')} is on the same host as ${origin}; with password login the session cookie would be sent there`);
        }
    }
    const steps = plan.steps ?? [];
    if (!Array.isArray(steps)) {
        throw new PlanError('steps must be an array');
    }
    if (steps.length > MAX_STEPS) {
        throw new PlanError(`plan has ${steps.length} steps; MAX_STEPS is ${MAX_STEPS}`);
    }
    steps.forEach((s, i) => {
        const where = `step ${i + 1}`;
        const action = exactlyOne(s, STEP_EXTRAS, where);
        if (action === 'goto') {
            // A path on the server under test ("/team/channels/x"), never a URL: a frozen spec must be able to target
            // another server, and plans never leave this one.
            const probe = typeof s.goto === 'string' ? s.goto.replace(VAR_REF_RE, 'x') : '';
            if (!nonEmpty(s.goto) || !probe.startsWith('/') || probe.startsWith('//') || probe.includes('\\') ||
                !staysOn(probe, origin)) {
                throw new PlanError(`${where}: goto must be a path starting with "/" (got ${JSON.stringify(s.goto)}); plans stay on the server under test`);
            }
        } else if (action === 'press') {
            if (!nonEmpty(s.press)) {
                throw new PlanError(`${where}: press must be a key name such as "Enter"`);
            }
            if ('on' in s) {
                checkLocator(s.on, `${where} on`);
            }
        } else if (action === 'drag') {
            checkDrag(s.drag, where);
        } else if (action === 'mouse_up') {
            if (s.mouse_up !== true) {
                throw new PlanError(`${where}: mouse_up must be true`);
            }
        } else if (action === 'snapshot') {
            if (s.snapshot !== null) {
                checkLocator(s.snapshot, where);
            }
        } else if (action === 'capture') {
            const keys = isObj(s.capture) ? Object.keys(s.capture) : [];
            if (!keys.includes('api') || keys.some((k) => !['api', 'save'].includes(k))) {
                throw new PlanError(`${where}: capture takes {"api": "/api/v4/..." | {path, method?, body?}, "save"?: {var: "json.path"}}`);
            }
            if (typeof s.capture.api === 'string') {
                if (!isApiPath(s.capture.api, origin, true)) {
                    throw new PlanError(`${where}: capture.api must be a path under /api/v4/ (got ${JSON.stringify(s.capture.api)})`);
                }
            } else {
                checkApiSpec(s.capture.api, origin, `${where} capture`);
            }
            if ('save' in s.capture) {
                if (!isObj(s.capture.save) || Object.entries(s.capture.save).some(([k, v]) => !VAR_NAME_RE.test(k) || !nonEmpty(v))) {
                    throw new PlanError(`${where}: capture.save must map identifier names to non-empty JSON paths`);
                }
            }
        } else {
            checkLocator(s[action], where);
            if ((action === 'fill' || action === 'select') && typeof s.value !== 'string') {
                throw new PlanError(`${where}: ${action} needs a string value`);
            }
        }
    });
    if (!Array.isArray(plan.expect) || plan.expect.length === 0) {
        throw new PlanError('expect must list at least one deterministic DOM or /api/v4/ check');
    }
    plan.expect.forEach((e, i) => {
        const where = `expect ${i + 1}`;
        const kind = exactlyOne(e, EXPECT_EXTRAS, where);
        if (kind === 'api') {
            const api = e.api;
            checkApiSpec(api, origin, where, true);
            if ('status' in api && !(Number.isInteger(api.status) && api.status >= 100 && api.status < 500)) {
                throw new PlanError(`${where}: api.status must be an integer from 100 to 499 (a server error always fails)`);
            }
            if ('json_has' in api && !isObj(api.json_has)) {
                throw new PlanError(`${where}: api.json_has must be an object`);
            }
            return;
        }
        checkLocator(e[kind], where);
        if (kind === 'text' && !nonEmpty(e.contains)) {
            throw new PlanError(`${where}: text needs a non-empty "contains"`);
        }
        if (kind === 'count' && 'nth' in e.count) {
            throw new PlanError(`${where}: count counts every match; nth is not allowed here`);
        }
        if (kind === 'count' && 'min' in e && !(Number.isInteger(e.min) && e.min >= 1)) {
            throw new PlanError(`${where}: min must be an integer >= 1 (0 would always pass)`);
        }
    });
    return {steps, base, origin, allowed};
}

function settleMs(env) {
    const raw = env.VERIFY_SETTLE_MS ?? String(DEFAULT_SETTLE_MS);
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new InfraError(`VERIFY_SETTLE_MS must be a positive number of milliseconds (got ${JSON.stringify(raw)})`);
    }
    return ms;
}

// ---------------------------------------------------------------- locators and snapshots

function locateAll(page, loc) {
    if (loc.role) {
        return page.getByRole(loc.role, loc.name === undefined ? {} : {name: loc.name, exact: Boolean(loc.exact)});
    }
    if (loc.testid) {
        return page.getByTestId(loc.testid);
    }
    if (loc.label) {
        return page.getByLabel(loc.label);
    }
    if (loc.placeholder) {
        return page.getByPlaceholder(loc.placeholder);
    }
    if (loc.text) {
        return page.getByText(loc.text);
    }
    return page.locator(loc.css);
}

// Strict by default: omitting `nth` requires a unique match so an ambiguous locator fails loudly instead of silently
// acting on or asserting the wrong element (pass `nth: 0` explicitly when multiple matches are intended).
function locate(page, loc) {
    const l = locateAll(page, loc);
    return loc.nth === undefined ? l : l.nth(loc.nth);
}

// Mattermost renders menus, modals, pickers and autocompletes in React portals at the end of <body>, outside
// #app-content. A snapshot scoped to the app would hide them, so every visible top-level portal outside the scope is
// appended to it.
const PORTAL_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"]';

const cap = (text) => (text.length > SNAPSHOT_CHARS ? `${text.slice(0, SNAPSHOT_CHARS)}\n... (truncated)` : text);

async function snapshot(page, loc) {
    const scope = loc ?? ((await page.locator('#app-content').count()) ? {css: '#app-content'} : {css: 'body'});
    const scoped = locate(page, scope);
    const parts = [cap(await scoped.ariaSnapshot({timeout: ACTION_TIMEOUT_MS}))];
    const scopeEl = await scoped.elementHandle();
    const portals = page.locator(PORTAL_SELECTOR);
    const n = await portals.count();
    for (let i = 0; i < n; i++) {
        const portal = portals.nth(i);
        if (!(await portal.isVisible())) {
            continue;
        }
        const outsideAndTopLevel = await portal.evaluate(
            (el, [s, sel]) => !(s && s.contains(el)) && !el.parentElement?.closest(sel), [scopeEl, PORTAL_SELECTOR]);
        if (outsideAndTopLevel) {
            parts.push(`portal [role=${await portal.getAttribute('role')}]:\n${cap(await portal.ariaSnapshot())}`);
        }
    }
    if (!parts[0].trim() && parts.length > 1) {
        // Mattermost's menus and modals set aria-hidden on the rest of the app while they are open.
        parts[0] = '(the scope is hidden from the accessibility tree while the portal below is open; close it, e.g. press Escape, to check app content)';
    }
    return parts.join('\n');
}

// ---------------------------------------------------------------- shared with frozen specs (copied via toString)

// Self-contained on purpose: --freeze copies this function's source into the generated spec, so frozen tests log in
// exactly the way the run that produced them did. Errors carry only Playwright's first line: the full message lists
// request headers, which would include the token.
export async function apiLogin(context, base, env) {
    const headers = {'X-Requested-With': 'XMLHttpRequest'};
    if (env.VERIFY_TOKEN) {
        const token = env.VERIFY_TOKEN;
        // A session cookie from a loaded storageState would win over the header and run as another user.
        await context.clearCookies({name: 'MMAUTHTOKEN'});
        let me;
        try {
            me = await context.request.get(new URL('/api/v4/users/me', base).toString(),
                {headers: {...headers, Authorization: `Bearer ${token}`}, maxRedirects: 0});
        } catch (err) {
            throw new Error(String(err instanceof Error ? err.message : err).split('\n')[0]);
        }
        if (!me.ok()) {
            throw new Error(`VERIFY_TOKEN rejected by GET /api/v4/users/me: HTTP ${me.status()}`);
        }
        const user = await me.json();
        // No MMAUTHTOKEN cookie: Mattermost reads that cookie before the Authorization header, and a cookie session
        // gets CSRF checks on every non-GET request, which a bare token cannot satisfy. With the token only in the
        // header the server authenticates by header and skips CSRF. MMUSERID tells the webapp it is signed in.
        await context.addCookies([{name: 'MMUSERID', value: user.id, url: base}]);
        const origin = new URL(base).origin;
        await context.route('**/*', async (route) => {
            const request = route.request();
            // Only the webapp's API calls (fetch/XHR) to the server under test carry the token. Pages and static
            // assets are served without auth and pass through untouched (fulfilling a document would also change
            // how Chromium classifies the page for local-network checks).
            if (new URL(request.url()).origin !== origin || !['fetch', 'xhr'].includes(request.resourceType())) {
                return route.fallback();
            }
            try {
                // Fetched here with the token and no redirect following: a redirect response goes back to the page
                // without the token, so the token never reaches another host.
                const response = await route.fetch({
                    headers: {...request.headers(), authorization: `Bearer ${token}`},
                    maxRedirects: 0,
                });
                return await route.fulfill({response});
            } catch {
                // A dropped connection or a closing context: fail the request quietly (the error would echo the
                // token header) and let the page's own error handling and the oracle report it.
                return route.abort('failed').catch(() => {});
            }
        });
        return `token auth as ${user.username} (Bearer header on same-origin API calls only)`;
    }
    let res;
    try {
        // maxRedirects: 0, so a 307/308 can never replay the password to another host.
        res = await context.request.post(new URL('/api/v4/users/login', base).toString(),
            {data: {login_id: env.VERIFY_USER, password: env.VERIFY_PASSWORD}, headers, maxRedirects: 0});
    } catch (err) {
        throw new Error(String(err instanceof Error ? err.message : err).split('\n')[0]);
    }
    if (!res.ok()) {
        throw new Error(`login as ${env.VERIFY_USER} failed: HTTP ${res.status()}`);
    }
    const names = new Set((await context.cookies(base)).map((c) => c.name));
    const missing = ['MMAUTHTOKEN', 'MMUSERID', 'MMCSRF'].filter((name) => !names.has(name));
    if (missing.length) {
        throw new Error(`login as ${env.VERIFY_USER} set no ${missing.join(', ')} cookie`);
    }
    return `password login as ${env.VERIFY_USER} (MMAUTHTOKEN, MMUSERID, MMCSRF set)`;
}

// Same semantics as Playwright's toMatchObject: objects may have extra keys, arrays must match element by element.
export function subset(want, got) {
    if (Array.isArray(want)) {
        return Array.isArray(got) && got.length === want.length && want.every((w, i) => subset(w, got[i]));
    }
    if (want !== null && typeof want === 'object') {
        return got !== null && typeof got === 'object' && !Array.isArray(got) &&
            Object.entries(want).every(([k, v]) => subset(v, got[k]));
    }
    return want === got; // JSON numbers: -0 equals 0, as in the response's own JSON
}

// Self-contained (--freeze copies it): a forward proxy on 127.0.0.1 that Chromium sends every connection through.
// Playwright's route() never sees redirect hops, so this is what keeps a redirect from even contacting an origin
// outside `allowed`: plain-http requests are checked by their absolute URL, CONNECT tunnels (https, ws, wss) by the
// host and port they name, and the tunnel goes to exactly that host and port. Refused targets get a 403 and are
// reported through onBlocked. An unreachable allowed server closes the client connection (no 502 page), so Chromium
// reports net::ERR_* and the runner can tell an infrastructure problem from an app failure. close() ends every
// connection it still holds, upstream sockets included.
export function startOriginGuard(httpMod, netMod, allowed, onBlocked) {
    // hop-by-hop headers belong to one connection and are never forwarded (RFC 9110, section 7.6.1)
    const hopByHop = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te',
        'trailer', 'transfer-encoding', 'upgrade'];
    const strip = (h) => {
        const out = {...h};
        const named = String(h.connection ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
        for (const k of [...hopByHop, ...named]) {
            delete out[k];
        }
        return out;
    };
    const closers = [() => {}];
    const server = httpMod.createServer((req, res) => {
        let target = null;
        try {
            target = new URL(req.url ?? '');
        } catch {
            target = null;
        }
        if (!target || target.protocol !== 'http:') {
            res.writeHead(400);
            res.end();
            return;
        }
        if (!allowed.has(target.origin)) {
            onBlocked(target.origin);
            res.writeHead(403);
            res.end();
            return;
        }
        const upstream = httpMod.request({host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80),
            method: req.method, path: target.pathname + target.search, headers: strip(req.headers)}, (up) => {
            res.writeHead(up.statusCode ?? 502, strip(up.headers));
            up.pipe(res);
        });
        upstream.on('error', () => res.destroy());
        res.on('close', () => upstream.destroy()); // the browser hung up or closed: never keep the upstream open
        req.pipe(upstream);
    });
    server.on('connection', (sock) => sock.on('error', () => sock.destroy()));
    server.on('connect', (req, client, head) => {
        // CONNECT names host:port exactly; anything else is refused, and the checked port is the one connected to.
        const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:/?#@[\]]+):(\d{1,5})$/.exec(req.url ?? '');
        const port = m ? Number(m[2]) : 0;
        if (!m || port < 1 || port > 65535) {
            client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        const origins = (() => {
            try {
                return [`https://${m[1]}:${port}`, `http://${m[1]}:${port}`].map((o) => new URL(o).origin);
            } catch {
                return [];
            }
        })();
        if (!origins.length || !origins.some((o) => allowed.has(o))) {
            if (origins.length) {
                onBlocked(origins[0]);
            }
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const up = (() => {
            try {
                return netMod.connect(port, m[1].replace(/^\[|\]$/g, ''));
            } catch {
                return null;
            }
        })();
        if (!up) {
            client.destroy();
            return;
        }
        up.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
                up.write(head);
            }
            up.pipe(client);
            client.pipe(up);
        });
        const end = () => {
            up.destroy();
            client.destroy();
        };
        up.on('error', end);
        up.on('close', end);
        client.on('error', end);
        client.on('close', end);
        closers.push(end);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                port: typeof addr === 'object' && addr ? addr.port : 0,
                close: () => {
                    for (const close of closers) {
                        close();
                    }
                    server.closeAllConnections();
                    server.close();
                },
            });
        });
    });
}

// Chromium switches, not Playwright's proxy option: the APIRequestContext (login, API checks) stays a direct
// connection with maxRedirects: 0, and '<-loopback>' sends localhost through the proxy too.
const guardArgs = (port) => [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>'];

const hasCredentials = (env) => Boolean(env.VERIFY_TOKEN || (env.VERIFY_USER && env.VERIFY_PASSWORD));

function originOf(url) {
    const u = new URL(url);
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
        return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null; // data:, blob:, about: are local
}

// ---------------------------------------------------------------- the run

// Runs in the page before any script (Playwright serialises it, so it must stay self-contained): the webapp redirects
// to /landing unless localStorage `__landingPageSeen__` is set. Only the server's own origin gets the key.
function landingPageSeen(origin) {
    try {
        if (location.origin === origin) {
            localStorage.setItem('__landingPageSeen__', 'true');
        }
    } catch {
        // about:blank or storage blocked: nothing to set
    }
}

function readJsonPath(obj, dotPath) {
    let cur = obj;
    for (const seg of dotPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
            return undefined;
        }
        cur = cur[seg];
    }
    return cur;
}

function expandPath(raw, origin, vars, mustBeApi) {
    const out = raw.replace(VAR_REF_RE, (_, name) => {
        if (!Object.hasOwn(vars, name)) {
            throw new Error(`unknown saved variable $${name}`);
        }
        const val = String(vars[name]);
        if (!URL_VAR_VAL_RE.test(val)) {
            throw new Error(`saved variable $${name} has unsafe URL token ${JSON.stringify(val)}`);
        }
        return val;
    });
    if (mustBeApi ? !isApiPath(out, origin) : (!out.startsWith('/') || out.startsWith('//') || out.includes('\\') || !staysOn(out, origin))) {
        throw new Error(`resolved path ${JSON.stringify(out)} left ${mustBeApi ? '/api/v4/' : origin}`);
    }
    return out;
}

function expandBody(val, vars) {
    if (typeof val === 'string') {
        return val.replace(VAR_REF_RE, (_, name) => {
            if (!Object.hasOwn(vars, name)) {
                throw new Error(`unknown saved variable $${name}`);
            }
            return String(vars[name]);
        });
    }
    if (Array.isArray(val)) {
        return val.map((v) => expandBody(v, vars));
    }
    if (isObj(val)) {
        return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, expandBody(v, vars)]));
    }
    return val;
}

async function runStep(page, base, origin, step, vars) {
    if ('goto' in step) {
        const target = expandPath(step.goto, origin, vars, false);
        await page.goto(new URL(target, base).toString(), {waitUntil: 'domcontentloaded'});
    } else if ('click' in step) {
        await locate(page, step.click).click();
    } else if ('fill' in step) {
        await locate(page, step.fill).fill(step.value);
    } else if ('press' in step) {
        await (step.on ? locate(page, step.on).press(step.press) : page.keyboard.press(step.press));
    } else if ('select' in step) {
        await locate(page, step.select).selectOption(step.value);
    } else if ('check' in step) {
        await locate(page, step.check).check();
    } else if ('wait_for' in step) {
        await locate(page, step.wait_for).waitFor({state: 'visible'});
    } else if ('drag' in step) {
        const d = step.drag;
        const src = await locate(page, d.from).boundingBox();
        if (!src) {
            throw new Error(`drag source has no bounding box: ${JSON.stringify(d.from)}`);
        }
        const sx = src.x + src.width / 2;
        const sy = src.y + src.height / 2;
        let tx;
        let ty;
        if (d.to) {
            const dst = await locate(page, d.to).boundingBox();
            if (!dst) {
                throw new Error(`drag target has no bounding box: ${JSON.stringify(d.to)}`);
            }
            tx = dst.x + dst.width / 2;
            ty = dst.y + dst.height / 2;
        } else {
            tx = sx + (d.dx ?? 0);
            ty = sy + (d.dy ?? 0);
        }
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(tx, ty, {steps: 5});
        if (d.release !== false) {
            await page.mouse.up();
        }
    } else if ('mouse_up' in step) {
        await page.mouse.up();
    }
}

// Waits until no request has been in flight for QUIET_MS, at most `limit` ms; a request still running then fails the
// run, so a slow response can never be skipped into a PASS. page.waitForLoadState('networkidle') cannot do this: it
// returns at once on a page that already reached that state, missing requests a click starts.
async function settle(page, limit) {
    const start = Date.now();
    let quietSince = page.inflight.size ? 0 : Date.now();
    while (Date.now() - start < limit) {
        await page.waitForTimeout(50);
        if (page.inflight.size) {
            quietSince = 0;
        } else if (!quietSince) {
            quietSince = Date.now();
        } else if (Date.now() - quietSince >= QUIET_MS) {
            return null;
        }
    }
    if (!page.inflight.size) {
        return null;
    }
    const urls = [...page.inflight].map((r) => `${r.method()} ${new URL(r.url()).pathname}`).slice(0, 5);
    return `${page.inflight.size} request(s) still in flight after ${limit}ms: ${urls.join(', ')}`;
}

// Errors that mean the plan is wrong (a malformed selector, an unknown key name), not that the app is.
function planMistake(err) {
    return /Unknown key: |is not a valid selector|while parsing (?:css )?selector|Unexpected token .* selector|Failed to parse/i
        .test(firstLine(err));
}

// Re-reads until `ok` holds or ACTION_TIMEOUT_MS passes, like Playwright's expect.poll in frozen specs; returns the
// last value read.
async function poll(read, ok) {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    let value = await read();
    while (!ok(value) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        value = await read();
    }
    return value;
}

// Browser-less login for API-only plans (same semantics as apiLogin, using APIRequestContext directly).
async function apiOnlyLogin(reqCtx, base, env) {
    const headers = {'X-Requested-With': 'XMLHttpRequest'};
    if (env.VERIFY_TOKEN) {
        let me;
        try {
            me = await reqCtx.get(new URL('/api/v4/users/me', base).toString(),
                {headers: {...headers, Authorization: `Bearer ${env.VERIFY_TOKEN}`}, maxRedirects: 0});
        } catch (err) {
            throw new Error(firstLine(err));
        }
        if (!me.ok()) {
            throw new Error(`VERIFY_TOKEN rejected by GET /api/v4/users/me: HTTP ${me.status()}`);
        }
        const user = await me.json();
        return `token auth as ${user.username} (API-only, no browser)`;
    }
    let res;
    try {
        res = await reqCtx.post(new URL('/api/v4/users/login', base).toString(),
            {data: {login_id: env.VERIFY_USER, password: env.VERIFY_PASSWORD}, headers, maxRedirects: 0});
    } catch (err) {
        throw new Error(firstLine(err));
    }
    if (!res.ok()) {
        throw new Error(`login as ${env.VERIFY_USER} failed: HTTP ${res.status()}`);
    }
    const state = await reqCtx.storageState();
    const names = new Set((state.cookies ?? []).map((c) => c.name));
    const missing = ['MMAUTHTOKEN', 'MMUSERID', 'MMCSRF'].filter((name) => !names.has(name));
    if (missing.length) {
        throw new Error(`login as ${env.VERIFY_USER} set no ${missing.join(', ')} cookie`);
    }
    return `password login as ${env.VERIFY_USER} (API-only, no browser)`;
}

async function csrfHeader(reqHost, base, env) {
    if (env.VERIFY_TOKEN) {
        return {};
    }
    const cookies = typeof reqHost.cookies === 'function'
        ? await reqHost.cookies(base)
        : ((await reqHost.storageState()).cookies ?? []);
    const csrf = cookies.find((c) => c.name === 'MMCSRF');
    return csrf ? {'X-CSRF-Token': csrf.value} : {};
}

// No redirects: an answer from another host must never satisfy an expectation or be captured.
async function apiCall(reqHost, base, origin, spec, env, vars) {
    const rawSpec = typeof spec === 'string' ? {path: spec} : spec;
    const method = (rawSpec.method ?? 'GET').toUpperCase();
    const apiPath = expandPath(rawSpec.path, origin, vars, true);
    const body = 'body' in rawSpec ? expandBody(rawSpec.body, vars) : undefined;
    const auth = env.VERIFY_TOKEN ? {Authorization: `Bearer ${env.VERIFY_TOKEN}`} : {};
    const csrf = method !== 'GET' ? await csrfHeader(reqHost, base, env) : {};
    const req = reqHost.request ?? reqHost;
    const opts = {method, headers: {'X-Requested-With': 'XMLHttpRequest', ...auth, ...csrf}, maxRedirects: 0};
    if (body !== undefined) {
        opts.data = body;
    }
    const res = await req.fetch(new URL(apiPath, base).toString(), opts);
    return {res, method, apiPath};
}

// A {"capture": {"api": PATH | {path, method?, body?}, "save"?: {...}}} step: records status and body, asserts nothing.
async function captureApi(reqHost, base, origin, capSpec, env, vars) {
    const {res, method, apiPath} = await apiCall(reqHost, base, origin, capSpec.api, env, vars);
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    if (capSpec.save) {
        for (const [name, dotPath] of Object.entries(capSpec.save)) {
            const val = readJsonPath(json, dotPath);
            if (val === undefined || val === null || typeof val === 'object') {
                throw new Error(`capture.save.${name}: path ${JSON.stringify(dotPath)} not found as scalar in ${method} ${apiPath} (HTTP ${res.status()})`);
            }
            vars[name] = String(val);
        }
    }
    return {path: apiPath, method, status: res.status(), json, text: json === undefined ? text : undefined};
}

async function checkExpect(reqHost, page, base, origin, e, env, vars) {
    if (e.visible) {
        const ok = await locate(page, e.visible).waitFor({state: 'visible', timeout: ACTION_TIMEOUT_MS}).then(() => true, (err) => {
            if (err?.name === 'TimeoutError') {
                return false;
            }
            throw err;
        });
        return ok ? null : `not visible within ${ACTION_TIMEOUT_MS}ms: ${JSON.stringify(e.visible)}`;
    }
    if (e.text) {
        const got = await poll(() => locate(page, e.text).innerText({timeout: ACTION_TIMEOUT_MS}), (t) => t.includes(e.contains));
        return got.includes(e.contains) ? null : `text of ${JSON.stringify(e.text)} is ${JSON.stringify(got.slice(0, 200))}, want it to contain ${JSON.stringify(e.contains)}`;
    }
    if (e.count) {
        const min = e.min ?? 1;
        const n = await poll(() => locateAll(page, e.count).count(), (c) => c >= min);
        return n >= min ? null : `count of ${JSON.stringify(e.count)} is ${n}, want >= ${min}`;
    }
    const {res, method, apiPath} = await apiCall(reqHost, base, origin, e.api, env, vars);
    if (res.status() >= 500) {
        return `${method} ${apiPath} returned ${res.status()}; a server error never satisfies an expectation`;
    }
    const status = e.api.status ?? 200;
    if (res.status() !== status) {
        return `${method} ${apiPath} returned ${res.status()}, want ${status}`;
    }
    if (e.api.json_has) {
        const body = await res.json().catch(() => null);
        if (!subset(e.api.json_has, body)) {
            return `${method} ${apiPath} body lacks ${JSON.stringify(e.api.json_has)}: ${JSON.stringify(body).slice(0, 300)}`;
        }
    }
    return null;
}

async function reachable(reqHost, base) {
    try {
        const req = reqHost.request ?? reqHost;
        await req.get(new URL('/api/v4/system/ping', base).toString(), {timeout: 5000, maxRedirects: 0});
        return true;
    } catch {
        return false;
    }
}

// `record` ({captures: [], snapshots: [], expects: [], problems: []}) is compare mode: what each step saw is stored for
// diffing, and an unmet expect, a page error or a >= 500 /api/v4/ response is recorded instead of ending the run (a step
// that fails, a request still running at the deadline and leaving the allowed origins still end it).
export async function verify(plan, log = console.log, freezeTo = null, env = process.env,
    {screenshotOnFail = null, record = null} = {}) {
    const {steps, base, origin, allowed} = validatePlan(plan, env);
    const limit = settleMs(env);
    const authed = hasCredentials(env);
    if (plan.login && !authed) {
        throw new InfraError('login required but neither VERIFY_TOKEN nor VERIFY_USER + VERIFY_PASSWORD is set');
    }
    const allowedSet = new Set(allowed);
    const scope = plan.scope ?? null;
    const needsBrowser = steps.some((s) => !('capture' in s)) || plan.expect.some((e) => !e.api);
    const {chromium, request} = loadPlaywright();
    const problems = [];
    const diagnostics = [];
    const blocked = new Set();
    const vars = {};
    let guard = null;
    let browser = null;
    let apiCtx = null;
    let page = null;
    let reqHost = null;
    if (needsBrowser) {
        guard = await startOriginGuard(http, net, allowedSet, (o) => blocked.add(o));
        try {
            browser = await chromium.launch({args: guardArgs(guard.port)});
        } catch (err) {
            guard.close();
            throw new InfraError(`cannot start Chromium: ${firstLine(err)}`);
        }
    }
    const finish = async (code, reason = '', snap = '') => {
        if (blocked.size) {
            log(`blocked other origins: ${[...blocked].join(', ')} (add to allow_origins if the app needs them)`);
        }
        if (code === 1 && screenshotOnFail && page) {
            // Opt-in, failures only, exactly one file: visual proof for a person (an overlay, broken CSS). The agent
            // never reads it; the verdict and the text snapshot below stay the record.
            try {
                await page.screenshot({path: screenshotOnFail});
                log(`failure screenshot for people (not read by the agent): ${screenshotOnFail}`);
            } catch (err) {
                log(`failure screenshot not written: ${firstLine(err)}`);
            }
        }
        log(code === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL ${reason}`);
        if (code === 1 && diagnostics.length) {
            log(`diagnostics at failure:\n${diagnostics.slice(0, 15).join('\n')}`);
        }
        if (snap) {
            log(`scope snapshot at failure:\n${snap}`);
        }
        return code;
    };
    const failSnap = async () => (page ? await snapshot(page, scope).catch(() => '(no snapshot)') : '');
    try {
        if (needsBrowser) {
            const context = await browser.newContext({viewport: {width: 1280, height: 800}});
            reqHost = context;
            // Skip the "Where would you like to view this?" desktop-app landing (see the header): set before any page script.
            await context.addInitScript(landingPageSeen, origin);
            await context.route('**/*', (route) => {
                const o = originOf(route.request().url());
                if (o === null || allowedSet.has(o)) {
                    return route.continue();
                }
                blocked.add(o);
                return route.abort('blockedbyclient');
            });
            page = await context.newPage();
            page.inflight = new Set();
            const loading = new Set();  // frames with a navigation request in progress
            page.on('request', (r) => {
                page.inflight.add(r);
                if (r.isNavigationRequest()) {
                    loading.add(r.frame());
                }
                // Redirect hops are not routed, so the route above cannot block them: check every request here.
                const o = originOf(r.url());
                if (o !== null && !allowedSet.has(o)) {
                    blocked.add(o);
                    if (r.redirectedFrom()) {
                        problems.push(`redirected to a non-allowed origin: ${r.method()} ${o}`);
                    } else if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
                        problems.push(`navigated to a non-allowed origin: ${o}`);
                    }
                }
            });
            page.on('requestfinished', (r) => page.inflight.delete(r));
            page.on('requestfailed', (r) => page.inflight.delete(r));
            // A request the page cancels by loading another document never gets requestfinished/requestfailed; forget it
            // then. Only a real load counts: an in-page URL change (history.pushState) cancels nothing.
            page.on('framenavigated', (frame) => {
                if (!loading.delete(frame)) {
                    return;
                }
                for (const r of page.inflight) {
                    if (r.frame() === frame && !r.isNavigationRequest()) {
                        page.inflight.delete(r);
                    }
                }
            });
            page.on('websocket', (ws) => {
                const o = originOf(ws.url());
                if (o !== null && !allowedSet.has(o)) {
                    problems.push(`websocket to a non-allowed origin: ${o}`);
                }
            });
            page.setDefaultTimeout(ACTION_TIMEOUT_MS);
            // Compare mode records page errors and >= 500 /api/v4/ responses (a noisy plugin throws on both servers) and diffs
            // them; a run alone treats each as a failure. 4xx /api/v4/ and console.error are fail-only diagnostics.
            const soft = record ? record.problems : problems;
            page.on('pageerror', (err) => soft.push(`pageerror: ${firstLine(err)}`));
            page.on('console', (msg) => {
                if (msg.type() === 'error' && diagnostics.length < 20) {
                    diagnostics.push(`console.error: ${firstLine(msg.text())}`);
                }
            });
            page.on('response', (res) => {
                const pathname = new URL(res.url()).pathname;
                if (!pathname.startsWith('/api/v4/')) {
                    return;
                }
                if (res.status() >= 500) {
                    soft.push(`HTTP ${res.status()} from ${res.request().method()} ${pathname}`);
                } else if (res.status() >= 400 && diagnostics.length < 20) {
                    diagnostics.push(`HTTP ${res.status()} from ${res.request().method()} ${pathname}`);
                }
            });
            if (authed) {
                try {
                    log(await apiLogin(context, base, env));
                } catch (err) {
                    const msg = firstLine(err);
                    throw new InfraError(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|net::ERR_/.test(msg) ? `server unreachable at ${base}: ${msg}` : msg);
                }
            }
        } else {
            // Browser-less fast path: API-only plans skip Chromium and run directly on Playwright's APIRequestContext.
            apiCtx = await request.newContext();
            reqHost = apiCtx;
            if (authed) {
                try {
                    log(await apiOnlyLogin(apiCtx, base, env));
                } catch (err) {
                    const msg = firstLine(err);
                    throw new InfraError(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|net::ERR_/.test(msg) ? `server unreachable at ${base}: ${msg}` : msg);
                }
            }
        }
        const afterStep = async () => {
            if (!page) {
                return;
            }
            const late = await settle(page, limit);
            if (late) {
                problems.push(late);
            }
            const o = originOf(page.url());
            if (page.url().startsWith('chrome-error:') || (o !== null && !allowedSet.has(o))) {
                problems.push(`the page left the allowed origins: now on ${o ?? page.url()}`);
            }
        };
        for (const [i, step] of steps.entries()) {
            const label = `step ${i + 1}/${steps.length} ${JSON.stringify(step)}`;
            try {
                if ('snapshot' in step) {
                    const text = await snapshot(page, step.snapshot ?? scope);
                    record?.snapshots.push({step: i + 1, text});
                    log(`${label}\n${text}`);
                    continue;
                }
                if ('capture' in step) {
                    const got = await captureApi(reqHost, base, origin, step.capture, env, vars);
                    record?.captures.push({step: i + 1, ...got});
                    log(`${label} captured: HTTP ${got.status}, ${got.json === undefined ? 'not JSON' : 'JSON'}`);
                    continue;
                }
                await runStep(page, base, origin, step, vars);
                await afterStep();
            } catch (err) {
                const msg = firstLine(err);
                if (planMistake(err)) {
                    throw new PlanError(`${label}: ${msg}`);
                }
                if (/net::ERR_|ECONNREFUSED/.test(msg) && !(await reachable(reqHost, base))) {
                    throw new InfraError(`server unreachable at ${base}: ${msg}`);
                }
                return await finish(1, `${label} failed: ${problems.length ? `${problems.join('; ')}; ` : ''}${msg}${actionHint(err)}`, await failSnap());
            }
            if (problems.length) {
                return await finish(1, `${label}: ${problems.join('; ')}`, await failSnap());
            }
            log(`${label} ok`);
        }
        for (const [i, e] of plan.expect.entries()) {
            let why;
            try {
                why = await checkExpect(reqHost, page, base, origin, e, env, vars);
            } catch (err) {
                const msg = firstLine(err);
                if (planMistake(err)) {
                    throw new PlanError(`expect ${i + 1}: ${msg}`);
                }
                if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|net::ERR_/.test(msg) && !(await reachable(reqHost, base))) {
                    throw new InfraError(`server unreachable at ${base}: ${msg}`);
                }
                why = msg;
            }
            record?.expects.push({n: i + 1, ok: !why, why: why ?? null});
            if (why && record) {
                log(`expect ${i + 1} not met ${JSON.stringify(e)}: ${why}`);
            }
            if ((why && !record) || problems.length) {
                return await finish(1, `expect ${i + 1}: ${why ?? problems.join('; ')}`, await failSnap());
            }
            if (!why) {
                log(`expect ${i + 1} ok ${JSON.stringify(e)}`);
            }
        }
        // Late events (a 500 or page error after the last check) count too.
        await afterStep();
        if (problems.length) {
            return await finish(1, `after the checks: ${problems.join('; ')}`, await failSnap());
        }
        if (freezeTo) {
            try {
                writeFileSync(freezeTo, freeze(plan, base, allowed.slice(1), authed));
            } catch (err) {
                throw new InfraError(`cannot write ${freezeTo}: ${firstLine(err)}`);
            }
            const dir = path.dirname(path.resolve(freezeTo));
            log(`frozen to ${freezeTo}: rerun with \`cd ${JSON.stringify(dir)} && npx playwright test ${JSON.stringify(path.basename(freezeTo))}\` (no model needed)`);
            const real = (d) => {
                try {
                    return realpathSync(d);
                } catch {
                    return d;
                }
            };
            if ([os.tmpdir(), '/tmp'].map(real).includes(real(dir))) {
                // With no config Playwright collects tests from the whole current folder: /tmp can take a minute.
                log(`note: keep frozen specs in a dedicated folder (e.g. e2e-tests/playwright/specs/verify/), not ${dir}`);
            }
        }
        return await finish(0);
    } finally {
        await apiCtx?.dispose().catch(() => {});
        await browser?.close().catch(() => {});
        guard?.close();
    }
}

// ---------------------------------------------------------------- compare mode (--compare)

const ID_RE = /\b[ybndrfg8ejkmcpqxot1uwisza345h769]{26}\b/g;  // Mattermost ids: 26 characters of its base32 alphabet
const ISO_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi;  // times of day the webapp prints ("3:33 PM")
const DAY_RE = /\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/g;
const LOCAL_ORIGIN_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/g;
const TIME_KEY_RE = /(?:_at|At|^timestamp|^Timestamp)$/;
const VERSION_KEY_RE = /version|^build|^Build/i;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What differs between two servers on every run and means nothing: ids, dates, origins. `origins` are the two servers'.
export function normalizeText(text, origins = []) {
    let out = String(text);
    for (const o of origins) {
        out = out.replace(new RegExp(escapeRe(o), 'g'), '<origin>');
    }
    for (const o of origins) {
        out = out.replace(new RegExp(escapeRe(new URL(o).host), 'g'), '<host>');
    }
    return out.replace(LOCAL_ORIGIN_RE, '<origin>').replace(ID_RE, '<id>').replace(ISO_RE, '<date>')
        .replace(DAY_RE, '<date>').replace(CLOCK_RE, '<time>');
}

// A JSON value with the noise replaced by placeholders. A timestamp of 0 or null is kept: "never deleted" is a fact.
export function normalizeJson(value, origins = [], key = '') {
    if (Array.isArray(value)) {
        return value.map((v) => normalizeJson(v, origins));
    }
    if (isObj(value)) {
        // Keys that normalize to the same placeholder (e.g. Mattermost's id-keyed posts/users maps) must not drop
        // entries 2..N: keep every entry sorted deterministically by its normalized value under `<nk>#0`, `<nk>#1`, ...
        const grouped = new Map();
        for (const [k, v] of Object.entries(value)) {
            const nk = normalizeText(k, origins);
            if (!grouped.has(nk)) {
                grouped.set(nk, []);
            }
            grouped.get(nk).push(normalizeJson(v, origins, k));
        }
        const out = {};
        for (const [nk, vals] of grouped) {
            if (vals.length === 1) {
                out[nk] = vals[0];
            } else {
                const sorted = vals.map((val) => [JSON.stringify(val), val])
                    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
                sorted.forEach(([, val], idx) => {
                    out[`${nk}#${idx}`] = val;
                });
            }
        }
        return out;
    }
    if (TIME_KEY_RE.test(key) && (typeof value === 'string' || (typeof value === 'number' && value !== 0))) {
        return '<time>';
    }
    if (VERSION_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        return '<version>';
    }
    return typeof value === 'string' ? normalizeText(value, origins) : value;
}

function ignored(jsonPath, patterns) {
    return patterns.some((pat) => new RegExp(`^${pat.split('*').map(escapeRe).join('.*')}(?:$|[.\\[])`).test(jsonPath));
}

const show = (v) => {
    if (v === undefined) {
        return '<absent>';
    }
    const t = JSON.stringify(v);
    return t.length > 200 ? `${t.slice(0, 200)}...` : t;
};

// Leaf-level differences between two normalised JSON values: [{path, base, head}], "." joining keys and "[i]" indexes.
export function diffJson(base, head, ignore = [], at = '') {
    if (at && ignored(at, ignore)) {
        return [];
    }
    if (isObj(base) && isObj(head)) {
        return [...new Set([...Object.keys(base), ...Object.keys(head)])].flatMap((k) =>
            diffJson(base[k], head[k], ignore, at ? `${at}.${k}` : k));
    }
    if (Array.isArray(base) && Array.isArray(head)) {
        const n = Math.max(base.length, head.length);
        return Array.from({length: n}, (_, i) => diffJson(base[i], head[i], ignore, `${at}[${i}]`)).flat();
    }
    return JSON.stringify(base) === JSON.stringify(head) ? [] : [{path: at || '$', base, head}];
}

// Line-level difference of two normalised snapshots: lines only in one side, paired in order.
function diffLines(base, head) {
    const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
    const take = (from, other) => {
        const left = count(other);
        return from.filter((l) => {
            const n = left.get(l) ?? 0;
            left.set(l, n - 1);
            return n <= 0;
        });
    };
    const a = base.split('\n');
    const b = head.split('\n');
    const onlyBase = take(a, b);
    const onlyHead = take(b, a);
    return Array.from({length: Math.max(onlyBase.length, onlyHead.length)}, (_, i) => ({base: onlyBase[i], head: onlyHead[i]}));
}

// All differences between two recorded runs, as {step, path, base, head} (strings already shown).
export function diffRuns(base, head, origins, ignore = []) {
    const diffs = [];
    const add = (step, path, b, h) => diffs.push({step, path, base: b, head: h});
    const norm = (c) => (c.json === undefined ? normalizeText(c.text ?? '', origins) : normalizeJson(c.json, origins));
    for (const step of [...new Set([...base.captures, ...head.captures].map((c) => c.step))]) {
        const b = base.captures.find((c) => c.step === step);
        const h = head.captures.find((c) => c.step === step);
        if (b.status !== h.status) {
            add(step, 'status', b.status, h.status);
        }
        for (const d of diffJson(norm(b), norm(h), ignore)) {
            add(step, d.path, show(d.base), show(d.head));
        }
    }
    for (const b of base.snapshots) {
        const h = head.snapshots.find((x) => x.step === b.step);
        for (const d of diffLines(normalizeText(b.text, origins), normalizeText(h?.text ?? '', origins))) {
            add(b.step, 'snapshot', show(d.base), show(d.head));
        }
    }
    for (const b of base.expects) {
        const h = head.expects.find((x) => x.n === b.n);
        if (b.ok !== h?.ok) {
            const side = (x) => (x.ok ? 'PASS' : `FAIL (${x.why})`);
            add(`expect${b.n}`, 'result', side(b), side(h));
        }
    }
    const rest = [...head.problems];
    for (const b of base.problems.map((t) => normalizeText(t, origins))) {
        const at = rest.findIndex((t) => normalizeText(t, origins) === b);
        if (at >= 0) {
            rest.splice(at, 1);
        } else {
            add('run', 'problem', show(b), show(undefined));
        }
    }
    for (const h of rest) {
        add('run', 'problem', show(undefined), show(normalizeText(h, origins)));
    }
    return diffs;
}

function tagged(prefix, rec, log = console.log) {
    return (line) => {
        const text = String(line);
        if (text.startsWith('VERDICT: ')) {
            rec.verdict = text.slice('VERDICT: '.length);
        }
        log(`[${prefix}] ${text}`);
    };
}

// Runs the plan against the target (head) and `baseUrl`, and returns the exit code after printing the verdict.
export async function compare(plan, baseUrl, env = process.env, log = console.log) {
    const baseOrigin = httpOrigin(baseUrl, '--compare');
    // The base run uses the plan without its own base_url: the head target is the plan's or the environment's, the base
    // is the command line's, and both get the same credentials.
    const {base_url: _drop, ...basePlan} = plan;
    const baseEnv = {...env, VERIFY_BASE_URL: baseOrigin};
    const sides = [['base', basePlan, baseEnv], ['head', plan, env]];
    const origins = [];
    // Validate both sides upfront so an invalid head plan fails fast without running Chromium against base.
    for (const [name, p, e] of sides) {
        try {
            origins.push(validatePlan(p, e).origin);
        } catch (err) {
            const wrap = err instanceof PlanError ? PlanError : InfraError;
            throw new wrap(`${name} run: ${firstLine(err)}`);
        }
    }
    const recs = {};
    for (const [name, p, e] of sides) {
        const rec = {captures: [], snapshots: [], expects: [], problems: [], verdict: ''};
        recs[name] = rec;
        let code;
        try {
            code = await verify(p, tagged(name, rec, log), null, e, {record: rec});
        } catch (err) {
            const wrap = err instanceof PlanError ? PlanError : InfraError;
            throw new wrap(`${name} run: ${firstLine(err)}`);
        }
        if (code !== 0) {
            log(`VERDICT: FAIL ${name} run failed: ${rec.verdict.replace(/^FAIL /, '')}`);
            return 1;
        }
    }
    const diffs = diffRuns(recs.base, recs.head, origins, plan.ignore ?? []);
    for (const d of diffs.slice(0, MAX_DIFFS)) {
        log(`DIFF ${d.step} ${d.path}: base=${d.base} head=${d.head}`);
    }
    if (diffs.length > MAX_DIFFS) {
        log(`... ${diffs.length - MAX_DIFFS} more differences not shown`);
    }
    const regressions = recs.base.expects.filter((b) => b.ok && !recs.head.expects.find((h) => h.n === b.n)?.ok);
    log(`${diffs.length} difference(s) after normalising ids, timestamps, versions and origins; ${regressions.length} expect regression(s)`);
    const verdict = regressions.length ? 'REGRESSION' : diffs.length ? 'DIFF' : 'SAME';
    log(`VERDICT: ${verdict}`);
    return verdict === 'SAME' ? 0 : 1;
}

// ---------------------------------------------------------------- --freeze

function locatorCode(loc) {
    const q = JSON.stringify;
    if (loc.role) {
        return loc.name === undefined ? `page.getByRole(${q(loc.role)})` :
            `page.getByRole(${q(loc.role)}, {name: ${q(loc.name)}, exact: ${Boolean(loc.exact)}})`;
    }
    if (loc.testid) {
        return `page.getByTestId(${q(loc.testid)})`;
    }
    if (loc.label) {
        return `page.getByLabel(${q(loc.label)})`;
    }
    if (loc.placeholder) {
        return `page.getByPlaceholder(${q(loc.placeholder)})`;
    }
    if (loc.text) {
        return `page.getByText(${q(loc.text)})`;
    }
    return `page.locator(${q(loc.css)})`;
}

const one = (loc) => (loc.nth === undefined ? locatorCode(loc) : `${locatorCode(loc)}.nth(${Number(loc.nth)})`);

// The spec gets the runner's own startOriginGuard(); its one helper with an untyped parameter gets a type.
function typedGuard() {
    const src = startOriginGuard.toString();
    const typed = src.replace('const strip = (h) => {', 'const strip = (h: Record<string, string | string[] | undefined>) => {');
    if (typed === src) {
        throw new Error('startOriginGuard() changed; update typedGuard()');
    }
    return typed;
}

// The spec gets the runner's own subset(), with TypeScript types added to its signature (it is recursive, so a typed
// const cannot infer them).
function typedSubset() {
    const src = subset.toString();
    const typed = src.replace('function subset(want, got) {', 'function subset(want: any, got: any): boolean {');
    if (typed === src) {
        throw new Error('subset() signature changed; update typedSubset()');
    }
    return typed;
}

export function freeze(plan, base, allowOrigins = [], authed = false) {
    const q = JSON.stringify;
    const lines = [];
    const emittedSteps = (plan.steps ?? []).filter((s) => {
        if ('snapshot' in s) {
            return false;
        }
        if ('capture' in s) {
            const rawApi = typeof s.capture.api === 'string' ? {path: s.capture.api} : s.capture.api;
            return Boolean(s.capture.save) || (rawApi.method ?? 'GET').toUpperCase() !== 'GET';
        }
        return true;
    });
    const steps = emittedSteps.length;
    const expects = plan.expect.length;
    for (const s of plan.steps ?? []) {
        if ('goto' in s) {
            lines.push(`await page.goto(new URL(expandPath(${q(s.goto)}, false), BASE).toString(), {waitUntil: 'domcontentloaded'});`);
        } else if ('click' in s) {
            lines.push(`await ${one(s.click)}.click();`);
        } else if ('fill' in s) {
            lines.push(`await ${one(s.fill)}.fill(${q(s.value)});`);
        } else if ('press' in s) {
            lines.push(s.on ? `await ${one(s.on)}.press(${q(s.press)});` : `await page.keyboard.press(${q(s.press)});`);
        } else if ('select' in s) {
            lines.push(`await ${one(s.select)}.selectOption(${q(s.value)});`);
        } else if ('check' in s) {
            lines.push(`await ${one(s.check)}.check();`);
        } else if ('wait_for' in s) {
            lines.push(`await ${one(s.wait_for)}.waitFor({state: 'visible'});`);
        } else if ('drag' in s) {
            const d = s.drag;
            lines.push('{',
                `  const src = await ${one(d.from)}.boundingBox();`,
                "  expect(src, 'drag source has bounding box').not.toBeNull();",
                '  const sx = src!.x + src!.width / 2, sy = src!.y + src!.height / 2;');
            if (d.to) {
                lines.push(`  const dst = await ${one(d.to)}.boundingBox();`,
                    "  expect(dst, 'drag target has bounding box').not.toBeNull();",
                    '  const tx = dst!.x + dst!.width / 2, ty = dst!.y + dst!.height / 2;');
            } else {
                lines.push(`  const tx = sx + ${Number(d.dx ?? 0)}, ty = sy + ${Number(d.dy ?? 0)};`);
            }
            lines.push('  await page.mouse.move(sx, sy);',
                '  await page.mouse.down();',
                '  await page.mouse.move(tx, ty, {steps: 5});');
            if (d.release !== false) {
                lines.push('  await page.mouse.up();');
            }
            lines.push('}');
        } else if ('mouse_up' in s) {
            lines.push('await page.mouse.up();');
        } else if ('capture' in s) {
            const rawApi = typeof s.capture.api === 'string' ? {path: s.capture.api} : s.capture.api;
            const method = (rawApi.method ?? 'GET').toUpperCase();
            if (!s.capture.save && method === 'GET') {
                continue; // read-only captures without save are for --compare / the agent's eyes
            }
            const bodyArg = 'body' in rawApi ? `, expandBody(${q(rawApi.body)})` : '';
            lines.push('{', `  const res = await apiCall(page, expandPath(${q(rawApi.path)}, true), ${q(method)}${bodyArg});`);
            if (s.capture.save) {
                lines.push('  const data: unknown = await res.json();');
                for (const [k, dotPath] of Object.entries(s.capture.save)) {
                    lines.push(`  { const v = readJsonPath(data, ${q(dotPath)}); expect(v !== undefined && v !== null && typeof v !== 'object', ${q(`capture.save.${k}`)}).toBe(true); vars[${q(k)}] = String(v); }`);
                }
            }
            lines.push('}');
        } else {
            continue; // snapshots are for the agent's eyes; the frozen test asserts only the deterministic oracle
        }
        lines.push('await settle();');
    }
    for (const e of plan.expect) {
        if (e.visible) {
            lines.push(`await expect(${one(e.visible)}).toBeVisible({timeout: TIMEOUT});`);
        } else if (e.text) {
            lines.push(`await expect.poll(() => ${one(e.text)}.innerText(), {timeout: TIMEOUT}).toContain(${q(e.contains)});`);
        } else if (e.count) {
            lines.push(`await expect.poll(() => ${locatorCode(e.count)}.count(), {timeout: TIMEOUT}).toBeGreaterThanOrEqual(${Number(e.min ?? 1)});`);
        } else {
            const method = (e.api.method ?? 'GET').toUpperCase();
            const bodyArg = 'body' in e.api ? `, expandBody(${q(e.api.body)})` : '';
            lines.push('{', `  const res = await apiCall(page, expandPath(${q(e.api.path)}, true), ${q(method)}${bodyArg});`,
                "  expect(res.status(), 'no server error').toBeLessThan(500);",
                `  expect(res.status()).toBe(${Number(e.api.status ?? 200)});`);
            if (e.api.json_has) {
                lines.push(`  expect(subset(${q(e.api.json_has)}, await res.json())).toBe(true);`);
            }
            lines.push('}');
        }
    }
    lines.push('await settle(); // late events count too');
    const needsLogin = plan.login || authed;
    const login = needsLogin ? `
  expect(Boolean(process.env.VERIFY_TOKEN || (process.env.VERIFY_USER && process.env.VERIFY_PASSWORD)),
    'set VERIFY_TOKEN or VERIFY_USER + VERIFY_PASSWORD').toBe(true);
  // The runner's cookie rule, checked again for the replay target: cookies ignore the port, so with password login an
  // allowed origin on BASE's host would receive the session cookie.
  const host = new URL(BASE).hostname;
  const sameHost = [...ALLOWED].filter((o) => o !== new URL(BASE).origin && new URL(o).hostname === host);
  expect(Boolean(process.env.VERIFY_TOKEN) || sameHost.length === 0,
    \`allowed origins \${sameHost.join(', ')} share the host of \${BASE}; with password login the session cookie would be sent there\`).toBe(true);
  await apiLogin(context, BASE, process.env);` : '';
    // Contextual typing gives the copied functions typed parameters, so the spec passes `tsc --strict`.
    const loginFn = needsLogin ? `
// Same API login as verify_ui.mjs (copied from its apiLogin): no steps spent on the login form.
const apiLogin: (context: BrowserContext, base: string, env: NodeJS.ProcessEnv) => Promise<string> = ${apiLogin.toString()};
` : '';
    const metaLines = [
        ...(plan.covers?.length ? [`// covers: ${plan.covers.join(', ')}`] : []),
        ...(plan.verified_at ? [`// verified-at: ${plan.verified_at}`] : []),
    ];
    const metaBlock = metaLines.length ? `${metaLines.join('\n')}\n` : '';
    return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan, with the same oracle: allowed origins only, every step settles, and page
// errors, >= 500 /api/v4/ responses, requests still running at the deadline, or leaving the allowed origins fail.
// It checks the server the run checked; set VERIFY_REPLAY_BASE_URL to point it at another one.
${metaBlock}import {chromium, expect, test, type Browser, type BrowserContext, type Page, type Request} from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';

const BASE = process.env.VERIFY_REPLAY_BASE_URL || ${q(base)};
const AUTHED = ${needsLogin ? 'true' : 'false'}; // an anonymous plan stays anonymous even where VERIFY_TOKEN is set
const ALLOWED = new Set([new URL(BASE).origin, ...${q(allowOrigins)}.map((o: string) => new URL(o).origin)]);
const SETTLE_MS = Number(process.env.VERIFY_SETTLE_MS ?? ${DEFAULT_SETTLE_MS});
const QUIET_MS = ${QUIET_MS};
const TIMEOUT = ${ACTION_TIMEOUT_MS};

const originOf: (url: string) => string | null = ${originOf.toString()};
${typedSubset()}

// API calls of a signed-in plan carry the token or auto X-CSRF-Token on writes; errors keep only their first line.
async function apiCall(page: Page, path: string, method = 'GET', body?: unknown) {
  const token = AUTHED ? process.env.VERIFY_TOKEN : undefined;
  const auth: Record<string, string> = token ? {Authorization: \`Bearer \${token}\`} : {};
  let csrf: Record<string, string> = {};
  if (method !== 'GET' && !token) {
    const c = (await page.context().cookies(BASE)).find((x) => x.name === 'MMCSRF');
    if (c) {
      csrf = {'X-CSRF-Token': c.value};
    }
  }
  const opts: {method: string; headers: Record<string, string>; maxRedirects: number; data?: unknown} = {
    method,
    headers: {'X-Requested-With': 'XMLHttpRequest', ...auth, ...csrf},
    maxRedirects: 0,
  };
  if (body !== undefined) {
    opts.data = body;
  }
  try {
    return await page.request.fetch(new URL(path, BASE).toString(), opts);
  } catch (err) {
    throw new Error(String(err instanceof Error ? err.message : err).split('\\n')[0]);
  }
}

function readJsonPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotPath.replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
${loginFn}
// Same origin guard as verify_ui.mjs (copied from its startOriginGuard): Chromium connects only through this local
// proxy, so a redirect hop never reaches an origin outside ALLOWED.
const startOriginGuard: (httpMod: typeof http, netMod: typeof net, allowed: Set<string>, onBlocked: (origin: string) => void) =>
  Promise<{port: number, close: () => void}> = ${typedGuard()};

let browser: Browser | undefined;
let guard: {port: number, close: () => void} | undefined;
test.afterEach(async () => {
  try {
    await browser?.close();
  } finally {
    guard?.close();
    browser = undefined;
    guard = undefined;
  }
});

test(${q(plan.name ?? 'frozen /verify plan')}, async () => {
  expect(Number.isFinite(SETTLE_MS) && SETTLE_MS > 0, 'VERIFY_SETTLE_MS must be a positive number').toBe(true);
  // As long as the runner may take: login, every step and expectation at their limits, and the final settle.
  test.setTimeout(60000 + ${steps} * (TIMEOUT + SETTLE_MS) + ${expects} * TIMEOUT + SETTLE_MS);
  const vars: Record<string, string> = {};
  const expandPath = (raw: string, mustBeApi: boolean): string => {
    const out = raw.replace(/\\$([A-Za-z_][A-Za-z0-9_]*)/g, (_: string, name: string) => {
      expect(Object.prototype.hasOwnProperty.call(vars, name), \`unknown saved variable $\${name}\`).toBe(true);
      const val = vars[name];
      expect(/^[A-Za-z0-9._~-]+$/.test(val), \`saved variable $\${name} has unsafe URL token\`).toBe(true);
      return val;
    });
    const u = new URL(out, BASE);
    expect(u.origin, \`path \${out} left \${BASE}\`).toBe(new URL(BASE).origin);
    if (mustBeApi) {
      expect(u.pathname.startsWith('/api/v4/'), \`path \${out} left /api/v4/\`).toBe(true);
    }
    return out;
  };
  const expandBody = (val: unknown): unknown => {
    if (typeof val === 'string') {
      return val.replace(/\\$([A-Za-z_][A-Za-z0-9_]*)/g, (_: string, name: string) => {
        expect(Object.prototype.hasOwnProperty.call(vars, name), \`unknown saved variable $\${name}\`).toBe(true);
        return vars[name];
      });
    }
    if (Array.isArray(val)) {
      return val.map((v) => expandBody(v));
    }
    if (val !== null && typeof val === 'object') {
      const rec = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec)) {
        out[k] = expandBody(rec[k]);
      }
      return out;
    }
    return val;
  };
  guard = await startOriginGuard(http, net, ALLOWED, () => {});
  browser = await chromium.launch({args: [\`--proxy-server=http://127.0.0.1:\${guard.port}\`, '--proxy-bypass-list=<-loopback>']});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  // Skip the webapp's desktop-app landing page, as verify_ui.mjs does.
  await context.addInitScript((origin: string) => {
    try {
      if (location.origin === origin) {
        localStorage.setItem('__landingPageSeen__', 'true');
      }
    } catch {
      // about:blank or storage blocked
    }
  }, new URL(BASE).origin);
  const page = await context.newPage();
  const problems: string[] = [];
  const inflight = new Set<Request>();
  await context.route('**/*', (route) => {
    const origin = originOf(route.request().url());
    return origin === null || ALLOWED.has(origin) ? route.continue() : route.abort('blockedbyclient');
  });
  const loading = new Set<unknown>();
  page.on('request', (r) => {
    inflight.add(r);
    if (r.isNavigationRequest()) {
      loading.add(r.frame());
    }
    const origin = originOf(r.url());
    if (origin !== null && !ALLOWED.has(origin) && r.redirectedFrom()) {
      problems.push(\`redirected to a non-allowed origin: \${r.method()} \${origin}\`);
    } else if (origin !== null && !ALLOWED.has(origin) && r.isNavigationRequest() && r.frame() === page.mainFrame()) {
      problems.push(\`navigated to a non-allowed origin: \${origin}\`);
    }
  });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  page.on('framenavigated', (frame) => {
    if (!loading.delete(frame)) {
      return; // an in-page URL change (history.pushState) cancels nothing
    }
    for (const r of inflight) {
      if (r.frame() === frame && !r.isNavigationRequest()) {
        inflight.delete(r);
      }
    }
  });
  page.on('websocket', (ws) => {
    const origin = originOf(ws.url());
    if (origin !== null && !ALLOWED.has(origin)) {
      problems.push(\`websocket to a non-allowed origin: \${origin}\`);
    }
  });
  page.on('pageerror', (err) => problems.push(\`pageerror: \${err.message.split('\\n')[0]}\`));
  page.on('response', (res) => {
    if (res.status() >= 500 && new URL(res.url()).pathname.startsWith('/api/v4/')) {
      problems.push(\`HTTP \${res.status()} from \${new URL(res.url()).pathname}\`);
    }
  });
  page.setDefaultTimeout(TIMEOUT);
  // Wait until nothing has been in flight for QUIET_MS (at most SETTLE_MS), then apply the oracle, as verify_ui.mjs does.
  const settle = async () => {
    const start = Date.now();
    let quiet = Date.now();
    while (Date.now() - start < SETTLE_MS && (inflight.size || Date.now() - quiet < QUIET_MS)) {
      if (inflight.size) {
        quiet = Date.now();
      }
      await page.waitForTimeout(50);
    }
    expect(inflight.size, 'requests still in flight at the settle deadline').toBe(0);
    const origin = originOf(page.url());
    expect(!page.url().startsWith('chrome-error:') && (origin === null || ALLOWED.has(origin)),
      \`the page left the allowed origins: \${page.url()}\`).toBe(true);
    expect(problems).toEqual([]);
  };${login}
${lines.map((l) => `  ${l}`).join('\n')}
});
`;
}

// ---------------------------------------------------------------- FEATURE_MAP.md

// A target repository can describe its UI for plan writers in .claude/skills/verify/FEATURE_MAP.md: one `## ` section per
// feature with its route, keyboard shortcuts and stable data-testid / ARIA names. --feature-map prints the sections whose
// heading or text mentions the query (case-insensitive), so plans use names the app really has instead of guesses.
export function featureSections(text, query) {
    const q = query.toLowerCase();
    const sections = text.split(/^(?=## )/m).filter((sec) => sec.startsWith('## '));
    return sections.filter((sec) => sec.toLowerCase().includes(q)).map((sec) => sec.trimEnd());
}

export function findFeatureMap(start = process.cwd(), env = process.env) {
    if (env.VERIFY_FEATURE_MAP) {
        return env.VERIFY_FEATURE_MAP;
    }
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, '.claude', 'skills', 'verify', 'FEATURE_MAP.md');
        try {
            readFileSync(candidate);
            return candidate;
        } catch {
            // keep walking up to the filesystem root
        }
        if (path.dirname(dir) === dir) {
            return null;
        }
    }
}

function featureMapCli(query, file) {
    const map = file ?? findFeatureMap();
    if (!map) {
        console.log('no FEATURE_MAP.md (looked for .claude/skills/verify/FEATURE_MAP.md above the current directory and '
            + '$VERIFY_FEATURE_MAP); write the plan from snapshots');
        return 0;
    }
    let text;
    try {
        text = readFileSync(map, 'utf8');
    } catch (err) {
        console.log(`cannot read ${map}: ${firstLine(err)}`);
        return 2;
    }
    const found = featureSections(text, query);
    if (!found.length) {
        const headings = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
        console.log(`no section of ${map} mentions ${JSON.stringify(query)}; sections: ${headings.join(' | ') || '(none)'}`);
        return 0;
    }
    console.log(`from ${map}:\n\n${found.join('\n\n')}`);
    return 0;
}

// ---------------------------------------------------------------- CLI

const USAGE = 'usage: verify_ui.mjs <plan.json> [--freeze <dir>/<name>.spec.ts] [--screenshot-on-fail]\n' +
    '       verify_ui.mjs <plan.json> --compare <base_url>\n' +
    '       verify_ui.mjs --feature-map <route or feature> [FEATURE_MAP.md]';

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--feature-map') {
        if (args.length < 2 || args.length > 3) {
            console.error(USAGE);
            return 2;
        }
        return featureMapCli(args[1], args[2]);
    }
    const si = args.indexOf('--screenshot-on-fail');
    const screenshotOnFail = si >= 0 ? (args.splice(si, 1), 'failure.png') : null;
    const fi = args.indexOf('--freeze');
    const freezeTo = fi >= 0 ? args.splice(fi, 2)[1] : null;
    const ci = args.indexOf('--compare');
    const compareTo = ci >= 0 ? args.splice(ci, 2)[1] : null;
    if (args.length !== 1 || (fi >= 0 && !freezeTo) || (ci >= 0 && !compareTo)) {
        console.error(USAGE);
        return 2;
    }
    if (compareTo && (freezeTo || screenshotOnFail)) {
        console.log('VERDICT: INVALID_PLAN --compare cannot be combined with --freeze or --screenshot-on-fail');
        return 2;
    }
    try {
        let plan;
        try {
            plan = JSON.parse(readFileSync(args[0], 'utf8'));
        } catch (err) {
            throw new PlanError(`cannot read ${args[0]}: ${firstLine(err)}`);
        }
        return compareTo ? await compare(plan, compareTo) : await verify(plan, console.log, freezeTo, process.env, {screenshotOnFail});
    } catch (err) {
        // Anything unexpected is an infrastructure problem, never a FAIL, and only its first line is printed.
        const kind = err instanceof PlanError ? 'INVALID_PLAN' : 'INFRA_ERROR';
        console.log(`VERDICT: ${kind} ${firstLine(err)}`);
        return 2;
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify_ui.mjs')) {
    process.on('unhandledRejection', (err) => {
        console.log(`VERDICT: INFRA_ERROR ${firstLine(err)}`);
        process.exit(2);
    });
    // Exit naturally so piped output drains; if something still holds the event loop (a stalled upstream socket), the
    // unref'd timer ends the process anyway.
    const code = await main();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5000).unref();
}
