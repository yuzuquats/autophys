"""Modal backend for ``autophys train``: synthetic data (CPU) and LoRA SFT (GPU).

Run it through the CLI, which turns the budget into hard Modal timeouts:

    autophys train dataset --backend modal --usd-per-hour X --max-usd Y ...
    autophys train run --backend modal --gpu L40S --usd-per-hour X --max-usd Y --live ...

``dataset_main`` builds one synthetic case per container in parallel with the
same ``build_dataset.run`` code as the local build, then merges the cases in
the local order, so the files match a local build byte for byte.

``train_main`` trains a LoRA adapter on any Hugging Face causal LM. It uses
``train_sft.Encoder``, so rows are rendered and tokenized exactly as for
Loops: the model's own chat template, loss on the answer and the template's
end-of-turn marker only. Before and after training it decodes every held-out
prompt greedily and scores the decision against the scripted target, so a
smoke test shows whether training changed anything. The adapter is saved
to the ``autophys-train`` volume; ``runs/<name>/run.json`` is written locally.

``eval_main`` runs the full closed-loop benchmark (``eval_heldout.py``,
reason vs scripted) against a trained adapter served on 127.0.0.1 inside one
GPU container, and writes report.json, scores.json, the cassette and the
workbooks locally.

No credentials are read here; the Modal client reads its own token.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
SDK = Path(os.environ.get("AUTOPHYS_SDK_DIR", HERE.parents[1] / "sdks/python"))
# Never ship data, runs or any env file (partner.env can hold a key).
IGNORE = ["data", "data-*", "runs", "results", "__pycache__", "*.env", ".env*", "*.jsonl", "serving"]

app = modal.App("autophys-train")
volume = modal.Volume.from_name("autophys-train", create_if_missing=True)

cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy>=1.24", "scipy>=1.10", "jinja2", "tokenizers")
    .add_local_dir(SDK, "/sdk", copy=True, ignore=["**/__pycache__", "**/.venv"])
    .run_commands("pip install /sdk")
    .add_local_dir(HERE, "/work", ignore=IGNORE)
)
gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy>=1.24", "scipy>=1.10", "jinja2", "tokenizers", "torch", "transformers>=5.22",
                 "peft", "accelerate", "safetensors")
    .env({"HF_HOME": "/vol/hf"})
    .add_local_dir(SDK, "/sdk", copy=True, ignore=["**/__pycache__", "**/.venv"])
    .run_commands("pip install /sdk")
    .add_local_dir(HERE, "/work", ignore=IGNORE)
)


# --------------------------------------------------------------------- dataset

@app.function(image=cpu_image, cpu=2, timeout=600)
def build_case(case: str, splits: list[tuple[str, list[int]]], playbook: str) -> dict:
    sys.path.insert(0, "/work")
    import build_dataset

    out = {"case": case, "splits": {}}
    for split, seeds in splits:
        rows, meta, trajectories = [], [], []
        for seed in seeds:
            r, score = build_dataset.run(case, seed, playbook)
            rows += [x["row"] for x in r]
            meta += [x["meta"] for x in r]
            trajectories.append({"split": split, "case": case, "seed": seed, **score})
        out["splits"][split] = {"rows": rows, "meta": meta, "trajectories": trajectories}
    return out


@app.local_entrypoint()
def dataset_main(out: str, budget_seconds: int, args: str = "{}"):
    sys.path.insert(0, str(HERE))
    from build_dataset import seeds as parse_seeds

    a = json.loads(args)
    train, val, held = (parse_seeds(a.get(k, d)) for k, d in
                        (("train_seeds", "0,1,2"), ("val_seeds", "5,6"), ("heldout_seeds", "3,4")))
    if set(train) & set(held) or set(val) & set(held) or set(train) & set(val):
        raise SystemExit("train, validation and held-out seeds must be disjoint")
    playbook = a.get("playbook", "default")
    cases = a.get("case") or build_case_names()
    splits = [("train", train), ("validation", val), ("heldout", held)]
    per_container = max(60, budget_seconds // len(cases))
    print(json.dumps({"event": "dataset_start", "cases": cases, "containers": len(cases),
                      "timeout_s_per_container": per_container}), flush=True)
    fn = build_case.with_options(timeout=per_container)
    results = {r["case"]: r for r in fn.starmap([(c, splits, playbook) for c in cases])}
    write_merged(results, cases, splits, playbook, Path(out))


def write_merged(results: dict, cases: list[str], splits: list, playbook: str, dest: Path) -> None:
    """Write per-case results exactly as ``build_dataset.main`` would."""
    import hashlib
    from collections import Counter

    from autophys.agent import system_prompt
    system = system_prompt(playbook)
    manifest = {"system_prompt_sha256": hashlib.sha256(system.encode()).hexdigest(), "playbook": playbook,
                "cases": cases, "splits": {}, "trajectories": []}
    dest.mkdir(parents=True, exist_ok=True)
    for split, split_seeds in splits:
        rows, meta, actions = [], [], Counter()
        for case in cases:  # same order as the local build: split, case, seed
            part = results[case]["splits"][split]
            rows += part["rows"]
            meta += part["meta"]
            manifest["trajectories"] += part["trajectories"]
        for m in meta:
            actions[m["action"]] += 1
        with open(dest / f"{split}.jsonl", "w") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        with open(dest / f"{split}.meta.jsonl", "w") as f:
            f.writelines(json.dumps(m) + "\n" for m in meta)
        prompts = {json.dumps(r["messages"][:2]) for r in rows}
        manifest["splits"][split] = {"seeds": split_seeds, "rows": len(rows), "distinct_prompts": len(prompts),
                                     "actions": dict(sorted(actions.items()))}
        print(f"{split:10s} seeds={','.join(map(str, split_seeds))} rows={len(rows)} "
              f"distinct_prompts={len(prompts)} actions={dict(sorted(actions.items()))}", flush=True)
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"system_prompt_sha256={manifest['system_prompt_sha256']}", flush=True)


def build_case_names() -> list[str]:
    from autophys.synthetic import CASES
    return list(CASES)


# -------------------------------------------------------------------- training

def _score(pred_text: str, target_text: str, parse, meta: dict | None = None) -> dict:
    """One held-out step: the model's decision against the scripted target."""
    target = json.loads(target_text)
    try:
        pred = parse(pred_text)
    except Exception:
        pred = None
    ok = isinstance(pred, dict)
    meta = meta or {}
    return {"case": meta.get("case"), "seed": meta.get("seed"), "step": meta.get("step"),
            "target_action": target.get("action"),
            "predicted_action": pred.get("action") if ok else None,
            "parsed": ok,
            "action_match": ok and pred.get("action") == target["action"],
            "decision_match": ok and pred.get("action") == target["action"]
            and pred.get("arguments") == target.get("arguments"),
            "predicted_text": pred_text[:400]}


