//! Path-keyed column visibility — the shared model behind toggleable columns
//! in any column-aware renderer (the fleet tree pane, the trace renderer, and
//! future consumers).
//!
//! Two pieces of state:
//! - `ordered: Vec<String>` — when non-empty, this is the explicit visible set
//!   in order. When empty, "all known paths are visible" (subject to `hidden`).
//! - `hidden: BTreeSet<String>` — wins over `ordered`. A path in `hidden` is
//!   never rendered, even if listed in `ordered` (matches the Lisp DSL where
//!   `(hide)` wins over `(leftover :on)`).
//!
//! The semantics deliberately mirror the four Lisp verbs the fleet tree pane
//! already uses — `(columns …)`, `(show …)`, `(hide …)`, `(toggle …)` — so the
//! same DSL can drive any renderer that consumes a `ColumnVisibility`.
//!
//! **Namespacing taxonomy**: the verb set is canonical; the namespace prefix
//! declares the scope. Bare verbs in a pane LispHost target that pane's
//! in-memory visibility (this struct, via `register_visibility_bindings`).
//! Dotted `table.<verb>` shell commands target one emitted table's durable
//! view sidecar — the INSTANCE scope — addressable with a `:table NAME`
//! keyword (tsh's `table_cmd`, sharing the same mechanics through
//! `TableView`). Dotted `<cmd>.<verb>` (e.g. `ls.columns`) target the
//! command's per-name config — the CLASS scope — which seeds every new
//! emission and doubles as the newest emission's immediate update (tsh's
//! `command_config`); a config line in the user's rc makes it durable,
//! dotfile-style. The class scope has two halves: `<cmd>.columns`/`show`/
//! `hide`/`toggle` set which columns are visible, while `<cmd>.column <key>
//! :header :align :format :hidden` styles the CATALOG itself — what the
//! columns are and how each renders. The catalog default ships as embedded
//! Lisp in the core library (tsh's `configs/<cmd>.tsh`), evaluated before the
//! user's rc so rc lines override it; formats are Lisp-selected by name
//! ([`crate::CellFormat::from_name`]) over Rust implementations. Future
//! scopes — `tree.<verb>`, selection-addressed widget forms — join the same
//! grammar by prefixing the same verbs, never by renaming them.

use std::collections::BTreeSet;

/// Visibility state for a column-aware renderer.
///
/// `ordered.is_empty() && hidden.is_empty()` is the "show everything" default,
/// which is what [`ColumnVisibility::all`] returns. Renderers with a fixed,
/// known column set should default to this and only consult `hidden`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ColumnVisibility {
  /// Ordered explicit visible set. When non-empty, only these paths render
  /// (and in this order, for renderers that honour ordering). When empty,
  /// all paths the renderer knows about are visible (minus `hidden`).
  pub ordered: Vec<String>,
  /// Always-hidden paths. Wins over `ordered`.
  pub hidden: BTreeSet<String>,
}

impl ColumnVisibility {
  /// Empty ordered + empty hidden — "everything visible". The natural default
  /// for renderers with a fixed known column set.
  pub fn all() -> Self {
    Self::default()
  }

  /// Construct from an explicit visible set. Equivalent to the Lisp
  /// `(columns p1 p2 …)`. `hidden` stays empty.
  pub fn only<P, I>(paths: I) -> Self
  where
    P: Into<String>,
    I: IntoIterator<Item = P>,
  {
    Self {
      ordered: paths.into_iter().map(Into::into).collect(),
      hidden: BTreeSet::new(),
    }
  }

  /// Construct with a hidden set; `ordered` stays empty (so the visible set
  /// is "all known paths minus these"). Equivalent to `(hide p1 p2 …)`
  /// against the default-everything baseline.
  pub fn hiding<P, I>(paths: I) -> Self
  where
    P: Into<String>,
    I: IntoIterator<Item = P>,
  {
    Self {
      ordered: Vec::new(),
      hidden: paths.into_iter().map(Into::into).collect(),
    }
  }

