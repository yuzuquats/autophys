//! The style vocabulary every shape that paints cells shares.
//!
//! [`SpanStyle`] is the value; this module is how a *caller* spells one. Two
//! spellings, both accepted everywhere a style is taken:
//!
//! ```jsonc
//! "dim"                      // terse tokens, for authoring by hand
//! "bold fg:#9ece6a bg:red"
//! {"fg": "#9ece6a", "bold": true}   // structured, for generated values
//! ```
//!
//! Tokens split on whitespace, `,` or `|`; a bare colour is a foreground, so
//! `"red"` and `"fg:red"` mean the same thing. Colours are whatever
//! [`color_sgr`] accepts — a name, `index:N`, or `#rrggbb` — plus, behind an
//! explicit `fg:` / `bg:`, any name at all, so a [`Theme`] palette entry can be
//! written where a colour goes and resolved later.
//!
//! **Unknown tokens are dropped, never an error.** A style is presentation: a
//! typo must cost the styling it names and nothing else, because the
//! alternative is a component that blanks rather than renders.
//!
//! This lived inside `canvas/v1` and was reachable only from there, which is
//! why the theme paths grew colour-only vocabularies of their own — a theme
//! could say `"comment": "#8b8fa3"` but not `"comment": "dim"`, though the
//! machinery for the second had existed all along.

use std::collections::BTreeMap;

use serde_json::Value;

pub use tento_term::{SpanStyle, color_sgr, style_from_tokens};

/// Parse either spelling of a style. Anything else yields the default.
pub fn parse_style(value: &Value) -> SpanStyle {
  match value {
    Value::String(spec) => style_from_tokens(spec),
    object @ Value::Object(_) => serde_json::from_value(object.clone()).unwrap_or_default(),
    _ => SpanStyle::default(),
  }
}

/// A theme: a **palette** of named colours, and **roles** that name styles.
///
/// Two tiers, and the layering rule is the point of having them:
///
/// > A component references a ROLE. A theme binds roles to style specs and may
/// > reference PALETTE names. A palette entry is a literal colour. Nothing
/// > skips a tier.
///
/// ```text
/// (theme.palette "accent" "#cd694a")
/// (theme.role    "status.ok" "fg:accent bold")
/// (term.span "✓" :style (theme.style "status.ok"))
/// ```
///
/// Without the middle tier a preset must name `#cd694a` directly, which is how
/// the shipped presets ended up with fourteen hex literals retyped across them
/// — the same accent five times over, with no single place to change it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Theme {
  palette: BTreeMap<String, String>,
  roles: BTreeMap<String, String>,
}

impl Theme {
  /// Bind a palette name to a literal colour.
  ///
  /// A palette name SHADOWS a built-in colour name: a theme that defines
  /// `"red"` means its own red everywhere `fg:red` appears. That is the point
  /// of a palette — it would be useless if the sixteen ANSI names were carved
  /// out of it — and it is what Helix and every design-token system do.
  pub fn set_color(&mut self, name: impl Into<String>, literal: impl Into<String>) {
    self.palette.insert(name.into(), literal.into());
  }

  /// Bind a dotted role to a style spec.
  pub fn set_role(&mut self, role: impl Into<String>, spec: impl Into<String>) {
    self.roles.insert(role.into(), spec.into());
  }

  /// The literal behind a palette name.
  pub fn color(&self, name: &str) -> Option<&str> {
    self.palette.get(name).map(String::as_str)
  }

  /// The raw spec bound to `role`, by LONGEST PREFIX over the dotted name:
  /// `syntax.function.method` tries the whole name, then `syntax.function`,
  /// then `syntax`.
  ///
  /// The hierarchy is what keeps a theme small. A theme that says nothing about
  /// `syntax.function.method` still styles it, because it said something about
  /// `syntax` — the same fallback tree-sitter capture names, Chroma token types
  /// and TextMate scopes have all converged on.
  pub fn spec(&self, role: &str) -> Option<&str> {
    let mut probe = role;
    loop {
      if let Some(spec) = self.roles.get(probe) {
        return Some(spec.as_str());
      }
      probe = &probe[..probe.rfind('.')?];
    }
  }

  /// The style `role` resolves to, with palette names replaced by literals.
  /// An unbound role is the default style — absent, not an error.
  pub fn style(&self, role: &str) -> SpanStyle {
    self
      .spec(role)
      .map(|spec| self.resolve(&style_from_tokens(spec)))
      .unwrap_or_default()
  }

