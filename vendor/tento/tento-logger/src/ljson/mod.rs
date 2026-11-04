//! LJSON (Line-delimited JSON) schema types for tento-logger.
//!
//! Each line is a self-contained JSON object representing a completed root span
//! with its full tree of children. This format enables:
//!
//! - Streaming-friendly log processing (one line = one complete request)
//! - Decoupled rendering (write LJSON, render later with a compatible renderer)
//! - Easy filtering with grep/jq
//! - Future Parquet conversion for analytical queries

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{layers::logging_layer::SlogLevel, models::code_location::CodeLocation};

/// Schema version for forward compatibility
pub const LJSON_VERSION: u8 = 1;

/// A complete log entry representing a root span and all its children.
/// Each entry is serialized as a single JSON line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LjsonEntry {
  /// Schema version (currently 1)
  pub v: u8,
  /// Timestamp when the root span completed
  pub ts: DateTime<Utc>,
  /// Session ID from the logging layer
  pub session_id: Uuid,
  /// Origin: "client" or "server" (None defaults to "server" for backwards compat)
  #[serde(skip_serializing_if = "Option::is_none")]
  pub origin: Option<String>,
  /// The root span with nested children
  pub root_span: LjsonSpan,
}

impl LjsonEntry {
  /// Returns true if this entry originated from the client.
  pub fn is_client(&self) -> bool {
    self.origin.as_deref() == Some("client")
  }
}

/// A span in the LJSON tree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LjsonSpan {
  /// Unique span ID
  pub id: u64,
  /// Span name (e.g., "http_request", "db_query")
  pub name: String,
  /// Log level
  pub level: LjsonLevel,
  /// Duration in milliseconds (None if span didn't complete normally)
  /// Using i64 because client-side spans can report negative durations
  /// when concurrent API calls resolve out of order.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub duration_ms: Option<i64>,
  /// Source code location
  pub location: LjsonLocation,
  /// Key-value attributes
  pub attributes: HashMap<String, serde_json::Value>,
  /// Nested children (spans and events)
  pub children: Vec<LjsonChild>,
}

/// A child element in the span tree - either a nested span or an event
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LjsonChild {
  Span(LjsonSpan),
  Event(LjsonEvent),
}

/// An event (log message) in the LJSON tree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LjsonEvent {
  /// Log level
  pub level: LjsonLevel,
  /// Source code location
  pub location: LjsonLocation,
  /// Key-value attributes (includes "message" if present)
  pub attributes: HashMap<String, serde_json::Value>,
}

/// Log level for LJSON serialization
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum LjsonLevel {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

impl From<&SlogLevel> for LjsonLevel {
  fn from(level: &SlogLevel) -> Self {
    match level {
      SlogLevel::Trace => LjsonLevel::Trace,
      SlogLevel::Debug => LjsonLevel::Debug,
      SlogLevel::Info => LjsonLevel::Info,
      SlogLevel::Warn => LjsonLevel::Warn,
      SlogLevel::Error => LjsonLevel::Error,
    }
  }
}

impl LjsonLevel {
  /// Get the short prefix for terminal rendering (e.g., "ERR", "WRN")
  pub fn prefix(&self) -> &'static str {
    match self {
      LjsonLevel::Error => "ERR",
      LjsonLevel::Warn => "WRN",
      LjsonLevel::Info => "INF",
      LjsonLevel::Debug => "DBG",
      LjsonLevel::Trace => "TRC",
    }
  }

  /// Get the single-character prefix with ANSI color for terminal rendering
  pub fn colored_prefix(&self) -> &'static str {
    match self {
      LjsonLevel::Error => "\u{001b}[31me\u{001b}[0m",
      LjsonLevel::Warn => "\u{001b}[33mw\u{001b}[0m",
      LjsonLevel::Info => "\u{001b}[34m \u{001b}[0m",
      LjsonLevel::Debug => "\u{001b}[35m \u{001b}[0m",
      LjsonLevel::Trace => "\u{001b}[34m \u{001b}[0m",
    }
  }

  /// Parse a level from a string (case-insensitive).
  pub fn from_str(s: &str) -> Option<Self> {
    match s.to_lowercase().as_str() {
      "trace" | "trc" => Some(LjsonLevel::Trace),
      "debug" | "dbg" => Some(LjsonLevel::Debug),
      "info" | "inf" => Some(LjsonLevel::Info),
      "warn" | "wrn" => Some(LjsonLevel::Warn),
      "error" | "err" => Some(LjsonLevel::Error),
      _ => None,
    }
  }

  /// Apply ANSI color to a string based on level
  pub fn apply_color(&self, s: &str) -> String {
    match self {
      LjsonLevel::Error => format!("\u{001b}[31m{s}\u{001b}[0m"),
      LjsonLevel::Warn => format!("\u{001b}[33m{s}\u{001b}[0m"),
      _ => s.to_string(),
    }
  }
}

/// Source code location in LJSON format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LjsonLocation {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub line: Option<u32>,
}

impl From<&CodeLocation> for LjsonLocation {
  fn from(loc: &CodeLocation) -> Self {
    LjsonLocation {
      file: loc.file().map(String::from),
      line: loc.line(),
    }
  }
}

