# train/sft: distil the scripted autophys policy into a model on Modal or Baseten Loops

**Framing.** No live model runs have been recorded yet, so this first SFT is
*distillation of `ScriptedPolicy`*, the Fisher-ranking expert. At best the
model **matches** the scripted policy. It proves the pipeline and gives a
real endpoint. It does not claim to beat anything unless a held-out
evaluation shows it. RL against the synthetic `Evaluator`, which could beat the
scripted policy, is a later step. The data, `scores.json` and the cassettes here
are built so that step can reuse them.

## What the model sees and must answer

Captured by the SDK's own code (`ReasonLanePolicy.decide`), not copied:

- messages: `[{"role": "developer", "content": system_prompt(playbook)}, {"role": "user", "content": render_facts(facts)}]`
  - The system prompt is `CONTRACT` + the action catalog + `playbooks/default/SKILL.md`, with sha256 `09efc287…1802`.
- `response_format: {"type": "json_schema", "json_schema": {"name": "decision", "schema": DECISION_SCHEMA}}`.
- `max_tokens`: 1800, the default via `autophys bench` and `run_case`. No `reasoning_effort` unless `--effort` is given.
- The reply is the Decision JSON `{hypothesis, evidence[], action, arguments, expected_information}`. It's checked by `Decision.parse`, and three invalid replies in a row end the run as `failed`.

## Files

| file | what |
|---|---|
| `build_dataset.py` | Offline. Runs the real `ReasonLanePolicy` with a `FakeReasoner` that answers with `ScriptedPolicy`'s choice. Every target passes `Decision.parse`, and every trajectory is asserted equal to a plain `ScriptedPolicy` run. Splits by seed. |
| `data/` | Strict split: train seeds 0,1,2 (72 rows), validation 5,6 (48), held-out 3,4 (48, evaluation only). Includes `*.meta.jsonl` and `manifest.json` with per-trajectory Evaluator scores. |
| `data-ext/` | Not committed; regenerate with `--out data-ext --train-seeds 0,1,2,10-59`. Train is 1,272 rows; validation and held-out are as above. |
| `patch_chat_template.py`, `render.py`, `serving/*.jinja` | Serving template that renders `developer` as `system`, with thinking off by default. Verified byte-identical to the training prompt. |
| `train_sft.py` | Loops LoRA SFT (`baseten-loops`). Dry run by default (offline); `--live` trains. Guards dedicated trainers: `--allow-dedicated --max-seconds N` (the CLI passes these), otherwise a dedicated trainer is deactivated before training. |
| `modal_app.py` | Modal backend: `dataset_main` (CPU, one case per container), `train_main` (GPU LoRA SFT plus held-out scoring before and after), `eval_main` (closed-loop benchmark of an adapter, or with `--base-only` the base model, served on localhost in one container). |
| `eval_heldout.py` | Held-out benchmark of reason vs scripted through the Python SDK's `autophys.synthetic.run_case`, with workbooks, `--record` cassette, `scores.json` and `report.json`. |
| `selftest_replay.py` | Offline harness check: replays the teacher's answers as a `--route baseten` cassette. |
| `SDK_BRIEF.md` | SDK issues for the `sdks/python` owner. Nothing in `sdks/` was edited. |
| `partner.env.example` | Partner hand-off template, with no key value. |

## `autophys train` (the CLI drives everything here)

The Rust CLI owns the workflow: dataset identity, budget gates, run manifests,
evaluation and history. These scripts are its worker. All commands take
`--train-dir DIR` (`AUTOPHYS_TRAIN_DIR`) and
`--python FILE` (`AUTOPHYS_TRAIN_PYTHON`, default `python3` on PATH, including an activated venv).
Without `--train-dir`, `autophys` installs the copy of these workers built into it in
`~/.local/share/tento/autophys/train/sft` and works there, with the Python SDK the Modal
images build from in `~/.local/share/tento/autophys/sdks/python`, so a release binary needs no
checkout. Runs, loops and datasets are written beside the workers. A later version replaces
only the files an install wrote and nobody changed since; an edited file is kept and named on
stderr (remove it to get the built-in one back). To work on the workers themselves, pass
`--train-dir train/sft` from a checkout.

