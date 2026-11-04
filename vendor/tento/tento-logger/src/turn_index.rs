//! The TURN INDEX: a byte-offset table over a trace file, one row per turn.
//!
//! ## Why it exists
//!
//! A transcript viewer windowing a large trace re-derives "which rows belong
//! on screen" from raw bytes on every window move, because a row's existence
//! depends on fold structure — a collapsed mega-turn renders two rows for a
//! thousand records, an over-cap record renders none. Without an index the
//! viewer can only ESTIMATE where a page's bytes begin (bytes-per-row
//! heuristics, starved-landing retries, desert walks over giant records),
//! and every estimate miss re-parses megabytes. Measured on a 392 MB
//! legacy-replay trace, that discovery cost — not text rendering — was ~85%
//! of every page turn.
//!
//! The index answers the discovery question exactly: for each turn (in the
//! [`crate::fold::TraceState::turns`] sense), where its bytes begin, whether
//! it is prompted or ambient, and how many records fold into it. A page turn
//! becomes: binary-search the current origin, take exactly the K prior (or
//! next) turns, fold exactly their bytes. No estimates, no retries.
//!
//! ## Grouping fidelity
//!
//! The scan mirrors [`crate::fold::TraceState::turns`]: top-level records
//! (parentless opens and events) with a non-zero host-stamped `turn_seq`
//! coalesce into one prompted turn per seq (interleaving tolerated — the
//! turn's offset is its FIRST record's); each contiguous run of unmarked
//! top-level records is one ambient turn, and a marked record closes the
//! open run. Child records (parented events, field patches, closes) never
//! open a turn; they attribute their record count to their root's turn
//! through the parent chain. Standalone stream merges (ACP chunks, agent
//! deltas) never move a turn boundary: a merged continuation is unmarked or
//! same-seq either way.
//!
//! Two deliberate approximations, both validated by the fixture test that
//! compares a scan against a real fold of the same bytes: file order stands
//! in for the fold's timestamp-chronological entry order (the writer
//! appends), and a root's `turn_seq` is read at its OPEN (the host stamps it
//! there; a later field patch adding `turn_seq` would be invisible to the
//! scan).
//!
//! ## Cost
//!
//! One streaming pass. Child records — the payload bulk; stdout events are
//! parented — parse envelope-only (serde skips unknown fields without
//! materializing them), and `fields` parses only the `turn_seq` probe. Lines
//! over [`MAX_INDEXED_LINE_BYTES`] are skipped exactly as the fold skips
//! them, so counts match what a fold of the same bytes would hold.

use std::collections::HashMap;
use std::io::{BufRead, Seek, SeekFrom};
use std::path::Path;

use serde::Deserialize;

/// Longest line the scan parses — mirrors the fold consumer's cap
/// (`MAX_TRACE_LINE_BYTES` in the trace pane): a record beyond it never
/// folds, so it must not count here either.
pub const MAX_INDEXED_LINE_BYTES: usize = 2 * 1024 * 1024;

/// One turn's mark: where it starts, what it is, how much folds into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnMark {
  /// Byte offset of the turn's FIRST record's line start.
  pub offset: u64,
  /// The host-stamped `turn_seq` for a prompted turn; `0` for an ambient
  /// run (the fold treats absent and zero alike).
  pub seq: u64,
  /// Records attributed to this turn — top-level and child lines both, in
  /// parse-eligible lines.
  pub records: u64,
}

impl TurnMark {
  pub fn is_prompted(&self) -> bool {
    self.seq != 0
  }
}

/// The scanned table plus how far into the source it is valid.
#[derive(Debug, Clone, Default)]
pub struct TurnIndex {
  pub turns: Vec<TurnMark>,
  /// Byte offset of every TOP-LEVEL record's line start (parentless opens
  /// and events) — the fold's entry granularity, and the one paging must
  /// use: real traces hold hours-long turns (a 392 MB replay groups into
  /// 582 turns, some spanning many megabytes), so turn-aligned pages fold
  /// entire mega-turns. Entry-aligned pages take exactly K entries.
  pub tops: Vec<u64>,
  /// Byte offset the scan consumed up to (a line boundary).
  pub source_len: u64,
}

