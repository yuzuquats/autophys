//! ParquetAppender — per-day Parquet writer for log entries.
//!
//! Uses a single `server-app-YYYY-MM-DD.parquet` file per calendar day, accumulating
//! entries across server restarts. On startup, any existing day file is loaded
//! into the in-memory buffer so the full day's history is always available.
//!
//! A `server-app.parquet` symlink in logs_dir is atomically updated to point to
//! today's file. `logs.render` reads via this symlink.
//!
//! Only the first `new()` call per process sets the global singleton.
//! Subsequent calls return the existing singleton.

use std::{
  path::PathBuf,
  sync::{Arc, Mutex, OnceLock},
};

use chrono::Utc;

use crate::{
  ljson::LjsonEntry,
  parquet::{LjsonParquetReader, LjsonParquetWriter},
};

static GLOBAL_APPENDER: OnceLock<Arc<ParquetAppender>> = OnceLock::new();

pub struct ParquetAppender {
  pending_entries: Mutex<Vec<LjsonEntry>>,
  /// Serializes concurrent flush calls so they don't race on the same tmp path.
  flush_lock: Mutex<()>,
  session_path: PathBuf,
}

impl ParquetAppender {
  /// Create (or retrieve) the global singleton appender.
  ///
  /// The first call atomically updates the `server-app.parquet` symlink and spawns a
  /// 30s flush task.
  ///
  /// Subsequent calls return the existing singleton without side effects.
  pub fn new(logs_dir: PathBuf) -> Arc<Self> {
    if let Some(existing) = GLOBAL_APPENDER.get() {
      return existing.clone();
    }

    let date_str = Utc::now().format("%Y-%m-%d").to_string();
    // COMPATIBILITY SHIM: a host that has already been writing today holds a
    // `loaf-<date>.parquet`. Starting a second file beside it would split the
    // day's history in two, and `flush` rewrites the whole day from the file
    // it owns — so the older half would simply stop being readable. Adopt the
    // legacy file when it is the one that exists.
    // Delete once retention has aged out every `loaf-*.parquet` on the fleet.
    let neutral = format!("server-app-{}.parquet", date_str);
    let legacy = format!("loaf-{}.parquet", date_str);
    let filename = if !logs_dir.join(&neutral).exists() && logs_dir.join(&legacy).exists() {
      legacy
    } else {
      neutral
    };
    let session_path = logs_dir.join(&filename);

    let appender = Arc::new(Self {
      pending_entries: Mutex::new(Vec::new()),
      flush_lock: Mutex::new(()),
      session_path,
    });

    match GLOBAL_APPENDER.set(appender.clone()) {
      Ok(()) => {
        // Won the race — update symlinks and start flush task.
        //
        // COMPATIBILITY SHIM: both link names are refreshed. `logs.render`
        // and mono's loaf.package open `loaf.parquet`; publishing only the
        // new name would leave them pointing at a stale day file with no
        // error anywhere. Delete the `loaf.parquet` entry once every reader
        // opens `server-app.parquet`.
        for link in ["server-app.parquet", "loaf.parquet"] {
          let link_path = logs_dir.join(link);
          let link_tmp = logs_dir.join(format!("{}.tmp", link));
          let _ = std::fs::remove_file(&link_tmp);
          std::os::unix::fs::symlink(&filename, &link_tmp).ok();
          std::fs::rename(&link_tmp, &link_path).ok();
        }

        let clone = appender.clone();
        tokio::spawn(async move {
          loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            let c = clone.clone();
            tokio::task::spawn_blocking(move || c.flush()).await.ok();
          }
        });

        appender
      }
      Err(_) => GLOBAL_APPENDER.get().unwrap().clone(),
    }
  }

  /// Returns the global singleton appender, if one has been created.
  pub fn get_global() -> Option<Arc<Self>> {
    GLOBAL_APPENDER.get().cloned()
  }

  /// Append an entry to the in-memory buffer.
  ///
  /// Buffered entries are persisted by the 30s background flush task.
  pub fn append(&self, entry: &LjsonEntry) {
    let mut entries = self
      .pending_entries
      .lock()
      .expect("parquet entries lock poisoned");
    entries.push(entry.clone());
  }

  fn requeue_pending(&self, mut pending_entries: Vec<LjsonEntry>) {
    if pending_entries.is_empty() {
      return;
    }

    let mut guard = self
      .pending_entries
      .lock()
      .expect("parquet entries lock poisoned");
    pending_entries.append(&mut *guard);
    *guard = pending_entries;
  }

  /// Flush all session entries to the per-day parquet file.
  ///
  /// Writes all previously persisted entries plus the pending in-memory batch to
  /// a `.parquet.tmp` file, then atomically renames it to the day path.
  /// Concurrent calls are serialized via flush_lock.
  pub fn flush(&self) {
    let _flush_guard = self.flush_lock.lock().expect("flush lock poisoned");

    let pending_entries: Vec<LjsonEntry> = {
      let mut guard = self
        .pending_entries
        .lock()
        .expect("parquet entries lock poisoned");
      std::mem::take(&mut *guard)
    };

    if pending_entries.is_empty() {
      return;
    }

    let existing_entries = if self.session_path.exists() {
      match LjsonParquetReader::open(&self.session_path) {
        Ok(reader) => reader.entries(None),
        Err(e) => {
          tracing::warn!(
            "parquet load existing {}: {}",
            self.session_path.display(),
            e
          );
          self.requeue_pending(pending_entries);
          return;
        }
      }
    } else {
      Vec::new()
    };

    let tmp_path = self.session_path.with_file_name(format!(
      "{}.tmp",
      self
        .session_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
    ));

    match LjsonParquetWriter::new(&tmp_path) {
      Ok(mut writer) => {
        for entry in &existing_entries {
          if let Err(e) = writer.write_entry(entry) {
            tracing::warn!("parquet write existing entry: {}", e);
            self.requeue_pending(pending_entries);
            return;
          }
        }

        for entry in &pending_entries {
          if let Err(e) = writer.write_entry(entry) {
            tracing::warn!("parquet write entry: {}", e);
            self.requeue_pending(pending_entries);
            return;
          }
        }
        if let Err(e) = writer.finish() {
          tracing::warn!("parquet finish {}: {}", tmp_path.display(), e);
          self.requeue_pending(pending_entries);
          return;
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.session_path) {
          tracing::warn!("parquet rename: {}", e);
          self.requeue_pending(pending_entries);
        }
      }
      Err(e) => {
        tracing::warn!("parquet create {}: {}", tmp_path.display(), e);
        self.requeue_pending(pending_entries);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  use crate::ljson::{LJSON_VERSION, LjsonEntry, LjsonLevel, LjsonLocation, LjsonSpan};

  fn make_entry(id: u64, message: &str) -> LjsonEntry {
    let mut attributes = HashMap::new();
    attributes.insert(
      "message".to_string(),
      serde_json::Value::String(message.to_string()),
    );

    LjsonEntry {
      v: LJSON_VERSION,
      ts: Utc::now(),
      session_id: uuid::Uuid::new_v4(),
      origin: None,
      root_span: LjsonSpan {
        id,
        name: format!("span-{id}"),
        level: LjsonLevel::Info,
        duration_ms: Some(1),
        location: LjsonLocation {
          file: Some("test.rs".to_string()),
          line: Some(1),
        },
        attributes,
        children: Vec::new(),
      },
    }
  }

  #[test]
  fn flush_drains_pending_entries_but_preserves_existing_file_entries() {
    let temp_dir =
      std::env::temp_dir().join(format!("tento-logger-parquet-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).expect("couldn't create temp dir");

    let appender = ParquetAppender {
      pending_entries: Mutex::new(Vec::new()),
      flush_lock: Mutex::new(()),
      session_path: temp_dir.join("server-app.parquet"),
    };

    appender.append(&make_entry(1, "first"));
    appender.flush();
    assert_eq!(
      appender
        .pending_entries
        .lock()
        .expect("pending entries lock poisoned")
        .len(),
      0
    );

    appender.append(&make_entry(2, "second"));
    assert_eq!(
      appender
        .pending_entries
        .lock()
        .expect("pending entries lock poisoned")
        .len(),
      1
    );
    appender.flush();
    assert_eq!(
      appender
        .pending_entries
        .lock()
        .expect("pending entries lock poisoned")
        .len(),
      0
    );

    let reader = LjsonParquetReader::open(&appender.session_path).expect("couldn't open parquet");
    let entries = reader.entries(None);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].root_span.get_str("message"), Some("first"));
    assert_eq!(entries[1].root_span.get_str("message"), Some("second"));

    std::fs::remove_dir_all(&temp_dir).expect("couldn't remove temp dir");
  }
}
