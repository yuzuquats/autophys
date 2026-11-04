//! Reuse of a verified, unchanged frontend build across a restart (O08).
//!
//! `Bundler::clean_and_build_all` deletes and rewrites its whole output tree.
//! After a clean, quiet build it now also writes a *stamp* beside that tree
//! recording everything the build depended on and everything it wrote; the
//! next call skips the clean and the rebuild only when every recorded fact
//! still holds. Any doubt is a miss: an unreadable file, a parse failure, a
//! schema or tool change, an input whose mtime falls inside the build window.
//!
//! Hashes are the only positive evidence. Modification times are used in one
//! direction only, to *refuse* writing a stamp for a build whose inputs may
//! have changed while it ran.
//!
//! The stamp lives in `<output parent>/.tento-build-reuse/<output name>.json`:
//! outside the served tree, and outside what a promote copies.

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
  collections::{BTreeMap, BTreeSet},
  fs,
  io::Read,
  path::{Path, PathBuf},
  time::{Duration, SystemTime},
};

/// Bump when the stamp's meaning changes; an unknown schema is a miss.
/// 2: resolver probes (`missing`, `present`, `links`).
const SCHEMA: u32 = 2;
const STAMP_DIR: &str = ".tento-build-reuse";
/// `TENTO_WEB_BUILD_REUSE=0` turns reuse (and stamp writing) off.
pub const REUSE_ENV: &str = "TENTO_WEB_BUILD_REUSE";

/// Rewritten on every build and every reuse, so it is not an output the stamp
/// can vouch for.
pub(super) const UNSTAMPED_OUTPUTS: &[&str] = &["build-status.json", "build-status.json.tmp"];

/// Files beside an input (or above it) that change how esbuild or Deno
/// resolves it without being an input themselves. Their contents, or their
/// absence, are part of the stamp for every directory above an input.
const RESOLUTION_FILES: &[&str] = &[
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
];

/// Environment that reaches the build: the per-file emitter's barrel knob, the
/// build-stamp commit override, Deno's config and anything esbuild reads.
const ENV_NAMES: &[&str] = &[
  "TENTO_BUILD_GIT_HASH",
  "LONA_INLINE_BARRELS",
  "DENO_CONFIG",
  "NODE_ENV",
  "NODE_PATH",
];
const ENV_PREFIXES: &[&str] = &["ESBUILD_", "DENO_"];

/// A write within this long before the build started still counts as during
/// it: coarse filesystem clocks stamp a write slightly in the past.
const MTIME_SLACK: Duration = Duration::from_millis(100);
/// A whole-second mtime may come from a filesystem with 1–2 s resolution.
const COARSE_MTIME_SLACK: Duration = Duration::from_secs(2);

pub(super) fn enabled() -> bool {
  std::env::var(REUSE_ENV).map_or(true, |v| v.trim() != "0")
}

pub(super) fn stamp_path(output_dir: &Path) -> Option<PathBuf> {
  let parent = output_dir.parent()?;
  let name = output_dir.file_name()?;
  let mut file = name.to_os_string();
  file.push(".json");
  Some(parent.join(STAMP_DIR).join(file))
}

/// What a build was configured with, before anything is read: the parts of
/// the key that do not depend on the build's own inputs.
pub(super) struct BuildConfig<'a> {
  pub html_root: &'a Path,
  pub output_dir: &'a Path,
  pub store: Option<&'a Path>,
  pub fleet_prefix: Option<&'a str>,
  /// The tento-web crate dir (`TENTO_WEB`): where the build scripts live.
  pub tento_web: &'a Path,
}

/// What one build read and wrote, gathered by the build steps.
#[derive(Debug, Default)]
pub(super) struct BuildEvidence {
  /// Every file either esbuild pass read, vendor included.
  pub inputs: BTreeSet<PathBuf>,
  /// Store URLs (`/js/m/...`) the unbundled manifests reference.
  pub store_urls: BTreeSet<String>,
  /// Where the resolver looked, as the worker's replay of it reports
  /// (`bundler-resolution.deno.ts`), reduced to facts by `ProbeFacts`.
  pub probes: ProbeFacts,
  /// package.json files whose contents decided a resolution.
  pub probe_reads: BTreeSet<PathBuf>,
  /// Candidate spelling → the real file esbuild read, where a symlink sits
  /// between them.
  pub links: BTreeMap<PathBuf, PathBuf>,
}

/// What a set of resolver probes found, in a form a later check can repeat:
/// each probed path either exists (with its kind, symlinks followed), or is
/// missing because a directory above it has no entry of that name. A missing
/// probe is recorded at its deepest existing ancestor, so creating the path —
/// or any directory on the way to it — shows up as a new entry there. Names
/// are compared case-insensitively, as esbuild looks them up.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub(super) struct ProbeFacts {
  /// Directory → names that must stay absent from it.
  pub missing: BTreeMap<PathBuf, BTreeSet<String>>,
  /// Path → `f`ile, `d`irectory or `o`ther.
  pub present: BTreeMap<PathBuf, char>,
}

/// A probe's kind as the resolver replay saw it (`bundler-resolution.deno.ts`):
/// `file`, `dir` or `other`; `null` on the wire when there was no such entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Seen {
  File,
  Dir,
  Other,
}

impl Seen {
  /// The `ProbeFacts::present` code of this kind.
  pub fn code(self) -> char {
    match self {
      Seen::File => 'f',
      Seen::Dir => 'd',
      Seen::Other => 'o',
    }
  }
}

impl ProbeFacts {
  /// Facts for `probes`, each with the kind (`kind_of` code) the replay saw
  /// there, or `None` where it saw nothing. Every probe is stat'ed again
  /// here; one that no longer matches what the resolver saw changed during
  /// the build, and the build gets no stamp. Only the probes themselves are
  /// compared, so an unrelated entry added beside one does not matter.
  pub fn collect<'a>(
    probes: impl IntoIterator<Item = (&'a Path, Option<char>)>,
  ) -> anyhow::Result<ProbeFacts> {
    let mut facts = ProbeFacts::default();
    for (probe, seen) in probes {
      if !probe.is_absolute() {
        bail!("probe {} is not absolute", probe.display());
      }
      let fact = probe_fact(probe)?;
      let now = match &fact {
        Fact::Present(path, kind) if path == probe => Some(*kind),
        _ => None,
      };
      if now != seen {
        bail!(
          "{} changed during the build: the resolver saw {}, it is now {}",
          probe.display(),
          describe(seen),
          describe(now)
        );
      }
      match fact {
        Fact::Present(path, kind) => {
          facts.present.insert(path, kind);
        }
        Fact::Missing(dir, name) => {
          facts.missing.entry(dir).or_default().insert(name);
        }
      }
    }
    // A name esbuild would match in another case is not missing to it.
    for (dir, names) in &facts.missing {
      let found = lowercase_entries(dir).with_context(|| format!("list {}", dir.display()))?;
      if let Some(name) = names.iter().find(|n| found.contains(&n.to_lowercase())) {
        bail!(
          "{} exists in another case or appeared while probing",
          dir.join(name).display()
        );
      }
    }
    Ok(facts)
  }

