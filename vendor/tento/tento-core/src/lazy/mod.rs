use std::{
  sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
  },
  time::{Duration, Instant},
};

static STARTUP_DEADLINE: OnceLock<Instant> = OnceLock::new();
static STARTUP_DEADLINE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Set a startup deadline. Any `Lazy::get()` call after this deadline
/// will abort the process instead of potentially deadlocking. Also
/// spawns a watchdog thread that aborts if the deadline is never
/// cleared (i.e. the server never reaches READY).
///
/// **First arm wins.** Subsequent calls log a warning and return
/// without spawning a redundant watchdog thread — this is the supported
/// pattern for "arm early at the binary entry, with a fallback arm
/// somewhere deeper for non-loaf consumers" (see `loaf.package::cmd::server`
/// + `tento_web::start_server`).
pub fn set_startup_deadline(timeout: Duration) {
  set_startup_deadline_named(None, timeout);
}

/// Same as [`set_startup_deadline`] but tags the arm site in the log line
/// (`[lazy] startup deadline set: Ns at <label>`). On a re-arm, the warning
/// names the LATER caller so the operator can tell which arm actually
/// provided coverage.
pub fn set_startup_deadline_at(label: &'static str, timeout: Duration) {
  set_startup_deadline_named(Some(label), timeout);
}

fn set_startup_deadline_named(label: Option<&'static str>, timeout: Duration) {
  let deadline = Instant::now() + timeout;
  if STARTUP_DEADLINE.set(deadline).is_err() {
    // First arm already won — don't re-store ACTIVE (already true), don't
    // log a misleading "set" line, don't spawn a redundant thread.
    eprintln!(
      "[lazy] startup deadline already armed; ignoring re-arm{} of {}s",
      label.map(|l| format!(" from {l}")).unwrap_or_default(),
      timeout.as_secs(),
    );
    return;
  }
  STARTUP_DEADLINE_ACTIVE.store(true, Ordering::SeqCst);
  eprintln!(
    "[lazy] startup deadline set: {}s{}",
    timeout.as_secs(),
    label.map(|l| format!(" at {l}")).unwrap_or_default(),
  );

  std::thread::spawn(move || {
    std::thread::sleep(timeout);
    if STARTUP_DEADLINE_ACTIVE.load(Ordering::SeqCst) {
      eprintln!(
        "[lazy] FATAL: startup watchdog fired after {}s — server failed to reach READY, aborting",
        timeout.as_secs()
      );
      std::process::exit(1);
    }
  });
}

/// Clear the startup deadline (call after server is ready).
pub fn clear_startup_deadline() {
  STARTUP_DEADLINE_ACTIVE.store(false, Ordering::SeqCst);
  eprintln!("[lazy] startup deadline cleared");
}

#[derive(Clone)]
pub struct Lazy<T>
where
  T: Clone,
{
  inner: Arc<OnceLock<T>>,
  factory: Arc<dyn Fn() -> T + Send + Sync>,
  name: Option<&'static str>,
}

impl<T> Lazy<T>
where
  T: Clone,
{
  pub fn new(factory: impl Fn() -> T + Send + Sync + 'static) -> Self {
    Lazy {
      inner: Arc::new(OnceLock::new()),
      factory: Arc::new(factory),
      name: None,
    }
  }

  pub fn named(name: &'static str, factory: impl Fn() -> T + Send + Sync + 'static) -> Self {
    Lazy {
      inner: Arc::new(OnceLock::new()),
      factory: Arc::new(factory),
      name: Some(name),
    }
  }

  pub fn get(&self) -> T {
    self
      .inner
      .get_or_init(|| {
        if STARTUP_DEADLINE_ACTIVE.load(Ordering::SeqCst) {
          if let Some(deadline) = STARTUP_DEADLINE.get() {
            if Instant::now() > *deadline {
              let name = self.name.unwrap_or("?");
              eprintln!(
                "[lazy:{}] FATAL: startup deadline exceeded, aborting to prevent deadlock",
                name
              );
              std::process::exit(1);
            }
          }
        }
        if let Some(name) = self.name {
          eprintln!("[lazy:{}] init starting", name);
        }
        let start = Instant::now();
        let value = (self.factory)();
        let elapsed = start.elapsed();
        if let Some(name) = self.name {
          eprintln!("[lazy:{}] init took {:?}", name, elapsed);
        } else if elapsed.as_millis() > 10 {
          eprintln!("[lazy:?] init took {:?}", elapsed);
        }
        value
      })
      .clone()
  }
}
