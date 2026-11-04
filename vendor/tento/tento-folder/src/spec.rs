//! Runtime folder specs — the owned counterpart of [`crate::Schema`].
//!
//! A [`Schema`](crate::Schema) is `&'static` and only the `folder!` macro
//! builds one, so a layout has to be known at compile time. A [`Spec`]
//! is plain owned data: it can be built from a file read at runtime
//! (the `folder.*` tsh prelude, see [`crate::tsh`], or any JSON with the
//! same shape via [`Spec::from_json`]) and validated against a
//! directory without generating any code.
//!
//! # Matching
//!
//! Literal entries are checked first and **claim** their names: a child a
//! literal names is never also offered to a glob. Every other child goes to
//! the glob entry (`*` / `?`) that matches it — the most specific one (most
//! non-wildcard characters) when several do, so entry order never matters.
//! (The macro-built [`Schema`](crate::Schema) instead takes the first
//! matching glob in declaration order; a JSON map has no order to rely on.)
//! Beyond what the macro form checks:
//!
//! - a **closed** folder reports every child no entry claims as
//!   [`FolderError::Unexpected`];
//! - a **none** entry forbids what it matches — a literal that must not
//!   exist, or a glob that carves an exception out of a broader one
//!   (`{"tento-*" dir, "tento-*.docs" none}`): every match is
//!   [`FolderError::Forbidden`], open folder or closed;
//! - a **required** glob must match at least one child *besides* those a
//!   literal claimed — `{"mod.rs" file, "*.rs" (some file)}` wants a `.rs`
//!   file other than `mod.rs`.
//!
//! Symlinks are followed: a link counts as whatever it points at, and a
//! dangling link is an [`FolderError::Io`] violation.
//!
//! # JSON shape
//!
//! A node is a map with a `kind` of `"file"`, `"folder"`, `"any"` or
//! `"none"` (forbidden: whatever the entry matches is a violation).
//! Folder nodes carry `entries` (on-disk name or glob → node) and
//! `closed`; an entry may carry `optional` when its name is a literal, or
//! `required` when it is a glob. Anything else — `entries` on a file,
//! `optional` on a glob, a flag on the root, a `.` / `..` name — is a
//! [`SpecError`], never silently ignored:
//!
//! ```json
//! {"kind": "folder", "closed": true, "entries": {
//!   "Cargo.toml": {"kind": "file"},
//!   "src": {"kind": "folder", "entries": {"*.rs": {"kind": "file", "required": true}}}
//! }}
//! ```

use std::path::{Path, PathBuf};

use crate::error::{FolderError, NodeKind};
use crate::glob_match;
use crate::validate::Validator;

/// An owned folder layout: what a directory must (and, when
/// [`closed`](Self::closed), may only) contain.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spec {
  pub entries: Vec<SpecEntry>,
  /// Children matched by no entry are violations.
  pub closed: bool,
}

/// One entry of a [`Spec`]: a literal name or a glob pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecEntry {
  pub pattern: String,
  /// A literal entry that may be absent. Meaningless on globs.
  pub optional: bool,
  /// A glob entry that must match at least one child. Meaningless on
  /// literals (they are required unless `optional`).
  pub required: bool,
  pub kind: SpecKind,
}

/// What a [`SpecEntry`] must be on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecKind {
  File,
  /// A folder whose children follow the nested spec.
  Folder(Spec),
  /// Anything — existence only (the `Folder::Dynamic` analogue).
  Any,
  /// Forbidden: anything this entry matches is
  /// [`FolderError::Forbidden`]. Never `optional` or `required`.
  None,
}

/// A spec document that does not describe a valid [`Spec`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid folder spec at {at}: {message}")]
pub struct SpecError {
  /// Slash-joined entry path inside the spec (`.` for the root).
  pub at: String,
  pub message: String,
}

impl SpecError {
  pub fn new(at: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      at: at.into(),
      message: message.into(),
    }
  }
}

impl SpecEntry {
  pub fn new(pattern: impl Into<String>, kind: SpecKind) -> Self {
    Self {
      pattern: pattern.into(),
      optional: false,
      required: false,
      kind,
    }
  }

  pub fn optional(mut self) -> Self {
    self.optional = true;
    self
  }

  pub fn required(mut self) -> Self {
    self.required = true;
    self
  }

  /// Whether the pattern is a glob rather than a literal name.
  pub fn is_glob(&self) -> bool {
    is_glob(&self.pattern)
  }
}

fn is_glob(pattern: &str) -> bool {
  pattern.contains(['*', '?'])
}

/// How specific a glob is: its count of non-wildcard characters.
fn literal_chars(pattern: &str) -> usize {
  pattern.chars().filter(|c| !matches!(c, '*' | '?')).count()
}

