//! The one write lock for an envelope vault.
//!
//! [`Vault::set`](crate::Vault::set) does not merge: it rewrites the whole
//! signed manifest from the copy the writer opened. Two writers that overlap
//! therefore lose one update. So every writer, in tsh or in a provider binary
//! of its own, takes this exclusive lock BEFORE it opens the vault and holds
//! it until its write lands: each writer then opens the manifest the previous
//! one wrote, and a version guard checked under the lock stays true until the
//! write lands ([`Vault::write_guarded`](crate::Vault::write_guarded)).
//! Readers do not lock; the manifest replace is atomic.
//!
//! The lock is one fixed file, `.vault.lock` in the vault directory, never a
//! caller-chosen name: two names would be two locks, which is no lock at all.
//! The wait is bounded so a stopped or hung writer blocks later ones with an
//! error that names the file rather than forever.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use fs2::FileExt;

/// `<vault dir>/.vault.lock`, 0600.
pub const LOCK_FILE: &str = ".vault.lock";
/// How long a writer waits for another writer to release the lock.
pub const LOCK_WAIT: Duration = Duration::from_secs(10);
/// How often a waiting writer retries.
const LOCK_POLL: Duration = Duration::from_millis(25);

/// Held for the duration of one vault write. Closing the file releases the
/// lock, so dropping the guard (including on unwind) unlocks.
#[must_use = "the vault is unlocked as soon as this guard drops"]
pub struct VaultWriteLock {
  _file: File,
}

/// Create the vault dir if needed (0700) and wait up to [`LOCK_WAIT`] for the
/// exclusive vault write lock, silently. Errors are the raw I/O errors so a
/// caller can tell a read-only store from a broken one; a lock still held when
/// the wait ends is [`io::ErrorKind::TimedOut`].
pub fn acquire(dir: &Path) -> io::Result<VaultWriteLock> {
  acquire_within(dir, LOCK_WAIT, |_| {})
}

/// [`acquire`] with an explicit bound. `on_wait` runs once, with the lock
/// file's path, when the lock is busy and this writer starts waiting: a CLI
/// says so on stderr; a script effect stays silent.
pub fn acquire_within(
  dir: &Path,
  wait: Duration,
  on_wait: impl FnOnce(&Path),
) -> io::Result<VaultWriteLock> {
  let mut builder = std::fs::DirBuilder::new();
  builder.recursive(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o700);
  }
  builder.create(dir)?;
  let mut options = OpenOptions::new();
  options.read(true).write(true).create(true).truncate(false);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let path = dir.join(LOCK_FILE);
  let file = options.open(&path)?;
  let contended = fs2::lock_contended_error().kind();
  let deadline = Instant::now() + wait;
  let mut on_wait = Some(on_wait);
  loop {
    match file.try_lock_exclusive() {
      Ok(()) => return Ok(VaultWriteLock { _file: file }),
      Err(e) if e.kind() != contended => return Err(e),
      Err(_) => {}
    }
    if let Some(notify) = on_wait.take() {
      notify(&path);
    }
    let now = Instant::now();
    if now >= deadline {
      return Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
          "the vault write lock {} is still held by another writer after {} s; retry once it finishes",
          path.display(),
          wait.as_secs_f64()
        ),
      ));
    }
    std::thread::sleep(LOCK_POLL.min(deadline - now));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;

  #[test]
  fn second_writer_waits_for_the_first_and_times_out_if_it_never_leaves() {
    let dir = tempfile::tempdir().unwrap();
    let first = acquire(dir.path()).unwrap();
    let (tx, rx) = mpsc::channel();
    let path = dir.path().to_path_buf();
    let waiter = std::thread::spawn(move || {
      let started = Instant::now();
      let got = acquire_within(&path, Duration::from_millis(400), |p| tx.send(p.to_path_buf()).unwrap());
      (got.map(|_| ()).map_err(|e| e.kind()), started.elapsed())
    });
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().ends_with(LOCK_FILE), "the waiter is told the lock file");
    let (got, elapsed) = waiter.join().unwrap();
    assert_eq!(got, Err(io::ErrorKind::TimedOut));
    assert!(elapsed >= Duration::from_millis(400));
    drop(first);
    let _second = acquire(dir.path()).unwrap();
  }
}
