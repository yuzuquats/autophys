"""M-4: offline request parity, plot determinism, blob ordering and adapters."""
import base64
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import struct
import zlib

import pytest

from autophys.agent import Investigation, ReasonLanePolicy, ScriptedPolicy, render_facts
from autophys.bench import case_project
from autophys.http import HttpError, HttpStore
from autophys.reasoner import (ChatReasoner, FakeReasoner, HttpReasoner, ModelSpec, ReasonerError,
                               RecordingReasoner, ReplayReasoner, MUSE_SPARK, MUSE_WONDER,
                               _ConfiguredReasoner, _cassette_key, images_enabled, request_body)
from autophys.store import MemoryStore, JsonlStore, canonical, config_hash
from autophys.synthetic import thermal_case
from autophys.workbook import WorkbookStore
from fake_server import FakeAutophys


IMAGE = {"media_type": "image/png", "data": "aGVsbG8="}


def test_rust_image_request_bytes_and_identity():
    # Hand-transcribed from Rust reasoner/cassette.rs request_body, not a second
    # call to the Python builder. The last user gets text then image_url parts.
    messages = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "plot"}]
    saved = deepcopy(messages)
    expected = {"model": MUSE_WONDER, "max_tokens": 1800, "reasoning_effort": "high",
                "messages": [*messages[:-1], {"role": "user", "content": [
                    {"type": "text", "text": "plot"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}}]}],
                "response_format": {"type": "json_schema", "json_schema": {
                    "name": "decision", "schema": {"type": "object"}}}}
    body = request_body("meta", MUSE_WONDER, messages, images=[IMAGE],
                        max_tokens=4, effort="high", response_schema={"type": "object"})
    assert canonical(body).encode() == canonical(expected).encode()
    assert _cassette_key(body) == hashlib.sha256(canonical(expected).encode()).hexdigest()
    assert messages == saved
    assert request_body("meta", MUSE_SPARK, messages) == {
        "model": MUSE_SPARK, "max_tokens": 1800, "messages": messages}
    assert request_body("meta", MUSE_SPARK, messages, images=[]) == request_body("meta", MUSE_SPARK, messages)
    with pytest.raises(ReasonerError, match="require a user"):
        request_body("meta", MUSE_SPARK, [{"role": "developer", "content": "x"}], images=[IMAGE])
    for media in ["text/plain", "image/png;bad", "image/png\n", "image/png,bad"]:
        with pytest.raises(ReasonerError, match="media_type"):
            request_body("meta", MUSE_SPARK, messages, images=[{**IMAGE, "media_type": media}])
    with pytest.raises(ReasonerError, match="text-only"):
        request_body("lane", "", messages, images=[IMAGE])
    with pytest.raises(ReasonerError, match="text-only"):
        HttpReasoner("http://unused").complete(messages, images=[IMAGE])


def test_chat_record_replay_configured_and_fake_images(tmp_path, monkeypatch):
    sent = []
    def request(owner, body, label):
        sent.append(body)
        return {"choices": [{"message": {"content": "ok"}}]}
    monkeypatch.setattr("autophys.reasoner._request_with_retry", request)
    chat = ChatReasoner(api_key="unused")
    messages = [{"role": "user", "content": "plot"}]
    assert chat.complete(messages, images=[IMAGE]).content == "ok"
    assert sent[0]["messages"][0]["content"][1]["image_url"]["url"].endswith(IMAGE["data"])
    fake = FakeReasoner(lambda m: {"ok": True})
    spec = ModelSpec("policy", "meta", MUSE_SPARK, effort="high", max_tokens=2400, images=True)
    configured = _ConfiguredReasoner(fake, spec)
    path = tmp_path / "offline-images.jsonl"
    recorder = RecordingReasoner(configured, path)
    reply = recorder.complete(messages, images=[IMAGE])
    assert fake.calls[0]["images"] == [IMAGE]
    replay = _ConfiguredReasoner(ReplayReasoner(path), spec)
    assert replay.complete(messages, images=[IMAGE]).content == reply.content
    with pytest.raises(ReasonerError, match="replay miss"):
        replay.complete(messages)
    with pytest.raises(ReasonerError, match="replay miss"):
        replay.complete(messages, images=[{**IMAGE, "data": "different"}])


