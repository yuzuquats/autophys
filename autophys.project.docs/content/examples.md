# Examples: templates, demos and backtests

Status: rev 3 (2026-11-07). Plan steps 1 and 2 are implemented
(I91c47241e650e419b25036afffb9d6ed, the SDK cases; I124d47e38ec757fbc1b16e66fa4cec3c, the CLI); step 3 is not. Every choice EX-1..EX-10 is
an operator decision (2026-11-07; EX-4..EX-8 answered in the /open-questions
walkthrough that day). EX-7 and EX-8 differ from the agent's recommendation;
see the table. Where the draft format below differs from what was built,
"Implemented" is current.

## Implemented (steps 1 and 2)

- `examples/blank.template/`, `battery-fit.demo/`, and
  `oscillator.backtest/`, `thermal.backtest/`, `battery.backtest/` (the six
  former code cases plus the planted `battery-biased`), each with an
  `example.toml`. `autophys examples` lists them by kind; `autophys examples
  --check [REF]...` runs the checks below on built-ins or a folder.
- References `[SCHEME:]SOURCE[#CASE]` are parsed in both SDKs
  (`autophys::backtest::parse_ref`, `autophys.backtest.parse_ref`):
  `builtin:` (bare names; a kind suffix such as `blank.template` is
  accepted) and `path:` (`./`, `../`, `/`, `~`). Unknown schemes are errors.
- `new --example REF` takes templates and demos (built in or a folder),
  refuses `#CASE`, refuses a backtest with no project, and reads its next
  steps from the manifest's `[next]`. `bench`, `research`, `autoloop` and
  `train dataset|eval|loop` take repeatable `--example REF[#CASE]`; `--case`
  still works with a deprecation note.
- Backtest format as built: `example.toml` has `[system] model` (a built-in
  simulator, EX-6) and optional `experiment_cost = { setup_hours }` (each
  catalog run costs setup plus its duration), and `[[case]]` tables with
  `name`, `id` (built-ins only), `suite` (default true; false marks a
  planted case), `budget = { max_experiments, max_test_hours }`, `train`
  and `validation` (catalog names or settings tables). One
  `hidden/cases.toml` per example holds `[truth]`, `[noise] sigma`,
  `[[test]]` and a `[case.NAME]` table per case with `combos`,
  `expected_non_identified`, `note`, and optional `bias` and `missing`.
  This replaces the draft's `initial`, per-case `hidden = ...` and `[score]`.
- Ids: built-in cases keep their stable ids (`battery`,
  `battery-short-only`, ...) as investigation and project names, so
  records, replay cassettes, training data and stored results are
  unchanged; a case from a folder uses its canonical reference
  (`path:/abs/x.backtest#case`) as its id. Result rows keep `case` (the id)
  and gain a last field `example` (the canonical reference). This refines
  EX-9: the local names are how cases are referenced, not a rename of
  stored ids.
- Each SDK ships a copy of the three built-in backtests
  (`sdks/rust/src/backtests/`, `autophys/backtests/` package data), tested
  byte-identical to `examples/`, because a pip install from the SDK's
  subdirectory cannot reach the repository's `examples/`. The Python SDK
  reads TOML with `tomllib`, or `tomli` on Python 3.10 (a new dependency
  there). The SDK `*_case` helpers (`battery_case(seed, max_experiments,
  bias)`, ...) now build from the manifests.
- Parity gate: `autophys bench --seeds 3` (scripted and fake-reasoner, all
  seven cases) and Python `run_case` over the same 42 runs give results
  identical to the pre-change baseline in every field except wall time.
- Not built yet: running each demo's `[[expected]]` commands in CI (they
  need the SDK installed from git); the checks confirm the expected files
  exist. `min_autophys` is optional and checked when present.

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
`provenance`, `sha256` and, when measured, `license` and `source`. Backtest
dataset files are never embedded in the binary, whatever their size: each is
listed with `url` and `sha256` and fetched on first use into
`~/.local/share/tento/autophys/datasets/`, then verified (EX-7). Generator
cases have no dataset files and stay offline; demos keep their bundled data.
CI runs dataset cases from a pre-populated cache of that directory.

## Running a backtest

The existing commands read backtest examples instead of the hard-coded
tables. `bench`, `research` and `train eval` select what to run with one
repeatable flag, `--example REF`, the same flag `new` takes (EX-9). A
reference is `[SCHEME:]SOURCE[#CASE]` (EX-10), after Node's `node:fs`,
Nix flake references (`github:owner/repo#pkg`) and Terraform module
sources:

| Scheme | Source | Shorthand |
|---|---|---|
| `builtin:` | an example built into the binary: `builtin:battery` | a bare name, `battery` |
| `path:` | a local example folder: `path:cells/a17.backtest` | anything starting with `./`, `../`, `/` or `~` |
| `github:`, `https:` (later) | `github:owner/repo/dir/x.backtest@REV`, an archive URL | none |

- `#CASE` picks one case; without it `bench` runs every case of the example.
  The first `#` ends the source, so a case never collides with path
  segments. `new` refuses a `#CASE`: it sets up whole examples.
