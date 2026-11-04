use serde_json::Value;

use crate::list::scalar_text;
use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};

/// `kv/v1` — a single heterogeneous record rendered as aligned `key   value`
/// lines (the map-shaped twin of `table/v1`). A producer whose value is one
/// object (a version summary, a config) emits `{shape:"kv/v1", fields:{…}}`.
pub const KV_V1: &str = "kv/v1";

pub struct KvWidget;

impl ShapeWidget for KvWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[KV_V1]
  }

  fn render(
    &self,
    value: &Value,
    _width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    let Some(fields) = value.get("fields").and_then(Value::as_object) else {
      return ShapeOutput::diagnostic("  (kv/v1: no `fields` object)");
    };
    let key_width = fields.keys().map(String::len).max().unwrap_or(0);
    let mut lines = Vec::new();
    let mut paths: Vec<Option<String>> = Vec::new();
    if let Some(title) = value.get("title").and_then(Value::as_str) {
      lines.push(title.to_string());
      paths.push(None);
    }
    for (key, val) in fields {
      lines.push(format!("  {key:key_width$}   {}", scalar_text(val)));
      paths.push(ctx.base_path.map(|b| format!("{b}/field:{key}")));
    }
    ShapeOutput {
      lines,
      paths,
      ..ShapeOutput::default()
    }
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
  fn fields_render_aligned_and_addressable() {
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let value = json!({"shape": "kv/v1", "fields": {"semver": "0.1.2", "git": "abc"}});
    let out = ShapeRegistry::core()
      .render(&value, 40, &ctx(&collapsed, &state))
      .expect("renders");
    // JSON object iteration order depends on serde_json's preserve_order
    // feature; paths and values must stay paired in either feature graph.
    let git = out
      .paths
      .iter()
      .position(|p| p.as_deref() == Some("turn:5/field:git"))
      .unwrap();
    let semver = out
      .paths
      .iter()
      .position(|p| p.as_deref() == Some("turn:5/field:semver"))
      .unwrap();
    assert!(
      out.lines[git].contains("git") && out.lines[git].contains("abc"),
      "{:?}",
      out.lines
    );
    assert!(
      out.lines[semver].contains("semver") && out.lines[semver].contains("0.1.2"),
      "{:?}",
      out.lines
    );
    assert_ne!(git, semver);
  }

  #[test]
  fn malformed_degrades() {
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let out = ShapeRegistry::core()
      .render(
        &json!({"shape": "kv/v1", "fields": []}),
        40,
        &ctx(&collapsed, &state),
      )
      .expect("renders");
    assert!(out.lines[0].contains("kv/v1"), "{:?}", out.lines);
  }
}
