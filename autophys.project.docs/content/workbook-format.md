# The `.ap-workbook` file format, versions 1 to 3

Status: format spec, rev 1, 2026-11-04. It turns the operator decisions in
[`workbook.md`](workbook.md) (W-3, W-4, W-6) into a byte-level contract. The
reference implementation is the shared Rust store (`sdks/rust/src/workbook.rs`); the Python SDK
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
- `PRAGMA user_version` is the workbook format: 1, 2 or 3 (format 2 adds the
  display table, format 3 the overviews table, below). A new workbook is
  created at format 1. Migrations append steps and never edit a shipped one.
  Readers accept formats 1 to 3 and refuse a newer one, on open and when
  another process wrote it after open. A step past format 1 runs only inside
  the write that needs it, never on open (DM-D1a): a display write moves a
  workbook to exactly format 2, and only an overview write moves it to 3.
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
6. For `reveal`, an `outcome` record must exist in this investigation
   (`409 outcome_required`) and no earlier `reveal` may exist
   (`409 already_revealed`). This check and append share the same
   `BEGIN IMMEDIATE`. Idempotent replay is checked first, so the same
   id/kind/payload succeeds after the first reveal.
7. `seq` and `prev_hash` from the investigation's head, `hash`, insert, fold.

Creating an investigation appends its seq-0 `investigation` record the same
way. The payload is the client's meta with `project_id`, `config_version` and
`overrides` (default `{}`) set; the pinned config version must be stored
(`unknown_config_version`).

## Format 2: the display table (DM-D1)

Format 2 is format 1 plus the `display` table (operator, 2026-11-08: DM-D1
and DM-D1a). A workbook reaches format 2 at its first display write, never
on open, so a workbook without a display stays format 1 and readable by SDK
0.1.x, which refuses format 2. The display is authoritative presentation
data, outside the record log and projection rebuild, and does not affect
config or source hashes.

Migration step 1 to 2 is exactly this statement (both SDKs run the same
bytes, so `sqlite_master` holds the same text, without `IF NOT EXISTS` and
the `;`):

```sql
CREATE TABLE IF NOT EXISTS display (
              project TEXT PRIMARY KEY REFERENCES projects(id),
              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL
            );
```

A display write (Rust `Workbook::put_display`, which the daemon's
`PUT /projects/{pid}/display` calls; Python `WorkbookStore.put_display`)
runs in one `BEGIN IMMEDIATE` transaction: refuse a format above 2, run the
steps up to 2 and set `user_version = 2`, then compare digests and upsert.
It commits even when the digest is unchanged, and a failed write leaves the
file at format 1. Reading a display never creates the table or changes the
format. A display write upgrades to exactly format 2, never to the current
format: a workbook at format 3 stays at 3, and a display-only workbook stays
readable by SDKs that read up to format 2 (OV-2).

SDKs before format 2 created the same table, with the same statement, as an
optional extension of format 1. Such a file reads as is (its display
included) and becomes format 2 on its next display write, even an unchanged
one.

There is one latest row per project. `body` is canonical JSON; `digest` is
the bare lowercase sha256 of those bytes. Both uploaded bytes and canonical
bytes must fit 256 KiB. Only an object with integer `format: 1` is accepted;
all other fields are opaque. An identical canonical digest is a no-op,
including its creation timestamp. A different upload replaces the row in
`BEGIN IMMEDIATE` order, including a return to an earlier digest.

`Workbook::snapshot` reads the display (if any) in the same transaction as
records/configs. `/workspace.projects[]` includes `display: <manifest|null>`.
`/stream` sends `event: display` with
`{project_id, digest, display}` and no event id: records keep their cursors.
The latest display is sent on reconnect, then when its digest changes.
Intermediate uploads may coalesce; the latest committed upload wins.

## Format 3: the overviews table (OV-1 to OV-4)

Format 3 is format 2 plus the append-only `overviews` table
([overview-sdk.md](overview-sdk.md)). A workbook reaches format 3 at its
first overview write, never on open or on read, so a workbook without an
overview stays at format 1 or 2. SDKs that read up to format 2 refuse it
afterwards. Migration step 2 to 3 is exactly this statement, byte-identical
in both SDKs and in `tests/conformance/overview/cases.json` (`ddl`):

