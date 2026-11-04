//! Parquet reader for LJSON log entries.
//!
//! Reads flattened Parquet rows and reconstructs LjsonEntry objects
//! for rendering with the standard terminal renderer.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::Path;

use arrow::array::{
  Array, StringArray, TimestampMillisecondArray, UInt8Array, UInt16Array, UInt32Array, UInt64Array,
};
use chrono::{DateTime, TimeZone, Utc};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use uuid::Uuid;

use crate::ljson::{
  LJSON_VERSION, LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan,
};

use super::schema::FlattenedRow;

/// Read LJSON entries from a Parquet file.
pub struct LjsonParquetReader {
  rows: Vec<FlattenedRow>,
}

impl LjsonParquetReader {
  /// Open a Parquet file and read all rows.
  pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, ParquetReadError> {
    let file = File::open(path)?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file)?;
    let reader = builder.build()?;

    let mut rows = Vec::new();

    for batch_result in reader {
      let batch = batch_result?;

      // Extract columns
      let entry_id = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("entry_id not StringArray"))?;
      let entry_ts = batch
        .column(1)
        .as_any()
        .downcast_ref::<TimestampMillisecondArray>()
        .ok_or(ParquetReadError::Schema(
          "entry_ts not TimestampMillisecondArray",
        ))?;
      let session_id = batch
        .column(2)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("session_id not StringArray"))?;
      let node_type = batch
        .column(3)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("node_type not StringArray"))?;
      let span_id = batch
        .column(4)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .ok_or(ParquetReadError::Schema("span_id not UInt64Array"))?;
      let parent_id = batch
        .column(5)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .ok_or(ParquetReadError::Schema("parent_id not UInt64Array"))?;
      let depth = batch
        .column(6)
        .as_any()
        .downcast_ref::<UInt8Array>()
        .ok_or(ParquetReadError::Schema("depth not UInt8Array"))?;
      let sibling_index = batch
        .column(7)
        .as_any()
        .downcast_ref::<UInt16Array>()
        .ok_or(ParquetReadError::Schema("sibling_index not UInt16Array"))?;
      let name = batch
        .column(8)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("name not StringArray"))?;
      let level = batch
        .column(9)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("level not StringArray"))?;
      let duration_ms = batch
        .column(10)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .ok_or(ParquetReadError::Schema("duration_ms not UInt64Array"))?;
      let message = batch
        .column(11)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("message not StringArray"))?;
      let file_col = batch
        .column(12)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("file not StringArray"))?;
      let line = batch
        .column(13)
        .as_any()
        .downcast_ref::<UInt32Array>()
        .ok_or(ParquetReadError::Schema("line not UInt32Array"))?;
      let http_method = batch
        .column(14)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("http_method not StringArray"))?;
      let http_target = batch
        .column(15)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("http_target not StringArray"))?;
      let http_status = batch
        .column(16)
        .as_any()
        .downcast_ref::<UInt16Array>()
        .ok_or(ParquetReadError::Schema("http_status not UInt16Array"))?;
      let http_host = batch
        .column(17)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("http_host not StringArray"))?;
      let user_email = batch
        .column(18)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("user_email not StringArray"))?;
      let user_ip = batch
        .column(19)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("user_ip not StringArray"))?;
      let log_type = batch
        .column(20)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("log_type not StringArray"))?;
      let fingerprint = batch
        .column(21)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("fingerprint not StringArray"))?;
      let attributes_json = batch
        .column(22)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or(ParquetReadError::Schema("attributes_json not StringArray"))?;
      // Column 23 (origin) was added later — absent in older Parquet files.
      let origin_col: Option<&StringArray> = if batch.num_columns() > 23 {
        batch.column(23).as_any().downcast_ref::<StringArray>()
      } else {
        None
      };

      for i in 0..batch.num_rows() {
        let row = FlattenedRow {
          entry_id: entry_id.value(i).to_string(),
          entry_ts_ms: entry_ts.value(i),
          session_id: session_id.value(i).to_string(),
          origin: origin_col.and_then(|col| {
            if col.is_null(i) {
              None
            } else {
              Some(col.value(i).to_string())
            }
          }),
          node_type: node_type.value(i).to_string(),
          span_id: if span_id.is_null(i) {
            None
          } else {
            Some(span_id.value(i))
          },
          parent_id: if parent_id.is_null(i) {
            None
          } else {
            Some(parent_id.value(i))
          },
          depth: depth.value(i),
          sibling_index: sibling_index.value(i),
          name: name.value(i).to_string(),
          level: level.value(i).to_string(),
          duration_ms: if duration_ms.is_null(i) {
            None
          } else {
            Some(duration_ms.value(i))
          },
          message: if message.is_null(i) {
            None
          } else {
            Some(message.value(i).to_string())
          },
          file: if file_col.is_null(i) {
            None
          } else {
            Some(file_col.value(i).to_string())
          },
          line: if line.is_null(i) {
            None
          } else {
            Some(line.value(i))
          },
          http_method: if http_method.is_null(i) {
            None
          } else {
            Some(http_method.value(i).to_string())
          },
          http_target: if http_target.is_null(i) {
            None
          } else {
            Some(http_target.value(i).to_string())
          },
          http_status: if http_status.is_null(i) {
            None
          } else {
            Some(http_status.value(i))
          },
          http_host: if http_host.is_null(i) {
            None
          } else {
            Some(http_host.value(i).to_string())
          },
          user_email: if user_email.is_null(i) {
            None
          } else {
            Some(user_email.value(i).to_string())
          },
          user_ip: if user_ip.is_null(i) {
            None
          } else {
            Some(user_ip.value(i).to_string())
          },
          log_type: if log_type.is_null(i) {
            None
          } else {
            Some(log_type.value(i).to_string())
          },
          fingerprint: if fingerprint.is_null(i) {
            None
          } else {
            Some(fingerprint.value(i).to_string())
          },
          attributes_json: if attributes_json.is_null(i) {
            None
          } else {
            Some(attributes_json.value(i).to_string())
          },
        };
        rows.push(row);
      }
    }

    Ok(Self { rows })
  }

  /// Get all entries, optionally filtered by timestamp.
  ///
  /// If `since` is provided, only entries with timestamp >= since are returned.
  pub fn entries(&self, since: Option<DateTime<Utc>>) -> Vec<LjsonEntry> {
    // Group rows by entry_id
    let mut by_entry: HashMap<String, Vec<&FlattenedRow>> = HashMap::new();
    for row in &self.rows {
      by_entry.entry(row.entry_id.clone()).or_default().push(row);
    }

    let since_ms = since.map(|t| t.timestamp_millis());

    let mut entries: Vec<LjsonEntry> = by_entry
      .into_iter()
      .filter_map(|(_entry_id, rows)| {
        let first = rows.first()?;

        // Filter by timestamp
        if let Some(since_ms) = since_ms {
          if first.entry_ts_ms < since_ms {
            return None;
          }
        }

        Some(reconstruct_entry(&rows))
      })
      .collect();

    // Sort by span start time (completion ts minus duration) so requests appear
    // in arrival order, not completion order.
    entries.sort_by_key(|e| {
      e.root_span
        .duration_ms
        .map(|d| e.ts - chrono::Duration::milliseconds(d))
        .unwrap_or(e.ts)
    });

    entries
  }

  /// Get the last `tail_n` entries, filtered by timestamp and minimum level,
  /// reconstructing only the qualifying entries.
  ///
  /// More efficient than `entries()` + tail for large files: root row metadata
  /// is inspected for every entry, but `reconstruct_entry()` is called only for
  /// the last `tail_n` qualifying entries.
  pub fn entries_tail(
    &self,
    tail_n: usize,
    since: Option<DateTime<Utc>>,
    min_level: Option<LjsonLevel>,
  ) -> Vec<LjsonEntry> {
    // Group rows by entry_id (O(all rows), unavoidable)
    let mut by_entry: HashMap<&str, Vec<&FlattenedRow>> = HashMap::new();
    for row in &self.rows {
      by_entry.entry(row.entry_id.as_str()).or_default().push(row);
    }

    let since_ms = since.map(|t| t.timestamp_millis());

    // For each entry, inspect root row metadata only (cheap — no JSON parsing)
    let mut qualifying: Vec<(i64, &str)> = by_entry
      .iter()
      .filter_map(|(entry_id, rows)| {
        let root = rows.iter().find(|r| r.depth == 0)?;

        if let Some(since_ms) = since_ms {
          if root.entry_ts_ms < since_ms {
            return None;
          }
        }

        if let Some(ref min) = min_level {
          if parse_level(&root.level) < *min {
            return None;
          }
        }

        // Sort key: span start time = completion_ts - duration_ms
        let start_ms = root
          .duration_ms
          .map(|d| root.entry_ts_ms - d as i64)
          .unwrap_or(root.entry_ts_ms);

        Some((start_ms, *entry_id))
      })
      .collect();

    // Sort by start time, keep only the last tail_n
    qualifying.sort_unstable_by_key(|(ts, _)| *ts);
    if qualifying.len() > tail_n {
      qualifying.drain(..qualifying.len() - tail_n);
    }

    // Build O(1) lookup set of qualifying entry_ids
    let qualifying_ids: HashSet<&str> = qualifying.iter().map(|(_, id)| *id).collect();

    // Reconstruct only the qualifying entries — the expensive step
    let mut entries: Vec<LjsonEntry> = by_entry
      .into_iter()
      .filter_map(|(entry_id, rows)| {
        if !qualifying_ids.contains(entry_id) {
          return None;
        }
        Some(reconstruct_entry(&rows))
      })
      .collect();

    // Sort reconstructed entries by start time
    entries.sort_by_key(|e| {
      e.root_span
        .duration_ms
        .map(|d| e.ts - chrono::Duration::milliseconds(d))
        .unwrap_or(e.ts)
    });

    entries
  }

  /// Get the timestamp range of entries in the file.
  pub fn timestamp_range(&self) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    if self.rows.is_empty() {
      return None;
    }

    let mut min_ts = i64::MAX;
    let mut max_ts = i64::MIN;

    for row in &self.rows {
      if row.depth == 0 {
        // Only root entries
        min_ts = min_ts.min(row.entry_ts_ms);
        max_ts = max_ts.max(row.entry_ts_ms);
      }
    }

    if min_ts == i64::MAX {
      return None;
    }

    Some((
      Utc.timestamp_millis_opt(min_ts).single()?,
      Utc.timestamp_millis_opt(max_ts).single()?,
    ))
  }

  /// Get the total number of root entries.
  pub fn entry_count(&self) -> usize {
    self.rows.iter().filter(|r| r.depth == 0).count()
  }
}

