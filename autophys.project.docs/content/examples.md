# Examples: templates, demos and backtests

Status: rev 4 (2026-11-07). All three plan steps are implemented; see
"Implemented" (step 1 and 2 Change-Ids are listed there; step 3 is the
commit "Draw backtest truth per seed, replay recorded runs and score models").
Every choice EX-1..EX-10 is an operator decision (2026-11-07; EX-4..EX-8
answered in the /open-questions walkthrough that day). EX-7 and EX-8 differ
from the agent's recommendation; see the table. Where the draft format
below differs from what was built, "Implemented" is current. EX-11 (below)
is deferred by the operator (2026-11-08) until a trigger it names.

## Implemented

Steps 1 and 2 (I91c47241e650e419b25036afffb9d6ed, the SDK cases;
I124d47e38ec757fbc1b16e66fa4cec3c, the CLI):


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
  `expected_non_identified`, `note`, and, for a generator case only,
  optional `bias` and `missing` (a dataset case refuses them, EX-12).
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

Step 3:

- **Per-seed truth (EX-4).** `hidden/cases.toml` may have `[prior]`, one
  `uniform = [lo, hi]` or `log_uniform = [lo, hi]` per `[truth]`
  parameter (the fixed value must lie inside). With `autophys bench --truth
  drawn` (Python `run_case(..., truth="drawn")`), each generator case's
  truth is drawn for its seed from `default_rng([seed, 3])`, in `[truth]`
  order, identically in both SDKs (a test pins seed 1's draw in each).
  `autophys examples --check` runs the regime check: for 32 seeds, the
  drawn truth must leave the same parameters non-identified from the
  starting data as the fixed truth does, and the starting data plus every
  catalog experiment must leave exactly `expected_non_identified` (a case
  with no experiments: from its starting data). The three built-ins have
  ranges that pass (tests use 48 seeds). The battery short-pulse answer is a
  noise-level threshold, so its ranges are narrow (about +/-12%); +/-40%
  ranges flipped it in 9 of 16 seeds.
- **EX-11 (operator, 2026-11-08: deferred with a trigger): fixed truth
  stays the default for now.** EX-4 says random truth per seed with one fixed seed as the CI
  baseline. Drawing by default would change the data of every built-in
  case at every seed, which breaks the recorded reasoner cassettes, the
  committed training data (`train/sft/data`) and comparisons with stored
  results. So `--truth fixed` is the default and `--truth drawn` is what
  model comparisons should use; results record which. Strongest
  alternative: draw by default for seeds other than 0 and re-record the
  cassettes and training data. Reversal: change the default in `bench` and
  `run_case`; small, plus the re-recording.
  Operator decision (2026-11-08, option D of four): keep fixed truth
  everywhere for now, because nothing learns from these cases yet. Trigger:
  before the first fine-tuned model is evaluated with `train eval` or the
  `train loop` held-out check, or before the research loop's first real
  run, switch to option C: `train eval`, the `train loop` held-out check
  and research-loop scoring use drawn truth on the held-out seeds, while
  `bench`, CI and the training data stay fixed; re-record any held-out
  replay files. Rejected for now: B (draw by default for seeds other than
  0 in every command; re-records all cassettes and training data) and
  doing C immediately (no learner exists to misjudge yet).
- **Recorded runs (EX-5).** `[[dataset]]` tables (public ones in
  `example.toml`, held-out ones in `hidden/cases.toml`) give `name`,
  `settings` (the program the run used), `file` (folders on disk only) or
  `url`, `sha256`, `columns` (`t` plus each channel), `sigma` and
  `provenance` (`measured` needs `license` and `source`). A case with
  `source = "datasets"` names datasets in `train`/`validation`; its
  experiment menu is the remaining public datasets, each runnable once;
  `[case.NAME] test = [...]` names the held-out runs. Each run is read as a
  plain CSV and interpolated onto its settings' time grid (as
  `numpy.interp`). With no `[truth]`, there is no parameter error and no
  reveal record; the score is held-out prediction error and the diagnosis.
