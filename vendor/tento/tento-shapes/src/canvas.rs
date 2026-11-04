//! `canvas/v1`: a cell buffer — ops in, standalone ANSI rows out.
//!
//! A renderer (Lisp, or anything that can emit JSON) describes *what to draw*
//! as an ordered list of cell ops; this module owns *how it reaches the
//! terminal*. That split is the second rung of the escape ladder: a canvas
//! owns every cell of its own rect and **nothing outside it**. No cursor
//! motion, no clear-screen, no scroll region, no raw escape ever crosses the
//! boundary — the widget paints a grid and flattens it, so a hostile or buggy
//! producer can corrupt its own rect and only its own rect.
//!
//! ```jsonc
//! {"shape": "canvas/v1", "w": 40, "h": 12, "ops": [
//!   {"op": "rect",  "x": 0, "y": 0, "w": 10, "h": 2, "style": "dim"},
//!   {"op": "text",  "x": 2, "y": 0, "text": "SCORE 120", "style": "bold"},
//!   {"op": "hline", "y": 5, "from": 0, "to": 39, "style": "dim"}
//! ]}
//! ```
//!
//! Invariants — all of them load-bearing, none of them negotiable:
//!
//! * **Exact geometry.** The render is `min(h, `[`MAX_ROWS`]`)` rows, each
//!   exactly `min(w, width)` cells wide ([`tento_term::visual_width`] of the
//!   painted row, ANSI excluded). Ops never grow it.
//! * **No torn cells.** A 2-cell grapheme that would straddle the clip edge —
//!   or that gets half-overwritten by a later op — degrades to a styled space.
//!   A row can never end mid-grapheme.
//! * **Standalone rows.** Every styled run is emitted as one SGR opener plus
//!   one reset ([`crate::term_block`]'s painter), so a row carries no style
//!   into its neighbour and a host may paint rows in any order.
//! * **Chrome cannot fail (D7).** A malformed *op* is skipped or clipped,
//!   silently. Only a malformed *value* (no numeric `w`/`h`, or an `ops` that
//!   isn't a list) degrades to [`ShapeOutput::diagnostic`].
//! * **Deterministic.** Same value + same width ⇒ byte-identical rows. There
//!   is no clock, no map iteration and no environment lookup on the path — the
//!   wave's native-twin equivalence gate diffs these bytes.
//!
//! `canvas/v1` ships **no animation**: [`ShapeOutput::anims`] is always empty,
//! so the equal-width frame contract in [`crate::anim`] is untouched.

use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};
use crate::term_block::safe_span_text;
use tento_term::{SpanStyle, paint_with_color};

pub const CANVAS_V1: &str = "canvas/v1";

/// Row cap. A canvas is chrome: an authoring slip (`"h": 1e9`) must cost a
/// clipped drawing, not the host's memory. Paired with the per-row clip at the
/// caller's `width`, this bounds one render to `MAX_ROWS × width` cells.
pub const MAX_ROWS: usize = 10_000;

/// Default fill of an `hline` — the same light box-drawing rule the crate's
/// markdown renderer paints its horizontal rules with (`markdown.rs`), rather
/// than a bare space, so `hline` reads as a rule at authoring sites. Override
/// per-op with `"ch"`.
pub const HLINE_CH: &str = "─";

pub struct CanvasWidget;

impl ShapeWidget for CanvasWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[CANVAS_V1]
  }

  fn render(
    &self,
    value: &Value,
    width: u16,
    _ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    match render_canvas_rows(value, width, false) {
      Ok(lines) => ShapeOutput {
        // One `None` per line: a canvas has no addressable rows in v1, but the
        // paths vector still has to be parallel to `lines` — `sections/v1`
        // zips the two when it splices a child render, and a short vector
        // would silently drop rows.
        paths: vec![None; lines.len()],
        lines,
        ..ShapeOutput::default()
      },
      Err(error) => ShapeOutput::diagnostic(format!("  ({CANVAS_V1}: {error})")),
    }
  }
}

