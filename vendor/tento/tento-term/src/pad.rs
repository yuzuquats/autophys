//! Visual-width-aware padding, truncation (with ellipsis), and word-wrap.
//!
//! All of these count *display columns* (so ANSI escapes are zero-width and
//! never split, and double-width CJK counts as two).

use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::ansi;
use crate::width::{Segment, segments, skip_columns, take_columns, visual_width};

/// Horizontal alignment within a fixed-width field.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
  #[default]
  Left,
  Right,
  Center,
}

/// Pad `s` to `width` display columns (no-op if already wide enough; never
/// truncates).
pub fn pad(s: &str, width: usize, align: Align) -> String {
  let vis = visual_width(s);
  if vis >= width {
    return s.to_string();
  }
  let total = width - vis;
  match align {
    Align::Left => format!("{s}{}", " ".repeat(total)),
    Align::Right => format!("{}{s}", " ".repeat(total)),
    Align::Center => {
      let l = total / 2;
      let r = total - l;
      format!("{}{s}{}", " ".repeat(l), " ".repeat(r))
    }
  }
}

/// Left-align `s` in a `width`-column field (pad on the right).
pub fn pad_right(s: &str, width: usize) -> String {
  pad(s, width, Align::Left)
}

/// Right-align `s` in a `width`-column field (pad on the left).
pub fn pad_left(s: &str, width: usize) -> String {
  pad(s, width, Align::Right)
}

/// Centre `s` in a `width`-column field; an odd extra column biases left.
pub fn pad_center(s: &str, width: usize) -> String {
  pad(s, width, Align::Center)
}

/// Truncate `s` to at most `max_width` display columns, appending `ellipsis`
/// (e.g. `"…"`) if anything was dropped. ANSI-safe: keeps any active style and
/// closes it with [`ansi::RESET`] after the ellipsis. If `max_width` is smaller
/// than the ellipsis width, returns the first `max_width` columns with no
/// ellipsis (degenerate; never panics).
pub fn truncate_ellipsis(s: &str, max_width: usize, ellipsis: &str) -> String {
  if visual_width(s) <= max_width {
    return s.to_string();
  }
  let ell_w = visual_width(ellipsis);
  if max_width < ell_w {
    let (out, opened) = take_columns(s, max_width);
    return if opened {
      format!("{out}{}", ansi::RESET)
    } else {
      out
    };
  }
  let (mut out, opened) = take_columns(s, max_width - ell_w);
  out.push_str(ellipsis);
  if opened {
    out.push_str(ansi::RESET);
  }
  out
}

/// Truncate `s` to `max_width` columns by removing the *middle*, keeping the
/// head and tail with `ellipsis` between (the head is one column longer on an
/// odd split). ANSI-safe.
pub fn truncate_middle(s: &str, max_width: usize, ellipsis: &str) -> String {
  let total = visual_width(s);
  if total <= max_width {
    return s.to_string();
  }
  let ell_w = visual_width(ellipsis);
  if max_width <= ell_w {
    let (out, opened) = take_columns(s, max_width);
    return if opened {
      format!("{out}{}", ansi::RESET)
    } else {
      out
    };
  }
  let keep = max_width - ell_w;
  let left = keep.div_ceil(2);
  let right = keep - left;
  let (mut out, head_open) = take_columns(s, left);
  if head_open {
    out.push_str(ansi::RESET);
  }
  out.push_str(ellipsis);
  out.push_str(&skip_columns(s, total - right));
  out
}

/// Hard-cut `s` to at most `max_width` columns, no ellipsis. ANSI-safe (closes
/// an open style).
pub fn truncate_clip(s: &str, max_width: usize) -> String {
  let (out, opened) = take_columns(s, max_width);
  if opened {
    format!("{out}{}", ansi::RESET)
  } else {
    out
  }
}

