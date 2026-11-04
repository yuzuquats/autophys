//! [`Tree`] + [`RenderedLine`] + the rendering pipeline.
//!
//! Owns the cross-row column layout (`fit_columns`), per-row emission
//! (`emit_row`), and the ANSI-preserving middle-area wrap
//! (`wrap_middle`). The internal `Row` / `SideCol` / `SideKind` /
//! `Layout` types are private to this module.
//!
//! Also home to the [`Tree`] deserializer (with its `DividerSpec`
//! sentinel that distinguishes absent / explicit-null / explicit-set
//! `column_divider`).

use serde::Deserialize;
use serde::de::Deserializer;

use crate::ansi;
use crate::draw::{BoxChars, box_chars};
use crate::pad::{push_line_carrying_prelude, update_prelude, wrap_to_width};
use crate::style::{Cell, Style};
use crate::width::visual_width;

use super::column::{ColumnDivider, ColumnPosition, TreeColumn};
use super::node::Node;

#[derive(Clone, Debug)]
pub struct Tree {
  pub root: Node,
  pub box_chars: BoxChars,
  pub columns: Vec<TreeColumn>,
  pub subline_indent: usize,
  pub column_divider: Option<ColumnDivider>,
}

/// One rendered output line plus the index (depth-first pre-order) of the source
/// node it belongs to. A node spanning multiple lines (wrapped label, demoted
/// column sublines) emits several `RenderedLine`s sharing one `node`.
#[derive(Debug, Clone)]
pub struct RenderedLine {
  pub text: String,
  pub node: usize,
}

impl Tree {
  pub fn new(root: Node) -> Self {
    Tree {
      root,
      box_chars: box_chars(),
      columns: Vec::new(),
      subline_indent: 3,
      column_divider: Some(ColumnDivider::default()),
    }
  }

  pub fn with_columns(mut self, cols: Vec<TreeColumn>) -> Self {
    self.columns = cols;
    self
  }
  pub fn add_column(mut self, col: TreeColumn) -> Self {
    self.columns.push(col);
    self
  }
  pub fn with_column_divider(mut self, div: ColumnDivider) -> Self {
    self.column_divider = Some(div);
    self
  }
  pub fn without_column_divider(mut self) -> Self {
    self.column_divider = None;
    self
  }

  pub fn render(&self, max_width: usize) -> String {
    self.render_lines(max_width).join("\n")
  }

  pub fn render_auto(&self) -> String {
    self.render(crate::term::term_columns())
  }

  pub fn render_to(&self, to: &mut impl std::fmt::Write, max_width: usize) -> std::fmt::Result {
    to.write_str(&self.render(max_width))
  }

  #[cfg(feature = "watch")]
  pub fn watch<W: std::io::Write>(&self, out: &mut W) -> std::io::Result<()> {
    crate::live::watch(out, || self.render_lines(crate::term::term_columns()))
  }

  pub fn render_lines(&self, max_width: usize) -> Vec<String> {
    self
      .render_rows(max_width)
      .into_iter()
      .map(|r| r.text)
      .collect()
  }

