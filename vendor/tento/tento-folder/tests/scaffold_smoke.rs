//! Integration test for the `folder!` macro.
//!
//! Covers: nested folders, optional entries, shell-script executability,
//! and strict-mode load failures on incomplete folders.

use tento_folder::{folder, ContentSource};

folder!(test_folder, {
  "bin": {
    "run.sh": File::Shell,
    "app": File::Binary,
  },
  "config": Folder,
  "data": {
    "cache": Folder,
  },
  "VERSION": File::Text,
  "optional_file"?: File::Text,
});

#[test]
fn macro_generates_buildable_and_loadable_types() {
  let dir = std::env::temp_dir().join("tento_folder_macro_test_basic");
  let _ = std::fs::remove_dir_all(&dir);

  test_folder::Folder::builder()
    .bin(|bin| {
      bin
        .run_sh(ContentSource::write_str("#!/bin/bash"))
        .app(ContentSource::bytes(vec![0u8; 10]))
    })
    .config(ContentSource::empty())
    .data(|data| data.cache(ContentSource::empty()))
    .VERSION(ContentSource::write_str("1.0.0"))
    .build_at(&dir)
    .unwrap();

  let folder = test_folder::Folder::load(&dir).unwrap();

  assert!(folder.bin.run_sh.path().exists());
  assert!(folder.bin.app.path().exists());
  assert!(folder.config.path().exists());
  assert!(folder.data.cache.path().exists());
  assert!(folder.VERSION.path().exists());
  assert!(folder.optional_file.is_none());

  let version = folder.VERSION.read_to_string().unwrap();
  assert_eq!(version, "1.0.0");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn strict_load_fails_on_incomplete_folder() {
  let dir = std::env::temp_dir().join("tento_folder_macro_test_incomplete");
  let _ = std::fs::remove_dir_all(&dir);

  std::fs::create_dir_all(&dir).unwrap();
  std::fs::write(dir.join("VERSION"), "1.0.0").unwrap();

  let result = test_folder::Folder::load(&dir);
  assert!(result.is_err());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
#[cfg(unix)]
fn shell_files_are_made_executable() {
  use std::os::unix::fs::PermissionsExt;

  let dir = std::env::temp_dir().join("tento_folder_macro_test_exec");
  let _ = std::fs::remove_dir_all(&dir);

  test_folder::Folder::builder()
    .bin(|bin| {
      bin
        .run_sh(ContentSource::write_str("#!/bin/bash\necho hi"))
        .app(ContentSource::empty())
    })
    .config(ContentSource::empty())
    .data(|data| data.cache(ContentSource::empty()))
    .VERSION(ContentSource::write_str("1.0.0"))
    .build_at(&dir)
    .unwrap();

  let metadata = std::fs::metadata(dir.join("bin/run.sh")).unwrap();
  let mode = metadata.permissions().mode();
  assert!(mode & 0o111 != 0, "run.sh should be executable");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn atomic_builder_validates_before_replacing_destination() {
  let dir = std::env::temp_dir().join("tento_folder_macro_test_atomic");
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  std::fs::write(dir.join("sentinel"), "old").unwrap();

  let incomplete = test_folder::Folder::builder().VERSION(ContentSource::write_str("2.0.0"));
  assert!(incomplete.build_atomic(&dir).is_err());
  assert_eq!(
    std::fs::read_to_string(dir.join("sentinel")).unwrap(),
    "old"
  );

  let folder = test_folder::Folder::builder()
    .bin(|bin| {
      bin
        .run_sh(ContentSource::write_str("#!/bin/bash"))
        .app(ContentSource::bytes(vec![0u8; 10]))
    })
    .config(ContentSource::empty())
    .data(|data| data.cache(ContentSource::empty()))
    .VERSION(ContentSource::write_str("2.0.0"))
    .build_atomic(&dir)
    .unwrap();

  assert_eq!(folder.VERSION.read_to_string().unwrap(), "2.0.0");
  assert!(!dir.join("sentinel").exists());
  std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn copied_folders_preserve_relative_symlinks() {
  let source = std::env::temp_dir().join("tento_folder_macro_test_symlink_source");
  let dir = std::env::temp_dir().join("tento_folder_macro_test_symlink_bundle");
  let _ = std::fs::remove_dir_all(&source);
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(source.join("Versions/A")).unwrap();
  std::fs::write(source.join("Versions/A/runtime"), "runtime").unwrap();
  std::os::unix::fs::symlink("A", source.join("Versions/Current")).unwrap();

  test_folder::Folder::builder()
    .bin(|bin| {
      bin
        .run_sh(ContentSource::write_str("#!/bin/bash"))
        .app(ContentSource::bytes(vec![0u8; 10]))
    })
    .config(ContentSource::copy(&source))
    .data(|data| data.cache(ContentSource::empty()))
    .VERSION(ContentSource::write_str("3.0.0"))
    .build_atomic(&dir)
    .unwrap();

  assert_eq!(
    std::fs::read_link(dir.join("config/Versions/Current")).unwrap(),
    std::path::PathBuf::from("A")
  );
  std::fs::remove_dir_all(&source).unwrap();
  std::fs::remove_dir_all(&dir).unwrap();
}
