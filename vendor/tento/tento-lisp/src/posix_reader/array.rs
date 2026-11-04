use super::*;

pub(super) fn read<S: Symbol, B: Backend<S>>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError> {
  let source = source.trim();
  let Some((lhs, rhs)) = source.split_once('=') else {
    return Ok(None);
  };
  let append = lhs.ends_with('+');
  let lhs = lhs.strip_suffix('+').unwrap_or(lhs);
  let (name, index) = if let Some((name, rest)) = lhs.split_once('[') {
    let Some(index) = rest.strip_suffix(']') else {
      return Ok(None);
    };
    (name, Some(index))
  } else {
    (lhs, None)
  };
  if !compound::identifier(name) || index.is_none() && !rhs.starts_with('(') {
    return Ok(None);
  }
  let text = |value: &str| SExpression::Literal(Literal::String(value.into()));
  let (index, values) = if rhs.starts_with('(') {
    if index.is_some() {
      return Err(PosixReadError::ShellOperatorUnsupported(
        "indexed array initializer".into(),
      ));
    }
    let chars: Vec<_> = rhs.chars().collect();
    let end = scan_balanced(&chars, 1)?;
    if end + 1 != chars.len() {
      return Err(PosixReadError::ShellOperatorUnsupported(
        "array assignment prefix".into(),
      ));
    }
    let body: String = chars[1..end].iter().collect();
    let chars: Vec<_> = body.chars().collect();
    let mut raw_words = Vec::new();
    let mut i = 0;
    while i < chars.len() {
      if chars[i].is_whitespace() {
        i += 1;
        continue;
      }
      let end = redirection::word_end(&chars, i)?;
      // An operator (`|`, `&`, `;`, `<`, `>`) cannot start an element: bash
      // reports a syntax error; never loop without consuming input.
      if end == i {
        return Err(PosixReadError::UnexpectedToken(chars[i].to_string()));
      }
      raw_words.push(chars[i..end].iter().collect::<String>());
      i = end;
    }
    if raw_words
      .iter()
      .any(|word| word.starts_with('[') && word.contains("]="))
    {
      let mut stages = vec![call(
        "std.sh.array-assign",
        vec![
          text(name),
          text(""),
          SExpression::Literal(Literal::Boolean(append)),
          call("list", vec![], interner),
        ],
        interner,
      )];
      let mut next = if append { None } else { Some("0".to_string()) };
      for word in raw_words {
        let (key, rhs) = if let Some((key, rhs)) = word
          .strip_prefix('[')
          .and_then(|word| word.split_once("]="))
        {
          (Some(key.to_string()), rhs.to_string())
        } else {
          (next.clone(), word)
        };
        next = key.as_ref().map(|key| format!("({key})+1"));
        let index = if let Some(key) = key {
          subscript(name, &key, interner, home)?
        } else {
          call("std.sh.array-next", vec![text(name)], interner)
        };
        let parts = redirection::word_parts(&rhs, interner, home)?;
        let values = parts
          .into_iter()
          .map(|(value, _, _)| call("std.sh.scalar", vec![value], interner))
          .collect();
        let value = call("str.concat", values, interner);
        let values = call("list", vec![value], interner);
        stages.push(call(
          "std.sh.array-assign",
          vec![
            text(name),
            index,
            SExpression::Literal(Literal::Boolean(false)),
            values,
          ],
          interner,
        ));
      }
      return Ok(Some(call("std.sh.seq", stages, interner)));
    }
    let mut atoms = vec![Atom::Word("list".into())];
    let data = compound::data_arguments(&format!("list {body}"))?;
    atoms.extend(scan(
      data.strip_prefix("list ").unwrap_or(""),
      interner,
      home,
    )?);
    (text(""), atoms_to_symbol_call(atoms, interner)?)
  } else {
    let chars: Vec<_> = rhs.chars().collect();
    if redirection::word_end(&chars, 0)? != chars.len() {
      return Err(PosixReadError::ShellOperatorUnsupported(
        "array assignment prefix".into(),
      ));
    }
    let rhs = if rhs.starts_with("--") {
      format!("''{rhs}")
    } else {
      rhs.into()
    };
    let mut atoms = scan(&rhs, interner, home)?;
    let value = if atoms.is_empty() {
      text("")
    } else if atoms.len() == 1 {
      atom_to_value(atoms.remove(0), interner)
    } else {
      return Err(PosixReadError::ShellOperatorUnsupported(
        "array assignment".into(),
      ));
    };
    (
      subscript(name, index.unwrap(), interner, home)?,
      call("list", vec![value], interner),
    )
  };
  Ok(Some(call(
    "std.sh.array-assign",
    vec![
      text(name),
      index,
      SExpression::Literal(Literal::Boolean(append)),
      values,
    ],
    interner,
  )))
}

/// [`read`] for an array assignment statement, wrapped in
/// `(std.sh.array-traced TRACE FORM)` for `set -x`: bash shows `name=(words)` as
/// written (one blank between words), and `name[SUB]=` with the expanded
/// value appended at run time.
pub(super) fn read_traced<S: Symbol, B: Backend<S>>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError> {
  let Some(form) = read(source, interner, home)? else { return Ok(None) };
  let source = source.trim();
  let Some((lhs, rhs)) = source.split_once('=') else { return Ok(Some(form)) };
  let trace = if rhs.starts_with('(') {
    let chars: Vec<_> = rhs.chars().collect();
    let end = scan_balanced(&chars, 1)?;
    let body: Vec<_> = chars[1..end].to_vec();
    let mut words = Vec::new();
    let mut i = 0;
    while i < body.len() {
      if body[i].is_whitespace() {
        i += 1;
        continue;
      }
      let end = redirection::word_end(&body, i)?;
      if end == i {
        return Err(PosixReadError::UnexpectedToken(body[i].to_string()));
      }
      words.push(body[i..end].iter().collect::<String>());
      i = end;
    }
    format!("{lhs}=({})", words.join(" "))
  } else {
    format!("{lhs}=")
  };
  Ok(Some(call("std.sh.array-traced", vec![SExpression::Literal(Literal::String(trace)), form], interner)))
}

pub(super) fn subscript<S: Symbol, B: Backend<S>>(
  name: &str,
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError> {
  for variable in arith::variable_names(raw) {
    interner.get_or_intern(variable);
  }
  let parts = redirection::word_parts(raw, interner, home)?;
  let values = parts
    .into_iter()
    .map(|(value, _, _)| call("std.sh.scalar", vec![value], interner))
    .collect();
  let raw = call("str.concat", values, interner);
  Ok(call(
    "std.sh.array-index",
    vec![SExpression::Literal(Literal::String(name.into())), raw],
    interner,
  ))
}
