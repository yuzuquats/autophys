//! Dev rebuild scheduling: one slot per output root, a bounded number of
//! slots building at once, and requests that arrive while a slot builds
//! merged into one follow-up build of that slot.
//!
//! The unit of serialisation is the output root, not the domain and not the
//! whole server: a build starts by cleaning its tree, so two webapps writing
//! one root must take turns, while webapps writing different roots have
//! nothing to protect from each other. The "dirty" state is each slot's own
//! pending set, never a global flag, so one slot finishing cannot clear
//! another's work, and a request that lands after a build started reading
//! files always gets a build that starts after it.
//! See `projects/frontend-build-scheduling.project.docs`.

use std::{
  collections::{HashMap, VecDeque},
  future::Future,
  panic::AssertUnwindSafe,
  path::{Component, Path, PathBuf},
  pin::Pin,
  sync::Arc,
  time::{Duration, Instant, SystemTime},
};

use tokio::{
  sync::{Semaphore, mpsc},
  task::JoinSet,
};
use tracing::{Instrument, error, info, info_span};

use crate::Webapp;

pub(crate) type BuildFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;

/// Something the scheduler can build.
pub(crate) trait BuildJob: Send + Sync + 'static {
  /// Jobs sharing a key never build at the same time.
  fn output_key(&self) -> PathBuf;
  /// Names the job in logs and reports.
  fn label(&self) -> String;
  fn build(self: Arc<Self>) -> BuildFuture;
}

impl BuildJob for Webapp {
  /// The beta routes root as one identity however it is spelled; see
  /// `stable_output_key`.
  fn output_key(&self) -> PathBuf {
    self.beta_output_key()
  }

  fn label(&self) -> String {
    self.domain_name()
  }

  fn build(self: Arc<Self>) -> BuildFuture {
    let span = info_span!("build", message = "build-beta", domain = %self.domain_name());
    Box::pin(async move { self.build_beta().await }.instrument(span))
  }
}

/// One identity for an output root however it is spelled: relative or
/// absolute, through `.` and `..`, or through a symlinked ancestor (a
/// `target` link to another disk). The longest proper ancestor that exists
/// is resolved and the rest is appended lexically. The root itself is never
/// resolved: every build deletes and recreates it, and its key must not
/// change when it does. Webapps cache the result (`Webapp::beta_output_key`),
/// so one webapp keeps one slot even if an ancestor appears later.
pub(crate) fn stable_output_key(root: &Path) -> PathBuf {
  stable_output_key_in(root, std::env::current_dir().ok().as_deref())
}

fn stable_output_key_in(root: &Path, cwd: Option<&Path>) -> PathBuf {
  let absolute = match cwd {
    Some(cwd) if root.is_relative() => cwd.join(root),
    _ => root.to_path_buf(),
  };
  let components: Vec<Component> = absolute
    .components()
    .filter(|c| *c != Component::CurDir)
    .collect();
  for split in (1..components.len()).rev() {
    let ancestor: PathBuf = components[..split].iter().collect();
    let Ok(mut key) = ancestor.canonicalize() else {
      continue;
    };
    // What is left does not exist (or is the root itself), so it holds no
    // symlink for `..` to step back through.
    for component in &components[split..] {
      match component {
        Component::ParentDir => {
          key.pop();
        }
        other => key.push(other),
      }
    }
    return key;
  }
  normalize_lexically(&absolute)
}

fn normalize_lexically(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for component in path.components() {
    match component {
      Component::CurDir => {}
      Component::ParentDir => {
        if !out.pop() {
          out.push("..");
        }
      }
      other => out.push(other),
    }
  }
  out
}

/// `TENTO_WEB_BUILD_CONCURRENCY` overrides how many output roots build at
/// once in dev; it must be a positive integer.
pub(crate) const BUILD_CONCURRENCY_ENV: &str = "TENTO_WEB_BUILD_CONCURRENCY";

/// How many output roots may build at once: the env override, else a quarter
/// of the cores clamped to 1..=4. Small on purpose — the per-file emitter
/// blocks a runtime worker while its child process runs, and the server
/// keeps answering requests on the remaining workers.
pub(crate) fn build_concurrency() -> usize {
  let cores = std::thread::available_parallelism()
    .map(|n| n.get())
    .unwrap_or(1);
  concurrency_from(std::env::var(BUILD_CONCURRENCY_ENV).ok().as_deref(), cores)
}

