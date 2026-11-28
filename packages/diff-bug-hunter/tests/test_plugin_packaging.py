# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Tests for marketplace plugin packaging, sync-marketplace.sh, and read-only plugin cache safety."""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import lessons
import pytest
import trusted

PKG_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = PKG_ROOT / ".claude" / "skills"


def test_skill_frontmatters_disable_model_invocation():
    for rel in ("hunt/SKILL.md", "verify/SKILL.md"):
        text = (SKILLS_ROOT / rel).read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1]
        assert "disable-model-invocation: true" in frontmatter


def test_sync_marketplace_allows_only_runtime_files_and_bumps_version(tmp_path: Path):
    mp = tmp_path / "marketplace"
    mp.mkdir()
    script = PKG_ROOT / "scripts" / "sync-marketplace.sh"
    subprocess.run(["bash", str(script), "--allow-branch", str(mp)], check=True)

    plugin = mp / "plugins" / "diff-bug-hunter"
    manifest_entries = [
        ln.strip() for ln in (PKG_ROOT / "plugin-manifest.txt").read_text().splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    for rel in manifest_entries:
        assert (plugin / "skills" / rel).is_file(), f"missing synced file: {rel}"

    assert not (plugin / "skills" / "hunt" / "scripts" / "eval_bugs.py").exists()
    assert not (plugin / "skills" / "hunt" / "scripts" / "skeptic_eval.py").exists()
    assert not list(plugin.rglob("__pycache__"))
    start_pg = plugin / "skills" / "hunt" / "scripts" / "start_pg.sh"
    assert start_pg.stat().st_mode & stat.S_IXUSR

    pjson = plugin / ".claude-plugin" / "plugin.json"
    assert json.loads(pjson.read_text())["version"] == "0.1.0"
    assert (plugin / "README.md").is_file()
    source_txt = (plugin / "SOURCE").read_text()
    assert "repository=https://github.com/mattermost/mattermost-test-automation-toolkit" in source_txt
    assert "commit=" in source_txt

    # Re-running without changes keeps 0.1.0; changing synced README triggers patch bump to 0.1.1
    subprocess.run(["bash", str(script), "--allow-branch", str(mp)], check=True)
    assert json.loads(pjson.read_text())["version"] == "0.1.0"
    (plugin / "README.md").write_text("changed\n")
    subprocess.run(["bash", str(script), "--allow-branch", str(mp)], check=True)
    assert json.loads(pjson.read_text())["version"] == "0.1.1"
    # Executable-bit change bumps patch version to 0.1.2
    start_pg.chmod(stat.S_IRUSR | stat.S_IWUSR)
    subprocess.run(["bash", str(script), "--allow-branch", str(mp)], check=True)
    assert json.loads(pjson.read_text())["version"] == "0.1.2"
    # Interrupted sync (stale content_hash in SOURCE) completes pending patch bump on retry
    src_file = plugin / "SOURCE"
    src_file.write_text("\n".join(
        "content_hash=stale" if ln.startswith("content_hash=") else ln
        for ln in src_file.read_text().splitlines()
    ) + "\n")
    subprocess.run(["bash", str(script), "--allow-branch", str(mp)], check=True)
    assert json.loads(pjson.read_text())["version"] == "0.1.3"


def test_read_only_plugin_cache_uses_state_overlay_and_passes_trusted_check(tmp_path: Path, monkeypatch):
    cached = tmp_path / "cache" / "diff-bug-hunter" / "skills"
    cached.parent.mkdir(parents=True)
    shutil.copytree(
        SKILLS_ROOT, cached,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".mypy_cache"),
    )
    (cached / "hunt" / "scripts" / "eval_bugs.py").unlink(missing_ok=True)
    (cached / "hunt" / "scripts" / "skeptic_eval.py").unlink(missing_ok=True)

    # Make entire cached skill directory strictly read-only
    all_paths = [cached, *sorted(cached.rglob("*"), reverse=True)]
    for p in all_paths:
        p.chmod(stat.S_IRUSR | stat.S_IXUSR if p.is_dir() else stat.S_IRUSR)

    state_dir = tmp_path / "state"
    scratch_dir = tmp_path / "scratch"
    hunt_skill = cached / "hunt"
    verify_skill = cached / "verify"

    try:
        # 1. trusted.check works on non-git read-only skill cache
        msg = trusted.check(hunt_skill)
        assert "not in a git repository" in msg
        assert (hunt_skill / "scripts" / ".." / ".." / "verify" / "scripts" / "pr_server.py").resolve() == (
            verify_skill / "scripts" / "pr_server.py"
        ).resolve()

        # 2. Running lessons.py against read-only cache writes only to HUNT_SCRATCH & HUNT_STATE_DIR overlay
        monkeypatch.setattr(lessons, "LESSONS_FILE", hunt_skill / "lessons.jsonl")
        monkeypatch.setattr(trusted, "SKILL_DIR", hunt_skill)
        monkeypatch.setenv("HUNT_STATE_DIR", str(state_dir))
        monkeypatch.setenv("HUNT_SCRATCH", str(scratch_dir))

        seed_count = len(_load_seed_lines(hunt_skill / "lessons.jsonl"))
        added = lessons.add({
            "kind": "miss",
            "pattern": "cache-overlay-pattern",
            "applies_to": {"lang": ["go"], "path_globs": ["server/channels/api4/*"]},
            "keywords": ["cache_overlay_kw"],
            "symptom": "sym",
            "check": "chk",
            "source_pr": 99999,
        })
        assert (state_dir / "lessons.jsonl").is_file()

        lessons.log_hits("99999", [added])
        assert (scratch_dir / "lessons_hits.jsonl").is_file()

        # Duplicate detection spans seed lessons + overlay
        with pytest.raises(ValueError, match="duplicate"):
            lessons.add({
                "kind": "miss",
                "pattern": "cache-overlay-pattern",
                "applies_to": {"lang": ["go"], "path_globs": ["server/channels/api4/*"]},
                "keywords": ["cache_overlay_kw"],
                "symptom": "sym",
                "check": "chk",
                "source_pr": 99999,
            })

        # Subprocess smoke test running cached lessons.py with write-protected LESSONS_FILE
        env = {
            **os.environ,
            "HUNT_STATE_DIR": str(state_dir),
            "HUNT_SCRATCH": str(scratch_dir),
            "HUNT_LESSONS_HITS": str(scratch_dir / "lessons_hits.jsonl"),
        }
        proc = subprocess.run(
            [sys.executable, str(hunt_skill / "scripts" / "lessons.py"), "prune", "--window", "1", "--write"],
            check=True, capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        assert seed_count >= 1
    finally:
        for p in sorted(cached.rglob("*")):
            p.chmod(stat.S_IRWXU if p.is_dir() else stat.S_IRUSR | stat.S_IWUSR)
        cached.chmod(stat.S_IRWXU)


def _load_seed_lines(path: Path) -> list[str]:
    return [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def test_sync_marketplace_rejects_unmanifested_local_import_before_mutating_dest(tmp_path: Path):
    pkg = tmp_path / "repo" / "packages" / "diff-bug-hunter"
    (pkg / "scripts").mkdir(parents=True)
    (pkg / "plugin").mkdir(parents=True)
    (pkg / ".claude" / "skills" / "hunt" / "scripts").mkdir(parents=True)
    shutil.copy2(PKG_ROOT / "scripts" / "sync-marketplace.sh", pkg / "scripts" / "sync-marketplace.sh")
    shutil.copy2(PKG_ROOT / "plugin" / "plugin.json", pkg / "plugin" / "plugin.json")
    (pkg / "plugin" / "README.md").write_text("seed\n")
    (pkg / "plugin-manifest.txt").write_text("hunt/scripts/a.py\n")
    (pkg / ".claude" / "skills" / "hunt" / "scripts" / "a.py").write_text("from . import helper\n")
    (pkg / ".claude" / "skills" / "hunt" / "scripts" / "helper.py").write_text("X = 1\n")

    repo_root = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo_root, check=True)
    subprocess.run(["git", "add", "."], cwd=repo_root, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], cwd=repo_root, check=True)

    mp = tmp_path / "mp"
    pjson = mp / "plugins" / "diff-bug-hunter" / ".claude-plugin" / "plugin.json"
    pjson.parent.mkdir(parents=True)
    pjson.write_text(json.dumps({"name": "diff-bug-hunter", "version": "0.1.0"}) + "\n")

    proc = subprocess.run(
        ["bash", str(pkg / "scripts" / "sync-marketplace.sh"), "--allow-branch", str(mp)],
        capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "un-manifested local module 'helper'" in proc.stderr
    assert json.loads(pjson.read_text())["version"] == "0.1.0"
    assert not (mp / "plugins" / "diff-bug-hunter" / "skills" / "hunt" / "scripts" / "a.py").exists()
