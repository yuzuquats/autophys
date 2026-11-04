//! The posix reader: a shell-style command line lexed into the *same*
//! [`SExpression`] the lisp reader produces, so both syntaxes feed one
//! evaluator. A line becomes a call list — the first word is the head
//! `Symbol`, each later bare word a `String` literal, a bare unquoted
//! expanded words become ordinary `str`, `apply`, and runtime-library calls.
//!
//! Quoting follows Bash: single quotes are literal, double quotes preserve
//! non-special backslashes, and `$'…'` decodes ANSI-C escapes. An unquoted
//! `\` escapes the next char; backslash-newline continues a line. Double quotes
//! allow expansions but suppress splitting; only unquoted expansion parts are
//! marked for the Bash runtime library's IFS splitting.
//!
//! Tilde expansion (the `_with_home` doors) is recognised HERE, at the
//! tokenizer layer, because only the scanner knows quoting: a word whose
//! FIRST char is an **unquoted** `~` (and, in an assignment-shaped word, a
//! `~` after the `=` or an unquoted `:`) lowers to a runtime lookup,
//! `(std.sh.tilde "PREFIX")`; `'~'`, `"~"`, `\~` and mid-word `a~b` stay literal.
//! The runtime resolves `~` from `$HOME` as it stands when the word is
//! expanded (so an in-script `HOME=` is followed on the same line and in
//! function bodies), `~+`/`~-` from `PWD`/`OLDPWD`, `~N`/`~+N`/`~-N` from the
//! directory stack and `~user` from the user database, leaving the prefix
//! literal when there is nothing to name. `home` only enables the bare home
//! form: `Some(_)` lowers it, `None` leaves it literal; its text is not read.
//! Lisp forms never come through this reader, so lisp strings are untouched
//! by construction.

use crate::grammar::{Literal, SExpression};
use crate::symbol::{Backend, Symbol};
use string_interner::StringInterner;

mod redirection;
mod brace;
mod condition;
mod compound;
mod print;
mod extglob;
pub use print::{FunctionStyle, format_shell_function};
pub mod arith;
mod param;
mod array;
mod raw_macro;
pub use raw_macro::{RAW_MACROS, mask_raw_macros, raw_macro_close, raw_macro_head};

/// A parenthesised statement stays Lisp unless it contains Bash syntax.
/// List heads are Lisp symbols; strings and Lisp comments protect operators.
/// Comments follow WAT (I10): `;;` and nestable `(; … ;)`. A single `;` after
/// code is not lisp, so it makes the statement plainly bash, like `&&` or `|`;
/// one that starts a line is the deprecated spelling of `;;`. A `;;` selects
/// Bash only when stripping it destroys a balanced form (or leaves a bare word
/// after the forms), as in a `case` clause.
pub fn bash_paren_statement(source: &str) -> bool {
  // A raw macro's body (`(sh! a | b)`) is bash the macro owns, not the line's.
  let masked = mask_raw_macros(source);
  let source = masked.trim();
  if let Some(inner) = source.strip_prefix("((").and_then(|s| s.strip_suffix("))")) {
    if arith::validate(inner).is_ok() { return true; }
  }
  if !source.starts_with('(') { return false; }
  let chars: Vec<_> = source.chars().collect();
  let mut shell_chars = chars.clone();
  let mut quote = None;
  let mut heads = Vec::new();
  let mut comment = false;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if c == '\\' && quote != Some('\'') { i += 2; continue; }
    if let Some(q) = quote {
      if c == q { quote = None; }
    } else {
      match c {
        '\'' | '"' => {
          quote = Some(c);
          if let Some(head) = heads.last_mut() { *head = false; }
        }
        '(' if chars.get(i + 1) == Some(&';') => {
          let start = i;
          i = block_comment_end(&chars, i);
          shell_chars[start..i].fill(' ');
          continue;
        }
        '(' => {
          if let Some(head) = heads.last_mut() { *head = false; }
          heads.push(true);
        }
        ')' => { heads.pop(); }
        ';' => {
          let inline = chars[..i].iter().rev().take_while(|c| **c != '\n')
            .any(|c| !c.is_whitespace());
          // A single `;` after code is not lisp: the statement is bash.
          if inline && chars.get(i + 1) != Some(&';') { return true; }
          comment |= inline;
          let start = i;
          while i < chars.len() && chars[i] != '\n' { i += 1; }
          shell_chars[start..i].fill(' ');
          continue;
        }
        c if c.is_whitespace() => {}
        _ if heads.last() == Some(&true) => {
          // Consume the whole head symbol, including comparison operators.
          *heads.last_mut().unwrap() = false;
          while i < chars.len() && !chars[i].is_whitespace()
            && !matches!(chars[i], '(' | ')' | ';' | '"' | '\'') { i += 1; }
          continue;
        }
        '>' if chars.get(i + 1).is_some_and(|c| c.is_whitespace())
          && chars[..i].iter().rev().take_while(|c| **c != '\n')
            .all(|c| c.is_whitespace())
          && chars[i + 1..].iter().copied().find(|c| !c.is_whitespace()) == Some('(') => {}
        // A standalone type arrow belongs to a Lisp signature. Explicit
        // Bash sources never use this mixed-language classifier; attached
        // shell redirects such as `->file` still take the Bash path here.
        '-' if chars.get(i + 1) == Some(&'>')
          && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(')
          && chars.get(i + 2).is_none_or(|c| c.is_whitespace() || *c == ')') => {
            i += 2;
            continue;
          }
        '|' | '&' | '<' | '>' => return true,
        _ => {}
      }
    }
    i += 1;
  }
  if !comment { return false; }
  // Use Lisp's own string/comment rules for the balance check: apostrophes
  // quote forms in Lisp, rather than introducing shell strings.
  let mut depth = 0i32;
  let mut string = false;
  let mut closed = false;
  let mut trailing = false;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if string {
      if c == '\\' { i += 2; continue; }
      if c == '"' { string = false; }
    } else if c == ';' {
      while i < chars.len() && chars[i] != '\n' { i += 1; }
      continue;
    } else if c == '(' && chars.get(i + 1) == Some(&';') {
      i = block_comment_end(&chars, i);
      continue;
    } else if c == '"' {
      string = true;
      trailing |= closed && depth == 0;
    } else if !c.is_whitespace() {
      // Several forms on a line stay lisp; a bare word after them does not.
      trailing |= closed && depth == 0 && c != '(';
      if c == '(' { depth += 1; }
      if c == ')' { depth -= 1; closed |= depth == 0; }
    }
    i += 1;
  }
  if depth == 0 && !string && !trailing { return false; }
  if trailing || depth < 0 { return true; }
  // An incomplete Lisp form remains Lisp while the chunker gathers it.
  // While gathering an incomplete form, parentheses in standalone Lisp
  // comments or `;;` must not make the Bash candidate appear complete.
  scan_balanced(&shell_chars, 1).is_ok()
}
/// Index just past the `;)` closing the block comment opened at `open`
/// (nested `(; … ;)` counted), or the end of `chars` when it never closes.
fn block_comment_end(chars: &[char], open: usize) -> usize {
  let mut depth = 0usize;
  let mut i = open;
  while i + 1 < chars.len() {
    match (chars[i], chars[i + 1]) {
      ('(', ';') => { depth += 1; i += 2; }
      (';', ')') => {
        depth -= 1;
        i += 2;
        if depth == 0 { return i; }
      }
      _ => i += 1,
    }
  }
  chars.len()
}
#[cfg(test)]
mod compound_tests;

#[cfg(test)]
mod script_builtins_tests;
#[cfg(test)]
mod corpus_zero_tests;

/// Why a posix line could not be read into an s-expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PosixReadError {
  /// The line held no words (blank / whitespace only).
  Empty,
  /// A `'` or `"` was never closed.
  UnterminatedQuote,
  /// ANSI-C byte escapes produced text outside the string value's UTF-8 domain.
  NonUtf8AnsiCQuote,
  /// A `$(` had no matching `)`.
  UnbalancedSubstitution,
  /// A here-document has not reached its quote-removed delimiter yet.
  IncompleteHeredoc(String),
  /// A compound command is waiting for its closing reserved word.
  IncompleteCompound(String),
  /// A `name=a b …` env-prefixed command (posix) — reserved, not yet read.
  EnvPrefixUnsupported,
  /// A flow operator appeared without a command on its left or right.
  MissingFlowOperand(&'static str),
  /// Shell syntax that this command-line reader does not lower.
  ShellOperatorUnsupported(String),
  /// A token where the grammar allows none (a stray `)`, a `|` that starts a
  /// command): bash's `syntax error near unexpected token`. Unlike
  /// [`Self::MissingFlowOperand`] it never asks a reader for more input. An
  /// empty token is the end of the input.
  UnexpectedToken(String),
  /// An active brace list or sequence, before quote removal.
  BraceExpansionUnsupported,
  /// A parameter/arithmetic construct without a faithful lowering yet.
  ShellExpansionUnsupported(String),
}

impl std::fmt::Display for PosixReadError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      PosixReadError::Empty => f.write_str("empty posix line"),
      PosixReadError::UnterminatedQuote => f.write_str("unterminated quote"),
      PosixReadError::NonUtf8AnsiCQuote => {
        f.write_str("ANSI-C quote is not valid UTF-8 — byte-valued words are not yet supported")
      }
      PosixReadError::UnbalancedSubstitution => f.write_str("unbalanced `$(...)`"),
      PosixReadError::IncompleteCompound(word) => write!(f, "unterminated compound command (wanted `{word}`)"),
      PosixReadError::IncompleteHeredoc(word) => write!(f, "unterminated here-document (wanted `{word}`)"),
      PosixReadError::EnvPrefixUnsupported => {
        f.write_str("env-prefixed command (name=val cmd …) not yet supported")
      }
      PosixReadError::MissingFlowOperand(op) => {
        write!(f, "flow operator `{op}` is missing a command")
      }
      PosixReadError::ShellOperatorUnsupported(op) => {
        write!(
          f,
          "shell operator `{op}` is not supported on a tsh command line — use a lisp form, or quote it"
        )
      }
      PosixReadError::UnexpectedToken(token) if token.is_empty() => {
        f.write_str("syntax error: unexpected end of file")
      }
      PosixReadError::UnexpectedToken(token) => {
        // bash names a newline token `newline`.
        let token = if token == "\n" { "newline" } else { token };
        write!(f, "syntax error near unexpected token `{token}'")
      }
      PosixReadError::BraceExpansionUnsupported => f.write_str(
        "brace expansion is not supported on a tsh command line — use a lisp form, or quote it",
      ),
      PosixReadError::ShellExpansionUnsupported(construct) => {
        write!(f, "shell expansion `{construct}` is not supported yet")
      }
    }
  }
}
impl std::error::Error for PosixReadError {}

/// The shell-shaped control operators that have a canonical tsh flow form.
///
/// This is deliberately smaller than POSIX shell grammar. Redirections lower
/// onto a separate ordered wrapper; background execution remains refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellOperator {
  Pipe,
  AndIf,
  OrIf,
  Sequence,
  Background,
}

impl ShellOperator {
  fn source(self) -> &'static str {
    match self {
      ShellOperator::Pipe => "|",
      ShellOperator::AndIf => "&&",
      ShellOperator::OrIf => "||",
      ShellOperator::Sequence => ";",
      ShellOperator::Background => "&",
    }
  }
}

/// A shell-shaped statement after precedence parsing but before execution.
/// Each leaf is already the same canonical [`SExpression`] the Lisp reader
/// would produce for that command. Flow nodes retain execution structure so a
/// later async executor never has to recover it from source text.
#[derive(Debug, Clone, PartialEq)]
pub enum ShellExpression<S: Symbol> {
  Command(SExpression<S>),
  Background(Box<ShellExpression<S>>),
  Pipeline(Vec<ShellExpression<S>>),
  Not(Box<ShellExpression<S>>),
  AndIf(Box<ShellExpression<S>>, Box<ShellExpression<S>>),
  OrIf(Box<ShellExpression<S>>, Box<ShellExpression<S>>),
  Sequence(Vec<ShellExpression<S>>),
}

#[derive(Debug, Clone, PartialEq)]
enum FlowToken {
  Command(String),
  Operator(ShellOperator),
  Not,
}

/// One lexed posix atom, before placement decides symbol-vs-literal.
enum Atom<S: Symbol> {
  /// A plain word (quotes already processed).
  Word(String),
  /// A literal word written with quoting or escaping (`'ls'`, `"ls"`, `\ls`,
  /// `l\s`). Its value is the same string; only a command word keeps the
  /// difference, as [`QUOTED_WORD`], because bash expands aliases only on
  /// unquoted command words.
  Quoted(String),
  /// A runtime-selected brace word yields already split fields.
  Fields(SExpression<S>, SExpression<S>),
  /// Joined word parts; `true` marks an unquoted expansion, never literal text.
  Expanded(Vec<(SExpression<S>, bool)>),
  /// Word parts retain independent splitting and pathname-pattern eligibility.
  Glob(Vec<(SExpression<S>, bool, bool)>),
}

#[derive(Clone, Copy)]
enum State {
  Delimiter,
  Unquoted,
  Single,
  Double,
  Backslash,         // after `\` that opened a word
  UnquotedBackslash, // after `\` inside an unquoted word
  DoubleBackslash,   // after `\` inside a double-quoted word
}

/// Read one posix command line into the canonical [`SExpression`]
/// `(std.sh.cmd "name" "arg" …)`: the name and each plain word are `String`
/// literals; expanded arguments lower to string construction and runtime-library
/// calls. An empty line is [`PosixReadError::Empty`].
pub fn read_posix<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  read_posix_with_home(line, interner, None)
}

/// [`read_posix`] with tilde expansion: an unquoted word-leading `~` (bare `~`
/// or `~/rest`) lowers to a runtime `$HOME` lookup; quoted/mid-word tildes stay
/// literal (see the module doc). `Some(_)` home enables the lowering (its text
/// is not read); `None` leaves the bare home form literal.
pub fn read_posix_with_home<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let atoms = scan(line, interner, home)?;
  if matches!(atoms.first(), Some(Atom::Expanded(_) | Atom::Glob(_) | Atom::Fields(_, _))) {
    let verbatim = compound::data_arguments(line)?;
    return atoms_to_call(scan(&verbatim, interner, home)?, interner);
  }
  atoms_to_call(atoms, interner)
}

/// Read a pre-split command. The first word names the command (a `Symbol`
/// head: this door is a registered name, not a bash word); every later word is
/// a literal string. The caller's shell already processed quoting, expansion
/// and splitting, so this door never applies those rules again.
pub fn read_posix_argv<S, B>(
  argv: &[String],
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let Some((head, rest)) = argv.split_first() else {
    return Err(PosixReadError::Empty);
  };
  // Placement makes only the head a symbol; argv operands stay literal.
  let mut atoms: Vec<Atom<S>> = vec![Atom::Word(head.clone())];
  for word in rest {
    push_pure_word(&mut atoms, word);
  }
  atoms_to_symbol_call(atoms, interner)
}

/// The marker on a command word that was quoted or escaped:
/// `'ls' -l` → `(std.sh.cmd (std.sh.word.quoted "ls") "-l")` (argv.md I12).
/// It resolves exactly as the bare string does; it exists so a literal macro
/// pattern on `std.sh.cmd` (aliases, D2a; `std.sh.display` clauses, D5)
/// matches only an unquoted command word, as bash's alias rule does.
pub const QUOTED_WORD: &str = "std.sh.word.quoted";

/// The bash dialect's control-flow forms (argv.md I17: one `std.sh` module for
/// the whole lowering vocabulary; these were `std.flow.*`). Their operands are
/// syntax, so hosts dispatch them rather than evaluate them as calls. The
/// reader writes `cmd &` as [`SPAWN_FORM`]; `std.sh.background` stays here
/// so a form compiled before I17 still runs.
pub const SH_FLOW_FORMS: &[&str] = &[
  "std.sh.seq", "std.sh.and", "std.sh.or", "std.sh.pipe", "std.sh.not", "std.sh.redirect",
  "std.sh.if", "std.sh.while", "std.sh.for", "std.sh.case", "std.sh.arm", "std.sh.group",
  "std.sh.function", "std.sh.test", "std.sh.condition", "std.sh.background", "std.sh.subshell",
  "std.sh.arithmetic", "std.sh.arithmetic-for", "std.sh.time", "std.sh.select", "std.sh.line",
];

/// bash's `cmd &` lowers to `(std.jobs.spawn STAGE)` (argv.md I17: where a
/// typed command covers the job the form lowers to it). With one compiled
/// stage as its operand the stage is syntax, as a flow form's operands are:
/// the host starts it as a background job, sets `$!` and returns status 0 at
/// once. With program words, `(std.jobs.spawn "sleep" "1")`, it is the typed
/// command and returns the `job/v1` value.
pub const SPAWN_FORM: &str = "std.jobs.spawn";

/// bash's `$!` lowers to `(std.jobs.last)` (argv.md I17): the pid of the most
/// recent background job as a word, empty when there is none.
pub const LAST_JOB_FORM: &str = "std.jobs.last";

/// The head a lowered command takes: the `std.sh.cmd` form a bash line
/// compiles to (argv.md I12), or a bare symbol for the doors whose head is a
/// registered name rather than a shell word (`unset`, the pre-split argv door).
#[derive(Clone, Copy, PartialEq)]
enum Head {
  Command,
  Symbol,
}

/// Place lexed atoms into a bash simple command, `(std.sh.cmd w0 w1 …)`: every
/// word is a string literal or its expansion form, the first naming the
/// command. A word that expands to fields (`std.sh.split`, a `${x:+…}` word)
/// is spliced where it stands; the runtime resolves the name by bash's lookup,
/// so nothing here makes the command word a symbol.
fn atoms_to_call<S, B>(
  atoms: Vec<Atom<S>>,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  place_atoms(atoms, interner, Head::Command)
}

/// Place lexed atoms into a call list whose head is a `Symbol`: atom `[0]`'s
/// plain word is the head; every later atom is its value s-expression (string
/// literal, or constructed word). Splitting uses ordinary `apply`/`append`, so
/// the evaluator itself has no Bash-specific argument-splicing rule.
fn atoms_to_symbol_call<S, B>(
  atoms: Vec<Atom<S>>,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  place_atoms(atoms, interner, Head::Symbol)
}

