# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Wave 2 context lane: R1 (all batches, risk x callers order, whole patch, .sql, word-boundary risk),
R2 (multi-hop caller walk with permission lines, per-symbol fairness), R4 (helper and jest sibling fallbacks)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ctx
import prefilter
import pytest
from test_v2_features import _two_batch_repo


def fd(path: str, patch: str = "+x := 1\n", added: int = 5) -> prefilter.FileDiff:
    return prefilter.FileDiff(path, added, 0, patch)


def write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


# ------------------------------------------------------------------ R1 prefilter

@pytest.mark.parametrize("path,patch", [
    ("pkg/ctx.go", "+x := ctx.Value()\n"),            # 'tx.' inside ctx.
    ("pkg/controller.go", "+controller.Run()\n"),      # 'role' inside controller
    ("pkg/concert.go", "+concert := 1\n"),             # 'cert' inside concert
    ("pkg/block.go", "+block(x)\n"),                   # 'lock(' inside block(
    ("pkg/mchan.go", "+mchan := 1\n"),                 # 'chan ' inside mchan
    ("pkg/xhttp.go", "+xhttp.Get()\n"),                # 'http.' inside xhttp.
])
def test_risk_ignores_keywords_inside_other_words(path, patch):
    assert prefilter.risk(fd(path, patch)) == 0.0


@pytest.mark.parametrize("path,patch,floor", [
    ("server/channels/app/login.go", "+checkAuth(session)\n", 10),     # camelCase word start still matches
    ("server/channels/app/user.go", "+if user.IsGuest() {\n", 10),
    ("server/channels/app/user.go", "+roleID := 1\n", 10),
    ("server/channels/app/x.go", "+tx.Commit()\n", 9),
    ("server/channels/db/migrations/postgres/000150_x.up.sql", "+ALTER TABLE a ADD b int;\n", 9),
])
def test_risk_still_matches_real_keywords(path, patch, floor):
    assert prefilter.risk(fd(path, patch)) >= floor


def test_sql_migrations_are_hunted_not_excluded():
    assert prefilter.excluded("server/channels/db/migrations/postgres/000150_x.up.sql") is None
    p = prefilter.plan([fd("server/channels/db/migrations/postgres/000150_x.up.sql", "+ALTER TABLE a ADD b int;\n")])
    assert [f.path for b in p.batches for f in b] == ["server/channels/db/migrations/postgres/000150_x.up.sql"]


def test_plan_orders_by_risk_then_callers():
    a, b = fd("server/channels/app/a_cfg.go", "+config := 1\n"), fd("server/channels/app/b_cfg.go", "+config := 1\n")
    plain = prefilter.plan([a, b], max_files=1)
    assert [x[0].path for x in plain.batches] == [a.path, b.path]  # tie: path order
    busy = prefilter.plan([a, b], max_files=1, callers={b.path: 20})
    assert [x[0].path for x in busy.batches] == [b.path, a.path]  # callers break the tie


def test_caller_bonus_never_outranks_a_higher_risk_tier():
    auth, cfg = fd("server/channels/app/login.go", "+session := 1\n"), fd("server/channels/app/c.go", "+config := 1\n")
    p = prefilter.plan([cfg, auth], max_files=1, callers={cfg.path: 1000})
    assert p.batches[0][0].path == auth.path


