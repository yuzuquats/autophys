//! Bounded-memory compaction: an external merge sort from the rollup inputs
//! into one parquet file.
//!
//! The rollup feeds rows in **precedence order** (the source first, then any
//! existing daily/weekly). [`Sorter`] buffers them as `(ts_key, json)` pairs
//! until a chunk limit (row count or serialized bytes) is reached, sorts the
//! chunk by key (stable, then first-copy dedup), and spills it to a sorted run
//! file. Run files are created in precedence order, so when two runs hold the
//! same key the lower run index wins: that is the store's "first copy wins"
//! rule. [`Sorter::finish_parquet`] k-way merges the runs (plus the last,
//! still in-memory chunk) into one [`ArrowWriter`], encoding bounded record
//! batches and closing row groups at a bounded size. When there are more runs
//! than the merge fan-in, the oldest runs are merged into one run first.
//!
//! Peak memory is therefore about one chunk + `fan_in` read buffers + one
//! record batch + one parquet row group, independent of input size. Inputs are
//! streamed: ljson with a `BufRead`, parquet one record batch at a time.
//!
//! Run files live in a private work dir inside the store directory
//! (`<store>/.compact-<pid>-<nanos>/`), never in the system temp dir; the
//! [`WorkDir`] guard removes it on every return path (and the rollup removes
//! one a killed process left behind, under the maintenance lock).

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use tento_buckets::durable;

use crate::row::SeriesRow;

/// Prefix of a compaction's private work dir inside the store directory.
pub(crate) const WORK_DIR_PREFIX: &str = ".compact-";

/// Memory budget knobs for a compaction. The defaults keep a rollup of a
/// multi-hundred-MB day well under 128 MB; tests shrink them to force many
/// runs and merge passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactionLimits {
  /// Rows buffered before a chunk is sorted and spilled to a run.
  pub chunk_rows: usize,
  /// Serialized row bytes (plus keys) buffered before a chunk is spilled.
  pub chunk_bytes: usize,
  /// Runs merged at once; more runs are merged in cascading passes first.
  pub fan_in: usize,
  /// Rows per arrow record batch handed to the parquet writer, and per batch
  /// when reading parquet inputs back.
  pub batch_rows: usize,
  /// Rows per parquet row group (upper bound).
  pub row_group_rows: usize,
  /// Encoded bytes of the open row group that close it early.
  pub row_group_bytes: usize,
  /// Serialized row bytes that close an output record batch early, so a
  /// batch of large rows is bounded by bytes and not only by row count.
  pub batch_bytes: usize,
  /// The largest row accepted, in serialized bytes (an ljson line, or a
  /// parquet row re-serialized). A longer ljson line (terminated or not) is
  /// never buffered whole: it is **dropped**, logged to stderr with its file,
  /// byte offset and size, and counted in
  /// [`CompactStats::dropped_oversized`]; the rest of the day compacts
  /// (operator decision TBC-D6, 2026-10-27). A longer parquet row fails its
  /// compaction.
  pub max_row_bytes: usize,
}

impl Default for CompactionLimits {
  fn default() -> Self {
    CompactionLimits {
      chunk_rows: 64 * 1024,
      chunk_bytes: 8 * 1024 * 1024,
      fan_in: 64,
      batch_rows: 1024,
      row_group_rows: 64 * 1024,
      row_group_bytes: 16 * 1024 * 1024,
      batch_bytes: 4 * 1024 * 1024,
      max_row_bytes: 4 * 1024 * 1024,
    }
  }
}

/// What one compaction did (for reports and tests).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompactStats {
  /// Rows written to the output parquet (after dedup).
  pub rows: u64,
  /// Sorted run files spilled (including cascade merges).
  pub runs: usize,
  /// The most rows held in the in-memory chunk at once.
  pub peak_chunk_rows: usize,
  /// ljson lines longer than [`CompactionLimits::max_row_bytes`] that were
  /// dropped (logged, not compacted).
  pub dropped_oversized: u64,
}

