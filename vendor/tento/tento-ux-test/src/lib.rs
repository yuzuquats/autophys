//! tento-ux-test — UX test session model, spec, orchestration, and rendering.
//!
//! Absorbs the former `tento-llm-logger` crate (session + spec) and hosts the
//! `ux-test` subcommand group and grafted client+server trace rendering.

/// Agent-driven `--auto`: a spec's `manual: true` steps handed to an agent job
/// enqueued through tsh (`UX_AGENT_LANE`), with this process owning the browser.
pub mod agent;
/// Fixed-argv, JSON-stdin administration commands for an explicitly pinned target.
pub mod command_port;
/// Named environment profiles (`<corpus>/.envs/<name>.yaml`) — the resolver /
/// TLS / host-slug knobs that decide which server a run actually measures.
pub mod env_profile;
/// `fill_secret`: the agent asks for an allowlisted password by name, and the
/// harness types it into Google's password page; the agent never sees it.
pub mod fill_secret;
pub mod folder;
pub mod headless;
/// Mountable actix handlers for the `/_/ux-test/*` data routes — `tento-web`
/// enables the `http` feature and mounts these (auth + guards stay there).
#[cfg(feature = "http")]
pub mod http;
/// The tracked per-test run record — the one artifact in the corpus a checkout
/// that has never run anything can read.
pub mod ledger;
/// One LJSON line → one entry, tolerant of the unpaired UTF-16 surrogate
/// escapes a page's `JSON.stringify` writes for a string cut mid-pair.
pub mod ljson_line;
pub mod manifest;
pub mod orchestration;
pub mod render;
/// `ux-test.run-report/v1` — the structured result of `ux-test run --json`,
/// and `ux-test spec.accounts`.
pub mod report;
pub mod scripts;
/// A spec as a high-level sequence diagram (runner, page, server), and a run
/// laid over it with its divergences marked — what the console draws beside
/// the log, and what the judge refuses a pass over.
pub mod sequence;
pub mod session;
pub mod spec;

// Re-export the session model + spec at the crate root for back-compat with the
// former `tento-llm-logger` crate (tento-web and scripts import these paths).
pub use session::{
  LLMLogger, Session, SessionCompletion, SessionParam, SessionResult, SessionStatus,
};
pub use spec::{ExecutableAction, ScrollBurstMode, TestSpec, TestStep};

// The orchestration context + the host seam the `scripts` adapter mounts: a
// read-only env it implements, and a port it feeds from its own verb loop.
pub use env_profile::{EnvProfile, Resolver, Tls};
pub use ledger::ArtifactIdentity;
pub use orchestration::{HostPort, SessionTarget, UxTestCtx, UxTestEnv, VerbRequest};
pub use report::{
  Counts, ProfileOutcome, ProfileReport, RunReport, RunnerIdentity, Selection, SelectionKind,
  SpecAccount, SpecAccountEntry, SpecAccounts, SpecOutcome, SpecReport,
};
