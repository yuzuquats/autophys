//! Conditional compilation, as Rust's `cfg`: a form that exists only in some
//! contexts. `(@cfg P)` before a top-level form keeps that form when the
//! predicate `P` holds and removes it otherwise; the `(@cfg P)` itself is
//! always removed. Removal happens on the source text before anything reads
//! it ([`resolve_source`]): a removed form is never evaluated, never linked,
//! and is dropped whole, parentheses included. `(cfg? P)` is the expression
//! form (Rust's `cfg!`), and `(cfg)` returns every key.
//!
//! Keys are fixed before any source is read. The host derives the built-in
//! ones from how it was started ([`DERIVED`]) and adds the user's own from the
//! command line and the environment ([`parse_user_spec`]), then installs the
//! set once per process ([`install`]). Nothing a program computes can set a
//! key.
//!
//! A key is a name, optionally with a value, as in Rust: `unix`,
//! `os = "macos"`. A predicate is a name (a key with that name and no value
//! is set), `(name = "value")`, or `(all P…)`, `(any P…)`, `(not P)`.

use std::collections::BTreeSet;
use std::fmt;
use std::ops::Range;
use std::sync::RwLock;

/// The keys a host derives from how it was started. They are always known:
/// an unset one is false, a near-miss of one is an error (a typo must never
/// silently drop code), and the user cannot set one.
pub const DERIVED: &[&str] = &[
  "interactive",
  "login",
  "os",
  "posix",
  "profile",
  "session",
  "unix",
  "windows",
];

/// Derived keys that only exist with a value (`os = "macos"`).
const VALUED: &[&str] = &["os", "profile"];

/// A set of keys: names, each with or without a value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cfg {
  keys: BTreeSet<(String, Option<String>)>,
}

impl Cfg {
  /// The keys the build alone decides: `os` and `unix`/`windows`.
  pub fn for_build() -> Self {
    let mut cfg = Self::default();
    cfg.set("os", Some(std::env::consts::OS));
    match std::env::consts::FAMILY {
      "unix" => cfg.set("unix", None),
      "windows" => cfg.set("windows", None),
      _ => {}
    }
    cfg
  }

  pub fn set(&mut self, name: &str, value: Option<&str>) {
    self.keys.insert((name.to_owned(), value.map(str::to_owned)));
  }

  /// Remove every value of `name` (a host replacing `profile` once its final
  /// selection is known).
  pub fn unset(&mut self, name: &str) {
    self.keys.retain(|(n, _)| n != name);
  }

  /// Set a boolean key when `on`.
  pub fn flag(&mut self, name: &str, on: bool) {
    if on {
      self.set(name, None);
    }
  }

  /// Every key, in order: `(name, value)`.
  pub fn keys(&self) -> impl Iterator<Item = (&str, Option<&str>)> {
    self.keys.iter().map(|(n, v)| (n.as_str(), v.as_deref()))
  }

  fn has(&self, name: &str, value: Option<&str>) -> bool {
    self.keys.iter().any(|(n, v)| n == name && v.as_deref() == value)
  }

  fn names(&self, name: &str) -> bool {
    self.keys.iter().any(|(n, _)| n == name)
  }

  /// Evaluate a predicate against this set.
  pub fn eval(&self, pred: &Pred) -> Result<bool, CfgError> {
    match pred {
      Pred::Name(name) => {
        self.check_name(name)?;
        if VALUED.contains(&name.as_str()) {
          return Err(CfgError::NeedsValue(name.clone()));
        }
        Ok(self.has(name, None))
      }
      Pred::Eq(name, value) => {
        self.check_name(name)?;
        Ok(self.has(name, Some(value)))
      }
      Pred::All(preds) => {
        for pred in preds {
          if !self.eval(pred)? {
            return Ok(false);
          }
        }
        Ok(true)
      }
      Pred::Any(preds) => {
        for pred in preds {
          if self.eval(pred)? {
            return Ok(true);
          }
        }
        Ok(false)
      }
      Pred::Not(pred) => Ok(!self.eval(pred)?),
    }
  }

