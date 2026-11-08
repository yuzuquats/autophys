# The store keeps one append-only log per workspace, and every write, SDK or browser, goes through one append

Status: implementation record, rev 2, 2026-11-04. This page records the
daemon's data layer: phase 3 of `architecture.md` (section "tento-autophys:
the daemon", decisions AX-1 to AX-6). It adds AX-7 onward, the operator's
rulings E-1, O-3 and S-1 to S-3 as they apply here, the places where the
SDK's draft contract has to change, and where this schema conflicts with
`workbook.md` (W-1 to W-8), which arrived after it was built.

The store was built and tested first as a standalone crate,
`tento/tento-autophys-store/` (never committed to tento), and then moved
into this repository (S-1 to S-3) in three commits:

```review-table
| Change-Id            | What |
| -------------------- | ---- |
| If37ad0401b72f2cf08d3 | `src/store/`, `src/ingest.rs`; `tests/store_rebuild.rs`, `tests/store_vectors.rs`, `tests/vectors/chain.json` |
| I4d08654b208926c9a4aa | `src/http.rs`, `src/http/`; the `configure_api_v1` hook body, `AppConfig::store`, `serve --db`; `tests/store_contract.rs`, `tests/store_mount.rs` |
| I4c43653dfb20677d72ae | `src/admin.rs` (`autophys pair`, `keys`, `db`); `tests/store_admin.rs` |
```

## What it is

One SQLite file, WAL mode. The `records` table is the only source of truth:
client-chosen `id`, per-investigation `seq` from 0, `kind`, `ts`, canonical
JSON `payload`, and `hash = sha256(prev_hash ‖ canonical{id, kind, payload})`
chained from 64 zeros. Triggers refuse `UPDATE` and `DELETE` on it.
`investigations` and `proposals` are projections, rebuilt from the log by
`db_check(rebuild = true)`. `projects`, `config_versions`, `keys` and
`pairings` are reference data written directly.

```review-flow
flowchart LR
  sdk[SDK HttpStore]:::changed -->|Bearer key| http[src/http.rs\nactix configure]:::new
  ui[browser, same origin]:::new -->|no key: reads, approvals, pairings| http
  http --> ingest[src/ingest.rs\nStore::append]:::new
  ingest -->|one tx: replay, check, chain, insert, project| db[(SQLite WAL\nrecords + projections)]:::new
  ingest -->|after commit, in gseq order| bus[broadcast]:::new
  bus --> sse[GET /stream?after=gseq]:::new
  cli[autophys pair, keys, db]:::new --> store[src/store]:::new
  store --> db
```

One writer thread owns the read-write connection; handlers send it closures
over a channel and await the reply. Reads use a small pool of read-only
connections under `spawn_blocking`. The writer thread broadcasts each record
right after its commit, so subscribers see `gseq` order. An SSE subscriber
registers before it reads its backlog and drops anything at or below its
cursor, so nothing falls in the gap. A subscriber that lags re-reads from the
database.

`append(inv, envelope)` runs in this order: idempotent replay by client id,
then payload validation (422 with a field path), then `projections::check`
(409 on an illegal proposal transition), then seq and hash, insert, apply the
projections, commit, broadcast.

## Routes

