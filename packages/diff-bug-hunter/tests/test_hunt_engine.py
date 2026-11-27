# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Self-test for the /hunt and /verify skills.

/hunt: worktrees + merge-base, context builder, runner, vetting, mutation gate, large-diff prefilter, lessons, trusted
base-branch rules and RELIABILITY.md triggers. Fixtures are tiny git repos built from tests/hunt_fixtures/<name>/.
/verify: verify_ui.mjs against a local fixture server (pass, pageerror, HTTP 500, step cap, no screenshots)."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import build_requests
import ctx
import hunt_common
import lessons
import old_tests
import prefilter
import prepare
import pytest
import reliability
import run
import trusted
from conftest import (
    FIX,
    GIT_ENV,
    JESTDEPS,
    ROOT,
    SCRIPTS,
    SKILL,
    TOKEN,
    VERIFY_DEPS,
    VERIFY_UI,
    JsonHandler,
    _git,
    _module,
    _node_env,
    http_server,
    make_hunt,
    make_repo,
    needs_jest,
    needs_node,
    needs_playwright,
    run_frozen_spec,
)
from conftest import (
    overlay as _overlay,
)
from conftest import (
    wts_clean as _clean,
)

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


def test_pr_tests_diff_shows_the_prs_own_test_additions_with_head_line_numbers(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_bug")
    c = json.loads((hdir / "ctx.json").read_text())
    assert [d["file"] for d in c["pr_tests_diff"]] == ["calc/calc_test.go"]
    added = c["pr_tests_diff"][0]["added"]
    head = (Path(state["wt"]) / "calc/calc_test.go").read_text().split("\n")
    for row in added.split("\n"):
        n, text = row.split(": ", 1)
        assert head[int(n) - 1] == text  # line numbers point at the head file, so hunters can cite file:line
    assert "Clamp(5, 0, 10)" in added
    # Planters never see tests; hunters do, and the prompt tells Mode A how to use them.
    assert "pr_tests_diff" not in build_requests.mutant_user(c)
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    assert "lifted:" in build_requests.hunter_system("A", state, c)


def test_pr_tests_diff_is_capped_and_skips_other_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(ctx, "MAX_PR_TEST_LINES", 3)
    body = "package calc\n" + "".join(f"\nfunc TestX{i}(t *testing.T) {{}}\n" for i in range(5))
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/calc.go": _go_funcs(["One"]), "other/o_test.go": "package o\n"},
                  {"calc/calc.go": _go_funcs(["One"], "\treturn 2"), "calc/calc_test.go": body,
                   "other/o_test.go": "package o\n\n// changed\n"})
    assert [d["file"] for d in c["pr_tests_diff"]] == ["calc/calc_test.go"]
    assert len(c["pr_tests_diff"][0]["added"].split("\n")) == 3


def _ctx_from(tmp: Path, base: dict[str, str], head: dict[str, str], untracked: dict[str, str] | None = None) -> dict:
    """ctx.json for a two-commit repo (`base` files, then `head` edits); `untracked` files are dropped into the head
    worktree before the context is built."""
    repo = make_repo(tmp, base, head)
    wt, wt_base = tmp / "wt", tmp / "wt.base"
    mb = prepare.worktrees(repo, "feature", "master", wt, wt_base)
    for rel, body in (untracked or {}).items():
        (wt / rel).write_text(body)
    hdir = tmp / "hunt"
    prep = {"repo": str(repo), "wt": str(wt), "wt_base": str(wt_base), "merge_base": mb,
            "head": _git(repo, "rev-parse", "feature"), "hunt_dir": str(hdir)}
    ctx.build("1", 1, prep, {"title": "t", "body": ""})
    return json.loads((hdir / "ctx.json").read_text())


def _go_funcs(names: list[str], body: str = "\treturn 1") -> str:
    return "package calc\n" + "".join(f"\nfunc {n}() int {{\n{body}\n}}\n" for n in names)


def _picked(c: dict) -> list[tuple[str, str, str]]:
    return [(n["file"], n["symbol"], n["scope"]) for n in c["neighbors_same_file"]]


def test_neighbours_are_the_nearest_unchanged_functions_and_base_shows_the_old_body(tmp_path):
    src = _go_funcs(["One", "Two", "Three", "Four"])
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/calc.go": src},
                  {"calc/calc.go": src.replace("func Two() int {\n\treturn 1", "func Two() int {\n\treturn 22")})
    assert _picked(c) == [("calc/calc.go", "One", "same_file"), ("calc/calc.go", "Three", "same_file")]
    assert all(n["near"] == ["calc/calc.go"] for n in c["neighbors_same_file"])
    assert [b["symbol"] for b in c["changed_functions_base_source"]] == ["Two"]
    assert "return 1" in c["changed_functions_base_source"][0]["source"]


def test_a_new_file_takes_neighbours_only_from_tracked_unchanged_sources_in_its_directory(tmp_path):
    base = {"go.mod": "module x\n", "calc/aa_test.go": "package calc\n\nfunc helperT() int {\n\treturn 0\n}\n",
            "calc/ab_gen.go": "// Code generated by x. DO NOT EDIT.\npackage calc\n\nfunc Gen() int {\n\treturn 0\n}\n",
            "calc/also.go": _go_funcs(["Also"]), "calc/old.go": _go_funcs(["A", "B", "Z"])}
    head = {"calc/new.go": _go_funcs(["New"], "\treturn A() + B()"),
            "calc/also.go": _go_funcs(["Also"], "\treturn 4")}  # changed in the PR: never a neighbour
    c = _ctx_from(tmp_path, base, head, untracked={"calc/aaa_scratch.go": _go_funcs(["Untracked"])})
    # both changed files fall back to the same tracked sibling, which is listed once for both
    assert _picked(c) == [("calc/old.go", "A", "same_dir"), ("calc/old.go", "B", "same_dir")]
    assert all(sorted(n["near"]) == ["calc/also.go", "calc/new.go"] for n in c["neighbors_same_file"])
    assert "New" not in {b["symbol"] for b in c["changed_functions_base_source"]}  # no merge-base version exists


def test_a_tsx_component_with_nested_logic_falls_back_to_function_siblings(tmp_path):
    comp = "export default function Gallery({items}: Props) {\n    const n = items.length;\n    return n;\n}\n"
    util = ("export const LIMIT = 5;\n\nexport type Fn = () => void;\n\ninterface P {\n    a: string;\n}\n\n"
            "export function overloaded(a: string): string;\n"
            "export function overloaded(a: string) {\n    return a;\n}\n\n"
            "export const trimName = (s: string) => {\n    return s.trim();\n};\n\n"
            "export const CardList = ({\n    a,\n    b,\n    c,\n    d,\n    e,\n}: Props) => {\n    return a;\n};\n")
    c = _ctx_from(tmp_path, {"web/gallery.tsx": comp, "web/util.ts": util},
                  {"web/gallery.tsx": comp.replace("items.length", "items.length + 1")})
    assert _picked(c) == [("web/util.ts", "overloaded", "same_dir"), ("web/util.ts", "trimName", "same_dir")]
    assert [s for s, _, _ in ctx.top_blocks(util.split("\n"), "jest")] == ["overloaded", "trimName", "CardList"]
    assert [b["symbol"] for b in c["changed_functions_base_source"]] == ["Gallery"]


def test_top_blocks_handle_receivers_one_liners_repeats_and_anonymous_defaults():
    go = ("package s\n\nfunc (Cache) Get() int {\n\treturn 1\n}\n\nfunc (s *Store) Get() int { return 2 }\n\n"
          "type T struct {\n\ta int\n}\n\nfunc init() {\n}\n\nfunc init() {\n}\n")
    assert ctx.top_blocks(go.split("\n"), "go") == [("Cache.Get", 3, 5), ("Store.Get", 7, 7), ("init", 13, 14), ("init#2", 16, 17)]
    js = "export default function () {\n  return 1;\n}\n\nconst add = (a, b) => a + b;\nconst cfg = {a: 1};\n"
    assert ctx.top_blocks(js.split("\n"), "jest") == [("default", 1, 3), ("add", 5, 5)]


def test_block_ends_ignore_braces_and_slashes_inside_literals_and_parameter_types():
    go = ("package u\n\nfunc Fix(u string) string {\n\tif strings.HasPrefix(u, \"http://\") {\n\t\tu = u[7:]\n\t}\n"
          "\tb.WriteString(\"}\")\n\tswitch r {\n\tcase '}':\n\t}\n\treturn u\n}\n")
    assert ctx.top_blocks(go.split("\n"), "go") == [("Fix", 3, 12)]
    ts = ("export function f(\n    a: string,\n    opts: {\n        b: number;\n    },\n) {\n    const u = `${a}}`;\n"
          "    return a + opts.b;\n}\n\nexport function g(a: {x: string}): void;\nexport function g(a: {x: string}) {\n"
          "    return a.x;\n}\n")
    assert ctx.top_blocks(ts.split("\n"), "jest") == [("f", 1, 9), ("g", 12, 14)]


def test_block_ends_carry_multiline_literals_and_skip_js_regexes():
    go = ("package p\n\nfunc Payload(x string) string {\n\ts := `{\n\"text\": \"hi\"\n}`\n\ts = strings.TrimSpace(s)\n"
          "\treturn s\n}\n\nfunc Win(p string) string {\n\tif strings.HasSuffix(p, `\\`) {\n\t\tp = p[:len(p)-1]\n\t}\n"
          "\treturn p\n}\n")
    assert ctx.top_blocks(go.split("\n"), "go") == [("Payload", 3, 9), ("Win", 11, 16)]
    js = ("export function isUrl(u) {\n    if (/^https?:\\/\\//.test(u)) {\n        return true;\n    }\n    return false;\n}\n"
          "\nexport function strip(s) {\n    if (/[\"']/.test(s)) {\n        return s.slice(1);\n    }\n    return s;\n}\n"
          "\nexport function half(a, b) {\n    return a / b / 2;\n}\n"
          "\nexport function f(): {a: string};\nexport function f() {\n    return {a: ''};\n}\n"
          "\nexport const g = <T = () => void,>(x: T) => {\n    return x;\n};\n")
    assert ctx.top_blocks(js.split("\n"), "jest") == [("isUrl", 1, 6), ("strip", 8, 13), ("half", 15, 17),
                                                       ("f", 20, 22), ("g", 24, 26)]


def test_generated_markers_are_found_after_any_license_header():
    assert ctx.is_generated(["/*", "Copyright 2020 Foo", "*/", "// Code generated by x. DO NOT EDIT.", "package p"])
    assert ctx.is_generated([f"// line {i}" for i in range(30)] + ["// Code generated by x.", "package p"])
    assert not ctx.is_generated(["// Copyright", "", "package p", "// Code generated later is not a header"])


def test_ts_function_values_are_told_apart_from_other_constants():
    holds = ["const a = (x: number): number => x;", "const b = async ({id}: P) => id;", "const c = <T,>(x: T) => x;",
             "const d = function () {};", "const e = x => x;", "const f = React.memo(({a}: P) => a);",
             "export const getMyTeams: (s: GlobalState) => Team[] = createSelector('getMyTeams', getTeams, (t) => t);",
             "var legacy = function () {};"]
    plain = ["const win = (window as any).foo;", "const calc = (A + B) * 2;", "const el = <div/>;", "const n = 5;",
             "const doubled = [1, 2].map((x) => x * 2);", "const cfg = {a: () => 1};"]
    assert [ctx.ts_holds_function(d) for d in holds] == [True] * len(holds)
    assert not any(ctx.ts_holds_function(d) for d in plain)


def test_generated_siblings_are_never_neighbours(tmp_path):
    header = "// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.\n// See LICENSE.txt.\n\n"
    base = {"go.mod": "module x\n",
            "plugin/a_layer.go": header + "// Code generated by \"make pluginapi\"\n\npackage plugin\n\n"
                                 "func (h *hooksTimerLayer) OnActivate() error {\n\treturn nil\n}\n",
            "plugin/b_timer_layer_generated.go": "package plugin\n\nfunc Gen() int {\n\treturn 0\n}\n",
            "plugin/c.go": _go_funcs(["Real"])}
    c = _ctx_from(tmp_path, base, {"plugin/hooks.go": "package plugin\n\ntype Hooks interface {\n\tOnActivate() error\n}\n"})
    assert _picked(c) == [("plugin/c.go", "Real", "same_dir")]


def test_base_window_follows_a_pure_addition(tmp_path):
    body = "\n".join(f"\tx{i} := {i}" for i in range(200)) + "\n\treturn 0"
    src = "package calc\n\nfunc Long() int {\n" + body + "\n}\n"
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/calc.go": src},
                  {"calc/calc.go": src.replace("\tx150 := 150\n", "\tx150 := 150\n\tx150++\n")})
    old = c["changed_functions_base_source"][0]["source"]
    assert "x150 := 150" in old and "x10 := 10" not in old


def test_repeated_names_get_no_base_version_rather_than_a_wrong_one(tmp_path):
    src = "package calc\n\nfunc init() {\n\told()\n}\n"
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/calc.go": src},
                  {"calc/calc.go": "package calc\n\nfunc init() {\n\tnewer()\n}\n" + src[len("package calc\n"):]})
    assert c["changed_functions_base_source"] == []


def test_patch_lines_skip_context_and_headers_but_keep_plus_plus_content():
    patch = ("diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n@@ -3,4 +3,4 @@ function A() {\n ctx1\n-old\n+new\n ctx2\n"
             "@@ -20,4 +20,4 @@\n keep\n---count;\n+++count;\n keep2\n\\ No newline at end of file\n")
    pl = ctx.patch_lines(patch)
    assert (pl.added, pl.anchors, pl.removed, pl.inserted) == ({4, 21}, {4, 21}, {4, 21}, {5, 22})
    assert ctx.changed_lines(patch) == {4, 21}


def test_removing_a_whole_function_shows_its_base_body_and_leaves_the_next_one_a_neighbour(tmp_path):
    src = _go_funcs(["A", "B", "C"])
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/calc.go": src},
                  {"calc/calc.go": src.replace("\nfunc B() int {\n\treturn 1\n}\n", "")})
    assert [b["symbol"] for b in c["changed_functions_base_source"]] == ["B"]
    assert {n["symbol"] for n in c["neighbors_same_file"]} == {"A", "C"}


def test_a_change_past_line_1500_is_still_found(tmp_path):
    names = [f"F{i}" for i in range(500)]  # 4 lines each: ~2000 lines
    src = _go_funcs(names)
    c = _ctx_from(tmp_path, {"go.mod": "module x\n", "calc/big.go": src},
                  {"calc/big.go": src.replace("func F499() int {\n\treturn 1", "func F499() int {\n\treturn 9")})
    assert [b["symbol"] for b in c["changed_functions_base_source"]] == ["F499"]
    assert [n["symbol"] for n in c["neighbors_same_file"]] == ["F498", "F497"]


def test_long_functions_and_lines_are_clipped_around_the_change(tmp_path):
    body = "\n".join(f"\tx{i} := {i}" for i in range(200)) + "\n\treturn 0"
    long_line = "\tvar blob = \"" + "x" * 5000 + "\""
    base = {"go.mod": "module x\n", "calc/calc.go": "package calc\n\nfunc Long() int {\n" + body + "\n}\n",
            "calc/blob.go": "package calc\n\nfunc Blob() int {\n" + long_line + "\n\treturn 0\n}\n"}
    c = _ctx_from(tmp_path, base, {"calc/calc.go": base["calc/calc.go"].replace("x150 := 150", "x150 := -150")})
    old = c["changed_functions_base_source"][0]["source"]
    assert "x150 := 150" in old and "x10 := 10" not in old  # the window follows the change, not the function start
    blob = next(n for n in c["neighbors_same_file"] if n["symbol"] == "Blob")["source"]
    assert max(len(ln) for ln in blob.split("\n")) < ctx.MAX_LINE_CHARS + 20


def test_neighbours_never_follow_a_symlink_out_of_the_worktree(tmp_path):
    outside = tmp_path / "outside.go"
    outside.write_text(_go_funcs(["Secret"]))
    (tmp_path / "w" / "calc").mkdir(parents=True)
    (tmp_path / "w" / "calc" / "link.go").symlink_to(outside)
    assert ctx.read_source(tmp_path / "w" / "calc" / "link.go", tmp_path / "w") is None
    assert ctx.read_source(tmp_path / "w" / "calc" / "missing.go", tmp_path / "w") is None


def test_strategy_prompt_goes_to_first_pass_hunters_only(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, state = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "hunters")
    for mode in ("A", "B"):
        assert "S1 Sibling guards" in json.loads((hdir / mode / "request.json").read_text())["system"]
    c = json.loads((hdir / "ctx.json").read_text())
    assert "S1 Sibling guards" not in build_requests.hunter_system("A", state, c)  # strengthen and repair rounds
    assert "S1 Sibling guards" not in build_requests.mutant_system(state, 3, "M1, M2, M3")
    assert not {"neighbors_same_file", "changed_functions_base_source"} & set(build_requests.mutant_user(c))


# ------------------------------------------------------------------ fixture 1: known Go bug

