//! Stateless fold over a [`TraceOp`] stream.
//!
//! [`TraceState`] holds the in-flight span tree (open + closed-but-not-drained
//! roots, their children, recorded fields). [`apply`] is the canonical reducer
//! that every consumer runs over the stream. Materializers (`build_ljson_entry`,
//! `build_tree_value`) read state without mutating it.
//!
//! The pure-fn factoring lets independent consumers share the same fold:
//! - `RootCloseConsumer` folds, watches for root-close ops, materializes
//!   `LjsonEntry`s, and drains the closed subtree out of state.
//! - `LiveTraceConsumer` folds the same ops and materializes a `tree/v1` value
//!   each TUI tick so the renderer can show in-flight spans.
//!
//! Standalone events (no parent span) are *not* held in [`TraceState`]; emit
//! them directly via [`build_standalone_entry`] / [`event_to_tree_node`].

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::ljson::{
  LJSON_VERSION, LjsonChild, LjsonEntry, LjsonEvent, LjsonLevel, LjsonLocation, LjsonSpan,
};
use crate::stream::{CloseOp, EventOp, FieldOp, OpenOp, TraceOp};

/// Accumulated span tree built by folding [`TraceOp`]s.
#[derive(Debug, Default)]
pub struct TraceState {
  spans: BTreeMap<u64, SpanNode>,
  roots: Vec<u64>,
  /// Standalone events (parent=None) — kept for live consumers (TracePane).
  /// RootCloseConsumer intercepts these *before* `apply` so they never land
  /// here in its own state.
  standalones: Vec<EventNode>,
  /// Monotonic revision counter — every mutation the fold applies draws a
  /// fresh value, so a top-level entry's revision strictly increases whenever
  /// anything inside it changes, and no two entries ever share one.
  rev_counter: u64,
  /// Revision of each ROOT span's subtree, keyed by root id: bumped when the
  /// root (or any descendant span/event under it) is opened, patched, closed,
  /// or appended to. Consumers key render caches on
  /// [`entry_rev`](Self::entry_rev) — an unchanged revision proves the entry
  /// would fold (hence render) identically.
  root_revs: HashMap<u64, u64>,
  /// Revision per standalone, aligned index-for-index with `standalones`:
  /// stamped at push, bumped by the in-place stream/patch merges. Because
  /// values come from `rev_counter`, an index reused after a FIFO drop can
  /// never collide with the entry that previously held it.
  standalone_revs: Vec<u64>,
  /// CONTENT-derived shadow of the revisions: per root subtree / standalone,
  /// how many ops folded in and the lowest/highest file `seq` among them.
  /// Unlike revisions (fold-instance counters), these survive a re-fold of
  /// the same bytes unchanged — a consumer windowing a large file re-folds
  /// on every scroll page turn, and content-stable fingerprints are what let
  /// its render caches outlive the fold instance.
  root_stats: HashMap<u64, EntryStats>,
  standalone_stats: Vec<EntryStats>,
}

/// See [`TraceState::entry_stats`]: `(ops, lo, hi)` over the file `seq`s an
/// entry folded. Any clipping or growth of the entry's record set changes it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EntryStats {
  pub ops: u64,
  pub lo: u64,
  pub hi: u64,
}

impl EntryStats {
  fn fold(&mut self, seq: u64) {
    if self.ops == 0 {
      self.lo = seq;
      self.hi = seq;
    } else {
      self.lo = self.lo.min(seq);
      self.hi = self.hi.max(seq);
    }
    self.ops += 1;
  }
}

#[derive(Debug, Clone)]
pub struct SpanNode {
  pub id: u64,
  pub parent: Option<u64>,
  pub name: String,
  pub level: LjsonLevel,
  pub loc: LjsonLocation,
  pub fields: HashMap<String, Value>,
  pub opened_at: DateTime<Utc>,
  pub closed_at: Option<DateTime<Utc>>,
  pub elapsed_ms: Option<i64>,
  pub children: Vec<NodeChild>,
}

#[derive(Debug, Clone)]
pub enum NodeChild {
  Span(u64),
  Event(EventNode),
}

#[derive(Debug, Clone)]
pub struct EventNode {
  pub ts: DateTime<Utc>,
  pub level: LjsonLevel,
  pub loc: LjsonLocation,
  pub fields: HashMap<String, Value>,
}

impl EventNode {
  pub fn from_op(op: &EventOp) -> Self {
    EventNode {
      ts: op.ts,
      level: op.level.clone(),
      loc: op.loc.clone(),
      fields: op.fields.clone(),
    }
  }

  pub fn to_ljson(&self) -> LjsonEvent {
    LjsonEvent {
      level: self.level.clone(),
      location: self.loc.clone(),
      attributes: self.fields.clone(),
    }
  }

  /// The host-stamped `turn_seq` if present — events emitted inside
  /// `tento-sh-tui` carry this so the renderer can group everything one
  /// user input produced into a single turn. Absent on legacy traces /
  /// non-`tento-sh` hosts; absent on events that aren't turn-scoped
  /// (e.g. infrastructure events emitted outside any exec).
  pub fn turn_seq(&self) -> Option<u64> {
    extract_turn_seq(&self.fields)
  }
}

impl SpanNode {
  /// See [`EventNode::turn_seq`]. Stamped on the `shell.exec` span open
  /// in `tento-sh-tui`.
  pub fn turn_seq(&self) -> Option<u64> {
    extract_turn_seq(&self.fields)
  }
}

/// Pull `turn_seq` out of a fields map, treating both u64 JSON numbers
/// and the stringly form that the `info!(turn_seq = n)` macro can emit.
fn extract_turn_seq(fields: &HashMap<String, Value>) -> Option<u64> {
  let v = fields.get("turn_seq")?;
  v.as_u64()
    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
}

impl TraceState {
  pub fn new() -> Self {
    Self::default()
  }

  /// The current revision of a top-level entry: a value that strictly
  /// increases whenever the fold mutates that entry (or, for a root span,
  /// anything in its subtree). Two observations of an entry with equal
  /// revisions are guaranteed byte-identical; `0` for an entry the state no
  /// longer holds.
  pub fn entry_rev(&self, entry: &Entry) -> u64 {
    match entry {
      Entry::Root { id, .. } => self.root_revs.get(id).copied().unwrap_or(0),
      Entry::Standalone { index, .. } => self.standalone_revs.get(*index).copied().unwrap_or(0),
    }
  }

  /// Content-derived fingerprint of a top-level entry: how many ops folded
  /// into it (subtree included, for a root) and the lowest/highest file
  /// `seq` among them. Equal stats over a re-fold of the same byte range
  /// prove the entry folds identically; a window boundary that clips the
  /// entry on either side changes `ops` and one of the bounds.
  pub fn entry_stats(&self, entry: &Entry) -> EntryStats {
    match entry {
      Entry::Root { id, .. } => self.root_stats.get(id).copied().unwrap_or_default(),
      Entry::Standalone { index, .. } => self
        .standalone_stats
        .get(*index)
        .copied()
        .unwrap_or_default(),
    }
  }

  fn next_rev(&mut self) -> u64 {
    self.rev_counter += 1;
    self.rev_counter
  }

  /// Bump the revision of the ROOT entry that owns `span_id` (walking the
  /// parent chain). A missing span or a broken chain bumps nothing — the op
  /// didn't attach to a tracked entry.
  fn touch_root_of(&mut self, span_id: u64, seq: u64) {
    let mut id = span_id;
    loop {
      match self.spans.get(&id) {
        Some(node) => match node.parent {
          Some(parent) => id = parent,
          None => break,
        },
        None => return,
      }
    }
    let rev = self.next_rev();
    self.root_revs.insert(id, rev);
    self.root_stats.entry(id).or_default().fold(seq);
  }

  pub fn roots(&self) -> &[u64] {
    &self.roots
  }

  pub fn standalones(&self) -> &[EventNode] {
    &self.standalones
  }

  /// Total span count (root + child). Diagnostic accessor for
  /// memory-bound assertions on consumers that scope the fold to a
  /// rendered window (e.g. TracePane).
  pub fn spans_count(&self) -> usize {
    self.spans.len()
  }

  pub fn span(&self, id: u64) -> Option<&SpanNode> {
    self.spans.get(&id)
  }

  /// Roots + standalones merged in chronological order — what a renderer
  /// wants when it composes one row group per "top-level entry" instead of
  /// the two-pass roots-then-standalones layout. The sort key is each
  /// entry's start time (`opened_at` for a root span, `ts` for a
  /// standalone event); stable so events fired in the same millisecond
  /// stay in insertion order.
  pub fn entries_chronological(&self) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::with_capacity(self.roots.len() + self.standalones.len());
    for id in &self.roots {
      if let Some(node) = self.spans.get(id) {
        entries.push(Entry::Root {
          id: *id,
          ts: node.opened_at,
        });
      }
    }
    for (i, ev) in self.standalones.iter().enumerate() {
      entries.push(Entry::Standalone {
        index: i,
        ts: ev.ts,
      });
    }
    entries.sort_by_key(|e| e.ts());
    entries
  }

  /// Look up the `turn_seq` an entry was stamped with, or `None` if the
  /// entry was emitted outside any `tento-sh-tui` turn (e.g. legacy
  /// traces, infrastructure events from a separate writer).
  fn entry_turn_seq(&self, entry: &Entry) -> Option<u64> {
    match entry {
      Entry::Root { id, .. } => self.spans.get(id).and_then(|s| s.turn_seq()),
      Entry::Standalone { index, .. } => self.standalones.get(*index).and_then(|e| e.turn_seq()),
    }
  }

  /// Group [`entries_chronological`](Self::entries_chronological) into
  /// [`Turn`]s. Entries sharing a non-zero `turn_seq` coalesce into one
  /// [`Turn::Prompted`] (robust to rare interleaving where a turn's events
  /// bracket a stray same-seq entry); each contiguous run of unmarked
  /// entries (no `turn_seq`, or `turn_seq == 0`) becomes its own
  /// [`Turn::Ambient`] at its real chronological position. A marked entry
  /// closes the open ambient run, so ambient output produced between two
  /// prompted turns renders inline between them — not coalesced into one
  /// bucket at the top.
  ///
  /// The returned `Vec<Turn>` is in first-appearance order.
  pub fn turns(&self) -> Vec<Turn> {
    let chrono = self.entries_chronological();
    let mut turns: Vec<Turn> = Vec::new();
    let mut index_for_seq: HashMap<u64, usize> = HashMap::new();
    // Index of the currently-open ambient run, if any. Reset whenever a
    // marked entry is seen so the next unmarked entry opens a fresh run.
    let mut open_ambient: Option<usize> = None;
    for entry in chrono {
      match self.entry_turn_seq(&entry) {
        Some(seq) if seq != 0 => {
          open_ambient = None;
          let idx = *index_for_seq.entry(seq).or_insert_with(|| {
            turns.push(Turn::Prompted {
              seq,
              entries: Vec::new(),
            });
            turns.len() - 1
          });
          turns[idx].push(entry);
        }
        _ => {
          let idx = match open_ambient {
            Some(i) => i,
            None => {
              turns.push(Turn::Ambient {
                entries: Vec::new(),
              });
              let i = turns.len() - 1;
              open_ambient = Some(i);
              i
            }
          };
          turns[idx].push(entry);
        }
      }
    }
    turns
  }
}