/// A compaction's private work dir; removed (with every run in it) on drop.
pub(crate) struct WorkDir {
  path: PathBuf,
  next: usize,
}

impl WorkDir {
  pub(crate) fn create(store_dir: &Path) -> Result<WorkDir> {
    let stamp = durable::unique_tmp(Path::new("run"));
    let stamp = stamp.to_string_lossy();
    // `run.<pid>.<nanos>.tmp` → `.compact-<pid>.<nanos>`
    let tag = stamp
      .trim_start_matches("run.")
      .trim_end_matches(".tmp")
      .to_string();
    let path = store_dir.join(format!("{WORK_DIR_PREFIX}{tag}"));
    std::fs::create_dir(&path).with_context(|| format!("create {}", path.display()))?;
    Ok(WorkDir { path, next: 0 })
  }

  fn next_run(&mut self) -> PathBuf {
    self.next += 1;
    self.path.join(format!("run-{:06}", self.next))
  }
}

impl Drop for WorkDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.path);
  }
}

/// One buffered entry: the dedup key and the row as compact JSON.
type Entry = (String, Vec<u8>);

/// Write one entry as `u32 key_len | key | u32 json_len | json`.
fn write_entry(w: &mut impl Write, key: &str, json: &[u8]) -> std::io::Result<()> {
  w.write_all(&(key.len() as u32).to_le_bytes())?;
  w.write_all(key.as_bytes())?;
  w.write_all(&(json.len() as u32).to_le_bytes())?;
  w.write_all(json)
}

/// Read one entry written by [`write_entry`]; `None` at a clean end of file.
fn read_entry(r: &mut impl Read) -> Result<Option<Entry>> {
  let mut len = [0u8; 4];
  match r.read_exact(&mut len) {
    Ok(()) => {}
    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
    Err(e) => return Err(e).context("read run"),
  }
  let mut key = vec![0u8; u32::from_le_bytes(len) as usize];
  r.read_exact(&mut key).context("read run key")?;
  r.read_exact(&mut len).context("read run entry")?;
  let mut json = vec![0u8; u32::from_le_bytes(len) as usize];
  r.read_exact(&mut json).context("read run row")?;
  Ok(Some((
    String::from_utf8(key).context("run key utf-8")?,
    json,
  )))
}

/// A sorted, deduplicated input to the merge.
enum Run {
  File(BufReader<File>),
  Mem(std::vec::IntoIter<Entry>),
}

impl Run {
  fn next(&mut self) -> Result<Option<Entry>> {
    match self {
      Run::File(r) => read_entry(r),
      Run::Mem(it) => Ok(it.next()),
    }
  }
}

/// Buffers rows in precedence order and spills sorted runs (see module doc).
pub(crate) struct Sorter {
  limits: CompactionLimits,
  work: WorkDir,
  chunk: Vec<Entry>,
  chunk_bytes: usize,
  /// Spilled runs, in precedence order (lower index wins a key tie).
  runs: Vec<PathBuf>,
  stats: CompactStats,
}

impl Sorter {
  pub(crate) fn new(store_dir: &Path, limits: CompactionLimits) -> Result<Sorter> {
    Ok(Sorter {
      limits,
      work: WorkDir::create(store_dir)?,
      chunk: Vec::new(),
      chunk_bytes: 0,
      runs: Vec::new(),
      stats: CompactStats::default(),
    })
  }

  /// Add one row. `json` is its compact JSON (an ljson line, trimmed).
  pub(crate) fn push(&mut self, key: String, json: Vec<u8>) -> Result<()> {
    anyhow::ensure!(
      json.len() <= self.limits.max_row_bytes,
      "row {key} is {} bytes, over the {}-byte row limit",
      json.len(),
      self.limits.max_row_bytes
    );
    self.chunk_bytes += key.len() + json.len() + 64;
    self.chunk.push((key, json));
    self.stats.peak_chunk_rows = self.stats.peak_chunk_rows.max(self.chunk.len());
    if self.chunk.len() >= self.limits.chunk_rows.max(1)
      || self.chunk_bytes >= self.limits.chunk_bytes
    {
      self.spill()?;
    }
    Ok(())
  }

