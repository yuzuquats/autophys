//! Chrome may not be drawn from codepoints a stock system monospace font does
//! not carry.
//!
//! This is a width invariant, not a taste one. [`tento_term::visual_width`]
//! assumes the terminal advances a glyph by its Unicode-declared width; when
//! the font has no glyph, the OS substitutes one from another family — and on
//! macOS the substitute for `U+23FA` comes from Apple Color Emoji, which
//! advances TWO cells while `unicode-width` reports one. Every `pad_right` and
//! every rule computation after it on that row is then one column out, so a
//! missing glyph misaligns the frame rather than merely looking wrong. The
//! emoji substitute also paints in its own fixed colour and ignores SGR, so the
//! same codepoint breaks styling too.
//!
//! The banned set was measured against `/System/Library/Fonts/Menlo.ttc`'s
//! cmap — the default face of the terminal tsh must be correct in out of the
//! box — not guessed. Box drawing, block elements, geometric shapes, dingbats
//! and arrows are all present there and stay allowed.
//!
//! When the glyph tier lands, the tier tables become the single allowlisted
//! home for anything in this set and this test narrows to "outside the tables".

use std::path::{Path, PathBuf};

/// Codepoints absent from Menlo, each with the substitution to use instead.
/// Keep the reason column: the next person needs to know this was measured.
const BANNED: &[(char, &str)] = &[
  (
    '\u{23FA}',
    "record — use ● U+25CF (Menlo substitutes Apple Color Emoji, 2 cells)",
  ),
  (
    '\u{23F8}',
    "pause — use ▮ U+25AE (Apple Color Emoji, 2 cells)",
  ),
  (
    '\u{23F9}',
    "stop — use ■ U+25A0 (Apple Color Emoji, 2 cells)",
  ),
  (
    '\u{23F5}',
    "play — use ▶ U+25B6 (no substitute at all; renders as tofu)",
  ),
  (
    '\u{23BF}',
    "tool continuation — use └ U+2514 (Apple Symbols, proportional)",
  ),
  (
    '\u{27F3}',
    "cycle — use ↻ U+21BB (Apple Symbols, proportional)",
  ),
  (
    '\u{2637}',
    "trigram — use ≡ U+2261 (Apple Symbols, proportional)",
  ),
  (
    '\u{240D}',
    "carriage return — use ↵ U+21B5 (Apple Symbols, proportional)",
  ),
];

/// Whole ranges with no Menlo coverage at all.
const BANNED_RANGES: &[(char, char, &str)] = &[
  (
    '\u{2800}',
    '\u{28FF}',
    "Braille — 0 of 256 present in Menlo; use Block Elements (U+2580–U+259F)",
  ),
  (
    '\u{E000}',
    '\u{F8FF}',
    "private use area (Powerline/Nerd) — present only in patched fonts; \
     use ▐ U+2590 / ▌ U+258C for pill caps",
  ),
];

fn why(ch: char) -> Option<&'static str> {
  if let Some((_, reason)) = BANNED.iter().find(|(c, _)| *c == ch) {
    return Some(reason);
  }
  BANNED_RANGES
    .iter()
    .find(|(lo, hi, _)| ch >= *lo && ch <= *hi)
    .map(|(_, _, reason)| *reason)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in entries.flatten() {
    let path = entry.path();
    let name = entry.file_name();
    let name = name.to_string_lossy();
    // `target` is a symlink onto the build SSD; never descend it.
    if name.starts_with('.') || name == "target" || name == "node_modules" {
      continue;
    }
    if path.is_dir() {
      walk(&path, out);
    } else if matches!(
      path.extension().and_then(|e| e.to_str()),
      Some("rs" | "tsh" | "tshrc")
    ) {
      out.push(path);
    }
  }
}

#[test]
fn chrome_is_drawn_only_from_glyphs_a_stock_monospace_carries() {
  // tento-term is the bottom crate; the workspace it anchors is its parent.
  let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("tento-term sits inside the tento workspace")
    .to_path_buf();
  let mut files = Vec::new();
  walk(&root, &mut files);
  assert!(
    files.len() > 100,
    "the walk found only {} files under {} — it is not reaching the tree",
    files.len(),
    root.display()
  );

  let mut findings = Vec::new();
  for path in &files {
    let Ok(text) = std::fs::read_to_string(path) else {
      continue; // not UTF-8; nothing we can lint
    };
    if text.is_ascii() {
      continue; // the overwhelmingly common case, and free to skip
    }
    for (lineno, line) in text.lines().enumerate() {
      for ch in line.chars() {
        if let Some(reason) = why(ch) {
          findings.push(format!(
            "{}:{}: U+{:04X} {reason}",
            path.strip_prefix(&root).unwrap_or(path).display(),
            lineno + 1,
            ch as u32
          ));
        }
      }
    }
  }

  assert!(
    findings.is_empty(),
    "{} unrenderable glyph(s) in chrome. These are absent from Menlo, so the \
     OS substitutes a glyph of a DIFFERENT width and every column after it on \
     the row is misaligned:\n  {}",
    findings.len(),
    findings.join("\n  ")
  );
}

/// The classifier has teeth, and does not ban its own remedies. Without this
/// the walk above could pass because it flags nothing at all.
#[test]
fn the_banned_set_is_recognised_and_the_substitutes_are_not() {
  for (ch, _) in BANNED {
    assert!(why(*ch).is_some(), "U+{:04X} must be flagged", *ch as u32);
  }
  for ch in ['\u{2801}', '\u{28FF}', '\u{E0B0}', '\u{F8FF}'] {
    assert!(why(ch).is_some(), "U+{:04X} must be flagged", ch as u32);
  }
  // Every substitution the messages recommend, plus the chrome vocabulary the
  // census showed Menlo does carry.
  for ch in [
    '●', '▮', '■', '▶', '└', '↻', '≡', '↵', '▐', '▌', '─', '│', '╭', '╯', '█', '░', '▒', '▓', '▁',
    '▏', '✓', '✗', '✔', '◼', '◻', '▾', '▸', '❯', '○', '◐', '·', '…', '→', '✳', '✻',
  ] {
    assert!(
      why(ch).is_none(),
      "U+{:04X} is present in Menlo and must stay allowed",
      ch as u32
    );
  }
}
