# Understand the battery’s response

We are fitting a first-order battery model to find out which parameters the
measurements determine and what experiment would resolve the remaining uncertainty.

## What we know

A short current pulse identifies the immediate resistance, R0, but does not
separate the slower response parameters, R1 and C1. A good fit to that voltage
curve is not enough to determine all three parameters.

The additional pulse measurements in the synthetic battery example resolve
that ambiguity. The model still needs to predict measurements excluded from
fitting before we treat it as validated.

## What happens next

Check predictions against held-out measurements. If they fail, investigate the
discrepancy before relying on the model.

*Illustrative narrative based on the bundled battery example; not live project data.*
