//! A responsive table model: columns declare min/max width, a flex weight, an
//! overflow policy and a priority; when the terminal is too narrow the table
//! shrinks shrinkable columns toward their minimums and, if that's still not
//! enough, demotes the lowest-priority columns out of the grid and renders them
//! as a per-row sub-tree (`├── ColName: value`) — a hybrid tree/table.

use serde::{Deserialize, Serialize};

use crate::draw::{BoxChars, box_chars};
use crate::format::CellFormat;
use crate::pad::Align;
use crate::style::{Cell, Overflow, Style};
use crate::width::visual_width;

/// Minimum width a shrinkable column is allowed to reach (room for `…`), unless
/// its explicit `min_width` is larger or its natural width is smaller.
const MIN_FLOOR: usize = 3;

/// Predicate that decides whether a `─` rule is drawn before a given row
/// (`(row_index, row_cells)`).
pub type SectionBreakFn = dyn Fn(usize, &[Cell]) -> bool;

/// A table column specification.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Column {
  pub header: String,
  #[serde(default)]
  pub align: Align,
  #[serde(default)]
  pub min_width: usize,
  #[serde(default)]
  pub max_width: Option<usize>,
  /// Share of leftover width when the table is narrower than the terminal.
  /// `0` (the default) = never grow past natural width.
  #[serde(default)]
  pub flex: u16,
  /// Lower = kept in the grid longer. Higher-numbered columns are demoted to
  /// per-row sub-lines first when space runs out.
  #[serde(default)]
  pub priority: u8,
  #[serde(default)]
  pub overflow: Overflow,
  /// Default style for every cell in this column (a cell's own style wins).
  #[serde(default)]
  pub style: Option<Style>,
  /// Row-record field this column reads when the table's rows come from a
  /// `row_shape:"records"` source. `None` → the lowercased header.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub key: Option<String>,
  /// How the raw record value renders (`None` → [`CellFormat::Text`]).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub format: Option<CellFormat>,
  /// Catalog-only column: part of the available set but not of the default
  /// view (rendered only when a view names it).
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub default_hidden: bool,
}

impl Column {
  pub fn new(header: impl Into<String>) -> Self {
    Column {
      header: header.into(),
      align: Align::Left,
      min_width: 0,
      max_width: None,
      flex: 0,
      priority: 0,
      overflow: Overflow::TruncateEnd,
      style: None,
      key: None,
      format: None,
      default_hidden: false,
    }
  }
  pub fn key(mut self, k: impl Into<String>) -> Self {
    self.key = Some(k.into());
    self
  }
  pub fn format(mut self, f: CellFormat) -> Self {
    self.format = Some(f);
    self
  }
  pub fn default_hidden(mut self) -> Self {
    self.default_hidden = true;
    self
  }
  pub fn align(mut self, a: Align) -> Self {
    self.align = a;
    self
  }
  pub fn min(mut self, w: usize) -> Self {
    self.min_width = w;
    self
  }
  pub fn max(mut self, w: usize) -> Self {
    self.max_width = Some(w);
    self
  }
  pub fn flex(mut self, f: u16) -> Self {
    self.flex = f;
    self
  }
  pub fn priority(mut self, p: u8) -> Self {
    self.priority = p;
    self
  }
  pub fn overflow(mut self, o: Overflow) -> Self {
    self.overflow = o;
    self
  }
  pub fn style(mut self, s: Style) -> Self {
    self.style = Some(s);
    self
  }
}

/// A renderable table.
#[derive(Serialize, Deserialize)]
pub struct Table {
  #[serde(default)]
  pub title: Option<Cell>,
  /// Style applied to the header cells and the `─` rule (e.g. `Dimmed`).
  #[serde(default)]
  pub header_style: Option<Style>,
  pub columns: Vec<Column>,
  #[serde(default)]
  pub rows: Vec<Vec<Cell>>,
  /// Data-row indexes rendered with the shared full-width hover band.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub highlighted_rows: Vec<usize>,
  /// String drawn between columns.
  #[serde(default = "default_gap")]
  pub gap: String,
  /// Draw a `─` rule under the header.
  #[serde(default = "default_true")]
  pub header_rule: bool,
  /// Indent (spaces) of the hybrid sub-lines.
  #[serde(default = "default_subline_indent")]
  pub subline_indent: usize,
  /// Optional predicate: a `─` rule is drawn before each row for which it
  /// returns true. (Not serialised.)
  #[serde(skip)]
  pub section_break: Option<Box<SectionBreakFn>>,
  #[serde(skip)]
  pub box_chars: BoxChars,
}

