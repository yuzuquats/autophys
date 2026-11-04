//! Regular expressions: `str.re-match?`, `str.re-find`, `str.re-find-all`,
//! `str.re-captures`, `str.re-captures-all`, `str.re-split`, `str.re-replace`.
//!
//! Each is the pattern form of a literal `str.*` function (`str.find` ↔
//! `str.re-find`, `str.replace` ↔ `str.re-replace`, `str.split` ↔
//! `str.re-split`). Patterns use the Rust `regex` crate's syntax, which
//! matches in time linear in the text — there is no catastrophic
//! backtracking to guard against — and has no look-around or backreferences.
//! Flags go inline: `(?i)` case-insensitive, `(?m)` line anchors, `(?s)` dot
//! matches newline.
//!
//! Compiled patterns are cached per thread, so a pattern used inside a loop
//! over a file's lines compiles once; so is a pattern's compile error, so a
//! bad pattern in a loop fails fast instead of compiling again every time.

use std::collections::HashMap;

use regex::{Captures, Regex, RegexBuilder};

use super::text::{arity, bounded, fits, string_arg, strings, text_arg, too_long};
use super::*;
use crate::eval::List;

/// Distinct patterns kept compiled (or kept as their compile error). Scripts
/// use a handful; a script that builds patterns from data evicts the least
/// recently used one rather than growing the cache without bound.
const CACHE_ENTRIES: usize = 128;

/// Compiled-program size limit for one pattern. The crate's default (10 MiB)
/// lets a short pattern such as `\w{1000}{1000}` compile to hundreds of MiB
/// of automaton before it fails; 2 MiB covers any pattern written by hand.
const PATTERN_SIZE_LIMIT: usize = 2 * 1024 * 1024;

/// A pattern's compiled form, or the crate's message for why it failed.
type Compiled = Result<Regex, String>;

/// Patterns by text, each with the tick of its last use; the stalest is
/// evicted when a new pattern arrives at a full cache.
#[derive(Default)]
struct Cache {
  entries: HashMap<String, (Compiled, u64)>,
  tick: u64,
}

thread_local! {
  static CACHE: RefCell<Cache> = RefCell::new(Cache::default());
}

fn compile(pattern: &str, name: &str) -> Result<Regex, RuntimeError> {
  let compiled = CACHE.with(|cache| {
    let mut cache = cache.borrow_mut();
    cache.tick += 1;
    let tick = cache.tick;
    cache.entries.get_mut(pattern).map(|(compiled, used)| {
      *used = tick;
      compiled.clone()
    })
  });
  let compiled = compiled.unwrap_or_else(|| {
    let compiled = RegexBuilder::new(pattern)
      .size_limit(PATTERN_SIZE_LIMIT)
      .build()
      .map_err(|error| error.to_string());
    CACHE.with(|cache| {
      let mut cache = cache.borrow_mut();
      if cache.entries.len() >= CACHE_ENTRIES {
        let stalest = cache
          .entries
          .iter()
          .min_by_key(|(_, (_, used))| *used)
          .map(|(key, _)| key.clone());
        if let Some(stalest) = stalest {
          cache.entries.remove(&stalest);
        }
      }
      let tick = cache.tick;
      cache
        .entries
        .insert(pattern.to_string(), (compiled.clone(), tick));
    });
    compiled
  });
  compiled
    .map_err(|error| RuntimeError::Other(format!("{name}: invalid pattern {pattern:?}: {error}")))
}

/// `(TEXT PATTERN)` for every function here; TEXT may be `nil` (read as
/// `""`), PATTERN must be a string.
fn text_and_pattern<'a, S: Symbol>(
  args: &'a [Value<S>],
  name: &str,
) -> Result<(&'a str, Regex), RuntimeError> {
  let text = text_arg(&args[0], name)?;
  let pattern = string_arg(&args[1], name)?;
  Ok((text, compile(pattern, name)?))
}