```review-table
| Route (under /api/v1)                                   | Auth           | Notes |
| ------------------------------------------------------- | -------------- | ----- |
| `POST /pair/start`, `/pair/poll`                        | none           | RFC 8628 errors: authorization_pending, slow_down, access_denied, expired_token |
| `GET /pairings`, `POST /pairings/{code}/approve, /deny` | key or browser | O-3; never shows device codes or keys |
| `GET /whoami`                                           | key            | account, workspace, key_id, device_name |
| `GET/POST /projects`                                    | key            | idempotent by name: 201 new, 200 existing |
| `GET /projects/{pid}/config_versions`, `PUT …/{version}` | key           | 422 hash_mismatch unless version = sha256 of the body bytes |
| `PUT /projects/{pid}/display`                         | key            | format 1 only, 256 KiB uploaded/canonical cap; 201 changed, 200 duplicate; returns {project_id, digest} |
| `GET/POST /investigations`                              | key            | 409 unknown_config_version; Idempotency-Key replays to the same id |
| `GET /investigations/{id}/records?kind=`                | key            | the SDK's 8 Record fields |
| `POST /investigations/{id}/records`                     | key            | CORE-01 batch: `{records: [{id, kind, payload, hash_of?}]}` (1 to 64) appended in order, all or none, in one transaction; each gets `Investigation::append`'s store validation keyed by record id (kind, payload shape and size, replay/conflict, proposal state machine), not the single routes' rules (no per-route kind or event allowlist, no path proposal id, no server-stamped `by`; keys only); a `data_attached` event the batch writes must name a measurement that precedes it in the batch when it links into the batch or a measurement precedes it (hash, as both SDKs send since RR1-b, or the payload `version` older Python clients send); two events may name the same batch measurement (the removed route allowed one measurement per event); a stored record retried unchanged replays without this check; `hash_of` fills payload fields with an earlier record's hash; → `{records: [{record, gseq, created}], gseq}`, 201 if any is new; no Idempotency-Key. Replaces `…/proposals/{pid}/attachment` (removed, CORE-01a) |
| `POST …/{measurements,runs,steps,outcome}`              | key            | append → `{record, gseq}`; 400 if the envelope kind is not the route's |
| `POST …/reveal`                                         | key            | append opaque reveal after outcome; 409 outcome_required before, already_revealed for a second distinct reveal; retries replay |
| `POST …/proposals`                                      | key            | event proposed or withdrawn |
| `GET …/proposals/{pid}`                                 | key            | proposal_id, status, experiment, settings |
| `POST …/proposals/{pid}/approvals`                      | key or browser | approved, edited (settings inside the outlook, AX-15), rejected; 409 unless proposed |
| `POST …/proposals/{pid}/data`                           | key            | data_attached; 409 unless approved or edited |
| `GET /workspace`                                        | key or browser | one read transaction: cursor, projects, configs, projections, records |
| `GET /stream?after={gseq}&investigation={id}`           | key or browser | SSE, framing below; Last-Event-ID resumes; `investigation` is optional |
```

Errors are `{error, message}`, plus `path` on a 422, as the SDK's
`request_json` reads them. Every append route answers `{record, gseq}`: 201
for a new record, 200 for a replay, which reports the stored `gseq`.

### A record, exactly

```review-table
| Field           | Type and rule |
| --------------- | ------------- |
| `id`            | client-chosen, 1 to 128 of `[A-Za-z0-9_.:-]`; unique across the workspace |
| `investigation` | `inv_` + 16 hex, assigned by `POST /investigations` |
| `seq`           | integer, per investigation, **starting at 0** (the investigation record) and contiguous; assigned by the store |
| `kind`          | investigation, measurement, run, step, proposal, outcome, reveal |
| `ts`            | JSON number, **unix seconds as a float** with microsecond resolution, taken by the store at insert; stored as SQLite REAL; not hashed |
| `payload`       | JSON object, returned as parsed from its stored canonical text |
| `prev_hash`     | the previous record's `hash`; 64 zeros at seq 0 |
| `hash`          | lowercase hex `sha256(prev_hash + canonical({id, kind, payload}))` |
```

No other field is ever added to a record. `gseq`, the workspace-wide order
(SQLite rowid, from 1, increasing, never reused), travels beside it: in
append responses, in the SSE `id:` line and as `/workspace`'s `cursor`.

### Stream framing

`Content-Type: text/event-stream`. Each record is one event:

```
id: <gseq>
event: record
data: <the record as one line of JSON, the 8 fields above>

```

After 15 s with no record the store sends `: keep-alive` and a blank line.
`?after=` and `Last-Event-ID` both mean "records with a larger gseq"; the
larger of the two wins. `?investigation=` limits events to one investigation
(AX-16). The stream ends only when the daemon stops.

## Decisions

```review-callout
kind: decision
title: AX-7: the data layer is a framework-free core plus a thin actix layer (placement superseded by S-1 to S-3)
Agent-chosen, then placed by the operator. Before: the spec put
`src/store/`, `src/ingest.rs` and `src/http/` inside the daemon crate. The
first build made it a separate library crate, `tento-autophys-store`, which
the daemon would mount with `.nest("/api/v1", router(store))`. The strongest
alternative was a module inside the daemon crate. A separate crate let the
store be tested and reviewed while the daemon was still in progress
elsewhere, and kept web types out of the core. The operator then ruled
(S-1 to S-3) that it lives in this repository as modules, with the actix
layer as `configure(cfg, state)`. What survives of AX-7 is the split: no
actix type appears in `src/store` or `src/ingest.rs`, and `src/http.rs` only
maps requests to `Store` calls and `StoreError` to responses. Reversing it
costs one file: wrap the modules in a crate again.
Implementation: done. The standalone copy in `tento/tento-autophys-store/`
stays uncommitted until the orchestrator removes it.
```

