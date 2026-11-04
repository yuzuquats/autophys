#![cfg(target_os = "macos")]
#![cfg_attr(feature = "cargo-clippy", allow(unreadable_literal))]

pub(crate) mod dl;
pub mod core_foundation;
mod fsevent;

pub use fsevent::*;
