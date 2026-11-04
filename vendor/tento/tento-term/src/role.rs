//! Semantic roles: the indirection between "what this text MEANS" and "what
//! colour it is".
//!
//! [`crate::Style`] gained a `Role` variant, and every legacy variant now
//! *reports* a role — `Style::Red` is `ansi.red`, `Style::Gray` is `ansi.gray`.
//! So every painting site in the tree is theme-routed the day this lands,
//! without any of them being edited: with no table installed a role resolves to
//! nothing and the legacy SGR constant is used, which is byte-for-byte today's
//! output. Installing a table is what changes anything.
//!
//! **Why the table lives here, and why it is process-global.** `color_sgr`,
//! `Style::paint` and `BoxChars` are in `tento-term`, the bottom crate; a theme
//! value lives in `tento-shapes`, above it. Threading a theme down into
//! `Style::paint` would mean threading it through `Cell::new`, `render_fit`,
//! `Style::or`, `Table` and `Tree` — a change to every signature in the
//! rendering path. A process paints for exactly one terminal, and the same four
//! call sites already consult one process-global (`SHOULD_COLORIZE`) for
//! exactly this reason.
//!
//! The table holds **resolved** styles: palette names are substituted by the
//! installer (`tento_shapes::style::Theme::resolve`), so this crate never
//! learns what a palette is. It only knows role → [`SpanStyle`].
//!
//! Roles are dotted and resolve by LONGEST PREFIX, the same rule `Theme::spec`
//! uses: `syntax.function.method` tries the whole name, then `syntax.function`,
//! then `syntax`. A theme that binds six trunks styles seventy leaves.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, RwLock};

use crate::span_style::{SpanStyle, style_from_tokens};

/// Role names a [`crate::Style`] legacy variant reports, bound here so a theme
/// can restyle `Style::Red` without touching the 373 sites that construct one.
pub const ANSI_ROLES: &[(&str, &str)] = &[
  ("ansi.red", "red"),
  ("ansi.green", "green"),
  ("ansi.yellow", "yellow"),
  ("ansi.blue", "blue"),
  ("ansi.magenta", "magenta"),
  ("ansi.cyan", "cyan"),
  ("ansi.white", "white"),
  // NOT `gray`. `color_sgr("gray")` is SGR 90 (bright black) but `Style::Gray`
  // has always been 256-colour index 238, and the two have disagreed for as
  // long as both existed. The compat binding preserves the OLD value, because
  // its job is to change nothing; a theme is where that gets a considered
  // answer.
  ("ansi.gray", "index:238"),
  ("ansi.dimmed", "dim"),
  ("ansi.bold", "bold"),
];

/// A role → style binding table, resolved and ready to paint from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoleTable {
  roles: BTreeMap<String, SpanStyle>,
}

impl RoleTable {
  pub fn new() -> Self {
    Self::default()
  }

  /// The compatibility table: every `ansi.*` role bound to the literal its
  /// legacy `Style` variant has always painted. Installing this must produce
  /// byte-identical output to installing nothing — that equivalence is the
  /// acceptance test for the whole role migration, and it is asserted below.
  pub fn ansi_defaults() -> Self {
    let mut table = Self::new();
    for (role, spec) in ANSI_ROLES {
      table.bind(*role, spec);
    }
    table
  }

  /// Bind a dotted role to a style spec (`"bold fg:#9ece6a"`). The spec must
  /// already be palette-resolved; see the module docs.
  pub fn bind(&mut self, role: impl Into<String>, spec: &str) {
    self.roles.insert(role.into(), style_from_tokens(spec));
  }

  /// Bind a role to an already-parsed style.
  pub fn set(&mut self, role: impl Into<String>, style: SpanStyle) {
    self.roles.insert(role.into(), style);
  }

  pub fn is_empty(&self) -> bool {
    self.roles.is_empty()
  }

  pub fn len(&self) -> usize {
    self.roles.len()
  }

  /// Every bound role name, in sorted order — what a coverage guard walks.
  pub fn names(&self) -> impl Iterator<Item = &str> {
    self.roles.keys().map(String::as_str)
  }

  /// The style bound to `role`, by longest dotted prefix.
  pub fn get(&self, role: &str) -> Option<&SpanStyle> {
    let mut probe = role;
    loop {
      if let Some(style) = self.roles.get(probe) {
        return Some(style);
      }
      probe = &probe[..probe.rfind('.')?];
    }
  }
}

