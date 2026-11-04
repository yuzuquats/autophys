# autophys-rs: the daemon's endpoints are a thin layer over a Rust library that matches the Python SDK

Status: phase 1 implemented, rev 4, 2026-11-04. Rev 2: full API parity (AX-2 revised). Rev 3: the numerics case format, the `autophys-cli` layout, the conformance tree as committed. Operator direction (autophys/rs thread): the
Rust binary produces the app and serves the endpoints, and each endpoint
calls a Rust library crate that is the Rust counterpart of the Python SDK, so
Rust programs can import it directly. Phase 1 is implemented; phase 2 remains pending. It refines W-4
(`workbook.md`) and does not change the workbook format (`workbook-format.md`).

## The shape

```
                    ┌──────────────── autophys (binary, repo root) ────────────────┐
 browser ──HTTP──►  │ html/ app (tento-web)   /api/v1 handlers   keys · pairing · CSRF │
                    └──────────────────────────────┬───────────────────────────────┘
                                                   │ calls (no SQL in src/)
 Rust program ──────────── use autophys::… ────────┤
                                                   ▼
                    ┌──────────── autophys-rs  (sdks/rust, crate `autophys`) ───────┐
                    │ connect · Client · Workbook · Investigation · records · verify │
                    │ Local (rusqlite on <project>.ap-workbook) | Remote (/api/v1)   │
                    └────────────────────────────────────────────────────────────────┘
 Python program ── import autophys ── sdks/python: same names, sqlite3 locally, /api/v1 remotely
```

Three rules make the layers line up:

1. **One API, two languages.** `sdks/rust` and `sdks/python` expose the same
   objects and method names. Signatures differ only where the language forces
   it (`Result`, borrowing, keyword arguments).
2. **An endpoint is one library call.** Every `/api/v1` route parses its
   request, calls one `Workbook` or `Investigation` method on a Local client,
   and serialises the result. Validation, hashing, projections and errors
   live in the library. So HTTP, a local Rust caller and a local Python
   caller all hit the same rules. The conformance suite (W-4) proves the
   Python side matches.
3. **Server-only concerns stay in the binary.** API keys, pairing, the O-3
   CSRF guard, SSE fan-out and the html app are not in the library. They use
   the server's own database, not a workbook (`workbook-format.md`: keys and
   pairings are not in a workbook).

## The shared API (W-7, both languages)

```review-table
| Python (`sdks/python`)                 | Rust (`sdks/rust`, crate `autophys`)                    | HTTP the server maps it to                       |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `ap.connect(target=None)`              | `autophys::connect(target: Option<&str>) -> Result<Client>` | — (picks Local or Remote)                    |
| `client.projects()`                    | `client.projects()`                                     | `GET /api/v1/projects`                           |
| `client.project(Project)` (simulator + config; uploads the config version) | `client.project_with(Project) -> Result<Workbook>` (phase 2) | `POST /api/v1/projects` + `PUT …/config_versions/{v}` |
| `client.project(name)` (review only)   | `client.project(name) -> Result<Workbook>` (review only) | `POST /api/v1/projects` (open or create)        |
| `wb.investigations()`                  | `wb.investigations()`                                   | `GET /api/v1/investigations?project=`            |
| `wb.investigation(id, runner=None, policy=None)` (resumes from the records) | `wb.investigation(id)`; `wb.resume(id, runner, policy)` (phase 2) | `GET /api/v1/investigations/{inv}/records` |
| `wb.investigate(dataset, runner, policy=…)` (creates and records) | `wb.investigate(dataset, runner, policy)` (phase 2) | `POST /api/v1/investigations`                    |
| `inv.run()` (runs the loop; proposals come from `request_experiment`) | `inv.run() -> Result<Outcome>` (phase 2) | `POST …/proposals`, `…/runs`, `…/steps`, `…/measurements`, `…/outcome` |
| `store.create_investigation(meta, record_id=)` (record only) | `wb.create_investigation(meta, record_id)`  | `POST /api/v1/investigations`                    |
| `store.append(kind, payload, id)`      | `inv.append(kind, payload, id)`                         | `POST …/runs`, `…/steps`, `…/measurements`, `…/outcome`, `…/proposals` (by kind) |
| `inv.records(kind=None)`               | `inv.records(kind: Option<&str>)`                       | `GET …/records`                                  |
| —                                      | `inv.records_after(gseq)` (Rust only: SSE and the daemon) | `GET …/records?after=`                         |
| `inv.proposal(pid)`                    | `inv.proposal(pid)`                                     | `GET …/proposals/{pid}`                          |
| `inv.approve(pid, by=, settings=)`     | `inv.approve(pid, by, settings)`                        | `POST …/proposals/{pid}/approvals` (event `approved`/`edited`) |
| `inv.reject(pid, by=, reason=)`        | `inv.reject(pid, by, reason)`                           | `POST …/proposals/{pid}/approvals` (event `rejected`) |
| `inv.attach_data(pid, observation)`    | `inv.attach_data(pid, observation)`                     | `POST …/proposals/{pid}/data`                    |
| `inv.wait_for_approval(proposal_id, timeout=)` | `inv.wait_for_approval(proposal_id, timeout)`                        | `GET /api/v1/stream?investigation=` (remote) or `PRAGMA data_version` (local) |
| `wb.config_versions()`                 | `wb.config_versions()`, `wb.put_config_version(v, body)` | `GET/PUT /api/v1/projects/{pid}/config_versions[/{v}]` |
| `wb.verify()` → `{ok, records, investigations, chain_errors, projections_match}` | `wb.verify() -> VerifyReport` (same five fields) | `autophys db verify` |
```