fn default_gap() -> String {
  " ".to_string()
}
fn default_true() -> bool {
  true
}
fn default_subline_indent() -> usize {
  3
}

impl std::fmt::Debug for Table {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Table")
      .field("title", &self.title)
      .field("header_style", &self.header_style)
      .field("columns", &self.columns)
      .field("rows", &self.rows)
      .field("highlighted_rows", &self.highlighted_rows)
      .field("gap", &self.gap)
      .field("header_rule", &self.header_rule)
      .field("subline_indent", &self.subline_indent)
      .field("section_break", &self.section_break.is_some())
      .finish()
  }
}

impl Table {
  pub fn new(columns: Vec<Column>) -> Self {
    Table {
      title: None,
      header_style: None,
      columns,
      rows: Vec::new(),
      highlighted_rows: Vec::new(),
      gap: default_gap(),
      header_rule: true,
      subline_indent: default_subline_indent(),
      section_break: None,
      box_chars: box_chars(),
    }
  }
  pub fn title(mut self, t: impl Into<Cell>) -> Self {
    self.title = Some(t.into());
    self
  }
  pub fn header_style(mut self, s: Style) -> Self {
    self.header_style = Some(s);
    self
  }
  pub fn gap(mut self, g: impl Into<String>) -> Self {
    self.gap = g.into();
    self
  }
  pub fn header_rule(mut self, on: bool) -> Self {
    self.header_rule = on;
    self
  }
  pub fn push_row(&mut self, row: Vec<Cell>) {
    self.rows.push(row);
  }
  pub fn highlight_row(mut self, row: usize) -> Self {
    self.highlighted_rows.push(row);
    self
  }
  pub fn section_break(mut self, f: impl Fn(usize, &[Cell]) -> bool + 'static) -> Self {
    self.section_break = Some(Box::new(f));
    self
  }

  /// Render to a `String` (lines joined by `\n`, no trailing newline).
  pub fn render(&self, term_width: usize) -> String {
    self.render_lines(term_width).join("\n")
  }
  /// Render with the auto-detected terminal width.
  pub fn render_auto(&self) -> String {
    self.render(crate::term::term_columns())
  }
  pub fn render_to(&self, to: &mut impl std::fmt::Write, term_width: usize) -> std::fmt::Result {
    to.write_str(&self.render(term_width))
  }

  /// Draw the table at the current terminal width, then re-draw it in place on
  /// every terminal resize (re-flowing: shrink / demote / un-demote columns).
  /// Blocks; use only when `out` is a terminal. See [`crate::live::watch`].
  #[cfg(feature = "watch")]
  pub fn watch<W: std::io::Write>(&self, out: &mut W) -> std::io::Result<()> {
    crate::live::watch(out, || self.render_lines(crate::term::term_columns()))
  }

  /// Render to a `Vec` of lines (each already trailing-whitespace-stripped).
  pub fn render_lines(&self, term_width: usize) -> Vec<String> {
    self.render_lines_with_rows(term_width).0
  }

  /// Like [`Self::render_lines`], but also returns — per output line — the
  /// source data-row it renders: `Some(row_index)` for a row's flat line and
  /// each of its demoted sub-lines, `None` for the title, header, header rule,
  /// and section-break rules. The two vectors index in lockstep (same length).
  /// Lets a caller map a rendered line back to its row (e.g. row selection).
  pub fn render_lines_with_rows(&self, term_width: usize) -> (Vec<String>, Vec<Option<usize>>) {
    self.render_lines_with_rows_inner(term_width, false)
  }

  pub(crate) fn render_lines_with_rows_sparse(
    &self,
    term_width: usize,
  ) -> (Vec<String>, Vec<Option<usize>>) {
    self.render_lines_with_rows_inner(term_width, true)
  }

