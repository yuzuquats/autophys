//! HTTP request formatting for terminal rendering.
//!
//! Contains methods for rendering HTTP request spans, grafted server roots,
//! status codes, server timing, and compact session-mode HTTP content.

use crate::ljson::{LjsonEntry, LjsonSpan};

use super::{EMPTY, GRAY, GuidelineCharacterBuffer, RESET, RenderContext, TerminalRenderer};

impl<'a> TerminalRenderer<'a> {
  /// Render the `"request"` span kind (server-side HTTP request root).
  pub(super) fn render_request_span(
    &mut self,
    span: &LjsonSpan,
    ctx: &RenderContext,
    level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
  ) {
    if level == 0 {
      let cf_connecting_ip = span.get_str("user.connecting_ip");
      let ip = cf_connecting_ip.or_else(|| span.get_str("http.client_ip"));
      let user = span
        .get_str("user.id")
        .or_else(|| span.get_str("user.email"));
      // COMPATIBILITY SHIM: rows written before the field was renamed carry
      // `yuzu.dev_mode`, and log retention outlives the rename by weeks.
      // Delete the middle arm once no stored log predates it.
      let dev_mode = span
        .get_str("app.dev_mode")
        .or_else(|| span.get_str("yuzu.dev_mode"))
        .or_else(|| span.get_str("version.dev_flag"));
      // A 101 (Switching Protocols) is a websocket upgrade — render `ws` in the
      // elapsed column rather than its connection-lifetime duration.
      let is_upgrade = span.get_u64("http.status_code") == Some(101);
      self.write_columns(
        ctx.origin,
        &span.level,
        span.duration_ms,
        level,
        ctx.start_ts,
        ip,
        cf_connecting_ip.is_some(),
        user,
        is_upgrade,
      );
      self.content(" ");
      self.content_request_body(
        span.get_u64("http.status_code"),
        span.get_str("http.method"),
        dev_mode,
        span.get_str("http.host"),
        span.get_str("http.target"),
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
      self.content(&format!(
        " {}{EMPTY:10}{}{} {}",
        ctx.graft_prefix,
        Self::guidelines(level, guideline_buffer),
        if !span.name.is_empty() {
          span.level.apply_color(&span.name)
        } else {
          "<None>".to_string()
        },
        span.location.format()
      ));
    }
  }

  /// Render a server request root span at a client tree level position.
  pub(super) fn render_grafted_root(
    &mut self,
    server_span: &LjsonSpan,
    server_entry: &LjsonEntry,
    client_level: i32,
    guideline_buffer: &GuidelineCharacterBuffer,
  ) {
    let cf_connecting_ip = server_span.get_str("user.connecting_ip");
    let ip = cf_connecting_ip.or_else(|| server_span.get_str("http.client_ip"));
    let user = server_span
      .get_str("user.id")
      .or_else(|| server_span.get_str("user.email"));
    // COMPATIBILITY SHIM: see the note above — same rule on the grafted path.
    let dev_mode = server_span
      .get_str("app.dev_mode")
      .or_else(|| server_span.get_str("yuzu.dev_mode"))
      .or_else(|| server_span.get_str("version.dev_flag"));
    let start_ts = server_span
      .duration_ms
      .map(|d| server_entry.ts - chrono::Duration::milliseconds(d as i64));

    self.write_columns(
      "server",
      &server_span.level,
      server_span.duration_ms,
      0,
      start_ts,
      ip,
      cf_connecting_ip.is_some(),
      user,
      server_span.get_u64("http.status_code") == Some(101),
    );

    self.content(" ");
    self.content(&Self::guidelines(client_level, guideline_buffer));
    self.content_request_body(
      server_span.get_u64("http.status_code"),
      server_span.get_str("http.method"),
      dev_mode,
      server_span.get_str("http.host"),
      server_span.get_str("http.target"),
    );
    self.newline();
  }

  #[inline]
  pub(super) fn content_request_body(
    &mut self,
    status_code: Option<u64>,
    http_method: Option<&str>,
    dev_mode: Option<&str>,
    http_host: Option<&str>,
    http_target: Option<&str>,
  ) {
    self.write(&format!(
      "{} {:4.4} {} {:14.14} {:36.36}",
      match status_code {
        Some(sc) => match sc {
          200..=299 => format!("\u{001b}[34m{sc}\u{001b}[0m"),
          300..=399 => format!("\u{001b}[32m{sc}\u{001b}[0m"),
          400..=599 => format!("\u{001b}[31m{sc}\u{001b}[0m"),
          _ => format!("\u{001b}[34m{sc}\u{001b}[0m"),
        },
        None => "\u{001b}[31mErr\u{001b}[0m".to_string(),
      },
      http_method.unwrap_or(""),
      match dev_mode {
        Some("beta") => "\u{001b}[35mB\u{001b}[0m",
        Some("rc") => "\u{001b}[32mR\u{001b}[0m",
        Some("prod") => "\u{001b}[33mP\u{001b}[0m",
        _ => " ",
      },
      http_host.unwrap_or(""),
      http_target.unwrap_or("")
    ));
  }

  /// Extract server timing attributes from a span and format as a compact string.
  /// Returns None if no server.* attributes are present.
  ///
  /// Example: "total:45ms db:3ms garmin_api:121ms"
  pub(super) fn format_server_timing(span: &LjsonSpan) -> Option<String> {
    let mut parts: Vec<(String, f64)> = Vec::new();
    for (key, value) in &span.attributes {
      let Some(suffix) = key.strip_prefix("server.") else {
        continue;
      };
      let Some(suffix) = suffix.strip_suffix("_ms") else {
        continue;
      };
      let Some(ms) = value.as_f64() else { continue };
      parts.push((suffix.to_string(), ms));
    }
    if parts.is_empty() {
      return None;
    }
    parts.sort_by(|a, b| {
      if a.0 == "total" {
        return std::cmp::Ordering::Less;
      }
      if b.0 == "total" {
        return std::cmp::Ordering::Greater;
      }
      a.0.cmp(&b.0)
    });
    let formatted: Vec<String> = parts
      .iter()
      .map(|(name, ms)| format!("{name}:{ms:.0}ms"))
      .collect();
    Some(formatted.join(" "))
  }

  /// Write HTTP status/method/path content for session lines.
  pub(super) fn write_session_http_content(
    &mut self,
    status: Option<u64>,
    method: Option<&str>,
    path: Option<&str>,
    server_timing: Option<&str>,
  ) {
    self.content(&match status {
      Some(sc) => match sc {
        200..=299 => format!("\u{001b}[34m{sc}\u{001b}[0m"),
        300..=399 => format!("\u{001b}[32m{sc}\u{001b}[0m"),
        400..=599 => format!("\u{001b}[31m{sc}\u{001b}[0m"),
        _ => format!("\u{001b}[34m{sc}\u{001b}[0m"),
      },
      None => "\u{001b}[31mErr\u{001b}[0m".to_string(),
    });
    self.content(&format!(
      " {:4.4} {}",
      method.unwrap_or(""),
      path.unwrap_or("")
    ));
    if let Some(st) = server_timing {
      self.content(&format!("  {GRAY}{st}{RESET}"));
    }
  }
}
