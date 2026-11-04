//! Declarative folder schemas.
//!
//! A [`Schema`] is the **shape** of a folder, separated from any
//! concrete instance on disk. The [`crate::folder!`] macro emits a
//! `pub const SCHEMA: Schema = …` alongside the loaded-instance
//! `Folder` type, so callers can:
//!
//! - Introspect the declared shape ([`Schema::entries`]).
//! - Validate a path without constructing a typed `Folder`
//!   ([`Schema::validate`]).
//! - Share schema references across instances (nested schemas are
//!   `&'static Schema`).
//!
//! Validation is **strict**: missing required entries error,
//! wrong-kind clashes error. Content is checked only where an entry
//! carries a [`check` hook](SchemaEntry::check) — what the `folder!`
//! macro attaches to `Valid<…>` entries.
//!
//! ```ignore
//! use tento_folder::folder;
//!
//! folder!(coffee_folder, {
//!   "bin": { "coffee": File::Binary },
//!   "VERSION": File::Text,
//! });
//!
//! // Introspect:
//! for entry in coffee_folder::SCHEMA.entries() {
//!   println!("{} (optional: {})", entry.name, entry.optional);
//! }
//!
//! // Validate a path without loading a typed Folder:
//! coffee_folder::SCHEMA.validate(std::path::Path::new("./out/coffee.app"))?;
//! ```

use std::path::Path;

use crate::error::FolderError;
use crate::glob_match;
use crate::node::FileType;
use crate::validate::Validator;

/// Declarative description of a folder's shape.
///
/// Generated from a [`crate::folder!`] invocation as a `pub const`,
/// alongside the loaded-instance `Folder` type. Each nested folder
/// section produces its own `pub const <Child>_SCHEMA`; the parent's
/// [`SchemaEntry`] references those children by `&'static Schema`.
#[derive(Debug, Clone, Copy)]
pub struct Schema {
  entries: &'static [SchemaEntry],
}

impl Schema {
  pub const fn new(entries: &'static [SchemaEntry]) -> Self {
    Self { entries }
  }

