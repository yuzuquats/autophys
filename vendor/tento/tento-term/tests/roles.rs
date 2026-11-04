//! The role seam, tested in its OWN binary.
//!
//! Not a stylistic choice. The installed theme is process-global — deliberately
//! so, because `color_sgr` and `Style::paint` are pure functions on the paint
//! path and threading a theme into them would mean threading it through every
//! signature in the rendering stack. The cost of that decision is exactly this:
//! a test that installs a theme and a test that asserts unthemed SGR cannot
//! share a process, because cargo runs `#[test]`s in parallel threads and the
//! second would intermittently read the first's table.
//!
//! An integration test file is a separate BINARY, so the unit-test binary never
//! has a theme installed and its golden assertions cannot be raced. Every test
//! that calls `set_roles`/`with_roles` belongs here; tests that only build a
//! `RoleTable` without installing it stay beside the code.

use tento_term::{RoleTable, SpanStyle, Style, ansi, color_sgr, role, with_roles};

// Include assertions before/after with_roles in the same critical section.
// Its internal lock protects the callback, not those surrounding reads.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const LEGACY_VARIANTS: &[Style] = &[
  Style::None,
  Style::Red,
  Style::Green,
  Style::Yellow,
  Style::Blue,
  Style::Magenta,
  Style::Cyan,
  Style::White,
  Style::Gray,
  Style::Dimmed,
  Style::Bold,
];

/// The acceptance gate for the whole role migration: routing every legacy
/// variant through its `ansi.*` compatibility role must change nothing at all.
/// If this fails, the compat bindings are wrong and every golden in the tree is
/// about to move.
#[test]
fn the_ansi_compat_table_is_byte_identical_to_no_table_at_all() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let unthemed: Vec<String> = LEGACY_VARIANTS
    .iter()
    .map(|style| style.code().into_owned())
    .collect();
  with_roles(RoleTable::ansi_defaults(), || {
    for (style, before) in LEGACY_VARIANTS.iter().zip(&unthemed) {
      assert_eq!(
        &style.code().into_owned(),
        before,
        "{style:?} changed when its compatibility role was bound"
      );
    }
  });
}

#[test]
fn a_bound_role_restyles_a_legacy_variant_without_touching_its_call_site() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::ansi_defaults();
  table.bind("ansi.gray", "fg:#808080");
  with_roles(table, || {
    // The call site still says `Style::Gray`. The theme decided what that is.
    assert_eq!(Style::Gray.code(), "\u{1b}[38;2;128;128;128m");
    assert_eq!(
      Style::Red.code(),
      ansi::RED,
      "a role nobody rebound is untouched"
    );
  });
  assert_eq!(Style::Gray.code(), ansi::GRAY, "and it is restored after");
}

#[test]
fn the_ambient_table_is_installed_and_restored() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  table.bind("status.ok", "fg:#00ff00");
  with_roles(table, || {
    assert_eq!(
      role::resolve("status.ok").unwrap().fg.as_deref(),
      Some("#00ff00")
    );
  });
  assert!(
    role::resolve("status.ok").is_none(),
    "restored to the previous table"
  );
}

#[test]
fn the_unthemed_fast_path_short_circuits_and_an_install_lifts_it() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  with_roles(RoleTable::new(), || {
    assert!(!role::any_roles_bound(), "an empty table is not a theme");
    assert!(role::resolve("anything.at.all").is_none());
  });
  let mut table = RoleTable::new();
  table.bind("text.primary", "fg:red");
  with_roles(table, || {
    assert!(role::any_roles_bound());
    assert_eq!(
      role::resolve("text.primary").unwrap().fg.as_deref(),
      Some("red")
    );
  });
}

#[test]
fn a_role_resolves_where_a_colour_goes() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  table.bind("text.primary", "fg:#1f2328");
  table.bind("surface.raised", "bg:#f6f8fa");
  with_roles(table, || {
    assert_eq!(
      color_sgr("text.primary", false).as_deref(),
      Some("38;2;31;35;40"),
      "a role written where a colour goes paints the colour it names"
    );
    assert_eq!(
      color_sgr("surface.raised", true).as_deref(),
      Some("48;2;246;248;250")
    );
    // Asking a foreground-only role for a background gets nothing — not the
    // foreground quietly reused as a background.
    assert!(color_sgr("text.primary", true).is_none());
  });
}

