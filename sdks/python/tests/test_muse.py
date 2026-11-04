"""Muse contracts, entirely offline (loopback transport or cassette)."""
import hashlib
import io
import json
from dataclasses import asdict
from pathlib import Path

import pytest

from autophys.agent import Investigation, ReasonLanePolicy, system_prompt
from autophys.bench import case_project, run_case
from autophys.cli import main
from autophys.http import HttpError
from autophys.playbook import load_playbook
from autophys.reasoner import (BudgetError, ChatReasoner, ModelSpec, MUSE_SPARK, MUSE_WONDER,
                              ReasonReply, ReasonerError, RecordingReasoner, ReplayReasoner,
                              reasoner_for, reasoner_from_env, request_body)
from autophys.store import MemoryStore, canonical
from autophys.synthetic import CASES
from autophys.usage import normalize_usage, usage_total
from autophys.workbook import WorkbookError, WorkbookStore, payload_shape

ROOT = Path(__file__).resolve().parents[3]
CASSETTE = ROOT / "tests/conformance/reasoner/spark-oscillator.jsonl"
SPEC = ModelSpec("policy", "meta", MUSE_SPARK)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    for key in ("AUTOPHYS_REASON_RECORD", "AUTOPHYS_REASON_REPLAY", "AUTOPHYS_REASON_ROUTE",
                "AUTOPHYS_REASON_MODEL", "AUTOPHYS_REASON_URL", "AUTOPHYS_ALLOW_LIVE_REASON",
                "MODEL_API_KEY", "BASETEN_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path))


def test_prices_are_identical():
    from autophys import usage
    assert Path(usage.__file__).with_name("prices.json").read_bytes() == (CASSETTE.parent / "prices.json").read_bytes()


def test_playbook_pin_and_fixed_contract(tmp_path):
    original = load_playbook()
    assert original.sha256 == hashlib.sha256(original.data).hexdigest()
    path = tmp_path / "SKILL.md"
    path.write_text('---\nname: alternate\ndescription: "A strategy: with punctuation"\nversion: "2"\n---\nWeigh cost.\n')
    alternate = load_playbook(path.parent)
    assert alternate.name == "alternate" and alternate.version == "2"
    assert system_prompt(alternate).endswith("Weigh cost.\n")
    assert system_prompt(alternate).split("Strategy:")[0] == system_prompt(original).split("Strategy:")[0]
    path.write_text(path.read_text() + "Changed.\n")
    with pytest.raises(ValueError, match="changed"):
        alternate.data


@pytest.mark.parametrize("text", ["bad", "---\nname: x\n---\nbody", "---\nname: x", 
                                       "---\nname: x\nname: y\n---\nbody"])
def test_bad_playbook(tmp_path, text):
    path = tmp_path / "SKILL.md"
    path.write_text(text)
    with pytest.raises(ValueError):
        load_playbook(path)


def test_usage_reasoning_not_double_counted():
    reply = ReasonReply("ok", MUSE_SPARK, {"prompt_tokens": 100, "completion_tokens": 40,
                         "completion_tokens_details": {"reasoning_tokens": 10},
                         "prompt_tokens_details": {"cached_tokens": 20}}, "meta", 2.5)
    usage = normalize_usage(reply)
    assert usage == {"route": "meta", "model": MUSE_SPARK, "input_tokens": 100, "output_tokens": 40,
                     "total_tokens": 140, "reasoning_tokens": 10, "cached_input_tokens": 20,
                     "latency_ms": 2.5, "cost_usd": 0.000295}
    reply.model = "unknown"
    assert normalize_usage(reply)["cost_usd"] is None


def test_legacy_usage_is_skipped_and_cost_unknown(tmp_path):
    # Real persisted old-style step; no provider-key normalization on read.
    with WorkbookStore(tmp_path / "old.ap-workbook") as store:
        pid = store.ensure_project("legacy")
        from autophys.store import config_hash
        cfg = {"name": "legacy"}
        ver = store.put_config_version(pid, config_hash(cfg), cfg)
        inv = store.create_investigation({"project_id": pid, "config_version": ver})
        store.append(inv, "step", {"usage": {"prompt_tokens": 999, "completion_tokens": 888}})
        store.append(inv, "step", {"usage": {"input_tokens": 10, "output_tokens": 5, "cost_usd": 0.1}})
        assert usage_total(r.payload for r in store.records(inv, "step")) == {
            "calls": 1, "input_tokens": 10, "output_tokens": 5, "cost_usd": None}
    assert usage_total([{"usage": {"input_tokens": 1, "output_tokens": 2}}])["cost_usd"] is None


@pytest.mark.parametrize("kind,field,value,path", [
    ("investigation", "playbook", {"name": "x", "version": "1", "sha256": "bad"}, "playbook.sha256"),
    ("investigation", "model", {"role": "wrong", "route": "meta", "model": "x"}, "model.role"),
    ("investigation", "model", {"role": "policy", "route": "meta", "model": "x", "max_tokens": True}, "model.max_tokens"),
    ("investigation", "price", {"model": "x", "as_of": "today", "input_per_mtok": "bad", "output_per_mtok": 1}, "price.input_per_mtok"),
    ("step", "usage", {"input_tokens": -1}, "usage.input_tokens"),
    ("step", "usage", {"output_tokens": True}, "usage.output_tokens"),
    ("step", "usage", {"latency_ms": None}, "usage.latency_ms"),
    ("step", "usage", {"cost_usd": "bad"}, "usage.cost_usd"),
    ("step", "images", [{"sha256": "a"*64, "media_type": 4}], "images[0].media_type"),
    ("step", "replayed", 1, "replayed"),
    ("outcome", "usage_total", {"calls": 1.5}, "usage_total.calls"),
])
def test_trace_validation(kind, field, value, path):
    payload = {"project_id": "p", "config_version": "v", "status": "inconclusive", field: value}
    with pytest.raises(WorkbookError) as exc:
        payload_shape(kind, payload)
    assert exc.value.error == "invalid"
    assert "payload." + path in str(exc.value)


def test_offline_reason_bench_is_deterministic(monkeypatch):
    import autophys.reasoner as module
    monkeypatch.setattr(module, "request_json", lambda *a, **k: pytest.fail("network during replay"))
    rows = [run_case("oscillator", "reason", 0, model_spec=SPEC, replay=CASSETTE) for _ in range(2)]
    one, two = map(asdict, rows)
    one.pop("wall_s")
    two.pop("wall_s")
    assert one == two
    baseline = asdict(run_case("oscillator", "fake-reasoner", 0))
    assert one["status"] == "validated"
    for field in ("simulations", "test_rmse", "requested", "rel_errors"):
        assert one[field] == baseline[field]
    assert one["calls"] > 0 and one["cost_usd"] > 0


def test_cli_replay_and_live_guard():
    out = io.StringIO()
    assert main(["bench", "--policy", "reason", "--model", MUSE_SPARK], out=out) == 2
    assert "AUTOPHYS_ALLOW_LIVE_REASON=1" in out.getvalue()
    out = io.StringIO()
    assert main(["bench", "--policy", "reason", "--model", MUSE_SPARK, "--case", "oscillator",
                 "--seeds", "1", "--replay", str(CASSETTE)], out=out) == 0
    assert all(key in out.getvalue() for key in ("calls", "input_tokens", "output_tokens", "cost_usd"))
    assert "validatedx1" in out.getvalue()


def test_recording_key_exact_post_body_and_replay_miss(tmp_path):
    class FakeHTTP:
        route, model = "meta", MUSE_WONDER
        def complete(self, messages, **kw):
            return ReasonReply("reply", self.model, {"prompt_tokens": 1}, self.route, 3)
    path = tmp_path / "record.jsonl"
    messages = [{"role": "user", "content": "Hi"}]
    kw = {"effort": "high", "max_tokens": 12}
    reply = RecordingReasoner(FakeHTTP(), path).complete(messages, **kw)
    item = json.loads(path.read_text())
    body = request_body("meta", MUSE_WONDER, messages, **kw)
    assert body["max_tokens"] == 1800
    assert item["key"] == hashlib.sha256(canonical(body).encode()).hexdigest()
    replay = ReplayReasoner(path, model=MUSE_WONDER)
    assert replay.complete(messages, **kw).replayed
    assert replay.complete(messages, **kw).usage == reply.usage
    with pytest.raises(ReasonerError, match="replay miss: [0-9a-f]{64}"):
        replay.complete(messages, effort="low")


def test_env_replay_no_credentials(monkeypatch):
    monkeypatch.setenv("AUTOPHYS_REASON_REPLAY", str(CASSETTE))
    assert isinstance(reasoner_from_env(), ReplayReasoner)
    assert isinstance(reasoner_for(SPEC), ReplayReasoner)


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504, None])
def test_retry_transport_and_server_failures(monkeypatch, status):
    import autophys.reasoner as module
    calls, sleeps = [], []
    def fake(*a, **kw):
        calls.append(kw)
        if len(calls) < 4:
            if status is None:
                raise TimeoutError("synthetic timeout")
            raise HttpError(status, "synthetic")
        return 200, {"choices": [{"message": {"content": "ok"}}]}
    monkeypatch.setattr(module, "request_json", fake)
    chat = ChatReasoner(api_key="synthetic-key", sleep=sleeps.append, jitter=lambda: 0.5)
    assert chat.complete([]).content == "ok"
    assert len(calls) == 4 and sleeps == [1, 2, 4]


