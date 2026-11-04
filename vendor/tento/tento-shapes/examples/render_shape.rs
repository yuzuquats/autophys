//! Read a retained shape from stdin and paint it with the Threads dark reference
//! roles. This probe exercises the actual shape registry, not a second layout.
use std::io::{self, Read};

use tento_shapes::{RenderCtx, ShapeRegistry};
use tento_term::RoleTable;

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let width: u16 = std::env::args()
    .nth(1)
    .unwrap_or_else(|| "80".into())
    .parse()?;
  if !(20..=500).contains(&width) {
    return Err("width must be 20..500".into());
  }
  let mut input = String::new();
  io::stdin()
    .take(16 * 1024 * 1024 + 1)
    .read_to_string(&mut input)?;
  if input.len() > 16 * 1024 * 1024 {
    return Err("shape exceeds 16 MiB".into());
  }
  let value = serde_json::from_str(&input)?;
  let mut roles = RoleTable::new();
  for (role, style) in [
    ("text", "fg:#cbd0d7"),
    ("text.primary", "fg:#cbd0d7"),
    ("text.secondary", "fg:#6c7086"),
    ("text.faint", "fg:#45475a"),
    ("status.warn", "fg:#d3a027"),
    ("status.error", "fg:#d77757"),
  ] {
    roles.bind(role, style);
  }
  tento_term::force_color(true);
  let registry = ShapeRegistry::core();
  let rendered =
    tento_term::with_roles(roles, || registry.render(&value, width, &RenderCtx::cli()))
      .ok_or("shape is not supported")?;
  for line in rendered.lines {
    println!("{line}");
  }
  Ok(())
}
