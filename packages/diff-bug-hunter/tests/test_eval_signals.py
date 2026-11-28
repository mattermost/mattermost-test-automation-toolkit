# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-test for eval_bugs.py's per-signal scoring, repair round and per-tag isolation, and for mine_controls.py.

The signal functions (old_tests.cmd_old, pr_tests.cmd_pr) are stubbed: they are tested on their own elsewhere. The hunter
path runs for real on the same fixture repos as test_hunt_engine.py's eval tests."""
from __future__ import annotations

import json
import shlex
import sys
import types
from pathlib import Path
from typing import Any

import eval_bugs
import hunt_common
import mine_controls
import old_tests
import pytest
import run
import trusted
from conftest import FIX, _git, make_repo


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)


# ------------------------------------------------------------------ scoring, no repository needed
def _entry(**tables: dict[str, str]) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    if "run" in tables or "base" in tables:
        results.append({"batch": 1, "hunter": "A", "run": tables.get("run", {}), "base": tables.get("base", {})})
    for key, hunter in (("old", "OLD"), ("pr", "PR")):
        if key in tables:
            results.append({"hunter": hunter, key: tables[key]})
    return {"results": results}


def _manifest() -> dict[str, Any]:
    ids = [("case", "c1"), ("case", "c2"), ("case", "c3"), ("control", "k1"), ("control", "k2")]
    return {"cases": [{"id": i, "area": "a"} for k, i in ids if k == "case"],
            "controls": [{"id": i, "area": "a"} for k, i in ids if k == "control"],
            "thresholds": dict(eval_bugs.DEFAULT_THRESHOLDS)}


def test_scorecard_reports_recall_and_fp_for_each_signal_and_combined():
    hunted = {
        "c1": _entry(run={"t": "FAIL_3_OF_3"}, base={"t": "NEW_PR_BUG"}),
        "c2": _entry(run={"t": "FAIL_3_OF_3"}, base={"t": "NEW_API"}, old={"o": "OLD_TEST_SOMETIMES_BREAKS"}),
        "c3": _entry(old={"o": "OLD_TEST_BREAKS"}, pr={"p": "PR_TEST_FAILS_UNDER_CI"}),
        "k1": _entry(pr={"p": "PR_TEST_FAILS"}, old={"o": "PASS"}),  # pr_fails: reported, not a finding
        "k2": _entry(run={"t": "FAIL_3_OF_3"}, base={"t": "PRE_EXISTING"}),
    }
    card = eval_bugs.scorecard(_manifest(), hunted)
    m = card["metrics"]
    third = round(1 / 3, 4)
    assert (m["raw_recall"], m["vetted_recall"], m["fp_rate"], m["raw_fp_rate"]) == (round(2 / 3, 4), third, 0.0, 0.5)
    assert (m["new_api_recall"], m["new_api_fp_rate"]) == (third, 0.0)
    assert (m["old_recall"], m["old_fp_rate"]) == (third, 0.0)
    assert (m["old_sometimes_recall"], m["old_sometimes_fp_rate"]) == (third, 0.0)
    assert (m["pr_ci_recall"], m["pr_ci_fp_rate"]) == (third, 0.0)
    assert (m["pr_fails_recall"], m["pr_fails_fp_rate"]) == (0.0, 0.5)
    assert (m["combined_recall"], m["combined_fp_rate"]) == (1.0, 0.0)  # finding signals only
    rows = {r["id"]: r for r in card["rows"]}
    assert [rows["c2"][k] for k in ("hunters_vetted", "hunters_new_api", "old", "old_sometimes", "pr_ci")] == \
        [False, True, False, True, False]
    assert rows["c1"]["vetted"] is True and rows["k2"]["raw"] is True and rows["k2"]["any"] is False
    # the thresholds still judge the hunters' raw and vetted metrics only
    assert card["checks"] == {"raw_recall": True, "vetted_recall": True, "fp_rate": True} and card["verdict"] == "PASS"
    text = eval_bugs.render(card)
    assert "hunters new-api" in text and "pr tests (ci)" in text and "combined (any)" in text
    assert "(3 cases, 2 controls)" in text


