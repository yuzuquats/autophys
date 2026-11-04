//! Resize-aware live rendering (feature `watch`).
//!
//! Two entrypoints, both feature-gated:
//!
//! - [`watch`] — switch to the terminal's alternate screen + raw mode +
//!   mouse capture, then run an event loop that lets the user scroll a
//!   tall render with `↑/↓ j/k`, `PgUp/PgDn`, `Home/End g/G`, and the
//!   mouse wheel. A dimmed footer row shows the keybindings and
//!   `lines L–M of N`. Quits on Ctrl-C, `q`, or `Esc`.
//! - [`watch_with`] — like [`watch`], but also re-runs `render()` every
//!   `interval` so time-sensitive content stays fresh. The scroll offset
//!   is sticky across re-reads (only clamped when the snapshot shrinks).
//!
//! On exit (Ctrl-C / `q` / panic unwind), the RAII [`WatchGuard`] restores
//! cooked mode, mouse mode, cursor visibility, and the main screen.
//!
//! Mouse-capture caveat: while the watch is active the host terminal
//! forwards mouse events to us, so plain drag-select is consumed by the
//! app. Most terminals fall back to native selection if you hold
//! Option/Alt while dragging.
//!
//! This is the slim, single-pane-viewer surface. For interactive
//! multi-pane TUIs (composer, scene DSL, file-watch repaints), use
//! [`tento-tui`](https://docs.rs/tento-tui).

use std::io::{self, Write};
use std::time::Duration;

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{
  DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent,
  MouseEventKind, poll, read,
};
use crossterm::terminal::{
  Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
  size,
};
use crossterm::{execute, queue};

use crate::pad::truncate_ellipsis;
use crate::style::Style;
use crate::width::visual_width;

// ---------------------------------------------------------------------------
// Watch session: alt-screen + raw mode + mouse capture, with scrollable view.
// ---------------------------------------------------------------------------

struct WatchGuard;

impl WatchGuard {
  fn enter<W: Write>(out: &mut W) -> io::Result<Self> {
    enable_raw_mode()?;
    execute!(
      out,
      EnterAlternateScreen,
      EnableMouseCapture,
      Hide,
      Clear(ClearType::All),
      MoveTo(0, 0)
    )?;
    Ok(WatchGuard)
  }
}

impl Drop for WatchGuard {
  fn drop(&mut self) {
    let _ = execute!(
      std::io::stdout(),
      Show,
      DisableMouseCapture,
      LeaveAlternateScreen
    );
    let _ = disable_raw_mode();
  }
}

fn is_ctrl_c(k: &KeyEvent) -> bool {
  matches!(k.code, KeyCode::Char('c')) && k.modifiers.contains(KeyModifiers::CONTROL)
}

fn is_quit(k: &KeyEvent) -> bool {
  is_ctrl_c(k)
    || matches!(
      k.code,
      KeyCode::Char('q') | KeyCode::Char('Q') | KeyCode::Esc
    )
}

/// One "frame" of state: the rendered lines, scroll offset, terminal
/// size, and last-paint bookkeeping for the diff redraw. A 1-row
/// footer occupies the bottom; the viewport above it scrolls.
struct ViewState {
  lines: Vec<String>,
  offset: usize,
  cols: u16,
  rows: u16,
  /// How many viewport rows the previous [`redraw`] painted with content
  /// (excludes the footer). Used to erase only the rows a shrinking
  /// frame leaves behind, so we never `Clear(All)` on a normal tick.
  last_painted_rows: usize,
  /// One-shot request for a full alt-screen clear before the next paint.
  full_clear: bool,
}

impl ViewState {
  /// Footer height — fixed at 1.
  const FOOTER_ROWS: u16 = 1;

  fn viewport_h(&self) -> usize {
    (self.rows as usize).saturating_sub(Self::FOOTER_ROWS as usize)
  }

  fn max_offset(&self) -> usize {
    self.lines.len().saturating_sub(self.viewport_h())
  }

  fn clamp(&mut self) {
    let m = self.max_offset();
    if self.offset > m {
      self.offset = m;
    }
  }
}

