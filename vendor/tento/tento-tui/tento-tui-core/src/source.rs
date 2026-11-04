//! Filesystem-backed pane data sources.
//!
//! A pane source is an LJSON file: the **first line is a [`Header`]**
//! declaring the pane's `shape`, followed by one JSON record per line. A
//! producer appends records with [`PaneWriter`]; any number of independent
//! readers follow the same file with [`PaneReader`] — the file is the only
//! contract between them.
//!
//! ```text
//! {"v":1,"shape":"calc-log/v1","encoding":"records","created_ms":1716200000000}
//! {"ts_ms":1716200001234,"kind":"eval","input":"2+2","result":4.0}
//! {"ts_ms":1716200005111,"kind":"eval","input":"4*10","result":40.0}
//! ```
//!
//! This is the append-only (log) writer. A rewrite-with-dedup writer for
//! whole-state shapes (the `SnapshotWriter` lineage) is a separate primitive
//! to add when the first state-shaped pane lands.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bumped when the on-disk envelope (header + line framing) changes.
pub const ENVELOPE_VERSION: u32 = 1;

/// The first line of every pane file. Self-describes the stream so a generic
/// reader can dispatch on `shape` without prior knowledge of the producer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
  pub v: u32,
  /// Shape id, e.g. `"calc-log/v1"`, `"tree/v1"`, `"lines/v1"`.
  pub shape: String,
  /// How the record lines reconstruct the value, e.g. `"records"`.
  pub encoding: String,
  /// Producer start time (epoch millis).
  pub created_ms: i64,
}

/// Append-only producer side of a pane file.
///
/// [`create`](PaneWriter::create) truncates and writes a fresh [`Header`] —
/// each producer run starts a clean stream. [`append`](PaneWriter::append)
/// serializes one record to a single line and flushes, so a following reader
/// only ever sees whole lines.
pub struct PaneWriter {
  file: File,
  path: PathBuf,
}

impl PaneWriter {
  /// Create (or truncate) the pane file and write its header.
  pub fn create(
    path: impl AsRef<Path>,
    shape: impl Into<String>,
    encoding: impl Into<String>,
  ) -> io::Result<Self> {
    let path = path.as_ref().to_path_buf();
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
      .create(true)
      .write(true)
      .truncate(true)
      .open(&path)?;
    let mut w = PaneWriter { file, path };
    let header = Header {
      v: ENVELOPE_VERSION,
      shape: shape.into(),
      encoding: encoding.into(),
      created_ms: chrono::Utc::now().timestamp_millis(),
    };
    w.write_line(&serde_json::to_string(&header)?)?;
    Ok(w)
  }

  /// Append one record as a single JSON line, then flush.
  pub fn append<T: Serialize>(&mut self, record: &T) -> io::Result<()> {
    let line = serde_json::to_string(record)?;
    self.write_line(&line)
  }

  /// Open an existing pane stream for append without replacing its header or
  /// records. Callers must validate the stream shape before choosing this over
  /// [`create`](Self::create).
  pub fn open_append(path: impl AsRef<Path>) -> io::Result<Self> {
    let path = path.as_ref().to_path_buf();
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok(PaneWriter { file, path })
  }

  /// Path this writer is producing to.
  pub fn path(&self) -> &Path {
    &self.path
  }

  fn write_line(&mut self, line: &str) -> io::Result<()> {
    self.reattach_if_replaced()?;
    self.file.write_all(line.as_bytes())?;
    self.file.write_all(b"\n")?;
    self.file.flush()
  }

  /// Atomic backfills replace a pathname while an append-only producer may
  /// still hold the prior inode open. Reattach before the next write so live
  /// output follows the canonical path instead of disappearing into an
  /// unlinked file descriptor.
  fn reattach_if_replaced(&mut self) -> io::Result<()> {
    let open = self.file.metadata()?;
    let current = match fs::metadata(&self.path) {
      Ok(metadata) => metadata,
      Err(error) if error.kind() == io::ErrorKind::NotFound => {
        self.file = OpenOptions::new()
          .create(true)
          .append(true)
          .open(&self.path)?;
        return Ok(());
      }
      Err(error) => return Err(error),
    };
    if file_identity(&open) != file_identity(&current) {
      self.file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&self.path)?;
    }
    Ok(())
  }
}

/// Filesystem identity of a file — the pair that answers "is the name still
/// bound to the bytes this handle holds open?".
///
/// `None` means the platform (or this particular file) cannot answer, in
/// which case two `None`s compare equal and the writer stays attached, the
/// same no-op the non-unix arm used to be.
#[cfg(unix)]
pub fn file_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
  use std::os::unix::fs::MetadataExt;
  Some((metadata.dev(), metadata.ino()))
}

