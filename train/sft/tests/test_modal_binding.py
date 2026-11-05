"""Real Modal entry/encoder dispatch with offline provider facades, never a GPU."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import types
import urllib.request

import pytest
from tokenizers import Tokenizer

from test_asset_planning import prepared, MODEL, ANSWER, HERE
from model_assets import ModelAssets

REVISION = "a" * 40


def assets_at_commit(tmp_path):
    path, data = prepared(tmp_path)
    manifest = json.loads((path / "manifest.json").read_text())
    manifest["revision"] = REVISION
    (path / "manifest.json").write_text(json.dumps(manifest, sort_keys=True))
    return path, data


def modal_facade(record):
    class Function:
        def __init__(self, fn): self.fn = fn
        def with_options(self, **kw):
            record("options", options=kw)
            return self
        def remote(self, *args):
            record("remote-entry", cfg=args[0])
            return self.fn(*args)
    class Builder:
        def __getattr__(self, key): return lambda *a, **kw: self
    class App:
        def __init__(self, *a): pass
        def function(self, **kw): return Function
        def local_entrypoint(self): return lambda fn: fn
    return types.SimpleNamespace(
        App=App, Volume=types.SimpleNamespace(from_name=lambda *a, **kw: Builder()),
        Image=types.SimpleNamespace(debian_slim=lambda **kw: Builder()))


def subject(record, path=HERE / "modal_app.py"):
    spec = importlib.util.spec_from_file_location("offline_modal_subject", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def remote_tokenizer(assets, mode="match"):
    # A separately loaded real tokenizers backend, not the planner's object.
    raw = json.loads((assets.path / "tokenizer.json").read_text())
    if mode == "ids": raw["model"]["vocab"]["S"] = 11
    if mode == "unused-ids": raw["model"]["vocab"]["7"] = 11
    backend = Tokenizer.from_str(json.dumps(raw))
    return types.SimpleNamespace(
        backend_tokenizer=backend,
        chat_template=assets.template + ("changed" if mode == "template" else ""),
        special_tokens_map={**assets.special, **({"eos_token": "different"} if mode == "special" else {})},
        init_kwargs={} if mode == "missing-revision" else {"_commit_hash": "b" * 40 if mode == "revision" else REVISION},
        encode=lambda text, **kw: backend.encode(text, add_special_tokens=False).ids)


def install_tokenizer(assets, mode, record):
    def load(base, **kw):
        record("tokenizer", base=base, options=kw)
        assert base == MODEL and kw == {"revision": REVISION, "trust_remote_code": False}
        return remote_tokenizer(assets, mode)
    return types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=load))


def training_standin(record):
    def train(cfg, tr, va, ho, meta, tok, enc):
        assert tr == va == [("S", "U", ANSWER)]
        assert enc.tokens(*tr[0]) == ([5, 6, 1, 9, 7, 2, 9, 8], [3, 9])
        assert enc.encode("7 8") == [4, 10]
        record("training-body", identity=enc.identity, tokens=enc.tokens(*tr[0]))
        return {"run_id": "offline-modal", "sampler_weights": "offline-adapter", "state": None,
                "model_assets": enc.identity, "model_revision": enc.identity["revision"]}
    return train


@pytest.fixture(autouse=True)
def outbound_denied(monkeypatch):
    def denied(*a, **kw): raise AssertionError("offline Modal proof attempted network")
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(urllib.request, "urlopen", denied)


@pytest.mark.parametrize("mode", ["match", "template", "ids", "unused-ids", "special", "revision", "missing-revision",
                                 "payload-tamper", "missing-payload", "planned-revision", "mutable-revision",
                                 "missing-identity", "mutable-local-revision"])
def test_actual_local_entry_remote_entry_and_training_boundary(tmp_path, monkeypatch, mode):
    path, data = assets_at_commit(tmp_path)
    if mode == "mutable-local-revision":
        manifest = json.loads((path / "manifest.json").read_text())
        manifest["revision"] = "main"
        (path / "manifest.json").write_text(json.dumps(manifest))
    assets = ModelAssets(MODEL, path)
    events = []
    record = lambda kind, **kw: events.append({"event": kind, **kw})
    monkeypatch.setitem(sys.modules, "modal", modal_facade(record))
    monkeypatch.setitem(sys.modules, "transformers", install_tokenizer(assets, mode, record))
    mod = subject(record)
    mod.HERE = tmp_path
    mod._train_lora = training_standin(record)
    original = mod.train_lora.fn
    def transport(cfg, *args):
        cfg = copy.deepcopy(cfg)
        if mode == "payload-tamper": cfg["model_assets_payload"]["files"]["chat_template.jinja"] += "changed"
        if mode == "missing-payload": cfg.pop("model_assets_payload")
        if mode == "planned-revision": cfg["planned_assets"]["revision"] = "b" * 40
        return original(cfg, *args)
    mod.train_lora.fn = transport
    expected = copy.deepcopy(assets.identity)
    if mode == "mutable-revision": expected["revision"] = "main"
    if mode == "missing-identity": expected = {}
    kwargs = dict(name="bound", base_model=MODEL, data=str(data), gpu="L40S", timeout=2880,
                  model_assets=str(path), planned_assets=json.dumps(expected))
    if mode == "match":
        mod.train_main(**kwargs)
        result = json.loads((tmp_path / "runs/bound/run.json").read_text())
        assert result["model_assets"] == assets.identity and result["model_revision"] == REVISION
        assert [e["event"] for e in events] == ["options", "remote-entry", "tokenizer", "training-body"]
        assert events[0]["options"] == {"gpu": "L40S", "timeout": 2880}
        assert events[1]["cfg"]["planned_assets"] == assets.identity
    else:
        with pytest.raises(ValueError): mod.train_main(**kwargs)
        assert not any(e["event"] == "training-body" for e in events)
        assert not (tmp_path / "runs/bound/run.json").exists()
        if mode in ["payload-tamper", "missing-payload", "planned-revision", "mutable-revision", "missing-identity", "mutable-local-revision"]:
            assert not any(e["event"] == "tokenizer" for e in events)


def test_model_acquisition_is_revision_pinned_and_returned_revision_checked(tmp_path, monkeypatch):
    path, _ = assets_at_commit(tmp_path)
    assets = ModelAssets(MODEL, path)
    from train_sft import Encoder
    enc = Encoder(MODEL, assets=assets)
    events = []
    monkeypatch.setitem(sys.modules, "modal", modal_facade(lambda *a, **kw: None))
    mod = subject(None)
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(manual_seed=lambda seed: None, bfloat16="offline-bfloat16"))
    monkeypatch.setitem(sys.modules, "peft", types.SimpleNamespace(LoraConfig=None, get_peft_model=None))
    monkeypatch.setitem(sys.modules, "autophys.reasoner", types.SimpleNamespace(parse_json_content=None))
    def load(base, **kw):
        events.append((base, kw))
        # Must reject immediately, before any model/training method.
        return types.SimpleNamespace(config=types.SimpleNamespace(_commit_hash="b" * 40))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(
        AutoModelForCausalLM=types.SimpleNamespace(from_pretrained=load)))
    with pytest.raises(ValueError, match="model revision differs"):
        mod._train_lora(dict(name="model", base_model=MODEL, seed=0, max_seq_len=100),
                        [("S", "U", ANSWER)], [("S", "U", ANSWER)], [], None, None, enc)
    assert events == [(MODEL, dict(revision=REVISION, trust_remote_code=False, dtype="offline-bfloat16", device_map="cuda"))]


def run_offline_modal():
    """Executed by the actual native CLI's python -m modal argv."""
    events = Path(os.environ["OFFLINE_MODAL_EVENTS"])
    def record(kind, **kw):
        with events.open("a") as out: out.write(json.dumps({"event": kind, **kw}) + "\n")
    def denied(*a, **kw): raise AssertionError("offline native dispatch attempted network")
    socket.create_connection = socket.getaddrinfo = urllib.request.urlopen = denied
    record("argv", argv=sys.argv)
    sys.modules["modal"] = modal_facade(record)
    target, entry = sys.argv[2].split("::")
    assert entry == "train_main"
    mod = subject(record, Path(target))
    mod.HERE = Path(target).parent
    kwargs = {sys.argv[i][2:].replace("-", "_"): sys.argv[i + 1] for i in range(3, len(sys.argv), 2)}
    kwargs["timeout"] = int(kwargs["timeout"])
    assets = ModelAssets(MODEL, kwargs["model_assets"])
    sys.modules["transformers"] = install_tokenizer(assets, os.environ.get("OFFLINE_MODAL_MODE", "match"), record)
    train = training_standin(record)
    def result_body(*args):
        result = train(*args)
        mode = os.environ.get("OFFLINE_MODAL_MODE")
        if mode == "result-assets":
            result["model_assets"] = {**result["model_assets"], "manifest_sha256": "0" * 64}
        if mode == "result-revision": result["model_revision"] = "b" * 40
        return result
    mod._train_lora = result_body
    mod.train_main(**kwargs)


