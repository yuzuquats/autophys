//! App-bundle filesystem helpers, extracted verbatim from
//! `tento_core::app_bundle` on 2026-09-15 so that `tento-release` and
//! `tento-package` no longer link the whole of tento-core for three symbols
//! (dependency doctrine rules 1 and 5). Depends on serde, sha2, tokio, toml
//! and tracing only.
//!
//! The `loaf.toml` half (`LoafConfig` and friends) is product-shaped and moves
//! on to the product tree in a later draft; it is kept here so mono's callers
//! keep one import path during the migration.

use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tracing::info;

// ============================================================================
// Version Handling
// ============================================================================

/// Semantic version: `major.minor.patch`, optionally with a prerelease.
///
/// Serializes as a `"major.minor.patch[-prerelease]"` string (not a struct) so
/// it embeds cleanly in TOML/JSON.
///
/// The prerelease exists because a release-ci candidate IS one. The pipeline
/// stamps `1.0.92-candidate.2` into a candidate bundle's VERSION and rewrites
/// it to a plain `1.0.92` on promotion, because the candidate is the
/// pipeline's fact about a build rather than the product's. Until this type
/// could hold that, `loaf deploy` refused every candidate bundle with
/// "expected major.minor.patch", so rc could only ever run a build it had
/// made itself — measured 2026-09-21.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
  pub major: u32,
  pub minor: u32,
  pub patch: u32,
  /// The dot-separated identifiers after the first `-`, e.g. `candidate.2`.
  /// `None` is a release. Build metadata (`+...`) is not modelled, because
  /// nothing in this tree emits it.
  pub prerelease: Option<String>,
}

impl SemVer {
  pub fn parse(s: &str) -> anyhow::Result<Self> {
    let s = s.trim();
    let (core, prerelease) = match s.split_once('-') {
      Some((core, prerelease)) => (core, Some(prerelease)),
      None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
      anyhow::bail!(
        "Invalid version format: expected major.minor.patch[-prerelease], got '{}'",
        s
      );
    }
    let prerelease = match prerelease {
      None => None,
      Some(prerelease) => {
        let well_formed = !prerelease.is_empty()
          && prerelease.split('.').all(|identifier| {
            !identifier.is_empty()
              && identifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
          });
        if !well_formed {
          anyhow::bail!(
            "Invalid prerelease in '{}': identifiers are non-empty and [0-9A-Za-z-]",
            s
          );
        }
        Some(prerelease.to_string())
      }
    };
    Ok(SemVer {
      major: parts[0].parse().context("Invalid major version")?,
      minor: parts[1].parse().context("Invalid minor version")?,
      patch: parts[2].parse().context("Invalid patch version")?,
      prerelease,
    })
  }

  /// Whether this is a candidate rather than a release.
  pub fn is_prerelease(&self) -> bool {
    self.prerelease.is_some()
  }

  /// The release this version belongs to, with any prerelease dropped:
  /// `1.0.92-candidate.2` and `1.0.92` share a core.
  pub fn core(&self) -> SemVer {
    SemVer {
      major: self.major,
      minor: self.minor,
      patch: self.patch,
      prerelease: None,
    }
  }

  /// Whether `deployed` satisfies a caret requirement floored at `self`
  /// (i.e. `^self`): same major and `deployed >= self`. This is the
  /// secrets-surface compatibility check — a binary needing `^2.1.0` runs on
  /// any deployed `2.x >= 2.1.0`, but not on `3.0.0` or `2.0.x`.
  ///
  /// Compared on the release CORE, and that is a deliberate divergence from
  /// strict semver range semantics. `2.1.0-candidate.3` is 2.1.0's bytes and
  /// so presents 2.1.0's secrets surface; its prerelease names which build
  /// produced it, not what it requires. A strict range orders every candidate
  /// below its own release and would refuse to deploy one to rc, which is the
  /// case this type gained a prerelease to serve.
  pub fn caret_satisfied_by(&self, deployed: &SemVer) -> bool {
    let (required, deployed) = (self.core(), deployed.core());
    deployed.major == required.major && deployed >= required
  }

  /// Validates that `new` is exactly one semver increment from `self`.
  /// Returns the bump kind, or an error if the delta is invalid.
  pub fn validate_bump(&self, new: &SemVer) -> anyhow::Result<&'static str> {
    if self.is_prerelease() || new.is_prerelease() {
      anyhow::bail!(
        "Invalid version bump: {self} -> {new}. A bump steps between releases; \
         a prerelease is cut FROM a release, never stepped to.",
      );
    }
    let major_d = new.major as i64 - self.major as i64;
    let minor_d = new.minor as i64 - self.minor as i64;
    let patch_d = new.patch as i64 - self.patch as i64;

