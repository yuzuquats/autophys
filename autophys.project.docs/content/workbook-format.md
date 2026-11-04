# The `.ap-workbook` file format, version 1

Status: format spec, rev 1, 2026-11-04. It turns the operator decisions in
[`workbook.md`](workbook.md) (W-3, W-4, W-6) into a byte-level contract. The
reference implementation is the Rust store (`src/store`); the Python SDK
implements the same rules in `sdks/python/src/autophys/workbook.py` with the
standard library's `sqlite3`. `tests/conformance/` holds what both sides
must pass.

## The file

- One SQLite 3 database per project, named `<slug>.ap-workbook`. The slug is
  the project name lowercased, every run of characters outside `a-z 0-9 . _ -`
  replaced by `-`, leading and trailing `-` and `.` removed (`project` if
  nothing is left). The name inside the file is authoritative; a slug
  collision is refused when the stored name differs.
- `PRAGMA application_id = 1095784258` (`0x41505742`, ASCII `APWB`). A file
  without it is not a workbook; an empty new file is initialised.
- `PRAGMA user_version = 1` for this schema. Migrations append steps and never
  edit a shipped one.
- `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, busy
  timeout 5 s. Several processes may open the file; writes are serialised by
  SQLite.
- Exactly one row in `projects`. A workbook refuses a second project name.
- Keys and pairings are not in a workbook. They belong to the server's own
  database.

## Schema version 1

```sql
CREATE TABLE records (
  gseq          INTEGER PRIMARY KEY,      -- order within this workbook
  id            TEXT NOT NULL UNIQUE,     -- client-chosen record id
  investigation TEXT NOT NULL,
  seq           INTEGER NOT NULL,         -- per-investigation order, from 0
  kind          TEXT NOT NULL,
  ts            REAL NOT NULL,            -- unix seconds, microsecond precision
  payload       TEXT NOT NULL,            -- canonical JSON
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  UNIQUE (investigation, seq)
);
CREATE TRIGGER records_no_update BEFORE UPDATE ON records
  BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
CREATE TRIGGER records_no_delete BEFORE DELETE ON records
  BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;

CREATE TABLE investigations (             -- projection
  id TEXT PRIMARY KEY, project TEXT NOT NULL, config_version TEXT NOT NULL,
  overrides TEXT NOT NULL, status TEXT NOT NULL, budget_used INTEGER NOT NULL,
  created REAL NOT NULL, updated REAL NOT NULL);
CREATE TABLE proposals (                  -- projection
  investigation TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
  experiment TEXT, settings TEXT, updated REAL NOT NULL,
  PRIMARY KEY (investigation, id));

CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created REAL NOT NULL);
CREATE TABLE config_versions (
  project TEXT NOT NULL REFERENCES projects(id), version TEXT NOT NULL,
  body TEXT NOT NULL,                     -- the exact bytes that were hashed
  created REAL NOT NULL, PRIMARY KEY (project, version));
CREATE TABLE blobs (                      -- content-addressed arrays (W-3)
  sha256 TEXT PRIMARY KEY,                -- "sha256:<hex>" of bytes
  media_type TEXT NOT NULL, bytes BLOB NOT NULL, created REAL NOT NULL);
```

`records` is the only source of truth. The two projection tables are rebuilt
exactly by replaying `records` in `gseq` order through the fold below.
`blobs` is in the schema so the format does not change when records start
referring to arrays by hash; version 1 records still carry arrays inline.

## Values

- Ids (record, proposal): 1 to 128 characters of `A-Z a-z 0-9 _ - . :`.
  Projects are `prj_` + 16 lowercase hex, investigations `inv_` + 16 hex.
- `ts`: `floor(unix_nanoseconds / 1000) / 1e6`.
- Canonical JSON: Python's `json.dumps(obj, sort_keys=True,
  separators=(",", ":"))` with `ensure_ascii` and float `repr`; NaN and
  infinities are `null`. `tests/vectors/chain.json` holds the shared vectors.
- `hash = sha256_hex(prev_hash + canonical({id, kind, payload}))`;
  `prev_hash` of seq 0 is 64 zeros.
- A config version is `"sha256:" + sha256_hex(body)` where `body` is the
  canonical config text.

## Appending a record

One `BEGIN IMMEDIATE` transaction, in this order:

1. Validate the envelope and payload (below). The canonical payload must be
   at most 1 MiB.
2. Replay: an existing record with the same `id` is returned unchanged when
   its investigation, kind and canonical payload match; otherwise the append
   fails with `idempotency_conflict`.
3. The investigation must exist (`not_found`).
4. Proposal transitions: `proposed` only for a new proposal id
   (`proposal_exists`); `approved`, `edited`, `rejected`, `withdrawn` only
   from `proposed`; `data_attached` only from `approved` or `edited`
   (`conflict`). An unknown proposal is `not_found`.
5. `edited` limits: when the `proposed` payload has `outlook.axes`, each
   edited setting that is an axis must be a number within the axis's
   `[min, max]` (slack `1e-9 * max(|lo|, |hi|, 1)`); every other setting must
   equal the proposed value (compared as canonical JSON).
6. `seq` and `prev_hash` from the investigation's head, `hash`, insert, fold.

Creating an investigation appends its seq-0 `investigation` record the same
way. The payload is the client's meta with `project_id`, `config_version` and
`overrides` (default `{}`) set; the pinned config version must be stored
(`unknown_config_version`).

## Payload validation

| Kind | Rule |
| --- | --- |
| any | payload is a JSON object |
| `investigation` | `project_id`, `config_version` non-empty strings |
| `measurement` | `observation` is an object |
| `outcome` | `status` non-empty string |
| `run`, `step` | none |
| `proposal` | `proposal_id` a valid id; `event` one of `proposed approved edited rejected withdrawn data_attached` |
| `proposed` | `experiment` non-empty string; `settings` absent, null or an object; `outlook`, when present: `axes` an array of at most 3 `{name, values}` with non-empty finite number arrays, `score` and every `after[param]` finite arrays with the product of the axis lengths |
| `edited` | `settings` an object |
| `data_attached` | `measurement_version` present and not null |

Booleans are not numbers.

## The projection fold

For each record in `gseq` order:

- `investigation`: insert `(id, project_id, config_version,
  canonical(overrides or {}), 'open', 0, ts, ts)`. Nothing else.
- `measurement`: `budget_used += 1`.
- `outcome`: `status = payload.status` when it is a string.
- `proposal`: `proposed` inserts `(investigation, proposal_id, 'proposed',
  experiment, canonical(settings) or NULL, ts)`; every other event sets
  `state = event, updated = ts`, and `edited` also sets `settings`. Then the
  investigation's status becomes `awaiting_approval` (proposed),
  `awaiting_data` (approved, edited) or `open` (rejected, withdrawn,
  data_attached).
- `run`, `step`: nothing.
- Every kind except `investigation` then sets the investigation's
  `updated = ts`.

`gseq` orders records within one workbook only. A server that streams
several workbooks needs its own cursor, such as `(project, gseq)`; that is
the server's concern, not the file's.

## Watching for changes

A reader in another process polls `PRAGMA data_version`; it changes when any
other connection commits. The SDK's local `wait_for_approval` uses it.

## Conformance

`tests/conformance/` holds golden workbooks written by the Python SDK, each
with a JSON file of its expected projection rows and chain heads. The Python
suite checks that it reproduces them. The Rust store should open each golden
workbook, verify every chain, rebuild the projections and compare them with
the JSON, and write its own workbook for the Python suite to verify.
