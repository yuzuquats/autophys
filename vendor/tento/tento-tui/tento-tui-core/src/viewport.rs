//! The slice of screen a renderer draws into.

use serde::{Deserialize, Serialize};

/// The rect a renderer is asked to fill, in terminal cells, plus the vertical
/// scroll `offset` the compositor wants. A controlled renderer draws to `cols`
/// width and may use `rows`/`offset` to self-slice tall content (or render all
/// lines and let the compositor slice — see [`crate::renderer`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
  pub cols: u16,
  pub rows: u16,
  pub offset: usize,
}

impl Viewport {
  /// A viewport at the top (`offset = 0`).
  pub fn new(cols: u16, rows: u16) -> Self {
    Viewport {
      cols,
      rows,
      offset: 0,
    }
  }
}
