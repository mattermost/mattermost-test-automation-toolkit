#!/usr/bin/env node
// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Text-only UI smoke check against a running Mattermost server. Never takes screenshots.
//
// usage: verify_ui.mjs <plan.json> [--freeze <out.spec.ts>]
// Exit codes: 0 PASS, 1 FAIL (assertion, pageerror or a >=500 API response), 2 invalid plan or infrastructure.
// Bounded by design: at most MAX_STEPS steps, same-origin only (other hosts are blocked and logged), every step waits
// for in-flight requests to settle, and success is a deterministic DOM or /api/v4/ check, never a model's judgement.
// --freeze writes a passing plan as a plain @playwright/test spec, so the check reruns in CI with no model at all.
//
// Auth (API, before the first step, so no step is spent on the login form):
//   VERIFY_TOKEN                   session or personal access token: Bearer header on same-origin fetch/XHR only, never
//                                  across redirects, + MMUSERID cookie;
//                                  no cookie session, so no CSRF; the webapp's websocket stays unauthenticated
//   VERIFY_USER + VERIFY_PASSWORD  POST /api/v4/users/login; the server sets MMAUTHTOKEN, MMUSERID and MMCSRF
// Frozen specs embed the same apiLogin() and read the same variables.
//
// Plan:
// {
//   "base_url": "http://localhost:8065",          (default: $VERIFY_BASE_URL, $MM_URL or http://localhost:8065)
//   "login": true,                                (require auth: INFRA_ERROR when no VERIFY_* credentials are set)
//   "scope": {"role": "main"},                    (snapshot scope; default: #app-content if present, else body.
//                                                  Open dialogs, menus and listboxes outside it are always added.)
//   "allow_origins": ["https://cdn.example.com"], (extra origins the page may load; default: base_url only)
//   "steps": [ at most MAX_STEPS of
//     {"goto": "/team/channels/town-square"} | {"click": LOC} | {"fill": LOC, "value": "text"} |
//     {"press": "Enter", "on": LOC?} | {"select": LOC, "value": "x"} | {"check": LOC} | {"wait_for": LOC} |
//     {"snapshot": LOC?} ],
//   "expect": [ at least one of
//     {"visible": LOC} | {"text": LOC, "contains": "x"} | {"count": LOC, "min": 1} |
//     {"api": {"path": "/api/v4/users/me", "status": 200, "json_has": {"username": "sysadmin"}}} ]
// }
// LOC: {"role": "button", "name": "Save", "exact"?: true} | {"testid"} | {"label"} | {"placeholder"} | {"text"} |
//      {"css"}, plus optional "nth".

import {createRequire} from 'node:module';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const MAX_STEPS = 10;
const ACTION_TIMEOUT_MS = 10000;
const SNAPSHOT_CHARS = 4000;
const STEP_KEYS = ['goto', 'click', 'fill', 'press', 'select', 'check', 'wait_for', 'snapshot'];
const EXPECT_KEYS = ['visible', 'text', 'count', 'api'];
const LOC_KEYS = ['role', 'testid', 'label', 'placeholder', 'text', 'css'];

class PlanError extends Error {}
class InfraError extends Error {}

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

export function validatePlan(plan) {
    if (!plan || typeof plan !== 'object') {
        throw new PlanError('plan must be a JSON object');
    }
    const steps = plan.steps ?? [];
    if (!Array.isArray(steps)) {
        throw new PlanError('steps must be an array');
    }
    if (steps.length > MAX_STEPS) {
        throw new PlanError(`plan has ${steps.length} steps; MAX_STEPS is ${MAX_STEPS}`);
    }
    steps.forEach((s, i) => {
        const action = Object.keys(s).find((k) => STEP_KEYS.includes(k));
        const unknown = Object.keys(s).filter((k) => !STEP_KEYS.includes(k) && !['value', 'on'].includes(k));
        if (!action || unknown.length) {
            throw new PlanError(`step ${i + 1}: unknown action ${JSON.stringify(Object.keys(s))} (allowed: ${STEP_KEYS.join(', ')})`);
        }
    });
    if (!Array.isArray(plan.expect) || plan.expect.length === 0) {
        throw new PlanError('expect must list at least one deterministic DOM or /api/v4/ check');
    }
    plan.expect.forEach((e, i) => {
        const kind = Object.keys(e).find((k) => EXPECT_KEYS.includes(k));
        if (!kind) {
            throw new PlanError(`expect ${i + 1}: unknown check ${JSON.stringify(Object.keys(e))}`);
        }
        if (kind === 'api' && !String(e.api?.path ?? '').startsWith('/api/v4/')) {
            throw new PlanError(`expect ${i + 1}: api.path must start with /api/v4/`);
        }
        if (kind === 'api' && (e.api.status ?? 200) >= 500) {
            throw new PlanError(`expect ${i + 1}: api.status ${e.api.status} expects a server error, which always fails`);
        }
    });
    return steps;
}

