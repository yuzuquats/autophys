//! Process-wide exclusion between owned I/O and no-exec shell forks.
//!
//! Acquire a live token before constructor effects and retain it until payload
//! cleanup finishes. Reserve each forking command before its own effects. Neither
//! acquisition waits for the other kind of authority to finish: it returns an
//! error instead. The mutex protects accounting only and is a leaf lock.
use std::{
  collections::BTreeMap,
  fmt,
  sync::{Arc, Mutex, MutexGuard},
};

static GATE: Gate = Gate::new();

struct Gate {
  state: Mutex<State>,
}

struct State {
  epoch: u64,
  next_id: u64,
  live: BTreeMap<u64, Arc<str>>,
  reserved: BTreeMap<u64, Arc<str>>,
}

impl Gate {
  const fn new() -> Self {
    Self {
      state: Mutex::new(State {
        epoch: 0,
        next_id: 0,
        live: BTreeMap::new(),
        reserved: BTreeMap::new(),
      }),
    }
  }

  fn acquire(&'static self, kind: Kind, owner: Arc<str>) -> Result<Lease, GateError> {
    let mut state = self.state.lock().map_err(|_| GateError::Unavailable)?;
    let conflicts = match kind {
      Kind::Live => &state.reserved,
      Kind::Reservation => &state.live,
    };
    if !conflicts.is_empty() {
      let owners = conflicts.values().cloned().collect();
      return Err(match kind {
        Kind::Live => GateError::Busy(owners),
        Kind::Reservation => GateError::LiveIo(owners),
      });
    }
    let id = state.next_id;
    state.next_id = id.checked_add(1).ok_or(GateError::Unavailable)?;
    let epoch = state.epoch;
    match kind {
      Kind::Live => state.live.insert(id, owner),
      Kind::Reservation => state.reserved.insert(id, owner),
    };
    Ok(Lease {
      gate: self,
      id,
      epoch,
      pid: std::process::id(),
      kind,
    })
  }

  fn ensure_idle(&self) -> Result<(), GateError> {
    let state = self.state.lock().map_err(|_| GateError::Unavailable)?;
    if !state.live.is_empty() {
      return Err(GateError::LiveIo(state.live.values().cloned().collect()));
    }
    if !state.reserved.is_empty() {
      return Err(GateError::Busy(state.reserved.values().cloned().collect()));
    }
    Ok(())
  }
}

/// For a fork made outside the shell's reservations, such as daemonize
/// before any runtime exists: refuse while owned I/O or fork preparation is
/// live in this process, naming the owners.
pub fn ensure_idle() -> Result<(), GateError> {
  GATE.ensure_idle()
}

#[derive(Clone, Copy)]
enum Kind {
  Live,
  Reservation,
}

struct Lease {
  gate: &'static Gate,
  id: u64,
  epoch: u64,
  pid: u32,
  kind: Kind,
}

impl Drop for Lease {
  fn drop(&mut self) {
    // A missed fork seam must not touch a possibly inherited locked mutex.
    if self.pid != std::process::id() {
      return;
    }
    // Poison is fail-closed: retain accounting rather than admit an unsafe fork.
    let Ok(mut state) = self.gate.state.lock() else {
      return;
    };
    if state.epoch != self.epoch {
      return;
    }
    match self.kind {
      Kind::Live => {
        state.live.remove(&self.id);
      }
      Kind::Reservation => {
        state.reserved.remove(&self.id);
      }
    }
  }
}

/// Distinct diagnostics for the two directions of process-wide exclusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
  Busy(Vec<Arc<str>>),
  LiveIo(Vec<Arc<str>>),
  Inherited,
  Unavailable,
}

impl fmt::Display for GateError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let owners = match self {
      Self::Busy(owners) => {
        f.write_str("owned I/O busy: shell fork preparation in progress")?;
        owners
      }
      Self::LiveIo(owners) => {
        f.write_str("owned I/O prevents shell fork in this process; close live owned handles in this host or another host/job")?;
        owners
      }
      Self::Inherited => return f.write_str("owned I/O authority belongs to another process"),
      Self::Unavailable => return f.write_str("owned I/O process gate is unavailable"),
    };
    for (i, owner) in owners.iter().enumerate() {
      f.write_str(if i == 0 { ": " } else { ", " })?;
      f.write_str(owner)?;
    }
    Ok(())
  }
}
impl std::error::Error for GateError {}

