//! `tento-logger-spans` — the **span-tree** bucket shape (`span-tree/v1`).
//!
//! This crate is the schema *source of truth* shared by the producer (the
//! evolving tento-logger tracing layer writes [`SpanRow`]s) and the consumers
//! (the watcher edge-cache + the TUI renderer read them via the recompose here).
//!
//! Each `tracing` span is appended **independently the moment it resolves** — we
//! never wait for the root. Out-of-order arrival is fine because identity is
//! stable and denormalized:
//! - `session_id` (a per-app-lifetime UUID) namespaces a process run,
//! - `span_id` is minted stable at span creation (not tracing's recycled `u64`),
//! - `parent_id` is the stable parent, and `trace_id` (the root's id) is copied
//!   onto **every** row — so the `parent_id` chain to root is always well-defined
//!   and a whole tree is fetched by `trace_id`.
//!
//! The parquet is generic: structural columns + one `attributes` json string
//! column (message, `http.*`, custom fields) that the framework never reads.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use arrow::array::{Array, ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tento_timeseries::SeriesRow;

pub mod writer;

pub use writer::{StreamBucketSpec, StreamEventWriter, StreamRunHandle};

/// The `shape_tag` a span bucket advertises.
pub const SHAPE_TAG: &str = "span-tree/v1";

/// Explicit retention for synthesized text-stream buckets (the recorder's
/// `logs` tail, loaf's `bundling`/`startup`, …). Text volume is 10–100× span
/// volume, so these must NOT inherit the span-shape default (2d/30d/26w);
/// hot 2d / daily 14d / weekly 12w is the explicit contract stamped into
/// `meta.json`. Operators can override per-bucket by editing
/// `<bucket>/meta.json` directly.
pub fn synthesized_text_retention() -> tento_buckets::RetentionPolicy {
  tento_buckets::RetentionPolicy {
    keep_hot_days: Some(2),
    keep_daily_days: Some(14),
    keep_weekly_weeks: Some(12),
  }
}

/// One resolved `tracing` span (or event), written independently. Ids are
/// stable strings (uuid-derived) so they survive out-of-order, cross-window reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpanRow {
  /// Per-app-lifetime UUID (namespaces ids across process runs).
  pub session_id: String,
  /// The root span's id — copied onto every row in the tree.
  pub trace_id: String,
  pub span_id: String,
  /// `None` ⇒ this is the root.
  pub parent_id: Option<String>,
  /// `"span"` | `"event"`.
  pub kind: String,
  pub name: String,
  pub level: String,
  pub start_ts: DateTime<Utc>,
  pub end_ts: Option<DateTime<Utc>>,
  pub duration_ms: Option<i64>,
  /// Arbitrary `json::Value` (message / http.* / fields), as a JSON string.
  pub attributes: String,
  /// Nesting depth in the trace (root = 0). Denormalized so a windowed read can
  /// render the line's indent without walking ancestors that may be off-window.
  /// `#[serde(default)]` ⇒ pre-annotation rows read as `0` (render flat).
  #[serde(default)]
  pub depth: u32,
  /// The root span's `start_ts` (= self's when this row IS the root). Bounds an
  /// on-demand "expand the whole trace" fetch (`range(root_ts ..= start_ts)`).
  /// `None` on pre-annotation rows.
  #[serde(default)]
  pub root_ts: Option<DateTime<Utc>>,
}

impl SpanRow {
  /// A self-rooted synthesized event: `trace_id == span_id`, no parent,
  /// depth 0, `root_ts = start_ts`, ANSI stripped from `name`. The one
  /// canonical mapping from "a raw text line" to a span row, shared by every
  /// producer that synthesizes rows from text rather than from live tracing
  /// (the fleet recorder's log tail, the bundler stderr stream, the loaf
  /// restart logger). `attributes` is the caller's provenance object,
  /// serialized as the row's JSON string column.
  pub fn synthesized_event(
    session_id: &str,
    start_ts: DateTime<Utc>,
    name: &str,
    level: &str,
    attributes: serde_json::Value,
  ) -> SpanRow {
    let span_id = uuid::Uuid::new_v4().to_string();
    SpanRow {
      session_id: session_id.to_string(),
      trace_id: span_id.clone(),
      span_id,
      parent_id: None,
      kind: "event".to_string(),
      name: strip_ansi(name),
      level: level.to_string(),
      start_ts,
      end_ts: None,
      duration_ms: None,
      attributes: attributes.to_string(),
      depth: 0,
      root_ts: Some(start_ts),
    }
  }

