//! Built-in completion providers. All dependencies (the base directory, the
//! list source) are **injected** at construction — no provider reads process env
//! or `current_dir` at the leaf (repo rule: pass deps down).
//!
//! Slow sources are expected to snapshot behind an internal cache and answer
//! `complete` from it — the seam is synchronous and the input path must never
//! block. [`PathsProvider`] is the worked example of that snapshot pattern: it
//! owns a background worker thread that runs every `read_dir` off the input
//! path and serves `complete` from an in-memory, stale-while-revalidate cache,
//! so a slow or hung directory can only ever mean *stale* candidates, never
//! typing lag (see the type's docs).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::time::{Duration, Instant};

use crate::seam::{Candidate, Provider};

/// Cap on directory entries read per snapshot — a big directory truncates
/// rather than stalling the worker. The pane shows a bounded set anyway.
pub const MAX_PATH_ENTRIES: usize = 200;

/// Bound retained directories and all admitted reads (queued, executing, or
/// awaiting consumption). Saturation degrades to stale/empty candidates; a
/// later query retries admission without blocking the input thread.
const MAX_CACHED_DIRS: usize = 64;
const MAX_PENDING_READS: usize = 8;

/// How long a *first* fill (cache miss) waits for the worker before degrading
/// to an empty answer. A fast local directory resolves well inside this window,
/// so the Tab-open feels synchronous; a slow, network-mounted, or OS-mediated
/// directory degrades to "empty now, populated on the next republish" instead
/// of wedging the keystroke handler. Cache *hits* never wait at all.
pub const FIRST_FILL_GRACE: Duration = Duration::from_millis(25);

/// One directory entry, snapshotted off the input path: the file name and
/// whether it is a directory (the only two facts `complete` needs). `Send`, so
/// it can cross from the worker thread back to the provider.
#[derive(Clone)]
struct DirEntrySnap {
  name: String,
  is_dir: bool,
}

struct CachedDirectory {
  entries: Vec<DirEntrySnap>,
  last_used: Instant,
}

/// Filesystem path completion, rooted at an injected base directory. When the
/// prefix names a parent (contains `/`), that directory is read (relative to
/// the base, or absolute when the prefix is absolute); otherwise the base
/// itself. Directories carry a trailing `/` in `insert` so a further keystroke
/// descends. The engine matches each `insert` against the full prefix.
///
/// **The read never runs on the input path.** `read_dir` has unbounded
/// worst-case latency (network mounts, dying disks, macOS TCC mediation), and
/// `complete` runs inside the composer's keystroke handler, so a blocking read
/// here reads as a frozen terminal. Instead this provider is **stale-while-
/// revalidate**: one background worker thread owns every `read_dir`, and
/// `complete` answers from a per-directory in-memory cache. A cache hit serves
/// the last snapshot immediately and queues a refresh for next time. A
/// newly admitted cache miss waits at most [`FIRST_FILL_GRACE`], then degrades to an
/// empty list. Repeated queries while that read is pending return immediately.
/// The cache retains 64 directories and at most eight distinct reads can be
/// outstanding. A later query retries a read refused under saturation.
pub struct PathsProvider {
  base: PathBuf,
  /// Directories this provider will NEVER `read_dir` (compared by prefix
  /// against the resolved read root). A completion producer must never be the
  /// thing that triggers an OS consent flow — on macOS, enumerating
  /// TCC-mediated dirs (`~/.Trash`, `~/Desktop`, …) can raise a modal prompt
  /// that steals the terminal's keyboard, which reads as a frozen TUI. Which
  /// dirs are mediated is host policy, so the set is injected. A mediated dir
  /// is never requested and never cached — it is refused before the channel.
  never_read: Vec<PathBuf>,
  /// Requests to the worker: directories to `read_dir`. Dropping this (on
  /// provider drop) disconnects the worker's receiver. A hung read remains
  /// detached; it exits after returning and observing the dropped receiver.
  req_tx: SyncSender<PathBuf>,
  /// Finished snapshots from the worker, drained into `cache` on each
  /// `complete` (and while waiting out a first fill).
  res_rx: Receiver<(PathBuf, Vec<DirEntrySnap>)>,
  /// Per-directory snapshot cache — the source `complete` answers from.
  cache: RefCell<HashMap<PathBuf, CachedDirectory>>,
  /// A path remains pending until its result is consumed, so both request
  /// and result backlogs share one bound and repeated queries coalesce.
  pending: RefCell<HashSet<PathBuf>>,
}

impl PathsProvider {
  /// Root path completion at `base` (the caller's decision — the session's
  /// working directory, typically; never read from env here). Spawns the
  /// background read worker eagerly and **detaches** it: the thread is owned
  /// by the channels and needs no join (a hung `read_dir` must never turn drop
  /// into a freeze). Dropping the provider lets it exit once its read returns.
  pub fn new(base: impl Into<PathBuf>) -> Self {
    Self::with_reader(base.into(), read_dir_snapshot)
  }

