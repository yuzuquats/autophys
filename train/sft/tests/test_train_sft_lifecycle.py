"""Training ownership qualification with offline stand-ins; no billing proof."""
from pathlib import Path
import importlib.util
import json
import sys
import types

import pytest

HERE = Path(__file__).resolve().parents[1]
# Rendering assets/dependencies are a separate qualification boundary. Inject
# only these imports; Encoder itself still runs with fault-injected operations.
from unittest.mock import patch
render = types.ModuleType("render")
render.end_of_turn = render.render_prompt = render.special_tokens = lambda *a, **kw: None
patcher = types.ModuleType("patch_chat_template")
patcher.fetch = lambda model: None
spec = importlib.util.spec_from_file_location("train_sft_lifecycle_subject", HERE / "train_sft.py")
sft = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"render": render, "patch_chat_template": patcher}):
    spec.loader.exec_module(sft)


class PrimaryError(RuntimeError):
    pass


class DeadlineExit(BaseException):
    pass


@pytest.fixture
def lab(tmp_path, monkeypatch):
    calls = []
    fault = {"at": None, "cleanup": None}
    def hit(at):
        calls.append(at)
        if fault["at"] == at:
            raise PrimaryError(at)
        if fault["at"] == "interrupt" and at == "tokenizer":
            raise KeyboardInterrupt("interrupted")
        if fault["at"] == "system-exit" and at == "tokenizer":
            raise SystemExit(7)
    class Deployment:
        deployment_id = "offline-deployment"
    service_client = types.ModuleType("baseten.loops.service_client")
    original = lambda run: Deployment()
    service_client.deployment_from_run = original
    class Future:
        def __init__(self, at): self.at = at
        def result(self, **kw):
            hit(self.at)
            return types.SimpleNamespace(loss=0.5, path="offline-weights")
    class Tokenizer:
        def encode(self, text, **kw):
            hit("tokenization")
            return [1] * (4096 if fault["at"] == "overlength" else 2)
    class Client:
        run_id = "offline-run"
        def get_tokenizer(self):
            hit("tokenizer")
            if fault["at"] == "deadline": timers[0].callback()
            return Tokenizer()
        def forward(self, *a): return Future("validation")
        def forward_backward(self, *a): return Future("train")
        def optim_step(self, *a): return Future("optim")
        def save_weights_for_sampler(self, **kw): return Future("save-sampler")
        def save_state(self, **kw): return Future("save-state")
        def close(self):
            calls.append("client-close")
            if fault["cleanup"] in ("client", "both"): raise RuntimeError("close failed")
    class Service:
        def __init__(self): hit("service")
        def create_lora_training_client(self, **kw):
            hit("acquire")
            service_client.deployment_from_run({"id": "offline-run"})
            return Client()
        def close(self):
            calls.append("service-close")
            if fault["cleanup"] == "service": raise RuntimeError("service close failed")
    timers = []
    class Timer:
        def __init__(self, seconds, callback):
            self.callback = callback; self.cancelled = False; timers.append(self)
        def start(self): pass
        def cancel(self): self.cancelled = True
    loops = types.ModuleType("baseten.loops")
    loops.ServiceClient, loops.service_client = Service, service_client
    loops.AdamParams = lambda **kw: kw
    baseten = types.ModuleType("baseten"); baseten.loops = loops
    deployment_module = types.ModuleType("baseten.loops.trainer_deployment")
    deployment_module.DedicatedTrainerDeployment = Deployment
    for name, module in {"baseten": baseten, "baseten.loops": loops,
                         "baseten.loops.service_client": service_client,
                         "baseten.loops.trainer_deployment": deployment_module}.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setenv("BASETEN_API_KEY", "synthetic-offline-key")
    monkeypatch.setattr(sft.threading, "Timer", Timer)
    monkeypatch.setattr(sft, "HERE", tmp_path)
    def fetch(model): hit("template"); return "offline-template"
    monkeypatch.setattr(sft, "fetch", fetch)
    monkeypatch.setattr(sft, "special_tokens", lambda model: {})
    monkeypatch.setattr(sft, "end_of_turn", lambda *a, **kw: "END")
    monkeypatch.setattr(sft, "render_prompt", lambda *a, **kw: "PROMPT")
    monkeypatch.setattr(sft, "datum", lambda p, a: (p, a))
    def deactivate(id):
        assert id == "offline-deployment"
        calls.append("deactivate")
        if fault["cleanup"] == "both": raise RuntimeError("deactivate failed")
        return fault["cleanup"] != "deactivate"
    monkeypatch.setattr(sft, "deactivate", deactivate)
    monkeypatch.setattr(sft.os, "_exit", lambda code: (_ for _ in ()).throw(DeadlineExit(code)))
    monkeypatch.setattr(sft.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("asset download"))
    data = tmp_path / "data"; data.mkdir()
    row = {"messages": [{"role": r, "content": r} for r in ["system", "user", "assistant"]]}
    for split in ["train", "validation"]: (data / (split + ".jsonl")).write_text(json.dumps(row) + "\n")
    argv = ["--live", "--allow-dedicated", "--max-seconds", "1000", "--data", str(data),
            "--name", "offline", "--epochs", "1", "--eval-every", "1"]
    return types.SimpleNamespace(calls=calls, fault=fault, argv=argv, timers=timers,
                                 service_client=service_client, original=original, root=tmp_path)


