//! Terminal rendering for LJSON entries.
//!
//! This module provides functions to render LjsonEntry objects to ANSI-colored
//! terminal output with a unified column layout supporting both client and server origins.

mod client_labels;
mod http;
mod session;

pub use session::{render_session, render_session_to};
pub use tento_term::ColumnVisibility;

use std::collections::HashMap;
use std::io::Write;

use chrono::{DateTime, Duration, Local, Utc};
use tento_env::{FromEnvVar, env_kv};

use crate::{
  ljson::{LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan},
  subscribers::{exception::ExceptionWithTrace, format_ms},
};

/// Path constants for the trace renderer's fixed column set. Plug these into a
/// `ColumnVisibility` to toggle the column slots (e.g. the `ux-test view`
/// default hides `IP` and `USER` for client-heavy traces). Constants live on
/// the renderer so callers needn't repeat stringly paths.
pub mod col {
  pub const LEVEL: &str = "level";
  pub const ELAPSED: &str = "elapsed";
  pub const TS: &str = "ts";
  pub const IP: &str = "ip";
  pub const USER: &str = "user";
  pub const ORIGIN: &str = "origin";
}

pub(crate) static EMPTY: &str = "";
pub(crate) static RED: &str = "\u{001b}[31m";
pub(crate) static GREEN: &str = "\u{001b}[32m";
pub(crate) static CYAN: &str = "\u{001b}[36m";
pub(crate) static YELLOW: &str = "\u{001b}[33m";
pub(crate) static GRAY: &str = "\u{001b}[38;5;238m";
pub(crate) static RESET: &str = "\u{001b}[0m";
pub(crate) static BOLD: &str = "\u{001b}[1m";

env_kv!("COLUMNS", i32, default = 80);

fn term_columns() -> i32 {
  Columns::from_env().unwrap().max(20)
}

/// Guideline characters for tree rendering
#[derive(Clone, PartialEq)]
pub enum GuidelineCharacter {
  Empty,
  Continuation,
  Finish,
  Direct,
}

impl GuidelineCharacter {
  pub fn new_buffer() -> GuidelineCharacterBuffer {
    use GuidelineCharacter::*;
    [Empty, Empty, Empty, Empty, Empty, Empty, Empty, Empty]
  }
}

pub type GuidelineCharacterBuffer = [GuidelineCharacter; 8];

/// Span/event attribute keys rendered specially elsewhere (inlined into the
/// message/http content, the init banner, the exception box, or used only for
/// graft correlation), so they must NOT be repeated as field-tree lines.
fn is_skipped_attr(key: &str) -> bool {
  key == "message"
    || key == "span.kind"
    || key == "exception.trace_json"
    || key.starts_with("http.")
    || key.starts_with("server.")
    || key.starts_with("initialize.")
    || key.starts_with("client.")
}

/// Render a JSON attribute value as one inline string: bare text for strings,
/// `null` for null, compact JSON for numbers/bools/objects/arrays.
fn format_attr_value(v: &serde_json::Value) -> String {
  match v {
    serde_json::Value::String(s) => s.clone(),
    serde_json::Value::Null => "null".to_string(),
    other => other.to_string(),
  }
}

/// A span's display attributes: the custom (non-framework) keys, sorted for
/// deterministic output, each formatted as `(key, value-string)`.
fn display_attrs(span: &LjsonSpan) -> Vec<(String, String)> {
  let mut out: Vec<(String, String)> = span
    .attributes
    .iter()
    .filter(|(k, _)| !is_skipped_attr(k))
    .map(|(k, v)| (k.clone(), format_attr_value(v)))
    .collect();
  out.sort_by(|a, b| a.0.cmp(&b.0));
  out
}

/// Context carried through all rendering methods for a single entry.
pub(crate) struct RenderContext<'a> {
  pub(super) origin: &'a str,
  pub(super) span_kind: &'a str,
  pub(super) start_ts: Option<DateTime<Utc>>,
  /// Client tree guidelines for grafted server children (empty for non-grafted).
  pub(super) graft_prefix: String,
}

/// Like [`render_entry`] but **slim**: drops the HTTP-only columns
/// (connecting_ip, user_id, origin) so non-HTTP entries (e.g. the fleet
/// span-log pane's rows) don't waste ~45 horizontal characters on empty cells.
/// Same level / elapsed / timestamp / name / location / tree-children layout
/// otherwise. Implemented as a `render_entry` with those three columns hidden
/// via [`ColumnVisibility`].
pub fn render_entry_slim(entry: &LjsonEntry) -> String {
  let mut viz = ColumnVisibility::all();
  viz.hide(col::IP);
  viz.hide(col::USER);
  viz.hide(col::ORIGIN);
  let mut renderer = TerminalRenderer::new(&viz);
  let mut buffer = GuidelineCharacter::new_buffer();

  let origin = entry.origin.as_deref().unwrap_or("server");
  let span_kind = entry.root_span.get_str("span.kind").unwrap_or("default");
  let ctx = RenderContext {
    origin,
    span_kind,
    start_ts: Some(entry_start_ts(entry)),
    graft_prefix: String::new(),
  };

  renderer.render_span(&entry.root_span, &ctx, 0, &buffer);
  renderer.render_children(&entry.root_span.children, &ctx, 1, &mut buffer);

  renderer.finish()
}

/// The root's START instant: `entry.ts` (written at completion) minus the
/// root duration. Durationless roots — synthesized text events, unclosed
/// spans — fall back to `entry.ts` itself, so the timestamp column always
/// renders instead of leaving a blank 14-char slot.
fn entry_start_ts(entry: &LjsonEntry) -> DateTime<Utc> {
  match entry.root_span.duration_ms {
    Some(d) => entry.ts - chrono::Duration::milliseconds(d as i64),
    None => entry.ts,
  }
}

/// Render an LJSON entry to a terminal-formatted string.
///
/// `viz` controls which of the six fixed columns (`col::LEVEL` … `col::ORIGIN`)
/// actually render — hidden columns are skipped entirely (no separator, no
/// padding), so the line collapses cleanly. Pass [`ColumnVisibility::all`] to
/// preserve the historical layout.
pub fn render_entry(entry: &LjsonEntry, viz: &ColumnVisibility) -> String {
  let mut renderer = TerminalRenderer::new(viz);
  let mut buffer = GuidelineCharacter::new_buffer();

  let origin = entry.origin.as_deref().unwrap_or("server");
  let span_kind = entry.root_span.get_str("span.kind").unwrap_or("default");
  let ctx = RenderContext {
    origin,
    span_kind,
    start_ts: Some(entry_start_ts(entry)),
    graft_prefix: String::new(),
  };

  renderer.render_span(&entry.root_span, &ctx, 0, &buffer);
  renderer.render_span_attrs(&entry.root_span, &ctx, 1, &mut buffer);
  renderer.render_children(&entry.root_span.children, &ctx, 1, &mut buffer);

  renderer.finish()
}

