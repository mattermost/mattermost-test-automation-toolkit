# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Milestone M2 tests: Step 3 (skip/opt-in/$8 budget), Step 4 (Sonnet default, Skeptic Opus,
capped mechanical Opus escalation), Step 5 (schema caps & pruned prose), opt-in DISABLE_PROMPT_CACHING=1,
and offline 9/9 skeptic_eval."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import build_requests
import ctx
import dispatch
import hunt
import prepare
import pytest
import report
import skeptic_eval
import trusted
from conftest import (
    FAKE_DISPATCH,
    cli_json,
    make_repo,
)
from conftest import (
    canned_responses as _canned,
)
from conftest import (
    e2e_repo as _e2e_repo,
)
from conftest import (
    fake_script as _fake,
)
from hunt_common import SKILL_DIR, hunt_dir, scratch, write_json


def _inline_cli_json(answer: object, *, stop_reason: str = "end_turn", subtype: str = "success",
                     is_error: bool = False) -> str:
    return cli_json(answer, stop_reason=stop_reason, subtype=subtype, is_error=is_error, total_cost_usd=0.1,
                    usage={"input_tokens": 10, "cache_creation_input_tokens": 0,
                           "cache_read_input_tokens": 0, "output_tokens": 5})


# ------------------------------------------------------------------ Step 3: Budget, prompt_version, Skip, Mode D

def test_default_budget_is_8_dollars_in_hunt_and_skill():
    assert hunt.DEFAULT_BUDGET_USD == 8.0
    assert hunt.budget_usd() == 8.0
    skill = (SKILL_DIR / "SKILL.md").read_text()
    assert "$8" in skill and "$25" not in skill


def test_prompt_version_is_deterministic_and_sensitive_to_prompt_edits(tmp_path):
    skill = tmp_path / "skill"
    (skill / "prompts").mkdir(parents=True)
    (skill / "prompts" / "common.md").write_text("v1")
    (skill / "RELIABILITY.md").write_text("")
    (skill / "lessons.jsonl").write_text("")
    (skill / "vetted.schema.json").write_text("{}")
    (skill / "finding.schema.json").write_text("{}")

    v1 = build_requests.prompt_version(skill, 1)
    assert len(v1) == 16 and v1 == build_requests.prompt_version(skill, 1)
    (skill / "prompts" / "common.md").write_text("v2")
    v2 = build_requests.prompt_version(skill, 1)
    assert v2 != v1
    assert build_requests.prompt_version(skill, 2) != v2


def test_completed_hunt_skips_unless_force_or_prompt_version_changes(tmp_path, monkeypatch, capsys):
    _e2e_repo(tmp_path, "go_bug", monkeypatch)
    responses, log = _canned(tmp_path, "go_bug", "calc::TestHuntA_ClampRangeAndIdentity", "A")
    cmd = _fake(tmp_path, "fake_dispatch.py", FAKE_DISPATCH)
    monkeypatch.setenv("HUNT_DISPATCH_CMD", cmd)
    monkeypatch.setenv("FAKE_RESPONSES", str(responses))
    monkeypatch.setenv("FAKE_LOG", str(log))

    assert hunt.main(["hunt.py", "master..feature"]) == 0
    calls_first = log.read_text().splitlines()
    hdir = hunt_dir("master..feature")
    done_doc = json.loads((hdir / "hunt_done.json").read_text())
    assert done_doc["modes"] == ["A", "B", "R"]
    assert (scratch() / "hunted_index.jsonl").exists()
    capsys.readouterr()

    # Second run skips cleanly with 0 model calls.
    assert hunt.main(["hunt.py", "master..feature"]) == 0
    assert "skip: already hunted" in capsys.readouterr().out
    assert log.read_text().splitlines() == calls_first

    # Adding Mode D reuses A/B/R and runs D (vet reuses identical request sha).
    assert hunt.main(["hunt.py", "master..feature", "--modes", "A,B,D"]) == 0
    calls_after_d = log.read_text().splitlines()
    assert calls_after_d[len(calls_first):] == ["D"]
    assert json.loads((hdir / "hunt_done.json").read_text())["modes"] == ["A", "B", "D"]

    # Prompt version change invalidates completed-hunt skip & prepare cache.
    for p in (hdir / "prepare.json", hdir / "hunt_done.json"):
        doc = json.loads(p.read_text())
        doc["prompt_version"] = "oldpv00000000001"
        p.write_text(json.dumps(doc))
    assert hunt.main(["hunt.py", "master..feature"]) == 0
    calls_after_pv = log.read_text().splitlines()
    assert len(calls_after_pv) > len(calls_after_d)

    # --force re-runs a completed hunt even when prompt_version matches.
    assert hunt.main(["hunt.py", "master..feature", "--force"]) == 0
    assert len(log.read_text().splitlines()) > len(calls_after_pv)