def test_budget_error_immediate_and_attempt_limit(monkeypatch):
    import autophys.reasoner as module
    calls, sleeps = [], []
    def fake(*a, **kw):
        calls.append(1)
        raise HttpError(402, "synthetic")
    monkeypatch.setattr(module, "request_json", fake)
    with pytest.raises(BudgetError):
        ChatReasoner(api_key="synthetic-key", sleep=sleeps.append).complete([])
    assert calls == [1] and sleeps == []
    monkeypatch.setattr(module, "request_json", lambda *a, **k: (_ for _ in ()).throw(TimeoutError()))
    with pytest.raises(ReasonerError):
        ChatReasoner(api_key="synthetic-key", max_attempts=2, sleep=sleeps.append).complete([])
    assert len(sleeps) == 1


def test_replayed_golden_metadata_blobs_and_totals(tmp_path):
    import shutil
    source = ROOT / "tests/conformance/python/reason-replayed.ap-workbook"
    copy = tmp_path / source.name
    shutil.copyfile(source, copy)
    with WorkbookStore(copy, readonly=True) as store:
        inv = store.investigations()[0]["id"]
        records = store.records(inv)
        for record in records:
            payload_shape(record.kind, record.payload)
        meta = records[0].payload
        playbook = load_playbook()
        assert meta["playbook"] == {"name": playbook.name, "version": playbook.version, "sha256": playbook.sha256}
        assert store.get_blob("sha256:" + playbook.sha256) == (playbook.data, "text/markdown")
        assert meta["model"] == asdict(SPEC)
        assert meta["price"]["model"] == MUSE_SPARK
        steps = [r.payload for r in records if r.kind == "step" and "usage" in r.payload]
        assert all(s["replayed"] is True and "elapsed_ms" in s for s in steps)
        outcome = next(r.payload for r in records if r.kind == "outcome")
        assert outcome["usage_total"] == usage_total(steps)


