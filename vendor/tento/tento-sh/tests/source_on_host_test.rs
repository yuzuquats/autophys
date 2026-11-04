//! `run_source_on_host`: the long-lived-host runner a control plane uses to
//! evaluate units — env persists across calls, multi-line forms coalesce.

use std::collections::HashMap;

use tento_sh::script::{RunOptions, run_source_on_host};
use tento_sh::shell::Callable;
use tento_sh::{Scripts, script};

fn scripts() -> Scripts<()> {
  Scripts::new(())
}

fn subs() -> HashMap<String, Box<dyn Callable>> {
  HashMap::new()
}

#[tokio::test]
async fn env_persists_across_calls_on_one_host() {
  let scripts = scripts();
  let subs = subs();
  let mut host = script::LispHost::new();

  // First unit defines; second unit (a separate call) still sees it.
  run_source_on_host(
    &mut host,
    "> (let x 41)",
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect("define");
  run_source_on_host(
    &mut host,
    "(assert (= x 41))",
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect("x visible in the next unit");

  // A fresh host does NOT see it — the persistence is the host's, not global.
  let mut fresh = script::LispHost::new();
  let err = run_source_on_host(
    &mut fresh,
    "(assert (= x 41))",
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await;
  assert!(err.is_err(), "fresh host has no x");
}

#[tokio::test]
async fn multi_line_forms_coalesce_into_one_statement() {
  let scripts = scripts();
  let subs = subs();
  let mut host = script::LispHost::new();

  // A balanced form spread over lines — the per-line runners would fail on
  // the unbalanced first line; the coalescing pre-pass evaluates it whole.
  let source = "(assert (=\n  (+ 40 1)\n  41))";
  run_source_on_host(
    &mut host,
    source,
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect("multi-line form evaluates");

  // Strings containing parens don't confuse the scanner.
  let tricky = "(assert (=\n  (len \"(((\")\n  3))";
  run_source_on_host(
    &mut host,
    tricky,
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect("paren-in-string is inert");
}

#[tokio::test]
async fn lisp_only_source_yields_no_value_and_errors_carry_the_form() {
  let scripts = scripts();
  let subs = subs();
  let mut host = script::LispHost::new();

  let value = run_source_on_host(
    &mut host,
    "> (let y 1)\n(assert (= y 1))",
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect("runs");
  assert_eq!(
    value,
    Some(serde_json::Value::Bool(true)),
    "the final Lisp assertion is the source value"
  );

  let err = run_source_on_host(
    &mut host,
    "# fine\n(assert (=\n  1\n  2))",
    &scripts,
    &subs,
    &[],
    RunOptions::default(),
  )
  .await
  .expect_err("failing assert");
  assert_eq!(err.line, 2, "error is tagged with the form's starting line");
}
