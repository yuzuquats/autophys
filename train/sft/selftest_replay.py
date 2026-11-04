#!/usr/bin/env python3
"""Offline self-test of the evaluation path, with no model and no network.

Builds a cassette whose replies are the scripted teacher's held-out answers,
keyed exactly as ``ReplayReasoner`` keys a ``--route baseten`` request (the
SDK's ``request_body`` + ``_cassette_key``). Replaying it through
``eval_heldout.py --policy reason`` must reproduce the scripted runs: a
"perfect distillation" upper bound that checks the harness, not a model.
"""

import json
import sys
import tempfile
from pathlib import Path

from autophys.agent import DECISION_SCHEMA
from autophys.reasoner import _cassette_key, request_body

import eval_heldout

HERE = Path(__file__).parent
MODEL = "selftest"

out = Path(tempfile.mkdtemp(prefix="autophys-sft-selftest-"))
cassette = out / "teacher.cassette.jsonl"
with cassette.open("w") as f:
    for line in (HERE / "data" / "heldout.jsonl").open():
        system, user, answer = json.loads(line)["messages"]
        messages = [{"role": "developer", "content": system["content"]}, {"role": "user", "content": user["content"]}]
        key = _cassette_key(request_body("baseten", MODEL, messages, response_schema=DECISION_SCHEMA))
        f.write(json.dumps({"key": key, "reply": {"content": answer["content"], "model": MODEL, "usage": {},
                                                  "route": "baseten", "elapsed_ms": 0.0}}) + "\n")
sys.exit(eval_heldout.main(["--out", str(out / "eval"), "--model", MODEL, "--replay", str(cassette)]))
