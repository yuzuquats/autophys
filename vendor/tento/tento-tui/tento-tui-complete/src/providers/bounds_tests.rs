use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

fn snapshot() -> Vec<DirEntrySnap> {
  (0..MAX_PATH_ENTRIES)
    .map(|i| DirEntrySnap {
      name: format!("entry-{i:03}-{}", "x".repeat(96)),
      is_dir: i % 2 == 0,
    })
    .collect()
}

#[test]
fn visiting_many_directories_has_a_retention_bound() {
  let provider = PathsProvider::with_reader(PathBuf::from("/synthetic"), |_| snapshot());
  for i in 0..256 {
    let prefix = format!("directory-{i}/");
    let candidates = tests::complete_until_nonempty(&provider, &prefix);
    assert_eq!(candidates.len(), MAX_PATH_ENTRIES);
    assert!(candidates[0].insert.starts_with(&prefix));
  }
  assert!(provider.cache.borrow().len() <= 64);
}

fn manual_provider() -> (
  PathsProvider,
  Receiver<PathBuf>,
  SyncSender<(PathBuf, Vec<DirEntrySnap>)>,
) {
  let (req_tx, req_rx) = mpsc::sync_channel(MAX_PENDING_READS);
  let (res_tx, res_rx) = mpsc::sync_channel(MAX_PENDING_READS);
  (
    PathsProvider {
      base: PathBuf::from("/synthetic"),
      never_read: Vec::new(),
      req_tx,
      res_rx,
      cache: RefCell::new(HashMap::new()),
      pending: RefCell::new(HashSet::new()),
    },
    req_rx,
    res_tx,
  )
}

#[test]
fn admission_coalesces_until_consumed_and_recovers_from_saturation() {
  let (provider, requests, results) = manual_provider();
  for i in 0..MAX_PENDING_READS {
    assert!(provider.request(Path::new(&format!("/synthetic/{i}"))));
  }
  for _ in 0..10_000 {
    assert!(!provider.request(Path::new("/synthetic/0")));
    assert!(!provider.request(Path::new("/synthetic/refused")));
  }
  // Filling the result channel must not free admission: these allocations
  // still belong to the provider even though the worker has finished them.
  for _ in 0..MAX_PENDING_READS {
    let dir = requests.try_recv().unwrap();
    results.try_send((dir, snapshot())).unwrap();
  }
  assert!(requests.try_recv().is_err());
  assert!(!provider.request(Path::new("/synthetic/refused")));
  assert_eq!(provider.pending.borrow().len(), MAX_PENDING_READS);
  provider.drain_results();
  assert!(provider.pending.borrow().is_empty());
  assert_eq!(provider.cache.borrow().len(), MAX_PENDING_READS);
  assert!(provider.request(Path::new("/synthetic/refused")));
  assert_eq!(
    requests.try_recv().unwrap(),
    Path::new("/synthetic/refused")
  );
  drop(requests);
  assert!(!provider.request(Path::new("/synthetic/disconnected")));
  assert!(
    !provider
      .pending
      .borrow()
      .contains(Path::new("/synthetic/disconnected"))
  );
}

#[test]
fn saturated_completion_serves_cached_entries_and_refuses_protected_paths() {
  let (provider, requests, _results) = manual_provider();
  let provider = provider.with_never_read([PathBuf::from("/synthetic/protected")]);
  provider.cache_snapshot(PathBuf::from("/synthetic/cached"), snapshot());
  for i in 0..MAX_PENDING_READS {
    assert!(provider.request(Path::new(&format!("/synthetic/{i}"))));
  }
  assert_eq!(provider.complete("cached/").len(), MAX_PATH_ENTRIES);
  assert!(provider.complete("missing/").is_empty());
  assert!(provider.complete("protected/").is_empty());
  assert_eq!(requests.try_iter().count(), MAX_PENDING_READS);
  assert_eq!(provider.pending.borrow().len(), MAX_PENDING_READS);
}

#[test]
fn eviction_keeps_recently_used_directories_and_refresh_does_not_promote() {
  let (provider, _requests, _results) = manual_provider();
  for i in 0..MAX_CACHED_DIRS {
    provider.cache_snapshot(PathBuf::from(format!("/synthetic/{i}")), snapshot());
  }
  // Explicit ages avoid relying on the host clock's resolution.
  let old = Instant::now() - Duration::from_secs(100);
  for i in 0..MAX_CACHED_DIRS {
    provider
      .cache
      .borrow_mut()
      .get_mut(Path::new(&format!("/synthetic/{i}")))
      .unwrap()
      .last_used = old + Duration::from_millis(i as u64);
  }
  assert_eq!(provider.complete("0/").len(), MAX_PATH_ENTRIES);
  provider.cache_snapshot(PathBuf::from("/synthetic/1"), snapshot());
  provider.cache_snapshot(PathBuf::from("/synthetic/new"), snapshot());
  assert!(
    provider
      .cache
      .borrow()
      .contains_key(Path::new("/synthetic/0"))
  );
  assert!(
    !provider
      .cache
      .borrow()
      .contains_key(Path::new("/synthetic/1"))
  );
  assert_eq!(provider.cache.borrow().len(), MAX_CACHED_DIRS);
}