def test_docs_and_webapp_test_only_diffs_skip_npm_ci_and_exit_zero(tmp_path, monkeypatch, capsys):
    repo = make_repo(
        tmp_path,
        {"README.md": "hello\n", "webapp/channels/src/a.test.tsx": "test('x', () => {})\n"},
        {"README.md": "updated docs\n", "webapp/channels/src/a.test.tsx": "test('x', () => { expect(1).toBe(1); })\n"},
        head_msg="docs and test only",
    )

    monkeypatch.setenv("HUNT_MM", str(repo))
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    monkeypatch.setattr(prepare, "webapp_deps", lambda *a, **k: pytest.fail("npm ci must not run"))
    monkeypatch.setattr(prepare, "go_work", lambda *a, **k: pytest.fail("go_work must not run"))
    monkeypatch.setattr(prepare, "services_up", lambda *a, **k: pytest.fail("services_up must not run"))
    monkeypatch.setattr(ctx, "caller_counts", lambda *a, **k: pytest.fail("caller_counts must not run"))

    prepare.main("master..feature")
    hdir = hunt_dir("master..feature")
    prep = json.loads((hdir / "prepare.json").read_text())
    assert prep["huntable_files"] == 0

    st = ctx.build("master..feature", 1, prep, {"title": "docs", "body": ""})
    assert st["batches"] == 0 and st["skipped_diff"] is True
    assert (hdir / "skipped.log").exists()

    monkeypatch.setattr(hunt.dispatch, "dispatch", lambda *a, **k: pytest.fail("model must not be called"))
    assert hunt.main(["hunt.py", "master..feature"]) == 0
    assert "skip: no huntable source files" in capsys.readouterr().out


def test_parse_modes_rejects_invalid_and_cli_returns_1():
    assert hunt.parse_modes("d,a") == ("A", "D")
    assert hunt.parse_modes("Z") is None
    assert hunt.parse_modes("") is None
    assert hunt.main(["hunt.py", "master..feature", "--modes", "Z"]) == 1


# ------------------------------------------------------------------ Step 4: Sonnet default, Skeptic Opus, --model, Schema & Escalation

def test_request_tiers_default_sonnet_skeptic_opus_and_retry_repair_preserve(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {
        "pr": "1", "wt": str(tmp_path), "wt_base": str(tmp_path), "head": "h", "merge_base": "b",
        "targets": [{"lang": "go", "dir": "calc", "path": "calc/hunt_hunt<mode>_test.go", "package": "calc"}],
    })
    write_json(hdir / "ctx.json", {
        "pr": {"number": 1, "title": "t", "description": "d"},
        "diff_production_code": "", "changed_files_head_source": [],
        "sibling_tests_and_helpers": [], "callers": [], "your_test_files": [],
        "all_changed_files": [], "pr_tests_diff": [], "neighbors_same_file": [], "changed_functions_base_source": [],
    })
    monkeypatch.setenv("HUNT_TRUSTED_REF", trusted.WORKTREE)
    monkeypatch.setattr(build_requests, "hunt_dir", lambda pr: hdir)

    build_requests.main("1", "hunters")
    build_requests.main("1", "diff")
    assert json.loads((hdir / "A" / "request.json").read_text())["tier"] == "sonnet"
    assert json.loads((hdir / "B" / "request.json").read_text())["tier"] == "sonnet"
    assert json.loads((hdir / "D" / "request.json").read_text())["tier"] == "sonnet"

    # Retry preserves sonnet by default, or opus if escalated.
    write_json(hdir / "A" / "response.json", {"files": [], "tests": []})
    build_requests.main("1", "retry", "A")
    assert json.loads((hdir / "A" / "request.retry.json").read_text())["tier"] == "sonnet"

    write_json(hdir / "A" / "request.opus.json", {"tier": "opus"})
    (hdir / "compile_A.log").write_text("err")
    build_requests.main("1", "repair", "A")
    assert json.loads((hdir / "A" / "request.repair.json").read_text())["tier"] == "opus"


