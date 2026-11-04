//! `CheckRow` — the published health-check verdict shape (`check/v1`): one
//! `(field, status, detail)` result for a node plus when it was evaluated. The
//! owning host's recorder appends these on its authoritative *local* vantage; a
//! remote recorder fetches them (via the edge cache) instead of re-probing the
//! service's loopback. Kept dependency-free of `tento-nodes` (which sits above
//! the store) — `status` is the lowercase `CheckStatus` name as a string, and
//! the `Check` ↔ `CheckRow` mapping lives in the verdict-bucket node where both
//! types are in scope. The store/framework reads only `ts`.

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, RecordBatch, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::row::SeriesRow;

/// One published verdict: `{ts, seq, field, status, detail, checked_at}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CheckRow {
  /// Publish time — buckets the row into a UTC day and drives range/tail reads.
  pub ts: DateTime<Utc>,
  /// The field's index within its publishing `check()` pass. `tail_n` returns
  /// rows in `ts_key` (lexical-field) order, so a consumer sorts by `seq` to
  /// reproduce the owner's original display order.
  pub seq: i64,
  /// The leaf-check field name (one node publishes several, e.g. `"daemon"`).
  pub field: String,
  /// Lowercase `CheckStatus`: `ok` | `warn` | `fail` | `pending`.
  pub status: String,
  /// The `Check.detail` one-liner.
  pub detail: String,
  /// When the verdict was actually evaluated — the staleness clock, distinct
  /// from `ts` (the publish time), though the two are usually equal.
  pub checked_at: DateTime<Utc>,
}

/// Millisecond RFC3339 — the dedup-key prefix only.
fn rfc3339(t: DateTime<Utc>) -> String {
  t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Full-precision RFC3339 for the parquet timestamp columns.
fn rfc3339_full(t: DateTime<Utc>) -> String {
  t.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

impl SeriesRow for CheckRow {
  fn ts(&self) -> DateTime<Utc> {
    self.ts
  }

  /// Field-qualified so several fields published in the same millisecond each
  /// survive the `ts_key` dedup in `range`/`tail_n` — the default ts-only key
  /// would collapse a node's whole `check()` pass to a single row.
  fn ts_key(&self) -> String {
    format!("{}|{}", rfc3339(self.ts), self.field)
  }

  fn arrow_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
      Field::new("ts", DataType::Utf8, false),
      Field::new("seq", DataType::Int64, false),
      Field::new("field", DataType::Utf8, false),
      Field::new("status", DataType::Utf8, false),
      Field::new("detail", DataType::Utf8, false),
      Field::new("checked_at", DataType::Utf8, false),
    ]))
  }

  fn to_batch(rows: &[Self]) -> anyhow::Result<RecordBatch> {
    // The `ts` column carries the real timestamp (RFC3339) — NOT `ts_key()`,
    // which is field-qualified and would not round-trip through
    // `parse_from_rfc3339` in `from_batch`.
    let cols: Vec<ArrayRef> = vec![
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| rfc3339_full(r.ts)),
      )),
      Arc::new(Int64Array::from_iter_values(rows.iter().map(|r| r.seq))),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| r.field.as_str()),
      )),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| r.status.as_str()),
      )),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| r.detail.as_str()),
      )),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| rfc3339_full(r.checked_at)),
      )),
    ];
    Ok(RecordBatch::try_new(Self::arrow_schema(), cols)?)
  }

  fn from_batch(batch: &RecordBatch) -> Vec<Self> {
    let s = |i: usize| batch.column(i).as_any().downcast_ref::<StringArray>();
    let seq = batch.column(1).as_any().downcast_ref::<Int64Array>();
    let (Some(ts), Some(seq), Some(field), Some(status), Some(detail), Some(checked_at)) =
      (s(0), seq, s(2), s(3), s(4), s(5))
    else {
      return Vec::new();
    };
    (0..batch.num_rows())
      .filter_map(|i| {
        Some(CheckRow {
          ts: DateTime::parse_from_rfc3339(ts.value(i))
            .ok()?
            .with_timezone(&Utc),
          seq: seq.value(i),
          field: field.value(i).to_string(),
          status: status.value(i).to_string(),
          detail: detail.value(i).to_string(),
          checked_at: DateTime::parse_from_rfc3339(checked_at.value(i))
            .ok()?
            .with_timezone(&Utc),
        })
      })
      .collect()
  }

  fn try_from_batch(batch: &RecordBatch) -> anyhow::Result<Vec<Self>> {
    crate::row::check_schema(&Self::arrow_schema(), batch)?;
    let rows = Self::from_batch(batch);
    anyhow::ensure!(
      rows.len() == batch.num_rows(),
      "check/v1: decoded {} of {} rows (unparseable timestamp)",
      rows.len(),
      batch.num_rows()
    );
    Ok(rows)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::TimeSeriesStore;
  use chrono::TimeZone;

  fn temp(tag: &str) -> std::path::PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("ts-check-{tag}-{}-{n}", std::process::id()))
  }

  fn row(field: &str, status: &str, ts: DateTime<Utc>) -> CheckRow {
    CheckRow {
      ts,
      seq: 0,
      field: field.to_string(),
      status: status.to_string(),
      detail: format!("{field} detail"),
      checked_at: ts,
    }
  }

  /// Several fields published at the SAME timestamp must all survive — the
  /// field-qualified `ts_key` is the load-bearing override.
  #[test]
  fn multi_field_same_ts_all_survive_tail() {
    let dir = temp("multifield");
    let s = TimeSeriesStore::<CheckRow>::new(&dir);
    let ts = Utc.with_ymd_and_hms(2020, 1, 1, 12, 0, 0).unwrap();
    for (i, f) in ["daemon", "jvm pool", "http"].iter().enumerate() {
      s.append(&CheckRow {
        seq: i as i64,
        ..row(f, "ok", ts)
      })
      .unwrap();
    }
    let mut got: Vec<String> = s.tail_n(10).into_iter().map(|r| r.field).collect();
    got.sort();
    assert_eq!(
      got,
      vec!["daemon", "http", "jvm pool"],
      "all 3 fields kept (no ts-only dedup)"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// ljson hot → daily parquet → `from_batch` round-trips every column.
  #[test]
  fn round_trips_through_parquet_rollup() {
    let dir = temp("roundtrip");
    let s = TimeSeriesStore::<CheckRow>::new(&dir);
    let ts = Utc.with_ymd_and_hms(2020, 1, 5, 9, 30, 0).unwrap();
    s.append(&row("daemon", "warn", ts)).unwrap();
    s.rollup_daily().unwrap(); // 2020 is past → rolls to daily/<d>.parquet
    let latest = s.latest().expect("rolled row readable");
    assert_eq!(latest.field, "daemon");
    assert_eq!(latest.status, "warn");
    assert_eq!(latest.detail, "daemon detail");
    assert_eq!(latest.ts, ts);
    assert_eq!(latest.checked_at, ts);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
