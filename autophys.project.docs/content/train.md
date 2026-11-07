# autophys train turns scripted investigations into a fine-tuned decision policy, on Modal or Baseten Loops

Status: implementation record, rev 1, 2026-11-04. The pipeline holds end to
end. Every stage has run live once. The trained models do not yet beat the
scripted policy closed-loop. Details, commands and results:
`train/sft/README.md`.

## Shape

The Rust CLI owns the workflow (dataset identity, budget gates, run
manifests, evaluation, history) and drives a Python worker in `train/sft`
that tokenizes and trains:

```
src/train.rs              autophys train dataset | run | eval | runs | loop | loops; Flags, budget gates, manifests
train/sft/build_dataset.py   teacher rows: ScriptedPolicy's decisions through the real ReasonLanePolicy
train/sft/train_sft.py       Baseten Loops LoRA SFT (dry run by default)
train/sft/modal_app.py       Modal: dataset fan-out, LoRA SFT, closed-loop eval in one GPU container
train/sft/eval_heldout.py    held-out closed-loop benchmark, reason vs scripted
train/sft/runs/NAME/         manifest.json per run (not committed)
train/sft/loops/LOOP/        train loop state.json, journal.jsonl, per-iteration data and evals (not committed)
```

The training data is a view of the record log: each row is one decision the
expert policy made, rendered exactly as the SDK would prompt a model. Splits
are by seed. The base model is a flag, and the end-of-turn marker comes from
the model's own chat template.

## Gates

- **Price.** The CLI never assumes one. Per-token runs need `--usd-per-mtok`
  and `--max-usd`. GPU-time runs (Modal, and dedicated Loops trainers) need
  `--usd-per-hour` and `--max-usd`, and the cap becomes a deadline: a Modal
  function timeout, or the worker deactivating the Loops trainer.
- **Plan first.** Every `train run` writes an offline plan (token counts,
  schedule, data hashes, git head) before anything is spent. Only `--live`
  spends.
- **Credentials.** The CLI checks presence only. Keys stay on rwc-01 and are
  piped over SSH stdin into the one process on rwc-dev-01.

## Live runs (2026-11-04)

```review-table
| Run | Where | Result | Cost |
| --- | ----- | ------ | ---- |
| smoke-qwen35-4b-2 | Modal, L40S | held-out decisions 16/48 -> 42/48; closed-loop 4/8: passes the stop-early cases, never runs an experiment | $0.44 + $0.07 eval |
| loops-qwen38-27b-1 | Baseten Loops, dedicated H100:4 | 36 updates, validation NLL 1.116 -> 2.7e-6; not yet served or evaluated | about $3.94 |
```

## Open

1. Data, not tooling, is the bottleneck. Add more cases and steps where the
   right move is an experiment, then retrain and evaluate closed-loop.
   Experimental implementation, pending successful qualification: `autophys train loop` automates the
   retrain-and-evaluate cycle. It scores the base model closed-loop, then
   per candidate builds the data locally, trains on Modal, evaluates on the
   held-out seeds, and keeps the new model only if it is strictly better
   (MQ-4 order: passes, then mean log error, then parse failures), under one
   total `--max-usd`. Historical baseline attempts failed or were interrupted; no successful loop qualification is established. Current-source native qualification remains pending.
2. `train eval --backend baseten` (serve Loops weights, then the same
   benchmark) is not built.
3. Datasets built on Modal's x86 machines differ in the last digits of fitted
   values from those built on rwc-dev-01's arm64. Manifests record the data
   hashes, not the build platform.
4. Real-lab data (Onori battery set) needs its license checked and a mapping
   to the `battery-fit` template (`templates/battery-fit`, formerly
   `examples/battery_fit`) before it can become training rows.