/// Does this entry represent a routine static-asset fetch that we fold into a
/// per-page-load summary instead of printing one line each? These dominate dev
/// logs (per-file JS modules, css, maps, fonts, favicons) and carry no signal
/// individually. We fold ONLY when it is provably uninteresting: a server
/// `request` span, a safe method, a success/redirect/not-modified status, no
/// child events (so an asset request that logged an error or anything else is
/// never hidden), and a static asset path. Any 4xx/5xx — including on assets —
/// is left to render normally so failures stay visible.
fn is_foldable_static_request(entry: &LjsonEntry) -> bool {
  if entry.is_client() {
    return false;
  }
  let span = &entry.root_span;
  if span.get_str("span.kind") != Some("request") {
    return false;
  }
  if !span.children.is_empty() {
    return false;
  }
  if !matches!(span.get_str("http.method"), Some("GET") | Some("HEAD")) {
    return false;
  }
  if !matches!(span.get_u64("http.status_code"), Some(200..=399)) {
    return false;
  }
  let Some(target) = span.get_str("http.target") else {
    return false;
  };
  let path = target.split('?').next().unwrap_or(target);
  const STATIC_PREFIXES: &[&str] = &[
    "/js/",
    "/css/",
    "/@/static/",
    "/static/",
    "/img/",
    "/fonts/",
  ];
  const STATIC_SUFFIXES: &[&str] = &[
    ".js", ".css", ".map", ".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".svg", ".ico",
    ".gif", ".webp", ".wasm",
  ];
  STATIC_PREFIXES.iter().any(|p| path.starts_with(p))
    || STATIC_SUFFIXES.iter().any(|s| path.ends_with(s))
}

/// Render one finished run of consecutive foldable static-asset requests. A
/// lone request renders normally (no point summarizing one line); a run of two
/// or more collapses into a single synthesized summary line.
fn render_static_fold(run: &[&LjsonEntry], viz: &ColumnVisibility) -> String {
  match run {
    [] => String::new(),
    [only] => render_entry(only, viz),
    many => render_static_fold_line(many, viz),
  }
}

/// Build the one-line page-load summary for a run of folded static fetches:
/// count, how many were served-from-cache (`304`), wall-clock span of the
/// burst, and the host. (Byte totals aren't recorded on the request span yet,
/// so they're intentionally omitted.)
fn render_static_fold_line(run: &[&LjsonEntry], viz: &ColumnVisibility) -> String {
  let n = run.len();
  let cached = run
    .iter()
    .filter(|e| e.root_span.get_u64("http.status_code") == Some(304))
    .count();

  let mut min_start: Option<DateTime<Utc>> = None;
  let mut max_end: Option<DateTime<Utc>> = None;
  for e in run {
    let end = e.ts;
    let start = e
      .root_span
      .duration_ms
      .map(|d| end - Duration::milliseconds(d))
      .unwrap_or(end);
    min_start = Some(min_start.map_or(start, |m| m.min(start)));
    max_end = Some(max_end.map_or(end, |m| m.max(end)));
  }
  let wall_ms = match (min_start, max_end) {
    (Some(s), Some(e)) => (e - s).num_milliseconds().max(0),
    _ => 0,
  };

  let host = run
    .iter()
    .find_map(|e| e.root_span.get_str("http.host"))
    .unwrap_or("");

  let mut message = format!("served {n} static assets");
  if cached > 0 {
    message.push_str(&format!(" ({cached} cached)"));
  }
  message.push_str(&format!(" in {wall_ms}ms"));
  if !host.is_empty() {
    message.push_str(&format!(" · {host}"));
  }

  let mut attributes = HashMap::new();
  attributes.insert("message".to_string(), serde_json::Value::String(message));
  let event = LjsonEvent {
    level: LjsonLevel::Info,
    location: LjsonLocation {
      file: None,
      line: None,
    },
    attributes,
  };
  render_standalone_event(&event, viz)
}

/// Routine requests that add no signal to the rendered log and are dropped from
/// the view entirely (raw rows still go to parquet): CORS `OPTIONS` preflight,
/// and the log-/trace-ingest endpoints that would otherwise log their own
/// access lines. Mirrors [`is_foldable_static_request`]'s safety rails — server
/// `request` span, no child events, success/redirect only — so a failing
/// (4xx/5xx) preflight or ingest call still renders.
fn is_suppressed_request(entry: &LjsonEntry) -> bool {
  if entry.is_client() {
    return false;
  }
  let span = &entry.root_span;
  if span.get_str("span.kind") != Some("request") {
    return false;
  }
  if !span.children.is_empty() {
    return false;
  }
  if !matches!(span.get_u64("http.status_code"), Some(200..=399)) {
    return false;
  }
  if span.get_str("http.method") == Some("OPTIONS") {
    return true;
  }
  let Some(target) = span.get_str("http.target") else {
    return false;
  };
  let path = target.split('?').next().unwrap_or(target);
  const SUPPRESSED_PATHS: &[&str] = &["/_/ux-test/logs", "/api/tracing/entries"];
  SUPPRESSED_PATHS.iter().any(|p| path == *p)
}

/// Render multiple LJSON entries with client-server grafting.
///
/// When a client `api-call` span has a `client.span_id` that matches a server
/// entry's `client.span_id`, the server's request tree is grafted into the
/// client tree, replacing the api-call span.
///
/// Consecutive runs of routine static-asset fetches
/// ([`is_foldable_static_request`]) are collapsed into a single per-page-load
/// summary line, and routine instrumentation requests
/// ([`is_suppressed_request`]) are dropped, so neither drowns the log.
pub fn render_unified(entries: &[LjsonEntry], viz: &ColumnVisibility) -> String {
  use std::collections::HashSet;

  // Build server index keyed by client.span_id (shared with the TUI grafting).
  let server_index = crate::graft::build_server_index(entries);

  let mut grafted: HashSet<String> = HashSet::new();
  let mut renderer = TerminalRenderer::new(viz);
  let mut pending: Vec<&LjsonEntry> = Vec::new();

  for entry in entries {
    if entry.is_client() {
      renderer.write(&render_static_fold(&pending, viz));
      pending.clear();
      let mut buffer = GuidelineCharacter::new_buffer();
      let span_kind = entry.root_span.get_str("span.kind").unwrap_or("default");
      let start_ts = entry
        .root_span
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));
      let ctx = RenderContext {
        origin: "client",
        span_kind,
        start_ts,
        graft_prefix: String::new(),
      };

      renderer.render_span(&entry.root_span, &ctx, 0, &buffer);
      renderer.render_span_attrs(&entry.root_span, &ctx, 1, &mut buffer);
      renderer.render_children_graftable(
        &entry.root_span.children,
        &ctx,
        1,
        &mut buffer,
        &server_index,
        &mut grafted,
      );
    } else {
      let span_id = entry.root_span.get_str("client.span_id").unwrap_or("");
      if !span_id.is_empty() && grafted.contains(span_id) {
        continue;
      }
      if is_foldable_static_request(entry) {
        pending.push(entry);
        continue;
      }
      renderer.write(&render_static_fold(&pending, viz));
      pending.clear();
      if is_suppressed_request(entry) {
        continue;
      }
      renderer.write(&render_entry(entry, viz));
    }
  }
  renderer.write(&render_static_fold(&pending, viz));

  renderer.finish()
}

