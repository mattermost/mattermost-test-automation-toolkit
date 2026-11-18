# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-test for the /hunt and /verify skills.

/hunt: worktrees + merge-base, context builder, runner, vetting, mutation gate, large-diff prefilter, lessons, trusted
base-branch rules and RELIABILITY.md triggers. Fixtures are tiny git repos built from tests/hunt_fixtures/<name>/.
/verify: verify_ui.mjs against a local fixture server (pass, pageerror, HTTP 500, step cap, no screenshots)."""
from __future__ import annotations

import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / ".claude" / "skills" / "hunt"
SCRIPTS = SKILL / "scripts"
VERIFY_UI = ROOT / ".claude" / "skills" / "verify" / "scripts" / "verify_ui.mjs"
VERIFY_DEPS = Path(__file__).resolve().parent / "verify_fixtures" / "node_modules"
FIX = Path(__file__).resolve().parent / "hunt_fixtures"
JESTDEPS = FIX / "jestdeps" / "node_modules"
sys.path.insert(0, str(SCRIPTS))

import build_requests  # noqa: E402
import ctx  # noqa: E402
import hunt_common  # noqa: E402
import lessons  # noqa: E402
import prefilter  # noqa: E402
import prepare  # noqa: E402
import reliability  # noqa: E402
import run  # noqa: E402
import trusted  # noqa: E402

GIT_ENV = {**hunt_common.git_env(), "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=GIT_ENV).stdout.strip()


def _overlay(src: Path, dst: Path) -> None:
    for p in src.rglob("*"):
        if p.is_file():
            out = dst / p.relative_to(src)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, out)


def make_hunt(tmp: Path, name: str) -> tuple[Path, dict]:
    """Repo with master=base and feature=base+head, worktrees via prepare.worktrees, context via ctx.build."""
    repo = tmp / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    _overlay(FIX / name / "base", repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    _overlay(FIX / name / "head", repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    wt, wt_base = tmp / "wt", tmp / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    for w in (wt, wt_base):
        if (w / "web").is_dir():
            (w / "web" / "node_modules").symlink_to(JESTDEPS)
    hdir = tmp / "hunt"
    shutil.copytree(FIX / name / "responses", hdir)
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    state = ctx.build("1", 1, prep, {"title": f"fixture {name}", "body": "Clamp keeps values in range."})
    return hdir, state


# ------------------------------------------------------------------ worktrees + context

def test_worktrees_pin_head_and_merge_base(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    assert state["merge_base"] == _git(Path(state["repo"]), "rev-parse", "master")
    assert "v >= hi" in (Path(state["wt"]) / "calc/calc.go").read_text()
    assert "v > hi" in (Path(state["wt_base"]) / "calc/calc.go").read_text()
    assert state["changed"] == ["calc/calc.go"]  # go.mod and the existing test are filtered out
    assert state["own_tests"]["go"] == ["TestClampMiddle"]
    c = json.loads((hdir / "ctx.json").read_text())
    assert c["your_test_files"] == [{"lang": "go", "dir": "calc", "path": "calc/hunt_hunt<mode>_test.go", "package": "calc"}]
    assert "-\tif v > hi {" in c["diff_production_code"]
    assert any(s["file"] == "calc/calc_test.go" for s in c["sibling_tests_and_helpers"])
    assert "EXCLUDED\tcalc/calc_test.go\texisting test" in (hdir / "skipped.log").read_text()


# ------------------------------------------------------------------ fixture 1: known Go bug

def test_go_bug_fails_3_of_3_and_is_new_in_pr(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    assert run.cmd_run(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "NEW_PR_BUG"}
    assert not list(Path(state["wt"]).rglob("hunt_*")) and not list(Path(state["wt_base"]).rglob("hunt_*"))


# ------------------------------------------------------------------ fixture 2: known React bug

@pytest.mark.skipif(not os.environ.get("HUNT_REQUIRE_DEPS") and not JESTDEPS.is_dir(), reason="run `make jest-deps` first")
def test_react_bug_fails_3_of_3_and_is_new_in_pr(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_bug")
    assert state["targets"] == [{"lang": "jest", "dir": "web/src", "path": "web/src/hunt_<mode>.test.tsx"}]
    assert run.cmd_run(hdir, state, "A", runs=3) == {"web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "NEW_PR_BUG"}


@pytest.mark.skipif(not os.environ.get("HUNT_REQUIRE_DEPS") and not JESTDEPS.is_dir(), reason="run `make jest-deps` first")
def test_babel_compile_check(tmp_path):
    _, state = make_hunt(tmp_path, "react_bug")
    wt = Path(state["wt"])
    assert run.jest_compiles(wt, "web/src/counter.tsx") is None
    (wt / "web/src/counter.tsx").write_text("export const x = (;\n")
    assert run.jest_compiles(wt, "web/src/counter.tsx")


# ------------------------------------------------------------------ fixture 3: clean control + mutation gate

def test_clean_control_has_no_findings_and_mutants_are_scored(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    assert set(run.cmd_run(hdir, state, "A").values()) == {"PASS"}
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M1"]["verdict"] == "KILLED" and v["M1"]["killers"] == ["calc::TestHuntA_PercentZeroTotal"]
    assert v["M2"]["verdict"] == "NEEDS_REGENERATION" and "totl" in v["M2"]["detail"]
    assert v["M3"]["verdict"] == "SURVIVED"
    assert v["M4"]["verdict"] == "KILLED" and v["M4"]["held_back"]
    assert v["M5"]["verdict"] == "INVALID"
    assert "return part * 100 / total" in (Path(state["wt"]) / "calc/percent.go").read_text()  # restored


def test_regenerated_mutant_replaces_broken_one(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "R_M2").mkdir()
    (hdir / "R_M2" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M2", "file": "calc/percent.go", "old": "return part * 100 / total", "new": "return part * 10 / total",
         "what_breaks": "off by a factor of ten"}]}))
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M2"]["verdict"] == "KILLED"


def test_zero_tests_is_infra_error_and_bad_test_is_compile_error(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    no_tests = "package calc\n\nimport \"testing\"\n\nfunc TestSomethingElse(t *testing.T) {}\n"
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go", "content": no_tests}]}))
    with pytest.raises(run.InfraError, match="0 tests executed"):
        run.cmd_run(hdir, state, "B", runs=1)
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go",
                                                                      "content": "package calc\nfunc TestHuntB_X(t *T) {}\n"}]}))
    with pytest.raises(run.CompileError):
        run.cmd_run(hdir, state, "B", runs=1)


def test_place_refuses_paths_outside_hunt_files(tmp_path):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    for bad in ("calc/calc.go", "../escape/hunt_hunta_test.go", "other/hunt_hunta_test.go", "/etc/hunt_hunta_test.go"):
        with pytest.raises(ValueError):
            run.place(wt, [{"path": bad, "content": "x"}], {"calc"})


def test_pr_own_tests_score_mutants(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    (hdir / "M").mkdir()
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M1", "file": "calc/calc.go", "old": "return v\n", "new": "return v + 1\n", "what_breaks": "shifts values"}]}))
    v = run.cmd_mutants(hdir, state, "PR")
    assert v[0]["verdict"] == "KILLED" and v[0]["killers"] == ["calc::TestClampMiddle"]


# ------------------------------------------------------------------ large-diff guard

def synthetic_diff() -> list[prefilter.FileDiff]:
    files = [prefilter.FileDiff(f"server/channels/app/file{i}.go", i % 90 + 1, i % 7, "+x := 1\n") for i in range(1000)]
    files += [prefilter.FileDiff("webapp/package-lock.json", 40000, 300),
              prefilter.FileDiff("webapp/channels/src/i18n/en.json", 900, 2),
              prefilter.FileDiff("server/i18n/de.json", 500, 1),
              prefilter.FileDiff("server/channels/store/mocks/ChannelStore.go", 3000, 10),
              prefilter.FileDiff("server/channels/app/user_test.go", 100, 0),
              prefilter.FileDiff("webapp/channels/src/x/__snapshots__/a.test.tsx.snap", 200, 0),
              prefilter.FileDiff("server/channels/api4/user.go", 30, 4, "+\tif !c.App.SessionHasPermissionTo(*c.AppContext.Session(), model.PermissionManageSystem) {\n"),
              prefilter.FileDiff("server/channels/app/huge.go", 5000, 0, "+y\n")]
    files += [prefilter.FileDiff(f"server/public/model/gen{i}.pb.go", 50, 0) for i in range(200)]
    return files


def test_prefilter_caps_batches_and_logs_every_file():
    files = synthetic_diff()
    p = prefilter.plan(files)
    for b in p.batches:
        assert len(b) <= prefilter.MAX_FILES
        assert len(b) == 1 or sum(f.lines for f in b) <= prefilter.MAX_LINES
    assert p.batches[0][0].path == "server/channels/api4/user.go"  # permission check ranks first
    reasons = dict(p.skipped)
    assert reasons["webapp/package-lock.json"] == "lockfile"
    assert reasons["server/i18n/de.json"] == reasons["webapp/channels/src/i18n/en.json"] == "translations"
    assert reasons["server/channels/store/mocks/ChannelStore.go"] == "generated mock"
    assert reasons["server/channels/app/user_test.go"] == "existing test"
    assert all(reasons[f"server/public/model/gen{i}.pb.go"] == "generated" for i in range(200))
    log = prefilter.describe(p, 1)
    assert len(log) == 1 + len(files)  # header + one line per input file
    assert sum(1 for line in log if line.startswith("HUNT")) == len(p.batches[0])
    assert any("huge.go" in line and "oversize" in line for line in log)


# ------------------------------------------------------------------ lessons

def test_lessons_append_only_and_matching(tmp_path):
    path = tmp_path / "lessons.jsonl"
    base = {"applies_to": {"lang": ["go"], "path_globs": ["server/channels/app/platform/*"]}, "keywords": ["clientconfig"],
            "symptom": "s", "check": "c", "source_pr": 1}
    first = lessons.add({**base, "pattern": "p1"}, path)
    lessons.add({**base, "pattern": "p2", "applies_to": {"lang": ["jest"], "path_globs": ["webapp/*"]}}, path)
    before = path.read_text()
    with pytest.raises(ValueError):
        lessons.add({**base, "pattern": "p1"}, path)
    with pytest.raises(ValueError):
        lessons.add({"pattern": "p3"}, path)
    assert path.read_text() == before and first["id"] == "L001"
    c = {"changed_files_head_source": [{"file": "server/channels/app/platform/config.go"}], "diff_production_code": "ClientConfig"}
    assert [m["pattern"] for m in lessons.match(c, lessons.load(path))] == ["p1"]


def test_real_lessons_are_injected_into_hunter_prompts_only(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)  # this checkout is the PR that edits the rules
    c = {"pr": {"title": "t"}, "diff_production_code": "+ ps.regenerateClientConfig()",
         "changed_files_head_source": [{"file": "server/channels/app/platform/config.go", "source": ""}],
         "sibling_tests_and_helpers": [], "callers": [], "your_test_files": []}
    state = {"targets": [{"lang": "go", "dir": "server/channels/app/platform"}]}
    system = build_requests.hunter_system("A", state, c)
    assert "Setup(t) stale client config" in system and "JSDOM" not in system
    assert "{lang_rules}" not in system and "{lessons}" not in system
    m = build_requests.mutant_user(c)
    assert set(m) == {"pr_title", "diff_production_code", "changed_files_head_source"}  # planters never see tests
    assert "Setup(t)" not in build_requests.mutant_system(state, 3, "M1, M2, M3")


# ------------------------------------------------------------------ trusted base-branch rules

def _skill_repo(tmp: Path) -> tuple[Path, Path]:
    """A repo whose origin/main holds the real skill, checked out on a PR branch that weakens the rules."""
    repo = tmp / "toolkit"
    skill = repo / "pkg" / ".claude" / "skills" / "hunt"
    shutil.copytree(SKILL, skill, ignore=shutil.ignore_patterns("__pycache__"))
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "rules on main")
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(repo, "checkout", "-qb", "weaken-rules")
    (skill / "lessons.jsonl").write_text("")
    (skill / "RELIABILITY.md").write_text("# nothing to check\n")
    _git(repo, "commit", "-qam", "PR weakens its own checks")
    return repo, skill


def test_rules_come_from_base_branch_not_pr_head(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    _, skill = _skill_repo(tmp_path)
    assert (skill / "lessons.jsonl").read_text() == ""  # what the PR head has on disk
    base_lessons = trusted.read("lessons.jsonl", skill)
    assert "Setup(t) stale client config" in base_lessons
    assert len(reliability.parse(trusted.read("RELIABILITY.md", skill))) == 10
    with pytest.raises(trusted.InfraError, match="lessons.jsonl"):
        trusted.check(skill)
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    assert trusted.read("lessons.jsonl", skill) == ""  # explicit rule-editing mode reads the disk
    assert "rule-editing" in trusted.check(skill)


def test_trusted_rules_fail_closed_and_local_installs_read_disk(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    (skill / "NEW_RULES.md").write_text("added by the PR")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "PR adds a rules file")
    with pytest.raises(trusted.InfraError, match="not on the trusted ref"):
        trusted.read("NEW_RULES.md", skill)
    (skill / "LOCAL.md").write_text("untracked local file")
    assert trusted.read("LOCAL.md", skill) == "untracked local file"
    _git(repo, "update-ref", "-d", "refs/remotes/origin/main")
    with pytest.raises(trusted.InfraError, match="no base branch"):
        trusted.read("lessons.jsonl", skill)
    _git(repo, "checkout", "-q", "main")
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    with pytest.raises(trusted.InfraError, match="LOCAL.md"):
        trusted.check(skill)  # an untracked file in a tracked skill counts as a change too
    (skill / "LOCAL.md").unlink()
    assert "trusted ref" in trusted.check(skill)  # unchanged skill on main passes


# ------------------------------------------------------------------ RELIABILITY.md triggers

def _ctx(files: list[str], diff: str) -> dict:
    return {"pr": {"title": "t"}, "diff_production_code": diff, "callers": [], "your_test_files": [],
            "sibling_tests_and_helpers": [], "changed_files_head_source": [{"file": f, "source": ""} for f in files]}


def test_reliability_rules_parse_and_trigger_only_on_matching_diffs(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    rules = reliability.load()
    assert [r.id for r in rules] == [f"R{i:02d}" for i in range(1, 11)]
    ids = lambda c: [r.id for r in reliability.match(c, rules)]  # noqa: E731
    assert ids(_ctx(["server/channels/app/platform/config.go"], "+\tps.regenerateClientConfig()")) == ["R03"]
    assert ids(_ctx(["webapp/channels/src/selectors/views/foo.ts"], "+export const getX = createSelector(")) == ["R10"]
    assert "R08" in ids(_ctx(["server/public/model/x.go"], "+\tgo func() {"))
    assert ids(_ctx(["server/public/model/x.go"], "+\tx := 1")) == []  # R08 is diff-triggered only
    assert ids(_ctx(["server/channels/db/migrations/postgres/000150_x.up.sql"], "+ALTER TABLE Posts")) == ["R07"]
    assert ids(_ctx(["README.md"], "-\tgo func() {")) == ["R08"]  # removed lines count too


def test_reliability_rules_go_to_mode_a_only(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    c = _ctx(["server/channels/app/platform/config.go"], "+\tps.regenerateClientConfig()")
    state = {"targets": [{"lang": "go", "dir": "server/channels/app/platform"}]}
    assert "R03 ClientConfig hash compatibility" in build_requests.hunter_system("A", state, c)
    assert "R03" not in build_requests.hunter_system("B", state, c)
    assert "R03" not in build_requests.mutant_system(state, 3, "M1, M2, M3")
    with pytest.raises(ValueError, match="missing"):
        reliability.parse("## R01 Broken\npaths: x\n")


# ------------------------------------------------------------------ /verify: verify_ui.mjs

PAGES = {
    "/ok": """<html><body><main><h1>Fixture</h1><button onclick="save()">Save</button><ul id="l"></ul></main><script>
