//! Arrow schema definition for LJSON log entries.

use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema, TimeUnit};

/// Get the Arrow schema for flattened LJSON entries.
pub fn parquet_schema() -> Schema {
  Schema::new(vec![
    // Entry-level fields
    Field::new("entry_id", DataType::Utf8, false),
    Field::new(
      "entry_ts",
      DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into())),
      false,
    ),
    Field::new("session_id", DataType::Utf8, false),
    // Node identification
    Field::new("node_type", DataType::Utf8, false), // "span" | "event"
    Field::new("span_id", DataType::UInt64, true),  // null for events
    Field::new("parent_id", DataType::UInt64, true), // null for root
    Field::new("depth", DataType::UInt8, false),
    Field::new("sibling_index", DataType::UInt16, false),
    // Core fields
    Field::new("name", DataType::Utf8, false),
    Field::new("level", DataType::Utf8, false), // trace/debug/info/warn/error
    Field::new("duration_ms", DataType::UInt64, true), // null for events and client logs
    Field::new("message", DataType::Utf8, true),
    Field::new("file", DataType::Utf8, true),
    Field::new("line", DataType::UInt32, true),
    // HTTP attributes (extracted for fast queries)
    Field::new("http_method", DataType::Utf8, true),
    Field::new("http_target", DataType::Utf8, true),
    Field::new("http_status", DataType::UInt16, true),
    Field::new("http_host", DataType::Utf8, true),
    // User attributes
    Field::new("user_email", DataType::Utf8, true),
    Field::new("user_ip", DataType::Utf8, true),
    // Client log attributes
    Field::new("log_type", DataType::Utf8, true),
    Field::new("fingerprint", DataType::Utf8, true),
    // Catch-all for remaining attributes
    Field::new("attributes_json", DataType::Utf8, true),
    // Entry origin: "client" or null (null = server, for backwards compat)
    Field::new("origin", DataType::Utf8, true),
  ])
}

/// Lazy static schema reference.
pub static PARQUET_SCHEMA: std::sync::LazyLock<Arc<Schema>> =
  std::sync::LazyLock::new(|| Arc::new(parquet_schema()));

/// A flattened row representing a span or event.
#[derive(Debug, Clone)]
pub struct FlattenedRow {
  // Entry-level
  pub entry_id: String,
  pub entry_ts_ms: i64,
  pub session_id: String,
  pub origin: Option<String>,

  // Node identification
  pub node_type: String,
  pub span_id: Option<u64>,
  pub parent_id: Option<u64>,
  pub depth: u8,
  pub sibling_index: u16,

  // Core fields
  pub name: String,
  pub level: String,
  pub duration_ms: Option<u64>,
  pub message: Option<String>,
  pub file: Option<String>,
  pub line: Option<u32>,

  // HTTP attributes
  pub http_method: Option<String>,
  pub http_target: Option<String>,
  pub http_status: Option<u16>,
  pub http_host: Option<String>,

  // User attributes
  pub user_email: Option<String>,
  pub user_ip: Option<String>,

  // Client log attributes
  pub log_type: Option<String>,
  pub fingerprint: Option<String>,

  // Catch-all
  pub attributes_json: Option<String>,
}

impl FlattenedRow {
  pub fn new_span(
    entry_id: String,
    entry_ts_ms: i64,
    session_id: String,
    span_id: u64,
    parent_id: Option<u64>,
    depth: u8,
    sibling_index: u16,
  ) -> Self {
    Self {
      entry_id,
      entry_ts_ms,
      session_id,
      origin: None,
      node_type: "span".to_string(),
      span_id: Some(span_id),
      parent_id,
      depth,
      sibling_index,
      name: String::new(),
      level: String::new(),
      duration_ms: None,
      message: None,
      file: None,
      line: None,
      http_method: None,
      http_target: None,
      http_status: None,
      http_host: None,
      user_email: None,
      user_ip: None,
      log_type: None,
      fingerprint: None,
      attributes_json: None,
    }
  }

  pub fn new_event(
    entry_id: String,
    entry_ts_ms: i64,
    session_id: String,
    parent_id: u64,
    depth: u8,
    sibling_index: u16,
  ) -> Self {
    Self {
      entry_id,
      entry_ts_ms,
      session_id,
      origin: None,
      node_type: "event".to_string(),
      span_id: None,
      parent_id: Some(parent_id),
      depth,
      sibling_index,
      name: String::new(),
      level: String::new(),
      duration_ms: None,
      message: None,
      file: None,
      line: None,
      http_method: None,
      http_target: None,
      http_status: None,
      http_host: None,
      user_email: None,
      user_ip: None,
      log_type: None,
      fingerprint: None,
      attributes_json: None,
    }
  }
}
