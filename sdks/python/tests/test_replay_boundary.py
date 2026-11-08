"""A fixed historical transport corpus and a separate numerical round trip."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from autophys.agent import DECISION_SCHEMA, system_prompt
from autophys.reasoner import MUSE_SPARK, ReasonerError, ReplayReasoner, request_body
from autophys.store import canonical

ROOT = Path(__file__).resolve().parents[3]
CASSETTE = ROOT / "tests/conformance/reasoner/spark-oscillator.jsonl"
GOLDEN = ROOT / "tests/conformance/python/reason-replayed.ap-workbook"


def historical_requests():
    # No solver rerun and no SQLite journal writes into the immutable corpus.
    with sqlite3.connect(GOLDEN.as_uri() + "?mode=ro&immutable=1", uri=True) as conn:
        steps = [json.loads(row[0]) for row in conn.execute(
            "SELECT payload FROM records WHERE kind='step' ORDER BY seq")]
    return [[{"role": "developer", "content": system_prompt()},
             {"role": "user", "content": s["evidence_text"]}]
            for s in steps if "evidence_text" in s]


def test_all_eight_historical_requests_replay_exactly():
    items = [json.loads(line) for line in CASSETTE.read_text().splitlines()]
    messages = historical_requests()
    assert len(messages) == len(items) == 8
    replay = ReplayReasoner(CASSETTE)
    for request, item in zip(messages, items):
        body = request_body("meta", MUSE_SPARK, request, response_schema=DECISION_SCHEMA)
        assert hashlib.sha256(canonical(body).encode()).hexdigest() == item["key"]
        reply = replay.complete(request, response_schema=DECISION_SCHEMA)
        assert reply.replayed and reply.content == item["reply"]["content"]
        assert reply.usage == item["reply"]["usage"]


@pytest.mark.parametrize("field", ["request", "schema", "model", "effort", "tokens", "route"])
def test_historical_one_field_changes_still_miss(field):
    messages = historical_requests()[0]
    options = {"response_schema": copy.deepcopy(DECISION_SCHEMA)}
    route, model = "meta", MUSE_SPARK
    if field == "request":
        messages[-1]["content"] += " perturbed"
    elif field == "schema":
        options["response_schema"]["description"] = "perturbed"
    elif field == "model":
        model = "different-model"
    elif field == "effort":
        options["effort"] = "high"
    elif field == "tokens":
        options["max_tokens"] = 2700
    elif field == "route":
        route = "muse"
    with pytest.raises(ReasonerError, match="replay miss"):
        ReplayReasoner(CASSETTE, route=route, model=model).complete(messages, **options)


def test_fake_capture_has_no_provider_or_socket_path(tmp_path, monkeypatch):
    import socket
    import autophys.reasoner as reasoner
    from reasoner_cassette import generate
    def denied(*args, **kwargs):
        pytest.fail("fake capture attempted network/provider selection")
    for name in ("reasoner_for", "reasoner_from_env", "request_json", "ChatReasoner", "HttpReasoner", "MuseExecReasoner"):
        monkeypatch.setattr(reasoner, name, denied)
    monkeypatch.setattr(socket, "socket", denied)
    path = generate(tmp_path / "local.jsonl")
    from reasoner_cassette import ACTIONS
    assert len(path.read_text().splitlines()) == len(ACTIONS)
    with pytest.raises(FileExistsError):
        generate(path)
