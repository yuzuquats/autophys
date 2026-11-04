//! Column layout for [`super::Tree`]:
//!
//! - [`ColumnPosition`] — where the column renders relative to the tree
//!   (Left / Right / Inline).
//! - [`TreeColumn`] — one column declaration (key + position + width
//!   constraints + style).
//! - [`ColumnDivider`] — optional glyph drawn between a row's side blocks
//!   and the tree (and between adjacent side-block columns), repeated on
//!   continuation lines so columns stay visually aligned.

use serde::{Deserialize, Serialize};

use crate::pad::Align;
use crate::style::{Overflow, Style};
use crate::width::visual_width;

/// Where a [`TreeColumn`] renders relative to the tree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnPosition {
  /// Column-aligned, before the tree edges.
  Left,
  /// Column-aligned, rightmost.
  Right,
  /// Packed after the label with a two-space gap (the legacy `detail` behaviour).
  /// Wraps onto continuation lines inside the row's leftover width.
  #[default]
  Inline,
  /// Joined onto the row's label as a comma-separated parenthetical group:
  /// `label (a, b, c)`. Multiple `TitleSuffix` columns are collected in
  /// declaration order; empty values are elided. Used for short identity
  /// markers (kind tag, run mode, version) that should read as part of
  /// the node's title rather than living in their own visual column.
  TitleSuffix,
}

/// A tree column declaration — pulled out of each row's `fields` by `key`.
#[derive(Clone, Debug, Deserialize)]
pub struct TreeColumn {
  pub key: String,
  #[serde(default)]
  pub header: Option<String>,
  #[serde(default)]
  pub position: ColumnPosition,
  #[serde(default)]
  pub align: Align,
  #[serde(default)]
  pub min_width: usize,
  #[serde(default)]
  pub max_width: Option<usize>,
  #[serde(default)]
  pub flex: u16,
  #[serde(default)]
  pub priority: u8,
  #[serde(default)]
  pub overflow: Overflow,
  #[serde(default)]
  pub style: Option<Style>,
}

impl TreeColumn {
  pub fn new(key: impl Into<String>) -> Self {
    TreeColumn {
      key: key.into(),
      header: None,
      position: ColumnPosition::Inline,
      align: Align::Left,
      min_width: 0,
      max_width: None,
      flex: 0,
      priority: 0,
      overflow: Overflow::TruncateEnd,
      style: None,
    }
  }
  pub fn position(mut self, p: ColumnPosition) -> Self {
    self.position = p;
    self
  }
  pub fn align(mut self, a: Align) -> Self {
    self.align = a;
    self
  }
  pub fn min_width(mut self, w: usize) -> Self {
    self.min_width = w;
    self
  }
  pub fn max_width(mut self, w: usize) -> Self {
    self.max_width = Some(w);
    self
  }
  pub fn flex(mut self, f: u16) -> Self {
    self.flex = f;
    self
  }
  pub fn priority(mut self, p: u8) -> Self {
    self.priority = p;
    self
  }
  pub fn overflow(mut self, o: Overflow) -> Self {
    self.overflow = o;
    self
  }
  pub fn style(mut self, s: Style) -> Self {
    self.style = Some(s);
    self
  }
  pub fn header(mut self, h: impl Into<String>) -> Self {
    self.header = Some(h.into());
    self
  }
}

/// Glyph drawn between a row's side-blocks and the tree (and between adjacent side-block
/// columns), repeated on continuation lines so columns stay visually aligned.
#[derive(Clone, Debug, Deserialize)]
pub struct ColumnDivider {
  #[serde(default = "default_divider_glyph")]
  pub glyph: String,
  #[serde(default = "default_divider_style")]
  pub style: Option<Style>,
  #[serde(default = "default_divider_gap")]
  pub gap: usize,
}

fn default_divider_glyph() -> String {
  "▏".to_string()
}
fn default_divider_style() -> Option<Style> {
  Some(Style::Dimmed)
}
fn default_divider_gap() -> usize {
  1
}

impl Default for ColumnDivider {
  fn default() -> Self {
    ColumnDivider {
      glyph: default_divider_glyph(),
      style: default_divider_style(),
      gap: default_divider_gap(),
    }
  }
}

impl ColumnDivider {
  /// Total visible width of `gap + glyph + gap`.
  pub(super) fn slot_width(&self) -> usize {
    visual_width(&self.glyph) + 2 * self.gap
  }

  /// Render a divider slot. If `with_glyph` is false, returns a fully-blank slot of the
  /// same width (used to keep alignment when the row decides not to draw on this edge).
  pub(super) fn render(&self, with_glyph: bool) -> String {
    let gap = " ".repeat(self.gap);
    if with_glyph {
      let painted = self.style.unwrap_or(Style::None).paint(&self.glyph);
      format!("{gap}{painted}{gap}")
    } else {
      " ".repeat(self.slot_width())
    }
  }
}