/// Returns `true` if the offset changed.
fn scroll_key(state: &mut ViewState, k: &KeyEvent) -> bool {
  let viewport_h = state.viewport_h();
  let max_offset = state.max_offset();
  let before = state.offset;
  state.offset = match k.code {
    KeyCode::Up | KeyCode::Char('k') => state.offset.saturating_sub(1),
    KeyCode::Down | KeyCode::Char('j') => (state.offset + 1).min(max_offset),
    KeyCode::PageUp => state.offset.saturating_sub(viewport_h),
    KeyCode::PageDown => (state.offset + viewport_h).min(max_offset),
    KeyCode::Home | KeyCode::Char('g') => 0,
    KeyCode::End | KeyCode::Char('G') => max_offset,
    _ => state.offset,
  };
  state.offset != before
}

/// Returns `true` if the offset changed.
fn scroll_mouse(state: &mut ViewState, m: &MouseEvent) -> bool {
  let max_offset = state.max_offset();
  let before = state.offset;
  state.offset = match m.kind {
    MouseEventKind::ScrollUp => state.offset.saturating_sub(3),
    MouseEventKind::ScrollDown => (state.offset + 3).min(max_offset),
    _ => state.offset,
  };
  state.offset != before
}

/// One-row footer: keybind hints on the left, scroll-position on the
/// right; dimmed.
fn footer_text(offset: usize, end: usize, total: usize, cols: usize) -> String {
  let keys = "↑↓ scroll · PgUp/PgDn page · g/G top/bottom · q quit";
  let pos = if total == 0 {
    "empty".to_string()
  } else {
    let from = offset + 1;
    let to = end.max(from);
    format!("lines {from}–{to} of {total}")
  };
  let raw = format!("{keys}  │  {pos}");
  let fit = if visual_width(&raw) > cols {
    truncate_ellipsis(&raw, cols, "…")
  } else {
    raw
  };
  Style::Dimmed.paint(&fit)
}

/// DECSET 2026 — synchronized output. Terminals that support it (iTerm2 ≥3.5,
/// WezTerm, Kitty, foot, Alacritty, contour, ghostty, recent xterm/Windows
/// Terminal) batch all writes between BSU and ESU into a single atomic paint,
/// so the user never sees a half-drawn frame. Unsupported terminals ignore the
/// sequence, which is fine — the [`redraw`] body is already efficient enough
/// to not flicker on its own once `Clear(All)` is gone.
const BEGIN_SYNC: &str = "\u{1b}[?2026h";
const END_SYNC: &str = "\u{1b}[?2026l";

/// Redraw the alt-screen: viewport slice of `state.lines` from row 0,
/// then the 1-row footer.
///
/// We *don't* `Clear(All)` every frame — that's what made the periodic
/// tick flicker. Each rewritten line carries its own `ESC[K`, so a
/// same-or-taller repaint clears its own tail. For shrinking frames, we
/// erase only the rows the previous frame painted but this one doesn't
/// (`last_painted_rows`). `Resize` events force a one-shot full clear
/// via `full_clear` because the terminal can leave stale rows behind.
///
/// The whole sequence is wrapped in DECSET 2026 (synchronized output)
/// so terminals that support it commit the frame atomically.
fn redraw<W: Write>(out: &mut W, state: &mut ViewState) -> io::Result<()> {
  let viewport_h = state.viewport_h();
  let total = state.lines.len();
  let max_offset = state.max_offset();
  let offset = state.offset.min(max_offset);
  let end = (offset + viewport_h).min(total);
  let painted = end - offset;

  write!(out, "{BEGIN_SYNC}")?;

  if state.full_clear {
    queue!(out, Clear(ClearType::All))?;
    state.full_clear = false;
  }
  queue!(out, MoveTo(0, 0))?;
  for i in offset..end {
    write!(out, "{}\u{1b}[K\r\n", state.lines[i])?;
  }
  // Erase rows the previous frame painted but this one doesn't (shrinking
  // tree). Capped at the viewport so we never spill into the footer.
  let stale = state
    .last_painted_rows
    .saturating_sub(painted)
    .min(viewport_h.saturating_sub(painted));
  for _ in 0..stale {
    write!(out, "\u{1b}[K\r\n")?;
  }

  // 1-row footer at the bottom.
  let footer_row = state.rows.saturating_sub(ViewState::FOOTER_ROWS);
  queue!(out, MoveTo(0, footer_row))?;
  let footer = footer_text(offset, end, total, state.cols as usize);
  write!(out, "{footer}\u{1b}[K")?;

  write!(out, "{END_SYNC}")?;
  out.flush()?;

  state.last_painted_rows = painted;
  Ok(())
}

