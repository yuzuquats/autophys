# Identifying a battery’s fast and slow response

## Abstract

Can a simple battery model distinguish immediate resistance from a slower
voltage response? In this synthetic-cell demonstration, a short current pulse
identified the immediate resistance but left the slow-response parameters
unresolved. A subsequent pulse ladder separated those parameters, and the
refitted model passed a prediction check on measurements excluded from fitting.
One investigation has reached this result; a second is awaiting experiment
approval.

## Research question

We model the cell’s immediate resistance as **R0** and its slower response with
**R1** and **C1**. The aim is to determine whether the measurements constrain
all three parameters. A model can closely reproduce a voltage curve while
leaving several parameter combinations equally plausible.

## Method

1. **Establish a baseline.** Fit the model to a short current pulse and inspect
   its parameter sensitivity. Identify what the measurements constrain and
   where ambiguity remains.
2. **Collect more informative measurements.** Rank candidate experiments,
   obtain human approval for a pulse ladder, and refit using the initial pulse
   and the new measurements.
3. **Check prediction separately.** Evaluate the final model against a held-out
   measurement set that was excluded from fitting.

## Findings

The first investigation completed this sequence. The initial pulse constrained
R0, but R1 and C1 remained unresolved. Adding the pulse ladder made all three
parameters identifiable under the recorded sensitivity criterion.

| Parameter | Short pulse | Pulse + ladder |
| --- | --- | --- |
| R0 (Ω) | 0.02486 | 0.02494 |
| R1 (Ω) | Unresolved | 0.04513 |
| C1 (F) | Unresolved | 1,610 |

The held-out check passed: noise-weighted **χ²/N = 1.04** across **741 samples**,
below the recorded acceptance threshold of 2. This supports the model’s
prediction under the tested conditions. Both the short pulse and the pulse
ladder belong to this single investigation.

<ap-investigation investigation="inv_c51194ac2a68ef19"></ap-investigation>

## Takeaways

- **Experiment choice resolved the ambiguity.** The short pulse was sufficient
  for R0; the pulse ladder supplied the information needed to distinguish R1
  and C1.
- **A good fit alone is insufficient.** Parameter identification and prediction
  on unseen measurements answer different questions. This investigation
  recorded both checks.
- **The result has a defined scope.** It establishes a model for this synthetic
  cell under the tested conditions, rather than a general battery model.

## Work in progress

The second investigation starts from the same short pulse. R0 is identified;
R1 and C1 remain unresolved. Its pulse ladder proposal is awaiting approval,
so no follow-up measurements or held-out validation are recorded. It does not
yet provide a completed replication of the first result.

<ap-investigation investigation="inv_1b63c1cbdd6c12bd"></ap-investigation>

## Limitations

This is a simulated demonstration, not an experiment on a physical cell.
Temperature changes, aging and transfer to other cells remain untested.
The parameter table reports fitted values, not confidence intervals; no
uncertainty bounds are claimed here.