  /// The first fact that no longer holds.
  fn first_change(&self) -> Option<PathBuf> {
    for (path, kind) in &self.present {
      if fs::metadata(path).ok().map(|m| kind_of(&m)) != Some(*kind) {
        return Some(path.clone());
      }
    }
    for (dir, names) in &self.missing {
      let Ok(found) = lowercase_entries(dir) else {
        return Some(dir.clone());
      };
      if let Some(name) = names.iter().find(|n| found.contains(&n.to_lowercase())) {
        return Some(dir.join(name));
      }
    }
    None
  }

  /// The missing paths' first absent component, which is what a dev watcher
  /// sees created: watching each one's directory covers the whole probe.
  pub fn watch_paths(&self) -> Vec<PathBuf> {
    self
      .missing
      .iter()
      .flat_map(|(dir, names)| names.iter().map(move |n| dir.join(n)))
      .collect()
  }
}

enum Fact {
  Present(PathBuf, char),
  Missing(PathBuf, String),
}

fn describe(kind: Option<char>) -> &'static str {
  match kind {
    Some('f') => "a file",
    Some('d') => "a directory",
    Some(_) => "another kind of entry",
    None => "nothing",
  }
}

fn kind_of(meta: &fs::Metadata) -> char {
  if meta.is_dir() {
    'd'
  } else if meta.is_file() {
    'f'
  } else {
    'o'
  }
}

/// The probe as it stands: it exists, or the deepest existing path above it
/// is a directory missing the next component (or a file, which the probe
/// cannot be under until it is replaced).
fn probe_fact(probe: &Path) -> anyhow::Result<Fact> {
  match fs::metadata(probe) {
    Ok(m) => return Ok(Fact::Present(probe.to_path_buf(), kind_of(&m))),
    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
      bail!("stat {}: {e}", probe.display())
    }
    Err(_) => {}
  }
  let mut child = probe;
  loop {
    let parent = child
      .parent()
      .with_context(|| format!("{} has no existing ancestor", probe.display()))?;
    match fs::metadata(parent) {
      Ok(m) if m.is_dir() => {
        let name = child
          .file_name()
          .and_then(|n| n.to_str())
          .with_context(|| format!("{} is not a UTF-8 name", child.display()))?;
        return Ok(Fact::Missing(parent.to_path_buf(), name.to_string()));
      }
      Ok(m) => return Ok(Fact::Present(parent.to_path_buf(), kind_of(&m))),
      Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
        bail!("stat {}: {e}", parent.display())
      }
      Err(_) => child = parent,
    }
  }
}

fn lowercase_entries(dir: &Path) -> std::io::Result<BTreeSet<String>> {
  let mut names = BTreeSet::new();
  for entry in fs::read_dir(dir)? {
    names.insert(entry?.file_name().to_string_lossy().to_lowercase());
  }
  Ok(names)
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Stamp {
  schema: u32,
  /// sha-256 over tool identity and configuration.
  key: String,
  /// Absolute path → sha-256: inputs, the html tree, build scripts, the
  /// resolution files found above inputs, tsconfig `extends` targets.
  files: BTreeMap<PathBuf, String>,
  /// Resolution files that must still be absent.
  absent: BTreeSet<PathBuf>,
  /// Directory → sha-256 of its sorted entry names: every html-tree directory
  /// and every directory holding an input, so additions and deletions show.
  listings: BTreeMap<PathBuf, String>,
  /// Directory → git HEAD a `build-stamp.ts` inside it would be stamped with.
  heads: BTreeMap<PathBuf, Option<String>>,
  /// Output-relative path → sha-256 of everything the build wrote.
  outputs: BTreeMap<PathBuf, String>,
  /// Output-relative directories the build created.
  output_dirs: BTreeSet<PathBuf>,
  /// Store-relative path → sha-256 of every module the manifests reference.
  store_files: BTreeMap<PathBuf, String>,
  /// The report's watch set (`BuildReport::inputs`), returned on reuse.
  watch_inputs: Vec<PathBuf>,
  /// What the resolver probed and found missing or present.
  probes: ProbeFacts,
  /// Candidate spelling → real path, for resolutions through a symlink.
  links: BTreeMap<PathBuf, PathBuf>,
}

/// Why a stamp did not verify, for the log.
#[derive(Debug, PartialEq)]
pub(super) enum Miss {
  NoStamp,
  Unreadable(String),
  Schema,
  Key,
  Changed(PathBuf),
  OutputChanged(PathBuf),
  Unsupported(String),
}

impl std::fmt::Display for Miss {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Miss::NoStamp => write!(f, "no stamp"),
      Miss::Unreadable(why) => write!(f, "stamp unreadable: {why}"),
      Miss::Schema => write!(f, "stamp schema changed"),
      Miss::Key => write!(f, "tool or configuration changed"),
      Miss::Changed(path) => write!(f, "input changed: {}", path.display()),
      Miss::OutputChanged(path) => write!(f, "output missing or changed: {}", path.display()),
      Miss::Unsupported(why) => write!(f, "not verifiable: {why}"),
    }
  }
}

/// The verified result of a reuse: the report's watch set, and the output
/// files the stamp does not record (to prune, as a clean would have).
pub(super) struct Reuse {
  pub watch_inputs: Vec<PathBuf>,
  /// `ProbeFacts::watch_paths` of the recorded build.
  pub watch_probes: Vec<PathBuf>,
  pub extra_files: Vec<PathBuf>,
  pub extra_dirs: Vec<PathBuf>,
}

