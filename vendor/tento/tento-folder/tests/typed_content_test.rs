//! Tests for the typed `File<C>` slot and its two axes.
//!
//! **Encoding, inside**: the bundled [`formats`](tento_folder::formats)
//! markers (`Json<T>` / `Toml<T>` / `Yaml<T>`) versus a bare custom
//! [`FileContent`] filetype in a bespoke, non-serde encoding.
//!
//! **Timing and retention, outside**: `File<C>` (parse at load, hold
//! the value), `Valid<File<C>>` (prove at tier-1, hold the path), and
//! `Unchecked<File<C>>` (defer everything). Plus recursive composition
//! of `folder!` modules, in any direction.

use serde::Deserialize;
use tento_folder::formats::{Json, Toml, Yaml};
use tento_folder::{ContentSource, FileContent, FolderError, folder};

#[derive(Debug, Deserialize, PartialEq)]
struct AppConfig {
  name: String,
  port: u16,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Limits {
  max: u32,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Route {
  path: String,
}

/// A **custom filetype**: a bespoke `key=value` encoding with no serde
/// and no format crate behind it. This is what a bare `File<T>` slot
/// means — the blanket impls live on the markers, never on `T`, so
/// `File<VersionFile>` unambiguously routes here.
#[derive(Debug, PartialEq)]
struct VersionFile {
  version: String,
}

impl FileContent for VersionFile {
  // Associated-type defaults are unstable, so a custom filetype spells
  // out that it produces itself.
  type Value = Self;

  fn parse(bytes: &[u8]) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
    let text = std::str::from_utf8(bytes).map_err(|source| format!("not UTF-8: {source}"))?;
    let version = text
      .lines()
      .find_map(|line| line.trim().strip_prefix("version="))
      .ok_or("well-formed text, but no `version=` line")?;
    Ok(Self {
      version: version.trim().to_string(),
    })
  }
}

folder!(typed_test, {
  "config.json":   File<Json<AppConfig>>,
  "limits.toml"?:  File<Toml<Limits>>,
  "limits.yaml"?:  File<Yaml<Limits>>,
  "app.version":   File<VersionFile>,
  "raw.json":      Valid<File<Json>>,
  "VERSION":       File::Text,
  "*.route.json":  Glob<File<Json<Route>>>,
});

// ── Recursive composition ────────────────────────────────────────────────
// A typed leaf, referenced by parents that are themselves typed or not, by
// exact name or by glob. Every generated constructor is fallible, so all four
// directions compose.

folder!(typed_leaf, {
  "config.json": File<Json<AppConfig>>,
});

folder!(untyped_parent, {
  "VERSION": File::Text,
  "leaf": typed_leaf::Folder,
});

folder!(untyped_glob_parent, {
  "*.leaf": Glob<typed_leaf::Folder>,
});

folder!(typed_parent, {
  "config.json": File<Json<AppConfig>>,
  "leaf": typed_leaf::Folder,
});

// ── Explicitly deferred entries ──────────────────────────────────────────
// Everything `Unchecked<…>` here is existence-checked and nothing more; the
// schema is the documentation of what `load` does NOT prove.

folder!(deferred_parent, {
  "VERSION":     File::Text,
  "big.json":    Unchecked<File<Json<AppConfig>>>,
  "extra.json"?: Unchecked<File<Json<AppConfig>>>,
  "leaf":        Unchecked<typed_leaf::Folder>,
  "*.run":       Glob<Unchecked<typed_leaf::Folder>>,
});

// ── Proven-but-not-held entries ──────────────────────────────────────────
// Everything `Valid<…>` here is proven during tier-1 validation and then
// dropped: the field is a path, and `load` still guarantees the content.

folder!(valid_parent, {
  "VERSION":      File::Text,
  "raw.json":     Valid<File<Json>>,
  "config.json":  Valid<File<Json<AppConfig>>>,
  "extra.json"?:  Valid<File<Json<AppConfig>>>,
  "leaf":         Valid<typed_leaf::Folder>,
  "*.probe.json": Glob<Valid<File<Json<Route>>>>,
  "*.run":        Glob<Valid<typed_leaf::Folder>>,
});

fn temp_dir(name: &str) -> std::path::PathBuf {
  let dir = std::env::temp_dir().join(format!("tento_folder_typed_{name}"));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

const VALID_CONFIG: &str = r#"{ "name": "coffee", "port": 8080 }"#;

/// Write the minimum required entries; callers override individual
/// files before loading.
fn write_valid(dir: &std::path::Path) {
  std::fs::write(dir.join("config.json"), VALID_CONFIG).unwrap();
  std::fs::write(dir.join("raw.json"), r#"{ "anything": [1, 2] }"#).unwrap();
  std::fs::write(dir.join("app.version"), "version=1.2.3\n").unwrap();
  std::fs::write(dir.join("VERSION"), "1.2.3\n").unwrap();
}

/// A `typed_leaf::Folder` on disk at `dir`, with the given `config.json` body.
fn write_leaf(dir: &std::path::Path, config: &str) {
  std::fs::create_dir_all(dir).unwrap();
  std::fs::write(dir.join("config.json"), config).unwrap();
}

#[test]
fn typed_entry_caches_parsed_value() {
  let dir = temp_dir("value");
  write_valid(&dir);

  let f = typed_test::Folder::load(&dir).unwrap();
  assert_eq!(
    f.config_json.value(),
    &AppConfig {
      name: "coffee".to_string(),
      port: 8080,
    },
  );
  assert_eq!(f.config_json.path(), dir.join("config.json"));

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_custom_filetype_needs_no_format_crate() {
  let dir = temp_dir("custom");
  write_valid(&dir);

  // `File<VersionFile>` — bare `T`, so `VersionFile`'s own
  // `FileContent` impl is the parse. No marker, no serde.
  let f = typed_test::Folder::load(&dir).unwrap();
  assert_eq!(f.app_version.value().version, "1.2.3");

  std::fs::write(dir.join("app.version"), "nothing useful here\n").unwrap();
  match typed_test::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("app.version"));
      assert!(
        source.to_string().contains("no `version=` line"),
        "expected the filetype's own message, got {source}",
      );
    }
    other => panic!("expected Shape, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_json_marker_distinguishes_malformed_from_wrong_shape() {
  let dir = temp_dir("marker_errors");
  write_valid(&dir);

  // Phase 1 — not JSON at all.
  std::fs::write(dir.join("config.json"), "{ not json").unwrap();
  match typed_test::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("config.json"));
      let message = source.to_string();
      assert!(
        message.contains("malformed JSON"),
        "expected the syntax phase, got {message}",
      );
    }
    other => panic!("expected Shape, got {other:?}"),
  }