fn concurrency_from(env: Option<&str>, cores: usize) -> usize {
  if let Some(n) = env
    .and_then(|v| v.trim().parse::<usize>().ok())
    .filter(|n| *n > 0)
  {
    return n;
  }
  (cores / 4).clamp(1, 4)
}

/// What one slot run did: the jobs it built, in order, and the ones that
/// failed with their error.
#[derive(Debug, Clone)]
pub(crate) struct SlotRun {
  pub key: PathBuf,
  pub built: Vec<String>,
  pub failed: Vec<(String, String)>,
  pub elapsed: Duration,
}

/// Called after every build with the job, whether it succeeded and when it
/// started; returning `true` asks for one more build of that job.
pub(crate) type AfterBuild<J> = Arc<dyn Fn(&Arc<J>, bool, SystemTime) -> bool + Send + Sync>;

/// Hands build requests to the scheduler task. Cheap to clone; `request` is
/// synchronous and never blocks, so the debouncer thread can call it.
pub(crate) struct BuildScheduler<J: BuildJob> {
  tx: mpsc::UnboundedSender<Vec<Arc<J>>>,
}

impl<J: BuildJob> Clone for BuildScheduler<J> {
  fn clone(&self) -> Self {
    BuildScheduler {
      tx: self.tx.clone(),
    }
  }
}

impl<J: BuildJob> BuildScheduler<J> {
  /// Starts the scheduler task on the current tokio runtime, logging every
  /// slot run and calling `after` after every build. It runs until every
  /// handle is dropped and the remaining work has drained.
  pub fn spawn_after(
    limit: usize,
    after: impl Fn(&Arc<J>, bool, SystemTime) -> bool + Send + Sync + 'static,
  ) -> Self {
    Self::spawn_with(limit, log_slot_run, Arc::new(after))
  }

  /// As `spawn_after`, calling `on_run` after every slot run instead of
  /// logging it.
  pub fn spawn_with(
    limit: usize,
    on_run: impl Fn(&SlotRun) + Send + 'static,
    after: AfterBuild<J>,
  ) -> Self {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(schedule(rx, limit.max(1), on_run, after));
    BuildScheduler { tx }
  }

  /// Asks for these jobs to be built. Returns false only when the scheduler
  /// task has stopped.
  pub fn request(&self, jobs: Vec<Arc<J>>) -> bool {
    jobs.is_empty() || self.tx.send(jobs).is_ok()
  }
}

fn log_slot_run(run: &SlotRun) {
  for (label, err) in &run.failed {
    error!("build/failed [{label}]: {err}");
  }
  info!(
    "build/slot done in {} ms: built [{}], failed {} ({})",
    run.elapsed.as_millis(),
    run.built.join(", "),
    run.failed.len(),
    run.key.display()
  );
}

struct Slot<J> {
  pending: Vec<Arc<J>>,
  running: bool,
  queued: bool,
}

impl<J> Default for Slot<J> {
  fn default() -> Self {
    Slot {
      pending: vec![],
      running: false,
      queued: false,
    }
  }
}

async fn schedule<J: BuildJob>(
  mut rx: mpsc::UnboundedReceiver<Vec<Arc<J>>>,
  limit: usize,
  on_run: impl Fn(&SlotRun),
  after: AfterBuild<J>,
) {
  let mut slots: HashMap<PathBuf, Slot<J>> = HashMap::new();
  let mut ready: VecDeque<PathBuf> = VecDeque::new();
  let mut running: JoinSet<(SlotRun, Vec<Arc<J>>)> = JoinSet::new();
  let mut open = true;

  loop {
    while running.len() < limit {
      let Some(key) = ready.pop_front() else { break };
      let slot = slots.get_mut(&key).expect("a queued slot exists");
      slot.queued = false;
      slot.running = true;
      let jobs = std::mem::take(&mut slot.pending);
      running.spawn(run_slot(key, jobs, after.clone()));
    }

    if !open && running.is_empty() && ready.is_empty() {
      return;
    }

    tokio::select! {
      batch = rx.recv(), if open => match batch {
        Some(jobs) => {
          for job in jobs {
            enqueue(&mut slots, &mut ready, job);
          }
        }
        None => open = false,
      },
      Some(done) = running.join_next(), if !running.is_empty() => {
        // `run_slot` never panics (each build runs in its own task), so a
        // join error is runtime shutdown; there is nothing left to schedule.
        let Ok((run, again)) = done else { return };
        on_run(&run);
        let slot = slots.get_mut(&run.key).expect("a running slot exists");
        slot.running = false;
        for job in again {
          if !slot.pending.iter().any(|p| Arc::ptr_eq(p, &job)) {
            slot.pending.push(job);
          }
        }
        if slot.pending.is_empty() {
          slots.remove(&run.key);
        } else {
          slot.queued = true;
          ready.push_back(run.key);
        }
      }
    }
  }
}

