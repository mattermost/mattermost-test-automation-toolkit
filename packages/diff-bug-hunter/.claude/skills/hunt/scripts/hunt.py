#!/usr/bin/env python3
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
"""Unattended driver: a deterministic state machine over the hunt scripts. The model answers only the requests it is
given (hunters, Mode V diagnostics, the skeptic); every other step is a script.

usage: hunt.py <pr | base..head | base...head> [--fresh]
       hunt.py --help

Stages. A stage whose output exists is skipped, so running again resumes at the first missing output:
  prepare    prepare.py (exit 4 = results for this head exist: resume; exit 5 = SCHEMA_MISMATCH: stop, or --fresh)
  ctx        ctx.py                                     -> ctx.json
  requests   build_requests.py review, hunters, diff    -> A/, B/, D/ (and R/ when it qualifies)
  dispatch   dispatch.py for each request, in parallel  -> <tag>/response.json (idempotent per request)
  run        run.py run A (EMPTY retry, COMPILE repair), run.py run B, run.py diff D, run.py run R
  base       run.py base <tag> for each tag with FAIL_3_OF_3 tests
  old_tests  old_tests.py                                -> old_tests.json
  pr_tests   pr_tests.py                                 -> pr_tests.json
  vet_v      Mode V: one request writes hunt_v tests for the A/B NEW_PR_BUG candidates; run.py run V, run.py base V
  vet        the skeptic decides KEEP/DROP/HELD per candidate                 -> vetted.json
  verdict    verdict.admissibility + lessons.post_filter                      -> verdict.json
  report     report.py                                                         -> findings.json, audit.md

Every stage runs inside telemetry.stage (telemetry.jsonl); dispatch rows carry tokens and cost. Gaps (a hunter that
wrote no response, a COMPILE_ERROR after its repair round) are kept in driver.json and degrade the confidence tier.
Circuit breaker: once the hunt's model calls have cost $HUNT_BUDGET_USD (default 25, about 3x the highest measured
hunt, $8.32 on PR 40256), no further call is made; the hunt finishes on what it has, as Partial with a `budget` gap.
Exit codes: 0 done, 1 usage, 2 INFRA_ERROR, 5 SCHEMA_MISMATCH. A second driver on the same target stops with
INFRA_ERROR. The trust gate (trusted.check) runs first.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True
if not sys.pycache_prefix:
    sys.pycache_prefix = "/dev/null/hunt-pyc"

import concurrent.futures
import fcntl
import json
import os
import shlex
import signal
import subprocess
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import build_requests
import dispatch
import lessons
import report
import telemetry
import trusted
import verdict
from hunt_common import SKILL_DIR, InfraError, hunt_dir, read_dict, terminate_handler, write_json

SCRIPTS = Path(__file__).resolve().parent
HUNTER_TAGS = ("A", "B", "D", "R")
BASE_TAGS = ("A", "B", "R")
MAX_PAYLOAD_CHARS = 20000  # per request: a candidate's test source and failure text, capped so a request stays readable

V_SYSTEM = (
    "You are the diagnostic step of a bug hunt. Each candidate below is a test that failed 3 of 3 times on the PR head "
    "and passed on the merge-base. Write exactly one bounded diagnostic test per candidate. It must isolate the root "
    "cause with the smallest input, use only the code given in this request, and assert the merge-base behaviour that "
    "the candidate asserts. Name Go tests TestHuntV_<Name> and Jest tests 'HuntV_<name>' (the title must start with HuntV_), in the same package or "
    "component directory as the candidate. Report only what the test shows, never the PR's intent. Put the tests in "
    "the `files` array and describe each in `tests`. Output one JSON object matching the schema, nothing else."
)
SKEPTIC_SYSTEM = (
    "You are the skeptic of a bug hunt. For each candidate, decide KEEP, DROP or HELD. The request gives the PR's "
    "title and description, the production diff, callers of the changed code (an `entry_point: true` caller is an API "
    "route, websocket handler, plugin hook or UI entry), and per candidate the test source, its head failure or "
    "differential examples, and the command that reproduces it. "
    "KEEP when the failure is a behaviour a production user or caller can hit and the PR's description does not ask "
    "for it: name the real caller in `caller`, the entry point in `entry_point` (API route, UI component or screen, "
    "job, plugin hook), the root-cause `file_line` from the diff, and copy the candidate's `repro_cmd`. "
    "DROP when the evidence shows intended behaviour (the description or diff asks for it), a test that asserts the "
    "wrong thing, or input no caller can produce. HELD only when the request lacks something you need to decide; "
    "say what in `reason`. A candidate with mechanical_verdict NEW_API has no merge-base to compare with: KEEP it "
    "only when the failing assertion contradicts the PR's own description or an existing invariant shown in the "
    "diff. Give `reason` in one or two sentences. Copy the candidate's `id` and `source`. Set `evidence_path` to "
    "the artifact the evidence came from, and `fix_check` to null. Output JSON {\"rows\": [...]} matching the "
    "schema, one row per candidate, and nothing else. "
    "Every row also carries `reason_code` and `evidence_quote`, which code checks: KEEP uses BUG. A DROP must use "
    "INTENDED (evidence_quote is copied verbatim from the PR description, the production diff or pr_tests_diff), "
    "UNREACHABLE (evidence_quote names the guard, copied verbatim from the diff or a caller's source) or "
    "WRONG_ASSERTION (evidence_quote is the wrong assertion, copied verbatim from the candidate's test_source). "
    "HELD uses NEEDS_INPUT. A DROP whose quote is not found verbatim is held, not dropped."
)


DEFAULT_BUDGET_USD = 25.0


class Stop(RuntimeError):
    """A stop that is not an infrastructure failure: the exit code is given."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