/// Windows' dev/ino: the volume serial number plus the 64-bit file index from
/// `BY_HANDLE_FILE_INFORMATION`. A rotated or rewritten-in-place ljson gets a
/// new index, so the writer follows the pathname instead of appending into
/// the unlinked file it still holds open. std exposes both behind the nightly
/// `windows_by_handle` feature, enabled for `cfg(windows)` only at the crate
/// root; the fields are absent when `fs::metadata` had to fall back to
/// `FindFirstFileExW` past a share-mode conflict.
#[cfg(windows)]
pub fn file_identity(metadata: &fs::Metadata) -> Option<(u64, u64)> {
  use std::os::windows::fs::MetadataExt;
  Some((
    u64::from(metadata.volume_serial_number()?),
    metadata.file_index()?,
  ))
}

#[cfg(not(any(unix, windows)))]
pub fn file_identity(_metadata: &fs::Metadata) -> Option<(u64, u64)> {
  None
}

/// Following consumer side of a pane file.
///
/// [`poll`](PaneReader::poll) returns the record lines appended since the last
/// call. It reads only the bytes past the last poll's end — a pane file grows
/// for as long as its pane lives, and re-reading all of it on every tick (the
/// first form of this reader) made each poll cost the pane's whole history —
/// carrying a partial trailing line until its newline arrives. A file that
/// shrank is a producer that truncated and restarted: the cursor resets and
/// the new stream's records come from the top.
pub struct PaneReader {
  path: PathBuf,
  /// Bytes consumed so far; the next poll reads from here.
  offset: u64,
  /// An unterminated last line, kept until the rest of it lands.
  partial: Vec<u8>,
  /// The next complete line is the header, not a record.
  expect_header: bool,
}

impl PaneReader {
  /// Open an existing pane file and read its [`Header`]. Returns
  /// `Ok(None)` for the header if the file exists but has no header line yet.
  pub fn open(path: impl AsRef<Path>) -> io::Result<(Option<Header>, Self)> {
    let path = path.as_ref().to_path_buf();
    let header = match File::open(&path) {
      Ok(f) => {
        let mut first = String::new();
        io::BufReader::new(f).read_line(&mut first)?;
        first
          .strip_suffix('\n')
          .and_then(|line| serde_json::from_str::<Header>(line).ok())
      }
      Err(e) if e.kind() == io::ErrorKind::NotFound => None,
      Err(e) => return Err(e),
    };
    Ok((
      header,
      PaneReader {
        path,
        offset: 0,
        partial: Vec::new(),
        expect_header: true,
      },
    ))
  }