fn enqueue<J: BuildJob>(
  slots: &mut HashMap<PathBuf, Slot<J>>,
  ready: &mut VecDeque<PathBuf>,
  job: Arc<J>,
) {
  let key = job.output_key();
  let slot = slots.entry(key.clone()).or_default();
  if !slot.pending.iter().any(|p| Arc::ptr_eq(p, &job)) {
    slot.pending.push(job);
  }
  if !slot.running && !slot.queued {
    slot.queued = true;
    ready.push_back(key);
  }
}

/// Builds one slot's jobs in order, returning the run and the jobs `after`
/// asked to build again. Each build runs in its own task so a panic is
/// reported as that job's failure instead of wedging the slot, and a
/// panicking `after` counts as "no".
async fn run_slot<J: BuildJob>(
  key: PathBuf,
  jobs: Vec<Arc<J>>,
  after: AfterBuild<J>,
) -> (SlotRun, Vec<Arc<J>>) {
  let started = Instant::now();
  let mut built = vec![];
  let mut failed = vec![];
  let mut again = vec![];
  for job in jobs {
    let label = job.label();
    let build_started = SystemTime::now();
    let result = run_one(job.clone()).await;
    let ok = result.is_ok();
    let more = std::panic::catch_unwind(AssertUnwindSafe(|| after(&job, ok, build_started)))
      .unwrap_or_else(|_| {
        error!("build/after-build hook panicked [{label}]");
        false
      });
    if more {
      info!("build/again [{label}]: an input changed while it built");
      again.push(job);
    }
    match result {
      Ok(()) => built.push(label),
      Err(e) => failed.push((label, e)),
    }
  }
  (
    SlotRun {
      key,
      built,
      failed,
      elapsed: started.elapsed(),
    },
    again,
  )
}

async fn run_one<J: BuildJob>(job: Arc<J>) -> Result<(), String> {
  match tokio::spawn(job.build()).await {
    Ok(Ok(())) => Ok(()),
    Ok(Err(e)) => Err(format!("{e:#}")),
    Err(join) => Err(format!("build task panicked: {join}")),
  }
}

/// Runs `step` once for every job: jobs sharing an output root in order,
/// one after another, and at most `limit` roots at a time. Returns each
/// job's label and result in input order. This is the startup build's
/// replacement for an unbounded `join_all`.
pub(crate) async fn run_grouped<J, F>(
  jobs: impl IntoIterator<Item = Arc<J>>,
  limit: usize,
  step: F,
) -> Vec<(String, anyhow::Result<()>)>
where
  J: BuildJob,
  F: Fn(Arc<J>) -> BuildFuture + Send + Sync + 'static,
{
  let mut order: Vec<PathBuf> = vec![];
  let mut groups: HashMap<PathBuf, Vec<(usize, Arc<J>)>> = HashMap::new();
  let mut count = 0;
  for (i, job) in jobs.into_iter().enumerate() {
    count += 1;
    let key = job.output_key();
    if !groups.contains_key(&key) {
      order.push(key.clone());
    }
    groups.entry(key).or_default().push((i, job));
  }

  let permits = Arc::new(Semaphore::new(limit.max(1)));
  let step = Arc::new(step);
  let mut tasks: JoinSet<Vec<(usize, String, anyhow::Result<()>)>> = JoinSet::new();
  for key in order {
    let group = groups.remove(&key).expect("grouped key");
    let permits = permits.clone();
    let step = step.clone();
    tasks.spawn(async move {
      let _permit = permits.acquire_owned().await.expect("semaphore open");
      let mut results = vec![];
      for (i, job) in group {
        let label = job.label();
        let result = match tokio::spawn(step(job)).await {
          Ok(r) => r,
          Err(join) => Err(anyhow::anyhow!("build task panicked: {join}")),
        };
        results.push((i, label, result));
      }
      results
    });
  }

  let mut slots: Vec<Option<(String, anyhow::Result<()>)>> = (0..count).map(|_| None).collect();
  while let Some(done) = tasks.join_next().await {
    // Each group task only awaits spawned work, so it cannot panic itself.
    for (i, label, result) in done.expect("group task") {
      slots[i] = Some((label, result));
    }
  }
  slots
    .into_iter()
    .map(|s| s.expect("every job reported"))
    .collect()
}

