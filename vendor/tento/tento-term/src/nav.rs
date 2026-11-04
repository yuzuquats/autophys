//! Interactive-tree navigation helpers — chevrons, selection arithmetic,
//! scroll bounds, full-line highlight, severity styling.
//!
//! These are the algorithmic primitives shared between any pane that
//! drives a selectable tree (the fleet `TreePane`, the REPL `TracePane`,
//! and future panes). Pure functions; the pane owns the state and
//! delegates the math.
//!
//! Why here, not in a `tento-tui-*` crate: `tento-term` is the
//! lowest-level term-rendering crate and has zero deps on the
//! `tento-tui-*` stack, so these helpers can be reused from anywhere
//! without risking a cycle. The convention is "flat static helpers per
//! topic module" (compare `pad.rs`, `width.rs`, `draw.rs`).

use crate::style::Style;
use crate::width::visual_width;

// ---------------------------------------------------------------------------
// Chevron + collapse XOR
// ---------------------------------------------------------------------------

/// Pick the chevron glyph for a tree row.
///
/// - `has_children = true, shown = true` → `▾` (revealed children)
/// - `has_children = true, shown = false` → `▸` (folded children)
/// - `has_children = false` → `" "` (single-glyph blank so the column stays aligned)
pub fn chevron(has_children: bool, shown: bool) -> &'static str {
  match (has_children, shown) {
    (true, true) => "▾",
    (true, false) => "▸",
    (false, _) => " ",
  }
}

/// XOR helper: a default visibility state flipped by membership in the
/// `toggled` set.
///
/// `is_open(true, true) == false` (default-shown, toggled-off → hidden).
/// `is_open(false, true) == true` (default-hidden, toggled-on → visible).
pub fn is_open(default: bool, toggled: bool) -> bool {
  default ^ toggled
}

// ---------------------------------------------------------------------------
// Selection arithmetic — saturating clamp, no wrap
// ---------------------------------------------------------------------------

/// Move `selection` by `delta`, saturating at `0` and `max` (inclusive).
///
/// `max` is the largest valid selection index (i.e. `count - 1`). A
/// negative delta past zero clamps to zero; a positive delta past `max`
/// clamps to `max`. Selecting from / into a zero-count list is undefined
/// — the caller should not call this when the list is empty.
pub fn select_step(selection: usize, max: usize, delta: isize) -> usize {
  if delta >= 0 {
    selection.saturating_add(delta as usize).min(max)
  } else {
    selection.saturating_sub((-delta) as usize)
  }
}

/// Page-size variant of [`select_step`]: moves by `page` rows in
/// `forward`/backward direction, saturating at the bounds.
pub fn select_page(selection: usize, max: usize, page: usize, forward: bool) -> usize {
  let delta = page as isize;
  select_step(selection, max, if forward { delta } else { -delta })
}

