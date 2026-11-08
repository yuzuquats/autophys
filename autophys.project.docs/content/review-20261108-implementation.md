# Build the 2026-11-08 review decisions

Status: built, deployed and published, 2026-11-08. SHAs are the published
commits on origin/master (restacks before the push were mapped by Change-Id);
`6590251` is the deployed release's own identity.

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
Breaking changes (CORE-01's removed route, CORE-04, DM-RS-1, DM-RS-1b's
removed `traj["name"]` indexing and the new oscillator and thermal source
hashes, format 2) are listed in the next release's notes; no version bump or release is part of
this plan.

## Remaining work

Tracked here as each wave lands.

**RS-REMOTE-2: done** (`dac03c9`, `I6009dcdbcda1cf93fd70e97ec63e2866`).
Python's `HttpStore` raises `HttpError` (status and code kept) with "the
daemon is too old for reveal records / display manifests (no endpoint);
upgrade the autophys daemon" on every attempt, instead of warning once and
skipping. Only a missing route counts: 405, or 404 with the daemon's
`unknown route` message (or an empty body); a 404 such as `unknown
investigation` or `unknown project` is raised unchanged. A reveal is
appended after the outcome, so against such a daemon the reveal error
arrives with the `outcome` record already written (documented in review
round 1; the erroring behaviour is the operator's decision and unchanged).
Tests:
`test_curves_reveal.py`, `test_display.py`. Rust already returns the HTTP
error; giving it the same upgrade wording is optional Rust-side follow-up.

**DM-D1 (Python): done** (`68536e9`, `Ic24293b548e74e9f62a642f806af2c60`).
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

`f88704d` (`I4f63a8230efc2cf463a5d907805eb885`). Rust `Trajectory` has no
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

DM-RS-1b (since changed by the operator and built; see "DM-RS-1b: done"
below) — **agent-chosen, pending operator review**: `traj["name"]`
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
failed, 2 ignored (baseline at `f44852b`, before the change: 321/0/2; the
two new tests are the trajectory unit tests). `autophys new --lang rust`
for `blank` and `battery-fit`, pinned to `f88704d` through a `file://`
SDK repo, builds in release; both run, and `battery-fit --demo` writes a
`demo.csv` byte-identical to the shipped one.

### UI-27: done

`Ie4f804d3ea81ab924611f3d5cefc1bc9` and `I3babbef47e5b61f8fedbdc0df2ea9a62`
(`0d626d4`, `d9177c2` as of `5cfb1a1`). New project is the operator-chosen
SDK stepper: create with `autophys new my-project --lang python|rust`,
connect with `autophys connect <page origin> --name my-device` and approve
the device from its pending card in the step (approval advances), then run
the program; the first investigation opens when it appears. The Thermal RC
wizard, its model, styles, client `projects` calls and tests are gone; the
empty workspace, walkthrough and Docs point at the SDK flow;
`src/http/workbench.rs` was left in place by this commit; **its daemon API
was removed in review round 1** (`I6d08b4d44d86063ab2714e7dbc4f4151`, below),
so UI-27's removal now covers the backend too. Agent-chosen details UI-27-a..e
(runnable placeholder names, removing the thermal "Start simulated
investigation" action, completion rule, workspace re-read while open, native
toggle buttons) are in `ui.md`, pending operator review. `decisions.md`
marks UI-27 implemented, with the backend removal.

Tests: `deno test --allow-read --config html/deno.json html/` 138 passed,
0 failed; `deno check` clean; `autophys build-web` ok.
`tests/e2e/sidebar-flow.ts` 46 checks, no browser errors, against scratch
daemons 47971/47972 with real `autophys connect` devices (one denied, one
approved per run) and `seed.py --connected`; screenshots in
`yuzuquats:~/.cache/autophys/ui27-20261108T104915Z/shots/`.

### RS-REMOTE-1: done

`199c4fb` (`I312a644864bfa193ee73218cd2782f6d`). `autophys::remote::Remote`
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

`b116ef4` (`Ia265d1b94e62c5cd0e711976fbba5b72`). Contract:

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
  only. A `data_attached` event the batch writes must name a measurement
  that precedes it in the batch when it links into the batch or a
  measurement precedes it; two events may name the same one. Corrected in
  review round 2: an earlier wording said any measurement of the batch.)
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
record appends … upgrade the autophys daemon" in both SDKs (in `e0bf786`).

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

`9a1fab4` (`Ib8f521611f865d8ff5462fa64020266c`). Rust `Client::project(name)`
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

`e0bf786` (`Iadc35d7dfcd6f0dfcb60ff1c2a212497`). `schema.rs` has the display
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