#[cfg(test)]
mod tests {
  use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
  };

  use tokio::sync::{Notify, mpsc::UnboundedReceiver};

  use super::*;

  /// A fake build that records when it starts and ends, can be held open on
  /// a gate, and can be told to fail.
  struct Job {
    name: &'static str,
    key: &'static str,
    log: Arc<Log>,
    gate: Option<Arc<Notify>>,
    fail: bool,
    hold: Duration,
  }

  #[derive(Default)]
  struct Log {
    events: Mutex<Vec<String>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    active_by_key: Mutex<HashMap<&'static str, usize>>,
    key_overlap: AtomicUsize,
  }

  impl Log {
    fn builds_of(&self, name: &str) -> usize {
      let start = format!("start {name}");
      self
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == start)
        .count()
    }
  }

  impl BuildJob for Job {
    fn output_key(&self) -> PathBuf {
      PathBuf::from(self.key)
    }
    fn label(&self) -> String {
      self.name.to_string()
    }
    fn build(self: Arc<Self>) -> BuildFuture {
      Box::pin(async move {
        let log = &self.log;
        log
          .events
          .lock()
          .unwrap()
          .push(format!("start {}", self.name));
        let now = log.active.fetch_add(1, Ordering::SeqCst) + 1;
        log.peak.fetch_max(now, Ordering::SeqCst);
        {
          let mut by_key = log.active_by_key.lock().unwrap();
          let n = by_key.entry(self.key).or_default();
          *n += 1;
          if *n > 1 {
            log.key_overlap.fetch_add(1, Ordering::SeqCst);
          }
        }
        if let Some(gate) = &self.gate {
          gate.notified().await;
        }
        tokio::time::sleep(self.hold).await;
        *log.active_by_key.lock().unwrap().get_mut(self.key).unwrap() -= 1;
        log.active.fetch_sub(1, Ordering::SeqCst);
        log
          .events
          .lock()
          .unwrap()
          .push(format!("end {}", self.name));
        if self.fail {
          anyhow::bail!("{} failed", self.name);
        }
        Ok(())
      })
    }
  }

  fn job(name: &'static str, key: &'static str, log: &Arc<Log>) -> Job {
    Job {
      name,
      key,
      log: log.clone(),
      gate: None,
      fail: false,
      hold: Duration::from_millis(5),
    }
  }

  fn scheduler(limit: usize) -> (BuildScheduler<Job>, UnboundedReceiver<SlotRun>) {
    scheduler_after(limit, Arc::new(|_: &Arc<Job>, _, _| false))
  }

  fn scheduler_after(
    limit: usize,
    after: AfterBuild<Job>,
  ) -> (BuildScheduler<Job>, UnboundedReceiver<SlotRun>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let s = BuildScheduler::spawn_with(
      limit,
      move |run: &SlotRun| {
        let _ = tx.send(run.clone());
      },
      after,
    );
    (s, rx)
  }

  async fn next(rx: &mut UnboundedReceiver<SlotRun>) -> SlotRun {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
      .await
      .expect("a slot run within 5 s")
      .expect("scheduler alive")
  }

  async fn wait_started(log: &Log, name: &str) {
    for _ in 0..500 {
      if log.builds_of(name) > 0 {
        return;
      }
      tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("{name} never started");
  }

  async fn assert_quiet(rx: &mut UnboundedReceiver<SlotRun>) {
    let extra = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(extra.is_err(), "no further slot runs, got {extra:?}");
  }

  /// O04: a burst of 27 debounced batches that arrive while the build runs
  /// becomes exactly one follow-up build, not 27.
  #[tokio::test]
  async fn a_burst_during_a_build_becomes_one_follow_up() {
    let log = Arc::new(Log::default());
    let gate = Arc::new(Notify::new());
    let app = Arc::new(Job {
      gate: Some(gate.clone()),
      ..job("app", "/out/app", &log)
    });
    let (s, mut rx) = scheduler(2);

    s.request(vec![app.clone()]);
    wait_started(&log, "app").await;
    for _ in 0..27 {
      s.request(vec![app.clone()]);
    }
    gate.notify_one();
    assert_eq!(next(&mut rx).await.built, vec!["app"]);
    gate.notify_one();
    assert_eq!(next(&mut rx).await.built, vec!["app"]);
    assert_quiet(&mut rx).await;
    assert_eq!(log.builds_of("app"), 2, "1 build + 1 merged follow-up");
  }

  /// O04: a request that lands mid-build is not lost: the follow-up starts
  /// after the running build ended, and it includes every webapp that asked,
  /// even ones that were not part of the running build.
  #[tokio::test]
  async fn requests_during_a_build_are_built_after_it_not_dropped() {
    let log = Arc::new(Log::default());
    let gate = Arc::new(Notify::new());
    let a = Arc::new(Job {
      gate: Some(gate.clone()),
      ..job("a", "/out/shared", &log)
    });
    let alias = Arc::new(job("alias", "/out/shared", &log));
    let (s, mut rx) = scheduler(4);

    s.request(vec![a.clone()]);
    wait_started(&log, "a").await;
    s.request(vec![alias.clone()]);
    s.request(vec![a.clone(), alias.clone()]);
    gate.notify_one();
    assert_eq!(next(&mut rx).await.built, vec!["a"]);
    gate.notify_one();
    let follow_up = next(&mut rx).await;
    assert_eq!(follow_up.built, vec!["alias", "a"], "first-request order");
    assert_quiet(&mut rx).await;

    let events = log.events.lock().unwrap().clone();
    let end_a = events.iter().position(|e| e == "end a").unwrap();
    let start_alias = events.iter().position(|e| e == "start alias").unwrap();
    assert!(
      start_alias > end_a,
      "the follow-up starts after the build: {events:?}"
    );
  }

  /// O05: independent output roots build concurrently, never more than the
  /// limit at once, and every one completes.
  #[tokio::test]
  async fn independent_roots_build_concurrently_up_to_the_limit() {
    let log = Arc::new(Log::default());
    let jobs: Vec<Arc<Job>> = [
      ("a", "/out/a"),
      ("b", "/out/b"),
      ("c", "/out/c"),
      ("d", "/out/d"),
    ]
    .into_iter()
    .map(|(n, k)| {
      Arc::new(Job {
        hold: Duration::from_millis(60),
        ..job(n, k, &log)
      })
    })
    .collect();
    let (s, mut rx) = scheduler(2);

    s.request(jobs.clone());
    let mut built: Vec<String> = vec![];
    for _ in 0..4 {
      built.extend(next(&mut rx).await.built);
    }
    built.sort();
    assert_eq!(built, vec!["a", "b", "c", "d"]);
    assert_eq!(log.peak.load(Ordering::SeqCst), 2, "bounded at the limit");
  }

  /// O05: two webapps (aliases) writing the same output root never overlap,
  /// even with spare concurrency, and both build.
  #[tokio::test]
  async fn aliases_sharing_an_output_root_never_overlap() {
    let log = Arc::new(Log::default());
    let a = Arc::new(Job {
      hold: Duration::from_millis(40),
      ..job("a", "/out/shared", &log)
    });
    let b = Arc::new(Job {
      hold: Duration::from_millis(40),
      ..job("b", "/out/shared", &log)
    });
    let other = Arc::new(Job {
      hold: Duration::from_millis(40),
      ..job("other", "/out/other", &log)
    });
    let (s, mut rx) = scheduler(4);

    s.request(vec![a, b, other]);
    let mut runs = vec![next(&mut rx).await, next(&mut rx).await];
    runs.sort_by_key(|r| r.key.clone());
    assert_eq!(runs[0].built, vec!["other"]);
    assert_eq!(runs[1].built, vec!["a", "b"], "one slot, serial");
    assert_eq!(log.key_overlap.load(Ordering::SeqCst), 0);
    assert_eq!(
      log.peak.load(Ordering::SeqCst),
      2,
      "the other root overlapped"
    );
  }

  /// A failing build is reported, does not stop the other jobs in its slot
  /// or other slots, and the next request for it builds again.
  #[tokio::test]
  async fn a_failure_is_reported_and_isolated() {
    let log = Arc::new(Log::default());
    let broken = Arc::new(Job {
      fail: true,
      ..job("broken", "/out/shared", &log)
    });
    let alias = Arc::new(job("alias", "/out/shared", &log));
    let other = Arc::new(job("other", "/out/other", &log));
    let (s, mut rx) = scheduler(2);

    s.request(vec![broken.clone(), alias, other]);
    let mut runs = vec![next(&mut rx).await, next(&mut rx).await];
    runs.sort_by_key(|r| r.key.clone());
    assert_eq!(runs[0].built, vec!["other"]);
    assert_eq!(runs[1].built, vec!["alias"]);
    assert_eq!(runs[1].failed.len(), 1);
    assert!(runs[1].failed[0].1.contains("broken failed"));

    s.request(vec![broken]);
    assert_eq!(
      next(&mut rx).await.failed.len(),
      1,
      "retried on the next edit"
    );
  }

  /// A request for a root that is queued (waiting for a permit) merges into
  /// that queued run instead of adding another.
  #[tokio::test]
  async fn requests_for_a_queued_root_merge_into_its_run() {
    let log = Arc::new(Log::default());
    let gate = Arc::new(Notify::new());
    let busy = Arc::new(Job {
      gate: Some(gate.clone()),
      ..job("busy", "/out/busy", &log)
    });
    let waiting = Arc::new(job("waiting", "/out/waiting", &log));
    let (s, mut rx) = scheduler(1);

    s.request(vec![busy]);
    wait_started(&log, "busy").await;
    for _ in 0..5 {
      s.request(vec![waiting.clone()]);
    }
    gate.notify_one();
    assert_eq!(next(&mut rx).await.built, vec!["busy"]);
    assert_eq!(next(&mut rx).await.built, vec!["waiting"]);
    assert_quiet(&mut rx).await;
    assert_eq!(log.builds_of("waiting"), 1);
  }

  /// The startup runner keeps input order in its report, serialises a
  /// shared root, bounds concurrency and reports every failure.
  #[tokio::test]
  async fn run_grouped_bounds_serialises_and_reports() {
    let log = Arc::new(Log::default());
    let jobs = vec![
      Arc::new(Job {
        hold: Duration::from_millis(30),
        ..job("a", "/out/a", &log)
      }),
      Arc::new(Job {
        hold: Duration::from_millis(30),
        fail: true,
        ..job("alias", "/out/a", &log)
      }),
      Arc::new(Job {
        hold: Duration::from_millis(30),
        ..job("b", "/out/b", &log)
      }),
      Arc::new(Job {
        hold: Duration::from_millis(30),
        ..job("c", "/out/c", &log)
      }),
    ];
    let results = run_grouped(jobs, 2, |j: Arc<Job>| j.build()).await;
    let labels: Vec<&str> = results.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(labels, vec!["a", "alias", "b", "c"]);
    let failed: Vec<&str> = results
      .iter()
      .filter(|(_, r)| r.is_err())
      .map(|(l, _)| l.as_str())
      .collect();
    assert_eq!(failed, vec!["alias"]);
    assert_eq!(log.key_overlap.load(Ordering::SeqCst), 0);
    assert!(log.peak.load(Ordering::SeqCst) <= 2);
  }

  #[test]
  fn concurrency_defaults_to_a_quarter_of_cores_clamped() {
    assert_eq!(concurrency_from(None, 1), 1);
    assert_eq!(concurrency_from(None, 8), 2);
    assert_eq!(concurrency_from(None, 20), 4);
    assert_eq!(concurrency_from(None, 64), 4);
    assert_eq!(concurrency_from(Some("7"), 4), 7);
    assert_eq!(concurrency_from(Some("0"), 8), 2, "zero is not a limit");
    assert_eq!(concurrency_from(Some("many"), 8), 2);
  }

  /// The after-build hook sees every build with its outcome and start
  /// time; `true` builds that job once more, after the build that asked,
  /// and a panicking hook is a "no", not a dead scheduler.
  #[tokio::test]
  async fn the_after_build_hook_can_ask_for_one_more_build() {
    let log = Arc::new(Log::default());
    let app = Arc::new(job("app", "/out/app", &log));
    let broken = Arc::new(Job {
      fail: true,
      ..job("broken", "/out/broken", &log)
    });
    let seen: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
    let before = SystemTime::now();
    let after: AfterBuild<Job> = {
      let seen = seen.clone();
      Arc::new(move |job: &Arc<Job>, ok, started| {
        assert!(started >= before);
        let first_app = {
          let mut seen = seen.lock().unwrap();
          seen.push((job.name.to_string(), ok));
          job.name == "app" && seen.iter().filter(|(n, _)| n == "app").count() == 1
        };
        if job.name == "broken" {
          panic!("hook bug");
        }
        first_app
      })
    };
    let (s, mut rx) = scheduler_after(2, after);

    s.request(vec![app.clone(), broken]);
    let mut runs = vec![
      next(&mut rx).await,
      next(&mut rx).await,
      next(&mut rx).await,
    ];
    runs.sort_by_key(|r| (r.key.clone(), r.built.len()));
    let app_runs: Vec<_> = runs
      .iter()
      .filter(|r| r.key == Path::new("/out/app"))
      .collect();
    assert_eq!(app_runs.len(), 2, "built once more");
    assert!(app_runs.iter().all(|r| r.built == vec!["app"]));
    let broken_run = runs
      .iter()
      .find(|r| r.key == Path::new("/out/broken"))
      .unwrap();
    assert_eq!(broken_run.failed.len(), 1);
    assert_quiet(&mut rx).await;
    assert_eq!(log.builds_of("app"), 2);
    let mut seen = seen.lock().unwrap().clone();
    seen.sort();
    assert_eq!(
      seen,
      vec![
        ("app".to_string(), true),
        ("app".to_string(), true),
        ("broken".to_string(), false),
      ]
    );

    s.request(vec![app]);
    assert_eq!(next(&mut rx).await.built, vec!["app"], "still scheduling");
  }

  #[test]
  fn output_keys_name_one_root_however_it_is_spelled() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    std::fs::create_dir_all(base.join("disk/target.web.beta")).unwrap();
    let want = base.join("disk/target.web.beta/app");
    let key = |p: &str| stable_output_key_in(&base.join(p), None);

    assert_eq!(key("disk/target.web.beta/app"), want);
    assert_eq!(key("disk/./target.web.beta/app"), want);
    assert_eq!(key("disk/target.web.beta/../target.web.beta/app"), want);
    assert_eq!(
      stable_output_key_in(Path::new("disk/target.web.beta/app"), Some(&base)),
      want,
      "relative to the working directory"
    );
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(base.join("disk"), base.join("target")).unwrap();
      assert_eq!(
        key("target/target.web.beta/app"),
        want,
        "symlinked ancestor"
      );
      assert_eq!(
        key("target/../disk/target.web.beta/app"),
        want,
        "`..` after a symlink resolved as the OS does"
      );
      assert_eq!(
        key("target/target.web.missing/app"),
        base.join("disk/target.web.missing/app"),
        "a missing stage directory still resolves through the link"
      );
    }

    // The root coming and going (a clean) never moves its key.
    let absent = key("disk/target.web.beta/app");
    std::fs::create_dir_all(&want).unwrap();
    assert_eq!(key("disk/target.web.beta/app"), absent);
    std::fs::remove_dir_all(&want).unwrap();
    assert_eq!(key("disk/target.web.beta/app"), absent);
    assert_eq!(
      normalize_lexically(Path::new("/r/./target.web.beta/../target.web.beta/app")),
      PathBuf::from("/r/target.web.beta/app")
    );
  }
}
