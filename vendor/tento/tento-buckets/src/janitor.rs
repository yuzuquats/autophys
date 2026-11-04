//! The host-level **bucket janitor**: rolls up + prunes every bucket under its
//! roots on a timer, decoupled from producer liveness (an exited app's hot ljson
//! still gets rolled up and pruned). Producers only `append`; the janitor owns
//! rollup + retention (and, in a later slice, node-deletion GC).
//!
//! Rollup is **injected** as `Fn(shape_tag, dir) -> Result<()>` so this leaf
//! crate stays free of the row types + `tento-timeseries`: the host agent maps
//! each `shape_tag` to `TimeSeriesStore::<R>::rollup` and passes it in.
//!
//! **Fail closed.** Per bucket, a sweep takes the bucket's maintenance lock,
//! runs the rollup, and prunes only if the rollup succeeded. A rollup error, an
//! unreadable `meta.json` or a lock failure *holds* the bucket (no prune this
//! sweep) and is logged with the bucket identity. `RetentionSpec::Forever`
//! buckets are never pruned; prune itself only deletes covered files (see
//! [`prune`](crate::prune)).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::retention::{PruneStats, prune};
use crate::{Bucket, BucketRegistry};

/// What a [`Janitor::sweep`] did across all buckets.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepStats {
  /// Usable buckets discovered (unreadable ones are in `held_buckets`/`errors`).
  pub buckets: usize,
  /// Buckets whose rollup succeeded.
  pub rolled: usize,
  /// Buckets whose rollup returned an error.
  pub roll_errors: usize,
  /// Buckets not pruned this sweep because of a rollup error, an unreadable
  /// `meta.json`, or a maintenance-lock failure.
  pub held_buckets: usize,
  /// One line per problem: `<bucket dir>: <error>`.
  pub errors: Vec<String>,
  /// Files removed / held for lack of coverage, across all pruned buckets.
  pub pruned: PruneStats,
}

/// Scans bucket roots and maintains them. Point each root at a host's bucket
/// subtree (`<buckets_root>/<host>`), where buckets live at nested node-paths.
#[derive(Default)]
pub struct Janitor {
  roots: Vec<PathBuf>,
}

impl Janitor {
  pub fn new() -> Self {
    Janitor::default()
  }

  pub fn with_root(mut self, root: impl Into<PathBuf>) -> Self {
    self.roots.push(root.into());
    self
  }

  /// Roll up then prune every discovered bucket, fail-closed (see the module
  /// doc). `rollup(shape_tag, dir)` runs under the bucket's maintenance lock
  /// (re-entrant, so a rollup that takes the lock itself does not deadlock).
  /// Prune uses the retention parsed once at discovery: `ShapeDefault` → the
  /// per-shape default, `Forever` → no prune, `Explicit` → the policy.
  pub fn sweep(&self, rollup: impl Fn(&str, &Path) -> anyhow::Result<()>) -> SweepStats {
    let mut stats = SweepStats::default();
    for root in &self.roots {
      let found = BucketRegistry::new(root).discover();
      for (dir, err) in found.errors {
        hold(&mut stats, &dir, &err);
      }
      for bucket in found.buckets {
        stats.buckets += 1;
        self.sweep_one(&bucket, &rollup, &mut stats);
      }
    }
    stats
  }

  fn sweep_one(
    &self,
    bucket: &Bucket,
    rollup: &impl Fn(&str, &Path) -> anyhow::Result<()>,
    stats: &mut SweepStats,
  ) {
    let _lock = match bucket.maintenance_lock() {
      Ok(l) => l,
      Err(e) => {
        hold(stats, &bucket.dir, &format!("maintenance lock: {e}"));
        return;
      }
    };
    if let Err(e) = rollup(&bucket.shape_tag, &bucket.dir) {
      stats.roll_errors += 1;
      hold(
        stats,
        &bucket.dir,
        &format!("rollup {} ({}): {e:#}", bucket.name, bucket.shape_tag),
      );
      return;
    }
    stats.rolled += 1;
    let Some(policy) = bucket.retention.resolve(&bucket.shape_tag) else {
      return; // keep forever
    };
    match prune(&bucket.dir, &policy) {
      Ok(p) => {
        stats.pruned.removed_files += p.removed_files;
        stats.pruned.freed_bytes += p.freed_bytes;
        stats.pruned.held += p.held;
      }
      Err(e) => {
        stats.errors.push(format!("{}: prune: {e:#}", bucket.dir.display()));
      }
    }
  }