  /// Add a decoded row (a parquet input): serialized here.
  pub(crate) fn push_row<R: SeriesRow>(&mut self, row: &R) -> Result<()> {
    let json = serde_json::to_vec(row).context("serialize row")?;
    self.push(row.ts_key(), json)
  }

  /// Stream every row of an ljson file in, strictly: a malformed interior
  /// line fails, as does an unterminated last line that does not parse. A
  /// parseable unterminated last line is kept (same as the readers). Returns
  /// the number of rows read.
  ///
  /// A line longer than [`CompactionLimits::max_row_bytes`], terminated or
  /// not, is dropped: skipped to its newline without being buffered, logged
  /// with its file, byte offset and size, and counted in
  /// [`CompactStats::dropped_oversized`]. It never holds the day.
  ///
  /// Reads through `file` (the caller holds its day-file lock, so this is
  /// the inode appenders write to); `path` is for messages. No line is ever
  /// buffered beyond [`CompactionLimits::max_row_bytes`].
  pub(crate) fn push_ljson_strict<R: SeriesRow>(
    &mut self,
    file: &File,
    path: &Path,
  ) -> Result<u64> {
    let max = self.limits.max_row_bytes;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    let mut lineno = 0usize;
    let mut bad: Vec<String> = Vec::new();
    let mut bad_count = 0usize;
    let mut in_flight_tail = false;
    let mut rows = 0u64;
    let mut offset = 0u64;
    loop {
      let line_offset = offset;
      let Some(read) = read_line_bounded(&mut reader, &mut line, max)
        .with_context(|| format!("read {}", path.display()))?
      else {
        break;
      };
      offset += read.len + u64::from(read.terminated);
      lineno += 1;
      if read.oversized {
        self.stats.dropped_oversized += 1;
        eprintln!(
          "tento-timeseries: compaction dropped an oversized row: {} line {lineno} at byte \
           offset {line_offset}: {} bytes, over the {max}-byte row limit{}",
          path.display(),
          read.len,
          if read.terminated {
            ""
          } else {
            " (unterminated last line)"
          }
        );
        continue;
      }
      let terminated = read.terminated;
      let body = line.trim_ascii();
      if body.is_empty() {
        continue;
      }
      match serde_json::from_slice::<R>(body) {
        Ok(r) => {
          rows += 1;
          if bad_count == 0 {
            // A held day is never written, so stop buffering after a bad line
            // (but keep scanning to count them, as the reader reports).
            self.push(r.ts_key(), body.to_vec())?;
          }
        }
        Err(e) if terminated => {
          bad_count += 1;
          if bad.is_empty() {
            bad.push(format!("line {lineno}: {e}"));
          }
        }
        Err(_) => in_flight_tail = true,
      }
    }
    anyhow::ensure!(
      bad_count == 0,
      "{bad_count} malformed line(s), first: {}",
      bad[0]
    );
    anyhow::ensure!(
      !in_flight_tail,
      "unterminated unparseable last line in a completed day"
    );
    Ok(rows)
  }

  /// Oversized ljson lines dropped so far by this sorter.
  pub(crate) fn dropped_oversized(&self) -> u64 {
    self.stats.dropped_oversized
  }