def test_scorecard_ignores_a_signal_that_was_switched_off():
    hunted = {"c1": _entry(run={"t": "FAIL_3_OF_3"}, base={"t": "NEW_PR_BUG"}, old={"o": "OLD_TEST_BREAKS"})}
    manifest = {**_manifest(), "cases": [{"id": "c1", "area": "a"}], "controls": []}
    card = eval_bugs.scorecard(manifest, hunted, ("old",))
    assert card["metrics"]["vetted_recall"] == 0.0 and card["metrics"]["old_recall"] == 1.0
    assert card["signals"] == ["old"] and "hunters vetted     off" in eval_bugs.render(card)


# ------------------------------------------------------------------ the real hunter path, stubbed model-free signals
def _fixture_manifest(tmp: Path, responses: bool = True) -> tuple[Path, Path]:
    """The clamp bug (go_bug) and the clean control (clean), as test_hunt_engine.py builds them. -> (manifest, bug repo)"""
    tmp.mkdir(parents=True, exist_ok=True)
    repo = make_repo(tmp, "go_bug", "go_bug", head_msg="Make Clamp faster\n\nAvoid comparison in hot path.",
                     dirname="bugrepo", feature_branch=None)
    ctl_repo = make_repo(tmp, "clean", "clean", head_msg="Handle zero total in Percent",
                         dirname="cleanrepo", feature_branch=None)
    bug = _git(repo, "rev-parse", "HEAD")
    _git(repo, "revert", "--no-edit", "HEAD")
    manifest: dict[str, Any] = {
        "cases": [{"id": "clamp", "repo": str(repo), "bug_sha": bug, "fix_sha": _git(repo, "rev-parse", "HEAD"),
                   "area": "calc", "bug": "Clamp returns max inputs.", "source": "self-test fixture"}],
        "controls": [{"id": "percent", "repo": str(ctl_repo), "sha": _git(ctl_repo, "rev-parse", "HEAD"), "area": "calc"}]}
    if responses:
        manifest["cases"][0]["responses"] = str(FIX / "go_bug" / "responses")
        manifest["controls"][0]["responses"] = str(FIX / "clean" / "responses")
    path = tmp / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path, repo


def _stub_signals(monkeypatch, old_for: dict[str, dict[str, str]], pr_for: dict[str, dict[str, str]]) -> None:
    """hunt<n> numbers entries in manifest order: hunt1 is the case, hunt2 the control."""
    monkeypatch.setattr(old_tests, "cmd_old", lambda hdir, state: {"tests": old_for.get(hdir.name, {})})
    fake = types.ModuleType("pr_tests")
    fake.cmd_pr = lambda hdir, state: {"tests": pr_for.get(hdir.name, {})}  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pr_tests", fake)


def _card(tmp: Path, name: str = "out") -> dict[str, Any]:
    return json.loads((tmp / name / "scorecard.json").read_text())


def test_eval_scores_each_signal_from_the_stubbed_checks(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path)
    _stub_signals(monkeypatch, {"hunt1": {"T::a": "OLD_TEST_BREAKS", "T::b": "OLD_TEST_SOMETIMES_BREAKS"}},
                  {"hunt1": {"P::a": "PR_TEST_FAILS_UNDER_CI"}, "hunt2": {"P::b": "PR_TEST_FAILS"}})
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")])
    assert code == 0, capsys.readouterr().out
    card = _card(tmp_path)
    m = card["metrics"]
    assert (m["vetted_recall"], m["fp_rate"]) == (1.0, 0.0)  # hunters unchanged by the new signals
    assert (m["old_recall"], m["old_sometimes_recall"], m["pr_ci_recall"], m["new_api_recall"]) == (1.0, 1.0, 1.0, 0.0)
    assert (m["old_fp_rate"], m["pr_ci_fp_rate"], m["pr_fails_fp_rate"], m["combined_fp_rate"]) == (0.0, 0.0, 1.0, 0.0)
    assert card["signals"] == ["hunters", "diff", "old", "pr"]
    assert "pr tests (ci)" in capsys.readouterr().out


