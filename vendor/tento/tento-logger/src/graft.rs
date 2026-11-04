//! Shared client↔server span grafting.
//!
//! A client `api-call` span carries a `client.span_id` attribute; the server
//! entry that handled that request carries the same `client.span_id` on its
//! root span. This module owns that correlation:
//!
//! - [`build_server_index`] — the borrowed index the terminal `render_unified`
//!   uses to graft at render time.
//! - [`owned_server_index`] + [`ljson_span_to_tree_node`] + [`graft_forest`] —
//!   build the grafted `tree/v1` forest the TUI `EntryTracePane` renders (client
//!   trees with matching server subtrees spliced in).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::ljson::{LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonSpan};

/// Attribute correlating a client `api-call` span with the server request span
/// that handled it.
pub const CLIENT_SPAN_ID: &str = "client.span_id";

/// If `entry` is a server entry correlating to a client api-call, return its
/// `client.span_id`.
pub fn server_correlation_id(entry: &LjsonEntry) -> Option<&str> {
  if entry.is_client() {
    return None;
  }
  entry.root_span.get_str(CLIENT_SPAN_ID)
}

/// Index server entries by their `client.span_id` (borrowed view).
pub fn build_server_index(entries: &[LjsonEntry]) -> HashMap<&str, &LjsonEntry> {
  let mut index = HashMap::new();
  for entry in entries {
    if let Some(sid) = server_correlation_id(entry) {
      index.insert(sid, entry);
    }
  }
  index
}

/// Owned counterpart of [`build_server_index`], keyed by `client.span_id`.
pub fn owned_server_index(entries: Vec<LjsonEntry>) -> HashMap<String, LjsonEntry> {
  let mut index = HashMap::new();
  for entry in entries {
    if let Some(sid) = server_correlation_id(&entry) {
      index.insert(sid.to_string(), entry);
    }
  }
  index
}

fn level_word(level: &LjsonLevel) -> String {
  match level {
    LjsonLevel::Trace => "trace",
    LjsonLevel::Debug => "debug",
    LjsonLevel::Info => "info",
    LjsonLevel::Warn => "warn",
    LjsonLevel::Error => "error",
  }
  .to_string()
}

fn to_attr_string(v: &Value) -> Value {
  match v {
    Value::String(_) => v.clone(),
    other => Value::String(other.to_string()),
  }
}

/// Convert a completed server `LjsonSpan` subtree into the `tree/v1` Value shape
/// the TUI renders (mirrors `fold::span_tree_node`), so it can be grafted under
/// a client span. Server spans carry no per-span start timestamp, so `ts` is
/// omitted (unlike the live-folded client spans).
pub fn ljson_span_to_tree_node(span: &LjsonSpan) -> Value {
  let mut attrs: Map<String, Value> = Map::new();
  attrs.insert("level".to_string(), Value::String(level_word(&span.level)));
  if let Some(ms) = span.duration_ms {
    attrs.insert("elapsed".to_string(), Value::String(format!("{ms}ms")));
  }
  for (k, v) in &span.attributes {
    attrs.insert(k.clone(), to_attr_string(v));
  }

  let mut children: Vec<Value> = Vec::with_capacity(span.children.len());
  for child in &span.children {
    match child {
      LjsonChild::Span(s) => children.push(ljson_span_to_tree_node(s)),
      LjsonChild::Event(e) => children.push(ljson_event_to_tree_node(e)),
    }
  }

  let title = span
    .attributes
    .get("message")
    .and_then(Value::as_str)
    .map(|m| format!("{} · {}", span.name, m))
    .unwrap_or_else(|| span.name.clone());

  let mut obj = Map::new();
  obj.insert("title".to_string(), Value::String(title));
  obj.insert("attrs".to_string(), Value::Object(attrs));
  obj.insert("children".to_string(), Value::Array(children));
  Value::Object(obj)
}

fn ljson_event_to_tree_node(ev: &LjsonEvent) -> Value {
  let mut attrs: Map<String, Value> = Map::new();
  attrs.insert("level".to_string(), Value::String(level_word(&ev.level)));
  for (k, v) in &ev.attributes {
    if k == "message" {
      continue;
    }
    attrs.insert(k.clone(), to_attr_string(v));
  }
  let title = ev
    .attributes
    .get("message")
    .and_then(Value::as_str)
    .map(str::to_string)
    .unwrap_or_else(|| "(event)".to_string());
  let mut obj = Map::new();
  obj.insert("title".to_string(), Value::String(title));
  obj.insert("attrs".to_string(), Value::Object(attrs));
  obj.insert("children".to_string(), Value::Array(Vec::new()));
  Value::Object(obj)
}