  /// A synthesized event CHILD of an existing synthesized root: same shape
  /// as [`synthesized_event`](Self::synthesized_event) but chained into the
  /// root's trace (`trace_id`/`parent_id`/`root_ts`, depth 1), so a
  /// multi-line producer episode — one server start attempt, one bundling
  /// pass — recomposes and renders as ONE tree instead of N flat lines.
  pub fn synthesized_child(
    session_id: &str,
    start_ts: DateTime<Utc>,
    name: &str,
    level: &str,
    attributes: serde_json::Value,
    root_id: &str,
    root_ts: DateTime<Utc>,
  ) -> SpanRow {
    SpanRow {
      session_id: session_id.to_string(),
      trace_id: root_id.to_string(),
      span_id: uuid::Uuid::new_v4().to_string(),
      parent_id: Some(root_id.to_string()),
      kind: "event".to_string(),
      name: strip_ansi(name),
      level: level.to_string(),
      start_ts,
      end_ts: None,
      duration_ms: None,
      attributes: attributes.to_string(),
      depth: 1,
      root_ts: Some(root_ts),
    }
  }
}

/// The per-source monotone capture sequence a text-tail producer stamped
/// into `attributes.seq` ([`SpanRow::synthesized_event`] callers). `None`
/// for native tracing rows.
pub fn capture_seq(r: &SpanRow) -> Option<i64> {
  serde_json::from_str::<serde_json::Value>(&r.attributes)
    .ok()
    .and_then(|v| v.get("seq").and_then(|s| s.as_i64()))
}

/// The canonical render ordering for span-log rows, shared by the TUI
/// window and the `--op logs` CLI (use with `sort_by_cached_key`).
///
/// Primary anchor is the ROOT timestamp (`root_ts`, = own `start_ts` for
/// roots and synthesized events) then `trace_id`, so a whole native trace
/// forms one contiguous block. Within an anchor, synthesized text rows
/// order by their capture `seq`: a tailed batch lands with ONE shared
/// ingest-fallback `start_ts`, and without the seq tiebreak the random
/// per-row `trace_id` SHUFFLES the batch — request trees captured from a
/// service's pretty stdout interleave into nonsense. `seq` is the journal's
/// original line order; nothing else preserves it.
pub fn render_order_key(
  r: &SpanRow,
) -> (DateTime<Utc>, Option<i64>, String, DateTime<Utc>, String) {
  (
    r.root_ts.unwrap_or(r.start_ts),
    capture_seq(r),
    r.trace_id.clone(),
    r.start_ts,
    r.span_id.clone(),
  )
}

/// The folded display name for a row: HTTP-request roots (attrs carry
/// `span.kind == "request"`, written by the tracing middleware's
/// `root_span!`) collapse their `http.*` fields into one scannable line —
/// `GET jameskao.io /api/blog → 200` — instead of the bare `HTTP request`
/// plus a dozen attribute lines. Every other row keeps its `name`. Shared by
/// the TUI span pane and the `--op logs` CLI so both surfaces agree; raw
/// records stay available via `--json`.
pub fn display_name(r: &SpanRow) -> String {
  let Some(attrs) = serde_json::from_str::<serde_json::Value>(&r.attributes)
    .ok()
    .and_then(|v| v.as_object().cloned())
  else {
    return r.name.clone();
  };
  let get = |key: &str| {
    attrs.get(key).map(|v| match v {
      serde_json::Value::String(s) => s.clone(),
      other => other.to_string(),
    })
  };
  if get("span.kind").as_deref() != Some("request") {
    return r.name.clone();
  }
  let method = get("http.method").unwrap_or_else(|| "?".to_string());
  let host = get("http.host").unwrap_or_default();
  let target = get("http.target").unwrap_or_default();
  let status = get("http.status_code").unwrap_or_else(|| "…".to_string());
  format!("{method} {host} {target} → {status}")
}