/// [`select_step`]'s **row**-granular twin: move the cursor one addressable
/// ROW over a per-line path table, instead of one visual line.
///
/// A displayed line is not a unit of interaction — an addressable row is. A
/// component block's payload, a wrapped prompt banner and a table row's
/// continuation lines each span many lines that all carry ONE path, and the
/// operator means all of them when they point at any of them. So one press
/// crosses one path boundary, no matter how tall the row is.
///
/// The rules, in order:
/// - **Continuation lines are not stops.** The nearest line in `forward`'s
///   direction whose path is `Some` and *differs* from the current
///   selection's path wins.
/// - **Path-less filler is not a stop.** Blank spacers, turn separators and
///   unaddressable chrome carry `None` and are stepped over — they are
///   scenery, not destinations.
/// - **Never strand the cursor.** With nothing pathed and different left in
///   that direction, the cursor still leaves the run it was on (walking out
///   of the current path's lines, then one more), so it reaches the buffer
///   edge instead of grinding inside the block it is already on. The caller's
///   edge handling (hand focus to the neighboring pane) then sees a cursor
///   that genuinely ran out of rows.
///
/// Backward hits are normalized to their run's FIRST line, so `Up` and `Down`
/// are inverses and the selection band always sits on a row's head.
///
/// `paths[i]` is line `i`'s path; the result is always a valid index into
/// `paths` (and `0` for an empty table — the caller must not step an empty
/// list, exactly as with [`select_step`]).
pub fn select_row_step(paths: &[Option<String>], selection: usize, forward: bool) -> usize {
  let max = paths.len().saturating_sub(1);
  let at = |i: usize| paths.get(i).and_then(Option::as_deref);
  let current = at(selection);
  let differs = |i: usize| matches!(at(i), Some(p) if Some(p) != current);
  let hit = if forward {
    (selection.saturating_add(1)..paths.len()).find(|&i| differs(i))
  } else {
    (0..selection.min(paths.len())).rev().find(|&i| differs(i))
  };
  if let Some(i) = hit {
    if forward {
      // A forward hit is already its run's first line: everything between the
      // cursor and it either shares the cursor's path or is filler.
      return i;
    }
    let target = at(i);
    let mut head = i;
    while head > 0 && at(head - 1) == target {
      head -= 1;
    }
    return head;
  }
  // Fallback: step OUT of the current run, then one line further. With a
  // `None` current path this degrades to a plain one-line step, which is the
  // right behavior for a transcript that addresses nothing.
  let mut edge = selection.min(max);
  if current.is_some() {
    while forward && edge < max && at(edge + 1) == current {
      edge += 1;
    }
    while !forward && edge > 0 && at(edge - 1) == current {
      edge -= 1;
    }
  }
  select_step(edge, max, if forward { 1 } else { -1 })
}

// ---------------------------------------------------------------------------
// Scroll bounds — keep a node's line range inside the viewport
// ---------------------------------------------------------------------------

/// Adjust `scroll` so the line range `first..=last` fits inside a
/// `height`-tall viewport that starts at `scroll`. Returns the new
/// scroll value.
///
/// Behavior:
/// - If `first..=last` already lies entirely inside
///   `scroll..(scroll + height)`, returns `scroll` unchanged.
/// - If the range starts above the viewport (`first < scroll`), scrolls
///   up so `first` becomes the first visible line.
/// - If the range ends below the viewport
///   (`last >= scroll + height`), scrolls down so `last` becomes the
///   last visible line.
/// - If the range is taller than the viewport, the start (`first`)
///   wins; the bottom of the range stays clipped.
pub fn scroll_into_view(scroll: usize, first: usize, last: usize, height: usize) -> usize {
  let h = height.max(1);
  if first < scroll {
    first
  } else if last >= scroll + h {
    // last - h + 1, but written via checked-add so an absurdly large
    // `last` (well past the buffer) doesn't panic in debug builds.
    last + 1 - h
  } else {
    scroll
  }
}

// ---------------------------------------------------------------------------
// Full-line highlight (ANSI background, foreground-color preserving)
// ---------------------------------------------------------------------------

/// The theme-matched truecolor background every selection band paints in. One constant so
/// a table row, a tree row and a transcript row all read as the same cursor.
pub const SELECTION_BG: &str = "\u{1b}[48;2;0;34;42m";

/// The selection band under the ambient theme: the `selection.row` role's
/// background; `reverse` when that is all the role says, which is how the
/// adaptive floor draws a band in whatever colours the terminal has; and
/// [`SELECTION_BG`] when no theme is installed, so an unthemed process paints
/// exactly what it always has.
pub fn selection_bg() -> String {
  let Some(style) = crate::role::resolve("selection.row") else {
    return SELECTION_BG.to_string();
  };
  if let Some(params) = style
    .bg
    .as_deref()
    .and_then(|bg| crate::span_style::color_sgr(bg, true))
  {
    return format!("\u{1b}[{params}m");
  }
  if style.reverse {
    return "\u{1b}[7m".to_string();
  }
  SELECTION_BG.to_string()
}

/// DEBUG ONLY. An unmistakable band for seeing where a surface's rows
/// actually reach — the question "is this pane as wide as I think, and where
/// does it stop" has no other cheap answer, because a pane paints text and
/// nothing paints its extent. Never reached unless `TSH_TINT_ROWS` is set.
pub const DEBUG_TINT_BG: &str = "\u{1b}[48;2;127;29;29m";

