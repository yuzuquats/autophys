use std::path::PathBuf;

use tento_env::{FromEnvVar, env_kv};
use tracing::info;

/// Moved to [`tento_bundle_fs`]; this shim keeps mono's callers compiling
/// until they re-target (dependency doctrine rule 5). Removal draft: D1.4c.
#[deprecated(since = "0.1.0", note = "use `tento_bundle_fs` directly")]
pub mod app_bundle {
  pub use tento_bundle_fs::*;
}
pub mod container;
pub mod crypto;
pub mod env;
pub mod fs;
pub mod globals;
pub mod index;
pub mod lazy;
pub mod math;
pub mod range;
pub mod rate_limiter;
pub mod result;
pub mod serde;
pub mod subprocess;
pub mod sync;
pub mod term;
#[cfg(test)]
pub mod test_utils;
pub mod validate;

/// Re-export redactable types from tento_env for backwards compatibility.
pub mod redactable {
  pub use tento_env::{Redactable, Redacted};
}

env_kv!("DISABLE_REPL", bool, default = false);
env_kv!("TENTO_CORE", PathBuf);
// Launcher-side OVERRIDE for the span-bucket node identity. Server
// commands now self-identify via [`enable_app_span_bucket`] (late-bound,
// no env needed); this env remains honored for services that haven't
// migrated and as an operator escape hatch. Value = the `node_path`
// segment (e.g. `"loaf"`). Read once in `install_repl_logger_with`.
env_kv!("TENTO_APP_SPAN_BUCKET_NODE_PATH", String);

pub use env::Home;
pub use phf;

impl TentoCore {
  pub fn get_calculator_path(&self) -> anyhow::Result<PathBuf> {
    let calculator_path = self.0.join("src").join("subprocess").join("calculator.py");

    info!(
      "Calculator path from TENTO_CORE: {}",
      calculator_path.display()
    );

    if !calculator_path.exists() {
      return Err(anyhow::anyhow!(
        "Calculator script not found at: {}",
        calculator_path.display()
      ));
    }

    Ok(calculator_path)
  }

  pub fn get_typescript_calculator_path(&self) -> anyhow::Result<PathBuf> {
    let calculator_path = self.0.join("src").join("subprocess").join("calculator.ts");

    info!(
      "TypeScript calculator path from TENTO_CORE: {}",
      calculator_path.display()
    );

    if !calculator_path.exists() {
      return Err(anyhow::anyhow!(
        "TypeScript calculator script not found at: {}",
        calculator_path.display()
      ));
    }

    Ok(calculator_path)
  }
}

pub fn install_repl_logger(app_name: String, flush_immediate: bool) {
  install_repl_logger_with(app_name, flush_immediate, None, None, false)
}

/// Install the REPL logger with optional Parquet file output.
///
/// When `parquet_log_dir` is Some, writes rolling Parquet log files to that directory.
pub fn install_repl_logger_with_parquet(
  app_name: String,
  flush_immediate: bool,
  parquet_log_dir: Option<PathBuf>,
) {
  install_repl_logger_with(app_name, flush_immediate, parquet_log_dir, None, false)
}

/// Install the REPL logger with both Parquet output and a `trace/v1` LJSON
/// pane file. The pane file is what the `tento-sh` TUI / a tsh trace scene
/// tail to render a live span tree.
///
/// When `tui_mode = true`, the in-process consumer that renders span trees
/// to stdout (and any callback wired via `pretty_line_output`) is suppressed
/// so the alt-screen compositor stays uncorrupted. The trace file is still
/// written; the TUI pane tailing it is the on-screen renderer.
pub fn install_repl_logger_with(
  app_name: String,
  flush_immediate: bool,
  parquet_log_dir: Option<PathBuf>,
  trace_pane_path: Option<PathBuf>,
  tui_mode: bool,
) {
  install_repl_logger_stamped(
    app_name,
    None,
    flush_immediate,
    parquet_log_dir,
    trace_pane_path,
    tui_mode,
  )
}

/// Compile-time identity a host binary stamps into its session banner: the
/// semver (`CARGO_PKG_VERSION`) and the build time (a build.rs stamp). The
/// banner title becomes "<app> <version> session started · …" with
/// `initialize.version` / `initialize.built` child rows.
pub use tento_logger::AppBuildStamp;

/// [`install_repl_logger_with`] plus an optional [`AppBuildStamp`].
pub fn install_repl_logger_stamped(
  app_name: String,
  stamp: Option<AppBuildStamp>,
  flush_immediate: bool,
  parquet_log_dir: Option<PathBuf>,
  trace_pane_path: Option<PathBuf>,
  tui_mode: bool,
) {
  tento_logger::install_repl_logger_stamped(
    app_name,
    stamp,
    flush_immediate,
    parquet_log_dir,
    trace_pane_path,
    tui_mode,
  );

  // The span-bucket producer is LATE-BOUND (the forwarding sink is always
  // registered, inert until bound): server commands self-identify via
  // [`enable_app_span_bucket`] AFTER this install — loaf's `server.run*`,
  // the recorder daemon. `TENTO_APP_SPAN_BUCKET_NODE_PATH` remains honored
  // as a launcher-side override for services that haven't migrated to
  // self-identification; one-shot CLI runs bind nothing and stay text-only.
  if let Some(node_path) = TentoAppSpanBucketNodePath::from_env()
    .ok()
    .map(|p| p.into_value().0)
    .filter(|s| !s.is_empty())
  {
    enable_app_span_bucket(&node_path);
  }
}

/// Bind this process's tracing output to the node's span bucket
/// (`<default_buckets_root>/<host_id>/<node_path>/spans/`). Call from the
/// command that KNOWS it is a long-running node service — loaf's
/// `server.run*` entries, `fleet.health record` — after
/// [`install_repl_logger*`] has run. Idempotent (first bind wins); one-shot
/// CLI invocations never call it and produce no bucket rows. Best-effort:
/// a bucket failure must not take the service down.
pub fn enable_app_span_bucket(node_path: &str) {
  let config = tento_logger::SpanBucketConfig {
    buckets_root: tento_buckets::default_buckets_root(),
    host: tento_buckets::host_id(),
    node_path: node_path.to_string(),
    bucket: "spans".to_string(),
    retention: None,
    sample: tento_logger::SpanSample::All,
  };
  if let Err(e) = tento_logger::enable_span_bucket(config) {
    eprintln!("warning: span bucket disabled: {e:#}");
  }
}

#[macro_export]
macro_rules! block {
  ($name:expr, $block:block) => {{
    {
      use tracing::Instrument;
      async $block.instrument(tracing::info_span!($name)).await
    }
  }};
  ($name:expr, $message:expr, $block:block) => {{
    {
      use tracing::Instrument;
      async $block.instrument(tracing::info_span!($name, message = $message)).await
    }
  }};
}

#[macro_export]
macro_rules! sync_block {
  ($name:expr, $block:block) => {{
    {
      let s = tracing::info_span!($name);
      let _enter = s.enter();
      $block
    }
  }};
  ($name:expr, $message:expr, $block:block) => {{
    {
      let s = tracing::info_span!($name, message = $message);
      let _enter = s.enter();
      $block
    }
  }};
}
