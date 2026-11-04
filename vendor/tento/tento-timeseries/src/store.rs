//! `TimeSeriesStore<R>` — a generic port of the host-health on-disk store: a
//! per-day line-delimited-JSON hot file, rolled up into a per-day parquet once
//! the day completes, and those into a per-ISO-week parquet once the week
//! completes. `rollup_*` are idempotent / self-healing (a process that was off
//! for days catches every missed rollup on the next run).
//!
//! ```text
//! <dir>/
//!   samples/2026-05-12.ljson    one `R` JSON object per line (bucketed by R::ts())
//!   daily/2026-05-12.parquet    consolidated from samples/2026-05-12.ljson once < today
//!   weekly/2026-W19.parquet     consolidated from that ISO week's daily/*.parquet
//! ```
//!
//! **Tiers are partitions, not copies.** A row lives in exactly one tier after
//! compaction; readers merge `samples → daily → weekly` and dedup by
//! [`SeriesRow::ts_key`], keeping the **first** copy seen in that order (the
//! hot copy wins).
//!
//! **Compaction contract.** Every rollup holds the bucket's maintenance lock
//! (`tento_buckets::maintenance_lock_at`, re-entrant per thread, so the
//! janitor can hold it around this call). A day/week is compacted by: strict
//! read of the sources (a malformed line fails *that* day, which is left in
//! place and reported — the other days still roll) → merge with any existing
//! daily/weekly (late rows are merged, never stranded or overwritten) → write a
//! unique tmp → `sync_all` → rename → fsync the dir → re-read and compare the
//! row count → only then unlink the sources and fsync their dir. The current
//! UTC day (and the current ISO week) is never rolled.
//!
//! **Bounded memory.** Compaction never holds a whole day or week: inputs are
//! streamed into an external merge sort ([`crate::compact`]) whose sorted run
//! files live in a private `.compact-*` dir inside the store dir, and the
//! output is written and verified in bounded record batches and row groups.
//! Peak memory follows [`CompactionLimits`], not the input size.
//!
//! **Crash-loop breaker.** An OOM kill cannot be caught, so before a day
//! (week) is compacted an attempt marker `samples/<day>.ljson.attempts`
//! (`weekly/<week>.parquet.attempts`) is written durably; a success or an
//! ordinary failure removes it. A source whose marker already counts
//! [`MAX_UNFINISHED_ATTEMPTS`] is not retried: its files are moved, byte for
//! byte, to `quarantine/samples/` (`quarantine/daily/`) with a `.reason` note
//! and reported in [`RollupReport::quarantined`]. Quarantined files are **not
//! served** by any read and never pruned; restore one by moving it back into
//! its tier and deleting its `.attempts` marker (the next rollup retries it).
//! See [`quarantined`](TimeSeriesStore::quarantined).
//!
//! **Appends vs maintenance.** Compaction (read → write → unlink) and
//! quarantine (rename) of a day hold that day file's exclusive `flock`, the
//! same lock every append takes. An appender that wins the lock afterwards
//! finds its open handle is no longer the file at the path (dev/inode
//! differ) and reopens the path, so a late past-dated row lands in a fresh
//! `samples/<day>.ljson` (merged by the next rollup), never in an unlinked or
//! quarantined inode. After a few lost rounds the appender takes the
//! maintenance lock (holding no day-file lock) and then cannot lose again.
//!
//! **Markers never outlive their file.** A compaction clears its attempt
//! marker before it unlinks the source, and quarantine moves the marker
//! before the data, so a fresh file later created at the same path never
//! inherits a dead generation's count. Dying in between costs a retry, not
//! data.
//!
//! **Oversized rows.** No ljson line is buffered past
//! [`CompactionLimits::max_row_bytes`]; a longer line (terminated or not) is
//! dropped, logged to stderr with file, byte offset and size, and counted in
//! [`RollupReport::dropped_oversized`]; the rest of the day compacts and its
//! source is removed as usual (operator decision TBC-D6, 2026-10-27). A
//! malformed line that is not oversized still holds the day.
//!
//! **Reads.** [`range_strict`](TimeSeriesStore::range_strict) reports per-file
//! failures in a [`Coverage`]; `range`, `range_windowed`, `tail_n`, `latest`,
//! `earliest` and `today` are best-effort (unreadable files and malformed lines
//! are skipped) and share the same segment logic.

use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use tento_buckets::{durable, maintenance_lock_at};

use crate::compact::{CompactionLimits, Sorter, WORK_DIR_PREFIX};
use crate::row::SeriesRow;

/// Keep source files after a successful rollup? `false` = truncate-after-compact
/// (the consolidated copy is authoritative).
const KEEP_SOURCE_AFTER_ROLLUP: bool = false;

/// Unfinished compaction attempts (process deaths mid-compaction) after which
/// a source is quarantined instead of retried.
pub const MAX_UNFINISHED_ATTEMPTS: u32 = 3;

/// Optimistic open → lock → inode-check rounds an append makes before it
/// falls back to the maintenance lock (see `append_with`).
const APPEND_OPTIMISTIC_TRIES: u32 = 4;

/// Suffix of a compaction attempt marker, appended to the guarded file name.
const ATTEMPTS_SUFFIX: &str = ".attempts";

/// A time-series store rooted at a directory, generic over the row shape.
pub struct TimeSeriesStore<R: SeriesRow> {
  dir: PathBuf,
  limits: CompactionLimits,
  _row: PhantomData<fn() -> R>,
}

/// A no-rollup snapshot for a node's `check()`.
#[derive(Debug, Clone)]
pub struct StoreSummary<R> {
  /// Most recent row on disk, if any (last line of the newest `samples/*.ljson`).
  pub latest: Option<R>,
  /// Lines in today's (UTC) `samples/*.ljson`.
  pub today_count: usize,
  pub daily_parquets: usize,
  pub weekly_parquets: usize,
  /// A completed day still un-consolidated in `samples/` (daily rollup behind).
  pub pending_daily: Option<NaiveDate>,
  /// A completed week with dailies but no weekly parquet (weekly rollup behind).
  pub pending_weekly: Option<String>,
}

/// How [`TimeSeriesStore::append_with`] reaches disk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppendOptions {
  /// `true`: `sync_all` the day file — and fsync `samples/` (and the store dir)
  /// when the file (or dir) was just created — before returning, so `Ok` is a
  /// durable admission receipt. `false` (the default, for logs/metrics): the
  /// line is in the page cache only.
  pub durable: bool,
}

/// The rows of a window plus an honest account of what could not be read.
#[derive(Debug, Clone)]
pub struct Coverage<R> {
  /// Deduplicated rows in the window, oldest first (by `ts_key`).
  pub rows: Vec<R>,
  /// `failed.is_empty()` — every segment that can hold window rows was read.
  pub complete: bool,
  /// Per-file problems: an unreadable/undecodable file, a parquet schema
  /// mismatch, a malformed interior ljson line (`"line N: …"`; the file's other
  /// lines are still read), or a segment that vanished twice mid-read.
  pub failed: Vec<(PathBuf, String)>,
  /// Some hot file ends in an unterminated, unparseable line — an append in
  /// flight (or a crash remnant), not counted as a failure.
  pub in_flight_tail: bool,
}

/// What a rollup did, with per-file failures isolated.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RollupReport {
  pub daily: Vec<NaiveDate>,
  pub weekly: Vec<String>,
  /// Source files left in place because they could not be compacted safely.
  pub failed: Vec<(PathBuf, String)>,
  /// Sources moved to `quarantine/` by this rollup because earlier
  /// compactions of them never finished (the process died): `(original
  /// path, note)`. Reported once, on the rollup that moves them.
  pub quarantined: Vec<(PathBuf, String)>,
  /// Sources that compacted with ljson lines over
  /// [`CompactionLimits::max_row_bytes`] dropped: `(source path, lines
  /// dropped)`. Those rows are lost; this and a stderr line per row are the
  /// only record. Does not make the report unclean.
  pub dropped_oversized: Vec<(PathBuf, u64)>,
}

impl RollupReport {
  /// Nothing held and nothing quarantined by this rollup.
  pub fn is_clean(&self) -> bool {
    self.failed.is_empty() && self.quarantined.is_empty()
  }

  fn into_error(self, dir: &Path) -> anyhow::Error {
    let detail: Vec<String> = self
      .failed
      .iter()
      .map(|(p, e)| format!("{}: {e}", p.display()))
      .chain(
        self
          .quarantined
          .iter()
          .map(|(p, e)| format!("{}: quarantined: {e}", p.display())),
      )
      .collect();
    anyhow::anyhow!(
      "rollup {}: {} segment(s) held, {} quarantined: {}",
      dir.display(),
      self.failed.len(),
      self.quarantined.len(),
      detail.join("; ")
    )
  }
}

/// How a guarded compaction went.
enum Attempt<T> {
  /// It ran (the marker was cleared afterwards).
  Ran(Result<T>),
  /// The marker already counted this many unfinished attempts; not run.
  Exhausted(u32),
}

/// What [`compact_day`](TimeSeriesStore::compact_day) did.
struct DayCompaction {
  /// A daily parquet was written (the source held kept rows).
  rolled: bool,
  /// Oversized ljson lines dropped from the source.
  dropped_oversized: u64,
}

impl<R: SeriesRow> TimeSeriesStore<R> {
  pub fn new(dir: impl Into<PathBuf>) -> Self {
    TimeSeriesStore {
      dir: dir.into(),
      limits: CompactionLimits::default(),
      _row: PhantomData,
    }
  }

  /// Override the compaction memory budget (tests, constrained hosts).
  pub fn with_compaction_limits(mut self, limits: CompactionLimits) -> Self {
    self.limits = limits;
    self
  }

  pub fn dir(&self) -> &Path {
    &self.dir
  }

  fn quarantine_dir(&self) -> PathBuf {
    self.dir.join("quarantine")
  }

  fn samples_dir(&self) -> PathBuf {
    self.dir.join("samples")
  }
  fn daily_dir(&self) -> PathBuf {
    self.dir.join("daily")
  }
  fn weekly_dir(&self) -> PathBuf {
    self.dir.join("weekly")
  }
  fn samples_file(&self, date: NaiveDate) -> PathBuf {
    self
      .samples_dir()
      .join(format!("{}.ljson", date.format("%Y-%m-%d")))
  }
  fn daily_file(&self, date: NaiveDate) -> PathBuf {
    self
      .daily_dir()
      .join(format!("{}.parquet", date.format("%Y-%m-%d")))
  }
  fn weekly_file(&self, date: NaiveDate) -> PathBuf {
    self
      .weekly_dir()
      .join(format!("{}.parquet", week_label(date)))
  }

  // ── append ────────────────────────────────────────────────────────────────

  /// Append one row to its day's `samples/*.ljson` (bucketed by `R::ts()`).
  /// Past-dated rows land in the correct historical file, so backfill works
  /// (a rolled day is merged again by the next rollup). Best-effort
  /// durability: see [`append_synced`](Self::append_synced).
  ///
  /// The line (content + trailing `\n`) is issued as ONE `write` on the
  /// `O_APPEND` handle. Multiple appenders share a day-file — the tracing
  /// span sink's worker threads, and even separate processes (a server plus
  /// one-shot CLI runs with the same bucket identity) — and the kernel only
  /// serializes individual `O_APPEND` writes. Writing content and newline
  /// separately let two appenders interleave as `row1 row2 \n \n`: a torn
  /// line carrying two JSON objects (silently skipped by readers) plus a
  /// blank. Found as 8 torn rows across the fleet's loaf span buckets.
  ///
  /// **Torn-tail repair:** if the file's last byte is not `\n` (a crash or
  /// ENOSPC mid-append), the line is prefixed with `\n`, so the torn fragment
  /// stays one bad line instead of corrupting this row too.
  ///
  /// **Appenders serialize on an exclusive `flock` of the day file** for the
  /// tail check and the write. An `O_APPEND` write is atomic only against
  /// other writes, not against a reader: Linux publishes a write that crosses
  /// a page boundary one page at a time, so an unlocked tail check could see
  /// another appender's half-copied line (its length a page multiple),
  /// "repair" it, and leave a blank line. Readers take no lock; an
  /// unterminated tail they see is still an append in flight.
  pub fn append(&self, row: &R) -> Result<()> {
    self.append_with(row, AppendOptions::default())
  }

  /// [`append`](Self::append), then `sync_all` the file (and fsync the
  /// directory entry on first create): `Ok` means the row survives power loss.
  pub fn append_synced(&self, row: &R) -> Result<()> {
    self.append_with(row, AppendOptions { durable: true })
  }