# ------------------------------------------------------------------ small helpers

def script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    """Run one hunt script from the scripts directory, streaming its output into the driver's log."""
    p = subprocess.run([sys.executable, str(SCRIPTS / name), *args], cwd=SCRIPTS, capture_output=True, text=True,
                       errors="replace", check=False)
    print(p.stdout, end="")
    if p.stderr:
        print(p.stderr, end="", file=sys.stderr)
    return p


def expect_ok(p: subprocess.CompletedProcess[str], what: str) -> None:
    """Exit 0 is success. Anything else from a script is an environment or usage failure: stop, do not guess."""
    if p.returncode != 0:
        tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
        raise InfraError(f"{what} exited {p.returncode}: {tail[0][:400]}")


_GAP_LOCK = threading.Lock()  # dispatch threads record gaps concurrently


def set_gap(hdir: Path, key: str, message: str | None) -> None:
    """Record (or, with None, clear) a gap for the audit. Keyed, so a resumed run overwrites instead of duplicating.
    Serialized and written atomically: parallel hunters must not read a half-written file or lose each other's gap."""
    with _GAP_LOCK:
        path = hdir / "driver.json"
        gaps = read_dict(path).get("gaps", {})
        if message is None:
            gaps.pop(key, None)
        else:
            gaps[key] = message
        tmp = path.with_name(path.name + ".tmp")
        write_json(tmp, {"gaps": gaps})
        os.replace(tmp, path)


