# Show the calibrated model, its residuals and the ground truth

Status: rev 2 (2026-11-04). The rev 2 comparison rule is
**operator-confirmed, 2026-11-04**: Rust fit curves are compared within
numerical tolerance, and reveal records stay byte-for-byte identical
(FC-1r2 in [decisions.md](decisions.md)). FC-1 and GT-1 themselves were
confirmed as built by the operator on 2026-11-08. Step 1 (Python SDK) is
implemented (I8c41e7a95d2f03b6c1e8). The goldens for Rust are under
`tests/conformance/python/`: `thermal-curves-reveal.ap-workbook` with its
`.json` expectation, and `thermal-curves-fit.json` and
`thermal-curves-initial.json`. Rev 2 fixes the rules in "Rules both SDKs
follow (rev 2)" and replaces rev 1's byte-identical curves with a tolerance
comparison. The daemon/store portion of step 2 is implemented: outcome-gated
single reveal, opaque reveal storage, and FC-1 run-curve shape/size validation.
The Rust SDK portion is implemented: measurement-id curves, uncounted
truth-accuracy generation, evaluator reveal publication and resume/continuation
refusal. Numerical curve comparisons use `rtol=1e-5, atol=1e-8`, as in the
Python fixtures; unchanged metadata and recorded replay stay byte-identical.

## What the operator asked for

1. A page showing the true parameters a synthetic investigation started from,
   so a viewer can check that the agent recovered the correct values.
2. The Fit tab shows only the measured samples. It should also show the
   output of the calibrated model, and the Residuals tab should work.

## Why the Fit and Residuals tabs are empty today

The UI already draws measured dots, the initial-guess curve (dashed) and the
fitted curve on the Fit tab, and it already has a Residuals view
(`html/client/derive/charts.ts:50–100`). It has no curve to draw, though: no
record carries one. A `run` record holds the fitted parameters and
statistics (`FitResult.to_dict`, `sdks/python/src/autophys/fit.py:76`), and
`wire.ts:144` sets `curves: {}`. So derive falls back to "The SDK has not
recorded a fitted curve" on Fit, and "Residuals need the fit's curve" on
Residuals. Both tabs need the same data.

The UI must not simulate the model to get the curves itself, because it
does no numerics (AX-2). The SDK has just run the model at the fitted
parameters, so it records the curves.

## FC-1: a `run` record carries its curves

`run.payload.curves` is new and optional:

```json
"curves": {
  "<measurement record id>": {
    "t": [ ... ],                                  // only when downsampled
    "fit":     {"<output channel>": [ ... ]},
    "initial": {"<output channel>": [ ... ]}
  }
}
```

- **Which measurements:** every measurement the fit was trained on, and
  every held-out measurement it predicts. Keys are measurement *record ids*;
  `wire.ts` maps them to its `experiment@n` ids.
- **What is simulated:** the model at the fitted parameters (`fit`) and at
  the fit's starting parameters (`initial`), at the measurement's own
  settings and sample times. Simulations use `TRUTH_OPTIONS`-equivalent
  accuracy, and they fall outside the investigation's simulation budget,
  like display previews.
- **Size:** values are in the measurement's sample order. A measurement
  with more than 2,000 samples is downsampled to 2,000 evenly spaced
  indices, and `t` is included. A fit's payload stays under 256 KiB.
- **Agents never read it.** The agent's state summary is unchanged.
- **Both SDKs:** Python is the reference (AX-2). Rust matches its curves
  within numerics tolerances (rev 2): two independently solved ODEs cannot
  agree byte for byte.

Once curves exist, the UI changes are:
- **Fit tab:** two charts per measurement. First, the measured dots with
  the calibrated model line and the dashed initial guess (this already
  exists). Second, a short residual strip below it on the same time axis,
  showing (measured − model)/σ with the ±1σ band, so misfit is visible
  without switching tabs.
- **Residuals tab:** it works unchanged (`residualPanels`).
- **Validation:** the predicted curve for a held-out measurement comes from
  the same field.

## GT-1: a `reveal` record publishes the ground truth after the outcome

Only synthetic and benchmark investigations have a ground truth: the
`SyntheticRunner` keeps it in a closure, and the `Evaluator` holds it
(`synthetic.py:73,103`). Today it is used only offline, by `research.py`
scoring. A real lab investigation has no truth, and its page never appears.

There is a new record kind, `reveal`, which only the synthetic runner or
bench harness writes, **after** the investigation's `outcome` record:

```json
{
  "kind": "reveal",
  "payload": {
    "source": "synthetic",
    "tolerance": 0.10,
    "truth": {"R0": 0.0312, "R1": 0.0185, "C1": 2350.0},
    "estimate": {"R0": 0.0309, "R1": 0.0191, "C1": 2290.0},
    "quantities": [
      {"name": "R1", "truth": 0.0185, "estimate": 0.0191, "ratio": 1.032,
       "sigma_ratio": 0.021, "within": true, "identifiable": true}
    ],
    "fit_id": 4
  }
}
```

