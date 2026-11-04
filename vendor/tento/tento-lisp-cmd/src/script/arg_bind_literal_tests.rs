use super::*;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize, PartialEq)]
struct Declared {
  path: String,
  lang: String,
  #[serde(default)]
  dry_run: bool,
}

impl CommandArg for Declared {
  fn display_help() -> Vec<String> {
    vec!["path".into(), "--lang".into(), "--dry-run".into()]
  }
  fn arg_schema() -> ArgSchema {
    ArgSchema {
      positionals: vec!["path".into()],
      variadic: None,
      named: vec![
        crate::command_arg::NamedField { name: "lang".into(), is_flag: false },
        crate::command_arg::NamedField { name: "dry_run".into(), is_flag: true },
      ],
    }
  }
}

fn strings(words: &[&str]) -> Vec<LispValue<Sym>> {
  words.iter().map(|s| LispValue::String((*s).into())).collect()
}

#[test]
fn declared_schema_accepts_literal_equals_options() {
  // This exercises the declared-schema path, unlike highlight's argv vector.
  let got: Declared = lisp_args_to_typed("probe", strings(&["file", "--lang=rust", "--dry-run"])).unwrap();
  assert_eq!(got, Declared { path: "file".into(), lang: "rust".into(), dry_run: true });
}

#[test]
fn native_schema_binds_both_spellings_and_terminates() {
  for words in [
    vec!["--lang=rust", "--dry-run", "file"],
    vec!["--lang", "rust", "--dry-run", "file"],
    vec![":lang", "rust", ":dry-run", "file"],
    vec!["--lang=rust", "--dry-run", "--", "--help"],
  ] {
    let expected = Declared { path: words.last().unwrap().to_string(), lang: "rust".into(), dry_run: true };
    assert_eq!(lisp_args_to_typed::<Declared>("probe", strings(&words)).unwrap(), expected);
    let mut argv = vec!["probe".into()];
    argv.extend(words.iter().map(|s| s.to_string()));
    assert_eq!(parse_arguments::<Declared>(argv).unwrap(), expected);
  }
  assert!(lisp_args_to_typed::<Declared>("probe", strings(&["file", "--lang=rust", "--unknown"])).is_err());
  assert_eq!(lisp_args_to_bind_doc(strings(&["file", "--lang=rust-lang", "--dry-run=false"]), &Declared::arg_schema()).unwrap().0,
    json!({"path":"file", "lang":"rust-lang", "dry_run":false}));
}

#[test]
fn external_lowering_preserves_spelling_and_argument_boundaries() {
  assert_eq!(lisp_args_to_argv("git", strings(&[":multi-word-flag", "x", ":flag", "next", "--k=v", "--json", "--help", "--", ":after"])),
    vec!["git", "--multi-word-flag", "x", "--flag", "next", "--k=v", "--json", "--help", "--", "--after"]);
}

#[test]
fn schema_free_map_keeps_option_values_verbatim() {
  #[derive(Debug, Deserialize, PartialEq)]
  struct Legacy { multi_word: String }
  impl CommandArg for Legacy {
    fn display_help() -> Vec<String> { vec!["--multi-word".into()] }
  }
  for words in [vec!["--multi-word=rust-lang"], vec!["--multi-word", "rust-lang"], vec![":multi-word", "rust-lang"]] {
    assert_eq!(lisp_args_to_typed::<Legacy>("probe", strings(&words)).unwrap(), Legacy { multi_word: "rust-lang".into() });
  }
}

#[test]
fn declared_numeric_options_bind_equals_and_separated_values() {
  #[derive(Debug, Deserialize, PartialEq)]
  struct Count { count: i64 }
  impl CommandArg for Count {
    fn display_help() -> Vec<String> { vec!["--count".into()] }
    fn arg_schema() -> ArgSchema {
      ArgSchema { positionals: vec![], variadic: None,
        named: vec![crate::command_arg::NamedField { name: "count".into(), is_flag: false }] }
    }
  }
  for words in [vec!["--count=1"], vec!["--count", "1"], vec![":count", "1"]] {
    let mut argv = vec!["probe".into()];
    argv.extend(words.iter().map(|s| s.to_string()));
    assert_eq!(parse_arguments::<Count>(argv).unwrap(), Count { count: 1 });
  }
  for words in [vec!["--count=1"], vec!["--count", "1"]] {
    assert_eq!(lisp_args_to_typed::<Count>("probe", strings(&words)).unwrap(), Count { count: 1 });
  }
  assert_eq!(lisp_args_to_typed::<Count>("probe", vec![LispValue::String(":count".into()), LispValue::Integer(1)]).unwrap(), Count { count: 1 });
}
