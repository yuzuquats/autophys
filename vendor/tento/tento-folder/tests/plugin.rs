//! The tsh plugin stays true to the crate, and behaves through tsh.
//!
//! `tsh.toml` is the authored contract tsh-package packages from; it owns
//! the bundle's name, version, mount, entrypoint, transport and
//! description, and `manifest.json` repeats them with the same values
//! beside the command descriptors, which must be exactly what the binary
//! prints for tsh-package with `--help --json`.
//!
//! When a tsh is available (`TENTO_FOLDER_TEST_TSH`, else `~/.local/bin/tsh`;
//! `TENTO_FOLDER_REQUIRE_TSH=1` makes a missing one a failure), the bundle is
//! also run through it: `(@import "tento-folder" :as "folder")` mounts the
//! commands, `(folder.check SPEC DIR :report)` returns the violations as a
//! tsh value, and `(folder.check SPEC DIR)` on a directory that breaks the
//! spec ends the script non-zero, naming the violation.
#![cfg(feature = "cli")]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

// Beside this file's crate, not CARGO_MANIFEST_DIR: tsh builds these
// sources from a side workspace of its own (crates/<plugin>-tsh), whose
// manifest directory holds neither file.
const MANIFEST: &str = include_str!("../manifest.json");
const TSH_TOML: &str = include_str!("../tsh.toml");

fn manifest() -> Value {
  serde_json::from_str(MANIFEST).unwrap()
}

#[test]
fn tsh_toml_and_the_manifest_name_this_crate_at_its_version_and_agree() {
  let m = manifest();
  let t: toml::Table = TSH_TOML.parse().unwrap();
  let plugin = t["plugin"].as_table().unwrap();
  assert_eq!(m["schema"], "tsh.app/v1");
  assert_eq!(plugin["name"].as_str(), Some(env!("CARGO_PKG_NAME")));
  assert_eq!(plugin["version"].as_str(), Some(env!("CARGO_PKG_VERSION")));
  // Without it tsh mounts the id minus `tento-`, which is also `folder`;
  // stated so the README's `folder.*` never depends on that rule.
  assert_eq!(plugin["mount"].as_str(), Some("folder"));
  assert_eq!(plugin["entrypoint"].as_str(), Some("bin/tento-folder"));
  assert_eq!(plugin["transport"].as_str(), Some("oneshot"));
  for key in [
    "name",
    "version",
    "mount",
    "entrypoint",
    "transport",
    "description",
  ] {
    assert_eq!(m[key].as_str(), plugin[key].as_str(), "{key}");
  }
  assert_eq!(t["build"]["packager"].as_str(), Some("tsh-package"));
}

#[test]
fn the_manifest_describes_exactly_what_the_binary_does() {
  let out = Command::new(env!("CARGO_BIN_EXE_tento-folder"))
    .args(["--help", "--json"])
    .output()
    .unwrap();
  assert!(out.status.success());
  let described: Value = serde_json::from_slice(&out.stdout).unwrap();
  assert_eq!(described["commands"], manifest()["commands"]);
  let mut names: Vec<_> = manifest()["commands"]
    .as_object()
    .unwrap()
    .keys()
    .cloned()
    .collect();
  names.sort_unstable();
  assert_eq!(names, ["check", "show"]);
}

/// The tsh to run the bundle through, if any.
fn tsh() -> Option<PathBuf> {
  let found = std::env::var_os("TENTO_FOLDER_TEST_TSH")
    .map(PathBuf::from)
    .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/bin/tsh")))
    .filter(|p| p.is_file());
  if found.is_none() {
    assert!(
      std::env::var_os("TENTO_FOLDER_REQUIRE_TSH").is_none(),
      "TENTO_FOLDER_REQUIRE_TSH=1 but no tsh was found"
    );
    eprintln!(
      "no tsh found (TENTO_FOLDER_TEST_TSH or ~/.local/bin/tsh): the through-tsh checks are skipped"
    );
  }
  found
}

#[cfg(unix)]
#[test]
fn through_tsh_check_reports_as_a_value_and_fails_the_script_on_violations() {
  let Some(tsh) = tsh() else { return };
  let dir = std::env::temp_dir().join(format!("tento-folder-plugin-tsh-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  let app = dir.join("apps/tento-folder.tsh.app");
  std::fs::create_dir_all(app.join("bin")).unwrap();
  for sub in ["managed", "state", "checked"] {
    std::fs::create_dir_all(dir.join(sub)).unwrap();
  }
  let dir = std::fs::canonicalize(&dir).unwrap();
  // The bundle: this manifest and this build's binary.
  std::fs::write(app.join("manifest.json"), MANIFEST).unwrap();
  std::os::unix::fs::symlink(
    env!("CARGO_BIN_EXE_tento-folder"),
    app.join("bin/tento-folder"),
  )
  .unwrap();
  // A spec that allows one file, and a directory holding it and a stray.
  let spec = dir.join("layout.folder");
  std::fs::write(&spec, "(folder.closed {\"a.txt\" folder.file})\n").unwrap();
  let checked = dir.join("checked");
  std::fs::write(checked.join("a.txt"), "").unwrap();
  std::fs::write(checked.join("stray.txt"), "").unwrap();
  let (spec, checked) = (spec.display().to_string(), checked.display().to_string());

  let run = |name: &str, body: &str| {
    let script = dir.join(name);
    std::fs::write(
      &script,
      format!("(@import \"tento-folder\" :as \"folder\")\n{body}\n"),
    )
    .unwrap();
    Command::new(&tsh)
      .arg(&script)
      .current_dir(&dir)
      .env("TSH_APP_PATH", dir.join("apps"))
      .env("TSH_APPS_DIR", dir.join("managed"))
      .env("TENTO_APP_STATE_DIR", dir.join("state"))
      .output()
      .unwrap()
  };

  // --report: the report is a value (a tsh script prints its last form).
  let report = run(
    "report.tsh",
    &format!(
      "(let r (folder.check \"{spec}\" \"{checked}\" :report))\n\
       (let v (first (get (get r \"records\") \"violations\")))\n\
       (str (get r \"datatype\") \" \" (get v \"path\") \" \" (get v \"problem\"))"
    ),
  );
  let stdout = String::from_utf8_lossy(&report.stdout);
  assert!(
    report.status.success(),
    "{}",
    String::from_utf8_lossy(&report.stderr)
  );
  assert_eq!(
    stdout.trim(),
    "folder.check/v1 stray.txt unexpected",
    "{stdout}"
  );

  // Without --report a violation fails the script, by name.
  let failed = run(
    "check.tsh",
    &format!("(folder.check \"{spec}\" \"{checked}\")\n(str \"after the check\")"),
  );
  let stderr = String::from_utf8_lossy(&failed.stderr);
  assert_ne!(failed.status.code(), Some(0), "{stderr}");
  assert!(
    stderr.contains("stray.txt"),
    "the violation is named: {stderr}"
  );
  assert!(
    !String::from_utf8_lossy(&failed.stdout).contains("after the check"),
    "the script stopped"
  );

  // And a conforming directory passes.
  std::fs::remove_file(Path::new(&checked).join("stray.txt")).unwrap();
  let passed = run(
    "pass.tsh",
    &format!("(folder.check \"{spec}\" \"{checked}\")\n\"ok\""),
  );
  assert!(
    passed.status.success(),
    "{}",
    String::from_utf8_lossy(&passed.stderr)
  );
  let _ = std::fs::remove_dir_all(&dir);
}