@contextmanager
def driver_lock(hdir: Path, target: str) -> Iterator[None]:
    """One driver per target. Separate from .lock: the child scripts take .lock, and this process holds this one."""
    hdir.mkdir(parents=True, exist_ok=True)
    with (hdir / ".driver.lock").open("w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise InfraError(f"another hunt driver is running for {target}") from e
        yield


def step(hdir: Path, name: str, done: Callable[[], bool], body: Callable[[], object]) -> None:
    if done():
        print(f"[{name}] resume: output exists, skipped")
        return
    with telemetry.stage(hdir, f"step:{name}"):
        body()


def budget_usd() -> float:
    try:
        return float(os.environ.get("HUNT_BUDGET_USD", DEFAULT_BUDGET_USD))
    except ValueError:
        return DEFAULT_BUDGET_USD


def over_budget(hdir: Path) -> bool:
    """True once this hunt's model calls have cost the budget. Records the `budget` gap the first time."""
    spent = float(telemetry.summarize(hdir).get("total_cost_usd") or 0.0)
    if spent < budget_usd():
        set_gap(hdir, "budget", None)
        return False
    set_gap(hdir, "budget", f"model calls cost ${spent:.2f}, budget ${budget_usd():.2f} (HUNT_BUDGET_USD): "
                            "later calls not made")
    return True


def dispatch_one(hdir: Path, tag: str, request: Path) -> bool:
    """One model call for one request. A failed call is a gap, not a stop: the hunter is reported as failed."""
    if over_budget(hdir):
        print(f"[dispatch {tag}] skipped: budget reached")
        return False
    try:
        res = dispatch.dispatch(request, hdir=hdir, tag=tag)
    except dispatch.DispatchError as e:
        print(f"[dispatch {tag}] FAILED {str(e)[:300]}")
        set_gap(hdir, f"dispatch:{tag}", str(e)[:500])
        return False
    print(f"[dispatch {tag}] {res.status} retries={res.retries} tokens_in={res.tokens_in} "
          f"cache_write={res.cache_write} cache_read={res.cache_read} tokens_out={res.tokens_out}")
    set_gap(hdir, f"dispatch:{tag}", None)
    return True


# ------------------------------------------------------------------ stages

def stage_prepare(target: str, hdir: Path, fresh: bool) -> None:
    p = script("prepare.py", target, *(["--fresh"] if fresh else []))
    if p.returncode == 5:
        raise Stop(5, "SCHEMA_MISMATCH: this hunt dir was prepared by another schema; pass --fresh to start over")
    if p.returncode == 4:  # results for this head exist: resume from the first missing output
        return
    expect_ok(p, "prepare.py")


def stage_requests(target: str, hdir: Path) -> None:
    # Review first: a failure there leaves no hunter request behind, so the next run builds everything again.
    expect_ok(script("build_requests.py", target, "review"), "build_requests review")
    expect_ok(script("build_requests.py", target, "hunters"), "build_requests hunters")
    expect_ok(script("build_requests.py", target, "diff"), "build_requests diff")


def requests_present(hdir: Path, tags: tuple[str, ...]) -> list[tuple[str, Path]]:
    return [(t, hdir / t / "request.json") for t in tags if (hdir / t / "request.json").exists()]


def stage_dispatch(hdir: Path) -> None:
    reqs = requests_present(hdir, HUNTER_TAGS)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(reqs))) as pool:
        list(pool.map(lambda tr: dispatch_one(hdir, *tr), reqs))


def dispatched(hdir: Path) -> bool:
    reqs = requests_present(hdir, HUNTER_TAGS)
    if over_budget(hdir):
        return True  # the breaker tripped: run on the answers that exist
    return bool(reqs) and all(dispatch.is_answered(path) for _, path in reqs)


def repair_round(target: str, hdir: Path, tag: str) -> bool:
    """One repair round after a COMPILE_ERROR (SKILL.md step 4): the failing files go back to the same hunter."""
    expect_ok(script("build_requests.py", target, "repair", tag), f"build_requests repair {tag}")
    return dispatch_one(hdir, f"{tag}:repair", hdir / tag / "request.repair.json")


def run_tag(target: str, hdir: Path, tag: str, *, retry_empty: bool = False) -> None:
    if (hdir / f"run_{tag}.json").exists():
        return
    if not (hdir / tag / "response.json").exists():
        set_gap(hdir, f"run:{tag}", f"hunter {tag} wrote no response")
        return
    p = script("run.py", "run", target, tag)
    if p.returncode == 3 and repair_round(target, hdir, tag):
        p = script("run.py", "run", target, tag)
    if p.returncode == 3:
        set_gap(hdir, f"run:{tag}", f"{tag} COMPILE_ERROR after one repair round")
        return
    expect_ok(p, f"run.py run {tag}")
    if retry_empty and "EMPTY_RESPONSE" in p.stdout and not (hdir / tag / "request.retry.json").exists():
        expect_ok(script("build_requests.py", target, "retry", tag), f"build_requests retry {tag}")
        if dispatch_one(hdir, f"{tag}:retry", hdir / tag / "request.retry.json"):
            p = script("run.py", "run", target, tag)
            expect_ok(p, f"run.py run {tag} after retry")
    set_gap(hdir, f"empty:{tag}", "Mode A emitted no tests after one retry" if "EMPTY_RESPONSE" in p.stdout else None)
    set_gap(hdir, f"run:{tag}", None)