```review-callout
kind: decision
title: AX-8: where the SDK and the spec disagree, the store follows the SDK
Agent-chosen, pending operator review. The spec's sketch starts `seq` at
`head.seq + 1` from `(0, GENESIS)`, which gives 1. The SDK's `Store.verify`
requires `seq == i` from 0, so the first record is seq 0. The spec types `ts`
as TEXT; the SDK's `Record.ts` is a float, so the store keeps unix seconds as
REAL. The SDK builds `Record(**json)` and rejects unknown fields, so every
record response carries exactly its 8 fields. The global cursor `gseq` goes
in the SSE `id:` line and in `/workspace`'s `cursor`, never in the record.
The alternative was to follow the spec and change the SDK, which would break
its 55 passing tests for no gain. Reversal is a migration plus an SDK release.
```

```review-callout
kind: decision
title: AX-9: a same-origin local browser reads without a key; the reasoning rests on the loopback bind
Agent-chosen, pending operator review (its write half is O-3, below).
`autophys serve` binds only literal loopback addresses (`parse_loopback`).
Every peer is therefore a local process or the operator's tento.localhost
proxy, which splices the browser's bytes through unchanged. A key protects
nothing against a local process that can read the database file. The threat
that is left is the operator's own browser driven by a hostile page. A
keyless read needs `Sec-Fetch-Site: same-origin`, which page script cannot
set. Its Host must be a loopback literal, `localhost` or `*.localhost`
(DNS rebinding presents the attacker's own host). An Origin, if present,
must match that host. A known TCP peer must be loopback. This covers
`/workspace`, `/stream` and `GET /pairings` only.
The alternative was a session cookie minted by the served page. It is more
machinery for the same guarantee on a loopback daemon, and D1 (non-loopback
serving) would replace both. If the bind ever widens, this exemption must go
first. Reversal: delete the extractor's browser branch.
```

```review-callout
kind: decision
title: AX-10: idempotency is checked before state, and a reused id with new content is refused
Agent-chosen, pending operator review. A replayed client id returns the
stored record with 200 (a new one gets 201). It does so even when the
proposal has since moved on, so an SDK retry of an approval after a timeout
succeeds instead of getting 409. The fake server checks state first and would
return 409. The same id with a different investigation, kind or payload gets
409 `idempotency_conflict`; the fake silently returns the old record.
`Idempotency-Key`, when sent, must equal the envelope id (400). The
alternative was to mirror the fake exactly. That turns a lost response into
a hard error and hides client id collisions. Reversal: two branches in
`ingest.rs`.
```

```review-callout
kind: decision
title: AX-11: canonical JSON is re-implemented to match Python byte for byte
Agent-chosen, pending operator review. The SDK hashes
`json.dumps(sort_keys=True, separators=(",", ":"))`, which escapes
everything outside printable ASCII (`ensure_ascii`) and prints floats with
`repr` (`1e-05`, `1e+16`, `3.0`). serde_json differs on both, so the store
writes its own canonical form, and stores that text as the payload.
The shared vectors at `tests/vectors/chain.json` pin it: each is
`{envelope, prev_hash, canonical, hash}`, where `canonical` is the hashed
text of `{id, kind, payload}`. They were written by Python's json and hashlib,
cover float repr, unicode escapes and key order, and are asserted by
`cargo test` and, from the same file, by the SDK. A live run of the SDK's own HttpStore and investigation loop against the
store passed `store.verify()` over 19 records of real fit payloads. The alternative was to
let the server choose its own canonical form and have the SDK adopt it. That
changes the SDK's hash rule and invalidates its stored logs. Known gap:
integers outside the 64-bit range arrive as floats in serde_json, so their
hash would differ. Physics payloads do not carry such integers today.
```

```review-callout
kind: decision
title: AX-12: projection rules
Agent-chosen, pending operator review. `apply` reads only the record and
existing projection rows, so a replay rebuilds both tables exactly (tested).
An investigation's first record carries `project_id`, `config_version` and
`overrides`, merged over the client's `meta`, so the pin survives a rebuild.
`status` is `open` at start, `awaiting_approval` after `proposed`,
`awaiting_data` after `approved` or `edited`, and `open` after `rejected`,
`withdrawn` or `data_attached`. An outcome sets it to the outcome's own
status (`validated`, `inconclusive`, …). `budget_used` counts measurement
records. Proposals are keyed by (investigation, proposal_id), since proposal
ids are client-chosen. The alternative was to fold these rules in the client
(derive), which the UI agent may still prefer for display. Reversal: edit
`projections::apply` and run `autophys db check --rebuild`.
```

