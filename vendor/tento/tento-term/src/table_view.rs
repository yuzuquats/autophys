//! The mutable view over a records-backed table — which catalog columns
//! render, in what order. The view lives in a small JSON sidecar next to the
//! immutable rows ljson (`{"columns":[…keys…],"hidden":[…keys…]}`); rewriting
//! it repaints the table without touching the data. Absent/corrupt view →
//! the catalog's defaults, so a table is always renderable from its trace
//! entry alone.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::column_visibility::ColumnVisibility;
use crate::format::format_cell;
use crate::style::Cell;
use crate::table::Column;

/// Column selection for one emitted table. `columns` is the explicit ordered
/// visible set (empty → the catalog's non-`default_hidden` columns); `hidden`
/// always wins, mirroring [`ColumnVisibility`] semantics.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TableView {
  #[serde(default)]
  pub columns: Vec<String>,
  #[serde(default)]
  pub hidden: Vec<String>,
}

impl TableView {
  /// Lossy parse: anything that isn't a well-formed view (missing file read
  /// as `Null`, garbage, wrong types) degrades to the default view rather
  /// than failing the render.
  pub fn from_json(v: &Value) -> TableView {
    serde_json::from_value(v.clone()).unwrap_or_default()
  }

  /// The catalog key a view refers to a column by: its `key`, else the
  /// lowercased header.
  pub fn column_key(col: &Column) -> String {
    col.key.clone().unwrap_or_else(|| col.header.to_lowercase())
  }

  /// Project the catalog through this view: empty `columns` → catalog order
  /// minus `default_hidden`; non-empty → that order, restricted to catalog
  /// keys; `hidden` always wins. An all-filtered result falls back to the
  /// defaults — a view can never render a table away entirely.
  pub fn effective_columns(&self, catalog: &[Column]) -> Vec<Column> {
    let viz = ColumnVisibility {
      ordered: self.columns.clone(),
      hidden: self.hidden.iter().cloned().collect(),
    };
    let keys: Vec<String> = catalog.iter().map(TableView::column_key).collect();
    let by_key = |key: &str| {
      catalog
        .iter()
        .zip(&keys)
        .find(|(_, k)| k.as_str() == key)
        .map(|(c, _)| c.clone())
    };
    let visible: Vec<Column> = viz
      .iter_visible(keys.iter().map(String::as_str))
      .filter_map(by_key)
      // Default mode (no explicit `columns`) excludes catalog-only columns.
      .filter(|c| !self.columns.is_empty() || !c.default_hidden)
      .collect();
    if !visible.is_empty() {
      return visible;
    }
    catalog
      .iter()
      .filter(|c| !c.default_hidden)
      .cloned()
      .collect()
  }
}

/// Render raw row records into cells under already-projected `columns`: each
/// cell is the record's value at the column's key, through the column's
/// format. `now_ms` anchors relative formats (ages).
pub fn project_rows(columns: &[Column], records: &[Value], now_ms: i64) -> Vec<Vec<Cell>> {
  records
    .iter()
    .map(|rec| {
      columns
        .iter()
        .map(|col| {
          let key = TableView::column_key(col);
          format_cell(rec.get(&key), col.format.unwrap_or_default(), now_ms)
        })
        .collect()
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::format::CellFormat;
  use crate::pad::Align;
  use serde_json::json;

  fn ls_catalog() -> Vec<Column> {
    vec![
      Column::new("NAME").key("name"),
      Column::new("KIND").key("kind"),
      Column::new("SIZE")
        .key("size_bytes")
        .format(CellFormat::SizeBytes)
        .align(Align::Right),
      Column::new("MODIFIED")
        .key("modified_ms")
        .format(CellFormat::AgeMs)
        .align(Align::Right),
      Column::new("PERMS").key("perms").default_hidden(),
      Column::new("OWNER").key("owner").default_hidden(),
    ]
  }

  fn headers(cols: &[Column]) -> Vec<&str> {
    cols.iter().map(|c| c.header.as_str()).collect()
  }

  #[test]
  fn from_json_is_lossy_to_default() {
    assert_eq!(TableView::from_json(&json!(null)), TableView::default());
    assert_eq!(
      TableView::from_json(&json!("garbage")),
      TableView::default()
    );
    assert_eq!(
      TableView::from_json(&json!({"columns": 7})),
      TableView::default()
    );
    // Unknown keys are ignored, known ones land.
    let v = TableView::from_json(&json!({"columns": ["name"], "zzz": true}));
    assert_eq!(v.columns, vec!["name"]);
  }

  #[test]
  fn default_view_excludes_default_hidden() {
    let cols = TableView::default().effective_columns(&ls_catalog());
    assert_eq!(headers(&cols), ["NAME", "KIND", "SIZE", "MODIFIED"]);
  }

  #[test]
  fn explicit_columns_set_order_and_reveal_hidden_catalog_columns() {
    let view = TableView {
      columns: vec!["perms".into(), "name".into()],
      hidden: vec![],
    };
    assert_eq!(
      headers(&view.effective_columns(&ls_catalog())),
      ["PERMS", "NAME"]
    );
  }

  #[test]
  fn hidden_wins_and_unknown_keys_are_skipped() {
    let view = TableView {
      columns: vec![],
      hidden: vec!["kind".into()],
    };
    assert_eq!(
      headers(&view.effective_columns(&ls_catalog())),
      ["NAME", "SIZE", "MODIFIED"]
    );
    let view = TableView {
      columns: vec!["name".into(), "nope".into()],
      hidden: vec![],
    };
    assert_eq!(headers(&view.effective_columns(&ls_catalog())), ["NAME"]);
  }

  #[test]
  fn all_filtered_falls_back_to_defaults() {
    let view = TableView {
      columns: vec!["nope".into()],
      hidden: vec![],
    };
    assert_eq!(
      headers(&view.effective_columns(&ls_catalog())),
      ["NAME", "KIND", "SIZE", "MODIFIED"]
    );
  }

  #[test]
  fn projects_an_ls_shaped_record() {
    let cols = TableView::default().effective_columns(&ls_catalog());
    let now = 1_000_000_000_000;
    let rows = project_rows(
      &cols,
      &[json!({"name":".cargo/","kind":"dir","size_bytes":null,"modified_ms": now - 7_200_000})],
      now,
    );
    let texts: Vec<String> = rows[0]
      .iter()
      .map(|c| c.plain_text().into_owned())
      .collect();
    assert_eq!(texts, [".cargo/", "dir", "-", "2h"]);
  }
}
