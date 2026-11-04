//! Streaming tracing op log.
//!
//! Every span lifecycle event (open, field update, in-span event, close) maps
//! to one [`TraceOp`] record. [`TraceStreamWriter`] implements
//! [`SlogSubscriber`] and, on each event, serializes one op record and fans it
//! out to:
//!
//! 1. an optional `PaneWriter` opened with shape [`tento_tui_core::shape::TRACE_V1`]
//!    (the cross-process SSOT file);
//! 2. any number of in-process [`TraceOpSink`]s (e.g. the terminal
//!    root-close consumer, the live TUI pane's folder).
//!
//! Writes carry a producer-side monotonic `seq` so consumers can detect drops
//! and order interleaved spans.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::{
  Arc, Mutex,
  atomic::{AtomicU64, Ordering},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tento_tui_core::source::{Header, PaneWriter};

use crate::layers::logging_layer::{SlogEvent, SlogSubscriber};
use crate::ljson::{LjsonLevel, LjsonLocation};

mod json;

/// One step in the streaming trace log. Serialized to a single JSON line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum TraceOp {
  /// A span has opened. `parent` is `None` for root spans.
  Open(OpenOp),
  /// A span's fields have been updated. Field values overwrite previous values.
  Field(FieldOp),
  /// An event (log line). `parent` is `None` for standalone events.
  Event(EventOp),
  /// A span has closed; the optional duration is whatever the tracing layer
  /// captured.
  Close(CloseOp),
}

impl TraceOp {
  pub fn seq(&self) -> u64 {
    match self {
      TraceOp::Open(o) => o.seq,
      TraceOp::Field(o) => o.seq,
      TraceOp::Event(o) => o.seq,
      TraceOp::Close(o) => o.seq,
    }
  }
}

