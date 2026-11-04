# Rust investigation API

`client.project_with(project::Project::new(name, model))` returns a
`ProjectWorkbook`, which dereferences to the phase-1 record `Workbook`.
It owns the executable simulator needed by `investigate` and `resume`.
A review-only workbook can attach code with `with_project(project)`.
The resulting investigation dereferences to the phase-1 record investigation;
its `run()` executes the loop, and durable records always use `append`.

Numerical dependencies:

- `differential-equations` 0.7 supplies the DOP853 tableau. The adapter uses
  SciPy's initial step, RMS error controller and seventh-order dense polynomial.
- `trust-region-least-squares` 0.11 supplies robust rho functions and the dense
  trust-region subproblem. A bounded Coleman–Li reflective iteration honors
  transformed bounds, Jacobian scaling and SciPy termination rules.
- `nalgebra` 0.33 supplies SVD, symmetric eigenvalues and dense matrix operations.
- `indexmap` 2 preserves parameter, channel, catalog and outlook-axis order.
- `ureq` 3 supplies blocking reason-lane HTTP without an application runtime.

SeedSequence, PCG64, ziggurat normals and Latin-hypercube draws reproduce the
Python RNG. The normal test checks 10,000 reference draws, including rejection
and tail paths. Fits also accept explicit physical-parameter starts.

The private Python fixtures in `models/fixtures/python.json` cover all three
example models. Their generator must run against an exported Python SDK copy.
The shared `tests/conformance/numerics` reader skips an empty directory and
supports simulate, fit, analyze, rank, outlook and run cases, including per-field
numeric, exact, set and up-to-sign comparisons.

Observed maximum relative errors (native ARM64; primary numeric results):

| Model | simulate | fit | analyze | rank | outlook |
| --- | --- | --- | --- | --- | --- |
| thermal | 1.57e-15 | 1.97e-12 | 1.07e-11 | 4.05e-11 | 2.36e-11 |
| oscillator | 1.12e-13 | 1.69e-10 | 4.72e-12 | 2.22e-9 | 5.17e-11 |
| battery | 2.27e-16 | 2.82e-10 | 1.39e-11 | 1.51e-10 | 3.69e-11 |

All three scripted runs match Python's actions, arguments, experiment choices
and final validated status. Bound and identification decisions match the
fixtures. No tolerances were relaxed.

One intentional contract difference remains: Python inserts the proposed value
into an outlook axis and may produce 13 values with the default 12-point grid.
The requested Rust contract caps each axis at 12; for an off-grid proposal it
replaces the nearest interior grid value while preserving both endpoints and
the proposal. Explicit axes retain their supplied order. This is a settings-grid
shape difference, not a fitted or ranked decision mismatch.

Rust types are available in their named public modules. Phase-1's root `Project`
and `Investigation` remain the record types; executable types are
`project::Project` and `agent::Investigation`. No network reason-lane request
was made during validation; FakeReasoner and response parsing are tested.