/// Check the stamp for `config` against the filesystem. `Ok` only when every
/// recorded fact still holds.
pub(super) fn verify(config: &BuildConfig) -> Result<Reuse, Miss> {
  let path = stamp_path(config.output_dir).ok_or(Miss::NoStamp)?;
  let text = match fs::read_to_string(&path) {
    Ok(text) => text,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Miss::NoStamp),
    Err(e) => return Err(Miss::Unreadable(e.to_string())),
  };
  let stamp: Stamp = serde_json::from_str(&text).map_err(|e| Miss::Unreadable(e.to_string()))?;
  if stamp.schema != SCHEMA {
    return Err(Miss::Schema);
  }
  if stamp.key != key(config).map_err(|e| Miss::Unsupported(format!("{e:#}")))? {
    return Err(Miss::Key);
  }
  // Cheapest first: existence, then listings, then contents.
  for absent in &stamp.absent {
    if fs::symlink_metadata(absent).is_ok() {
      return Err(Miss::Changed(absent.clone()));
    }
  }
  for (dir, hash) in &stamp.listings {
    if listing_hash(dir).ok().as_ref() != Some(hash) {
      return Err(Miss::Changed(dir.clone()));
    }
  }
  // Where the resolver looked and found nothing (a `paths` target ahead of
  // the one that matched, a `.tsx` beside a `.ts`, a node_modules level):
  // anything there now could change what a fresh build resolves.
  if let Some(changed) = stamp.probes.first_change() {
    return Err(Miss::Changed(changed));
  }
  for (spelling, real) in &stamp.links {
    if fs::canonicalize(spelling).ok().as_ref() != Some(real) {
      return Err(Miss::Changed(spelling.clone()));
    }
  }
  // The html tree is re-walked, not just re-read: a file added anywhere under
  // it changes a listing above, but a new subdirectory's own files are only
  // seen by walking.
  let (tree_files, tree_dirs) =
    walk_tree(config.html_root).map_err(|e| Miss::Unreadable(format!("{e:#}")))?;
  for dir in &tree_dirs {
    if !stamp.listings.contains_key(dir) {
      return Err(Miss::Changed(dir.clone()));
    }
  }
  for file in &tree_files {
    if !stamp.files.contains_key(file) {
      return Err(Miss::Changed(file.clone()));
    }
  }
  for (dir, head) in &stamp.heads {
    if &stamp_head(dir) != head {
      return Err(Miss::Changed(dir.clone()));
    }
  }
  if let Some(changed) = first_mismatch(stamp.files.iter().map(|(p, h)| (p.clone(), h.clone()))) {
    return Err(Miss::Changed(changed));
  }
  if !stamp.store_files.is_empty() {
    let store = config
      .store
      .ok_or_else(|| Miss::Unsupported("stamp records store files but there is no store".into()))?;
    if let Some(changed) = first_mismatch(
      stamp
        .store_files
        .iter()
        .map(|(p, h)| (store.join(p), h.clone())),
    ) {
      return Err(Miss::OutputChanged(changed));
    }
  }
  if let Some(changed) = first_mismatch(
    stamp
      .outputs
      .iter()
      .map(|(p, h)| (config.output_dir.join(p), h.clone())),
  ) {
    return Err(Miss::OutputChanged(changed));
  }

  // Anything else under the output dir was not written by the build (the
  // previous artifact hook's files, a packager's health.json): a clean would
  // have removed it, so the caller does.
  let (out_files, out_dirs) =
    walk_outputs(config.output_dir).map_err(|e| Miss::Unreadable(format!("{e:#}")))?;
  let extra_files = out_files
    .into_iter()
    .filter(|rel| !stamp.outputs.contains_key(rel) && !is_unstamped(rel))
    .map(|rel| config.output_dir.join(rel))
    .collect();
  let extra_dirs = out_dirs
    .into_iter()
    .filter(|rel| !stamp.output_dirs.contains(rel))
    .map(|rel| config.output_dir.join(rel))
    .collect();
  Ok(Reuse {
    watch_probes: stamp.probes.watch_paths(),
    watch_inputs: stamp.watch_inputs,
    extra_files,
    extra_dirs,
  })
}

/// Remove the stamp, before a clean: an interrupted build must not leave a
/// stamp describing a tree that no longer exists.
pub(super) fn invalidate(output_dir: &Path) {
  if let Some(path) = stamp_path(output_dir) {
    let _ = fs::remove_file(path);
  }
}

/// Record a finished build. Returns why it did not when it declines: a build
/// with errors never gets a stamp, and neither does one whose inputs may have
/// been edited while it ran.
pub(super) fn record(
  config: &BuildConfig,
  evidence: &BuildEvidence,
  watch_inputs: &[PathBuf],
  build_started: SystemTime,
) -> anyhow::Result<()> {
  let path = stamp_path(config.output_dir).context("output dir has no parent for a stamp")?;
  let stamp = collect(config, evidence, watch_inputs, build_started)?;
  let dir = path.parent().expect("stamp path has a parent");
  fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
  let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
  fs::write(&tmp, serde_json::to_vec(&stamp)?)
    .with_context(|| format!("write {}", tmp.display()))?;
  fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
  Ok(())
}

fn collect(
  config: &BuildConfig,
  evidence: &BuildEvidence,
  watch_inputs: &[PathBuf],
  build_started: SystemTime,
) -> anyhow::Result<Stamp> {
  let key = key(config)?;
  let (tree_files, tree_dirs) = walk_tree(config.html_root)?;

  let mut file_set: BTreeSet<PathBuf> = BTreeSet::new();
  file_set.extend(tree_files.iter().cloned());
  for input in &evidence.inputs {
    file_set.insert(absolute(input)?);
  }
  file_set.extend(tool_files(config.tento_web)?);
  for read in &evidence.probe_reads {
    file_set.insert(absolute(read)?);
  }

  // Directories whose entries decide resolution: every directory holding an
  // input. Their ancestors (and the build scripts' own, for deno.json) are
  // probed for resolution files.
  let mut listing_dirs: BTreeSet<PathBuf> = tree_dirs.iter().cloned().collect();
  for input in &evidence.inputs {
    if let Some(dir) = absolute(input)?.parent() {
      listing_dirs.insert(dir.to_path_buf());
    }
  }
  let mut probe_dirs: BTreeSet<PathBuf> = BTreeSet::new();
  for file in &file_set {
    if let Some(dir) = file.parent() {
      for ancestor in dir.ancestors() {
        if !probe_dirs.insert(ancestor.to_path_buf()) {
          break;
        }
      }
    }
  }
  let client_dir = config.tento_web.join("src/client");
  for ancestor in client_dir.ancestors() {
    probe_dirs.insert(ancestor.to_path_buf());
  }

  let mut absent = BTreeSet::new();
  for dir in &probe_dirs {
    for name in RESOLUTION_FILES {
      let candidate = dir.join(name);
      match fs::metadata(&candidate) {
        Ok(meta) if meta.is_file() => {
          file_set.insert(candidate);
        }
        Ok(_) => bail!("{} is not a file", candidate.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
          absent.insert(candidate);
        }
        Err(e) => bail!("stat {}: {e}", candidate.display()),
      }
    }
    // Bare specifiers resolve through the nearest node_modules; whether one
    // exists at each level, and which packages it holds, is part of the answer.
    let modules = dir.join("node_modules");
    if modules.is_dir() {
      listing_dirs.insert(modules);
    } else if fs::symlink_metadata(&modules).is_err() {
      absent.insert(modules);
    } else {
      bail!("{} is not a directory", modules.display());
    }
  }
  // `@std/dotenv/load` reads `.env` from the worker's cwd, the client dir.
  let dotenv = client_dir.join(".env");
  if dotenv.is_file() {
    file_set.insert(dotenv);
  } else {
    absent.insert(dotenv);
  }
  if let Ok(config_path) = std::env::var("DENO_CONFIG") {
    let config_path = PathBuf::from(config_path);
    if config_path.is_file() {
      file_set.insert(absolute(&config_path)?);
    }
  }
  for extended in tsconfig_extends(&file_set)? {
    file_set.insert(extended);
  }

  // Directories too: an entry added while the build ran (a new `foo.tsx`
  // beside the `foo.ts` esbuild already resolved) changes the directory's
  // mtime, and its listing would otherwise be stamped as if the build saw it.
  // Resolver probes are not here: `ProbeFacts::collect` compared each one with
  // what the resolver saw, which an unrelated entry beside it cannot upset.
  check_quiet(&file_set, build_started)?;
  check_quiet(&listing_dirs, build_started)?;
  let files = hash_all(file_set.into_iter().collect())?;

  let mut listings = BTreeMap::new();
  for dir in listing_dirs {
    let hash = listing_hash(&dir).with_context(|| format!("list {}", dir.display()))?;
    listings.insert(dir, hash);
  }

  let mut heads = BTreeMap::new();
  for file in files.keys() {
    if file.file_name().is_some_and(|n| n == "build-stamp.ts") {
      let dir = file.parent().expect("file has a parent").to_path_buf();
      let head = stamp_head(&dir);
      heads.insert(dir, head);
    }
  }

  let (out_files, out_dirs) = walk_outputs(config.output_dir)?;
  let out_files: Vec<PathBuf> = out_files
    .into_iter()
    .filter(|rel| !is_unstamped(rel))
    .collect();
  let hashed = hash_all(
    out_files
      .iter()
      .map(|rel| config.output_dir.join(rel))
      .collect(),
  )?;
  let outputs = hashed
    .into_iter()
    .map(|(abs, hash)| {
      (
        abs
          .strip_prefix(config.output_dir)
          .expect("under output")
          .to_path_buf(),
        hash,
      )
    })
    .collect();

  let mut store_files = BTreeMap::new();
  if !evidence.store_urls.is_empty() {
    let store = config.store.context("store URLs without a store")?;
    let rels: Vec<PathBuf> = evidence
      .store_urls
      .iter()
      .map(|url| store_rel(url))
      .collect::<anyhow::Result<_>>()?;
    let hashed = hash_all(rels.iter().map(|rel| store.join(rel)).collect())?;
    for (abs, hash) in hashed {
      store_files.insert(
        abs.strip_prefix(store).expect("under store").to_path_buf(),
        hash,
      );
    }
  }

  Ok(Stamp {
    schema: SCHEMA,
    key,
    files,
    absent,
    listings,
    heads,
    outputs,
    output_dirs: out_dirs.into_iter().collect(),
    store_files,
    watch_inputs: watch_inputs.to_vec(),
    probes: evidence.probes.clone(),
    links: evidence.links.clone(),
  })
}