  /// Record lines (raw JSON) appended since the previous poll. If the file
  /// shrank (producer restarted), the cursor resets and the new stream's
  /// records are returned from the top.
  pub fn poll(&mut self) -> io::Result<Vec<String>> {
    let mut file = match File::open(&self.path) {
      Ok(f) => f,
      Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
      Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    if len < self.offset {
      // Producer truncated and started a fresh stream.
      self.offset = 0;
      self.partial.clear();
      self.expect_header = true;
    }
    if len == self.offset {
      return Ok(Vec::new());
    }
    file.seek(io::SeekFrom::Start(self.offset))?;
    let mut tail = std::mem::take(&mut self.partial);
    let read = file.read_to_end(&mut tail)?;
    self.offset += read as u64;

    let mut fresh = Vec::new();
    let mut rest = tail.as_slice();
    while let Some(at) = rest.iter().position(|&b| b == b'\n') {
      let line = &rest[..at];
      rest = &rest[at + 1..];
      if self.expect_header {
        self.expect_header = false;
        continue;
      }
      fresh.push(String::from_utf8_lossy(line).into_owned());
    }
    self.partial = rest.to_vec();
    Ok(fresh)
  }
}

/// Read the whole file once and split it into the header (line 0) and the
/// record lines (the rest), dropping the trailing empty segment after the
/// final newline. Returns `(None, [])` if the file is empty. For a one-shot
/// reader that wants the file as it stands; a follower uses [`PaneReader`].
pub fn read_all(path: &Path) -> io::Result<(Option<Header>, Vec<String>)> {
  read_lines(path)
}

fn read_lines(path: &Path) -> io::Result<(Option<Header>, Vec<String>)> {
  let mut buf = String::new();
  match File::open(path) {
    Ok(mut f) => {
      f.read_to_string(&mut buf)?;
    }
    Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((None, Vec::new())),
    Err(e) => return Err(e),
  }
  let mut lines = buf.split('\n').collect::<Vec<_>>();
  // Drop the trailing "" produced by the final newline (or a not-yet-complete
  // partial line — we only emit fully-terminated lines).
  if lines.last() == Some(&"") {
    lines.pop();
  }
  let mut iter = lines.into_iter();
  let header = match iter.next() {
    Some(h) => serde_json::from_str::<Header>(h).ok(),
    None => None,
  };
  let records = iter.map(|s| s.to_string()).collect();
  Ok((header, records))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Serialize, Deserialize, PartialEq, Debug)]
  struct Rec {
    n: i64,
  }

  #[test]
  fn header_then_follow_appends() {
    let dir = std::env::temp_dir().join(format!("tento-tui-test-{}", std::process::id()));
    let path = dir.join("pane.ljson");

    let mut w = PaneWriter::create(&path, "test/v1", "records").unwrap();
    w.append(&Rec { n: 1 }).unwrap();

    let (header, mut r) = PaneReader::open(&path).unwrap();
    let header = header.expect("header present");
    assert_eq!(header.shape, "test/v1");
    assert_eq!(header.v, ENVELOPE_VERSION);

    // First poll sees the one record written so far.
    let first = r.poll().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
      serde_json::from_str::<Rec>(&first[0]).unwrap(),
      Rec { n: 1 }
    );

    // Nothing new yet.
    assert!(r.poll().unwrap().is_empty());

    // Producer appends more; follower picks up only the new lines.
    w.append(&Rec { n: 2 }).unwrap();
    w.append(&Rec { n: 3 }).unwrap();
    let next = r.poll().unwrap();
    assert_eq!(next.len(), 2);

    // Restart truncates the stream; follower resets and re-reads from top.
    let mut w2 = PaneWriter::create(&path, "test/v1", "records").unwrap();
    w2.append(&Rec { n: 9 }).unwrap();
    let after_restart = r.poll().unwrap();
    assert_eq!(after_restart.len(), 1);
    assert_eq!(
      serde_json::from_str::<Rec>(&after_restart[0]).unwrap(),
      Rec { n: 9 }
    );

    let _ = fs::remove_dir_all(&dir);
  }

  /// The follower reads only what was appended, and never emits half a line:
  /// a record written without its newline waits until the newline lands,
  /// then arrives whole, with the header still skipped after a restart.
  #[test]
  fn a_partial_line_waits_for_its_newline() {
    let dir = std::env::temp_dir().join(format!("tento-tui-partial-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pane.ljson");
    let mut w = PaneWriter::create(&path, "test/v1", "records").unwrap();
    w.append(&Rec { n: 1 }).unwrap();
    let (_, mut r) = PaneReader::open(&path).unwrap();
    assert_eq!(r.poll().unwrap().len(), 1);

    {
      let mut raw = fs::OpenOptions::new().append(true).open(&path).unwrap();
      raw.write_all(b"{\"n\":").unwrap();
    }
    assert!(r.poll().unwrap().is_empty(), "no newline yet, nothing emitted");
    {
      let mut raw = fs::OpenOptions::new().append(true).open(&path).unwrap();
      raw.write_all(b"2}\n").unwrap();
    }
    let whole = r.poll().unwrap();
    assert_eq!(whole.len(), 1);
    assert_eq!(serde_json::from_str::<Rec>(&whole[0]).unwrap(), Rec { n: 2 });

    // A restart in the middle of a partial line drops the fragment too.
    {
      let mut raw = fs::OpenOptions::new().append(true).open(&path).unwrap();
      raw.write_all(b"{\"n\":").unwrap();
    }
    assert!(r.poll().unwrap().is_empty());
    let mut w2 = PaneWriter::create(&path, "test/v1", "records").unwrap();
    w2.append(&Rec { n: 7 }).unwrap();
    let after = r.poll().unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(serde_json::from_str::<Rec>(&after[0]).unwrap(), Rec { n: 7 });
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn writer_reattaches_after_atomic_path_replacement() {
    let dir = std::env::temp_dir().join(format!("tento-tui-reattach-{}", std::process::id()));
    let path = dir.join("pane.ljson");
    let replacement = dir.join("replacement.ljson");
    let mut writer = PaneWriter::create(&path, "test/v1", "records").unwrap();
    writer.append(&Rec { n: 1 }).unwrap();

    let mut next = PaneWriter::create(&replacement, "test/v1", "records").unwrap();
    next.append(&Rec { n: 9 }).unwrap();
    fs::rename(&replacement, &path).unwrap();

    writer.append(&Rec { n: 2 }).unwrap();
    let (_, records) = read_lines(&path).unwrap();
    let values = records
      .iter()
      .map(|line| serde_json::from_str::<Rec>(line).unwrap().n)
      .collect::<Vec<_>>();
    assert_eq!(values, vec![9, 2]);
    let _ = fs::remove_dir_all(&dir);
  }
}