function locateAll(page, loc) {
    if (!loc || typeof loc !== 'object' || !LOC_KEYS.some((k) => k in loc)) {
        throw new PlanError(`bad locator ${JSON.stringify(loc)} (use one of ${LOC_KEYS.join(', ')})`);
    }
    let l;
    if (loc.role) {
        l = page.getByRole(loc.role, loc.name === undefined ? {} : {name: loc.name, exact: Boolean(loc.exact)});
    } else if (loc.testid) {
        l = page.getByTestId(loc.testid);
    } else if (loc.label) {
        l = page.getByLabel(loc.label);
    } else if (loc.placeholder) {
        l = page.getByPlaceholder(loc.placeholder);
    } else if (loc.text) {
        l = page.getByText(loc.text);
    } else {
        l = page.locator(loc.css);
    }
    return l;
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

// Self-contained on purpose: --freeze copies this function's source into the generated spec, so frozen tests log in
// exactly the way the run that produced them did.
export async function apiLogin(context, base, env) {
    const headers = {'X-Requested-With': 'XMLHttpRequest'};
    if (env.VERIFY_TOKEN) {
        // A session cookie from a loaded storageState would win over the header and run as another user.
        await context.clearCookies({name: 'MMAUTHTOKEN'});
        const me = await context.request.get(new URL('/api/v4/users/me', base).toString(),
            {headers: {...headers, Authorization: `Bearer ${env.VERIFY_TOKEN}`}});
        if (!me.ok()) {
            throw new Error(`VERIFY_TOKEN rejected by GET /api/v4/users/me: HTTP ${me.status()}`);
        }
        const user = await me.json();
        // No MMAUTHTOKEN cookie: Mattermost reads that cookie before the Authorization header, and a cookie session
        // gets CSRF checks on every non-GET request, which a bare token cannot satisfy. With the token only in the
        // header the server authenticates by header and skips CSRF. MMUSERID tells the webapp it is signed in.
        await context.addCookies([{name: 'MMUSERID', value: user.id, url: base}]);
        // The token goes only to the server under test, never to another origin the page loads.
        const origin = new URL(base).origin;
        await context.route('**/*', async (route) => {
            const request = route.request();
            // Only the webapp's API calls (fetch/XHR) to the server under test carry the token. Pages and static
            // assets are served without auth and pass through untouched (fulfilling a document would also change
            // how Chromium classifies the page for local-network checks).
            if (new URL(request.url()).origin !== origin || !['fetch', 'xhr'].includes(request.resourceType())) {
                return route.fallback();
            }
            // Fetch with the token here and never follow redirects: a redirect goes back to the browser, whose new
            // request passes this origin check again, so the token can't ride a redirect to another host.
            const response = await route.fetch({
                headers: {...request.headers(), authorization: `Bearer ${env.VERIFY_TOKEN}`},
                maxRedirects: 0,
            });
            return route.fulfill({response});
        });
        return `token auth as ${user.username} (Bearer header on same-origin API calls only)`;
    }
    const res = await context.request.post(new URL('/api/v4/users/login', base).toString(),
        {data: {login_id: env.VERIFY_USER, password: env.VERIFY_PASSWORD}, headers});
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

const hasCredentials = (env) => Boolean(env.VERIFY_TOKEN || (env.VERIFY_USER && env.VERIFY_PASSWORD));

function subset(want, got) {
    if (want === null || typeof want !== 'object') {
        return want === got;
    }
    return got !== null && typeof got === 'object' && Object.entries(want).every(([k, v]) => subset(v, got[k]));
}

async function runStep(page, base, step) {
    if ('goto' in step) {
        await page.goto(new URL(step.goto, base).toString(), {waitUntil: 'domcontentloaded'});
    } else if ('click' in step) {
        await locate(page, step.click).click();
    } else if ('fill' in step) {
        await locate(page, step.fill).fill(String(step.value ?? ''));
    } else if ('press' in step) {
        await (step.on ? locate(page, step.on).press(step.press) : page.keyboard.press(step.press));
    } else if ('select' in step) {
        await locate(page, step.select).selectOption(String(step.value));
    } else if ('check' in step) {
        await locate(page, step.check).check();
    } else if ('wait_for' in step) {
        await locate(page, step.wait_for).waitFor({state: 'visible'});
    }
    await settle(page);
}

// Waits until no request has been in flight for QUIET_MS (bounded by SETTLE_MS; a request still running at the
// deadline is reported as a problem, so a slow response can never be skipped into a PASS). page.waitForLoadState('networkidle')
// cannot do this: it returns at once on a page that already reached that state, missing requests a click starts.
const QUIET_MS = 300;
const SETTLE_MS = Number(process.env.VERIFY_SETTLE_MS ?? 10000); // tests lower it
async function settle(page) {
    const start = Date.now();
    let quietSince = page.inflight.size ? 0 : Date.now();
    while (Date.now() - start < SETTLE_MS) {
        await page.waitForTimeout(50);
        if (page.inflight.size) {
            quietSince = 0;
        } else if (!quietSince) {
            quietSince = Date.now();
        } else if (Date.now() - quietSince >= QUIET_MS) {
            return;
        }
    }
    if (page.inflight.size) {
        const urls = [...page.inflight].map((r) => `${r.method()} ${new URL(r.url()).pathname}`).slice(0, 5);
        throw new Error(`${page.inflight.size} request(s) still in flight after ${SETTLE_MS}ms: ${urls.join(', ')}`);
    }
}

async function checkExpect(page, base, e) {
    if (e.visible) {
        const ok = await locate(page, e.visible).waitFor({state: 'visible', timeout: ACTION_TIMEOUT_MS}).then(() => true, () => false);
        return ok ? null : `not visible within ${ACTION_TIMEOUT_MS}ms: ${JSON.stringify(e.visible)}`;
    }
    if (e.text) {
        const got = await locate(page, e.text).innerText({timeout: ACTION_TIMEOUT_MS});
        return got.includes(e.contains) ? null : `text of ${JSON.stringify(e.text)} is ${JSON.stringify(got.slice(0, 200))}, want it to contain ${JSON.stringify(e.contains)}`;
    }
    if (e.count) {
        const n = await locateAll(page, e.count).count();
        return n >= (e.min ?? 1) ? null : `count of ${JSON.stringify(e.count)} is ${n}, want >= ${e.min ?? 1}`;
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

export async function verify(plan, log = console.log, freezeTo = null) {
    const steps = validatePlan(plan);
    const base = plan.base_url ?? process.env.VERIFY_BASE_URL ?? process.env.MM_URL ?? 'http://localhost:8065';
    for (const s of steps) {
        if ('goto' in s && new URL(s.goto, base).origin !== new URL(base).origin) {
            throw new PlanError(`goto ${s.goto} leaves ${new URL(base).origin}; plans stay on the server under test`);
        }
    }
    const scope = plan.scope ?? null;
    const {chromium} = loadPlaywright();
    const browser = await chromium.launch();
    const problems = [];
    try {
        const context = await browser.newContext({viewport: {width: 1280, height: 800}});
        const allowed = new Set([new URL(base).origin, ...(plan.allow_origins ?? []).map((o) => new URL(o).origin)]);
        const blocked = new Set();
        await context.route('**/*', (route) => {
            const url = route.request().url();
            if (/^(data|blob):/.test(url) || allowed.has(new URL(url).origin)) {
                return route.continue();
            }
            blocked.add(new URL(url).origin);
            return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        page.inflight = new Set();
        page.on('request', (r) => page.inflight.add(r));
        page.on('requestfinished', (r) => page.inflight.delete(r));
        page.on('requestfailed', (r) => page.inflight.delete(r));
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.on('pageerror', (err) => problems.push(`pageerror: ${String(err.message ?? err).split('\n')[0]}`));
        page.on('response', (res) => {
            if (res.status() >= 500 && new URL(res.url()).pathname.startsWith('/api/v4/')) {
                problems.push(`HTTP ${res.status()} from ${res.request().method()} ${new URL(res.url()).pathname}`);
            }
        });
        const authed = hasCredentials(process.env);
        if (plan.login && !authed) {
            throw new InfraError('login required but neither VERIFY_TOKEN nor VERIFY_USER + VERIFY_PASSWORD is set');
        }
        if (authed) {
            try {
                log(await apiLogin(context, base, process.env));
            } catch (err) {
                const msg = String(err.message ?? err).split('\n')[0];
                throw new InfraError(/ECONNREFUSED|ENOTFOUND|net::ERR_/.test(msg) ? `server unreachable at ${base}: ${msg}` : msg);
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
            } catch (err) {
                if (err instanceof PlanError) {
                    throw err;
                }
                if (/net::ERR_|ECONNREFUSED/.test(String(err))) {
                    throw new InfraError(`server unreachable at ${base}: ${String(err).split('\n')[0]}`);
                }
                const snap = await snapshot(page, scope).catch(() => '(no snapshot)');
                return fail(log, `${label} failed: ${String(err.message ?? err).split('\n')[0]}`, snap);
            }
            if (problems.length) {
                return fail(log, `${label}: ${problems.join('; ')}`, await snapshot(page, scope).catch(() => ''));
            }
            log(`${label} ok`);
        }
        for (const [i, e] of plan.expect.entries()) {
            const why = await checkExpect(page, base, e).catch((err) => String(err.message ?? err).split('\n')[0]);
            if (why || problems.length) {
                return fail(log, `expect ${i + 1}: ${why ?? problems.join('; ')}`, await snapshot(page, scope).catch(() => ''));
            }
            log(`expect ${i + 1} ok ${JSON.stringify(e)}`);
        }
        if (blocked.size) {
            log(`blocked other origins: ${[...blocked].join(', ')} (add to allow_origins if the app needs them)`);
        }
        log('VERDICT: PASS');
        if (freezeTo) {
            writeFileSync(freezeTo, freeze(plan, base, authed));
            log(`frozen to ${freezeTo}: rerun with \`npx playwright test ${path.basename(freezeTo)}\` (no model needed)`);
        }
        return 0;
    } finally {
        await browser.close();
    }
}

function locatorCode(loc) {
    let code;
    if (loc.role) {
        code = loc.name === undefined ? `page.getByRole(${JSON.stringify(loc.role)})` :
            `page.getByRole(${JSON.stringify(loc.role)}, {name: ${JSON.stringify(loc.name)}, exact: ${Boolean(loc.exact)}})`;
    } else if (loc.testid) {
        code = `page.getByTestId(${JSON.stringify(loc.testid)})`;
    } else if (loc.label) {
        code = `page.getByLabel(${JSON.stringify(loc.label)})`;
    } else if (loc.placeholder) {
        code = `page.getByPlaceholder(${JSON.stringify(loc.placeholder)})`;
    } else if (loc.text) {
        code = `page.getByText(${JSON.stringify(loc.text)})`;
    } else {
        code = `page.locator(${JSON.stringify(loc.css)})`;
    }
    return code;
}

const one = (loc) => `${locatorCode(loc)}.${loc.nth === undefined ? 'first()' : `nth(${loc.nth})`}`;

export function freeze(plan, base, authed = false) {
    const q = JSON.stringify;
    const lines = [];
    for (const s of plan.steps ?? []) {
        if ('goto' in s) {
            lines.push(`await page.goto(new URL(${q(s.goto)}, BASE).toString());`);
        } else if ('click' in s) {
            lines.push(`await ${one(s.click)}.click();`);
        } else if ('fill' in s) {
            lines.push(`await ${one(s.fill)}.fill(${q(String(s.value ?? ''))});`);
        } else if ('press' in s) {
            lines.push(s.on ? `await ${one(s.on)}.press(${q(s.press)});` : `await page.keyboard.press(${q(s.press)});`);
        } else if ('select' in s) {
            lines.push(`await ${one(s.select)}.selectOption(${q(String(s.value))});`);
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
            lines.push(`await expect(${one(e.visible)}).toBeVisible();`);
        } else if (e.text) {
            lines.push(`await expect(${one(e.text)}).toContainText(${q(e.contains)});`);
        } else if (e.count) {
            lines.push(`await expect.poll(() => ${locatorCode(e.count)}.count()).toBeGreaterThanOrEqual(${e.min ?? 1});`);
        } else {
            lines.push(`{`, `  const auth = process.env.VERIFY_TOKEN ? {Authorization: \`Bearer \${process.env.VERIFY_TOKEN}\`} : {};`,
                `  const res = await page.request.get(new URL(${q(e.api.path)}, BASE).toString(), {headers: {'X-Requested-With': 'XMLHttpRequest', ...auth}});`,
                '  expect(res.status(), \'no server error\').toBeLessThan(500);', `  expect(res.status()).toBe(${e.api.status ?? 200});`);
            if (e.api.json_has) {
                lines.push(`  expect(await res.json()).toMatchObject(${q(e.api.json_has)});`);
            }
            lines.push('}');
        }
    }
    lines.push('await settle();');
    const login = plan.login || authed ? `
  expect(Boolean(process.env.VERIFY_TOKEN || (process.env.VERIFY_USER && process.env.VERIFY_PASSWORD)),
    'set VERIFY_TOKEN or VERIFY_USER + VERIFY_PASSWORD').toBe(true);
  await apiLogin(page.context(), BASE, process.env);` : '';
    const loginFn = login ? `\n// Same API login as verify_ui.mjs (copied from its apiLogin): no steps spent on the login form.\n${apiLogin.toString()}\n` : '';
    return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan. Same oracle: page errors and >= 500 /api/v4/ responses fail the test.
import {expect, test} from '@playwright/test';

const BASE = process.env.VERIFY_BASE_URL ?? process.env.MM_URL ?? ${q(base)};
${loginFn}
test(${q(plan.name ?? 'frozen /verify plan')}, async ({page}) => {
  const problems: string[] = [];
  const inflight = new Set<unknown>();
  page.on('request', (r) => inflight.add(r));
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  // Wait until nothing has been in flight for ${QUIET_MS}ms (at most ${SETTLE_MS}ms), as verify_ui.mjs does.
  const settle = async () => {
    const start = Date.now();
    let quiet = Date.now();
    while (Date.now() - start < ${SETTLE_MS} && (inflight.size || Date.now() - quiet < ${QUIET_MS})) {
      if (inflight.size) {
        quiet = Date.now();
      }
      await page.waitForTimeout(50);
    }
    expect(inflight.size, 'requests still in flight at the settle deadline').toBe(0);
    expect(problems).toEqual([]); // fail fast after every step, like verify_ui.mjs
  };
  page.on('pageerror', (err) => problems.push(\`pageerror: \${err.message}\`));
  page.on('response', (res) => {
    if (res.status() >= 500 && new URL(res.url()).pathname.startsWith('/api/v4/')) {
      problems.push(\`HTTP \${res.status()} from \${new URL(res.url()).pathname}\`);
    }
  });${login}
${lines.map((l) => `  ${l}`).join('\n')}
});
`;
}

function fail(log, reason, snap) {
    log(`VERDICT: FAIL ${reason}`);
    if (snap) {
        log(`scope snapshot at failure:\n${snap}`);
    }
    return 1;
}

async function main() {
    const args = process.argv.slice(2);
    const fi = args.indexOf('--freeze');
    const freezeTo = fi >= 0 ? args.splice(fi, 2)[1] : null;
    if (args.length !== 1 || (fi >= 0 && !freezeTo)) {
        console.error('usage: verify_ui.mjs <plan.json> [--freeze <out.spec.ts>]');
        return 2;
    }
    try {
        return await verify(JSON.parse(readFileSync(args[0], 'utf8')), console.log, freezeTo);
    } catch (err) {
        if (err instanceof PlanError || err instanceof InfraError || err instanceof SyntaxError) {
            console.log(`VERDICT: ${err instanceof InfraError ? 'INFRA_ERROR' : 'INVALID_PLAN'} ${err.message}`);
            return 2;
        }
        throw err;
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify_ui.mjs')) {
    process.exitCode = await main();
}
