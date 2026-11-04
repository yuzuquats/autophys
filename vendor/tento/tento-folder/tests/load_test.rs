//! Tests for `folder!`-generated load semantics: optional entries,
//! Strict vs Lenient mode, and structured error reporting.

use tento_folder::formats::Toml;
use tento_folder::{ContentSource, FolderError, folder};

folder!(load_test, {
  "bin": Folder,
  "VERSION": File::Text,
  "config"?: {
    "settings.toml": Valid<File<Toml>>,
  },
});

fn temp_dir(name: &str) -> std::path::PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_load_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  dir
}

#[test]
fn optional_nested_folder_missing_is_none() {
  let dir = temp_dir("opt_none");

  load_test::Folder::builder()
    .bin(ContentSource::empty())
    .VERSION(ContentSource::write_str("1.0"))
    .build_at(&dir)
    .unwrap();

  let f = load_test::Folder::load(&dir).unwrap();
  assert!(f.config.is_none());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn optional_nested_folder_present_is_some() {
  let dir = temp_dir("opt_some");

  load_test::Folder::builder()
    .bin(ContentSource::empty())
    .VERSION(ContentSource::write_str("1.0"))
    .config(|c| c.settings_toml(ContentSource::write_str("[a]\nb = 1\n")))
    .build_at(&dir)
    .unwrap();

  let f = load_test::Folder::load(&dir).unwrap();
  let config = f.config.expect("config present");
  assert!(config.settings_toml.path().exists());
  // Proven at load, held as a path: producing the value re-reads.
  let settings = config.settings_toml.read().unwrap();
  assert_eq!(settings["a"]["b"].as_integer(), Some(1));

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn strict_load_reports_wrong_kind() {
  let dir = temp_dir("wrong_kind");
  std::fs::create_dir_all(&dir).unwrap();
  // Put a file where `bin/` folder is expected.
  std::fs::write(dir.join("bin"), "not-a-folder").unwrap();
  std::fs::write(dir.join("VERSION"), "1.0").unwrap();

  let err = load_test::Folder::load(&dir).unwrap_err();
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
fn strict_load_collects_multiple_missing() {
  let dir = temp_dir("strict_missing");
  std::fs::create_dir_all(&dir).unwrap();

  let err = load_test::Folder::load(&dir).unwrap_err();
  match err {
    FolderError::Multiple(errors) => {
      assert!(errors.len() >= 2);
      assert!(
        errors
          .iter()
          .all(|e| matches!(e, FolderError::Missing { .. })),
      );
    }
    single => panic!("expected Multiple, got {single:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn round_trip_preserves_file_contents() {
  let dir = temp_dir("round_trip");

  load_test::Folder::builder()
    .bin(ContentSource::empty())
    .VERSION(ContentSource::write_str("v=42\n"))
    .build_at(&dir)
    .unwrap();

  let f = load_test::Folder::load(&dir).unwrap();
  assert_eq!(f.VERSION.read_to_string().unwrap(), "v=42\n");
  assert!(f.bin.exists());

  std::fs::remove_dir_all(&dir).unwrap();
}
