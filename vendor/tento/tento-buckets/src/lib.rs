//! `tento-buckets` — the pure bucket-directory model for fleet data buckets.
//!
//! A **bucket** is a directory holding a `meta.json`
//! (`{shape_tag, retention, visibility}`, see [`BucketMeta`]) plus a
//! [`TimeSeriesStore`](https://docs.rs/tento-timeseries) layout
//! (`samples/*.ljson`, `daily/*.parquet`, `weekly/*.parquet`). The canonical
//! on-disk address is
//!
//! ```text
//!   <root>/<host>/<node-path…>/<bucket>/{meta.json, .maintenance.lock, samples/, daily/, weekly/}
//! ```
//!
//! `<host>` is the top segment on BOTH the producer and the control-pane cache,
//! so the two trees are structurally identical — a host's bucket root is exactly
//! a sub-tree of the pane's cache, making `rsync` a drop-in alternative to the
//! mTLS pull, and letting [`bucket_dir`] serve both sides. The node-path between
//! `<host>` and the bucket may be **nested** (e.g. `loaf/web`), so discovery is a
//! recursive walk for `meta.json`, not a fixed-depth scan.
//!
//! **Metadata ownership.** `ensure*` only *creates* `meta.json` (atomically,
//! durably) when it is missing; an existing file is read, its `shape_tag`
//! verified, and its retention/visibility left as stored. The only writer of an
//! existing `meta.json` is [`Bucket::set_policy`].
//!
//! This crate is intentionally pure (fs + serde, no async / no TLS) so producers
//! (`tento-logger` + instrumented apps) can depend on it without linking the host
//! agent's tokio + rustls. The host agent (`tento-host`) re-exports it and adds
//! the network server/client + the lifecycle janitor.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub mod durable;
pub mod janitor;
pub mod lock;
pub mod retention;

pub use janitor::{GcConfig, GcStats, Janitor, SweepStats};
pub use lock::{
  MAINTENANCE_LOCK_FILE, MaintenanceLock, maintenance_lock_at, try_maintenance_lock_at,
};
pub use retention::{PruneStats, default_retention, prune};

/// The metadata file that makes a directory a bucket.
pub const META_FILE: &str = "meta.json";

/// Per-bucket retention windows. `None` on a field ⇒ keep that tier forever.
/// The janitor prunes by the file's logical date (never mtime), never deletes
/// the currently-growing hot file, and only deletes a finer-tier file when a
/// coarser tier covers it (see [`prune`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RetentionPolicy {
  /// Completed-day `samples/*.ljson` kept this many days (today's is exempt).
  pub keep_hot_days: Option<u32>,
  /// `daily/*.parquet` kept this many days.
  pub keep_daily_days: Option<u32>,
  /// `weekly/*.parquet` kept this many weeks.
  pub keep_weekly_weeks: Option<u32>,
}

impl RetentionPolicy {
  /// Every tier kept forever.
  pub const FOREVER: RetentionPolicy = RetentionPolicy {
    keep_hot_days: None,
    keep_daily_days: None,
    keep_weekly_weeks: None,
  };

  /// True when no tier has a window (nothing is ever pruned).
  pub fn is_forever(&self) -> bool {
    *self == Self::FOREVER
  }
}

/// A bucket's retention intent, as persisted in `meta.json`'s `retention` key.
///
/// | `meta.json`                    | variant            | janitor behaviour                         |
/// |--------------------------------|--------------------|-------------------------------------------|
/// | key absent, or `null`          | `ShapeDefault`     | [`default_retention`] for the shape tag   |
/// | `"forever"`                    | `Forever`          | never pruned                              |
/// | `{ "keep_hot_days": … }`       | `Explicit(policy)` | the policy (a `null` tier = keep forever) |
///
/// `null` keeps meaning "shape default" so every legacy `meta.json` (written
/// by `ensure_nested(…, None)`) is read exactly as before. Authoritative data
/// (leads, a sent-ledger) must say `Forever` explicitly — `null` is a finite
/// default for known shapes such as `cell/v1`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RetentionSpec {
  /// Use the per-shape default ([`default_retention`]).
  #[default]
  ShapeDefault,
  /// Keep every tier forever; the janitor never prunes this bucket.
  Forever,
  /// Explicit per-tier windows.
  Explicit(RetentionPolicy),
}

impl RetentionSpec {
  /// The policy the janitor applies to a bucket of `shape_tag`, or `None` when
  /// the bucket must never be pruned.
  pub fn resolve(&self, shape_tag: &str) -> Option<RetentionPolicy> {
    match self {
      RetentionSpec::ShapeDefault => Some(default_retention(shape_tag)),
      RetentionSpec::Forever => None,
      RetentionSpec::Explicit(p) => Some(p.clone()),
    }
  }
}

impl From<Option<RetentionPolicy>> for RetentionSpec {
  /// The legacy `ensure_nested` argument: `None` = shape default.
  fn from(p: Option<RetentionPolicy>) -> Self {
    match p {
      None => RetentionSpec::ShapeDefault,
      Some(p) => RetentionSpec::Explicit(p),
    }
  }
}

