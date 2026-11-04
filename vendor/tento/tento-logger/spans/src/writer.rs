//! `StreamEventWriter` — appends synthesized event rows to one named stream
//! bucket (`<root>/<host>/<node-path>/<bucket>`).
//!
//! A **stream** is a bucket whose name identifies a node's log channel
//! (`bundling`, `startup`, the recorder's `logs`, …) and whose rows are
//! [`SpanRow::synthesized_event`]s. Naming the bucket after the stream keeps
//! the whole pipeline discovery-driven: the pull mirrors it, retention prunes
//! it by the policy stamped here, the TUI lists it as a toggleable stream,
//! and an agent addresses it as `--stream <bucket>` — all without
//! registration anywhere.
//!
//! The writer is deliberately dumb: lazily ensure the bucket on first
//! append, then append. No env reads — callers resolve
//! `buckets_root`/`host`/`node_path` at their own call site and pass an
//! explicit [`StreamBucketSpec`].

use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use tento_buckets::{Bucket, RetentionPolicy};
use tento_timeseries::TimeSeriesStore;

use crate::{SHAPE_TAG, SpanRow};

/// Where a stream bucket lives. All fields explicit — the writer never
/// consults the environment.
#[derive(Debug, Clone)]
pub struct StreamBucketSpec {
  pub buckets_root: std::path::PathBuf,
  /// The service's host id (the top bucket-namespace segment).
  pub host: String,
  /// Slash-path under the host (e.g. `loaf`).
  pub node_path: String,
  /// The stream name — doubles as the bucket name (e.g. `bundling`).
  pub bucket: String,
  /// Stamped into `meta.json` at open. Synthesized text streams should pass
  /// [`synthesized_text_retention`](crate::synthesized_text_retention), not
  /// `None` (which would fall back to the much longer span-shape default).
  pub retention: Option<RetentionPolicy>,
}

/// Appends `kind: "event"` rows to one stream bucket. Cheap to construct;
/// the bucket itself (dir + `meta.json`) is ensured **lazily on the first
/// append**, so a producer that never emits a line never registers an empty
/// stream (e.g. released-mode loaf, whose bundler is disabled). A per-writer
/// monotone `seq` is injected into each row's `attributes` so consumers can
/// detect gaps/duplicates within a session.
pub struct StreamEventWriter {
  spec: StreamBucketSpec,
  store: std::sync::OnceLock<TimeSeriesStore<SpanRow>>,
  session_id: String,
  seq: AtomicI64,
}

impl StreamEventWriter {
  /// Bind a writer to a stream bucket. Infallible — the bucket is created
  /// (with the spec's shape + retention stamped into `meta.json`) on the
  /// first [`append`](Self::append). `session_id` namespaces this producer
  /// run, mirroring the per-app-lifetime id a native tracing producer
  /// writes — pass the framework spawn-id when available.
  pub fn new(spec: StreamBucketSpec, session_id: String) -> Self {
    Self {
      spec,
      store: std::sync::OnceLock::new(),
      session_id,
      seq: AtomicI64::new(0),
    }
  }

  fn store(&self) -> Result<&TimeSeriesStore<SpanRow>> {
    if let Some(s) = self.store.get() {
      return Ok(s);
    }
    let bucket = Bucket::ensure_nested(
      &self.spec.buckets_root,
      &self.spec.host,
      &self.spec.node_path,
      &self.spec.bucket,
      SHAPE_TAG,
      self.spec.retention.clone(),
    )
    .with_context(|| {
      format!(
        "ensure stream bucket {}/{}/{}/{}",
        self.spec.buckets_root.display(),
        self.spec.host,
        self.spec.node_path,
        self.spec.bucket
      )
    })?;
    // A concurrent first-append may have won the set; ensure_nested is
    // idempotent, so either store is equivalent.
    let _ = self.store.set(TimeSeriesStore::new(bucket.dir));
    Ok(self.store.get().expect("just set"))
  }