@pytest.mark.parametrize("model", [MUSE_SPARK, MUSE_WONDER, "unknown"])
def test_capability_opt_in(model, monkeypatch):
    assert not images_enabled(ModelSpec("policy", "meta", model))
    assert images_enabled(ModelSpec("policy", "meta", model, images=True))
    assert not images_enabled(ModelSpec("policy", "lane", model, images=True))
    monkeypatch.setitem(__import__("autophys.reasoner", fromlist=["IMAGE_CAPABILITIES"]).IMAGE_CAPABILITIES, model, False)
    assert not images_enabled(ModelSpec("policy", "meta", model, images=True))


def make_inv(store, enabled=True):
    view, _ = thermal_case(0, max_experiments=0)
    policy = ScriptedPolicy()
    policy.render_images = enabled
    return Investigation(case_project(view), view.dataset, view.runner, policy=policy, store=store, seed=0)


def decode_png(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    offset, compressed, kinds = 8, b"", []
    while offset < len(data):
        size = struct.unpack(">I", data[offset:offset+4])[0]
        kind, body = data[offset+4:offset+8], data[offset+8:offset+8+size]
        assert zlib.crc32(kind+body) & 0xffffffff == struct.unpack(">I", data[offset+8+size:offset+12+size])[0]
        kinds.append(kind)
        if kind == b"IHDR":
            assert struct.unpack(">IIBBBBB", body) == (640,400,8,3,0,0,0)
        if kind == b"IDAT":
            compressed += body
        offset += size+12
    assert kinds == [b"IHDR",b"PLTE",b"IDAT",b"IEND"]
    rows = zlib.decompress(compressed)
    assert len(rows) == 400*641
    assert all(rows[i*641] == 0 for i in range(400))
    assert {1,2,3,4,5} <= set(rows)
    assert len(data) <= 64*1024


@pytest.mark.parametrize("kind", ["memory", "jsonl", "workbook", "http"])
def test_adopted_fit_plots_blobs_before_step_and_no_numerical_effect(kind, tmp_path):
    with FakeAutophys() as server:
        store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path/"json"),
                 "workbook": lambda: WorkbookStore(tmp_path/"plots.ap-workbook"),
                 "http": lambda: HttpStore(server.url, server.issue_key())}[kind]()
        original = store.append
        def append(inv, kind, payload, **kw):
            for ref in payload.get("images", []):
                data, media = store.get_blob(ref["sha256"])
                assert media == ref["media_type"] == "image/png"
                assert ref["sha256"] == "sha256:"+hashlib.sha256(data).hexdigest()
                assert set(ref) == {"sha256","media_type","caption"}
                decode_png(data)
            return original(inv, kind, payload, **kw)
        store.append = append
        inv = make_inv(store)
        out = inv.run()
        assert inv.plot_refs
        plain = make_inv(MemoryStore(), False)
        expected = plain.run()
        assert {k:v for k,v in out.to_dict().items() if k not in ("wall_s", "investigation")} == {
            k:v for k,v in expected.to_dict().items() if k not in ("wall_s", "investigation")}
        assert render_facts(inv.facts()) == render_facts(plain.facts())
        assert any(r.payload.get("images") for r in inv.records("step"))
        from autophys.plots import render_plots
        measurements = inv.records("measurement")
        curves = inv.records("run")[-1].payload["curves"]
        def render(_):
            return list(render_plots(measurements, curves))
        with ThreadPoolExecutor(4) as pool:
            parallel = list(pool.map(render, range(4)))
        assert all(items == render(None) for items in parallel)
        if hasattr(store, "close"):
            store.close()