/// Walk `line` and update `prelude` to be the concatenation of every
/// non-reset SGR escape since the last reset. Used by the wrap helpers
/// to carry "currently open styling" from one output line to the next.
pub(crate) fn update_prelude(line: &str, prelude: &mut String) {
  for seg in segments(line) {
    if let Segment::Ansi(esc) = seg {
      if ansi::is_reset(esc) {
        prelude.clear();
      } else {
        prelude.push_str(esc);
      }
    }
  }
}

/// Close `cur` with [`ansi::RESET`] iff `prelude` is non-empty (the
/// caller has tracked styling state), push it, then seed `cur` with
/// `prelude` so the continuation line re-opens active styling.
///
/// **Caller responsibility**: keep `prelude` in sync with the escapes
/// already pushed into `cur` via [`update_prelude`]. This helper does
/// NOT re-scan `cur` — calling it after the caller has already
/// `update_prelude`-d the same escapes is correct and idempotent.
pub(crate) fn push_line_carrying_prelude(lines: &mut Vec<String>, cur: &mut String, prelude: &str) {
  if !prelude.is_empty() {
    cur.push_str(ansi::RESET);
  }
  lines.push(std::mem::take(cur));
  cur.push_str(prelude);
}

/// Greedily word-wrap `text` into lines of at most `width` display columns.
/// Whitespace runs collapse to a single space; a single token wider than
/// `width` is hard-broken at the column boundary (no ellipsis).
///
/// ANSI-preserving: each output line is **self-contained**. If styling
/// is active at a break point, the current line is closed with
/// [`ansi::RESET`] and the next line re-opens the active SGR run via a
/// re-emitted prelude, so the compositor's per-row paint (which can't
/// carry SGR state across rows) renders bold / colored content correctly
/// on every wrapped line. A reset embedded mid-text clears the
/// carry-forward. ANSI sequences ride along with whichever
/// whitespace-delimited token contains them and are never split.
pub fn wrap_to_width(text: &str, width: usize) -> Vec<String> {
  let width = width.max(1);
  let mut lines: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut cur_w = 0usize;
  let mut prelude = String::new();

  for word in text.split_whitespace() {
    let ww = visual_width(word);
    if ww > width {
      // Over-long token: flush cur, then hard-break the token,
      // preserving / re-emitting styling across the breaks.
      if cur_w > 0 {
        push_line_carrying_prelude(&mut lines, &mut cur, &prelude);
        cur_w = 0;
      }
      let mut rest: &str = word;
      while visual_width(rest) > width {
        let (chunk, _) = take_columns(rest, width);
        if chunk.is_empty() {
          // A single grapheme wider than `width`: emit it alone.
          let g = rest.graphemes(true).next().unwrap_or(rest);
          update_prelude(g, &mut prelude);
          cur.push_str(g);
          push_line_carrying_prelude(&mut lines, &mut cur, &prelude);
          rest = &rest[g.len()..];
        } else {
          let n = chunk.len();
          update_prelude(&chunk, &mut prelude);
          cur.push_str(&chunk);
          push_line_carrying_prelude(&mut lines, &mut cur, &prelude);
          rest = &rest[n..];
        }
      }
      if !rest.is_empty() {
        update_prelude(rest, &mut prelude);
        cur.push_str(rest);
        cur_w = visual_width(rest);
      }
    } else if cur_w == 0 {
      update_prelude(word, &mut prelude);
      cur.push_str(word);
      cur_w = ww;
    } else if cur_w + 1 + ww <= width {
      update_prelude(word, &mut prelude);
      cur.push(' ');
      cur.push_str(word);
      cur_w += 1 + ww;
    } else {
      push_line_carrying_prelude(&mut lines, &mut cur, &prelude);
      update_prelude(word, &mut prelude);
      cur.push_str(word);
      cur_w = ww;
    }
  }
  // Final line: include it even if empty (for an empty input).
  if cur_w > 0 || lines.is_empty() {
    // Close the trailing line if it left styling open, so the final
    // line is also self-contained.
    update_prelude(&cur, &mut prelude);
    if !prelude.is_empty() {
      cur.push_str(ansi::RESET);
    }
    lines.push(cur);
  } else if !cur.is_empty() {
    // `cur` carries only a prelude prefix (zero-width) — discard it.
    // No trailing empty line needed.
  }
  lines
}

