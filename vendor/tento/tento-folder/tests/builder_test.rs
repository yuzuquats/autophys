//! Tests for the programmatic `FolderBuilder` (non-macro API).

use std::path::PathBuf;

use tento_folder::{ContentSource, FolderBuilder};

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_builder_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  dir
}

#[test]
fn builds_simple_folder() {
  let dir = temp_dir("simple");

  let path = FolderBuilder::new()
    .add_text_file("VERSION", ContentSource::write_str("1.0.0"))
    .add_folder("bin", ContentSource::empty())
    .add_shell_script(
      "bin/run.sh",
      ContentSource::write_str("#!/bin/bash\necho hello"),
    )
    .build_at(&dir)
    .unwrap();

  assert!(path.join("VERSION").is_file());
  assert!(path.join("bin").is_dir());
  assert!(path.join("bin/run.sh").is_file());
  assert_eq!(
    std::fs::read_to_string(path.join("VERSION")).unwrap(),
    "1.0.0",
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn build_atomic_round_trip() {
  let dir = temp_dir("atomic");

  let path = FolderBuilder::new()
    .add_text_file("config.txt", ContentSource::write_str("config"))
    .add_binary_file("data.bin", ContentSource::bytes(vec![1, 2, 3, 4]))
    .build_atomic(&dir)
    .unwrap();

  assert!(path.join("config.txt").is_file());
  assert!(path.join("data.bin").is_file());
  assert_eq!(
    std::fs::read(path.join("data.bin")).unwrap(),
    vec![1, 2, 3, 4],
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn build_at_overwrites_existing() {
  let dir = temp_dir("overwrite");
  std::fs::create_dir_all(&dir).unwrap();
  std::fs::write(dir.join("stale.txt"), "stale").unwrap();

  FolderBuilder::new()
    .add_text_file("fresh.txt", ContentSource::write_str("fresh"))
    .build_at(&dir)
    .unwrap();

  assert!(!dir.join("stale.txt").exists());
  assert!(dir.join("fresh.txt").is_file());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
#[cfg(unix)]
fn shell_script_gets_exec_bit() {
  use std::os::unix::fs::PermissionsExt;

  let dir = temp_dir("shell_exec");

  FolderBuilder::new()
    .add_shell_script("script.sh", ContentSource::write_str("#!/bin/bash"))
    .build_at(&dir)
    .unwrap();

  let mode = std::fs::metadata(dir.join("script.sh"))
    .unwrap()
    .permissions()
    .mode();
  assert!(mode & 0o111 != 0, "script.sh should be executable");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
#[cfg(unix)]
fn symlink_content_source_works() {
  let dir = temp_dir("symlink");
  let target_dir = temp_dir("symlink_target");
  std::fs::create_dir_all(&target_dir).unwrap();
  std::fs::write(target_dir.join("hello.txt"), "hi").unwrap();

  FolderBuilder::new()
    .add_folder("linked", ContentSource::symlink(&target_dir))
    .build_at(&dir)
    .unwrap();

  let linked = dir.join("linked");
  assert!(linked.exists());
  assert!(linked.join("hello.txt").exists());

  std::fs::remove_dir_all(&dir).unwrap();
  std::fs::remove_dir_all(&target_dir).unwrap();
}

#[test]
fn copy_content_source_for_file() {
  let dir = temp_dir("copy_file");
  let src_dir = temp_dir("copy_source");
  std::fs::create_dir_all(&src_dir).unwrap();
  let src_file = src_dir.join("source.txt");
  std::fs::write(&src_file, "copied").unwrap();

  FolderBuilder::new()
    .add_text_file("dest.txt", ContentSource::copy(&src_file))
    .build_at(&dir)
    .unwrap();

  assert_eq!(
    std::fs::read_to_string(dir.join("dest.txt")).unwrap(),
    "copied",
  );

  std::fs::remove_dir_all(&dir).unwrap();
  std::fs::remove_dir_all(&src_dir).unwrap();
}

#[test]
fn copy_content_source_for_folder_recursive() {
  let dir = temp_dir("copy_folder");
  let src_dir = temp_dir("copy_folder_source");
  std::fs::create_dir_all(src_dir.join("nested")).unwrap();
  std::fs::write(src_dir.join("top.txt"), "top").unwrap();
  std::fs::write(src_dir.join("nested/inner.txt"), "inner").unwrap();

  FolderBuilder::new()
    .add_folder("copied", ContentSource::copy(&src_dir))
    .build_at(&dir)
    .unwrap();

  assert_eq!(
    std::fs::read_to_string(dir.join("copied/top.txt")).unwrap(),
    "top",
  );
  assert_eq!(
    std::fs::read_to_string(dir.join("copied/nested/inner.txt")).unwrap(),
    "inner",
  );

  std::fs::remove_dir_all(&dir).unwrap();
  std::fs::remove_dir_all(&src_dir).unwrap();
}

#[test]
fn empty_builder_state() {
  let b = FolderBuilder::new();
  assert!(b.is_empty());
  assert_eq!(b.len(), 0);
}