```review-callout
kind: decision
title: AX-13: pairing never stores a usable secret
Agent-chosen, pending operator review. Only sha256 hashes of device codes
and keys are stored. Approval only marks the pairing. The key is minted by
the first poll after approval and returned once; later polls get
`expired_token`. User codes are `BCDF-1234` style (no vowels, no 0/O or
1/I). Polls faster than 80 % of the interval get `slow_down`. Keys are
`apk_` + 64 hex, ids `k_` + 12 hex. `whoami` reports account and workspace
`local` (single-user daemon). `pair_deny` exists so a person can refuse a
device (`access_denied`). The alternative was to mint the key at approval
time. That needs the plaintext held somewhere until the poll arrives.
Reversal: local to `store/keys.rs`.
```

```review-callout
kind: decision
title: AX-14: what validation checks, and what it leaves alone
Agent-chosen, pending operator review. Ids (record and proposal) are 1 to
128 characters of `[A-Za-z0-9_.:-]`. A payload must be an object of at most
1 MiB canonical (413 above that). Beyond that, validation checks only what
the projections read: `measurement.observation` is an object, `outcome.status`
a string, a proposal's `proposal_id` and `event`, `proposed.experiment`,
`edited.settings` and `data_attached.measurement_version`. Every other field
passes through untouched. `withdrawn` is accepted on `POST …/proposals` (the
spec's state diagram has it; the SDK has no route yet). The alternative was
full schemas per kind. Those would freeze the SDK's run and step payloads
while they are still changing. Reversal: add checks in `store/validate.rs`.
```

```review-callout
kind: decision
title: AX-15: an edit may only move the outlook's axes, within their range
Directed by the orchestrator on 2026-11-04 (answers sdk.md question 5); the
details are agent-chosen, pending operator review. When the proposal carries
an outlook, an `edited` decision is refused with 422 at
`payload.settings.<name>` if a setting that is an outlook axis is not a
number inside `[min, max]` of that axis's values (inclusive, with 1e-9
relative slack), or if a setting that is not an axis differs from its
proposed value. A proposal without an outlook is not checked, since the store
cannot know what is editable. The strongest alternative was to check against
the config's catalog `edit` limits (E-1a). That needs the store to parse
configs, which it treats as opaque bytes. The outlook covers exactly those
limits. Reversal: one function, `projections::check_edit`.
```

```review-callout
kind: decision
title: AX-16: the stream can be limited to one investigation
Agent-chosen, pending operator review (answers sdk.md question 4).
`GET /stream?investigation=<id>` emits only that investigation's records.
The cursor still advances past the others, so resume and dedupe work the
same. The workspace-wide stream stays the default, which is what the browser
uses. The alternative was client-side filtering only. That costs a waiting SDK
the whole workspace's traffic. Reversal: drop the query field.
```

```review-callout
kind: decision
title: AX-17: the daemon's database lives in tento-dirs' data directory
Agent-chosen, pending operator review. `autophys serve` and the `pair`,
`keys` and `db` commands open `--db`, else `AUTOPHYS_DB`, else
`~/.local/share/tento/autophys/autophys.db` (tento-dirs `data`, the fleet's
durable app directory, beside the dev route tree that already uses its
`cache`). The architecture page's example was
`~/.local/share/autophys/autophys.db`. The alternative keeps that path. It
matches the page, but it sits outside the directories tento-dirs declares
and backs up. Reversal: one line in `default_db`, plus moving any existing
file. workbook.md (W-6, W-7) will replace this single file anyway.
```

```review-callout
kind: decision
title: E-1 (operator, 2026-11-04): proposal outlooks are validated and passed through
Operator-decided. A `proposed` payload may carry
`outlook: {axes: [{name, values}], score, after: {param: values}}`,
row-major, at most 3 axes. Each array's length must equal the product of the
axis lengths, and every value must be finite; otherwise 422 with the field
path (`payload.outlook.after.C`). The daemon never computes from it.
Agent-chosen within E-1, confirmed by the operator 2026-11-08: zero axes is allowed (a scalar, one
cell); an axis with no values is refused.
```

