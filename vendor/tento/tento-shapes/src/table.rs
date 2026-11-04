use serde_json::Value;
use tento_term::table::{Column, TABLE_V1, Table};
use tento_term::{TableView, project_rows, visual_width};

use crate::anim::{AnimKind, AnimPatch};

use crate::registry::{RenderCtx, RowAttrs, ShapeOutput, ShapeRegistry, ShapeWidget};

/// `table/v1` — a responsive [`Table`] at full width. Each data row is
/// addressable as `<base>/row:<i>` (shared by the row's flat line and its
/// demoted sub-lines) and carries its `(column, cell-text)` pairs as attrs so
/// a selection feeds the detail view. Lifted from the trace pane's
/// `render_table_body`, byte-for-byte on lines/paths/attrs.
///
/// Two value forms: inline (`columns` + `rows` in the value, possibly arrived
/// via last-record source resolution) and records-backed (`source` with
/// `row_shape:"records"`). For the records form the value carries an inline
/// column CATALOG (`columns`, the self-contained out-of-band fallback), the
/// rows are the source file's records, and two optional sidecars override at
/// render time: `catalog.path` (a Lisp-resolved `Vec<Column>` — headers /
/// formats / alignment, see `tsh`'s `command_config`) and `view.path` (which
/// catalog columns render + order, see [`TableView`]). Both resolve fresh each
/// paint, so editing either repaints the displayed table in place.
pub struct TableWidget;

impl ShapeWidget for TableWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[TABLE_V1]
  }

  fn render(
    &self,
    value: &Value,
    width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    #[cfg(feature = "native-tree-table")]
    if let Some(hierarchy) = value.get("hierarchy") {
      let result = serde_json::from_value::<tento_term::TreeTable>(hierarchy.clone())
        .map_err(|_| "invalid tree table hierarchy")
        .and_then(|table| table.render(width as usize, ctx.base_path, ctx.collapsed));
      if let Ok(rendered) = result {
        return ShapeOutput {
          lines: rendered.lines,
          paths: rendered.paths,
          attrs: rendered.attrs,
          ..ShapeOutput::default()
        };
      }
      // Optional metadata must never hide usable compatibility rows.
    }
    let Ok(mut table) = serde_json::from_value::<Table>(value.clone()) else {
      return ShapeOutput::diagnostic("  (table/v1: unresolved or malformed source)");
    };
    let records_source = value
      .get("source")
      .filter(|s| s.get("row_shape").and_then(Value::as_str) == Some("records"));
    if let Some(src) = records_source {
      let Some(records) = ctx.resolver.resolve_records(src) else {
        return ShapeOutput::diagnostic("  (table/v1: unresolved or malformed source)");
      };
      // An optional catalog sidecar (the Lisp-resolved catalog) overrides the
      // inline columns; absent/corrupt → the inline catalog. The inline
      // `columns` is always the self-contained fallback, so the table renders
      // from the trace value + rows file alone even with no sidecar.
      if let Some(catalog) = value
        .pointer("/catalog/path")
        .and_then(Value::as_str)
        .and_then(|p| ctx.resolver.resolve_json(p))
        .and_then(|v| serde_json::from_value::<Vec<Column>>(v).ok())
      {
        table.columns = catalog;
      }
      // Absent/corrupt view sidecar → the catalog's default columns; the
      // table is always renderable from the trace value + rows file alone.
      let view = value
        .pointer("/view/path")
        .and_then(Value::as_str)
        .and_then(|p| ctx.resolver.resolve_json(p))
        .map(|v| TableView::from_json(&v))
        .unwrap_or_default();
      let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
      table.columns = view.effective_columns(&table.columns);
      table.rows = project_rows(&table.columns, &records, now_ms);
    }
    render_table_with_anims(
      &table,
      width,
      ctx,
      value
        .get("anims")
        .and_then(Value::as_array)
        .map(Vec::as_slice),
    )
  }
}

