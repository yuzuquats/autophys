//! Owned I/O against no-exec shell forks: command-unit reservations.
//!
//! A no-exec fork copies this whole host. An owned payload copied into the
//! child (a managed reader with its worker sockets and PID, a local File, a
//! NamedTempFile whose cleanup unlinks the parent's path) would keep or act on
//! the parent's authority. The process gate (`tento_lisp::owned_io_gate`)
//! therefore refuses such a fork while any owned payload is live in any host
//! of the process, and refuses owned constructors while a fork is prepared.
//!
//! The only no-exec forks are the two callers of `fork_shell_plan`: a process
//! substitution, reached only through `shell_redirect::resolve_target`, and a
//! compound background stage in `start_job_process`. Command substitutions,
//! subshells and pipeline stages run in this process; ordinary external
//! commands spawn and exec, and never take the gate.
//!
//! A command unit reserves before its first own effect when the static scan
//! below says its own preparation can fork, and releases when that
//! preparation ends, never across the command's execution:
//!
//! | Unit and entry | Reserved before | Released after |
//! | --- | --- | --- |
//! | simple command: `bash_flow::eval_flow` | its words | their expansion |
//! | redirected command: `shell_redirect::run` | redirections, prefix assignments | `prepare`, or its simple command's word expansion |
//! | background job: `spawn_job`, also `std.jobs.spawn` lines | admission | `prepare`, word expansion, or the compound fork |
//! | external pipeline stage: `prepare_external_pipeline_stage` | its redirections | its word expansion |
//! | compound word (`for`, `case`, `(( ))`): `bash_compound::data` | the expansion | the expansion |
//! | `[[ … ]]` operands: `condition_command` | the first | the last |
//! | array assignment: `assign_shell_array`, `expand_array_assign` | the subscript | the words |
//! | `select` words; `PS4` (`shell_trace_prefix`) | the expansion | the expansion |
//!
//! The scan covers a unit's redirections, prefix assignments and words, both
//! branches of every parameter default, and the whole body of each command
//! substitution, which runs during the expansion, including a compound
//! background stage there. It does not predict function bodies or `eval`
//! text: the commands they run are units of their own, so their refusal does
//! not undo the enclosing command's completed effects (`f > out` truncates
//! `out` before `f`'s own `cat <(y)` refuses). A pipeline keeps one unit per
//! external stage, so `a > out | b <(y)` truncates `out` before `b` refuses.
//! A unit inside another unit's expansion reserves again; while a reservation
//! is held no owned token can exist, so that nested acquisition is never
//! refused for live I/O.
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tento_lisp::Value as LispValue;
use tento_lisp::owned_io_gate::ForkReservation;

use super::interp::{LispHost, LispHostError, Sym};

static UNCOVERED_FORKS: AtomicUsize = AtomicUsize::new(0);

/// How many no-exec shell forks this process made while their host held no
/// command-unit reservation. Each is a missed seam: it still refuses while
/// owned I/O is live, but its command's earlier effects may already have
/// happened. Debug builds assert that it stays zero.
#[doc(hidden)]
pub fn uncovered_shell_forks() -> usize {
  UNCOVERED_FORKS.load(Ordering::SeqCst)
}

#[cfg(test)]
thread_local! {
  /// Set by the unit test that drives the uncovered fallback on purpose.
  static FALLBACK_EXPECTED: Cell<bool> = const { Cell::new(false) };
}

/// The fork reservations a host's command units hold, counted only in the
/// process that made them: a forked child starts from none.
#[derive(Default)]
pub(super) struct ForkCover {
  held: Rc<Cell<usize>>,
  /// A redirected command's reservation, passed from `shell_redirect::run`
  /// to the `eval_flow` that expands its words. That `eval_flow` takes it
  /// before anything else runs, so no nested command can claim it.
  handoff: Option<UnitReservation>,
}

/// One command unit's process-wide permission for the no-exec forks its own
/// preparation starts.
#[must_use = "a fork reservation covers preparation only while it is held"]
pub(super) struct UnitReservation {
  _lease: ForkReservation,
  held: Rc<Cell<usize>>,
  pid: u32,
}

impl Drop for UnitReservation {
  fn drop(&mut self) {
    // A copy in a forked child neither counts nor releases (its lease is
    // inert there too).
    if self.pid == std::process::id() {
      self.held.set(self.held.get().saturating_sub(1));
    }
  }
}

impl LispHost {
  /// Reserve before a command unit's first own effect when `forks` (the
  /// static scan) says its preparation can start a no-exec fork. The refusal
  /// names the live owned I/O; the unit reports it as its own failure, with
  /// none of its effects done.
  pub(super) fn reserve_fork_unit(
    &mut self,
    forks: bool,
    unit: &str,
    line: usize,
  ) -> Result<Option<UnitReservation>, String> {
    if !forks {
      return Ok(None);
    }
    let lease = ForkReservation::acquire(format!("{unit} on line {line}"))
      .map_err(|error| error.to_string())?;
    let held = self.shell_compound.commands.fork_cover.held.clone();
    held.set(held.get() + 1);
    Ok(Some(UnitReservation {
      _lease: lease,
      held,
      pid: std::process::id(),
    }))
  }

