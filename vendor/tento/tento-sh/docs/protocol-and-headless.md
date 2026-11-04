# Protocol & first-class headless mode

> **Status:** shipped (`--tsh` + `table/v1`). Full protocol:
> [`protocol-spec`](../../../../tento-shell.project.docs/content/protocol-spec.md).

Subgoals 2 & 3. The same binary serves a human and a machine from one code path —
the difference is **output formatting only**, never input syntax.

## The `--tsh` modal toggle (`src/run_loop.rs`)

In one-shot CLI dispatch (`run_once_or_loop`), `--tsh` is detected and **stripped
from argv before the command sees it**, then steers the output:

```rust
let tsh_output = argv.iter().any(|a| a == "--tsh");
argv.retain(|a| a != "--tsh");
// … exec …
if tsh_output {
  println!("{}", serde_json::to_string(&value)?);   // machine: raw JSON / render shape
} else if let Some(text) = cli_table_text(&value) {
  println!("{text}");                                // human: aligned ANSI
}
```

So:

```
$ ./tento-whoop user-profile          # human — rendered table
$ ./tento-whoop user-profile --tsh    # machine — {"shape":"table/v1", …}
```

Input is identical in both modes; only the rendering differs. This is what makes
headless a **first-class** mode rather than a bolt-on: every command is already a
function `argv → Value`, and `--tsh` just declines to render.

## Why mounting works because of this

`RemoteGroup` (`src/remote_group.rs`) mounts a bundle by spawning
`<bin> <command> --tsh [args]` and parsing stdout as JSON. The mounting host then
renders that `Value` itself (text for humans, JSON if the host was itself called
with `--tsh`). One protocol, composed at every level.

## Render shapes (versioned, opt-in)

A command returns either raw data or a tagged shape. Two ship today:

| Shape | Payload | Human renderer | TUI renderer |
|---|---|---|---|
| `table/v1` | `{ columns, rows, title? }` | `cli_table_text` | inline responsive table |
| `tree/v1` | `{ title, status, attrs, blurb, children }` | tree text | `TreeRenderer` |

Shapes are *versioned* (`shape/v1`) so the protocol can evolve without breaking
mounted groups. Returning a shape is opt-in; raw JSON still renders generically.

## Headless all the way down

Because `--tsh` is the wire format and `Value` is the universal result type, any
consumer — CI, another shell, **an LLM agent** — drives a group with zero
divergence from the interactive path. That property is exactly what subgoal 4
(file-backed TUI, [tui-host.md](./tui-host.md)) and subgoal 5 (the coding harness,
[coding-harness.md](./coding-harness.md)) build on: the harness binary speaks
`--tsh`, so the same loop serves the TUI and a headless driver.
