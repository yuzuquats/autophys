# tento-sh — library guide

`tento-sh` ("Tento Shell", `tsh`) is a Rust library for building small,
file-backed, Lisp-extensible shells. It is the scaffolding behind the `tento-*`
group binaries and the standalone `tsh` core.

This `docs/` directory is the **library reference** — the public API, the `.tsh`
script layer, the protocol, headless mode, the TUI host, and the design spec for
driving a coding harness from inside the shell. For the higher-level
architecture and the resolved design forks (F1–F11), see the project docs at
`~/workspace/tento-shell.project.docs/content/` (linked throughout — read, don't
re-derive).

## The north star

> Make `tsh` behave like **bash, not like a Swiss Army knife** — a small, stable
> core that *finds and runs* command groups, instead of a monolith that
> *contains* them all. Bash doesn't contain `git`; it finds the program on disk
> and runs it. `tsh` finds `*.tsh.app` bundles on a `PATH`-like search and mounts
> them as CLI/REPL namespaces, with no compile-time dependency on the group.

A second, equal half of the north star: the shell is **hackable and
file-backed**, so the same surface that humans drive can be driven by automation
and reshaped into new tools (a coding harness, a web terminal) without forking
the core.

## The five subgoals (the spine of these docs)

1. **The core Rust modules stay product-agnostic.** Nothing in `tento-sh` /
   `tento-sh-tui` knows about whoop, lona, or deepseek. → [api.md](./api.md)
2. **Product logic is written in `.tsh`** (a small Lisp). Command groups, login,
   modes, and layout are Lisp, not recompiled Rust. → [script-layer.md](./script-layer.md)
3. **Binaries modally toggle structured vs human output.** `./my-bin` renders
   for a human; `./my-bin --tsh` emits JSON render shapes. Same input, two output
   modes — this is the *first-class headless mode*. → [protocol-and-headless.md](./protocol-and-headless.md)
4. **The TUI is a functional transformation of file-backed state.** Panes render
   from files; a push-based file-watch repaints on change. So an external actor
   (an LLM) can drive a terminal by reading and writing the same files. →
   [tui-host.md](./tui-host.md)
5. **The same hackable TUI drives a coding CLI.** Type `(lane.use "deepseek")`
   at the prompt and a DeepSeek coding harness runs inside the shell. →
   [coding-harness.md](./coding-harness.md)

## Crate map (one paragraph)

`src/shell.rs` holds the three load-bearing types — `Shell<Info>` (the
CLI/REPL host), `Scripts<Info>` (a command set), and the `Callable` trait (the
dispatch interface). Commands are declared with the `#[command]` derive macro
(`tento-sh-macros/`) implementing `CommandMetadata` (`src/command_metadata.rs`),
with `--key value` parsing via `CommandArg` (`src/command_arg.rs`). `src/run_loop.rs`
is the dispatch core (`exec`, the `--tsh` strip, human-vs-JSON output).
`src/remote_group.rs` + `src/tsh_app.rs` mount a `*.tsh.app` bundle as a namespace
by spawning its binary (the *oneshot* transport). `src/script/` is the `.tsh`
interpreter (`parser.rs` line kinds, `interp.rs` = `LispHost` + `@import`,
`runner.rs` execution). The interactive TUI lives in the sibling `tento-sh-tui`
crate; the `tsh` binary is `mono/tento/tsh/`.

## Pages

- [api.md](./api.md) — `Shell`, `Scripts`, `Callable`, `CommandMetadata`,
  `CommandArg`, the `#[command]` macro.
- [authoring-a-group.md](./authoring-a-group.md) — build a command group, return
  render shapes, package it as a `*.tsh.app`.
- [script-layer.md](./script-layer.md) — the `.tsh` language: line kinds,
  interpolation, binds, dotted paths, `@import`.
- [protocol-and-headless.md](./protocol-and-headless.md) — the `--tsh` toggle and
  the versioned render shapes (subgoals 2 & 3).
- [tui-host.md](./tui-host.md) — the file-backed TUI, turns, and in-composer
  control forms (subgoal 4).
- [coding-harness.md](./coding-harness.md) — **spec**: driving a DeepSeek coding
  harness via `(lane.use "deepseek")` (subgoal 5).
