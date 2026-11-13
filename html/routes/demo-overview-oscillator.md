# Identifying mass, stiffness and damping

## Abstract

Can watching an object oscillate reveal its mass, spring stiffness and damping?
In this synthetic demonstration, a freely decaying motion fitted extremely well
but left all three physical values unresolved. Adding a known external force
provided the missing scale. The updated model identified all three parameters
and passed a separate prediction check within one completed investigation.

## Research question

**Mass (m)** describes resistance to acceleration. **Spring stiffness (k)**
describes how strongly the spring pulls back when displaced. **Damping (c)**
describes resistance to motion that makes the oscillations fade. Can the
measurements distinguish these three effects, rather than just reproduce the
observed motion?

## Method

1. Fit displacement measurements from the initial free decay (`free`, 1,001
   samples) and check which parameters are identifiable.
2. Rank candidate experiments, then add the approved sinusoidal force test:
   a known **2 N amplitude at 0.44 Hz** (`sine_0.44Hz`, 1,001 samples). Refit
   using both training sets.
3. Check predictions against `free_neg`, a separate free response starting
   from negative displacement, excluded from fitting.

## Findings

The initial fit achieved noise-weighted **χ²/N = 1.0123**, but mass, damping
and stiffness shared an unresolved scale: multiplying each by the
same factor leaves the unforced motion unchanged. A close curve match
therefore did not establish their physical values.

The known force supplied that scale. **Fit #2 identified all three parameters**
under the recorded identification criterion. Rounded fitted values are:

| Parameter | Free decay only | Free decay + known force |
| --- | --- | --- |
| Mass m (kg) | Unresolved | 1.99999 |
| Damping c (N·s/m) | Unresolved | 0.80106 |
| Stiffness k (N/m) | Unresolved | 15.00137 |

The held-out check passed: **χ²/N = 1.0300** across **1,001 samples**, below
the acceptance threshold of **2**.

<ap-investigation investigation="inv_f9937c62fb18ecf0" title="A known push reveals the physical values" summary="Watching the motion fade matched the curve but left mass, spring stiffness and damping uncertain. Applying a known repeating force separated their values. The updated model then predicted a separate free motion successfully." before="Physical values unresolved" before-detail="The fading motion fitted well, but all three values shared an unknown scale." after="All three values identified" after-detail="The known force supplied the missing scale; a separate free-motion check passed." scope="Scope: synthetic data; held-out validation covers a separate free response."></ap-investigation>

## Takeaways and limits

Experiment choice resolved an ambiguity that a good fit could not. Parameter
identification and held-out prediction provide distinct evidence here.

This is synthetic data, not a physical apparatus test. Validation covers the
recorded free response; it does not establish forced-response accuracy across
frequencies. The table reports fitted estimates, not uncertainty bounds.