def test_model_spec_defaults_and_per_model_floor(monkeypatch):
    import autophys.reasoner as module
    bodies = []
    def fake(method, url, body, **kw):
        bodies.append(body)
        return 200, {"choices": [{"message": {"content": "ok"}}]}
    monkeypatch.setattr(module, "request_json", fake)
    spec = ModelSpec("researcher", "baseten", MUSE_WONDER, "high", 12)
    reasoner_for(spec, api_key="synthetic-key").complete([])
    assert bodies == [{"model": MUSE_WONDER, "messages": [], "max_tokens": 1800, "reasoning_effort": "high"}]


def test_invalid_reply_still_records_usage():
    class InvalidReasoner:
        def complete(self, *args, **kw):
            return ReasonReply("not JSON", MUSE_SPARK, {"prompt_tokens": 10, "completion_tokens": 5}, "meta", 1)
    view, _ = CASES["oscillator"](0)
    inv = Investigation(case_project(view), view.dataset, view.runner,
                        policy=ReasonLanePolicy(InvalidReasoner(), model_spec=SPEC))
    out = inv.run()
    assert out.status == "failed"
    assert out.usage_total["calls"] == 3
    assert out.usage_total["input_tokens"] == 30


def test_recording_configured_reasoner_uses_effective_defaults(monkeypatch, tmp_path):
    import autophys.reasoner as module
    sent = []
    def fake(method, url, body, **kw):
        sent.append(body)
        return 200, {"choices": [{"message": {"content": "ok"}}]}
    monkeypatch.setattr(module, "request_json", fake)
    spec = ModelSpec("researcher", "meta", MUSE_WONDER, "high", 2700)
    path = tmp_path / "wrapped.jsonl"
    inner = reasoner_for(spec, api_key="synthetic-key")
    RecordingReasoner(inner, path).complete([])
    assert json.loads(path.read_text())["key"] == hashlib.sha256(canonical(sent[0]).encode()).hexdigest()
    assert sent[0]["max_tokens"] == 2700 and sent[0]["reasoning_effort"] == "high"
