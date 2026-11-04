//! The Lisp front-end of the unified arg-binding calculus: lower evaluated Lisp
//! call args to the same `ArgToken` stream every front-end produces, so
//! `(ls "/tmp" :all)` binds to the same
//! param type as `ls --all /tmp`. A literal `--k` or `:k` keyword (which the interpreter
//! evaluates to `String(":k")`) introduces a named option / flag; everything
//! else is a positional, type-preserved through `value_to_json`.

use serde::de;
use serde_json::Value as JsonValue;

use super::interp::value_to_json;
use super::{LispValue, Sym};
use crate::command_arg::{
  ArgSchema, ArgToken, CommandArg, bind_doc_to, bind_tokens, parse_arguments,
};

/// Lisp keywords and literal long-option words are interpreted only here.
fn option_str(s: &str) -> Option<&str> {
  let rest = s.strip_prefix(':').or_else(|| s.strip_prefix("--"))?;
  rest.chars().next().filter(|c| c.is_ascii_alphabetic()).map(|_| rest)
}

fn is_option(v: &LispValue<Sym>) -> bool {
  matches!(v, LispValue::String(s) if option_str(s).is_some() || s == "--")
}

/// The schema decides flags versus valued options. After `--`, words are
/// positional; kebab-to-snake normalization applies to option names only.
pub fn lisp_args_to_tokens(args: Vec<LispValue<Sym>>, schema: &ArgSchema) -> Vec<ArgToken> {
  let mut out = Vec::with_capacity(args.len());
  let mut it = args.into_iter().peekable();
  let mut terminated = false;
  while let Some(a) = it.next() {
    if !terminated {
      if let LispValue::String(s) = &a {
        if s == "--" {
          terminated = true;
          continue;
        }
        if let Some(option) = option_str(s) {
          let (name, inline) = option.split_once('=').map_or((option, None), |(k, v)| (k, Some(v)));
          let key = name.replace('-', "_");
          if let Some(value) = inline {
            out.push(ArgToken::Named(key, crate::command_arg::parse_value(value)));
          } else if !schema.is_flag(&key) && it.peek().is_some_and(|next| !is_option(next)) {
            let value = it.next().unwrap();
            let value = match &value {
              LispValue::String(text) if s.starts_with("--") => crate::command_arg::parse_value(text),
              value => value_to_json(value),
            };
            out.push(ArgToken::Named(key, value));
          } else {
            out.push(ArgToken::Flag(key));
          }
          continue;
        }
      }
    }
    out.push(ArgToken::Positional(value_to_json(&a)));
  }
  out
}

/// Bind Lisp args into the bind document + the display-formatted provided keys
/// (`:key`, for error messages) — the Lisp counterpart of the argv binder.
pub fn lisp_args_to_bind_doc(
  args: Vec<LispValue<Sym>>,
  schema: &ArgSchema,
) -> crate::Result<(JsonValue, Vec<String>)> {
  let tokens = lisp_args_to_tokens(args, schema);
  let provided: Vec<String> = tokens
    .iter()
    .filter_map(|t| match t {
      ArgToken::Named(k, _) | ArgToken::Flag(k) => Some(format!(":{k}")),
      ArgToken::Positional(_) => None,
    })
    .collect();
  let doc = bind_tokens(schema, tokens)?;
  Ok((doc, provided))
}

/// Lower evaluated values to argv without pairing or normalizing words. An
/// explicit Lisp keyword becomes one `--name` word; the next value stays its
/// own argument. External dispatch uses this spelling-preserving bridge.
pub fn lisp_args_to_argv(name: &str, args: Vec<LispValue<Sym>>) -> Vec<String> {
  let mut argv = vec![name.to_string()];
  argv.extend(args.into_iter().map(|value| match value {
    LispValue::String(s) if s.strip_prefix(':').is_some_and(|rest|
      rest.chars().next().is_some_and(|c| c.is_ascii_alphabetic())) => format!("--{}", &s[1..]),
    value => json_scalar_to_arg(&value_to_json(&value)),
  }));
  argv
}

/// Reflection is bound only after dispatch has selected a tsh command.
#[derive(Default)]
pub(crate) struct ReflectionOptions {
  pub help: bool,
  pub json: bool,
  terminated: bool,
}

impl ReflectionOptions {
  fn keep(&mut self, word: &str) -> bool {
    if word == "--" { self.terminated = true; }
    if self.terminated { return true; }
    match word {
      "--help" | ":help" => { self.help = true; false }
      "--json" | ":json" => { self.json = true; false }
      _ => true,
    }
  }
}

pub(crate) fn take_reflection_argv(argv: &mut Vec<String>) -> ReflectionOptions {
  let mut options = ReflectionOptions::default();
  let mut head = true;
  argv.retain(|word| {
    if head { head = false; true } else { options.keep(word) }
  });
  options
}

pub(crate) fn take_reflection_lisp(args: &mut Vec<LispValue<Sym>>) -> ReflectionOptions {
  let mut options = ReflectionOptions::default();
  args.retain(|value| match value {
    LispValue::String(word) => options.keep(word),
    _ => true,
  });
  options
}

/// Bind Lisp args directly to the typed param `T`. With a declared (non-empty)
/// schema, positionals bind by name and may mix with `:named` options (the
/// type-preserving path). With an empty schema, falls back to the argv door so
/// the legacy scalar/array/named shaping is preserved exactly.
pub fn lisp_args_to_typed<T>(name: &str, args: Vec<LispValue<Sym>>) -> crate::Result<T>
where
  T: de::DeserializeOwned + CommandArg,
{
  let schema = T::arg_schema();
  if schema.is_empty() {
    parse_arguments::<T>(lisp_args_to_argv(name, args))
  } else {
    let (doc, provided) = lisp_args_to_bind_doc(args, &schema)?;
    bind_doc_to::<T>(doc, provided)
  }
}