fn rfc3339(t: DateTime<Utc>) -> String {
  t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl SeriesRow for SpanRow {
  fn ts(&self) -> DateTime<Utc> {
    self.start_ts
  }

  /// Unique per span (many spans can share a start instant): `start_ts:span_id`.
  /// `start_ts` first keeps the key chronologically sortable; `span_id` breaks ties.
  fn ts_key(&self) -> String {
    format!("{}:{}", rfc3339(self.start_ts), self.span_id)
  }

  fn arrow_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
      Field::new("session_id", DataType::Utf8, false),
      Field::new("trace_id", DataType::Utf8, false),
      Field::new("span_id", DataType::Utf8, false),
      Field::new("parent_id", DataType::Utf8, true),
      Field::new("kind", DataType::Utf8, false),
      Field::new("name", DataType::Utf8, false),
      Field::new("level", DataType::Utf8, false),
      Field::new("start_ts", DataType::Utf8, false),
      Field::new("end_ts", DataType::Utf8, true),
      Field::new("duration_ms", DataType::Int64, true),
      Field::new("attributes", DataType::Utf8, false),
      Field::new("depth", DataType::Int64, false),
      Field::new("root_ts", DataType::Utf8, true),
    ]))
  }

  fn to_batch(rows: &[Self]) -> Result<RecordBatch> {
    let strs = |f: fn(&SpanRow) -> &str| -> ArrayRef {
      Arc::new(StringArray::from_iter_values(rows.iter().map(f)))
    };
    let cols: Vec<ArrayRef> = vec![
      strs(|r| &r.session_id),
      strs(|r| &r.trace_id),
      strs(|r| &r.span_id),
      Arc::new(StringArray::from(
        rows
          .iter()
          .map(|r| r.parent_id.as_deref())
          .collect::<Vec<_>>(),
      )),
      strs(|r| &r.kind),
      strs(|r| &r.name),
      strs(|r| &r.level),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| rfc3339(r.start_ts)),
      )),
      Arc::new(StringArray::from(
        rows
          .iter()
          .map(|r| r.end_ts.map(rfc3339))
          .collect::<Vec<_>>(),
      )),
      Arc::new(Int64Array::from(
        rows.iter().map(|r| r.duration_ms).collect::<Vec<_>>(),
      )),
      strs(|r| &r.attributes),
      Arc::new(Int64Array::from(
        rows.iter().map(|r| r.depth as i64).collect::<Vec<_>>(),
      )),
      Arc::new(StringArray::from(
        rows
          .iter()
          .map(|r| r.root_ts.map(rfc3339))
          .collect::<Vec<_>>(),
      )),
    ];
    Ok(RecordBatch::try_new(Self::arrow_schema(), cols)?)
  }

  fn from_batch(batch: &RecordBatch) -> Vec<Self> {
    let s = |i: usize| batch.column(i).as_any().downcast_ref::<StringArray>();
    let parse = |a: &StringArray, i: usize| {
      DateTime::parse_from_rfc3339(a.value(i))
        .ok()
        .map(|d| d.with_timezone(&Utc))
    };
    let (
      Some(session),
      Some(trace),
      Some(span),
      Some(parent),
      Some(kind),
      Some(name),
      Some(level),
      Some(start),
    ) = (s(0), s(1), s(2), s(3), s(4), s(5), s(6), s(7))
    else {
      return Vec::new();
    };
    let end = s(8);
    let dur = batch.column(9).as_any().downcast_ref::<Int64Array>();
    let attrs = s(10);
    // `depth` / `root_ts` were added after the first parquet were written, so
    // resolve them BY NAME and default when absent — old (11-column) parquet on
    // disk must still read (reading `column(11)` by index would panic).
    let by_name = |n: &str| batch.schema().index_of(n).ok();
    let depth =
      by_name("depth").and_then(|i| batch.column(i).as_any().downcast_ref::<Int64Array>());
    let root =
      by_name("root_ts").and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());
    (0..batch.num_rows())
      .filter_map(|i| {
        Some(SpanRow {
          session_id: session.value(i).to_string(),
          trace_id: trace.value(i).to_string(),
          span_id: span.value(i).to_string(),
          parent_id: (!parent.is_null(i)).then(|| parent.value(i).to_string()),
          kind: kind.value(i).to_string(),
          name: name.value(i).to_string(),
          level: level.value(i).to_string(),
          start_ts: parse(start, i)?,
          end_ts: end.and_then(|a| (!a.is_null(i)).then(|| parse(a, i)).flatten()),
          duration_ms: dur.and_then(|a| (!a.is_null(i)).then(|| a.value(i))),
          attributes: attrs.map(|a| a.value(i).to_string()).unwrap_or_default(),
          depth: depth.map(|a| a.value(i) as u32).unwrap_or(0),
          root_ts: root.and_then(|a| (!a.is_null(i)).then(|| parse(a, i)).flatten()),
        })
      })
      .collect()
  }
}