    match (major_d, minor_d, patch_d) {
      (1, _, _) if new.minor == 0 && new.patch == 0 => Ok("major"),
      (0, 1, _) if new.patch == 0 => Ok("minor"),
      (0, 0, 1) => Ok("patch"),
      _ => anyhow::bail!(
        "Invalid version bump: {self} -> {new}. Must be exactly +1 major, +1 minor, or +1 patch.",
      ),
    }
  }
}

/// Precedence between two prerelease strings, per semver §11.4: compare
/// dot-separated identifiers left to right; a numeric identifier compares
/// numerically and always ranks below an alphanumeric one; when every shared
/// identifier is equal, the longer set wins.
fn cmp_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
  use std::cmp::Ordering;
  for (x, y) in a.split('.').zip(b.split('.')) {
    let ordering = match (
      !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit()),
      !y.is_empty() && y.bytes().all(|c| c.is_ascii_digit()),
    ) {
      // Unbounded digit strings have no integer-overflow boundary. Keeping
      // their length also distinguishes legacy leading-zero spellings;
      // compare-equal must agree with the type's string-based equality.
      (true, true) => x.len().cmp(&y.len()).then_with(|| x.cmp(y)),
      (true, false) => Ordering::Less,
      (false, true) => Ordering::Greater,
      (false, false) => x.cmp(y),
    };
    if ordering != Ordering::Equal {
      return ordering;
    }
  }
  a.split('.').count().cmp(&b.split('.').count())
}

/// Hand-written because a derive gets the prerelease BACKWARDS: Rust orders
/// `None < Some(_)`, but a prerelease sorts below its own release
/// (`1.0.92-candidate.2 < 1.0.92`). The field order still makes the numeric
/// part correct; only the tail needed saying out loud.
impl Ord for SemVer {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    (self.major, self.minor, self.patch)
      .cmp(&(other.major, other.minor, other.patch))
      .then_with(
        || match (self.prerelease.as_deref(), other.prerelease.as_deref()) {
          (None, None) => Ordering::Equal,
          (None, Some(_)) => Ordering::Greater,
          (Some(_), None) => Ordering::Less,
          (Some(a), Some(b)) => cmp_prerelease(a, b),
        },
      )
  }
}

impl PartialOrd for SemVer {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

impl std::fmt::Display for SemVer {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
    match &self.prerelease {
      Some(prerelease) => write!(f, "-{prerelease}"),
      None => Ok(()),
    }
  }
}

impl Serialize for SemVer {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&self.to_string())
  }
}

impl<'de> Deserialize<'de> for SemVer {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    let s = String::deserialize(deserializer)?;
    SemVer::parse(&s).map_err(serde::de::Error::custom)
  }
}

// ============================================================================
// Loaf Configuration (loaf.toml)
// ============================================================================

const LOAF_CONFIG_FILE: &str = "loaf.toml";

/// Root configuration structure for loaf.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoafConfig {
  pub version: VersionConfig,
  /// Optional `[build]` section. Modeled here (not ignored) because the
  /// version setters round-trip the whole file through this struct — an
  /// unmodeled section would be silently dropped on the next bump.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub build: Option<BuildConfig>,
  /// Optional `[recorder]` section — the fleet-collector's own build host
  /// (a macOS machine; distinct from loaf's linux `[build] host`). Modeled
  /// here for the same round-trip reason as `[build]`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub recorder: Option<RecorderConfig>,
  /// Optional `[host_health]` section — the host-health daemon's build host
  /// (host-health is per-arch and ships a standalone `tento-host-health-node`
  /// binary). Modeled here for the same round-trip reason as `[build]`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub host_health: Option<HostHealthBuildConfig>,
  /// Optional `[builtin_http]` section — the builtin-http server's build host
  /// (per-arch, ships a standalone `tento-builtin-http-server` binary). Modeled
  /// here for the same round-trip reason as `[build]`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub builtin_http: Option<BuiltinHttpBuildConfig>,
  /// Optional `[admin]` section — the admin.lona origin's build host (native
  /// macOS, single-host: build host == deploy host). Modeled here for the same
  /// round-trip reason as `[build]`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub admin: Option<AdminBuildConfig>,
}

/// Version configuration section in loaf.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionConfig {
  pub server: String,
  pub frontend: String,
}

/// Build configuration section in loaf.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildConfig {
  /// Fleet host id of the canonical build machine (e.g. `"yuzuquats"`).
  /// Release binaries are always built there: `lona.releases ship` builds
  /// natively when it runs on this host and routes through the
  /// `loaf.release` envelope (remote build + pull) from anywhere else.
  pub host: String,
}

