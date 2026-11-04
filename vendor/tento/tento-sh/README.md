# tento-sh

`tento-sh`, short for "Tento Shell", is a Rust library for quickly building
small interactive shells. It's the scaffolding behind the `tento-*` shell
binaries (`tento-linear`, `tento-iata`, `tento-monarch`, `tento-whoop`,
`tento-weather`, `tento-stripe`, `tento-deploy`, `tento-ai`,
`tento-cloudflare`, `tento-garmin`, `tento-core`, `tento-tz`,
`tento-event-classifier`) and the top-level `scripts/` crate.

> **Full library guide:** see [`docs/`](./docs/README.md) — the public API, the
> `.tsh` script layer, the `--tsh` protocol + headless mode, the file-backed TUI
> host, and the spec for driving a DeepSeek coding harness from inside the shell
> via `(mode.toggle "deepseek")`.

## Usage

```toml
[dependencies]
tento-sh.workspace = true
futures = "0.3"
```

```rust
use tento_sh::{command, CommandArg};
use serde::Deserialize;

#[derive(CommandArg, Deserialize, Clone)]
pub struct Args {
  name: String,
}

#[command(
  name = "hello",
  description = "Prints hello world",
  long_description = "Prints hello world" // optional
)]
pub async fn hello(_: UserInfo, args: Args) -> tento_sh::Result<()> {
  println!("Hello {}", args.name);
  Ok(())
}
```

```rust
use tento_sh::Shell;
use tokio;

#[derive(Clone)]
pub struct UserInfo {}

// #[tokio::main] // or
#[actix_rt::main]
async fn main() {
  Shell::new(UserInfo {})
    .add_command(hello)
    .run()
    .await;
}
```

### Trigger read-eval-print-loop

```bash
cargo run

>> hello --name World
Hello World
```

### Run single command

```bash
cargo run -- hello --name World
Hello World
```

## Run Examples

```bash
cargo run -p simple
```
