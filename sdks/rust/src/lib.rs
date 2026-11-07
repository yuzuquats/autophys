//! autophys: scientific calibration and local/remote workbook records in Rust.
//!
//! The scientific API includes [`project::Project`], [`fit::fit`],
//! [`sensitivity::analyze`], [`design::rank_experiments`] and
//! [`agent::Investigation`]: fit, diagnose, rank, propose, approve, attach and
//! resume. [`Client::project_with`] binds executable simulator code to a
//! [`project::ProjectWorkbook`]. Root [`Project`] and [`Investigation`] are
//! record types; scientific types live in their named modules.
//!
//! [`connect`] selects a local `.ap-workbook` collection/file or an HTTP daemon.
//! [`Client::open_project`] opens existing records; [`Client::ensure_project`]
//! explicitly creates when absent. Legacy [`Client::project`] also creates.
//! Python's name-only `project` opens existing records instead.
//!
//! ```no_run
//! # fn main() -> autophys::Result<()> {
//! let client = autophys::connect(Some("~/autophys"))?;
//! for project in client.projects()? {
//!     let wb = client.open_project(&project.name)?;
//!     println!("{} {:?}", project.name, wb.verify()?);
//! }
//! # Ok(())
//! # }
//! ```
//!
//! See `sdks/rust/README.md` and the paired Python README for source installation,
//! scientific examples, shared contracts and remaining capability gaps. Rust
//! supports recorded scientific loops today; public ephemeral/JSONL loops and
//! visual-policy orchestration remain incomplete analogies. Configuration guards
//! at run/approve/attach do not cover every public scientific tool boundary.
//!
//! The crate has no web framework or tento dependency; the daemon maps its
//! `/api/v1` record routes to this library. Direct numeric calls run locally.

pub mod canonical;
mod client;
pub mod remote;
pub use remote::HttpError;
pub mod error;
pub mod projections;
pub mod records;
pub mod schema;
pub mod validate;
mod workbook;

pub use canonical::{GENESIS, canonical, chain_hash, sha256_hex};
pub use client::{Client, SUFFIX, connect, default_home, slug};
pub use error::{Error, Result};
pub use projections::{InvestigationInfo, Proposal};
pub use records::{Logged, Record};
pub use schema::{APPLICATION_ID, VERSION as FORMAT_VERSION};
pub use validate::{Envelope, Event, Kind, MAX_ID_LEN, MAX_PAYLOAD_BYTES};
pub use workbook::{
    Appended, ChainError, ConfigVersion, Head, Investigation, MAX_DISPLAY_BYTES, Project, Snapshot,
    StoredDisplay, VerifyReport, Workbook,
};

pub mod agent;
pub mod data;
pub mod curves;
pub mod design;
pub mod fit;
pub mod models;
pub mod project;
pub mod reasoner;
pub mod sensitivity;
pub mod simulator;
pub mod synthetic;
pub mod worker;

pub mod playbook;
pub mod usage;

/// The ordered map the SDK's parameter and channel maps use.
pub use indexmap;

pub mod difflib;
pub mod measurements;
pub mod pyjson;
pub mod pyrandom;

pub mod display;
mod trajectory;
pub use display::Display;
