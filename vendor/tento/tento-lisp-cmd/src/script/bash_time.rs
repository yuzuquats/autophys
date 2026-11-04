//! The `time` reserved word: `(std.sh.time POSIX PIPELINE)` from the
//! reader. It times the whole pipeline — real time and the user/system CPU
//! of the shell and its children — and reports on the shell's standard
//! error as it stood around `time` (the pipeline's own redirections do not
//! apply), in `TIMEFORMAT` (or the POSIX format for `time -p`). A bare
//! `time` times nothing. A `return` out of the timed pipeline prints
//! nothing, as bash's longjmp does (`break` still reports).
//!
//! Bash 5.3 accepts precisions up to 6 and rounds; 3.2 caps them at 3 and
//! truncates.
use std::time::Instant;

use serde_json::Value as JsonValue;
use tento_lisp::Value as LispValue;

use super::bash_flow::{FlowOutput, eval_flow};
use super::interp::{LispHost, Sym};
use super::runner::TshScriptErrorKind;

const DEFAULT_FORMAT: &str = "\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS";
const POSIX_FORMAT: &str = "real %2R\nuser %2U\nsys %2S";

/// Elapsed seconds as whole seconds and microseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Span {
  seconds: u64,
  micros: u32,
}

impl Span {
  fn from_micros(total: u128) -> Self {
    Span { seconds: (total / 1_000_000) as u64, micros: (total % 1_000_000) as u32 }
  }

  fn total_micros(self) -> u128 {
    u128::from(self.seconds) * 1_000_000 + u128::from(self.micros)
  }
}

/// Real, user and system time of one timed pipeline.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Times {
  real: Span,
  user: Span,
  system: Span,
}

fn cpu() -> (u128, u128) {
  let mut total = (0u128, 0u128);
  for who in [libc::RUSAGE_SELF, libc::RUSAGE_CHILDREN] {
    // SAFETY: `usage` is plain data filled by getrusage.
    let usage = unsafe {
      let mut usage: libc::rusage = std::mem::zeroed();
      libc::getrusage(who, &mut usage);
      usage
    };
    let micros = |time: libc::timeval| time.tv_sec as u128 * 1_000_000 + time.tv_usec as u128;
    total.0 += micros(usage.ru_utime);
    total.1 += micros(usage.ru_stime);
  }
  total
}

/// `TIMEFORMAT` expanded over TIMES, or the invalid character.
pub(super) fn format(format: &str, times: Times) -> Result<String, String> {
  let mut out = String::new();
  let mut chars = format.chars().peekable();
  while let Some(c) = chars.next() {
    if c != '%' {
      out.push(c);
      continue;
    }
    let Some(next) = chars.peek().copied() else {
      // A trailing `%` prints as itself.
      out.push('%');
      break;
    };
    if next == '%' {
      chars.next();
      out.push('%');
      continue;
    }
    if next == 'P' {
      chars.next();
      let real = times.real.total_micros();
      let cpu = times.user.total_micros() + times.system.total_micros();
      // Hundredths of a percent, as bash's integer arithmetic.
      let hundredths = if real == 0 { 0 } else { cpu * 10_000 / real };
      out.push_str(&format!("{}.{:02}", hundredths / 100, hundredths % 100));
      continue;
    }
    let mut precision = 3usize;
    if let Some(digit) = next.to_digit(10) {
      chars.next();
      precision = (digit as usize).min(6);
    }
    let long = chars.peek() == Some(&'l');
    if long {
      chars.next();
    }
    let span = match chars.next() {
      Some('R') => times.real,
      Some('U') => times.user,
      Some('S') => times.system,
      Some(other) => return Err(other.to_string()),
      None => return Err(" ".into()),
    };
    out.push_str(&seconds_text(span, precision, long));
  }
  Ok(out)
}

/// bash's `mkfmt`: seconds (or `NmS.FFFs` when long) to PRECISION digits,
/// rounded.
fn seconds_text(span: Span, precision: usize, long: bool) -> String {
  let scale = 10u128.pow(6 - precision as u32);
  let rounded = (span.total_micros() + scale / 2) / scale;
  let unit = 10u128.pow(precision as u32);
  let (mut seconds, fraction) = (rounded / unit, rounded % unit);
  let mut out = String::new();
  if long {
    out.push_str(&format!("{}m", seconds / 60));
    seconds %= 60;
  }
  out.push_str(&seconds.to_string());
  if precision > 0 {
    out.push_str(&format!(".{fraction:0precision$}"));
  }
  if long {
    out.push('s');
  }
  out
}

