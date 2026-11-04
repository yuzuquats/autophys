//! `calculator` — a small interactive REPL showcasing `tento-sh`.
//!
//! Commands:
//!   add 1 2 3            → 6
//!   sub 10 3             → 7
//!   mul 2 3 4            → 24
//!   div 22 7             → 3.142857…
//!   pow 2 10             → 1024
//!   sqrt 144             → 12
//!   pi                   → 3.141592…
//!   mem set ans 42       → stores 42 under "ans"
//!   mem get ans          → 42
//!   mem list             → ans=42 …
//!
//! The shared calculator memory is a `RefCell<BTreeMap>` carried on the
//! context struct, which `tento-sh` clones into each command call.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use tento_sh::Scripts;

mod commands;

/// The shared state every command sees. `Calc` is `Clone` so `tento-sh` can
/// pass it into each command; the inner `RefCell` holds the live values.
#[derive(Clone, Default)]
pub struct Calc {
  pub memory: Rc<RefCell<BTreeMap<String, f64>>>,
}

/// Subcommand context for `mem …`. Same shared map — the nested namespace just
/// lets us group related verbs under one prefix.
#[derive(Clone)]
pub struct MemCtx {
  pub memory: Rc<RefCell<BTreeMap<String, f64>>>,
}

#[tokio::main]
async fn main() {
  let calc = Calc::default();
  let mem_ctx = MemCtx {
    memory: calc.memory.clone(),
  };
  Scripts::new(calc)
    .add_command(commands::add::add)
    .add_command(commands::sub::sub)
    .add_command(commands::mul::mul)
    .add_command(commands::div::div)
    .add_command(commands::pow::pow)
    .add_command(commands::sqrt::sqrt)
    .add_command(commands::pi::pi)
    .add_subcommand(
      "mem",
      Scripts::new(mem_ctx)
        .add_command(commands::mem::set)
        .add_command(commands::mem::get)
        .add_command(commands::mem::list)
        .add_command(commands::mem::clear),
    )
    .run()
    .await;
}