def test_policy_sends_stored_images_and_resume():
    from autophys.bench import heuristic_responder
    fake = FakeReasoner(heuristic_responder)
    spec = ModelSpec("policy", "meta", MUSE_SPARK, images=True)
    policy = ReasonLanePolicy(fake, model_spec=spec)
    view, _ = thermal_case(0, max_experiments=0)
    inv = Investigation(case_project(view), view.dataset, view.runner, policy=policy, seed=0)
    inv.run()
    calls = [c for c in fake.calls if c.get("images")]
    assert calls
    for image in calls[-1]["images"]:
        data = base64.b64decode(image["data"])
        assert inv.store.get_blob("sha256:"+hashlib.sha256(data).hexdigest())[0] == data
    resumed = Investigation.resume(inv.project, inv.store, inv.id, policy=ReasonLanePolicy(fake, model_spec=spec))
    assert resumed.policy.plot_images == inv.policy.plot_images


def test_http_create_retry_reuses_explicit_key_and_conflicts():
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        pid = store.ensure_project("plots")
        version = store.put_config_version(pid, config_hash({"name":"plots"}), {"name":"plots"})
        meta = {"project_id":pid, "config_version":version}
        inv = store.create_investigation(meta, idempotency_key="logical-create")
        assert store.create_investigation(meta, idempotency_key="logical-create") == inv
        # A new client can retry after losing the response.
        other = HttpStore(server.url, server.issue_key())
        assert other.create_investigation(meta, idempotency_key="logical-create") == inv
        assert len(server.investigations) == 1
        assert len(store.records(inv)) == 1
        with pytest.raises(HttpError) as error:
            store.create_investigation({**meta,"title":"different"}, idempotency_key="logical-create")
        assert error.value.error == "idempotency_conflict"
        assert store.create_investigation(meta) != inv
        assert len(server.investigations) == 2


def test_researcher_api_and_muse_workspace_plots(tmp_path, monkeypatch):
    import autophys.research as module
    from autophys.playbook import load_playbook
    from types import SimpleNamespace
    path = tmp_path/"plots.ap-workbook"
    with WorkbookStore(path) as store:
        inv = make_inv(store)
        inv.run()
        report = {"plot_artifacts":[{"workbook":str(path),"images":inv.plot_refs}], "score":{}}
    text = load_playbook("default").data.decode()
    proposed = text + "\nPrefer informative experiments.\n"
    fake = FakeReasoner(lambda m:proposed)
    spec = ModelSpec("researcher", "meta", MUSE_WONDER, images=True)
    assert module.APIResearcher(spec, reasoner=fake).propose(text, report) == proposed
    assert fake.calls[-1]["images"]
    assert "plot_artifacts" not in fake.calls[-1]["messages"][0]["content"]
    assert module.report_images(report, ModelSpec("researcher", "meta", MUSE_WONDER)) == []
    monkeypatch.setattr(module, "require_replay", lambda *a,**kw:None)
    def run(argv, **kw):
        workspace = Path(argv[argv.index("--workspace")+1])
        index = json.loads((workspace/"plot-images.json").read_text())
        assert index
        for item in index:
            decode_png((workspace/item["file"]).read_bytes())
        assert "plot-images.json" in (workspace/"prompt.txt").read_text()
        (workspace/"SKILL.md").write_text(proposed)
        return SimpleNamespace(returncode=0, stdout='{"type":"result","subtype":"success"}')
    monkeypatch.setattr(module.subprocess, "run", run)
    monkeypatch.setattr(module, "parse_muse_events", lambda s:{"terminal":"completed"})
    assert module.MuseCLIResearcher(spec=spec).propose(text,report) == proposed


def test_cli_image_flags():
    from autophys.cli import build_parser
    parser = build_parser()
    assert not parser.parse_args(["bench"]).images
    assert parser.parse_args(["bench","--images"]).images
    args = parser.parse_args(["research","--output-dir","unused","--images","--researcher-images"])
    assert args.images and args.researcher_images
