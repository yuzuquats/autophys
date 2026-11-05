#!/usr/bin/env python3
"""Make a Qwen chat template serve the autophys SDK exactly as it was trained.

``ReasonLanePolicy`` sends ``[{"role": "developer", ...}, {"role": "user", ...}]``
and no ``chat_template_kwargs``. Upstream Qwen templates either reject
``developer`` (Qwen3.6: "Unexpected message role") or do not render it, and
default to thinking on. The patched template:

* renders ``developer`` exactly as ``system``;
* defaults ``enable_thinking`` to false (explicit ``true`` still works).

It then *verifies* that the SDK's message shape renders byte-identically to
the training rendering (``system`` role, thinking off), using the real SDK
prompt from ``data/train.jsonl``, and writes ``serving/<model>.jinja``.
Reads only prepared, hash-identified local model assets.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from render import render_prompt, template_env

HERE = Path(__file__).parent

# (old, new) pairs; each must match at least once in the upstream template.
PATCHES = [
    ("messages[0].role == 'system'", "messages[0].role in ['system', 'developer']"),
    ('message.role == "system"', 'message.role in ["system", "developer"]'),
    ("enable_thinking is defined and enable_thinking is false",
     "not (enable_thinking is defined and enable_thinking is true)"),
]


def fetch(model: str, assets=None) -> str:
    from model_assets import ModelAssets
    return (assets or ModelAssets(model)).template


def patch(text: str) -> str:
    for old, new in PATCHES:
        if old not in text:
            raise SystemExit(f"template pattern not found, refusing to guess: {old!r}")
        text = text.replace(old, new)
    return text


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--model", default="Qwen/Qwen3.6-35B-A3B")
    p.add_argument("--data", type=Path, default=HERE / "data" / "train.jsonl")
    p.add_argument("--model-assets", type=Path, help="prepared model_assets.py directory (no network)")
    a = p.parse_args(argv)
    from model_assets import ModelAssets
    assets = ModelAssets(a.model, a.model_assets)
    upstream = fetch(a.model, assets)
    patched = patch(upstream)
    rows = [json.loads(line) for line in a.data.open()]
    for row in rows:
        system, user = row["messages"][0]["content"], row["messages"][1]["content"]
        trained = render_prompt(upstream, [{"role": "system", "content": system}, {"role": "user", "content": user}],
                                enable_thinking=False, **assets.special)
        served = render_prompt(patched, [{"role": "developer", "content": system}, {"role": "user", "content": user}], **assets.special)
        assert served == trained, "patched template does not reproduce the training prompt"
        assert system.strip() in served and user.strip() in served
    # Unpatched behaviour, for the record.
    try:
        up = render_prompt(upstream, [{"role": "developer", "content": "S"}, {"role": "user", "content": "U"}], **assets.special)
        upstream_note = "renders developer" + ("" if "S" in up else " but DROPS its content")
    except Exception as e:  # noqa: BLE001 - jinja raise_exception
        upstream_note = f"rejects developer: {e}"
    out = HERE / "serving" / (a.model.replace("/", "__") + ".jinja")
    out.parent.mkdir(exist_ok=True)
    out.write_text(patched)
    print(f"{a.model}: upstream template {upstream_note}")
    print(f"verified {len(rows)} SDK prompts render byte-identically to training; wrote {out.relative_to(HERE)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