impl Serialize for RetentionSpec {
  fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
    match self {
      RetentionSpec::ShapeDefault => s.serialize_none(),
      RetentionSpec::Forever => s.serialize_str("forever"),
      RetentionSpec::Explicit(p) => p.serialize(s),
    }
  }
}

impl<'de> Deserialize<'de> for RetentionSpec {
  fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
      Word(String),
      Policy(RetentionPolicy),
    }
    match Option::<Repr>::deserialize(d)? {
      None => Ok(RetentionSpec::ShapeDefault),
      Some(Repr::Policy(p)) => Ok(RetentionSpec::Explicit(p)),
      Some(Repr::Word(w)) => match w.as_str() {
        "forever" => Ok(RetentionSpec::Forever),
        "shape-default" => Ok(RetentionSpec::ShapeDefault),
        other => Err(serde::de::Error::custom(format!(
          "unknown retention {other:?} (expected null, \"forever\" or a policy object)"
        ))),
      },
    }
  }
}

/// Who may see a bucket. `Fleet` buckets are served by the host agent and
/// mirrored by recorders/edge caches; `Private` buckets (raw ad touches, leads,
/// anything with PII) must be excluded from discovery-for-serving and mirroring.
/// Absent in a legacy `meta.json` ⇒ `Fleet`, so nothing existing changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
  #[default]
  Fleet,
  Private,
}

/// On-disk `meta.json` for a bucket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BucketMeta {
  /// The shape contract the TUI dispatches a renderer on, e.g. `"cell/v1"` or
  /// `"span-tree/v1"`.
  pub shape_tag: String,
  /// Retention intent; `#[serde(default)]` keeps legacy `{"shape_tag":…}`
  /// files (no retention key) valid as [`RetentionSpec::ShapeDefault`].
  #[serde(default)]
  pub retention: RetentionSpec,
  /// Serving/mirroring visibility; absent ⇒ [`Visibility::Fleet`].
  #[serde(default)]
  pub visibility: Visibility,
}

impl BucketMeta {
  /// A fleet-visible, shape-default meta for `shape_tag`.
  pub fn new(shape_tag: impl Into<String>) -> Self {
    BucketMeta {
      shape_tag: shape_tag.into(),
      retention: RetentionSpec::ShapeDefault,
      visibility: Visibility::Fleet,
    }
  }

  pub fn is_private(&self) -> bool {
    self.visibility == Visibility::Private
  }

  /// Read `<dir>/meta.json`. `Ok(None)` when it is absent or zero-length (the
  /// state a crashed non-atomic writer leaves); a non-empty file that does not
  /// parse is an error, never a silent default.
  pub fn read(dir: &Path) -> Result<Option<BucketMeta>> {
    let path = dir.join(META_FILE);
    let bytes = match std::fs::read(&path) {
      Ok(b) => b,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
      return Ok(None);
    }
    serde_json::from_slice(&bytes)
      .map(Some)
      .map_err(|e| anyhow::Error::new(BucketError::CorruptMeta { path, reason: e.to_string() }))
  }
}

/// Typed bucket errors (wrapped in `anyhow::Error`; use `downcast_ref`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BucketError {
  /// `ensure*` found an existing `meta.json` with a different shape tag.
  ShapeMismatch {
    dir: PathBuf,
    stored: String,
    requested: String,
  },
  /// A host/node/name segment is empty, `.`, `..`, or contains `/`, `\` or NUL.
  InvalidSegment { kind: &'static str, segment: String },
  /// `meta.json` exists but does not parse.
  CorruptMeta { path: PathBuf, reason: String },
}

impl std::fmt::Display for BucketError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      BucketError::ShapeMismatch {
        dir,
        stored,
        requested,
      } => write!(
        f,
        "bucket {} has shape_tag {stored:?}, refusing to open it as {requested:?}",
        dir.display()
      ),
      BucketError::InvalidSegment { kind, segment } => {
        write!(f, "invalid bucket {kind} segment {segment:?}")
      }
      BucketError::CorruptMeta { path, reason } => {
        write!(f, "unreadable {}: {reason}", path.display())
      }
    }
  }
}

impl std::error::Error for BucketError {}

/// Reject an identity segment that could escape or collapse the bucket tree:
/// empty, `.`, `..`, or containing `/`, `\` or NUL.
pub fn validate_segment(kind: &'static str, segment: &str) -> Result<(), BucketError> {
  let bad = segment.is_empty()
    || segment == "."
    || segment == ".."
    || segment.contains(['/', '\\', '\0']);
  if bad {
    return Err(BucketError::InvalidSegment {
      kind,
      segment: segment.to_string(),
    });
  }
  Ok(())
}

/// Validate a slash-separated node path (empty segments from leading/trailing
/// or doubled slashes are ignored, as [`bucket_dir`] ignores them).
fn validate_node_path(node_path: &str) -> Result<(), BucketError> {
  for seg in node_path.split('/').filter(|s| !s.is_empty()) {
    validate_segment("node", seg)?;
  }
  Ok(())
}

