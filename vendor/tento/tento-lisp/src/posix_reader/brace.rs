//! Brace alternatives retain source quoting until ordinary word expansion.
use super::*;

fn sequence(body: &str) -> Option<Vec<String>> {
  let parts: Vec<_> = body.split("..").collect();
  if !(2..=3).contains(&parts.len()) {
    return None;
  }
  let step = if parts.len() == 3 {
    parts[2].parse::<i64>().ok()?.checked_abs()?
  } else {
    1
  }
  .max(1);
  let numeric = parts[0]
    .parse::<i64>()
    .ok()
    .zip(parts[1].parse::<i64>().ok());
  let (start, end, letters) = if let Some((a, b)) = numeric {
    (a, b, false)
  } else if parts[0].len() == 1
    && parts[1].len() == 1
    && parts[0].as_bytes()[0].is_ascii_alphabetic()
    && parts[1].as_bytes()[0].is_ascii_alphabetic()
  {
    (
      i64::from(parts[0].as_bytes()[0]),
      i64::from(parts[1].as_bytes()[0]),
      true,
    )
  } else {
    return None;
  };
  let padded = !letters
    && parts[..2].iter().any(|s| {
      s.strip_prefix('-').unwrap_or(s).starts_with('0')
        && s.strip_prefix('-').unwrap_or(s).len() > 1
    });
  let width = if padded {
    parts[0].len().max(parts[1].len())
  } else {
    0
  };
  let step = if start > end { -step } else { step };
  let mut result = Vec::new();
  let mut value = start;
  while if step > 0 { value <= end } else { value >= end } {
    if result.len() >= 100_000 {
      return None;
    }
    result.push(if letters {
      // Generated metacharacters are not reparsed as command syntax.
      if value == i64::from(b'\\') {
        "''".into()
      } else if value == i64::from(b'`') {
        "\\`".into()
      } else {
        (value as u8 as char).to_string()
      }
    } else if padded {
      format!("{value:0width$}")
    } else {
      value.to_string()
    });
    let Some(next) = value.checked_add(step) else {
      break;
    };
    value = next;
  }
  Some(result)
}

fn alternatives(
  chars: &[char],
  start: usize,
) -> Result<Option<(usize, Vec<String>)>, PosixReadError> {
  let mut depth = 0;
  let mut commas = Vec::new();
  let mut i = start + 1;
  while i < chars.len() {
    if let Some(end) = redirection::protected_end(chars, i)? {
      i = end;
      continue;
    }
    match chars[i] {
      '{' => depth += 1,
      '}' if depth == 0 => {
        let values = if commas.is_empty() {
          sequence(&chars[start + 1..i].iter().collect::<String>())
        } else {
          let mut values = Vec::new();
          let mut from = start + 1;
          for to in commas.into_iter().chain(std::iter::once(i)) {
            values.push(chars[from..to].iter().collect());
            from = to + 1;
          }
          Some(values)
        };
        if values.is_none() && is_brace_sequence(&chars[start + 1..i]) {
          return Err(PosixReadError::ShellExpansionUnsupported(
            "brace sequence is out of range (maximum 100000 words)".into(),
          ));
        }
        return Ok(values.map(|values| (i + 1, values)));
      }
      '}' => depth -= 1,
      ',' if depth == 0 => commas.push(i),
      _ => {}
    }
    i += 1;
  }
  Ok(None)
}

pub(super) fn expand(raw: &str) -> Result<Vec<String>, PosixReadError> {
  let chars: Vec<_> = raw.chars().collect();
  let mut i = 0;
  while i < chars.len() {
    if let Some(end) = redirection::protected_end(&chars, i)? {
      i = end;
      continue;
    }
    if chars[i] == '{' {
      if let Some((end, alternatives)) = alternatives(&chars, i)? {
        let prefix: String = chars[..i].iter().collect();
        let suffix: String = chars[end..].iter().collect();
        let mut result = Vec::new();
        for alternative in alternatives {
          for word in expand(&format!("{prefix}{alternative}{suffix}"))? {
            if result.len() >= 100_000 {
              return Err(PosixReadError::ShellExpansionUnsupported(
                "brace expansion exceeds 100000 words".into(),
              ));
            }
            result.push(word);
          }
        }
        return Ok(result);
      }
    }
    i += 1;
  }
  Ok(vec![raw.into()])
}

fn fields<S, B>(
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<SExpression<S>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let parts = redirection::word_parts(raw, interner, home)?
    .into_iter()
    .map(|(value, split, glob)| word_descriptor(value, split, glob, interner))
    .collect();
  let parts = call("list", parts, interner);
  Ok(call("std.sh.split", vec![parts], interner))
}

pub(super) fn word<S, B>(
  raw: &str,
  interner: &mut StringInterner<B>,
  home: Option<&str>,
) -> Result<Option<SExpression<S>>, PosixReadError>
where
  S: Symbol,
  B: Backend<S>,
{
  let expanded = expand(raw)?;
  if expanded.len() == 1 && expanded[0] == raw {
    return Ok(None);
  }
  let mut words = Vec::new();
  for word in expanded {
    words.push(fields(&word, interner, home)?);
  }
  let enabled = call("append", words, interner);
  let disabled = fields(raw, interner, home)?;
  let toggle = call("std.sh.brace-enabled", Vec::new(), interner);
  Ok(Some(call("if", vec![toggle, enabled, disabled], interner)))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn brace_nested_ranges_quotes_and_parameter_boundaries() {
    for (raw, expected) in [
      ("pre{a,{b,c}}post", vec!["preapost", "prebpost", "precpost"]),
      ("{03..-1..2}", vec!["03", "01", "-1"]),
      ("{e..a..2}", vec!["e", "c", "a"]),
      ("{a,b}{1,2}", vec!["a1", "a2", "b1", "b2"]),
      ("{\"a\",b}", vec!["\"a\"", "b"]),
      ("${x:-{a,b}}", vec!["${x:-{a,b}}"]),
      ("'{a,b}'", vec!["'{a,b}'"]),
      ("{a}", vec!["{a}"]),
      ("{}", vec!["{}"]),
    ] {
      assert_eq!(expand(raw).unwrap(), expected, "{raw}");
    }
  }

  #[test]
  fn a_brace_word_in_command_position_is_not_a_group() {
    // bash: `{echo,hi}` runs `echo hi`; `{ echo hi; }` is a group.
    let mut interner = StringInterner::<string_interner::backend::StringBackend>::new();
    let form = read_statement::<string_interner::symbol::SymbolU32, _>("{echo,hi}", &mut interner).unwrap();
    let json = sexpr_to_json(&form, &interner).to_string();
    assert!(json.contains("std.sh.brace-enabled"), "{json}");
    // An escaped blank before a redirection stays in its word.
    let form = read_statement::<string_interner::symbol::SymbolU32, _>("echo a\\ &>> /dev/null", &mut interner).unwrap();
    let json = sexpr_to_json(&form, &interner).to_string();
    assert!(json.contains(r#"{"str":"a "}"#), "{json}");
  }
}
