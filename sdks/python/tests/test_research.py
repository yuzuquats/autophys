"""Batch 2 tests: no provider calls or installed Muse binary."""
from dataclasses import asdict
import io
import json
from pathlib import Path
import sys

import pytest

from autophys.bench import run_benchmark, run_case
from autophys.cli import main
from autophys.playbook import load_playbook
from autophys.reasoner import ModelSpec, MUSE_SPARK, ReasonerError
from autophys.research import (APIResearcher, MuseCLIResearcher, evaluate, improves,
                               parse_muse_events, research, run_score, score, validate_edit)
from autophys.trajectories import export_trajectories

ROOT = Path(__file__).resolve().parents[3]
CASSETTE = ROOT / "tests/conformance/reasoner/spark-oscillator.jsonl"


def test_parallel_bench_identity():
    serial = run_benchmark(seeds=1, jobs=1)
    parallel = run_benchmark(seeds=1, jobs=4)
    for one, two in zip(serial, parallel):
        a, b = asdict(one), asdict(two)
        a.pop("wall_s")
        b.pop("wall_s")
        assert a == b


def test_parallel_replay_and_record_guard(tmp_path):
    options = dict(cases=["oscillator"], policies=["reason"], seeds=1,
                   model_spec=ModelSpec("policy", "meta", MUSE_SPARK), replay=CASSETTE)
    one = asdict(run_benchmark(jobs=1, **options)[0])
    two = asdict(run_benchmark(jobs=4, **options)[0])
    one.pop("wall_s")
    two.pop("wall_s")
    assert one == two
    with pytest.warns(UserWarning, match="jobs=1"):
        run_benchmark(jobs=4, record=tmp_path / "record.jsonl", **options)
    with pytest.raises(ValueError):
        run_benchmark(jobs=0)


def component(correct=True, error=0.1, cost=1):
    return dict(correct=correct, mean_log_error=error, cost_usd=cost)


@pytest.mark.parametrize("candidate,baseline,expected", [
    (component(True, 10, 10), component(False, 0, 0), True),
    (component(False, 0, 0), component(True, 10, 10), False),
    (component(error=.01, cost=100), component(error=.1, cost=0), True),
    (component(cost=0), component(cost=1), True),
    (component(cost=None), component(cost=1), False),
    (component(cost=0), component(cost=None), False),
    (component(), component(), False),
    (component(error=.2, cost=0), component(error=.1, cost=100), False),
])
def test_score_ties(candidate, baseline, expected):
    assert improves(score([candidate]), score([baseline])) is expected


def test_exact_log_score():
    a = run_score(status="validated", expected_status="validated", diagnosis_correct=True,
                  ratios={"a": 2, "b": .5}, cost_usd=None)
    import math
    assert a["correct"] and a["mean_log_error"] == math.log(2)
    assert score([a])["cost_usd"] is None
    b = run_score(status="failed", expected_status="validated", diagnosis_correct=True,
                  ratios={}, cost_usd=0)
    assert not b["correct"] and math.isinf(b["mean_log_error"])


def fake_muse(tmp_path, body):
    path = tmp_path / "muse"
    path.write_text("#!" + sys.executable + "\n" + body)
    path.chmod(0o700)
    return str(path)


