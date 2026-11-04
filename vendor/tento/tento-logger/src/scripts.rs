//! The `logs.*` command group over local `span-tree/v1` buckets.
//!
//! `logs.render` and `logs.bundler` used to read the legacy `LOAF_LOGS_DIR`
//! parquet symlinks. The fleet log substrate is now the bucket tree:
//! `<root>/<host>/<node-path>/<stream>/{samples,daily,weekly}`.

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration as StdDuration;

use anyhow::Context;
use chrono::{DateTime, Duration, Local, Utc};
use serde::Deserialize;
use tento_logger_spans::{SpanRow, recompose, render_order_key};
use tento_sh::{CommandArg, command};
use tento_timeseries::TimeSeriesStore;
use uuid::Uuid;

use crate::ljson::{LjsonEntry, LjsonLevel};
use crate::render::project::{LogZoom, tree_to_entry};
use crate::render::terminal::ColumnVisibility;
use crate::render::{render_session_to, render_unified_to};

/// Context for the `logs.*` group.
#[derive(Clone, Debug)]
pub struct LogsScriptsContext {
  /// Optional crash-path text log directory. Used only by `logs.rotate`.
  pub logs_dir: Option<PathBuf>,
  /// Root of the bucket tree.
  pub buckets_root: PathBuf,
  /// Host segment under `buckets_root`.
  pub host: String,
  /// Node path whose app logs are rendered, usually `server-app`.
  pub node_path: String,
}

/// The `logs.render` / `logs.rotate` / `logs.bundler` command group.
pub fn scripts(ctx: LogsScriptsContext) -> tento_sh::Scripts<LogsScriptsContext> {
  tento_sh::Scripts::new(ctx)
    .add_command(logs_render)
    .add_command(logs_rotate)
    .add_command(logs_bundler)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogsView {
  App,
  Raw,
  All,
}

impl LogsView {
  fn from_arg(value: Option<&str>) -> anyhow::Result<Self> {
    match value.unwrap_or("app") {
      "app" => Ok(Self::App),
      "raw" => Ok(Self::Raw),
      "all" => Ok(Self::All),
      other => anyhow::bail!("Invalid view {other:?}. Use app|raw|all"),
    }
  }

  fn streams(self) -> &'static [&'static str] {
    match self {
      Self::App => &["spans", "startup", "bundling"],
      Self::Raw => &["logs"],
      Self::All => &["spans", "startup", "bundling", "logs"],
    }
  }
}

/// Arguments for the logs.render command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct LogsRenderArgs {
  /// Timestamp filter (RFC3339 or relative like '5m', '1h')
  since: Option<String>,
  /// Show only the last N entries in less (default: 200)
  tail: Option<usize>,
  /// Dump all entries to stdout instead of opening less
  #[serde(default)]
  all: bool,
  /// Minimum log level to display (trace|debug|info|warn|error)
  level: Option<String>,
  /// Filter to a specific tracing session ID (UUID).
  session: Option<String>,
  /// Top-level bucket view: app|raw|all. Default app.
  view: Option<String>,
  /// Exact stream bucket to read, e.g. spans, startup, bundling, logs.
  stream: Option<String>,
  /// Projection depth: collapsed|messages|fields. Default messages.
  zoom: Option<String>,
  /// Comma-separated visible column list.
  columns: Option<String>,
  /// Comma-separated columns to hide. Wins over `--columns`.
  hide: Option<String>,
}

