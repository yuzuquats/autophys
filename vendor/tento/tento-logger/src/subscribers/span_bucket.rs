//! `SpanBucketSink` — the producer that turns the live `tracing` op stream into a
//! span-tree **bucket** on local disk, reusing the existing capture
//! ([`SlogLayer`](crate::layers) → [`TraceOp`](crate::stream)) with no new
//! tracing hooks.
//!
//! It appends one [`SpanRow`] per span (at `Close`, when the duration is known)
//! and one per event (at `Event`, immediately) into a
//! [`TimeSeriesStore<SpanRow>`](tento_timeseries::TimeSeriesStore) — the
//! `samples/*.ljson → daily/weekly parquet` bucket layout. Rows may be written
//! out of order; [`recompose`](tento_logger_spans::recompose) tolerates that.
//!
//! Stable identity: tracing's span `u64` is recycled per process, so the sink
//! mints a stable `span_id` (uuid) at `Open`, inherits `trace_id` from the parent
//! (a root sets `trace_id = own span_id`), and evicts the `u64 → identity` entry
//! at `Close`. `(session_id, span_id)` is therefore globally unique.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::ljson::LjsonLevel;
use crate::stream::{CloseOp, EventOp, FieldOp, OpenOp, TraceOp, TraceOpSink};
use tento_logger_spans::SpanRow;
use tento_timeseries::TimeSeriesStore;

/// In-flight identity for one open span, keyed by tracing's recycled `u64`.
struct Live {
  span_id: String,
  trace_id: String,
  parent_id: Option<String>,
  name: String,
  level: String,
  start_ts: DateTime<Utc>,
  fields: HashMap<String, serde_json::Value>,
  /// Nesting depth (root = 0) — inherited at open, denormalized onto each row.
  depth: u32,
  /// The trace root's start time — inherited at open (a root sets it to its own).
  root_ts: DateTime<Utc>,
}

/// Head-based trace sampling — bounds the bucket's write volume by keeping or
/// dropping a *whole* trace (decided once at its root), never partial trees.
#[derive(Clone, Copy, Debug)]
pub enum SpanSample {
  /// Keep every trace (default; today's behavior).
  All,
  /// Keep each trace with probability `keep_rate` (clamped to `0.0..=1.0`),
  /// decided once at its root span and applied to the whole trace. A trace is
  /// always kept once any `warn`/`error` span or event is seen (best-effort
  /// escalation: because writes are incremental, rows written *before* the
  /// escalation in an otherwise-dropped trace are lost — the error itself and
  /// everything after it are kept).
  Rate { keep_rate: f64 },
}

impl Default for SpanSample {
  fn default() -> Self {
    SpanSample::All
  }
}

/// Appends `SpanRow`s to a span-tree bucket from the trace op stream.
pub struct SpanBucketSink {
  store: TimeSeriesStore<SpanRow>,
  session_id: String,
  sample: SpanSample,
  live: Mutex<HashMap<u64, Live>>,
  /// Per-trace keep decision (keyed by `trace_id`), set at the root and read by
  /// every row's append; entries are evicted when their root span closes.
  trace_keep: Mutex<HashMap<String, bool>>,
}

impl SpanBucketSink {
  /// `bucket_dir` is the fully-resolved `<root>/<host>/<node-path>/<bucket>` (the
  /// caller ran `Bucket::ensure_nested` first); `session_id` names this process
  /// run; `sample` bounds write volume ([`SpanSample::All`] keeps everything).
  pub fn new(bucket_dir: impl Into<PathBuf>, session_id: Uuid, sample: SpanSample) -> Self {
    SpanBucketSink {
      store: TimeSeriesStore::new(bucket_dir.into()),
      session_id: session_id.to_string(),
      sample,
      live: Mutex::new(HashMap::new()),
      trace_keep: Mutex::new(HashMap::new()),
    }
  }

  /// Head decision for a new root/orphan trace: the sample policy, OR-ed with
  /// "always keep errors". Recorded in `trace_keep` so the whole trace follows it.
  fn decide_root_keep(&self, trace_id: &str, level: &str) {
    let keep = matches!(self.sample, SpanSample::All)
      || matches!(self.sample, SpanSample::Rate { keep_rate } if sample_keep(keep_rate, trace_id))
      || is_error_level(level);
    self
      .trace_keep
      .lock()
      .unwrap()
      .insert(trace_id.to_string(), keep);
  }

  /// Escalate a trace to "keep" once a warn/error row appears in it.
  fn escalate_if_error(&self, trace_id: &str, level: &str) {
    if is_error_level(level) {
      self
        .trace_keep
        .lock()
        .unwrap()
        .insert(trace_id.to_string(), true);
    }
  }

