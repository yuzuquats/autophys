//! Render-shape registry: the single dispatch point for shape-tagged command
//! results (`{ "shape": "<name>/v<N>", … }`) shared by the plain CLI and the
//! TUI trace pane.
//!
//! Widgets implement [`ShapeWidget`]; [`ShapeRegistry::core`] bundles the
//! built-ins (`table/v1`, `sections/v1`, `chart/v1`). Hosts extend it with
//! their own widgets (the trace pane registers `tree/v1`, which needs the TUI
//! tree renderer). A `source` DataRef on any shape value is resolved here,
//! before widget dispatch, so live file-backed content works for every shape
//! — see the tento-shell project doc `render-shapes.md`.

mod algebra;
pub mod anim;
pub mod build;
mod canvas;
mod chart;
mod confirm;
mod job_row;
mod json;
mod kv;
mod list;
mod markdown;
mod registry;
mod resolve;
mod sections;
pub mod style;
mod table;
mod term;
mod term_block;

pub use algebra::{
  Container, ContainerKinds, Element, ElementKinds, Shape, ShapeError, ShapeSig, SingleWidget,
  UnionWidget,
};
pub use anim::{
  AnimCounter, AnimDuration, AnimKind, AnimPatch, MIN_INTERVAL_MS, REDUCED_MOTION_VAR, Splice,
  apply_splices, duration_text, reduced_motion_from, validate_frame_widths,
};
pub use canvas::{CANVAS_V1, CanvasWidget, render_canvas_rows};
pub use chart::ChartWidget;
pub use confirm::ConfirmWidget;
pub use job_row::{JOB_V1, JobWidget};
pub use json::render_fallback;
pub use kv::{KV_V1, KvWidget};
pub use list::{LIST_V1, ListWidget};
pub use markdown::{MarkdownTheme, markdown_rows, markdown_rows_with_highlighter};
pub use registry::{
  RenderCtx, RowAttrs, ShapeOutput, ShapeRegistry, ShapeWidget, WidgetAction, WidgetEvent,
};
pub use resolve::{FileSourceResolver, SourceResolver};
pub use sections::SectionsWidget;
pub use style::{SpanStyle, Theme, color_sgr, parse_style, style_from_tokens};
pub use table::TableWidget;
pub use term::{TERM_V1, TermWidget};
pub use term_block::{TERM_BLOCK_V1, TermBlockWidget, render_inline_spans, term_block_anim_errors};