async function save() {
  // like the Mattermost webapp: echo the MMCSRF cookie in X-CSRF-Token on writes
  const csrf = (document.cookie.match(/(?:^|; )MMCSRF=([^;]*)/) || [])[1] || '';
  const r = await fetch('/api/v4/things', {method: 'POST', headers: {'X-CSRF-Token': csrf}});
  const li = document.createElement('li'); li.textContent = r.ok ? 'saved' : 'error';
  document.getElementById('l').appendChild(li); }</script></body></html>""",
    "/boom": """<html><body><main><button onclick="throw new Error('kaboom')">Boom</button></main></body></html>""",
    "/fail500": """<html><body><main><button onclick="fetch('/api/v4/broken')">Break</button></main></body></html>""",
    "/slow": """<html><body><main><button onclick="fetch('/api/v4/slow')">Slow</button></main></body></html>""",
    "/external": """<html><body><main><p>ok</p><script src="http://blocked.invalid/x.js"></script></main></body></html>""",
    # the browser's own credentials (cookies or the Bearer header), as the Mattermost webapp would send them
    "/whoami": """<html><body><main><p id="who">loading</p></main><script>
fetch('/api/v4/users/me', {credentials: 'include'}).then(async (r) => {
  document.getElementById('who').textContent = r.ok ? 'signed in as ' + (await r.json()).username : 'HTTP ' + r.status;
});</script></body></html>""",
    # Mattermost-style React portals: the menu and the dialog are appended to <body>, outside #app-content
    "/portal": """<html><body><div id="app-content"><main><button onclick="openMenu()">Channel menu</button></main></div>
