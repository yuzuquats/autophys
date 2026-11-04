//! Crash-safe file primitives shared by bucket metadata and the time-series
//! compaction in `tento-timeseries`.
//!
//! * [`unique_tmp`] — a per-writer temp name beside the target
//!   (`<file>.<pid>.<nanos>.tmp`), so two writers never share (and truncate) one
//!   tmp inode.
//! * [`write_atomic`] — tmp → `sync_all` → `rename` → fsync the parent dir, so
//!   after a power loss the target is either the old content or the complete new
//!   content, never empty or torn.
//! * [`fsync_dir`] — make a create/rename/unlink in a directory durable.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Strictly increasing per-process nanosecond stamp: wall-clock nanos, bumped
/// past the previous value so two threads in one nanosecond still differ.
fn unique_nanos() -> u64 {
  static LAST: AtomicU64 = AtomicU64::new(0);
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64)
    .unwrap_or(0);
  let mut prev = LAST.load(Ordering::Relaxed);
  loop {
    let next = now.max(prev + 1);
    match LAST.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
      Ok(_) => return next,
      Err(p) => prev = p,
    }
  }
}

/// A temp path beside `path`: `<file-name>.<pid>.<nanos>.tmp` (e.g.
/// `daily/2026-05-12.parquet.4711.1760000000000000000.tmp`). Unique per writer
/// within and across processes. Readers ignore it (its extension is `tmp`).
pub fn unique_tmp(path: &Path) -> PathBuf {
  let name = path
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_default();
  path.with_file_name(format!(
    "{name}.{}.{}.tmp",
    std::process::id(),
    unique_nanos()
  ))
}

/// fsync a directory so entries created, renamed or removed in it survive a
/// power loss. Filesystems that cannot fsync a directory (`EINVAL`/`ENOTSUP`)
/// are treated as success; every other error is returned.
pub fn fsync_dir(dir: &Path) -> io::Result<()> {
  let d = std::fs::File::open(dir)?;
  match d.sync_all() {
    Ok(()) => Ok(()),
    Err(e) if matches!(e.kind(), io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported) => Ok(()),
    Err(e) => Err(e),
  }
}

/// Write `bytes` to `path` atomically and durably: unique tmp → write →
/// `sync_all` → `rename` over `path` → fsync the parent dir. The tmp is removed
/// on failure. Readers see either the previous file or the complete new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
  let tmp = unique_tmp(path);
  let res = (|| {
    let mut f = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
      fsync_dir(parent)?;
    }
    Ok(())
  })();
  if res.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  res
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn unique_tmp_names_differ_and_keep_the_target_name() {
    let p = Path::new("/x/daily/2026-05-12.parquet");
    let a = unique_tmp(p);
    let b = unique_tmp(p);
    assert_ne!(a, b);
    let an = a.file_name().unwrap().to_string_lossy().into_owned();
    assert!(an.starts_with(&format!("2026-05-12.parquet.{}.", std::process::id())));
    assert!(an.ends_with(".tmp"));
    assert_eq!(a.parent(), p.parent());
  }

  #[test]
  fn write_atomic_replaces_and_leaves_no_tmp() {
    let dir = std::env::temp_dir().join(format!("tb-durable-{}-{}", std::process::id(), unique_nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("meta.json");
    write_atomic(&p, b"one").unwrap();
    write_atomic(&p, b"two").unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), b"two");
    let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names.len(), 1, "no tmp left behind: {names:?}");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
