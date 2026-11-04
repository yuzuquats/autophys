//! In-process consumers of the [`TraceOp`] stream.
//!
//! Each consumer holds one [`TraceState`] and applies every op it receives.
//! [`RootCloseConsumer`] is the drop-in replacement for the old
//! `SlogAggregator`'s emit path — on every root-close op it materializes an
//! `LjsonEntry`, runs the terminal renderer and (optionally) the Parquet
//! appender, then drains the closed subtree.

use std::sync::Mutex;

use tracing_core::LevelFilter;
use uuid::Uuid;

#[cfg(feature = "parquet")]
use std::sync::Arc;

use crate::fold::{TraceState, apply, build_ljson_entry, build_standalone_entry};
use crate::ljson::{LjsonEntry, LjsonEvent, LjsonLevel};
use crate::render::render_entry;
use crate::render::terminal::{ColumnVisibility, render_standalone_event};
use crate::stream::{TraceOp, TraceOpSink};
#[cfg(feature = "parquet")]
use crate::subscribers::ParquetAppender;

/// In-process consumer that watches the op stream for root-span closes and
/// emits one terminal line / Parquet row per closed root (same shape as the
/// pre-streaming `SlogAggregator`).
pub struct RootCloseConsumer {
  inner: Mutex<Inner>,
  emit: Option<Box<dyn Fn(String) + Send + Sync>>,
  console_min_level: LevelFilter,
  session_id: Uuid,
  /// Column set for standalone (span-less) events. Server consoles keep the
  /// default `all()` so event rows align with span entries; CLI/REPL hosts
  /// pass a reduced set — every column except `level` is structurally blank
  /// for a standalone event, so on a CLI they render as broken-looking rails.
  standalone_columns: ColumnVisibility,
  #[cfg(feature = "parquet")]
  parquet_appender: Option<Arc<ParquetAppender>>,
}

struct Inner {
  state: TraceState,
}

impl RootCloseConsumer {
  pub fn new() -> Self {
    RootCloseConsumer {
      inner: Mutex::new(Inner {
        state: TraceState::new(),
      }),
      emit: None,
      console_min_level: LevelFilter::INFO,
      session_id: Uuid::new_v4(),
      standalone_columns: ColumnVisibility::all(),
      #[cfg(feature = "parquet")]
      parquet_appender: None,
    }
  }

  pub fn with_emit(mut self, emit: impl Fn(String) + Send + Sync + 'static) -> Self {
    self.emit = Some(Box::new(emit));
    self
  }

  pub fn with_console_min_level(mut self, level: LevelFilter) -> Self {
    self.console_min_level = level;
    self
  }

  pub fn with_standalone_columns(mut self, columns: ColumnVisibility) -> Self {
    self.standalone_columns = columns;
    self
  }

  #[cfg(feature = "parquet")]
  pub fn with_parquet_appender(mut self, appender: Arc<ParquetAppender>) -> Self {
    self.parquet_appender = Some(appender);
    self
  }

  pub fn session_id(&self) -> Uuid {
    self.session_id
  }

  fn emit_line(&self, line: String) {
    if let Some(emit) = &self.emit {
      emit(line);
      return;
    }
    use std::io::Write;
    print!("{line}");
    let _ = std::io::stdout().flush();
  }

  fn write_parquet(&self, _entry: &LjsonEntry) {
    #[cfg(feature = "parquet")]
    if let Some(appender) = &self.parquet_appender {
      appender.append(_entry);
    }
  }

  fn should_render(&self, level: &LjsonLevel) -> bool {
    level_filter_of(level) <= self.console_min_level
  }
}

impl Default for RootCloseConsumer {
  fn default() -> Self {
    Self::new()
  }
}

