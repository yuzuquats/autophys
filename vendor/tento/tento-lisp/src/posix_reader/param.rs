//! Parameter operators lower onto lazy Lisp conditionals and word descriptors.
use super::*;

fn text<S: Symbol>(value: &str) -> SExpression<S> {
  SExpression::Literal(Literal::String(value.into()))
}

pub(super) fn fields<S: Symbol, B: Backend<S>>(value: &SExpression<S>, interner: &StringInterner<B>) -> bool {
  if let SExpression::List(items) = value {
    if is_call(value, "if", interner) {
      // `"${@:-w}"`, and `"${@:+w}"` not taken, are `"$@"`: fields too.
      return items.iter().skip(2).any(|value| fields(value, interner)
        || is_call(value, "std.sh.positional", interner)
          && matches!(value, SExpression::List(items) if matches!(items.get(1), Some(SExpression::Literal(Literal::String(name))) if name == "@")));
    }
    if ["std.sh.array-get", "std.sh.array-keys", "std.sh.array-word", "std.sh.param-each"].iter().any(|name| is_call(value, name, interner)) {
      return matches!(items.get(2), Some(SExpression::Literal(Literal::String(selector))) if selector == "@" || selector == "*fields");
    }
    if is_call(value, "std.sh.names", interner) {
      return matches!(items.get(2), Some(SExpression::Literal(Literal::String(selector))) if selector == "@" || selector == "*fields");
    }
  }
  false
}

fn parts<S: Symbol, B: Backend<S>>(
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
  quoted: bool,
  pattern: bool,
) -> Result<SExpression<S>, PosixReadError> {
  // An outer double quote makes single quotes in the default word literal.
  // Inner double quotes retain their normal quote-removal role.
  let source = if quoted && !pattern {
    let mut word = String::new();
    let chars: Vec<_> = raw.chars().collect();
    let mut inner_quote = false;
    let mut i = 0;
    while i < chars.len() {
      let c = chars[i];
      if c == '$' && chars.get(i + 1) == Some(&'{') {
        let end = parameter_span_end_in(&chars, i + 2, true);
        word.extend(&chars[i..end]);
        i = end;
        continue;
      }
      if c == '`' || c == '$' && chars.get(i + 1) == Some(&'(') {
        if let Some(end) = redirection::protected_end(&chars, i)? {
          word.extend(&chars[i..end]);
          i = end;
          continue;
        }
      }
      if c == '\\' {
        if let Some(&next) = chars.get(i + 1) {
          // \} quotes the expansion delimiter, including in inner quotes.
          // The wrapper reverses inner quotes, so retain their non-special
          // backslashes explicitly before word_parts removes quotes.
          if inner_quote && !matches!(next, '}' | '$' | '`' | '"' | '\\' | '\n') {
            word.push(c);
          }
          if next != '}' { word.push(c); }
          word.push(next);
          i += 2;
          continue;
        }
      }
      if c == '"' { inner_quote = !inner_quote; }
      word.push(c);
      i += 1;
    }
    format!("\"{word}\"")
  } else {
    raw.to_string()
  };
  let mut parts = redirection::word_parts(&source, interner, home)?;
  if raw.is_empty() {
    parts.push((text(""), !quoted, false));
  }
  let descriptors = parts
    .into_iter()
    .map(|(value, split, glob)| {
      let split = if pattern {
        false
      } else if quoted {
        false
      } else {
        split || glob
      };
      word_descriptor(value, split, glob && !quoted || pattern && glob, interner)
    })
    .collect();
  Ok(call("list", descriptors, interner))
}

fn separator(raw: &str, target: char) -> Option<usize> {
  let chars: Vec<_> = raw.chars().collect();
  let mut i = 0;
  let mut byte = 0;
  while i < chars.len() {
    if let Ok(Some(end)) = redirection::protected_end(&chars, i) {
      byte += chars[i..end].iter().map(|c| c.len_utf8()).sum::<usize>();
      i = end;
      continue;
    }
    if chars[i] == target {
      return Some(byte);
    }
    byte += chars[i].len_utf8();
    i += 1;
  }
  None
}

