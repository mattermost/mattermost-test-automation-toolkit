# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""R4 tests: normalize_for_compare() and base_verdict() ephemeral log-ID normalization."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import run
from verdicts import Verdict

_HEAD_FAIL = {"pkg::TestHuntA_X": Verdict.FAIL_3_OF_3}


@pytest.mark.parametrize(
    ("head_msg", "base_msg"),
    [
        pytest.param(
            (
                "Messages: scope permissions=[] write_channels=[znxtf5fd7bys9xafezubcqfwxc "
                "q14auxhbopbu9f7i6iru5ikg7w rdhzhwhobidzmyhs4qu6f1d9pe]: "
                "edit_bookmark_private_channel allowed on channel q14auxhbopbu9f7i6iru5ikg7w the scope cannot read"
            ),
            (
                "Messages: scope permissions=[] write_channels=[4f8k9m2p7q1r3t5w6y8z0b1c2d "
                "9a8b7c6d5e4f3g2h1j0k9m8n7p 1q2w3e4r5t6y7u8i9o0p1a2s3d]: "
                "edit_bookmark_private_channel allowed on channel 9a8b7c6d5e4f3g2h1j0k9m8n7p the scope cannot read"
            ).replace("0", "3").replace("2", "4"),  # strict zbase32: no 0/2/l/v
            id="model_new_id_multi",
        ),
        pytest.param(
            "missing channel_znxtf5fd7bys9xafezubcqfwxc in store",
            "missing channel_k8m3p9q4r7t5w6y8z1b3c4d5f6 in store",
            id="model_new_id_underscore_boundary",
        ),
        pytest.param(
            "open postgres dbznxtf5fd7bys9xafezubcqfwxc: permission denied",
            "open postgres dbq14auxhbopbu9f7i6iru5ikg7w: permission denied",
            id="storetest_db_new_id",
        ),
        pytest.param(
            "drop database db02lvabcd1234efgh5678ijkl90 failed",
            "drop database db98zyxw7654utsr3210qpon99 failed",
            id="storetest_db_alnum_fallback",
        ),
        pytest.param(
            "unexpected token 550e8400-e29b-41d4-a716-446655440000 in payload",
            "unexpected token 11111111-2222-3333-4444-555555555555 in payload",
            id="uuid_lowercase",
        ),
        pytest.param(
            "unexpected token 550E8400-E29B-41D4-A716-446655440000 in payload",
            "unexpected token A1B2C3D4-E5F6-7890-ABCD-EF1234567890 in payload",
            id="uuid_uppercase",
        ),
        pytest.param(
            "Get \"http://127.0.0.1:54321/api/v4/users\": connection refused",
            "Get \"http://127.0.0.1:49152/api/v4/users\": connection refused",
            id="loopback_ipv4_port",
        ),
        pytest.param(
            "Get \"http://localhost:8065/api/v4/ping\": EOF",
            "Get \"http://localhost:18065/api/v4/ping\": EOF",
            id="loopback_localhost_port",
        ),
        pytest.param(
            "dial tcp [::1]:49152: connect: connection refused",
            "dial tcp [::1]:55123: connect: connection refused",
            id="loopback_ipv6_port",
        ),
        pytest.param(
            "stat /private/var/folders/3k/9x8y_7z/T/TestFoo123456789/001/x.json: no such file",
            "stat /tmp/TestFoo987654321/001/x.json: no such file",
            id="tmpdir_macos_vs_linux",
        ),
        pytest.param(
            "open /var/folders/ab/cd_1/T/run_12345/out.log: permission denied",
            "open /private/tmp/run_998877/out.log: permission denied",
            id="tmpdir_var_folders_vs_private_tmp",
        ),
        pytest.param(
            "container a1b2c3d4e5f6 exited with code 137",
            "container f6e5d4c3b2a1 exited with code 137",
            id="long_hex_12_container_id",
        ),
        pytest.param(
            "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7 failed",
            "trace 99887766554433221100aabbccddeeff span aabbccddeeff0011 failed",
            id="long_hex_otel_trace_and_span",
        ),
        pytest.param(
            "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 mismatch",
            "sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef mismatch",
            id="long_hex_64_sha256",
        ),
        pytest.param(
            "created_at=1700000000123 ns=1764212431123456789",
            "created_at=1700000009999 ns=1764212999987654321",
            id="epoch_millis_and_nanos",
        ),
        pytest.param(
            "got <ts> m=+0.012345678, want <ts> m=-0.500",
            "got <ts> m=+1.987654321, want <ts> m=+0.123",
            id="go_monotonic_clock_suffix",
        ),
        pytest.param(
            'id="postAttributeValueInput-f1-:r0:" aria-describedby="_r_1a_"',
            'id="postAttributeValueInput-f1-:r9:" aria-describedby="_r_2b_"',
            id="react_18_19_use_id",
        ),
        pytest.param(
            "focus target :R3: missing",
            "focus target :R12: missing",
            id="react_uppercase_use_id",
        ),
        pytest.param(
            '{"request_id": "req-12345678", "X-Correlation-ID": "corr99887766"} container_id=a1b2c3d4',
            '{"request_id": "req-87654321", "X-Correlation-ID": "corr11223344"} container_id=e5f6a7b8',
            id="keyed_request_correlation_container_ids",
        ),
        pytest.param(
            "trace_id=tr12345678 span_id=sp12345678 session_id=sess98765432 instance_id=inst12345678",
            "trace_id=tr87654321 span_id=sp87654321 session_id=sess12345678 instance_id=inst87654321",
            id="keyed_trace_span_session_instance_ids",
        ),
    ],
)
def test_base_verdict_normalizes_ephemeral_ids_to_pre_existing(head_msg: str, base_msg: str) -> None:
    verdict = run.base_verdict("pkg::TestHuntA_X", Verdict.FAIL, _HEAD_FAIL, {"pkg::TestHuntA_X": head_msg}, base_msg)
    assert verdict == Verdict.PRE_EXISTING


