//! The per-bucket **maintenance lock**: an exclusive `flock` on
//! `<bucket>/.maintenance.lock`, held by whoever rolls up or prunes a bucket —
//! the [`Janitor`](crate::Janitor) sweep, `TimeSeriesStore::rollup*` in
//! `tento-timeseries`, and any ad-hoc rollup (`AdsStore::rollup`, scripts).
//! Appenders normally do not take it; only maintainers serialize on it. A
//! `TimeSeriesStore` append whose day file keeps being replaced by rollups
//! takes it as a fallback, never while holding a day-file lock.
//!
//! The lock is **re-entrant per thread**: the janitor holds it while it calls
//! the injected rollup, and that rollup's own `maintenance_lock_at` on the same
//! directory returns a nested guard instead of deadlocking on a second `flock`
//! (which conflicts even within one process, since each `open` is a separate
//! open file description). Another thread or process blocks (or, with
//! [`try_maintenance_lock_at`], gets `None`) until the outermost guard drops.
//! Guards are therefore `!Send`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

/// File name of the maintenance lock inside a bucket dir.
pub const MAINTENANCE_LOCK_FILE: &str = ".maintenance.lock";

thread_local! {
  /// Canonical bucket dir → (nesting depth, the locked file). The outermost
  /// guard unlocks the file explicitly, then drops it.
  static HELD: RefCell<HashMap<PathBuf, (usize, File)>> = RefCell::new(HashMap::new());
}

/// Proof that this thread holds a bucket's maintenance lock. Released when the
/// outermost guard for that bucket drops.
#[derive(Debug)]
pub struct MaintenanceLock {
  key: PathBuf,
  _not_send: PhantomData<*const ()>,
}

impl MaintenanceLock {
  /// The (canonical) bucket dir this guard locks.
  pub fn dir(&self) -> &Path {
    &self.key
  }
}

impl Drop for MaintenanceLock {
  fn drop(&mut self) {
    let _ = HELD.try_with(|h| {
      let mut h = h.borrow_mut();
      if let Some(entry) = h.get_mut(&self.key) {
        entry.0 -= 1;
        if entry.0 == 0 {
          // Unlock before closing: a child forked meanwhile (any thread's
          // `Command::spawn`) shares this open file description until it
          // execs, so closing our fd alone would leave the lock held.
          if let Some((_, file)) = h.remove(&self.key) {
            let _ = file.unlock();
          }
        }
      }
    });
  }
}

/// Take `dir`'s maintenance lock, blocking until it is free. `dir` must exist.
pub fn maintenance_lock_at(dir: &Path) -> io::Result<MaintenanceLock> {
  acquire(dir, true).map(|g| g.expect("blocking acquire always yields a guard"))
}

/// Take `dir`'s maintenance lock if it is free right now; `Ok(None)` when
/// another thread or process holds it.
pub fn try_maintenance_lock_at(dir: &Path) -> io::Result<Option<MaintenanceLock>> {
  acquire(dir, false)
}

fn acquire(dir: &Path, blocking: bool) -> io::Result<Option<MaintenanceLock>> {
  let key = std::fs::canonicalize(dir)?;
  let guard = || MaintenanceLock {
    key: key.clone(),
    _not_send: PhantomData,
  };
  let nested = HELD.with(|h| {
    if let Some(entry) = h.borrow_mut().get_mut(&key) {
      entry.0 += 1;
      true
    } else {
      false
    }
  });
  if nested {
    return Ok(Some(guard()));
  }
  let file = OpenOptions::new()
    .create(true)
    .truncate(false)
    .read(true)
    .write(true)
    .open(key.join(MAINTENANCE_LOCK_FILE))?;
  if blocking {
    file.lock()?;
  } else {
    match file.try_lock() {
      Ok(()) => {}
      Err(TryLockError::WouldBlock) => return Ok(None),
      Err(TryLockError::Error(e)) => return Err(e),
    }
  }
  HELD.with(|h| h.borrow_mut().insert(key.clone(), (1, file)));
  Ok(Some(guard()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
      "tb-lock-{tag}-{}-{}",
      std::process::id(),
      crate::durable::unique_tmp(Path::new("x")).display()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
  }

  #[test]
  fn exclusive_across_threads_reentrant_within_one() {
    let dir = temp("excl");
    let outer = maintenance_lock_at(&dir).unwrap();
    let inner = try_maintenance_lock_at(&dir).unwrap();
    assert!(inner.is_some(), "same thread re-enters");
    let d2 = dir.clone();
    let other = std::thread::spawn(move || try_maintenance_lock_at(&d2).unwrap().is_some())
      .join()
      .unwrap();
    assert!(!other, "another thread is excluded while held");
    drop(inner);
    let d2 = dir.clone();
    let still = std::thread::spawn(move || try_maintenance_lock_at(&d2).unwrap().is_some())
      .join()
      .unwrap();
    assert!(!still, "dropping the nested guard keeps the outer lock");
    drop(outer);
    let d2 = dir.clone();
    let freed = std::thread::spawn(move || try_maintenance_lock_at(&d2).unwrap().is_some())
      .join()
      .unwrap();
    assert!(freed, "released after the outermost guard drops");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A child spawned by any thread while the lock is held inherits a copy of
  /// its descriptor until it execs (`hostname` in `host_id` is one). That copy
  /// must not keep the lock held after the outermost guard drops.
  #[test]
  fn released_while_a_spawned_child_still_shares_the_descriptor() {
    let dir = temp("inherited");
    let guard = maintenance_lock_at(&dir).unwrap();
    let key = guard.dir().to_path_buf();
    // The copy a fork makes: another reference to the same open file description.
    let child_copy = HELD.with(|h| h.borrow()[&key].1.try_clone().unwrap());
    drop(guard);
    let d2 = dir.clone();
    let freed = std::thread::spawn(move || try_maintenance_lock_at(&d2).unwrap().is_some())
      .join()
      .unwrap();
    assert!(
      freed,
      "released while a child's copy of the descriptor is open"
    );
    drop(child_copy);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