  /// [`append`](Self::append) with explicit [`AppendOptions`].
  pub fn append_with(&self, row: &R, opts: AppendOptions) -> Result<()> {
    use std::io::Write;
    let dir = self.samples_dir();
    let dir_existed = opts.durable && dir.is_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let path = self.samples_file(row.ts().date_naive());
    let mut file_existed = opts.durable && path.exists();
    // A leading `\n` for torn-tail repair, skipped when the tail is whole.
    let mut line = Vec::with_capacity(256);
    line.push(b'\n');
    serde_json::to_writer(&mut line, row)?;
    line.push(b'\n');
    // Compaction and quarantine hold this same lock while they read, unlink
    // or rename a completed day. An appender that opened the file before
    // that and only then got the lock holds a handle to an inode that is no
    // longer the day file: it reopens the path instead of writing rows into
    // a compacted (unlinked) or quarantined file.
    //
    // Each reopen can lose another race to a later rollup, so after
    // `APPEND_OPTIMISTIC_TRIES` rounds the appender falls back: holding no
    // day-file lock, it takes the bucket's maintenance lock (which every
    // compaction and quarantine holds for its whole run), then opens and
    // locks the current file, which nothing can replace meanwhile. The lock
    // order is always maintenance → day file, as in a rollup, and an
    // appender never waits for maintenance while holding a day-file lock, so
    // the two cannot deadlock.
    let mut maintenance = None;
    let mut tries = 0;
    let mut f = loop {
      tries += 1;
      if tries > APPEND_OPTIMISTIC_TRIES && maintenance.is_none() {
        maintenance = Some(
          maintenance_lock_at(&self.dir)
            .with_context(|| format!("maintenance lock {}", self.dir.display()))?,
        );
      }
      let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
      #[cfg(test)]
      if maintenance.is_none() {
        test_hooks::before_append_lock(&path);
      }
      f.lock()
        .with_context(|| format!("lock {}", path.display()))?;
      if is_current_file(&f, &path) {
        break f;
      }
      let _ = f.unlock();
      file_existed = false;
      // Under the maintenance lock nothing replaces the file; a mismatch
      // there means a maintainer that ignores the lock.
      anyhow::ensure!(
        maintenance.is_none(),
        "append {}: the day file was replaced under the maintenance lock",
        path.display()
      );
    };
    let skip = usize::from(!ends_without_newline(&f));
    let written = f.write_all(&line[skip..]);
    // Unlock explicitly rather than on close: a child forked meanwhile holds a
    // copy of this descriptor until it execs, and would keep the lock held.
    let unlocked = f.unlock();
    drop(maintenance);
    written.with_context(|| format!("append {}", path.display()))?;
    unlocked.with_context(|| format!("unlock {}", path.display()))?;
    if opts.durable {
      f.sync_all()
        .with_context(|| format!("sync {}", path.display()))?;
      if !file_existed {
        durable::fsync_dir(&dir).with_context(|| format!("fsync {}", dir.display()))?;
      }
      if !dir_existed {
        durable::fsync_dir(&self.dir).with_context(|| format!("fsync {}", self.dir.display()))?;
      }
    }
    Ok(())
  }

  // ── rollups (idempotent / self-healing / lock-holding) ─────────────────────

  /// Run both rollups for any completed periods. `Err` when any day or week
  /// was held (the others are still rolled); see
  /// [`rollup_report`](Self::rollup_report) for the per-file detail.
  pub fn rollup(&self) -> Result<()> {
    let report = self.rollup_report()?;
    if report.is_clean() {
      Ok(())
    } else {
      Err(report.into_error(&self.dir))
    }
  }

  /// Daily then weekly rollup under the maintenance lock, with every failure
  /// isolated to its own day/week. `Err` only if the lock cannot be taken.
  pub fn rollup_report(&self) -> Result<RollupReport> {
    let mut report = RollupReport::default();
    let Some(_lock) = self.lock()? else {
      return Ok(report);
    };
    self.rollup_daily_into(&mut report);
    self.rollup_weekly_into(&mut report);
    Ok(report)
  }

  /// Consolidate each pre-today `samples/*.ljson` into its daily parquet
  /// (merging with an existing daily), then drop the ljson. Returns the dates
  /// rolled up; `Err` if any day was held (the other days still roll).
  pub fn rollup_daily(&self) -> Result<Vec<NaiveDate>> {
    let mut report = RollupReport::default();
    let Some(_lock) = self.lock()? else {
      return Ok(Vec::new());
    };
    self.rollup_daily_into(&mut report);
    if report.is_clean() {
      Ok(report.daily)
    } else {
      Err(report.into_error(&self.dir))
    }
  }

  /// Merge each completed ISO week's daily parquets into its weekly parquet
  /// (merging with an existing weekly), then drop the dailies. Returns the
  /// week labels rolled up; `Err` if any week was held.
  pub fn rollup_weekly(&self) -> Result<Vec<String>> {
    let mut report = RollupReport::default();
    let Some(_lock) = self.lock()? else {
      return Ok(Vec::new());
    };
    self.rollup_weekly_into(&mut report);
    if report.is_clean() {
      Ok(report.weekly)
    } else {
      Err(report.into_error(&self.dir))
    }
  }

  /// The maintenance lock, or `None` when the store dir does not exist yet
  /// (nothing to roll). Holding it, clears what a killed compaction left
  /// behind (see [`clear_stale`](Self::clear_stale)).
  fn lock(&self) -> Result<Option<tento_buckets::MaintenanceLock>> {
    if !self.dir.is_dir() {
      return Ok(None);
    }
    let lock = maintenance_lock_at(&self.dir)
      .with_context(|| format!("maintenance lock {}", self.dir.display()))?;
    self.clear_stale();
    Ok(Some(lock))
  }

