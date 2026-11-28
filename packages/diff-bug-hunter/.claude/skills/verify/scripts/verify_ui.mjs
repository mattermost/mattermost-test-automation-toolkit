#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Text-only UI smoke check against a running Mattermost server. Takes no screenshot unless --screenshot-on-fail is
// given, and then exactly one, failure.png, only when the run FAILs, for a person to look at; the agent never reads it.
//
// usage: verify_ui.mjs <plan.json> [--freeze <dir>/<name>.spec.ts] [--screenshot-on-fail]
//        verify_ui.mjs <plan.json> --compare <base_url> [--all-diffs]
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
//   VERDICT: BOTH_FAIL   an expect fails on base and on head, and nothing else differs: the plan says nothing about the change   exit 1
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
// "goto" and "api.path" are checked after URL resolution: they must stay on the server, and api.path (and capture) under
// /api/v4/, /oauth/ or /plugins/<id>/.

import {createRequire} from 'node:module';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_STEPS = 10;
const ACTION_TIMEOUT_MS = 10000;
const API_TIMEOUT_MS = 30000;
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
const NET_ERR_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|net::ERR_(?:CONNECTION_|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|TIMED_OUT|(?:CERT|SSL)_[A-Z0-9_]+)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate has expired|hostname\/IP does not match certificate/i;
const SINGLE_LINE_RE = /[\r\n\u2028\u2029]/;

class PlanError extends Error {}
class InfraError extends Error {}
class StepFailureError extends Error {}

const firstLine = (err) => String(err instanceof Error ? err.message : err).split('\n')[0];
const normApi = (spec) => (typeof spec === 'string' ? {path: spec} : spec);

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
const singleLine = (v) => nonEmpty(v) && !SINGLE_LINE_RE.test(v);

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
// Same-origin server paths a capture or api expect may call: the API, OAuth endpoints and a plugin's own routes.
const SERVER_PATH_RE = /^\/(?:api\/v4\/|oauth\/|plugins\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)/;
function isApiPath(p, origin, allowVars = false) {
    if (!nonEmpty(p)) {
        return false;
    }
    const probe = allowVars ? p.replace(VAR_REF_RE, 'x') : p;
    return SERVER_PATH_RE.test(probe) && staysOn(probe, origin) && SERVER_PATH_RE.test(new URL(probe, origin).pathname);
}