def _summary(scores: list[dict]) -> dict:
    n = len(scores)
    return {k: f"{sum(bool(s[k]) for s in scores)}/{n}" for k in ("parsed", "action_match", "decision_match")}


@app.function(image=gpu_image, gpu="L40S", timeout=600, volumes={"/vol": volume})
def train_lora(cfg: dict, train_rows: list, val_rows: list, held_rows: list, held_meta: list | None = None) -> dict:
    import math
    import random

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, "/work")
    from autophys.reasoner import parse_json_content
    from train_sft import Encoder, lr_at

    def emit(**entry):
        print(json.dumps(entry), flush=True)

    started = time.time()
    name, base = cfg["name"], cfg["base_model"]
    torch.manual_seed(cfg["seed"])
    tok = AutoTokenizer.from_pretrained(base)
    enc = Encoder(base, tok)
    tr = [enc.tokens(*r) for r in train_rows]
    va = [enc.tokens(*r) for r in val_rows]
    ho = [enc.tokens(*r) for r in held_rows]
    longest = max(len(p) + len(a) for p, a in tr + va)
    if longest > cfg["max_seq_len"]:
        raise SystemExit(f"longest sequence {longest} exceeds max_seq_len {cfg['max_seq_len']}")

    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, device_map="cuda")
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=cfg["rank"], lora_alpha=cfg["rank"], lora_dropout=0.0,
                                             target_modules="all-linear", task_type="CAUSAL_LM"))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    emit(event="loaded", base_model=base, end_of_turn=enc.end_of_turn, trainable_params=trainable,
         rows={"train": len(tr), "validation": len(va), "heldout": len(ho)}, t=round(time.time() - started, 1))

    def seq_loss(p, a):
        ids = torch.tensor([p + a], device="cuda")
        logits = model(input_ids=ids).logits[0, len(p) - 1:-1].float()
        return torch.nn.functional.cross_entropy(logits, torch.tensor(a, device="cuda"), reduction="sum")

    @torch.no_grad()
    def nll(rows):
        model.eval()
        total = sum(seq_loss(p, a).item() for p, a in rows)
        model.train()
        return total / sum(len(a) for _, a in rows)

    eot_ids = [i for i in (tok.convert_tokens_to_ids(enc.end_of_turn), tok.eos_token_id)
               if isinstance(i, int) and i >= 0 and i != tok.unk_token_id]
    pad = tok.pad_token_id if tok.pad_token_id is not None else eot_ids[0]

    @torch.no_grad()
    def decide_all(label):
        model.eval()
        scores = []
        for i in range(0, len(ho), 8):
            chunk = ho[i:i + 8]
            width = max(len(p) for p, _ in chunk)
            ids = torch.tensor([[pad] * (width - len(p)) + p for p, _ in chunk], device="cuda")
            mask = torch.tensor([[0] * (width - len(p)) + [1] * len(p) for p, _ in chunk], device="cuda")
            out = model.generate(input_ids=ids, attention_mask=mask, max_new_tokens=384, do_sample=False,
                                 eos_token_id=eot_ids, pad_token_id=pad)
            for row in range(len(chunk)):
                text = tok.decode(out[row, width:], skip_special_tokens=True).strip()
                meta = held_meta[i + row] if held_meta and i + row < len(held_meta) else None
                scores.append(_score(text, held_rows[i + row][2], parse_json_content, meta))
        model.train()
        result = _summary(scores)
        emit(event="heldout_decisions", model=label, **result, t=round(time.time() - started, 1))
        return result, scores

    with model.disable_adapter():
        before, before_rows = decide_all("base")

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=cfg["lr"], weight_decay=0.0)
    steps_per_epoch = math.ceil(len(tr) / cfg["batch_size"])
    total = steps_per_epoch * cfg["epochs"]
    log = [{"step": 0, "val_nll": nll(va)}]
    emit(**log[-1])
    rng, step = random.Random(cfg["seed"]), 0
    model.train()
    for epoch in range(cfg["epochs"]):
        order = list(range(len(tr)))
        rng.shuffle(order)
        for i in range(0, len(order), cfg["batch_size"]):
            batch = [tr[j] for j in order[i:i + cfg["batch_size"]]]
            tokens = sum(len(a) for _, a in batch)
            opt.zero_grad(set_to_none=True)
            loss_sum = 0.0
            for p, a in batch:
                loss = seq_loss(p, a) / tokens
                loss.backward()
                loss_sum += loss.item()
            lr = lr_at(step, total, cfg["lr"], cfg["warmup"])
            for group in opt.param_groups:
                group["lr"] = lr
            opt.step()
            step += 1
            entry = {"step": step, "epoch": epoch, "train_loss": loss_sum, "lr": lr, "t": round(time.time() - started, 1)}
            if step % cfg["eval_every"] == 0 or step == total:
                entry["val_nll"] = nll(va)
            log.append(entry)
            emit(**entry)

    after, after_rows = decide_all("trained")
    adapter = f"/vol/runs/{name}/adapter"
    model.save_pretrained(adapter)
    record = {"run_id": f"modal:{name}", "sampler_weights": f"modal-volume://autophys-train/runs/{name}/adapter",
              "state": None, "config": cfg, "end_of_turn": enc.end_of_turn, "trainable_params": trainable,
              "heldout_decisions": {"base": before, "trained": after},
              "heldout_rows": {"base": before_rows, "trained": after_rows}, "log": log,
              "gpu_seconds": round(time.time() - started, 1)}
    Path(f"/vol/runs/{name}/run.json").write_text(json.dumps(record, indent=1) + "\n")
    volume.commit()
    return record


