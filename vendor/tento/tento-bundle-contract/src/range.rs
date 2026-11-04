//! Version ranges between bundles: the `name@range` a manifest requires and
//! the ranges `tsh.toml` `[dependencies]` declare, matched against a
//! bundle's `version` the way Cargo matches a crate requirement.
//!
//! One grammar for every consumer: tsh-serve decides whether a browser
//! bridge can load a module that requires `tsh-web@^1`, tsh-package checks
//! the ranges a plugin declares, and tsh-plugins resolves a plugin's bundle
//! dependencies against what a registry publishes.
//!
//! A range is one or more comma-separated comparators, all of which must
//! hold. A comparator is an operator and a version that may stop after its
//! major or minor component:
//!
//! | Range | Means |
//! | --- | --- |
//! | `*`, empty | any version |
//! | `1.2`, `^1.2` | `>=1.2.0, <2.0.0` (`^0.2` is `>=0.2.0, <0.3.0`) |
//! | `~1.2` | `>=1.2.0, <1.3.0` |
//! | `1.*`, `1.2.*` | the versions that start so |
//! | `=1.2.3`, `>1`, `>=1.4`, `<2`, `<=1.2` | as written; a missing component is `0` above and a wildcard below |
//!
//! A prerelease or build suffix on a candidate version is ignored: a nightly
//! `0.2.0-nightly.3` is on the `0.2.0` line and satisfies what `0.2.0` does.
//! tsh's nightlies rebuild the current version, so refusing them would make
//! every nightly dependency unsatisfiable.

/// Enforce a tsh floor: a bare version means `>=`, explicit ranges retain
/// the shared bundle grammar (whose bare dependency versions remain caret).
pub fn check_requires_tsh(plugin: &str, requirement: &str, running: &str) -> anyhow::Result<()> {
  let trimmed = requirement.trim();
  let floor;
  let range_text = if Version::parse(trimmed).is_some() {
    floor = format!(">={trimmed}");
    &floor
  } else { trimmed };
  let range = Range::parse(range_text)
    .map_err(|e| anyhow::anyhow!("{plugin}: invalid requires_tsh {requirement:?}: {e}"))?;
  let version = Version::parse(running)
    .ok_or_else(|| anyhow::anyhow!("{plugin}: cannot determine running tsh version {running:?}; requires_tsh {requirement}"))?;
  anyhow::ensure!(range.matches(&version), "{plugin} requires tsh {requirement}; running tsh {running}; upgrade tsh before installing or mounting this plugin");
  Ok(())
}

/// A candidate version's core. Prerelease and build suffixes are dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
  pub major: u64,
  pub minor: u64,
  pub patch: u64,
}

impl Version {
  /// `1`, `1.2`, `1.2.3`, with an optional `-pre` or `+build` suffix; a
  /// missing component is `0`. `None` for anything else.
  pub fn parse(text: &str) -> Option<Self> {
    let core = text.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut next = |required: bool| match parts.next() {
      Some(part) => number(part),
      None if required => None,
      None => Some(0),
    };
    let version = Self {
      major: next(true)?,
      minor: next(false)?,
      patch: next(false)?,
    };
    parts.next().is_none().then_some(version)
  }
}

impl std::fmt::Display for Version {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
  }
}

fn number(part: &str) -> Option<u64> {
  if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  part.parse().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
  Exact,
  Greater,
  GreaterEq,
  Less,
  LessEq,
  Tilde,
  Caret,
}

/// One comparator: an operator and a version cut after any component.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Comparator {
  op: Op,
  major: u64,
  minor: Option<u64>,
  patch: Option<u64>,
}

/// A parsed range (see the module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range {
  raw: String,
  comparators: Vec<Comparator>,
}

impl Range {
  /// Parse a range. The error names the range and the grammar.
  pub fn parse(raw: &str) -> anyhow::Result<Self> {
    let raw = raw.trim();
    let mut comparators = Vec::new();
    if !matches!(raw, "" | "*") {
      for part in raw.split(',') {
        comparators.push(comparator(part.trim()).ok_or_else(|| {
          anyhow::anyhow!(
            "{raw:?} is not a version range (`*`, `^1.2`, `~1.2`, `1.2.*`, `>=1.4, <2`)"
          )
        })?);
      }
    }
    Ok(Self {
      raw: raw.to_string(),
      comparators,
    })
  }

  /// The range as written.
  pub fn as_str(&self) -> &str {
    &self.raw
  }

  /// Whether `version` satisfies every comparator.
  pub fn matches(&self, version: &Version) -> bool {
    self.comparators.iter().all(|c| c.matches(version))
  }

