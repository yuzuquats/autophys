use std::{collections::HashMap, sync::Arc, time::Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{Event, Instrument, Level};
use tracing_bunyan_formatter::JsonStorage;
use tracing_core::{
  LevelFilter, Subscriber,
  span::{Attributes, Id, Record},
};
use tracing_subscriber::{Layer, layer::Context};
use uuid::Uuid;

use crate::models::code_location::CodeLocation;

pub trait SlogSubscriber: Send + Sync {
  fn on_slog(&self, slog: &SlogEvent);
}

pub struct SlogLayerBuilder {
  subscribers: Vec<Box<dyn SlogSubscriber>>,
  spawn_id: Option<uuid::Uuid>,
}

impl SlogLayerBuilder {
  fn new() -> Self {
    SlogLayerBuilder {
      subscribers: vec![],
      spawn_id: None,
    }
  }

  pub fn with_subscriber(mut self, sub: impl SlogSubscriber + 'static) -> Self {
    self.subscribers.push(Box::new(sub));
    self
  }

  /// Use the framework-injected spawn-id as the per-logger `session_id`.
  /// When set, every emitted SlogEvent carries this UUID — span creates,
  /// records, closes, AND events — so downstream readers can filter rows
  /// by spawn-id with one substring/field match.
  ///
  /// When omitted, the layer generates a fresh UUID at build time (legacy
  /// per-process semantics). Callers should prefer
  /// [`crate::set_global_logger`]'s `LoggerConfig::spawn_id` (or letting it
  /// read `ACME_SPAWN_ID` from env) over plumbing this directly.
  pub fn with_spawn_id(mut self, spawn_id: uuid::Uuid) -> Self {
    self.spawn_id = Some(spawn_id);
    self
  }

  pub fn build(self) -> SlogLayer {
    SlogLayer::new(self.subscribers, self.spawn_id)
  }
}

#[derive(Clone)]
pub struct SlogLayer {
  session_id: uuid::Uuid,
  subscribers: Arc<Vec<Box<dyn SlogSubscriber>>>,
}

impl SlogLayer {
  pub fn builder() -> SlogLayerBuilder {
    SlogLayerBuilder::new()
  }

  fn new(subscribers: Vec<Box<dyn SlogSubscriber>>, spawn_id: Option<uuid::Uuid>) -> Self {
    SlogLayer {
      // When the framework injected a spawn-id (via `ACME_SPAWN_ID` env
      // or explicit `LoggerConfig::spawn_id`), use it as the
      // `session_id`. Two concepts collapse into one in our use case:
      // each spawn instantiates one logger, so the spawn-id IS the
      // logger's identifier from the rows-on-disk perspective.
      // Downstream readers see `session_id == spawn_id` and can scope
      // their tail to a specific spawn cleanly.
      session_id: spawn_id.unwrap_or_else(Uuid::new_v4),
      subscribers: Arc::new(subscribers),
    }
  }

  /// The session-id this logger stamps on every SlogEvent. When the
  /// framework injected a spawn-id, this is the spawn-id; otherwise
  /// it's a freshly-minted per-process UUID. Surfaced for tests + for
  /// callers that need to correlate logger lifetime to row metadata.
  pub fn session_id(&self) -> uuid::Uuid {
    self.session_id
  }

  fn record(&self, log: SlogEvent) {
    for s in &*self.subscribers {
      s.on_slog(&log);
    }
  }
}

#[derive(Debug, Serialize, Clone)]
pub enum SlogLevel {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

impl From<&Level> for SlogLevel {
  fn from(level: &Level) -> Self {
    match level.as_str() {
      "TRACE" => SlogLevel::Trace,
      "DEBUG" => SlogLevel::Debug,
      "WARN" => SlogLevel::Warn,
      "ERROR" => SlogLevel::Error,
      "INFO" | _ => SlogLevel::Info,
    }
  }
}

impl SlogLevel {
  pub fn to_logging_prefix(&self) -> &str {
    match self {
      SlogLevel::Error => "\u{001b}[31me\u{001b}[0m",
      SlogLevel::Warn => "\u{001b}[33mw\u{001b}[0m",
      SlogLevel::Info => "\u{001b}[34m \u{001b}[0m",
      SlogLevel::Debug => "\u{001b}[35m \u{001b}[0m",
      SlogLevel::Trace => "\u{001b}[34m \u{001b}[0m",
    }
  }

  pub fn apply_term_color(&self, s: &str) -> String {
    match self {
      SlogLevel::Error => format!("\u{001b}[31m{s}\u{001b}[0m"),
      SlogLevel::Warn => format!("\u{001b}[33m{s}\u{001b}[0m"),
      _ => s.to_string(),
    }
  }

  /// Convert to `LevelFilter` for comparison against console minimum level.
  pub fn to_level_filter(&self) -> LevelFilter {
    match self {
      SlogLevel::Trace => LevelFilter::TRACE,
      SlogLevel::Debug => LevelFilter::DEBUG,
      SlogLevel::Info => LevelFilter::INFO,
      SlogLevel::Warn => LevelFilter::WARN,
      SlogLevel::Error => LevelFilter::ERROR,
    }
  }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum SlogEvent<'a> {
  #[serde(rename_all = "camelCase")]
  OnEvent {
    parent_id: Option<u64>,
    /// Per-logger session-id — equals the framework's spawn-id when
    /// `ACME_SPAWN_ID` was set at logger init. Added to `OnEvent` (it
    /// was previously only on the span-shape variants) so non-span
    /// emits (`tracing::info!`, `tracing::error!`, etc.) also carry
    /// spawn-id and downstream readers can filter them by one field
    /// rather than walking parent chains.
    session_id: uuid::Uuid,
    timestamp: DateTime<Utc>,
    attributes: &'a HashMap<&'a str, serde_json::Value>,
    location: CodeLocation,
    level: SlogLevel,
  },
  #[serde(rename_all = "camelCase")]
  OnSpanCreate {
    id: u64,
    parent_id: Option<u64>,
    session_id: uuid::Uuid,

    name: &'static str,
    level: SlogLevel,
    location: CodeLocation,
    timestamp: DateTime<Utc>,
    attributes: &'a HashMap<&'a str, serde_json::Value>,
  },
  #[serde(rename_all = "camelCase")]
  OnSpanRecord {
    id: u64,
    session_id: uuid::Uuid,
    timestamp: DateTime<Utc>,
    attributes: &'a HashMap<&'a str, serde_json::Value>,
  },
  #[serde(rename_all = "camelCase")]
  OnSpanClose {
    id: u64,
    session_id: uuid::Uuid,
    timestamp: DateTime<Utc>,
    time_elapsed_ms: Option<u128>,
  },
}

/// Fold `*_json` string attributes into structured JSON.
///
/// tracing's field capture is string-only for `%`-formatted values, so a
/// producer that wants a structured payload in the trace stream emits
/// `value_json = %value` (one intentional JSON encoding). This helper —
/// applied at the capture boundary, the single place every event/span
/// attribute map passes through — parses such fields and re-keys them
/// without the suffix (`value_json` → `value`), so every downstream
/// consumer (fold, ljson files, panes) sees a real `Value` instead of
/// JSON-inside-a-string. Unparseable or non-string `*_json` fields pass
/// through untouched under their original key; returns `None` when no
/// fold is needed (the caller keeps the visitor's map, zero copies).
fn fold_json_attrs<'a>(
  values: &HashMap<&'a str, serde_json::Value>,
) -> Option<HashMap<&'a str, serde_json::Value>> {
  if !values
    .keys()
    .any(|k| k.len() > "_json".len() && k.ends_with("_json"))
  {
    return None;
  }
  let mut out: HashMap<&'a str, serde_json::Value> = HashMap::with_capacity(values.len());
  for (k, v) in values {
    let parsed = match (k.strip_suffix("_json"), v) {
      (Some(stripped), serde_json::Value::String(s)) if !stripped.is_empty() => {
        serde_json::from_str::<serde_json::Value>(s)
          .ok()
          .map(|p| (stripped, p))
      }
      _ => None,
    };
    match parsed {
      Some((key, value)) => {
        out.insert(key, value);
      }
      None => {
        out.insert(k, v.clone());
      }
    }
  }
  Some(out)
}