  /// Append one synthesized event. `attributes` must be a JSON object — the
  /// writer injects its monotone `seq` alongside the caller's provenance
  /// fields before serializing.
  pub fn append(
    &self,
    ts: DateTime<Utc>,
    name: &str,
    level: &str,
    attributes: serde_json::Value,
  ) -> Result<()> {
    let row = SpanRow::synthesized_event(
      &self.session_id,
      ts,
      name,
      level,
      self.seq_attrs(attributes)?,
    );
    self.store()?.append(&row)
  }

  /// Open a RUN GROUP: append a depth-0 root row named `name` and return a
  /// handle for its identity. Rows appended via
  /// [`append_child`](Self::append_child) with this handle chain under the
  /// root, so a multi-line producer episode (one server start attempt, one
  /// bundling pass) recomposes and renders as ONE tree — collapsible,
  /// `▸N`-foldable — instead of N flat lines. Five crash-loop restarts then
  /// read as five compact trees, each ending in its failure row, not an
  /// undifferentiated wall.
  pub fn begin_run(
    &self,
    ts: DateTime<Utc>,
    name: &str,
    level: &str,
    attributes: serde_json::Value,
  ) -> Result<StreamRunHandle> {
    let row = SpanRow::synthesized_event(
      &self.session_id,
      ts,
      name,
      level,
      self.seq_attrs(attributes)?,
    );
    self.store()?.append(&row)?;
    Ok(StreamRunHandle {
      root_id: row.span_id,
      root_ts: row.start_ts,
    })
  }

  /// Append one event as a CHILD of an open run group (see
  /// [`begin_run`](Self::begin_run)).
  pub fn append_child(
    &self,
    run: &StreamRunHandle,
    ts: DateTime<Utc>,
    name: &str,
    level: &str,
    attributes: serde_json::Value,
  ) -> Result<()> {
    let row = SpanRow::synthesized_child(
      &self.session_id,
      ts,
      name,
      level,
      self.seq_attrs(attributes)?,
      &run.root_id,
      run.root_ts,
    );
    self.store()?.append(&row)
  }

  fn seq_attrs(&self, attributes: serde_json::Value) -> Result<serde_json::Value> {
    let serde_json::Value::Object(mut attrs) = attributes else {
      bail!("stream event attributes must be a JSON object");
    };
    let seq = self.seq.fetch_add(1, Ordering::Relaxed);
    attrs.insert("seq".to_string(), serde_json::json!(seq));
    Ok(serde_json::Value::Object(attrs))
  }
}

/// Identity of an open run group: the root row's id + timestamp, threaded
/// into each child append. Plain data (no borrow of the writer) so callers
/// can stash it across await points / struct fields.
#[derive(Debug, Clone)]
pub struct StreamRunHandle {
  root_id: String,
  root_ts: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::synthesized_text_retention;

