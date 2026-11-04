use std::sync::Once;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

static INIT: Once = Once::new();

pub fn init_tracing() {
  INIT.call_once(|| {
    // Anything that implements `MakeWriter` will work.
    // `TestWriter::stderr()` picks *stderr* and still plays nicely
    // with the test harness.
    let fmt_layer = fmt::layer()
      .with_writer(fmt::writer::TestWriter::new()) // or just std::io::stderr
      .with_target(false) // hide target module path
      .with_level(true); // show INFO/DEBUG/…

    tracing_subscriber::registry().with(fmt_layer).init();
  });
}