/// `[recorder]` section in loaf.toml — the fleet-collector's build host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderConfig {
  /// Fleet host id of the recorder's build machine (a macOS host, e.g.
  /// `"rwc-01"`). The recorder bundle is a native macOS build, so it can't
  /// reuse loaf's linux `[build] host`. `recorder ship` builds natively here
  /// and routes through the `recorder.release` envelope from anywhere else.
  pub build_host: String,
}

/// `[host_health]` section in loaf.toml — the host-health daemon's build host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostHealthBuildConfig {
  /// Fleet host id of the host-health build machine (e.g. `"yuzuquats"` for the
  /// linux `x86_64-linux` bundle that every Linux host runs). `host-health ship`
  /// builds natively here and routes through the `host-health.release` envelope
  /// from anywhere else; cross-arch (the operator Mac's `arm64-darwin`) uses the
  /// `--build local --target …` escape hatch.
  pub build_host: String,
}

/// `[admin]` section in loaf.toml — the admin.lona origin's build host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminBuildConfig {
  /// Fleet host id of the admin build machine (the operator Mac, e.g. `"rwc-01"`;
  /// admin.lona is native macOS and builds + deploys on the same host). `admin.lona
  /// ship` builds natively here and routes through the `admin.lona.release` envelope
  /// from anywhere else.
  pub build_host: String,
}

/// `[builtin_http]` section in loaf.toml — the builtin-http server's build host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinHttpBuildConfig {
  /// Fleet host id of the builtin-http build machine (e.g. `"yuzuquats"` for the
  /// linux `x86_64-linux` bundle). `builtin-http ship` builds natively here and
  /// routes through the `builtin-http.release` envelope from anywhere else;
  /// cross-arch uses the `--build local --target …` escape hatch.
  pub build_host: String,
}

/// Read loaf.toml configuration from a specific directory
pub fn read_loaf_config_from(dir: &Path) -> anyhow::Result<LoafConfig> {
  let config_file = dir.join(LOAF_CONFIG_FILE);
  let content = std::fs::read_to_string(&config_file).context(format!(
    "Failed to read {} at {:?}",
    LOAF_CONFIG_FILE, config_file
  ))?;
  toml::from_str(&content).context(format!("Failed to parse {}", LOAF_CONFIG_FILE))
}

/// Find loaf.toml by searching up the directory tree from the given starting point.
/// Returns the directory containing loaf.toml, or None if not found.
pub fn find_loaf_config_dir(start: &Path) -> Option<PathBuf> {
  let mut current = start.to_path_buf();
  loop {
    if current.join(LOAF_CONFIG_FILE).exists() {
      return Some(current);
    }
    if !current.pop() {
      return None;
    }
  }
}

/// Read loaf.toml configuration from the current directory
fn read_loaf_config() -> anyhow::Result<LoafConfig> {
  let cwd = std::env::current_dir().context("Failed to get current directory")?;
  read_loaf_config_from(&cwd)
}

/// Write loaf.toml configuration to the current directory
fn write_loaf_config(config: &LoafConfig) -> anyhow::Result<()> {
  let cwd = std::env::current_dir().context("Failed to get current directory")?;
  let config_file = cwd.join(LOAF_CONFIG_FILE);
  let content = toml::to_string_pretty(config).context("Failed to serialize config")?;
  std::fs::write(&config_file, content).context(format!(
    "Failed to write {} at {:?}",
    LOAF_CONFIG_FILE, config_file
  ))?;
  Ok(())
}

/// Read server version from loaf.toml in the current directory
pub fn read_version() -> anyhow::Result<SemVer> {
  let config = read_loaf_config()?;
  SemVer::parse(&config.version.server)
}

/// Write server version to loaf.toml in the current directory
pub fn write_version(version: &SemVer) -> anyhow::Result<()> {
  let mut config = read_loaf_config()?;
  config.version.server = version.to_string();
  write_loaf_config(&config)
}

/// Read the canonical build host from loaf.toml's `[build] host` in the
/// current directory. `None` when the section is absent (build locally).
pub fn read_build_host() -> anyhow::Result<Option<String>> {
  let config = read_loaf_config()?;
  Ok(config.build.map(|b| b.host))
}

/// Read the fleet-collector build host from loaf.toml's `[recorder] build_host`
/// in the current directory. `None` when the section is absent (build locally).
pub fn read_recorder_build_host() -> anyhow::Result<Option<String>> {
  let config = read_loaf_config()?;
  Ok(config.recorder.map(|r| r.build_host))
}

/// Read the host-health build host from loaf.toml's `[host_health] build_host`
/// in the current directory. `None` when the section is absent (build locally).
pub fn read_host_health_build_host() -> anyhow::Result<Option<String>> {
  let config = read_loaf_config()?;
  Ok(config.host_health.map(|h| h.build_host))
}

