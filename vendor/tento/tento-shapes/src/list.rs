use serde_json::Value;

use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};

/// `list/v1` — an ordered list of scalar items, one addressable line each. The
/// array-shaped twin of `table/v1` (records): a producer whose value is a flat
/// list (paths, names) emits `{shape:"list/v1", items:[…]}` and stops; each item
/// renders on its own line.
pub const LIST_V1: &str = "list/v1";

pub struct ListWidget;

impl ShapeWidget for ListWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[LIST_V1]
  }

  fn render(
    &self,
    value: &Value,
    _width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    let Some(items) = value.get("items").and_then(Value::as_array) else {
      return ShapeOutput::diagnostic("  (list/v1: no `items` array)");
    };
    let mut lines = Vec::new();
    let mut paths: Vec<Option<String>> = Vec::new();
    if let Some(title) = value.get("title").and_then(Value::as_str) {
      lines.push(title.to_string());
      paths.push(None);
    }
    if items.is_empty() {
      lines.push("  (empty)".to_string());
      paths.push(None);
    }
    for (i, item) in items.iter().enumerate() {
      lines.push(format!("  {}", scalar_text(item)));
      paths.push(ctx.base_path.map(|b| format!("{b}/item:{i}")));
    }
    ShapeOutput {
      lines,
      paths,
      ..ShapeOutput::default()
    }
  }
}

/// A scalar JSON value as its display text — a string sheds its quotes; other
/// scalars use their JSON form. Shared with [`crate::kv`].
pub(crate) fn scalar_text(value: &Value) -> String {
  match value {
    Value::String(s) => s.clone(),
    Value::Null => String::new(),
    other => other.to_string(),
  }
}

#[cfg(test)]
mod tests {
  use std::collections::{HashMap, HashSet};

  use serde_json::json;

  use super::*;
  use crate::FileSourceResolver;

  fn ctx<'a>(collapsed: &'a HashSet<String>, state: &'a HashMap<String, Value>) -> RenderCtx<'a> {
    RenderCtx {
      base_path: Some("turn:5"),
      collapsed,
      widget_state: state,
      resolver: &FileSourceResolver,
      depth: 0,
    }
  }

  #[test]
  fn items_render_one_addressable_line_each() {
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let value = json!({"shape": "list/v1", "title": "2 paths", "items": ["/a", "/b"]});
    let out = ShapeRegistry::core()
      .render(&value, 40, &ctx(&collapsed, &state))
      .expect("renders");
    assert_eq!(out.lines[0], "2 paths");
    assert!(
      out.lines[1].contains("/a") && out.lines[2].contains("/b"),
      "{:?}",
      out.lines
    );
    // Each item is addressable; the title line is chrome.
    assert_eq!(out.paths[0], None);
    assert_eq!(out.paths[1], Some("turn:5/item:0".to_string()));
    assert_eq!(out.paths[2], Some("turn:5/item:1".to_string()));
  }

  #[test]
  fn empty_and_malformed_degrade() {
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let empty = ShapeRegistry::core()
      .render(
        &json!({"shape": "list/v1", "items": []}),
        40,
        &ctx(&collapsed, &state),
      )
      .expect("renders");
    assert!(
      empty.lines.iter().any(|l| l.contains("empty")),
      "{:?}",
      empty.lines
    );
    let bad = ShapeRegistry::core()
      .render(&json!({"shape": "list/v1"}), 40, &ctx(&collapsed, &state))
      .expect("renders");
    assert!(bad.lines[0].contains("list/v1"), "{:?}", bad.lines);
  }
}
