//! Initialize a span bucket with realistic multi-segment history: several days of
//! rolled `daily`/`weekly` parquet plus a hot `samples/<today>.ljson`, so a node
//! can be made to look like it has been logging for weeks. The seed rows carry the
//! denormalized `depth`/`root_ts`, so the windowed log reader renders them with
//! correct indent and can locate each trace's root.
//!
//! Usage:
//!   seed-spans --dir <bucket-dir> [--days K] [--per-day N]
//!
//! `<bucket-dir>` is the bucket leaf, e.g.
//!   ~/.tento/buckets/<host>/<node-path>/spans
//! It is created (with a `meta.json`) if absent.

use std::path::PathBuf;

use chrono::{DateTime, Duration, Utc};
use tento_logger_spans::{SHAPE_TAG, SpanRow};
use tento_timeseries::TimeSeriesStore;

fn main() {
  let mut dir: Option<PathBuf> = None;
  let mut days: i64 = 14;
  let mut per_day: i64 = 40;

  let mut args = std::env::args().skip(1);
  while let Some(a) = args.next() {
    match a.as_str() {
      "--dir" => dir = args.next().map(PathBuf::from),
      "--days" => days = args.next().and_then(|v| v.parse().ok()).unwrap_or(days),
      "--per-day" => per_day = args.next().and_then(|v| v.parse().ok()).unwrap_or(per_day),
      "-h" | "--help" => {
        eprintln!("seed-spans --dir <bucket-dir> [--days K] [--per-day N]");
        return;
      }
      other => {
        eprintln!("unknown arg: {other}");
        std::process::exit(2);
      }
    }
  }

  let Some(dir) = dir else {
    eprintln!("--dir is required");
    std::process::exit(2);
  };

  std::fs::create_dir_all(&dir).expect("create bucket dir");
  // A bucket is discoverable by its meta.json shape tag.
  let meta = dir.join("meta.json");
  if !meta.exists() {
    std::fs::write(&meta, format!("{{\"shape_tag\":\"{SHAPE_TAG}\"}}\n")).expect("write meta.json");
  }

  let store = TimeSeriesStore::<SpanRow>::new(&dir);
  let now = Utc::now();
  let mut written = 0usize;

  // Back-dated days (oldest first) → completed days roll to daily, completed weeks
  // to weekly; day 0 (today) stays hot in samples/<today>.ljson. Each day's traces
  // are anchored to that calendar date (never crossing midnight or `now`), so the
  // tier layout is clean and every row is ≤ now.
  for d in (0..days).rev() {
    let date = (now - Duration::days(d)).date_naive();
    let start = date.and_hms_opt(1, 0, 0).expect("01:00").and_utc();
    let end = if d == 0 {
      now
    } else {
      date.and_hms_opt(23, 0, 0).expect("23:00").and_utc()
    };
    let span = (end - start).num_milliseconds().max(1);
    for i in 0..per_day {
      // Spread the day's traces across the day so each lands at a distinct ts.
      let off_ms = (span * i) / per_day.max(1);
      let ts = start + Duration::milliseconds(off_ms);
      written += emit_trace(&store, d, i, ts);
    }
  }

  store.rollup().expect("rollup");

  // Report what the seed produced, the way a reader would see it.
  let from = now - Duration::days(days + 1);
  let to = now + Duration::minutes(1);
  let segs = store.segments_for_range(from, to);
  let rows = store.range_windowed(from, to);
  let ext_count = |e: &str| {
    segs
      .iter()
      .filter(|p| p.extension().and_then(|x| x.to_str()) == Some(e))
      .count()
  };
  println!("seeded {written} rows into {}", dir.display());
  println!(
    "  segments: {} parquet, {} ljson ({} total)",
    ext_count("parquet"),
    ext_count("ljson"),
    segs.len()
  );
  println!("  range_windowed over {days}d → {} rows", rows.len());
  if let (Some(first), Some(last)) = (rows.first(), rows.last()) {
    println!("  span: {} … {}", first.start_ts, last.start_ts);
  }
}

/// One trace = a root span (depth 0) with a child span (depth 1) and an event
/// (depth 2) beneath it — enough to exercise indent + root_ts trace-back.
fn emit_trace(store: &TimeSeriesStore<SpanRow>, day: i64, i: i64, ts: DateTime<Utc>) -> usize {
  let trace = format!("t-{day}-{i}");
  let root_ts = ts;
  let root = format!("{trace}-root");
  let child = format!("{trace}-child");

  let rows = [
    row(
      &trace,
      &root,
      None,
      "span",
      0,
      root_ts,
      ts,
      "handle_request",
    ),
    row(
      &trace,
      &child,
      Some(&root),
      "span",
      1,
      root_ts,
      ts + Duration::milliseconds(2),
      "db_query",
    ),
    row(
      &trace,
      &format!("{trace}-evt"),
      Some(&child),
      "event",
      2,
      root_ts,
      ts + Duration::milliseconds(5),
      "row_fetched",
    ),
  ];
  for r in &rows {
    store.append(r).expect("append");
  }
  rows.len()
}

#[allow(clippy::too_many_arguments)]
fn row(
  trace: &str,
  span: &str,
  parent: Option<&str>,
  kind: &str,
  depth: u32,
  root_ts: DateTime<Utc>,
  ts: DateTime<Utc>,
  name: &str,
) -> SpanRow {
  SpanRow {
    session_id: "seed".into(),
    trace_id: trace.into(),
    span_id: span.into(),
    parent_id: parent.map(String::from),
    kind: kind.into(),
    name: name.into(),
    level: "info".into(),
    start_ts: ts,
    end_ts: None,
    duration_ms: Some(0),
    attributes: "{}".into(),
    depth,
    root_ts: Some(root_ts),
  }
}