/// Reconstruct an LjsonEntry from flattened rows.
fn reconstruct_entry(rows: &[&FlattenedRow]) -> LjsonEntry {
  let first = rows[0];

  let ts = Utc
    .timestamp_millis_opt(first.entry_ts_ms)
    .single()
    .unwrap_or_else(Utc::now);
  let session_id = Uuid::parse_str(&first.session_id).unwrap_or_else(|_| Uuid::new_v4());

  // Find root span (depth == 0, node_type == "span")
  let root_row = rows
    .iter()
    .find(|r| r.depth == 0 && r.node_type == "span")
    .unwrap_or(&first);

  let origin = root_row.origin.as_deref();
  let root_span = reconstruct_span(root_row, rows, origin);

  LjsonEntry {
    v: LJSON_VERSION,
    ts,
    session_id,
    origin: root_row.origin.clone(),
    root_span,
  }
}

/// Reconstruct an LjsonSpan from a flattened row and find its children.
fn reconstruct_span(
  row: &FlattenedRow,
  all_rows: &[&FlattenedRow],
  origin: Option<&str>,
) -> LjsonSpan {
  let span_id = row.span_id.unwrap_or(0);

  // Find children (rows where parent_id == this span_id)
  let mut child_rows: Vec<&FlattenedRow> = all_rows
    .iter()
    .filter(|r| r.parent_id == Some(span_id) && r.depth == row.depth + 1)
    .copied()
    .collect();

  // Sort by sibling_index
  child_rows.sort_by_key(|r| r.sibling_index);

  let children: Vec<LjsonChild> = child_rows
    .iter()
    .map(|child_row| {
      if child_row.node_type == "span" {
        LjsonChild::Span(reconstruct_span(child_row, all_rows, origin))
      } else {
        LjsonChild::Event(reconstruct_event(child_row, origin))
      }
    })
    .collect();

  LjsonSpan {
    id: span_id,
    name: row.name.clone(),
    level: parse_level(&row.level),
    duration_ms: row.duration_ms.map(|d| d as i64),
    location: LjsonLocation {
      file: row.file.clone(),
      line: row.line,
    },
    attributes: build_attributes(row, origin),
    children,
  }
}