impl LjsonLocation {
  /// Format location for terminal display (e.g., "routes/api.rs:45")
  pub fn format(&self) -> String {
    let Some(file) = &self.file else {
      return String::new();
    };

    let parts: Vec<&str> = file.rsplitn(4, '/').collect();
    let mut sb = String::new();

    sb.push_str("\u{001b}[38;5;239m");

    // Build path from last 3 components
    if parts.len() >= 3 {
      sb.push_str(parts[2]);
      sb.push('/');
    }
    if parts.len() >= 2 {
      sb.push_str(parts[1]);
      sb.push('/');
    }
    if !parts.is_empty() {
      sb.push_str(parts[0]);
    }

    if let Some(line) = self.line {
      sb.push(':');
      sb.push_str(&line.to_string());
    }

    sb.push_str("\u{001b}[0m");
    sb
  }
}

// ============================================================================
// Attribute helpers
// ============================================================================

impl LjsonSpan {
  #[inline]
  pub fn get_str(&self, key: &str) -> Option<&str> {
    self.attributes.get(key).and_then(|v| v.as_str())
  }

  #[inline]
  pub fn get_u64(&self, key: &str) -> Option<u64> {
    self.attributes.get(key).and_then(|v| v.as_u64())
  }

  #[inline]
  pub fn get_bool(&self, key: &str) -> Option<bool> {
    self.attributes.get(key).and_then(|v| v.as_bool())
  }

  #[inline]
  pub fn message(&self) -> Option<&str> {
    self.get_str("message").or_else(|| self.get_str("summary"))
  }

  #[inline]
  pub fn elapsed_ms(&self) -> Option<u64> {
    self.get_u64("perf.elapsed")
  }
}

impl LjsonEvent {
  #[inline]
  pub fn get_str(&self, key: &str) -> Option<&str> {
    self.attributes.get(key).and_then(|v| v.as_str())
  }

  #[inline]
  pub fn get_u64(&self, key: &str) -> Option<u64> {
    self.attributes.get(key).and_then(|v| v.as_u64())
  }

  #[inline]
  pub fn get_bool(&self, key: &str) -> Option<bool> {
    self.attributes.get(key).and_then(|v| v.as_bool())
  }

  #[inline]
  pub fn flag(&self, key: &str) -> bool {
    self.get_bool(key).unwrap_or(false)
  }

  #[inline]
  pub fn message(&self) -> Option<&str> {
    self.get_str("message").or_else(|| self.get_str("summary"))
  }

  #[inline]
  pub fn elapsed_ms(&self) -> Option<u64> {
    self.get_u64("perf.elapsed")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_ljson_parse_nested_from_json() {
    let json = r#"{"v":1,"ts":"2026-02-19T11:00:02.100Z","sessionId":"00000000-0000-0000-0000-000000000001","origin":"client","rootSpan":{"id":2,"name":"user/click","level":"info","durationMs":342,"location":{},"attributes":{"message":"user/click: navigate-sheet (calendar)"},"children":[{"type":"event","level":"debug","location":{},"attributes":{"message":"view-state [main.state]"}},{"type":"span","id":3,"name":"api_request","level":"info","durationMs":187,"location":{"file":"test.rs","line":42},"attributes":{"message":"200 GET /api/sheets"},"children":[{"type":"span","id":4,"name":"db_query","level":"debug","durationMs":12,"location":{},"attributes":{"message":"SELECT"},"children":[]},{"type":"event","level":"info","location":{},"attributes":{"message":"Cache miss"}}]}]}}"#;

    let entry: LjsonEntry = serde_json::from_str(json).unwrap();
    assert_eq!(entry.root_span.name, "user/click");
    assert_eq!(entry.root_span.children.len(), 2);

    // First child: event
    match &entry.root_span.children[0] {
      LjsonChild::Event(e) => {
        assert_eq!(e.level, LjsonLevel::Debug);
        assert_eq!(e.message(), Some("view-state [main.state]"));
      }
      _ => panic!("Expected event"),
    }

    // Second child: span with nested children
    match &entry.root_span.children[1] {
      LjsonChild::Span(s) => {
        assert_eq!(s.name, "api_request");
        assert_eq!(s.children.len(), 2);
      }
      _ => panic!("Expected span"),
    }
  }

  #[test]
  fn test_ljson_roundtrip() {
    let entry = LjsonEntry {
      v: LJSON_VERSION,
      ts: Utc::now(),
      session_id: Uuid::new_v4(),
      origin: None,
      root_span: LjsonSpan {
        id: 1,
        name: "test".to_string(),
        level: LjsonLevel::Info,
        duration_ms: Some(42),
        location: LjsonLocation {
          file: Some("test.rs".to_string()),
          line: Some(10),
        },
        attributes: HashMap::new(),
        children: vec![LjsonChild::Event(LjsonEvent {
          level: LjsonLevel::Debug,
          location: LjsonLocation {
            file: Some("test.rs".to_string()),
            line: Some(15),
          },
          attributes: {
            let mut m = HashMap::new();
            m.insert("message".to_string(), serde_json::json!("hello"));
            m
          },
        })],
      },
    };

    let json = serde_json::to_string(&entry).unwrap();
    let parsed: LjsonEntry = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.v, entry.v);
    assert_eq!(parsed.root_span.name, "test");
    assert_eq!(parsed.root_span.children.len(), 1);
  }
}
