//! Hierarchical data on one responsive table grid. Producers supply identity,
//! children and semantic cell values; this module owns rails and the role budget.
//! `table/v1` rows are a compatibility projection. The accompanying hierarchy
//! lets current renderers rebuild at paint time, preserve node paths and omit
//! empty demoted fields. Older clients can still read the projected rows.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Cell, Column, Style, Table, paint_with_color};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
  Update,
  Attention,
  Error,
}

impl Severity {
  fn marker(self) -> (&'static str, &'static str) {
    match self {
      Self::Update => ("↑", "status.info"),
      Self::Attention => ("●", "status.warn"),
      Self::Error => ("●", "status.error"),
    }
  }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeTableValue {
  pub text: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub severity: Option<Severity>,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub dim: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub role: Option<String>,
}

impl TreeTableValue {
  pub fn text(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      severity: None,
      dim: false,
      role: None,
    }
  }

  pub fn dimmed(text: impl Into<String>) -> Self {
    Self {
      dim: true,
      ..Self::text(text)
    }
  }

  pub fn with_role(text: impl Into<String>, role: impl Into<String>) -> Self {
    Self {
      role: Some(role.into()),
      ..Self::text(text)
    }
  }

  pub fn flagged(text: impl Into<String>, severity: Severity) -> Self {
    Self {
      text: text.into(),
      severity: Some(severity),
      dim: false,
      role: None,
    }
  }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeTableNode {
  pub id: String,
  pub label: String,
  #[serde(default)]
  pub group: bool,
  #[serde(default)]
  pub fields: BTreeMap<String, TreeTableValue>,
  #[serde(default)]
  pub children: Vec<TreeTableNode>,
  /// A one-cell status icon between the rail and the label. Once any node is
  /// marked, every label reserves the slot; unmarked rows leave it blank.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub marker: Option<TreeTableValue>,
}

impl TreeTableNode {
  pub fn item(id: impl Into<String>, label: impl Into<String>) -> Self {
    Self {
      id: id.into(),
      label: label.into(),
      group: false,
      fields: BTreeMap::new(),
      children: Vec::new(),
      marker: None,
    }
  }

  pub fn group(id: impl Into<String>, label: impl Into<String>) -> Self {
    Self {
      group: true,
      ..Self::item(id, label)
    }
  }

  pub fn field(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
    self.fields.insert(key.into(), TreeTableValue::text(value));
    self
  }

  pub fn state(self, key: impl Into<String>, value: TreeTableValue) -> Self {
    self.value(key, value)
  }

  pub fn value(mut self, key: impl Into<String>, value: TreeTableValue) -> Self {
    self.fields.insert(key.into(), value);
    self
  }

  pub fn marker(mut self, value: TreeTableValue) -> Self {
    self.marker = Some(value);
    self
  }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeTableNote {
  pub text: String,
  pub severity: Option<Severity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeTable {
  pub title: String,
  pub summary: String,
  pub columns: Vec<Column>,
  pub roots: Vec<TreeTableNode>,
  #[serde(default)]
  pub notes: Vec<TreeTableNote>,
}

/// A native paint result, with one semantic node path per data line. Header
/// lines have no owner; continuations keep the same owner as their node.
pub struct TreeTableRender {
  pub lines: Vec<String>,
  pub paths: Vec<Option<String>>,
  pub attrs: Vec<(String, Vec<(String, String)>)>,
}

impl TreeTable {
  pub const MAX_NODES: usize = 8192;
  /// Invalid hierarchies fail visibly rather than recursing without a bound.
  pub fn validate(&self) -> Result<(), &'static str> {
    if self.columns.is_empty() {
      return Err("tree table needs an identity column");
    }
    let mut ids = HashSet::new();
    let mut count = 0;
    fn visit<'a>(
      nodes: &'a [TreeTableNode],
      depth: usize,
      ids: &mut HashSet<&'a str>,
      count: &mut usize,
    ) -> Result<(), &'static str> {
      if depth > 32 {
        return Err("tree table exceeds 32 levels");
      }
      for node in nodes {
        *count += 1;
        if *count > TreeTable::MAX_NODES {
          return Err("tree table exceeds 8192 nodes");
        }
        if node.id.is_empty() || node.id.chars().any(char::is_control) || !ids.insert(&node.id) {
          return Err("tree table needs unique, nonempty node ids");
        }
        visit(&node.children, depth + 1, ids, count)?;
      }
      Ok(())
    }
    visit(&self.roots, 0, &mut ids, &mut count)
  }