impl<S: Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>> Layer<S> for SlogLayer {
  fn on_event(&self, e: &Event<'_>, _: Context<'_, S>) {
    let mut visitor = JsonStorage::default();
    e.record(&mut visitor);

    // Respect the full tracing parent contract: an explicit root
    // (`info!(parent: None, …)`) stays parentless — `parent()` returns
    // `None` for BOTH explicit-root and contextual events, so checking it
    // alone would silently re-attach root events to the current span (and
    // e.g. a streamed `agent.delta` emitted inside its unit's span would
    // never fold as a standalone).
    let parent_id = if e.is_root() {
      None
    } else if let Some(parent) = e.parent() {
      Some(parent.to_owned())
    } else {
      e.in_current_span().span().id()
    };

    let folded = fold_json_attrs(visitor.values());
    self.record(SlogEvent::OnEvent {
      parent_id: parent_id.map(|id| id.into_u64()),
      session_id: self.session_id,
      level: e.metadata().level().into(),
      timestamp: Utc::now(),
      attributes: folded.as_ref().unwrap_or_else(|| visitor.values()),
      location: e.metadata().into(),
    })
  }

  fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
    let span = ctx.span(id).expect("Span not found, this is a bug");
    let mut visitor = JsonStorage::default();
    attrs.record(&mut visitor);