def test_eval_signals_flag_runs_only_the_chosen_signals(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path)
    _stub_signals(monkeypatch, {"hunt1": {"T::a": "OLD_TEST_BREAKS"}}, {"hunt1": {"P::a": "PR_TEST_FAILS_UNDER_CI"}})

    def boom(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("hunters must not run")

    monkeypatch.setattr(run, "cmd_run", boom)
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--signals", "old,pr"])
    assert code == 0, capsys.readouterr().out
    m = _card(tmp_path)["metrics"]
    assert (m["raw_recall"], m["vetted_recall"], m["old_recall"], m["pr_ci_recall"]) == (0.0, 0.0, 1.0, 1.0)
    assert eval_bugs.main(["eval_bugs.py", str(path), "--signals", "old,bogus"]) == 2
    assert "INVALID_SIGNALS" in capsys.readouterr().out


def test_eval_records_a_missing_or_failing_pr_signal_and_keeps_the_entry(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path)
    monkeypatch.setattr(old_tests, "cmd_old", lambda hdir, state: {"tests": {}})
    monkeypatch.setitem(sys.modules, "pr_tests", None)  # import raises ImportError
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")]) == 1
    card = _card(tmp_path)
    assert card["fp_checks"]["pr_ci_fp_rate"] is False
    rows = {r["id"]: r for r in card["rows"]}
    assert "signal not available" in rows["clamp"]["pr_error"] and rows["clamp"]["error"] is None
    assert rows["clamp"]["vetted"] is True  # the hunters' result stands

    def infra(hdir: Path, state: dict[str, Any]) -> dict[str, Any]:
        raise hunt_common.InfraError("no CI config here")

    fake = types.ModuleType("pr_tests")
    fake.cmd_pr = infra  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pr_tests", fake)
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out2")]) == 1
    card2 = _card(tmp_path, "out2")
    assert card2["fp_checks"]["pr_ci_fp_rate"] is False
    rows = {r["id"]: r for r in card2["rows"]}
    assert rows["clamp"]["pr_error"] == "no CI config here" and rows["clamp"]["error"] is None
    assert "pr-tests ERROR no CI config here" in capsys.readouterr().out


def test_eval_an_infra_error_in_one_hunter_keeps_the_other_hunter_and_signals(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path)
    m = json.loads(path.read_text())
    both = tmp_path / "both_responses"  # the clamp response for hunter A, renamed for hunter B: two hunters to compare
    good = (FIX / "go_bug" / "responses" / "A" / "response.json").read_text()
    for tag in ("A", "B"):
        (both / tag).mkdir(parents=True)
        (both / tag / "response.json").write_text(good.replace("HuntA", f"Hunt{tag}").replace("hunta", f"hunt{tag.lower()}"))
    m["cases"][0]["responses"] = str(both)
    path.write_text(json.dumps(m))
    _stub_signals(monkeypatch, {"hunt1": {"T::a": "OLD_TEST_BREAKS"}}, {})
    real = run.cmd_run

    def flaky(hdir: Path, state: dict[str, Any], tag: str, runs: int = 3) -> dict[str, Any]:
        if tag == "A" and hdir.name == "hunt1":
            raise hunt_common.InfraError("no jest.config above webapp/channels/src/nowhere")
        return real(hdir, state, tag, runs)

    monkeypatch.setattr(run, "cmd_run", flaky)
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")])
    out = capsys.readouterr().out
    card = _card(tmp_path)
    rows = {r["id"]: r for r in card["rows"]}
    assert rows["clamp"]["error"] is None and card["verdict"] != "ERROR" and code != 2, out
    assert rows["clamp"]["hunter_errors"] == ["A: no jest.config above webapp/channels/src/nowhere"]
    assert rows["clamp"]["vetted"] is True  # hunter B still ran and was vetted
    assert rows["clamp"]["old"] is True  # and so did the old-test signal
    assert "hunter A: no jest.config above" in out
    entry = json.loads((tmp_path / "out" / "entry_1_clamp.json").read_text())
    assert [r["hunter"] for r in entry["results"]] == ["A", "B", "OLD", "PR"]
    assert "run" not in entry["results"][0] and "run" in entry["results"][1]


def test_eval_entries_that_cannot_prepare_still_count_as_errors(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path)
    _stub_signals(monkeypatch, {}, {})

    def no_deps(*_a: Any, **_k: Any) -> None:
        raise hunt_common.InfraError("npm ci failed")

    monkeypatch.setattr(eval_bugs.prepare, "deps", no_deps)
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")]) == 2
    assert "VERDICT: ERROR" in capsys.readouterr().out and set(_card(tmp_path)["errors"]) == {"clamp", "percent"}


# ------------------------------------------------------------------ repair round
def _dispatcher(tmp: Path, repair_fixes: bool) -> tuple[str, Path]:
    """A fake model: the first Clamp hunter A response does not compile; the repair request gets the good one (or the
    same broken one again when repair_fixes is False). Every other request gets an empty response."""
    good = FIX / "go_bug" / "responses" / "A" / "response.json"
    log = tmp / "dispatched.txt"
    script = tmp / "dispatch.py"
    script.write_text(
        "import json, sys\n"
        "req = json.load(open(sys.argv[1]))\n"
        f"open({str(log)!r}, 'a').write(sys.argv[1].rsplit('/', 1)[-1] + ' ' + req['response_path'] + '\\n')\n"
        "out = {'files': [], 'tests': []}\n"
        "if '/hunt1/A/' in req['response_path']:\n"
        f"    out = json.load(open({str(good)!r}))\n"
        f"    if {not repair_fixes!r} or sys.argv[1].endswith('request.json'):\n"
        "        out['files'][0]['content'] += '\\nvar _ = undefinedHuntSymbol\\n'\n"
        "json.dump(out, open(req['response_path'], 'w'))\n")
    return f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}", log


