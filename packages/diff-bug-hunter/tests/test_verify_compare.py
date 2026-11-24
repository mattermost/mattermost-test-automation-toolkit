# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""/verify compare mode: the same plan against a base and a head server, and code (not a model) decides.

The fixture is one http.server class started twice, once per "version" of a server. Every request returns fresh random
ids and timestamps and a per-server version and origin, so a SAME verdict proves the normalisation works; the one field
that really differs is set per test."""

import http.server
import json
import random
import subprocess
import threading
import time
from pathlib import Path

import pytest
from test_hunt_engine import VERIFY_UI, _module, _node_env, needs_node, needs_playwright

ID_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769"  # the characters Mattermost ids are made of
SECRET = "*" * 32


def _id() -> str:
    return "".join(random.choice(ID_ALPHABET) for _ in range(26))


class _Server(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code: int, body: str, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        o = self.server.opts
        origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        if self.path == "/api/v4/config":
            self._send(200, json.dumps({
                "ServiceSettings": {"SiteURL": origin, "ListenAddress": ":8065"},
                "PluginSettings": {"Plugins": {"com.mattermost.calls": {"allowenablecalls": o.get("calls", True)}}},
                "BuildNumber": o["version"], "Version": o["version"],
                "Users": [{"id": _id(), "username": "sysadmin", "create_at": random.randint(1, 10**12),
                           "update_at": random.randint(1, 10**12), "delete_at": 0,
                           "last_password_update_at": time.time_ns() // 1000, "created": "2024-05-06T07:08:09.123Z",
                           "avatar": f"{origin}/api/v4/users/{_id()}/image"}],
            }))
        elif self.path == "/api/v4/flag":
            self._send(200, json.dumps({"on": o.get("flag", True)}))
        elif self.path == "/api/v4/text":
            self._send(200, f"plain text from {origin}", "text/plain")
        elif self.path == "/page":
            self._send(200, f"<html><body><main><h1>{o.get('heading', 'Channels')}</h1><p>{_id()}</p></main></body></html>",
                       "text/html")
        elif self.path == "/boom":
            script = "" if o.get("quiet") else "<script>throw new Error('base page broke')</script>"
            self._send(200, f"<html><body><main><p>x</p>{script}</main></body></html>", "text/html")
        elif self.path == "/app":
            # like the webapp's root.tsx: first visit redirects to /landing unless __landingPageSeen__ is set
            self._send(200, "<html><body><main><p id='m'>loading</p></main><script>"
                       "if (!localStorage.getItem('__landingPageSeen__')) { location.href = '/landing'; }"
                       "else { document.getElementById('m').textContent = 'app home'; }</script></body></html>", "text/html")
        elif self.path == "/landing":
            self._send(200, "<html><body><main><h1>Where would you like to view this?</h1></main></body></html>", "text/html")
        else:
            self._send(404, "{}")


def _start(**opts) -> tuple[str, http.server.ThreadingHTTPServer]:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Server)
    srv.opts = {"version": "11.0.2", **opts}
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}", srv


@pytest.fixture
def servers():
    started = []

    def make(base: dict, head: dict) -> tuple[str, str]:
        b, bs = _start(**base)
        h, hs = _start(**head)
        started.extend([bs, hs])
        return b, h

    yield make
    for srv in started:
        srv.shutdown()
        srv.server_close()


def compare(tmp: Path, plan: dict, base: str, head: str, *extra: str) -> tuple[int, str]:
    (tmp / "plan.json").write_text(json.dumps(plan))
    env = {**_node_env("none"), "VERIFY_BASE_URL": head}
    p = subprocess.run(["node", str(VERIFY_UI), "plan.json", "--compare", base, *extra], cwd=tmp, env=env,
                       capture_output=True, text=True, timeout=180, check=False)
    return p.returncode, p.stdout + p.stderr


def verdict(out: str) -> str:
    lines = [ln for ln in out.splitlines() if ln.startswith("VERDICT:")]
    assert len(lines) == 1, out
    return lines[0]


CONFIG_PLAN = {"steps": [{"capture": {"api": "/api/v4/config"}}], "expect": [{"api": {"path": "/api/v4/flag"}}]}
DIFF_LINE = "DIFF 1 PluginSettings.Plugins.com.mattermost.calls.allowenablecalls:"


@needs_playwright
def test_compare_same_despite_random_ids_timestamps_versions_and_origins(tmp_path, servers):
    base, head = servers({"version": "11.2.0"}, {"version": "11.0.2"})
    code, out = compare(tmp_path, {**CONFIG_PLAN, "steps": [{"capture": {"api": "/api/v4/config"}},
                                                           {"capture": {"api": "/api/v4/text"}}]}, base, head)
    assert code == 0 and verdict(out) == "VERDICT: SAME", out
    assert not [ln for ln in out.splitlines() if ln.startswith("DIFF ")], out


@needs_playwright
def test_compare_reports_the_one_real_difference_as_diff(tmp_path, servers):
    base, head = servers({"calls": True, "version": "11.2.0"}, {"calls": SECRET, "version": "11.0.2"})
    code, out = compare(tmp_path, CONFIG_PLAN, base, head)
    assert code == 1 and verdict(out) == "VERDICT: DIFF", out
    diffs = [ln for ln in out.splitlines() if ln.startswith("DIFF ")]
    assert diffs == [f'{DIFF_LINE} base=true head="{SECRET}"'], out


@needs_playwright
def test_compare_ignore_paths_suppress_a_known_difference(tmp_path, servers):
    base, head = servers({"calls": True}, {"calls": SECRET})
    for ignore in ("PluginSettings.Plugins", "PluginSettings.*.allowenablecalls"):
        code, out = compare(tmp_path, {**CONFIG_PLAN, "ignore": [ignore]}, base, head)
        assert code == 0 and verdict(out) == "VERDICT: SAME", (ignore, out)


@needs_playwright
def test_compare_regression_when_an_expect_passes_on_base_and_fails_on_head(tmp_path, servers):
    base, head = servers({"flag": True}, {"flag": False})
    plan = {"steps": [], "expect": [{"api": {"path": "/api/v4/flag", "json_has": {"on": True}}}]}
    code, out = compare(tmp_path, plan, base, head)
    assert code == 1 and verdict(out) == "VERDICT: REGRESSION", out
    assert "DIFF expect1 result: base=PASS head=FAIL" in out, out
    # the other direction (fails on base, passes on head) is a difference, not a regression
    code, out = compare(tmp_path, plan, head, base)
    assert code == 1 and verdict(out) == "VERDICT: DIFF", out
    # both fail: nothing differs
    code, out = compare(tmp_path, plan, head, head)
    assert code == 0 and verdict(out) == "VERDICT: SAME", out


@needs_playwright
def test_compare_diffs_snapshots_as_text_and_ignores_ids_in_them(tmp_path, servers):
    base, head = servers({"heading": "Channels"}, {"heading": "Threads"})
    plan = {"steps": [{"goto": "/page"}, {"snapshot": {"role": "main"}}], "expect": [{"visible": {"role": "main"}}]}
    code, out = compare(tmp_path, plan, base, head)
    assert code == 1 and verdict(out) == "VERDICT: DIFF", out
    diffs = [ln for ln in out.splitlines() if ln.startswith("DIFF ")]
    assert diffs == ['DIFF 2 snapshot: base="  - heading \\"Channels\\" [level=1]" head="  - heading \\"Threads\\" [level=1]"'], out
    code, out = compare(tmp_path, plan, base, base)  # only the random id in the page differs
    assert code == 0 and verdict(out) == "VERDICT: SAME", out


@needs_playwright
def test_compare_a_failing_step_is_fail_not_a_diff(tmp_path, servers):
    base, head = servers({}, {})
    plan = {"steps": [{"goto": "/page"}, {"click": {"role": "button", "name": "Missing"}}],
            "expect": [{"visible": {"role": "main"}}]}
    code, out = compare(tmp_path, plan, base, head)
    assert code == 1 and verdict(out).startswith("VERDICT: FAIL base run failed: step 2/2"), out
    assert "[head]" not in out, "a failing base stops the comparison before the head runs"


@needs_playwright
def test_compare_page_errors_are_diffed_not_fatal(tmp_path, servers):
    plan = {"steps": [{"goto": "/boom"}], "expect": [{"visible": {"role": "main"}}]}
    base, head = servers({}, {})  # both servers throw the same page error: shared noise is not a difference
    code, out = compare(tmp_path, plan, base, head)
    assert code == 0 and verdict(out) == "VERDICT: SAME", out
    base, head = servers({"quiet": True}, {})  # only the head throws
    code, out = compare(tmp_path, plan, base, head)
    assert code == 1 and verdict(out) == "VERDICT: DIFF", out
    assert 'DIFF run problem: base=<absent> head="pageerror: base page broke"' in out, out


@needs_playwright
def test_compare_errors_exit_2(tmp_path, servers):
    base, head = servers({}, {})
    for plan in ({"steps": [{"capture": {"api": "/not/api"}}], "expect": [{"api": {"path": "/api/v4/flag"}}]},
                 {"steps": [{"capture": {"api": "/api/v4/x", "nope": 1}}], "expect": [{"api": {"path": "/api/v4/flag"}}]},
                 {**CONFIG_PLAN, "ignore": [""]}):
        code, out = compare(tmp_path, plan, base, head)
        assert code == 2 and verdict(out).startswith("VERDICT: INVALID_PLAN"), (plan, out)
    code, out = compare(tmp_path, CONFIG_PLAN, "http://127.0.0.1:9", head)
    assert code == 2 and verdict(out).startswith("VERDICT: INFRA_ERROR base run:"), out
    code, out = compare(tmp_path, CONFIG_PLAN, "http://127.0.0.1:9/path", head)
    assert code == 2 and verdict(out).startswith("VERDICT: INVALID_PLAN"), out
    code, out = compare(tmp_path, CONFIG_PLAN, base, head, "--freeze", "x.spec.ts")
    assert code == 2 and "cannot be combined" in out, out


@needs_playwright
def test_runner_skips_the_desktop_app_landing_page(tmp_path, servers):
    base, _ = servers({}, {})
    (tmp_path / "plan.json").write_text(json.dumps({"base_url": base, "steps": [{"goto": "/app"}],
                                                    "expect": [{"text": {"css": "#m"}, "contains": "app home"}]}))
    p = subprocess.run(["node", str(VERIFY_UI), "plan.json"], cwd=tmp_path, env={**_node_env("none"), "VERIFY_BASE_URL": base},
                       capture_output=True, text=True, timeout=120, check=False)
    assert p.returncode == 0 and "VERDICT: PASS" in p.stdout, p.stdout + p.stderr


@needs_node
def test_normalisation_and_diff_functions():
    i1, i2 = "ybndrfg8ejkmcpqxot1uwisza3", "h769h769h769h769h769h769h7"
    assert len(i1) == len(i2) == 26
    origins = '["http://localhost:8112", "http://localhost:8110"]'
    norm = _module(f"m.normalizeJson({{id: '{i1}', create_at: 1700000000000, delete_at: 0, last_login_at: 5, "
                   f"Version: '11.2.0', BuildNumber: 9, server_version: '11.2', serverVersion: '11.2.0', "
                   f"buildNumber: 9, conversion_rate: 0.42, "
                   f"url: 'http://localhost:8112/x?u={i1}', "
                   "when: '2024-01-02T03:04:05Z', note: 'keep me', nested: [{update_at: 7}]}, " + origins + ")")
    assert json.loads(norm) == {"id": "<id>", "create_at": "<time>", "delete_at": 0, "last_login_at": "<time>",
                                "Version": "<version>", "BuildNumber": "<version>", "server_version": "<version>",
                                "serverVersion": "<version>", "buildNumber": "<version>",
                                "conversion_rate": 0.42, "url": "<origin>/x?u=<id>",
                                "when": "<date>", "note": "keep me", "nested": [{"update_at": "<time>"}]}
    assert json.loads(_module("m.diffJson({a: {b: 1, c: [1, 2]}, d: 1}, {a: {b: 2, c: [1, 3]}, e: 1})")) == [
        {"path": "a.b", "base": 1, "head": 2}, {"path": "a.c[1]", "base": 2, "head": 3}, {"path": "d", "base": 1},
        {"path": "e", "head": 1}]
    assert _module("m.diffJson({a: {b: 1}, c: 1}, {a: {b: 2}, c: 2}, ['a'])").count("path") == 1


@needs_node
def test_normalize_json_preserves_multiple_id_keyed_entries():
    a1, a2 = "ybndrfg8ejkmcpqxot1uwisza3", "h769h769h769h769h769h769h7"
    b1, b2 = "345h769ybndrfg8ejkmcpqxot1", "uwisza345h769ybndrfg8ejkmc"
    same = json.loads(_module(
        f"m.diffJson(m.normalizeJson({{posts: {{'{a1}': {{msg: 'one'}}, '{a2}': {{msg: 'two'}}}}}}), "
        f"m.normalizeJson({{posts: {{'{b2}': {{msg: 'two'}}, '{b1}': {{msg: 'one'}}}}}}))"
    ))
    assert same == []
    changed = json.loads(_module(
        f"m.diffJson(m.normalizeJson({{posts: {{'{a1}': {{msg: 'one'}}, '{a2}': {{msg: 'two'}}}}}}), "
        f"m.normalizeJson({{posts: {{'{b1}': {{msg: 'one'}}, '{b2}': {{msg: 'BROKEN'}}}}}}))"
    ))
    assert changed and any("BROKEN" in json.dumps(d) for d in changed)
    # A literal "<id>#0" key must coexist with grouped 26-char ID keys without collision.
    no_collide = json.loads(_module(
        f"m.normalizeJson({{posts: {{'<id>#0': {{msg: 'literal'}}, '{a1}': {{msg: 'one'}}, '{a2}': {{msg: 'two'}}}}}})"
    ))
    assert len(no_collide["posts"]) == 3 and {"msg": "literal"} in no_collide["posts"].values()
    reordered = json.loads(_module("m.diffLines('First\\nSecond', 'Second\\nFirst')"))
    assert reordered and any("First" in json.dumps(d) for d in reordered)
