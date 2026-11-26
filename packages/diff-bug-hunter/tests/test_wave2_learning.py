# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Wave 2 learning lane: post-run lesson filter, candidate validation, fp/miss kinds, uuid ids, locked appends."""
from __future__ import annotations

import json
import threading

import lessons
import pytest

BASE = {"pattern": "p", "applies_to": {"lang": ["go"], "path_globs": ["server/a/*"]}, "keywords": ["k"],
        "symptom": "s", "check": "c", "source_pr": 1}


def test_post_filter_moves_matching_failures(tmp_path):
    hdir = tmp_path
    (hdir / "run_1.messages.json").write_text(json.dumps({"a::TestA": "boom: stale client config", "a::TestB": "other"}))
    (hdir / "run_2.messages.json").write_text(json.dumps({"a::TestA": "stale client config", "a::TestC": "nil deref"}))
    ls = [{"id": "L1", "kind": "fp", "failure_regex": "stale client config"},
          {"id": "L2", "kind": "miss", "failure_regex": "nil deref"},
          {"id": "L3", "pattern": "old row"}]
    assert lessons.post_filter(hdir, ls) == [{"test_id": "a::TestA", "lesson_id": "L1"}]
    assert lessons.counts_line(1, 2) == "lessons applied 1, matched 2"


def test_regex_lessons_leave_prompt_but_plain_fp_stay():
    ls = [{**BASE, "id": "A", "kind": "fp", "failure_regex": "x"}, {**BASE, "id": "B", "pattern": "q"}]
    ctx = {"changed_files_head_source": [{"file": "server/a/x.go"}], "diff_production_code": "k"}
    assert [m["id"] for m in lessons.match(ctx, ls)] == ["B"]


def test_validate_candidate_needs_reproducing_fixture(tmp_path):
    (tmp_path / "fp.txt").write_text("FAIL: stale client config\n")
    ok = {**BASE, "kind": "fp", "fixture": "fp.txt", "failure_regex": "stale client"}
    lessons.validate_candidate(ok, tmp_path)
    for bad, msg in [({**ok, "fixture": None}, "fixture"), ({**ok, "fixture": "nope.txt"}, "not found"),
                     ({**ok, "fixture": "../x"}, "escapes"), ({**ok, "failure_regex": "zzz"}, "reproduce"),
                     ({**ok, "failure_regex": "("}, "compile"), ({**ok, "kind": "other"}, "kind")]:
        with pytest.raises(ValueError, match=msg):
            lessons.validate_candidate(bad, tmp_path)
    lessons.validate_candidate({**BASE, "kind": "miss"}, tmp_path)  # miss needs no fixture
    with pytest.raises(ValueError, match="fixture"):
        lessons.add({**BASE, "kind": "fp"}, tmp_path / "l.jsonl", fixture_base=tmp_path)


def test_probes_for_returns_only_miss_lessons():
    ls = [{**BASE, "id": "M", "kind": "miss"}, {**BASE, "id": "F", "pattern": "f"}]
    diff = "+++ b/server/a/x.go\n+ call k()\n"
    assert [p["id"] for p in lessons.probes_for(diff, ls)] == ["M"]
    assert lessons.probes_for("+++ b/other.go\n+k\n", ls) == []
    assert "Probe:" in lessons.render_probes(lessons.probes_for(diff, ls))


def test_uuid_ids_and_locked_concurrent_appends(tmp_path):
    path = tmp_path / "l.jsonl"
    errors: list[Exception] = []

    def worker(i: int) -> None:
        try:
            lessons.add({**BASE, "pattern": f"p{i}"}, path)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors
    rows = [json.loads(x) for x in path.read_text().splitlines()]
    assert len(rows) == 20 and len({r["id"] for r in rows}) == 20
    with pytest.raises(ValueError, match="duplicate"):
        lessons.add({**BASE, "pattern": "p3"}, path)


def test_stale_by_file_hash(tmp_path):
    (tmp_path / "f.go").write_text("v1")
    ls = [{"id": "L", "matched_files": ["f.go"], "files_hash": lessons.files_hash(tmp_path, ["f.go"])},
          {"id": "N"}]
    assert lessons.stale(ls, tmp_path) == []
    (tmp_path / "f.go").write_text("v2")
    assert [r["retire"] for r in lessons.stale(ls, tmp_path)] == ["L"]
