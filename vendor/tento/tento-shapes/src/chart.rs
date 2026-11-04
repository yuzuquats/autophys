use serde_json::Value;
use tento_term::chart::{CHART_V1, ChartBody, ChartSeries};
use tento_term::spark::{bucketize_points, sparkline};
use tento_term::{BOLD, RESET, human_age_ms, pad_right, truncate_ellipsis, visual_width};

use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};

/// Label column cap; longer series labels ellipsize.
const LABEL_MAX: usize = 16;
/// Sparkline floor — below this the chart is unreadable, so the row wins
/// over the requested width.
const SPARK_MIN: usize = 8;
/// Window when nothing pins one: source-backed series with a zeroed window
/// chart the trailing 15 minutes.
const DEFAULT_TRAILING_MS: i64 = 15 * 60 * 1000;

/// `chart/v1` — one block-sparkline row per series over a shared window and
/// a shared `[lo, hi]` value range (rows are visually comparable). Inline
/// `points` render directly; a per-series `source` DataRef resolves through
/// `ctx.resolver.resolve_points` fresh on every paint — the same live loop
/// as file-backed tables. A series that resolves to nothing degrades to a
/// per-series note, never an error.
///
/// Path scheme: series rows are `<base>/series:<i>`; the title line is
/// chrome. Selecting a row fires `(label, last, min, max)` attrs.
pub struct ChartWidget;

impl ShapeWidget for ChartWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[CHART_V1]
  }

  fn render(
    &self,
    value: &Value,
    width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    let Ok(body) = serde_json::from_value::<ChartBody>(value.clone()) else {
      return ShapeOutput::diagnostic("  (chart/v1: malformed)");
    };
    if body.series.is_empty() {
      return ShapeOutput::diagnostic("  (chart/v1: no series)");
    }

    let (from_ms, to_ms) = window(&body);
    let resolved: Vec<(String, Option<Vec<(i64, f64)>>)> = body
      .series
      .iter()
      .map(|s| (s.label.clone(), series_points(s, ctx, from_ms, to_ms)))
      .collect();

    // One shared value range across every series, from the raw in-window
    // points (the legend reflects data, not bucket averages).
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for (_, points) in resolved.iter() {
      for (t, v) in points.iter().flatten() {
        if *t >= from_ms && *t <= to_ms && v.is_finite() {
          lo = lo.min(*v);
          hi = hi.max(*v);
        }
      }
    }
    if !lo.is_finite() {
      (lo, hi) = (0.0, 1.0);
    }

    let label_w = resolved
      .iter()
      .map(|(l, _)| visual_width(l).min(LABEL_MAX))
      .max()
      .unwrap_or(0);
    let spark_w = (width as usize).saturating_sub(label_w + 2).max(SPARK_MIN);

    let mut out = ShapeOutput::default();

    // Title line (chrome): name left, `lo..hi · span` legend right-aligned.
    let title = body.title.as_deref().unwrap_or("(chart)");
    let legend = format!(
      "{}..{} · {}",
      fmt_num(lo),
      fmt_num(hi),
      human_age_ms(to_ms, from_ms)
    );
    let total = label_w + 2 + spark_w;
    let gap = total
      .saturating_sub(visual_width(title) + visual_width(&legend))
      .max(2);
    out
      .lines
      .push(format!("{BOLD}{title}{RESET}{:gap$}{legend}", ""));
    out.paths.push(None);

    for (i, (label, points)) in resolved.iter().enumerate() {
      let shown = truncate_ellipsis(label, label_w, "…");
      let padded = pad_right(&shown, label_w);
      match points {
        Some(points) if !points.is_empty() => {
          let cols = bucketize_points(points, from_ms, to_ms, spark_w);
          out
            .lines
            .push(format!("{padded}  {}", sparkline(&cols, lo, hi)));
          out
            .paths
            .push(ctx.base_path.map(|b| format!("{b}/series:{i}")));
          if let Some(path) = ctx.base_path.map(|b| format!("{b}/series:{i}")) {
            let in_window: Vec<f64> = points
              .iter()
              .filter(|(t, _)| *t >= from_ms && *t <= to_ms)
              .map(|(_, v)| *v)
              .collect();
            let smin = in_window.iter().copied().fold(f64::INFINITY, f64::min);
            let smax = in_window.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            out.attrs.push((
              path,
              vec![
                ("SERIES".to_string(), label.clone()),
                (
                  "LAST".to_string(),
                  in_window
                    .last()
                    .map(|v| fmt_num(*v))
                    .unwrap_or_else(|| "-".into()),
                ),
                ("MIN".to_string(), fmt_num(smin)),
                ("MAX".to_string(), fmt_num(smax)),
              ],
            ));
          }
        }
        // No inline points and no resolvable source: a per-series note —
        // on the CLI this is the expected degrade for `kind:"bucket"`.
        _ => {
          out
            .lines
            .push(format!("{padded}  (no data / unresolved source)"));
          out.paths.push(None);
        }
      }
    }
    out
  }
}