| command | what it does |
|---|---|
| `autophys train dataset [--out DIR] [--train-seeds 0,1,2] [--example REF]...` | Builds train/validation/held-out rows. `--backend local` (default) is offline and free. `--backend modal --usd-per-hour X --max-usd Y` builds one case per CPU container and writes byte-identical files (`modal_app.py::dataset_main`). Returns per-split rows and sha256 plus the system-prompt hash. |
| `autophys train run --name N --base-model HF_ID --data DIR --model-assets DIR` | Always plans first: an offline dry run (token counts, schedule) written to `runs/N/manifest.json`. Trains only with `--live`. Any Hugging Face chat model works: the end-of-turn marker is read from the model's own template (`render.end_of_turn`), not hardcoded. |
| `autophys train eval ...` | Held-out closed-loop benchmark, reason vs scripted (`eval_heldout.py`). For a Modal-trained adapter, `modal_app.py::eval_main` serves it on 127.0.0.1 inside one GPU container and runs the benchmark there (see below). |
| `autophys train runs` | Every run manifest, newest first: status, backend, model, rows, budget, held-out scores. |
| `autophys train loop --name L ...` | Keep-if-better SFT loop on Modal (see "`train loop`" below). Plans for free without `--live`. |
| `autophys train loops` | Every loop's state: status, stop reason, incumbent and its score, spend. |

**Backends for `train run`:**

- `--backend modal --gpu L40S --usd-per-hour X --max-usd Y --live`: LoRA SFT on a
  Modal GPU (`modal_app.py::train_main`), same tokenization and answer-only loss as
  Loops. It scores every held-out step greedily before and after training:
  aggregates go in `heldout_decisions` and per step (case, seed, step, target vs
  predicted action, parsed, matches, first 400 characters of the reply) in
  `heldout_rows`. The adapter goes to the `autophys-train` Modal volume at
  `runs/N/adapter`.
- `--backend loops --live`: Baseten Loops via `train_sft.py --live`. The
  organization's settings decide whether Loops gives the run a serverless
  trainer (billed per token) or a dedicated one (billed by GPU time); the
  caller cannot choose (the SDK's `scope` argument only works for
  Baseten-internal organizations and gets HTTP 403 otherwise, so the worker
  never sends it). Pick the gate for what your organization gets:
  - `--usd-per-mtok X --max-usd Y`: serverless. If Loops assigns a dedicated
    trainer anyway, the worker deactivates it before any training and fails.
  - `--usd-per-hour X --max-usd Y`: dedicated. The cap becomes a deadline as
    on Modal; the worker deactivates the trainer
    (`POST /v1/loops/deployments/{id}/deactivate`) at the deadline, after
    training, and on any error. The manifest records `trainer` (deployment
    and run ids) and `wall_seconds`.

**Budget gates.** The CLI never assumes a price. Serverless Loops needs
`--usd-per-mtok` and `--max-usd`, and refuses if tokens x price exceeds the
cap. On Modal and on a dedicated Loops trainer the cap is a deadline:
`max_usd / usd_per_hour`, less 20% for startup and billing lag. Modal enforces
it as a function timeout; for Loops the worker deactivates the trainer. Read
the hourly rate for the trainer Loops assigns (this workspace got `H100:4`,
$26/h) from `GET /v1/instance_type_prices`. A live run with a missing price, cap, GPU or
credentials is refused before anything starts. A run name that is no longer
`planned` cannot be reused.

**Credentials.** Configure your own provider account through its documented
login or a private environment loader on the machine that runs the worker.
The CLI checks the required variable names for presence; it does not load a
workspace `.env` or fetch credentials from another machine. Never put token
values in command arguments or tracked files. Offline dataset/replay work needs
no provider credentials. Live work additionally requires the explicit budget
and `--live` gates above.

`modal_app.py` ships no data, runs, serving templates or `*.env` files into its
images (`IGNORE`).

### Evaluating a Modal adapter (`modal_app.py::eval_main`)

```sh
python -m modal run modal_app.py::eval_main --run NAME --base-model HF_ID \
  --out ABS_DIR --gpu L40S --timeout N --args '{"seeds": "3,4", "case": ["oscillator"]}'
```

It runs in one GPU container (the timeout caps the spend; nothing is exposed):

1. It loads the base model, merges `/vol/runs/NAME/adapter`, and serves an OpenAI
   `chat/completions` endpoint on `127.0.0.1` with a random per-run bearer token.
