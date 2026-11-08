# autophys CLI: one command, the Rust binary; the SDKs are libraries

Status: phases A and B and the CLI-11 worker (option A) published,
2026-11-06 (origin `ef602bf..b06da66`, then `b06da66..2a75846`). Agent
choices CLI-4..CLI-9 and CLI-12..CLI-14 await operator review; the operator
reviewed CLI-16 on 2026-11-07 and chose to split code and data
(implemented 2026-11-07);
CLI-15 (2026-11-07) moved the templates to `examples/`. Thread
autophys/run.

## Why

Today a user meets two programs named `autophys`. The packaged Rust binary
serves the app and administers the server (`serve`, `pair approve`, `keys`,
`users`, `db`, `train`, workbook reads). The Python SDK installs a second
`autophys` console script (`pair`, `whoami`, `bench`, `research`, `autoloop`,
`export-trajectories`). The examples hide this behind
`examples/battery_fit/run.sh`, a venv bootstrapper that dispatches to
`battery_fit.py`, `closed_loop.py` or the Python CLI. Nothing a user installs
gives them the fit, the loop or pairing without cloning the repo.

## Operator decisions (2026-11-06)

```review-table
| Id | Decision | Who |
| -- | -------- | --- |
| CLI-1 | The only CLI is the Rust `autophys` binary. `sdks/python` and `sdks/rust` are libraries for developers: the core primitives to import and use in code. The CLI drives them. No SDK ships a console script. | operator, 2026-11-06 |
| CLI-2 | The CLI sets up a new project for Python or Rust. | operator, 2026-11-06 |
| CLI-3 | A new project depends on the SDK through a git dependency on the private repo `github.com/yuzuquats/autophys`. The SDKs will be published later; the scaffold then switches to registry versions. | operator, 2026-11-06 |
| CLI-15 | The example projects move from `templates/` to `examples/` (still embedded by `build.rs`, still written by `autophys new --example`); `scripts/innerloop_pilot.py`, the only script there, moves to `train/`, and `scripts/` goes away; the training workers are embedded too (CLI-16). Chosen over embedding the workers alone or only renaming; supersedes CLI-8's "no `examples/`". `ops/` stays: it builds and deploys the binary, which cannot carry it. | operator, 2026-11-07 |
| CLI-16 | Reviewed 2026-11-07 (/open-questions): split code and data. The built-in workers and SDK go in a code cache keyed by the binary's version, and training outputs (runs, loops, datasets) go in a separate data directory; each worker takes an output-directory flag instead of writing next to itself. The agent recommended keeping the shared folder until side-by-side versions or confusion justified the refactor. **Implemented 2026-11-07.** Layout under `~/.local/share/tento/autophys/train/`: `code/<key>/train/sft` (the workers, run from there) and `code/<key>/sdks/python` (the SDK, still the workers' `../../sdks/python` for the Modal images), and `data/` (`runs/`, `loops/`, `data/` datasets, anything a worker writes), shared by every version and never touched by an install. The key is `CARGO_PKG_VERSION-` plus the first 12 hex of a SHA-256 over every embedded worker and SDK file name and bytes (for example `0.1.1-2527c6d51347`): the version keeps it readable, and the content hash keeps two builds of one version apart even when the source commit is empty (a source export) or the tree was dirty, while identical builds share a cache harmlessly; the commit alone would do neither. Each cache keeps the edit-preserving install (lock, `.autophys-workers.json`, an edited or pre-existing file is kept and named, nothing deleted, older caches included). The output-directory mechanism is one env var, `AUTOPHYS_TRAIN_DATA`, which the CLI sets on every worker it starts (including `modal run` local entrypoints); a worker run by hand without it writes next to itself as before (`build_dataset.py --out`, `train_sft.py` and `modal_app.py` `runs/`, `real_label.py` `label-work/` and `data-real/`, `patch_chat_template.py` `serving/`; `train_sft.py`/`patch_chat_template.py` read a built `data/` there, else the shipped one). New `--data-dir DIR` (`AUTOPHYS_TRAIN_DATA`) on every train command picks the data directory; without it an explicit `--train-dir` keeps its outputs beside its workers, as before, else `train/data`. Runs and loops from before the split stay in `train/sft` and are never moved: `train runs`/`train loops` list them with a `location` field, and while the new data directory has none of its own each command prints one stderr line naming the old folder and `--data-dir`/`--train-dir`. | operator, 2026-11-07 |
| CLI-11 | Operator 2026-11-06: option A — Rust mcp drives a Python simulator worker for module:project refs. `autophys mcp --project mypkg.module:project` spawns `python -m autophys.worker` from the Python SDK (an internal protocol endpoint, no console script) and calls the user's simulator through it; tools, fits and records stay in the binary. Replaces the phase B refusal recorded under that id. | operator, 2026-11-06 |
```