  /// Best-effort removal of a dead compaction's leftovers. Only a compaction
  /// writes them and every compaction holds the maintenance lock, so under
  /// the lock they are stale: `.compact-*` run dirs, `daily|weekly/*.tmp`
  /// parquet tmps, and `samples/*.ljson.attempts` markers whose day file is
  /// gone (killed between the unlink and the marker removal).
  fn clear_stale(&self) {
    if let Ok(rd) = std::fs::read_dir(&self.dir) {
      for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with(WORK_DIR_PREFIX)
          && e.file_type().is_ok_and(|t| t.is_dir())
        {
          let _ = std::fs::remove_dir_all(e.path());
        }
      }
    }
    for tier in [self.daily_dir(), self.weekly_dir()] {
      let Ok(rd) = std::fs::read_dir(&tier) else {
        continue;
      };
      for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.contains(".parquet")
          && name.ends_with(".tmp")
          && e.file_type().is_ok_and(|t| t.is_file())
        {
          let _ = std::fs::remove_file(e.path());
        }
      }
    }
    if let Ok(rd) = std::fs::read_dir(self.samples_dir()) {
      for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(src) = name.strip_suffix(ATTEMPTS_SUFFIX)
          && !p.with_file_name(src).exists()
        {
          let _ = std::fs::remove_file(&p);
        }
      }
    }
    // A weekly marker guards that week's dailies. With none left (killed
    // after unlinking the last one), it would otherwise outlive them and
    // charge its count to a later backfill of the same week. This runs
    // before any daily compaction of the rollup creates new dailies.
    if let Ok(rd) = std::fs::read_dir(self.weekly_dir()) {
      let weeks_with_dailies: std::collections::BTreeSet<String> =
        list_dir(&self.daily_dir(), "parquet")
          .iter()
          .filter_map(|p| parse_date_stem(p))
          .map(week_label)
          .collect();
      for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(week) = name
          .strip_suffix(ATTEMPTS_SUFFIX)
          .and_then(|n| n.strip_suffix(".parquet"))
          && !weeks_with_dailies.contains(week)
        {
          let _ = std::fs::remove_file(e.path());
        }
      }
    }
  }

  fn rollup_daily_into(&self, report: &mut RollupReport) {
    let today = Utc::now().date_naive();
    for path in list_dir(&self.samples_dir(), "ljson") {
      let Some(date) = parse_date_stem(&path) else {
        continue;
      };
      if date >= today {
        continue; // today's file is still being appended to
      }
      let marker = attempts_marker(&path);
      match self.attempt(&marker, || self.compact_day(date, &path)) {
        Attempt::Ran(Ok(day)) => {
          if day.rolled {
            report.daily.push(date);
          }
          if day.dropped_oversized > 0 {
            report.dropped_oversized.push((path, day.dropped_oversized));
          }
        }
        Attempt::Ran(Err(e)) => report.failed.push((path, format!("{e:#}"))),
        Attempt::Exhausted(n) => {
          let label = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
          match self.quarantine("samples", &label, std::slice::from_ref(&path), &marker, n) {
            Ok(note) => report.quarantined.push((path, note)),
            Err(e) => report.failed.push((path, format!("quarantine: {e:#}"))),
          }
        }
      }
    }
    report.daily.sort();
  }

  /// Run one compaction under a durable attempt marker. A marker left by a
  /// process that died mid-compaction survives and counts; a finished
  /// attempt — success or ordinary error — clears it.
  fn attempt<T>(&self, marker: &Path, compact: impl FnOnce() -> Result<T>) -> Attempt<T> {
    let prior = read_attempts(marker);
    if prior >= MAX_UNFINISHED_ATTEMPTS {
      return Attempt::Exhausted(prior);
    }
    if let Err(e) = write_attempts(marker, prior + 1) {
      return Attempt::Ran(Err(
        e.context(format!("record attempt {}", marker.display())),
      ));
    }
    let result = compact();
    // A successful compaction already cleared it before unlinking its
    // source; this clears it after an ordinary failure. Best-effort: one
    // that survives a finished attempt costs one count.
    if std::fs::remove_file(marker).is_ok()
      && let Some(dir) = marker.parent()
    {
      let _ = durable::fsync_dir(dir);
    }
    Attempt::Ran(result)
  }

  /// Move `files` (and their attempt `marker`) into `quarantine/<tier>/`,
  /// byte for byte, with a `<label>.reason` note. Returns the note.
  fn quarantine(
    &self,
    tier: &str,
    label: &str,
    files: &[PathBuf],
    marker: &Path,
    attempts: u32,
  ) -> Result<String> {
    let qdir = self.quarantine_dir().join(tier);
    std::fs::create_dir_all(&qdir).with_context(|| format!("create {}", qdir.display()))?;
    // The marker moves first: a death before the data moves leaves the
    // source with no marker (it is retried, at worst dying up to
    // MAX_UNFINISHED_ATTEMPTS more times), never a full marker beside a path
    // that may hold a fresh file by then.
    if let Some(name) = marker.file_name()
      && marker.exists()
    {
      std::fs::rename(marker, free_name(&qdir, name))
        .with_context(|| format!("move {}", marker.display()))?;
      if let Some(d) = marker.parent() {
        durable::fsync_dir(d).with_context(|| format!("fsync {}", d.display()))?;
      }
    }
    #[cfg(test)]
    test_hooks::crash_point("quarantine-before-data");
    let mut moved = Vec::new();
    let mut src_dirs: Vec<PathBuf> = Vec::new();
    for f in files {
      let name = f.file_name().context("quarantine: no file name")?;
      let dest = free_name(&qdir, name);
      // Under the day-file lock, so a concurrent appender either finishes
      // first (its row moves with the file) or reopens the original path.
      let held = DayFileLock::acquire(f)?;
      std::fs::rename(f, &dest)
        .with_context(|| format!("move {} -> {}", f.display(), dest.display()))?;
      drop(held);
      moved.push(dest.display().to_string());
      if let Some(d) = f.parent()
        && !src_dirs.iter().any(|x| x == d)
      {
        src_dirs.push(d.to_path_buf());
      }
    }
    let note = format!(
      "{attempts} compaction attempt(s) of {label} never finished (the process died mid-compaction); \
       moved to {}; restore by moving the file(s) back into {tier}/ and deleting the .attempts marker",
      qdir.display()
    );
    let reason = format!(
      "quarantined_at: {}\nreason: {note}\nfiles:\n{}\n",
      Utc::now().to_rfc3339(),
      moved.iter().map(|m| format!("  {m}\n")).collect::<String>()
    );
    durable::write_atomic(
      &free_name(&qdir, format!("{label}.reason").as_ref()),
      reason.as_bytes(),
    )
    .context("write quarantine reason")?;
    durable::fsync_dir(&qdir).with_context(|| format!("fsync {}", qdir.display()))?;
    for d in src_dirs
      .iter()
      .chain(marker.parent().map(Path::to_path_buf).iter())
    {
      durable::fsync_dir(d).with_context(|| format!("fsync {}", d.display()))?;
    }
    let _ = durable::fsync_dir(&self.quarantine_dir());
    let _ = durable::fsync_dir(&self.dir);
    Ok(note)
  }

  /// Files moved to `quarantine/` (not served by any read; see the module
  /// doc). Excludes the `.reason` notes and `.attempts` markers. Sorted.
  pub fn quarantined(&self) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ["samples", "daily"]
      .iter()
      .filter_map(|t| std::fs::read_dir(self.quarantine_dir().join(t)).ok())
      .flat_map(|rd| rd.flatten().map(|e| e.path()))
      .filter(|p| {
        // Data files keep their tier extension (see `free_name`); the
        // `.reason` notes and `.attempts` markers never end in one.
        matches!(
          p.extension().and_then(|e| e.to_str()),
          Some("ljson" | "parquet")
        ) && p.is_file()
      })
      .collect();
    out.sort();
    out
  }

  /// Compact one completed day. `rolled == false` = the source held no
  /// (kept) rows; it is removed either way. Oversized lines are dropped and
  /// counted (TBC-D6), never holding the day.
  ///
  /// Bounded memory: the source is streamed (strictly) into the external
  /// sorter, then any existing daily batch by batch — that order is the
  /// first-copy-wins precedence — and the merge is written in bounded
  /// batches and verified by streaming it back.
  ///
  /// The day file's exclusive lock (the one appenders take) is held from the
  /// read through the unlink, so a late past-dated append either lands
  /// before the read or, seeing the unlinked inode, reopens a fresh file
  /// that the next rollup merges. Late appenders for this day wait for the
  /// compaction.
  fn compact_day(&self, date: NaiveDate, src: &Path) -> Result<DayCompaction> {
    let held = DayFileLock::acquire(src)?;
    let mut sorter = Sorter::new(&self.dir, self.limits)?;
    let rows = sorter.push_ljson_strict::<R>(&held.file, src)?;
    let dropped_oversized = sorter.dropped_oversized();
    if rows == 0 {
      drop(sorter);
      clear_marker(&attempts_marker(src))?;
      std::fs::remove_file(src).with_context(|| format!("remove {}", src.display()))?;
      return Ok(DayCompaction {
        rolled: false,
        dropped_oversized,
      });
    }
    let out = self.daily_file(date);
    if out.exists() {
      sorter
        .push_parquet_strict::<R>(&out)
        .with_context(|| format!("merge into {}", out.display()))?;
    }
    sorter.finish_parquet::<R>(&out)?;
    if !KEEP_SOURCE_AFTER_ROLLUP {
      // The attempt is finished once the daily is verified: clear its marker
      // before the unlink, so a marker never outlives the file it counts (a
      // fresh file at the path must not inherit it). A death in between
      // leaves the source with no marker; the next rollup merges it into the
      // daily again (same rows, first copy wins).
      clear_marker(&attempts_marker(src))?;
      #[cfg(test)]
      test_hooks::crash_point("compact-before-unlink");
      std::fs::remove_file(src).with_context(|| format!("remove {}", src.display()))?;
      durable::fsync_dir(&self.samples_dir()).context("fsync samples/")?;
    }
    Ok(DayCompaction {
      rolled: true,
      dropped_oversized,
    })
  }

  fn rollup_weekly_into(&self, report: &mut RollupReport) {
    let this_week = Utc::now().date_naive().iso_week();
    let mut by_week: BTreeMap<String, (NaiveDate, Vec<PathBuf>)> = BTreeMap::new();
    for path in list_dir(&self.daily_dir(), "parquet") {
      let Some(date) = parse_date_stem(&path) else {
        continue;
      };
      if date.iso_week() >= this_week {
        continue;
      }
      by_week
        .entry(week_label(date))
        .or_insert_with(|| (date, Vec::new()))
        .1
        .push(path);
    }
    for (label, (any_date, mut daily_paths)) in by_week {
      daily_paths.sort();
      let out = self.weekly_file(any_date);
      let marker = attempts_marker(&out);
      match self.attempt(&marker, || self.compact_week(any_date, &daily_paths)) {
        Attempt::Ran(Ok(true)) => report.weekly.push(label),
        Attempt::Ran(Ok(false)) => {}
        Attempt::Ran(Err(e)) => report.failed.push((out, format!("{e:#}"))),
        Attempt::Exhausted(n) => match self.quarantine("daily", &label, &daily_paths, &marker, n) {
          Ok(note) => report.quarantined.push((out, note)),
          Err(e) => report.failed.push((out, format!("quarantine: {e:#}"))),
        },
      }
    }
  }

  /// Compact one completed week's dailies. `Ok(false)` = they held no rows.
  /// Bounded memory, as [`compact_day`](Self::compact_day): the dailies in
  /// date order, then any existing weekly, stream into the external sorter.
  fn compact_week(&self, any_date: NaiveDate, daily_paths: &[PathBuf]) -> Result<bool> {
    let mut sorter = Sorter::new(&self.dir, self.limits)?;
    let mut rows = 0u64;
    for p in daily_paths {
      rows += sorter.push_parquet_strict::<R>(p)?;
    }
    if rows == 0 {
      return Ok(false);
    }
    let out = self.weekly_file(any_date);
    if out.exists() {
      sorter
        .push_parquet_strict::<R>(&out)
        .with_context(|| format!("merge into {}", out.display()))?;
    }
    sorter.finish_parquet::<R>(&out)?;
    if !KEEP_SOURCE_AFTER_ROLLUP {
      clear_marker(&attempts_marker(&out))?;
      for p in daily_paths {
        std::fs::remove_file(p).with_context(|| format!("remove {}", p.display()))?;
      }
      durable::fsync_dir(&self.daily_dir()).context("fsync daily/")?;
    }
    Ok(true)
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /// All rows in today's (UTC) `samples/*.ljson`, oldest first.
  pub fn today(&self) -> Vec<R> {
    read_ljson(&self.samples_file(Utc::now().date_naive())).unwrap_or_default()
  }

  /// The most recent row on disk across all stored segments, or `None` if
  /// the store is empty. Normally lives in the newest `samples/*.ljson`,
  /// but after the rollup empties samples (a paused producer, a test) the
  /// fallback to the newest `daily/*` / `weekly/*` keeps the answer
  /// correct. Constant work: at most three file reads.
  pub fn latest(&self) -> Option<R> {
    let weekly = list_dir(&self.weekly_dir(), "parquet")
      .into_iter()
      .next_back()
      .and_then(|p| read_parquet::<R>(&p).ok());
    let daily = list_dir(&self.daily_dir(), "parquet")
      .into_iter()
      .next_back()
      .and_then(|p| read_parquet::<R>(&p).ok());
    let samples = list_dir(&self.samples_dir(), "ljson")
      .into_iter()
      .next_back()
      .and_then(|p| read_ljson::<R>(&p).ok());
    [weekly, daily, samples]
      .into_iter()
      .flatten()
      .flat_map(|rows| rows.into_iter())
      .max_by(|a, b| a.ts().cmp(&b.ts()))
  }

  /// The oldest row on disk across all stored segments, or `None` if the
  /// store is empty. Reads the chronologically first file from each tier
  /// (weekly / daily / samples) and returns the row with the smallest
  /// timestamp — robust to which tier actually holds the oldest data
  /// (typically `weekly` once rollups have run; `samples` before any rollup).
  /// Constant work: at most three file reads, regardless of archive size.
  pub fn earliest(&self) -> Option<R> {
    let weekly = list_dir(&self.weekly_dir(), "parquet")
      .into_iter()
      .next()
      .and_then(|p| read_parquet::<R>(&p).ok());
    let daily = list_dir(&self.daily_dir(), "parquet")
      .into_iter()
      .next()
      .and_then(|p| read_parquet::<R>(&p).ok());
    let samples = list_dir(&self.samples_dir(), "ljson")
      .into_iter()
      .next()
      .and_then(|p| read_ljson::<R>(&p).ok());
    [weekly, daily, samples]
      .into_iter()
      .flatten()
      .flat_map(|rows| rows.into_iter())
      .min_by(|a, b| a.ts().cmp(&b.ts()))
  }

  /// All on-disk rows whose timestamp falls in `[from, to]`, oldest first,
  /// deduplicated by [`ts_key`](SeriesRow::ts_key) (first copy in
  /// samples → daily → weekly order wins). Opens **every** file in every tier
  /// (a full scan); prefer [`range_windowed`](Self::range_windowed).
  /// Best-effort: unreadable files and malformed lines are skipped.
  pub fn range(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<R> {
    self
      .collect(
        || {
          let mut all = list_dir(&self.samples_dir(), "ljson");
          all.extend(list_dir(&self.daily_dir(), "parquet"));
          all.extend(list_dir(&self.weekly_dir(), "parquet"));
          all
        },
        from,
        to,
        false,
      )
      .rows
  }

  /// The existing fragment files whose rows can fall in `[from, to]`: every
  /// in-range `samples/<d>.ljson` and `daily/<d>.parquet`, plus the
  /// `weekly/<wk>.parquet` of every in-range ISO week **whenever it exists** —
  /// a daily inside an already-rolled week holds only late rows, so the weekly
  /// is never skipped because a daily exists. Dates are UTC — files are
  /// UTC-dated by the rollup, so the filename date is exactly the rows' date.
  /// Lists paths only; reads nothing. Sorted by path.
  pub fn segments_for_range(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<PathBuf> {
    if from > to {
      return Vec::new();
    }
    let last = to.date_naive();
    let mut out: Vec<PathBuf> = Vec::new();
    let mut weeks: BTreeMap<String, NaiveDate> = BTreeMap::new();

    let mut d = from.date_naive();
    while d <= last {
      let s = self.samples_file(d);
      if s.is_file() {
        out.push(s);
      }
      let dp = self.daily_file(d);
      if dp.is_file() {
        out.push(dp);
      }
      weeks.entry(week_label(d)).or_insert(d);
      match d.succ_opt() {
        Some(n) => d = n,
        None => break,
      }
    }
    for rep in weeks.values() {
      let wp = self.weekly_file(*rep);
      if wp.is_file() {
        out.push(wp);
      }
    }
    out.sort();
    out.dedup();
    out
  }

  /// Rows in `[from, to]`, reading **only** [`segments_for_range`] — the cheap
  /// windowed counterpart of [`range`] (which opens every file in every tier).
  /// Same `ts_key` dedup and tier precedence (samples → daily → weekly, first
  /// copy wins, so the hot `samples` win on a collision). Best-effort.
  ///
  /// [`segments_for_range`]: Self::segments_for_range
  /// [`range`]: Self::range
  pub fn range_windowed(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<R> {
    self.collect(|| self.ordered_segments(from, to), from, to, false).rows
  }

  /// The strict counterpart of [`range_windowed`](Self::range_windowed): the
  /// same segments and dedup, but every per-file problem is reported in
  /// [`Coverage::failed`] (never aborting the whole range), an unterminated
  /// last line is reported as [`Coverage::in_flight_tail`], parquet is decoded
  /// with [`SeriesRow::try_from_batch`] (schema mismatch = failed segment), and
  /// a segment that vanishes mid-read (a concurrent rollup moved it) triggers
  /// one re-list. Use it wherever "no rows" must not be confused with "could
  /// not read" (exports, attribution, completeness checks).
  pub fn range_strict(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Coverage<R>> {
    Ok(self.collect(|| self.ordered_segments(from, to), from, to, true))
  }

  /// [`segments_for_range`](Self::segments_for_range) in read-precedence order.
  fn ordered_segments(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<PathBuf> {
    let mut segs = self.segments_for_range(from, to);
    segs.sort_by_key(|p| tier_rank(p)); // stable: samples … weekly
    segs
  }

  /// The shared segment reader behind every range read: read `list()` in
  /// order, keep in-window rows first-copy-wins, record per-file failures, and
  /// re-list once if a listed segment vanished (rolled up under us).
  fn collect(
    &self,
    list: impl Fn() -> Vec<PathBuf>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    strict: bool,
  ) -> Coverage<R> {
    let mut attempt = 0;
    loop {
      let mut by_key: BTreeMap<String, R> = BTreeMap::new();
      let mut failed: Vec<(PathBuf, String)> = Vec::new();
      let mut vanished: Vec<PathBuf> = Vec::new();
      let mut in_flight_tail = false;
      for p in list() {
        let seg = match p.extension().and_then(|e| e.to_str()) {
          Some("ljson") => read_ljson_segment::<R>(&p),
          Some("parquet") => read_parquet_segment::<R>(&p, strict).map(|rows| Segment {
            rows,
            ..Segment::default()
          }),
          _ => continue,
        };
        match seg {
          Ok(seg) => {
            for r in seg.rows {
              let t = r.ts();
              if t >= from && t <= to {
                by_key.entry(r.ts_key()).or_insert(r);
              }
            }
            failed.extend(seg.bad_lines.into_iter().map(|b| (p.clone(), b)));
            in_flight_tail |= seg.in_flight_tail;
          }
          Err(SegErr::Vanished) => vanished.push(p),
          Err(SegErr::Failed(e)) => failed.push((p, e)),
        }
      }
      if vanished.is_empty() || attempt > 0 {
        failed.extend(
          vanished
            .into_iter()
            .map(|p| (p, "segment vanished during read".to_string())),
        );
        return Coverage {
          rows: by_key.into_values().collect(),
          complete: failed.is_empty(),
          failed,
          in_flight_tail,
        };
      }
      attempt += 1;
    }
  }

  /// The `n` most recent rows on disk, chronological-oldest-first. Walks
  /// **dates newest-first across tiers**: ISO weeks newest first, and within a
  /// week each date's `samples` then `daily`, then the week's `weekly`. Stops
  /// once ≥ `n` distinct rows are held from dates newer than anything unread
  /// (a week with a weekly is read whole first, since the weekly can hold any
  /// of its dates). Within ljson files only the last-N lines are parsed, so
  /// `--op logs --lines 200` against 15k lines/day stays cheap.
  ///
  /// Same `ts_key` dedup contract as [`range`](Self::range): the first copy
  /// in samples → daily → weekly order wins on a collision (a crash-replay row
  /// already in `daily/` shows its hot copy). Best-effort.
  pub fn tail_n(&self, n: usize) -> Vec<R> {
    if n == 0 {
      return Vec::new();
    }
    #[derive(Default)]
    struct Week {
      /// date → (samples file, daily file)
      dates: BTreeMap<NaiveDate, (Option<PathBuf>, Option<PathBuf>)>,
      weekly: Option<PathBuf>,
    }
    let mut weeks: BTreeMap<(i32, u32), Week> = BTreeMap::new();
    let week_of = |d: NaiveDate| (d.iso_week().year(), d.iso_week().week());
    for p in list_dir(&self.samples_dir(), "ljson") {
      if let Some(d) = parse_date_stem(&p) {
        weeks.entry(week_of(d)).or_default().dates.entry(d).or_default().0 = Some(p);
      }
    }
    for p in list_dir(&self.daily_dir(), "parquet") {
      if let Some(d) = parse_date_stem(&p) {
        weeks.entry(week_of(d)).or_default().dates.entry(d).or_default().1 = Some(p);
      }
    }
    for p in list_dir(&self.weekly_dir(), "parquet") {
      if let Some(k) = parse_week_stem(&p) {
        weeks.entry(k).or_default().weekly = Some(p);
      }
    }

    let mut by_ts: BTreeMap<String, R> = BTreeMap::new();
    for week in weeks.values().rev() {
      for (samples, daily) in week.dates.values().rev() {
        if let Some(s) = samples {
          add_first(&mut by_ts, read_ljson_tail::<R>(s, n));
        }
        if let Some(d) = daily {
          add_first(&mut by_ts, read_parquet::<R>(d).unwrap_or_default());
        }
        if week.weekly.is_none() && by_ts.len() >= n {
          return finish_tail(by_ts, n);
        }
      }
      if let Some(w) = &week.weekly {
        add_first(&mut by_ts, read_parquet::<R>(w).unwrap_or_default());
      }
      if by_ts.len() >= n {
        return finish_tail(by_ts, n);
      }
    }
    finish_tail(by_ts, n)
  }

  /// A no-rollup snapshot for a node's `check()`.
  pub fn summary(&self) -> StoreSummary<R> {
    let today = Utc::now().date_naive();
    let sample_files = list_dir(&self.samples_dir(), "ljson");
    let latest = self.latest();
    let today_count = sample_files
      .iter()
      .find(|p| parse_date_stem(p) == Some(today))
      .map(|p| count_lines(p))
      .unwrap_or(0);
    let pending_daily = sample_files
      .iter()
      .filter_map(|p| parse_date_stem(p))
      .filter(|d| *d < today)
      .min();

    let daily_files = list_dir(&self.daily_dir(), "parquet");
    let this_week = today.iso_week();
    let pending_weekly = daily_files
      .iter()
      .filter_map(|p| parse_date_stem(p))
      .filter(|d| d.iso_week() < this_week)
      .map(week_label)
      .min();

    StoreSummary {
      latest,
      today_count,
      daily_parquets: daily_files.len(),
      weekly_parquets: list_dir(&self.weekly_dir(), "parquet").len(),
      pending_daily,
      pending_weekly,
    }
  }
}

// ── free helpers ──────────────────────────────────────────────────────────────

fn week_label(date: NaiveDate) -> String {
  date.format("%G-W%V").to_string()
}

/// `2026-W19` → `(2026, 19)`.
fn parse_week_stem(path: &Path) -> Option<(i32, u32)> {
  let (y, w) = path.file_stem()?.to_str()?.split_once("-W")?;
  Some((y.parse().ok()?, w.parse().ok()?))
}

/// Read precedence: hot `samples` first, then `daily`, then `weekly` (the
/// promotion direction), so the first copy seen — the freshest — wins the
/// `ts_key` dedup, and a file moved up a tier mid-read is met again later.
fn tier_rank(p: &Path) -> u8 {
  match p
    .parent()
    .and_then(|d| d.file_name())
    .and_then(|n| n.to_str())
  {
    Some("samples") => 0,
    Some("daily") => 1,
    Some("weekly") => 2,
    _ => 3,
  }
}

fn parse_date_stem(path: &Path) -> Option<NaiveDate> {
  NaiveDate::parse_from_str(path.file_stem()?.to_str()?, "%Y-%m-%d").ok()
}

fn list_dir(dir: &Path, ext: &str) -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = match std::fs::read_dir(dir) {
    Ok(rd) => rd
      .filter_map(Result::ok)
      .map(|e| e.path())
      .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(ext))
      .collect(),
    Err(_) => Vec::new(),
  };
  out.sort();
  out
}

fn count_lines(path: &Path) -> usize {
  use std::io::BufRead;
  match std::fs::File::open(path) {
    Ok(f) => std::io::BufReader::new(f)
      .lines()
      .map_while(Result::ok)
      .filter(|l| !l.trim().is_empty())
      .count(),
    Err(_) => 0,
  }
}

/// True when `f` is non-empty and its last byte is not `\n` (a torn tail).
#[cfg(unix)]
fn ends_without_newline(f: &std::fs::File) -> bool {
  use std::os::unix::fs::FileExt;
  let Ok(len) = f.metadata().map(|m| m.len()) else {
    return false;
  };
  if len == 0 {
    return false;
  }
  let mut last = [0u8; 1];
  matches!(f.read_at(&mut last, len - 1), Ok(1)) && last[0] != b'\n'
}

#[cfg(not(unix))]
fn ends_without_newline(_f: &std::fs::File) -> bool {
  false
}

/// Insert rows keeping the first copy per `ts_key`.
fn add_first<R: SeriesRow>(by_ts: &mut BTreeMap<String, R>, rows: Vec<R>) {
  for r in rows {
    by_ts.entry(r.ts_key()).or_insert(r);
  }
}

/// Merge row sets in precedence order (first copy per `ts_key` wins), sorted by
/// `ts_key` — the one dedup rule compaction and readers share. The in-memory
/// reference the streaming compaction is tested against.
#[cfg(test)]
fn merge_first_wins<R: SeriesRow>(parts: impl IntoIterator<Item = Vec<R>>) -> Vec<R> {
  let mut by_ts: BTreeMap<String, R> = BTreeMap::new();
  for part in parts {
    add_first(&mut by_ts, part);
  }
  by_ts.into_values().collect()
}

/// Drain the deduped `by_ts` map into a final last-N chronological slice.
/// Map iteration is already sorted by `ts_key` (BTreeMap), so we just skip
/// the leading rows whose count exceeds `n`.
fn finish_tail<R>(by_ts: BTreeMap<String, R>, n: usize) -> Vec<R> {
  let total = by_ts.len();
  let skip = total.saturating_sub(n);
  by_ts.into_values().skip(skip).collect()
}

/// Parse at most the last `n` non-empty lines of an ljson file (best-effort:
/// unparseable lines, including a torn tail, are skipped). Reads the whole
/// body but parses only the trailing slice — the `--op logs --lines N` path.
fn read_ljson_tail<R: SeriesRow>(path: &Path, n: usize) -> Vec<R> {
  let Ok(body) = std::fs::read(path) else {
    return Vec::new();
  };
  let lines: Vec<&[u8]> = body
    .split(|b| *b == b'\n')
    .map(|l| l.trim_ascii())
    .filter(|l| !l.is_empty())
    .collect();
  let skip = lines.len().saturating_sub(n);
  lines
    .into_iter()
    .skip(skip)
    .filter_map(|l| serde_json::from_slice(l).ok())
    .collect()
}

/// One fragment's decoded content.
struct Segment<R> {
  rows: Vec<R>,
  /// `"line N: <error>"` for each malformed interior line.
  bad_lines: Vec<String>,
  /// The file ends in an unterminated line that does not parse.
  in_flight_tail: bool,
}

impl<R> Default for Segment<R> {
  fn default() -> Self {
    Segment {
      rows: Vec::new(),
      bad_lines: Vec::new(),
      in_flight_tail: false,
    }
  }
}

/// Why a segment could not be read.
enum SegErr {
  /// Listed, then gone (a concurrent rollup moved it) — worth one re-list.
  Vanished,
  Failed(String),
}

impl std::fmt::Display for SegErr {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SegErr::Vanished => f.write_str("segment vanished"),
      SegErr::Failed(e) => f.write_str(e),
    }
  }
}

fn open_err(path: &Path, e: std::io::Error) -> SegErr {
  if e.kind() == std::io::ErrorKind::NotFound {
    SegErr::Vanished
  } else {
    SegErr::Failed(format!("open {}: {e}", path.display()))
  }
}

/// Read an ljson file line by line: a malformed interior line is recorded and
/// skipped (the rest of the file still reads); an unterminated last line is
/// parsed if it can be, else flagged as in flight.
fn read_ljson_segment<R: SeriesRow>(path: &Path) -> Result<Segment<R>, SegErr> {
  let bytes = std::fs::read(path).map_err(|e| open_err(path, e))?;
  let mut seg = Segment::default();
  let terminated = bytes.last().is_none_or(|b| *b == b'\n');
  let mut lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').collect();
  let tail = if terminated { None } else { lines.pop() };
  for (i, line) in lines.iter().enumerate() {
    let line = line.trim_ascii();
    if line.is_empty() {
      continue;
    }
    match serde_json::from_slice::<R>(line) {
      Ok(r) => seg.rows.push(r),
      Err(e) => seg.bad_lines.push(format!("line {}: {e}", i + 1)),
    }
  }
  if let Some(tail) = tail.map(|t| t.trim_ascii()).filter(|t| !t.is_empty()) {
    match serde_json::from_slice::<R>(tail) {
      Ok(r) => seg.rows.push(r),
      Err(_) => seg.in_flight_tail = true,
    }
  }
  Ok(seg)
}

/// Decode a parquet file; `strict` uses [`SeriesRow::try_from_batch`].
fn read_parquet_segment<R: SeriesRow>(path: &Path, strict: bool) -> Result<Vec<R>, SegErr> {
  let file = std::fs::File::open(path).map_err(|e| open_err(path, e))?;
  let fail = |what: &str, e: &dyn std::fmt::Display| SegErr::Failed(format!("{what}: {e}"));
  let reader = ParquetRecordBatchReaderBuilder::try_new(file)
    .map_err(|e| fail("open parquet", &e))?
    .build()
    .map_err(|e| fail("build reader", &e))?;
  let mut out = Vec::new();
  for batch in reader {
    let batch = batch.map_err(|e| fail("read batch", &e))?;
    if strict {
      out.extend(R::try_from_batch(&batch).map_err(|e| fail("decode", &format!("{e:#}")))?);
    } else {
      out.extend(R::from_batch(&batch));
    }
  }
  Ok(out)
}

/// Best-effort ljson read (malformed lines skipped).
fn read_ljson<R: SeriesRow>(path: &Path) -> Result<Vec<R>> {
  read_ljson_segment(path)
    .map(|s| s.rows)
    .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// Best-effort parquet read ([`SeriesRow::from_batch`]).
fn read_parquet<R: SeriesRow>(path: &Path) -> Result<Vec<R>> {
  read_parquet_segment(path, false).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// Strict parquet read ([`SeriesRow::try_from_batch`]) of a whole file — the
/// tests' view of a compaction output (compaction itself streams).
#[cfg(test)]
fn read_parquet_strict<R: SeriesRow>(path: &Path) -> Result<Vec<R>> {
  read_parquet_segment(path, true).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// The attempt marker guarding `file`: `<file>.attempts` beside it. Readers,
/// the manifest and prune ignore it (its extension is neither `ljson` nor
/// `parquet`).
fn attempts_marker(file: &Path) -> PathBuf {
  let mut name = file.file_name().unwrap_or_default().to_os_string();
  name.push(ATTEMPTS_SUFFIX);
  file.with_file_name(name)
}

/// Unfinished attempts recorded in `marker`; 0 when absent. An unreadable
/// marker counts as one attempt (it exists, so one was started).
fn read_attempts(marker: &Path) -> u32 {
  match std::fs::read_to_string(marker) {
    Ok(s) => s.trim().parse().unwrap_or(1),
    Err(_) => 0,
  }
}

/// Durably record `n` started attempts (atomic replace + fsync of the dir), so
/// the count survives the process being killed right after.
fn write_attempts(marker: &Path, n: u32) -> Result<()> {
  if let Some(dir) = marker.parent() {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
  }
  durable::write_atomic(marker, format!("{n}\n").as_bytes())
    .with_context(|| format!("write {}", marker.display()))
}

/// Remove an attempt marker durably (absent is fine). Callers clear it
/// before unlinking or moving the file it counts.
fn clear_marker(marker: &Path) -> Result<()> {
  match std::fs::remove_file(marker) {
    Ok(()) => {
      if let Some(dir) = marker.parent() {
        durable::fsync_dir(dir).with_context(|| format!("fsync {}", dir.display()))?;
      }
      Ok(())
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e).with_context(|| format!("remove {}", marker.display())),
  }
}

/// `dir/name`, or — when taken — `dir/<stem>.q<n>.<ext>` for the first free
/// `n`, keeping the final extension, so a re-quarantined day stays a
/// `.ljson`/`.parquet` data file and its notes stay `.reason`/`.attempts`.
fn free_name(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
  let first = dir.join(name);
  if !first.exists() {
    return first;
  }
  let name = name.to_string_lossy();
  let (stem, ext) = match name.rsplit_once('.') {
    Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
    _ => (name.to_string(), String::new()),
  };
  (1u32..)
    .map(|n| dir.join(format!("{stem}.q{n}{ext}")))
    .find(|p| !p.exists())
    .unwrap_or(first)
}

/// An exclusive `flock` on a day file — the lock appenders take for each
/// write. Released on drop (explicitly, not on close: see `append_with`).
struct DayFileLock {
  file: std::fs::File,
}

impl DayFileLock {
  fn acquire(path: &Path) -> Result<DayFileLock> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    file
      .lock()
      .with_context(|| format!("lock {}", path.display()))?;
    Ok(DayFileLock { file })
  }
}

impl Drop for DayFileLock {
  fn drop(&mut self) {
    let _ = self.file.unlock();
  }
}

/// `f` is still the file at `path` (same device and inode): not unlinked by a
/// compaction or renamed into quarantine since it was opened.
#[cfg(unix)]
fn is_current_file(f: &std::fs::File, path: &Path) -> bool {
  use std::os::unix::fs::MetadataExt;
  match (f.metadata(), std::fs::metadata(path)) {
    (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
    _ => false,
  }
}

#[cfg(not(unix))]
fn is_current_file(_f: &std::fs::File, path: &Path) -> bool {
  path.exists()
}

/// Deterministic interleavings for the append/maintenance race tests.
#[cfg(test)]
mod test_hooks {
  use std::cell::RefCell;
  use std::path::Path;

  /// Returns whether to run again on the next optimistic append round.
  type Hook = Box<dyn FnMut(&Path) -> bool>;

  thread_local! {
    static BEFORE_APPEND_LOCK: RefCell<Option<Hook>> = RefCell::new(None);
    static CRASH_AT: RefCell<Option<&'static str>> = const { RefCell::new(None) };
  }

  /// Run `hook` once, in this thread, between an append's open and its lock.
  pub(super) fn set_before_append_lock(hook: impl FnOnce(&Path) + 'static) {
    let mut hook = Some(hook);
    set_before_append_lock_while(move |p| {
      if let Some(h) = hook.take() {
        h(p);
      }
      false
    });
  }

  /// Run `hook` between an append's open and its lock on every optimistic
  /// round (never on the maintenance-lock fallback, which a real rival
  /// maintainer could not interleave), for as long as it returns `true`.
  pub(super) fn set_before_append_lock_while(hook: impl FnMut(&Path) -> bool + 'static) {
    BEFORE_APPEND_LOCK.with(|h| *h.borrow_mut() = Some(Box::new(hook)));
  }

  pub(super) fn before_append_lock(path: &Path) {
    let hook = BEFORE_APPEND_LOCK.with(|h| h.borrow_mut().take());
    if let Some(mut hook) = hook
      && hook(path)
    {
      BEFORE_APPEND_LOCK.with(|h| *h.borrow_mut() = Some(hook));
    }
  }

  /// Make the next pass through crash point `name`, in this thread, panic:
  /// a process death at that step (the unwind skips every later step).
  pub(super) fn arm_crash(name: &'static str) {
    CRASH_AT.with(|c| *c.borrow_mut() = Some(name));
  }

  pub(super) fn crash_point(name: &'static str) {
    if CRASH_AT.with(|c| c.borrow().is_some_and(|n| n == name)) {
      CRASH_AT.with(|c| *c.borrow_mut() = None);
      panic!("simulated death at {name}");
    }
  }
}

#[cfg(test)]
mod windowed_tests {
  use super::*;
  use crate::CellRow;
  use chrono::TimeZone;

  fn temp(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("ts-win-{tag}-{}-{n}", std::process::id()))
  }
  fn cell(y: i32, m: u32, d: u32, h: u32, data: &str) -> CellRow {
    CellRow {
      id: format!("c-{y}{m:02}{d:02}{h:02}"),
      ts: Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap(),
      data: data.to_string(),
    }
  }
  fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
  }
  /// `<tier>/<file>`, e.g. `daily/2020-01-07.parquet`.
  fn base(p: &Path) -> String {
    format!(
      "{}/{}",
      p.parent().unwrap().file_name().unwrap().to_string_lossy(),
      p.file_name().unwrap().to_string_lossy()
    )
  }

  #[test]
  fn segments_for_range_selects_only_the_in_range_daily() {
    let dir = temp("sel");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    for d in [6u32, 7, 8] {
      s.append(&cell(2020, 1, d, 12, "x")).unwrap();
    }
    s.rollup_daily().unwrap(); // 2020 days are past → each rolls to daily/<d>.parquet

    let segs = s.segments_for_range(at(2020, 1, 7, 0), at(2020, 1, 7, 23));
    assert_eq!(
      segs.iter().map(|p| base(p)).collect::<Vec<_>>(),
      vec!["daily/2020-01-07.parquet".to_string()],
      "only the 7th's daily — not the 6th/8th, not every file"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn weekly_fallback_when_no_daily() {
    let dir = temp("wk");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // 2020-01-06 (Mon) .. 01-07 — both ISO week 2020-W02.
    s.append(&cell(2020, 1, 6, 12, "a")).unwrap();
    s.append(&cell(2020, 1, 7, 12, "b")).unwrap();
    s.rollup().unwrap(); // daily then weekly → weekly/2020-W02.parquet; dailies pruned

    let segs = s.segments_for_range(at(2020, 1, 6, 0), at(2020, 1, 7, 23));
    assert_eq!(
      segs.iter().map(|p| base(p)).collect::<Vec<_>>(),
      vec!["weekly/2020-W02.parquet".to_string()],
      "no dailies left → fall back to the weekly"
    );
    let rows = s.range_windowed(at(2020, 1, 6, 0), at(2020, 1, 7, 23));
    assert_eq!(rows.len(), 2, "both days read from the weekly");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn latest_falls_back_to_daily_or_weekly_when_samples_is_empty() {
    // After a full rollup samples/ is empty; latest must still return the
    // newest row from the rolled tiers (otherwise a paused-producer fleet
    // host appears "data-less" in `available_extent`).
    let dir = temp("latest-rolled");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell(2020, 1, 6, 12, "a")).unwrap();
    s.append(&cell(2020, 1, 7, 12, "b")).unwrap();
    s.rollup().unwrap(); // weekly/2020-W02.parquet; samples and dailies pruned
    let l = s.latest().expect("rolled rows are still readable");
    assert_eq!(l.data, "b", "newest rolled row wins");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn earliest_returns_none_on_empty_store() {
    let dir = temp("earliest-empty");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    assert!(s.earliest().is_none());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn earliest_picks_oldest_row_across_all_tiers() {
    let dir = temp("earliest-tiers");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // Two days in 2020-W02 → rolled to a weekly. A separate day in 2020-W03
    // stays in daily. A hot row today stays in samples.
    s.append(&cell(2020, 1, 6, 12, "old1")).unwrap();
    s.append(&cell(2020, 1, 7, 12, "old2")).unwrap();
    s.rollup().unwrap(); // weekly/2020-W02.parquet, dailies pruned
    s.append(&cell(2020, 1, 14, 12, "mid")).unwrap();
    s.rollup_daily().unwrap(); // daily/2020-01-14.parquet
    let today = Utc::now();
    s.append(&CellRow {
      id: "hot".into(),
      ts: today,
      data: "hot".into(),
    })
    .unwrap();

    let e = s.earliest().expect("at least one row");
    assert_eq!(e.data, "old1", "oldest row wins, regardless of tier");
    assert_eq!(e.ts, at(2020, 1, 6, 12));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn earliest_falls_to_samples_when_no_rollups_exist() {
    let dir = temp("earliest-samples");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let t0 = Utc::now() - chrono::Duration::seconds(30);
    let t1 = Utc::now();
    s.append(&CellRow {
      id: "a".into(),
      ts: t0,
      data: "a".into(),
    })
    .unwrap();
    s.append(&CellRow {
      id: "b".into(),
      ts: t1,
      data: "b".into(),
    })
    .unwrap();
    // No rollup ran — both rows live in samples/<today>.ljson.
    let e = s.earliest().expect("at least one row");
    assert_eq!(e.ts, t0, "earliest sample is the first appended row");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// `tail_n` returns up to N most-recent rows in chronological order,
  /// without reading older files when today's ljson alone satisfies the
  /// request. This is the load-bearing path for `--op logs --lines N`.
  #[test]
  fn tail_n_returns_last_n_chronological_from_samples() {
    let dir = temp("tail-samples");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // Five rows on today's date so they all land in one samples ljson.
    for h in 0..5 {
      s.append(&cell(2020, 1, 1, h, &format!("r{h}"))).unwrap();
    }
    let last3 = s.tail_n(3);
    assert_eq!(
      last3.iter().map(|r| r.data.as_str()).collect::<Vec<_>>(),
      vec!["r2", "r3", "r4"],
      "last 3 in chronological order"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// When `n` exceeds today's file, `tail_n` walks back through older
  /// samples then older daily parquet. Stops as soon as accumulated rows
  /// ≥ `n` so a deep history isn't fully reread.
  #[test]
  fn tail_n_spans_tiers_when_today_is_short() {
    let dir = temp("tail-tiers");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // Day -2: rolled to daily/.
    s.append(&cell(2020, 1, 5, 12, "old-a")).unwrap();
    s.append(&cell(2020, 1, 5, 13, "old-b")).unwrap();
    s.rollup_daily().unwrap();
    // Day -1: rolled to daily/.
    s.append(&cell(2020, 1, 6, 12, "mid-a")).unwrap();
    s.rollup_daily().unwrap();
    // Today: one hot sample.
    s.append(&cell(2020, 1, 7, 12, "today-a")).unwrap();

    let last3 = s.tail_n(3);
    let names: Vec<&str> = last3.iter().map(|r| r.data.as_str()).collect();
    assert_eq!(
      names,
      vec!["old-b", "mid-a", "today-a"],
      "spans samples + daily"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Edge: `n == 0` is a no-op (don't allocate, don't read).
  #[test]
  fn tail_n_zero_returns_empty() {
    let dir = temp("tail-zero");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell(2020, 1, 1, 12, "x")).unwrap();
    assert!(s.tail_n(0).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// `tail_n` honors the same tier-precedence dedup contract as
  /// [`range`]: the newer-tier copy wins on a `ts_key` collision
  /// (crash-replay can leave an ljson row whose key already exists in
  /// daily/, and the resolver/operator must see the hot copy).
  #[test]
  fn tail_n_dedups_samples_over_daily_on_collision() {
    let dir = temp("tail-dedup");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // Old row rolled to daily/.
    s.append(&cell(2020, 1, 1, 12, "rolled")).unwrap();
    s.rollup_daily().unwrap();
    // Same ts re-emitted onto today's samples (simulated crash-replay).
    s.append(&cell(2020, 1, 1, 12, "hot")).unwrap();
    let rows = s.tail_n(5);
    assert_eq!(rows.len(), 1, "one row for the collision (dedup)");
    assert_eq!(rows[0].data, "hot", "hot samples win the precedence");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn range_windowed_dedups_samples_over_daily_and_bounds_window() {
    let dir = temp("dedup");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell(2020, 2, 10, 12, "old")).unwrap();
    s.rollup_daily().unwrap(); // daily/2020-02-10 holds "old"; samples pruned
    s.append(&cell(2020, 2, 10, 12, "new")).unwrap(); // same ts → samples/2020-02-10 holds "new"
    s.append(&cell(2020, 2, 11, 12, "other")).unwrap(); // out of the window below

    let rows = s.range_windowed(at(2020, 2, 10, 0), at(2020, 2, 10, 23));
    assert_eq!(
      rows.len(),
      1,
      "one row for the day (dedup), the 11th excluded"
    );
    assert_eq!(rows[0].data, "new", "hot samples win over the rolled daily");
    let _ = std::fs::remove_dir_all(&dir);
  }
}

#[cfg(test)]
mod contract_tests {
  use super::*;
  use crate::{CellRow, CheckRow};
  use chrono::TimeZone;

  fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
      "ts-contract-{tag}-{}",
      durable::unique_tmp(Path::new("x")).display()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
  }
  fn cell(id: &str, ts: DateTime<Utc>) -> CellRow {
    CellRow {
      id: id.to_string(),
      ts,
      data: format!("{{\"id\":\"{id}\"}}"),
    }
  }
  fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
  }
  fn line(r: &CellRow) -> String {
    serde_json::to_string(r).unwrap()
  }
  fn day(y: i32, m: u32, d: u32) -> (DateTime<Utc>, DateTime<Utc>) {
    (at(y, m, d, 0), Utc.with_ymd_and_hms(y, m, d, 23, 59, 59).unwrap())
  }
  fn ids(rows: &[CellRow]) -> Vec<&str> {
    rows.iter().map(|r| r.id.as_str()).collect()
  }

  #[test]
  fn torn_tail_is_in_flight_not_a_failure() {
    let dir = temp("tail");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell("a", at(2020, 3, 2, 1))).unwrap();
    let path = dir.join("samples/2020-03-02.ljson");
    let mut body = std::fs::read(&path).unwrap();
    body.extend_from_slice(br#"{"id":"b","ts":"2020-"#);
    std::fs::write(&path, body).unwrap();

    let (f, t) = day(2020, 3, 2);
    let cov = s.range_strict(f, t).unwrap();
    assert!(cov.complete, "{:?}", cov.failed);
    assert!(cov.in_flight_tail);
    assert_eq!(ids(&cov.rows), vec!["a"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn torn_line_mid_file_is_recorded_and_the_rest_still_reads() {
    let dir = temp("mid");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    std::fs::create_dir_all(dir.join("samples")).unwrap();
    let body = format!(
      "{}\n{{\"id\":\"x\",\"ts\n{}\n",
      line(&cell("a", at(2020, 3, 2, 1))),
      line(&cell("c", at(2020, 3, 2, 3)))
    );
    std::fs::write(dir.join("samples/2020-03-02.ljson"), body).unwrap();

    let (f, t) = day(2020, 3, 2);
    let cov = s.range_strict(f, t).unwrap();
    assert!(!cov.complete);
    assert!(!cov.in_flight_tail);
    assert_eq!(cov.failed.len(), 1);
    assert!(cov.failed[0].1.starts_with("line 2:"), "{:?}", cov.failed);
    assert_eq!(ids(&cov.rows), vec!["a", "c"], "the file is not dropped whole");
    assert_eq!(ids(&s.range_windowed(f, t)), vec!["a", "c"], "best-effort agrees");
    assert_eq!(ids(&s.range(f, t)), vec!["a", "c"]);

    // Rollup refuses to compact (and delete) a day with a malformed line.
    assert!(s.rollup().is_err());
    assert!(dir.join("samples/2020-03-02.ljson").exists());
    assert!(!dir.join("daily/2020-03-02.parquet").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn append_repairs_a_torn_tail_for_the_next_line() {
    let dir = temp("repair");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    std::fs::create_dir_all(dir.join("samples")).unwrap();
    let path = dir.join("samples/2020-03-02.ljson");
    std::fs::write(&path, br#"{"id":"torn","ts":"20"#).unwrap();
    s.append(&cell("next", at(2020, 3, 2, 5))).unwrap();
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains("\"20\n{"), "newline inserted before the row: {body:?}");

    let (f, t) = day(2020, 3, 2);
    let cov = s.range_strict(f, t).unwrap();
    assert_eq!(ids(&cov.rows), vec!["next"], "the new row survives");
    assert_eq!(cov.failed.len(), 1, "the torn fragment is one bad line");
    assert!(!cov.in_flight_tail);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_bad_day_is_held_and_later_days_still_roll() {
    let dir = temp("isolate");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell("good-before", at(2020, 3, 1, 1))).unwrap();
    s.append(&cell("good-after", at(2020, 3, 3, 1))).unwrap();
    std::fs::write(dir.join("samples/2020-03-02.ljson"), b"not json\n").unwrap();

    let report = s.rollup_report().unwrap();
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].0.ends_with("samples/2020-03-02.ljson"));
    assert_eq!(report.daily.len(), 2, "the other days still roll: {report:?}");
    assert!(dir.join("samples/2020-03-02.ljson").exists(), "bad source kept");
    let err = s.rollup_daily().unwrap_err().to_string();
    assert!(err.contains("2020-03-02"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn late_rows_merge_into_an_existing_daily() {
    let dir = temp("late-daily");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell("orig", at(2020, 3, 4, 1))).unwrap();
    assert_eq!(s.rollup_daily().unwrap().len(), 1);
    s.append(&cell("late", at(2020, 3, 4, 2))).unwrap();
    assert_eq!(s.rollup_daily().unwrap().len(), 1, "the late day is re-rolled");
    assert!(!dir.join("samples/2020-03-04.ljson").exists());
    let daily = read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-04.parquet")).unwrap();
    assert_eq!(ids(&daily), vec!["orig", "late"], "merged, not overwritten");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn late_rows_after_the_weekly_are_read_and_then_merged() {
    let dir = temp("late-weekly");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    // 2020-03-02 (Mon) and 03-03 — ISO week 2020-W10.
    s.append(&cell("mon", at(2020, 3, 2, 1))).unwrap();
    s.append(&cell("tue", at(2020, 3, 3, 1))).unwrap();
    s.rollup().unwrap();
    assert!(dir.join("weekly/2020-W10.parquet").exists());

    // A late Monday row, rolled to a daily only: the windowed read must still
    // include the weekly (the original Monday row lives there).
    s.append(&cell("mon-late", at(2020, 3, 2, 2))).unwrap();
    s.rollup_daily().unwrap();
    let (f, t) = day(2020, 3, 2);
    let segs: Vec<String> = s
      .segments_for_range(f, t)
      .iter()
      .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
      .collect();
    assert_eq!(segs, vec!["2020-03-02.parquet", "2020-W10.parquet"]);
    assert_eq!(ids(&s.range_windowed(f, t)), vec!["mon", "mon-late"]);

    // The weekly rollup merges the late daily into the existing weekly.
    assert_eq!(s.rollup_weekly().unwrap(), vec!["2020-W10".to_string()]);
    assert!(!dir.join("daily/2020-03-02.parquet").exists());
    let weekly = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();
    assert_eq!(ids(&weekly), vec!["mon", "mon-late", "tue"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn parquet_schema_mismatch_is_a_failed_segment() {
    let dir = temp("schema");
    let wrong = TimeSeriesStore::<CheckRow>::new(&dir);
    wrong
      .append(&CheckRow {
        ts: at(2020, 3, 2, 1),
        seq: 0,
        field: "f".into(),
        status: "ok".into(),
        detail: "d".into(),
        checked_at: at(2020, 3, 2, 1),
      })
      .unwrap();
    wrong.rollup_daily().unwrap();

    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let (f, t) = day(2020, 3, 2);
    let cov = s.range_strict(f, t).unwrap();
    assert!(!cov.complete);
    assert!(cov.failed[0].1.contains("schema mismatch"), "{:?}", cov.failed);
    assert!(s.range_windowed(f, t).is_empty(), "best-effort just skips it");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn try_from_batch_rejects_the_wrong_shape() {
    let check = CheckRow {
      ts: at(2020, 3, 2, 1),
      seq: 0,
      field: "f".into(),
      status: "ok".into(),
      detail: "d".into(),
      checked_at: at(2020, 3, 2, 1),
    };
    let batch = CheckRow::to_batch(&[check]).unwrap();
    assert!(CellRow::from_batch(&batch).is_empty());
    assert!(CellRow::try_from_batch(&batch).is_err());
    let ok = CellRow::to_batch(&[cell("a", at(2020, 3, 2, 1))]).unwrap();
    assert_eq!(CellRow::try_from_batch(&ok).unwrap().len(), 1);
  }

  #[test]
  fn full_precision_timestamps_survive_compaction() {
    let dir = temp("precision");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let ts = Utc.with_ymd_and_hms(2020, 3, 2, 1, 2, 3).unwrap() + chrono::Duration::nanoseconds(123_456_789);
    s.append(&cell("p", ts)).unwrap();
    s.rollup_daily().unwrap();
    let back = s.range(ts, ts);
    assert_eq!(back.len(), 1, "a sub-ms bound still matches after compaction");
    assert_eq!(back[0].ts, ts);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn append_synced_writes_a_durable_line() {
    let dir = temp("synced");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append_synced(&cell("a", at(2020, 3, 2, 1))).unwrap();
    s.append_with(&cell("b", at(2020, 3, 2, 2)), AppendOptions { durable: true })
      .unwrap();
    let (f, t) = day(2020, 3, 2);
    assert_eq!(ids(&s.range(f, t)), vec!["a", "b"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn concurrent_rollups_serialize_on_the_maintenance_lock() {
    let dir = temp("concurrent");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    for d in 1..=20u32 {
      for h in 0..5u32 {
        s.append(&cell(&format!("{d}-{h}"), at(2020, 1, d, h))).unwrap();
      }
    }
    let handles: Vec<_> = (0..4)
      .map(|_| {
        let dir = dir.clone();
        std::thread::spawn(move || TimeSeriesStore::<CellRow>::new(&dir).rollup())
      })
      .collect();
    for h in handles {
      h.join().unwrap().unwrap();
    }
    let all = s.range(at(2019, 12, 1, 0), at(2020, 2, 1, 0));
    assert_eq!(all.len(), 100, "no row lost or duplicated");
    let leftovers: Vec<_> = ["samples", "daily", "weekly"]
      .iter()
      .flat_map(|t| std::fs::read_dir(dir.join(t)).into_iter().flatten().flatten())
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .filter(|n| n.ends_with(".tmp"))
      .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn rollup_waits_for_a_held_maintenance_lock() {
    let dir = temp("blocked");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell("a", at(2020, 3, 2, 1))).unwrap();
    let held = tento_buckets::maintenance_lock_at(&dir).unwrap();
    let d2 = dir.clone();
    let worker = std::thread::spawn(move || TimeSeriesStore::<CellRow>::new(&d2).rollup_daily());
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(dir.join("samples/2020-03-02.ljson").exists(), "rollup is blocked");
    drop(held);
    assert_eq!(worker.join().unwrap().unwrap().len(), 1);
    assert!(dir.join("daily/2020-03-02.parquet").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn tail_n_walks_dates_newest_first_across_tiers() {
    let dir = temp("tail-order");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&cell("new-1", at(2020, 1, 10, 1))).unwrap();
    s.append(&cell("new-2", at(2020, 1, 10, 2))).unwrap();
    s.rollup_daily().unwrap(); // daily/2020-01-10
    // A stranded, older samples file (e.g. a mirror that never deletes).
    s.append(&cell("old-1", at(2020, 1, 1, 1))).unwrap();
    s.append(&cell("old-2", at(2020, 1, 1, 2))).unwrap();
    assert_eq!(ids(&s.tail_n(2)), vec!["new-1", "new-2"]);
    assert_eq!(ids(&s.tail_n(3)), vec!["old-2", "new-1", "new-2"]);
    let _ = std::fs::remove_dir_all(&dir);
  }
}

#[cfg(test)]
mod compaction_tests {
  //! The streaming compaction against the in-memory reference
  //! ([`merge_first_wins`]): same rows, same order, same holds — with tiny
  //! limits so every path crosses many runs and cascade merges.
  use super::*;
  use crate::CellRow;
  use chrono::TimeZone;

  fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
      "ts-compact-{tag}-{}",
      durable::unique_tmp(Path::new("x")).display()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
  }
  fn tiny() -> CompactionLimits {
    CompactionLimits {
      chunk_rows: 7,
      chunk_bytes: 1 << 20,
      fan_in: 3,
      batch_rows: 5,
      row_group_rows: 11,
      row_group_bytes: 1 << 20,
      ..CompactionLimits::default()
    }
  }
  /// Deterministic pseudo-random stream (no dev-dependency needed).
  struct Lcg(u64);
  impl Lcg {
    fn next(&mut self, n: u64) -> u64 {
      self.0 = self
        .0
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
      (self.0 >> 33) % n
    }
  }
  /// A row on 2020-03-02 whose key collides with others when `slot` repeats.
  fn row(slot: u64, tag: &str) -> CellRow {
    CellRow {
      id: format!("id-{}", slot % 5),
      ts: Utc.with_ymd_and_hms(2020, 3, 2, 0, 0, 0).unwrap()
        + chrono::Duration::seconds((slot / 5) as i64),
      data: format!("{{\"tag\":\"{tag}\",\"slot\":{slot}}}"),
    }
  }
  fn write_ljson(path: &Path, rows: &[CellRow]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body: String = rows
      .iter()
      .map(|r| serde_json::to_string(r).unwrap() + "\n")
      .collect();
    std::fs::write(path, body).unwrap();
  }
  fn data(rows: &[CellRow]) -> Vec<String> {
    rows
      .iter()
      .map(|r| format!("{}={}", r.ts_key(), r.data))
      .collect()
  }
  fn leftovers(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
      for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with(WORK_DIR_PREFIX) || n.ends_with(".tmp") || n.ends_with(ATTEMPTS_SUFFIX) {
          out.push(e.path().display().to_string());
        }
        if e.file_type().unwrap().is_dir() {
          stack.push(e.path());
        }
      }
    }
    out
  }

  /// Source duplicates, source-vs-existing duplicates (the source copy wins),
  /// many runs and cascade passes: identical to the in-memory reference.
  #[test]
  fn day_matches_the_in_memory_reference_across_many_runs() {
    for (seed, limits) in [
      (1u64, tiny()),
      (2, tiny()),
      (3, CompactionLimits::default()),
    ] {
      let dir = temp("equiv");
      let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
      let mut rng = Lcg(seed);
      let existing: Vec<CellRow> = (0..150).map(|_| row(rng.next(400), "old")).collect();
      let source: Vec<CellRow> = (0..300)
        .map(|i| row(rng.next(400), &format!("new{i}")))
        .collect();
      // An existing daily, written by the same compaction from its own day.
      write_ljson(&dir.join("samples/2020-03-02.ljson"), &existing);
      assert_eq!(s.rollup_daily().unwrap().len(), 1);
      let existing_daily =
        read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-02.parquet")).unwrap();
      assert_eq!(
        data(&existing_daily),
        data(&merge_first_wins([existing.clone()]))
      );

      write_ljson(&dir.join("samples/2020-03-02.ljson"), &source);
      assert_eq!(s.rollup_daily().unwrap().len(), 1);
      let got = read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-02.parquet")).unwrap();
      let want = merge_first_wins([source.clone(), existing_daily]);
      assert_eq!(data(&got), data(&want), "seed {seed}");
      assert!(
        got.iter().any(|r| r.data.contains("new")) && got.iter().any(|r| r.data.contains("old"))
      );
      assert!(!dir.join("samples/2020-03-02.ljson").exists());
      assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
      let _ = std::fs::remove_dir_all(&dir);
    }
  }

  /// A week: several dailies (earlier date wins a tie) plus an existing
  /// weekly (lowest precedence), through many runs.
  #[test]
  fn week_matches_the_in_memory_reference_across_many_runs() {
    let dir = temp("week");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(tiny());
    let mut rng = Lcg(9);
    let mk = |rng: &mut Lcg, d: u32, tag: &str, n: usize| -> Vec<CellRow> {
      (0..n)
        .map(|i| CellRow {
          id: format!("id-{}", rng.next(3)),
          ts: Utc.with_ymd_and_hms(2020, 3, d, 0, 0, 0).unwrap()
            + chrono::Duration::seconds(rng.next(40) as i64),
          data: format!("{tag}-{i}"),
        })
        .collect()
    };
    // Week 2020-W10 = Mon 03-02 .. Sun 03-08. First an existing weekly.
    let old_mon = mk(&mut rng, 2, "weekly", 60);
    write_ljson(&dir.join("samples/2020-03-02.ljson"), &old_mon);
    s.rollup().unwrap();
    let weekly = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();

    let mut dailies = Vec::new();
    for d in 2..=8u32 {
      let rows = mk(&mut rng, d, &format!("d{d}"), 40);
      write_ljson(&dir.join(format!("samples/2020-03-{d:02}.ljson")), &rows);
      dailies.push(rows);
    }
    assert_eq!(s.rollup_daily().unwrap().len(), 7);
    let daily_rows: Vec<Vec<CellRow>> = (2..=8u32)
      .map(|d| {
        read_parquet_strict::<CellRow>(&dir.join(format!("daily/2020-03-{d:02}.parquet"))).unwrap()
      })
      .collect();
    assert_eq!(s.rollup_weekly().unwrap(), vec!["2020-W10".to_string()]);
    let got = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();
    let mut parts = daily_rows;
    parts.push(weekly);
    assert_eq!(data(&got), data(&merge_first_wins(parts)));
    assert!(list_dir(&dir.join("daily"), "parquet").is_empty());
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Malformed interior lines hold the day (counted, first reported) even
  /// after rows were already spilled to runs; nothing is written or left.
  #[test]
  fn malformed_line_holds_the_day_after_spilling() {
    let dir = temp("bad");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(tiny());
    let rows: Vec<CellRow> = (0..50).map(|i| row(i, "x")).collect();
    let mut body: String = rows
      .iter()
      .map(|r| serde_json::to_string(r).unwrap() + "\n")
      .collect();
    body.push_str("{\"id\":\"torn\n\nnot json\n");
    body.push_str(&(serde_json::to_string(&row(99, "after")).unwrap() + "\n"));
    let src = dir.join("samples/2020-03-02.ljson");
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(&src, &body).unwrap();

    let report = s.rollup_report().unwrap();
    assert_eq!(report.failed.len(), 1, "{report:?}");
    let err = &report.failed[0].1;
    assert!(
      err.contains("2 malformed line(s), first: line 51:"),
      "{err}"
    );
    assert_eq!(
      std::fs::read_to_string(&src).unwrap(),
      body,
      "source untouched"
    );
    assert!(!dir.join("daily/2020-03-02.parquet").exists());
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    // An ordinary failure is not a crash: it never counts toward quarantine.
    for _ in 0..(MAX_UNFINISHED_ATTEMPTS + 2) {
      assert_eq!(s.rollup_report().unwrap().failed.len(), 1);
    }
    assert!(s.quarantined().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// An unterminated unparseable tail fails a completed day; an unterminated
  /// tail that parses is a row (as the readers treat it).
  #[test]
  fn unterminated_tail_rules_match_the_reader() {
    let dir = temp("tail");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(tiny());
    let rows: Vec<CellRow> = (0..20).map(|i| row(i, "x")).collect();
    let src = dir.join("samples/2020-03-02.ljson");
    write_ljson(&src, &rows);
    let mut torn = std::fs::read(&src).unwrap();
    torn.extend_from_slice(br#"{"id":"b","ts":"2020-"#);
    std::fs::write(&src, &torn).unwrap();
    let err = s.rollup_daily().unwrap_err().to_string();
    assert!(err.contains("unterminated unparseable last line"), "{err}");
    assert!(src.exists() && !dir.join("daily/2020-03-02.parquet").exists());

    let mut whole: Vec<u8> = rows
      .iter()
      .flat_map(|r| serde_json::to_vec(r).unwrap().into_iter().chain(*b"\n"))
      .collect();
    whole.extend_from_slice(serde_json::to_string(&row(77, "tail")).unwrap().as_bytes());
    std::fs::write(&src, &whole).unwrap();
    assert_eq!(s.rollup_daily().unwrap().len(), 1);
    let got = read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-02.parquet")).unwrap();
    let mut all = rows.clone();
    all.push(row(77, "tail"));
    assert_eq!(data(&got), data(&merge_first_wins([all])));
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A source with no rows (blank lines only) is removed; no daily appears.
  #[test]
  fn empty_source_is_dropped_without_a_daily() {
    let dir = temp("empty");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let src = dir.join("samples/2020-03-02.ljson");
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(&src, b"\n  \n").unwrap();
    assert!(s.rollup_daily().unwrap().is_empty());
    assert!(!src.exists());
    assert!(!dir.join("daily/2020-03-02.parquet").exists());
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// K killed attempts (the marker a dead process leaves) quarantine the
  /// source byte for byte; the other days still roll and the next rollup is
  /// clean. Fewer than K are retried, and a success clears the marker.
  #[test]
  fn killed_attempts_quarantine_the_source_and_the_rest_rolls() {
    let dir = temp("quarantine");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let cell = |d: u32, id: &str| CellRow {
      id: id.into(),
      ts: Utc.with_ymd_and_hms(2020, 3, d, 1, 0, 0).unwrap(),
      data: "{}".into(),
    };
    for d in [1u32, 2, 3, 4] {
      s.append(&cell(d, "a")).unwrap();
    }
    let bad = dir.join("samples/2020-03-02.ljson");
    let retried = dir.join("samples/2020-03-03.ljson");
    let bad_bytes = std::fs::read(&bad).unwrap();
    // What a process killed mid-compaction leaves: the marker it wrote first.
    for _ in 0..MAX_UNFINISHED_ATTEMPTS {
      let n = read_attempts(&attempts_marker(&bad));
      write_attempts(&attempts_marker(&bad), n + 1).unwrap();
    }
    write_attempts(&attempts_marker(&retried), MAX_UNFINISHED_ATTEMPTS - 1).unwrap();

    let report = s.rollup_report().unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    assert_eq!(report.quarantined.len(), 1, "{report:?}");
    assert_eq!(report.quarantined[0].0, bad);
    assert!(
      report.quarantined[0].1.contains("3 compaction attempt(s)"),
      "{report:?}"
    );
    assert!(!report.is_clean());
    // 03-01, 03-04 and the retried 03-03 (two prior deaths) roll this time.
    assert_eq!(report.daily.len(), 3, "{report:?}");
    assert!(!bad.exists());
    let q = dir.join("quarantine/samples/2020-03-02.ljson");
    assert_eq!(std::fs::read(&q).unwrap(), bad_bytes, "kept byte for byte");
    assert!(
      dir
        .join("quarantine/samples/2020-03-02.ljson.reason")
        .exists()
    );
    assert!(
      dir
        .join("quarantine/samples/2020-03-02.ljson.attempts")
        .exists()
    );
    assert_eq!(s.quarantined(), vec![q.clone()]);
    assert!(
      !attempts_marker(&retried).exists(),
      "a success clears the marker"
    );

    // The next rollup reports clean; quarantined rows are not served.
    s.rollup().unwrap();
    let day2 = s.range(
      Utc.with_ymd_and_hms(2020, 3, 2, 0, 0, 0).unwrap(),
      Utc.with_ymd_and_hms(2020, 3, 2, 23, 0, 0).unwrap(),
    );
    assert!(day2.is_empty());
    assert_eq!(
      s.range(
        Utc.with_ymd_and_hms(2020, 3, 1, 0, 0, 0).unwrap(),
        Utc.with_ymd_and_hms(2020, 3, 5, 0, 0, 0).unwrap()
      )
      .len(),
      3
    );

    // Restoring it (move back, drop the marker) rolls it normally.
    std::fs::rename(&q, &bad).unwrap();
    std::fs::remove_file(dir.join("quarantine/samples/2020-03-02.ljson.attempts")).unwrap();
    s.rollup().unwrap();
    assert_eq!(
      s.range(
        Utc.with_ymd_and_hms(2020, 3, 1, 0, 0, 0).unwrap(),
        Utc.with_ymd_and_hms(2020, 3, 5, 0, 0, 0).unwrap()
      )
      .len(),
      4
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A week whose compaction keeps dying moves its dailies to
  /// `quarantine/daily/`; other weeks still roll.
  #[test]
  fn killed_weekly_attempts_quarantine_the_dailies() {
    let dir = temp("quarantine-week");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    for d in [2u32, 3, 9] {
      s.append(&CellRow {
        id: "a".into(),
        ts: Utc.with_ymd_and_hms(2020, 3, d, 1, 0, 0).unwrap(),
        data: "{}".into(),
      })
      .unwrap();
    }
    s.rollup_daily().unwrap();
    write_attempts(
      &attempts_marker(&dir.join("weekly/2020-W10.parquet")),
      MAX_UNFINISHED_ATTEMPTS,
    )
    .unwrap();
    let report = s.rollup_report().unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    assert_eq!(report.weekly, vec!["2020-W11".to_string()]);
    assert_eq!(report.quarantined.len(), 1);
    assert_eq!(
      s.quarantined()
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>(),
      vec!["2020-03-02.parquet", "2020-03-03.parquet"]
    );
    assert!(dir.join("quarantine/daily/2020-W10.reason").exists());
    assert!(!dir.join("weekly/2020-W10.parquet").exists());
    s.rollup().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A killed compaction's run dir, parquet tmps and orphan markers are
  /// cleared by the next rollup (under the maintenance lock).
  #[test]
  fn stale_leftovers_are_cleared_under_the_lock() {
    let dir = temp("stale");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    std::fs::create_dir_all(dir.join(".compact-123.456/")).unwrap();
    std::fs::write(dir.join(".compact-123.456/run-000001"), b"x").unwrap();
    std::fs::create_dir_all(dir.join("daily")).unwrap();
    std::fs::write(dir.join("daily/2026-09-28.parquet.tmp"), b"").unwrap();
    std::fs::write(dir.join("daily/2026-09-28.parquet.9.9.tmp"), b"").unwrap();
    std::fs::create_dir_all(dir.join("samples")).unwrap();
    std::fs::write(dir.join("samples/2020-01-01.ljson.attempts"), b"2\n").unwrap();
    std::fs::write(dir.join("samples/keep.txt"), b"x").unwrap();
    s.rollup().unwrap();
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    assert!(
      dir.join("samples/keep.txt").exists(),
      "unrelated files untouched"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  fn day2(id: &str, h: u32) -> CellRow {
    CellRow {
      id: id.into(),
      ts: Utc.with_ymd_and_hms(2020, 3, 2, h, 0, 0).unwrap(),
      data: "{}".into(),
    }
  }
  fn ids_of(rows: &[CellRow]) -> Vec<String> {
    rows.iter().map(|r| r.id.clone()).collect()
  }
  fn whole_day() -> (DateTime<Utc>, DateTime<Utc>) {
    (
      Utc.with_ymd_and_hms(2020, 3, 2, 0, 0, 0).unwrap(),
      Utc.with_ymd_and_hms(2020, 3, 2, 23, 59, 59).unwrap(),
    )
  }

  /// An appender that opened the day file before a quarantine moved it, and
  /// gets the lock only afterwards, must not write into the quarantined
  /// inode: it reopens the path, and its row stays served and rolls.
  #[test]
  fn append_racing_quarantine_reopens_the_day_file() {
    let dir = temp("race-quarantine");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("before", 1)).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    let original = std::fs::read(&src).unwrap();
    write_attempts(&attempts_marker(&src), MAX_UNFINISHED_ATTEMPTS).unwrap();

    let d = dir.clone();
    test_hooks::set_before_append_lock(move |_| {
      let report = TimeSeriesStore::<CellRow>::new(&d).rollup_report().unwrap();
      assert_eq!(report.quarantined.len(), 1, "{report:?}");
    });
    s.append(&day2("racing", 2)).unwrap();

    let q = dir.join("quarantine/samples/2020-03-02.ljson");
    assert_eq!(
      std::fs::read(&q).unwrap(),
      original,
      "quarantined bytes untouched"
    );
    let (f, t) = whole_day();
    assert_eq!(
      ids_of(&s.range(f, t)),
      vec!["racing"],
      "the racing row is served"
    );
    s.rollup().unwrap();
    assert_eq!(ids_of(&s.range(f, t)), vec!["racing"], "and rolls");
    assert!(
      dir.join("weekly/2020-W10.parquet").exists(),
      "rolled through to the weekly"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// The same race against a compaction's unlink: the late row reopens a
  /// fresh day file instead of vanishing into the unlinked inode, and the
  /// next rollup merges it into the daily.
  #[test]
  fn append_racing_compaction_is_not_lost() {
    let dir = temp("race-compact");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("first", 1)).unwrap();
    let d = dir.clone();
    test_hooks::set_before_append_lock(move |_| {
      let rolled = TimeSeriesStore::<CellRow>::new(&d).rollup_daily().unwrap();
      assert_eq!(rolled.len(), 1);
    });
    s.append(&day2("late", 2)).unwrap();
    assert!(
      dir.join("samples/2020-03-02.ljson").exists(),
      "late row reopened the path"
    );
    let (f, t) = whole_day();
    assert_eq!(ids_of(&s.range(f, t)), vec!["first", "late"]);
    s.rollup_daily().unwrap();
    let daily = read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-02.parquet")).unwrap();
    assert_eq!(ids_of(&daily), vec!["first", "late"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Killed after the last daily of a week was unlinked, before the weekly
  /// marker was cleared: a later backfill of that week is compacted, not
  /// quarantined on the dead generation's count.
  #[test]
  fn weekly_marker_without_dailies_does_not_charge_a_backfill() {
    let dir = temp("week-orphan");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("mon", 1)).unwrap();
    s.rollup().unwrap();
    assert!(dir.join("weekly/2020-W10.parquet").exists());
    // The state the dead process left: no W10 dailies, a full marker.
    let marker = attempts_marker(&dir.join("weekly/2020-W10.parquet"));
    write_attempts(&marker, MAX_UNFINISHED_ATTEMPTS).unwrap();

    s.append(&CellRow {
      id: "tue-backfill".into(),
      ts: Utc.with_ymd_and_hms(2020, 3, 3, 1, 0, 0).unwrap(),
      data: "{}".into(),
    })
    .unwrap();
    let report = s.rollup_report().unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert_eq!(report.weekly, vec!["2020-W10".to_string()]);
    assert!(!marker.exists());
    let weekly = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();
    assert_eq!(ids_of(&weekly), vec!["mon", "tue-backfill"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A day quarantined twice keeps two data files with data extensions; the
  /// second generation's notes are not listed as data.
  #[test]
  fn repeated_quarantine_keeps_notes_out_of_the_data_listing() {
    let dir = temp("requarantine");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    let src = dir.join("samples/2020-03-02.ljson");
    for gen_id in ["gen-1", "gen-2"] {
      s.append(&day2(gen_id, 1)).unwrap();
      write_attempts(&attempts_marker(&src), MAX_UNFINISHED_ATTEMPTS).unwrap();
      assert_eq!(s.rollup_report().unwrap().quarantined.len(), 1);
    }
    let names: Vec<String> = s
      .quarantined()
      .iter()
      .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
      .collect();
    assert_eq!(names, vec!["2020-03-02.ljson", "2020-03-02.q1.ljson"]);
    for note in ["2020-03-02.ljson.q1.reason", "2020-03-02.ljson.q1.attempts"] {
      assert!(dir.join("quarantine/samples").join(note).exists(), "{note}");
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Rows longer than `max_row_bytes` are dropped (TBC-D6, operator
  /// 2026-10-27) — interior or unterminated tail — without being buffered;
  /// the rest of the day compacts, its source is removed and the report
  /// counts the drops. A malformed line beside an oversized one still holds
  /// the day. A valid oversized row in an existing parquet still fails.
  #[test]
  fn oversized_rows_are_dropped_and_the_day_compacts() {
    let limits = CompactionLimits {
      max_row_bytes: 256,
      ..tiny()
    };
    let big = CellRow {
      id: "big".into(),
      ts: Utc.with_ymd_and_hms(2020, 3, 2, 3, 0, 0).unwrap(),
      data: "x".repeat(1000),
    };

    let dir = temp("oversized");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
    s.append(&day2("ok", 1)).unwrap();
    s.append(&big).unwrap(); // a valid row, over the limit
    s.append(&day2("ok2", 2)).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    let report = s.rollup_report().unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert_eq!(
      report.daily,
      vec![NaiveDate::from_ymd_opt(2020, 3, 2).unwrap()]
    );
    assert_eq!(report.dropped_oversized, vec![(src.clone(), 1)]);
    assert!(!src.exists(), "source removed as normal");
    let rolled = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();
    assert_eq!(ids_of(&rolled), vec!["ok", "ok2"]);
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    let _ = std::fs::remove_dir_all(&dir);

    // An oversized unterminated tail is dropped the same way.
    let dir = temp("oversized-tail");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
    s.append(&day2("ok", 1)).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    let mut body = std::fs::read(&src).unwrap();
    body.extend(std::iter::repeat_n(b'{', 100_000));
    std::fs::write(&src, &body).unwrap();
    let report = s.rollup_report().unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert_eq!(report.dropped_oversized, vec![(src.clone(), 1)]);
    assert!(!src.exists());
    let rolled = read_parquet_strict::<CellRow>(&dir.join("weekly/2020-W10.parquet")).unwrap();
    assert_eq!(ids_of(&rolled), vec!["ok"]);
    let _ = std::fs::remove_dir_all(&dir);

    // A day of nothing but an oversized line: dropped, source removed.
    let dir = temp("oversized-only");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
    s.append(&big).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    let report = s.rollup_report().unwrap();
    assert!(report.is_clean() && report.daily.is_empty(), "{report:?}");
    assert_eq!(report.dropped_oversized, vec![(src.clone(), 1)]);
    assert!(!src.exists());
    let _ = std::fs::remove_dir_all(&dir);

    // Malformed (not oversized) still holds the day, oversized or not.
    let dir = temp("oversized-and-malformed");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
    s.append(&day2("ok", 1)).unwrap();
    s.append(&big).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    let mut f = std::fs::OpenOptions::new().append(true).open(&src).unwrap();
    std::io::Write::write_all(&mut f, b"oops\n").unwrap();
    drop(f);
    s.append(&day2("ok2", 2)).unwrap();
    let before = std::fs::read(&src).unwrap();
    let err = s.rollup_daily().unwrap_err().to_string();
    assert!(err.contains("1 malformed line(s), first: line 3"), "{err}");
    assert_eq!(std::fs::read(&src).unwrap(), before, "held untouched");
    let _ = std::fs::remove_dir_all(&dir);

    // An existing daily holding a row over the limit fails its merge.
    let dir = temp("oversized-parquet");
    TimeSeriesStore::<CellRow>::new(&dir).append(&big).unwrap();
    TimeSeriesStore::<CellRow>::new(&dir)
      .rollup_daily()
      .unwrap();
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(limits);
    s.append(&day2("late", 4)).unwrap();
    let err = s.rollup_daily().unwrap_err().to_string();
    assert!(err.contains("over the 256-byte row limit"), "{err}");
    assert!(leftovers(&dir).is_empty(), "{:?}", leftovers(&dir));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// An existing daily written by the previous writer (one arrow batch, one
  /// row group, default properties) merges exactly like the reference.
  #[test]
  fn merges_an_existing_daily_from_the_old_single_batch_writer() {
    use parquet::arrow::ArrowWriter;
    let dir = temp("old-writer");
    let s = TimeSeriesStore::<CellRow>::new(&dir).with_compaction_limits(tiny());
    let mut rng = Lcg(42);
    let existing = merge_first_wins([(0..200)
      .map(|_| row(rng.next(300), "old"))
      .collect::<Vec<_>>()]);
    std::fs::create_dir_all(dir.join("daily")).unwrap();
    let out = dir.join("daily/2020-03-02.parquet");
    let mut w = ArrowWriter::try_new(
      std::fs::File::create(&out).unwrap(),
      CellRow::arrow_schema(),
      None,
    )
    .unwrap();
    w.write(&CellRow::to_batch(&existing).unwrap()).unwrap();
    w.close().unwrap();

    let source: Vec<CellRow> = (0..120)
      .map(|i| row(rng.next(300), &format!("new{i}")))
      .collect();
    write_ljson(&dir.join("samples/2020-03-02.ljson"), &source);
    assert_eq!(s.rollup_daily().unwrap().len(), 1);
    let got = read_parquet_strict::<CellRow>(&out).unwrap();
    assert_eq!(data(&got), data(&merge_first_wins([source, existing])));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Crash, append, restart (compaction): the process dies after the daily
  /// is verified and the marker cleared, before the unlink. A fresh row then
  /// lands in the same day file, and the restart merges it into the daily;
  /// the dead attempt's count (here the last allowed) is not inherited.
  #[test]
  fn death_before_the_unlink_then_backfill_is_compacted_not_quarantined() {
    let dir = temp("death-compact");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("orig", 1)).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    write_attempts(&attempts_marker(&src), MAX_UNFINISHED_ATTEMPTS - 1).unwrap();

    test_hooks::arm_crash("compact-before-unlink");
    let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.rollup_daily()));
    assert!(died.is_err(), "the simulated death happened");
    assert!(src.exists() && !attempts_marker(&src).exists());

    s.append(&day2("fresh", 2)).unwrap();
    let report = s.rollup_report().unwrap();
    assert!(
      report.failed.is_empty() && report.quarantined.is_empty(),
      "{report:?}"
    );
    assert!(s.quarantined().is_empty());
    assert_eq!(
      ids_of(&s.range(whole_day().0, whole_day().1)),
      vec!["orig", "fresh"]
    );
    assert!(!src.exists() && !attempts_marker(&src).exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Crash, append, restart (quarantine): the process dies after moving the
  /// marker, before moving the data. The source (with a fresh row appended)
  /// is retried from zero instead of being quarantined unattempted.
  #[test]
  fn death_inside_quarantine_then_backfill_is_retried_not_quarantined() {
    let dir = temp("death-quarantine");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("orig", 1)).unwrap();
    let src = dir.join("samples/2020-03-02.ljson");
    write_attempts(&attempts_marker(&src), MAX_UNFINISHED_ATTEMPTS).unwrap();

    test_hooks::arm_crash("quarantine-before-data");
    let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.rollup_report()));
    assert!(died.is_err(), "the simulated death happened");
    assert!(src.exists() && !attempts_marker(&src).exists());

    s.append(&day2("fresh", 2)).unwrap();
    let report = s.rollup_report().unwrap();
    assert!(
      report.failed.is_empty() && report.quarantined.is_empty(),
      "{report:?}"
    );
    assert!(s.quarantined().is_empty(), "the moved marker is not data");
    assert_eq!(
      ids_of(&s.range(whole_day().0, whole_day().1)),
      vec!["orig", "fresh"]
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A rival rollup replaces the day file before every optimistic lock
  /// (compacting the first one, then removing each empty file the appender
  /// created). The append falls back to the maintenance lock and succeeds.
  #[test]
  fn repeated_replacement_falls_back_to_the_maintenance_lock() {
    let dir = temp("append-fallback");
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.append(&day2("seed", 1)).unwrap();
    let rounds = std::rc::Rc::new(std::cell::Cell::new(0u32));
    let (d, r) = (dir.clone(), rounds.clone());
    test_hooks::set_before_append_lock_while(move |_| {
      r.set(r.get() + 1);
      TimeSeriesStore::<CellRow>::new(&d).rollup_daily().unwrap();
      true
    });
    s.append(&day2("persistent", 2)).unwrap();
    test_hooks::set_before_append_lock_while(|_| false);
    assert_eq!(
      rounds.get(),
      APPEND_OPTIMISTIC_TRIES,
      "every optimistic round lost"
    );
    assert_eq!(
      ids_of(&s.range(whole_day().0, whole_day().1)),
      vec!["seed", "persistent"]
    );
    s.rollup_daily().unwrap();
    let daily = read_parquet_strict::<CellRow>(&dir.join("daily/2020-03-02.parquet")).unwrap();
    assert_eq!(ids_of(&daily), vec!["seed", "persistent"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Real threads: past-dated appenders race a rollup loop. Every append
  /// succeeds, no row is lost or duplicated, and nothing deadlocks.
  #[test]
  fn concurrent_past_appends_and_rollups_lose_nothing() {
    let dir = temp("append-stress");
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let roller = {
      let (dir, done) = (dir.clone(), done.clone());
      std::thread::spawn(move || {
        let s = TimeSeriesStore::<CellRow>::new(&dir);
        while !done.load(std::sync::atomic::Ordering::Relaxed) {
          let _ = s.rollup_daily();
        }
      })
    };
    let appenders: Vec<_> = (0..4)
      .map(|t| {
        let dir = dir.clone();
        std::thread::spawn(move || {
          let s = TimeSeriesStore::<CellRow>::new(&dir);
          for i in 0..150u32 {
            s.append(&CellRow {
              id: format!("t{t}-{i}"),
              ts: Utc.with_ymd_and_hms(2020, 3, 2, 1, 0, 0).unwrap()
                + chrono::Duration::seconds(i as i64),
              data: "{}".into(),
            })
            .unwrap();
          }
        })
      })
      .collect();
    for a in appenders {
      a.join().unwrap();
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    roller.join().unwrap();
    let s = TimeSeriesStore::<CellRow>::new(&dir);
    s.rollup_daily().unwrap();
    assert_eq!(s.range(whole_day().0, whole_day().1).len(), 600);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
