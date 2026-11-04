//! Level Filter Demo
//!
//! Renders the same set of log entries at each `--level` threshold to
//! demonstrate how filtering affects output.
//!
//! Run with: cargo run -p tento-logger --example level_filter_demo

use std::collections::HashMap;

use chrono::{Duration, Utc};
use uuid::Uuid;

use tento_logger::ljson::{
  LJSON_VERSION, LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan,
};
use tento_logger::render::render_entry;
use tento_logger::render::terminal::ColumnVisibility;

const GRAY: &str = "\x1b[38;5;239m";
const RESET: &str = "\x1b[0m";

fn main() {
  let entries = build_entries();

  let levels = [
    LjsonLevel::Trace,
    LjsonLevel::Debug,
    LjsonLevel::Info,
    LjsonLevel::Warn,
    LjsonLevel::Error,
  ];

  println!("╔═══════════════════════════════════════════════════════════════════╗");
  println!("║               LEVEL FILTER DEMONSTRATION                          ║");
  println!("║                                                                   ║");
  println!(
    "║  Same {} entries rendered at each --level threshold              ║",
    entries.len()
  );
  println!("╚═══════════════════════════════════════════════════════════════════╝");

  for min_level in &levels {
    let filtered: Vec<&LjsonEntry> = entries
      .iter()
      .filter(|e| e.root_span.level >= *min_level)
      .collect();

    println!();
    println!("┌─────────────────────────────────────────────────────────────────┐");
    println!(
      "│ --level {:<5}  ({} of {} entries)                              │",
      format!("{:?}", min_level).to_lowercase(),
      filtered.len(),
      entries.len(),
    );
    println!("└─────────────────────────────────────────────────────────────────┘");

    if filtered.is_empty() {
      println!("  {GRAY}(no entries at this level){RESET}");
      continue;
    }

    let viz = ColumnVisibility::all();
    for entry in &filtered {
      print!("{}", render_entry(entry, &viz));
    }
  }

  println!();
  println!(
    "{GRAY}Tip: cargo run --example render_ljson -- --level warn examples/sample.ljson{RESET}"
  );
  println!("{GRAY}     ./run logs.render --level error{RESET}");
}

// ============================================================================
// Sample data: one entry per level
// ============================================================================

fn attr(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
  pairs
    .iter()
    .map(|(k, v)| (k.to_string(), v.clone()))
    .collect()
}

fn loc(file: &str, line: u32) -> LjsonLocation {
  LjsonLocation {
    file: Some(file.to_string()),
    line: Some(line),
  }
}

