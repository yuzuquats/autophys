# Rust investigation API

`client.project_with(project::Project::new(name, model))` returns a
`ProjectWorkbook`, which dereferences to the record `Workbook`.
It owns the executable simulator needed by `investigate` and `resume`.
A review-only workbook can attach code with `with_project(project)`.
The resulting investigation dereferences to the record investigation;
its `run()` executes the loop, and durable records always use `append`.

Numerical dependencies:

- `differential-equations` 0.7 supplies the DOP853 tableau. The adapter uses
  SciPy's initial step, RMS error controller and seventh-order dense polynomial.
- `trust-region-least-squares` 0.11 supplies robust rho functions and the dense
  trust-region subproblem. A bounded Coleman–Li reflective iteration honors
  transformed bounds, Jacobian scaling and SciPy termination rules.
- `nalgebra` 0.33 supplies SVD, symmetric eigenvalues and dense matrix operations.
- `indexmap` 2 preserves parameter, channel, catalog and outlook-axis order.
- `ureq` 3 supplies blocking reason-lane and Meta/Baseten chat HTTP without an application runtime.

SeedSequence, PCG64, ziggurat normals and Latin-hypercube draws reproduce the
Python RNG. The normal test checks 10,000 reference draws, including rejection
and tail paths. Fits also accept explicit physical-parameter starts.

The private Python fixtures in `models/fixtures/python.json` cover all three
example models. Their generator must run against an exported Python SDK copy.
The shared `tests/conformance/numerics` reader fails on a missing or empty corpus and
supports simulate, fit, analyze, rank, outlook and run cases, including per-field
numeric, exact, set and up-to-sign comparisons.

Retained earlier native ARM64 measurements (not a fresh current-artifact run):

| Model | simulate | fit | analyze | rank | outlook |
| --- | --- | --- | --- | --- | --- |
| thermal | 1.57e-15 | 1.97e-12 | 1.07e-11 | 4.05e-11 | 2.36e-11 |
| oscillator | 1.12e-13 | 1.69e-10 | 4.72e-12 | 2.22e-9 | 5.17e-11 |
| battery | 2.27e-16 | 2.82e-10 | 1.39e-11 | 1.51e-10 | 3.69e-11 |

In that retained assessment, all three scripted runs matched Python's actions,
arguments, experiment choices and final validated status. Bound and identification
decisions matched the fixtures; no tolerances were relaxed.

Resume restores the last fit, its model and warm start. Outlooks carry
`after_resolved_max` and `at`, shrink uniformly to fit the configured
`max_outlook_simulations` and 900 KiB payload limit, and report axis counts.
The default outlook budget is hash-neutral in the project configuration.
Record waits require a proposal id; agent waits forward their pending id.
Withdrawals clear pending state and decision records stamp `via: "sdk"`.
Local workbooks have no loaded HTTP credential, so they omit `key_id`.

`ChatReasoner` and `reasoner_from_env` match Meta/Baseten routing,
private file/environment credentials, response schemas, token budgets and
bounded rate-limit retries. Mock HTTP tests cover requests, retry exhaustion,
billing errors and response parsing without an external request.

Outlook axes match Python (E-1b): 12 evenly spaced values, with an off-grid
proposed value inserted, so an axis has 12 or 13 values. Explicit axes retain
their supplied order.

Rust types are available in their named public modules. The root `Project`
and `Investigation` remain the record types; executable types are
`project::Project` and `agent::Investigation`. No external reasoner request
was made during validation; local HTTP, FakeReasoner and parsing are tested.

Start with the [Rust SDK guide](../../README.md) for installation, a scientific
example and the explicit Python analogy/gap table. The [shared fixture guide](../../../../tests/conformance/README.md)
identifies writers, readers and regeneration controls. A3/A5/A6 and PERF01/02
remain open; retained measurements here do not establish current readiness.
