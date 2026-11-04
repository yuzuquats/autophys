//! bash `umask [-p] [-S] [mode]` over the process file-creation mask. A
//! subshell restores the mask it started with, so a change stays local.
use super::*;

/// The new mask for a symbolic `mode` such as `u+w,go=rx` applied to `mask`,
/// or the character bash rejects with its message.
fn symbolic_mask(mask: u32, mode: &str) -> std::result::Result<u32, String> {
  let mut perms = !mask & 0o777;
  for clause in mode.split(',') {
    let mut chars = clause.chars().peekable();
    let mut who = 0;
    while let Some(c) = chars.peek().copied() {
      who |= match c {
        'u' => 0o700,
        'g' => 0o070,
        'o' => 0o007,
        'a' => 0o777,
        _ => break,
      };
      chars.next();
    }
    if who == 0 {
      who = 0o777;
    }
    let Some(op) = chars.next() else {
      return Err("` ': invalid symbolic mode operator".into());
    };
    if !matches!(op, '+' | '-' | '=') {
      return Err(format!("`{op}': invalid symbolic mode operator"));
    }
    let mut bits = 0;
    for c in chars {
      bits |= match c {
        'r' => 0o444,
        'w' => 0o222,
        'x' => 0o111,
        _ => return Err(format!("`{c}': invalid symbolic mode character")),
      };
    }
    let bits = bits & who;
    perms = match op {
      '+' => perms | bits,
      '-' => perms & !bits,
      _ => (perms & !who) | bits,
    };
  }
  Ok(!perms & 0o777)
}

/// `u=rwx,g=rx,o=rx` for 022.
fn symbolic(mask: u32) -> String {
  let perms = !mask & 0o777;
  let class = |shift: u32| {
    let bits = (perms >> shift) & 7;
    let mut text = String::new();
    for (bit, c) in [(4, 'r'), (2, 'w'), (1, 'x')] {
      if bits & bit != 0 {
        text.push(c);
      }
    }
    text
  };
  format!("u={},g={},o={}", class(6), class(3), class(0))
}

impl LispHost {
  pub(in crate::script) fn umask_builtin(
    &mut self,
    args: &[String],
    line: usize,
    output: FlowOutput,
  ) -> Result<Option<JsonValue>> {
    #[cfg(unix)]
    {
      let (mut print, mut symbolic_out) = (false, false);
      let mut index = 0;
      while let Some(arg) = args.get(index) {
        if arg == "--" {
          index += 1;
          break;
        }
        if arg.len() < 2 || !arg.starts_with('-') {
          break;
        }
        for flag in arg[1..].chars() {
          match flag {
            'p' => print = true,
            'S' => symbolic_out = true,
            other => {
              self.report_shell_diagnostic(format!(
                "tsh: line {line}: umask: -{other}: invalid option"
              ));
              self.report_shell_diagnostic("umask: usage: umask [-p] [-S] [mode]".into());
              self.set_shell_status(2);
              return Ok(None);
            }
          }
        }
        index += 1;
      }
      let mask = u32::from(super::current_umask());
      let Some(mode) = args.get(index) else {
        let shown = if symbolic_out {
          symbolic(mask)
        } else {
          format!("{mask:04o}")
        };
        let text = if print {
          format!("umask {}{shown}\n", if symbolic_out { "-S " } else { "" })
        } else {
          format!("{shown}\n")
        };
        output.write_bytes(self, text.as_bytes());
        self.set_shell_status(0);
        return Ok(None);
      };
      let new = if mode.starts_with(|c: char| c.is_ascii_digit()) {
        match u32::from_str_radix(mode, 8) {
          Ok(value) if value <= 0o777 => Ok(value),
          _ => Err(format!("{mode}: octal number out of range")),
        }
      } else {
        symbolic_mask(mask, mode)
      };
      match new {
        Ok(new) => {
          // SAFETY: umask only replaces the process file-creation mask.
          unsafe { libc::umask(new as libc::mode_t) };
          self.shell_compound.commands.umask_changes += 1;
          if symbolic_out {
            output.write_bytes(self, format!("{}\n", symbolic(new)).as_bytes());
          }
          self.set_shell_status(0);
        }
        Err(message) => {
          self.report_shell_diagnostic(format!("tsh: line {line}: umask: {message}"));
          self.set_shell_status(1);
        }
      }
    }
    #[cfg(not(unix))]
    {
      let _ = (args, line, output);
      self.set_shell_status(0);
    }
    Ok(None)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn symbolic_modes_follow_bash() {
    assert_eq!(symbolic_mask(0o022, "u+w,g-r"), Ok(0o062));
    assert_eq!(symbolic_mask(0o777, "a=rx"), Ok(0o222));
    assert_eq!(symbolic_mask(0o222, "go="), Ok(0o277));
    assert_eq!(symbolic_mask(0o277, "u=rwx,go-w"), Ok(0o077));
    assert_eq!(
      symbolic_mask(0o022, "zz"),
      Err("`z': invalid symbolic mode operator".into())
    );
  }

  #[test]
  fn symbolic_output_names_each_class() {
    assert_eq!(symbolic(0o022), "u=rwx,g=rx,o=rx");
    assert_eq!(symbolic(0o755), "u=,g=w,o=w");
  }
}
