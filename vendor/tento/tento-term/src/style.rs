//! Styled cells: a small `Style` enum (delegating to ANSI SGR codes, gated by
//! `colored::control`) and a `Cell` that table/tree cells are built from.

use std::borrow::Cow;

use serde::de::Deserializer;
use serde::{Deserialize, Serialize};

use crate::ansi;
use crate::pad::{Align, truncate_clip, truncate_ellipsis, truncate_middle};
use crate::width::{strip_ansi, visual_width};

/// A terminal style applied to a piece of text. `None` is unstyled.
///
/// Every variant carries a **role** ([`Style::role_name`]): the eleven legacy
/// ones report `ansi.red`, `ansi.gray`, … and [`Style::Role`] carries its own.
/// Painting goes through [`crate::role`], so a theme can restyle any of them —
/// but with no table installed a role resolves to nothing and the legacy SGR
/// constant is used, which is byte-for-byte the output this type has always
/// produced. See the `role` module docs for why the table is ambient.
///
/// `Copy` is deliberate and load-bearing: 373 sites construct a `Style` and 64
/// signatures take one by value. Hence `Role(&'static str)` over an owned
/// string, and hence [`crate::role::intern`] for names that arrive at runtime.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Style {
  #[default]
  None,
  Red,
  Green,
  Yellow,
  Blue,
  Magenta,
  Cyan,
  White,
  Gray,
  Dimmed,
  Bold,
  /// A semantic role, resolved through the ambient theme at paint time. An
  /// unbound role paints nothing — absent, not an error.
  Role(&'static str),
}

/// The wire spelling of each legacy variant, paired with its compatibility
/// role. One table, so serde and [`Style::role_name`] cannot drift apart.
const LEGACY: &[(Style, &str, &str)] = &[
  (Style::None, "none", ""),
  (Style::Red, "red", "ansi.red"),
  (Style::Green, "green", "ansi.green"),
  (Style::Yellow, "yellow", "ansi.yellow"),
  (Style::Blue, "blue", "ansi.blue"),
  (Style::Magenta, "magenta", "ansi.magenta"),
  (Style::Cyan, "cyan", "ansi.cyan"),
  (Style::White, "white", "ansi.white"),
  (Style::Gray, "gray", "ansi.gray"),
  (Style::Dimmed, "dimmed", "ansi.dimmed"),
  (Style::Bold, "bold", "ansi.bold"),
];

impl Style {
  /// A role by name, interned. Returns [`Style::None`] for a name that is not
  /// role-shaped or when the intern table is full — presentation degrades, it
  /// does not fault.
  pub fn role(name: &str) -> Style {
    crate::role::intern(name).map_or(Style::None, Style::Role)
  }

