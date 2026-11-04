//! Session rendering mode for terminal output.
//!
//! Produces a compact user-journey view where each API call is a single line,
//! user actions render with tree-structured children, and standalone entries
//! (view-state, etc.) appear as labeled lines.

use std::io::Write;

use chrono::{DateTime, Utc};

use crate::ljson::{LjsonChild, LjsonEntry, LjsonLevel, LjsonSpan};

use super::client_labels::{client_span_label, user_action_detail};
use super::{
  CYAN, ColumnVisibility, GRAY, GuidelineCharacter, RESET, RenderContext, TerminalRenderer,
};

/// Render entries in compact session mode — one line per API call.
///
/// Produces a compact user-journey view:
/// - User action entries (`user.action=true`) render with tree-structured children
/// - Client `api-call` children are matched to server entries via `client.span_id`
/// - Standalone view-state entries render as labeled lines
/// - Ungrafted server entries render as single-line summaries
/// - Error/warn entries still expand children
pub fn render_session(entries: &[LjsonEntry], viz: &ColumnVisibility) -> String {
  use std::collections::{HashMap, HashSet};

  // Build server index keyed by client.span_id
  let mut server_index: HashMap<&str, &LjsonEntry> = HashMap::new();
  for entry in entries {
    if !entry.is_client() {
      if let Some(sid) = entry.root_span.get_str("client.span_id") {
        server_index.insert(sid, entry);
      }
    }
  }

  let mut grafted: HashSet<String> = HashSet::new();
  let mut renderer = TerminalRenderer::new(viz);

  for entry in entries {
    if entry.is_client() {
      let start_ts = entry
        .root_span
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));

      let is_user_action = entry.root_span.get_bool("user.action").unwrap_or(false);

      if is_user_action {
        // (a) User action entries — render root + one-level-deep children
        let name = &entry.root_span.name;
        let detail = user_action_detail(&entry.root_span);
        let label = match &detail {
          Some(d) => format!("user/click: {CYAN}{name}{RESET} ({d})"),
          None => format!("user/click: {CYAN}{name}{RESET}"),
        };
        renderer.write_session_label_line(
          "client",
          &entry.root_span.level,
          entry.root_span.duration_ms,
          start_ts,
          None,
          &label,
        );

        let child_spans: Vec<&LjsonSpan> = entry
          .root_span
          .children
          .iter()
          .filter_map(|c| match c {
            LjsonChild::Span(s) => Some(s),
            _ => None,
          })
          .collect();

        for (i, child) in child_spans.iter().enumerate() {
          let is_last = i == child_spans.len() - 1;
          let tree_char = if is_last { "└" } else { "├" };

          if child.name == "api-call" {
            let graft = child
              .get_str("client.span_id")
              .and_then(|sid| server_index.get(sid).map(|e| (sid, *e)));

            if let Some((sid, server_entry)) = graft {
              let ss = &server_entry.root_span;
              let user = ss.get_str("user.id").or(ss.get_str("user.email"));
              let st = TerminalRenderer::format_server_timing(child);
              renderer.write_session_line_with_prefix(
                "client",
                &child.level,
                child.duration_ms,
                start_ts,
                user,
                ss.get_u64("http.status_code"),
                ss.get_str("http.method"),
                ss.get_str("http.target"),
                tree_char,
                st.as_deref(),
              );

              if ss.level >= LjsonLevel::Warn {
                let server_start_ts = ss
                  .duration_ms
                  .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));
                let ctx = RenderContext {
                  origin: "server",
                  span_kind: ss.get_str("span.kind").unwrap_or("default"),
                  start_ts: server_start_ts,
                  graft_prefix: String::new(),
                };
                let mut buf = GuidelineCharacter::new_buffer();
                renderer.render_children(&ss.children, &ctx, 1, &mut buf);
              }

              grafted.insert(sid.to_string());
            } else {
              let st = TerminalRenderer::format_server_timing(child);
              renderer.write_session_line_with_prefix(
                "client",
                &child.level,
                child.duration_ms,
                start_ts,
                None,
                child.get_u64("http.status"),
                child.get_str("http.method"),
                child.get_str("http.path"),
                tree_char,
                st.as_deref(),
              );
            }
          } else if child.name == "view-state" {
            let reason = child.get_str("reason").unwrap_or("");
            let ops = child.get_str("ops").unwrap_or("");
            let label =
              format!("{GRAY}{tree_char}{RESET} view-state {reason} {GRAY}[{ops}]{RESET}");
            renderer.write_session_label_line(
              "client",
              &child.level,
              child.duration_ms,
              start_ts,
              None,
              &label,
            );
          }
        }
      } else {
        // (b) and (c): Non-user-action client entries
        let api_calls: Vec<&LjsonSpan> = entry
          .root_span
          .children
          .iter()
          .filter_map(|c| match c {
            LjsonChild::Span(s) if s.name == "api-call" => Some(s),
            _ => None,
          })
          .collect();

        if api_calls.is_empty() {
          let has_http = entry.root_span.get_str("http.method").is_some()
            || entry.root_span.get_u64("http.status").is_some()
            || entry.root_span.get_u64("http.status_code").is_some();

          if has_http {
            // Root span is the api-call itself
            let st = TerminalRenderer::format_server_timing(&entry.root_span);
            renderer.write_session_line(
              "client",
              &entry.root_span.level,
              entry.root_span.duration_ms,
              start_ts,
              None,
              entry
                .root_span
                .get_u64("http.status")
                .or(entry.root_span.get_u64("http.status_code")),
              entry.root_span.get_str("http.method"),
              entry
                .root_span
                .get_str("http.path")
                .or(entry.root_span.get_str("http.target")),
              st.as_deref(),
            );
          } else {
            // (c) Standalone label entry (e.g. view-state)
            let label = client_span_label(&entry.root_span, false);
            renderer.write_session_label_line(
              "client",
              &entry.root_span.level,
              entry.root_span.duration_ms,
              start_ts,
              None,
              label.trim(),
            );
          }
        } else {
          // (b) Existing behavior: flat grafted lines for each api-call
          for api_span in &api_calls {
            let graft = api_span
              .get_str("client.span_id")
              .and_then(|sid| server_index.get(sid).map(|e| (sid, *e)));

            if let Some((sid, server_entry)) = graft {
              let ss = &server_entry.root_span;
              let user = ss.get_str("user.id").or(ss.get_str("user.email"));
              let st = TerminalRenderer::format_server_timing(api_span);

              renderer.write_session_line(
                "client",
                &api_span.level,
                api_span.duration_ms,
                start_ts,
                user,
                ss.get_u64("http.status_code"),
                ss.get_str("http.method"),
                ss.get_str("http.target"),
                st.as_deref(),
              );

              if ss.level >= LjsonLevel::Warn {
                let server_start_ts = ss
                  .duration_ms
                  .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));
                let ctx = RenderContext {
                  origin: "server",
                  span_kind: ss.get_str("span.kind").unwrap_or("default"),
                  start_ts: server_start_ts,
                  graft_prefix: String::new(),
                };
                let mut buf = GuidelineCharacter::new_buffer();
                renderer.render_children(&ss.children, &ctx, 1, &mut buf);
              }

              grafted.insert(sid.to_string());
            } else {
              let st = TerminalRenderer::format_server_timing(api_span);
              renderer.write_session_line(
                "client",
                &api_span.level,
                api_span.duration_ms,
                start_ts,
                None,
                api_span.get_u64("http.status"),
                api_span.get_str("http.method"),
                api_span.get_str("http.path"),
                st.as_deref(),
              );
            }
          }
        }

        // Expand client children on error/warn
        if entry.root_span.level >= LjsonLevel::Warn {
          let ctx = RenderContext {
            origin: "client",
            span_kind: "default",
            start_ts,
            graft_prefix: String::new(),
          };
          let mut buf = GuidelineCharacter::new_buffer();
          renderer.render_children(&entry.root_span.children, &ctx, 1, &mut buf);
        }
      }
    } else {
      // Server entry
      let sid = entry.root_span.get_str("client.span_id").unwrap_or("");
      if !sid.is_empty() && grafted.contains(sid) {
        continue;
      }

      let s = &entry.root_span;
      let user = s.get_str("user.id").or(s.get_str("user.email"));
      let start_ts = s
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));

      renderer.write_session_line(
        "server",
        &s.level,
        s.duration_ms,
        start_ts,
        user,
        s.get_u64("http.status_code"),
        s.get_str("http.method"),
        s.get_str("http.target"),
        None,
      );

      // Expand children on error/warn
      if s.level >= LjsonLevel::Warn {
        let span_kind = s.get_str("span.kind").unwrap_or("default");
        let ctx = RenderContext {
          origin: "server",
          span_kind,
          start_ts,
          graft_prefix: String::new(),
        };
        let mut buf = GuidelineCharacter::new_buffer();
        renderer.render_children(&s.children, &ctx, 1, &mut buf);
      }
    }
  }

  renderer.finish()
}

