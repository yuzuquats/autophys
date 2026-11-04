//! The static scan, and the uncovered-fork fallback. The fallback tests hold
//! live tokens on the process-global gate, so each runs alone in a child test
//! process: a token held here would refuse every concurrent test's fork.
use super::*;
use std::time::{Duration, Instant};
use tento_lisp::owned_io_gate::{self, GateError, LiveIo};

fn plan(host: &mut LispHost, source: &str) -> LispValue<Sym> {
  host
    .read_posix_line_value(source)
    .unwrap_or_else(|error| panic!("{source}: {error}"))
}

fn find_background<'a>(
  host: &mut LispHost,
  value: &'a LispValue<Sym>,
) -> Option<&'a LispValue<Sym>> {
  if host.application_head(value).as_deref() == Some("std.sh.background") {
    return operands(value).next();
  }
  operands(value).find_map(|item| find_background(host, item))
}

#[test]
fn the_scan_reserves_exactly_the_units_whose_own_preparation_forks() {
  let mut host = LispHost::new();
  for (source, forks) in [
    // A simple command's words, assignments included.
    ("cat <(a)", true),
    ("cat >(a)", true),
    ("cat a b", false),
    ("cat '<(a)' \"<(a)\"", false),
    ("x=$(cat <(a))", true),
    ("x=$(cat a)", false),
    // Redirections and prefix assignments.
    ("cat > >(tee x)", true),
    ("cat > out", false),
    ("FOO=$(cat <(a)) cmd", true),
    ("FOO=bar cmd <(a)", true),
    ("while read l; do :; done < <(producer)", true),
    // Both branches of a parameter default; nested substitutions.
    ("echo ${x:-$(cat <(a))}", true),
    ("echo ${x:+$(cat <(a))}", true),
    ("echo \"$(cat \"$(cat <(b))\")\"", true),
    ("diff <(a) \"$(cat <(b))\" > out", true),
    // A compound background stage in a substitution forks this host; an
    // external one spawns.
    ("echo $( { a; } & )", true),
    ("echo $( (a) > out & )", true),
    ("echo $(sleep 1 &)", false),
    // A compound command's body and a function's commands are units of
    // their own.
    ("while read l; do cat <(x); done > out", false),
    ("{ cat <(a); } > out", false),
    ("f > out", false),
  ] {
    let value = plan(&mut host, source);
    assert_eq!(unit_forks(&mut host, &value), forks, "{source}");
  }
}

#[test]
fn a_background_job_reserves_for_its_compound_fork_redirections_and_words() {
  let mut host = LispHost::new();
  for (source, forks) in [
    ("{ a; } &", true),
    ("{ a; } > out &", true),
    ("(a) &", true),
    ("a | b &", true),
    ("cat <(a) &", true),
    ("cat > >(tee x) &", true),
    ("diff <(a) \"$(cat <(b))\" > out &", true),
    ("sleep 1 &", false),
    ("sleep 1 > out &", false),
  ] {
    let value = plan(&mut host, source);
    let stage = find_background(&mut host, &value).unwrap_or_else(|| panic!("{source}: no job"));
    assert_eq!(background_forks(&mut host, stage), forks, "{source}");
  }
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "without a command-unit reservation")]
fn debug_builds_assert_every_no_exec_fork_is_covered() {
  // The assertion fires before the gate is touched: no isolation needed.
  let _ = LispHost::new().fork_permission("process substitution", 1);
}

/// Run `name` alone in a child test process, bounded. The gate is
/// process-global; this test's live tokens must meet no other test's fork.
fn isolated(name: &str) -> bool {
  const MARKER: &str = "TENTO_OWNED_IO_FORK_ISOLATED";
  if std::env::var_os(MARKER).is_some() {
    return false;
  }
  let path = format!("script::owned_io_fork::tests::{name}");
  let mut child = std::process::Command::new(std::env::current_exe().unwrap())
    .args(["--exact", &path, "--nocapture", "--test-threads=1"])
    .env(MARKER, "1")
    .stdout(std::process::Stdio::piped())
    .spawn()
    .unwrap();
  let mut stdout = child.stdout.take().unwrap();
  let reader = std::thread::spawn(move || {
    let mut text = String::new();
    let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
    text
  });
  let deadline = Instant::now() + Duration::from_secs(60);
  let status = loop {
    if let Some(status) = child.try_wait().unwrap() {
      break status;
    }
    if Instant::now() > deadline {
      let _ = child.kill();
      let _ = child.wait();
      panic!("{path} timed out in isolation");
    }
    std::thread::sleep(Duration::from_millis(10));
  };
  let output = reader.join().unwrap();
  assert!(status.success(), "{path} failed in isolation:\n{output}");
  assert!(
    output.contains("1 passed"),
    "{path} did not run in isolation:\n{output}"
  );
  true
}