  pub const fn entries(&self) -> &'static [SchemaEntry] {
    self.entries
  }

  /// Validate that `path` matches this schema.
  ///
  /// Walks the declared entries, checks structural invariants
  /// (existence, kind), and runs each present entry's
  /// [`check` hook](SchemaEntry::check) if it has one. Strict-only:
  /// missing required entries error.
  pub fn validate(&self, path: &Path) -> Result<(), FolderError> {
    let mut validator = Validator::new();
    self.validate_with(&mut validator, path);
    validator.finish()
  }

  /// Validate `path` against this schema, pushing any errors into
  /// `validator` rather than returning a fresh result. Used by the
  /// recursive nested-schema walk and by [`Schema::validate`].
  ///
  /// Walk order: exact-name entries first (consume matching children),
  /// then `FolderGlob` / `FileGlob` entries in declaration order
  /// against any unconsumed children. Unmatched children are ignored.
  pub fn validate_with(&self, validator: &mut Validator, path: &Path) {
    // First pass: consume children matching exact-name entries.
    // Collect the set of consumed names to avoid double-matching with globs.
    let mut consumed: Vec<String> = Vec::new();

    for entry in self.entries {
      match &entry.kind {
        SchemaKind::FolderGlob { .. } | SchemaKind::FileGlob { .. } => continue,
        _ => {}
      }
      let entry_path = path.join(entry.name);
      match &entry.kind {
        SchemaKind::File(file_type) => {
          // Silent on absence for optional entries; if present, check
          // kind, then the entry's content hook.
          let present = if entry.optional {
            entry_path.exists()
              && validator
                .load_file_required(&entry_path, *file_type)
                .is_some()
          } else {
            validator
              .load_file_required(&entry_path, *file_type)
              .is_some()
          };
          if present {
            entry.run_check(&entry_path, validator);
          }
        }
        SchemaKind::Folder | SchemaKind::DynamicFolder => {
          let present = if entry.optional {
            entry_path.exists()
          } else {
            validator.load_folder_required(&entry_path).is_some()
          };
          if present {
            entry.run_check(&entry_path, validator);
          }
        }
        SchemaKind::FolderWithChildren(child) => {
          if entry.optional {
            if entry_path.exists() {
              child.validate_with(validator, &entry_path);
              entry.run_check(&entry_path, validator);
            }
          } else {
            child.validate_with(validator, &entry_path);
            entry.run_check(&entry_path, validator);
          }
        }
        SchemaKind::FolderRef(child) => {
          let present = if entry.optional {
            entry_path.exists() && validator.load_folder_required(&entry_path).is_some()
          } else {
            validator.load_folder_required(&entry_path).is_some()
          };
          if present {
            child.validate_with(validator, &entry_path);
            entry.run_check(&entry_path, validator);
          }
        }
        SchemaKind::FolderGlob { .. } | SchemaKind::FileGlob { .. } => unreachable!(),
      }
      consumed.push(entry.name.to_string());
    }

    // Second pass: only proceed with globs if some glob entry exists
    // AND the directory exists (else there are no children to walk).
    let has_glob = self.entries.iter().any(|e| {
      matches!(
        e.kind,
        SchemaKind::FolderGlob { .. } | SchemaKind::FileGlob { .. }
      )
    });
    if !has_glob || !path.is_dir() {
      return;
    }

    let children = match std::fs::read_dir(path) {
      Ok(r) => r,
      Err(source) => {
        validator.push_error(FolderError::Io {
          path: path.to_path_buf(),
          source,
        });
        return;
      }
    };

    for child in children.flatten() {
      let name = child.file_name();
      let name_str = name.to_string_lossy();
      if consumed.iter().any(|c| c.as_str() == name_str.as_ref()) {
        continue;
      }
      let child_path = child.path();
      // Find the first glob entry whose pattern matches; first-match-wins.
      for entry in self.entries {
        match &entry.kind {
          SchemaKind::FolderGlob { pattern, schema } => {
            if glob_match::matches(pattern, &name_str) {
              if validator.load_folder_required(&child_path).is_some() {
                schema.validate_with(validator, &child_path);
                entry.run_check(&child_path, validator);
              }
              break;
            }
          }
          SchemaKind::FileGlob { pattern, file_type } => {
            if glob_match::matches(pattern, &name_str) {
              if validator
                .load_file_required(&child_path, *file_type)
                .is_some()
              {
                entry.run_check(&child_path, validator);
              }
              break;
            }
          }
          _ => {}
        }
      }
    }
  }

  /// Whether this schema's entries include the
  /// `html/{target.web, target.web.beta, target.web.rc}` staging
  /// pattern. Replaces the `HasStagedHtml` marker trait.
  pub fn has_html_stages(&self) -> bool {
    let html = self.entries.iter().find(|e| e.name == "html");
    let Some(html_entry) = html else {
      return false;
    };
    let SchemaKind::FolderWithChildren(html_schema) = &html_entry.kind else {
      return false;
    };
    let expected = ["target.web", "target.web.beta", "target.web.rc"];
    expected
      .iter()
      .all(|name| html_schema.entries.iter().any(|e| e.name == *name))
  }
}

/// The content proof a [`SchemaEntry`] runs on its path.
pub type CheckFn = fn(&Path) -> Result<(), FolderError>;

/// A single entry in a [`Schema`].
#[derive(Debug, Clone, Copy)]
pub struct SchemaEntry {
  pub name: &'static str,
  pub optional: bool,
  pub kind: SchemaKind,
  /// Content proof to run during tier-1 validation, after the entry's
  /// existence/kind check passes.
  ///
  /// A plain `fn` pointer, so the whole `SchemaEntry` stays `const`.
  /// The `folder!` macro attaches one for every `Valid<…>` entry —
  /// `|p| <T as Checkable>::check_at(p).map(|_| ())` — which is what
  /// makes `Valid` the per-entry opt-in to "`validate()` parse-checks
  /// content". Eager `File<C>` entries have no hook (their proof
  /// happens at handle construction) and `Unchecked<…>` entries have
  /// none by definition.
  pub check: Option<CheckFn>,
}

impl SchemaEntry {
  pub const fn file(name: &'static str, file_type: FileType) -> Self {
    Self {
      name,
      optional: false,
      kind: SchemaKind::File(file_type),
      check: None,
    }
  }

  pub const fn file_optional(name: &'static str, file_type: FileType) -> Self {
    Self {
      name,
      optional: true,
      kind: SchemaKind::File(file_type),
      check: None,
    }
  }

  pub const fn folder(name: &'static str) -> Self {
    Self {
      name,
      optional: false,
      kind: SchemaKind::Folder,
      check: None,
    }
  }

