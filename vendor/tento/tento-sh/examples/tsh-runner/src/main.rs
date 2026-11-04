//! Example showing how to run `.tsh` scripts against a `tento-sh`
//! `Shell`. Defines a tiny in-memory store with `create-sheet`,
//! `add-row`, and `set-cell` commands; the bundled scripts under
//! `scripts/` exercise interpolation, named binds, lisp defs, and
//! `(when ...)` guards.
//!
//! Usage:
//!
//! ```text
//! cargo run -p tsh-runner -- scripts/basic.tsh
//! cargo run -p tsh-runner -- scripts/named-binds.tsh
//! cargo run -p tsh-runner -- scripts/lisp-def.tsh
//! cargo run -p tsh-runner -- scripts/when-guard.tsh
//! cargo run -p tsh-runner -- scripts/named-binds.tsh --dry-run
//! ```
//!
//! Without a `.tsh` file argv it drops into the standard `tento-sh`
//! REPL so you can poke at the same commands interactively.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tento_sh::{CommandArg, Scripts, command};

#[derive(Default, Clone)]
pub struct Store {
  pub inner: Arc<Mutex<StoreInner>>,
}

#[derive(Default)]
pub struct StoreInner {
  pub next_id: u64,
  pub sheets: Vec<Sheet>,
  pub rows: Vec<Row>,
  pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sheet {
  pub id: String,
  pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Row {
  pub id: String,
  pub sheet: String,
  pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cell {
  pub row: String,
  pub col: String,
  pub value: i64,
}

impl Store {
  fn next(&self, prefix: &str) -> String {
    let mut g = self.inner.lock().unwrap();
    g.next_id += 1;
    format!("{}_{}", prefix, g.next_id)
  }
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone)]
pub struct CreateSheetArgs {
  name: String,
}

#[command(name = "create-sheet", description = "create a sheet by name")]
pub async fn create_sheet(
  store: Store,
  args: CreateSheetArgs,
) -> tento_sh::Result<serde_json::Value> {
  let id = store.next("sheet");
  let sheet = Sheet {
    id: id.clone(),
    name: args.name.clone(),
  };
  store.inner.lock().unwrap().sheets.push(sheet.clone());
  println!("created sheet {} ({})", sheet.id, sheet.name);
  Ok(serde_json::to_value(sheet).unwrap())
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone)]
pub struct AddRowArgs {
  sheet: String,
  label: String,
}

#[command(name = "add-row", description = "add a row to a sheet")]
pub async fn add_row(store: Store, args: AddRowArgs) -> tento_sh::Result<serde_json::Value> {
  let id = store.next("row");
  let row = Row {
    id: id.clone(),
    sheet: args.sheet.clone(),
    label: args.label.clone(),
  };
  store.inner.lock().unwrap().rows.push(row.clone());
  println!("added row {} to sheet {}", row.id, row.sheet);
  Ok(serde_json::to_value(row).unwrap())
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone)]
pub struct SetCellArgs {
  row: String,
  col: String,
  value: i64,
}

#[command(name = "set-cell", description = "set a cell value")]
pub async fn set_cell(store: Store, args: SetCellArgs) -> tento_sh::Result<serde_json::Value> {
  let cell = Cell {
    row: args.row.clone(),
    col: args.col.clone(),
    value: args.value,
  };
  store.inner.lock().unwrap().cells.push(cell.clone());
  println!(
    "set {}.{} = {} (count={})",
    cell.row,
    cell.col,
    cell.value,
    store.inner.lock().unwrap().cells.len()
  );
  Ok(serde_json::json!({
    "row": cell.row,
    "col": cell.col,
    "value": cell.value,
    "count": store.inner.lock().unwrap().cells.len(),
  }))
}

#[command(name = "show", description = "dump the in-memory store")]
pub async fn show(store: Store, _: Option<()>) -> tento_sh::Result<serde_json::Value> {
  let g = store.inner.lock().unwrap();
  println!("sheets: {:#?}", g.sheets);
  println!("rows:   {:#?}", g.rows);
  println!("cells:  {:#?}", g.cells);
  Ok(serde_json::json!({
    "sheets": g.sheets.len(),
    "rows": g.rows.len(),
    "cells": g.cells.len(),
  }))
}

#[tokio::main]
async fn main() {
  Scripts::new(Store::default())
    .add_command(create_sheet)
    .add_command(add_row)
    .add_command(set_cell)
    .add_command(show)
    .run()
    .await;
}