fn fresh_state(lines: Vec<String>, cols: u16, rows: u16) -> ViewState {
  ViewState {
    lines,
    offset: 0,
    cols,
    rows,
    last_painted_rows: 0,
    full_clear: false, // WatchGuard::enter already cleared the alt-screen
  }
}

/// Draw `render()` once on the alternate screen, then re-draw it on every
/// terminal resize or scroll input. Returns cleanly on Ctrl-C, `q`, or `Esc`.
pub fn watch<W: Write>(out: &mut W, mut render: impl FnMut() -> Vec<String>) -> io::Result<()> {
  let _guard = WatchGuard::enter(out)?;
  let (cols, rows) = size().unwrap_or((80, 24));
  let mut state = fresh_state(render(), cols, rows);
  redraw(out, &mut state)?;
  loop {
    match read()? {
      Event::Resize(c, r) => {
        handle_resize(&mut state, c, r, &mut render);
        redraw(out, &mut state)?;
      }
      Event::Key(k) if is_quit(&k) => break,
      Event::Key(k) => {
        if scroll_key(&mut state, &k) {
          redraw(out, &mut state)?;
        }
      }
      Event::Mouse(m) => {
        if scroll_mouse(&mut state, &m) {
          redraw(out, &mut state)?;
        }
      }
      _ => {}
    }
  }
  Ok(())
}

/// Like [`watch`], but also re-runs `render()` every `interval` so
/// time-sensitive content stays fresh. `interval` is floored at 50 ms.
///
/// Sticky scroll: when the periodic tick replaces `state.lines`, the
/// offset is preserved (only clamped if the new line count is shorter
/// than the previous one).
pub fn watch_with<W: Write>(
  out: &mut W,
  interval: Duration,
  mut render: impl FnMut() -> Vec<String>,
) -> io::Result<()> {
  let _guard = WatchGuard::enter(out)?;
  let interval = interval.max(Duration::from_millis(50));
  let (cols, rows) = size().unwrap_or((80, 24));
  let mut state = fresh_state(render(), cols, rows);
  redraw(out, &mut state)?;
  loop {
    if poll(interval)? {
      match read()? {
        Event::Resize(c, r) => {
          handle_resize(&mut state, c, r, &mut render);
          redraw(out, &mut state)?;
        }
        Event::Key(k) if is_quit(&k) => break,
        Event::Key(k) => {
          if scroll_key(&mut state, &k) {
            redraw(out, &mut state)?;
          }
        }
        Event::Mouse(m) => {
          if scroll_mouse(&mut state, &m) {
            redraw(out, &mut state)?;
          }
        }
        _ => {}
      }
    } else {
      // Periodic tick: re-read content; redraw only if it changed.
      let next = render();
      if next != state.lines {
        state.lines = next;
        state.clamp();
        redraw(out, &mut state)?;
      }
    }
  }
  Ok(())
}

/// Common terminal-resize bookkeeping for both watch loops:
///   1. Record the new (cols, rows) on `state`.
///   2. Re-invoke `render()` so `state.lines` carry the freshly-sized
///      output. Without this step, lines wider than the new terminal wrap
///      into adjacent rows on the next paint and tmux captures the overflow
///      as zombie artifacts.
///   3. Re-clamp the scroll offset against the new viewport height.
///   4. Force a one-shot `Clear(All)` on the next `redraw` so any stale
///      cells outside the new viewport bounds get erased.
fn handle_resize(
  state: &mut ViewState,
  cols: u16,
  rows: u16,
  render: &mut impl FnMut() -> Vec<String>,
) {
  state.cols = cols;
  state.rows = rows;
  state.lines = render();
  state.clamp();
  state.full_clear = true;
}

