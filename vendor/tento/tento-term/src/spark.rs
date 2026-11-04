//! Points → a single-line block sparkline. Pure rendering: no storage or
//! scroll knowledge, so it serves any windowed numeric series. Moved down
//! from `tento-tui-data` (which keeps thin `Row`-based wrappers) so the
//! `chart/v1` shape widget in `tento-shapes` can render without pulling the
//! TUI data layer; same precedent as the `sections` serde types living here.

const BLOCKS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/// Bucket `(ts_ms, value)` points into `width` time-columns across
/// `[from_ms, to_ms]`, averaging the values that land in each column. Empty
/// columns are `None` (forward-filled by the renderer so a sparse series
/// still reads as a line). `from..to` empty or `width == 0` ⇒ empty.
pub fn bucketize_points(
  points: &[(i64, f64)],
  from_ms: i64,
  to_ms: i64,
  width: usize,
) -> Vec<Option<f64>> {
  if width == 0 || to_ms <= from_ms {
    return Vec::new();
  }
  let span = (to_ms - from_ms) as f64;
  let mut sum = vec![0.0f64; width];
  let mut count = vec![0u32; width];
  for (t_ms, value) in points {
    if *t_ms < from_ms || *t_ms > to_ms {
      continue;
    }
    let frac = (*t_ms - from_ms) as f64 / span;
    let col = ((frac * width as f64) as usize).min(width - 1);
    sum[col] += value;
    count[col] += 1;
  }
  (0..width)
    .map(|i| (count[i] > 0).then(|| sum[i] / count[i] as f64))
    .collect()
}

/// A block sparkline of bucketed `columns`, each normalized into `[lo, hi]`.
/// `None` columns before the first real value render as spaces; once a value
/// has appeared, gaps forward-fill the previous block so the line stays
/// continuous.
pub fn sparkline(columns: &[Option<f64>], lo: f64, hi: f64) -> String {
  let range = (hi - lo).max(f64::EPSILON);
  let level = |v: f64| -> char {
    let n = ((v - lo) / range).clamp(0.0, 1.0);
    BLOCKS[((n * (BLOCKS.len() - 1) as f64).round() as usize).min(BLOCKS.len() - 1)]
  };
  let mut last: Option<char> = None;
  let mut out = String::with_capacity(columns.len());
  for c in columns {
    let ch = match c {
      Some(v) => {
        let b = level(*v);
        last = Some(b);
        b
      }
      None => last.unwrap_or(' '),
    };
    out.push(ch);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bucketize_averages_within_columns() {
    let points = [(0, 0.0), (5, 10.0), (90, 90.0)];
    let cols = bucketize_points(&points, 0, 100, 10);
    assert_eq!(cols.len(), 10);
    assert_eq!(cols[0], Some(5.0)); // t=0 and t=5 both land in column 0 → avg
    assert_eq!(cols[9], Some(90.0)); // t=90 lands in the last column
    assert_eq!(cols[5], None); // nothing in the middle
  }

  #[test]
  fn sparkline_maps_extremes_and_forward_fills() {
    let cols = vec![Some(0.0), None, Some(100.0)];
    let s: Vec<char> = sparkline(&cols, 0.0, 100.0).chars().collect();
    assert_eq!(s[0], '▁'); // low
    assert_eq!(s[1], '▁'); // gap forward-fills the previous block
    assert_eq!(s[2], '█'); // high
  }

  #[test]
  fn sparkline_leading_gaps_are_spaces() {
    let cols = vec![None, None, Some(50.0)];
    let s: Vec<char> = sparkline(&cols, 0.0, 100.0).chars().collect();
    assert_eq!(s[0], ' ');
    assert_eq!(s[1], ' ');
  }
}
