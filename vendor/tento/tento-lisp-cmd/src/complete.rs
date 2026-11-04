//! Command completion: the shell's adapter to the pane engine's completion
//! seam.
//!
//! The provider that understands `command.index/v1` lives next to the
//! reflection records it parses ([`crate::reflect`]) — the crate that *emits*
//! the shape provides its completion adapter. The shell contributes a provider
//! to the engine ([`tento_tui_complete`]); the engine never knows the shell.

use std::rc::Rc;

use serde_json::{Map, Value};

use tento_tui_complete::{Candidate, Provider};

/// Command completion off the shell's `command.index/v1` reflection value
/// (see [`crate::reflect`]). The value is fetched through an injected closure so
/// this provider never reaches into the shell registry directly —
/// `(complete.use :commands)` decides when it is live. Each leaf becomes a
/// candidate whose `insert` is the full dotted command path and whose `detail`
/// is the command's description.
pub struct CommandsProvider {
  source: Rc<dyn Fn() -> Value>,
}

impl CommandsProvider {
  /// Wire the reflection source. `source` returns a `command.index/v1` value
  /// (or a `tsh.app/v1` root — both are entry maps and are handled).
  pub fn new(source: Rc<dyn Fn() -> Value>) -> Self {
    CommandsProvider { source }
  }
}

impl Provider for CommandsProvider {
  fn name(&self) -> &str {
    "commands"
  }

  fn complete(&self, _prefix: &str) -> Vec<Candidate> {
    // Over-return the whole tree; the engine matches and ranks against the
    // prefix. Cheap in practice (a HashMap walk) and keeps the source dumb.
    let value = (self.source)();
    let mut out = Vec::new();
    // `command.index/v1` keys entries under `entries`; the `tsh.app/v1` root
    // keys them under `commands`. Both are `segment -> CommandEntry` maps.
    let entries = value
      .get("entries")
      .or_else(|| value.get("commands"))
      .and_then(Value::as_object);
    if let Some(entries) = entries {
      collect_commands(entries, "", self.name(), &mut out);
    }
    out
  }
}

/// Walk a `CommandEntry` map into dotted-path candidates. Nested
/// `command.index/v1` entries recurse with the segment appended to `base`; any
/// other entry is a leaf command (`command.doc/v1`) and yields one candidate.
/// The dotted path is rebuilt from the map keys, so it is correct regardless of
/// what a leaf's own `name` field carries.
fn collect_commands(
  entries: &Map<String, Value>,
  base: &str,
  source: &str,
  out: &mut Vec<Candidate>,
) {
  for (segment, entry) in entries {
    let path = if base.is_empty() {
      segment.clone()
    } else {
      format!("{base}.{segment}")
    };
    match entry.get("type").and_then(Value::as_str) {
      Some("command.index/v1") => {
        if let Some(sub) = entry.get("entries").and_then(Value::as_object) {
          collect_commands(sub, &path, source, out);
        }
      }
      _ => {
        let detail = entry
          .get("description")
          .and_then(Value::as_str)
          .unwrap_or("");
        out.push(Candidate::new(path, source, 0).with_detail(detail));
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// A `command.index/v1` fixture matching the real emitted shape: a nested
  /// namespace (`whoop`) plus a flat leaf, each entry `type`-tagged.
  fn command_index() -> Value {
    json!({
      "type": "command.index/v1",
      "entries": {
        "whoop": {
          "type": "command.index/v1",
          "entries": {
            "sleep": {
              "type": "command.doc/v1",
              "name": "whoop.sleep",
              "description": "recent sleep summary",
              "options": []
            }
          }
        },
        "session": {
          "type": "command.doc/v1",
          "name": "session",
          "description": "show the session",
          "options": []
        }
      }
    })
  }

  #[test]
  fn commands_provider_flattens_dotted_paths_with_descriptions() {
    let src = command_index();
    let provider = CommandsProvider::new(Rc::new(move || src.clone()));
    let mut got: Vec<(String, String)> = provider
      .complete("")
      .into_iter()
      .map(|c| (c.insert, c.detail))
      .collect();
    got.sort();
    assert_eq!(
      got,
      vec![
        ("session".to_string(), "show the session".to_string()),
        (
          "whoop.sleep".to_string(),
          "recent sleep summary".to_string()
        ),
      ]
    );
    // Every candidate is sourced "commands" (the styling policy keys on it).
    assert!(provider.complete("").iter().all(|c| c.source == "commands"));
  }

  /// A `command.alias/v1` leaf is a leaf like any other: the alias name is the
  /// insert and its (pre-composed) description is the detail — `ls` Tab-completes
  /// with no provider special-casing.
  #[test]
  fn alias_leaf_completes_with_composed_detail() {
    let src = json!({
      "type": "command.index/v1",
      "entries": {
        "ls": {
          "type": "command.alias/v1",
          "name": "ls",
          "target": "std.fs.list_dir",
          "description": "→ std.fs.list_dir — list directory entries"
        }
      }
    });
    let provider = CommandsProvider::new(Rc::new(move || src.clone()));
    let got: Vec<(String, String)> = provider
      .complete("")
      .into_iter()
      .map(|c| (c.insert, c.detail))
      .collect();
    assert_eq!(
      got,
      vec![(
        "ls".to_string(),
        "→ std.fs.list_dir — list directory entries".to_string()
      )]
    );
  }
}
