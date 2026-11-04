//! The completion provider seam: one prefix in, candidate records out.
//!
//! Completion is a **producer** (like every other tsh view model): the engine
//! computes ranked candidates and writes a file the pane renders. Nothing on
//! the input or paint path waits on a provider, so the seam is deliberately
//! **synchronous** — a source that needs a slow lookup snapshots the result
//! internally and answers `complete` from that snapshot; the seam never awaits.
//! Provider latency can only ever mean *stale* candidates, never typing lag.

use serde::{Deserialize, Serialize};

/// One completion source. Built-ins (`commands`, `paths`, …) and script-added
/// sources are the same trait — the completeness test the design doc names.
pub trait Provider {
  /// Stable source name (`"commands"`, `"paths"`, …). The styling policy and
  /// the future `(complete.use …)` selector key on it.
  fn name(&self) -> &str;
  /// Candidates for `prefix`. May over-return (the engine matches and ranks);
  /// must not block — see the module note on the synchronous contract.
  fn complete(&self, prefix: &str) -> Vec<Candidate>;
}

/// One completion candidate. `score` is provider-local; the engine re-ranks
/// across providers (match class first, then provider order — see
/// [`crate::rank`]), so a source need only order its own results.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
  /// What lands in the composer buffer on accept.
  pub insert: String,
  /// Display form. Defaults to `insert` via [`Candidate::new`].
  pub label: String,
  /// Right-hand hint (a doc/summary line); empty when the source has none.
  pub detail: String,
  /// Producing provider's [`Provider::name`] — the styling policy keys on it.
  pub source: String,
  /// Provider-local rank; higher sorts first *within* one provider.
  pub score: u32,
}

impl Candidate {
  /// A candidate whose `label` mirrors `insert` and whose `detail` is empty —
  /// the common case for path/word sources.
  pub fn new(insert: impl Into<String>, source: impl Into<String>, score: u32) -> Self {
    let insert = insert.into();
    Candidate {
      label: insert.clone(),
      insert,
      detail: String::new(),
      source: source.into(),
      score,
    }
  }

  /// Set the right-hand hint (builder style).
  pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
    self.detail = detail.into();
    self
  }
}

/// An ordered provider set. **Order is meaningful**: it is the ranking
/// tiebreaker (earlier providers win an equal match class) and later becomes
/// the `(complete.use …)` policy order. Mirrors the builder style of
/// `tento_shapes::ShapeRegistry`.
#[derive(Default)]
pub struct ProviderSet {
  providers: Vec<Box<dyn Provider>>,
}

impl ProviderSet {
  /// An empty set — every provider is injected (there is no implicit "core"
  /// set; the caller decides which sources a session runs).
  pub fn new() -> Self {
    ProviderSet {
      providers: Vec::new(),
    }
  }

  /// Append a provider (builder style). The append position is its ranking
  /// weight, so call order encodes policy priority.
  pub fn with(mut self, provider: Box<dyn Provider>) -> Self {
    self.providers.push(provider);
    self
  }

  /// The providers in set order, each paired with nothing but iteration —
  /// the engine `enumerate`s this to tag candidates with their source's
  /// position for ranking.
  pub fn iter(&self) -> impl Iterator<Item = &dyn Provider> {
    self.providers.iter().map(|p| p.as_ref())
  }

  /// Count of registered providers.
  pub fn len(&self) -> usize {
    self.providers.len()
  }

  /// Whether no provider is registered.
  pub fn is_empty(&self) -> bool {
    self.providers.is_empty()
  }
}