  // Phase 2 — well-formed JSON, wrong shape. `port` is missing and
  // `name` is a number.
  std::fs::write(dir.join("config.json"), r#"{ "name": 7 }"#).unwrap();
  match typed_test::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("config.json"));
      let message = source.to_string();
      assert!(
        message.contains("well-formed JSON, but not a") && message.contains("AppConfig"),
        "expected the shape phase naming the type, got {message}",
      );
    }
    other => panic!("expected Shape, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn optional_typed_entry_absent_is_none() {
  let dir = temp_dir("opt_none");
  write_valid(&dir);

  let f = typed_test::Folder::load(&dir).unwrap();
  assert!(f.limits_toml.is_none());
  assert!(f.limits_yaml.is_none());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn markers_of_different_formats_live_in_one_schema() {
  let dir = temp_dir("opt_some");
  write_valid(&dir);
  std::fs::write(dir.join("limits.toml"), "max = 42\n").unwrap();
  std::fs::write(dir.join("limits.yaml"), "max: 7\n").unwrap();

  // JSON, TOML, YAML and a bespoke encoding, side by side. The
  // encoding is a name inside the slot; the folder primitive is none
  // the wiser.
  let f = typed_test::Folder::load(&dir).unwrap();
  assert_eq!(
    f.limits_toml.expect("toml present").value(),
    &Limits { max: 42 }
  );
  assert_eq!(
    f.limits_yaml.expect("yaml present").value(),
    &Limits { max: 7 }
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn optional_typed_entry_present_but_rejected_errors() {
  let dir = temp_dir("opt_shape");
  write_valid(&dir);
  std::fs::write(dir.join("limits.toml"), "max = \"lots\"\n").unwrap();

  match typed_test::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("limits.toml"));
      let message = source.to_string();
      assert!(
        message.contains("well-formed TOML, but not a") && message.contains("Limits"),
        "expected the TOML marker's shape message, got {message}",
      );
    }
    other => panic!("expected Shape, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_yaml_marker_reports_its_own_syntax_failure() {
  let dir = temp_dir("yaml_malformed");
  write_valid(&dir);
  std::fs::write(dir.join("limits.yaml"), "max: [unterminated\n").unwrap();

  match typed_test::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("limits.yaml"));
      assert!(
        source.to_string().contains("malformed YAML"),
        "expected the YAML marker's syntax message, got {source}",
      );
    }
    other => panic!("expected Shape, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn typed_glob_entries_parse_each_match() {
  let dir = temp_dir("glob");
  write_valid(&dir);
  std::fs::write(dir.join("a.route.json"), r#"{ "path": "/a" }"#).unwrap();
  std::fs::write(dir.join("b.route.json"), r#"{ "path": "/b" }"#).unwrap();

  let f = typed_test::Folder::load(&dir).unwrap();
  let mut routes: Vec<(String, String)> = f
    .route_json
    .iter()
    .map(|(name, route)| (name.clone(), route.value().path.clone()))
    .collect();
  routes.sort();
  assert_eq!(
    routes,
    vec![
      ("a.route.json".to_string(), "/a".to_string()),
      ("b.route.json".to_string(), "/b".to_string()),
    ],
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn typed_glob_match_with_wrong_shape_errors() {
  let dir = temp_dir("glob_shape");
  write_valid(&dir);
  std::fs::write(dir.join("a.route.json"), r#"{ "route": "/a" }"#).unwrap();

  let err = typed_test::Folder::load(&dir).unwrap_err();
  assert!(
    matches!(err, FolderError::Shape { .. }),
    "expected Shape, got {err:?}",
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn schema_entry_for_an_eager_typed_file_is_structural_only() {
  // An eager typed entry contributes an `Opaque` file entry with NO
  // check hook: presence + is-a-file. Its content contract runs at
  // handle construction instead.
  let entry = typed_test::SCHEMA
    .entries()
    .iter()
    .find(|e| e.name == "config.json")
    .expect("config.json entry");
  assert!(matches!(
    entry.kind,
    tento_folder::SchemaKind::File(tento_folder::FileType::Opaque)
  ));
  assert!(entry.check.is_none(), "eager entries carry no tier-1 hook");
  assert!(!entry.optional);

  // …and validation therefore passes even on bytes the shape rejects —
  // not just the wrong shape, but bytes that are not JSON at all.
  let dir = temp_dir("schema_only");
  write_valid(&dir);
  std::fs::write(dir.join("config.json"), "{ not json").unwrap();
  typed_test::Folder::validate(&dir).expect("structural validation ignores eager content");
  assert!(typed_test::Folder::load(&dir).is_err());

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn builder_writes_typed_entries() {
  let dir = temp_dir("builder");
  let _ = std::fs::remove_dir_all(&dir);

  typed_test::Folder::builder()
    .config_json(ContentSource::write_str(
      r#"{ "name": "built", "port": 1 }"#,
    ))
    .limits_toml(ContentSource::write_str("max = 3\n"))
    .app_version(ContentSource::write_str("version=9.9.9\n"))
    .raw_json(ContentSource::write_str("[]"))
    .VERSION(ContentSource::write_str("0.0.1"))
    .build_at(&dir)
    .unwrap();

  let f = typed_test::Folder::load(&dir).unwrap();
  assert_eq!(f.config_json.value().name, "built");
  assert_eq!(
    f.limits_toml.map(|l| l.into_value()),
    Some(Limits { max: 3 })
  );
  assert_eq!(f.app_version.into_value().version, "9.9.9");

  std::fs::remove_dir_all(&dir).unwrap();
}

// ── Recursion ────────────────────────────────────────────────────────────

#[test]
fn untyped_schema_references_typed_schema_by_exact_name() {
  let dir = temp_dir("rec_exact");
  std::fs::write(dir.join("VERSION"), "1.0.0\n").unwrap();
  write_leaf(&dir.join("leaf"), VALID_CONFIG);

  let f = untyped_parent::Folder::load(&dir).unwrap();
  assert_eq!(f.leaf.config_json.value().port, 8080);
  assert_eq!(f.VERSION.read_to_string().unwrap(), "1.0.0\n");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn untyped_schema_globs_over_a_typed_schema() {
  let dir = temp_dir("rec_glob");
  write_leaf(&dir.join("a.leaf"), VALID_CONFIG);
  write_leaf(&dir.join("b.leaf"), r#"{ "name": "tea", "port": 9090 }"#);
  // A non-matching child is ignored by the glob.
  std::fs::create_dir_all(dir.join("notes")).unwrap();

  let f = untyped_glob_parent::Folder::load(&dir).unwrap();
  let mut got: Vec<(String, u16)> = f
    .leaf
    .iter()
    .map(|(name, leaf)| (name.clone(), leaf.config_json.value().port))
    .collect();
  got.sort();
  assert_eq!(
    got,
    vec![("a.leaf".to_string(), 8080), ("b.leaf".to_string(), 9090)],
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn typed_schema_references_typed_schema() {
  let dir = temp_dir("rec_typed");
  std::fs::write(dir.join("config.json"), VALID_CONFIG).unwrap();
  write_leaf(&dir.join("leaf"), r#"{ "name": "tea", "port": 9090 }"#);

  let f = typed_parent::Folder::load(&dir).unwrap();
  assert_eq!(f.config_json.value().port, 8080);
  assert_eq!(f.leaf.config_json.value().port, 9090);

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_typed_childs_shape_error_surfaces_through_the_parents_load() {
  let dir = temp_dir("rec_child_err");
  std::fs::write(dir.join("VERSION"), "1.0.0\n").unwrap();
  write_leaf(&dir.join("leaf"), r#"{ "name": 7 }"#);

  // Tier-1 sees only structure, so the parent validates…
  untyped_parent::Folder::validate(&dir).expect("structure is fine");
  // …and the child's content contract fails the parent's load, naming the
  // child's file.
  let err = untyped_parent::Folder::load(&dir).unwrap_err();
  match &err {
    FolderError::Shape { path, .. } => {
      assert_eq!(path, &dir.join("leaf").join("config.json"));
    }
    other => panic!("expected Shape from the child, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn load_unchecked_is_fallible_for_every_schema() {
  let dir = temp_dir("rec_unchecked");
  std::fs::write(dir.join("VERSION"), "1.0.0\n").unwrap();
  write_leaf(&dir.join("leaf"), VALID_CONFIG);

  // The typed-free-looking parent's constructor returns Result too — that
  // uniformity is what makes the composition above compile.
  let f = untyped_parent::Folder::load_unchecked(&dir).unwrap();
  assert_eq!(f.leaf.config_json.value().name, "coffee");

  std::fs::write(dir.join("leaf").join("config.json"), r#"{ "name": 7 }"#).unwrap();
  assert!(matches!(
    untyped_parent::Folder::load_unchecked(&dir),
    Err(FolderError::Shape { .. })
  ));

  std::fs::remove_dir_all(&dir).unwrap();
}

// ── Unchecked<…>: explicit deferral ──────────────────────────────────────

/// A `deferred_parent::Folder` on disk: required entries present, every
/// deferred payload deliberately *invalid*, plus two `*.run` children (one
/// good, one bad) and no optional `extra.json`.
fn write_deferred(dir: &std::path::Path) {
  std::fs::write(dir.join("VERSION"), "1.0.0\n").unwrap();
  std::fs::write(dir.join("big.json"), r#"{ "name": 7 }"#).unwrap();
  write_leaf(&dir.join("leaf"), r#"{ "name": 7 }"#);
  write_leaf(&dir.join("good.run"), VALID_CONFIG);
  write_leaf(&dir.join("bad.run"), "{ not json");
}

#[test]
fn deferred_entries_are_not_read_at_load() {
  let dir = temp_dir("def_load");
  write_deferred(&dir);

  // Every deferred payload on disk is invalid, and load still succeeds —
  // that is the contract: `load` proves everything NOT marked Unchecked.
  deferred_parent::Folder::validate(&dir).expect("existence-only tier 1");
  let f = deferred_parent::Folder::load(&dir).expect("deferred content is not read");

  assert_eq!(f.big_json.path(), dir.join("big.json"));
  assert_eq!(f.leaf.path(), dir.join("leaf"));
  assert!(
    f.extra_json.is_none(),
    "absent optional deferred entry is None"
  );
  assert_eq!(f.run.len(), 2, "the glob enumerated without walking");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn checking_a_deferred_file_reports_shape_with_its_path() {
  let dir = temp_dir("def_file");
  write_deferred(&dir);
  let f = deferred_parent::Folder::load(&dir).unwrap();

  match f.big_json.check() {
    Err(FolderError::Shape { path, .. }) => assert_eq!(path, dir.join("big.json")),
    other => panic!("expected Shape, got {:?}", other.map(|_| ())),
  }

  // Fix the bytes and the same handle checks clean — and `.read()` is the
  // sugar for check-then-take.
  std::fs::write(dir.join("big.json"), VALID_CONFIG).unwrap();
  assert_eq!(f.big_json.check().unwrap().value().port, 8080);
  assert_eq!(
    f.big_json.read().unwrap(),
    AppConfig {
      name: "coffee".to_string(),
      port: 8080,
    }
  );

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn optional_deferred_entry_present_is_some_and_checks() {
  let dir = temp_dir("def_opt");
  write_deferred(&dir);
  std::fs::write(dir.join("extra.json"), VALID_CONFIG).unwrap();

  let f = deferred_parent::Folder::load(&dir).unwrap();
  let extra = f
    .extra_json
    .as_ref()
    .expect("present optional deferred entry");
  assert_eq!(extra.path(), dir.join("extra.json"));
  assert_eq!(extra.read().unwrap().name, "coffee");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn checking_a_deferred_folder_runs_the_childs_own_load() {
  let dir = temp_dir("def_folder");
  write_deferred(&dir);
  let f = deferred_parent::Folder::load(&dir).unwrap();

  // The child's error names the child's file — `.check()` ran
  // `typed_leaf::Folder::load`, not some shallower check.
  match f.leaf.check() {
    Err(FolderError::Shape { path, .. }) => {
      assert_eq!(path, dir.join("leaf").join("config.json"));
    }
    other => panic!("expected the child's Shape, got {:?}", other.map(|_| ())),
  }

  // A deferred child missing its required file fails as Missing, from the
  // child's tier-1 walk.
  std::fs::remove_file(dir.join("leaf").join("config.json")).unwrap();
  assert!(matches!(f.leaf.check(), Err(FolderError::Missing { .. })));

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn one_bad_child_in_a_deferred_glob_does_not_poison_its_siblings() {
  let dir = temp_dir("def_glob");
  write_deferred(&dir);

  let f = deferred_parent::Folder::load(&dir).expect("bad child does not fail load");
  let mut names: Vec<&str> = f.run.iter().map(|(name, _)| name.as_str()).collect();
  names.sort();
  assert_eq!(names, vec!["bad.run", "good.run"]);

  for (name, handle) in &f.run {
    let checked = handle.check();
    match name.as_str() {
      "good.run" => assert_eq!(checked.unwrap().config_json.value().port, 8080),
      "bad.run" => match checked {
        Err(FolderError::Shape { path, .. }) => {
          assert_eq!(path, dir.join("bad.run").join("config.json"));
        }
        other => panic!("expected Shape for bad.run, got {:?}", other.map(|_| ())),
      },
      other => panic!("unexpected glob match {other}"),
    }
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn deferred_entries_are_existence_checked_and_nothing_more() {
  // Present-but-invalid passes tier 1 (asserted above); absent does not.
  let dir = temp_dir("def_missing");
  write_deferred(&dir);
  std::fs::remove_file(dir.join("big.json")).unwrap();
  let err = deferred_parent::Folder::validate(&dir).unwrap_err();
  let missing = err.missing_paths();
  assert!(
    missing.contains(&dir.join("big.json").as_path()),
    "expected big.json in {err:?}",
  );

  // The schema entries themselves say "structural only": an Opaque file and
  // a plain folder, NOT a folder_ref into the child schema, and no hook.
  let entries = deferred_parent::SCHEMA.entries();
  let big = entries.iter().find(|e| e.name == "big.json").unwrap();
  assert!(matches!(
    big.kind,
    tento_folder::SchemaKind::File(tento_folder::FileType::Opaque)
  ));
  assert!(big.check.is_none(), "deferred entries carry no tier-1 hook");
  let leaf = entries.iter().find(|e| e.name == "leaf").unwrap();
  assert!(matches!(leaf.kind, tento_folder::SchemaKind::Folder));
  assert!(leaf.check.is_none());

  std::fs::remove_dir_all(&dir).unwrap();
}

// ── Valid<…>: proven at load, not held ───────────────────────────────────

/// A `valid_parent::Folder` on disk with every entry valid, plus two
/// `*.run` children.
fn write_valid_parent(dir: &std::path::Path) {
  std::fs::write(dir.join("VERSION"), "1.0.0\n").unwrap();
  std::fs::write(dir.join("raw.json"), r#"{ "anything": [1, 2] }"#).unwrap();
  std::fs::write(dir.join("config.json"), VALID_CONFIG).unwrap();
  std::fs::write(dir.join("a.probe.json"), r#"{ "path": "/a" }"#).unwrap();
  write_leaf(&dir.join("leaf"), VALID_CONFIG);
  write_leaf(&dir.join("one.run"), VALID_CONFIG);
  write_leaf(&dir.join("two.run"), r#"{ "name": "tea", "port": 9090 }"#);
}

#[test]
fn valid_entries_prove_content_at_load_and_hold_only_a_path() {
  let dir = temp_dir("valid_ok");
  write_valid_parent(&dir);

  let f = valid_parent::Folder::load(&dir).expect("everything proves");
  assert_eq!(f.config_json.path(), dir.join("config.json"));
  assert!(f.extra_json.is_none());

  // The handle carries a path and nothing else — no cached value.
  assert_eq!(
    std::mem::size_of_val(&f.config_json),
    std::mem::size_of::<std::path::PathBuf>(),
  );

  // Producing the value is therefore fallible sugar over a re-read.
  assert_eq!(
    f.config_json.read().unwrap(),
    AppConfig {
      name: "coffee".to_string(),
      port: 8080,
    }
  );
  assert_eq!(f.raw_json.read().unwrap()["anything"][1], 2);
  assert_eq!(f.leaf.check().unwrap().config_json.value().port, 8080);

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_valid_file_with_bad_content_fails_load_and_validate() {
  let dir = temp_dir("valid_bad_file");
  write_valid_parent(&dir);
  std::fs::write(dir.join("config.json"), r#"{ "name": 7 }"#).unwrap();

  // The proof runs in TIER 1 — so standalone `validate` catches it, which
  // is exactly what an eager `File<C>` entry does NOT do.
  match valid_parent::Folder::validate(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("config.json"));
      assert!(source.to_string().contains("well-formed JSON, but not a"));
    }
    other => panic!("expected Shape from tier 1, got {other:?}"),
  }
  assert!(valid_parent::Folder::load(&dir).is_err());

  // And the bare marker catches non-JSON in the same place.
  write_valid_parent(&dir);
  std::fs::write(dir.join("raw.json"), "{ not json").unwrap();
  match valid_parent::Folder::validate(&dir).unwrap_err() {
    FolderError::Shape { path, source } => {
      assert_eq!(path, dir.join("raw.json"));
      assert!(source.to_string().contains("malformed JSON"));
    }
    other => panic!("expected Shape from tier 1, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_valid_folder_ref_runs_the_childs_whole_load_in_tier_1() {
  let dir = temp_dir("valid_bad_child");
  write_valid_parent(&dir);
  write_leaf(&dir.join("leaf"), r#"{ "name": 7 }"#);

  // The child's failure names the child's file, from the PARENT's load.
  match valid_parent::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, .. } => {
      assert_eq!(path, dir.join("leaf").join("config.json"));
    }
    other => panic!("expected the child's Shape, got {other:?}"),
  }

  // Fixed, the handle re-loads the child on demand.
  write_leaf(&dir.join("leaf"), VALID_CONFIG);
  let f = valid_parent::Folder::load(&dir).unwrap();
  assert_eq!(f.leaf.check().unwrap().config_json.value().name, "coffee");

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_valid_file_glob_proves_every_match() {
  let dir = temp_dir("valid_file_glob");
  write_valid_parent(&dir);
  std::fs::write(dir.join("b.probe.json"), r#"{ "path": "/b" }"#).unwrap();

  let f = valid_parent::Folder::load(&dir).unwrap();
  let mut probes: Vec<(String, String)> = f
    .probe_json
    .iter()
    .map(|(name, handle)| (name.clone(), handle.read().unwrap().path))
    .collect();
  probes.sort();
  assert_eq!(
    probes,
    vec![
      ("a.probe.json".to_string(), "/a".to_string()),
      ("b.probe.json".to_string(), "/b".to_string()),
    ]
  );

  // The hook runs per match, in tier 1: one bad match fails `validate`.
  std::fs::write(dir.join("b.probe.json"), r#"{ "route": "/b" }"#).unwrap();
  match valid_parent::Folder::validate(&dir).unwrap_err() {
    FolderError::Shape { path, .. } => assert_eq!(path, dir.join("b.probe.json")),
    other => panic!("expected Shape from the bad match, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_valid_glob_proves_every_match() {
  let dir = temp_dir("valid_glob");
  write_valid_parent(&dir);

  let f = valid_parent::Folder::load(&dir).unwrap();
  let mut names: Vec<&str> = f.run.iter().map(|(name, _)| name.as_str()).collect();
  names.sort();
  assert_eq!(names, vec!["one.run", "two.run"]);

  // Unlike a deferred glob, ONE bad match fails the parent's load: `Valid`
  // is a promise the whole glob keeps.
  write_leaf(&dir.join("two.run"), "{ not json");
  match valid_parent::Folder::load(&dir).unwrap_err() {
    FolderError::Shape { path, .. } => {
      assert_eq!(path, dir.join("two.run").join("config.json"));
    }
    other => panic!("expected Shape from the bad match, got {other:?}"),
  }

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn optional_valid_entry_is_proven_only_when_present() {
  let dir = temp_dir("valid_opt");
  write_valid_parent(&dir);

  // Absent: no proof, no error.
  valid_parent::Folder::validate(&dir).expect("absent optional is fine");

  // Present and bad: proven, and rejected.
  std::fs::write(dir.join("extra.json"), r#"{ "name": 7 }"#).unwrap();
  assert!(matches!(
    valid_parent::Folder::validate(&dir),
    Err(FolderError::Shape { .. })
  ));

  // Present and good: `Some`, path-only, readable.
  std::fs::write(dir.join("extra.json"), VALID_CONFIG).unwrap();
  let f = valid_parent::Folder::load(&dir).unwrap();
  let extra = f.extra_json.as_ref().expect("present optional");
  assert_eq!(extra.path(), dir.join("extra.json"));
  assert_eq!(extra.read().unwrap().port, 8080);

  std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn valid_schema_entries_carry_a_tier_1_hook() {
  let entries = valid_parent::SCHEMA.entries();

  // A `Valid<File<C>>` entry is an Opaque file WITH a hook — that hook is
  // the whole difference from the eager and deferred forms.
  let config = entries.iter().find(|e| e.name == "config.json").unwrap();
  assert!(matches!(
    config.kind,
    tento_folder::SchemaKind::File(tento_folder::FileType::Opaque)
  ));
  assert!(config.check.is_some());

  // A `Valid<mod::Folder>` entry is a plain folder plus the hook —
  // deliberately not a `FolderRef`, since the hook already runs the
  // child's whole `load`; walking the child schema too would double the
  // work.
  let leaf = entries.iter().find(|e| e.name == "leaf").unwrap();
  assert!(matches!(leaf.kind, tento_folder::SchemaKind::Folder));
  assert!(leaf.check.is_some());

  // Globs get one hook, applied per match — file globs and folder globs
  // alike.
  let run = entries.iter().find(|e| e.name == "*.run").unwrap();
  assert!(matches!(
    run.kind,
    tento_folder::SchemaKind::FolderGlob { .. }
  ));
  assert!(run.check.is_some());

  let probe = entries.iter().find(|e| e.name == "*.probe.json").unwrap();
  assert!(matches!(
    probe.kind,
    tento_folder::SchemaKind::FileGlob {
      file_type: tento_folder::FileType::Opaque,
      ..
    }
  ));
  assert!(probe.check.is_some());

  // Untyped kinds never carry one.
  let version = entries.iter().find(|e| e.name == "VERSION").unwrap();
  assert!(version.check.is_none());
}
