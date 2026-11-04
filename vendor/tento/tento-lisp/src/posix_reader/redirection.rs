//! Redirection syntax stays in the Bash reader; the host receives ordered data.
use super::*;

pub(super) fn protected_end(chars: &[char], start: usize) -> Result<Option<usize>, PosixReadError> {
  if let Some(end) = super::extglob::end(chars, start) {
    return Ok(Some(end));
  }
  match chars[start] {
    '(' if chars.get(start + 1) == Some(&'(') => Ok(Some(scan_balanced(chars, start + 1)? + 1)),
    '\\' => Ok(Some((start + 2).min(chars.len()))),
    '<' | '>' if chars.get(start + 1) == Some(&'(') => {
      Ok(Some(scan_balanced(chars, start + 2)? + 1))
    }
    '$' if chars.get(start + 1) == Some(&'(') => Ok(Some(scan_balanced(chars, start + 2)? + 1)),
    '$' if chars.get(start + 1) == Some(&'{') => Ok(Some(parameter_span_end(chars, start + 2))),
    '$' if chars.get(start + 1) == Some(&'\'') => Ok(Some(ansi_c_quote_end(chars, start + 2)? + 1)),
    '`' => Ok(Some(backtick_source(chars, start + 1)?.1 + 1)),
    '\'' | '"' => {
      let quote = chars[start];
      let mut i = start + 1;
      while i < chars.len() {
        if chars[i] == quote {
          return Ok(Some(i + 1));
        }
        if quote == '"' {
          if chars[i] == '$' && chars.get(i + 1) == Some(&'{') {
            i = parameter_span_end_in(chars, i + 2, true);
            continue;
          }
          if matches!(chars[i], '\\' | '`')
            || chars[i] == '$' && chars.get(i + 1).is_some_and(|c| matches!(c, '(' | '{'))
          {
            if let Some(end) = protected_end(chars, i)? {
              i = end;
              continue;
            }
          }
        }
        i += 1;
      }
      Err(PosixReadError::UnterminatedQuote)
    }
    _ => Ok(None),
  }
}

pub(super) fn word_end(chars: &[char], mut i: usize) -> Result<usize, PosixReadError> {
  while i < chars.len() {
    if let Some(end) = protected_end(chars, i)? {
      i = end;
    } else if chars[i].is_whitespace() || matches!(chars[i], '<' | '>' | '&' | '|' | ';') {
      break;
    } else {
      i += 1;
    }
  }
  Ok(i)
}

pub(super) fn substitution_heredoc(
  chars: &[char],
  start: usize,
) -> Result<(usize, String, bool), PosixReadError> {
  let mut i = start + 2;
  let tabs = chars.get(i) == Some(&'-');
  if tabs {
    i += 1;
  }
  while chars.get(i).is_some_and(|c| matches!(c, ' ' | '\t')) {
    i += 1;
  }
  let end = word_end(chars, i)?;
  if end == i {
    return Err(PosixReadError::MissingFlowOperand("<<"));
  }
  let mut delimiter = String::new();
  let mut quote = None;
  while i < end {
    let c = chars[i];
    if c == '\\'
      && quote != Some('\'')
      && (quote.is_none()
        || chars
          .get(i + 1)
          .is_some_and(|c| matches!(c, '$' | '`' | '"' | '\\' | '\n')))
    {
      i += 1;
      if chars.get(i).is_some_and(|c| *c != '\n') {
        delimiter.push(chars[i]);
      }
    } else if quote == Some(c) {
      quote = None;
    } else if quote.is_none() && matches!(c, '\'' | '"') {
      quote = Some(c);
    } else {
      delimiter.push(c);
    }
    i += 1;
  }
  Ok((end, delimiter, tabs))
}