@pytest.mark.parametrize("at", ["tokenizer", "template", "tokenization", "overlength", "validation",
                                "train", "optim", "save-sampler", "save-state", "interrupt", "system-exit"])
def test_every_acquired_client_closes_on_failure(lab, at):
    lab.fault["at"] = at
    expected = KeyboardInterrupt if at == "interrupt" else SystemExit if at in ("overlength", "system-exit") else PrimaryError
    with pytest.raises(expected): sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == 1
    assert lab.calls.count("deactivate") == 1
    assert lab.timers[0].cancelled
    assert lab.service_client.deployment_from_run is lab.original
    if at in ("tokenizer", "template", "tokenization", "overlength", "interrupt", "system-exit"):
        assert "train" not in lab.calls and "validation" not in lab.calls
    assert not (lab.root / "runs/offline/run.json").exists()


def test_acquisition_failure_closes_service_and_deactivates(lab, monkeypatch):
    # The provider discovered a deployment before failing to return a client.
    def fail(run):
        sft.DEDICATED.update(id="offline-deployment")
        raise PrimaryError("acquisition")
    lab.original = fail
    lab.service_client.deployment_from_run = fail
    with pytest.raises(PrimaryError, match="acquisition"): sft.main(lab.argv)
    assert "client-close" not in lab.calls
    assert lab.calls.count("service-close") == lab.calls.count("deactivate") == 1
    assert "train" not in lab.calls


@pytest.mark.parametrize("cleanup", ["client", "service", "deactivate", "both"])
def test_teardown_failures_preserve_primary_and_attempt_other_cleanup(lab, cleanup):
    lab.fault.update(at="train", cleanup=cleanup)
    with pytest.raises(PrimaryError, match="train") as error: sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1
    assert any("cleanup also failed" in note for note in getattr(error.value, "__notes__", ["cleanup also failed"]))


@pytest.mark.parametrize("cleanup", ["client", "service", "deactivate", "both"])
def test_success_with_failed_teardown_is_reported_as_failure(lab, cleanup):
    lab.fault["cleanup"] = cleanup
    with pytest.raises(RuntimeError, match="cleanup failed"): sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1


def test_deadline_attempts_all_cleanup_before_exit(lab):
    lab.fault.update(at="deadline", cleanup="both")
    with pytest.raises(DeadlineExit): sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1
    assert "train" not in lab.calls
    assert lab.service_client.deployment_from_run is lab.original


def test_unapproved_dedicated_is_refused_before_training(lab):
    argv = [x for x in lab.argv if x != "--allow-dedicated"]
    with pytest.raises(SystemExit, match="Refusing training"): sft.main(argv)
    assert "train" not in lab.calls
    assert lab.calls.count("service-close") == lab.calls.count("deactivate") == 1


def test_success_closes_resources_and_cancels_deadline(lab):
    assert sft.main(lab.argv) == 0
    record = json.loads((lab.root / "runs/offline/run.json").read_text())
    assert record["run_id"] == "offline-run" and record["sampler_weights"] == "offline-weights"
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1
    assert lab.timers[0].cancelled
    assert lab.service_client.deployment_from_run is lab.original


def test_invalid_dedicated_setup_acquires_nothing(lab):
    i = lab.argv.index("--max-seconds")
    with pytest.raises(SystemExit): sft.main(lab.argv[:i] + lab.argv[i+2:])
    assert "service" not in lab.calls


def test_broken_cleanup_diagnostic_preserves_primary(lab, monkeypatch):
    lab.fault.update(at="train", cleanup="both")
    original_print = print
    def broken(*args, **kwargs):
        if args and '"event": "cleanup_failed"' in str(args[0]):
            raise BrokenPipeError("diagnostic pipe closed")
        return original_print(*args, **kwargs)
    monkeypatch.setattr(sft, "print", broken, raising=False)
    with pytest.raises(PrimaryError, match="train"):
        sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1


def test_broken_deadline_diagnostic_cannot_skip_teardown_or_exit(lab, monkeypatch):
    lab.fault["at"] = "deadline"
    original_print = print
    def broken(*args, **kwargs):
        if args and '"event": "deadline"' in str(args[0]):
            raise BrokenPipeError("deadline pipe closed")
        return original_print(*args, **kwargs)
    monkeypatch.setattr(sft, "print", broken, raising=False)
    with pytest.raises(DeadlineExit):
        sft.main(lab.argv)
    assert lab.calls.count("client-close") == lab.calls.count("service-close") == lab.calls.count("deactivate") == 1
    assert lab.service_client.deployment_from_run is lab.original