/// Streaming variant of `render_unified` — writes directly to `out` entry-by-entry.
///
/// Avoids accumulating the full rendered output in memory. The graft index is
/// still built upfront (requires all entries), but each entry's rendered string
/// is written immediately and then dropped.
pub fn render_unified_to<W: Write>(
  entries: &[LjsonEntry],
  out: &mut W,
  viz: &ColumnVisibility,
) -> std::io::Result<()> {
  use std::collections::HashSet;

  let server_index = crate::graft::build_server_index(entries);

  let mut grafted: HashSet<String> = HashSet::new();
  let mut pending: Vec<&LjsonEntry> = Vec::new();

  for entry in entries {
    if entry.is_client() {
      out.write_all(render_static_fold(&pending, viz).as_bytes())?;
      pending.clear();
      let mut renderer = TerminalRenderer::new(viz);
      let mut buffer = GuidelineCharacter::new_buffer();
      let span_kind = entry.root_span.get_str("span.kind").unwrap_or("default");
      let start_ts = entry
        .root_span
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));
      let ctx = RenderContext {
        origin: "client",
        span_kind,
        start_ts,
        graft_prefix: String::new(),
      };

      renderer.render_span(&entry.root_span, &ctx, 0, &buffer);
      renderer.render_span_attrs(&entry.root_span, &ctx, 1, &mut buffer);
      renderer.render_children_graftable(
        &entry.root_span.children,
        &ctx,
        1,
        &mut buffer,
        &server_index,
        &mut grafted,
      );
      out.write_all(renderer.finish().as_bytes())?;
    } else {
      let span_id = entry.root_span.get_str("client.span_id").unwrap_or("");
      if !span_id.is_empty() && grafted.contains(span_id) {
        continue;
      }
      if is_foldable_static_request(entry) {
        pending.push(entry);
        continue;
      }
      out.write_all(render_static_fold(&pending, viz).as_bytes())?;
      pending.clear();
      if is_suppressed_request(entry) {
        continue;
      }
      out.write_all(render_entry(entry, viz).as_bytes())?;
    }
  }
  out.write_all(render_static_fold(&pending, viz).as_bytes())?;

  Ok(())
}

/// Render just an event (for standalone events without a parent span)
pub fn render_standalone_event(event: &LjsonEvent, viz: &ColumnVisibility) -> String {
  let mut renderer = TerminalRenderer::new(viz);
  let buffer = GuidelineCharacter::new_buffer();

  if event.flag("initialize.is") {
    renderer.write_init_banner(event.get_str("initialize.app_name"));
  } else if let Some(trace_json) = event.get_str("exception.trace_json") {
    if let Ok(trace) = serde_json::from_str::<ExceptionWithTrace>(trace_json) {
      let ctx = RenderContext {
        origin: "server",
        span_kind: "default",
        start_ts: None,
        graft_prefix: String::new(),
      };
      renderer.write_exception(trace, &ctx, 0, &buffer);
    }
  } else {
    let ctx = RenderContext {
      origin: "server",
      span_kind: "default",
      start_ts: None,
      graft_prefix: String::new(),
    };
    renderer.render_event(event, &ctx, 0, &buffer);
  }

  renderer.finish()
}

/// Internal terminal renderer state. Carries a `&ColumnVisibility` borrow so
/// the column helpers can skip hidden column slots entirely (no separator, no
/// padding) — the line collapses cleanly instead of leaving blank middle slots.
pub(crate) struct TerminalRenderer<'a> {
  pub(super) out: String,
  pub(super) viz: &'a ColumnVisibility,
}

impl<'a> TerminalRenderer<'a> {
  pub(super) fn new(viz: &'a ColumnVisibility) -> Self {
    TerminalRenderer {
      out: String::new(),
      viz,
    }
  }

  pub(super) fn finish(self) -> String {
    self.out
  }

  #[inline]
  pub(super) fn write(&mut self, s: &str) {
    self.out.push_str(s);
  }

  #[inline]
  pub(super) fn newline(&mut self) {
    self.out.push('\n');
  }

  #[inline]
  pub(super) fn column_origin(&mut self, origin: &str) {
    if !self.viz.is_visible(col::ORIGIN) {
      return;
    }
    match origin {
      "client" => self.write(&format!(" {CYAN}C{RESET} │")),
      _ => self.write(&format!(" {GRAY}S{RESET} │")),
    }
  }

  #[inline]
  pub(super) fn column_level(&mut self, level: &LjsonLevel) {
    if !self.viz.is_visible(col::LEVEL) {
      return;
    }
    self.write(level.colored_prefix());
    self.write("│");
  }

  #[inline]
  pub(super) fn column_elapsed(&mut self, elapsed: Option<i64>, tree_level: i32, is_upgrade: bool) {
    if !self.viz.is_visible(col::ELAPSED) {
      return;
    }
    if is_upgrade {
      // A 101 upgrade (websocket) span lives for the whole connection — its
      // "duration" is the connection lifetime, not latency. Render a `ws`
      // marker instead of a misleading slow-colored (red ≥5s) elapsed.
      self.write(&format!("{GRAY}{:>7.7}{RESET} │", "ws"));
      return;
    }
    let elapsed_u128 = elapsed.map(|e| e.max(0) as u128);
    if tree_level == 0 {
      // Slow-root scan: ≥5s red, ≥1s yellow, else plain. Children stay gray.
      let color = match elapsed_u128 {
        Some(ms) if ms >= 5_000 => RED,
        Some(ms) if ms >= 1_000 => YELLOW,
        _ => EMPTY,
      };
      let reset = if color.is_empty() { EMPTY } else { RESET };
      self.write(&format!(
        "{color}{:>7.7}{reset} │",
        elapsed_u128.map(format_ms).as_deref().unwrap_or(" ")
      ));
    } else {
      self.write(&format!(
        "{GRAY}{:>7.7}{RESET} │",
        elapsed_u128.map(format_ms).as_deref().unwrap_or(" ")
      ));
    }
  }

  #[inline]
  pub(super) fn column_timestamp(&mut self, ts: Option<DateTime<Utc>>) {
    if !self.viz.is_visible(col::TS) {
      return;
    }
    match ts {
      Some(t) => {
        let local = t.with_timezone(&chrono::Local);
        self.write(&format!(
          " {GRAY}{:>12}{RESET} │",
          local.format("%H:%M:%S%.3f")
        ));
      }
      None => self.write("              │"),
    }
  }

  #[inline]
  pub(super) fn column_connecting_ip(&mut self, connecting_ip: Option<&str>, is_cf: bool) {
    if !self.viz.is_visible(col::IP) {
      return;
    }
    self.write(&format!(
      " {:1.1}{:>20.20} │",
      if is_cf { "↗" } else { "" },
      connecting_ip.unwrap_or(""),
    ));
  }

  #[inline]
  pub(super) fn column_user_id(&mut self, user_id: Option<&str>) {
    if !self.viz.is_visible(col::USER) {
      return;
    }
    self.write(&format!(" {:>6.6} │", user_id.unwrap_or("")));
  }

