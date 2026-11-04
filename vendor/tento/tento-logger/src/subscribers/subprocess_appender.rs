//! SubprocessLogAppender — per-day Parquet writer for subprocess stderr lines.
//!
//! Uses a single `bundler-YYYY-MM-DD.parquet` file per calendar day.
//! A `bundler.parquet` symlink in logs_dir is atomically updated to point to
//! today's file.
//!
//! Only the first `new()` call per process sets the global singleton.

use std::{
  path::PathBuf,
  sync::{Arc, Mutex, OnceLock},
};

use arrow::{
  array::{Int64Array, StringArray, TimestampMillisecondArray, UInt32Array},
  datatypes::{DataType, Field, Schema, TimeUnit},
  record_batch::RecordBatch,
};
use chrono::Utc;
use parquet::{arrow::ArrowWriter, basic::Compression, file::properties::WriterProperties};

static GLOBAL: OnceLock<Arc<SubprocessLogAppender>> = OnceLock::new();

#[derive(Clone)]
struct LogRow {
  ts_ms: i64,
  subprocess_id: String,
  spawn_id: u32,
  pid: i64,
  level: String,
  message: String,
}

pub struct SubprocessLogAppender {
  pending_rows: Mutex<Vec<LogRow>>,
  flush_lock: Mutex<()>,
  session_path: PathBuf,
}

fn make_schema() -> Schema {
  Schema::new(vec![
    Field::new(
      "ts",
      DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into())),
      false,
    ),
    Field::new("subprocess_id", DataType::Utf8, false),
    Field::new("spawn_id", DataType::UInt32, false),
    Field::new("pid", DataType::Int64, false),
    Field::new("level", DataType::Utf8, false),
    Field::new("message", DataType::Utf8, false),
  ])
}

/// Crude level sniff for raw subprocess stderr lines. Public so the bucket
/// stream write at the same call site labels rows consistently with the
/// parquet copy.
pub fn detect_level(line: &str) -> &'static str {
  if line.contains("[ERROR]") || line.contains("error:") {
    "error"
  } else if line.contains("[WARNING]") || line.contains("warning:") {
    "warn"
  } else {
    "info"
  }
}