```sql
CREATE TABLE IF NOT EXISTS overviews (
  seq INTEGER PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(id),
  digest TEXT NOT NULL,
  markdown TEXT NOT NULL,
  author TEXT NOT NULL,
  created REAL NOT NULL
);
```

Each row is one version of the project's Markdown research note; rows are
only inserted. The latest version is the highest `seq`, not the latest
`created`. `digest` is the bare lowercase sha256 of the Markdown's UTF-8
bytes.

An overview write (Rust `Workbook::put_overview(markdown, author)`, Python
`WorkbookStore.put_overview(project_id, markdown, author)`) runs in one
`BEGIN IMMEDIATE` transaction: refuse a format above 3, run the steps up to 3
and set `user_version = 3`, compare the digest with the latest version's, and
insert a row only when it differs (`changed`). The author is not part of the
comparison. A write is refused only for an empty or whitespace-only body
(`invalid_payload`, path `markdown`), more than 256 KiB of UTF-8
(`payload_too_large`), invalid UTF-8, or an author that is empty or longer
than 200 characters (path `author`); a refused write leaves the file as it
was.

Everything else is advisory (OV-3). The write returns warnings
`{code, message, line?, reason?, investigation?, attribute?}` from a
canonical-form lint (OV-13), in document order. An insert is canonical when
it is written alone on one line at column 0, after a blank line or at the
start of the document, as `<ap-investigation …></ap-investigation>`, outside
fenced and indented code; a line that holds a `|` must also be followed by a
blank line or the end, or the next line could make it a table header. The
codes are:

- `noncanonical_insert` (`line`, `reason`): any other line that mentions
  `<ap-investigation` or `</ap-investigation` (ASCII-case-insensitively)
  outside code;
- `html_block` (`line`): a line that, past any `>`, list markers and
  whitespace, starts with `<!`, `<?`, `</` or a tag name followed by
  whitespace, `/`, `>` or the end of the line;
- `unknown_investigation` and `unknown_attribute`: a canonical insert that
  names no investigation of this workbook (or none at all), or has an
  attribute outside the shared list `html/ui/investigation-inserts.json`,
  each finding once.

The lint over-warns on purpose: a document without warnings shows exactly one
card per canonical line and hides nothing in the viewer. Attribute names are
ASCII-case-insensitive, the first of a repeated attribute wins, and values
decode numeric character references and the five XML names. The vectors and
the shared document generator are in `tests/conformance/overview/cases.json`.

Reading an overview (`overview()`, `overview_versions()`, the snapshot) never
creates the table or changes the format; formats 1 and 2 read as no overview.
`verify` and the projection rebuild ignore the table, as they ignore display.

Over HTTP (OV-5), `PUT /projects/{pid}/overview` takes
`{"markdown", "author"}` and answers 201 (new version) or 200 (unchanged
digest) with `{project_id, overview: {seq, digest, author, created},
changed, warnings}`; refusals use the codes above (422 `invalid_payload`,
413 `payload_too_large`). `GET /projects/{pid}/overview/versions` returns
`{versions: [{seq, digest, markdown, author, created}]}`, oldest first.
`GET /projects/{pid}/overview` returns `{project_id, overview}`, where
`overview` is the latest version `{seq, digest, markdown, author, created}`,
or null before the first write. Each `/workspace.projects[]` carries the same
`overview` object (or null), byte for byte (OV-7). `/stream` sends
`event: overview` whose data is `{project_id, overview}`, exactly the route's
body, with no event id, on the same terms as `event: display`: the latest on
connect, then on each change of digest, without moving the record cursor.
The CLI writes and reads through the SDK: `autophys overview set PROJECT
FILE.md --author NAME` (the author is required, OV-8; `FILE` may be `-` for
stdin) and `autophys overview show PROJECT [--json]`, both with
`--target DIR|FILE|URL`. An SDK talking to
a daemon without these routes gets an "upgrade the autophys daemon" error.

## Payload validation