#[test]
fn dropping_provider_does_not_join_a_blocked_read_or_run_queued_reads() {
  let (started_tx, started_rx) = mpsc::channel();
  let (release_tx, release_rx) = mpsc::channel();
  let (exited_tx, exited_rx) = mpsc::channel();
  struct Exited(std::sync::mpsc::Sender<()>);
  impl Drop for Exited {
    fn drop(&mut self) {
      let _ = self.0.send(());
    }
  }
  let exited = Exited(exited_tx);
  let reads = Arc::new(AtomicUsize::new(0));
  let worker_reads = reads.clone();
  let provider = PathsProvider::with_reader(PathBuf::from("/synthetic"), move |_| {
    let _keep_alive = &exited;
    worker_reads.fetch_add(1, Ordering::Relaxed);
    started_tx.send(()).unwrap();
    release_rx.recv().unwrap();
    snapshot()
  });
  assert!(provider.request(Path::new("/synthetic/blocked")));
  started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
  for i in 1..MAX_PENDING_READS {
    assert!(provider.request(Path::new(&format!("/synthetic/{i}"))));
  }
  // Drop before releasing the read. A regression to joining must fail this
  // assertion, while still releasing the fixture worker on the failure path.
  let (dropped_tx, dropped_rx) = mpsc::channel();
  let dropper = std::thread::spawn(move || {
    drop(provider);
    let _ = dropped_tx.send(());
  });
  let dropped = dropped_rx.recv_timeout(Duration::from_secs(2));
  release_tx.send(()).unwrap();
  exited_rx.recv_timeout(Duration::from_secs(2)).unwrap();
  dropper.join().unwrap();
  assert!(
    dropped.is_ok(),
    "provider drop waited for the filesystem read"
  );
  assert_eq!(reads.load(Ordering::Relaxed), 1);
}

#[test]
#[ignore = "controlled completion benchmark; run explicitly"]
fn completion_bounds_benchmark() {
  let visits = std::env::var("TENTO_COMPLETION_VISITS")
    .ok()
    .and_then(|value| value.parse().ok())
    .unwrap_or(1000);
  let reads = Arc::new(AtomicUsize::new(0));
  let worker_reads = reads.clone();
  let provider = PathsProvider::with_reader(PathBuf::from("/synthetic"), move |_| {
    worker_reads.fetch_add(1, Ordering::Relaxed);
    snapshot()
  });
  let start = Instant::now();
  for i in 0..visits {
    let candidates = tests::complete_until_nonempty(&provider, &format!("directory-{i}/"));
    assert_eq!(candidates.len(), MAX_PATH_ENTRIES);
  }
  let visit_ms = start.elapsed().as_secs_f64() * 1000.0;
  let retained = provider.cache.borrow().len();
  drop(provider);

  // An injected hung read makes repeated miss latency independent of the
  // host filesystem. Always release our worker before checking assertions.
  let (started_tx, started_rx) = mpsc::channel();
  let (release_tx, release_rx) = mpsc::channel();
  let (finished_tx, finished_rx) = mpsc::channel();
  let slow = PathsProvider::with_reader(PathBuf::from("/slow"), move |_| {
    started_tx.send(()).unwrap();
    release_rx.recv().unwrap();
    finished_tx.send(()).unwrap();
    snapshot()
  });
  let first_start = Instant::now();
  assert!(slow.complete("").is_empty());
  let first_ms = first_start.elapsed().as_secs_f64() * 1000.0;
  started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
  let repeat_start = Instant::now();
  for _ in 0..16 {
    assert!(slow.complete("").is_empty());
  }
  let repeat_ms = repeat_start.elapsed().as_secs_f64() * 1000.0;
  drop(slow);
  release_tx.send(()).unwrap();
  finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
  println!(
    "COMPLETION_BENCH {}",
    serde_json::json!({"visits":visits, "reads":reads.load(Ordering::Relaxed),
      "retained_directories":retained, "visit_ms":visit_ms,
      "first_slow_ms":first_ms, "repeated_slow_ms":repeat_ms})
  );
}