Python's names win (autophys/api, 2026-11-04). Every Python call has a Rust
counterpart. Where Python uses one name with an optional argument, Rust has
two names: `project`/`project_with` and `investigation`/`resume`. `inv.run`
is the loop in both languages, so the record writer is `append`, after
Python's `Store.append`, never `run`.

The rest of the Python surface is ported with the same names in phase 2:
`simulator`/`Simulator` with `ParamSpec` and `SimOptions`, `Project` with
`Budgets`, `NoiseConfig`, `PolicyConfig` and `StopRules`, `Dataset` and
`Observation`, `fit`/`FitResult`, `analyze`/`SensitivityReport`,
`rank_experiments`, `Decision`, `ScriptedPolicy`, `ReasonLanePolicy`,
`Reasoner`/`HttpReasoner`, `Outcome`, and the three example models
(thermal, oscillator, battery).

`target` means the same thing in both: a directory (a local collection), a
`.ap-workbook` path, an `http(s)` URL, or nothing (`AUTOPHYS_HOME`, default
`~/autophys`).

```rust
let client = autophys::connect(Some("~/autophys"))?;
let wb = client.project("heated-block")?;           // review only, like Python's plain name
for inv in wb.investigations()? {
    println!("{} {}", inv.id, inv.status);
}
wb.investigation("inv-7")?.approve("p-3", "james", None)?;
```

```rust
// src/http.rs: an endpoint is parse → one call → serialise
async fn approvals(state: web::Data<Server>, path: web::Path<(String, String)>,
                   body: web::Json<ApprovalBody>) -> Result<HttpResponse, ApiError> {
    let (inv, pid) = path.into_inner();
    let inv = state.collection.find_investigation(&inv)?;   // Local client
    let envelope = body.into_inner(); // validated decision envelope, including proposal id
    let appended = inv.append("proposal", envelope.payload, Some(&envelope.id))?;
    Ok(HttpResponse::Ok().json(appended))                    // {record, gseq}
}
```

## Full parity, in two phases

```review-callout
kind: decision
title: AX-2 revised (operator, 2026-11-04): autophys-rs ports the investigation loop
The operator chose full API parity over a record-only Rust crate. A Rust
program can declare a simulator, run an investigation and get the same
proposals as Python. The cost is accepted: about 2,400 lines of numerics
exist twice, and every numerics change lands in both SDKs. Python stays the
reference for numerical behaviour.
```

```review-table
| Phase | Ships                                                                                   | Conformance                                             |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1     | the record calls, the workbook format, the daemon on top of the crate                   | byte-identical: hashes, canonical JSON, golden workbooks |
| 2     | Simulator trait, fit, sensitivity, design, the agent loop, policies, reasoner, 3 models  | numeric, within stated tolerances; decisions identical  |
```

Phase 2's replacements for scipy: an ODE solver crate for `solve_ivp`, a
Levenberg–Marquardt crate for `least_squares`, nalgebra for the linear
algebra, and a Sobol sampler for `qmc`. Each must reproduce the Python
results within the tolerance its conformance case states.

Phase 2's conformance goes in `tests/conformance/numerics/`. Python records
the inputs and outputs of the fit, the sensitivity analysis, the experiment
ranking and a full `ScriptedPolicy` run on each example model; Rust must
match them within tolerance. Where a tolerance-level difference would change
a decision (which experiment to propose, which parameters count as
identifiable), Rust must make the same decision. A case that can't meet that
is reported, not loosened. The case format is below; autophys/api writes
the cases from the Python SDK.

### Numerics case format (draft for autophys/api)

One JSON file per case, at `tests/conformance/numerics/<model>/<op>-<name>.json`,
with `op` one of `simulate`, `fit`, `analyze`, `rank`, `outlook`, `run`. Each
file states every input, so neither side depends on the other's random numbers,
and every output with the comparison rule it must pass.

