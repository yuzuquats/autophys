//! The native-stack grower every interpreter in a tento-lisp-cmd process
//! evaluates through ([`tento_lisp::StackGrower`]).
//!
//! Without it, deep Lisp recursion overflows the evaluating thread — about
//! 2,000 frames on an 8 MB main thread — and the overflow aborts the process
//! where no `(try …)` can see it. With it, evaluation moves onto a freshly
//! mapped segment whenever the current one runs low, so recursion is bounded
//! by the interpreter's own (catchable) depth limit instead.

/// Head-room an evaluation needs before it nests again. Debug builds keep
/// several large frames per evaluation, so this is generous.
const RED_ZONE: usize = 256 * 1024;
/// Size of each extra segment: large enough to amortise the switch across
/// thousands of frames, and only mapped while recursion is that deep.
const SEGMENT: usize = 8 * 1024 * 1024;

fn grow(f: &mut dyn FnMut()) {
  stacker::maybe_grow(RED_ZONE, SEGMENT, f)
}

/// Install the grower for the whole process. Idempotent: every host
/// constructor calls it, and only the first install takes effect.
pub(crate) fn install() {
  tento_lisp::install_stack_grower(grow);
}