| Kind | Rule |
| --- | --- |
| any | payload is a JSON object; every integer at any depth is within -2^63 .. 2^64-1 (what serde_json stores as i64/u64), so a record one SDK writes the other can verify |
| `investigation` | `project_id`, `config_version` non-empty strings |
| `measurement` | `observation` is an object |
| `outcome` | `status` non-empty string |
| `run` | optional `curves`: object keyed by measurement record ids; each value has `fit` and `initial` objects of per-output-channel finite-number arrays, with equal lengths across both and optional `t`; at most 2000 points per array; canonical whole run payload at most 256 KiB when curves is present. SDKs include `t` only when downsampled, otherwise arrays use the measurement sample order. The store validates shape and id syntax; it does not simulate, check source grids, or resolve measurement references. Runs without curves retain the existing 1 MiB limit |
| `reveal` | opaque object, with the common payload/id/size rules; accepted only after an outcome for this investigation; a second distinct reveal is refused |
| `investigation` (optional trace metadata) | `playbook {name, version, sha256}`: name/version strings, sha256 64 hex; `model {role, route, model, effort, max_tokens}`: role policy/researcher, route/model strings, effort string or null, max_tokens nonnegative integer or null; `price {model, input_per_mtok, output_per_mtok, as_of}`: strings and finite numeric rates |
| `step` (optional trace fields) | `usage` object: known route/model keys strings, input_tokens/output_tokens/total_tokens/reasoning_tokens/cached_input_tokens nonnegative integers, latency_ms finite number, cost_usd finite number or null; unknown keys allowed for older raw provider dictionaries. `images` list of {sha256, media_type, caption?}: hash (64 hex, optional sha256: blob prefix), media_type string, optional caption string. `replayed` boolean. Top-level `model` and `elapsed_ms` stay unchanged |
| `outcome` (optional totals) | `usage_total` object: calls/input_tokens/output_tokens nonnegative integers, cost_usd finite number or null. Readers skip raw usage dictionaries without input_tokens entirely (they add no calls, tokens or cost and never null the total); a counted call with a missing/null cost_usd makes the total null |
| `proposal` | `proposal_id` a valid id; `event` one of `proposed approved edited rejected withdrawn data_attached` |
| `proposed` | `experiment` non-empty string; `settings` absent, null or an object; `outlook`, when present: `axes` an array of at most 3 `{name, values}` with non-empty finite number arrays, `score` and every `after[param]` finite arrays with the product of the axis lengths |
| `edited` | `settings` an object |
| `data_attached` | `measurement_version` present and not null. Both SDKs write the measurement record's hash (a string, filled through `hash_of`; RR1-b); Python before RR1-b wrote the dataset version integer, and readers accept both |

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
- `run`, `step`, `reveal`: nothing.
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

`tests/conformance/overview/` holds the format-3 contract: `cases.json`
(the step's DDL, digests, refusals and insert warnings) and one golden
workbook per SDK (`rust.ap-workbook`, `python.ap-workbook`) with two overview
versions and a display. Each SDK reads both goldens, checks every version and
its digest, and confirms that rewriting the latest version adds no row and a
display write leaves format 3. Regenerate them with
`AUTOPHYS_WRITE_GOLDENS=1 cargo test -p autophys --test workbook_format3
the_overview_generator` and, from `sdks/python`,
`PYTHONPATH=src python3 tests/conformance_cases.py --overview
../../tests/conformance/overview`; the insert tags and attribute keys come from
`html/ui/investigation-inserts.json`, which the Python package carries as a
byte-identical copy (`autophys/investigation-inserts.json`, pinned by a test).

### Candidate uncertainty in ranking steps

`rank_experiments` step results retain `criterion` and `ranking`. Uncosted rows
are `[experiment, min_eig, d_opt, after]`; the first three positions are unchanged.
Costed rows retain their dictionary fields and add `after`. Old three-element
rows remain valid. `after` maps parameters not identified at the ranking fit to
expected one-sigma uncertainty in fitting coordinates (log sigma for log
parameters), using the same ridge-floored Fisher inverse as proposal outlook.
Null/nonfinite means unbounded; a missing map means not recorded. No record kind,
configuration hash or daemon envelope changes: step results remain opaque payloads.
