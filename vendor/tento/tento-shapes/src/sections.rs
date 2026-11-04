use serde_json::Value;
use tento_term::sections::{SECTIONS_V1, SectionsBody};
use tento_term::{Cell, Style, chevron};

use crate::json::render_fallback;
use crate::registry::{
  RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget, WidgetAction, WidgetEvent,
};

/// Composite nesting cap: a `sections/v1` nested deeper than this renders via
/// the JSON fallback instead of recursing further.
const MAX_DEPTH: u8 = 3;
/// Spaces a titled section's body is indented under its header.
const INDENT: usize = 2;

/// `sections/v1` — an ordered list of titled blocks whose values dispatch
/// recursively through the registry (`table/v1`, nested sections, …) or, when
/// untagged/unknown, through the JSON fallback.
///
/// Path scheme: the section header line is `<base>/sec:<i>`; child rows are
/// `<base>/sec:<i>/<child-path>`. Collapsing `<base>/sec:<i>` hides the body.
/// A single untitled section renders transparently (no header, no indent).
pub struct SectionsWidget;

impl ShapeWidget for SectionsWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[SECTIONS_V1]
  }

  fn render(&self, value: &Value, width: u16, ctx: &RenderCtx, reg: &ShapeRegistry) -> ShapeOutput {
    let Ok(body) = serde_json::from_value::<SectionsBody>(value.clone()) else {
      return ShapeOutput::diagnostic("  (sections/v1: malformed)");
    };
    if ctx.depth >= MAX_DEPTH {
      let mut out = render_fallback(value, width);
      out.lines.insert(0, "  (sections: max depth)".to_string());
      out.paths.insert(0, None);
      return out;
    }

    let transparent = body.sections.len() == 1 && body.sections[0].title.is_none();
    let mut out = ShapeOutput::default();

    for (i, section) in body.sections.iter().enumerate() {
      let sec_path = ctx.base_path.map(|b| format!("{b}/sec:{i}"));
      let folded = sec_path
        .as_deref()
        .is_some_and(|p| ctx.collapsed.contains(p));

      if i > 0 {
        out.lines.push(String::new());
        out.paths.push(None);
      }
      if let Some(title) = &section.title {
        // The header is the section's addressable line: selecting it carries
        // the sec path; Space/Enter toggles the body via the collapse set.
        // A styled title Cell wins; an unstyled one keeps the bold default.
        let painted = match title {
          Cell::Styled { text, style } => style.or(Style::Bold).paint(text),
          Cell::Raw(s) => s.clone(),
        };
        let line = match &sec_path {
          Some(_) => format!("{} {painted}", chevron(true, !folded)),
          None => painted,
        };
        out.lines.push(line);
        out.paths.push(sec_path.clone());
      }
      if folded {
        continue;
      }

      let indent = body.indent.unwrap_or(if transparent { 0 } else { INDENT });
      let child_width = (width as usize).saturating_sub(indent).max(8) as u16;
      let child_ctx = RenderCtx {
        base_path: sec_path.as_deref(),
        collapsed: ctx.collapsed,
        widget_state: ctx.widget_state,
        resolver: ctx.resolver,
        depth: ctx.depth + 1,
      };
      let mut child = reg
        .render(&section.value, child_width, &child_ctx)
        .unwrap_or_else(|| render_fallback(&section.value, child_width));
      // Carry the child's animation patches across the splice: rows shift by
      // where the child lands, byte offsets by the indent this widget prefixes.
      // Without both, a nested animated block would splice the wrong bytes.
      child.offset_anims(out.lines.len());
      for patch in child.anims.iter_mut() {
        patch.start += indent;
        patch.end += indent;
      }
      out.anims.extend(child.anims);
      for (line, path) in child.lines.into_iter().zip(child.paths) {
        out.lines.push(format!("{:indent$}{line}", ""));
        out.paths.push(path);
      }
      out.attrs.extend(child.attrs);
    }
    out
  }

  /// Recurse the event to the owning section's child widget: a path like
  /// `sec:1/confirm` re-dispatches against section 1's value with the
  /// child's own base. The bare `sec:<i>` header line stays host-handled
  /// (collapse), as do paths of children that don't claim the event.
  fn on_event(&self, ev: &WidgetEvent, value: &Value, reg: &ShapeRegistry) -> Option<WidgetAction> {
    let body: SectionsBody = serde_json::from_value(value.clone()).ok()?;
    let rest = ev.rel_path.strip_prefix("sec:")?;
    let (idx, child_rel) = rest.split_once('/')?;
    let section = body.sections.get(idx.parse::<usize>().ok()?)?;
    let child_base = &ev.abs_path[..ev.abs_path.len() - child_rel.len() - 1];
    reg.on_event(&section.value, child_base, ev.abs_path, ev.event, ev.state)
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;

  use serde_json::json;

  use super::*;
  use crate::FileSourceResolver;
  use crate::registry::EMPTY_WIDGET_STATE as EMPTY_STATE;

  fn ctx<'a>(collapsed: &'a HashSet<String>) -> RenderCtx<'a> {
    RenderCtx {
      base_path: Some("turn:7"),
      collapsed,
      widget_state: &EMPTY_STATE,
      resolver: &FileSourceResolver,
      depth: 0,
    }
  }

  fn zone_sections() -> serde_json::Value {
    json!({
      "shape": "sections/v1",
      "sections": [
        { "title": "Zone X", "value": {
          "shape": "table/v1",
          "columns": [{"header": "A"}],
          "rows": [["a1"]],
        }},
        { "title": "Rule US", "value": {
          "shape": "table/v1",
          "columns": [{"header": "B"}],
          "rows": [["b1"], ["b2"]],
        }},
      ],
    })
  }

  /// Section headers get `sec:<i>` paths; nested table rows extend them —
  /// the scheme collapse + selection key off.
  #[test]
  fn sections_and_rows_are_addressable() {
    let collapsed = HashSet::new();
    let out = ShapeRegistry::core()
      .render(&zone_sections(), 60, &ctx(&collapsed))
      .expect("renders");
    assert!(
      out.paths.contains(&Some("turn:7/sec:0".into())),
      "{:?}",
      out.paths
    );
    assert!(out.paths.contains(&Some("turn:7/sec:0/row:0".into())));
    assert!(out.paths.contains(&Some("turn:7/sec:1/row:1".into())));
    assert_eq!(
      out.attrs.first().map(|(p, _)| p.as_str()),
      Some("turn:7/sec:0/row:0")
    );
    let text = out.lines.join("\n");
    assert!(text.contains("Zone X"), "{text}");
    assert!(text.contains("b2"), "{text}");
  }

  /// A collapsed section keeps its header (folded chevron) and drops its body.
  #[test]
  fn collapsed_section_hides_its_body() {
    let collapsed: HashSet<String> = ["turn:7/sec:1".to_string()].into();
    let out = ShapeRegistry::core()
      .render(&zone_sections(), 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("Rule US"), "{text}");
    assert!(!text.contains("b1"), "collapsed body hidden:\n{text}");
    assert!(text.contains("a1"), "other section unaffected:\n{text}");
  }

  /// Untagged section values render via the fallback; unknown shapes inside a
  /// section degrade the same way instead of erroring.
  #[test]
  fn untagged_and_unknown_children_fall_back() {
    let collapsed = HashSet::new();
    let v = json!({
      "shape": "sections/v1",
      "sections": [
        { "title": "Notes", "value": "plain\ntext" },
        { "title": "Mystery", "value": {"shape": "mystery/v9", "data": 1} },
      ],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("plain"), "{text}");
    assert!(
      text.contains("mystery/v9"),
      "unknown shape pretty-prints: {text}"
    );
  }

  /// A styled title Cell (the error/notice case) renders its text and still
  /// gets a `sec:<i>` path; a bare-string title keeps deserializing.
  #[test]
  fn styled_title_renders_and_stays_addressable() {
    let collapsed = HashSet::new();
    let v = json!({
      "shape": "sections/v1",
      "sections": [
        { "title": {"text": "error: nope", "style": "red"}, "value": "detail" },
        { "title": "plain", "value": "x" },
      ],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("error: nope"), "{text}");
    assert!(text.contains("plain"), "{text}");
    assert!(
      out.paths.contains(&Some("turn:7/sec:0".into())),
      "{:?}",
      out.paths
    );
  }

  /// Nesting past MAX_DEPTH degrades to the fallback with a note.
  #[test]
  fn deep_nesting_is_capped() {
    let mut v = json!({"shape": "sections/v1", "sections": [{"title": "leaf", "value": "x"}]});
    for _ in 0..MAX_DEPTH {
      v = json!({"shape": "sections/v1", "sections": [{"title": "wrap", "value": v}]});
    }
    let collapsed = HashSet::new();
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("(sections: max depth)"), "{text}");
  }

  /// A single untitled section is transparent: no header line, no indent.
  #[test]
  fn single_untitled_section_is_transparent() {
    let collapsed = HashSet::new();
    let v = json!({
      "shape": "sections/v1",
      "sections": [{ "value": {
        "shape": "table/v1",
        "columns": [{"header": "A"}],
        "rows": [["a1"]],
      }}],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    assert!(
      out.lines.iter().any(|l| l.starts_with('A')),
      "no indent: {:?}",
      out.lines
    );
    assert!(out.paths.contains(&Some("turn:7/sec:0/row:0".into())));
  }

  /// A per-section `source` DataRef resolves through the registry — the
  /// embedded-live-subpane path.
  #[test]
  fn per_section_source_resolves() {
    use std::io::Write;
    let path = std::env::temp_dir().join(format!(
      "tento-shapes-sections-{}.ljson",
      std::process::id()
    ));
    let mut f = std::fs::File::create(&path).unwrap();
    writeln!(
      f,
      "{}",
      json!({"v":1,"shape":"table/v1","encoding":"records"})
    )
    .unwrap();
    writeln!(
      f,
      "{}",
      json!({"shape":"table/v1","columns":[{"header":"Live"}],"rows":[["fresh"]]})
    )
    .unwrap();

    let collapsed = HashSet::new();
    let v = json!({
      "shape": "sections/v1",
      "sections": [{ "title": "Live table", "value": {
        "shape": "table/v1",
        "source": {"kind": "file", "path": path.to_str().unwrap()},
      }}],
    });
    let out = ShapeRegistry::core()
      .render(&v, 60, &ctx(&collapsed))
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("fresh"), "{text}");
    std::fs::remove_file(&path).ok();
  }
}