  /// Drop every palette entry and role binding.
  ///
  /// What `(theme.use …)` does before loading, so selecting a theme REPLACES
  /// the one before it. Without this, `(theme.use "dark")` after
  /// `(theme.use "light")` would leave every role the dark palette does not
  /// happen to mention still bound to its light value — a blend of two themes,
  /// which is not a thing anyone asked for and is very hard to see.
  pub fn clear(&mut self) {
    self.palette.clear();
    self.roles.clear();
  }

  /// Every role this theme binds, in sorted order — what a coverage guard
  /// walks to prove a shipped theme answers every role the tree references.
  pub fn role_names(&self) -> impl Iterator<Item = &str> {
    self.roles.keys().map(String::as_str)
  }

  /// Flatten this theme into a paint-ready [`tento_term::RoleTable`]: every
  /// spec parsed, every palette name substituted for its literal.
  ///
  /// This is the bridge that lets a theme reach `Style::paint` and `color_sgr`,
  /// which live in `tento-term`, *below* this crate and so unable to see a
  /// `Theme`. The flattening happens here, where the palette is known; the
  /// lower crate only ever learns role → style. Longest-prefix resolution is
  /// preserved because the table keeps the same keys.
  pub fn role_table(&self) -> tento_term::RoleTable {
    self
      .roles
      .keys()
      .map(|role| (role.clone(), self.style(role)))
      .collect()
  }

  /// Install this theme as the process-wide painting theme. One terminal per
  /// process; see `tento_term::role` for why that is the right shape.
  pub fn install(&self) {
    tento_term::set_roles(self.role_table());
  }

  /// Replace palette names in a style's colours with their literals. A colour
  /// that names nothing in the palette is left alone, so a literal written
  /// inline still works and an unknown name degrades to whatever `color_sgr`
  /// makes of it rather than erroring.
  pub fn resolve(&self, style: &SpanStyle) -> SpanStyle {
    let map = |color: &Option<String>| {
      color
        .as_ref()
        .map(|name| self.color(name).unwrap_or(name).to_string())
    };
    SpanStyle {
      fg: map(&style.fg),
      bg: map(&style.bg),
      ..style.clone()
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_role_table_carries_resolved_literals_down_to_tento_term() {
    let mut theme = Theme::default();
    theme.set_color("accent", "#cd694a");
    theme.set_role("status", "fg:grey");
    theme.set_role("status.ok", "fg:accent bold");

    let table = theme.role_table();
    let ok = table.get("status.ok").expect("bound");
    assert_eq!(
      ok.fg.as_deref(),
      Some("#cd694a"),
      "palette resolved BEFORE the handoff"
    );
    assert!(ok.bold);
    // Longest-prefix survives the flattening, so a trunk still covers a leaf
    // the theme never mentions.
    assert_eq!(
      table.get("status.error").unwrap().fg.as_deref(),
      Some("grey")
    );
    assert!(table.get("syntax.string").is_none());
  }

  #[test]
  fn a_role_resolves_through_the_palette() {
    let mut theme = Theme::default();
    theme.set_color("accent", "#cd694a");
    theme.set_role("status.ok", "fg:accent bold");

    let style = theme.style("status.ok");
    assert_eq!(
      style.fg.as_deref(),
      Some("#cd694a"),
      "palette name resolved"
    );
    assert!(style.bold);
  }

  #[test]
  fn roles_fall_back_by_longest_prefix() {
    let mut theme = Theme::default();
    theme.set_role("syntax", "dim");
    theme.set_role("syntax.function", "fg:blue");

    assert_eq!(theme.spec("syntax.function.method"), Some("fg:blue"));
    assert_eq!(theme.spec("syntax.keyword"), Some("dim"));
    assert_eq!(theme.spec("syntax"), Some("dim"));
    assert_eq!(theme.spec("chrome.rule"), None, "no bare-name cross-talk");
  }

  #[test]
  fn an_unbound_role_is_the_default_style_not_an_error() {
    assert_eq!(Theme::default().style("nothing.here"), SpanStyle::default());
  }

  #[test]
  fn a_palette_name_shadows_a_builtin_colour_name() {
    let mut theme = Theme::default();
    theme.set_color("red", "#f7768e");
    theme.set_role("status.bad", "fg:red");
    assert_eq!(
      theme.style("status.bad").fg.as_deref(),
      Some("#f7768e"),
      "the theme's own red wins — that is what a palette is for"
    );
  }

  #[test]
  fn a_colour_that_names_nothing_in_the_palette_is_left_alone() {
    let mut theme = Theme::default();
    theme.set_role("plain", "fg:#9ece6a bg:blue");
    let style = theme.style("plain");
    assert_eq!(
      style.fg.as_deref(),
      Some("#9ece6a"),
      "inline literal survives"
    );
    assert_eq!(style.bg.as_deref(), Some("blue"), "builtin name survives");
  }
}
