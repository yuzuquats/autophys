use std::path::PathBuf;

/// Compile-time identity a composition root stamps into its session banner.
pub struct AppBuildStamp {
  pub version: String,
  pub built_at: String,
  /// Short release notes supplied by the application, one item per line.
  pub changelog: String,
  /// What this open must tell the operator (a pending update, a mixed
  /// install), one item per line; empty for nothing. Unlike the changelog,
  /// the session banner draws it.
  pub notice: String,
}

/// Install the logger for a command-line or interactive host.
///
/// This is deliberately application-neutral: product-specific sinks such as
/// fleet span buckets are enabled separately by the application that owns
/// them. Keeping the base installation here lets public composition roots use
/// logging without depending on the broad `tento-core` utility crate.
pub fn install_repl_logger_stamped(
  app_name: String,
  stamp: Option<AppBuildStamp>,
  flush_immediate: bool,
  parquet_log_dir: Option<PathBuf>,
  trace_pane_path: Option<PathBuf>,
  tui_mode: bool,
) {
  use render::terminal::{ColumnVisibility, col};
  use std::io::Write;

  let pretty_line_output: Option<Box<dyn Fn(String) + Send + Sync>> = if tui_mode {
    None
  } else {
    Some(Box::new(move |s| {
      if flush_immediate {
        print!("{s}");
        let _ = std::io::stdout().flush();
      } else {
        eprint!("{s}");
        let _ = std::io::stderr().flush();
      }
    }))
  };
  let (app_version, app_built_at, app_changelog, app_notice) = match stamp {
    Some(s) => (Some(s.version), Some(s.built_at), s.changelog, s.notice),
    None => (None, None, String::new(), String::new()),
  };
  set_global_logger(LoggerConfig {
    log_path: None,
    bind_panic: false,
    app_name,
    app_version,
    app_built_at,
    app_changelog,
    app_notice,
    backtrace_to_stderr: false,
    output: LogOutput::Terminal,
    pretty_line_output,
    parquet_log_dir,
    console_min_level: LevelFilter::INFO,
    standalone_event_columns: ColumnVisibility::only([col::LEVEL]),
    trace_pane_path,
    tui_mode,
    ..Default::default()
  });
}

use layers::logging_layer::SlogLayer;
pub use tracing_core::LevelFilter;
use tracing_subscriber::{Registry, filter, prelude::__tracing_subscriber_SubscriberExt};

pub mod consumers;
pub mod fold;
pub mod graft;
mod layers;
pub mod ljson;
#[cfg(feature = "web")]
pub mod middleware;
mod models;
mod panic_hook;
#[cfg(feature = "parquet")]
pub mod parquet;
pub mod render;
#[cfg(feature = "scripts")]
pub mod scripts;
pub mod stream;
pub mod subscribers;
mod trusted_proxy;
pub mod turn_index;

/// Trust gate for forwarded-IP headers (`CF-Connecting-IP`): callers that
/// need the real client IP outside the logging middleware (e.g. persisting
/// it on a signup record) apply the same peer-trust rule the request log
/// uses, instead of duplicating the Cloudflare CIDR list a third time.
pub use trusted_proxy::is_trusted_proxy;

/// Process-wide app build stamp for log attribution. Late-bound once at
/// server start (same pattern as the span-bucket producer): the logger is
/// installed before the bundle VERSION is parsed, so the stamp arrives
/// after install and every request root span from then on carries
/// `app.version = "<version>+<short-git>"`, tying any log line to the
/// deployed bundle.
pub struct AppVersionStamp {
  pub version: String,
  pub git_hash: String,
  combined: String,
}

impl AppVersionStamp {
  pub fn new(version: impl Into<String>, git_hash: impl Into<String>) -> Self {
    let version = version.into();
    let git_hash = git_hash.into();
    // Git hashes are ASCII hex; a plain byte slice is safe.
    let short = if git_hash.len() > 7 {
      &git_hash[..7]
    } else {
      git_hash.as_str()
    };
    let combined = if short.is_empty() {
      version.clone()
    } else {
      format!("{version}+{short}")
    };
    AppVersionStamp {
      version,
      git_hash,
      combined,
    }
  }

  /// The single-field form stamped onto spans: `"<version>+<short-git>"`.
  pub fn combined(&self) -> &str {
    &self.combined
  }
}

