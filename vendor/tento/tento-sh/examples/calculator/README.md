# calculator

A minimal `tento-sh` example: a REPL with binary arithmetic, a couple of
unary commands, and a `mem …` subcommand namespace that mutates a
`Rc<RefCell<HashMap>>` shared between commands.

## Run

```bash
cd tento/tento-sh/examples/calculator
cargo run                       # interactive REPL (state persists across commands)
cargo run -- pi                 # one-shot CLI form
cargo run -- add "1 2"          # binary op (two whitespace-separated numbers)
cargo run -- mem set "foo 42"   # subcommand call
```

## Commands

| Command       | Form                | Example          | Result          |
|---------------|---------------------|------------------|-----------------|
| `pi`          | nullary             | `pi`             | `3.14159…`      |
| `sqrt`        | single positional   | `sqrt 144`       | `12`            |
| `add`         | `"a b"` pair        | `add "1 2"`      | `3`             |
| `sub`         | `"a b"` pair        | `sub "10 3"`     | `7`             |
| `mul`         | `"a b"` pair        | `mul "6 7"`      | `42`            |
| `div`         | `"a b"` pair        | `div "22 7"`     | `3.142857…`     |
| `pow`         | `"base exp"` pair   | `pow "2 10"`     | `1024`          |
| `mem set`     | `"name value"` pair | `mem set "x 5"`  | stored          |
| `mem get`     | single positional   | `mem get x`      | `5`             |
| `mem list`    | nullary             | `mem list`       | dump            |
| `mem clear`   | nullary             | `mem clear`      | dump count      |

Every arithmetic command also stores its result under `ans`:

```
> mul "6 7"
42
> mem get ans
42
```

## Why a string pair instead of `--a 1 --b 2`?

`tento-sh`'s arg parser deserializes `--key value …` argv into a struct via
`serde_json`. Coercing integer JSON literals into `f64` struct fields hits a
serde edge case (`Number(i64)` → `f64` fails depending on serde features), so
this example sidesteps it by taking a single positional `String` and parsing
it inside the command. Single positionals and nullary commands work
directly with the macro path.