def test_go_bug_fails_3_of_3_and_is_new_in_pr(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    assert run.cmd_run(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "NEW_PR_BUG"}
    assert not list(Path(state["wt"]).rglob("hunt_*")) and not list(Path(state["wt_base"]).rglob("hunt_*"))


# ------------------------------------------------------------------ fixture 2: known React bug

@needs_jest
def test_react_bug_fails_3_of_3_and_is_new_in_pr(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_bug")
    assert state["targets"] == [{"lang": "jest", "dir": "web/src", "path": "web/src/hunt_<mode>.test.tsx"}]
    assert run.cmd_run(hdir, state, "A", runs=3) == {"web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax": "NEW_PR_BUG"}


@needs_jest
def test_babel_compile_check(tmp_path):
    _, state = make_hunt(tmp_path, "react_bug")
    wt = Path(state["wt"])
    assert run.jest_compiles(wt, "web/src/counter.tsx") is None
    (wt / "web/src/counter.tsx").write_text("export const x = (;\n")
    assert run.jest_compiles(wt, "web/src/counter.tsx")


def _platform_tree(wt: Path) -> None:
    """webapp/channels has the jest config; webapp/platform/types (a package with no config) does not."""
    web = FIX / "react_bug" / "base" / "web"
    ch = wt / "webapp" / "channels"
    ch.mkdir(parents=True)
    for n in ("jest.config.js", "babel.config.js", "package.json"):
        shutil.copy(web / n, ch / n)
    pkg = wt / "webapp" / "platform" / "types"
    (pkg / "src").mkdir(parents=True)
    (pkg / "package.json").write_text('{"name": "@mattermost/types"}\n')


def test_jest_root_falls_back_to_channels_for_platform_packages(tmp_path):
    _platform_tree(tmp_path)
    rel = "webapp/platform/types/src/hunt_a.test.ts"
    root = run.jest_root(tmp_path, rel)
    assert root == (tmp_path / "webapp/channels").resolve()
    pkg = (tmp_path / "webapp/platform/types").resolve()
    assert run.jest_roots_args(tmp_path, rel, root) == ["--roots", str(root), "--roots", str(pkg)]
    # a test under the config's own rootDir keeps the default roots
    assert run.jest_roots_args(tmp_path, "webapp/channels/src/x.test.ts", root) == []
    # outside webapp/ there is no fallback
    (tmp_path / "other").mkdir()
    with pytest.raises(run.InfraError, match="no jest.config above other/x.test.ts"):
        run.jest_root(tmp_path, "other/x.test.ts")


@needs_jest
def test_jest_runs_a_platform_package_test_under_the_channels_config(tmp_path):
    _platform_tree(tmp_path)
    (tmp_path / "webapp/channels/node_modules").symlink_to(JESTDEPS)
    src = tmp_path / "webapp/platform/types/src"
    (src / "policy.ts").write_text("export const isEmpty = (rules: string[]) => rules.length === 0;\n")
    (src / "hunt_a.test.ts").write_text(
        "import {isEmpty} from './policy';\n"
        "test('HuntA_empty', () => { expect(isEmpty([])).toBe(true); });\n"
        "test('HuntA_wrong', () => { expect(isEmpty(['a'])).toBe(true); });\n")
    o = run.Outcome()
    run.jest_run(tmp_path, ["webapp/platform/types/src/hunt_a.test.ts"], "HuntA_", o)
    key = "webapp/platform/types/src/hunt_a.test.ts::"
    assert o.results == {key + "HuntA_empty": "PASS", key + "HuntA_wrong": "FAIL"}


# ------------------------------------------------------------------ fixture 3: clean control + mutation gate

def test_clean_control_has_no_findings_and_mutants_are_scored(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    assert set(run.cmd_run(hdir, state, "A").values()) == {"PASS"}
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M1"]["verdict"] == "KILLED" and v["M1"]["killers"] == ["calc::TestHuntA_PercentZeroTotal"]
    assert v["M2"]["verdict"] == "NEEDS_REGENERATION" and "totl" in v["M2"]["detail"]
    assert v["M3"]["verdict"] == "SURVIVED"
    assert v["M4"]["verdict"] == "KILLED" and v["M4"]["held_back"]
    assert v["M5"]["verdict"] == "NEEDS_REGENERATION" and "not one of the hunted files" in v["M5"]["detail"]
    assert "return part * 100 / total" in (Path(state["wt"]) / "calc/percent.go").read_text()  # restored


def test_regenerated_mutant_replaces_broken_one(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "R_M2").mkdir()
    (hdir / "R_M2" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M2", "file": "calc/percent.go", "old": "return part * 100 / total", "new": "return part * 10 / total",
         "what_breaks": "off by a factor of ten"}]}))
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M2"]["verdict"] == "KILLED"


def test_a_mutant_that_hangs_a_test_is_killed_at_the_baseline_derived_cap(tmp_path, monkeypatch):
    # Without the cap, go test's own 10-minute default decides, once per hanging mutant (PR 40094's app package).
    monkeypatch.setattr(run, "MUTANT_TIMEOUT_MIN_S", 5)
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M1", "file": "calc/percent.go", "old": "\t\treturn 0\n", "new": "\t\tfor {\n\t\t}\n",
         "what_breaks": "a zero total loops forever"}]}))
    shutil.rmtree(hdir / "M2")
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M1"]["verdict"] == "KILLED" and v["M1"]["killers"] == ["calc::(package failed)"]
    assert "\t\treturn 0\n" in (Path(state["wt"]) / "calc/percent.go").read_text()  # restored


def test_go_package_runtime_is_read_from_the_summary_line():
    assert run.go_package_runtime("--- PASS: TestX (1.20s)\nPASS\nok  \tgithub.com/x/app\t15.116s\n") == 15.116
    assert run.go_package_runtime("FAIL\tgithub.com/x/app\t2.5s\n") == 2.5
    assert run.go_package_runtime("FAIL\tgithub.com/x/app [build failed]\n") is None
    assert run.mutant_timeouts(run.Outcome(runtimes={"a": 0.1, "b": 40.0})) == {"a": run.MUTANT_TIMEOUT_MIN_S, "b": 200}


def test_zero_tests_is_infra_error_and_bad_test_is_compile_error(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    no_tests = "package calc\n\nimport \"testing\"\n\nfunc TestSomethingElse(t *testing.T) {}\n"
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go", "content": no_tests}]}))
    with pytest.raises(run.CompileError, match="no test named TestHuntB_"):  # a naming mistake goes to repair
        run.cmd_run(hdir, state, "B", runs=1)
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go",
                                                                      "content": "package calc\nfunc TestHuntB_X(t *T) {}\n"}]}))
    with pytest.raises(run.CompileError):
        run.cmd_run(hdir, state, "B", runs=1)


def test_place_refuses_paths_outside_hunt_files(tmp_path):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    for bad in ("calc/calc.go", "../escape/hunt_hunta_test.go", "other/hunt_hunta_test.go", "/etc/hunt_hunta_test.go"):
        with pytest.raises(run.CompileError):  # a model's path mistake goes to the repair round
            run.place(wt, [{"path": bad, "content": "x"}], {"calc"})


