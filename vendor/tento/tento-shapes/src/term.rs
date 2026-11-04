//! `term/v1` — a hosted terminal's grid, rendered from the `term.grid/v1`
//! wire snapshot (RLE styled runs per row).
//!
//! Two input forms:
//! - the **resolved live pointer**: the registry's `source` resolution hands
//!   this widget the grid file's latest snapshot record directly
//!   (`{v, gen, cols, rows, alt_screen, cursor, rows_rle, …}`);
//! - a **wrapper** `{shape:"term/v1", grid:{…snapshot…}, tail?:N, full?:bool}`
//!   for composed renders (a settled fold's `final_alt_grid`, a term pane).
//!
//! Painting reads the WIRE format, deliberately independent of `tento-vt` —
//! the snapshot JSON is the contract between the session-side emulator and
//! every consumer, and depending on the emulator crate here would drag its
//! VT engine into every CLI. Alt-screen content renders whole; primary-screen
//! content defaults to a bottom tail (a live `cargo build` is a scrolling
//! log, not a fixed frame).

use serde::Deserialize;
use serde_json::Value;

use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};

pub const TERM_V1: &str = "term/v1";

/// Rows a non-alt-screen (scrolling) grid shows inline by default.
const DEFAULT_TAIL: usize = 16;

/// `Run.attrs` bits — the `term.grid/v1` wire vocabulary (mirrors
/// `tento-vt`'s `attrs` module; the wire is the contract).
mod attr {
  pub const BOLD: u16 = 1;
  pub const DIM: u16 = 1 << 1;
  pub const ITALIC: u16 = 1 << 2;
  pub const UNDERLINE: u16 = 1 << 3;
  pub const INVERSE: u16 = 1 << 4;
  pub const STRIKEOUT: u16 = 1 << 5;
  pub const HIDDEN: u16 = 1 << 6;
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
enum PaintDoc {
  Indexed(u8),
  Rgb(String),
}

#[derive(Deserialize, Clone)]
struct RunDoc {
  text: String,
  #[serde(default)]
  fg: Option<PaintDoc>,
  #[serde(default)]
  bg: Option<PaintDoc>,
  #[serde(default)]
  attrs: u16,
}

#[derive(Deserialize, Default)]
struct CursorDoc {
  #[serde(default)]
  row: u16,
  #[serde(default)]
  col: u16,
  #[serde(default)]
  visible: bool,
}

#[derive(Deserialize)]
struct GridDoc {
  #[serde(default)]
  alt_screen: bool,
  #[serde(default)]
  cursor: Option<CursorDoc>,
  rows_rle: Vec<Vec<RunDoc>>,
}

pub struct TermWidget;

impl ShapeWidget for TermWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[TERM_V1]
  }

  fn render(
    &self,
    value: &Value,
    _width: u16,
    _ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    // The settled fold (`term.result/v1` routed here by preset): its
    // transcript lines are already-painted ANSI strings — output them
    // directly, tail-limited like any primary-screen stream.
    if let Some(lines) = value
      .get("transcript")
      .and_then(|t| t.get("lines"))
      .and_then(Value::as_array)
    {
      let tail = value
        .get("tail")
        .and_then(Value::as_u64)
        .map(|t| t as usize)
        .unwrap_or(DEFAULT_TAIL);
      let full = value.get("full").and_then(Value::as_bool).unwrap_or(false);
      let all: Vec<String> = lines
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect();
      let skip = if full {
        0
      } else {
        all.len().saturating_sub(tail)
      };
      let lines: Vec<String> = all.into_iter().skip(skip).collect();
      let paths = vec![None; lines.len()];
      return ShapeOutput {
        lines,
        paths,
        ..ShapeOutput::default()
      };
    }
    let (doc, tail, full) = match extract(value) {
      Some(parts) => parts,
      None => return ShapeOutput::diagnostic("  (term/v1: no grid)"),
    };
    // Alt-screen content is a composed frame — show it whole. Primary-screen
    // content is a scrolling stream — show the live tail; a consumer that
    // wants everything passes `full`. The tail ends where the program has
    // written (or the cursor sits), not at the grid's last row: a primary
    // screen fills from the top, so in a tall terminal a short program's
    // output — or a prompt on row 0 — would otherwise sit above a tail of
    // blank rows and never be seen until it exited.
    let (skipped, end) = if full || doc.alt_screen {
      (0, doc.rows_rle.len())
    } else {
      let end = written_end(&doc);
      (end.saturating_sub(tail), end)
    };
    let rows = &doc.rows_rle[skipped..end];
    let cursor = doc.cursor.unwrap_or_default();
    let mut lines = Vec::with_capacity(rows.len());
    for (i, runs) in rows.iter().enumerate() {
      let absolute_row = i + skipped;
      let with_cursor;
      let runs: &[RunDoc] = if cursor.visible && absolute_row == cursor.row as usize {
        with_cursor = invert_cell(runs, cursor.col as usize);
        &with_cursor
      } else {
        runs
      };
      lines.push(paint_row(runs));
    }
    let paths = vec![None; lines.len()];
    ShapeOutput {
      lines,
      paths,
      ..ShapeOutput::default()
    }
  }
}

