# autophys Rust SDK

The Rust crate implements scientific calibration and a local/remote workbook
client: simulate, fit, analyze identifiability, rank experiments, propose a test,
record approval, attach measurements and resume the investigation. Start here
or with the analogous [Python SDK](../python/README.md). The two SDKs share
scientific and record contracts; their signatures and storage choices differ.

## Use the source crate

From your Rust application's directory, point Cargo at this checkout:

```sh
cargo add autophys --path /absolute/path/to/autophys/sdks/rust
cargo add serde_json
```

The [manifest](Cargo.toml) uses edition 2024 and `publish = false`; this is a
source dependency, not a crates.io installation. The SDK has no tento or web
framework dependency. See [contributor setup](../../CONTRIBUTING.md) for the
repository toolchain. Python installation is in its paired guide.

## A local scientific calculation

This synthetic example constructs an observation from the built-in thermal
model, then fits and analyzes it. It is an API example, not independent
validation of a model against physical measurements. Direct numerical calls
create no workbook and make no network request.

```rust
use autophys::{data::Observation, fit::{fit, FitOptions}, models,
    sensitivity::{analyze, DEFAULT_RULE}, simulator::{Simulator, FIT_OPTIONS}};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sim = models::thermal_rc();
    let truth = [("C".into(), 500.0), ("R".into(), 2.0)].into_iter().collect();
    let settings = sim.experiment(&json!("step_long"))?;
    let y = sim.simulate(&truth, &settings, FIT_OPTIONS)?;
    let observation = Observation::new("step_long", settings, y.t()?.to_vec(),
        [("T".into(), y.output("T")?.to_vec())].into_iter().collect(),
        [("T".into(), 0.05)].into_iter().collect())?;
    let observations = vec![observation];
    let result = fit(&sim, &observations, &FitOptions::default())?;
    let (report, jacobian) = analyze(&sim, &result.params, &observations, DEFAULT_RULE, None)?;
    let noise = [("T".into(), 0.05)].into_iter().collect();
    let ranking = autophys::design::rank_experiments(
        &sim, &result.params, &observations, &noise, None, "min_eig", Some(&jacobian))?;
    println!("{} candidates", ranking.len());
    println!("{:?} {:?}", result.params, report.identified);
    Ok(())
}
```

A simulation returns a `simulator::Trajectory`: its outputs (`outputs()`,
holding the time vector under `"t"`) and its stimulus inputs (`inputs()`).
`t()`, `output(name)` and `input(name)` return a `Result` whose
`ChannelError` names the missing channel; `?` converts it into a
`SimulationError` or `autophys::Error`. `traj["T"]` indexes outputs only and
panics with the channel name. A simulator returns `map.into()` or
`collect()`s `(name, samples)` pairs as outputs; `Trajectory::from_parts`,
`with_output` and `with_input` build both halves. A trajectory serialises as
`{"y": {...}, "u": {...}}`, the worker protocol's result shape, and equality
compares inputs as well as outputs.

To record a human-approved investigation, use the same `observations` with
`data::Dataset::new(observations)?`, and bind executable code to a workbook:

```rust,ignore
let dataset = autophys::data::Dataset::new(observations)?;
let project = autophys::project::Project::new("heated-block", sim);
let wb = autophys::connect(Some("~/autophys"))?.project_with(project)?;
let mut inv = wb.investigate(dataset, autophys::agent::ProposalRunner,
    autophys::agent::ScriptedPolicy::default())?;
let outcome = inv.run()?;
// When outcome.status == "awaiting_data", retain inv.id and outcome.proposal_id.
// After review: inv.approve(&pid, "reviewer", None)?;
// Then attach a real observation: inv.attach_data(&pid, observation)?;
// In another process, with the same project declaration:
// let mut inv = wb.resume(&id, ProposalRunner, ScriptedPolicy::default())?;
```

The second fragment continues the first and requires `dataset` as described
above; approval and attachment require the actual proposal id and measurement.
A run can finish without requesting more data. `ProposalRunner` does not acquire
measurements: an approved proposal waits for the caller to attach them.

## Rust and Python: contracts and capabilities