/// A "turn" in the `tento-sh-tui` sense.
///
/// - [`Turn::Prompted`]: every event one input produced, sharing a
///   host-stamped non-zero `turn_seq` (the `user.input` banner, the
///   `shell.exec` span, the trailing `stdout` / `exec.body`). When an LLM
///   turn flow lands, `llm.prompt` events stamp `turn_seq` the same way and
///   fall into this variant unchanged.
/// - [`Turn::Ambient`]: a contiguous run of entries emitted while no turn
///   was active (no `turn_seq`, or `turn_seq == 0`) — idle / infrastructure
///   output, legacy traces. There can be many ambient runs, each at its real
///   chronological position.
#[derive(Debug, Clone)]
pub enum Turn {
  Prompted { seq: u64, entries: Vec<Entry> },
  Ambient { entries: Vec<Entry> },
}

impl Turn {
  /// The entries in this turn, regardless of variant.
  pub fn entries(&self) -> &[Entry] {
    match self {
      Turn::Prompted { entries, .. } | Turn::Ambient { entries } => entries,
    }
  }

  /// The host-stamped sequence for a prompted turn; `None` for ambient.
  pub fn seq(&self) -> Option<u64> {
    match self {
      Turn::Prompted { seq, .. } => Some(*seq),
      Turn::Ambient { .. } => None,
    }
  }

  /// Whether this is the [`Turn::Ambient`] variant (a prompt-less run).
  pub fn is_ambient(&self) -> bool {
    matches!(self, Turn::Ambient { .. })
  }

  /// Whether this is the [`Turn::Prompted`] variant.
  pub fn is_prompted(&self) -> bool {
    matches!(self, Turn::Prompted { .. })
  }

  /// Append an entry to whichever variant this is.
  fn push(&mut self, entry: Entry) {
    match self {
      Turn::Prompted { entries, .. } | Turn::Ambient { entries } => entries.push(entry),
    }
  }
}

/// One top-level renderable item in [`TraceState`]: a root span or a
/// standalone event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
  Root { id: u64, ts: DateTime<Utc> },
  Standalone { index: usize, ts: DateTime<Utc> },
}

impl Entry {
  pub fn ts(&self) -> DateTime<Utc> {
    match self {
      Entry::Root { ts, .. } | Entry::Standalone { ts, .. } => *ts,
    }
  }
}

impl TraceState {
  pub fn is_root(&self, id: u64) -> bool {
    self.spans.get(&id).is_some_and(|n| n.parent.is_none())
  }

  /// Whether this span has been observed but not yet closed.
  pub fn is_open(&self, id: u64) -> bool {
    self.spans.get(&id).is_some_and(|n| n.closed_at.is_none())
  }

  /// Drop the subtree rooted at `id` (used by RootCloseConsumer after emit).
  pub fn drain_subtree(&mut self, id: u64) {
    let Some(node) = self.spans.remove(&id) else {
      return;
    };
    for child in &node.children {
      if let NodeChild::Span(child_id) = child {
        self.drain_subtree(*child_id);
      }
    }
    if node.parent.is_none() {
      self.roots.retain(|r| *r != id);
      self.root_revs.remove(&id);
      self.root_stats.remove(&id);
    }
  }

  /// Enforce a soft cap on the total entry count (root spans +
  /// standalones), dropping the chronologically-oldest entry until the
  /// total is ≤ `target`. Used by consumers (TracePane) that fold an
  /// append-only stream and need to bound persistent memory.
  ///
  /// Drops:
  /// - For a root span: the entire subtree via [`drain_subtree`].
  /// - For a standalone: the event at index 0 of `standalones` (i.e.
  ///   the oldest by chronological insertion).
  ///
  /// Non-root spans never count as "top-level entries" here — they
  /// live under a root and are removed alongside it. Open root spans
  /// without a Close are still droppable; they just leave the renderer
  /// with whatever subtree was assembled at the drop moment.
  pub fn drop_oldest(&mut self, target: usize) {
    loop {
      let total = self.roots.len() + self.standalones.len();
      if total <= target {
        return;
      }
      // Compare the chronologically-oldest root vs the oldest standalone
      // and drop whichever came first.
      let oldest_root = self
        .roots
        .first()
        .and_then(|id| self.spans.get(id).map(|n| (*id, n.opened_at)));
      let oldest_standalone = self.standalones.first().map(|e| e.ts);
      match (oldest_root, oldest_standalone) {
        (Some((id, root_ts)), Some(std_ts)) => {
          if root_ts <= std_ts {
            self.drain_subtree(id);
          } else {
            self.standalones.remove(0);
            self.standalone_revs.remove(0);
            if !self.standalone_stats.is_empty() {
              self.standalone_stats.remove(0);
            }
          }
        }
        (Some((id, _)), None) => self.drain_subtree(id),
        (None, Some(_)) => {
          self.standalones.remove(0);
          self.standalone_revs.remove(0);
          if !self.standalone_stats.is_empty() {
            self.standalone_stats.remove(0);
          }
        }
        (None, None) => return, // nothing left
      }
    }
  }
}

/// Apply one trace op to the state. Pure (modulo `state` mutation) — every
/// consumer runs the same fold.
pub fn apply(state: &mut TraceState, op: &TraceOp) {
  match op {
    TraceOp::Open(o) => apply_open(state, o),
    TraceOp::Field(f) => apply_field(state, f),
    TraceOp::Event(e) => apply_event(state, e),
    TraceOp::Close(c) => apply_close(state, c),
  }
}

fn apply_open(state: &mut TraceState, op: &OpenOp) {
  state.spans.insert(
    op.id,
    SpanNode {
      id: op.id,
      parent: op.parent,
      name: op.name.clone(),
      level: op.level.clone(),
      loc: op.loc.clone(),
      fields: op.fields.clone(),
      opened_at: op.ts,
      closed_at: None,
      elapsed_ms: None,
      children: Vec::new(),
    },
  );
  match op.parent {
    Some(parent_id) => {
      if let Some(parent) = state.spans.get_mut(&parent_id) {
        parent.children.push(NodeChild::Span(op.id));
      }
    }
    None => state.roots.push(op.id),
  }
  state.touch_root_of(op.id, op.seq);
}

fn apply_field(state: &mut TraceState, op: &FieldOp) {
  let Some(node) = state.spans.get_mut(&op.id) else {
    return;
  };
  for (k, v) in &op.fields {
    node.fields.insert(k.clone(), v.clone());
  }
  state.touch_root_of(op.id, op.seq);
}

fn apply_event(state: &mut TraceState, op: &EventOp) {
  let mut event = EventNode::from_op(op);
  match op.parent {
    Some(parent_id) => {
      if state.spans.contains_key(&parent_id) {
        if let Some(parent) = state.spans.get_mut(&parent_id) {
          parent.children.push(NodeChild::Event(event));
        }
        state.touch_root_of(parent_id, op.seq);
      }
    }
    None => {
      // Adjacent ACP message/thought chunks are one logical streamed action.
      // Keep them as typed shapes so the harness component catalog—not the
      // generic trace chrome—renders both reasoning and the final response.
      if let Some((surface, update_type)) = acp_stream_identity(&event.fields)
        .map(|(surface, update_type)| (surface.to_string(), update_type.to_string()))
      {
        let merges_into_last = state.standalones.last().is_some_and(|last| {
          last.turn_seq() == event.turn_seq()
            && acp_stream_identity(&last.fields) == Some((surface.as_str(), update_type.as_str()))
        });
        if merges_into_last {
          let rev = state.next_rev();
          if let Some(last) = state.standalones.last_mut() {
            append_acp_stream_patch(&mut last.fields, &event.fields);
            advance_value_span(&mut last.fields, event.ts);
          }
          if let Some(slot) = state.standalone_revs.last_mut() {
            *slot = rev;
          }
          if let Some(stats) = state.standalone_stats.last_mut() {
            stats.fold(op.seq);
          }
          return;
        }
        // First chunk of a run: both span ends are this record's own
        // timestamp — a single-chunk action carries equal stamps, never none.
        open_value_span(&mut event.fields, event.ts);
      }

      // Reaching here means this record did NOT continue the open stream run,
      // so it settles it: reasoning ends at the moment the NEXT fact was
      // recorded, not at its own last chunk. A single-chunk thought is not a
      // zero-length thought, and the silence between the last chunk and the
      // tool call that follows was still thinking. With no successor (tail of
      // the transcript) the last chunk's stamp remains as the floor.
      let continues_last = state.standalones.last().is_some_and(|last| {
        last.turn_seq() == event.turn_seq() && acp_stream_identity(&last.fields).is_some()
      });
      if continues_last {
        if let Some(last) = state.standalones.last_mut() {
          advance_value_span(&mut last.fields, event.ts);
        }
      }

      // A permission ask and the decision that answers it are one action in
      // two states. The decided patch merges into the pending ask it settles,
      // so the transcript never shows an open question beside its answer.
      if let Some((surface, ask_id)) = acp_permission_identity(&event.fields)
        .map(|(surface, ask_id)| (surface.to_string(), ask_id))
      {
        let turn_seq = event.turn_seq();
        if let Some(pos) = state.standalones.iter().rposition(|candidate| {
          candidate.turn_seq() == turn_seq
            && acp_permission_identity(&candidate.fields)
              .is_some_and(|(s, id)| s == surface.as_str() && id == ask_id)
        }) {
          let rev = state.next_rev();
          merge_acp_tool_patch(&mut state.standalones[pos].fields, &event.fields);
          if let Some(slot) = state.standalone_revs.get_mut(pos) {
            *slot = rev;
          }
          if let Some(stats) = state.standalone_stats.get_mut(pos) {
            stats.fold(op.seq);
          }
          return;
        }
      }

      // ACP sends one logical tool action as a sequence of structured patches
      // (`tool_call`, followed by zero or more `tool_call_update`s). Keep the
      // producer records lossless, but fold those patches into one live
      // transcript action. The Lisp component then receives the latest
      // complete shape instead of rendering every transport observation.
      if let Some((surface, tool_call_id)) = acp_tool_identity(&event.fields)
        .map(|(surface, tool_call_id)| (surface.to_string(), tool_call_id.to_string()))
      {
        let turn_seq = event.turn_seq();
        if let Some(pos) = state.standalones.iter().rposition(|candidate| {
          candidate.turn_seq() == turn_seq
            && acp_tool_identity(&candidate.fields)
              == Some((surface.as_str(), tool_call_id.as_str()))
        }) {
          let rev = state.next_rev();
          merge_acp_tool_patch(&mut state.standalones[pos].fields, &event.fields);
          if let Some(slot) = state.standalone_revs.get_mut(pos) {
            *slot = rev;
          }
          if let Some(stats) = state.standalone_stats.get_mut(pos) {
            stats.fold(op.seq);
          }
          return;
        }
      }

      // Coalesce streamed model-text fragments: an `agent.delta` reply or
      // `agent.thought` reasoning event whose immediate predecessor has the
      // same kind and turn appends (verbatim) to that standalone's `message`.
      // Reply and thought runs remain distinct growing blocks.
      if let Some(stream_kind) = agent_stream_kind(&event.fields).map(str::to_string) {
        let merges_into_last = state.standalones.last().is_some_and(|last| {
          agent_stream_kind(&last.fields) == Some(stream_kind.as_str())
            && last.turn_seq() == event.turn_seq()
        });
        if merges_into_last {
          let rev = state.next_rev();
          if let Some(last) = state.standalones.last_mut() {
            append_message(&mut last.fields, &event.fields);
          }
          if let Some(slot) = state.standalone_revs.last_mut() {
            *slot = rev;
          }
          if let Some(stats) = state.standalone_stats.last_mut() {
            stats.fold(op.seq);
          }
          return;
        }
      }
      let rev = state.next_rev();
      state.standalones.push(event);
      state.standalone_revs.push(rev);
      let mut stats = EntryStats::default();
      stats.fold(op.seq);
      state.standalone_stats.push(stats);
    }
  }
}