/// Shared lines/paths/attrs body for both value forms (attrs carry the
/// PROJECTED columns for a records-backed table).
/// `table/v1`'s `anims`: animated regions declared BY CONTENT.
///
/// A table assembles its lines from cells it pads, truncates and joins, so a
/// component cannot know the byte range its glyph ended up at — and a `Cell`
/// cannot carry an animation, because that type lives a layer below the anim
/// vocabulary. So a declaration names the data row and the exact painted bytes
/// to animate, and this resolves it against the finished line:
///
/// ```json
/// {"row": 3, "find": "<esc>[36m* <esc>[0m", "key": "herd/4242",
///  "interval_ms": 120, "frames": ["<esc>[36m+ <esc>[0m"]}
/// ```
///
/// Forgiving in exactly one direction: a row whose content was truncated away
/// yields no patch, so a narrow pane degrades to the static glyph instead of
/// animating the wrong bytes. `find` must be the component's own painted run —
/// searching for a bare glyph would match the first one anywhere on the line,
/// including inside a name.
fn resolve_anims(
  specs: &[Value],
  lines: &[String],
  row_of_line: &[Option<usize>],
) -> Vec<AnimPatch> {
  let mut patches = Vec::new();
  for spec in specs {
    let (Some(row), Some(find)) = (
      spec.get("row").and_then(Value::as_u64),
      spec.get("find").and_then(Value::as_str),
    ) else {
      continue;
    };
    let frames: Vec<String> = spec
      .get("frames")
      .and_then(Value::as_array)
      .map(|frames| {
        frames
          .iter()
          .filter_map(Value::as_str)
          .map(str::to_string)
          .collect()
      })
      .unwrap_or_default();
    if find.is_empty() || frames.is_empty() {
      continue;
    }
    // The FIRST line of that data row: a row with demoted sub-lines keeps its
    // flat line, and the glyph a component animates is on it.
    let Some(index) = row_of_line.iter().position(|r| *r == Some(row as usize)) else {
      continue;
    };
    let Some(line) = lines.get(index) else {
      continue;
    };
    let Some(start) = line.find(find) else {
      continue;
    };
    patches.push(AnimPatch {
      row: index,
      start,
      end: start + find.len(),
      key: spec
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or(find)
        .to_string(),
      interval_ms: spec
        .get("interval_ms")
        .and_then(Value::as_u64)
        .unwrap_or(120),
      delay_ms: spec.get("delay_ms").and_then(Value::as_u64).unwrap_or(0),
      base: find.to_string(),
      reduced_frame: spec
        .get("reduced_frame")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize,
      width: visual_width(find),
      kind: AnimKind::Frames(frames),
    });
  }
  patches
}