- A bare name is always `builtin:`, never a local folder. If a local folder
  of that name exists, the error or note says to use `./NAME` or `path:`.
- No `--example` runs every built-in backtest (today's default suite). An
  unknown reference fails and lists what exists; nothing is guessed, and an
  unknown scheme is an error.
- Case names are local to their example, so a bare example name is never
  ambiguous:

  | Today's `--case` | Becomes |
  |---|---|
  | `battery`, `battery-short-only`, `battery-biased` (planted) | `battery#full`, `battery#short-only`, `battery#biased` |
  | `oscillator`, `oscillator-free-only` | `oscillator#full`, `oscillator#free-only` |
  | `thermal`, `thermal-short-only` | `thermal#full`, `thermal#short-only` |

- `--case OLD-NAME` keeps working through that table with a deprecation
  note on stderr, and the loader maps old names in recorded replay files and
  stored results, so they still replay and compare.

```sh
autophys examples                                  # every example, grouped by kind
autophys new DIR --example battery-fit             # demo (aliases keep v0.1.1 names working)
autophys new DIR --example blank --lang rust       # template
autophys bench --example battery --policy scripted --seeds 5
autophys bench --example builtin:battery#short-only --example oscillator \
    --policy reason --model muse-spark-1.3 --route meta --record run.jsonl
autophys bench --example ./my-cell.backtest#cell-a17 --policy reason --model … --replay run.jsonl
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
| EX-4 | Generator cases draw the truth per seed from per-case ranges, and a check proves every seed in range keeps the case's expected identifiable set (for example the battery short-pulse case keeps R1*C1 well above its 6 s pulse). One fixed truth stays as the CI regression baseline | operator, 2026-11-07 (recommended option) | compute the expected answer per seed (wider ranges, more harness, relies on the analysis the model uses); fixed truth only (memorization undetected) | drop `[truth.prior]`; small until cross-model results accumulate |
| EX-5 | In a dataset case the model's experiment menu is exactly the recorded runs; the score is held-out prediction error, plus parameter error only when truth is known | operator, 2026-11-07 (recommended option) | offer the full menu and refuse unrecorded requests (realistic, but mostly measures refusal handling) | change the runner's catalogue; small |
| EX-6 | Phased: phase 1 backtests use only the built-in simulators (`battery_ecm`, `oscillator`, `thermal`), so both SDKs run every case; phase 3 adds a backtest's own Python simulator through the `autophys.worker` that `mcp` uses | operator, 2026-11-07 (recommended option) | built-in only; or own simulator first | resequence the plan; small |
| EX-7 | Backtest datasets are always downloaded by URL and sha256 into the data dir, never embedded; demos keep bundled data; CI uses a cache | operator, 2026-11-07 (agent recommended embedding files under 1 MB) | embed small files; embed everything | allow embedding again; small |
| EX-10 | `--example` takes `[SCHEME:]SOURCE[#CASE]`: `builtin:` (bare names) and `path:` (`./`, `../`, `/`, `~`) now, `github:`/`https:` later; `#` separates the case, replacing EX-9's `/`, which would collide with path segments in remote sources | operator, 2026-11-07 (recommended option) | schemes with `/` for cases; no schemes (EX-9 as first recorded) | change the separator or drop the prefixes; small until references appear in stored results and docs |
| EX-9 | `bench`, `research` and `train eval` drop `--case` for one repeatable `--example TARGET` (`example`, `example/case` — separator superseded by EX-10's `#` — or a `.backtest` path with an optional case); case names become local (`battery#full`, …); old `--case` names, replay files and results map through a table | operator, 2026-11-07 (agent recommended a positional `TARGET`; operator chose the flag, matching `new --example`) | positional `bench [TARGET...]`; or keeping `--example` and `--case` as two levels | rename the flag; small while `bench` is a developer tool |
| EX-8 | The demo (`closed_loop.py` `HIDDEN_CELL`, `battery_fit.py` `TRUTH`) and `battery.backtest`'s baseline truth are separate copies with no required link or check | operator, 2026-11-07 ("separate copies is fine"; this replaced an interrupted "load from backtest" answer; agent recommended separate copies plus a CI equality check) | a CI check that the values match; or loading the demo's cell from the backtest | add the check; trivial |

## Plan

1. **Kinds for what exists.** Done (see Implemented).
2. **The existing cases become backtests.** Done (see Implemented).
3. **New capability**, not started: `[truth.prior]` per-seed truth with the
   regime check (EX-4), dataset cases with downloaded data (EX-5, EX-7),
   `bench --summary`, then a backtest's own simulator through the worker
   (EX-6). `--example ./x.backtest` for generator cases already works.

## Open questions

- **Measured data:** is there a battery data set we can redistribute (and
  under which license) for the first dataset case? Without one, phase 3
  ships the dataset format with a synthetic recording only.
- **Prior ranges (work, not a choice):** each case's EX-4 ranges need the
  regime check before they ship.