/// One past the last primary-screen row that holds anything: the last row
/// with non-blank text, or the visible cursor's row if that is lower. Rows
/// below it are space the program has not reached yet.
fn written_end(doc: &GridDoc) -> usize {
  let last_text = doc
    .rows_rle
    .iter()
    .rposition(|runs| runs.iter().any(|run| !run.text.trim().is_empty()))
    .map_or(0, |row| row + 1);
  let cursor = doc
    .cursor
    .as_ref()
    .filter(|cursor| cursor.visible)
    .map_or(0, |cursor| cursor.row as usize + 1);
  last_text.max(cursor).min(doc.rows_rle.len())
}

fn extract(value: &Value) -> Option<(GridDoc, usize, bool)> {
  let tail = value
    .get("tail")
    .and_then(Value::as_u64)
    .map(|t| t as usize)
    .unwrap_or(DEFAULT_TAIL);
  let full = value.get("full").and_then(Value::as_bool).unwrap_or(false);
  let grid_value = if value.get("rows_rle").is_some() {
    value
  } else {
    value.get("grid")?
  };
  let doc: GridDoc = serde_json::from_value(grid_value.clone()).ok()?;
  Some((doc, tail, full))
}

/// Split the run list at display column `col` and set INVERSE on that one
/// cell — the cursor. Column arithmetic counts chars (a wide char shifts the
/// cursor by one cell at most — accepted imprecision until width-aware runs).
fn invert_cell(runs: &[RunDoc], col: usize) -> Vec<RunDoc> {
  let mut out = Vec::with_capacity(runs.len() + 2);
  let mut at = 0usize;
  let mut done = false;
  for run in runs {
    let len = run.text.chars().count();
    if done || col < at || col >= at + len {
      out.push(run.clone());
      at += len;
      continue;
    }
    let split = col - at;
    let chars: Vec<char> = run.text.chars().collect();
    if split > 0 {
      out.push(RunDoc {
        text: chars[..split].iter().collect(),
        ..run.clone()
      });
    }
    out.push(RunDoc {
      text: chars[split].to_string(),
      attrs: run.attrs ^ attr::INVERSE,
      ..run.clone()
    });
    if split + 1 < len {
      out.push(RunDoc {
        text: chars[split + 1..].iter().collect(),
        ..run.clone()
      });
    }
    at += len;
    done = true;
  }
  if !done {
    // Cursor past the painted content (trailing blanks were trimmed): pad to
    // it and invert one space.
    let pad = col.saturating_sub(at);
    if pad > 0 {
      out.push(RunDoc {
        text: " ".repeat(pad),
        fg: None,
        bg: None,
        attrs: 0,
      });
    }
    out.push(RunDoc {
      text: " ".to_string(),
      fg: None,
      bg: None,
      attrs: attr::INVERSE,
    });
  }
  out
}

