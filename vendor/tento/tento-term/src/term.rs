//! Terminal-width detection.

/// Columns to render to: `$COLUMNS` if set to a positive integer, otherwise the
/// terminal's actual width (ioctl), otherwise `80`. Always at least `20`.
pub fn term_columns() -> usize {
  if let Some(c) = std::env::var("COLUMNS")
    .ok()
    .and_then(|v| v.trim().parse::<i64>().ok())
    .filter(|&n| n > 0)
  {
    return (c as usize).max(20);
  }
  if let Some((terminal_size::Width(w), _)) = terminal_size::terminal_size() {
    if w > 0 {
      return (w as usize).max(20);
    }
  }
  80
}