def test_dispatch_passes_model_after_system_prompt_and_logs_telemetry(tmp_path, monkeypatch):
    seen: dict[str, object] = {}

    def fake_run(argv, **kw):
        seen["argv"] = argv
        seen["has_env"] = "env" in kw
        return subprocess.CompletedProcess(
            argv, 0, stdout=_inline_cli_json({"files": [], "tests": []}, stop_reason="end_turn"), stderr="",
        )

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.delenv("DISABLE_PROMPT_CACHING", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)

    hdir = tmp_path / "hunt"
    req = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    res = dispatch.dispatch(req, hdir=hdir, tag="A", strict_schema=True)
    argv = list(seen["argv"])  # type: ignore[arg-type]
    sys_idx = argv.index("--system-prompt-file")
    model_idx = argv.index("--model")
    assert model_idx > sys_idx and argv[model_idx + 1] == "sonnet"
    assert seen["has_env"] is False
    assert res.model == "sonnet" and res.effort_tier == "sonnet" and res.stop_reason == "end_turn"
    assert res.schema_errors == []
    trow = json.loads((hdir / "telemetry.jsonl").read_text().splitlines()[-1])
    assert (trow["model"], trow["effort_tier"], trow["stop_reason"], trow["schema_valid"]) == (
        "sonnet", "sonnet", "end_turn", True,
    )


def test_disable_prompt_caching_env_and_flag(tmp_path, monkeypatch):
    envs: list[dict[str, str] | None] = []

    def fake_run(argv, **kw):
        envs.append(kw.get("env"))
        return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"files": [], "tests": []}), stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)

    hdir = tmp_path / "hunt"
    req_a = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    dispatch.dispatch(req_a, hdir=hdir, tag="A", no_prompt_cache=True)
    assert envs[-1] is not None and envs[-1]["DISABLE_PROMPT_CACHING"] == "1"

    monkeypatch.setenv("DISABLE_PROMPT_CACHING", "1")
    req_b = build_requests.write(hdir, "B", "sys", {"x": 2}, build_requests.HUNTER_SCHEMA)
    dispatch.dispatch(req_b, hdir=hdir, tag="B")
    assert envs[-1] is not None and envs[-1]["DISABLE_PROMPT_CACHING"] == "1"

    # CLI flag works on dispatch.py
    req_d = build_requests.write(hdir, "D", "sys", {"x": 3}, build_requests.HUNTER_SCHEMA)
    monkeypatch.delenv("DISABLE_PROMPT_CACHING", raising=False)
    assert dispatch.main(["dispatch.py", str(req_d), "--tag", "D", "--no-prompt-cache"]) == 0
    assert envs[-1] is not None and envs[-1]["DISABLE_PROMPT_CACHING"] == "1"


def test_escalation_schema_fail_capped_at_one_and_preserves_clean_tier(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "head": "h", "merge_base": "b", "batches": 1, "changed": ["calc/a.go"]})
    write_json(hdir / "ctx.json", {"diff_production_code": ""})
    build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    build_requests.write(hdir, "B", "sys", {"x": 2}, build_requests.HUNTER_SCHEMA)

    def fake_run(argv, **kw):
        model = argv[argv.index("--model") + 1]
        if model == "sonnet":
            # Invalid: missing required "files"
            return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"wrong": 1}), stderr="")
        return subprocess.CompletedProcess(
            argv, 0, stdout=_inline_cli_json({"files": [{"path": "calc/a_test.go", "content": "func TestA() {}"}],
                                              "tests": []}), stderr="",
        )

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)

    hunt.stage_dispatch(hdir, ("A", "B"))
    drv = json.loads((hdir / "driver.json").read_text())
    # Cap at 1: A escalated to Opus and succeeded; B stayed unescalated with a dispatch gap.
    assert len(drv["escalations"]) == 1
    assert drv["escalations"][0] == {"tag": "A", "reason": "schema_validation_failed", "from_tier": "sonnet",
                                     "to_tier": "opus"}
    assert "dispatch:A" not in drv["gaps"] and "dispatch:B" in drv["gaps"]
    assert (hdir / "A" / "request.opus.json").exists()
    assert hunt.dispatched(hdir, ("A",)) is True

    # Escalations alone NEVER degrade High-Confidence Clean.
    write_json(hdir / "driver.json", {"gaps": {}, "escalations": drv["escalations"], "modes": ["A", "B"]})
    write_json(hdir / "run_A.json", {"calc::TestA": "PASS"})
    write_json(hdir / "run_B.json", {"calc::TestB": "PASS"})
    write_json(hdir / "run_A.coverage.json", {"reached": 1, "executable": 1})
    write_json(hdir / "verdict.json", {"vetted_present": True, "keep": [], "held": []})
    out = report.write(hdir, "1")
    assert out["tier"] == "High-Confidence Clean"