impl SpecKind {
  fn node_kind(&self) -> Option<NodeKind> {
    match self {
      SpecKind::File => Some(NodeKind::File),
      SpecKind::Folder(_) => Some(NodeKind::Folder),
      SpecKind::Any | SpecKind::None => None,
    }
  }
}

impl Spec {
  pub fn new(entries: Vec<SpecEntry>) -> Self {
    Self {
      entries,
      closed: false,
    }
  }

  pub fn closed(entries: Vec<SpecEntry>) -> Self {
    Self {
      entries,
      closed: true,
    }
  }

  /// Validate `root` against this spec, collecting every violation.
  pub fn validate(&self, root: &Path) -> Result<(), FolderError> {
    let mut validator = Validator::new();
    if let Some(e) = check_kind(root, Some(NodeKind::Folder)) {
      validator.push_error(e);
    } else {
      self.validate_with(&mut validator, root);
    }
    validator.finish()
  }

  /// Validate the folder at `path` (known to exist) into `validator`.
  pub fn validate_with(&self, validator: &mut Validator, path: &Path) {
    let (mut globs, literals): (Vec<&SpecEntry>, Vec<&SpecEntry>) =
      self.entries.iter().partition(|e| e.is_glob());
    // Most specific first, so overlapping globs resolve the same way
    // whatever order the entries arrived in (a JSON map has none).
    globs.sort_by(|a, b| {
      literal_chars(&b.pattern)
        .cmp(&literal_chars(&a.pattern))
        .then_with(|| a.pattern.cmp(&b.pattern))
    });

    for entry in &literals {
      let child = path.join(&entry.pattern);
      if !exists(&child) {
        if !entry.optional && entry.kind != SpecKind::None {
          validator.push_error(FolderError::Missing {
            path: child,
            expected: entry.kind.node_kind().unwrap_or(NodeKind::File),
          });
        }
        continue;
      }
      validate_node(entry, &child, validator);
    }

    if globs.is_empty() && !self.closed {
      return;
    }

    // Join from the real name; match on its (lossy) text.
    let mut names = match std::fs::read_dir(path) {
      Ok(read) => read
        .flatten()
        .map(|c| {
          let os = c.file_name();
          (os.to_string_lossy().into_owned(), os)
        })
        .collect::<Vec<_>>(),
      Err(source) => {
        validator.push_error(FolderError::Io {
          path: path.to_path_buf(),
          source,
        });
        return;
      }
    };
    names.sort();

    let mut matched = vec![0usize; globs.len()];
    for (name, os_name) in names {
      if literals.iter().any(|e| e.pattern == name) {
        continue;
      }
      let child = path.join(&os_name);
      match globs
        .iter()
        .position(|e| glob_match::matches(&e.pattern, &name))
      {
        Some(i) => {
          matched[i] += 1;
          validate_node(globs[i], &child, validator);
        }
        None if self.closed => validator.push_error(FolderError::Unexpected { path: child }),
        None => {}
      }
    }

    for (entry, count) in globs.iter().zip(matched) {
      if entry.required && count == 0 {
        validator.push_error(FolderError::Missing {
          path: path.join(&entry.pattern),
          expected: entry.kind.node_kind().unwrap_or(NodeKind::File),
        });
      }
    }
  }
}

/// One entry of a spec, flattened: see [`Spec::rows`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecRow {
  /// Slash-joined path from the spec root; folders end in `/`.
  pub path: String,
  /// `file`, `folder`, `any` or `none`.
  pub kind: &'static str,
  /// `optional`, `required` (a glob that must match), `closed`.
  pub flags: Vec<&'static str>,
}

impl Spec {
  /// Every entry, depth-first, with its full path — the tree without
  /// indentation, for renderers that collapse whitespace.
  pub fn rows(&self) -> Vec<SpecRow> {
    let mut out = Vec::new();
    collect_rows(self, "", &mut out);
    out
  }

  /// [`rows`](Self::rows) as a `table/v1` shape (entry, kind, flags), for
  /// tsh renderers.
  #[cfg(feature = "json")]
  pub fn rows_table(&self) -> serde_json::Value {
    let rows: Vec<serde_json::Value> = self
      .rows()
      .into_iter()
      .map(|r| {
        serde_json::json!([
          r.path,
          { "text": r.kind, "style": "text.secondary" },
          { "text": r.flags.join(" "), "style": "dimmed" },
        ])
      })
      .collect();
    serde_json::json!({
      "shape": "table/v1",
      "header_style": "dimmed",
      "gap": "  ",
      "columns": [
        { "header": if self.closed { "entry (root closed)" } else { "entry" }, "priority": 0 },
        { "header": "kind", "priority": 0 },
        { "header": "flags", "priority": 1 },
      ],
      "rows": rows,
    })
  }
}