/// `/js/m/a/b.1234abcd.js` → `js/m/a/b.1234abcd.js`, refusing anything that
/// could leave the store.
fn store_rel(url: &str) -> anyhow::Result<PathBuf> {
  let rel = Path::new(url.trim_start_matches('/'));
  if rel
    .components()
    .any(|c| !matches!(c, std::path::Component::Normal(_)))
  {
    bail!("store URL {url:?} is not a plain relative path");
  }
  Ok(rel.to_path_buf())
}

/// sha-256 over the tool identity and the configuration.
fn key(config: &BuildConfig) -> anyhow::Result<String> {
  let mut h = Sha256::new();
  let mut field = |name: &str, value: &[u8]| {
    h.update((name.len() as u64).to_le_bytes());
    h.update(name.as_bytes());
    h.update((value.len() as u64).to_le_bytes());
    h.update(value);
  };
  field("schema", &SCHEMA.to_le_bytes());
  field("crate", env!("CARGO_PKG_VERSION").as_bytes());
  // The copy/template step and this check are compiled in; a binary built
  // from changed sources must not vouch for a tree the old one wrote.
  field("bundler.rs", include_bytes!("bundler.rs"));
  field("bundler_reuse.rs", include_bytes!("bundler_reuse.rs"));
  field("deno", &deno_version()?);
  field(
    "html_root",
    absolute(config.html_root)?.as_os_str().as_encoded_bytes(),
  );
  field(
    "output_dir",
    absolute(config.output_dir)?.as_os_str().as_encoded_bytes(),
  );
  field(
    "store",
    config
      .store
      .map(absolute)
      .transpose()?
      .unwrap_or_default()
      .as_os_str()
      .as_encoded_bytes(),
  );
  field(
    "fleet_prefix",
    config.fleet_prefix.unwrap_or("\u{0}none").as_bytes(),
  );
  let mut env: Vec<(String, String)> = std::env::vars()
    .filter(|(name, _)| {
      ENV_NAMES.contains(&name.as_str()) || ENV_PREFIXES.iter().any(|p| name.starts_with(p))
    })
    .collect();
  env.sort();
  for (name, value) in env {
    field(&format!("env:{name}"), value.as_bytes());
  }
  Ok(hex::encode(h.finalize()))
}

fn deno_version() -> anyhow::Result<Vec<u8>> {
  let output = std::process::Command::new("deno")
    .arg("--version")
    .stderr(std::process::Stdio::null())
    .output()
    .context("run deno --version")?;
  if !output.status.success() {
    bail!("deno --version exited with {}", output.status);
  }
  Ok(output.stdout)
}

/// The build scripts and plugins the worker runs. They are not in esbuild's
/// metafile, and a change to any of them can change every output.
fn tool_files(tento_web: &Path) -> anyhow::Result<Vec<PathBuf>> {
  let mut files = Vec::new();
  let tento = tento_web.parent().context("TENTO_WEB has no parent")?;
  for dir in [
    tento_web.join("src/client"),
    tento.join("tento-web-js/build-plugins"),
    tento.join("tento-core/src/subprocess"),
  ] {
    let entries = fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))?;
    for entry in entries {
      let path = entry?.path();
      let is_script = path
        .extension()
        .is_some_and(|ext| ext == "ts" || ext == "js" || ext == "mjs");
      if is_script && path.is_file() {
        files.push(absolute(&path)?);
      }
    }
  }
  files.sort();
  Ok(files)
}