def run_diff(target: str, hdir: Path) -> None:
    if (hdir / "diff_D.json").exists():
        return
    if not (hdir / "D" / "response.json").exists():
        set_gap(hdir, "run:D", "hunter D wrote no response")
        return
    p = script("run.py", "diff", target, "D")
    if p.returncode == 3 and repair_round(target, hdir, "D"):
        p = script("run.py", "diff", target, "D")
    if p.returncode == 3:
        set_gap(hdir, "run:D", "D COMPILE_ERROR after one repair round")
        return
    expect_ok(p, "run.py diff D")
    set_gap(hdir, "run:D", None)


def stage_run(target: str, hdir: Path) -> None:
    run_tag(target, hdir, "A", retry_empty=True)
    run_tag(target, hdir, "B")
    run_diff(target, hdir)
    if (hdir / "R" / "request.json").exists():
        run_tag(target, hdir, "R")


def failing(hdir: Path, tag: str) -> list[str]:
    return [k for k, v in read_dict(hdir / f"run_{tag}.json").items() if v == verdict.Verdict.FAIL_3_OF_3]


def base_pending(hdir: Path, tag: str) -> bool:
    return bool(failing(hdir, tag)) and not (hdir / f"base_{tag}.json").exists()


def stage_base(target: str, hdir: Path) -> None:
    for tag in BASE_TAGS:
        if base_pending(hdir, tag):
            p = script("run.py", "base", target, tag)
            if p.returncode == 3:
                set_gap(hdir, f"base:{tag}", f"{tag} COMPILE_ERROR on the merge-base")
                continue
            expect_ok(p, f"run.py base {tag}")
            set_gap(hdir, f"base:{tag}", None)


def candidates_ab(hdir: Path) -> list[dict[str, Any]]:
    """Mode A and B tests that fail 3 of 3 on head and pass on the merge-base: the ones Mode V diagnoses."""
    out = []
    for tag in ("A", "B"):
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_PR_BUG:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def candidates_new_api(hdir: Path) -> list[dict[str, Any]]:
    """Mode A/B tests that fail 3 of 3 on head and cannot run on the merge-base because they call the PR's new API.
    No base oracle exists, so the skeptic judges them against the PR's description (PR 40256: the write-scope bug)."""
    out = []
    for tag in ("A", "B"):
        head = read_dict(hdir / f"run_{tag}.json")
        for tid, v in read_dict(hdir / f"base_{tag}.json").items():
            if v == verdict.Verdict.NEW_API and head.get(tid) == verdict.Verdict.FAIL_3_OF_3:
                out.append({"id": tid, "source": tag, "mechanical_verdict": v})
    return out


def candidates_all(hdir: Path) -> list[dict[str, Any]]:
    """Everything the skeptic may decide on: Mode A/B NEW_PR_BUG or NEW_API (head 3 of 3), Mode R PROVEN with a
    NEW_PR_BUG base, Mode D DIFF."""
    out = candidates_ab(hdir) + candidates_new_api(hdir)
    for tid, item in read_dict(hdir / "review_verdicts.json").get("verdicts", {}).items():
        if isinstance(item, dict) and item.get("verdict") == verdict.Verdict.PROVEN \
                and item.get("base_verdict") == verdict.Verdict.NEW_PR_BUG:
            out.append({"id": tid, "source": "R", "mechanical_verdict": verdict.Verdict.NEW_PR_BUG})
    for tid, v in read_dict(hdir / "diff_D.json").items():
        if v == verdict.Verdict.DIFF:
            out.append({"id": tid, "source": "D", "mechanical_verdict": v})
    return out


