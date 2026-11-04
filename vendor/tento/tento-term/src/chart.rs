//! `chart/v1` — a windowed multi-series sparkline render shape.
//!
//! The serde types live here (alongside [`TableBody`](crate::table::TableBody)
//! and [`SectionsBody`](crate::sections::SectionsBody)) so a producer only
//! needs `tento-term` to emit the shape; dispatch/rendering lives in the shape
//! registry (`tento-shapes`). A series carries inline `points` or a `source`
//! DataRef (`{"kind":"bucket", …}` for a windowed node-bucket feed) resolved
//! by the host at paint time. See the tento-shell project doc
//! `render-shapes.md` for window defaults and layout.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The shape id for a `chart/v1` turn-item / pane `stdout`.
pub const CHART_V1: &str = "chart/v1";

/// A shape-tagged chart, so a serialized value self-describes as
/// `{ "shape":"chart/v1", "series":[…] }`. Build via [`ChartBody::new`].
#[derive(Debug, Serialize, Deserialize)]
pub struct ChartBody {
  pub shape: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  /// Both bounds zero ⇒ the renderer derives the window (inline points'
  /// min/max ts; trailing default for source-backed series).
  #[serde(default)]
  pub window: ChartWindow,
  pub series: Vec<ChartSeries>,
}

/// `[from_ms, to_ms]` epoch-millisecond window the series are bucketed over.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
pub struct ChartWindow {
  pub from_ms: i64,
  pub to_ms: i64,
}

/// One labelled series: inline `(ts_ms, value)` points, or a `source`
/// DataRef the host resolves per paint. A series carrying neither (or an
/// unresolvable source) renders one diagnostic line, never an error.
#[derive(Debug, Serialize, Deserialize)]
pub struct ChartSeries {
  pub label: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub points: Option<Vec<(i64, f64)>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source: Option<Value>,
}

impl ChartBody {
  pub fn new(series: Vec<ChartSeries>) -> Self {
    ChartBody {
      shape: CHART_V1.to_string(),
      title: None,
      window: ChartWindow::default(),
      series,
    }
  }

  pub fn with_title(mut self, title: impl Into<String>) -> Self {
    self.title = Some(title.into());
    self
  }

  pub fn with_window(mut self, from_ms: i64, to_ms: i64) -> Self {
    self.window = ChartWindow { from_ms, to_ms };
    self
  }
}

impl ChartSeries {
  /// An inline-points series.
  pub fn points(label: impl Into<String>, points: Vec<(i64, f64)>) -> Self {
    ChartSeries {
      label: label.into(),
      points: Some(points),
      source: None,
    }
  }

  /// A source-backed series (resolved by the host per paint).
  pub fn source(label: impl Into<String>, source: Value) -> Self {
    ChartSeries {
      label: label.into(),
      points: None,
      source: Some(source),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The serialized body leads with the shape tag; points round-trip as
  /// `[ts, value]` pairs — the structure the registry dispatches on.
  #[test]
  fn chart_body_tags_shape_and_round_trips() {
    let body = ChartBody::new(vec![
      ChartSeries::points("host-a", vec![(0, 1.0), (60_000, 2.5)]),
      ChartSeries::source(
        "host-b",
        serde_json::json!({"kind": "bucket", "node": "server-app", "name": "cpu"}),
      ),
    ])
    .with_title("p95 latency")
    .with_window(0, 120_000);

    let json = serde_json::to_value(&body).unwrap();
    assert_eq!(json["shape"], CHART_V1);
    assert_eq!(
      json["series"][0]["points"][1],
      serde_json::json!([60_000, 2.5])
    );
    assert_eq!(json["series"][1]["source"]["kind"], "bucket");

    let back: ChartBody = serde_json::from_str(&json.to_string()).unwrap();
    assert_eq!(back.window.to_ms, 120_000);
    assert_eq!(back.series.len(), 2);
    assert!(back.series[1].points.is_none());
  }
}