| Concept/result | Python | Rust | Qualification |
| --- | --- | --- | --- |
| Simulator and scientific Project | `@ap.simulator`, `ap.Project` | `simulator::simulator`, `project::Project` | Built-in thermal, oscillator and battery models in both; source identity is language-specific. |
| Connection | `ap.connect(target, api_key=...)` | `connect(Some(target))`; explicit key via `Client::connect_remote` | Local directory/file or HTTP daemon; absent/empty target uses `AUTOPHYS_HOME`, then `~/autophys`. |
| Open existing / create if absent | `open_project(name)` / `ensure_project(name)` | same method names; ensure returns `(Workbook, bool)` | `project(name)` opens in both and errors when the project is missing (CORE-04; Rust 404 `not_found`). Passing a scientific Project creates/binds in both. |
| Bound workbook | `client.project(project)` | `client.project_with(project)`; `Workbook::with_project` | Rust returns `project::ProjectWorkbook`; root `Project` is record metadata. |
| Investigation and Store | `wb.investigate(dataset, runner, policy=...)`; `Store` backends | `ProjectWorkbook::investigate(dataset, runner, policy)` | Rust root `Investigation` is the record handle; `agent::Investigation` executes science. |
| Fit / analyze / rank | `ap.fit`, `ap.analyze`, `ap.rank_experiments` | `fit::fit`, `sensitivity::analyze`, `design::rank_experiments` | Fit parameters/loss, identified directions and candidate rankings share tolerance-based contracts, not identical optimizer iterations. |
| Propose / approve / attach | `ProposalRunner`, `inv.approve(pid, by=...)`, `inv.attach_data(pid, obs)` | `agent::ProposalRunner`, `inv.approve(&pid, by, settings)`, `inv.attach_data(&pid, obs)` | Approval precedes attachment; edits are constrained by declared outlook axes. |
| Resume | `wb.investigation(id, runner=..., policy=...)` | `ProjectWorkbook::resume(id, runner, policy)` | Supply executable simulator code again; stored records are not executable closures. |
| Scientific validation / record verification | `inv.tool_validate_predictions()` / `wb.verify()` | same tool name / `wb.verify()` | Held-out usable validation data determines prediction validation; hash/projection integrity is a different check. |
| Records and blobs | `inv.records`, `WorkbookStore`/`HttpStore` | record `Investigation::records`, `Workbook::put_blob/get_blob` | Shared workbook format, canonical hash chain and content-addressed blobs; HTTP Python stores are bound to their project. |
| Ephemeral / JSONL full investigations | `MemoryStore`, `JsonlStore`, `Project.investigate` | Missing public equivalent (A5) | File-backed Rust science is implemented; direct numeric calls do not replace a no-file record-backed loop. |
| Visual policy evidence / exact replay / resume | Opt-in image-capable policy and stored plot references | Partial transport/blob support; built-in policy lacks analogous image path (A6) | Text replay support does not establish visual orchestration parity. |
| CLI research/export, plotting, MCP/Muse adapters | Python tooling | No dedicated Rust counterparts identified | These adapters are Python-only; they do not imply that Rust lacks scientific operations. |

The [investigation implementation guide](src/agent/README.md) describes numeric
adapters. [Shared fixture guides](../../tests/conformance/README.md) identify
cross-language inputs and readers.

## Effects and limits

`connect` selects a backend; local project creation writes a `.ap-workbook`
SQLite file. HTTP operations call `/api/v1` through one async transport,
`autophys::remote::Remote` (tokio); `Client`, `Workbook` and the investigation
loop stay synchronous through `autophys::blocking`, a thin facade that waits on
the same futures (like `reqwest::blocking`). Async programs can call
`client.remote().unwrap().as_async()` or `autophys::remote::Remote::new`
directly. A blocking call made inside a tokio runtime does not panic; it
waits on a helper thread and blocks its caller meanwhile. The daemon owns persistent writes,
while simulators and scientific calculations run in the SDK process. Explicit
open/create calls make missing-project effects clear. Saved credentials are
scoped to normalized server identity; local connections do not load HTTP keys.
An explicitly supplied key selects the caller's intended destination.

The paired attachment operation commits measurement and attachment-event
records in one transaction, or neither: `attach_data` is an
`Investigation::append_batch` of the two records, the event's
`measurement_version` filled with the measurement's hash (`hash_of`). Over
HTTP that is one `POST /investigations/{inv}/records`; it does not fall back
to two independent appends on a daemon without the batch route (before
CORE-01), which therefore cannot take attachments from this SDK. Record
ids are globally unique in a workbook: the same id/envelope is replayable,
while a changed envelope conflicts. Preserve the original attachment request
ids when retrying after an ambiguous response. A second scientific
`attach_data` call after successful completion can instead refuse because the
proposal is no longer pending; it is not an unconditional no-op retry API.

Investigations pin configuration versions. Resume and run/approve/attach check
the pin, but public scientific tools can still bypass that check after exposed
configuration mutation (A3). Keep the declaration stable; do not assume every
public effectful entry point rejects drift before simulation or writes.

Python total HTTP transfer deadlines/body/frame caps remain incomplete (PERF01).
Rust has transport and line/data bounds, but accumulated empty SSE data lines
remain a review concern. Repeated paired scientific timing/resource qualification
is still missing (PERF02). Simulation-count budgets do not interrupt arbitrary
nonreturning simulator callbacks. These are open obligations, not guarantees
provided by this guide.

Examples were checked against source, without compiling or running them for this
documentation refresh. Source checks, installed Python wheels and exact native
artifacts have distinct evidence. See the [SDK assessment](../../autophys.project.docs/content/productionize-sdks/README.md)
for retained results and open work; no blanket readiness claim follows.