/// Every tsconfig/jsconfig in `files`, followed through `extends`. A config
/// that does not parse (as JSON with comments and trailing commas, which is
/// what TypeScript and esbuild accept), or extends a package rather than a
/// path, is not something this check can follow, so the build gets no stamp.
fn tsconfig_extends(files: &BTreeSet<PathBuf>) -> anyhow::Result<BTreeSet<PathBuf>> {
  let mut found = BTreeSet::new();
  let mut queue: Vec<PathBuf> = files
    .iter()
    .filter(|p| {
      p.file_name()
        .is_some_and(|n| n == "tsconfig.json" || n == "jsconfig.json")
    })
    .cloned()
    .collect();
  while let Some(config) = queue.pop() {
    let text = fs::read_to_string(&config).with_context(|| format!("read {}", config.display()))?;
    let value: serde_json::Value = serde_json::from_str(&strip_jsonc(&text))
      .with_context(|| format!("{} does not parse", config.display()))?;
    let targets: Vec<&str> = match value.get("extends") {
      None => vec![],
      Some(serde_json::Value::String(one)) => vec![one.as_str()],
      Some(serde_json::Value::Array(many)) => many.iter().filter_map(|v| v.as_str()).collect(),
      Some(other) => bail!("{}: unexpected extends {other}", config.display()),
    };
    for target in targets {
      if !(target.starts_with("./") || target.starts_with("../") || target.starts_with('/')) {
        bail!("{} extends package {target:?}", config.display());
      }
      let base = config.parent().expect("config has a parent").join(target);
      let resolved = if base.is_file() {
        base
      } else {
        let with_json = PathBuf::from(format!("{}.json", base.display()));
        if !with_json.is_file() {
          bail!("{} extends missing {target:?}", config.display());
        }
        with_json
      };
      let resolved = absolute(&resolved)?;
      if found.insert(resolved.clone()) && !files.contains(&resolved) {
        queue.push(resolved);
      }
    }
  }
  Ok(found)
}

/// JSON with comments → JSON: drops `//` and `/* */` comments and trailing
/// commas outside strings. Only for reading `extends`; the hash covers the
/// original bytes.
fn strip_jsonc(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut chars = text.chars().peekable();
  let mut in_string = false;
  while let Some(c) = chars.next() {
    if in_string {
      out.push(c);
      match c {
        '\\' => {
          if let Some(next) = chars.next() {
            out.push(next);
          }
        }
        '"' => in_string = false,
        _ => {}
      }
      continue;
    }
    match c {
      '"' => {
        in_string = true;
        out.push(c);
      }
      '/' if chars.peek() == Some(&'/') => while chars.next_if(|&n| n != '\n').is_some() {},
      '/' if chars.peek() == Some(&'*') => {
        chars.next();
        let mut last = '\0';
        for n in chars.by_ref() {
          if last == '*' && n == '/' {
            break;
          }
          last = n;
        }
      }
      _ => out.push(c),
    }
  }
  // Trailing commas: a comma whose next non-space character closes.
  let mut cleaned = String::with_capacity(out.len());
  let bytes: Vec<char> = out.chars().collect();
  let mut in_string = false;
  let mut i = 0;
  while i < bytes.len() {
    let c = bytes[i];
    if in_string {
      cleaned.push(c);
      if c == '\\' && i + 1 < bytes.len() {
        cleaned.push(bytes[i + 1]);
        i += 1;
      } else if c == '"' {
        in_string = false;
      }
    } else if c == '"' {
      in_string = true;
      cleaned.push(c);
    } else if c == ',' {
      let next = bytes[i + 1..].iter().find(|n| !n.is_whitespace());
      if !matches!(next, Some('}') | Some(']')) {
        cleaned.push(c);
      }
    } else {
      cleaned.push(c);
    }
    i += 1;
  }
  cleaned
}

/// Refuse to stamp when any input was modified at or after the build began:
/// the build may have read the earlier bytes while the stamp would hash the
/// later ones.
fn check_quiet(files: &BTreeSet<PathBuf>, build_started: SystemTime) -> anyhow::Result<()> {
  let boundary = build_started
    .checked_sub(MTIME_SLACK)
    .unwrap_or(build_started);
  for file in files {
    let modified = fs::metadata(file)
      .and_then(|m| m.modified())
      .with_context(|| format!("stat {}", file.display()))?;
    let coarse = modified
      .duration_since(SystemTime::UNIX_EPOCH)
      .is_ok_and(|d| d.subsec_nanos() == 0);
    let latest = if coarse {
      modified + COARSE_MTIME_SLACK
    } else {
      modified
    };
    if latest >= boundary {
      bail!("{} was modified while the build ran", file.display());
    }
  }
  Ok(())
}

fn is_unstamped(rel: &Path) -> bool {
  rel.parent() == Some(Path::new(""))
    && rel.to_str().is_some_and(|n| UNSTAMPED_OUTPUTS.contains(&n))
}

fn absolute(path: &Path) -> anyhow::Result<PathBuf> {
  if path.is_absolute() {
    Ok(path.to_path_buf())
  } else {
    Ok(std::env::current_dir()?.join(path))
  }
}

/// sha-256 of a directory's sorted entry names, with a kind marker so a file
/// replaced by a directory of the same name changes it.
fn listing_hash(dir: &Path) -> anyhow::Result<String> {
  let mut names = Vec::new();
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let kind = match entry.file_type()? {
      t if t.is_dir() => 'd',
      t if t.is_symlink() => 'l',
      _ => 'f',
    };
    names.push(format!("{kind}{}", entry.file_name().to_string_lossy()));
  }
  names.sort();
  let mut h = Sha256::new();
  for name in names {
    h.update(name.as_bytes());
    h.update([0]);
  }
  Ok(hex::encode(h.finalize()))
}

/// Every file and directory under the html root (absolute), following
/// symlinks the way the copy step does, hidden entries included.
fn walk_tree(root: &Path) -> anyhow::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
  let root = absolute(root)?;
  let mut files = Vec::new();
  let mut dirs = vec![root.clone()];
  let mut seen = BTreeSet::new();
  let mut stack = vec![root];
  while let Some(dir) = stack.pop() {
    if !seen.insert(fs::canonicalize(&dir)?) {
      bail!("{} is a symlink loop", dir.display());
    }
    for entry in fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
      let path = entry?.path();
      if fs::metadata(&path)?.is_dir() {
        dirs.push(path.clone());
        stack.push(path);
      } else {
        files.push(path);
      }
    }
  }
  files.sort();
  dirs.sort();
  Ok((files, dirs))
}

/// Every file and directory under the output dir, relative to it, without
/// following symlinks (the build writes none).
fn walk_outputs(root: &Path) -> anyhow::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
  let mut files = Vec::new();
  let mut dirs = Vec::new();
  let mut stack = vec![PathBuf::new()];
  while let Some(rel) = stack.pop() {
    for entry in fs::read_dir(root.join(&rel)).with_context(|| format!("read {}", rel.display()))? {
      let entry = entry?;
      let child = rel.join(entry.file_name());
      if entry.file_type()?.is_dir() {
        dirs.push(child.clone());
        stack.push(child);
      } else {
        files.push(child);
      }
    }
  }
  files.sort();
  dirs.sort();
  Ok((files, dirs))
}

fn hash_file(path: &Path) -> std::io::Result<String> {
  let mut file = fs::File::open(path)?;
  let mut h = Sha256::new();
  let mut buf = vec![0u8; 1 << 16];
  loop {
    let n = file.read(&mut buf)?;
    if n == 0 {
      break;
    }
    h.update(&buf[..n]);
  }
  Ok(hex::encode(h.finalize()))
}

fn workers(n: usize) -> usize {
  std::thread::available_parallelism()
    .map_or(4, |p| p.get())
    .min(8)
    .min(n.max(1))
}