/// Render a JSON scalar back to an argv token (string unquoted; others as JSON
/// text, which `parse_value` re-coerces on the argv side).
fn json_scalar_to_arg(v: &JsonValue) -> String {
  match v {
    JsonValue::String(s) => s.clone(),
    other => other.to_string(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::command_arg::{ArgSchema, NamedField};
  use serde_json::json;

  fn kw(k: &str) -> LispValue<Sym> {
    LispValue::String(format!(":{k}").into())
  }
  fn str_(s: &str) -> LispValue<Sym> {
    LispValue::String(s.to_string().into())
  }
  fn ls_schema() -> ArgSchema {
    ArgSchema {
      positionals: vec![],
      variadic: Some("paths".into()),
      named: vec![
        NamedField {
          name: "all".into(),
          is_flag: true,
        },
        NamedField {
          name: "long".into(),
          is_flag: true,
        },
      ],
    }
  }

  #[test]
  fn declared_flag_is_not_swallowed() {
    // `:all "/tmp"` with `all` a declared flag → Flag(all) + Positional, exactly
    // as posix `--all /tmp` must read. (Without the schema this greedily became
    // Named(all,"/tmp") and lost the positional.)
    let toks = lisp_args_to_tokens(vec![kw("all"), str_("/tmp")], &ls_schema());
    assert_eq!(
      toks,
      vec![
        ArgToken::Flag("all".into()),
        ArgToken::Positional(json!("/tmp"))
      ]
    );
  }

  #[test]
  fn option_without_flag_schema_swallows_value() {
    // No declared flag → the greedy `:k v` → Named the legacy path relies on.
    let toks = lisp_args_to_tokens(vec![kw("name"), str_("foo")], &ArgSchema::empty());
    assert_eq!(toks, vec![ArgToken::Named("name".into(), json!("foo"))]);
  }

  #[test]
  fn colon_shaped_value_is_not_swallowed_as_a_keyword() {
    // Regression: `cells.get --row :~acme:chores` lowers (post-eval, once the
    // `:row` keyword and the `:~acme:chores` value have BOTH self-evaluated to
    // `String(":…")`) to `[":row", ":~acme:chores"]`. `:row` must take
    // `:~acme:chores` as its VALUE — a leading-`~` colon token is not
    // `--flag`-shaped, so it stays a string. Before the fix `:~acme:chores` was
    // seen as a keyword, so `:row` became a valueless flag and the value was
    // lost (the binary saw `--row` with no value → "--row is required").
    let toks = lisp_args_to_tokens(vec![kw("row"), str_(":~acme:chores")], &ArgSchema::empty());
    assert_eq!(
      toks,
      vec![ArgToken::Named("row".into(), json!(":~acme:chores"))],
      "the colon-shaped value must ride --row, not vanish"
    );
    let argv = lisp_args_to_argv("cells.get", vec![kw("row"), str_(":~acme:chores")]);
    assert_eq!(argv, vec!["cells.get", "--row", ":~acme:chores"]);
  }

  #[test]
  fn colon_value_as_lone_positional_stays_a_string() {
    // A colon-shaped value that isn't `--flag`-shaped is a POSITIONAL, never a
    // (valueless) flag — even standing alone.
    let toks = lisp_args_to_tokens(vec![str_(":~acme:chores")], &ArgSchema::empty());
    assert_eq!(toks, vec![ArgToken::Positional(json!(":~acme:chores"))]);
  }

  #[test]
  fn kebab_keyword_normalizes_to_snake() {
    let toks = lisp_args_to_tokens(vec![kw("dry-run")], &ArgSchema::empty());
    assert_eq!(toks, vec![ArgToken::Flag("dry_run".into())]);
  }

  #[test]
  fn keyword_before_keyword_is_a_flag() {
    // `:all :long` → two flags even with no schema (the next token is a keyword,
    // so there is nothing to swallow).
    let toks = lisp_args_to_tokens(vec![kw("all"), kw("long")], &ArgSchema::empty());
    assert_eq!(
      toks,
      vec![ArgToken::Flag("all".into()), ArgToken::Flag("long".into())]
    );
  }

  #[test]
  fn posix_and_lisp_orderings_bind_to_one_doc() {
    // Posix `ls --all /tmp` supplies ["--all", "/tmp"]; the
    // lisp form `(ls "/tmp" :all)` → ["/tmp", :all]. Under the flag schema a
    // declared flag is written `:all` (never `:all true`) in BOTH syntaxes, and
    // both bind to {all:true, paths:["/tmp"]}.
    let posix = lisp_args_to_tokens(vec![str_("--all"), str_("/tmp")], &ls_schema());
    let lisp = lisp_args_to_tokens(vec![str_("/tmp"), kw("all")], &ls_schema());
    let from_posix = bind_tokens(&ls_schema(), posix).unwrap();
    let from_lisp = bind_tokens(&ls_schema(), lisp).unwrap();
    assert_eq!(from_posix, json!({ "all": true, "paths": ["/tmp"] }));
    assert_eq!(from_posix, from_lisp, "posix and lisp orderings converge");
  }
}

#[cfg(test)]
#[path = "arg_bind_literal_tests.rs"]
mod literal_tests;