pub(super) fn lower<S: Symbol, B: Backend<S>>(
  body: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
  quoted: bool,
) -> Result<SExpression<S>, PosixReadError> {
  let fail = || PosixReadError::ShellExpansionUnsupported(format!("${{{body}}}"));
  // No valid parameter name (`${:-d}`, `${1x}`): bash's runtime `bad
  // substitution`, not a refusal of a form tsh has not built.
  let display = format!("${{{body}}}");
  let (length, body) = if body.starts_with('#') && body.len() > 1 {
    (true, &body[1..])
  } else {
    (false, body)
  };
  // `${#@}` and `${#*}` count the positionals, as `$#` does.
  if length && matches!(body, "@" | "*") {
    return Ok(parameter("#", interner));
  }
  if let Some(indirect) = body.strip_prefix('!') {
    for suffix in ["[@]", "[*]", "@", "*"] {
      if let Some(name) = indirect.strip_suffix(suffix).filter(|name| compound::identifier(name) || name.is_empty() && suffix.len() == 1) {
        if length { return Err(fail()); }
        let array = suffix.len() > 1;
        interner.get_or_intern(name);
        let selector = if suffix.contains('@') { "@" } else if quoted { "*" } else { "*fields" };
        return Ok(call(if array { "std.sh.array-keys" } else { "std.sh.names" }, vec![text(name), text(selector)], interner));
      }
    }
  }
  if let Some(name) = body
    .strip_prefix('!')
    .filter(|name| compound::identifier(name))
  {
    interner.get_or_intern(name);
    return Ok(call("std.sh.indirect", vec![text(name)], interner));
  }
  // `${~PREFIX}`: the reader's own spelling of a tilde prefix (see
  // `tilde_source`), resolved at run time.
  if let Some(prefix) = body.strip_prefix('~').filter(|prefix| !length && super::tilde_prefix(prefix, Some(""))) {
    return Ok(call("std.sh.tilde", vec![text(prefix)], interner));
  }
  let bad = |interner: &mut StringInterner<B>| call("std.sh.bad-substitution", vec![text(&display)], interner);
  let Some(first) = body.chars().next() else {
    return Ok(bad(interner));
  };
  if first.is_ascii_digit()
    && body.trim_start_matches(|c: char| c.is_ascii_digit()).starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
  {
    return Ok(bad(interner));
  }
  let name_len = if first.is_ascii_alphabetic() || first == '_' {
    body
      .bytes()
      .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_')
      .count()
  } else if first.is_ascii_digit() {
    body.bytes().take_while(u8::is_ascii_digit).count()
  } else if matches!(first, '?' | '#' | '@' | '*' | '$' | '!' | '-') {
    1
  } else {
    return Ok(bad(interner));
  };
  let name = &body[..name_len];
  if compound::identifier(name) {
    interner.get_or_intern(name);
  }
  let rest = &body[name_len..];
  // `"${@%x}"`, `"${@:2}"` and `"${@@Q}"` act on each positional.
  if matches!(name, "@" | "*") && !length && !rest.is_empty()
    && !rest.strip_prefix(':').unwrap_or(rest).starts_with(['+', '-', '=', '?']) {
    let selector = if name == "@" { "@" } else if quoted { "*" } else { "*fields" };
    return each("@", selector, rest, &format!("${{{body}}}"), interner, home)?.ok_or_else(fail);
  }
  if let Some((selector, rest)) = rest.strip_prefix("[@]").map(|rest| ("@", rest))
    .or_else(|| rest.strip_prefix("[*]").map(|rest| (if quoted { "*" } else { "*fields" }, rest)))
    .filter(|(_, rest)| !rest.is_empty()) {
    let colon = rest.starts_with(':');
    let operator = if colon { &rest[1..] } else { rest };
    // `"${a[@]%x}"`, `"${a[@]:1}"` and `"${a[@]@Q}"` act on each element.
    if !operator.starts_with(['+', '-', '=', '?']) && !length {
      return each(name, selector, rest, &format!("${{{body}}}"), interner, home)?.ok_or_else(fail);
    }
    if !operator.starts_with(['+', '-', '=', '?']) || length { return Err(fail()); }
    let op = &operator[..1];
    let test = call("std.sh.array-test", vec![text(name), text(selector),
      SExpression::Literal(Literal::Boolean(colon)), SExpression::Literal(Literal::Boolean(op == "+"))], interner);
    let word = parts(&operator[1..], interner, home, quoted, false)?;
    let selected = call("std.sh.array-word", vec![text(name), text(selector), text(op), word], interner);
    // An alternative that is not taken leaves the expansion itself, as bash
    // does: quoted `"${a[@]:+w}"` over `a=("")` is one empty word, over
    // `a=()` none.
    let other = if op == "+" {
      if selector == "*" { text("") }
      else if selector == "@" { call("std.sh.array-get", vec![text(name), text(selector), SExpression::Literal(Literal::Boolean(false))], interner) }
      else { call("list", vec![], interner) }
    } else {
      call("std.sh.array-get", vec![text(name), text(selector), SExpression::Literal(Literal::Boolean(false))], interner)
    };
    return Ok(call("if", vec![test, selected, other], interner));
  }
  if rest.starts_with('[') && rest.ends_with(']') {
    let index = &rest[1..rest.len() - 1];
    let index = if matches!(index, "@" | "*") { text(if index == "*" && !quoted { "*fields" } else { index }) }
      else { array::subscript(name, index, interner, home)? };
    return Ok(call("std.sh.array-get", vec![text(name), index,
      SExpression::Literal(Literal::Boolean(length))], interner));
  }

  if length {
    if !rest.is_empty() {
      return Err(fail());
    }
    return Ok(call(
      "std.sh.param-transform",
      vec![
        text(name),
        text("length"),
        parts("", interner, home, false, true)?,
        text(""),
      ],
      interner,
    ));
  }
  if rest.is_empty() {
    return Ok(parameter(name, interner));
  }
  let colon = rest.starts_with(':');
  let operator = if colon { &rest[1..] } else { rest };
  if operator.starts_with(['-', '=', '?', '+']) {
    let op = &operator[..1];
    let word = &operator[1..];
    let plus = op == "+";
    let test = call(
      "std.sh.param-test",
      vec![
        text(name),
        SExpression::Literal(Literal::Boolean(colon)),
        SExpression::Literal(Literal::Boolean(plus)),
      ],
      interner,
    );
    let word = parts(word, interner, home, quoted, false)?;
    // `${x:?}` and `${x?}` differ in bash's default message.
    let selected_op = if colon && op == "?" { ":?" } else { op };
    let selected = call("std.sh.param-word", vec![text(name), text(selected_op), word], interner);
    // `"${@:+w}"` not taken is `"$@"`: no word when there are no
    // positionals, as in bash.
    let other = if plus && name != "@" {
      text("")
    } else {
      parameter(name, interner)
    };
    return Ok(call("if", vec![test, selected, other], interner));
  }
  if colon {
    let (offset, length) = slice(&rest[1..], interner, home)?;
    return Ok(call(
      "std.sh.param-slice",
      vec![text(name), offset, length],
      interner,
    ));
  }
  // `${x@Q}` and the other transforms; an unknown operator is a runtime
  // `bad substitution`, as in bash.
  if let Some(op) = rest.strip_prefix('@') {
    return Ok(call(
      "std.sh.param-transform",
      vec![text(name), text(&format!("@{op}")), parts("", interner, home, false, true)?, text(&format!("${{{body}}}"))],
      interner,
    ));
  }
  if rest.starts_with(['#', '%']) {
    let op_len = if rest.as_bytes().get(1) == rest.as_bytes().first() {
      2
    } else {
      1
    };
    let pattern = parts(&rest[op_len..], interner, home, false, true)?;
    return Ok(call(
      "std.sh.param-transform",
      vec![text(name), text(&rest[..op_len]), pattern, text("")],
      interner,
    ));
  }
  if let Some(rest) = rest.strip_prefix('/') {
    let (op, rest) = if let Some(raw) = rest.strip_prefix('/') {
      ("//", raw)
    } else if let Some(raw) = rest.strip_prefix('#') {
      ("/#", raw)
    } else if let Some(raw) = rest.strip_prefix('%') {
      ("/%", raw)
    } else {
      ("/", rest)
    };
    let split = separator(rest, '/');
    let pattern = parts(
      &rest[..split.unwrap_or(rest.len())],
      interner,
      home,
      false,
      true,
    )?;
    let replacement = parts(
      split.map(|i| &rest[i + 1..]).unwrap_or(""),
      interner,
      home,
      false,
      false,
    )?;
    return Ok(call(
      "std.sh.param-transform",
      vec![text(name), text(op), pattern, replacement],
      interner,
    ));
  }
  if rest.starts_with(['^', ',']) {
    let op_len = if rest.as_bytes().get(1) == rest.as_bytes().first() {
      2
    } else {
      1
    };
    let pattern = parts(&rest[op_len..], interner, home, false, true)?;
    return Ok(call(
      "std.sh.param-transform",
      vec![text(name), text(&rest[..op_len]), pattern, text("")],
      interner,
    ));
  }
  Err(fail())
}

