//! Peak heap of a daily compaction, measured with a counting global allocator,
//! against a faithful replica of the previous whole-day compaction (read the
//! file, decode every row, `BTreeMap` merge, one arrow batch, one row group,
//! read the whole parquet back). Synthetic span-sized rows only (~1 KB lines,
//! the shape of the loaf span days that OOM-killed host-health on htz-02).
//!
//! A 64 MB single line (newline-less tail or interior) is dropped without
//! being buffered, and the rest of the day compacts (TBC-D6). The fast test (24 MB) runs by default. The 250 MB variant is `#[ignore]`:
//! `cargo test -p tento-timeseries --release --test compaction_memory -- --ignored --nocapture`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::{Duration, TimeZone, Utc};
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use tento_timeseries::{CellRow, SeriesRow, TimeSeriesStore};

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    let p = unsafe { System.alloc(layout) };
    if !p.is_null() {
      let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
      PEAK.fetch_max(now, Ordering::Relaxed);
    }
    p
  }
  unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
    unsafe { System.dealloc(p, layout) };
    CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
  }
  unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    let q = unsafe { System.realloc(p, layout, new_size) };
    if !q.is_null() {
      if new_size >= layout.size() {
        let now =
          CURRENT.fetch_add(new_size - layout.size(), Ordering::Relaxed) + new_size - layout.size();
        PEAK.fetch_max(now, Ordering::Relaxed);
      } else {
        CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
      }
    }
    q
  }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// One measurement at a time (the counter is process-wide).
static SERIAL: Mutex<()> = Mutex::new(());

/// Peak heap growth above the current level while `f` runs.
fn peak_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
  let base = CURRENT.load(Ordering::Relaxed);
  PEAK.store(base, Ordering::Relaxed);
  let out = f();
  (out, PEAK.load(Ordering::Relaxed).saturating_sub(base))
}

fn temp(tag: &str) -> PathBuf {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap()
    .as_nanos();
  let d = std::env::temp_dir().join(format!("tts-mem-{tag}-{}-{nanos}", std::process::id()));
  std::fs::create_dir_all(&d).unwrap();
  d
}

/// Write a completed day of ~`bytes` of ~1 KB rows; returns the row count.
fn synth_day(path: &Path, bytes: usize) -> usize {
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  let mut w = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
  let t0 = Utc.with_ymd_and_hms(2020, 3, 2, 0, 0, 0).unwrap();
  let mut x: u64 = 0x9e3779b97f4a7c15;
  let (mut written, mut n) = (0usize, 0usize);
  while written < bytes {
    let mut hex = String::with_capacity(900);
    while hex.len() < 860 {
      x ^= x << 13;
      x ^= x >> 7;
      x ^= x << 17;
      hex.push_str(&format!("{x:016x}"));
    }
    let row = CellRow {
      id: format!("span-{n:08}-{:x}", x & 0xffff),
      ts: t0 + Duration::milliseconds((n as i64 * 337) % 86_400_000),
      data: format!("{{\"http.target\":\"/api/v1/rows\",\"blob\":\"{hex}\"}}"),
    };
    let line = serde_json::to_string(&row).unwrap();
    w.write_all(line.as_bytes()).unwrap();
    w.write_all(b"\n").unwrap();
    written += line.len() + 1;
    n += 1;
  }
  w.flush().unwrap();
  n
}

/// The previous `compact_day` + `write_parquet_verified`, verbatim in effect.
fn old_compact(src: &Path, out: &Path) -> usize {
  let bytes = std::fs::read(src).unwrap();
  let lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').collect();
  let rows: Vec<CellRow> = lines
    .iter()
    .map(|l| l.trim_ascii())
    .filter(|l| !l.is_empty())
    .map(|l| serde_json::from_slice(l).unwrap())
    .collect();
  let mut by_ts: BTreeMap<String, CellRow> = BTreeMap::new();
  for r in rows {
    by_ts.entry(r.ts_key()).or_insert(r);
  }
  let merged: Vec<CellRow> = by_ts.into_values().collect();
  let props = WriterProperties::builder()
    .set_compression(Compression::ZSTD(Default::default()))
    .build();
  let file = std::fs::File::create(out).unwrap();
  let mut writer = ArrowWriter::try_new(file, CellRow::arrow_schema(), Some(props)).unwrap();
  writer.write(&CellRow::to_batch(&merged).unwrap()).unwrap();
  writer.close().unwrap();
  let reader = ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(out).unwrap())
    .unwrap()
    .build()
    .unwrap();
  let back: Vec<CellRow> = reader
    .flat_map(|b| CellRow::try_from_batch(&b.unwrap()).unwrap())
    .collect();
  assert_eq!(back.len(), merged.len());
  back.len()
}