/// Read the builtin-http build host from loaf.toml's `[builtin_http] build_host`
/// in the current directory. `None` when the section is absent (build locally).
pub fn read_builtin_http_build_host() -> anyhow::Result<Option<String>> {
  let config = read_loaf_config()?;
  Ok(config.builtin_http.map(|h| h.build_host))
}

/// Read the admin.lona build host from loaf.toml's `[admin] build_host` in the
/// current directory. `None` when the section is absent (build locally).
pub fn read_admin_build_host() -> anyhow::Result<Option<String>> {
  let config = read_loaf_config()?;
  Ok(config.admin.map(|h| h.build_host))
}

/// Read frontend version from loaf.toml in the current directory
pub fn read_fe_version() -> anyhow::Result<SemVer> {
  let config = read_loaf_config()?;
  SemVer::parse(&config.version.frontend)
}

/// Read frontend version from loaf.toml in a specific directory
pub fn read_fe_version_from(dir: &Path) -> anyhow::Result<SemVer> {
  let config = read_loaf_config_from(dir)?;
  SemVer::parse(&config.version.frontend)
}

/// Write frontend version to loaf.toml in the current directory
pub fn write_fe_version(version: &SemVer) -> anyhow::Result<()> {
  let mut config = read_loaf_config()?;
  config.version.frontend = version.to_string();
  write_loaf_config(&config)
}

// ============================================================================
// Fingerprinting & Git
// ============================================================================

/// Compute SHA256 fingerprint of a file, returning first 8 hex chars.
/// This reads the entire file into memory - use `compute_fingerprint_fast` for large files.
pub fn compute_fingerprint(path: &Path) -> anyhow::Result<String> {
  let bytes = std::fs::read(path).context(format!("Failed to read file: {:?}", path))?;
  let hash = Sha256::digest(&bytes);
  Ok(format!("{:x}", hash)[..8].to_string())
}

/// Compute fast fingerprint using file metadata (size + mtime).
/// Much faster than content hash for large files. Suitable for dev bundles.
pub fn compute_fingerprint_fast(path: &Path) -> anyhow::Result<String> {
  let metadata = std::fs::metadata(path).context(format!("Failed to get metadata: {:?}", path))?;
  let size = metadata.len();
  let mtime = metadata
    .modified()
    .context("Failed to get mtime")?
    .duration_since(std::time::UNIX_EPOCH)
    .context("Invalid mtime")?
    .as_secs();

  // Hash size + mtime to get a fingerprint
  let data = format!("{}:{}", size, mtime);
  let hash = Sha256::digest(data.as_bytes());
  Ok(format!("{:x}", hash)[..8].to_string())
}

/// The short commit of the source being built in the current directory.
///
/// `TENTO_BUILD_GIT_HASH` (7-40 lowercase hex), set by a packager building a
/// `git archive`, wins. Otherwise git's answer counts only when the repository
/// it finds tracks the current directory: `git rev-parse` walks up past an
/// untracked directory to whatever checkout encloses it, and stamped the
/// campaign RC with an unrelated workspace HEAD. Same rule as
/// `tento_package::get_git_short_hash`; fails when neither names a commit.
pub async fn get_git_short_hash() -> anyhow::Result<String> {
  if let Ok(explicit) = std::env::var("TENTO_BUILD_GIT_HASH") {
    let explicit = explicit.trim();
    if !explicit.is_empty() {
      let hex = (7..=40).contains(&explicit.len())
        && explicit
          .bytes()
          .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
      anyhow::ensure!(hex, "TENTO_BUILD_GIT_HASH is not 7-40 lowercase hex");
      return Ok(explicit.to_string());
    }
  }
  let tracked = Command::new("git")
    .args(["ls-files", "--error-unmatch", "--", "."])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .status()
    .await
    .context("Failed to execute git ls-files")?;
  anyhow::ensure!(
    tracked.success(),
    "the build directory is not tracked by a git checkout; set TENTO_BUILD_GIT_HASH"
  );
  let output = Command::new("git")
    .args(["rev-parse", "--short", "HEAD"])
    .output()
    .await
    .context("Failed to execute git rev-parse")?;
  anyhow::ensure!(output.status.success(), "git rev-parse failed");

  let hash = String::from_utf8(output.stdout)
    .context("Invalid UTF-8 in git output")?
    .trim()
    .to_string();

  Ok(hash)
}

// ============================================================================
// File Utilities
// ============================================================================