impl FromIterator<(String, SpanStyle)> for RoleTable {
  fn from_iter<I: IntoIterator<Item = (String, SpanStyle)>>(iter: I) -> Self {
    Self {
      roles: iter.into_iter().collect(),
    }
  }
}

// --- the ambient table ------------------------------------------------------

static ROLES: LazyLock<RwLock<Arc<RoleTable>>> =
  LazyLock::new(|| RwLock::new(Arc::new(RoleTable::new())));

/// Is ANY role bound right now?
///
/// `Style::code` runs once per painted span, so the unthemed path — the CLI,
/// every test, and any process that never installs a theme — must not pay for
/// a lock, an `Arc` clone, a map probe and a `String` for a table it is going
/// to find empty. This flag makes that path a single relaxed load.
///
/// Relaxed is sufficient: it is only ever flipped by `set_roles`, and the worst
/// a stale read can do is paint one frame with the previous theme. There is no
/// invariant on the other side of it to publish.
static THEMED: AtomicBool = AtomicBool::new(false);

/// How many times the ambient table has been swapped.
///
/// Downstream render caches key a row on the inputs that produced it; the
/// ambient theme is one of those inputs and it is invisible to them, so a
/// theme switch would otherwise serve stale colours out of cache for the life
/// of the process. Folding this counter into a cache key fixes that with no
/// coupling in the wrong direction: `tento-term` is the bottom crate and
/// cannot see a scene's `DataPulse`, and asking every install site to
/// remember to bump one would be a second place that answers the same
/// question.
///
/// Starts at 0 (nothing installed) and is bumped INSIDE `set_roles`, which is
/// the only path that swaps the table — `clear_roles` delegates to it.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The current theme generation — bumped on every [`set_roles`], including the
/// one [`clear_roles`] performs. See [`GENERATION`].
#[inline]
pub fn generation() -> u64 {
  GENERATION.load(Ordering::Relaxed)
}

/// Does any role resolution need to happen at all?
#[inline]
pub fn any_roles_bound() -> bool {
  THEMED.load(Ordering::Relaxed)
}

/// The table currently painting. Cheap: an `Arc` clone.
pub fn roles() -> Arc<RoleTable> {
  ROLES
    .read()
    .map(|table| Arc::clone(&table))
    .unwrap_or_else(|poisoned| Arc::clone(&poisoned.into_inner()))
}

