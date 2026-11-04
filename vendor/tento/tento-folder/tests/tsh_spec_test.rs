//! The `folder.*` tsh DSL evaluates to the same [`Spec`] the Rust
//! constructors build.
#![cfg(feature = "tsh")]

use tento_folder::tsh::spec_from_tsh;
use tento_folder::{Spec, SpecEntry, SpecKind};

#[test]
fn dsl_builds_the_spec() {
  let spec = spec_from_tsh(
    r#"
    ;; a connector crate, abridged
    (folder.closed {"Cargo.toml" folder.file
                    "README.md"  (folder.opt folder.file)
                    "vendor"     folder.any
                    "src" (folder.dir {"lib.rs" folder.file
                                       "*.rs"   (folder.some folder.file)})})
    "#,
  )
  .unwrap();

  let expected = Spec::closed(vec![
    SpecEntry::new("Cargo.toml", SpecKind::File),
    SpecEntry::new("README.md", SpecKind::File).optional(),
    SpecEntry::new("vendor", SpecKind::Any),
    SpecEntry::new(
      "src",
      SpecKind::Folder(Spec::new(vec![
        SpecEntry::new("lib.rs", SpecKind::File),
        SpecEntry::new("*.rs", SpecKind::File).required(),
      ])),
    ),
  ]);
  assert_eq!(spec.to_json(), expected.to_json());
}

#[test]
fn dsl_errors_are_reported() {
  assert!(spec_from_tsh("(folder.closed {\"a\" folder.nope})").is_err());
  assert!(spec_from_tsh("folder.file").is_err());
}
