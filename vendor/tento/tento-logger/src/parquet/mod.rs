//! Parquet storage for LJSON log entries.
//!
//! This module provides efficient columnar storage for log data,
//! enabling fast analytical queries across large log datasets.
//!
//! # Design
//!
//! LJSON entries (both server spans and client logs) are flattened to rows:
//! - Each span/event becomes one row
//! - Parent-child relationships preserved via `parent_id` and `depth`
//! - Common attributes extracted as typed columns for fast filtering
//! - Remaining attributes stored as JSON in `attributes_json`
//!
//! # Usage
//!
//! ```ignore
//! use tento_logger::parquet::{LjsonParquetWriter, LjsonParquetReader};
//!
//! // Write LJSON entries to Parquet
//! let mut writer = LjsonParquetWriter::new("logs.parquet")?;
//! for entry in entries {
//!   writer.write_entry(&entry)?;
//! }
//! writer.finish()?;
//!
//! // Query with DuckDB or other tools
//! // SELECT * FROM 'logs.parquet' WHERE level = 'error'
//! ```

mod reader;
mod schema;
mod writer;

pub use reader::LjsonParquetReader;
pub use schema::{FlattenedRow, PARQUET_SCHEMA};
pub use writer::LjsonParquetWriter;