2. It runs `eval_heldout.py --route baseten --model NAME` with
   `AUTOPHYS_REASON_URL=http://127.0.0.1:<port>/v1`, `BASETEN_API_KEY=<that local token>`
   (not a provider key) and `AUTOPHYS_ALLOW_LIVE_REASON=1`. These are the SDK's
   existing route variables; no SDK change was needed.
3. It returns `report.json`, `scores.json`, `reason.cassette.jsonl` and the
   workbooks, written to `ABS_DIR`, and prints `{"event": "eval_done", ...}`.

Serving reuses the training stack (transformers + PEFT) and renders each
request with `train_sft.Encoder`: the SDK's `developer` message becomes `system`,
so the prompt is the training prompt by construction. Decoding is greedy. The
SDK's `response_format` JSON schema is **not** enforced (no constrained
decoding), so malformed replies count as parse failures. That is the honest
measure of the model on its own.

Checked offline: a stub server built from the same helpers, answering from
`data/heldout.jsonl` keyed on the training prompt's token ids, found **48/48**
SDK requests (seeds 3,4, all four cases) byte-identical to training prompts for
`Qwen/Qwen3.5-4B`, and `eval_heldout.py` completed through it. Expect roughly 6 to 10
GPU-minutes on an L40S for the 48 calls plus load (about $0.20 to $0.35 at $1.95/h).

### `train loop`: keep a new model only if it beats the best so far

```sh
autophys train loop --name LOOP --base-model HF_ID --gpu L40S --usd-per-hour 1.95 --max-usd TOTAL \
  [--iterations 3] [--patience 2] [--candidates FILE] [--eval-seeds 3,4] [--example REF]... [--live] [--resume]
```

Without `--live` it only plans, for free. It validates the flags and
candidates, writes `loops/LOOP/state.json` with status `planned`, and prints
the schedule: each step, its GPU-second estimate, cap and Modal timeout, and
the worst-case cost. With `--live` it runs:

1. **Baseline (iteration 0).** It runs a closed-loop eval of the base model
   with no adapter (`eval_main --base-only`). The base weights go through the
   same server path, so the prompts are byte-identical to an adapter's. This
   result becomes the first incumbent.
2. **Each iteration N** takes the next candidate. It builds its dataset
   locally and for free (the `train dataset` code path) into
   `loops/LOOP/iter-N/data`, with the eval seeds as the held-out split. It
   trains the run `LOOP-iN` (the `train run --backend modal --live` code path,
   with a normal run manifest), then evaluates it (the `train eval --backend
   modal` code path) into `loops/LOOP/iter-N/eval`.
3. **Score**, from the `report.json` rows with policy `reason`, in the MQ-4
   order: passes (more is better), then mean log10 of `max_rel_error` (lower
   is better), then parse failures (fewer is better). A missing or infinite
   error counts as 50, and errors are floored at 1e-5, the report's rounding.
   A candidate is accepted only if it is **strictly** better than the
   incumbent; a tie keeps the incumbent.
4. **Stops** (recorded as `status` and `stop_reason`):
   - `iterations`: the planned iterations are done (at most one per candidate).
   - `patience`: `--patience` rejections in a row.
   - `budget: ...`: the next step no longer fits the remaining budget.
   - `failed: ...`: a step failed. The loop stops and records why; it does
     not go on to the next step.

**Candidates.** `--candidates FILE` is a JSON list:

```json
[{"label": "more-data",
  "dataset": {"train_seeds": "0-2,7-9", "val_seeds": "5,6", "case": ["oscillator"]},
  "hparams": {"epochs": 4, "lr": 0.0002, "rank": 32, "batch_size": 8}}]
```

- `val_seeds` defaults to 5,6. `case` defaults to the loop's `--example` cases (all
  cases if none).
- Allowed `hparams`: `epochs`, `lr`, `rank`, `batch_size`, `max_seq_len`,
  `warmup`, `eval_every` and `seed`. Unknown keys are refused.
- Any candidate whose train or val seeds intersect `--eval-seeds` is refused.
- Without `--candidates`, the loop grows the training data with default
  hyperparameters: 3, then 6, then 12 train seeds (`0-2`, `0-2,7-9`,
  `0-2,7-15`).

**Budget.** There is one total cap, `--max-usd`.

- It is split over the steps in proportion to their GPU-second estimates:
  the base eval is 1,500 s, each adapter eval is 300 s, and train is 300 s plus 32 s per train seed per epoch. These
  numbers come from the L40S smoke runs: training 72 rows took 686 s, and an
  eval took 132 s plus model load.