- **Quantities are what the evaluator scores.** Each is an identifiable
  combination (`Evaluator.combos`), so a parameter pair the experiment
  cannot separate is shown as its product or ratio, not as two misleading
  values. For a fully identified model, they are the parameters themselves.
  The SDK computes the ratios; the UI only displays them.
- **The truth cannot leak.** A `reveal` is written only once an `outcome`
  exists. An SDK refuses to resume or continue an investigation that has a
  `reveal`. The agent's record reader skips the kind.
- **Daemon:** add `reveal` to the record kinds (`validate.rs` `Kind`,
  `workbook.py`/`store.py` `KINDS`), with `POST
  /investigations/{inv}/reveal`, which is accepted only after an outcome.
  The payload is opaque, like the other kinds.

UI: when an investigation has a `reveal`, the tree gets a **Ground truth**
row after Validation. Its page has a headline ("3 of 3 within ±10% of the
truth"), a ratio plot (estimate ÷ truth per quantity, with ±1σ whiskers,
on a band from 0.9 to 1.1), and a table with the columns *quantity ·
truth · recovered · error · within ±10%*. It is marked "Synthetic: truth
was hidden from the agent until the outcome."

## Rules both SDKs follow (rev 2)

Step 1 settled these; Rust copies them.

- **Curves:**
  - Keys are measurement record ids, for every `train` and `validation`
    measurement recorded when the fit is adopted.
  - Each is simulated on the measurement's full time grid at its settings,
    with `rtol=1e-11`, `atol=1e-13` (`TRUTH_OPTIONS`), uncounted. Only output
    channels are stored, never inputs.
  - `initial` is the lowest-loss multistart's `x0`, transformed to
    parameters; the first start wins ties.
  - Output values are rounded to 6 significant figures
    (`float(f"{x:.6g}")`); times keep full precision.
- **Downsampling and size:** start with a limit of 2,000 points per
  measurement and keep indices `rint(linspace(0, n-1, min(n, limit)))`
  (ties to even), always resampling the original arrays. `t` is present
  only when points were dropped. While the whole run payload, canonically
  encoded as UTF-8, exceeds 256 KiB, halve the shared limit (integer floor,
  minimum 1). If one point per measurement is still too big, the SDK raises
  an error. The workbook's 1 MiB payload check still applies.
- **Validation (`run`):** when `curves` is present, it is an object of
  objects. Each has `fit` and `initial` objects of finite-number arrays,
  every array in an entry has the same length, and `t` is checked with them
  when present.
- **Reveal ordering:** a `reveal` needs an existing `outcome`. A retry with
  the same record id and payload succeeds; a second distinct reveal is
  refused. Stores check both, and `Investigation.resume`, `run`, `approve`
  and `attach_data` refuse an investigation that has a reveal. Replay
  skips the kind.
- **Reveal payload:** exactly the fields in the example, validated as
  finite numbers, booleans and strings. `sigma_ratio` may be null.
  Quantities are `Evaluator.combos`, with combinations whose parameters
  have no estimate omitted. `within` is `|ratio − 1| ≤ 0.10`, and
  `identifiable` means the combination is not in the evaluator's expected
  non-identified set.
- **`sigma_ratio`:** the delta method on the final sensitivity analysis
  (`J = U diag(s) Vᵀ`): `|ratio| · sqrt(Σᵢ ((Vᵢ·g)/sᵢ)²)`. Here `g_j` is the
  combination exponent for a log-scaled parameter, otherwise
  `exponent · scale / estimate`. It uses the known measurement sigma with no
  residual rescaling. It is null when the analysis is missing or stale,
  when a structural or zero-singular direction projects above `1e-8`, or
  when the result is not finite.
- **Who writes it:** only `Evaluator.reveal`, which the bench (and so the
  research loop) calls after `inv.run()`. When a daemon has no route yet
  (404/405), `HttpStore` warns once per store and skips the record.

## Phases

```review-steps
1. autophys/py — `curves` on `run` (train + held-out, downsampling, initial), `reveal` written by `SyntheticRunner`/bench after outcome, resume refusal, the fake store's endpoint, goldens.
2. autophys/rs — daemon `reveal` kind and `POST /investigations/{inv}/reveal` (after outcome only), `workbook-format.md`; Rust SDK `curves` and `reveal`, numerics within step 1's fixture tolerances and recorded replay byte-identical.
3. autophys/ui — `wire.ts` maps `curves` and `reveal`; residual strip under each Fit chart; Ground truth row and page; fixtures carry both.
```

Steps 1 and 2 can land independently, because both fields are optional. Step 3 can start on fixtures straight away.

## Alternatives considered

```review-callout
kind: decision
title: Rejected — let the UI or daemon simulate the curves
The UI has no numerics (AX-2), and the daemon does not read payloads. Only
the SDK holds the simulator. Recording curves costs workbook space, but it
keeps every plot reproducible from the record log.
```

```review-callout
kind: decision
title: Rejected — put the truth in the investigation record
Then the agent could read it from its first step, and the benchmark would
measure nothing. Appending it after the outcome keeps "truth hidden from the
agent" true by construction, not by convention.
```


## Daemon/store step 2 implementation (2026-11-04)