def stage_v(target: str, hdir: Path) -> None:
    cands = candidates_ab(hdir)
    if not cands:
        return
    files_by_tag: dict[str, str] = {}
    for tag in ("A", "B"):
        resp = read_dict(hdir / tag / "response.json")
        files_by_tag[tag] = _capped_to("\n\n".join(f"// {f.get('path', '')}\n{f.get('content', '')}"
                                                  for f in resp.get("files", []) if isinstance(f, dict)),
                                        MAX_PAYLOAD_CHARS)
    messages: dict[str, Any] = {}
    for tag in ("A", "B"):
        messages.update(read_dict(hdir / f"run_{tag}.messages.json"))
    user = {"candidates": [{"id": c["id"], "tag": c["source"], "head_failure": str(messages.get(c["id"], ""))[:1500],
                            "test_source": files_by_tag[c["source"]]} for c in cands]}
    build_requests.write_request(hdir / "V" / "request.json", V_SYSTEM, user, build_requests.HUNTER_SCHEMA,
                                 hdir / "V" / "response.json")
    if not dispatch_one(hdir, "V", hdir / "V" / "request.json"):
        return
    p = script("run.py", "run", target, "V")
    if p.returncode == 3:  # the diagnostic tests did not compile: vet the candidates on the A/B evidence alone
        tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
        set_gap(hdir, "vet_v", f"Mode V COMPILE_ERROR: {tail[0][:300]}")
        return
    expect_ok(p, "run.py run V")
    set_gap(hdir, "vet_v", None)
    expect_ok(script("run.py", "base", target, "V"), "run.py base V")


def v_done(hdir: Path) -> bool:
    if not candidates_ab(hdir):
        return True
    if not (hdir / "run_V.json").exists():
        return "vet_v" in read_dict(hdir / "driver.json").get("gaps", {})
    return not failing(hdir, "V") or (hdir / "base_V.json").exists()


SKEPTIC_DESCRIPTION_CHARS = 3000
SKEPTIC_DIFF_CHARS = 12000
SKEPTIC_CALLERS_CHARS = 6000
SKEPTIC_TEST_CHARS = 3000
SKEPTIC_PR_TESTS_CHARS = 4000


def repro_cmd(hdir: Path, tid: str) -> str:
    """The command that reruns one hunted test, from the repository root of the PR head, as run.py runs it."""
    rel, _, name = tid.partition("::")
    wt = Path(str(read_dict(hdir / "state.json").get("wt") or "."))
    if rel.endswith((".ts", ".tsx", ".js", ".jsx")):
        import run  # only for the Jest root lookup
        try:
            root = run.jest_root(wt, rel).relative_to(wt.resolve())
        except (InfraError, ValueError):
            root = Path("webapp/channels")
        if Path(rel).is_relative_to(root):
            return f"cd {root} && npx jest {Path(rel).relative_to(root)} -t {shlex.quote(name)}"
        # A test outside the Jest root (webapp/platform) is found only through --roots, as run.py runs it.
        pkg = run.jest_pkg_dir(wt, rel, wt / root)
        roots = f"--roots . --roots {os.path.relpath(pkg, (wt / root).resolve())} " if pkg is not None else ""
        return f"cd {root} && npx jest {roots}--runTestsByPath {os.path.relpath(rel, root)} -t {shlex.quote(name)}"
    mod = Path(rel)
    while mod.parts and not (wt / mod / "go.mod").exists():
        mod = mod.parent
    pkg = Path(rel).relative_to(mod) if mod.parts else Path(rel)
    cd = f"cd {mod} && " if mod.parts else ""
    return f"{cd}go test ./{pkg} -run '^{name.split('/')[0]}$' -count=1"


def _test_source(hdir: Path, tag: str, tid: str) -> str:
    """The candidate's own test function (or the whole hunter file when the function cannot be cut out)."""
    rel, _, name = tid.partition("::")
    files = read_dict(hdir / tag / "response.json").get("files", [])
    key = name.split(" ")[-1].split("/")[0]
    # A Go id names the package (dir::TestName), a Jest id the file (file::title).
    ok = [f for f in files if isinstance(f, dict) and (f.get("path") == rel or str(Path(str(f.get("path"))).parent) == rel)]
    text = next((str(f.get("content", "")) for f in ok if key and key in str(f.get("content", ""))),
                str(ok[0].get("content", "")) if ok else "")
    at = text.find(key) if key else -1
    if at >= 0:
        start = max(0, text.rfind("\n", 0, max(0, at - 200)))
        return _capped_to(text[start:], SKEPTIC_TEST_CHARS)
    return _capped_to(text, SKEPTIC_TEST_CHARS)