/// [`highlight_row_line`] in [`DEBUG_TINT_BG`] — same continuous band, so a
/// tinted row shows its true width even where it paints its own backgrounds.
pub fn tint_row_line(line: &str, cols: usize) -> String {
  band_line(&strip_background_sgr(line), cols, DEBUG_TINT_BG)
}

/// Wrap `line` in the selection background ([`selection_bg`]) padded out to
/// `cols` characters, re-asserting the background after every embedded
/// reset so per-cell foreground colors (status circles, dim columns,
/// etc.) keep their color on the highlight band instead of being
/// flattened.
///
/// Use case: render a selected row with full-width visual emphasis
/// without inverting individual cell colors.
///
/// This preserves a line's OWN backgrounds, which is right for a row whose
/// background is content (a chart bar, a diff gutter) and wrong for a row the
/// cursor is on — use [`highlight_row_line`] when the band must be continuous.
pub fn highlight_line(line: &str, cols: usize) -> String {
  band_line(line, cols, &selection_bg())
}

/// A **continuous** full-width selection band at [`selection_bg`], for a row
/// that paints backgrounds of its own.
///
/// [`highlight_line`] only re-asserts the band after a reset, so any span
/// carrying an explicit background (a `term.block` `:fill` row, a diff
/// hunk's tinted gutter) re-paints over the band and the cursor comes out
/// striped — or, on a fully filled row, invisible. This strips the line's
/// background parameters first ([`strip_background_sgr`]), so exactly one
/// background survives: the band's. Foregrounds, bold/dim/underline and every
/// glyph are untouched, so the row still reads as itself under the cursor.
///
/// Rows that paint no background of their own (a table row, plain text) come
/// out byte-identical to [`highlight_line`] — the strip is a no-op there.
pub fn highlight_row_line(line: &str, cols: usize) -> String {
  band_line(&strip_background_sgr(line), cols, &selection_bg())
}

/// `line` with every SGR **background** parameter removed, leaving foreground
/// colors, attributes, glyphs and display width exactly as they were.
///
/// Drops `40`–`49`, `100`–`107`, and the extended forms `48;5;N` /
/// `48;2;R;G;B` (plus the colon-subparameter spelling `48:…`), consuming an
/// extended color's arguments so they can't leak out as stray attributes. An
/// SGR whose parameters were ALL backgrounds is dropped whole rather than
/// emitted as a bare `ESC[m` (which the terminal would read as a full reset).
/// Non-SGR escapes pass through verbatim.
pub fn strip_background_sgr(line: &str) -> String {
  if !line.as_bytes().contains(&0x1b) {
    return line.to_string();
  }
  let mut out = String::with_capacity(line.len());
  for segment in crate::width::segments(line) {
    let escape = match segment {
      crate::width::Segment::Text { text, .. } => {
        out.push_str(text);
        continue;
      }
      crate::width::Segment::Ansi(escape) => escape,
    };
    // Only SGR (`ESC[…m`) carries color; a bare `ESC[m` IS a reset and must
    // survive so the band can re-assert itself after it.
    let Some(params) = escape
      .strip_prefix("\u{1b}[")
      .and_then(|body| body.strip_suffix('m'))
      .filter(|body| !body.is_empty())
      .map(|body| body.split(';').collect::<Vec<_>>())
    else {
      out.push_str(escape);
      continue;
    };
    let kept = params_without_background(&params);
    if kept.len() == params.len() {
      out.push_str(escape);
    } else if !kept.is_empty() {
      out.push_str("\u{1b}[");
      out.push_str(&kept.join(";"));
      out.push('m');
    }
  }
  out
}