  #[test]
  fn bucket_is_lazy_and_first_append_stamps_meta() {
    let root = tempfile::tempdir().unwrap();
    let w = StreamEventWriter::new(
      StreamBucketSpec {
        buckets_root: root.path().to_path_buf(),
        host: "h1".into(),
        node_path: "loaf".into(),
        bucket: "bundling".into(),
        retention: Some(synthesized_text_retention()),
      },
      "sess".into(),
    );
    let dir = root.path().join("h1/loaf/bundling");
    assert!(
      !dir.exists(),
      "no append yet ⟹ no bucket — a quiet producer must not register an empty stream"
    );
    w.append(Utc::now(), "line", "info", serde_json::json!({}))
      .unwrap();
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["shape_tag"], SHAPE_TAG);
    assert_eq!(meta["retention"]["keep_hot_days"], 2);
    assert_eq!(meta["retention"]["keep_daily_days"], 14);
    assert_eq!(meta["retention"]["keep_weekly_weeks"], 12);
  }

  #[test]
  fn append_injects_monotone_seq_and_lands_in_samples() {
    let root = tempfile::tempdir().unwrap();
    let w = StreamEventWriter::new(
      StreamBucketSpec {
        buckets_root: root.path().to_path_buf(),
        host: "h1".into(),
        node_path: "loaf".into(),
        bucket: "startup".into(),
        retention: None,
      },
      "sess".into(),
    );
    // Distinct timestamps — equal-ts ordering tie-breaks on the random
    // span_id, which would make the assertions below flaky.
    let t0 = Utc::now();
    let t1 = t0 + chrono::Duration::milliseconds(5);
    w.append(t0, "first", "info", serde_json::json!({"command": "up"}))
      .unwrap();
    w.append(t1, "second", "warn", serde_json::json!({"command": "up"}))
      .unwrap();

    let store: TimeSeriesStore<SpanRow> = TimeSeriesStore::new(root.path().join("h1/loaf/startup"));
    let rows = store.tail_n(10);
    assert_eq!(rows.len(), 2);
    let attrs = |r: &SpanRow| serde_json::from_str::<serde_json::Value>(&r.attributes).unwrap();
    assert_eq!(attrs(&rows[0])["seq"], 0);
    assert_eq!(attrs(&rows[0])["command"], "up");
    assert_eq!(attrs(&rows[1])["seq"], 1);
    assert_eq!(rows[1].level, "warn");
    assert_eq!(rows[0].session_id, "sess");
    assert_eq!(rows[0].kind, "event");
    assert_eq!(rows[0].trace_id, rows[0].span_id, "self-rooted");
  }

  /// A run group recomposes as ONE tree: root at depth 0, children chained
  /// via trace/parent/root_ts at depth 1.
  #[test]
  fn run_group_rows_recompose_as_one_tree() {
    let root = tempfile::tempdir().unwrap();
    let w = StreamEventWriter::new(
      StreamBucketSpec {
        buckets_root: root.path().to_path_buf(),
        host: "h1".into(),
        node_path: "loaf".into(),
        bucket: "startup".into(),
        retention: Some(synthesized_text_retention()),
      },
      "sess".into(),
    );
    let t0 = Utc::now();
    let run = w
      .begin_run(t0, "server.run.fg", "info", serde_json::json!({}))
      .unwrap();
    w.append_child(
      &run,
      t0 + chrono::Duration::milliseconds(1),
      "starting",
      "info",
      serde_json::json!({}),
    )
    .unwrap();
    w.append_child(
      &run,
      t0 + chrono::Duration::milliseconds(2),
      "exited: couldn't bind ssl",
      "error",
      serde_json::json!({}),
    )
    .unwrap();

    let store: TimeSeriesStore<SpanRow> = TimeSeriesStore::new(root.path().join("h1/loaf/startup"));
    let rows = store.tail_n(10);
    assert_eq!(rows.len(), 3);
    let trees = crate::recompose(rows);
    assert_eq!(trees.len(), 1, "one tree per run");
    let tree = &trees[0];
    assert_eq!(tree.row.name, "server.run.fg");
    assert_eq!(tree.row.depth, 0);
    assert_eq!(tree.children.len(), 2);
    assert_eq!(tree.children[0].row.name, "starting");
    assert_eq!(tree.children[0].row.depth, 1);
    assert_eq!(tree.children[1].row.level, "error");
    assert_eq!(tree.children[1].row.root_ts, Some(tree.row.start_ts));
  }

  #[test]
  fn append_rejects_non_object_attributes() {
    let root = tempfile::tempdir().unwrap();
    let w = StreamEventWriter::new(
      StreamBucketSpec {
        buckets_root: root.path().to_path_buf(),
        host: "h1".into(),
        node_path: "n".into(),
        bucket: "s".into(),
        retention: None,
      },
      "sess".into(),
    );
    assert!(
      w.append(Utc::now(), "x", "info", serde_json::json!([1, 2]))
        .is_err()
    );
  }

  #[test]
  fn synthesized_event_is_self_rooted_and_ansi_stripped() {
    let now = Utc::now();
    let row = SpanRow::synthesized_event(
      "sess",
      now,
      "\x1B[31mboom\x1B[0m: refused",
      "error",
      serde_json::json!({}),
    );
    assert_eq!(row.kind, "event");
    assert_eq!(row.trace_id, row.span_id);
    assert_eq!(row.parent_id, None);
    assert_eq!(row.depth, 0);
    assert_eq!(row.name, "boom: refused");
    assert_eq!(row.start_ts, now);
    assert_eq!(row.root_ts, Some(now));
  }
}