  /// The role this style resolves through (`""` for [`Style::None`]).
  pub fn role_name(self) -> &'static str {
    match self {
      Style::Role(name) => name,
      other => LEGACY
        .iter()
        .find(|(style, _, _)| *style == other)
        .map(|(_, _, role)| *role)
        .unwrap_or(""),
    }
  }

  /// The wire spelling — what this style serializes as, and the keyword a
  /// preset writes. Single source of truth: `Serialize`, `from_wire` and
  /// `tento_tui_panes::router::style_kw` all read this one table.
  pub fn wire_name(self) -> &'static str {
    match self {
      Style::Role(name) => name,
      other => LEGACY
        .iter()
        .find(|(style, _, _)| *style == other)
        .map(|(_, wire, _)| *wire)
        .unwrap_or("none"),
    }
  }

  /// The SGR constant this style falls back to when its role is unbound.
  fn builtin_code(self) -> &'static str {
    match self {
      Style::None => ansi::EMPTY,
      Style::Red => ansi::RED,
      Style::Green => ansi::GREEN,
      Style::Yellow => ansi::YELLOW,
      Style::Blue => ansi::BLUE,
      Style::Magenta => ansi::MAGENTA,
      Style::Cyan => ansi::CYAN,
      Style::White => ansi::WHITE,
      Style::Gray => ansi::GRAY,
      Style::Dimmed => ansi::DIMMED,
      Style::Bold => ansi::BOLD,
      // A role names a meaning, not a colour. With nothing bound there is no
      // colour to guess at, so it paints as unstyled.
      Style::Role(_) => ansi::EMPTY,
    }
  }

  /// The opening SGR escape for this style (`""` for `None` and for an unbound
  /// role), taking the ambient theme into account.
  pub fn code(self) -> Cow<'static, str> {
    // The unthemed path — the CLI, every test, any process that never installs
    // a theme — is one relaxed atomic load and then exactly the match this
    // method has always been.
    if !crate::role::any_roles_bound() {
      return Cow::Borrowed(self.builtin_code());
    }
    if let Some(style) = crate::role::resolve(self.role_name()) {
      let codes = crate::span_style::style_sgr(&style);
      // A role bound to an empty style is "explicitly plain", not a reset:
      // emitting `\x1b[m` here would clear whatever run the caller had open.
      if !codes.is_empty() {
        return Cow::Owned(format!("\u{1b}[{}m", codes.join(";")));
      }
      return Cow::Borrowed(ansi::EMPTY);
    }
    Cow::Borrowed(self.builtin_code())
  }

  /// Wrap `s` in this style's SGR codes — but only if colour output is enabled
  /// (`colored::control`) and the style actually paints something. Otherwise
  /// returns `s`.
  pub fn paint(self, s: &str) -> String {
    if self == Style::None || !colored::control::SHOULD_COLORIZE.should_colorize() {
      return s.to_string();
    }
    let code = self.code();
    if code.is_empty() {
      // An unbound role. Without this the `RESET` below would still be emitted
      // and would close a run the caller opened around us.
      return s.to_string();
    }
    format!("{code}{s}{}", ansi::RESET)
  }

  /// Resolve a per-cell style against a fallback (a column / header default):
  /// `None` falls back, anything else wins.
  pub fn or(self, fallback: Style) -> Style {
    if self == Style::None { fallback } else { self }
  }
}

// --- Style serde: the wire format is a plain string, exactly as before -------
//
// Hand-written rather than derived because the derive would spell `Role` as
// `{"role": "..."}` and cannot deserialize into a `&'static str`. The eleven
// legacy names round-trip byte-identically, which is what keeps every scene
// `.tsh` and every stored JSON shape reading the same after this landed.
//
// A role serializes as its bare dotted name. There is no ambiguity with the
// legacy names because those are undotted and a role name that collides with
// one deserializes to that variant — which is the same thing, since the variant
// reports the matching `ansi.*` role.

impl Serialize for Style {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    serializer.serialize_str(self.wire_name())
  }
}

impl<'de> Deserialize<'de> for Style {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    let name = String::deserialize(deserializer)?;
    Ok(Style::from_wire(&name))
  }
}

impl Style {
  /// Parse the wire spelling: a legacy name, else a role, else `None`.
  ///
  /// Unknown names degrade to unstyled rather than erroring, the same rule
  /// `style_from_tokens` follows — a style is presentation, and a typo must
  /// cost the styling it names and nothing else.
  pub fn from_wire(name: &str) -> Style {
    let normalized = name.trim().to_ascii_lowercase();
    if let Some((style, _, _)) = LEGACY.iter().find(|(_, wire, _)| *wire == normalized) {
      return *style;
    }
    Style::role(&normalized)
  }
}

/// How a cell's content is handled when it is wider than its field.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Overflow {
  /// Drop the tail, append `…`.
  #[default]
  TruncateEnd,
  /// Drop the middle, keep head + tail with `…` between.
  TruncateMiddle,
  /// Hard cut, no ellipsis.
  Clip,
  /// Wrap onto continuation lines. Not yet implemented for table cells —
  /// currently treated as `TruncateEnd`.
  Wrap,
}

