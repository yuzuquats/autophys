# The `.tsh` script layer

> **Status:** shipped. Implemented in `mono/tento/tento-sh/src/script/`
> (`parser.rs`, `interp.rs`, `runner.rs`, `value.rs`).

Subgoal 2: **product logic is written in `.tsh`**, not recompiled into the core.
A `.tsh` file is a sequence of lines; each line is classified, then executed.
Group imports, login, layout, keymaps, and harness modes are all `.tsh`.

## Line kinds (`src/script/parser.rs`, `LineKind`)

`classify(raw)` maps each line to one of:

| Kind | Syntax | Meaning |
|---|---|---|
| `Blank` / `Comment` | empty / `# …` | ignored |
| `LispStmt` | `> EXPR` or a bare `(…)` line | evaluate a top-level Lisp form for its effect (e.g. `(@import …)`) |
| `LispDef` | `> (let NAME RHS)` | bind `NAME` in the Lisp env; persists across lines |
| `WhenGuard` | `(when COND) BODY` | run `BODY` only if `COND` is truthy (same-line guard) |
| `NamedBind` | `name <- cmd args…` | run the command, capture its JSON result as `name` |
| `Plain` | `cmd args…` | run a command; its result becomes `prev` |

A bare `(…)` line auto-classifies as Lisp so reserved forms like `(@import "x")`
parse naturally; `(when …)` is special-cased first so its guard semantics win.

## Interpolation, `prev`, and binds (`src/script/runner.rs`, `interp.rs`)

- `$(expr)` interpolates into a command line. The resolver checks **bind table →
  Lisp env → Lisp eval**, in that order.
- `prev` is the implicit last command result (a JSON `Value`). It is overwritten
  every `Plain` line.
- `name <- …` captures into a **named bind** that outlives `prev`.
- Dotted paths index into JSON: `prev.id`, `sheet.id`, `array.0`, `array.count`,
  `string.count`.

```bash
# named binds outlive `prev`
sheet <- create --name first
create --name second
link --parent $(sheet.id) --label x

# lisp let + interpolation
> (let label (concat "row-" "x"))
create --name $(label)

# same-line guard
(when (> $(prev.count) 5)) delete
```

(See the fixtures at `mono/tento/tento-sh/tests/fixtures/tsh/`.)

## `@import` — installing a group (`src/script/interp.rs`)

`@import` is the link-phase form that mounts a `*.tsh.app` bundle as a namespace.
Namespace is required via `:as`:

```lisp
(@import "tento-whoop" :as "whoop")     ; now `whoop.user-profile` dispatches
(@import "tento-garmin" :as "garmin" {:auth "lona-user"})   ; config map
```

At link time the bundle is *resolved* (pure file reads — no spawning); at run
time each call spawns the bundle binary with `--tsh`. Importing 50 groups stays
idle until you *use* one. Worked examples:
[`import-and-codeflow`](../../../../tento-shell.project.docs/content/import-and-codeflow.md).

## How a script is run

`Shell::run_with_startup` runs a startup `.tsh` (e.g. `console.tsh` auto-login)
before the loop. `tsh path/to/script.tsh` runs a file; `run_loop` also supports a
nested form (`<bin> sub1 [sub2 …] script.tsh`) that prepends a prefix to every
line. The `LispHost` (`interp.rs`) carries the Lisp env and the recursive
JSON↔Lisp bridge across all lines. This same Lisp layer is where composer
**modes** are defined — see [coding-harness.md](./coding-harness.md).