  fn with_reader(
    base: PathBuf,
    reader: impl FnMut(&Path) -> Vec<DirEntrySnap> + Send + 'static,
  ) -> Self {
    let (req_tx, req_rx) = mpsc::sync_channel::<PathBuf>(MAX_PENDING_READS);
    let (res_tx, res_rx) = mpsc::sync_channel(MAX_PENDING_READS);
    std::thread::spawn(move || run_worker(req_rx, res_tx, reader));
    PathsProvider {
      base,
      never_read: Vec::new(),
      req_tx,
      res_rx,
      cache: RefCell::new(HashMap::new()),
      pending: RefCell::new(HashSet::new()),
    }
  }

  /// Inject the never-enumerate set (see the field doc). Matching is by path
  /// prefix on the resolved read root, so listing a PARENT still shows the
  /// protected dir's name (that needs no mediated read); only descending into
  /// it is refused — the chooser simply shows nothing there.
  pub fn with_never_read(mut self, dirs: impl IntoIterator<Item = PathBuf>) -> Self {
    self.never_read = dirs.into_iter().collect();
    self
  }

  /// Move every finished snapshot the worker has produced into the cache. Cheap
  /// and non-blocking (`try_recv` until empty); called at the top of every
  /// `complete` so a query always sees the latest reads that have landed.
  fn drain_results(&self) {
    while let Ok((dir, snaps)) = self.res_rx.try_recv() {
      self.cache_snapshot(dir, snaps);
    }
  }

  /// Return true only for a newly admitted request. Never wait for channel
  /// capacity, including when the worker is stuck inside a filesystem call.
  fn request(&self, dir: &Path) -> bool {
    let mut pending = self.pending.borrow_mut();
    if pending.contains(dir) || pending.len() >= MAX_PENDING_READS {
      return false;
    }
    if self.req_tx.try_send(dir.to_path_buf()).is_err() {
      return false;
    }
    pending.insert(dir.to_path_buf());
    true
  }

  fn cache_snapshot(&self, dir: PathBuf, entries: Vec<DirEntrySnap>) {
    self.pending.borrow_mut().remove(&dir);
    let mut cache = self.cache.borrow_mut();
    if let Some(snapshot) = cache.get_mut(&dir) {
      // A background refresh must not promote an unused directory over one
      // the user actually visited more recently.
      snapshot.entries = entries;
      return;
    }
    if cache.len() >= MAX_CACHED_DIRS {
      let oldest = cache
        .iter()
        .min_by_key(|(_, snapshot)| snapshot.last_used)
        .map(|(dir, _)| dir.clone());
      if let Some(oldest) = oldest {
        cache.remove(&oldest);
      }
    }
    cache.insert(
      dir,
      CachedDirectory {
        entries,
        last_used: Instant::now(),
      },
    );
  }
}

impl Provider for PathsProvider {
  fn name(&self) -> &str {
    "paths"
  }

  fn complete(&self, prefix: &str) -> Vec<Candidate> {
    // Pick up any refreshes that finished since the last query.
    self.drain_results();

    // The dir part is everything up to and including the last `/`; the engine
    // matches the whole `insert` against the whole prefix, so we only need the
    // dir part to locate which directory to read.
    let (dir_part, _frag) = match prefix.rfind('/') {
      Some(i) => prefix.split_at(i + 1),
      None => ("", prefix),
    };
    let read_root = if dir_part.starts_with('/') {
      PathBuf::from(dir_part)
    } else {
      self.base.join(dir_part)
    };
    // Refuse mediated dirs outright — before touching the worker at all, since
    // the consent consultation happens inside `read_dir`. Never requested,
    // never cached.
    if self.never_read.iter().any(|d| read_root.starts_with(d)) {
      return Vec::new();
    }

    // Cache hit: serve the (possibly stale) snapshot now and queue a refresh so
    // the NEXT query sees a fresh read. Never wait.
    if let Some(snapshot) = self.cache.borrow_mut().get_mut(&read_root) {
      snapshot.last_used = Instant::now();
      let candidates = build_candidates(dir_part, &snapshot.entries, self.name());
      self.request(&read_root);
      return candidates;
    }

    // Cache miss: queue the read and wait out the first-fill grace. A fast dir
    // fills inside the window and answers synchronously; a slow one degrades to
    // [] and the cache fills behind it. Snapshots for OTHER dirs may arrive
    // first while we wait — cache each and keep waiting for ours.
    if !self.request(&read_root) {
      return Vec::new();
    }
    let deadline = Instant::now() + FIRST_FILL_GRACE;
    loop {
      let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return Vec::new();
      };
      match self.res_rx.recv_timeout(remaining) {
        Ok((dir, snaps)) if dir == read_root => {
          let candidates = build_candidates(dir_part, &snaps, self.name());
          self.cache_snapshot(dir, snaps);
          return candidates;
        }
        Ok((dir, snaps)) => {
          self.cache_snapshot(dir, snaps);
        }
        Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
          return Vec::new();
        }
      }
    }
  }
}