/// Walk a `tree/v1` node; for any node whose `attrs["client.span_id"]` matches a
/// server entry in `index`, append that server span subtree as a child (nested
/// under the client api-call), recording each grafted `client.span_id` into
/// `grafted` so [`graft_forest`] can skip rendering those server entries
/// standalone. Returns the number of grafts applied.
///
/// Pre-existing children are recursed into *before* anything is appended, so an
/// appended server subtree — whose own root carries the same `client.span_id` —
/// is never re-grafted.
fn graft_into(
  node: &mut Value,
  index: &HashMap<String, LjsonEntry>,
  grafted: &mut HashSet<String>,
) -> usize {
  let Some(obj) = node.as_object_mut() else {
    return 0;
  };

  let mut count = 0;

  // 1. Recurse into existing children before appending anything.
  if let Some(Value::Array(children)) = obj.get_mut("children") {
    for child in children.iter_mut() {
      count += graft_into(child, index, grafted);
    }
  }

  // 2. If this node correlates to a server entry, append its subtree.
  let sid = obj
    .get("attrs")
    .and_then(|a| a.get(CLIENT_SPAN_ID))
    .and_then(Value::as_str)
    .map(str::to_string);
  if let Some(sid) = sid {
    if let Some(server) = index.get(&sid) {
      let server_node = ljson_span_to_tree_node(&server.root_span);
      if let Some(Value::Array(children)) = obj.get_mut("children") {
        children.push(server_node);
        count += 1;
        grafted.insert(sid);
      }
    }
  }

  count
}

/// Build the grafted `tree/v1` forest for a set of mixed client+server entries:
/// each client entry as a tree with matching server subtrees spliced in, plus
/// any server entries that were *not* grafted (rendered standalone). Output
/// preserves the input order (callers typically pass entries sorted by `ts`).
///
/// This is the data-level analog of `render::render_unified` — both stitch by
/// `client.span_id`; this one yields `tree/v1` Values for the TUI to render.
pub fn graft_forest(entries: &[LjsonEntry]) -> Vec<Value> {
  let index = owned_server_index(entries.to_vec());
  let mut grafted: HashSet<String> = HashSet::new();
  let mut indexed: Vec<(usize, Value)> = Vec::new();

  // Client entries first, so `grafted` is fully populated before we decide
  // which server entries to keep standalone.
  for (i, e) in entries.iter().enumerate().filter(|(_, e)| e.is_client()) {
    let mut tree = ljson_span_to_tree_node(&e.root_span);
    graft_into(&mut tree, &index, &mut grafted);
    indexed.push((i, tree));
  }
  for (i, e) in entries.iter().enumerate().filter(|(_, e)| !e.is_client()) {
    let keep = e
      .root_span
      .get_str(CLIENT_SPAN_ID)
      .map(|s| !grafted.contains(s))
      .unwrap_or(true);
    if keep {
      indexed.push((i, ljson_span_to_tree_node(&e.root_span)));
    }
  }

  indexed.sort_by_key(|(i, _)| *i);
  indexed.into_iter().map(|(_, t)| t).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ljson::LjsonLocation;
  use chrono::Utc;
  use uuid::Uuid;

  fn loc() -> LjsonLocation {
    LjsonLocation {
      file: None,
      line: None,
    }
  }

  fn span(name: &str, attrs: &[(&str, &str)]) -> LjsonSpan {
    let mut attributes = HashMap::new();
    for (k, v) in attrs {
      attributes.insert(k.to_string(), Value::String(v.to_string()));
    }
    LjsonSpan {
      id: 1,
      name: name.to_string(),
      level: LjsonLevel::Info,
      duration_ms: Some(5),
      location: loc(),
      attributes,
      children: vec![],
    }
  }

  fn entry(origin: &str, root: LjsonSpan) -> LjsonEntry {
    LjsonEntry {
      v: 1,
      ts: Utc::now(),
      session_id: Uuid::nil(),
      origin: Some(origin.to_string()),
      root_span: root,
    }
  }

  #[test]
  fn server_index_keys_by_client_span_id_and_ignores_client() {
    let entries = vec![
      entry("server", span("request", &[("client.span_id", "abc")])),
      entry("client", span("page-load", &[("client.span_id", "abc")])),
    ];
    let idx = build_server_index(&entries);
    assert_eq!(idx.len(), 1);
    assert!(idx.contains_key("abc"));
  }

  #[test]
  fn ljson_span_to_tree_node_matches_fold_shape() {
    let s = span("request", &[("http.method", "GET")]);
    let v = ljson_span_to_tree_node(&s);
    assert_eq!(v["title"], Value::String("request".into()));
    assert_eq!(v["attrs"]["level"], Value::String("info".into()));
    assert_eq!(v["attrs"]["elapsed"], Value::String("5ms".into()));
    assert_eq!(v["attrs"]["http.method"], Value::String("GET".into()));
    assert!(v["children"].as_array().unwrap().is_empty());
  }

  #[test]
  fn graft_forest_nests_server_and_dedups() {
    // A client page-load whose api-call child carries client.span_id "k", and
    // the matching server entry. The server entry must NOT also appear standalone.
    let mut api = span("api-call", &[("client.span_id", "k")]);
    api.id = 2;
    let mut root = span("page-load", &[]);
    root.children = vec![LjsonChild::Span(api)];
    let client = entry("client", root);
    let server = entry(
      "server",
      span("request GET /api", &[("client.span_id", "k")]),
    );

    let forest = graft_forest(&[client, server]);
    // One top-level node (the client tree); the server is nested, not standalone.
    assert_eq!(forest.len(), 1);
    let grafted = &forest[0]["children"][0]["children"][0];
    assert_eq!(grafted["title"], Value::String("request GET /api".into()));
  }

  #[test]
  fn graft_forest_keeps_ungrafted_server_standalone() {
    let server = entry(
      "server",
      span("orphan request", &[("client.span_id", "unmatched")]),
    );
    let forest = graft_forest(&[server]);
    assert_eq!(forest.len(), 1);
    assert_eq!(forest[0]["title"], Value::String("orphan request".into()));
  }
}
