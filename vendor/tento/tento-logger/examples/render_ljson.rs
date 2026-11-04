//! Simple LJSON renderer example
//!
//! This example reads LJSON log files and renders them using the library's
//! terminal renderer — the same output you see from the live logger.
//!
//! Usage:
//!   cargo run -p tento-logger --example render_ljson -- examples/fixtures/requests.ljson
//!   cat loaf.ljson | cargo run -p tento-logger --example render_ljson
//!   cargo run -p tento-logger --example render_ljson -- --level warn loaf.ljson

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};

use tento_logger::ljson::{LjsonEntry, LjsonLevel};
use tento_logger::render::render_entry;
use tento_logger::render::terminal::ColumnVisibility;

fn level_value(level: &LjsonLevel) -> u8 {
  match level {
    LjsonLevel::Trace => 0,
    LjsonLevel::Debug => 1,
    LjsonLevel::Info => 2,
    LjsonLevel::Warn => 3,
    LjsonLevel::Error => 4,
  }
}

fn parse_level(s: &str) -> u8 {
  match s.to_lowercase().as_str() {
    "trace" => 0,
    "debug" => 1,
    "info" => 2,
    "warn" => 3,
    "error" => 4,
    _ => 0,
  }
}

fn main() -> io::Result<()> {
  let args: Vec<String> = env::args().collect();

  let mut min_level_value: u8 = 0;
  let mut positional_args: Vec<&str> = Vec::new();

  let mut i = 1;
  while i < args.len() {
    if args[i] == "--level" {
      i += 1;
      if i < args.len() {
        min_level_value = parse_level(&args[i]);
      } else {
        eprintln!("--level requires a value (trace|debug|info|warn|error)");
        std::process::exit(1);
      }
    } else {
      positional_args.push(&args[i]);
    }
    i += 1;
  }

  let reader: Box<dyn BufRead> = if let Some(path) = positional_args.first() {
    let file = File::open(path)?;
    Box::new(BufReader::new(file))
  } else {
    Box::new(BufReader::new(io::stdin()))
  };

  let viz = ColumnVisibility::all();
  for line in reader.lines() {
    let line = line?;
    if line.trim().is_empty() {
      continue;
    }

    match serde_json::from_str::<LjsonEntry>(&line) {
      Ok(entry) => {
        if level_value(&entry.root_span.level) >= min_level_value {
          print!("{}", render_entry(&entry, &viz));
        }
      }
      Err(e) => eprintln!("\x1b[31mFailed to parse line: {e}\x1b[0m"),
    }
  }

  Ok(())
}