```json
{
  "format": 1,
  "op": "fit",
  "model": "thermal",
  "written_by": "autophys 0.1.0 (python)",
  "inputs": {
    "params":   {"tau": {"lo": 1.0, "hi": 100.0, "log": true}, "gain": {"lo": 0.1, "hi": 10.0}},
    "fixed":    {"ambient": 20.0},
    "options":  {"rtol": 1e-8, "atol": 1e-10, "method": "LSODA"},
    "observations": [{"experiment": "step", "settings": {"power": 5.0},
                      "t": [0.0, 1.0, 2.0], "y": {"temp": [20.0, 21.3, 22.4]},
                      "sigma": {"temp": 0.05}}],
    "starts":   [{"tau": 10.0, "gain": 1.0}, {"tau": 50.0, "gain": 0.5}],
    "loss": "linear", "f_scale": 1.0
  },
  "expect": {
    "params":     {"value": {"tau": 12.304, "gain": 1.9871}, "rtol": 1e-6},
    "loss":       {"value": 0.01834, "rtol": 1e-6},
    "chi2_per_n": {"value": 0.9171, "rtol": 1e-6},
    "at_bounds":  {"value": [], "exact": true},
    "success":    {"value": true, "exact": true}
  }
}
```

The comparison rules:

```review-table
| Rule                    | Meaning                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `rtol`, `atol`          | numeric (scalars, arrays, maps of either), element-wise: pass if within `atol + rtol·|expected|` |
| `exact: true`           | strings, booleans, integers and ordered lists match exactly                               |
| `set: true`             | a list compared as a set (e.g. `identified`, `non_identified`)                            |
| `up_to_sign: true`      | a vector that may come back negated (singular directions); compare both signs, pass on either |
| omitted field           | not compared: `nfev`, `status`, `message` and solver timings are implementation-specific  |
```

What each `op` takes as inputs, besides the model and its parameter specs:

```review-table
| op         | inputs beyond the model                                     | decision fields (`exact`/`set`)          |
| ---------- | ----------------------------------------------------------- | ---------------------------------------- |
| `simulate` | `theta`, `experiment`, `settings`, `t`, `options`          | none (trajectory, `rtol`)                |
| `fit`      | `observations`, explicit `starts`, `loss`, `f_scale`        | `at_bounds`, `success`                   |
| `analyze`  | `theta`, `observations`, `rule`                             | `identified`, `non_identified`           |
| `rank`     | `theta`, `observations`, `candidates`, `criterion`          | the ranked `experiment` order            |
| `outlook`  | `theta`, `experiment`, `axes` (≤3 × ≤12 values), `criterion` | none (the E-1 grid, `rtol`)            |
| `run`      | `dataset`, a `ScriptedPolicy` script, budgets, stop rules, a deterministic runner | every `Decision` in order, the final outcome `status` |
```

A `run` case checks decisions, not numbers: Rust replays the same script
against the same data and must produce the same sequence of actions,
experiments and settings, ending in the same status. Its records are not
compared byte for byte, because ids and timestamps differ.

Fit cases pass `starts` explicitly. Python's Latin-hypercube start sampler
is tested on its own `sample` op later, if at all; the fit itself must not
depend on it.

## Layout and naming

```
autophys/
  Cargo.toml          [workspace] members = ["sdks/rust"] (root implicit); exclude = ["vendor"]; package `autophys-cli`, [[bin]] name = "autophys"
  src/                autophys-cli: main, scripts (commands), app (tento-web), server, http/ (handlers), keys/pairing DB
  sdks/rust/          crate `autophys` (autophys-rs): client, workbook, records, projections, validate, canonical, remote
  sdks/python/        package `autophys` (owned by autophys/api)
  tests/conformance/  golden workbooks, chain vectors, cross tests (shared)
```

- The crate is named `autophys`, like the pip package, so it's `use autophys::connect`.
  "autophys-rs" is the project name.
- The root package is `autophys-cli` (operator, 2026-11-04), shaped like
  tento-garmin. Its binary stays `autophys`, and its commands are a
  `tento_sh` `Scripts` tree: `serve`, `build-web`, `pack`, `pair`, `keys` and `db`
  operate the daemon, and `projects`, `investigations`, `records`, `approve`,
  `reject` and `verify` are the SDK through `autophys::connect`, so they work
  on a local folder or a URL. The command tree is implemented with `tento_sh::Scripts` and `command!`.
- `sdks/rust` depends on `rusqlite`, `serde_json`, `sha2` and, for Remote,
  a blocking HTTP client. It does not depend on tento or actix, so it builds
  without `vendor/`.

## Moving today's code

```review-table
| Today (`src/`)              | Goes to                         | Note                                                       |
| --------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `store/canonical.rs`        | `sdks/rust/src/canonical.rs`    | unchanged                                                  |
| `store/validate.rs`         | `sdks/rust/src/validate.rs`     | unchanged                                                  |
| `store/projections.rs`      | `sdks/rust/src/projections.rs`  | unchanged                                                  |
| `store/records.rs`, `mod.rs`| `sdks/rust/src/workbook.rs`     | one file per project (W-6) instead of one daemon database  |
| `store/schema.rs`           | `sdks/rust/src/schema.rs`       | without key and pairing tables; `application_id` APWB      |
| `store/keys.rs`             | `src/keys.rs`                   | server database                                            |
| `http.rs`, `http/`          | `src/http/`                     | handlers call the library only                             |
```