function checkApiSpec(spec, origin, where, allowExpectKeys = false) {
    const allowedKeys = allowExpectKeys ? ['path', 'method', 'body', 'status', 'json_has'] : ['path', 'method', 'body'];
    if (!isObj(spec) || Object.keys(spec).some((k) => !allowedKeys.includes(k))) {
        throw new PlanError(`${where}: api takes only ${allowedKeys.join(', ')}`);
    }
    if (!isApiPath(spec.path, origin, true)) {
        throw new PlanError(`${where}: api.path must be a path under /api/v4/, /oauth/ or /plugins/<id>/ (got ${JSON.stringify(spec.path)})`);
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
    if ('covers' in plan && !(Array.isArray(plan.covers) && plan.covers.length > 0 && plan.covers.every(singleLine))) {
        throw new PlanError('covers must be a non-empty array of single-line file paths');
    }
    if ('verified_at' in plan && !singleLine(plan.verified_at)) {
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
                    throw new PlanError(`${where}: capture.api must be a path under /api/v4/, /oauth/ or /plugins/<id>/ (got ${JSON.stringify(s.capture.api)})`);
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

const LOC_METHODS = {testid: 'getByTestId', label: 'getByLabel', placeholder: 'getByPlaceholder', text: 'getByText', css: 'locator'};

function locatorCall(loc) {
    if (loc.role) {
        return ['getByRole', loc.name === undefined ? [loc.role] : [loc.role, {name: loc.name, exact: Boolean(loc.exact)}]];
    }
    const k = Object.keys(LOC_METHODS).find((key) => loc[key]);
    return [LOC_METHODS[k], [loc[k]]];
}

function locateAll(page, loc) {
    const [method, args] = locatorCall(loc);
    return page[method](...args);
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

// Self-contained on purpose: --freeze copies this function's source into the generated spec.
export async function apiLogin(context, base, env) {
    const hasBrowser = typeof context.route === 'function';
    const headers = {'X-Requested-With': 'XMLHttpRequest'};
    if (env.VERIFY_TOKEN) {
        const token = env.VERIFY_TOKEN;
        if (hasBrowser) {
            await context.clearCookies({name: 'MMAUTHTOKEN'});
        }
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
        if (!hasBrowser) {
            return `token auth as ${user.username} (API-only, no browser)`;
        }
        // No MMAUTHTOKEN cookie: header auth skips CSRF; MMUSERID tells the webapp it is signed in.
        await context.addCookies([{name: 'MMUSERID', value: user.id, url: base}]);
        const origin = new URL(base).origin;
        await context.route('**/*', async (route) => {
            const request = route.request();
            if (new URL(request.url()).origin !== origin || !['fetch', 'xhr'].includes(request.resourceType())) {
                return route.fallback();
            }
            try {
                const response = await route.fetch({
                    headers: {...request.headers(), authorization: `Bearer ${token}`},
                    maxRedirects: 0,
                });
                return await route.fulfill({response});
            } catch {
                return route.abort('failed').catch(() => {});
            }
        });
        return `token auth as ${user.username} (Bearer header on same-origin API calls only)`;
    }
    let res;
    try {
        res = await context.request.post(new URL('/api/v4/users/login', base).toString(),
            {data: {login_id: env.VERIFY_USER, password: env.VERIFY_PASSWORD}, headers, maxRedirects: 0});
    } catch (err) {
        throw new Error(String(err instanceof Error ? err.message : err).split('\n')[0]);
    }
    if (!res.ok()) {
        throw new Error(`login as ${env.VERIFY_USER} failed: HTTP ${res.status()}`);
    }
    let cookies;
    if (typeof context.cookies === 'function') {
        cookies = await context.cookies(base);
    } else {
        const u = new URL(base);
        const host = u.hostname.toLowerCase();
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
        cookies = ((await context.storageState()).cookies ?? []).filter((x) => {
            const raw = (x.domain ?? '').toLowerCase();
            const dom = raw.replace(/^\./, '');
            const domOk = !dom || host === dom || (raw.startsWith('.') && host.endsWith('.' + dom));
            const cp = x.path ?? '';
            const pathOk = !cp || cp === '/' || u.pathname === cp || u.pathname.startsWith(cp.endsWith('/') ? cp : cp + '/');
            const secureOk = !x.secure || u.protocol === 'https:' || isLocal;
            const expiryOk = x.expires === undefined || x.expires === -1 || x.expires * 1000 > Date.now();
            return domOk && pathOk && secureOk && expiryOk;
        });
    }
    const names = new Set(cookies.map((c) => c.name));
    const missing = ['MMAUTHTOKEN', 'MMUSERID', 'MMCSRF'].filter((name) => !names.has(name));
    if (missing.length) {
        throw new Error(`login as ${env.VERIFY_USER} set no ${missing.join(', ')} cookie`);
    }
    return `password login as ${env.VERIFY_USER} (${hasBrowser ? 'MMAUTHTOKEN, MMUSERID, MMCSRF set' : 'API-only, no browser'})`;
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
    const out = raw.replace(/\$([A-Za-z_]\w*)/g, (_, name) => {
        if (!Object.hasOwn(vars, name)) {
            throw new Error(`unknown saved variable $${name}`);
        }
        const val = String(vars[name]);
        if (!/^[A-Za-z0-9._-]+$/.test(val)) {
            throw new Error(`saved variable $${name} has unsafe URL token ${JSON.stringify(val)}`);
        }
        return val;
    });
    let u = null;
    try {
        u = new URL(out, origin);
    } catch {
        u = null;
    }
    const apiRe = /^\/(?:api\/v4\/|oauth\/|plugins\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)/;
    const okPath = mustBeApi
        ? apiRe.test(out) && apiRe.test(u?.pathname ?? '')
        : out.startsWith('/') && !out.startsWith('//') && !out.includes('\\');
    if (!u || u.origin !== origin || !okPath) {
        throw new Error(`resolved path ${JSON.stringify(out)} left ${mustBeApi ? '/api/v4/, /oauth/ or /plugins/<id>/' : origin}`);
    }
    return out;
}

function expandBody(val, vars) {
    if (typeof val === 'string') {
        return val.replace(/\$([A-Za-z_]\w*)/g, (_, name) => {
            if (!Object.hasOwn(vars, name)) {
                throw new Error(`unknown saved variable $${name}`);
            }
            return String(vars[name]);
        });
    }
    if (Array.isArray(val)) {
        return val.map((v) => expandBody(v, vars));
    }
    if (val !== null && typeof val === 'object') {
        return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, expandBody(v, vars)]));
    }
    return val;
}

const SIMPLE_STEPS = {
    click: ['click'], fill: ['fill', 'value'], select: ['selectOption', 'value'],
    check: ['check'], wait_for: ['waitFor', null, {state: 'visible'}],
};

async function runStep(page, base, origin, step, vars) {
    if ('goto' in step) {
        let target;
        try {
            target = expandPath(step.goto, origin, vars, false);
        } catch (err) {
            throw new StepFailureError(firstLine(err));
        }
        await page.goto(new URL(target, base).toString(), {waitUntil: 'domcontentloaded'});
        return;
    }
    try {
        if ('press' in step) {
            await (step.on ? locate(page, step.on).press(step.press) : page.keyboard.press(step.press));
        } else if ('mouse_up' in step) {
            await page.mouse.up();
        } else if ('drag' in step) {
            const d = step.drag;
            const src = await locate(page, d.from).boundingBox();
            if (!src) {
                throw new StepFailureError(`drag source has no bounding box: ${JSON.stringify(d.from)}`);
            }
            const sx = src.x + src.width / 2;
            const sy = src.y + src.height / 2;
            let tx = sx + (d.dx ?? 0);
            let ty = sy + (d.dy ?? 0);
            if (d.to) {
                const dst = await locate(page, d.to).boundingBox();
                if (!dst) {
                    throw new StepFailureError(`drag target has no bounding box: ${JSON.stringify(d.to)}`);
                }
                tx = dst.x + dst.width / 2;
                ty = dst.y + dst.height / 2;
            }
            await page.mouse.move(sx, sy);
            await page.mouse.down();
            await page.mouse.move(tx, ty, {steps: 5});
            if (d.release !== false) {
                await page.mouse.up();
            }
        } else {
            const [k, [fn, argKey, fixed]] = Object.entries(SIMPLE_STEPS).find(([key]) => key in step);
            await locate(page, step[k])[fn](...(argKey ? [step[argKey]] : fixed ? [fixed] : []));
        }
    } catch (err) {
        if (err instanceof Error && !(err instanceof StepFailureError)) {
            err._verifyNonTransport = true;
        }
        throw err;
    }
}

async function waitSettle(page, inflight, lastAt, limit, quietMs) {
    const start = Date.now();
    while (Date.now() - start < limit && (inflight.size || Date.now() - Math.max(start, lastAt()) < quietMs)) {
        await page.waitForTimeout(50);
    }
    if (!inflight.size) {
        return null;
    }
    const urls = [...inflight].map((r) => `${r.method()} ${new URL(r.url()).pathname}`).slice(0, 5);
    return `${inflight.size} request(s) still in flight after ${limit}ms: ${urls.join(', ')}`;
}

async function attachPageGuards(context, page, allowedSet, originOfFn, timeoutMs, problems, soft, onBlocked, diagnostics) {
    const inflight = new Set();
    const navFrames = new Map();
    let lastActivityAt = Date.now();
    const frameOf = (r) => { try { return r.frame(); } catch { return null; } };
    await context.route('**/*', (route) => {
        const o = originOfFn(route.request().url());
        if (o === null || allowedSet.has(o)) {
            return route.continue();
        }
        onBlocked(o);
        return route.abort('blockedbyclient');
    });
    page.on('request', (r) => {
        inflight.add(r);
        lastActivityAt = Date.now();
        const rf = frameOf(r);
        if (r.isNavigationRequest() && rf) {
            let set = navFrames.get(rf);
            if (!set) {
                set = new Set();
                navFrames.set(rf, set);
            }
            set.add(r);
        }
        const o = originOfFn(r.url());
        if (o !== null && !allowedSet.has(o)) {
            onBlocked(o);
            if (r.redirectedFrom()) {
                problems.push(`redirected to a non-allowed origin: ${r.method()} ${o}`);
            } else if (r.isNavigationRequest() && rf === page.mainFrame()) {
                problems.push(`navigated to a non-allowed origin: ${o}`);
            }
        }
    });
    const done = (r) => {
        inflight.delete(r);
        const rf = frameOf(r);
        if (r.isNavigationRequest() && rf) {
            const set = navFrames.get(rf);
            if (set) {
                set.delete(r);
                if (!set.size) {
                    navFrames.delete(rf);
                }
            }
        }
        lastActivityAt = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('framenavigated', (frame) => {
        if (!navFrames.delete(frame)) {
            return;
        }
        for (const r of [...inflight]) {
            const rf = frameOf(r);
            if (rf !== null && !r.isNavigationRequest() && rf === frame) {
                inflight.delete(r);
            }
        }
        lastActivityAt = Date.now();
    });
    page.on('websocket', (ws) => {
        const o = originOfFn(ws.url());
        if (o !== null && !allowedSet.has(o)) {
            problems.push(`websocket to a non-allowed origin: ${o}`);
        }
    });
    page.on('pageerror', (err) => soft.push(`pageerror: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`));
    if (diagnostics) {
        const diag = diagnostics;
        page.on('console', (msg) => {
            if (msg.type() === 'error' && diag.length < 20) {
                diag.push(`console.error: ${String(msg.text()).split('\n')[0]}`);
            }
        });
    }
    page.on('response', (res) => {
        const pathname = new URL(res.url()).pathname;
        if (!SERVER_PATH_RE.test(pathname)) {
            return;
        }
        if (res.status() >= 500) {
            soft.push(`HTTP ${res.status()} from ${res.request().method()} ${pathname}`);
        } else if (diagnostics && res.status() >= 400 && diagnostics.length < 20) {
            diagnostics.push(`HTTP ${res.status()} from ${res.request().method()} ${pathname}`);
        }
    });
    page.setDefaultTimeout(timeoutMs);
    return {inflight, lastAt: () => lastActivityAt};
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

// Self-contained (--freeze copies it): sends an API request with Bearer token or MMCSRF, no redirects, bounded body.
async function sendApiRequest(reqHost, base, method, apiPath, body, env, maxBytes, timeoutMs) {
    const reqUrl = new URL(apiPath, base).toString();
    const headers = {'X-Requested-With': 'XMLHttpRequest'};
    if (env.VERIFY_TOKEN) {
        headers.Authorization = `Bearer ${env.VERIFY_TOKEN}`;
    } else if (method !== 'GET') {
        let cookies;
        if (typeof reqHost.cookies === 'function') {
            cookies = await reqHost.cookies(reqUrl);
        } else {
            const u = new URL(reqUrl);
            const host = u.hostname.toLowerCase();
            const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
            cookies = ((await reqHost.storageState()).cookies ?? []).filter((x) => {
                const raw = (x.domain ?? '').toLowerCase();
                const dom = raw.replace(/^\./, '');
                const domOk = !dom || host === dom || (raw.startsWith('.') && host.endsWith('.' + dom));
                const cp = x.path ?? '';
                const pathOk = !cp || cp === '/' || u.pathname === cp || u.pathname.startsWith(cp.endsWith('/') ? cp : cp + '/');
                const secureOk = !x.secure || u.protocol === 'https:' || isLocal;
                const expiryOk = x.expires === undefined || x.expires === -1 || x.expires * 1000 > Date.now();
                return domOk && pathOk && secureOk && expiryOk;
            });
        }
        const c = cookies.find((x) => x.name === 'MMCSRF');
        if (c) {
            headers['X-CSRF-Token'] = c.value;
        }
    }
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    if (serialized !== undefined) {
        if (new TextEncoder().encode(serialized).length > maxBytes) {
            throw new Error(`${method} ${apiPath}: expanded api.body exceeds ${maxBytes} bytes`);
        }
        headers['Content-Type'] = 'application/json';
    }
    const opts = {method, headers, maxRedirects: 0, timeout: timeoutMs, ...(serialized !== undefined ? {data: serialized} : {})};
    try {
        return await reqHost.request.fetch(reqUrl, opts);
    } catch (err) {
        const out = new Error(String(err instanceof Error ? err.message : err).split('\n')[0]);
        if (err instanceof Error && err.name) {
            out.name = err.name;
        }
        throw out;
    }
}

async function apiCall(reqHost, base, origin, spec, env, vars) {
    const rawSpec = normApi(spec);
    const method = (rawSpec.method ?? 'GET').toUpperCase();
    let apiPath;
    let body;
    try {
        apiPath = expandPath(rawSpec.path, origin, vars, true);
        body = 'body' in rawSpec ? expandBody(rawSpec.body, vars) : undefined;
    } catch (err) {
        throw new StepFailureError(firstLine(err));
    }
    let res;
    try {
        res = await sendApiRequest(reqHost, base, method, apiPath, body, env, MAX_BODY_BYTES, API_TIMEOUT_MS);
    } catch (err) {
        const msg = firstLine(err);
        if (msg.includes(`exceeds ${MAX_BODY_BYTES} bytes`)) {
            throw new StepFailureError(msg);
        }
        if (err instanceof Error && (err.name === 'TimeoutError' || /\btimed?\s*out\b/i.test(msg))) {
            err._verifyApiTimeout = true;
        }
        throw err;
    }
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
                throw new StepFailureError(`capture.save.${name}: path ${JSON.stringify(dotPath)} not found as scalar in ${method} ${apiPath} (HTTP ${res.status()})`);
            }
            vars[name] = String(val);
        }
    }
    return {path: apiPath, method, status: res.status(), json, text: json === undefined ? text : undefined};
}

