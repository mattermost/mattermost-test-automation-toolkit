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
// Plan:
// {
//   "base_url": "http://localhost:8065",          (default: $MM_URL or http://localhost:8065)
//   "login": true,                                (POST /api/v4/users/login with $MM_USERNAME / $MM_PASSWORD)
//   "scope": {"role": "main"},                    (default locator for snapshots; default: body)
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

async function snapshot(page, loc) {
    const text = await locate(page, loc).ariaSnapshot({timeout: ACTION_TIMEOUT_MS});
    return text.length > SNAPSHOT_CHARS ? `${text.slice(0, SNAPSHOT_CHARS)}\n... (truncated)` : text;
}

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

// Waits until no request has been in flight for QUIET_MS (bounded by SETTLE_MS). page.waitForLoadState('networkidle')
// cannot do this: it returns at once on a page that already reached that state, missing requests a click starts.
const QUIET_MS = 300;
const SETTLE_MS = 5000;
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
    const res = await page.request.get(new URL(e.api.path, base).toString(), {headers: {'X-Requested-With': 'XMLHttpRequest'}});
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
    const base = plan.base_url ?? process.env.MM_URL ?? 'http://localhost:8065';
    for (const s of steps) {
        if ('goto' in s && new URL(s.goto, base).origin !== new URL(base).origin) {
            throw new PlanError(`goto ${s.goto} leaves ${new URL(base).origin}; plans stay on the server under test`);
        }
    }
    const scope = plan.scope ?? {css: 'body'};
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
        if (plan.login) {
            const {MM_USERNAME: user, MM_PASSWORD: pass} = process.env;
            if (!user || !pass) {
                throw new InfraError('login requested but MM_USERNAME / MM_PASSWORD are not set');
            }
            const res = await context.request.post(new URL('/api/v4/users/login', base).toString(),
                {data: {login_id: user, password: pass}, headers: {'X-Requested-With': 'XMLHttpRequest'}});
            if (!res.ok()) {
                throw new InfraError(`login as ${user} failed: HTTP ${res.status()}`);
            }
            log(`login ok as ${user}`);
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
            writeFileSync(freezeTo, freeze(plan, base));
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

export function freeze(plan, base) {
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
            lines.push(`{`, `  const res = await page.request.get(new URL(${q(e.api.path)}, BASE).toString(), {headers: {'X-Requested-With': 'XMLHttpRequest'}});`,
                `  expect(res.status()).toBe(${e.api.status ?? 200});`);
            if (e.api.json_has) {
                lines.push(`  expect(await res.json()).toMatchObject(${q(e.api.json_has)});`);
            }
            lines.push('}');
        }
    }
    lines.push('await settle();');
    const login = plan.login ? `
  const login = await page.request.post(new URL('/api/v4/users/login', BASE).toString(), {
    data: {login_id: process.env.MM_USERNAME, password: process.env.MM_PASSWORD},
    headers: {'X-Requested-With': 'XMLHttpRequest'},
  });
  expect(login.ok()).toBe(true);` : '';
    return `// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Frozen by verify_ui.mjs from a passing plan. Same oracle: page errors and >= 500 /api/v4/ responses fail the test.
import {expect, test} from '@playwright/test';

const BASE = process.env.MM_URL ?? ${q(base)};

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