def test_eval_gives_a_compile_error_one_repair_round_when_dispatching(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path / "m", responses=False)
    _stub_signals(monkeypatch, {}, {})
    cmd, log = _dispatcher(tmp_path, repair_fixes=True)
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--dispatch", cmd])
    out = capsys.readouterr().out
    assert code == 0, out
    rows = {r["id"]: r for r in _card(tmp_path)["rows"]}
    assert rows["clamp"]["vetted"] is True and rows["clamp"]["error"] is None
    entry = json.loads((tmp_path / "out" / "entry_1_clamp.json").read_text())
    row = next(r for r in entry["results"] if r["hunter"] == "A")
    assert row["repaired"] is True and "compile_error" not in row
    assert [line.endswith("/hunt1/A/response.json") for line in log.read_text().splitlines()
            if line.startswith("request.repair.json")] == [True]  # one repair dispatch, for the case's hunter A
    assert "undefinedHuntSymbol" in (tmp_path / "out" / "hunt1" / "compile_A.log").read_text()  # run.py's log, replicated
    req = json.loads((tmp_path / "out" / "hunt1" / "A" / "request.repair.json").read_text())
    assert "undefinedHuntSymbol" in req["user"]  # build_requests put the compiler error in front of the repairing agent
    assert "undefinedHuntSymbol" in (tmp_path / "out" / "hunt1" / "A" / "response.prev.json").read_text()


def test_eval_a_repair_that_still_does_not_compile_is_a_miss(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path / "m", responses=False)
    _stub_signals(monkeypatch, {}, {})
    cmd, log = _dispatcher(tmp_path, repair_fixes=False)
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--dispatch", cmd,
                           "--signals", "hunters"])
    capsys.readouterr()
    card = _card(tmp_path)
    rows = {r["id"]: r for r in card["rows"]}
    assert rows["clamp"]["error"] is None and rows["clamp"]["vetted"] is False and rows["clamp"]["raw"] is False
    entry = json.loads((tmp_path / "out" / "entry_1_clamp.json").read_text())
    row = next(r for r in entry["results"] if r["hunter"] == "A")
    assert row["repaired"] is True and "undefinedHuntSymbol" in row["compile_error"]
    assert sum(line.startswith("request.repair.json") for line in log.read_text().splitlines()) == 1  # never a second
    assert code == 0 and card["verdict"] == "PASS"  # default thresholds: a miss is not an error


def test_eval_without_dispatch_a_compile_error_is_a_miss_with_no_repair(tmp_path, monkeypatch, capsys):
    path, _ = _fixture_manifest(tmp_path / "m")
    broken = tmp_path / "broken" / "A"
    broken.mkdir(parents=True)
    data = json.loads((FIX / "go_bug" / "responses" / "A" / "response.json").read_text())
    data["files"][0]["content"] += "\nvar _ = undefinedHuntSymbol\n"
    (broken / "response.json").write_text(json.dumps(data))
    m = json.loads(path.read_text())
    m["cases"][0]["responses"] = str(broken.parent)
    path.write_text(json.dumps(m))
    _stub_signals(monkeypatch, {}, {})
    eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--signals", "hunters"])
    capsys.readouterr()
    row = next(r for r in json.loads((tmp_path / "out" / "entry_1_clamp.json").read_text())["results"]
               if r["hunter"] == "A")
    assert "compile_error" in row and "repaired" not in row
    assert not (tmp_path / "out" / "hunt1" / "A" / "request.repair.json").exists()