/// A slice's offset and optional length. Ternary colons belong to the
/// arithmetic expression; the separator is a top-level colon outside a
/// ternary, quote or nested expansion.
fn slice<S: Symbol, B: Backend<S>>(
  offset: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<(SExpression<S>, SExpression<S>), PosixReadError> {
  let chars: Vec<_> = offset.chars().collect();
  let mut i = 0;
  let mut depth = 0;
  let mut ternary = 0;
  let mut split = None;
  while i < chars.len() {
    if let Some(end) = redirection::protected_end(&chars, i)? {
      i = end;
      continue;
    }
    match chars[i] {
      '(' => depth += 1,
      ')' => depth -= 1,
      '?' if depth == 0 => ternary += 1,
      ':' if depth == 0 && ternary > 0 => ternary -= 1,
      ':' if depth == 0 => {
        split = Some(i);
        break;
      }
      _ => {}
    }
    i += 1;
  }
  let first: String = chars[..split.unwrap_or(chars.len())].iter().collect();
  let second: String = split
    .map(|i| chars[i + 1..].iter().collect())
    .unwrap_or_default();
  let offset = arith::lower(&first, interner, home)?;
  let length = if split.is_some() {
    arith::lower(&second, interner, home)?
  } else {
    SExpression::Literal(Literal::Symbol(interner.get_or_intern("nil")))
  };
  Ok((offset, length))
}

/// `${a[@]OP}` and `${@OP}`: one operator over every element (`name` "@" is
/// the positionals). The runtime joins or splits the results by `selector`,
/// as `${a[@]}` does. `display` is the source, for a `bad substitution`.
fn each<S: Symbol, B: Backend<S>>(
  name: &str,
  selector: &str,
  rest: &str,
  display: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError> {
  let (op, pattern, replacement) = if let Some(offset) = rest.strip_prefix(':') {
    let (offset, length) = slice(offset, interner, home)?;
    (":".to_string(), offset, length)
  } else if let Some(op) = rest.strip_prefix('@') {
    (format!("@{op}"), parts("", interner, home, false, true)?, text(display))
  } else if rest.starts_with(['#', '%', '^', ',']) {
    let op_len = if rest.as_bytes().get(1) == rest.as_bytes().first() { 2 } else { 1 };
    (rest[..op_len].to_string(), parts(&rest[op_len..], interner, home, false, true)?, text(""))
  } else if let Some(rest) = rest.strip_prefix('/') {
    let (op, rest) = if let Some(raw) = rest.strip_prefix('/') { ("//", raw) }
      else if let Some(raw) = rest.strip_prefix('#') { ("/#", raw) }
      else if let Some(raw) = rest.strip_prefix('%') { ("/%", raw) }
      else { ("/", rest) };
    let split = separator(rest, '/');
    let pattern = parts(&rest[..split.unwrap_or(rest.len())], interner, home, false, true)?;
    let replacement = parts(split.map(|i| &rest[i + 1..]).unwrap_or(""), interner, home, false, false)?;
    (op.to_string(), pattern, replacement)
  } else {
    return Ok(None);
  };
  Ok(Some(call("std.sh.param-each", vec![text(name), text(selector), text(&op), pattern, replacement], interner)))
}

pub(super) fn parameter<S: Symbol, B: Backend<S>>(
  name: &str,
  interner: &mut StringInterner<B>,
) -> SExpression<S> {
  if name == "?" {
    return call("std.sh.status", vec![], interner);
  }
  if matches!(name, "@" | "*" | "#" | "$" | "!" | "-") || name.bytes().all(|c| c.is_ascii_digit()) {
    call("std.sh.positional", vec![text(name)], interner)
  } else {
    call("std.sh.var", vec![text(name)], interner)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use string_interner::{backend::StringBackend, symbol::SymbolU32};

  #[test]
  fn parameter_operator_reader_table() {
    for source in [
      "${x-w}",
      "${x:-w}",
      "${x=w}",
      "${x:=w}",
      "${x?w}",
      "${x:?w}",
      "${x+w}",
      "${x:+w}",
      "${#x}",
      "${x#p}",
      "${x##p}",
      "${x%p}",
      "${x%%p}",
      "${x/p/r}",
      "${x//p/r}",
      "${x/#p/r}",
      "${x/%p/r}",
      "${x:off}",
      "${x:off:len}",
      "${x^}",
      "${x^^}",
      "${x,}",
      "${x,,}",
      r#"${x:-"a b" c}"#,
      "${x:-${y:=fallback}}",
      "$((x+=2))",
      "${x@Q}",
      "${x@Z}",
      "${a[@]%.c}",
      "${a[*]//b/c}",
      "${a[@]:1:2}",
      "${a[@]@K}",
      "${@#a}",
      "${*^^}",
      "${@:2}",
      "${#@}",
      "$[1+2]",
      "${:-d}",
      "${1x:+a}",
    ] {
      let mut interner = StringInterner::<StringBackend>::new();
      assert!(
        read_statement::<SymbolU32, _>(&format!("echo {source}"), &mut interner).is_ok(),
        "{source}"
      );
    }
  }

  /// The form as compact s-expression text: `(std.sh.param-each "a" "@" …)`.
  fn lowered(source: &str) -> String {
    fn text(value: &serde_json::Value) -> String {
      match value {
        serde_json::Value::Object(map) => match map.iter().next() {
          Some((kind, serde_json::Value::Array(items))) if kind == "list" => {
            format!("({})", items.iter().map(text).collect::<Vec<_>>().join(" "))
          }
          Some((kind, value)) if kind == "str" => value.to_string(),
          Some((_, value)) => value.as_str().map_or_else(|| value.to_string(), str::to_string),
          None => String::new(),
        },
        value => value.to_string(),
      }
    }
    let mut interner = StringInterner::<StringBackend>::new();
    let form = read_statement::<SymbolU32, _>(&format!("echo {source}"), &mut interner).unwrap();
    text(&sexpr_to_json(&form, &interner))
  }

  #[test]
  fn each_element_operators_and_transforms_lower_to_their_natives() {
    // One operator over every element keeps the `${a[@]}` selector.
    assert!(lowered(r#""${a[@]%.c}""#).contains(r#"(std.sh.param-each "a" "@" "%""#));
    assert!(lowered(r#""${@:2}""#).contains(r#"(std.sh.param-each "@" "@" ":""#));
    assert!(lowered(r#""${*@Q}""#).contains(r#"(std.sh.param-each "@" "*" "@Q""#));
    assert!(lowered("${x@U}").contains(r#"(std.sh.param-transform "x" "@U""#));
    // `${#@}` is `$#`; `${x?}` and `${x:?}` keep their colon.
    assert!(lowered("${#@}").contains(r##"(std.sh.positional "#")"##));
    assert!(lowered("${x?}").contains(r#"(std.sh.param-word "x" "?""#));
    assert!(lowered("${x:?}").contains(r#"(std.sh.param-word "x" ":?""#));
    // No valid name: a runtime bad substitution.
    assert!(lowered("${:-d}").contains(r#"(std.sh.bad-substitution "${:-d}")"#));
    assert!(lowered("${1x:+a}").contains(r#"(std.sh.bad-substitution "${1x:+a}")"#));
  }
}
