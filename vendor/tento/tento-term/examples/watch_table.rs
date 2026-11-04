//! Live, resize-aware table demo.
//!
//!   cargo run -p tento-term --features watch --example watch_table
//!
//! Run it in a real terminal: drag the window narrower/wider to watch the table
//! re-flow (columns shrink, then the lowest-priority ones demote to `├──/└──`
//! sub-lines, then un-demote when you widen it again). The "Now (s)" cell ticks
//! once a second. Ctrl-C to quit — the shell prompt lands right below the table.

use std::io;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tento_term::{Align, Cell, Column, Style, Table, term_columns, watch_with};

fn build() -> Table {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  let mut t = Table::new(vec![
    Column::new("Service").min(8).priority(0),
    Column::new("State").min(6).priority(1),
    Column::new("Now (s)")
      .align(Align::Right)
      .min(8)
      .priority(2),
    Column::new("Note").min(20).priority(3),
  ])
  .title(Cell::new(
    "watch_table — resize me; Ctrl-C to quit",
    Style::Bold,
  ))
  .header_style(Style::Dimmed);
  t.push_row(vec![
    Cell::plain("api"),
    Cell::new("running", Style::Green),
    Cell::plain(now.to_string()),
    Cell::plain("primary edge node, us-west"),
  ]);
  t.push_row(vec![
    Cell::plain("worker"),
    Cell::new("stopped", Style::Red),
    Cell::plain(now.to_string()),
    Cell::plain("awaiting manual restart"),
  ]);
  t.push_row(vec![
    Cell::plain("cache"),
    Cell::new("degraded", Style::Yellow),
    Cell::plain(now.to_string()),
    Cell::plain("ok"),
  ]);
  t
}

fn main() -> io::Result<()> {
  let mut out = io::stdout();
  watch_with(&mut out, Duration::from_secs(1), || {
    build().render_lines(term_columns())
  })
}