/// Hash every path, in parallel; any unreadable file is an error.
fn hash_all(paths: Vec<PathBuf>) -> anyhow::Result<BTreeMap<PathBuf, String>> {
  let chunk = paths.len().div_ceil(workers(paths.len())).max(1);
  let results: Vec<anyhow::Result<Vec<(PathBuf, String)>>> = std::thread::scope(|scope| {
    let handles: Vec<_> = paths
      .chunks(chunk)
      .map(|part| {
        scope.spawn(move || {
          part
            .iter()
            .map(|p| {
              hash_file(p)
                .map(|h| (p.clone(), h))
                .with_context(|| format!("hash {}", p.display()))
            })
            .collect()
        })
      })
      .collect();
    handles
      .into_iter()
      .map(|h| h.join().expect("hash worker panicked"))
      .collect()
  });
  let mut out = BTreeMap::new();
  for part in results {
    out.extend(part?);
  }
  Ok(out)
}

/// The first path whose current hash differs from the recorded one (or that
/// cannot be read), checked in parallel.
fn first_mismatch(expected: impl Iterator<Item = (PathBuf, String)>) -> Option<PathBuf> {
  let expected: Vec<(PathBuf, String)> = expected.collect();
  let chunk = expected.len().div_ceil(workers(expected.len())).max(1);
  let mut mismatches: Vec<PathBuf> = std::thread::scope(|scope| {
    let handles: Vec<_> = expected
      .chunks(chunk)
      .map(|part| {
        scope.spawn(move || {
          part
            .iter()
            .find(|(path, hash)| hash_file(path).ok().as_ref() != Some(hash))
            .map(|(path, _)| path.clone())
        })
      })
      .collect();
    handles
      .into_iter()
      .filter_map(|h| h.join().expect("hash worker panicked"))
      .collect()
  });
  mismatches.sort();
  mismatches.into_iter().next()
}

