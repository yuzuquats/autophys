# tento-core

`tento-core` holds small shared runtime helpers used by Tento command-line
tools and services. It's the catch-all utility crate — logging, crypto,
serialization, subprocess management, file-system helpers, validation,
request handling, async primitives, and more.

## Public surface

### Logger installation

- `install_repl_logger(app_name, flush_immediate)` — installs the default
  terminal logger and returns a `tento_sh::ExternalPrinter`.
- `install_repl_logger_with_parquet(app_name, flush_immediate, parquet_log_dir)`
  — adds optional rolling Parquet log output.
- `install_repl_logger_with(app_name, flush_immediate, parquet_log_dir,
  trace_pane_path, tui_mode)` — full-control logger: Parquet output, LJSON
  trace pane file for TUI tailing, and TUI-mode suppression of the
  in-process terminal consumer so the alt-screen compositor stays uncorrupted.

### Environment

- `DISABLE_REPL` — shared environment switch for REPL behavior (via
  `tento_env::env_kv!`).
- `TENTO_CORE` — path to the tento-core source tree, used to locate
  bundled scripts (e.g. calculator.py, calculator.ts).
- `TentoCore` — env struct providing `get_calculator_path()` and
  `get_typescript_calculator_path()`.

### Re-exports

- `redactable::{Redactable, Redacted}` — re-exported from `tento_env` for
  backwards compatibility.

### Macros

- `block!(name, block)` / `block!(name, message, block)` — wraps an async
  block in a tracing span.
- `sync_block!(name, block)` / `sync_block!(name, message, block)` —
  wraps a sync block in a tracing span.

### Modules

| Module | Purpose |
| ------ | ------- |
| `app_bundle` | `SemVer` parsing/comparison, `compute_fingerprint`, `get_git_short_hash` — shared by `tento-package`. Also re-exported from `tento-package` for Packager convenience. |
| `container` | Generic container types. |
| `crypto` | SHA-256 hashing helpers. |
| `env` | `Home` type for resolving `~` paths and home-directory lookups. |
| `fs` | File-system utilities including `path_iter` for recursive directory walking. |
| `globals` | Global application state. |
| `index` | Index-based data structures. |
| `lazy` | Lazy initialization with `first-arm-wins` deadline semantics and labeled arm sites. |
| `math` | Mathematical helpers. |
| `path_buf` | `PathBuf` utilities. |
| `range` | Range types. |
| `rate_limiter` | Rate-limiting primitives. |
| `request` | HTTP request helpers (actix-web / awc based). |
| `result` | Result type aliases and error helpers. |
| `serde` | Serialization helpers. |
| `subprocess` | Language-runtime subprocess management: Python/Typescript RPC servers (`calculator`), message passing, test harnesses. |
| `sync` | Async synchronization primitives: `sync_range`, `sync_handle_store`. |
| `term` | Terminal utilities. |
| `validate` | Input validation (`scary_user_string`). |

## Boundaries

This crate should stay small and dependency-light in spirit, but it has
grown beyond the original scope. It is not the place for provider clients,
deployment logic, or application state. Shared helpers belong here only
when multiple Tento command surfaces or services need the same runtime
behavior.

If a helper needs domain concepts, prefer a domain crate such as a
provider SDK, `tento-fleet`, or `tento-cloudflare`.
