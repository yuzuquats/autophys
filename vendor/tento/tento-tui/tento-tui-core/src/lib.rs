//! `tento-tui-core` — the pure heart of the terminal-sheets architecture.
//!
//! Today this crate carries the load-bearing primitive: a **filesystem-backed
//! pane data source**. A producer writes its records to a self-describing
//! LJSON file (a header line declaring the pane's `shape`, then one JSON
//! record per line); any number of independent readers — a renderer in
//! another terminal, an agent, a compositor — consume that same file with no
//! coupling to the producer.
//!
//! See the design doc:
//! `acme/acme-console/projects/acme-sdk-2.0.project.docs/content/terminal-sheets`.
//!
//! This crate is intentionally pure: no terminal, no `crossterm`, no
//! `notify`. Those live in the runtime / backend crates.

// Windows file identity (volume serial + file index — Windows' dev/ino) is
// only reachable through std behind this nightly feature; see
// `source::file_identity`. Unix builds never see the attribute, so the crate's
// stable `rust-version` still holds everywhere except Windows.
#![cfg_attr(windows, feature(windows_by_handle))]

pub mod backend;
pub mod input;
pub mod renderer;
pub mod shape;
pub mod source;
pub mod viewport;

pub use backend::{Backend, Capabilities, Frame, PaneSlot, Rect};
pub use input::{Event, Key, KeyCode, Mods, Mouse};
pub use renderer::{PaneRenderer, RenderCache};
pub use source::{ENVELOPE_VERSION, Header, PaneReader, PaneWriter};
pub use viewport::Viewport;
