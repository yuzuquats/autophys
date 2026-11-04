//! Render all LJSON fixture files using the library renderer.
//!
//! Usage:
//!   cargo run --example render_fixtures -p tento-logger

use tento_logger::ljson::LjsonEntry;
use tento_logger::render::terminal::{ColumnVisibility, render_entry, render_unified};

fn main() {
  let viz = ColumnVisibility::all();
  let fixtures_dir = format!("{}/examples/fixtures", env!("CARGO_MANIFEST_DIR"));

  let mut ljson_files: Vec<_> = std::fs::read_dir(&fixtures_dir)
    .expect("fixtures dir not found")
    .filter_map(|e| e.ok())
    .filter(|e| e.path().extension().map_or(false, |ext| ext == "ljson"))
    .collect();

  ljson_files.sort_by_key(|e| e.file_name());

  for file in ljson_files {
    let name = file.file_name();
    let name_str = name.to_string_lossy();
    eprintln!("\n\x1b[1m═══ {name_str} ═══\x1b[0m\n");

    let content = std::fs::read_to_string(file.path()).unwrap();

    if name_str.starts_with("unified_") {
      // Unified fixtures use client-server grafting
      let entries: Vec<LjsonEntry> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| match serde_json::from_str(l) {
          Ok(entry) => Some(entry),
          Err(e) => {
            eprintln!("  \x1b[31mParse error: {e}\x1b[0m");
            None
          }
        })
        .collect();
      print!("{}", render_unified(&entries, &viz));
    } else {
      for line in content.lines() {
        if line.trim().is_empty() {
          continue;
        }
        match serde_json::from_str::<LjsonEntry>(line) {
          Ok(entry) => print!("{}", render_entry(&entry, &viz)),
          Err(e) => eprintln!("  \x1b[31mParse error: {e}\x1b[0m"),
        }
      }
    }
  }
}