impl TurnIndex {
  /// Index of the last turn whose offset is `<= at` — the turn a byte
  /// position falls into (its records begin at or before `at`).
  pub fn turn_at(&self, at: u64) -> Option<usize> {
    match self.turns.binary_search_by(|mark| mark.offset.cmp(&at)) {
      Ok(i) => Some(i),
      Err(0) => None,
      Err(i) => Some(i - 1),
    }
  }

  /// Index of the last top-level entry whose offset is `<= at`.
  pub fn top_at(&self, at: u64) -> Option<usize> {
    match self.tops.binary_search(&at) {
      Ok(i) => Some(i),
      Err(0) => None,
      Err(i) => Some(i - 1),
    }
  }
}

#[derive(Deserialize)]
struct FieldsProbe {
  #[serde(default)]
  turn_seq: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ProbeOp {
  op: String,
  #[serde(default)]
  id: Option<u64>,
  #[serde(default)]
  parent: Option<u64>,
  #[serde(default)]
  fields: Option<FieldsProbe>,
}

fn probe_turn_seq(fields: &Option<FieldsProbe>) -> u64 {
  let Some(FieldsProbe {
    turn_seq: Some(value),
  }) = fields
  else {
    return 0;
  };
  value
    .as_u64()
    .or_else(|| value.as_str().and_then(|s| s.parse::<u64>().ok()))
    .unwrap_or(0)
}

/// Scan `path` from byte 0 and build the turn table. Streaming, read-only,
/// bounded memory (two u64 maps over span/root ids).
pub fn scan_turn_index(path: &Path) -> std::io::Result<TurnIndex> {
  let file = std::fs::File::open(path)?;
  let mut reader = std::io::BufReader::with_capacity(256 * 1024, file);
  reader.seek(SeekFrom::Start(0))?;

  let mut index = TurnIndex::default();
  // span id → its ROOT span id (roots map to themselves).
  let mut span_root: HashMap<u64, u64> = HashMap::new();
  // root span id → turn index in `index.turns`.
  let mut root_turn: HashMap<u64, usize> = HashMap::new();
  // prompted turn seq → turn index.
  let mut seq_turn: HashMap<u64, usize> = HashMap::new();
  let mut open_ambient: Option<usize> = None;

  let mut offset: u64 = 0;
  let mut line: Vec<u8> = Vec::new();
  loop {
    line.clear();
    let read = reader.read_until(b'\n', &mut line)?;
    if read == 0 {
      break;
    }
    let line_start = offset;
    offset += read as u64;
    if !line.ends_with(b"\n") {
      // Trailing partial line (writer mid-flush): not consumed — the next
      // scan picks it up whole.
      break;
    }
    if line.len() > MAX_INDEXED_LINE_BYTES {
      continue;
    }
    let Ok(text) = std::str::from_utf8(&line) else {
      continue;
    };
    let Ok(probe) = serde_json::from_str::<ProbeOp>(text) else {
      continue;
    };
    let top_level = probe.parent.is_none() && matches!(probe.op.as_str(), "open" | "event");
    if top_level {
      index.tops.push(line_start);
      let seq = probe_turn_seq(&probe.fields);
      let turn = if seq != 0 {
        open_ambient = None;
        *seq_turn.entry(seq).or_insert_with(|| {
          index.turns.push(TurnMark {
            offset: line_start,
            seq,
            records: 0,
          });
          index.turns.len() - 1
        })
      } else {
        match open_ambient {
          Some(turn) => turn,
          None => {
            index.turns.push(TurnMark {
              offset: line_start,
              seq: 0,
              records: 0,
            });
            let turn = index.turns.len() - 1;
            open_ambient = Some(turn);
            turn
          }
        }
      };
      if probe.op == "open" {
        if let Some(id) = probe.id {
          span_root.insert(id, id);
          root_turn.insert(id, turn);
        }
      }
      index.turns[turn].records += 1;
    } else {
      // Child record: attribute through the parent chain, falling back to
      // the most recent turn (a broken chain still folds SOMEWHERE near
      // its neighbors).
      if probe.op == "open" {
        if let (Some(id), Some(parent)) = (probe.id, probe.parent) {
          let root = span_root.get(&parent).copied().unwrap_or(parent);
          span_root.insert(id, root);
        }
      }
      let owner = probe
        .parent
        .or(probe.id)
        .and_then(|span| span_root.get(&span).copied())
        .and_then(|root| root_turn.get(&root).copied())
        .or(index.turns.len().checked_sub(1));
      if let Some(turn) = owner {
        index.turns[turn].records += 1;
      }
    }
    index.source_len = offset;
  }
  Ok(index)
}

/// Sibling index file for a trace: `trace.ljson` → `trace.ljson.turns.idx`.
pub fn index_path_for(trace: &Path) -> std::path::PathBuf {
  let mut name = trace
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| "trace".into());
  name.push_str(".turns.idx");
  trace.with_file_name(name)
}

