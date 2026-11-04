//! Which watcher events can change a webapp's build output.
//!
//! The filter never drops a path the last clean build read, and it falls back
//! to "rebuild" whenever that build graph is missing (no clean build yet, or
//! the last build reported errors, in which case the bundler reports no
//! inputs). It drops only what cannot change an output: editor and VCS
//! noise, the webapp's own output trees, and non-input files outside
//! `html_root` that no bundle could have read.
//! See `projects/frontend-build-scheduling.project.docs`.

use std::{
  collections::HashSet,
  ffi::OsStr,
  path::{Component, Path, PathBuf},
  sync::Arc,
};

/// Paths no build reads, whoever watches them: editor swap, backup and
/// atomic-save temporaries, OS metadata, and version-control internals.
pub(crate) fn is_noise(path: &Path) -> bool {
  let in_vcs = path.components().any(|c| match c {
    Component::Normal(name) => name == ".git" || name == ".hg" || name == ".svn",
    _ => false,
  });
  if in_vcs {
    return true;
  }
  let Some(name) = path.file_name().and_then(OsStr::to_str) else {
    return false;
  };
  name.ends_with('~')
    || name.starts_with(".#")
    || (name.len() > 1 && name.starts_with('#') && name.ends_with('#'))
    || name == "4913"
    || name == ".DS_Store"
    || name.ends_with(".swp")
    || name.ends_with(".swo")
    || name.ends_with(".swx")
    || name.ends_with("___jb_tmp___")
    || name.ends_with("___jb_old___")
}

/// Resolution config esbuild reads but does not list in its metafile.
const RESOLUTION_CONFIG: &[&str] = &[
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "package.json",
  "tsconfig.json",
  "import_map.json",
];

/// Extensions a page can import or a loader can read: a new or deleted file
/// with one may be a new import, or the file a failing import was missing.
const BUILDABLE: &[&str] = &[
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "css", "json", "jsonc", "html", "htm",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf", "wasm",
];

fn is_test_file(name: &str) -> bool {
  [".test.", "_test.", ".spec."]
    .iter()
    .any(|marker| name.contains(marker))
}

/// What one webapp's filter knows: where its sources and outputs are, and
/// the files its last clean build read (`None` = unknown, rebuild broadly).
pub(crate) struct WebappFilter<'a> {
  pub html_root: Option<&'a Path>,
  pub outputs: &'a [PathBuf],
  pub inputs: Option<Arc<HashSet<PathBuf>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
  Rebuild,
  /// Inside the webapp's own output: a build observing itself.
  OwnOutput,
  /// Not read by the last clean build and not something a build could pick
  /// up without another, relevant edit.
  NotAnInput,
}

impl WebappFilter<'_> {
  pub fn decide(&self, path: &Path) -> Decision {
    if self.outputs.iter().any(|o| path.starts_with(o)) {
      return Decision::OwnOutput;
    }
    let Some(inputs) = &self.inputs else {
      return Decision::Rebuild;
    };
    if inputs.contains(path) {
      return Decision::Rebuild;
    }
    // `copy_files_step` copies every non-`.ts` file under the html root and
    // templates every `.html`: assets, templates and new routes all matter.
    if self.html_root.is_some_and(|root| path.starts_with(root)) {
      return Decision::Rebuild;
    }
    let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
    if RESOLUTION_CONFIG.contains(&name) {
      return Decision::Rebuild;
    }
    if is_test_file(name) {
      return Decision::NotAnInput;
    }
    let buildable = path
      .extension()
      .and_then(OsStr::to_str)
      .is_some_and(|ext| BUILDABLE.contains(&ext.to_ascii_lowercase().as_str()));
    if buildable {
      return Decision::Rebuild;
    }
    // A directory that moved or vanished takes its inputs with it.
    if inputs.iter().any(|input| input.starts_with(path)) {
      return Decision::Rebuild;
    }
    Decision::NotAnInput
  }
}