pub(super) fn skip_substitution_heredoc(
  chars: &[char],
  mut cursor: usize,
  word: &str,
  tabs: bool,
) -> Result<usize, PosixReadError> {
  while cursor < chars.len() {
    let start = cursor;
    while cursor < chars.len() && chars[cursor] != '\n' {
      cursor += 1;
    }
    let line: String = chars[start..cursor].iter().collect();
    if cursor < chars.len() {
      cursor += 1;
    }
    if (if tabs {
      line.trim_start_matches('\t')
    } else {
      &line
    }) == word
    {
      return Ok(cursor);
    }
  }
  Err(PosixReadError::IncompleteHeredoc(word.into()))
}

fn literal_word(text: &str) -> String {
  format!("'{}'", text.replace('\'', "'\\''"))
}

pub(super) fn word_parts<S, B>(
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Vec<(SExpression<S>, bool, bool)>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let chars = bash_line_chars(raw)?;
  let mut parts = Vec::new();
  let mut quote = None;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if quote.is_none() && c == '$' && chars.get(i + 1) == Some(&'"') {
      i += 1;
      continue;
    }
    if quote.is_none() && c == '$' && chars.get(i + 1) == Some(&'\'') {
      let (text, end) = decode_ansi_c_quote(&chars, i + 2)?;
      parts.push((SExpression::Literal(Literal::String(text)), false, false));
      i = end + 1;
      continue;
    }
    if quote != Some('\'') {
      let expansion = if quote.is_none() && matches!(c, '<' | '>') && chars.get(i + 1) == Some(&'(')
      {
        Some(read_process_substitution(&chars, i, interner, home)?)
      } else if c == '$' {
        read_expansion_in(&chars, i, interner, home, quote == Some('"'))?
      } else if c == '`' {
        let (inner, end) = backtick_source_in_quotes(&chars, i + 1, quote == Some('"'))?;
        let command = read_statement_with_home(&inner, interner, home).map_err(backtick_read_error)?;
        Some((call("std.sh.sub", vec![command], interner), end + 1))
      } else {
        None
      };
      if let Some((value, end)) = expansion {
        parts.push((value, quote.is_none(), quote.is_none()));
        i = end;
        continue;
      }
    }
    if quote == Some(c) {
      quote = None;
      i += 1;
      continue;
    }
    if quote.is_none() && matches!(c, '\'' | '"') {
      quote = Some(c);
      // Explicit empty quotes preserve an otherwise empty expansion's field.
      parts.push((
        SExpression::Literal(Literal::String(String::new())),
        false,
        false,
      ));
      i += 1;
      continue;
    }
    let (text, glob) = if c == '\\' && quote != Some('\'') {
      let next = chars
        .get(i + 1)
        .copied()
        .ok_or(PosixReadError::UnterminatedQuote)?;
      if quote.is_none() || matches!(next, '$' | '`' | '"' | '\\' | '\n') {
        i += 1;
        (
          if next == '\n' {
            String::new()
          } else {
            next.to_string()
          },
          false,
        )
      } else {
        (c.to_string(), false)
      }
    } else if i == 0 && c == '~' && quote.is_none() {
      // A word-leading tilde prefix (a redirection target, a pattern, a
      // brace-expanded element) lowers to the runtime lookup: one unsplit,
      // unglobbed part.
      let end = chars.iter().position(|&c| c == '/').unwrap_or(chars.len());
      let prefix: String = chars[1..end].iter().collect();
      if super::tilde_prefix(&prefix, home) {
        parts.push((call("std.sh.tilde", vec![SExpression::Literal(Literal::String(prefix))], interner), false, false));
        i = end;
        continue;
      }
      (c.to_string(), true)
    } else {
      (c.to_string(), quote.is_none())
    };
    parts.push((SExpression::Literal(Literal::String(text)), false, glob));
    i += 1;
  }
  let mut joined: Vec<(SExpression<S>, bool, bool)> = Vec::new();
  for (value, split, glob) in parts {
    if let SExpression::Literal(Literal::String(text)) = &value {
      if let Some((SExpression::Literal(Literal::String(previous)), ps, pg)) = joined.last_mut() {
        if *ps == split && *pg == glob {
          previous.push_str(text);
          continue;
        }
      }
    }
    joined.push((value, split, glob));
  }
  if raw.strip_prefix('"').and_then(|raw| raw.strip_suffix('"'))
    .is_some_and(|raw| !raw.is_empty() && raw.replace("$@", "").replace("${@}", "").is_empty()) {
    joined.retain(|(value, _, _)| !matches!(value, SExpression::Literal(Literal::String(text)) if text.is_empty()));
  }
  // Quotes around one @ expansion do not anchor an empty array or name list.
  if raw.starts_with('"') && raw.ends_with('"')
    && joined.iter().filter(|(value, _, _)| param::fields(value, interner)).count() == 1
    && joined.iter().all(|(value, _, _)| param::fields(value, interner)
      || matches!(value, SExpression::Literal(Literal::String(text)) if text.is_empty())) {
    joined.retain(|(value, _, _)| !matches!(value, SExpression::Literal(Literal::String(text)) if text.is_empty()));
  }
  Ok(joined)
}

