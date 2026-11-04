//! The completion producer: derive the token, query providers, rank, and
//! atomically publish the view model.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::rank::{effective_prefix, rank};
use crate::seam::{Candidate, ProviderSet};

/// Cap on candidates written to the view model. The ranked list is truncated
/// here (never dropped mid-provider) — the pane shows a bounded set, and the
/// producer never emits an unbounded file.
pub const MAX_CANDIDATES: usize = 50;

/// The completion view model: the ranked candidates plus the prefix they were
/// computed for. The prefix travels with them so the pane can drop a paint that
/// no longer matches the live buffer (a stale write), and tests can assert the
/// candidates correspond to the prefix.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CandidatesVm {
  pub prefix: String,
  pub candidates: Vec<Candidate>,
}

/// The composer view model — the INPUT half of the completion wire, written by
/// the viewer and read by the engine-side producer. Where [`CandidatesVm`] is
/// the producer→chooser file, this is the composer→producer file: the live
/// buffer + caret the producer computes candidates for, plus the active `lane`
/// (whose policy the producer resolves) and a monotonic `seq`.
///
/// `seq` is the writer's own monotonic counter, carried so the producer can
/// DEDUPE — a re-publish with an unchanged `seq` (e.g. a spurious watcher
/// re-fire) is skipped — and so a Tab-open can force a recompute on an
/// otherwise-unchanged buffer by bumping it. `lane == None` is the `ctl`
/// control lane (the built-in default provider set).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ComposerVm {
  pub buffer: String,
  pub caret: usize,
  pub lane: Option<String>,
  pub seq: u64,
}

impl ComposerVm {
  /// Serialize + atomically replace `path` (temp + rename), the same
  /// never-torn write the candidates VM uses — the viewer's input path must
  /// never block on or half-write this file.
  pub fn write(&self, path: &Path) -> io::Result<()> {
    let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)
  }

  /// Read + parse the composer VM at `path`. A missing/partial/garbled file is
  /// an `io::Error` the caller log-and-skips (the producer treats it as "no
  /// change yet"), never a panic.
  pub fn read(path: &Path) -> io::Result<ComposerVm> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
  }
}

/// A synchronous composer publisher with bounded reusable serialization storage.
///
/// Every call writes and renames the complete VM, including an unchanged draft
/// with a new sequence. This does not batch, dedupe, defer, or query providers.
/// Use one writer per output path; the sibling temp name and error behavior
/// match `ComposerVm::write`. The input and lane are borrowed only for this call.
pub struct ComposerVmWriter {
  path: PathBuf,
  tmp: PathBuf,
  bytes: Vec<u8>,
}

// A retention bound, not an input-size limit: oversized VMs are still published.
const MAX_RETAINED_COMPOSER_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
struct BorrowedComposerVm<'a> {
  buffer: &'a str,
  caret: usize,
  lane: Option<&'a str>,
  seq: u64,
}

impl ComposerVmWriter {
  pub fn new(path: impl Into<PathBuf>) -> Self {
    let path = path.into();
    let tmp = path.with_extension("tmp");
    Self {
      path,
      tmp,
      bytes: Vec::new(),
    }
  }

  /// Publish before returning, using the existing JSON schema and temp+rename.
  pub fn write(
    &mut self,
    buffer: &str,
    caret: usize,
    lane: Option<&str>,
    seq: u64,
  ) -> io::Result<()> {
    self.bytes.clear();
    // Start small without growing once for every short JSON fragment.
    if self.bytes.capacity() == 0 {
      self.bytes.reserve(128);
    }
    let vm = BorrowedComposerVm {
      buffer,
      caret,
      lane,
      seq,
    };
    let result = (|| {
      serde_json::to_writer(&mut self.bytes, &vm).map_err(io::Error::other)?;
      std::fs::write(&self.tmp, &self.bytes)?;
      std::fs::rename(&self.tmp, &self.path)
    })();
    // No logical snapshot is retained, even after an I/O error. Large pastes
    // must not leave an unbounded per-view serialization allocation behind.
    self.bytes.clear();
    if self.bytes.capacity() > MAX_RETAINED_COMPOSER_BYTES {
      self.bytes = Vec::new();
    }
    result
  }
}

/// The completion producer: a [`ProviderSet`] and the output path it writes.
/// The path is injected — where in the session dir the VM lands is the caller's
/// decision, not this engine's.
pub struct CompletionEngine {
  providers: ProviderSet,
  out_path: PathBuf,
  max_candidates: usize,
}

impl CompletionEngine {
  /// Build the engine over `providers`, writing the VM to `out_path`.
  pub fn new(providers: ProviderSet, out_path: impl Into<PathBuf>) -> Self {
    CompletionEngine {
      providers,
      out_path: out_path.into(),
      max_candidates: MAX_CANDIDATES,
    }
  }

