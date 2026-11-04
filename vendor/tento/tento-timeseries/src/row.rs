//! [`SeriesRow`] — the one thing a [`TimeSeriesStore`](crate::TimeSeriesStore)
//! needs to know about a row: its timestamp (for day-bucketing, range filtering,
//! and dedup) and how to (de)serialize it to ljson + parquet. Everything else —
//! the row's actual fields, its "shape" — is opaque to the store.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;

use arrow::array::RecordBatch;
use arrow::datatypes::Schema;

/// A storable time-series row. `serde` drives the ljson hot file; the arrow
/// methods drive the rolled-up parquet.
pub trait SeriesRow: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {
  /// When this row happened — buckets it into a UTC day and drives range queries.
  fn ts(&self) -> DateTime<Utc>;

  /// A fixed-width, chronologically-sortable key used to dedup the **same row**
  /// when it appears in more than one storage tier (a hot `samples` line and
  /// its rolled-up parquet copy). Default = RFC3339-`Z` to millis (lexical
  /// order == time order), which is only correct for a series that has at most
  /// one row per millisecond. Any row type that can legitimately record two
  /// distinct rows in one millisecond — events, cells with several ids, spans —
  /// must qualify the key with its identity, timestamp first so the order is
  /// still chronological: see `CellRow`, `CheckRow` and the span row. Never
  /// store this key as the row's timestamp column; it is a map key, not a time.
  fn ts_key(&self) -> String {
    self.ts().to_rfc3339_opts(SecondsFormat::Millis, true)
  }

  /// The parquet/arrow column schema for this row type.
  ///
  /// **Precision rule:** `to_batch` must preserve the row's timestamps at the
  /// precision the ljson hot file carries (chrono's full RFC3339, i.e. up to
  /// nanoseconds), so a row reads identically before and after compaction.
  /// `CellRow` and `CheckRow` write `SecondsFormat::AutoSi`; only `ts_key`
  /// (a dedup map key) is millisecond-truncated.
  fn arrow_schema() -> Arc<Schema>;

  /// Encode rows to a single arrow `RecordBatch` (column order matches
  /// [`arrow_schema`](SeriesRow::arrow_schema)).
  fn to_batch(rows: &[Self]) -> anyhow::Result<RecordBatch>;

  /// Decode a `RecordBatch` back to rows (best-effort: rows or columns it
  /// cannot decode are dropped). Strict callers use
  /// [`try_from_batch`](SeriesRow::try_from_batch).
  fn from_batch(batch: &RecordBatch) -> Vec<Self>;

  /// Decode a `RecordBatch`, failing on a schema mismatch or any undecodable
  /// row instead of returning fewer rows. The default wraps
  /// [`from_batch`](SeriesRow::from_batch) and requires it to decode exactly
  /// `batch.num_rows()` rows (so a wrong-shape file is an error, not an empty
  /// vec); row types override it to report the precise column/row.
  fn try_from_batch(batch: &RecordBatch) -> anyhow::Result<Vec<Self>> {
    let rows = Self::from_batch(batch);
    anyhow::ensure!(
      rows.len() == batch.num_rows(),
      "decoded {} of {} rows (schema mismatch or undecodable rows)",
      rows.len(),
      batch.num_rows()
    );
    Ok(rows)
  }
}

/// Check that `batch`'s columns match `expected` by name and data type (in
/// order). Nullability is not compared.
pub fn check_schema(expected: &Schema, batch: &RecordBatch) -> anyhow::Result<()> {
  let got = batch.schema();
  let names = |s: &Schema| {
    s.fields()
      .iter()
      .map(|f| format!("{}:{}", f.name(), f.data_type()))
      .collect::<Vec<_>>()
  };
  let (want, have) = (names(expected), names(&got));
  anyhow::ensure!(want == have, "schema mismatch: expected {want:?}, found {have:?}");
  Ok(())
}
