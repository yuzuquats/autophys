//! Box-drawing primitives: the tree glyph set, a continuation-prefix builder,
//! a horizontal rule, and a rounded titled [`panel`] frame.

use crate::ansi::{BLUE, RESET};
use crate::pad::{pad_right, truncate_ellipsis};
use crate::style::Style;
use crate::width::visual_width;

/// The glyphs used to draw trees and table separators.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoxChars {
  /// Branch glyph for a node that has a following sibling, e.g. `├──`.
  pub branch_mid: &'static str,
  /// Branch glyph for the last child, e.g. `└──`.
  pub branch_last: &'static str,
  /// Vertical connector for a continuation line under a non-last node, e.g. `│`.
  pub vert: &'static str,
  /// Continuation prefix (branch-glyph width) under a non-last node, e.g. `│   `.
  pub vert_cont: &'static str,
  /// Continuation prefix (branch-glyph width) under the last child, e.g. `    `.
  pub blank_cont: &'static str,
  /// Horizontal bar used for rules, e.g. `─`.
  pub hbar: &'static str,
}

/// The default Unicode box-drawing set.
pub const fn box_chars() -> BoxChars {
  BoxChars {
    branch_mid: "├──",
    branch_last: "└──",
    vert: "│",
    vert_cont: "│   ",
    blank_cont: "    ",
    hbar: "─",
  }
}

/// An ASCII-only fallback set (not used by default; here for future opt-in).
pub const fn box_chars_ascii() -> BoxChars {
  BoxChars {
    branch_mid: "+--",
    branch_last: "`--",
    vert: "|",
    vert_cont: "|   ",
    blank_cont: "    ",
    hbar: "-",
  }
}

impl Default for BoxChars {
  fn default() -> Self {
    box_chars()
  }
}

impl BoxChars {
  /// The branch glyph (without trailing space) for a node, given whether it is
  /// the last child of its parent.
  pub fn branch(&self, is_last: bool) -> &'static str {
    if is_last {
      self.branch_last
    } else {
      self.branch_mid
    }
  }

  /// The continuation prefix that a node contributes to its descendants
  /// (`vert_cont` if it has a following sibling, else `blank_cont`).
  pub fn cont(&self, is_last: bool) -> &'static str {
    if is_last {
      self.blank_cont
    } else {
      self.vert_cont
    }
  }
}

/// A horizontal rule `width` columns wide (each `hbar` glyph is one column).
pub fn rule_with(box_chars: &BoxChars, width: usize) -> String {
  box_chars.hbar.repeat(width)
}

/// A horizontal rule `width` columns wide using the default `─` glyph.
pub fn rule(width: usize) -> String {
  "─".repeat(width)
}

// Rounded box-drawing glyphs for [`panel`] frames: `╭ ╮ ╰ ╯` corners, `─`/`│` edges.
const TOP_LEFT: &str = "╭";
const TOP_RIGHT: &str = "╮";
const BOTTOM_LEFT: &str = "╰";
const BOTTOM_RIGHT: &str = "╯";
const HORIZ: &str = "─";
const VERT: &str = "│";

/// Draw `lines` inside a rounded box `width` columns wide, with `title` set into
/// the top border:
///
/// ```text
/// ╭─ title ───────────────╮
/// │ content line          │
/// ╰───────────────────────╯
/// ```
///
/// Each content line is truncated + right-padded to the inner width (`width − 4`,
/// for the `│ ` / ` │` borders) so styled (colored/dimmed) lines stay aligned;
/// the frame glyphs are dimmed. An empty `title` draws a plain top border.
/// Returns `lines.len() + 2` rows. ANSI-safe.
pub fn panel(title: &str, lines: &[String], width: usize) -> Vec<String> {
  panel_full(title, "", lines, width)
}

/// [`panel`] with a right-aligned `subtitle` in the top border, for a trailing
/// caption (e.g. a status badge):
///
/// ```text
/// ╭─ title ───────────── ● ok ─╮
/// ```
///
/// `title` and `subtitle` may carry their own ANSI styling (measured by display
/// width). Either may be empty.
pub fn panel_full(title: &str, subtitle: &str, lines: &[String], width: usize) -> Vec<String> {
  panel_focused(title, subtitle, lines, width, false)
}

/// [`panel_full`], but when `focused` the frame glyphs are drawn in blue instead
/// of dim grey — the active-pane highlight (matching the prompt pane's focused
/// border). Captions are unchanged. Uses raw ANSI so it's tty-independent and
/// testable.
pub fn panel_focused(
  title: &str,
  subtitle: &str,
  lines: &[String],
  width: usize,
  focused: bool,
) -> Vec<String> {
  let mut out = Vec::with_capacity(lines.len() + 2);
  out.push(panel_top(title, subtitle, width, focused));
  for line in lines {
    out.push(panel_row(line, width, focused));
  }
  out.push(panel_bottom(width, focused));
  out
}

/// Resolve the frame-glyph styler: blue when `focused`, dim otherwise. Matches
/// the closure used inside every panel helper so they stay byte-identical.
fn frame_edge(focused: bool) -> impl Fn(&str) -> String {
  move |s: &str| {
    if focused {
      format!("{BLUE}{s}{RESET}")
    } else {
      Style::Dimmed.paint(s)
    }
  }
}

/// The opening rounded border of a panel, captioned by `title` (left) and an
/// optional right-aligned `subtitle`. The pane composes this with
/// [`panel_row`] + [`panel_bottom`] to interleave its own content.
pub fn panel_top(title: &str, subtitle: &str, width: usize, focused: bool) -> String {
  let width = width.max(4);
  let edge = frame_edge(focused);
  top_border(title, subtitle, width, &edge)
}

