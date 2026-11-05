"""Explicit, hash-identified local tokenizer/template inputs; no implicit download.

Acquisition is a separate command pinned to an immutable Hugging Face revision.
Planning and live Loops workers only read and verify the prepared directory.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.request

FILES = ("tokenizer.json", "tokenizer_config.json", "chat_template.jinja")


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ModelAssets:
    def __init__(self, model, directory=None):
        path = directory or os.environ.get("AUTOPHYS_TRAIN_MODEL_ASSETS")
        if not path:
            raise ValueError("model assets are required: pass --model-assets DIR or set AUTOPHYS_TRAIN_MODEL_ASSETS; prepare separately with model_assets.py acquire --model MODEL --revision COMMIT --output DIR")
        self.path = Path(path).expanduser().resolve()
        try:
            raw = (self.path / "manifest.json").read_bytes()
            data = {name: (self.path / name).read_bytes() for name in FILES}
            self._load(model, raw, data)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError(f"invalid/missing local model assets in {self.path}: {exc}; prepare an identified asset directory before planning or training") from exc

    def _load(self, model, raw, data):
        manifest = json.loads(raw)
        if manifest.get("schema") != 1 or manifest.get("model") != model:
            raise ValueError("asset manifest schema/model does not match --base-model")
        if not isinstance(manifest.get("revision"), str) or not manifest["revision"]:
            raise ValueError("asset manifest needs an identifiable revision")
        if set(manifest.get("files", {})) != set(FILES):
            raise ValueError("asset manifest must identify tokenizer.json, tokenizer_config.json and chat_template.jinja")
        for name, value in data.items():
            if digest(value) != manifest["files"][name]:
                raise ValueError(f"model asset digest mismatch: {name}")
        self._raw, self._data = raw, data
        self.template = data["chat_template.jinja"].decode("utf-8")
        config = json.loads(data["tokenizer_config.json"])
        from render import special_tokens_from_config
        self.special = special_tokens_from_config(config)
        from tokenizers import Tokenizer
        self.tokenizer = Tokenizer.from_str(data["tokenizer.json"].decode("utf-8"))
        self.identity = {"model": model, "revision": manifest["revision"], "manifest_sha256": digest(raw), "files": manifest["files"]}

    def modal_payload(self, expected):
        self.verify_modal_identity(expected)
        return {"manifest": self._raw.decode("utf-8"),
                "files": {name: value.decode("utf-8") for name, value in self._data.items()}}

    def verify_modal_identity(self, expected):
        if self.identity != expected:
            raise ValueError("Modal assets differ from the planned identity; refusing training")
        if not re.fullmatch(r"[0-9a-fA-F]{40}", self.identity["revision"]):
            raise ValueError("Modal requires an immutable 40-hex model revision; prepare assets at a model commit")

    @classmethod
    def from_modal_payload(cls, model, payload, expected):
        # Validate the exact manifest and every prepared file again at the
        # remote boundary. Never interpret a local path on the remote worker.
        if not isinstance(payload, dict) or set(payload) != {"manifest", "files"}:
            raise ValueError("missing/invalid planned Modal asset payload")
        if not isinstance(payload["files"], dict) or set(payload["files"]) != set(FILES):
            raise ValueError("missing/invalid planned Modal asset files")
        obj = cls.__new__(cls)
        obj._load(model, payload["manifest"].encode("utf-8"),
                  {name: value.encode("utf-8") for name, value in payload["files"].items()})
        obj.verify_modal_identity(expected)
        return obj

    def encode(self, text):
        return self.tokenizer.encode(text, add_special_tokens=False).ids


def acquire(model, revision, output):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
        raise ValueError("--revision must be an immutable 40-hex Hugging Face commit, never main or a branch")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", model):
        raise ValueError("--model must be an owner/model Hugging Face identifier")
    data = {}
    for name in FILES[:2]:
        with urllib.request.urlopen(f"https://huggingface.co/{model}/resolve/{revision}/{name}", timeout=120) as response:
            data[name] = response.read()
    # Some models embed the template in the tokenizer config rather than ship
    # a standalone file. Both sources use the same immutable model revision.
    try:
        with urllib.request.urlopen(f"https://huggingface.co/{model}/resolve/{revision}/chat_template.jinja", timeout=60) as response:
            data["chat_template.jinja"] = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code != 404: raise
        template = json.loads(data["tokenizer_config.json"])["chat_template"]
        if not isinstance(template, str): raise ValueError("select a single chat template explicitly")
        data["chat_template.jinja"] = template.encode("utf-8")
    output = Path(output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    for name, value in data.items():
        with (output / name).open("xb") as file: file.write(value)
    manifest = {"schema": 1, "model": model, "revision": revision, "files": {name: digest(data[name]) for name in FILES}}
    with (output / "manifest.json").open("x") as file: file.write(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    get = sub.add_parser("acquire", help="deliberately download public assets at an immutable revision")
    get.add_argument("--model", required=True)
    get.add_argument("--revision", required=True)
    get.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(acquire(args.model, args.revision, args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