- **`battery-recorded.backtest`** (built in, not in the default suite):
  six recorded runs of one cell (R0 0.031, R1 0.052, C1 2100: a 109 s
  polarization time constant), synthesized by its `generate.py` with 2 mV
  noise until measured data that may be redistributed exists. The model
  starts from a 6 s pulse and a 1 A check and may request the three catalog
  programs (`two-tests`: two, `one-test`: one); `unseen_train` is held out.
  The CSVs live in the repository's `examples/battery-recorded.backtest/data/`,
  which hosts them: the manifest fetches them from
  `raw.githubusercontent.com/yuzuquats/autophys/master/...` and checks each
  by sha256, and `build.rs` leaves every backtest's `data/` out of the
  binary. The urls answer only once the files are on origin master.
- **Downloads (EX-7).** A `url` (`https://`, `http://`, `file://`) is
  fetched once into `AUTOPHYS_DATASETS_DIR`, else
  `$XDG_DATA_HOME/tento/autophys/datasets`, else
  `~/.local/share/tento/autophys/datasets`, named by its sha256 and
  verified on every read. A built-in backtest may only use `url`.
- **A backtest's own simulator (EX-6, phase 3).** `[system] project =
  "module:attr"` in a folder on disk imports the module from the example
  folder: the Rust SDK through `python -m autophys.worker --root DIR`
  (`AUTOPHYS_PYTHON`, else `python3`), the Python SDK directly. Built-ins
  must use a built-in model.
- **Comparing models.** `autophys bench --append RESULTS.jsonl` appends one
  row per run with `model` (`route:model`, null offline), `truth`, the
  binary's version and commit. `autophys bench --summary RESULTS.jsonl`
  prints one row per (case, policy, model, truth): passed/runs, median max
  relative error, median test RMSE, median steps, total cost. A run passes
  when it is validated or rightly inconclusive, its diagnosis is right and,
  when the truth is known, every scored quantity is within 10% (the `train
  eval` rule). Result rows' `requested` now lists the train runs after the
  starting ones (identical for generator cases).
- Validation: with fixed truth, `bench --seeds 3` and Python `run_case` over
  the 42 baseline runs are still identical to the pre-change baseline; Rust
  workspace tests pass; Python 620 passed / 13 skipped.

## Live checks (2026-11-07, yuzuquats)

Evidence (result rows and stderr): `yuzuquats:~/.local/state/tento/evidence/autophys/examples-live-20261107/`.

- **Downloads over https:** a backtest folder whose dataset `url` is a
  published file on `raw.githubusercontent.com` ran through `autophys bench`
  (Rust, ureq) and the Python SDK (urllib): each fetched it once into an
  empty datasets directory under its sha256, and a wrong sha256 was refused
  with both digests named. `battery-recorded`'s own urls return 404 until
  its data is on origin master, so its live runs read a datasets directory
  filled from the repository files (same bytes, same sha256).
- **Models** (route `baseten` pointed at the operator's OpenAI-compatible
  proxy, subscription models only; 2 seeds each of `battery-recorded`
  `two-tests` and `one-test`, and `battery#full` and `battery#short-only`
  with `--truth drawn`):

  | Model | Passed | Notes |
  |---|---|---|
  | scripted (offline) | 8/8 | requests `discharge_1A` on the recorded cell; 1.07% max error |
  | muse-spark-1.3 | 8/8 | same choices and errors as scripted, about 10 calls and 100 s a run |
  | muse-wonder-1.0 | 8/8 | same outcomes, about twice Spark's token cost |
  | glm-5.3 | 3/8, then 2/4 on a rerun | failures are empty replies (reasoning used the completion budget) |
  | gpt-6.1-sol, claude-sonnet-5-5 | not run | the proxy answered HTTP 429: usage limit reached (GPT, resets in about 55 h) and account rate limit (Claude) |

  The Python SDK's live path (`run_case(..., policy="reason")`) validated
  `battery-recorded#one-test` and ended `battery#short-only` (drawn truth)
  rightly inconclusive.