/// (rows, new peak, old peak) for a synthetic day of `bytes`.
fn measure(tag: &str, bytes: usize) -> (usize, usize, usize) {
  let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
  let dir = temp(tag);
  let src = dir.join("samples/2020-03-02.ljson");
  let rows = synth_day(&src, bytes);

  let old_dir = temp(&format!("{tag}-old"));
  let (old_rows, old_peak) = peak_during(|| old_compact(&src, &old_dir.join("old.parquet")));
  assert_eq!(old_rows, rows);
  let _ = std::fs::remove_dir_all(&old_dir);

  let store = TimeSeriesStore::<CellRow>::new(&dir);
  let (rolled, new_peak) = peak_during(|| store.rollup_daily().unwrap());
  assert_eq!(rolled.len(), 1);
  let out = dir.join("daily/2020-03-02.parquet");
  let footer = ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(&out).unwrap())
    .unwrap()
    .metadata()
    .file_metadata()
    .num_rows();
  assert_eq!(footer as usize, rows);
  let _ = std::fs::remove_dir_all(&dir);
  eprintln!(
    "{tag}: {} MB day, {rows} rows: old peak {} MB, new peak {} MB",
    bytes >> 20,
    old_peak >> 20,
    new_peak >> 20
  );
  (rows, new_peak, old_peak)
}

#[test]
fn compaction_peak_heap_is_bounded_not_proportional() {
  let (_, new_peak, old_peak) = measure("fast", 24 << 20);
  assert!(new_peak < 48 << 20, "new peak {} MB", new_peak >> 20);
  assert!(
    old_peak > 3 * new_peak,
    "old {} MB vs new {} MB",
    old_peak >> 20,
    new_peak >> 20
  );
}

#[test]
#[ignore = "writes and compacts a 250 MB synthetic day; run in --release"]
fn compaction_of_a_250mb_day_stays_under_128mb() {
  let (_, new_peak, old_peak) = measure("250mb", 250 << 20);
  assert!(new_peak < 128 << 20, "new peak {} MB", new_peak >> 20);
  assert!(
    old_peak > new_peak,
    "old {} MB vs new {} MB",
    old_peak >> 20,
    new_peak >> 20
  );
}

/// A 64 MB line — newline-less tail, or terminated interior line — is never
/// buffered whole: it is dropped and counted, the rest of the day compacts and
/// the source is removed, and peak heap stays at the row limit (TBC-D6).
#[test]
fn a_64mb_line_is_dropped_and_the_day_compacts_in_bounded_memory() {
  let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
  for terminated in [false, true] {
    let dir = temp(if terminated { "huge-line" } else { "huge-tail" });
    let src = dir.join("samples/2020-03-02.ljson");
    let mut rows = synth_day(&src, 1 << 20);
    {
      let mut w =
        std::io::BufWriter::new(std::fs::OpenOptions::new().append(true).open(&src).unwrap());
      let block = vec![b'x'; 1 << 20];
      for _ in 0..64 {
        w.write_all(&block).unwrap();
      }
      if terminated {
        w.write_all(b"\n").unwrap();
        w.write_all(b"{\"id\":\"after\",\"ts\":\"2020-03-02T01:00:00Z\",\"data\":\"{}\"}\n")
          .unwrap();
        rows += 1;
      }
      w.flush().unwrap();
    }
    let store = TimeSeriesStore::<CellRow>::new(&dir);
    let (res, peak) = peak_during(|| store.rollup_report());
    let report = res.unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert_eq!(report.daily.len(), 1, "{report:?}");
    // rollup_report also rolls the (long past) week, so the rows land there.
    assert_eq!(report.dropped_oversized, vec![(src.clone(), 1)]);
    assert!(!src.exists(), "the source is removed as normal");
    let footer = ParquetRecordBatchReaderBuilder::try_new(
      std::fs::File::open(dir.join("weekly/2020-W10.parquet")).unwrap(),
    )
    .unwrap()
    .metadata()
    .file_metadata()
    .num_rows();
    assert_eq!(footer as usize, rows, "every other row compacted");
    eprintln!(
      "64 MB line (terminated={terminated}): dropped, {rows} rows kept, peak {} MB",
      peak >> 20
    );
    assert!(peak < 24 << 20, "peak {} MB", peak >> 20);
    let _ = std::fs::remove_dir_all(&dir);
  }
}