# ------------------------------------------------------------------ --controls
def test_eval_appends_extra_controls_and_keeps_ids_unique(tmp_path, monkeypatch, capsys):
    path, repo = _fixture_manifest(tmp_path)
    _stub_signals(monkeypatch, {}, {})
    sha = _git(repo, "rev-parse", "HEAD~1")  # any commit with a parent: the bug commit
    extra = tmp_path / "extra.json"
    extra.write_text(json.dumps({"controls": [{"id": "extra-1", "repo": str(repo), "area": "calc", "sha": sha, "matches": "clamp"}]}))
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"), "--signals", "old",
                           "--controls", str(extra)]) == 0
    assert [r["id"] for r in _card(tmp_path)["rows"]] == ["clamp", "percent", "extra-1"]
    extra.write_text(json.dumps([{"id": "percent", "repo": str(repo), "area": "calc", "sha": sha}]))  # a bare list, with a clashing id
    assert eval_bugs.main(["eval_bugs.py", str(path), "--controls", str(extra)]) == 2
    assert "ids must be unique" in capsys.readouterr().out
    assert eval_bugs.main(["eval_bugs.py", str(path), "--controls", str(tmp_path / "nope.json")]) == 2


# ------------------------------------------------------------------ mine_controls
def _commit(repo: Path, name: str, files: dict[str, int], message: str, when: str) -> str:
    """Add one new file per entry of `files` (path -> lines), commit with the given date."""
    for rel, n in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text("x\n" * n)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", message, when=when)
    return _git(repo, "rev-parse", "HEAD")


def _mining_history(tmp: Path) -> tuple[Path, dict[str, str]]:
    repo = tmp / "mining"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    sha: dict[str, str] = {}
    sha["root"] = _commit(repo, "root", {"README.txt": 1}, "root", "2024-01-01T00:00:00 +0000")
    sha["case"] = _commit(repo, "case", {"srv/app/a.go": 10, "srv/app/b.go": 10}, "MM-111 the bug\n\nbody",
                          "2024-03-01T00:00:00 +0000")
    sha["clean_far"] = _commit(repo, "x", {"srv/app/c1.go": 10, "srv/app/c2.go": 12}, "clean far in size and time",
                               "2024-03-20T00:00:00 +0000")
    sha["clean_best"] = _commit(repo, "x", {"srv/app/d1.go": 10, "srv/app/d2.go": 10}, "clean best match",
                                "2024-03-10T00:00:00 +0000")
    sha["clean_three"] = _commit(repo, "x", {"srv/app/e1.go": 10, "srv/app/e2.go": 10, "srv/app/e3.go": 10},
                                 "clean, three files", "2024-02-20T00:00:00 +0000")
    sha["ticket"] = _commit(repo, "x", {"srv/app/f1.go": 10, "srv/app/f2.go": 10}, "MM-111 same ticket, other PR",
                            "2024-03-02T00:00:00 +0000")
    sha["reverted"] = _commit(repo, "x", {"srv/app/g1.go": 10, "srv/app/g2.go": 10}, "good looking but reverted",
                              "2024-03-03T00:00:00 +0000")
    sha["reverted_by_title"] = _commit(repo, "x", {"srv/app/h1.go": 10, "srv/app/h2.go": 10},
                                       "title-only revert (#9)", "2024-03-04T00:00:00 +0000")
    sha["too_small"] = _commit(repo, "x", {"srv/app/i1.go": 3}, "one file, few lines", "2024-03-05T00:00:00 +0000")
    sha["too_big"] = _commit(repo, "x", {f"srv/app/j{i}.go": 10 for i in range(5)}, "five files",
                             "2024-03-06T00:00:00 +0000")
    sha["elsewhere"] = _commit(repo, "x", {"other/k1.go": 10, "other/k2.go": 10}, "wrong directory",
                               "2024-03-07T00:00:00 +0000")
    sha["too_late"] = _commit(repo, "x", {"srv/app/l1.go": 10, "srv/app/l2.go": 10}, "200 days later",
                              "2024-09-17T00:00:00 +0000")
    sha["tests_only"] = _commit(repo, "x", {"srv/app/m_test.go": 20}, "only tests", "2024-03-08T00:00:00 +0000")
    sha["merge_side"] = _commit(repo, "x", {"srv/app/n1.go": 10, "srv/app/n2.go": 10}, "an existing control",
                                "2024-03-09T00:00:00 +0000")
    _git(repo, "revert", "--no-edit", sha["reverted"], when="2024-04-01T00:00:00 +0000")  # "This reverts commit <sha>"
    _git(repo, "commit", "--allow-empty", "-qm", 'Revert "title-only revert (#9)"', when="2024-04-02T00:00:00 +0000")
    _git(repo, "commit", "--allow-empty", "-qm", f'Revert "the bug"\n\nThis reverts commit {sha["case"]}.\nMM-222',
         when="2024-04-03T00:00:00 +0000")  # the case's own revert
    sha["fix"] = _git(repo, "rev-parse", "HEAD")
    return repo, sha