The shared validator recognises `reveal`; the append transaction checks for
an outcome and refuses a second distinct reveal after checking idempotent
replay. The keyed HTTP route is `POST /investigations/{inv}/reveal`.
The daemon stores reveal fields opaquely, per this implementation task's
explicit scope; the stricter rev-2 reveal payload contract is owned by SDK
writers. This is the operator's scope ruling, not a new agent decision.
Recorded `run.curves` shape, finite arrays, equal lengths, 2000-point bound
and the 256 KiB canonical run limit are enforced by the shared store.
Store validation does not compute curves or verify measurement sample grids.

Tests cover HTTP gating/retry/conflict and stream delivery, local append
gating, curve acceptance/refusal/cap, and the Python reveal workbook's chain,
projection replay and curve payloads. The fitted/initial curve JSON files
are read as recorded fixtures; no SDK numerics behavior is added here.


### Daemon/store validation and review receipt (2026-11-04)

Implementation commits: display `b242839` (`I3239635c574aff73f583`);
reveal/curves `e5472b3` (`I930ec3df6c116b50e969`). Both were assembled
from HEAD blobs through private indexes; no peer uncommitted work was adopted.

A `git archive` export of the combined commit passed `cargo test --workspace`:
161 passed, 0 failed, 2 existing ignored tests. This includes 4 display route/
stream tests and 5 reveal/curve tests, all Python workbook conformance inputs,
and the Rust SDK suite. The initial test-only Actix macro collision was fixed
before this passing gate.

Independent review (separate GPT-6.1 Sol agent, no credits provider) found one
P2: unrelated project broadcasts could postpone an external-writer poll.
The stream now keeps a fixed polling deadline. A fifth display test sustains
unrelated writes while requiring the external manifest within 1.5 seconds and
checking scope isolation. The reviewer found no other actionable findings.
The final archived-tree rerun is recorded on rwc-dev-01 at
`~/.cache/autophys/daemon-dm1-work/c-workspace-test.log`, using exactly
`CARGO_TARGET_DIR=~/.cache/autophys/daemon-dm1-target cargo test --workspace`.
That target is disposable and removed after qualification. No push or deploy.


## Rust SDK step 2 implementation (2026-11-04)

`curves::run_payload` simulates both predictions on the recorded full grids,
then selects original indices, rounds outputs and halves the shared limit.
The existing shared store validator checks the resulting run; its rules are
not duplicated. `FitResult` ignores the optional curves on replay, and facts
retain their existing shape. The agent skips reveal records and refuses
resume, run, approve and attach_data after publication.

`Evaluator::reveal(&inv)` is the harness publication API, called after
`inv.run()`; it follows Python's evaluator-only writer rule. `SyntheticRunner`
continues to provide measurements without exposing truth to the agent. Rust
has no bench module to wire automatically. This follows rev 2 rather than
introducing an additional truth-bearing runner hook. The sensitivity report
must belong to the current fit; no residual rescaling is applied.

Conformance tests regenerate both runs (2,170 output samples across fit and
initial) from the Python workbook, check both standalone numeric fixtures,
compare unchanged metadata canonically, and preserve the full golden record
log and hash chain on projection rebuild. Reveal fields other than numerical
uncertainty compare canonically exactly at the reference estimate; uncertainty
uses the same `rtol=1e-5, atol=1e-8` numerical tolerance. Tests also exercise
size halving, original-grid sampling, first-start ties, truth accuracy,
zero simulation budget, uncertainty cancellation and reveal refusal.

No new consequential design choice is introduced: the public evaluator hook,
sampling, caps and numerical tolerances follow rev 2. FC-1/GT-1 were
confirmed as built by the operator on 2026-11-08.


### Rust qualification and independent review receipt

Implementation `17d84f989c43` (`I84635c971ba4f5375689`) passed a clean
`git archive` gate: Rust workspace **170 passed, 0 failed, 2 ignored**;
Python **590 passed, 6 skipped**. Existing hashes, goldens and conformance
inputs were unchanged. The new tests include both thermal curve fixtures,
all golden run curves and canonical reveal fields at the reference estimate.

A separate GPT-6.1 Sol reviewer (no credits model) returned **ready**, with
no actionable correctness/contract findings or likely-defect test gaps.
The reviewer checked committed blobs and the archive, excluded dirty peer
changes, and confirmed the evaluator-only writer matches rev 2 and Python.
No finding remains unresolved. Review task: `autophys-rs-fcgt-review-round-1`.

The final receipt commit is requalified from its own `git archive` export
with `CARGO_TARGET_DIR=~/.cache/autophys/rs-fcgt-target`, running
`cargo test --workspace --locked` and the full Python suite. Logs, exact final
commit identity and counts are retained on rwc-dev-01 under
`~/.cache/autophys/rs-fcgt-work/` (`receipt.json`, `rust-gate-final.log`,
`python-gate-final.log`). The disposable target is removed after the gate;
the pre-existing repository-root target is left alone. No push or deploy.

The installed task CLI lacks `task`; external `tasks.json` tracks this work.
Remote Rust transport remains outside this step. FC-1/GT-1 operator design
review remains pending, as before.