def _capped_to(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n] + "\n[truncated]"


def skeptic_context(hdir: Path) -> dict[str, Any]:
    """What a reviewer needs to place a failure: the PR's intent, the production diff and who calls the changed code.
    Entry-point callers first, then the shallowest."""
    ctx = read_dict(hdir / "ctx.json")
    pr: dict[str, Any] = ctx["pr"] if isinstance(ctx.get("pr"), dict) else {}
    callers = [c for c in ctx.get("callers", []) if isinstance(c, dict)]
    callers.sort(key=lambda c: (not c.get("entry_point"), int(c.get("hop") or 9)))
    picked, used = [], 0
    for c in callers:
        item = {k: c.get(k) for k in ("file", "symbol", "lines", "hop", "entry_point", "enclosing", "permission_checks")
                if c.get(k) not in (None, "", [])}
        item["source"] = _capped_to(str(c.get("source", "")), 800)
        used += len(json.dumps(item))
        if used > SKEPTIC_CALLERS_CHARS:
            break
        picked.append(item)
    return {"pr": {"title": pr.get("title", ""), "description": _capped_to(str(pr.get("description", "")),
                                                                            SKEPTIC_DESCRIPTION_CHARS)},
            "diff_production_code": _capped_to(str(ctx.get("diff_production_code", "")), SKEPTIC_DIFF_CHARS),
            "pr_tests_diff": _capped_to("\n".join(str(d.get("diff", d)) if isinstance(d, dict) else str(d)
                                                  for d in ctx.get("pr_tests_diff") or []), SKEPTIC_PR_TESTS_CHARS),
            "callers": picked}


def stage_vet(hdir: Path) -> None:
    cands = candidates_all(hdir)
    if not cands:
        write_json(hdir / "vetted.json", {"rows": []})
        return
    messages: dict[str, Any] = {}
    for tag in ("A", "B", "V"):
        messages.update(read_dict(hdir / f"run_{tag}.messages.json"))
    examples = read_dict(hdir / "diff_D.examples.json")
    v_results = {"run_V": read_dict(hdir / "run_V.json"), "base_V": read_dict(hdir / "base_V.json")}
    items = []
    for c in cands:
        item: dict[str, Any] = {"id": c["id"], "source": c["source"],
                                "mechanical_verdict": c["mechanical_verdict"], "repro_cmd": repro_cmd(hdir, c["id"])}
        if c["source"] == "D":
            item["examples"] = (examples.get(c["id"]) or {}).get("examples", [])[:3]
        else:
            item["head_failure"] = str(messages.get(c["id"], ""))[:1200]
            item["diagnostic_v_results"] = v_results
        if c["source"] in ("A", "B", "D"):
            item["test_source"] = _test_source(hdir, c["source"], c["id"])
        items.append(item)
    schema = json.loads((SKILL_DIR / "vetted.schema.json").read_text())
    context = skeptic_context(hdir)
    build_requests.write_request(hdir / "vet" / "request.json", SKEPTIC_SYSTEM,
                                 {**context, "candidates": items}, schema,
                                 hdir / "vet" / "response.json")
    if not dispatch_one(hdir, "vet", hdir / "vet" / "request.json"):
        return
    data = read_dict(hdir / "vet" / "response.json")
    rows = data.get("rows")
    if not isinstance(rows, list):
        set_gap(hdir, "vet", "skeptic response has no rows array")
        return
    repro = {item["id"]: item["repro_cmd"] for item in items}
    for r in rows:  # the repro command is mechanical: what the driver ran, not what the model remembers
        if isinstance(r, dict) and r.get("id") in repro:
            r["repro_cmd"] = repro[r["id"]]
    ids = {item["id"]: item for item in items}
    good = [r for r in rows if isinstance(r, dict) and not verdict.row_errors(r) and r.get("id") in ids]
    bad = len(rows) - len(good)
    # A candidate the skeptic did not answer is held, never silently gone (PR text can ask the model to omit one).
    answered = {r["id"] for r in good}
    missing = [i for i in ids if i not in answered]
    good += [{"id": i, "source": ids[i]["source"], "decision": verdict.Verdict.HELD.value,
              "reason": "the skeptic returned no row for this candidate", "file_line": "", "caller": "",
              "entry_point": None, "repro_cmd": ids[i]["repro_cmd"], "evidence_path": "vet/response.json",
              "severity": "minor", "fix_check": None, "reason_code": "NEEDS_INPUT", "evidence_quote": ""}
             for i in missing]
    notes = [f"{bad} skeptic row(s) malformed or for unknown ids, ignored"] if bad else []
    notes += [f"{len(missing)} candidate(s) with no skeptic row, held"] if missing else []
    set_gap(hdir, "vet", "; ".join(notes) or None)
    # A DROP is a model claim. It stands only when its evidence is found verbatim in what the skeptic was shown.
    tests = {item["id"]: str(item.get("test_source", "")) for item in items}
    for r in good:
        verdict.check_drop(r, verdict.drop_corpus(context, tests.get(str(r.get("id")), "")))
    write_json(hdir / "vetted.json", {"rows": good})