def test_mine_controls_picks_size_matched_clean_commits_closest_first(tmp_path, capsys):
    repo, sha = _mining_history(tmp_path)
    manifest = {"cases": [{"id": "bug", "area": "srv/app", "bug_sha": sha["case"], "fix_sha": sha["fix"]}],
                "controls": [{"id": "old-ctl", "area": "srv/app", "sha": sha["merge_side"]}]}
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    out = tmp_path / "extra.json"
    assert mine_controls.main(["mine_controls.py", str(repo), str(mpath), "--per-case", "5", "--out", str(out)]) == 0
    data = json.loads(out.read_text())
    # best = identical size; far = 22 lines but 11 days later; three = 1.5x files and lines; the rest each fail one rule
    assert [c["sha"] for c in data["controls"]] == [sha["clean_best"], sha["clean_far"], sha["clean_three"]]
    assert all(set(c) == {"id", "area", "sha", "matches"} and c["matches"] == "bug" and c["area"] == "srv/app"
               for c in data["controls"])
    assert [c["id"] for c in data["controls"]] == ["bug-ctl1", "bug-ctl2", "bug-ctl3"]
    assert data["filled"] == {"bug": 3}
    assert "short: bug (3)" in capsys.readouterr().out  # asked for 5, found 3: named, not hidden
    # deterministic, and --per-case caps it
    out2 = tmp_path / "extra2.json"
    assert mine_controls.main(["mine_controls.py", str(repo), str(mpath), "--per-case", "2", "--out", str(out2)]) == 0
    assert [c["sha"] for c in json.loads(out2.read_text())["controls"]] == [sha["clean_best"], sha["clean_far"]]
    assert mine_controls.main(["mine_controls.py", str(repo), str(mpath), "--per-case", "5", "--out", str(out)]) == 0
    assert json.loads(out.read_text()) == data


def test_mine_controls_never_picks_a_reverted_ticket_sharing_or_foreign_commit(tmp_path, capsys):
    repo, sha = _mining_history(tmp_path)
    manifest = {"cases": [{"id": "bug", "area": "srv/app", "bug_sha": sha["case"], "fix_sha": sha["fix"]}]}
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    picked, _ = mine_controls.mine(repo, manifest, 20)
    got = {c["sha"] for c in picked}
    for bad in ("reverted", "reverted_by_title", "ticket", "too_small", "too_big", "elsewhere", "too_late", "tests_only",
                "case", "fix", "root"):
        assert sha[bad] not in got, bad
    assert sha["merge_side"] in got  # not excluded unless the manifest lists it as a control
    picked, _ = mine_controls.mine(repo, {**manifest, "controls": [{"id": "c", "sha": sha["merge_side"], "area": "a"}]}, 20)
    assert sha["merge_side"] not in {c["sha"] for c in picked}
    capsys.readouterr()