/// A reconstructed span tree node.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanTree {
  pub row: SpanRow,
  pub children: Vec<SpanTree>,
}

/// Rebuild span trees from a flat set of rows (typically one `trace_id`'s worth,
/// fetched via `range`). Children are ordered by `start_ts`. Spans whose parent
/// isn't present (an orphan from a partial read) become roots, so nothing is
/// dropped — but with `trace_id`-scoped fetches the tree is normally whole.
pub fn recompose(rows: Vec<SpanRow>) -> Vec<SpanTree> {
  let present: HashSet<String> = rows.iter().map(|r| r.span_id.clone()).collect();
  let mut by_parent: HashMap<Option<String>, Vec<SpanRow>> = HashMap::new();
  for r in rows {
    by_parent.entry(r.parent_id.clone()).or_default().push(r);
  }
  // Roots = real roots (parent None) + orphans (parent id not in this set).
  let mut roots: Vec<SpanRow> = Vec::new();
  let keys: Vec<Option<String>> = by_parent.keys().cloned().collect();
  for k in keys {
    let is_root = match &k {
      None => true,
      Some(p) => !present.contains(p),
    };
    if is_root {
      roots.extend(by_parent.remove(&k).unwrap_or_default());
    }
  }
  build_level(roots, &mut by_parent)
}

fn build_level(
  mut rows: Vec<SpanRow>,
  by_parent: &mut HashMap<Option<String>, Vec<SpanRow>>,
) -> Vec<SpanTree> {
  rows.sort_by(|a, b| a.start_ts.cmp(&b.start_ts));
  rows
    .into_iter()
    .map(|r| {
      let kids = by_parent
        .remove(&Some(r.span_id.clone()))
        .unwrap_or_default();
      SpanTree {
        children: build_level(kids, by_parent),
        row: r,
      }
    })
    .collect()
}

