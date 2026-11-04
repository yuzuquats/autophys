# autophys-rs: the daemon's endpoints are a thin layer over a Rust library that matches the Python SDK

Status: plan, rev 1, 2026-11-04. Operator direction (autophys/rs thread): the
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
| `client.project(name)`                 | `client.project(name) -> Result<Workbook>`              | `POST /api/v1/projects` (open or create)         |
| `wb.investigations()`                  | `wb.investigations()`                                   | `GET /api/v1/investigations?project=`            |
| `wb.investigation(id)`                 | `wb.investigation(id) -> Result<Investigation>`         | `GET /api/v1/investigations/{inv}/records`       |
| `wb.investigate(...)` (runs the loop)  | `wb.create_investigation(NewInvestigation)` (record only) | `POST /api/v1/investigations`                  |
| `inv.records(after=)`                  | `inv.records(after)`                                    | `GET …/records?after=`                           |
| `inv.propose(...)`                     | `inv.propose(proposal)`                                 | `POST …/proposals`                               |
| `inv.proposal(pid)`                    | `inv.proposal(pid)`                                     | `GET …/proposals/{pid}`                          |
| `inv.approve(pid, by=, settings=)`     | `inv.approve(pid, by, settings)`                        | `POST …/proposals/{pid}/approvals` (event `approved`/`edited`) |
| `inv.reject(pid, by=, reason=)`        | `inv.reject(pid, by, reason)`                           | `POST …/proposals/{pid}/approvals` (event `rejected`) |
| `inv.attach_data(pid, observation)`    | `inv.attach_data(pid, observation)`                     | `POST …/proposals/{pid}/data`                    |
| run/step/measurement/outcome writes    | `inv.run(..)`, `inv.step(..)`, `inv.measurement(..)`, `inv.outcome(..)` | `POST …/runs`, `…/steps`, `…/measurements`, `…/outcome` |
| `client.project(p).config_versions()`  | `wb.config_versions()`, `wb.put_config_version(v, body)` | `GET/PUT /api/v1/projects/{pid}/config_versions[/{v}]` |
| `wb.verify()`                          | `wb.verify() -> CheckReport`                            | `autophys db verify`                             |
```

`target` means the same thing in both: a directory (a local collection), a
`.ap-workbook` path, an `http(s)` URL, or nothing (`AUTOPHYS_HOME`, default
`~/autophys`).

```rust
let client = autophys::connect(Some("~/autophys"))?;
let wb = client.project("heated-block")?;
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

## What the Rust library leaves out

```review-callout
kind: decision
title: The numerics stay Python-only (AX-2)
AX-2 says numerics live in the SDK and the client only formats. `investigate()`
in Python runs fitting, sensitivity analysis and experiment design with numpy
and scipy. The Rust library therefore covers the record side only: workbooks,
investigations, proposals, the approval verbs, verification and the remote
client. A Rust program can read, review and approve, but it can't run an
investigation. **Agent-chosen, pending operator review.** The alternative is
porting the numerics to Rust; that doubles the numerical code and its tests.
```

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

The schema itself (records, blobs, migrations) does not change in this move.
Any change to those tables goes to autophys/api as a question first.

```review-callout
kind: risk
title: Not settled yet
- autophys/api has not confirmed the Python column of the table. Its names win
  where the Python SDK already ships them; this page follows.
- `wb.investigate` vs `wb.create_investigation`: the Rust name differs on
  purpose, because the Rust call doesn't run the loop. If Python also exposes
  a record-only create, they should share that name.
- The Remote client in Rust is new code. Until it passes the same conformance
  cases as Python's HttpStore, Rust callers should use Local.
```