  /// A name that is not derived and not set is a typo of a derived key when it
  /// is one edit from it, or two edits when both names are six letters or
  /// more: `sesion` is `session`, but `host` is not `os`.
  fn check_name(&self, name: &str) -> Result<(), CfgError> {
    if DERIVED.contains(&name) || self.names(name) {
      return Ok(());
    }
    let near = |known: &&&str| match edit_distance(name, known) {
      1 => true,
      2 => name.len() >= 6 && known.len() >= 6,
      _ => false,
    };
    match DERIVED.iter().find(near) {
      Some(known) => Err(CfgError::Unknown {
        name: name.to_owned(),
        suggestion: (*known).to_owned(),
      }),
      None => Ok(()),
    }
  }
}

static ACTIVE: RwLock<Option<Cfg>> = RwLock::new(None);

/// Install this process's keys. The host calls it once it knows how it was
/// started; a session engine installs again with its session's keys before it
/// reads any rc.
pub fn install(cfg: Cfg) {
  *ACTIVE.write().unwrap_or_else(|e| e.into_inner()) = Some(cfg);
}

/// This process's keys: the installed set, or the build's keys when the host
/// installed none.
pub fn active() -> Cfg {
  ACTIVE
    .read()
    .unwrap_or_else(|e| e.into_inner())
    .clone()
    .unwrap_or_else(Cfg::for_build)
}

/// A cfg predicate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pred {
  Name(String),
  Eq(String, String),
  All(Vec<Pred>),
  Any(Vec<Pred>),
  Not(Box<Pred>),
}

/// The shape of a form, as far as a predicate needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
  Symbol(String),
  String(String),
  List(Vec<Node>),
  /// Anything else (a number, a map, …): never valid in a predicate.
  Other(String),
}

impl Pred {
  /// Read the arguments of `(@cfg …)` or `(cfg? …)`: one predicate, or the
  /// three-word key test `name = "value"`.
  pub fn from_args(args: &[Node]) -> Result<Self, CfgError> {
    match args {
      [one] => Self::from_node(one),
      [Node::Symbol(_), Node::Symbol(eq), _] if eq == "=" => key_value(args),
      [] => Err(CfgError::Shape("a predicate is missing".into())),
      _ => Err(CfgError::Shape(
        "one predicate expected; combine several with (all …) or (any …)".into(),
      )),
    }
  }

  fn from_node(node: &Node) -> Result<Self, CfgError> {
    match node {
      Node::Symbol(name) => Ok(Pred::Name(name.clone())),
      Node::List(items) => match items.as_slice() {
        [Node::Symbol(_), Node::Symbol(eq), _] if eq == "=" => key_value(items),
        [Node::Symbol(head), rest @ ..] if head == "all" || head == "any" => {
          let preds = rest.iter().map(Self::from_node).collect::<Result<Vec<_>, _>>()?;
          Ok(if head == "all" { Pred::All(preds) } else { Pred::Any(preds) })
        }
        [Node::Symbol(head), one] if head == "not" => Ok(Pred::Not(Box::new(Self::from_node(one)?))),
        [Node::Symbol(head), ..] if head == "not" => {
          Err(CfgError::Shape("(not P) takes exactly one predicate".into()))
        }
        _ => Err(CfgError::Shape(format!(
          "`{}` is not a predicate: expected a name, (name = \"value\"), (all …), (any …) or (not …)",
          render(node)
        ))),
      },
      other => Err(CfgError::Shape(format!(
        "`{}` is not a predicate: a key is a bare name",
        render(other)
      ))),
    }
  }
}

fn key_value(items: &[Node]) -> Result<Pred, CfgError> {
  match items {
    [Node::Symbol(name), _, Node::String(value)] => Ok(Pred::Eq(name.clone(), value.clone())),
    [Node::Symbol(name), _, other] => Err(CfgError::Shape(format!(
      "({name} = …) compares with a string: ({name} = \"{}\")",
      render(other)
    ))),
    _ => unreachable!("callers match the key = value shape"),
  }
}

fn render(node: &Node) -> String {
  match node {
    Node::Symbol(s) | Node::Other(s) => s.clone(),
    Node::String(s) => format!("{s:?}"),
    Node::List(items) => format!("({})", items.iter().map(render).collect::<Vec<_>>().join(" ")),
  }
}