- **Route `muse`** (headless `muse exec`) could not run here: the `muse` on
  this host is a different tool without `exec`. Modal is not installed or
  configured on this host, so the CLI-16 Modal entrypoints were not run live.
- **Fixes from the live runs:** a failed `bench` run now says why on stderr
  (reasons and the last step error; before, every failure was a bare
  "failed"); an empty model reply is reported as such in both SDKs instead
  of "not JSON: EOF while parsing"; `--append` rows label recorded-run cases
  `truth = "recorded"`.

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
| EX-11 | Fixed truth stays the default for now; `--truth drawn` draws per seed (EX-4), and results record which. Before the first fine-tune evaluation or real research-loop run, held-out evaluation and research scoring switch to drawn truth (option C) | operator, 2026-11-08 (deferred with that trigger; agent recommended deferring) | draw by default for seeds other than 0 everywhere and re-record the cassettes and training data (B); or C now | implement C at the trigger: small code change plus re-recording held-out replays |
| EX-10 | `--example` takes `[SCHEME:]SOURCE[#CASE]`: `builtin:` (bare names) and `path:` (`./`, `../`, `/`, `~`) now, `github:`/`https:` later; `#` separates the case, replacing EX-9's `/`, which would collide with path segments in remote sources | operator, 2026-11-07 (recommended option) | schemes with `/` for cases; no schemes (EX-9 as first recorded) | change the separator or drop the prefixes; small until references appear in stored results and docs |
| EX-9 | `bench`, `research` and `train eval` drop `--case` for one repeatable `--example TARGET` (`example`, `example/case` — separator superseded by EX-10's `#` — or a `.backtest` path with an optional case); case names become local (`battery#full`, …); old `--case` names, replay files and results map through a table | operator, 2026-11-07 (agent recommended a positional `TARGET`; operator chose the flag, matching `new --example`) | positional `bench [TARGET...]`; or keeping `--example` and `--case` as two levels | rename the flag; small while `bench` is a developer tool |
| EX-12 | A recorded case keeps running every seed (the seed still moves the fitter's start points, and a live model's choices vary), and `bench`, `bench --summary` and `train eval` show a `truth` column (`recorded`, `fixed`, `drawn`) plus a note that a recorded case's seeds are repeats on the same runs; `bias` and `missing` are refused for recorded cases instead of being ignored | operator, 2026-11-07 (recommended option; the operator chose a column over a label in the seeds cell) | run recorded cases once offline, or always once (changes how much the recorded case weighs when `train loop` accepts a model) | drop the column; trivial |
| EX-8 | The demo (`closed_loop.py` `HIDDEN_CELL`, `battery_fit.py` `TRUTH`) and `battery.backtest`'s baseline truth are separate copies with no required link or check | operator, 2026-11-07 ("separate copies is fine"; this replaced an interrupted "load from backtest" answer; agent recommended separate copies plus a CI equality check) | a CI check that the values match; or loading the demo's cell from the backtest | add the check; trivial |

## Plan

1. **Kinds for what exists.** Done.
2. **The existing cases become backtests.** Done.
3. **New capability.** Done (per-seed truth, recorded runs, downloads, own
   simulators, `--append`/`--summary`), and `battery-recorded` with
   synthesized runs. Not done, by operator direction for now: running each
   demo's `[[expected]]` commands in CI.

## Open questions

- **Measured data:** a battery data set we may redistribute (and its
  license) would replace or join `battery-recorded`'s synthesized runs.
  Hosting is the repository itself for now (raw GitHub urls, pinned by
  sha256); release assets remain an alternative.
- **EX-11 trigger** (above): switch held-out evaluation and research
  scoring to drawn truth before the first fine-tune evaluation or real
  research-loop run.