/// One fragment file inside a bucket dir (relative path + size).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FragmentFile {
  /// Path relative to the bucket dir, e.g. `daily/2026-05-12.parquet`.
  pub path: String,
  pub bytes: u64,
}

/// The `/manifest` response: a bucket's shape tag + its fragment files. The
/// mirror client diffs this against the local edge cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
  pub shape_tag: String,
  pub files: Vec<FragmentFile>,
}

/// One entry in the `GET /buckets` discovery response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BucketEntry {
  pub node: String,
  pub name: String,
  pub shape_tag: String,
}

/// The data subdirs inside a bucket (never treated as node-path segments).
const DATA_SUBDIRS: [&str; 3] = ["samples", "daily", "weekly"];

/// Discovery never descends deeper than this many directories below its root
/// (host + nested node path + bucket name is far shallower).
pub const MAX_WALK_DEPTH: usize = 16;

/// The canonical bucket dir: `<root>/<host>/<node-path…>/<name>`. `node_path` may
/// contain `/` (nested). This is the SAME join the control-pane cache uses
/// (`edge_cache_dir`), so producer and cache trees align. A pure join: the
/// `ensure*` constructors validate the segments (see [`validate_segment`]).
pub fn bucket_dir(root: impl AsRef<Path>, host: &str, node_path: &str, name: &str) -> PathBuf {
  let mut dir = root.as_ref().join(host);
  for seg in node_path.split('/').filter(|s| !s.is_empty()) {
    dir = dir.join(seg);
  }
  dir.join(name)
}

/// This host's bucket root: `$TENTO_BUCKETS_ROOT` → `~/.tento/buckets` →
/// `./tento-buckets`. Mirrors host-health's `default_data_dir` env pattern.
pub fn default_buckets_root() -> PathBuf {
  if let Some(dir) = std::env::var_os("TENTO_BUCKETS_ROOT") {
    let dir = PathBuf::from(dir);
    if !dir.as_os_str().is_empty() {
      return dir;
    }
  }
  match std::env::var_os("HOME") {
    Some(home) => PathBuf::from(home).join(".tento/buckets"),
    None => PathBuf::from("tento-buckets"),
  }
}

/// Env var that pins the bucket host segment (highest-priority env source).
pub const BUCKETS_HOST_ENV: &str = "TENTO_BUCKETS_HOST";

static HOST_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);
static HOSTNAME: OnceLock<String> = OnceLock::new();

/// Programmatically pin this process's bucket host segment (wins over every
/// env var); `None` clears the override. Composition roots that know their
/// fleet id should call this once at startup.
pub fn set_host_override(host: Option<&str>) {
  let v = host.map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
  *HOST_OVERRIDE.write().unwrap_or_else(|e| e.into_inner()) = v;
}

/// This host's id — the top bucket-namespace segment, shared by producers and the
/// host agent so their `<root>/<host>` agree (and so the recorder's
/// `edge_cache_dir`/`rsync` mirror lands at the same path). Resolution order:
///
/// 1. [`set_host_override`] (programmatic),
/// 2. `$TENTO_BUCKETS_HOST`,
/// 3. `$TENTO_HOST_ID` (stamped by the package deployer),
/// 4. `hostname -s`, read once per process and cached,
/// 5. `"localhost"`.
///
/// `hostname -s` is NOT stable: a reboot can change it (prod rwc-02 split its
/// ads buckets into `rwc-02/` and `rwc-02-B550-AORUS-ELITE/`). Any producer of
/// authoritative data must set `TENTO_BUCKETS_HOST` (or the override) to the
/// fleet id. Should equal the recorder's fleet-id.
pub fn host_id() -> String {
  if let Some(h) = HOST_OVERRIDE
    .read()
    .unwrap_or_else(|e| e.into_inner())
    .clone()
  {
    return h;
  }
  for var in [BUCKETS_HOST_ENV, "TENTO_HOST_ID"] {
    if let Some(id) = std::env::var_os(var) {
      let id = id.to_string_lossy().trim().to_string();
      if !id.is_empty() {
        return id;
      }
    }
  }
  HOSTNAME
    .get_or_init(|| {
      std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
    })
    .clone()
}

/// The search order every bucket *reader* should use: this host's own producer
/// root first ([`default_buckets_root`]), then the control-pane edge cache (the
/// mirror of *remote* hosts pulled over mTLS) when one is given. Both trees share
/// the `<root>/<host>/…` layout and never hold the same `<host>` subtree, so a
/// "first root whose `<root>/<host>` exists wins" resolution always picks the
/// local producer root for this host and the edge cache for remote hosts — no
/// per-call-site "am I local or remote?" branching.
///
/// Empty / unset `edge_cache` paths are dropped, and a duplicate of the producer
/// root (e.g. an edge cache pointed at `~/.tento/buckets`) is collapsed.
pub fn bucket_read_roots(edge_cache: Option<PathBuf>) -> Vec<PathBuf> {
  let mut roots = vec![default_buckets_root()];
  if let Some(edge) = edge_cache {
    if !edge.as_os_str().is_empty() && !roots.contains(&edge) {
      roots.push(edge);
    }
  }
  roots
}