/// The commit `BuildStampPlugin` would splice into a `build-stamp.ts` in
/// `dir` (tento-web-js `build-stamp.deno.ts`): the explicit override when set,
/// else git HEAD of the checkout tracking `dir`.
fn stamp_head(dir: &Path) -> Option<String> {
  super::source_git_hash(
    dir,
    std::env::var(super::BUILD_GIT_HASH_ENV).ok().as_deref(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
  }

  #[test]
  fn the_stamp_lives_beside_the_output_not_in_it() {
    assert_eq!(
      stamp_path(Path::new("/r/target.web.beta/lona.so")),
      Some(PathBuf::from(
        "/r/target.web.beta/.tento-build-reuse/lona.so.json"
      ))
    );
    assert_eq!(stamp_path(Path::new("/")), None);
  }

  #[test]
  fn store_urls_cannot_leave_the_store() {
    assert_eq!(
      store_rel("/js/m/a/b.12345678.js").unwrap(),
      PathBuf::from("js/m/a/b.12345678.js")
    );
    assert!(store_rel("/js/../../etc/passwd").is_err());
  }

  #[test]
  fn listings_change_with_additions_deletions_and_kind() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join("a.ts"), "");
    let before = listing_hash(dir.path()).unwrap();
    write(&dir.path().join("a.tsx"), "");
    let added = listing_hash(dir.path()).unwrap();
    assert_ne!(before, added);
    fs::remove_file(dir.path().join("a.tsx")).unwrap();
    assert_eq!(listing_hash(dir.path()).unwrap(), before);
    fs::remove_file(dir.path().join("a.ts")).unwrap();
    fs::create_dir(dir.path().join("a.ts")).unwrap();
    assert_ne!(listing_hash(dir.path()).unwrap(), before);
  }

  #[test]
  fn an_input_written_during_the_build_refuses_a_stamp() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.ts");
    write(&file, "old");
    let files: BTreeSet<PathBuf> = [file.clone()].into();
    // Written before the build began: quiet.
    std::thread::sleep(Duration::from_millis(150));
    let started = SystemTime::now();
    check_quiet(&files, started).unwrap();
    // Written after it began: not quiet.
    write(&file, "new");
    assert!(check_quiet(&files, started).is_err());
  }

  #[test]
  fn tsconfig_extends_are_followed_and_packages_refused() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("base/tsconfig.base.json");
    write(&base, r#"{"compilerOptions": {}}"#);
    let app = dir.path().join("app/html/tsconfig.json");
    write(&app, r#"{"extends": "../../base/tsconfig.base"}"#);
    let found = tsconfig_extends(&[app.clone()].into()).unwrap();
    assert_eq!(found.len(), 1);
    assert!(found.iter().next().unwrap().ends_with("tsconfig.base.json"));

    // Comments and trailing commas are what tsconfig files look like.
    write(
      &app,
      "{\n  // base\n  \"extends\": \"../../base/tsconfig.base\", /* x */\n  \"a\": [\"//not\",],\n}",
    );
    assert_eq!(tsconfig_extends(&[app.clone()].into()).unwrap(), found);

    write(&app, r#"{"extends": "@tsconfig/strictest"}"#);
    assert!(tsconfig_extends(&[app.clone()].into()).is_err());
    write(&app, "{ \"extends\": ");
    assert!(tsconfig_extends(&[app].into()).is_err());
  }

  #[test]
  fn mismatch_finds_changed_and_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    write(&a, "a");
    write(&b, "b");
    let recorded = hash_all(vec![a.clone(), b.clone()]).unwrap();
    assert_eq!(first_mismatch(recorded.clone().into_iter()), None);
    write(&b, "B");
    assert_eq!(
      first_mismatch(recorded.clone().into_iter()),
      Some(b.clone())
    );
    fs::remove_file(&a).unwrap();
    assert_eq!(first_mismatch(recorded.into_iter()), Some(a));
  }

  #[test]
  fn only_top_level_build_status_is_unstamped() {
    assert!(is_unstamped(Path::new("build-status.json")));
    assert!(!is_unstamped(Path::new("routes/build-status.json")));
  }

  /// A recorded "build" without running one: build scripts, an html tree,
  /// an input outside it, outputs and one store module, laid out like a real
  /// tree. Only `deno --version` is needed.
  struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
  }

  impl Fixture {
    fn new() -> Fixture {
      let dir = tempfile::tempdir().unwrap();
      let root = fs::canonicalize(dir.path()).unwrap();
      let f = Fixture { _dir: dir, root };
      write(
        &f.tento_web().join("src/client/bundler.deno.ts"),
        "// bundler",
      );
      write(
        &f.root.join("tento/tento-web-js/build-plugins/svg.deno.ts"),
        "// plugin",
      );
      write(
        &f.root
          .join("tento/tento-core/src/subprocess/rpc-server.deno.ts"),
        "// rpc",
      );
      write(
        &f.html().join("routes/index.anon.html"),
        "<script src=\"/routes/index.root.js\"></script>",
      );
      write(
        &f.html().join("routes/index.root.ts"),
        "import { a } from \"../../lib/a.ts\";",
      );
      write(&f.root.join("app/lib/a.ts"), "export const a = 1;");
      write(&f.output().join("routes/index.anon.html"), "<html>");
      write(&f.output().join("routes/index.root.js"), "var a=1;");
      write(&f.output().join("build-status.json"), "{}");
      write(
        &f.store().join("js/m/app/lib/a.12345678.js"),
        "export const a=1;",
      );
      f
    }
    fn tento_web(&self) -> PathBuf {
      self.root.join("tento/tento-web")
    }
    fn html(&self) -> PathBuf {
      self.root.join("app/html")
    }
    fn output(&self) -> PathBuf {
      self.root.join("rel/target.web.beta/example.test")
    }
    fn store(&self) -> PathBuf {
      self.root.join("rel/target.web.modules")
    }
    fn evidence(&self) -> BuildEvidence {
      BuildEvidence {
        inputs: [
          self.html().join("routes/index.root.ts"),
          self.root.join("app/lib/a.ts"),
        ]
        .into(),
        store_urls: ["/js/m/app/lib/a.12345678.js".to_string()].into(),
        ..Default::default()
      }
    }
    fn check<T>(&self, prefix: Option<&str>, f: impl FnOnce(&BuildConfig) -> T) -> T {
      let (html, output, store, tento_web) =
        (self.html(), self.output(), self.store(), self.tento_web());
      f(&BuildConfig {
        html_root: &html,
        output_dir: &output,
        store: Some(&store),
        fleet_prefix: prefix,
        tento_web: &tento_web,
      })
    }
    /// Record as a build that started after the fixture was written.
    fn recorded() -> Fixture {
      let f = Fixture::new();
      std::thread::sleep(Duration::from_millis(150));
      let started = SystemTime::now();
      let watch = vec![f.html().join("routes/index.root.ts")];
      f.check(None, |c| record(c, &f.evidence(), &watch, started))
        .unwrap();
      f
    }
    fn verify(&self) -> Result<Reuse, Miss> {
      self.check(None, verify)
    }
  }

  fn changed(result: Result<Reuse, Miss>) -> PathBuf {
    match result {
      Err(Miss::Changed(path)) => path,
      Err(other) => panic!("expected an input change, got {other}"),
      Ok(_) => panic!("expected an input change, got a reuse"),
    }
  }

  fn output_changed(result: Result<Reuse, Miss>) -> PathBuf {
    match result {
      Err(Miss::OutputChanged(path)) => path,
      Err(other) => panic!("expected an output change, got {other}"),
      Ok(_) => panic!("expected an output change, got a reuse"),
    }
  }

  #[test]
  fn an_unchanged_build_verifies_and_returns_its_watch_set() {
    let f = Fixture::recorded();
    let hit = f.verify().unwrap();
    assert_eq!(
      hit.watch_inputs,
      vec![f.html().join("routes/index.root.ts")]
    );
    assert!(hit.extra_files.is_empty() && hit.extra_dirs.is_empty());
    // build-status.json is rewritten on every pass; it is not evidence.
    write(
      &f.output().join("build-status.json"),
      "{\"status\":\"failed\"}",
    );
    assert!(f.verify().is_ok());
  }

  #[test]
  fn no_stamp_is_a_miss() {
    let f = Fixture::new();
    assert_eq!(f.verify().err(), Some(Miss::NoStamp));
    let f = Fixture::recorded();
    invalidate(&f.output());
    assert_eq!(f.verify().err(), Some(Miss::NoStamp));
  }

  #[test]
  fn a_changed_or_deleted_input_misses() {
    let f = Fixture::recorded();
    write(&f.root.join("app/lib/a.ts"), "export const a = 2;");
    assert_eq!(changed(f.verify()), f.root.join("app/lib/a.ts"));

    let f = Fixture::recorded();
    fs::remove_file(f.root.join("app/lib/a.ts")).unwrap();
    // The directory listing goes first, and is enough.
    assert_eq!(changed(f.verify()), f.root.join("app/lib"));

    let f = Fixture::recorded();
    write(
      &f.html().join("routes/index.anon.html"),
      "<b>edited template</b>",
    );
    assert_eq!(changed(f.verify()), f.html().join("routes/index.anon.html"));
  }

  #[test]
  fn a_new_file_beside_an_input_or_anywhere_in_the_html_tree_misses() {
    // A sibling that could change what `./a` resolves to.
    let f = Fixture::recorded();
    write(&f.root.join("app/lib/a.tsx"), "");
    assert_eq!(changed(f.verify()), f.root.join("app/lib"));

    // A new asset in a new html subdirectory: copied by the copy step.
    let f = Fixture::recorded();
    write(&f.html().join("routes/new/logo.png"), "png");
    assert_eq!(changed(f.verify()), f.html().join("routes"));
  }

  #[test]
  fn a_resolution_file_appearing_above_an_input_misses() {
    let f = Fixture::recorded();
    write(&f.root.join("app/tsconfig.json"), "{}");
    assert_eq!(changed(f.verify()), f.root.join("app/tsconfig.json"));

    let f = Fixture::recorded();
    fs::create_dir_all(f.root.join("app/node_modules")).unwrap();
    assert_eq!(changed(f.verify()), f.root.join("app/node_modules"));
  }

  #[test]
  fn a_changed_build_script_or_configuration_misses() {
    let f = Fixture::recorded();
    write(
      &f.root.join("tento/tento-web-js/build-plugins/svg.deno.ts"),
      "// plugin v2",
    );
    assert_eq!(
      changed(f.verify()),
      f.root.join("tento/tento-web-js/build-plugins/svg.deno.ts")
    );

    let f = Fixture::recorded();
    assert_eq!(f.check(Some("aws-04"), verify).err(), Some(Miss::Key));
  }

  #[test]
  fn a_missing_or_corrupt_output_or_store_module_misses() {
    let f = Fixture::recorded();
    fs::remove_file(f.output().join("routes/index.root.js")).unwrap();
    assert_eq!(
      output_changed(f.verify()),
      f.output().join("routes/index.root.js")
    );

    let f = Fixture::recorded();
    write(&f.output().join("routes/index.root.js"), "var a=2;");
    assert_eq!(
      output_changed(f.verify()),
      f.output().join("routes/index.root.js")
    );

    let f = Fixture::recorded();
    write(&f.store().join("js/m/app/lib/a.12345678.js"), "truncated");
    assert_eq!(
      output_changed(f.verify()),
      f.store().join("js/m/app/lib/a.12345678.js")
    );
  }

  #[test]
  fn files_the_build_did_not_write_are_reported_for_pruning() {
    let f = Fixture::recorded();
    write(&f.output().join("routes/health.json"), "{}");
    write(&f.output().join("hook/out.txt"), "hook");
    let hit = f.verify().unwrap();
    assert_eq!(
      hit.extra_files,
      vec![
        f.output().join("hook/out.txt"),
        f.output().join("routes/health.json")
      ]
    );
    assert_eq!(hit.extra_dirs, vec![f.output().join("hook")]);
  }

  #[test]
  fn a_corrupt_or_foreign_stamp_misses() {
    let f = Fixture::recorded();
    let path = stamp_path(&f.output()).unwrap();
    fs::write(&path, "{ not json").unwrap();
    assert!(matches!(f.verify(), Err(Miss::Unreadable(_))));

    let f = Fixture::recorded();
    let path = stamp_path(&f.output()).unwrap();
    let mut stamp: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    stamp["schema"] = serde_json::json!(SCHEMA + 1);
    fs::write(&path, stamp.to_string()).unwrap();
    assert_eq!(f.verify().err(), Some(Miss::Schema));
  }

  #[test]
  fn a_missing_probe_is_recorded_at_its_deepest_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    write(&root.join("second/x.ts"), "");
    write(&root.join("lib/a.ts"), "");
    // What the replay saw at each probe.
    let probes = [
      (root.join("first/x"), None),
      (root.join("first/x.tsx"), None),
      (root.join("second/x"), None),
      (root.join("second/x.ts"), Some('f')),
      (root.join("lib/a.ts/index.ts"), None),
    ];
    let seen = || probes.iter().map(|(p, k)| (p.as_path(), *k));
    let facts = ProbeFacts::collect(seen()).unwrap();
    assert_eq!(
      facts.missing.get(&root).unwrap(),
      &BTreeSet::from(["first".to_string()])
    );
    assert_eq!(
      facts.missing.get(&root.join("second")).unwrap(),
      &BTreeSet::from(["x".to_string()])
    );
    assert_eq!(facts.present.get(&root.join("second/x.ts")), Some(&'f'));
    // Below a file: the file's kind is the fact.
    assert_eq!(facts.present.get(&root.join("lib/a.ts")), Some(&'f'));
    assert_eq!(facts.first_change(), None);
    let mut watch = facts.watch_paths();
    watch.sort();
    assert_eq!(watch, vec![root.join("first"), root.join("second/x")]);

    // The first component of a deep missing probe is enough to notice.
    fs::create_dir(root.join("first")).unwrap();
    assert_eq!(facts.first_change(), Some(root.join("first")));
    fs::remove_dir(root.join("first")).unwrap();
    // esbuild matches names case-insensitively.
    fs::create_dir(root.join("FIRST")).unwrap();
    assert_eq!(facts.first_change(), Some(root.join("first")));
    assert!(ProbeFacts::collect(seen()).is_err());
    fs::remove_dir(root.join("FIRST")).unwrap();
    // A present probe that changes kind.
    fs::remove_file(root.join("lib/a.ts")).unwrap();
    fs::create_dir(root.join("lib/a.ts")).unwrap();
    assert_eq!(facts.first_change(), Some(root.join("lib/a.ts")));
  }

  #[test]
  fn recorded_probes_and_links_must_still_hold() {
    let f = Fixture::new();
    let mut evidence = f.evidence();
    let preferred = f.root.join("app/first/a.ts");
    evidence.probes = ProbeFacts::collect([(preferred.as_path(), None)]).unwrap();
    let target = f.root.join("app/lib/a.ts");
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.root.join("app/lib"), f.root.join("app/linked")).unwrap();
    evidence
      .links
      .insert(f.root.join("app/linked/a.ts"), target.clone());
    std::thread::sleep(Duration::from_millis(150));
    let started = SystemTime::now();
    f.check(None, |c| record(c, &evidence, &[], started)).unwrap();
    let hit = f.verify().unwrap();
    assert_eq!(hit.watch_probes, vec![f.root.join("app/first")]);

    // Retargeting the link changes what a fresh build would read.
    write(&f.root.join("app/other/a.ts"), "export const a = 1;");
    fs::remove_file(f.root.join("app/linked")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.root.join("app/other"), f.root.join("app/linked")).unwrap();
    assert_eq!(changed(f.verify()), f.root.join("app/linked/a.ts"));
    fs::remove_file(f.root.join("app/linked")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.root.join("app/lib"), f.root.join("app/linked")).unwrap();

    // `app/` is no input's directory; only the probe notices `first/`.
    write(&preferred, "export const a = 2;");
    assert_eq!(changed(f.verify()), f.root.join("app/first"));
  }

  #[test]
  fn a_probe_whose_kind_changed_during_the_build_refuses_a_stamp() {
    let f = Fixture::new();
    let preferred = f.root.join("app/first/a.ts");
    let input = f.root.join("app/lib/a.ts");
    // The replay saw `first/a.ts` missing and `lib/a.ts` a file; both hold.
    let seen = [(preferred.as_path(), None), (input.as_path(), Some('f'))];
    ProbeFacts::collect(seen).unwrap();

    // A missing probe created after the resolver looked.
    write(&preferred, "export const a = 2;");
    let err = ProbeFacts::collect(seen).unwrap_err().to_string();
    let expected = format!(
      "{} changed during the build: the resolver saw nothing, it is now a file",
      preferred.display()
    );
    assert!(err.contains(&expected), "{err}");
    fs::remove_dir_all(f.root.join("app/first")).unwrap();

    // A present probe replaced by another kind, which a directory-mtime check
    // on missing probes never looked at.
    fs::remove_file(&input).unwrap();
    fs::create_dir(&input).unwrap();
    let err = ProbeFacts::collect(seen).unwrap_err().to_string();
    let expected = format!(
      "{} changed during the build: the resolver saw a file, it is now a directory",
      input.display()
    );
    assert!(err.contains(&expected), "{err}");
  }

  #[test]
  fn an_unrelated_entry_in_a_probed_directory_during_the_build_still_stamps() {
    let f = Fixture::new();
    let mut evidence = f.evidence();
    let preferred = f.root.join("app/first/a.ts");
    std::thread::sleep(Duration::from_millis(150));
    let started = SystemTime::now();
    std::thread::sleep(Duration::from_millis(150));
    // `app/`, where `first` must stay absent, gains an unrelated entry while
    // the build runs, as `~` or `/tmp` do. What the resolver saw still holds.
    write(&f.root.join("app/unrelated.txt"), "");
    evidence.probes = ProbeFacts::collect([(preferred.as_path(), None)]).unwrap();
    f.check(None, |c| record(c, &evidence, &[], started)).unwrap();
    assert!(f.verify().is_ok());
  }

  #[test]
  fn a_build_whose_inputs_changed_while_it_ran_gets_no_stamp() {
    let f = Fixture::new();
    // The build "started" before the fixture's inputs were last written.
    let started = SystemTime::now() - Duration::from_secs(5);
    let result = f.check(None, |c| record(c, &f.evidence(), &[], started));
    assert!(
      result
        .unwrap_err()
        .to_string()
        .contains("modified while the build ran")
    );
    assert_eq!(f.verify().err(), Some(Miss::NoStamp));
  }
}