@pytest.mark.parametrize(
    ("head_msg", "base_msg"),
    [
        pytest.param("got 0x02, want 0x01", "got 0x04, want 0x01", id="short_hex_assertion"),
        pytest.param("0xdeadbeef", "0xcafebabe", id="8_hex_literal"),
        pytest.param("got 3, want 5", "got 7, want 5", id="small_integers"),
        pytest.param("expected 403, got 400", "expected 403, got 500", id="http_status_codes"),
        pytest.param("field charactersremainingcounter failed", "field charactersremainingxxxxxxx failed", id="26_char_words"),
        pytest.param("a" * 26, "b" * 26, id="repeated_26_chars"),
        pytest.param("reaction :rocket: missing", "reaction :rage: missing", id="mattermost_emojis"),
        pytest.param("selector :root: invalid", "selector :read: invalid", id="css_pseudo_tokens"),
        pytest.param("channel huntdmissingchannel0000000", "channel huntdmissingchannel0000001", id="deterministic_channel_id"),
        pytest.param("session_id=bad", "session_id=good", id="short_keyed_words"),
        pytest.param("open /tmp/a: fail", "open /tmp/b: fail", id="deterministic_tmp_subpaths"),
        pytest.param("ratio=0.1234567890123456", "ratio=0.9876543210987654", id="long_floats"),
        pytest.param("max=18446744073709551615", "max=18446744073709551614", id="20_digit_max_uint64"),
        pytest.param("hunt_huntb_test.go:42: fail", "hunt_huntb_test.go:99: fail", id="test_line_numbers"),
    ],
)
def test_base_verdict_preserves_deterministic_differences(head_msg: str, base_msg: str) -> None:
    assert run.normalize_for_compare(head_msg) != run.normalize_for_compare(base_msg)
    verdict = run.base_verdict("pkg::TestHuntA_X", Verdict.FAIL, _HEAD_FAIL, {"pkg::TestHuntA_X": head_msg}, base_msg)
    assert verdict == Verdict.BASE_FAILS_DIFFERENTLY


def test_cmd_run_preserves_raw_ids_while_cmd_base_classifies_pre_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    wt_head = tmp_path / "wt_head"
    wt_base = tmp_path / "wt_base"
    for wt in (wt_head, wt_base):
        (wt / "calc").mkdir(parents=True)
        (wt / "go.mod").write_text("module example.com/test\n\ngo 1.22\n")
    hdir = tmp_path / "hunt"
    (hdir / "A").mkdir(parents=True)
    test_src = "package calc\n\nimport \"testing\"\n\nfunc TestHuntA_Scope(t *testing.T) {}\n"
    (hdir / "A" / "response.json").write_text(json.dumps({
        "files": [{"path": "calc/hunt_hunta_test.go", "content": test_src}],
    }))
    state = {
        "wt": str(wt_head),
        "wt_base": str(wt_base),
        "targets": [{"dir": "calc", "lang": "go"}],
    }

    head_id = "znxtf5fd7bys9xafezubcqfwxc"
    head_uuid = "550e8400-e29b-41d4-a716-446655440000"
    head_port = "127.0.0.1:54321"
    head_tmp = "/tmp/TestScope123456789/001/x.json"

    base_id = "q14auxhbopbu9f7i6iru5ikg7w"
    base_uuid = "11111111-2222-3333-4444-555555555555"
    base_port = "127.0.0.1:49152"
    base_tmp = "/private/var/folders/3k/9x8y_7z/T/TestScope987654321/001/x.json"

    def _go_out(nid: str, uid: str, hostport: str, tmppath: str) -> str:
        return (
            "=== RUN   TestHuntA_Scope\n"
            f"    hunt_hunta_test.go:12: channel={nid} req={uid} url=http://{hostport}/ping file={tmppath}\n"
            "--- FAIL: TestHuntA_Scope (0.01s)\n"
            "FAIL\n"
            "FAIL\texample.com/test/calc\t0.012s\n"
        )

    def fake_sh(cmd: list[str], cwd: Path, check: bool = True, **kwargs: object) -> subprocess.CompletedProcess[str]:
        out = (
            _go_out(head_id, head_uuid, head_port, head_tmp)
            if cwd.resolve() == wt_head.resolve()
            else _go_out(base_id, base_uuid, base_port, base_tmp)
        )
        return subprocess.CompletedProcess(cmd, 1, stdout=out, stderr="")

    monkeypatch.setattr(run, "ensure_clean", lambda wt: None)
    monkeypatch.setattr(run, "sh", fake_sh)

    head_table = run.cmd_run(hdir, state, "A", runs=3)
    assert head_table == {"calc::TestHuntA_Scope": Verdict.FAIL_3_OF_3}

    raw_msgs = json.loads((hdir / "run_A.messages.json").read_text())
    raw_msg = raw_msgs["calc::TestHuntA_Scope"]
    for token in (head_id, head_uuid, head_port, head_tmp):
        assert token in raw_msg
    for placeholder in ("<id>", "<uuid>", "<port>", "<tmpdir>"):
        assert placeholder not in raw_msg

    base_verdicts = run.cmd_base(hdir, state, "A")
    assert base_verdicts["calc::TestHuntA_Scope"] == Verdict.PRE_EXISTING