  /// Remove bucket dirs whose node-path is no longer a live node. **Opt-in**
  /// (`GcConfig::enabled`) and guarded: a bucket is kept if its node-path is
  /// at-or-under any live node, OR its newest fragment was written within
  /// `grace` (protects a node briefly missing from one snapshot, and brand-new
  /// buckets). Call only after a SUCCESSFUL snapshot — an empty/failed `live`
  /// would look like "every node is dead". Only scanned roots are touched, so
  /// explicitly-registered legacy buckets are never GC'd.
  pub fn gc(&self, live: &HashSet<String>, config: &GcConfig) -> GcStats {
    let mut stats = GcStats::default();
    if !config.enabled {
      return stats;
    }
    let now = SystemTime::now();
    for root in &self.roots {
      for bucket in BucketRegistry::new(root).list() {
        if is_live(&bucket.node, live) {
          continue;
        }
        if within_grace(&bucket, now, config.grace) {
          continue; // recently active / brand-new — protect it
        }
        // Never remove a bucket someone is maintaining right now.
        let Ok(Some(lock)) = bucket.try_maintenance_lock() else {
          continue;
        };
        let removed = std::fs::remove_dir_all(&bucket.dir).is_ok();
        drop(lock);
        if removed {
          stats.removed_buckets += 1;
          prune_empty_parents(&bucket.dir, root);
        }
      }
    }
    stats
  }
}

/// Record a held bucket: counted, kept in `errors`, and logged to stderr with
/// the bucket identity (this leaf crate has no logging dependency).
fn hold(stats: &mut SweepStats, dir: &Path, err: &str) {
  stats.held_buckets += 1;
  let line = format!("{}: {err}", dir.display());
  eprintln!("tento-buckets janitor: holding {line} (no prune this sweep)");
  stats.errors.push(line);
}

/// A bucket's node-path is "live" if it equals, or is a descendant of, some live
/// node (so buckets under a live node survive even if only the ancestor is listed).
fn is_live(node: &str, live: &HashSet<String>) -> bool {
  live
    .iter()
    .any(|l| node == l || node.starts_with(&format!("{l}/")))
}

/// True if the bucket's newest fragment (or `meta.json`) was modified within
/// `grace` of `now`.
fn within_grace(bucket: &Bucket, now: SystemTime, grace: Duration) -> bool {
  let mut newest: Option<SystemTime> = std::fs::metadata(bucket.dir.join("meta.json"))
    .and_then(|m| m.modified())
    .ok();
  for f in bucket.fragments() {
    if let Ok(m) = std::fs::metadata(bucket.dir.join(&f.path)).and_then(|m| m.modified()) {
      newest = Some(newest.map_or(m, |n| n.max(m)));
    }
  }
  match newest {
    Some(t) => now.duration_since(t).map(|age| age < grace).unwrap_or(true), // future mtime ⇒ protect
    None => false,
  }
}

/// After removing a bucket, delete now-empty parent dirs up to (not including) `root`.
fn prune_empty_parents(removed: &Path, root: &Path) {
  let mut cur = removed.parent();
  while let Some(dir) = cur {
    if dir == root || !dir.starts_with(root) {
      break;
    }
    // Stop at the first non-empty parent.
    if std::fs::read_dir(dir)
      .map(|mut d| d.next().is_some())
      .unwrap_or(true)
    {
      break;
    }
    if std::fs::remove_dir(dir).is_err() {
      break;
    }
    cur = dir.parent();
  }
}

/// Node-deletion GC knobs. Off by default; a non-zero `grace` protects buckets
/// whose node is transiently missing or freshly created.
pub struct GcConfig {
  pub enabled: bool,
  pub grace: Duration,
}

impl Default for GcConfig {
  fn default() -> Self {
    GcConfig {
      enabled: false,
      grace: Duration::from_secs(7 * 24 * 3600),
    }
  }
}