/// Keep this inside the owned payload, after fields whose cleanup it protects.
/// Moving a resource moves its token; aliases do not acquire additional tokens.
#[must_use = "a live-I/O token protects its payload only while it is held"]
pub struct LiveIo(Lease);
impl LiveIo {
  pub fn acquire(owner: impl Into<Arc<str>>) -> Result<Self, GateError> {
    GATE.acquire(Kind::Live, owner.into()).map(Self)
  }

  /// Check before operating a payload or running its destructive cleanup.
  pub fn check_process(&self) -> Result<(), GateError> {
    if self.0.pid == std::process::id() {
      Ok(())
    } else {
      Err(GateError::Inherited)
    }
  }
}

/// Permission held across a command's own preparation, not its execution.
/// Reservations nest: while one exists no live token can be acquired.
#[must_use = "a fork reservation covers preparation only while it is held"]
pub struct ForkReservation(Lease);
impl ForkReservation {
  pub fn acquire(owner: impl Into<Arc<str>>) -> Result<Self, GateError> {
    GATE.acquire(Kind::Reservation, owner.into()).map(Self)
  }

  /// Acquire LAST after stdout/stderr/job locks. Hold across fork, then drop in
  /// both processes. The child must first call reset_after_fork_in_child().
  pub fn lock_for_fork(&self) -> Result<ForkPermit<'_>, GateError> {
    if self.0.pid != std::process::id() {
      return Err(GateError::Inherited);
    }
    let state = self
      .0
      .gate
      .state
      .lock()
      .map_err(|_| GateError::Unavailable)?;
    if state.epoch != self.0.epoch
      || !state.reserved.contains_key(&self.0.id)
      || !state.live.is_empty()
    {
      return Err(GateError::Unavailable);
    }
    Ok(ForkPermit {
      state,
      parent_pid: self.0.pid,
    })
  }
}