/// Recursively copy a directory
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
  if !src.exists() {
    return Ok(());
  }

  if !dst.exists() {
    std::fs::create_dir_all(dst).context(format!("Failed to create dir: {:?}", dst))?;
  }

  for entry in std::fs::read_dir(src).context(format!("Failed to read directory: {:?}", src))? {
    let entry = entry.context("Failed to read dir entry")?;
    let src_path = entry.path();
    let dst_path = dst.join(entry.file_name());

    if src_path.is_dir() {
      copy_dir_recursive(&src_path, &dst_path)?;
    } else {
      std::fs::copy(&src_path, &dst_path)
        .context(format!("Failed to copy {:?} to {:?}", src_path, dst_path))?;
    }
  }

  Ok(())
}

// ============================================================================
// Content Mode
// ============================================================================

/// How to handle content (HTML, secrets, etc.) when creating a bundle
#[derive(Default, Clone, Debug)]
pub enum ContentMode {
  /// Skip this content entirely
  #[default]
  None,
  /// Copy content from the source path
  Copy(PathBuf),
  /// Create a symlink to the source path
  Symlink(PathBuf),
  /// Create empty directory structure
  CreateDir,
}

// ============================================================================
// Bundle Path Helpers
// ============================================================================

/// The per-user store where an app's bundles live: `<home>/.local/share/tento/<app>`.
///
/// ONE definition, because every caller that recomputes it is a chance for two
/// halves of the same install to disagree about where the install is. `tsh`
/// alone had six independent copies of this expression — the packager, the
/// promote path (whose comment conceded the duplication), the stable-channel
/// resolver, the dev-channel resolver, and two launcher scripts.
///
/// `override_dir` is the caller's escape hatch, threaded down from whatever
/// env key that app declares (tento-core stays app-agnostic and bakes no key
/// names). It is not a convenience: `HOME` is seeded from `getpwuid_r`, not
/// from `$HOME`, so a test CANNOT relocate the store by setting an environment
/// variable. Without an explicit override there is no way to exercise store
/// mutation off the developer's real install.
pub fn app_store_dir(app: &str, override_dir: Option<&str>) -> anyhow::Result<PathBuf> {
  if let Some(dir) = override_dir.map(str::trim).filter(|d| !d.is_empty()) {
    return Ok(PathBuf::from(dir));
  }
  // Windows: the local (non-roaming) profile is the payload store — bundles
  // are machine-local artifacts, the analogue of ~/.local/share.
  #[cfg(windows)]
  if let Some(local) = std::env::var_os("LOCALAPPDATA") {
    return Ok(PathBuf::from(local).join("tento").join(app));
  }
  use tento_env::FromEnvVar as _;
  let home = tento_env::Home::from_env()
    .map_err(|e| anyhow!("resolving HOME for the {app} store dir: {e}"))?;
  Ok(home.into_value().0.join(".local/share/tento").join(app))
}

/// Atomically update `link_path` to point at `target`.
///
/// Writes the new symlink to a unique sibling staging path, then renames it
/// over `link_path`. POSIX `rename(2)` is atomic when source and target are
/// on the same filesystem (guaranteed: same parent dir) and replaces an
/// existing entry — so a concurrent reader sees either the old symlink or
/// the new one, never a missing one. Failure leaves the existing link in
/// place; the staging path is cleaned up.
pub fn update_symlink(link_path: &Path, target: &str) -> anyhow::Result<()> {
  let parent = link_path.parent().unwrap_or_else(|| Path::new("."));
  let file_name = link_path
    .file_name()
    .and_then(|n| n.to_str())
    .ok_or_else(|| anyhow!("symlink path has no file_name component: {link_path:?}"))?;
  let unique = format!(
    "{}.{}",
    std::process::id(),
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0)
  );
  let tmp = parent.join(format!(".{file_name}.tmp.{unique}"));
  // Defend against a stale staging entry from a prior crashed run.
  let _ = std::fs::remove_file(&tmp);
  #[cfg(unix)]
  std::os::unix::fs::symlink(target, &tmp)
    .with_context(|| format!("create staging symlink {tmp:?} -> {target}"))?;
  // Windows splits symlink creation by kind (and needs Developer Mode or
  // SeCreateSymbolicLinkPrivilege — surfaced as the create error if absent).
  #[cfg(windows)]
  {
    let create = if parent.join(target).is_dir() {
      std::os::windows::fs::symlink_dir
    } else {
      std::os::windows::fs::symlink_file
    };
    create(Path::new(target), &tmp)
      .with_context(|| format!("create staging symlink {tmp:?} -> {target}"))?;
  }
  if let Err(error) = std::fs::rename(&tmp, link_path) {
    let _ = std::fs::remove_file(&tmp);
    return Err(error).with_context(|| format!("atomic rename {tmp:?} -> {link_path:?}"));
  }
  info!("Updated symlink {:?} -> {}", link_path, target);
  Ok(())
}

