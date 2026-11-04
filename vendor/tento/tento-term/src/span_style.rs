//! The style vocabulary every surface that paints cells shares.
//!
//! This lives in `tento-term`, below `tento-shapes`, for a structural reason:
//! the crates depend one way, so anything in `tento-term` — the column and
//! table painters among them — cannot see a type defined above it. That is why
//! two style types existed. [`crate::Style`], an eleven-variant enum, is what
//! the lower layer could reach; `SpanStyle` is what everything above it uses.
//! Only one of them can say **dim on a specific colour**.
//!
//! Two spellings, both accepted wherever a style is taken:
//!
//! ```text
//! "dim"                      // terse tokens, for authoring by hand
//! "bold fg:#9ece6a bg:red"
//! {"fg": "#9ece6a", "bold": true}   // structured, for generated values
//! ```
//!
//! Tokens split on whitespace, `,` or `|`; a bare colour is a foreground, so
//! `"red"` and `"fg:red"` mean the same thing. Behind an explicit `fg:` / `bg:`
//! ANY name is accepted, so a theme palette entry can be written where a colour
//! goes and substituted later — a bare token still has to be a colour the
//! renderer recognizes, or a misspelled attribute would silently become one.
//!
//! **Unknown tokens are dropped, never an error.** A style is presentation: a
//! typo must cost the styling it names and nothing else.

use serde::{Deserialize, Serialize};

/// A span's full style: colours plus every SGR attribute a terminal carries.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct SpanStyle {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub fg: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub bg: Option<String>,
  #[serde(default, skip_serializing_if = "is_false")]
  pub bold: bool,
  #[serde(default, skip_serializing_if = "is_false")]
  pub dim: bool,
  #[serde(default, skip_serializing_if = "is_false")]
  pub italic: bool,
  #[serde(default, skip_serializing_if = "is_false")]
  pub underline: bool,
  #[serde(default, skip_serializing_if = "is_false")]
  pub strike: bool,
  #[serde(default, skip_serializing_if = "is_false")]
  pub reverse: bool,
}

/// Serialize only what was ASKED for. A span value carries `{"fg": …}` and not
/// `{"fg": …, "bold": false, "dim": false, …}`, so a style that round-trips
/// through JSON comes back byte-identical to one written by hand.
fn is_false(flag: &bool) -> bool {
  !*flag
}

/// Parse the terse spelling: `"bold dim fg:#9ece6a bg:index:238"`.
pub fn style_from_tokens(spec: &str) -> SpanStyle {
  let mut style = SpanStyle::default();
  for token in spec.split([' ', '\t', '\n', '\r', ',', '|']) {
    if token.is_empty() {
      continue;
    }
    let token = token.to_ascii_lowercase();
    match token.as_str() {
      "bold" => style.bold = true,
      "dim" => style.dim = true,
      "italic" => style.italic = true,
      "underline" => style.underline = true,
      "strike" => style.strike = true,
      "reverse" => style.reverse = true,
      // A PREFIXED colour is taken at its word: `fg:` / `bg:` is the author
      // saying "this is a colour", so the name may be a palette entry that only
      // a theme can resolve. Validation happens at paint, where an unresolvable
      // name costs its colour and nothing else.
      //
      // A BARE token still has to be recognizable, because a bare token is
      // ambiguous with a misspelled attribute — accepting anything would turn
      // `"bolt"` into a foreground named "bolt" instead of dropping it.
      _ => match token.strip_prefix("bg:") {
        Some(color) => style.bg = Some(color.to_string()),
        None => match token.strip_prefix("fg:") {
          Some(color) => style.fg = Some(color.to_string()),
          None => {
            if color_sgr(&token, false).is_some() {
              style.fg = Some(token.clone());
            }
          }
        },
      },
    }
  }
  style
}

/// Wrap `text` in `style`'s SGR codes.
///
/// `force_color` is appropriate inside an alternate-screen TUI, whose output is
/// known to be a terminal even when process-level tty detection is hidden;
/// otherwise the ambient gate decides, exactly as [`crate::Style::paint`] does.
pub fn paint_with_color(text: &str, style: &SpanStyle, force_color: bool) -> String {
  if text.is_empty()
    || *style == SpanStyle::default()
    || (!force_color && !colored::control::SHOULD_COLORIZE.should_colorize())
  {
    return text.to_string();
  }
  format!("\u{1b}[{}m{text}\u{1b}[0m", style_sgr(style).join(";"))
}

/// The SGR parameters `style` opens with, without the escape wrapper — what a
/// caller needs when it is building its own opener (the animation pre-painter
/// splices frames into an already-open run).
pub fn style_sgr(style: &SpanStyle) -> Vec<String> {
  let mut codes = Vec::new();
  if style.bold {
    codes.push("1".to_string());
  }
  if style.dim {
    codes.push("2".to_string());
  }
  if style.italic {
    codes.push("3".to_string());
  }
  if style.underline {
    codes.push("4".to_string());
  }
  if style.reverse {
    codes.push("7".to_string());
  }
  if style.strike {
    codes.push("9".to_string());
  }
  if let Some(color) = style
    .fg
    .as_deref()
    .and_then(|value| color_sgr(value, false))
  {
    codes.push(color);
  }
  if let Some(color) = style.bg.as_deref().and_then(|value| color_sgr(value, true)) {
    codes.push(color);
  }
  codes
}

