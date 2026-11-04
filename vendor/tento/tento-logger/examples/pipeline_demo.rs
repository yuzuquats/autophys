//! Logging Pipeline Demo
//!
//! This example demonstrates each step of the tento-logger pipeline:
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────────┐
//! │                        LOGGING PIPELINE                                  │
//! ├─────────────────────────────────────────────────────────────────────────┤
//! │                                                                         │
//! │  1. TRACING EVENTS                                                      │
//! │     tracing::info_span!(), tracing::info!(), etc.                       │
//! │                         │                                               │
//! │                         ▼                                               │
//! │  2. SLOG LAYER (SlogLayer)                                              │
//! │     Captures span lifecycle: create, record, close                      │
//! │     Captures events with parent span context                            │
//! │                         │                                               │
//! │                         ▼                                               │
//! │  3. SLOG AGGREGATOR (SlogAggregator)                                    │
//! │     Builds span tree: root_spans, children, span_info                   │
//! │     On root span close: builds LjsonEntry, renders via render_entry()   │
//! │                         │                                               │
//! │                         ├─────────────────────┐                         │
//! │                         ▼                     ▼                         │
//! │  4a. LJSON FILE                     4b. TERMINAL OUTPUT                 │
//! │      (if ljson_log_dir set)             render_entry(&entry)            │
//! │      Writes LjsonEntry to               → ANSI-colored string           │
//! │      loaf.ljson                         → stdout or callback            │
//! │                                                                         │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! Run with: cargo run -p tento-logger --example pipeline_demo

use std::collections::HashMap;

use chrono::Utc;
use uuid::Uuid;

// Import the LJSON types
use tento_logger::ljson::{
  LJSON_VERSION, LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan,
};

// Import the render function
use tento_logger::render::render_entry;
use tento_logger::render::terminal::ColumnVisibility;

fn main() {
  println!("╔═══════════════════════════════════════════════════════════════════╗");
  println!("║              YUZU-LOGGER PIPELINE DEMONSTRATION                   ║");
  println!("╚═══════════════════════════════════════════════════════════════════╝\n");

  // =========================================================================
  // STEP 1: Simulating what tracing macros produce
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 1: Tracing Events (what your code produces)                │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  println!("  In your application code, you write:");
  println!();
  println!("    #[tracing::instrument]");
  println!("    async fn handle_request(user_id: &str) {{");
  println!("        tracing::info!(\"Processing request\");");
  println!("        let result = db_query().await;");
  println!("        tracing::info!(rows = result.len(), \"Query complete\");");
  println!("    }}");
  println!();
  println!("  These macros emit span lifecycle events and log events.");
  println!();

  // =========================================================================
  // STEP 2: SlogLayer captures events
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 2: SlogLayer Captures Events                               │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  println!("  SlogLayer intercepts tracing events and converts them to SlogEvent:");
  println!();
  println!("    enum SlogEvent {{");
  println!("      OnSpanCreate {{ id, parent_id, name, attributes, location, level }}");
  println!("      OnSpanRecord {{ id, attributes }}");
  println!("      OnSpanClose  {{ id, time_elapsed_ms }}");
  println!("      OnEvent      {{ parent_id, attributes, location, level }}");
  println!("    }}");
  println!();
  println!("  These events are forwarded to the SlogSubscriber (SlogAggregator).");
  println!();

  // =========================================================================
  // STEP 3: SlogAggregator builds span tree
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 3: SlogAggregator Builds Span Tree                         │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  println!("  SlogAggregator maintains three data structures:");
  println!();
  println!("    root_spans: DashSet<u64>           // IDs of top-level spans");
  println!("    span_info:  DashMap<u64, Span>     // Span metadata by ID");
  println!("    children:   DashMap<u64, Vec<Slog>> // Children by parent ID");
  println!();
  println!("  Example tree for an HTTP request:");
  println!();
  println!("    root_spans: [1001]");
  println!("    span_info:");
  println!("      1001 -> {{ name: \"http_request\", duration_ms: 142 }}");
  println!("      1002 -> {{ name: \"auth_check\", duration_ms: 8 }}");
  println!("      1003 -> {{ name: \"db_query\", duration_ms: 45 }}");
  println!("    children:");
  println!("      1001 -> [Span(1002), Span(1003), Event(\"Request complete\")]");
  println!("      1003 -> [Event(\"Connection acquired\")]");
  println!();

  // =========================================================================
  // STEP 4: Build LJSON structure
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 4: Convert to LJSON Format                                 │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  // Build a sample LJSON entry programmatically
  let entry = build_sample_entry();

  println!("  When a root span closes, we build an LjsonEntry:");
  println!();
  println!("    LjsonEntry {{");
  println!("      v: 1,                    // Schema version");
  println!("      ts: \"2026-01-30T...\",    // Completion timestamp");
  println!("      session_id: \"uuid\",      // Logger session");
  println!("      root_span: LjsonSpan {{   // Nested tree structure");
  println!("        id, name, level, duration_ms, location, attributes,");
  println!("        children: [LjsonChild::Span(...), LjsonChild::Event(...)]");
  println!("      }}");
  println!("    }}");
  println!();

  // Show the actual JSON
  println!("  Serialized LJSON (one line per root span):");
  println!();
  let json = serde_json::to_string_pretty(&entry).unwrap();
  for line in json.lines().take(25) {
    println!("    {}", line);
  }
  println!("    ... (truncated)");
  println!();

  // =========================================================================
  // STEP 5: Render to terminal
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 5: Render to Terminal                                      │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  println!("  The render module transforms LjsonEntry to ANSI-colored output:");
  println!();
  println!("    render_entry(&entry) -> String");
  println!();
  println!("  Output format (columns):");
  println!("    [level]│ [elapsed] │ [IP] │ [user] │ [status] [method] [mode] [host] [path]");
  println!("           │           │      │        │ [guidelines] [span/event] [location]");
  println!();
  println!("  Rendered output:");
  println!("  ─────────────────────────────────────────────────────────────────");

  let rendered = render_entry(&entry, &ColumnVisibility::all());
  print!("{}", rendered);

  println!("  ─────────────────────────────────────────────────────────────────");
  println!();

  // =========================================================================
  // STEP 6: File output paths
  // =========================================================================
  println!("┌─────────────────────────────────────────────────────────────────┐");
  println!("│ STEP 6: Output Destinations                                     │");
  println!("└─────────────────────────────────────────────────────────────────┘\n");

  println!("  With ljson_log_dir configured, logs go to TWO places:");
  println!();
  println!("    1. Terminal (rendered)     -> stdout");
  println!("    2. LJSON file (raw)        -> $LOAF_LOGS_DIR/loaf.ljson");
  println!();
  println!("  The LJSON file can be:");
  println!("    - Replayed: cargo run --example render_ljson -- loaf.ljson");
  println!("    - Filtered: grep '\"level\":\"error\"' loaf.ljson | ...");
  println!("    - Analyzed: jq '.rootSpan.durationMs' loaf.ljson");
  println!("    - Archived: for later debugging or analytics");
  println!();

  // =========================================================================
  // Summary
  // =========================================================================
  println!("╔═══════════════════════════════════════════════════════════════════╗");
  println!("║                           SUMMARY                                 ║");
  println!("╠═══════════════════════════════════════════════════════════════════╣");
  println!("║  tracing::*  →  SlogLayer  →  SlogAggregator  →  LJSON + Render   ║");
  println!("║                                                                   ║");
  println!("║  Benefits of LJSON separation:                                    ║");
  println!("║  • Raw logs preserved for replay/debugging                        ║");
  println!("║  • Render logic decoupled from capture                            ║");
  println!("║  • Easy filtering with grep/jq                                    ║");
  println!("║  • Future: Parquet conversion for analytics                       ║");
  println!("╚═══════════════════════════════════════════════════════════════════╝");
}

