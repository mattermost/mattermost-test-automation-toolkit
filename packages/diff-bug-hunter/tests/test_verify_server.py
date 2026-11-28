# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""/verify pr_server.py: which image a commit maps to, whether a running build is that image, and seeding an admin
that /verify can log in as without the onboarding overlay. The server is a small in-process fake of the four
Mattermost API calls seeding makes."""

import http.server
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".claude" / "skills" / "verify" / "scripts"))
import pr_server


def test_a_commit_maps_to_its_published_enterprise_image():
    assert pr_server.image_for("5E62CB15E58D1CD6") == "mattermostdevelopment/mattermost-enterprise-edition:5e62cb1"
    for bad in ("abc12", "master", "zzzzzzzz", ""):
        with pytest.raises(pr_server.InfraError, match="not a commit sha"):
            pr_server.image_for(bad)


def test_a_running_build_matches_only_its_own_image():
    image = "mattermostdevelopment/mattermost-enterprise-edition:5e62cb1"
    assert pr_server.build_matches("5e62cb15e58d1cd6fbbcdb862424b051f5a5e925", image)
    assert not pr_server.build_matches("3f535d172f4f8e9495798e3e1e60068835000a07", image)
    assert not pr_server.build_matches("", image)  # a server that reports no build is never trusted
    assert not pr_server.build_matches("5e62cb15e5", "mattermostdevelopment/mattermost-enterprise-edition:master")


class _Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=None, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body is not None:
            self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        st, body = self.server.state, json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/v4/users":
            if len(body["password"]) < 2:
                return self._send(400, {"id": "model.user.is_valid.pwd.app_error"})
            if body["username"] in st["users"]:
                return self._send(400, {"id": "app.user.save.username_exists.app_error"})
            st["users"][body["username"]] = {"id": f"id-{body['username']}", "password": body["password"],
                                             "roles": "system_user" if st["users"] else "system_admin system_user"}
            return self._send(201, {"id": f"id-{body['username']}"})
        if self.path == "/api/v4/users/login":
            u = st["users"].get(body["login_id"])
            if not u or u["password"] != body["password"]:
                return self._send(401, {})
            return self._send(200, {"id": u["id"], "roles": u["roles"]}, {} if st.get("no_token") else {"Token": "tok"})
        if self.path == "/api/v4/teams":
            if body["name"] in st["teams"]:
                return self._send(400, {})
            st["teams"].add(body["name"])
            return self._send(201, {"id": "team"})
        if self.path == "/api/v4/teams/team/members":
            st["members"].add((body["team_id"], body["user_id"]))
            return self._send(201, body)
        self._send(404, {})

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.headers["Authorization"] == "Bearer tok"
        self.server.state["prefs"] += body
        self._send(200, {"status": "OK"})

    def do_GET(self):
        st = self.server.state
        if self.path == "/api/v4/teams/name/verify":
            return self._send(200, {"id": "team"}) if "verify" in st["teams"] else self._send(404, {})
        if self.path.startswith("/api/v4/users/username/"):
            uname = self.path.rsplit("/", 1)[-1]
            u = st["users"].get(uname)
            return self._send(200, {"id": u["id"], "username": uname}) if u else self._send(404, {})
        self._send(200, {"BuildHash": st["build"]})


@pytest.fixture
def fake():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
    srv.state = {"users": {}, "teams": set(), "members": set(), "prefs": [], "build": "5e62cb15e5"}
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv, f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_seeding_makes_the_first_user_an_admin_and_turns_the_onboarding_overlay_off(fake):
    srv, url = fake
    pr_server.seed(url, "poster", "pw")
    assert srv.state["users"]["poster"]["roles"].startswith("system_admin") and "verify" in srv.state["teams"]
    assert srv.state["users"][pr_server.MEMBER_USER]["roles"] == "system_user"
    assert ("team", f"id-{pr_server.MEMBER_USER}") in srv.state["members"]
    by_user = {}
    for p in srv.state["prefs"]:
        by_user.setdefault(p["user_id"], {})[(p["category"], p["name"])] = p["value"]
    assert set(by_user) == {"id-poster", f"id-{pr_server.MEMBER_USER}"}
    for uid in by_user:
        assert by_user[uid][("onboarding_task_list", "onboarding_task_list_show")] == "false"
    pr_server.seed(url, "poster", "pw")  # a reused server: users and team exist already, seeding still succeeds


def test_seeding_refuses_a_user_that_is_not_an_admin(fake):
    _, url = fake
    pr_server.seed(url, "someone", "pw")  # first user: admin
    with pytest.raises(pr_server.InfraError, match="not a system admin"):
        pr_server.seed(url, "poster", "pw")


def test_the_running_build_is_read_from_the_server_and_none_when_nothing_answers(fake):
    _, url = fake
    assert pr_server.running_build(url) == "5e62cb15e5"
    assert pr_server.running_build("http://127.0.0.1:9") is None


def test_up_checks_credentials_and_the_e2e_dir_before_touching_any_server(tmp_path, monkeypatch):
    monkeypatch.setattr(pr_server, "make", lambda *a: pytest.fail("started a stack"))
    image = "mattermostdevelopment/mattermost-enterprise-edition:5e62cb1"
    monkeypatch.delenv("VERIFY_USER", raising=False)
    with pytest.raises(pr_server.InfraError, match="VERIFY_USER"):
        pr_server.up(image, tmp_path)
    monkeypatch.setenv("VERIFY_USER", "poster")
    monkeypatch.setenv("VERIFY_PASSWORD", "pw")
    with pytest.raises(pr_server.InfraError, match="not the mattermost repo's e2e-tests dir"):
        pr_server.up(image, tmp_path)


def test_up_replaces_a_server_running_another_build_and_never_seeds_the_wrong_one(tmp_path, monkeypatch, fake):
    srv, url = fake
    (tmp_path / ".ci").mkdir()
    (tmp_path / ".ci" / "server.generate.sh").write_text("")
    monkeypatch.setenv("VERIFY_USER", "poster")
    monkeypatch.setenv("VERIFY_PASSWORD", "pw")
    monkeypatch.setattr(pr_server, "SERVER_URL", url)
    calls = []

    def make(e2e, target, image):
        calls.append(target)
        if target == "start-server":
            srv.state["build"] = image.rsplit(":", 1)[-1] + "aaa"

    monkeypatch.setattr(pr_server, "make", make)
    pr_server.up("mattermostdevelopment/mattermost-enterprise-edition:3f535d1", tmp_path)
    assert calls == ["stop-server", "start-server"] and "poster" in srv.state["users"]
    calls.clear()
    pr_server.up("mattermostdevelopment/mattermost-enterprise-edition:3f535d1", tmp_path)
    assert calls == []  # already on that build: no restart

    monkeypatch.setattr(pr_server, "make", lambda *a: None)  # a start that leaves the old build running
    monkeypatch.setattr(pr_server, "seed", lambda *a: pytest.fail("seed() must not be called on build mismatch"))
    with pytest.raises(pr_server.InfraError, match="expected"):
        pr_server.up("mattermostdevelopment/mattermost-enterprise-edition:5e62cb1", tmp_path)


def test_e2e_option_is_taken_out_of_the_arguments(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(pr_server, "up", lambda image, e2e: seen.update(image=image, e2e=e2e))
    pr_server.main(["up", "--e2e", str(tmp_path), "img:abcdef1"])
    assert seen == {"image": "img:abcdef1", "e2e": tmp_path}
    with pytest.raises(SystemExit):
        pr_server.main(["up"])


def test_seeding_reports_why_a_user_could_not_be_made_instead_of_blaming_a_reused_server(fake):
    _, url = fake
    with pytest.raises(pr_server.InfraError, match=r"HTTP 400 model\.user\.is_valid\.pwd\.app_error"):
        pr_server.seed(url, "poster", "x")  # rejected by the password policy, not because the user exists


def test_seeding_refuses_a_login_without_a_session_token(fake):
    srv, url = fake
    srv.state["no_token"] = True
    with pytest.raises(pr_server.InfraError, match="no session token"):
        pr_server.seed(url, "poster", "pw")


def test_a_missing_tool_is_an_infra_error_not_a_traceback(monkeypatch, capsys):
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(SystemExit) as e:
        pr_server.run_cli(["images", "40094"])
    assert e.value.code == 2 and capsys.readouterr().out.startswith("INFRA_ERROR")


def test_up_leaves_e2e_dir_clean_and_down_validates_e2e(tmp_path, monkeypatch, fake):
    _, url = fake
    e2e = tmp_path / "e2e-tests"
    (e2e / ".ci").mkdir(parents=True)
    (e2e / ".ci" / "server.generate.sh").write_text("")
    monkeypatch.setenv("VERIFY_USER", "poster")
    monkeypatch.setenv("VERIFY_PASSWORD", "pw")
    monkeypatch.setattr(pr_server, "SERVER_URL", url)
    calls = []
    monkeypatch.setattr(pr_server, "make", lambda d, t, img: calls.append((d, t)))
    pr_server.up("mattermostdevelopment/mattermost-enterprise-edition:5e62cb1", e2e)
    assert not (e2e / ".pr_server.lock").exists()  # lock lives in tempdir, never in the repo
    pr_server.down(e2e)
    assert calls == [(e2e, "stop-server")]
    with pytest.raises(pr_server.InfraError, match="not the mattermost repo's e2e-tests dir"):
        pr_server.down(tmp_path / "empty")
    monkeypatch.delenv("MM_E2E_DIR", raising=False)
    assert pr_server.default_e2e(tmp_path) == e2e
    with pytest.raises(SystemExit):
        pr_server.main(["down", "--e2e"])


def test_pr_images_supports_release_ranges(monkeypatch):
    calls = []

    def fake_gh(path: str):
        calls.append(path)
        if "/compare/" in path:
            return {"merge_base_commit": {"sha": "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
        if "/commits/" in path:
            return {"sha": "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        raise AssertionError(path)

    monkeypatch.setattr(pr_server, "gh_json", fake_gh)
    imgs = pr_server.pr_images("release-12.0.0-rc1...release-12.1.0-rc3")
    assert imgs == {"head": f"{pr_server.IMAGE_REPO}:2222222", "base": f"{pr_server.IMAGE_REPO}:1111111"}
    assert any("release-12.0.0-rc1...release-12.1.0-rc3" in c for c in calls)


def test_seed_raises_infra_error_on_team_lookup_failure():
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/api/v4/users":
                self.send_response(201)
                self.end_headers()
                self.wfile.write(json.dumps({"id": "u1"}).encode())
            elif self.path == "/api/v4/users/login":
                self.send_response(200)
                self.send_header("Token", "tok")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "u1", "roles": "system_admin"}).encode())
            elif self.path == "/api/v4/teams":
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"{}")

        def do_GET(self):
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"{}")

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with pytest.raises(pr_server.InfraError, match="looking up team verify: HTTP 500"):
            pr_server.seed(f"http://127.0.0.1:{srv.server_address[1]}", "poster", "pw")
    finally:
        srv.shutdown()


def test_images_pull_failure_raises_infra_error(monkeypatch):
    monkeypatch.setattr(pr_server, "pr_images", lambda _pr: {"head": "r:aaa", "base": "r:bbb"})
    monkeypatch.setattr(pr_server, "published", lambda img: True)  # base is published: no ancestor walk
    monkeypatch.setattr(pr_server, "pull", lambda img: "manifest unknown" if img == "r:aaa" else None)
    with pytest.raises(pr_server.InfraError, match="image pull failed"):
        pr_server.main(["images", "40100", "--pull"])
    with pytest.raises(SystemExit) as exc:
        pr_server.run_cli(["images", "40100", "--pull"])
    assert exc.value.code == 2
