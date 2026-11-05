"""Actual local Jinja/tokenizers planning, without network or provider clients."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import socket
import sys
import urllib.request

import pytest
from tokenizers import Tokenizer, models, pre_tokenizers

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import train_sft as sft
from model_assets import ModelAssets, acquire
from render import render_prompt

MODEL = "synthetic/control-tokenizer"
ANSWER = '{"action":"stop","arguments":{},"hypothesis":"local","evidence":[],"expected_information":"none"}'
TEMPLATE = "{{ bos_token }} {% for m in messages %}<{{ m['role'] }}> {{ m['content'] }} {{ eos_token }} {% endfor %}{% if add_generation_prompt %}<assistant> {% endif %}"


def prepared(tmp_path):
    assets = tmp_path / "model assets"; assets.mkdir()
    vocab = {"<unk>": 0, "S": 1, "U": 2, ANSWER: 3, "7": 4, "<bos>": 5,
             "<system>": 6, "<user>": 7, "<assistant>": 8, "<eot>": 9, "8": 10}
    tok = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tok.add_special_tokens(["<bos>", "<system>", "<user>", "<assistant>", "<eot>"])
    data = {"tokenizer.json": tok.to_str().encode(), "tokenizer_config.json": json.dumps({"bos_token": "<bos>", "eos_token": {"content": "<eot>"}}).encode(), "chat_template.jinja": TEMPLATE.encode()}
    for name, value in data.items(): (assets / name).write_bytes(value)
    manifest = {"schema": 1, "model": MODEL, "revision": "synthetic-wordlevel-v1", "files": {name: hashlib.sha256(value).hexdigest() for name, value in data.items()}}
    (assets / "manifest.json").write_text(json.dumps(manifest, sort_keys=True))
    rows = tmp_path / "data"; rows.mkdir()
    row = {"messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}, {"role": "assistant", "content": ANSWER}]}
    for split in ["train", "validation"]: (rows / (split + ".jsonl")).write_text(json.dumps(row) + "\n")
    return assets, rows


@pytest.fixture(autouse=True)
def outbound_denied(monkeypatch):
    def denied(*a, **kw): raise AssertionError("offline planner attempted outbound network")
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(urllib.request, "urlopen", denied)


def test_real_offline_plan_has_independent_render_ids_costs_and_asset_identity(tmp_path, capsys, monkeypatch):
    assets, data = prepared(tmp_path)
    model = ModelAssets(MODEL, assets)
    prompt = render_prompt(model.template, [{"role": "system", "content": "S"}, {"role": "user", "content": "U"}], enable_thinking=False, **model.special)
    assert prompt == "<bos> <system> S <eot> <user> U <eot> <assistant> "
    enc = sft.Encoder(MODEL, assets=model)
    assert enc.tokens("S", "U", ANSWER) == ([5, 6, 1, 9, 7, 2, 9, 8], [3, 9])
    assert model.encode("7 8") == [4, 10]  # numeric values retain distinct model IDs
    def acquisition(*a): pytest.fail("offline planner acquired a remote client")
    # The normal offline context must never import the provider SDK.
    monkeypatch.setitem(sys.modules, "baseten.loops", None)
    assert sft.main(["--base-model", MODEL, "--model-assets", str(assets), "--data", str(data)]) == 0
    summary, _ = json.JSONDecoder().raw_decode(capsys.readouterr().out)
    assert summary["model_assets"] == model.identity
    assert summary["tokens_per_sequence"] == {"min": 10, "max": 10}
    assert summary["billed_token_estimate"] == {"train_forward_backward": 40, "validation_forward": 20, "total": 60}
    assert summary["end_of_turn"] == " <eot>"


@pytest.mark.parametrize("failure", ["missing", "tampered", "wrong-model", "changed-after-plan"])
def test_bad_or_missing_assets_refuse_before_any_remote_acquisition(tmp_path, monkeypatch, failure):
    assets, data = prepared(tmp_path)
    expected = hashlib.sha256((assets / "manifest.json").read_bytes()).hexdigest()
    model = MODEL
    if failure == "missing": assets = tmp_path / "not prepared"
    if failure == "tampered": (assets / "chat_template.jinja").write_text("changed")
    if failure == "wrong-model": model = "other/model"
    if failure == "changed-after-plan": expected = "0" * 64
    monkeypatch.setenv("BASETEN_API_KEY", "synthetic-never-sent")
    monkeypatch.setattr(sft, "live_client", lambda *a: pytest.fail("remote client acquired before local validation"))
    with pytest.raises((ValueError, SystemExit)):
        sft.main(["--live", "--base-model", model, "--model-assets", str(assets), "--data", str(data), "--expected-assets-sha256", expected])


@pytest.mark.parametrize("mismatch", [False, True])
def test_plan_and_live_use_same_asset_bytes_and_provider_ids_must_agree(tmp_path, monkeypatch, mismatch):
    assets, data = prepared(tmp_path)
    model = ModelAssets(MODEL, assets)
    expected = model.identity["manifest_sha256"]
    events = []
    class Remote:
        def get_tokenizer(self): return self
        def encode(self, text, **kw): return [999] if mismatch else model.encode(text)
    @contextmanager
    def client(*a):
        events.append("acquire")
        try: yield Remote()
        finally: events.append("close")
    def train(args, remote, encoder, tr, va, summary, started):
        assert summary["model_assets"]["manifest_sha256"] == expected
        assert tr == va == [([5, 6, 1, 9, 7, 2, 9, 8], [3, 9])]
        events.append("train")
        return 0
    monkeypatch.setenv("BASETEN_API_KEY", "synthetic-never-sent")
    monkeypatch.setattr(sft, "live_client", client)
    monkeypatch.setattr(sft, "train_live", train)
    argv = ["--live", "--base-model", MODEL, "--model-assets", str(assets), "--data", str(data), "--expected-assets-sha256", expected]
    if mismatch:
        with pytest.raises(ValueError, match="provider tokenizer differs"): sft.main(argv)
        assert events == ["acquire", "close"]
    else:
        assert sft.main(argv) == 0
        assert events == ["acquire", "train", "close"]


def test_acquisition_requires_an_immutable_revision_and_is_not_a_planner_fallback(tmp_path):
    with pytest.raises(ValueError, match="immutable 40-hex"):
        acquire(MODEL, "main", tmp_path / "uncreated")
    assert not (tmp_path / "uncreated").exists()
