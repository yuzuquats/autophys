# Build the 2026-11-08 review decisions

Status: built, 2026-11-08 (all eight decisions; independent review pending). SHAs below are as of HEAD `e31f3d7`; Change-Ids are the stable names. The operator said "start" after the
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

**RS-REMOTE-2: done** (`8f3c1a9`, `I6009dcdbcda1cf93fd70e97ec63e2866`).
Python's `HttpStore` raises `HttpError` (status and code kept) with "the
daemon is too old for reveal records / display manifests (no endpoint);
upgrade the autophys daemon" on every attempt, instead of warning once and
skipping. Only a missing route counts: 405, or 404 with the daemon's
`unknown route` message (or an empty body); a 404 such as `unknown
investigation` or `unknown project` is raised unchanged. Tests:
`test_curves_reveal.py`, `test_display.py`. Rust already returns the HTTP
error; giving it the same upgrade wording is optional Rust-side follow-up.

**DM-D1 (Python): done** (`f4f5d26`, `Ic24293b548e74e9f62a642f806af2c60`).
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

`7ae2cb7` (`I4f63a8230efc2cf463a5d907805eb885`). Rust `Trajectory` has no
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
failed, 2 ignored (baseline at `ddecbbb`, before the change: 321/0/2; the
two new tests are the trajectory unit tests). `autophys new --lang rust`
for `blank` and `battery-fit`, pinned to `7ae2cb7` through a `file://`
SDK repo, builds in release; both run, and `battery-fit --demo` writes a
`demo.csv` byte-identical to the shipped one.

### UI-27: done

`a2394e3` (`Ie4f804d3ea81ab924611f3d5cefc1bc9`) and `ddd1bb7`
(`I3babbef47e5b61f8fedbdc0df2ea9a62`). New project is the operator-chosen
SDK stepper: create with `autophys new my-project --lang python|rust`,
connect with `autophys connect <page origin> --name my-device` and approve
the device from its pending card in the step (approval advances), then run
the program; the first investigation opens when it appears. The Thermal RC
wizard, its model, styles, client `projects` calls and tests are gone; the
empty workspace, walkthrough and Docs point at the SDK flow;
`src/http/workbench.rs` is untouched. Agent-chosen details UI-27-a..e
(runnable placeholder names, removing the thermal "Start simulated
investigation" action, completion rule, workspace re-read while open, native
toggle buttons) are in `ui.md`, pending operator review. `decisions.md`
still marks UI-27 "not implemented".

Tests: `deno test --allow-read --config html/deno.json html/` 138 passed,
0 failed; `deno check` clean; `autophys build-web` ok.
`tests/e2e/sidebar-flow.ts` 46 checks, no browser errors, against scratch
daemons 47971/47972 with real `autophys connect` devices (one denied, one
approved per run) and `seed.py --connected`; screenshots in
`yuzuquats:~/.cache/autophys/ui27-20261108T104915Z/shots/`.

### RS-REMOTE-1: done

`0067d04` (`I312a644864bfa193ee73218cd2782f6d`). `autophys::remote::Remote`
is async over reqwest 0.12 (rustls, webpki roots, ring) and tokio:
requests, projects, investigations, records, proposals, appends, SSE
streams (`RecordStream::next().await`), approval waits and
`remote::auth::{pair_start, pair_poll, whoami}`. `autophys::blocking`
(RS-REMOTE-1a) is the thin facade `Client`, `Workbook`, the investigation
loop, the CLI and scripts use: `blocking::Remote`, `blocking::RecordStream`
(an `Iterator`) and `blocking::auth`. It waits on a process-wide one-worker
runtime; called inside a tokio runtime it runs the future on a scoped helper
thread instead of panicking. Public `HttpError`/`Error` shapes and messages
are unchanged; one SSE frame parser serves the blocking `Sse<R>` and the
async stream. Cargo.lock gains reqwest and its hyper/tower stack (24
packages); `ureq` stays for the reasoner and the backtest fetch.

