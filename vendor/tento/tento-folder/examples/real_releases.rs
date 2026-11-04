//! Smoke test: load `lona/.releases/` via a `folder!()`-declared schema.
//!
//! Mirrors `loaf-package`'s `loaf_bundle` shape and wraps it in a
//! releases-directory schema. Run from the workspace root:
//!
//!   cargo run -p tento-folder --example real_releases
//!
//! Prints the typed dev/latest fields and iterates over the
//! glob-matched released bundles. If any bundle fails Tier-1
//! validation (missing required entries, malformed JSON/TOML/YAML),
//! `load` errors and we print the structured diagnostic.

use tento_folder::folder;

folder!(loaf_bundle, {
  "bin": {
    "mono": File::Binary,
    "loaf.sh": File::Shell,
  },
  "html": {
    "target.web": Folder,
    "target.web.beta": Folder,
    "target.web.rc": Folder,
  },
  "container_data": {
    "tento-tz": Folder,
    "lona.so": Folder,
  },
  "secrets": Folder,
  "VERSION": File::Text,
});

folder!(loaf_releases, {
  "Loaf-dev.app"?:     loaf_bundle::Folder,
  "Loaf-latest.app"?:  loaf_bundle::Folder,
  "Loaf-*.app":        Glob<loaf_bundle::Folder>,
});

fn main() -> Result<(), Box<dyn std::error::Error>> {
  let releases_dir =
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lona/.releases");
  let releases_dir = releases_dir.canonicalize().unwrap_or(releases_dir);

  println!("Loading {}", releases_dir.display());

  match loaf_releases::Folder::load(&releases_dir) {
    Ok(r) => {
      println!("\n✓ Validation passed.\n");
      println!("Exact-match entries:");
      println!("  Loaf-dev.app     present: {}", r.Loaf_dev_app.is_some());
      println!(
        "  Loaf-latest.app  present: {}",
        r.Loaf_latest_app.is_some()
      );

      println!(
        "\nGlob `Loaf-*.app` matched {} bundle(s):",
        r.Loaf_app.len()
      );
      for (name, bundle) in &r.Loaf_app {
        let version = bundle
          .VERSION
          .read_to_string()
          .map(|s| s.lines().next().unwrap_or("?").to_string())
          .unwrap_or_else(|_| "(unreadable)".to_string());
        println!("  {name}  ({version})");
      }
    }
    Err(e) => {
      eprintln!("✗ Validation failed:");
      eprintln!("{}", e);
      std::process::exit(1);
    }
  }

  Ok(())
}