def test_oversize_patch_is_not_truncated_in_ctx(tmp_path, monkeypatch):
    hdir, prep = _two_batch_repo(tmp_path)
    repo = Path(prep["repo"])
    big = "package pkg2\n\n" + "".join(f"func Big{i}(x int) int {{ return x + {i} }}\n" for i in range(1500))
    (Path(prep["wt"]) / "pkg2" / "extra.go").write_text(big)
    monkeypatch.setattr(ctx, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(ctx, "file_diffs", lambda r, mb, head: [prefilter.FileDiff("pkg2/extra.go", 1500, 0)])
    monkeypatch.setattr(ctx, "git", lambda r, *a: "\n".join(["diff --git a/pkg2/extra.go b/pkg2/extra.go", "@@ -0,0 +1,1500 @@"]
                                                            + [f"+func Big{i}() {{}}" for i in range(1500)]) if a[0] == "diff" and "--" in a else "")
    ctx.build("42", 1, prep, {"title": "t", "body": ""})
    out = json.loads((hdir / "ctx.json").read_text())
    assert out["diff_production_code"].count("\n") >= 1500
    assert repo.exists()


# ------------------------------------------------------------------ R1 batches default / --first-batch

def _run_main(hdir, prep, monkeypatch, *flags):
    hdir.mkdir(parents=True, exist_ok=True)
    (hdir / "prepare.json").write_text(json.dumps({**prep, "range": ["master", "feature"]}))
    monkeypatch.setattr(ctx, "hunt_dir", lambda pr: hdir)
    monkeypatch.setattr(sys, "argv", ["ctx.py", "42", *flags])
    ctx.main()
    return json.loads((hdir / "state.json").read_text())


def test_all_batches_is_default_and_first_batch_restores_old_behaviour(tmp_path, monkeypatch, capsys):
    hdir, prep = _two_batch_repo(tmp_path)
    assert _run_main(hdir, prep, monkeypatch)["all_batches"] is True
    assert "all-batches plan (2 batches" in capsys.readouterr().out
    st = _run_main(hdir, prep, monkeypatch, "--first-batch")
    assert st["all_batches"] is False and st["forced_all_batches"] == []  # does not inherit the earlier state
    assert "all-batches plan" not in capsys.readouterr().out
    assert _run_main(hdir, prep, monkeypatch, "--all-batches")["all_batches"] is True


def test_reliability_hit_forces_all_batches_under_first_batch(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", "worktree")
    hdir, prep = _two_batch_repo(tmp_path)
    monkeypatch.setattr(ctx, "forced_all_batches", lambda diffs, deleted: ["R02"])
    st = _run_main(hdir, prep, monkeypatch, "--first-batch")
    assert st["all_batches"] is True and st["forced_all_batches"] == ["R02"]


def test_forced_all_batches_matches_r01_r02_only(monkeypatch):
    monkeypatch.setenv("HUNT_TRUSTED_REF", "worktree")
    team = fd("server/channels/api4/team.go", "+x := 1\n")
    other = fd("server/channels/app/platform/config.go", "+x := 1\n")  # R03 path only
    assert ctx.forced_all_batches([team], []) == ["R02"]
    assert ctx.forced_all_batches([other], []) == []


# ------------------------------------------------------------------ R2 callers

def _server_tree(tmp_path: Path) -> Path:
    wt = tmp_path / "wt"
    write(wt, "server/channels/app/team.go", "package app\n\nfunc (a *App) UpdateTeamName(id string) error {\n\treturn nil\n}\n")
    write(wt, "server/channels/app/team_helper.go",
          "package app\n\nfunc (a *App) renameFlow(id string) error {\n\treturn a.UpdateTeamName(id)\n}\n")
    write(wt, "server/channels/api4/team.go",
          "package api4\n\nfunc renameTeam(c *Context, w http.ResponseWriter, r *http.Request) {\n"
          "\tif !c.App.SessionHasPermissionToTeam(*c.AppContext.Session(), id, model.PermissionManageTeam) {\n"
          "\t\treturn\n\t}\n\tc.App.renameFlow(id)\n}\n")
    return wt


def test_callers_walk_up_to_api4_entry_point_with_permission_lines(tmp_path):
    wt = _server_tree(tmp_path)
    out = ctx.callers(wt, ["server/channels/app/team.go"], {"UpdateTeamName"})
    by_hop = {e["hop"]: e for e in out}
    assert by_hop[1]["file"] == "server/channels/app/team_helper.go" and by_hop[1]["enclosing"] == "renameFlow"
    assert by_hop[2]["file"] == "server/channels/api4/team.go" and by_hop[2]["entry_point"] is True
    assert by_hop[2]["chain_for"] == "UpdateTeamName" and by_hop[2]["symbol"] == "renameFlow"
    assert any("SessionHasPermissionToTeam" in line and line.startswith("server/channels/api4/team.go:")
               for line in by_hop[2]["permission_checks"])


def test_callers_rank_entry_points_before_alphabetical_order(tmp_path):
    wt = tmp_path / "wt"
    write(wt, "server/channels/app/team.go", "package app\n\nfunc DoThing() {}\n")
    write(wt, "server/channels/app/aaa.go", "package app\n\nfunc aaa() {\n\tDoThing()\n}\n")
    write(wt, "server/channels/api4/zzz.go", "package api4\n\nfunc zzz() {\n\tDoThing()\n}\n")
    out = ctx.callers(wt, ["server/channels/app/team.go"], {"DoThing"})
    assert out[0]["file"] == "server/channels/api4/zzz.go"


def test_callers_share_the_cap_between_symbols(tmp_path, monkeypatch):
    wt = tmp_path / "wt"
    write(wt, "pkg/a.go", "package pkg\n\nfunc Alpha() {}\nfunc Omega() {}\n")
    for i in range(30):  # many callers of Alpha, sorted before Omega's single caller
        write(wt, f"pkg/a{i:02d}_use.go", f"package pkg\n\nfunc useA{i}() {{\n\tAlpha()\n}}\n")
    write(wt, "pkg/zz_use.go", "package pkg\n\nfunc useOmega() {\n\tOmega()\n}\n")
    monkeypatch.setattr(ctx, "MAX_CALLERS", 6)
    out = ctx.callers(wt, ["pkg/a.go"], {"Alpha", "Omega"})
    assert len(out) <= 6 and {"Alpha", "Omega"} <= {e["symbol"] for e in out}


# ------------------------------------------------------------------ R4 fallbacks

def test_go_helper_source_fallback_includes_apitestlib(tmp_path):
    wt = tmp_path / "wt"
    write(wt, "server/channels/api4/team.go", "package api4\n\nfunc renameTeam() {}\n")
    write(wt, "server/channels/api4/apitestlib.go",
          "package api4\n\nfunc Setup(tb testing.TB) *TestHelper {\n\treturn &TestHelper{}\n}\n")
    out = ctx.sibling_tests(wt, ["server/channels/api4/team.go"], {"renameTeam"})
    assert [e["file"] for e in out] == ["server/channels/api4/apitestlib.go"]


def test_helper_fallback_not_used_when_a_real_sibling_test_exists(tmp_path):
    wt = tmp_path / "wt"
    write(wt, "pkg/team.go", "package pkg\n\nfunc renameTeam() {}\n")
    write(wt, "pkg/team_test.go", "package pkg\n\nfunc TestTeam(t *testing.T) {}\n")
    write(wt, "pkg/testlib.go", "package pkg\n\nfunc Setup() {}\n")
    assert [e["file"] for e in ctx.sibling_tests(wt, ["pkg/team.go"], {"renameTeam"})] == ["pkg/team_test.go"]


def test_jest_sibling_fallback_same_dir_then_dunder_tests(tmp_path):
    wt = tmp_path / "wt"
    write(wt, "webapp/c/panel/panel.tsx", "export const Panel = () => null;\n")
    write(wt, "webapp/c/panel/other.test.tsx", "import {renderWithContext} from 'tests/helpers';\ntest('x', () => {});\n")
    out = ctx.sibling_tests(wt, ["webapp/c/panel/panel.tsx"], {"Panel2x"})
    assert [e["file"] for e in out] == ["webapp/c/panel/other.test.tsx"]

    wt2 = tmp_path / "wt2"
    write(wt2, "webapp/c/panel/panel.tsx", "export const Panel = () => null;\n")
    write(wt2, "webapp/c/__tests__/shared.test.tsx", "test('x', () => {});\n")
    out = ctx.sibling_tests(wt2, ["webapp/c/panel/panel.tsx"], {"Panel2x"})
    assert [e["file"] for e in out] == ["webapp/c/__tests__/shared.test.tsx"]


def test_sql_file_targets_sqlstore_package(tmp_path):
    wt = tmp_path / "wt"
    write(wt, "server/channels/store/sqlstore/store.go", "package sqlstore\n")
    write(wt, "server/channels/db/migrations/postgres/000150_x.up.sql", "ALTER TABLE a ADD b int;\n")
    t = ctx.test_targets(wt, ["server/channels/db/migrations/postgres/000150_x.up.sql"])
    assert t == [{"lang": "go", "dir": "server/channels/store/sqlstore",
                  "path": "server/channels/store/sqlstore/hunt_hunt<mode>_test.go", "package": "sqlstore"}]
    assert ctx.test_targets(tmp_path / "empty", ["db/migrations/x.sql"]) == []