  /// Whether this trace's rows should be written. Unknown trace ⇒ keep (e.g. a
  /// `Close` whose root the sink never saw — never silently drop).
  fn should_keep(&self, trace_id: &str) -> bool {
    self
      .trace_keep
      .lock()
      .unwrap()
      .get(trace_id)
      .copied()
      .unwrap_or(true)
  }

  fn on_open(&self, o: &OpenOp) {
    let span_id = Uuid::new_v4().to_string();
    let level = level_str(&o.level);
    let mut live = self.live.lock().unwrap();
    // Resolve the parent's stable identity; absent/unseen parent ⇒ this is a root.
    // A child inherits depth+1 and the root's ts; a root is depth 0, root_ts = own.
    let (parent_id, trace_id, is_root, depth, root_ts) = match o.parent.and_then(|p| live.get(&p)) {
      Some(parent) => (
        Some(parent.span_id.clone()),
        parent.trace_id.clone(),
        false,
        parent.depth + 1,
        parent.root_ts,
      ),
      None => (None, span_id.clone(), true, 0, o.ts),
    };
    live.insert(
      o.id,
      Live {
        span_id,
        trace_id: trace_id.clone(),
        parent_id,
        name: o.name.clone(),
        level: level.clone(),
        start_ts: o.ts,
        fields: o.fields.clone(),
        depth,
        root_ts,
      },
    );
    drop(live);
    // A root opens the trace: make its keep/drop decision now (whole trace follows).
    if is_root {
      self.decide_root_keep(&trace_id, &level);
    }
  }

  fn on_field(&self, f: &FieldOp) {
    if let Some(l) = self.live.lock().unwrap().get_mut(&f.id) {
      for (k, v) in &f.fields {
        l.fields.insert(k.clone(), v.clone());
      }
    }
  }

  fn on_event(&self, e: &EventOp) {
    let span_id = Uuid::new_v4().to_string();
    let level = level_str(&e.level);
    let (parent_id, trace_id, is_root, depth, root_ts) = {
      let live = self.live.lock().unwrap();
      match e.parent.and_then(|p| live.get(&p)) {
        Some(parent) => (
          Some(parent.span_id.clone()),
          parent.trace_id.clone(),
          false,
          parent.depth + 1,
          parent.root_ts,
        ),
        // standalone event is its own root (depth 0, rooted at itself)
        None => (None, span_id.clone(), true, 0, e.ts),
      }
    };
    // Sampling: a standalone event is its own one-row trace (decide inline, no
    // follow-up to track); an in-span event escalates the trace on error then
    // follows its decision.
    if is_root {
      let keep = matches!(self.sample, SpanSample::All)
        || matches!(self.sample, SpanSample::Rate { keep_rate } if sample_keep(keep_rate, &trace_id))
        || is_error_level(&level);
      if !keep {
        return;
      }
    } else {
      self.escalate_if_error(&trace_id, &level);
      if !self.should_keep(&trace_id) {
        return;
      }
    }
    let row = SpanRow {
      session_id: self.session_id.clone(),
      trace_id,
      span_id,
      parent_id,
      kind: "event".into(),
      name: event_name(&e.fields),
      level,
      start_ts: e.ts,
      end_ts: None,
      duration_ms: None,
      attributes: attrs_json(&e.fields),
      depth,
      root_ts: Some(root_ts),
    };
    let _ = self.store.append(&row); // best-effort; a write failure must not panic the producer
  }

  fn on_close(&self, c: &CloseOp) {
    // Evict the recycled-u64 entry as we read it (so a later reuse mints fresh ids).
    let Some(l) = self.live.lock().unwrap().remove(&c.id) else {
      return; // Close for an id we never saw (sink attached mid-span) → drop
    };
    // Sampling: an error in this span escalates the whole trace to "keep". The
    // root closes last, so by here every child has been decided; evict the
    // trace's keep entry as the root finishes. Read the decision *before* evicting.
    self.escalate_if_error(&l.trace_id, &l.level);
    let keep = self.should_keep(&l.trace_id);
    if l.parent_id.is_none() {
      self.trace_keep.lock().unwrap().remove(&l.trace_id);
    }
    if !keep {
      return;
    }
    let duration_ms = c
      .elapsed_ms
      .or_else(|| Some((c.ts - l.start_ts).num_milliseconds()));
    let row = SpanRow {
      session_id: self.session_id.clone(),
      trace_id: l.trace_id,
      span_id: l.span_id,
      parent_id: l.parent_id,
      kind: "span".into(),
      name: l.name,
      level: l.level,
      start_ts: l.start_ts,
      end_ts: Some(c.ts),
      duration_ms,
      attributes: attrs_json(&l.fields),
      depth: l.depth,
      root_ts: Some(l.root_ts),
    };
    let _ = self.store.append(&row);
  }
}