/// The non-background subset of one SGR's parameters, in order. Extended
/// colors (`38`/`48` + `5;N` or `2;R;G;B`) are consumed as a unit so a dropped
/// background takes its arguments with it and a kept foreground keeps its own.
fn params_without_background<'a>(params: &[&'a str]) -> Vec<&'a str> {
  let mut kept: Vec<&str> = Vec::with_capacity(params.len());
  let mut i = 0;
  while i < params.len() {
    let param = params[i];
    // Colon-subparameter spelling: the whole background lives in one param.
    if param.starts_with("48:") {
      i += 1;
      continue;
    }
    match param.parse::<u16>() {
      Ok(code @ (38 | 48)) => {
        let span = match params.get(i + 1).copied() {
          Some("5") => 3,
          Some("2") => 5,
          _ => 1,
        };
        let end = (i + span).min(params.len());
        if code == 38 {
          kept.extend_from_slice(&params[i..end]);
        }
        i = end;
      }
      Ok(40..=49 | 100..=107) => i += 1,
      _ => {
        kept.push(param);
        i += 1;
      }
    }
  }
  kept
}

/// The foreground parameters that paint the same colour as the background SGR
/// `bg` — `100` ↔ `90`, `48;5;N` ↔ `38;5;N`, `48;2;R;G;B` ↔ `38;2;R;G;B` — or
/// `None` when `bg` is not one colour (`reverse`, a compound SGR).
fn foreground_twin(bg: &str) -> Option<Vec<&str>> {
  let body = bg.strip_prefix("\u{1b}[")?.strip_suffix('m')?;
  let params: Vec<&str> = body.split(';').collect();
  match params.as_slice() {
    [code] => {
      const FOREGROUNDS: [&str; 16] = [
        "30", "31", "32", "33", "34", "35", "36", "37", "90", "91", "92", "93", "94", "95", "96",
        "97",
      ];
      match code.parse::<u16>().ok()? {
        n @ 40..=47 => Some(vec![FOREGROUNDS[usize::from(n - 40)]]),
        n @ 100..=107 => Some(vec![FOREGROUNDS[usize::from(n - 92)]]),
        _ => None,
      }
    }
    ["48", rest @ ..] if matches!(rest.first(), Some(&"5") | Some(&"2")) => {
      let mut twin = vec!["38"];
      twin.extend_from_slice(rest);
      Some(twin)
    }
    _ => None,
  }
}

/// `line` with every foreground the band's own colour repainted in the
/// terminal's foreground (`39`). The adaptive floor bands a row in one of the
/// terminal's sixteen colours, and the same name is what it paints hints,
/// gutters and timestamps in — text that would vanish into the band. A band
/// no text shares (every tuned palette's) leaves the line untouched.
fn repaint_band_coloured_text<'a>(line: &'a str, bg: &str) -> std::borrow::Cow<'a, str> {
  use std::borrow::Cow;
  if !line.as_bytes().contains(&0x1b) {
    return Cow::Borrowed(line);
  }
  let Some(twin) = foreground_twin(bg) else {
    return Cow::Borrowed(line);
  };
  let mut out = String::with_capacity(line.len());
  let mut changed = false;
  for segment in crate::width::segments(line) {
    let escape = match segment {
      crate::width::Segment::Text { text, .. } => {
        out.push_str(text);
        continue;
      }
      crate::width::Segment::Ansi(escape) => escape,
    };
    let Some(params) = escape
      .strip_prefix("\u{1b}[")
      .and_then(|body| body.strip_suffix('m'))
      .filter(|body| !body.is_empty())
      .map(|body| body.split(';').collect::<Vec<_>>())
    else {
      out.push_str(escape);
      continue;
    };
    let mut kept: Vec<&str> = Vec::with_capacity(params.len());
    let mut hit = false;
    let mut i = 0;
    while i < params.len() {
      let span = match (params[i], params.get(i + 1).copied()) {
        ("38" | "48", Some("5")) => 3,
        ("38" | "48", Some("2")) => 5,
        _ => 1,
      };
      let end = (i + span).min(params.len());
      if params[i..end] == twin[..] {
        kept.push("39");
        hit = true;
      } else {
        kept.extend_from_slice(&params[i..end]);
      }
      i = end;
    }
    if hit {
      changed = true;
      out.push_str("\u{1b}[");
      out.push_str(&kept.join(";"));
      out.push('m');
    } else {
      out.push_str(escape);
    }
  }
  if changed { Cow::Owned(out) } else { Cow::Borrowed(line) }
}

