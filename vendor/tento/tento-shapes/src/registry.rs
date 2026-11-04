use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::Value;
use tento_tui_core::input::Event;

use crate::anim::AnimPatch;
use crate::chart::ChartWidget;
use crate::confirm::ConfirmWidget;
use crate::resolve::{FileSourceResolver, SourceResolver};
use crate::sections::SectionsWidget;
use crate::table::TableWidget;

/// Selectable-row attributes: each addressable row path, valued by its
/// `(column header, visible cell text)` pairs in column order. Feeds the
/// detail view on select.
pub type RowAttrs = Vec<(String, Vec<(String, String)>)>;

/// One value rendered to lines, with a parallel selection/collapse path per
/// line (`None` = chrome: titles, rules, separators) plus the [`RowAttrs`] of
/// the addressable rows.
#[derive(Default)]
pub struct ShapeOutput {
  pub lines: Vec<String>,
  pub paths: Vec<Option<String>>,
  pub attrs: RowAttrs,
  /// Animated regions of [`Self::lines`], addressed by row index and byte
  /// range (see [`crate::anim`]). Empty for every static render — a host that
  /// ignores this field behaves exactly as before, and a host that honors it
  /// swaps pre-painted frames without re-rendering anything.
  pub anims: Vec<AnimPatch>,
}

impl ShapeOutput {
  /// A single unselectable diagnostic line — the degraded render for a
  /// malformed value or an unresolvable `source`. Never panic in a renderer.
  pub fn diagnostic(message: impl Into<String>) -> Self {
    ShapeOutput {
      lines: vec![message.into()],
      paths: vec![None],
      ..ShapeOutput::default()
    }
  }

  /// Shift every animation patch's row index by `rows` — what a composite
  /// widget does when it splices a child render into its own line list.
  pub fn offset_anims(&mut self, rows: usize) {
    for patch in self.anims.iter_mut() {
      patch.row += rows;
    }
  }
}

static EMPTY_COLLAPSED: LazyLock<HashSet<String>> = LazyLock::new(HashSet::new);
pub(crate) static EMPTY_WIDGET_STATE: LazyLock<HashMap<String, Value>> =
  LazyLock::new(HashMap::new);

/// Per-render context a widget draws against.
pub struct RenderCtx<'a> {
  /// Path prefix for this value's addressable rows (a turn path like
  /// `turn:5`, or `turn:5/sec:1` inside a composite). `None` on the CLI —
  /// rows are unaddressable and no attrs are emitted.
  pub base_path: Option<&'a str>,
  /// Collapse set (slash paths) owned by the hosting pane's view state.
  pub collapsed: &'a HashSet<String>,
  /// Per-path widget view state (cursor, edit buffer), host-held like the
  /// collapse set; widgets read it at render and replace it via
  /// [`WidgetAction::State`]. Keyed by full line path. Empty on the CLI.
  pub widget_state: &'a HashMap<String, Value>,
  /// Resolves `source` DataRefs (`{kind:"file", path}` today).
  pub resolver: &'a dyn SourceResolver,
  /// Composite recursion depth ([`SectionsWidget`] caps it).
  pub depth: u8,
}

impl<'a> RenderCtx<'a> {
  /// CLI context: fixed width, no view state, file sources resolvable.
  pub fn cli() -> RenderCtx<'static> {
    RenderCtx {
      base_path: None,
      collapsed: &EMPTY_COLLAPSED,
      widget_state: &EMPTY_WIDGET_STATE,
      resolver: &FileSourceResolver,
      depth: 0,
    }
  }
}

/// What a widget asks the host to do in response to an input event.
pub enum WidgetAction {
  /// A control form for the session's existing grammar (e.g.
  /// `(deploy.confirm --fleet-id host-b)`), fed to the shell-pane stdin
  /// drain — exactly as if the user typed it.
  Control(String),
  /// Replace this path's view state (cursor, edit buffer). The host stores
  /// it (`RenderCtx::widget_state` on the next paint) and repaints.
  State(Value),
}

/// One input event offered to a widget, addressed by line path.
pub struct WidgetEvent<'a> {
  /// Full line path (`turn:5/sec:1/confirm`) — what control forms and the
  /// host's state map key on.
  pub abs_path: &'a str,
  /// Path relative to this widget's value root (`""` for the widget's own
  /// header line; `sec:1/confirm` seen by an outer sections widget).
  pub rel_path: &'a str,
  pub event: &'a Event,
  /// Current view state for `abs_path`, if any.
  pub state: Option<&'a Value>,
}

/// One renderer for one or more shape ids. Implementations are pure
/// `(value, width, view-state) → lines`; effects (file reads) go through
/// `ctx.resolver`.
pub trait ShapeWidget: Send + Sync {
  /// Shape ids this widget renders, e.g. `["table/v1"]`.
  fn shapes(&self) -> &'static [&'static str];
  /// Render `value` (already `source`-resolved) at `width`. `reg` lets
  /// composite shapes recurse through the registry.
  fn render(&self, value: &Value, width: u16, ctx: &RenderCtx, reg: &ShapeRegistry) -> ShapeOutput;
  /// Offer an input event on one of this value's lines. `None` (the
  /// default — interactivity is additive, no existing widget breaks) lets
  /// the host keep its own handling (collapse, selection). Composite
  /// shapes recurse via `reg` (see [`crate::SectionsWidget`]).
  fn on_event(&self, ev: &WidgetEvent, value: &Value, reg: &ShapeRegistry) -> Option<WidgetAction> {
    let _ = (ev, value, reg);
    None
  }
}

/// The widget set a host dispatches shape-tagged values through.
pub struct ShapeRegistry {
  widgets: Vec<Box<dyn ShapeWidget>>,
}