/// Reconstruct an LjsonEvent from a flattened row.
fn reconstruct_event(row: &FlattenedRow, origin: Option<&str>) -> LjsonEvent {
  LjsonEvent {
    level: parse_level(&row.level),
    location: LjsonLocation {
      file: row.file.clone(),
      line: row.line,
    },
    attributes: build_attributes(row, origin),
  }
}

/// Parse level string to LjsonLevel.
fn parse_level(s: &str) -> LjsonLevel {
  match s.to_lowercase().as_str() {
    "trace" => LjsonLevel::Trace,
    "debug" => LjsonLevel::Debug,
    "info" => LjsonLevel::Info,
    "warn" => LjsonLevel::Warn,
    "error" => LjsonLevel::Error,
    _ => LjsonLevel::Info,
  }
}

/// Build attributes HashMap from flattened row.
fn build_attributes(
  row: &FlattenedRow,
  origin: Option<&str>,
) -> HashMap<String, serde_json::Value> {
  let mut attrs = HashMap::new();
  let is_client = origin == Some("client");

  if let Some(msg) = &row.message {
    attrs.insert("message".to_string(), serde_json::json!(msg));
  }
  if let Some(method) = &row.http_method {
    attrs.insert("http.method".to_string(), serde_json::json!(method));
  }
  if let Some(target) = &row.http_target {
    attrs.insert("http.target".to_string(), serde_json::json!(target));
  }
  if let Some(status) = row.http_status {
    let key = if is_client {
      "http.status"
    } else {
      "http.status_code"
    };
    attrs.insert(key.to_string(), serde_json::json!(status));
  }
  if let Some(host) = &row.http_host {
    attrs.insert("http.host".to_string(), serde_json::json!(host));
  }
  if let Some(email) = &row.user_email {
    attrs.insert("user.email".to_string(), serde_json::json!(email));
  }
  if let Some(ip) = &row.user_ip {
    attrs.insert("user.connecting_ip".to_string(), serde_json::json!(ip));
  }
  if let Some(log_type) = &row.log_type {
    attrs.insert("log_type".to_string(), serde_json::json!(log_type));
  }
  if let Some(fp) = &row.fingerprint {
    attrs.insert("fingerprint".to_string(), serde_json::json!(fp));
  }

  // Merge attributes_json back
  if let Some(json_str) = &row.attributes_json {
    if let Ok(extra) = serde_json::from_str::<HashMap<String, serde_json::Value>>(json_str) {
      attrs.extend(extra);
    }
  }

  // Add span.kind if this looks like an HTTP request
  if row.http_method.is_some() && row.depth == 0 {
    attrs.insert("span.kind".to_string(), serde_json::json!("request"));
  }

  attrs
}