/// Build a sample LjsonEntry representing an HTTP request
fn build_sample_entry() -> LjsonEntry {
  LjsonEntry {
    v: LJSON_VERSION,
    ts: Utc::now(),
    session_id: Uuid::new_v4(),
    origin: None,
    root_span: LjsonSpan {
      id: 1001,
      name: "http_request".to_string(),
      level: LjsonLevel::Info,
      duration_ms: Some(142),
      location: LjsonLocation {
        file: Some("src/routes/api.rs".to_string()),
        line: Some(45),
      },
      attributes: {
        let mut m = HashMap::new();
        m.insert("http.method".to_string(), serde_json::json!("POST"));
        m.insert("http.target".to_string(), serde_json::json!("/api/sheets"));
        m.insert("http.status_code".to_string(), serde_json::json!(200));
        m.insert("http.host".to_string(), serde_json::json!("app.lona.so"));
        m.insert("user.email".to_string(), serde_json::json!("alice"));
        m.insert(
          "user.connecting_ip".to_string(),
          serde_json::json!("203.0.113.42"),
        );
        m.insert("kind".to_string(), serde_json::json!("http.request"));
        m.insert("span.kind".to_string(), serde_json::json!("request"));
        m.insert("yuzu.dev_mode".to_string(), serde_json::json!("beta"));
        m
      },
      children: vec![
        LjsonChild::Span(LjsonSpan {
          id: 1002,
          name: "auth_check".to_string(),
          level: LjsonLevel::Debug,
          duration_ms: Some(8),
          location: LjsonLocation {
            file: Some("src/middleware/auth.rs".to_string()),
            line: Some(23),
          },
          attributes: {
            let mut m = HashMap::new();
            m.insert(
              "message".to_string(),
              serde_json::json!("Validating JWT token"),
            );
            m
          },
          children: vec![],
        }),
        LjsonChild::Span(LjsonSpan {
          id: 1003,
          name: "db_query".to_string(),
          level: LjsonLevel::Debug,
          duration_ms: Some(45),
          location: LjsonLocation {
            file: Some("src/db/sheets.rs".to_string()),
            line: Some(112),
          },
          attributes: {
            let mut m = HashMap::new();
            m.insert(
              "query".to_string(),
              serde_json::json!("INSERT INTO sheets ..."),
            );
            m
          },
          children: vec![LjsonChild::Event(LjsonEvent {
            level: LjsonLevel::Trace,
            location: LjsonLocation {
              file: Some("src/db/pool.rs".to_string()),
              line: Some(67),
            },
            attributes: {
              let mut m = HashMap::new();
              m.insert(
                "message".to_string(),
                serde_json::json!("Acquired connection from pool"),
              );
              m
            },
          })],
        }),
        LjsonChild::Event(LjsonEvent {
          level: LjsonLevel::Info,
          location: LjsonLocation {
            file: Some("src/routes/api.rs".to_string()),
            line: Some(78),
          },
          attributes: {
            let mut m = HashMap::new();
            m.insert(
              "message".to_string(),
              serde_json::json!("Sheet created successfully"),
            );
            m.insert("sheet_id".to_string(), serde_json::json!("sheet_xyz789"));
            m
          },
        }),
      ],
    },
  }
}