impl ShapeRegistry {
  /// The built-in vocabulary every host gets: `table/v1` + `sections/v1`
  /// + `chart/v1` + `confirm/v1` + `list/v1` + `kv/v1` + `term.block/v1`
  /// + `term/v1` + `canvas/v1` + `job/v1`.
  pub fn core() -> Self {
    ShapeRegistry {
      widgets: Vec::new(),
    }
    .with(Box::new(TableWidget))
    .with(Box::new(SectionsWidget))
    .with(Box::new(ChartWidget))
    .with(Box::new(ConfirmWidget))
    .with(Box::new(crate::ListWidget))
    .with(Box::new(crate::KvWidget))
    .with(Box::new(crate::algebra::SingleWidget))
    .with(Box::new(crate::algebra::UnionWidget))
    .with(Box::new(crate::TermBlockWidget))
    .with(Box::new(crate::TermWidget))
    .with(Box::new(crate::CanvasWidget))
    .with(Box::new(crate::JobWidget))
  }

  /// Register an additional widget (host-specific shapes like `tree/v1`).
  pub fn with(mut self, widget: Box<dyn ShapeWidget>) -> Self {
    self.widgets.push(widget);
    self
  }

  /// Whether any registered widget renders `shape`.
  pub fn accepts(&self, shape: &str) -> bool {
    self.widgets.iter().any(|w| w.shapes().contains(&shape))
  }

  /// The shape tag of `value`, if the registry can render it.
  pub fn accepted_shape<'v>(&self, value: &'v Value) -> Option<&'v str> {
    let shape = value.get("shape").and_then(Value::as_str)?;
    self.accepts(shape).then_some(shape)
  }

  /// Render a shape-tagged value: resolve a `source` DataRef if present, then
  /// dispatch by tag. `None` when the value carries no tag the registry
  /// accepts — the caller keeps its generic fallback (body tree in the TUI,
  /// readable JSON in the CLI), so unknown shapes degrade instead of erroring.
  pub fn render(&self, value: &Value, width: u16, ctx: &RenderCtx) -> Option<ShapeOutput> {
    let shape = self.accepted_shape(value)?;
    let widget = self
      .widgets
      .iter()
      .find(|w| w.shapes().contains(&shape))
      .expect("accepted_shape implies a widget");
    match value.get("source") {
      // A records source feeds the OUTER value's rows; the widget composes
      // (records + view + the outer column catalog) via ctx.resolver instead
      // of the registry swapping the value out from under it.
      Some(src) if src.get("row_shape").and_then(Value::as_str) == Some("records") => {
        Some(widget.render(value, width, ctx, self))
      }
      Some(src) => match ctx.resolver.resolve(src) {
        // The outer tag is authoritative; the resolved record renders as-is.
        Some(resolved) => Some(widget.render(&resolved, width, ctx, self)),
        None => Some(ShapeOutput::diagnostic(format!(
          "  ({shape}: unresolved or malformed source)"
        ))),
      },
      None => Some(widget.render(value, width, ctx, self)),
    }
  }

  /// Offer an input event landing on `abs_path` (a line of the value
  /// rendered under `base_path`) to the owning widget. `None` when the
  /// value isn't shaped, the path isn't under the base, or the widget
  /// doesn't claim the event — the host keeps its own handling.
  pub fn on_event(
    &self,
    value: &Value,
    base_path: &str,
    abs_path: &str,
    event: &Event,
    state: Option<&Value>,
  ) -> Option<WidgetAction> {
    let shape = self.accepted_shape(value)?;
    let widget = self
      .widgets
      .iter()
      .find(|w| w.shapes().contains(&shape))
      .expect("accepted_shape implies a widget");
    let rel_path = if abs_path == base_path {
      ""
    } else {
      abs_path.strip_prefix(base_path)?.strip_prefix('/')?
    };
    widget.on_event(
      &WidgetEvent {
        abs_path,
        rel_path,
        event,
        state,
      },
      value,
      self,
    )
  }

  /// CLI convenience: render at the terminal width with no view state and
  /// join to one string. `None` for non-shape values (caller falls back to
  /// its readable-JSON path). Unlike the old CLI table path, `source`
  /// aliases resolve here too.
  pub fn render_text(&self, value: &Value) -> Option<String> {
    let width = tento_term::term_columns().clamp(20, 500) as u16;
    let out = self.render(value, width, &RenderCtx::cli())?;
    Some(out.lines.join("\n"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn unknown_shape_and_untagged_values_return_none() {
    let reg = ShapeRegistry::core();
    let ctx = RenderCtx::cli();
    assert!(
      reg
        .render(&json!({"shape": "mystery/v9"}), 80, &ctx)
        .is_none()
    );
    assert!(reg.render(&json!({"rows": []}), 80, &ctx).is_none());
    assert!(reg.render(&json!("plain string"), 80, &ctx).is_none());
  }

  #[test]
  fn core_accepts_table_and_sections() {
    let reg = ShapeRegistry::core();
    assert!(reg.accepts("table/v1"));
    assert!(reg.accepts("sections/v1"));
    assert!(!reg.accepts("tree/v1"));
  }

  #[test]
  fn unresolvable_source_degrades_to_diagnostic() {
    let reg = ShapeRegistry::core();
    let v = json!({"shape": "table/v1", "source": {"kind": "file", "path": "/nonexistent/x"}});
    let out = reg.render(&v, 80, &RenderCtx::cli()).expect("dispatches");
    assert_eq!(out.lines.len(), 1);
    assert!(out.lines[0].contains("unresolved"), "{}", out.lines[0]);
  }
}