/// Strip terminal ANSI escape sequences from `s`, returning a plain-text
/// copy. Used at ingest by producers that synthesize rows from raw text
/// (the fleet recorder's log tail) so a service that writes colorized
/// output to its launchd / systemd log doesn't pollute the bucket. The
/// bucket is the canonical structured copy; renderers should drive
/// coloring off `level`, not off whatever ANSI the producer emitted.
///
/// Handles the common forms:
/// - **CSI** (`ESC [ … final-byte`) — the SGR colors and most cursor moves.
///   Per the CSI spec the final byte is in `0x40..=0x7E` (`@`, `A-Z`,
///   `[ \ ] ^ _`, `` ` ``, `a-z`, `{ | } ~`). We consume parameters
///   until any byte in that range so an SGR like `\x1B[1m` AND a less
///   common `\x1B[~` both terminate cleanly.
/// - **Two-char escapes** (`ESC X` where `X` ≠ `[`) — rare in log files;
///   dropped both bytes.
/// - **OSC** (`ESC ] …`) — terminated by BEL (`\x07`) or `ESC \`;
///   dropped through the terminator.
///
/// A dangling `ESC` at end-of-string is dropped (defensive — shouldn't
/// happen for a complete log line).
pub fn strip_ansi(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars();
  while let Some(c) = chars.next() {
    if c != '\x1B' {
      out.push(c);
      continue;
    }
    match chars.next() {
      None => break, // dangling ESC — drop
      Some('[') => {
        // CSI: consume params until any final-byte (`0x40..=0x7E`).
        for tc in chars.by_ref() {
          let b = tc as u32;
          if (0x40..=0x7E).contains(&b) {
            break;
          }
        }
      }
      Some(']') => {
        // OSC: consume until BEL (\x07) or the `ESC \` two-byte ST.
        while let Some(tc) = chars.next() {
          if tc == '\x07' {
            break;
          }
          if tc == '\x1B' {
            // Possible ST: peek for '\'.
            let _ = chars.next();
            break;
          }
        }
      }
      Some(_) => {} // simple two-char escape — drop both bytes
    }
  }
  out
}

// NOTE: there is deliberately NO parser here for the terminal renderer's
// pretty output. Structure comes from producers writing span-tree/v1 rows
// natively (the tento-logger span-bucket sink, enabled by
// `TENTO_APP_SPAN_BUCKET_NODE_PATH` in each service's launcher/unit); the
// recorder's text tail covers only foreign, genuinely unstructured logs and
// stores their lines raw. Re-deriving structure from rendered text was tried
// and removed — presentation output is not a data source.

#[cfg(test)]
mod tests {
  use super::*;

  fn span(id: &str, parent: Option<&str>, kind: &str, secs: i64) -> SpanRow {
    let start = DateTime::parse_from_rfc3339(&format!("2026-05-23T00:00:{secs:02}Z"))
      .unwrap()
      .with_timezone(&Utc);
    SpanRow {
      session_id: "sess".into(),
      trace_id: "root".into(),
      span_id: id.into(),
      parent_id: parent.map(String::from),
      kind: kind.into(),
      name: id.into(),
      level: "info".into(),
      start_ts: start,
      end_ts: None,
      duration_ms: Some(secs),
      attributes: "{}".into(),
      depth: parent.is_some() as u32,
      root_ts: Some(start),
    }
  }