  /// Like [`render_lines`](Self::render_lines) but tags each output line with the
  /// pre-order index of the source node it came from (so callers can map a line
  /// back to its node — e.g. to highlight a whole multi-line node).
  pub fn render_rows(&self, max_width: usize) -> Vec<RenderedLine> {
    let max_width = max_width.max(1);

    // 1. Collect rows depth-first.
    let mut rows: Vec<Row> = Vec::new();
    self.collect_rows(
      &self.root,
      String::new(),
      String::new(),
      true,
      true,
      &mut rows,
    );

    // 2. Effective columns: if none declared, fall back to a single Inline "detail"
    //    column so legacy `with_detail()` / `{"detail": "..."}` JSON keeps working.
    let default_inline;
    let columns: &[TreeColumn] = if self.columns.is_empty() {
      default_inline = vec![TreeColumn::new("detail").position(ColumnPosition::Inline)];
      &default_inline
    } else {
      &self.columns
    };
    // 3. Decide layout: which columns demote, and what widths the remaining ones take.
    let layout = fit_columns(
      columns,
      &rows,
      max_width,
      self.column_divider.as_ref(),
      self.subline_indent,
    );

    // 4. Emit each row, tagging every line it produces with that row's index.
    let mut out: Vec<String> = Vec::new();
    let mut owner: Vec<usize> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
      self.emit_row(row, columns, &layout, max_width, &mut out);
      owner.resize(out.len(), i);
    }
    out
      .into_iter()
      .zip(owner)
      .map(|(text, node)| RenderedLine { text, node })
      .collect()
  }

  fn collect_rows(
    &self,
    node: &Node,
    ancestor_prefix: String,
    glyph_prefix: String,
    is_last: bool,
    is_root: bool,
    out: &mut Vec<Row>,
  ) {
    // Compose this row's own prefix strings.
    let (line1_prefix, cont_prefix) = if is_root {
      (String::new(), String::new())
    } else {
      let glyph = self.box_chars.branch(is_last);
      let p1 = format!("{glyph_prefix}{glyph} ");
      let pc = format!("{glyph_prefix}{}", self.box_chars.cont(is_last));
      (p1, pc)
    };

    out.push(Row {
      line1_prefix: line1_prefix.clone(),
      cont_prefix: cont_prefix.clone(),
      prefix: node.label_prefix.clone(),
      label: node.label.clone(),
      fields: node.fields.clone(),
    });

    // For children, the new ancestor prefix is what we'd carry as continuation here.
    let next_ancestor = if is_root {
      String::new()
    } else {
      cont_prefix.clone()
    };
    let n = node.children.len();
    for (i, child) in node.children.iter().enumerate() {
      let last = i + 1 == n;
      self.collect_rows(
        child,
        ancestor_prefix.clone(),
        next_ancestor.clone(),
        last,
        false,
        out,
      );
    }
  }

  fn emit_row(
    &self,
    row: &Row,
    columns: &[TreeColumn],
    layout: &Layout,
    max_width: usize,
    out: &mut Vec<String>,
  ) {
    // Render the side blocks once for the top line and once for continuation lines.
    // `cells_with_text` toggles cell-text-vs-blank-padding (true for top, false for
    // continuations). Dividers always draw with their glyph so columns stay visually
    // aligned through wrapped inline text. When no divider is configured, a 1-char
    // blank slot is used so the side block doesn't run into the tree.
    let div = layout.divider.as_ref();
    let outer_slot = |with_glyph: bool| -> String {
      match div {
        Some(d) => d.render(with_glyph),
        None => " ".to_string(),
      }
    };
    let render_side =
      |widths: &[(usize, usize)], side: SideKind, cells_with_text: bool| -> String {
        if widths.is_empty() {
          return String::new();
        }
        let mut parts: Vec<String> = Vec::new();
        for (i, (col_idx, w)) in widths.iter().enumerate() {
          let col = &columns[*col_idx];
          let cell = row
            .fields
            .iter()
            .find(|(k, _)| k == &col.key)
            .map(|(_, c)| c.clone())
            .unwrap_or_default();
          let rendered = if cells_with_text {
            cell.render_field(
              *w,
              col.align,
              col.overflow,
              col.style.unwrap_or(Style::None),
            )
          } else {
            " ".repeat(*w)
          };
          parts.push(rendered);
          // Intra-block divider between adjacent cells; always draws with glyph.
          if i + 1 < widths.len() {
            parts.push(outer_slot(true));
          }
        }
        let outer = outer_slot(true);
        match side {
          SideKind::Left => format!("{}{outer}", parts.join("")),
          SideKind::Right => format!("{outer}{}", parts.join("")),
        }
      };

    let left_top = render_side(&layout.left, SideKind::Left, true);
    let left_cont = render_side(&layout.left, SideKind::Left, false);
    let right_top = render_side(&layout.right, SideKind::Right, true);
    let right_cont = render_side(&layout.right, SideKind::Right, false);

    let left_top_w = visual_width(&left_top);
    let right_top_w = visual_width(&right_top);
    let tree_width = max_width.saturating_sub(left_top_w + right_top_w).max(1);

    // Render the tree+inline middle area as a list of chunks (each line fits in tree_width).
    let middle_chunks = self.wrap_middle(row, columns, layout, tree_width);

    // Combine.
    for (i, chunk) in middle_chunks.iter().enumerate() {
      let chunk_w = visual_width(chunk);
      let pad = tree_width.saturating_sub(chunk_w);
      let padded = format!("{chunk}{}", " ".repeat(pad));
      let line = if i == 0 {
        format!("{left_top}{padded}{right_top}")
      } else {
        format!("{left_cont}{padded}{right_cont}")
      };
      out.push(strip_trailing(&line));
    }

    // Emit sub-lines for demoted columns (Left first, then Right, in declared order).
    let demoted_cols: Vec<usize> = columns
      .iter()
      .enumerate()
      .filter(|(i, c)| {
        layout.demoted.contains(i)
          && (c.position == ColumnPosition::Left || c.position == ColumnPosition::Right)
      })
      .map(|(i, _)| i)
      .collect();

    for (i, &col_idx) in demoted_cols.iter().enumerate() {
      let col = &columns[col_idx];
      let cell = row
        .fields
        .iter()
        .find(|(k, _)| k == &col.key)
        .map(|(_, c)| c.clone())
        .unwrap_or_default();
      if cell.width() == 0 {
        continue;
      }
      let is_last = i + 1 == demoted_cols.len();
      let glyph = self.box_chars.branch(is_last);
      let key_label = col.header.as_deref().unwrap_or(&col.key);
      let indent = " ".repeat(layout.subline_indent);
      // Sub-lines are anchored on the row's continuation prefix (so they sit
      // under the row's tree-indent level rather than the top-level edge).
      let prefix = format!("{}{indent}{glyph} {key_label}: ", row.cont_prefix);
      let prefix_w = visual_width(&prefix);
      let value_avail = max_width.saturating_sub(prefix_w);
      let line = if value_avail == 0 {
        // Prefix itself exceeds the width — truncate the whole line as a fallback.
        crate::pad::truncate_ellipsis(&format!("{prefix}{}", cell.plain_text()), max_width, "…")
      } else {
        let value = cell.render_fit(value_avail, col.overflow, col.style.unwrap_or(Style::None));
        format!("{prefix}{value}")
      };
      out.push(strip_trailing(&line));
    }
  }

  /// Returns 1+ chunks for the row's middle: line1 = `line1_prefix + label + [  inline]`
  /// wrapped within `tree_width`; continuations carry `cont_prefix`.
  fn wrap_middle(
    &self,
    row: &Row,
    columns: &[TreeColumn],
    layout: &Layout,
    tree_width: usize,
  ) -> Vec<String> {
    // The hanging glyph prefix: rendered once at the head of line 1; wrapped
    // continuation lines substitute `hang` spaces so the label text keeps one
    // left edge. With no prefix this is all zero-width no-ops (the legacy
    // flush-wrap behavior).
    let prefix_painted = match &row.prefix {
      Some(Cell::Raw(s)) => s.clone(),
      Some(Cell::Styled { text, style }) => style.paint(text),
      None => String::new(),
    };
    let hang = visual_width(&prefix_painted);
    let mut label_painted = match &row.label {
      Cell::Raw(s) => s.clone(),
      Cell::Styled { text, style } => style.paint(text),
    };
    // Title-suffix columns join onto the label as `(a, b, c)` before any
    // inline column. Values are pulled out of the row's fields by key,
    // empties are elided, and each column's style is honored individually.
    if !layout.title_suffix_cols.is_empty() {
      let parts: Vec<String> = layout
        .title_suffix_cols
        .iter()
        .filter_map(|&i| {
          let col = &columns[i];
          let cell = row
            .fields
            .iter()
            .find(|(k, _)| k == &col.key)
            .map(|(_, c)| c.clone())?;
          let plain = cell.plain_text();
          if plain.is_empty() {
            return None;
          }
          // Honor per-column style for each suffix segment (default: dimmed,
          // matching the inline-column convention).
          let style_for_cell = match &cell {
            Cell::Styled { style, .. } => *style,
            Cell::Raw(_) => col.style.unwrap_or(Style::Dimmed),
          };
          Some(style_for_cell.paint(&plain))
        })
        .collect();
      if !parts.is_empty() {
        let dim_paren = Style::Dimmed;
        label_painted = format!(
          "{label_painted} {open}{joined}{close}",
          open = dim_paren.paint("("),
          joined = parts.join(&dim_paren.paint(", ")),
          close = dim_paren.paint(")"),
        );
      }
    }
    let inline_cell = layout.inline_idx.and_then(|i| {
      let col = &columns[i];
      row
        .fields
        .iter()
        .find(|(k, _)| k == &col.key)
        .map(|(_, c)| (col, c))
    });
    let inline_text: Option<String> = inline_cell
      .map(|(col, c)| match c {
        Cell::Raw(s) => s.clone(),
        Cell::Styled { text, style } => style.or(col.style.unwrap_or(Style::None)).paint(text),
      })
      .filter(|s| !s.is_empty());

    let line1_avail = tree_width
      .saturating_sub(visual_width(&row.line1_prefix))
      .max(1);

    let single = match &inline_text {
      Some(d) => format!("{prefix_painted}{label_painted}  {d}"),
      None => format!("{prefix_painted}{label_painted}"),
    };
    if visual_width(&single) <= line1_avail {
      return vec![format!("{}{single}", row.line1_prefix)];
    }

    // Wrap. (Same algorithm as the legacy renderer, but parameterised on the row's
    // prefixes and the dynamic `tree_width` derived from side-column widths.)
    // Text capacity is uniform across lines: line 1 spends `hang` columns on the
    // glyph prefix, continuations spend it on the hang indent — so both wrap
    // widths just subtract `hang`.
    let text1_avail = line1_avail.saturating_sub(hang).max(1);
    let cont_avail = tree_width
      .saturating_sub(visual_width(&row.cont_prefix))
      .saturating_sub(hang)
      .max(1);

    // Label wraps via the ANSI-preserving `wrap_to_width` — bold/colored
    // labels keep their styling through wrap boundaries (each line is
    // self-contained).
    let mut chunks: Vec<String> = if visual_width(&label_painted) <= text1_avail {
      vec![label_painted.clone()]
    } else {
      wrap_to_width(&label_painted, text1_avail)
    };

    // The avail for line N+1 is cont_avail; for line 1 it's line1_avail. We don't have
    // a clean way to encode that in the existing packer — approximate by using
    // line1_avail when packing the first chunk and cont_avail thereafter.
    if let Some(detail_styled) = inline_text {
      // Detail packing is ANSI-aware: we walk `inline_text` verbatim
      // (no strip_ansi pre-pass), tracking the active SGR prelude. At
      // each chunk boundary we close with RESET if styling is open and
      // re-seed the next chunk with the prelude so styling survives.
      let mut current = chunks.pop().unwrap_or_default();
      let mut current_w = visual_width(&current);
      let mut started_detail = false;
      let mut prelude = String::new();
      // The popped chunk's tail SGR state matters: if it ended in an
      // open style we need to carry it forward.
      update_prelude(&current, &mut prelude);

      let avail_for = |chunk_idx: usize| -> usize {
        if chunk_idx == 0 {
          text1_avail
        } else {
          cont_avail
        }
      };

      for word in detail_styled.split_whitespace() {
        let ww = visual_width(word);
        let ca = avail_for(chunks.len());
        if ww > ca {
          // Over-long single word: flush current (preserving prelude),
          // then `wrap_to_width` hard-breaks the word and emits chunks
          // that are themselves ANSI-preserving.
          if current_w > 0 {
            push_line_carrying_prelude(&mut chunks, &mut current, &prelude);
            current_w = 0;
          }
          let ca2 = avail_for(chunks.len());
          let pieces = wrap_to_width(word, ca2);
          let last = pieces.len().saturating_sub(1);
          for (i, p) in pieces.into_iter().enumerate() {
            if i < last {
              chunks.push(p);
              // wrap_to_width's pieces are each self-contained
              // (closed with RESET) — keep `prelude` aligned with
              // the last piece for the next iteration.
              update_prelude(chunks.last().unwrap(), &mut prelude);
            } else {
              current_w = visual_width(&p);
              current.push_str(&p);
              update_prelude(&p, &mut prelude);
              started_detail = true;
            }
          }
          continue;
        }
        let sep_w = if current_w == 0 {
          0
        } else if started_detail {
          1
        } else {
          2
        };
        if current_w + sep_w + ww <= ca {
          if current_w > 0 {
            current.push_str(if started_detail { " " } else { "  " });
          }
          current.push_str(word);
          update_prelude(word, &mut prelude);
          current_w += sep_w + ww;
          started_detail = true;
        } else {
          push_line_carrying_prelude(&mut chunks, &mut current, &prelude);
          // After the flush, `current` is seeded with the carry-forward
          // prelude (zero visible width). Start the new word against it.
          current_w = 0;
          current.push_str(word);
          update_prelude(word, &mut prelude);
          current_w += ww;
          started_detail = true;
        }
      }
      if current_w > 0 || chunks.is_empty() {
        // Close the trailing chunk if it still has styling open so each
        // chunk the renderer hands out is self-contained.
        update_prelude(&current, &mut prelude);
        if !prelude.is_empty() {
          current.push_str(ansi::RESET);
        }
        chunks.push(current);
      }
    }

    let hang_pad = " ".repeat(hang);
    chunks
      .into_iter()
      .enumerate()
      .map(|(i, c)| {
        if i == 0 {
          format!("{}{prefix_painted}{c}", row.line1_prefix)
        } else {
          format!("{}{hang_pad}{c}", row.cont_prefix)
        }
      })
      .collect()
  }
}