/// A renderable cell of text.
#[derive(Clone, Debug)]
pub enum Cell {
  /// Text to be styled with `style` at render time (a column/header default
  /// applies when `style` is `None`). A bare JSON string deserialises here
  /// with `style = None`.
  Styled { text: String, style: Style },
  /// A pre-rendered string that may already contain ANSI escapes; rendered
  /// verbatim (no default style applied), width measured visibly. Deserialises
  /// from `{ "raw": "..." }`.
  Raw(String),
}

impl Default for Cell {
  fn default() -> Self {
    Cell::Styled {
      text: String::new(),
      style: Style::None,
    }
  }
}

impl Cell {
  /// Plain text, no style.
  pub fn plain(s: impl Into<String>) -> Self {
    Cell::Styled {
      text: s.into(),
      style: Style::None,
    }
  }
  /// Text with an explicit style.
  pub fn new(s: impl Into<String>, style: Style) -> Self {
    Cell::Styled {
      text: s.into(),
      style,
    }
  }
  /// A pre-rendered (possibly ANSI-laden) string.
  pub fn raw(s: impl Into<String>) -> Self {
    Cell::Raw(s.into())
  }
  /// An empty cell.
  pub fn empty() -> Self {
    Cell::default()
  }

  /// The visible (ANSI-stripped) text of this cell.
  pub fn plain_text(&self) -> Cow<'_, str> {
    match self {
      Cell::Styled { text, .. } => Cow::Borrowed(text),
      Cell::Raw(s) => {
        if s.as_bytes().contains(&0x1b) {
          Cow::Owned(strip_ansi(s))
        } else {
          Cow::Borrowed(s)
        }
      }
    }
  }

  /// The cell's display width (columns), ANSI-aware.
  pub fn width(&self) -> usize {
    match self {
      Cell::Styled { text, .. } => visual_width(text),
      Cell::Raw(s) => visual_width(s),
    }
  }

  /// Render the cell's content (applying `default_style` if it's a `Styled`
  /// cell with no explicit style), truncating to at most `max_width` columns
  /// per `overflow`. Does **not** pad.
  pub fn render_fit(&self, max_width: usize, overflow: Overflow, default_style: Style) -> String {
    let content = match self {
      Cell::Raw(s) => s.clone(),
      Cell::Styled { text, style } => style.or(default_style).paint(text),
    };
    if visual_width(&content) <= max_width {
      return content;
    }
    match overflow {
      Overflow::TruncateEnd | Overflow::Wrap => truncate_ellipsis(&content, max_width, "…"),
      Overflow::TruncateMiddle => truncate_middle(&content, max_width, "…"),
      Overflow::Clip => truncate_clip(&content, max_width),
    }
  }

  /// `render_fit`, then pad to exactly `width` columns with `align`.
  pub fn render_field(
    &self,
    width: usize,
    align: Align,
    overflow: Overflow,
    default_style: Style,
  ) -> String {
    let content = self.render_fit(width, overflow, default_style);
    let vis = visual_width(&content);
    if vis >= width {
      return content;
    }
    let pad = width - vis;
    match align {
      Align::Left => format!("{content}{}", " ".repeat(pad)),
      Align::Right => format!("{}{content}", " ".repeat(pad)),
      Align::Center => {
        let l = pad / 2;
        let r = pad - l;
        format!("{}{content}{}", " ".repeat(l), " ".repeat(r))
      }
    }
  }
}

impl From<&str> for Cell {
  fn from(s: &str) -> Self {
    Cell::plain(s)
  }
}
impl From<String> for Cell {
  fn from(s: String) -> Self {
    Cell::Styled {
      text: s,
      style: Style::None,
    }
  }
}

// --- Deserialize: a bare string, `{text, style}`, or `{raw}` ----------------

impl<'de> Deserialize<'de> for Cell {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
      Plain(String),
      Styled {
        text: String,
        #[serde(default)]
        style: Style,
      },
      Raw {
        raw: String,
      },
    }
    Ok(match Repr::deserialize(deserializer)? {
      Repr::Plain(text) => Cell::Styled {
        text,
        style: Style::None,
      },
      Repr::Styled { text, style } => Cell::Styled { text, style },
      Repr::Raw { raw } => Cell::Raw(raw),
    })
  }
}

