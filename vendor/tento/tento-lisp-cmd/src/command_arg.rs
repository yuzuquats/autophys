use crate::error::Error;
use serde::de;
use uuid::Uuid;

pub trait CommandArg {
  fn display_help() -> Vec<String>;
  /// A schema-free argv vector owns every word, including flags. Its command
  /// body decides what those words mean; the generic binder must not drop them.
  fn positional_argv() -> bool {
    false
  }
  /// The ordered parameter schema for the unified arg-binding calculus (the
  /// positionals/variadic/named a call binds against). Default is **empty** —
  /// which preserves the legacy scalar/array/named shaping in
  /// [`parse_arguments`]. `#[derive(CommandArg)]` overrides this for structs
  /// whose fields opt into positional/variadic binding.
  fn arg_schema() -> ArgSchema {
    ArgSchema::empty()
  }
  /// The structured per-option documentation (name/kind/type/help), the
  /// reflection twin of [`display_help`]. Default is **empty**;
  /// `#[derive(CommandArg)]` fills it from the arg struct's fields. Feeds
  /// `CommandMetadata::doc()`'s `command.doc/v1` `options`.
  fn arg_docs() -> Vec<crate::reflect::OptionDoc> {
    Vec::new()
  }
  /// Declared single-letter aliases (`#[arg(short = 'x')]` → `('x', "field")`).
  /// An argv word `-x` (or a bundle `-xy` of declared shorts) binds as
  /// `--field`. Default **empty**: no word is rewritten.
  fn arg_shorts() -> Vec<(char, &'static str)> {
    Vec::new()
  }
  /// Values bound for fields the call omits (`#[arg(default = …)]`, plus
  /// `false` for a declared flag and `[]` for a `rest` vector). Applied to the
  /// bind document before deserializing. Default **empty**.
  fn arg_defaults() -> Vec<(&'static str, serde_json::Value)> {
    Vec::new()
  }
}

/// Converts an `#[arg(default = <expr>)]` expression into the field's type:
/// the value itself, or a string literal for a `String`/`PathBuf` field.
pub trait IntoArgDefault<T> {
  fn into_arg_default(self) -> T;
}

impl<T> IntoArgDefault<T> for T {
  fn into_arg_default(self) -> T {
    self
  }
}

impl IntoArgDefault<String> for &str {
  fn into_arg_default(self) -> String {
    self.to_string()
  }
}

impl IntoArgDefault<std::path::PathBuf> for &str {
  fn into_arg_default(self) -> std::path::PathBuf {
    std::path::PathBuf::from(self)
  }
}

/// The `#[arg(default = …)]` value of a field of type `T` (used by the derive).
pub fn arg_default<T, V: IntoArgDefault<T>>(value: V) -> T {
  value.into_arg_default()
}