  /// Override the published-list cap. Ordinary completion stays bounded at
  /// [`MAX_CANDIDATES`]; finite command palettes can opt into their complete
  /// advertised vocabulary and let the chooser window scroll it.
  pub fn with_max_candidates(mut self, max_candidates: usize) -> Self {
    self.max_candidates = max_candidates;
    self
  }

  /// Recompute candidates for `buffer`/`caret` and atomically publish the VM.
  /// An EMPTY (or whitespace-only) buffer publishes an empty VM — an empty
  /// composer never completes. An empty token in a NON-empty buffer (the caret
  /// right after a space: the next-argument position) lists the full set — that
  /// is the "what can go here" ask. Otherwise it derives the effective match
  /// prefix ([`effective_prefix`], which applies the discovery-slash rule),
  /// queries every provider (tagging each candidate with its provider's set
  /// position for ranking), ranks ([`rank`]), caps at the configured maximum
  /// ([`MAX_CANDIDATES`] by default), and writes. The VM's `prefix` carries the EFFECTIVE prefix (a leading
  /// discovery `/` already stripped). A later call fully replaces the file
  /// (temp + rename), so a reader never sees a partial or appended list.
  pub fn update(&self, buffer: &str, caret: usize) -> io::Result<()> {
    // Only a blank BUFFER suppresses completion; a blank token mid-line is the
    // next-argument position and falls through to the full-set listing (the
    // empty prefix matches everything).
    if buffer.trim().is_empty() {
      let vm = CandidatesVm {
        prefix: String::new(),
        candidates: Vec::new(),
      };
      return write_vm(&self.out_path, &vm);
    }
    let prefix = effective_prefix(buffer, caret);
    let mut tagged = Vec::new();
    for (position, provider) in self.providers.iter().enumerate() {
      for candidate in provider.complete(prefix) {
        tagged.push((position, candidate));
      }
    }
    let mut candidates = rank(prefix, tagged);
    candidates.truncate(self.max_candidates);
    let vm = CandidatesVm {
      prefix: prefix.to_string(),
      candidates,
    };
    write_vm(&self.out_path, &vm)
  }
}