- Each cap becomes that step's Modal timeout through the same `modal_budget`
  rule, so 20% is left for startup and billing lag.
- The loop is refused before it starts if `--max-usd` cannot buy the estimated
  GPU time, or if any step's timeout would fall under its estimate.
- `spent_usd` charges the measured GPU seconds x rate / 0.8, capped at the
  step's cap. A failed or interrupted step is charged its whole cap.
- Before each step, the remaining budget is split again over the remaining
  steps, so unspent money rolls forward. A step never starts with a cap above
  what remains.

**State.** `loops/LOOP/` holds `state.json` (cursor, incumbent and score,
spend, consecutive rejections, every finished step), `journal.jsonl` (start,
dataset, `step_start`, `step_done` with the decision, `step_failed`, stop),
`baseline/eval*` and `iter-N/{data,eval*}`. Each eval attempt gets a fresh
directory.

**Resume.** `--resume --live` continues a stopped, failed or interrupted loop
from its cursor. The base model, GPU, price, eval seeds, cases and candidates
must match the original run, or the resume is refused. `--iterations`,
`--patience` and `--max-usd` may change, for example to give it more budget.
A step that was in flight when the loop was interrupted is charged its full
cap, and a run that already completed is reused, not retrained. Without
`--live`, `--resume` previews the remaining schedule and writes nothing.

The schedule uses 1,500 GPU-s for the untrained baseline, 300 GPU-s for each adapter evaluation, and 300 + 32 × train seeds × epochs GPU-s for training. These are planning estimates, not guarantees. Inspect the printed schedule and its refusal before authorizing any spend; older $3 smoke examples predate the longer baseline estimate.

Historical loop-smoke-1 and loop-smoke-2 baselines failed; loop-smoke-3 was interrupted with an in-flight baseline. No successful loop qualification is established. The imported score/budget/seed tests are retained; native execution of this integrated revision remains pending. A live loop also requires separately prepared `--model-assets DIR` (or `AUTOPHYS_TRAIN_MODEL_ASSETS`), which fixes tokenizer/model identity across baseline, training, evaluation and resume. No model acquisition is implicit in planning. Repeated evaluation seeds select the incumbent and are therefore selection data, not an untouched final scientific audit.

## Smoke test result (Modal, 2026-11-04)

`autophys train run --backend modal --name smoke-qwen35-4b-2 --base-model Qwen/Qwen3.5-4B --data data --gpu L40S --usd-per-hour 1.95 --max-usd 10 --live`

- 72 training rows, 36 updates. Validation NLL went from 1.31 to 0.0070; about 11.5 minutes in total on one L40S.
- Held-out steps (seeds 3,4), base then trained: parsed 48/48 and 48/48; action match 26/48 and **42/48**; full decision match 16/48 and **42/48**.
- Cost **$0.44**, all from Modal credits (`modal billing summary`: billed $0.00).
- Caveats: 8 of the 48 held-out rows are byte-identical to training rows (step 1, `FIT: none`), so excluding them it is about 34/40. These are one-step decisions on the scripted policy's states, not closed-loop investigations (that is `eval_main`). And it is distillation, so it can at best match scripted.
- An earlier attempt (`smoke-qwen35-4b`) was refused by Modal before any GPU ran ("add a payment method"), at $0.00.

Closed-loop eval of that adapter (`autophys train eval --backend modal --run smoke-qwen35-4b-2 --gpu L40S --usd-per-hour 1.95 --max-usd 2`, held-out seeds 3,4, 132 GPU-seconds, $0.07):

| case | scripted | trained Qwen3.5-4B |
|---|---|---|
| oscillator-free-only, thermal-short-only (correct answer: stop inconclusive) | 4/4 | 4/4 |
| oscillator, thermal (needs an experiment) | 4/4 validated | **0/4**: stops after 4 steps with 0 experiments |

0 parse failures and 0 guardrail overrides. The model learned "fit and stop"
and never chooses `run_experiment`: one-step accuracy (42/48) hides the one
decision that matters. The pipeline measured this correctly; fixing it is a
data problem (more cases, weight the experiment steps).

## Baseten Loops result (2026-11-04)

`autophys train run --backend loops --name loops-qwen38-27b-1 --base-model Qwen/Qwen3.8-27B --data data --usd-per-hour 26 --max-usd 17 --live`