impl TraceOpSink for RootCloseConsumer {
  fn on_op(&self, op: &TraceOp) {
    // Standalone events never enter state — emit immediately.
    if let TraceOp::Event(ev) = op {
      if ev.parent.is_none() {
        let entry = build_standalone_entry(ev, self.session_id);
        self.write_parquet(&entry);
        if self.should_render(&ev.level) {
          let ljson_event = LjsonEvent {
            level: ev.level.clone(),
            location: ev.loc.clone(),
            attributes: ev.fields.clone(),
          };
          let rendered = render_standalone_event(&ljson_event, &self.standalone_columns);
          self.emit_line(rendered);
        }
        return;
      }
    }

    // Apply into state, then on a root close materialize the entry.
    let entry = {
      let mut inner = self.inner.lock().unwrap();
      apply(&mut inner.state, op);
      match op {
        TraceOp::Close(c) if inner.state.is_root(c.id) => {
          let entry = build_ljson_entry(&inner.state, c.id, self.session_id);
          inner.state.drain_subtree(c.id);
          entry
        }
        _ => None,
      }
    };

    if let Some(entry) = entry {
      self.write_parquet(&entry);
      if self.should_render(&entry.root_span.level) {
        let rendered = render_entry(&entry, &ColumnVisibility::all());
        self.emit_line(rendered);
      }
    }
  }
}