The move brings the schema to `workbook-format.md` version 1, which drops
the key and pairing tables and adds `blobs` and `application_id`. Any change
beyond that spec to the records, blobs or migrations tables goes to
autophys/api as a question first.

## Conformance (autophys/api, 2026-11-04)

The crate is tested directly with `cargo test` in `sdks/rust`, not through
the daemon. The spec both sides implement is `workbook-format.md`.

```
tests/conformance/
  README.md            what every implementation must do
  python/              <case>.ap-workbook + <case>.json, written by Python → Rust verifies (cargo test in sdks/rust)
  rust/                the same shape, written by Rust                  → Python verifies (pytest in sdks/python)
  numerics/            phase 2: <model>/<op>-<name>.json, written by Python → Rust matches within tolerance
tests/vectors/chain.json   hash-chain vectors; both suites read it at this path
```

```review-callout
kind: risk
title: Not settled yet
- The Remote client in Rust is new code. Until it passes the same conformance
  cases as Python's HttpStore, Rust callers should use Local.
- `inv.records_after` and the HTTP `?after=` cursor are Rust- and server-only.
  `gseq` orders records within one workbook only (W-6), so a remote stream that
  spans projects needs a cursor per workbook.
- The crate name `autophys` and root `autophys-cli` are operator-confirmed (RS-1).
- Phase 2's tolerances are not yet set. Python's solvers are adaptive, so
  results that match within 1e-6 on the example models may still drift on
  stiff user models.
```

## Phase 1: record library and daemon

The record store now lives in `sdks/rust`, crate `autophys`. Its dependencies
contain no tento, actix or async runtime. `connect` supports a collection
directory, one `.ap-workbook` path, or the default `AUTOPHYS_HOME` /
`~/autophys`; HTTP targets return an explicit remote-not-implemented error.
The Rust column above is implemented through `wait_for_approval`, config
versions and `verify`. Phase-2 names remain reserved without stubs.

A workbook has APWB / version 1, WAL, exactly one project, the specified
`blobs` table and no keys or pairings. Appends validate, replay, check
transitions, insert and fold under `BEGIN IMMEDIATE`. Replays retain the
original record and gseq; different content with the same id conflicts.
Canonical float formatting also handles decimal halfway cases with Python's
ties-to-even rule; Rust's ordinary float display does not.

`attach_data` commits its measurement and `data_attached` event together,
returning the latter as `Appended {record, gseq, created}`; `created` is
omitted from JSON. Creation returns `(Investigation, created)`.
`verify` returns the five documented fields; each chain error also carries
a human-readable `problem`. Public collection helpers for the daemon are
`ensure_project`, `project_by_id`, `find_investigation`, `workbooks`,
`snapshots` and `investigations_in`; workbook helpers provide snapshots,
heads, projection rows, rebuilds and paged records. The core client API
remains the table above.

The root package is `autophys-cli`, library `autophys_cli`, binary
`autophys`. The root package is implicitly a workspace member; explicitly
listing `"."` makes this Cargo version resolve nested vendor dependency
inheritance against the wrong workspace. Operator confirmed the equivalent
`members = ["sdks/rust"]`, `exclude = ["vendor"]` form. Metadata shows
exactly the two autophys packages; the tento crates still inherit from
`vendor/tento/Cargo.toml`. HEAD's comments are retained. Apart from the
required package/library renames, the manifest diff contains additions only.

Handlers parse requests, resolve their workbook, call the library and
serialize. The old `src/store` and `src/ingest.rs` are moved out; no SQL
statements remain in `src/`. Keys and pairing operations live in
`src/keys.rs`, using their own `~/.local/share/tento/autophys/server.db`
(tento-dirs data, AX-17); the
server-only statements are included from `sql/keys/`.
`serve --collection DIR` (`--db DIR` alias) / `AUTOPHYS_HOME` selects
the collection; `--server-db FILE` / `AUTOPHYS_SERVER_DB` selects the key
database. These are fresh format-v1 workbooks; no legacy daemon database is
silently converted. The old argument parser remains in place.
Repeatable `--browser-origin ORIGIN` or comma-separated
`AUTOPHYS_BROWSER_ORIGINS` admits an explicitly configured
tento.localhost origin; flagged values override the environment. JSON plus
Origin CSRF checks and keyed SDK calls retain their existing rules.
AX-9 replaces the header-only read exemption with a document-issued cookie:
GET `/`, `/app` and `/app/*` mint a fresh random 256-bit
`autophys_session`, `HttpOnly; SameSite=Strict; Path=/api`. The document
is `Cache-Control: no-store`. Valid tokens live only in this server process;
a restart invalidates them and reloading a document mints a new one.
Browser reads on `/workspace`, `/stream` and `GET /pairings` require
the cookie (401 without it); `Sec-Fetch-Site` grants no exemption.
Browser writes require the cookie as well as O-3: valid Origin without a
cookie returns 401; cross-origin writes return 403 even with a valid cookie.
API keys remain sufficient on their existing routes.
R-9 removes `tento_commit` from BuildInfo and healthz: the latter is exactly
`{ok, version, commit}`. The deploy script and unit no longer stamp or
record `TENTO_COMMIT`; no deployment or service restart is part of phase 1.