/// Paint a `canvas/v1` value to standalone ANSI rows.
///
/// `force_color` is appropriate inside an alternate-screen TUI, whose output is
/// known to be a terminal even when process-level tty detection is hidden (the
/// same seam as [`crate::render_inline_spans`]). `Err` carries the reason the
/// *value* is unrenderable — the widget shows it as a diagnostic line.
pub fn render_canvas_rows(
  value: &Value,
  width: u16,
  force_color: bool,
) -> Result<Vec<String>, String> {
  if !value.is_object() {
    return Err("value is not an object".to_string());
  }
  let (Some(declared_w), Some(declared_h)) = (int_at(value, "w"), int_at(value, "h")) else {
    return Err("needs numeric `w` and `h`".to_string());
  };
  let ops: &[Value] = match value.get("ops") {
    None | Some(Value::Null) => &[],
    Some(Value::Array(ops)) => ops,
    Some(_) => return Err("`ops` must be a list".to_string()),
  };

  let rows = declared_h.clamp(0, MAX_ROWS as i64) as usize;
  let cols = declared_w.clamp(0, i64::from(width)) as usize;
  let mut grid = Grid::new(cols, rows, declared_w);
  for op in ops {
    grid.apply(op);
  }
  Ok(grid.paint(force_color))
}

// --- the grid -------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CellKind {
  /// One grapheme occupying one column.
  Single,
  /// Left half of a 2-column grapheme; the text lives here.
  WideLead,
  /// Right half of a 2-column grapheme; paints nothing of its own.
  WideTail,
}

#[derive(Clone, Debug)]
struct Cell {
  text: String,
  style: SpanStyle,
  kind: CellKind,
}

impl Cell {
  fn blank(style: SpanStyle) -> Cell {
    Cell {
      text: " ".to_string(),
      style,
      kind: CellKind::Single,
    }
  }
}

struct Grid {
  cols: usize,
  /// The canvas's *declared* width, which can exceed [`Self::cols`] when the
  /// viewport is narrower. Only `hline`'s default `to` reads it, so an op
  /// authored against the declared size clips instead of shrinking.
  declared_w: i64,
  rows: Vec<Vec<Cell>>,
}

impl Grid {
  fn new(cols: usize, rows: usize, declared_w: i64) -> Grid {
    Grid {
      cols,
      declared_w,
      rows: vec![vec![Cell::blank(SpanStyle::default()); cols]; rows],
    }
  }

  /// Apply one op. Anything unrecognised or mistyped is dropped on the floor:
  /// a canvas value can never produce an error, only cells.
  fn apply(&mut self, op: &Value) {
    let Some(kind) = op.get("op").and_then(Value::as_str) else {
      return;
    };
    let style = op
      .get("style")
      .map(crate::style::parse_style)
      .unwrap_or_default();
    match kind {
      "rect" => {
        let (Some(x), Some(y), Some(w), Some(h)) = (
          int_at(op, "x"),
          int_at(op, "y"),
          int_at(op, "w"),
          int_at(op, "h"),
        ) else {
          return;
        };
        let (fill, fill_w) = fill_glyph(op.get("ch"));
        self.rect(x, y, w, h, &fill, fill_w, &style);
      }
      "text" => {
        let (Some(x), Some(y), Some(text)) = (
          int_at(op, "x"),
          int_at(op, "y"),
          op.get("text").and_then(Value::as_str),
        ) else {
          return;
        };
        self.text(x, y, text, &style);
      }
      "hline" => {
        let Some(y) = int_at(op, "y") else {
          return;
        };
        let from = int_at(op, "from").unwrap_or(0);
        let to = int_at(op, "to").unwrap_or(self.declared_w.saturating_sub(1));
        let (start, end) = (from.min(to), from.max(to));
        // An explicit `null` is the same as an absent key: a Lisp constructor
        // that always emits its optional slots must not lose the rule glyph.
        let (fill, fill_w) = match op.get("ch") {
          Some(ch) if !ch.is_null() => fill_glyph(Some(ch)),
          _ => (HLINE_CH.to_string(), 1),
        };
        let w = end.saturating_sub(start).saturating_add(1);
        self.rect(start, y, w, 1, &fill, fill_w, &style);
      }
      _ => {}
    }
  }

  fn rect(
    &mut self,
    x0: i64,
    y0: i64,
    w: i64,
    h: i64,
    fill: &str,
    fill_w: usize,
    style: &SpanStyle,
  ) {
    if w <= 0 || h <= 0 || self.cols == 0 {
      return;
    }
    let limit = x0.saturating_add(w).min(self.cols as i64);
    let y_end = y0.saturating_add(h).min(self.rows.len() as i64);
    let advance = fill_w.max(1) as i64;
    // Skip whole fill steps that land entirely left of the canvas, so a
    // wildly negative origin costs O(1) and the fill keeps its phase.
    let mut x_start = x0;
    if x_start < -advance {
      x_start += (-x_start - 1) / advance * advance;
    }
    for y in y0.max(0)..y_end {
      let mut x = x_start;
      while x < limit {
        x += self.put_glyph(x, y as usize, fill, fill_w, style, limit);
      }
    }
  }