  /// Stream every row of a parquet file in, one record batch at a time,
  /// decoding strictly ([`SeriesRow::try_from_batch`]). Returns the rows read.
  pub(crate) fn push_parquet_strict<R: SeriesRow>(&mut self, path: &Path) -> Result<u64> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = ParquetRecordBatchReaderBuilder::try_new(file)
      .with_context(|| format!("{}: open parquet", path.display()))?
      .with_batch_size(self.limits.batch_rows.max(1))
      .build()
      .with_context(|| format!("{}: build reader", path.display()))?;
    let mut rows = 0u64;
    for batch in reader {
      let batch = batch.with_context(|| format!("{}: read batch", path.display()))?;
      let decoded =
        R::try_from_batch(&batch).with_context(|| format!("{}: decode", path.display()))?;
      for r in &decoded {
        self.push_row(r)?;
      }
      rows += decoded.len() as u64;
    }
    Ok(rows)
  }

  /// Sort the chunk by key and drop later copies of a key (stable sort, so
  /// the first-pushed copy survives).
  fn sorted_chunk(&mut self) -> Vec<Entry> {
    let mut chunk = std::mem::take(&mut self.chunk);
    self.chunk_bytes = 0;
    chunk.sort_by(|a, b| a.0.cmp(&b.0));
    chunk.dedup_by(|later, kept| later.0 == kept.0);
    chunk
  }

  fn spill(&mut self) -> Result<()> {
    if self.chunk.is_empty() {
      return Ok(());
    }
    let chunk = self.sorted_chunk();
    let path = self.work.next_run();
    let mut w = BufWriter::with_capacity(256 * 1024, create(&path)?);
    for (k, j) in &chunk {
      write_entry(&mut w, k, j).with_context(|| format!("write {}", path.display()))?;
    }
    w.flush()
      .with_context(|| format!("write {}", path.display()))?;
    self.runs.push(path);
    self.stats.runs += 1;
    Ok(())
  }

  fn open_runs(paths: &[PathBuf]) -> Result<Vec<Run>> {
    paths
      .iter()
      .map(|p| {
        File::open(p)
          .map(|f| Run::File(BufReader::with_capacity(64 * 1024, f)))
          .with_context(|| format!("open {}", p.display()))
      })
      .collect()
  }

  /// Merge the oldest runs together until the rest fit one merge pass.
  fn cascade(&mut self, reserved: usize) -> Result<()> {
    let fan_in = self.limits.fan_in.max(2);
    while self.runs.len() + reserved > fan_in {
      let take = fan_in.min(self.runs.len());
      let group: Vec<PathBuf> = self.runs.drain(..take).collect();
      let out = self.work.next_run();
      let mut w = BufWriter::with_capacity(256 * 1024, create(&out)?);
      merge(Self::open_runs(&group)?, |k, j| {
        write_entry(&mut w, k, j).with_context(|| format!("write {}", out.display()))
      })?;
      w.flush()
        .with_context(|| format!("write {}", out.display()))?;
      for p in &group {
        let _ = std::fs::remove_file(p);
      }
      // The merged run holds the highest-precedence rows: it goes first.
      self.runs.insert(0, out);
      self.stats.runs += 1;
    }
    Ok(())
  }

  /// Merge everything into `out` crash-safely: unique tmp → bounded batches →
  /// `sync_all` → rename → fsync the dir → stream the file back and compare
  /// the row count. The work dir is removed when `self` drops.
  pub(crate) fn finish_parquet<R: SeriesRow>(mut self, out: &Path) -> Result<CompactStats> {
    let parent = out.parent().context("parquet path has no parent")?;
    std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let mem = self.sorted_chunk();
    self.cascade(usize::from(!mem.is_empty()))?;
    let mut runs = Self::open_runs(&self.runs)?;
    if !mem.is_empty() {
      runs.push(Run::Mem(mem.into_iter()));
    }

    let limits = self.limits;
    let tmp = durable::unique_tmp(out);
    let written = (|| -> Result<u64> {
      let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("create {}", tmp.display()))?;
      let props = WriterProperties::builder()
        .set_compression(Compression::ZSTD(Default::default()))
        .set_max_row_group_size(limits.row_group_rows.max(1))
        .build();
      let mut writer = ArrowWriter::try_new(file, R::arrow_schema(), Some(props))
        .with_context(|| format!("parquet writer {}", tmp.display()))?;
      let mut batch: Vec<R> = Vec::with_capacity(limits.batch_rows.max(1));
      let mut rows = 0u64;
      let emit = |batch: &mut Vec<R>, writer: &mut ArrowWriter<File>| -> Result<()> {
        if batch.is_empty() {
          return Ok(());
        }
        writer.write(&R::to_batch(batch)?).context("write batch")?;
        batch.clear();
        if writer.in_progress_size() >= limits.row_group_bytes {
          writer.flush().context("flush row group")?;
        }
        Ok(())
      };
      let mut batch_bytes = 0usize;
      merge(runs, |_key, json| {
        batch.push(serde_json::from_slice(json).context("decode run row")?);
        batch_bytes += json.len();
        rows += 1;
        if batch.len() >= limits.batch_rows.max(1) || batch_bytes >= limits.batch_bytes {
          emit(&mut batch, &mut writer)?;
          batch_bytes = 0;
        }
        Ok(())
      })?;
      emit(&mut batch, &mut writer)?;
      writer.close().context("close parquet")?;
      File::open(&tmp)
        .and_then(|f| f.sync_all())
        .with_context(|| format!("sync {}", tmp.display()))?;
      std::fs::rename(&tmp, out)
        .with_context(|| format!("rename {} -> {}", tmp.display(), out.display()))?;
      Ok(rows)
    })();
    let rows = match written {
      Ok(rows) => rows,
      Err(e) => {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
      }
    };
    durable::fsync_dir(parent).with_context(|| format!("fsync {}", parent.display()))?;
    let back =
      count_parquet_strict::<R>(out, limits.batch_rows).context("verify written parquet")?;
    anyhow::ensure!(
      back == rows,
      "verify {}: wrote {rows} rows, read back {back}",
      out.display()
    );
    self.stats.rows = rows;
    Ok(self.stats)
  }
}