/// Why a cfg form or spec was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CfgError {
  /// A near-miss of a derived key.
  Unknown { name: String, suggestion: String },
  /// A valued key used bare (`(@cfg os)`).
  NeedsValue(String),
  /// A malformed predicate.
  Shape(String),
  /// `(@cfg …)` with no form after it, or something other than a form.
  Dangling { line: usize },
  /// The source around a `(@cfg …)` does not parse.
  Syntax { line: usize, detail: String },
  /// A user key that is not a plain name, or that names a derived key.
  Spec(String),
}

impl fmt::Display for CfgError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      CfgError::Unknown { name, suggestion } => {
        write!(f, "unknown cfg key `{name}` — did you mean `{suggestion}`?")
      }
      CfgError::NeedsValue(name) => {
        write!(f, "cfg key `{name}` has a value: write ({name} = \"…\")")
      }
      CfgError::Shape(detail) => write!(f, "cfg: {detail}"),
      CfgError::Dangling { line } => write!(
        f,
        "line {line}: (@cfg …) applies to the form after it, and none follows"
      ),
      CfgError::Syntax { line, detail } => write!(f, "line {line}: (@cfg …) does not parse: {detail}"),
      CfgError::Spec(detail) => write!(f, "cfg: {detail}"),
    }
  }
}

impl std::error::Error for CfgError {}

/// Read user keys from `--cfg` words or `TSH_CFG`: whitespace-separated
/// `name` or `name=value` (`name="two words"` keeps its spaces). A derived
/// key cannot be set: it says how tsh was started, and `--cfg` would lie.
pub fn parse_user_spec(spec: &str) -> Result<Vec<(String, Option<String>)>, CfgError> {
  let mut out = Vec::new();
  let mut chars = spec.chars().peekable();
  loop {
    while chars.next_if(|c| c.is_whitespace()).is_some() {}
    if chars.peek().is_none() {
      return Ok(out);
    }
    let mut name = String::new();
    while let Some(c) = chars.next_if(|c| !c.is_whitespace() && *c != '=') {
      name.push(c);
    }
    let value = if chars.next_if_eq(&'=').is_some() {
      let mut value = String::new();
      if chars.next_if_eq(&'"').is_some() {
        loop {
          match chars.next() {
            Some('"') => break,
            Some('\\') => {
              if matches!(chars.peek(), Some('\\' | '"')) {
                value.push(chars.next().expect("peeked escape"));
              } else {
                // Keep literal path backslashes unless they escape a quote or backslash.
                value.push('\\');
              }
            }
            Some(c) => value.push(c),
            None => return Err(CfgError::Spec(format!("`{name}=\"…` has no closing quote"))),
          }
        }
      } else {
        while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
          value.push(c);
        }
      }
      Some(value)
    } else {
      None
    };
    if !is_key_name(&name) {
      return Err(CfgError::Spec(format!(
        "`{name}` is not a cfg key: a key is a lowercase name like `work` or `gpu-host`"
      )));
    }
    if DERIVED.contains(&name.as_str()) {
      return Err(CfgError::Spec(format!(
        "`{name}` is derived from how tsh starts and cannot be set with --cfg or TSH_CFG"
      )));
    }
    out.push((name, value));
  }
}

/// Encode one cfg key for parse_user_spec, including quotes and backslashes.
/// Quoted values escape only quotes and backslashes; other backslashes stay literal.
pub fn format_user_spec(name: &str, value: Option<&str>) -> String {
  let Some(value) = value else { return name.to_owned() };
  let mut out = format!("{name}=\"");
  for ch in value.chars() {
    if matches!(ch, '\\' | '"') {
      out.push('\\');
    }
    out.push(ch);
  }
  out.push('"');
  out
}

