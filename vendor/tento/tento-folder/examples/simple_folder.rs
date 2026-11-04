//! Simple example demonstrating the `folder!` macro.
//!
//! Run with: cargo run -p tento-folder --example simple_folder

use tento_folder::{ContentSource, SchemaKind, folder};

folder!(app_folder, {
  "bin": {
    "app": File::Binary,
    "run.sh": File::Shell,
  },
  "config": Folder,
  "VERSION": File::Text,
});

fn main() -> Result<(), Box<dyn std::error::Error>> {
  // Schema introspection — works without a folder on disk.
  println!("Declared schema:");
  for entry in app_folder::SCHEMA.entries() {
    let opt = if entry.optional { " (optional)" } else { "" };
    let kind = match &entry.kind {
      SchemaKind::File(ft) => format!("file ({:?})", ft),
      SchemaKind::Folder => "folder".to_string(),
      SchemaKind::FolderWithChildren(s) => {
        format!("folder with {} entries", s.entries().len())
      }
      SchemaKind::DynamicFolder => "dynamic folder".to_string(),
      SchemaKind::FolderRef(s) => {
        format!("cross-schema ref ({} entries)", s.entries().len())
      }
      SchemaKind::FolderGlob { pattern, .. } => format!("glob folder `{}`", pattern),
      SchemaKind::FileGlob { pattern, .. } => format!("glob file `{}`", pattern),
    };
    println!("  {} → {}{}", entry.name, kind, opt);
  }
  println!();

  let folder_path =
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/generated/simple_folder");

  let _ = std::fs::remove_dir_all(&folder_path);

  println!("Creating folder at: {:?}", folder_path);

  app_folder::Folder::builder()
    .bin(|bin| {
      bin
        .app(ContentSource::bytes(vec![0x7f, 0x45, 0x4c, 0x46])) // ELF header
        .run_sh(ContentSource::write_str(
          "#!/bin/bash\necho 'Hello from folder!'",
        ))
    })
    .config(ContentSource::empty())
    .VERSION(ContentSource::write_str("1.0.0"))
    .build_at(&folder_path)?;

  println!("Folder created.\n");

  let f = app_folder::Folder::load(&folder_path)?;

  println!("Loaded folder:");
  println!("  Root: {:?}", f.root());
  println!("  bin/app:    {:?}", f.bin.app.path());
  println!("  bin/run.sh: {:?}", f.bin.run_sh.path());
  println!("  config:     {:?}", f.config.path());
  println!("  VERSION:    {:?}", f.VERSION.path());
  println!("\nVERSION contents: {}", f.VERSION.read_to_string()?);
  println!("\nFolder preserved at: {:?}", folder_path);

  Ok(())
}