/// Bundle VERSION file contents.
#[derive(Debug, Clone)]
pub struct BundleVersionFile {
  pub version: SemVer,
  pub hash: String,
  pub binary_fingerprint: String,
}

impl BundleVersionFile {
  /// Parse VERSION file content from a bundle.
  pub fn parse(content: &str) -> anyhow::Result<Self> {
    let mut version = None;
    let mut hash = None;
    let mut fingerprint = None;

    for line in content.lines() {
      if let Some((key, value)) = line.split_once('=') {
        match key {
          "version" => version = Some(SemVer::parse(value)?),
          "hash" => hash = Some(value.to_string()),
          "binary_fingerprint" => fingerprint = Some(value.to_string()),
          _ => {}
        }
      }
    }

    Ok(Self {
      version: version.context("Missing version in VERSION file")?,
      hash: hash.context("Missing hash in VERSION file")?,
      binary_fingerprint: fingerprint.context("Missing binary_fingerprint in VERSION file")?,
    })
  }

  /// Read and parse VERSION file from a bundle path.
  pub fn from_bundle(bundle_path: &Path) -> anyhow::Result<Self> {
    let version_path = bundle_path.join("VERSION");
    let content = std::fs::read_to_string(&version_path)
      .context(format!("Failed to read VERSION file at {:?}", version_path))?;
    Self::parse(&content)
  }

  /// Generate release bundle name.
  pub fn release_name(&self) -> String {
    format!(
      "Loaf-{}-{}-{}.app",
      self.version.to_string(),
      self.hash,
      self.binary_fingerprint
    )
  }
}

/// Publishes a pending bundle by reading VERSION file and renaming appropriately.
/// Returns the new bundle path.
pub fn publish_pending_bundle(bundle_path: &Path) -> anyhow::Result<PathBuf> {
  let bundle_name = bundle_path
    .file_name()
    .context("Invalid bundle path")?
    .to_string_lossy()
    .to_string();

  if bundle_name != "Loaf-pending.app" {
    anyhow::bail!("Bundle is not a pending bundle: {}", bundle_name);
  }

  // Read VERSION file to get release name
  let version_info = BundleVersionFile::from_bundle(bundle_path)?;
  let release_name = version_info.release_name();

  let parent = bundle_path
    .parent()
    .context("Bundle has no parent directory")?;
  let release_path = parent.join(&release_name);

  // Remove existing release if it exists
  if release_path.exists() {
    std::fs::remove_dir_all(&release_path).context("Failed to remove existing release bundle")?;
  }

  // Rename pending to release
  std::fs::rename(bundle_path, &release_path).context("Failed to rename bundle")?;
  info!("Bundle published: {} -> {}", bundle_name, release_name);

  Ok(release_path)
}