fn is_key_name(name: &str) -> bool {
  let mut chars = name.chars();
  chars.next().is_some_and(|c| c.is_ascii_lowercase())
    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Remove every top-level form whose `(@cfg P)` is false, and every
/// `(@cfg …)` form, from `source`. Removed text becomes spaces (newlines
/// stay), so every remaining form keeps its line and column. Source without
/// `(@cfg` is returned unchanged without being scanned.
pub fn resolve_source(source: &str, cfg: &Cfg) -> Result<String, CfgError> {
  if !source.contains("(@cfg") {
    return Ok(source.to_owned());
  }
  let forms = crate::source::top_level_lists(source);
  let mut blank: Vec<Range<usize>> = Vec::new();
  let mut i = 0;
  while i < forms.len() {
    let range = forms[i].clone();
    let text = &source[range.clone()];
    if !is_cfg_head(text) {
      i += 1;
      continue;
    }
    let line = line_of(source, range.start);
    let args = cfg_args(text).map_err(|detail| CfgError::Syntax { line, detail })?;
    let keep = cfg.eval(&Pred::from_args(&args)?).map_err(|e| at_line(e, line))?;
    blank.push(range.clone());
    let Some(next) = forms.get(i + 1) else {
      return Err(CfgError::Dangling { line });
    };
    // Only whitespace and comments may sit between the two forms.
    if crate::source::lex(&source[range.end..next.start]).iter().next().is_some() {
      return Err(CfgError::Dangling { line });
    }
    if is_cfg_head(&source[next.clone()]) {
      // Stacked attributes: the next `(@cfg …)` gates the same form, so a
      // false one removes everything up to and including that form.
      if !keep {
        let mut j = i + 1;
        while j < forms.len() && is_cfg_head(&source[forms[j].clone()]) {
          blank.push(forms[j].clone());
          j += 1;
        }
        let Some(target) = forms.get(j) else {
          return Err(CfgError::Dangling { line });
        };
        blank.push(target.clone());
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if !keep {
      blank.push(next.clone());
    }
    i += 2;
  }
  let mut out: Vec<u8> = source.as_bytes().to_vec();
  for range in blank {
    for b in &mut out[range] {
      if *b != b'\n' {
        *b = b' ';
      }
    }
  }
  // Blanking whole forms replaces complete UTF-8 sequences with spaces.
  Ok(String::from_utf8(out).expect("blanked whole forms"))
}

fn at_line(error: CfgError, line: usize) -> CfgError {
  match error {
    CfgError::Unknown { .. } | CfgError::NeedsValue(_) | CfgError::Shape(_) => {
      CfgError::Syntax { line, detail: error.to_string() }
    }
    other => other,
  }
}

fn is_cfg_head(form: &str) -> bool {
  form
    .strip_prefix("(@cfg")
    .is_some_and(|rest| rest.starts_with(|c: char| c.is_whitespace() || c == ')' || c == '('))
}

fn line_of(source: &str, at: usize) -> usize {
  source[..at].bytes().filter(|b| *b == b'\n').count() + 1
}

/// The arguments of one `(@cfg …)` form, read with the real reader.
fn cfg_args(form: &str) -> Result<Vec<Node>, String> {
  use string_interner::StringInterner;
  use string_interner::backend::StringBackend;
  use string_interner::symbol::SymbolU32;
  let mut interner = StringInterner::<StringBackend>::new();
  let parsed = crate::Runtime::<SymbolU32, StringBackend>::parse(None, form, &mut interner)
    .map_err(|e| format!("{e:?}"))?;
  let [crate::SExpression::List(items)] = parsed.as_slice() else {
    return Err("expected one list".into());
  };
  Ok(items[1..].iter().map(|item| node_of(item, &interner)).collect())
}

fn node_of(
  expr: &crate::SExpression<string_interner::symbol::SymbolU32>,
  interner: &string_interner::StringInterner<string_interner::backend::StringBackend>,
) -> Node {
  use crate::{Literal, SExpression};
  match expr {
    SExpression::Literal(Literal::Symbol(sym)) => {
      Node::Symbol(interner.resolve(*sym).unwrap_or_default().to_owned())
    }
    SExpression::Literal(Literal::String(s)) => Node::String(s.clone()),
    SExpression::List(items) => Node::List(items.iter().map(|i| node_of(i, interner)).collect()),
    SExpression::Literal(other) => Node::Other(format!("{other:?}")),
  }
}

fn edit_distance(a: &str, b: &str) -> usize {
  let b: Vec<char> = b.chars().collect();
  let mut row: Vec<usize> = (0..=b.len()).collect();
  for (i, ca) in a.chars().enumerate() {
    let mut prev = row[0];
    row[0] = i + 1;
    for (j, cb) in b.iter().enumerate() {
      let cur = row[j + 1];
      row[j + 1] = if ca == *cb { prev } else { 1 + prev.min(row[j]).min(row[j + 1]) };
      prev = cur;
    }
  }
  row[b.len()]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn keys(pairs: &[(&str, Option<&str>)]) -> Cfg {
    let mut cfg = Cfg::default();
    for (name, value) in pairs {
      cfg.set(name, *value);
    }
    cfg
  }

  fn session_on_macos() -> Cfg {
    keys(&[("session", None), ("unix", None), ("os", Some("macos"))])
  }

  #[test]
  fn a_false_cfg_removes_its_form_and_keeps_every_line_number() {
    let src = "(let a 1)\n(@cfg login)\n(lane.declare \"x\"\n  :handler \"acp\")\n(let b 2)\n";
    let out = resolve_source(src, &session_on_macos()).unwrap();
    assert_eq!(out.lines().count(), src.lines().count());
    assert!(out.contains("(let a 1)") && out.contains("(let b 2)"));
    assert!(!out.contains("lane.declare") && !out.contains("@cfg"));
  }

  #[test]
  fn a_true_cfg_keeps_its_form_and_drops_only_itself() {
    let src = "(@cfg session) (lane.declare \"x\")";
    let out = resolve_source(src, &session_on_macos()).unwrap();
    assert_eq!(out.trim(), "(lane.declare \"x\")");
  }

  #[test]
  fn predicates_combine_and_compare_values() {
    let cfg = session_on_macos();
    let yes = |src: &str| !resolve_source(&format!("{src} (x)"), &cfg).unwrap().contains("@cfg") &&
      resolve_source(&format!("{src} (x)"), &cfg).unwrap().contains("(x)");
    assert!(yes("(@cfg (all session unix))"));
    assert!(yes("(@cfg (any login session))"));
    assert!(yes("(@cfg (not login))"));
    assert!(yes("(@cfg os = \"macos\")"));
    assert!(yes("(@cfg (all session (os = \"macos\")))"));
    assert!(!yes("(@cfg (os = \"linux\"))"));
    assert!(!yes("(@cfg work)"));
  }

  #[test]
  fn user_keys_come_from_the_spec_and_cannot_claim_a_derived_name() {
    assert_eq!(
      parse_user_spec("  work host=rwc-05 label=\"two words\" ").unwrap(),
      vec![
        ("work".into(), None),
        ("host".into(), Some("rwc-05".into())),
        ("label".into(), Some("two words".into())),
      ]
    );
    assert!(parse_user_spec("session").unwrap_err().to_string().contains("derived"));
    assert!(parse_user_spec("Work").is_err());
    assert!(parse_user_spec("x=\"open").is_err());
  }

  #[test]
  fn recorded_cfg_values_round_trip_quotes_backslashes_and_whitespace() {
    for value in ["", "a\"b", "a \"quoted\" value", r"C:\work\tsh", r"\\server\share",
                  "line\nbreak\tand spaces", "é😀", r#"\""#] {
      let spec = format_user_spec("label", Some(value));
      assert_eq!(
        parse_user_spec(&spec).unwrap(),
        vec![("label".to_owned(), Some(value.to_owned()))],
        "{spec:?}",
      );
    }
    assert_eq!(parse_user_spec(&format_user_spec("work", None)).unwrap(),
               vec![("work".to_owned(), None)]);
    assert_eq!(parse_user_spec(r#"path="C:\work\tsh""#).unwrap(),
               vec![("path".to_owned(), Some(r"C:\work\tsh".to_owned()))]);
  }

  #[test]
  fn a_typo_of_a_derived_key_is_loud_and_an_unset_user_key_is_false() {
    let cfg = session_on_macos();
    let err = resolve_source("(@cfg sesion) (x)", &cfg).unwrap_err().to_string();
    assert!(err.contains("did you mean `session`"), "{err}");
    assert!(err.starts_with("line 1"), "{err}");
    assert!(!resolve_source("(@cfg gpu) (x)", &cfg).unwrap().contains("(x)"));
    // Short user keys near a short derived key are not typos.
    assert!(!resolve_source("(@cfg host = \"a\") (x)", &cfg).unwrap().contains("(x)"));
    assert!(resolve_source("(@cfg interactve) (x)", &cfg).is_err());
    assert!(resolve_source("(@cfg logn) (x)", &cfg).is_err());
  }

  #[test]
  fn valued_keys_need_a_value() {
    let err = resolve_source("(@cfg os) (x)", &session_on_macos()).unwrap_err();
    assert!(err.to_string().contains("(os = \""), "{err}");
  }

  #[test]
  fn a_cfg_must_be_followed_by_a_form() {
    assert_eq!(
      resolve_source("(x)\n(@cfg session)\n", &session_on_macos()).unwrap_err(),
      CfgError::Dangling { line: 2 }
    );
    assert!(resolve_source("(@cfg session) bare (x)", &session_on_macos()).is_err());
  }

  #[test]
  fn comments_and_strings_never_confuse_the_scan() {
    let src = "(@cfg login) ; drop the next form\n(echo \"(@cfg login) ) (\")\n(keep)";
    let out = resolve_source(src, &session_on_macos()).unwrap();
    assert!(!out.contains("echo"));
    assert!(out.contains("(keep)"));
  }

  #[test]
  fn stacked_cfgs_all_gate_the_same_form() {
    let cfg = session_on_macos();
    let both = resolve_source("(@cfg session) (@cfg unix) (x) (y)", &cfg).unwrap();
    assert!(both.contains("(x)") && both.contains("(y)"));
    let one_false = resolve_source("(@cfg session) (@cfg login) (x) (y)", &cfg).unwrap();
    assert!(!one_false.contains("(x)") && one_false.contains("(y)"));
    let first_false = resolve_source("(@cfg login) (@cfg session) (x) (y)", &cfg).unwrap();
    assert!(!first_false.contains("(x)") && first_false.contains("(y)"));
  }

  #[test]
  fn source_without_cfg_is_untouched() {
    let src = "(let a 1) ; @cfg in a comment\n";
    assert_eq!(resolve_source(src, &Cfg::default()).unwrap(), src);
  }

  /// The interpreter forms read the installed keys. One test owns the
  /// process-wide install so parallel tests never race on it.
  #[test]
  fn the_interpreter_forms_read_the_installed_keys() {
    use crate::{Runtime, Value};
    use string_interner::backend::StringBackend;
    use string_interner::symbol::SymbolU32;
    let mut cfg = session_on_macos();
    cfg.set("host", Some("rwc-05"));
    install(cfg);
    let eval = |src: &str| Runtime::<SymbolU32, StringBackend>::eval(None, src);
    let last = |src: &str| eval(src).expect(src).pop().expect(src);
    assert!(matches!(last("(cfg? session)"), Value::Boolean(true)));
    assert!(matches!(last("(cfg? (all unix (not login)))"), Value::Boolean(true)));
    assert!(matches!(last("(cfg? host = \"rwc-05\")"), Value::Boolean(true)));
    assert!(matches!(last("(cfg? work)"), Value::Boolean(false)));
    assert!(format!("{:?}", eval("(cfg? sesion)").unwrap_err()).contains("did you mean `session`"));
    let Value::Map(map) = last("(cfg)") else { panic!("(cfg) is a map") };
    assert!(matches!(map.get("os"), Some(Value::String(os)) if os == "macos"));
    assert!(matches!(map.get("session"), Some(Value::Boolean(true))));
    assert!(format!("{:?}", eval("(begin (@cfg session) (x))").unwrap_err()).contains("(when (cfg? …)"));
    // `cfg` stays an ordinary name everywhere else.
    assert!(matches!(last("(let cfg (lambda (x) x)) (cfg 7)"), Value::Integer(7)));
    install(Cfg::for_build());
  }

  #[test]
  fn the_build_keys_name_this_platform() {
    let cfg = Cfg::for_build();
    assert!(cfg.has("os", Some(std::env::consts::OS)));
  }
}
