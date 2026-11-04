//! Hidden multiline terminal input. Plaintext never goes through a renderer or logger.
use std::io::{self, IsTerminal, Write};

use anyhow::{Context, Result, bail};
use crossterm::{
  event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind, KeyModifiers,
  },
  execute,
  terminal::{disable_raw_mode, enable_raw_mode, is_raw_mode_enabled},
};
use zeroize::Zeroizing;

use crate::SecretBytes;

struct HiddenInput {
  restore_cooked: bool,
}

impl HiddenInput {
  fn enter() -> Result<Self> {
    let restore_cooked = !is_raw_mode_enabled()?;
    enable_raw_mode().context("Could not hide secret input")?;
    let guard = Self { restore_cooked };
    execute!(io::stderr(), EnableBracketedPaste)?;
    Ok(guard)
  }
}

impl Drop for HiddenInput {
  fn drop(&mut self) {
    let _ = execute!(io::stderr(), DisableBracketedPaste);
    if self.restore_cooked {
      let _ = disable_raw_mode();
    }
    let mut terminal = io::stderr();
    let _ = terminal.write_all(b"\r\n");
    let _ = terminal.flush();
  }
}

/// Read UTF-8 text without echoing, including multiline bracketed paste.
/// Ctrl-D finishes; Esc or Ctrl-C cancels. `prompt` is printed only after echo
/// is disabled. The caller must own the terminal's input while this runs.
/// No clipboard API, temporary file, history, or tracing sink is involved.
pub fn read_secret_multiline(prompt: &str, max_bytes: usize) -> Result<SecretBytes> {
  if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
    bail!("Hidden secret input requires an interactive terminal");
  }
  if max_bytes == 0 || max_bytes > 16 * 1024 * 1024 {
    bail!("Secret input limit must be between 1 byte and 16 MiB");
  }
  let _input = HiddenInput::enter()?;
  io::stderr().write_all(prompt.as_bytes())?;
  io::stderr().flush()?;
  // Reserve the limit up front so growing the buffer cannot leave copies in
  // old allocations. SecretBytes owns zeroing after the completed read.
  let mut bytes = Zeroizing::new(Vec::with_capacity(max_bytes));
  loop {
    match event::read().context("Could not read secret input")? {
      Event::Paste(value) => {
        let value = Zeroizing::new(value);
        append(&mut bytes, value.as_bytes(), max_bytes)?;
      }
      Event::Key(key) if key.kind != KeyEventKind::Release => {
        if key.code == KeyCode::Esc
          || (key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c'))
        {
          bail!("Secret input cancelled; nothing was saved");
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('d') {
          if bytes.is_empty() {
            bail!("No secret text was entered; nothing was saved");
          }
          return Ok(SecretBytes::new(std::mem::take(&mut *bytes)));
        }
        match key.code {
          KeyCode::Enter => append(&mut bytes, b"\n", max_bytes)?,
          KeyCode::Tab => append(&mut bytes, b"\t", max_bytes)?,
          KeyCode::Backspace => {
            // Remove one UTF-8 character and erase the removed bytes too.
            while let Some(last) = bytes.last_mut() {
              let continuation = *last & 0xc0 == 0x80;
              *last = 0;
              bytes.pop();
              if !continuation {
                break;
              }
            }
          }
          KeyCode::Char(c)
            if !key
              .modifiers
              .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
          {
            let mut encoded = Zeroizing::new([0u8; 4]);
            append(
              &mut bytes,
              c.encode_utf8(&mut *encoded).as_bytes(),
              max_bytes,
            )?;
          }
          _ => {}
        }
      }
      _ => {}
    }
  }
}

fn append(bytes: &mut Vec<u8>, value: &[u8], max_bytes: usize) -> Result<()> {
  if value.len() > max_bytes.saturating_sub(bytes.len()) {
    bail!("Secret text exceeds the input limit; nothing was saved");
  }
  bytes.extend_from_slice(value);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bounded_input_errors_never_include_the_secret() {
    let mut bytes = Vec::new();
    append(&mut bytes, b"key", 3).unwrap();
    let error = append(&mut bytes, b"do-not-disclose", 3).unwrap_err();
    assert_eq!(bytes, b"key");
    assert!(!error.to_string().contains("do-not-disclose"));
  }
}
