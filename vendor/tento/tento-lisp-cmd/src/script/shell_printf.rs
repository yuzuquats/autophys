//! Bash printf escape compatibility over the platform's printf formatter.

/// Protect unknown escapes from printf implementations that drop their slash.
/// Only the bare shell spelling is adapted; executable paths stay native.
pub(super) fn prepare_printf_argv(argv: &mut Vec<String>) {
  if argv.first().map(String::as_str) != Some("printf") {
    return;
  }
  let format_index = if argv.get(1).map(String::as_str) == Some("--") {
    2
  } else {
    1
  };
  let Some(format) = argv.get(format_index).cloned() else {
    return;
  };
  // Option errors belong to the native utility. Do not turn an option into a format.
  if format_index == 1 && format.starts_with('-') {
    return;
  }
  let (conversions, format) = conversions(&format);
  argv[format_index] = protect_escapes(&format, false);
  if conversions.is_empty() {
    return;
  }
  let supplied = argv.len().saturating_sub(format_index + 1);
  let last_cycle = supplied.saturating_sub(1) / conversions.len();
  if let Some(last_q) = conversions
    .iter()
    .rposition(|kind| matches!(*kind, 'q' | 'Q'))
  {
    let needed = last_cycle * conversions.len() + last_q + 1;
    while argv.len() < format_index + 1 + needed {
      let index = argv.len() - format_index - 1;
      let kind = conversions[index % conversions.len()];
      argv.push(if "diouxXfFeEgGaA*".contains(kind) {
        "0".into()
      } else {
        String::new()
      });
    }
  }
  for (index, argument) in argv.iter_mut().skip(format_index + 1).enumerate() {
    match conversions[index % conversions.len()] {
      'b' => *argument = protect_escapes(argument, true),
      'q' => *argument = quote(argument),
      'Q' => *argument = quote_alternate(argument),
      _ => {}
    }
  }
}

fn protect_escapes(text: &str, b_argument: bool) -> String {
  let mut output = String::with_capacity(text.len());
  let mut chars = text.chars();
  while let Some(ch) = chars.next() {
    output.push(ch);
    if ch != '\\' {
      continue;
    }
    let Some(next) = chars.next() else {
      output.push('\\');
      break;
    };
    let known = "abefnrtvE\\01234567xuU".contains(next)
      || if b_argument {
        next == 'c'
      } else {
        "\"'?".contains(next)
      };
    if !known {
      output.push('\\');
    }
    output.push(next);
  }
  output
}

