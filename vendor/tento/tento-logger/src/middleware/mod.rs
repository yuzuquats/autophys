mod request_id;
mod root_span;
mod root_span_macro;
mod tracing_logger;

use tracing_logger::{DomainRootSpanBuilder, TracingLogger, WithId, WithoutId};

pub struct TentoLogger;

impl TentoLogger {
  pub fn default_log_identity() -> TracingLogger<DomainRootSpanBuilder<WithId>> {
    TracingLogger::<DomainRootSpanBuilder<WithId>>::new()
  }

  pub fn default() -> TracingLogger<DomainRootSpanBuilder<WithoutId>> {
    TracingLogger::<DomainRootSpanBuilder<WithoutId>>::new()
  }

  pub fn new<RootSpan: tracing_logger::RootSpanBuilder>() -> TracingLogger<RootSpan> {
    TracingLogger::<RootSpan>::new()
  }

  pub fn register_panic_hook_for_thread(backtrace_to_stderr: bool) {
    crate::panic_hook::register(backtrace_to_stderr);
  }
}