fn collect_rows(spec: &Spec, prefix: &str, out: &mut Vec<SpecRow>) {
  for entry in &spec.entries {
    let mut flags = Vec::new();
    if entry.optional && !entry.is_glob() {
      flags.push("optional");
    }
    if entry.required && entry.is_glob() {
      flags.push("required");
    }
    let (kind, path) = match &entry.kind {
      SpecKind::File => ("file", format!("{prefix}{}", entry.pattern)),
      SpecKind::Any => ("any", format!("{prefix}{}", entry.pattern)),
      SpecKind::None => ("none", format!("{prefix}{}", entry.pattern)),
      SpecKind::Folder(inner) => {
        if inner.closed {
          flags.push("closed");
        }
        ("folder", format!("{prefix}{}/", entry.pattern))
      }
    };
    if let SpecKind::Folder(inner) = &entry.kind {
      out.push(SpecRow {
        path: path.clone(),
        kind,
        flags,
      });
      collect_rows(inner, &path, out);
    } else {
      out.push(SpecRow { path, kind, flags });
    }
  }
}

/// One violation, flattened from a [`FolderError`] tree.
///
/// `detail` says what the spec expected for `missing` / `wrong-kind`, and
/// carries the error text for the other problems.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "json", derive(serde::Serialize, serde::Deserialize))]
pub struct FolderViolation {
  /// Path relative to the checked directory.
  pub path: String,
  /// `missing`, `wrong-kind`, `unexpected`, `forbidden`, `content`,
  /// `invariant` or `io`.
  pub problem: String,
  pub detail: String,
}

/// Flatten a validation error into one [`FolderViolation`] per leaf, paths
/// relative to `root`, sorted by path.
pub fn violations(root: &Path, err: &FolderError) -> Vec<FolderViolation> {
  let rel = |p: &Path| {
    p.strip_prefix(root)
      .map(|r| {
        if r.as_os_str().is_empty() {
          PathBuf::from(".")
        } else {
          r.to_path_buf()
        }
      })
      .unwrap_or_else(|_| p.to_path_buf())
      .display()
      .to_string()
  };
  let mut out: Vec<FolderViolation> = err
    .leaves()
    .into_iter()
    .map(|leaf| {
      let (path, problem, detail) = match leaf {
        FolderError::Missing { path, expected } => {
          (rel(path), "missing", format!("expected a {expected}"))
        }
        FolderError::WrongKind {
          path,
          expected,
          found,
        } => (
          rel(path),
          "wrong-kind",
          format!("expected a {expected}, found a {found}"),
        ),
        FolderError::Unexpected { path } => {
          (rel(path), "unexpected", "not declared by the spec".into())
        }
        FolderError::Forbidden { path, pattern } => (
          rel(path),
          "forbidden",
          format!("matches `{pattern}`, which the spec forbids"),
        ),
        FolderError::Shape { path, source } => (rel(path), "content", source.to_string()),
        FolderError::Io { path, source } => (rel(path), "io", source.to_string()),
        FolderError::Invariant { path, message } => (rel(path), "invariant", message.clone()),
        FolderError::Multiple(_) => unreachable!("leaves() flattens Multiple"),
      };
      FolderViolation {
        path,
        problem: problem.into(),
        detail,
      }
    })
    .collect();
  out.sort_by(|a, b| a.path.cmp(&b.path));
  out
}

/// Check one present child against its entry, recursing into folders.
fn validate_node(entry: &SpecEntry, path: &Path, validator: &mut Validator) {
  if entry.kind == SpecKind::None {
    validator.push_error(FolderError::Forbidden {
      path: path.to_path_buf(),
      pattern: entry.pattern.clone(),
    });
    return;
  }
  if let Some(e) = check_kind(path, entry.kind.node_kind()) {
    validator.push_error(e);
    return;
  }
  if let SpecKind::Folder(spec) = &entry.kind {
    spec.validate_with(validator, path);
  }
}

fn exists(path: &Path) -> bool {
  path.symlink_metadata().is_ok()
}

fn check_kind(path: &Path, expected: Option<NodeKind>) -> Option<FolderError> {
  if !exists(path) {
    return Some(FolderError::Missing {
      path: path.to_path_buf(),
      expected: expected.unwrap_or(NodeKind::Folder),
    });
  }
  // Present (the link itself exists); classify what it resolves to.
  let found = match std::fs::metadata(path) {
    Ok(meta) if meta.is_dir() => NodeKind::Folder,
    Ok(_) => NodeKind::File,
    Err(source) => {
      return Some(FolderError::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(source.kind(), format!("broken symlink: {source}")),
      });
    }
  };
  match expected {
    Some(expected) if expected != found => Some(FolderError::WrongKind {
      path: path.to_path_buf(),
      expected,
      found,
    }),
    _ => None,
  }
}

