"""Route ``muse``: the policy reasoner runs each decision through ``muse exec`` on the coding plan.

A fake ``muse`` binary stands in for the CLI. The end-to-end test makes it answer
with the playbook-sensitive heuristic brain, so the autoloop runs through the exact
live code path (argv, prompt, event parsing, decision parsing, scoring) offline.
"""
import json
import os
import sys
from pathlib import Path

import pytest

from autophys.agent import DECISION_SCHEMA, ReasonLanePolicy
from autophys.autoloop import HeuristicResearcher, autoloop
from autophys.playbook import load_playbook
from autophys.reasoner import MUSE_SPARK, ModelSpec, MuseExecReasoner, ReasonerError, reasoner_for
from autophys.usage import normalize_usage

SRC = str(Path(__file__).resolve().parents[1] / "src")

PREAMBLE = f'''#!{sys.executable}
import json, os, re, sys
from pathlib import Path
sys.path.insert(0, {SRC!r})
args = sys.argv[1:]
def ev(kind, payload):
    print(json.dumps({{"schema_version": 1, "payload_type": kind, "payload": payload}}))
def usage():
    ev("run.usage", {{"models": [{{"model": "muse-spark-1.3", "input_tokens": 100, "cached_tokens": 40,
                                   "output_tokens": 20, "reasoning_tokens": 5, "calls": 1}}]}})
prompt = Path(args[args.index("--prompt-file") + 1]).read_text()
'''


def fake_muse(tmp_path, body, name="muse"):
    path = tmp_path / name
    path.write_text(PREAMBLE + body)
    path.chmod(0o700)
    return str(path)


DECISION = {"hypothesis": "h", "evidence": [], "action": "inspect_data", "arguments": {}, "expected_information": "x"}

CHECKING = f'''
assert args[:6] == ["exec", "--json", "--provider", "meta", "--model", "muse-spark-1.3"], args
for flag in ("--no-session-log", "--disable-web-tools", "--disable-request-user-input",
             "--no-foreign-personal-context", "--disable-reminders", "--disable-shell", "--disable-write"):
    assert flag in args, flag
assert "--api-key-stdin" not in args and args[args.index("--approval-mode") + 1] == "never"
assert args[args.index("--max-model-steps") + 1] == "2"
assert args[args.index("--reasoning-effort") + 1] == "low"
assert "MODEL_API_KEY" not in os.environ and sys.stdin.read() == ""
assert "<system>" in prompt and "<user>" in prompt and '"action"' in prompt and "matches this JSON schema" in prompt
ev("run.output.delta", {{"text": "ignored"}})
usage()
ev("run.terminal.completed", {{"terminal": "completed", "text": {json.dumps(json.dumps(DECISION))}}})
'''


def test_muse_route_runs_one_plan_call_per_decision(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "metered-key-must-not-be-used")
    reasoner = MuseExecReasoner(binary=fake_muse(tmp_path, CHECKING))
    reply = reasoner.complete([{"role": "developer", "content": "rules"}, {"role": "user", "content": "facts"}],
                              response_schema=DECISION_SCHEMA, effort="low")
    assert json.loads(reply.content) == DECISION and reply.route == "muse" and reply.model == MUSE_SPARK
    usage = normalize_usage(reply)
    assert (usage["input_tokens"], usage["output_tokens"], usage["cached_input_tokens"], usage["reasoning_tokens"]) == (100, 20, 40, 5)
    assert usage["cost_usd"] is None  # plan usage is not priced per token


