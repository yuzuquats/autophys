//! Parquet writer for LJSON log entries.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use arrow::array::{
  ArrayRef, StringArray, TimestampMillisecondArray, UInt8Array, UInt16Array, UInt32Array,
  UInt64Array,
};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;

use crate::ljson::{LjsonChild, LjsonEntry, LjsonEvent, LjsonSpan};

use super::schema::{FlattenedRow, PARQUET_SCHEMA};

/// Writer for converting LJSON entries to Parquet format.
pub struct LjsonParquetWriter {
  writer: ArrowWriter<File>,
  buffer: Vec<FlattenedRow>,
  batch_size: usize,
}

impl LjsonParquetWriter {
  /// Create a new Parquet writer.
  pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, ParquetWriteError> {
    let file = File::create(path)?;

    let props = WriterProperties::builder()
      .set_compression(Compression::ZSTD(Default::default()))
      .build();

    let writer = ArrowWriter::try_new(file, PARQUET_SCHEMA.clone(), Some(props))?;

    Ok(Self {
      writer,
      buffer: Vec::new(),
      batch_size: 10_000,
    })
  }

  /// Write an LJSON entry to the Parquet file.
  pub fn write_entry(&mut self, entry: &LjsonEntry) -> Result<(), ParquetWriteError> {
    let entry_id = format!("{}_{}", entry.ts.timestamp_millis(), entry.session_id);
    let entry_ts_ms = entry.ts.timestamp_millis();
    let session_id = entry.session_id.to_string();

    let origin = entry.origin.clone();

    // Flatten the entry into rows
    self.flatten_span(
      &entry.root_span,
      &entry_id,
      entry_ts_ms,
      &session_id,
      origin.as_deref(),
      None, // root has no parent
      0,    // depth 0
      0,    // sibling index 0
    );

    // Flush if buffer is full
    if self.buffer.len() >= self.batch_size {
      self.flush_buffer()?;
    }

    Ok(())
  }

  fn flatten_span(
    &mut self,
    span: &LjsonSpan,
    entry_id: &str,
    entry_ts_ms: i64,
    session_id: &str,
    origin: Option<&str>,
    parent_id: Option<u64>,
    depth: u8,
    sibling_index: u16,
  ) {
    let mut row = FlattenedRow::new_span(
      entry_id.to_string(),
      entry_ts_ms,
      session_id.to_string(),
      span.id,
      parent_id,
      depth,
      sibling_index,
    );

    row.origin = origin.map(String::from);

    // Core fields
    row.name = span.name.clone();
    row.level = format!("{:?}", span.level).to_lowercase();
    row.duration_ms = span.duration_ms.map(|d| d.max(0) as u64);
    row.file = span.location.file.clone();
    row.line = span.location.line;

    // Extract common attributes
    self.extract_attributes(&mut row, &span.attributes);

    self.buffer.push(row);

    // Recursively flatten children
    for (idx, child) in span.children.iter().enumerate() {
      match child {
        LjsonChild::Span(child_span) => {
          self.flatten_span(
            child_span,
            entry_id,
            entry_ts_ms,
            session_id,
            origin,
            Some(span.id),
            depth + 1,
            idx as u16,
          );
        }
        LjsonChild::Event(event) => {
          self.flatten_event(
            event,
            entry_id,
            entry_ts_ms,
            session_id,
            origin,
            span.id,
            depth + 1,
            idx as u16,
          );
        }
      }
    }
  }

  fn flatten_event(
    &mut self,
    event: &LjsonEvent,
    entry_id: &str,
    entry_ts_ms: i64,
    session_id: &str,
    origin: Option<&str>,
    parent_id: u64,
    depth: u8,
    sibling_index: u16,
  ) {
    let mut row = FlattenedRow::new_event(
      entry_id.to_string(),
      entry_ts_ms,
      session_id.to_string(),
      parent_id,
      depth,
      sibling_index,
    );

    row.origin = origin.map(String::from);
    row.name = "event".to_string();
    row.level = format!("{:?}", event.level).to_lowercase();
    row.file = event.location.file.clone();
    row.line = event.location.line;

    self.extract_attributes(&mut row, &event.attributes);

    self.buffer.push(row);
  }