  /// Write the full column prefix for a line. Each `column_*` helper checks
  /// `self.viz` and skips its slot when hidden.
  #[allow(clippy::too_many_arguments)]
  pub(super) fn write_columns(
    &mut self,
    origin: &str,
    level: &LjsonLevel,
    elapsed: Option<i64>,
    tree_level: i32,
    timestamp: Option<DateTime<Utc>>,
    connecting_ip: Option<&str>,
    is_cf: bool,
    user_id: Option<&str>,
    is_upgrade: bool,
  ) {
    self.column_level(level);
    self.column_elapsed(elapsed, tree_level, is_upgrade);
    self.column_timestamp(timestamp);
    self.column_connecting_ip(connecting_ip, is_cf);
    self.column_user_id(user_id);
    self.column_origin(origin);
  }

  /// Write blank columns (for exception box lines, etc.)
  fn write_blank_columns(&mut self, ctx: &RenderContext, level: &LjsonLevel) {
    self.write_columns(ctx.origin, level, None, 1, None, None, false, None, false);
  }

  #[inline]
  pub(super) fn content(&mut self, s: &str) {
    self.out.push_str(s);
  }

  pub(super) fn guidelines(level: i32, guideline_buffer: &GuidelineCharacterBuffer) -> String {
    let mut sb = String::from(GRAY);
    for i in 0..=level - 1 {
      if i as usize >= guideline_buffer.len() {
        break;
      }

      sb.push_str(match guideline_buffer[i as usize] {
        GuidelineCharacter::Empty => "  ",
        GuidelineCharacter::Continuation => "│ ",
        GuidelineCharacter::Finish => "└ ",
        GuidelineCharacter::Direct => "├ ",
      })
    }
    sb.push_str(RESET);
    sb
  }

  /// Render a client span's custom attributes as `├──`/`└──` field-tree lines at
  /// `level`, the way structured fields read under a normal log line. No-op for
  /// non-client origins (server data is already inlined in messages) and for
  /// spans with no display attributes. Attributes are the *leading* children of
  /// the span, so the last attribute is a `└` only when no real child
  /// spans/events follow it.
  fn render_span_attrs(
    &mut self,
    span: &LjsonSpan,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &mut GuidelineCharacterBuffer,
  ) {
    if ctx.origin != "client" {
      return;
    }
    let attrs = display_attrs(span);
    if attrs.is_empty() {
      return;
    }
    let has_children = !span.children.is_empty();
    let guideline_idx = (level - 1) as usize;
    let can_set = guideline_idx < guideline_buffer.len();

    for (i, (key, value)) in attrs.iter().enumerate() {
      let is_last_item = i == attrs.len() - 1 && !has_children;
      if can_set {
        guideline_buffer[guideline_idx] = if is_last_item {
          GuidelineCharacter::Finish
        } else {
          GuidelineCharacter::Direct
        };
      }
      self.render_attr_line(span, ctx, level, guideline_buffer, key, value);
      if can_set {
        guideline_buffer[guideline_idx] = if is_last_item {
          GuidelineCharacter::Empty
        } else {
          GuidelineCharacter::Continuation
        };
      }
    }
  }

  /// One field-tree line: blank level/elapsed/timestamp columns, then the
  /// guideline prefix and `key: value` (mirrors `render_event`'s column layout).
  fn render_attr_line(
    &mut self,
    span: &LjsonSpan,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
    key: &str,
    value: &str,
  ) {
    self.write_columns(
      ctx.origin,
      &span.level,
      None,
      level,
      None,
      None,
      false,
      None,
      false,
    );
    self.content(" ");
    if !ctx.graft_prefix.is_empty() {
      self.content(&ctx.graft_prefix);
    }
    self.content(&format!(
      "{}{key}: {value}\n",
      Self::guidelines(level, guideline_buffer),
    ));
  }

  fn write_init_banner(&mut self, app_name: Option<&str>) {
    self.write("\n\n");
    if let Some(app_name) = app_name {
      self.write(&format!("  {BOLD}{app_name}{RESET}\n"));
    }
    let now = Local::now();

    self.write("  ───\n");
    self.write(&format!(
      "  {}, {GREEN}{}{RESET}\n",
      now.format("%b %-d"),
      now.format("%-I:%M %p")
    ));
    self.write("\n");
    self.write(&format!("  Now (UTC)  : {}\n", Utc::now()));
    self.write(&format!("      (Local): {}\n", now));
    self.write(&"\n  ─── \n\n".to_string());
  }