Wave 2 validation on yuzuquats after `e0bf786`: `cargo test --workspace
--locked` 342 passed, 0 failed, 2 ignored (baseline 323; +17 from this wave,
+2 from peers' G8-TRAIN/G3-NAME commits); `python3 -m pytest -q -p
no:cacheprovider sdks/python/tests` 669 passed, 13 skipped (baseline 665;
+2 from this wave, +2 from peers); with `AUTOPHYS_RUST_BIN`,
`AUTOPHYS_RUST_WEB_ROOT` and `AUTOPHYS_CORE_PEER` set, the cross-writer,
atomic-remote, core-boundary, display and reveal suites pass with no skips
(119 passed).

(`decisions.md` has since marked UI-27 implemented.) Open: the
`AUTOPHYS_CORE_PEER` binary the env-gated Python tests need is not a
build target (`sdks/rust/tests/support/core_peer.rs` is not wired into
Cargo); this wave used an uncommitted scratch peer.

### O-3a: done

`866e0f0` (`I1e9b4c7a2d5f80364b1e7c9a2d4f6b18`) runs `ops/deploy.sh` under
`LC_ALL=C`: in a UTF-8 locale bash's `[A-Za-z]` matched `é`, so the existing
deploy test failed at HEAD. `I7d2a5e8c1b4f93062a7d5e1c8b3f4a29`
renders `--browser-origin http://autophys.<host>.tento.localhost` into the
unit's ExecStart; `AUTOPHYS_BROWSER_ORIGIN` overrides it (empty: loopback
only) and is validated before sed. `python3 -m pytest ops/test_deploy.py`:
2 passed. Takes effect at the next deploy.

### Review round 1 fixes

An independent review of the build (2026-11-08) returned six findings; each
is fixed in a scoped commit on yuzuquats `~/workspace/autophys` master
(SHAs as of HEAD `a014c35`; local history has been restacked before, so
Change-Ids are the stable names). Nothing is pushed or deployed;
`autophys.service` keeps running the earlier build until the next deploy.

