//! Terminal primitives — now living in the `tento-term` crate. This module is
//! a back-compat re-export so existing callers (`use tento_core::term::{...}`)
//! keep working.

pub use tento_term::{
  BLACK, BLUE, BOLD, CYAN, DIMMED, EMPTY, GRAY, GREEN, MAGENTA, RED, RESET, YELLOW,
};

/// Terminal column width. Back-compat shim around [`tento_term::term_columns`]
/// (kept returning `i32` for existing callers).
pub fn term_columns() -> i32 {
  tento_term::term_columns() as i32
}