def test_escalation_triggers_max_tokens_uncited_line_and_risky_empty(tmp_path, monkeypatch):
    # (b) max_tokens
    h_mt = tmp_path / "mt"
    write_json(h_mt / "state.json", {"pr": "1", "batches": 1, "changed": []})
    write_json(h_mt / "ctx.json", {"diff_production_code": ""})
    build_requests.write(h_mt, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)

    def fake_mt(argv, **kw):
        model = argv[argv.index("--model") + 1]
        sr = "max_tokens" if model == "sonnet" else "end_turn"
        return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"files": [], "tests": []}, stop_reason=sr),
                                           stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_mt)
    hunt.stage_dispatch(h_mt, ("A",))
    assert json.loads((h_mt / "driver.json").read_text())["escalations"][0]["reason"] == "max_tokens"

    # (c) cited line not in diff/context
    h_cite = tmp_path / "cite"
    req_c = build_requests.write(
        h_cite, "R", "sys",
        {"diff_production_code": "diff --git a/pkg1/f1.go b/pkg1/f1.go\n@@ -10,2 +10,2 @@\n-a\n+b\n",
         "thread_files_head_source": [{"file": "pkg2/extra.go", "source": "    4  func Extra() {}"}],
         "review_threads": [{"path": "pkg2/extra.go", "line": 4}]},
        build_requests.REVIEW_SCHEMA,
    )
    resp_c = h_cite / "R" / "response.json"
    write_json(resp_c, {"files": [], "claims": [], "tests": [
        {"test_name": "T1", "source": "CR1 pkg2/extra.go:4"},
    ]})
    assert hunt._has_uncited_line(req_c, resp_c) is False  # batch-2 Mode R citation is valid
    write_json(resp_c, {"files": [], "claims": [], "tests": [
        {"test_name": "T1", "source": "pkg1/f1.go:999"},
    ]})
    assert hunt._has_uncited_line(req_c, resp_c) is True

    # (d) empty on risky file
    h_risk = tmp_path / "risk"
    write_json(h_risk / "state.json", {"pr": "1", "batches": 1, "changed": ["server/channels/api4/auth.go"]})
    write_json(h_risk / "ctx.json", {"diff_production_code": "diff --git a/server/channels/api4/auth.go b/server/channels/api4/auth.go\n@@ -1,1 +1,2 @@\n+func CheckPermission() {}\n"})
    assert hunt._batch_has_risky_file(h_risk) is True


