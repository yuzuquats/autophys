# Show the calibrated model, its residuals and the ground truth

Status: rev 1 (2026-11-04), by autophys/design. **Agent-chosen, pending
operator review** (FC-1 and GT-1 in [decisions.md](decisions.md)).
Nothing is implemented yet.

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
- **Both SDKs:** Python is the reference (AX-2). Rust emits byte-identical
  curves for the bench goldens.

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