/// How [`read_line_bounded`] ended a line.
struct LineRead {
  /// Ended by `\n` (else by end of file).
  terminated: bool,
  /// Longer than the limit: the buffer was emptied and the rest skipped.
  oversized: bool,
  /// The line's full length in bytes, without its `\n` (also when it was
  /// skipped as oversized).
  len: u64,
}

/// Read the next line into `buf` (without its `\n`), never growing `buf` past
/// `max` bytes: a longer line is consumed and discarded (`oversized`), so a
/// huge newline-less tail costs one read buffer, not its own size. `None` at
/// end of file.
fn read_line_bounded(
  r: &mut impl BufRead,
  buf: &mut Vec<u8>,
  max: usize,
) -> std::io::Result<Option<LineRead>> {
  buf.clear();
  let mut any = false;
  let mut oversized = false;
  let mut len = 0u64;
  loop {
    let avail = match r.fill_buf() {
      Ok(a) => a,
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(e) => return Err(e),
    };
    if avail.is_empty() {
      return Ok(any.then_some(LineRead {
        terminated: false,
        oversized,
        len,
      }));
    }
    any = true;
    let newline = avail.iter().position(|b| *b == b'\n');
    let part = &avail[..newline.unwrap_or(avail.len())];
    if !oversized {
      if buf.len() + part.len() > max {
        oversized = true;
        buf.clear();
      } else {
        buf.extend_from_slice(part);
      }
    }
    len += part.len() as u64;
    let used = part.len() + usize::from(newline.is_some());
    r.consume(used);
    if newline.is_some() {
      return Ok(Some(LineRead {
        terminated: true,
        oversized,
        len,
      }));
    }
  }
}

fn create(path: &Path) -> Result<File> {
  std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(path)
    .with_context(|| format!("create {}", path.display()))
}