/// Streaming variant of `render_session` — writes directly to `out` entry-by-entry.
///
/// Avoids accumulating the full rendered output in memory. Each entry is
/// rendered to a temporary String and flushed immediately.
pub fn render_session_to<W: Write>(
  entries: &[LjsonEntry],
  out: &mut W,
  viz: &ColumnVisibility,
) -> std::io::Result<()> {
  use std::collections::{HashMap, HashSet};

  let mut server_index: HashMap<&str, &LjsonEntry> = HashMap::new();
  for entry in entries {
    if !entry.is_client() {
      if let Some(sid) = entry.root_span.get_str("client.span_id") {
        server_index.insert(sid, entry);
      }
    }
  }

  let mut grafted: HashSet<String> = HashSet::new();

  for entry in entries {
    if entry.is_client() {
      let mut renderer = TerminalRenderer::new(viz);
      let start_ts = entry
        .root_span
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));

      let is_user_action = entry.root_span.get_bool("user.action").unwrap_or(false);

      if is_user_action {
        let name = &entry.root_span.name;
        let detail = user_action_detail(&entry.root_span);
        let label = match &detail {
          Some(d) => format!("user/click: {CYAN}{name}{RESET} ({d})"),
          None => format!("user/click: {CYAN}{name}{RESET}"),
        };
        renderer.write_session_label_line(
          "client",
          &entry.root_span.level,
          entry.root_span.duration_ms,
          start_ts,
          None,
          &label,
        );

        let child_spans: Vec<&LjsonSpan> = entry
          .root_span
          .children
          .iter()
          .filter_map(|c| match c {
            LjsonChild::Span(s) => Some(s),
            _ => None,
          })
          .collect();

        for (i, child) in child_spans.iter().enumerate() {
          let is_last = i == child_spans.len() - 1;
          let tree_char = if is_last { "└" } else { "├" };

          if child.name == "api-call" {
            let graft = child
              .get_str("client.span_id")
              .and_then(|sid| server_index.get(sid).map(|e| (sid, *e)));

            if let Some((sid, server_entry)) = graft {
              let ss = &server_entry.root_span;
              let user = ss.get_str("user.id").or(ss.get_str("user.email"));
              let st = TerminalRenderer::format_server_timing(child);
              renderer.write_session_line_with_prefix(
                "client",
                &child.level,
                child.duration_ms,
                start_ts,
                user,
                ss.get_u64("http.status_code"),
                ss.get_str("http.method"),
                ss.get_str("http.target"),
                tree_char,
                st.as_deref(),
              );

              if ss.level >= LjsonLevel::Warn {
                let server_start_ts = ss
                  .duration_ms
                  .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));
                let ctx = RenderContext {
                  origin: "server",
                  span_kind: ss.get_str("span.kind").unwrap_or("default"),
                  start_ts: server_start_ts,
                  graft_prefix: String::new(),
                };
                let mut buf = GuidelineCharacter::new_buffer();
                renderer.render_children(&ss.children, &ctx, 1, &mut buf);
              }

              grafted.insert(sid.to_string());
            } else {
              let st = TerminalRenderer::format_server_timing(child);
              renderer.write_session_line_with_prefix(
                "client",
                &child.level,
                child.duration_ms,
                start_ts,
                None,
                child.get_u64("http.status"),
                child.get_str("http.method"),
                child.get_str("http.path"),
                tree_char,
                st.as_deref(),
              );
            }
          } else if child.name == "view-state" {
            let reason = child.get_str("reason").unwrap_or("");
            let ops = child.get_str("ops").unwrap_or("");
            let label =
              format!("{GRAY}{tree_char}{RESET} view-state {reason} {GRAY}[{ops}]{RESET}");
            renderer.write_session_label_line(
              "client",
              &child.level,
              child.duration_ms,
              start_ts,
              None,
              &label,
            );
          }
        }
      } else {
        let api_calls: Vec<&LjsonSpan> = entry
          .root_span
          .children
          .iter()
          .filter_map(|c| match c {
            LjsonChild::Span(s) if s.name == "api-call" => Some(s),
            _ => None,
          })
          .collect();

        if api_calls.is_empty() {
          let has_http = entry.root_span.get_str("http.method").is_some()
            || entry.root_span.get_u64("http.status").is_some()
            || entry.root_span.get_u64("http.status_code").is_some();

          if has_http {
            let st = TerminalRenderer::format_server_timing(&entry.root_span);
            renderer.write_session_line(
              "client",
              &entry.root_span.level,
              entry.root_span.duration_ms,
              start_ts,
              None,
              entry
                .root_span
                .get_u64("http.status")
                .or(entry.root_span.get_u64("http.status_code")),
              entry.root_span.get_str("http.method"),
              entry
                .root_span
                .get_str("http.path")
                .or(entry.root_span.get_str("http.target")),
              st.as_deref(),
            );
          } else {
            let label = client_span_label(&entry.root_span, false);
            renderer.write_session_label_line(
              "client",
              &entry.root_span.level,
              entry.root_span.duration_ms,
              start_ts,
              None,
              label.trim(),
            );
          }
        } else {
          for api_span in &api_calls {
            let graft = api_span
              .get_str("client.span_id")
              .and_then(|sid| server_index.get(sid).map(|e| (sid, *e)));

            if let Some((sid, server_entry)) = graft {
              let ss = &server_entry.root_span;
              let user = ss.get_str("user.id").or(ss.get_str("user.email"));
              let st = TerminalRenderer::format_server_timing(api_span);

              renderer.write_session_line(
                "client",
                &api_span.level,
                api_span.duration_ms,
                start_ts,
                user,
                ss.get_u64("http.status_code"),
                ss.get_str("http.method"),
                ss.get_str("http.target"),
                st.as_deref(),
              );

              if ss.level >= LjsonLevel::Warn {
                let server_start_ts = ss
                  .duration_ms
                  .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));
                let ctx = RenderContext {
                  origin: "server",
                  span_kind: ss.get_str("span.kind").unwrap_or("default"),
                  start_ts: server_start_ts,
                  graft_prefix: String::new(),
                };
                let mut buf = GuidelineCharacter::new_buffer();
                renderer.render_children(&ss.children, &ctx, 1, &mut buf);
              }

              grafted.insert(sid.to_string());
            } else {
              let st = TerminalRenderer::format_server_timing(api_span);
              renderer.write_session_line(
                "client",
                &api_span.level,
                api_span.duration_ms,
                start_ts,
                None,
                api_span.get_u64("http.status"),
                api_span.get_str("http.method"),
                api_span.get_str("http.path"),
                st.as_deref(),
              );
            }
          }
        }

        if entry.root_span.level >= LjsonLevel::Warn {
          let ctx = RenderContext {
            origin: "client",
            span_kind: "default",
            start_ts,
            graft_prefix: String::new(),
          };
          let mut buf = GuidelineCharacter::new_buffer();
          renderer.render_children(&entry.root_span.children, &ctx, 1, &mut buf);
        }
      }

      out.write_all(renderer.finish().as_bytes())?;
    } else {
      let sid = entry.root_span.get_str("client.span_id").unwrap_or("");
      if !sid.is_empty() && grafted.contains(sid) {
        continue;
      }

      let mut renderer = TerminalRenderer::new(viz);
      let s = &entry.root_span;
      let user = s.get_str("user.id").or(s.get_str("user.email"));
      let start_ts = s
        .duration_ms
        .map(|d| entry.ts - chrono::Duration::milliseconds(d as i64));

      renderer.write_session_line(
        "server",
        &s.level,
        s.duration_ms,
        start_ts,
        user,
        s.get_u64("http.status_code"),
        s.get_str("http.method"),
        s.get_str("http.target"),
        None,
      );

      if s.level >= LjsonLevel::Warn {
        let span_kind = s.get_str("span.kind").unwrap_or("default");
        let ctx = RenderContext {
          origin: "server",
          span_kind,
          start_ts,
          graft_prefix: String::new(),
        };
        let mut buf = GuidelineCharacter::new_buffer();
        renderer.render_children(&s.children, &ctx, 1, &mut buf);
      }

      out.write_all(renderer.finish().as_bytes())?;
    }
  }

  Ok(())
}

