//! End-to-end: append → daily rollup → weekly rollup → range, across all three
//! on-disk fragment families, with idempotent re-runs.

use chrono::{DateTime, Duration, TimeZone, Utc};
use tento_timeseries::{CellRow, TimeSeriesStore};

fn cell(ts: DateTime<Utc>, cpu: i64) -> CellRow {
  CellRow {
    id: format!("host@{}", ts.to_rfc3339()),
    ts,
    data: format!("{{\"cpu\":{cpu}}}"),
  }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap()
    .as_nanos();
  std::env::temp_dir().join(format!("tts-{tag}-{}-{nanos}", std::process::id()))
}

#[test]
fn ljson_then_daily_then_weekly_then_range() {
  let dir = temp_dir("roundtrip");
  let store = TimeSeriesStore::<CellRow>::new(&dir);

  // A completed past ISO week (2026-W20: Mon 5/11, Tue 5/12) — always < today.
  let d1 = Utc.with_ymd_and_hms(2026, 5, 11, 12, 0, 0).unwrap();
  let d2 = Utc.with_ymd_and_hms(2026, 5, 12, 12, 0, 0).unwrap();
  store.append(&cell(d1, 10)).unwrap();
  store.append(&cell(d1 + Duration::minutes(5), 20)).unwrap();
  store.append(&cell(d2, 30)).unwrap();

  let wide = (d1 - Duration::days(1), d2 + Duration::days(1));

  // Hot ljson only.
  assert_eq!(store.range(wide.0, wide.1).len(), 3);

  // Daily rollup: both days consolidate to parquet; ljson dropped.
  let mut rolled = store.rollup_daily().unwrap();
  rolled.sort();
  assert_eq!(rolled, vec![d1.date_naive(), d2.date_naive()]);
  let rows = store.range(wide.0, wide.1);
  assert_eq!(rows.len(), 3);
  assert_eq!(rows.first().unwrap().ts, d1, "oldest first");

  // Weekly rollup: the completed week's dailies merge into one weekly parquet.
  assert_eq!(store.rollup_weekly().unwrap(), vec!["2026-W20".to_string()]);
  assert_eq!(
    store.range(wide.0, wide.1).len(),
    3,
    "range reads the weekly parquet"
  );

  // Idempotent: nothing left to roll.
  assert!(store.rollup_daily().unwrap().is_empty());
  assert!(store.rollup_weekly().unwrap().is_empty());

  // Narrow window.
  assert_eq!(
    store
      .range(d2 - Duration::hours(1), d2 + Duration::hours(1))
      .len(),
    1
  );

  let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn dedups_rows_sharing_a_timestamp() {
  let dir = temp_dir("dedup");
  let store = TimeSeriesStore::<CellRow>::new(&dir);
  let t = Utc.with_ymd_and_hms(2026, 5, 11, 9, 0, 0).unwrap();
  store.append(&cell(t, 1)).unwrap();
  store.append(&cell(t, 2)).unwrap(); // same ts AND same id → same ts_key → dedups
  assert_eq!(
    store
      .range(t - Duration::hours(1), t + Duration::hours(1))
      .len(),
    1
  );
  let _ = std::fs::remove_dir_all(&dir);
}

/// Distinct ids in one millisecond are distinct rows — through the hot file,
/// through the daily rollup (whose `ts` column must stay a parseable
/// timestamp, not the dedup key), and through a crash-replay duplicate that
/// lands in `samples/` after its day was rolled up.
#[test]
fn distinct_ids_sharing_a_millisecond_all_survive() {
  let dir = temp_dir("same-ms");
  let store = TimeSeriesStore::<CellRow>::new(&dir);
  // A past instant with a non-zero millisecond part, so precision loss shows.
  let t = Utc.with_ymd_and_hms(2026, 5, 11, 9, 0, 0).unwrap() + Duration::milliseconds(123);
  let row = |id: &str| CellRow {
    id: id.to_string(),
    ts: t,
    data: format!("{{\"id\":\"{id}\"}}"),
  };
  for id in ["cpu", "ram", "disk"] {
    store.append(&row(id)).unwrap();
  }
  let window = |s: &TimeSeriesStore<CellRow>| s.range(t - Duration::hours(1), t + Duration::hours(1));
  let ids = |rows: &[CellRow]| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();

  let hot = window(&store);
  assert_eq!(ids(&hot), ["cpu", "disk", "ram"], "three cells, one instant, hot file");
  assert_eq!(store.tail_n(10).len(), 3);

  assert_eq!(store.rollup_daily().unwrap().len(), 1);
  let rolled = window(&store);
  assert_eq!(ids(&rolled), ["cpu", "disk", "ram"], "survive the parquet round trip");
  assert!(rolled.iter().all(|r| r.ts == t), "millisecond precision kept in parquet");

  // The same cell appearing in both tiers is still one row.
  store.append(&row("ram")).unwrap();
  assert_eq!(window(&store).len(), 3, "a tier duplicate of the same (ts, id) dedups");
  assert_eq!(store.range_windowed(t - Duration::hours(1), t + Duration::hours(1)).len(), 3);
  let _ = std::fs::remove_dir_all(&dir);
}

/// A fat row (a fat payload widens the race window vs a tiny row); lines of
/// this size routinely straddle a page boundary of the day file.
fn fat_row(ts: DateTime<Utc>, writer: &str, i: usize) -> CellRow {
  CellRow {
    id: format!("{writer}-i{i}"),
    ts,
    data: format!(
      "{{\"w\":\"{writer}\",\"i\":{i},\"pad\":\"{}\"}}",
      "x".repeat(400)
    ),
  }
}

/// Every line of `day_file` is one whole row, and there are `expected` of them.
fn assert_whole_rows(day_file: &std::path::Path, expected: usize) {
  let body = std::fs::read_to_string(day_file).unwrap();
  let mut parsed = 0;
  for (i, line) in body.lines().enumerate() {
    assert!(!line.is_empty(), "blank line at {i} — torn newline pair");
    let v: serde_json::Value =
      serde_json::from_str(line).unwrap_or_else(|e| panic!("torn line {i}: {e}: {:.120}…", line));
    assert!(v.get("id").is_some(), "line {i} parsed but isn't a row");
    parsed += 1;
  }
  assert_eq!(parsed, expected, "every appended row present and whole");
}

const PER_WRITER: usize = 250;

/// Every torn-line test appends to the day file of this instant.
fn torn_ts() -> DateTime<Utc> {
  Utc.with_ymd_and_hms(2026, 5, 11, 12, 0, 0).unwrap()
}

fn torn_day_file(dir: &std::path::Path) -> std::path::PathBuf {
  dir.join("samples").join("2026-05-11.ljson")
}

/// Concurrent appenders share one day-file; every line must stay whole.
/// Before `append` issued the row and its `\n` as a single `O_APPEND` write,
/// parallel writers could interleave `row1 row2 \n \n` — a torn line carrying
/// two JSON objects that readers silently skip (observed 8× in the fleet's
/// loaf span buckets). Threads stand in for the real-world mix of sink
/// worker threads and concurrent processes: the kernel-level interleaving
/// surface (separate writes to one `O_APPEND` file) is identical.
/// The tail check of torn-tail repair races the same way unless appenders
/// serialize on the day file (see `append_waits_for_an_appender_mid_write`).
#[test]
fn concurrent_appends_never_tear_lines() {
  let dir = temp_dir("torn");
  const THREADS: usize = 8;

  std::thread::scope(|s| {
    for t in 0..THREADS {
      let dir = dir.clone();
      s.spawn(move || {
        let store = TimeSeriesStore::<CellRow>::new(&dir);
        for i in 0..PER_WRITER {
          store
            .append(&fat_row(torn_ts(), &format!("t{t}"), i))
            .unwrap();
        }
      });
    }
  });

  assert_whole_rows(&torn_day_file(&dir), THREADS * PER_WRITER);
  let _ = std::fs::remove_dir_all(&dir);
}

/// Set by [`concurrent_appends_across_processes_never_tear_lines`] when it
/// re-runs this test binary as a child appender.
const CHILD_DIR_ENV: &str = "TTS_CHILD_APPEND_DIR";
const CHILD_TAG_ENV: &str = "TTS_CHILD_APPEND_TAG";
/// Created by the parent once every child has been spawned.
const START_FILE: &str = "start";

/// The child half of the cross-process test: a no-op unless that test
/// started this process.
#[test]
fn child_appender() {
  let Some(dir) = std::env::var_os(CHILD_DIR_ENV) else {
    return;
  };
  let dir = std::path::PathBuf::from(dir);
  let tag = std::env::var(CHILD_TAG_ENV).unwrap();
  // Start together, so the appends overlap rather than run in launch order.
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
  while !dir.join(START_FILE).exists() {
    assert!(std::time::Instant::now() < deadline, "no start signal");
    std::thread::sleep(std::time::Duration::from_millis(1));
  }
  let store = TimeSeriesStore::<CellRow>::new(&dir);
  for i in 0..PER_WRITER {
    store.append(&fat_row(torn_ts(), &tag, i)).unwrap();
  }
}

/// Separate processes (a server plus one-shot CLI runs) share a day file too.
#[test]
fn concurrent_appends_across_processes_never_tear_lines() {
  let dir = temp_dir("torn-procs");
  const PROCESSES: usize = 8;
  let exe = std::env::current_exe().unwrap();
  std::fs::create_dir_all(&dir).unwrap();
  let children: Vec<_> = (0..PROCESSES)
    .map(|p| {
      std::process::Command::new(&exe)
        .args(["--exact", "child_appender", "--test-threads=1", "--quiet"])
        .env(CHILD_DIR_ENV, &dir)
        .env(CHILD_TAG_ENV, format!("p{p}"))
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap()
    })
    .collect();
  std::fs::write(dir.join(START_FILE), b"").unwrap();
  for mut child in children {
    assert!(child.wait().unwrap().success(), "child appender failed");
  }

  assert_whole_rows(&torn_day_file(&dir), PROCESSES * PER_WRITER);
  let _ = std::fs::remove_dir_all(&dir);
}

/// Deterministic form of the torn-newline race. Another appender is mid-write:
/// it holds the day file's lock and only the first half of its line is
/// visible, as Linux shows a write that crosses a page boundary. `append`
/// must wait for it instead of mistaking the half line for a torn tail.
#[test]
fn append_waits_for_an_appender_mid_write() {
  use std::io::Write;
  use std::time::{Duration as StdDuration, Instant};

  let dir = temp_dir("mid-write");
  let store = TimeSeriesStore::<CellRow>::new(&dir);
  store.append(&fat_row(torn_ts(), "first", 0)).unwrap();
  let day_file = torn_day_file(&dir);

  let mut other = std::fs::OpenOptions::new()
    .append(true)
    .open(&day_file)
    .unwrap();
  other.lock().unwrap();
  let mut in_flight = serde_json::to_vec(&fat_row(torn_ts(), "in-flight", 0)).unwrap();
  in_flight.push(b'\n');
  let (head, rest) = in_flight.split_at(in_flight.len() / 2);
  other.write_all(head).unwrap();

  let appender = {
    let dir = dir.clone();
    std::thread::spawn(move || {
      TimeSeriesStore::<CellRow>::new(&dir).append(&fat_row(torn_ts(), "next", 0))
    })
  };
  let deadline = Instant::now() + StdDuration::from_millis(500);
  while !appender.is_finished() && Instant::now() < deadline {
    std::thread::sleep(StdDuration::from_millis(10));
  }
  assert!(
    !appender.is_finished(),
    "append went ahead while another appender held the day file mid-write"
  );

  other.write_all(rest).unwrap();
  other.unlock().unwrap();
  appender.join().unwrap().unwrap();

  assert_whole_rows(&day_file, 3);
  let ids: Vec<String> = std::fs::read_to_string(&day_file)
    .unwrap()
    .lines()
    .map(|l| {
      serde_json::from_str::<serde_json::Value>(l).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
    })
    .collect();
  assert_eq!(ids, ["first-i0", "in-flight-i0", "next-i0"]);
  let _ = std::fs::remove_dir_all(&dir);
}