  fn project(
    &self,
    base: Option<&str>,
    collapsed: &HashSet<String>,
    compatibility: bool,
  ) -> (Table, Vec<(String, String)>) {
    fn marked(nodes: &[TreeTableNode]) -> bool {
      nodes.iter().any(|node| node.marker.is_some() || marked(&node.children))
    }
    let slot = marked(&self.roots);
    let mut table = Table::new(self.columns.clone())
      .gap("  ")
      .header_style(Style::role("text.secondary"));
    let mut identities = Vec::new();
    struct Walk<'a> {
      model: &'a TreeTable,
      table: &'a mut Table,
      identities: &'a mut Vec<(String, String)>,
      collapsed: &'a HashSet<String>,
      compatibility: bool,
      slot: bool,
      root_starts: Vec<usize>,
    }
    impl Walk<'_> {
      fn nodes(&mut self, nodes: &[TreeTableNode], lead: &str, parent: &str, roots: bool) {
        for (index, node) in nodes.iter().enumerate() {
          let last = index + 1 == nodes.len();
          let prefix = if roots {
            String::new()
          } else {
            format!("{lead}{} ", if last { "└" } else { "├" })
          };
          let path = format!("{parent}/node:{}", path_segment(&node.id));
          if roots && index > 0 {
            // Hosts are separated: native paint draws a faint rule before the
            // row; compatible readers have no rules, so they get a blank row.
            if self.compatibility {
              self
                .table
                .rows
                .push(vec![Cell::empty(); self.model.columns.len()]);
            } else {
              self.root_starts.push(self.table.rows.len());
            }
          }
          let icon = node.marker.as_ref().map_or(if roots { "" } else { " " }, |m| m.text.as_str());
          let identity = if self.compatibility {
            let label_style = if node.group { Style::Bold } else { Style::None };
            match (&node.marker, self.slot) {
              // A compatible cell has one style, so a colored icon makes the
              // cell pre-painted. The producer runs without a terminal, so
              // the paint is forced, in the palette compatible cells use.
              (Some(TreeTableValue { text, role: Some(role), .. }), true) => Cell::raw(format!(
                "{prefix}{} {}",
                force_paint(compatible_role(role), text),
                force_paint(label_style, &node.label)
              )),
              _ => {
                let slot = if self.slot { format!("{icon} ") } else { String::new() };
                Cell::new(format!("{prefix}{slot}{}", node.label), label_style)
              }
            }
          } else {
            let slot = match (&node.marker, self.slot) {
              (_, false) => String::new(),
              (Some(TreeTableValue { text, role: Some(role), .. }), true) => {
                format!("{} ", paint(role, text, false))
              }
              (_, true) => format!("{icon} "),
            };
            Cell::raw(format!(
              "{}{slot}{}",
              paint("text.faint", &prefix, false),
              paint("text", &node.label, node.group)
            ))
          };
          let mut row = Vec::with_capacity(self.model.columns.len());
          row.push(identity);
          for column in self.model.columns.iter().skip(1) {
            let key = column.key.as_deref().unwrap_or(&column.header);
            let value = node.fields.get(key);
            row.push(match value {
              Some(TreeTableValue {
                text,
                severity: Some(severity),
                ..
              }) => {
                let (marker, role) = severity.marker();
                if self.compatibility {
                  Cell::new(format!("{marker} {text}"), Style::role(role))
                } else {
                  Cell::raw(format!(
                    "{} {}",
                    paint(role, marker, false),
                    paint("text.secondary", text, false)
                  ))
                }
              }
              Some(value) if value.dim => Cell::new(&value.text, Style::Dimmed),
              Some(TreeTableValue {
                text,
                role: Some(role),
                ..
              }) => {
                if self.compatibility {
                  Cell::new(text, compatible_role(role))
                } else {
                  Cell::raw(paint(role, text, false))
                }
              }
              Some(value) => Cell::new(
                &value.text,
                column.style.unwrap_or(Style::role("text.secondary")),
              ),
              None => Cell::empty(),
            });
          }
          self.table.rows.push(row);
          self.identities.push((path.clone(), node.id.clone()));
          if !self.collapsed.contains(&path) {
            let next = if roots {
              " ".to_string()
            } else {
              format!("{lead}{}", if last { "  " } else { "│ " })
            };
            self.nodes(&node.children, &next, &path, false);
          }
        }
      }
    }
    let mut walk = Walk {
      model: self,
      table: &mut table,
      identities: &mut identities,
      collapsed,
      compatibility,
      slot,
      root_starts: Vec::new(),
    };
    walk.nodes(&self.roots, "", base.unwrap_or(""), true);
    let starts: HashSet<usize> = walk.root_starts.into_iter().collect();
    if !starts.is_empty() {
      table = table.section_break(move |row, _| starts.contains(&row));
    }
    (table, identities)
  }

  /// Compatible output for existing clients. This is deliberately called a
  /// projection: only an aware renderer consumes `hierarchy` as native nodes.
  pub fn body(&self) -> Result<Value, &'static str> {
    self.validate()?;
    let (table, _) = self.project(None, &HashSet::new(), true);
    let mut value = serde_json::to_value(table.into_body()).expect("tree table serializes");
    value["hierarchy"] = serde_json::to_value(self).expect("hierarchy serializes");
    let mut sections = vec![
      json!({"value":{"shape":"term.block/v1","rows":[{"spans":[
      {"text":self.title,"fg":"text.primary","bold":true},
      {"text":format!(" · {}",self.summary),"fg":"text.secondary"}
    ],"wrap":"word"}]}}),
      json!({"value":value}),
    ];
    if !self.notes.is_empty() {
      let rows: Vec<_> = self
        .notes
        .iter()
        .map(|note| {
          let mut spans = Vec::new();
          if let Some(severity) = note.severity {
            let (marker, role) = severity.marker();
            spans.push(json!({"text":format!("{marker} "),"fg":role}));
          }
          spans.push(json!({"text":note.text,"fg":"text.secondary"}));
          json!({"spans":spans,"wrap":"word"})
        })
        .collect();
      sections.push(json!({"value":{"shape":"term.block/v1","rows":rows}}));
    }
    Ok(json!({"shape":"sections/v1","indent":0,"sections":sections}))
  }

  /// Native hierarchy paint: columns share one fit, and absent parent metadata
  /// does not become empty demoted sublines. Paths retain actual ancestry.
  pub fn render(
    &self,
    width: usize,
    base: Option<&str>,
    collapsed: &HashSet<String>,
  ) -> Result<TreeTableRender, &'static str> {
    self.validate()?;
    let (table, identities) = self.project(base, collapsed, false);
    let (lines, owners) = table.render_lines_with_rows_sparse(width);
    let paths = owners
      .iter()
      .map(|owner| owner.and_then(|index| base.map(|_| identities[index].0.clone())))
      .collect();
    let attrs = if base.is_some() {
      identities
        .iter()
        .zip(&table.rows)
        .map(|((path, id), row)| {
          let mut values: Vec<_> = table
            .columns
            .iter()
            .zip(row)
            .map(|(column, cell)| (column.header.clone(), cell.plain_text().into_owned()))
            .collect();
          values.push(("id".into(), id.clone()));
          (path.clone(), values)
        })
        .collect()
    } else {
      Vec::new()
    };
    Ok(TreeTableRender {
      lines,
      paths,
      attrs,
    })
  }
}