#[test]
fn an_uncovered_fork_counts_and_still_refuses_live_owned_io() {
  if isolated("an_uncovered_fork_counts_and_still_refuses_live_owned_io") {
    return;
  }
  let mut host = LispHost::new();
  FALLBACK_EXPECTED.with(|expected| expected.set(true));
  let before = uncovered_shell_forks();
  let token = LiveIo::acquire("isolated owned payload").unwrap();
  let refused = host
    .fork_permission("process substitution", 7)
    .err()
    .expect("a live token refuses the uncovered fork")
    .to_string();
  assert!(
    refused.contains("owned I/O prevents shell fork in this process"),
    "{refused}"
  );
  assert!(refused.contains("isolated owned payload"), "{refused}");
  assert_eq!(uncovered_shell_forks(), before + 1);
  drop(token);
  let permission = host.fork_permission("process substitution", 7).unwrap();
  assert_eq!(uncovered_shell_forks(), before + 2);
  // A constructor meeting fork preparation is busy at once; it never waits.
  let busy = LiveIo::acquire("constructor").err().unwrap();
  assert!(matches!(busy, GateError::Busy(_)), "{busy}");
  assert!(
    busy
      .to_string()
      .contains("process substitution fork on line 7"),
    "{busy}"
  );
  drop(permission);
  // Covered: a unit's reservation, then the fork's own nested lease.
  let unit = host.reserve_fork_unit(true, "test unit", 8).unwrap();
  assert!(unit.is_some());
  drop(host.fork_permission("process substitution", 8).unwrap());
  assert_eq!(
    uncovered_shell_forks(),
    before + 2,
    "a covered fork is not counted"
  );
  drop(unit);
  assert_eq!(host.shell_compound.commands.fork_cover.held.get(), 0);
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
}

#[test]
fn nested_units_share_the_gate_and_only_the_outermost_can_meet_live_io() {
  if isolated("nested_units_share_the_gate_and_only_the_outermost_can_meet_live_io") {
    return;
  }
  let mut host = LispHost::new();
  let token = LiveIo::acquire("other host reader").unwrap();
  let refused = host
    .reserve_fork_unit(true, "redirected command", 2)
    .err()
    .unwrap();
  assert!(refused.contains("other host reader"), "{refused}");
  assert!(
    host
      .reserve_fork_unit(false, "plain command", 2)
      .unwrap()
      .is_none(),
    "a unit that cannot fork never meets the gate"
  );
  assert_eq!(host.shell_compound.commands.fork_cover.held.get(), 0);
  drop(token);
  let outer = host
    .reserve_fork_unit(true, "redirected command", 3)
    .unwrap();
  // While it is held another host's constructor is busy, so no token can
  // exist when a nested unit reserves.
  let other = std::thread::spawn(|| LiveIo::acquire("other host").err())
    .join()
    .unwrap();
  assert!(matches!(other, Some(GateError::Busy(_))), "{other:?}");
  let nested = host
    .reserve_fork_unit(true, "command substitution", 3)
    .unwrap();
  assert_eq!(host.shell_compound.commands.fork_cover.held.get(), 2);
  drop(outer);
  assert!(
    LiveIo::acquire("while nested").is_err(),
    "the nested reservation still holds"
  );
  drop(nested);
  assert_eq!(host.shell_compound.commands.fork_cover.held.get(), 0);
  drop(LiveIo::acquire("released").unwrap());
  assert_eq!(owned_io_gate::ensure_idle(), Ok(()));
}