  fn write_exception(
    &mut self,
    exception: ExceptionWithTrace,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
  ) {
    let info_level = LjsonLevel::Info;
    // Build parent guidelines (levels 0 to level-2) for consistent tree context
    let parent_guidelines = if level > 0 {
      let mut sb = String::from(GRAY);
      for i in 0..(level - 1) as usize {
        if i >= guideline_buffer.len() {
          break;
        }
        sb.push_str(match guideline_buffer[i] {
          GuidelineCharacter::Empty => "  ",
          GuidelineCharacter::Continuation => "│ ",
          GuidelineCharacter::Finish => "  ",
          GuidelineCharacter::Direct => "│ ",
        });
      }
      sb.push_str(RESET);
      sb
    } else {
      String::new()
    };

    let request_pad = if !ctx.graft_prefix.is_empty() {
      ctx.graft_prefix.clone()
    } else if ctx.span_kind == "request" && level > 0 {
      format!("{EMPTY:10}")
    } else {
      String::new()
    };

    let box_width = (term_columns() - 62).max(20) as usize;

    // Box top
    self.write_blank_columns(ctx, &info_level);
    self.write(&format!(
      " {request_pad}{parent_guidelines}┌{:─^width$}┄\n",
      "",
      width = box_width
    ));

    // Heading — "Panic" from the panic hook, "Error" for command failures
    let label = &exception.label;
    self.write_blank_columns(ctx, &info_level);
    if let Some(message) = &exception.message {
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {BOLD}{RED}{label}{RESET}: {message}\n",
      ));
    } else {
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {BOLD}{RED}{label}{RESET}\n",
      ));
    }

    // Sources
    if !exception.sources.is_empty() {
      self.write_blank_columns(ctx, &info_level);
      self.write(&format!(" {request_pad}{parent_guidelines}│\n"));
      self.write_blank_columns(ctx, &info_level);
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {BOLD}Caused by{RESET}:\n"
      ));
      for (i, source) in exception.sources.iter().enumerate() {
        self.write_blank_columns(ctx, &info_level);
        self.write(&format!(
          " {request_pad}{parent_guidelines}│ {:4.4} │ {}\n",
          i, source
        ));
      }
    }

    // Stack trace
    self.write_blank_columns(ctx, &info_level);
    self.write(&format!(" {request_pad}{parent_guidelines}│\n"));
    if !exception.frames.is_empty() {
      self.write_blank_columns(ctx, &info_level);
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {BOLD}Stack trace{RESET}:\n"
      ));
      self.write_blank_columns(ctx, &info_level);
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {EMPTY:4} │ ...\n"
      ));
      for (idx, frame) in exception.filtered_frames().take(8) {
        self.write_blank_columns(ctx, &info_level);
        self.write(&format!(
          " {request_pad}{parent_guidelines}│ {:4.4} │ {}\n",
          idx, frame.func
        ));
        if let Some(file) = &frame.file {
          if !frame.is_core_or_stdlib() {
            self.write_blank_columns(ctx, &info_level);
            self.write(&format!(
              " {request_pad}{parent_guidelines}│ {EMPTY:4.4} │   {GRAY}{}",
              file
            ));
            if let Some(line) = frame.line {
              self.write(":");
              self.write(&line.to_string());
            }
            self.write(RESET);
            self.write("\n");
          }
        };
      }
      self.write_blank_columns(ctx, &info_level);
      self.write(&format!(
        " {request_pad}{parent_guidelines}│ {EMPTY:4} │ ...\n"
      ));
    }
    self.write_blank_columns(ctx, &info_level);
    self.write(&format!(" {request_pad}{parent_guidelines}│\n"));

    // Box bottom
    self.write_blank_columns(ctx, &info_level);
    self.write(&format!(
      " {request_pad}{parent_guidelines}└{:─^width$}┄\n",
      "",
      width = box_width
    ));
  }

  fn render_span(
    &mut self,
    span: &LjsonSpan,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
  ) {
    match ctx.span_kind {
      "request" if ctx.origin != "client" => {
        self.render_request_span(span, ctx, level, guideline_buffer);
      }
      _ => {
        if level == 0 {
          self.write_columns(
            ctx.origin,
            &span.level,
            span.duration_ms,
            level,
            ctx.start_ts,
            None,
            false,
            None,
            false,
          );
        } else {
          self.write_columns(
            ctx.origin,
            &span.level,
            span.duration_ms,
            level,
            None,
            None,
            false,
            None,
            false,
          );
        }
        self.content(" ");
        if !ctx.graft_prefix.is_empty() {
          self.content(&ctx.graft_prefix);
        }
        if level != 0 {
          self.content(&Self::guidelines(level, guideline_buffer));
        }
        if span.name == "api-call" {
          let status = span.get_u64("http.status");
          let method = span.get_str("http.method");
          let path = span.get_str("http.path");
          self.write_session_http_content(
            status,
            method,
            path,
            TerminalRenderer::format_server_timing(span).as_deref(),
          );
        } else if ctx.origin == "client" && level == 0 {
          let label = client_labels::client_span_label(span, true);
          self.content(&label);
        } else {
          self.content(&span.level.apply_color(&span.name));
          self.content(" ");
          if let Some(message) = span.message() {
            self.content(message);
            self.content(" ");
          }
          self.content(&span.location.format());
          if let Some(st) = TerminalRenderer::format_server_timing(span) {
            self.content(&format!("  {GRAY}{st}{RESET}"));
          }
        }
      }
    }
    self.newline();
  }

  fn render_event(
    &mut self,
    event: &LjsonEvent,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
  ) {
    if event.flag("initialize.is") {
      self.write_init_banner(event.get_str("initialize.app_name"));
      return;
    }

    if let Some(trace_json) = event.get_str("exception.trace_json") {
      let mut trace = serde_json::from_str::<ExceptionWithTrace>(trace_json)
        .expect("trace_json has the wrong format");

      if ctx.span_kind == "request" {
        trace.filtered_range.1 = Some("actix_web::handler::handler_service".to_string());
      }

      self.write_exception(trace, ctx, level, guideline_buffer);
      return;
    }

    self.write_columns(
      ctx.origin,
      &event.level,
      event.elapsed_ms().map(|e| e as i64),
      level,
      None,
      None,
      false,
      None,
      false,
    );
    self.content(" ");
    if ctx.span_kind == "request" {
      if level == 0 {
        self.content(&format!("{EMPTY:8}"));
      } else {
        self.content(&format!("{}{EMPTY:10}", ctx.graft_prefix));
      }
    } else if !ctx.graft_prefix.is_empty() {
      self.content(&ctx.graft_prefix);
    }
    self.content(&format!(
      "{}{} {}\n",
      Self::guidelines(level, guideline_buffer),
      event.level.apply_color(event.message().unwrap_or("")),
      event.location.format()
    ));
  }

  pub(super) fn render_children(
    &mut self,
    children: &[LjsonChild],
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &mut GuidelineCharacterBuffer,
  ) {
    let buffer_len = guideline_buffer.len();
    let guideline_idx = (level - 1) as usize;
    let can_set_guideline = guideline_idx < buffer_len;

    if can_set_guideline {
      guideline_buffer[guideline_idx] = GuidelineCharacter::Continuation;
    }

    for (idx, child) in children.iter().enumerate() {
      let child_is_last = idx == children.len() - 1;
      let did_guideline_finish = can_set_guideline && child_is_last;

      match child {
        LjsonChild::Span(child_span) => {
          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Finish;
          } else if can_set_guideline {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Direct;
          }

          self.render_span(child_span, ctx, level, guideline_buffer);

          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Empty;
          } else if can_set_guideline {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Continuation;
          }

          self.render_span_attrs(child_span, ctx, level + 1, guideline_buffer);
          self.render_children(&child_span.children, ctx, level + 1, guideline_buffer);
        }
        LjsonChild::Event(event) => {
          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Finish;
          }

          self.render_event(event, ctx, level, guideline_buffer);

          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Empty;
          }
        }
      }
    }
  }

  /// Like `render_children` but checks each child span for `client.span_id`
  /// matches against the server index, grafting server request trees in place
  /// of matching client api-call spans.
  fn render_children_graftable(
    &mut self,
    children: &[LjsonChild],
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &mut GuidelineCharacterBuffer,
    server_index: &std::collections::HashMap<&str, &LjsonEntry>,
    grafted: &mut std::collections::HashSet<String>,
  ) {
    let buffer_len = guideline_buffer.len();
    let guideline_idx = (level - 1) as usize;
    let can_set_guideline = guideline_idx < buffer_len;

    if can_set_guideline {
      guideline_buffer[guideline_idx] = GuidelineCharacter::Continuation;
    }

    for (idx, child) in children.iter().enumerate() {
      let child_is_last = idx == children.len() - 1;
      let did_guideline_finish = can_set_guideline && child_is_last;

      match child {
        LjsonChild::Span(child_span) => {
          let graft_match = child_span
            .get_str("client.span_id")
            .and_then(|sid| server_index.get(sid).map(|entry| (sid, *entry)));

          if let Some((span_id, server_entry)) = graft_match {
            // Set guideline for the grafted root line
            if did_guideline_finish {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Finish;
            } else if can_set_guideline {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Direct;
            }

            // Render the server root at this client tree position
            self.render_grafted_root(
              &server_entry.root_span,
              server_entry,
              level,
              guideline_buffer,
            );

            // Update guideline for continuation/empty after the grafted root
            if did_guideline_finish {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Empty;
            } else if can_set_guideline {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Continuation;
            }

            // Build graft_prefix from current client guidelines
            let graft_prefix = Self::guidelines(level, guideline_buffer);

            let server_start_ts = server_entry
              .root_span
              .duration_ms
              .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));
            let server_ctx = RenderContext {
              origin: "server",
              span_kind: "default",
              start_ts: server_start_ts,
              graft_prefix,
            };

            // Render server children with a fresh guideline buffer
            let mut server_buffer = GuidelineCharacter::new_buffer();
            self.render_children(
              &server_entry.root_span.children,
              &server_ctx,
              1,
              &mut server_buffer,
            );

            grafted.insert(span_id.to_string());
          } else {
            // No graft match: render span normally
            if did_guideline_finish {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Finish;
            } else if can_set_guideline {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Direct;
            }

            self.render_span(child_span, ctx, level, guideline_buffer);

            if did_guideline_finish {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Empty;
            } else if can_set_guideline {
              guideline_buffer[guideline_idx] = GuidelineCharacter::Continuation;
            }

            self.render_span_attrs(child_span, ctx, level + 1, guideline_buffer);
            // Recurse with graftable to find deeper graft points
            self.render_children_graftable(
              &child_span.children,
              ctx,
              level + 1,
              guideline_buffer,
              server_index,
              grafted,
            );
          }
        }
        LjsonChild::Event(event) => {
          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Finish;
          }

          self.render_event(event, ctx, level, guideline_buffer);

          if did_guideline_finish {
            guideline_buffer[guideline_idx] = GuidelineCharacter::Empty;
          }
        }
      }
    }
  }
}