/// Rewrite declared short options to their long names: `-x` → `--field`, and a
/// bundle `-xy` whose letters are all declared → `--x-field --y-field`. Words
/// after a bare `--`, undeclared letters and negative numbers stay verbatim.
fn expand_shorts(argv: Vec<String>, shorts: &[(char, &'static str)]) -> Vec<String> {
  if shorts.is_empty() {
    return argv;
  }
  let long = |c: char| shorts.iter().find(|(s, _)| *s == c).map(|(_, name)| *name);
  let mut out = Vec::with_capacity(argv.len());
  let mut terminated = false;
  for (i, word) in argv.into_iter().enumerate() {
    if i == 0 || terminated {
      out.push(word);
      continue;
    }
    if word == "--" {
      terminated = true;
      out.push(word);
      continue;
    }
    let letters = word.strip_prefix('-').filter(|rest| !rest.is_empty() && !rest.starts_with('-'));
    match letters.map(|rest| rest.chars().map(long).collect::<Option<Vec<_>>>()) {
      Some(Some(names)) => out.extend(names.into_iter().map(|name| format!("--{name}"))),
      _ => out.push(word),
    }
  }
  out
}

impl CommandArg for String {
  fn display_help() -> Vec<String> {
    vec!["[string]".to_string()]
  }
}

impl CommandArg for i64 {
  fn display_help() -> Vec<String> {
    vec!["[i64]".to_string()]
  }
}

impl CommandArg for i32 {
  fn display_help() -> Vec<String> {
    vec!["[i32]".to_string()]
  }
}

impl CommandArg for f32 {
  fn display_help() -> Vec<String> {
    vec!["[f32]".to_string()]
  }
}

impl CommandArg for f64 {
  fn display_help() -> Vec<String> {
    vec!["[f64]".to_string()]
  }
}

impl CommandArg for Uuid {
  fn display_help() -> Vec<String> {
    vec!["[uuid]".to_string()]
  }
}

impl<T> CommandArg for Vec<T>
where
  T: CommandArg,
{
  fn positional_argv() -> bool {
    true
  }
  fn display_help() -> Vec<String> {
    // A `Vec<T>` arg collects all positionals: `cmd a b c`.
    T::display_help()
      .iter()
      .map(|s| format!("{s}..."))
      .collect()
  }
}

impl<T> CommandArg for Option<T>
where
  T: CommandArg,
{
  fn positional_argv() -> bool {
    T::positional_argv()
  }
  fn display_help() -> Vec<String> {
    // @todo: properly format
    // let inner = T::display_help();
    // if inner.len() == 1 && let Some(first) = inner.get(0) && !first.starts_with("--") {
    //   return vec![format]
    // }
    let help = &mut T::display_help();
    if help.len() == 0 {
      return vec![];
    }
    if help.len() == 1 {
      let opt = help.get(0).unwrap();
      return vec![format!("Option<{opt}>")];
    }

    let mut opt = vec!["<Optional>".to_string()];
    opt.append(help);
    opt
  }
}

/// Parse a string value into the appropriate JSON type (bool, i64, or string).
///
/// Only the literals `true`/`false` map to a bool — NOT `1`/`0`. Coercing `1`/`0`
/// to bool silently broke every numeric arg that legitimately takes `0` or `1`
/// (e.g. `--count 0`, `--max-age-secs 1`), which failed to deserialize a bool
/// into an integer field. Bool flags get `true` from bare presence (see below)
/// or an explicit `--flag true|false`, so they are unaffected.
pub(crate) fn parse_value(arg: &str) -> serde_json::Value {
  if arg == "true" {
    serde_json::Value::Bool(true)
  } else if arg == "false" {
    serde_json::Value::Bool(false)
  } else if let Ok(n) = arg.parse::<i64>() {
    serde_json::Value::Number(serde_json::Number::from(n))
  } else if arg.starts_with('{') || arg.starts_with('[') {
    // A `serde_json::Value`-typed flag (e.g. `--data '{"k":"v"}'`) must keep its
    // object/array shape — otherwise it deserializes as a string and any
    // struct/array target fails. Only parse values that LOOK like JSON
    // (object/array); plain strings/numbers/bools fall through unchanged. A
    // malformed `{…}` stays a string rather than erroring here.
    serde_json::from_str(arg).unwrap_or_else(|_| serde_json::Value::String(arg.to_string()))
  } else {
    serde_json::Value::String(arg.to_string())
  }
}

pub fn parse_arguments<T>(argv: Vec<String>) -> crate::Result<T>
where
  T: de::DeserializeOwned + CommandArg,
{
  let schema = T::arg_schema();
  if !schema.is_empty() {
    let argv = expand_shorts(argv, &T::arg_shorts());
    let args = argv.into_iter().skip(1)
      .map(|word| crate::script::value_from_json(&parse_value(&word))).collect();
    let (doc, provided) = crate::script::lisp_args_to_bind_doc(args, &schema)?;
    return bind_doc_to::<T>(doc, provided);
  }

  // println!("--argv {:#?}", argv);

  if argv.len() == 1 {
    // No args: try a JSON `null` first — that deserializes to `None` for
    // `Option<T>` and covers the unit-like "no arguments" case. A struct whose
    // fields are all optional can't be built from `null`, so fall back to an
    // empty object `{}`, where each `Option` field defaults to `None`. A type
    // with a genuinely required field fails both and surfaces as
    // "Missing required arguments".
    return serde_json::from_str("null")
      .or_else(|_| serde_json::from_str("{}"))
      .map_err(|_| {
        let expected_fields = T::display_help();
        if expected_fields.is_empty() {
          Error::ArgParseError("No arguments expected, but command failed".to_string())
        } else {
          let fields_list = expected_fields.join(", ");
          Error::ArgParseError(format!("Missing required arguments: {}", fields_list))
        }
      });
  }

  if T::positional_argv() {
    // Preserve the scalar JSON door (`cmd '["a","b"]'`) before treating
    // ordinary argv words as the command's own positional vector.
    if argv.len() == 2 {
      if let Ok(v) = serde_json::from_str::<T>(&argv[1]) {
        return Ok(v);
      }
    }
    return serde_json::from_value(serde_json::json!(&argv[1..]))
      .map_err(|e| Error::ArgParseError(e.to_string()));
  }

  // Positional mode: the first arg after the command name is not a `--flag`.
  // Supports a single scalar positional (`ls /tmp` → `String`/`Option<String>`/
  // `i64`) and multiple positionals collected into a `Vec<String>` (`mv a b`,
  // `echo x y z`). Commands taking `--key value` structs start with a flag and
  // fall through to the map parser below. A bare `--` (the posix options
  // terminator) is NOT a flag — it enters positional mode too, so
  // `cmd -- -p` reaches the positional array.
  if argv.len() >= 2 && (argv[1] == "--" || !argv[1].starts_with("--")) {
    // Single positional → try a scalar deserialize first, preserving the
    // existing single-arg behavior for `String`/`i64`/`Option<…>` arg types.
    if argv.len() == 2 {
      let only = &argv[1];
      if let Ok(v) = serde_json::from_str::<T>(only) {
        return Ok(v);
      }
      let quoted = serde_json::to_string(only).map_err(|e| Error::Other(e.into()))?;
      if let Ok(v) = serde_json::from_str::<T>(&quoted) {
        return Ok(v);
      }
      // Not a scalar target (e.g. a one-element `Vec<String>`) → fall to the
      // array path below.
    }

    // One-or-more positionals → a JSON array of strings (`Vec<String>` /
    // `Option<Vec<String>>`). `--` is the posix options terminator: it must
    // SURVIVE into the positional array — itself included — so that
    // posix-emulation builtins (tsh coreutils' `parse_flags`) can see it and
    // stop their own flag-parsing there; the words after it are never flags
    // at this layer either, so they pass through verbatim (`mkdir -- -p`
    // makes a literal `-p`). Before the first bare `--`, `--`-prefixed words
    // are dropped as before (they are named flags, not positionals).
    let mut words: Vec<serde_json::Value> = Vec::new();
    let mut terminated = false;
    for a in &argv[1..] {
      if !terminated && a == "--" {
        terminated = true;
        words.push(serde_json::Value::String(a.clone()));
        continue;
      }
      if terminated || !a.starts_with("--") {
        words.push(serde_json::Value::String(a.clone()));
      }
    }
    let arr = serde_json::Value::Array(words);
    if let Ok(v) = serde_json::from_value::<T>(arr) {
      return Ok(v);
    }
    // Neither scalar nor array matched `T` → fall through to the map parser,
    // which yields an informative "expected / provided" error.
  }

  use serde_json::Map;
  let mut map: Map<String, serde_json::Value> = Map::new();
  let mut key: Option<String> = None;
  for (i, arg) in argv.iter().enumerate() {
    // println!("[]: {arg}");
    if i == 0 {
      continue;
    }

    if arg == "--" {
      // A bare `--` here would trim to an empty-string key and silently
      // misparse; the terminator only means something to positional binding.
      return Err(Error::ArgParseError(
        "\"--\" terminator is only supported with positional arguments".to_string(),
      ));
    }

    if arg.starts_with("--") {
      // Normalize kebab-case CLI flags (`--from-dump`) to the
      // snake_case Rust field names serde will deserialize into
      // (`from_dump`). Without this, fields with `_` in their
      // names silently parse as missing when the CLI uses `-`.
      let arg = arg.trim_start_matches("--");
      // If there's a pending key without a value, treat it as a boolean flag
      if let Some(pending_key) = key.take() {
        map.insert(pending_key, serde_json::Value::Bool(true));
      }
      // Check for --key=value syntax
      if let Some((k, v)) = arg.split_once('=') {
        let value = parse_value(v);
        map.insert(k.replace('-', "_"), value);
      } else {
        key = Some(arg.replace('-', "_"));
      }
    } else {
      let Some(unwrapped_key) = key else {
        return Err(Error::ArgParseError(format!("unexpected argument {arg:?}")));
      };
      let value = parse_value(arg);
      map.insert(unwrapped_key, value);
      key = None;
    }
  }
  // If there's a trailing key without a value, treat it as a boolean flag
  if let Some(pending_key) = key {
    map.insert(pending_key, serde_json::Value::Bool(true));
  }
  let provided_fields: Vec<String> = map.keys().map(|k| format!("--{}", k)).collect();
  bind_doc_to::<T>(serde_json::Value::Object(map), provided_fields)
}

// === The unified arg-binding calculus =======================================
//
// One *bind document* (a `serde_json::Value`) is the canonical intermediate
// every front-end produces, and one serde step consumes. A posix line/argv and a
// lisp call bind literal words or keywords through
// `script::lisp_args_to_tokens`, producing the same `ArgToken`
// stream; `bind_tokens` binds those against an `ArgSchema` into the bind
// document; `bind_doc_to` deserializes it. `:key val` ≡ `--key val`, `:flag` ≡
// `--flag`, positionals fill declared slots in order, a trailing variadic slurps
// the rest — and the two may mix.

/// A front-end-neutral argument token. argv and Lisp both lower to a `Vec` of
/// these before binding, so the calculus is single-sourced.
#[derive(Debug, Clone, PartialEq)]
pub enum ArgToken {
  /// A value with no name, e.g. `/tmp` or `(ls "/tmp")`'s `"/tmp"`.
  Positional(serde_json::Value),
  /// `--key val` / `:key val`.
  Named(String, serde_json::Value),
  /// `--flag` / `:flag` (bare presence ⇒ `true`).
  Flag(String),
}

/// The ordered parameter schema a call binds against: positional slots (by
/// name, in order), an optional trailing variadic field, and the named options.
/// Empty = legacy shaping (scalar/array/named), preserved by [`parse_arguments`].
#[derive(Debug, Clone, Default)]
pub struct ArgSchema {
  pub positionals: Vec<String>,
  pub variadic: Option<String>,
  pub named: Vec<NamedField>,
}

/// A declared named option. `is_flag` (a `bool`-typed field) tells the
/// tokenizer NOT to swallow the following token as a value — so `:all "/tmp"`
/// (read from posix `--all /tmp` or written as lisp) is `Flag(all)` +
/// `Positional("/tmp")`, not `Named(all, "/tmp")`.
#[derive(Debug, Clone)]
pub struct NamedField {
  pub name: String,
  pub is_flag: bool,
}

impl ArgSchema {
  pub fn empty() -> Self {
    ArgSchema::default()
  }
  pub fn is_empty(&self) -> bool {
    self.positionals.is_empty() && self.variadic.is_none() && self.named.is_empty()
  }
  /// Is `name` a declared boolean flag (takes no value)?
  pub fn is_flag(&self, name: &str) -> bool {
    self.named.iter().any(|f| f.is_flag && f.name == name)
  }
}

/// Bind a token stream into the bind document, driven by `schema`: named/flag
/// tokens land by key; positionals fill the declared slots in order, then spill
/// into the variadic array; an extra positional with neither is an error.
pub fn bind_tokens(schema: &ArgSchema, tokens: Vec<ArgToken>) -> crate::Result<serde_json::Value> {
  let mut obj = serde_json::Map::new();
  let mut pos = 0usize;
  for tok in tokens {
    if let ArgToken::Named(name, _) | ArgToken::Flag(name) = &tok {
      if !schema.is_empty() && !schema.named.iter().any(|f| &f.name == name)
        && !schema.positionals.contains(name) && schema.variadic.as_ref() != Some(name)
      {
        return Err(Error::ArgParseError(format!("unknown option \"--{}\"", name.replace('_', "-"))));
      }
    }
    match tok {
      ArgToken::Named(k, v) => {
        obj.insert(k, v);
      }
      ArgToken::Flag(k) => {
        obj.insert(k, serde_json::Value::Bool(true));
      }
      ArgToken::Positional(v) => {
        if pos < schema.positionals.len() {
          obj.insert(schema.positionals[pos].clone(), v);
          pos += 1;
        } else if let Some(var) = &schema.variadic {
          let arr = obj
            .entry(var.clone())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
          if let Some(a) = arr.as_array_mut() {
            a.push(v);
          }
        } else {
          let word = match &v {
            serde_json::Value::String(s) => format!("{s:?}"),
            other => other.to_string(),
          };
          return Err(Error::ArgParseError(format!("unexpected argument {word}")));
        }
      }
    }
  }
  Ok(serde_json::Value::Object(obj))
}

/// The shared serde tail: deserialize a bind document into the param type `T`,
/// with a one-line error naming the offending option (the full option list is
/// what `--help` is for).
/// `provided_keys` are the call's keys, already display-formatted by the caller
/// (`--key` for argv, `:key` for Lisp).
pub fn bind_doc_to<T>(doc: serde_json::Value, provided_keys: Vec<String>) -> crate::Result<T>
where
  T: de::DeserializeOwned + CommandArg,
{
  let mut doc = doc;
  if let serde_json::Value::Object(obj) = &mut doc {
    for (name, value) in T::arg_defaults() {
      obj.entry(name.to_string()).or_insert(value);
    }
  }
  serde_json::from_value(doc).map_err(|e| {
    let message = e.to_string();
    if T::display_help().is_empty() {
      // A command without options given one: serde says `invalid type: map,
      // expected unit`; name the option instead.
      match provided_keys.first() {
        Some(key) if message.starts_with("invalid type: map") => {
          Error::ArgParseError(format!("unknown option {key:?}"))
        }
        _ => Error::Other(e.into()),
      }
    } else {
      Error::ArgParseError(one_line_bind_error(&message, &provided_keys))
    }
  })
}

/// serde's field errors as option-shaped one-liners, in the caller's spelling
/// (`--key` for argv, `:key` for Lisp, judged from the provided keys):
/// ``missing field `x_y` `` -> `missing required option --x-y`;
/// ``unknown field `x`, expected ...`` -> `unknown option "--x"`.
fn one_line_bind_error(message: &str, provided_keys: &[String]) -> String {
  let lisp = provided_keys.first().is_some_and(|key| key.starts_with(':'));
  let option = |rest: &str| {
    let name = rest.split('`').next().unwrap_or("");
    if lisp { format!(":{name}") } else { format!("--{}", name.replace('_', "-")) }
  };
  if let Some(rest) = message.strip_prefix("missing field `") {
    return format!("missing required option {}", option(rest));
  }
  if let Some(rest) = message.strip_prefix("unknown field `") {
    return format!("unknown option {:?}", option(rest));
  }
  format!("invalid arguments: {}", message.lines().next().unwrap_or(message))
}

#[cfg(test)]
#[path = "command_arg_declared_tests.rs"]
mod declared_tests;

#[cfg(test)]
mod tests {
  use super::*;
  use serde::Deserialize;
  use serde_json::json;

  // The front-end-neutral core: `bind_tokens` is the single source of truth
  // every syntax targets. These assert binding behavior on hand-built token
  // streams; the per-syntax binders (`lisp_args_to_tokens` and argv parsing)
  // are tested at their own sites.
  fn ls_schema() -> ArgSchema {
    ArgSchema {
      positionals: vec![],
      variadic: Some("paths".to_string()),
      named: vec![
        NamedField {
          name: "all".to_string(),
          is_flag: true,
        },
        NamedField {
          name: "long".to_string(),
          is_flag: true,
        },
      ],
    }
  }

  #[test]
  fn two_token_orderings_bind_to_the_same_doc() {
    // The same call expressed two ways binds identically: posix `ls --all /tmp`
    // (Flag(all) then Positional) and lisp `(ls "/tmp" :all true)` (Positional
    // then Named) both land `{all:true, paths:["/tmp"]}`.
    let posix_order = vec![
      ArgToken::Flag("all".into()),
      ArgToken::Positional(json!("/tmp")),
    ];
    let lisp_order = vec![
      ArgToken::Positional(json!("/tmp")),
      ArgToken::Named("all".into(), json!(true)),
    ];
    let from_posix = bind_tokens(&ls_schema(), posix_order).unwrap();
    let from_lisp = bind_tokens(&ls_schema(), lisp_order).unwrap();
    assert_eq!(from_posix, json!({ "all": true, "paths": ["/tmp"] }));
    assert_eq!(from_posix, from_lisp, "both orderings bind to one document");
  }

  #[test]
  fn variadic_collects_multiple_positionals() {
    let toks = vec![
      ArgToken::Positional(json!("a")),
      ArgToken::Positional(json!("b")),
      ArgToken::Positional(json!("c")),
    ];
    let doc = bind_tokens(&ls_schema(), toks).unwrap();
    assert_eq!(doc, json!({ "paths": ["a", "b", "c"] }));
  }

  #[test]
  fn positionals_fill_named_slots_in_order_then_variadic() {
    let schema = ArgSchema {
      positionals: vec!["src".into(), "dest".into()],
      variadic: Some("rest".into()),
      named: vec![],
    };
    let toks = vec![
      ArgToken::Positional(json!("a")),
      ArgToken::Positional(json!("b")),
      ArgToken::Positional(json!("c")),
      ArgToken::Positional(json!("d")),
    ];
    let doc = bind_tokens(&schema, toks).unwrap();
    assert_eq!(doc, json!({ "src": "a", "dest": "b", "rest": ["c", "d"] }));
  }

  #[test]
  fn extra_positional_without_a_slot_errors() {
    let schema = ArgSchema {
      positionals: vec!["only".into()],
      variadic: None,
      named: vec![],
    };
    let toks = vec![
      ArgToken::Positional(json!("a")),
      ArgToken::Positional(json!("b")),
    ];
    assert!(bind_tokens(&schema, toks).is_err());
  }

  #[test]
  fn flags_and_named_bind_by_key() {
    // Flag(dry_run) + Named(from_dump,"x") → {dry_run:true, from_dump:"x"}.
    // (The tokenizing of `--dry-run`/`:dry-run` into these tokens, incl.
    // kebab→snake, is covered by the reader + lisp tokenizer tests.)
    let toks = vec![
      ArgToken::Flag("dry_run".into()),
      ArgToken::Named("from_dump".into(), json!("x")),
    ];
    let doc = bind_tokens(&ArgSchema::empty(), toks).unwrap();
    assert_eq!(doc, json!({ "dry_run": true, "from_dump": "x" }));
  }

  #[test]
  fn dashdash_terminator_survives_into_the_positional_array() {
    // Leading `--` enters positional mode and is kept verbatim, with the
    // words after it — so a posix-emulation builtin downstream can see the
    // terminator and treat `-p` as a literal name.
    let argv: Vec<String> = ["cmd", "--", "-p"].iter().map(|s| s.to_string()).collect();
    let v: Vec<String> = parse_arguments(argv).unwrap();
    assert_eq!(v, vec!["--".to_string(), "-p".to_string()]);

    // Mid-argv `--` is kept too, in position.
    let argv: Vec<String> = ["cmd", "a", "--", "-p"]
      .iter()
      .map(|s| s.to_string())
      .collect();
    let v: Vec<String> = parse_arguments(argv).unwrap();
    assert_eq!(v, vec!["a".to_string(), "--".to_string(), "-p".to_string()]);
  }

  #[test]
  fn positional_vectors_keep_every_flag_word() {
    for words in [
      vec!["--help"],
      vec!["-h"],
      vec!["a", "--help", "b"],
      vec!["--", "--help", "-h"],
      vec!["--unknown", "operand"],
    ] {
      let mut argv = vec!["cmd".to_string()];
      argv.extend(words.iter().map(|w| w.to_string()));
      let plain: Vec<String> = parse_arguments(argv.clone()).unwrap();
      let optional: Option<Vec<String>> = parse_arguments(argv).unwrap();
      assert_eq!(plain, words);
      assert_eq!(optional.unwrap(), words);
    }
  }

  #[test]
  fn positional_vectors_keep_the_single_json_argument_door() {
    let argv = vec!["cmd".into(), r#"["a","b"]"#.into()];
    let got: Vec<String> = parse_arguments(argv).unwrap();
    assert_eq!(got, vec!["a", "b"]);
  }

  #[test]
  fn map_parser_rejects_a_bare_dashdash() {
    // A `--key value` struct command has no positional binding for `--` to
    // terminate — a bare `--` is an explicit error, never an empty-string key.
    #[derive(Deserialize, Debug)]
    struct M {
      #[allow(dead_code)]
      name: String,
    }
    impl CommandArg for M {
      fn display_help() -> Vec<String> {
        vec!["--name".into()]
      }
    }
    let argv: Vec<String> = ["cmd", "--name", "x", "--"]
      .iter()
      .map(|s| s.to_string())
      .collect();
    let err = parse_arguments::<M>(argv).unwrap_err();
    assert_eq!(
      format!("{err}"),
      "arg parse error: \"--\" terminator is only supported with positional arguments"
    );
  }

  #[test]
  fn bind_doc_to_round_trips_a_struct() {
    #[derive(Deserialize, PartialEq, Debug)]
    struct A {
      all: bool,
      #[serde(default)]
      paths: Vec<String>,
    }
    impl CommandArg for A {
      fn display_help() -> Vec<String> {
        vec!["--all".into()]
      }
    }
    let v: A = bind_doc_to(json!({ "all": true, "paths": ["/tmp"] }), vec![]).unwrap();
    assert_eq!(
      v,
      A {
        all: true,
        paths: vec!["/tmp".into()]
      }
    );
  }
}