/// Points for one series: inline wins, then `source` via the resolver.
fn series_points(
  s: &ChartSeries,
  ctx: &RenderCtx,
  from_ms: i64,
  to_ms: i64,
) -> Option<Vec<(i64, f64)>> {
  if let Some(points) = &s.points {
    return Some(points.clone());
  }
  let source = s.source.as_ref()?;
  ctx.resolver.resolve_points(source, from_ms, to_ms)
}

/// The chart window: explicit when either bound is set; otherwise derived
/// from the inline points' ts range, or — all series source-backed — the
/// trailing [`DEFAULT_TRAILING_MS`].
fn window(body: &ChartBody) -> (i64, i64) {
  let w = body.window;
  if w.from_ms != 0 || w.to_ms != 0 {
    return (w.from_ms, w.to_ms);
  }
  let ts: Vec<i64> = body
    .series
    .iter()
    .flat_map(|s| s.points.iter().flatten().map(|(t, _)| *t))
    .collect();
  match (ts.iter().min(), ts.iter().max()) {
    (Some(&a), Some(&b)) if b > a => (a, b),
    // A single instant still needs a non-empty window to bucket into.
    (Some(&a), Some(_)) => (a - 1, a + 1),
    _ => {
      let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
      (now - DEFAULT_TRAILING_MS, now)
    }
  }
}