/// `session_id` on each TraceOp variant carries the SlogLayer's
/// `session_id` (which equals the framework's spawn-id when
/// `ACME_SPAWN_ID` was set at logger init). It's `Option<Uuid>` for
/// backwards-compat: pre-spawn-id rows on disk deserialize as `None`,
/// new rows populate it. Downstream consumers (`wait_for_marker`,
/// the recorder's log-tail) filter by this field to scope row matches
/// to a specific spawn.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOp {
  pub seq: u64,
  pub id: u64,
  pub parent: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session_id: Option<uuid::Uuid>,
  pub ts: DateTime<Utc>,
  pub name: String,
  pub level: LjsonLevel,
  pub loc: LjsonLocation,
  pub fields: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOp {
  pub seq: u64,
  pub id: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session_id: Option<uuid::Uuid>,
  pub ts: DateTime<Utc>,
  pub fields: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventOp {
  pub seq: u64,
  pub parent: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session_id: Option<uuid::Uuid>,
  pub ts: DateTime<Utc>,
  pub level: LjsonLevel,
  pub loc: LjsonLocation,
  pub fields: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseOp {
  pub seq: u64,
  pub id: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session_id: Option<uuid::Uuid>,
  pub ts: DateTime<Utc>,
  pub elapsed_ms: Option<i64>,
}

/// In-process consumer of the trace op stream.
///
/// Sinks are notified synchronously inside `TraceStreamWriter::on_slog` — keep
/// them fast and lock-light. Use an internal channel if you need to defer work
/// to another thread.
pub trait TraceOpSink: Send + Sync {
  fn on_op(&self, op: &TraceOp);
}

/// SlogLayer subscriber that converts each `SlogEvent` into one `TraceOp` and
/// fans it out to a file (`PaneWriter`) and any number of in-proc sinks.
pub struct TraceStreamWriter {
  seq: AtomicU64,
  writer: Option<Mutex<PaneWriter>>,
  sinks: Vec<Arc<dyn TraceOpSink>>,
}

impl TraceStreamWriter {
  pub fn new() -> Self {
    TraceStreamWriter {
      seq: AtomicU64::new(0),
      writer: None,
      sinks: Vec::new(),
    }
  }

  /// Open a `PaneWriter` at `path` with shape `trace/v1`; appended ops go to
  /// the file as well as to in-proc sinks. Errors propagate so the caller
  /// (typically `set_global_logger`) can decide whether to log a warning or
  /// fall back to in-proc only.
  pub fn with_file(mut self, path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
    let path = path.as_ref();
    let (w, next_seq) = match resumable_next_seq(path)? {
      Some(next_seq) => (PaneWriter::open_append(path)?, next_seq),
      None => (
        PaneWriter::create(path, tento_tui_core::shape::TRACE_V1, "records")?,
        0,
      ),
    };
    self.seq.store(next_seq, Ordering::Relaxed);
    self.writer = Some(Mutex::new(w));
    Ok(self)
  }

  /// Add an in-process sink that receives every op synchronously.
  pub fn with_sink(mut self, sink: Arc<dyn TraceOpSink>) -> Self {
    self.sinks.push(sink);
    self
  }

  fn next_seq(&self) -> u64 {
    self.seq.fetch_add(1, Ordering::Relaxed)
  }

  fn dispatch(&self, op: TraceOp) {
    if let Some(writer) = &self.writer {
      if let Ok(mut w) = writer.lock() {
        // A best-effort append: a failed write should not crash the producer.
        let _ = w.append(&op);
      }
    }
    for sink in &self.sinks {
      sink.on_op(&op);
    }
  }
}

/// A valid trace stream survives an engine recycle. Return the next producer
/// sequence when `path` already carries the expected envelope; malformed or
/// differently-shaped files are replaced by the caller with a fresh stream.
fn resumable_next_seq(path: &std::path::Path) -> std::io::Result<Option<u64>> {
  let file = match std::fs::File::open(path) {
    Ok(file) => file,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(error),
  };
  let mut lines = std::io::BufReader::new(file).lines();
  let Some(first) = lines.next().transpose()? else {
    return Ok(None);
  };
  let Ok(header) = serde_json::from_str::<Header>(&first) else {
    return Ok(None);
  };
  if header.shape != tento_tui_core::shape::TRACE_V1 || header.encoding != "records" {
    return Ok(None);
  }
  let mut next = 0u64;
  for line in lines {
    let line = line?;
    if let Ok(op) = serde_json::from_str::<TraceOp>(&line) {
      next = next.max(op.seq().saturating_add(1));
    }
  }
  Ok(Some(next))
}

impl Default for TraceStreamWriter {
  fn default() -> Self {
    Self::new()
  }
}

impl SlogSubscriber for TraceStreamWriter {
  fn on_slog(&self, slog: &SlogEvent) {
    match slog {
      SlogEvent::OnSpanCreate {
        id,
        parent_id,
        session_id,
        name,
        level,
        location,
        timestamp,
        attributes,
      } => {
        self.dispatch(TraceOp::Open(OpenOp {
          seq: self.next_seq(),
          id: *id,
          parent: *parent_id,
          session_id: Some(*session_id),
          ts: *timestamp,
          name: name.to_string(),
          level: LjsonLevel::from(level),
          loc: LjsonLocation::from(location),
          fields: clone_attributes(attributes),
        }));
      }
      SlogEvent::OnSpanRecord {
        id,
        session_id,
        timestamp,
        attributes,
      } => {
        self.dispatch(TraceOp::Field(FieldOp {
          seq: self.next_seq(),
          id: *id,
          session_id: Some(*session_id),
          ts: *timestamp,
          fields: clone_attributes(attributes),
        }));
      }
      SlogEvent::OnEvent {
        parent_id,
        session_id,
        timestamp,
        attributes,
        location,
        level,
      } => {
        self.dispatch(TraceOp::Event(EventOp {
          seq: self.next_seq(),
          parent: *parent_id,
          session_id: Some(*session_id),
          ts: *timestamp,
          level: LjsonLevel::from(level),
          loc: LjsonLocation::from(location),
          fields: clone_attributes(attributes),
        }));
      }
      SlogEvent::OnSpanClose {
        id,
        session_id,
        timestamp,
        time_elapsed_ms,
      } => {
        self.dispatch(TraceOp::Close(CloseOp {
          seq: self.next_seq(),
          id: *id,
          session_id: Some(*session_id),
          ts: *timestamp,
          elapsed_ms: time_elapsed_ms.map(|ms| ms as i64),
        }));
      }
    }
  }
}

fn clone_attributes(
  attrs: &HashMap<&str, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
  attrs
    .iter()
    .map(|(k, v)| ((*k).to_string(), v.clone()))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::layers::logging_layer::SlogLevel;
  use crate::models::code_location::CodeLocation;
  use std::sync::Mutex;

  fn test_location() -> CodeLocation {
    serde_json::from_value(serde_json::json!({
      "module": "test",
      "file": "test.rs",
      "line": 1
    }))
    .unwrap()
  }

  struct Recorder(Mutex<Vec<TraceOp>>);
  impl Recorder {
    fn new() -> Arc<Self> {
      Arc::new(Recorder(Mutex::new(Vec::new())))
    }
    fn ops(&self) -> Vec<TraceOp> {
      self.0.lock().unwrap().clone()
    }
  }
  impl TraceOpSink for Recorder {
    fn on_op(&self, op: &TraceOp) {
      self.0.lock().unwrap().push(op.clone());
    }
  }

  #[test]
  fn on_slog_emits_one_op_per_event_with_monotonic_seq() {
    let rec = Recorder::new();
    let w = TraceStreamWriter::new().with_sink(rec.clone());
    let session = uuid::Uuid::new_v4();
    let attrs = HashMap::new();

    w.on_slog(&SlogEvent::OnSpanCreate {
      id: 1,
      parent_id: None,
      session_id: session,
      name: "root",
      level: SlogLevel::Info,
      location: test_location(),
      timestamp: Utc::now(),
      attributes: &attrs,
    });
    w.on_slog(&SlogEvent::OnEvent {
      parent_id: Some(1),
      session_id: session,
      timestamp: Utc::now(),
      attributes: &attrs,
      location: test_location(),
      level: SlogLevel::Info,
    });
    w.on_slog(&SlogEvent::OnSpanClose {
      id: 1,
      session_id: session,
      timestamp: Utc::now(),
      time_elapsed_ms: Some(7),
    });

    let ops = rec.ops();
    assert_eq!(ops.len(), 3);
    assert!(matches!(ops[0], TraceOp::Open(_)));
    assert!(matches!(ops[1], TraceOp::Event(_)));
    assert!(matches!(ops[2], TraceOp::Close(_)));
    assert_eq!(ops[0].seq(), 0);
    assert_eq!(ops[1].seq(), 1);
    assert_eq!(ops[2].seq(), 2);
  }

  #[test]
  fn write_with_file_round_trips_through_pane_reader() {
    use tento_tui_core::source::PaneReader;

    let dir = std::env::temp_dir().join(format!("tento-logger-stream-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("trace.ljson");

    let rec = Recorder::new();
    let w = TraceStreamWriter::new()
      .with_file(&path)
      .unwrap()
      .with_sink(rec.clone());
    let session = uuid::Uuid::new_v4();
    let attrs = HashMap::new();
    w.on_slog(&SlogEvent::OnSpanCreate {
      id: 1,
      parent_id: None,
      session_id: session,
      name: "root",
      level: SlogLevel::Info,
      location: test_location(),
      timestamp: Utc::now(),
      attributes: &attrs,
    });
    w.on_slog(&SlogEvent::OnSpanClose {
      id: 1,
      session_id: session,
      timestamp: Utc::now(),
      time_elapsed_ms: Some(3),
    });

    let (header, mut reader) = PaneReader::open(&path).unwrap();
    assert_eq!(header.unwrap().shape, tento_tui_core::shape::TRACE_V1);
    let lines = reader.poll().unwrap();
    assert_eq!(lines.len(), 2);
    let _: TraceOp = serde_json::from_str(&lines[0]).unwrap();
    let close: TraceOp = serde_json::from_str(&lines[1]).unwrap();
    assert!(matches!(close, TraceOp::Close(_)));

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn trace_writer_resumes_existing_file_and_sequence() {
    use tento_tui_core::source::PaneReader;

    let dir = std::env::temp_dir().join(format!("tento-logger-resume-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("trace.ljson");
    let session = uuid::Uuid::new_v4();
    let attrs = HashMap::new();

    let first = TraceStreamWriter::new().with_file(&path).unwrap();
    first.on_slog(&SlogEvent::OnEvent {
      parent_id: None,
      session_id: session,
      timestamp: Utc::now(),
      attributes: &attrs,
      location: test_location(),
      level: SlogLevel::Info,
    });
    drop(first);

    let second = TraceStreamWriter::new().with_file(&path).unwrap();
    second.on_slog(&SlogEvent::OnEvent {
      parent_id: None,
      session_id: session,
      timestamp: Utc::now(),
      attributes: &attrs,
      location: test_location(),
      level: SlogLevel::Info,
    });
    drop(second);

    let (_, mut reader) = PaneReader::open(&path).unwrap();
    let ops = reader
      .poll()
      .unwrap()
      .into_iter()
      .map(|line| serde_json::from_str::<TraceOp>(&line).unwrap())
      .collect::<Vec<_>>();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0].seq(), 0);
    assert_eq!(ops[1].seq(), 1);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// **Spawn-id contract for TraceOp**: every variant must carry the
  /// SlogEvent's `session_id` as `Some(<uuid>)` in the emitted op.
  /// This is the wire-format guarantee that lets `wait_for_marker` and
  /// the recorder's log-tail filter rows by spawn-id without walking
  /// span-parent chains. Pin all four variants so a future refactor
  /// can't accidentally drop it from one.
  #[test]
  fn each_trace_op_carries_session_id_from_slog_event() {
    let rec = Recorder::new();
    let w = TraceStreamWriter::new().with_sink(rec.clone());
    let session = uuid::Uuid::new_v4();
    let attrs = HashMap::new();

    w.on_slog(&SlogEvent::OnSpanCreate {
      id: 7,
      parent_id: None,
      session_id: session,
      name: "root",
      level: SlogLevel::Info,
      location: test_location(),
      timestamp: Utc::now(),
      attributes: &attrs,
    });
    w.on_slog(&SlogEvent::OnSpanRecord {
      id: 7,
      session_id: session,
      timestamp: Utc::now(),
      attributes: &attrs,
    });
    w.on_slog(&SlogEvent::OnEvent {
      parent_id: Some(7),
      session_id: session,
      timestamp: Utc::now(),
      attributes: &attrs,
      location: test_location(),
      level: SlogLevel::Info,
    });
    w.on_slog(&SlogEvent::OnSpanClose {
      id: 7,
      session_id: session,
      timestamp: Utc::now(),
      time_elapsed_ms: Some(2),
    });

    let ops = rec.ops();
    assert_eq!(ops.len(), 4, "expected 4 ops (Open, Field, Event, Close)");
    for (idx, op) in ops.iter().enumerate() {
      let got = match op {
        TraceOp::Open(o) => o.session_id,
        TraceOp::Field(o) => o.session_id,
        TraceOp::Event(o) => o.session_id,
        TraceOp::Close(o) => o.session_id,
      };
      assert_eq!(
        got,
        Some(session),
        "op[{idx}] ({op:?}) must carry session_id Some({session})"
      );
    }
  }
}