fn redirect_word<S, B>(
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let parts = word_parts(raw, interner, home)?;
  let parts = parts
    .into_iter()
    .map(|(value, split, glob)| {
      word_descriptor(value, split, glob, interner)
    })
    .collect();
  let parts = call("list", parts, interner);
  Ok(call(
    "std.sh.redirect-word",
    vec![parts, SExpression::Literal(Literal::String(raw.into()))],
    interner,
  ))
}

/// Consume bodies before any expansion/substitution scanner sees their bytes.
/// The replacement is a quoted input word, so normal flow lexing stays shared.
pub(super) fn heredocs(source: &str) -> Result<String, PosixReadError> {
  prepare_heredocs(source, false)
}

/// Here-documents read to end of input (a missing delimiter warns), also
/// returning where physical lines were folded away:
/// each `(index, lines)` says the prepared text from char `index` on stands
/// `lines` physical lines further down the source than its newlines count.
pub(super) fn heredocs_eof_lines(source: &str) -> Result<(String, Vec<(usize, isize)>), PosixReadError> {
  let mut folds = Vec::new();
  let prepared = prepare_heredocs_lines(source, true, &mut folds)?;
  Ok((prepared, folds))
}

fn prepare_heredocs(source: &str, eof: bool) -> Result<String, PosixReadError> {
  prepare_heredocs_lines(source, eof, &mut Vec::new())
}