impl SubprocessLogAppender {
  /// Create (or retrieve) the global singleton appender.
  ///
  /// The first call atomically updates the `bundler.parquet` symlink and
  /// spawns a 30s flush task.
  pub fn new(logs_dir: PathBuf) -> Arc<Self> {
    if let Some(existing) = GLOBAL.get() {
      return existing.clone();
    }

    let date_str = Utc::now().format("%Y-%m-%d").to_string();
    let filename = format!("bundler-{}.parquet", date_str);
    let session_path = logs_dir.join(&filename);

    let appender = Arc::new(Self {
      pending_rows: Mutex::new(Vec::new()),
      flush_lock: Mutex::new(()),
      session_path,
    });

    match GLOBAL.set(appender.clone()) {
      Ok(()) => {
        // Won the race — update symlink and start flush task.
        let link_path = logs_dir.join("bundler.parquet");
        let link_tmp = logs_dir.join("bundler.parquet.tmp");
        let _ = std::fs::remove_file(&link_tmp);
        std::os::unix::fs::symlink(&filename, &link_tmp).ok();
        std::fs::rename(&link_tmp, &link_path).ok();

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
      Err(_) => GLOBAL.get().unwrap().clone(),
    }
  }

  /// Returns the global singleton, if one has been created.
  pub fn get_global() -> Option<Arc<Self>> {
    GLOBAL.get().cloned()
  }

  /// Append a stderr line to the in-memory buffer.
  pub fn append(&self, subprocess_id: &str, line: &str, spawn_id: u32, pid: i64) {
    let level = detect_level(line).to_string();
    let row = LogRow {
      ts_ms: Utc::now().timestamp_millis(),
      subprocess_id: subprocess_id.to_string(),
      spawn_id,
      pid,
      level,
      message: line.to_string(),
    };
    let mut rows = self
      .pending_rows
      .lock()
      .expect("subprocess log rows lock poisoned");
    rows.push(row);
  }

  fn requeue_pending(&self, mut pending_rows: Vec<LogRow>) {
    if pending_rows.is_empty() {
      return;
    }

    let mut guard = self
      .pending_rows
      .lock()
      .expect("subprocess log rows lock poisoned");
    pending_rows.append(&mut *guard);
    *guard = pending_rows;
  }

  /// Flush all rows to the per-day parquet file.
  pub fn flush(&self) {
    let _flush_guard = self.flush_lock.lock().expect("flush lock poisoned");

    let pending_rows: Vec<LogRow> = {
      let mut guard = self
        .pending_rows
        .lock()
        .expect("subprocess log rows lock poisoned");
      std::mem::take(&mut *guard)
    };

    if pending_rows.is_empty() {
      return;
    }

    let mut rows = if self.session_path.exists() {
      match load_existing_rows(&self.session_path) {
        Some(rows) => rows,
        None => {
          tracing::warn!(
            "subprocess parquet load existing {}",
            self.session_path.display()
          );
          self.requeue_pending(pending_rows);
          return;
        }
      }
    } else {
      Vec::new()
    };
    rows.extend(pending_rows.iter().cloned());

    let tmp_path = self.session_path.with_file_name(format!(
      "{}.tmp",
      self
        .session_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
    ));

    let schema = Arc::new(make_schema());

    let Ok(file) = std::fs::File::create(&tmp_path) else {
      tracing::warn!("subprocess parquet create {}", tmp_path.display());
      self.requeue_pending(pending_rows);
      return;
    };

    let props = WriterProperties::builder()
      .set_compression(Compression::ZSTD(Default::default()))
      .build();

    let Ok(mut writer) = ArrowWriter::try_new(file, schema.clone(), Some(props)) else {
      tracing::warn!("subprocess parquet writer init failed");
      self.requeue_pending(pending_rows);
      return;
    };

    let ts_arr = TimestampMillisecondArray::from(rows.iter().map(|r| r.ts_ms).collect::<Vec<_>>())
      .with_timezone("UTC");
    let id_arr = StringArray::from(
      rows
        .iter()
        .map(|r| r.subprocess_id.as_str())
        .collect::<Vec<_>>(),
    );
    let spawn_arr = UInt32Array::from(rows.iter().map(|r| r.spawn_id).collect::<Vec<_>>());
    let pid_arr = Int64Array::from(rows.iter().map(|r| r.pid).collect::<Vec<_>>());
    let level_arr = StringArray::from(rows.iter().map(|r| r.level.as_str()).collect::<Vec<_>>());
    let msg_arr = StringArray::from(rows.iter().map(|r| r.message.as_str()).collect::<Vec<_>>());

    let batch = RecordBatch::try_new(
      schema,
      vec![
        Arc::new(ts_arr),
        Arc::new(id_arr),
        Arc::new(spawn_arr),
        Arc::new(pid_arr),
        Arc::new(level_arr),
        Arc::new(msg_arr),
      ],
    );

    let Ok(batch) = batch else {
      tracing::warn!("subprocess parquet batch creation failed");
      self.requeue_pending(pending_rows);
      return;
    };

    if let Err(e) = writer.write(&batch) {
      tracing::warn!("subprocess parquet write: {}", e);
      self.requeue_pending(pending_rows);
      return;
    }

    if let Err(e) = writer.close() {
      tracing::warn!("subprocess parquet close: {}", e);
      self.requeue_pending(pending_rows);
      return;
    }

    if let Err(e) = std::fs::rename(&tmp_path, &self.session_path) {
      tracing::warn!("subprocess parquet rename: {}", e);
      self.requeue_pending(pending_rows);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flush_drains_pending_rows_but_preserves_existing_file_rows() {
    let temp_dir =
      std::env::temp_dir().join(format!("tento-logger-subprocess-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).expect("couldn't create temp dir");

    let appender = SubprocessLogAppender {
      pending_rows: Mutex::new(Vec::new()),
      flush_lock: Mutex::new(()),
      session_path: temp_dir.join("bundler.parquet"),
    };

    appender.append("bundler", "first", 1, 100);
    appender.flush();
    assert_eq!(
      appender
        .pending_rows
        .lock()
        .expect("pending rows lock poisoned")
        .len(),
      0
    );

    appender.append("bundler", "second", 2, 200);
    assert_eq!(
      appender
        .pending_rows
        .lock()
        .expect("pending rows lock poisoned")
        .len(),
      1
    );
    appender.flush();
    assert_eq!(
      appender
        .pending_rows
        .lock()
        .expect("pending rows lock poisoned")
        .len(),
      0
    );

    let rows =
      load_existing_rows(&appender.session_path).expect("couldn't read subprocess parquet");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].message, "first");
    assert_eq!(rows[1].message, "second");

    std::fs::remove_dir_all(&temp_dir).expect("couldn't remove temp dir");
  }
}

/// Load existing rows from a bundler parquet file.
fn load_existing_rows(path: &PathBuf) -> Option<Vec<LogRow>> {
  use arrow::array::AsArray;
  use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

  let file = std::fs::File::open(path).ok()?;
  let builder = ParquetRecordBatchReaderBuilder::try_new(file).ok()?;
  let reader = builder.build().ok()?;

  let mut rows = Vec::new();
  for batch_result in reader {
    let batch = batch_result.ok()?;

    let ts_col = batch
      .column(0)
      .as_primitive::<arrow::datatypes::TimestampMillisecondType>();
    let id_col = batch.column(1).as_string::<i32>();
    let spawn_col = batch
      .column(2)
      .as_primitive::<arrow::datatypes::UInt32Type>();
    let pid_col = batch
      .column(3)
      .as_primitive::<arrow::datatypes::Int64Type>();
    let level_col = batch.column(4).as_string::<i32>();
    let msg_col = batch.column(5).as_string::<i32>();

    for i in 0..batch.num_rows() {
      rows.push(LogRow {
        ts_ms: ts_col.value(i),
        subprocess_id: id_col.value(i).to_string(),
        spawn_id: spawn_col.value(i),
        pid: pid_col.value(i),
        level: level_col.value(i).to_string(),
        message: msg_col.value(i).to_string(),
      });
    }
  }

  Some(rows)
}
