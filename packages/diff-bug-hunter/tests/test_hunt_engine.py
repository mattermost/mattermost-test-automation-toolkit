# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-test for the /hunt scripts: worktrees + merge-base, context builder, runner, vetting, mutation gate,
large-diff prefilter and lessons. Fixtures are tiny git repos built from tests/hunt_fixtures/<name>/{base,head}."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / ".claude" / "skills" / "hunt" / "scripts"
FIX = Path(__file__).resolve().parent / "hunt_fixtures"
JESTDEPS = FIX / "jestdeps" / "node_modules"
sys.path.insert(0, str(SCRIPTS))

import build_requests  # noqa: E402
import ctx  # noqa: E402
import lessons  # noqa: E402
import prefilter  # noqa: E402
import prepare  # noqa: E402
import run  # noqa: E402

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
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
    assert run.cmd_run(hdir, state, "A") == {"TestHuntA_ClampRangeAndIdentity": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"TestHuntA_ClampRangeAndIdentity": "NEW_PR_BUG"}
    assert not list(Path(state["wt"]).rglob("hunt_*")) and not list(Path(state["wt_base"]).rglob("hunt_*"))


# ------------------------------------------------------------------ fixture 2: known React bug

@pytest.mark.skipif(not JESTDEPS.is_dir(), reason="run `make jest-deps` first")
def test_react_bug_fails_3_of_3_and_is_new_in_pr(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_bug")
    assert state["targets"] == [{"lang": "jest", "dir": "web/src", "path": "web/src/hunt_<mode>.test.tsx"}]
    assert run.cmd_run(hdir, state, "A", runs=3) == {"HuntA_neverExceedsMax": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"HuntA_neverExceedsMax": "NEW_PR_BUG"}


@pytest.mark.skipif(not JESTDEPS.is_dir(), reason="run `make jest-deps` first")
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
    assert v["M1"]["verdict"] == "KILLED" and v["M1"]["killers"] == ["TestHuntA_PercentZeroTotal"]
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
    assert v[0]["verdict"] == "KILLED" and v[0]["killers"] == ["TestClampMiddle"]


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


def test_real_lessons_are_injected_into_hunter_prompts_only():
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
