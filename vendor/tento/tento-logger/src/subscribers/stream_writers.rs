//! Process-global registry of named [`StreamEventWriter`]s.
//!
//! A producer deep in the stack (e.g. the subprocess RPC layer in
//! `tento-core`, which routes a subprocess's diagnostics to its stream via
//! `SubprocessRpc::with_log_stream`) can't be handed a writer at construction
//! without threading bucket config through every intermediate constructor —
//! the same reason `SubprocessLogAppender::get_global()` exists, and this
//! registry is used at the exact same call sites. The launcher that knows the
//! node's bucket identity (e.g. `scripts/main.rs` for the server-app/mono binary)
//! builds the writer with explicit config and installs it under the stream
//! name; the producer looks it up by name and appends if present.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tento_logger_spans::StreamEventWriter;

static STREAM_WRITERS: OnceLock<Mutex<HashMap<String, Arc<StreamEventWriter>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<StreamEventWriter>>> {
  STREAM_WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Install a writer under a stream name (e.g. `"bundling"`). Last install
/// wins — re-installation is allowed so tests and respawning launchers don't
/// have to care about prior state.
pub fn install_stream_writer(name: &str, writer: StreamEventWriter) {
  registry()
    .lock()
    .expect("stream writer registry poisoned")
    .insert(name.to_string(), Arc::new(writer));
}

/// Look up the writer for a stream name. `None` when no launcher installed
/// one — producers treat that as "this process has no bucket identity" and
/// skip the bucket write.
pub fn stream_writer(name: &str) -> Option<Arc<StreamEventWriter>> {
  registry()
    .lock()
    .expect("stream writer registry poisoned")
    .get(name)
    .cloned()
}

#[cfg(test)]
mod tests {
  use super::*;
  use tento_logger_spans::StreamBucketSpec;

  #[test]
  fn install_then_lookup_round_trips_and_misses_return_none() {
    assert!(stream_writer("never-installed").is_none());
    let dir = tempfile::tempdir().unwrap();
    install_stream_writer(
      "test-stream",
      StreamEventWriter::new(
        StreamBucketSpec {
          buckets_root: dir.path().to_path_buf(),
          host: "h".into(),
          node_path: "n".into(),
          bucket: "test-stream".into(),
          retention: None,
        },
        "sess".into(),
      ),
    );
    let w = stream_writer("test-stream").expect("installed");
    w.append(chrono::Utc::now(), "line", "info", serde_json::json!({}))
      .unwrap();
    assert!(dir.path().join("h/n/test-stream/meta.json").exists());
  }
}