#[derive(Debug)]
pub enum ParquetReadError {
  Io(std::io::Error),
  Parquet(String),
  Arrow(String),
  Schema(&'static str),
}

impl std::fmt::Display for ParquetReadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ParquetReadError::Io(e) => write!(f, "IO error: {}", e),
      ParquetReadError::Parquet(e) => write!(f, "Parquet error: {}", e),
      ParquetReadError::Arrow(e) => write!(f, "Arrow error: {}", e),
      ParquetReadError::Schema(e) => write!(f, "Schema error: {}", e),
    }
  }
}

impl std::error::Error for ParquetReadError {}

impl From<std::io::Error> for ParquetReadError {
  fn from(e: std::io::Error) -> Self {
    ParquetReadError::Io(e)
  }
}

impl From<parquet::errors::ParquetError> for ParquetReadError {
  fn from(e: parquet::errors::ParquetError) -> Self {
    ParquetReadError::Parquet(e.to_string())
  }
}

impl From<arrow::error::ArrowError> for ParquetReadError {
  fn from(e: arrow::error::ArrowError) -> Self {
    ParquetReadError::Arrow(e.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_parse_level() {
    assert_eq!(parse_level("info"), LjsonLevel::Info);
    assert_eq!(parse_level("INFO"), LjsonLevel::Info);
    assert_eq!(parse_level("error"), LjsonLevel::Error);
    assert_eq!(parse_level("warn"), LjsonLevel::Warn);
    assert_eq!(parse_level("debug"), LjsonLevel::Debug);
    assert_eq!(parse_level("trace"), LjsonLevel::Trace);
    assert_eq!(parse_level("unknown"), LjsonLevel::Info);
  }
}