/// Find existing pending bundle matching a prefix pattern
/// e.g., find_pending_bundle(releases_dir, "MyApp-1.0.0-") finds "MyApp-1.0.0-abc123-pending.app"
pub fn find_pending_bundle(releases_dir: &Path, prefix: &str) -> Option<PathBuf> {
  let Ok(entries) = std::fs::read_dir(releases_dir) else {
    return None;
  };

  for entry in entries.flatten() {
    let name = entry.file_name();
    let name_str = name.to_string_lossy();
    if name_str.starts_with(prefix) && name_str.ends_with("-pending.app") {
      return Some(entry.path());
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The shape release-ci actually stamps into a candidate bundle's VERSION.
  /// This is the string `loaf deploy` refused on 2026-09-21, which is why the
  /// prerelease is modelled at all.
  #[test]
  fn a_candidate_version_parses_and_round_trips() {
    let candidate = SemVer::parse("1.0.92-candidate.2").unwrap();
    assert_eq!((candidate.major, candidate.minor, candidate.patch), (1, 0, 92));
    assert_eq!(candidate.prerelease.as_deref(), Some("candidate.2"));
    assert!(candidate.is_prerelease());
    assert_eq!(candidate.to_string(), "1.0.92-candidate.2");
    // Serialize/Deserialize delegate to Display/parse verbatim, so this IS the
    // serde round trip, without pulling serde_json into a crate kept lean.
    // `PackageMetadata` covers the real VERSION-file JSON in tento-package.
    assert_eq!(SemVer::parse(&candidate.to_string()).unwrap(), candidate);
  }

  /// A plain release is unchanged: still parses, still prints without a tail,
  /// and reports itself as a release.
  #[test]
  fn a_release_is_unchanged() {
    let release = SemVer::parse("1.0.92").unwrap();
    assert_eq!(release.prerelease, None);
    assert!(!release.is_prerelease());
    assert_eq!(release.to_string(), "1.0.92");
    assert!(SemVer::parse("1.2").is_err());
    assert!(SemVer::parse("1.2.3.4").is_err());
  }

  /// The trap a derived `Ord` walks into: Rust orders `None < Some(_)`, which
  /// would rank every candidate ABOVE its own release and let a candidate
  /// satisfy a floor its release does not.
  #[test]
  fn a_prerelease_sorts_below_its_release() {
    let release = SemVer::parse("1.0.92").unwrap();
    let candidate = SemVer::parse("1.0.92-candidate.2").unwrap();
    assert!(candidate < release);
    assert!(release > candidate);
    assert_ne!(candidate, release);
    // and the numeric core still dominates the prerelease
    assert!(release < SemVer::parse("1.0.93-candidate.1").unwrap());
  }

  /// Semver §11.4 precedence: numeric identifiers compare numerically (so
  /// candidate.10 is not "less than" candidate.2 by string order), a numeric
  /// identifier ranks below an alphanumeric one, and when every shared
  /// identifier matches the longer set wins.
  #[test]
  fn prerelease_precedence_follows_semver() {
    let v = |s: &str| SemVer::parse(s).unwrap();
    assert!(v("1.0.0-candidate.2") < v("1.0.0-candidate.10"));
    assert!(v("1.0.0-1") < v("1.0.0-alpha"));
    assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
    assert!(v("1.0.0-alpha.1") < v("1.0.0-beta"));
    assert_eq!(v("1.0.0-candidate.2"), v("1.0.0-candidate.2"));
  }

  /// A tail that is not a well-formed identifier set is refused rather than
  /// stored verbatim — the string round-trips through Display, so an
  /// unparseable one would come back out of a VERSION file unchanged.
  #[test]
  fn a_malformed_prerelease_is_refused() {
    for bad in ["1.0.92-", "1.0.92-.2", "1.0.92-candidate..2", "1.0.92-cand_2"] {
      assert!(SemVer::parse(bad).is_err(), "expected {bad:?} to be refused");
    }
  }

  /// The secrets-surface check compares release cores on purpose: a candidate
  /// IS its release's bytes, so it presents that release's surface. Under
  /// strict semver range semantics the first assertion would fail and rc could
  /// never be handed a candidate.
  #[test]
  fn a_candidate_satisfies_its_own_releases_floor() {
    let floor = SemVer::parse("2.1.0").unwrap();
    assert!(floor.caret_satisfied_by(&SemVer::parse("2.1.0-candidate.3").unwrap()));
    assert!(floor.caret_satisfied_by(&SemVer::parse("2.3.0-candidate.1").unwrap()));
    // the core still decides: a lower or cross-major candidate is refused
    assert!(!floor.caret_satisfied_by(&SemVer::parse("2.0.9-candidate.1").unwrap()));
    assert!(!floor.caret_satisfied_by(&SemVer::parse("3.0.0-candidate.1").unwrap()));
  }

  /// A bump is a step between releases. Cutting `1.0.92-candidate.1` from
  /// `1.0.91` is not a patch bump, and calling it one would let the pipeline's
  /// candidate counter drive a product's version.
  #[test]
  fn validate_bump_refuses_a_prerelease_on_either_side() {
    let release = SemVer::parse("1.0.91").unwrap();
    let candidate = SemVer::parse("1.0.92-candidate.1").unwrap();
    assert!(release.validate_bump(&candidate).is_err());
    assert!(candidate.validate_bump(&release).is_err());
    // releases still bump exactly as before
    assert_eq!(
      release.validate_bump(&SemVer::parse("1.0.92").unwrap()).unwrap(),
      "patch"
    );
  }

  /// First-deploy: link_path doesn't exist yet — stage + rename still produces
  /// An explicit override wins outright and is used verbatim — this is the
  /// only way a test can point the store somewhere scratch, because `HOME`
  /// comes from `getpwuid_r` rather than `$HOME` and so cannot be redirected
  /// by setting an environment variable.
  #[test]
  fn app_store_dir_prefers_an_explicit_override() {
    let dir = tempfile::tempdir().unwrap();
    let scratch = dir.path().join("scratch-store");
    let resolved = app_store_dir("tsh", Some(scratch.to_str().unwrap())).unwrap();
    assert_eq!(resolved, scratch);
  }

  /// A blank or whitespace-only override is not an override — it falls back to
  /// the per-user default rather than resolving the store to "" (which would
  /// silently become the process cwd).
  #[test]
  fn app_store_dir_ignores_a_blank_override() {
    let default = app_store_dir("tsh", None).unwrap();
    for blank in ["", "   "] {
      assert_eq!(app_store_dir("tsh", Some(blank)).unwrap(), default);
    }
    assert!(default.ends_with("tsh"));
    assert!(default.to_string_lossy().contains(".local/share/tento"));
  }

  /// The app name is the last component, so two apps never share a store.
  #[test]
  fn app_store_dir_is_keyed_by_app_name() {
    let tsh = app_store_dir("tsh", None).unwrap();
    let loaf = app_store_dir("Loaf", None).unwrap();
    assert_ne!(tsh, loaf);
    assert_eq!(tsh.parent(), loaf.parent());
  }

  /// a working symlink.
  #[test]
  fn update_symlink_creates_on_fresh_dir() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("Loaf-latest.app");
    assert!(!link.exists());
    update_symlink(&link, "Loaf-1.0.0.app").unwrap();
    assert_eq!(
      std::fs::read_link(&link).unwrap(),
      PathBuf::from("Loaf-1.0.0.app")
    );
  }

  /// The core guarantee: existing link is replaced with the new target.
  #[test]
  fn update_symlink_replaces_existing_target() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("Loaf-latest.app");
    std::os::unix::fs::symlink("Loaf-1.0.0.app", &link).unwrap();
    assert_eq!(
      std::fs::read_link(&link).unwrap(),
      PathBuf::from("Loaf-1.0.0.app")
    );

    update_symlink(&link, "Loaf-1.0.1.app").unwrap();
    assert_eq!(
      std::fs::read_link(&link).unwrap(),
      PathBuf::from("Loaf-1.0.1.app")
    );
  }

  /// After a successful update, no staging entry (`.<name>.tmp.*`) is left
  /// lingering in the parent dir.
  #[test]
  fn update_symlink_leaves_no_staging_residue() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("Loaf-latest.app");
    update_symlink(&link, "Loaf-1.0.0.app").unwrap();

    let staging: Vec<_> = std::fs::read_dir(dir.path())
      .unwrap()
      .map(|e| e.unwrap().file_name())
      .filter(|n| {
        let s = n.to_string_lossy();
        s.starts_with(".Loaf-latest.app.tmp.")
      })
      .collect();
    assert!(
      staging.is_empty(),
      "expected no staging tmp entries after successful update, got: {staging:?}"
    );
  }
}