/// Decide what width each side column takes and which columns demote to sub-lines.
fn fit_columns(
  columns: &[TreeColumn],
  rows: &[Row],
  max_width: usize,
  divider: Option<&ColumnDivider>,
  subline_indent: usize,
) -> Layout {
  let inline_idx = columns
    .iter()
    .position(|c| c.position == ColumnPosition::Inline);
  let title_suffix_cols: Vec<usize> = columns
    .iter()
    .enumerate()
    .filter(|(_, c)| c.position == ColumnPosition::TitleSuffix)
    .map(|(i, _)| i)
    .collect();

  let mut left: Vec<SideCol> = Vec::new();
  let mut right: Vec<SideCol> = Vec::new();
  for (idx, col) in columns.iter().enumerate() {
    match col.position {
      ColumnPosition::Left | ColumnPosition::Right => {
        let s = SideCol::compute(idx, col, rows);
        // Elide entirely if no row has any content and no header — keeps the live
        // `health.tree` (where checked_at/cadence are absent) free of reserved
        // empty side columns.
        if s.max_cell_width == 0 && col.header.is_none() {
          continue;
        }
        match col.position {
          ColumnPosition::Left => left.push(s),
          ColumnPosition::Right => right.push(s),
          _ => unreachable!(),
        }
      }
      // Inline + TitleSuffix don't consume side-block width — they pack into
      // the row's middle area (after the label). `wrap_middle` handles them.
      ColumnPosition::Inline | ColumnPosition::TitleSuffix => {}
    }
  }

  let tree_natural: usize = rows
    .iter()
    .map(|r| {
      let prefix_w = r.prefix.as_ref().map(Cell::width).unwrap_or(0);
      visual_width(&r.line1_prefix) + prefix_w + r.label.width()
    })
    .max()
    .unwrap_or(0);
  // A minimum reading floor for the tree area — don't let it collapse below this when
  // deciding to demote vs shrink. Tuned to admit `…` + a few chars.
  let tree_floor = tree_natural.min(8).max(4);

  // Even without a configured divider, side blocks keep a 1-char gap so they don't run
  // into the tree.
  let divider_slot = divider.map(|d| d.slot_width()).unwrap_or(1);

  let mut demoted: Vec<usize> = Vec::new();
  loop {
    let active_left: Vec<&SideCol> = left.iter().filter(|c| !demoted.contains(&c.idx)).collect();
    let active_right: Vec<&SideCol> = right.iter().filter(|c| !demoted.contains(&c.idx)).collect();

    let side_w = |active: &[&SideCol]| -> usize {
      if active.is_empty() {
        0
      } else {
        let cells: usize = active.iter().map(|c| c.natural).sum();
        let intra = active.len().saturating_sub(1) * divider_slot;
        let outer = divider_slot;
        cells + intra + outer
      }
    };
    let left_w = side_w(&active_left);
    let right_w = side_w(&active_right);
    let avail_for_tree = max_width.saturating_sub(left_w + right_w);

    if avail_for_tree >= tree_floor || (active_left.is_empty() && active_right.is_empty()) {
      let left_widths: Vec<(usize, usize)> =
        active_left.iter().map(|c| (c.idx, c.natural)).collect();
      let right_widths: Vec<(usize, usize)> =
        active_right.iter().map(|c| (c.idx, c.natural)).collect();
      return Layout {
        inline_idx,
        title_suffix_cols: title_suffix_cols.clone(),
        left: left_widths,
        right: right_widths,
        demoted,
        divider: divider.cloned(),
        subline_indent,
      };
    }

    // Demote the highest-priority active side col (ties: Right before Left, then by idx).
    let pick = active_left
      .iter()
      .chain(active_right.iter())
      .max_by_key(|c| {
        (
          c.col.priority,
          matches!(c.col.position, ColumnPosition::Right),
          c.idx,
        )
      });
    match pick {
      Some(c) => demoted.push(c.idx),
      None => {
        return Layout {
          inline_idx,
          title_suffix_cols,
          left: Vec::new(),
          right: Vec::new(),
          demoted,
          divider: divider.cloned(),
          subline_indent,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal layout types
// ---------------------------------------------------------------------------

struct Row {
  line1_prefix: String,
  cont_prefix: String,
  /// Hanging glyph prefix ([`Node::label_prefix`]): painted before the label
  /// on the first line; continuation lines indent by its visible width.
  prefix: Option<Cell>,
  label: Cell,
  fields: Vec<(String, Cell)>,
}

struct SideCol<'a> {
  idx: usize,
  col: &'a TreeColumn,
  natural: usize,
  /// Max cell visual width across rows (pre-clamp). Used to decide whether the column
  /// has any content to render at all.
  max_cell_width: usize,
}

impl<'a> SideCol<'a> {
  fn compute(idx: usize, col: &'a TreeColumn, rows: &[Row]) -> Self {
    let header_w = col.header.as_deref().map(visual_width).unwrap_or(0);
    let cells_w = rows
      .iter()
      .map(|r| {
        r.fields
          .iter()
          .find(|(k, _)| k == &col.key)
          .map(|(_, c)| c.width())
          .unwrap_or(0)
      })
      .max()
      .unwrap_or(0);
    let nat = header_w.max(cells_w).max(col.min_width);
    let nat = match col.max_width {
      Some(mx) => nat.min(mx),
      None => nat,
    };
    SideCol {
      idx,
      col,
      natural: nat,
      max_cell_width: cells_w,
    }
  }
}

#[derive(Clone, Copy)]
enum SideKind {
  Left,
  Right,
}

struct Layout {
  inline_idx: Option<usize>,
  /// Column indices, in declared order, with `ColumnPosition::TitleSuffix`.
  /// The renderer joins their per-row values as `(a, b, c)` after the label.
  title_suffix_cols: Vec<usize>,
  /// (column_index, fitted_width) pairs in declared order for the left block.
  left: Vec<(usize, usize)>,
  /// Same for the right block.
  right: Vec<(usize, usize)>,
  /// Column indices that demoted to sub-lines.
  demoted: Vec<usize>,
  divider: Option<ColumnDivider>,
  subline_indent: usize,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn strip_trailing(s: &str) -> String {
  s.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Tree deserializer
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TreeRepr {
  root: Node,
  #[serde(default)]
  columns: Vec<TreeColumn>,
  /// `null` ⇒ no divider; absent ⇒ default divider when there are side columns.
  #[serde(default, deserialize_with = "deserialize_optional_divider")]
  column_divider: DividerSpec,
}

#[derive(Default)]
enum DividerSpec {
  #[default]
  Default,
  None,
  Set(ColumnDivider),
}

fn deserialize_optional_divider<'de, D>(d: D) -> Result<DividerSpec, D::Error>
where
  D: Deserializer<'de>,
{
  let v: Option<ColumnDivider> = Option::deserialize(d)?;
  Ok(match v {
    Some(div) => DividerSpec::Set(div),
    None => DividerSpec::None,
  })
}

impl<'de> Deserialize<'de> for Tree {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    let r = TreeRepr::deserialize(deserializer)?;
    let mut t = Tree::new(r.root).with_columns(r.columns);
    // Divider semantics:
    //  - absent in JSON ⇒ default ON (matches `Tree::new`)
    //  - explicit `null` ⇒ no divider
    //  - explicit object ⇒ that divider
    t.column_divider = match r.column_divider {
      DividerSpec::Default => Some(ColumnDivider::default()),
      DividerSpec::None => None,
      DividerSpec::Set(div) => Some(div),
    };
    Ok(t)
  }
}

#[allow(unused)]
fn _assert_cell_default() {
  let _ = Cell::default();
  let _ = Style::default();
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::width::strip_ansi;

  #[test]
  fn simple_tree() {
    let root = Node::branch(
      Cell::plain("project"),
      vec![
        Node::branch(
          Cell::plain("src"),
          vec![Node::leaf("main.rs"), Node::leaf("lib.rs")],
        ),
        Node::leaf("README.md"),
      ],
    );
    assert_eq!(
      Tree::new(root).render_lines(80),
      vec![
        "project",
        "├── src",
        "│   ├── main.rs",
        "│   └── lib.rs",
        "└── README.md",
      ]
    );
  }

  #[test]
  fn wraps_when_narrow() {
    let root = Node::branch(
      Cell::plain("service health"),
      vec![Node::leaf("api").with_detail("responding in 12ms")],
    );
    assert_eq!(
      Tree::new(root).render_lines(24),
      vec!["service health", "└── api  responding in", "    12ms"]
    );
  }

  /// A `label_prefix` paints once at the head of line 1 and hang-indents
  /// every wrapped continuation by its visible width, so the label text keeps
  /// one left edge (instead of continuations sliding under the glyph).
  #[test]
  fn label_prefix_hangs_wrapped_continuations() {
    let root = Node::branch(
      Cell::plain("tasks"),
      vec![
        Node::leaf(Cell::plain(
          "update the auditor instructions for the new whitelist table",
        ))
        .label_prefix(Cell::plain("· ")),
      ],
    );
    let lines = Tree::new(root).render_lines(34);
    let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert_eq!(plain[0], "tasks");
    assert!(
      plain[1].starts_with("└── · update"),
      "line 1 carries the glyph: {:?}",
      plain[1]
    );
    // Continuations: tree cont prefix (4 cols) + 2-col hang ⇒ text at col 6,
    // aligned with "update" above.
    for cont in &plain[2..] {
      assert!(cont.starts_with("      "), "hang indent: {cont:?}");
      assert!(
        !cont.starts_with("       "),
        "exactly hang-width spaces: {cont:?}"
      );
    }
    // Line 1: "└── " (4 cols) + "· " (2 cols) puts text at visual column 6 —
    // exactly where the 6-space continuations start (asserted above).
    assert!(!plain[2].trim_start().is_empty());
    // Every line respects the width budget.
    for l in &plain {
      assert!(visual_width(l) <= 34, "line within width: {l:?}");
    }
  }

  /// An ANSI-styled prefix keeps its styling on line 1 and the hang width is
  /// measured visibly (escapes are zero-width).
  #[test]
  fn ansi_label_prefix_width_is_visible_width() {
    let root = Node::branch(
      Cell::plain("tasks"),
      vec![
        Node::leaf(Cell::plain(
          "a fairly long task title that must wrap over lines",
        ))
        .label_prefix(Cell::raw(format!("{} ", Style::Green.paint("✓")))),
      ],
    );
    let lines = Tree::new(root).render_lines(30);
    let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert!(plain[1].starts_with("└── ✓ a"), "{:?}", plain[1]);
    assert!(
      plain[2].starts_with("      "),
      "hang under text, not glyph: {:?}",
      plain[2]
    );
    for l in &plain {
      assert!(visual_width(l) <= 30, "line within width: {l:?}");
    }
  }

  /// Right side columns render their full value at the requested width — the
  /// rightmost character must not be clipped (regression: `0/3` → `0/`).
  #[test]
  fn right_column_last_char_survives_at_exact_widths() {
    for w in 30..60 {
      let root = Node::branch(
        Cell::plain("tasks"),
        vec![
          Node::leaf(Cell::plain(
            "a task title that is long enough to wrap sometimes",
          ))
          .with_field("done", Cell::plain("0/12")),
        ],
      );
      let cols = vec![TreeColumn::new("done").position(ColumnPosition::Right)];
      let lines = Tree::new(root).with_columns(cols).render_lines(w);
      let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
      assert!(
        plain.iter().any(|l| l.contains("0/12")),
        "full value present at width {w}: {plain:?}"
      );
      for l in &plain {
        assert!(visual_width(l) <= w, "line exceeds width {w}: {l:?}");
      }
    }
  }

  /// A column declared at `TitleSuffix` joins its value onto the row's
  /// label as `(value)`. Empty values are elided. Multiple TitleSuffix
  /// columns merge into a single comma-joined paren group in declaration
  /// order.
  #[test]
  fn title_suffix_single_column_renders_as_paren() {
    let root = Node::branch(
      Cell::plain("project"),
      vec![Node::leaf("server-app").with_field("mode", Cell::plain("d+w"))],
    );
    let cols = vec![TreeColumn::new("mode").position(ColumnPosition::TitleSuffix)];
    let lines = Tree::new(root).with_columns(cols).render_lines(80);
    // Strip ANSI to make the assertion stable across style changes.
    let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert_eq!(plain, vec!["project", "└── server-app (d+w)",]);
  }

  #[test]
  fn title_suffix_multiple_columns_join_with_comma() {
    let root = Node::branch(
      Cell::plain("project"),
      vec![
        Node::leaf("server-app")
          .with_field("kind", Cell::plain("package"))
          .with_field("mode", Cell::plain("d+w")),
      ],
    );
    let cols = vec![
      TreeColumn::new("kind").position(ColumnPosition::TitleSuffix),
      TreeColumn::new("mode").position(ColumnPosition::TitleSuffix),
    ];
    let lines = Tree::new(root).with_columns(cols).render_lines(80);
    let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert_eq!(plain, vec!["project", "└── server-app (package, d+w)",]);
  }

  #[test]
  fn title_suffix_empty_values_are_elided() {
    let root = Node::branch(
      Cell::plain("project"),
      vec![
        // Has kind but no mode — only kind shows in the suffix.
        Node::leaf("host-a").with_field("kind", Cell::plain("ubuntu.host")),
        // No suffix-relevant fields at all — no paren group at all.
        Node::leaf("plain"),
      ],
    );
    let cols = vec![
      TreeColumn::new("kind").position(ColumnPosition::TitleSuffix),
      TreeColumn::new("mode").position(ColumnPosition::TitleSuffix),
    ];
    let lines = Tree::new(root).with_columns(cols).render_lines(80);
    let plain: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();
    assert_eq!(
      plain,
      vec!["project", "├── host-a (ubuntu.host)", "└── plain",]
    );
  }

  #[test]
  fn render_rows_tags_each_line_with_its_node() {
    let root = Node::branch(
      Cell::plain("service health"),
      vec![Node::leaf("api").with_detail("responding in 12ms")],
    );
    // "api" wraps to two lines at width 24; both carry its node index.
    let rows = Tree::new(root).render_rows(24);
    let nodes: Vec<usize> = rows.iter().map(|r| r.node).collect();
    assert_eq!(
      nodes,
      vec![0, 1, 1],
      "wrapped subline shares the node index"
    );
  }

  #[test]
  fn styled_detail_survives_wrap() {
    // The bug the detail-packer ANSI fix exists to address: a colored
    // detail that wraps must carry its styling onto every chunk.
    // Mirrors the user-reported shape `initialize.local: <styled date>`
    // where the date wraps onto a continuation row.
    crate::force_color(true);
    let root = Node::branch(
      Cell::plain("session"),
      vec![
        Node::leaf("initialize.local")
          .with_detail(Cell::new("2026-05-25 01:43:23.509 -0700", Style::Yellow)),
      ],
    );
    let lines = Tree::new(root).render_lines(30);
    crate::unforce_color();

    // At width 30 the styled detail should wrap onto more than one
    // chunk under "initialize.local". Every chunk that contains any
    // part of the date string must re-emit the yellow opener and end
    // self-contained (closing reset).
    let date_parts = ["2026-05-25", "01:43:23.509", "-0700"];
    let detail_lines: Vec<&String> = lines
      .iter()
      .filter(|l| date_parts.iter().any(|p| l.contains(p)))
      .collect();
    assert!(
      detail_lines.len() >= 2,
      "expected styled detail to wrap into ≥ 2 chunks; lines = {lines:?}"
    );
    for (i, line) in detail_lines.iter().enumerate() {
      assert!(
        line.contains("\u{1b}[33m"),
        "detail chunk {i} should re-emit Yellow (\\x1b[33m): {line:?}"
      );
      assert!(
        line.contains("\u{1b}[0m"),
        "detail chunk {i} should close with RESET: {line:?}"
      );
      // Bug-prevention: no double opener.
      assert!(
        !line.contains("\u{1b}[33m\u{1b}[33m"),
        "detail chunk {i} must not duplicate the opener: {line:?}"
      );
    }
  }
}
