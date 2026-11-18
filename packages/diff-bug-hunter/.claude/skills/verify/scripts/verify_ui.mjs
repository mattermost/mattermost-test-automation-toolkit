#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Text-only UI smoke check against a running Mattermost server. Never takes screenshots.
//
// usage: verify_ui.mjs <plan.json> [--freeze <out.spec.ts>]
// Exit codes: 0 PASS, 1 FAIL (an expectation, a page error, a >= 500 /api/v4/ response, a request still running at the
// settle deadline, or leaving the allowed origins), 2 INVALID_PLAN or INFRA_ERROR. Errors print only their first line.
// Bounded by design: at most MAX_STEPS steps, allowed origins only (base_url plus allow_origins; other hosts are
// blocked, and a redirect, navigation or websocket to them fails the run), every step and the final check wait for
// in-flight requests to settle, and success is a deterministic DOM or /api/v4/ check, never a model's judgement.
// --freeze writes a passing plan as a @playwright/test spec with the same oracle, so the check reruns with no model.
//
// Target: plan.base_url, else $VERIFY_BASE_URL, else $MM_URL, else http://localhost:8065. With credentials set, a
// plan.base_url must have the same origin as $VERIFY_BASE_URL / $MM_URL / the default, so credentials never go to a
// host the plan chose. Frozen specs read $VERIFY_BASE_URL / $MM_URL first and fall back to the frozen target.
//
// Auth (API, before the first step, so no step is spent on the login form):
//   VERIFY_TOKEN                   session or personal access token: a Bearer header on same-origin fetch/XHR only
//                                  (fetched without following redirects) + the MMUSERID cookie; no cookie session, so
//                                  no CSRF; the webapp's websocket stays unauthenticated
//   VERIFY_USER + VERIFY_PASSWORD  POST /api/v4/users/login; the server sets MMAUTHTOKEN, MMUSERID and MMCSRF
// Frozen specs embed the same apiLogin() and read the same variables. VERIFY_SETTLE_MS (default 10000) bounds settling.
//
// Plan (unknown keys are rejected):
// {
//   "name": "what this checks",                  (optional; the frozen test's title)
//   "base_url": "http://localhost:8065",          (optional, http or https)
//   "login": true,                                (optional: INFRA_ERROR when no VERIFY_* credentials are set)
//   "scope": LOC,                                 (snapshot scope; default #app-content if present, else body. Open
//                                                  dialogs, menus and listboxes outside it are always appended.)
//   "allow_origins": ["https://cdn.example.com"], (extra origins the page may load)
//   "steps": [ at most MAX_STEPS of, each with exactly one action:
//     {"goto": "/team/channels/town-square"} | {"click": LOC} | {"fill": LOC, "value": "text"} |
//     {"press": "Enter", "on"?: LOC} | {"select": LOC, "value": "x"} | {"check": LOC} | {"wait_for": LOC} |
//     {"snapshot": LOC | null} ],
//   "expect": [ at least one of
//     {"visible": LOC} | {"text": LOC, "contains": "x"} | {"count": LOC, "min"?: 1} |
//     {"api": {"path": "/api/v4/users/me", "status"?: 200, "json_has"?: {"username": "sysadmin"}}} ]
// }
// LOC: exactly one of {"role": "button", "name"?: "Save", "exact"?: true} | {"testid"} | {"label"} | {"placeholder"} |
//      {"text"} | {"css"}, plus an optional integer "nth".

import {createRequire} from 'node:module';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const MAX_STEPS = 10;
const ACTION_TIMEOUT_MS = 10000;
const SNAPSHOT_CHARS = 4000;
const QUIET_MS = 300;
const DEFAULT_SETTLE_MS = 10000;
const DEFAULT_BASE = 'http://localhost:8065';
const LOC_KINDS = ['role', 'testid', 'label', 'placeholder', 'text', 'css'];
const STEP_EXTRAS = {goto: [], click: [], fill: ['value'], press: ['on'], select: ['value'], check: [], wait_for: [],
    snapshot: []};
const EXPECT_EXTRAS = {visible: [], text: ['contains'], count: ['min'], api: []};
const TOP_KEYS = ['name', 'base_url', 'login', 'scope', 'allow_origins', 'steps', 'expect'];

class PlanError extends Error {}
class InfraError extends Error {}

