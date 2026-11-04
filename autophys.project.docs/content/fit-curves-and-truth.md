# Show the calibrated model, its residuals and the ground truth

Status: rev 2 (2026-11-04). **Agent-chosen, pending operator review**
(FC-1 and GT-1 in [decisions.md](decisions.md)). Step 1 (Python SDK) is
implemented (I8c41e7a95d2f03b6c1e8). The goldens for Rust are under
`tests/conformance/python/`: `thermal-curves-reveal.ap-workbook` with its
`.json` expectation, and `thermal-curves-fit.json` and
`thermal-curves-initial.json`. Rev 2 fixes the rules in "Rules both SDKs
follow (rev 2)" and replaces rev 1's byte-identical curves with a tolerance
comparison.

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
2. autophys/rs — daemon `reveal` kind and `POST /investigations/{inv}/reveal` (after outcome only), `workbook-format.md`; Rust SDK `curves` and `reveal`, byte-identical against step 1's goldens.
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
