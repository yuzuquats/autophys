"""Consolidated experimental entrypoints: no provider SDK, model, or recorded data."""
import ast
import importlib.util
import json
from pathlib import Path
import socket
import sys
import types
import urllib.request

import pytest

HERE = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("offline consolidation check attempted network")
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(urllib.request, "urlopen", denied)


def function(name):
    """Load the actual entry function without importing Modal's image declarations."""
    tree = ast.parse((HERE / "modal_app.py").read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    scope = {"Path": Path, "json": json, "sys": sys, "HERE": HERE, "time": types.SimpleNamespace(time=lambda: 0)}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(HERE / "modal_app.py"), "exec"), scope)
    return scope[name], scope


@pytest.mark.parametrize("base_only", [False, True])
def test_eval_local_entry_transports_the_planned_assets(tmp_path, monkeypatch, base_only):
    entry, scope = function("eval_main")
    identity = {"model": "local/model", "revision": "a" * 40}
    payload = {"manifest": "identified-input", "files": {}}
    class Assets:
        def __init__(self, model, directory):
            assert (model, directory) == ("local/model", "prepared-assets")
            self.identity = identity
        def modal_payload(self, expected):
            assert expected == identity
            return payload
    monkeypatch.setitem(sys.modules, "model_assets", types.SimpleNamespace(ModelAssets=Assets))
    calls = []
    class Remote:
        def with_options(self, **options):
            assert options == {"gpu": "offline", "timeout": 1}
            return self
        def remote(self, *args):
            calls.append(args)
            return {"files": {}, "calls": 0, "gpu_seconds": 0}
    scope["eval_adapter"] = Remote()
    entry("run", "local/model", str(tmp_path / "eval"), "offline", 1,
          base_only=base_only, model_assets="prepared-assets", planned_assets=json.dumps(identity))
    assert calls == [("run", "local/model", "3,4", [], base_only,
                      {"base_model": "local/model", "planned_assets": identity, "model_assets_payload": payload})]


def test_base_only_refuses_unprepared_inputs_before_transport(tmp_path):
    entry, scope = function("eval_main")
    scope["eval_adapter"] = None
    with pytest.raises(ValueError, match="prepared model assets"):
        entry("run", "local/model", str(tmp_path / "eval"), "offline", 1, base_only=True)
    assert not (tmp_path / "eval").exists()


def test_eval_remote_pins_model_and_refuses_a_different_returned_revision(monkeypatch):
    entry, scope = function("eval_adapter")
    revision = "a" * 40
    scope["bound_training_inputs"] = lambda cfg, rows: (None, types.SimpleNamespace(identity={"revision": revision}))
    calls = []
    def load(base, **options):
        calls.append((base, options))
        return types.SimpleNamespace(config=types.SimpleNamespace(_commit_hash="b" * 40))
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(bfloat16="offline"))
    monkeypatch.setitem(sys.modules, "peft", types.SimpleNamespace(PeftModel=None))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(
        AutoModelForCausalLM=types.SimpleNamespace(from_pretrained=load), AutoTokenizer=None))
    monkeypatch.setitem(sys.modules, "train_sft", types.SimpleNamespace(Encoder=None))
    with pytest.raises(ValueError, match="differs from the planned revision"):
        entry("baseline", "local/model", "3,4", [], True, {"base_model": "local/model"})
    assert calls == [("local/model", {"revision": revision, "trust_remote_code": False,
                                     "dtype": "offline", "device_map": "cuda"})]


def test_label_response_preserves_existing_labels_and_explicit_provenance(tmp_path):
    spec = importlib.util.spec_from_file_location("real_labels", HERE / "real_label.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pending = [{"key": "first", "trajectory": "one", "step": 1}, {"key": "second"}]
    (tmp_path / "pending.jsonl").write_text("".join(json.dumps(row) + "\n" for row in pending))
    labels = tmp_path / "labels.jsonl"
    labels.write_text('{"key":"prior","response":"prior"}\n')
    response = {"action": "stop", "arguments": {"status": "inconclusive"}}
    argv = ["label-response", "--work", str(tmp_path), "--labels", str(labels),
            "--response", json.dumps(response), "--labeller", "human-reviewer"]
    assert mod.main(argv) == 0
    rows = [json.loads(line) for line in labels.read_text().splitlines()]
    assert rows == [{"key": "prior", "response": "prior"},
                    {**pending[0], "response": response, "labeller": "human-reviewer"},
                    {**pending[1], "response": response, "labeller": "human-reviewer"}]
    previous = labels.read_bytes()
    argv[argv.index("--response") + 1] = "not JSON"
    with pytest.raises(ValueError): mod.main(argv)
    assert labels.read_bytes() == previous
