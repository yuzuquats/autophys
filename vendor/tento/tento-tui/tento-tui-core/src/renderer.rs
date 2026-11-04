//! Controlled-component pane renderers.
//!
//! A renderer holds **no state**. It is a pure function of the raw datasource
//! value plus the [`Viewport`] it draws into — the datasource file is the
//! single source of truth. Edits flow to the datasource (by the runtime), then
//! the pane re-renders. This mirrors a "controlled component": the value is
//! driven entirely from outside.
//!
//! Output is `Vec<String>` (one styled line per row). Diffing happens in two
//! cheap layers, neither owned by the renderer:
//!
//! 1. **Skip-if-unchanged** — [`RenderCache`] re-invokes the renderer only when
//!    the `(datasource, viewport)` pair changes (content hash).
//! 2. **Line diff** — the compositor repaints only the lines that differ from
//!    the previous frame (the existing `tento-term::live` redraw discipline).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::Value;

use crate::viewport::Viewport;

/// A controlled, stateless pane renderer: `(datasource, viewport) -> lines`.
pub trait PaneRenderer {
  /// Renderer id, distinct from the shape it serves so multiple renderers can
  /// serve one shape (e.g. `"tree"` vs `"tree.fails-only"`).
  fn id(&self) -> &str;

  /// Shape ids this renderer can draw (see [`crate::shape`]).
  fn accepts(&self) -> &[&'static str];

  /// Render the datasource value into at most `view.rows` lines, each at most
  /// `view.cols` visual columns wide. Pure: no internal state is mutated.
  fn render(&self, datasource: &Value, view: Viewport) -> Vec<String>;
}

/// Skip-if-unchanged wrapper around a renderer — the first diff layer.
///
/// Holds the last `(datasource, viewport)` hash and the lines it produced;
/// [`render`](RenderCache::render) recomputes only on a cache miss. This is the
/// "diff if necessary to render faster" path, kept out of the renderer so the
/// renderer stays a pure function.
#[derive(Default)]
pub struct RenderCache {
  key: Option<u64>,
  lines: Vec<String>,
  /// `true` if the most recent [`render`](RenderCache::render) recomputed.
  dirty: bool,
}

impl RenderCache {
  pub fn new() -> Self {
    RenderCache::default()
  }

  /// Return the rendered lines, recomputing only if `(datasource, viewport)`
  /// changed since the last call.
  pub fn render(&mut self, r: &dyn PaneRenderer, datasource: &Value, view: Viewport) -> &[String] {
    let key = hash_inputs(datasource, view);
    if self.key != Some(key) {
      self.lines = r.render(datasource, view);
      self.key = Some(key);
      self.dirty = true;
    } else {
      self.dirty = false;
    }
    &self.lines
  }

  /// Whether the last [`render`](RenderCache::render) was a cache miss (the
  /// compositor can skip the line-diff entirely when this is `false`).
  pub fn took_render(&self) -> bool {
    self.dirty
  }
}

fn hash_inputs(datasource: &Value, view: Viewport) -> u64 {
  let mut h = DefaultHasher::new();
  // `Value` isn't `Hash`; its compact JSON form is a stable-enough key.
  datasource.to_string().hash(&mut h);
  view.cols.hash(&mut h);
  view.rows.hash(&mut h);
  view.offset.hash(&mut h);
  h.finish()
}