#[cfg(feature = "json")]
impl Spec {
  /// Build a spec from its JSON shape (see the module docs). The root
  /// must be a `folder` node.
  pub fn from_json(value: &serde_json::Value) -> Result<Spec, SpecError> {
    match node_from_json(".", value)? {
      (SpecKind::Folder(spec), false, false) => Ok(spec),
      (SpecKind::Folder(_), ..) => Err(SpecError::new(
        ".",
        "the root cannot be `optional` or `required`",
      )),
      _ => Err(SpecError::new(".", "the root node must be a folder")),
    }
  }

  /// The JSON shape this spec round-trips through [`Spec::from_json`].
  pub fn to_json(&self) -> serde_json::Value {
    folder_to_json(self)
  }
}

#[cfg(feature = "json")]
fn node_from_json(
  at: &str,
  value: &serde_json::Value,
) -> Result<(SpecKind, bool, bool), SpecError> {
  let map = value
    .as_object()
    .ok_or_else(|| SpecError::new(at, format!("expected a node map, found {value}")))?;
  for key in map.keys() {
    if !matches!(
      key.as_str(),
      "kind" | "entries" | "closed" | "optional" | "required"
    ) {
      return Err(SpecError::new(at, format!("unknown node field `{key}`")));
    }
  }
  let flag = |key: &str| -> Result<bool, SpecError> {
    match map.get(key) {
      None | Some(serde_json::Value::Null) => Ok(false),
      Some(serde_json::Value::Bool(b)) => Ok(*b),
      Some(other) => Err(SpecError::new(
        at,
        format!("`{key}` must be a boolean, found {other}"),
      )),
    }
  };
  let leaf = |kind: SpecKind, name: &str| -> Result<SpecKind, SpecError> {
    match ["entries", "closed"].iter().find(|k| map.contains_key(**k)) {
      Some(key) => Err(SpecError::new(
        at,
        format!("a `{name}` node cannot carry `{key}` (only folders do)"),
      )),
      None => Ok(kind),
    }
  };
  let kind = match map.get("kind").and_then(|k| k.as_str()) {
    Some("file") => leaf(SpecKind::File, "file")?,
    Some("any") => leaf(SpecKind::Any, "any")?,
    Some("none") => leaf(SpecKind::None, "none")?,
    Some("folder") => {
      let mut entries = Vec::new();
      if let Some(children) = map.get("entries") {
        let children = children
          .as_object()
          .ok_or_else(|| SpecError::new(at, "`entries` must be a map of name -> node"))?;
        for (name, child) in children {
          if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            return Err(SpecError::new(
              at,
              format!("entry name `{name}` must be a single path segment"),
            ));
          }
          let child_at = if at == "." {
            name.clone()
          } else {
            format!("{at}/{name}")
          };
          let (kind, optional, required) = node_from_json(&child_at, child)?;
          if kind == SpecKind::None && (optional || required) {
            return Err(SpecError::new(
              child_at,
              "a `none` entry cannot be `optional` or `required` (it forbids what it matches)",
            ));
          }
          match (is_glob(name), optional, required) {
            (true, true, _) => {
              return Err(SpecError::new(
                child_at,
                "a glob entry cannot be `optional` (it already matches zero or more); use `required` for at least one",
              ));
            }
            (false, _, true) => {
              return Err(SpecError::new(
                child_at,
                "a literal entry cannot be `required` (it already is unless `optional`)",
              ));
            }
            _ => {}
          }
          entries.push(SpecEntry {
            pattern: name.clone(),
            optional,
            required,
            kind,
          });
        }
      }
      SpecKind::Folder(Spec {
        entries,
        closed: flag("closed")?,
      })
    }
    Some(other) => {
      return Err(SpecError::new(
        at,
        format!("unknown kind `{other}` (expected file, folder, any or none)"),
      ));
    }
    None => return Err(SpecError::new(at, "node is missing `kind`")),
  };
  Ok((kind, flag("optional")?, flag("required")?))
}

#[cfg(feature = "json")]
fn folder_to_json(spec: &Spec) -> serde_json::Value {
  let entries = spec
    .entries
    .iter()
    .map(|e| {
      let mut node = match &e.kind {
        SpecKind::File => serde_json::json!({"kind": "file"}),
        SpecKind::Any => serde_json::json!({"kind": "any"}),
        SpecKind::None => serde_json::json!({"kind": "none"}),
        SpecKind::Folder(inner) => folder_to_json(inner),
      };
      if e.optional {
        node["optional"] = true.into();
      }
      if e.required {
        node["required"] = true.into();
      }
      (e.pattern.clone(), node)
    })
    .collect::<serde_json::Map<_, _>>();
  serde_json::json!({"kind": "folder", "closed": spec.closed, "entries": entries})
}