/// The first root whose `<root>/<host>` directory exists, in search order — the
/// host-level resolution that pairs with [`bucket_read_roots`]: the local host
/// resolves from its producer root, a remote host from the pulled edge cache.
/// `None` when no root holds the host (the caller picks the fallback).
pub fn bucket_host_root(roots: &[PathBuf], host: &str) -> Option<PathBuf> {
  roots.iter().map(|r| r.join(host)).find(|d| d.is_dir())
}

/// A discovered bucket: its `(node, name)` identity (node may be a nested
/// slash-path), its shape tag, its dir, and the retention/visibility parsed
/// from its `meta.json` at discovery time (read once; the janitor never re-reads).
#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
  pub node: String,
  pub name: String,
  pub shape_tag: String,
  pub dir: PathBuf,
  pub retention: RetentionSpec,
  pub visibility: Visibility,
}

impl Bucket {
  /// Create (if missing) a flat bucket at `<root>/<node>/<name>` (no host
  /// segment, shape-default retention, fleet visibility). Kept for the legacy
  /// host-local layout + tests; new producers use
  /// [`ensure_nested`](Bucket::ensure_nested).
  pub fn ensure(root: &Path, node: &str, name: &str, shape_tag: &str) -> Result<Bucket> {
    validate_node_path(node)?;
    validate_segment("name", name)?;
    let dir = {
      let mut d = root.to_path_buf();
      for seg in node.split('/').filter(|s| !s.is_empty()) {
        d = d.join(seg);
      }
      d.join(name)
    };
    Self::ensure_at(
      dir,
      node,
      name,
      shape_tag,
      RetentionSpec::ShapeDefault,
      Visibility::Fleet,
    )
  }

  /// Create (if missing) a bucket at the canonical
  /// `<root>/<host>/<node-path…>/<name>`, fleet-visible. `retention: None` =
  /// shape default. An existing bucket keeps its stored policy (see
  /// [`ensure_nested_with`](Bucket::ensure_nested_with)). The returned
  /// `Bucket.node` is the logical node-path (host stripped).
  pub fn ensure_nested(
    root: &Path,
    host: &str,
    node_path: &str,
    name: &str,
    shape_tag: &str,
    retention: Option<RetentionPolicy>,
  ) -> Result<Bucket> {
    Self::ensure_nested_with(
      root,
      host,
      node_path,
      name,
      shape_tag,
      retention.into(),
      Visibility::Fleet,
    )
  }

  /// [`ensure_nested`](Bucket::ensure_nested) with an explicit
  /// [`RetentionSpec`] and [`Visibility`]. These are written **only when the
  /// bucket is created**; an existing `meta.json` is never rewritten here (its
  /// shape tag must match, else [`BucketError::ShapeMismatch`]). To change an
  /// existing bucket's policy call [`set_policy`](Bucket::set_policy).
  pub fn ensure_nested_with(
    root: &Path,
    host: &str,
    node_path: &str,
    name: &str,
    shape_tag: &str,
    retention: RetentionSpec,
    visibility: Visibility,
  ) -> Result<Bucket> {
    validate_segment("host", host)?;
    validate_node_path(node_path)?;
    validate_segment("name", name)?;
    let dir = bucket_dir(root, host, node_path, name);
    Self::ensure_at(dir, node_path, name, shape_tag, retention, visibility)
  }

  /// Create-if-missing: an existing (non-empty) `meta.json` is read, its shape
  /// verified, and returned as stored; a missing or zero-length one is written
  /// atomically (tmp + rename + fsync of file and dir).
  fn ensure_at(
    dir: PathBuf,
    node: &str,
    name: &str,
    shape_tag: &str,
    retention: RetentionSpec,
    visibility: Visibility,
  ) -> Result<Bucket> {
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let meta = match BucketMeta::read(&dir)? {
      Some(stored) => {
        if stored.shape_tag != shape_tag {
          return Err(
            BucketError::ShapeMismatch {
              dir,
              stored: stored.shape_tag,
              requested: shape_tag.to_string(),
            }
            .into(),
          );
        }
        stored
      }
      None => {
        let meta = BucketMeta {
          shape_tag: shape_tag.to_string(),
          retention,
          visibility,
        };
        durable::write_atomic(&dir.join(META_FILE), &serde_json::to_vec_pretty(&meta)?)
          .with_context(|| format!("write meta.json in {}", dir.display()))?;
        meta
      }
    };
    Ok(Bucket {
      node: node.trim_matches('/').to_string(),
      name: name.to_string(),
      shape_tag: meta.shape_tag,
      dir,
      retention: meta.retention,
      visibility: meta.visibility,
    })
  }