// --- Serialize: mirror of the Deserialize forms ----------------------------
// Unstyled `Styled` → a bare string; styled → `{text, style}`; `Raw` → `{raw}`.
// So a serialized `Cell` round-trips through the untagged `Deserialize` above.
impl Serialize for Cell {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    use serde::ser::SerializeStruct;
    match self {
      Cell::Styled { text, style } if *style == Style::None => serializer.serialize_str(text),
      Cell::Styled { text, style } => {
        let mut st = serializer.serialize_struct("Cell", 2)?;
        st.serialize_field("text", text)?;
        st.serialize_field("style", style)?;
        st.end()
      }
      Cell::Raw(s) => {
        let mut st = serializer.serialize_struct("Cell", 1)?;
        st.serialize_field("raw", s)?;
        st.end()
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fit_and_pad() {
    let c = Cell::plain("hello world");
    assert_eq!(
      c.render_field(5, Align::Left, Overflow::TruncateEnd, Style::None),
      "hell…"
    );
    assert_eq!(
      c.render_field(13, Align::Left, Overflow::TruncateEnd, Style::None),
      "hello world  "
    );
    assert_eq!(
      c.render_field(13, Align::Right, Overflow::TruncateEnd, Style::None),
      "  hello world"
    );
  }

  #[test]
  fn every_legacy_variant_reports_a_role_and_it_is_bound_in_the_compat_table() {
    let table = crate::role::RoleTable::ansi_defaults();
    for style in [
      Style::Red,
      Style::Green,
      Style::Yellow,
      Style::Blue,
      Style::Magenta,
      Style::Cyan,
      Style::White,
      Style::Gray,
      Style::Dimmed,
      Style::Bold,
    ] {
      let role = style.role_name();
      assert!(role.starts_with("ansi."), "{style:?} reports {role:?}");
      assert!(
        table.get(role).is_some(),
        "{role} must be bound in the compat table"
      );
    }
    assert_eq!(Style::None.role_name(), "", "unstyled names no role");
  }

  #[test]
  fn the_wire_format_is_unchanged_and_roles_round_trip() {
    for (style, wire) in [
      (Style::None, "\"none\""),
      (Style::Red, "\"red\""),
      (Style::Gray, "\"gray\""),
      (Style::Dimmed, "\"dimmed\""),
      (Style::Bold, "\"bold\""),
    ] {
      assert_eq!(serde_json::to_string(&style).unwrap(), wire);
      assert_eq!(serde_json::from_str::<Style>(wire).unwrap(), style);
    }
    let role = Style::role("status.ok");
    assert_eq!(serde_json::to_string(&role).unwrap(), "\"status.ok\"");
    assert_eq!(
      serde_json::from_str::<Style>("\"status.ok\"").unwrap(),
      role
    );
    // Degrade, never fault — the same rule `style_from_tokens` follows.
    assert_eq!(
      serde_json::from_str::<Style>("\"NONSENSE!\"").unwrap(),
      Style::None
    );
  }

  #[test]
  fn deserialize_forms() {
    let c: Cell = serde_json::from_str(r#""running""#).unwrap();
    assert!(matches!(
      c,
      Cell::Styled {
        style: Style::None,
        ..
      }
    ));
    let c: Cell = serde_json::from_str(r#"{"text":"running","style":"green"}"#).unwrap();
    assert!(matches!(
      c,
      Cell::Styled {
        style: Style::Green,
        ..
      }
    ));
    let c: Cell = serde_json::from_str(r#"{"text":"selected","style":"white"}"#).unwrap();
    assert!(matches!(
      c,
      Cell::Styled {
        style: Style::White,
        ..
      }
    ));
    let c: Cell = serde_json::from_str(r#"{"raw":"already rendered"}"#).unwrap();
    assert!(matches!(c, Cell::Raw(_)));
  }
}
