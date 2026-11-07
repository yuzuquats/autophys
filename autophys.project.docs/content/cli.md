# autophys CLI: one command, the Rust binary; the SDKs are libraries

Status: plan, rev 1, 2026-11-06. Thread autophys/run.

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

## Remaining work

Switch CLI-3 to registry versions when the SDKs are published.
