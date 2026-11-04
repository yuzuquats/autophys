//! `mem …` subcommands — manipulate the shared named-value map.

use tento_sh::{Error, command};

use crate::MemCtx;

#[command(name = "set", description = "Store a value: mem set \"foo 42\"")]
pub async fn set(ctx: MemCtx, pair: String) -> tento_sh::Result<()> {
  let mut parts = pair.split_whitespace();
  let name = parts
    .next()
    .ok_or_else(|| Error::Other(anyhow::anyhow!("mem set: missing name")))?;
  let value: f64 = parts
    .next()
    .ok_or_else(|| Error::Other(anyhow::anyhow!("mem set: missing value")))?
    .parse()
    .map_err(|e| Error::Other(anyhow::anyhow!("mem set: bad value: {e}")))?;
  ctx.memory.borrow_mut().insert(name.to_string(), value);
  println!("{name} = {value}");
  Ok(())
}

#[command(name = "get", description = "Recall a stored value: mem get foo")]
pub async fn get(ctx: MemCtx, name: String) -> tento_sh::Result<()> {
  match ctx.memory.borrow().get(&name) {
    Some(v) => {
      println!("{v}");
      Ok(())
    }
    None => Err(Error::Other(anyhow::anyhow!("no value stored under {}", name))),
  }
}

#[command(name = "list", description = "List all stored values")]
pub async fn list(ctx: MemCtx, _: Option<()>) -> tento_sh::Result<()> {
  let mem = ctx.memory.borrow();
  if mem.is_empty() {
    println!("(empty)");
    return Ok(());
  }
  for (name, value) in mem.iter() {
    println!("{name} = {value}");
  }
  Ok(())
}

#[command(name = "clear", description = "Drop every stored value")]
pub async fn clear(ctx: MemCtx, _: Option<()>) -> tento_sh::Result<()> {
  let count = ctx.memory.borrow().len();
  ctx.memory.borrow_mut().clear();
  println!("cleared {count} value(s)");
  Ok(())
}