/// One match's groups as a list: the whole match, then each group in order,
/// `nil` for a group that did not take part. Named groups are positional
/// here; `(?<name>…)` is still useful to document the pattern.
fn groups<S: Symbol>(captures: &Captures<'_>) -> Value<S> {
  Value::List(List {
    items: captures
      .iter()
      .map(|group| group.map_or(Value::Nil, |m| Value::String(m.as_str().into())))
      .collect(),
  })
}

/// `(str.re-match? TEXT PATTERN)` — whether PATTERN matches anywhere in TEXT.
/// Anchor with `^…$` to test the whole text.
pub fn is_match<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 2..=2, "str.re-match? takes 2 args (text, pattern)")?;
  let (text, regex) = text_and_pattern(&args, "str.re-match?")?;
  Ok(Value::Boolean(regex.is_match(text)))
}

/// `(str.re-find TEXT PATTERN)` — the first matching text, or `nil`.
pub fn find<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 2..=2, "str.re-find takes 2 args (text, pattern)")?;
  let (text, regex) = text_and_pattern(&args, "str.re-find")?;
  Ok(
    regex
      .find(text)
      .map_or(Value::Nil, |m| Value::String(m.as_str().into())),
  )
}

/// `(str.re-find-all TEXT PATTERN)` — every non-overlapping match, left to
/// right, as a list of strings (empty when nothing matches).
pub fn find_all<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 2..=2, "str.re-find-all takes 2 args (text, pattern)")?;
  let (text, regex) = text_and_pattern(&args, "str.re-find-all")?;
  strings("str.re-find-all", regex.find_iter(text).map(|m| m.as_str()))
}

/// `(str.re-captures TEXT PATTERN)` — the first match as
/// `(whole group1 group2 …)`, `nil` in place of a group that did not take
/// part, or `nil` when nothing matches.
pub fn captures<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 2..=2, "str.re-captures takes 2 args (text, pattern)")?;
  let (text, regex) = text_and_pattern(&args, "str.re-captures")?;
  Ok(regex.captures(text).map_or(Value::Nil, |c| groups(&c)))
}

/// `(str.re-captures-all TEXT PATTERN)` — every match's group list, as
/// `str.re-captures` shapes one. With `(?m)` this parses a whole
/// line-oriented file in one call.
pub fn captures_all<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(
    &args,
    2..=2,
    "str.re-captures-all takes 2 args (text, pattern)",
  )?;
  let (text, regex) = text_and_pattern(&args, "str.re-captures-all")?;
  // Each match costs its own list plus one value per group.
  bounded(
    "str.re-captures-all",
    1 + regex.captures_len(),
    regex.captures_iter(text).map(|c| groups(&c)),
  )
}

/// `(str.re-split TEXT PATTERN [LIMIT])` — `str.split` with a pattern for the
/// separator: `(str.re-split "a, b ,c" "\\s*,\\s*")` → `("a" "b" "c")`.
/// LIMIT caps the piece count, the last piece keeping the remainder.
pub fn split<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(
    &args,
    2..=3,
    "str.re-split takes 2 or 3 args (text, pattern, [limit])",
  )?;
  let (text, regex) = text_and_pattern(&args, "str.re-split")?;
  match args.get(2) {
    None => strings("str.re-split", regex.split(text)),
    Some(Value::Integer(limit)) if *limit > 0 => strings(
      "str.re-split",
      regex.splitn(text, usize::try_from(*limit).unwrap_or(usize::MAX)),
    ),
    Some(Value::Integer(limit)) => Err(RuntimeError::Other(format!(
      "str.re-split: the limit must be at least 1 (got {limit})"
    ))),
    Some(other) => Err(RuntimeError::TypeError {
      expected: "Integer (in str.re-split limit)".into(),
      got: format!("{:?}", other.as_type()),
    }),
  }
}

