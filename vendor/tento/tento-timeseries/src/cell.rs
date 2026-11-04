//! `CellRow` — the point-in-time **cell** shape (`cell/v1`): an id, a timestamp,
//! and an arbitrary `json::Value` payload (stored as a JSON string). Mirrors
//! lona's `SheetCellRecord`/`Cell` point cell; host metrics (cpu/ram/disk) and
//! any other point time-series use it. The store/framework never reads `data` —
//! only a renderer interprets it.
//!
//! A cell's read identity is `(ts, id)`, not `ts` alone: `cpu`, `ram` and `disk`
//! sampled in one millisecond are three cells, and two event rows that share an
//! instant are two events. The store dedups across storage tiers by
//! [`SeriesRow::ts_key`], so that key carries the id; the parquet `ts` column is
//! written as plain RFC3339 and never from the key.

use std::sync::Arc;

use arrow::array::{ArrayRef, RecordBatch, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::row::SeriesRow;

/// A point cell: `{id, ts, data}` where `data` is an opaque JSON string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CellRow {
  pub id: String,
  pub ts: DateTime<Utc>,
  /// Arbitrary `json::Value`, serialized as a JSON string (e.g. `{"cpu":12}`).
  pub data: String,
}

/// Millisecond RFC3339 — the dedup-key prefix only.
fn rfc3339(t: DateTime<Utc>) -> String {
  t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Full-precision RFC3339 for the parquet `ts` column (see the precision rule
/// on [`SeriesRow::arrow_schema`]).
fn rfc3339_full(t: DateTime<Utc>) -> String {
  t.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

impl SeriesRow for CellRow {
  fn ts(&self) -> DateTime<Utc> {
    self.ts
  }

  /// Timestamp first (so the store's maps stay chronological), id second (so
  /// distinct cells in one millisecond are distinct rows). The default ts-only
  /// key made `range`/`tail_n` keep one row per millisecond: a 500-row
  /// acknowledgement batch stamped with one `now` read back as a single entry,
  /// and two leads or two touches in one instant became one.
  fn ts_key(&self) -> String {
    format!("{}|{}", rfc3339(self.ts), self.id)
  }

  fn arrow_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
      Field::new("id", DataType::Utf8, false),
      Field::new("ts", DataType::Utf8, false),
      Field::new("data", DataType::Utf8, false),
    ]))
  }

  fn to_batch(rows: &[Self]) -> anyhow::Result<RecordBatch> {
    let cols: Vec<ArrayRef> = vec![
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| r.id.as_str()),
      )),
      // The timestamp column is a timestamp, not the dedup key: `from_batch`
      // parses it as RFC3339.
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| rfc3339_full(r.ts)),
      )),
      Arc::new(StringArray::from_iter_values(
        rows.iter().map(|r| r.data.as_str()),
      )),
    ];
    Ok(RecordBatch::try_new(Self::arrow_schema(), cols)?)
  }

  fn from_batch(batch: &RecordBatch) -> Vec<Self> {
    let s = |i: usize| batch.column(i).as_any().downcast_ref::<StringArray>();
    let (Some(id), Some(ts), Some(data)) = (s(0), s(1), s(2)) else {
      return Vec::new();
    };
    (0..batch.num_rows())
      .filter_map(|i| {
        Some(CellRow {
          id: id.value(i).to_string(),
          ts: DateTime::parse_from_rfc3339(ts.value(i))
            .ok()?
            .with_timezone(&Utc),
          data: data.value(i).to_string(),
        })
      })
      .collect()
  }

  fn try_from_batch(batch: &RecordBatch) -> anyhow::Result<Vec<Self>> {
    crate::row::check_schema(&Self::arrow_schema(), batch)?;
    let s = |i: usize| batch.column(i).as_any().downcast_ref::<StringArray>();
    let (Some(id), Some(ts), Some(data)) = (s(0), s(1), s(2)) else {
      anyhow::bail!("cell/v1 columns are not utf8");
    };
    (0..batch.num_rows())
      .map(|i| {
        Ok(CellRow {
          id: id.value(i).to_string(),
          ts: DateTime::parse_from_rfc3339(ts.value(i))
            .map_err(|e| anyhow::anyhow!("row {i}: ts {:?}: {e}", ts.value(i)))?
            .with_timezone(&Utc),
          data: data.value(i).to_string(),
        })
      })
      .collect()
  }
}
