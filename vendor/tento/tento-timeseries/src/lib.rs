//! `tento-timeseries` — a generic time-series store shared by node data
//! **buckets** and the fleet **edge cache**.
//!
//! A [`SeriesRow`] is "a timestamp + a serde/arrow codec"; the framework reads
//! only the timestamp and treats the rest of the row as opaque. [`TimeSeriesStore`]
//! is the ljson-hot → daily/weekly parquet rollup engine (ported from the
//! host-health store, generalized over the row). [`CellRow`] is the point-cell
//! shape (`cell/v1`); the span-tree shape (`SpanRow`) lives in `tento-logger-spans`
//! and plugs into the same store.

pub mod cell;
pub mod check;
pub mod compact;
pub mod row;
pub mod store;

pub use cell::CellRow;
pub use check::CheckRow;
pub use compact::{CompactStats, CompactionLimits};
pub use row::SeriesRow;
pub use store::{RollupReport, StoreSummary, TimeSeriesStore};