/// What a [`Janitor::gc`] removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcStats {
  pub removed_buckets: usize,
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{Bucket, RetentionPolicy};
  use std::sync::Mutex;

  fn temp(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("tb-jan-{tag}-{}-{n}", std::process::id()))
  }
  fn touch(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, b"x").unwrap();
  }

  #[test]
  fn sweep_rolls_each_bucket_and_prunes_per_policy() {
    let root = temp("sweep");
    let host = root.join("rwc-09");
    // Two buckets with tight retention; seed an ancient daily in each.
    let tight = Some(RetentionPolicy {
      keep_hot_days: Some(0),
      keep_daily_days: Some(1),
      keep_weekly_weeks: Some(1),
    });
    let a = Bucket::ensure_nested(
      &root,
      "rwc-09",
      "loaf/web",
      "spans",
      "span-tree/v1",
      tight.clone(),
    )
    .unwrap();
    let b =
      Bucket::ensure_nested(&root, "rwc-09", "host-health", "metrics", "cell/v1", tight).unwrap();
    // Each ancient daily is covered by its (newer) weekly, so both tiers prune.
    for d in [&a.dir, &b.dir] {
      touch(&d.join("daily/2020-01-01.parquet"));
      touch(&d.join("weekly/2020-W01.parquet"));
    }

    // Record which (shape, dir) pairs the injected rollup saw.
    let seen = Mutex::new(Vec::<String>::new());
    let stats = Janitor::new().with_root(&host).sweep(|shape, dir| {
      seen
        .lock()
        .unwrap()
        .push(format!("{shape}@{}", dir.display()));
      Ok(())
    });

    assert_eq!(stats.buckets, 2);
    assert_eq!(stats.rolled, 2);
    assert_eq!(stats.roll_errors, 0);
    assert_eq!(
      seen.lock().unwrap().len(),
      2,
      "rollup invoked once per bucket"
    );
    assert_eq!(
      stats.pruned.removed_files, 4,
      "both ancient dailies + weeklies pruned"
    );
    assert!(!a.dir.join("daily/2020-01-01.parquet").exists());
    assert!(!b.dir.join("daily/2020-01-01.parquet").exists());
    assert_eq!(stats.held_buckets, 0);
    assert!(stats.errors.is_empty());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn unknown_shape_keeps_all_data() {
    let root = temp("unknown");
    let host = root.join("h");
    // No explicit retention → unknown shape falls back to keep-all.
    let bucket = Bucket::ensure_nested(&root, "h", "n", "mystery", "mystery/v9", None).unwrap();
    touch(&bucket.dir.join("daily/2020-01-01.parquet"));

    let stats = Janitor::new().with_root(&host).sweep(|_, _| Ok(()));
    assert_eq!(stats.buckets, 1);
    assert_eq!(stats.pruned.removed_files, 0, "unknown shape never prunes");
    assert!(bucket.dir.join("daily/2020-01-01.parquet").exists());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn rollup_error_is_counted_not_fatal() {
    let root = temp("rollerr");
    let host = root.join("h");
    Bucket::ensure_nested(&root, "h", "n", "spans", "span-tree/v1", None).unwrap();
    let stats = Janitor::new()
      .with_root(&host)
      .sweep(|_, _| anyhow::bail!("boom"));
    assert_eq!(stats.roll_errors, 1);
    assert_eq!(stats.rolled, 0);
    assert_eq!(stats.held_buckets, 1);
    assert_eq!(stats.errors.len(), 1);
    assert!(stats.errors[0].contains("boom"), "{:?}", stats.errors);
    let _ = std::fs::remove_dir_all(&root);
  }

  /// The prod failure: a cell/v1 bucket with legacy `null` retention whose
  /// rollup fails must keep every hot file, however old.
  #[test]
  fn prune_is_held_after_a_failed_rollup() {
    let root = temp("heldroll");
    let host = root.join("h");
    let b = Bucket::ensure_nested(&root, "h", "lona/ads", "leads", "cell/v1", None).unwrap();
    touch(&b.dir.join("samples/2020-01-01.ljson"));
    touch(&b.dir.join("daily/2020-01-01.parquet")); // even "covered" files are kept
    touch(&b.dir.join("weekly/2020-W01.parquet"));
    let stats = Janitor::new()
      .with_root(&host)
      .sweep(|_, _| anyhow::bail!("torn line"));
    assert_eq!(stats.held_buckets, 1);
    assert_eq!(stats.pruned.removed_files, 0);
    assert!(b.dir.join("samples/2020-01-01.ljson").exists());
    assert!(b.dir.join("daily/2020-01-01.parquet").exists());

    // Same bucket, successful rollup: the legacy null still means the finite
    // cell/v1 shape default, so covered ancient files do prune.
    let stats = Janitor::new().with_root(&host).sweep(|_, _| Ok(()));
    assert_eq!(stats.held_buckets, 0);
    assert_eq!(stats.pruned.removed_files, 3, "shape default applied to null retention");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn keep_forever_survives_a_sweep() {
    let root = temp("forever");
    let host = root.join("h");
    let b = Bucket::ensure_nested_with(
      &root,
      "h",
      "lona/ads",
      "capi-sent",
      "cell/v1",
      crate::RetentionSpec::Forever,
      crate::Visibility::Private,
    )
    .unwrap();
    touch(&b.dir.join("samples/2020-01-01.ljson"));
    touch(&b.dir.join("daily/2020-01-01.parquet"));
    touch(&b.dir.join("weekly/2020-W01.parquet"));
    let stats = Janitor::new().with_root(&host).sweep(|_, _| Ok(()));
    assert_eq!(stats.rolled, 1);
    assert_eq!(stats.pruned.removed_files, 0, "forever is never pruned");
    for f in ["samples/2020-01-01.ljson", "daily/2020-01-01.parquet", "weekly/2020-W01.parquet"] {
      assert!(b.dir.join(f).exists(), "{f}");
    }
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn unreadable_meta_is_held_not_defaulted() {
    let root = temp("badmeta");
    let host = root.join("h");
    let b = Bucket::ensure_nested(&root, "h", "n", "spans", "span-tree/v1", None).unwrap();
    touch(&b.dir.join("daily/2020-01-01.parquet"));
    touch(&b.dir.join("weekly/2020-W01.parquet"));
    std::fs::write(b.dir.join("meta.json"), b"{\"shape_tag\":").unwrap();
    let rolled = Mutex::new(0);
    let stats = Janitor::new().with_root(&host).sweep(|_, _| {
      *rolled.lock().unwrap() += 1;
      Ok(())
    });
    assert_eq!(*rolled.lock().unwrap(), 0);
    assert_eq!(stats.held_buckets, 1);
    assert_eq!(stats.errors.len(), 1);
    assert!(b.dir.join("daily/2020-01-01.parquet").exists());
    assert!(b.dir.join("weekly/2020-W01.parquet").exists());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn sweep_holds_the_maintenance_lock_during_rollup() {
    let root = temp("lock");
    let host = root.join("h");
    let b = Bucket::ensure_nested(&root, "h", "n", "spans", "span-tree/v1", None).unwrap();
    let stats = Janitor::new().with_root(&host).sweep(|_, dir| {
      // Re-entrant on this thread (a rollup that locks itself must not deadlock) …
      let nested = crate::maintenance_lock_at(dir)?;
      drop(nested);
      // … and exclusive against any other thread.
      let d = dir.to_path_buf();
      let other = std::thread::spawn(move || crate::try_maintenance_lock_at(&d).unwrap().is_some())
        .join()
        .unwrap();
      anyhow::ensure!(!other, "another thread took the lock mid-sweep");
      Ok(())
    });
    assert_eq!(stats.rolled, 1, "{:?}", stats.errors);
    assert!(b.try_maintenance_lock().unwrap().is_some(), "released after the sweep");
    let _ = std::fs::remove_dir_all(&root);
  }

  fn live(names: &[&str]) -> std::collections::HashSet<String> {
    names.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn gc_disabled_removes_nothing() {
    let root = temp("gcoff");
    let host = root.join("h");
    Bucket::ensure_nested(&root, "h", "dead/node", "spans", "span-tree/v1", None).unwrap();
    let stats = Janitor::new()
      .with_root(&host)
      .gc(&live(&[]), &GcConfig::default());
    assert_eq!(stats.removed_buckets, 0, "default GcConfig is disabled");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn gc_removes_dead_node_keeps_live_descendant_and_cleans_parents() {
    let root = temp("gcdead");
    let host = root.join("h");
    let keep =
      Bucket::ensure_nested(&root, "h", "loaf/web", "spans", "span-tree/v1", None).unwrap();
    let dead =
      Bucket::ensure_nested(&root, "h", "dead/node", "spans", "span-tree/v1", None).unwrap();

    // grace=0 ⇒ no mtime protection; "loaf" live ⇒ loaf/web (descendant) kept.
    let cfg = GcConfig {
      enabled: true,
      grace: Duration::ZERO,
    };
    let stats = Janitor::new().with_root(&host).gc(&live(&["loaf"]), &cfg);

    assert_eq!(stats.removed_buckets, 1);
    assert!(keep.dir.exists(), "live descendant kept");
    assert!(!dead.dir.exists(), "dead bucket removed");
    assert!(!host.join("dead").exists(), "empty parent dir cleaned");
    assert!(host.join("loaf").exists(), "live parent retained");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn gc_grace_protects_fresh_bucket() {
    let root = temp("gcgrace");
    let host = root.join("h");
    let b = Bucket::ensure_nested(&root, "h", "dead/node", "spans", "span-tree/v1", None).unwrap();
    // Just-created bucket; a long grace protects it even though its node is dead.
    let cfg = GcConfig {
      enabled: true,
      grace: Duration::from_secs(3600),
    };
    let stats = Janitor::new().with_root(&host).gc(&live(&[]), &cfg);
    assert_eq!(stats.removed_buckets, 0, "fresh bucket protected by grace");
    assert!(b.dir.exists());
    let _ = std::fs::remove_dir_all(&root);
  }
}