  /// The permission one no-exec fork holds across `fork(2)`, nested in its
  /// unit's reservation. Reached uncovered (a missed seam), it still refuses
  /// while owned I/O is live; debug builds assert that never happens.
  pub(super) fn fork_permission(
    &mut self,
    fork: &str,
    line: usize,
  ) -> Result<ForkReservation, LispHostError> {
    if self.shell_compound.commands.fork_cover.held.get() == 0 {
      UNCOVERED_FORKS.fetch_add(1, Ordering::SeqCst);
      #[cfg(test)]
      let expected = FALLBACK_EXPECTED.with(Cell::get);
      #[cfg(not(test))]
      let expected = false;
      debug_assert!(
        expected,
        "no-exec shell fork ({fork}, line {line}) without a command-unit reservation"
      );
    }
    ForkReservation::acquire(format!("{fork} fork on line {line}"))
      .map_err(|error| LispHostError::Command(error.to_string()))
  }

  /// `shell_redirect::run` hands its reservation to the next `eval_flow`.
  pub(super) fn hand_off_fork_unit(&mut self, unit: Option<UnitReservation>) {
    self.shell_compound.commands.fork_cover.handoff = unit;
  }

  /// `eval_flow` claims a handed-off reservation before anything else runs.
  pub(super) fn take_fork_handoff(&mut self) -> Option<UnitReservation> {
    self.shell_compound.commands.fork_cover.handoff.take()
  }

  /// In a forked child, before its first command: what it copied covers
  /// nothing here. Its gate was reset under the fork lock, and releasing a
  /// copied reservation is inert in this process.
  #[cfg(unix)]
  pub(super) fn reset_fork_cover_in_child(&mut self) {
    drop(self.shell_compound.commands.fork_cover.handoff.take());
    self.shell_compound.commands.fork_cover.held.set(0);
  }
}

/// Whether the unit `value`'s own preparation can start a no-exec fork: its
/// redirections and prefix assignments, and the words of a simple command.
/// A compound command's body runs later, as units of its own.
pub(super) fn unit_forks(host: &mut LispHost, value: &LispValue<Sym>) -> bool {
  if let Some((_, body)) = super::bash_flow::line_marker(host, value) {
    return unit_forks(host, body);
  }
  if let Some((stage, specs)) = super::shell_redirect::redirected_stage(host, value) {
    return words_fork(host, specs) || unit_forks(host, stage);
  }
  simple_command(host, value) && words_fork(host, value)
}

/// What `eval_flow` expands as one simple command.
fn simple_command(host: &mut LispHost, value: &LispValue<Sym>) -> bool {
  let head = host.application_head(value);
  !super::bash_flow::is_flow(head.as_deref())
    || matches!(head.as_deref(), Some("std.sh.cmd" | "std.sh.append"))
}

/// Whether expanding `value` as words can fork: a process substitution, or a
/// fork anywhere in a command substitution's body. Both branches of a
/// parameter default count; quoted data never runs.
pub(super) fn words_fork(host: &mut LispHost, value: &LispValue<Sym>) -> bool {
  match host.application_head(value).as_deref() {
    Some("quote") => false,
    Some("std.sh.process-sub") => true,
    Some("std.sh.sub") => operands(value).any(|body| body_forks(host, body)),
    _ => operands(value).any(|item| words_fork(host, item)),
  }
}

/// Whether running the command tree `value` in this process can fork.
fn body_forks(host: &mut LispHost, value: &LispValue<Sym>) -> bool {
  match host.application_head(value).as_deref() {
    Some("quote") => false,
    Some("std.sh.process-sub") => true,
    Some("std.sh.background") if operands(value).any(|stage| background_compound(host, stage)) => {
      true
    }
    _ => operands(value).any(|item| body_forks(host, item)),
  }
}

/// Whether a background `stage` runs in a forked shell, as
/// `start_job_process` decides: a flow under at most one redirection.
fn background_compound(host: &mut LispHost, stage: &LispValue<Sym>) -> bool {
  let stage =
    super::shell_redirect::redirected_stage(host, stage).map_or(stage, |(stage, _)| stage);
  super::bash_flow::is_flow(host.application_head(stage).as_deref())
}

/// A background job's unit: its admission comes before a compound fork, its
/// redirections and its words.
pub(super) fn background_forks(host: &mut LispHost, stage: &LispValue<Sym>) -> bool {
  background_compound(host, stage) || unit_forks(host, stage)
}

fn operands(value: &LispValue<Sym>) -> std::slice::Iter<'_, LispValue<Sym>> {
  match value {
    LispValue::List(list) => list.items.get(1..).unwrap_or_default().iter(),
    _ => Default::default(),
  }
}

#[cfg(test)]
#[path = "owned_io_fork_tests.rs"]
mod tests;