- Loops assigned a dedicated `H100:4` trainer. Deadline 1,883 s; the run took
  545 s wall clock (about 8 minutes of startup, about 1 minute of training)
  and the worker deactivated the trainer at the end. About **$3.94** at $26/h.
- 36 updates. Validation NLL went from 1.116 to 2.7e-6. On data this small and
  this scripted that mostly says the answers are easy to imitate; it is not
  evidence the 27B avoids the 4B's closed-loop failure.
- Weights: `bt://loops:3yd54l3/sampler_weights/loops-qwen38-27b-1-step-36`
  (run `3yd54l3`). Not yet served or evaluated closed-loop.
- Earlier attempts, all at about $0: a key without training permission (403
  on `POST /v1/loops/sessions`); `scope=serverless` (403 on the internal
  `/v1/loops/debug/trainers`); and a dedicated trainer refused by the guard
  and deactivated by hand after about a minute (before the worker learned to).

## Baseten Loops in this workspace (2026-11-04)

- **API key.** Loops training needs a **Team** key with **Manage and call all
  team models** (Organization settings -> API keys). A Personal key and
  "Call certain models" keys get HTTP 403 on `POST /v1/loops/sessions`. Even
  the Team key gets 400 on `/v1/billing/usage_summary`, so check credits in
  the dashboard.
- **Models** (`GET /v1/loops/capabilities`): `Qwen/Qwen3.8-27B`, `Qwen3.5-0.8B`
  to `27B`, `Qwen3.6-27B`, `Qwen3-0.6B` and `gemma-4-26B-A4B` are enabled.
  The old default `Qwen/Qwen3.6-35B-A3B` is **not**.
