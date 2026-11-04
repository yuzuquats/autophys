use std::backtrace::Backtrace;
use std::cell::Cell;
use std::io::{Write, stderr};
use std::panic::PanicHookInfo;

use crate::subscribers::exception::ExceptionWithTrace;

pub(crate) const REPANIC_KEY: &str = "<yuzu_actix_logger::repanic>";

thread_local! {
  pub(crate) static EXCEPTION: Cell<Option<ExceptionWithTrace>> = const { Cell::new(None) };
}

fn hook(info: &PanicHookInfo<'_>, with_stderr: bool) {
  let message = ExceptionWithTrace::parse_message(info);
  if let Some(ref message) = message {
    if message == REPANIC_KEY {
      return;
    }
  }

  let trace = Backtrace::capture();
  let mut panic_with_trace = ExceptionWithTrace::new(message, Some(&trace));
  panic_with_trace.filtered_range.0 = Some("rust_begin_unwind".to_string());
  let serialized = serde_json::to_string(&panic_with_trace).expect("trace couldn't serialize");

  if with_stderr {
    let _ = writeln!(stderr().lock(), "{trace}");
  }

  EXCEPTION.replace(Some(panic_with_trace));
  tracing::error!(exception.trace_json = serialized, "<hook>");
}

fn hook_with_backtrace(info: &PanicHookInfo<'_>) {
  hook(info, true)
}

fn hook_without_backtrace(info: &PanicHookInfo<'_>) {
  hook(info, false)
}

pub(crate) fn register(backtrace_to_stderr: bool) {
  std::panic::set_hook(Box::new(if backtrace_to_stderr {
    hook_with_backtrace
  } else {
    hook_without_backtrace
  }));
}