#[test]
fn the_literal_vocabulary_wins_over_a_role_of_the_same_name() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  table.bind("red", "fg:#00ff00");
  table.bind("default", "fg:#00ff00");
  with_roles(table, || {
    assert_eq!(
      color_sgr("red", false).as_deref(),
      Some("31"),
      "still ANSI red: a theme cannot capture the literal vocabulary"
    );
    assert_eq!(color_sgr("default", false).as_deref(), Some("39"));
  });
}

#[test]
fn an_unbound_name_is_still_nothing_and_a_role_cycle_terminates() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  assert!(
    color_sgr("text.primary", false).is_none(),
    "unthemed: exactly as before"
  );
  let mut table = RoleTable::new();
  table.bind("a.role", "fg:b.role");
  table.bind("b.role", "fg:a.role");
  with_roles(table, || {
    assert!(
      color_sgr("a.role", false).is_none(),
      "a cycle stops at the hop limit, it does not overflow the stack"
    );
  });
}

#[test]
fn one_hop_through_a_role_to_a_named_colour_works() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  table.bind("status.ok", "fg:green bold");
  with_roles(table, || {
    // Attributes are not this function's business; it answers colour.
    assert_eq!(color_sgr("status.ok", false).as_deref(), Some("32"));
  });
}

#[test]
fn a_role_bound_to_an_empty_style_paints_nothing_rather_than_a_reset() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  // Nothing recognizable: an explicitly plain role.
  table.set("text.plain", SpanStyle::default());
  table.bind("ansi.red", "");
  with_roles(table, || {
    assert_eq!(
      Style::Red.code(),
      "",
      "an empty binding must not emit \\x1b[m, which would close a run the \
       caller had open"
    );
  });
}

/// `paint` on an unbound role must return the text untouched — no opener, and
/// crucially no `\x1b[0m`, which would close a run the caller had opened around
/// us.
///
/// It lives HERE rather than beside `Style` for the same reason as everything
/// else in this file, though a different global: it toggles
/// `colored::control`'s process-wide override, and `table.rs`'s
/// `demotes_when_narrow` reads that override while asserting styled output.
/// Two threads, one switch — the unforce landed inside the other test's window
/// and it failed intermittently. Nothing else in this binary calls `paint`.
#[test]
fn an_unbound_role_paints_nothing_rather_than_a_bare_reset() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  // `with_roles` for the ambient LOCK as much as the empty table: a sibling
  // test in this file binds `text.primary`, and without the guard this one
  // would intermittently read it.
  let painted = with_roles(RoleTable::new(), || {
    let style = Style::role("text.primary");
    assert!(matches!(style, Style::Role("text.primary")));
    assert_eq!(style.code(), "");
    tento_term::force_color(true);
    let painted = style.paint("hi");
    tento_term::unforce_color();
    painted
  });
  assert_eq!(painted, "hi");
}

#[test]
fn a_malformed_role_name_degrades_to_unstyled() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  assert_eq!(Style::role("Not A Role"), Style::None);
  assert_eq!(Style::role("#ff0000"), Style::None);
  assert_eq!(Style::role("under_score"), Style::None);
}

/// A render cache downstream keys rows on the inputs that produced them. The
/// ambient theme is one of those inputs and is invisible to the cache, so this
/// counter is the handle it folds into its key. Two properties matter to it:
/// the counter MOVES on every swap (or a theme switch serves stale colours),
/// and it moves for a CLEAR too (or switching back to unthemed does).
#[test]
fn a_theme_swap_moves_the_generation_a_cache_keys_on() {
  let _test_guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut table = RoleTable::new();
  table.bind("text.primary", "fg:#ff0000");

  let before = tento_term::theme_generation();
  tento_term::with_roles(table, || {
    let inside = tento_term::theme_generation();
    assert!(
      inside > before,
      "installing a table must move the generation ({before} -> {inside})"
    );
    // A clear is a swap like any other: a cache holding themed rows has to be
    // told that unthemed is now in force.
    let cleared_from = tento_term::theme_generation();
    tento_term::clear_roles();
    assert!(
      tento_term::theme_generation() > cleared_from,
      "clearing must move the generation too"
    );
  });
  assert!(
    tento_term::theme_generation() > before,
    "the restore is itself a swap and must be observable"
  );
}
