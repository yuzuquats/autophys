//! Bucket retention: per-shape defaults + a file-level prune.
//!
//! Prune is deliberately **file-level** — it never parses a row. It keys on the
//! file's logical date encoded in its NAME (matching how the store buckets data),
//! never on mtime, so backfilled data prunes by logical date and clock-skewed
//! future-dated files are exempt. It NEVER deletes today's hot
//! `samples/<today>.ljson` (the only file a live producer appends to).
//!
//! Prune is also **coverage-gated**: tiers are partitions of the same rows, not
//! copies, so a finer-tier file past its window is deleted only when a coarser
//! tier provably holds its rows —
//!
//! * `samples/<d>.ljson` needs `daily/<d>.parquet` or `weekly/<wk(d)>.parquet`
//!   modified at or after the ljson's mtime;
//! * `daily/<d>.parquet` needs `weekly/<wk(d)>.parquet` modified at or after it.
//!
//! Anything else (an un-rolled day, a late row appended after compaction, a
//! backfilled daily for an already-rolled week) is **held** and counted in
//! [`PruneStats::held`]. Weekly files are the top tier and prune by window.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::Result;
use chrono::{Datelike, NaiveDate, Utc, Weekday};

use crate::RetentionPolicy;

/// Per-shape default retention. Unknown shapes keep everything — we never prune
/// data whose layout we don't understand.
pub fn default_retention(shape_tag: &str) -> RetentionPolicy {
  match shape_tag {
    // High-volume traces: a couple days hot, a month of dailies, ~6mo of weeklies.
    "span-tree/v1" => RetentionPolicy {
      keep_hot_days: Some(2),
      keep_daily_days: Some(30),
      keep_weekly_weeks: Some(26),
    },
    // Point metrics + published check verdicts: a week hot, a quarter of
    // dailies, ~2yr of weeklies.
    "cell/v1" | "host-metrics/v1" | "check/v1" => RetentionPolicy {
      keep_hot_days: Some(7),
      keep_daily_days: Some(90),
      keep_weekly_weeks: Some(104),
    },
    // (`log-line/v1` is retired — the recorder's tailed-text buckets are
    // `span-tree/v1` with an explicit shorter retention stamped in their
    // meta.json, so no shape default applies.)
    _ => RetentionPolicy::default(), // all None ⇒ keep forever
  }
}

/// What a [`prune`] removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PruneStats {
  pub removed_files: usize,
  pub freed_bytes: u64,
  /// Files past their window that were kept because no coarser tier covers
  /// them yet.
  pub held: usize,
}

impl PruneStats {
  fn merge(&mut self, other: PruneStats) {
    self.removed_files += other.removed_files;
    self.freed_bytes += other.freed_bytes;
    self.held += other.held;
  }
}

/// Delete fragments older than `policy` that a coarser tier covers (see the
/// module doc). A `None` tier keeps that tier forever. Callers must hold the
/// bucket's maintenance lock.
pub fn prune(bucket_dir: &Path, policy: &RetentionPolicy) -> Result<PruneStats> {
  Ok(prune_at(bucket_dir, policy, Utc::now().date_naive()))
}

/// Date-injectable core (so tests can pin "today").
pub(crate) fn prune_at(bucket_dir: &Path, policy: &RetentionPolicy, today: NaiveDate) -> PruneStats {
  let mut stats = PruneStats::default();

  // samples/<date>.ljson — completed days only (`date < today`, so today's hot
  // file is never touched), older than the hot window.
  if let Some(keep) = policy.keep_hot_days {
    stats.merge(prune_dated(
      bucket_dir,
      "samples",
      "ljson",
      today,
      keep as i64,
      true,
    ));
  }
  // daily/<date>.parquet — older than the daily window.
  if let Some(keep) = policy.keep_daily_days {
    stats.merge(prune_dated(
      bucket_dir,
      "daily",
      "parquet",
      today,
      keep as i64,
      false,
    ));
  }
  // weekly/<%G-W%V>.parquet — older than the weekly window.
  if let Some(keep) = policy.keep_weekly_weeks {
    stats.merge(prune_weekly(&bucket_dir.join("weekly"), today, keep as i64));
  }
  stats
}