  fn render_lines_with_rows_inner(
    &self,
    term_width: usize,
    skip_empty: bool,
  ) -> (Vec<String>, Vec<Option<usize>>) {
    let term_width = term_width.max(1);
    let gap_w = visual_width(&self.gap);
    let layout = self.fit(term_width, gap_w);
    let content_w = layout.content_total(&self.columns, gap_w, &layout.width);
    let rule_w = content_w.min(term_width);
    let header_style = self.header_style.unwrap_or(Style::None);

    let mut out: Vec<String> = Vec::new();
    let mut row_of_line: Vec<Option<usize>> = Vec::new();

    if let Some(t) = &self.title {
      let line = t.render_fit(term_width, Overflow::TruncateEnd, Style::None);
      out.push(strip_trailing(&line));
      row_of_line.push(None);
    }

    // Header row — skipped when every column is headerless (the plain-list
    // idiom), which would otherwise render as a blank line.
    if self.columns.iter().any(|c| !c.header.is_empty()) {
      let mut line = String::new();
      for (k, &ci) in layout.kept.iter().enumerate() {
        if k > 0 {
          line.push_str(&self.gap);
        }
        let col = &self.columns[ci];
        line.push_str(&Cell::plain(&col.header).render_field(
          layout.width[ci],
          col.align,
          Overflow::TruncateEnd,
          header_style,
        ));
      }
      out.push(strip_trailing(&line));
      row_of_line.push(None);
    }

    if self.header_rule {
      out.push(strip_trailing(
        &header_style.paint(&self.box_chars.hbar.repeat(rule_w)),
      ));
      row_of_line.push(None);
    }

    // Demoted columns shown as sub-lines, in (priority asc, index asc) order.
    let mut sub_cols = layout.demoted.clone();
    sub_cols.sort_by_key(|&i| (self.columns[i].priority, i));

    for (ri, row) in self.rows.iter().enumerate() {
      let highlighted = self.highlighted_rows.contains(&ri);
      if let Some(f) = &self.section_break {
        if f(ri, row) {
          out.push(strip_trailing(
            &header_style.paint(&self.box_chars.hbar.repeat(rule_w)),
          ));
          row_of_line.push(None);
        }
      }
      // Flat line over the kept columns.
      let mut line = String::new();
      for (k, &ci) in layout.kept.iter().enumerate() {
        if k > 0 {
          line.push_str(&self.gap);
        }
        let col = &self.columns[ci];
        let cell = row.get(ci).cloned().unwrap_or_default();
        line.push_str(&cell.render_field(
          layout.width[ci],
          col.align,
          col.overflow,
          col.style.unwrap_or(Style::None),
        ));
      }
      out.push(if highlighted {
        highlight_row_line(&line, content_w)
      } else if debug_tint() {
        tint_row_line(&line, content_w)
      } else {
        strip_trailing(&line)
      });
      row_of_line.push(Some(ri));

      // Sub-lines for demoted columns.
      let row_sub_cols: Vec<_> = sub_cols
        .iter()
        .copied()
        .filter(|&ci| {
          !skip_empty
            || row
              .get(ci)
              .is_some_and(|cell| !cell.plain_text().is_empty())
        })
        .collect();
      for (si, &ci) in row_sub_cols.iter().enumerate() {
        let col = &self.columns[ci];
        let is_last = si + 1 == row_sub_cols.len();
        let glyph = self.box_chars.branch(is_last);
        let header_label = Style::Dimmed.paint(&col.header);
        // Prefix width is computed on visible text.
        let prefix_w = self.subline_indent
                    + visual_width(glyph)
                    + 1 // space after the glyph
                    + visual_width(&col.header)
                    + 2; // ": "
        let avail = term_width.saturating_sub(prefix_w);
        let cell = row.get(ci).cloned().unwrap_or_default();
        let value = cell.render_fit(avail, col.overflow, col.style.unwrap_or(Style::None));
        let full = format!(
          "{}{glyph} {header_label}: {value}",
          " ".repeat(self.subline_indent)
        );
        // Last-resort: if even the header didn't fit, clamp the whole line.
        let full = crate::pad::truncate_ellipsis(&full, term_width, "…");
        out.push(if highlighted {
          highlight_row_line(&full, term_width)
        } else if debug_tint() {
          tint_row_line(&full, term_width)
        } else {
          strip_trailing(&full)
        });
        row_of_line.push(Some(ri));
      }
    }
    (out, row_of_line)
  }