/// K-way merge of sorted, deduplicated runs, calling `sink` once per distinct
/// key in key order. On a tie the lowest run index wins (precedence order).
fn merge(mut runs: Vec<Run>, mut sink: impl FnMut(&str, &[u8]) -> Result<()>) -> Result<()> {
  let mut heads: Vec<Option<Vec<u8>>> = Vec::with_capacity(runs.len());
  let mut heap: BinaryHeap<Reverse<(String, usize)>> = BinaryHeap::with_capacity(runs.len());
  for (i, run) in runs.iter_mut().enumerate() {
    match run.next()? {
      Some((k, j)) => {
        heap.push(Reverse((k, i)));
        heads.push(Some(j));
      }
      None => heads.push(None),
    }
  }
  let mut last: Option<String> = None;
  while let Some(Reverse((key, i))) = heap.pop() {
    let json = heads[i].take().context("merge head missing")?;
    if last.as_deref() != Some(key.as_str()) {
      sink(&key, &json)?;
      last = Some(key);
    }
    if let Some((k, j)) = runs[i].next()? {
      heap.push(Reverse((k, i)));
      heads[i] = Some(j);
    }
  }
  Ok(())
}

/// Count a parquet file's rows by streaming its batches through
/// [`SeriesRow::try_from_batch`] (strict, bounded memory), cross-checked
/// against the footer's row count.
pub(crate) fn count_parquet_strict<R: SeriesRow>(path: &Path, batch_rows: usize) -> Result<u64> {
  let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
  let builder = ParquetRecordBatchReaderBuilder::try_new(file)
    .with_context(|| format!("{}: open parquet", path.display()))?
    .with_batch_size(batch_rows.max(1));
  let footer = builder.metadata().file_metadata().num_rows();
  let reader = builder
    .build()
    .with_context(|| format!("{}: build reader", path.display()))?;
  let mut rows = 0u64;
  for batch in reader {
    let batch = batch.with_context(|| format!("{}: read batch", path.display()))?;
    rows += R::try_from_batch(&batch)
      .with_context(|| format!("{}: decode", path.display()))?
      .len() as u64;
  }
  anyhow::ensure!(
    footer >= 0 && footer as u64 == rows,
    "{}: footer says {footer} rows, decoded {rows}",
    path.display()
  );
  Ok(rows)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::CellRow;
  use chrono::{TimeZone, Utc};

  fn temp() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
      "ts-sorter-{}",
      durable::unique_tmp(Path::new("x")).display()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
  }

  /// The chunk never holds more than `chunk_rows` rows, however many rows go
  /// in: memory is set by the limit, not the input.
  #[test]
  fn chunk_is_bounded_by_the_limit_and_runs_cascade() {
    let dir = temp();
    let limits = CompactionLimits {
      chunk_rows: 100,
      chunk_bytes: usize::MAX,
      fan_in: 4,
      batch_rows: 64,
      row_group_rows: 500,
      row_group_bytes: 1 << 20,
      ..CompactionLimits::default()
    };
    let mut sorter = Sorter::new(&dir, limits).unwrap();
    let n = 10_000u64;
    for i in 0..n {
      // Reverse order and every key twice: sorting and dedup do real work.
      let r = CellRow {
        id: format!("k{}", (n - 1 - i) % (n / 2)),
        ts: Utc.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).unwrap(),
        data: format!("{i}"),
      };
      sorter.push_row(&r).unwrap();
    }
    let out = dir.join("out.parquet");
    let stats = sorter.finish_parquet::<CellRow>(&out).unwrap();
    assert_eq!(stats.peak_chunk_rows, 100);
    assert!(stats.runs > 100, "spilled and cascaded: {stats:?}");
    assert_eq!(stats.rows, n / 2);
    let file = File::open(&out).unwrap();
    let meta = ParquetRecordBatchReaderBuilder::try_new(file).unwrap();
    assert!(meta.metadata().num_row_groups() >= 10, "bounded row groups");
    // The first pushed copy of each key won (data = the earlier index).
    let rows: Vec<CellRow> = meta
      .build()
      .unwrap()
      .flat_map(|b| CellRow::from_batch(&b.unwrap()))
      .collect();
    assert!(rows.windows(2).all(|w| w[0].ts_key() < w[1].ts_key()));
    assert!(rows.iter().all(|r| r.data.parse::<u64>().unwrap() < n / 2));
    let names: Vec<_> = std::fs::read_dir(&dir)
      .unwrap()
      .flatten()
      .map(|e| e.file_name())
      .collect();
    assert_eq!(
      names,
      vec![std::ffi::OsString::from("out.parquet")],
      "work dir removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// An oversized line (interior or unterminated tail) is dropped and
  /// counted, the other rows still go in; a malformed line still fails.
  #[test]
  fn oversized_lines_are_dropped_and_counted_malformed_still_fail() {
    let dir = temp();
    let limits = CompactionLimits {
      max_row_bytes: 128,
      ..CompactionLimits::default()
    };
    let ok =
      |id: &str| format!("{{\"id\":\"{id}\",\"ts\":\"2020-01-01T00:00:00Z\",\"data\":\"\"}}\n");
    let src = dir.join("day.ljson");
    let body = ok("a") + &"x".repeat(1000) + "\n" + &ok("b") + &"{".repeat(5000);
    std::fs::write(&src, &body).unwrap();
    let mut sorter = Sorter::new(&dir, limits).unwrap();
    let rows = sorter
      .push_ljson_strict::<CellRow>(&File::open(&src).unwrap(), &src)
      .unwrap();
    assert_eq!(rows, 2);
    assert_eq!(sorter.dropped_oversized(), 2);
    let stats = sorter
      .finish_parquet::<CellRow>(&dir.join("out.parquet"))
      .unwrap();
    assert_eq!((stats.rows, stats.dropped_oversized), (2, 2));

    std::fs::write(&src, ok("a") + &"x".repeat(1000) + "\noops\n").unwrap();
    let mut sorter = Sorter::new(&dir, limits).unwrap();
    let err = sorter
      .push_ljson_strict::<CellRow>(&File::open(&src).unwrap(), &src)
      .unwrap_err()
      .to_string();
    assert!(err.contains("1 malformed line(s), first: line 3"), "{err}");
    drop(sorter);
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// `read_line_bounded` reports each line's full length, also when skipped.
  #[test]
  fn bounded_reads_report_full_line_lengths() {
    let data = b"ab\nxxxxxxxxxx\ncd";
    let mut r = std::io::BufReader::with_capacity(4, &data[..]);
    let mut buf = Vec::new();
    let mut got = Vec::new();
    while let Some(l) = read_line_bounded(&mut r, &mut buf, 4).unwrap() {
      got.push((l.len, l.oversized, l.terminated, buf.clone()));
    }
    assert_eq!(
      got,
      vec![
        (2, false, true, b"ab".to_vec()),
        (10, true, true, Vec::new()),
        (2, false, false, b"cd".to_vec()),
      ]
    );
  }

  /// Every error path drops the work dir.
  #[test]
  fn work_dir_is_removed_on_error() {
    let dir = temp();
    let limits = CompactionLimits {
      chunk_rows: 2,
      ..CompactionLimits::default()
    };
    let mut sorter = Sorter::new(&dir, limits).unwrap();
    let src = dir.join("bad.ljson");
    std::fs::write(
      &src,
      "{\"id\":\"a\",\"ts\":\"2020-01-01T00:00:00Z\",\"data\":\"\"}\n".repeat(5) + "oops\n",
    )
    .unwrap();
    let f = File::open(&src).unwrap();
    assert!(sorter.push_ljson_strict::<CellRow>(&f, &src).is_err());
    drop(sorter);
    let names: Vec<_> = std::fs::read_dir(&dir)
      .unwrap()
      .flatten()
      .map(|e| e.file_name())
      .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("bad.ljson")]);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
