//! Completion engine + provider seam: the pane engine's **input vocabulary**,
//! the mirror of `tento-shapes`' output vocabulary.
//!
//! Completion is a **producer**: given the input buffer and caret,
//! [`CompletionEngine::update`] derives the token under the caret, queries every
//! [`Provider`] in a [`ProviderSet`], ranks the results across providers, and
//! atomically writes a [`CandidatesVm`] view model. A pane tails that file and
//! paints it — so provider latency is only ever *stale candidates*, never typing
//! lag, and the [`Provider`] seam stays synchronous.
//!
//! Scope here is the mechanism only. The pane/popup, gesture/key handling, the
//! `complete.*` host natives + gating, and any live subscription are out of
//! scope: `update` is the whole entry point today.

pub mod engine;
pub mod providers;
pub mod rank;
pub mod seam;

pub use engine::{CandidatesVm, CompletionEngine, ComposerVm, ComposerVmWriter, MAX_CANDIDATES};
pub use providers::{ListItem, ListProvider, MAX_PATH_ENTRIES, PathsProvider};
pub use rank::{MatchClass, effective_prefix, match_class, prefix_at, rank, token_at};
pub use seam::{Candidate, Provider, ProviderSet};