@pytest.mark.skipif(not os.environ.get("AUTOPHYS_TEST_NATIVE_BINARY"), reason="set a qualified native CLI artifact")
@pytest.mark.parametrize("mode", ["match", "env-assets", "template", "ids", "revision", "missing-revision", "budget", "result-assets", "result-revision"])
def test_native_actual_modal_argv_provenance_refusal_and_retry(tmp_path, mode):
    path, data = assets_at_commit(tmp_path)
    assets = ModelAssets(MODEL, path)
    worker = tmp_path / "worker"; worker.mkdir()
    for source in HERE.glob("*.py"): (worker / source.name).symlink_to(source)
    # This module only replaces Modal's provider transport; actual local and
    # remote entrypoint functions and Encoder remain the product implementations.
    (worker / "modal.py").write_text("from test_modal_binding import run_offline_modal\nrun_offline_modal()\n")
    events = tmp_path / "events.jsonl"
    env = dict(HOME=str(tmp_path), PATH="/usr/bin:/bin", PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=str(Path(__file__).parent), TMPDIR=str(tmp_path),
               OFFLINE_MODAL_MODE=mode, OFFLINE_MODAL_EVENTS=str(events),
               MODAL_TOKEN_ID="offline-never-sent", MODAL_TOKEN_SECRET="offline-never-sent",
               AUTOPHYS_TRAIN_WORKER_TIMEOUT_SECONDS="5", AUTOPHYS_TRAIN_WORKER_GRACE_SECONDS="2",
               AUTOPHYS_TRAIN_WORKER_OUTPUT_BYTES="1048576")
    argv = [os.environ["AUTOPHYS_TEST_NATIVE_BINARY"], "train", "run", "--json", "--name", "bound",
            "--base-model", MODEL, "--data", str(data), "--train-dir", str(worker),
            "--python", sys.executable, "--model-assets", str(path), "--backend", "modal", "--gpu", "L40S",
            "--usd-per-hour", "1", "--max-usd", "0.0001" if mode == "budget" else "1", "--live"]
    if mode == "env-assets":
        env["AUTOPHYS_TRAIN_MODEL_ASSETS"] = str(path)
        index = argv.index("--model-assets")
        argv = argv[:index] + argv[index + 2:]
    out = subprocess.run(argv, env=env, capture_output=True, timeout=9)
    manifest_path = worker / "runs/bound/manifest.json"
    before_bytes = manifest_path.read_bytes()
    manifest = json.loads(before_bytes)
    assert manifest["plan"]["model_assets"] == assets.identity
    assert manifest["budget"]["live_allowed"] == (mode != "budget")
    if mode == "budget":
        assert out.returncode == 1 and manifest["status"] == "planned"
        assert not events.exists()  # budget refuses before transport
        return
    raw = [json.loads(line) for line in events.read_text().splitlines()]
    cli_kwargs = raw[0]["argv"]
    assert json.loads(cli_kwargs[cli_kwargs.index("--planned-assets") + 1]) == assets.identity
    assert Path(cli_kwargs[cli_kwargs.index("--model-assets") + 1]) == path
    assert raw[1] == {"event": "options", "options": {"gpu": "L40S", "timeout": 2880}}
    assert raw[2]["cfg"]["planned_assets"] == assets.identity
    if mode in ["match", "env-assets"]:
        assert out.returncode == 0, out.stderr
        assert manifest["status"] == "completed"
        assert manifest["model_assets"] == assets.identity and manifest["model_revision"] == REVISION
    else:
        assert out.returncode == 1 and manifest["status"] == "failed", out.stderr
        assert manifest["remote_status"] == "unconfirmed"
        if mode.startswith("result-"):
            assert any(e["event"] == "training-body" for e in raw)
            assert "malformed worker result" in manifest["worker_error"]
        else:
            assert not any(e["event"] == "training-body" for e in raw)
            assert not (worker / "runs/bound/run.json").exists()
        # Same-name retry preserves failed provenance/budget, then succeeds.
        env["OFFLINE_MODAL_MODE"] = "match"
        retry = subprocess.run(argv, env=env, capture_output=True, timeout=9)
        assert retry.returncode == 0, retry.stderr
        current = json.loads(manifest_path.read_text())
        assert current["status"] == "completed" and current["attempt_id"] != manifest["attempt_id"]
        assert (manifest_path.parent / current["previous_manifest"]).read_bytes() == before_bytes
        assert current["budget"] == manifest["budget"]