#[cfg(test)]
mod prerelease_boundary_tests {
  use super::SemVer;
  use std::cmp::Ordering;

  fn version(identifier: &str) -> SemVer {
    SemVer::parse(&format!("1.2.3-{identifier}")).unwrap()
  }

  #[test]
  fn numeric_identifiers_do_not_overflow_into_alphanumeric_ordering() {
    let maximum = version("18446744073709551615");
    let overflow = version("18446744073709551616");
    let larger = version("100000000000000000000");
    let enormous = version(&"9".repeat(256));
    assert!(maximum < overflow);
    assert!(
      overflow < larger,
      "numeric magnitude must not use lexical order alone"
    );
    assert!(larger < enormous);
    assert!(
      enormous < version("1alpha"),
      "all numeric identifiers precede alphanumeric ones"
    );
    assert!(version("candidate.18446744073709551616") < version("candidate.1alpha"));
  }

  #[test]
  fn leading_zero_spellings_do_not_compare_equal() {
    // Parsing remains permissive for existing stored spellings. The total
    // order must distinguish them even though strict SemVer disallows them.
    let one = version("candidate.1");
    let padded = version("candidate.01");
    assert_ne!(one, padded);
    assert_eq!(one.cmp(&padded), Ordering::Less);
    assert_eq!(padded.cmp(&one), Ordering::Greater);
    assert!(version("candidate.0") < version("candidate.00"));
    let set = std::collections::BTreeSet::from([one, padded]);
    assert_eq!(
      set.len(),
      2,
      "an ordered collection must retain distinct versions"
    );
  }

  #[test]
  fn boundary_order_is_total_and_agrees_with_equality() {
    let sorted: Vec<_> = [
      "0",
      "1",
      "2",
      "9",
      "00",
      "01",
      "10",
      "99",
      "000",
      "18446744073709551615",
      "18446744073709551616",
      "99999999999999999999",
      "100000000000000000000",
      "1alpha",
      "alpha",
      "alpha.0",
      "alpha.1",
      "alpha.01",
      "alpha.18446744073709551616",
      "alpha.1alpha",
      "beta",
    ]
    .into_iter()
    .map(version)
    .chain([SemVer::parse("1.2.3").unwrap()])
    .collect();
    for (i, left) in sorted.iter().enumerate() {
      for (j, right) in sorted.iter().enumerate() {
        assert_eq!(left.cmp(right), i.cmp(&j), "{left} vs {right}");
        assert_eq!(left.cmp(right) == Ordering::Equal, left == right);
      }
    }
    assert!(version("beta") < SemVer::parse("1.2.3").unwrap());
    assert!(SemVer::parse("1.2.3").unwrap() < SemVer::parse("1.2.4-0").unwrap());
  }
}