/// Turn a directory snapshot into candidates: prepend the `dir_part` so the
/// `insert` matches against the full prefix, and mark directories with a
/// trailing `/` so a further keystroke descends.
fn build_candidates(dir_part: &str, snaps: &[DirEntrySnap], source: &str) -> Vec<Candidate> {
  snaps
    .iter()
    .map(|snap| {
      let mut insert = format!("{dir_part}{}", snap.name);
      if snap.is_dir {
        insert.push('/');
      }
      Candidate::new(insert, source, 0)
    })
    .collect()
}

/// Read one directory into a capped snapshot. This is the ONLY place `read_dir`
/// runs, and it runs on the worker thread — never on the input path.
fn read_dir_snapshot(dir: &Path) -> Vec<DirEntrySnap> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return Vec::new();
  };
  entries
    .flatten()
    .take(MAX_PATH_ENTRIES)
    .map(|entry| {
      let name = entry.file_name().to_string_lossy().into_owned();
      let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
      DirEntrySnap { name, is_dir }
    })
    .collect()
}

/// The read worker: read each admitted directory once. The provider coalesces
/// requests through result consumption, before they enter the channel. Exits
/// when the request channel disconnects (the provider was dropped) or a result send
/// fails (the provider's receiver is gone) — so it is fully owned by the
/// provider's lifetime and never needs an explicit shutdown signal.
fn run_worker(
  req_rx: Receiver<PathBuf>,
  res_tx: SyncSender<(PathBuf, Vec<DirEntrySnap>)>,
  mut reader: impl FnMut(&Path) -> Vec<DirEntrySnap>,
) {
  while let Ok(dir) = req_rx.recv() {
    let snaps = reader(&dir);
    if res_tx.send((dir, snaps)).is_err() {
      return;
    }
  }
}

/// One entry from a [`ListProvider`] source: what to insert and its hint.
#[derive(Clone, Debug, PartialEq)]
pub struct ListItem {
  pub insert: String,
  pub detail: String,
}

impl ListItem {
  pub fn new(insert: impl Into<String>, detail: impl Into<String>) -> Self {
    ListItem {
      insert: insert.into(),
      detail: detail.into(),
    }
  }
}

/// The generic injected-source provider: a name plus a closure yielding
/// [`ListItem`]s. This is how F17.2 wires scenes / lanes / slots as completion
/// sources without adding new provider types — each is a `ListProvider` over
/// the relevant enumerator.
pub struct ListProvider {
  name: String,
  source: Rc<dyn Fn() -> Vec<ListItem>>,
}

impl ListProvider {
  pub fn new(name: impl Into<String>, source: Rc<dyn Fn() -> Vec<ListItem>>) -> Self {
    ListProvider {
      name: name.into(),
      source,
    }
  }
}

impl Provider for ListProvider {
  fn name(&self) -> &str {
    self.name.as_str()
  }