#[cfg(test)]
mod tests {
  use super::*;

  fn state_with(n: usize, rows: u16) -> ViewState {
    let lines = (1..=n).map(|i| format!("line {i}")).collect();
    fresh_state(lines, 80, rows)
  }

  fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
  }

  #[test]
  fn scroll_down_stops_at_max_offset() {
    let mut s = state_with(20, 6); // viewport_h = 5; max_offset = 15
    for _ in 0..30 {
      scroll_key(&mut s, &key(KeyCode::Down));
    }
    assert_eq!(s.offset, 15);
  }

  #[test]
  fn scroll_up_does_not_go_negative() {
    let mut s = state_with(20, 6);
    s.offset = 2;
    scroll_key(&mut s, &key(KeyCode::Up));
    scroll_key(&mut s, &key(KeyCode::Up));
    scroll_key(&mut s, &key(KeyCode::Up));
    assert_eq!(s.offset, 0);
  }

  #[test]
  fn page_down_advances_by_viewport_height() {
    let mut s = state_with(20, 6); // viewport_h = 5
    scroll_key(&mut s, &key(KeyCode::PageDown));
    assert_eq!(s.offset, 5);
    scroll_key(&mut s, &key(KeyCode::PageDown));
    assert_eq!(s.offset, 10);
  }

  #[test]
  fn home_and_end_jump() {
    let mut s = state_with(20, 6); // max_offset = 15
    scroll_key(&mut s, &key(KeyCode::End));
    assert_eq!(s.offset, 15);
    scroll_key(&mut s, &key(KeyCode::Home));
    assert_eq!(s.offset, 0);
    // vim-style g/G
    scroll_key(&mut s, &key(KeyCode::Char('G')));
    assert_eq!(s.offset, 15);
    scroll_key(&mut s, &key(KeyCode::Char('g')));
    assert_eq!(s.offset, 0);
  }

  #[test]
  fn j_and_k_scroll_one_line() {
    let mut s = state_with(20, 6);
    scroll_key(&mut s, &key(KeyCode::Char('j')));
    assert_eq!(s.offset, 1);
    scroll_key(&mut s, &key(KeyCode::Char('j')));
    assert_eq!(s.offset, 2);
    scroll_key(&mut s, &key(KeyCode::Char('k')));
    assert_eq!(s.offset, 1);
  }

  #[test]
  fn scroll_offset_clamps_when_snapshot_shrinks() {
    let mut s = state_with(20, 6); // max_offset = 15
    s.offset = 15;
    // Snapshot shrinks to 8 lines → viewport_h still 5 → new max_offset = 3
    s.lines = (1..=8).map(|i| format!("line {i}")).collect();
    s.clamp();
    assert_eq!(s.offset, 3);
  }

  #[test]
  fn mouse_scroll_three_lines_per_notch() {
    let mut s = state_with(20, 6);
    let m = |kind| MouseEvent {
      kind,
      column: 0,
      row: 0,
      modifiers: KeyModifiers::NONE,
    };
    scroll_mouse(&mut s, &m(MouseEventKind::ScrollDown));
    assert_eq!(s.offset, 3);
    scroll_mouse(&mut s, &m(MouseEventKind::ScrollDown));
    assert_eq!(s.offset, 6);
    scroll_mouse(&mut s, &m(MouseEventKind::ScrollUp));
    assert_eq!(s.offset, 3);
  }

  #[test]
  fn quit_keys() {
    assert!(is_quit(&key(KeyCode::Char('q'))));
    assert!(is_quit(&key(KeyCode::Char('Q'))));
    assert!(is_quit(&key(KeyCode::Esc)));
    assert!(is_quit(&KeyEvent::new(
      KeyCode::Char('c'),
      KeyModifiers::CONTROL
    )));
    assert!(!is_quit(&key(KeyCode::Char('x'))));
  }

  // -- redraw output ------------------------------------------------------

  #[test]
  fn redraw_emits_only_visible_slice_and_footer() {
    // colour off so footer style doesn't add ANSI codes.
    colored::control::set_override(false);
    let lines: Vec<String> = (1..=20).map(|i| format!("line {i:02}")).collect();
    let mut state = fresh_state(lines, 80, 5);
    state.offset = 7;
    let mut buf: Vec<u8> = Vec::new();
    redraw(&mut buf, &mut state).unwrap();
    let s = String::from_utf8(buf).unwrap();

    // Visible window is lines[7..11] = line 08..line 11.
    assert!(s.contains("line 08"));
    assert!(s.contains("line 09"));
    assert!(s.contains("line 10"));
    assert!(s.contains("line 11"));
    assert!(!s.contains("line 07"));
    assert!(!s.contains("line 12"));

    // Footer reports the visible-window slice.
    assert!(
      s.contains("lines 8–11 of 20"),
      "footer missing slice info: {s:?}"
    );
    // last_painted_rows reflects the 4 viewport rows we just drew.
    assert_eq!(state.last_painted_rows, 4);
    colored::control::unset_override();
  }

  #[test]
  fn redraw_wraps_in_synchronized_output_and_skips_clear_all() {
    colored::control::set_override(false);
    let mut state = state_with(8, 5); // viewport_h = 4
    let mut buf: Vec<u8> = Vec::new();
    redraw(&mut buf, &mut state).unwrap();
    buf.clear();
    redraw(&mut buf, &mut state).unwrap();
    let s = String::from_utf8(buf).unwrap();

    // DECSET 2026 begin/end wrap the whole redraw.
    assert!(
      s.starts_with("\u{1b}[?2026h"),
      "missing BSU at start: {s:?}"
    );
    assert!(s.ends_with("\u{1b}[?2026l"), "missing ESU at end: {s:?}");
    // No Clear(All) on a steady-state tick.
    assert!(
      !s.contains("\u{1b}[2J"),
      "unexpected Clear(All) escape: {s:?}"
    );
    colored::control::unset_override();
  }

  #[test]
  fn redraw_emits_clear_all_only_when_full_clear_is_requested() {
    colored::control::set_override(false);
    let mut state = state_with(8, 5);
    state.full_clear = true;
    let mut buf: Vec<u8> = Vec::new();
    redraw(&mut buf, &mut state).unwrap();
    let s = String::from_utf8(buf).unwrap();

    assert!(
      s.contains("\u{1b}[2J"),
      "expected Clear(All) when full_clear set: {s:?}"
    );
    // Flag should be consumed after the paint.
    assert!(!state.full_clear);
    colored::control::unset_override();
  }

  #[test]
  fn shrinking_frame_erases_only_stale_rows() {
    // Frame 1: 4 lines fill the viewport.
    colored::control::set_override(false);
    let mut state = state_with(4, 5); // viewport_h = 4
    let mut buf: Vec<u8> = Vec::new();
    redraw(&mut buf, &mut state).unwrap();
    assert_eq!(state.last_painted_rows, 4);

    // Frame 2: shrink to 1 line — expect 3 stale rows erased with ESC[K\r\n,
    // and no Clear(All).
    state.lines = vec!["only".to_string()];
    buf.clear();
    redraw(&mut buf, &mut state).unwrap();
    let s = String::from_utf8(buf).unwrap();
    assert!(s.contains("only\u{1b}[K\r\n"), "missing content row: {s:?}");
    let stale_erases = s.matches("\u{1b}[K\r\n").count();
    // 1 content row + 3 stale-row erases = 4 occurrences.
    assert_eq!(
      stale_erases, 4,
      "expected 1 content + 3 stale erases, got {stale_erases}: {s:?}"
    );
    assert!(
      !s.contains("\u{1b}[2J"),
      "Clear(All) leaked into shrink path: {s:?}"
    );
    assert_eq!(state.last_painted_rows, 1);
    colored::control::unset_override();
  }
}