impl TraceOpSink for SpanBucketSink {
  fn on_op(&self, op: &TraceOp) {
    match op {
      TraceOp::Open(o) => self.on_open(o),
      TraceOp::Field(f) => self.on_field(f),
      TraceOp::Event(e) => self.on_event(e),
      TraceOp::Close(c) => self.on_close(c),
    }
  }
}

/// The process-global LATE-BINDING span-bucket slot.
///
/// The tracing subscriber is installed once in `main`, BEFORE command
/// dispatch — at that point a multi-role binary (`mono`/`acme-console`)
/// doesn't yet know whether it's "the server-app server" or a one-shot CLI run.
/// [`set_global_logger`](crate::set_global_logger) therefore always
/// registers [`LateSpanBucketSink`] (inert: one atomic load per op), and a
/// process that LATER learns its node identity — a server command like
/// server-app's `server.run.fg`, the recorder daemon — calls
/// [`enable_span_bucket`] to start producing. Commands self-identify; no
/// launcher/unit env wiring required (the `TENTO_APP_SPAN_BUCKET_NODE_PATH`
/// stale-launcher bug class dies here).
static LATE_SPAN_BUCKET: std::sync::OnceLock<SpanBucketSink> = std::sync::OnceLock::new();

/// Forwards trace ops to the late-bound [`SpanBucketSink`] once
/// [`enable_span_bucket`] has run; no-op before that.
pub struct LateSpanBucketSink;

impl TraceOpSink for LateSpanBucketSink {
  fn on_op(&self, op: &TraceOp) {
    if let Some(sink) = LATE_SPAN_BUCKET.get() {
      sink.on_op(op);
    }
  }
}

/// Bind the process's span-bucket producer (see [`LateSpanBucketSink`]).
/// Ensures the bucket dir, then publishes the sink. First call wins;
/// subsequent calls are no-ops (a process has ONE node identity) — returns
/// `Ok` either way so callers don't need to track whether a launcher env
/// already bound it.
pub fn enable_span_bucket(config: crate::SpanBucketConfig) -> anyhow::Result<()> {
  if LATE_SPAN_BUCKET.get().is_some() {
    return Ok(());
  }
  let bucket = tento_buckets::Bucket::ensure_nested(
    &config.buckets_root,
    &config.host,
    &config.node_path,
    &config.bucket,
    tento_logger_spans::SHAPE_TAG,
    config.retention,
  )?;
  let dest = bucket.dir.display().to_string();
  let _ = LATE_SPAN_BUCKET.set(SpanBucketSink::new(
    bucket.dir,
    Uuid::new_v4(),
    config.sample,
  ));
  tracing::trace!("span bucket: {dest}");
  Ok(())
}

fn level_str(l: &LjsonLevel) -> String {
  match l {
    LjsonLevel::Trace => "trace",
    LjsonLevel::Debug => "debug",
    LjsonLevel::Info => "info",
    LjsonLevel::Warn => "warn",
    LjsonLevel::Error => "error",
  }
  .to_string()
}

/// A level worth keeping unconditionally (sampling never drops these traces).
fn is_error_level(level: &str) -> bool {
  matches!(level, "warn" | "error")
}

/// Deterministic per-trace head decision in `[0,1)`: hash the (already-random
/// uuid) `seed` and keep iff below `keep_rate`. Same trace ⇒ same answer (so a
/// trace is never half-written); the uuid's randomness makes it ~uniform, so no
/// rng dependency is needed.
fn sample_keep(keep_rate: f64, seed: &str) -> bool {
  if keep_rate >= 1.0 {
    return true;
  }
  if keep_rate <= 0.0 {
    return false;
  }
  let h = seed
    .bytes()
    .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
  ((h % 1_000_000) as f64 / 1_000_000.0) < keep_rate
}

/// All op fields as a JSON object string — the generic `attributes` column.
fn attrs_json(fields: &HashMap<String, serde_json::Value>) -> String {
  serde_json::to_string(fields).unwrap_or_else(|_| "{}".to_string())
}

