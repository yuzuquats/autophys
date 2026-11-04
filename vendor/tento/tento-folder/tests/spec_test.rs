//! Tests for the runtime [`Spec`] — the owned layout a `.rebar` or a
//! tsh spec file builds without the `folder!` macro.

use std::path::{Path, PathBuf};

use tento_folder::{FolderError, NodeKind, Spec, SpecEntry, SpecKind};

fn temp_dir(name: &str) -> PathBuf {
  // Per-process, so concurrent test runs (two worktrees) never collide.
  let dir = std::env::temp_dir().join(format!("tento_folder_spec_{}_{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

fn touch(root: &Path, rel: &str) {
  let path = root.join(rel);
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, "").unwrap();
}

fn file(name: &str) -> SpecEntry {
  SpecEntry::new(name, SpecKind::File)
}

fn folder(name: &str, spec: Spec) -> SpecEntry {
  SpecEntry::new(name, SpecKind::Folder(spec))
}

fn crate_spec() -> Spec {
  Spec::closed(vec![
    file("Cargo.toml"),
    file("README.md").optional(),
    folder(
      "src",
      Spec::closed(vec![
        file("lib.rs"),
        folder("models", Spec::closed(vec![file("mod.rs"), file("*.rs")])),
        folder(
          "connector",
          Spec::closed(vec![
            file("mod.rs"),
            folder(
              "fixtures",
              Spec::closed(vec![file("*.ops.json").required()]),
            ),
            folder("*", Spec::closed(vec![file("mod.rs"), file("logs.rs")])),
          ]),
        ),
      ]),
    ),
  ])
}

fn good_crate(name: &str) -> PathBuf {
  let root = temp_dir(name);
  for rel in [
    "Cargo.toml",
    "src/lib.rs",
    "src/models/mod.rs",
    "src/models/sleep.rs",
    "src/connector/mod.rs",
    "src/connector/fixtures/sleep.ops.json",
    "src/connector/sleep/mod.rs",
    "src/connector/sleep/logs.rs",
  ] {
    touch(&root, rel);
  }
  root
}

#[test]
fn matching_tree_passes() {
  let root = good_crate("pass");
  crate_spec().validate(&root).unwrap();
}

#[test]
fn missing_literal_is_reported_and_optional_is_not() {
  let root = good_crate("missing");
  std::fs::remove_file(root.join("src/lib.rs")).unwrap();
  let err = crate_spec().validate(&root).unwrap_err();
  assert_eq!(err.missing_paths(), vec![root.join("src/lib.rs").as_path()]);
}

#[test]
fn closed_folder_rejects_undeclared_children() {
  let root = good_crate("closed");
  touch(&root, "src/retry.rs");
  touch(&root, "rustfmt.toml");
  let err = crate_spec().validate(&root).unwrap_err();
  let mut unexpected: Vec<&Path> = err
    .leaves()
    .into_iter()
    .filter_map(|e| match e {
      FolderError::Unexpected { path } => Some(path.as_path()),
      _ => None,
    })
    .collect();
  unexpected.sort();
  assert_eq!(
    unexpected,
    vec![
      root.join("rustfmt.toml").as_path(),
      root.join("src/retry.rs").as_path()
    ]
  );
}

#[test]
fn none_carves_an_exception_out_of_a_broader_glob() {
  let root = temp_dir("none");
  for rel in [
    "tento-a/Cargo.toml",
    "tento-a.project.docs/README.md",
    "notes.md",
  ] {
    touch(&root, rel);
  }
  // Open folder: `none` still forbids, and an absent `none` literal is fine.
  let spec = Spec::new(vec![
    folder("tento-*", Spec::new(vec![])),
    SpecEntry::new("*.project.docs", SpecKind::None),
    SpecEntry::new("docs", SpecKind::None),
  ]);
  let err = spec.validate(&root).unwrap_err();
  let leaves = err.leaves();
  assert_eq!(leaves.len(), 1, "{leaves:?}");
  assert!(matches!(leaves[0], FolderError::Forbidden { path, pattern }
      if *path == root.join("tento-a.project.docs") && pattern == "*.project.docs"));

  touch(&root, "docs/x.md");
  assert_eq!(spec.validate(&root).unwrap_err().leaves().len(), 2);
}

#[test]
fn open_folder_ignores_undeclared_children() {
  let root = good_crate("open");
  touch(&root, "notes.txt");
  let mut spec = crate_spec();
  spec.closed = false;
  spec.validate(&root).unwrap();
}

#[test]
fn wrong_kind_is_reported() {
  let root = good_crate("kind");
  std::fs::remove_dir_all(root.join("src/models")).unwrap();
  touch(&root, "src/models");
  let err = crate_spec().validate(&root).unwrap_err();
  assert!(matches!(
    err,
    FolderError::WrongKind {
      expected: NodeKind::Folder,
      found: NodeKind::File,
      ..
    }
  ));
}

#[test]
fn glob_folder_applies_its_spec_to_every_match() {
  let root = good_crate("glob");
  touch(&root, "src/connector/hrv/mod.rs");
  let err = crate_spec().validate(&root).unwrap_err();
  assert_eq!(
    err.missing_paths(),
    vec![root.join("src/connector/hrv/logs.rs").as_path()]
  );
}

#[test]
fn literal_wins_over_glob() {
  // `connector/mod.rs` is claimed by its literal entry, not the `*`
  // folder glob — otherwise it would be a wrong-kind error.
  let root = good_crate("literal_first");
  crate_spec().validate(&root).unwrap();
}

#[test]
fn required_glob_needs_a_match() {
  let root = good_crate("required");
  std::fs::remove_file(root.join("src/connector/fixtures/sleep.ops.json")).unwrap();
  let err = crate_spec().validate(&root).unwrap_err();
  assert_eq!(
    err.missing_paths(),
    vec![root.join("src/connector/fixtures/*.ops.json").as_path()]
  );
}

#[test]
fn every_violation_is_collected() {
  let root = good_crate("collect");
  std::fs::remove_file(root.join("Cargo.toml")).unwrap();
  touch(&root, "src/extra.rs");
  let err = crate_spec().validate(&root).unwrap_err();
  assert_eq!(err.leaves().len(), 2);
}

#[test]
fn missing_root_is_reported() {
  let root = std::env::temp_dir().join("tento_folder_spec_no_such_root");
  let _ = std::fs::remove_dir_all(&root);
  let err = crate_spec().validate(&root).unwrap_err();
  assert!(err.has_missing());
}

#[test]
fn json_round_trip() {
  let spec = crate_spec();
  let json = spec.to_json();
  let back = Spec::from_json(&json).unwrap();
  // JSON maps are unordered; compare through the canonical JSON form.
  assert_eq!(back.to_json(), json);
}

#[test]
fn from_json_rejects_bad_nodes() {
  let err = Spec::from_json(&serde_json::json!({"kind": "file"})).unwrap_err();
  assert_eq!(err.at, ".");
  let err = Spec::from_json(&serde_json::json!({
    "kind": "folder", "entries": {"src": {"kind": "folder", "entries": {"x": {"kind": "blob"}}}}
  }))
  .unwrap_err();
  assert_eq!(err.at, "src/x");
  let err = Spec::from_json(&serde_json::json!({
    "kind": "folder", "entries": {"a": {"kind": "file", "optinal": true}}
  }))
  .unwrap_err();
  assert!(err.message.contains("optinal"));
}

#[test]
fn rows_flatten_the_tree_with_full_paths() {
  let rows = crate_spec().rows();
  let logs = rows
    .iter()
    .find(|r| r.path == "src/connector/*/logs.rs")
    .unwrap();
  assert_eq!(logs.kind, "file");
  let src = rows.iter().find(|r| r.path == "src/").unwrap();
  assert_eq!((src.kind, src.flags.clone()), ("folder", vec!["closed"]));
  let readme = rows.iter().find(|r| r.path == "README.md").unwrap();
  assert_eq!(readme.flags, vec!["optional"]);
}

#[test]
fn the_most_specific_glob_wins_whatever_the_order() {
  let root = temp_dir("specific");
  touch(&root, "a.example.json");
  touch(&root, "b.rs");
  // `*` alone would claim `a.example.json` as a folder; the more specific
  // file glob must win even though it is declared second.
  let spec = Spec::closed(vec![
    folder("*", Spec::new(vec![])),
    file("*.example.json"),
    file("*.rs"),
  ]);
  spec.validate(&root).unwrap();
}

#[test]
fn a_literal_claims_its_name_before_a_required_glob() {
  let root = temp_dir("literal_claims");
  touch(&root, "mod.rs");
  let spec = Spec::new(vec![file("mod.rs"), file("*.rs").required()]);
  let err = spec.validate(&root).unwrap_err();
  assert_eq!(err.missing_paths(), vec![root.join("*.rs").as_path()]);
  touch(&root, "a.rs");
  spec.validate(&root).unwrap();
}

#[test]
fn from_json_rejects_flags_and_fields_that_mean_nothing() {
  let bad = [
    (
      serde_json::json!({"kind": "folder", "entries": {"*.rs": {"kind": "file", "optional": true}}}),
      "glob entry cannot be `optional`",
    ),
    (
      serde_json::json!({"kind": "folder", "entries": {"a.rs": {"kind": "file", "required": true}}}),
      "literal entry cannot be `required`",
    ),
    (
      serde_json::json!({"kind": "folder", "entries": {"a": {"kind": "file", "closed": true}}}),
      "cannot carry `closed`",
    ),
    (
      serde_json::json!({"kind": "folder", "entries": {"a": {"kind": "any", "entries": {}}}}),
      "cannot carry `entries`",
    ),
    (
      serde_json::json!({"kind": "folder", "optional": true}),
      "root cannot be",
    ),
    (
      serde_json::json!({"kind": "folder", "entries": {"*.md": {"kind": "none", "required": true}}}),
      "`none` entry cannot be",
    ),
    (
      serde_json::json!({"kind": "folder", "entries": {"..": {"kind": "folder"}}}),
      "single path segment",
    ),
  ];
  for (json, needle) in bad {
    let err = Spec::from_json(&json).unwrap_err();
    assert!(err.message.contains(needle), "{json}: {}", err.message);
  }
}

#[cfg(unix)]
#[test]
fn symlinks_count_as_their_target_and_dangling_ones_fail() {
  let root = temp_dir("symlinks");
  std::fs::create_dir_all(root.join("real")).unwrap();
  std::os::unix::fs::symlink(root.join("real"), root.join("linked")).unwrap();
  std::os::unix::fs::symlink(root.join("nowhere"), root.join("dangling")).unwrap();
  let spec = Spec::new(vec![folder("linked", Spec::new(vec![])), file("dangling")]);
  let err = spec.validate(&root).unwrap_err();
  let leaves = err.leaves();
  assert_eq!(leaves.len(), 1, "{err}");
  match leaves[0] {
    FolderError::Io { path, source } => {
      assert_eq!(path, &root.join("dangling"));
      assert!(source.to_string().contains("broken symlink"));
    }
    other => panic!("expected an io error, got {other}"),
  }
}