fn path_segment(id: &str) -> String {
  id.bytes()
    .map(|byte| {
      if byte.is_ascii_alphanumeric() || b"-_.".contains(&byte) {
        (byte as char).to_string()
      } else {
        format!("%{byte:02X}")
      }
    })
    .collect()
}

// Old table readers understand these styles and resolve them in the VIEWER.
// Keep projection data free of baked-in SGR, so repainting a retained result
// under another theme also repaints its category and state values.
fn compatible_role(role: &str) -> Style {
  match role {
    "channel.stable" | "kind.service" => Style::Green,
    "channel.nightly" | "kind.plugin" => Style::Magenta,
    "kind.native" => Style::Blue,
    "kind.miniapp" => Style::Cyan,
    "kind.extension" => Style::Yellow,
    "kind.cli" => Style::White,
    "text.faint" | "text.secondary" => Style::Dimmed,
    "status.warn" => Style::Yellow,
    "status.info" => Style::Blue,
    "status.error" => Style::Red,
    _ => Style::None,
  }
}

/// `style` painted whether or not this process has a terminal.
fn force_paint(style: Style, text: &str) -> String {
  if style == Style::None {
    return text.to_string();
  }
  let tokens = if style == Style::Dimmed { "dim" } else { style.wire_name() };
  paint_with_color(text, &crate::style_from_tokens(tokens), true)
}

