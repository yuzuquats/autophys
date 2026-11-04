//! Shape ids.
//!
//! A pane file's header declares its `shape` ([`crate::source::Header`]); a
//! [`PaneRenderer`](crate::renderer::PaneRenderer) declares the shapes it
//! `accepts`. Binding is by id — a renderer draws any datasource whose shape it
//! accepts, never a hardcoded pane type.

/// A health tree (a serialized `tento_nodes::NodeHealth`).
pub const TREE_V1: &str = "tree/v1";

/// A generic directed-acyclic graph: flat nodes in topo order (each carrying a
/// presentation glyph + colour, a label, generic ordered column cells, an
/// optional wrapped detail block, and DAG-structural markers) plus a
/// node-indexed edge list. Domain-free — a task board is one producer of it.
/// Rendered by the `renderer.dag` pane (git-log-style rails).
pub const GRAPH_V1: &str = "graph/v1";

/// A prompt pane. Data-model is the raw text being edited (+ a cursor index).
pub const PROMPT_V1: &str = "prompt/v1";

/// A selected node's metadata (path · status · attribute bag), written by the
/// tree on select and rendered by the detail pane.
pub const NODE_META_V1: &str = "node-meta/v1";

/// A streaming tracing log: one record per span lifecycle event (open / field /
/// event / close). Consumers fold the stream into a live tree; root-close
/// consumers emit `LjsonEntry`s on close. Written by `tento-logger`.
pub const TRACE_V1: &str = "trace/v1";

/// A host's current failing checks (`{host, errors:[{path, detail}]}`),
/// rendered by the errors section.
pub const ERRORS_V1: &str = "errors/v1";

/// A host's current utilization gauges (`{host, gauges:[{label, percent}]}`),
/// rendered by the gauges section.
pub const GAUGES_V1: &str = "gauges/v1";

/// A session status bag: the merged `tento_sh::StatusBoard` JSON object
/// (`{namespace: value}`), one record per board update. Readers use the LAST
/// record. Rendered by the status-line pane.
pub const STATUS_V1: &str = "status/v1";