def test_eval_scores_mode_d_diff_signal_from_responses_and_dispatch(tmp_path, monkeypatch, capsys):
    # Case = diff_go (behaviour changes on head -> DIFF), control = diff_same (identical -> SAME).
    bug_repo, ctl_repo = tmp_path / "diff_bug", tmp_path / "diff_same"
    for r, name, msg in ((bug_repo, "diff_go", "Adjust calc behaviour"), (ctl_repo, "diff_same", "Refactor calc")):
        r.mkdir()
        _git(r, "init", "-q", "-b", "master")
        for step in ("base", "head"):
            for f in (FIX / name / step).rglob("*"):
                if f.is_file():
                    dst = r / f.relative_to(FIX / name / step)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_bytes(f.read_bytes())
            _git(r, "add", "-A")
            _git(r, "commit", "-qm", "base" if step == "base" else msg)
    bug = _git(bug_repo, "rev-parse", "HEAD")
    _git(bug_repo, "revert", "--no-edit", "HEAD")
    manifest = {
        "cases": [{"id": "diff-case", "repo": str(bug_repo), "bug_sha": bug, "fix_sha": _git(bug_repo, "rev-parse", "HEAD"),
                   "area": "calc", "bug": "Changed calc output", "source": "self-test fixture",
                   "responses": str(FIX / "diff_go" / "responses")}],
        "controls": [{"id": "diff-ctl", "repo": str(ctl_repo), "sha": _git(ctl_repo, "rev-parse", "HEAD"),
                      "area": "calc", "responses": str(FIX / "diff_same" / "responses")}],
    }
    mpath = tmp_path / "manifest.json"
    mpath.write_text(json.dumps(manifest))
    code = eval_bugs.main(["eval_bugs.py", str(mpath), "--out", str(tmp_path / "out"), "--signals", "diff"])
    out = capsys.readouterr().out
    assert code == 0, out
    card = _card(tmp_path)
    assert card["signals"] == ["diff"]
    assert card["metrics"]["diff_recall"] == 1.0 and card["metrics"]["diff_fp_rate"] == 0.0
    assert "diff (Mode D)" in out
    rows = {r["id"]: r for r in card["rows"]}
    assert rows["diff-case"]["diff"] is True and rows["diff-ctl"]["diff"] is False


def test_mine_controls_finds_in_window_commit_under_out_of_order_child_date(tmp_path):
    repo = tmp_path / "skew"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "master")
    _commit(repo, "init", {"b/init.go": 1}, "init", "2024-05-01T00:00:00Z")
    bug = _commit(repo, "bug", {"a/x.go": 5}, "bug commit", "2024-06-01T00:00:00Z")
    _git(repo, "revert", "--no-edit", "HEAD", when="2024-06-02T00:00:00Z")
    fix = _git(repo, "rev-parse", "HEAD")
    target = _commit(repo, "target", {"a/y.go": 5}, "clean change in window", "2024-06-05T00:00:00Z")
    # Skewed timestamp older than case - 90d; git log --after would cut off traversal before reaching target.
    _commit(repo, "skewed", {"b/skew.go": 1}, "rebased old timestamp", "2024-01-01T00:00:00Z")
    _commit(repo, "tip", {"b/tip.go": 1}, "tip", "2024-06-10T00:00:00Z")
    manifest = {"cases": [{"id": "c1", "bug_sha": bug, "fix_sha": fix, "area": "a"}], "controls": []}
    picked, _ = mine_controls.mine(repo, manifest, 5)
    assert any(c["sha"] == target for c in picked)


# ------------------------------------------------------------------ fix-commit oracle: is a vetted test the right test?
CLAMP_FIXED = (FIX / "go_bug" / "base" / "calc" / "calc.go").read_text()
CLAMP_BUGGY = (FIX / "go_bug" / "head" / "calc" / "calc.go").read_text()


def _with_fix(path: Path, repo: Path, calc_go: str) -> None:
    """Make the case's fix a fix-forward commit on top of the bug (not the revert) that leaves calc.go as calc_go."""
    m = json.loads(path.read_text())
    case = m["cases"][0]
    _git(repo, "checkout", "-q", "-b", "fix", case["bug_sha"])
    (repo / "calc" / "calc.go").write_text(calc_go)
    _git(repo, "commit", "-qam", "Fix forward")
    case.update(kind="rc_hotfix", fix_sha=_git(repo, "rev-parse", "HEAD"))
    path.write_text(json.dumps(m))


def _fix_card(tmp: Path, monkeypatch, capsys, calc_go: str | None) -> tuple[dict[str, Any], str]:
    path, repo = _fixture_manifest(tmp)
    if calc_go is not None:
        _with_fix(path, repo, calc_go)
    _stub_signals(monkeypatch, {}, {})
    eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp / "out"), "--signals", "hunters"])
    return _card(tmp), capsys.readouterr().out