def vet_done(hdir: Path) -> bool:
    return (hdir / "vetted.json").exists()


def stage_verdict(hdir: Path) -> None:
    adm = verdict.admissibility(hdir)
    lesson_hits = {h["test_id"]: h["lesson_id"] for h in lessons.post_filter(hdir)}
    print(lessons.counts_line(applied=len(lesson_hits), matched=len(adm["keep"]) + len(adm["held"])))
    keep, held = [], list(adm["held"])
    for row in adm["keep"]:
        lid = lesson_hits.get(str(row.get("id", "")))
        if lid is None:
            keep.append(row)
        else:
            held.append({"row": row, "reasons": [f"failure text matches false-positive lesson {lid}"]})
    write_json(hdir / "verdict.json", {"vetted_present": adm["vetted_present"], "keep": keep, "held": held})
    print(f"[verdict] kept {len(keep)}, held {len(held)}")


# ------------------------------------------------------------------ driver

def drive(target: str, fresh: bool) -> int:
    hdir = hunt_dir(target)
    with driver_lock(hdir, target):
        print(trusted.check())
        step(hdir, "prepare", lambda: False, lambda: stage_prepare(target, hdir, fresh))
        step(hdir, "ctx", lambda: (hdir / "ctx.json").exists(),
             lambda: expect_ok(script("ctx.py", target), "ctx.py"))
        step(hdir, "requests", lambda: all((hdir / t / "request.json").exists() for t in ("A", "B", "D")),
             lambda: stage_requests(target, hdir))
        step(hdir, "dispatch", lambda: dispatched(hdir), lambda: stage_dispatch(hdir))
        step(hdir, "run", lambda: (hdir / "run_A.json").exists() and (hdir / "run_B.json").exists()
             and (hdir / "diff_D.json").exists(), lambda: stage_run(target, hdir))
        step(hdir, "base", lambda: not any(base_pending(hdir, t) for t in BASE_TAGS),
             lambda: stage_base(target, hdir))
        step(hdir, "old_tests", lambda: (hdir / "old_tests.json").exists(),
             lambda: expect_ok(script("old_tests.py", target), "old_tests.py"))
        step(hdir, "pr_tests", lambda: (hdir / "pr_tests.json").exists(),
             lambda: expect_ok(script("pr_tests.py", target), "pr_tests.py"))
        step(hdir, "vet_v", lambda: v_done(hdir), lambda: stage_v(target, hdir))
        step(hdir, "vet", lambda: vet_done(hdir), lambda: stage_vet(hdir))
        step(hdir, "verdict", lambda: False, lambda: stage_verdict(hdir))
        step(hdir, "report", lambda: False, lambda: report.write(hdir, target))
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    if len(argv) not in (2, 3) or argv[2:] not in ([], ["--fresh"]) or argv[1].startswith("-"):
        print(__doc__)
        return 1
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, terminate_handler)
    try:
        return drive(argv[1], fresh=argv[2:] == ["--fresh"])
    except InfraError as e:
        print(f"INFRA_ERROR {e}")
        return 2
    except Stop as s:
        print(str(s))
        return s.code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