- **Trainer type.** This organization gets a dedicated trainer, even for
  Qwen3.8-27B, so use the `--usd-per-hour` gate. Baseten's single-GPU H100 is
  $6.50/h (Modal's about $3.95/h), and startup dominates short runs, so small
  experiments are cheaper on Modal.

## Setup in your own Python environment

From the repository root, with Python 3.10 or newer:

```sh
python3 -m venv .venv-train
. .venv-train/bin/activate
python -m pip install ./sdks/python baseten-loops
python -m pip install -r train/sft/requirements-planning.txt
export AUTOPHYS_TRAIN_PYTHON="$VIRTUAL_ENV/bin/python"
# Deliberate public asset acquisition, separate from planning. Choose an
# immutable model commit in MODEL_REVISION; neither a branch nor "main" is accepted.
python train/sft/model_assets.py acquire --model Qwen/Qwen3.6-35B-A3B \
  --revision "$MODEL_REVISION" --output /absolute/path/to/model-assets
export AUTOPHYS_TRAIN_MODEL_ASSETS=/absolute/path/to/model-assets
cd train/sft
python build_dataset.py           # offline, writes data/
python patch_chat_template.py     # writes a serving template
python train_sft.py               # dry run: lengths, schedule, billed tokens
python selftest_replay.py         # harness check, offline
```

Modal is an optional backend and needs its own SDK (`python -m pip install modal`)
and your account configuration. Its SDK source defaults to this checkout's
`sdks/python`; set `AUTOPHYS_SDK_DIR` to an explicit SDK directory when worker
scripts are distributed separately. No sibling repository or operator venv is
required. Put generated datasets, runs and evaluation output in a directory you
own (or use the workers' output flags); they are not contributor test inputs.

The `loops-cookbook` package that Baseten's docs reference is not on PyPI (checked 2026-11-04), so `train_sft.py` uses the `baseten-loops` 0.32.0 SDK directly.

## Verified so far (offline, 2026-11-04, SDK at HEAD `8c8a3e9`)

- Scripted baseline on held-out seeds 3,4: oscillator and thermal validated 2/2. The two "-only" cases are inconclusive 2/2, which is the correct answer for them. Diagnosis correct 8/8.
- Dataset: 100% of targets pass `Decision.parse`. All 228 extended trajectories equal `ScriptedPolicy`. The system-prompt sha is identical between HEAD and the live working tree.
- Held-out overlap: seeds are disjoint, but 8 of 48 held-out rows are byte-identical to training rows. All 8 are step 1 (`FIT: none`), which carries nothing seed-specific.
- Coverage gap: `compare_models` and `inspect_data` never appear in the targets. No synthetic case has a sensor bias, so the model never learns them.
- Templates: Qwen3.6-35B-A3B and Qwen3.5-4B upstream **reject** `developer`, and Qwen3-8B **drops its content**. The patched templates reproduce all 72 training prompts byte-for-byte. Qwen3.8-27B was first dropped as a candidate because its template injects a reasoning-effort preamble. It was later trained anyway, since it is the largest Qwen enabled on Loops here, with that preamble in every training prompt, so serving must use the same template.
- Dry run (Qwen3.6-35B-A3B, strict): 900–1355 tokens per sequence, 5.6% of tokens trained, 36 updates, about 0.58M billed tokens. Extended, at batch 16 and 2 epochs: 160 updates, about 3.76M tokens.
- Harness self-test (replaying the teacher through `--route baseten`): 8/8 pass for reason and scripted, 0 parse failures, 0 guardrail overrides, same actions 8/8. That's a ceiling for a perfect distillation, **not a model result**.

## Not done yet on Loops

Training works (above). Serving and closed-loop evaluation do not, and
`autophys train eval` has no `--backend baseten` yet. These steps run in order
(deployments bill GPU time; get a budget approved first):

1. ~~`train_sft.py --live`~~ (done: `loops-qwen38-27b-1`).
2. `baseten loops checkpoint deploy --dry-run`. This shows the GPU and whether the Truss config can take `serving/<model>.jinja` as its chat template. If it can't, the deployment will reject or mangle the SDK's `developer` message until SDK_BRIEF item 1 lands.
3. Deploy.
4. `AUTOPHYS_ALLOW_LIVE_REASON=1 eval_heldout.py --out results/heldout --model <checkpoint name>`, with the URL and key from the environment.
5. Fill in the partner `.env`.
6. Delete the deployment when the window ends: `DELETE https://api.baseten.co/v1/models/<model_id>`.

## Partner hand-off (fill in after deploy)

```sh
cp partner.env.example partner.env   # fill in the <...> values and your own BASETEN_API_KEY
set -a; . ./partner.env; set +a
autophys bench --policy reason --policy scripted --route baseten --model "$AUTOPHYS_REASON_MODEL" --seeds 5 --record partner.cassette.jsonl
```

Replay offline afterwards with `--replay partner.cassette.jsonl` instead of `--record`. `autophys bench` is the Rust binary: it sends the training prompts' system prompt and facts format, but the numbers come from the Rust solver, so a cassette it records replays in the binary, not in `eval_heldout.py` (and vice versa). `--seeds 5` runs seeds 0–4. Seeds 0–2 are training seeds, so only 3,4 count as held-out.

## Local planning assets and diagnostic delivery

A dry run does not download anything. Supply `--model-assets DIR` to the native
CLI or Python worker, or set `AUTOPHYS_TRAIN_MODEL_ASSETS` to a prepared directory.
The directory contains `tokenizer.json`, `tokenizer_config.json`,
`chat_template.jinja` and a schema-1 `manifest.json` recording the model,
revision and SHA-256 of each file. `model_assets.py acquire` is the separate,
intentional public download command; it requires an immutable 40-hex model
commit and refuses an existing output directory. Local prepared assets may
also identify an original/synthetic model revision. Missing, altered or
wrong-model inputs fail before any remote client is acquired. The planning
requirements file identifies Jinja/tokenizers dependencies; no provider SDK is
required for a dry run.

The plan records full asset identity. The native Loops launch passes its
manifest digest back to the live worker, which rejects changed assets before
remote acquisition and compares the provider tokenizer's numeric IDs with the
local encoder for every training/validation prompt and answer before training.
The same local encoder supplies both planning and training IDs. Public model
weights are not downloaded by planning. Transformer-based remote helpers can
still use an explicitly supplied, already-acquired tokenizer and its own
in-memory template; their cloud execution and plan-to-remote asset binding are
not qualified by the local Loops checks.

Worker diagnostics are best effort: full stderr pipes/terminals may drop output
rather than suspend the deadline, local cleanup or terminal manifest. A broken
sink fails the attempt; final train-error delivery is also nonblocking and can
be omitted when the sink cannot accept it. No writer thread or queue is kept.
The pipe-backpressure guarantee does not bound kernel/filesystem stalls when
stderr is redirected to a regular file. Local worker termination still never
confirms provider cancellation or billing cessation.
