# Examples: templates, demos and backtests

Status: draft spec, rev 1 (2026-11-07). Not implemented. EX-1 and EX-2 are
operator decisions (2026-11-07). EX-3 records the operator's definition of a
backtest; the rest of the backtest design (EX-4..EX-7) is **agent-chosen,
pending operator review**.

## Why

`examples/` holds two projects today, and one of them does three jobs.
`battery-fit` is a walkthrough with a known answer (`demo.csv`, `expected/`),
a starting point for your own data (`ocv_generic.csv`), and a closed loop
against a hidden simulated cell (`closed_loop.py --simulate`). Its README is
the only place that says which is which, and `EXAMPLES = ["battery-fit",
"blank"]` in `src/scaffold.rs` is the only catalogue.

Separately, the benchmark cases that `autophys bench`, `autophys research`
and `autophys train eval` score models against live in code, written twice:
`CASES` in `sdks/python/src/autophys/synthetic.py` and its Rust mirror in
`sdks/rust/src/synthetic.rs`. Adding a case means editing both SDKs, and a
user can't add one (cli.md: "a user's simulator in those loops would need a
case definition").

This spec gives every example one of three kinds, with one manifest format,
and turns the benchmark cases into data that both SDKs read.

| Kind | It is for | Has data | Has a right answer |
|---|---|---|---|
| **template** | starting your own project | no | no |
| **demo** | seeing autophys work end to end in a few minutes | yes, bundled | yes, `expected/` output |
| **backtest** | asking a model to discover a hidden system through the pipeline, and scoring it | a list of datasets, or a hidden simulation that generates them | yes, hidden from the model |

## Layout and naming (EX-1, operator decision)

The folder suffix names the kind and `example.toml` describes the example. A
check fails when the two disagree.

```
examples/
  README.md                         this spec, short form
  blank.template/
    example.toml
    python/  rust/
  battery-fit.demo/
    example.toml
    common/data/{demo,short,ocv_generic}.csv
    python/  rust/                  each with expected/
  battery.backtest/
    example.toml                    what the model may see + how runs are scored
    hidden/                         never shown to the model (truth, held-out test data)
    data/                           datasets the model may see (dataset backtests)
    python/  rust/                  optional: a project to watch a run in
```

Naming rules:

- `<name>.<kind>/`, where `name` is lowercase `[a-z0-9-]+` and `kind` is
  `template`, `demo` or `backtest`. Names are unique across kinds, so
  `battery-fit` alone still resolves.
- `common/` plus `<lang>/` is scaffolded, with the language's files
  winning, as today.
- A file ending in `.tmpl` is rendered: the suffix is dropped and
  `{{name}}`, `{{crate_name}}`, `{{sdk_repo}}` and `{{sdk_rev}}` are
  replaced. Every other file is copied byte for byte. `.tmpl` (one file)
  and `.template` (a whole example) are deliberately different words.
- `hidden/` is never scaffolded, never passed to a policy and never listed
  in a prompt. The runner reads it directly from the embedded bytes. Inside
  one process this is a structural boundary, not a security one, the same
  as `Evaluator` today.

## The manifest

Fields every kind has:

```toml
kind = "demo"                         # must match the folder suffix
title = "Fit a battery cell"
summary = "Fit a 1RC model to a pulse test and see which parameters the data pins down."
languages = ["python", "rust"]        # a subfolder must exist for each
min_autophys = "0.2.0"                # binary that understands this manifest
```

### template

Nothing beyond the common fields. It must render completely (no `{{` left)
and build: Python `pip install .`, Rust `cargo check`.

### demo

```toml
[[data]]
path = "common/data/demo.csv"
provenance = "synthetic"              # synthetic | measured
generator = "battery_ecm, R0=0.025 R1=0.045 C1=1600, sigma_v=0.002, seed 0"
sha256 = "…"

[[expected]]                          # what a correct run prints, checked in CI
lang = "python"
run = ".venv/bin/python battery_fit.py data/demo.csv"
stdout = "python/expected/demo.txt"
compare = { numbers = "rel 1e-3" }   # numbers within tolerance, text exact
```

Measured data adds `license` and `source`, and the check refuses a measured
file without both. `expected/*.png` are for people to compare by eye, and CI
doesn't compare them.

### backtest (EX-3..EX-7)

The operator's definition (EX-3): a backtest is a complete example with
either a list of datasets or a hidden simulation that can generate datasets,
and a model is asked to discover the system using the autophys pipeline.