  fn text(&mut self, x0: i64, y: i64, text: &str, style: &SpanStyle) {
    if y < 0 || y >= self.rows.len() as i64 || self.cols == 0 {
      return;
    }
    let limit = self.cols as i64;
    let mut x = x0;
    // Span text is data, never terminal control: `safe_span_text` strips ANSI
    // and neutralises control characters before a single cell is touched.
    for grapheme in safe_span_text(text).graphemes(true) {
      if x >= limit {
        break;
      }
      let Some((glyph, glyph_w)) = cell_of(grapheme) else {
        continue;
      };
      x += self.put_glyph(x, y as usize, glyph, glyph_w, style, limit);
    }
  }

  /// Paint one grapheme at canvas cell `(x, y)` and return its advance.
  ///
  /// A 2-cell grapheme with only one visible half — clipped by `limit` on the
  /// right or by column 0 on the left — degrades to a styled space, so the row
  /// can never end mid-grapheme. `limit <= self.cols` is the caller's
  /// contract.
  fn put_glyph(
    &mut self,
    x: i64,
    y: usize,
    glyph: &str,
    glyph_w: usize,
    style: &SpanStyle,
    limit: i64,
  ) -> i64 {
    let advance = glyph_w.max(1) as i64;
    if x >= limit || x + advance <= 0 {
      return advance;
    }
    let wide = glyph_w >= 2;
    if wide && (x < 0 || x + 1 >= limit) {
      let visible = if x < 0 { 0 } else { x };
      self.put(visible as usize, y, " ", false, style);
      return advance;
    }
    if x < 0 {
      return advance;
    }
    self.put(x as usize, y, glyph, wide, style);
    advance
  }

  /// Write a cell (or a wide pair), first breaking any wide pair the write
  /// lands inside — the surviving half becomes a space in its own style, which
  /// keeps a background fill intact without leaving half a grapheme behind.
  fn put(&mut self, x: usize, y: usize, text: &str, wide: bool, style: &SpanStyle) {
    break_pair(&mut self.rows[y], x);
    if wide {
      break_pair(&mut self.rows[y], x + 1);
    }
    self.rows[y][x] = Cell {
      text: text.to_string(),
      style: style.clone(),
      kind: if wide {
        CellKind::WideLead
      } else {
        CellKind::Single
      },
    };
    if wide {
      self.rows[y][x + 1] = Cell {
        text: String::new(),
        style: style.clone(),
        kind: CellKind::WideTail,
      };
    }
  }

  /// Flatten to rows: runs of equal-styled cells share one SGR wrapper, and a
  /// styled run always closes with a reset, so each row stands alone.
  fn paint(&self, force_color: bool) -> Vec<String> {
    self
      .rows
      .iter()
      .map(|row| {
        let mut out = String::new();
        let mut index = 0;
        while index < row.len() {
          let style = &row[index].style;
          let mut text = String::new();
          while index < row.len() && &row[index].style == style {
            match row[index].kind {
              CellKind::Single => text.push_str(&row[index].text),
              // A lead is only ever placed with its tail in range; the guard
              // is belt-and-braces against a future edit breaking that.
              CellKind::WideLead if index + 1 < row.len() => text.push_str(&row[index].text),
              CellKind::WideLead => text.push(' '),
              CellKind::WideTail => {}
            }
            index += 1;
          }
          out.push_str(&paint_with_color(&text, style, force_color));
        }
        out
      })
      .collect()
  }
}

/// If `x` sits inside a wide pair, blank the *other* half in place.
fn break_pair(row: &mut [Cell], x: usize) {
  match row.get(x).map(|cell| cell.kind) {
    Some(CellKind::WideLead) => {
      if let Some(tail) = row.get_mut(x + 1) {
        *tail = Cell::blank(tail.style.clone());
      }
    }
    Some(CellKind::WideTail) if x > 0 => {
      row[x - 1] = Cell::blank(row[x - 1].style.clone());
    }
    _ => {}
  }
}

