//! Live, resize-aware tree demo.
//!
//!   cargo run -p tento-term --features watch --example watch_tree
//!
//! Run it in a real terminal and drag the window narrower / wider — long
//! `label  detail` lines word-wrap onto continuation lines that carry the
//! node's `│   ` / `    ` prefix; widen the window and they snap back to one
//! line. The "Now" leaf ticks once a second. Ctrl-C to quit.
//!
//! Modelled on the `health.tree` output so you can see the exact behaviour
//! that prompted the wrap fix.

use std::io;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tento_term::{Cell, Node, Style, Tree, term_columns, watch_with};

fn check(icon: &str, icon_style: Style, label: &str, detail: &str) -> Node {
  let icon = icon_style.paint(icon);
  Node::leaf(Cell::raw(format!("{icon} {label}"))).with_detail(Cell::plain(detail.to_string()))
}

fn build() -> Tree {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);

  let root = Node::branch(
    Cell::raw(format!(
      "lona-control-pane health (demo) — {} ({})",
      "watch_tree".bold_like(),
      now
    )),
    vec![
      Node::branch(
        Cell::new("edge bypass", Style::Cyan),
        vec![check(
          "✓",
          Style::Green,
          "agent-validation token",
          "configured",
        )],
      ),
      Node::branch(
        Cell::new("admin.lona.so", Style::Green),
        vec![
          check("✓", Style::Green, "local origin", "200 ok"),
          check("✓", Style::Green, "public route", "200 ok"),
        ],
      ),
      Node::branch(
        Cell::new("paperclip.lona.so", Style::Magenta),
        vec![
          check(
            "✓",
            Style::Green,
            "local api",
            "deploymentMode=authenticated bootstrapStatus=ready bootstrapInviteActive=false",
          ),
          check(
            "✓",
            Style::Green,
            "public route",
            "deploymentMode=authenticated bootstrapStatus=ready bootstrapInviteActive=false",
          ),
          check("✓", Style::Green, "server container", "running (healthy)"),
          check("✓", Style::Green, "runner container", "running (healthy)"),
          check(
            "✗",
            Style::Red,
            "bridge container",
            "paperclip-lan-company-command-bridge-1: error: no such object: paperclip-lan-company-command-bridge-1",
          ),
          check(
            "✗",
            Style::Red,
            "bridge health",
            "curl failed: Error response from daemon: No such container: paperclip-lan-company-command-bridge-1",
          ),
        ],
      ),
      Node::branch(
        Cell::new("paperclip companies", Style::Yellow),
        vec![
          check("✓", Style::Green, "api", "2 rows"),
          Node::branch(
            Cell::plain("Doge Council · DOG · active"),
            vec![check("✓", Style::Green, "agents", "6 configured")],
          ),
          Node::branch(
            Cell::plain("KOL Triad Inc. · KOLA · active"),
            vec![check("✓", Style::Green, "agents", "10 configured")],
          ),
        ],
      ),
    ],
  );
  Tree::new(root)
}

// Tiny trait extension so the doc comment stays neat — `colored::Colorize` is
// re-exported from `tento_term` as a dep, but using the SGR escapes directly
// keeps the example self-contained.
trait BoldLike {
  fn bold_like(&self) -> String;
}
impl BoldLike for &str {
  fn bold_like(&self) -> String {
    Style::Bold.paint(self)
  }
}

fn main() -> io::Result<()> {
  let mut out = io::stdout();
  watch_with(&mut out, Duration::from_secs(1), || {
    build().render_lines(term_columns())
  })
}