#[cfg(test)]
mod static_fold_tests {
  use super::*;
  use crate::ljson::{LjsonEntry, LjsonLevel, LjsonLocation, LjsonSpan};
  use std::collections::HashMap;
  use uuid::Uuid;

  /// Drop ANSI color escapes so assertions match on plain text.
  fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
      if c == '\u{1b}' {
        for n in chars.by_ref() {
          if n == 'm' {
            break;
          }
        }
      } else {
        out.push(c);
      }
    }
    out
  }

  /// A server-side HTTP request entry with the attributes the renderer
  /// inspects, and an explicit span duration.
  fn req_dur(method: &str, status: u64, host: &str, target: &str, dur_ms: i64) -> LjsonEntry {
    let mut attributes = HashMap::new();
    attributes.insert("span.kind".to_string(), serde_json::json!("request"));
    attributes.insert("http.method".to_string(), serde_json::json!(method));
    attributes.insert("http.status_code".to_string(), serde_json::json!(status));
    attributes.insert("http.host".to_string(), serde_json::json!(host));
    attributes.insert("http.target".to_string(), serde_json::json!(target));
    LjsonEntry {
      v: 1,
      ts: Utc::now(),
      session_id: Uuid::nil(),
      origin: Some("server".to_string()),
      root_span: LjsonSpan {
        id: 1,
        name: String::new(),
        level: LjsonLevel::Info,
        duration_ms: Some(dur_ms),
        location: LjsonLocation {
          file: None,
          line: None,
        },
        attributes,
        children: Vec::new(),
      },
    }
  }

  fn req(method: &str, status: u64, host: &str, target: &str) -> LjsonEntry {
    req_dur(method, status, host, target, 5)
  }

  fn render(entries: &[LjsonEntry]) -> String {
    strip_ansi(&render_unified(entries, &ColumnVisibility::all()))
  }

  /// Raw (ANSI-retained) render, for asserting on color escapes.
  fn render_raw(entries: &[LjsonEntry]) -> String {
    render_unified(entries, &ColumnVisibility::all())
  }

  #[test]
  fn consecutive_static_run_collapses_to_summary() {
    let entries = vec![
      req("GET", 200, "dev--static.lo", "/js/m/a.js"),
      req("GET", 200, "dev--static.lo", "/js/m/b.js"),
      req("GET", 200, "dev--static.lo", "/js/m/c.js"),
      req("GET", 200, "dev--calendar.", "/api/user/initial_payload"),
    ];
    let out = render(&entries);
    assert!(
      out.contains("served 3 static assets"),
      "summary missing:\n{out}"
    );
    assert!(out.contains("dev--static.lo"), "host missing:\n{out}");
    // The individual module fetches are folded away…
    assert!(!out.contains("/js/m/a.js"), "module line leaked:\n{out}");
    // …but the real API request still renders.
    assert!(
      out.contains("/api/user/initial_payload"),
      "api line missing:\n{out}"
    );
  }

  #[test]
  fn lone_static_request_renders_normally() {
    let entries = vec![
      req("GET", 200, "dev--static.lo", "/js/m/only.js"),
      req("GET", 200, "dev--calendar.", "/api/x"),
    ];
    let out = render(&entries);
    assert!(
      !out.contains("served"),
      "should not summarize a single fetch:\n{out}"
    );
    assert!(
      out.contains("/js/m/only.js"),
      "lone static should render:\n{out}"
    );
  }

  #[test]
  fn asset_errors_are_never_folded() {
    let entries = vec![
      req("GET", 200, "dev--static.lo", "/js/m/a.js"),
      req("GET", 404, "dev--static.lo", "/js/m/missing.js"),
      req("GET", 200, "dev--static.lo", "/js/m/b.js"),
    ];
    let out = render(&entries);
    // The 404 breaks the run and stays visible; the two 200s are lone → render.
    assert!(
      out.contains("/js/m/missing.js"),
      "404 must stay visible:\n{out}"
    );
    assert!(
      !out.contains("served"),
      "runs of 1 shouldn't summarize:\n{out}"
    );
  }

  #[test]
  fn cached_304s_are_counted() {
    let entries = vec![
      req("GET", 200, "dev--static.lo", "/js/m/a.js"),
      req("GET", 304, "dev--static.lo", "/js/m/b.js"),
      req("GET", 304, "dev--static.lo", "/js/m/c.js"),
      req("POST", 200, "dev--calendar.", "/api/end"),
    ];
    let out = render(&entries);
    assert!(
      out.contains("served 3 static assets (2 cached)"),
      "cached count wrong:\n{out}"
    );
  }

  #[test]
  fn api_requests_are_not_static() {
    let entries = vec![req("GET", 200, "dev--calendar.", "/api/rows/foo/cells")];
    let out = render(&entries);
    assert!(
      out.contains("/api/rows/foo/cells"),
      "api GET must render:\n{out}"
    );
    assert!(!out.contains("served"), "api GET must not fold:\n{out}");
  }

  // ---- N5: instrumentation / OPTIONS suppression ----

  #[test]
  fn instrumentation_endpoints_are_suppressed() {
    let entries = vec![
      req("OPTIONS", 200, "dev.example.test", "/_/ux-test/logs"),
      req("POST", 200, "dev.example.test", "/_/ux-test/logs"),
      req("POST", 200, "dev--calendar.", "/api/tracing/entries"),
      req("GET", 200, "dev--calendar.", "/api/user/initial_payload"),
    ];
    let out = render(&entries);
    assert!(
      !out.contains("/_/ux-test/logs"),
      "ux-test logs suppressed:\n{out}"
    );
    assert!(
      !out.contains("/api/tracing/entries"),
      "tracing entries suppressed:\n{out}"
    );
    assert!(
      out.contains("/api/user/initial_payload"),
      "real API request must render:\n{out}"
    );
  }

  #[test]
  fn options_preflight_is_suppressed() {
    let entries = vec![req("OPTIONS", 200, "dev--calendar.", "/api/sheets/abc")];
    let out = render(&entries);
    assert!(
      out.trim().is_empty(),
      "200 OPTIONS preflight should be suppressed:\n{out:?}"
    );
  }

  #[test]
  fn failed_instrumentation_still_renders() {
    let entries = vec![req("POST", 500, "dev.example.test", "/_/ux-test/logs")];
    let out = render(&entries);
    assert!(
      out.contains("/_/ux-test/logs"),
      "5xx on a suppressed path must stay visible:\n{out}"
    );
  }

  // ---- N6: websocket 101 not slow-colored ----

  #[test]
  fn websocket_upgrade_not_slow_colored() {
    // A 10s-lived 101 upgrade would otherwise render RED ("slow").
    let entries = vec![req_dur(
      "GET",
      101,
      "dev--calendar.",
      "/api/ws?clientId=465",
      10_000,
    )];
    let raw = render_raw(&entries);
    assert!(
      !raw.contains("\u{1b}[31m"),
      "ws upgrade must not be slow-colored red:\n{raw}"
    );
    let out = strip_ansi(&raw);
    assert!(out.contains("ws"), "ws marker missing:\n{out}");
    assert!(
      out.contains("/api/ws"),
      "ws request should still render:\n{out}"
    );
  }

  #[test]
  fn slow_non_ws_request_still_red() {
    // Sanity: the slow-color path still fires for a genuinely slow request.
    let entries = vec![req_dur("GET", 200, "dev--calendar.", "/api/slow", 10_000)];
    let raw = render_raw(&entries);
    assert!(
      raw.contains("\u{1b}[31m"),
      "a 10s request should still be slow-colored:\n{raw}"
    );
  }
}