## Agent choices (pending operator review)

```review-table
| Id | Choice | Strongest alternative | Reverse cost |
| -- | ------ | --------------------- | ------------ |
| CLI-4 | Device pairing is `autophys connect [URL] [--name N]`; `autophys whoami [--json]` shows the key's account. Same device-code flow (`/api/v1/pair/*`) and the same credentials file (`~/.config/autophys/credentials`, 0600, `AUTOPHYS_CONFIG_DIR`), which both SDKs keep reading. `pair list/approve/deny` stays the server-side admin group. | `autophys pair` with no subcommand as the device flow; clashes with the admin group's usage text | rename one command and the docs |
| CLI-5 | `bench`, `research`, `autoloop` and `export-trajectories` move to the Rust CLI. Their orchestration lives in the CLI crate (`src/`), driving `sdks/rust` primitives (simulator, fit, agent, reasoner, playbooks, workbook). The Python modules (`cli.py`, `bench.py`, `research.py`, `autoloop.py`, `trajectories.py`) are removed only after the Rust commands reproduce their replayed results. | keep orchestration in each SDK and have the CLI call the Rust one | move modules between `src/` and `sdks/rust` |
| CLI-6 | `autophys new DIR --lang python|rust [--example battery-fit|blank] [--name P] [--no-install]`. Templates are embedded in the binary. Python writes `pyproject.toml` with `autophys @ git+https://github.com/yuzuquats/autophys@REV#subdirectory=sdks/python`, then creates `.venv` and installs the project unless `--no-install`. Rust writes `Cargo.toml` with `autophys = { git = "https://github.com/yuzuquats/autophys", rev = "REV" }`. REV defaults to the commit the binary was built from; `--sdk-rev` overrides it. | path dependency on a local checkout (works only where the repo is) | change two template lines |
| CLI-7 | `examples/battery_fit` becomes the `battery-fit` template (Python, plus a Rust port of the fit). `run.sh` is deleted. The loop's `approve` and `status` subcommands are dropped from the example in favour of `autophys approve` and `autophys investigations`; `start` and `continue` stay as the user's own program. | keep `examples/` as a separate copy | restore the folder from history |
| CLI-8 | *Superseded by CLI-15 (operator, 2026-11-07): the tree is now `examples/`.* Templates live in a top-level `templates/<example>/{common,python,rust}/` tree, the single source (no `examples/`). `build.rs` embeds every file `git ls-files` lists there (tracked plus untracked, minus ignored, so a `.venv` or plot from running a template in place is never embedded; a plain walk without Git). `*.tmpl` files are rendered, everything else is copied byte for byte. | templates under `src/templates/` with an explicit `include_bytes!` list | move the tree and edit `build.rs`; nothing outside the CLI reads it |
| CLI-9 | The pinned REV is `AUTOPHYS_SOURCE_COMMIT`, a new build.rs variable: `AUTOPHYS_COMMIT` when the release scripts stamp it, else `git rev-parse HEAD` at build time, else empty (then `new` asks for `--sdk-rev`). `--version` and `/api/healthz` keep reporting `AUTOPHYS_COMMIT` or `dev`. `--sdk-repo GIT_URL` overrides the repository (testing unpublished commits; a Python `file:///PATH` is written as `file://localhost/PATH`, which pip requires). `AUTOPHYS_PYTHON` overrides `python3` for the venv. | stamp HEAD into `BuildInfo` too, so `--version` names the commit of every build | one build.rs line and the docs |
| CLI-10 | *Superseded by phase B (CLI-11).* Without the console script, the Muse plugin's source manifest and `build.py` default launch `python3 -m autophys.cli mcp`; a generated bundle still uses the explicit venv interpreter. `mcp` stays in the Python SDK (it serves the user's Python simulator). | keep a console script just for `mcp` | restore the entry point and the plugin default |
| CLI-12 | The removal gate (CLI-5: "reproduce their replayed results") was applied as *decisions match*: cases, steps, requests, diagnoses, accepted playbooks, journals and costs identical, solver counts and scores close (bench `simulations` up to 11%, scores up to 6.4%, research `mean_log_error` up to 11.8% under a 50% tolerance). `parity.sh` did not fail on the strict bench comparator, which exits 1. | require bit-identical scores, which means porting the Python solver's exact evaluation sequence | restore the Python modules from `c086d5b` until exact parity |
| CLI-13 | The CLI-11 worker. Protocol `autophys-worker` version 1: newline-delimited JSON, a startup frame with the simulator schema, display declaration, Project settings, the Python `source_hash` and `config_version`, then `simulate` requests answered in order; user stdout is redirected to stderr. The reusable client is `autophys::worker` in `sdks/rust` (a `FunctionSimulator` whose calls go to the child, serialized by a mutex, child killed on drop); the spawn policy is `src/devtools/python.rs`. Interpreter: `--python`, else `python` in `.autophys-mcp.json` (relative to the working directory), else `AUTOPHYS_PYTHON`, else `python3`. The module is imported with `--root` first on `sys.path`, the worker keeping the server's working directory and environment, as the former Python server did. The worker's `Project.config()` (as canonical JSON reads back) and `config_version` are authoritative: the server records them verbatim in `config_versions`, investigation heads and `describe_project`, so records byte-match what the Python SDK writes, even for a lab typed with integers (`initial={"A": 1}`, `sigma={"y": 1}`, integer bounds, `StopRules`/`Budgets` values), which Python keeps as integers and Rust reads as floats. At startup the rebuilt Rust project must equal that configuration up to number spelling (`1` equals `1.0`, recursively; integers compared exactly) and the config must hash to the version, or the server refuses to start, naming the first differing path. Python's own config version is unchanged; coercing the lab's integers in Python instead would move existing workbooks to new config versions. The pinned configuration lives on `Project` (a private field set by `Project::with_recorded_config`) and is dropped if the project's fields change. Up to 32 lines (64 KiB) of other output on the worker's stdout before its startup frame (sitecustomize, a `.pth` file) are passed to stderr; more, an unreadable frame, or an exit before it fails with the first 200 bytes received and the stderr tail. User exceptions arrive as `SimulationError` (a fit treats them as a failed trial point, as in Python); a crash or protocol fault fails the tool call with the reference and the worker's stderr tail. The protocol version must match exactly. | embed CPython in the binary (PyO3), or keep a separate Python `mcp` server | the pipe is internal to one commit's binary and SDK; changing the transport touches `worker.py`, `worker.rs` and their tests only |
| CLI-16 | (Superseded by the operator's 2026-11-07 answer in the table above, implemented 2026-11-07; kept as history.) Without `--train-dir` or `AUTOPHYS_TRAIN_DIR`, `autophys train` installs the `train/sft` workers built into the binary (`build.rs`, without `tests/`) in the app data directory, `~/.local/share/tento/autophys/train/sft`, and runs there; runs, loops and datasets live beside them because the workers write next to themselves. Before, the default was `CARGO_MANIFEST_DIR/train/sft`, the build machine's checkout, which a release binary does not have. An install writes a missing file or one still holding the bytes an earlier install wrote (recorded in `.autophys-workers.json`), keeps any other file (including one that was there before any install, even with matching bytes) and names it on stderr, and deletes nothing. The Python SDK (`sdks/python` without `tests/`) is installed the same way in `~/.local/share/tento/autophys/sdks/python`, where the workers' Modal images look for it (`../../sdks/python`). A relative `--train-dir` is made absolute. | extract to a cache keyed by content hash and keep state in a separate directory, which needs the workers to take an output-directory flag | point the default back at `project_root()/train/sft`; installed copies stay where they are |
| CLI-14 | (Recorded as "CLI-11 (phase B part)" until 2026-11-06.) `bench --images` and `research --researcher-images` stay refused: plots need the Python renderer. The operator's CLI-11 decision covers the MCP simulator only. | render plots through the same worker | add a `plot` op to the worker |
```

## Phases

**A. One CLI for users.** `connect`/`whoami` in Rust; `new` with the Python
and Rust templates; delete the Python console script entry and the
`pair`/`whoami` commands; replace `run.sh` and point the README, the example
README, `.claude/skills/fit-battery-data`, `html/routes/docs.ts` and
`sdks/python/README.md` at `autophys new` / `autophys connect`.

**B. Developer tools in Rust.** `autophys bench|research|autoloop|export-trajectories`
on `sdks/rust`, proven against the Python implementation on recorded
cassettes (same cases, seeds, decisions and scores). Then remove the Python
orchestration modules and their CLI tests, and update `sdk.md`, `docs.ts`,
`loops-figure.ts` and `train/sft` references.

## Validation

- `cargo test` for the CLI crate and `sdks/rust`; Python SDK tests minus the removed CLI tests.
- `autophys new` into a temp dir for each language and template: the Python
  project installs from the git dependency and the battery fit reproduces
  `examples/battery_fit/expected`; the Rust project builds and runs the fit.
  (The git dependency needs the pinned REV on origin; unpublished revs are
  tested with `--sdk-rev` pointing at a published commit, or with a local
  `file://` git URL.)
- `connect`/`whoami` against a loopback `autophys serve` with a scratch
  collection, approved with `autophys pair approve`.
- Phase B: Rust vs Python parity on replay cassettes, recorded in this page.

## Phase A result (2026-11-06)

Published as two commits (Project: autophys): the plan `dc8981b`
(`Iaf7cb8a686556c5a4c4c2af4d3b3feab`) and the implementation that follows it
(`Ie421641bae5d8226c9f4d041ffa6a10b`): `connect`/`whoami`/`new` in
`src/device.rs`, `src/scaffold.rs` and `build.rs`; `templates/` from
`examples/battery_fit` plus the Rust and blank templates; the Python console
script and its `pair`/`whoami` removed; the Muse plugin launcher; README,
CONTRIBUTING, repository map, docs page, SDK README, skill and Devices panel
text. The commit hashes and Change-Ids cited below are those of the local
drafts it was folded from.

Validation:

- `cargo test --locked --test user_cli` (6 tests: connect against a
  scratch `autophys serve` approved with `autophys pair approve`, key file
  0600 and never printed, `--json` keeps stdout one object, revoked key
  reported as rejected, unreachable server exit 2; `new` for each language
  and template, name normalisation, pins, refusing a non-empty DIR) and the
  `scaffold`/`device` unit tests pass. `cargo test --workspace --locked
  --no-fail-fast` (CLI crate and `sdks/rust`): 249 passed, 0 failed, 2
  ignored. An earlier run under heavy load (pytest in parallel) failed
  `http::binary_exits_cleanly_on_sigterm` once; it passed three isolated
  reruns and in the full run above.
- Python SDK `pytest -q`: 713 passed, 10 skipped (live/peer opt-ins) in
  33 min; then `test_mcp.py`, `test_http.py` and `test_cross_writer.py` with
  `AUTOPHYS_RUST_BIN` set to this build: 44 passed, 1 skipped (live
  smoke). The CLI pairing tests became SDK-level pairing tests
  (`test_http.py`), plus a check that the SDK ships no console script.
- `autophys new py --lang python --sdk-repo file:///…/autophys` (REV
  `5bc4022`): pip installed the SDK from the git dependency; the README's
  regenerate commands reproduce `data/demo.csv`, `data/short.csv`,
  `expected/demo.txt`, `expected/short.txt` and even `expected/demo.png` byte
  for byte. The closed loop ran `start --simulate`, `autophys approve`,
  `continue --simulate` to `validated` with the README's numbers, and
  `autophys verify` passed, all in a temporary `AUTOPHYS_HOME`.
- The same with the GitHub URL at the newest pushed commit (`--sdk-rev
  ef602bf`): pip fetched the private repository and the fit printed the
  expected report.
- `autophys new rs --lang rust --sdk-repo file:///…/autophys`: Cargo
  resolved the SDK from the git dependency (fresh lock), the release build
  ran, its report and `expected/*.txt` match, and `--demo` regenerates
  `data/demo.csv` byte for byte. Both blank templates build and run.
- `connect`/`whoami` by hand against a scratch `autophys serve` on a free
  loopback port (mktemp collection and server database), approved with
  `autophys pair approve`; the server process was then killed. The running
  `autophys.service` and `~/autophys` were not touched.

Deviations from the plan text: none of substance. CLI-8..CLI-10 record the
choices the plan left open. `closed_loop.py` now reads `.env` itself (run.sh
used to). The Rust template writes the fitted curve to `fit.csv` instead of
plotting.

Pre-existing failures seen during validation, not caused by phase A (both
reproduce on the plan commit): `deno test` type-checks
`html/client/context.deno.test.ts` against an older `AppContext` shape, and
`daemon: display events redraw an open store…` fails its record count
(3 vs 2) with `--no-check`.

## Phase B result (2026-11-06)

Published in `b06da66..2a75846` (Project: autophys), above phase A:
`I9ea207fdf2c2df9388057ddb90237547` (the `sdks/rust` primitives: heuristic
brains and typed playbook settings, `external_step`, `measurements`, the
`muse` route, the planted synthetic cases, Python-compatible JSON, random
and `unified_diff`), `I60eb6b960b9df72adcf03c63fce56cc7` (`bench`,
`research`, `autoloop`, `export-trajectories` and `mcp` in `src/devtools`),
`I810df545b865d31c6c621baf03dca1c9` (the bare playbook name always loads
the bundled skill, as in Python), `Id4dbfda56a39aceb27d1950adf4f311f`
(Python `cli.py`, `bench.py`, `research.py`, `autoloop.py`,
`trajectories.py` and `autophys.mcp` removed; the primitives other code
imports moved to `autophys.synthetic`, `autophys.heuristic`,
`autophys.reasoner`, `autophys.measurements` and `autophys.project`; the
Muse plugin launches `autophys mcp`), `I517ec878b3de768db84bd4dec9d6cccd`
(docs, `sdk.md`, `muse-plugin.md`, the training guide), plus this record.

Parity, offline, Rust release binary against the Python tree exported
at `c086d5b` (before removal). Scripts and outputs are in
`~/.cache/autophys/cli-phase-b/` on rwc-dev-01.

- Decisions match exactly; the solver's work does not. `bench --seeds 3`
  (6 cases, scripted and fake-reasoner, 36 rows): status, steps,
  experiments, requested data, test hours, diagnosis, identifiability,
  calls and cost are identical in every row. `simulations` (objective
  evaluations of the fit) differs in 32 rows by up to 11% (battery seed 1:
  557 vs 501), and fake-reasoner prompts differ by at most 5 input tokens
  because they print the solver's numbers. Fitted errors agree to a
  worst relative difference of 6.4%; none of 150 floats is bit-identical.
  The strict comparator (`cmp_bench.py`) therefore exits 1; the plan's
  "same cases, seeds, decisions and scores" holds for decisions, not for
  bit-identical scores.
- `research`, `autoloop` with resume, the bootstrap autoloop and
  `export-trajectories` on the planted case: playbooks, accepted
  iterations, journals (hypothesis, prediction, diff, sha256), stop
  reasons, held-out comparisons, correctness and cost identical
  (`cmp_loops.py`: 0 problems). The scores themselves (`mean_log_error`)
  differ by up to 11.8%, which the comparator accepts under a 50% relative
  tolerance; export prompt tokens are at most 1 apart. `improves()` breaks
  ties on that score, so on other inputs Rust and Python could accept
  different candidates; the planted case does not exercise that.
- `reason` policy through a loopback fake model: each SDK replays its own
  recording identically (8/8 rows); Rust vs Python differ only in
  `simulations` and up to 5 input tokens, as above.
- `mcp`: 14 JSON-RPC requests; the tool list and schemas are identical;
  2 responses differ: `chi2_per_n` at 1e-23 (5.2258e-23 vs 5.2161e-23),
  estimates in the 13th significant digit, wall time and the random
  investigation and proposal ids.

Validation at `872dc0e`: `cargo test --workspace --locked --no-fail-fast`
277 passed, 0 failed, 2 ignored. Python SDK `pytest -q` after the removal:
610 passed, 5 skipped.

### CLI-11 worker result (2026-11-06)

Published in the same range (Project: autophys): `Ia2cb7216c33d9f154763dd1515897f49`
(`python -m autophys.worker` in the Python SDK and the `autophys::worker`
client in `sdks/rust`, with their tests and the `tests/fixtures/python_lab`
module), `Id704a8346e917a5cd05824e25fef5ca1` (`autophys mcp --project
mypkg.module:project` and `--python`, the plugin builder's `--python`, the
integration tests) and `Ia1b6c8d2ae50643e50d7df3f6ee32c21` (docs and this
record). Choices the decision left open are CLI-13.

Parity, offline, debug binary against the Python `mcp` server exported at
`c086d5b`, both serving the fixture `decaylab:project` (y = A exp(-k t)
with a deterministic 0.01 sin(7t) wobble on the CSVs) through the same 12
JSON-RPC requests (initialize, tools/list, describe, import, fit,
identifiability, rank, propose, status, an unknown proposal, report, ping).
Scripts and outputs are in `~/.cache/autophys/cli-11-worker/` on
rwc-dev-01 (`parity.sh`, `parity-summary.txt`).

- The config version is identical (`sha256:adf95e6a…d03279`), so the
  records carry the same simulator source hash and configuration as the
  Python server wrote. Tool list and schemas identical.
- Decisions identical: identified `[A, k]` in both; ranking order
  `short, long`; proposal `proposed` with 10 outlook simulations; report
  `awaiting_data` with the same reason; 84 simulations in both
  investigations.
- Numbers close: fit A 2.0047488991068105 (Python) vs 2.0047488991045577
  (Rust), relative 1.1e-12; k 0.8024507992590093 vs 0.8024507992566328,
  3.0e-12; chi2_per_n 0.46441672251031135 vs 0.4644167225103122; nfev 66
  in both; condition number 3.18579307312659 vs 3.185793073128619; rank
  scores agree to about 1e-11 relative.
- The only differing responses are the workbook paths (two output
  directories) in describe, propose and status.

Validation: `cargo test --workspace --locked --no-fail-fast` with
`AUTOPHYS_PYTHON` set to the venv: 282 passed, 0 failed, 2 ignored (277
before, plus 3 `worker` unit tests and 2 `devtools` tests; without an SDK
interpreter those 2 skip with a message). Python SDK `pytest -q` with
`AUTOPHYS_RUST_BIN`: 619 passed, 5 skipped (7 new worker tests, 2 new
plugin tests). `cargo clippy --workspace --all-targets` reports nothing in
the new code.

Review fixes (2026-11-06, `Iee8d57257061b809b70fe547eeaabe7b`):

- B1: a lab typed with integers (`initial={"A": 1}`,
  `NoiseConfig(sigma={"y": 1})`, `StopRules(validation_threshold=3)`,
  `Budgets(max_test_hours=5)`, integer bounds) was refused at startup: Python
  keeps the integers in `Project.config()`, Rust hashed `1.0`, so the config
  versions differed, although the former Python server served such labs. The
  startup frame now carries the worker's `config`; the server records it and
  its `config_version` verbatim and compares the rebuilt project with it by
  value (CLI-13). Python's config version is unchanged.
- The error for a genuine difference names the first differing path and no
  longer suggests reinstalling the SDK; only a missing `config` (a worker
  from another commit) and a protocol version mismatch still do.
- Output on the worker's stdout before the handshake is passed over (up to
  32 lines) or reported with its first 200 bytes and the stderr tail,
  instead of "invalid startup frame".
- The Python worker tests in `tests/devtools.rs` fail instead of skipping
  when `CI` is set or `AUTOPHYS_REQUIRE_PYTHON=1`.
- The plot-image refusal's agent row, which reused the operator id CLI-11,
  is CLI-14.

Tests added: `project` unit tests for the by-value comparison (int/float,
exact large integers, missing and extra keys, type differences) and for the
recorded configuration (authoritative while the project matches, dropped
after a change, a genuine difference and a wrong version refused);
`worker` unit tests for output before the frame and for recording the
worker's configuration through a fake worker; `devtools`
`mcp_serves_a_python_lab_declared_with_integers` (fixture
`decaylab:integers`: the full MCP cycle, one config version recorded, equal
to Python's `Project.config_version`, pinned by the investigation and
reported by `describe_project`); Python `test_worker.py` checks the frame's
`config` against `Project.config()`. Counts: `cargo test --workspace --locked --no-fail-fast` with
`AUTOPHYS_PYTHON` set: 288 passed, 0 failed, 2 ignored, no `SKIPPED` line
(an earlier run under load average 20 failed the known-flaky
`http::binary_exits_cleanly_on_sigterm` once; it passed three isolated
reruns and the full rerun). `pytest -q` of `test_worker.py`,
`test_muse_plugin.py` and `test_http.py` with `AUTOPHYS_RUST_BIN`: 36
passed, 1 skipped (the live smoke). `cargo clippy --workspace --all-targets`
reports nothing in the changed code.

## Publication (2026-11-06)

`b06da66..2a75846`, 11 commits, pushed as a fast-forward on the operator's
"sink and push". Three Opus review rounds: round 1 (phase B as first
committed) asked for the CLI-11 decision, the parity wording, the
`sdk.md` `--images` lines and the plugin's PATH step; round 2
(with the worker) found integer-typed Python labs refused (fixed by
`Iee8d57257061b809b70fe547eeaabe7b`); round 3 was ready. At `2a75846`:
`cargo test --workspace` 288 passed, 0 failed, 2 ignored, with the worker
tests running; Python SDK `pytest` 620 passed, 5 skipped. Receipt:
rwc-dev-01 `~/workspace/fleet/evidence/autophys/onecli-phaseb-publication-20261106.md`.

## Remaining work

- Operator review of the agent choices: CLI-4..CLI-9 (phase A, see the
  table), CLI-12 (removal gate applied as "decisions match"), CLI-13 (the
  worker's protocol and spawn policy) and CLI-14 (plot images refused).
- For remote workbooks, a Python lab's display bytes are still
  canonicalised from Rust's float values, so integer-typed display
  settings may hash differently from what the Python SDK writes.
- Minor, from the last review: the worker's pre-handshake line read is
  bounded only after a full line arrives; any non-empty `CI` (even
  `CI=false`) makes the worker tests required; external Rust code can no
  longer build a `Project { .. }` literal.
- `bench` and `research` run the planted synthetic cases only; they take no
  project reference, so the worker is not wired into them. A user's
  simulator in those loops would need a case definition (truth parameters,
  experiments) as well as the simulator.
- A worker that hangs (an infinite loop in user code, or on import) blocks
  the MCP call; there is no per-call timeout.
- Exact solver parity, if wanted: the remaining differences come from the
  fit's evaluation count, not from loop logic.
- `autophys investigations` prints whole investigation records in text
  mode; the template README points users at it, so a compact table would
  help.
- Switch CLI-3 to registry versions when the SDKs are published. Until
  then a project pins the binary's own commit, which must be on GitHub for
  pip or Cargo to fetch it; a binary built from an unpushed commit needs
  `--sdk-rev` with a pushed one.