  /// Rewrite this bucket's retention + visibility atomically (tmp + rename +
  /// fsync). The **only** writer of an existing `meta.json`; the shape tag is
  /// preserved from the stored file (or this handle when none is readable).
  pub fn set_policy(&self, retention: RetentionSpec, visibility: Visibility) -> std::io::Result<()> {
    let shape_tag = BucketMeta::read(&self.dir)
      .ok()
      .flatten()
      .map(|m| m.shape_tag)
      .unwrap_or_else(|| self.shape_tag.clone());
    let meta = BucketMeta {
      shape_tag,
      retention,
      visibility,
    };
    let bytes = serde_json::to_vec_pretty(&meta).map_err(std::io::Error::other)?;
    std::fs::create_dir_all(&self.dir)?;
    durable::write_atomic(&self.dir.join(META_FILE), &bytes)
  }

  /// Re-read this bucket's `meta.json` from disk.
  pub fn load_meta(&self) -> Result<Option<BucketMeta>> {
    BucketMeta::read(&self.dir)
  }

  /// Compatibility view of the stored retention: `None` = shape default (or no
  /// readable `meta.json`), `Some(RetentionPolicy::FOREVER)` = keep forever,
  /// `Some(policy)` = explicit. Prefer [`Bucket::retention`] / [`load_meta`].
  pub fn load_retention(&self) -> Option<RetentionPolicy> {
    match BucketMeta::read(&self.dir).ok()??.retention {
      RetentionSpec::ShapeDefault => None,
      RetentionSpec::Forever => Some(RetentionPolicy::FOREVER),
      RetentionSpec::Explicit(p) => Some(p),
    }
  }

  pub fn is_private(&self) -> bool {
    self.visibility == Visibility::Private
  }

  /// Take this bucket's exclusive maintenance lock (blocking). Every rollup or
  /// prune of the bucket must hold it; it is re-entrant on one thread.
  pub fn maintenance_lock(&self) -> std::io::Result<MaintenanceLock> {
    maintenance_lock_at(&self.dir)
  }

  /// Non-blocking [`maintenance_lock`](Bucket::maintenance_lock).
  pub fn try_maintenance_lock(&self) -> std::io::Result<Option<MaintenanceLock>> {
    try_maintenance_lock_at(&self.dir)
  }

  /// All data fragment files (ljson + parquet) under this bucket, sorted by path.
  pub fn fragments(&self) -> Vec<FragmentFile> {
    let mut out = Vec::new();
    for sub in DATA_SUBDIRS {
      let subdir = self.dir.join(sub);
      let Ok(rd) = std::fs::read_dir(&subdir) else {
        continue;
      };
      for entry in rd.flatten() {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str());
        if !matches!(ext, Some("ljson") | Some("parquet")) {
          continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(FragmentFile {
          path: format!("{sub}/{}", p.file_name().unwrap().to_string_lossy()),
          bytes,
        });
      }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
  }

  /// Resolve a manifest-relative path to an absolute file **inside** this bucket,
  /// rejecting traversal (`..`, absolute, or anything escaping the dir).
  pub fn resolve(&self, relpath: &str) -> Option<PathBuf> {
    let rel = Path::new(relpath);
    if rel.is_absolute()
      || rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
      return None;
    }
    let full = self.dir.join(rel);
    // Only allow the known data subdirs.
    let ok_prefix = DATA_SUBDIRS
      .iter()
      .any(|s| full.starts_with(self.dir.join(s)));
    (ok_prefix && full.is_file()).then_some(full)
  }
}

/// A discovery result: the buckets found plus every directory that looked
/// like a bucket but could not be used (unreadable/corrupt `meta.json`, depth
/// cap), so callers can surface them instead of silently ignoring them.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Discovery {
  pub buckets: Vec<Bucket>,
  pub errors: Vec<(PathBuf, String)>,
}

/// Discovers buckets by recursively walking a root for dirs that contain a
/// `meta.json`. A dir with `meta.json` IS a bucket (a discovery leaf — its
/// subdirs are the `samples/daily/weekly` data dirs). A bucket's `node` is its
/// dir relative to the root, minus the final segment (the bucket name); it may
/// be a nested slash-path. Buckets directly under the root (empty node-path) are
/// ignored. Symlinked directories are not followed and the walk stops at
/// [`MAX_WALK_DEPTH`].
pub struct BucketRegistry {
  root: PathBuf,
}

impl BucketRegistry {
  pub fn new(root: impl Into<PathBuf>) -> Self {
    BucketRegistry { root: root.into() }
  }

  /// Scan for all buckets present right now, with the per-dir errors.
  pub fn discover(&self) -> Discovery {
    let mut out = Discovery::default();
    walk(&self.root, &self.root, 0, &mut out);
    out
      .buckets
      .sort_by(|a, b| (a.node.as_str(), a.name.as_str()).cmp(&(&b.node, &b.name)));
    out
  }

  /// Scan for all buckets present right now (cheap; the agent rescans per request
  /// so newly-created buckets appear without a restart). Unreadable buckets are
  /// omitted; use [`discover`](BucketRegistry::discover) to see them.
  pub fn list(&self) -> Vec<Bucket> {
    self.discover().buckets
  }

  /// Find one bucket by `(node, name)`.
  pub fn get(&self, node: &str, name: &str) -> Option<Bucket> {
    self
      .list()
      .into_iter()
      .find(|b| b.node == node && b.name == name)
  }
}

