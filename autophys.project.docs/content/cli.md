# autophys CLI: one command, the Rust binary; the SDKs are libraries

Status: phase A published, 2026-11-06; phase B implemented locally, 2026-11-06. Thread autophys/run.

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
```

## Agent choices (pending operator review)

```review-table
| Id | Choice | Strongest alternative | Reverse cost |
| -- | ------ | --------------------- | ------------ |
| CLI-4 | Device pairing is `autophys connect [URL] [--name N]`; `autophys whoami [--json]` shows the key's account. Same device-code flow (`/api/v1/pair/*`) and the same credentials file (`~/.config/autophys/credentials`, 0600, `AUTOPHYS_CONFIG_DIR`), which both SDKs keep reading. `pair list/approve/deny` stays the server-side admin group. | `autophys pair` with no subcommand as the device flow; clashes with the admin group's usage text | rename one command and the docs |
| CLI-5 | `bench`, `research`, `autoloop` and `export-trajectories` move to the Rust CLI. Their orchestration lives in the CLI crate (`src/`), driving `sdks/rust` primitives (simulator, fit, agent, reasoner, playbooks, workbook). The Python modules (`cli.py`, `bench.py`, `research.py`, `autoloop.py`, `trajectories.py`) are removed only after the Rust commands reproduce their replayed results. | keep orchestration in each SDK and have the CLI call the Rust one | move modules between `src/` and `sdks/rust` |
| CLI-6 | `autophys new DIR --lang python|rust [--example battery-fit|blank] [--name P] [--no-install]`. Templates are embedded in the binary. Python writes `pyproject.toml` with `autophys @ git+https://github.com/yuzuquats/autophys@REV#subdirectory=sdks/python`, then creates `.venv` and installs the project unless `--no-install`. Rust writes `Cargo.toml` with `autophys = { git = "https://github.com/yuzuquats/autophys", rev = "REV" }`. REV defaults to the commit the binary was built from; `--sdk-rev` overrides it. | path dependency on a local checkout (works only where the repo is) | change two template lines |
| CLI-7 | `examples/battery_fit` becomes the `battery-fit` template (Python, plus a Rust port of the fit). `run.sh` is deleted. The loop's `approve` and `status` subcommands are dropped from the example in favour of `autophys approve` and `autophys investigations`; `start` and `continue` stay as the user's own program. | keep `examples/` as a separate copy | restore the folder from history |
| CLI-8 | Templates live in a top-level `templates/<example>/{common,python,rust}/` tree, the single source (no `examples/`). `build.rs` embeds every file `git ls-files` lists there (tracked plus untracked, minus ignored, so a `.venv` or plot from running a template in place is never embedded; a plain walk without Git). `*.tmpl` files are rendered, everything else is copied byte for byte. | templates under `src/templates/` with an explicit `include_bytes!` list | move the tree and edit `build.rs`; nothing outside the CLI reads it |
| CLI-9 | The pinned REV is `AUTOPHYS_SOURCE_COMMIT`, a new build.rs variable: `AUTOPHYS_COMMIT` when the release scripts stamp it, else `git rev-parse HEAD` at build time, else empty (then `new` asks for `--sdk-rev`). `--version` and `/api/healthz` keep reporting `AUTOPHYS_COMMIT` or `dev`. `--sdk-repo GIT_URL` overrides the repository (testing unpublished commits; a Python `file:///PATH` is written as `file://localhost/PATH`, which pip requires). `AUTOPHYS_PYTHON` overrides `python3` for the venv. | stamp HEAD into `BuildInfo` too, so `--version` names the commit of every build | one build.rs line and the docs |
| CLI-10 | *Superseded by phase B (CLI-11).* Without the console script, the Muse plugin's source manifest and `build.py` default launch `python3 -m autophys.cli mcp`; a generated bundle still uses the explicit venv interpreter. `mcp` stays in the Python SDK (it serves the user's Python simulator). | keep a console script just for `mcp` | restore the entry point and the plugin default |
| CLI-12 | The removal gate (CLI-5: "reproduce their replayed results") was applied as *decisions match*: cases, steps, requests, diagnoses, accepted playbooks, journals and costs identical, solver counts and scores close (bench `simulations` up to 11%, scores up to 6.4%, research `mean_log_error` up to 11.8% under a 50% tolerance). `parity.sh` did not fail on the strict bench comparator, which exits 1. | require bit-identical scores, which means porting the Python solver's exact evaluation sequence | restore the Python modules from `c086d5b` until exact parity |
| CLI-11 | Phase B ports `mcp` to the Rust binary and the plugin launches `autophys mcp`. It serves the built-in projects (`--project battery_ecm`); a Python `module:project` reference, which the Python server loaded from the user's simulator, is refused. `bench --images` and `research --researcher-images` are refused too: plots need the Python renderer. | keep a Python `mcp` for user-defined Python simulators (CLI-10 as written) | restore `autophys.mcp` from `c086d5b` and the plugin's `--python` launcher |
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

Local commits (Project: autophys) above the phase A publication:
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

## Remaining work

- Operator review of CLI-11: user-defined Python simulators can no longer
  be served over MCP, and plot images are refused.
- Exact solver parity, if wanted: the remaining differences come from the
  fit's evaluation count, not from loop logic.
- `autophys investigations` prints whole investigation records in text
  mode; the template README points users at it, so a compact table would
  help.
- Switch CLI-3 to registry versions when the SDKs are published. Until
  then a project pins the binary's own commit, which must be on GitHub for
  pip or Cargo to fetch it; a binary built from an unpushed commit needs
  `--sdk-rev` with a pushed one.