static APP_VERSION_STAMP: std::sync::OnceLock<AppVersionStamp> = std::sync::OnceLock::new();

/// Install the process-wide app version stamp. First caller wins; later
/// calls are ignored (the deployed bundle identity cannot change mid-run).
pub fn set_app_version_stamp(stamp: AppVersionStamp) {
  let combined = stamp.combined.clone();
  if APP_VERSION_STAMP.set(stamp).is_ok() {
    tracing::info!("app version stamp: {combined}");
  }
}

/// The stamp installed by [`set_app_version_stamp`], if any. Also the read
/// side for non-logging consumers that want the same version identity on
/// their own records (e.g. funnel/attribution rows).
pub fn app_version_stamp() -> Option<&'static AppVersionStamp> {
  APP_VERSION_STAMP.get()
}

/// Head-based trace sampling for the span bucket — see [`SpanBucketConfig::sample`].
#[cfg(feature = "buckets")]
pub use subscribers::SpanSample;
/// Late-bind the process's span-bucket producer after the logger is
/// installed — server commands self-identify instead of launchers
/// exporting `TENTO_APP_SPAN_BUCKET_NODE_PATH`.
#[cfg(feature = "buckets")]
pub use subscribers::span_bucket::enable_span_bucket;

#[derive(Clone)]
pub struct LogPath {
  pub path: std::path::PathBuf,
}

/// Output mode for the logger.
#[derive(Clone, Default)]
pub enum LogOutput {
  /// DEFAULT: Render to terminal.
  #[default]
  Terminal,
}

/// Producer config for the span→bucket sink. When present on [`LoggerConfig`],
/// this process's tracing spans are mirrored into a local span-tree bucket at
/// `<buckets_root>/<host>/<node_path>/<bucket>/` (the layout the control-pane
/// cache mirrors). Requires the `buckets` feature.
#[cfg(feature = "buckets")]
#[derive(Clone)]
pub struct SpanBucketConfig {
  /// Bucket root; default `tento_buckets`'s convention if you don't override.
  pub buckets_root: PathBuf,
  /// This host's id (the fleet-id) — the top namespace segment, MUST match the
  /// recorder's host id so producer + cache trees align.
  pub host: String,
  /// Nested node-path under the host, e.g. `server-app/web`.
  pub node_path: String,
  /// Bucket name, e.g. `spans`.
  pub bucket: String,
  /// Per-bucket retention; `None` uses the shape default.
  pub retention: Option<tento_buckets::RetentionPolicy>,
  /// Head-based trace sampling — bounds write volume by keeping/dropping whole
  /// traces. [`SpanSample::All`] (the default) keeps everything.
  pub sample: SpanSample,
}