#[cfg(test)]
mod golden_tests {
  use super::*;
  use crate::ljson::{LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation};
  use std::collections::HashMap;

  fn fixture_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("examples")
      .join("fixtures")
  }

  fn load_and_render(name: &str) -> String {
    let path = fixture_dir().join(format!("{name}.ljson"));
    let content = std::fs::read_to_string(&path)
      .unwrap_or_else(|_| panic!("fixture not found: {}", path.display()));

    let viz = ColumnVisibility::all();
    content
      .lines()
      .filter(|l| !l.trim().is_empty())
      .map(|l| {
        let entry: LjsonEntry =
          serde_json::from_str(l).unwrap_or_else(|e| panic!("invalid LJSON: {e}\nline: {l}"));
        render_entry(&entry, &viz)
      })
      .collect()
  }

  fn assert_golden(name: &str) {
    let rendered = load_and_render(name);
    let expected_path = fixture_dir().join(format!("{name}.expected"));

    if std::env::var("GOLDEN_UPDATE").is_ok() {
      std::fs::write(&expected_path, &rendered).unwrap();
      println!("Updated golden file: {}", expected_path.display());
      return;
    }

    let expected = std::fs::read_to_string(&expected_path).unwrap_or_else(|_| {
      panic!(
        "golden file not found: {} (run with GOLDEN_UPDATE=1 to generate)",
        expected_path.display()
      )
    });

    if rendered != expected {
      for (i, (a, b)) in rendered.lines().zip(expected.lines()).enumerate() {
        if a != b {
          println!("Line {i} differs:");
          println!("  got:      {a:?}");
          println!("  expected: {b:?}");
        }
      }
      let rendered_lines = rendered.lines().count();
      let expected_lines = expected.lines().count();
      if rendered_lines != expected_lines {
        println!("Line count: got {rendered_lines}, expected {expected_lines}");
      }
      panic!("Golden test mismatch for {name}");
    }
  }

  /// Normalize exception border dashes so output is terminal-width-independent.
  fn normalize_dashes(s: &str) -> String {
    let mut result = String::new();
    let mut in_dash = false;
    for ch in s.chars() {
      if ch == '─' {
        if !in_dash {
          result.push_str("───");
          in_dash = true;
        }
      } else {
        in_dash = false;
        result.push(ch);
      }
    }
    result
  }

  fn assert_golden_normalized(name: &str) {
    let rendered = normalize_dashes(&load_and_render(name));
    let expected_path = fixture_dir().join(format!("{name}.expected"));

    if std::env::var("GOLDEN_UPDATE").is_ok() {
      std::fs::write(&expected_path, &rendered).unwrap();
      println!("Updated golden file: {}", expected_path.display());
      return;
    }

    let expected = normalize_dashes(&std::fs::read_to_string(&expected_path).unwrap_or_else(
      |_| {
        panic!(
          "golden file not found: {} (run with GOLDEN_UPDATE=1 to generate)",
          expected_path.display()
        )
      },
    ));

    if rendered != expected {
      for (i, (a, b)) in rendered.lines().zip(expected.lines()).enumerate() {
        if a != b {
          println!("Line {i} differs:");
          println!("  got:      {a:?}");
          println!("  expected: {b:?}");
        }
      }
      let rendered_lines = rendered.lines().count();
      let expected_lines = expected.lines().count();
      if rendered_lines != expected_lines {
        println!("Line count: got {rendered_lines}, expected {expected_lines}");
      }
      panic!("Golden test mismatch for {name}");
    }
  }

  fn load_and_render_unified(name: &str) -> String {
    let path = fixture_dir().join(format!("{name}.ljson"));
    let content = std::fs::read_to_string(&path)
      .unwrap_or_else(|_| panic!("fixture not found: {}", path.display()));
    let entries: Vec<LjsonEntry> = content
      .lines()
      .filter(|l| !l.trim().is_empty())
      .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("invalid LJSON: {e}\nline: {l}")))
      .collect();
    render_unified(&entries, &ColumnVisibility::all())
  }

  fn assert_golden_unified_normalized(name: &str) {
    let rendered = normalize_dashes(&load_and_render_unified(name));
    let expected_path = fixture_dir().join(format!("{name}.expected"));

    if std::env::var("GOLDEN_UPDATE").is_ok() {
      std::fs::write(&expected_path, &rendered).unwrap();
      println!("Updated golden file: {}", expected_path.display());
      return;
    }

    let expected = normalize_dashes(&std::fs::read_to_string(&expected_path).unwrap_or_else(
      |_| {
        panic!(
          "golden file not found: {} (run with GOLDEN_UPDATE=1 to generate)",
          expected_path.display()
        )
      },
    ));

    if rendered != expected {
      for (i, (a, b)) in rendered.lines().zip(expected.lines()).enumerate() {
        if a != b {
          println!("Line {i} differs:");
          println!("  got:      {a:?}");
          println!("  expected: {b:?}");
        }
      }
      let rendered_lines = rendered.lines().count();
      let expected_lines = expected.lines().count();
      if rendered_lines != expected_lines {
        println!("Line count: got {rendered_lines}, expected {expected_lines}");
      }
      panic!("Golden test mismatch for {name}");
    }
  }

  #[test]
  fn golden_requests() {
    assert_golden("requests");
  }

  #[test]
  fn golden_client_attrs() {
    assert_golden("client_attrs");
  }

  #[test]
  fn client_span_attrs_render_as_field_tree_via_unified() {
    // The unified (graftable) path must also expand client span attributes.
    let json = concat!(
      r#"{"v":1,"ts":"2026-01-30T10:00:00Z","sessionId":"00000000-0000-0000-0000-000000000000","#,
      r#""origin":"client","rootSpan":{"id":1,"name":"event-drag","level":"info","durationMs":5,"#,
      r#""location":{"file":"drag.ts","line":1},"#,
      r#""attributes":{"eventId":"evt_123","fromTime":"10:00","toTime":"14:00"},"children":[]}}"#,
    );
    let entry: LjsonEntry = serde_json::from_str(json).unwrap();
    let out = render_unified(std::slice::from_ref(&entry), &ColumnVisibility::all());
    assert!(
      out.contains("eventId: evt_123"),
      "field eventId missing:\n{out}"
    );
    assert!(
      out.contains("fromTime: 10:00"),
      "field fromTime missing:\n{out}"
    );
    assert!(
      out.contains("toTime: 14:00"),
      "field toTime missing:\n{out}"
    );
    assert!(
      out.contains('├') || out.contains('└'),
      "tree guideline missing:\n{out}"
    );
  }

  #[test]
  fn server_span_attrs_not_expanded() {
    // Server-origin custom attributes are NOT expanded into a field tree
    // (server data is already inlined in messages).
    let json = concat!(
      r#"{"v":1,"ts":"2026-01-30T10:00:00Z","sessionId":"00000000-0000-0000-0000-000000000000","#,
      r#""origin":"server","rootSpan":{"id":1,"name":"task","level":"info","durationMs":5,"#,
      r#""location":{"file":"t.rs","line":1},"attributes":{"custom_key":"should_not_show"},"children":[]}}"#,
    );
    let entry: LjsonEntry = serde_json::from_str(json).unwrap();
    let out = render_entry(&entry, &ColumnVisibility::all());
    assert!(
      !out.contains("custom_key: should_not_show"),
      "server custom attr should NOT be expanded as a field tree:\n{out}"
    );
  }

  #[test]
  fn golden_default_spans() {
    assert_golden("default_spans");
  }

  #[test]
  fn golden_exceptions() {
    assert_golden_normalized("exceptions");
  }

  #[test]
  fn golden_unified_session() {
    assert_golden_unified_normalized("unified_session");
  }

  #[test]
  fn test_init_banner_standalone() {
    let event = LjsonEvent {
      level: LjsonLevel::Info,
      location: LjsonLocation {
        file: None,
        line: None,
      },
      attributes: {
        let mut m = HashMap::new();
        m.insert("initialize.is".to_string(), serde_json::json!(true));
        m.insert(
          "initialize.app_name".to_string(),
          serde_json::json!("TestApp"),
        );
        m
      },
    };

    let output = render_standalone_event(&event, &ColumnVisibility::all());
    assert!(output.contains("TestApp"), "should contain app name");
    assert!(output.contains("───"), "should contain box chars");
    assert!(output.contains("Now (UTC)"), "should contain UTC label");
    assert!(output.contains("(Local)"), "should contain Local label");
  }

  #[test]
  fn test_init_banner_inside_span() {
    let json = concat!(
      r#"{"v":1,"ts":"2026-01-30T10:00:00Z","sessionId":"00000000-0000-0000-0000-000000000000","#,
      r#""rootSpan":{"id":1,"name":"startup","level":"info","durationMs":10,"#,
      r#""location":{"file":"main.rs","line":1},"attributes":{},"children":["#,
      r#"{"type":"event","level":"info","location":{"file":"main.rs","line":5},"#,
      r#""attributes":{"initialize.is":true,"initialize.app_name":"TestApp"}}]}}"#,
    );

    let entry: LjsonEntry = serde_json::from_str(json).unwrap();
    let output = render_entry(&entry, &ColumnVisibility::all());
    assert!(output.contains("TestApp"), "should contain app name");
    assert!(output.contains("───"), "should contain box chars");
  }

  #[test]
  fn test_standalone_exception() {
    let trace = ExceptionWithTrace {
      message: Some("standalone panic".to_string()),
      sources: vec![],
      frames: vec![],
      filtered_range: (None, None),
      label: "Panic".to_string(),
    };
    let trace_json = serde_json::to_string(&trace).unwrap();

    let event = LjsonEvent {
      level: LjsonLevel::Error,
      location: LjsonLocation {
        file: None,
        line: None,
      },
      attributes: {
        let mut m = HashMap::new();
        m.insert(
          "exception.trace_json".to_string(),
          serde_json::json!(trace_json),
        );
        m
      },
    };

    let output = render_standalone_event(&event, &ColumnVisibility::all());
    assert!(output.contains("Panic"), "should contain Panic label");
    assert!(
      output.contains("standalone panic"),
      "should contain message"
    );
    assert!(output.contains("┌"), "should contain box top");
    assert!(output.contains("└"), "should contain box bottom");
  }

  #[test]
  fn trace_default_hides_ip_and_user_columns() {
    // The `ux-test view` / trace default hides `ip` and `user`. Compare
    // against the all-visible baseline: those column slots must disappear
    // entirely (no separator, no padding) rather than render as blanks.
    let path = fixture_dir().join("client_attrs.ljson");
    let content = std::fs::read_to_string(&path).expect("fixture");
    let entries: Vec<LjsonEntry> = content
      .lines()
      .filter(|l| !l.trim().is_empty())
      .map(|l| serde_json::from_str(l).expect("ljson"))
      .collect();

    let all = render_unified(&entries, &ColumnVisibility::all());
    let hidden = render_unified(&entries, &ColumnVisibility::hiding([col::IP, col::USER]));

    // The 21-char IP slot + the 8-char user slot vanish; the hidden render is
    // strictly shorter and the all-visible render contains the literal 20-space
    // blank ip slot that the hidden render must not.
    assert!(hidden.len() < all.len(), "hidden render should be shorter");
    let blank_ip = format!(" {empty:>20.20} │", empty = "");
    assert!(
      all.contains(&blank_ip),
      "baseline should contain the 20-space blank ip slot"
    );
    assert!(
      !hidden.contains(&blank_ip),
      "trace default should drop the blank ip slot:\n{hidden}"
    );
    // Page content must still render — only the columns changed.
    assert!(hidden.contains("page-load"), "page-load entry preserved");
    assert!(hidden.contains("eventId: evt_123"), "field tree preserved");
  }

  #[test]
  fn test_standalone_event_default() {
    let event = LjsonEvent {
      level: LjsonLevel::Info,
      location: LjsonLocation {
        file: Some("test.rs".to_string()),
        line: Some(42),
      },
      attributes: {
        let mut m = HashMap::new();
        m.insert("message".to_string(), serde_json::json!("standalone msg"));
        m
      },
    };

    let output = render_standalone_event(&event, &ColumnVisibility::all());
    assert!(
      output.contains("standalone msg"),
      "should contain the message"
    );
    assert!(output.contains("test.rs:42"), "should contain location");
  }
}