  fn extract_attributes(&self, row: &mut FlattenedRow, attrs: &HashMap<String, serde_json::Value>) {
    // Extract message
    row.message = attrs
      .get("message")
      .or_else(|| attrs.get("summary"))
      .and_then(|v| v.as_str())
      .map(String::from);

    // HTTP attributes
    row.http_method = attrs
      .get("http.method")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.http_target = attrs
      .get("http.target")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.http_status = attrs
      .get("http.status_code")
      .or_else(|| attrs.get("http.status"))
      .and_then(|v| v.as_u64())
      .map(|n| n as u16);
    row.http_host = attrs
      .get("http.host")
      .and_then(|v| v.as_str())
      .map(String::from);

    // User attributes
    row.user_email = attrs
      .get("user.email")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.user_ip = attrs
      .get("user.connecting_ip")
      .or_else(|| attrs.get("http.client_ip"))
      .and_then(|v| v.as_str())
      .map(String::from);

    // Client log attributes
    row.log_type = attrs
      .get("log_type")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.fingerprint = attrs
      .get("fingerprint")
      .and_then(|v| v.as_str())
      .map(String::from);

    // Remaining attributes as JSON
    let mut remaining = attrs.clone();
    for key in [
      "message",
      "summary",
      "http.method",
      "http.target",
      "http.status_code",
      "http.status",
      "http.host",
      "user.email",
      "user.connecting_ip",
      "http.client_ip",
      "log_type",
      "fingerprint",
    ] {
      remaining.remove(key);
    }
    if !remaining.is_empty() {
      row.attributes_json = serde_json::to_string(&remaining).ok();
    }
  }

  fn flush_buffer(&mut self) -> Result<(), ParquetWriteError> {
    if self.buffer.is_empty() {
      return Ok(());
    }

    let batch = self.rows_to_batch(&self.buffer)?;
    self.writer.write(&batch)?;
    self.buffer.clear();

    Ok(())
  }