Agent-chosen, pending operator review: RS-REMOTE-1-a reqwest 0.12 rather
than 0.13 (alternative: 0.13, a version bump later); RS-REMOTE-1-b
`blocking` always compiled, no feature gate (alternative: a default
`blocking` feature, small to add); RS-REMOTE-1-c one shared runtime plus a
helper thread inside a runtime (alternative: refuse with an error inside a
runtime, as `reqwest::blocking` panics); RS-REMOTE-1-d no idle connection
pool (`pool_max_idle_per_host(0)`), so no connection outlives the runtime
that opened it (cost: one TCP connect per request on loopback; reversal is
one builder line once callers share a runtime).

Breaking: `Client::remote()`/`Workbook::remote()` return
`&autophys::blocking::Remote`; `remote::Remote` methods and
`remote::auth::{pair_start, pair_poll, whoami}` are async; its `timeout` and
`stream_idle` are set through `blocking::Remote::set_timeout` /
`set_stream_idle` on the facade.

Tests: three new transport tests (async client on the caller's runtime,
blocking facade inside a current-thread runtime, blocking stream iteration
advancing the cursor); workspace 326/0/2.

### CORE-01: done

`799234b` (`Ia265d1b94e62c5cd0e711976fbba5b72`). Contract:

- `POST /api/v1/investigations/{inv}/records`, `Keyed` auth, body
  `{"records": [{"id", "kind", "payload", "hash_of"?}, ...]}`, 1 to 64
  envelopes within the 1 MiB + 64 KiB body limit.
- Appended in order in one `BEGIN IMMEDIATE` transaction, all or none. Each
  record gets the store validation `Investigation::append` gives one record,
  keyed by record id (kind, payload shape and size, the proposal state
  machine) against the state the earlier records leave; `investigation`
  records are refused. (Corrected in review round 1: the single routes' own
  rules, their per-route kind and event allowlists, the path proposal id and
  the server stamping `by` on decisions, do not apply; the route takes keys
  only. A `data_attached` event must name a measurement of the batch when it
  links into the batch or the batch holds measurements.)
- Idempotent by record id: the same id and content replays
  (`created: false`), the same id with other content is 409
  `idempotency_conflict`; replays and new records may mix. An
  `Idempotency-Key` header is refused (400): idempotency is per record.
- `hash_of: {field: index}` fills a top-level payload field with the hash of
  an earlier record of the batch; Rust `attach_data` links the
  `data_attached` event's `measurement_version` to the measurement this way.
- Reply `{"records": [{"record", "gseq", "created"}], "gseq": max}`, 201 if
  any record is new, else 200. Errors are the `ApiError` shapes, with
  `path` prefixed `records[i].` (or `records` for the count).
- `POST …/proposals/{pid}/attachment` is removed (CORE-01a): 404.

SDKs: Rust `Investigation::append_batch(&[BatchRecord])`, `BatchRecord`,
`MAX_BATCH_RECORDS`; `attach_data` is a two-record batch locally and over
HTTP (no fallback); `Investigation::attach_records` is removed. Python
`HttpStore.attach_data` posts the batch (with content-derived ids until review round 1, now Rust's investigation/proposal/kind ids) and
`HttpStore.append_batch` is now atomic through it; the fake server
implements the route. A daemon without the route gives "too old for batch
record appends … upgrade the autophys daemon" in both SDKs (in `9849710`).

Agent-chosen, pending operator review: CORE-01-a the route path (alternative
`POST /investigations/{inv}/batch`); CORE-01-b `hash_of` linkage (alternative:
callers precompute hashes, which needs the chain head and races);
CORE-01-c per-record replay, mixed batches allowed (alternative: whole-batch
replay only); CORE-01-d the 64-record cap; CORE-01-e the old route's strict
pair checks (both records replay or neither) are replaced by the per-record
rules. Reversal of each is local to `workbook.rs`, `http.rs` and the two
clients, before external adoption.

Breaking: SDK 0.1.0 to 0.1.2 cannot attach data against this daemon (they
call the removed route); these SDKs cannot attach against an older daemon;
`Investigation::attach_records` is gone.

Tests: `store_contract.rs` batch test (atomic refusal by kind, payload,
proposal state and duplicate id; empty/missing records; `hash_of` linkage;
replay 200; conflict 409; header 400; old route 404), SDK pre-request batch
checks, `test_http.py` batch/attach test, and `test_atomic_remote.py` (4
tests) passing against a real daemon and a Rust peer.

### CORE-04: done

`e4b7409` (`Ib8f521611f865d8ff5462fa64020266c`). Rust `Client::project(name)`
opens: locally it is 404 `not_found` unless the slug's file exists (no file
written), a file holding another name stays 409 `conflict`; remotely it opens
through the project list. `ensure_project` creates; `project_with(Project)`
keeps creating (through `ensure_project`), like Python's
`project(Project)`. Python already opened. Callers changed: SDK and daemon
tests that meant to create; the CLI, daemon, `examples/` and the
investigation loop already used `ensure_project` or a `Project`. Breaking:
Rust code relying on `project(name)` to create must call `ensure_project`.
Test: `project_by_name_opens_and_only_ensure_project_creates`.