  /// Parse the CLI-shaped `--columns a,b,c` / `--hide x,y` flag pair into a
  /// `ColumnVisibility`. Whitespace around each path is trimmed; empty
  /// segments are skipped. Both `None` returns [`ColumnVisibility::all`].
  pub fn from_cli(columns: Option<&str>, hide: Option<&str>) -> Self {
    let ordered = columns
      .map(|s| {
        s.split(',')
          .map(str::trim)
          .filter(|s| !s.is_empty())
          .map(str::to_string)
          .collect()
      })
      .unwrap_or_default();
    let hidden = hide
      .map(|s| {
        s.split(',')
          .map(str::trim)
          .filter(|s| !s.is_empty())
          .map(str::to_string)
          .collect()
      })
      .unwrap_or_default();
    Self { ordered, hidden }
  }

  /// `true` when `path` should be rendered. A path is visible when it isn't in
  /// `hidden` AND (either `ordered` is empty — meaning "show known paths by
  /// default" — or `ordered` lists it).
  pub fn is_visible(&self, path: &str) -> bool {
    if self.hidden.iter().any(|p| p == path) {
      return false;
    }
    if self.ordered.is_empty() {
      return true;
    }
    self.ordered.iter().any(|p| p == path)
  }

  /// Make `path` visible: remove from `hidden`, append to `ordered` if not
  /// already there. Matches the Lisp `(show …)` semantics — appends so the
  /// caller can build up an ordered visible list.
  pub fn show(&mut self, path: &str) {
    self.hidden.remove(path);
    if !self.ordered.iter().any(|p| p == path) {
      self.ordered.push(path.to_string());
    }
  }

  /// Hide `path`: remove from `ordered` if present, insert into `hidden`.
  pub fn hide(&mut self, path: &str) {
    self.ordered.retain(|p| p != path);
    self.hidden.insert(path.to_string());
  }

  /// Flip `path`'s visibility. Hidden → shown (un-hide + append if missing).
  /// Otherwise → hidden (remove from ordered + insert into hidden).
  pub fn toggle(&mut self, path: &str) {
    if self.hidden.remove(path) {
      if !self.ordered.iter().any(|p| p == path) {
        self.ordered.push(path.to_string());
      }
    } else {
      self.ordered.retain(|p| p != path);
      self.hidden.insert(path.to_string());
    }
  }

  /// Replace the ordered visible set wholesale. The `hidden` set is preserved
  /// so a global `(hide)` keeps winning across `(columns …)` resets.
  pub fn set_ordered(&mut self, paths: Vec<String>) {
    self.ordered = paths;
  }