  fn rows_to_batch(&self, rows: &[FlattenedRow]) -> Result<RecordBatch, ParquetWriteError> {
    // Build arrays for each column
    let entry_id: ArrayRef = Arc::new(StringArray::from(
      rows.iter().map(|r| r.entry_id.as_str()).collect::<Vec<_>>(),
    ));
    let entry_ts: ArrayRef = Arc::new(
      TimestampMillisecondArray::from(rows.iter().map(|r| r.entry_ts_ms).collect::<Vec<_>>())
        .with_timezone("UTC"),
    );
    let session_id: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.session_id.as_str())
        .collect::<Vec<_>>(),
    ));

    let node_type: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.node_type.as_str())
        .collect::<Vec<_>>(),
    ));
    let span_id: ArrayRef = Arc::new(UInt64Array::from(
      rows.iter().map(|r| r.span_id).collect::<Vec<_>>(),
    ));
    let parent_id: ArrayRef = Arc::new(UInt64Array::from(
      rows.iter().map(|r| r.parent_id).collect::<Vec<_>>(),
    ));
    let depth: ArrayRef = Arc::new(UInt8Array::from(
      rows.iter().map(|r| r.depth).collect::<Vec<_>>(),
    ));
    let sibling_index: ArrayRef = Arc::new(UInt16Array::from(
      rows.iter().map(|r| r.sibling_index).collect::<Vec<_>>(),
    ));

    let name: ArrayRef = Arc::new(StringArray::from(
      rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
    ));
    let level: ArrayRef = Arc::new(StringArray::from(
      rows.iter().map(|r| r.level.as_str()).collect::<Vec<_>>(),
    ));
    let duration_ms: ArrayRef = Arc::new(UInt64Array::from(
      rows.iter().map(|r| r.duration_ms).collect::<Vec<_>>(),
    ));
    let message: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.message.as_deref())
        .collect::<Vec<_>>(),
    ));
    let file: ArrayRef = Arc::new(StringArray::from(
      rows.iter().map(|r| r.file.as_deref()).collect::<Vec<_>>(),
    ));
    let line: ArrayRef = Arc::new(UInt32Array::from(
      rows.iter().map(|r| r.line).collect::<Vec<_>>(),
    ));

    let http_method: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.http_method.as_deref())
        .collect::<Vec<_>>(),
    ));
    let http_target: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.http_target.as_deref())
        .collect::<Vec<_>>(),
    ));
    let http_status: ArrayRef = Arc::new(UInt16Array::from(
      rows.iter().map(|r| r.http_status).collect::<Vec<_>>(),
    ));
    let http_host: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.http_host.as_deref())
        .collect::<Vec<_>>(),
    ));

    let user_email: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.user_email.as_deref())
        .collect::<Vec<_>>(),
    ));
    let user_ip: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.user_ip.as_deref())
        .collect::<Vec<_>>(),
    ));

    let log_type: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.log_type.as_deref())
        .collect::<Vec<_>>(),
    ));
    let fingerprint: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.fingerprint.as_deref())
        .collect::<Vec<_>>(),
    ));
    let attributes_json: ArrayRef = Arc::new(StringArray::from(
      rows
        .iter()
        .map(|r| r.attributes_json.as_deref())
        .collect::<Vec<_>>(),
    ));
    let origin: ArrayRef = Arc::new(StringArray::from(
      rows.iter().map(|r| r.origin.as_deref()).collect::<Vec<_>>(),
    ));

    let columns = vec![
      entry_id,
      entry_ts,
      session_id,
      node_type,
      span_id,
      parent_id,
      depth,
      sibling_index,
      name,
      level,
      duration_ms,
      message,
      file,
      line,
      http_method,
      http_target,
      http_status,
      http_host,
      user_email,
      user_ip,
      log_type,
      fingerprint,
      attributes_json,
      origin,
    ];

    RecordBatch::try_new(PARQUET_SCHEMA.clone(), columns)
      .map_err(|e| ParquetWriteError::Arrow(e.to_string()))
  }

  /// Finish writing and close the file.
  pub fn finish(mut self) -> Result<(), ParquetWriteError> {
    self.flush_buffer()?;
    self.writer.close()?;
    Ok(())
  }
}

#[derive(Debug)]
pub enum ParquetWriteError {
  Io(std::io::Error),
  Parquet(String),
  Arrow(String),
}

impl std::fmt::Display for ParquetWriteError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ParquetWriteError::Io(e) => write!(f, "IO error: {}", e),
      ParquetWriteError::Parquet(e) => write!(f, "Parquet error: {}", e),
      ParquetWriteError::Arrow(e) => write!(f, "Arrow error: {}", e),
    }
  }
}

impl std::error::Error for ParquetWriteError {}

impl From<std::io::Error> for ParquetWriteError {
  fn from(e: std::io::Error) -> Self {
    ParquetWriteError::Io(e)
  }
}

