# train/sft: distil the scripted autophys policy into a model on Baseten Loops

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
- `max_tokens`: 1800, the default via `autophys bench`. No `reasoning_effort` unless `--effort` is given.
- The reply is the Decision JSON `{hypothesis, evidence[], action, arguments, expected_information}`. It's checked by `Decision.parse`, and three invalid replies in a row end the run as `failed`.

## Files

| file | what |
|---|---|
| `build_dataset.py` | Offline. Runs the real `ReasonLanePolicy` with a `FakeReasoner` that answers with `ScriptedPolicy`'s choice. Every target passes `Decision.parse`, and every trajectory is asserted equal to a plain `ScriptedPolicy` run. Splits by seed. |
| `data/` | Strict split: train seeds 0,1,2 (72 rows), validation 5,6 (48), held-out 3,4 (48, evaluation only). Includes `*.meta.jsonl` and `manifest.json` with per-trajectory Evaluator scores. |
| `data-ext/` | Not committed; regenerate with `--out data-ext --train-seeds 0,1,2,10-59`. Train is 1,272 rows; validation and held-out are as above. |
| `patch_chat_template.py`, `render.py`, `serving/*.jinja` | Serving template that renders `developer` as `system`, with thinking off by default. Verified byte-identical to the training prompt. |
| `train_sft.py` | Loops LoRA SFT (`baseten-loops`). Dry run by default (offline); `--live` trains. |
| `modal_app.py` | Modal backend: `dataset_main` (CPU, one case per container), `train_main` (GPU LoRA SFT plus held-out scoring before and after), `eval_main` (closed-loop benchmark of an adapter served on localhost in one container). |
| `eval_heldout.py` | Held-out benchmark of reason vs scripted through `autophys.bench.run_case`, with workbooks, `--record` cassette, `scores.json` and `report.json`. |
| `selftest_replay.py` | Offline harness check: replays the teacher's answers as a `--route baseten` cassette. |
| `SDK_BRIEF.md` | SDK issues for the `sdks/python` owner. Nothing in `sdks/` was edited. |
| `partner.env.example` | Partner hand-off template, with no key value. |

## `autophys train` (the CLI drives everything here)

The Rust CLI owns the workflow: dataset identity, budget gates, run manifests,
evaluation and history. These scripts are its worker. All commands take
`--train-dir DIR` (`AUTOPHYS_TRAIN_DIR`, default `<project>/train/sft`) and
`--python FILE` (`AUTOPHYS_TRAIN_PYTHON`, default `~/autophys-train/.venv/bin/python`).

| command | what it does |
|---|---|
| `autophys train dataset [--out DIR] [--train-seeds 0,1,2] [--case NAME]...` | Builds train/validation/held-out rows. `--backend local` (default) is offline and free. `--backend modal --usd-per-hour X --max-usd Y` builds one case per CPU container and writes byte-identical files (`modal_app.py::dataset_main`). Returns per-split rows and sha256 plus the system-prompt hash. |
| `autophys train run --name N --base-model HF_ID --data DIR` | Always plans first: an offline dry run (token counts, schedule) written to `runs/N/manifest.json`. Trains only with `--live`. Any Hugging Face chat model works: the end-of-turn marker is read from the model's own template (`render.end_of_turn`), not hardcoded. |
| `autophys train eval ...` | Held-out closed-loop benchmark, reason vs scripted (`eval_heldout.py`). For a Modal-trained adapter, `modal_app.py::eval_main` serves it on 127.0.0.1 inside one GPU container and runs the benchmark there (see below). |
| `autophys train runs` | Every run manifest, newest first: status, backend, model, rows, budget, held-out scores. |

**Backends for `train run`:**

- `--backend modal --gpu L40S --usd-per-hour X --max-usd Y --live`: LoRA SFT on a
  Modal GPU (`modal_app.py::train_main`), same tokenization and answer-only loss as
  Loops. It scores every held-out step greedily before and after training:
  aggregates go in `heldout_decisions` and per step (case, seed, step, target vs
  predicted action, parsed, matches, first 400 characters of the reply) in
  `heldout_rows`. The adapter goes to the `autophys-train` Modal volume at
  `runs/N/adapter`.
- `--backend loops --usd-per-mtok X --max-usd Y --live`: Baseten Loops via
  `train_sft.py --live` (serverless scope by default).

**Budget gates.** The CLI never assumes a price. Loops needs `--usd-per-mtok`
and `--max-usd`, and refuses if tokens x price exceeds the cap. On Modal the cap
is a hard function timeout: `max_usd / usd_per_hour`, less 20% for container
CPU, memory and startup. A live run with a missing price, cap, GPU or
credentials is refused before anything starts. A run name that is no longer
`planned` cannot be reused.

**Credentials.** Presence is checked, values are never read by the CLI. Keys
live only on rwc-01 (`~/workspace/.env`). For a run on rwc-dev-01, read just
the needed variables on rwc-01 and pipe them over SSH stdin into the one
process, never onto disk there:

```sh
( set -a; eval "$(grep -E '^MODAL_TOKEN_(ID|SECRET)=' ~/workspace/.env)"; set +a
  printf '%s\n%s\n' "$MODAL_TOKEN_ID" "$MODAL_TOKEN_SECRET" ) |
ssh rwc-dev-01 'IFS= read -r MODAL_TOKEN_ID; IFS= read -r MODAL_TOKEN_SECRET
  export MODAL_TOKEN_ID MODAL_TOKEN_SECRET; cd ~/workspace/autophys &&
  exec target/debug/autophys train run --backend modal ... --live'
```

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

## Smoke test result (Modal, 2026-11-04)

`autophys train run --backend modal --name smoke-qwen35-4b-2 --base-model Qwen/Qwen3.5-4B --data data --gpu L40S --usd-per-hour 1.95 --max-usd 10 --live`

- 72 training rows, 36 updates. Validation NLL went from 1.31 to 0.0070; about 11.5 minutes in total on one L40S.
- Held-out steps (seeds 3,4), base then trained: parsed 48/48 and 48/48; action match 26/48 and **42/48**; full decision match 16/48 and **42/48**.
- Cost **$0.44**, all from Modal credits (`modal billing summary`: billed $0.00).
- Caveats: 8 of the 48 held-out rows are byte-identical to training rows (step 1, `FIT: none`), so excluding them it is about 34/40. These are one-step decisions on the scripted policy's states, not closed-loop investigations (that is `eval_main`). And it is distillation, so it can at best match scripted.
- An earlier attempt (`smoke-qwen35-4b`) was refused by Modal before any GPU ran ("add a payment method"), at $0.00.

## Baseten Loops in this workspace (capabilities API, 2026-11-04)

- The default `Qwen/Qwen3.6-35B-A3B` is **not enabled** in this workspace.
- `Qwen/Qwen3.8-27B` is enabled and is the serverless (per-token) option. Smoke-test plan: 582,170 billed tokens on `data/`.
- `Qwen/Qwen3.5-4B`, `Qwen3.5-9B`, `Qwen3.5-27B`, `Qwen3.6-27B` and others are enabled but dedicated-only (GPU-time billing), which the per-token gate cannot cap. Keep those on Modal.
- Loops does not publish a serverless price, and the current key cannot read billing (HTTP 403). A live Loops run needs the rate from the dashboard.

## Setup (private venv, never the shared checkout)

```sh
mkdir -p ~/autophys-train/sdk && git -C ~/workspace/autophys archive HEAD sdks/python | tar -x -C ~/autophys-train/sdk
python3 -m venv ~/autophys-train/.venv
~/autophys-train/.venv/bin/pip install ~/autophys-train/sdk/sdks/python baseten-loops tokenizers jinja2
cd ~/workspace/autophys/train/sft
~/autophys-train/.venv/bin/python build_dataset.py          # data/
~/autophys-train/.venv/bin/python patch_chat_template.py    # serving/Qwen__Qwen3.6-35B-A3B.jinja
~/autophys-train/.venv/bin/python train_sft.py              # dry run: lengths, schedule, billed tokens
~/autophys-train/.venv/bin/python selftest_replay.py        # harness check, offline
```

The `loops-cookbook` package that Baseten's docs reference is not on PyPI (checked 2026-11-04), so `train_sft.py` uses the `baseten-loops` 0.32.0 SDK directly.

## Verified so far (offline, 2026-11-04, SDK at HEAD `8c8a3e9`)

- Scripted baseline on held-out seeds 3,4: oscillator and thermal validated 2/2. The two "-only" cases are inconclusive 2/2, which is the correct answer for them. Diagnosis correct 8/8.
- Dataset: 100% of targets pass `Decision.parse`. All 228 extended trajectories equal `ScriptedPolicy`. The system-prompt sha is identical between HEAD and the live working tree.
- Held-out overlap: seeds are disjoint, but 8 of 48 held-out rows are byte-identical to training rows. All 8 are step 1 (`FIT: none`), which carries nothing seed-specific.
- Coverage gap: `compare_models` and `inspect_data` never appear in the targets. No synthetic case has a sensor bias, so the model never learns them.
- Templates: Qwen3.6-35B-A3B and Qwen3.5-4B upstream **reject** `developer`, and Qwen3-8B **drops its content**. The patched templates reproduce all 72 training prompts byte-for-byte. Qwen3.8-27B was dropped as a candidate because its template injects a reasoning-effort preamble.
- Dry run (Qwen3.6-35B-A3B, strict): 900–1355 tokens per sequence, 5.6% of tokens trained, 36 updates, about 0.58M billed tokens. Extended, at batch 16 and 2 epochs: 160 updates, about 3.76M tokens.
- Harness self-test (replaying the teacher through `--route baseten`): 8/8 pass for reason and scripted, 0 parse failures, 0 guardrail overrides, same actions 8/8. That's a ceiling for a perfect distillation, **not a model result**.

## Not done yet on Loops (needs budget approval, a price and an enabled serverless model)

These steps run in order:

1. `train_sft.py --live`.
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

Replay offline afterwards with `--replay partner.cassette.jsonl` instead of `--record`. `--seeds 5` runs seeds 0–4. Seeds 0–2 are training seeds, so only 3,4 count as held-out.