fn build_entries() -> Vec<LjsonEntry> {
  let session = Uuid::new_v4();
  let base = Utc::now() - Duration::seconds(30);

  vec![
    // 1. TRACE — pool connection acquired (background noise)
    LjsonEntry {
      v: LJSON_VERSION,
      ts: base,
      session_id: session,
      origin: None,
      root_span: LjsonSpan {
        id: 100,
        name: "pool_maintenance".to_string(),
        level: LjsonLevel::Trace,
        duration_ms: Some(1),
        location: loc("db/pool.rs", 22),
        attributes: attr(&[("message", serde_json::json!("Idle connection keepalive"))]),
        children: vec![],
      },
    },
    // 2. DEBUG — auth token validation
    LjsonEntry {
      v: LJSON_VERSION,
      ts: base + Duration::seconds(2),
      session_id: session,
      origin: None,
      root_span: LjsonSpan {
        id: 200,
        name: "auth_check".to_string(),
        level: LjsonLevel::Debug,
        duration_ms: Some(5),
        location: loc("middleware/auth.rs", 40),
        attributes: attr(&[
          ("message", serde_json::json!("JWT validated")),
          ("user.id", serde_json::json!("usr_abc")),
        ]),
        children: vec![],
      },
    },
    // 3. INFO — normal HTTP request
    LjsonEntry {
      v: LJSON_VERSION,
      ts: base + Duration::seconds(5),
      session_id: session,
      origin: None,
      root_span: LjsonSpan {
        id: 300,
        name: "http_request".to_string(),
        level: LjsonLevel::Info,
        duration_ms: Some(87),
        location: loc("routes/api.rs", 45),
        attributes: attr(&[
          ("http.method", serde_json::json!("GET")),
          ("http.target", serde_json::json!("/api/sheets")),
          ("http.status_code", serde_json::json!(200)),
          ("http.host", serde_json::json!("app.lona.so")),
          ("user.email", serde_json::json!("alice")),
          ("user.connecting_ip", serde_json::json!("203.0.113.42")),
          ("kind", serde_json::json!("http.request")),
          ("span.kind", serde_json::json!("request")),
          ("yuzu.dev_mode", serde_json::json!("prod")),
        ]),
        children: vec![
          LjsonChild::Span(LjsonSpan {
            id: 301,
            name: "db_query".to_string(),
            level: LjsonLevel::Debug,
            duration_ms: Some(32),
            location: loc("db/sheets.rs", 60),
            attributes: attr(&[("query", serde_json::json!("SELECT * FROM sheets"))]),
            children: vec![],
          }),
          LjsonChild::Event(LjsonEvent {
            level: LjsonLevel::Info,
            location: loc("routes/api.rs", 78),
            attributes: attr(&[("message", serde_json::json!("Returned 12 sheets"))]),
          }),
        ],
      },
    },
    // 4. WARN — 404 not found
    LjsonEntry {
      v: LJSON_VERSION,
      ts: base + Duration::seconds(12),
      session_id: session,
      origin: None,
      root_span: LjsonSpan {
        id: 400,
        name: "http_request".to_string(),
        level: LjsonLevel::Warn,
        duration_ms: Some(4),
        location: loc("routes/api.rs", 120),
        attributes: attr(&[
          ("http.method", serde_json::json!("DELETE")),
          ("http.target", serde_json::json!("/api/sheets/gone")),
          ("http.status_code", serde_json::json!(404)),
          ("http.host", serde_json::json!("app.lona.so")),
          ("user.email", serde_json::json!("bob")),
          ("kind", serde_json::json!("http.request")),
          ("span.kind", serde_json::json!("request")),
          ("yuzu.dev_mode", serde_json::json!("rc")),
        ]),
        children: vec![LjsonChild::Event(LjsonEvent {
          level: LjsonLevel::Warn,
          location: loc("routes/api.rs", 125),
          attributes: attr(&[("message", serde_json::json!("Sheet not found"))]),
        })],
      },
    },
    // 5. ERROR — 500 constraint violation
    LjsonEntry {
      v: LJSON_VERSION,
      ts: base + Duration::seconds(20),
      session_id: session,
      origin: None,
      root_span: LjsonSpan {
        id: 500,
        name: "http_request".to_string(),
        level: LjsonLevel::Error,
        duration_ms: Some(91),
        location: loc("routes/api.rs", 150),
        attributes: attr(&[
          ("http.method", serde_json::json!("PUT")),
          ("http.target", serde_json::json!("/api/sheets/dup")),
          ("http.status_code", serde_json::json!(500)),
          ("http.host", serde_json::json!("app.lona.so")),
          ("user.email", serde_json::json!("charli")),
          ("user.connecting_ip", serde_json::json!("198.51.100.7")),
          ("kind", serde_json::json!("http.request")),
          ("span.kind", serde_json::json!("request")),
          ("yuzu.dev_mode", serde_json::json!("prod")),
        ]),
        children: vec![LjsonChild::Span(LjsonSpan {
          id: 501,
          name: "db_query".to_string(),
          level: LjsonLevel::Debug,
          duration_ms: Some(67),
          location: loc("db/sheets.rs", 95),
          attributes: attr(&[("query", serde_json::json!("UPDATE sheets SET ..."))]),
          children: vec![LjsonChild::Event(LjsonEvent {
            level: LjsonLevel::Error,
            location: loc("db/sheets.rs", 102),
            attributes: attr(&[(
              "message",
              serde_json::json!("duplicate key violates unique constraint"),
            )]),
          })],
        })],
      },
    },
  ]
}