fn prepare_heredocs_lines(source: &str, eof: bool, folds: &mut Vec<(usize, isize)>) -> Result<String, PosixReadError> {
  let chars: Vec<char> = source.chars().collect();
  let mut i = 0;
  let mut pending = Vec::new();
  while i < chars.len() {
    if let Some(end) = protected_end(&chars, i)? {
      i = end;
      continue;
    }
    if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
      while i < chars.len() && chars[i] != '\n' {
        i += 1;
      }
      continue;
    }
    if chars[i] == '<' && chars.get(i + 1) == Some(&'<') && chars.get(i + 2) == Some(&'<') {
      i += 3;
      continue;
    }
    if chars[i] == '<' && chars.get(i + 1) == Some(&'<') {
      let start = i;
      i += 2;
      let tabs = chars.get(i) == Some(&'-');
      if tabs {
        i += 1;
      }
      while chars.get(i).is_some_and(|c| matches!(c, ' ' | '\t')) {
        i += 1;
      }
      let word_start = i;
      i = word_end(&chars, i)?;
      if i == word_start {
        return Err(PosixReadError::MissingFlowOperand("<<"));
      }
      let raw: String = chars[word_start..i].iter().collect();
      let quoted = raw.chars().any(|c| matches!(c, '\'' | '"' | '\\'));
      // Delimiter quote removal performs no parameter or command expansion.
      let mut delimiter = String::new();
      let mut quote = None;
      let mut delimiter_chars = raw.chars().peekable();
      while let Some(c) = delimiter_chars.next() {
        if c == '\\'
          && quote != Some('\'')
          && (quote.is_none()
            || delimiter_chars
              .peek()
              .is_some_and(|c| matches!(c, '$' | '`' | '"' | '\\' | '\n')))
        {
          if let Some(next) = delimiter_chars.next() {
            if next != '\n' {
              delimiter.push(next);
            }
          }
        } else if quote == Some(c) {
          quote = None;
        } else if quote.is_none() && matches!(c, '\'' | '"') {
          quote = Some(c);
        } else {
          delimiter.push(c);
        }
      }
      pending.push((start, i, tabs, quoted, delimiter));
      continue;
    }
    if (chars[i] == '\n' || eof && i + 1 == chars.len()) && !pending.is_empty() {
      let header_end = if chars[i] == '\n' { i } else { chars.len() };
      let mut cursor = (i + 1).min(chars.len());
      let mut replacements = Vec::new();
      let mut warnings = String::new();
      for (start, end, tabs, quoted, delimiter) in pending {
        let mut body = String::new();
        loop {
          if cursor >= chars.len() {
            if !eof { return Err(PosixReadError::IncompleteHeredoc(delimiter)); }
            warnings.push_str(&format!("std.sh.heredoc-warning {}; ", literal_word(&delimiter)));
            break;
          }
          let line_start = cursor;
          while cursor < chars.len() && chars[cursor] != '\n' {
            cursor += 1;
          }
          let physical: String = chars[line_start..cursor].iter().collect();
          let mut line = if tabs {
            physical.trim_start_matches('\t').to_string()
          } else {
            physical
          };
          let mut newline = cursor < chars.len();
          if newline { cursor += 1; }
          while !quoted && newline && line.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1 {
            line.pop();
            let start = cursor;
            while cursor < chars.len() && chars[cursor] != '\n' {
              cursor += 1;
            }
            let next: String = chars[start..cursor].iter().collect();
            line.push_str(if tabs {
              next.trim_start_matches('\t')
            } else {
              &next
            });
            newline = cursor < chars.len();
            if newline { cursor += 1; }
            if cursor == start {
              break;
            }
          }
          if line == delimiter {
            break;
          }
          body.push_str(&line);
          // bash ends every body line with a newline, even the last line of
          // a here-document cut short by end of input.
          body.push('\n');
        }
        let word = if quoted {
          literal_word(&body)
        } else {
          // Heredoc quotes are literal, while $, backticks and the double-quote
          // backslash rules remain active. Protect only the literal quotes.
          let mut escaped = String::new();
          let mut chars = body.chars().peekable();
          while let Some(c) = chars.next() {
            if c == '"' {
              escaped.push('\\');
            }
            if c == '\\' && chars.peek() == Some(&'"') {
              escaped.push('\\');
            }
            escaped.push(c);
          }
          format!("\"{escaped}\"")
        };
        if !quoted {
          let mut interner = StringInterner::<string_interner::backend::StringBackend>::new();
          word_parts::<string_interner::symbol::SymbolU32, _>(&word, &mut interner, None)
            .map_err(|error| match error {
              PosixReadError::IncompleteCompound(_) | PosixReadError::IncompleteHeredoc(_)
                | PosixReadError::UnbalancedSubstitution | PosixReadError::UnterminatedQuote
                | PosixReadError::MissingFlowOperand(_) | PosixReadError::Empty =>
                  PosixReadError::ShellExpansionUnsupported("here-document expansion".into()),
              PosixReadError::ShellExpansionUnsupported(name) if name == "backtick substitution" =>
                PosixReadError::ShellExpansionUnsupported("here-document expansion".into()),
              error => error,
            })?;
        }
        replacements.push((start, end, format!("<< {word}")));
      }
      let mut result = warnings;
      let mut start = 0;
      for (from, to, replacement) in replacements {
        result.extend(&chars[start..from]);
        result.push_str(&replacement);
        start = to;
      }
      result.extend(&chars[start..header_end]);
      result.push('\n');
      // The bodies moved onto the header line: the text after them sits
      // as many physical lines lower as the bodies spanned, less the
      // newlines the quoted words now carry.
      let folded = chars.get(header_end + 1..cursor).map_or(0, |body| body.iter().filter(|c| **c == '\n').count());
      let carried = result.chars().filter(|c| *c == '\n').count() - 1
        - chars[..header_end].iter().filter(|c| **c == '\n').count();
      let offset = result.chars().count();
      folds.push((offset, folded as isize - carried as isize));
      let rest: String = chars[cursor..].iter().collect();
      let mut inner = Vec::new();
      result.push_str(&prepare_heredocs_lines(&rest, eof, &mut inner)?);
      folds.extend(inner.into_iter().map(|(index, lines)| (offset + index, lines)));
      return Ok(result);
    }
    i += 1;
  }
  if let Some((_, _, _, _, delimiter)) = pending.last() {
    if eof { return prepare_heredocs_lines(&format!("{source}\n"), true, folds); }
    return Err(PosixReadError::IncompleteHeredoc(delimiter.clone()));
  }
  Ok(source.into())
}