  /// Whether a contract that is only versioned by its major (a bridge,
  /// `tsh-web/1`) can satisfy the range: each comparator is cut to its major,
  /// because a contract's minor additions are additive by construction.
  pub fn admits_major(&self, major: u64) -> bool {
    let version = Version {
      major,
      minor: 0,
      patch: 0,
    };
    self.comparators.iter().all(|c| {
      Comparator {
        minor: None,
        patch: None,
        ..c.clone()
      }
      .matches(&version)
    })
  }
}

impl std::fmt::Display for Range {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(if self.raw.is_empty() { "*" } else { &self.raw })
  }
}

fn comparator(text: &str) -> Option<Comparator> {
  let (op, rest) = [
    (">=", Op::GreaterEq),
    ("<=", Op::LessEq),
    (">", Op::Greater),
    ("<", Op::Less),
    ("=", Op::Exact),
    ("~", Op::Tilde),
    ("^", Op::Caret),
  ]
  .into_iter()
  .find_map(|(prefix, op)| text.strip_prefix(prefix).map(|rest| (op, rest)))
  .unwrap_or((Op::Caret, text));
  let rest = rest.trim().split('+').next()?;
  let mut parts = rest.split('.');
  let major = number(parts.next()?)?;
  let mut component = |op: &mut Op| -> Option<Option<u64>> {
    match parts.next() {
      None => Some(None),
      Some("*" | "x" | "X") if *op == Op::Caret => {
        *op = Op::Exact;
        Some(None)
      }
      Some("*" | "x" | "X") => Some(None),
      Some(part) => number(part.split('-').next()?).map(Some),
    }
  };
  let mut op = op;
  let minor = component(&mut op)?;
  let patch = if minor.is_some() {
    component(&mut op)?
  } else {
    None
  };
  parts.next().is_none().then_some(Comparator {
    op,
    major,
    minor,
    patch,
  })
}

impl Comparator {
  fn matches(&self, v: &Version) -> bool {
    match self.op {
      Op::Exact => self.exact(v),
      Op::Greater => self.greater(v),
      Op::GreaterEq => self.exact(v) || self.greater(v),
      Op::Less => self.less(v),
      Op::LessEq => self.exact(v) || self.less(v),
      Op::Tilde => self.tilde(v),
      Op::Caret => self.caret(v),
    }
  }

  fn exact(&self, v: &Version) -> bool {
    v.major == self.major
      && self.minor.is_none_or(|m| v.minor == m)
      && self.patch.is_none_or(|p| v.patch == p)
  }

  fn greater(&self, v: &Version) -> bool {
    if v.major != self.major {
      return v.major > self.major;
    }
    let Some(minor) = self.minor else {
      return false;
    };
    if v.minor != minor {
      return v.minor > minor;
    }
    self.patch.is_some_and(|patch| v.patch > patch)
  }

  fn less(&self, v: &Version) -> bool {
    if v.major != self.major {
      return v.major < self.major;
    }
    let Some(minor) = self.minor else {
      return false;
    };
    if v.minor != minor {
      return v.minor < minor;
    }
    self.patch.is_some_and(|patch| v.patch < patch)
  }

  fn tilde(&self, v: &Version) -> bool {
    v.major == self.major
      && self.minor.is_none_or(|m| v.minor == m)
      && self.patch.is_none_or(|p| v.patch >= p)
  }

  fn caret(&self, v: &Version) -> bool {
    if v.major != self.major {
      return false;
    }
    let Some(minor) = self.minor else {
      return true;
    };
    let Some(patch) = self.patch else {
      return if self.major > 0 {
        v.minor >= minor
      } else {
        v.minor == minor
      };
    };
    if self.major > 0 {
      (v.minor, v.patch) >= (minor, patch)
    } else if minor > 0 {
      v.minor == minor && v.patch >= patch
    } else {
      v.minor == minor && v.patch == patch
    }
  }
}

/// A `name@range` requirement, as a manifest's `web.requires` spells it. A
/// bare `name` requires any version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
  pub name: String,
  pub range: Range,
}

impl Requirement {
  pub fn parse(raw: &str) -> anyhow::Result<Self> {
    let raw = raw.trim();
    let (name, range) = raw.split_once('@').unwrap_or((raw, "*"));
    anyhow::ensure!(!name.trim().is_empty(), "{raw:?} names no bundle");
    Ok(Self {
      name: name.trim().to_string(),
      range: Range::parse(range)?,
    })
  }
}