/// The canonical form of a path that may no longer exist: the path itself
/// if it resolves, else its resolved parent joined with its name, else the
/// path unchanged. Watcher events name paths under the canonical directory
/// that was watched, deleted files included.
pub(crate) fn canonical_lossy(path: &Path) -> PathBuf {
  if let Ok(p) = path.canonicalize() {
    return p;
  }
  match (path.parent(), path.file_name()) {
    (Some(parent), Some(name)) => parent
      .canonicalize()
      .map(|p| p.join(name))
      .unwrap_or_else(|_| path.to_path_buf()),
    _ => path.to_path_buf(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn filter<'a>(
    html_root: Option<&'a Path>,
    outputs: &'a [PathBuf],
    inputs: Option<&[&str]>,
  ) -> WebappFilter<'a> {
    WebappFilter {
      html_root,
      outputs,
      inputs: inputs.map(|i| Arc::new(i.iter().map(PathBuf::from).collect())),
    }
  }

  #[test]
  fn editor_and_vcs_noise_is_ignored_everywhere() {
    for noisy in [
      "/src/pkg/.page.ts.swp",
      "/src/pkg/.page.ts.swx",
      "/src/pkg/page.ts~",
      "/src/pkg/.#page.ts",
      "/src/pkg/#page.ts#",
      "/src/pkg/4913",
      "/src/pkg/.DS_Store",
      "/src/pkg/page.ts___jb_tmp___",
      "/src/.git/index.lock",
      "/src/pkg/.hg/store",
    ] {
      assert!(is_noise(Path::new(noisy)), "{noisy}");
    }
    for real in [
      "/src/pkg/page.ts",
      "/src/pkg/#hash.css",
      "/src/pkg/gitignore.ts",
      "/src/pkg/.gitkeep",
    ] {
      assert!(!is_noise(Path::new(real)), "{real}");
    }
  }

  #[test]
  fn known_inputs_rebuild_and_own_output_never_does() {
    let outputs = vec![PathBuf::from("/rel/target.web.beta")];
    let f = filter(
      Some(Path::new("/app/html")),
      &outputs,
      Some(&["/pkg/a.ts", "/pkg/notes.md"]),
    );
    assert_eq!(f.decide(Path::new("/pkg/a.ts")), Decision::Rebuild);
    assert_eq!(
      f.decide(Path::new("/pkg/notes.md")),
      Decision::Rebuild,
      "an input is an input whatever its extension"
    );
    assert_eq!(
      f.decide(Path::new("/rel/target.web.beta/app/x.js")),
      Decision::OwnOutput
    );
  }

  #[test]
  fn without_a_clean_build_graph_everything_but_output_rebuilds() {
    let outputs = vec![PathBuf::from("/rel/target.web.beta")];
    let f = filter(None, &outputs, None);
    assert_eq!(f.decide(Path::new("/pkg/lib.rs")), Decision::Rebuild);
    assert_eq!(f.decide(Path::new("/pkg/README.md")), Decision::Rebuild);
    assert_eq!(
      f.decide(Path::new("/rel/target.web.beta/app/x.js")),
      Decision::OwnOutput
    );
  }

  #[test]
  fn everything_under_the_html_root_rebuilds() {
    let f = filter(
      Some(Path::new("/app/html")),
      &[],
      Some(&["/app/html/routes/index.root.ts"]),
    );
    for p in [
      "/app/html/routes/index.html",
      "/app/html/routes/new-page.root.ts",
      "/app/html/assets/logo.png",
      "/app/html/assets/data.bin",
      "/app/html/README.md",
    ] {
      assert_eq!(f.decide(Path::new(p)), Decision::Rebuild, "{p}");
    }
  }

  #[test]
  fn new_deleted_imports_config_and_assets_rebuild_outside_the_html_root() {
    let f = filter(Some(Path::new("/app/html")), &[], Some(&["/pkg/src/a.ts"]));
    for p in [
      "/pkg/src/new-module.ts",
      "/pkg/src/new-style.css",
      "/pkg/src/icon.svg",
      "/pkg/src/data.json",
      "/pkg/src/font.woff2",
      "/pkg/src/IMAGE.PNG",
      "/pkg/deno.json",
      "/pkg/deno.lock",
      "/pkg/package.json",
      "/pkg/tsconfig.json",
    ] {
      assert_eq!(f.decide(Path::new(p)), Decision::Rebuild, "{p}");
    }
    assert_eq!(
      f.decide(Path::new("/pkg/src/a.ts")),
      Decision::Rebuild,
      "a deleted input is still in the graph"
    );
    assert_eq!(
      f.decide(Path::new("/pkg/src")),
      Decision::Rebuild,
      "a moved directory holding inputs"
    );
  }

  #[test]
  fn non_inputs_that_no_bundle_reads_are_ignored_outside_the_html_root() {
    let f = filter(Some(Path::new("/app/html")), &[], Some(&["/pkg/src/a.ts"]));
    for p in [
      "/pkg/src/lib.rs",
      "/pkg/src/NOTES.md",
      "/pkg/Cargo.toml",
      "/pkg/src/a.test.ts",
      "/pkg/src/a_test.ts",
      "/pkg/src/a.spec.tsx",
      "/pkg/LICENSE",
      "/pkg/src/empty-new-dir",
    ] {
      assert_eq!(f.decide(Path::new(p)), Decision::NotAnInput, "{p}");
    }
  }

  #[test]
  fn canonical_lossy_resolves_deleted_files_through_their_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    std::fs::write(dir.join("here.ts"), "").unwrap();
    assert_eq!(
      canonical_lossy(&tmp.path().join("here.ts")),
      dir.join("here.ts")
    );
    assert_eq!(
      canonical_lossy(&tmp.path().join("gone.ts")),
      dir.join("gone.ts")
    );
    assert_eq!(
      canonical_lossy(Path::new("/no/such/dir/x.ts")),
      PathBuf::from("/no/such/dir/x.ts")
    );
  }
}