/// Character-exact (visual-width) wrap that preserves the text verbatim
/// — no whitespace collapsing, no word boundaries. Breaks at the next
/// grapheme that would exceed `width` display columns.
///
/// ANSI-preserving: each returned line is **self-contained**. If
/// styling is active at a break point, the current line is closed
/// with [`ansi::RESET`] and the next line re-opens the active SGR
/// run, so the compositor's per-row paint (which can't carry SGR
/// state across rows) renders bold / colored content correctly on
/// every line. A reset embedded mid-text clears the carry-forward.
///
/// Companion to [`wrap_to_width`] (word-wrap). Reach for `wrap_exact`
/// when you need to preserve user-supplied text verbatim (composer
/// input, raw log lines, paste preview); reach for `wrap_to_width`
/// when natural-language reflow is desired.
///
/// `width == 0` is clamped to `1`. Always returns at least one
/// (possibly empty) line.
pub fn wrap_exact(s: &str, width: usize) -> Vec<String> {
  wrap_exact_hanging(s, width, width)
}

/// Exact-wrap with a distinct width for the first visual row.
///
/// Useful for hanging layouts where a prompt/prefix consumes space only on
/// row one. ANSI state and grapheme boundaries follow [`wrap_exact`].
pub fn wrap_exact_hanging(s: &str, first_width: usize, continuation_width: usize) -> Vec<String> {
  let mut width = first_width.max(1);
  let continuation_width = continuation_width.max(1);
  let mut lines: Vec<String> = Vec::new();
  let mut cur = String::new();
  let mut cur_w = 0usize;
  let mut prelude = String::new();

  for seg in segments(s) {
    match seg {
      Segment::Ansi(esc) => {
        cur.push_str(esc);
        if ansi::is_reset(esc) {
          prelude.clear();
        } else {
          prelude.push_str(esc);
        }
      }
      Segment::Text { text, .. } => {
        for g in text.graphemes(true) {
          let gw = UnicodeWidthStr::width(g).max(1);
          if cur_w + gw > width && cur_w > 0 {
            push_line_carrying_prelude(&mut lines, &mut cur, &prelude);
            cur_w = 0;
            width = continuation_width;
          }
          cur.push_str(g);
          cur_w += gw;
        }
      }
    }
  }
  // Close the trailing line if styling is open, so the final line is
  // also self-contained.
  update_prelude(&cur, &mut prelude);
  if cur_w > 0 && !prelude.is_empty() {
    cur.push_str(ansi::RESET);
  }
  lines.push(cur);
  lines
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn padding() {
    assert_eq!(pad_right("ab", 5), "ab   ");
    assert_eq!(pad_left("ab", 5), "   ab");
    assert_eq!(pad_center("x", 5), "  x  ");
    assert_eq!(pad_right("already wide", 5), "already wide");
  }

  #[test]
  fn ellipsis() {
    assert_eq!(truncate_ellipsis("abcdef", 4, "…"), "abc…");
    assert_eq!(truncate_ellipsis("abcdef", 4, "..."), "a...");
    assert_eq!(truncate_ellipsis("hi", 1, "…"), "…");
    assert_eq!(truncate_ellipsis("hi", 0, "…"), "");
    assert_eq!(truncate_ellipsis("abc", 5, "…"), "abc");
    assert_eq!(
      truncate_ellipsis("\u{1b}[32mgreen text\u{1b}[0m", 5, "…"),
      "\u{1b}[32mgree…\u{1b}[0m"
    );
  }

  #[test]
  fn middle() {
    assert_eq!(truncate_middle("abcdefgh", 5, "…"), "ab…gh");
    assert_eq!(
      truncate_middle("/very/long/path/to/file.rs", 12, "…"),
      "/very/…le.rs"
    );
    assert_eq!(truncate_middle("abc", 9, "…"), "abc");
  }

  #[test]
  fn wrap() {
    assert_eq!(
      wrap_to_width("api  responding in 12ms", 20),
      vec!["api responding in", "12ms"]
    );
    assert_eq!(
      wrap_to_width("cache miss rate 2.3%", 20),
      vec!["cache miss rate 2.3%"]
    );
    // hard-break an over-long token
    assert_eq!(
      wrap_to_width("supercalifragilistic", 7),
      vec!["superca", "lifragi", "listic"]
    );
  }

  #[test]
  fn wrap_exact_short_string_passes_through() {
    assert_eq!(wrap_exact("hello", 10), vec!["hello"]);
    assert_eq!(wrap_exact("", 10), vec![""]);
  }

  #[test]
  fn wrap_exact_breaks_at_visual_width_not_byte_count() {
    // 6-byte string, 6 cells; width 4 breaks at cell 4.
    assert_eq!(wrap_exact("abcdef", 4), vec!["abcd", "ef"]);
    // Whitespace is not collapsed (unlike wrap_to_width).
    assert_eq!(wrap_exact("a  b", 2), vec!["a ", " b"]);
  }

  #[test]
  fn wrap_exact_handles_double_width_grapheme_on_width_one() {
    // CJK char (display width 2) at width 1: emit it alone on its own line.
    assert_eq!(wrap_exact("日a", 1), vec!["日", "a"]);
  }

  #[test]
  fn wrap_exact_preserves_bold_across_break() {
    // The bug this primitive exists to fix: bold opens, line wraps,
    // continuation line MUST re-emit the bold opener and the first
    // line MUST close with a reset (self-contained per-row paint).
    const BOLD: &str = "\u{1b}[1m";
    const RESET: &str = "\u{1b}[0m";
    let input = format!("{BOLD}hello world{RESET}");
    let out = wrap_exact(&input, 5);
    assert_eq!(out.len(), 3, "11 cells / width 5 = 3 lines, got {out:?}");
    // Line 1: opens with BOLD, closes with RESET.
    assert!(out[0].starts_with(BOLD), "line 1 starts bold: {:?}", out[0]);
    assert!(out[0].ends_with(RESET), "line 1 closes reset: {:?}", out[0]);
    // Line 2 (mid): re-opens BOLD at the start, closes with RESET.
    assert!(
      out[1].starts_with(BOLD),
      "line 2 re-opens bold: {:?}",
      out[1]
    );
    assert!(out[1].ends_with(RESET), "line 2 closes reset: {:?}", out[1]);
    // Line 3 (tail): re-opens BOLD; the input's own RESET supplies the close.
    assert!(
      out[2].starts_with(BOLD),
      "line 3 re-opens bold: {:?}",
      out[2]
    );
    assert!(
      out[2].contains(RESET),
      "line 3 carries the input reset: {:?}",
      out[2]
    );
  }

  #[test]
  fn wrap_exact_clears_prelude_on_reset() {
    // A mid-text reset means subsequent breaks should NOT re-emit the
    // earlier styling.
    const BOLD: &str = "\u{1b}[1m";
    const RESET: &str = "\u{1b}[0m";
    let input = format!("{BOLD}ab{RESET}cdef");
    let out = wrap_exact(&input, 2);
    // Cells: a b c d e f → width 2 → ["ab", "cd", "ef"].
    assert_eq!(out.len(), 3, "got {out:?}");
    // Line 1: has the BOLD open and the RESET close (from input).
    assert!(out[0].contains(BOLD));
    assert!(out[0].ends_with(RESET));
    // Lines 2 and 3 must NOT contain BOLD — the reset cleared the prelude.
    assert!(
      !out[1].contains(BOLD),
      "line 2 must not re-bold: {:?}",
      out[1]
    );
    assert!(
      !out[2].contains(BOLD),
      "line 3 must not re-bold: {:?}",
      out[2]
    );
  }

  #[test]
  fn wrap_exact_width_zero_clamps_to_one() {
    // Width 0 is degenerate — clamp to 1 so progress is guaranteed.
    assert_eq!(wrap_exact("abc", 0), vec!["a", "b", "c"]);
  }

  #[test]
  fn wrap_exact_hanging_uses_the_full_continuation_width() {
    assert_eq!(
      wrap_exact_hanging("abcdefghijkl", 4, 8),
      vec!["abcd", "efghijkl"]
    );
  }

  #[test]
  fn wrap_exact_combining_grapheme_stays_with_base() {
    // "a + combining acute" is one grapheme of display width 1; it
    // must not split between the base and the combining mark.
    let s = "a\u{0301}bc";
    let out = wrap_exact(s, 1);
    assert_eq!(out, vec!["a\u{0301}", "b", "c"]);
  }

  // ---- wrap_to_width ANSI-preservation ----

  #[test]
  fn wrap_to_width_preserves_bold_across_wrap() {
    // "bold word1 word2 word3" with width 5: words wrap onto multiple
    // lines and each line must carry the bold opener (because the
    // closing reset is at the end of the input, after the wraps).
    const BOLD: &str = "\u{1b}[1m";
    const RESET: &str = "\u{1b}[0m";
    let input = format!("{BOLD}initialize.local: 2026-05-25 01:43:23.509{RESET}");
    let out = wrap_to_width(&input, 20);
    assert!(out.len() >= 2, "expected at least two lines, got {out:?}");
    for (i, line) in out.iter().enumerate() {
      assert!(
        line.contains(BOLD),
        "line {i} should carry the active bold opener: {line:?}"
      );
      assert!(
        line.contains(RESET),
        "line {i} should close styling so it's self-contained: {line:?}"
      );
    }
  }

  #[test]
  fn wrap_to_width_reset_mid_text_clears_carry_forward() {
    // Same shape as wrap_exact: a reset mid-text means subsequent
    // wraps don't re-open the prior style.
    const RED: &str = "\u{1b}[31m";
    const RESET: &str = "\u{1b}[0m";
    let input = format!("{RED}red{RESET} word1 word2 word3 word4");
    let out = wrap_to_width(&input, 8);
    // First line carries red + closes it; later lines must not contain RED.
    assert!(
      out[0].contains(RED),
      "line 0 has the red opener: {:?}",
      out[0]
    );
    assert!(out[0].contains(RESET), "line 0 closes red: {:?}", out[0]);
    for (i, line) in out.iter().enumerate().skip(1) {
      assert!(
        !line.contains(RED),
        "line {i} must not re-open red after mid-text reset: {line:?}"
      );
    }
  }

  #[test]
  fn wrap_to_width_plain_input_unchanged() {
    // Sanity: BC for plain inputs — the original behavior of word-wrap
    // + whitespace collapse + hard-break long tokens must survive.
    assert_eq!(
      wrap_to_width("api  responding in 12ms", 20),
      vec!["api responding in", "12ms"]
    );
    assert_eq!(
      wrap_to_width("cache miss rate 2.3%", 20),
      vec!["cache miss rate 2.3%"]
    );
    assert_eq!(
      wrap_to_width("supercalifragilistic", 7),
      vec!["superca", "lifragi", "listic"]
    );
  }

  #[test]
  fn wrap_to_width_hard_break_of_styled_long_token() {
    // An over-long single token that's also styled: hard-break must
    // re-emit the active styling on each piece.
    const BOLD: &str = "\u{1b}[1m";
    const RESET: &str = "\u{1b}[0m";
    let input = format!("{BOLD}supercalifragilistic{RESET}");
    let out = wrap_to_width(&input, 7);
    // 20 visible chars / 7 width → 3 pieces.
    assert_eq!(out.len(), 3, "got {out:?}");
    for (i, line) in out.iter().enumerate() {
      assert!(
        line.contains(BOLD),
        "piece {i} should carry the bold opener: {line:?}"
      );
    }
  }
}