@app.local_entrypoint()
def train_main(name: str, base_model: str, data: str, gpu: str, timeout: int, hparams: str = "{}"):
    sys.path.insert(0, str(HERE))
    from train_sft import load

    d = Path(data)
    cfg = {"name": name, "base_model": base_model, "rank": 32, "max_seq_len": 2048, "lr": 2e-4, "warmup": 5,
           "batch_size": 8, "epochs": 4, "eval_every": 10, "seed": 0}
    cfg.update(json.loads(hparams))
    held, held_meta = d / "heldout.jsonl", d / "heldout.meta.jsonl"
    meta = [json.loads(line) for line in held_meta.open()] if held_meta.exists() else None
    rows = load(held) if held.exists() else []
    if meta is not None and len(meta) != len(rows):
        raise SystemExit(f"{held_meta} has {len(meta)} rows but {held} has {len(rows)}")
    fn = train_lora.with_options(gpu=gpu, timeout=timeout)
    record = fn.remote(cfg, load(d / "train.jsonl"), load(d / "validation.jsonl"), rows, meta)
    record["gpu"] = gpu
    run_dir = HERE / "runs" / name
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(record, indent=1) + "\n")
    print(f"run_id={record['run_id']} adapter={record['sampler_weights']}", flush=True)


# ------------------------------------------------------------------ evaluation
#
# The full closed-loop benchmark (eval_heldout.py: reason vs scripted) for a
# trained adapter, in ONE GPU container: the model is served on 127.0.0.1 only,
# so nothing is exposed and the function timeout caps the spend.
#
# Serving uses the same stack as training (transformers + PEFT) and renders each
# request with ``train_sft.Encoder``: the SDK's ``developer`` message becomes
# ``system`` and the prompt is byte-identical to the training rendering by
# construction (no separate serving template to keep in sync). Decoding is
# greedy. The SDK's ``response_format`` JSON schema is NOT enforced (no
# constrained decoding); a malformed reply is counted by the loop as a parse
# failure, which is the honest measure of the trained model on its own.