pub struct LoggerConfig {
  pub log_path: Option<PathBuf>,
  pub bind_panic: bool,
  pub backtrace_to_stderr: bool,
  pub app_name: String,
  /// The app's semver, when the host binary stamps one (e.g. tsh bakes
  /// `CARGO_PKG_VERSION`). Rendered in the session-start banner title and as
  /// an `initialize.version` child row.
  pub app_version: Option<String>,
  /// The binary's build time (host-formatted, e.g. from a build.rs stamp).
  /// Rendered as an `initialize.built` child row in the session banner.
  pub app_built_at: Option<String>,
  /// Short release notes retained in the session-start record.
  pub app_changelog: String,
  /// The banner notice (`initialize.notice`): lines the session-start box
  /// draws under the build stamp. Empty for none.
  pub app_notice: String,
  /// Custom terminal output callback (for REPL integration).
  pub pretty_line_output: Option<Box<dyn Fn(String) + Send + Sync>>,
  /// Output mode. Defaults to Terminal.
  pub output: LogOutput,
  /// Optional directory for Parquet log files.
  /// When set, writes rolling Parquet logs to
  /// `{parquet_log_dir}/server-app-*.parquet` (a day already started under the
  /// legacy `loaf-*.parquet` name is continued instead of duplicated).
  pub parquet_log_dir: Option<PathBuf>,
  /// Minimum level for console output. Events below this level are still
  /// written to Parquet but suppressed from terminal rendering.
  /// Defaults to INFO.
  pub console_min_level: LevelFilter,
  /// Column set for standalone (span-less) console events. Defaults to
  /// `all()` — server consoles keep event rows aligned with span entries.
  /// CLI/REPL hosts pass a reduced set: every column except `level` is
  /// structurally blank for a standalone event there.
  pub standalone_event_columns: render::terminal::ColumnVisibility,
  /// Optional path to an LJSON `trace/v1` pane file. When set,
  /// [`TraceStreamWriter`](stream::TraceStreamWriter) appends every span
  /// lifecycle op so a TUI in another process can tail it.
  pub trace_pane_path: Option<PathBuf>,
  /// When `true`, the logger is configured for a host that owns the
  /// terminal in alt-screen + raw mode (e.g. `tento-sh-tui`). The
  /// `RootCloseConsumer` — which `print!`s span trees to stdout for the
  /// CI/non-TTY case — is suppressed so nothing else can corrupt the alt
  /// screen. `TraceStreamWriter` still writes the LJSON file; the on-screen
  /// renderer is the `TracePane` tailing that file.
  pub tui_mode: bool,
  /// When set, mirror this process's tracing spans into a local span-tree bucket
  /// (alongside all other consumers). See [`SpanBucketConfig`]. `buckets` feature.
  #[cfg(feature = "buckets")]
  pub span_bucket: Option<SpanBucketConfig>,
  /// Framework-injected spawn-id (the per-up UUID generated by the
  /// supervisor at spawn time and passed to the child via the
  /// `ACME_SPAWN_ID` env var). When `None`, [`set_global_logger`]
  /// reads the env var itself; explicit `Some` overrides the env. When
  /// the value is non-None, the per-logger `session_id` IS the
  /// spawn-id — every emitted span/event row carries it as `session_id`
  /// in the LJSON stream, so downstream readers (`wait_for_marker`,
  /// the recorder's log-tail) can filter by spawn-id without ambiguity
  /// in shared log paths. See the framework-hardening project doc
  /// Phase 2 for the broader rationale.
  pub spawn_id: Option<uuid::Uuid>,
}

impl Default for LoggerConfig {
  fn default() -> Self {
    LoggerConfig {
      log_path: None,
      bind_panic: true,
      backtrace_to_stderr: false,
      app_name: "app".to_string(),
      app_version: None,
      app_built_at: None,
      app_changelog: String::new(),
      app_notice: String::new(),
      pretty_line_output: None,
      output: LogOutput::default(),
      parquet_log_dir: None,
      console_min_level: LevelFilter::INFO,
      standalone_event_columns: render::terminal::ColumnVisibility::all(),
      trace_pane_path: None,
      tui_mode: false,
      #[cfg(feature = "buckets")]
      span_bucket: None,
      spawn_id: None,
    }
  }
}

/// Read a logger env var under its neutral name, falling back to the
/// pre-neutralization `LONA_*` spelling. A set-but-empty value is treated as
/// absent on both names, so an explicitly-cleared neutral var still falls
/// through to the legacy one rather than silently resolving to nothing.
///
/// COMPATIBILITY SHIM. Deletable — along with the `legacy` argument and both
/// call sites' second string — once every producer injects the neutral name.
/// Today they do not: tento-nodes spawns supervised processes with
/// `LONA_SPAWN_ID` / `LONA_PARQUET_LOG_DIR` (`launchd.rs`, `local.rs`,
/// `systemd.rs`, and their tests), and mono's `loaf.package` exports the same
/// pair. Without this fallback every supervised node would lose its spawn-id
/// session binding and its structured Parquet directory the moment this crate
/// was rebuilt — silently, because both reads are `Option` and `None` is a
/// legitimate value.
fn logger_env_var(neutral: &str, legacy: &str) -> Option<String> {
  fn non_empty(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| {
      let trimmed = value.trim();
      if trimmed.is_empty() {
        None
      } else {
        Some(trimmed.to_string())
      }
    })
  }
  non_empty(neutral).or_else(|| non_empty(legacy))
}

/// Read `ACME_SPAWN_ID` (or legacy `LONA_SPAWN_ID`) from env, parse as a UUID.
/// Returns `None` when neither var is set, both are empty, or the value that
/// won is malformed. Pulled out as a free function so callers (and tests) can
/// inspect the same resolution rule [`set_global_logger`] applies internally.
pub fn spawn_id_from_env() -> Option<uuid::Uuid> {
  logger_env_var("ACME_SPAWN_ID", "LONA_SPAWN_ID").and_then(|s| s.parse().ok())
}