/// Compact legend/attr number: integers stay integral, small values keep
/// enough precision to differ.
fn fmt_num(v: f64) -> String {
  if !v.is_finite() {
    return "-".to_string();
  }
  let a = v.abs();
  if a >= 100.0 || v.fract() == 0.0 {
    format!("{v:.0}")
  } else if a >= 1.0 {
    format!("{v:.1}")
  } else {
    format!("{v:.2}")
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;

  use serde_json::json;

  use super::*;
  use crate::FileSourceResolver;
  use crate::registry::EMPTY_WIDGET_STATE as EMPTY_STATE;

  fn ctx<'a>(collapsed: &'a HashSet<String>) -> RenderCtx<'a> {
    RenderCtx {
      base_path: Some("turn:5"),
      collapsed,
      widget_state: &EMPTY_STATE,
      resolver: &FileSourceResolver,
      depth: 0,
    }
  }

  fn two_series() -> Value {
    json!({
      "shape": "chart/v1",
      "title": "p95 latency",
      "series": [
        { "label": "host-a", "points": [[0, 0.0], [30_000, 50.0], [60_000, 100.0]] },
        { "label": "host-b", "points": [[0, 100.0], [60_000, 0.0]] },
      ],
    })
  }

  /// Series rows carry `series:<i>` paths and `(label, last, min, max)`
  /// attrs; the title legend reflects the global range and derived window.
  #[test]
  fn series_rows_are_addressable_with_summary_attrs() {
    let collapsed = HashSet::new();
    let out = ShapeRegistry::core()
      .render(&two_series(), 60, &ctx(&collapsed))
      .expect("renders");
    assert_eq!(out.paths[0], None, "title is chrome");
    assert_eq!(out.paths[1], Some("turn:5/series:0".into()));
    assert_eq!(out.paths[2], Some("turn:5/series:1".into()));
    let text = out.lines.join("\n");
    assert!(text.contains("p95 latency"), "{text}");
    assert!(text.contains("0..100"), "global lo..hi legend: {text}");
    assert!(text.contains("1m"), "derived 60s window in legend: {text}");

    let (path, attrs) = &out.attrs[0];
    assert_eq!(path, "turn:5/series:0");
    assert_eq!(attrs[0], ("SERIES".to_string(), "host-a".to_string()));
    assert_eq!(attrs[1], ("LAST".to_string(), "100".to_string()));
    assert_eq!(attrs[2], ("MIN".to_string(), "0".to_string()));
    assert_eq!(attrs[3], ("MAX".to_string(), "100".to_string()));
  }

  /// Both series normalize into one shared range: host-a ends high (█),
  /// host-b ends low (▁) — comparable rows, not per-row scaling.
  #[test]
  fn rows_share_a_global_value_range() {
    let collapsed = HashSet::new();
    let out = ShapeRegistry::core()
      .render(&two_series(), 60, &ctx(&collapsed))
      .expect("renders");
    let row0 = &out.lines[1];
    let row1 = &out.lines[2];
    assert_eq!(row0.chars().last(), Some('█'), "{row0}");
    assert_eq!(row1.chars().last(), Some('▁'), "{row1}");
    assert!(row0.starts_with("host-a  "), "{row0}");
  }

  /// CLI context: no paths, no attrs, same text layout.
  #[test]
  fn cli_render_is_unaddressable_but_identical_layout() {
    let out = ShapeRegistry::core()
      .render(&two_series(), 60, &RenderCtx::cli())
      .expect("renders");
    assert!(out.paths.iter().all(Option::is_none));
    assert!(out.attrs.is_empty());
    assert!(out.lines[1].starts_with("host-a  "));
  }

  /// A `kind:"bucket"` series degrades per-series under a resolver without
  /// bucket access (the CLI); other series still chart.
  #[test]
  fn unresolvable_bucket_series_degrades_per_series() {
    let collapsed = HashSet::new();
    let v = json!({
      "shape": "chart/v1",
      "window": {"from_ms": 0, "to_ms": 60_000},
      "series": [
        { "label": "inline", "points": [[0, 1.0], [60_000, 2.0]] },
        { "label": "bucket", "source": {"kind": "bucket", "node": "server-app", "name": "cpu"} },
      ],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("(no data / unresolved source)"), "{text}");
    assert!(out.paths[1].is_some(), "inline series still addressable");
    assert_eq!(out.paths[2], None, "degraded series is chrome");
  }

  #[test]
  fn malformed_and_empty_degrade_to_diagnostics() {
    let collapsed = HashSet::new();
    let reg = ShapeRegistry::core();
    let out = reg
      .render(
        &json!({"shape": "chart/v1", "series": "nope"}),
        60,
        &ctx(&collapsed),
      )
      .expect("dispatches");
    assert!(out.lines[0].contains("malformed"), "{}", out.lines[0]);
    let out = reg
      .render(
        &json!({"shape": "chart/v1", "series": []}),
        60,
        &ctx(&collapsed),
      )
      .expect("dispatches");
    assert!(out.lines[0].contains("no series"), "{}", out.lines[0]);
  }

  /// Inside sections, chart rows pick up the `sec:<i>` prefix — the same
  /// composition rule as tables.
  #[test]
  fn chart_nested_in_sections_prefixes_paths() {
    let collapsed = HashSet::new();
    let v = json!({
      "shape": "sections/v1",
      "sections": [{ "title": "Latency", "value": two_series() }],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    assert!(
      out.paths.contains(&Some("turn:5/sec:0/series:0".into())),
      "{:?}",
      out.paths
    );
  }
}