/// Fit one grapheme to the grid: `None` when it occupies no cell (a lone
/// combining mark), otherwise the text to paint and its cell count. A cluster
/// measuring more than two cells (a ZWJ emoji whose width the measurer and the
/// terminal disagree about) is replaced by a space — the exact-width invariant
/// outranks rendering an ambiguous glyph.
fn cell_of(grapheme: &str) -> Option<(&str, usize)> {
  match tento_term::visual_width(grapheme) {
    0 => None,
    1 => Some((grapheme, 1)),
    2 => Some((grapheme, 2)),
    _ => Some((" ", 1)),
  }
}

/// A `ch` fill: the first cell-occupying grapheme of the string, defaulting to
/// a space. Sanitised like any other authored text.
fn fill_glyph(value: Option<&Value>) -> (String, usize) {
  let Some(Value::String(raw)) = value else {
    return (" ".to_string(), 1);
  };
  let safe = safe_span_text(raw);
  match safe.graphemes(true).find_map(cell_of) {
    Some((glyph, width)) => (glyph.to_string(), width),
    None => (" ".to_string(), 1),
  }
}

/// An integer field. JSON numbers only (a stringly `"3"` is a malformed op, not
/// a coordinate); a float truncates toward zero, since a Lisp `(/ w 2)` is a
/// perfectly ordinary way to author a coordinate.
fn int_at(value: &Value, key: &str) -> Option<i64> {
  match value.get(key)? {
    Value::Number(number) => number
      .as_i64()
      .or_else(|| number.as_f64().map(|float| float.trunc() as i64)),
    _ => None,
  }
}

// --- styles ---------------------------------------------------------------

