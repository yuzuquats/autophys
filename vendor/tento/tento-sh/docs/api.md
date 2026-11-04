# Library API

> **Status:** shipped. Everything here is in `mono/tento/tento-sh/src/`.

The public surface is small and product-agnostic (subgoal 1). You build a shell
out of three types and one macro.

## The three load-bearing types (`src/shell.rs`)

| Type | What it is |
|---|---|
| `Shell<Info>` | The CLI/REPL host. You add commands and subcommand groups, then `.run()`. `Info` is your per-session context (auth backend, clients, etc.) handed to every command. |
| `Scripts<Info>` | A mountable command set: `info`, a `CommandList<Info>`, and nested subcommands keyed by namespace. A group's `scripts() -> Scripts<Info>` factory is *both* a standalone binary's command set and a library others can mount. |
| `Callable` | The dispatch interface — `call_with_argv(argv) -> Future<Value>` + `print_help` + `help_value`. `Scripts<Info>` implements it; so does `RemoteGroup` (a mounted `*.tsh.app`). Mounting a group = inserting a `Box<dyn Callable>` under a name. |

```rust
pub trait Callable {
  fn call_with_argv(&self, argv: Vec<String>)
    -> crate::Result<Pin<Box<dyn Future<Output = crate::Result<Value>>>>>;
  fn print_help(&self, include_args: bool);
  fn help_value(&self) -> Value { /* default: empty object */ }
}
```

`Callable` returning `serde_json::Value` is the whole reason headless mode and
rich rendering are free: every command's result is structured data. See
[protocol-and-headless.md](./protocol-and-headless.md).

### Gated groups
`Shell::add_gated_subcommand` + `GateOutcome`/`UnavailableGroup` (`shell.rs`) mount
a group only if a precondition holds; an unsatisfied gate mounts a *visible*
placeholder that fails loudly with a reason instead of silently vanishing. The
reason string is computed by the caller, so the core stays env-agnostic.

## Declaring a command — the `#[command]` macro

`#[command]` (in `tento-sh-macros/`) turns an `async fn` into a `CommandMetadata`
impl. The trait (`src/command_metadata.rs`):

```rust
pub trait CommandMetadata<Info> {
  fn name(&self) -> &'static str;
  fn description(&self) -> &'static str;
  fn long_description(&self) -> Option<&'static str>;
  fn confirmation_message(&self) -> Option<&'static str> { None }
  fn call_with_argv(&self, info: Info, argv: Vec<String>)
    -> Result<Pin<Box<dyn Future<Output = Result<Value, Error>>>>, Error>;
  fn help(&self) -> Vec<String>;
}
```

`confirmation_message` lets a mutating command require a y/N prompt before it
runs — the destructive-op guard lives in the dispatch layer, not each command.

## Parsing arguments — `CommandArg`

Args follow the **`--key value` mysh convention**, never positionals. You derive
`CommandArg` (+ `serde::Deserialize`) on a struct; the macro generates the
`--key value` → struct parse and the `help()` option list. `()` implements
`CommandArg` for commands that take no args.

## Worked example

```rust
use tento_sh::{command, CommandArg, Shell};
use serde::Deserialize;

#[derive(CommandArg, Deserialize, Clone)]
pub struct Args { name: String }

#[derive(Clone)]
pub struct UserInfo {}

#[command(name = "hello", description = "Prints hello world")]
pub async fn hello(_: UserInfo, args: Args) -> tento_sh::Result<()> {
  println!("Hello {}", args.name);
  Ok(())
}

#[actix_rt::main]
async fn main() {
  Shell::new(UserInfo {}).add_command(hello).run().await;
}
```

```
$ cargo run -- hello --name World      # one-shot CLI
Hello World
$ cargo run                            # REPL
>> hello --name World
Hello World
```

A command that returns a `serde_json::Value` (or a typed `Serialize` value)
instead of printing gets rich rendering for free — see
[authoring-a-group.md](./authoring-a-group.md).

## Where each symbol lives

| Symbol | Module |
|---|---|
| `Shell`, `Scripts`, `Callable`, `GateOutcome`, `UnavailableGroup` | `src/shell.rs` |
| `CommandMetadata`, `print_command_help` | `src/command_metadata.rs` |
| `CommandArg` | `src/command_arg.rs` |
| `#[command]`, `#[derive(CommandArg)]` | `tento-sh-macros/` |
| `exec`, `nearest_command`, `--tsh` handling | `src/run_loop.rs` |
| `RemoteGroup` (mount a `*.tsh.app`) | `src/remote_group.rs` |
| bundle resolve + oneshot spawn | `src/tsh_app.rs` |
| `.tsh` interpreter | `src/script/` |
