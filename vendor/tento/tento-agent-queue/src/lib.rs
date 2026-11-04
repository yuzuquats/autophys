//! A durable job queue for agent work, as a library with a backend contract.
//!
//! A product describes a job and asks a queue to run it:
//!
//! ```ignore
//! let queue = AgentQueue::from_env(QueueEnv::load()?, "news-demo")?;
//! let enqueued = queue
//!   .enqueue(NewJob::agent("news", prompt).datatype("news.summary/v1"))
//!   .await?;
//! let history = queue.history().await?;      // this producer's jobs, newest first
//! ```
//!
//! What runs them is the [`Backend`]. [`TshBackend`] hands them to tsh's
//! `tsh-agent-queue` daemon through `tsh serve`, which gives every attempt its
//! own saved tsh session and owns retries, timeouts and result decoding;
//! [`FixtureBackend`] runs a closure in-process, which is what a dev mode and
//! a test want. Neither is visible in the types a product passes around, so
//! the same product code runs against either.
//!
//! The model mirrors what the daemon stores, because a translation layer that
//! renames every field is a second place for the two to disagree.

mod backend;
mod auth;
#[cfg(feature = "cli")]
pub mod cli;
mod env;
mod error;
mod fixture;
pub mod frame;
mod model;
mod new_job;
mod queue;
mod tsh;

pub use backend::{Backend, BoxStream, Change, Enqueued, ListFilter};
pub use env::{AgentQueueName, QueueEnv, TshServeSocket};
pub use error::{QueueError, Result};
pub use fixture::FixtureBackend;
pub use model::{Attempt, Job, JobError, JobPolicy, JobResult, JobState};
pub use new_job::{AgentSpec, CancelReason, JobKind, NewJob};
pub use queue::AgentQueue;
pub use tsh::{BUNDLE, TshBackend};
