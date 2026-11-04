//! Tests for the `Schema` introspection + standalone-validate API.
//!
//! The `folder!` macro emits a `pub const SCHEMA: Schema` next to the
//! loaded-instance `Folder` type. These tests cover:
//!
//! - That the const's `entries()` reflects the declaration shape.
//! - That `SCHEMA.validate(path, mode)` matches `Folder::load(path)`
//!   semantics without constructing typed handles.
//! - That nested folder children get their own `pub const <NAME>_SCHEMA`
//!   and are referenced from the parent via `FolderWithChildren`.

use tento_folder::{ContentSource, FileType, FolderError, Schema, SchemaKind, folder};

folder!(schema_test, {
  "bin": {
    "mono": File::Binary,
    "loaf.sh": File::Shell,
  },
  "html": Folder,
  "secrets"?: Folder,
  "VERSION": File::Text,
});

fn temp_dir(name: &str) -> std::path::PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_schema_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  dir
}

#[test]
fn schema_entries_reflect_declaration_order() {
  let entries = schema_test::SCHEMA.entries();
  assert_eq!(entries.len(), 4);
  assert_eq!(entries[0].name, "bin");
  assert_eq!(entries[1].name, "html");
  assert_eq!(entries[2].name, "secrets");
  assert_eq!(entries[3].name, "VERSION");
}

#[test]
fn schema_entries_capture_optionality() {
  let entries = schema_test::SCHEMA.entries();
  assert!(!entries[0].optional, "bin is required");
  assert!(!entries[1].optional, "html is required");
  assert!(entries[2].optional, "secrets is optional");
  assert!(!entries[3].optional, "VERSION is required");
}

#[test]
fn schema_entry_kinds_match_declarations() {
  let entries = schema_test::SCHEMA.entries();

  // bin → nested schema
  match entries[0].kind {
    SchemaKind::FolderWithChildren(child) => {
      let child_entries = child.entries();
      assert_eq!(child_entries.len(), 2);
      assert_eq!(child_entries[0].name, "mono");
      assert!(matches!(
        child_entries[0].kind,
        SchemaKind::File(FileType::Binary)
      ));
      assert_eq!(child_entries[1].name, "loaf.sh");
      assert!(matches!(
        child_entries[1].kind,
        SchemaKind::File(FileType::Shell)
      ));
    }
    other => panic!("expected FolderWithChildren, got {other:?}"),
  }

  // html → plain folder
  assert!(matches!(entries[1].kind, SchemaKind::Folder));

  // secrets → plain folder
  assert!(matches!(entries[2].kind, SchemaKind::Folder));

  // VERSION → file
  assert!(matches!(entries[3].kind, SchemaKind::File(FileType::Text)));
}

#[test]
fn nested_schema_const_matches_folder_with_children_reference() {
  // The macro emits both `SCHEMA` (parent) and `BIN_SCHEMA` (child).
  // The parent's FolderWithChildren entry must reference the same
  // entries the standalone BIN_SCHEMA exposes.
  //
  // Pointer identity isn't load-bearing (the macro emits `const`, not
  // `static`; the compiler may inline). Instead, compare the entries
  // slice — that slice IS a `'static` rodata reference inside the
  // emitted Schema struct.
  let parent = schema_test::SCHEMA.entries();
  let child_ref: &'static Schema = match parent[0].kind {
    SchemaKind::FolderWithChildren(s) => s,
    _ => panic!("bin should be FolderWithChildren"),
  };
  let standalone = schema_test::BIN_SCHEMA.entries();
  assert_eq!(child_ref.entries().len(), standalone.len());
  for (a, b) in child_ref.entries().iter().zip(standalone) {
    assert_eq!(a.name, b.name);
    assert_eq!(a.optional, b.optional);
  }
}

#[test]
fn folder_schema_accessor_returns_a_view_of_the_const() {
  // Same reasoning as above: compare entries, not pointers.
  let from_method = schema_test::Folder::schema();
  let from_const = &schema_test::SCHEMA;
  assert_eq!(from_method.entries().len(), from_const.entries().len());
  for (a, b) in from_method.entries().iter().zip(from_const.entries()) {
    assert_eq!(a.name, b.name);
    assert_eq!(a.optional, b.optional);
  }
}

#[test]
fn schema_validate_ok_on_well_formed_tree() {
  let dir = temp_dir("validate_ok");
  schema_test::Folder::builder()
    .bin(|b| {
      b.mono(ContentSource::write_str("bin"))
        .loaf_sh(ContentSource::write_str("#!/bin/sh\n"))
    })
    .html(ContentSource::empty())
    .VERSION(ContentSource::write_str("1.0\n"))
    .build_at(&dir)
    .unwrap();

  schema_test::SCHEMA
    .validate(&dir)
    .expect("validate should pass on a well-formed tree");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn schema_validate_reports_missing_required() {
  let dir = temp_dir("validate_missing");
  std::fs::create_dir_all(&dir).unwrap();

  let err = schema_test::SCHEMA.validate(&dir).unwrap_err();
  // Expect at least bin/mono, bin/loaf.sh, html, VERSION as missing —
  // four required entries (secrets is optional, so absent is fine).
  assert!(err.has_missing(), "should flag missing required entries");
  let missing = err.missing_paths();
  assert!(
    missing.len() >= 3,
    "expected ≥3 missing paths, got {missing:?}"
  );
}

#[test]
fn schema_validate_reports_wrong_kind() {
  let dir = temp_dir("validate_wrong_kind");
  std::fs::create_dir_all(&dir).unwrap();
  std::fs::create_dir_all(dir.join("bin")).unwrap();
  std::fs::write(dir.join("bin/mono"), "binary").unwrap();
  std::fs::write(dir.join("bin/loaf.sh"), "#!/bin/sh\n").unwrap();
  // Wrong kind: html should be a folder, but write a file there.
  std::fs::write(dir.join("html"), "not-a-folder").unwrap();
  std::fs::write(dir.join("VERSION"), "1.0").unwrap();

  let err = schema_test::SCHEMA.validate(&dir).unwrap_err();
  let errors: Vec<&FolderError> = match &err {
    FolderError::Multiple(es) => es.iter().collect(),
    single => vec![single],
  };
  assert!(
    errors
      .iter()
      .any(|e| matches!(e, FolderError::WrongKind { .. })),
    "expected at least one WrongKind, got: {err:?}",
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn schema_validate_skips_optional_nested_when_absent() {
  // schema_test declares "secrets"?: Folder — absent is allowed.
  let dir = temp_dir("validate_optional_absent");
  schema_test::Folder::builder()
    .bin(|b| {
      b.mono(ContentSource::write_str("bin"))
        .loaf_sh(ContentSource::write_str("#!/bin/sh\n"))
    })
    .html(ContentSource::empty())
    .VERSION(ContentSource::write_str("1.0"))
    .build_at(&dir)
    .unwrap();

  schema_test::SCHEMA
    .validate(&dir)
    .expect("optional `secrets` absent should not fail strict validation");

  std::fs::remove_dir_all(&dir).unwrap();
}