/// [`highlight_line`] with a caller-chosen background SGR: a full-width band
/// padded to `cols`, re-asserting `bg` after every embedded reset so per-cell
/// foreground colors keep their color on the band. For bands subtler than the
/// selection highlight (e.g. zebra striping at `48;5;235`). Text painted in
/// the band's own colour takes the terminal's foreground instead, so it stays
/// legible on it.
pub fn band_line(line: &str, cols: usize, bg: &str) -> String {
  const RESET: &str = "\u{1b}[0m";
  let line = repaint_band_coloured_text(line, bg);
  let line = line.as_ref();
  let pad = cols.saturating_sub(visual_width(line));
  let padded = format!("{line}{}", " ".repeat(pad));
  let body = padded.replace(RESET, &format!("{RESET}{bg}"));
  format!("{bg}{body}{RESET}")
}

// ---------------------------------------------------------------------------
// Level → Style
// ---------------------------------------------------------------------------

/// Pick a [`Style`] for a tracing-level name. Case-insensitive over the
/// usual set (`trace`, `debug`, `info`, `warn`, `error`). Returns
/// `None` for unrecognized levels and for `info` (info renders plain).
///
/// Used by trace-pane leading cells so warnings / errors stand out at
/// a glance. Trace and debug get `Dimmed` so they recede; info stays
/// plain so it doesn't fight the bulk of normal output.
pub fn level_style(level: &str) -> Option<Style> {
  match level.to_ascii_lowercase().as_str() {
    "trace" | "debug" => Some(Style::Dimmed),
    "warn" | "warning" => Some(Style::Yellow),
    "error" => Some(Style::Red),
    _ => None,
  }
}

// ---------------------------------------------------------------------------
// Tree-node key styling
// ---------------------------------------------------------------------------