/// Session-mode helper methods on TerminalRenderer.
impl<'a> TerminalRenderer<'a> {
  /// Write the session-mode column prefix: level │ elapsed │ time │ user │ origin │
  ///
  /// The session-mode time slot is keyed off `col::TS` (same path as the
  /// trace-mode timestamp column) so a single visibility config toggles both.
  fn write_session_columns(
    &mut self,
    origin: &str,
    level: &LjsonLevel,
    elapsed: Option<i64>,
    timestamp: Option<DateTime<Utc>>,
    user_id: Option<&str>,
  ) {
    self.column_level(level);
    self.column_elapsed(elapsed, 0, false);
    if self.viz.is_visible(super::col::TS) {
      match timestamp {
        Some(t) => {
          let local = t.with_timezone(&chrono::Local);
          self.write(&format!(" {:>8} │", local.format("%H:%M:%S")));
        }
        None => self.write("          │"),
      }
    }
    self.column_user_id(user_id);
    self.column_origin(origin);
  }

  /// Write a compact session-mode line: level │ elapsed │ time │ user │ origin │ status method path
  pub(super) fn write_session_line(
    &mut self,
    origin: &str,
    level: &LjsonLevel,
    elapsed: Option<i64>,
    timestamp: Option<DateTime<Utc>>,
    user_id: Option<&str>,
    status: Option<u64>,
    method: Option<&str>,
    path: Option<&str>,
    server_timing: Option<&str>,
  ) {
    self.write_session_columns(origin, level, elapsed, timestamp, user_id);
    self.content(" ");
    self.write_session_http_content(status, method, path, server_timing);
    self.newline();
  }

  /// Write a session-mode HTTP line with tree prefix.
  pub(super) fn write_session_line_with_prefix(
    &mut self,
    origin: &str,
    level: &LjsonLevel,
    elapsed: Option<i64>,
    timestamp: Option<DateTime<Utc>>,
    user_id: Option<&str>,
    status: Option<u64>,
    method: Option<&str>,
    path: Option<&str>,
    tree_char: &str,
    server_timing: Option<&str>,
  ) {
    self.write_session_columns(origin, level, elapsed, timestamp, user_id);
    self.content(&format!(" {GRAY}{tree_char}{RESET} "));
    self.write_session_http_content(status, method, path, server_timing);
    self.newline();
  }

  /// Write a labeled session-mode line: level │ elapsed │ time │ user │ origin │ content
  pub(super) fn write_session_label_line(
    &mut self,
    origin: &str,
    level: &LjsonLevel,
    elapsed: Option<i64>,
    timestamp: Option<DateTime<Utc>>,
    user_id: Option<&str>,
    content: &str,
  ) {
    self.write_session_columns(origin, level, elapsed, timestamp, user_id);
    self.content(" ");
    self.content(content);
    self.newline();
  }
}