impl std::fmt::Display for Requirement {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}@{}", self.name, self.range)
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn bare_tsh_versions_are_floors_and_explicit_ranges_keep_their_meaning() {
    for running in ["0.1.57", "0.2.0", "1.0.0"] {
      super::check_requires_tsh("fleet", "0.1.57", running).unwrap();
    }
    assert!(super::check_requires_tsh("fleet", "0.1.57", "0.1.56").is_err());
    assert!(super::check_requires_tsh("fleet", "^0.1.57", "0.2.0").is_err());
    assert!(super::check_requires_tsh("fleet", ">=0.1.57, <0.2", "0.2.0").is_err());
    assert!(super::check_requires_tsh("fleet", "=0.1.57", "0.1.58").is_err());
  }

  use super::*;

  fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
  }

  fn admits(range: &str, versions: &[&str]) -> Vec<bool> {
    let range = Range::parse(range).unwrap();
    versions.iter().map(|text| range.matches(&v(text))).collect()
  }

  #[test]
  fn versions_parse_their_core_and_drop_suffixes() {
    assert_eq!(v("1"), v("1.0.0"));
    assert_eq!(v("0.2.28-nightly.4+abc"), v("0.2.28"));
    for bad in ["", "v1", "1.2.3.4", "1..2", "-1"] {
      assert_eq!(Version::parse(bad), None, "{bad}");
    }
  }

  /// Cargo's caret: the leftmost non-zero component may not change.
  #[test]
  fn caret_and_bare_ranges_keep_the_leftmost_nonzero_component() {
    let versions = ["0.1.0", "0.1.9", "0.2.0", "1.0.0", "1.9.0", "2.0.0"];
    assert_eq!(admits("^0.1", &versions), [true, true, false, false, false, false]);
    assert_eq!(admits("0.1", &versions), admits("^0.1", &versions));
    assert_eq!(admits("^1", &versions), [false, false, false, true, true, false]);
    assert_eq!(admits("^1.4", &["1.3.9", "1.4.0", "1.99.0", "2.0.0"]), [false, true, true, false]);
    assert_eq!(admits("^0.0.3", &["0.0.3", "0.0.4"]), [true, false]);
    assert_eq!(admits("^0.2.3", &["0.2.2", "0.2.3", "0.2.9", "0.3.0"]), [false, true, true, false]);
  }

  #[test]
  fn tilde_wildcard_and_operator_ranges() {
    let versions = ["1.1.9", "1.2.0", "1.2.7", "1.3.0", "2.0.0"];
    assert_eq!(admits("~1.2", &versions), [false, true, true, false, false]);
    assert_eq!(admits("1.2.*", &versions), [false, true, true, false, false]);
    assert_eq!(admits("1.*", &versions), [true, true, true, true, false]);
    assert_eq!(admits(">=1.2, <1.3", &versions), [false, true, true, false, false]);
    assert_eq!(admits(">1.2", &versions), [false, false, false, true, true]);
    assert_eq!(admits("<=1.2", &versions), [true, true, true, false, false]);
    assert_eq!(admits("=1.2.7", &versions), [false, false, true, false, false]);
    assert_eq!(admits("*", &versions), [true; 5]);
    assert_eq!(admits("", &versions), [true; 5]);
  }

  #[test]
  fn a_nightly_satisfies_its_own_line() {
    assert_eq!(admits("^0.2", &["0.2.0-nightly.3", "0.3.0-nightly.1"]), [true, false]);
  }

  #[test]
  fn unreadable_ranges_are_refused_with_the_grammar() {
    for bad in ["latest", "^", ">=", "1.2.3.4", "^1, ", "1.x.3x"] {
      let error = Range::parse(bad).unwrap_err().to_string();
      assert!(error.contains("is not a version range"), "{bad}: {error}");
    }
  }

  /// A bridge has only a major: each comparator is cut to its major.
  #[test]
  fn a_major_only_contract_is_matched_by_major() {
    let caret = Range::parse("^1.4").unwrap();
    assert!(caret.admits_major(1));
    assert!(!caret.admits_major(2));
    assert!(Range::parse(">=2").unwrap().admits_major(3));
    assert!(!Range::parse(">=2").unwrap().admits_major(1));
    assert!(Range::parse("*").unwrap().admits_major(0));
  }

  #[test]
  fn requirements_name_a_bundle_and_a_range() {
    let req = Requirement::parse("tsh-web@^1").unwrap();
    assert_eq!(req.name, "tsh-web");
    assert_eq!(req.range.as_str(), "^1");
    assert_eq!(req.to_string(), "tsh-web@^1");
    assert_eq!(Requirement::parse("tsh-web").unwrap().to_string(), "tsh-web@*");
    assert!(Requirement::parse("@^1").is_err());
    assert!(Requirement::parse("tsh-web@soon").is_err());
  }
}