/// Bold the name portion of a tree-node key, dimming any leading `.`
/// separator. The leading dot is a visual cue showing the join
/// character between this key and its parent (so a reader can mentally
/// concatenate parent + ".child" = "parent.child"), and benefits from
/// receding into the background; the rest of the key — the actual
/// command/group name — wants emphasis.
///
/// Examples:
/// - `style_node_key(".healthd.install")` → dimmed `.` + bold `healthd.install`
/// - `style_node_key("admin.spend.report")` → bold `admin.spend.report`
/// - `style_node_key("")` → empty
///
/// Pure; the `colored` crate suppresses ANSI when stdout isn't a
/// TTY, so call sites that pipe to non-terminal sinks get plain text
/// automatically.
pub fn style_node_key(key: &str) -> String {
  if let Some(rest) = key.strip_prefix('.') {
    format!("{}{}", Style::Dimmed.paint("."), Style::Bold.paint(rest))
  } else {
    Style::Bold.paint(key)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chevron_picks_right_glyph() {
    assert_eq!(chevron(true, true), "▾");
    assert_eq!(chevron(true, false), "▸");
    assert_eq!(chevron(false, true), " ");
    assert_eq!(chevron(false, false), " ");
  }

  #[test]
  fn is_open_truth_table() {
    assert!(!is_open(true, true), "shown by default + toggled → hidden");
    assert!(
      is_open(true, false),
      "shown by default + not toggled → shown"
    );
    assert!(is_open(false, true), "hidden by default + toggled → shown");
    assert!(
      !is_open(false, false),
      "hidden by default + not toggled → hidden"
    );
  }

  #[test]
  fn select_step_saturates_at_bounds() {
    assert_eq!(select_step(0, 9, -1), 0, "stays at 0 going up");
    assert_eq!(select_step(9, 9, 1), 9, "stays at max going down");
    assert_eq!(select_step(5, 9, 3), 8);
    assert_eq!(select_step(5, 9, 100), 9);
    assert_eq!(select_step(5, 9, -100), 0);
  }

  /// A table of line paths shaped like a real transcript: a three-line banner
  /// (one row), a path-less separator, a four-line component block (one row),
  /// trailing filler.
  fn transcript_paths() -> Vec<Option<String>> {
    let p = |s: &str| Some(s.to_string());
    vec![
      p("turn:1"),   // 0 banner head
      p("turn:1"),   // 1
      p("turn:1"),   // 2
      None,          // 3 separator
      p("turn:1/b"), // 4 block head
      p("turn:1/b"), // 5
      p("turn:1/b"), // 6
      p("turn:1/b"), // 7
      None,          // 8 filler
      p("turn:2"),   // 9
      None,          // 10 trailing filler
      None,          // 11
    ]
  }

  #[test]
  fn select_row_step_treats_a_multi_line_block_as_one_stop() {
    let paths = transcript_paths();
    // Down from anywhere in the banner lands on the block's head, skipping
    // both the banner's continuation lines and the path-less separator.
    assert_eq!(select_row_step(&paths, 0, true), 4);
    assert_eq!(select_row_step(&paths, 2, true), 4);
    // Down from anywhere in the block clears the whole block plus the filler.
    assert_eq!(select_row_step(&paths, 4, true), 9);
    assert_eq!(select_row_step(&paths, 7, true), 9);
  }

  #[test]
  fn select_row_step_backward_lands_on_the_rows_head() {
    let paths = transcript_paths();
    // Up out of `turn:2` lands on the BLOCK'S FIRST line, not its last, so
    // Up and Down are inverses.
    assert_eq!(select_row_step(&paths, 9, false), 4);
    assert_eq!(select_row_step(&paths, 4, false), 0);
    assert_eq!(select_row_step(&paths, 2, false), 0, "…and never mid-run");
  }

  #[test]
  fn select_row_step_never_strands_the_cursor() {
    let paths = transcript_paths();
    // Nothing pathed and different below `turn:2`: the cursor still leaves
    // that row, so the caller's edge handling can hand focus on.
    assert_eq!(select_row_step(&paths, 9, true), 10);
    assert_eq!(select_row_step(&paths, 11, true), 11, "clamps at the end");
    assert_eq!(select_row_step(&paths, 0, false), 0, "clamps at the start");
    // A cursor parked mid-block with nothing below leaves the block whole.
    let tail = vec![Some("b".to_string()), Some("b".to_string()), None];
    assert_eq!(select_row_step(&tail, 0, true), 2, "steps out of the run");
  }

  #[test]
  fn select_row_step_degrades_to_line_stepping_without_paths() {
    // A transcript that addresses nothing still navigates line by line
    // instead of jumping to an edge.
    let none: Vec<Option<String>> = vec![None, None, None, None];
    assert_eq!(select_row_step(&none, 0, true), 1);
    assert_eq!(select_row_step(&none, 2, false), 1);
    assert_eq!(select_row_step(&none, 3, true), 3);
    assert_eq!(select_row_step(&[], 0, true), 0, "empty table is safe");
  }

  #[test]
  fn select_page_clamps_near_edges() {
    assert_eq!(select_page(5, 100, 10, true), 15);
    assert_eq!(select_page(95, 100, 10, true), 100, "clamps to max");
    assert_eq!(select_page(3, 100, 10, false), 0, "clamps to 0");
  }

  #[test]
  fn scroll_into_view_keeps_visible_range_unchanged() {
    // 5..=8 is already inside 3..(3+10) = 3..13 → no change.
    assert_eq!(scroll_into_view(3, 5, 8, 10), 3);
  }

  #[test]
  fn scroll_into_view_scrolls_up_for_range_above() {
    // 1..=2 starts before scroll=5 → scroll up to 1.
    assert_eq!(scroll_into_view(5, 1, 2, 10), 1);
  }

  #[test]
  fn scroll_into_view_scrolls_down_for_range_below() {
    // 12..=14 ends after scroll=0+10=10 → scroll so last=14 is last visible.
    // new_scroll = 14 + 1 - 10 = 5.
    assert_eq!(scroll_into_view(0, 12, 14, 10), 5);
  }

  #[test]
  fn scroll_into_view_handles_zero_height_safely() {
    // height=0 is clamped to 1; first=0 already at scroll=0 → 0.
    assert_eq!(scroll_into_view(0, 0, 0, 0), 0);
  }

  #[test]
  fn highlight_line_pads_and_reasserts_background_after_resets() {
    const BG: &str = SELECTION_BG;
    const RESET: &str = "\u{1b}[0m";
    // Embedded reset (e.g. a styled cell's terminator) must be followed by a
    // re-assertion of BG so the next foreground color paints on the BG.
    let input = format!("{RESET}rest");
    let out = highlight_line(&input, 10);
    assert!(out.starts_with(BG), "highlight wraps in BG");
    assert!(
      out.contains(&format!("{RESET}{BG}")),
      "BG is re-asserted after every embedded reset"
    );
    assert!(out.ends_with(RESET), "trailing reset closes the band");
  }

  /// The adaptive floor bands a row in `bright-black` and paints its hints in
  /// `bright-black` too; on the band that text takes the terminal's foreground,
  /// and only the colour that clashes changes.
  #[test]
  fn band_line_repaints_text_in_the_bands_own_colour() {
    const RESET: &str = "\u{1b}[0m";
    let input = format!("\u{1b}[2;90mhint{RESET} \u{1b}[32mok{RESET} \u{1b}[38;5;8mgray{RESET}");
    let out = band_line(&input, 20, "\u{1b}[100m");
    assert!(out.contains("\u{1b}[2;39mhint"), "{out:?}");
    assert!(out.contains("\u{1b}[32mok"), "other colours keep theirs: {out:?}");
    assert!(
      out.contains("\u{1b}[38;5;8mgray"),
      "index 8 is not SGR 90's spelling of the band: {out:?}"
    );

    let out = band_line(&format!("\u{1b}[38;5;236mx{RESET}"), 4, "\u{1b}[48;5;236m");
    assert!(out.contains("\u{1b}[39mx"), "{out:?}");
    let out = band_line(&format!("\u{1b}[1;38;2;0;34;42mx{RESET}"), 4, SELECTION_BG);
    assert!(out.contains("\u{1b}[1;39mx"), "{out:?}");
  }

  /// A band no text shares, and `reverse`, paint exactly what they always did.
  #[test]
  fn band_line_leaves_unrelated_text_byte_identical() {
    const RESET: &str = "\u{1b}[0m";
    let input = format!("\u{1b}[1;38;2;192;202;245mhead{RESET}\u{1b}[90mtail{RESET}");
    let pad = " ".repeat(12);
    assert_eq!(
      band_line(&input, 20, SELECTION_BG),
      format!("{SELECTION_BG}\u{1b}[1;38;2;192;202;245mhead{RESET}{SELECTION_BG}\u{1b}[90mtail{RESET}{SELECTION_BG}{pad}{RESET}")
    );
    let reverse = "\u{1b}[7m";
    assert_eq!(
      band_line(&input, 20, reverse),
      format!("{reverse}\u{1b}[1;38;2;192;202;245mhead{RESET}{reverse}\u{1b}[90mtail{RESET}{reverse}{pad}{RESET}")
    );
  }

  /// The failure `highlight_row_line` exists for: a row that fills itself with
  /// its own background (a `term.block` `:fill` row) re-paints over an
  /// overlaid band, so the cursor is invisible on exactly the rows a component
  /// draws. Stripping the row's backgrounds leaves the band as the only one.
  #[test]
  fn highlight_row_line_leaves_exactly_one_background_the_bands() {
    const RESET: &str = "\u{1b}[0m";
    // A styled span with BOTH a truecolor fg and a 256-color bg, then a
    // basic-color bg run — the two spellings a component actually emits.
    let input = format!("\u{1b}[1;38;2;192;202;245;48;5;236mhead{RESET}\u{1b}[41mtail{RESET}");
    let out = highlight_row_line(&input, 20);

    assert!(out.starts_with(SELECTION_BG), "the band opens the row");
    assert!(out.ends_with(RESET), "the band closes at the row's end");
    // No background survives but the band's: not the 256-color fill, not the
    // basic red, and no `49` default-bg reset either.
    assert!(
      !out.contains("48;5;236"),
      "256-color fill stripped: {out:?}"
    );
    assert!(!out.contains("\u{1b}[41m"), "basic bg stripped: {out:?}");
    assert_eq!(
      out.matches("48;").count(),
      out.matches(SELECTION_BG).count(),
      "every remaining background IS the band: {out:?}"
    );
    // The fg and the attributes came through untouched, and so did the text.
    assert!(out.contains("38;2;192;202;245"), "fg preserved: {out:?}");
    assert!(out.contains("1;38;2"), "bold preserved: {out:?}");
    assert_eq!(
      crate::strip_ansi(&out),
      format!("headtail{}", " ".repeat(12))
    );
  }

  /// A row with no background of its own is byte-identical to the plain band —
  /// the table's call sites keep the output they had.
  #[test]
  fn highlight_row_line_matches_highlight_line_without_backgrounds() {
    let input = format!("{}alpha{}  beta", "\u{1b}[2m", "\u{1b}[0m");
    assert_eq!(highlight_row_line(&input, 24), highlight_line(&input, 24));
  }

  /// An SGR whose parameters were ALL backgrounds must vanish, not degrade to
  /// `ESC[m` — which the terminal reads as a full reset and would tear the
  /// band open mid-row.
  #[test]
  fn strip_background_sgr_drops_all_background_sgr_whole() {
    assert_eq!(strip_background_sgr("\u{1b}[48;2;16;16;16mx"), "x");
    assert_eq!(strip_background_sgr("\u{1b}[49mx"), "x");
    assert_eq!(strip_background_sgr("\u{1b}[48:5:236mx"), "x");
    // A reset survives verbatim — the band re-asserts itself after it.
    assert_eq!(strip_background_sgr("\u{1b}[0mx"), "\u{1b}[0mx");
    // Mixed: the fg + attribute survive, the bg's three params leave together.
    assert_eq!(
      strip_background_sgr("\u{1b}[2;48;5;236;36mx"),
      "\u{1b}[2;36mx"
    );
  }

  #[test]
  fn style_node_key_dims_leading_dot_and_bolds_rest() {
    crate::force_color(true);
    let out = style_node_key(".healthd.install");
    crate::unforce_color();
    // Both an ANSI dim sequence (for the leading `.`) and a bold
    // sequence (for the rest) must appear. The dim sequence comes
    // first (since it wraps the leading character).
    assert!(out.contains('\u{1b}'), "expect ANSI escapes, got {out:?}");
    let dim_idx = out.find("\u{1b}[2m");
    let bold_idx = out.find("\u{1b}[1m");
    assert!(
      dim_idx.is_some(),
      "expect dim escape for leading dot in {out:?}"
    );
    assert!(bold_idx.is_some(), "expect bold escape for name in {out:?}");
    assert!(
      dim_idx.unwrap() < bold_idx.unwrap(),
      "dim must precede bold"
    );
  }

  #[test]
  fn style_node_key_bolds_only_when_no_leading_dot() {
    crate::force_color(true);
    let out = style_node_key("admin.spend.report");
    crate::unforce_color();
    assert!(out.contains("\u{1b}[1m"), "expect bold escape in {out:?}");
    assert!(
      !out.contains("\u{1b}[2m"),
      "must not contain a dim escape, got {out:?}"
    );
  }

  #[test]
  fn style_node_key_empty_returns_empty() {
    let out = style_node_key("");
    // Empty input may produce empty output OR bare escapes wrapping
    // nothing — either way it must not panic and must not contain
    // visible glyphs.
    assert!(crate::width::strip_ansi(&out).is_empty());
  }

  #[test]
  fn level_style_maps_severity_to_color() {
    assert_eq!(level_style("trace"), Some(Style::Dimmed));
    assert_eq!(level_style("DEBUG"), Some(Style::Dimmed));
    assert_eq!(level_style("info"), None);
    assert_eq!(level_style("warn"), Some(Style::Yellow));
    assert_eq!(level_style("warning"), Some(Style::Yellow));
    assert_eq!(level_style("Error"), Some(Style::Red));
    assert_eq!(level_style("???"), None);
  }
}