// One entry per consumed argument, including dynamic width and precision.
// The format repeats until every argument is consumed, just like printf.
fn conversions(format: &str) -> (Vec<char>, String) {
  let bytes = format.as_bytes();
  let mut result = Vec::new();
  let mut rewritten = format.to_string();
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'\\' && bytes.get(i + 1) != Some(&b'%') {
      i += 1;
      if let Some(next) = bytes.get(i).copied() {
        i += 1;
        let digits = match next {
          b'0'..=b'7' => 2,
          b'x' => 2,
          b'u' => 4,
          b'U' => 8,
          _ => 0,
        };
        for _ in 0..digits {
          if bytes.get(i).is_some_and(|ch| {
            if next.is_ascii_digit() {
              (b'0'..=b'7').contains(ch)
            } else {
              ch.is_ascii_hexdigit()
            }
          }) {
            i += 1;
          } else {
            break;
          }
        }
      }
      continue;
    }
    if bytes[i] != b'%' {
      i += 1;
      continue;
    }
    i += 1;
    if bytes.get(i) == Some(&b'%') {
      i += 1;
      continue;
    }
    let mut alternate = false;
    while bytes.get(i).is_some_and(|ch| b"#0- +'".contains(ch)) {
      alternate |= bytes[i] == b'#';
      i += 1;
    }
    if bytes.get(i) == Some(&b'*') {
      result.push('*');
      i += 1;
    } else {
      while bytes.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
      }
    }
    if bytes.get(i) == Some(&b'.') {
      i += 1;
      if bytes.get(i) == Some(&b'*') {
        result.push('*');
        i += 1;
      } else {
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
          i += 1;
        }
      }
    }
    while bytes.get(i).is_some_and(|ch| b"hljztL".contains(ch)) {
      i += 1;
    }
    if let Some(ch) = bytes.get(i) {
      result.push(if *ch == b'q' && alternate {
        'Q'
      } else {
        *ch as char
      });
      if *ch == b'q' {
        rewritten.replace_range(i..i + 1, "s");
      }
      i += 1;
    }
  }
  (result, rewritten)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn argv(args: &[&str]) -> Vec<String> {
    let mut argv = vec!["printf".into()];
    argv.extend(args.iter().map(|arg| (*arg).into()));
    prepare_printf_argv(&mut argv);
    argv
  }

  #[test]
  fn printf_unknown_and_trailing_escapes_keep_the_backslash() {
    assert_eq!(argv(&[r"\ \q\"]), ["printf", r"\\ \\q\\"]);
    assert_eq!(argv(&["%b", r"\ \q\"]), ["printf", "%b", r"\\ \\q\\"]);
    assert_eq!(argv(&[r#"\c\'\"\?"#]), ["printf", r#"\\c\'\"\?"#]);
    assert_eq!(
      argv(&["%b", r#"\c\'\"\?"#]),
      ["printf", "%b", r#"\c\\'\\"\\?"#]
    );
  }

  #[test]
  fn printf_b_arguments_follow_conversion_consumption_and_repetition() {
    assert_eq!(
      argv(&["%s:%b:%%", r"\q", r"\q", r"\z", r"\z"]),
      ["printf", "%s:%b:%%", r"\q", r"\\q", r"\z", r"\\z"]
    );
    assert_eq!(
      argv(&["%*.*b:%s", "8", "4", r"\q", r"\q"]),
      ["printf", "%*.*b:%s", "8", "4", r"\\q", r"\q"]
    );
    assert_eq!(argv(&[r"\%b", r"\q"]), ["printf", r"\\%b", r"\\q"]);
    assert_eq!(argv(&[r"\045b", r"\q"]), ["printf", r"\045b", r"\q"]);
  }

  #[test]
  fn printf_known_escapes_and_other_program_arguments_stay_literal() {
    let known = r"\a\b\e\E\f\n\r\t\v\\\012\x41\u0041\U00000041";
    assert_eq!(argv(&[known, "%b", known]), ["printf", known, "%b", known]);
    assert_eq!(argv(&["--", "%b", r"\q"]), ["printf", "--", "%b", r"\\q"]);
    for name in ["/usr/bin/printf", "other"] {
      let mut words = vec![name.into(), r"\q".into()];
      let before = words.clone();
      prepare_printf_argv(&mut words);
      assert_eq!(words, before);
    }
  }
}

/// Bash's reusable shell word: printable metacharacters use backslashes;
/// control bytes use an ANSI-C quote. Empty strings are an explicit empty word.
pub(super) fn quote(text: &str) -> String {
  if text.is_empty() {
    return "''".into();
  }
  let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
    .into_iter()
    .find_map(|name| {
      let value = if tento_env::global_env_map().is_some() {
        tento_env::effective_var(name)
      } else {
        std::env::var(name).ok()
      };
      value.filter(|value| !value.is_empty())
    })
    .unwrap_or_default()
    .to_ascii_lowercase();
  let utf8 = locale.contains("utf-8") || locale.contains("utf8");
  if text
    .chars()
    .any(|c| c.is_control() || !utf8 && !c.is_ascii())
  {
    let mut result = String::from("$'");
    for ch in text.chars() {
      match ch {
        '\x07' => result.push_str("\\a"),
        '\x08' => result.push_str("\\b"),
        '\x1b' => result.push_str("\\E"),
        '\x0c' => result.push_str("\\f"),
        '\n' => result.push_str("\\n"),
        '\r' => result.push_str("\\r"),
        '\t' => result.push_str("\\t"),
        '\x0b' => result.push_str("\\v"),
        '\\' => result.push_str("\\\\"),
        '\'' => result.push_str("\\'"),
        ch if ch.is_ascii_control() => result.push_str(&format!("\\{:03o}", ch as u32)),
        ch if !utf8 && !ch.is_ascii() => {
          let mut bytes = [0; 4];
          for byte in ch.encode_utf8(&mut bytes).as_bytes() {
            result.push_str(&format!("\\{byte:03o}"));
          }
        }
        ch => result.push(ch),
      }
    }
    result.push('\'');
    return result;
  }
  let mut result = String::new();
  for (index, ch) in text.chars().enumerate() {
    if ch.is_whitespace()
      || "\\\"'`$&;|<>(){}[]*!?^".contains(ch)
      || index == 0 && "#~".contains(ch)
    {
      result.push('\\');
    }
    result.push(ch);
  }
  result
}

pub(super) fn quote_alternate(raw: &str) -> String {
  let quoted = quote(raw);
  if quoted.starts_with("$'") {
    quoted
  } else {
    format!("'{}'", raw.replace('\'', "'\\''"))
  }
}
