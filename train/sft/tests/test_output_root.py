"""Workers write under AUTOPHYS_TRAIN_DATA (the CLI's data directory), else next to themselves (CLI-16)."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import types

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
SDK = HERE.parents[1] / "sdks/python/src"
if SDK.is_dir():
    sys.path.insert(0, str(SDK))


def load(name):
    spec = importlib.util.spec_from_file_location(f"output_root_{name}", HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("name", ["train_sft", "patch_chat_template", "build_dataset", "real_label"])
def test_out_root_defaults_next_to_the_worker_and_follows_the_env(name, monkeypatch, tmp_path):
    monkeypatch.delenv("AUTOPHYS_TRAIN_DATA", raising=False)
    try:
        module = load(name)
    except ImportError as e:
        pytest.skip(f"{name} needs {e.name}")
    assert module.out_root() == module.HERE
    monkeypatch.setenv("AUTOPHYS_TRAIN_DATA", str(tmp_path))
    assert module.out_root() == tmp_path


@pytest.mark.parametrize("name", ["train_sft", "patch_chat_template"])
def test_default_dataset_prefers_a_built_one_over_the_shipped_one(name, monkeypatch, tmp_path):
    try:
        module = load(name)
    except ImportError as e:
        pytest.skip(f"{name} needs {e.name}")
    monkeypatch.setenv("AUTOPHYS_TRAIN_DATA", str(tmp_path))
    assert module.default_dataset() == module.HERE / "data"
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "train.jsonl").write_text("")
    assert module.default_dataset() == tmp_path / "data"


def test_modal_train_main_writes_its_record_to_the_data_dir(monkeypatch, tmp_path):
    """The actual local entrypoint, without importing Modal's image declarations."""
    tree = ast.parse((HERE / "modal_app.py").read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "train_main")
    node.decorator_list = []
    code = tmp_path / "code"
    data = tmp_path / "data"

    class Assets:
        identity = {"model": "local/model"}
        def __init__(self, model, directory): pass
        def modal_payload(self, expected): return {}

    class Remote:
        def with_options(self, **options): return self
        def remote(self, cfg, *rows): return {"run_id": "modal:" + cfg["name"], "sampler_weights": "offline"}

    monkeypatch.setitem(sys.modules, "model_assets", types.SimpleNamespace(ModelAssets=Assets))
    monkeypatch.setitem(sys.modules, "train_sft", types.SimpleNamespace(load=lambda path: []))
    scope = {"Path": Path, "json": json, "os": os, "sys": sys, "HERE": code, "train_lora": Remote()}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(HERE / "modal_app.py"), "exec"), scope)
    monkeypatch.setenv("AUTOPHYS_TRAIN_DATA", str(data))
    scope["train_main"]("bound", "local/model", str(tmp_path / "rows"), "offline", 1)
    assert json.loads((data / "runs/bound/run.json").read_text())["run_id"] == "modal:bound"
    assert not code.exists()
    monkeypatch.delenv("AUTOPHYS_TRAIN_DATA")
    scope["train_main"]("by-hand", "local/model", str(tmp_path / "rows"), "offline", 1)
    assert (code / "runs/by-hand/run.json").is_file()