/// Read `ACME_PARQUET_LOG_DIR` (or legacy `LONA_PARQUET_LOG_DIR`) from env,
/// parse as a path. Returns `None` when neither is set or both are empty.
/// The framework's supervisors
/// inject this env var when spawning supervised processes so the
/// logger can write a structured Parquet stream to a per-spawn dir —
/// the same path the recorder's log-tail loop and `wait_for_marker`
/// will eventually read from.
///
/// Distinct from `LoggerConfig::parquet_log_dir` (which is the
/// caller-explicit override): when both are set, the explicit config
/// wins. Pulled out so callers + tests can inspect the resolution
/// rule that [`set_global_logger`] applies.
pub fn parquet_log_dir_from_env() -> Option<PathBuf> {
  logger_env_var("ACME_PARQUET_LOG_DIR", "LONA_PARQUET_LOG_DIR").map(PathBuf::from)
}

pub fn set_global_logger(config: LoggerConfig) {
  use std::sync::Arc;

  use consumers::RootCloseConsumer;
  use stream::{TraceOpSink, TraceStreamWriter};

  let console_min_level = config.console_min_level;

  // Resolve framework-injected fields BEFORE any consumer setup, so
  // both branches (TUI / non-TUI) see the same resolved values.
  //
  // spawn-id: explicit config wins; otherwise read env. Used as the
  // per-logger session_id so every TraceOp row carries it.
  let resolved_spawn_id = config.spawn_id.or_else(spawn_id_from_env);
  // parquet log dir: explicit config wins; otherwise read env. The
  // framework's supervisors inject `ACME_PARQUET_LOG_DIR=<state>/structured/`
  // so every supervised process writes a structured Parquet stream
  // that the recorder + wait_for_marker can read. Binaries with
  // parquet feature off ignore both paths silently.
  let resolved_parquet_dir = config
    .parquet_log_dir
    .clone()
    .or_else(parquet_log_dir_from_env);

  // When the framework injected `ACME_PARQUET_LOG_DIR` but no explicit
  // `trace_pane_path` was set, default the trace-pane LJSON file to
  // `<parquet_dir>/events.ljson`. This co-locates the real-time
  // tailable LJSON stream with the rolling Parquet files in one
  // directory: the supervisor's `wait_for_marker` reads LJSON (cheap
  // per-poll tail; one line == one TraceOp); the recorder's eventual
  // structured bucket reader can read either format. The TUI path
  // (explicit `trace_pane_path`) still wins when set.
  let resolved_trace_pane_path = config.trace_pane_path.clone().or_else(|| {
    resolved_parquet_dir
      .as_ref()
      .map(|d| d.join("events.ljson"))
  });

  // Build the file writer first. In TUI mode the file is the *only* on-screen
  // surface for tracing — the TracePane tails it. In non-TUI mode the
  // RootCloseConsumer also renders entries inline for stdout.
  let mut writer = match resolved_trace_pane_path.as_ref() {
    Some(path) => match TraceStreamWriter::new().with_file(path) {
      Ok(w) => w,
      Err(e) => {
        eprintln!(
          "warning: trace pane file at {} could not be opened: {e}",
          path.display()
        );
        TraceStreamWriter::new()
      }
    },
    None => TraceStreamWriter::new(),
  };

  // In TUI mode we skip RootCloseConsumer entirely — its emit path (callback
  // or `print!` fallback) would corrupt the alt screen, and the consumer's
  // only other job (parquet writes) is configured separately. If a parquet
  // dir is set in TUI mode the user should plumb it through a dedicated sink
  // — we'd rather fail loudly than silently lose parquet writes, so warn.
  if !config.tui_mode {
    let mut consumer = RootCloseConsumer::new()
      .with_console_min_level(console_min_level)
      .with_standalone_columns(config.standalone_event_columns.clone());
    if let Some(callback) = config.pretty_line_output {
      consumer = consumer.with_emit(callback);
    }
    #[cfg(feature = "parquet")]
    if let Some(parquet_dir) = resolved_parquet_dir.as_ref() {
      let appender = subscribers::ParquetAppender::new(parquet_dir.clone());
      consumer = consumer.with_parquet_appender(appender);
    }
    let consumer_sink: Arc<dyn TraceOpSink> = Arc::new(consumer);
    writer = writer.with_sink(consumer_sink);
  } else {
    #[cfg(feature = "parquet")]
    if resolved_parquet_dir.is_some() {
      eprintln!(
        "warning: parquet_log_dir is set with tui_mode=true; parquet output is currently \
         tied to RootCloseConsumer which TUI mode disables."
      );
    }
  }

  // Span→bucket producer, LATE-BOUND: always register the forwarding sink
  // (inert until [`subscribers::span_bucket::enable_span_bucket`] binds a
  // node identity). A multi-role binary's server commands self-identify
  // AFTER the logger installs (server-app's `server.run.fg`, the recorder
  // daemon) — no launcher env required. A `LoggerConfig.span_bucket` (the
  // legacy install-time config, e.g. builtin-http's) binds it immediately.
  // Best-effort — a bucket failure must not take down logging.
  #[cfg(feature = "buckets")]
  {
    let sink: Arc<dyn TraceOpSink> = Arc::new(subscribers::span_bucket::LateSpanBucketSink);
    writer = writer.with_sink(sink);
    if let Some(bc) = config.span_bucket {
      if let Err(e) = subscribers::span_bucket::enable_span_bucket(bc) {
        eprintln!("warning: span bucket disabled: {e:#}");
      }
    }
  }

  let mut slog_builder = SlogLayer::builder().with_subscriber(writer);
  if let Some(id) = resolved_spawn_id {
    slog_builder = slog_builder.with_spawn_id(id);
  }
  let subscriber = Registry::default().with(slog_builder.build()).with(
    filter::Targets::new()
      .with_default(LevelFilter::DEBUG)
      .with_target("actix", LevelFilter::WARN)
      .with_target("tracing_actix_web", LevelFilter::OFF)
      .with_target("ort", LevelFilter::OFF)
      // `tento_*` crates emit per-HTTP-request info! logs
      // (response size, full JSON body dumps, per-day span
      // starts during long backfills). They're useful when
      // debugging those integrations specifically but dominate
      // the terminal during anything that touches the sync
      // pipeline. Silence at WARN by default; set RUST_LOG /
      // a per-binary override when the tento logs are wanted.
      .with_target("tento_garmin", LevelFilter::WARN)
      .with_target("tento_whoop", LevelFilter::WARN)
      .with_target("tento_google", LevelFilter::WARN)
      .with_target("tento_flights", LevelFilter::WARN)
      .with_target("tento_stripe", LevelFilter::WARN)
      .with_target("tento_weather", LevelFilter::WARN)
      .with_target("tento_monarch", LevelFilter::WARN)
      .with_target("tento_linear", LevelFilter::WARN)
      .with_target("tento_oauth", LevelFilter::WARN)
      .with_target("hyper_util", LevelFilter::WARN)
      .with_target("hyper", LevelFilter::WARN)
      // `h2` instruments every protocol frame at DEBUG — `send`/`received`
      // events carrying Ping/Settings/WindowUpdate payloads, one pair every
      // few seconds per live connection, all nested under long-lived
      // `Connection` spans. The console floor (INFO) always hid them, but
      // the span-bucket sink records everything that passes this filter,
      // so they dominated the `spans` buckets. WARN keeps real protocol
      // errors.
      .with_target("h2", LevelFilter::WARN),
  );

  tracing::subscriber::set_global_default(subscriber).expect("couldn't set tracing subscriber");

  if config.bind_panic {
    panic_hook::register(config.backtrace_to_stderr);
  }

  // Emit a richer "session start" event so the TUI's TracePane can render
  // the same context the legacy `write_init_banner` printed (app name +
  // start-time UTC/local). The `message` field becomes the row title; the
  // remaining fields render as child rows via `event_to_tree_node`.
  //
  // TUI-only: in non-TUI mode the `RootCloseConsumer` renders this event to
  // **stdout**, where it pollutes one-shot command output (`tsh pwd` would
  // print the whole banner before the result). The banner exists for the trace
  // pane, so only emit it when a trace file is the surface (tui_mode).
  if config.tui_mode {
    let now_local = chrono::Local::now();
    let now_utc = chrono::Utc::now();
    // Title carries the stamped semver when the host provided one:
    // "tsh 0.2.0 session started · Jun 11, 8:24 PM".
    let name_version = match &config.app_version {
      Some(v) => format!("{} {v}", config.app_name),
      None => config.app_name.clone(),
    };
    let message = format!(
      "{name_version} session started · {}",
      now_local.format("%b %-d, %-I:%M %p")
    );
    // Two invocations rather than empty placeholder fields: an unstamped
    // app's banner must not grow blank version/built child rows.
    if config.app_version.is_some() || config.app_built_at.is_some() {
      tracing::info!(
        kind = "session.start",
        initialize.is = true,
        initialize.app_name = %config.app_name,
        initialize.changelog = %config.app_changelog,
        initialize.notice = %config.app_notice,
        initialize.version = %config.app_version.as_deref().unwrap_or("unknown"),
        initialize.built = %config.app_built_at.as_deref().unwrap_or("unknown"),
        initialize.local = %now_local.format("%Y-%m-%d %H:%M:%S%.3f %z"),
        initialize.utc = %now_utc.format("%Y-%m-%d %H:%M:%S%.3f UTC"),
        message = %message,
      );
    } else {
      tracing::info!(
        kind = "session.start",
        initialize.is = true,
        initialize.app_name = %config.app_name,
        initialize.changelog = %config.app_changelog,
        initialize.notice = %config.app_notice,
        initialize.local = %now_local.format("%Y-%m-%d %H:%M:%S%.3f %z"),
        initialize.utc = %now_utc.format("%Y-%m-%d %H:%M:%S%.3f UTC"),
        message = %message,
      );
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The combined stamp is `<version>+<short-git>` with the hash cut to 7
  /// chars, degrading to the bare version when no hash is available. The
  /// process-global set/get path isn't pinned here — `OnceLock` is
  /// first-caller-wins process state, and asserting it would race any other
  /// test touching the stamp; the live path is verified end-to-end via
  /// `logs.render` showing `app.version` on request rows.
  #[test]
  fn app_version_stamp_combines_version_and_short_hash() {
    let stamp = AppVersionStamp::new("1.0.80", "b718d7a166928ae5aecdbd408a5e84f56b6f8c6e");
    assert_eq!(stamp.combined(), "1.0.80+b718d7a");

    let short = AppVersionStamp::new("1.0.80", "abc");
    assert_eq!(short.combined(), "1.0.80+abc");

    let hashless = AppVersionStamp::new("1.0.80", "");
    assert_eq!(hashless.combined(), "1.0.80");
  }

  /// `spawn_id_from_env` parses `ACME_SPAWN_ID` if set + non-empty +
  /// valid UUID; returns `None` otherwise. Uses a serial mutex around
  /// the env mutation so concurrent test runs don't race on the
  /// process-global var (tests run with --test-threads by default and
  /// `std::env::set_var` is process-global, not per-thread).
  ///
  /// Pin the four cases: present-valid, present-empty, present-invalid,
  /// absent. We don't pin the explicit `LoggerConfig::spawn_id`
  /// override path directly here because that would require
  /// `set_global_logger`, which sets a tracing global that can only be
  /// set once per process — a hard constraint for parallel test
  /// execution. The override path is exercised indirectly by the
  /// integration shape: LocalRuntime's spawn_background tests (in
  /// `tento-nodes`) verify the env var reaches the child, and the
  /// `each_trace_op_carries_session_id_from_slog_event` test in
  /// `stream.rs` verifies the session_id flows through TraceOp once
  /// SlogLayer has it.
  #[test]
  fn spawn_id_from_env_parses_valid_uuid_or_returns_none() {
    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let prior = std::env::var("ACME_SPAWN_ID").ok();
    let prior_legacy = std::env::var("LONA_SPAWN_ID").ok();
    // The neutral-name cases below assert `None`, which is only meaningful
    // with the legacy name out of the way.
    // SAFETY: env mutation is process-global; serialized via ENV_LOCK.
    unsafe {
      std::env::remove_var("LONA_SPAWN_ID");
    }

    // Case 1: present + valid UUID → Some(uuid)
    let want = uuid::Uuid::new_v4();
    // SAFETY: env mutation is process-global; serialized via ENV_LOCK.
    unsafe {
      std::env::set_var("ACME_SPAWN_ID", want.to_string());
    }
    assert_eq!(spawn_id_from_env(), Some(want), "valid uuid round-trips");

    // Case 2: present but empty → None (don't treat empty as fresh-uuid)
    unsafe {
      std::env::set_var("ACME_SPAWN_ID", "");
    }
    assert_eq!(spawn_id_from_env(), None, "empty value reads as None");

    // Case 3: present but malformed → None
    unsafe {
      std::env::set_var("ACME_SPAWN_ID", "not-a-uuid");
    }
    assert_eq!(spawn_id_from_env(), None, "malformed value reads as None");

    // Case 4: absent → None
    unsafe {
      std::env::remove_var("ACME_SPAWN_ID");
    }
    assert_eq!(spawn_id_from_env(), None, "absent var reads as None");

    // Case 5: only the legacy name is set → the fallback resolves it. This
    // is the case every supervised node hits today, since tento-nodes and
    // mono's loaf.package still inject `LONA_SPAWN_ID`.
    let legacy_want = uuid::Uuid::new_v4();
    unsafe {
      std::env::set_var("LONA_SPAWN_ID", legacy_want.to_string());
    }
    assert_eq!(
      spawn_id_from_env(),
      Some(legacy_want),
      "the legacy LONA_SPAWN_ID still binds a spawn id"
    );

    // Case 6: both set → the neutral name wins, so a host that has been
    // migrated is not dragged back to whatever the old var still holds.
    let neutral_want = uuid::Uuid::new_v4();
    unsafe {
      std::env::set_var("ACME_SPAWN_ID", neutral_want.to_string());
    }
    assert_eq!(
      spawn_id_from_env(),
      Some(neutral_want),
      "ACME_SPAWN_ID takes precedence over LONA_SPAWN_ID"
    );

    // Case 7: neutral set but empty → still falls through to the legacy name
    // rather than reading as absent.
    unsafe {
      std::env::set_var("ACME_SPAWN_ID", "");
    }
    assert_eq!(
      spawn_id_from_env(),
      Some(legacy_want),
      "an empty neutral var does not mask the legacy one"
    );

    // Restore prior state so we don't leak across tests in the same
    // process.
    match prior {
      Some(v) => unsafe { std::env::set_var("ACME_SPAWN_ID", v) },
      None => unsafe { std::env::remove_var("ACME_SPAWN_ID") },
    }
    match prior_legacy {
      Some(v) => unsafe { std::env::set_var("LONA_SPAWN_ID", v) },
      None => unsafe { std::env::remove_var("LONA_SPAWN_ID") },
    }
  }

  /// The parquet-dir read has the same two-name rule, and the same reason:
  /// tento-nodes injects `LONA_PARQUET_LOG_DIR=<state>/structured/` today.
  #[test]
  fn parquet_log_dir_falls_back_to_the_legacy_name() {
    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let prior = std::env::var("ACME_PARQUET_LOG_DIR").ok();
    let prior_legacy = std::env::var("LONA_PARQUET_LOG_DIR").ok();

    // SAFETY: env mutation is process-global; serialized via ENV_LOCK.
    unsafe {
      std::env::remove_var("ACME_PARQUET_LOG_DIR");
      std::env::set_var("LONA_PARQUET_LOG_DIR", "/var/state/structured");
    }
    assert_eq!(
      parquet_log_dir_from_env(),
      Some(PathBuf::from("/var/state/structured")),
      "the legacy LONA_PARQUET_LOG_DIR still names the structured dir"
    );

    unsafe {
      std::env::set_var("ACME_PARQUET_LOG_DIR", "/var/state/neutral");
    }
    assert_eq!(
      parquet_log_dir_from_env(),
      Some(PathBuf::from("/var/state/neutral")),
      "ACME_PARQUET_LOG_DIR takes precedence"
    );

    unsafe {
      std::env::remove_var("ACME_PARQUET_LOG_DIR");
      std::env::remove_var("LONA_PARQUET_LOG_DIR");
    }
    assert_eq!(parquet_log_dir_from_env(), None, "neither set reads as None");

    match prior {
      Some(v) => unsafe { std::env::set_var("ACME_PARQUET_LOG_DIR", v) },
      None => unsafe { std::env::remove_var("ACME_PARQUET_LOG_DIR") },
    }
    match prior_legacy {
      Some(v) => unsafe { std::env::set_var("LONA_PARQUET_LOG_DIR", v) },
      None => unsafe { std::env::remove_var("LONA_PARQUET_LOG_DIR") },
    }
  }
}