fn place_atoms<S, B>(
  atoms: Vec<Atom<S>>,
  interner: &mut StringInterner<B>,
  head: Head,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  if atoms.is_empty() {
    return Err(PosixReadError::Empty);
  }
  // The reader's own plan forms travel through this door as source text
  // (`heredocs_eof` prepends the EOF warning as a command word); they are
  // forms with symbol heads, never bash commands.
  let head = match atoms.first() {
    Some(Atom::Word(word)) if word == "std.sh.heredoc-warning" => Head::Symbol,
    _ => head,
  };
  let dynamic_head = matches!(atoms.first(), Some(Atom::Expanded(_) | Atom::Glob(_) | Atom::Fields(_, _)));
  let mut items = Vec::with_capacity(atoms.len());
  let mut split = false;
  for (idx, atom) in atoms.into_iter().enumerate() {
    let sexpr = match (idx, atom) {
      (0, Atom::Word(w) | Atom::Quoted(w)) if head == Head::Symbol => {
        SExpression::Literal(Literal::Symbol(interner.get_or_intern(&w)))
      }
      (0, Atom::Quoted(w)) => {
        call(QUOTED_WORD, vec![SExpression::Literal(Literal::String(w))], interner)
      }
      (_, Atom::Fields(value, _)) => { split = true; value },
      (_, Atom::Glob(parts)) => {
        split = true;
        let descriptors = parts
          .into_iter()
          .map(|(value, unquoted, glob)| {
            word_descriptor(value, unquoted, glob, interner)
          })
          .collect();
        let parts = call("list", descriptors, interner);
        call("std.sh.split", vec![parts], interner)
      }
      (_, Atom::Expanded(parts)) if parts.iter().any(|(_, unquoted)| *unquoted) => {
        split = true;
        let descriptors = parts
          .into_iter()
          .map(|(value, unquoted)| {
            call(
              "list",
              vec![SExpression::Literal(Literal::Boolean(unquoted)), value],
              interner,
            )
          })
          .collect();
        let parts = call("list", descriptors, interner);
        call("std.sh.split", vec![parts], interner)
      }
      (_, atom) => atom_to_value(atom, interner),
    };
    items.push(sexpr);
  }
  if head == Head::Command {
    return Ok(call("std.sh.cmd", items, interner));
  }
  if dynamic_head {
    return Ok(call("std.sh.cmd", vec![append_fields(items, interner)], interner));
  }
  if split {
    let head = items.remove(0);
    let argv = append_fields(items, interner);
    Ok(call("apply", vec![head, argv], interner))
  } else {
    Ok(SExpression::List(items))
  }
}

/// A word that expands to fields rather than one string.
pub(crate) fn is_fields_word<S, B>(value: &SExpression<S>, interner: &StringInterner<B>) -> bool
where
  S: Symbol,
  B: Backend<S>,
{
  is_call(value, "std.sh.split", interner) || is_call(value, "if", interner)
}

/// `(append (list w) fields …)`: every word as a field list, spliced in order.
fn append_fields<S, B>(
  items: Vec<SExpression<S>>,
  interner: &mut StringInterner<B>,
) -> SExpression<S>
where
  S: Symbol,
  B: Backend<S>,
{
  let fields = items
    .into_iter()
    .map(|value| {
      if is_fields_word(&value, interner) {
        value
      } else {
        call("list", vec![value], interner)
      }
    })
    .collect();
  call("append", fields, interner)
}

fn call<S, B>(
  name: &str,
  args: Vec<SExpression<S>>,
  interner: &mut StringInterner<B>,
) -> SExpression<S>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut items = vec![SExpression::Literal(Literal::Symbol(
    interner.get_or_intern(name),
  ))];
  items.extend(args);
  SExpression::List(items)
}

fn word_descriptor<S, B>(mut value: SExpression<S>, split: bool, glob: bool, interner: &mut StringInterner<B>) -> SExpression<S>
where S: Symbol, B: Backend<S> {
  if split && is_call(&value, "std.sh.positional", interner) {
    if let SExpression::List(items) = &mut value {
      if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "*") {
        items[1] = SExpression::Literal(Literal::String("*fields".into()));
      }
    }
  }
  let positional = param::fields(&value, interner)
    || is_call(&value, "std.sh.positional", interner)
    && matches!(&value, SExpression::List(items) if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "@" || name == "*fields"));
  let mut args = vec![SExpression::Literal(Literal::Boolean(split)), value, SExpression::Literal(Literal::Boolean(glob))];
  if positional { args.push(SExpression::Literal(Literal::Boolean(true))); }
  call("list", args, interner)
}

fn is_call<S, B>(value: &SExpression<S>, name: &str, interner: &StringInterner<B>) -> bool
where
  S: Symbol,
  B: Backend<S>,
{
  matches!(value, SExpression::List(items) if matches!(items.first(),
    Some(SExpression::Literal(Literal::Symbol(s))) if interner.resolve(*s) == Some(name)))
}

/// Read one posix **statement**: a posix assignment `name=<value>` lowers to
/// `(let name <value>)` — posix capture, e.g. `files=$(ls /tmp)` →
/// `(let files (ls "/tmp"))` — and anything else is a command line via
/// [`read_posix`]. The value is a single posix atom: a word (string), a `$name`
/// expansion. Assignment words are constructed without IFS splitting.
pub fn read_statement<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  read_statement_with_home(line, interner, None)
}

/// [`read_statement`] with tilde expansion — the door the shell's posix-line
/// evaluators use: `Some(_)` home lowers `~` to a runtime `$HOME` lookup
/// (`None` = the bare home form stays literal). Expansion applies wherever
/// the scanner runs — command args, `$(…)` sub-lines, and an assignment's rhs
/// (`p=~/x` captures the expanded path, as in a posix shell).
pub fn read_statement_with_home<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let (prepared, folds) = redirection::heredocs_eof_lines(line)?;
  let line = prepared.as_str();
  if let Some(compound) = compound::read_with_lines(line, interner, home, &[], &folds)? {
    return Ok(compound);
  }
  // Ordinary lines keep the existing word/assignment door and allocate no
  // execution plan. Quoted/escaped operators also retain that exact shape.
  if !line
    .chars()
    .any(|c| matches!(c, ';' | '|' | '&' | '!' | '\n'))
  {
    return read_simple_statement(line, interner, home);
  }
  let tokens = lex_prepared_flow_tokens(line)?;
  if let [FlowToken::Command(command)] = tokens.as_slice() {
    return read_simple_statement(command, interner, home);
  }
  let mut pos = 0;
  let expression = parse_sequence(&tokens, &mut pos, interner, home)?;
  Ok(lower_shell_expression(expression, interner))
}

fn read_simple_statement<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  if let Some(command) = condition::read(line, interner, home)? { return Ok(command); }
  if let Some(command) = redirection::read(line, interner, home)? {
    return Ok(command);
  }
  if let Some(array) = array::read_traced(line, interner, home)? { return Ok(array); }
  let head = line.trim_start().split_whitespace().next().unwrap_or("");
  if matches!(
    head,
    "if"
      | "then"
      | "else"
      | "elif"
      | "fi"
      | "for"
      | "select"
      | "while"
      | "until"
      | "do"
      | "in"
      | "done"
      | "case"
      | "esac"
      | "function"
      | "coproc"
      | "time"
      | "[["
      | "]]"
      | "{"
      | "}"
  ) {
    return Err(PosixReadError::ShellOperatorUnsupported(head.into()));
  }
  if matches!(head, "local" | "export" | "declare" | "typeset" | "readonly") {
    return read_declaration(line, interner, home);
  }
  if split_assignment(line).is_some() {
    return read_environment_prefix(line, interner, home);
  }
  if head == "set" && line.split_whitespace().nth(1) == Some("--") {
    return read_posix_with_home(&compound::data_arguments(line)?, interner, home);
  }
  if head == "unset" {
    let mut atoms = vec![Atom::Word("std.sh.unset".into())];
    atoms.extend(scan::<S, B>(
      line.trim_start()[head.len()..].trim_start(),
      interner,
      home,
    )?);
    return atoms_to_symbol_call(atoms, interner);
  }
  read_posix_with_home(line, interner, home)
}

fn read_declaration<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let chars = bash_line_chars(line)?;
  let mut atoms = Vec::new();
  let mut initializers = Vec::new();
  let mut i = 0;
  while i < chars.len() {
    if chars[i].is_whitespace() {
      i += 1;
      continue;
    }
    if chars[i] == '#' { break; }
    let mut end = redirection::word_end(&chars, i)?;
    if end == i {
      // An operator where a word belongs: never loop without consuming input.
      return Err(PosixReadError::UnexpectedToken(chars[i].to_string()));
    }
    let raw: String = chars[i..end].iter().collect();
    if let Some((name, _)) = raw
      .split_once("=(")
      .filter(|(name, _)| compound::identifier(name.strip_suffix('+').unwrap_or(name)))
    {
      let open = i + name.chars().count() + 1;
      end = scan_balanced(&chars, open + 1)? + 1;
      let raw: String = chars[i..end].iter().collect();
      let initializer =
        array::read(&raw, interner, home)?.ok_or(PosixReadError::EnvPrefixUnsupported)?;
      let name = name.strip_suffix('+').unwrap_or(name);
      initializers.push((name.to_string(), initializer));
      atoms.push(Atom::Word(name.into()));
      i = end;
      continue;
    }
    if !atoms.is_empty() {
      if let Some((name, rhs)) = split_assignment(&raw) {
        let mut values = if rhs.starts_with("--")
          && !rhs.chars().any(|c| matches!(c, '\'' | '"' | '\\' | '$' | '`'))
        {
          vec![Atom::Word(rhs.into())]
        } else {
          scan(&assignment_tildes(rhs, home), interner, home)?
        };
        let value = if values.is_empty() {
          SExpression::Literal(Literal::String(String::new()))
        } else if values.len() == 1 {
          atom_to_value(values.remove(0), interner)
        } else {
          return Err(PosixReadError::EnvPrefixUnsupported);
        };
        // A literal value needs no join: `readonly r=1` passes the word `r=1`.
        if let SExpression::Literal(Literal::String(text)) = &value {
          atoms.push(Atom::Word(format!("{name}={text}")));
          i = end;
          continue;
        }
        atoms.push(Atom::Expanded(vec![
          (SExpression::Literal(Literal::String(format!("{name}="))), false),
          (value, false),
        ]));
        i = end;
        continue;
      }
    }
    atoms.extend(scan(&raw, interner, home)?);
    i = end;
  }
  let declaration = atoms_to_call(atoms, interner)?;
  if initializers.is_empty() {
    return Ok(declaration);
  }
  let initializers = initializers
    .into_iter()
    .map(|(name, value)| {
      call(
        "list",
        vec![SExpression::Literal(Literal::String(name)), value],
        interner,
      )
    })
    .collect();
  let initializers = call("list", initializers, interner);
  Ok(call(
    "std.sh.declare-initializer",
    vec![declaration, initializers],
    interner,
  ))
}

/// Prefix values use assignment expansion (no field splitting). The host's
/// scoped descriptor plan also carries per-command environment entries.
fn read_environment_prefix<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut rest = line.trim_start().to_string();
  let mut specs = Vec::new();
  let mut assignments = Vec::new();
  while split_assignment(&rest).is_some() {
    let chars: Vec<char> = rest.chars().collect();
    let end = redirection::word_end(&chars, 0)?;
    let word: String = chars[..end].iter().collect();
    let (name, rhs) = split_assignment(&word).unwrap();
    let mut atoms = if rhs.starts_with("--")
      && !rhs.chars().any(|c| matches!(c, '\'' | '"' | '\\' | '$' | '`'))
    {
      // Option parsing belongs to command arguments, never assignment data.
      vec![Atom::Word(rhs.into())]
    } else {
      scan::<S, B>(&assignment_tildes(rhs, home), interner, home)?
    };
    let value = match atoms.len() {
      0 => SExpression::Literal(Literal::String(String::new())),
      1 => atom_to_value(atoms.pop().unwrap(), interner),
      _ => return Err(PosixReadError::EnvPrefixUnsupported),
    };
    let append = name.ends_with('+');
    let name = name.strip_suffix('+').unwrap_or(name);
    let name_value = SExpression::Literal(Literal::String(name.into()));
    let prefix_value = if append {
      let current = param::parameter(name, interner);
      call("str.concat", vec![current, value.clone()], interner)
    } else { value.clone() };
    specs.push(call(
      "list",
      vec![
        SExpression::Literal(Literal::String("env".into())),
        name_value,
        prefix_value,
      ],
      interner,
    ));
    let name_symbol = SExpression::Literal(Literal::Symbol(interner.get_or_intern(name)));
    assignments.push(call(if append { "std.sh.append" } else { "let" }, vec![name_symbol, value], interner));
    rest = chars[end..]
      .iter()
      .collect::<String>()
      .trim_start()
      .to_string();
  }
  if rest.is_empty() {
    if assignments.len() == 1 {
      return Ok(assignments.pop().unwrap());
    }
    return Ok(call("std.sh.assign", assignments, interner));
  }
  let command = read_simple_statement(&rest, interner, home)?;
  Ok(call(
    "std.sh.redirect",
    vec![command, call("list", specs, interner)],
    interner,
  ))
}

/// Parse a shell-shaped flow expression without executing it. Command leaves
/// use [`read_statement`], so all existing word/flag/reference behavior is
/// preserved; only top-level control operators are new.
pub fn read_shell_expression<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  read_shell_expression_with_home(line, interner, None)
}

/// [`read_shell_expression`] with tilde expansion enabled by `home`. Operators inside quotes, escapes, and `$(...)` are retained as word
/// content and never split the outer expression.
pub fn read_shell_expression_with_home<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let (prepared, folds) = redirection::heredocs_eof_lines(line)?;
  if let Some(compound) = compound::read_with_lines(&prepared, interner, home, &[], &folds)? {
    return Ok(ShellExpression::Command(compound));
  }
  let tokens = lex_prepared_flow_tokens(&prepared)?;
  let mut pos = 0;
  let expression = parse_sequence(&tokens, &mut pos, interner, home)?;
  debug_assert_eq!(pos, tokens.len(), "flow parser must consume every token");
  Ok(expression)
}

/// Lower a parsed shell expression into the canonical flow s-expression.
///
/// The `std.flow.*` heads are reserved host forms with unevaluated stages.
pub fn lower_shell_expression<S, B>(
  expression: ShellExpression<S>,
  interner: &mut StringInterner<B>,
) -> SExpression<S>
where
  S: Symbol,
  B: Backend<S>,
{
  match expression {
    ShellExpression::Background(stage) => flow_form(SPAWN_FORM, vec![*stage], interner),
    ShellExpression::Command(command) => command,
    ShellExpression::Not(stage) => flow_form("std.sh.not", vec![*stage], interner),
    ShellExpression::Pipeline(stages) => flow_form("std.sh.pipe", stages, interner),
    ShellExpression::AndIf(left, right) => flow_form("std.sh.and", vec![*left, *right], interner),
    ShellExpression::OrIf(left, right) => flow_form("std.sh.or", vec![*left, *right], interner),
    ShellExpression::Sequence(stages) => flow_form("std.sh.seq", stages, interner),
  }
}

/// Parse and lower in one call, preserving the simple statement shape.
pub fn read_shell_plan<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  read_shell_plan_with_home(line, interner, None)
}

/// [`read_shell_plan`] with tilde expansion enabled by `home`.
pub fn read_shell_plan_with_home<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let expression = read_shell_expression_with_home(line, interner, home)?;
  Ok(lower_shell_expression(expression, interner))
}

/// Compile with the shell function names already installed on the host. Their
/// arguments are data words; they never pass the typed-command option lexer.
pub fn read_shell_plan_with_functions<S, B>(line: &str, interner: &mut StringInterner<B>, home: Option<&str>, functions: &[String]) -> Result<SExpression<S>, PosixReadError>
where S: Symbol, B: Backend<S> {
  let (prepared, folds) = redirection::heredocs_eof_lines(line)?;
  if let Some(plan) = compound::read_with_lines(&prepared, interner, home, functions, &folds)? { return Ok(plan); }
  read_shell_plan_with_home(line, interner, home)
}

/// [`read_shell_plan_with_functions`] for an interactive prompt line (argv.md
/// D5): the displayed command, and only it, is wrapped in the no-op marker
/// `(std.sh.display …)` so policy installed where interactive rc and plugins
/// load can draw the result. Scripts, `-c` and stdin never take this door.
pub fn read_prompt_plan_with_functions<S, B>(line: &str, interner: &mut StringInterner<B>, home: Option<&str>, functions: &[String]) -> Result<SExpression<S>, PosixReadError>
where S: Symbol, B: Backend<S> {
  let plan = read_shell_plan_with_functions(line, interner, home, functions)?;
  Ok(mark_displayed_command(plan, interner))
}

/// Wrap the command a prompt line displays in `(std.sh.display …)`: a lone
/// command, or the last member of a `;`, `&&` or `||` list. A pipeline stage,
/// a capture, a redirected command, a background job or a compound command is
/// never wrapped, and the marker evaluates to its body.
pub fn mark_displayed_command<S, B>(plan: SExpression<S>, interner: &mut StringInterner<B>) -> SExpression<S>
where S: Symbol, B: Backend<S> {
  if is_call(&plan, "std.sh.cmd", interner) {
    return call("std.sh.display", vec![plan], interner);
  }
  let displayed = if is_call(&plan, "std.sh.seq", interner) {
    1
  } else if is_call(&plan, "std.sh.and", interner) || is_call(&plan, "std.sh.or", interner) {
    2
  } else {
    return plan;
  };
  let SExpression::List(mut items) = plan else { unreachable!() };
  if items.len() > displayed {
    let last = items.pop().unwrap();
    items.push(mark_displayed_command(last, interner));
  }
  SExpression::List(items)
}

fn flow_form<S, B>(
  name: &str,
  stages: Vec<ShellExpression<S>>,
  interner: &mut StringInterner<B>,
) -> SExpression<S>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut items = Vec::with_capacity(stages.len() + 1);
  items.push(SExpression::Literal(Literal::Symbol(
    interner.get_or_intern(name),
  )));
  items.extend(
    stages
      .into_iter()
      .map(|stage| lower_shell_expression(stage, interner)),
  );
  SExpression::List(items)
}