/// One framed content row: `│ <line, truncated + right-padded to width-4> │`.
/// ANSI-safe (the styler tracks display width, not byte length).
pub fn panel_row(line: &str, width: usize, focused: bool) -> String {
  let width = width.max(4);
  let inner = width - 4; // "│ " + content + " │"
  let edge = frame_edge(focused);
  let lhs = edge(&format!("{VERT} "));
  let rhs = edge(&format!(" {VERT}"));
  let body = pad_right(&truncate_ellipsis(line, inner, "…"), inner);
  format!("{lhs}{body}{rhs}")
}

/// The closing rounded border of a panel.
pub fn panel_bottom(width: usize, focused: bool) -> String {
  let width = width.max(4);
  let edge = frame_edge(focused);
  format!(
    "{}{}{}",
    edge(BOTTOM_LEFT),
    edge(&HORIZ.repeat(width.saturating_sub(2))),
    edge(BOTTOM_RIGHT),
  )
}

/// The top border, captioned by `title` (left) and `subtitle` (right). Captions
/// are kept plain (they read as captions); the frame glyphs are styled by `edge`
/// (dim when passive, blue when the pane is focused).
fn top_border(title: &str, subtitle: &str, width: usize, edge: &dyn Fn(&str) -> String) -> String {
  let (tl, tr) = (edge(TOP_LEFT), edge(TOP_RIGHT));
  match (title.is_empty(), subtitle.is_empty()) {
    // No captions: a plain rounded top.
    (true, true) => format!("{tl}{}{tr}", edge(&HORIZ.repeat(width.saturating_sub(2)))),
    // Title only: ╭─ title ─…─╮ (fixed glyphs around the title total 5).
    (false, true) => {
      let title = truncate_ellipsis(title, width.saturating_sub(5), "…");
      let dashes = width.saturating_sub(5 + visual_width(&title));
      format!(
        "{tl}{} {title} {}{tr}",
        edge(HORIZ),
        edge(&HORIZ.repeat(dashes))
      )
    }
    // Subtitle present: ╭─ title ─…─ subtitle ─╮ (fixed glyphs total 8).
    _ => {
      let subtitle = truncate_ellipsis(subtitle, width.saturating_sub(8), "…");
      let sw = visual_width(&subtitle);
      let title = truncate_ellipsis(title, width.saturating_sub(8 + sw), "…");
      let dashes = width.saturating_sub(8 + visual_width(&title) + sw);
      format!(
        "{tl}{} {title} {} {subtitle} {}{tr}",
        edge(HORIZ),
        edge(&HORIZ.repeat(dashes)),
        edge(HORIZ),
      )
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::width::{strip_ansi, visual_width};

  #[test]
  fn panel_frames_title_and_content_to_width() {
    let lines = vec!["hello".to_string(), "world".to_string()];
    let out = panel("node", &lines, 20);
    assert_eq!(out.len(), 4, "top + 2 content + bottom");
    // Every row is exactly `width` display columns (ANSI stripped).
    for row in &out {
      assert_eq!(visual_width(row), 20, "row padded to width: {row:?}");
    }
    let plain: Vec<String> = out.iter().map(|r| strip_ansi(r)).collect();
    assert!(
      plain[0].starts_with("╭─ node "),
      "title in top border: {:?}",
      plain[0]
    );
    assert!(plain[0].ends_with('╮'));
    assert_eq!(&plain[1], "│ hello            │");
    assert!(plain[3].starts_with('╰') && plain[3].ends_with('╯'));
  }

  #[test]
  fn panel_truncates_overlong_content_and_title() {
    let lines = vec!["a very long content line that overflows".to_string()];
    let out = panel("a-really-long-title", &lines, 16);
    for row in &out {
      assert_eq!(visual_width(row), 16, "still width-bounded: {row:?}");
    }
    assert!(strip_ansi(&out[1]).contains('…'), "content ellipsized");
  }

  #[test]
  fn panel_full_places_subtitle_on_the_right() {
    let lines = vec!["body".to_string()];
    let out = panel_full("builder-host", "ok", &lines, 40);
    for row in &out {
      assert_eq!(visual_width(row), 40, "row width: {row:?}");
    }
    let top = strip_ansi(&out[0]);
    assert!(top.starts_with("╭─ builder-host "), "left caption: {top:?}");
    assert!(
      top.ends_with(" ok ─╮"),
      "right caption before the corner: {top:?}"
    );
  }

  #[test]
  fn panel_empty_title_draws_a_plain_top() {
    let out = panel("", &["x".to_string()], 12);
    let top = strip_ansi(&out[0]);
    assert_eq!(top, "╭──────────╮", "plain rounded top: {top:?}");
    assert_eq!(visual_width(&out[0]), 12);
  }

  #[test]
  fn panel_focused_paints_the_border_blue() {
    let lines = vec!["x".to_string()];
    let focused = panel_focused("node", "", &lines, 20, true);
    let passive = panel_focused("node", "", &lines, 20, false);
    // Focused frame carries the blue SGR on every border row; passive does not.
    assert!(
      focused.iter().all(|r| r.contains(BLUE)),
      "blue border when focused: {focused:#?}"
    );
    assert!(
      passive.iter().all(|r| !r.contains(BLUE)),
      "no blue when passive: {passive:#?}"
    );
    // Highlight is color-only — the stripped layout is identical + width-stable.
    for (f, p) in focused.iter().zip(&passive) {
      assert_eq!(strip_ansi(f), strip_ansi(p));
      assert_eq!(visual_width(f), 20);
    }
  }
}