  /// Iterate `known` paths in their natural order, yielding only those that
  /// are visible. When `ordered` is empty (the "show everything known" case),
  /// `known`'s order is preserved. When `ordered` is non-empty, paths render
  /// in the `ordered` sequence, restricted to those that also appear in
  /// `known` (so a typo in `ordered` doesn't synthesize an unknown column).
  pub fn iter_visible<'a, I>(&'a self, known: I) -> Box<dyn Iterator<Item = &'a str> + 'a>
  where
    I: IntoIterator<Item = &'a str> + 'a,
  {
    if self.ordered.is_empty() {
      Box::new(
        known
          .into_iter()
          .filter(move |p| !self.hidden.iter().any(|h| h == p)),
      )
    } else {
      let known: Vec<&'a str> = known.into_iter().collect();
      Box::new(self.ordered.iter().filter_map(move |p| {
        if self.hidden.iter().any(|h| h == p) {
          return None;
        }
        known.iter().copied().find(|k| *k == p.as_str())
      }))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn all_shows_everything() {
    let viz = ColumnVisibility::all();
    assert!(viz.is_visible("ts"));
    assert!(viz.is_visible("ip"));
    assert!(viz.is_visible("anything"));
  }

  #[test]
  fn only_restricts_to_listed_paths() {
    let viz = ColumnVisibility::only(["ts", "level"]);
    assert!(viz.is_visible("ts"));
    assert!(viz.is_visible("level"));
    assert!(!viz.is_visible("ip"));
    assert!(!viz.is_visible("user"));
  }

  #[test]
  fn hiding_keeps_others_visible() {
    let viz = ColumnVisibility::hiding(["ip", "user"]);
    assert!(viz.is_visible("ts"));
    assert!(viz.is_visible("level"));
    assert!(!viz.is_visible("ip"));
    assert!(!viz.is_visible("user"));
  }

  #[test]
  fn hidden_wins_over_ordered() {
    let mut viz = ColumnVisibility::only(["ts", "ip", "user"]);
    viz.hidden.insert("ip".into());
    assert!(viz.is_visible("ts"));
    assert!(!viz.is_visible("ip"));
    assert!(viz.is_visible("user"));
  }

  #[test]
  fn show_unhides_and_appends() {
    let mut viz = ColumnVisibility::hiding(["ip"]);
    viz.show("ip");
    assert!(viz.is_visible("ip"));
    assert!(viz.ordered.contains(&"ip".to_string()));
    assert!(!viz.hidden.contains("ip"));
  }

  #[test]
  fn hide_removes_from_ordered() {
    let mut viz = ColumnVisibility::only(["ts", "ip"]);
    viz.hide("ip");
    assert!(!viz.is_visible("ip"));
    assert!(!viz.ordered.contains(&"ip".to_string()));
    assert!(viz.hidden.contains("ip"));
  }

  #[test]
  fn toggle_flips_visibility() {
    let mut viz = ColumnVisibility::all();
    viz.toggle("ip");
    assert!(!viz.is_visible("ip"));
    viz.toggle("ip");
    assert!(viz.is_visible("ip"));
  }

  #[test]
  fn from_cli_parses_comma_lists() {
    let viz = ColumnVisibility::from_cli(Some("ts, level , origin"), Some("ip,user"));
    assert_eq!(viz.ordered, vec!["ts", "level", "origin"]);
    assert!(viz.hidden.contains("ip"));
    assert!(viz.hidden.contains("user"));
    assert!(viz.is_visible("ts"));
    assert!(!viz.is_visible("ip"));
    // ordered restricts to listed paths
    assert!(!viz.is_visible("elapsed"));
  }

  #[test]
  fn from_cli_both_none_is_all_visible() {
    let viz = ColumnVisibility::from_cli(None, None);
    assert_eq!(viz, ColumnVisibility::all());
    assert!(viz.is_visible("anything"));
  }

  #[test]
  fn from_cli_skips_empty_segments() {
    let viz = ColumnVisibility::from_cli(Some("ts,,level,"), None);
    assert_eq!(viz.ordered, vec!["ts", "level"]);
  }

  #[test]
  fn iter_visible_preserves_known_order_when_unordered() {
    let viz = ColumnVisibility::hiding(["ip"]);
    let cols: Vec<&str> = viz
      .iter_visible(["level", "elapsed", "ts", "ip", "user", "origin"])
      .collect();
    assert_eq!(cols, vec!["level", "elapsed", "ts", "user", "origin"]);
  }

  #[test]
  fn iter_visible_uses_ordered_sequence() {
    let viz = ColumnVisibility::only(["origin", "ts", "level"]);
    let cols: Vec<&str> = viz
      .iter_visible(["level", "elapsed", "ts", "ip", "user", "origin"])
      .collect();
    assert_eq!(cols, vec!["origin", "ts", "level"]);
  }

  #[test]
  fn iter_visible_skips_unknown_paths_in_ordered() {
    let viz = ColumnVisibility::only(["ts", "bogus", "level"]);
    let cols: Vec<&str> = viz.iter_visible(["level", "ts"]).collect();
    assert_eq!(cols, vec!["ts", "level"]);
  }
}
