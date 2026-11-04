//! autophys-rs: the Rust counterpart of the autophys Python SDK's record
//! side (crate `autophys`). It reads and writes `.ap-workbook` files, one
//! SQLite file per project, exactly as `workbook-format.md` (version 1)
//! specifies, so Rust programs, the Python SDK and the `autophys` daemon all
//! apply the same rules to the same files.
//!
//! ```no_run
//! # fn main() -> autophys::Result<()> {
//! let client = autophys::connect(Some("~/autophys"))?;
//! let wb = client.project("heated-block")?;
//! for inv in wb.investigations()? {
//!     println!("{} {}", inv.id, inv.status);
//! }
//! # let inv = wb.investigations()?.remove(0);
//! wb.investigation(&inv.id)?.approve("p-3", "james", None)?;
//! # Ok(())
//! # }
//! ```
//!
//! The names follow the Python SDK (`rust-sdk.md`). Phase 1 is the record
//! calls; the investigation loop and the numerics come in phase 2, and their
//! names are reserved: `Client::project_with`, `Workbook::investigate`,
//! `Workbook::resume` and `Investigation::run`. The record writer is
//! [`Investigation::append`], never `run`.
//!
//! The crate has no web framework or tento dependency; the daemon
//! (`autophys-cli`) maps each `/api/v1` route to one call here.

pub mod canonical;
mod client;
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
    Appended, ChainError, ConfigVersion, Head, Investigation, Project, Snapshot, VerifyReport,
    Workbook,
};

pub mod simulator;
pub mod models;
pub mod data;
pub mod fit;
pub mod sensitivity;
pub mod design;