  #[test]
  fn recompose_builds_tree_from_out_of_order_rows() {
    // Arrive deliberately scrambled: a grandchild before the root, etc.
    let rows = vec![
      span("b", Some("root"), "span", 2),   // child, later
      span("a-evt", Some("a"), "event", 1), // event under a
      span("root", None, "span", 0),        // the root, written last
      span("a", Some("root"), "span", 1),   // child, earlier
    ];
    let trees = recompose(rows);
    assert_eq!(trees.len(), 1, "one root");
    let root = &trees[0];
    assert_eq!(root.row.span_id, "root");
    // children ordered by start_ts: a (1s) before b (2s)
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].row.span_id, "a");
    assert_eq!(root.children[1].row.span_id, "b");
    // a has the event child
    assert_eq!(root.children[0].children.len(), 1);
    assert_eq!(root.children[0].children[0].row.kind, "event");
  }

  #[test]
  fn parquet_round_trip_preserves_rows() {
    let rows = vec![
      span("root", None, "span", 0),
      span("a", Some("root"), "event", 1),
    ];
    let batch = SpanRow::to_batch(&rows).unwrap();
    let back = SpanRow::from_batch(&batch);
    assert_eq!(back, rows);
  }

  #[test]
  fn from_batch_defaults_depth_and_root_ts_for_old_schema() {
    // The pre-annotation 11-column schema (no `depth` / `root_ts` columns) — old
    // parquet already on disk. `from_batch` must read it without panicking and
    // default the missing fields.
    let schema = Arc::new(Schema::new(vec![
      Field::new("session_id", DataType::Utf8, false),
      Field::new("trace_id", DataType::Utf8, false),
      Field::new("span_id", DataType::Utf8, false),
      Field::new("parent_id", DataType::Utf8, true),
      Field::new("kind", DataType::Utf8, false),
      Field::new("name", DataType::Utf8, false),
      Field::new("level", DataType::Utf8, false),
      Field::new("start_ts", DataType::Utf8, false),
      Field::new("end_ts", DataType::Utf8, true),
      Field::new("duration_ms", DataType::Int64, true),
      Field::new("attributes", DataType::Utf8, false),
    ]));
    let cols: Vec<ArrayRef> = vec![
      Arc::new(StringArray::from(vec!["sess"])),
      Arc::new(StringArray::from(vec!["root"])),
      Arc::new(StringArray::from(vec!["a"])),
      Arc::new(StringArray::from(vec![None::<&str>])),
      Arc::new(StringArray::from(vec!["span"])),
      Arc::new(StringArray::from(vec!["a"])),
      Arc::new(StringArray::from(vec!["info"])),
      Arc::new(StringArray::from(vec!["2026-05-23T00:00:00.000Z"])),
      Arc::new(StringArray::from(vec![None::<&str>])),
      Arc::new(Int64Array::from(vec![None::<i64>])),
      Arc::new(StringArray::from(vec!["{}"])),
    ];
    let batch = RecordBatch::try_new(schema, cols).unwrap();
    let rows = SpanRow::from_batch(&batch);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].span_id, "a");
    assert_eq!(rows[0].depth, 0, "old parquet → depth defaults to 0");
    assert_eq!(rows[0].root_ts, None, "old parquet → no root_ts");
  }

  #[test]
  fn ts_key_is_unique_per_span() {
    let a = span("a", None, "span", 0);
    let b = span("b", None, "span", 0); // same start_ts, different span_id
    assert_ne!(a.ts_key(), b.ts_key());
  }

  #[test]
  fn strip_ansi_removes_csi_sgr_sequences() {
    let s = "\x1B[31merror\x1B[0m: connect refused";
    assert_eq!(strip_ansi(s), "error: connect refused");
  }

  #[test]
  fn strip_ansi_handles_256_color_sgr_with_semicolons() {
    let s = "\x1B[38;5;238mS\x1B[0m \x1B[38;5;239mtento-cloudflare/src/utils.rs:97\x1B[0m";
    assert_eq!(strip_ansi(s), "S tento-cloudflare/src/utils.rs:97");
  }

  #[test]
  fn strip_ansi_plain_text_is_unchanged() {
    let s = "no escapes here [just brackets]";
    assert_eq!(strip_ansi(s), s);
  }

  #[test]
  fn strip_ansi_consumes_osc_through_bel() {
    let s = "before\x1B]0;title\x07after";
    assert_eq!(strip_ansi(s), "beforeafter");
  }

  /// CSI's final byte is anything in `0x40..=0x7E` — not just letters.
  #[test]
  fn strip_ansi_csi_terminates_on_full_final_byte_range() {
    assert_eq!(strip_ansi("a\x1B[5}b"), "ab");
    assert_eq!(strip_ansi("a\x1B[~b"), "ab");
    assert_eq!(strip_ansi("a\x1B[3@b"), "ab");
    assert_eq!(strip_ansi("a\x1B[1mb\x1B[0m"), "ab");
  }

  #[test]
  fn strip_ansi_drops_dangling_esc() {
    let s = "trailing escape\x1B";
    assert_eq!(strip_ansi(s), "trailing escape");
  }
}