fn render_table_with_anims(
  table: &Table,
  width: u16,
  ctx: &RenderCtx,
  anims: Option<&[Value]>,
) -> ShapeOutput {
  let (lines, row_of_line) = table.render_lines_with_rows(width as usize);
  let row_path = |ri: usize| ctx.base_path.map(|bp| format!("{bp}/row:{ri}"));
  // One path per output line: the row's path for a data line, else None
  // (title / header / rule / section-break chrome stays unselectable).
  let paths = row_of_line.iter().map(|r| r.and_then(row_path)).collect();
  // One attrs entry per addressable row: its cells as
  // (column header, visible text), in column order.
  let mut attrs: RowAttrs = Vec::new();
  if ctx.base_path.is_some() {
    for (ri, row) in table.rows.iter().enumerate() {
      if let Some(path) = row_path(ri) {
        let cells = table
          .columns
          .iter()
          .zip(row.iter())
          .map(|(col, cell)| (col.header.clone(), cell.plain_text().into_owned()))
          .collect();
        attrs.push((path, cells));
      }
    }
  }
  let anims = anims
    .map(|specs| resolve_anims(specs, &lines, &row_of_line))
    .unwrap_or_default();
  ShapeOutput {
    lines,
    paths,
    attrs,
    anims,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn hierarchy_branch_reflows_native_nodes_and_retains_flat_compatibility() {
    use tento_term::{Column, TreeTable, TreeTableNode};
    let mut host = TreeTableNode::group("host", "rwc-01");
    host
      .children
      .push(TreeTableNode::item("app", "spaces").field("version", "0.4.133"));
    let model = TreeTable {
      title: "Apps".into(),
      summary: "1 host".into(),
      columns: vec![
        Column::new("Host / App").min(18),
        Column::new("Installed").key("version").min(16).priority(2),
      ],
      roots: vec![host],
      notes: vec![],
    };
    let body = model.body().unwrap();
    let value = &body["sections"][1]["value"];
    let mut ctx = RenderCtx::cli();
    ctx.base_path = Some("turn:1");
    let rendered = TableWidget.render(value, 32, &ctx, &ShapeRegistry::core());
    assert_eq!(rendered.attrs.len(), 2);
    let mut flat = value.clone();
    flat.as_object_mut().unwrap().remove("hierarchy");
    #[cfg(not(feature = "native-tree-table"))]
    {
      let expected = TableWidget.render(&flat, 32, &ctx, &ShapeRegistry::core());
      assert_eq!(rendered.lines, expected.lines);
      assert_eq!(rendered.paths, expected.paths);
      assert_eq!(rendered.attrs, expected.attrs);
    }
    #[cfg(feature = "native-tree-table")]
    {
      assert!(
        rendered.attrs[1]
          .0
          .starts_with(&(rendered.attrs[0].0.clone() + "/node:"))
      );
      let plain: Vec<_> = rendered
        .lines
        .iter()
        .map(|line| tento_term::strip_ansi(line))
        .collect();
      assert!(
        !plain
          .iter()
          .any(|line| line.trim_end().ends_with("Installed:"))
      );
      assert!(plain.iter().any(|line| line.contains("0.4.133")));
    }
    let expected = TableWidget.render(&flat, 80, &ctx, &ShapeRegistry::core());
    let mut invalid = value.clone();
    invalid["hierarchy"] = json!({"roots":[]});
    let result = TableWidget.render(&invalid, 80, &ctx, &ShapeRegistry::core());
    assert_eq!(result.lines, expected.lines);
    assert_eq!(result.paths, expected.paths);
    invalid = value.clone();
    invalid["hierarchy"]["roots"][0]["id"] = json!("");
    let result = TableWidget.render(&invalid, 80, &ctx, &ShapeRegistry::core());
    assert_eq!(result.lines, expected.lines);
    assert_eq!(result.attrs, expected.attrs);
  }

  fn two_row_table() -> Value {
    json!({
      "shape": "table/v1",
      "columns": [{"header": "Name"}, {"header": "Qty"}],
      "rows": [["apple", "3"], ["pear", "7"]],
    })
  }

  /// `anims` resolves BY CONTENT against the finished line: the component
  /// names the painted run it wrote, and the widget reports where the table
  /// actually put it. A run the table truncated away yields no patch — a
  /// narrow pane degrades to the static glyph rather than animating whatever
  /// bytes happen to sit at a stale offset.
  #[test]
  fn animated_regions_resolve_against_the_assembled_line() {
    let reg = ShapeRegistry::core();
    let collapsed = std::collections::HashSet::new();
    let state = std::collections::HashMap::new();
    let ctx = RenderCtx {
      base_path: None,
      collapsed: &collapsed,
      widget_state: &state,
      resolver: &crate::FileSourceResolver,
      depth: 0,
    };
    let marker = "\u{1b}[36m* \u{1b}[0m";
    let value = json!({
      "shape": "table/v1",
      "header_rule": false,
      "columns": [{"header": ""}, {"header": ""}],
      "rows": [
        ["plain", "one"],
        [{"raw": format!("{marker}busy")}, "two"],
      ],
      "anims": [{
        "row": 1,
        "find": marker,
        "key": "herd/busy",
        "interval_ms": 90,
        "frames": ["\u{1b}[36m+ \u{1b}[0m", "\u{1b}[36mx \u{1b}[0m"],
      }],
    });
    let out = reg.render(&value, 40, &ctx).expect("table renders");
    assert_eq!(out.anims.len(), 1, "{:?}", out.anims);
    let patch = &out.anims[0];
    assert_eq!(patch.key, "herd/busy");
    assert_eq!(patch.interval_ms, 90);
    assert_eq!(patch.base, marker);
    assert_eq!(
      patch.width, 2,
      "the frames paint the cells the glyph reserved"
    );
    // The range is where the TABLE put it, not where the component guessed.
    let line = &out.lines[patch.row];
    assert_eq!(&line[patch.start..patch.end], marker);
    assert!(line.contains("busy"), "{line:?}");
    assert_eq!(patch.text_at(0), "\u{1b}[36m+ \u{1b}[0m");
    assert_eq!(patch.text_at(1), "\u{1b}[36mx \u{1b}[0m");

    // A row that is not there, a run the line does not carry, and a spec with
    // no frames are each simply not animated.
    for spec in [
      json!({"row": 9, "find": marker, "frames": ["x"]}),
      json!({"row": 1, "find": "\u{1b}[31mnope\u{1b}[0m", "frames": ["x"]}),
      json!({"row": 1, "find": marker, "frames": []}),
      json!({"row": 1, "find": "", "frames": ["x"]}),
    ] {
      let mut probe = value.clone();
      probe["anims"] = json!([spec]);
      assert!(
        reg
          .render(&probe, 40, &ctx)
          .expect("renders")
          .anims
          .is_empty(),
        "{spec}"
      );
    }
  }

  /// With a base path, data lines get `<base>/row:<i>` paths and attrs carry
  /// the cells in column order — the contract the trace pane's selection +
  /// detail view depend on.
  #[test]
  fn rows_are_addressable_under_base_path() {
    let reg = ShapeRegistry::core();
    let collapsed = std::collections::HashSet::new();
    let ctx = RenderCtx {
      base_path: Some("turn:5"),
      collapsed: &collapsed,
      widget_state: &crate::registry::EMPTY_WIDGET_STATE,
      resolver: &crate::FileSourceResolver,
      depth: 0,
    };
    let out = reg.render(&two_row_table(), 60, &ctx).expect("renders");
    assert!(
      out.paths.contains(&Some("turn:5/row:0".to_string())),
      "{:?}",
      out.paths
    );
    assert!(out.paths.contains(&Some("turn:5/row:1".to_string())));
    assert_eq!(out.attrs.len(), 2);
    assert_eq!(out.attrs[0].0, "turn:5/row:0");
    assert_eq!(
      out.attrs[0].1,
      vec![
        ("Name".to_string(), "apple".to_string()),
        ("Qty".to_string(), "3".to_string())
      ]
    );
  }

  /// CLI context (no base path): aligned text, no paths, no attrs.
  #[test]
  fn cli_render_has_no_paths_or_attrs() {
    let reg = ShapeRegistry::core();
    let out = reg
      .render(&two_row_table(), 60, &RenderCtx::cli())
      .expect("renders");
    assert!(out.paths.iter().all(Option::is_none));
    assert!(out.attrs.is_empty());
    let text = out.lines.join("\n");
    assert!(text.contains("apple"), "{text}");
    assert!(text.contains("Name"), "{text}");
  }

  #[test]
  fn malformed_table_degrades_to_diagnostic() {
    let reg = ShapeRegistry::core();
    let v = json!({"shape": "table/v1", "columns": "not-an-array"});
    let out = reg.render(&v, 60, &RenderCtx::cli()).expect("dispatches");
    assert!(out.lines[0].contains("table/v1"), "{}", out.lines[0]);
  }

  // ==== records-backed tables (raw rows ljson + view sidecar) ====

  /// A fixture session dir holding a `table-rows/v1` rows file (2 records)
  /// and, optionally, a view sidecar. Returns (dir, trace value).
  fn records_fixture(tag: &str, view: Option<&Value>) -> (std::path::PathBuf, Value) {
    use std::io::Write;
    let dir =
      std::env::temp_dir().join(format!("tento-shapes-records-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let rows_path = dir.join("ls-1.rows.ljson");
    let mut f = std::fs::File::create(&rows_path).unwrap();
    writeln!(
      f,
      "{}",
      json!({"v":1,"shape":"table-rows/v1","encoding":"records"})
    )
    .unwrap();
    writeln!(
      f,
      "{}",
      json!({"name":"subdir/","kind":"dir","size_bytes":null,"perms":"drwxr-xr-x"})
    )
    .unwrap();
    writeln!(
      f,
      "{}",
      json!({"name":"file.txt","kind":"file","size_bytes":1254,"perms":"-rw-r--r--"})
    )
    .unwrap();
    let view_path = dir.join("ls-1.view.json");
    if let Some(view) = view {
      std::fs::write(&view_path, serde_json::to_string(view).unwrap()).unwrap();
    }
    let value = json!({
      "shape": "table/v1",
      "columns": [
        {"header": "NAME", "key": "name"},
        {"header": "KIND", "key": "kind"},
        {"header": "SIZE", "key": "size_bytes", "format": "size_bytes", "align": "right"},
        {"header": "PERMS", "key": "perms", "default_hidden": true},
      ],
      "source": {"kind": "file", "path": rows_path.to_str().unwrap(), "row_shape": "records"},
      "view": {"path": view_path.to_str().unwrap()},
    });
    (dir, value)
  }

  /// A catalog sidecar overrides the inline columns (the Lisp-resolved
  /// catalog): a changed header renders from the sidecar, not the value.
  #[test]
  fn catalog_sidecar_overrides_inline_columns() {
    let (dir, mut value) = records_fixture("catalog", None);
    let catalog_path = dir.join("ls-1.catalog.json");
    // Same keys, but SIZE's header is renamed to "bytes".
    std::fs::write(
      &catalog_path,
      serde_json::to_string(&json!([
        {"header": "NAME", "key": "name"},
        {"header": "KIND", "key": "kind"},
        {"header": "bytes", "key": "size_bytes", "format": "size_bytes", "align": "right"},
        {"header": "MODIFIED", "key": "modified_ms", "format": "age_ms"},
      ]))
      .unwrap(),
    )
    .unwrap();
    value["catalog"] = json!({"path": catalog_path.to_str().unwrap()});
    let out = ShapeRegistry::core()
      .render(&value, 80, &RenderCtx::cli())
      .expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("bytes"), "sidecar header wins: {text}");
    assert!(
      !text.contains("SIZE"),
      "inline header is overridden: {text}"
    );
    assert!(text.contains("1.2K"), "format still applies: {text}");
    // Corrupt catalog sidecar → falls back to the inline columns (SIZE).
    std::fs::write(&catalog_path, "{not json").unwrap();
    let out = ShapeRegistry::core()
      .render(&value, 80, &RenderCtx::cli())
      .expect("renders");
    assert!(
      out.lines.join("\n").contains("SIZE"),
      "corrupt sidecar → inline fallback"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// No view sidecar → the catalog's default columns (PERMS is catalog-only),
  /// all records projected through their formats.
  #[test]
  fn records_source_without_view_renders_default_columns() {
    let (dir, value) = records_fixture("noview", None);
    let reg = ShapeRegistry::core();
    let out = reg.render(&value, 80, &RenderCtx::cli()).expect("renders");
    let text = out.lines.join("\n");
    assert!(
      text.contains("NAME") && text.contains("KIND") && text.contains("SIZE"),
      "{text}"
    );
    assert!(
      !text.contains("PERMS"),
      "default view hides catalog-only columns: {text}"
    );
    assert!(
      text.contains("subdir/") && text.contains("file.txt"),
      "{text}"
    );
    assert!(text.contains("1.2K"), "size_bytes formats: {text}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A view's explicit `columns` selects + orders, and can reveal a
  /// `default_hidden` catalog column; attrs carry the PROJECTED columns.
  #[test]
  fn records_source_with_view_projects_and_reveals() {
    let (dir, value) = records_fixture("view", Some(&json!({"columns": ["perms", "name"]})));
    let reg = ShapeRegistry::core();
    let collapsed = std::collections::HashSet::new();
    let ctx = RenderCtx {
      base_path: Some("turn:9"),
      collapsed: &collapsed,
      widget_state: &crate::registry::EMPTY_WIDGET_STATE,
      resolver: &crate::FileSourceResolver,
      depth: 0,
    };
    let out = reg.render(&value, 80, &ctx).expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("PERMS") && text.contains("NAME"), "{text}");
    assert!(!text.contains("KIND") && !text.contains("SIZE"), "{text}");
    assert_eq!(out.attrs.len(), 2);
    assert_eq!(
      out.attrs[0].1,
      vec![
        ("PERMS".to_string(), "drwxr-xr-x".to_string()),
        ("NAME".to_string(), "subdir/".to_string()),
      ]
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// `hidden` subtracts from the default view; corrupt view JSON degrades to
  /// the defaults instead of a diagnostic.
  #[test]
  fn records_view_hidden_and_corrupt_cases() {
    let (dir, value) = records_fixture("hidden", Some(&json!({"hidden": ["kind"]})));
    let reg = ShapeRegistry::core();
    let out = reg.render(&value, 80, &RenderCtx::cli()).expect("renders");
    let text = out.lines.join("\n");
    assert!(
      text.contains("NAME") && text.contains("SIZE") && !text.contains("KIND"),
      "{text}"
    );
    let _ = std::fs::remove_dir_all(&dir);

    let (dir, value) = records_fixture("corrupt", None);
    std::fs::write(dir.join("ls-1.view.json"), "{not json").unwrap();
    let out = reg.render(&value, 80, &RenderCtx::cli()).expect("renders");
    let text = out.lines.join("\n");
    assert!(text.contains("NAME") && text.contains("KIND"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// The one-shot CLI path (`render_text`) resolves records sources too.
  #[test]
  fn render_text_resolves_records_source() {
    let (dir, value) = records_fixture("clitext", None);
    let text = ShapeRegistry::core().render_text(&value).expect("renders");
    assert!(text.contains("file.txt") && text.contains("1.2K"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