/// Render app logs from bucket streams.
#[command(
  name = "logs.render",
  description = "Render bucket-backed app logs to terminal",
  long_description = "Renders app logs from span-tree bucket streams. Options: --view app|raw|all, --stream spans|startup|bundling|logs, --tail N, --all, --since 5m, --level trace|debug|info|warn|error, --session UUID"
)]
pub async fn logs_render(
  ctx: LogsScriptsContext,
  args: Option<LogsRenderArgs>,
) -> tento_sh::Result<()> {
  let args = args.unwrap_or_default();
  let tail_n = args.tail.unwrap_or(200);
  let since_ts = args
    .since
    .as_ref()
    .map(|s| parse_timestamp(s))
    .transpose()
    .context("Failed to parse timestamp")?;
  let min_level = args
    .level
    .as_deref()
    .map(|s| {
      LjsonLevel::from_str(s)
        .ok_or_else(|| anyhow::anyhow!("Invalid level {s:?}. Use trace|debug|info|warn|error"))
    })
    .transpose()?
    .unwrap_or(LjsonLevel::Info);
  let session_uuid = args
    .session
    .as_ref()
    .map(|s| s.parse::<Uuid>())
    .transpose()
    .context("--session must be a valid UUID")?;
  let zoom = args
    .zoom
    .as_deref()
    .map(|s| {
      LogZoom::from_label(s)
        .ok_or_else(|| anyhow::anyhow!("Invalid zoom {s:?}. Use collapsed|messages|fields"))
    })
    .transpose()?
    .unwrap_or(LogZoom::Messages);
  let viz = ColumnVisibility::from_cli(args.columns.as_deref(), args.hide.as_deref());
  let streams: Vec<String> = match args.stream {
    Some(stream) => vec![stream],
    None => LogsView::from_arg(args.view.as_deref())?
      .streams()
      .iter()
      .map(|s| s.to_string())
      .collect(),
  };

  let rows = read_stream_rows(&ctx, &streams, tail_n, since_ts)?;
  let mut entries = rows_to_entries(rows, zoom);
  entries.retain(|e| entry_level_passes(&e.root_span.level, &min_level));
  if let Some(session_uuid) = session_uuid {
    entries.retain(|e| entry_matches_tracing_session(e, &session_uuid));
    entries.retain(|e| !is_session_infra_route(e));
  }
  if since_ts.is_none() && entries.len() > tail_n {
    entries.drain(..entries.len() - tail_n);
  }

  if entries.is_empty() {
    println!(
      "No bucket log rows found for {}/{}",
      ctx.host, ctx.node_path
    );
    return Ok(());
  }

  if args.all {
    let mut stdout = std::io::stdout();
    render_entries(&entries, session_uuid.is_some(), &viz, &mut stdout)?;
    return Ok(());
  }

  let tmp_path = std::env::temp_dir().join(format!("bucket-logs-{}.txt", Uuid::new_v4()));
  {
    let f = std::fs::File::create(&tmp_path).context("Failed to create temp file")?;
    let mut writer = std::io::BufWriter::new(f);
    render_entries(&entries, session_uuid.is_some(), &viz, &mut writer)?;
  }

  let last_ts = entries.last().map(|e| e.ts);
  let poll_ctx = ctx.clone();
  let poll_streams = streams.clone();
  let poll_path = tmp_path.clone();
  let poll_viz = viz.clone();
  let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
  let poll_thread = std::thread::spawn(move || {
    let mut last_ts = last_ts;
    loop {
      if done_rx.try_recv().is_ok() {
        break;
      }
      std::thread::sleep(StdDuration::from_millis(500));
      let Some(since) = last_ts else {
        continue;
      };
      let Ok(rows) = read_stream_rows(&poll_ctx, &poll_streams, tail_n, Some(since)) else {
        continue;
      };
      let mut entries = rows_to_entries(rows, zoom);
      entries.retain(|e| e.ts > since);
      entries.retain(|e| entry_level_passes(&e.root_span.level, &min_level));
      if let Some(session_uuid) = session_uuid {
        entries.retain(|e| entry_matches_tracing_session(e, &session_uuid));
        entries.retain(|e| !is_session_infra_route(e));
      }
      if entries.is_empty() {
        continue;
      }
      last_ts = entries.last().map(|e| e.ts);
      if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&poll_path) {
        let _ = render_entries(&entries, session_uuid.is_some(), &poll_viz, &mut f);
      }
    }
  });

  let mut child = std::process::Command::new("less")
    .args(["-R", "+F"])
    .arg(&tmp_path)
    .spawn()
    .context("Failed to spawn less")?;
  let _ = child.wait();
  let _ = done_tx.send(());
  let _ = poll_thread.join();
  let _ = std::fs::remove_file(&tmp_path);
  Ok(())
}

/// Arguments for the logs.rotate command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct LogsRotateArgs {
  /// Show what would be done without actually doing it
  #[serde(default, rename = "dry-run", alias = "dry_run")]
  dry_run: bool,
}