/// Recursive discovery: record the bucket at `dir` if it has `meta.json` (leaf),
/// else descend into non-data, non-symlink subdirs up to [`MAX_WALK_DEPTH`].
fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Discovery) {
  let meta_path = dir.join(META_FILE);
  if std::fs::symlink_metadata(&meta_path).is_ok_and(|m| m.is_file()) {
    let meta = match BucketMeta::read(dir) {
      Ok(Some(m)) => m,
      Ok(None) => {
        out
          .errors
          .push((dir.to_path_buf(), "empty meta.json".to_string()));
        return;
      }
      Err(e) => {
        out.errors.push((dir.to_path_buf(), format!("{e:#}")));
        return;
      }
    };
    let Ok(rel) = dir.strip_prefix(root) else {
      return;
    };
    let comps: Vec<String> = rel
      .components()
      .map(|c| c.as_os_str().to_string_lossy().into_owned())
      .collect();
    if let Some((name, node_parts)) = comps.split_last() {
      let node = node_parts.join("/");
      if !node.is_empty() {
        out.buckets.push(Bucket {
          node,
          name: name.clone(),
          shape_tag: meta.shape_tag,
          dir: dir.to_path_buf(),
          retention: meta.retention,
          visibility: meta.visibility,
        });
      }
    }
    return; // a bucket dir is a discovery leaf
  }
  if depth >= MAX_WALK_DEPTH {
    out.errors.push((
      dir.to_path_buf(),
      format!("discovery depth cap {MAX_WALK_DEPTH} reached"),
    ));
    return;
  }
  let Ok(rd) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in rd.flatten() {
    // `DirEntry::file_type` does not follow symlinks: a symlinked dir (or a
    // symlink cycle) is never descended into.
    if !entry.file_type().is_ok_and(|t| t.is_dir()) {
      continue;
    }
    let name = entry.file_name();
    if DATA_SUBDIRS.contains(&name.to_string_lossy().as_ref()) {
      continue; // defensive: never descend into a stray data subdir
    }
    walk(root, &entry.path(), depth + 1, out);
  }
}

/// What the agent serves: convention-scanned root(s) **plus** explicitly
/// registered buckets — the latter lets a legacy store dir (e.g. host-health's
/// `~/.tento-host-health`, which already has the `samples/daily/weekly` layout)
/// be served with no data move and no `meta.json`. Explicit registrations win on
/// `(node, name)` collisions. Each [`Bucket`] carries its [`Visibility`]; a
/// server or mirror must drop `is_private()` buckets itself.
#[derive(Default, Clone)]
pub struct BucketSet {
  roots: Vec<PathBuf>,
  explicit: Vec<Bucket>,
}

impl BucketSet {
  pub fn new() -> Self {
    BucketSet::default()
  }

  /// Add a convention root scanned recursively for `meta.json` buckets. (The host
  /// agent points this at `<buckets_root>/<host>` so reported node-paths are
  /// host-stripped.)
  pub fn with_root(mut self, root: impl Into<PathBuf>) -> Self {
    self.roots.push(root.into());
    self
  }

  /// Register an existing store directory as a bucket (no `meta.json` needed;
  /// shape-default retention, fleet visibility).
  pub fn register(
    mut self,
    node: impl Into<String>,
    name: impl Into<String>,
    shape_tag: impl Into<String>,
    dir: impl Into<PathBuf>,
  ) -> Self {
    self.explicit.push(Bucket {
      node: node.into(),
      name: name.into(),
      shape_tag: shape_tag.into(),
      dir: dir.into(),
      retention: RetentionSpec::ShapeDefault,
      visibility: Visibility::Fleet,
    });
    self
  }

  /// All buckets: explicit first (they win on `(node, name)`), then scanned.
  pub fn list(&self) -> Vec<Bucket> {
    let mut out = self.explicit.clone();
    for root in &self.roots {
      for b in BucketRegistry::new(root.clone()).list() {
        if !out.iter().any(|e| e.node == b.node && e.name == b.name) {
          out.push(b);
        }
      }
    }
    out.sort_by(|a, b| (a.node.as_str(), a.name.as_str()).cmp(&(&b.node, &b.name)));
    out
  }