fn level_filter_of(level: &LjsonLevel) -> LevelFilter {
  match level {
    LjsonLevel::Trace => LevelFilter::TRACE,
    LjsonLevel::Debug => LevelFilter::DEBUG,
    LjsonLevel::Info => LevelFilter::INFO,
    LjsonLevel::Warn => LevelFilter::WARN,
    LjsonLevel::Error => LevelFilter::ERROR,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ljson::LjsonLocation;
  use crate::stream::{CloseOp, EventOp, OpenOp, TraceOp};
  use chrono::Utc;
  use std::collections::HashMap;
  use std::sync::{Arc, Mutex as StdMutex};

  fn loc() -> LjsonLocation {
    LjsonLocation {
      file: Some("test.rs".into()),
      line: Some(1),
    }
  }

  fn consumer_capturing() -> (RootCloseConsumer, Arc<StdMutex<Vec<String>>>) {
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let cap = captured.clone();
    let c = RootCloseConsumer::new().with_emit(move |s| cap.lock().unwrap().push(s));
    (c, captured)
  }

  #[test]
  fn root_close_renders_one_line() {
    let (c, captured) = consumer_capturing();
    c.on_op(&TraceOp::Open(OpenOp {
      seq: 0,
      id: 1,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      name: "root".into(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields: HashMap::new(),
    }));
    c.on_op(&TraceOp::Close(CloseOp {
      seq: 1,
      id: 1,
      session_id: None,
      ts: Utc::now(),
      elapsed_ms: Some(3),
    }));
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 1);
  }

  #[test]
  fn debug_root_suppressed_at_default_console_level() {
    let (c, captured) = consumer_capturing();
    c.on_op(&TraceOp::Open(OpenOp {
      seq: 0,
      id: 1,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      name: "root".into(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields: HashMap::new(),
    }));
    c.on_op(&TraceOp::Close(CloseOp {
      seq: 1,
      id: 1,
      session_id: None,
      ts: Utc::now(),
      elapsed_ms: Some(3),
    }));
    assert_eq!(captured.lock().unwrap().len(), 0);
  }

  #[test]
  fn standalone_info_event_emits_immediately() {
    let (c, captured) = consumer_capturing();
    let mut fields = HashMap::new();
    fields.insert("message".into(), serde_json::json!("hello"));
    c.on_op(&TraceOp::Event(EventOp {
      seq: 0,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    }));
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("hello"));
  }

  #[test]
  fn standalone_debug_event_suppressed_at_default_level() {
    let (c, captured) = consumer_capturing();
    let mut fields = HashMap::new();
    fields.insert("message".into(), serde_json::json!("hidden"));
    c.on_op(&TraceOp::Event(EventOp {
      seq: 0,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields,
    }));
    assert_eq!(captured.lock().unwrap().len(), 0);
  }

  #[test]
  fn debug_event_renders_when_console_level_is_debug() {
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let cap = captured.clone();
    let c = RootCloseConsumer::new()
      .with_console_min_level(LevelFilter::DEBUG)
      .with_emit(move |s| cap.lock().unwrap().push(s));
    let mut fields = HashMap::new();
    fields.insert("message".into(), serde_json::json!("visible"));
    c.on_op(&TraceOp::Event(EventOp {
      seq: 0,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields,
    }));
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("visible"));
  }

  #[test]
  fn debug_root_renders_when_console_level_is_debug() {
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let cap = captured.clone();
    let c = RootCloseConsumer::new()
      .with_console_min_level(LevelFilter::DEBUG)
      .with_emit(move |s| cap.lock().unwrap().push(s));
    c.on_op(&TraceOp::Open(OpenOp {
      seq: 0,
      id: 1,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      name: "debug_root".into(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields: HashMap::new(),
    }));
    c.on_op(&TraceOp::Close(CloseOp {
      seq: 1,
      id: 1,
      session_id: None,
      ts: Utc::now(),
      elapsed_ms: Some(2),
    }));
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("debug_root"));
  }

  #[test]
  fn error_event_renders_above_higher_thresholds() {
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let cap = captured.clone();
    let c = RootCloseConsumer::new()
      .with_console_min_level(LevelFilter::ERROR)
      .with_emit(move |s| cap.lock().unwrap().push(s));
    for (level, msg) in [
      (LjsonLevel::Error, "critical"),
      (LjsonLevel::Warn, "warning"),
      (LjsonLevel::Info, "info"),
    ] {
      let mut fields = HashMap::new();
      fields.insert("message".into(), serde_json::json!(msg));
      c.on_op(&TraceOp::Event(EventOp {
        seq: 0,
        parent: None,
        session_id: None,
        ts: Utc::now(),
        level,
        loc: loc(),
        fields,
      }));
    }
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 1, "only ERROR renders at ERROR threshold");
    assert!(lines[0].contains("critical"));
  }

  #[test]
  fn warn_threshold_suppresses_info_and_debug() {
    let captured = Arc::new(StdMutex::new(Vec::new()));
    let cap = captured.clone();
    let c = RootCloseConsumer::new()
      .with_console_min_level(LevelFilter::WARN)
      .with_emit(move |s| cap.lock().unwrap().push(s));
    for (level, msg) in [
      (LjsonLevel::Error, "err"),
      (LjsonLevel::Warn, "wrn"),
      (LjsonLevel::Info, "inf"),
      (LjsonLevel::Debug, "dbg"),
    ] {
      let mut fields = HashMap::new();
      fields.insert("message".into(), serde_json::json!(msg));
      c.on_op(&TraceOp::Event(EventOp {
        seq: 0,
        parent: None,
        session_id: None,
        ts: Utc::now(),
        level,
        loc: loc(),
        fields,
      }));
    }
    let lines = captured.lock().unwrap();
    assert_eq!(lines.len(), 2, "only ERROR and WARN render");
    assert!(lines[0].contains("err"));
    assert!(lines[1].contains("wrn"));
  }

  #[test]
  fn suppressed_root_with_child_drains_state() {
    let (c, captured) = consumer_capturing();
    c.on_op(&TraceOp::Open(OpenOp {
      seq: 0,
      id: 100,
      parent: None,
      session_id: None,
      ts: Utc::now(),
      name: "outer".into(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields: HashMap::new(),
    }));
    let mut child_fields = HashMap::new();
    child_fields.insert("message".into(), serde_json::json!("inner"));
    c.on_op(&TraceOp::Event(EventOp {
      seq: 1,
      parent: Some(100),
      session_id: None,
      ts: Utc::now(),
      level: LjsonLevel::Debug,
      loc: loc(),
      fields: child_fields,
    }));
    c.on_op(&TraceOp::Close(CloseOp {
      seq: 2,
      id: 100,
      session_id: None,
      ts: Utc::now(),
      elapsed_ms: Some(1),
    }));
    assert_eq!(captured.lock().unwrap().len(), 0);
    let inner = c.inner.lock().unwrap();
    assert!(inner.state.span(100).is_none(), "drained on root close");
    assert!(inner.state.roots().is_empty());
  }
}