async function checkExpect(reqHost, page, base, origin, e, env, vars) {
    if (e.visible || e.text || e.count) {
        try {
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
            const min = e.min ?? 1;
            const n = await poll(() => locateAll(page, e.count).count(), (c) => c >= min);
            return n >= min ? null : `count of ${JSON.stringify(e.count)} is ${n}, want >= ${min}`;
        } catch (err) {
            if (err instanceof Error && !(err instanceof StepFailureError)) {
                err._verifyNonTransport = true;
            }
            throw err;
        }
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

async function serverReachable(base) {
    try {
        await fetch(new URL('/api/v4/system/ping', base).toString(), {method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000)});
        return true;
    } catch {
        return false;
    }
}

async function classifyStepErr(where, err, base) {
    const msg = firstLine(err);
    if (err instanceof StepFailureError) {
        return msg;
    }
    if (planMistake(err)) {
        throw new PlanError(`${where}: ${msg}`);
    }
    if (err?._verifyApiTimeout) {
        if (!(await serverReachable(base))) {
            throw new InfraError(`server unreachable at ${base}: ${msg}`);
        }
        return msg;
    }
    if (err?.name === 'TimeoutError' || err?._verifyNonTransport) {
        return msg;
    }
    const reset = /ERR_CONNECTION_(?:RESET|ABORTED|CLOSED)|ERR_EMPTY_RESPONSE|ECONNRESET|socket hang up/i.test(msg);
    if (NET_ERR_RE.test(msg) || reset) {
        if (!reset || !(await serverReachable(base))) {
            throw new InfraError(`server unreachable at ${base}: ${msg}`);
        }
    }
    return msg;
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
    let tracker = null;
    try {
        if (needsBrowser) {
            const context = await browser.newContext({viewport: {width: 1280, height: 800}});
            reqHost = context;
            await context.addInitScript(landingPageSeen, origin);
            page = await context.newPage();
            tracker = await attachPageGuards(
                context, page, allowedSet, originOf, ACTION_TIMEOUT_MS,
                problems, record ? record.problems : problems, (o) => blocked.add(o), diagnostics,
            );
        } else {
            apiCtx = await request.newContext();
            reqHost = {request: apiCtx, storageState: () => apiCtx.storageState()};
        }
        if (authed) {
            try {
                log(await apiLogin(reqHost, base, env));
            } catch (err) {
                const msg = firstLine(err);
                throw new InfraError(NET_ERR_RE.test(msg) ? `server unreachable at ${base}: ${msg}` : msg);
            }
        }
        const afterStep = async () => {
            if (!page || !tracker) {
                return;
            }
            const late = await waitSettle(page, tracker.inflight, tracker.lastAt, limit, QUIET_MS);
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
                    if (!record && got.status >= 500) {
                        return await finish(1, `${label}: HTTP ${got.status} from ${got.method} ${got.path}`, await failSnap());
                    }
                    continue;
                }
                await runStep(page, base, origin, step, vars);
                await afterStep();
            } catch (err) {
                const msg = await classifyStepErr(label, err, base);
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
                why = await classifyStepErr(`expect ${i + 1}`, err, base);
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
const VERSION_KEY_RE = /^(?:[a-z_]+_)?version$|^[a-zA-Z0-9]*Version$|^build(?:[A-Z_]|$)|^Build(?:[A-Z_]|$)/;

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
        const multi = [];
        for (const [nk, vals] of grouped) {
            if (vals.length === 1) {
                out[nk] = vals[0];
            } else {
                multi.push([nk, vals]);
            }
        }
        for (const [nk, vals] of multi) {
            const sorted = vals.map((val) => [JSON.stringify(val), val])
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            let slot = 0;
            for (const [, val] of sorted) {
                while (Object.hasOwn(out, `${nk}#${slot}`)) {
                    slot += 1;
                }
                out[`${nk}#${slot}`] = val;
                slot += 1;
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

// Line-level difference of two normalised snapshots: LCS hunk pairing so reordered lines are still reported.
export function diffLines(base, head) {
    const aLines = base.split('\n');
    const bLines = head.split('\n');
    let lo = 0;
    let aHi = aLines.length;
    let bHi = bLines.length;
    while (lo < aHi && lo < bHi && aLines[lo] === bLines[lo]) {
        lo++;
    }
    while (aHi > lo && bHi > lo && aLines[aHi - 1] === bLines[bHi - 1]) {
        aHi--;
        bHi--;
    }
    const a = aLines.slice(lo, aHi);
    const b = bLines.slice(lo, bHi);
    const m = a.length;
    const n = b.length;
    if (!m && !n) {
        return [];
    }
    const dp = Array.from({length: m + 1}, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
        const del = [];
        const ins = [];
        while (i < m && j < n ? a[i] !== b[j] : (i < m || j < n)) {
            if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
                del.push(a[i++]);
            } else {
                ins.push(b[j++]);
            }
        }
        for (let k = 0; k < Math.max(del.length, ins.length); k++) {
            out.push({base: del[k], head: ins[k]});
        }
        if (i < m && j < n && a[i] === b[j]) {
            i++;
            j++;
        }
    }
    return out;
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
export async function compare(plan, baseUrl, env = process.env, log = console.log, opts = {}) {
    const baseOrigin = httpOrigin(baseUrl, '--compare');
    // The base run uses the plan without its own base_url: the head target is the plan's or the environment's, the base
    // is the command line's, and both get the same credentials.
    const {base_url: _drop, ...basePlan} = plan;
    const baseEnv = {...env, VERIFY_BASE_URL: baseOrigin};
    const sides = [['base', basePlan, baseEnv], ['head', plan, env]];
    const wrapSide = async (name, fn) => {
        try {
            return await fn();
        } catch (err) {
            const Wrap = err instanceof PlanError ? PlanError : InfraError;
            throw new Wrap(`${name} run: ${firstLine(err)}`);
        }
    };
    const origins = [];
    for (const [name, p, e] of sides) {
        origins.push(await wrapSide(name, () => validatePlan(p, e).origin));
    }
    const recs = {};
    for (const [name, p, e] of sides) {
        const rec = {captures: [], snapshots: [], expects: [], problems: [], verdict: ''};
        recs[name] = rec;
        const code = await wrapSide(name, () => verify(p, tagged(name, rec, log), null, e, {record: rec}));
        if (code !== 0) {
            log(`VERDICT: FAIL ${name} run failed: ${rec.verdict.replace(/^FAIL /, '')}`);
            return 1;
        }
    }
    const diffs = diffRuns(recs.base, recs.head, origins, plan.ignore ?? []);
    const limit = opts.allDiffs ? diffs.length : MAX_DIFFS;
    for (const d of diffs.slice(0, limit)) {
        log(`DIFF ${d.step} ${d.path}: base=${d.base} head=${d.head}`);
    }
    if (diffs.length > limit) {
        log(`... ${diffs.length - limit} more differences not shown (rerun with --all-diffs to print all)`);
    }
    const regressions = recs.base.expects.filter((b) => b.ok && !recs.head.expects.find((h) => h.n === b.n)?.ok);
    log(`${diffs.length} difference(s) after normalising ids, timestamps, versions and origins; ${regressions.length} expect regression(s)`);
    const bothFail = recs.base.expects.filter((b) => !b.ok && !recs.head.expects.find((h) => h.n === b.n)?.ok);
    const verdict = regressions.length ? 'REGRESSION' : diffs.length ? 'DIFF' : bothFail.length ? 'BOTH_FAIL' : 'SAME';
    log(`VERDICT: ${verdict}`);
    return verdict === 'SAME' ? 0 : 1;
}

// ---------------------------------------------------------------- --freeze

function locatorCode(loc) {
    const [method, args] = locatorCall(loc);
    return `page.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

const one = (loc) => (loc.nth === undefined ? locatorCode(loc) : `${locatorCode(loc)}.nth(${Number(loc.nth)})`);

function typedFn(fn, ...replacements) {
    let src = fn.toString();
    for (const [from, to] of replacements) {
        const next = src.replace(from, to);
        if (next === src) {
            throw new Error(`${fn.name}() changed; update typedFn()`);
        }
        src = next;
    }
    return src;
}

export function freeze(plan, base, allowOrigins = [], authed = false) {
    const q = JSON.stringify;
    const lines = [];
    const emittedSteps = (plan.steps ?? []).filter((s) => !('snapshot' in s));
    const domSteps = emittedSteps.filter((s) => !('capture' in s)).length;
    const targetDrags = emittedSteps.filter((s) => 'drag' in s && s.drag.to).length;
    const captureSteps = emittedSteps.filter((s) => 'capture' in s).length;
    const domExpects = plan.expect.filter((e) => !('api' in e)).length;
    const apiExpects = plan.expect.filter((e) => 'api' in e).length;
    const frozenSimple = {
        click: (s) => `${one(s.click)}.click()`,
        fill: (s) => `${one(s.fill)}.fill(${q(s.value)})`,
        press: (s) => (s.on ? `${one(s.on)}.press(${q(s.press)})` : `page.keyboard.press(${q(s.press)})`),
        select: (s) => `${one(s.select)}.selectOption(${q(s.value)})`,
        check: (s) => `${one(s.check)}.check()`,
        wait_for: (s) => `${one(s.wait_for)}.waitFor({state: 'visible'})`,
        mouse_up: () => 'page.mouse.up()',
    };
    for (const s of plan.steps ?? []) {
        const simpleKey = Object.keys(frozenSimple).find((k) => k in s);
        if ('goto' in s) {
            lines.push(`await page.goto(new URL(expandPath(${q(s.goto)}, BASE_ORIGIN, vars, false), BASE).toString(), {waitUntil: 'domcontentloaded'});`);
        } else if (simpleKey) {
            lines.push(`await ${frozenSimple[simpleKey](s)};`);
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
        } else if ('capture' in s) {
            const rawApi = normApi(s.capture.api);
            const method = (rawApi.method ?? 'GET').toUpperCase();
            const bodyArg = 'body' in rawApi ? `, expandBody(JSON.parse(${q(q(rawApi.body))}), vars)` : '';
            lines.push('{', `  const res = await sendApiRequest(context, BASE, ${q(method)}, expandPath(${q(rawApi.path)}, BASE_ORIGIN, vars, true), ${bodyArg ? bodyArg.slice(2) : 'undefined'}, AUTHED ? process.env : {}, MAX_BODY_BYTES, API_TIMEOUT);`);
            lines.push("  expect(res.status(), 'no server error').toBeLessThan(500);");
            const saveEntries = Object.entries(s.capture.save ?? {});
            if (saveEntries.length > 0) {
                lines.push('  const data: unknown = await res.json();');
                for (const [k, dotPath] of saveEntries) {
                    lines.push(`  { const v = readJsonPath(data, ${q(dotPath)}); expect(v !== undefined && v !== null && typeof v !== 'object', ${q(`capture.save.${k}`)}).toBe(true); vars[${q(k)}] = String(v); }`);
                }
            }
            lines.push('}');
            continue;
        } else {
            continue;
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
            const bodyArg = 'body' in e.api ? `expandBody(JSON.parse(${q(q(e.api.body))}), vars)` : 'undefined';
            lines.push('{', `  const res = await sendApiRequest(context, BASE, ${q(method)}, expandPath(${q(e.api.path)}, BASE_ORIGIN, vars, true), ${bodyArg}, AUTHED ? process.env : {}, MAX_BODY_BYTES, API_TIMEOUT);`,
                "  expect(res.status(), 'no server error').toBeLessThan(500);",
                `  expect(res.status()).toBe(${Number(e.api.status ?? 200)});`);
            if (e.api.json_has) {
                lines.push(`  expect(subset(${q(e.api.json_has)}, await res.json())).toBe(true);`);
            }
            lines.push('}');
        }
    }
    const needsBrowser = (plan.steps ?? []).some((s) => !('capture' in s)) || plan.expect.some((e) => !e.api);
    if (needsBrowser) {
        lines.push('await settle(); // late events count too');
    }
    const needsLogin = plan.login || authed;
    const login = needsLogin ? `
  expect(Boolean(process.env.VERIFY_TOKEN || (process.env.VERIFY_USER && process.env.VERIFY_PASSWORD)),
    'set VERIFY_TOKEN or VERIFY_USER + VERIFY_PASSWORD').toBe(true);
  const host = new URL(BASE).hostname;
  const sameHost = [...ALLOWED].filter((o) => o !== BASE_ORIGIN && new URL(o).hostname === host);
  expect(Boolean(process.env.VERIFY_TOKEN) || sameHost.length === 0,
    \`allowed origins \${sameHost.join(', ')} share the host of \${BASE}; with password login the session cookie would be sent there\`).toBe(true);
  await apiLogin(context, BASE, process.env);` : '';
    const loginFn = needsLogin ? `
const apiLogin: (context: BrowserContext, base: string, env: NodeJS.ProcessEnv) => Promise<string> = ${apiLogin.toString()};
` : '';
    const metaLines = [
        ...(plan.covers?.length ? [`// covers: ${plan.covers.join(', ')}`] : []),
        ...(plan.verified_at ? [`// verified-at: ${plan.verified_at}`] : []),
    ];
    const metaBlock = metaLines.length ? `${metaLines.join('\n')}\n` : '';
    const sharedHelpers = `${typedFn(subset, ['function subset(want, got) {', 'function subset(want: any, got: any): boolean {'])}
const sendApiRequest: (reqHost: BrowserContext, base: string, method: string, apiPath: string, body: unknown, env: NodeJS.ProcessEnv, maxBytes: number, timeoutMs: number) => Promise<APIResponse> = ${typedFn(sendApiRequest, ["const headers = {'X-Requested-With': 'XMLHttpRequest'};", "const headers: Record<string, string> = {'X-Requested-With': 'XMLHttpRequest'};"])};
const readJsonPath: (obj: unknown, dotPath: string) => unknown = ${typedFn(readJsonPath, ['cur = cur[seg];', 'cur = (cur as Record<string, unknown>)[seg];'])};
const expandPath: (raw: string, origin: string, vars: Record<string, string>, mustBeApi: boolean) => string = ${expandPath.toString()};
${typedFn(expandBody, ['function expandBody(val, vars) {', 'function expandBody(val: unknown, vars: Record<string, string>): unknown {'], ['Object.entries(val)', 'Object.entries(val as Record<string, unknown>)'])}${loginFn}`;
    if (!needsBrowser) {
        return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan, with the same oracle. Set VERIFY_REPLAY_BASE_URL to retarget.
${metaBlock}import {expect, request, test, type APIRequestContext, type APIResponse, type BrowserContext} from '@playwright/test';

const BASE = process.env.VERIFY_REPLAY_BASE_URL || ${q(base)};
const BASE_ORIGIN = new URL(BASE).origin;
const AUTHED = ${needsLogin ? 'true' : 'false'};
const ALLOWED = new Set([BASE_ORIGIN, ...${q(allowOrigins)}.map((o: string) => new URL(o).origin)]);
const API_TIMEOUT = ${API_TIMEOUT_MS};
const MAX_BODY_BYTES = ${MAX_BODY_BYTES};

${sharedHelpers}
let apiCtx: APIRequestContext | undefined;
test.afterEach(async () => {
  try {
    await apiCtx?.dispose();
  } finally {
    apiCtx = undefined;
  }
});

test(${q(plan.name ?? 'frozen /verify plan')}, async () => {
  test.setTimeout(60000 + ${captureSteps + apiExpects} * API_TIMEOUT);
  const vars: Record<string, string> = {};
  apiCtx = await request.newContext();
  const context = {request: apiCtx, storageState: () => apiCtx!.storageState()} as unknown as BrowserContext;${login}
${lines.map((l) => `  ${l}`).join('\n')}
});
`;
    }
    return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan, with the same oracle. Set VERIFY_REPLAY_BASE_URL to retarget.
${metaBlock}import {chromium, expect, test, type APIResponse, type Browser, type BrowserContext, type Page, type Request} from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';

const BASE = process.env.VERIFY_REPLAY_BASE_URL || ${q(base)};
const BASE_ORIGIN = new URL(BASE).origin;
const AUTHED = ${needsLogin ? 'true' : 'false'};
const ALLOWED = new Set([BASE_ORIGIN, ...${q(allowOrigins)}.map((o: string) => new URL(o).origin)]);
const SETTLE_MS = Number(process.env.VERIFY_SETTLE_MS ?? ${DEFAULT_SETTLE_MS});
const QUIET_MS = ${QUIET_MS};
const TIMEOUT = ${ACTION_TIMEOUT_MS};
const API_TIMEOUT = ${API_TIMEOUT_MS};
const MAX_BODY_BYTES = ${MAX_BODY_BYTES};
const SERVER_PATH_RE = ${SERVER_PATH_RE};

const originOf: (url: string) => string | null = ${originOf.toString()};
${sharedHelpers}
const startOriginGuard: (httpMod: typeof http, netMod: typeof net, allowed: Set<string>, onBlocked: (origin: string) => void) =>
  Promise<{port: number, close: () => void}> = ${typedFn(startOriginGuard, ['const strip = (h) => {', 'const strip = (h: Record<string, string | string[] | undefined>) => {'])};
const attachPageGuards: (context: BrowserContext, page: Page, allowedSet: Set<string>, originOfFn: (url: string) => string | null, timeoutMs: number, problems: string[], soft: string[], onBlocked: (origin: string) => void, diagnostics: string[] | null) => Promise<{inflight: Set<Request>; lastAt: () => number}> = ${typedFn(attachPageGuards, ['const inflight = new Set();', 'const inflight = new Set<Request>();'], ['const navFrames = new Map();', 'const navFrames = new Map<ReturnType<Page["mainFrame"]>, Set<Request>>();'], ['const frameOf = (r) => {', 'const frameOf = (r: Request) => {'], ['const done = (r) => {', 'const done = (r: Request) => {'])};
const waitSettle: (page: Page, inflight: Set<Request>, lastAt: () => number, limit: number, quietMs: number) => Promise<string | null> = ${waitSettle.toString()};

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
  test.setTimeout(60000 + ${domSteps} * (TIMEOUT + SETTLE_MS) + ${captureSteps} * API_TIMEOUT + ${domExpects + targetDrags} * TIMEOUT + ${apiExpects} * API_TIMEOUT + SETTLE_MS);
  const vars: Record<string, string> = {};
  guard = await startOriginGuard(http, net, ALLOWED, () => {});
  browser = await chromium.launch({args: [\`--proxy-server=http://127.0.0.1:\${guard.port}\`, '--proxy-bypass-list=<-loopback>']});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await context.addInitScript(${landingPageSeen.toString().replace('(origin)', '(origin: string)')}, BASE_ORIGIN);
  const page = await context.newPage();
  const problems: string[] = [];
  const tracker = await attachPageGuards(context, page, ALLOWED, originOf, TIMEOUT, problems, problems, () => {}, null);
  const settle = async () => {
    const late = await waitSettle(page, tracker.inflight, tracker.lastAt, SETTLE_MS, QUIET_MS);
    expect(tracker.inflight.size, late ?? 'requests still in flight at the settle deadline').toBe(0);
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
    '       verify_ui.mjs <plan.json> --compare <base_url> [--all-diffs]\n' +
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
    const ai = args.indexOf('--all-diffs');
    const allDiffs = ai >= 0 ? (args.splice(ai, 1), true) : false;
    const fi = args.indexOf('--freeze');
    const freezeTo = fi >= 0 ? args.splice(fi, 2)[1] : null;
    const ci = args.indexOf('--compare');
    const compareTo = ci >= 0 ? args.splice(ci, 2)[1] : null;
    if (args.length !== 1 || (fi >= 0 && !freezeTo) || (ci >= 0 && !compareTo)) {
        console.error(USAGE);
        return 2;
    }
    if (allDiffs && !compareTo) {
        console.log('VERDICT: INVALID_PLAN --all-diffs requires --compare');
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
        return compareTo ? await compare(plan, compareTo, process.env, console.log, {allDiffs}) : await verify(plan, console.log, freezeTo, process.env, {screenshotOnFail});
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