/// FNV-1a over the trace's first `len` bytes (at most 4 KB) — cheap
/// rotation/rewrite detection. The hashed length is recorded with the hash:
/// an append must not shift it, or appending to a sub-4 KB trace would
/// falsely invalidate.
const HEAD_HASH_CAP: usize = 4096;

fn head_fnv(trace: &Path, len: usize) -> std::io::Result<u64> {
  use std::io::Read;
  let mut head = vec![0u8; len.min(HEAD_HASH_CAP)];
  let mut file = std::fs::File::open(trace)?;
  let mut filled = 0usize;
  while filled < head.len() {
    let n = file.read(&mut head[filled..])?;
    if n == 0 {
      break;
    }
    filled += n;
  }
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in &head[..filled] {
    hash ^= *byte as u64;
    hash = hash.wrapping_mul(0x100000001b3);
  }
  Ok(hash)
}

/// Persist `index` beside `trace` — atomic tmp+rename, so concurrent
/// viewers see whole files only (last writer wins; the content is a pure
/// function of the trace bytes, so any complete write is correct).
pub fn save_index(trace: &Path, index: &TurnIndex) -> std::io::Result<()> {
  use std::io::Write;
  let path = index_path_for(trace);
  let tmp = path.with_file_name(format!(
    ".{}.{}.tmp",
    path
      .file_name()
      .map(|n| n.to_string_lossy())
      .unwrap_or_default(),
    std::process::id()
  ));
  let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
  let head_len = (index.source_len as usize).min(HEAD_HASH_CAP);
  writeln!(
    out,
    "{{\"v\":2,\"shape\":\"trace.turns.idx/v2\",\"source_len\":{},\"head_len\":{},\"head_fnv\":{},\"turns\":{},\"tops\":{}}}",
    index.source_len,
    head_len,
    head_fnv(trace, head_len)?,
    index.turns.len(),
    index.tops.len(),
  )?;
  for mark in &index.turns {
    writeln!(
      out,
      "{{\"o\":{},\"s\":{},\"n\":{}}}",
      mark.offset, mark.seq, mark.records
    )?;
  }
  for top in &index.tops {
    writeln!(out, "{{\"t\":{top}}}")?;
  }
  out.flush()?;
  drop(out);
  std::fs::rename(&tmp, &path)
}