impl From<parquet::errors::ParquetError> for ParquetWriteError {
  fn from(e: parquet::errors::ParquetError) -> Self {
    ParquetWriteError::Parquet(e.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  use chrono::Utc;
  use uuid::Uuid;

  use crate::ljson::{LJSON_VERSION, LjsonLevel, LjsonLocation};

  fn make_test_entry() -> LjsonEntry {
    let mut attrs = HashMap::new();
    attrs.insert("http.method".to_string(), serde_json::json!("GET"));
    attrs.insert("http.target".to_string(), serde_json::json!("/api/test"));
    attrs.insert("http.status_code".to_string(), serde_json::json!(200));
    attrs.insert(
      "message".to_string(),
      serde_json::json!("Request completed"),
    );

    LjsonEntry {
      v: LJSON_VERSION,
      ts: Utc::now(),
      session_id: Uuid::new_v4(),
      origin: None,
      root_span: LjsonSpan {
        id: 1,
        name: "http_request".to_string(),
        level: LjsonLevel::Info,
        duration_ms: Some(42),
        location: LjsonLocation {
          file: Some("routes/api.rs".to_string()),
          line: Some(100),
        },
        attributes: attrs,
        children: vec![],
      },
    }
  }

  /// Test flattening logic without needing a real writer.
  fn flatten_span_to_vec(
    span: &LjsonSpan,
    entry_id: &str,
    entry_ts_ms: i64,
    session_id: &str,
    parent_id: Option<u64>,
    depth: u8,
    sibling_index: u16,
    buffer: &mut Vec<FlattenedRow>,
  ) {
    let mut row = FlattenedRow::new_span(
      entry_id.to_string(),
      entry_ts_ms,
      session_id.to_string(),
      span.id,
      parent_id,
      depth,
      sibling_index,
    );

    row.name = span.name.clone();
    row.level = format!("{:?}", span.level).to_lowercase();
    row.duration_ms = span.duration_ms.map(|d| d.max(0) as u64);
    row.file = span.location.file.clone();
    row.line = span.location.line;

    // Extract attributes
    row.message = span
      .attributes
      .get("message")
      .or_else(|| span.attributes.get("summary"))
      .and_then(|v| v.as_str())
      .map(String::from);
    row.http_method = span
      .attributes
      .get("http.method")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.http_target = span
      .attributes
      .get("http.target")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.http_status = span
      .attributes
      .get("http.status_code")
      .and_then(|v| v.as_u64())
      .map(|n| n as u16);
    row.http_host = span
      .attributes
      .get("http.host")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.log_type = span
      .attributes
      .get("log_type")
      .and_then(|v| v.as_str())
      .map(String::from);
    row.fingerprint = span
      .attributes
      .get("fingerprint")
      .and_then(|v| v.as_str())
      .map(String::from);

    buffer.push(row);

    for (idx, child) in span.children.iter().enumerate() {
      match child {
        LjsonChild::Span(child_span) => {
          flatten_span_to_vec(
            child_span,
            entry_id,
            entry_ts_ms,
            session_id,
            Some(span.id),
            depth + 1,
            idx as u16,
            buffer,
          );
        }
        LjsonChild::Event(_) => {
          // Events handled separately in production
        }
      }
    }
  }

  #[test]
  fn test_flatten_entry() {
    let entry = make_test_entry();
    let entry_id = format!("{}_{}", entry.ts.timestamp_millis(), entry.session_id);

    let mut buffer = Vec::new();
    flatten_span_to_vec(
      &entry.root_span,
      &entry_id,
      entry.ts.timestamp_millis(),
      &entry.session_id.to_string(),
      None,
      0,
      0,
      &mut buffer,
    );

    assert_eq!(buffer.len(), 1);
    let row = &buffer[0];
    assert_eq!(row.node_type, "span");
    assert_eq!(row.name, "http_request");
    assert_eq!(row.level, "info");
    assert_eq!(row.duration_ms, Some(42));
    assert_eq!(row.http_method, Some("GET".to_string()));
    assert_eq!(row.http_target, Some("/api/test".to_string()));
    assert_eq!(row.http_status, Some(200));
    assert_eq!(row.message, Some("Request completed".to_string()));
    assert_eq!(row.depth, 0);
    assert!(row.parent_id.is_none());
  }

  #[test]
  fn test_flattened_row_new_span() {
    let row = FlattenedRow::new_span(
      "entry_1".to_string(),
      1000,
      "session_1".to_string(),
      42,
      Some(1),
      2,
      3,
    );

    assert_eq!(row.node_type, "span");
    assert_eq!(row.span_id, Some(42));
    assert_eq!(row.parent_id, Some(1));
    assert_eq!(row.depth, 2);
    assert_eq!(row.sibling_index, 3);
  }

  #[test]
  fn test_flattened_row_new_event() {
    let row = FlattenedRow::new_event(
      "entry_1".to_string(),
      1000,
      "session_1".to_string(),
      42,
      2,
      3,
    );

    assert_eq!(row.node_type, "event");
    assert!(row.span_id.is_none());
    assert_eq!(row.parent_id, Some(42));
    assert_eq!(row.depth, 2);
  }
}