fn acp_stream_identity(fields: &HashMap<String, Value>) -> Option<(&str, &str)> {
  let value = fields.get("value")?.as_object()?;
  let update_type = value.get("update_type")?.as_str()?;
  if !matches!(update_type, "agent_message_chunk" | "agent_thought_chunk") {
    return None;
  }
  Some((value.get("surface")?.as_str()?, update_type))
}

fn append_acp_stream_patch(
  destination: &mut HashMap<String, Value>,
  patch: &HashMap<String, Value>,
) {
  let Some(current) = destination.get_mut("value").and_then(Value::as_object_mut) else {
    return;
  };
  let Some(update) = patch.get("value").and_then(Value::as_object) else {
    return;
  };
  let old_text = current
    .get("content")
    .and_then(Value::as_object)
    .and_then(|content| content.get("text"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();
  let new_text = update
    .get("content")
    .and_then(Value::as_object)
    .and_then(|content| content.get("text"))
    .and_then(Value::as_str)
    .unwrap_or("");
  for (key, value) in update {
    current.insert(key.clone(), value.clone());
  }
  if !old_text.is_empty() || !new_text.is_empty() {
    let mut content = current
      .get("content")
      .and_then(Value::as_object)
      .cloned()
      .unwrap_or_default();
    content.insert(
      "text".to_string(),
      Value::String(format!("{old_text}{new_text}")),
    );
    current.insert("content".to_string(), Value::Object(content));
  }
  if let Some(kind) = patch.get("kind") {
    destination.insert("kind".to_string(), kind.clone());
  }
}

/// Identity of an ACP tool action carried in a structured `value` field.
///
/// The transport records both the initial `tool_call` and subsequent
/// `tool_call_update` values. They share a surface and `toolCallId`; other
/// structured ACP shapes intentionally do not match this reducer.
fn acp_tool_identity(fields: &HashMap<String, Value>) -> Option<(&str, &str)> {
  let value = fields.get("value")?.as_object()?;
  match value.get("update_type").and_then(Value::as_str)? {
    "tool_call" | "tool_call_update" => Some((
      value.get("surface")?.as_str()?,
      value.get("toolCallId")?.as_str()?,
    )),
    _ => None,
  }
}

/// Stamp a freshly pushed stream action's span from its record's own
/// timestamp. Both ends start equal; folding a later chunk advances the end.
/// The stamps are recorded facts — the fold never invents a clock.
fn open_value_span(fields: &mut HashMap<String, Value>, ts: DateTime<Utc>) {
  let Some(value) = fields.get_mut("value").and_then(Value::as_object_mut) else {
    return;
  };
  let ms = ts.timestamp_millis();
  value.insert("started_ms".to_string(), Value::from(ms));
  value.insert("ended_ms".to_string(), Value::from(ms));
}

/// Advance a folded stream action's span end to the newest chunk's timestamp.
/// A run whose first chunk predates timestamping still gains a best-effort
/// start from the first stamped chunk rather than reporting an open start.
fn advance_value_span(fields: &mut HashMap<String, Value>, ts: DateTime<Utc>) {
  let Some(value) = fields.get_mut("value").and_then(Value::as_object_mut) else {
    return;
  };
  let ms = ts.timestamp_millis();
  if !value.contains_key("started_ms") {
    value.insert("started_ms".to_string(), Value::from(ms));
  }
  value.insert("ended_ms".to_string(), Value::from(ms));
}

/// Identity of an ACP permission action carried in a structured `value` field.
///
/// A `permission_request` ask and its decided patch share the ask's durable
/// identity: `ask_key` — the protocol's own id for the ask (ACP: the tool
/// call id) — falling back to the wire `requestId` for agents that advertise
/// no key. Wire ids only correlate outstanding requests: a restarted child
/// reuses them, so two DIFFERENT asks in one turn can share a requestId; the
/// key makes the merge exact, and the `k:`/`r:` prefixes keep the two id
/// spaces from colliding. Matches are additionally scoped to one turn at the
/// call site.
fn acp_permission_identity(fields: &HashMap<String, Value>) -> Option<(&str, String)> {
  let value = fields.get("value")?.as_object()?;
  if value.get("update_type").and_then(Value::as_str)? != "permission_request" {
    return None;
  }
  let surface = value.get("surface")?.as_str()?;
  let id = match value.get("ask_key").and_then(Value::as_str) {
    Some(key) => format!("k:{key}"),
    None => format!("r:{}", value.get("requestId").and_then(Value::as_i64)?),
  };
  Some((surface, id))
}

/// Apply one ACP patch to the complete observer-owned action shape.
///
/// ACP patch fields replace fields of the same name and omitted fields retain
/// their previous value. Presentation routing follows the newest datatype.
fn merge_acp_tool_patch(destination: &mut HashMap<String, Value>, patch: &HashMap<String, Value>) {
  if let (Some(current), Some(update)) = (
    destination.get_mut("value").and_then(Value::as_object_mut),
    patch.get("value").and_then(Value::as_object),
  ) {
    for (key, value) in update {
      // Both sides always carry a `data` object, but an update's is sparse
      // (result/status only) while the start's holds the action's identity
      // (title, tool name, arguments). Union the keys so a progress patch
      // can never erase the identity the renderer keys its faces off.
      if key == "data" {
        if let (Some(current_data), Some(update_data)) = (
          current.get_mut("data").and_then(Value::as_object_mut),
          value.as_object(),
        ) {
          for (data_key, data_value) in update_data {
            current_data.insert(data_key.clone(), data_value.clone());
          }
          continue;
        }
      }
      current.insert(key.clone(), value.clone());
    }
  }
  if let Some(kind) = patch.get("kind") {
    destination.insert("kind".to_string(), kind.clone());
  }
}

/// The kind of a streamed model-text fragment (vs. a tool-progress `stdout`
/// line, which is not coalesced so it stays one row).
fn agent_stream_kind(fields: &HashMap<String, Value>) -> Option<&str> {
  match fields.get("kind").and_then(Value::as_str) {
    Some(kind @ ("agent.delta" | "agent.thought")) => Some(kind),
    _ => None,
  }
}

/// Append `src`'s `message` to `dst`'s `message` verbatim (no separator — the
/// deltas are continuous stream fragments, so concatenation reconstructs the
/// exact text including the model's own newlines).
fn append_message(dst: &mut HashMap<String, Value>, src: &HashMap<String, Value>) {
  let add = src.get("message").and_then(Value::as_str).unwrap_or("");
  let mut combined = dst
    .get("message")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();
  combined.push_str(add);
  dst.insert("message".to_string(), Value::String(combined));
}

fn apply_close(state: &mut TraceState, op: &CloseOp) {
  let Some(node) = state.spans.get_mut(&op.id) else {
    return;
  };
  node.closed_at = Some(op.ts);
  node.elapsed_ms = op.elapsed_ms;
  state.touch_root_of(op.id, op.seq);
}

/// Materialize a closed (or in-flight) span subtree as an `LjsonEntry`.
/// Returns `None` if the span isn't present in state.
pub fn build_ljson_entry(state: &TraceState, root_id: u64, session_id: Uuid) -> Option<LjsonEntry> {
  let root_span = build_ljson_span(state, root_id)?;
  Some(LjsonEntry {
    v: LJSON_VERSION,
    ts: Utc::now(),
    session_id,
    origin: None,
    root_span,
  })
}

fn build_ljson_span(state: &TraceState, id: u64) -> Option<LjsonSpan> {
  let node = state.spans.get(&id)?;
  let children = node
    .children
    .iter()
    .filter_map(|c| match c {
      NodeChild::Span(child_id) => build_ljson_span(state, *child_id).map(LjsonChild::Span),
      NodeChild::Event(ev) => Some(LjsonChild::Event(ev.to_ljson())),
    })
    .collect();
  Some(LjsonSpan {
    id: node.id,
    name: node.name.clone(),
    level: node.level.clone(),
    duration_ms: node.elapsed_ms,
    location: node.loc.clone(),
    attributes: node.fields.clone(),
    children,
  })
}

/// Wrap a standalone event (parent=None) in a synthetic root span so it can
/// flow through the same `LjsonEntry`-shaped consumers.
pub fn build_standalone_entry(op: &EventOp, session_id: Uuid) -> LjsonEntry {
  let event = LjsonEvent {
    level: op.level.clone(),
    location: op.loc.clone(),
    attributes: op.fields.clone(),
  };
  LjsonEntry {
    v: LJSON_VERSION,
    ts: Utc::now(),
    session_id,
    origin: None,
    root_span: LjsonSpan {
      id: 0,
      name: "standalone".to_string(),
      level: op.level.clone(),
      duration_ms: None,
      location: op.loc.clone(),
      attributes: HashMap::new(),
      children: vec![LjsonChild::Event(event)],
    },
  }
}

/// Materialize the full live forest in `tree/v1` shape (one wrapping root
/// node whose children are the in-flight roots, followed by any standalone
/// events). Used by the live TUI pane when it wants one combined tree.
pub fn build_tree_value(state: &TraceState) -> Value {
  let mut children: Vec<Value> = state
    .roots
    .iter()
    .filter_map(|id| span_tree_node(state, *id))
    .collect();
  for ev in &state.standalones {
    children.push(event_to_tree_node(ev));
  }
  Value::Object(
    [
      ("title".to_string(), Value::String("trace".to_string())),
      ("children".to_string(), Value::Array(children)),
    ]
    .into_iter()
    .collect(),
  )
}

/// Build the `tree/v1` representation of one span subtree. Returns `None`
/// when `id` is not present in `state`.
pub fn span_tree_node(state: &TraceState, id: u64) -> Option<Value> {
  let node = state.spans.get(&id)?;
  let mut attrs: Map<String, Value> = Map::new();
  attrs.insert("level".to_string(), Value::String(level_word(&node.level)));
  attrs.insert(
    "ts".to_string(),
    Value::String(node.opened_at.format("%H:%M:%S%.3f").to_string()),
  );
  if let Some(ms) = node.elapsed_ms {
    attrs.insert("elapsed".to_string(), Value::String(format!("{ms}ms")));
  }
  for (k, v) in &node.fields {
    attrs.insert(k.clone(), to_attr_string(v));
  }

  let mut children: Vec<Value> = Vec::with_capacity(node.children.len());
  for child in &node.children {
    match child {
      NodeChild::Span(child_id) => {
        if let Some(v) = span_tree_node(state, *child_id) {
          children.push(v);
        }
      }
      NodeChild::Event(ev) => children.push(event_to_tree_node(ev)),
    }
  }

  let title = node
    .fields
    .get("message")
    .and_then(Value::as_str)
    .map(|m| format!("{} · {}", node.name, m))
    .unwrap_or_else(|| node.name.clone());

  let mut obj = Map::new();
  obj.insert("title".to_string(), Value::String(title));
  obj.insert("attrs".to_string(), Value::Object(attrs));
  obj.insert("children".to_string(), Value::Array(children));
  Some(Value::Object(obj))
}

/// `tree/v1` representation of a single (parented) event, used both by
/// [`build_tree_value`] and by the live pane for standalone events.
///
/// If the event carries a structured `value` attribute — a real JSON
/// object/array (what `info!(value_json = %v)` yields after the capture
/// boundary's `_json` fold) or, in pre-fix session files, a string holding
/// JSON-serialized data — it is walked into child rows so the TracePane
/// can render the structure recursively. Without per-`kind` code, any
/// command returning a structured `Value` gets sensible rendering.
pub fn event_to_tree_node(ev: &EventNode) -> Value {
  let mut attrs: Map<String, Value> = Map::new();
  attrs.insert("level".to_string(), Value::String(level_word(&ev.level)));
  attrs.insert(
    "ts".to_string(),
    Value::String(ev.ts.format("%H:%M:%S%.3f").to_string()),
  );
  // Auto-fill `source` from the event's recorded location when the call site
  // didn't pass it as a tracing field. Last 3 path components keep the
  // column from blowing up on absolute paths.
  if !ev.fields.contains_key("source") {
    if let Some(src) = short_source(&ev.loc) {
      attrs.insert("source".to_string(), Value::String(src));
    }
  }
  for (k, v) in &ev.fields {
    // Skip keys that are already represented elsewhere on the row:
    //   - `message` becomes the title (would duplicate as the message column)
    //   - `kind` is the routing key (the renderer's preset reflects it)
    //   - `value` becomes the structured-children subtree
    if matches!(k.as_str(), "message" | "kind" | "value") {
      continue;
    }
    attrs.insert(k.clone(), to_attr_string(v));
  }

  let children: Vec<Value> =
    if let Some(parsed) = ev.fields.get("value").and_then(parse_structured_value) {
      structured_value_children(&parsed, "")
    } else {
      // Surface any non-meta fields as child rows. With a message present the
      // message is the row title and the fields are structured context under
      // it; without one, the fields are the only thing the row has to say
      // (avoids the bare `(event)` fallback). `field_children` returns empty
      // when nothing's left after filtering.
      field_children(ev)
    };

  let title = ev
    .fields
    .get("message")
    .and_then(Value::as_str)
    .map(str::to_string)
    .unwrap_or_else(|| structured_title(ev, &children));

  let mut obj = Map::new();
  obj.insert("title".to_string(), Value::String(title));
  obj.insert("attrs".to_string(), Value::Object(attrs));
  if !children.is_empty() {
    obj.insert("children".to_string(), Value::Array(children));
  }
  Value::Object(obj)
}

/// Pull the event's non-meta fields out as child tree rows. Excludes
/// `message` / `value` / `kind` (already handled elsewhere) and the
/// `source` we auto-derive from the location.
fn field_children(ev: &EventNode) -> Vec<Value> {
  let mut keys: Vec<&String> = ev
    .fields
    .keys()
    .filter(|k| !matches!(k.as_str(), "message" | "value" | "kind" | "source"))
    .collect();
  keys.sort(); // deterministic order — fields come out of the HashMap unordered
  keys
    .into_iter()
    .map(|k| structured_field_node(k, &ev.fields[k], k))
    .collect()
}

/// Last 2 path components + line — e.g.
/// `tento-logger/src/lib.rs:141`. Plain text (no ANSI codes).
fn short_source(loc: &LjsonLocation) -> Option<String> {
  let file = loc.file.as_ref()?;
  let parts: Vec<&str> = file.rsplit('/').take(2).collect();
  let short: String = parts.into_iter().rev().collect::<Vec<_>>().join("/");
  Some(match loc.line {
    Some(line) => format!("{short}:{line}"),
    None => short,
  })
}

/// Accept the value either as already-typed JSON (Object/Array — when a
/// future tracing layer preserves shape) or as a JSON-encoded string (the
/// common `%value` path today).
fn parse_structured_value(raw: &Value) -> Option<Value> {
  match raw {
    Value::Object(_) | Value::Array(_) => Some(raw.clone()),
    Value::String(s) => serde_json::from_str::<Value>(s).ok(),
    _ => None,
  }
}

/// Walk a JSON value into a Vec of child tree-nodes:
/// - Object → one child per key (key in title, value rendered recursively).
/// - Array  → one child per index (index in title, value rendered
///   recursively).
/// - Scalar → a single child labelled "value: …".
///
/// `parent_path` is the dotted addressing prefix (root = `""`); each
/// emitted node carries the joined path in its `attrs._path` so the
/// TUI can address subtrees for expand/collapse.
fn structured_value_children(v: &Value, parent_path: &str) -> Vec<Value> {
  match v {
    Value::Object(map) => map
      .iter()
      .filter(|(k, _)| !is_meta_key(k))
      .map(|(k, sub)| structured_field_node(k, sub, &join_path(parent_path, k)))
      .collect(),
    Value::Array(items) => items
      .iter()
      .enumerate()
      .map(|(i, sub)| {
        let seg = i.to_string();
        structured_field_node(&seg, sub, &join_path(parent_path, &seg))
      })
      .collect(),
    other => vec![structured_field_node(
      "value",
      other,
      &join_path(parent_path, "value"),
    )],
  }
}

/// Metadata keys on tree-node input values that should be hoisted into
/// the emitted node's `attrs` rather than rendered as children. By
/// convention these are `_`-prefixed: `_open` (default-open hint for
/// the TUI), and any future `_…` field a producer chooses to stash.
fn is_meta_key(k: &str) -> bool {
  k.starts_with('_')
}

/// Join a parent path with a child segment using `.`. An empty parent
/// returns the segment as-is.
fn join_path(parent: &str, segment: &str) -> String {
  if parent.is_empty() {
    segment.to_string()
  } else {
    format!("{parent}.{segment}")
  }
}

fn structured_field_node(key: &str, value: &Value, path: &str) -> Value {
  use tento_term::Style;
  use tento_term::nav::style_node_key;

  // The key gets bolded (with any leading `.` separator dimmed) — see
  // `tento_term::nav::style_node_key`. Secondary chrome (descriptions,
  // count chips, the `args:` label) gets dimmed so the eye can lock
  // onto the command names first.
  let styled_key = style_node_key(key);

  let mut obj = Map::new();
  match value {
    // Special case: an Object carrying a `description` string field
    // reads best with the description folded into the title (no
    // `description:` prefix). Sibling fields (e.g. `args`) become
    // children. This is the shape `tento-sh`'s help payload uses for
    // each command leaf; it generalises to any `{description, …}`
    // record without a separate name field.
    Value::Object(map) if has_inline_description(map) => {
      let desc = map
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
      let dim_tail = Style::Dimmed.paint(&format!(" — {desc}"));
      obj.insert(
        "title".to_string(),
        Value::String(format!("{styled_key}{dim_tail}")),
      );
      let mut siblings: Vec<(&String, &Value)> = map
        .iter()
        .filter(|(k, _)| k.as_str() != "description" && !is_meta_key(k))
        .collect();
      siblings.sort_by(|(a, _), (b, _)| a.cmp(b));
      if !siblings.is_empty() {
        let children: Vec<Value> = siblings
          .into_iter()
          .map(|(k, v)| structured_field_node(k, v, &join_path(path, k)))
          .collect();
        obj.insert("children".to_string(), Value::Array(children));
      }
    }
    Value::Object(_) | Value::Array(_) => {
      // The title is just the styled key — the chevron (`▾`/`▸`) the
      // renderer adds already conveys collapsibility, and the user can
      // count children directly when expanded. A `(N fields)` chip
      // was here historically but added no signal for either help
      // trees (where command-count under `acme` is irrelevant) or
      // normal tracing trees (where the user sees the fields).
      obj.insert("title".to_string(), Value::String(styled_key.clone()));
      obj.insert(
        "children".to_string(),
        Value::Array(structured_value_children(value, path)),
      );
    }
    Value::Null => {
      let tail = Style::Dimmed.paint(": null");
      obj.insert(
        "title".to_string(),
        Value::String(format!("{styled_key}{tail}")),
      );
    }
    Value::String(s) => {
      // For the `args` inline-row, dim just the `args:` label so the
      // arg list itself reads plain. Every other scalar key gets a
      // dimmed `: ` separator for consistency.
      let sep = Style::Dimmed.paint(": ");
      obj.insert(
        "title".to_string(),
        Value::String(format!("{styled_key}{sep}{s}")),
      );
    }
    other => {
      let sep = Style::Dimmed.paint(": ");
      obj.insert(
        "title".to_string(),
        Value::String(format!("{styled_key}{sep}{other}")),
      );
    }
  }
  let mut attrs = Map::new();
  attrs.insert("_path".to_string(), Value::String(path.to_string()));
  // Hoist any `_X` metadata fields on the input into `attrs`,
  // stringifying scalars so they fit the
  // `TreeNode.attrs: IndexMap<String, String>` shape the downstream
  // TreeRenderer deserializes into. Today's only consumer is `_open`
  // (TracePane's default-open hint for `decorate_for_collapse`); the
  // pass-through is generic so future metadata fields just work.
  if let Value::Object(map) = value {
    for (k, v) in map.iter() {
      if is_meta_key(k) && k != "_path" {
        let stringified = match v {
          Value::String(s) => s.clone(),
          Value::Bool(b) => b.to_string(),
          Value::Number(n) => n.to_string(),
          other => other.to_string(),
        };
        attrs.insert(k.clone(), Value::String(stringified));
      }
    }
  }
  obj.insert("attrs".to_string(), Value::Object(attrs));
  Value::Object(obj)
}

/// True when `map` has a `description` string field — the marker for
/// the "title-inlined record" shape.
fn has_inline_description(map: &Map<String, Value>) -> bool {
  map.get("description").and_then(|v| v.as_str()).is_some()
}

/// Fallback title when the event has no `message` but does carry a
/// structured `value`: summarize the top-level shape.
fn structured_title(ev: &EventNode, children: &[Value]) -> String {
  let count = children.len();
  let kind = ev
    .fields
    .get("kind")
    .and_then(Value::as_str)
    .unwrap_or("event");
  if count == 0 {
    format!("({kind})")
  } else if count == 1 {
    format!("({kind} · 1 item)")
  } else {
    format!("({kind} · {count} items)")
  }
}

fn level_word(level: &LjsonLevel) -> String {
  match level {
    LjsonLevel::Trace => "trace",
    LjsonLevel::Debug => "debug",
    LjsonLevel::Info => "info",
    LjsonLevel::Warn => "warn",
    LjsonLevel::Error => "error",
  }
  .to_string()
}

fn to_attr_string(v: &Value) -> Value {
  match v {
    Value::String(_) => v.clone(),
    other => Value::String(other.to_string()),
  }
}

/// Pick a column-preset key from an [`LjsonEntry`].
pub fn route_kind(entry: &LjsonEntry) -> &'static str {
  classify_span(&entry.root_span.name, &entry.root_span.attributes)
}

/// Pick a column-preset key from a span's name + fields. Shared between
/// `LjsonEntry`-based consumers and live TUI consumers (which work over
/// `SpanNode`s).
///
/// Classification is purely by the explicit `kind` field: producers declare
/// their own shape (`kind = "http.request"`, `"shell.exec"`, `"script.ts.check"`,
/// …). There is **no** name-matching or field-sniffing — routing never depends
/// on domain-specific field shapes (no `http.method` / `severity`+`file`
/// heuristics), so this carries zero knowledge of any particular producer.
///
/// A span that doesn't declare `kind` — legacy recordings, foreign logs, or
/// otherwise misbehaving input — degrades elegantly to the generic `event`
/// preset (via [`classify_kind`]'s own unknown-fallback): it renders the span's
/// title plus its fields as a tree, which is readable and structure-preserving.
/// It is never `compact`, whose collapse would hide exactly those fields. The
/// `name` is retained in the signature for call-site symmetry but no longer
/// influences routing.
pub fn classify_span(_name: &str, fields: &HashMap<String, Value>) -> &'static str {
  fields
    .get("kind")
    .and_then(Value::as_str)
    .map(classify_kind)
    .unwrap_or("event")
}