/// Load and VALIDATE a persisted index for `trace`: the header's head hash
/// must match the live file (rotation detection) and its `source_len` may
/// not exceed the live length (a truncated trace invalidates). `None` on
/// any mismatch or parse trouble — the caller rebuilds.
pub fn load_index(trace: &Path) -> Option<TurnIndex> {
  use std::io::BufRead;
  let path = index_path_for(trace);
  let file = std::fs::File::open(&path).ok()?;
  let mut lines = std::io::BufReader::new(file).lines();
  let header: serde_json::Value = serde_json::from_str(&lines.next()?.ok()?).ok()?;
  if header.get("v").and_then(|v| v.as_u64()) != Some(2) {
    return None;
  }
  let source_len = header.get("source_len")?.as_u64()?;
  let head_len = header.get("head_len")?.as_u64()? as usize;
  let recorded_fnv = header.get("head_fnv")?.as_u64()?;
  let live_len = std::fs::metadata(trace).ok()?.len();
  if source_len > live_len || head_fnv(trace, head_len).ok()? != recorded_fnv {
    return None;
  }
  let mut turns =
    Vec::with_capacity(header.get("turns").and_then(|v| v.as_u64()).unwrap_or(0) as usize);
  let mut tops =
    Vec::with_capacity(header.get("tops").and_then(|v| v.as_u64()).unwrap_or(0) as usize);
  for line in lines {
    let row: serde_json::Value = serde_json::from_str(&line.ok()?).ok()?;
    if let Some(top) = row.get("t") {
      tops.push(top.as_u64()?);
    } else {
      turns.push(TurnMark {
        offset: row.get("o")?.as_u64()?,
        seq: row.get("s")?.as_u64()?,
        records: row.get("n")?.as_u64()?,
      });
    }
  }
  Some(TurnIndex {
    turns,
    tops,
    source_len,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fold::{TraceState, Turn, apply};
  use crate::stream::TraceOp;
  use std::io::Write;

  fn op_line(json: serde_json::Value) -> String {
    serde_json::to_string(&json).unwrap()
  }

  /// A synthetic trace with prompted turns (spans + parented children),
  /// ambient runs between them, and a stray same-seq interleave — scanned
  /// marks must agree with a REAL fold of the same bytes.
  #[test]
  fn scan_agrees_with_the_fold_on_turn_grouping() {
    let mut lines: Vec<String> = Vec::new();
    let mut seqn = 0u64;
    let mut next = |v: serde_json::Value| {
      seqn += 1;
      let mut v = v;
      v["seq"] = serde_json::json!(seqn);
      // Monotonic timestamps, like the writer stamps: the fold orders
      // entries chronologically, and file order matches it on real traces.
      v["ts"] = serde_json::json!(format!("2026-01-01T00:00:{:02}Z", seqn));
      op_line(v)
    };
    // ambient preamble (two standalones = one run)
    lines.push(next(serde_json::json!({"op":"event","parent":null,"level":"info","loc":{},"fields":{"message":"boot"}})));
    lines.push(next(serde_json::json!({"op":"event","parent":null,"level":"info","loc":{},"fields":{"message":"ready"}})));
    // prompted turn 7: root span + child event + close
    lines.push(next(serde_json::json!({"op":"open","id":1,"parent":null,"name":"shell.exec","level":"info","loc":{},"fields":{"turn_seq":7}})));
    lines.push(next(serde_json::json!({"op":"event","parent":1,"level":"info","loc":{},"fields":{"message":"stdout"}})));
    // ambient run between turn records (marked entry closed the run above)
    lines.push(next(serde_json::json!({"op":"event","parent":null,"level":"info","loc":{},"fields":{"message":"infra"}})));
    // stray same-seq interleave rejoins turn 7
    lines.push(next(serde_json::json!({"op":"event","parent":null,"level":"info","loc":{},"fields":{"turn_seq":7,"message":"late"}})));
    lines.push(next(
      serde_json::json!({"op":"close","id":1,"elapsed_ms":5}),
    ));
    // prompted turn 9
    lines.push(next(serde_json::json!({"op":"open","id":2,"parent":null,"name":"shell.exec","level":"info","loc":{},"fields":{"turn_seq":9}})));
    lines.push(next(
      serde_json::json!({"op":"close","id":2,"elapsed_ms":1}),
    ));
    // trailing ambient
    lines.push(next(serde_json::json!({"op":"event","parent":null,"level":"info","loc":{},"fields":{"message":"idle"}})));

    let dir = std::env::temp_dir().join(format!("turn-index-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("trace.ljson");
    let mut f = std::fs::File::create(&path).unwrap();
    for l in &lines {
      writeln!(f, "{l}").unwrap();
    }
    drop(f);

    let index = scan_turn_index(&path).unwrap();

    // The real fold over the same bytes.
    let mut state = TraceState::new();
    for l in &lines {
      if let Ok(op) = serde_json::from_str::<TraceOp>(l) {
        apply(&mut state, &op);
      }
    }
    let fold_turns = state.turns();

    let scanned: Vec<(u64, bool)> = index
      .turns
      .iter()
      .map(|m| (m.seq, m.is_prompted()))
      .collect();
    let folded: Vec<(u64, bool)> = fold_turns
      .iter()
      .map(|turn| match turn {
        Turn::Prompted { seq, .. } => (*seq, true),
        Turn::Ambient { .. } => (0, false),
      })
      .collect();
    assert_eq!(
      scanned, folded,
      "scan and fold must agree on turn order and kinds"
    );
    // Every parse-eligible line is attributed exactly once.
    let counted: u64 = index.turns.iter().map(|m| m.records).sum();
    assert_eq!(counted, lines.len() as u64, "every record attributed");
    // Offsets are strictly increasing line starts.
    let mut last = None;
    for mark in &index.turns {
      assert!(last.is_none_or(|prev| mark.offset > prev));
      last = Some(mark.offset);
    }
    assert_eq!(index.source_len, std::fs::metadata(&path).unwrap().len());
    // binary search sanity: the byte inside turn 7's child event maps to it.
    let turn7_offset = index.turns[1].offset;
    assert_eq!(index.turn_at(turn7_offset + 10), Some(1));
    assert_eq!(index.turn_at(0), Some(0));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn index_roundtrips_and_detects_rotation() {
    let dir = std::env::temp_dir().join(format!("turn-index-rt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let trace = dir.join("trace.ljson");
    std::fs::write(
      &trace,
      "{\"op\":\"event\",\"seq\":1,\"parent\":null,\"ts\":\"2026-01-01T00:00:01Z\",\"level\":\"info\",\"loc\":{},\"fields\":{\"message\":\"x\"}}\n",
    )
    .unwrap();
    let index = scan_turn_index(&trace).unwrap();
    save_index(&trace, &index).unwrap();
    let loaded = load_index(&trace).expect("valid index loads");
    assert_eq!(loaded.turns, index.turns);
    assert_eq!(loaded.source_len, index.source_len);
    // An APPEND keeps the index valid (source_len <= live, head unchanged)…
    {
      use std::io::Write;
      let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&trace)
        .unwrap();
      writeln!(f, "{{\"op\":\"event\",\"seq\":2,\"parent\":null,\"ts\":\"2026-01-01T00:00:02Z\",\"level\":\"info\",\"loc\":{{}},\"fields\":{{}}}}").unwrap();
    }
    assert!(
      load_index(&trace).is_some(),
      "append keeps the index usable"
    );
    // …a REWRITE with a different head invalidates it.
    std::fs::write(&trace, "{\"v\":9,\"different\":true}\n").unwrap();
    assert!(load_index(&trace).is_none(), "rotation invalidates");
    let _ = std::fs::remove_dir_all(&dir);
  }
}

#[cfg(test)]
mod real_trace_probe {
  /// Manual probe: `TENTO_SCAN_PATH=<trace> cargo test -p tento-logger
  /// scan_real -- --ignored --nocapture`. Not part of the battery.
  #[test]
  #[ignore]
  fn scan_real() {
    let Some(path) = std::env::var_os("TENTO_SCAN_PATH") else {
      return;
    };
    let path = std::path::PathBuf::from(path);
    let started = std::time::Instant::now();
    let index = super::scan_turn_index(&path).expect("scan");
    eprintln!(
      "[scan-real] {:?} -> {} turns, {} bytes, in {:?}",
      path,
      index.turns.len(),
      index.source_len,
      started.elapsed()
    );
    let save_started = std::time::Instant::now();
    super::save_index(&path, &index).expect("save");
    eprintln!("[scan-real] saved in {:?}", save_started.elapsed());
  }
}