def test_escalation_mode_a_empty_after_retry_and_mode_v(tmp_path, monkeypatch):
    hdir = tmp_path / "hunt"
    write_json(hdir / "state.json", {"pr": "1", "batches": 1, "changed": []})
    req_a = build_requests.write(hdir, "A", "sys", {"x": 1}, build_requests.HUNTER_SCHEMA)
    write_json(hdir / "A" / "response.json", {"files": [], "tests": []})
    dispatch.sidecar(req_a).write_text(dispatch.request_sha(req_a))

    calls: list[str] = []

    def fake_script(name, *args):
        if name == "run.py" and args[:2] == ("run", "1"):
            if (hdir / "A" / "request.opus.json").exists():
                write_json(hdir / "run_A.json", {"calc::TestHuntA_Opus": "PASS"})
                return subprocess.CompletedProcess([], 0, stdout="PASS\n", stderr="")
            return subprocess.CompletedProcess([], 0, stdout="EMPTY_RESPONSE\n", stderr="")
        if name == "build_requests.py" and args[1] == "retry":
            build_requests.write_request(hdir / "A" / "request.retry.json", "sys", {"x": 1},
                                         build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
            return subprocess.CompletedProcess([], 0, stdout="ok\n", stderr="")
        return subprocess.CompletedProcess([], 0, stdout="", stderr="")

    def fake_dispatch(hdir_, tag, req, *, strict_schema=False, no_prompt_cache=None):
        calls.append(f"{tag}:{req.name}")
        return True, dispatch.DispatchResult(status="ok", model="opus" if "opus" in req.name else "sonnet"), None

    monkeypatch.setattr(hunt, "script", fake_script)
    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    hunt.run_tag("1", hdir, "A", retry_empty=True)
    assert calls == ["A:retry:request.retry.json", "A:request.opus.json"]
    drv = json.loads((hdir / "driver.json").read_text())
    assert drv["escalations"][0]["reason"] == "empty_after_retry"
    assert "empty:A" not in drv["gaps"]


def test_escalation_mode_v_schema_failure_to_opus(tmp_path, monkeypatch):
    # Mode V schema failure escalates to Opus.
    h_v = tmp_path / "hv"
    write_json(h_v / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(h_v / "base_A.json", {"calc::TestA": "NEW_PR_BUG"})
    write_json(h_v / "A" / "response.json", {"files": [{"path": "calc/a_test.go", "content": "func TestA() {}"}]})

    def fake_v_run(argv, **kw):
        model = argv[argv.index("--model") + 1]
        if model == "sonnet":
            return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"bad": 1}), stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"files": [], "tests": []}), stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_v_run)
    monkeypatch.setattr(hunt, "script", lambda *a: subprocess.CompletedProcess([], 0, stdout="", stderr=""))
    hunt.stage_v("1", h_v)
    assert json.loads((h_v / "driver.json").read_text())["escalations"][0] == {
        "tag": "V", "reason": "schema_validation_failed", "from_tier": "sonnet", "to_tier": "opus",
    }


# ------------------------------------------------------------------ Step 5 & Skeptic Eval 9/9

def test_step5_schemas_enforce_caps_and_prompts_drop_checks():
    assert "checks" not in json.dumps(build_requests.HUNTER_SCHEMA)
    assert "checks" not in json.dumps(build_requests.REVIEW_SCHEMA)
    for p in ("prompts/common.md", "prompts/mode_r.md", "prompts/mode_a.md", "prompts/mode_d.md"):
        assert "checks" not in (SKILL_DIR / p).read_text(), p
    assert "checks" not in build_requests.V_SYSTEM

    # Caps reject oversized arrays/strings
    assert dispatch.validate_schema({"files": [{"path": "a", "content": "b"}] * 9}, build_requests.HUNTER_SCHEMA)
    assert dispatch.validate_schema({"files": [{"path": "a", "content": "x" * 32001}]}, build_requests.HUNTER_SCHEMA)
    vet_schema = json.loads((SKILL_DIR / "vetted.schema.json").read_text())
    assert vet_schema["properties"]["rows"]["maxItems"] == 30
    valid_row = {
        "id": "pkg::TestA", "source": "A", "decision": "KEEP", "reason": "bug",
        "file_line": "pkg/a.go:1", "caller": "F", "entry_point": "API",
        "repro_cmd": "go test ./pkg -run ^TestA$ -count=1", "evidence_path": "run_A.json",
        "severity": "major", "fix_check": None,
    }
    assert dispatch.validate_schema({"rows": [valid_row] * 30}, vet_schema) == []
    cap_errs = dispatch.validate_schema({"rows": [valid_row] * 31}, vet_schema)
    assert cap_errs and any("maxItems" in e for e in cap_errs)

    # Legacy fixtures with _note and tests[].checks still validate
    fixture_resp = json.loads((Path(__file__).parent / "hunt_fixtures" / "go_bug" / "responses" / "A" / "response.json").read_text())
    assert dispatch.validate_schema(fixture_resp, build_requests.HUNTER_SCHEMA) == []


