//! Tests for `Validator` and the standalone validate/load helpers.
//!
//! Lenient mode and `ValidationMode` were removed; everything is
//! strict-only.

use std::path::PathBuf;

use tento_folder::{FolderError, Validator, validate_file, validate_folder};

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_validate_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

#[test]
fn missing_file_errors() {
  let path = std::env::temp_dir().join("tento_folder_test_nonexistent_strict.txt");
  let _ = std::fs::remove_file(&path);

  let err = validate_file(&path).unwrap_err();
  assert!(matches!(err, FolderError::Missing { .. }));
}

#[test]
fn file_validator_rejects_folder_at_path() {
  let dir = temp_dir("file_at_folder");

  let err = validate_file(&dir).unwrap_err();
  assert!(matches!(err, FolderError::WrongKind { .. }));

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn folder_validator_rejects_file_at_path() {
  let dir = temp_dir("folder_at_file");
  let file_path = dir.join("a_file");
  std::fs::write(&file_path, "x").unwrap();

  let err = validate_folder(&file_path).unwrap_err();
  assert!(matches!(err, FolderError::WrongKind { .. }));

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn validator_collects_multiple_errors() {
  let mut v = Validator::new();

  v.check_file(&PathBuf::from("/tmp/tento_folder_validate_missing_a"));
  v.check_file(&PathBuf::from("/tmp/tento_folder_validate_missing_b"));
  v.check_folder(&PathBuf::from("/tmp/tento_folder_validate_missing_dir"));

  assert!(!v.is_valid());

  let err = v.finish().unwrap_err();
  match err {
    FolderError::Multiple(errors) => {
      assert_eq!(errors.len(), 3);
      assert!(
        errors
          .iter()
          .all(|e| matches!(e, FolderError::Missing { .. })),
      );
    }
    other => panic!("expected Multiple, got {other:?}"),
  }
}

#[test]
fn missing_paths_helper_walks_multiple() {
  let mut v = Validator::new();
  v.check_file(&PathBuf::from("/tmp/tento_folder_validate_missing_paths_a"));
  v.check_file(&PathBuf::from("/tmp/tento_folder_validate_missing_paths_b"));

  let err = v.finish().unwrap_err();
  let paths = err.missing_paths();
  assert_eq!(paths.len(), 2);
  assert!(err.has_missing());
}

#[test]
fn combine_single_error_returns_it_unwrapped() {
  let single = FolderError::missing_file("/tmp/x");
  let combined = FolderError::combine(vec![single]).unwrap();
  assert!(matches!(combined, FolderError::Missing { .. }));
}

#[test]
fn combine_empty_returns_none() {
  assert!(FolderError::combine(vec![]).is_none());
}