/// A colour name, `index:N`, `#rrggbb`, **or a theme role**, to its SGR
/// parameter.
///
/// The role case is last, and deliberately so. The sixteen names, `default`,
/// `index:N` and `#rrggbb` are matched first, so a theme cannot capture `red`
/// by binding a role called `red` — and because an unresolvable name has always
/// returned `None` (no colour), reading one as a role can only turn *nothing*
/// into *something*. Nothing that worked before changes.
///
/// Why it matters: without this, a role written where a colour goes —
/// `:fg "text.primary"`, `fg:status.ok` in a preset — parses fine, resolves to
/// nothing, and paints unstyled with no diagnostic. That is the failure mode
/// the theme docs already record for palette names, and it is the reason the
/// shipped presets carry three hundred hex literals instead of role names.
/// A role reaching every site a colour reaches is what makes the indirection
/// usable rather than merely present.
pub fn color_sgr(value: &str, background: bool) -> Option<String> {
  color_sgr_depth(value, background, 0)
}

/// How far a role may point at another role before we stop.
///
/// One hop is the useful case (`"status.ok"` → `"fg:green"`); a chain past that
/// is a theme bug, and a cycle would otherwise recurse until the stack ran out.
/// Stopping returns `None`, which paints unstyled — degrade, never fault.
const ROLE_HOPS: u8 = 4;

fn color_sgr_depth(value: &str, background: bool, hops: u8) -> Option<String> {
  let base = if background { 40 } else { 30 };
  let bright_base = if background { 100 } else { 90 };
  let indexed_prefix = if background { 48 } else { 38 };
  let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
  let named = match normalized.as_str() {
    "default" => return Some(if background { "49" } else { "39" }.to_string()),
    "black" => 0,
    "red" => 1,
    "green" => 2,
    "yellow" => 3,
    "blue" => 4,
    "magenta" => 5,
    "cyan" => 6,
    "white" => 7,
    "bright-black" | "gray" | "grey" => return Some(bright_base.to_string()),
    "bright-red" => return Some((bright_base + 1).to_string()),
    "bright-green" => return Some((bright_base + 2).to_string()),
    "bright-yellow" => return Some((bright_base + 3).to_string()),
    "bright-blue" => return Some((bright_base + 4).to_string()),
    "bright-magenta" => return Some((bright_base + 5).to_string()),
    "bright-cyan" => return Some((bright_base + 6).to_string()),
    "bright-white" => return Some((bright_base + 7).to_string()),
    _ => usize::MAX,
  };
  if named != usize::MAX {
    return Some((base + named).to_string());
  }
  if let Some(index) = normalized.strip_prefix("index:") {
    return index
      .parse::<u8>()
      .ok()
      .map(|index| format!("{indexed_prefix};5;{index}"));
  }
  if !normalized.starts_with('#') {
    // Not a literal in any spelling this function knows. Before giving up, ask
    // the ambient theme whether it is a role. `any_roles_bound` makes the
    // unthemed case — every test, every CLI run — a single relaxed load.
    if hops < ROLE_HOPS && crate::role::any_roles_bound() {
      let style = crate::role::resolve(&normalized)?;
      let color = if background { style.bg } else { style.fg }?;
      return color_sgr_depth(&color, background, hops + 1);
    }
    return None;
  }
  let hex = normalized.strip_prefix('#')?;
  // Validate ASCII before taking byte slices: six UTF-8 bytes need not
  // contain six characters or have a character boundary at offsets 2 and 4.
  if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return None;
  }
  let red = u8::from_str_radix(&hex[0..2], 16).ok()?;
  let green = u8::from_str_radix(&hex[2..4], 16).ok()?;
  let blue = u8::from_str_radix(&hex[4..6], 16).ok()?;
  Some(format!("{indexed_prefix};2;{red};{green};{blue}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hex_colors_reject_invalid_utf8_boundary_and_non_hex_values() {
    // Each Unicode spelling has six bytes; the old parser panicked on the
    // first or second two-byte slice before it could reject the colour.
    for value in [
      "#aébbb", "#abcéa", "#１２", "#gg0000", "#00gg00", "#0000gg", "#12345", "#1234567",
    ] {
      for background in [false, true] {
        assert_eq!(color_sgr(value, background), None, "{value:?}");
      }
    }
  }

  #[test]
  fn valid_hex_colors_preserve_foreground_and_background_parameters() {
    for (value, rgb) in [
      ("#000000", "0;0;0"),
      ("#ffffff", "255;255;255"),
      (" #A1B2C3 ", "161;178;195"),
    ] {
      assert_eq!(color_sgr(value, false), Some(format!("38;2;{rgb}")));
      assert_eq!(color_sgr(value, true), Some(format!("48;2;{rgb}")));
    }
  }

  #[test]
  fn invalid_unicode_hex_in_a_role_loses_only_its_color() {
    let mut roles = crate::RoleTable::new();
    roles.bind("test.unicode", "fg:#aébbb bg:#abcéa bold");
    crate::with_roles(roles, || {
      assert_eq!(color_sgr("test.unicode", false), None);
      assert_eq!(color_sgr("test.unicode", true), None);
      let style = crate::resolve_role("test.unicode").expect("role");
      assert_eq!(paint_with_color("safe", &style, true), "\x1b[1msafe\x1b[0m");
    });
  }
}