def test_skeptic_eval_uses_opus_and_scores_9_of_9(tmp_path, monkeypatch):
    seen_tiers: list[str] = []
    seen_argv: list[list[str]] = []

    def fake_run(argv, **kw):
        seen_argv.append(list(argv))
        req = json.loads((Path(kw["cwd"]) / "request.json").read_text())
        seen_tiers.append(req["tier"])
        user = json.loads(req["user"])
        # Match checked-in labels for offline verification of request/schema/scoring pipeline
        drop_ids = {
            "server/channels/app::TestHuntB_WriteDeniedWhenScopeCannotReadChannel",
            "server/channels/app::TestHuntD_HealthCheckWatcherPollByLicense",
        }
        rows = []
        for c in user["candidates"]:
            cid = c["id"]
            dec = "DROP" if cid in drop_ids else "KEEP"
            desc = str(user.get("pr", {}).get("description", ""))
            row = {
                "id": cid, "source": c["source"], "decision": dec, "reason": "ok",
                "file_line": "a.go:1", "caller": "c", "entry_point": "e", "repro_cmd": c["repro_cmd"],
                "evidence_path": "run_A.json", "severity": "major", "fix_check": None,
                "reason_code": "INTENDED" if dec == "DROP" else "BUG",
                "evidence_quote": desc[:200] if dec == "DROP" else "",
            }
            rows.append(row)
        assert dispatch.validate_schema({"rows": rows}, req["schema"]) == []
        return subprocess.CompletedProcess(argv, 0, stdout=_inline_cli_json({"rows": rows}), stderr="")

    monkeypatch.delenv("HUNT_DISPATCH_CMD", raising=False)
    monkeypatch.setattr(dispatch.subprocess, "run", fake_run)
    out = tmp_path / "out"
    rc = skeptic_eval.main(["skeptic_eval.py", "--out", str(out)])
    assert rc == 0
    assert seen_tiers == ["opus", "opus", "opus"]
    assert all(a[a.index("--model") + 1] == "opus" for a in seen_argv)
    card = json.loads((out / "skeptic_scorecard.json").read_text())
    assert card["totals"] == {"pass": 9, "held": 0, "FAIL": 0}


# ------------------------------------------------------------------ M2 minor cleanup regressions

def test_requests_done_requires_r_artifacts_when_r_added_to_modes(tmp_path):
    hdir = tmp_path / "h"
    write_json(hdir / "A" / "request.json", {})
    write_json(hdir / "B" / "request.json", {})
    assert not hunt._requests_done(hdir, ("A", "B", "R"))
    write_json(hdir / "R" / "threads.json", {"threads": []})
    assert hunt._requests_done(hdir, ("A", "B", "R"))


def test_escalate_tag_does_not_burn_cap_when_over_budget(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    build_requests.write_request(hdir / "A" / "request.json", "sys", {"x": 1},
                                 build_requests.HUNTER_SCHEMA, hdir / "A" / "response.json")
    monkeypatch.setattr(hunt, "over_budget", lambda _hdir: True)
    ok, res, err = hunt.escalate_tag(hdir, "A", "schema_validation_failed")
    assert (ok, res, err) == (False, None, None)
    assert not (hdir / "A" / "request.opus.json").exists()
    assert hunt.can_escalate(hdir)


def test_stage_v_resume_honors_existing_request_opus_json(tmp_path, monkeypatch):
    hdir = tmp_path / "h"
    write_json(hdir / "state.json", {"pr": "1", "wt": str(tmp_path), "batches": 1})
    write_json(hdir / "base_A.json", {"calc::TestA": "NEW_PR_BUG"})
    write_json(hdir / "A" / "response.json", {"files": [{"path": "calc/a_test.go", "content": "func TestA() {}"}]})
    opus_req = build_requests.write_request(
        hdir / "V" / "request.opus.json", hunt.V_SYSTEM, {"candidates": []},
        build_requests.HUNTER_SCHEMA, hdir / "V" / "response.json", tier="opus")

    seen_reqs: list[Path] = []

    def fake_dispatch(_hdir, _tag, req, *, strict_schema=False, no_prompt_cache=None):
        seen_reqs.append(req)
        return True, dispatch.DispatchResult(status="ok", model="opus"), None

    monkeypatch.setattr(hunt, "dispatch_with_result", fake_dispatch)
    monkeypatch.setattr(hunt, "script", lambda *a: subprocess.CompletedProcess([], 0, stdout="", stderr=""))
    hunt.stage_v("1", hdir)
    assert seen_reqs == [opus_req]
    assert not (hdir / "V" / "request.json").exists()
