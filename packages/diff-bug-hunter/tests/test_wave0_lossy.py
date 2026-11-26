"""Wave 0 lossy reads: undecodable bytes must not raise UnicodeDecodeError."""
from __future__ import annotations

import ctx
import hunt_common
import run

BAD = b"\xff\xfe"


def test_read_text_lossy(tmp_path):
    p = tmp_path / "a.txt"
    p.write_bytes(BAD)
    assert hunt_common.read_text_lossy(p) == "��"


def test_load_json_lossy(tmp_path):
    p = tmp_path / "a.json"
    p.write_bytes(b'{"k": "\xff\xfe"}')
    assert hunt_common.load_json(p) == {"k": "��"}


def test_read_records_lossy(tmp_path):
    p = tmp_path / "rec.jsonl"
    p.write_bytes(BAD + b"\n" + b'{"test": "t", "i": 1, "v": "\xff"}\n')
    assert run.read_records(p) == {"t": {1: {"v": "�"}}}


def test_test_targets_lossy(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.go").write_bytes(b"package \xff\xfe\n// package foo\n" + b"package foo\n")
    out = ctx.test_targets(tmp_path, ["pkg/a.go"])
    assert out and out[0]["lang"] == "go"