/// Split only top-level flow operators, retaining the original command text
/// for the existing word reader. This is an expression lexer, not a second
/// word lexer: quote removal, tilde expansion, flags, and references remain
/// single-sourced in [`scan`].
fn lex_prepared_flow_tokens(line: &str) -> Result<Vec<FlowToken>, PosixReadError> {
  let chars = bash_line_chars(line)?;
  let mut tokens = Vec::new();
  let mut command = String::new();
  let mut quote: Option<char> = None;
  let mut escaped = false;
  let mut i = 0usize;
  let mut group_depth = 0;

  while i < chars.len() {
    let c = chars[i];

    if quote.is_none() && c == '[' && chars.get(i + 1) == Some(&'[')
      && chars.get(i + 2).is_none_or(|c| c.is_whitespace())
      && command.trim().is_empty() {
      let end = condition::end(&chars, i)?;
      command.extend(&chars[i..end]); i = end; continue;
    }

    if escaped {
      command.push(c);
      escaped = false;
      i += 1;
      continue;
    }

    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'(') {
      let end = scan_balanced(&chars, i + 2)?;
      command.extend(&chars[i..=end]);
      i = end + 1;
      continue;
    }
    if quote != Some('\'') && c == '`' {
      let (_, end) = backtick_source(&chars, i + 1)?;
      command.extend(&chars[i..=end]);
      i = end + 1;
      continue;
    }
    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'{') {
      let end = parameter_span_end_in(&chars, i + 2, quote == Some('"'));
      command.extend(&chars[i..end]);
      i = end;
      continue;
    }
    if let Some(q) = quote {
      command.push(c);
      if c == '\\' && q == '"' {
        escaped = true;
      } else if c == q {
        quote = None;
      }
      i += 1;
      continue;
    }
    if c == '\\' {
      command.push(c);
      escaped = true;
      i += 1;
      continue;
    }
    if c == '\'' || c == '"' {
      command.push(c);
      quote = Some(c);
      i += 1;
      continue;
    }
    if c == '$' && chars.get(i + 1) == Some(&'\'') {
      let end = ansi_c_quote_end(&chars, i + 2)?;
      command.extend(&chars[i..=end]);
      i = end + 1;
      continue;
    }
    if matches!(c, '<' | '>') && chars.get(i + 1) == Some(&'(') {
      let end = scan_balanced(&chars, i + 2)?;
      command.extend(&chars[i..=end]);
      i = end + 1;
      continue;
    }
    if let Some(end) = extglob::end(&chars, i) {
      command.extend(&chars[i..end]);
      i = end;
      continue;
    }
    if c == '#' && (command.trim().is_empty() || i == 0 || chars[i - 1].is_whitespace()) {
      while i < chars.len() && chars[i] != '\n' {
        i += 1;
      }
      continue;
    }
    if c == '\n' && command.trim().is_empty() {
      i += 1;
      continue;
    }
    if c == '!'
      && command.trim().is_empty()
      && chars.get(i + 1).is_none_or(|next| next.is_whitespace())
    {
      tokens.push(FlowToken::Not);
      i += 1;
      continue;
    }
    if c == '{' && (i == 0 || chars[i - 1].is_whitespace())
      && chars.get(i + 1).is_some_and(|c| c.is_whitespace()) {
      group_depth += 1;
    }
    if c == '}' && group_depth > 0 { group_depth -= 1; }
    if group_depth > 0 {
      command.push(c);
      i += 1;
      continue;
    }
    // &, | inside a redirection operator belong to that operator.
    if (c == '&' && (chars.get(i + 1) == Some(&'>') || i > 0 && matches!(chars[i - 1], '<' | '>')))
      || (c == '|' && i > 0 && chars[i - 1] == '>') {
      command.push(c);
      i += 1;
      continue;
    }
    if c == '|' && chars.get(i + 1) == Some(&'&') {
      command.push_str(" 2>&1");
      push_flow_command(&mut tokens, &mut command, ShellOperator::Pipe)?;
      tokens.push(FlowToken::Operator(ShellOperator::Pipe));
      i += 2;
      continue;
    }
    let operator = match (c, chars.get(i + 1).copied()) {
      ('&', Some('&')) => Some((ShellOperator::AndIf, 2)),
      ('&', _) => Some((ShellOperator::Background, 1)),
      ('|', Some('|')) => Some((ShellOperator::OrIf, 2)),
      ('|', _) => Some((ShellOperator::Pipe, 1)),
      (';' | '\n', _) => Some((ShellOperator::Sequence, 1)),
      _ => None,
    };
    if let Some((operator, width)) = operator {
      push_flow_command(&mut tokens, &mut command, operator)?;
      tokens.push(FlowToken::Operator(operator));
      i += width;
      continue;
    }

    command.push(c);
    i += 1;
  }

  if command.trim().is_empty() {
    return match tokens.last() {
      Some(FlowToken::Operator(ShellOperator::Sequence | ShellOperator::Background)) => Ok(tokens),
      Some(FlowToken::Operator(operator)) => {
        Err(PosixReadError::MissingFlowOperand(operator.source()))
      }
      Some(FlowToken::Not) => Err(PosixReadError::MissingFlowOperand("!")),
      _ => Err(PosixReadError::Empty),
    };
  }
  // Trailing whitespace may be escaped, or the newline in a continuation.
  // Keep it for the word scanner; trimming here changes the quoted value.
  tokens.push(FlowToken::Command(command.trim_start().to_string()));
  Ok(tokens)
}

fn push_flow_command(
  tokens: &mut Vec<FlowToken>,
  command: &mut String,
  operator: ShellOperator,
) -> Result<(), PosixReadError> {
  let trimmed = command.trim_start();
  if trimmed.is_empty() {
    return Err(PosixReadError::MissingFlowOperand(operator.source()));
  }
  tokens.push(FlowToken::Command(trimmed.to_string()));
  command.clear();
  Ok(())
}

// Precedence, highest to lowest: pipeline, and/or (same and left-associative),
// sequence. This matches the familiar shell grouping while lowering to tsh's
// own flow semantics.
fn parse_sequence<S, B>(
  tokens: &[FlowToken],
  pos: &mut usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut stages = Vec::new();
  loop {
    let mut stage = parse_and_or(tokens, pos, interner, home)?;
    let separator = match tokens.get(*pos) {
      Some(FlowToken::Operator(op @ (ShellOperator::Sequence | ShellOperator::Background))) => Some(*op),
      _ => None,
    };
    if separator == Some(ShellOperator::Background) { stage = ShellExpression::Background(Box::new(stage)); }
    stages.push(stage);
    if separator.is_none() { break; }
    *pos += 1;
    if *pos == tokens.len() { break; }
  }
  Ok(if stages.len() == 1 { stages.pop().unwrap() } else { ShellExpression::Sequence(stages) })
}

fn parse_and_or<S, B>(
  tokens: &[FlowToken],
  pos: &mut usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let mut expression = parse_pipeline(tokens, pos, interner, home)?;
  loop {
    let operator = match tokens.get(*pos) {
      Some(FlowToken::Operator(operator @ (ShellOperator::AndIf | ShellOperator::OrIf))) => {
        *operator
      }
      _ => break,
    };
    *pos += 1;
    let right = parse_pipeline(tokens, pos, interner, home)?;
    expression = match operator {
      ShellOperator::AndIf => ShellExpression::AndIf(Box::new(expression), Box::new(right)),
      ShellOperator::OrIf => ShellExpression::OrIf(Box::new(expression), Box::new(right)),
      _ => unreachable!(),
    };
  }
  Ok(expression)
}

fn parse_pipeline<S, B>(
  tokens: &[FlowToken],
  pos: &mut usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  if matches!(tokens.get(*pos), Some(FlowToken::Not)) {
    *pos += 1;
    return parse_pipeline(tokens, pos, interner, home)
      .map(|stage| ShellExpression::Not(Box::new(stage)));
  }
  let first = parse_command(tokens, pos, interner, home)?;
  let mut stages = vec![first];
  while matches!(
    tokens.get(*pos),
    Some(FlowToken::Operator(ShellOperator::Pipe))
  ) {
    *pos += 1;
    stages.push(parse_command(tokens, pos, interner, home)?);
  }
  Ok(if stages.len() == 1 {
    stages.pop().unwrap()
  } else {
    ShellExpression::Pipeline(stages)
  })
}

fn parse_command<S, B>(
  tokens: &[FlowToken],
  pos: &mut usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<ShellExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  match tokens.get(*pos) {
    Some(FlowToken::Command(command)) => {
      *pos += 1;
      read_simple_statement(command, interner, home).map(ShellExpression::Command)
    }
    Some(FlowToken::Operator(operator)) => {
      Err(PosixReadError::MissingFlowOperand(operator.source()))
    }
    Some(FlowToken::Not) => Err(PosixReadError::MissingFlowOperand("!")),
    None => Err(PosixReadError::Empty),
  }
}

/// A leading `name=` (identifier immediately followed by `=`, posix style — no
/// spaces, no `$` on the name). Returns `(name, rhs)`; `None` for a command line.
fn split_assignment(line: &str) -> Option<(&str, &str)> {
  let trimmed = line.trim_start();
  let bytes = trimmed.as_bytes();
  if bytes.is_empty() || !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') {
    return None;
  }
  let mut i = 1;
  while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
    i += 1;
  }
  if bytes.get(i) == Some(&b'+') && bytes.get(i + 1) == Some(&b'=') {
    Some((&trimmed[..i + 1], &trimmed[i + 2..]))
  } else if i < bytes.len() && bytes[i] == b'=' {
    Some((&trimmed[..i], &trimmed[i + 1..]))
  } else {
    None
  }
}

/// Map a scalar word (including an assignment rhs) to its value expression.
fn atom_to_value<S, B>(atom: Atom<S>, interner: &mut StringInterner<B>) -> SExpression<S>
where
  S: Symbol,
  B: Backend<S>,
{
  match atom {
    Atom::Word(w) | Atom::Quoted(w) => SExpression::Literal(Literal::String(w)),
    Atom::Fields(_, assignment) => assignment,
    Atom::Glob(parts) => {
      // Assignment values join the decoded text, without splitting or globbing.
      if parts
        .iter()
        .all(|(value, _, _)| matches!(value, SExpression::Literal(Literal::String(_))))
      {
        let text = parts
          .into_iter()
          .map(|(value, _, _)| match value {
            SExpression::Literal(Literal::String(text)) => text,
            _ => unreachable!(),
          })
          .collect::<String>();
        SExpression::Literal(Literal::String(text))
      } else {
        call(
          "str.concat",
          parts.into_iter().map(|(mut value, _, _)| {
            if is_call(&value, "std.sh.array-keys", interner) || is_call(&value, "std.sh.names", interner) {
              if let SExpression::List(items) = &mut value {
                if matches!(items.get(2), Some(SExpression::Literal(Literal::String(selector))) if selector == "@" || selector == "*fields") {
                  items[2] = SExpression::Literal(Literal::String("*".into()));
                }
              }
            }
            if is_call(&value, "std.sh.array-get", interner) {
              if let SExpression::List(items) = &mut value {
                if matches!(items.get(2), Some(SExpression::Literal(Literal::String(name))) if name == "@") {
                  items[2] = SExpression::Literal(Literal::String("@word".into()));
                } else if matches!(items.get(2), Some(SExpression::Literal(Literal::String(name))) if name == "*fields") {
                  items[2] = SExpression::Literal(Literal::String("*".into()));
                }
              }
            }
            if is_call(&value, "std.sh.positional", interner) {
              if let SExpression::List(items) = &mut value {
                if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "@") {
                  items[1] = SExpression::Literal(Literal::String("@word".into()));
                }
              }
            }
            if is_call(&value, "if", interner) {
              let scalar = if param::fields(&value, interner) { "std.sh.array-scalar" } else { "std.sh.scalar" };
              call(scalar, vec![value], interner)
            } else { value }
          }).collect(),
          interner,
        )
      }
    }

    // A whole unquoted assignment expansion keeps its typed value, just
    // like a whole unquoted argument. Quoted and joined words require text.
    Atom::Expanded(mut parts) if parts.len() == 1 && parts[0].1 => parts.pop().unwrap().0,
    Atom::Expanded(parts) => call(
      "str.concat",
      parts.into_iter().map(|(value, _)| value).collect(),
      interner,
    ),
  }
}

// Tilde prefixes never reach a word here: `tilde_prefixes` rewrote them as
// runtime lookups before the scan.
fn push_word<S: Symbol>(atoms: &mut Vec<Atom<S>>, word: &mut String, pure: bool) {
  if pure {
    push_pure_word(atoms, word);
  } else {
    atoms.push(Atom::Quoted(word.clone()));
  }
  word.clear();
}

/// Whether `prefix` (the text between `~` and the first `/`) names a tilde
/// expansion: `""` (the home; only when `home` enables it), `+`, `-`,
/// `N`/`+N`/`-N` (the directory stack) or a login name. Anything else —
/// notably a prefix holding a quoted character or an expansion — keeps the
/// tilde literal, as bash does.
fn tilde_prefix(prefix: &str, home: Option<&str>) -> bool {
  match prefix {
    "" => home.is_some(),
    "+" | "-" => true,
    _ => {
      let digits = prefix.strip_prefix(['+', '-']).unwrap_or(prefix);
      !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        || prefix.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    }
  }
}

/// A tilde prefix lowered as source: `"${~PREFIX}"`, which the parameter
/// reader turns into `(std.sh.tilde "PREFIX")`. The runtime resolves it when the
/// word is expanded — `$HOME` as it stands (the passwd home only when HOME
/// is unset), `$PWD`, `$OLDPWD`, the directory stack, a user's home — and
/// leaves `~PREFIX` literal when there is nothing to name. Double quotes
/// keep the result one unsplit, unglobbed field. `${~…}` is tsh's spelling
/// only: bash reports it as a bad substitution.
fn tilde_source(prefix: &str) -> String {
  format!("\"${{~{prefix}}}\"")
}

/// Every tilde prefix of a line, rewritten as runtime lookups
/// ([`tilde_source`]): a word-leading `~…` and, in an assignment-shaped
/// word (`name=…`, every word when `value` holds a whole assignment value),
/// a `~…` after the `=` or after an unquoted `:`. `home` enables the bare
/// home form (`~`, `~/…`); `None` leaves it literal. A prefix with a quoted
/// character stays literal.
fn tilde_prefixes(chars: &[char], home: Option<&str>, value: bool) -> Vec<char> {
  let mut result = Vec::with_capacity(chars.len());
  let mut i = 0;
  // Per word: the name so far (`None` once the word cannot be an
  // assignment) and whether the next `~` begins a tilde prefix.
  let mut name: Option<String> = Some(String::new());
  let mut assigned = value;
  let mut start = true;
  while i < chars.len() {
    let c = chars[i];
    if c.is_whitespace() {
      result.push(c);
      name = Some(String::new());
      assigned = value;
      start = true;
      i += 1;
      continue;
    }
    if c == '~' && (start || assigned && matches!(result.last(), Some('=' | ':'))) {
      let end = (i + 1..chars.len())
        .find(|&j| {
          chars[j].is_whitespace() || matches!(chars[j], '/' | ';' | '&' | '|' | '<' | '>' | '(' | ')')
            || assigned && chars[j] == ':'
        })
        .unwrap_or(chars.len());
      let prefix: String = chars[i + 1..end].iter().collect();
      if tilde_prefix(&prefix, home) {
        result.extend(tilde_source(&prefix).chars());
        i = end;
        name = None;
        start = false;
        continue;
      }
    }
    start = false;
    if let Ok(Some(end)) = redirection::protected_end(chars, i) {
      result.extend_from_slice(&chars[i..end]);
      i = end;
      name = None;
      continue;
    }
    match (&mut name, c) {
      (Some(text), '=') if compound::identifier(text.strip_suffix('+').unwrap_or(text)) => {
        name = None;
        assigned = true;
      }
      (Some(text), c) if c.is_ascii_alphanumeric() || c == '_' || c == '+' => text.push(c),
      _ => name = None,
    }
    result.push(c);
    i += 1;
  }
  result
}

/// An assignment value with its tilde prefixes expanded (after the `=` and
/// after each unquoted `:`), for the scanner.
fn assignment_tildes(rhs: &str, home: Option<&str>) -> String {
  tilde_prefixes(&rhs.chars().collect::<Vec<_>>(), home, true).into_iter().collect()
}

#[cfg(test)]
mod tilde_prefix_tests {
  use super::*;

  fn rewrite(source: &str, value: bool) -> String {
    tilde_prefixes(&source.chars().collect::<Vec<_>>(), Some(""), value).into_iter().collect()
  }