### HTTP and cursor contract changes in phase 1

All route paths, append envelopes, `/approvals`, `/data`, their
`{record, gseq}` results and ordinary statuses remain: 201 for a new write,
200 for its replay, 409 `idempotency_conflict` for reused content,
422 for an invalid/out-of-axis edit. Investigation creation still returns
`{id}`. Config and proposal response shapes retain their existing fields.

| Route / concern | Phase-1 behaviour |
| --- | --- |
| `GET /workspace?project=<prj_id>` | Added project filter; the same arrays restricted to one workbook. `cursor` is that workbook's integer gseq; added `cursors: {prj_id: gseq}`. Each workbook snapshot is one read transaction. |
| `GET /workspace` | `cursor` changes from a global integer to a string collection cursor, `prj_id:gseq,prj_id:gseq`, sorted by project id (empty string for no workbooks). Added the same `cursors` map. No cross-file atomic snapshot is claimed. |
| `GET /stream?project=<prj_id>` or `?investigation=<inv_id>` | Project filter added; integer `after`, integer `Last-Event-ID`, integer event ids and unchanged eight-field record data. gseq now orders one workbook. Both filters together must refer to the same workbook (else 400). An unknown selected project/investigation now returns 404 before streaming. |
| Unscoped `GET /stream` | Covers all workbooks with the collection cursor as `after`, `Last-Event-ID` and event ids. Missing / empty / `0` means the beginning. A bare nonzero integer or malformed query cursor returns 400; it cannot identify positions across files. Reconnect merges each workbook position by maximum. |
| `GET /investigations/{inv}/records?after=<gseq>` | Added exclusive per-workbook cursor filter. Retains `{records: [eight-field record…]}` and may combine with `kind`; invalid kind is still 422. |
| Collection listing / streaming | Workbooks are traversed in file-path order, with each file's own record order. There is no global ordering across projects. Streams poll every second for other processes' writes and wake immediately for this server's writes; keep-alive comments remain every 15 seconds. |

These resolve store.md's five workbook conflicts: per-project collection,
separate key database, blobs schema, per-workbook / collection cursors, and
the common projection fold demonstrated against all three Python workbooks.
The existing `tests/vectors/chain.json` stays in place.

Agent choice RS-CURSOR-1, **pending operator review**: an unscoped stream uses a
vector of per-project cursors rather than a server-owned global sequence.
This requires no cross-file writes or extra workbook tables; an alternative
global server sequence requires server indexing/recovery and persisted state.
The implementation is covered by two-workbook reconnect and external-writer
tests. Reversal costs a daemon cursor/index change plus consumer migration;
scoped streams keep integers. This is the phase-1 daemon commit's choice.

RS-WAIT-1, **operator decided, 2026-11-04**: the record API uses
`wait_for_approval(proposal_id, timeout)`, matching Python. It waits for that
proposal to leave `proposed`, returning its decided state immediately or
`NotFound` for an unknown id. A dedicated read-only connection polls
`data_version`, so decisions from any writer are visible. Selecting the newest
pending proposal could race onto a different writer's proposal and has been
removed. The agent's `wait_for_approval(timeout)` passes its pending proposal id.
The two-pending-proposal test approves the older proposal and verifies that the
wait returns it while the newer one remains proposed. No file-format change.

Questions for autophys/api: confirm RS-CURSOR-1's unscoped cursor is consumed as an
opaque string; consider making Python's measurement-plus-data-attachment
operation atomic too. Remote Rust transport and the investigation/numerics
loop remain phase 2 or later. No schema-format question remains open.

Repeated outlook axis names use the last axis's range when checking edits,
matching Python. Operator confirmed this v1 interpretation on 2026-11-04;
no schema change or new payload rejection was introduced.

### Phase-1 qualification

A clean archive of the phase-1 tree passes `cargo test --workspace --locked`
(66 passed, including one SDK doc test; one illustrative daemon doc test
ignored), and `cargo test` from `sdks/rust` (25 passed). The library checks
all three Python goldens and both Rust cases; independent Python stdlib
SQLite/hash/JSON readback also verifies all five files. The Python SDK and
its tests were not run or edited. The shared vectors and Python golden bytes
are unchanged. A differential check of 999,515 finite f64 values finds no
canonical-number mismatch with Python repr.