### DM-D1 (Rust): done

`9849710` (`Iadc35d7dfcd6f0dfcb60ff1c2a212497`). `schema.rs` has the display
DDL, byte for byte, as step 1 to 2, `INITIAL_VERSION = 1` and `VERSION = 2`
(exported `INITIAL_FORMAT_VERSION`, `FORMAT_VERSION`). `migrate` on open
creates new files at 1, accepts 1 and 2, refuses newer and never runs step 2;
`upgrade` runs steps inside the caller's transaction and refuses a newer
format written after open. `put_display` (the daemon's display route
included) upgrades to 2 in its `BEGIN IMMEDIATE` transaction and commits
even when unchanged. Reads never create the table. Canonical JSON agrees
between the SDKs on a non-ASCII manifest (both ASCII-escape and sort by code
point, floats included); a pinned digest test is in each SDK; no golden
changed. Rust now gives the RS-REMOTE-2 upgrade wording for missing reveal,
display and batch routes. `workbook-format.md` has the format-2 section;
`display-manifest.md` and the `decisions.md` implementation column are
updated for DM-D1, CORE-01, CORE-04, RS-REMOTE-1, RS-REMOTE-2 and DM-RS-1.

Breaking: a workbook given a display is format 2 and SDK 0.1.x refuses it;
`FORMAT_VERSION` is now 2 (use `INITIAL_FORMAT_VERSION`).

Tests: `sdks/rust/tests/workbook_format2.rs` (10, mirroring
`test_workbook_format2.py`; the failed-write case injects a view named
`display`), the daemon display test checks the upload moves only that
workbook to format 2, and a Python non-ASCII digest test.

Wave 2 validation on yuzuquats after `9849710`: `cargo test --workspace
--locked` 342 passed, 0 failed, 2 ignored (baseline 323; +17 from this wave,
+2 from peers' G8-TRAIN/G3-NAME commits); `python3 -m pytest -q -p
no:cacheprovider sdks/python/tests` 669 passed, 13 skipped (baseline 665;
+2 from this wave, +2 from peers); with `AUTOPHYS_RUST_BIN`,
`AUTOPHYS_RUST_WEB_ROOT` and `AUTOPHYS_CORE_PEER` set, the cross-writer,
atomic-remote, core-boundary, display and reveal suites pass with no skips
(119 passed).

Open: `decisions.md` still says UI-27 "not implemented" (not this wave).
The `AUTOPHYS_CORE_PEER` binary the env-gated Python tests need is not a
build target (`sdks/rust/tests/support/core_peer.rs` is not wired into
Cargo); this wave used an uncommitted scratch peer.

### O-3a: done

`a932728` (`I1e9b4c7a2d5f80364b1e7c9a2d4f6b18`) runs `ops/deploy.sh` under
`LC_ALL=C`: in a UTF-8 locale bash's `[A-Za-z]` matched `é`, so the existing
deploy test failed at HEAD. `96b5f8f` (`I7d2a5e8c1b4f93062a7d5e1c8b3f4a29`)
renders `--browser-origin http://autophys.<host>.tento.localhost` into the
unit's ExecStart; `AUTOPHYS_BROWSER_ORIGIN` overrides it (empty: loopback
only) and is validated before sed. `python3 -m pytest ops/test_deploy.py`:
2 passed. Takes effect at the next deploy.