/// A cell style, in exactly `term.block/v1`'s vocabulary and lowered through
/// exactly its painter — there is no second style system.
///
/// Two spellings, one meaning:
///
/// * the object form is a `term.span` style verbatim —
///   `{"bold": true, "fg": "#cd694a", "bg": "index:238"}`;
/// * the string form is a space/comma separated token list over the same
///   names — `"bold"`, `"dim underline"`, `"bold fg:red"`, `"bg:index:238"`.
///   A bare token that isn't an attribute name is read as a foreground color
///   in the same grammar (`"red"`, `"bright-black"`, `"#cd694a"`, `"index:9"`).
///
/// Anything unrecognised — an unknown token, an unknown color, a mistyped
/// object, a number — contributes nothing. Unknown style is unstyled, never an
/// error.
#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::*;

  const RESET: &str = "\u{1b}[0m";

  fn rows(value: &Value, width: u16) -> Vec<String> {
    render_canvas_rows(value, width, false).expect("canvas renders")
  }

  fn plain(value: &Value, width: u16) -> Vec<String> {
    rows(value, width)
      .iter()
      .map(|row| tento_term::strip_ansi(row))
      .collect()
  }

  /// Every row of every render is exactly `expected` cells and carries no
  /// control character other than SGR — the two invariants a host relies on to
  /// paint a canvas anywhere in its grid.
  fn assert_rows_are_safe(value: &Value, width: u16, expected: usize) {
    for (index, row) in rows(value, width).iter().enumerate() {
      assert_eq!(
        tento_term::visual_width(&tento_term::strip_ansi(row)),
        expected,
        "row {index} is not {expected} cells: {row:?}"
      );
      assert!(
        !tento_term::strip_ansi(row).chars().any(char::is_control),
        "row {index} carries a control character: {row:?}"
      );
    }
  }

  #[test]
  fn rect_text_and_hline_compose() {
    let value = json!({
      "shape": CANVAS_V1, "w": 12, "h": 4,
      "ops": [
        {"op": "rect", "x": 0, "y": 0, "w": 6, "h": 2, "style": "dim"},
        {"op": "rect", "x": 8, "y": 1, "w": 3, "h": 1, "ch": "#"},
        {"op": "text", "x": 1, "y": 0, "text": "SCORE 120", "style": "bold"},
        {"op": "hline", "y": 2, "from": 0, "to": 11, "style": "dim"},
        {"op": "hline", "y": 3, "from": 2, "to": 5, "ch": "="}
      ]
    });
    assert_eq!(
      plain(&value, 40),
      vec![
        " SCORE 120  ",
        "        ### ",
        "────────────",
        "  ====      ",
      ]
    );
    assert_rows_are_safe(&value, 40, 12);
  }

  #[test]
  fn text_clips_at_the_right_edge() {
    let value = json!({
      "shape": CANVAS_V1, "w": 6, "h": 1,
      "ops": [{"op": "text", "x": 3, "y": 0, "text": "abcdef"}]
    });
    assert_eq!(plain(&value, 40), vec!["   abc"]);
    assert_rows_are_safe(&value, 40, 6);
  }

  #[test]
  fn text_starting_left_of_the_canvas_clips_instead_of_shifting() {
    let value = json!({
      "shape": CANVAS_V1, "w": 6, "h": 1,
      "ops": [{"op": "text", "x": -2, "y": 0, "text": "abcdef"}]
    });
    assert_eq!(plain(&value, 40), vec!["cdef  "]);
  }

  #[test]
  fn ops_fully_out_of_bounds_draw_nothing() {
    let value = json!({
      "shape": CANVAS_V1, "w": 4, "h": 2,
      "ops": [
        {"op": "rect", "x": 100, "y": 0, "w": 3, "h": 1, "ch": "#"},
        {"op": "rect", "x": 0, "y": 40, "w": 3, "h": 1, "ch": "#"},
        {"op": "rect", "x": -9, "y": 0, "w": 4, "h": 1, "ch": "#"},
        {"op": "text", "x": 0, "y": -5, "text": "nope"},
        {"op": "text", "x": 99, "y": 0, "text": "nope"},
        {"op": "hline", "y": 99},
        {"op": "hline", "y": -1}
      ]
    });
    assert_eq!(plain(&value, 40), vec!["    ", "    "]);
    assert_rows_are_safe(&value, 40, 4);
  }

  #[test]
  fn a_canvas_wider_than_the_viewport_clips_to_the_viewport() {
    let value = json!({
      "shape": CANVAS_V1, "w": 20, "h": 2,
      "ops": [
        {"op": "hline", "y": 0},
        {"op": "text", "x": 6, "y": 1, "text": "far right"}
      ]
    });
    // `hline`'s default `to` is the DECLARED right edge, so the rule still
    // fills the visible strip rather than shrinking with the viewport.
    assert_eq!(plain(&value, 8), vec!["────────", "      fa"]);
    assert_rows_are_safe(&value, 8, 8);
  }

  #[test]
  fn zero_and_negative_sizes_render_nothing_without_panicking() {
    let none = json!({"shape": CANVAS_V1, "w": 10, "h": 0, "ops": []});
    assert!(rows(&none, 40).is_empty());
    let flat = json!({"shape": CANVAS_V1, "w": 0, "h": 2,
                      "ops": [{"op": "text", "x": 0, "y": 0, "text": "hi"}]});
    assert_eq!(plain(&flat, 40), vec!["", ""]);
    let negative = json!({"shape": CANVAS_V1, "w": -5, "h": -3,
                          "ops": [{"op": "rect", "x": 0, "y": 0, "w": -2, "h": -2}]});
    assert!(rows(&negative, 40).is_empty());
    // A viewport of zero columns is the same degenerate case.
    assert_eq!(
      plain(&json!({"shape": CANVAS_V1, "w": 4, "h": 1}), 0),
      vec![""]
    );
  }

  #[test]
  fn a_huge_declared_height_is_capped_not_allocated() {
    let value = json!({"shape": CANVAS_V1, "w": 2, "h": 900_000_000_i64, "ops": []});
    assert_eq!(rows(&value, 40).len(), MAX_ROWS);
  }

  #[test]
  fn wide_graphemes_never_leave_a_torn_cell() {
    // Fits exactly against the edge.
    let fits = json!({"shape": CANVAS_V1, "w": 6, "h": 1,
                      "ops": [{"op": "text", "x": 4, "y": 0, "text": "日"}]});
    assert_eq!(plain(&fits, 40), vec!["    日"]);
    assert_rows_are_safe(&fits, 40, 6);

    // One cell short: the half-visible grapheme degrades to a space.
    let straddles = json!({"shape": CANVAS_V1, "w": 6, "h": 1,
                           "ops": [{"op": "text", "x": 5, "y": 0, "text": "日本"}]});
    assert_eq!(plain(&straddles, 40), vec!["      "]);
    assert_rows_are_safe(&straddles, 40, 6);

    // Overwriting one half of a placed pair blanks the other half.
    let overwritten = json!({"shape": CANVAS_V1, "w": 4, "h": 1, "ops": [
      {"op": "text", "x": 0, "y": 0, "text": "日本"},
      {"op": "text", "x": 1, "y": 0, "text": "a"}
    ]});
    assert_eq!(plain(&overwritten, 40), vec![" a本"]);
    assert_rows_are_safe(&overwritten, 40, 4);

    // A wide fill in an odd-width rect ends on a space, never half a glyph.
    let odd = json!({"shape": CANVAS_V1, "w": 5, "h": 1,
                     "ops": [{"op": "rect", "x": 0, "y": 0, "w": 5, "h": 1, "ch": "日"}]});
    assert_eq!(plain(&odd, 40), vec!["日日 "]);
    assert_rows_are_safe(&odd, 40, 5);

    // A combining mark rides its base grapheme; it never claims a cell.
    let combining = json!({"shape": CANVAS_V1, "w": 4, "h": 1,
                           "ops": [{"op": "text", "x": 0, "y": 0, "text": "a\u{0301}bc"}]});
    assert_rows_are_safe(&combining, 40, 4);
    assert_eq!(plain(&combining, 40), vec!["a\u{0301}bc "]);
  }

  #[test]
  fn adjacent_equal_styles_share_one_sgr_and_unknown_styles_are_unstyled() {
    let value = json!({
      "shape": CANVAS_V1, "w": 8, "h": 1,
      "ops": [
        {"op": "rect", "x": 0, "y": 0, "w": 4, "h": 1, "style": "dim"},
        {"op": "text", "x": 1, "y": 0, "text": "hi", "style": "bold"},
        {"op": "text", "x": 3, "y": 0, "text": "!", "style": "sparkly"}
      ]
    });
    let painted = render_canvas_rows(&value, 40, true).expect("canvas renders");
    assert_eq!(
      painted,
      vec![format!("\u{1b}[2m \u{1b}[0m\u{1b}[1mhi\u{1b}[0m!    ")],
      "one SGR per run, and every run closes"
    );
    assert_eq!(painted[0].matches(RESET).count(), 2, "no dangling style");
    assert_eq!(tento_term::visual_width(&painted[0]), 8);

    // The object spelling is term.block's span style verbatim, and the string
    // spelling accepts the same color grammar.
    let styled = json!({
      "shape": CANVAS_V1, "w": 4, "h": 1,
      "ops": [
        {"op": "text", "x": 0, "y": 0, "text": "ab", "style": {"fg": "#d97757", "bold": true}},
        {"op": "text", "x": 2, "y": 0, "text": "cd", "style": "bg:index:238 underline"}
      ]
    });
    assert_eq!(
      render_canvas_rows(&styled, 40, true).expect("canvas renders"),
      vec![format!(
        "\u{1b}[1;38;2;217;119;87mab\u{1b}[0m\u{1b}[4;48;5;238mcd\u{1b}[0m"
      )]
    );
    // With color off (the CLI default) the same value paints bare cells.
    assert_eq!(plain(&styled, 40), vec!["abcd"]);
  }

  #[test]
  fn malformed_ops_are_skipped_and_never_error() {
    let value = json!({
      "shape": CANVAS_V1, "w": 5, "h": 1,
      "ops": [
        {"op": "rect", "x": 0, "y": 0},
        {"op": "rect", "x": 0, "y": 0, "w": "3", "h": 1},
        {"op": "text", "x": 0, "y": 0},
        {"op": "text", "x": "0", "y": 0, "text": "no"},
        {"op": "hline"},
        {"op": "wormhole", "x": 0, "y": 0},
        {"x": 0, "y": 0, "text": "no op key"},
        42,
        "nonsense",
        null,
        {"op": "text", "x": 0, "y": 0, "text": "ok"}
      ]
    });
    assert_eq!(plain(&value, 40), vec!["ok   "]);
    assert_rows_are_safe(&value, 40, 5);
  }

  #[test]
  fn text_can_never_smuggle_an_escape_or_a_newline_into_a_row() {
    let value = json!({
      "shape": CANVAS_V1, "w": 12, "h": 1,
      "ops": [{"op": "text", "x": 0, "y": 0, "text": "a\nb\r\u{1b}[31mc\u{7}d"}]
    });
    // The escape is stripped and the control characters become spaces, so the
    // producer's bytes can only ever land as cells of its own rect.
    assert_eq!(plain(&value, 40), vec!["a b c d     "]);
    assert_rows_are_safe(&value, 40, 12);
  }

  #[test]
  fn a_malformed_value_degrades_to_a_diagnostic() {
    for broken in [
      json!({"shape": CANVAS_V1, "h": 2, "ops": []}),
      json!({"shape": CANVAS_V1, "w": 2, "ops": []}),
      json!({"shape": CANVAS_V1, "w": "wide", "h": 2}),
      json!({"shape": CANVAS_V1, "w": 2, "h": 2, "ops": "rect"}),
      json!({"shape": CANVAS_V1, "w": 2, "h": 2, "ops": {"op": "rect"}}),
    ] {
      assert!(
        render_canvas_rows(&broken, 40, false).is_err(),
        "{broken} should not render"
      );
      let out = ShapeRegistry::core()
        .render(&broken, 40, &RenderCtx::cli())
        .expect("the shape still dispatches");
      assert_eq!(out.lines.len(), 1);
      assert!(out.lines[0].contains(CANVAS_V1), "{}", out.lines[0]);
    }
  }

  /// A constructor that always emits its optional slots sends `null`, which
  /// has to mean exactly what an absent key means.
  #[test]
  fn explicit_nulls_in_optional_slots_fall_back_to_the_defaults() {
    let value = json!({
      "shape": CANVAS_V1, "w": 6, "h": 2, "ops": [
        {"op": "hline", "y": 0, "from": null, "to": null, "style": null, "ch": null},
        {"op": "text", "x": 0, "y": 1, "text": "ab", "style": null},
        {"op": "rect", "x": 3, "y": 1, "w": 2, "h": 1, "ch": null, "style": null}
      ]
    });
    assert_eq!(plain(&value, 40), vec!["──────", "ab    "]);
    assert_eq!(
      rows(&value, 40),
      plain(&value, 40),
      "null style is unstyled"
    );
  }

  /// `sections/v1` zips a child's `lines` with its `paths`, so a canvas that
  /// returned an empty `paths` vector would lose every row inside a composite.
  #[test]
  fn a_canvas_keeps_all_its_rows_when_spliced_into_a_composite() {
    let value = json!({"shape": "sections/v1", "sections": [{
      "title": "board",
      "value": {"shape": CANVAS_V1, "w": 4, "h": 3,
                "ops": [{"op": "rect", "x": 0, "y": 0, "w": 4, "h": 3, "ch": "#"}]}
    }]});
    let out = ShapeRegistry::core()
      .render(&value, 40, &RenderCtx::cli())
      .expect("sections dispatches");
    let body: Vec<String> = out
      .lines
      .iter()
      .map(|line| tento_term::strip_ansi(line))
      .filter(|line| line.contains('#'))
      .collect();
    assert_eq!(body, vec!["  ####", "  ####", "  ####"]);
    assert_eq!(out.lines.len(), out.paths.len());
  }

  #[test]
  fn the_same_value_and_width_always_paint_the_same_bytes() {
    let value = json!({
      "shape": CANVAS_V1, "w": 16, "h": 3, "ops": [
        {"op": "rect", "x": 0, "y": 0, "w": 16, "h": 3, "style": {"bg": "index:238"}},
        {"op": "text", "x": 1, "y": 1, "text": "日本語 ok", "style": "bold fg:red"},
        {"op": "hline", "y": 2, "style": "dim"}
      ]
    });
    for force_color in [false, true] {
      let first = render_canvas_rows(&value, 16, force_color).expect("renders");
      let second = render_canvas_rows(&value, 16, force_color).expect("renders");
      assert_eq!(first, second, "render is not deterministic");
    }
  }

  #[test]
  fn the_core_registry_dispatches_a_canvas_value() {
    let reg = ShapeRegistry::core();
    assert!(reg.accepts(CANVAS_V1));
    let value = json!({
      "shape": CANVAS_V1, "w": 6, "h": 2,
      "ops": [{"op": "text", "x": 0, "y": 1, "text": "hey"}]
    });
    let out = reg
      .render(&value, 40, &RenderCtx::cli())
      .expect("canvas dispatches");
    assert_eq!(
      out
        .lines
        .iter()
        .map(|l| tento_term::strip_ansi(l))
        .collect::<Vec<_>>(),
      vec!["      ", "hey   "]
    );
    // Parallel to `lines`, all chrome: `sections/v1` zips the two vectors.
    assert_eq!(out.paths, vec![None, None]);
    assert!(out.attrs.is_empty());
    assert!(out.anims.is_empty(), "canvas/v1 ships no animation");
  }
}
