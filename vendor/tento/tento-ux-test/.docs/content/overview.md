# tento-ux-test

`tento-ux-test` stores UX-test and LLM-assisted verification sessions
as filesystem data, absorbs the former `tento-llm-logger` crate, and
hosts the `ux-test` CLI subcommand group including trace rendering.

## Public surface

### Session model (back-compat re-exports from `session`)
- `LLMLogger::new(base_dir)` creates a logger rooted at a session directory.
- `Session`, `SessionStatus`, `SessionResult`, and `SessionCompletion` define
  the session file contract.
- `SessionParam` declares display-only parameters for UX test overlays.
- `TestSpec` and `TestStep` describe scripted test instructions.
- Logger methods list pending sessions, append LJSON entries, and record
  completion state.

### Orchestration
- `UxTestActions` trait — host-implemented actions the test orchestrator
  can invoke (screen capture, browser navigation, etc.).
- `UxTestCtx` — orchestration context bundling actions + environment.
- `UxTestEnv` — typed environment config for test runs.

### Rendering & CLI
- `render` module — table/v1 renderer for `ux-test ls` inline tables,
  log-line field-tree fidelity, and TUI multi-line stdout.
- `scripts` module — `ux-test` subcommand group entry points.

## Boundaries

The crate owns session persistence, test orchestration, and CLI rendering.
It should not know how a browser executes a test, how screenshots are
captured, or how Lona routes are rendered — those live behind the
`UxTestActions` trait on the host side.

Readers must tolerate malformed or partially written session files, because
test sessions can be interrupted. Keep that resilience inside this crate so
callers can treat the logger as a queue-like API.

