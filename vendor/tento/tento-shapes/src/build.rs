//! Builders for the shape JSON a tsh plugin command returns.
//!
//! A tsh prompt only renders a value as a table or as sections when the value
//! names its shape (`{"shape": "table/v1", …}`). The `Table<T>` / `Sections<T>`
//! wrappers serialize transparently, so their shape is lost at a plugin's
//! import boundary, and plugins build the shapes by hand. These are the
//! builders they share, so every plugin draws its tables, missing values and
//! tones the same way.
//!
//! Colours are theme roles (`status.ok`, `text.faint`, …) so a palette
//! restyles them; `bold` and `dimmed` are the legacy names for an emphasised
//! column and the header row. A missing value is a faint `—`, never JSON
//! `null` and never a blank in one row and a dash in the next.

use serde::Serialize;
use serde_json::{Value, json};

pub const OK: &str = "status.ok";
pub const WARN: &str = "status.warn";
pub const ERROR: &str = "status.error";
pub const INFO: &str = "status.info";
pub const SECONDARY: &str = "text.secondary";
pub const FAINT: &str = "text.faint";
pub const BOLD: &str = "bold";
pub const DIM: &str = "dimmed";

pub const DASH: &str = "—";

/// A label and the role it is painted with.
pub type Tone = (&'static str, &'static str);

/// A cell (or title) carrying a style.
pub fn styled(text: impl Into<String>, style: &str) -> Value {
  json!({ "text": text.into(), "style": style })
}

pub fn toned(tone: Tone) -> Value {
  styled(tone.0, tone.1)
}

/// The missing-value cell.
pub fn dash() -> Value {
  styled(DASH, FAINT)
}

/// Plain text, or the missing-value cell when there is none.
pub fn or_dash(text: Option<&str>) -> Value {
  match text.map(str::trim) {
    Some(t) if !t.is_empty() => Value::String(t.to_string()),
    _ => dash(),
  }
}

/// Styled text, or the missing-value cell when there is none.
pub fn styled_or_dash(text: Option<&str>, style: &str) -> Value {
  match text.map(str::trim) {
    Some(t) if !t.is_empty() => styled(t, style),
    _ => dash(),
  }
}

/// One `table/v1` column. Lower `priority` survives longer when the terminal
/// is narrow: tento-term demotes the highest number to a sub-line first.
pub struct Col(Value);

impl Col {
  pub fn new(header: &str, priority: u8) -> Self {
    Col(json!({ "header": header, "priority": priority }))
  }
  pub fn style(mut self, style: &str) -> Self {
    self.0["style"] = json!(style);
    self
  }
  pub fn right(mut self) -> Self {
    self.0["align"] = json!("right");
    self
  }
  pub fn max(mut self, width: usize) -> Self {
    self.0["max_width"] = json!(width);
    self
  }
  pub fn min(mut self, width: usize) -> Self {
    self.0["min_width"] = json!(width);
    self
  }
}

/// A `table/v1` with a dimmed lowercase header row.
pub fn table(title: Option<Value>, columns: Vec<Col>, rows: Vec<Vec<Value>>) -> Value {
  let mut out = json!({
    "shape": "table/v1",
    "header_style": DIM,
    "gap": "  ",
    "columns": columns.into_iter().map(|c| c.0).collect::<Vec<_>>(),
    "rows": rows,
  });
  if let Some(title) = title {
    out["title"] = title;
  }
  out
}

/// Label/value lines with no header row: a dimmed label, the value, and an
/// optional dimmed aside (an address beside the tailnet state). The shape
/// a configuration block takes — `kv/v1` cannot style a value and does not
/// keep key order.
pub fn fields(rows: Vec<(&str, Value, Option<Value>)>) -> Value {
  let rows: Vec<Value> = rows
    .into_iter()
    .map(|(label, value, aside)| json!([label, value, aside.unwrap_or_else(|| json!(""))]))
    .collect();
  json!({
    "shape": "table/v1",
    "header_rule": false,
    "gap": "  ",
    "columns": [
      { "header": "", "priority": 0, "style": DIM },
      { "header": "", "priority": 0 },
      { "header": "", "priority": 1, "style": DIM },
    ],
    "rows": rows,
  })
}

/// One line of cells, separated by a space — a sentence with a toned word.
pub fn line(cells: Vec<Value>) -> Value {
  let columns: Vec<Value> = cells
    .iter()
    .map(|_| json!({ "header": "", "priority": 0 }))
    .collect();
  json!({
    "shape": "table/v1",
    "header_rule": false,
    "gap": " ",
    "columns": columns,
    "rows": [cells],
  })
}

pub fn section(title: Option<Value>, value: Value) -> Value {
  match title {
    Some(title) => json!({ "title": title, "value": value }),
    None => json!({ "value": value }),
  }
}

pub fn sections(sections: Vec<Value>) -> Value {
  json!({ "shape": "sections/v1", "sections": sections })
}

/// A one-line result.
pub fn note(cells: Vec<Value>) -> Value {
  sections(vec![section(None, line(cells))])
}

/// Attach the typed machine records — what `--json` and a Lisp caller read —
/// and the datatype that names them.
pub fn with_records(
  mut shape: Value,
  datatype: &str,
  records: &impl Serialize,
) -> serde_json::Result<Value> {
  shape["datatype"] = json!(datatype);
  shape["records"] = serde_json::to_value(records)?;
  Ok(shape)
}

/// `1 host`, `3 hosts`.
pub fn plural(n: usize, word: &str) -> String {
  format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plural_counts_one_without_an_s() {
    assert_eq!(plural(1, "host"), "1 host");
    assert_eq!(plural(0, "host"), "0 hosts");
  }

  #[test]
  fn records_ride_beside_the_shape() {
    let v = with_records(note(vec![json!("x")]), "test.records/v1", &vec![1, 2]).unwrap();
    assert_eq!(v["shape"], "sections/v1");
    assert_eq!(v["datatype"], "test.records/v1");
    assert_eq!(v["records"], json!([1, 2]));
  }

  #[test]
  fn a_missing_value_is_a_faint_dash() {
    assert_eq!(or_dash(None), dash());
    assert_eq!(or_dash(Some("  ")), dash());
    assert_eq!(or_dash(Some("x")), json!("x"));
    assert_eq!(dash(), json!({"text": DASH, "style": FAINT}));
  }
}