def test_fix_oracle_a_vetted_test_that_passes_on_the_revert_is_strong(tmp_path, monkeypatch, capsys):
    card, out = _fix_card(tmp_path, monkeypatch, capsys, None)  # the fixture's fix is `git revert` of the bug
    rows = {r["id"]: r for r in card["rows"]}
    assert rows["clamp"]["vetted"] and rows["clamp"]["strong"] and rows["clamp"]["fix_oracle"] == "revert"
    assert rows["clamp"]["fix_verdicts"] == {"A": {"STRONG": 1}} and rows["clamp"]["strictly_weak"] == []
    assert not rows["percent"]["has_fix"] and rows["percent"]["fix_verdicts"] == {}  # controls have no fix commit
    m = card["metrics"]
    assert (m["strong_recall"], m["strong_recall_fix_forward"], m["strictly_weak_ratio_A"]) == (1.0, 0.0, 0.0)
    assert "strong recall      1.00 (1 cases with a fix commit; fix-forward only: 0.00 of 0)" in out


def test_fix_oracle_a_vetted_test_that_still_fails_on_the_fix_is_strictly_weak(tmp_path, monkeypatch, capsys):
    # The "fix" changes something else and keeps the off-by-one: the hunter test asserts what the fix did not remove.
    card, out = _fix_card(tmp_path, monkeypatch, capsys, CLAMP_BUGGY.replace("limits v", "limits the value v"))
    row = next(r for r in card["rows"] if r["id"] == "clamp")
    assert row["vetted"] and not row["strong"] and row["fix_oracle"] == "fix_forward"
    assert row["strictly_weak"] == ["A:calc::TestHuntA_ClampRangeAndIdentity"]
    assert (card["metrics"]["strong_recall_fix_forward"], card["metrics"]["strictly_weak_ratio_A"]) == (0.0, 1.0)
    assert "read clamp: A:calc::TestHuntA_ClampRangeAndIdentity" in out


def test_fix_oracle_a_test_of_an_api_the_fix_renamed_is_fix_incompatible(tmp_path, monkeypatch, capsys):
    card, _ = _fix_card(tmp_path, monkeypatch, capsys, CLAMP_FIXED.replace("func Clamp(", "func ClampInt("))
    row = next(r for r in card["rows"] if r["id"] == "clamp")
    assert row["vetted"] and not row["strong"] and row["fix_verdicts"] == {"A": {"FIX_INCOMPATIBLE": 1}}
    assert card["metrics"]["strictly_weak_ratio_A"] == 0.0  # unknown is neither strong nor strictly weak


def test_fix_verdict_needs_every_run_to_agree():
    assert eval_bugs.fix_verdict(["PASS"] * 3, False, "") == "STRONG"
    assert eval_bugs.fix_verdict(["FAIL"] * 3, False, "got 7, want 5") == "STRICTLY_WEAK"
    assert eval_bugs.fix_verdict(["PASS", "FAIL", "PASS"], False, "") == "FIX_FLAKY"
    assert eval_bugs.fix_verdict(["PASS"] * 3, True, "") == "FIX_INCOMPATIBLE"
    assert eval_bugs.fix_verdict(["FAIL"] * 3, False, "TypeError: clamp is not a function") == "FIX_INCOMPATIBLE"
    assert eval_bugs.fix_verdict(["MISSING", "PASS", "PASS"], False, "") == "FIX_NOT_RUN"


def test_diff_gate_fails_when_strong_recall_drops_and_skips_it_for_old_scorecards():
    def card(vetted: float, strong: float | None) -> dict[str, Any]:
        metrics: dict[str, Any] = {"vetted_recall": vetted, "fp_rate": 0.0}
        if strong is not None:
            metrics["strong_recall"] = strong
        return {"metrics": metrics, "rows": [{"kind": "case", "id": "c1"}], "errors": [], "verdict": "PASS"}

    dropped = eval_bugs.diff_scorecards(card(0.5, 0.5), card(0.5, 0.25))
    assert dropped["verdict"] == "FAIL" and not dropped["strong_ok"]
    assert eval_bugs.diff_scorecards(card(0.5, 0.25), card(0.5, 0.5))["verdict"] == "PASS"
    old = eval_bugs.diff_scorecards(card(0.5, None), card(0.5, 0.0))  # a baseline from before the fix oracle
    assert old["verdict"] == "PASS" and old["base_strong_recall"] is None