"The pipeline" is the existing investigation loop: the model sees the
project and the initial data, then repeatedly chooses one action from the
fixed list in `agent.py`. The actions are `inspect_data`,
`optimize_parameters`, `analyze_sensitivity`, `rank_experiments`,
`request_experiment`, `compare_models`, `validate_predictions` and `stop`.
"Discover" means the model ends with a validated or inconclusive claim:
parameter estimates, which parameters are identified, and (when the backtest
hides a structural variant) which model variant is right. The model never
fits by hand: fits, sensitivity and ranking run in the SDK, and the model
decides what to do next. Every backtest asks for the same thing, and
what is hidden differs.

A backtest has one or more **cases**. Each case says what the model sees,
how new data appears when it requests an experiment, and how the claim is
scored.

```toml
kind = "backtest"
title = "Battery 1RC: discover R0, R1 and C1"
summary = "A cell behind a cycler. Pulse it, rest it, and say what you can determine."
languages = ["python"]

[system]                              # what the model is told
model = "battery_ecm"                 # a built-in simulator (see EX-6)
experiments = "builtin"               # the model's experiment catalogue, or a [[experiment]] list

[[case]]
name = "battery"
source = "generator"                  # generator | datasets
initial = [{ experiment = "pulse_short", split = "train" },
           { experiment = "pulse_short_1A", split = "validation" }]
budget = { max_experiments = 2, max_test_hours = 3.0, max_steps = 40 }
hidden = "hidden/battery.toml"        # truth, noise, test experiments, expectations

[[case]]
name = "battery-short-only"
source = "generator"
initial = [{ experiment = "pulse_short", split = "train" }]
budget = { max_experiments = 0 }
hidden = "hidden/battery-short-only.toml"
```

The hidden file for a **generator case** (EX-4):

```toml
[truth]                               # fixed truth: the regression baseline
R0 = 0.025
R1 = 0.045
C1 = 1600.0

[truth.prior]                         # or drawn per seed, so a model can't recall the answer
R0 = { log_uniform = [0.01, 0.06] }
R1 = { log_uniform = [0.02, 0.09] }
C1 = { log_uniform = [600.0, 4000.0] }

[noise]
sigma = { v = 0.002 }
bias = {}                             # e.g. { v = 0.01 } plants a sensor offset
missing = 0.0

[score]
combos = { R0 = { R0 = 1.0 }, R1 = { R1 = 1.0 }, C1 = { C1 = 1.0 } }
expected_non_identified = []
expected_variant = "base"             # only for structural cases, see compare_models
tolerance = 0.10
note = "A 6 s pulse against a 72 s RC time constant resolves I*R0 and I/C1; R1 needs relaxation."

[[test]]                              # held out: scores prediction, never shown
name = "unseen_train"
kind = "pulse_train"
current = 1.5
on = 40.0
off = 60.0
duration = 500.0
rate = 1.0
```

A **dataset case** (EX-5) replaces the generator with recorded data. That is
how measured data enters a backtest.

```toml
[[case]]
name = "cell-a17"
source = "datasets"
initial = [{ dataset = "data/a17/pulse_2A.csv", experiment = "pulse_2A", split = "train" }]
# request_experiment(x) returns the recorded run for x; the catalogue is the recorded runs
available = [
  { dataset = "data/a17/pulse_train.csv", experiment = "pulse_train" },
  { dataset = "data/a17/discharge_1A.csv", experiment = "discharge_1A" },
]
budget = { max_experiments = 2 }
hidden = "hidden/cell-a17.toml"       # held-out runs; truth only if it is known
```

For a dataset case, the score is prediction error on the held-out runs.
Parameter error is added only when the hidden file has a `[truth]`, for
example a cell measured on a reference rig. Every dataset file carries
`provenance`, `sha256` and, when measured, `license` and `source`. A file
larger than 1 MB is listed with `url` and `sha256` instead of being
embedded, and fetched on first use into
`~/.local/share/tento/autophys/datasets/` (EX-7).

## Running a backtest

The existing commands read backtest examples instead of the hard-coded
tables. Names stay `<example>/<case>`, and a bare case name stays valid
while it is unique.

```sh
autophys examples                                  # every example, grouped by kind
autophys new DIR --example battery-fit             # demo (aliases keep v0.1.1 names working)
autophys new DIR --example blank --lang rust       # template
autophys bench --case battery --policy scripted --seeds 5
autophys bench --case battery/battery-short-only \
    --policy reason --model muse-spark-1.3 --route meta --record run.jsonl
autophys bench --example ./my-cell.backtest --policy reason --model … --replay run.jsonl
```

- **One run** is (case, seed, policy, model spec, playbook), and produces one
  row. Today's `BenchRow` fields stay: status, `max_rel_error`, per-combo
  errors, `test_rmse`, `non_identified`, `diagnosis_correct`, experiments,
  steps, test hours, calls, tokens, cost. Rows gain `example`, the manifest's
  sha256, the binary's commit, and `variant_correct` for structural cases.