/// The coarser-tier files whose existence (newer than the finer file) proves a
/// `tier/<date>` file's rows were compacted.
fn coverers(bucket_dir: &Path, tier: &str, date: NaiveDate) -> Vec<PathBuf> {
  let weekly = bucket_dir
    .join("weekly")
    .join(format!("{}.parquet", date.format("%G-W%V")));
  match tier {
    "samples" => vec![
      bucket_dir
        .join("daily")
        .join(format!("{}.parquet", date.format("%Y-%m-%d"))),
      weekly,
    ],
    "daily" => vec![weekly],
    _ => Vec::new(),
  }
}

fn mtime(p: &Path) -> Option<SystemTime> {
  std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// True when some coarser file exists and was modified at or after `finer`.
/// An unreadable mtime on either side means "not covered" (hold).
fn is_covered(finer: &Path, coarser: &[PathBuf]) -> bool {
  let Some(f) = mtime(finer) else {
    return false;
  };
  coarser.iter().any(|c| mtime(c).is_some_and(|c| c >= f))
}

/// Prune `<tier>/*.{ext}` files named `%Y-%m-%d` older than `keep_days` whose
/// rows a coarser tier covers. When `completed_only`, files dated
/// today-or-later are skipped (the hot file).
fn prune_dated(
  bucket_dir: &Path,
  tier: &str,
  ext: &str,
  today: NaiveDate,
  keep_days: i64,
  completed_only: bool,
) -> PruneStats {
  let mut stats = PruneStats::default();
  let Ok(rd) = std::fs::read_dir(bucket_dir.join(tier)) else {
    return stats;
  };
  for entry in rd.flatten() {
    let p = entry.path();
    if p.extension().and_then(|e| e.to_str()) != Some(ext) {
      continue;
    }
    let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
      continue;
    };
    let Ok(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") else {
      continue; // unparseable name → leave it
    };
    if completed_only && date >= today {
      continue; // never touch today's (or a future) hot file
    }
    if (today - date).num_days() > keep_days {
      if is_covered(&p, &coverers(bucket_dir, tier, date)) {
        remove(&p, &mut stats);
      } else {
        stats.held += 1;
      }
    }
  }
  stats
}

/// Prune `<%G-W%V>.parquet` weekly files older than `keep_weeks`.
fn prune_weekly(dir: &Path, today: NaiveDate, keep_weeks: i64) -> PruneStats {
  let mut stats = PruneStats::default();
  let Ok(rd) = std::fs::read_dir(dir) else {
    return stats;
  };
  let Some(today_mon) = monday_of(today.iso_week().year(), today.iso_week().week()) else {
    return stats;
  };
  for entry in rd.flatten() {
    let p = entry.path();
    if p.extension().and_then(|e| e.to_str()) != Some("parquet") {
      continue;
    }
    let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
      continue;
    };
    let Some((y, w)) = stem
      .split_once("-W")
      .and_then(|(y, w)| Some((y.parse().ok()?, w.parse().ok()?)))
    else {
      continue;
    };
    let Some(week_mon) = monday_of(y, w) else {
      continue;
    };
    if (today_mon - week_mon).num_days() / 7 > keep_weeks {
      remove(&p, &mut stats);
    }
  }
  stats
}

fn monday_of(iso_year: i32, iso_week: u32) -> Option<NaiveDate> {
  NaiveDate::from_isoywd_opt(iso_year, iso_week, Weekday::Mon)
}

