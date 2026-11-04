//! Example demonstrating nested folders, optional entries, and the
//! Strict vs Lenient validation modes.
//!
//! Run with: cargo run -p tento-folder --example nested_folder

use tento_folder::formats::{Json, Toml};
use tento_folder::{ContentSource, SchemaKind, folder};

folder!(web_app, {
  "bin": {
    "server": File::Binary,
    "cli": File::Binary,
  },
  "html": {
    "static": {
      "css": Folder,
      "js": Folder,
    },
    "templates": Folder,
  },
  "config": {
    "app.toml": Valid<File<Toml>>,
    "routes.json": Valid<File<Json>>,
  },
  "secrets"?: Folder,
  "VERSION": File::Text,
  "README.md"?: File::Text,
});

fn print_schema(schema: &tento_folder::Schema, indent: usize) {
  let pad = "  ".repeat(indent);
  for entry in schema.entries() {
    let opt = if entry.optional { " (optional)" } else { "" };
    match &entry.kind {
      SchemaKind::File(ft) => println!("{pad}{} → file ({:?}){opt}", entry.name, ft),
      SchemaKind::Folder => println!("{pad}{} → folder{opt}", entry.name),
      SchemaKind::DynamicFolder => println!("{pad}{} → dynamic folder{opt}", entry.name),
      SchemaKind::FolderWithChildren(child) => {
        println!("{pad}{} →{opt}", entry.name);
        print_schema(child, indent + 1);
      }
      SchemaKind::FolderRef(child) => {
        println!(
          "{pad}{} → ref ({} entries){opt}",
          entry.name,
          child.entries().len()
        );
      }
      SchemaKind::FolderGlob { pattern, .. } => {
        println!("{pad}{} → glob folder `{}`{opt}", entry.name, pattern);
      }
      SchemaKind::FileGlob { pattern, .. } => {
        println!("{pad}{} → glob file `{}`{opt}", entry.name, pattern);
      }
    }
  }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
  println!("Declared schema for web_app:");
  print_schema(&web_app::SCHEMA, 1);
  println!();

  let generated_dir =
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/generated");
  let folder_path = generated_dir.join("nested_folder");
  let incomplete_path = generated_dir.join("incomplete_folder");

  let _ = std::fs::remove_dir_all(&folder_path);
  let _ = std::fs::remove_dir_all(&incomplete_path);

  println!("Creating nested folder at: {:?}\n", folder_path);

  web_app::Folder::builder()
    .bin(|bin| {
      bin
        .server(ContentSource::bytes(b"server binary".to_vec()))
        .cli(ContentSource::bytes(b"cli binary".to_vec()))
    })
    .html(|html| {
      html
        .static_(|s| s.css(ContentSource::empty()).js(ContentSource::empty()))
        .templates(ContentSource::empty())
    })
    .config(|config| {
      config
        .app_toml(ContentSource::write_str("[server]\nport = 8080\n"))
        .routes_json(ContentSource::write_str(
          r#"{"routes": ["/api", "/health"]}"#,
        ))
    })
    .VERSION(ContentSource::write_str("2.0.0-beta"))
    .build_at(&folder_path)?;

  let f = web_app::Folder::load(&folder_path)?;

  println!("Nested structure loaded:");
  println!("  bin/server:         {:?}", f.bin.server.path());
  println!("  bin/cli:            {:?}", f.bin.cli.path());
  println!("  html/static/css:    {:?}", f.html.static_.css.path());
  println!("  html/static/js:     {:?}", f.html.static_.js.path());
  println!("  html/templates:     {:?}", f.html.templates.path());
  println!("  config/app.toml:    {:?}", f.config.app_toml.path());
  println!("  config/routes.json: {:?}", f.config.routes_json.path());

  println!("\nOptional entries:");
  println!("  secrets present?   {}", f.secrets.is_some());
  println!("  README.md present? {}", f.README_md.is_some());

  // `Valid<File<…>>` proved these parse during `load`, but kept only
  // the path — so producing the value is a (fallible) `read()`.
  println!("\nConfig contents:");
  println!("  app.toml:\n{:?}", f.config.app_toml.read()?);
  println!("  routes.json: {:?}", f.config.routes_json.read()?);

  // ─── Strict validation on an incomplete tree ──────────────────────────
  println!("\n--- Strict validation on incomplete folder ---");

  std::fs::create_dir_all(&incomplete_path)?;
  std::fs::write(incomplete_path.join("VERSION"), "1.0.0")?;

  match web_app::Folder::load(&incomplete_path) {
    Ok(_) => println!("  Unexpectedly succeeded!"),
    Err(e) => println!("  Failed as expected:\n{}", e),
  }

  println!("\nFolders preserved at:");
  println!("  {:?}", folder_path);
  println!("  {:?}", incomplete_path);

  Ok(())
}