    let folded = fold_json_attrs(visitor.values());
    self.record(SlogEvent::OnSpanCreate {
      id: span.id().into_u64(),
      parent_id: span.parent().map(|p| p.id().into_u64()),
      session_id: self.session_id,

      name: span.name(),
      level: span.metadata().level().into(),
      timestamp: Utc::now(),
      location: span.metadata().into(),
      attributes: folded.as_ref().unwrap_or_else(|| visitor.values()),
    });
  }

  fn on_record(&self, span: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
    let span = ctx.span(span).expect("Span not found, this is a bug");
    let mut visitor = JsonStorage::default();
    values.record(&mut visitor);
    let folded = fold_json_attrs(visitor.values());
    self.record(SlogEvent::OnSpanRecord {
      id: span.id().into_u64(),
      session_id: self.session_id,
      timestamp: Utc::now(),
      attributes: folded.as_ref().unwrap_or_else(|| visitor.values()),
    });
  }

  fn on_enter(&self, span: &Id, ctx: Context<'_, S>) {
    let span = ctx.span(span).expect("Span not found, this is a bug");
    let mut extensions = span.extensions_mut();
    if extensions.get_mut::<Instant>().is_none() {
      extensions.insert(Instant::now());
    }
  }

  fn on_close(&self, span: Id, ctx: Context<'_, S>) {
    let span = ctx.span(&span).expect("Span not found, this is a bug");
    let time_elapsed_ms = {
      let extensions = span.extensions();
      let elapsed = extensions.get::<Instant>();
      elapsed.map(|i| i.elapsed().as_millis())
    };
    self.record(SlogEvent::OnSpanClose {
      id: span.id().into_u64(),
      session_id: self.session_id,
      timestamp: Utc::now(),
      time_elapsed_ms,
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::{Value, json};

  fn attrs(pairs: &[(&'static str, Value)]) -> HashMap<&'static str, Value> {
    pairs.iter().cloned().collect()
  }

  #[test]
  fn json_suffixed_string_parses_and_rekeys() {
    let values = attrs(&[
      ("kind", json!("exec.body")),
      ("value_json", json!(r#"{"shape":"table/v1","rows":[]}"#)),
    ]);
    let folded = fold_json_attrs(&values).expect("fold applies");
    assert_eq!(folded.get("kind"), Some(&json!("exec.body")));
    assert!(!folded.contains_key("value_json"));
    assert_eq!(
      folded.get("value"),
      Some(&json!({"shape": "table/v1", "rows": []}))
    );
  }

  #[test]
  fn unparseable_json_field_keeps_original_key_and_string() {
    let values = attrs(&[("value_json", json!("not json {"))]);
    let folded = fold_json_attrs(&values).expect("fold attempted");
    assert_eq!(folded.get("value_json"), Some(&json!("not json {")));
    assert!(!folded.contains_key("value"));
  }

  #[test]
  fn no_json_suffix_returns_none_for_zero_copy_path() {
    let values = attrs(&[("kind", json!("stdout")), ("message", json!("hi"))]);
    assert!(fold_json_attrs(&values).is_none());
  }

  #[test]
  fn bare_and_non_string_json_keys_pass_through() {
    // `_json` alone has no base key to strip to; a non-string value was
    // never the producer convention — both pass through untouched.
    let values = attrs(&[
      ("_json", json!(r#"{"a":1}"#)),
      ("stats_json", json!({"already": "structured"})),
    ]);
    let folded = fold_json_attrs(&values).expect("fold attempted");
    assert_eq!(folded.get("_json"), Some(&json!(r#"{"a":1}"#)));
    assert_eq!(
      folded.get("stats_json"),
      Some(&json!({"already": "structured"}))
    );
  }
}
