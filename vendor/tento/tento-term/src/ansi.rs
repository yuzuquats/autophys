//! Raw ANSI SGR escape sequences, as `&'static str` so callers (and the
//! `tento-core::term` re-export) can splice them straight into format strings.

pub const EMPTY: &str = "";

pub const BLACK: &str = "\u{001b}[30m";
pub const RED: &str = "\u{001b}[31m";
pub const GREEN: &str = "\u{001b}[32m";
pub const YELLOW: &str = "\u{001b}[33m";
pub const BLUE: &str = "\u{001b}[34m";
pub const MAGENTA: &str = "\u{001b}[35m";
pub const CYAN: &str = "\u{001b}[36m";
pub const WHITE: &str = "\u{001b}[37m";

/// 256-colour index 238 — a dim neutral grey (same as `tento-core::term::GRAY`).
pub const GRAY: &str = "\u{001b}[38;5;238m";

pub const BOLD: &str = "\u{001b}[1m";
pub const DIMMED: &str = "\u{001b}[2m";

pub const RESET: &str = "\u{001b}[0m";

/// Is `esc` an SGR reset (`\x1b[0m` or `\x1b[m`)?
pub(crate) fn is_reset(esc: &str) -> bool {
  esc == "\u{001b}[0m" || esc == "\u{001b}[m"
}