/// `(str.re-replace TEXT PATTERN REPLACEMENT)` — every match replaced.
/// REPLACEMENT may name groups: `$1`, `${1}`, `${name}`; `$$` is a literal
/// `$`. Write `${1}x`, not `$1x`, when a group is followed by a name
/// character (the crate reads `$1x` as the group named `1x`).
pub fn replace<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(
    &args,
    3..=3,
    "str.re-replace takes 3 args (text, pattern, replacement)",
  )?;
  let (text, regex) = text_and_pattern(&args, "str.re-replace")?;
  let replacement = text_arg(&args[2], "str.re-replace")?;
  let mut out = String::with_capacity(text.len());
  // Each match expands into `expanded` first, so the size check runs before
  // `out` grows; an output no larger than TEXT always fits.
  let mut expanded = String::new();
  let mut last = 0;
  for captures in regex.captures_iter(text) {
    let whole = captures.get(0).expect("group 0 is the whole match");
    expanded.clear();
    captures.expand(replacement, &mut expanded);
    let gap = whole.start() - last;
    if !fits(out.len() + gap + expanded.len(), text.len()) {
      return Err(too_long("str.re-replace"));
    }
    out.push_str(&text[last..whole.start()]);
    out.push_str(&expanded);
    last = whole.end();
  }
  if !fits(out.len() + (text.len() - last), text.len()) {
    return Err(too_long("str.re-replace"));
  }
  out.push_str(&text[last..]);
  Ok(Value::String(out.into()))
}

#[cfg(test)]
mod tests {
  use string_interner::symbol::SymbolU32;

  use crate::{Runtime, Value};

  fn eval(source: &str) -> Value<SymbolU32> {
    let mut values =
      Runtime::<SymbolU32>::eval(None, source).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    values.pop().unwrap()
  }

  fn assert_true(source: &str) {
    assert!(matches!(eval(source), Value::Boolean(true)), "{source}");
  }

  fn assert_error(source: &str, needle: &str) {
    let message = eval(&format!("(error.message (try {source}))"));
    let Value::String(message) = message else {
      panic!("{source}: no error, got {message:?}")
    };
    assert!(message.contains(needle), "{source}: {message}");
  }