def chat_rows(messages: list[dict]) -> tuple[str, str]:
    """(system, user) from the SDK's request, as training saw them."""
    roles = [m.get("role") for m in messages]
    if roles not in (["developer", "user"], ["system", "user"]):
        raise ValueError(f"expected [developer|system, user] messages, got {roles}")
    if not all(isinstance(m.get("content"), str) for m in messages):
        raise ValueError("message content must be text")
    return messages[0]["content"], messages[1]["content"]


def completion_body(model: str, text: str, finish: str, prompt_tokens: int, completion_tokens: int) -> dict:
    """An OpenAI chat.completion response, the shape the SDK's ChatReasoner reads."""
    return {"id": f"chatcmpl-local-{int(time.time() * 1000)}", "object": "chat.completion", "created": int(time.time()),
            "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                         "finish_reason": finish}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                      "total_tokens": prompt_tokens + completion_tokens}}


def eval_argv(out: str, model: str, seeds: str, cases: list[str]) -> list[str]:
    """The eval_heldout.py command line run inside the container."""
    argv = ["/work/eval_heldout.py", "--out", out, "--route", "baseten", "--model", model, "--seeds", seeds]
    for case in cases:
        argv += ["--case", case]
    return argv


@app.function(image=gpu_image, gpu="L40S", timeout=600, volumes={"/vol": volume})
def eval_adapter(run: str, base: str, seeds: str, cases: list[str]) -> dict:
    import secrets
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, "/work")
    from train_sft import Encoder

    def emit(**entry):
        print(json.dumps(entry), flush=True)

    started = time.time()
    adapter = Path(f"/vol/runs/{run}/adapter")
    if not adapter.is_dir():
        raise SystemExit(f"no adapter at {adapter}; train it first (autophys train run --backend modal)")
    tok = AutoTokenizer.from_pretrained(base)
    enc = Encoder(base, tok)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.bfloat16, device_map="cuda")
    model = PeftModel.from_pretrained(model, str(adapter)).merge_and_unload()
    model.eval()
    eot_ids = [i for i in (tok.convert_tokens_to_ids(enc.end_of_turn), tok.eos_token_id)
               if isinstance(i, int) and i >= 0 and i != tok.unk_token_id]
    pad = tok.pad_token_id if tok.pad_token_id is not None else eot_ids[0]
    emit(event="eval_loaded", run=run, base_model=base, t=round(time.time() - started, 1))

    token = secrets.token_urlsafe(24)  # local only; never a provider key
    lock = threading.Lock()
    calls = {"n": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body: dict):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/chat/completions":
                return self._send(404, {"error": "not_found"})
            if self.headers.get("Authorization") != f"Bearer {token}":
                return self._send(401, {"error": "unauthorized"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                system, user = chat_rows(req["messages"])
                prompt, _ = enc.tokens(system, user, "")
                limit = int(req.get("max_tokens") or 1800)
            except (ValueError, KeyError, TypeError) as e:
                return self._send(400, {"error": "bad_request", "message": str(e)[:200]})
            with lock, torch.no_grad():
                ids = torch.tensor([prompt], device="cuda")
                out = model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=limit,
                                     do_sample=False, eos_token_id=eot_ids, pad_token_id=pad)
                new = out[0, len(prompt):].tolist()
                calls["n"] += 1
            finish = "stop" if new and new[-1] in eot_ids else "length"
            text = tok.decode(new, skip_special_tokens=True).strip()
            self._send(200, completion_body(req.get("model") or run, text, finish, len(prompt), len(new)))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/v1"

    out = Path("/tmp/eval/out")
    env = {**os.environ, "AUTOPHYS_ALLOW_LIVE_REASON": "1", "AUTOPHYS_REASON_URL": url,
           "BASETEN_API_KEY": token, "PYTHONUNBUFFERED": "1"}
    for key in ("AUTOPHYS_REASON_REPLAY", "AUTOPHYS_REASON_RECORD"):
        env.pop(key, None)
    proc = subprocess.run([sys.executable, *eval_argv(str(out), run, seeds, cases)], cwd="/work", env=env)
    server.shutdown()
    if proc.returncode != 0:
        raise SystemExit(f"eval_heldout.py exited with {proc.returncode}")
    files = {p.name: p.read_bytes() for p in out.iterdir() if p.is_file()}
    emit(event="eval_served", calls=calls["n"], files=sorted(files), gpu_seconds=round(time.time() - started, 1))
    return {"files": files, "calls": calls["n"], "gpu_seconds": round(time.time() - started, 1)}


@app.local_entrypoint()
def eval_main(run: str, base_model: str, out: str, gpu: str, timeout: int, args: str = "{}"):
    a = json.loads(args)
    seeds = a.get("seeds", "3,4")
    if isinstance(seeds, list):
        seeds = ",".join(map(str, seeds))
    cases = a.get("case") or []
    if isinstance(cases, str):
        cases = [cases]
    dest = Path(out)
    if dest.exists() and any(dest.iterdir()):
        raise SystemExit(f"{dest} is not empty; pick a new --out")
    fn = eval_adapter.with_options(gpu=gpu, timeout=timeout)
    result = fn.remote(run, base_model, seeds, cases)
    dest.mkdir(parents=True, exist_ok=True)
    for name, data in result["files"].items():
        (dest / name).write_bytes(data)
    print(json.dumps({"event": "eval_done", "out": str(dest), "run": run, "calls": result["calls"],
                      "gpu_seconds": result["gpu_seconds"], "gpu": gpu}), flush=True)
