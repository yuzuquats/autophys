//! The rendering backend abstraction.
//!
//! The compositor decides *what* the screen contains (a [`Frame`] of laid-out
//! [`PaneSlot`]s); a `Backend` decides *how/where* to realize it — drawing to a
//! crossterm alt-screen, capturing for tests, or (later) mapping to tmux panes.
//! Keeping this trait here (with no terminal deps) lets the runtime and
//! renderers stay device-independent.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::Stream;

use crate::input::Event;

/// Type alias for the async event stream a [`Backend`] can produce.
pub type EventStream = Pin<Box<dyn Stream<Item = io::Result<Event>> + Send>>;

/// A rectangle in terminal cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Rect {
  pub x: u16,
  pub y: u16,
  pub w: u16,
  pub h: u16,
}

/// What a pane's lines MEAN, carried beside them: the structured value the
/// pane rendered (a `{"shape": "table/v1", …}` map), the semantic path of each
/// rendered line, and per-row attributes — exactly what the shape registry
/// produced the lines from (`tento_shapes::ShapeOutput`).
///
/// A terminal backend ignores it; the lines are authoritative and complete.
/// A device that can do more than paint cells — a browser — uses it to render
/// the shape natively, or to augment the painted lines with roles, selection
/// and hit targets, degrading to the bare lines whenever it cannot. Panes that
/// render plain strings carry none.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct PaneSemantics {
  /// The pane's scene key (`pane/custom :key`), when it has one.
  pub key: Option<String>,
  /// The rendered value, as the JSON the shape registry consumed.
  pub shape: serde_json::Value,
  /// One semantic path per rendered line (`None` for unaddressable rows).
  pub paths: Vec<Option<String>>,
  /// Per-row attributes, keyed by path.
  pub attrs: Vec<(String, Vec<(String, String)>)>,
}

/// One pane placed on the screen: its rect, its (full) rendered lines, the
/// vertical scroll offset into those lines, and whether it holds focus.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct PaneSlot {
  pub rect: Rect,
  pub lines: Vec<String>,
  pub scroll: usize,
  pub focused: bool,
  /// The structure behind `lines`, when the pane rendered a shape.
  #[serde(skip_serializing_if = "Option::is_none", serialize_with = "semantics_ref")]
  pub semantics: Option<Arc<PaneSemantics>>,
}

/// Shared, so a cached render hands the same semantics to every frame without
/// copying the shape; serialized through the reference (serde's `rc` feature
/// is not enabled workspace-wide).
fn semantics_ref<S: serde::Serializer>(
  semantics: &Option<Arc<PaneSemantics>>,
  serializer: S,
) -> Result<S::Ok, S::Error> {
  serde::Serialize::serialize(&semantics.as_deref(), serializer)
}

/// A composed screen: the terminal size and the panes to realize.
///
/// Serializes as `tui.frame/v1`, the wire form a non-terminal device (a
/// browser, a recorder) receives.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Frame {
  /// The focused input cursor in screen coordinates, independent of text.
  pub cursor: Option<(u16, u16)>,
  pub size: (u16, u16),
  pub panes: Vec<PaneSlot>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Capabilities {
  pub mouse: bool,
  pub sync_output: bool,
}

/// A device the compositor presents frames to.
pub trait Backend {
  /// Acquire the screen (alt-screen / raw mode / …).
  fn enter(&mut self) -> io::Result<()>;
  /// Restore the screen and stop consuming terminal input before returning.
  /// The event stream may still be polled by a background task while a
  /// foreground program owns the tty. `enter` resumes input consumption.
  /// Also called on drop by well-behaved backends.
  fn leave(&mut self) -> io::Result<()>;
  /// Current device size in cells.
  fn size(&self) -> io::Result<(u16, u16)>;
  fn capabilities(&self) -> Capabilities;
  /// Next input event, or `None` if `timeout` elapsed with no event.
  fn next_event(&mut self, timeout: Duration) -> io::Result<Option<Event>>;
  /// Take ownership of the backend's async event stream. The async
  /// compositor loop calls this once at startup and selects on the
  /// resulting [`Stream`] alongside file-change events.
  ///
  /// Returns `None` if this backend doesn't support async streaming
  /// (the sync [`next_event`](Self::next_event) is then the only event
  /// path). Backends that DO support streaming must yield the stream
  /// at most once; subsequent calls return `None`.
  ///
  /// Backends are free to keep `present`/`enter`/`leave` synchronous —
  /// the stream is a parallel concern. crossterm's `EventStream` reads
  /// from the same stdin as `next_event` does internally, so callers
  /// must NOT mix sync and async event paths within one session.
  fn take_event_stream(&mut self) -> Option<EventStream> {
    None
  }
  /// Set the terminal's tab/window title (OSC 0/2 on a real terminal).
  ///
  /// Constraints:
  ///
  /// * **Idempotent** — setting the same string twice is a no-op for the user;
  ///   backends need not deduplicate.
  /// * **Per change, not per frame** — callers invoke this only when the title
  ///   actually changed. A backend must not have to rate-limit it, and the
  ///   compositor must never call it from the paint path.
  /// * Devices with no title (test capture, tmux-pane mapping) keep the
  ///   default no-op, so every existing [`Backend`] impl stays valid.
  fn set_title(&mut self, _title: &str) -> io::Result<()> {
    Ok(())
  }
  /// Ring the terminal's bell (BEL on a real terminal) — the universal
  /// "this tab wants you" mark: terminals flag the tab (kitty's
  /// `bell_symbol`, iTerm's dot) and clear the flag on focus, locally and
  /// over SSH, with no configuration.
  ///
  /// Same constraints as [`set_title`](Self::set_title): **per change, never
  /// per frame** — the caller rings on a state *transition*, so a backend
  /// must not have to rate-limit it, and the compositor must never call it
  /// from the paint path. Devices with no bell keep the default no-op.
  fn bell(&mut self) -> io::Result<()> {
    Ok(())
  }
  /// Switch the device into **inline** mode instead of [`enter`](Self::enter):
  /// raw input, but no alt screen and no mouse capture. The app draws only a
  /// live region at the bottom of the normal buffer; everything above it
  /// belongs to the terminal, which keeps ownership of scrollback and wheel
  /// scrolling (the model plain CLIs — and the Claude CLI — use, and the
  /// reason their history scrolling is pixel-smooth: the app never sees a
  /// wheel event).
  ///
  /// Returns `Ok(false)` when the device has no inline mode (test captures,
  /// pane-mapping backends); the caller falls back to the composed screen.
  /// While inline, [`present`](Self::present) realizes the frame as the live
  /// region — `frame.size` is the region's size, not the device's — and
  /// [`commit_lines`](Self::commit_lines) emits rows permanently above it.
  fn enter_inline(&mut self) -> io::Result<bool> {
    Ok(false)
  }
  /// Emit rows **permanently** above the inline live region: they scroll into
  /// the terminal's own scrollback and are never repainted or repositioned.
  /// A no-op outside inline mode.
  fn commit_lines(&mut self, _lines: &[String]) -> io::Result<()> {
    Ok(())
  }
  /// Realize a composed frame on the device.
  fn present(&mut self, frame: &Frame) -> io::Result<()>;
}