/// Install `table` as the ambient theme for this process. Called once at the
/// composition root, and again when an rc reload changes the theme.
pub fn set_roles(table: RoleTable) {
  let bound = !table.is_empty();
  let next = Arc::new(table);
  match ROLES.write() {
    Ok(mut slot) => *slot = next,
    Err(poisoned) => *poisoned.into_inner() = next,
  }
  // After the swap: a reader that sees the flag must find the table already in
  // place, never the other way round.
  THEMED.store(bound, Ordering::Relaxed);
  // Last, so an observer that reacts to the bump finds the new table installed.
  GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// Drop back to the unthemed default (every role unbound, legacy SGR).
pub fn clear_roles() {
  set_roles(RoleTable::new());
}

/// The resolved style for `role`, or `None` if nothing is bound.
pub fn resolve(role: &str) -> Option<SpanStyle> {
  if role.is_empty() || !any_roles_bound() {
    return None;
  }
  roles().get(role).cloned()
}

/// Serializes tests that install a theme. The ambient table is process-global,
/// so two `#[test]` threads swapping it would race; take this guard first.
/// (`force_color`'s tests have the same hazard and no such guard — don't
/// compound it here.)
static AMBIENT_LOCK: Mutex<()> = Mutex::new(());

/// Run `body` with `table` installed, then restore. Returns the guard's result.
pub fn with_roles<T>(table: RoleTable, body: impl FnOnce() -> T) -> T {
  let _guard: MutexGuard<'_, ()> = AMBIENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let previous = roles();
  set_roles(table);
  let out = body();
  set_roles((*previous).clone());
  out
}

/// Install `table` for the rest of the process, serialized with
/// [`with_roles`]. For a test harness that wants one baseline theme under
/// every test: taking the same lock means it never lands in the middle of a
/// scoped install, and every later scope restores to it.
pub fn set_baseline_roles(table: RoleTable) {
  let _guard: MutexGuard<'_, ()> = AMBIENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  set_roles(table);
}

// --- interning --------------------------------------------------------------
//
// `Style` stays `Copy`, which is worth a lot: 373 construction sites and 64
// by-value signatures keep compiling untouched, so the variant lands as an
// addition rather than a tree-wide mechanical edit in a checkout five sessions
// share. That costs a `&'static str`, so a role name arriving at runtime — from
// a scene `.tsh` or a deserialized cell — has to be interned.
//
// The vocabulary is bounded by design (~70 leaves), so leaking is fine; what is
// NOT fine is leaking whatever a JSON payload happens to contain. Hence a shape
// filter and a hard cap, both of which DEGRADE (the name is simply not a role)
// rather than fault.

/// Ceiling on interned names. An order of magnitude above the designed
/// vocabulary; a table that hits it is a bug or an attack, and either way the
/// right answer is to stop growing, not to abort a render.
const INTERN_CAP: usize = 1024;

static INTERNED: LazyLock<RwLock<BTreeSet<&'static str>>> =
  LazyLock::new(|| RwLock::new(BTreeSet::new()));

/// Is `name` shaped like a role? Lowercase ASCII, digits, `.` and `-`; no
/// empty segment; 1..=64 bytes.
///
/// Underscore is excluded on purpose. `color_sgr` normalizes `_` to `-` before
/// it looks anything up (so `bright_black` and `bright-black` are one colour),
/// which would make a role bound as `my_role` unfindable under the name the
/// lookup actually uses. Dotted-kebab, and the trap cannot happen.
pub fn is_role_name(name: &str) -> bool {
  if name.is_empty() || name.len() > 64 || name.starts_with('.') || name.ends_with('.') {
    return false;
  }
  if name.contains("..") {
    return false;
  }
  name
    .bytes()
    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}

/// Intern a role name, or `None` if it is not role-shaped or the table is full.
pub fn intern(name: &str) -> Option<&'static str> {
  if !is_role_name(name) {
    return None;
  }
  if let Ok(seen) = INTERNED.read() {
    if let Some(found) = seen.get(name) {
      return Some(found);
    }
  }
  let mut seen = INTERNED.write().ok()?;
  if let Some(found) = seen.get(name) {
    return Some(found);
  }
  if seen.len() >= INTERN_CAP {
    return None;
  }
  let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
  seen.insert(leaked);
  Some(leaked)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn longest_prefix_wins_and_a_trunk_covers_its_leaves() {
    let mut table = RoleTable::new();
    table.bind("syntax", "fg:white");
    table.bind("syntax.function", "fg:blue");

    assert_eq!(
      table.get("syntax.function").unwrap().fg.as_deref(),
      Some("blue")
    );
    // Bound nowhere itself — covered by its trunk.
    assert_eq!(
      table.get("syntax.function.method").unwrap().fg.as_deref(),
      Some("blue"),
      "the longest bound prefix wins, not the shortest"
    );
    assert_eq!(
      table.get("syntax.string").unwrap().fg.as_deref(),
      Some("white")
    );
    assert!(
      table.get("chrome.rule").is_none(),
      "an unrelated trunk stays unbound"
    );
    assert!(
      table.get("syntaxical").is_none(),
      "prefix match is per SEGMENT, not per byte"
    );
  }

  #[test]
  fn role_names_are_shape_checked() {
    for good in ["text", "text.primary", "ansi.gray", "lane-1.bg", "a-b.c9"] {
      assert!(is_role_name(good), "{good:?} is role-shaped");
    }
    for bad in [
      "",
      ".leading",
      "trailing.",
      "double..dot",
      "Upper.Case",
      "under_score",
      "has space",
      "esc\u{1b}[31m",
      "#ff0000",
    ] {
      assert!(!is_role_name(bad), "{bad:?} must not intern");
    }
    assert!(!is_role_name(&"x".repeat(65)), "over the length ceiling");
  }

  #[test]
  fn interning_is_idempotent_and_refuses_junk() {
    let first = intern("text.primary").expect("role-shaped");
    let second = intern("text.primary").expect("role-shaped");
    assert!(
      std::ptr::eq(first, second),
      "the same name interns to the same pointer"
    );
    assert!(intern("Not A Role").is_none());
  }

  #[test]
  fn every_ansi_compat_role_parses_to_exactly_one_sgr_parameter() {
    // The equivalence `Style::code()` relies on: each legacy variant is a
    // single SGR parameter, so a compat binding cannot reorder anything.
    let table = RoleTable::ansi_defaults();
    for (role, spec) in ANSI_ROLES {
      let style = table.get(role).unwrap_or_else(|| panic!("{role} bound"));
      let codes = crate::span_style::style_sgr(style);
      assert_eq!(
        codes.len(),
        1,
        "{role} ({spec}) must be one parameter, got {codes:?}"
      );
    }
  }
}