  // --- layout ------------------------------------------------------------

  #[allow(clippy::needless_range_loop)]
  fn fit(&self, term_width: usize, gap_w: usize) -> Layout {
    let n = self.columns.len();
    // 1. natural width = max(header, widest cell).
    let mut natural = vec![0usize; n];
    for i in 0..n {
      natural[i] = visual_width(&self.columns[i].header);
      for row in &self.rows {
        if let Some(c) = row.get(i) {
          natural[i] = natural[i].max(c.width());
        }
      }
    }
    // 2. base = clamp(natural, min, max); floor = max(min, min(base, MIN_FLOOR)).
    let mut base = vec![0usize; n];
    let mut floor = vec![0usize; n];
    for i in 0..n {
      let col = &self.columns[i];
      let mx = col.max_width.unwrap_or(usize::MAX);
      base[i] = natural[i].max(col.min_width).min(mx);
      floor[i] = col.min_width.max(base[i].min(MIN_FLOOR)).min(base[i]);
    }

    let mut kept: Vec<usize> = (0..n).collect();
    let mut width = base.clone();
    let mut demoted: Vec<usize> = Vec::new();

    // 3. fits at base? distribute slack to flex columns; done.
    if content_total(&kept, gap_w, &width) <= term_width {
      self.grow(&kept, &mut width, term_width, gap_w);
      return Layout {
        kept,
        width,
        demoted,
      };
    }

    // 4. shrink toward floors.
    self.shrink(&kept, &mut width, &floor, term_width, gap_w);
    if content_total(&kept, gap_w, &width) <= term_width {
      return Layout {
        kept,
        width,
        demoted,
      };
    }

    // 5. demote lowest-priority columns one at a time, re-shrinking after.
    while content_total(&kept, gap_w, &width) > term_width && kept.len() > 1 {
      let pos = kept
        .iter()
        .enumerate()
        .max_by_key(|&(_, &i)| (self.columns[i].priority, i))
        .map(|(p, _)| p)
        .unwrap();
      let victim = kept.remove(pos);
      demoted.push(victim);
      for &i in &kept {
        width[i] = base[i];
      }
      self.shrink(&kept, &mut width, &floor, term_width, gap_w);
    }

    // 6. degenerate: a single column still too wide — the cell render will
    //    truncate it; clamp the field so no line exceeds the terminal.
    if kept.len() == 1 {
      let i = kept[0];
      width[i] = width[i].min(term_width.max(1));
    }
    Layout {
      kept,
      width,
      demoted,
    }
  }

  /// Distribute leftover width to `flex > 0` columns (capped at `max_width`),
  /// proportionally to `flex`, multi-pass.
  fn grow(&self, kept: &[usize], width: &mut [usize], target: usize, gap_w: usize) {
    let mut guard = 0;
    loop {
      guard += 1;
      if guard > 64 {
        break;
      }
      let cur = content_total(kept, gap_w, width);
      if cur >= target {
        break;
      }
      let slack = target - cur;
      let flexers: Vec<usize> = kept
        .iter()
        .cloned()
        .filter(|&i| {
          self.columns[i].flex > 0 && width[i] < self.columns[i].max_width.unwrap_or(usize::MAX)
        })
        .collect();
      if flexers.is_empty() {
        break;
      }
      let total_flex: u64 = flexers.iter().map(|&i| self.columns[i].flex as u64).sum();
      let mut grew = false;
      for &i in &flexers {
        let want = (slack as u64 * self.columns[i].flex as u64 / total_flex) as usize;
        let cap = self.columns[i].max_width.unwrap_or(usize::MAX) - width[i];
        let add = want.min(cap);
        if add > 0 {
          width[i] += add;
          grew = true;
        }
      }
      if !grew {
        // Hand one column at a time to the first flexer that can take
        // it; the outer loop recomputes the remaining slack.
        let mut handed = false;
        if slack > 0 {
          for &i in &flexers {
            if width[i] < self.columns[i].max_width.unwrap_or(usize::MAX) {
              width[i] += 1;
              handed = true;
              break;
            }
          }
        }
        if !handed {
          break;
        }
      }
    }
  }

