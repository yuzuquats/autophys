//! ux-test rendering policy + a stable facade over the `tento_logger` renderer.
//!
//! The heavy rendering — span-tree grafting, terminal layout, the `unified-trace`
//! TUI preset — lives in `tento_logger` and `tento-tui-scene`, which are shared
//! by several crates and must stay there. This module owns only the
//! *ux-test-specific policy*: which columns to hide by default for client-heavy
//! traces, and how to author the `view.tsh` viewer scene against the
//! `unified-trace` preset. (The preset name is referenced as an opaque string —
//! no Cargo dependency on `tento-tui-scene`.)

use std::path::Path;

use tento_logger::render::terminal::col;

pub use tento_logger::render::terminal::ColumnVisibility;
pub use tento_logger::render::{
  render_entry, render_session, render_session_to, render_unified, render_unified_to,
};

/// Trace-mode column visibility from CLI `--columns` / `--hide`. The default —
/// both `None` — hides the IP and user columns, usually blank for UX-test trace
/// renders (client-only spans). Pass `--columns ts,level,origin` or
/// `--hide ip,user,elapsed` to override. Path constants live in
/// [`tento_logger::render::terminal::col`]; CLI args take the bare path name.
pub fn ux_trace_columns(columns: Option<&str>, hide: Option<&str>) -> ColumnVisibility {
  if columns.is_none() && hide.is_none() {
    return ColumnVisibility::hiding([col::IP, col::USER]);
  }
  ColumnVisibility::from_cli(columns, hide)
}

/// JSON-quote a path as an A-grammar string literal so absolute paths embed
/// safely into the scene source (string args are literals; symbols are
/// bindings).
fn quoted(p: &Path) -> String {
  serde_json::Value::String(p.display().to_string()).to_string()
}

/// Live (`--follow`) viewer scene: client `logs.ljson` (tails) + server
/// `server.ljson`, side-by-side in a `unified-trace` pane. Literal paths.
pub fn unified_trace_scene_follow(client: &Path, server: &Path) -> String {
  format!(
    "(layout.column (pane \"trace\" (renderer.unified-trace (data.file {}) (data.file {})) :flex 1 :overflow :scroll))",
    quoted(client),
    quoted(server),
  )
}

/// Snapshot viewer scene: bind `trace-file` to a materialized unified (or
/// client-only) trace and render the `unified-trace` preset.
pub fn unified_trace_scene_snapshot(trace: &Path) -> String {
  format!(
    "(config.set 'trace-file {})\n(scene (unified-trace))",
    quoted(trace)
  )
}
