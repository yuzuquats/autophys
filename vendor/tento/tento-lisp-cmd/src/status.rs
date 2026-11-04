//! Declarative session status: libraries publish a serde status struct per
//! source, a [`StatusBoard`] merges them into one JSON object keyed by source,
//! and a [`StatusSink`] renders the merged value however it likes.
//!
//! `PromptText` is the default sink (renders the REPL label); a tento-tui status
//! pane is the intended future sink. Producers never render a string directly —
//! they push data and the sink decides presentation.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// A render target for the merged status JSON.
pub trait StatusSink: Send + Sync {
  fn render(&self, status: &Value);
}

/// Collects per-source serde status structs, merges them into one JSON object
/// keyed by source name, and re-renders through the sink on every update.
#[derive(Clone)]
pub struct StatusBoard {
  sources: Arc<Mutex<BTreeMap<String, Value>>>,
  sink: Arc<dyn StatusSink>,
}

impl StatusBoard {
  pub fn new(sink: Arc<dyn StatusSink>) -> Self {
    Self {
      sources: Arc::new(Mutex::new(BTreeMap::new())),
      sink,
    }
  }

  /// Replace `source`'s state, re-merge, and re-render. An empty or null state
  /// removes the source (used by `logout`).
  pub fn update<S: serde::Serialize>(&self, source: &str, status: &S) {
    let value = serde_json::to_value(status).unwrap_or(Value::Null);
    let merged = {
      let mut sources = self.sources.lock().expect("status board mutex poisoned");
      let empty = value.is_null() || value.as_object().is_some_and(|o| o.is_empty());
      if empty {
        sources.remove(source);
      } else {
        sources.insert(source.to_string(), value);
      }
      Value::Object(
        sources
          .iter()
          .map(|(k, v)| (k.clone(), v.clone()))
          .collect(),
      )
    };
    self.sink.render(&merged);
  }
}

/// A sink that renders nothing — for surfaces with no status line (e.g. the
/// standalone `tento` dev CLI).
pub struct NoopSink;

impl StatusSink for NoopSink {
  fn render(&self, _status: &Value) {}
}

impl StatusBoard {
  /// A board whose sink renders nothing.
  pub fn noop() -> Self {
    Self::new(Arc::new(NoopSink))
  }
}