impl LispHost {
  /// `(std.sh.time POSIX PIPELINE)`.
  pub(super) async fn time_pipeline(
    &mut self,
    stages: &[LispValue<Sym>],
    line: usize,
    ignored: bool,
    output: FlowOutput,
    last: bool,
  ) -> Result<Option<JsonValue>, TshScriptErrorKind> {
    let [LispValue::Boolean(posix), pipeline] = stages else {
      return Err(TshScriptErrorKind::Lisp(super::interp::LispHostError::Runtime("std.sh.time: invalid operands".into())));
    };
    let posix = *posix;
    let started = Instant::now();
    let (user_before, system_before) = cpu();
    let bare = matches!(pipeline, LispValue::List(list) if list.items.len() == 1
      && self.application_head(pipeline).as_deref() == Some("std.sh.seq"));
    let result = if bare {
      Ok(None)
    } else {
      eval_flow(self, pipeline, line, ignored, output.clone(), last).await
    };
    // `return` out of the pipeline skips the report (bash longjmps past it).
    if let Err(TshScriptErrorKind::Control(
      super::ControlSignal::Return(_),
    )) = &result
    {
      return result;
    }
    let (user_after, system_after) = cpu();
    let times = Times {
      real: Span::from_micros(started.elapsed().as_micros()),
      user: Span::from_micros(user_after.saturating_sub(user_before)),
      system: Span::from_micros(system_after.saturating_sub(system_before)),
    };
    let status = self.shell_status();
    let format_text = if posix {
      Some(POSIX_FORMAT.to_string())
    } else {
      let call = self.shell_literal_call(&["std.sh.var".into(), "TIMEFORMAT".into()], "std.sh.var", false);
      let set = self.shell_variable_set("TIMEFORMAT");
      match self.evaluate_shell_data(&call) {
        Ok(JsonValue::String(text)) if set => Some(text),
        _ if set => Some(String::new()),
        _ => Some(DEFAULT_FORMAT.to_string()),
      }
    };
    match format_text.filter(|text| !text.is_empty()).map(|text| format(&text, times)) {
      Some(Ok(text)) => self.report_shell_diagnostic(text),
      Some(Err(bad)) => {
        self.report_shell_diagnostic(format!("tsh: line {line}: TIMEFORMAT: `{bad}': invalid format character"))
      }
      None => {}
    }
    self.set_shell_status(status);
    result
  }

  /// Whether shell variable NAME is set (bound, or in the environment).
  fn shell_variable_set(&mut self, name: &str) -> bool {
    let symbol = self.interp.string_interner().get_or_intern(name);
    let bound = self.env.borrow().get(symbol);
    match bound {
      Some(LispValue::String(_)) => true,
      Some(_) => false,
      None => tento_env::effective_var(name).is_some(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn times(real: u128, user: u128, system: u128) -> Times {
    Times { real: Span::from_micros(real), user: Span::from_micros(user), system: Span::from_micros(system) }
  }

  // Formats checked against bash 5.3's `time` with fixed spans.
  #[test]
  fn timeformat_matches_bash() {
    let t = times(20_700, 1_000, 2_000);
    assert_eq!(
      format("R=%R U=%U S=%S %% %0R %1R %2lR %lR %3lU %4R|", t).unwrap(),
      "R=0.021 U=0.001 S=0.002 % 0 0.0 0m0.02s 0m0.021s 0m0.001s 0.0207|"
    );
    assert_eq!(format(DEFAULT_FORMAT, times(0, 0, 0)).unwrap(), "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s");
    assert_eq!(format(POSIX_FORMAT, times(0, 0, 0)).unwrap(), "real 0.00\nuser 0.00\nsys 0.00");
    assert_eq!(format("%0lR %1lR", times(1_050_000, 0, 0)).unwrap(), "0m1s 0m1.1s");
    assert_eq!(format("%lR", times(61_500_000, 0, 0)).unwrap(), "1m1.500s");
    assert_eq!(format("a%", t).unwrap(), "a%");
    assert_eq!(format("tab\\tx", t).unwrap(), "tab\\tx");
    assert_eq!(format("%x", t), Err("x".into()));
    assert_eq!(format("%P", times(100_000, 1_000_000, 0)).unwrap(), "1000.00");
    assert_eq!(format("%P", times(0, 0, 0)).unwrap(), "0.00");
  }
}
