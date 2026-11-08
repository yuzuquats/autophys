# Build the 2026-11-08 review decisions

Status: plan, 2026-11-08. The operator said "start" after the
`/open-questions` review recorded in [decisions.md](decisions.md) ("Operator
review, 2026-11-08" and the sub-questions). Nothing here is pushed or
released; commits stay local on yuzuquats `~/workspace/autophys` master.

## What changes

| Id | Change | Where |
| --- | --- | --- |
| DM-RS-1 | Rust `Trajectory` becomes an explicit struct: no map `Deref`/`DerefMut`; `outputs()`, `inputs()`, channel lookups that return an error naming the channel; serialised as `{"y": {...}, "u": {...}}` (DM-RS-1a); equality compares inputs too | `sdks/rust/src` (trajectory, simulator, curves, display, worker and callers), Rust templates in `examples/` |
| RS-REMOTE-2 | Python errors when a daemon lacks `reveal` or `display` (no warn-and-skip), with an "upgrade the daemon" message, like Rust | `sdks/python/src/autophys/http.py` |
| DM-D1 | Workbook format 2 holds the display table; a workbook migrates to 2 at its **first display write**, never on open (DM-D1a); format-1 workbooks without a display stay readable by SDK 0.1.x. Python gains its first migration step | both SDKs' workbook and schema code, the daemon's display route |
| UI-27 | New project becomes a three-step SDK flow: `autophys new --lang python\|rust`, `autophys connect <daemon> --name <device>` with the pairing approved in place, then the first investigation appearing. The Thermal wizard is removed | `html/` |
| O-3a | Deploy passes the host's tento.localhost origin as `--browser-origin` | `ops/` |
| RS-REMOTE-1 | Rust remote transport becomes async (tokio); `autophys::blocking` is a thin facade the CLI, the investigation loop and scripts use (RS-REMOTE-1a) | `sdks/rust/src/remote`, client, CLI callers |
| CORE-01 | A generic multi-record transaction endpoint replaces `POST …/proposals/{pid}/attachment`, which is **removed** (CORE-01a); both SDKs attach through the batch endpoint. Released SDKs 0.1.x cannot attach against the new daemon | `src/http.rs`, store, both SDK clients |
| CORE-04 | `project(name)` opens and errors if missing in both SDKs; Rust callers that relied on create use `ensure_project` | `sdks/rust/src/client.rs`, callers, docs |

## Order

Wave 1 runs in parallel on disjoint files: DM-RS-1 (Rust SDK types),
RS-REMOTE-2 plus Python's DM-D1 half (Python SDK), UI-27 (`html/`), O-3a
(`ops/`). Wave 2 is one sequential stream over the Rust remote transport,
the daemon and the store, which all three of its changes touch: RS-REMOTE-1,
then CORE-01 (Python's client side included), then CORE-04 and the Rust and
daemon half of DM-D1.

## Validation

Each change carries its own tests. Before the work is called done: `cargo
test` for the workspace, `python3 -m pytest -q sdks/python/tests`, the
`html/` Deno tests, and an independent Opus review of the whole range.
Breaking changes (CORE-01's removed route, CORE-04, DM-RS-1, format 2) are
listed in the next release's notes; no version bump or release is part of
this plan.

## Remaining work

Tracked here as each wave lands.

**RS-REMOTE-2: done** (`4e44370`, `I6009dcdbcda1cf93fd70e97ec63e2866`).
Python's `HttpStore` raises `HttpError` (status and code kept) with "the
daemon is too old for reveal records / display manifests (no endpoint);
upgrade the autophys daemon" on every attempt, instead of warning once and
skipping. Only a missing route counts: 405, or 404 with the daemon's
`unknown route` message (or an empty body); a 404 such as `unknown
investigation` or `unknown project` is raised unchanged. Tests:
`test_curves_reveal.py`, `test_display.py`. Rust already returns the HTTP
error; giving it the same upgrade wording is optional Rust-side follow-up.

**DM-D1 (Python): done** (`e48ce0c`, `Ic24293b548e74e9f62a642f806af2c60`).
`workbook.py` has `INITIAL_VERSION = 1` (new files), `SCHEMA_VERSION = 2`
(newest read and written) and an append-only `_MIGRATIONS` tuple run inside
the writing transaction. New `WorkbookStore.put_display` / `display` match
the Rust `Workbook`; local `register_display` stays a no-op, as in Rust.
Tests: `test_workbook_format2.py` (new file is v1 and opening never
migrates; first write moves to v2 with the exact DDL; v2 reads read-only and
writable; v1 with the old optional table reads, then upgrades on its next
write; v3 refused on open and when written after open; a failed write,
including one injected after the migration step, leaves v1; rejected
manifests change nothing). The Rust SDK and daemon must mirror:

- DDL, byte for byte (SQLite stores it without `IF NOT EXISTS` and `;`):
  `"CREATE TABLE IF NOT EXISTS display (\n              project TEXT PRIMARY KEY REFERENCES projects(id),\n              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n            );"`
  (the statement in `manifest.rs` today), appended as migration step 2 in
  `schema.rs`.
- `migrate` on open must stop at format 1 for new files and never run step
  2; readers accept 1 and 2 and refuse >2. `put_display`, in its one
  `BEGIN IMMEDIATE` transaction: refuse >2, run the steps up to 2 and set
  `user_version = 2`, then compare digests and upsert. Commit even when the
  digest is unchanged (today Rust returns early without committing), so a
  v1 file holding the old table always leaves the write at v2.
- Reading a display never creates the table or changes the format.

Breaking for release notes: a workbook given a display is format 2 and
SDK 0.1.x refuses it; Python `SCHEMA_VERSION` is now 2 (use
`INITIAL_VERSION` for "format of a new workbook"); against a daemon without
`reveal` or `display`, Python errors instead of skipping. Open:
`workbook-format.md` still describes the format-1 optional extension and
needs a format-2 section once the Rust half lands.

### DM-RS-1: done

`b4dfc6e` (`I4f63a8230efc2cf463a5d907805eb885`). Rust `Trajectory` has no
map `Deref`/`DerefMut`. Accessors: `outputs()`/`outputs_mut()` (the `y`
map, time under `"t"`), `inputs()`/`inputs_mut()`, and `t()`,
`output(name)`, `input(name)` returning `Result<&[f64], ChannelError>`;
the error names the channel ("missing output channel voltage") and converts
into `SimulationError::Simulation` and `autophys::Error::BadRequest`.
Builders: `from_parts`, `into_parts`, `insert_output`/`insert_input`,
`with_output`/`with_input`; `From<Channels>` and `collect()` still build
outputs. Serde is `{"y": {...}, "u": {...}}` (`u` optional on read) and
equality compares `u` too. Removed: `.u` as a public field, `Deref` map
methods (`get`, `keys`, `iter`, `insert`, `shift_remove`, …), `Extend`,
`IntoIterator` and `From<Trajectory> for Channels`.

Serialisation audit: with the serde derives removed, only tests failed to
compile; no record, hash or golden serialises a `Trajectory`. Two numerics
tests compared `json!(trajectory)` against Python fixtures and now
serialise `outputs()`, the bytes they compared before. Goldens under
`tests/conformance/`, `tests/vectors/` and `sdks/rust/src/models/` are
unchanged.

DM-RS-1b — **agent-chosen, pending operator review**: `traj["name"]`
(`Index<&str>`, outputs only, panics naming the channel) stays. Before: map
indexing through `Deref`. After: indexing of outputs only; no input or
mutable indexing. Reason: the built-in models hash their own file, test
module included, into their source identity, and those tests index results;
dropping `Index` means editing `models/{oscillator,thermal}.rs`, which
changes their source hashes and hence every bench project's config version
(a record-visible change the brief excluded). Alternative: remove `Index`,
edit the model tests and accept new built-in source hashes (new config
versions for existing bench projects on next run). Reversal: delete the impl
and convert the model tests and the remaining test call sites (about ten
lines) in the same release that is allowed to move the model hashes.

Tests: `cargo test --workspace --locked` on yuzuquats, 323 passed, 0
failed, 2 ignored (baseline at `5d64e70`, before the change: 321/0/2; the
two new tests are the trajectory unit tests). `autophys new --lang rust`
for `blank` and `battery-fit`, pinned to `b4dfc6e` through a `file://`
SDK repo, builds in release; both run, and `battery-fit --demo` writes a
`demo.csv` byte-identical to the shipped one.
