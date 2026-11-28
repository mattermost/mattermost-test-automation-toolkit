# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Wave 2 /verify: license upload (V1), feature flags (V2), same-origin /oauth/ and /plugins/<id>/ plan paths (V3),
ancestor base image (V6), two-dot range base (G1)."""

import http.server
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".claude" / "skills" / "verify" / "scripts"))
import pr_server
from test_hunt_engine import GIT_ENV, _module, needs_node

SECRET = "SECRET-LICENSE-BODY-123"
IMG = pr_server.IMAGE_REPO


# ---- V1 license


def test_license_comes_from_the_file_first_then_the_env_and_is_none_when_unset(tmp_path):
    f = tmp_path / "lic"
    f.write_text(f"  {SECRET}\n")
    assert pr_server.read_license({"MM_LICENSE_FILE": str(f), "MM_LICENSE": "other"}) == SECRET
    assert pr_server.read_license({"MM_LICENSE": SECRET}) == SECRET
    assert pr_server.read_license({}) is None
    assert pr_server.read_license({"MM_LICENSE": "  "}) is None
    with pytest.raises(pr_server.InfraError, match="not readable"):
        pr_server.read_license({"MM_LICENSE_FILE": str(tmp_path / "missing")})


class _LicenseFake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.seen.append((self.path, self.headers["Content-Type"], self.headers["Authorization"], raw))
        code = self.server.code
        self.send_response(code)
        self.end_headers()
        self.wfile.write(json.dumps({"id": "api.license.add_license.invalid.app_error", "message": SECRET}).encode())


@pytest.fixture
def license_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _LicenseFake)
    srv.seen, srv.code = [], 200
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv, f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_upload_license_posts_multipart_and_an_error_never_echoes_the_license(license_server):
    srv, url = license_server
    pr_server.upload_license(url, "tok", SECRET)
    path, ctype, auth, raw = srv.seen[0]
    assert path == "/api/v4/license" and ctype.startswith("multipart/form-data; boundary=") and auth == "Bearer tok"
    assert b'name="license"' in raw and SECRET.encode() in raw
    srv.code = 400
    with pytest.raises(pr_server.InfraError) as e:
        pr_server.upload_license(url, "tok", SECRET)
    assert "HTTP 400 api.license.add_license.invalid.app_error" in str(e.value) and SECRET not in str(e.value)


def _stack(tmp_path, monkeypatch):
    e2e = tmp_path / "e2e-tests"
    (e2e / ".ci").mkdir(parents=True)
    (e2e / ".ci" / "server.generate.sh").write_text("")
    monkeypatch.setenv("VERIFY_USER", "poster")
    monkeypatch.setenv("VERIFY_PASSWORD", "pw")
    monkeypatch.delenv("MM_LICENSE_FILE", raising=False)
    monkeypatch.delenv("MM_LICENSE", raising=False)
    monkeypatch.setattr(pr_server, "profile_path", lambda: tmp_path / "profile")
    monkeypatch.setattr(pr_server, "lock_path", lambda: tmp_path / "lock")
    return e2e


def test_up_requires_a_license_only_with_require_license_and_before_touching_the_stack(tmp_path, monkeypatch, capsys):
    e2e = _stack(tmp_path, monkeypatch)
    monkeypatch.setattr(pr_server, "make", lambda *a: pytest.fail("started a stack"))
    with pytest.raises(pr_server.InfraError, match="--require-license"):
        pr_server.up(f"{IMG}:3f535d1", e2e, require_license=True)
    # without the flag a missing license is only reported in the profile
    state = {"build": "3f535d1aaa", "seeded": []}
    monkeypatch.setattr(pr_server, "running_build", lambda url: state["build"])
    monkeypatch.setattr(pr_server, "seed", lambda *a: state["seeded"].append(a))
    pr_server.up(f"{IMG}:3f535d1", e2e)
    out = capsys.readouterr().out
    assert "license=none" in out and len(state["seeded"][0]) == 3


def test_up_passes_the_license_to_seed_and_never_prints_it(tmp_path, monkeypatch, capsys):
    e2e = _stack(tmp_path, monkeypatch)
    monkeypatch.setenv("MM_LICENSE", SECRET)
    seeded = []
    monkeypatch.setattr(pr_server, "running_build", lambda url: "3f535d1aaa")
    monkeypatch.setattr(pr_server, "seed", lambda *a: seeded.append(a))
    pr_server.up(f"{IMG}:3f535d1", e2e)
    assert seeded[0][3] == SECRET
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err and "license=uploaded" in out.out


# ---- V2 flags


def test_flag_names_are_validated_and_become_mm_env_pairs():
    assert pr_server.parse_flags("FeatureB, FeatureA,FeatureA") == ["FeatureA", "FeatureB"]
    assert pr_server.parse_flags("") == []
    for bad in ("A=1", "A,B C", "1Flag", "x;y"):
        with pytest.raises(pr_server.InfraError, match="not a feature flag name"):
            pr_server.parse_flags(bad)
    assert pr_server.flags_env(["FeatureA", "Other"]) == "MM_FEATUREFLAGS_FEATUREA=true,MM_FEATUREFLAGS_OTHER=true"


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True, capture_output=True)


def test_flags_come_from_added_diff_lines_only(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.go").write_text("if cfg.FeatureFlags.Old {\n}\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "base")
    (tmp_path / "a.go").write_text("if cfg.FeatureFlags.NewThing && cfg.FeatureFlags.Second {\n}\n")
    _git(tmp_path, "commit", "-qam", "head")
    assert pr_server.flags_from_diff("HEAD~1..HEAD", tmp_path) == ["NewThing", "Second"]
    assert pr_server.flags_from_diff("HEAD~1...HEAD", tmp_path) == ["NewThing", "Second"]
    for bad in ("HEAD", "--output=x..HEAD", "a..b c"):
        with pytest.raises(pr_server.InfraError, match="invalid range"):
            pr_server.flags_from_diff(bad, tmp_path)


def test_up_sets_flags_through_mm_env_and_restarts_when_the_profile_changes(tmp_path, monkeypatch, capsys):
    e2e = _stack(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(pr_server, "running_build", lambda url: "3f535d1aaa")
    monkeypatch.setattr(pr_server, "seed", lambda *a: None)
    monkeypatch.setattr(pr_server, "make", lambda e, target, image, mm_env="": calls.append((target, mm_env)))
    pr_server.up(f"{IMG}:3f535d1", e2e, flags=["FeatureA"])
    assert calls == [("stop-server", ""), ("start-server", "MM_FEATUREFLAGS_FEATUREA=true")]
    assert "PROFILE flags=FeatureA" in capsys.readouterr().out
    calls.clear()
    pr_server.up(f"{IMG}:3f535d1", e2e, flags=["FeatureA"])  # same profile, same build: no restart
    assert calls == []
    pr_server.up(f"{IMG}:3f535d1", e2e)  # flags off again: the flagged server is replaced
    assert [c[0] for c in calls] == ["stop-server", "start-server"] and calls[1][1] == ""


def test_main_collects_flag_and_license_options(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(pr_server, "up", lambda image, e2e, **kw: seen.update(image=image, **kw))
    monkeypatch.setattr(pr_server, "flags_from_diff", lambda target: ["FromDiff"])
    pr_server.main(["up", "--e2e", str(tmp_path), "img:abcdef1", "--flags", "Explicit", "--flags-from-diff", "a..b",
                    "--require-license"])
    assert seen == {"image": "img:abcdef1", "flags": ["Explicit", "FromDiff"], "require_license": True}
    for bad in (["up", "img:abcdef1", "--flags"], ["down", "--require-license"]):
        with pytest.raises(SystemExit):
            pr_server.main(bad)


# ---- G1 / V6 images


def _gh(shas):
    def fake(path):
        if "/compare/" in path:
            return {"merge_base_commit": {"sha": "m" * 40}}
        ref = path.rsplit("/", 1)[-1]
        return shas.get(ref, {"sha": ref})
    return fake


def test_two_dot_range_uses_the_base_itself_and_three_dot_the_merge_base(monkeypatch):
    shas = {"v1": {"sha": "1" * 40}, "v2": {"sha": "2" * 40}}
    monkeypatch.setattr(pr_server, "gh_json", _gh(shas))
    assert pr_server.pr_shas("v1..v2") == {"head": "2" * 40, "base": "1" * 40}
    assert pr_server.pr_shas("v1...v2")["base"] == "m" * 40


def test_unpublished_base_uses_the_nearest_published_first_parent_ancestor(monkeypatch):
    chain = {f"{i}" * 7 + "a" * 33: f"{i + 1}" * 7 + "a" * 33 for i in range(1, 8)}  # sha -> its first parent
    walked = []

    def fake_gh(path):
        sha = path.rsplit("/", 1)[-1]
        full = next(k for k in chain if k.startswith(sha[:7]))
        walked.append(sha)
        return {"parents": [{"sha": chain[full]}, {"sha": "9" * 40}]}

    base = f"{IMG}:1111111"
    ok = f"{IMG}:4444444"
    monkeypatch.setattr(pr_server, "gh_json", fake_gh)
    monkeypatch.setattr(pr_server, "published", lambda image: image == ok)
    imgs, note = pr_server.substitute_base({"head": f"{IMG}:9999999", "base": base})
    assert imgs == {"head": f"{IMG}:9999999", "base": ok}
    assert note is not None and f"requested={base}" in note and f"using={ok}" in note and "first_parent_ancestor=3" in note
    # a published base is left alone and nothing is walked
    walked.clear()
    monkeypatch.setattr(pr_server, "published", lambda image: True)
    assert pr_server.substitute_base({"head": "h:1", "base": base}) == ({"head": "h:1", "base": base}, None)
    assert walked == []


def test_ancestor_walk_stops_after_20_commits(monkeypatch):
    count = []

    def fake_gh(path):
        count.append(path)
        return {"parents": [{"sha": f"{len(count):07x}" + "b" * 33}]}

    monkeypatch.setattr(pr_server, "gh_json", fake_gh)
    monkeypatch.setattr(pr_server, "published", lambda image: False)
    with pytest.raises(pr_server.InfraError, match="skipped: no image"):
        pr_server.substitute_base({"head": "h:1", "base": f"{IMG}:1111111"})
    assert len(count) == 20


def test_a_registry_failure_is_an_infra_error_not_an_unpublished_image(monkeypatch):
    def run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, "", "error: unauthorized: authentication required")
    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(pr_server.InfraError, match="unauthorized"):
        pr_server.published(f"{IMG}:abc1234")

    def missing(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, "", "no such manifest: docker.io/x:abc1234")
    monkeypatch.setattr(subprocess, "run", missing)
    assert pr_server.published(f"{IMG}:abc1234") is False


def test_images_prints_the_substitution_and_pulls_the_substitute(monkeypatch, capsys):
    pulled = []
    monkeypatch.setattr(pr_server, "pr_images", lambda t: {"head": "r:aaa", "base": "r:bbb"})
    monkeypatch.setattr(pr_server, "substitute_base", lambda i: ({"head": "r:aaa", "base": "r:ccc"}, "BASE_SUBSTITUTION x"))
    monkeypatch.setattr(pr_server, "pull", lambda img: pulled.append(img))
    pr_server.main(["images", "1", "--pull"])
    out = capsys.readouterr().out
    assert "BASE_SUBSTITUTION x" in out and '"base": "r:ccc"' in out and sorted(pulled) == ["r:aaa", "r:ccc"]


# ---- V3 plan paths


def _validate(path_expr):
    plan = ('{steps: [], expect: [{api: {path: %s}}]}' % path_expr)
    return _module(f"(() => {{ try {{ m.validatePlan({plan}, {{VERIFY_BASE_URL: 'http://127.0.0.1:8065'}}); return 'ok'; }} "
                   f"catch (e) {{ return String(e.message).split('\\n')[0]; }} }})()")


@needs_node
def test_plan_paths_allow_same_origin_oauth_and_plugin_routes_but_not_escapes():
    for ok in ("/api/v4/users/me", "/oauth/authorize", "/plugins/com.mattermost.calls/api/v1/x", "/plugins/$id/x"):
        assert json.loads(_validate(json.dumps(ok))) == "ok", ok
    for bad in ("/plugins/", "/plugins//x", "/plugins/../api/v4/x", "/plugins/a/../../etc/passwd",
                "/plugins/%2e%2e/x", "/oauthx/y", "/oauth", "/api/v4/../../x", "/api/v4/%2e%2e/%2e%2e/ok",
                "//evil.example/oauth/x", "http://evil.example/oauth/x", "/etc/passwd", "/pluginsx/a/b"):
        assert "must be a path under /api/v4/, /oauth/ or /plugins/<id>/" in json.loads(_validate(json.dumps(bad))), bad
