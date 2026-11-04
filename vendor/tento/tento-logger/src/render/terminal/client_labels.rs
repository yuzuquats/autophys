//! Client span label logic for terminal rendering.
//!
//! Builds descriptive labels for standalone client spans (page-load, navigation,
//! view-state, etc.) used in both tree and session rendering modes.

use crate::ljson::LjsonSpan;

use super::{GRAY, RESET};

/// Build a descriptive label for a standalone client span.
///
/// Extracts the most useful attribute(s) for known span types and falls back
/// to a generic first-attribute display for unknown ones. When `tree_mode` is
/// set (the entry/unified tree renderers, which now also render a span's custom
/// attributes as a `├──` field tree), the generic fallback omits the inline
/// first-attribute echo to avoid duplicating a tree line; session mode (no tree)
/// keeps it.
pub(super) fn client_span_label(span: &LjsonSpan, tree_mode: bool) -> String {
  let name = &span.name;

  match name.as_str() {
    "page-load" => {
      let path = span.get_str("path").unwrap_or("/");
      let host = span.get_str("hostname").unwrap_or("");
      if host.is_empty() {
        format!("{name} {GRAY}{path}{RESET}")
      } else {
        format!("{name} {GRAY}{host}{path}{RESET}")
      }
    }
    "navigation" => {
      let from = span.get_str("from").unwrap_or("?");
      let to = span.get_str("to").unwrap_or("?");
      format!("{name} {GRAY}{from} → {to}{RESET}")
    }
    "view-state" => {
      let reason = span.get_str("reason").unwrap_or("");
      let ops = span.get_str("ops").unwrap_or("");
      let phase = span.get_str("phase").unwrap_or("");
      let mut parts = String::from(name.as_str());
      if !reason.is_empty() {
        parts.push(' ');
        parts.push_str(reason);
      }
      if !phase.is_empty() {
        parts.push_str(&format!(" {GRAY}phase={phase}{RESET}"));
      }
      if !ops.is_empty() {
        parts.push_str(&format!(" {GRAY}[{ops}]{RESET}"));
      }
      parts
    }
    "nav-complete" => {
      let key = span.get_str("sheetKey").unwrap_or("");
      let token = span.get_str("token").unwrap_or("");
      if !key.is_empty() {
        format!("{name} {GRAY}{key}{RESET}")
      } else if !token.is_empty() {
        format!("{name} {GRAY}{token}{RESET}")
      } else {
        name.to_string()
      }
    }
    "step-marker" => {
      let text = span.get_str("stepText").unwrap_or("");
      if text.is_empty() {
        name.to_string()
      } else {
        format!("{name} {GRAY}\"{text}\"{RESET}")
      }
    }
    _ => {
      // Generic: in tree mode the attributes render as a field tree below, so
      // keep the label to just the name (+ location); in session mode echo the
      // first useful attribute inline.
      let detail = if tree_mode {
        None
      } else {
        span_first_detail(span)
      };
      match detail {
        Some(d) => format!("{name} {GRAY}{d}{RESET}"),
        None => {
          let loc = span.location.format();
          if loc.is_empty() {
            name.to_string()
          } else {
            format!("{name} {loc}")
          }
        }
      }
    }
  }
}

/// Extract the first compact, useful attribute value from a span.
fn span_first_detail(span: &LjsonSpan) -> Option<String> {
  const SKIP: &[&str] = &["user.action", "client.span_id"];
  for (key, value) in &span.attributes {
    if SKIP.contains(&key.as_str()) {
      continue;
    }
    let s = match value {
      serde_json::Value::String(s) if s.len() <= 80 => format!("{key}={s}"),
      serde_json::Value::Number(n) => format!("{key}={n}"),
      serde_json::Value::Bool(b) => format!("{key}={b}"),
      _ => continue,
    };
    return Some(s);
  }
  None
}

/// Extract the first non-`user.action` attribute value from a span for session
/// mode user-action lines.
pub(super) fn user_action_detail(span: &LjsonSpan) -> Option<String> {
  for (key, value) in &span.attributes {
    if key == "user.action" {
      continue;
    }
    return Some(match value {
      serde_json::Value::String(s) => s.clone(),
      serde_json::Value::Number(n) => n.to_string(),
      serde_json::Value::Bool(b) => b.to_string(),
      _ => value.to_string(),
    });
  }
  None
}