/// Leaf mutex guard. Never call host code or acquire other locks while held.
#[must_use = "a fork permit serializes the fork only while it is held"]
pub struct ForkPermit<'a> {
  state: MutexGuard<'a, State>,
  parent_pid: u32,
}
impl ForkPermit<'_> {
  /// Reset copied accounting while the child still owns the fork mutex.
  /// Copied guards subsequently drop without modifying the child's new epoch.
  ///
  /// # Safety
  /// Call only in the child immediately after a successful no-exec fork made
  /// while holding this permit, before releasing it or using the copied host.
  pub unsafe fn reset_after_fork_in_child(&mut self) {
    assert_ne!(
      std::process::id(),
      self.parent_pid,
      "fork reset called in parent"
    );
    self.reset_epoch();
  }

  fn reset_epoch(&mut self) {
    self.state.epoch = self
      .state
      .epoch
      .checked_add(1)
      .expect("fork epoch exhausted");
    self.state.live.clear();
    self.state.reserved.clear();
    self.state.next_id = 0;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  fn gate() -> &'static Gate {
    Box::leak(Box::new(Gate::new()))
  }
  fn live(gate: &'static Gate) -> Result<LiveIo, GateError> {
    gate.acquire(Kind::Live, "reader host".into()).map(LiveIo)
  }
  fn reserve(gate: &'static Gate) -> Result<ForkReservation, GateError> {
    gate
      .acquire(Kind::Reservation, "shell host".into())
      .map(ForkReservation)
  }

  #[test]
  fn mutual_exclusion_nesting_and_release() {
    let gate = gate();
    let a = live(gate).unwrap();
    let b = live(gate).unwrap();
    assert!(matches!(reserve(gate), Err(GateError::LiveIo(_))));
    drop(a);
    assert!(reserve(gate).is_err());
    drop(b);
    let outer = reserve(gate).unwrap();
    let inner = reserve(gate).unwrap();
    assert!(matches!(live(gate), Err(GateError::Busy(_))));
    drop(outer);
    assert!(live(gate).is_err());
    drop(inner);
    assert!(live(gate).unwrap().check_process().is_ok());
  }

  #[test]
  fn copied_guards_cannot_remove_new_epoch_entries() {
    let gate = gate();
    let old = reserve(gate).unwrap();
    let mut permit = old.lock_for_fork().unwrap();
    // Simulate only the accounting reset, without changing process identity.
    permit.reset_epoch();
    drop(permit);
    let new = reserve(gate).unwrap(); // reuses id zero in the new epoch
    drop(old);
    assert!(live(gate).is_err());
    drop(new);
    assert!(live(gate).is_ok());
  }

  #[test]
  fn cross_thread_construction_and_reservation_never_overlap() {
    let gate = gate();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let other_barrier = barrier.clone();
    let other = std::thread::spawn(move || {
      for _ in 0..500 {
        other_barrier.wait();
        let token = live(gate);
        other_barrier.wait();
        if token.is_ok() {
          assert!(gate.state.lock().unwrap().reserved.is_empty());
        }
        drop(token);
        other_barrier.wait();
      }
    });
    for _ in 0..500 {
      barrier.wait();
      let reservation = reserve(gate);
      barrier.wait();
      if let Ok(ref reservation) = reservation {
        assert!(reservation.lock_for_fork().unwrap().state.live.is_empty());
      }
      drop(reservation);
      barrier.wait();
    }
    other.join().unwrap();
    assert!(gate.state.lock().unwrap().live.is_empty());
    assert!(gate.state.lock().unwrap().reserved.is_empty());
  }

  #[test]
  fn inherited_lease_drop_does_not_touch_accounting() {
    let gate = gate();
    let mut token = live(gate).unwrap();
    token.0.pid = std::process::id().wrapping_add(1);
    assert_eq!(token.check_process(), Err(GateError::Inherited));
    drop(token);
    assert!(reserve(gate).is_err());
  }

  #[test]
  fn idle_names_whichever_authority_is_live() {
    let gate = gate();
    assert_eq!(gate.ensure_idle(), Ok(()));
    let token = live(gate).unwrap();
    assert_eq!(
      gate.ensure_idle(),
      Err(GateError::LiveIo(vec!["reader host".into()]))
    );
    drop(token);
    let reservation = reserve(gate).unwrap();
    assert_eq!(
      gate.ensure_idle(),
      Err(GateError::Busy(vec!["shell host".into()]))
    );
    drop(reservation);
    assert_eq!(gate.ensure_idle(), Ok(()));
  }

  /// A real fork while holding the permit: the child resets under the copied
  /// mutex, its copied guards are inert, and new authority works there. The
  /// parent's accounting is untouched. The child runs only gate calls and
  /// reports through its exit status; waits are bounded.
  #[cfg(unix)]
  #[test]
  fn a_real_fork_resets_the_child_epoch_and_keeps_the_parent_accounting() {
    // SAFETY: the C library's own declarations (pid_t and int are i32 on
    // the supported Unix targets); tento-lisp does not depend on libc.
    unsafe extern "C" {
      fn fork() -> i32;
      fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
      fn kill(pid: i32, signal: i32) -> i32;
      fn _exit(status: i32) -> !;
    }
    const WNOHANG: i32 = 1;
    const SIGKILL: i32 = 9;
    let gate = gate();
    let outer = reserve(gate).unwrap();
    let nested = reserve(gate).unwrap();
    let permit = nested.lock_for_fork().unwrap();
    // SAFETY: the child touches only this test's gate and exits with _exit.
    let pid = unsafe { fork() };
    assert!(pid >= 0, "fork failed");
    if pid == 0 {
      let mut permit = permit;
      // SAFETY: this is the child of the fork made while holding `permit`.
      unsafe { permit.reset_after_fork_in_child() };
      drop(permit);
      // Copies of the parent's reservations: dropping them changes nothing.
      drop(nested);
      drop(outer);
      let code = match live(gate) {
        Ok(token) => {
          let refused = matches!(reserve(gate), Err(GateError::LiveIo(_)));
          let owned_here = token.check_process().is_ok();
          drop(token);
          let idle = gate.ensure_idle().is_ok();
          if refused && owned_here && idle { 0 } else { 2 }
        }
        Err(_) => 3,
      };
      // SAFETY: end the forked test child without running the parent's code.
      unsafe { _exit(code) };
    }
    drop(permit);
    // The child's new epoch did not release the parent's reservations.
    assert!(matches!(live(gate), Err(GateError::Busy(_))));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut status = 0;
    loop {
      // SAFETY: waits only for the child this test forked.
      let waited = unsafe { waitpid(pid, &mut status, WNOHANG) };
      if waited == pid {
        break;
      }
      assert!(waited == 0, "waitpid failed");
      if std::time::Instant::now() > deadline {
        // SAFETY: kill and reap only this test's stuck child.
        unsafe {
          kill(pid, SIGKILL);
          waitpid(pid, &mut status, 0);
        }
        panic!("forked gate child timed out");
      }
      std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(status & 0x7f, 0, "child ended by a signal: {status}");
    assert_eq!((status >> 8) & 0xff, 0, "child gate check failed: {status}");
    drop(nested);
    assert!(live(gate).is_err(), "the outer reservation is still held");
    drop(outer);
    assert_eq!(gate.ensure_idle(), Ok(()));
  }
}