  fn complete(&self, _prefix: &str) -> Vec<Candidate> {
    (self.source)()
      .into_iter()
      .map(|item| Candidate::new(item.insert, self.name.as_str(), 0).with_detail(item.detail))
      .collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Poll `complete` until it returns candidates, bounded. The worker fills the
  /// cache asynchronously, so a first-fill that outran `FIRST_FILL_GRACE` (a
  /// loaded CI box, say) still resolves on a later poll — this is the real
  /// signal (candidates present), not a bare timed sleep.
  pub(super) fn complete_until_nonempty(provider: &PathsProvider, prefix: &str) -> Vec<Candidate> {
    for _ in 0..200 {
      let candidates = provider.complete(prefix);
      if !candidates.is_empty() {
        return candidates;
      }
      std::thread::sleep(Duration::from_millis(5));
    }
    provider.complete(prefix)
  }

  fn inserts_of(candidates: Vec<Candidate>) -> Vec<String> {
    candidates.into_iter().map(|c| c.insert).collect()
  }

  #[test]
  fn paths_provider_marks_dirs_and_honors_the_cap() {
    let dir = std::env::temp_dir().join(format!("tento-complete-paths-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("subdir")).unwrap();
    std::fs::write(dir.join("file.txt"), b"x").unwrap();
    // More than the cap, to prove truncation.
    for i in 0..(MAX_PATH_ENTRIES + 40) {
      std::fs::write(dir.join(format!("f{i:04}")), b"x").unwrap();
    }

    let provider = PathsProvider::new(&dir);
    let candidates = complete_until_nonempty(&provider, "");
    assert!(
      candidates.len() <= MAX_PATH_ENTRIES,
      "cap enforced: {}",
      candidates.len()
    );

    // Read the whole (small) dir separately to assert the dir marker without
    // fighting readdir ordering: use a fresh dir with just the two entries.
    let dir2 = std::env::temp_dir().join(format!("tento-complete-paths2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir2);
    std::fs::create_dir_all(dir2.join("subdir")).unwrap();
    std::fs::write(dir2.join("file.txt"), b"x").unwrap();
    let provider2 = PathsProvider::new(&dir2);
    let inserts = inserts_of(complete_until_nonempty(&provider2, ""));
    assert!(
      inserts.contains(&"subdir/".to_string()),
      "dir gets a slash: {inserts:?}"
    );
    assert!(
      inserts.contains(&"file.txt".to_string()),
      "file as-is: {inserts:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
  }

  #[test]
  fn never_read_dirs_are_listed_by_name_but_not_descended() {
    let dir = std::env::temp_dir().join(format!(
      "tento-complete-nevereread-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    std::fs::create_dir_all(dir.join("protected")).unwrap();
    std::fs::write(dir.join("protected/secret.txt"), b"x").unwrap();
    std::fs::write(dir.join("plain.txt"), b"x").unwrap();

    let provider = PathsProvider::new(&dir).with_never_read([dir.join("protected")]);

    // Listing the PARENT still shows the protected dir's name — that read
    // touches only the parent.
    let inserts = inserts_of(complete_until_nonempty(&provider, ""));
    assert!(inserts.contains(&"protected/".to_string()), "{inserts:?}");
    assert!(inserts.contains(&"plain.txt".to_string()), "{inserts:?}");

    // Descending into it is refused outright: no read, no candidates — and
    // instantly, without ever consulting the worker.
    assert!(
      provider.complete("protected/").is_empty(),
      "a never-read dir must not be enumerated"
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn stale_while_revalidate_serves_cache_then_freshens() {
    let dir = std::env::temp_dir().join(format!(
      "tento-complete-swr-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("original.txt"), b"x").unwrap();

    let provider = PathsProvider::new(&dir);

    // First query fills the cache.
    let first = inserts_of(complete_until_nonempty(&provider, ""));
    assert!(first.contains(&"original.txt".to_string()), "{first:?}");

    // A new file lands after the snapshot was taken.
    std::fs::write(dir.join("added.txt"), b"x").unwrap();

    // The very next query is a cache hit: it must return candidates either way
    // — the stale list (no `added.txt`) OR an already-freshened one. Crucially
    // it does not block and does not come back empty.
    let second = inserts_of(provider.complete(""));
    assert!(
      second.contains(&"original.txt".to_string()),
      "cache hit still serves the known entries: {second:?}"
    );

    // Without any explicit sync, the queued refresh lands and a later query
    // picks up the new file. Bounded poll on the real signal.
    let mut freshened = false;
    for _ in 0..200 {
      if inserts_of(provider.complete("")).contains(&"added.txt".to_string()) {
        freshened = true;
        break;
      }
      std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
      freshened,
      "the background refresh must land without an explicit sync"
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn first_fill_waits_briefly_then_degrades() {
    let dir = std::env::temp_dir().join(format!(
      "tento-complete-firstfill-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("mediated")).unwrap();
    std::fs::write(dir.join("mediated/hidden.txt"), b"x").unwrap();
    std::fs::write(dir.join("visible.txt"), b"x").unwrap();

    let provider = PathsProvider::new(&dir).with_never_read([dir.join("mediated")]);

    // The miss path for a never-read dir degrades to [] IMMEDIATELY — it is
    // refused before the worker/grace ever come into play, so there is no wait
    // to observe and nothing to poll.
    let before = Instant::now();
    assert!(
      provider.complete("mediated/").is_empty(),
      "a never-read dir is empty-now, never blocking"
    );
    assert!(
      before.elapsed() < FIRST_FILL_GRACE,
      "the never-read refusal must not spend the first-fill grace"
    );

    // A normal first fill returns candidates: the grace let a fast local read
    // resolve synchronously (or, on a slow box, a bounded poll catches it).
    let visible = inserts_of(complete_until_nonempty(&provider, ""));
    assert!(visible.contains(&"visible.txt".to_string()), "{visible:?}");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn list_provider_maps_items_to_candidates() {
    let items = vec![
      ListItem::new("main", "the default scene"),
      ListItem::new("agent", "the agent scene"),
    ];
    let provider = ListProvider::new("scenes", Rc::new(move || items.clone()));
    let got = provider.complete("");
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].source, "scenes");
    assert_eq!(got[0].insert, "main");
    assert_eq!(got[0].detail, "the default scene");
  }
}

#[cfg(test)]
mod bounds_tests;
