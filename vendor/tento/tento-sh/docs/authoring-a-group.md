# Authoring a command group

> **Status:** shipped (oneshot transport). The mechanical packager is the next
> milestone — see the external
> [`authoring-guide`](../../../../tento-shell.project.docs/content/authoring-guide.md)
> and [`manifest-and-registry`](../../../../tento-shell.project.docs/content/manifest-and-registry.md).

A **command group** is an ordinary binary that exposes a `Scripts<Info>`. The key
property (the north star): *the standalone binary IS the plugin* — the same
factory is both the binary's command set and a library the `tsh` core can mount.
No second artifact, no `dlopen`.

## 1. Write the factory

```rust
pub fn scripts(backend: Arc<dyn Backend<Client>>) -> Scripts<Info> {
  Scripts::new(Info { backend })
    .add_command(user_profile)
    .add_command(sleep)
}
```

The factory is what both `main` (`Shell::new(...).add_*` then `.run()`) and a
mounting host (`shell.add_subcommand("whoop", whoop::scripts(backend))`) call.

## 2. Return data, not just text

A command may `println!` (fine for legacy), but **returning a value** is what
earns rich rendering and headless output. Return either raw data or a **versioned
render shape** (`table/v1`, `tree/v1`):

```json
{
  "shape": "table/v1",
  "title": "Recent activities",
  "columns": [{ "header": "Date" }, { "header": "Distance", "align": "right" }],
  "rows": [["2026-05-01", "12.4km"], ["2026-05-02", "8.0km"]]
}
```

The same returned value renders as an aligned ANSI table for a human and as raw
JSON under `--tsh`. The shape vocabulary and where it's serialized are documented
in [protocol-and-headless.md](./protocol-and-headless.md). Build shapes by
serializing a struct / `serde_json::Value` — never hand-format JSON strings.

## 3. Args are `--key value`

Derive `CommandArg` + `Deserialize` on an args struct (see [api.md](./api.md)).
No positionals — keep to the convention so every group dispatches uniformly,
whether called directly, mounted, or from a `.tsh` script.

## 4. Speak `--tsh` and `__manifest`

To be mountable as a bundle a group must:
- accept `--tsh` (machine output — handled for you by `run_loop`), and
- describe its command tree on request (`Callable::help_value()` already emits the
  tree; the packager turns it into a `manifest.json`).

`RemoteGroup` (`src/remote_group.rs`) mounts a resolved bundle by spawning
`<bin> <command> --tsh [args]`, capturing stdout as JSON, and returning the
`Value` — byte-identical to calling the standalone.

## 5. Package as a `*.tsh.app`

```
<name>.tsh.app/
  manifest.json     # command tree + transport + version
  bin/<name>        # the group binary
  ui/<name>.tsh     # optional UI: modes, keybindings, scenes (F11 — inert until activated)
  VERSION
```

Bundles are resolved on a `PATH`-like `$TSH_APP_PATH` (pure file reads; no
spawning during discovery — `src/tsh_app.rs`). Install a group =
`(@import "<name>" :as "<ns>")` in a `.tsh` rc; see
[script-layer.md](./script-layer.md). The `ui/<name>.tsh` is where a group ships
a coding-harness mode — see [coding-harness.md](./coding-harness.md).

## Bundle-readiness checklist

For a standalone bin to package cleanly as a `.tsh.app` (proven on whoop, garmin,
kol):

- **`__manifest` must not need live state.** The packager runs `bin __manifest
  --tsh` to read the spec; that path must work with **no creds / no env**. If
  `main` does `from_env_root().assert_envars()` (panics on missing config), gate
  it: take the tolerant `from_env_root().into_result().ok()` path for the
  `__manifest` invocation and keep the strict path for real runs. (See
  `tento-garmin/src/main.rs`'s `manifest` branch; `tento-whoop` is tolerant
  throughout; `tento-kol` emits its **daemon RPC surface** via a `__manifest`
  branch.) Optional-cred config (`credentials() -> Option<…>`) makes this easy.
- **Env-only config**, injected via `tento_env` — no compile-time dep on `./run`
  / `lona-console` app structs.
- **Commands must `return` a serde `Value`, never `println!` the result.** The
  `--tsh` channel is JSON-on-stdout; a stray `print!`/`.print()` corrupts it
  ("trailing characters" parse errors). A human-formatted command returns its
  text as `Value::String(formatted)` (or a structured value / `table/v1`); the
  shell renders it. (`tento-tz`'s `rules`/`transitions` were `println!` commands
  that had to return values.)
- **The `[[bin]]` target name must equal the crate name** — the packager copies
  `target/<profile>/<crate_name>`. A bin named `cli` (e.g. old `tento-tz`) won't
  be found; rename it to the crate name.
- **Feature-gated bins** (`required-features = ["bin"]`): package with
  `tsh-package build … --features bin` so the real binary builds (rarely-built
  bins also tend to bit-rot — keep their `main` compiling).
- **Daemon groups** additionally declare `Scripts::daemon(socket, start)` so
  `__manifest` carries the connection block; the bundle's socket is resolved from
  the group's own env at package time (`tento-kol`).
- **Streaming groups** declare `Scripts::streaming()`. The oneshot transport
  *captures* the bundle's stdout to parse it as the `--tsh` JSON channel, so a
  command that **spawns a subprocess and streams its output** (a test runner, a
  build — `tento-ts` wrapping `deno`/`tsc`) can't use it: the child's output would
  corrupt the JSON, and even on stderr it'd only surface buffered at the end. The
  streaming transport instead spawns `bin <cmd> …` with the terminal's stdio
  **inherited** (no `--tsh`, no capture) so output streams live; the command's
  result is its exit status, not a returned `Value` (commands return
  `tento_sh::Result<()>` and may log/print freely). The standalone binary is
  unchanged — only the tsh client's dispatch differs. (`__manifest` itself is
  still captured as JSON by the packager, so packaging a streaming group works
  exactly as any other.)

## Bound groups (auth without a daemon)

A group can be mounted *bound* to a backend so it shares one login: `lona.user`
and `lona.user.whoop` delegate auth to a `Backend<C>` the host injects, reading a
single-writer session file. The pattern is the external
[`bound-groups`](../../../../tento-shell.project.docs/content/bound-groups.md) /
[`auth-delegation`](../../../../tento-shell.project.docs/content/auth-delegation.md)
docs — generalized from `lona-console`'s `console.tsh` auto-login.
