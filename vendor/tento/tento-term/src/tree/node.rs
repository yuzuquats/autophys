//! [`Node`] — one item of a [`super::Tree`]. The struct carries a `label`
//! plus an open-ended map of keyed per-row data (`fields`) and child nodes.
//!
//! Also home to the custom [`serde::Deserialize`] impl that accepts either a
//! bare string (shorthand for `{label: …}`), the legacy `{detail: …}` field,
//! the new `{fields: {…}}` map, or both (explicit `fields["detail"]` wins).

use std::collections::HashMap;

use serde::Deserialize;
use serde::de::Deserializer;

use crate::style::Cell;

/// One node of a [`super::Tree`].
#[derive(Clone, Debug, Default)]
pub struct Node {
  /// Text shown after the branch glyph.
  pub label: Cell,
  /// Optional glyph prefix painted before the label on its first line only
  /// (status mark, bullet, chevron — `"✓ "`). Wrapped label lines hang-indent
  /// by this cell's visible width, so continuations align with the label text
  /// rather than the glyph. `None` ⇒ the label starts at the branch glyph and
  /// wraps flush (the legacy behavior).
  pub label_prefix: Option<Cell>,
  /// Keyed per-row data — the `Tree`'s declared columns pull cells out by key.
  /// A row can carry fields that aren't declared as columns; they're ignored.
  pub fields: Vec<(String, Cell)>,
  /// Child nodes.
  pub children: Vec<Node>,
}

impl Node {
  pub fn leaf(label: impl Into<Cell>) -> Self {
    Node {
      label: label.into(),
      label_prefix: None,
      fields: Vec::new(),
      children: Vec::new(),
    }
  }
  pub fn branch(label: impl Into<Cell>, children: Vec<Node>) -> Self {
    Node {
      label: label.into(),
      label_prefix: None,
      fields: Vec::new(),
      children,
    }
  }
  /// Set the hanging glyph prefix (see [`Node::label_prefix`]).
  pub fn label_prefix(mut self, prefix: impl Into<Cell>) -> Self {
    self.label_prefix = Some(prefix.into());
    self
  }
  /// BC alias for setting the `"detail"` field.
  pub fn with_detail(mut self, detail: impl Into<Cell>) -> Self {
    set_field(&mut self.fields, "detail", detail.into());
    self
  }
  /// Set an arbitrary keyed field cell.
  pub fn with_field(mut self, key: impl Into<String>, cell: impl Into<Cell>) -> Self {
    set_field(&mut self.fields, &key.into(), cell.into());
    self
  }
  pub fn child(mut self, c: Node) -> Self {
    self.children.push(c);
    self
  }
}

fn set_field(fields: &mut Vec<(String, Cell)>, key: &str, cell: Cell) {
  if let Some(slot) = fields.iter_mut().find(|(k, _)| k == key) {
    slot.1 = cell;
  } else {
    fields.push((key.to_string(), cell));
  }
}

impl<'de> Deserialize<'de> for Node {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
      Leaf(String),
      Full {
        #[serde(default)]
        label: Cell,
        #[serde(default)]
        label_prefix: Option<Cell>,
        /// Legacy: a single trailing detail cell.
        #[serde(default)]
        detail: Option<Cell>,
        /// New: keyed per-row fields. May coexist with `detail` (which is folded in
        /// under the `"detail"` key for BC).
        #[serde(default)]
        fields: HashMap<String, Cell>,
        #[serde(default)]
        children: Vec<Node>,
      },
    }
    Ok(match Repr::deserialize(deserializer)? {
      Repr::Leaf(s) => Node {
        label: Cell::plain(s),
        label_prefix: None,
        fields: Vec::new(),
        children: Vec::new(),
      },
      Repr::Full {
        label,
        label_prefix,
        detail,
        fields,
        children,
      } => {
        let mut out_fields: Vec<(String, Cell)> = Vec::new();
        if let Some(d) = detail {
          out_fields.push(("detail".to_string(), d));
        }
        // HashMap iteration order is unspecified; sort by key for stable serialization.
        let mut entries: Vec<(String, Cell)> = fields.into_iter().collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in entries {
          // If both legacy `detail` and a `fields["detail"]` are present, the
          // explicit `fields` value wins.
          if let Some(slot) = out_fields.iter_mut().find(|(kk, _)| kk == &k) {
            slot.1 = v;
          } else {
            out_fields.push((k, v));
          }
        }
        Node {
          label,
          label_prefix,
          fields: out_fields,
          children,
        }
      }
    })
  }
}