- **Comparing models** means running the same cases and seeds with each
  `--model` and appending the rows to one JSONL file. `bench --summary
  FILE` prints one table per case with pass rate, median error, median steps
  and cost per model. A run passes when its claim is validated, every
  identified combo is within `tolerance`, its non-identified set matches,
  and (where present) its variant is right.
- **Replay** keeps working as it does today: `--record` saves model replies,
  and `--replay` reruns them offline at no cost. Live model calls still
  need `AUTOPHYS_ALLOW_LIVE_REASON=1`.
- **Leakage:** a backtest example scaffolds without `hidden/`. Per-seed
  truth (`[truth.prior]`) keeps a public example's numbers from being recalled
  by a model trained on this repository. The fixed `[truth]` is kept for the
  regression baseline that CI checks.

## Checks (CI)

| Kind | Check |
|---|---|
| all | suffix matches `kind`; required fields present; one subfolder per language; every `[[data]]` file exists and matches its sha256; measured data has a license and a source |
| template | renders with no `{{` left; `pip install .` / `cargo check` |
| demo | each `[[expected]]` command runs and matches within its `compare` rule |
| backtest | every case loads in **both** SDKs; `scripted` reproduces a committed baseline row per case and seed (decisions exact, numbers within tolerance, the CLI-12 rule); a recorded `reason` cassette replays to the same decisions |

## Choices made here

| Id | Choice | Status | Strongest alternative | To reverse |
|---|---|---|---|---|
| EX-1 | The folder suffix names the kind, `example.toml` describes it, and a check keeps them in agreement | operator, 2026-11-07 | manifest only, with plain folder names | rename the folders back; minutes |
| EX-2 | `autophys new --example NAME` takes any kind; the v0.1.1 names are aliases; `autophys examples` lists examples by kind | operator, 2026-11-07 | one flag per kind (`--template`, `--demo`) | add the flags, keep `--example`; small |
| EX-3 | A backtest is an example with datasets or a hidden simulation, and a model discovers the system through the investigation loop | operator, 2026-11-07 | — | — |
| EX-4 | Generator cases may draw the truth per seed from a prior; a fixed truth is kept as the regression baseline | agent-chosen, pending operator review | fixed truth only, as today (simpler, but a model can recall published numbers) | drop `[truth.prior]`; small |
| EX-5 | In a dataset case, `request_experiment` only returns recorded runs; with no truth, the score is held-out prediction error | agent-chosen, pending operator review | let the model propose any experiment and mark unrecorded ones as unavailable (more realistic, but it spends the budget on refusals) | change the runner's catalogue; small |
| EX-6 | Phase 1 backtests use only the built-in simulators (`battery_ecm`, `oscillator`, `thermal`), so both SDKs can run every case | agent-chosen, pending operator review | a backtest's own simulator in Python, run through the `autophys.worker` that `mcp` already uses (any system, but Python only, with no Rust parity) | phase 3 below adds it |
| EX-7 | Datasets over 1 MB are fetched by URL and sha256 into the data dir, not embedded in the binary | agent-chosen, pending operator review | embed everything (offline, but a larger binary) | change the size cutoff; trivial |

## Plan

1. **Kinds for what exists.** Rename to `blank.template/` and
   `battery-fit.demo/`, add the manifests, `autophys examples` and the
   aliases. `build.rs` embeds by manifest instead of the depth-3 skip rule,
   and the template/demo checks go in CI. No behaviour change for v0.1.1
   users.
2. **The existing cases become backtests.** Move the six `CASES` and the
   planted `battery-biased` case into `battery.backtest/`,
   `oscillator.backtest/` and `thermal.backtest/`. Both SDKs load the cases
   from the manifests, and the code tables are deleted. Gate: `bench --seeds 3`
   and the recorded `reason` cassettes give the same decisions as before the
   move (the CLI-12 rule), and `train eval` is unchanged.
3. **New capability.** `[truth.prior]` per-seed truth, dataset cases,
   `--example PATH` for a user's own backtest, `bench --summary`, then a
   backtest's own simulator through the worker (EX-6's alternative) if wanted.

## Open questions

- **Measured data:** is there a battery data set we can redistribute (and
  under which license) for the first dataset case? Without one, phase 3
  ships the dataset format with a synthetic recording only.
- **Prior ranges:** EX-4's ranges for each model need a physics check, so
  that every seed is still identifiable with the same experiments.
- **`closed_loop.py`** stays in the demo as the guided walkthrough of the
  loop. Should the demo's hidden cell come from `battery.backtest` so the
  two can't drift?
