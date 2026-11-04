//! `#[arg(positional | rest | short | default)]`: a struct that declares its
//! binding. Legacy structs (no `#[arg]`) are covered in `tests` beside this.

use serde::Deserialize;
use serde_json::json;

use super::*;
use crate::reflect::OptionKind;
use crate::script::{LispValue, lisp_args_to_typed};

#[derive(Debug, PartialEq, Deserialize, crate::CommandArg)]
struct CopyArgs {
  /// Source path.
  #[arg(positional)]
  src: String,
  #[arg(positional)]
  dest: String,
  #[arg(short = 'n')]
  dry_run: bool,
  #[arg(short = 'v')]
  verbose: bool,
  #[arg(short = 'c', default = 3)]
  count: u64,
  #[arg(default = "plain")]
  mode: String,
  #[arg(rest)]
  extra: Vec<String>,
  #[tento_sh(help = "the label")]
  label: Option<String>,
}

fn copy(words: &[&str]) -> crate::Result<CopyArgs> {
  let mut argv = vec!["cp".to_string()];
  argv.extend(words.iter().map(|w| w.to_string()));
  parse_arguments::<CopyArgs>(argv)
}

fn expected() -> CopyArgs {
  CopyArgs {
    src: "a".into(),
    dest: "b".into(),
    dry_run: false,
    verbose: false,
    count: 3,
    mode: "plain".into(),
    extra: vec![],
    label: None,
  }
}

#[test]
fn positionals_bind_in_order_and_defaults_fill_omitted_fields() {
  assert_eq!(copy(&["a", "b"]).unwrap(), expected());
}

#[test]
fn shorts_bind_like_their_long_names() {
  let want = CopyArgs {
    dry_run: true,
    count: 5,
    extra: vec!["x".into(), "y".into()],
    ..expected()
  };
  assert_eq!(copy(&["-n", "a", "b", "-c", "5", "x", "y"]).unwrap(), want);
  assert_eq!(
    copy(&["--dry-run", "a", "--count", "5", "b", "x", "y"]).unwrap(),
    want
  );
  // A bundle of declared shorts expands letter by letter.
  let bundled = copy(&["-nv", "a", "b"]).unwrap();
  assert!(bundled.dry_run && bundled.verbose);
  // An undeclared letter or anything after `--` stays a word.
  assert_eq!(
    copy(&["a", "b", "--", "-n"]).unwrap().extra,
    vec!["-n".to_string()]
  );
  assert!(
    copy(&["-z", "a", "b"])
      .unwrap()
      .extra
      .contains(&"b".to_string())
  );
}

#[test]
fn explicit_values_override_defaults() {
  let got = copy(&["a", "b", "--mode", "fast", "--label", "L"]).unwrap();
  assert_eq!(got.mode, "fast");
  assert_eq!(got.label.as_deref(), Some("L"));
  assert!(
    copy(&["a", "b", "--nope"]).is_err(),
    "declared schemas refuse unknown flags"
  );
}

#[test]
fn lisp_callers_get_the_same_defaults() {
  let args = vec![
    LispValue::String("a".into()),
    LispValue::String("b".into()),
    LispValue::String(":dry-run".into()),
  ];
  let got: CopyArgs = lisp_args_to_typed("cp", args).unwrap();
  assert_eq!(
    got,
    CopyArgs {
      dry_run: true,
      ..expected()
    }
  );
}

#[test]
fn declared_schema_and_docs_describe_binding() {
  let schema = CopyArgs::arg_schema();
  assert_eq!(schema.positionals, ["src", "dest"]);
  assert_eq!(schema.variadic.as_deref(), Some("extra"));
  assert!(schema.is_flag("dry_run") && !schema.is_flag("count"));
  assert_eq!(
    CopyArgs::arg_shorts(),
    [('n', "dry_run"), ('v', "verbose"), ('c', "count")]
  );

  let docs = CopyArgs::arg_docs();
  let kinds: Vec<OptionKind> = docs.iter().map(|d| d.kind).collect();
  use OptionKind::*;
  assert_eq!(
    kinds,
    [
      Positional, Positional, Flag, Flag, Named, Named, Variadic, Named
    ]
  );
  assert_eq!(docs[0].help.as_deref(), Some("Source path."));
  assert_eq!(docs[2].short, Some('n'));
  assert_eq!(docs[4].default, Some(json!(3)));
  assert_eq!(docs[5].default, Some(json!("plain")));
  assert_eq!(
    docs[2].default, None,
    "the implicit false of a flag is not documented"
  );
  assert_eq!(docs[4].schema, Some(crate::schema::TypeDesc::U64));
  assert_eq!(
    docs[7].help.as_deref(),
    Some("the label"),
    "tento_sh(help) still wins"
  );
  let wire = serde_json::to_value(&docs[4]).unwrap();
  assert_eq!(
    wire,
    json!({"name": "count", "kind": "named", "type": "u64", "short": "c", "default": 3, "schema": {"kind": "u64"}})
  );
}

#[test]
fn declared_and_schema_derives_compose_on_one_struct() {
  #[derive(Debug, Deserialize, serde::Serialize, crate::CommandArg, crate::schema::Schema)]
  struct Both {
    #[arg(positional)]
    #[view(header = "PATH")]
    path: String,
  }
  use crate::schema::Schema as _;
  let parsed: Both = parse_arguments(vec!["x".into(), "p".into()]).unwrap();
  assert_eq!(parsed.path, "p");
  assert_eq!(
    Both::schema().record_fields().unwrap()[0]
      .view
      .header
      .as_deref(),
    Some("PATH")
  );
}