| Finding | Fix | Commit |
| --- | --- | --- |
| 1 (blocking). UI-27 removed the Thermal wizard's UI but the daemon still served `POST /workbench/projects` and `POST /workbench/projects/{pid}/investigations` to any allowed browser origin | **UI-27 backend removal done**: both routes, `src/http/workbench.rs`, the run registry only it used and `tests/browser_workbench.rs` are gone; a store_contract test pins both paths at 404 for a browser and a key. No UI or e2e caller used them. Built-in models elsewhere (bench, `sdks/rust/src/models`) are untouched | `914956b` `I6d08b4d44d86063ab2714e7dbc4f4151` |
| 2. A `--browser-origin` flag replaced `AUTOPHYS_BROWSER_ORIGINS`, so deploy's flag (O-3a) dropped a drop-in's origins | `parse_serve` joins them, environment first, duplicates dropped; test, help, Docs, rust-sdk.md and the deploy.sh comment updated | `2829efa` `Ia37aa9c7b5cc814d166ae1a2b1eab65f` |
| 3. Docs claimed batched records are checked as their single routes would check them; the batch also lost the attachment route's measurement link check | Docs corrected (store.md, the CORE-01 entry above, core-remediation.md, the http.rs and SDK doc comments): the batch applies `Investigation::append`'s store validation, key-only, without per-route allowlists, path proposal ids or server-stamped `by`. `Investigation::append_batch` now refuses a `data_attached` whose link into the batch is not a measurement, or that names none of the measurements that precede it in the batch; a measurement is named by its hash (Rust, `hash_of`) or its payload `version` (Python) | `96527b0` `I0724c809353210fee30999fec88cf6f3` |
| 4. `attach_data` record ids differed between SDKs (Python hashed the payload in) | Python derives them from investigation, proposal and kind, as Rust (`attach_record_id` in both, the same two ids pinned in each SDK's tests); no test or golden relied on the payload hash. Rust's doc comment now also describes a second local call | `df7ae68` `I591ab31cb17fd9fbb34b7c7c0015f10b` |
| 5. Python `HttpStore.append_batch` gave each record a fresh uuid4, so a retry duplicated it | Every Python store's `append_batch` takes `(kind, payload)` or `(kind, payload, record_id)`; uuid4 stays the fallback; docs say only records with ids are retry-safe; `attach_data` passes its ids through it | `df7ae68` (with 4) |
| 6. The blocking facade's in-runtime cost was undocumented | Module and `run` docs plus rust-sdk.md: one new helper thread per call inside a runtime, the caller's runtime thread blocked, a current-thread runtime (actix worker) stalled. The TLS note says reqwest takes the process-default rustls provider, else ring, and nothing may rely on rustls's crate-feature default. RS-REMOTE-2: documented that the Python reveal error arrives after the outcome is written (behaviour unchanged) | `a014c35` `I8da1463b1f558472b911750a25ac1f3a` |

Agent-chosen, pending operator review:

- **RR1-a, the batch link rule.** Before: the batch accepted any
  `measurement_version`. After: an event linking into the batch must name a
  measurement, and an event preceded by measurements in its batch must name
  one of them (hash or payload `version`). Two events may name the same
  batch measurement; the removed route allowed one measurement per event.
  Reason: it is the removed route's
  pair guarantee, generalised, and both SDKs' attachments pass it. Strongest
  alternative: check only explicit links (`hash_of` or a batch record's
  hash), which leaves a Python-shaped pair with a wrong version accepted.
  Implemented in `sdks/rust/src/workbook.rs` (`check_attachment_link`), so
  the Rust local store enforces it too. The Python local stores do not
  (Python's only batch writer is its own consistent pair); the test fake
  server mirrors it since review round 2. Reversal: delete the one call
  (and the fake's).
- **RR1-b, SDKs disagree on `measurement_version`.** Python records the
  dataset version (an integer, also in the measurement payload), Rust the
  measurement record's hash; `agent.py`'s cost lookup already reads both.
  Not changed here (a record-visible contract choice); the link check
  accepts both.
- **RR1-c, TLS provider.** The brief asked for a note that the provider is
  chosen explicitly; it is not: reqwest 0.12 uses an installed process
  default, else ring. The note says so. Making it explicit means building a
  rustls `ClientConfig` with `ring::default_provider()` and passing it
  through `use_preconfigured_tls`, which adds `rustls` and `webpki-roots` as
  direct dependencies (a Cargo.lock edit); not done.

Tests on yuzuquats at `a014c35`: `cargo test --workspace --locked` 344
passed, 0 failed, 2 ignored (baseline 342: minus the 2 removed
`browser_workbench` tests, plus 3 new, plus 1 from a peer's fit-penalty
commit restacked below this range); `python3 -m pytest -q -p
no:cacheprovider sdks/python/tests` 676 passed, 13 skipped (669 plus 6 new
plus 1 peer); with `AUTOPHYS_RUST_BIN`, `AUTOPHYS_RUST_WEB_ROOT` and
`AUTOPHYS_CORE_PEER` (the scratch peer `/tmp/autophys-core-peer`, still not a
Cargo target) the atomic-remote, cross-writer, core-boundary, display and
reveal suites pass with no skips (119); `deno test --allow-read --config
html/deno.json html/` 141 passed; `deno check` clean; `python3
ops/test_deploy.py` 2 OK.

### Review round 2 fixes

A second review returned four non-blocking findings, fixed on yuzuquats
`~/workspace/autophys` master (nothing pushed or deployed):

- **Link rule wording.** `check_attachment_link` sees only the records
  before the event, but store.md, core-remediation.md and the RR1-a text
  said any measurement of the batch. They now say a measurement that
  precedes it in the batch, and that two events may name the same batch
  measurement (the removed route allowed one per event). The rule is
  unchanged. (`I8578c332baf934b775610c6785b200e4`)
- **Replay before the link check.** A byte-identical retry of a stored
  `data_attached` could be refused 422 when the rest of its batch changed.
  `Investigation::append_batch` now looks up replay first and link-checks
  only records it will write; `batch_data_attached_must_name_its_measurement`
  covers the retry and fails with the old order.
  (`I08f7f6d7d368165a3420f45e5e1a548d`)
- **Python fake parity.** `fake_server.py`'s batch applies the same rule
  after the same replay lookup; a test shows a mis-linked Python-shaped pair
  refused with nothing written. (`I5ec3496492578ab8173f5aaa86457c93`)
- **Stale status text.** The UI-27 SHAs above, the "UI-27 not implemented"
  notes, decisions.md's O-3a deploy step and core-remediation.md's CORE-04
  row now show what is built, by Change-Id. (`I8578c332baf934b775610c6785b200e4`)

Tests on yuzuquats, run one after the other: `cargo test --workspace
--locked` 344 passed, 0 failed, 2 ignored (the replay case extends an
existing test); `python3 -m pytest -q -p no:cacheprovider sdks/python/tests`
678 passed, 13 skipped (676 plus 1 new plus 1 from a peer's G8-LOOP commit).

### Deployed, 2026-11-08

The operator asked to deploy and test. `ops/deploy.sh` ran from a fresh clone
of local master `6590251` (the shared checkout holds a peer's untracked note,
which the clean-tree gate refuses), so the release still names its exact
source: `~/.local/share/tento/services/autophys/6590251-20261108`. The live
service previously ran `b6f420e` (origin/master), an ancestor of `6590251`.
The deploy gate's cargo and Deno suites passed with no failures.

Tested against the release binary:
- live 127.0.0.1:4794 and https://autophys.lona.so report `6590251`; the unit
  runs `--browser-origin http://autophys.yuzuquats.tento.localhost` beside the
  drop-in's origins; 0 restarts. The old attachment route and both
  `/workbench` routes answer 404; `/investigations/{inv}/records` asks for a key.
- `tests/e2e/sidebar-flow.ts` on two scratch daemons of the release binary:
  46 checks passed, 14 screenshots, a real `autophys connect` device approved
  in the New project stepper.
- Daemon-backed Python suites with `AUTOPHYS_RUST_BIN` set to the release
  binary (atomic remote, cross-writer, core boundaries, display, curves and
  reveal, HTTP, format 2): 165 passed, 1 skipped (live reasoner smoke).

Not published: these commits are not pushed and no SDK release was cut. SDK
0.1.x clients cannot attach data against this daemon (CORE-01a).

### Published, 2026-11-08

Pushed `f9b9a7b..551a1f8` (32 commits, this session's Change-Ids only) to
`https://github.com/yuzuquats/autophys` master as a fast-forward; no sink was
needed because a peer had already published its interleaved G8-LOOP commits.

Agent review receipt (independent read-only Opus reviewers; agent review, not
an operator verdict): round 1 at `0a65618` changes required (Thermal daemon
routes live, 5 non-blocking) → fixed; round 2 at `5cfb1a1` ready (5
non-blocking) → 4 fixed, 1 accepted; round 3 bound to base `f9b9a7b`, tip
`551a1f8`: ready. `git range-diff` showed the 27 round-2 commits unchanged by
the restack. Checks on an export of `551a1f8`: cargo 344 passed, 2 ignored;
Python 678 passed, 13 skipped.

Follow-ups from round 3 (the first two fixed after the push, below):
- `sdks/python/tests/fake_server.py` runs the link check before the
  same-id/different-content conflict, so it answers 422 where the daemon
  answers 409; add a Rust `store_contract` assertion for that case too.
- `decisions.md` cites pre-restack SHAs (`b116ef4`, `199c4fb`, `dac03c9`,
  `e0bf786`, `f88704d`, `68536e9`) without Change-Ids; replace them.
- No SDK release has been cut; 0.1.x clients cannot attach against the
  deployed daemon.

### Round 3 follow-ups: done

`I3e8a1c6f9b2d47058e3a1c9f6b2d4e70`: the Python fake server decides replay or
`idempotency_conflict` for a reused id before the link rule, as the daemon
does; `test_http.py` and `store_contract.rs` pin the 409 (the Python test
fails against the previous fake). Every cited SHA in this page and
`decisions.md` now resolves on master: pre-restack SHAs were mapped to their
published twins by Change-Id. `display-manifest.md`'s 2026-11-04 SHAs predate
this project and were left alone.

### DM-RS-1b: done

`I557040dea5ba1c992c8773410e81a509`. The operator changed DM-RS-1b
(2026-11-08, `decisions.md`): `impl Index<&str> for Trajectory` is removed,
so `traj["name"]` no longer compiles; use `output(name)?`, `t()?` or
`outputs()`. Callers converted with the same assertions: the oscillator and
thermal model tests, `synthetic.rs` (`observe` and `test_rmse` now return
the `ChannelError` as `autophys::Error::BadRequest` where they panicked), the
worker test, `tests/devtools.rs` and three `sdks/rust/tests` files. The
examples' Rust templates already used `output(name)?`.

Built-in source hashes (each model hashes its own file, test module
included): oscillator
`sha256:162eb4454d2a19f1934eefc6a8bba30e974e7f73c5d5eaf5c0a7b91093ccf60a` →
`sha256:8902b7058425bba67969b16ad5a98c91c41f108bf90f3bdf60636252d20667af`
(`bench` config version `sha256:b6d96378…` → `sha256:16061af7…`); thermal
`sha256:88eb6dc5cd8227b7e6c89ef6327e7d41526463317e9ead2435764a31e0cb40ba` →
`sha256:5afeae8315ea5ba360735a7ba12e0d046488cbf173dd5b8e663b332e2de43d66`
(`sha256:2eaa83c1…` → `sha256:633b1f25…`); battery unchanged. No golden,
conformance vector, fixture, test or doc pinned the old values (searched by
8-hex prefix outside `target/`), so none changed. Existing bench projects
show config drift on their next run, as accepted.

Breaking for release notes: `traj["name"]` is gone; the oscillator and
thermal source hashes, and so the config versions of projects built on
them, change once.

Tests: `cargo test --workspace --locked` 345 passed, 0 failed, 2 ignored.