/// An event has no span name; use its `message` field, else `"event"`.
fn event_name(fields: &HashMap<String, serde_json::Value>) -> String {
  fields
    .get("message")
    .and_then(|v| v.as_str())
    .unwrap_or("event")
    .to_string()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ljson::LjsonLocation;
  use tento_logger_spans::recompose;

  fn temp_dir(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("sbs-{tag}-{}-{n}", std::process::id()))
  }

  fn loc() -> LjsonLocation {
    LjsonLocation {
      file: None,
      line: None,
    }
  }

  fn sink(tag: &str) -> (SpanBucketSink, PathBuf) {
    let dir = temp_dir(tag);
    (
      SpanBucketSink::new(&dir, Uuid::new_v4(), SpanSample::All),
      dir,
    )
  }

  fn sink_sampled(tag: &str, sample: SpanSample) -> (SpanBucketSink, PathBuf) {
    let dir = temp_dir(tag);
    (SpanBucketSink::new(&dir, Uuid::new_v4(), sample), dir)
  }

  fn event(parent: Option<u64>, level: LjsonLevel, msg: &str) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("message".to_string(), serde_json::json!(msg));
    TraceOp::Event(EventOp {
      seq: 0,
      parent,
      session_id: None,
      ts: Utc::now(),
      level,
      loc: loc(),
      fields,
    })
  }

  fn open(id: u64, parent: Option<u64>, name: &str) -> TraceOp {
    TraceOp::Open(OpenOp {
      seq: 0,
      id,
      parent,
      session_id: None,
      ts: Utc::now(),
      name: name.into(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields: HashMap::new(),
    })
  }
  fn close(id: u64) -> TraceOp {
    TraceOp::Close(CloseOp {
      seq: 0,
      id,
      session_id: None,
      ts: Utc::now(),
      elapsed_ms: Some(5),
    })
  }

  #[test]
  fn open_close_emits_one_span_row() {
    let (s, dir) = sink("oc");
    s.on_op(&open(1, None, "root"));
    s.on_op(&close(1));
    let rows = s.store.today();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "span");
    assert_eq!(rows[0].name, "root");
    assert_eq!(rows[0].parent_id, None);
    assert_eq!(rows[0].trace_id, rows[0].span_id, "root: trace == own id");
    assert_eq!(rows[0].duration_ms, Some(5));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn nested_spans_share_trace_id() {
    let (s, dir) = sink("nest");
    s.on_op(&open(1, None, "root"));
    s.on_op(&open(2, Some(1), "child"));
    s.on_op(&close(2));
    s.on_op(&close(1));
    let rows = s.store.today();
    let root = rows.iter().find(|r| r.name == "root").unwrap();
    let child = rows.iter().find(|r| r.name == "child").unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(root.span_id.as_str()));
    assert_eq!(
      child.trace_id, root.trace_id,
      "child inherits root's trace_id"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn rows_carry_depth_and_root_ts() {
    let (s, dir) = sink("depth");
    s.on_op(&open(1, None, "root"));
    s.on_op(&open(2, Some(1), "child"));
    s.on_op(&event(Some(2), LjsonLevel::Info, "evt"));
    s.on_op(&close(2));
    s.on_op(&close(1));
    let rows = s.store.today();
    let root = rows.iter().find(|r| r.name == "root").unwrap();
    let child = rows.iter().find(|r| r.name == "child").unwrap();
    let evt = rows.iter().find(|r| r.kind == "event").unwrap();
    assert_eq!(root.depth, 0);
    assert_eq!(child.depth, 1, "child is one deeper");
    assert_eq!(evt.depth, 2, "event under the child is depth 2");
    // Descendants carry the root's start_ts as root_ts; a root roots at itself.
    assert_eq!(root.root_ts, Some(root.start_ts));
    assert_eq!(child.root_ts, Some(root.start_ts));
    assert_eq!(evt.root_ts, Some(root.start_ts));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn recycled_u64_mints_new_span_id() {
    let (s, dir) = sink("recycle");
    s.on_op(&open(1, None, "a"));
    s.on_op(&close(1));
    s.on_op(&open(1, None, "b")); // SAME u64 reused after eviction
    s.on_op(&close(1));
    let rows = s.store.today();
    assert_eq!(rows.len(), 2);
    assert_ne!(
      rows[0].span_id, rows[1].span_id,
      "recycled u64 ⇒ distinct span_ids"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn event_emits_kind_event_row_under_its_span() {
    let (s, dir) = sink("event");
    s.on_op(&open(1, None, "root"));
    let mut fields = HashMap::new();
    fields.insert("message".to_string(), serde_json::json!("hello"));
    s.on_op(&TraceOp::Event(EventOp {
      seq: 0,
      parent: Some(1),
      session_id: None,
      ts: Utc::now(),
      level: LjsonLevel::Warn,
      loc: loc(),
      fields,
    }));
    s.on_op(&close(1));
    let rows = s.store.today();
    let ev = rows.iter().find(|r| r.kind == "event").unwrap();
    assert_eq!(ev.name, "hello");
    assert_eq!(ev.level, "warn");
    assert!(ev.attributes.contains("hello"));
    let root = rows.iter().find(|r| r.kind == "span").unwrap();
    assert_eq!(ev.parent_id.as_deref(), Some(root.span_id.as_str()));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn fields_merge_into_attributes_json() {
    let (s, dir) = sink("fields");
    s.on_op(&open(1, None, "root"));
    let mut f = HashMap::new();
    f.insert("http.status".to_string(), serde_json::json!(200));
    s.on_op(&TraceOp::Field(FieldOp {
      seq: 0,
      id: 1,
      session_id: None,
      ts: Utc::now(),
      fields: f,
    }));
    s.on_op(&close(1));
    let rows = s.store.today();
    assert!(
      rows[0].attributes.contains("http.status"),
      "{}",
      rows[0].attributes
    );
    assert!(rows[0].attributes.contains("200"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn round_trip_via_recompose() {
    let (s, dir) = sink("recompose");
    // root → child → grandchild, closed innermost-first (rows stream bottom-up).
    s.on_op(&open(1, None, "root"));
    s.on_op(&open(2, Some(1), "child"));
    s.on_op(&open(3, Some(2), "grandchild"));
    s.on_op(&close(3));
    s.on_op(&close(2));
    s.on_op(&close(1));
    let trees = recompose(s.store.today());
    assert_eq!(trees.len(), 1, "one root trace");
    assert_eq!(trees[0].row.name, "root");
    assert_eq!(trees[0].children[0].row.name, "child");
    assert_eq!(trees[0].children[0].children[0].row.name, "grandchild");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn close_for_unseen_id_is_dropped() {
    let (s, dir) = sink("unseen");
    s.on_op(&close(99)); // never opened
    assert_eq!(s.store.today().len(), 0);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn sample_rate_zero_drops_a_whole_trace() {
    let (s, dir) = sink_sampled("drop", SpanSample::Rate { keep_rate: 0.0 });
    s.on_op(&open(1, None, "root"));
    s.on_op(&open(2, Some(1), "child"));
    s.on_op(&close(2));
    s.on_op(&close(1));
    assert_eq!(s.store.today().len(), 0, "rate 0 ⇒ drop the entire trace");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn sample_rate_one_keeps_everything() {
    let (s, dir) = sink_sampled("keep", SpanSample::Rate { keep_rate: 1.0 });
    s.on_op(&open(1, None, "root"));
    s.on_op(&close(1));
    assert_eq!(s.store.today().len(), 1, "rate 1 ⇒ keep");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn error_event_rescues_a_sampled_out_trace() {
    // rate 0 would drop this trace, but a warn event escalates it to "keep".
    let (s, dir) = sink_sampled("rescue", SpanSample::Rate { keep_rate: 0.0 });
    s.on_op(&open(1, None, "root"));
    s.on_op(&event(Some(1), LjsonLevel::Warn, "boom")); // escalates the trace
    s.on_op(&close(1));
    let rows = s.store.today();
    assert!(
      rows.iter().any(|r| r.kind == "event" && r.level == "warn"),
      "the warn event is kept"
    );
    assert!(
      rows.iter().any(|r| r.kind == "span" && r.name == "root"),
      "the root span (closes after the escalation) is kept too"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn root_close_evicts_trace_keep_so_recycled_ids_redecide() {
    // A dropped trace's keep entry must not leak onto the next trace that reuses
    // the same u64 — each root makes its own decision.
    let (s, dir) = sink_sampled("evict", SpanSample::Rate { keep_rate: 1.0 });
    s.on_op(&open(1, None, "a"));
    s.on_op(&close(1));
    s.on_op(&open(1, None, "b")); // same u64, new trace_id
    s.on_op(&close(1));
    assert_eq!(s.store.today().len(), 2, "both kept; no stale keep state");
    assert!(
      s.trace_keep.lock().unwrap().is_empty(),
      "evicted at root close"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn standalone_error_event_is_kept_even_at_rate_zero() {
    let (s, dir) = sink_sampled("orphan-err", SpanSample::Rate { keep_rate: 0.0 });
    s.on_op(&event(None, LjsonLevel::Error, "standalone boom"));
    let rows = s.store.today();
    assert_eq!(rows.len(), 1, "orphan error event kept despite rate 0");
    assert_eq!(rows[0].level, "error");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
