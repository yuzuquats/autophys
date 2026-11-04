//! Cell formatting for raw row-record values — how a semantic value in a
//! `table-rows/v1` record (a byte count, an epoch-ms timestamp) becomes the
//! display text of a table cell. Shared by the renderer-side projection
//! (tento-shapes' `table/v1` records branch) and any CLI fallback that builds
//! the same projection inline, so both paths show identical cells.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::style::Cell;

/// How a column renders the raw record value under its `key`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CellFormat {
  /// The value as-is: strings verbatim, numbers/bools via `to_string`.
  #[default]
  Text,
  /// A `u64` byte count humanized (`6B`, `1.2K`, `34M`).
  SizeBytes,
  /// An epoch-milliseconds timestamp rendered as a relative age (`5m`, `3h`,
  /// `12d`) against "now" at render time — ages refresh on every repaint.
  AgeMs,
}

impl CellFormat {
  /// Resolve a Lisp-keyword / serde format name to a variant. Accepts both the
  /// dashed keyword spelling (`size-bytes`, from `(ls.column … :format
  /// :size-bytes)`) and the underscored serde spelling (`size_bytes`). This is
  /// the single seam for naming a new format: add a variant above + one arm
  /// here. Unknown → `None`.
  pub fn from_name(name: &str) -> Option<CellFormat> {
    match name.replace('-', "_").as_str() {
      "text" => Some(CellFormat::Text),
      "size_bytes" => Some(CellFormat::SizeBytes),
      "age_ms" => Some(CellFormat::AgeMs),
      _ => None,
    }
  }
}

/// `1.2K` / `34M`-style size (powers of 1024, one decimal under 10).
pub fn human_size(bytes: u64) -> String {
  const UNITS: [&str; 5] = ["B", "K", "M", "G", "T"];
  let mut v = bytes as f64;
  let mut unit = 0;
  while v >= 1024.0 && unit < UNITS.len() - 1 {
    v /= 1024.0;
    unit += 1;
  }
  if unit == 0 {
    format!("{bytes}B")
  } else if v < 10.0 {
    format!("{v:.1}{}", UNITS[unit])
  } else {
    format!("{v:.0}{}", UNITS[unit])
  }
}

/// `5s` / `5m` / `3h` / `12d`-style age of an epoch-ms timestamp relative to
/// `now_ms` (a timestamp at or past `now_ms` → `now`).
pub fn human_age_ms(now_ms: i64, ts_ms: i64) -> String {
  let secs = (now_ms - ts_ms) / 1000;
  if secs <= 0 {
    return "now".to_string();
  }
  match secs {
    1..=59 => format!("{secs}s"),
    60..=3599 => format!("{}m", secs / 60),
    3600..=86_399 => format!("{}h", secs / 3600),
    _ => format!("{}d", secs / 86_400),
  }
}

/// Format one raw record value into a display cell. A missing key, JSON
/// `null`, or a value the format can't read all render as `-` — absent data
/// shows as absent, never as a serialization artifact.
pub fn format_cell(raw: Option<&Value>, format: CellFormat, now_ms: i64) -> Cell {
  let Some(raw) = raw else {
    return Cell::plain("-");
  };
  let text = match format {
    CellFormat::Text => match raw {
      Value::String(s) => Some(s.clone()),
      Value::Number(n) => Some(n.to_string()),
      Value::Bool(b) => Some(b.to_string()),
      _ => None,
    },
    CellFormat::SizeBytes => raw.as_u64().map(human_size),
    CellFormat::AgeMs => raw.as_i64().map(|ts| human_age_ms(now_ms, ts)),
  };
  Cell::plain(text.unwrap_or_else(|| "-".to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn sizes_humanize() {
    assert_eq!(human_size(6), "6B");
    assert_eq!(human_size(1024 + 230), "1.2K");
    assert_eq!(human_size(55 * 1024), "55K");
    assert_eq!(human_size(34 * 1024 * 1024), "34M");
  }

  #[test]
  fn ages_humanize_and_clamp_future_to_now() {
    let now = 1_000_000_000_000;
    assert_eq!(human_age_ms(now, now - 5_000), "5s");
    assert_eq!(human_age_ms(now, now - 5 * 60_000), "5m");
    assert_eq!(human_age_ms(now, now - 3 * 3_600_000), "3h");
    assert_eq!(human_age_ms(now, now - 12 * 86_400_000), "12d");
    assert_eq!(human_age_ms(now, now + 60_000), "now");
  }

  #[test]
  fn missing_and_null_render_dash_for_every_format() {
    let now = 0;
    for f in [CellFormat::Text, CellFormat::SizeBytes, CellFormat::AgeMs] {
      assert_eq!(format_cell(None, f, now).plain_text(), "-");
      assert_eq!(format_cell(Some(&Value::Null), f, now).plain_text(), "-");
    }
  }

  #[test]
  fn text_format_reads_strings_numbers_bools() {
    let now = 0;
    assert_eq!(
      format_cell(Some(&json!("x/")), CellFormat::Text, now).plain_text(),
      "x/"
    );
    assert_eq!(
      format_cell(Some(&json!(12)), CellFormat::Text, now).plain_text(),
      "12"
    );
    assert_eq!(
      format_cell(Some(&json!(true)), CellFormat::Text, now).plain_text(),
      "true"
    );
  }

  #[test]
  fn typed_formats_reject_wrong_types() {
    let now = 0;
    assert_eq!(
      format_cell(Some(&json!("big")), CellFormat::SizeBytes, now).plain_text(),
      "-"
    );
    assert_eq!(
      format_cell(Some(&json!({"x":1})), CellFormat::AgeMs, now).plain_text(),
      "-"
    );
  }

  #[test]
  fn from_name_accepts_dash_and_underscore() {
    assert_eq!(CellFormat::from_name("text"), Some(CellFormat::Text));
    assert_eq!(
      CellFormat::from_name("size-bytes"),
      Some(CellFormat::SizeBytes)
    );
    assert_eq!(
      CellFormat::from_name("size_bytes"),
      Some(CellFormat::SizeBytes)
    );
    assert_eq!(CellFormat::from_name("age-ms"), Some(CellFormat::AgeMs));
    assert_eq!(CellFormat::from_name("age_ms"), Some(CellFormat::AgeMs));
    assert_eq!(CellFormat::from_name("bogus"), None);
  }
}