  #[test]
  fn match_and_find_search_anywhere_unless_anchored() {
    assert_true(r#"(str.re-match? "item 42" "[0-9]+")"#);
    assert_true(r#"(not (str.re-match? "item 42" "^[0-9]+$"))"#);
    assert_true(r#"(str.re-match? "ABC" "(?i)^abc$")"#);
    assert_true(r#"(not (str.re-match? nil "x"))"#);
    assert_true(r#"(= (str.re-find "item 42, item 7" "[0-9]+") "42")"#);
    assert_true(r#"(null? (str.re-find "no digits" "[0-9]+"))"#);
  }

  #[test]
  fn find_all_returns_every_match_in_order() {
    assert_true(r#"(= (str.re-find-all "a1 b22 c333" "[0-9]+") (list "1" "22" "333"))"#);
    assert_true(r#"(= (str.re-find-all "none" "[0-9]+") (list))"#);
    assert_true(r#"(= (str.re-find-all "é1😀2" "\\d") (list "1" "2"))"#);
  }

  #[test]
  fn captures_list_the_whole_match_then_each_group() {
    assert_true(
      r#"(= (str.re-captures "key = value" "^(\\w+)\\s*=\\s*(.*)$") (list "key = value" "key" "value"))"#,
    );
    assert_true(r#"(= (str.re-captures "ab" "(a)(x)?(b)") (list "ab" "a" nil "b"))"#);
    assert_true(r#"(null? (str.re-captures "nothing" "(\\d+)"))"#);
    assert_true(
      r#"(= (str.re-captures-all "a=1\nb=2\n" "(?m)^(\\w)=(\\d)$")
            (list (list "a=1" "a" "1") (list "b=2" "b" "2")))"#,
    );
  }

  #[test]
  fn split_and_replace_take_patterns() {
    assert_true(r#"(= (str.re-split "a, b ,c" "\\s*,\\s*") (list "a" "b" "c"))"#);
    assert_true(r#"(= (str.re-split "a  b c" "\\s+" 2) (list "a" "b c"))"#);
    assert_true(
      r#"(= (str.re-replace "2026-10-16" "(\\d+)-(\\d+)-(\\d+)" "$3/$2/$1") "16/10/2026")"#,
    );
    assert_true(r#"(= (str.re-replace "a1b2" "(?<d>\\d)" "<${d}>") "a<1>b<2>")"#);
    assert_true(r#"(= (str.re-replace "cost 5" "\\d" "$$") "cost $")"#);
    assert_true(r#"(= (str.re-replace "untouched" "\\d" "x") "untouched")"#);
    assert_error(r#"(str.re-split "a" "," 0)"#, "at least 1");
  }

  #[test]
  fn invalid_or_oversized_patterns_are_errors() {
    assert_error(r#"(str.re-match? "x" "(unclosed")"#, "invalid pattern");
    assert_error(r#"(str.re-find "x" "\\w{1000}{1000}")"#, "invalid pattern");
    assert_error(r#"(str.re-find "x" nil)"#, "String");
    assert_error(
      r#"(str.re-replace (str.repeat "a" 1048576) "a" (str.repeat "b" 128))"#,
      "output limit",
    );
  }

  #[test]
  fn the_cache_returns_the_same_answers_after_it_is_cleared() {
    let mut patterns = String::new();
    for i in 0..(super::CACHE_ENTRIES + 5) {
      patterns.push_str(&format!("(str.re-match? \"{i}\" \"^{i}$\") "));
    }
    let values = Runtime::<SymbolU32>::eval(None, &patterns).unwrap();
    assert!(values.iter().all(|v| matches!(v, Value::Boolean(true))));
  }

  fn cached(pattern: &str) -> Option<bool> {
    super::CACHE.with(|cache| cache.borrow().entries.get(pattern).map(|(c, _)| c.is_ok()))
  }

  #[test]
  fn the_cache_evicts_the_least_recently_used_pattern_and_keeps_errors() {
    for i in 0..super::CACHE_ENTRIES {
      super::compile(&format!("^{i}$"), "test").unwrap();
    }
    // Touch the oldest; the next new pattern evicts the second oldest.
    super::compile("^0$", "test").unwrap();
    super::compile("^new$", "test").unwrap();
    assert_eq!(cached("^0$"), Some(true));
    assert_eq!(cached("^1$"), None);
    // A failing pattern is remembered, and fails the same way again.
    let first = super::compile("\\w{1000}{1000}", "str.re-find").unwrap_err();
    assert_eq!(cached("\\w{1000}{1000}"), Some(false));
    let again = super::compile("\\w{1000}{1000}", "str.re-match?").unwrap_err();
    assert!(format!("{first:?}").contains("str.re-find: invalid pattern"));
    assert!(format!("{again:?}").contains("str.re-match?: invalid pattern"));
    super::CACHE.with(|cache| assert!(cache.borrow().entries.len() <= super::CACHE_ENTRIES));
  }

  #[test]
  fn re_replace_output_no_larger_than_its_text_is_not_refused() {
    // 72 MiB, past the output limit; one match keeps the size.
    let eight = "(str.repeat \"a\" 8388608)";
    let parts = std::iter::repeat(eight)
      .take(9)
      .collect::<Vec<_>>()
      .join(" ");
    assert_true(&format!(
      "(= (length (str.re-replace (str.join (list {parts} \"x\")) \"x\" \"y\")) {})",
      9 * 8388608 + 1
    ));
    assert_error(
      &format!("(str.re-replace (str.join (list {parts} \"x\")) \"x\" \"yy\")"),
      "output limit",
    );
  }
}
