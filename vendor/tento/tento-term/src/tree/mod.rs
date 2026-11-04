//! A box-drawing tree model with width-aware wrapping and optional column layout.
//!
//! Each [`Node`] carries a `label` plus an open-ended `fields` map of keyed per-row data.
//! A [`Tree`] declares which fields render where via [`TreeColumn`]: `Left` (column-aligned
//! before the tree edges), `Right` (column-aligned rightmost), or `Inline` (packed after the
//! label with a two-space gap — the legacy `detail` behaviour). Lowest-priority side columns
//! demote to indented sub-lines under each row when the terminal is too narrow. An optional
//! [`ColumnDivider`] glyph draws between the side blocks and the tree on the top line and on
//! every continuation line so columns stay aligned through wrapped inline text.
//!
//! With no columns declared, `Tree::new(root)` reproduces the legacy detail-only behaviour
//! exactly (BC: the `tree_basic.json` / `tree_health.json` fixtures still pass).
//!
//! Module split:
//!
//! - [`node`] — [`Node`] + its custom JSON deserializer (legacy `detail` / new `fields`).
//! - [`column`] — [`ColumnPosition`], [`TreeColumn`], [`ColumnDivider`].
//! - [`render`] — [`Tree`], [`RenderedLine`], the rendering pipeline (column layout,
//!   width fitting, side-block demotion, ANSI-aware wrap), and the [`Tree`] deserializer.

mod column;
mod node;
mod render;

pub use column::{ColumnDivider, ColumnPosition, TreeColumn};
pub use node::Node;
pub use render::{RenderedLine, Tree};
