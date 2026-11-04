//! Neutral input events — the crossterm-isolation seam.
//!
//! Backends translate their native events (crossterm `KeyEvent`/`MouseEvent`/
//! resize) into these types so the runtime and renderers never depend on a
//! terminal library.

/// Terminal rows advanced by one discrete mouse-wheel event.
///
/// Keep wheel movement finer than keyboard paging: terminals already emit a
/// burst of events for a fast wheel/trackpad gesture, so multiplying each
/// event here makes the viewport jump.
pub const WHEEL_SCROLL_ROWS: usize = 1;

/// Keyboard modifiers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
  pub ctrl: bool,
  pub alt: bool,
  pub shift: bool,
}

/// A key, device-independent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyCode {
  Char(char),
  Enter,
  Backspace,
  Delete,
  Left,
  Right,
  Up,
  Down,
  Home,
  End,
  PageUp,
  PageDown,
  Esc,
  Tab,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
  pub code: KeyCode,
  pub mods: Mods,
}

impl Key {
  /// Canonical name for this key event — the shared vocabulary of every
  /// key-as-data surface (`(bind-key "…")` / `(key "…")` in tento-sh-tui, an
  /// L0 `pane/custom` `:on-event` handler's key argument). Plain characters
  /// are themselves (`"!"`, `"a"`; the terminal delivers shifted characters
  /// pre-shifted, so Shift is only meaningful for `Shift-Tab`); modifiers
  /// prefix as `Ctrl-x` / `Alt-x`. `None` for events with no stable name.
  pub fn name(&self) -> Option<String> {
    let base = match self.code {
      KeyCode::Char(c) => c.to_string(),
      KeyCode::Tab if self.mods.shift => return Some("Shift-Tab".to_string()),
      KeyCode::Tab => "Tab".to_string(),
      KeyCode::Esc => "Esc".to_string(),
      KeyCode::Enter => "Enter".to_string(),
      KeyCode::Backspace => "Backspace".to_string(),
      KeyCode::Delete => "Delete".to_string(),
      KeyCode::Left => "Left".to_string(),
      KeyCode::Right => "Right".to_string(),
      KeyCode::Up => "Up".to_string(),
      KeyCode::Down => "Down".to_string(),
      KeyCode::Home => "Home".to_string(),
      KeyCode::End => "End".to_string(),
      KeyCode::PageUp => "PageUp".to_string(),
      KeyCode::PageDown => "PageDown".to_string(),
    };
    if self.mods.ctrl {
      Some(format!("Ctrl-{base}"))
    } else if self.mods.alt {
      Some(format!("Alt-{base}"))
    } else {
      Some(base)
    }
  }
}

/// Mouse input the panes consume: wheel + a left-button press (with the screen
/// cell pressed).
///
/// `DoubleClick` is synthesized by the runtime (see
/// `tento-tui-pane/src/runtime.rs`), not the backend — backends emit raw
/// `Down` events; the runtime detects two-in-a-row within a small time + row
/// window and re-dispatches the second one as `DoubleClick`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mouse {
  ScrollUp,
  ScrollDown,
  /// Left-button press at a screen cell.
  Down {
    row: u16,
    col: u16,
  },
  /// Synthetic event: a second `Down` arriving within the runtime's
  /// double-click window. Panes use this to engage row selection / open
  /// detail without stealing focus from the text-input pane on casual clicks.
  DoubleClick {
    row: u16,
    col: u16,
  },
}

/// One input/lifecycle event from a [`Backend`](crate::backend::Backend).
/// (`Paste` carries the bracketed-paste payload, so `Event` is `Clone`,
/// not `Copy`.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
  Key(Key),
  Mouse(Mouse),
  Resize(u16, u16),
  /// A bracketed paste: the whole pasted text in ONE event — newlines are
  /// content, never keystrokes. Terminals without bracketed-paste support
  /// degrade to per-key delivery.
  Paste(String),
}