  pub fn get(&self, node: &str, name: &str) -> Option<Bucket> {
    self
      .list()
      .into_iter()
      .find(|b| b.node == node && b.name == name)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("tb-bucket-{tag}-{}-{n}", std::process::id()))
  }

  fn tight() -> RetentionPolicy {
    RetentionPolicy {
      keep_hot_days: Some(2),
      keep_daily_days: Some(30),
      keep_weekly_weeks: Some(26),
    }
  }

  #[test]
  fn ensure_then_discover() {
    let root = temp_root("discover");
    Bucket::ensure(&root, "host-health", "metrics", "cell/v1").unwrap();
    Bucket::ensure(&root, "loaf", "spans", "span-tree/v1").unwrap();

    let reg = BucketRegistry::new(&root);
    let all = reg.list();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].node, "host-health");
    assert_eq!(all[0].shape_tag, "cell/v1");
    assert_eq!(reg.get("loaf", "spans").unwrap().shape_tag, "span-tree/v1");
    assert!(reg.get("loaf", "nope").is_none());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn ensure_nested_then_discover_at_depth() {
    let root = temp_root("nested");
    let b = Bucket::ensure_nested(
      &root,
      "rwc-03",
      "loaf/web",
      "spans",
      "span-tree/v1",
      Some(tight()),
    )
    .unwrap();
    assert_eq!(b.node, "loaf/web");
    assert_eq!(b.dir, root.join("rwc-03/loaf/web/spans"));
    assert!(b.dir.join("meta.json").is_file());

    // Scanning the HOST subtree reports the node-path host-stripped.
    let reg = BucketRegistry::new(root.join("rwc-03"));
    let all = reg.list();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].node, "loaf/web");
    assert_eq!(all[0].name, "spans");
    assert_eq!(all[0].retention, RetentionSpec::Explicit(tight()));
    // retention round-trips through meta.json
    let meta: BucketMeta =
      serde_json::from_slice(&std::fs::read(b.dir.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta.retention, RetentionSpec::Explicit(tight()));

    // Scanning the OUTER root keeps the host as the first node segment.
    assert_eq!(
      BucketRegistry::new(&root)
        .get("rwc-03/loaf/web", "spans")
        .map(|b| b.name),
      Some("spans".into())
    );

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn walk_does_not_descend_into_a_bucket() {
    let root = temp_root("nodescend");
    let b = Bucket::ensure_nested(&root, "h", "n", "spans", "span-tree/v1", None).unwrap();
    // A dir literally named like a nested node UNDER the data dir must be ignored.
    std::fs::create_dir_all(b.dir.join("daily/decoy")).unwrap();
    std::fs::write(b.dir.join("daily/decoy/meta.json"), br#"{"shape_tag":"x"}"#).unwrap();

    let all = BucketRegistry::new(root.join("h")).list();
    assert_eq!(
      all.len(),
      1,
      "only the real bucket, not the decoy under daily/"
    );
    assert_eq!(all[0].node, "n");

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn legacy_meta_without_retention_still_parses() {
    let meta: BucketMeta = serde_json::from_slice(br#"{"shape_tag":"cell/v1"}"#).unwrap();
    assert_eq!(meta.shape_tag, "cell/v1");
    assert_eq!(meta.retention, RetentionSpec::ShapeDefault);
    assert_eq!(meta.visibility, Visibility::Fleet, "visibility defaults to fleet");
    assert!(!meta.is_private());
  }

  #[test]
  fn legacy_null_retention_is_shape_default_and_forever_is_distinct() {
    let null: BucketMeta =
      serde_json::from_slice(br#"{"shape_tag":"cell/v1","retention":null}"#).unwrap();
    assert_eq!(null.retention, RetentionSpec::ShapeDefault);
    assert_eq!(
      null.retention.resolve("cell/v1"),
      Some(default_retention("cell/v1")),
      "legacy null keeps the finite cell/v1 default"
    );

    let forever: BucketMeta = serde_json::from_slice(
      br#"{"shape_tag":"cell/v1","retention":"forever","visibility":"private"}"#,
    )
    .unwrap();
    assert_eq!(forever.retention, RetentionSpec::Forever);
    assert_eq!(forever.retention.resolve("cell/v1"), None, "never pruned");
    assert!(forever.is_private());

    // Round trips: ShapeDefault → null, Forever → "forever", Explicit → object.
    let mut m = BucketMeta::new("cell/v1");
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v["retention"], serde_json::Value::Null);
    assert_eq!(v["visibility"], "fleet");
    m.retention = RetentionSpec::Forever;
    assert_eq!(serde_json::to_value(&m).unwrap()["retention"], "forever");
    m.retention = RetentionSpec::Explicit(tight());
    let back: BucketMeta = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
    assert_eq!(back, m);
    assert!(serde_json::from_slice::<BucketMeta>(br#"{"shape_tag":"x","retention":"weekly"}"#).is_err());
  }

  #[test]
  fn ensure_does_not_overwrite_existing_meta() {
    let root = temp_root("nooverwrite");
    let first = Bucket::ensure_nested_with(
      &root,
      "h",
      "lona/ads",
      "leads",
      "cell/v1",
      RetentionSpec::Forever,
      Visibility::Private,
    )
    .unwrap();
    assert_eq!(first.retention, RetentionSpec::Forever);
    let before = std::fs::read(first.dir.join("meta.json")).unwrap();

    // A later producer open with the legacy "no policy" argument keeps the
    // stored policy and visibility and does not touch the file.
    let again = Bucket::ensure_nested(&root, "h", "lona/ads", "leads", "cell/v1", None).unwrap();
    assert_eq!(again.retention, RetentionSpec::Forever);
    assert_eq!(again.visibility, Visibility::Private);
    assert_eq!(std::fs::read(first.dir.join("meta.json")).unwrap(), before);

    // A different shape is refused, not relabelled.
    let err = Bucket::ensure_nested(&root, "h", "lona/ads", "leads", "span-tree/v1", None)
      .unwrap_err();
    assert!(matches!(
      err.downcast_ref::<BucketError>(),
      Some(BucketError::ShapeMismatch { .. })
    ));

    // set_policy is the explicit writer.
    again
      .set_policy(RetentionSpec::Explicit(tight()), Visibility::Fleet)
      .unwrap();
    let meta = again.load_meta().unwrap().unwrap();
    assert_eq!(meta.shape_tag, "cell/v1");
    assert_eq!(meta.retention, RetentionSpec::Explicit(tight()));
    assert_eq!(meta.visibility, Visibility::Fleet);
    assert_eq!(again.load_retention(), Some(tight()));

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn ensure_repairs_an_empty_meta_but_reports_a_corrupt_one() {
    let root = temp_root("repair");
    let dir = bucket_dir(&root, "h", "n", "b");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("meta.json"), b"").unwrap();
    let b = Bucket::ensure_nested(&root, "h", "n", "b", "cell/v1", None).unwrap();
    assert_eq!(b.load_meta().unwrap().unwrap().shape_tag, "cell/v1");

    std::fs::write(dir.join("meta.json"), b"{\"shape_t").unwrap();
    let err = Bucket::ensure_nested(&root, "h", "n", "b", "cell/v1", None).unwrap_err();
    assert!(matches!(
      err.downcast_ref::<BucketError>(),
      Some(BucketError::CorruptMeta { .. })
    ));
    let disc = BucketRegistry::new(root.join("h")).discover();
    assert!(disc.buckets.is_empty());
    assert_eq!(disc.errors.len(), 1, "corrupt meta is reported, not dropped silently");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn identity_segments_are_validated() {
    let root = temp_root("validate");
    for (host, node, name) in [
      ("..", "n", "b"),
      ("", "n", "b"),
      ("h", "a/../b", "b"),
      ("h", "n", ".."),
      ("h", "n", "."),
      ("h", "n", "a/b"),
      ("h", "n", "a\\b"),
      ("h", "n", "a\0b"),
      ("h/x", "n", "b"),
    ] {
      let err = Bucket::ensure_nested(&root, host, node, name, "cell/v1", None).unwrap_err();
      assert!(
        matches!(err.downcast_ref::<BucketError>(), Some(BucketError::InvalidSegment { .. })),
        "{host:?} {node:?} {name:?}"
      );
    }
    assert!(!root.exists(), "nothing was created");
    assert!(Bucket::ensure(&root, "..", "b", "cell/v1").is_err());
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn walk_ignores_symlinked_dirs_and_cycles() {
    let root = temp_root("symlink");
    Bucket::ensure_nested(&root, "h", "n", "b", "cell/v1", None).unwrap();
    // A cycle back to the host dir and a link to the real bucket.
    std::os::unix::fs::symlink(root.join("h"), root.join("h/n/loop")).unwrap();
    std::os::unix::fs::symlink(root.join("h/n/b"), root.join("h/alias")).unwrap();
    let all = BucketRegistry::new(root.join("h")).list();
    assert_eq!(all.len(), 1, "symlinks not followed: {all:?}");
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn walk_stops_at_the_depth_cap() {
    let root = temp_root("depth");
    let mut deep = root.clone();
    for i in 0..(MAX_WALK_DEPTH + 2) {
      deep = deep.join(format!("d{i}"));
    }
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(deep.join("meta.json"), br#"{"shape_tag":"cell/v1"}"#).unwrap();
    let disc = BucketRegistry::new(&root).discover();
    assert!(disc.buckets.is_empty());
    assert_eq!(disc.errors.len(), 1);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn host_override_wins() {
    set_host_override(Some("fleet-id-x"));
    assert_eq!(host_id(), "fleet-id-x");
    set_host_override(None);
    assert_ne!(host_id(), "fleet-id-x");
  }

  #[test]
  fn fragments_and_path_safety() {
    let root = temp_root("frags");
    let b = Bucket::ensure(&root, "n", "m", "cell/v1").unwrap();
    std::fs::create_dir_all(b.dir.join("samples")).unwrap();
    std::fs::create_dir_all(b.dir.join("daily")).unwrap();
    std::fs::write(b.dir.join("samples/2026-05-23.ljson"), b"{}\n").unwrap();
    std::fs::write(b.dir.join("daily/2026-05-22.parquet"), b"PAR1").unwrap();
    std::fs::write(b.dir.join("samples/ignore.txt"), b"x").unwrap();

    let frags = b.fragments();
    assert_eq!(frags.len(), 2, "only ljson/parquet, not .txt");
    assert_eq!(frags[0].path, "daily/2026-05-22.parquet");
    assert_eq!(frags[1].path, "samples/2026-05-23.ljson");
    assert_eq!(frags[1].bytes, 3);

    assert!(b.resolve("daily/2026-05-22.parquet").is_some());
    assert!(b.resolve("../../etc/passwd").is_none());
    assert!(b.resolve("/etc/passwd").is_none());
    assert!(b.resolve("meta.json").is_none()); // not under a data subdir

    let _ = std::fs::remove_dir_all(&root);
  }
}
