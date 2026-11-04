//! Convert LJSON log files to Parquet format.
//!
//! Usage:
//!   cargo run -p tento-logger --features parquet --example logs_to_parquet -- \
//!     --input __logs/loaf.ljson container_data/tento-llm-logger/*/logs.ljson \
//!     --output __logs/all.parquet
//!
//! Query the output with DuckDB:
//!   duckdb -c "SELECT name, level, COUNT(*) FROM '__logs/all.parquet' WHERE depth = 0 GROUP BY 1, 2 ORDER BY 3 DESC"

use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use tento_logger::ljson::LjsonEntry;
use tento_logger::parquet::LjsonParquetWriter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let args: Vec<String> = env::args().collect();

  if args.len() < 4
    || !args.contains(&"--input".to_string())
    || !args.contains(&"--output".to_string())
  {
    eprintln!(
      "Usage: {} --input <file.ljson>... --output <output.parquet>",
      args[0]
    );
    eprintln!();
    eprintln!("Convert LJSON log files to Parquet format for analytical queries.");
    eprintln!();
    eprintln!("Options:");
    eprintln!(
      "  --input <files>   One or more LJSON files to convert (supports glob patterns via shell)"
    );
    eprintln!("  --output <file>   Output Parquet file path");
    eprintln!();
    eprintln!("Example:");
    eprintln!(
      "  {} --input __logs/loaf.ljson container_data/*/logs.ljson --output all.parquet",
      args[0]
    );
    std::process::exit(1);
  }

  // Parse arguments
  let mut input_files: Vec<PathBuf> = Vec::new();
  let mut output_file: Option<PathBuf> = None;
  let mut mode = "";

  for arg in &args[1..] {
    match arg.as_str() {
      "--input" => mode = "input",
      "--output" => mode = "output",
      _ => match mode {
        "input" => {
          let path = PathBuf::from(arg);
          if path.exists() {
            input_files.push(path);
          } else {
            eprintln!("Warning: skipping non-existent file: {}", arg);
          }
        }
        "output" => {
          output_file = Some(PathBuf::from(arg));
          mode = "";
        }
        _ => {}
      },
    }
  }

  let Some(output) = output_file else {
    eprintln!("Error: --output is required");
    std::process::exit(1);
  };

  if input_files.is_empty() {
    eprintln!("Error: no input files found");
    std::process::exit(1);
  }

  eprintln!(
    "Converting {} files to {}",
    input_files.len(),
    output.display()
  );

  let mut writer = LjsonParquetWriter::new(&output)?;
  let mut total_entries = 0;
  let mut total_errors = 0;

  for input_path in &input_files {
    eprintln!("  Processing: {}", input_path.display());

    let file = File::open(input_path)?;
    let reader = BufReader::new(file);

    for (line_num, line) in reader.lines().enumerate() {
      let line = line?;
      if line.trim().is_empty() {
        continue;
      }

      match serde_json::from_str::<LjsonEntry>(&line) {
        Ok(entry) => {
          writer.write_entry(&entry)?;
          total_entries += 1;
        }
        Err(e) => {
          eprintln!(
            "    Warning: failed to parse line {} in {}: {}",
            line_num + 1,
            input_path.display(),
            e
          );
          total_errors += 1;
        }
      }
    }
  }

  writer.finish()?;

  eprintln!();
  eprintln!("Done:");
  eprintln!("  Entries converted: {}", total_entries);
  if total_errors > 0 {
    eprintln!("  Parse errors: {}", total_errors);
  }
  eprintln!("  Output: {}", output.display());

  Ok(())
}
