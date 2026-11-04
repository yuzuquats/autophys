//! End-to-end smoke test: declare a Loaf-shaped releases schema with
//! glob entries + cross-schema refs, and exercise it.
//!
//! Builds a fake release directory with a dev bundle and two
//! "released" bundles, then loads it via the typed releases folder.
//! Verifies exact-match consumption, glob iteration, and that the
//! cross-schema-validated child enforces its inner schema.

use std::path::PathBuf;

use tento_folder::{ContentSource, folder};

// Inner schema: a Loaf-style bundle.
folder!(loaf_bundle, {
  "bin": {
    "mono": File::Binary,
    "loaf.sh": File::Shell,
  },
  "VERSION": File::Text,
});

// Outer schema: a releases directory.
folder!(loaf_releases, {
  "Loaf-dev.app"?:     loaf_bundle::Folder,
  "Loaf-latest.app"?:  loaf_bundle::Folder,
  "Loaf-*.app":        Glob<loaf_bundle::Folder>,
});

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_releases_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

fn build_bundle(at: &std::path::Path, version: &str) {
  loaf_bundle::Folder::builder()
    .bin(|b| {
      b.mono(ContentSource::bytes(b"binary".to_vec()))
        .loaf_sh(ContentSource::write_str("#!/bin/sh\nexec ./bin/mono\n"))
    })
    .VERSION(ContentSource::write_str(version))
    .build_at(at)
    .unwrap();
}

#[test]
fn loaf_releases_schema_loads_with_glob_and_exact_entries() {
  let dir = temp_dir("happy_path");

  // Build dev + two released bundles.
  build_bundle(&dir.join("Loaf-dev.app"), "1.0.0-dev");
  build_bundle(&dir.join("Loaf-1.0.40-7d2cbef-6344b409.app"), "1.0.40");
  build_bundle(&dir.join("Loaf-1.0.39-7d2cbef-dd81709d.app"), "1.0.39");

  let r = loaf_releases::Folder::load(&dir).expect("releases tree loads");

  // Exact-match entries:
  assert!(r.Loaf_dev_app.is_some(), "dev present");
  assert!(r.Loaf_latest_app.is_none(), "latest absent");

  // Glob field carries the two released bundles, names included.
  let names: Vec<&str> = r.Loaf_app.iter().map(|(n, _)| n.as_str()).collect();
  assert_eq!(
    r.Loaf_app.len(),
    2,
    "two glob matches, got names: {names:?}"
  );
  assert!(names.contains(&"Loaf-1.0.40-7d2cbef-6344b409.app"));
  assert!(names.contains(&"Loaf-1.0.39-7d2cbef-dd81709d.app"));

  // Cross-schema-validated child carries typed bundle fields.
  let dev = r.Loaf_dev_app.as_ref().unwrap();
  assert!(dev.bin.mono.path().is_file());
  assert!(dev.bin.loaf_sh.path().is_file());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn malformed_child_bundle_fails_outer_load() {
  let dir = temp_dir("malformed_child");

  // Build a glob-matching child that's missing required entries.
  let bad = dir.join("Loaf-1.0.40-7d2cbef-6344b409.app");
  std::fs::create_dir_all(&bad).unwrap();
  std::fs::write(bad.join("VERSION"), "1.0.40").unwrap();
  // missing bin/

  // Outer load must surface the missing-entry error.
  let err = loaf_releases::Folder::load(&dir).unwrap_err();
  assert!(
    err.has_missing(),
    "expected missing-entry error, got: {err:?}"
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn glob_with_anonymous_folder_catch_all() {
  // Separately-declared schema that uses Glob<Folder> as a catch-all
  // (no sub-schema). Useful for older / unknown release bundles.
  folder!(loaf_releases_loose, {
    "Loaf-dev.app"?: loaf_bundle::Folder,
    "Loaf-*.app":    Glob<Folder>,
  });

  let dir = temp_dir("loose_catch_all");

  // The "released" entry is intentionally just a non-conforming folder.
  std::fs::create_dir_all(dir.join("Loaf-1.0.0.app/whatever")).unwrap();

  let r = loaf_releases_loose::Folder::load(&dir).expect("loose load passes");
  assert_eq!(r.Loaf_app.len(), 1);
  assert_eq!(r.Loaf_app[0].0, "Loaf-1.0.0.app");

  std::fs::remove_dir_all(&dir).unwrap();
}