def test_muse_adapter(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_ALLOW_LIVE_REASON", "1")
    monkeypatch.setenv("MODEL_API_KEY", "test-secret")
    binary = fake_muse(tmp_path, '''
import sys, os, json
from pathlib import Path
args = sys.argv[1:]
assert args[:6] == ["exec", "--json", "--provider", "meta", "--model", "muse-wonder-1.0"]
assert "test-secret" not in " ".join(args)
assert sys.stdin.read() == "test-secret"
assert "MODEL_API_KEY" not in os.environ
for flag in ("--api-key-stdin", "--no-session-log", "--disable-web-tools",
             "--disable-request-user-input", "--no-foreign-personal-context",
             "--disable-reminders", "--disable-shell"):
    assert flag in args
assert args[args.index("--approval-mode")+1] == "never"
assert args[args.index("--reasoning-effort")+1] == "high"
assert args[args.index("--max-model-steps")+1] == "3"
root = Path(args[args.index("--workspace")+1])
assert Path(args[args.index("--prompt-file")+1]).is_file()
assert (root / "failing-transcripts.json").is_file()
p = root / "SKILL.md"
p.write_text(p.read_text() + "\\nConsider a cheaper experiment.\\n")
print("not json")
print(json.dumps({"type":"unknown", "arbitrary":42}))
def ev(kind, payload):
    print(json.dumps({"schema_version": 1, "payload_type": kind, "payload": payload}))
ev("run.output.delta", {"text": "ed"})
ev("run.output.delta", {"text": "ited"})
ev("run.usage", {"models": [{"model": "muse-wonder-1.0", "input_tokens": 12, "cached_tokens": 2,
                             "output_tokens": 4, "reasoning_tokens": 1, "calls": 1}], "calls": 1})
ev("run.terminal.completed", {"terminal": "completed", "text": "done", "reason": None})
''')
    recording = tmp_path / "cli-cassette.jsonl"
    adapter = MuseCLIResearcher(binary=binary, record=recording, spec=ModelSpec("researcher", "meta", "muse-wonder-1.0", "high"),
                                max_model_steps=3)
    text = load_playbook().data.decode()
    proposed = adapter.propose(text, {})
    assert "cheaper" in proposed
    assert "test-secret" not in recording.read_text()
    assert MuseCLIResearcher(binary="never-run", replay=recording, spec=adapter.spec,
                             max_model_steps=3).propose(text, {}) == proposed
    assert adapter.last_events == {"message": "done", "terminal": "completed", "usage": {
        "calls": 1, "input_tokens": 12, "output_tokens": 4, "cached_input_tokens": 2,
        "reasoning_tokens": 1, "models": ["muse-wonder-1.0"]}}


def test_parse_real_muse_echo_events():
    """Muse Code 1.4.14 `exec --provider echo --json` output, captured once (MQ-7, zero tokens)."""
    stdout = (Path(__file__).parent / "data" / "muse-exec-echo-1.4.14.jsonl").read_text()
    parsed = parse_muse_events(stdout + "\nnot json\n")
    assert parsed["terminal"] == "completed"
    assert parsed["message"].startswith("echo: Edit skills/autophys/SKILL.md")
    assert parsed["usage"] == {"calls": 1, "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0,
                               "reasoning_tokens": 0, "models": []}
    assert parse_muse_events("garbage\n{}\n") == {"message": None, "terminal": None, "usage": None}


def test_muse_failed_terminal_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_ALLOW_LIVE_REASON", "1")
    body = """
import sys, json
from pathlib import Path
p = Path(sys.argv[sys.argv.index("--workspace")+1], "SKILL.md")
p.write_text(p.read_text() + "\\nmore\\n")
print(json.dumps({"schema_version": 1, "payload_type": "run.terminal.failed", "payload": {"terminal": "failed", "reason": "secret-ish"}}))
"""
    with pytest.raises(ReasonerError, match="ended failed") as info:
        MuseCLIResearcher(binary=fake_muse(tmp_path, body)).propose(load_playbook().data.decode(), {})
    assert "secret-ish" not in str(info.value)


@pytest.mark.parametrize("body,error", [
    ("import sys; sys.exit(9)", "status 9"),
    ("pass", "unchanged"),
    ('import sys; from pathlib import Path; Path(sys.argv[sys.argv.index("--workspace")+1], "SKILL.md").write_text("bad")',
     "frontmatter"),
    ("import time; time.sleep(2)", "timed out"),
])
def test_muse_failures(tmp_path, monkeypatch, body, error):
    monkeypatch.setenv("AUTOPHYS_ALLOW_LIVE_REASON", "1")
    if error in ("unchanged", "frontmatter"):
        body += "\nprint(" + repr(json.dumps({"payload_type": "run.terminal.completed", "payload": {"terminal": "completed"}})) + ")"
    with pytest.raises((ValueError, ReasonerError), match=error):
        MuseCLIResearcher(binary=fake_muse(tmp_path, body), timeout=.2).propose(load_playbook().data.decode(), {})


def test_researcher_replay_guard(tmp_path, monkeypatch):
    monkeypatch.delenv("AUTOPHYS_ALLOW_LIVE_REASON", raising=False)
    monkeypatch.delenv("AUTOPHYS_REASON_REPLAY", raising=False)
    with pytest.raises(ReasonerError, match="replay"):
        APIResearcher()
    with pytest.raises(ReasonerError, match="replay"):
        MuseCLIResearcher(binary="never-run").propose(load_playbook().data.decode(), {})
    monkeypatch.setenv("AUTOPHYS_REASON_REPLAY", "not-a-cli-replay")
    with pytest.raises(ReasonerError, match="replay"):
        MuseCLIResearcher(binary="never-run").propose(load_playbook().data.decode(), {})
    text = load_playbook().data.decode()
    path = tmp_path / "edited.md"
    path.write_text(text + "\nNew strategy.\n")
    assert MuseCLIResearcher(replay=path).propose(text, {}) == path.read_text()


def test_api_fake_and_contract_validation():
    from autophys.reasoner import FakeReasoner
    text = load_playbook().data.decode()
    adapter = APIResearcher(reasoner=FakeReasoner(lambda messages: text + "\nChanged.\n"))
    assert "Changed." in adapter.propose(text, {})
    from autophys.agent import CONTRACT
    with pytest.raises(ValueError, match="fixed contract"):
        validate_edit(text, text + CONTRACT)


def test_research_accept_reject_and_heldout(tmp_path):
    original = load_playbook().data.decode()
    source = tmp_path / "source.md"
    source.write_text(original)
    calls = []
    class FakeResearcher:
        def propose(self, text, report):
            return text + ("\nImprove.\n" if "Improve." not in text else "\nRegress.\n")
    def evaluator(path, cases, seeds, policy, directory, **kw):
        text = path.read_text()
        calls.append((tuple(seeds), text))
        return {"score": score([component(error=.3 if "Regress." in text else .1 if "Improve." in text else .2)]),
                "runs": [], "failing_transcripts": []}
    result = research(researcher=FakeResearcher(), output_dir=tmp_path / "research", playbook=source,
                      iterations=2, policy="scripted", evaluate_fn=evaluator)
    assert [i["accepted"] for i in result["iterations"]] == [True, False]
    assert result["final_playbook"] == "playbook-001.md"
    assert calls[-2][0] == calls[-1][0] == (3, 4)
    assert "Improve." not in calls[-2][1] and "Improve." in calls[-1][1]
    assert source.read_text() == original
    assert json.loads((tmp_path / "research/summary.json").read_text())["train"]["mean_log_error"] == .1


def test_evaluate_and_replayed_export(tmp_path):
    report = evaluate(load_playbook().path, ["oscillator"], [0], "reason", tmp_path / "eval",
                      jobs=4, model_spec=ModelSpec("policy", "meta", MUSE_SPARK), replay=CASSETTE)
    assert report["score"]["correct"] == 1
    assert report["runs"][0]["score"]["log_errors"]
    output = io.StringIO()
    assert export_trajectories(tmp_path, output) == 8
    decisions = [json.loads(line) for line in output.getvalue().splitlines()]
    assert all(d["valid"] and d["replayed"] and d["score"]["correct"] for d in decisions)
    assert all(d["messages"] is None and d["system_prompt_sha256"] and d["playbook"]["sha256"] for d in decisions)
    assert sum(d["usage"]["input_tokens"] for d in decisions) == 800
    golden = ROOT / "tests/conformance/python/reason-replayed.ap-workbook"
    output = io.StringIO()
    assert export_trajectories(golden, output) == 8
    assert all(json.loads(line)["score"] is None for line in output.getvalue().splitlines())


def test_cli_new_commands(tmp_path, monkeypatch):
    monkeypatch.delenv("AUTOPHYS_ALLOW_LIVE_REASON", raising=False)
    monkeypatch.delenv("AUTOPHYS_REASON_REPLAY", raising=False)
    out = io.StringIO()
    assert main(["research", "--output-dir", str(tmp_path / "never")], out=out) == 2
    assert "replay" in out.getvalue()
    assert not (tmp_path / "never").exists()
    out = io.StringIO()
    assert main(["export-trajectories", str(ROOT / "tests/conformance/python/reason-replayed.ap-workbook")], out=out) == 0
    assert len(out.getvalue().splitlines()) == 8


def test_real_research_with_fake_policy(tmp_path, monkeypatch):
    import autophys.bench as bench
    original = bench.heuristic_responder
    def responder(messages):
        strategy = messages[0]["content"]
        return original(messages) if "Improve." in strategy and "Regress." not in strategy else "invalid"
    monkeypatch.setattr(bench, "heuristic_responder", responder)
    class FakeResearcher:
        def propose(self, text, report):
            return text + ("\nImprove.\n" if "Improve." not in text else "\nRegress.\n")
    summary = research(researcher=FakeResearcher(), output_dir=tmp_path / "real",
                       policy="fake-reasoner", cases=["thermal"], train_seeds=[0],
                       heldout_seeds=[1], iterations=2)
    assert [i["accepted"] for i in summary["iterations"]] == [True, False]
    assert summary["heldout_initial"]["correct"] == 0
    assert summary["heldout_final"]["correct"] == 1
    assert (tmp_path / "real/train-000/scores.json").is_file()
    assert (tmp_path / "real/playbook-002.sha256").is_file()


def test_prompt_cassette_identity_ignores_timing_and_ids():
    from autophys.research import proposal_prompt
    assert proposal_prompt("skill", {"runs": [{"id": "a", "wall_s": 1, "score": component()}]}) == proposal_prompt(
        "skill", {"runs": [{"id": "b", "wall_s": 9, "score": component()}]})


class _Refusing:
    """A reasoner that always answers HTTP 402."""
    calls = 0
    def complete(self, *args, **kwargs):
        from autophys.reasoner import BudgetError
        type(self).calls += 1
        raise BudgetError("chat completions: HTTP 402 (billing_not_configured)")


def test_first_402_ends_the_investigation_and_the_run():
    """MQ-6: one 402 call, outcome failed with a billing reason, BudgetError raised."""
    from autophys.agent import Investigation, ReasonLanePolicy
    from autophys.bench import case_project
    from autophys.reasoner import BudgetError
    from autophys.store import MemoryStore
    from autophys.synthetic import CASES
    view, _ = CASES["thermal"](0)
    _Refusing.calls = 0
    inv = Investigation(case_project(view), view.dataset, view.runner, policy=ReasonLanePolicy(_Refusing()),
                        store=MemoryStore(), seed=0, title="402")
    with pytest.raises(BudgetError):
        inv.run()
    assert _Refusing.calls == 1
    step = inv.records("step")[-1].payload
    assert step["valid"] is False and step["error"].startswith("BudgetError")
    outcome = inv.records("outcome")[-1].payload
    assert outcome["status"] == "failed"
    assert outcome["reasons"] == ["billing: provider refused the call (HTTP 402)"]


def test_research_skips_an_unusable_proposal(tmp_path):
    class Unchanged:
        last_usage = last_events = None
        def propose(self, text, report):
            return text
    fake_eval = lambda *a, **k: {"score": {"correct": 1, "mean_log_error": 0.5, "cost_usd": None}}
    summary = research(researcher=Unchanged(), output_dir=tmp_path / "out", iterations=2,
                       evaluate_fn=fake_eval, cases=["thermal"], policy="scripted")
    assert [h["accepted"] for h in summary["iterations"]] == [False, False]
    assert "unchanged" in summary["iterations"][0]["error"]