const firstLine = (err) => String(err instanceof Error ? err.message : err).split('\n')[0];

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
        throw new PlanError(`${what} ${JSON.stringify(url)} is not an absolute URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new PlanError(`${what} ${JSON.stringify(url)} must be http or https`);
    }
    return u.origin;
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
    const kinds = Object.keys(obj).filter((k) => k in table);
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
    const base = plan.base_url ?? envBase;
    const origin = httpOrigin(base, 'base_url');
    if (hasCredentials(env) && origin !== httpOrigin(envBase, 'VERIFY_BASE_URL / MM_URL')) {
        throw new PlanError(`base_url ${origin} differs from ${new URL(envBase).origin}; credentials only go to VERIFY_BASE_URL / MM_URL`);
    }
    if ('scope' in plan) {
        checkLocator(plan.scope, 'scope');
    }
    const allowOrigins = plan.allow_origins ?? [];
    if (!Array.isArray(allowOrigins)) {
        throw new PlanError('allow_origins must be an array');
    }
    const allowed = [origin, ...allowOrigins.map((o, i) => httpOrigin(o, `allow_origins[${i}]`))];
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
            if (!nonEmpty(s.goto)) {
                throw new PlanError(`${where}: goto must be a non-empty path`);
            }
            let target;
            try {
                target = new URL(s.goto, base);
            } catch {
                throw new PlanError(`${where}: goto ${JSON.stringify(s.goto)} is not a URL`);
            }
            if (target.origin !== origin) {
                throw new PlanError(`${where}: goto ${s.goto} leaves ${origin}; plans stay on the server under test`);
            }
        } else if (action === 'press') {
            if (!nonEmpty(s.press)) {
                throw new PlanError(`${where}: press must be a key name such as "Enter"`);
            }
            if ('on' in s) {
                checkLocator(s.on, `${where} on`);
            }
        } else if (action === 'snapshot') {
            if (s.snapshot !== null) {
                checkLocator(s.snapshot, where);
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
            if (!isObj(api) || Object.keys(api).some((k) => !['path', 'status', 'json_has'].includes(k))) {
                throw new PlanError(`${where}: api takes only path, status and json_has`);
            }
            if (!nonEmpty(api.path) || !api.path.startsWith('/api/v4/')) {
                throw new PlanError(`${where}: api.path must start with /api/v4/`);
            }
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

function locate(page, loc) {
    const l = locateAll(page, loc);
    return loc.nth === undefined ? l.first() : l.nth(loc.nth);
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
                {headers: {...headers, Authorization: `Bearer ${token}`}});
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
        res = await context.request.post(new URL('/api/v4/users/login', base).toString(),
            {data: {login_id: env.VERIFY_USER, password: env.VERIFY_PASSWORD}, headers});
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
    return Object.is(want, got);
}

const hasCredentials = (env) => Boolean(env.VERIFY_TOKEN || (env.VERIFY_USER && env.VERIFY_PASSWORD));

function originOf(url) {
    const u = new URL(url);
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
        return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null; // data:, blob:, about: are local
}

// ---------------------------------------------------------------- the run

async function runStep(page, base, step) {
    if ('goto' in step) {
        await page.goto(new URL(step.goto, base).toString(), {waitUntil: 'domcontentloaded'});
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

async function checkExpect(page, base, e) {
    if (e.visible) {
        const ok = await locate(page, e.visible).waitFor({state: 'visible', timeout: ACTION_TIMEOUT_MS}).then(() => true, () => false);
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
    const auth = process.env.VERIFY_TOKEN ? {Authorization: `Bearer ${process.env.VERIFY_TOKEN}`} : {};
    const res = await page.request.get(new URL(e.api.path, base).toString(), {headers: {'X-Requested-With': 'XMLHttpRequest', ...auth}});
    if (res.status() >= 500) {
        return `GET ${e.api.path} returned ${res.status()}; a server error never satisfies an expectation`;
    }
    const status = e.api.status ?? 200;
    if (res.status() !== status) {
        return `GET ${e.api.path} returned ${res.status()}, want ${status}`;
    }
    if (e.api.json_has) {
        const body = await res.json().catch(() => null);
        if (!subset(e.api.json_has, body)) {
            return `GET ${e.api.path} body lacks ${JSON.stringify(e.api.json_has)}: ${JSON.stringify(body).slice(0, 300)}`;
        }
    }
    return null;
}

async function reachable(context, base) {
    try {
        await context.request.get(new URL('/api/v4/system/ping', base).toString(), {timeout: 5000, maxRedirects: 0});
        return true;
    } catch {
        return false;
    }
}

export async function verify(plan, log = console.log, freezeTo = null, env = process.env) {
    const {steps, base, allowed} = validatePlan(plan, env);
    const limit = settleMs(env);
    const authed = hasCredentials(env);
    if (plan.login && !authed) {
        throw new InfraError('login required but neither VERIFY_TOKEN nor VERIFY_USER + VERIFY_PASSWORD is set');
    }
    const allowedSet = new Set(allowed);
    const scope = plan.scope ?? null;
    const {chromium} = loadPlaywright();
    let browser;
    try {
        browser = await chromium.launch();
    } catch (err) {
        throw new InfraError(`cannot start Chromium: ${firstLine(err)}`);
    }
    const problems = [];
    const blocked = new Set();
    const finish = (code, reason = '', snap = '') => {
        if (blocked.size) {
            log(`blocked other origins: ${[...blocked].join(', ')} (add to allow_origins if the app needs them)`);
        }
        log(code === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL ${reason}`);
        if (snap) {
            log(`scope snapshot at failure:\n${snap}`);
        }
        return code;
    };
    try {
        const context = await browser.newContext({viewport: {width: 1280, height: 800}});
        await context.route('**/*', (route) => {
            const origin = originOf(route.request().url());
            if (origin === null || allowedSet.has(origin)) {
                return route.continue();
            }
            blocked.add(origin);
            return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.inflight = new Set();
        page.on('request', (r) => {
            page.inflight.add(r);
            // Redirect hops are not routed, so the route above cannot block them: check every request here.
            const origin = originOf(r.url());
            if (origin !== null && !allowedSet.has(origin)) {
                blocked.add(origin);
                if (r.redirectedFrom()) {
                    problems.push(`redirected to a non-allowed origin: ${r.method()} ${origin}`);
                }
            }
        });
        page.on('requestfinished', (r) => page.inflight.delete(r));
        page.on('requestfailed', (r) => page.inflight.delete(r));
        page.on('websocket', (ws) => {
            const origin = originOf(ws.url());
            if (origin !== null && !allowedSet.has(origin)) {
                problems.push(`websocket to a non-allowed origin: ${origin}`);
            }
        });
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.on('pageerror', (err) => problems.push(`pageerror: ${firstLine(err)}`));
        page.on('response', (res) => {
            if (res.status() >= 500 && new URL(res.url()).pathname.startsWith('/api/v4/')) {
                problems.push(`HTTP ${res.status()} from ${res.request().method()} ${new URL(res.url()).pathname}`);
            }
        });
        const afterStep = async () => {
            const late = await settle(page, limit);
            if (late) {
                problems.push(late);
            }
            const origin = originOf(page.url());
            if (origin !== null && !allowedSet.has(origin)) {
                problems.push(`the page left the allowed origins: now on ${origin}`);
            }
        };
        if (authed) {
            try {
                log(await apiLogin(context, base, env));
            } catch (err) {
                const msg = firstLine(err);
                throw new InfraError(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|net::ERR_/.test(msg) ? `server unreachable at ${base}: ${msg}` : msg);
            }
        }
        for (const [i, step] of steps.entries()) {
            const label = `step ${i + 1}/${steps.length} ${JSON.stringify(step)}`;
            try {
                if ('snapshot' in step) {
                    log(`${label}\n${await snapshot(page, step.snapshot ?? scope)}`);
                    continue;
                }
                await runStep(page, base, step);
                await afterStep();
            } catch (err) {
                const msg = firstLine(err);
                if (/net::ERR_|ECONNREFUSED/.test(msg) && !(await reachable(context, base))) {
                    throw new InfraError(`server unreachable at ${base}: ${msg}`);
                }
                const snap = await snapshot(page, scope).catch(() => '(no snapshot)');
                return finish(1, `${label} failed: ${problems.length ? `${problems.join('; ')}; ` : ''}${msg}`, snap);
            }
            if (problems.length) {
                return finish(1, `${label}: ${problems.join('; ')}`, await snapshot(page, scope).catch(() => ''));
            }
            log(`${label} ok`);
        }
        for (const [i, e] of plan.expect.entries()) {
            const why = await checkExpect(page, base, e).catch((err) => firstLine(err));
            if (why || problems.length) {
                return finish(1, `expect ${i + 1}: ${why ?? problems.join('; ')}`, await snapshot(page, scope).catch(() => ''));
            }
            log(`expect ${i + 1} ok ${JSON.stringify(e)}`);
        }
        // Late events (a 500 or page error after the last check) count too.
        await afterStep();
        if (problems.length) {
            return finish(1, `after the checks: ${problems.join('; ')}`, await snapshot(page, scope).catch(() => ''));
        }
        if (freezeTo) {
            try {
                writeFileSync(freezeTo, freeze(plan, base, allowed.slice(1), authed));
            } catch (err) {
                throw new InfraError(`cannot write ${freezeTo}: ${firstLine(err)}`);
            }
            log(`frozen to ${freezeTo}: rerun with \`npx playwright test ${path.basename(freezeTo)}\` (no model needed)`);
        }
        return finish(0);
    } finally {
        await browser.close().catch(() => {});
    }
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

const one = (loc) => `${locatorCode(loc)}.${loc.nth === undefined ? 'first()' : `nth(${Number(loc.nth)})`}`;

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
    for (const s of plan.steps ?? []) {
        if ('goto' in s) {
            lines.push(`await page.goto(new URL(${q(s.goto)}, BASE).toString(), {waitUntil: 'domcontentloaded'});`);
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
            lines.push('{', `  const res = await apiGet(page, ${q(e.api.path)});`,
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
  await apiLogin(context, BASE, process.env);` : '';
    // Contextual typing gives the copied functions typed parameters, so the spec passes `tsc --strict`.
    const loginFn = needsLogin ? `
// Same API login as verify_ui.mjs (copied from its apiLogin): no steps spent on the login form.
const apiLogin: (context: BrowserContext, base: string, env: NodeJS.ProcessEnv) => Promise<string> = ${apiLogin.toString()};
` : '';
    return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan, with the same oracle: allowed origins only, every step settles, and page
// errors, >= 500 /api/v4/ responses, requests still running at the deadline, or leaving the allowed origins fail.
import {expect, test, type BrowserContext, type Page} from '@playwright/test';

test.use({viewport: {width: 1280, height: 800}});

const BASE = process.env.VERIFY_BASE_URL || process.env.MM_URL || ${q(base)};
const ALLOWED = new Set([new URL(BASE).origin, ...${q(allowOrigins)}.map((o: string) => new URL(o).origin)]);
const SETTLE_MS = Number(process.env.VERIFY_SETTLE_MS ?? ${DEFAULT_SETTLE_MS});
const QUIET_MS = ${QUIET_MS};
const TIMEOUT = ${ACTION_TIMEOUT_MS};

const originOf: (url: string) => string | null = ${originOf.toString()};
${typedSubset()}

// API reads carry the token when there is one; errors keep only their first line (the full one lists headers).
async function apiGet(page: Page, path: string) {
  const auth: Record<string, string> = process.env.VERIFY_TOKEN ? {Authorization: \`Bearer \${process.env.VERIFY_TOKEN}\`} : {};
  try {
    return await page.request.get(new URL(path, BASE).toString(), {headers: {'X-Requested-With': 'XMLHttpRequest', ...auth}});
  } catch (err) {
    throw new Error(String(err instanceof Error ? err.message : err).split('\\n')[0]);
  }
}
${loginFn}
test(${q(plan.name ?? 'frozen /verify plan')}, async ({page, context}) => {
  expect(Number.isFinite(SETTLE_MS) && SETTLE_MS > 0, 'VERIFY_SETTLE_MS must be a positive number').toBe(true);
  const problems: string[] = [];
  const inflight = new Set<unknown>();
  await context.route('**/*', (route) => {
    const origin = originOf(route.request().url());
    return origin === null || ALLOWED.has(origin) ? route.continue() : route.abort('blockedbyclient');
  });
  page.on('request', (r) => {
    inflight.add(r);
    const origin = originOf(r.url());
    if (origin !== null && !ALLOWED.has(origin) && r.redirectedFrom()) {
      problems.push(\`redirected to a non-allowed origin: \${r.method()} \${origin}\`);
    }
  });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
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
    expect(origin === null || ALLOWED.has(origin), \`the page left the allowed origins: \${page.url()}\`).toBe(true);
    expect(problems).toEqual([]);
  };${login}
${lines.map((l) => `  ${l}`).join('\n')}
});
`;
}

// ---------------------------------------------------------------- CLI

async function main() {
    const args = process.argv.slice(2);
    const fi = args.indexOf('--freeze');
    const freezeTo = fi >= 0 ? args.splice(fi, 2)[1] : null;
    if (args.length !== 1 || (fi >= 0 && !freezeTo)) {
        console.error('usage: verify_ui.mjs <plan.json> [--freeze <out.spec.ts>]');
        return 2;
    }
    try {
        let plan;
        try {
            plan = JSON.parse(readFileSync(args[0], 'utf8'));
        } catch (err) {
            throw new PlanError(`cannot read ${args[0]}: ${firstLine(err)}`);
        }
        return await verify(plan, console.log, freezeTo);
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
    process.exitCode = await main();
}