  /// Shrink shrinkable columns (`width > floor`) toward their floors until the
  /// content fits `target` or nothing is shrinkable. Proportional to each
  /// column's remaining slack, with a largest-first single-step fixup.
  fn shrink(
    &self,
    kept: &[usize],
    width: &mut [usize],
    floor: &[usize],
    target: usize,
    gap_w: usize,
  ) {
    let mut guard = 0;
    loop {
      guard += 1;
      if guard > 4096 {
        break;
      }
      let cur = content_total(kept, gap_w, width);
      if cur <= target {
        break;
      }
      let need = cur - target;
      let shr: Vec<usize> = kept
        .iter()
        .cloned()
        .filter(|&i| width[i] > floor[i])
        .collect();
      if shr.is_empty() {
        break;
      }
      let total_slack: u64 = shr.iter().map(|&i| (width[i] - floor[i]) as u64).sum();
      let mut reduced = 0usize;
      for &i in &shr {
        let want = (need as u64 * (width[i] - floor[i]) as u64 / total_slack) as usize;
        let dec = want.min(width[i] - floor[i]);
        width[i] -= dec;
        reduced += dec;
      }
      if reduced == 0 {
        // Proportional rounding bottomed out — drop one column from the
        // widest shrinkable column (ties to the lowest index).
        let i = *shr
          .iter()
          .max_by_key(|&&i| (width[i], std::cmp::Reverse(i)))
          .unwrap();
        width[i] -= 1;
      }
    }
  }
}

/// The shape id for a `table/v1` turn-item / pane `stdout`.
pub const TABLE_V1: &str = "table/v1";

/// A [`Table`] tagged with its `shape`, so a serialized table self-describes as
/// `{ "shape":"table/v1", …table fields… }`. Build via [`Table::into_body`].
///
/// A renderer may equally deserialize the same object straight into [`Table`] —
/// the extra `shape` field is ignored (serde skips unknown fields).
#[derive(Serialize, Deserialize)]
pub struct TableBody {
  pub shape: String,
  #[serde(flatten)]
  pub table: Table,
}

impl Table {
  /// Wrap into a shape-tagged [`TableBody`] (`shape = "table/v1"`) for emission
  /// as a turn item / pane stdout.
  pub fn into_body(self) -> TableBody {
    TableBody {
      shape: TABLE_V1.to_string(),
      table: self,
    }
  }
}

fn content_total(kept: &[usize], gap_w: usize, width: &[usize]) -> usize {
  if kept.is_empty() {
    return 0;
  }
  kept.iter().map(|&i| width[i]).sum::<usize>() + gap_w * (kept.len() - 1)
}

struct Layout {
  kept: Vec<usize>,
  width: Vec<usize>,
  demoted: Vec<usize>,
}

impl Layout {
  fn content_total(&self, _columns: &[Column], gap_w: usize, width: &[usize]) -> usize {
    content_total(&self.kept, gap_w, width)
  }
}

fn strip_trailing(s: &str) -> String {
  s.trim_end().to_string()
}

/// The table's colorize gate over the shared full-row band
/// ([`crate::nav::highlight_row_line`]) — a piped table stays plain text.
///
/// The algorithm moved to `nav` so the transcript pane can paint the same
/// cursor over rows that carry their own backgrounds. Table cells never do,
/// so this call site's bytes are unchanged.
fn highlight_row_line(s: &str, width: usize) -> String {
  if colored::control::SHOULD_COLORIZE.should_colorize() {
    crate::nav::highlight_row_line(s, width)
  } else {
    strip_trailing(s)
  }
}