/// Truncate crash-path text logs. Bucket retention is handled by the bucket janitor.
#[command(
  name = "logs.rotate",
  description = "Rotate crash-path text logs",
  long_description = "Truncates crash-path text logs. Bucket ljson/parquet retention is handled by the bucket janitor. Options: --dry-run"
)]
pub async fn logs_rotate(
  ctx: LogsScriptsContext,
  args: Option<LogsRotateArgs>,
) -> tento_sh::Result<()> {
  let args = args.unwrap_or_default();
  let Some(logs_dir) = ctx.logs_dir.as_ref() else {
    println!("No text log directory configured; bucket retention is handled by the janitor");
    return Ok(());
  };

  let mut total_freed: u64 = 0;
  let mut rows: Vec<(String, String, String)> = Vec::new();
  for log_name in &[
    "server-app.log",
    "server-app.err.log",
    "restart.log",
    "server-app.restart.log",
    // COMPATIBILITY SHIM: mono's loaf.package is what actually writes these
    // files, and it still writes the `loaf.*` names
    // (lona/loaf.package/src/context.rs, src/cmd/server.rs). Dropping them
    // from this list does not error — `logs_rotate` skips a name that does
    // not exist — it just silently stops rotating, and a deployed host's log
    // grows until the disk does. Delete these three once loaf.package writes
    // the `server-app.*` names.
    "loaf.log",
    "loaf.err.log",
    "loaf.restart.log",
  ] {
    let path = logs_dir.join(log_name);
    if !path.exists() {
      rows.push((
        log_name.to_string(),
        "-".to_string(),
        "not found".to_string(),
      ));
      continue;
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if args.dry_run {
      rows.push((
        log_name.to_string(),
        format_mb(size),
        "would truncate (dry-run)".to_string(),
      ));
    } else {
      std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .with_context(|| format!("Failed to truncate {}", path.display()))?;
      total_freed += size;
      rows.push((
        log_name.to_string(),
        format_mb(size),
        "truncated".to_string(),
      ));
    }
  }

  println!("{:<24} {:>10}  Status", "File", "Size");
  println!("{}", "-".repeat(60));
  for (name, size, status) in rows {
    println!("{:<24} {:>10}  {}", name, size, status);
  }
  println!("{}", "-".repeat(60));
  println!("Total freed: {}", format_mb(total_freed));
  println!("Bucket retention: handled by tento-buckets janitor");
  Ok(())
}

/// Arguments for the logs.bundler command.
#[derive(CommandArg, Deserialize, Clone, Debug, Default)]
pub struct LogsBundlerArgs {
  /// Timestamp filter (RFC3339 or relative like '5m', '1h')
  since: Option<String>,
  /// Minimum log level: info|warn|error (default: info)
  level: Option<String>,
  /// Show last N lines (default: 200)
  tail: Option<usize>,
  /// Dump all entries to stdout instead of opening less
  #[serde(default)]
  all: bool,
}

/// Render esbuild subprocess logs from the `bundling` bucket stream.
#[command(
  name = "logs.bundler",
  description = "Render bundler subprocess logs",
  long_description = "Renders bundler stderr logs from the server-app/bundling bucket stream. Options: --tail N, --all, --since 5m, --level info|warn|error"
)]
pub async fn logs_bundler(
  ctx: LogsScriptsContext,
  args: Option<LogsBundlerArgs>,
) -> tento_sh::Result<()> {
  let args = args.unwrap_or_default();
  let tail_n = args.tail.unwrap_or(200);
  let since_ts = args
    .since
    .as_ref()
    .map(|s| parse_timestamp(s))
    .transpose()
    .context("Failed to parse timestamp")?;
  let min_level = args.level.as_deref().unwrap_or("info");
  let mut rows = read_stream_rows(&ctx, &["bundling".to_string()], tail_n, since_ts)?;
  rows.retain(|(_, r)| level_passes(&r.level, min_level));
  rows.sort_by(|(_, a), (_, b)| {
    a.start_ts
      .cmp(&b.start_ts)
      .then_with(|| a.span_id.cmp(&b.span_id))
  });
  if since_ts.is_none() && rows.len() > tail_n {
    rows.drain(..rows.len() - tail_n);
  }
  if rows.is_empty() {
    println!(
      "No bundler bucket rows found for {}/{}",
      ctx.host, ctx.node_path
    );
    return Ok(());
  }

  let mut output = String::new();
  for (_, row) in rows {
    let ts = row
      .start_ts
      .with_timezone(&Local)
      .format("%Y-%m-%d %H:%M:%S%.3f");
    let attrs: serde_json::Value = serde_json::from_str(&row.attributes).unwrap_or_default();
    let subprocess_id = attrs
      .get("subprocess_id")
      .and_then(|v| v.as_str())
      .unwrap_or("-");
    let spawn_id = attrs
      .get("spawn_id")
      .map(|v| v.to_string())
      .unwrap_or("-".into());
    let pid = attrs
      .get("pid")
      .map(|v| v.to_string())
      .unwrap_or("-".into());
    output.push_str(&format!(
      "[{}] [{:<5}] [{} spawn={} pid={}] {}\n",
      ts,
      row.level.to_uppercase(),
      subprocess_id,
      spawn_id,
      pid,
      row.name
    ));
  }

  if args.all {
    print!("{output}");
    std::io::stdout().flush().ok();
  } else {
    let tmp_path = std::env::temp_dir().join(format!("bundler-logs-{}.txt", Uuid::new_v4()));
    std::fs::write(&tmp_path, &output).context("Failed to write temp file")?;
    let mut child = std::process::Command::new("less")
      .args(["-R", "+G"])
      .arg(&tmp_path)
      .spawn()
      .context("Failed to spawn less")?;
    let _ = child.wait();
    let _ = std::fs::remove_file(&tmp_path);
  }
  Ok(())
}

