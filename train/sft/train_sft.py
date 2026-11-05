#!/usr/bin/env python3
"""LoRA SFT of an autophys decision policy on Baseten Loops.

``--dry-run`` (the default) is offline: it renders every row with the base
model's own chat template and tokenizer (both public, from Hugging Face),
checks lengths, and prints the trained-token share, the schedule and the
token totals the cost estimate is based on. It never contacts Baseten.

A live run needs ``BASETEN_API_KEY`` in the environment and the explicit
``--live`` flag. It trains a LoRA adapter with cross-entropy on the
assistant (Decision JSON) tokens only, reports validation NLL, saves sampler
weights and resumable state, writes ``runs/<name>/run.json``, closes acquired clients and attempts to
deactivate any assigned dedicated trainer on every exit.

Training rendering = upstream template, ``system`` role, ``enable_thinking``
false, then the target JSON and the template's own end-of-turn marker
(``<|im_end|>`` for Qwen; see ``render.end_of_turn``). ``patch_chat_template.py``
proves the serving template renders the SDK's ``developer`` request to the
same prompt.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import threading
import json
import math
import os
import random
import sys
import time
import urllib.request
from pathlib import Path

from patch_chat_template import fetch
from render import end_of_turn, render_prompt, special_tokens

HERE = Path(__file__).parent


def load(path: Path) -> list[tuple[str, str]]:
    """(system, user, answer) text per row."""
    pairs = []
    for line in path.open():
        m = json.loads(line)["messages"]
        assert [x["role"] for x in m] == ["system", "user", "assistant"]
        pairs.append((m[0]["content"], m[1]["content"], m[2]["content"]))
    return pairs


class Encoder:
    def __init__(self, model: str, tokenizer=None):
        self.template = fetch(model)
        self.special = special_tokens(model)
        self.end_of_turn = end_of_turn(self.template, **self.special)
        if tokenizer is None:  # offline: public tokenizer.json only
            from tokenizers import Tokenizer
            with urllib.request.urlopen(f"https://huggingface.co/{model}/resolve/main/tokenizer.json", timeout=120) as r:
                tok = Tokenizer.from_str(r.read().decode())
            self.encode = lambda s: tok.encode(s, add_special_tokens=False).ids
        else:
            self.encode = lambda s: tokenizer.encode(s, add_special_tokens=False)

    def tokens(self, system: str, user: str, answer: str) -> tuple[list[int], list[int]]:
        prompt = render_prompt(self.template, [{"role": "system", "content": system}, {"role": "user", "content": user}],
                               enable_thinking=False, **self.special)
        return self.encode(prompt), self.encode(answer + self.end_of_turn)


def datum(p: list[int], a: list[int]):
    from baseten.loops import Datum, ModelInput, TensorData
    full = p + a
    # Loops does not shift labels: position i predicts full[i + 1].
    targets = full[1:]
    weights = [0.0] * (len(p) - 1) + [1.0] * len(a)
    return Datum(model_input=ModelInput.from_ints(full[:-1]),
                 loss_fn_inputs={"target_tokens": TensorData(data=targets, dtype="int64", shape=[len(targets)]),
                                 "weights": TensorData(data=weights, dtype="float32", shape=[len(weights)])})


DEDICATED: dict = {}


def deactivate(deployment_id: str) -> bool:
    """Stop a dedicated Loops trainer so it stops billing GPU time."""
    import httpx
    url = f"https://api.baseten.co/v1/loops/deployments/{deployment_id}/deactivate"
    headers = {"Authorization": f"Api-Key {os.environ['BASETEN_API_KEY']}"}
    for _ in range(3):
        try:
            if httpx.post(url, headers=headers, timeout=60).status_code == 200:
                print(json.dumps({"event": "deactivated", "deployment": deployment_id}), flush=True)
                return True
        except httpx.HTTPError:
            pass
        time.sleep(5)
    print(json.dumps({"event": "deactivate_failed", "deployment": deployment_id}), flush=True)
    return False


def guard_dedicated(allow: bool, max_seconds: float | None, on_deadline):
    """A dedicated trainer bills GPU time, which the per-token budget does not
    cover. Without ``allow`` the run stops (and the trainer is deactivated) as
    soon as Loops reports one. With it, the trainer is deactivated at
    ``max_seconds`` after start, and the process exits."""
    from baseten.loops import service_client
    from baseten.loops.trainer_deployment import DedicatedTrainerDeployment
    original = service_client.deployment_from_run

    def checked(run):
        deployment = original(run)
        if isinstance(deployment, DedicatedTrainerDeployment):
            DEDICATED.update(id=deployment.deployment_id, run=run.get("id"), instance=(run.get("instance_type") or {}).get("id"))
            print(json.dumps({"event": "dedicated_trainer", **DEDICATED}), flush=True)
            if not allow:
                raise SystemExit(f"Loops assigned a dedicated trainer (deployment {deployment.deployment_id}); it bills GPU "
                                 "time, which the per-token budget does not cover. Refusing training and attempting deactivation; "
                                 "a dedicated run needs --usd-per-hour and --max-usd.")
        return deployment

    service_client.deployment_from_run = checked
    timer = None
    if max_seconds:

        def deadline():
            try:
                try:
                    print(json.dumps({"event": "deadline", "after_s": max_seconds}), flush=True)
                finally:
                    on_deadline()
            finally:
                os._exit(3)

        timer = threading.Timer(max_seconds, deadline)
        timer.daemon = True
        timer.start()

    def restore():
        if timer is not None:
            timer.cancel()
        if service_client.deployment_from_run is checked:
            service_client.deployment_from_run = original
    return restore


@contextmanager
def live_client(a):
    """Own every acquired client, including failures before training starts.

    Cleanup attempts are independent. A teardown failure is attached to an
    existing BaseException (including SystemExit/KeyboardInterrupt); on success
    it becomes an error rather than claiming a fully cleaned-up run.
    """
    if not a.live:
        yield None
        return
    DEDICATED.clear()
    clients, errors = [], []
    restore = None
    cleaned = False
    lock = threading.RLock()

    def cleanup():
        nonlocal cleaned
        with lock:
            if cleaned:
                return
            cleaned = True
            if restore is not None:
                try:
                    restore()
                except BaseException as exc:
                    errors.append(exc)
            if "id" in DEDICATED:
                try:
                    if not deactivate(DEDICATED["id"]):
                        raise RuntimeError("dedicated trainer deactivation was not confirmed")
                except BaseException as exc:
                    errors.append(exc)
            for client in reversed(clients):
                try:
                    close = getattr(client, "close", None)
                    if close is not None:
                        close()
                except BaseException as exc:
                    errors.append(exc)
            for exc in errors:
                try:
                    print(json.dumps({"event": "cleanup_failed", "error_type": type(exc).__name__}),
                          file=sys.stderr, flush=True)
                except BaseException:
                    # A broken diagnostic pipe must not replace the primary
                    # error or stop another resource's cleanup.
                    pass

    primary = None
    try:
        from baseten.loops import ServiceClient
        restore = guard_dedicated(a.allow_dedicated, a.max_seconds, cleanup)
        service = ServiceClient()
        clients.append(service)
        client = service.create_lora_training_client(
            base_model=a.base_model, rank=a.rank, max_seq_len=a.max_seq_len, scope=a.scope or None,
            seed=a.seed, name=a.name)
        clients.append(client)
        yield client
    except BaseException as exc:
        primary = exc
        raise
    finally:
        cleanup()
        if errors:
            if primary is not None:
                if hasattr(primary, "add_note"):
                    primary.add_note("Training cleanup also failed; see cleanup_failed events. Remote teardown is unconfirmed.")
            else:
                raise RuntimeError("training cleanup failed; remote teardown is unconfirmed") from errors[0]


def lr_at(step: int, total: int, base: float, warmup: int) -> float:
    if step < warmup:
        return base * (step + 1) / warmup
    progress = (step - warmup) / max(1, total - warmup)
    return base * 0.5 * (1 + math.cos(math.pi * progress))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--base-model", default="Qwen/Qwen3.6-35B-A3B")
    p.add_argument("--data", type=Path, default=HERE / "data")
    p.add_argument("--rank", type=int, default=32)
    p.add_argument("--max-seq-len", type=int, default=2048)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--warmup", type=int, default=5)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--eval-every", type=int, default=10)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--scope", default=None,
                   help="Loops scope (Baseten-internal organizations only); omitted, the organization's default applies")
    p.add_argument("--allow-dedicated", action="store_true",
                   help="accept a dedicated trainer (billed by GPU time); without it the run stops before training")
    p.add_argument("--max-seconds", type=float, default=None,
                   help="wall-clock cap: deactivate a dedicated trainer and exit after this many seconds")
    p.add_argument("--name", default="autophys-sft")
    p.add_argument("--live", action="store_true", help="actually train on Baseten (spends money)")
    a = p.parse_args(argv)
    train, val = load(a.data / "train.jsonl"), load(a.data / "validation.jsonl")
    overlap = None
    if (a.data / "heldout.jsonl").exists():
        # Seeds are disjoint (build_dataset.py enforces it), but states that carry
        # no seed-specific numbers (e.g. "FIT: none" at step 1) repeat across seeds.
        held = load(a.data / "heldout.jsonl")
        seen = {json.dumps(x) for x in train + val}
        overlap = {"heldout_rows": len(held), "identical_to_a_training_row": sum(json.dumps(x) in seen for x in held)}

    if a.live:
        if not os.environ.get("BASETEN_API_KEY"):
            p.error("--live needs BASETEN_API_KEY in the environment")
        if a.allow_dedicated and not a.max_seconds:
            p.error("--allow-dedicated needs --max-seconds")
    if a.max_seconds is not None and (not math.isfinite(a.max_seconds) or a.max_seconds <= 0):
        p.error("--max-seconds must be finite and above zero")
    started = time.time()
    with live_client(a) as client:
        tokenizer = client.get_tokenizer() if client is not None else None
        enc = Encoder(a.base_model, tokenizer)
        tr = [enc.tokens(*x) for x in train]
        va = [enc.tokens(*x) for x in val]
        lengths = [len(p_) + len(a_) for p_, a_ in tr + va]
        if max(lengths) > a.max_seq_len:
            p.error(f"longest sequence {max(lengths)} exceeds --max-seq-len {a.max_seq_len}")
        steps_per_epoch = math.ceil(len(tr) / a.batch_size)
        total = steps_per_epoch * a.epochs
        seq_tokens = sum(len(p_) + len(a_) for p_, a_ in tr)
        trained = sum(len(a_) for _, a_ in tr)
        val_tokens = sum(len(p_) + len(a_) for p_, a_ in va)
        evals = total // a.eval_every + 2
        summary = {
            "base_model": a.base_model, "end_of_turn": enc.end_of_turn, "rows": {"train": len(tr), "validation": len(va)},
            "tokens_per_sequence": {"min": min(lengths), "max": max(lengths)},
            "trained_token_share": round(trained / seq_tokens, 4),
            "heldout_overlap": overlap,
            "schedule": {"updates": total, "per_epoch": steps_per_epoch, "epochs": a.epochs, "batch_size": a.batch_size,
                         "lr": a.lr, "warmup": a.warmup, "lr_schedule": "cosine", "rank": a.rank},
            "billed_token_estimate": {"train_forward_backward": seq_tokens * a.epochs,
                                      "validation_forward": val_tokens * evals,
                                      "total": seq_tokens * a.epochs + val_tokens * evals},
        }
        print(json.dumps(summary, indent=1))
        if not a.live:
            print("dry run: nothing sent to Baseten")
            return 0
        return train_live(a, client, enc, tr, va, summary, started)


def train_live(a, client, enc, tr, va, summary, started):
    from baseten.loops import AdamParams
    total = summary["schedule"]["updates"]
    run_dir = HERE / "runs" / a.name
    run_dir.mkdir(parents=True, exist_ok=True)
    train_data = [datum(*x) for x in tr]
    val_data = [datum(*x) for x in va]
    log = []

    def val_nll():
        return client.forward(val_data, "cross_entropy").result(timeout=1800).loss

    log.append({"step": 0, "val_nll": val_nll()})
    print(json.dumps(log[-1]), flush=True)
    rng, step = random.Random(a.seed), 0
    for epoch in range(a.epochs):
        order = list(range(len(train_data)))
        rng.shuffle(order)
        for i in range(0, len(order), a.batch_size):
            batch = [train_data[j] for j in order[i:i + a.batch_size]]
            fb = client.forward_backward(batch, "cross_entropy").result(timeout=1800)
            lr = lr_at(step, total, a.lr, a.warmup)
            client.optim_step(AdamParams(learning_rate=lr)).result(timeout=1800)
            step += 1
            entry = {"step": step, "epoch": epoch, "train_loss": fb.loss, "lr": lr, "t": time.time()}
            if step % a.eval_every == 0 or step == total:
                entry["val_nll"] = val_nll()
            log.append(entry)
            print(json.dumps(entry), flush=True)
    sampler = client.save_weights_for_sampler(name=f"{a.name}-step-{step}").result(timeout=1800)
    state = client.save_state(name=f"{a.name}-state-{step}").result(timeout=1800)
    record = {"run_id": client.run_id, "sampler_weights": sampler.path, "state": state.path, "args": vars(a) | {"data": str(a.data)},
              "summary": summary, "log": log,
              "trainer": DEDICATED or {"kind": "serverless"}, "wall_seconds": round(time.time() - started, 1)}
    (run_dir / "run.json").write_text(json.dumps(record, indent=1, default=str) + "\n")
    print(f"run_id={client.run_id} sampler_weights={sampler.path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
