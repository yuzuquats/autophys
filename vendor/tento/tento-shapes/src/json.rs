use serde_json::Value;
use tento_term::wrap_to_width;

use crate::registry::ShapeOutput;

/// Generic render for an untagged (or unknown-shape) value nested inside a
/// composite: a plain string wraps to width; anything else pretty-prints as
/// JSON. All lines are chrome (unselectable). Top-level untagged values never
/// reach this — the registry returns `None` and the host keeps its own
/// fallback.
pub fn render_fallback(value: &Value, width: u16) -> ShapeOutput {
  let lines: Vec<String> = match value {
    Value::String(s) => s
      .split('\n')
      .flat_map(|l| {
        if l.is_empty() {
          vec![String::new()]
        } else {
          wrap_to_width(l, width as usize)
        }
      })
      .collect(),
    other => serde_json::to_string_pretty(other)
      .unwrap_or_else(|_| other.to_string())
      .split('\n')
      .map(str::to_string)
      .collect(),
  };
  let paths = vec![None; lines.len()];
  ShapeOutput {
    lines,
    paths,
    ..ShapeOutput::default()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn string_values_keep_their_line_breaks() {
    let out = render_fallback(&json!("line one\n\nline three"), 80);
    assert_eq!(out.lines, vec!["line one", "", "line three"]);
    assert!(out.paths.iter().all(Option::is_none));
  }

  #[test]
  fn objects_pretty_print() {
    let out = render_fallback(&json!({"k": 1}), 80);
    assert!(out.lines.len() > 1);
    assert!(out.lines[0].starts_with('{'));
  }
}