/// One row of runs → one ANSI string (reset-terminated iff styled) — paints
/// the wire snapshot the way `term.block/v1` pre-paints its frames.
fn paint_row(runs: &[RunDoc]) -> String {
  let mut out = String::new();
  let mut styled = false;
  for run in runs {
    let codes = sgr_codes(run);
    if codes.is_empty() {
      if styled {
        out.push_str("\x1b[0m");
        styled = false;
      }
    } else {
      out.push_str("\x1b[0;");
      out.push_str(&codes.join(";"));
      out.push('m');
      styled = true;
    }
    out.push_str(&run.text);
  }
  if styled {
    out.push_str("\x1b[0m");
  }
  out
}

fn sgr_codes(run: &RunDoc) -> Vec<String> {
  let mut codes = Vec::new();
  let a = run.attrs;
  for (bit, code) in [
    (attr::BOLD, "1"),
    (attr::DIM, "2"),
    (attr::ITALIC, "3"),
    (attr::UNDERLINE, "4"),
    (attr::INVERSE, "7"),
    (attr::HIDDEN, "8"),
    (attr::STRIKEOUT, "9"),
  ] {
    if a & bit != 0 {
      codes.push(code.to_string());
    }
  }
  if let Some(fg) = &run.fg {
    color_codes(&mut codes, fg, false);
  }
  if let Some(bg) = &run.bg {
    color_codes(&mut codes, bg, true);
  }
  codes
}

fn color_codes(codes: &mut Vec<String>, paint: &PaintDoc, background: bool) {
  match paint {
    PaintDoc::Indexed(n) => {
      let n = *n;
      // Classic 16-color codes respect the viewer's theme; 256-index past 15.
      if n < 8 {
        codes.push(format!("{}", n as u16 + if background { 40 } else { 30 }));
      } else if n < 16 {
        codes.push(format!(
          "{}",
          (n - 8) as u16 + if background { 100 } else { 90 }
        ));
      } else {
        codes.push(format!("{};5;{}", if background { 48 } else { 38 }, n));
      }
    }
    PaintDoc::Rgb(hex) => {
      if let Some((r, g, b)) = parse_hex(hex) {
        codes.push(format!(
          "{};2;{r};{g};{b}",
          if background { 48 } else { 38 }
        ));
      }
    }
  }
}

fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
  let hex = hex.strip_prefix('#')?;
  if hex.len() != 6 {
    return None;
  }
  Some((
    u8::from_str_radix(&hex[0..2], 16).ok()?,
    u8::from_str_radix(&hex[2..4], 16).ok()?,
    u8::from_str_radix(&hex[4..6], 16).ok()?,
  ))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn snapshot() -> Value {
    json!({
      "v": 1, "gen": 3, "cols": 20, "rows": 4, "alt_screen": false,
      "cursor": {"row": 3, "col": 2, "visible": true},
      "modes": {"alt_screen": false, "app_cursor": false, "app_keypad": false,
                 "mouse": "none", "sgr_mouse": false, "bracketed_paste": false,
                 "focus_reporting": false, "kitty_flags": 0},
      "rows_rle": [
        [{"text": "one"}],
        [{"text": "two ", "fg": 1}, {"text": "red", "fg": 1, "attrs": 1}],
        [{"text": "three"}],
        [{"text": "$ "}]
      ]
    })
  }

  #[test]
  fn resolved_snapshot_renders_rows_with_cursor() {
    let out = TermWidget.render(&snapshot(), 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), 4);
    assert_eq!(out.lines[0], "one");
    assert!(
      out.lines[1].contains("\x1b[0;1;31mred"),
      "styled run: {:?}",
      out.lines[1]
    );
    // Cursor at row 3 col 2: the cell after "$ " is an inverted space.
    assert!(
      out.lines[3].contains("\x1b[0;7m \x1b[0m"),
      "cursor cell: {:?}",
      out.lines[3]
    );
  }

  #[test]
  fn primary_screen_tails_and_alt_screen_shows_whole() {
    let mut long = snapshot();
    let row = json!([{ "text": "x" }]);
    for _ in 0..40 {
      long["rows_rle"].as_array_mut().unwrap().push(row.clone());
    }
    let out = TermWidget.render(&long, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), DEFAULT_TAIL, "primary screen tails");

    long["alt_screen"] = json!(true);
    let out = TermWidget.render(&long, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), 44, "alt screen renders whole");
  }

  /// A short program in a tall terminal: its output is near the top and the
  /// rest of the grid is blank. The live tail shows what it wrote and the
  /// cursor row, not the blank bottom of the screen.
  #[test]
  fn a_tall_primary_screen_tails_what_was_written_not_blank_rows() {
    let mut tall = snapshot();
    let rows = tall["rows_rle"].as_array_mut().unwrap();
    rows.clear();
    rows.push(json!([{ "text": "   Compiling crate-20 [====] 20/20" }]));
    rows.push(json!([{ "text": "    Finished build in 3.0s" }]));
    for _ in 0..63 {
      rows.push(json!([]));
    }
    tall["cursor"] = json!({"row": 2, "col": 0, "visible": true});
    let out = TermWidget.render(&tall, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(
      out.lines.len(),
      3,
      "written rows + the cursor row: {:?}",
      out.lines
    );
    assert!(
      out.lines[0].contains("Compiling crate-20"),
      "{:?}",
      out.lines
    );
    assert!(out.lines[1].contains("Finished build"), "{:?}", out.lines);
  }

  /// A prompt waiting on row 0 of a fresh terminal is on screen, with the
  /// cursor after it.
  #[test]
  fn a_prompt_on_the_first_row_is_shown() {
    let mut prompt = snapshot();
    let rows = prompt["rows_rle"].as_array_mut().unwrap();
    rows.clear();
    rows.push(json!([{ "text": "Your name? " }]));
    for _ in 0..39 {
      rows.push(json!([]));
    }
    prompt["cursor"] = json!({"row": 0, "col": 11, "visible": true});
    let out = TermWidget.render(&prompt, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), 1, "{:?}", out.lines);
    assert!(out.lines[0].starts_with("Your name? "), "{:?}", out.lines);
    assert!(
      out.lines[0].contains("\x1b[0;7m \x1b[0m"),
      "cursor after the prompt: {:?}",
      out.lines
    );
  }

  #[test]
  fn wrapper_form_with_full_renders_all() {
    let wrapped = json!({
      "shape": "term/v1",
      "full": true,
      "grid": snapshot(),
    });
    let out = TermWidget.render(&wrapped, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), 4);
  }

  #[test]
  fn registry_dispatches_term_v1() {
    let reg = ShapeRegistry::core();
    let mut value = snapshot();
    value["shape"] = json!("term/v1");
    let out = reg
      .render(&value, 80, &RenderCtx::cli())
      .expect("dispatched");
    assert_eq!(out.lines[0], "one");
  }

  #[test]
  fn settled_fold_renders_transcript_tail() {
    let fold = json!({
      "shape": "term/v1",
      "datatype": "term.result/v1",
      "argv": ["git", "status"],
      "status": 0,
      "transcript": {"lines": (0..30).map(|i| format!("line{i}")).collect::<Vec<_>>(), "truncated": false},
    });
    let out = TermWidget.render(&fold, 80, &RenderCtx::cli(), &ShapeRegistry::core());
    assert_eq!(out.lines.len(), DEFAULT_TAIL);
    assert_eq!(out.lines.last().unwrap(), "line29");
  }

  #[test]
  fn malformed_grid_degrades_to_diagnostic() {
    let out = TermWidget.render(
      &json!({"shape": "term/v1", "grid": {"rows_rle": "nope"}}),
      80,
      &RenderCtx::cli(),
      &ShapeRegistry::core(),
    );
    assert_eq!(out.lines.len(), 1);
    assert!(out.lines[0].contains("no grid"));
  }
}