fn paint(role: &str, text: &str, bold: bool) -> String {
  if text.is_empty() {
    return String::new();
  }
  let fallback = compatible_role(role);
  let mut style = crate::role::resolve(role)
    .or_else(|| crate::role::resolve(fallback.role_name()))
    .unwrap_or_else(|| {
      crate::style_from_tokens(if fallback == Style::Dimmed {
        "dim"
      } else {
        fallback.wire_name()
      })
    });
  style.bold |= bold;
  paint_with_color(
    text,
    &style,
    colored::control::SHOULD_COLORIZE.should_colorize(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::strip_ansi;

  fn fixture() -> TreeTable {
    let mut host = TreeTableNode::group("host/one", "rwc-01").field("state", "2 apps");
    host.children = vec![
      TreeTableNode::item("app/spaces", "Spaces 東京")
        .field("installed", "0.4.133")
        .value(
          "channel",
          TreeTableValue::with_role("nightly", "channel.nightly"),
        )
        .state(
          "state",
          TreeTableValue::flagged("Update ready", Severity::Update),
        ),
      TreeTableNode::item("app/tsh", "tsh")
        .field("installed", "0.1.56")
        .state("state", TreeTableValue::dimmed("Latest")),
    ];
    TreeTable {
      title: "Fleet apps".into(),
      summary: "1 host · 2 apps".into(),
      columns: vec![
        Column::new("Host / App").key("label").min(18).flex(1),
        Column::new("Installed")
          .key("installed")
          .min(16)
          .priority(2),
        Column::new("Channel").key("channel").min(7).priority(3),
        Column::new("State").key("state").min(14).priority(1),
      ],
      roots: vec![host],
      notes: vec![],
    }
  }

  #[test]
  fn markers_sit_between_rail_and_label_and_hosts_are_separated() {
    let mut model = fixture();
    let spaces = model.roots[0].children[0].clone();
    model.roots[0].children[0] =
      spaces.marker(TreeTableValue::with_role("↑", "status.info"));
    let mut other = TreeTableNode::group("host/two", "rwc-05");
    other.children = vec![TreeTableNode::item("app/x", "x").field("installed", "1")];
    model.roots.push(other);
    let body = model.body().unwrap();
    let table = &body["sections"][1]["value"];
    assert_eq!(table["columns"].as_array().unwrap().len(), 4);
    let fallback: Table = serde_json::from_value(table.clone()).unwrap();
    // Compatible rows: icon slot after the rail, blank slot when unmarked,
    // and one blank spacer row between hosts.
    assert_eq!(fallback.rows[0][0].plain_text(), " rwc-01");
    assert_eq!(fallback.rows[1][0].plain_text(), " ├ ↑ Spaces 東京");
    assert_eq!(fallback.rows[2][0].plain_text(), " └   tsh");
    assert!(fallback.rows[3].iter().all(|c| c.plain_text().is_empty()));
    assert_eq!(fallback.rows[4][0].plain_text(), " rwc-05");
    assert_eq!(fallback.rows[1][1].plain_text(), "0.4.133");
    // The icon keeps its color in compatible rows: the producer has no
    // terminal, so the cell arrives pre-painted; the label stays unpainted.
    let Cell::Raw(painted) = &fallback.rows[1][0] else { panic!("marked rows are pre-painted") };
    assert!(painted.contains("\u{1b}[34m↑\u{1b}[0m Spaces"), "{painted:?}");
    assert!(matches!(fallback.rows[2][0], Cell::Styled { .. }), "unmarked rows keep one style");
    let mut warned = fixture();
    let tsh = warned.roots[0].children[1].clone();
    warned.roots[0].children[1] = tsh.marker(TreeTableValue::with_role("!", "status.warn"));
    let rows: Table = serde_json::from_value(warned.body().unwrap()["sections"][1]["value"].clone()).unwrap();
    let Cell::Raw(bang) = &rows.rows[2][0] else { panic!("a warning icon is pre-painted") };
    assert!(bang.contains("\u{1b}[33m!\u{1b}[0m"), "{bang:?}");
    let decoded: TreeTable = serde_json::from_value(table["hierarchy"].clone()).unwrap();
    assert_eq!(decoded.roots[0].children[0].marker.as_ref().unwrap().text, "↑");
    // Native paint: a rule separates hosts instead of a blank row.
    let lines = model.render(80, None, &HashSet::new()).unwrap().lines;
    let plain: Vec<_> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert!(plain.iter().any(|l| l.starts_with(" ├ ↑ Spaces")), "{plain:?}");
    let host_two = plain.iter().position(|l| l.contains("rwc-05")).unwrap();
    assert!(plain[host_two - 1].starts_with('─'), "{plain:?}");
    // Unmarked tables keep labels unpadded.
    let plain_table: Table =
      serde_json::from_value(fixture().body().unwrap()["sections"][1]["value"].clone()).unwrap();
    assert_eq!(plain_table.rows[1][0].plain_text(), " ├ Spaces 東京");
  }

  #[test]
  fn one_grid_retains_real_hierarchy_and_compatible_rows() {
    let model = fixture();
    let body = model.body().unwrap();
    let table = &body["sections"][1]["value"];
    assert_eq!(table["shape"], "table/v1");
    assert_eq!(table["rows"].as_array().unwrap().len(), 3);
    let decoded: TreeTable = serde_json::from_value(table["hierarchy"].clone()).unwrap();
    assert_eq!(decoded.roots[0].children[0].label, "Spaces 東京");
    // An old reader ignores hierarchy and still sees every original field.
    let fallback: Table = serde_json::from_value(table.clone()).unwrap();
    assert_eq!(fallback.rows[1][1].plain_text(), "0.4.133");
    assert_eq!(
      decoded.roots[0].children[0].fields["channel"]
        .role
        .as_deref(),
      Some("channel.nightly")
    );
    assert!(matches!(
      &fallback.rows[1][2],
      Cell::Styled {
        style: Style::Magenta,
        ..
      }
    ));
    assert!(fallback.rows[1][0].plain_text().contains(" ├ Spaces 東京"));
    assert!(!serde_json::to_string(&body).unwrap().contains("\\u001b"));
    let flag = &fallback.rows[1][3];
    assert_eq!(flag.plain_text(), "↑ Update ready");
    assert!(matches!(flag, Cell::Styled { style, .. } if style.role_name() == "status.info"));
    assert!(matches!(
      &fallback.rows[2][3],
      Cell::Styled {
        style: Style::Dimmed,
        ..
      }
    ));
  }

  #[test]
  fn retained_projection_resolves_theme_at_paint_time() {
    let body = fixture().body().unwrap();
    let table: Table = serde_json::from_value(body["sections"][1]["value"].clone()).unwrap();
    let Cell::Styled { style, .. } = table.rows[1][2] else {
      panic!("role must survive as a styled cell")
    };
    for (color, expected) in [
      ("#6639ba", "38;2;102;57;186"),
      ("#bb9af7", "38;2;187;154;247"),
    ] {
      let mut roles = crate::RoleTable::new();
      roles.bind("ansi.magenta", &format!("fg:{color}"));
      crate::with_roles(roles, || assert!(style.code().contains(expected)));
    }
    assert_eq!(compatible_role("kind.miniapp"), Style::Cyan);
  }

  #[test]
  fn narrow_paint_has_no_empty_parent_metadata_and_keeps_node_ownership() {
    for width in [40, 80, 140] {
      let render = fixture()
        .render(width, Some("turn:1"), &HashSet::new())
        .unwrap();
      let lines: Vec<_> = render.lines.iter().map(|line| strip_ansi(line)).collect();
      assert!(lines.iter().all(|line| crate::visual_width(line) <= width));
      assert_eq!(
        lines
          .iter()
          .filter(|line| line.contains("Host / App"))
          .count(),
        1
      );
      let host_path = render.attrs[0].0.clone();
      assert_eq!(
        render
          .paths
          .iter()
          .filter(|path| **path == Some(host_path.clone()))
          .count(),
        1
      );
      assert!(render.attrs[1].0.starts_with(&(host_path + "/node:")));
      assert!(lines.iter().any(|line| line.contains("Spaces 東京")));
      if width == 40 {
        assert!(lines.iter().any(|line| line.contains("Installed: 0.4.133")));
        assert!(
          lines
            .iter()
            .all(|line| !line.trim_end().ends_with("Installed:"))
        );
        assert!(
          lines
            .iter()
            .all(|line| !line.trim_end().ends_with("Channel:"))
        );
      }
    }
  }

  #[test]
  fn collapse_keeps_parent_and_uses_escaped_stable_ids() {
    let model = fixture();
    let parent = "turn:1/node:host%2Fone".to_string();
    let collapsed = HashSet::from([parent.clone()]);
    let render = model.render(80, Some("turn:1"), &collapsed).unwrap();
    assert_eq!(render.attrs.len(), 1);
    assert_eq!(render.attrs[0].0, parent);
    assert!(!render.lines.iter().any(|line| line.contains("Spaces")));
  }

  #[test]
  fn invalid_id_topology_is_a_visible_error() {
    let mut model = fixture();
    model.roots[0].children[0].id = model.roots[0].id.clone();
    assert!(model.body().is_err());
    assert!(model.render(80, None, &HashSet::new()).is_err());
  }
}
