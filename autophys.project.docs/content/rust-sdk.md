# autophys-rs: the daemon's endpoints are a thin layer over a Rust library that matches the Python SDK

Status: plan, rev 2, 2026-11-04. Rev 2: full API parity (AX-2 revised). Operator direction (autophys/rs thread): the
Rust binary produces the app and serves the endpoints, and each endpoint
calls a Rust library crate that is the Rust counterpart of the Python SDK, so
Rust programs can import it directly. Not implemented yet. It refines W-4
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
| `inv.wait_for_approval(timeout=)`      | `inv.wait_for_approval(timeout)`                        | `GET /api/v1/stream?investigation=` (remote) or `PRAGMA data_version` (local) |
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
    let wb = state.collection.workbook_for(&inv)?;           // Local client
    let appended = wb.investigation(&inv)?.decide(&pid, body.into_inner())?; // approve/edit/reject
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
is reported, not loosened.

## Layout and naming

```
autophys/
  Cargo.toml          [workspace] members = [".", "sdks/rust"]; package `autophys-server`, [[bin]] name = "autophys"
  src/                binary: main, app (tento-web), server, http/ (handlers), keys/pairing DB, admin CLI
  sdks/rust/          crate `autophys` (autophys-rs): client, workbook, records, projections, validate, canonical, remote
  sdks/python/        package `autophys` (owned by autophys/api)
  tests/conformance/  golden workbooks, chain vectors, cross tests (shared)
```

- The crate is named `autophys`, like the pip package, so it's `use autophys::connect`.
  "autophys-rs" is the project name. The root package becomes `autophys-server`,
  and its binary stays `autophys` (`autophys serve`). **Agent-chosen, pending operator review.**
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
  vectors/chain.json   hash vectors (today tests/vectors/chain.json)
  python/              workbooks Python writes  → Rust verifies (cargo test in sdks/rust)
  rust/                workbooks Rust writes    → Python verifies (pytest in sdks/python)
```

```review-callout
kind: risk
title: Not settled yet
- The Remote client in Rust is new code. Until it passes the same conformance
  cases as Python's HttpStore, Rust callers should use Local.
- `inv.records_after` and the HTTP `?after=` cursor are Rust- and server-only.
  `gseq` orders records within one workbook only (W-6), so a remote stream that
  spans projects needs a cursor per workbook.
- Crate and package naming are agent choices awaiting operator review.
- Phase 2's tolerances are not yet set. Python's solvers are adaptive, so
  results that match within 1e-6 on the example models may still drift on
  stiff user models.
```
