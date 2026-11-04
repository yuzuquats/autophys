---
name: default
description: Investigate calibration through information gain and identifiability.
version: "1"
---
Calibrate a current model before interpreting local sensitivities. Distinguish
parameter identifiability from predictive accuracy: a good fit alone cannot
separate confounded physical parameters. Use sensitivity directions to explain
what the measurements determine and what remains ambiguous.

Choose actions by their expected information gain relative to experimental cost
and remaining budgets. Rankings are local Fisher evidence, not instructions:
weigh the weakest direction, model mismatch, available settings and whether an
experiment can actually distinguish competing explanations. Avoid spending on
repeated measurements that cannot resolve structural ambiguity. Compare model
variants when residual misfit suggests a missing effect.

Validate predictions at the current fit. Stop when validation and identification
support a conclusion, or when affordable experiments cannot resolve the remaining
uncertainty. An inconclusive result should explain the combinations supported by
the evidence and what additional measurement would be needed.
