//! `sections/v1` — a composite render shape: an ordered list of titled blocks
//! whose values are themselves shape-tagged (`table/v1`, …) or raw JSON.
//!
//! The serde types live here (alongside [`TableBody`](crate::table::TableBody))
//! so a producer only needs `tento-term` to emit the shape; dispatch/rendering
//! lives in the shape registry (`tento-shapes`). See the tento-shell project
//! doc `render-shapes.md` for the path scheme and rendering semantics.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::style::Cell;
use crate::table::Table;

/// The shape id for a `sections/v1` turn-item / pane `stdout`.
pub const SECTIONS_V1: &str = "sections/v1";

/// A shape-tagged list of sections, so a serialized value self-describes as
/// `{ "shape":"sections/v1", "sections":[…] }`. Build via [`SectionsBody::new`].
#[derive(Debug, Serialize, Deserialize)]
pub struct SectionsBody {
  pub shape: String,
  pub sections: Vec<Section>,
  /// Override the body indentation for composed layouts (zero is flush left).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub indent: Option<usize>,
}

/// One block of a [`SectionsBody`]: an optional title line above a value that
/// is either shape-tagged (rendered by that shape's widget, recursively) or
/// raw JSON (rendered by the registry's fallback).
#[derive(Debug, Serialize, Deserialize)]
pub struct Section {
  /// Title line. A [`Cell`] so producers can carry a style (e.g. a red
  /// `error:` header); an unstyled title serializes as a bare string, so the
  /// wire format is unchanged for plain titles. Unstyled titles render bold.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<Cell>,
  pub value: Value,
}

impl SectionsBody {
  pub fn new(sections: Vec<Section>) -> Self {
    SectionsBody {
      shape: SECTIONS_V1.to_string(),
      sections,
      indent: None,
    }
  }
}

impl Section {
  /// A titled `table/v1` section.
  pub fn table(title: impl Into<Cell>, table: Table) -> Self {
    Section {
      title: Some(title.into()),
      value: serde_json::to_value(table.into_body())
        .expect("table/v1 body serializes (plain strings + numbers)"),
    }
  }

  /// A titled plain-text section (rendered as-is, line-wrapped).
  pub fn text(title: impl Into<Cell>, text: impl Into<String>) -> Self {
    Section {
      title: Some(title.into()),
      value: Value::String(text.into()),
    }
  }

  /// An untitled section holding any value (shape-tagged or raw).
  pub fn value(value: Value) -> Self {
    Section { title: None, value }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::table::Column;

  /// The serialized body leads with the shape tag and nests a shape-tagged
  /// table — the structure the registry dispatches on.
  #[test]
  fn sections_body_tags_shape_and_nests_tagged_values() {
    let t = Table::new(vec![Column::new("A")]);
    let body = SectionsBody::new(vec![
      Section::table("Zone X", t),
      Section::text("Notes", "hello"),
      Section::value(serde_json::json!({"k": 1})),
    ]);
    let json = serde_json::to_value(&body).unwrap();
    assert_eq!(json["shape"], SECTIONS_V1);
    assert_eq!(json["sections"][0]["title"], "Zone X");
    assert_eq!(json["sections"][0]["value"]["shape"], "table/v1");
    assert_eq!(json["sections"][1]["value"], "hello");
    assert!(json["sections"][2].get("title").is_none());
  }

  /// Round-trips through serde — what the shell does across the process
  /// boundary.
  #[test]
  fn sections_body_round_trips() {
    let body = SectionsBody::new(vec![Section::text("T", "v")]);
    let s = serde_json::to_string(&body).unwrap();
    let back: SectionsBody = serde_json::from_str(&s).unwrap();
    assert_eq!(back.shape, SECTIONS_V1);
    assert_eq!(back.sections.len(), 1);
    let title = back.sections[0].title.as_ref().expect("title");
    assert_eq!(title.plain_text(), "T");
  }

  /// A styled title serializes as `{text, style}` and round-trips; a plain
  /// title stays a bare string on the wire (backwards compatible).
  #[test]
  fn styled_title_round_trips_plain_title_stays_bare() {
    use crate::style::{Cell, Style};
    let styled = SectionsBody::new(vec![Section::text(
      Cell::new("error: nope", Style::Red),
      "detail",
    )]);
    let json = serde_json::to_value(&styled).unwrap();
    assert_eq!(json["sections"][0]["title"]["style"], "red");
    let back: SectionsBody = serde_json::from_value(json).unwrap();
    assert_eq!(
      back.sections[0].title.as_ref().unwrap().plain_text(),
      "error: nope"
    );

    let plain = SectionsBody::new(vec![Section::text("T", "v")]);
    let json = serde_json::to_value(&plain).unwrap();
    assert_eq!(json["sections"][0]["title"], "T");
  }
}