  pub const fn folder_optional(name: &'static str) -> Self {
    Self {
      name,
      optional: true,
      kind: SchemaKind::Folder,
      check: None,
    }
  }

  pub const fn folder_with_children(name: &'static str, schema: &'static Schema) -> Self {
    Self {
      name,
      optional: false,
      kind: SchemaKind::FolderWithChildren(schema),
      check: None,
    }
  }

  pub const fn folder_with_children_optional(name: &'static str, schema: &'static Schema) -> Self {
    Self {
      name,
      optional: true,
      kind: SchemaKind::FolderWithChildren(schema),
      check: None,
    }
  }

  pub const fn folder_ref(name: &'static str, schema: &'static Schema) -> Self {
    Self {
      name,
      optional: false,
      kind: SchemaKind::FolderRef(schema),
      check: None,
    }
  }

  pub const fn folder_ref_optional(name: &'static str, schema: &'static Schema) -> Self {
    Self {
      name,
      optional: true,
      kind: SchemaKind::FolderRef(schema),
      check: None,
    }
  }

  pub const fn folder_glob(pattern: &'static str, schema: &'static Schema) -> Self {
    Self {
      name: pattern,
      optional: false,
      kind: SchemaKind::FolderGlob { pattern, schema },
      check: None,
    }
  }

  pub const fn folder_glob_anonymous(pattern: &'static str) -> Self {
    // For `Glob<Folder>` — just-a-folder, no inner schema.
    Self {
      name: pattern,
      optional: false,
      kind: SchemaKind::FolderGlob {
        pattern,
        schema: &ANONYMOUS_SCHEMA,
      },
      check: None,
    }
  }

  pub const fn file_glob(pattern: &'static str, file_type: FileType) -> Self {
    Self {
      name: pattern,
      optional: false,
      kind: SchemaKind::FileGlob { pattern, file_type },
      check: None,
    }
  }

  pub const fn dynamic_folder(name: &'static str) -> Self {
    Self {
      name,
      optional: false,
      kind: SchemaKind::DynamicFolder,
      check: None,
    }
  }

  /// Attach a tier-1 content proof to this entry. Const-friendly
  /// builder, so it composes inside the `SCHEMA` const the macro
  /// emits:
  ///
  /// ```ignore
  /// SchemaEntry::file("raw.json", FileType::Opaque)
  ///   .with_check(|p| <Typed<Json> as Checkable>::check_at(p).map(|_| ()))
  /// ```
  pub const fn with_check(mut self, check: fn(&Path) -> Result<(), FolderError>) -> Self {
    self.check = Some(check);
    self
  }

  /// Run this entry's [`check`](Self::check) hook against a path known
  /// to exist and be the right node kind, collecting any failure.
  fn run_check(&self, path: &Path, validator: &mut Validator) {
    if let Some(check) = self.check {
      if let Err(e) = check(path) {
        validator.push_error(e);
      }
    }
  }
}

/// Sentinel schema with no entries — used by `Glob<Folder>` to mean
/// "just a folder, no inner validation". The recursive walk into this
/// schema is a no-op.
const ANONYMOUS_SCHEMA: Schema = Schema::new(&[]);

/// Kind of entry in a [`Schema`].
#[derive(Debug, Clone, Copy)]
pub enum SchemaKind {
  /// A file with the given type. Content is checked only if the entry
  /// carries a [`check`](SchemaEntry::check) hook.
  File(FileType),
  /// A folder with unspecified contents.
  Folder,
  /// A folder with a nested **inline** schema.
  FolderWithChildren(&'static Schema),
  /// A folder whose contents are not statically described (the
  /// `Folder::Dynamic` macro variant).
  DynamicFolder,
  /// A folder whose contents follow a **separately-declared** schema.
  /// Equivalent to `<module>::Folder` in macro value position.
  FolderRef(&'static Schema),
  /// Matches every directory child whose name fits the shell-style
  /// `pattern`. Each match validates against `schema`. Used by
  /// `Glob<…>` in macro value position.
  FolderGlob {
    pattern: &'static str,
    schema: &'static Schema,
  },
  /// Matches every plain-file child whose name fits the shell-style
  /// `pattern`. Each match validates as the given `file_type` (plus
  /// the entry's `check` hook, if any). Used by `Glob<File::…>` /
  /// `Glob<File<C>>` in macro value position.
  FileGlob {
    pattern: &'static str,
    file_type: FileType,
  },
}