def test_muse_route_records_a_replayable_cassette(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_MUSE_BINARY", fake_muse(tmp_path, CHECKING))
    spec = ModelSpec("policy", "muse", MUSE_SPARK, "low")
    cassette = tmp_path / "cassette.jsonl"
    messages = [{"role": "developer", "content": "rules"}, {"role": "user", "content": "facts"}]
    live = reasoner_for(spec, record=cassette).complete(messages, response_schema=DECISION_SCHEMA)
    monkeypatch.setenv("AUTOPHYS_MUSE_BINARY", "/nonexistent/muse")
    replayed = reasoner_for(spec, replay=cassette).complete(messages, response_schema=DECISION_SCHEMA)
    assert replayed.content == live.content and replayed.replayed and replayed.route == "muse"


@pytest.mark.parametrize("body,error", [
    ("sys.exit(3)", "status 3"),
    ('ev("run.terminal.failed", {"terminal": "failed", "text": "secret-ish"})', "ended failed"),
    ('ev("run.terminal.completed", {"terminal": "completed", "text": "  "})', "no text"),
    ("import time; time.sleep(3)", "timed out"),
])
def test_muse_route_failures_are_reasoner_errors(tmp_path, body, error):
    reasoner = MuseExecReasoner(binary=fake_muse(tmp_path, body), timeout=1)
    with pytest.raises(ReasonerError, match=error) as info:
        reasoner.complete([{"role": "user", "content": "x"}])
    assert "secret-ish" not in str(info.value)
    with pytest.raises(ReasonerError, match="text-only"):
        reasoner.complete([{"role": "user", "content": "x"}], images=[{"media_type": "image/png", "data": ""}])


def test_muse_route_is_text_only_for_images():
    from autophys.reasoner import images_enabled
    assert not images_enabled(ModelSpec("policy", "muse", MUSE_SPARK, images=True))


BRAIN = '''
from autophys.bench import heuristic_responder
system = re.search(r"<system>\\n(.*?)\\n</system>", prompt, re.S).group(1)
user = re.search(r"<user>\\n(.*?)\\n</user>", prompt, re.S).group(1)
answer = heuristic_responder([{"role": "developer", "content": system}, {"role": "user", "content": user}])
usage()
ev("run.terminal.completed", {"terminal": "completed", "text": answer if isinstance(answer, str) else json.dumps(answer)})
'''


def test_autoloop_end_to_end_through_the_muse_route(tmp_path, monkeypatch):
    """The live code path with Spark as policy, offline: the heuristic researcher finds the planted fix."""
    monkeypatch.setenv("AUTOPHYS_MUSE_BINARY", fake_muse(tmp_path, BRAIN))
    monkeypatch.setenv("AUTOPHYS_ALLOW_LIVE_REASON", "1")
    start = tmp_path / "start.md"
    start.write_text(load_playbook().data.decode().rstrip("\n") + "\n\nSettings:\n- compare_variants: never\n")
    summary = autoloop(researcher=HeuristicResearcher(), output_dir=tmp_path / "run", playbook=start, policy="reason",
                       cases=["battery-biased"], train_seeds=(0, 1), heldout_seeds=(2,),
                       model_spec=ModelSpec("policy", "muse", MUSE_SPARK, "low"))
    assert summary["acceptance"] == "bootstrap"
    assert (summary["train_initial"]["correct"], summary["train_final"]["correct"]) == (0, 2)
    assert (summary["heldout_initial"]["correct"], summary["heldout_final"]["correct"]) == (0, 1)
    assert summary["train_final"]["cost_usd"] is None
    report = json.loads((tmp_path / "run/train/001/report.json").read_text())
    assert all(r["row"]["policy"] for r in report["runs"])


def test_muse_and_meta_cassettes_never_share_keys(tmp_path):
    from autophys.reasoner import ReplayReasoner, _cassette_key, request_body
    messages = [{"role": "user", "content": "x"}]
    meta, muse = (_cassette_key(request_body(route, MUSE_SPARK, messages)) for route in ("meta", "muse"))
    assert meta != muse
    cassette = tmp_path / "c.jsonl"
    reply = {"content": "{}", "model": MUSE_SPARK, "usage": {}, "route": "meta", "elapsed_ms": 1}
    cassette.write_text(json.dumps({"key": meta, "reply": reply}) + "\n" + json.dumps({"key": muse, "reply": reply}) + "\n")
    with pytest.raises(ReasonerError, match="route mismatch"):
        ReplayReasoner(cassette, route="muse", model=MUSE_SPARK).complete(messages)
    assert ReplayReasoner(cassette, route="meta", model=MUSE_SPARK).complete(messages).route == "meta"


def test_unknown_terminal_text_is_not_echoed(tmp_path):
    body = 'ev("run.terminal.credential-sentinel", {"terminal": "credential-sentinel"})'
    with pytest.raises(ReasonerError, match="ended unexpectedly") as info:
        MuseExecReasoner(binary=fake_muse(tmp_path, body)).complete([{"role": "user", "content": "x"}])
    assert "sentinel" not in str(info.value)