/// Pick a column-preset key from a `kind` string. The mapping is idempotent
/// for known kinds and folds unknown values onto the `event` preset (rather
/// than `compact`, whose `(collapse :on)` would hide leaf child rows under
/// ok-status parents — fine for the fleet tree pane, wrong for trace
/// events whose structured fields the user needs to see). Public so TUI
/// consumers (e.g. callers of [`crate::fold::classify_span`]) can route
/// bare event kinds the same way span classification does.
pub fn classify_kind(kind: &str) -> &'static str {
  match kind {
    "http.request" => "http.request",
    "shell.exec" => "shell.exec",
    "script.ts.check" => "script.ts.check",
    "event" => "event",
    "exec.body" => "exec.body",
    "user.input" => "user.input",
    "stdout" => "stdout",
    "agent.delta" => "agent.delta",
    "agent.thought" => "agent.thought",
    "agent.turn" => "agent.turn",
    "unit.result" => "unit.result",
    "approval.pending" => "approval.pending",
    "approval.decided" => "approval.decided",
    "session.start" => "session.start",
    "engine.startup" => "engine.startup",
    _ => "event",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::ljson::LjsonLevel;
  use crate::stream::{CloseOp, EventOp, OpenOp, TraceOp};

  fn loc() -> LjsonLocation {
    LjsonLocation {
      file: Some("test.rs".into()),
      line: Some(1),
    }
  }
  fn ts() -> DateTime<Utc> {
    Utc::now()
  }

  fn open(seq: u64, id: u64, parent: Option<u64>, name: &str) -> TraceOp {
    TraceOp::Open(OpenOp {
      seq,
      id,
      parent,
      session_id: None,
      ts: ts(),
      name: name.into(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields: HashMap::new(),
    })
  }
  fn close(seq: u64, id: u64, ms: i64) -> TraceOp {
    TraceOp::Close(CloseOp {
      seq,
      id,
      session_id: None,
      ts: ts(),
      elapsed_ms: Some(ms),
    })
  }
  fn event(seq: u64, parent: Option<u64>, msg: &str) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("message".into(), serde_json::json!(msg));
    TraceOp::Event(EventOp {
      seq,
      parent,
      session_id: None,
      ts: ts(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    })
  }

  /// Standalone event stamped with a `turn_seq` field, mimicking what
  /// `tento-sh-tui` emits for `user.input`, trailing `stdout` /
  /// `exec.body` siblings, and `command.not_found` errors.
  fn event_in_turn(seq: u64, turn_seq: u64, kind: &str) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!(kind));
    fields.insert("turn_seq".into(), serde_json::json!(turn_seq));
    TraceOp::Event(EventOp {
      seq,
      parent: None,
      session_id: None,
      ts: ts(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    })
  }

  /// Standalone event with `kind` + `turn_seq` + `message` (for stdout /
  /// agent.delta coalescing tests).
  fn msg_in_turn(seq: u64, turn_seq: u64, kind: &str, msg: &str) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!(kind));
    fields.insert("turn_seq".into(), serde_json::json!(turn_seq));
    fields.insert("message".into(), serde_json::json!(msg));
    TraceOp::Event(EventOp {
      seq,
      parent: None,
      session_id: None,
      ts: ts(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    })
  }

  fn acp_tool_patch(seq: u64, turn_seq: u64, datatype: &str, value: Value) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!(datatype));
    fields.insert("turn_seq".into(), serde_json::json!(turn_seq));
    fields.insert("value".into(), value);
    TraceOp::Event(EventOp {
      seq,
      parent: None,
      session_id: None,
      ts: ts(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    })
  }

  fn last_msg(state: &TraceState, i: usize) -> String {
    state.standalones()[i]
      .fields
      .get("message")
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string()
  }

  #[test]
  fn agent_delta_fragments_coalesce_into_one_growing_standalone() {
    let mut state = TraceState::new();
    for (i, frag) in ["Hello ", "world", "\nsecond line"].iter().enumerate() {
      apply(&mut state, &msg_in_turn(i as u64, 1, "agent.delta", frag));
    }
    assert_eq!(
      state.standalones().len(),
      1,
      "deltas coalesce into one entry"
    );
    assert_eq!(last_msg(&state, 0), "Hello world\nsecond line");
  }

  #[test]
  fn thought_fragments_coalesce_but_stay_separate_from_the_reply() {
    let mut state = TraceState::new();
    apply(
      &mut state,
      &msg_in_turn(0, 1, "agent.thought", "Inspecting "),
    );
    apply(&mut state, &msg_in_turn(1, 1, "agent.thought", "the file."));
    apply(
      &mut state,
      &msg_in_turn(2, 1, "agent.delta", "The file is clean."),
    );
    assert_eq!(state.standalones().len(), 2);
    assert_eq!(last_msg(&state, 0), "Inspecting the file.");
    assert_eq!(last_msg(&state, 1), "The file is clean.");
  }

  #[test]
  fn stdout_between_deltas_breaks_the_run() {
    let mut state = TraceState::new();
    apply(&mut state, &msg_in_turn(0, 1, "agent.delta", "thinking"));
    apply(&mut state, &msg_in_turn(1, 1, "stdout", "read a.rs")); // tool progress
    apply(&mut state, &msg_in_turn(2, 1, "agent.delta", "done"));
    assert_eq!(state.standalones().len(), 3, "the tool line splits the run");
    assert_eq!(last_msg(&state, 0), "thinking");
    assert_eq!(last_msg(&state, 2), "done");
  }

  #[test]
  fn deltas_in_different_turns_do_not_coalesce() {
    let mut state = TraceState::new();
    apply(&mut state, &msg_in_turn(0, 1, "agent.delta", "turn one"));
    apply(&mut state, &msg_in_turn(1, 2, "agent.delta", "turn two"));
    assert_eq!(state.standalones().len(), 2);
  }

  #[test]
  fn acp_tool_patches_become_one_complete_action_shape() {
    let mut state = TraceState::new();
    let patches = [
      serde_json::json!({
        "datatype": "harness.claude.tool-call/v1",
        "surface": "claude",
        "update_type": "tool_call",
        "toolCallId": "toolu_7",
        "kind": "execute",
        "title": "Terminal",
        "status": "pending"
      }),
      serde_json::json!({
        "datatype": "harness.claude.tool-call/v1",
        "surface": "claude",
        "update_type": "tool_call_update",
        "toolCallId": "toolu_7",
        "title": "ls -la /Users/james"
      }),
      serde_json::json!({
        "datatype": "harness.claude.tool-call/v1",
        "surface": "claude",
        "update_type": "tool_call_update",
        "toolCallId": "toolu_7",
        "status": "completed",
        "content": [{
          "type": "content",
          "content": {"type": "text", "text": "List home directory contents"}
        }]
      }),
    ];
    for (seq, patch) in patches.into_iter().enumerate() {
      apply(
        &mut state,
        &acp_tool_patch(seq as u64, 4, "harness.claude.tool-call/v1", patch),
      );
    }

    assert_eq!(state.standalones().len(), 1);
    let shape = state.standalones()[0].fields["value"].as_object().unwrap();
    assert_eq!(shape["toolCallId"], "toolu_7");
    assert_eq!(shape["kind"], "execute");
    assert_eq!(shape["title"], "ls -la /Users/james");
    assert_eq!(shape["status"], "completed");
    assert_eq!(
      shape["content"][0]["content"]["text"],
      "List home directory contents"
    );
  }

  #[test]
  fn sparse_tool_updates_union_into_the_starts_data() {
    // Recorded envelopes nest the semantic payload under `data`; a progress
    // update's is sparse (status/result only). The identity the start
    // declared must survive the merge — it is what the renderer's native
    // faces key off.
    let mut state = TraceState::new();
    let patches = [
      serde_json::json!({
        "datatype": "harness.tool-call/v1",
        "surface": "claude",
        "update_type": "tool_call",
        "toolCallId": "toolu_9",
        "data": {
          "id": "toolu_9",
          "tool": "read",
          "toolName": "Read",
          "title": "Read File",
          "rawInput": {"file_path": "/tmp/a.rs"},
          "status": "pending"
        }
      }),
      serde_json::json!({
        "datatype": "harness.tool-call/v1",
        "surface": "claude",
        "update_type": "tool_call_update",
        "toolCallId": "toolu_9",
        "data": {
          "id": "toolu_9",
          "status": "completed",
          "result": [{"type": "content", "content": {"type": "text", "text": "l1"}}]
        }
      }),
    ];
    for (seq, patch) in patches.into_iter().enumerate() {
      apply(
        &mut state,
        &acp_tool_patch(seq as u64, 4, "harness.tool-call/v1", patch),
      );
    }

    assert_eq!(state.standalones().len(), 1);
    let data = &state.standalones()[0].fields["value"]["data"];
    assert_eq!(data["title"], "Read File");
    assert_eq!(data["toolName"], "Read");
    assert_eq!(data["rawInput"]["file_path"], "/tmp/a.rs");
    assert_eq!(data["status"], "completed");
    assert_eq!(data["result"][0]["content"]["text"], "l1");
  }

  #[test]
  fn acp_thought_and_response_form_ordered_typed_actions() {
    let mut state = TraceState::new();
    for (seq, update_type, datatype, text) in [
      (
        0,
        "agent_thought_chunk",
        "harness.claude.thinking/v1",
        "Inspecting ",
      ),
      (
        1,
        "agent_thought_chunk",
        "harness.claude.thinking/v1",
        "the files.",
      ),
      (
        2,
        "agent_message_chunk",
        "harness.claude.assistant/v1",
        "Everything ",
      ),
      (
        3,
        "agent_message_chunk",
        "harness.claude.assistant/v1",
        "looks good.",
      ),
    ] {
      apply(
        &mut state,
        &acp_tool_patch(
          seq,
          8,
          datatype,
          serde_json::json!({
            "datatype": datatype,
            "surface": "claude",
            "update_type": update_type,
            "content": {"type": "text", "text": text}
          }),
        ),
      );
    }

    assert_eq!(state.standalones().len(), 2);
    assert_eq!(
      state.standalones()[0].fields["value"]["datatype"],
      "harness.claude.thinking/v1"
    );
    assert_eq!(
      state.standalones()[0].fields["value"]["content"]["text"],
      "Inspecting the files."
    );
    assert_eq!(
      state.standalones()[1].fields["value"]["datatype"],
      "harness.claude.assistant/v1"
    );
    assert_eq!(
      state.standalones()[1].fields["value"]["content"]["text"],
      "Everything looks good."
    );
  }

  #[test]
  fn acp_tool_actions_do_not_merge_across_ids_or_turns() {
    let mut state = TraceState::new();
    for (seq, turn_seq, id) in [(0, 1, "a"), (1, 1, "b"), (2, 2, "a")] {
      apply(
        &mut state,
        &acp_tool_patch(
          seq,
          turn_seq,
          "harness.claude.tool-call/v1",
          serde_json::json!({
            "datatype": "harness.claude.tool-call/v1",
            "surface": "claude",
            "update_type": "tool_call",
            "toolCallId": id,
            "status": "pending"
          }),
        ),
      );
    }
    assert_eq!(state.standalones().len(), 3);
  }

  #[test]
  fn folded_stream_actions_carry_their_span() {
    let chunk = |seq: u64, ms: i64, text: &str| {
      let mut fields = HashMap::new();
      fields.insert(
        "kind".into(),
        serde_json::json!("harness.claude.thinking/v1"),
      );
      fields.insert("turn_seq".into(), serde_json::json!(4));
      fields.insert(
        "value".into(),
        serde_json::json!({
          "datatype": "harness.claude.thinking/v1",
          "surface": "claude",
          "update_type": "agent_thought_chunk",
          "content": {"type": "text", "text": text}
        }),
      );
      TraceOp::Event(EventOp {
        seq,
        parent: None,
        session_id: None,
        ts: DateTime::<Utc>::from_timestamp_millis(ms).unwrap(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields,
      })
    };

    // Three chunks: one action spanning first..last record timestamp.
    let mut state = TraceState::new();
    apply(&mut state, &chunk(0, 1_000, "a "));
    apply(&mut state, &chunk(1, 3_500, "b "));
    apply(&mut state, &chunk(2, 13_000, "c"));
    assert_eq!(state.standalones().len(), 1);
    let value = state.standalones()[0].fields.get("value").unwrap();
    assert_eq!(value["started_ms"], serde_json::json!(1_000));
    assert_eq!(value["ended_ms"], serde_json::json!(13_000));
    assert_eq!(value["content"]["text"], serde_json::json!("a b c"));

    // A single chunk carries equal stamps rather than none.
    let mut state = TraceState::new();
    apply(&mut state, &chunk(0, 2_000, "only"));
    let value = state.standalones()[0].fields.get("value").unwrap();
    assert_eq!(value["started_ms"], serde_json::json!(2_000));
    assert_eq!(value["ended_ms"], serde_json::json!(2_000));
  }

  #[test]
  fn permission_ask_and_decision_fold_to_one_action() {
    let ask = |seq: u64, turn: u64, request_id: i64| {
      acp_tool_patch(
        seq,
        turn,
        "harness.claude.permission/v1",
        serde_json::json!({
          "datatype": "harness.claude.permission/v1",
          "surface": "claude",
          "update_type": "permission_request",
          "requestId": request_id,
          "state": "pending",
          "options": [{"optionId": "allow", "kind": "allow_once"}]
        }),
      )
    };
    let decided = |seq: u64, turn: u64, request_id: i64| {
      acp_tool_patch(
        seq,
        turn,
        "harness.claude.permission/v1",
        serde_json::json!({
          "datatype": "harness.claude.permission/v1",
          "surface": "claude",
          "update_type": "permission_request",
          "requestId": request_id,
          "state": "decided",
          "decision": "approved",
          "optionId": "allow"
        }),
      )
    };

    // One ask + its decision: one standalone, latest state wins, and the
    // ask's fields the decision did not restate survive the merge.
    let mut state = TraceState::new();
    apply(&mut state, &ask(0, 4, 7));
    apply(&mut state, &decided(1, 4, 7));
    assert_eq!(state.standalones().len(), 1);
    let value = state.standalones()[0].fields.get("value").unwrap();
    assert_eq!(value["state"], serde_json::json!("decided"));
    assert_eq!(value["decision"], serde_json::json!("approved"));
    assert_eq!(value["options"][0]["kind"], serde_json::json!("allow_once"));

    // Distinct asks stay distinct; a decision finds ITS ask, not the newest.
    let mut state = TraceState::new();
    apply(&mut state, &ask(0, 4, 7));
    apply(&mut state, &ask(1, 4, 8));
    apply(&mut state, &decided(2, 4, 7));
    assert_eq!(state.standalones().len(), 2);
    let first = state.standalones()[0].fields.get("value").unwrap();
    let second = state.standalones()[1].fields.get("value").unwrap();
    assert_eq!(first["state"], serde_json::json!("decided"));
    assert_eq!(second["state"], serde_json::json!("pending"));

    // The same wire id in a different turn never merges across turns.
    let mut state = TraceState::new();
    apply(&mut state, &ask(0, 4, 7));
    apply(&mut state, &decided(1, 4, 7));
    apply(&mut state, &ask(2, 5, 7));
    assert_eq!(state.standalones().len(), 2);
  }

  #[test]
  fn permission_identity_prefers_the_durable_key_over_the_wire_id() {
    let keyed = |seq: u64, request_id: i64, key: &str, state_str: &str| {
      acp_tool_patch(
        seq,
        4,
        "harness.claude.permission/v1",
        serde_json::json!({
          "datatype": "harness.claude.permission/v1",
          "surface": "claude",
          "update_type": "permission_request",
          "requestId": request_id,
          "ask_key": key,
          "state": state_str,
        }),
      )
    };

    // A restarted child reused wire id 1 for a DIFFERENT ask: distinct keys
    // keep the two asks distinct actions.
    let mut state = TraceState::new();
    apply(&mut state, &keyed(0, 1, "toolu_a", "pending"));
    apply(&mut state, &keyed(1, 1, "toolu_b", "pending"));
    assert_eq!(state.standalones().len(), 2, "distinct asks never merge");

    // The decided patch finds its ask by key even under a NEW wire id (the
    // re-raise after a restart replies through a fresh request).
    let mut state = TraceState::new();
    apply(&mut state, &keyed(0, 1, "toolu_a", "pending"));
    apply(&mut state, &keyed(1, 7, "toolu_a", "decided"));
    assert_eq!(state.standalones().len(), 1, "the decision settles its ask");
    let value = state.standalones()[0].fields.get("value").unwrap();
    assert_eq!(value["state"], serde_json::json!("decided"));
  }

  #[test]
  fn the_settling_successor_stamps_the_end_of_a_thought() {
    let chunk = |seq: u64, ms: i64, text: &str| {
      let mut fields = HashMap::new();
      fields.insert(
        "kind".into(),
        serde_json::json!("harness.claude.thinking/v1"),
      );
      fields.insert("turn_seq".into(), serde_json::json!(4));
      fields.insert(
        "value".into(),
        serde_json::json!({
          "datatype": "harness.claude.thinking/v1",
          "surface": "claude",
          "update_type": "agent_thought_chunk",
          "content": {"type": "text", "text": text}
        }),
      );
      TraceOp::Event(EventOp {
        seq,
        parent: None,
        session_id: None,
        ts: DateTime::<Utc>::from_timestamp_millis(ms).unwrap(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields,
      })
    };
    // One chunk at t=2s, then the tool call that ended the reasoning at
    // t=9s: the thought spans 2s..9s — not the zero-length 2s..2s its own
    // chunks would claim. Silence before the successor was still thinking.
    let tool_at = |seq: u64, ms: i64| {
      let mut fields = HashMap::new();
      fields.insert(
        "kind".into(),
        serde_json::json!("harness.claude.tool-call/v1"),
      );
      fields.insert("turn_seq".into(), serde_json::json!(4));
      fields.insert(
        "value".into(),
        serde_json::json!({
          "datatype": "harness.claude.tool-call/v1",
          "surface": "claude",
          "update_type": "tool_call",
          "toolCallId": "toolu_1",
          "status": "pending"
        }),
      );
      TraceOp::Event(EventOp {
        seq,
        parent: None,
        session_id: None,
        ts: DateTime::<Utc>::from_timestamp_millis(ms).unwrap(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields,
      })
    };
    let mut state = TraceState::new();
    apply(&mut state, &chunk(0, 2_000, "planning"));
    apply(&mut state, &tool_at(1, 9_000));
    let thought = state.standalones()[0].fields.get("value").unwrap();
    assert_eq!(thought["started_ms"], serde_json::json!(2_000));
    assert_eq!(thought["ended_ms"], serde_json::json!(9_000));
  }

  /// Root span stamped with `turn_seq`, mimicking the host's
  /// `info_span!("shell.exec", … turn_seq = …)` open.
  fn open_in_turn(seq: u64, id: u64, turn_seq: u64, name: &str) -> TraceOp {
    let mut fields = HashMap::new();
    fields.insert("turn_seq".into(), serde_json::json!(turn_seq));
    TraceOp::Open(OpenOp {
      seq,
      id,
      parent: None,
      session_id: None,
      ts: ts(),
      name: name.into(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    })
  }

  #[test]
  fn root_span_with_child_event_builds_ljson_entry() {
    let mut s = TraceState::new();
    apply(&mut s, &open(0, 1, None, "req"));
    apply(&mut s, &event(1, Some(1), "hit cache"));
    apply(&mut s, &close(2, 1, 12));

    let entry = build_ljson_entry(&s, 1, Uuid::nil()).unwrap();
    assert_eq!(entry.root_span.name, "req");
    assert_eq!(entry.root_span.duration_ms, Some(12));
    assert_eq!(entry.root_span.children.len(), 1);
    match &entry.root_span.children[0] {
      LjsonChild::Event(e) => assert_eq!(e.message(), Some("hit cache")),
      _ => panic!("expected event child"),
    }
  }

  #[test]
  fn two_concurrent_roots_grow_in_parallel() {
    let mut s = TraceState::new();
    apply(&mut s, &open(0, 1, None, "a"));
    apply(&mut s, &open(1, 2, None, "b"));
    // Interleaved children:
    apply(&mut s, &event(2, Some(1), "a.1"));
    apply(&mut s, &event(3, Some(2), "b.1"));
    apply(&mut s, &event(4, Some(1), "a.2"));

    let a = s.span(1).unwrap();
    let b = s.span(2).unwrap();
    assert_eq!(a.children.len(), 2);
    assert_eq!(b.children.len(), 1);
    assert_eq!(s.roots(), &[1, 2]);
  }

  #[test]
  fn drain_subtree_removes_root_and_children() {
    let mut s = TraceState::new();
    apply(&mut s, &open(0, 1, None, "root"));
    apply(&mut s, &open(1, 2, Some(1), "child"));
    apply(&mut s, &close(2, 2, 1));
    apply(&mut s, &close(3, 1, 5));

    assert!(s.span(1).is_some());
    s.drain_subtree(1);
    assert!(s.span(1).is_none());
    assert!(s.span(2).is_none());
    assert!(s.roots().is_empty());
  }

  #[test]
  fn drop_oldest_caps_standalones_fifo() {
    let mut s = TraceState::new();
    for i in 0..10u64 {
      apply(&mut s, &event(i, None, &format!("e{i}")));
    }
    assert_eq!(s.standalones().len(), 10);
    s.drop_oldest(3);
    assert_eq!(s.standalones().len(), 3);
    // The remaining standalones should be the LAST 3 (e7, e8, e9) —
    // FIFO drops the oldest from index 0.
    let names: Vec<String> = s
      .standalones()
      .iter()
      .map(|e| {
        e.fields
          .get("message")
          .and_then(|v| v.as_str())
          .unwrap_or("")
          .to_string()
      })
      .collect();
    assert_eq!(names, vec!["e7", "e8", "e9"]);
  }

  #[test]
  fn drop_oldest_compares_root_vs_standalone_by_timestamp() {
    // Standalones t=0,2,4 and a root span opened at t=1, closed at t=3.
    // After cap=3 we should drop the root (t=1) FIRST because t=0
    // standalone is older, then drop standalone(t=0), leaving 3 entries.
    let mut s = TraceState::new();
    apply(&mut s, &event(0, None, "s0"));
    apply(&mut s, &open(1, 1, None, "r1"));
    apply(&mut s, &event(2, None, "s2"));
    apply(&mut s, &close(3, 1, 5));
    apply(&mut s, &event(4, None, "s4"));
    assert_eq!(s.roots().len() + s.standalones().len(), 4);
    s.drop_oldest(3);
    assert_eq!(s.roots().len() + s.standalones().len(), 3);
    // s0 (t=0) is the chronological oldest → dropped first.
    let msgs: Vec<&str> = s
      .standalones()
      .iter()
      .map(|e| {
        e.fields
          .get("message")
          .and_then(|v| v.as_str())
          .unwrap_or("")
      })
      .collect();
    assert!(
      !msgs.contains(&"s0"),
      "oldest standalone should be dropped: {msgs:?}"
    );
    assert!(s.roots().contains(&1), "root opened after s0 should remain");
  }

  #[test]
  fn drop_oldest_is_a_noop_below_target() {
    let mut s = TraceState::new();
    apply(&mut s, &event(0, None, "a"));
    apply(&mut s, &event(1, None, "b"));
    s.drop_oldest(100);
    assert_eq!(s.standalones().len(), 2);
  }

  #[test]
  fn route_kind_picks_explicit_kind_field_first() {
    let mut s = TraceState::new();
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!("http.request"));
    apply(
      &mut s,
      &TraceOp::Open(OpenOp {
        seq: 0,
        id: 1,
        parent: None,
        session_id: None,
        ts: ts(),
        name: "req".into(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields,
      }),
    );
    apply(&mut s, &close(1, 1, 4));
    let entry = build_ljson_entry(&s, 1, Uuid::nil()).unwrap();
    assert_eq!(route_kind(&entry), "http.request");
  }

  #[test]
  fn route_kind_without_kind_degrades_to_generic_event() {
    // A span that declares no `kind` — even one that "looks" like HTTP by its
    // fields/name — is NOT sniffed into a domain preset. It degrades to the
    // generic, structure-preserving `event` preset. (Producers now stamp `kind`
    // explicitly; this is the elegant fallback for legacy/foreign/misbehaving
    // input.)
    let mut s = TraceState::new();
    let mut fields = HashMap::new();
    fields.insert("http.method".into(), serde_json::json!("GET"));
    apply(
      &mut s,
      &TraceOp::Open(OpenOp {
        seq: 0,
        id: 1,
        parent: None,
        session_id: None,
        ts: ts(),
        name: "request".into(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields,
      }),
    );
    apply(&mut s, &close(1, 1, 4));
    let entry = build_ljson_entry(&s, 1, Uuid::nil()).unwrap();
    assert_eq!(route_kind(&entry), "event");
  }

  #[test]
  fn build_tree_value_includes_in_flight_root() {
    let mut s = TraceState::new();
    apply(&mut s, &open(0, 1, None, "running"));
    apply(&mut s, &event(1, Some(1), "step 1"));
    // No close — root is still in flight.
    let v = build_tree_value(&s);
    let roots = v["children"].as_array().unwrap();
    assert_eq!(roots.len(), 1);
    assert!(roots[0]["title"].as_str().unwrap().starts_with("running"));
    assert_eq!(roots[0]["children"].as_array().unwrap().len(), 1);
  }

  #[test]
  fn event_to_tree_node_walks_structured_value_object() {
    // Simulates what `tracing::info!(kind = "exec.output", value = %json)`
    // produces: a `value` attribute holding a JSON-serialized string.
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!("exec.output"));
    fields.insert(
      "value".into(),
      serde_json::json!(
        serde_json::to_string(&serde_json::json!({
          "ok": true,
          "commands": [
            { "name": "pi", "description": "Print π" },
            { "name": "sqrt", "description": "Square root" },
          ]
        }))
        .unwrap()
      ),
    );
    let ev = EventNode {
      ts: Utc::now(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    };
    let node = event_to_tree_node(&ev);
    let children = node["children"].as_array().expect("children present");
    assert_eq!(children.len(), 2, "ok + commands fields");
    // commands field should itself have 2 child items.
    let commands = children
      .iter()
      .find(|c| c["title"].as_str().unwrap_or("").starts_with("commands"))
      .expect("commands child");
    assert_eq!(commands["children"].as_array().unwrap().len(), 2);
    // Title falls back to `(exec.output · 2 items)` when there is no message.
    assert!(
      node["title"].as_str().unwrap().contains("exec.output"),
      "title should include kind: {}",
      node["title"]
    );
    // The raw `value` blob is not surfaced as an attr.
    let attrs = node["attrs"].as_object().unwrap();
    assert!(
      !attrs.contains_key("value"),
      "value should not appear as attr"
    );
  }

  #[test]
  fn entries_chronological_orders_roots_and_standalones_by_ts() {
    let mut s = TraceState::new();
    // Insert a span FIRST then a standalone event whose timestamp is
    // actually earlier — chronological order should put the event first.
    apply(&mut s, &open(0, 1, None, "later"));
    let mut early_fields = HashMap::new();
    early_fields.insert("message".into(), serde_json::json!("earliest"));
    apply(
      &mut s,
      &TraceOp::Event(crate::stream::EventOp {
        seq: 1,
        parent: None,
        session_id: None,
        ts: chrono::DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
        level: LjsonLevel::Info,
        loc: loc(),
        fields: early_fields,
      }),
    );

    let entries = s.entries_chronological();
    assert_eq!(entries.len(), 2);
    // Standalone (earlier ts) first; root span second.
    assert!(matches!(entries[0], Entry::Standalone { .. }));
    assert!(matches!(entries[1], Entry::Root { id: 1, .. }));
  }

  #[test]
  fn structured_value_children_array_expands_each_element() {
    let value = serde_json::json!([
      { "name": "a", "description": "apple" },
      { "name": "b", "description": "banana" },
    ]);
    let node = structured_field_node("commands", &value, "commands");
    let obj = node.as_object().unwrap();
    let rows = obj.get("children").unwrap().as_array().unwrap();
    assert_eq!(rows.len(), 2, "one node per array element");
    // Each child should carry its dotted path.
    let p0 = rows[0]
      .get("attrs")
      .and_then(|a| a.get("_path"))
      .and_then(|s| s.as_str())
      .unwrap();
    assert_eq!(p0, "commands.0");
    let p1 = rows[1]
      .get("attrs")
      .and_then(|a| a.get("_path"))
      .and_then(|s| s.as_str())
      .unwrap();
    assert_eq!(p1, "commands.1");
  }

  #[test]
  fn structured_field_node_stamps_path_on_inline_description_leaf() {
    let value = serde_json::json!({
      "description": "Install or update health daemon",
      "args": ["--host <host>"]
    });
    let node = structured_field_node("healthd.install", &value, "fleet.healthd.install");
    let attrs = node.get("attrs").unwrap();
    assert_eq!(
      attrs.get("_path").and_then(|s| s.as_str()),
      Some("fleet.healthd.install")
    );
    // The args sibling becomes a child with its own joined path.
    let children = node.get("children").unwrap().as_array().unwrap();
    assert_eq!(children.len(), 1);
    let args_path = children[0]
      .get("attrs")
      .and_then(|a| a.get("_path"))
      .and_then(|s| s.as_str());
    assert_eq!(args_path, Some("fleet.healthd.install.args"));
  }

  #[test]
  fn inline_description_passes_open_hint_through_as_attrs_open_and_suppresses_it_as_child() {
    let value = serde_json::json!({
      "description": "Install daemon",
      "args": "--target",
      "_open": false
    });
    let node = structured_field_node("healthd.install", &value, "fleet.healthd.install");
    let attrs = node.get("attrs").unwrap();
    assert_eq!(
      attrs.get("_open").and_then(|v| v.as_str()),
      Some("false"),
      "the `_open` hint must land on the emitted attrs (as a String, since TreeNode.attrs is String-valued)"
    );
    // `_open` must NOT have been emitted as a child row.
    let children = node.get("children").unwrap().as_array().unwrap();
    let titles: Vec<&str> = children
      .iter()
      .filter_map(|c| c.get("title").and_then(|t| t.as_str()))
      .collect();
    assert!(
      !titles.iter().any(|t| t.starts_with("_open")),
      "metadata `_open` must not appear as a child row, got titles {titles:?}"
    );
    // The only child is the inline args line.
    assert_eq!(children.len(), 1);
    assert_eq!(
      children[0].get("title").and_then(|t| t.as_str()),
      Some("args: --target")
    );
  }

  // ---- `TraceState::turns()` grouping ----

  #[test]
  fn turns_groups_user_input_span_and_trailing_standalones() {
    // Mimic two full `tento-sh-tui` turns in stream order:
    //   turn 1: user.input, shell.exec(open/close), stdout, exec.body
    //   turn 2: user.input, shell.exec(open/close)
    let mut s = TraceState::new();
    apply(&mut s, &event_in_turn(0, 1, "user.input"));
    apply(&mut s, &open_in_turn(1, 1, 1, "shell.exec"));
    apply(&mut s, &event(2, Some(1), "internal step"));
    apply(&mut s, &close(3, 1, 5));
    apply(&mut s, &event_in_turn(4, 1, "stdout"));
    apply(&mut s, &event_in_turn(5, 1, "exec.body"));
    apply(&mut s, &event_in_turn(6, 2, "user.input"));
    apply(&mut s, &open_in_turn(7, 2, 2, "shell.exec"));
    apply(&mut s, &close(8, 2, 3));

    let turns = s.turns();
    assert_eq!(turns.len(), 2, "two turns, got {}", turns.len());

    assert_eq!(turns[0].seq(), Some(1));
    // turn 1: user.input + shell.exec root + stdout + exec.body = 4 entries.
    // The in-span `internal step` event is a CHILD of the root span, not a
    // top-level entry — so it doesn't appear here (it's nested under
    // `Entry::Root { id: 1 }` and visible to the renderer via the span tree).
    assert_eq!(turns[0].entries().len(), 4);

    assert_eq!(turns[1].seq(), Some(2));
    assert_eq!(turns[1].entries().len(), 2); // user.input + shell.exec root
  }

  #[test]
  fn turns_groups_contiguous_unmarked_into_one_ambient() {
    // Two contiguous unmarked events — a legacy / non-`tento-sh` trace
    // stream. With no marked entry between them they form a single ambient
    // run.
    let mut s = TraceState::new();
    apply(&mut s, &event(0, None, "infra event 1"));
    apply(&mut s, &event(1, None, "infra event 2"));
    let turns = s.turns();
    assert_eq!(turns.len(), 1, "one ambient run");
    assert!(turns[0].is_ambient());
    assert_eq!(turns[0].seq(), None);
    assert_eq!(turns[0].entries().len(), 2);
  }

  #[test]
  fn turns_places_ambient_run_between_prompted_turns() {
    // Marked, unmarked, marked: the stray infra event becomes its own
    // ambient turn sitting BETWEEN the two prompted turns, in order.
    let mut s = TraceState::new();
    apply(&mut s, &event_in_turn(0, 1, "user.input"));
    apply(&mut s, &event(1, None, "stray infra event"));
    apply(&mut s, &event_in_turn(2, 2, "user.input"));
    let turns = s.turns();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0].seq(), Some(1));
    assert!(turns[1].is_ambient(), "ambient run sits between the turns");
    assert_eq!(turns[1].entries().len(), 1);
    assert_eq!(turns[2].seq(), Some(2));
  }

  #[test]
  fn turns_two_ambient_runs_separated_by_a_prompted_turn() {
    // ambient {A,B}, prompted turn 1, ambient {C,D}. The marked turn must
    // SPLIT the ambient output into two runs at their real positions — not
    // coalesce all four into one bucket at the top (the bug this fixes).
    let mut s = TraceState::new();
    apply(&mut s, &event(0, None, "infra A"));
    apply(&mut s, &event(1, None, "infra B"));
    apply(&mut s, &event_in_turn(2, 1, "user.input"));
    apply(&mut s, &open_in_turn(3, 1, 1, "shell.exec"));
    apply(&mut s, &close(4, 1, 5));
    apply(&mut s, &event(5, None, "infra C"));
    apply(&mut s, &event(6, None, "infra D"));

    let turns = s.turns();
    assert_eq!(turns.len(), 3, "ambient, prompted, ambient");
    assert!(turns[0].is_ambient());
    assert_eq!(turns[0].entries().len(), 2); // A, B
    assert_eq!(turns[1].seq(), Some(1));
    assert!(turns[2].is_ambient());
    assert_eq!(turns[2].entries().len(), 2); // C, D
  }

  #[test]
  fn turns_ambient_runs_separated_by_prompt_have_distinct_first_entries() {
    // The two ambient runs must be distinct instances (the basis for the
    // renderer's per-run collapse keys), not one coalesced bucket — their
    // first entries differ.
    let mut s = TraceState::new();
    apply(&mut s, &event(0, None, "before")); // standalone index 0
    apply(&mut s, &event_in_turn(1, 1, "user.input")); // index 1
    apply(&mut s, &event(2, None, "after")); // standalone index 2
    let turns = s.turns();
    let ambient: Vec<&Turn> = turns.iter().filter(|t| t.is_ambient()).collect();
    assert_eq!(ambient.len(), 2, "two separate ambient runs");
    let first_index = |t: &Turn| match t.entries().first() {
      Some(Entry::Standalone { index, .. }) => Some(*index),
      _ => None,
    };
    assert_eq!(first_index(ambient[0]), Some(0));
    assert_eq!(first_index(ambient[1]), Some(2));
  }

  #[test]
  fn turn_seq_accessor_handles_string_form() {
    // `tracing::info!(turn_seq = n)` for a u64 emits a JSON number, but if
    // a producer ever stringifies it (e.g. through Display), the accessor
    // must still recover it so the renderer doesn't silently drop the turn.
    let mut fields = HashMap::new();
    fields.insert("turn_seq".into(), serde_json::json!("7"));
    let ev = EventNode {
      ts: Utc::now(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    };
    assert_eq!(ev.turn_seq(), Some(7));
  }

  #[test]
  fn event_to_tree_node_scalar_value_renders_single_child() {
    let mut fields = HashMap::new();
    fields.insert("kind".into(), serde_json::json!("exec.output"));
    fields.insert(
      "value".into(),
      serde_json::json!(serde_json::to_string(&serde_json::json!(42)).unwrap()),
    );
    let ev = EventNode {
      ts: Utc::now(),
      level: LjsonLevel::Info,
      loc: loc(),
      fields,
    };
    let node = event_to_tree_node(&ev);
    let children = node["children"].as_array().expect("children present");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["title"].as_str().unwrap(), "value: 42");
  }

  #[test]
  fn classify_kind_routes_session_start() {
    // The session-open banner must reach its own preset (which renders the
    // `session.preamble/v1` chrome widget) rather than the generic `event`
    // preset, whose tree body would paint every `initialize.*` field.
    assert_eq!(classify_kind("session.start"), "session.start");
    assert_eq!(classify_kind("engine.startup"), "engine.startup");
    assert_eq!(classify_kind("some.unknown"), "event");
  }
}