fn stream_dir(ctx: &LogsScriptsContext, stream: &str) -> PathBuf {
  tento_buckets::bucket_dir(&ctx.buckets_root, &ctx.host, &ctx.node_path, stream)
}

fn read_stream_rows(
  ctx: &LogsScriptsContext,
  streams: &[String],
  tail_n: usize,
  since_ts: Option<DateTime<Utc>>,
) -> anyhow::Result<Vec<(String, SpanRow)>> {
  let mut out = Vec::new();
  let now = Utc::now();
  for stream in streams {
    let dir = stream_dir(ctx, stream);
    if !dir.join("meta.json").exists() {
      continue;
    }
    let store: TimeSeriesStore<SpanRow> = TimeSeriesStore::new(&dir);
    let rows = if let Some(since) = since_ts {
      store.range(since, now)
    } else {
      store.tail_n(tail_n)
    };
    out.extend(rows.into_iter().map(|r| (stream.clone(), r)));
  }
  Ok(out)
}

fn rows_to_entries(mut rows: Vec<(String, SpanRow)>, zoom: LogZoom) -> Vec<LjsonEntry> {
  rows.sort_by_cached_key(|(stream, r)| (render_order_key(r), stream.clone()));
  let mut entries = Vec::new();
  let mut i = 0;
  while i < rows.len() {
    let mut j = i + 1;
    while j < rows.len() && rows[j].1.trace_id == rows[i].1.trace_id {
      j += 1;
    }
    let group: Vec<SpanRow> = rows[i..j].iter().map(|(_, r)| r.clone()).collect();
    for tree in recompose(group) {
      entries.push(tree_to_entry(&tree, zoom));
    }
    i = j;
  }
  entries.sort_by_key(|e| e.ts);
  entries
}

fn render_entries(
  entries: &[LjsonEntry],
  session: bool,
  viz: &ColumnVisibility,
  writer: &mut impl Write,
) -> anyhow::Result<()> {
  if session {
    render_session_to(entries, writer, viz).ok();
  } else {
    render_unified_to(entries, writer, viz).ok();
  }
  Ok(())
}

fn parse_timestamp(s: &str) -> anyhow::Result<DateTime<Utc>> {
  if let Ok(ts) = DateTime::parse_from_rfc3339(s) {
    return Ok(ts.with_timezone(&Utc));
  }
  let s = s.trim();
  if s.is_empty() {
    anyhow::bail!("Empty timestamp");
  }
  let last_char = s.chars().last().unwrap();
  let num_str = &s[..s.len() - 1];
  let num: i64 = num_str
    .parse()
    .context("Invalid number in relative timestamp")?;
  let duration = match last_char {
    's' => Duration::seconds(num),
    'm' => Duration::minutes(num),
    'h' => Duration::hours(num),
    'd' => Duration::days(num),
    _ => anyhow::bail!("Unknown time unit: {last_char}. Use s/m/h/d"),
  };
  Ok(Utc::now() - duration)
}

fn entry_matches_tracing_session(entry: &LjsonEntry, uuid: &Uuid) -> bool {
  if entry.session_id == *uuid {
    return true;
  }
  if let Some(serde_json::Value::String(attr_val)) =
    entry.root_span.attributes.get("tracing_session.id")
  {
    if let Ok(attr_uuid) = attr_val.parse::<Uuid>() {
      return attr_uuid == *uuid;
    }
  }
  false
}

fn is_session_infra_route(entry: &LjsonEntry) -> bool {
  let attrs = &entry.root_span.attributes;
  let route = attrs
    .get("http.route")
    .or_else(|| attrs.get("http.path"))
    .or_else(|| attrs.get("path"))
    .and_then(|v| v.as_str())
    .unwrap_or("");
  route == "/api/tracing/entries" || route.ends_with("/api/tracing/entries")
}

fn entry_level_passes(level: &LjsonLevel, min: &LjsonLevel) -> bool {
  level >= min
}

fn level_passes(level: &str, min: &str) -> bool {
  let rank = |l: &str| match l {
    "error" => 4,
    "warn" => 3,
    "info" => 2,
    "debug" => 1,
    "trace" => 0,
    _ => 0,
  };
  rank(level) >= rank(min)
}

fn format_mb(bytes: u64) -> String {
  if bytes < 1024 {
    format!("{} B", bytes)
  } else if bytes < 1024 * 1024 {
    format!("{:.1} KB", bytes as f64 / 1024.0)
  } else {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
  }
}