fn remove(p: &Path, stats: &mut PruneStats) {
  let bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
  if std::fs::remove_file(p).is_ok() {
    stats.removed_files += 1;
    stats.freed_bytes += bytes;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp(tag: &str) -> std::path::PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("tb-ret-{tag}-{}-{n}", std::process::id()))
  }

  fn touch(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, b"x").unwrap();
  }

  #[test]
  fn default_for_shapes() {
    assert_eq!(default_retention("span-tree/v1").keep_daily_days, Some(30));
    assert_eq!(default_retention("cell/v1").keep_weekly_weeks, Some(104));
    assert_eq!(default_retention("mystery/v9"), RetentionPolicy::default()); // keep all
  }

  #[test]
  fn prunes_old_keeps_today_and_within_window() {
    let dir = temp("prune");
    let today = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
    touch(&dir.join("samples/2026-08-20.ljson")); // today's hot — must survive
    touch(&dir.join("samples/2026-08-18.ljson")); // 2d old completed …
    touch(&dir.join("daily/2026-08-18.parquet")); // … covered by its (newer) daily
    touch(&dir.join("daily/2026-08-19.parquet")); // 1d old — within window
    touch(&dir.join("daily/2026-08-03.parquet")); // 17d old — past window …
    touch(&dir.join("weekly/2026-W32.parquet")); // … covered by its weekly (kept: 2wk old)
    touch(&dir.join("weekly/2026-W20.parquet")); // ~13wk old — past window
    touch(&dir.join("weekly/2026-W33.parquet")); // current/recent — within

    let policy = RetentionPolicy {
      keep_hot_days: Some(1),
      keep_daily_days: Some(7),
      keep_weekly_weeks: Some(4),
    };
    let stats = prune_at(&dir, &policy, today);

    assert!(
      dir.join("samples/2026-08-20.ljson").exists(),
      "today's hot file survives"
    );
    assert!(
      !dir.join("samples/2026-08-18.ljson").exists(),
      "2d-old covered ljson > 1d window deleted"
    );
    assert!(
      dir.join("daily/2026-08-19.parquet").exists(),
      "1d-old daily within 7d kept"
    );
    assert!(
      !dir.join("daily/2026-08-03.parquet").exists(),
      "17d-old covered daily deleted"
    );
    assert!(
      !dir.join("weekly/2026-W20.parquet").exists(),
      "old weekly deleted"
    );
    assert!(
      dir.join("weekly/2026-W33.parquet").exists(),
      "recent weekly kept"
    );
    assert_eq!(stats.removed_files, 3);
    assert_eq!(stats.held, 0);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn uncovered_or_stale_coverage_is_held() {
    let dir = temp("held");
    let today = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
    let all_zero = RetentionPolicy {
      keep_hot_days: Some(0),
      keep_daily_days: Some(0),
      keep_weekly_weeks: None,
    };
    // An un-rolled day: no daily, no weekly.
    touch(&dir.join("samples/2026-08-10.ljson"));
    // A late row appended AFTER the day's daily was written: the ljson is newer.
    touch(&dir.join("daily/2026-08-11.parquet"));
    touch(&dir.join("samples/2026-08-11.ljson"));
    let old = SystemTime::now() - std::time::Duration::from_secs(3600);
    std::fs::File::options()
      .write(true)
      .open(dir.join("daily/2026-08-11.parquet"))
      .unwrap()
      .set_modified(old)
      .unwrap();
    // A daily whose week has no weekly yet.
    touch(&dir.join("daily/2026-08-12.parquet"));

    let stats = prune_at(&dir, &all_zero, today);
    assert_eq!(stats.removed_files, 0, "nothing is covered");
    assert_eq!(stats.held, 4, "both ljson and both dailies held");
    for f in [
      "samples/2026-08-10.ljson",
      "samples/2026-08-11.ljson",
      "daily/2026-08-11.parquet",
      "daily/2026-08-12.parquet",
    ] {
      assert!(dir.join(f).exists(), "{f} held");
    }

    // Once the week is compacted (weekly newer than everything), all go.
    touch(&dir.join("weekly/2026-W33.parquet"));
    let stats = prune_at(&dir, &all_zero, today);
    assert_eq!(stats.removed_files, 4);
    assert_eq!(stats.held, 0);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn none_policy_keeps_everything() {
    let dir = temp("keepall");
    touch(&dir.join("daily/2020-01-01.parquet")); // ancient
    let stats = prune_at(
      &dir,
      &RetentionPolicy::default(),
      NaiveDate::from_ymd_opt(2026, 8, 20).unwrap(),
    );
    assert_eq!(stats.removed_files, 0);
    assert!(dir.join("daily/2020-01-01.parquet").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn unparseable_names_are_left_alone() {
    let dir = temp("weird");
    touch(&dir.join("daily/not-a-date.parquet"));
    let policy = RetentionPolicy {
      keep_hot_days: None,
      keep_daily_days: Some(0),
      keep_weekly_weeks: None,
    };
    let stats = prune_at(&dir, &policy, NaiveDate::from_ymd_opt(2026, 8, 20).unwrap());
    assert_eq!(stats.removed_files, 0);
    assert!(dir.join("daily/not-a-date.parquet").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