/// DEBUG ONLY — `TSH_TINT_ROWS=1` bands every UNhighlighted row in
/// [`crate::nav::DEBUG_TINT_BG`], so a table's real extent is visible against
/// whatever is around it. The highlighted row keeps the selection band, so the
/// cursor stays findable while the tint is on.
///
/// Read once: this is asked per row, and a tint nobody turned on must cost a
/// load, not a `getenv`.
fn debug_tint() -> bool {
  static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
  *ON.get_or_init(|| std::env::var_os("TSH_TINT_ROWS").is_some())
}

fn tint_row_line(s: &str, width: usize) -> String {
  if colored::control::SHOULD_COLORIZE.should_colorize() {
    crate::nav::tint_row_line(s, width)
  } else {
    strip_trailing(s)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cols() -> Vec<Column> {
    vec![
      Column::new("Name").min(6).priority(0),
      Column::new("Status").min(8).priority(1),
      Column::new("Count").align(Align::Right).min(5).priority(2),
      Column::new("Detail").min(18).priority(3),
    ]
  }
  fn rows() -> Vec<Vec<Cell>> {
    vec![
      vec![
        Cell::plain("alpha"),
        Cell::plain("running"),
        Cell::plain("12"),
        Cell::plain("primary edge node, us-west"),
      ],
      vec![
        Cell::plain("beta"),
        Cell::plain("stopped"),
        Cell::plain("3"),
        Cell::plain("awaiting manual restart"),
      ],
      vec![
        Cell::plain("gamma-svc"),
        Cell::plain("degraded"),
        Cell::plain("0"),
        Cell::plain("ok"),
      ],
    ]
  }

  /// Legacy column JSON (no key/format/default_hidden) still parses, and the
  /// new fields stay off the wire at their defaults — old readers and old
  /// payloads are both unaffected.
  #[test]
  fn column_serde_is_backward_compatible() {
    let legacy: Column = serde_json::from_str(r#"{"header":"NAME","priority":1}"#).unwrap();
    assert_eq!(legacy.key, None);
    assert_eq!(legacy.format, None);
    assert!(!legacy.default_hidden);
    let wire = serde_json::to_string(&legacy).unwrap();
    assert!(
      !wire.contains("key") && !wire.contains("format") && !wire.contains("default_hidden"),
      "defaults must not serialize: {wire}"
    );
    let full: Column = serde_json::from_str(
      r#"{"header":"SIZE","key":"size_bytes","format":"size_bytes","default_hidden":true}"#,
    )
    .unwrap();
    assert_eq!(full.key.as_deref(), Some("size_bytes"));
    assert_eq!(full.format, Some(CellFormat::SizeBytes));
    assert!(full.default_hidden);
  }

  #[test]
  fn fits_at_natural_width() {
    let mut t = Table::new(cols());
    t.rows = rows();
    let lines = t.render_lines(60);
    // header, rule, 3 rows
    assert_eq!(lines.len(), 5);
    assert_eq!(lines[0], "Name      Status   Count Detail");
    assert!(lines[1].chars().all(|c| c == '─'));
    assert_eq!(lines[1].chars().count(), 51);
    assert_eq!(
      lines[2],
      "alpha     running     12 primary edge node, us-west"
    );
  }

  #[test]
  fn demotes_when_narrow() {
    let mut t = Table::new(cols());
    t.rows = rows();
    let lines = t.render_lines(30);
    assert_eq!(lines[0], "Name      Status   Count");
    assert_eq!(lines[1].chars().count(), 24);
    assert_eq!(lines[2], "alpha     running     12");
    // Colour is process-wide and other tests exercise its override. This
    // regression is about layout, which must be invariant under styling.
    assert_eq!(
      crate::strip_ansi(&lines[3]),
      "   └── Detail: primary edge n…"
    );
    for line in &lines {
      assert!(visual_width(line) <= 30, "line over width: {line:?}");
    }
  }

  #[test]
  fn degenerate_single_column_no_panic() {
    let mut t = Table::new(cols());
    t.rows = rows();
    let lines = t.render_lines(8);
    for line in &lines {
      assert!(visual_width(line) <= 8, "line over width: {line:?}");
    }
  }

  #[test]
  fn render_lines_with_rows_maps_lines_to_rows() {
    let mut t = Table::new(cols());
    t.rows = rows();
    let (lines, row_of) = t.render_lines_with_rows(60);
    // Same lines as render_lines, plus a row index per line.
    assert_eq!(lines, t.render_lines(60));
    assert_eq!(lines.len(), row_of.len());
    // Fits at width 60: header, rule (both chrome → None), then the 3 data rows.
    assert_eq!(row_of, vec![None, None, Some(0), Some(1), Some(2)]);
  }

  #[test]
  fn render_lines_with_rows_tags_demoted_sublines() {
    let mut t = Table::new(cols());
    t.rows = rows();
    let (lines, row_of) = t.render_lines_with_rows(30);
    assert_eq!(lines.len(), row_of.len());
    // Narrow: `Detail` demotes to a per-row sub-line — a row's flat line and
    // its sub-line carry the same row index.
    let first = row_of.iter().position(Option::is_some).unwrap();
    assert_eq!(
      row_of[first],
      Some(0),
      "first data line is row 0's flat line"
    );
    assert_eq!(
      row_of[first + 1],
      Some(0),
      "the demoted sub-line is still row 0"
    );
    // Every tagged line maps to a real row.
    for r in row_of.iter().flatten() {
      assert!(*r < 3, "row index in range");
    }
  }

  #[test]
  fn serialize_roundtrips_and_emits_compact_cells() {
    let mut t = Table::new(vec![
      Column::new("STATUS"),
      Column::new("AGE").align(Align::Right),
    ]);
    t.push_row(vec![Cell::new("success", Style::Green), Cell::plain("2h")]);

    let json = serde_json::to_string(&t).unwrap();
    // Unstyled cell → a bare string; styled → `{text, style}`.
    assert!(
      json.contains(r#""2h""#),
      "unstyled cell is a bare string: {json}"
    );
    assert!(
      json.contains(r#"{"text":"success","style":"green"}"#),
      "styled cell carries text + snake_case style: {json}"
    );

    // The deserialized table renders identically (the wire form round-trips).
    let back: Table = serde_json::from_str(&json).unwrap();
    assert_eq!(back.render_lines(40), t.render_lines(40));
  }

  #[test]
  fn highlighted_row_uses_hover_band_across_the_table_width() {
    const HOVER_BG: &str = crate::nav::SELECTION_BG;
    crate::force_color(true);
    let mut t = Table::new(vec![
      Column::new("Name").min(8),
      Column::new("State").min(8),
    ])
    .highlight_row(1);
    t.push_row(vec![Cell::new("alpha", Style::Green), Cell::plain("live")]);
    t.push_row(vec![Cell::new("beta", Style::Green), Cell::plain("dead")]);

    let lines = t.render_lines(40);
    crate::unforce_color();

    assert!(!lines[2].contains(HOVER_BG));
    assert!(lines[3].starts_with(HOVER_BG), "{:?}", lines[3]);
    assert!(lines[3].ends_with(crate::ansi::RESET), "{:?}", lines[3]);
    assert_eq!(
      visual_width(&lines[3]),
      17,
      "the highlight includes both padded fields and their gap"
    );
    assert!(
      lines[3].contains(Style::Green.code().as_ref()),
      "the hover should preserve lifecycle foreground colors"
    );

    let wire = serde_json::to_string(&t).unwrap();
    assert!(wire.contains(r#""highlighted_rows":[1]"#), "{wire}");
    let back: Table = serde_json::from_str(&wire).unwrap();
    assert_eq!(back.highlighted_rows, vec![1]);
  }

  #[test]
  fn into_body_tags_shape_and_table_ignores_it() {
    let t = Table::new(vec![Column::new("A"), Column::new("B")]);
    let body_json = serde_json::to_string(&t.into_body()).unwrap();
    assert!(
      body_json.starts_with(r#"{"shape":"table/v1","#),
      "table/v1 self-describes: {body_json}"
    );
    assert!(body_json.contains(r#""columns":[{"header":"A""#));
    // The renderer can deserialize the tagged object straight into a Table
    // (the `shape` field is ignored).
    let back: Table = serde_json::from_str(&body_json).unwrap();
    assert_eq!(back.columns.len(), 2);
  }
}
