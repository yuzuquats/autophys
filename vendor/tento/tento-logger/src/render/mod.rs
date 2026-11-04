//! Rendering logic for tento-logger.
//!
//! This module contains functions for rendering LJSON entries to various formats,
//! primarily terminal output with ANSI colors.

#[cfg(feature = "spans")]
pub mod project;
pub mod terminal;

pub use terminal::{
  render_entry, render_session, render_session_to, render_unified, render_unified_to,
};