  #[test]
  fn word_leading_tildes_lower_to_runtime_lookups() {
    // The home is read when the word expands, never spliced in at read time.
    assert_eq!(rewrite("cd ~ ~/a", false), r#"cd "${~}" "${~}"/a"#);
    assert_eq!(rewrite("HOME=/h; echo ~", false), r#"HOME=/h; echo "${~}""#);
    // Without a home switch the bare form stays literal; others still lower.
    let off: String = tilde_prefixes(&"echo ~ ~/a ~+".chars().collect::<Vec<_>>(), None, false).into_iter().collect();
    assert_eq!(off, r#"echo ~ ~/a "${~+}""#);
  }

  #[test]
  fn assignment_shaped_words_expand_after_equals_and_colons() {
    // bash 5.3 (not in posix mode) expands these in any argument.
    assert_eq!(
      rewrite("echo x=~ x=~/b a+=~ p=a:~:~/c:b~", false),
      r#"echo x="${~}" x="${~}"/b a+="${~}" p=a:"${~}":"${~}"/c:b~"#
    );
    // Not an assignment: a quoted or invalid name, or no `=`.
    assert_eq!(rewrite(r#"echo "a"=~ a\=~ 1a=~ --o=~ a:~"#, false), r#"echo "a"=~ a\=~ 1a=~ --o=~ a:~"#);
    // A whole value: its first character is after the `=`.
    assert_eq!(rewrite("~:~/b:c~", true), r#""${~}":"${~}"/b:c~"#);
  }

  #[test]
  fn directory_stack_pwd_and_user_prefixes_lower_by_name() {
    assert_eq!(
      rewrite("echo ~0 ~1/x ~+2 ~-0 x=a:~1 ~+ ~- ~alice/x", false),
      r#"echo "${~0}" "${~1}"/x "${~+2}" "${~-0}" x=a:"${~1}" "${~+}" "${~-}" "${~alice}"/x"#
    );
  }

  #[test]
  fn quoted_or_expanding_prefixes_stay_literal() {
    assert_eq!(rewrite(r#"echo ~"+" x=~"/b" ~"alice" ~al\ice ~+x ~$u"#, false), r#"echo ~"+" x=~"/b" ~"alice" ~al\ice ~+x ~$u"#);
    // Quoted words are protected whole: their tildes never begin a prefix.
    assert_eq!(rewrite(r#"echo "a ~" 'b ~+'"#, false), r#"echo "a ~" 'b ~+'"#);
  }
}

/// Both reader doors preserve option spelling; only a command's binder reads it.
fn push_pure_word<S: Symbol>(atoms: &mut Vec<Atom<S>>, word: &str) {
  atoms.push(Atom::Word(word.to_string()));
}

/// Inspect source while quotes and escapes still distinguish syntax from data.
/// Flow-plan leaves come here after their supported operators have been split.
fn refuse_shell_syntax(chars: &[char]) -> Result<(), PosixReadError> {
  refuse_shell_syntax_in(chars, false)
}

fn refuse_shell_syntax_in(chars: &[char], flow: bool) -> Result<(), PosixReadError> {
  let mut quote = None;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if quote == Some('\'') {
      if c == '\'' {
        quote = None;
      }
      i += 1;
      continue;
    }
    if quote.is_none() && c == '$' && chars.get(i + 1) == Some(&'\'') {
      i = ansi_c_quote_end(chars, i + 2)? + 1;
      continue;
    }
    if c == '\\' {
      i += 2;
      continue;
    }
    // Outer double quotes do not quote the source of a nested command.
    if c == '$' && chars.get(i + 1) == Some(&'(') {
      let end = scan_balanced(chars, i + 2)?;
      if chars.get(i + 2) == Some(&'(') {
        i = end + 1;
        continue;
      }
      // The nested word reader validates its Bash grammar, including case
      // patterns and arm terminators that are not simple flow operators.
      i = end + 1;
      continue;
    }
    if c == '`' {
      let (_, end) = backtick_source(chars, i + 1)?;
      i = end + 1;
      continue;
    }
    // Parameter forms are a separate grammar; their braces are not lists.
    if c == '$' && chars.get(i + 1) == Some(&'{') {
      i = parameter_span_end_in(chars, i + 2, quote == Some('"'));
      continue;
    }
    if quote == Some('"') {
      if c == '"' {
        quote = None;
      }
      i += 1;
      continue;
    }
    if c == '\'' || c == '"' {
      quote = Some(c);
      i += 1;
      continue;
    }
    if matches!(c, '<' | '>') && chars.get(i + 1) == Some(&'(') {
      i = scan_balanced(chars, i + 2)? + 1;
      continue;
    }
    if let Some(end) = extglob::end(chars, i) {
      i = end;
      continue;
    }
    if let Some(op) = unsupported_operator(chars, i) {
      if flow && matches!(op.as_str(), "&&" | "||" | "|" | ";" | "&") {
        i += op.len();
        continue;
      }
      return Err(PosixReadError::ShellOperatorUnsupported(op));
    }
    i += 1;
  }
  Ok(())
}

fn parameter_span_end(chars: &[char], i: usize) -> usize {
  parameter_span_end_in(chars, i, false)
}

fn parameter_span_end_in(chars: &[char], mut i: usize, quoted: bool) -> usize {
  let mut quote = None;
  while i < chars.len() {
    let c = chars[i];
    if !quoted && quote.is_none() && c == '$' && chars.get(i + 1) == Some(&'\'') {
      i = ansi_c_quote_end(chars, i + 2).map_or(chars.len(), |end| end + 1);
      continue;
    }
    if c == '\\' && quote != Some('\'') {
      i += 2;
      continue;
    }
    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'(') {
      i = scan_balanced(chars, i + 2).map_or(chars.len(), |end| end + 1);
      continue;
    }
    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'{') {
      i = parameter_span_end_in(chars, i + 2, quoted || quote == Some('"'));
      continue;
    }
    if quote != Some('\'') && c == '`' {
      i = backtick_source_in_quotes(chars, i + 1, quote == Some('"')).map_or(chars.len(), |(_, end)| end + 1);
      continue;
    }
    if let Some(q) = quote {
      if c == q {
        quote = None;
      }
    } else {
      match c {
        '\'' => quote = Some(c),
        '"' => quote = Some(c),
        '}' => return i + 1,
        _ => {}
      }
    }
    i += 1;
  }
  i.min(chars.len())
}

fn unsupported_operator(chars: &[char], start: usize) -> Option<String> {
  if chars[start].is_ascii_digit() && start > 0 && chars[start - 1].is_ascii_digit() {
    return None;
  }
  let mut i = start;
  // Retain a redirection's descriptor in the diagnostic when present.
  while chars.get(i).is_some_and(|c| c.is_ascii_digit()) {
    i += 1;
  }
  let c = *chars.get(i)?;
  if i > start && c != '<' && c != '>' {
    return None;
  }
  let next = chars.get(i + 1).copied();
  let end = match (c, next) {
    ('&', Some('&' | '>')) | ('|', Some('|')) => i + 2,
    ('>', Some('>')) => i + 2,
    ('<', Some('<')) => {
      if chars.get(i + 2) == Some(&'<') {
        i + 3
      } else {
        i + 2
      }
    }
    ('>', Some('&')) => {
      let mut end = i + 2;
      while chars.get(end).is_some_and(|c| c.is_ascii_digit()) {
        end += 1;
      }
      end
    }
    ('&' | '|' | ';' | '>' | '<' | '(' | ')' | '`', _) => i + 1,
    _ => return None,
  };
  Some(chars[start..end].iter().collect())
}

fn is_brace_sequence(chars: &[char]) -> bool {
  let body: String = chars.iter().collect();
  let parts: Vec<&str> = body.split("..").collect();
  if parts.len() != 2 && parts.len() != 3 {
    return false;
  }
  let integer = |s: &str| {
    let digits = s.strip_prefix('-').unwrap_or(s);
    !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())
  };
  let letter = |s: &str| s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic();
  ((integer(parts[0]) && integer(parts[1])) || (letter(parts[0]) && letter(parts[1])))
    && (parts.len() == 2 || integer(parts[2]))
}

/// Locate the end without decoding, so syntax walkers can skip the same span.
fn ansi_c_quote_end(chars: &[char], mut i: usize) -> Result<usize, PosixReadError> {
  while i < chars.len() {
    match chars[i] {
      '\'' => return Ok(i),
      '\\' => i += 2,
      _ => i += 1,
    }
  }
  Err(PosixReadError::UnterminatedQuote)
}

fn ansi_c_number(chars: &[char], i: &mut usize, radix: u32, limit: usize) -> Option<u32> {
  let mut value = 0;
  let start = *i;
  while *i < chars.len() && *i - start < limit {
    let Some(digit) = chars[*i].to_digit(radix).filter(|_| chars[*i].is_ascii()) else {
      break;
    };
    value = value * radix + digit;
    *i += 1;
  }
  (*i > start).then_some(value)
}

fn decode_ansi_c_quote(chars: &[char], start: usize) -> Result<(String, usize), PosixReadError> {
  let end = ansi_c_quote_end(chars, start)?;
  let chars = &chars[..end];
  let mut bytes = Vec::new();
  let mut i = start;
  while i < end {
    let mut c = chars[i];
    i += 1;
    if c == '\\' {
      c = chars[i];
      i += 1;
      c = match c {
        'a' => '\u{0007}',
        'b' => '\u{0008}',
        'e' | 'E' => '\u{001b}',
        'f' => '\u{000c}',
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        'v' => '\u{000b}',
        '\\' | '\'' | '"' | '?' => c,
        'c' if i < end && chars[i].is_ascii() => {
          let control = chars[i];
          i += 1;
          bytes.push(if control == '?' { 0x7f } else { control as u8 & 0x1f });
          continue;
        }
        '0'..='7' => {
          i -= 1;
          bytes.push(ansi_c_number(chars, &mut i, 8, 3).unwrap() as u8);
          continue;
        }
        'x' | 'u' | 'U' => {
          let limit = match c {
            'x' => 2,
            'u' => 4,
            _ => 8,
          };
          if let Some(value) = ansi_c_number(chars, &mut i, 16, limit) {
            if c == 'x' {
              bytes.push(value as u8);
              continue;
            }
            char::from_u32(value).ok_or(PosixReadError::NonUtf8AnsiCQuote)?
          } else {
            bytes.push(b'\\');
            c
          }
        }
        _ => {
          bytes.push(b'\\');
          c
        }
      };
    }
    let mut utf8 = [0; 4];
    bytes.extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
  }
  // Bash words cannot carry NUL: it terminates this quoted part, not its
  // adjacent word parts. Decode octal/hex as bytes before validating UTF-8.
  if let Some(nul) = bytes.iter().position(|b| *b == 0) {
    bytes.truncate(nul);
  }
  let value = String::from_utf8(bytes).map_err(|_| PosixReadError::NonUtf8AnsiCQuote)?;
  Ok((value, end))
}

/// An unquoted trailing escape asks the source runner for the next physical
/// line. Unfinished quotes/substitutions are reported by the normal reader.
pub fn bash_line_continues(line: &str) -> bool {
  if !line.ends_with('\\') { return false; }
  let chars: Vec<char> = line.chars().collect();
  let mut boundary = true;
  let mut i = 0;
  while i < chars.len() {
    if chars[i] == '#' && boundary {
      while i < chars.len() && chars[i] != '\n' { i += 1; }
      boundary = true;
      continue;
    }
    if chars[i] == '\\' && i + 1 == chars.len() { return true; }
    match redirection::protected_end(&chars, i) {
      Ok(Some(end)) => { i = end; boundary = false; }
      Ok(None) => {
        boundary = chars[i].is_whitespace() || matches!(chars[i], ';' | '|' | '&' | '<' | '>' | '(' | ')');
        i += 1;
      }
      Err(_) => return false,
    }
  }
  false
}

/// Continuations disappear before token recognition, including between `$`
/// and a quote. Single and ANSI-C quoted spans keep their physical newlines.
fn bash_line_chars(line: &str) -> Result<Vec<char>, PosixReadError> {
  bash_line_chars_tracking(line, None)
}

/// [`bash_line_chars`], also recording the output index at which each
/// removed continuation stood, so a reader can recover physical lines.
fn bash_line_chars_tracking(line: &str, mut joined: Option<&mut Vec<usize>>) -> Result<Vec<char>, PosixReadError> {
  let chars: Vec<char> = line.chars().collect();
  let mut out = Vec::with_capacity(chars.len());
  let mut quote = None;
  let mut dollar = false;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if quote == Some('\'') {
      out.push(c);
      if c == '\'' {
        quote = None;
      }
      i += 1;
      continue;
    }
    if c == '$' && chars.get(i + 1) == Some(&'(') {
      let end = scan_balanced(&chars, i + 2)?;
      out.extend_from_slice(&chars[i..=end]);
      i = end + 1;
      dollar = false;
      continue;
    }
    if c == '`' {
      let (_, end) = backtick_source(&chars, i + 1)?;
      out.extend_from_slice(&chars[i..=end]);
      i = end + 1;
      dollar = false;
      continue;
    }
    if c == '\\' {
      if chars.get(i + 1) != Some(&'\n') {
        out.push(c);
        if let Some(next) = chars.get(i + 1) {
          out.push(*next);
        }
        dollar = false;
      } else if let Some(joined) = joined.as_deref_mut() {
        joined.push(out.len());
      }
      i += 2;
      continue;
    }
    if let Some(q) = quote {
      out.push(c);
      if c == q {
        quote = None;
      }
    } else if c == '\'' && dollar {
      let end = ansi_c_quote_end(&chars, i + 1)?;
      out.extend_from_slice(&chars[i..=end]);
      i = end + 1;
      dollar = false;
      continue;
    } else {
      out.push(c);
      if c == '\'' || c == '"' {
        quote = Some(c);
      }
    }
    dollar = quote.is_none() && c == '$';
    i += 1;
  }
  Ok(out)
}

// Literal runs retain an explicit empty quote so `""$unset` keeps one field.
fn flush_literal<S: Symbol>(
  word: &mut String,
  present: &mut bool,
  parts: &mut Vec<(SExpression<S>, bool)>,
) {
  if !word.is_empty() || *present {
    parts.push((
      SExpression::Literal(Literal::String(std::mem::take(word))),
      false,
    ));
    *present = false;
  }
}

fn finish_word<S, B>(
  atoms: &mut Vec<Atom<S>>,
  word: &mut String,
  present: &mut bool,
  parts: &mut Vec<(SExpression<S>, bool)>,
  pure: bool,
  home: Option<&str>,
  raw: &str,
  interner: &mut StringInterner<B>,
) -> Result<(), PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  if let Some(value) = brace::word(raw, interner, home)? {
    let assignment = atom_to_value(Atom::Glob(redirection::word_parts(raw, interner, home)?), interner);
    atoms.push(Atom::Fields(value, assignment));
    word.clear(); parts.clear(); *present = false;
    return Ok(());
  }
  if parts.iter().any(|(value, _)| is_call(value, "if", interner)) {
    atoms.push(Atom::Glob(redirection::word_parts(raw, interner, home)?));
    word.clear(); parts.clear(); *present = false;
    return Ok(());
  }
  if parts.iter().any(|(value, _)| is_call(value, "std.sh.array-get", interner) || param::fields(value, interner)) {
    let descriptors = redirection::word_parts(raw, interner, home)?;
    atoms.push(Atom::Glob(descriptors));
    word.clear(); parts.clear(); *present = false;
    return Ok(());
  }
  if parts.iter().any(|(value, split)| is_call(value, "std.sh.positional", interner)
    && matches!(value, SExpression::List(items) if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "@" || name == "*" && *split))) {
    let mut descriptors = redirection::word_parts(raw, interner, home)?;
    if raw.strip_prefix('"').and_then(|raw| raw.strip_suffix('"'))
      .is_some_and(|raw| raw.replace("$@", "").replace("${@}", "").is_empty()) {
      descriptors.retain(|(value, _, _)| !matches!(value, SExpression::Literal(Literal::String(text)) if text.is_empty()));
    }
    atoms.push(Atom::Glob(descriptors));
    word.clear(); parts.clear(); *present = false;
    return Ok(());
  }
  if raw.chars().any(|c| matches!(c, '*' | '?' | '[')) {
    let pattern_parts = redirection::word_parts(raw, interner, home)?;
    let mut pattern = String::new();
    for (value, _, glob) in &pattern_parts {
      if let SExpression::Literal(Literal::String(text)) = value {
        for c in text.chars() {
          if !glob && matches!(c, '*' | '?' | '[' | ']' | '\\') {
            pattern.push('\\');
          }
          pattern.push(c);
        }
      } else {
        // An expansion may supply bracket data; its actual pattern is checked
        // after expansion. It must never turn an unmatched literal [ into one.
        pattern.push('x');
      }
    }
    if has_pathname_pattern(&pattern) {
      atoms.push(Atom::Glob(pattern_parts));
      word.clear();
      parts.clear();
      *present = false;
      return Ok(());
    }
  }
  if parts.is_empty() {
    push_word(atoms, word, pure);
    *present = false;
  } else {
    flush_literal(word, present, parts);
    atoms.push(Atom::Expanded(std::mem::take(parts)));
  }
  Ok(())
}

// Bash treats an unmatched [ as literal, including the [ builtin. Escaped
// closing brackets and a bracket's first ] are data, not terminators.
fn has_pathname_pattern(pattern: &str) -> bool {
  let bytes = pattern.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'\\' => i += 2,
      b'*' | b'?' => return true,
      // An extended glob group (extglob is always on).
      b'+' | b'@' | b'!' if bytes.get(i + 1) == Some(&b'(') => return true,
      b'[' => {
        let mut j = i + 1;
        if matches!(bytes.get(j), Some(b'!' | b'^')) {
          j += 1;
        }
        if bytes.get(j) == Some(&b']') {
          j += 1;
        }
        while j < bytes.len() && bytes[j] != b'/' {
          if bytes[j] == b'\\' {
            j += 2;
            continue;
          }
          if bytes[j] == b']' {
            return true;
          }
          if bytes[j] == b'[' && bytes.get(j + 1) == Some(&b':') {
            if let Some(end) = bytes[j + 2..].windows(2).position(|w| w == b":]") {
              j += end + 4;
              continue;
            }
          }
          j += 1;
        }
        i += 1;
      }
      _ => i += 1,
    }
  }
  false
}

fn read_process_substitution<S: Symbol, B: Backend<S>>(
  chars: &[char],
  start: usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<(SExpression<S>, usize), PosixReadError> {
  let end = scan_balanced(chars, start + 2)?;
  let source: String = chars[start + 2..end].iter().collect();
  let body = read_statement_with_home(&source, interner, home)?;
  Ok((
    call(
      "std.sh.process-sub",
      vec![
        SExpression::Literal(Literal::Boolean(chars[start] == '>')),
        body,
      ],
      interner,
    ),
    end + 1,
  ))
}

fn read_expansion<S, B>(
  chars: &[char],
  start: usize,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<(SExpression<S>, usize)>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  read_expansion_in(chars, start, interner, home, false)
}

fn read_expansion_in<S, B>(
  chars: &[char], start: usize, interner: &mut StringInterner<B>, home: Option<&str>, quoted: bool,
) -> Result<Option<(SExpression<S>, usize)>, PosixReadError>
where S: Symbol, B: Backend<S> {
  let next = chars.get(start + 1).copied();
  if next == Some('!') {
    return Ok(Some((call(LAST_JOB_FORM, vec![], interner), start + 2)));
  }
  if next == Some('{') {
    let end = parameter_span_end_in(chars, start + 2, quoted);
    let name: String = chars[start + 2..end.saturating_sub(1)].iter().collect();
    if let Some(index) = name.strip_prefix("BASH_REMATCH[").and_then(|s| s.strip_suffix(']')) {
      if index.bytes().all(|b| b.is_ascii_digit()) && !index.is_empty() {
        return Ok(Some((call("std.sh.rematch", vec![SExpression::Literal(Literal::String(index.into()))], interner), end)));
      }
    }
  }
  // `$[expr]` is bash's deprecated spelling of `$((expr))`.
  if next == Some('[') {
    let mut depth = 0;
    let close = (start + 1..chars.len()).find(|&i| {
      match chars[i] {
        '[' => depth += 1,
        ']' => depth -= 1,
        _ => {}
      }
      depth == 0
    });
    if let Some(close) = close {
      let inner: String = chars[start + 2..close].iter().collect();
      return Ok(Some((arith::lower(&inner, interner, home)?, close + 1)));
    }
  }
  if next == Some('(') {
    let end = scan_balanced(chars, start + 2)?;
    if chars.get(start + 2) == Some(&'(') {
      let inner: String = chars[start + 3..end - 1].iter().collect();
      return Ok(Some((arith::lower(&inner, interner, home)?, end + 1)));
    }
    let inner: String = chars[start + 2..end].iter().collect();
    // `$()` and `$( )` expand to nothing.
    if inner.trim().is_empty() {
      return Ok(Some((SExpression::Literal(Literal::String(String::new())), end + 1)));
    }
    // `$(< file)` is the file's contents, read without running a command.
    if let Some(file) = inner.trim().strip_prefix('<').map(str::trim).filter(|file| {
      let chars: Vec<char> = file.chars().collect();
      !file.is_empty() && !file.starts_with(['<', '(', '&', '>'])
        && redirection::word_end(&chars, 0).is_ok_and(|end| end == chars.len())
    }) {
      let parts = redirection::word_parts(file, interner, home)?
        .into_iter()
        .map(|(value, split, glob)| word_descriptor(value, split, glob, interner))
        .collect();
      let parts = call("list", parts, interner);
      let target = call("std.sh.redirect-word", vec![parts, SExpression::Literal(Literal::String(file.into()))], interner);
      return Ok(Some((call("std.sh.read-file", vec![target], interner), end + 1)));
    }
    let command = read_statement_with_home(&inner, interner, home)?;
    return Ok(Some((call("std.sh.sub", vec![command], interner), end + 1)));
  }
  let (name, end) = if next == Some('{') {
    let end = parameter_span_end_in(chars, start + 2, quoted);
    if chars.get(end.wrapping_sub(1)) != Some(&'}') {
      return Err(PosixReadError::ShellExpansionUnsupported(
        chars[start..end].iter().collect(),
      ));
    }
    let body: String = chars[start + 2..end - 1].iter().collect();
    return Ok(Some((param::lower(&body, interner, home, quoted)?, end)));
  } else if next.is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
    let mut end = start + 2;
    while chars
      .get(end)
      .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
    {
      end += 1;
    }
    (chars[start + 1..end].iter().collect(), end)
  } else if next
    .is_some_and(|c| c.is_ascii_digit() || matches!(c, '?' | '#' | '@' | '*' | '$' | '!' | '-'))
  {
    (next.unwrap().to_string(), start + 2)
  } else {
    return Ok(None);
  };
  let expr = param::parameter(&name, interner);
  Ok(Some((expr, end)))
}


fn backtick_read_error(error: PosixReadError) -> PosixReadError {
  match error {
    PosixReadError::IncompleteCompound(_) | PosixReadError::IncompleteHeredoc(_)
      | PosixReadError::MissingFlowOperand(_) | PosixReadError::UnterminatedQuote
      | PosixReadError::UnbalancedSubstitution | PosixReadError::Empty =>
        PosixReadError::ShellExpansionUnsupported("backtick substitution".into()),
    error => error,
  }
}

/// Streaming callers must gather the body before treating EOF as a warning.
pub fn bash_heredoc_pending(source: &str) -> bool {
  matches!(redirection::heredocs(source), Err(PosixReadError::IncompleteHeredoc(_)))
}

fn backtick_source(chars: &[char], start: usize) -> Result<(String, usize), PosixReadError> {
  backtick_source_in_quotes(chars, start, false)
}

fn backtick_source_in_quotes(chars: &[char], start: usize, double: bool) -> Result<(String, usize), PosixReadError> {
  let mut source = String::new();
  let mut i = start;
  while i < chars.len() {
    match chars[i] {
      '`' => return Ok((source, i)),
      '\\'
        if chars
          .get(i + 1)
          .is_some_and(|c| matches!(c, '$' | '`' | '\\') || double && *c == '"') =>
      {
        i += 1;
        source.push(chars[i]);
      }
      c => source.push(c),
    }
    i += 1;
  }
  Err(PosixReadError::UnbalancedSubstitution)
}

fn scan<S, B>(
  line: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Vec<Atom<S>>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  use State::*;
  let chars = tilde_prefixes(&bash_line_chars(line)?, home, false);
  refuse_shell_syntax(&chars)?;
  let mut atoms = Vec::new();
  let mut word = String::new();
  let mut parts = Vec::new();
  let mut present = false;
  let mut in_word = false;
  let mut pure = false;
  let mut empty_quote = false;
  let mut state = Delimiter;
  let mut raw_start = 0;
  let mut i = 0;
  while i <= chars.len() {
    let c = chars.get(i).copied();
    if matches!(state, Delimiter) && c.is_some_and(|c| !c.is_whitespace()) {
      raw_start = i;
    }
    if matches!(state, Delimiter | Unquoted)
      && c == Some('$')
      && matches!(chars.get(i + 1), Some('\'' | '"'))
    {
      in_word = true;
      pure = false;
      if chars[i + 1] == '\'' {
        let (value, end) = decode_ansi_c_quote(&chars, i + 2)?;
        present |= value.is_empty();
        word.push_str(&value);
        state = Unquoted;
        i = end + 1;
      } else {
        empty_quote = true;
        state = Double;
        i += 2;
      }
      continue;
    }
    if matches!(state, Delimiter | Unquoted) {
      if let Some(end) = extglob::end(&chars, i) {
        // The group is one run of unquoted pattern characters.
        word.extend(&chars[i..end]);
        in_word = true;
        state = Unquoted;
        i = end;
        continue;
      }
    }
    if matches!(state, Delimiter | Unquoted | Double) {
      let expansion = if matches!(state, Delimiter | Unquoted)
        && matches!(c, Some('<' | '>'))
        && chars.get(i + 1) == Some(&'(')
      {
        Some(read_process_substitution(&chars, i, interner, home)?)
      } else if c == Some('$') {
        read_expansion_in(&chars, i, interner, home, matches!(state, Double))?
      } else if c == Some('`') {
        let (inner, end) = backtick_source_in_quotes(&chars, i + 1, matches!(state, Double))?;
        if inner.trim().is_empty() {
          // An empty substitution expands to nothing.
          Some((SExpression::Literal(Literal::String(String::new())), end + 1))
        } else {
          let command = read_statement_with_home(&inner, interner, home)
            .map_err(backtick_read_error)?;
          Some((call("std.sh.sub", vec![command], interner), end + 1))
        }
      } else {
        None
      };
      if let Some((value, end)) = expansion {
        flush_literal(&mut word, &mut present, &mut parts);
        parts.push((
          value,
          !matches!(state, Double) && !matches!(c, Some('<' | '>')),
        ));
        in_word = true;
        pure = false;
        empty_quote = false;
        if matches!(state, Delimiter) {
          state = Unquoted;
        }
        i = end;
        continue;
      }
    }
    state = match state {
      Delimiter => match c {
        None => break,
        Some(' ' | '\t' | '\n' | '\r') => Delimiter,
        Some(ch) => {
          in_word = true;
          pure = !matches!(ch, '\'' | '"' | '\\');
          match ch {
            '\'' => {
              empty_quote = true;
              Single
            }
            '"' => {
              empty_quote = true;
              Double
            }
            '\\' => Backslash,
            _ => {
              word.push(ch);
              Unquoted
            }
          }
        }
      },
      Unquoted => match c {
        None => break,
        Some(' ' | '\t' | '\n' | '\r') => {
          finish_word(
            &mut atoms,
            &mut word,
            &mut present,
            &mut parts,
            pure,
            home,
            &chars[raw_start..i].iter().collect::<String>(),
            interner,
          )?;
          in_word = false;
          Delimiter
        }
        Some('\'') => {
          pure = false;
          empty_quote = true;
          Single
        }
        Some('"') => {
          pure = false;
          empty_quote = true;
          Double
        }
        Some('\\') => {
          pure = false;
          UnquotedBackslash
        }
        Some(ch) => {
          word.push(ch);
          Unquoted
        }
      },
      Single => match c {
        None => return Err(PosixReadError::UnterminatedQuote),
        Some('\'') => {
          present |= empty_quote;
          Unquoted
        }
        Some(ch) => {
          empty_quote = false;
          word.push(ch);
          Single
        }
      },
      Double => match c {
        None => return Err(PosixReadError::UnterminatedQuote),
        Some('"') => {
          present |= empty_quote;
          Unquoted
        }
        Some('\\') => DoubleBackslash,
        Some(ch) => {
          empty_quote = false;
          word.push(ch);
          Double
        }
      },
      Backslash | UnquotedBackslash => match c {
        // A backslash that ends the input quotes nothing and stays.
        None => {
          word.push('\\');
          break;
        }
        Some(ch) => {
          word.push(ch);
          Unquoted
        }
      },
      DoubleBackslash => match c {
        None => return Err(PosixReadError::UnterminatedQuote),
        Some(ch) => {
          empty_quote = false;
          if !matches!(ch, '$' | '`' | '"' | '\\') {
            word.push('\\');
          }
          word.push(ch);
          Double
        }
      },
    };
    i += 1;
  }
  if in_word {
    finish_word(
      &mut atoms,
      &mut word,
      &mut present,
      &mut parts,
      pure,
      home,
      &chars[raw_start..i.min(chars.len())].iter().collect::<String>(),
      interner,
    )?;
  }
  Ok(atoms)
}

/// Check the simple parameter-name grammar (`$f`, `$HOME`).
pub(crate) fn is_dollar_ident(w: &str) -> bool {
  let Some(rest) = w.strip_prefix('$') else {
    return false;
  };
  let mut chars = rest.chars();
  match chars.next() {
    Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
    _ => return false,
  }
  chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Index of the `)` that closes a `$(` opened just before `start`, honoring
/// nested parens and quoted regions.
fn scan_balanced(chars: &[char], start: usize) -> Result<usize, PosixReadError> {
  let arithmetic = chars.get(start) == Some(&'(') && start > 0 && chars[start - 1] == '(';
  let mut depth = 1i32;
  let mut i = start;
  let mut quote: Option<char> = None;
  let mut heredocs = Vec::new();
  // case patterns own their optional '(' and terminating ')'. They are not
  // substitution delimiters. Track nested cases at their parenthesis depth.
  let mut cases: Vec<(i32, u8)> = Vec::new(); // header / pattern / body
  let mut position = true;
  while i < chars.len() {
    let c = chars[i];
    if quote.is_none() && c == '#' && (i == start || chars[i - 1].is_whitespace()
      || matches!(chars[i - 1], ';' | '(' | ')' | '&' | '|')) {
      while i < chars.len() && chars[i] != '\n' { i += 1; }
      continue;
    }
    if quote.is_none() && (c.is_ascii_alphabetic() || c == '_')
      && (i == start || chars[i - 1].is_whitespace() || matches!(chars[i - 1], ';' | '(' | ')' | '&' | '|')) {
      let mut end = i + 1;
      while chars.get(end).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') { end += 1; }
      let word: String = chars[i..end].iter().collect();
      let bare = chars.get(end).is_none_or(|c| c.is_whitespace() || matches!(c, ';' | '(' | ')' | '&' | '|'));
      if bare && word == "case" && position { cases.push((depth, 0)); }
      else if bare && word == "in" && cases.last() == Some(&(depth, 0)) { cases.last_mut().unwrap().1 = 1; }
      else if bare && word == "esac" && cases.last().is_some_and(|(d, _)| *d == depth)
        && (position || cases.last() == Some(&(depth, 1))) { cases.pop(); }
      position = bare && matches!(word.as_str(), "do" | "then" | "else" | "elif");
      i = end;
      continue;
    }
    if !arithmetic && quote.is_none() && c == '<' && chars.get(i + 1) == Some(&'<') {
      if chars.get(i + 2) == Some(&'<') { i += 3; continue; }
      let (end, word, tabs) = redirection::substitution_heredoc(chars, i)?;
      heredocs.push((word, tabs));
      i = end;
      continue;
    }
    if quote.is_none() && c == '\n' && !heredocs.is_empty() {
      i += 1;
      for (word, tabs) in heredocs.drain(..) {
        i = redirection::skip_substitution_heredoc(chars, i, &word, tabs)?;
      }
      continue;
    }
    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'(') {
      i = scan_balanced(chars, i + 2)? + 1;
      continue;
    }
    if quote != Some('\'') && c == '`' {
      i = backtick_source(chars, i + 1)?.1 + 1;
      continue;
    }
    if quote != Some('\'') && c == '$' && chars.get(i + 1) == Some(&'{') {
      i = parameter_span_end_in(chars, i + 2, quote == Some('"'));
      continue;
    }
    match quote {
      Some(q) => {
        if c == q {
          quote = None;
        } else if c == '\\' && q == '"' {
          i += 1; // skip the escaped char inside a double quote
        }
      }
      None => match c {
        '$' if chars.get(i + 1) == Some(&'\'') => {
          i = ansi_c_quote_end(chars, i + 2)?;
        }
        '\\' => i += 1,
        '\'' | '"' => quote = Some(c),
        ';' if chars.get(i + 1) == Some(&';') => {
          if let Some((d, state)) = cases.last_mut() { if *d == depth { *state = 1; } }
          i += 1;
          position = true;
        }
        ';' | '\n' | '&' | '|' => position = true,
        '(' if cases.last() == Some(&(depth, 1)) => {}
        '(' => { depth += 1; position = true; }
        ')' if cases.last() == Some(&(depth, 1)) => {
          cases.last_mut().unwrap().1 = 2;
          position = true;
        }
        ')' => {
          depth -= 1;
          if depth == 0 {
            return Ok(i);
          }
        }
        _ => {}
      },
    }
    i += 1;
  }
  Err(PosixReadError::UnbalancedSubstitution)
}

/// Serialize an [`SExpression`] into a canonical, structured JSON value — a
/// tagged union (`{"sym":…}` / `{"str":…}` / `{"int":…}` / `{"list":[…]}` …).
/// This is the alignment shape for fixtures: it is *built*, never parsed back
/// from a renderer, so the posix and lisp readers can be asserted to converge
/// on the same s-expression.
pub fn sexpr_to_json<S, B>(expr: &SExpression<S>, interner: &StringInterner<B>) -> serde_json::Value
where
  S: Symbol,
  B: Backend<S>,
{
  use serde_json::json;
  match expr {
    SExpression::Literal(lit) => match lit {
      Literal::Boolean(b) => json!({ "bool": b }),
      Literal::Integer(n) => json!({ "int": n }),
      Literal::Float(x) => json!({ "float": x }),
      Literal::String(s) => json!({ "str": s }),
      Literal::Symbol(sym) => json!({ "sym": interner.resolve(*sym).unwrap_or("") }),
      Literal::TaggedString { tag, payload } => json!({ "tag": tag, "payload": payload }),
    },
    SExpression::List(items) => {
      let arr: Vec<serde_json::Value> = items.iter().map(|e| sexpr_to_json(e, interner)).collect();
      json!({ "list": arr })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn environment_prefixes_lower_to_scoped_environment_data() {
    let mut i = intern();
    let got = read_statement::<SymbolU32, _>("FOO='a b' MYVAR=1 env", &mut i).unwrap();
    assert_eq!(
      got,
      lisp(
        "(std.sh.redirect (std.sh.cmd \"env\") (list (list \"env\" \"FOO\" \"a b\") (list \"env\" \"MYVAR\" \"1\")))",
        &mut i
      )
    );
    let got = read_statement::<SymbolU32, _>("FOO=$HOME env", &mut i).unwrap();
    assert_eq!(
      got,
      lisp(
        "(std.sh.redirect (std.sh.cmd \"env\") (list (list \"env\" \"FOO\" (std.sh.var \"HOME\"))))",
        &mut i
      )
    );
    assert!(read_statement::<SymbolU32, _>("FOO=bar env | cat", &mut i).is_ok());
    assert!(read_statement::<SymbolU32, _>("FOO=bar env >out", &mut i).is_ok());
  }

  #[test]
  fn assignment_values_keep_option_spellings_as_data() {
    for value in ["--help", "--json", "--flag=value", "-n"] {
      let mut i = intern();
      let got = read_statement::<SymbolU32, _>(&format!("FOO={value}"), &mut i).unwrap();
      assert_eq!(got, lisp(&format!("(let FOO \"{value}\")"), &mut i));
      assert!(read_statement::<SymbolU32, _>(&format!("FOO={value} env"), &mut i).is_ok());
    }
  }

  #[test]
  fn redirections_are_ordered_and_position_independent() {
    for source in [">out echo hi 2>&1", "echo >out hi 2>&1", "echo hi >out 2>&1"] {
      let mut i = intern();
      let got = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let expected = lisp("(std.sh.redirect (std.sh.cmd \"echo\" \"hi\") (list (list 1 \">\" \"out\") (list 2 \">&\" \"1\")))", &mut i);
      assert_eq!(got, expected, "{source}");
    }
    for op in [">", ">>", "<", "3>", "3>>", "3<", ">&", "2>&", "<&", "2>&", "&>", "&>>", ">|"] {
      let target = if op.ends_with('&') { "1" } else { "out" };
      assert!(read_statement::<SymbolU32, _>(&format!("echo hi {op}{target}"), &mut intern()).is_ok());
    }
    assert!(read_statement::<SymbolU32, _>("echo hi 2>&-", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("{ echo a; echo b; } >out", &mut intern()).is_ok());
  }

  #[test]
  fn heredocs_quote_bodies_and_strip_tabs() {
    for delimiter in ["'EOF'", "\"EOF\"", "\\EOF"] {
      let source = format!("cat <<{delimiter}\n$x $(unclosed `python\nEOF\n");
      let mut i = intern();
      let got = read_statement::<SymbolU32, _>(&source, &mut i).unwrap();
      assert_eq!(got, lisp("(std.sh.redirect (std.sh.cmd \"cat\") (list (list 0 \"<<\" \"$x $(unclosed `python\\n\")))", &mut i));
    }
    let mut i = intern();
    let got = read_statement::<SymbolU32, _>("cat <<-'EOF'\n\thi\n\tEOF\n", &mut i).unwrap();
    assert_eq!(got, lisp("(std.sh.redirect (std.sh.cmd \"cat\") (list (list 0 \"<<\" \"hi\\n\")))", &mut i));
    assert!(read_statement::<SymbolU32, _>("cat <<EOF\n$x $(echo hi)\nEOF\n", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("cat <<<\"a b\"", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("ssh host 'cat <<\"PY\"\n$( `python\nPY'", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("echo \"$(cat <<'EOF'\n$(unclosed `python\nEOF\n)\"", &mut intern()).is_ok());
  }

  #[test]
  fn last_history_reader_process_words_and_declarations() {
    for source in [
      "comm -12 <(sort a.txt) <(sort b.txt)",
      "echo hi > >(cat)",
      "echo prefix<(echo suffix)",
      "declare -A m; m[k]=v; echo \"${m[k]}\"",
      "declare -air n=3",
      "echo \"${!name}\"",
      "{ (echo a) & (echo b) & wait; } | sort",
      "while IFS=, read -r a b c; do echo \"$b\"; done",
    ] {
      assert!(
        read_statement::<SymbolU32, _>(source, &mut intern()).is_ok(),
        "{source}"
      );
    }
  }

  #[test]
  fn redirections_keep_coprocess_forms_loud() {
    for source in ["coproc cat >out"] {
      assert!(matches!(read_statement::<SymbolU32, _>(source, &mut intern()),
        Err(PosixReadError::ShellOperatorUnsupported(_))), "{source}");
    }
    assert!(read_statement::<SymbolU32, _>("echo hi >--mode=x", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("echo hi >\"single'quote\"", &mut intern()).is_ok());
  }
  use crate::Runtime;
  use string_interner::{StringInterner, backend::StringBackend, symbol::SymbolU32};

  fn lisp(source: &str, i: &mut StringInterner<StringBackend>) -> SExpression<SymbolU32> {
    Runtime::<SymbolU32, StringBackend>::parse(None, source, i).unwrap().remove(0)
  }

  fn intern() -> StringInterner<StringBackend> {
    StringInterner::<StringBackend>::new()
  }

  fn posix(line: &str, i: &mut StringInterner<StringBackend>) -> SExpression<SymbolU32> {
    read_posix(line, i).expect("posix read")
  }

  fn shell_plan(line: &str, i: &mut StringInterner<StringBackend>) -> SExpression<SymbolU32> {
    read_shell_plan(line, i).expect("shell plan read")
  }

  fn assert_expansion(source: &str, compiled: &str) {
    let mut i = intern();
    let got = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
    let want = Runtime::<SymbolU32, StringBackend>::parse(None, compiled, &mut i).unwrap();
    assert_eq!(got, want[0], "{source}");
    assert_eq!(shell_plan(source, &mut i), got, "flow reader: {source}");
  }

  #[test]
  fn incomplete_brackets_are_literal_and_expanded_heads_are_runtime_commands() {
    for (pattern, expected) in [
      ("[", false),
      ("[[", false),
      ("a[", false),
      ("x[1", false),
      ("[]", false),
      ("[!]", false),
      ("[]]", true),
      ("[a-z]", true),
      (r"[a\]", false),
      (r"[\]]", true),
      ("[a/b]", false),
      ("[[:alpha:]]", true),
    ] {
      assert_eq!(has_pathname_pattern(pattern), expected, "{pattern}");
    }
    for name in ["[", "a[", "x[1", "[]", "[!]"] {
      let mut i = intern();
      let got = read_posix::<SymbolU32, _>(&format!("{name} a"), &mut i).unwrap();
      assert_eq!(
        got,
        SExpression::List(vec![
          SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
          SExpression::Literal(Literal::String(name.into())),
          SExpression::Literal(Literal::String("a".into())),
        ]),
        "{name}"
      );
    }
    let mut i = intern();
    let bracket = read_statement::<SymbolU32, _>("[ a = b ]", &mut i).unwrap();
    assert!(is_call(&bracket, "std.sh.cmd", &i));
    assert!(matches!(&bracket, SExpression::List(items)
      if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "[")));
    // A computed command word is a word expression, never a string literal.
    for source in ["$SH -c 'echo hi'", r#""$cmd" args"#, "./tool* args"] {
      let mut i = intern();
      let form = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      assert!(is_call(&form, "std.sh.cmd", &i), "{source}");
      assert!(matches!(&form, SExpression::List(items)
        if !matches!(items.get(1), Some(SExpression::Literal(Literal::String(_))))), "{source}");
    }
    assert!(read_statement::<SymbolU32, _>("[[ a = b ]]", &mut intern()).is_ok());
  }

  /// I12 note: a quoted or escaped command word carries a marker, because
  /// bash expands aliases only on unquoted command words; arguments never do.
  #[test]
  fn quoted_command_words_are_marked_and_read_back() {
    for (source, compiled) in [
      ("ls -l", r#"(std.sh.cmd "ls" "-l")"#),
      ("'ls' -l", r#"(std.sh.cmd (std.sh.word.quoted "ls") "-l")"#),
      (r#""ls" -l"#, r#"(std.sh.cmd (std.sh.word.quoted "ls") "-l")"#),
      (r"\ls -l", r#"(std.sh.cmd (std.sh.word.quoted "ls") "-l")"#),
      (r"l\s -l", r#"(std.sh.cmd (std.sh.word.quoted "ls") "-l")"#),
      ("''ls", r#"(std.sh.cmd (std.sh.word.quoted "ls"))"#),
      ("$'ls'", r#"(std.sh.cmd (std.sh.word.quoted "ls"))"#),
      ("ls 'a' \\b", r#"(std.sh.cmd "ls" "a" "b")"#),
      ("'it'\\''s'", r#"(std.sh.cmd (std.sh.word.quoted "it's"))"#),
      ("true && 'ls'", r#"(std.sh.and (std.sh.cmd "true") (std.sh.cmd (std.sh.word.quoted "ls")))"#),
    ] {
      assert_expansion(source, compiled);
      let mut i = intern();
      let form = shell_plan(source, &mut i);
      // The canonical text reads back as the same form (C4) ...
      assert_eq!(lisp(&crate::render_lisp(&form, &i), &mut i), form, "{source}");
      // ... and the bash rendering keeps the quoting, so it compiles back too.
      let posix = crate::render_posix(&form, &i);
      assert_eq!(shell_plan(&posix, &mut i), form, "{source} -> {posix}");
    }
    // An unmarked name prints bare whenever bash reads it back unquoted, so
    // the rendering never adds a marker; otherwise it is quoted as before.
    for (form, posix) in [
      (r#"(std.sh.cmd ":")"#, ":"),
      (r#"(std.sh.cmd "[")"#, "["),
      (r#"(std.sh.cmd "-x")"#, "-x"),
      (r#"(std.sh.cmd "e{cho")"#, "e{cho"),
      (r#"(std.sh.cmd "a=b")"#, r#""a=b""#),
      (r#"(std.sh.cmd "*")"#, r#""*""#),
    ] {
      let mut i = intern();
      assert_eq!(crate::render_posix(&lisp(form, &mut i), &i), posix, "{form}");
    }
  }

  #[test]
  fn pathname_words_compile_with_split_and_quote_metadata() {
    assert_expansion(
      "args *",
      r#"(std.sh.cmd "args" (std.sh.split (list (list false "*" true))))"#,
    );
    assert_expansion(
      r#"args pre*"mid"?"#,
      r#"(std.sh.cmd "args" (std.sh.split (list (list false "pre*" true) (list false "mid" false) (list false "?" true))))"#,
    );
    for source in [r#"args "*""#, r"args \*", "args '*'", "args $'*'"] {
      assert_expansion(source, r#"(std.sh.cmd "args" "*")"#);
    }
    assert_expansion("saved=*", r#"(let saved "*")"#);
    assert_expansion("args plain", r#"(std.sh.cmd "args" "plain")"#);
    assert_expansion("set -f", "(std.sh.cmd \"set\" \"-f\")");
    assert_expansion("set -o noglob", "(std.sh.cmd \"set\" \"-o\" \"noglob\")");
    assert_expansion("set +f", "(std.sh.cmd \"set\" \"+f\")");
    assert_expansion("set +o noglob", "(std.sh.cmd \"set\" \"+o\" \"noglob\")");
  }

  #[test]
  fn pathname_patterns_do_not_change_pre_split_argv_or_later_refusals() {
    let mut i = intern();
    assert_eq!(argv(&["args", "*"], &mut i), lisp(r#"(args "*")"#, &mut i));
    assert_expansion(
      "case x in *) echo yes ;; esac",
      r#"(std.sh.case "x" (std.sh.arm (list (list (list "*" true))) (std.sh.cmd "echo" "yes") ";;") "x")"#,
    );
    for source in ["[[ x == * ]]"] {
      assert!(
        read_statement::<SymbolU32, _>(source, &mut intern()).is_ok(),
        "{source}"
      );
    }
    assert_expansion(
      r"args [C\-D]",
      r#"(std.sh.cmd "args" (std.sh.split (list (list false "[C" true) (list false "-" false) (list false "D]" true))))"#,
    );
    // The home (`HOME=/home/*`) is a quoted runtime part: never a pattern.
    let compiled =
      read_posix_with_home::<SymbolU32, _>("args ~/*", &mut i, Some("")).unwrap();
    assert_eq!(
      compiled,
      lisp(
        r#"(std.sh.cmd "args" (std.sh.split (list (list false "" false) (list false (std.sh.tilde "") false) (list false "/*" true))))"#,
        &mut i
      )
    );
  }

  #[test]
  fn declaration_values_are_assignment_words_and_other_arguments_still_split() {
    for name in ["local", "export", "declare", "typeset", "readonly"] {
      assert_expansion(
        &format!("{name} foo=$value $names"),
        &format!(r#"(std.sh.cmd "{name}" (str.concat "foo=" (std.sh.var "value")) (std.sh.split (list (list true (std.sh.var "names")))))"#),
      );
      // A literal value is one word: no join, no option parsing, no globbing.
      assert_expansion(&format!("{name} foo=--help"), &format!(r#"(std.sh.cmd "{name}" "foo=--help")"#));
      assert_expansion(&format!("{name} foo=*"), &format!(r#"(std.sh.cmd "{name}" "foo=*")"#));
      assert_expansion(&format!("{name} r=1"), &format!(r#"(std.sh.cmd "{name}" "r=1")"#));
    }
  }

  #[test]
  fn backquotes_inside_double_quotes_strip_escaped_double_quotes() {
    assert_expansion(
      r#"echo "`echo \"hi\"`""#,
      r#"(std.sh.cmd "echo" (str.concat (std.sh.sub (std.sh.cmd "echo" "hi"))))"#,
    );
    let mut i = intern();
    assert_eq!(
      read_statement::<SymbolU32, _>(r#"echo `echo \"hi\"`"#, &mut i).unwrap(),
      read_statement::<SymbolU32, _>(r#"echo $(echo '"hi"')"#, &mut i).unwrap(),
    );
  }

  #[test]
  fn shopt_options_are_runtime_commands() {
    for option in ["nullglob", "failglob", "dotglob", "nocaseglob", "globstar", "globskipdots"] {
      for flag in ["-s", "-u"] {
        assert!(read_statement::<SymbolU32, _>(&format!("shopt {flag} {option}"), &mut intern()).is_ok());
      }
    }
  }

  #[test]
  fn whole_unquoted_expansions_reach_the_runtime_without_coercion() {
    assert_expansion(
      "args $record",
      r#"(std.sh.cmd "args" (std.sh.split (list (list true (std.sh.var "record")))))"#,
    );
    assert_expansion("saved=$(record)", "(let saved (std.sh.sub (std.sh.cmd \"record\")))");
    assert_expansion("saved=$record", r#"(let saved (std.sh.var "record"))"#);
    assert_expansion("args plain 'quoted'", r#"(std.sh.cmd "args" "plain" "quoted")"#);
  }

  #[test]
  fn bash_expansion_builds_quoted_words() {
    for (source, compiled) in [
      (r#"echo "$HOME""#, r#"(std.sh.cmd "echo" (str.concat (std.sh.var "HOME")))"#),
      (r#"echo "a $x b""#, r#"(std.sh.cmd "echo" (str.concat "a " (std.sh.var "x") " b"))"#),
      (r#"echo "${x}y""#, r#"(std.sh.cmd "echo" (str.concat (std.sh.var "x") "y"))"#),
      (r#"echo "$(pick a)""#, r#"(std.sh.cmd "echo" (str.concat (std.sh.sub (std.sh.cmd "pick" "a"))))"#),
      (r#"echo "`pick a`""#, r#"(std.sh.cmd "echo" (str.concat (std.sh.sub (std.sh.cmd "pick" "a"))))"#),
      ("echo '$x'", r#"(std.sh.cmd "echo" "$x")"#),
      (r#"echo "\$x""#, r#"(std.sh.cmd "echo" "$x")"#),
      ("x=hello", r#"(let x "hello")"#),
      ("x=$HOME", r#"(let x (std.sh.var "HOME"))"#),
      ("x=$(pick a)y", r#"(let x (str.concat (std.sh.sub (std.sh.cmd "pick" "a")) "y"))"#),
      (
        r#"echo "$? ${?}""#,
        r#"(std.sh.cmd "echo" (str.concat (std.sh.status) " " (std.sh.status)))"#,
      ),
    ] {
      assert_expansion(source, compiled);
    }
  }

  #[test]
  fn bash_expansion_marks_only_unquoted_parts_for_splitting() {
    for (source, compiled) in [
      (
        "echo $x",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.var "x")))))"#,
      ),
      (
        "echo $HOME",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.var "HOME")))))"#,
      ),
      (
        "echo ${HOME}",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.var "HOME")))))"#,
      ),
      (
        "echo pre$HOME",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list false "pre") (list true (std.sh.var "HOME")))))"#,
      ),
      (
        "echo $(echo hi)x",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "echo" "hi"))) (list false "x"))))"#,
      ),
      (
        r#"echo "a b"$x"#,
        r#"(std.sh.cmd "echo" (std.sh.split (list (list false "a b") (list true (std.sh.var "x")))))"#,
      ),
      (
        r#"echo ""$x"#,
        r#"(std.sh.cmd "echo" (std.sh.split (list (list false "") (list true (std.sh.var "x")))))"#,
      ),
      (
        "echo $?",
        r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.status)))))"#,
      ),
    ] {
      assert_expansion(source, compiled);
    }
  }

  #[test]
  fn unsupported_bash_expansions_refuse_inside_and_outside_quotes() {
    for construct in [
      "${!x:-d}",
    ] {
      for source in [format!("echo {construct}"), format!("echo \"{construct}\"")] {
        let err = read_statement::<SymbolU32, _>(&source, &mut intern()).unwrap_err();
        assert!(
          err.to_string().contains("not supported yet"),
          "{source}: {err}"
        );
        assert!(err.to_string().contains(construct), "{source}: {err}");
        assert!(read_shell_plan::<SymbolU32, _>(&source, &mut intern()).is_err());
      }
      let literal = posix(&format!("echo '{construct}'"), &mut intern());
      assert_eq!(args_of(&literal), vec![construct]);
    }
  }

  #[test]
  fn live_operator_precedence_and_negation() {
    for (source, expected) in [
      ("a; b;", "(std.sh.seq (std.sh.cmd \"a\") (std.sh.cmd \"b\"))"),
      // A command on a later line carries its line marker (Q8/Q9).
      ("a\nb\n", "(std.sh.seq (std.sh.cmd \"a\") (std.sh.line 1 (std.sh.cmd \"b\")))"),
      ("a &&\nb", "(std.sh.and (std.sh.cmd \"a\") (std.sh.cmd \"b\"))"),
      (
        "! a | b && c || d",
        "(std.sh.or (std.sh.and (std.sh.not (std.sh.pipe (std.sh.cmd \"a\") (std.sh.cmd \"b\"))) (std.sh.cmd \"c\")) (std.sh.cmd \"d\"))",
      ),
      ("a || b && c", "(std.sh.and (std.sh.or (std.sh.cmd \"a\") (std.sh.cmd \"b\")) (std.sh.cmd \"c\"))"),
      (
        "a && b || c && d",
        "(std.sh.and (std.sh.or (std.sh.and (std.sh.cmd \"a\") (std.sh.cmd \"b\")) (std.sh.cmd \"c\")) (std.sh.cmd \"d\"))",
      ),
      ("a | b | c", "(std.sh.pipe (std.sh.cmd \"a\") (std.sh.cmd \"b\") (std.sh.cmd \"c\"))"),
      ("a; ! b; c", "(std.sh.seq (std.sh.cmd \"a\") (std.sh.not (std.sh.cmd \"b\")) (std.sh.cmd \"c\"))"),
    ] {
      let mut i = intern();
      let got = read_statement::<SymbolU32, _>(source, &mut i).unwrap();
      let want = Runtime::<SymbolU32, StringBackend>::parse(None, expected, &mut i).unwrap();
      assert_eq!(got, want[0], "{source}");
    }
  }

  #[test]
  fn live_operators_preserve_word_data_and_refuse_remaining_constructs() {
    let mut i = intern();
    for source in [r#"echo '; && || | !'"#, r"echo \! \; \|", "echo !suffix"] {
      assert_eq!(
        read_statement::<SymbolU32, _>(source, &mut i).unwrap(),
        posix(source, &mut i)
      );
    }
    let plan = read_statement::<SymbolU32, _>("echo $(one | two); echo ok", &mut i).unwrap();
    assert_eq!(sexpr_to_json(&plan, &i)["list"][0]["sym"], "std.sh.seq");
    for (source, name) in [
      ("a ( b )", "("),
    ] {
      let err = read_statement::<SymbolU32, _>(source, &mut i).unwrap_err();
      assert!(err.to_string().contains(name), "{source}: {err}");
    }
  }

  #[test]
  fn command_lines_refuse_unlowered_shell_operators() {
    for op in [
      "(", ")",
    ] {
      for line in [format!("echo a {op} b"), format!("echo a{op}b")] {
        let err = read_statement::<SymbolU32, _>(&line, &mut intern()).unwrap_err();
        assert_eq!(
          err,
          PosixReadError::ShellOperatorUnsupported(op.into()),
          "{line}"
        );
        assert!(
          err
            .to_string()
            .contains("not supported on a tsh command line"),
          "{line}: {err}"
        );
      }
    }
  }

  #[test]
  fn quoted_and_escaped_shell_operators_are_data() {
    for op in [
      "&&", "||", ";", "|", "&", ">", ">>", "<", "<<", "<<<", "2>", "2>&1", ">&2", "&>", "(", ")",
    ] {
      let escaped: String = op.chars().map(|c| format!("\\{c}")).collect();
      for word in [format!("'{op}'"), format!("\"{op}\""), escaped] {
        let got = posix(&format!("echo {word}"), &mut intern());
        assert_eq!(args_of(&got), vec![op], "{word}");
      }
    }
  }

  #[test]
  fn brace_lists_compile_before_quote_removal() {
    for word in [
      "{a,b}",
      "{1..3}",
      "{a,b}.txt",
      "x/{a,b}",
      r#"{"a","b"}"#,
      r#""prefix"{a,b}"#,
      "{a,{b,c}}",
      "{a..c}",
      "{3..1}",
      "{01..03}",
      "{1..5..2}",
      r#""$(echo {a,b})""#,
      "pre$(echo {a,b})post",
      "{a,{b,c}",
    ] {
      for line in [format!("echo {word}"), format!("value={word}")] {
        assert!(read_statement::<SymbolU32, _>(&line, &mut intern()).is_ok(), "{line}");
      }
      assert!(read_shell_plan::<SymbolU32, _>(&format!("echo {word} | sink"), &mut intern()).is_ok());
    }
  }

  #[test]
  fn literal_braces_and_parameter_spans_pass_through() {
    for (word, literal) in [
      ("{}", "{}"),
      ("{a}", "{a}"),
      ("'{a,b}'", "{a,b}"),
      (r#""{a,b}""#, "{a,b}"),
      (r"\{a,b\}", "{a,b}"),
      (r"{a\,b}", "{a,b}"),
      ("{1..x}", "{1..x}"),
      ("{a,b", "{a,b"),
      ("{1..3..x}", "{1..3..x}"),
      (r#"{"1"..3}"#, "{1..3}"),
      (r"{1\.\.3}", "{1..3}"),
    ] {
      let got = posix(&format!("echo {word}"), &mut intern());
      assert_eq!(args_of(&got), vec![literal], "{word}");
      assert_eq!(shell_plan(&format!("echo {word}"), &mut intern()), got);
    }
  }

  #[test]
  fn brace_lists_do_not_cross_word_boundaries() {
    let got = posix("echo {a, b} {1.. 3}", &mut intern());
    assert_eq!(args_of(&got), vec!["{a,", "b}", "{1..", "3}"]);
  }

  #[test]
  fn substitutions_keep_their_reader_and_refuse_inner_shell_syntax() {
    assert!(read_statement::<SymbolU32, _>("echo $(pick a)", &mut intern()).is_ok());
    for line in [r"echo $(pick \()", r"echo $(pick \))", r"echo $(pick \|)"] {
      assert!(
        read_statement::<SymbolU32, _>(line, &mut intern()).is_ok(),
        "{line}"
      );
    }
    // A list inside a substitution is Bash, including redirections.
    assert!(read_statement::<SymbolU32, _>("echo $(pick a && pick b)", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>(r#"echo "$(pick a > out)""#, &mut intern()).is_ok());
    // `select` and `time` are compound syntax (Q7/Q8).
    assert!(read_statement::<SymbolU32, _>("select x in a b; do :; done", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("time -p a | b", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("list | pick --field name", &mut intern()).is_ok());
    assert!(read_statement::<SymbolU32, _>("echo '$(pick {a,b})'", &mut intern()).is_ok());
  }

  #[test]
  fn argv_and_lisp_literal_syntax_stays_literal() {
    let got = argv(&["echo", "{a,b}", "&&", ">"], &mut intern());
    assert_eq!(strings_of(&got), vec!["{a,b}", "&&", ">"]);
    assert!(
      Runtime::<SymbolU32, StringBackend>::parse(None, r#"(std.sh.cmd "echo" "{a,b}" "&&" ">")"#, &mut intern())
        .is_ok()
    );
  }

  #[test]
  fn option_words_are_literal_on_line_and_argv_doors() {
    let words = ["--untracked-files=no", "--no-deps", "--json", "--help", "--", "-rn"];
    let mut i = intern();
    let strings = || words.iter().map(|w| SExpression::Literal(Literal::String((*w).into())));
    let mut line_want = vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("probe".into())),
    ];
    line_want.extend(strings());
    assert_eq!(posix(&format!("probe {}", words.join(" ")), &mut i), SExpression::List(line_want));
    let mut argv_want = vec![SExpression::Literal(Literal::Symbol(i.get_or_intern("probe")))];
    argv_want.extend(strings());
    let mut argv_words = vec!["probe"];
    argv_words.extend(words);
    assert_eq!(argv(&argv_words, &mut i), SExpression::List(argv_want));
  }

  #[test]
  fn command_name_is_a_string_args_are_strings() {
    let mut i = intern();
    let got = posix("ls -la /tmp", &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("ls".into())),
      SExpression::Literal(Literal::String("-la".into())),
      SExpression::Literal(Literal::String("/tmp".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn long_flag_is_a_literal_string() {
    let mut i = intern();
    let got = posix("ls --all /tmp", &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("ls".into())),
      SExpression::Literal(Literal::String("--all".into())),
      SExpression::Literal(Literal::String("/tmp".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn quoted_long_flag_stays_literal() {
    let mut i = intern();
    let got = posix("ls \"--all\"", &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("ls".into())),
      SExpression::Literal(Literal::String("--all".into())),
    ]);
    assert_eq!(
      got, want,
      "a quoted --all is the literal string, not a keyword"
    );
  }

  #[test]
  fn long_flag_with_value_stays_one_string() {
    let mut i = intern();
    let got = posix("cp --mode=fast a", &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("cp".into())),
      SExpression::Literal(Literal::String("--mode=fast".into())),
      SExpression::Literal(Literal::String("a".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn posix_long_flag_reads_identically_to_lisp_string() {
    // Source words compile literally; keyword binding belongs to the callee.
    let mut i = intern();
    let p = posix("ls --all /tmp", &mut i);
    let l = Runtime::<SymbolU32, StringBackend>::parse(None, "(std.sh.cmd \"ls\" \"--all\" \"/tmp\")", &mut i).unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(p, l[0], "posix --all reads as a Lisp string");
  }

  fn argv(words: &[&str], i: &mut StringInterner<StringBackend>) -> SExpression<SymbolU32> {
    let owned: Vec<String> = words.iter().map(|w| w.to_string()).collect();
    read_posix_argv(&owned, i).expect("posix argv read")
  }

  #[test]
  fn argv_head_is_symbol_args_are_strings() {
    let mut i = intern();
    let got = argv(&["ls", "-la", "/tmp"], &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("ls"))),
      SExpression::Literal(Literal::String("-la".into())),
      SExpression::Literal(Literal::String("/tmp".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn argv_long_flag_stays_literal_and_unsplit() {
    let mut i = intern();
    let got = argv(&["cp", "--all", "--mode=fast", "a"], &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("cp"))),
      SExpression::Literal(Literal::String("--all".into())),
      SExpression::Literal(Literal::String("--mode=fast".into())),
      SExpression::Literal(Literal::String("a".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn argv_reads_to_the_call_the_lisp_door_reads_and_the_line_to_a_command_form() {
    // The argv door is a registered name (a symbol head, literal string
    // arguments); a Bash line is `std.sh.cmd` over the same words.
    let mut i = intern();
    let a = argv(&["ls", "--all", "/tmp"], &mut i);
    let line = posix("ls --all /tmp", &mut i);
    let l = Runtime::<SymbolU32, StringBackend>::parse(None, "(ls \"--all\" \"/tmp\")", &mut i).unwrap();
    assert_eq!(a, l[0], "argv door reads identically to the lisp call");
    assert_eq!(args_of(&line), strings_of(&a), "the line carries the same argument words");
    assert_eq!(args_of(&line), vec!["--all", "/tmp"]);
  }

  #[test]
  fn argv_dollar_word_is_a_literal_not_a_reference() {
    // The outer shell already expanded `$f`; a `$`-word reaching the argv door
    // is a literal (unlike the line reader, which flips it to a reference).
    let mut i = intern();
    let got = argv(&["cat", "$f"], &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("cat"))),
      SExpression::Literal(Literal::String("$f".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn argv_empty_errors() {
    let mut i = intern();
    assert_eq!(
      read_posix_argv::<SymbolU32, _>(&[], &mut i),
      Err(PosixReadError::Empty)
    );
  }

  #[test]
  fn dollar_word_uses_runtime_lookup_and_splitting() {
    assert_expansion(
      "cat $f",
      r#"(std.sh.cmd "cat" (std.sh.split (list (list true (std.sh.var "f")))))"#,
    );
  }

  #[test]
  fn quoted_dollar_expands_without_splitting() {
    assert_expansion(r#"echo "$f""#, r#"(std.sh.cmd "echo" (str.concat (std.sh.var "f")))"#);
  }

  #[test]
  fn substitution_is_a_nested_call() {
    assert_expansion(
      r#"cat $(ls "/tmp")"#,
      r#"(std.sh.cmd "cat" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "ls" "/tmp"))))))"#,
    );
  }

  fn posix_home(
    line: &str,
    home: Option<&str>,
    i: &mut StringInterner<StringBackend>,
  ) -> SExpression<SymbolU32> {
    read_statement_with_home(line, i, home).expect("posix read with home")
  }

  /// The words after the command name of a `(std.sh.cmd "name" word…)` form.
  fn args_of(expr: &SExpression<SymbolU32>) -> Vec<String> {
    strings_of(expr).into_iter().skip(1).collect()
  }

  fn strings_of(expr: &SExpression<SymbolU32>) -> Vec<String> {
    match expr {
      SExpression::List(items) => items
        .iter()
        .filter_map(|e| match e {
          SExpression::Literal(Literal::String(s)) => Some(s.clone()),
          _ => None,
        })
        .collect(),
      _ => vec![],
    }
  }

  #[test]
  fn tilde_lowers_to_a_runtime_home_lookup() {
    let mut i = intern();
    // `~` is read when the word expands (`std.sh.tilde`), so a `HOME=` earlier on
    // the same line, or before a function is called, is followed.
    let cases = [
      ("mkdir ~/.config/tsh/scenes", r#"(std.sh.cmd "mkdir" (str.concat (std.sh.tilde "") "/.config/tsh/scenes"))"#),
      ("cd ~", r#"(std.sh.cmd "cd" (str.concat (std.sh.tilde "")))"#),
      ("cp ~/a.txt ~/b.txt", r#"(std.sh.cmd "cp" (str.concat (std.sh.tilde "") "/a.txt") (str.concat (std.sh.tilde "") "/b.txt"))"#),
      // The result is one quoted field: never split, never globbed.
      ("echo ~/*.py", r#"(std.sh.cmd "echo" (std.sh.split (list (list false "" false) (list false (std.sh.tilde "") false) (list false "/*.py" true))))"#),
      ("echo ~1 ~-0 ~+ ~- ~alice", r#"(std.sh.cmd "echo" (str.concat (std.sh.tilde "1")) (str.concat (std.sh.tilde "-0")) (str.concat (std.sh.tilde "+")) (str.concat (std.sh.tilde "-")) (str.concat (std.sh.tilde "alice")))"#),
    ];
    for (line, want) in cases {
      let got = posix_home(line, Some(""), &mut i);
      assert_eq!(crate::render_lisp(&got, &i), want, "for `{line}`");
    }
  }

  #[test]
  fn tilde_lowers_in_every_word_context() {
    let mut i = intern();
    for line in [
      "HOME=/h; echo ~",
      "f() { echo ~; }",
      "if true; then echo ~/x; fi",
      "cat <<< ~",
      "declare v=~",
      "export y=~ z=a:~",
      "echo hi > ~/f",
      "[[ $x == ~ ]]",
      "case $x in ~) echo y;; esac",
      "echo ${y:-~}",
      "echo {~,x}/y",
      "echo ~{/a,/b}",
      "for d in ~ ~/b; do echo $d; done",
    ] {
      let plan: SExpression<SymbolU32> = read_shell_plan_with_home(line, &mut i, Some("")).expect(line);
      let form = crate::render_lisp(&plan, &i);
      assert!(form.contains(r#"(std.sh.tilde "")"#), "`{line}` lowered to {form}");
    }
  }

  #[test]
  fn tilde_text_that_bash_keeps_stays_literal() {
    let mut i = intern();
    for line in ["cat <<EOF\n~ ~/b\nEOF", "echo \"${y-~}\"", "echo hi # ~"] {
      let plan: SExpression<SymbolU32> = read_shell_plan_with_home(line, &mut i, Some("")).expect(line);
      let form = crate::render_lisp(&plan, &i);
      assert!(!form.contains("std.sh.tilde"), "`{line}` lowered to {form}");
    }
  }

  #[test]
  fn quoted_and_midword_tildes_stay_literal() {
    let mut i = intern();
    for line in ["echo '~/x'", "echo \"~/x\"", "echo \\~/x"] {
      let got = posix_home(line, Some("/home/u"), &mut i);
      assert_eq!(args_of(&got), vec!["~/x"], "for `{line}`");
    }
    // Mid-word tildes never expand — only a word-LEADING `~` qualifies.
    let got = posix_home("echo a~b x/~/y", Some("/home/u"), &mut i);
    assert_eq!(args_of(&got), vec!["a~b", "x/~/y"]);
  }

  #[test]
  fn no_declared_home_means_no_expansion() {
    // `None` home (no HOME in the declared session env) → literal pass-through;
    // the plain `read_statement` door is exactly the `None` case.
    let mut i = intern();
    let got = posix_home("mkdir ~/x", None, &mut i);
    assert_eq!(args_of(&got), vec!["~/x"]);
    assert_eq!(
      posix("mkdir ~/x", &mut i),
      posix_home("mkdir ~/x", None, &mut i)
    );
  }

  #[test]
  fn tilde_expands_in_substitutions_and_assignments() {
    let mut i = intern();
    // The `$(…)` sub-line scans with the same home.
    let got = posix_home("cat $(ls ~/d)", Some(""), &mut i);
    let want = Runtime::<SymbolU32, StringBackend>::parse(
      None,
      r#"(std.sh.cmd "cat" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "ls" (str.concat (std.sh.tilde "") "/d")))))))"#,
      &mut i,
    )
    .unwrap()
    .remove(0);
    assert_eq!(got, want);
    // An assignment's rhs expands too: `p=~/x` captures the real path.
    let got = posix_home("p=~/x", Some(""), &mut i);
    assert_eq!(crate::render_lisp(&got, &i), r#"(let p (str.concat (std.sh.tilde "") "/x"))"#);
  }

  #[test]
  fn quotes_group_and_strip() {
    let mut i = intern();
    let got = posix("echo \"a b\" c", &mut i);
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("echo".into())),
      SExpression::Literal(Literal::String("a b".into())),
      SExpression::Literal(Literal::String("c".into())),
    ]);
    assert_eq!(got, want);
  }

  fn assert_bash_word(source: &str, value: &str) {
    let got = posix(source, &mut intern());
    assert_eq!(args_of(&got), vec![value], "{source}");
  }

  #[test]
  fn double_quotes_keep_regex_backslashes() {
    assert_bash_word(r#"grep "foo\.bar""#, r"foo\.bar");
  }

  #[test]
  fn double_quotes_keep_windows_path_backslashes() {
    assert_bash_word(r#"echo "C:\temp\new""#, r"C:\temp\new");
  }

  #[test]
  fn double_quotes_decode_escaped_dollars() {
    assert_bash_word(r#"echo "cost \$5""#, "cost $5");
  }

  #[test]
  fn double_quotes_decode_escaped_backticks() {
    assert_bash_word(r#"echo "x\`y""#, "x`y");
  }

  #[test]
  fn double_quotes_decode_escaped_backslashes() {
    assert_bash_word(r#"echo "a\\b""#, r"a\b");
  }

  #[test]
  fn double_quotes_decode_escaped_quotes() {
    assert_bash_word(r#"echo "say \"hi\"""#, "say \"hi\"");
  }

  #[test]
  fn double_quotes_remove_backslash_newline() {
    assert_bash_word("echo \"a\\\nb\"", "ab");
  }

  #[test]
  fn ansi_c_quotes_decode_tabs() {
    assert_bash_word(r"echo $'a\tb'", "a\tb");
  }

  #[test]
  fn ansi_c_quotes_decode_hex_octal_and_unicode() {
    assert_bash_word(r"echo $'\x41\101\u00e9'", "AAé");
  }

  #[test]
  fn ansi_c_quotes_join_adjacent_word_parts() {
    assert_bash_word(r"echo pre$'\n'post", "pre\npost");
  }

  #[test]
  fn double_quotes_preserve_every_non_bash_escape() {
    for escape in '\0'..='\u{007f}' {
      let source = format!("echo \"a\\{escape}b\"");
      let value = match escape {
        '$' | '`' | '"' | '\\' => format!("a{escape}b"),
        '\n' => "ab".to_string(),
        _ => format!("a\\{escape}b"),
      };
      assert_bash_word(&source, &value);
    }
    assert_bash_word(r#"echo "\d\/\u0041\λ""#, r"\d\/\u0041\λ");
  }

  #[test]
  fn bash_quotes_and_lisp_strings_agree_by_value() {
    for (source, lisp) in [
      (r#"echo "a\tb""#, r#"(std.sh.cmd "echo" "a\\tb")"#),
      (r"echo $'a\tb'", r#"(std.sh.cmd "echo" "a\tb")"#),
      (r#"echo "a\\b\"c""#, r#"(std.sh.cmd "echo" "a\\b\"c")"#),
    ] {
      let mut pi = intern();
      let got = posix(source, &mut pi);
      let mut li = intern();
      let want = Runtime::<SymbolU32, StringBackend>::parse(None, lisp, &mut li).unwrap();
      assert_eq!(
        sexpr_to_json(&got, &pi),
        sexpr_to_json(&want[0], &li),
        "{source}"
      );
    }
  }

  #[test]
  fn missing_bash_quote_always_reports_unterminated_quote() {
    for source in [
      "echo \"a\\",
      "echo \"a",
      "echo 'a",
      "echo $'a",
      "echo $'a\\",
    ] {
      assert_eq!(
        read_posix::<SymbolU32, _>(source, &mut intern()).unwrap_err(),
        PosixReadError::UnterminatedQuote,
        "{source}"
      );
    }
  }

  #[test]
  fn ansi_c_quotes_decode_the_bash_escape_table() {
    for (source, value) in [
      (
        r"echo $'\a\b\e\E\f\n\r\t\v'",
        "\u{0007}\u{0008}\u{001b}\u{001b}\u{000c}\n\r\t\u{000b}",
      ),
      (r#"echo $'\\\'\"\?'"#, "\\'\"?"),
      (r"echo $'\1\12\1012\x4\x41f'", "\u{0001}\nA2\u{0004}Af"),
      (r"echo $'\u03bb\U0001f600'", "λ😀"),
      (r"echo $'\d\q\λ\x\u\U'", r"\d\q\λ\x\u\U"),
      (r"echo $''", ""),
      (r#"echo $"a\tb\$c""#, r"a\tb$c"),
      (r"echo '$''a\tb'", r"$a\tb"),
    ] {
      assert_bash_word(source, value);
    }
  }

  #[test]
  fn ansi_c_byte_escapes_preserve_utf8_and_nul_terminates_only_the_quote() {
    assert_bash_word(r"echo $'\xC3\xA9'", "é");
    assert_bash_word(r"echo $'\303\251'", "é");
    assert_bash_word(r"echo $'a\0b'post", "apost");
    assert_bash_word(r"echo $'\400'post", "post");
    for source in [
      r"echo $'\xff'",
      r"echo $'\777'",
      r"echo $'\uD800'",
      r"echo $'\U00110000'",
    ] {
      assert_eq!(
        read_posix::<SymbolU32, _>(source, &mut intern()).unwrap_err(),
        PosixReadError::NonUtf8AnsiCQuote,
        "{source}"
      );
    }
  }

  #[test]
  fn single_quotes_and_unquoted_backslashes_keep_their_meaning() {
    for source in [r"echo 'a\nb'", r"echo 'a\.b'", r"echo 'a\u0041b'"] {
      let got = posix(source, &mut intern());
      assert_eq!(
        args_of(&got),
        vec![&source[6..source.len() - 1]],
        "{source}"
      );
    }
    let got = posix(r"echo a\ b a\.b \n", &mut intern());
    assert_eq!(args_of(&got), vec!["a b", "a.b", "n"]);
  }

  #[test]
  fn unquoted_backslash_newline_joins_without_an_empty_word() {
    for source in ["echo a\\\nb", "echo \\\nab", "echo ab\\\n", "echo ab \\\n"] {
      assert_bash_word(source, "ab");
      let mut i = intern();
      assert_eq!(shell_plan(source, &mut i), posix(source, &mut i));
    }
    let got = posix("echo a \\\n b", &mut intern());
    assert_eq!(args_of(&got), vec!["a", "b"]);
    let mut i = intern();
    assert_eq!(posix("echo \\\n", &mut i), posix("echo", &mut i));
    assert_eq!(shell_plan("echo \\\n", &mut i), posix("echo", &mut i));
    let expected = posix(r"echo a\ ", &mut i);
    assert_eq!(args_of(&expected), vec!["a "]);
    assert_eq!(shell_plan(r"echo a\ ", &mut i), expected);
  }

  #[test]
  fn continuations_can_join_bash_quote_prefixes_but_stay_literal_in_single_quotes() {
    for (source, value) in [
      ("echo $\\\n'a\\tb'", "a\tb"),
      ("echo $\\\n\"a\\tb\"", r"a\tb"),
      ("echo '$\\\n'", "$\\\n"),
      ("echo $'a\\\nb'", "a\\\nb"),
    ] {
      assert_bash_word(source, value);
      let mut i = intern();
      assert_eq!(shell_plan(source, &mut i), posix(source, &mut i));
    }
  }

  #[test]
  fn bash_escapes_work_in_joined_words_and_substitutions() {
    assert_bash_word(r#"echo pre"a\nb"post$'\t'"\$x""#, "prea\\nbpost\t$x");
    assert_expansion(
      r#"echo $(echo "a\nb")"#,
      r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "echo" "a\\nb"))))))"#,
    );
  }

  #[test]
  fn bash_quoting_reaches_statement_and_shell_plan_doors() {
    for source in [r#"echo "a\nb""#, r#"echo "a\.b""#, r"echo $'a\tb'"] {
      let mut i = intern();
      let expected = posix(source, &mut i);
      assert_eq!(read_statement(source, &mut i).unwrap(), expected);
      assert_eq!(shell_plan(source, &mut i), expected);
    }
  }

  #[test]
  fn ansi_c_escaped_quotes_do_not_expose_operators_or_substitution_delimiters() {
    for source in [r"echo $'a\'|;{a,b}$(bad)'", r"echo pre$'\'&&>post'post"] {
      let mut i = intern();
      let expected = posix(source, &mut i);
      assert_eq!(read_statement(source, &mut i).unwrap(), expected);
      assert_eq!(shell_plan(source, &mut i), expected);
    }
    assert_expansion(
      r"echo $(echo $'a\')b')",
      r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "echo" "a')b"))))))"#,
    );
    let mut i = intern();
    let plan = shell_plan(r"echo $'a\'|b' && echo ok", &mut i);
    let json = sexpr_to_json(&plan, &i);
    assert_eq!(json["list"][0]["sym"], "std.sh.and");
    assert_eq!(json["list"][1]["list"][2]["str"], "a'|b");
  }

  #[test]
  fn posix_and_lisp_converge_to_one_json() {
    let mut pi = intern();
    let p = posix("cat $(ls \"/tmp\")", &mut pi);
    let mut li = intern();
    let l = Runtime::<SymbolU32, StringBackend>::parse(
      None,
      r#"(std.sh.cmd "cat" (std.sh.split (list (list true (std.sh.sub (std.sh.cmd "ls" "/tmp"))))))"#,
      &mut li,
    )
    .unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(sexpr_to_json(&p, &pi), sexpr_to_json(&l[0], &li));
  }

  #[test]
  fn shell_plan_without_operators_is_the_existing_statement() {
    let mut i = intern();
    let plan = shell_plan("ls --all /tmp", &mut i);
    let statement = read_statement("ls --all /tmp", &mut i).unwrap();
    assert_eq!(
      plan, statement,
      "the new door does not fork simple commands"
    );
  }

  /// A `(` after `&` on one line opens a subshell, and a background list may
  /// end in a redirected group or subshell: bash reads all of these.
  #[test]
  fn background_lists_take_subshells_and_redirected_compounds() {
    for (source, expected) in [
      (
        "true & (exit 3) &",
        r#"(std.sh.seq (std.jobs.spawn (std.sh.cmd "true")) (std.jobs.spawn (std.sh.subshell (std.sh.cmd "exit" "3"))))"#,
      ),
      (
        "{ echo a; } > f &",
        r#"(std.jobs.spawn (std.sh.redirect (std.sh.group (std.sh.cmd "echo" "a")) (list (list 1 ">" "f"))))"#,
      ),
      (
        "( echo a ) > f &",
        r#"(std.jobs.spawn (std.sh.redirect (std.sh.subshell (std.sh.cmd "echo" "a")) (list (list 1 ">" "f"))))"#,
      ),
      (
        "echo a & (echo b)",
        r#"(std.sh.seq (std.jobs.spawn (std.sh.cmd "echo" "a")) (std.sh.subshell (std.sh.cmd "echo" "b")))"#,
      ),
    ] {
      let mut i = intern();
      let got = shell_plan(source, &mut i);
      let want = lisp(expected, &mut i);
      assert_eq!(sexpr_to_json(&got, &i), sexpr_to_json(&want, &i), "{source}");
    }
  }

  /// argv.md I17: `$!` is the typed `(std.jobs.last)` wherever it stands.
  #[test]
  fn last_background_pid_lowers_to_std_jobs_last() {
    for (source, expected) in [
      ("echo $!", r#"(std.sh.cmd "echo" (std.sh.split (list (list true (std.jobs.last)))))"#),
      ("pid=$!", r#"(let pid (std.jobs.last))"#),
      ("sleep 0 & wait $!", r#"(std.sh.seq (std.jobs.spawn (std.sh.cmd "sleep" "0")) (std.sh.cmd "wait" (std.sh.split (list (list true (std.jobs.last))))))"#),
    ] {
      let mut i = intern();
      let got = shell_plan(source, &mut i);
      let want = lisp(expected, &mut i);
      assert_eq!(sexpr_to_json(&got, &i), sexpr_to_json(&want, &i), "{source}");
    }
  }

  /// argv.md D5: a prompt line marks only what it displays.
  #[test]
  fn a_prompt_line_marks_only_the_displayed_command() {
    for (source, expected) in [
      ("ls", r#"(std.sh.display (std.sh.cmd "ls"))"#),
      ("ls /tmp", r#"(std.sh.display (std.sh.cmd "ls" "/tmp"))"#),
      (
        "cd /tmp; ls",
        r#"(std.sh.seq (std.sh.cmd "cd" "/tmp") (std.sh.display (std.sh.cmd "ls")))"#,
      ),
      (
        "make && ls",
        r#"(std.sh.and (std.sh.cmd "make") (std.sh.display (std.sh.cmd "ls")))"#,
      ),
      (
        "make || ls",
        r#"(std.sh.or (std.sh.cmd "make") (std.sh.display (std.sh.cmd "ls")))"#,
      ),
      (
        "a; b && c",
        r#"(std.sh.seq (std.sh.cmd "a") (std.sh.and (std.sh.cmd "b") (std.sh.display (std.sh.cmd "c"))))"#,
      ),
      // Never a pipeline stage, a capture, a redirected or background command.
      (r#"ls | sort"#, r#"(std.sh.pipe (std.sh.cmd "ls") (std.sh.cmd "sort"))"#),
      (
        "x=$(ls)",
        r#"(let x (std.sh.sub (std.sh.cmd "ls")))"#,
      ),
      (
        "ls > out",
        r#"(std.sh.redirect (std.sh.cmd "ls") (list (list 1 ">" "out")))"#,
      ),
      ("ls &", r#"(std.jobs.spawn (std.sh.cmd "ls"))"#),
      (
        "! ls",
        r#"(std.sh.not (std.sh.cmd "ls"))"#,
      ),
    ] {
      let mut i = intern();
      let got = read_prompt_plan_with_functions::<SymbolU32, _>(source, &mut i, None, &[]).unwrap();
      let want = lisp(expected, &mut i);
      assert_eq!(sexpr_to_json(&got, &i), sexpr_to_json(&want, &i), "{source}");
      // The marker is not source: a script reads the same line unmarked.
      let plain = shell_plan(source, &mut i);
      assert_eq!(crate::render_posix(&got, &i), crate::render_posix(&plain, &i), "{source}");
    }
  }

  #[test]
  fn flow_precedence_lowers_to_one_canonical_lisp_form() {
    // Pipeline binds tightest; && and || share a left-associative level; `;`
    // sequences the whole expression on its left.
    let mut pi = intern();
    let plan = shell_plan("a | b --x 1 && c || d ; e", &mut pi);
    let mut li = intern();
    let lisp = Runtime::<SymbolU32, StringBackend>::parse(
      None,
      r#"(std.sh.seq
            (std.sh.or
              (std.sh.and
                (std.sh.pipe (std.sh.cmd "a") (std.sh.cmd "b" "--x" "1"))
                (std.sh.cmd "c"))
              (std.sh.cmd "d"))
            (std.sh.cmd "e"))"#,
      &mut li,
    )
    .unwrap();
    assert_eq!(lisp.len(), 1);
    assert_eq!(
      sexpr_to_json(&plan, &pi),
      sexpr_to_json(&lisp[0], &li),
      "shell and Lisp surfaces must produce the same plan"
    );
  }

  #[test]
  fn quoted_escaped_and_substitution_operators_do_not_split_outer_flow() {
    let mut i = intern();
    let plan = shell_plan(r#"echo 'a|b' "c&&d" e\;f $(pick "x||y") | sink"#, &mut i);
    let json = sexpr_to_json(&plan, &i);
    let text = json.to_string();
    assert_eq!(json["list"][0]["sym"], "std.sh.pipe");
    assert_eq!(
      json["list"].as_array().unwrap().len(),
      3,
      "two pipeline stages"
    );
    for literal in ["a|b", "c&&d", "e;f", "x||y"] {
      assert!(
        text.contains(literal),
        "quoted operator `{literal}` remains data: {text}"
      );
    }
  }

  #[test]
  fn flow_operators_require_both_operands() {
    for (line, operator) in [("| a", "|"), ("a &&", "&&"), ("a || ; b", ";")] {
      let mut i = intern();
      let err = read_shell_plan::<SymbolU32, _>(line, &mut i).unwrap_err();
      assert_eq!(
        err,
        PosixReadError::MissingFlowOperand(operator),
        "for `{line}`"
      );
    }
  }

  #[test]
  fn declared_home_expands_independently_in_each_flow_stage() {
    let mut i = intern();
    let plan =
      read_shell_plan_with_home::<SymbolU32, _>("ls ~/left | cp ~/right", &mut i, Some(""))
        .unwrap();
    assert_eq!(
      crate::render_lisp(&plan, &i),
      r#"(std.sh.pipe (std.sh.cmd "ls" (str.concat (std.sh.tilde "") "/left")) (std.sh.cmd "cp" (str.concat (std.sh.tilde "") "/right")))"#
    );
  }

  #[test]
  fn empty_line_errors() {
    let mut i = intern();
    assert_eq!(
      read_posix::<SymbolU32, _>("   ", &mut i),
      Err(PosixReadError::Empty)
    );
  }

  #[test]
  fn assignment_captures_a_command() {
    assert_expansion(
      r#"files=$(ls "/tmp")"#,
      r#"(let files (std.sh.sub (std.sh.cmd "ls" "/tmp")))"#,
    );
  }

  #[test]
  fn assignment_of_a_bare_word_is_a_string() {
    let mut i = intern();
    let got = read_statement::<SymbolU32, _>("name=hello", &mut i).unwrap();
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("let"))),
      SExpression::Literal(Literal::Symbol(i.get_or_intern("name"))),
      SExpression::Literal(Literal::String("hello".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn equals_inside_an_arg_is_not_an_assignment() {
    let mut i = intern();
    let got = read_statement::<SymbolU32, _>("ls a=b", &mut i).unwrap();
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
      SExpression::Literal(Literal::String("ls".into())),
      SExpression::Literal(Literal::String("a=b".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn reflection_words_stay_literal() {
    let mut i = intern();
    // Reflection options are interpreted after command resolution.
    let got = read_posix_argv::<SymbolU32, _>(
      &[
        "ls".into(),
        "--all".into(),
        "--version".into(),
        "--json".into(),
        "-h".into(),
      ],
      &mut i,
    )
    .unwrap();
    let want = SExpression::List(vec![
      SExpression::Literal(Literal::Symbol(i.get_or_intern("ls"))),
      SExpression::Literal(Literal::String("--all".into())),
      SExpression::Literal(Literal::String("--version".into())),
      SExpression::Literal(Literal::String("--json".into())),
      SExpression::Literal(Literal::String("-h".into())),
    ]);
    assert_eq!(got, want);
  }

  #[test]
  fn help_flags_are_ordinary_lossless_arguments() {
    for head in ["du", "echo", "std.io.echo"] {
      let mut i = intern();
      let flags = ["-h", "--help"].map(|flag| SExpression::Literal(Literal::String(flag.into())));
      let mut argv_want = vec![SExpression::Literal(Literal::Symbol(i.get_or_intern(head)))];
      argv_want.extend(flags.clone());
      let mut line_want = vec![
        SExpression::Literal(Literal::Symbol(i.get_or_intern("std.sh.cmd"))),
        SExpression::Literal(Literal::String(head.into())),
      ];
      line_want.extend(flags);
      let argv = vec![head.into(), "-h".into(), "--help".into()];
      assert_eq!(
        read_posix_argv::<SymbolU32, _>(&argv, &mut i).unwrap(),
        SExpression::List(argv_want)
      );
      assert_eq!(
        read_posix::<SymbolU32, _>(&format!("{head} -h --help"), &mut i).unwrap(),
        SExpression::List(line_want)
      );
    }
  }

  #[test]
  fn fixture_battery_aligns_posix_lisp_sexpr() {
    let path = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/reader_parity.json"
    );
    let raw = std::fs::read_to_string(path).expect("read fixtures");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("parse fixtures");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 10, "expected a real battery");
    for case in cases {
      let desc = case["desc"].as_str().unwrap_or("?");
      let expected = &case["sexpr"];
      if let Some(src) = case.get("posix").and_then(|v| v.as_str()) {
        let mut i = intern();
        let got = read_statement::<SymbolU32, _>(src, &mut i)
          .unwrap_or_else(|e| panic!("posix `{src}` ({desc}): {e}"));
        assert_eq!(&sexpr_to_json(&got, &i), expected, "posix `{src}` ({desc})");
      }
      if let Some(src) = case.get("shell").and_then(|v| v.as_str()) {
        let mut i = intern();
        let got = read_shell_plan::<SymbolU32, _>(src, &mut i)
          .unwrap_or_else(|e| panic!("shell `{src}` ({desc}): {e}"));
        assert_eq!(&sexpr_to_json(&got, &i), expected, "shell `{src}` ({desc})");
      }
      if let Some(src) = case.get("lisp").and_then(|v| v.as_str()) {
        let mut i = intern();
        let parsed = Runtime::<SymbolU32, StringBackend>::parse(None, src, &mut i)
          .unwrap_or_else(|e| panic!("lisp `{src}` ({desc}): {e:?}"));
        assert_eq!(parsed.len(), 1, "lisp `{src}` ({desc}) should be one form");
        assert_eq!(
          &sexpr_to_json(&parsed[0], &i),
          expected,
          "lisp `{src}` ({desc})"
        );
      }
    }
  }
}