The socket check on 127.0.0.1:4796 passes health, document cookie mint/remint,
cookie-less 401, session-auth reads/SSE, cross-origin 403, pairing,
approval/edit bounds, replay 200, id-conflict 409, data and workbook verify.
Restarting that private test daemon invalidates its cookie while retaining
the API key in its private server DB. It is stopped and port 4796 is closed.
The deployed service was never restarted. `bash -n ops/deploy.sh` passes.

The read-only HTML run passes 55 tests. The working checkout's later full
Cargo/SDK attempts are blocked by the parallel implementer's uncommitted
`sdks/rust/tests/numerics.rs` (unfinished phase-2 exports and `indexmap`);
those files are excluded from these scoped commits and the archive.
Task CLI is unavailable on this host, as already recorded in the project
cover. Remaining work is the reserved phase-2 API, remote Rust transport,
and review of RS-CURSOR-1; no format-v1 blocker remains.

## Embedded web release (B-1)

Linux ships one native executable with a deflated ZIP and the 24-byte
`APZIP001 | prefix u64 LE | ZIP length u64 LE` footer. macOS relinks the ZIP
into `__AUTOPHYS,__web` with `-Wl,-sectcreate` and reads it with
`getsectiondata`; macOS packaging requires the source checkout and remains
untested on this Linux host. Strip Linux executables before packing.

`autophys pack --web-root DIR --out FILE [--no-maps]` packs a built tree;
`autophys build-web [--out DIR] --bundle FILE` builds and packs it.
Serving prefers an explicit web root, then the hydrated embedded tree, then
the dev build. A compile-time `AUTOPHYS_RELEASE=1` serve refuses a binary
without a payload. Hydration uses the SHA-256 of the ZIP under the app cache's
`web/embedded/<sha256>/autophys`, atomically publishes a complete tree, and
prunes complete entries older than seven days.

`GET /api/healthz` is now `{ok, version, commit, web_id}`. `web_id` is
the payload SHA-256 when serving embedded assets and null for an explicit
web root or a dev build. The existing routes and document session cookie
remain in force.

## CLI command tree

`src/main.rs` composes the `src/scripts.rs` registry. Constructing it reads no
environment or database, so `autophys --help --json` reflects the full tree
without HOME or credentials. The daemon adapters retain their existing flag
and environment parsers, including aliases and repeatable browser origins.
Usage errors exit 2; operational failures exit 1.

The SDK commands all call `autophys::connect` with `--target`, defaulting to
`AUTOPHYS_HOME` or `~/autophys`; all accept `--json`:

- `projects`
- `investigations [--project NAME]`
- `records INVESTIGATION [--kind KIND]`
- `approve INVESTIGATION PROPOSAL [--by NAME] [--settings JSON]`
- `reject INVESTIGATION PROPOSAL [--by NAME] [--reason TEXT]`
- `verify [--project NAME]`

Review decisions default `--by` to `operator`. Verification returns an array
of `{project, report}` and exits 1 if a report fails. Directory and
`.ap-workbook` targets work. URL targets are forwarded unchanged; the current
SDK reports `Unsupported` for Remote, so those calls fail clearly until its
Remote client is implemented. CLI routing does not substitute a local
collection for a URL.

B1-M1 (**agent-chosen, pending operator review**): macOS packaging relinks from
the source checkout with `-sectcreate`, preserving the compiled release guard
and commit stamp; `AUTOPHYS_PROJECT_ROOT` can select that checkout. This keeps
the native linker's signature valid. The alternative is an explicit build-time
ZIP/link step instead of `pack`; switching costs a small command/build change.
The section and relink implementation remains untested on macOS.

## Phase 3: Muse roles

The direct `ChatReasoner` exposes `MUSE_SPARK` (`muse-spark-1.3`) and
`MUSE_WONDER` (`muse-wonder-1.0`). `ChatReasonerConfig.role` defaults to
`policy` (Spark); `researcher` selects Wonder. An explicit model wins.
`ReasonOptions.images` accepts `ReasonImage {media_type, data}` with base64
bytes, attaching OpenAI `image_url` data-URI parts to the last user message.
`HttpReasoner` retains the text-only lane and its `elapsed_ms` reply field.
Direct calls retry 429 and 5xx up to four attempts, respecting numeric
Retry-After (0–30 seconds) and otherwise backing off 1, 2, 4 seconds. A 402
fails immediately with the committed Python `billing_not_configured` detail.

The Muse Code CLI adapter remains Python-only. Phase 3b now writes and
validates the Muse record fields, embeds pricing and replays/records cassettes,
using Python commit `d389c79` (`I7d2e5a9c3f1b84e06a51`) as its reference. Workbook schema and projection tables remain
unchanged; workbook `user_version` remains 1. All tests use loopback HTTP or
fixtures. No live provider call, deployment or restart is part of phase 3.
The numerics reader selects ScriptedPolicy only for the top-level
`policy: "scripted"`; all 21 shared cases pass in its clean-export workspace
gate. Task-board CLI is unavailable on rwc-dev-01; this section and the active
session plan carry the work state until the CLI is available.

