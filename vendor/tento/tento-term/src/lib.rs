//! Terminal rendering primitives: ANSI-aware width / pad / truncate, box-drawing
//! trees that wrap, and a responsive table model that shrinks columns toward
//! their minimums and — when that isn't enough — demotes the lowest-priority
//! columns into a per-row sub-tree (a hybrid tree/table).
//!
//! Small composable pieces ([`visual_width`], [`pad_right`], [`truncate_ellipsis`],
//! [`box_chars`], [`term_columns`], …) live alongside the data models ([`Table`],
//! [`Tree`]).

pub mod ansi;
pub mod chart;
pub mod column_visibility;
pub mod confirm;
pub mod draw;
pub mod format;
#[cfg(feature = "watch")]
pub mod live;
pub mod nav;
pub mod pad;
pub mod role;
pub mod sections;
pub mod span_style;
pub mod spark;
pub mod style;
pub mod table;
pub mod table_view;
pub mod term;
pub mod tree;
pub mod tree_table;
pub mod width;

pub use ansi::{
  BLACK, BLUE, BOLD, CYAN, DIMMED, EMPTY, GRAY, GREEN, MAGENTA, RED, RESET, WHITE, YELLOW,
};
pub use chart::{CHART_V1, ChartBody, ChartSeries, ChartWindow};
pub use column_visibility::ColumnVisibility;
pub use confirm::{CONFIRM_V1, ConfirmBody, ConfirmButton};
pub use draw::{
  BoxChars, box_chars, box_chars_ascii, panel, panel_bottom, panel_focused, panel_full, panel_row,
  panel_top, rule, rule_with,
};
pub use format::{CellFormat, format_cell, human_age_ms, human_size};
#[cfg(feature = "watch")]
pub use live::{watch, watch_with};
pub use nav::{
  SELECTION_BG, chevron, highlight_line, highlight_row_line, is_open, level_style,
  scroll_into_view, select_page, select_row_step, select_step, strip_background_sgr,
  style_node_key,
};
pub use pad::{
  Align, pad, pad_center, pad_left, pad_right, truncate_clip, truncate_ellipsis, truncate_middle,
  wrap_exact, wrap_exact_hanging, wrap_to_width,
};
pub use role::{
  RoleTable, any_roles_bound, clear_roles, generation as theme_generation, is_role_name,
  resolve as resolve_role, roles, set_baseline_roles, set_roles, with_roles,
};
pub use sections::{SECTIONS_V1, Section, SectionsBody};
pub use span_style::{SpanStyle, color_sgr, paint_with_color, style_from_tokens, style_sgr};
pub use spark::{bucketize_points, sparkline};
pub use style::{Cell, Overflow, Style};
pub use table::{Column, Table};
pub use table_view::{TableView, project_rows};
pub use term::term_columns;
pub use tree::{ColumnDivider, ColumnPosition, Node, RenderedLine, Tree, TreeColumn};
pub use tree_table::{Severity, TreeTable, TreeTableNode, TreeTableNote, TreeTableValue};
pub use width::{strip_ansi, visual_width};

/// Force terminal-colour output on or off for the current process (delegates to
/// `colored::control::set_override`). Useful in tests and when piping.
pub fn force_color(enable: bool) {
  colored::control::set_override(enable);
}

/// Undo a previous [`force_color`] (delegates to `colored::control::unset_override`).
pub fn unforce_color() {
  colored::control::unset_override();
}
