//! Display-width measurement that is aware of ANSI SGR escapes (counted as
//! zero columns) and of double-width CJK / zero-width combining characters.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::ansi;

/// One scanned chunk of a string: an ANSI escape run (display width 0,
/// re-emitted verbatim) or a run of visible text with its display width.
pub(crate) enum Segment<'a> {
  Ansi(&'a str),
  Text { text: &'a str, width: usize },
}

/// Scan `s` into a sequence of [`Segment`]s.
pub(crate) fn segments(s: &str) -> Vec<Segment<'_>> {
  let bytes = s.as_bytes();
  let mut out: Vec<Segment<'_>> = Vec::new();
  let mut i = 0usize;
  let mut text_start = 0usize;
  while i < bytes.len() {
    if bytes[i] == 0x1b {
      if text_start < i {
        let t = &s[text_start..i];
        out.push(Segment::Text {
          text: t,
          width: UnicodeWidthStr::width(t),
        });
      }
      let start = i;
      i += 1; // past ESC
      if i < bytes.len() && bytes[i] == b'[' {
        // CSI: ESC '[' params/intermediates final-byte(0x40..=0x7e)
        i += 1;
        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
          i += 1;
        }
        if i < bytes.len() {
          i += 1; // consume the final byte
        }
      } else if i < bytes.len() {
        // lone `ESC X` — best-effort: consume one *character* (a multibyte
        // `X` must not be split, or the slice below lands off a char boundary)
        i += s[i..].chars().next().map_or(1, char::len_utf8);
      }
      out.push(Segment::Ansi(&s[start..i]));
      text_start = i;
    } else {
      i += 1;
    }
  }
  if text_start < bytes.len() {
    let t = &s[text_start..];
    out.push(Segment::Text {
      text: t,
      width: UnicodeWidthStr::width(t),
    });
  }
  out
}

/// Visible display width of `s`, ignoring ANSI escapes; double-width CJK count
/// as 2 columns, combining marks and control characters as 0.
pub fn visual_width(s: &str) -> usize {
  if !s.as_bytes().contains(&0x1b) {
    return UnicodeWidthStr::width(s);
  }
  segments(s)
    .iter()
    .map(|seg| match seg {
      Segment::Ansi(_) => 0,
      Segment::Text { width, .. } => *width,
    })
    .sum()
}

/// `s` with all ANSI escape sequences removed.
pub fn strip_ansi(s: &str) -> String {
  if !s.as_bytes().contains(&0x1b) {
    return s.to_string();
  }
  segments(s)
    .iter()
    .filter_map(|seg| match seg {
      Segment::Ansi(_) => None,
      Segment::Text { text, .. } => Some(*text),
    })
    .collect()
}

/// Take the leading `max_columns` display columns of `s`, preserving any ANSI
/// runs encountered (they are zero-width). Returns the substring plus whether
/// the substring left an SGR style "open" (last emitted escape wasn't a reset),
/// so callers can append [`ansi::RESET`].
pub(crate) fn take_columns(s: &str, max_columns: usize) -> (String, bool) {
  let mut out = String::new();
  let mut used = 0usize;
  let mut emitted_ansi = false;
  let mut last_open = false;
  'outer: for seg in segments(s) {
    match seg {
      Segment::Ansi(esc) => {
        out.push_str(esc);
        emitted_ansi = true;
        last_open = !ansi::is_reset(esc);
      }
      Segment::Text { text, .. } => {
        for g in text.graphemes(true) {
          let gw = UnicodeWidthStr::width(g);
          if used + gw > max_columns {
            break 'outer;
          }
          out.push_str(g);
          used += gw;
        }
      }
    }
  }
  (out, emitted_ansi && last_open)
}

/// Skip the leading `skip_columns` display columns of `s` but keep every ANSI
/// run along the way (so styles carry into the tail) and then keep the rest.
pub(crate) fn skip_columns(s: &str, skip_columns: usize) -> String {
  let mut out = String::new();
  let mut skipped = 0usize;
  let mut done_skipping = false;
  for seg in segments(s) {
    match seg {
      Segment::Ansi(esc) => out.push_str(esc),
      Segment::Text { text, .. } => {
        for g in text.graphemes(true) {
          if done_skipping {
            out.push_str(g);
            continue;
          }
          let gw = UnicodeWidthStr::width(g);
          if skipped + gw <= skip_columns {
            skipped += gw;
          } else {
            done_skipping = true;
            out.push_str(g);
          }
        }
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lone_esc_before_a_multibyte_char_does_not_split_it() {
    // fuzz finding F2: `ESC` + a 2-byte char sliced mid-codepoint and panicked.
    assert_eq!(visual_width("\u{1b}\u{301}ab"), 2);
    assert_eq!(visual_width("o\u{1b}é"), 1);
    assert_eq!(strip_ansi("o\u{1b}éx"), "ox");
    assert_eq!(visual_width("\u{1b}"), 0);
  }

  #[test]
  fn ansi_is_zero_width() {
    assert_eq!(visual_width("\u{1b}[31mabc\u{1b}[0m"), 3);
    assert_eq!(visual_width("\u{1b}[38;5;238m──\u{1b}[0m"), 2);
    assert_eq!(strip_ansi("\u{1b}[31mabc\u{1b}[0m"), "abc");
  }

  #[test]
  fn wide_and_combining() {
    assert_eq!(visual_width("日本語"), 6);
    assert_eq!(visual_width("a\u{0301}"), 1); // a + combining acute
    assert_eq!(visual_width("✓ ok"), 4); // status glyph is width 1
    assert_eq!(visual_width("├── └──"), 7);
  }

  #[test]
  fn take_columns_keeps_ansi_and_reports_open() {
    let (s, open) = take_columns("\u{1b}[32mabcdef\u{1b}[0m", 3);
    assert_eq!(s, "\u{1b}[32mabc");
    assert!(open);
    let (s, open) = take_columns("\u{1b}[32mab\u{1b}[0mcdef", 4);
    assert_eq!(s, "\u{1b}[32mab\u{1b}[0mcd");
    assert!(!open);
    let (s, open) = take_columns("plain", 2);
    assert_eq!(s, "pl");
    assert!(!open);
  }
}