### Phase-3 HTTP read shapes

`InvestigationInfo` and `Proposal` flatten the crate's `ReasonMetadata`.
`GET /api/v1/investigations`, `GET …/proposals/{pid}` and both arrays in
`GET /api/v1/workspace` gain optional `playbook`, `model`, `price`,
`usage_total`, and `steps` (ordered step payloads, including each usage,
images and replay flag). Proposal context belongs to its investigation;
its `steps` includes that investigation's full step history. Absent metadata
and empty steps are omitted. Raw historical usage is returned unchanged.
The library reads this context from records alongside the existing folded
state. Projection columns, rebuild comparison and SQL schema stay unchanged;
handlers continue to call the crate and serialize its result without SQL.

### Phase-3 checkpoint and validation (2026-11-04)

This historical checkpoint implemented the numerics reader, direct Muse reasoner
inputs and retry behavior, and daemon/API read scaffolding. The phase-3b
completion below supersedes its integration cutoff.
The operator requested a bounded wait for Python's committed Muse batch.
Ten-minute checks through 15:15Z found no commit in
`git log -- tests/conformance/reasoner sdks/python/src/autophys/usage.py`.
The monitor was disabled and implementation stopped at that cutoff.

Each implementation commit passed `cargo test --workspace --locked` from
its own `git archive <commit>` export, with a fresh
`CARGO_TARGET_DIR=~/.cache/autophys/rs-target-*` per export:

| Commit | Change-Id | Scope | Passed / ignored |
| --- | --- | --- | --- |
| `37bcf81f1d208b719786817ef51d9bbfa3cd1477` | `I9df7436b9d742d057f3a` | Numerics case policy discriminator; all 21 shared cases | 115 / 2 |
| `3da55d04676f717625f0cd3f50572cead97969f5` | `I650cdd6bef98bd5d5fe1` | Muse defaults, image inputs, 5xx retries | 116 / 2 |
| `34df3a89d471baf9e8fcd1993e0aad723790cdc1` | `I5f1121865e42382d4f8c` | Record-derived metadata views and HTTP contract coverage | 117 / 2 |

These counts sum the test harness summaries, including SDK doc tests; there
were no failures. The earlier chat count of 126 was an addition error; the
last implementation gate passed 117 tests. Exports, fresh targets and private
indexes were removed after each gate. Commits landed with private indexes and
CAS ref updates; no CAS retry was required for these three commits. The shared
index, peer Python/HTML source and peer changes were preserved.

The committed Python names mirrored at this checkpoint are `ChatReasoner`,
`HttpReasoner`, `ReasonReply`, `reasoner_from_env`, `parse_json_content`,
`MIN_TOKENS` and `REASON_PATH`, plus the immediate HTTP-402
`billing_not_configured` detail and unchanged `elapsed_ms` reply key.
Muse constants and role names follow the agreed phase-3 contract; no
committed Python Muse batch has yet qualified the remaining parity surface.

The integration items deferred at this cutoff are delivered in phase 3b
below: validators, playbook/model/price writes and blobs, normalized usage,
images/replay fields, totals/pricing, replay/record factories, and both sides'
reason-replayed conformance. The earlier scaffold remains the read path.

Closure qualification note: the first documentation-only export failed the
existing `binary_exits_cleanly_on_sigterm` HTTP test (8 passed, 1 failed in
that binary; Cargo stopped there). No test or implementation was changed for
the retry; the closure gate was repeated with another fresh export and target.
The failed run log is
`~/.cache/autophys/5faaee2eaa526e405546f01e26f585643b6090a6.test.log`.

### Phase 3b: committed Python Muse batch integration

Phase 3b mirrors `d389c79` with `usage::{normalize_usage, price_for,
usage_total}`, embedded `prices.json` plus byte/value equality with the shared
table, `playbook::load_playbook` (bundled default and scalar-only frontmatter),
`ModelSpec`, `reasoner_for`, `ReplayReasoner` and `RecordingReasoner`.
`reasoner_from_env` honors `AUTOPHYS_REASON_REPLAY` and
`AUTOPHYS_REASON_RECORD`; replay selection precedes credential loading and
a miss returns an error, never an HTTP fallback. Configured effort/token
defaults participate in recording keys. HTTP 402 immediately returns the
typed `SimulationError::BudgetError` with `billing_not_configured`.