<script>
function openMenu() {
  const m = document.createElement('div'); m.setAttribute('role', 'menu'); m.setAttribute('aria-label', 'Channel menu');
  const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); item.textContent = 'Leave channel';
  item.onclick = () => { m.remove(); const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Leave channel'); d.innerHTML = '<button>Yes, leave</button>'; document.body.appendChild(d); };
  m.appendChild(item); document.body.appendChild(m);
}</script></body></html>""",
}

TOKEN, USER_ID = "tok-123", "uid1"
SEEN: list[tuple[str, str, str | None]] = []  # (Host, path, Authorization) of every request the fixture server saw


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep test output clean
        pass

    def _send(self, code: int, body: str, ctype: str = "application/json", headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())

    def _auth(self) -> str | None:
        """Mattermost's order: the MMAUTHTOKEN cookie wins over the Authorization header. Cookie sessions need a
        matching X-CSRF-Token on writes ("Appears to be a CSRF attempt")."""
        cookies = dict(c.strip().split("=", 1) for c in (self.headers.get("Cookie") or "").split(";") if "=" in c)
        if "MMAUTHTOKEN" in cookies:
            if self.command != "GET" and self.headers.get("X-CSRF-Token") != cookies.get("MMCSRF"):
                return None
            return cookies["MMAUTHTOKEN"] if cookies["MMAUTHTOKEN"] == TOKEN else None
        return TOKEN if self.headers.get("Authorization") == f"Bearer {TOKEN}" else None

    def do_GET(self):
        SEEN.append((self.headers.get("Host", ""), self.path, self.headers.get("Authorization")))
        if self.path == "/xorigin":
            port = self.server.server_address[1]
            self._send(200, f'<html><body><main><p>x</p><script src="http://localhost:{port}/asset.js"></script></main></body></html>',
                       "text/html")
        elif self.path == "/asset.js":
            self._send(200, "document.title = 'asset loaded';", "application/javascript")
        elif self.path in PAGES:
            self._send(200, PAGES[self.path], "text/html")
        elif self.path == "/api/v4/users/me":
            authed = self._auth() is not None
            self._send(200 if authed else 401,
                       json.dumps({"id": USER_ID, "username": "tester"} if authed else {"id": "unauthorized"}))
        elif self.path == "/api/v4/broken":
            self._send(500, '{"id": "boom"}')
        elif self.path == "/api/v4/slow":
            import time
            time.sleep(2)
            self._send(200, "{}")
        else:
            self._send(404, "{}")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/v4/users/login":
            ok = json.loads(body or b"{}") == {"login_id": "tester", "password": "pw"}
            if not ok:
                self._send(401, "{}")
                return
            # what Mattermost sets on login: the session token, the user id and the CSRF token
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Token", TOKEN)
            for c in (f"MMAUTHTOKEN={TOKEN}; Path=/; HttpOnly", f"MMUSERID={USER_ID}; Path=/", "MMCSRF=csrf1; Path=/"):
                self.send_header("Set-Cookie", c)
            self.end_headers()
            self.wfile.write(json.dumps({"id": USER_ID, "username": "tester"}).encode())
        elif self.path == "/api/v4/things":
            SEEN.append((self.headers.get("Host", ""), self.path, self.headers.get("Authorization")))
            self._send(201 if self._auth() else 401, "{}")
        else:
            self._send(404, "{}")


@pytest.fixture
def ui_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _node_env(auth: str = "password") -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("VERIFY_")}
    if auth == "password":
        env.update(VERIFY_USER="tester", VERIFY_PASSWORD="pw")
    elif auth == "token":
        env["VERIFY_TOKEN"] = TOKEN
    paths = [str(VERIFY_DEPS)] + [p for p in env.get("NODE_PATH", "").split(os.pathsep) if p]
    env["NODE_PATH"] = os.pathsep.join(paths)
    if os.environ.get("HUNT_NODE_BIN"):
        env["PATH"] = f"{os.environ['HUNT_NODE_BIN']}{os.pathsep}{env['PATH']}"
    return env


def _playwright_available() -> bool:
    try:
        p = subprocess.run(["node", "-e", "require('playwright')"], env=_node_env(), capture_output=True, check=False)
    except FileNotFoundError:  # no node at all: optional /verify tests skip (HUNT_REQUIRE_DEPS makes them fail)
        return False
    return p.returncode == 0


# CI sets HUNT_REQUIRE_DEPS=1 so missing dependencies fail loudly instead of skipping.
REQUIRE_DEPS = bool(os.environ.get("HUNT_REQUIRE_DEPS"))
needs_playwright = pytest.mark.skipif(not REQUIRE_DEPS and not _playwright_available(), reason="run `make verify-deps` first")


def verify(tmp: Path, plan: dict, *extra: str, auth: str = "password", env: dict | None = None) -> tuple[int, str]:
    (tmp / "plan.json").write_text(json.dumps(plan))
    p = subprocess.run(["node", str(VERIFY_UI), "plan.json", *extra], cwd=tmp, env={**_node_env(auth), **(env or {})},
                       capture_output=True,
                       text=True, timeout=120, check=False)
    assert not list(tmp.rglob("*.png")), "verify_ui must never write screenshots"
    return p.returncode, p.stdout + p.stderr


@needs_playwright
def test_verify_passes_with_dom_and_api_checks(tmp_path, ui_server):
    code, out = verify(tmp_path, {
        "base_url": ui_server, "login": True, "scope": {"role": "main"},
        "steps": [{"goto": "/ok"}, {"click": {"role": "button", "name": "Save"}}, {"snapshot": {"role": "main"}}],
        "expect": [{"visible": {"role": "listitem"}},
                   {"text": {"role": "list"}, "contains": "saved"},
                   {"count": {"role": "button"}, "min": 1},
                   {"api": {"path": "/api/v4/users/me", "status": 200, "json_has": {"username": "tester"}}}]})
    assert code == 0, out
    assert "password login as tester (MMAUTHTOKEN, MMUSERID, MMCSRF set)" in out
    assert '- button "Save"' in out and "VERDICT: PASS" in out


@needs_playwright
def test_verify_fails_on_pageerror_and_on_api_500(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [
        {"goto": "/boom"}, {"click": {"role": "button", "name": "Boom"}}], "expect": [{"visible": {"role": "main"}}]})
    assert code == 1 and "pageerror: kaboom" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [
        {"goto": "/fail500"}, {"click": {"role": "button", "name": "Break"}}], "expect": [{"visible": {"role": "main"}}]})
    assert code == 1 and "HTTP 500 from GET /api/v4/broken" in out, out


@needs_playwright
def test_verify_fails_on_wrong_expectation_with_scoped_snapshot(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "scope": {"role": "main"}, "steps": [{"goto": "/ok"}],
                                  "expect": [{"visible": {"text": "saved"}}]})
    assert code == 1 and "VERDICT: FAIL expect 1" in out and '- button "Save"' in out, out


@needs_playwright
def test_verify_rejects_bad_plans(tmp_path, ui_server):
    eleven = [{"goto": "/ok"}] * 11
    for plan, msg in [({"steps": eleven, "expect": [{"visible": {"role": "main"}}]}, "MAX_STEPS is 10"),
                      ({"steps": [{"screenshot": "x.png"}], "expect": [{"visible": {"role": "main"}}]}, "unknown action"),
                      ({"steps": [{"goto": "/ok"}]}, "at least one deterministic"),
                      ({"steps": [], "expect": [{"api": {"path": "/etc/passwd"}}]}, "must start with /api/v4/")]:
        code, out = verify(tmp_path, {"base_url": ui_server, **plan})
        assert code == 2 and "INVALID_PLAN" in out and msg in out, (msg, out)
    code, out = verify(tmp_path, {"base_url": "http://127.0.0.1:9", "steps": [{"goto": "/"}],
                                  "expect": [{"visible": {"role": "main"}}]})
    assert code == 2 and "INFRA_ERROR server unreachable" in out, out


@needs_playwright
def test_verify_stays_on_the_server_under_test(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/external"}],
                                  "expect": [{"text": {"role": "main"}, "contains": "ok"}]})
    assert code == 0 and "blocked other origins: http://blocked.invalid" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "https://example.com/"}],
                                  "expect": [{"visible": {"role": "main"}}]})
    assert code == 2 and "leaves" in out, out


@needs_playwright
def test_verify_freezes_a_passing_plan_into_a_model_free_playwright_test(tmp_path, ui_server):
    plan = {"name": "save shows saved", "base_url": ui_server, "login": True,
            "steps": [{"goto": "/ok"}, {"click": {"role": "button", "name": "Save"}}, {"snapshot": {"role": "main"}}],
            "expect": [{"visible": {"text": "saved"}}, {"count": {"role": "listitem"}, "min": 1},
                       {"api": {"path": "/api/v4/users/me", "json_has": {"username": "tester"}}}]}
    code, out = verify(tmp_path, plan, "--freeze", "frozen.spec.ts")
    assert code == 0 and "frozen to frozen.spec.ts" in out, out
    spec = (tmp_path / "frozen.spec.ts").read_text()
    assert "Copyright (c) 2015-present Mattermost" in spec and "ariaSnapshot" not in spec and "screenshot" not in spec
    (tmp_path / "node_modules").symlink_to(VERIFY_DEPS)
    cli = VERIFY_DEPS / "@playwright" / "test" / "cli.js"
    env = {**_node_env(), "MM_URL": ui_server}
    run_spec = lambda: subprocess.run(["node", str(cli), "test", "frozen.spec.ts", "--reporter=line"],  # noqa: E731
                                      cwd=tmp_path, env=env, capture_output=True, text=True, timeout=180, check=False)
    p = run_spec()
    assert p.returncode == 0 and "1 passed" in p.stdout, p.stdout + p.stderr
    # the frozen test keeps the oracle: the same flow against a broken page fails without any model involved
    (tmp_path / "frozen.spec.ts").write_text(spec.replace('"/ok"', '"/boom"').replace('"Save"', '"Boom"'))
    p = run_spec()
    assert p.returncode != 0 and "kaboom" in p.stdout + p.stderr, p.stdout + p.stderr


# ------------------------------------------------------------------ installer

def test_install_skill_links_both_skills_and_refuses_to_clobber(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    _git(target, "init", "-q")
    script = ROOT / "scripts" / "install-skill.sh"
    p = subprocess.run(["bash", str(script), str(target)], capture_output=True, text=True, check=False)
    assert p.returncode == 0, p.stdout + p.stderr
    for name in ("hunt", "verify"):
        link = target / ".claude" / "skills" / name
        assert link.is_symlink() and (link / "SKILL.md").exists()
    exclude = (target / ".git" / "info" / "exclude").read_text()
    assert "/.claude/skills/hunt" in exclude and "/.claude/skills/verify" in exclude
    assert _git(target, "status", "--porcelain") == ""  # symlinks are local-only
    p = subprocess.run(["bash", str(script), "--copy", "--skill", "verify", str(target)], capture_output=True, text=True,
                       check=False)
    assert p.returncode == 1 and "--force" in p.stderr
    p = subprocess.run(["bash", str(script), "--copy", "--force", "--skill", "verify", str(target)], capture_output=True,
                       text=True, check=False)
    copied = target / ".claude" / "skills" / "verify"
    assert p.returncode == 0 and not copied.is_symlink() and (copied / "scripts" / "verify_ui.mjs").exists()


@needs_playwright
def test_verify_api_login_reaches_the_app_with_password_or_token(tmp_path, ui_server):
    plan = {"base_url": ui_server, "steps": [{"goto": "/whoami"}],
            "expect": [{"text": {"css": "#who"}, "contains": "signed in as tester"}]}
    for auth, line in (("password", "password login as tester"), ("token", "token auth as tester")):
        code, out = verify(tmp_path, plan, auth=auth)
        assert code == 0 and line in out, (auth, out)
    code, out = verify(tmp_path, {**plan, "login": True}, auth="none")
    assert code == 2 and "INFRA_ERROR login required" in out, out
    code, out = verify(tmp_path, plan, auth="none")
    assert code == 1 and "HTTP 401" in out, out  # without credentials the page really is signed out


@needs_playwright
def test_frozen_spec_reuses_the_api_login_with_only_a_token(tmp_path, ui_server):
    plan = {"name": "whoami", "base_url": ui_server, "login": True, "steps": [{"goto": "/whoami"}],
            "expect": [{"text": {"css": "#who"}, "contains": "signed in as tester"}]}
    code, out = verify(tmp_path, plan, "--freeze", "frozen.spec.ts", auth="password")
    assert code == 0, out
    spec = (tmp_path / "frozen.spec.ts").read_text()
    assert "async function apiLogin(context, base, env)" in spec and "await apiLogin(page.context(), BASE, process.env)" in spec
    assert "getByLabel" not in spec and "fill(" not in spec  # no login form steps
    (tmp_path / "node_modules").symlink_to(VERIFY_DEPS)
    cli = VERIFY_DEPS / "@playwright" / "test" / "cli.js"
    for auth, ok in (("token", True), ("none", False)):
        env = {**_node_env(auth), "VERIFY_BASE_URL": ui_server}
        p = subprocess.run(["node", str(cli), "test", "frozen.spec.ts", "--reporter=line"], cwd=tmp_path, env=env,
                           capture_output=True, text=True, timeout=180, check=False)
        assert (p.returncode == 0) == ok, (auth, p.stdout + p.stderr)
    assert "set VERIFY_TOKEN or VERIFY_USER + VERIFY_PASSWORD" in p.stdout + p.stderr


@needs_playwright
def test_verify_snapshots_show_portals_outside_app_content(tmp_path, ui_server):
    code, out = verify(tmp_path, {
        "base_url": ui_server, "scope": {"css": "#app-content"},
        "steps": [{"goto": "/portal"}, {"click": {"role": "button", "name": "Channel menu"}}, {"snapshot": None},
                  {"click": {"role": "menuitem", "name": "Leave channel"}}, {"snapshot": {"css": "#app-content"}}],
        "expect": [{"visible": {"role": "dialog", "name": "Leave channel"}}]})
    assert code == 0, out
    first, second = out.split("step 5/5")
    assert 'portal [role=menu]:' in first and '- menuitem "Leave channel"' in first
    assert 'portal [role=dialog]:' in second and '- button "Yes, leave"' in second
    assert "portal [role=menu]" not in second  # closed portals are not reported


# ------------------------------------------------------------------ Bugbot regressions

def test_context_skips_deleted_and_renamed_files(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    _overlay(FIX / "clean" / "base", repo)
    (repo / "calc" / "old.go").write_text("package calc\n\nfunc Old() int { return 1 }\n")
    (repo / "calc" / "moved.go").write_text("package calc\n\nfunc Moved() int { return 2 }\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "feature")
    _git(repo, "rm", "-q", "calc/old.go")
    _git(repo, "mv", "calc/moved.go", "calc/renamed.go")
    _overlay(FIX / "clean" / "head", repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    wt, wt_base = tmp_path / "wt", tmp_path / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    hdir = tmp_path / "hunt"
    hdir.mkdir()
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    state = ctx.build("1", 1, prep, {"title": "t", "body": ""})
    assert sorted(state["changed"]) == ["calc/percent.go", "calc/renamed.go"]
    log = (hdir / "skipped.log").read_text()
    assert "calc/old.go\tdeleted" in log and "calc/moved.go\tdeleted" in log


def test_place_writes_nothing_when_any_path_is_rejected(tmp_path):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    files = [{"path": "calc/hunt_hunta_test.go", "content": "x"}, {"path": "calc/evil.go", "content": "y"}]
    with pytest.raises(ValueError):
        run.place(wt, files, {"calc"})
    assert not list(wt.rglob("*.go"))


@needs_playwright
def test_verify_never_passes_on_server_errors_or_unsettled_requests(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [],
                                  "expect": [{"api": {"path": "/api/v4/broken", "status": 500}}]})
    assert code == 2 and "expects a server error" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [],
                                  "expect": [{"api": {"path": "/api/v4/broken", "status": 200}}]})
    assert code == 1 and "returned 500; a server error never satisfies" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [
        {"goto": "/slow"}, {"click": {"role": "button", "name": "Slow"}}], "expect": [{"visible": {"role": "main"}}]},
        env={"VERIFY_SETTLE_MS": "800"})
    assert code == 1 and "still in flight after 800ms: GET /api/v4/slow" in out, out


# ------------------------------------------------------------------ CodeRabbit regressions

def test_changed_go_tests_include_edited_bodies_not_only_new_declarations():
    head = "package calc\n\nfunc helper() int { return 1 }\n\nfunc TestA(t *testing.T) {\n\tx := 2\n}\n\nfunc TestB(t *testing.T) {\n}\n"
    patch = "@@ -5,3 +5,3 @@\n func TestA(t *testing.T) {\n-\tx := 1\n+\tx := 2\n }\n"
    assert ctx.changed_go_tests(patch, head) == ["TestA"]
    helper_only = "@@ -3,1 +3,1 @@\n-func helper() int { return 0 }\n+func helper() int { return 1 }\n"
    assert ctx.changed_go_tests(helper_only, head) == []


def test_go_package_exit_after_passing_tests_is_a_failure(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    exits = ("package calc\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\n"
             "func TestMain(m *testing.M) {\n\tm.Run()\n\tos.Exit(3) // teardown failure after the tests\n}\n\n"
             "func TestHuntB_Fine(t *testing.T) {}\n")
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go", "content": exits}]}))
    table = run.cmd_run(hdir, state, "B", runs=1)
    assert table == {"calc::TestHuntB_Fine": "PASS", "calc::(package failed)": "FAIL_3_OF_3"}


def test_git_commands_ignore_inherited_repository_variables(tmp_path, monkeypatch):
    outer = tmp_path / "outer"
    outer.mkdir()
    _git(outer, "init", "-q")
    inner = tmp_path / "inner"
    inner.mkdir()
    _git(inner, "init", "-q")
    monkeypatch.setenv("GIT_DIR", str(outer / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(outer))
    assert hunt_common.git(inner, "rev-parse", "--show-toplevel") == str(inner.resolve())


@needs_playwright
def test_token_mode_keeps_the_bearer_on_the_server_and_writes_pass_csrf(tmp_path, ui_server):
    SEEN.clear()
    other = ui_server.replace("127.0.0.1", "localhost")  # same server, different origin
    code, out = verify(tmp_path, {
        "base_url": ui_server, "allow_origins": [other],
        "steps": [{"goto": "/xorigin"}, {"goto": "/ok"}, {"click": {"role": "button", "name": "Save"}}],
        "expect": [{"text": {"role": "list"}, "contains": "saved"}]}, auth="token")
    assert code == 0 and "token auth as tester (Bearer header, same origin only)" in out, out
    asset = [a for host, path, a in SEEN if path == "/asset.js"]
    assert asset == [None], SEEN  # the other origin never sees the token
    writes = [a for host, path, a in SEEN if path == "/api/v4/things"]
    assert writes == [f"Bearer {TOKEN}"], SEEN  # header auth, so the write needs no CSRF token


@needs_playwright
def test_password_mode_writes_carry_the_csrf_cookie(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/ok"}, {"click": {"role": "button", "name": "Save"}}],
                                  "expect": [{"text": {"role": "list"}, "contains": "saved"}]}, auth="password")
    assert code == 0, out


def test_place_rolls_back_a_file_that_failed_mid_write(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    real_write = Path.write_text

    def flaky_write(self, data, *args, **kwargs):
        if self.name == "hunt_huntb_test.go":
            real_write(self, data[:3], *args, **kwargs)  # partial file on disk, then the disk "fills up"
            raise OSError("No space left on device")
        return real_write(self, data, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", flaky_write)
    files = [{"path": "calc/hunt_hunta_test.go", "content": "a"}, {"path": "calc/hunt_huntb_test.go", "content": "bbbbbb"}]
    with pytest.raises(OSError):
        run.place(wt, files, {"calc"})
    assert not list(wt.rglob("*.go"))