/// Serialize `vm` and replace `path` atomically: write a sibling temp file,
/// then rename over the target (a reader sees the whole file or the previous
/// one, never a half-written list). Mirrors the session layer's atomic replace
/// pattern.
fn write_vm(path: &Path, vm: &CandidatesVm) -> io::Result<()> {
  // Serialize the struct — never hand-build the JSON (repo rule).
  let bytes = serde_json::to_vec(vm).map_err(io::Error::other)?;
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, &bytes)?;
  std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::providers::{ListItem, ListProvider};
  use crate::seam::Provider;
  use std::rc::Rc;

  fn word_provider(name: &'static str, words: &[&str]) -> Box<dyn Provider> {
    let words: Vec<ListItem> = words.iter().map(|w| ListItem::new(*w, "")).collect();
    Box::new(ListProvider::new(name, Rc::new(move || words.clone())))
  }

  fn read_vm(path: &Path) -> CandidatesVm {
    let bytes = std::fs::read(path).expect("vm file exists");
    serde_json::from_slice(&bytes).expect("vm parses")
  }

  #[test]
  fn update_writes_a_parseable_vm_matching_the_prefix() {
    let dir = std::env::temp_dir().join(format!("tento-complete-engine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");

    let set = ProviderSet::new()
      .with(word_provider("a", &["session", "sessions", "scene"]))
      .with(word_provider("b", &["deploy"]));
    let engine = CompletionEngine::new(set, &out);

    // "ses|" — prefix "ses" from the composer.
    engine.update("ses", 3).unwrap();
    let vm = read_vm(&out);
    assert_eq!(vm.prefix, "ses");
    let inserts: Vec<&str> = vm.candidates.iter().map(|c| c.insert.as_str()).collect();
    // Prefix matches only; "deploy" and "scene" drop.
    assert!(inserts.contains(&"session"));
    assert!(inserts.contains(&"sessions"));
    assert!(
      !inserts.contains(&"scene"),
      "subsequence-only, no s-e-s: {inserts:?}"
    );
    assert!(!inserts.contains(&"deploy"), "{inserts:?}");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_second_update_replaces_and_stays_complete_json() {
    let dir = std::env::temp_dir().join(format!("tento-complete-replace-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");

    let set = ProviderSet::new().with(word_provider("a", &["alpha", "alto", "beta"]));
    let engine = CompletionEngine::new(set, &out);

    engine.update("al", 2).unwrap();
    let first = read_vm(&out);
    assert_eq!(first.prefix, "al");
    assert_eq!(first.candidates.len(), 2); // alpha, alto

    // A different prefix must REPLACE, not append.
    engine.update("be", 2).unwrap();
    let second = read_vm(&out);
    assert_eq!(second.prefix, "be");
    assert_eq!(second.candidates.len(), 1);
    assert_eq!(second.candidates[0].insert, "beta");

    // A blank buffer never lists everything — it publishes an empty VM.
    engine.update("", 0).unwrap();
    assert_eq!(read_vm(&out).candidates.len(), 0);

    // Full-set listing on a blank buffer is reachable only via "/".
    engine.update("/", 1).unwrap();
    assert_eq!(read_vm(&out).candidates.len(), 3);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn discovery_slash_publishes_the_effective_prefix() {
    let dir = std::env::temp_dir().join(format!("tento-complete-discovery-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");

    let set = ProviderSet::new().with(word_provider("a", &["session", "scene", "deploy"]));
    let engine = CompletionEngine::new(set, &out);

    // "/se|" — the discovery slash at char 0 strips to "se"; the VM prefix is
    // the effective one, and only "se"-prefixed items match.
    engine.update("/se", 3).unwrap();
    let vm = read_vm(&out);
    assert_eq!(vm.prefix, "se");
    let inserts: Vec<&str> = vm.candidates.iter().map(|c| c.insert.as_str()).collect();
    assert!(inserts.contains(&"session"), "{inserts:?}");
    assert!(!inserts.contains(&"deploy"), "{inserts:?}");

    // "/|" — full-set listing (empty effective prefix).
    engine.update("/", 1).unwrap();
    let vm = read_vm(&out);
    assert_eq!(vm.prefix, "");
    assert_eq!(vm.candidates.len(), 3);

    // "x /se|" — the '/se' token is NOT the first token, so it is matched
    // verbatim (no stripping); the published prefix keeps the slash.
    engine.update("x /se", 5).unwrap();
    assert_eq!(read_vm(&out).prefix, "/se");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_written_list_is_capped() {
    let dir = std::env::temp_dir().join(format!("tento-complete-cap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");

    let words: Vec<String> = (0..(MAX_CANDIDATES + 25))
      .map(|i| format!("cmd{i:04}"))
      .collect();
    let items: Vec<ListItem> = words.iter().map(|w| ListItem::new(w.clone(), "")).collect();
    let set = ProviderSet::new().with(Box::new(ListProvider::new(
      "many",
      Rc::new(move || items.clone()),
    )));
    let engine = CompletionEngine::new(set, &out);

    // Full-set listing via the "/" discovery token; the written list is capped.
    engine.update("/", 1).unwrap();
    assert_eq!(read_vm(&out).candidates.len(), MAX_CANDIDATES);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_finite_palette_can_publish_beyond_the_default_cap() {
    let dir =
      std::env::temp_dir().join(format!("tento-complete-palette-cap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");
    let count = MAX_CANDIDATES + 25;
    let items: Vec<ListItem> = (0..count)
      .map(|index| ListItem::new(format!("/cmd{index:04}"), ""))
      .collect();
    let set = ProviderSet::new().with(Box::new(ListProvider::new(
      "palette",
      Rc::new(move || items.clone()),
    )));
    let engine = CompletionEngine::new(set, &out).with_max_candidates(usize::MAX);

    engine.update("/", 1).unwrap();
    assert_eq!(read_vm(&out).candidates.len(), count);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn composer_vm_round_trips_through_the_file() {
    let dir = std::env::temp_dir().join(format!("tento-complete-composer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("composer.json");

    let vm = ComposerVm {
      buffer: "deploy fro".to_string(),
      caret: 10,
      lane: Some("ds".to_string()),
      seq: 42,
    };
    vm.write(&path).unwrap();
    let back = ComposerVm::read(&path).unwrap();
    assert_eq!(back, vm);

    // The ctl lane (no lane) also round-trips, and a re-write replaces.
    let ctl = ComposerVm {
      buffer: "ls".to_string(),
      caret: 2,
      lane: None,
      seq: 43,
    };
    ctl.write(&path).unwrap();
    assert_eq!(ComposerVm::read(&path).unwrap(), ctl);

    // A missing file is an Err (the producer's "no change yet"), never a panic.
    assert!(ComposerVm::read(&dir.join("absent.json")).is_err());

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_blank_buffer_publishes_an_empty_vm_but_a_next_argument_lists_all() {
    let dir = std::env::temp_dir().join(format!("tento-complete-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("candidates.json");

    let set = ProviderSet::new().with(word_provider("a", &["session", "scene", "deploy"]));
    let engine = CompletionEngine::new(set, &out);

    // Empty buffer: nothing to complete — an empty VM, not the full set.
    engine.update("", 0).unwrap();
    let vm = read_vm(&out);
    assert_eq!(vm.prefix, "");
    assert!(vm.candidates.is_empty());

    // Whitespace-only buffer counts as empty.
    engine.update("  ", 2).unwrap();
    assert!(read_vm(&out).candidates.is_empty());

    // Caret right after a space in a NON-empty buffer is the next-argument
    // position: the full set lists (Tab after "deploy " must show options).
    engine.update("deploy ", 7).unwrap();
    let vm = read_vm(&out);
    assert_eq!(vm.prefix, "");
    assert_eq!(vm.candidates.len(), 3);

    let _ = std::fs::remove_dir_all(&dir);
  }

  fn writer_dir(label: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
      "tento-composer-writer-{}-{}-{label}",
      std::process::id(),
      NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn borrowed_writer_matches_owned_wire_for_each_publication() {
    let dir = writer_dir("wire");
    let path = dir.join("composer.json");
    let mut writer = ComposerVmWriter::new(&path);
    for (buffer, caret, lane, seq) in [
      ("x", 1, None, 1),
      ("x", 1, None, 2), // unchanged draft still republishes
      ("quote\\\"\\\\\n\t\u{0000}", 3, Some("lane\\\""), 3),
      ("e\u{0301}界🦀", 2, Some("λ界"), u64::MAX),
      ("", 0, None, 0),
    ] {
      let owned = ComposerVm {
        buffer: buffer.to_owned(),
        caret,
        lane: lane.map(str::to_owned),
        seq,
      };
      writer.write(buffer, caret, lane, seq).unwrap();
      assert_eq!(
        std::fs::read(&path).unwrap(),
        serde_json::to_vec(&owned).unwrap()
      );
      assert_eq!(ComposerVm::read(&path).unwrap(), owned);
      assert!(writer.bytes.is_empty());
      assert!(writer.bytes.capacity() <= MAX_RETAINED_COMPOSER_BYTES);
      assert!(!path.with_extension("tmp").exists());
    }
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn oversized_publication_is_complete_but_scratch_retention_is_bounded() {
    let dir = writer_dir("large");
    let path = dir.join("composer.json");
    let mut writer = ComposerVmWriter::new(&path);
    let large = "🦀".repeat(MAX_RETAINED_COMPOSER_BYTES);
    writer
      .write(&large, large.chars().count(), Some("ds"), 7)
      .unwrap();
    assert_eq!(
      ComposerVm::read(&path).unwrap(),
      ComposerVm {
        buffer: large.clone(),
        caret: large.chars().count(),
        lane: Some("ds".into()),
        seq: 7
      }
    );
    assert!(writer.bytes.is_empty());
    assert!(writer.bytes.capacity() <= MAX_RETAINED_COMPOSER_BYTES);
    writer.write("x", 1, None, 8).unwrap();
    assert_eq!(
      ComposerVm::read(&path).unwrap(),
      ComposerVm {
        buffer: "x".into(),
        caret: 1,
        lane: None,
        seq: 8,
      }
    );
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn failed_write_and_rename_clear_scratch_and_allow_fresh_recovery() {
    let dir = writer_dir("failure");
    let path = dir.join("missing").join("composer.json");
    let mut writer = ComposerVmWriter::new(&path);
    assert!(writer.write("first", 5, None, 1).is_err());
    assert!(writer.bytes.is_empty());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    writer.write("ready", 5, None, 2).unwrap();
    let old = std::fs::read(&path).unwrap();

    // A blocked temp write must leave the published file intact.
    std::fs::create_dir(&writer.tmp).unwrap();
    assert!(writer.write("blocked", 7, Some("ds"), 3).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), old);
    assert!(writer.bytes.is_empty());
    std::fs::remove_dir(&writer.tmp).unwrap();
    writer.write("recovered", 9, Some("ds"), 4).unwrap();
    assert_eq!(ComposerVm::read(&path).unwrap().seq, 4);

    // A successful temp write followed by a failed rename has the same
    // recoverable error boundary as the legacy writer.
    let blocked = dir.join("directory.json");
    std::fs::create_dir(&blocked).unwrap();
    let mut rename_writer = ComposerVmWriter::new(&blocked);
    assert!(rename_writer.write("x", 1, None, 5).is_err());
    assert!(rename_writer.bytes.is_empty());
    std::fs::remove_dir(&blocked).unwrap();
    rename_writer.write("final", 5, None, 6).unwrap();
    assert_eq!(ComposerVm::read(&blocked).unwrap().buffer, "final");
    std::fs::remove_dir_all(dir).unwrap();
  }
}