```review-callout
kind: decision
title: O-3 (operator, 2026-11-04): pairings can be approved from the browser, and keyless writes are guarded
Operator-decided. `GET /pairings` lists pending pairings (user_code,
device_name, client, expires). `POST /pairings/{code}/approve` and `/deny`
are keyless for the same-origin local browser. Every keyless state-changing
route (approvals, pairing approve and deny) requires
`Content-Type: application/json` (else 415) and an `Origin` equal to the
daemon's own origin (else 403). Keyed SDK calls need neither.
Agent-chosen within O-3, confirmed by the operator 2026-11-08 (deploy to pass the host's exact origin): "own origin" is computed from the
port the server is bound to (`http://127.0.0.1:<port>`,
`http://localhost:<port>`, `http://[::1]:<port>`), plus
`Options::browser_origins`. Through tento.localhost the page's origin is
`http://autophys.<host>.tento.localhost`. That origin is refused until the
daemon lists it in `browser_origins`, so approvals from the dashboard need
that one setting.
```

## The SDK must change

```review-table
| # | Today (SDK / fake) | Real store | SDK change |
| - | ------------------ | ---------- | ---------- |
| 1 | `API_PREFIX = "/api/modellab"`, server hacks.lona.so | `/api/v1` on 127.0.0.1:4794 | done in `sdks/python` |
| 2 | `Record(**json)` raises on unknown fields | sends exactly 8 fields; `gseq` beside the record | done in `sdks/python` (`_RECORD_FIELDS` filter) |
| 3 | no way to withdraw; `PROPOSAL_EVENTS` lacks `withdrawn` | `withdrawn` on `POST …/proposals` | add the event to `store.py` and `HttpStore.append` |
| 4 | fake: a replayed approval gets 409; a replay is always 201 | replay gets 200 with the stored record, before any state check (AX-10) | update the fake; clients must accept 200 |
| 5 | fake: the same id with new content returns the old record | 409 `idempotency_conflict` | update the fake; treat it as a client bug |
| 6 | fake accepts any event on `/approvals` and `/data` | 422 `payload.event` outside the route's events | update the fake |
| 7 | keys are `mlk_…` (`test_cli_pair` asserts the prefix) | `apk_…` | done in `sdks/python` |
| 8 | integers of any size | 64-bit integers only, or the hash differs (AX-11) | send counts as ints, large values as floats |
| 9 | `verification_url` from the server | `http://127.0.0.1:4794/pair` by default; that page is not built yet | none; the UI owes the page (O-3) |
```

## Answers to sdk.md's contract questions

```review-table
| # | Question | Answer |
| - | -------- | ------ |
| 1 | GET routes missing from the architecture table | All four exist; see Routes above. |
| 2 | `gseq` in POST responses | Done: `{record, gseq}`, replay included. The record itself never carries it. |
| 3 | SSE framing | As in "Stream framing" above; `event: record` is always sent. |
| 4 | Stream scope | Workspace-wide by default; `?investigation=` filters (AX-16). |
| 5 | Edited settings outside the outlook | Refused with 422 (AX-15). |
| 6 | SDK posting approvals with a key | Intended: `…/approvals` takes a key or the browser. |
| 7 | `withdrawn` | Accepted on `POST …/proposals`, only from `proposed`. |
| 8 | Canonical JSON parity | Settled: `tests/vectors/chain.json`, plus a live SDK run whose `verify()` passed (AX-11). |
| 9 | `seq` and `ts` | seq from 0; ts float unix seconds (see "A record, exactly"). |
| 10 | A laptop SDK | tento.localhost splices bytes unchanged, so `Authorization` passes; base URL `http://autophys.<host>.tento.localhost`. `verification_url` defaults to `http://127.0.0.1:4794/pair` (`Options::verification_url`); the daemon should set it to the proxied URL once the page exists. |
| 11 | `whoami` account and workspace | Both `local` (`Options`). |
| 12 | Payload size | 1 MiB of canonical payload, 413 above; the request body may be 64 KiB larger. |
| 13 | Reason lane | Not in the store's scope. |
```

## Where this schema conflicts with workbook.md

workbook.md (W-1 to W-8, operator, 2026-11-04) arrived after this store was
built. It makes `src/store` the reference for a per-project
`<project>.ap-workbook` file. The committed schema does not match it yet.
These are reported here, not resolved; the orchestrator relays them to
autophys/api:

```review-table
| # | workbook.md says | The committed store does | Consequence |
| - | ---------------- | ------------------------ | ----------- |
| 1 | W-6: one workbook per project; a collection is a directory of them | one database for the whole daemon, holding every project (`projects`, `config_versions` keyed by project) | `Store::open` opens a workspace, not a workbook; a collection layer is missing |
| 2 | W-3: the workbook omits the key and pairing tables; those move to the server's own database | `keys` and `pairings` live in the same file (migration 1) | splitting needs a second database and a migration that drops them from workbooks |
| 3 | W-3: a hash-addressed `blobs` table for arrays | no `blobs` table; payloads are inline JSON up to 1 MiB | E-1 outlooks and measurements stay inline until blobs exist |
| 4 | AX-4 stream cursor (`gseq`) with many files | `gseq` is the rowid of the one `records` table | per-workbook files need a cursor such as `(project, gseq)` or a server-level sequence |
| 5 | W-4: Python sqlite3 also writes the file | projections are written only by Rust's `projections::apply` | a Python writer must apply the same rules (AX-12), or `db check --rebuild` must follow its writes |
```

The schema is plain SQLite throughout: triggers using `RAISE`, a partial
unique index, no custom functions or collations, and migrations by
`PRAGMA user_version`. So Python's stdlib `sqlite3` can read and write it.
The only JSON function used is `json_extract`, in a query in
`projections::check_edit`, not in stored SQL. Per the orchestrator's rule,
the `records` table, a future `blobs` table and the migrations will not
change without asking first.

## Validation

In this repository, `CARGO_TARGET_DIR=~/.cache/autophys/target cargo test`
passes: 13 lib unit tests (6 of them the store's), 9 daemon socket tests,
1 admin, 16 HTTP contract, 1 mount, 3 rebuild and 1 vector test. rustfmt is
clean and clippy reports nothing in autophys. Each commit was verified the
same way in a clean `git archive` export of its own tree. The contract tests
cover every route, auth refusal, the browser rules, O-3, E-1 and AX-15,
idempotent replay, the 409 and 422 paths, hash-chain continuity and SSE
resume with the investigation filter. `tests/store_mount.rs` runs the hook
in the real tento-web app over a loopback socket and sees the first SSE
frame unbuffered. The SDK live run is recorded above (AX-11).

## Remaining

- Converge on workbook.md (the conflicts above). Schema changes to
  `records`, `blobs` or migrations wait for the orchestrator's answer.
- `serve` has no flag yet for `Options::browser_origins`, so approving from
  the tento.localhost dashboard is refused (403) until one is added (O-3).
- A `/pair` page in the UI (O-3, row 9 above).
- An open SSE response holds a graceful stop until actix's 10 s shutdown
  timeout. The stream does not yet end on shutdown.
- SSE fan-out and the single writer are unmeasured beyond the test suite.


### Project display manifests (DM-1)

`PUT /api/v1/projects/{pid}/display` takes the manifest itself as JSON,
requires a valid key, and returns `{project_id, digest}`. Unsupported,
missing or non-integer format and malformed JSON return 422; oversized
uploaded or canonical bytes return 413. Unknown projects return 404.
The latest upload replaces the current manifest; canonical duplicates return
200 without a write. The daemon reads only `format`.

Each project in `GET /workspace` has `display: <manifest|null>`. Each workbook
snapshot includes it atomically with the records. In all stream scopes,
including `?investigation=`, `event: display` carries
`{project_id, digest, display}` for that scope's projects, without an `id:`.
It resends the current manifest on connection/reconnection, then sends changes
on wakeup or the one-second external-writer poll. Display events leave
Last-Event-ID and record cursors intact. Intermediate uploads can coalesce.


### Ground-truth reveal and recorded curves (GT-1 / FC-1)

`POST /api/v1/investigations/{inv}/reveal` uses the ordinary
`{id, kind: "reveal", payload: {...}}` envelope and keyed authentication.
It returns `{record, gseq}` (201 new, 200 identical retry). It requires an
outcome in that investigation (`409 outcome_required`) and refuses a second
distinct reveal (`409 already_revealed`). A reused id with changed content
is `409 idempotency_conflict`. Payload fields are opaque to the daemon.
Reveal records appear in records/workspace and `event: record` streams.

`POST …/runs` validates optional `payload.curves` per
[workbook-format.md](workbook-format.md): finite per-channel arrays, matching
lengths including optional downsampled `t`, at most 2000 points, and a
256 KiB canonical whole-run cap when curves is present. Invalid shape is
422, excess bytes 413. Runs without curves keep the 1 MiB payload cap.