pub(super) fn read<S, B>(
  source: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let chars: Vec<char> = source.chars().collect();
  let mut command = String::new();
  let mut specs = Vec::new();
  let mut i = 0;
  let mut group = 0;
  while i < chars.len() {
    if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()) {
      break;
    }
    if command.trim().is_empty() && chars[i] == '[' && chars.get(i + 1) == Some(&'[')
      && chars.get(i + 2).is_none_or(|c| c.is_whitespace()) {
      let end = condition::end(&chars, i)?;
      command.extend(&chars[i..end]); i = end; continue;
    }
    if let Some(end) = protected_end(&chars, i)? {
      command.extend(&chars[i..end]);
      i = end;
      continue;
    }
    if chars[i] == '{' && (i == 0 || chars[i - 1].is_whitespace())
      && chars.get(i + 1).is_some_and(|c| c.is_whitespace()) {
      group += 1;
    }
    if chars[i] == '}' && group > 0 {
      group -= 1;
    }
    if group > 0 {
      command.push(chars[i]);
      i += 1;
      continue;
    }
    let start = i;
    let mut op_start = i;
    let mut variable = None;
    if (i == 0 || chars[i - 1].is_whitespace()) && chars[i] == '{' {
      if let Some(close) = chars[i + 1..].iter().position(|c| *c == '}') {
        let close = i + 1 + close;
        let name: String = chars[i + 1..close].iter().collect();
        if compound::identifier(&name) && chars.get(close + 1).is_some_and(|c| matches!(c, '<' | '>')) {
          variable = Some(name);
          op_start = close + 1;
        }
      }
    }
    if variable.is_none() && (i == 0 || chars[i - 1].is_whitespace()) {
      while chars.get(op_start).is_some_and(|c| c.is_ascii_digit()) {
        op_start += 1;
      }
    }
    let both = chars.get(op_start) == Some(&'&') && chars.get(op_start + 1) == Some(&'>');
    // An IO number prefixes < or > only. In 2&>out, 2 is the command.
    if both && op_start > start {
      command.extend(&chars[start..op_start]);
    }
    if !both && !chars.get(op_start).is_some_and(|c| matches!(c, '<' | '>')) {
      command.push(chars[i]);
      i += 1;
      continue;
    }
    i = op_start + if both { 2 } else { 1 };
    if chars.get(i) == Some(&'(') {
      return Err(PosixReadError::ShellOperatorUnsupported(
        chars[op_start..=i].iter().collect(),
      ));
    }
    if both {
      if chars.get(i) == Some(&'>') {
        i += 1;
      }
    } else if chars
      .get(i)
      .is_some_and(|c| *c == chars[op_start] || matches!(c, '&' | '|') || chars[op_start] == '<' && *c == '>')
    {
      i += 1;
      if chars[op_start] == '<' && chars.get(i) == Some(&'<') {
        i += 1;
      }
    }
    let op: String = chars[op_start..i].iter().collect();
    let fd = if variable.is_some() {
      0
    } else if both {
      -1
    } else if op_start > start {
      chars[start..op_start]
        .iter()
        .collect::<String>()
        .parse::<i64>()
        .map_err(|_| {
          PosixReadError::ShellOperatorUnsupported("file descriptor out of range".into())
        })?
    } else if op.starts_with('<') {
      0
    } else {
      1
    };
    while chars.get(i).is_some_and(|c| matches!(c, ' ' | '\t')) {
      i += 1;
    }
    let target_start = i;
    i = word_end(&chars, i)?;
    if target_start == i {
      return Err(PosixReadError::MissingFlowOperand("redirection"));
    }
    let raw: String = chars[target_start..i].iter().collect();
    // Ordinary targets retain unquoted expansion metadata for ambiguity checks.
    let mut atoms = if raw.starts_with("--")
      && !raw
        .chars()
        .any(|c| matches!(c, '$' | '`' | '\\' | '\'' | '"'))
    {
      vec![Atom::Word(raw.clone())]
    } else {
      scan::<S, B>(&raw, interner, home)?
    };
    if atoms.len() != 1 {
      return Err(PosixReadError::MissingFlowOperand("redirection word"));
    }
    let atom = atoms.pop().unwrap();
    let target = match atom {
      Atom::Fields(fields, _) if !matches!(op.as_str(), "<<" | "<<<") => {
        call("std.sh.redirect-fields", vec![fields, SExpression::Literal(Literal::String(raw.clone()))], interner)
      }
      Atom::Expanded(_) | Atom::Glob(_) if !matches!(op.as_str(), "<<" | "<<<") => {
        redirect_word(&raw, interner, home)?
      }
      Atom::Word(_) | Atom::Quoted(_)
        if !matches!(op.as_str(), "<<" | "<<<")
          && raw.chars().any(|c| matches!(c, '*' | '?' | '[')) =>
      {
        redirect_word(&raw, interner, home)?
      }
      atom => atom_to_value(atom, interner),
    };
    specs.push(call(
      "list",
      vec![
        variable.map_or_else(|| SExpression::Literal(Literal::Integer(fd)),
          |name| SExpression::Literal(Literal::String(name))),
        SExpression::Literal(Literal::String(op)),
        target,
      ],
      interner,
    ));
    command.push(' ');
  }
  let mut trimmed = command.trim();
  // An escaped blank before a redirection (`echo a\ &>> f`) is the word's.
  let start = command.len() - command.trim_start().len();
  if trimmed.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1 {
    let end = start + trimmed.len();
    if let Some(blank) = command[end..].chars().next() {
      trimmed = &command[start..end + blank.len_utf8()];
    }
  }
  // `{` opens a group only as its own word: `{echo,hi}` is a brace word.
  let compound = trimmed.starts_with('{')
    && trimmed[1..].starts_with(char::is_whitespace)
    && trimmed.ends_with('}');
  if specs.is_empty() && !compound {
    return Ok(None);
  }
  let stage = if compound {
    {
      let body = &trimmed[1..trimmed.len() - 1];
      if let Some(compound) = compound::read(body, interner, home)? { compound }
      else {
        let tokens = lex_prepared_flow_tokens(body)?;
        let expression = parse_sequence(&tokens, &mut 0, interner, home)?;
        lower_shell_expression(expression, interner)
      }
    }
  } else if trimmed.is_empty() || trimmed == ":" {
    call("begin", vec![], interner)
  } else {
    read_simple_statement(trimmed, interner, home)?
  };
  if specs.is_empty() {
    return Ok(Some(stage));
  }
  let specs = call("list", specs, interner);
  Ok(Some(call(
    "std.sh.redirect",
    vec![stage, specs],
    interner,
  )))
}