def test_pr_own_tests_score_mutants(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    (hdir / "M").mkdir()
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M1", "file": "calc/calc.go", "old": "return v\n", "new": "return v + 1\n", "what_breaks": "shifts values"}]}))
    v = run.cmd_mutants(hdir, state, "PR")
    assert v[0]["verdict"] == "KILLED" and v[0]["killers"] == ["calc::TestClampMiddle"]


# ------------------------------------------------------------------ Go fuzzing (on unless HUNT_FUZZ=0)

FUZZ_CLAMP = ("\nfunc huntCheckA_Clamp(t *testing.T, v, lo, hi int) {\n\tif hi < lo {\n\t\treturn\n\t}\n"
              "\tgot := Clamp(v, lo, hi)\n\tif got < lo || got > hi || (v >= lo && v <= hi && got != v) {\n"
              "\t\tt.Fatalf(\"Clamp(%d, %d, %d) = %d\", v, lo, hi, got)\n\t}\n}\n\n"
              "func FuzzHuntA_Clamp(f *testing.F) {\n\tf.Add(0, 0, 10)\n"
              "\tf.Fuzz(func(t *testing.T, v, lo, hi int) { huntCheckA_Clamp(t, v, lo, hi) })\n}\n")


def _add_to_response(hdir: Path, extra: str) -> None:
    resp = json.loads((hdir / "A" / "response.json").read_text())
    resp["files"][0]["content"] += extra
    (hdir / "A" / "response.json").write_text(json.dumps(resp))


def test_fuzz_is_off_only_when_hunt_fuzz_is_0(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_FUZZ", "0")
    hdir, state = make_hunt(tmp_path, "go_bug")
    with pytest.raises(hunt_common.InfraError, match="HUNT_FUZZ=0"):
        run.cmd_fuzz(hdir, state, "A")
    monkeypatch.delenv("HUNT_FUZZ")  # unset = on
    assert run.cmd_fuzz(hdir, state, "A")["targets"] == {}


def test_fuzz_failure_is_frozen_into_a_deterministic_test_that_is_vetted_like_any_other(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_FUZZ", "1")
    monkeypatch.setenv("HUNT_FUZZ_TIME", "30s")
    hdir, state = make_hunt(tmp_path, "go_bug")
    _add_to_response(hdir, FUZZ_CLAMP)
    rep = run.cmd_fuzz(hdir, state, "A")
    assert rep["targets"]["FuzzHuntA_Clamp"].startswith("FAIL frozen as TestHuntA_Clamp_Fuzz")
    frozen = rep["frozen"][0]
    wt = Path(state["wt"])
    assert not list(wt.rglob("hunt_*")) and not (wt / "calc" / "testdata").exists()
    run.ensure_clean(wt)  # the corpus the fuzzer wrote is gone
    assert (hdir / "A" / "response.prefuzz.json").exists()
    assert frozen in (hdir / "A" / "response.json").read_text()
    table = run.cmd_run(hdir, state, "A")
    assert table[f"calc::{frozen}"] == "FAIL_3_OF_3"
    assert run.cmd_base(hdir, state, "A")[f"calc::{frozen}"] == "NEW_PR_BUG"
    assert run.cmd_fuzz(hdir, state, "A")["targets"]["FuzzHuntA_Clamp"].startswith("SKIPPED already frozen")


def test_fuzz_skips_stateful_and_unfreezable_targets(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_FUZZ", "1")
    hdir, state = make_hunt(tmp_path, "go_bug")
    stateful = ("\nfunc huntCheckA_Store(t *testing.T, n int) {\n\tth := Setup(t)\n\t_ = th\n}\n\n"
                "func FuzzHuntA_Store(f *testing.F) {\n\tf.Fuzz(func(t *testing.T, n int) { huntCheckA_Store(t, n) })\n}\n"
                "\nfunc FuzzHuntA_NoHelper(f *testing.F) {\n\tf.Fuzz(func(t *testing.T, n int) {})\n}\n"
                "\nfunc Setup(t *testing.T) int { return 0 }\n")
    _add_to_response(hdir, stateful)
    rep = run.cmd_fuzz(hdir, state, "A")
    assert rep["targets"]["FuzzHuntA_Store"].startswith("SKIPPED stateful")
    assert rep["targets"]["FuzzHuntA_NoHelper"].startswith("SKIPPED no huntCheckA_NoHelper")
    assert rep["frozen"] == [] and not (hdir / "A" / "response.prefuzz.json").exists()


def test_fuzz_prompt_only_goes_to_mode_a_when_fuzzing_is_on(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, state = make_hunt(tmp_path, "go_bug")
    c = json.loads((hdir / "ctx.json").read_text())
    monkeypatch.setenv("HUNT_FUZZ", "0")
    assert "FuzzHuntA_" not in build_requests.hunter_system("A", state, c, strategies=True)
    monkeypatch.delenv("HUNT_FUZZ")  # the default is on
    assert "FuzzHuntA_" in build_requests.hunter_system("A", state, c, strategies=True)
    monkeypatch.setenv("HUNT_FUZZ", "1")
    assert "FuzzHuntA_" in build_requests.hunter_system("A", state, c, strategies=True)
    assert "FuzzHuntA_" not in build_requests.hunter_system("B", state, c, strategies=True)


def test_corpus_args_accept_plain_literals_only():
    assert run.corpus_args('go test fuzz v1\nint(5)\nstring("a\\x00")\n[]byte("x")\n') == \
        ["int(5)", 'string("a\\x00")', '[]byte("x")']
    assert run.corpus_args("go test fuzz v1\nfloat64(+Inf)\n") is None
    assert run.corpus_args("go test fuzz v1\nfloat64(math.Float64frombits(0x7ff8000000000001))\n") is None
    assert run.corpus_args("not a corpus\n") is None


# ------------------------------------------------------------------ changed-line coverage gate

CLAMP_ONLY = ("\nfunc TestHuntA_ClampOnly(t *testing.T) {\n\tif Clamp(5, 0, 3) != 3 {\n\t\tt.Fatal(\"clamp\")\n\t}\n}\n")


def test_cover_marks_a_test_that_never_reaches_the_change_vacuous(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    resp = json.loads((hdir / "A" / "response.json").read_text())
    resp["files"][0]["content"] += CLAMP_ONLY  # Clamp is unchanged base code; the PR only adds percent.go
    (hdir / "A" / "response.json").write_text(json.dumps(resp))
    assert set(run.cmd_run(hdir, state, "A", runs=1).values()) == {"PASS"}
    cov = run.cmd_cover(hdir, state, "A")
    t = cov["tests"]
    assert t["calc::TestHuntA_ClampOnly"]["verdict"] == "VACUOUS"
    assert t["calc::TestHuntA_PercentZeroTotal"]["verdict"] == "REACHES"
    assert 9 in t["calc::TestHuntA_PercentZeroTotal"]["hit"]["calc/percent.go"]  # `return 0` for a zero total
    # The fixture hunter draws part <= total only, so the cap branch is a real gap the strengthen round is told about.
    assert 0 < cov["reached"] < cov["executable"]
    src = (Path(state["wt"]) / "calc/percent.go").read_text().split("\n")
    assert any("return 100" in src[n - 1] for n in cov["unreached"]["calc/percent.go"])
    # comment and signature-only lines are not part of the denominator
    assert cov["executable"] < len(run.changed_lines_by_file(Path(state["wt"]), state["merge_base"],
                                                             state["changed"])["calc/percent.go"])
    assert json.loads((hdir / "run_A.coverage.json").read_text())["tests"] == t
    assert run.vacuous_tests(hdir, "A") == {"calc::TestHuntA_ClampOnly"}
    assert not list(Path(state["wt"]).rglob("hunt_*"))  # the coverage pass cleans up after itself


def test_strengthen_request_carries_unreached_lines_only_when_cover_ran(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "strengthen", "M3")
    user = json.loads(json.loads((hdir / "A2" / "request.json").read_text())["user"])
    assert "unreached_changed_lines" not in user and user["surviving_faults"]
    (hdir / "run_A.coverage.json").write_text(json.dumps({"tests": {}, "unreached": {"calc/percent.go": [12]}}))
    build_requests.main("1", "strengthen", "M3")
    req = json.loads((hdir / "A2" / "request.json").read_text())
    assert json.loads(req["user"])["unreached_changed_lines"] == {"calc/percent.go": [12]}
    assert "Reaching a line is not enough" in req["system"]


def test_cover_refuses_mode_b_and_stale_runs(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    with pytest.raises(hunt_common.InfraError, match="Mode A"):
        run.cmd_cover(hdir, state, "B")  # S3 differential tests stay off the changed lines on purpose
    with pytest.raises(hunt_common.InfraError, match="run `run.py run"):
        run.cmd_cover(hdir, state, "A")


def test_a_vacuous_test_kills_no_mutant_but_a_vacuous_head_failure_is_kept(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    run.cmd_run(hdir, state, "A", runs=1)
    cov = {"tests": {"calc::TestHuntA_PercentZeroTotal": {"verdict": "VACUOUS", "hit": {}, "head": "PASS"}},
           "reached": 0, "executable": 0, "unreached": {}}
    (hdir / "run_A.coverage.json").write_text(json.dumps(cov))
    v = {m["id"]: m for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M1"]["verdict"] == "SURVIVED"  # its only killer reached no changed line
    cov["tests"]["calc::TestHuntA_PercentZeroTotal"]["head"] = "FAIL_3_OF_3"
    (hdir / "run_A.coverage.json").write_text(json.dumps(cov))
    assert run.vacuous_tests(hdir, "A") == set()


def test_cover_table_never_drops_a_test_without_a_profile():
    changed = {"a.go": {3, 4, 5}}
    out = run.cover_table(changed, {"p::TestHuntA_Crash": None, "p::TestHuntA_Ok": {"a.go": ({3, 4, 9}, {4, 9})}})
    assert out["tests"]["p::TestHuntA_Crash"]["verdict"] == "UNKNOWN"
    assert out["tests"]["p::TestHuntA_Ok"] == {"verdict": "REACHES", "hit": {"a.go": [4]}}
    assert (out["reached"], out["executable"], out["unreached"]) == (1, 2, {"a.go": [3]})


def test_go_profile_lines_match_by_path_below_the_module_root():
    prof = ("mode: set\nexample.com/fx/calc/percent.go:7.36,8.16 1 1\nexample.com/fx/calc/percent.go:11.2,11.27 1 0\n"
            "example.com/fx/other/percent.go:7.1,9.2 1 1\n")
    assert run.go_profile_lines(prof, "calc/percent.go") == ({7, 8, 11}, {7, 8})


@needs_jest
def test_cover_measures_a_jest_test(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_bug")
    run.cmd_run(hdir, state, "A", runs=1)
    cov = run.cmd_cover(hdir, state, "A")
    t = cov["tests"]["web/src/hunt_a.test.tsx::HuntA HuntA_neverExceedsMax"]
    assert t["verdict"] == "REACHES" and t["head"] == "FAIL_3_OF_3"
    assert cov["executable"] > 0


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
    assert path.read_text() == before and first["id"].startswith("L-")  # uuid ids
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
    assert len(reliability.parse(trusted.read("RELIABILITY.md", skill))) == 11
    with pytest.raises(trusted.InfraError, match="RELIABILITY.md"):
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
    with pytest.raises(trusted.InfraError, match="LOCAL.md"):
        trusted.read("LOCAL.md", skill)  # an untracked file in a tracked skill is never read, nor silently dropped
    assert trusted.read("NOT_ANYWHERE.md", skill) == ""
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
    assert [r.id for r in rules] == [f"R{i:02d}" for i in range(1, 12)]
    ids = lambda c: [r.id for r in reliability.match(c, rules)]  # noqa: E731
    assert ids(_ctx(["server/channels/app/platform/config.go"], "+\tps.regenerateClientConfig()")) == ["R03"]
    assert ids(_ctx(["webapp/channels/src/selectors/views/foo.ts"], "+export const getX = createSelector(")) == ["R10"]
    assert "R08" in ids(_ctx(["server/public/model/x.go"], "+\tgo func() {"))
    assert ids(_ctx(["server/public/model/x.go"], "+\tx := 1")) == []  # R08 is diff-triggered only
    assert ids(_ctx(["server/channels/db/migrations/postgres/000150_x.up.sql"], "+ALTER TABLE Posts")) == ["R07"]
    assert ids(_ctx(["server/public/model/x.go"], "-\tgo func() {")) == ["R08"]  # removed lines count too
    assert ids(_ctx(["README.md"], "-\tgo func() {")) == []  # R08 is Go-only (lang: go)
    assert ids(_ctx(["webapp/channels/src/foo.ts"], "-\tgo func() {")) == []
    assert ids(_ctx(["server/channels/app/property_field.go"],
                    "+\tif dropsOptions(f, existingByID[f.ID], updatedByID[f.ID]) {\n+\t\ta.refreshAttributeViews(rctx)\n")) == ["R11"]
    assert ids(_ctx(["server/channels/api4/properties.go"],
                    "+\tfield, err := c.App.GetPropertyField(RequestContextWithMaster(rctx), id)")) == ["R11"]


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
    "/droppage": """<html><body><main><p>d</p></main><script>fetch('/api/v4/drop').catch(() => {});</script></body></html>""",
    "/late500": """<html><body><main><p id="s">wait</p></main><script>
setTimeout(() => { document.getElementById('s').textContent = 'done'; fetch('/api/v4/slow500'); }, 400);</script></body></html>""",
    "/xfetch": """<html><body><main><p>x</p></main><script>
fetch('http://localhost:' + location.port + '/api/v4/users/me').catch(() => {});</script></body></html>""",
    "/link": """<html><body><main><a href="http://localhost:PORT/x">away</a></main></body></html>""",
    "/redirpage": """<html><body><main><p id="o">r</p></main><script>
fetch('/redir').then((r) => { document.getElementById('o').textContent = 'redirected:' + r.redirected; },
                     () => { document.getElementById('o').textContent = 'fetch failed'; });</script></body></html>""",
    "/spa3": """<html><body><main><p id="s">start</p><button onclick="go()">Go</button></main><script>
function go() { fetch('/api/v4/slow500');
  setTimeout(() => { history.pushState({}, '', '/moved'); document.getElementById('s').textContent = 'moved'; }, 100); }
</script></body></html>""",
    "/cancel": """<html><body><main><button onclick="fetch('/api/v4/slow'); location.href = '/ok';">Go</button></main></body></html>""",
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
    "/drag": """<html><body><main><div id="handle" style="width:40px;height:40px;background:#ccc">Drag</div>
<button onclick="document.getElementById('handle')?.remove()">Unmount</button><p id="state">idle</p></main>
<script>
let startX = null;
const log = [];
const upd = (s) => { log.push(s); document.getElementById('state').textContent = log.join(','); };
document.getElementById('handle').addEventListener('mousedown', (e) => { startX = e.clientX; upd('down'); });
window.addEventListener('mousemove', (e) => { if (startX !== null && Math.abs(e.clientX - startX) >= 30) { upd('dragged'); startX = null; } });
window.addEventListener('mouseup', () => upd('up'));
</script></body></html>""",
    "/dup": """<html><body><main><button onclick="document.getElementById('r').textContent='first'">Submit</button>
<button onclick="document.getElementById('r').textContent='second'">Submit</button><p id="r">none</p></main></body></html>""",
    "/diag": """<html><body><main><p id="m">ready</p></main><script>
console.error('boom-console');
fetch('/api/v4/missing404');
</script></body></html>""",
}

USER_ID = "uid1"
SEEN: list[tuple[str, str, str | None]] = []  # (Host, path, Authorization) of every request the fixture server saw


class _Handler(JsonHandler):
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
        elif self.path == "/api/v4/drop":
            self.close_connection = True
            self.connection.shutdown(2)  # hang up without a response
        elif self.path == "/api/v4/slow500":
            import time
            time.sleep(0.3)
            self._send(500, '{"id": "late"}')
        elif self.path == "/off":
            port = self.server.server_address[1]
            self._send(302, "", "text/plain", headers={"Location": f"http://localhost:{port}/landing"})
        elif self.path == "/landing":
            self._send(200, "<html><body><main><p>landing</p></main></body></html>", "text/html")
        elif self.path == "/redir":
            port = self.server.server_address[1]
            self._send(302, "", "text/plain", headers={"Location": f"http://localhost:{port}/asset.js"})
        elif self.path == "/asset.js":
            self._send(200, "document.title = 'asset loaded';", "application/javascript",
                       headers={"Access-Control-Allow-Origin": "*"})
        elif self.path == "/link":
            port = str(self.server.server_address[1])
            self._send(200, PAGES["/link"].replace("PORT", port), "text/html")
        elif self.path == "/api/v4/redirme":
            port = self.server.server_address[1]
            self._send(302, "", "text/plain", headers={"Location": f"http://localhost:{port}/api/v4/users/me"})
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
        elif self.path == "/api/v4/things/item42":
            authed = self._auth() is not None
            title = getattr(self.server, "things", {}).get("item42", "")
            self._send(200 if authed else 401, json.dumps({"id": "item42", "title": title}))
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
            parsed = json.loads(body or b"{}")
            self._send(201 if self._auth() else 401, json.dumps({"id": "item42", "title": parsed.get("title", "")}))
        elif self.path == "/api/v4/unsafe":
            self._send(200, json.dumps({"id": "../evil"}))
        else:
            self._send(404, "{}")

    def do_PATCH(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/v4/things/item42":
            parsed = json.loads(body or b"{}")
            if not hasattr(self.server, "things"):
                self.server.things = {}
            title = parsed.get("title", "") if isinstance(parsed, dict) else parsed
            if self._auth():
                self.server.things["item42"] = title
            self._send(200 if self._auth() else 401, json.dumps({"id": "item42", "title": title, "patched": True}))
        else:
            self._send(404, "{}")

    def do_DELETE(self):
        if self.path == "/api/v4/things/item42":
            self._send(200 if self._auth() else 401, json.dumps({"status": "OK"}))
        else:
            self._send(404, "{}")


@pytest.fixture
def ui_server():
    with http_server(_Handler) as (_, url):
        yield url


def verify(tmp: Path, plan: dict, *extra: str, auth: str = "password", env: dict | None = None) -> tuple[int, str]:
    (tmp / "plan.json").write_text(json.dumps(plan))
    # credentials only go to VERIFY_BASE_URL, so point it at the plan's server unless a test says otherwise
    target = {"VERIFY_BASE_URL": plan["base_url"]} if "base_url" in plan else {}
    p = subprocess.run(["node", str(VERIFY_UI), "plan.json", *extra], cwd=tmp,
                       env={**_node_env(auth), **target, **(env or {})},
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
                      ({"steps": [{"screenshot": "x.png"}], "expect": [{"visible": {"role": "main"}}]}, "needs exactly one of goto"),
                      ({"steps": [{"goto": "/ok"}]}, "at least one deterministic"),
                      ({"steps": [], "expect": [{"api": {"path": "/etc/passwd"}}]}, "must be a path under /api/v4/")]:
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
    assert code == 2 and "goto must be a path" in out, out


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
    p = run_frozen_spec(tmp_path, "frozen.spec.ts", env={"MM_URL": ui_server})
    assert p is not None and p.returncode == 0 and "1 passed" in p.stdout, p.stdout + p.stderr
    # the frozen test keeps the oracle: the same flow against a broken page fails without any model involved
    (tmp_path / "frozen.spec.ts").write_text(spec.replace('"/ok"', '"/boom"').replace('"Save"', '"Boom"'))
    p = run_frozen_spec(tmp_path, "frozen.spec.ts", env={"MM_URL": ui_server})
    assert p is not None and p.returncode != 0 and "kaboom" in p.stdout + p.stderr, p.stdout + p.stderr


# ------------------------------------------------------------------ installer

def test_install_skill_links_both_skills_and_refuses_to_clobber(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    _git(target, "init", "-q")
    script = ROOT / "scripts" / "install-skill.sh"
    p = subprocess.run(["bash", str(script), str(target)], capture_output=True, text=True, check=False, env=GIT_ENV)
    assert p.returncode == 0, p.stdout + p.stderr
    for name in ("hunt", "verify"):
        link = target / ".claude" / "skills" / name
        assert link.is_symlink() and (link / "SKILL.md").exists()
    exclude = (target / ".git" / "info" / "exclude").read_text()
    assert "/.claude/skills/hunt" in exclude and "/.claude/skills/verify" in exclude
    assert _git(target, "status", "--porcelain") == ""  # symlinks are local-only
    p = subprocess.run(["bash", str(script), "--copy", "--skill", "verify", str(target)], capture_output=True, text=True,
                       check=False, env=GIT_ENV)
    assert p.returncode == 1 and "--force" in p.stderr
    p = subprocess.run(["bash", str(script), "--copy", "--force", "--skill", "verify", str(target)], capture_output=True,
                       text=True, check=False, env=GIT_ENV)
    copied = target / ".claude" / "skills" / "verify"
    assert p.returncode == 0 and not copied.is_symlink() and (copied / "scripts" / "verify_ui.mjs").exists()
    # the vendored copy is no longer git-ignored, and re-running the same copy is a no-op
    assert ".claude/" in _git(target, "status", "--porcelain", "--untracked-files=all")
    p = subprocess.run(["bash", str(script), "--copy", "--skill", "verify", str(target)], capture_output=True, text=True,
                       check=False, env=GIT_ENV)
    assert p.returncode == 0 and "identical copy" in p.stdout, p.stdout + p.stderr
    # link mode restores a missing exclude entry on re-run
    (target / ".git" / "info" / "exclude").write_text("")
    p = subprocess.run(["bash", str(script), "--skill", "hunt", str(target)], capture_output=True, text=True,
                       check=False, env=GIT_ENV)
    assert p.returncode == 0 and "/.claude/skills/hunt" in (target / ".git" / "info" / "exclude").read_text()


def test_install_skill_reports_failures_instead_of_success(tmp_path):
    target = tmp_path / "target"
    (target / ".claude").mkdir(parents=True)
    _git(target, "init", "-q")
    (target / ".claude" / "skills").write_text("not a directory")
    script = ROOT / "scripts" / "install-skill.sh"
    for args in ([str(target)], ["--copy", str(target)]):
        p = subprocess.run(["bash", str(script), *args], capture_output=True, text=True, check=False, env=GIT_ENV)
        assert p.returncode == 1 and "install failed" in p.stderr and "start Claude Code" not in p.stdout, p.stdout


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
    assert "async function apiLogin(context, base, env)" in spec and "await apiLogin(context, BASE, process.env)" in spec
    assert "getByLabel(" not in spec and ".fill(" not in spec  # no login form steps
    for auth, ok in (("token", True), ("none", False)):
        p = run_frozen_spec(tmp_path, "frozen.spec.ts", auth=auth, env={"VERIFY_BASE_URL": ui_server})
        assert p is not None and (p.returncode == 0) == ok, (auth, p.stdout + p.stderr)
    assert p is not None and "set VERIFY_TOKEN or VERIFY_USER + VERIFY_PASSWORD" in p.stdout + p.stderr


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
    # deleted paths still reach path-triggered rules
    assert {"calc/old.go", "calc/moved.go"} <= set(json.loads((hdir / "ctx.json").read_text())["all_changed_files"])


def test_place_writes_nothing_when_any_path_is_rejected(tmp_path):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    files = [{"path": "calc/hunt_hunta_test.go", "content": "x"}, {"path": "calc/evil.go", "content": "y"}]
    with pytest.raises(run.CompileError):
        run.place(wt, files, {"calc"})
    assert not list(wt.rglob("*.go"))


@needs_playwright
def test_verify_never_passes_on_server_errors_or_unsettled_requests(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [],
                                  "expect": [{"api": {"path": "/api/v4/broken", "status": 500}}]})
    assert code == 2 and "a server error always fails" in out, out
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
    # TestMain, receivers and benchmarks are not runnable by -run: never selected (Bugbot on 97b48b4)
    other = ("package calc\n\nfunc TestMain(m *testing.M) {\n\tm.Run()\n}\n\n"
             "func (s *suite) TestThing(t *testing.T) {\n\tx := 1\n}\n\nfunc TestReal(t *testing.T) {\n\ty := 1\n}\n")
    edits = "@@ -4,1 +4,1 @@\n-\tm.Run() \n+\tm.Run()\n@@ -8,1 +8,1 @@\n-\tx := 0\n+\tx := 1\n@@ -12,1 +12,1 @@\n-\ty := 0\n+\ty := 1\n"
    assert ctx.changed_go_tests(edits, other) == ["TestReal"]


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
    assert code == 0 and "token auth as tester (Bearer header on same-origin API calls only)" in out, out
    assert [a for host, path, a in SEEN if path == "/asset.js"] == [None], SEEN  # the other origin never sees it
    assert [a for host, path, a in SEEN if path == "/xorigin"] == [None], SEEN  # pages need no token
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


@needs_playwright
def test_token_never_follows_a_redirect_to_another_origin(tmp_path, ui_server):
    SEEN.clear()
    other = ui_server.replace("127.0.0.1", "localhost")
    code, out = verify(tmp_path, {"base_url": ui_server, "allow_origins": [other], "steps": [{"goto": "/redirpage"}],
                                  "expect": [{"text": {"css": "#o"}, "contains": "redirected:true"}]}, auth="token")
    assert code == 0, out  # the page saw the 302 itself: the token route did not follow it with the token attached
    redirect = [a for host, path, a in SEEN if path == "/redir"]
    asset = [a for host, path, a in SEEN if path == "/asset.js"]
    assert redirect == [f"Bearer {TOKEN}"] and asset == [None], SEEN


def test_pr_own_go_tests_run_only_in_their_own_package():
    state = {"targets": [{"lang": "go", "dir": "a"}, {"lang": "go", "dir": "b"}],
             "own_tests": {"go": ["TestX"], "go_by_dir": {"a": ["TestX"]}, "jest": []}}
    assert run.suite_for("PR", state, [], Path(".")).go_patterns == {"a": "^(TestX)$"}


def test_mutant_that_only_breaks_package_teardown_is_killed(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    teardown = ("package calc\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\n"
                "func TestMain(m *testing.M) {\n\tcode := m.Run()\n\tif Percent(0, 0) != 0 {\n\t\tos.Exit(1)\n\t}\n\tos.Exit(code)\n}\n\n"
                "func TestHuntA_Full(t *testing.T) {\n\tif Percent(5, 5) != 100 {\n\t\tt.Fatal(Percent(5, 5))\n\t}\n}\n")
    (hdir / "A" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_hunta_test.go", "content": teardown}]}))
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M1", "file": "calc/percent.go", "old": "\t\treturn 0\n", "new": "\t\treturn 1\n", "what_breaks": "zero total"}]}))
    (hdir / "M2" / "response.json").unlink()
    v = run.cmd_mutants(hdir, state, "A")
    assert v[0]["verdict"] == "KILLED" and v[0]["killers"] == ["calc::(package failed)"], v



def test_lessons_only_edit_does_not_block_the_trust_gate(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    _git(repo, "checkout", "-q", "main")
    with (skill / "lessons.jsonl").open("a") as fh:  # what `lessons.py add` does
        fh.write(json.dumps({"pattern": "new"}) + "\n")
    assert "trusted ref" in trusted.check(skill)
    assert '"new"' not in trusted.read("lessons.jsonl", skill)  # hunters still get the base copy


def test_deleted_and_recreated_lessons_fail_closed(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    _git(repo, "rm", "-q", str(skill / "lessons.jsonl"))
    _git(repo, "commit", "-qm", "PR deletes the lessons")
    (skill / "lessons.jsonl").write_text(json.dumps({"pattern": "planted"}) + "\n")  # untracked replacement
    _git(repo, "checkout", "-q", "main", "--", str(skill / "RELIABILITY.md"))  # only the lessons differ now
    _git(repo, "commit", "-qam", "restore the rules")
    with pytest.raises(trusted.InfraError, match="lessons.jsonl"):
        trusted.check(skill)
    text = trusted.read("lessons.jsonl", skill)
    assert "planted" not in text and "Setup(t) stale client config" in text  # the base copy, never the disk


# ------------------------------------------------------------------ runner robustness (self-review)

def test_go_panic_before_any_result_line_is_a_failure_not_infra(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    panics = ("package calc\n\nimport \"testing\"\n\nfunc TestHuntB_Boom(t *testing.T) {\n"
              "\tdone := make(chan bool)\n\tgo func() { panic(\"boom\") }()\n\t<-done\n}\n")
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go", "content": panics}]}))
    assert run.cmd_run(hdir, state, "B", runs=1) == {"calc::(package failed)": "FAIL_3_OF_3"}


def test_runner_refuses_a_dirty_worktree_and_prepare_cleans_it(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    wt = Path(state["wt"])
    (wt / "calc" / "percent.go").write_text("package calc\n")  # an interrupted mutant
    with pytest.raises(run.InfraError, match="leftover changes"):
        run.cmd_run(hdir, state, "A", runs=1)
    prepare.worktrees(Path(state["repo"]), "feature", "master", wt, Path(state["wt_base"]))
    assert "return part * 100 / total" in (wt / "calc" / "percent.go").read_text()
    assert set(run.cmd_run(hdir, state, "A", runs=1).values()) == {"PASS"}


def test_empty_hunter_response_and_pr_without_tests_are_not_infra_errors(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": []}))
    assert run.cmd_run(hdir, state, "B") == {}
    state["own_tests"] = {"go": [], "go_by_dir": {}, "jest": []}
    v = run.cmd_mutants(hdir, state, "PR")
    assert {m["verdict"] for m in v} == {"SURVIVED"} and v[0]["detail"] == "no tests to score"


def test_base_verdicts_only_for_head_failures_and_missing_symbols():
    head = {"x::T1": "FAIL_3_OF_3", "x::T2": "PASS", "x::T3": "FAIL_3_OF_3", "x::T4": "FAIL_3_OF_3"}
    msgs = {"x::T3": "Error: expect(received).toBe(expected)", "x::T4": "Error: boom"}
    assert run.base_verdict("x::T1", "PASS", head, msgs, "") == "NEW_PR_BUG"
    assert run.base_verdict("x::T2", "PASS", head, msgs, "") == "NOT_A_HEAD_FAILURE"
    assert run.base_verdict("x::T3", "FAIL", head, msgs, "TypeError: (0 , _x.newHelper) is not a function") == "NEW_API"
    assert run.base_verdict("x::T3", "FAIL", head, msgs, msgs["x::T3"]) == "PRE_EXISTING"
    assert run.base_verdict("x::T4", "FAIL", head, msgs, "Error: other") == "BASE_FAILS_DIFFERENTLY"
    assert run.base_verdict("x::T3", "FAIL", head, msgs, "TypeError: Cannot read properties of undefined (reading 'x')") == "BASE_FAILS_DIFFERENTLY"
    assert run.classify(["SKIP"] * 3) == "SKIP"


def test_a_second_runner_on_the_same_pr_is_refused(tmp_path, monkeypatch):
    import fcntl
    hdir = tmp_path / "hunt1"
    hdir.mkdir()
    (hdir / "state.json").write_text("{}")
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    with (hdir / ".lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert run.main(["run.py", "run", "1", "A"]) == 2


def test_load_json_repairs_lone_backslashes_but_keeps_valid_escapes(tmp_path):
    p = tmp_path / "r.json"
    p.write_text(r'{"a": "x\d y\\s \n \u00e9"}')
    assert hunt_common.load_json(p) == {"a": "x\\d y\\s \n é"}


def test_go_test_selection_handles_one_line_bodies_and_any_testing_qualifier():
    head = ("package calc\n\nfunc TestA(t *testing.T) {}\n\nfunc helper() {\n\tx := 1\n}\n\n"
            "func TestB(*testing.T) {\n\ty := 1\n}\n\nfunc TestC(t *tt.T) {\n\tz := 1\n}\n")
    helper_edit = "@@ -6,1 +6,1 @@\n-\tx := 0\n+\tx := 1\n"
    assert ctx.changed_go_tests(helper_edit, head) == []  # the one-line TestA does not swallow helper()
    body_edits = "@@ -10,1 +10,1 @@\n-\ty := 0\n+\ty := 1\n@@ -14,1 +14,1 @@\n-\tz := 0\n+\tz := 1\n"
    assert ctx.changed_go_tests(body_edits, head) == ["TestB", "TestC"]


def test_non_ascii_paths_are_not_quoted(tmp_path):
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "café.go").write_text("package x\n")
    _git(repo, "add", "-A")
    assert hunt_common.git(repo, "diff", "--cached", "--name-only") == "café.go"


def test_regen_and_repair_requests(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, state = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    run.cmd_mutants(hdir, state, "A")  # writes mutants_A.json, where M2 does not compile
    build_requests.main("1", "regen", "M2", "A")
    req = json.loads((hdir / "R_M2" / "request.json").read_text())
    assert "totl" in req["user"]
    (hdir / "compile_A.log").write_text("calc/hunt_hunta_test.go:3: undefined: Nope")
    build_requests.main("1", "repair", "A")
    rep = json.loads((hdir / "A" / "request.repair.json").read_text())
    assert rep["response_path"].endswith("A/response.json") and "undefined: Nope" in rep["user"]
    assert (hdir / "A" / "response.prev.json").exists()
    assert "undefined: Nope" in (hdir / "A" / "request.repair.md").read_text()  # the agent's readable copy


def test_every_request_has_a_readable_text_copy_with_real_line_breaks(tmp_path, monkeypatch):
    # PR 40176: the whole user message sat on one 198 KB line of request.json, the hunter's file reader could not
    # page through it, and Hunter A wrote nothing.
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "hunters")
    req = json.loads((hdir / "A" / "request.json").read_text())
    text = (hdir / "A" / "request.md").read_text()
    assert max(len(line) for line in text.splitlines()) <= 2000
    assert req["system"] in text and req["response_path"] in text and '"required"' in text
    lines = text.splitlines()
    # the diff and the numbered head source arrive line by line, as the agent must read them
    assert "+func Percent(part, total int) int {" in lines
    assert "    7  func Percent(part, total int) int {" in lines
    assert "## diff_production_code" in lines and "## changed_files_head_source" in lines


def test_text_rendering_keeps_every_value_and_fences_code_safely():
    out = build_requests.render_text({"a": "x\ny", "b": [{"c": 1}, "z"], "d": "has ``` inside\nok", "e": None})
    lines = out.splitlines()
    assert "x" in lines and "y" in lines and "z" in out and "1" in out and "null" in out
    assert "````" in out  # a fence longer than any backtick run inside the value
    assert build_requests.render_text("x" * 5000).count("\n") >= 2  # one long line is wrapped, never cut



# ------------------------------------------------------------------ /verify hardening (self-review)


@needs_playwright
def test_verify_strict_plan_validation_exits_2(tmp_path, ui_server):
    bad = [
        ({"steps": [None], "expect": [{"visible": {"role": "main"}}]}, "step 1 must be an object"),
        ({"base_url": "localhost:18765", "steps": [], "expect": [{"visible": {"role": "main"}}]}, "must be http or https"),
        ({"steps": [], "allow_origins": ["cdn.example.com"], "expect": [{"visible": {"role": "main"}}]}, "not an absolute URL"),
        ({"steps": [], "expect": [{"visible": {"rol": "button"}}]}, "locator needs exactly one of"),
        ({"steps": [], "expect": [{"visible": {"role": "button", "nmae": "Save"}}]}, "unknown locator key(s) nmae"),
        ({"steps": [], "expect": [{"visible": {"role": ""}}]}, "role must be a non-empty string"),
        ({"steps": [{"goto": "/ok", "click": {"role": "button"}}], "expect": [{"visible": {"role": "main"}}]}, "needs exactly one of"),
        ({"steps": [], "expect": [{"text": {"role": "main"}}]}, 'needs a non-empty "contains"'),
        ({"steps": [], "expect": [{"count": {"role": "button"}, "min": 0}]}, "min must be an integer >= 1"),
        ({"steps": [], "expect": [{"visible": {"role": "main", "nth": "1"}}]}, "nth must be an integer"),
        ({"steps": [{"goto": "javascript:alert(1)"}], "expect": [{"visible": {"role": "main"}}]}, "goto must be a path"),
        ({"steps": [{"goto": "//evil.example/x"}], "expect": [{"visible": {"role": "main"}}]}, "goto must be a path"),
        ({"steps": [{"goto": "http://127.0.0.1:1/ok"}], "expect": [{"visible": {"role": "main"}}]}, "goto must be a path"),
        ({"base_url": "http://user:pw@127.0.0.1:1", "steps": [], "expect": [{"visible": {"role": "main"}}]},
         "must not contain user:password"),
        ({"steps": [], "expect": [{"visible": {"role": "main"}}], "extra": 1}, "unknown plan key(s) extra"),
    ]
    for plan, msg in bad:
        # the environment points at the real server, so only the plan's own mistakes can be reported
        code, out = verify(tmp_path, {"base_url": ui_server, **plan} if "base_url" not in plan else plan, auth="none",
                           env={"VERIFY_BASE_URL": ui_server})
        assert code == 2 and "INVALID_PLAN" in out and msg in out, (plan, out)


@needs_playwright
def test_verify_credentials_only_go_to_the_configured_server(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [], "expect": [{"visible": {"role": "main"}}]},
                       env={"VERIFY_BASE_URL": "http://127.0.0.1:9"})
    assert code == 2 and "credentials only go to VERIFY_BASE_URL" in out, out


@needs_playwright
def test_verify_infra_errors_exit_2(tmp_path, ui_server):
    plan = {"base_url": ui_server, "steps": [{"goto": "/ok"}], "expect": [{"visible": {"role": "main"}}]}
    code, out = verify(tmp_path, plan, auth="none", env={"VERIFY_SETTLE_MS": "abc"})
    assert code == 2 and "VERIFY_SETTLE_MS must be a positive number" in out, out
    code, out = verify(tmp_path, plan, "--freeze", "/nonexistent/dir/x.spec.ts", auth="none")
    assert code == 2 and "INFRA_ERROR cannot write /nonexistent/dir/x.spec.ts" in out and "VERDICT: PASS" not in out, out


@needs_playwright
def test_verify_fails_on_events_after_the_last_check(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/late500"}],
                                  "expect": [{"text": {"css": "#s"}, "contains": "done"}]}, auth="none")
    assert code == 1 and "after the checks: HTTP 500 from GET /api/v4/slow500" in out, out


@needs_playwright
def test_verify_fails_when_a_redirect_leaves_the_allowed_origins(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/off"}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="none")
    assert code == 1 and "redirected to a non-allowed origin" in out, out


@needs_playwright
def test_verify_blocked_origins_are_logged_on_fail_too(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/external"}],
                                  "expect": [{"text": {"role": "main"}, "contains": "nope"}]}, auth="none")
    assert code == 1 and "blocked other origins: http://blocked.invalid" in out, out


@needs_playwright
def test_token_route_survives_a_dropped_connection_without_leaking_the_token(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/droppage"}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="token")
    assert "VERDICT:" in out and TOKEN not in out and code in (0, 1), out


@needs_playwright
def test_frozen_spec_keeps_errors_free_of_the_token(tmp_path, ui_server):
    plan = {"base_url": ui_server, "login": True, "steps": [{"goto": "/whoami"}],
            "expect": [{"api": {"path": "/api/v4/users/me", "json_has": {"username": "tester"}}}]}
    code, out = verify(tmp_path, plan, "--freeze", "frozen.spec.ts", auth="token")
    assert code == 0, out
    p = run_frozen_spec(tmp_path, "frozen.spec.ts", auth="token", env={"VERIFY_REPLAY_BASE_URL": "http://127.0.0.1:9"})
    assert p is not None and p.returncode != 0 and "ECONNREFUSED" in p.stdout + p.stderr and TOKEN not in p.stdout + p.stderr


@needs_playwright
def test_frozen_spec_type_checks_strictly(tmp_path, ui_server):
    plan = {"name": "typed", "base_url": ui_server, "login": True, "allow_origins": [ui_server.replace("127.0.0.1", "localhost")],
            "steps": [{"goto": "/ok"}, {"click": {"role": "button", "name": "Save"}}],
            "expect": [{"visible": {"text": "saved", "nth": 0}}, {"text": {"role": "list"}, "contains": "saved"},
                       {"count": {"role": "listitem"}, "min": 1},
                       {"api": {"path": "/api/v4/users/me", "status": 200, "json_has": {"username": "tester"}}}]}
    code, out = verify(tmp_path, plan, "--freeze", "typed.spec.ts", auth="token")
    assert code == 0, out
    # the test timeout covers the plan at its limits: 2 steps and 4 expectations
    assert "test.setTimeout(60000 + 2 * (TIMEOUT + SETTLE_MS) + 4 * TIMEOUT + SETTLE_MS);" in (tmp_path / "typed.spec.ts").read_text()
    run_frozen_spec(tmp_path, "typed.spec.ts", check_tsc=True, run_test=False)


@needs_node
def test_json_has_matches_like_to_match_object():
    assert _module("[m.subset({roles: ['a']}, {roles: ['a', 'b']}), m.subset({a: {b: 1}}, {a: {b: 1, c: 2}}),"
                   " m.subset({x: [1]}, {x: [1]}), m.subset({x: null}, {x: null}), m.subset({x: 1}, {x: '1'})]") == \
        "[false,true,true,true,false]"



@needs_playwright
def test_token_is_not_added_to_api_calls_on_other_allowed_origins(tmp_path, ui_server):
    SEEN.clear()
    other = ui_server.replace("127.0.0.1", "localhost")  # allowed, same server, different origin
    code, out = verify(tmp_path, {"base_url": ui_server, "allow_origins": [other], "steps": [{"goto": "/xfetch"}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="token")
    assert code == 0, out
    cross = [a for host, path, a in SEEN if host.startswith("localhost") and path == "/api/v4/users/me"]
    same = [a for host, path, a in SEEN if host.startswith("127.0.0.1") and path == "/api/v4/users/me"]
    assert cross == [None] and same and all(a == f"Bearer {TOKEN}" for a in same), SEEN



# ------------------------------------------------------------------ second review round

def test_new_context_clears_the_previous_hunts_outputs(tmp_path):
    hdir, _ = make_hunt(tmp_path, "clean")
    (hdir / "R_M1").mkdir()
    (hdir / "R_M1" / "response.json").write_text("{}")
    (hdir / "compile_A.log").write_text("old")
    (hdir / "mutants_A.json").write_text("[]")
    ctx.reset_hunt_dir(hdir)
    assert not (hdir / "R_M1").exists() and not (hdir / "compile_A.log").exists()
    assert not (hdir / "mutants_A.json").exists() and not (hdir / "A").exists()


def test_base_vetting_compares_whole_failures_and_covers_missing_tests(tmp_path):
    out = "=== RUN   TestX\n    x_test.go:9: got 3, want 5\n--- FAIL: TestX (0.01s)\n=== RUN   TestY\n--- PASS: TestY (0.00s)\n"
    assert "got 3, want 5" in run.go_test_output(out)["TestX"]
    wt = tmp_path / "wt"
    a = run.normalize_failure(f"{wt}/a.go:9: got 3 (0.01s) (*T)(0xc000123456) \n    at foo ({wt}/x.js:1:2)", wt)
    b = run.normalize_failure(f"{wt}/a.go:9: got 3 (0.20s) (*T)(0xc000999999) \n    at bar ({wt}/y.js:3:4)", wt)
    assert a == b and "<wt>/a.go:9: got 3" in a
    # values written in hex are assertion text, not addresses: different values must not compare equal
    assert run.normalize_failure("got 0x02, want 0x01", wt) != run.normalize_failure("got 0x04, want 0x01", wt)
    head = {"d::TestX": "FAIL_3_OF_3", "d::TestZ": "FAIL_3_OF_3", "e::TestW": "FAIL_3_OF_3"}
    msgs = {"d::TestX": "got 3, want 5"}
    o = run.Outcome(results={"d::TestX": "FAIL", "d::(package failed)": "FAIL"}, messages={"d::TestX": "got 7, want 5"},
                    packages={"d": "FAIL", "e": "PASS"})
    table = run.base_table(head, msgs, o)
    assert table["d::TestX"] == "BASE_FAILS_DIFFERENTLY"  # fails on base, but not the same way
    assert table["d::TestZ"] == "BASE_FAILS_DIFFERENTLY"  # no line on base, its package died
    assert table["e::TestW"] == "NOT_RUN_ON_BASE"
    # a teardown failure on head whose package exits cleanly on base is new in the PR
    head = {"e::(package failed)": "FAIL_3_OF_3", "f::(package failed)": "FAIL_3_OF_3"}
    table = run.base_table(head, {}, run.Outcome(results={"e::TestW": "PASS"}, packages={"e": "PASS"}))
    assert table["e::(package failed)"] == "NEW_PR_BUG" and table["f::(package failed)"] == "NOT_RUN_ON_BASE"


def test_wrong_test_path_from_a_model_is_a_repairable_compile_error(tmp_path, monkeypatch):
    hdir, _ = make_hunt(tmp_path, "clean")
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/other_test.go", "content": "x"}]}))
    monkeypatch.setattr(run, "hunt_dir", lambda pr: hdir)
    assert run.main(["run.py", "run", "1", "B"]) == 3
    assert "refusing to write" in (hdir / "compile_B.log").read_text()


def test_rule_and_prefilter_precision():
    rules = reliability.parse((SKILL / "RELIABILITY.md").read_text())
    r05 = next(r for r in rules if r.id == "R05")
    assert not r05.diff.search("if (value === null) {") and r05.diff.search("strip NUL bytes")
    assert prefilter.excluded("server/channels/store/storetest/channel_store.go") == "test helper"
    assert prefilter.excluded("server/channels/api4/apitestlib.go") == "test helper"
    assert "MapAll" in ctx.changed_symbols("+func MapAll[T any](xs []T) []T {\n", "go")  # generic


def test_committed_bytecode_cannot_run_and_fails_the_trust_gate(tmp_path, monkeypatch):
    import py_compile
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    _git(repo, "checkout", "-q", "main")
    scripts = skill / "scripts"
    payload = tmp_path / "payload.py"
    payload.write_text((scripts / "hunt_common.py").read_text() + '\nprint("PWNED")\n')
    pyc = scripts / "__pycache__" / f"hunt_common.{sys.implementation.cache_tag}.pyc"
    pyc.parent.mkdir(exist_ok=True)
    py_compile.compile(str(payload), cfile=str(pyc), dfile=str(scripts / "hunt_common.py"),
                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
    _git(repo, "add", "-f", str(pyc))
    _git(repo, "commit", "-qm", "plant bytecode")
    p = subprocess.run([sys.executable, "trusted.py", "check"], cwd=scripts, capture_output=True, text=True, check=False,
                       env={**GIT_ENV, "PYTHONPYCACHEPREFIX": ""})
    assert "PWNED" not in p.stdout + p.stderr  # the planted file is never loaded
    assert p.returncode == 2 and "compiled bytecode is committed" in p.stdout, p.stdout + p.stderr


def test_git_output_ignores_colour_and_prefix_config(tmp_path, monkeypatch):
    cfg = tmp_path / "gitconfig"
    cfg.write_text("[color]\n\tui = always\n[diff]\n\tnoprefix = true\n")
    _, state = make_hunt(tmp_path, "go_bug")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    own = ctx.own_tests(Path(state["repo"]), state["merge_base"], state["head"], {"calc"})
    assert own["go"] == ["TestClampMiddle"]
    assert "\x1b[" not in hunt_common.git(Path(state["repo"]), "diff", state["merge_base"], state["head"])


def test_webapp_deps_install_in_the_worktree_and_share_when_the_lockfile_is_unchanged(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "npm.log"
    (bin_dir / "npm").write_text(f'#!/bin/sh\npwd >> "{log}"\nmkdir -p node_modules\n')
    (bin_dir / "npm").chmod(0o755)
    (bin_dir / "node").write_text("#!/bin/sh\nexit 0\n")
    (bin_dir / "node").chmod(0o755)
    monkeypatch.setenv("HUNT_NODE_BIN", str(bin_dir))
    repo = tmp_path / "repo"
    (repo / "webapp").mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    (repo / "webapp" / "package-lock.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    mb = _git(repo, "rev-parse", "HEAD")
    (repo / "webapp" / "x.ts").write_text("x")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "head")
    base_wt = tmp_path / "base"
    (base_wt / "webapp").mkdir(parents=True)
    prepare.webapp_deps(repo, base_wt, mb, _git(repo, "rev-parse", "HEAD"))
    assert log.read_text().splitlines() == [str(repo / "webapp")]
    assert (base_wt / "webapp" / "node_modules").is_symlink()
    (repo / "webapp" / "package-lock.json").write_text('{"changed": 1}')
    _git(repo, "commit", "-qam", "lock changes")
    base2 = tmp_path / "base2"
    (base2 / "webapp").mkdir(parents=True)
    prepare.webapp_deps(repo, base2, mb, _git(repo, "rev-parse", "HEAD"))
    assert log.read_text().splitlines()[-1] == str(base2 / "webapp")  # its own install


def test_install_skill_keeps_the_exclude_file_intact_and_respects_other_worktrees(tmp_path):
    script = ROOT / "scripts" / "install-skill.sh"
    target = tmp_path / "target"
    target.mkdir()
    _git(target, "init", "-q", "-b", "main")
    _git(target, "commit", "-q", "--allow-empty", "-m", "init")
    (target / ".git" / "info").mkdir(exist_ok=True)
    (target / ".git" / "info" / "exclude").write_text("*.log")  # no trailing newline
    p = subprocess.run(["bash", str(script), "--skill", "hunt", str(target)], capture_output=True, text=True,
                       check=False, env=GIT_ENV)
    assert p.returncode == 0, p.stderr
    assert (target / ".git" / "info" / "exclude").read_text().splitlines() == ["*.log", "/.claude/skills/hunt"]
    other = tmp_path / "other"
    _git(target, "worktree", "add", "-q", str(other))
    p = subprocess.run(["bash", str(script), "--copy", "--skill", "hunt", str(other)], capture_output=True, text=True,
                       check=False, env=GIT_ENV)
    assert p.returncode == 0 and "git add -f" in p.stdout, p.stdout + p.stderr
    assert _git(target, "status", "--porcelain") == ""  # the main worktree's symlink stays ignored


@needs_playwright
def test_verify_login_never_replays_the_password_through_a_redirect(tmp_path):
    captured: list[bytes] = []

    class Redirecting(_Handler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if self.path == "/api/v4/users/login" and self.headers.get("Host", "").startswith("127.0.0.1"):
                port = self.server.server_address[1]
                self._send(307, "", "text/plain", headers={"Location": f"http://localhost:{port}/api/v4/users/login"})
                return
            captured.append(body)
            self._send(200, "{}")

    with http_server(Redirecting) as (_, base):
        code, out = verify(tmp_path, {"base_url": base, "steps": [], "expect": [{"visible": {"role": "main"}}]})
    assert captured == [] and code == 2 and "login as tester failed: HTTP 307" in out, (captured, out)


@needs_playwright
def test_verify_fails_on_navigation_or_api_redirect_off_the_allowed_origins(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/link"}, {"click": {"role": "link", "name": "away"}}],
                                  "expect": [{"api": {"path": "/api/v4/users/me"}}]})
    assert code == 1 and "navigated to a non-allowed origin" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [], "expect": [{"api": {"path": "/api/v4/redirme"}}]})
    assert code == 1 and "returned 302, want 200" in out, out


@needs_playwright
def test_verify_plan_mistakes_found_at_runtime_are_invalid_plans(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/ok"}],
                                  "expect": [{"visible": {"css": "div["}}]}, auth="none")
    assert code == 2 and "INVALID_PLAN expect 1" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/ok"}, {"press": "Entr"}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="none")
    assert code == 2 and "INVALID_PLAN step 2/2" in out and "Unknown key" in out, out


@needs_playwright
def test_verify_library_call_uses_the_env_it_is_given(tmp_path, ui_server):
    code = ("import(process.env.VERIFY_UI_MODULE).then(async (m) => { const r = await m.verify(JSON.parse(process.env.PLAN),"
            " () => {}, null, {VERIFY_TOKEN: process.env.T, VERIFY_BASE_URL: process.env.B}); console.log('code=' + r); })")
    plan = {"base_url": ui_server, "steps": [], "expect": [{"api": {"path": "/api/v4/users/me", "json_has": {"username": "tester"}}}]}
    env = {**_node_env("none"), "VERIFY_UI_MODULE": str(VERIFY_UI), "PLAN": json.dumps(plan), "T": TOKEN, "B": ui_server}
    p = subprocess.run(["node", "-e", code], env=env, capture_output=True, text=True, timeout=120, check=False)
    assert "code=0" in p.stdout, p.stdout + p.stderr



# ------------------------------------------------------------------ third review round

def test_identical_go_failures_on_head_and_base_are_pre_existing(tmp_path):
    def run_output(secs: str) -> str:
        return (f"=== RUN   TestHuntA_Add\n    add_test.go:7: Add(2, 2) = 5\n--- FAIL: TestHuntA_Add ({secs}s)\n"
                f"FAIL\nFAIL\texample.com/m/calc\t{secs}s\nFAIL\n")
    wt = tmp_path / "wt"
    head = run.normalize_failure(run.go_test_output(run_output("0.013"))["TestHuntA_Add"], wt)
    base = run.normalize_failure(run.go_test_output(run_output("0.012"))["TestHuntA_Add"], wt)
    assert head == base and "Add(2, 2) = 5" in head
    assert run.base_verdict("d::TestHuntA_Add", "FAIL", {"d::TestHuntA_Add": "FAIL_3_OF_3"},
                            {"d::TestHuntA_Add": head}, base) == "PRE_EXISTING"


def test_round3_prefilter_ctx_and_runner_guards(tmp_path):
    assert prefilter.excluded("e2e-tests/playwright/specs/functional/channels/foo.spec.ts") == "e2e suite"
    assert prefilter.excluded("webapp/channels/src/x.spec.tsx") == "existing test"
    raw = ('package p\n\nfunc TestParse(t *testing.T) {\n\tjs := `{\n"a": 1\n}`\n\tif Parse(js) != 1 {\n'
           '\t\tt.Fatal("x")\n\t}\n}\n')
    patch = "@@ -7,0 +7,3 @@\n+\tif Parse(js) != 1 {\n+\t\tt.Fatal(\"x\")\n+\t}\n"
    assert ctx.changed_go_tests(patch, raw) == ["TestParse"]  # a raw string ending "}`" in column 0 is not the end
    hdir, state = make_hunt(tmp_path, "clean")
    with pytest.raises(run.InfraError, match="run_A.json missing"):
        run.cmd_base(hdir, state, "A")
    prep = {"repo": state["repo"], "wt": state["wt"], "wt_base": state["wt_base"], "merge_base": state["merge_base"],
            "head": state["head"], "hunt_dir": str(tmp_path / "h2")}
    with pytest.raises(run.InfraError, match="batches are 1..1"):
        ctx.build("1", 0, prep, {"title": "t", "body": ""})


def test_unapplicable_mutant_goes_back_for_regeneration(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": "M1", "file": "calc/percent.go", "old": "    return 0", "new": "    return 1", "what_breaks": "spaces"}]}))
    (hdir / "M2" / "response.json").unlink()
    v = run.cmd_mutants(hdir, state, "A")
    assert v[0]["verdict"] == "NEEDS_REGENERATION" and "occurs 0 times" in v[0]["detail"]
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "regen", "M1", "A")
    assert (hdir / "R_M1" / "request.json").exists()


def test_webapp_deps_follow_lockfile_changes_across_reruns(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "npm.log"
    (bin_dir / "npm").write_text(f'#!/bin/sh\npwd >> "{log}"\nmkdir -p node_modules\n')
    (bin_dir / "node").write_text("#!/bin/sh\nexit 0\n")
    for f in ("npm", "node"):
        (bin_dir / f).chmod(0o755)
    monkeypatch.setenv("HUNT_NODE_BIN", str(bin_dir))
    repo = tmp_path / "repo"
    (repo / "webapp").mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    (repo / "webapp" / "package-lock.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    mb = _git(repo, "rev-parse", "HEAD")
    base_wt = tmp_path / "base"
    (base_wt / "webapp").mkdir(parents=True)
    (base_wt / "webapp" / "package-lock.json").write_text("{}")
    prepare.webapp_deps(repo, base_wt, mb, mb)
    assert (base_wt / "webapp" / "node_modules").is_symlink() and len(log.read_text().splitlines()) == 1
    (repo / "webapp" / "package-lock.json").write_text('{"v": 2}')  # the PR is pushed again with a new lockfile
    _git(repo, "commit", "-qam", "lock")
    prepare.webapp_deps(repo, base_wt, mb, _git(repo, "rev-parse", "HEAD"))
    calls = log.read_text().splitlines()
    assert calls[1:] == [str(repo / "webapp"), str(base_wt / "webapp")], calls  # head reinstalls, base gets its own
    assert not (base_wt / "webapp" / "node_modules").is_symlink()


@needs_playwright
def test_verify_forgets_requests_cancelled_by_a_navigation(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/cancel"}, {"click": {"role": "button", "name": "Go"}}],
                                  "expect": [{"visible": {"role": "button", "name": "Save"}}]},
                       auth="none", env={"VERIFY_SETTLE_MS": "3000"})
    assert code == 0, out


@needs_playwright
def test_verify_environment_and_target_problems_are_classified(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": "http://127.0.0.1:9", "steps": [], "expect": [{"api": {"path": "/api/v4/system/ping"}}]},
                       auth="none")
    assert code == 2 and "INFRA_ERROR server unreachable" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server + "/mm", "steps": [], "expect": [{"visible": {"role": "main"}}]},
                       auth="none")
    assert code == 2 and "must be a server root" in out, out
    code, out = verify(tmp_path, {"steps": [], "expect": [{"visible": {"role": "main"}}]}, auth="none",
                       env={"VERIFY_BASE_URL": "localhost:18772"})
    assert code == 2 and "INFRA_ERROR VERIFY_BASE_URL / MM_URL" in out, out



# ------------------------------------------------------------------ fourth review round

def test_go_binary_dying_before_any_test_is_infra(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    dies = ('package calc\n\nimport "testing"\n\nfunc TestMain(m *testing.M) {\n\tpanic("cannot reach the database")\n}\n\n'
            "func TestHuntB_X(t *testing.T) {}\n")
    (hdir / "B").mkdir()
    (hdir / "B" / "response.json").write_text(json.dumps({"files": [{"path": "calc/hunt_huntb_test.go", "content": dies}]}))
    with pytest.raises(run.InfraError, match="0 tests executed"):
        run.cmd_run(hdir, state, "B", runs=1)


def test_failure_comparison_ignores_frames_and_goroutine_ids(tmp_path):
    wt = tmp_path / "wt"
    a = run.normalize_failure(f"panic: boom\n\ngoroutine 7 [running]:\ncalc.Add(...)\n\t{wt}/calc/calc.go:6 +0x1d\n", wt)
    b = run.normalize_failure(f"panic: boom\n\ngoroutine 9 [running]:\ncalc.Add(...)\n\t{wt}/calc/calc.go:5 +0x2e\n", wt)
    assert a == b and "panic: boom" in a
    kept = run.normalize_failure("    add_test.go:7: Add(2, 2) = 5\n", wt)
    assert "add_test.go:7: Add(2, 2) = 5" in kept  # t.Errorf lines are the failure itself, not a frame
    m = "TypeError: Cannot read properties of undefined (reading 'id')"
    assert run.base_verdict("f::T", "FAIL", {"f::T": "FAIL_3_OF_3"}, {"f::T": m}, m) == "PRE_EXISTING"


def test_path_triggered_rules_see_files_that_are_not_hunted(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    c = {**_ctx(["server/channels/app/x.go"], "+\tx := 1"),
         "all_changed_files": ["server/channels/app/x.go", "server/channels/db/migrations/postgres/000150_add_col.up.sql"]}
    assert [r.id for r in reliability.match(c)] == ["R07"]


def test_scripts_leave_no_bytecode_dirs_behind(tmp_path):
    import glob
    tmp = tmp_path / "t"  # a private TMPDIR: other processes' hunt-pyc-* dirs never show up here
    tmp.mkdir()
    ctx_file = tmp_path / "c.json"
    ctx_file.write_text(json.dumps({"changed_files_head_source": [], "diff_production_code": ""}))
    subprocess.run([sys.executable, str(SCRIPTS / "lessons.py"), "match", str(ctx_file)], check=True, capture_output=True,
                   env={**os.environ, "HUNT_TRUSTED_REF": trusted.WORKTREE, "PYTHONPYCACHEPREFIX": "", "TMPDIR": str(tmp)})
    assert glob.glob(os.path.join(tmp, "hunt-pyc-*")) == []


@needs_playwright
def test_verify_keeps_tracking_requests_across_in_page_url_changes(tmp_path, ui_server):
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/spa3"}, {"click": {"role": "button", "name": "Go"}}],
                                  "expect": [{"text": {"css": "#s"}, "contains": "moved"}]}, auth="none")
    assert code == 1 and "HTTP 500 from GET /api/v4/slow500" in out, out


@needs_playwright
def test_verify_plan_rules_for_cookies_and_builtin_keys(tmp_path, ui_server):
    other_port = ui_server.rsplit(":", 1)[0] + ":1"
    code, out = verify(tmp_path, {"base_url": ui_server, "allow_origins": [other_port], "steps": [],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="password")
    assert code == 2 and "session cookie would be sent there" in out, out
    for plan in ({"steps": [{"constructor": {"role": "button"}}], "expect": [{"visible": {"role": "main"}}]},
                 {"steps": [], "expect": [{"toString": {"css": "main"}}]}):
        code, out = verify(tmp_path, {"base_url": ui_server, **plan}, auth="none")
        assert code == 2 and "INVALID_PLAN" in out and "needs exactly one of" in out, (plan, out)


def test_base_worktree_with_its_own_install_follows_its_lockfile(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "npm.log"
    (bin_dir / "npm").write_text(f'#!/bin/sh\npwd >> "{log}"\nmkdir -p node_modules\n')
    (bin_dir / "node").write_text("#!/bin/sh\nexit 0\n")
    for f in ("npm", "node"):
        (bin_dir / f).chmod(0o755)
    monkeypatch.setenv("HUNT_NODE_BIN", str(bin_dir))
    repo = tmp_path / "repo"
    (repo / "webapp").mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    (repo / "webapp" / "package-lock.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    mb = _git(repo, "rev-parse", "HEAD")
    base_wt = tmp_path / "base"
    (base_wt / "webapp" / "node_modules").mkdir(parents=True)  # its own install from an earlier run...
    (base_wt / "webapp" / "node_modules" / ".hunt-lock-sha256").write_text("stale")  # ...from another lockfile
    (base_wt / "webapp" / "package-lock.json").write_text("{}")
    prepare.webapp_deps(repo, base_wt, mb, mb)
    assert str(base_wt / "webapp") in log.read_text().splitlines()


# ------------------------------------------------------------------ fourth CodeRabbit round

def test_place_never_overwrites_an_existing_file_or_writes_a_path_twice(tmp_path):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    tracked = wt / "calc" / "hunt_hunta_test.go"
    tracked.write_text("package calc // tracked by the repository")
    with pytest.raises(run.CompileError, match="already taken"):
        run.place(wt, [{"path": "calc/hunt_hunta_test.go", "content": "x"}], {"calc"})
    assert tracked.read_text() == "package calc // tracked by the repository"
    twice = [{"path": "calc/hunt_huntb_test.go", "content": "a"}, {"path": "calc/hunt_huntb_test.go", "content": "b"}]
    with pytest.raises(run.CompileError, match="already taken"):
        run.place(wt, twice, {"calc"})
    assert not (wt / "calc" / "hunt_huntb_test.go").exists()


def test_each_go_hunter_file_needs_its_own_matching_test(tmp_path):
    hdir, state = make_hunt(tmp_path, "clean")
    good = "package calc\n\nimport \"testing\"\n\nfunc TestHuntA_Zero(t *testing.T) {\n\tif Percent(0, 0) != 0 {\n\t\tt.Fatal()\n\t}\n}\n"
    misnamed = "package calc\n\nimport \"testing\"\n\nfunc TestOther(t *testing.T) {\n\tt.Fatal(\"never run\")\n}\n"
    (hdir / "A" / "response.json").write_text(json.dumps({"files": [
        {"path": "calc/hunt_hunta_test.go", "content": good}, {"path": "calc/hunt_hunta2_test.go", "content": misnamed}]}))
    with pytest.raises(run.CompileError, match="hunt_hunta2_test.go: no test named TestHuntA_"):
        run.cmd_run(hdir, state, "A", runs=1)
    assert not list(Path(state["wt"]).rglob("hunt_*"))


def test_base_refuses_a_response_changed_after_the_head_run(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")
    run.cmd_run(hdir, state, "A", runs=1)
    resp = json.loads((hdir / "A" / "response.json").read_text())
    resp["files"][0]["content"] += "\n// redispatched\n"
    (hdir / "A" / "response.json").write_text(json.dumps(resp))
    with pytest.raises(run.InfraError, match="changed since run_A.json"):
        run.cmd_base(hdir, state, "A")


def test_package_kill_needs_an_observed_passing_baseline():
    passed = run.Outcome(results={"calc::TestX": "PASS"}, packages={"calc": "PASS"})
    failed = run.Outcome(results={"calc::TestX": "FAIL"}, packages={"calc": "FAIL"})
    assert run.is_kill("calc::(package failed)", "FAIL", passed)
    assert not run.is_kill("calc::(package failed)", "FAIL", failed)  # nothing passed at baseline
    assert not run.is_kill("calc::(package failed)", "FAIL", run.Outcome())  # not observed at all
    assert run.is_kill("calc::TestX", "FAIL", passed) and not run.is_kill("calc::TestX", "FAIL", failed)


def test_a_compile_check_timeout_only_errors_that_mutant(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "clean")
    (hdir / "M" / "response.json").write_text(json.dumps({"mutants": [
        {"id": f"M{i}", "file": "calc/percent.go", "old": "\t\treturn 0\n", "new": f"\t\treturn {i}\n", "what_breaks": "zero"}
        for i in (1, 2, 3)]}))
    (hdir / "M2" / "response.json").unlink()
    real = run.compiles

    def flaky_toolchain(wt, file):
        if "return 2" in (Path(wt) / file).read_text():
            raise run.InfraError("timed out after 900s: go test -c")
        return real(wt, file)

    monkeypatch.setattr(run, "compiles", flaky_toolchain)
    v = {m["id"]: m["verdict"] for m in run.cmd_mutants(hdir, state, "A")}
    assert v["M2"] == "ERROR" and v["M1"] in ("KILLED", "SURVIVED") and v["M3"] in ("KILLED", "SURVIVED"), v


def test_prepare_and_ctx_refuse_while_another_hunt_step_runs(tmp_path, monkeypatch):
    import fcntl
    hdir = tmp_path / "hunt7"
    monkeypatch.setattr(prepare, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(ctx, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(prepare, "prepare", lambda pr: pytest.fail("prepared while a run held the lock"))
    monkeypatch.setattr(ctx, "build", lambda *a: pytest.fail("rebuilt the context while a run held the lock"))
    monkeypatch.setattr(sys, "argv", ["ctx.py", "7"])
    hdir.mkdir()
    with (hdir / ".lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(hunt_common.InfraError, match="one at a time"):
            prepare.main("7")
        with pytest.raises(hunt_common.InfraError, match="one at a time"):
            ctx.main()  # before it reads prepare.json or calls GitHub


def test_go_test_ranges_survive_trailing_comments():
    src = ("package p\n\nfunc TestA(t *testing.T) {\n\tx := 1\n} // TestA\n\n"
           "func TestB(t *testing.T) {\n\ty := 2\n}\n\nfunc TestC(t *testing.T) {} // empty\n")
    patch = "@@ -8,0 +8,1 @@\n+\ty := 2\n"
    assert ctx.changed_go_tests(patch, src) == ["TestB"]
    quoted = 'package p\n\nfunc TestA(t *testing.T) {} // see "x" and `y`\n\nfunc TestB(t *testing.T) {\n\ty := "//"\n}\n'
    assert ctx.changed_go_tests("@@ -6,0 +6,1 @@\n+\ty := \"//\"\n", quoted) == ["TestB"]
    assert ctx.go_code('\tu := "http://x" // c') == '\tu := "http://x"' and ctx.go_code("} // TestA") == "}"


def test_regen_reads_only_the_requested_score(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    row = {"id": "M2", "verdict": "NEEDS_REGENERATION", "file": "calc/percent.go", "what_breaks": "w"}
    (hdir / "mutants_A.json").write_text(json.dumps([{**row, "mutant": {"old": "A-attempt"}, "detail": "A error"}]))
    (hdir / "mutants_PR.json").write_text(json.dumps([{**row, "mutant": {"old": "PR-attempt"}, "detail": "PR error"}]))
    build_requests.main("1", "regen", "M2", "PR")
    user = json.loads((hdir / "R_M2" / "request.json").read_text())["user"]
    assert "PR-attempt" in user and "PR error" in user and "A-attempt" not in user


@needs_jest
def test_each_jest_hunter_file_needs_its_own_matching_test(tmp_path):
    hdir, state = make_hunt(tmp_path, "react_bug")
    resp = json.loads((hdir / "A" / "response.json").read_text())
    misnamed = "test('unrelated name', () => { expect(1).toBe(2); });\n"
    resp["files"].append({"path": "web/src/hunt_a2.test.tsx", "content": misnamed})
    (hdir / "A" / "response.json").write_text(json.dumps(resp))
    with pytest.raises(run.CompileError, match="hunt_a2.test.tsx: no test title starts with 'HuntA_'"):
        run.cmd_run(hdir, state, "A", runs=1)


@needs_playwright
def test_a_redirect_hop_never_reaches_a_non_allowed_origin(tmp_path, ui_server):
    SEEN.clear()
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/off"}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="none")
    assert code == 1 and "redirected to a non-allowed origin" in out, out
    assert [h for h, path, _ in SEEN if path == "/landing"] == [], SEEN  # blocked before any connection to it


@needs_playwright
def test_verify_rejects_paths_that_resolve_off_the_server_or_the_api(tmp_path, ui_server):
    for plan, msg in [({"steps": [{"goto": "/\t/example.com/"}]}, "goto must be a path"),
                      ({"steps": [{"goto": "/\n/example.com/"}]}, "goto must be a path"),
                      ({"expect": [{"api": {"path": "/api/v4/../../ok"}}]}, "under /api/v4/"),
                      ({"expect": [{"api": {"path": "/api/v4/%2e%2e/%2e%2e/ok"}}]}, "under /api/v4/"),
                      ({"expect": [{"count": {"role": "button", "nth": 2}}]}, "nth is not allowed")]:
        full = {"base_url": ui_server, "steps": [], "expect": [{"visible": {"role": "main"}}], **plan}
        code, out = verify(tmp_path, full, auth="none")
        assert code == 2 and "INVALID_PLAN" in out and msg in out, (plan, out)
    assert _module("m.subset({delta: -0}, {delta: 0}) && m.subset([0], [-0])") == "true"  # JSON numbers: -0 == 0


@needs_playwright
def test_frozen_spec_keeps_the_verified_target_anonymity_and_origin_guard(tmp_path, ui_server):
    plan = {"name": "anonymous", "base_url": ui_server, "steps": [{"goto": "/ok"}],
            "expect": [{"api": {"path": "/api/v4/users/me", "status": 401}}]}
    code, out = verify(tmp_path, plan, "--freeze", "anon.spec.ts", auth="none")
    assert code == 0 and f'cd "{tmp_path}" && npx playwright test "anon.spec.ts"' in out, out
    spec = (tmp_path / "anon.spec.ts").read_text()
    assert "const AUTHED = false;" in spec and "apiLogin" not in spec
    (tmp_path / "node_modules").symlink_to(VERIFY_DEPS)
    cli = VERIFY_DEPS / "@playwright" / "test" / "cli.js"

    def run_spec(name: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(["node", str(cli), "test", name, "--reporter=line"], cwd=tmp_path,
                              env={**_node_env("token"), **env}, capture_output=True, text=True, timeout=180, check=False)

    # a shared CI VERIFY_TOKEN neither signs the anonymous check in nor retargets it: VERIFY_BASE_URL is ignored
    p = run_spec("anon.spec.ts", VERIFY_BASE_URL="http://127.0.0.1:9")
    assert p.returncode == 0 and "1 passed" in p.stdout, p.stdout + p.stderr
    # the frozen spec has the same origin guard: a redirect hop off the allowed origins never connects
    (tmp_path / "off.spec.ts").write_text(spec.replace('"/ok"', '"/off"'))
    SEEN.clear()
    p = run_spec("off.spec.ts")
    assert p.returncode != 0 and "allowed origins" in p.stdout + p.stderr, p.stdout + p.stderr
    assert [h for h, path, _ in SEEN if path == "/landing"] == [], SEEN


def test_identical_go_panics_compare_equal_despite_moved_code_addresses(tmp_path):
    # real `go test` panic output from two builds of the same bug: only binary addresses differ
    def panic(pc: str, a: str, b: str, c: str) -> str:
        return (f"--- FAIL: TestHuntA_Nil (0.00s)\npanic: runtime error: invalid memory address or nil pointer dereference [recovered]\n"
                f"[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc={pc}]\n\ngoroutine 7 [running]:\n"
                f"testing.tRunner.func1.2({{{a}, {b}}})\n\t/usr/local/go/src/testing/testing.go:1632 +0x230\n"
                f"testing.tRunner(0xc000102b60, {c})\n\t/usr/local/go/src/testing/testing.go:1742 +0x123\n")
    wt = tmp_path / "wt"
    head = run.normalize_failure(panic("0x51f9a2", "0x54fe40", "0x6a08a0", "0x584368"), wt)
    base = run.normalize_failure(panic("0x51fa12", "0x5501c0", "0x6a0960", "0x5843f0"), wt)
    assert head == base and "nil pointer dereference" in head and "code=0x1" in head
    assert run.normalize_failure("got (0x02), want (0x01)", wt) != run.normalize_failure("got (0x04), want (0x01)", wt)


@needs_playwright
def test_origin_guard_tunnels_only_the_named_allowed_port_and_survives_bad_connects():
    script = r"""
const http = await import('node:http'); const net = await import('node:net');
const {startOriginGuard} = await import(process.env.VERIFY_UI_MODULE);
const echo = net.createServer((s) => s.pipe(s)); await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const port = echo.address().port; const blocked = [];
const guard = await startOriginGuard(http, net, new Set([`https://127.0.0.1:${port}`]), (o) => blocked.push(o));
const CRLF2 = '\r\n\r\n';
const send = (line, body = '') => new Promise((resolve) => {
  const s = net.connect(guard.port, '127.0.0.1', () => s.write(line + CRLF2 + body)); let got = '';
  s.on('data', (d) => { got += d; if (got.includes(CRLF2) && (!body || got.endsWith(body))) { s.destroy(); } });
  s.on('close', () => resolve(got.split(CRLF2)[0] + (body && got.endsWith(body) ? ' +echo' : '')));
  setTimeout(() => s.destroy(), 2000);
});
const out = [await send(`CONNECT 127.0.0.1:${port} HTTP/1.1`, 'ping'), await send('CONNECT 127.0.0.1:80 HTTP/1.1'),
  await send(`CONNECT 127.0.0.1:${port}?:80 HTTP/1.1`), await send('CONNECT [::1] HTTP/1.1'), await send('CONNECT 127.0.0.1:0 HTTP/1.1')];
guard.close(); echo.close();
console.log(JSON.stringify({out, blocked}));
"""
    p = subprocess.run(["node", "--input-type=module", "-e", script], env={**_node_env("none"), "VERIFY_UI_MODULE": str(VERIFY_UI)},
                       capture_output=True, text=True, timeout=30, check=False)
    assert p.returncode == 0, p.stdout + p.stderr
    res = json.loads(p.stdout)
    assert res["out"][0] == "HTTP/1.1 200 Connection Established +echo", res  # the allowed port tunnels, early bytes too
    assert res["out"][1].startswith("HTTP/1.1 403"), res  # another port on an allowed host is another origin
    assert [o.split(" ")[1] for o in res["out"][2:]] == ["400", "400", "400"], res  # malformed: refused, no crash
    assert res["blocked"] == ["https://127.0.0.1:80"], res


# ------------------------------------------------------------------ Phase 2: resource discipline

def test_low_disk_is_infra_error_before_any_work(tmp_path, monkeypatch):
    import collections
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(hunt_common.shutil, "disk_usage", lambda p: usage(10 * 1024**3, 9 * 1024**3, 1024**3))
    with pytest.raises(hunt_common.InfraError, match="only 1.0 GiB free"):
        hunt_common.require_disk(tmp_path / "not" / "created" / "yet")
    monkeypatch.setattr(prepare, "mm_clone", lambda: pytest.fail("cloned with no disk space"))
    with pytest.raises(hunt_common.InfraError, match="GiB free"):
        prepare.prepare("1")
    with pytest.raises(hunt_common.InfraError, match="GiB free"):  # before the -race build starts
        run.go_run(tmp_path, {"calc": "^TestX$"}, True, run.Outcome())
    monkeypatch.setattr(hunt_common.shutil, "disk_usage", lambda p: usage(10 * 1024**3, 0, 3 * 1024**3))
    hunt_common.require_disk(tmp_path)  # 3 GiB is enough


def test_runner_never_sleeps_or_retries_tests():
    # flaky tests are reported (FLAKY, 3 runs), never retried into a pass or slept around
    for name in ("run.py", "prepare.py", "eval_bugs.py"):
        src = (SCRIPTS / name).read_text()
        assert not re.search(r"\bsleep\(|--retries|retryTimes|-count=[2-9]", src), name


# ------------------------------------------------------------------ Phase 2: lessons prune and the hit log

def test_lessons_prune_is_deterministic_and_append_only(tmp_path):
    def lesson(i: str, globs: list[str]) -> dict:
        return {"id": i, "pattern": i, "applies_to": {"path_globs": globs}, "keywords": ["k"], "symptom": "s",
                "check": "c", "source_pr": "1"}
    lessons_ = [lesson("L001", ["server/channels/app/*"]), lesson("L002", ["webapp/*"]), lesson("L003", ["server/x/*"])]
    log = [{"run": f"{n}/1", "matched": ["L001"]} for n in range(29)]
    assert lessons.prune(lessons_, log, window=30) == [{"retire": "L002", "reason": "over-broad path glob(s) ['webapp/*']"}]
    log.append({"run": "29/1", "matched": []})  # 30 hunts now: L003 never matched in any of them
    log.append({"run": "0/1", "matched": []})  # a re-run of hunt 0 counts once, with its latest result
    out = lessons.prune(lessons_, log, window=30)
    assert [r["retire"] for r in out] == ["L002", "L003"] and "no match in the last 30" in out[1]["reason"]
    assert [lessons.overbroad(g) for g in (
        "*", "**", "server/*", "webapp/**/*.ts", "server/channels/*", "server/channels/app/*",
    )] == [True] * 5 + [False]
    # retirements are append-only lines: load() drops the retired lesson, ids are never reused
    f = tmp_path / "lessons.jsonl"
    f.write_text("".join(json.dumps(x) + "\n" for x in lessons_) + json.dumps(out[0]) + "\n")
    assert [x["id"] for x in lessons.load(f)] == ["L001", "L003"]
    added = lessons.add({**lesson("x", ["server/y/*"]), "pattern": "new"}, f)
    assert added["id"].startswith("L-") and added["id"] not in {"L001", "L002", "L003"}


def test_hunters_log_which_lessons_they_were_shown(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "hunters")
    lines = [json.loads(x) for x in lessons.hits_log().read_text().splitlines()]
    assert lines == [{"run": "1", "matched": lines[0]["matched"]}] and isinstance(lines[0]["matched"], list)


# ------------------------------------------------------------------ Phase 2: revert-to-rule miner

def _revert_history(tmp: Path) -> Path:
    repo = tmp / "reverts"
    (repo / "server" / "channels" / "app" / "platform").mkdir(parents=True)
    (repo / "webapp" / "channels" / "src").mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "master")
    web_conn = repo / "server" / "channels" / "app" / "platform" / "web_conn.go"
    web_conn.write_text("package platform\n")
    (repo / "webapp" / "channels" / "src" / "a.ts").write_text("export const a = 1;\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    for i, body in enumerate(["func (wc *WebConn) BroadcastHook() { wc.sendQueue <- nil }",
                              "func (wc *WebConn) suppressTyping() { BroadcastHook(); wc.sendQueue <- nil }"]):
        web_conn.write_text(f"package platform\n\n{body}\n")
        _git(repo, "commit", "-qam", f"change {i}")
        _git(repo, "revert", "--no-edit", "HEAD")
    (repo / "webapp" / "channels" / "src" / "a.ts").write_text("export const a = 2;\n")
    _git(repo, "commit", "-qam", "web change")
    _git(repo, "revert", "--no-edit", "HEAD")
    (repo / "webapp" / "channels" / "src" / "a.ts").write_text("export const a = 3; // Revert \"not a revert\"\n")
    _git(repo, "commit", "-qam", "a change whose body says\n\nRevert \"something\" happened inside this PR")
    return repo


def test_mine_rules_proposes_parseable_candidates_and_writes_nothing(tmp_path, capsys):
    import mine_rules
    repo = _revert_history(tmp_path)
    rules = SKILL / "RELIABILITY.md"
    before = rules.read_text()
    assert mine_rules.main(["mine_rules.py", str(repo), "-n", "30"]) == 0
    out = capsys.readouterr().out
    assert rules.read_text() == before  # never edits the rules
    parsed = reliability.parse(out)
    assert [r.id for r in parsed] == ["R12"]  # numbered after R11; the webapp glob was reverted only once
    assert parsed[0].paths == ["server/channels/app/platform/*"]
    assert parsed[0].diff.search("+ BroadcastHook()") and parsed[0].diff.search("+ sendQueue")
    assert "Reverted 2 times" in out and 'Revert "change 0"' in out and "CANDIDATE" in parsed[0].invariant
    assert "not a revert" not in out  # a message that only mentions a revert is not a revert


# ------------------------------------------------------------------ Phase 2: revert benchmark

def _bug_fix_history(tmp: Path) -> tuple[Path, str, str]:
    """base -> bug (the go_bug fixture's head) -> fix (git revert of the bug)."""
    repo = make_repo(tmp, "go_bug", "go_bug", head_msg="Make Clamp faster\n\nAvoid a comparison in the hot path.",
                     dirname="bugrepo", feature_branch=None)
    bug = _git(repo, "rev-parse", "HEAD")
    _git(repo, "revert", "--no-edit", "HEAD")
    return repo, bug, _git(repo, "rev-parse", "HEAD")


def _control_history(tmp: Path) -> tuple[Path, str]:
    repo = make_repo(tmp, "clean", "clean", head_msg="Handle a zero total in Percent",
                     dirname="cleanrepo", feature_branch=None)
    return repo, _git(repo, "rev-parse", "HEAD")


def _eval_manifest(tmp: Path, **thresholds: float) -> tuple[Path, str]:
    tmp.mkdir(parents=True, exist_ok=True)
    bug_repo, bug, fix = _bug_fix_history(tmp)
    ctl_repo, ctl = _control_history(tmp)
    truth = "Clamp returns values above max for some inputs."
    manifest = {"thresholds": thresholds,
                "cases": [{"id": "clamp", "repo": str(bug_repo), "bug_sha": bug, "fix_sha": fix, "area": "calc",
                           "bug": truth, "source": "self-test fixture", "responses": str(FIX / "go_bug" / "responses")}],
                "controls": [{"id": "percent", "repo": str(ctl_repo), "sha": ctl, "area": "calc",
                              "responses": str(FIX / "clean" / "responses")}]}
    path = tmp / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path, truth


def test_eval_bugs_scores_a_real_bug_and_a_clean_control(tmp_path, monkeypatch, capsys):
    import eval_bugs
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    path, _ = _eval_manifest(tmp_path, raw_recall_min=1.0, vetted_recall_min=1.0, fp_rate_max=0.0)
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")])
    out = capsys.readouterr().out
    assert code == 0 and "VERDICT: PASS" in out, out
    card = json.loads((tmp_path / "out" / "scorecard.json").read_text())
    assert card["metrics"] == {"raw_recall": 1.0, "vetted_recall": 1.0, "fp_rate": 0.0, "raw_fp_rate": 0.0,
                               "diff_recall": 0.0, "diff_fp_rate": 0.0,
                               "old_recall": 0.0, "old_fp_rate": 0.0, "combined_recall": 1.0, "combined_fp_rate": 0.0,
                               "new_api_recall": 0.0, "new_api_fp_rate": 0.0, "old_sometimes_recall": 0.0,
                               "old_sometimes_fp_rate": 0.0, "pr_ci_recall": 0.0, "pr_ci_fp_rate": 0.0,
                               "pr_fails_recall": 0.0, "pr_fails_fp_rate": 0.0,
                               # the fix commit is the revert: the vetted clamp test passes there (STRONG)
                               "strong_recall": 1.0, "strong_recall_fix_forward": 0.0, "strictly_weak_ratio_A": 0.0,
                               # no vetted.json in this fixture: nothing admitted, so both admissibility rates are 0
                               "admissibility_recall": 0.0, "admissibility_fp_rate": 0.0}
    # the same responses always give the same scorecard
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out2")]) == 0
    assert json.loads((tmp_path / "out2" / "scorecard.json").read_text()) == card
    # a threshold the run misses fails the benchmark
    path2, _ = _eval_manifest(tmp_path / "strict", fp_rate_max=-1.0)
    assert eval_bugs.main(["eval_bugs.py", str(path2), "--out", str(tmp_path / "out3")]) == 1


def test_eval_bugs_refuses_a_manifest_whose_fix_is_not_the_revert(tmp_path, capsys):
    import eval_bugs
    path, _ = _eval_manifest(tmp_path)
    m = json.loads(path.read_text())
    m["cases"][0]["fix_sha"] = m["cases"][0]["bug_sha"]  # a commit cannot revert itself
    path.write_text(json.dumps(m))
    assert eval_bugs.main(["eval_bugs.py", str(path)]) == 2
    assert "does not say it reverts" in capsys.readouterr().out


def test_eval_bugs_dispatch_never_shows_the_ground_truth(tmp_path, monkeypatch, capsys):
    import eval_bugs
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    path, truth = _eval_manifest(tmp_path)
    m = json.loads(path.read_text())
    for e in m["cases"] + m["controls"]:
        e.pop("responses")  # hunters come from the dispatch command instead
    path.write_text(json.dumps(m))
    seen = tmp_path / "seen.txt"
    dispatcher = tmp_path / "dispatch.py"
    dispatcher.write_text(
        "import json, shutil, sys\n"
        f"req = json.load(open(sys.argv[1])); open({str(seen)!r}, 'a').write(req['system'] + req['user'])\n"
        "out = {'files': [], 'tests': []}\n"
        f"if '/A/' in req['response_path'] and 'Clamp' in req['user']:\n"
        f"    out = json.load(open({str(FIX / 'go_bug' / 'responses' / 'A' / 'response.json')!r}))\n"
        "json.dump(out, open(req['response_path'], 'w'))\n")
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out"),
                           "--dispatch", f"{sys.executable} {dispatcher}"])
    out = capsys.readouterr().out
    assert code == 0 and "clamp" in out and "VERDICT: PASS" in out, out
    text = seen.read_text()
    assert "Make Clamp faster" in text and truth not in text  # the commit message, never the ground truth


# ------------------------------------------------------------------ Phase 2: /verify failure screenshot and feature map

@needs_playwright
def test_failure_screenshot_is_opt_in_and_only_on_fail(tmp_path, ui_server):
    def run_plan(name: str, contains: str, *flags: str) -> tuple[int, list[Path], str]:
        d = tmp_path / name
        d.mkdir()
        (d / "plan.json").write_text(json.dumps({"base_url": ui_server, "steps": [{"goto": "/ok"}],
                                                 "expect": [{"text": {"role": "main"}, "contains": contains}]}))
        p = subprocess.run(["node", str(VERIFY_UI), "plan.json", *flags], cwd=d, capture_output=True, text=True,
                           env={**_node_env("none"), "VERIFY_BASE_URL": ui_server}, timeout=120, check=False)
        return p.returncode, sorted(d.rglob("*.png")), p.stdout
    code, pngs, out = run_plan("fail_flag", "not on the page", "--screenshot-on-fail")
    assert code == 1 and [p.name for p in pngs] == ["failure.png"], out
    assert pngs[0].read_bytes()[:8] == b"\x89PNG\r\n\x1a\n" and "not read by the agent" in out
    assert "VERDICT: FAIL" in out and "scope snapshot at failure" in out  # the text record is unchanged
    code, pngs, out = run_plan("pass_flag", "Fixture", "--screenshot-on-fail")
    assert code == 0 and pngs == [], out  # passing runs never write one
    code, pngs, out = run_plan("fail_noflag", "not on the page")
    assert code == 1 and pngs == [], out  # without the flag, never


@needs_playwright
def test_feature_map_prints_only_the_matching_route_sections(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".claude" / "skills" / "verify").mkdir(parents=True)
    (repo / ".claude" / "skills" / "verify" / "FEATURE_MAP.md").write_text(
        "# Feature map\n\n## Channel header\nroute: /<team>/channels/<channel>\n- button \"town square channel menu\"\n\n"
        "## Drafts\nroute: /<team>/drafts\n- testid drafts-list\n")
    (repo / "e2e").mkdir()

    def feature_map(*args: str, cwd: Path = repo / "e2e", **env: str) -> tuple[int, str]:
        p = subprocess.run(["node", str(VERIFY_UI), "--feature-map", *args], cwd=cwd, capture_output=True, text=True,
                           env={**_node_env("none"), **env}, timeout=30, check=False)
        return p.returncode, p.stdout
    code, out = feature_map("/channels/")
    assert code == 0 and "## Channel header" in out and "town square channel menu" in out and "Drafts" not in out, out
    code, out = feature_map("DRAFTS")
    assert code == 0 and "testid drafts-list" in out and "Channel header" not in out, out
    code, out = feature_map("emoji picker")
    assert code == 0 and "no section" in out and "Channel header | Drafts" in out, out
    code, out = feature_map("drafts", cwd=tmp_path)  # no map above this directory
    assert code == 0 and "no FEATURE_MAP.md" in out, out
    code, out = feature_map("drafts", cwd=tmp_path, VERIFY_FEATURE_MAP=str(repo / ".claude/skills/verify/FEATURE_MAP.md"))
    assert code == 0 and "drafts-list" in out, out


# ------------------------------------------------------------------ sixth CodeRabbit round (review of 8770fdc)

def test_unstaging_the_skill_does_not_make_it_a_local_install(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    _git(repo, "checkout", "-q", "main")
    _git(repo, "rm", "-r", "-q", "--cached", str(skill))  # still committed at HEAD, gone from the index
    (skill / "RELIABILITY.md").write_text("# weakened on disk\n")
    with pytest.raises(trusted.InfraError):
        trusted.check(skill)
    assert len(reliability.parse(trusted.read("RELIABILITY.md", skill))) == 11  # the base copy, never the disk


def test_place_cleans_up_when_terminated_mid_write(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    (wt / "calc").mkdir(parents=True)
    real = Path.write_text
    calls = []

    def write(self, data, *a, **kw):
        calls.append(self)
        if len(calls) == 2:
            raise SystemExit(143)  # SIGTERM arrives while the second file is written
        return real(self, data, *a, **kw)

    monkeypatch.setattr(Path, "write_text", write)
    files = [{"path": "calc/hunt_hunta_test.go", "content": "a"}, {"path": "calc/hunt_huntb_test.go", "content": "b"}]
    with pytest.raises(SystemExit):
        run.place(wt, files, {"calc"})
    assert not list((wt / "calc").iterdir())


def test_prepare_drops_the_previous_context_and_verdicts_first(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt9"
    hdir.mkdir()
    for name in ("state.json", "ctx.json", "run_A.json", "run_A.response.sha256", "base_A.json", "prepare.json"):
        (hdir / name).write_text("{}")
    (hdir / "A").mkdir()
    monkeypatch.setattr(prepare, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(prepare, "pr_meta", lambda pr: {"head": {"sha": "new"}, "base": {"ref": "master"}})
    monkeypatch.setattr(prepare, "mm_clone", lambda: (_ for _ in ()).throw(hunt_common.InfraError("stop here")))
    with pytest.raises(hunt_common.InfraError, match="stop here"):
        prepare.prepare("9")  # prepare.json records no head: these results are from some other preparation
    assert sorted(p.name for p in hdir.iterdir()) == []  # nothing from the old head survives a new preparation


def _hunted(hdir: Path, head: str) -> None:
    hdir.mkdir()
    (hdir / "prepare.json").write_text(json.dumps({"head": head}))
    (hdir / "A").mkdir()
    (hdir / "A" / "response.json").write_text("{}")
    (hdir / "run_A.json").write_text("{}")
    (hdir / "old_tests.json").write_text("{}")
    (hdir / "pr_tests.json").write_text("{}")


def test_prepare_never_wipes_results_for_the_same_head(tmp_path, monkeypatch):
    # PR 40221: a headless session waited with ScheduleWakeup, each wakeup re-sent `/hunt <pr>`, and every restart
    # wiped the finished results and paid for the hunters again (11 times, $25).
    hdir = tmp_path / "hunt9"
    _hunted(hdir, "abc")
    monkeypatch.setattr(prepare, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(prepare, "pr_meta", lambda pr: {"head": {"sha": "abc"}, "base": {"ref": "master"}})
    monkeypatch.setattr(prepare, "mm_clone", lambda: pytest.fail("re-prepared a hunt that already has results"))
    with pytest.raises(prepare.AlreadyHunted, match="run_A.json"):
        prepare.prepare("9")
    assert (hdir / "run_A.json").exists() and (hdir / "A" / "response.json").exists()


def test_prepare_starts_over_when_the_head_moved_or_fresh_is_asked(tmp_path, monkeypatch):
    for head, fresh in (("old", False), ("abc", True)):
        hdir = tmp_path / f"hunt-{head}"
        _hunted(hdir, head)
        monkeypatch.setattr(prepare, "hunt_dir", lambda pr, h=hdir: h)
        monkeypatch.setattr(prepare, "pr_meta", lambda pr: {"head": {"sha": "abc"}, "base": {"ref": "master"}})
        monkeypatch.setattr(prepare, "mm_clone", lambda: (_ for _ in ()).throw(hunt_common.InfraError("stop here")))
        with pytest.raises(hunt_common.InfraError, match="stop here"):
            prepare.prepare("9", fresh=fresh)
        assert not (hdir / "run_A.json").exists() and not (hdir / "A").exists()
        assert not (hdir / "old_tests.json").exists() and not (hdir / "pr_tests.json").exists()


@needs_playwright
def test_frozen_replay_rechecks_the_cookie_rule_for_its_new_target(tmp_path, ui_server):
    plan = {"name": "whoami", "base_url": ui_server, "login": True, "allow_origins": ["http://localhost:1"],
            "steps": [{"goto": "/whoami"}], "expect": [{"text": {"css": "#who"}, "contains": "signed in as tester"}]}
    code, out = verify(tmp_path, plan, "--freeze", "frozen.spec.ts", auth="password")
    assert code == 0, out  # 127.0.0.1 and localhost are different hosts for cookies
    retarget = ui_server.replace("127.0.0.1", "localhost")  # now BASE shares its host with http://localhost:1
    p = run_frozen_spec(tmp_path, "frozen.spec.ts", auth="password", env={"VERIFY_REPLAY_BASE_URL": retarget})
    assert p is not None and p.returncode != 0 and "share the host of" in p.stdout + p.stderr, p.stdout + p.stderr
    p = run_frozen_spec(tmp_path, "frozen.spec.ts", auth="token", env={"VERIFY_REPLAY_BASE_URL": retarget})
    assert p is not None and p.returncode == 0, p.stdout + p.stderr  # token mode sets no session cookie


def test_shipped_revert_manifest_is_well_formed():
    import eval_bugs
    m = json.loads((ROOT / "eval" / "revert_cases.json").read_text())
    ids = [e["id"] for e in m["cases"] + m["controls"]]
    assert len(ids) == len(set(ids)) and len(m["cases"]) >= 5
    # exactly one size-matched control per case
    assert sorted(c["matches"] for c in m["controls"]) == sorted(e["id"] for e in m["cases"])
    for e in m["cases"]:
        assert all(str(e.get(k, "")).strip() for k in eval_bugs.CASE_KEYS), e
        assert re.fullmatch(r"[0-9a-f]{40}", e["bug_sha"]) and re.fullmatch(r"[0-9a-f]{40}", e["fix_sha"]), e
        assert e["source"].startswith("https://github.com/mattermost/mattermost/pull/"), e
    case_ids = {e["id"] for e in m["cases"]}
    for e in m["controls"]:
        assert re.fullmatch(r"[0-9a-f]{40}", e["sha"]) and e["matches"] in case_ids, e
    assert set(m["thresholds"]) == set(eval_bugs.DEFAULT_THRESHOLDS)


# ------------------------------------------------------------------ revert benchmark: the disk gate and per-entry failures

def test_eval_checks_disk_before_creating_any_worktree(tmp_path, monkeypatch, capsys):
    import collections

    import eval_bugs
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(hunt_common.shutil, "disk_usage", lambda p: usage(10 * 1024**3, 9 * 1024**3, 1024**3))
    path, _ = _eval_manifest(tmp_path)
    out = tmp_path / "out"
    assert eval_bugs.main(["eval_bugs.py", str(path), "--out", str(out)]) == 2
    text = capsys.readouterr().out
    assert "VERDICT: ERROR" in text and "GiB free" in text, text
    assert not (out / "wt1").exists() and not (out / "wt1.base").exists()  # nothing was checked out


def test_eval_records_a_broken_entry_and_still_hunts_the_rest(tmp_path, monkeypatch, capsys):
    import eval_bugs
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    path, _ = _eval_manifest(tmp_path)
    broken = tmp_path / "broken_responses" / "A"
    broken.mkdir(parents=True)
    (broken / "response.json").write_text("{ not json")  # a hunter response that cannot be read
    m = json.loads(path.read_text())
    m["cases"][0]["responses"] = str(broken.parent)
    path.write_text(json.dumps(m))
    code = eval_bugs.main(["eval_bugs.py", str(path), "--out", str(tmp_path / "out")])
    text = capsys.readouterr().out
    assert code == 2 and "VERDICT: ERROR" in text, text
    card = json.loads((tmp_path / "out" / "scorecard.json").read_text())
    rows = {r["id"]: r for r in card["rows"]}
    assert rows["clamp"]["error"] and "JSONDecodeError" in rows["clamp"]["error"]
    assert rows["percent"]["error"] is None and rows["percent"]["responses"] is True  # the control still ran


def test_eval_refuses_a_responses_directory_that_does_not_exist(tmp_path, capsys):
    import eval_bugs
    path, _ = _eval_manifest(tmp_path)
    m = json.loads(path.read_text())
    m["cases"][0]["responses"] = str(tmp_path / "no_such_dir")
    path.write_text(json.dumps(m))
    assert eval_bugs.main(["eval_bugs.py", str(path)]) == 2
    assert "responses directory" in capsys.readouterr().out


def test_mutant_scoring_stops_on_low_disk_before_placing_anything(tmp_path, monkeypatch):
    import collections
    hdir, state = make_hunt(tmp_path, "clean")
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(hunt_common.shutil, "disk_usage", lambda p: usage(10 * 1024**3, 9 * 1024**3, 1024**3))
    with pytest.raises(run.InfraError, match="GiB free"):
        run.cmd_mutants(hdir, state, "A")
    assert not list(Path(state["wt"]).rglob("hunt_*"))  # no hunter file was placed, nothing was built
    assert not (hdir / "mutants_A.json").exists()


# ------------------------------------------------------------------ old tests on new code (no model)


def test_old_test_the_pr_had_to_edit_breaks_on_head_and_passes_on_base(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_test_break")
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {
        "calc::TestClampHigh": "OLD_TEST_BREAKS",   # the edit hid the new off-by-one
        "calc::TestClampMiddle": "PASS",            # edited (a comment) but the old version still holds
        "dbl::TestDouble": "OLD_TEST_UNCOMPILABLE", # Double was renamed: an API change, not a finding
    }
    # TestClampLow is unchanged, so it never runs; the PR-added top_test.go (which uses a head-only helper) was moved
    # aside, or the calc package would not have compiled with the base calc_test.go
    assert [u["tests"] for u in out["units"]] == [["TestClampHigh", "TestClampMiddle"], ["TestDouble"]]
    msgs = json.loads((hdir / "old_tests.messages.json").read_text())
    assert "got 9, want 10" in msgs["calc::TestClampHigh"]
    assert "undefined: Double" in msgs["dbl::*"]
    assert _clean(Path(state["wt"])) and _clean(Path(state["wt_base"]))
    assert (Path(state["wt"]) / "calc/top_test.go").exists()  # head files are back


def test_old_tests_run_nothing_when_the_pr_only_adds_tests(tmp_path):
    hdir, state = make_hunt(tmp_path, "go_bug")  # adds TestClampMiddle to an existing file; TestClampOwn is unchanged
    assert old_tests.cmd_old(hdir, state) == {"tests": {}, "units": [], "skipped": []}


def test_old_tests_pick_tests_that_call_a_changed_helper():
    base = ("package c\n\nfunc helper() int {\n\treturn 1\n}\n\nfunc TestA(t *testing.T) {\n\t_ = helper()\n}\n\n"
            "func TestB(t *testing.T) {\n\t_ = 2\n}\n")
    head = base.replace("return 1", "return 2")
    assert old_tests.go_candidates(base, head) == ["TestA"]
    assert old_tests.go_candidates(base, None) == ["TestA", "TestB"]  # a deleted file: every test is old
    assert old_tests.go_candidates(base, base) == []


def test_old_tests_restore_head_files_even_when_a_run_is_interrupted(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "old_test_break")
    def boom(*a, **k):
        raise SystemExit(143)  # SIGTERM mid-run
    monkeypatch.setattr(old_tests, "go_run", boom)
    with pytest.raises(SystemExit):
        old_tests.cmd_old(hdir, state)
    assert _clean(Path(state["wt"]))


@needs_jest
def test_old_jest_file_the_pr_edited_breaks_on_head_and_leaves_no_snapshot(tmp_path):
    hdir, state = make_hunt(tmp_path, "old_test_jest")
    out = old_tests.cmd_old(hdir, state)
    assert out["tests"] == {"web/src/total.test.ts::total adds every value": "OLD_TEST_BREAKS",
                            "web/src/total.test.ts::total matches its snapshot": "PASS"}
    # jest wrote a new snapshot file on head and on base: both are removed
    assert _clean(Path(state["wt"])) and _clean(Path(state["wt_base"]))


def test_trusted_check_blocks_gitignored_files_and_modified_pr_server(tmp_path, monkeypatch):
    monkeypatch.delenv("HUNT_TRUSTED_REF", raising=False)
    repo, skill = _skill_repo(tmp_path)
    _git(repo, "checkout", "-q", "main")
    pr_srv = skill.parent / "verify" / "scripts" / "pr_server.py"
    pr_srv.parent.mkdir(parents=True)
    pr_srv.write_text("# pr_server\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "add pr_server")
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    assert "trusted ref" in trusted.check(skill)
    # A PR hiding a shadowing module behind .gitignore must still fail closed.
    (repo / ".gitignore").write_text("json.py\n")
    shadow = skill / "scripts" / "json.py"
    shadow.write_text("raise RuntimeError('shadow')\n")
    with pytest.raises(trusted.InfraError, match="json.py"):
        trusted.check(skill)
    shadow.unlink()
    (repo / ".gitignore").unlink()
    # Modifying sibling verify/scripts/pr_server.py must also fail closed.
    pr_srv.write_text("# tampered\n")
    with pytest.raises(trusted.InfraError, match="pr_server.py"):
        trusted.check(skill)


def test_shipped_lessons_pass_prune_with_zero_retirements(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    assert lessons.prune(lessons.load(), [], window=30) == []


def test_mine_rules_root_file_glob():
    import mine_rules
    assert mine_rules.glob_of("main.go") == "*"
    assert mine_rules.glob_of("server/a/b.go") == "server/a/*"


def test_strengthen_strips_spaces_around_mutant_ids(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    hdir, _ = make_hunt(tmp_path, "clean")
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)
    build_requests.main("1", "strengthen", "M1, M3")
    req = json.loads((hdir / "A2" / "request.json").read_text())
    user = json.loads(req["user"])
    assert len(user["surviving_faults"]) == 2


def test_suite_for_handles_symlinked_worktree_path(tmp_path):
    # macOS /tmp -> /private/tmp: placed paths from under() are resolved while wt may be a symlink.
    real_wt = tmp_path / "real_wt"
    (real_wt / "calc").mkdir(parents=True)
    link_wt = tmp_path / "link_wt"
    link_wt.symlink_to(real_wt)
    placed = run.place(link_wt, [{"path": "calc/hunt_hunta_test.go",
                                  "content": "package calc\nfunc TestHuntA_Ok(t *testing.T) {}\n"}], {"calc"})
    try:
        suite = run.suite_for("A", {"targets": [{"lang": "go", "dir": "calc"}]}, placed, link_wt)
        assert suite.go_patterns == {"calc": "^TestHuntA_"}
    finally:
        run.unplace(placed)


def test_range_parsing_and_target_keys():
    assert hunt_common.parse_range("40260") is None
    assert hunt_common.parse_range("release-11...release-12") == ("release-11", "release-12")
    assert hunt_common.parse_range("release-12.0.0-rc1 ... release-12.1.0-rc3") == ("release-12.0.0-rc1", "release-12.1.0-rc3")
    assert hunt_common.parse_range("v11.0.0..v12.0.0") == ("v11.0.0", "v12.0.0")
    for bad in ("..head", "base..", "..."):
        with pytest.raises(hunt_common.InfraError, match="invalid range"):
            hunt_common.parse_range(bad)
    assert hunt_common.target_key("40260") == "40260"
    k1 = hunt_common.target_key("release-12.0.0-rc1...release-12.1.0-rc3")
    k2 = hunt_common.target_key("release-12.0.0-rc1..release-12.1.0-rc3")
    assert k1 == k2 and "/" not in k1 and " " not in k1


def test_prepare_and_ctx_work_on_release_tag_ranges(tmp_path, monkeypatch):
    # A local git repo with release tags (no GitHub PR / gh API needed): prepare -> ctx -> run -> base end-to-end.
    repo = tmp_path / "mm"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "release-12")
    _overlay(FIX / "go_bug" / "base", repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base release")
    _git(repo, "tag", "release-12.0.0-rc1")
    _overlay(FIX / "go_bug" / "head", repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "Clamp upper bound change for rc3")
    _git(repo, "tag", "release-12.1.0-rc3")

    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    monkeypatch.setattr(prepare, "pr_meta", lambda pr: pytest.fail("gh api must not be called for a range"))
    target = "release-12.0.0-rc1...release-12.1.0-rc3"
    prepare.prepare(target)
    hdir = hunt_common.hunt_dir(target)
    prep = json.loads((hdir / "prepare.json").read_text())
    assert prep["range"] == ["release-12.0.0-rc1", "release-12.1.0-rc3"]
    meta = ctx.range_meta(repo, prep["merge_base"], prep["head"], *prep["range"])
    assert "Clamp upper bound change for rc3" in meta["body"]
    state = ctx.build(target, 1, prep, meta)
    c = json.loads((hdir / "ctx.json").read_text())
    assert c["pr"]["number"] == 0 and c["pr"]["range"] == target
    shutil.copytree(FIX / "go_bug" / "responses", hdir, dirs_exist_ok=True)
    assert run.cmd_run(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "FAIL_3_OF_3"}
    assert run.cmd_base(hdir, state, "A") == {"calc::TestHuntA_ClampRangeAndIdentity": "NEW_PR_BUG"}
    with pytest.raises(prepare.AlreadyHunted):
        prepare.prepare(target)


@needs_playwright
def test_verify_api_write_methods_csrf_save_and_browserless_fast_path(tmp_path, ui_server):
    plan = {
        "name": "api writes",
        "base_url": ui_server,
        "login": True,
        "steps": [
            {"capture": {"api": {"method": "POST", "path": "/api/v4/things", "body": {"title": "hello"}}, "save": {"tid": "id"}}},
            {"capture": {"api": {"method": "PATCH", "path": "/api/v4/things/$tid", "body": {"title": "patched-$tid"}}}},
        ],
        "expect": [
            {"api": {"method": "GET", "path": "/api/v4/things/$tid", "status": 200, "json_has": {"title": "patched-item42"}}},
            {"api": {"method": "DELETE", "path": "/api/v4/things/$tid", "status": 200, "json_has": {"status": "OK"}}},
        ],
    }
    code, out = verify(tmp_path, plan, "--freeze", "api.spec.ts", auth="password")
    assert code == 0 and "API-only, no browser" in out, out
    # Frozen spec must pass tsc --strict AND replay cleanly with password+CSRF auth
    p = run_frozen_spec(tmp_path, "api.spec.ts", auth="password", check_tsc=True)
    assert p is not None and p.returncode == 0 and "1 passed" in p.stdout, p.stdout + p.stderr
    # Unsafe $var tokens cannot traverse outside /api/v4/
    unsafe_plan = {"base_url": ui_server, "steps": [{"capture": {"api": {"method": "POST", "path": "/api/v4/unsafe"}, "save": {"bad": "id"}}}],
                   "expect": [{"api": {"path": "/api/v4/things/$bad"}}]}
    code, out = verify(tmp_path, unsafe_plan, auth="none")
    assert code == 1 and "unsafe URL token" in out, out
    # Invalid method and oversized body (>64 KiB) are INVALID_PLAN
    for bad in ({"expect": [{"api": {"method": "TRACE", "path": "/api/v4/users/me"}}]},
                {"expect": [{"api": {"method": "POST", "path": "/api/v4/things", "body": {"x": "a" * 70000}}}]}):
        code, out = verify(tmp_path, {"base_url": ui_server, "steps": [], **bad}, auth="none")
        assert code == 2 and "INVALID_PLAN" in out, (bad, out)


@needs_playwright
def test_verify_drag_release_false_mouse_up_and_freeze(tmp_path, ui_server):
    plan = {
        "name": "mid-drag unmount",
        "base_url": ui_server,
        "steps": [
            {"goto": "/drag"},
            {"drag": {"from": {"css": "#handle"}, "dx": 60, "dy": 0, "release": False}},
            {"press": "Enter", "on": {"role": "button", "name": "Unmount"}},
            {"snapshot": {"css": "#state"}},
            {"mouse_up": True},
        ],
        "expect": [{"text": {"css": "#state"}, "contains": "down,dragged,up"}],
    }
    code, out = verify(tmp_path, plan, "--freeze", "drag.spec.ts", auth="none")
    assert code == 0 and "- paragraph: down,dragged\n" in out, out
    p = run_frozen_spec(tmp_path, "drag.spec.ts", auth="none", check_tsc=True)
    assert p is not None and p.returncode == 0 and "1 passed" in p.stdout, p.stdout + p.stderr
    # Out-of-bounds drag offset is INVALID_PLAN
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"drag": {"from": {"css": "#handle"}, "dx": 5000}}],
                                  "expect": [{"visible": {"role": "main"}}]}, auth="none")
    assert code == 2 and "INVALID_PLAN" in out, out


@needs_playwright
def test_verify_strict_locators_and_fail_only_diagnostics(tmp_path, ui_server):
    # Ambiguous locator fails loudly when `nth` is omitted, succeeds with explicit `nth: 1`
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/dup"}, {"click": {"role": "button", "name": "Submit"}}],
                                  "expect": [{"text": {"css": "#r"}, "contains": "first"}]}, auth="none")
    assert code == 1 and "strict mode violation" in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/dup"}, {"click": {"role": "button", "name": "Submit", "nth": 1}}],
                                  "expect": [{"text": {"css": "#r"}, "contains": "second"}]}, auth="none")
    assert code == 0, out
    # console.error and 4xx /api/v4/ are silent on PASS, printed in diagnostics on FAIL
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/diag"}],
                                  "expect": [{"text": {"css": "#m"}, "contains": "ready"}]}, auth="none")
    assert code == 0 and "diagnostics at failure" not in out, out
    code, out = verify(tmp_path, {"base_url": ui_server, "steps": [{"goto": "/diag"}],
                                  "expect": [{"text": {"css": "#m"}, "contains": "never"}]}, auth="none")
    assert code == 1 and "diagnostics at failure:" in out, out
    assert "console.error: boom-console" in out and "HTTP 404 from GET /api/v4/missing404" in out, out


def test_mode_d_failure_detail_strips_server_noise_and_keeps_tail(tmp_path, monkeypatch):
    hdir, state = make_hunt(tmp_path, "go_bug")
    (hdir / "D").mkdir()
    src = ('package calc\n\nimport (\n\t"fmt"\n\t"testing"\n)\n\n'
           'func TestHuntD_NoisyFail(t *testing.T) {\n'
           '\tfor i := 0; i < 40; i++ {\n'
           '\t\tfmt.Println("\\x1b[33mwarn\\x1b[0m [2026-11-23 00:00:00.000 Z] Preserving role permissions caller=\\"sqlstore/role_store.go:123\\"")\n'
           '\t}\n'
           '\tt.Fatal("REAL_TAIL_CAUSE_12345")\n'
           '}\n')
    (hdir / "D" / "response.json").write_text(json.dumps({
        "files": [{"path": "calc/hunt_huntd_test.go", "content": src}],
        "tests": [{"test_name": "TestHuntD_NoisyFail", "checks": "differential recorder", "source": "calc"}],
    }))
    v = run.cmd_diff(hdir, state, "D")
    assert v == {"calc::TestHuntD_NoisyFail": "RECORDER_FAILED"}
    ex = json.loads((hdir / "diff_D.examples.json").read_text())
    detail = ex["calc::TestHuntD_NoisyFail"]["detail"]
    assert "REAL_TAIL_CAUSE_12345" in detail and "role_store.go" not in detail, detail


def test_prefilter_uses_max_plus_breadth_aligned_with_dev_rubric():
    auth_only = prefilter.FileDiff("server/channels/app/login.go", 5, 2, "+checkAuth(session)\n")
    multi_lower = prefilter.FileDiff(
        "server/channels/app/settings_cache.go", 40, 10,
        "+var mu sync.Mutex\n+cfg := getConfig()\n+reducer(dispatch(x))\n",
    )
    persistence = prefilter.FileDiff("server/channels/store/sqlstore/post_store.go", 20, 5, "+tx.Commit()\n")
    api_ws = prefilter.FileDiff("server/channels/wsapi/channel.go", 15, 3, "+broadcastEvent()\n")
    assert prefilter.risk(auth_only) == 10.0
    assert prefilter.risk(multi_lower) == 7.5  # max(7) + 0.5 for config; does not beat Tier 1 auth
    assert prefilter.risk(persistence) == 9.0
    assert prefilter.risk(api_ws) == 8.0
    p = prefilter.plan([multi_lower, api_ws, persistence, auth_only], max_files=2)
    assert [f.path for f in p.batches[0]] == [auth_only.path, persistence.path]


@needs_playwright
def test_verify_freeze_emits_covers_and_verified_at_and_rejects_multiline(tmp_path, ui_server):
    plan = {
        "name": "covers metadata",
        "base_url": ui_server,
        "covers": ["server/channels/api4/config.go", "webapp/channels/src/foo.tsx"],
        "verified_at": "5e62cb1",
        "steps": [{"capture": {"api": "/api/v4/users/me"}}],
        "expect": [{"api": {"path": "/api/v4/users/me", "status": 401}}],
    }
    code, out = verify(tmp_path, plan, "--freeze", "meta.spec.ts", auth="none")
    assert code == 0, out
    spec = (tmp_path / "meta.spec.ts").read_text()
    assert "// covers: server/channels/api4/config.go, webapp/channels/src/foo.tsx\n" in spec
    assert "// verified-at: 5e62cb1\n" in spec
    run_frozen_spec(tmp_path, "meta.spec.ts", check_tsc=True, run_test=False)
    for bad in ({"verified_at": "abc\nevil()"}, {"covers": ["ok\nbad"]}, {"covers": []}):
        bad_plan = {"base_url": ui_server, "steps": [], "expect": [{"api": {"path": "/api/v4/users/me", "status": 401}}], **bad}
        bcode, bout = verify(tmp_path, bad_plan, auth="none")
        assert bcode == 2 and "INVALID_PLAN" in bout, (bad, bout)


def test_prepare_worktrees_refuses_non_worktree_dir(tmp_path):
    repo = make_repo(tmp_path, "go_bug", "go_bug", feature_branch=None)
    mb = _git(repo, "rev-parse", "HEAD~1")
    head = _git(repo, "rev-parse", "HEAD")
    wt, wt_base = tmp_path / "wt", tmp_path / "wt_base"
    wt.mkdir()
    keep = wt / "keep.txt"
    keep.write_text("do not delete")
    with pytest.raises(hunt_common.InfraError, match="not a git worktree"):
        prepare.worktrees(repo, head, mb, wt, wt_base)
    assert keep.read_text() == "do not delete"


def test_run_clears_stale_coverage_and_records_jest_package_failed(tmp_path, monkeypatch):
    go_dir = tmp_path / "go"
    go_dir.mkdir()
    hdir, state = make_hunt(go_dir, "go_bug")
    cov = hdir / "run_A.coverage.json"
    cov.write_text('{"stale": true}')
    run.cmd_run(hdir, state, "A", runs=1)
    assert not cov.exists()

    web_dir = tmp_path / "web"
    web_dir.mkdir()
    _, wstate = make_hunt(web_dir, "react_bug")
    wt = Path(wstate["wt"])
    tfile = wt / "web" / "src" / "hunt_a.test.tsx"
    tfile.write_text("test('HuntA_ok', () => {});\n")
    real_run = subprocess.run

    def fake_jest(cmd, **kw):
        for i, arg in enumerate(cmd):
            s = str(arg)
            out_arg = s.split("=", 1)[1] if s.startswith("--outputFile=") else (str(cmd[i + 1]) if s == "--outputFile" else None)
            if out_arg:
                Path(out_arg).write_text(json.dumps({"testResults": [{
                    "name": str(tfile.resolve()), "status": "failed", "message": "afterAll exploded",
                    "assertionResults": [{"title": "HuntA_ok", "fullName": "HuntA HuntA_ok", "status": "passed"}],
                }]}))
                return subprocess.CompletedProcess(cmd, 1, "", "")
        return real_run(cmd, **kw)

    monkeypatch.setattr(subprocess, "run", fake_jest)
    into = run.Outcome()
    try:
        run.jest_run(wt, ["web/src/hunt_a.test.tsx"], "HuntA", into)
    finally:
        tfile.unlink(missing_ok=True)
    assert into.results == {
        "web/src/hunt_a.test.tsx::HuntA HuntA_ok": "PASS",
        f"web/src/hunt_a.test.tsx::{run.PACKAGE_FAILED}": "FAIL",
    }
    assert into.packages == {"web/src/hunt_a.test.tsx": "FAIL"}
    pkg_fail = f"web/src/hunt_a.test.tsx::{run.PACKAGE_FAILED}"
    assert "afterAll exploded" in into.messages[pkg_fail]
    pass_base = run.Outcome(packages={"web/src/hunt_a.test.tsx": "PASS"})
    assert run.is_kill(pkg_fail, "FAIL", pass_base) is True
    assert run.base_table({pkg_fail: "FAIL_3_OF_3"}, {}, pass_base) == {pkg_fail: "NEW_PR_BUG"}


@needs_node
def test_verify_ui_rejects_unicode_separators_long_expanded_body_and_503_capture(tmp_path):
    seen = []

    class Handler(JsonHandler):
        def do_GET(self):
            if self.path == "/api/v4/big":
                self._send(200, {"big": "x" * 70000})
            elif self.path == "/api/v4/fail503":
                self._send(503, "{}")
            else:
                self._send(200, "{}")

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            seen.append((self.path, self.headers.get("Content-Type", ""), raw))
            self._send(200, '{"ok": true}')

    with http_server(Handler) as (_, url):
        for bad in ({"verified_at": "a\u2028b"}, {"verified_at": "a\u2029b"}, {"covers": ["ok\u2028bad"]}):
            bplan = {"base_url": url, "steps": [], "expect": [{"api": {"path": "/api/v4/ok", "status": 200}}], **bad}
            bcode, bout = verify(tmp_path, bplan, auth="none")
            assert bcode == 2 and "INVALID_PLAN" in bout, (bad, bout)

        ok_plan = {
            "base_url": url,
            "steps": [{"capture": {"api": {"method": "POST", "path": "/api/v4/echo", "body": "hello"}}}],
            "expect": [{"api": {"path": "/api/v4/ok", "status": 200}}],
        }
        code, out = verify(tmp_path, ok_plan, auth="none")
        assert code == 0 and seen == [("/api/v4/echo", "application/json", b'"hello"')], (out, seen)
        fcode, fout = verify(tmp_path, ok_plan, "--freeze", "cap.spec.ts", auth="none")
        assert fcode == 0 and "toBeLessThan(500)" in (tmp_path / "cap.spec.ts").read_text(), fout

        seen.clear()
        big_plan = {
            "base_url": url,
            "steps": [
                {"capture": {"api": "/api/v4/big", "save": {"big": "big"}}},
                {"capture": {"api": {"method": "POST", "path": "/api/v4/echo", "body": {"v": "$big"}}}},
            ],
            "expect": [{"api": {"path": "/api/v4/ok", "status": 200}}],
        }
        bcode, bout = verify(tmp_path, big_plan, auth="none")
        assert bcode != 0 and "exceeds" in bout and seen == [], (bcode, bout, seen)

        s503_plan = {
            "base_url": url,
            "steps": [{"capture": {"api": "/api/v4/fail503"}}],
            "expect": [{"api": {"path": "/api/v4/ok", "status": 200}}],
        }
        scode, sout = verify(tmp_path, s503_plan, auth="none")
        assert scode == 1 and "503" in sout, (scode, sout)


def test_mine_rules_ignores_sql_comment_headers_inside_hunk(tmp_path, capsys):
    import mine_rules
    rel_sql = "server/channels/store/sqlstore/q.sql"
    repo = make_repo(tmp_path, {rel_sql: "-- base\nSELECT safeFunc();\n"}, base_msg="init", dirname="sqlrepo")
    sql = repo / rel_sql
    for idx in range(2):
        # Reverting removes "-- comment" (producing "--- comment" inside the hunk) and adds buggyQueryGuard().
        sql.write_text(f"-- base\nSELECT buggyQueryGuard({idx});\n")
        _git(repo, "commit", "-qam", f"setup {idx}")
        sql.write_text(f"-- section {idx}\nSELECT other({idx});\n")
        _git(repo, "commit", "-qam", f"sql change {idx}")
        _git(repo, "revert", "--no-edit", "HEAD")
    assert mine_rules.main(["mine_rules.py", str(repo), "-n", "10", "--min", "2"]) == 0
    out = capsys.readouterr().out
    assert "buggyQueryGuard" in out and "sqlstore/*" in out


def test_sh_survives_non_utf8_test_output(tmp_path):
    # PR 39657: a Go recorder printed generated ids containing b"\xff\xfe"; the strict decode crashed `run.py diff`.
    p = hunt_common.sh([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'id=\\xff\\xfe ok')"], tmp_path)
    assert p.returncode == 0 and p.stdout == "id=�� ok"