`ReasonLanePolicy` pins playbook bytes through `Workbook::put_blob`,
writes playbook/model/price metadata when given a `ModelSpec`, and writes
normalized usage, elapsed time and replay flags. Paid invalid replies retain
their trace and count toward totals; resume recomputes totals from all stored
steps. `Outcome.usage_total` counts normalized calls only and propagates an
unknown counted cost to null. `Workbook::get_blob` returns `(bytes, media_type)`,
accepting bare playbook digests or prefixed image addresses. Generic step
appends accept images with captions and either hash spelling. The additive
validators match Python's accepted shapes and preserve unknown raw usage keys.
No migration, projection-column change or user_version bump was made.

Rust validates every record in all four Python goldens, including
`reason-replayed`, and verifies/rebuilds their chains/projections. The new
`tests/conformance/rust/reason-replayed.{json,ap-workbook}` replays all eight
recorded seed-0 oscillator prompts, checks each reply and normalized usage
exactly, stores playbook/image blobs, preserves a legacy raw usage dictionary,
and records 800 input / 320 output tokens for $0.002360. The conformance
generator can select only this new case with
`AUTOPHYS_WRITE_GOLDENS_CASE=reason-replayed`; existing goldens are retained.
This is request/record conformance using the Python golden's exact prompts;
it does not claim a native Rust numerical run generates identical prompts.
The shared cassette covers oscillator seed 0 only.

The chip reads these fields from investigation rows returned by
`GET /api/v1/investigations` and `GET /api/v1/workspace`:

- `playbook.name`, `playbook.version`;
- `model.model` (e.g. `muse-spark-1.3`, displayed as Spark), plus
  `model.role`, `model.route`, `model.effort`, `model.max_tokens` if needed;
- `usage_total.cost_usd` (nullable), `usage_total.input_tokens` and
  `usage_total.output_tokens` (sum these for displayed tokens), and
  `usage_total.calls`.

`GET /api/v1/investigations/{id}/proposals/{pid}` exposes the same
investigation context. `GET /api/v1/investigations/{id}/records` returns
the original seq-0, step and outcome payloads for detailed trace displays.
The daemon test loads Python's actual replay golden and checks the listing,
workspace and records views; the earlier proposal-context test remains.
No HTML changes are part of phase 3b.

Until an outcome records `usage_total`, the read views derive it from the
steps with the same rule (8c8a3e9), so a running investigation's chip shows
cost and tokens; the recorded total wins once it exists.

The legacy-usage divergence with Python is resolved: both SDKs skip a raw
provider dictionary entirely (Python 8847a6d). A null, float or missing count
records 0 and makes the cost unknown in both (ee0dac7).

Qualification: `cargo test --workspace --locked` passes 126 tests, 0 failed,
2 ignored (including SDK doc tests). The commit gate uses a fresh
`git archive <tree>` export and fresh
`CARGO_TARGET_DIR=~/.cache/autophys/rs-3b-gate-target-*`, then removes both.
No live Meta/Baseten/Muse call, deployment or source push was made.
The shared index and concurrent Python/HTML edits were preserved. Supported
task-board CLI remains unavailable on rwc-dev-01; this completion record
carries the task state. No item from the phase-3b deferred list remains;
the Muse Code CLI adapter and broader numerical prompt parity are outside
this workstream.

## Publication (2026-11-04)

The first publication of autophys went to `origin/master` as
`c12ddee..4a098cb`: 64 commits covering both SDKs, the daemon, the web app,
the shared conformance cases and these docs, through the Rust Muse records
(Change-Id I03bd2bd028efdd3de6d3). Before pushing, the stack was rewritten so
every Rust commit builds with `--locked`:

- the CLI dependency fix (5b17f3a) was folded into the embedded-payload commit;
- `Cargo.lock` at that commit and the four phase-2 commits was pruned offline
  from the final lockfile, so package versions don't change;
- split trailer blocks were merged, and the pitch-deck commit was given a
  Change-Id.

At the pushed tip: Rust 126 passed / 2 ignored, Python 359 passed / 2 skipped,
html 59 passed. The four commits from the Muse batch up to the pitch deck fail
one Rust conformance assertion, which hard-codes the number of Python goldens;
the tip fixes it.

An independent agent review (Codex) returned ready. Its non-blocking notes:

- two docs pages expose host paths;
- Python's legacy-cost total was wrong (fixed locally since);
- some rewritten messages lost trailing blank lines.

Receipt and manifests: `fleet/evidence/autophys/sink-20261104/` on
rwc-dev-01. Still local: py's batch two, the battery hand-off and the
`usage_total` fix.

The second publication, `4a098cb..63606eb` (14 commits), carried:

- py's batch two and its `usage_total` fix;
- the workbench and vendor updates;
- the battery hand-off;
- the Rust follow-ups: the `build-web` guard, a hardened `deploy.sh`,
  E-1b outlook axes, blob routes, live usage totals, and parity with Python
  on 402s, retries, error paths and usage counts.

Only commit messages were rewritten, to merge split trailer blocks and give
the two battery commits a Change-Id. An independent review returned ready
with no findings. Receipt: `fleet/evidence/autophys/sink-20261104b/`.
